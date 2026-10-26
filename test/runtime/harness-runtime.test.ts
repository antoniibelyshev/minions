// task-14.2: `harness` in the brief, `harness` + `launch` in `work next`, the phase rules at claim and the pre-agent
// hook for process-harness roles (docs/design/agent-runtimes.md D1, D8, D9). No runner yet (`work run` is child task 3).
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_RULES } from '../../src/config/harnesses.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { MinionsError } from '../../src/core/errors.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { humanNext } from '../../src/runtime/commands.js';
import { preAgentHook } from '../../src/runtime/hooks.js';
import { checkProposal, formatSummary } from '../../src/runtime/role-proposals.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, makeDefaultEnv, result, type Env } from './fixtures.js';

const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol', 'gpt-6.1-mini'] }, effort: 'medium' as const };
const PILOT_ROLE = { description: 'Second-opinion review on Codex.', promptText: 'Review the head.', contract: 'gate', harness: 'codex', deepVariant: true };

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};
const set = (c: MinionsConfig, patch: Record<string, unknown>) => Object.assign(c as unknown as Record<string, unknown>, structuredClone(patch));
const pilotEnv = () => makeDefaultEnv((c) => set(c, { harnesses: { codex: CODEX }, roles: { 'codex-reviewer': PILOT_ROLE }, workflows: { pilot: ['engineer', 'codex-reviewer'] } }));
async function engineerStage(e: Env, id: string) {
  const brief = await e.sched.claim(id, 'engineer');
  mkdirSync(dirname(join(brief.worktree, 'a.txt')), { recursive: true });
  const head = commitFile(brief.worktree, 'a.txt', `x ${Math.random()}`);
  await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }));
  return brief;
}
const loader = (e: Env) => () => ({ db: e.db, backlog: e.backlog, config: e.config });
const agent = (subagent_type: string, prompt: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type, prompt, description: 'x' } });
const decision = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } } : null);

describe('back-compat: no harnesses', () => {
  it('the brief says harness claude and keeps the Claude model fields; work next launches an agent', async () => {
    const e = makeDefaultEnv();
    e.backlog.add({ id: 'task-1' });
    const n = await e.sched.next();
    expect(n.runnable[0]).toMatchObject({ harness: 'claude', agentType: 'minions:engineer', launch: { kind: 'agent', agentType: 'minions:engineer', agentModel: null } });
    const brief = await e.sched.claim('task-1');
    expect(brief).toMatchObject({ harness: 'claude', model: 'sonnet', allowedModels: ['sonnet', 'opus', 'haiku'], effort: null });
  });

  it('a risk:high engineer still launches minions:engineer-deep with the strongest alias', async () => {
    const e = makeDefaultEnv();
    e.backlog.add({ id: 'task-1', labels: ['risk:high'] });
    expect((await e.sched.next()).runnable[0]).toMatchObject({ agentType: 'minions:engineer-deep', agentModel: 'opus', harness: 'claude', launch: { kind: 'agent', agentType: 'minions:engineer-deep', agentModel: 'opus' } });
  });
});

describe('phase 1 (b) pilot: codex-reviewer gate after the Claude engineer', () => {
  it('work next lists the gate with harness codex and a run launch; the brief carries harness and the Codex model', async () => {
    const e = pilotEnv();
    e.backlog.add({ id: 'task-1', workflow: 'pilot' });
    await engineerStage(e, 'task-1');
    const n = await e.sched.next();
    expect(n.runnable).toHaveLength(1);
    expect(n.runnable[0]).toMatchObject({
      taskId: 'task-1', role: 'codex-reviewer', harness: 'codex', suggestedModel: 'gpt-6.1-sol', agentModel: null, modelRule: 'default',
      launch: { kind: 'run', command: 'minions work run <leaseId> --json', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', deep: false },
    });
    expect(humanNext(n)).toContain('task-1 codex-reviewer -> claim, then minions work run <leaseId> --json (codex, model gpt-6.1-sol)');
    const brief = await e.sched.claim('task-1');
    expect(brief).toMatchObject({ role: 'codex-reviewer', harness: 'codex', model: 'gpt-6.1-sol', allowedModels: ['gpt-6.1-sol', 'gpt-6.1-mini'], effort: 'medium' });
  });

  it('a stage hint picks the Codex model; risk:high applies the -deep effort on the harness', async () => {
    const e = makeDefaultEnv((c) => set(c, { harnesses: { codex: CODEX }, roles: { 'codex-reviewer': PILOT_ROLE }, workflows: { pilot: ['engineer', { role: 'codex-reviewer', model: 'gpt-6.1-mini' }] } }));
    e.backlog.add({ id: 'task-1', workflow: 'pilot', labels: ['risk:high'] });
    await engineerStage(e, 'task-1');
    expect((await e.sched.next()).runnable[0]).toMatchObject({
      role: 'codex-reviewer', suggestedModel: 'gpt-6.1-mini', modelRule: 'stage',
      launch: { kind: 'run', model: 'gpt-6.1-mini', effort: 'high', deep: true },
    });
    expect(await e.sched.claim('task-1')).toMatchObject({ model: 'gpt-6.1-mini', harness: 'codex' });
  });

  it('the pre-agent hook refuses to spawn a process-harness role as a Claude subagent, even with its lease', async () => {
    const e = pilotEnv();
    e.backlog.add({ id: 'task-1', workflow: 'pilot' });
    await engineerStage(e, 'task-1');
    const brief = await e.sched.claim('task-1');
    for (const type of ['minions:codex-reviewer', 'minions:codex-reviewer-deep']) {
      const d = decision(await preAgentHook(agent(type, brief.briefMarker), loader(e)))!;
      expect(d.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(d.hookSpecificOutput.permissionDecisionReason).toMatch(/runs on OpenAI Codex CLI \(harness codex\), not as a Claude subagent/);
    }
  });

  it('the plugin has no Claude agent file for a process-harness role, only its resolved prompt for the runner', async () => {
    const e = pilotEnv();
    const out = await mkdtemp(join(tmpdir(), 'minions-harness-plugin-'));
    try {
      const files = (await generatePlugin(e.config, out)).map((f) => relative(out, f.path).split('\\').join('/'));
      expect(files).toContain('agents/reviewer.md');
      expect(files.filter((f) => f.includes('codex-reviewer'))).toEqual(['harness-prompts/codex-reviewer.md']);
      expect(await readFile(join(out, 'harness-prompts', 'codex-reviewer.md'), 'utf8')).toBe('Review the head.\n');
    } finally { await rm(out, { recursive: true, force: true }); }
  });
});

describe('role proposals', () => {
  it('a proposal may put a project gate on a configured harness; the summary shows it; the phase rules still apply', async () => {
    const e = makeDefaultEnv((c) => set(c, { harnesses: { codex: CODEX } }));
    const { summary } = await checkProposal(e.config, { name: 'codex-reviewer', role: { description: 'Second opinion.', contract: 'gate', harness: 'codex' }, promptText: 'Review.', reason: 'cross-model review' });
    expect(summary.harness).toBe('codex');
    expect(formatSummary(summary)).toMatch(/, harness codex/);
    const claude = await checkProposal(e.config, { name: 'judge', role: { description: 'Judge.', contract: 'gate' }, promptText: 'Judge.', reason: 'r' });
    expect(claude.summary.harness).toBe('claude');
    expect(formatSummary(claude.summary)).not.toMatch(/harness/);
    const x = await err(checkProposal(e.config, { name: 'maker', role: { description: 'Makes.', contract: 'producer', edits: 'any', harness: 'codex' }, promptText: 'Make.', reason: 'r' }));
    expect(x.code).toBe('INVALID_CONFIG');
    expect(JSON.stringify(x.details)).toMatch(/roles\.maker\.harness/);
  });
});

describe('phase rules at claim', () => {
  const engineerOnCodex = (c: MinionsConfig) => set(c, { harnesses: { codex: CODEX }, roles: { engineer: { harness: 'codex' } } });

  it('phase 1 (b) refuses a process-harness producer even when the config skipped validation', async () => {
    const e = makeDefaultEnv(engineerOnCodex);
    e.backlog.add({ id: 'task-1' });
    const x = await err(e.sched.claim('task-1'));
    expect(x.code).toBe('POLICY_DENIED');
    expect(x.message).toMatch(/Role engineer cannot run on harness codex: phase 1, option \(b\)/);
    expect(e.db.activeLeases()).toEqual([]);
  });

  it('phase 1 (a): at most one process-harness producer lease squad-wide (claim and work next)', async () => {
    const e = makeDefaultEnv(engineerOnCodex);
    const sched = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, phase: PHASE_RULES['1a'] });
    e.backlog.add({ id: 'task-1', priority: 'high' });
    e.backlog.add({ id: 'task-2' });
    expect(e.config.execution.maxByRole?.engineer ?? e.config.execution.maxEngineers).toBe(2);
    const before = await sched.next();
    expect(before.runnable.map((r) => r.taskId)).toEqual(['task-1']);
    expect(before.runnable[0]).toMatchObject({ harness: 'codex', launch: { kind: 'run', harness: 'codex', model: 'gpt-6.1-sol' } });
    expect(before.waiting).toEqual([expect.objectContaining({ taskId: 'task-2', waitingOn: 'harness-capacity', why: expect.stringMatching(/process-harness producer cap \(1\/1/) })]);

    const brief = await sched.claim('task-1');
    expect(brief).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', allowedModels: ['gpt-6.1-sol', 'gpt-6.1-mini'], effort: 'medium' });
    const x = await err(sched.claim('task-2'));
    expect(x.code).toBe('CAPACITY');
    expect(x.message).toMatch(/Process-harness producer cap reached \(1\/1/);
    expect((await sched.next()).waiting).toEqual([expect.objectContaining({ taskId: 'task-2', waitingOn: 'harness-capacity' })]);

    // Releasing the running producer frees the slot.
    await sched.release(brief.leaseId, 'test');
    expect((await sched.claim('task-2')).harness).toBe('codex');
  });

  it('phase 2 lifts the producer cap', async () => {
    const e = makeDefaultEnv(engineerOnCodex);
    const sched = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, phase: PHASE_RULES['2'] });
    e.backlog.add({ id: 'task-1' });
    e.backlog.add({ id: 'task-2' });
    expect((await sched.next()).runnable.map((r) => r.taskId).sort()).toEqual(['task-1', 'task-2']);
    await sched.claim('task-1');
    expect((await sched.claim('task-2')).harness).toBe('codex');
  });
});
