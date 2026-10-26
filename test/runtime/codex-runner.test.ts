// task-14.6: `minions work run` with the real Codex adapter against a fake `codex` CLI (test/fixtures/fake-codex.mjs),
// on the phase 1 b gate pilot (an engineer, then a codex-reviewer gate). Mirrors the fake-harness runner tests:
// real git repositories, isolation `none`. Never starts Codex or a Claude session.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_RULES } from '../../src/config/harnesses.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { claimWithBrief, recordSubmitted, submissionPath } from '../../src/runtime/handoff.js';
import { codexAdapter } from '../../src/runtime/runner/codex.js';
import { runLease, type RunnerDeps } from '../../src/runtime/runner/run.js';
import { Scheduler, type TaskBrief } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

const FAKE = resolve(__dirname, '..', 'fixtures', 'fake-codex.mjs');
const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol'] }, timeoutMinutes: 5 };
const KEY = 'sk-proj-FakeCodexKeyForTests0123456789abcdef';
const set = (c: MinionsConfig, patch: Record<string, unknown>) => Object.assign(c as unknown as Record<string, unknown>, structuredClone(patch));

interface Rig extends Env { paths: RunnerDeps['paths']; deps: (scenario: unknown, over?: Partial<RunnerDeps>) => RunnerDeps }

/** The phase 1 b pilot: workflow engineer -> codex-reviewer (a gate on harness codex); the key in the secrets dir. */
function rig(reviewer: Record<string, unknown> = { promptText: 'Review the diff against the brief.' }, key: string | null = KEY): Rig {
  const phase = PHASE_RULES['1b'];
  const e = makeDefaultEnv((c) => set(c, {
    harnesses: { codex: CODEX },
    roles: { 'codex-reviewer': { description: 'Codex review.', contract: 'gate', harness: 'codex', ...reviewer } },
    workflows: { pilot: ['engineer', 'codex-reviewer'] },
  }));
  const state = join(e.root, 'state');
  const paths = { state, briefs: join(state, 'briefs'), results: join(state, 'results'), scratch: join(e.root, 'scratch'), secretsDir: join(e.root, 'secrets'), drainFlag: join(state, 'run', 'drain') };
  mkdirSync(paths.secretsDir, { recursive: true });
  if (key !== null) writeFileSync(join(paths.secretsDir, 'codex-api-key'), key + '\n', { mode: 0o600 });
  e.sched = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, handoff: paths, phase });
  const deps = (scenario: unknown, over: Partial<RunnerDeps> = {}): RunnerDeps => {
    const file = join(e.root, `scenario-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(scenario));
    return {
      db: e.db, config: e.config, paths, commonDir: join(e.layout.repo, '.git'), adapters: { codex: codexAdapter({ command: [process.execPath, FAKE, file] }) },
      isolation: { kind: 'none' }, phase, callerEnv: {}, callerCwd: e.root, env: process.env,
      timing: { pollMs: 50, killGraceMs: 400, drainGraceMs: 200 }, ...over,
    };
  };
  return { ...e, paths, deps };
}

async function toGate(r: Rig): Promise<TaskBrief> {
  r.backlog.add({ id: 'task-1', workflow: 'pilot' });
  const eng = await r.sched.claim('task-1', 'engineer');
  const head = commitFile(eng.worktree, 'a.txt', 'x\n');
  await r.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head }));
  const b = await claimWithBrief(r.sched, r.paths, 'task-1', undefined);
  expect(b.role).toBe('codex-reviewer');
  return b;
}

const submitted = (r: Rig, b: TaskBrief) => JSON.parse(readFileSync(submissionPath(r.paths, b.leaseId), 'utf8')) as Record<string, unknown> & { status: string; findings: string[]; checks: Record<string, unknown>[] };

describe('work run with the Codex adapter (gate pilot, fake codex)', () => {
  it('runs codex exec, submits the normalized final message as an approving gate result and records the last usage total', async () => {
    const r = rig();
    const b = await toGate(r);
    const echo = join(r.root, 'echo.json');
    const out = await runLease(b.leaseId, r.deps({ echo, usage: [[1000, 100, 800], [5000, 400, 4200]] }));
    expect(out).toMatchObject({ submitted: true, status: 'complete', violations: [], usage: { tokens: 5400 } });
    expect(out.exit).toMatchObject({ code: 0 });
    // The gate did not move the branch; the coordinator records the submission as an approval.
    expect(gitSync(r.layout.repo, 'rev-parse', `refs/heads/${b.branch}`)).toBe(b.expectedHead);
    const s = submitted(r, b);
    expect(s).not.toHaveProperty('needsQa');
    expect(s.checks[0]).toEqual({ command: 'npm test', outcome: 'pass' });
    expect(await recordSubmitted(r.sched, r.paths, b.leaseId)).toMatchObject({ valid: true, approved: true });
    // Usage: the last turn.completed running total, not the sum (6500).
    const usage = r.db.events('task-1', 'usage').map((ev) => ev.data);
    expect(usage).toContainEqual(expect.objectContaining({ leaseId: b.leaseId, tokens: 5400, source: 'runner', harness: 'codex' }));
    // What codex saw: the key only in env, the role prompt and brief on stdin, the per-lease config.
    const seen = JSON.parse(readFileSync(echo, 'utf8')) as { argv: string[]; env: Record<string, string>; stdin: string; cwd: string; config: string; schema: { properties: object } };
    const scratch = join(r.paths.scratch, b.leaseId);
    expect(seen.env.CODEX_API_KEY).toBe(KEY);
    expect(seen.argv.join(' ')).not.toContain('sk-proj');
    expect(seen.env.CODEX_HOME).toBe(join(scratch, 'harness-home'));
    expect(Object.keys(seen.env).filter((k) => /^(GIT_|GH_|CLAUDE|ANTHROPIC|OPENAI)/.test(k))).toEqual([]);
    expect(seen.cwd).toBe(join(scratch, 'work'));
    expect(seen.argv).toContain('--sandbox');
    expect(seen.stdin).toContain('Role instructions (from the project):');
    expect(seen.stdin).toContain('Review the diff against the brief.');
    expect(seen.stdin).toMatch(/read-only gate/);
    expect(seen.stdin).toContain(b.leaseId);
    expect(seen.config).toContain(`[projects.${JSON.stringify(join(scratch, 'work'))}]`);
    expect(seen.config).toContain('web_search = "disabled"');
    expect(seen.schema.properties).toHaveProperty('verdict');
  });

  it('a request-changes verdict is submitted as needs_changes', async () => {
    const r = rig();
    const b = await toGate(r);
    const out = await runLease(b.leaseId, r.deps({ result: { status: 'needs_changes', verdict: 'request-changes', findings: ['a.txt: missing test'] } }));
    expect(out).toMatchObject({ submitted: true, status: 'needs_changes' });
    expect(await recordSubmitted(r.sched, r.paths, b.leaseId)).toMatchObject({ valid: true, approved: false });
  });

  it('a final message that is not a result becomes a synthesized blocked result with the redacted stderr tail', async () => {
    const r = rig();
    const b = await toGate(r);
    const out = await runLease(b.leaseId, r.deps({ message: 'I could not finish.', stderr: `error: auth failed for ${KEY}\n`, exitCode: 1 }));
    expect(out).toMatchObject({ submitted: true, status: 'blocked', exit: { code: 1 } });
    const s = submitted(r, b);
    expect(s.findings.join('\n')).toContain('auth failed');
    expect(JSON.stringify(s)).not.toContain(KEY);
  });

  it('without the codex key nothing starts: a blocked result names the missing credential', async () => {
    const r = rig(undefined, null);
    const b = await toGate(r);
    const echo = join(r.root, 'echo.json');
    const out = await runLease(b.leaseId, r.deps({ echo }));
    expect(out).toMatchObject({ submitted: true, status: 'blocked', exit: null });
    expect(out.error).toMatch(/No codex-api-key credential is set up for harness codex/);
    expect(submitted(r, b).findings.join('\n')).toMatch(/No codex-api-key credential/);
    expect(existsSync(echo)).toBe(false);
  });

  it('a file prompt is read from the generated plugin dir; a missing copy refuses the run', async () => {
    const r = rig({ prompt: 'prompts/codex-reviewer.md' });
    const b = await toGate(r);
    const missing = await runLease(b.leaseId, r.deps({}, { rolePromptDir: join(r.root, 'plugin', 'harness-prompts') }));
    expect(missing).toMatchObject({ submitted: true, status: 'blocked', exit: null });
    expect(missing.error).toMatch(/prompt of role codex-reviewer .* is not in the generated plugin/);

    const r2 = rig({ prompt: 'prompts/codex-reviewer.md' });
    const b2 = await toGate(r2);
    const dir = join(r2.root, 'plugin', 'harness-prompts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex-reviewer.md'), 'Generated reviewer prompt from the host.\n');
    const echo = join(r2.root, 'echo.json');
    const out = await runLease(b2.leaseId, r2.deps({ echo }, { rolePromptDir: dir }));
    expect(out).toMatchObject({ submitted: true, status: 'complete' });
    expect((JSON.parse(readFileSync(echo, 'utf8')) as { stdin: string }).stdin).toContain('Generated reviewer prompt from the host.');
  });
});
