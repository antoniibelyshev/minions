// `minions pull` (docs/design/autonomy.md Decision 13): delivered/landed tasks as minions/task-<id>, and the base
// fast-forward decision (clean checkout on the base, strict fast-forward only).
import { describe, expect, it } from 'vitest';
import { ffDecision, type FfFacts } from '../../src/host/pull.js';
import { taskRefs } from '../../src/host/transfer.js';
import { deliveredTaskBranches } from '../../src/runtime/workspace.js';

describe('pull: task refs', () => {
  const fetched = new Set(['refs/remotes/minions/main', 'refs/remotes/minions/agent/task-7-add-docs', 'refs/remotes/minions/agent/task-53-8-split']);

  it('names each delivered task\'s fetched agent branch minions/task-<id>', () => {
    expect(taskRefs([
      { taskId: 'task-7', branch: 'agent/task-7-add-docs', status: 'delivered' },
      { taskId: 'TASK-53.8', branch: 'agent/task-53-8-split', status: 'done' },
    ], fetched)).toEqual([
      { taskId: 'task-7', ref: 'refs/remotes/minions/task-7', source: 'refs/remotes/minions/agent/task-7-add-docs' },
      { taskId: 'task-53.8', ref: 'refs/remotes/minions/task-53.8', source: 'refs/remotes/minions/agent/task-53-8-split' },
    ]);
  });

  it('drops anything the runtime should not have sent: odd ids, non-agent or unfetched branches, duplicates', () => {
    expect(taskRefs(null, fetched)).toEqual([]);
    expect(taskRefs([
      { taskId: 'main', branch: 'agent/task-7-add-docs' },
      { taskId: 'task-7/../x', branch: 'agent/task-7-add-docs' },
      { taskId: 'task-8', branch: 'main' },
      { taskId: 'task-9', branch: 'agent/task-9-not-fetched' },
      { taskId: 'task-7', branch: 'agent/../main' },
      { taskId: 'task-7', branch: 'agent/task-7-add-docs' },
      { taskId: 'task-7', branch: 'agent/task-53-8-split' },
      'garbage',
    ], fetched).map((t) => [t.taskId, t.source])).toEqual([['task-7', 'refs/remotes/minions/agent/task-7-add-docs']]);
  });
});

describe('pull: base fast-forward decision', () => {
  const facts = (o: Partial<FfFacts> = {}): FfFacts => ({ base: 'main', current: 'main', dirty: 0, from: 'a'.repeat(40), to: 'b'.repeat(40), canFastForward: true, contains: false, ...o });

  it('fast-forwards a clean checkout on the base', () => {
    expect(ffDecision(facts())).toEqual({ action: 'fast-forward', reason: `main ${'a'.repeat(12)} -> ${'b'.repeat(12)}` });
  });

  it('is up to date when equal or when the base already contains the agents\' base', () => {
    expect(ffDecision(facts({ to: 'a'.repeat(40) })).action).toBe('up-to-date');
    expect(ffDecision(facts({ canFastForward: false, contains: true })).action).toBe('up-to-date');
  });

  it('never moves a dirty tree, another checked-out branch, a detached HEAD or a diverged base', () => {
    expect(ffDecision(facts({ dirty: 3 }))).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/3 uncommitted change\(s\) to tracked files/) });
    expect(ffDecision(facts({ inTheWay: ['.minions/goals.md'] }))).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/adds \.minions\/goals\.md, which an untracked file/) });
    expect(ffDecision(facts({ current: 'feature' }))).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/on feature, not main/) });
    expect(ffDecision(facts({ current: null }))).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/detached HEAD/) });
    expect(ffDecision(facts({ canFastForward: false }))).toMatchObject({ action: 'skipped', reason: expect.stringMatching(/diverged/) });
    expect(ffDecision(facts({ to: null })).action).toBe('skipped');
    expect(ffDecision(facts({ from: null })).action).toBe('skipped');
  });
});

describe('pull: the runtime\'s delivered task branches', () => {
  it('takes each task\'s latest lease branch, only when exported and the task is delivered or done', async () => {
    const leases = [
      { task_id: 'task-7', branch: 'agent/task-7-old', started_at: '2026-10-01T00:00:00Z' },
      { task_id: 'task-7', branch: 'agent/task-7-add-docs', started_at: '2026-10-02T00:00:00Z' },
      { task_id: 'task-10', branch: 'agent/task-10-x', started_at: '2026-10-01T00:00:00Z' },
      { task_id: 'task-8', branch: 'agent/task-8-wip', started_at: '2026-10-01T00:00:00Z' },
      { task_id: 'task-9', branch: 'agent/task-9-gone', started_at: '2026-10-01T00:00:00Z' },
      { task_id: 'task-11', branch: null, started_at: '2026-10-01T00:00:00Z' },
    ];
    const exported = ['refs/heads/main', 'refs/heads/agent/task-7-add-docs', 'refs/heads/agent/task-10-x', 'refs/heads/agent/task-8-wip'];
    const status: Record<string, string> = { 'task-7': 'delivered', 'task-10': 'done', 'task-8': 'implementing', 'task-9': 'done' };
    expect(await deliveredTaskBranches(leases, exported, async (id) => status[id] ?? null)).toEqual([
      { taskId: 'task-7', branch: 'agent/task-7-add-docs', status: 'delivered' },
      { taskId: 'task-10', branch: 'agent/task-10-x', status: 'done' },
    ]);
  });
});
