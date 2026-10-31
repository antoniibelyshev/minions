import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BacklogAdapter } from '../../src/backlog/types.js';
import { MinionsError } from '../../src/core/errors.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { makeEnv, tmp, type Env } from './fixtures.js';

// task-24.2: one backlog listing per work claim, none per Stop hook run.
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
  it('never reads the backlog: only the holds of the dispatcher decide (autonomy Decision 10)', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const s = spyReads(env.backlog);
    expect((await stopHook({}, loader(env))).stdout).toBeUndefined();
    expect(s.listTasks).not.toHaveBeenCalled();
    expect(s.listReady).not.toHaveBeenCalled();
    expect(s.getTask).not.toHaveBeenCalled();
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

  it('puts the task notes into the brief (task-98), and leaves the field out without notes', async () => {
    const env = makeEnv((c) => { c.execution.maxActiveTasks = 5; });
    env.backlog.add({ id: 'task-1', notes: 'spike: use the fast path' });
    env.backlog.add({ id: 'task-2', notes: null });
    expect((await env.sched.claim('task-1', 'engineer')).task.notes).toBe('spike: use the fast path');
    expect('notes' in (await env.sched.claim('task-2', 'engineer')).task).toBe(false);
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
