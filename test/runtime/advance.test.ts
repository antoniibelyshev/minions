// `minions work advance` (task-68.7): record the submitted result, then claim the next stage or return a decision.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MinionsError } from '../../src/core/errors.js';
import { advanceLease, humanAdvance } from '../../src/runtime/advance.js';
import { requestDrain } from '../../src/runtime/drain.js';
import { claimWithBrief, submissionPath, submitResult, type HandoffPaths } from '../../src/runtime/handoff.js';
import { coordinatorOnlyWorkCommand, preBashHook } from '../../src/runtime/hooks.js';
import { latestLeaseUsage, setBudget } from '../../src/runtime/spend.js';
import type { TaskBrief } from '../../src/runtime/scheduler.js';
import { commitFile, makeDefaultEnv, makeEnv, result, type Env } from './fixtures.js';

const paths = (env: Env): HandoffPaths => ({ briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') });
const deps = (env: Env) => ({ db: env.db, config: env.config });

/** Claims the current stage of `taskId`, commits (producers) and submits `over` as the worker would. */
async function stage(env: Env, taskId: string, over: Record<string, unknown> = {}, opts: { commit?: boolean } = {}): Promise<TaskBrief> {
  const brief = await claimWithBrief(env.sched, paths(env), taskId, undefined);
  return submitFor(env, brief, over, opts);
}

async function submitFor(env: Env, brief: TaskBrief, over: Record<string, unknown> = {}, opts: { commit?: boolean } = {}): Promise<TaskBrief> {
  const head = (opts.commit ?? brief.role === 'engineer') ? commitFile(brief.worktree, `${brief.leaseId}.txt`, 'work') : brief.expectedHead;
  await submitResult(env.db, paths(env), brief.leaseId, JSON.stringify(result({ branch: brief.branch, headSha: head, ...over })), { role: brief.role, cwd: brief.worktree });
  return brief;
}

describe('work advance: record + next claim', () => {
  it('records the engineer result with usage and claims the same task\'s next stage, with the Agent parameters', async () => {
    const env = makeEnv(); // testerRequired: engineer -> tester -> reviewer
    env.backlog.add({ id: 'task-1' });
    const e = await stage(env, 'task-1');
    const r = await advanceLease(env.sched, paths(env), e.leaseId, { usage: { tokens: 12_345 } }, deps(env));
    expect(r.record).toMatchObject({ valid: true, from: 'implementing', to: 'testing', usage: { tokens: 12_345 } });
    expect(latestLeaseUsage(env.db, e.leaseId)?.tokens).toBe(12_345);
    expect(r.decision).toBeUndefined();
    expect(r.next).toMatchObject({ taskId: 'task-1', role: 'tester', agentType: 'minions:tester', briefMarker: `minions-lease: ${r.next!.leaseId}`, branch: e.branch });
    expect(r.next).toHaveProperty('agentModel');
    expect(r.next!.launch).toBeUndefined(); // an Agent stage: no runner command
    // Exactly what `work claim --compact` stores: the full brief for the worker, the lease active.
    const stored = JSON.parse(readFileSync(join(paths(env).briefs, `${r.next!.leaseId}.json`), 'utf8')) as TaskBrief;
    expect(stored).toMatchObject({ leaseId: r.next!.leaseId, role: 'tester' });
    expect(env.db.lease(r.next!.leaseId)!.status).toBe('active');
    expect(existsSync(submissionPath(paths(env), e.leaseId))).toBe(false);
    expect(humanAdvance(r)).toMatch(/next: task-1 tester -> minions:tester/);
  });

  it('prefers the same task\'s next stage over a higher-priority ready task, and takes `work next` order otherwise', async () => {
    const env = makeDefaultEnv((c) => { c.execution.maxActiveTasks = 3; c.execution.maxEngineers = 3; });
    env.backlog.add({ id: 'task-1', priority: 'low' });
    const e = await stage(env, 'task-1');
    env.backlog.add({ id: 'task-2', priority: 'high' });
    const r = await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env));
    expect(r.next).toMatchObject({ taskId: 'task-1', role: 'reviewer' });

    // The reviewer asks for changes on task-1 while task-2 waits: the repair of task-1 comes first (under way).
    await submitFor(env, stored(env, r.next!.leaseId), { status: 'needs_changes', verdict: 'request-changes' });
    const rr = await advanceLease(env.sched, paths(env), r.next!.leaseId, {}, deps(env));
    expect(rr.record.to).toBe('changes-requested');
    expect(rr.next).toMatchObject({ taskId: 'task-1', role: 'engineer' });
  });

  it('after a delivery claims the first runnable stage overall', async () => {
    const env = makeDefaultEnv((c) => { c.execution.maxActiveTasks = 3; c.execution.maxEngineers = 3; });
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    env.backlog.add({ id: 'task-3', priority: 'high' });
    const e1 = await stage(env, 'task-1');
    const e2 = await claimWithBrief(env.sched, paths(env), 'task-2', 'engineer'); // keeps a lease active (no context reset)
    const rev = await advanceLease(env.sched, paths(env), e1.leaseId, {}, deps(env));
    expect(rev.next).toMatchObject({ taskId: 'task-1', role: 'reviewer' });
    await submitFor(env, stored(env, rev.next!.leaseId), { verdict: 'approve' });
    const r = await advanceLease(env.sched, paths(env), rev.next!.leaseId, {}, deps(env));
    expect(r.record).toMatchObject({ valid: true, to: 'delivered', approved: true });
    expect(r.next).toMatchObject({ taskId: 'task-3', role: 'engineer' });
    expect(e2.leaseId).not.toBe(r.next!.leaseId);
  });

  it('an invalid result claims nothing and returns the errors; the correction then advances', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const e = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    const head = commitFile(e.worktree, 'a.txt', 'work');
    await submitResult(env.db, paths(env), e.leaseId, JSON.stringify(result({ branch: e.branch, headSha: 'f'.repeat(40) })), { role: 'engineer', cwd: e.worktree });
    const leasesBefore = env.db.leases({ all: true }).length;
    const bad = await advanceLease(env.sched, paths(env), e.leaseId, { usage: { tokens: 100 } }, deps(env));
    expect(bad.record.valid).toBe(false);
    expect(bad.next).toBeUndefined();
    expect(bad.decision).toMatchObject({ kind: 'invalid', taskId: 'task-1', correctionAllowed: true });
    expect(bad.decision!.errors!.join(' ')).toMatch(/stale head/);
    expect(env.db.leases({ all: true })).toHaveLength(leasesBefore);
    await submitResult(env.db, paths(env), e.leaseId, JSON.stringify(result({ branch: e.branch, headSha: head })), { role: 'engineer', cwd: e.worktree });
    const ok = await advanceLease(env.sched, paths(env), e.leaseId, { correction: true, usage: { tokens: 200 } }, deps(env));
    expect(ok.record).toMatchObject({ valid: true, to: 'testing' });
    expect(ok.next).toMatchObject({ taskId: 'task-1', role: 'tester' });
    expect(latestLeaseUsage(env.db, e.leaseId)?.tokens).toBe(200);
  });

  it('an invalid correction (unvalidated) claims nothing', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const e = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    const bad = JSON.stringify(result({ branch: e.branch, headSha: 'f'.repeat(40) }));
    await submitResult(env.db, paths(env), e.leaseId, bad, { role: 'engineer', cwd: e.worktree });
    await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env));
    await submitResult(env.db, paths(env), e.leaseId, bad, { role: 'engineer', cwd: e.worktree });
    const r = await advanceLease(env.sched, paths(env), e.leaseId, { correction: true }, deps(env));
    expect(r.decision).toMatchObject({ kind: 'invalid', unvalidated: true, correctionAllowed: false });
    expect(env.db.activeLeases()).toHaveLength(0);
  });

  it.each([
    ['paused', (env: Env) => env.db.setPaused({ starts: true })],
    ['draining', (env: Env) => { requestDrain(env.db, { drainFlag: join(env.root, 'state', 'run', 'drain') }, 'upgrade'); }],
    // The attempts budget counts claims from when it is set: the engineer claim uses the only one.
    ['budget', (env: Env) => { setBudget({ db: env.db, billing: 'subscription' }, '1 attempts'); }],
  ] as const)('never claims while %s: records, then returns the decision', async (kind, block) => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    if (kind === 'budget') block(env);
    const e = await stage(env, 'task-1');
    if (kind !== 'budget') block(env);
    const r = await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env));
    expect(r.record).toMatchObject({ valid: true, to: 'testing' });
    expect(r.next).toBeUndefined();
    expect(r.decision).toMatchObject({ kind, code: 'POLICY_DENIED' });
    expect(env.db.activeLeases()).toHaveLength(0);
  });

  it.each([
    ['blocked', { status: 'blocked' }],
    ['needs-split', { status: 'needs_split' }],
    ['partial', { status: 'partial' }],
    ['needs-changes', { status: 'needs_changes' }],
  ] as const)('a %s result returns a decision and claims nothing, even with other work runnable', async (kind, over) => {
    const env = makeEnv((c) => { c.execution.maxActiveTasks = 3; c.execution.maxEngineers = 3; });
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const e = await stage(env, 'task-1', over);
    const r = await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env));
    expect(r.record.valid).toBe(true);
    expect(r.decision).toMatchObject({ kind, taskId: 'task-1' });
    expect(r.next).toBeUndefined();
    expect(env.db.activeLeases()).toHaveLength(0);
  });

  it('replan at the repair-cycle limit is a decision', async () => {
    const env = makeDefaultEnv((c) => { c.execution.maxRepairCyclesBeforeReplan = 1; });
    env.backlog.add({ id: 'task-1' });
    const e = await stage(env, 'task-1');
    const rev = await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env));
    await submitFor(env, stored(env, rev.next!.leaseId), { status: 'needs_changes', verdict: 'request-changes' });
    const r = await advanceLease(env.sched, paths(env), rev.next!.leaseId, {}, deps(env));
    expect(r.record).toMatchObject({ replan: true, to: 'awaiting-human' });
    expect(r.decision?.kind).toBe('replan');
    expect(r.next).toBeUndefined();
  });

  it('nothing runnable and capacity are decisions', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const e = await stage(env, 'task-1', { status: 'blocked' });
    expect((await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env))).decision?.kind).toBe('blocked');

    const cap = makeDefaultEnv((c) => { c.execution.maxActiveTasks = 2; c.execution.maxEngineers = 2; c.execution.maxByRole = { reviewer: 1 }; });
    for (const id of ['task-1', 'task-2']) cap.backlog.add({ id });
    const a = await stage(cap, 'task-1');
    const b = await stage(cap, 'task-2');
    expect((await advanceLease(cap.sched, paths(cap), a.leaseId, {}, deps(cap))).next).toMatchObject({ taskId: 'task-1', role: 'reviewer' });
    const r = await advanceLease(cap.sched, paths(cap), b.leaseId, {}, deps(cap));
    expect(r.decision).toMatchObject({ kind: 'capacity' });
    expect(r.decision!.waiting).toEqual([expect.objectContaining({ taskId: 'task-2', role: 'reviewer', waitingOn: 'role-capacity' })]);

    const none = makeDefaultEnv();
    none.backlog.add({ id: 'task-1' });
    const n = await stage(none, 'task-1');
    const rev = await advanceLease(none.sched, paths(none), n.leaseId, {}, deps(none));
    await submitFor(none, stored(none, rev.next!.leaseId), { verdict: 'approve' });
    const done = await advanceLease(none.sched, paths(none), rev.next!.leaseId, {}, deps(none));
    expect(done.record.to).toBe('delivered');
    expect(done.decision).toMatchObject({ kind: 'nothing-runnable', message: expect.stringMatching(/Nothing runnable/) });
    expect(done.next).toBeUndefined();
  });

  it('a due context reset comes before more dispatching: no claim, the record carries contextReset', async () => {
    const env = makeDefaultEnv((c) => { c.execution.maxActiveTasks = 3; c.execution.maxEngineers = 3; });
    env.db.acquireCoordinatorLock('coordinator', 4242, () => false);
    env.backlog.add({ id: 'task-1' });
    const e = await stage(env, 'task-1');
    const rev = await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env));
    env.backlog.add({ id: 'task-2' });
    await submitFor(env, stored(env, rev.next!.leaseId), { verdict: 'approve' });
    const r = await advanceLease(env.sched, paths(env), rev.next!.leaseId, {}, deps(env));
    expect(r.record).toMatchObject({ to: 'delivered', contextReset: { due: true } });
    expect(r.decision).toMatchObject({ kind: 'context-reset', message: expect.stringMatching(/delivered task-1/) });
    expect(env.db.activeLeases()).toHaveLength(0);
  });

  it('a QA sweep with findings is a decision (create the tasks); without findings it advances', async () => {
    const env = makeEnv((c) => { c.execution.maxActiveTasks = 3; c.execution.maxEngineers = 3; });
    env.backlog.add({ id: 'task-1', labels: ['qa-sweep'] });
    env.backlog.add({ id: 'task-2', labels: ['qa-sweep'] });
    env.backlog.add({ id: 'task-3' });
    const s1 = await stage(env, 'task-1', { findings: ['README typo'] });
    expect(s1.kind).toBe('qa-sweep');
    const r = await advanceLease(env.sched, paths(env), s1.leaseId, {}, deps(env));
    expect(r.record.to).toBe('done');
    expect(r.decision).toMatchObject({ kind: 'qa-findings', findings: 1, taskId: 'task-1' });
    const s2 = await stage(env, 'task-2');
    const r2 = await advanceLease(env.sched, paths(env), s2.leaseId, {}, deps(env));
    expect(r2.decision).toBeUndefined();
    expect(r2.next).toMatchObject({ taskId: 'task-3', role: 'engineer' });
  });

  it('a refused claim after the record is a decision, not an error (the record stays)', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const e = await stage(env, 'task-1');
    env.sched.claim = async () => { throw new MinionsError('CONFLICT', 'another stage is active'); };
    const r = await advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env));
    expect(r.record).toMatchObject({ valid: true, to: 'testing' });
    expect(r.decision).toMatchObject({ kind: 'claim-failed', code: 'CONFLICT', taskId: 'task-1' });
  });

  it('a missing submission fails like record --submitted and claims nothing', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const e = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    await expect(advanceLease(env.sched, paths(env), e.leaseId, {}, deps(env))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(env.db.lease(e.leaseId)!.status).toBe('active');
  });
});

describe('work advance is coordinator-only', () => {
  it('the pre-bash hook denies it to a subagent and allows the coordinator', () => {
    expect(coordinatorOnlyWorkCommand('minions work advance lease-1 --usage 5 --json')).toBe('minions work advance');
    const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });
    expect(JSON.stringify(preBashHook(bash('minions work advance lease-1 --json', { agent_id: 'a1' })))).toMatch(/deny/);
    expect(preBashHook(bash('minions work advance lease-1 --json'))).toEqual({ reason: 'allow: Bash from the coordinator' });
  });
});

function stored(env: Env, leaseId: string): TaskBrief {
  return JSON.parse(readFileSync(join(paths(env).briefs, `${leaseId}.json`), 'utf8')) as TaskBrief;
}
