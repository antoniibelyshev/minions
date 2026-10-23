// task-33.5: the thin stage runner (docs/design/roles-and-workflows.md D12). `Scheduler.next()` lists the stages a
// claim could start now, from the stage machine (stagePlan), and `claim` without a role picks the stage's role.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import { collectStatus, humanNext, humanStatus } from '../../src/runtime/commands.js';
import { commitFile, makeDefaultEnv, result, type Env } from './fixtures.js';

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};
const ROLES = {
  researcher: { description: 'Researches.', promptText: 'Research.', contract: 'producer', edits: { paths: ['docs/research/**'] } },
  writer: { description: 'Writes docs.', promptText: 'Write.', contract: 'producer', edits: { paths: ['docs/**'] } },
  fetcher: { description: 'Needs the network.', promptText: 'Fetch.', contract: 'producer', requires: ['network.use'], capabilities: { 'network.use': 'deny' } },
};
const WORKFLOWS = {
  research: ['researcher', 'writer', 'reviewer'],
  fetch: ['fetcher', 'engineer', 'reviewer'],
  cheap: [{ role: 'engineer', model: 'sonnet' }, { role: 'reviewer', model: 'haiku' }],
};
const env = (mutate?: Parameters<typeof makeDefaultEnv>[0]) => makeDefaultEnv((c) => {
  (c as { roles?: unknown }).roles = structuredClone(ROLES);
  (c as { workflows?: unknown }).workflows = structuredClone(WORKFLOWS);
  mutate?.(c);
});
const commit = (dir: string, file: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  return commitFile(dir, file, `x ${Math.random()}`);
};
async function stageIn(e: Env, id: string, role: string | undefined, files: string[] = ['a.txt'], over: Record<string, unknown> = {}) {
  const brief = await e.sched.claim(id, role);
  let head = brief.expectedHead;
  for (const f of files) head = commit(brief.worktree, f);
  const r = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: files, ...over }));
  return { brief, head, r };
}
const ids = (xs: { taskId: string }[]) => xs.map((x) => x.taskId);

describe('work next: runnable stages from the stage machine', () => {
  it('lists a ready task as its first stage with every documented field', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', title: 'First' });
    const n = await e.sched.next();
    expect(n.runnable).toEqual([{
      taskId: 'task-1', title: 'First', status: 'ready', priority: 'medium', kind: 'task',
      role: 'engineer', agentType: 'minions:engineer', position: 0, count: 3, workflow: 'default',
      suggestedModel: 'sonnet', agentModel: null, modelRule: 'default',
      harness: 'claude', launch: { kind: 'agent', agentType: 'minions:engineer', agentModel: null },
      reason: 'ready: stage 1/3 (engineer) of workflow default; model: default',
    }]);
    expect(n).toMatchObject({ waiting: [], stuck: [], startsBlocked: null, message: '1 runnable stage(s): task-1 engineer' });
    expect(n.capacity.byRole.engineer).toMatchObject({ active: 0, max: 2, limited: true });
  });

  it('follows the task through its workflow: reviewer after the engineer, the inserted tester when QA is required', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await stageIn(e, 'task-1', undefined);
    expect(e.backlog.status('task-1')).toBe('reviewing');
    expect((await e.sched.next()).runnable[0]).toMatchObject({ taskId: 'task-1', role: 'reviewer', agentType: 'minions:reviewer', position: 2, status: 'reviewing' });

    e.backlog.add({ id: 'task-2', labels: ['qa'] });
    await stageIn(e, 'task-2', 'engineer');
    expect(e.backlog.status('task-2')).toBe('testing');
    const t = (await e.sched.next()).runnable.find((x) => x.taskId === 'task-2')!;
    expect(t).toMatchObject({ role: 'tester', position: 1, workflow: 'default' });
    expect(t.reason).toMatch(/^testing: stage 2\/3 \(tester\) of workflow default/);
  });

  it('a multi-producer workflow: the task sits in implementing without a lease and the next producer is runnable (33.3 review)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    await stageIn(e, 'task-1', 'researcher', ['docs/research/a.md']);
    expect(e.backlog.status('task-1')).toBe('implementing');
    const n = await e.sched.next();
    expect(n.runnable).toEqual([expect.objectContaining({ taskId: 'task-1', role: 'writer', agentType: 'minions:writer', position: 1, count: 3, workflow: 'research', status: 'implementing' })]);
    expect(n.stuck).toEqual([]);
  });

  it('a repair is listed as a repair cycle of the repair target', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await stageIn(e, 'task-1', 'engineer');
    await stageIn(e, 'task-1', 'reviewer', [], { status: 'needs_changes', verdict: 'request-changes', modifiedPaths: [] });
    const r = (await e.sched.next()).runnable[0]!;
    expect(r).toMatchObject({ taskId: 'task-1', role: 'engineer', position: 0, status: 'changes-requested' });
    expect(r.reason).toMatch(/^changes-requested: repair \(cycle 1\) at stage 1\/3 \(engineer\)/);
  });

  it('excludes leased tasks and ready tasks that are not startable (unauthorized, unmet dependency)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    e.backlog.add({ id: 'task-2', authorized: false });
    e.backlog.add({ id: 'task-3', dependencies: ['task-4'] });
    e.backlog.add({ id: 'task-4', status: 'blocked' });
    await e.sched.claim('task-1');
    const n = await e.sched.next();
    expect(n.runnable).toEqual([]);
    expect(n.waiting).toEqual([]);
    expect(n.message).toBe('Nothing runnable: no ready task and no task waiting for its next stage.');
  });

  it('orders tasks under way before new ones, then by priority', async () => {
    const e = env((c) => { c.execution.maxActiveTasks = 5; c.execution.maxEngineers = 5; });
    e.backlog.add({ id: 'task-1', priority: 'low' });
    e.backlog.add({ id: 'task-2', priority: 'high' });
    e.backlog.add({ id: 'task-3', priority: 'medium' });
    e.backlog.add({ id: 'task-9', priority: 'low' });
    await stageIn(e, 'task-9', 'engineer');
    expect(ids((await e.sched.next()).runnable)).toEqual(['task-9', 'task-2', 'task-3', 'task-1']);
  });
});

describe('work next: QA sweeps', () => {
  it('lists a ready qa-sweep as a tester sweep without a stage plan, never as an engineer stage', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', labels: ['qa-sweep'] });
    const n = await e.sched.next();
    expect(n.runnable).toEqual([expect.objectContaining({ taskId: 'task-1', kind: 'qa-sweep', role: 'tester', agentType: 'minions:tester', position: null, count: null, workflow: null })]);
    expect(n.runnable[0]!.reason).toMatch(/^QA sweep of main/);
    // claim without a role runs the sweep's tester
    const b = await e.sched.claim('task-1');
    expect(b).toMatchObject({ role: 'tester', kind: 'qa-sweep' });
    expect(b.stage).toBeUndefined();
  });

  it('an engineer claim of a sweep is still refused', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', labels: ['qa-sweep'] });
    expect((await err(e.sched.claim('task-1', 'engineer'))).message).toMatch(/QA sweep/);
  });
});

describe('work next: pauses, drain, capacity and requires', () => {
  it('paused starts: nothing runnable; every stage waits with the claim error', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    e.db.setPaused({ starts: true });
    const n = await e.sched.next();
    expect(n.runnable).toEqual([]);
    expect(n.startsBlocked).toMatchObject({ code: 'POLICY_DENIED', message: 'Starts are paused (paused_starts).' });
    expect(n.waiting).toEqual([expect.objectContaining({ taskId: 'task-1', role: 'engineer', waitingOn: 'starts' })]);
    expect(n.message).toMatch(/^Nothing runnable: Starts are paused/);
  });

  it('a drain: nothing runnable and the drain is named', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    e.db.setPaused({ starts: true });
    e.db.setDrain('upgrade');
    const n = await e.sched.next();
    expect(n.runnable).toEqual([]);
    expect(n.startsBlocked!.message).toMatch(/paused for a drain \(upgrade/);
  });

  it('applies the active task limit greedily in dispatch order', async () => {
    const e = env();
    for (const id of ['task-1', 'task-2', 'task-3']) e.backlog.add({ id });
    const n = await e.sched.next();
    expect(ids(n.runnable)).toEqual(['task-1', 'task-2']);
    expect(n.waiting).toEqual([expect.objectContaining({ taskId: 'task-3', waitingOn: 'capacity', why: 'active task limit (2/2)' })]);
  });

  it('applies per-role limits (execution.maxByRole) and leaves other roles runnable', async () => {
    const e = env((c) => { c.execution.maxActiveTasks = 5; delete (c.execution as { maxEngineers?: number }).maxEngineers; c.execution.maxByRole = { engineer: 1 }; });
    e.backlog.add({ id: 'task-1' });
    e.backlog.add({ id: 'task-2' });
    e.backlog.add({ id: 'task-3' });
    await stageIn(e, 'task-3', 'engineer'); // task-3 now waits for its reviewer
    const n = await e.sched.next();
    expect(n.runnable.map((x) => `${x.taskId}:${x.role}`)).toEqual(['task-3:reviewer', 'task-1:engineer']);
    expect(n.waiting).toEqual([expect.objectContaining({ taskId: 'task-2', waitingOn: 'role-capacity', why: 'engineer limit (1/1)' })]);
  });

  it('a stage whose required capability is denied waits with the capability named', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'fetch' });
    const n = await e.sched.next();
    expect(n.runnable).toEqual([]);
    expect(n.waiting).toEqual([expect.objectContaining({ taskId: 'task-1', role: 'fetcher', waitingOn: 'requires', why: expect.stringMatching(/requires network\.use, which is denied/) })]);
  });

  it('a stage status without a lease that no stage can be claimed from is reported as stuck', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', status: 'implementing' });
    e.backlog.add({ id: 'task-2', workflow: 'gone' });
    const n = await e.sched.next();
    expect(n.runnable).toEqual([]);
    expect(n.stuck).toEqual([
      expect.objectContaining({ taskId: 'task-1', status: 'implementing', reason: expect.stringMatching(/cannot be claimed from it/) }),
      expect.objectContaining({ taskId: 'task-2', reason: expect.stringMatching(/workflow "gone", which is not configured/) }),
    ]);
  });
});

describe('work next: suggested model and agent type', () => {
  it('stage hints win; the definition model is passed as null (omit)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'cheap' });
    expect((await e.sched.next()).runnable[0]).toMatchObject({ role: 'engineer', suggestedModel: 'sonnet', agentModel: null, modelRule: 'stage' });
    await stageIn(e, 'task-1', undefined);
    expect((await e.sched.next()).runnable[0]).toMatchObject({ role: 'reviewer', suggestedModel: 'haiku', agentModel: 'haiku', modelRule: 'stage' });
  });

  it('risk:low: the cheapest allowed alias for the gate, the default for the producer', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', labels: ['risk:low'] });
    expect((await e.sched.next()).runnable[0]).toMatchObject({ role: 'engineer', suggestedModel: 'sonnet', modelRule: 'default' });
    await stageIn(e, 'task-1', 'engineer');
    expect((await e.sched.next()).runnable[0]).toMatchObject({ role: 'reviewer', suggestedModel: 'haiku', agentModel: 'haiku', modelRule: 'risk-low' });
  });

  it('risk:high: the strongest allowed alias and the deep engineer', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', labels: ['risk:high'] });
    const r = (await e.sched.next()).runnable[0]!;
    expect(r).toMatchObject({ role: 'engineer', agentType: 'minions:engineer-deep', suggestedModel: 'opus', agentModel: 'opus', modelRule: 'risk-high' });
    expect(r.reason).toMatch(/model: risk-high, deep variant$/);
  });

  it('a repair after a failed engineer attempt (blocked) escalates to the deep engineer and the strongest alias', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    const b = await stageIn(e, 'task-1', 'engineer', [], { status: 'blocked', modifiedPaths: [] });
    expect(b.r.valid).toBe(true);
    await e.backlog.updateTask('task-1', (await e.backlog.getTask('task-1')).version, { status: 'ready' });
    expect((await e.sched.next()).runnable[0]).toMatchObject({ agentType: 'minions:engineer-deep', suggestedModel: 'opus', modelRule: 'repair-after-failure' });
  });

  it('the second repair cycle (the first repair did not fix the findings) escalates the engineer', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await stageIn(e, 'task-1', 'engineer');
    await stageIn(e, 'task-1', 'reviewer', [], { status: 'needs_changes', verdict: 'request-changes', modifiedPaths: [] });
    expect((await e.sched.next()).runnable[0]).toMatchObject({ agentType: 'minions:engineer', modelRule: 'default' });
    await stageIn(e, 'task-1', 'engineer', ['b.txt']);
    await stageIn(e, 'task-1', 'reviewer', [], { status: 'needs_changes', verdict: 'request-changes', modifiedPaths: [] });
    expect((await e.sched.next()).runnable[0]).toMatchObject({ agentType: 'minions:engineer-deep', suggestedModel: 'opus', modelRule: 'repair-after-failure' });
  });

  it('a drained partial is not a failed attempt; an ordinary partial is', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    e.backlog.add({ id: 'task-2' });
    const b = await e.sched.claim('task-1', undefined);
    const d = e.db.setDrain('upgrade');
    e.db.recordDrainNotice({ id: b.leaseId, task_id: 'task-1' }, { eventId: d.eventId, agentId: 'agent-1', agentType: 'minions:engineer', tool: 'Bash', via: 'only' });
    const wip = commit(b.worktree, 'a.txt');
    const r = await e.sched.record(b.leaseId, result({ status: 'partial', branch: b.branch, headSha: wip, modifiedPaths: ['a.txt'] }));
    expect(r).toMatchObject({ valid: true, drain: true });
    e.db.clearDrain('test');
    await stageIn(e, 'task-2', undefined, ['b.txt'], { status: 'partial' });
    const n = await e.sched.next();
    expect(n.runnable.find((x) => x.taskId === 'task-1')).toMatchObject({ agentType: 'minions:engineer', modelRule: 'default' });
    expect(n.runnable.find((x) => x.taskId === 'task-2')).toMatchObject({ agentType: 'minions:engineer-deep', suggestedModel: 'opus', modelRule: 'repair-after-failure' });
  });

  it('selection fixed: always the default model (omit model)', async () => {
    const e = env((c) => { c.models.selection = 'fixed'; });
    e.backlog.add({ id: 'task-1', labels: ['risk:high'] });
    e.backlog.add({ id: 'task-2', workflow: 'cheap' });
    const n = await e.sched.next();
    for (const r of n.runnable) expect(r).toMatchObject({ suggestedModel: 'sonnet', agentModel: null, modelRule: 'fixed' });
  });
});

describe('claim without --role', () => {
  it('infers the current stage role, including a later producer of a multi-producer workflow', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const a = await stageIn(e, 'task-1', undefined, ['docs/research/a.md']);
    expect(a.brief).toMatchObject({ role: 'researcher', stage: { position: 0, role: 'researcher' } });
    const w = await e.sched.claim('task-1');
    expect(w).toMatchObject({ role: 'writer', stage: { position: 1, role: 'writer' } });
  });

  it('--role is still accepted when it is the stage role and refused with the current stage named otherwise', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    await stageIn(e, 'task-1', 'researcher', ['docs/research/a.md']);
    const x = await err(e.sched.claim('task-1', 'engineer'));
    expect(x.code).toBe('PRECONDITION');
    expect(x.message).toMatch(/The current stage is writer \(workflow research, stage 2\/3\)/);
    expect((await e.sched.claim('task-1', 'writer')).role).toBe('writer');
  });

  it('a task in a status no stage runs from is refused with a pointer to work next', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', status: 'blocked' });
    const x = await err(e.sched.claim('task-1'));
    expect(x.code).toBe('PRECONDITION');
    expect(x.message).toMatch(/no stage of its workflow can be claimed/);
    expect(x.hint).toMatch(/minions work next/);
  });

  it('paused starts are refused before the role is inferred', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', status: 'blocked' });
    e.db.setPaused({ starts: true });
    expect((await err(e.sched.claim('task-1'))).message).toBe('Starts are paused (paused_starts).');
  });

  it('a workflow changed between stages: next previews the reset and claim infers the reset stage', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    await stageIn(e, 'task-1', 'researcher', ['docs/research/a.md']);
    await e.backlog.updateTask('task-1', (await e.backlog.getTask('task-1')).version, { workflow: 'default' });
    const r = (await e.sched.next()).runnable[0]!;
    expect(r).toMatchObject({ taskId: 'task-1', role: 'engineer', position: 0, workflow: 'default' });
    expect(r.reason).toMatch(/workflow changed: the claim resets the position by evidence at the head and moves the task to changes-requested/);
    expect(e.backlog.status('task-1')).toBe('implementing'); // next is read-only
    const b = await e.sched.claim('task-1');
    expect(b).toMatchObject({ role: 'engineer', stage: { workflow: 'default', position: 0 } });
  });
});

describe('humanNext', () => {
  it('prints the message, runnable stages, waiting and stuck tasks', async () => {
    const e = env();
    for (const id of ['task-1', 'task-2', 'task-3']) e.backlog.add({ id });
    // an implementing task without a lease is stuck and still occupies an active-task slot
    e.backlog.add({ id: 'task-4', status: 'implementing' });
    const out = humanNext(await e.sched.next());
    expect(out.split('\n')[0]).toBe('1 runnable stage(s): task-1 engineer');
    expect(out).toMatch(/ {2}task-1 engineer -> minions:engineer: ready: stage 1\/3/);
    expect(out).toMatch(/waiting:\n {2}task-2 engineer: active task limit \(2\/2\)\n {2}task-3 engineer: active task limit/);
    expect(out).toMatch(/stuck:\n {2}task-4 \(implementing\):/);
  });
});

describe('status: per-role capacity', () => {
  it('collectStatus carries capacity.byRole; humanStatus prints limited roles as active/max and the others as counts', async () => {
    const e = env((c) => { delete (c.execution as { maxEngineers?: number }).maxEngineers; c.execution.maxByRole = { engineer: 2, writer: 1 }; });
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    await e.sched.claim('task-1');
    const s = await collectStatus({ db: e.db, config: e.config, backlog: async () => e.backlog });
    expect(s.capacity!.byRole).toMatchObject({ engineer: { active: 0, max: 2, limited: true }, writer: { active: 0, max: 1, limited: true }, researcher: { active: 1, limited: false } });
    expect(humanStatus(s)).toMatch(/capacity: 1\/2 tasks, 0\/2 engineer, 0 tester, 0 reviewer, 1 researcher, 0\/1 writer, 0 fetcher/);
  });
});
