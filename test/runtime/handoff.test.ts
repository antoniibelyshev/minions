import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { COMPACT_FIELDS, projectTasks, register as registerBacklog, selectFields } from '../../src/backlog/commands.js';
import type { MinionsError } from '../../src/core/errors.js';
import { register as registerRuntime } from '../../src/runtime/commands.js';
import {
  claimWithBrief, compactClaim, fetchBrief, recordSubmitted, rejectedPath, submissionPath, submitResult, type HandoffPaths,
} from '../../src/runtime/handoff.js';
import { preAgentHook } from '../../src/runtime/hooks.js';
import { commitFile, makeEnv, result, type Env } from './fixtures.js';

const paths = (env: Env): HandoffPaths => ({ briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') });
const fail = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a failure');
};
const json = (v: unknown) => JSON.stringify(v);

describe('worker-fetched brief', () => {
  it('claim stores the full brief; the compact claim carries only what the coordinator needs', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', title: 'Add login', description: 'A long description '.repeat(200) });
    const brief = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    const c = compactClaim(brief);
    expect(Object.keys(c).sort()).toEqual(['attempt', 'branch', 'briefCommand', 'briefMarker', 'expectedHead', 'leaseId', 'role', 'taskId', 'title', 'worktree']);
    expect(c).toMatchObject({ leaseId: brief.leaseId, briefMarker: `minions-lease: ${brief.leaseId}`, branch: brief.branch, worktree: brief.worktree, expectedHead: brief.expectedHead });
    expect(c.briefCommand).toBe(`minions work brief ${brief.leaseId} --role engineer --json`);
    expect(json(c).length).toBeLessThan(600);
    expect(json(c)).not.toContain('long description');
    const stored = JSON.parse(readFileSync(join(paths(env).briefs, `${brief.leaseId}.json`), 'utf8'));
    expect(stored).toEqual(brief);
  });

  it('the lease worker fetches its brief from its worktree (or a subdirectory)', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const brief = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    expect(await fetchBrief(env.db, paths(env), brief.leaseId, { role: 'engineer', cwd: brief.worktree })).toEqual(brief);
    const sub = join(brief.worktree, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    expect((await fetchBrief(env.db, paths(env), brief.leaseId, { role: 'engineer', cwd: sub })).leaseId).toBe(brief.leaseId);
  });

  it('only the lease\'s own worker can fetch it: wrong role, other worktree, coordinator cwd, ended lease, bad id', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const p = paths(env);
    const b1 = await claimWithBrief(env.sched, p, 'task-1', 'engineer');
    const b2 = await claimWithBrief(env.sched, p, 'task-2', 'engineer');
    // worker 1 cannot read worker 2's brief from its own worktree
    expect((await fail(fetchBrief(env.db, p, b2.leaseId, { role: 'engineer', cwd: b1.worktree }))).code).toBe('POLICY_DENIED');
    // a prefix-sharing sibling directory is not "inside"
    expect((await fail(fetchBrief(env.db, p, b1.leaseId, { role: 'engineer', cwd: `${b1.worktree}-x` }))).code).toBe('POLICY_DENIED');
    // from the main repo (coordinator cwd) or with another role
    expect((await fail(fetchBrief(env.db, p, b1.leaseId, { role: 'engineer', cwd: env.layout.repo }))).code).toBe('POLICY_DENIED');
    const wrongRole = await fail(fetchBrief(env.db, p, b1.leaseId, { role: 'reviewer', cwd: b1.worktree }));
    expect(wrongRole.code).toBe('POLICY_DENIED');
    expect(wrongRole.message).toMatch(/belongs to a engineer/);
    // unknown, malformed (path traversal) and ended leases
    expect((await fail(fetchBrief(env.db, p, 'lease-000000000000', { role: 'engineer', cwd: b1.worktree }))).code).toBe('NOT_FOUND');
    expect((await fail(fetchBrief(env.db, p, '../minions', { role: 'engineer', cwd: b1.worktree }))).code).toBe('PRECONDITION');
    await env.sched.release(b1.leaseId, 'done');
    expect((await fail(fetchBrief(env.db, p, b1.leaseId, { role: 'engineer', cwd: b1.worktree }))).code).toBe('CONFLICT');
  });

  it('a lease claimed without a stored brief fails with a hint', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const brief = await env.sched.claim('task-1', 'engineer');
    const e = await fail(fetchBrief(env.db, paths(env), brief.leaseId, { role: 'engineer', cwd: brief.worktree }));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.hint).toMatch(/paste the brief|reclaim/);
  });

  it('the pre-agent hook accepts a prompt with only the lease marker plus notes (hook unchanged)', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const c = compactClaim(await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer'));
    const prompt = `${c.briefMarker}\nworktree: ${c.worktree}\n\nCoordinator notes: keep README edits small.`;
    const load = () => ({ db: env.db, backlog: env.backlog, config: env.config });
    const ok = await preAgentHook({ tool_input: { subagent_type: 'minions:engineer', prompt } }, load);
    expect(ok.stdout).toBeUndefined();
    const denied = await preAgentHook({ tool_input: { subagent_type: 'minions:engineer', prompt: `worktree: ${c.worktree}` } }, load);
    expect(denied.stdout).toMatch(/deny/);
  });
});

describe('file-based result hand-off', () => {
  async function engineer(env: Env) {
    env.backlog.add({ id: 'task-1' });
    const brief = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    const head = commitFile(brief.worktree, 'a.txt', 'work');
    return { brief, head, owner: { role: 'engineer', cwd: brief.worktree } };
  }

  it('submit + record --submitted applies the transition without the coordinator handling the JSON', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const s = await submitResult(env.db, paths(env), brief.leaseId, '```json\n' + json(result({ branch: brief.branch, headSha: head })) + '\n```', owner);
    expect(s).toMatchObject({ leaseId: brief.leaseId, replaced: false });
    expect(s.path).toBe(submissionPath(paths(env), brief.leaseId));
    const r = await recordSubmitted(env.sched, paths(env), brief.leaseId);
    expect(r).toMatchObject({ valid: true, from: 'implementing', to: 'testing' });
    expect(env.backlog.status('task-1')).toBe('testing');
    expect(existsSync(s.path)).toBe(false); // the DB holds the recorded result
    expect(JSON.parse(env.db.lease(brief.leaseId)!.result_json!).headSha).toBe(head);
    expect(env.db.events('task-1', 'submit')).toHaveLength(1);
  });

  it('a missing submission fails clearly with a hint; the lease stays active', async () => {
    const env = makeEnv();
    const { brief } = await engineer(env);
    const e = await fail(recordSubmitted(env.sched, paths(env), brief.leaseId));
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toMatch(/No submitted result/);
    expect(e.hint).toContain(`minions work submit ${brief.leaseId}`);
    expect(env.db.lease(brief.leaseId)!.status).toBe('active');
  });

  it('keeps the correction semantics: invalid -> errors, resubmit, record --correction', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: 'abc' })), owner);
    const bad = await recordSubmitted(env.sched, p, brief.leaseId);
    expect(bad).toMatchObject({ valid: false, correctionAllowed: true });
    expect(bad.errors!.join('\n')).toMatch(/headSha/);
    expect(bad.message).toMatch(/minions work submit/);
    expect(existsSync(rejectedPath(p, brief.leaseId))).toBe(true);
    // recording again without --correction is refused exactly as on stdin
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    expect((await fail(recordSubmitted(env.sched, p, brief.leaseId))).code).toBe('PRECONDITION');
    const ok = await recordSubmitted(env.sched, p, brief.leaseId, { correction: true });
    expect(ok).toMatchObject({ valid: true, to: 'testing' });
    expect(existsSync(submissionPath(p, brief.leaseId))).toBe(false);
    expect(existsSync(rejectedPath(p, brief.leaseId))).toBe(false);
  });

  it('a correction needs a fresh submission, and a second invalid result ends unvalidated', async () => {
    const env = makeEnv();
    const { brief, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, 'not json', owner);
    expect((await recordSubmitted(env.sched, p, brief.leaseId)).valid).toBe(false);
    const missing = await fail(recordSubmitted(env.sched, p, brief.leaseId, { correction: true }));
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.message).toMatch(/No corrected result/);
    await submitResult(env.db, p, brief.leaseId, '{"status":"complete"}', owner);
    const r = await recordSubmitted(env.sched, p, brief.leaseId, { correction: true });
    expect(r).toMatchObject({ valid: false, correctionAllowed: false, unvalidated: true });
    expect(env.db.lease(brief.leaseId)!.status).toBe('unvalidated');
    expect(env.backlog.status('task-1')).toBe('ready');
    expect(existsSync(submissionPath(p, brief.leaseId))).toBe(false);
  });

  it('only the lease worker can submit; a later submit replaces an earlier one', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    const good = json(result({ branch: brief.branch, headSha: head }));
    expect((await fail(submitResult(env.db, p, brief.leaseId, good, { role: 'engineer', cwd: env.layout.repo }))).code).toBe('POLICY_DENIED');
    expect((await fail(submitResult(env.db, p, brief.leaseId, good, { role: 'tester', cwd: brief.worktree }))).code).toBe('POLICY_DENIED');
    expect((await fail(submitResult(env.db, p, brief.leaseId, '  ', owner))).code).toBe('PRECONDITION');
    await submitResult(env.db, p, brief.leaseId, '{}', owner);
    expect((await submitResult(env.db, p, brief.leaseId, good, owner)).replaced).toBe(true);
    expect((await recordSubmitted(env.sched, p, brief.leaseId)).valid).toBe(true);
    expect((await fail(submitResult(env.db, p, brief.leaseId, good, owner))).code).toBe('CONFLICT'); // lease ended
  });

  it('a read-only reviewer submits from its review worktree (written under state, not the worktree)', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    await recordSubmitted(env.sched, p, brief.leaseId);
    const tester = await claimWithBrief(env.sched, p, 'task-1', 'tester');
    await submitResult(env.db, p, tester.leaseId, json(result({ branch: brief.branch, headSha: head })), { role: 'tester', cwd: tester.worktree });
    await recordSubmitted(env.sched, p, tester.leaseId);
    const rev = await claimWithBrief(env.sched, p, 'task-1', 'reviewer');
    expect((await fetchBrief(env.db, p, rev.leaseId, { role: 'reviewer', cwd: rev.worktree })).expectedHead).toBe(head);
    const s = await submitResult(env.db, p, rev.leaseId, json(result({ branch: brief.branch, headSha: head, verdict: 'approve' })), { role: 'reviewer', cwd: rev.worktree });
    expect(s.path.startsWith(p.results)).toBe(true);
    expect((await recordSubmitted(env.sched, p, rev.leaseId)).approved).toBe(true);
    expect(env.backlog.status('task-1')).toBe('delivered');
  });

  it('the stdin record path still works', async () => {
    const env = makeEnv();
    const { brief, head } = await engineer(env);
    expect((await env.sched.record(brief.leaseId, json(result({ branch: brief.branch, headSha: head })))).valid).toBe(true);
  });
});

describe('compact backlog output', () => {
  const env = makeEnv();
  const task = env.backlog.add({ id: 'task-1', description: 'very long text', dependencies: ['task-0'] });

  it('--compact keeps id, title, status, priority, dependencies', () => {
    expect(selectFields({ compact: true })).toEqual([...COMPACT_FIELDS]);
    expect(projectTasks([task], selectFields({ compact: true }))).toEqual([{ id: 'task-1', title: 'Task task-1', status: 'ready', priority: 'medium', dependencies: ['task-0'] }]);
  });

  it('--fields selects fields (deduplicated, overriding --compact); unknown fields are rejected', () => {
    expect(projectTasks([task], selectFields({ fields: 'id, status,id' }))).toEqual([{ id: 'task-1', status: 'ready' }]);
    expect(selectFields({ fields: 'id', compact: true })).toEqual(['id']);
    expect(() => selectFields({ fields: 'id,secret' })).toThrow(/secret/);
    expect(() => selectFields({ fields: ',' })).toThrow(/--fields/);
  });

  it('no flags keeps full tasks', () => {
    expect(selectFields({})).toBeUndefined();
    expect(projectTasks([task])).toEqual([task]);
  });
});

describe('CLI wiring', () => {
  const program = new Command();
  registerRuntime(program);
  registerBacklog(program);
  const sub = (group: string, name: string) => program.commands.find((c) => c.name() === group)!.commands.find((c) => c.name() === name)!;
  const flags = (group: string, name: string) => sub(group, name).options.map((o) => o.long).sort();

  it('registers work brief/submit, record --submitted and claim --compact', () => {
    expect(flags('work', 'brief')).toEqual(['--role']);
    expect(flags('work', 'submit')).toEqual(['--result-file', '--role']);
    expect(flags('work', 'record')).toEqual(['--correction', '--model', '--result-file', '--submitted', '--usage']);
    expect(flags('work', 'claim')).toEqual(['--compact', '--holder', '--role']);
  });

  it('registers --fields/--compact on backlog list and ready', () => {
    expect(flags('backlog', 'list')).toEqual(['--compact', '--fields']);
    expect(flags('backlog', 'ready')).toEqual(['--compact', '--fields', '--limit']);
  });
});
