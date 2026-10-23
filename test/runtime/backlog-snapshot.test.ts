import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BacklogAdapter } from '../../src/backlog/types.js';
import { MinionsError } from '../../src/core/errors.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { makeEnv, tmp, type Env } from './fixtures.js';

// task-24.2: one backlog listing per Stop hook run and per work claim.
let stateDir: string;
beforeAll(() => { stateDir = tmp('minions-snapshot-'); process.env.MINIONS_STATE_DIR = stateDir; });
afterEach(() => vi.restoreAllMocks());

const loader = (env: Env) => () => ({ db: env.db, backlog: env.backlog, config: env.config });

/** Spies on the backlog reads; counts are per method. */
function spyReads(b: BacklogAdapter) {
  return {
    listTasks: vi.spyOn(b, 'listTasks'),
    listReady: vi.spyOn(b, 'listReady'),
    getTask: vi.spyOn(b, 'getTask'),
  };
}

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};

describe('stop hook backlog reads', () => {
  it('lists the backlog once and derives ready, capacity and continuing stages from it', async () => {
    const env = makeEnv((c) => { c.execution.maxActiveTasks = 5; });
    env.backlog.add({ id: 'task-1', status: 'done' });
    env.backlog.add({ id: 'task-2', dependencies: ['task-1'], priority: 'low' });
    env.backlog.add({ id: 'task-3', dependencies: ['task-4'] });
    env.backlog.add({ id: 'task-4', status: 'implementing' });
    env.backlog.add({ id: 'task-5', status: 'reviewing' });
    env.backlog.add({ id: 'task-6', authorized: false });
    env.backlog.add({ id: 'task-7', priority: 'high' });
    const s = spyReads(env.backlog);
    const out = await stopHook({}, loader(env));
    expect(s.listTasks).toHaveBeenCalledTimes(1);
    expect(s.listReady).not.toHaveBeenCalled();
    expect(s.getTask).not.toHaveBeenCalled();
    const reason = JSON.parse(out.stdout!).reason as string;
    // Ready by priority: task-7 (high) before task-2 (low); task-3 waits on task-4, task-6 is unauthorized.
    expect(reason).toMatch(/2 ready task\(s\) \(task-7, task-2\), capacity \d+/);
    expect(reason).toMatch(/1 task\(s\) awaiting the next stage \(task-5:reviewing\)/);
  });

  it('counts ready tasks from the snapshot when there is no capacity', async () => {
    const env = makeEnv();
    for (const id of ['task-1', 'task-2', 'task-3']) env.backlog.add({ id });
    await env.sched.claim('task-1', 'engineer');
    await env.sched.claim('task-2', 'engineer');
    const s = spyReads(env.backlog);
    const out = await stopHook({}, loader(env));
    expect(out.reason).toBe('allow: 1 ready but no capacity');
    expect(s.listTasks).toHaveBeenCalledTimes(1);
    expect(s.listReady).not.toHaveBeenCalled();
  });

  it('respects the intake scope like listReady did', async () => {
    const env = makeEnv((c) => { c.intake.scope.requiredLabels = ['qa']; });
    env.backlog.add({ id: 'task-1' });
    expect((await stopHook({}, loader(env))).reason).toBe('allow: no runnable tasks');
    env.backlog.add({ id: 'task-2', labels: ['qa'] });
    expect(JSON.parse((await stopHook({}, loader(env))).stdout!).reason).toMatch(/1 ready task\(s\) \(task-2\)/);
  });
});

describe('work claim backlog reads', () => {
  it('lists the backlog once, with dependency status from the listing', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'done' });
    env.backlog.add({ id: 'task-2', status: 'delivered' });
    env.backlog.add({ id: 'task-3', dependencies: ['task-1', 'task-2'] });
    const s = spyReads(env.backlog);
    const brief = await env.sched.claim('task-3', 'engineer');
    expect(brief.task.id).toBe('task-3');
    expect(s.listTasks).toHaveBeenCalledTimes(1);
    expect(s.listReady).not.toHaveBeenCalled();
    // Only the claimed task itself is viewed (stage pick and fresh details), never a dependency.
    expect(s.getTask.mock.calls.map((c) => c[0])).not.toContain('task-1');
    expect(s.getTask.mock.calls.map((c) => c[0])).not.toContain('task-2');
  });

  it('lists once for a task without dependencies', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const s = spyReads(env.backlog);
    await env.sched.claim('task-1', 'engineer');
    expect(s.listTasks).toHaveBeenCalledTimes(1);
  });

  it('keeps the PRECONDITION messages for a dependency that is not done or cannot be read', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'implementing' });
    env.backlog.add({ id: 'task-2', dependencies: ['task-1'] });
    env.backlog.add({ id: 'task-3', dependencies: ['task-99'] });
    const s = spyReads(env.backlog);
    const notDone = await err(env.sched.claim('task-2', 'engineer'));
    expect(notDone.code).toBe('PRECONDITION');
    expect(notDone.message).toBe('Task task-2 depends on task-1, which is "implementing".');
    const unreadable = await err(env.sched.claim('task-3', 'engineer'));
    expect(unreadable.code).toBe('PRECONDITION');
    expect(unreadable.message).toBe('Task task-3: dependency task-99 cannot be read (task task-99 not found).');
    expect(s.listTasks).toHaveBeenCalledTimes(2); // one per claim
  });

  it('views a dependency the listing lacks (e.g. archived) instead of refusing it', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'done' });
    env.backlog.add({ id: 'task-2', dependencies: ['task-1'] });
    const full = env.backlog.listTasks.bind(env.backlog);
    vi.spyOn(env.backlog, 'listTasks').mockImplementation(async () => (await full()).filter((t) => t.id !== 'task-1'));
    const get = vi.spyOn(env.backlog, 'getTask');
    await env.sched.claim('task-2', 'engineer');
    expect(get.mock.calls.map((c) => c[0])).toContain('task-1');
    expect(env.backlog.listTasks).toHaveBeenCalledTimes(1);
  });
});
