import { describe, expect, it } from 'vitest';
import { compareIds, cycleIfAdded, filterReady, findCycle, notReadyReason, sortByPriority } from '../../src/backlog/ready.js';
import type { ScopeFilter, Task } from '../../src/backlog/types.js';

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id, locator: `backlogmd:${id.toUpperCase()}`, title: id, description: '', acceptanceCriteria: [],
  status: 'ready', priority: null, dependencies: [], parent: null, externalLinks: [], labels: [],
  authorized: true, branch: null, commits: [], prUrl: null, provenance: 'user-decision', version: 'v', milestone: null, ...over,
});
const scope: ScopeFilter = { milestone: null, requiredLabels: [], allowedPaths: ['**'] };
const ctxFor = (tasks: Task[], over: Partial<Parameters<typeof filterReady>[1]> = {}) => {
  const m = new Map(tasks.map((x) => [x.id, x]));
  return { leased: new Set<string>(), scope, lookup: (id: string) => m.get(id), ...over };
};

describe('readiness', () => {
  it('excludes non-ready, unauthorized, leased and paused', () => {
    const tasks = [t('task-1'), t('task-2', { status: 'idea' }), t('task-3', { authorized: false }), t('task-4')];
    const ctx = ctxFor(tasks, { leased: new Set(['task-4']) });
    expect(filterReady(tasks, ctx).map((x) => x.id)).toEqual(['task-1']);
    expect(notReadyReason(tasks[1]!, ctx)).toBe('status');
    expect(notReadyReason(tasks[2]!, ctx)).toBe('unauthorized');
    expect(notReadyReason(tasks[3]!, ctx)).toBe('leased');
    expect(filterReady(tasks, { ...ctx, paused: true })).toEqual([]);
  });

  it('requires deps done/delivered; unknown or failed dep lookup excludes', () => {
    const tasks = [
      t('task-1', { status: 'done' }), t('task-2', { status: 'delivered' }), t('task-3', { status: 'testing' }),
      t('task-10', { dependencies: ['task-1', 'task-2'] }),
      t('task-11', { dependencies: ['task-3'] }),
      t('task-12', { dependencies: ['task-99'] }),
    ];
    const ctx = ctxFor(tasks);
    expect(filterReady(tasks, ctx).map((x) => x.id)).toEqual(['task-10']);
    const failing = { ...ctx, lookup: (id: string) => (id === 'task-1' ? undefined : ctx.lookup(id)) };
    expect(notReadyReason(tasks[3]!, failing)).toBe('dependency');
  });

  it('applies scope milestone and required labels', () => {
    const tasks = [t('task-1', { labels: ['a'], milestone: 'm1' }), t('task-2', { labels: ['a'] }), t('task-3', { milestone: 'm1' })];
    const ctx = ctxFor(tasks, { scope: { milestone: 'm1', requiredLabels: ['a'], allowedPaths: ['**'] } });
    expect(filterReady(tasks, ctx).map((x) => x.id)).toEqual(['task-1']);
  });

  it('orders by priority then numeric id and honours limit', () => {
    const tasks = [t('task-10', { priority: 'low' }), t('task-2'), t('task-9', { priority: 'high' }), t('task-11', { priority: 'high' }),
      t('task-3', { priority: 'medium' }), t('task-1')];
    expect(sortByPriority(tasks).map((x) => x.id)).toEqual(['task-9', 'task-11', 'task-3', 'task-10', 'task-1', 'task-2']);
    expect(filterReady(tasks, ctxFor(tasks), 2).map((x) => x.id)).toEqual(['task-9', 'task-11']);
    expect(compareIds('task-1.2', 'task-1.10')).toBeLessThan(0);
    expect(compareIds('task-1', 'task-1.1')).toBeLessThan(0);
  });
});

describe('cycles', () => {
  it('finds a cycle path', () => {
    const g = new Map([['task-1', ['task-2']], ['task-2', ['task-3']], ['task-3', ['task-1']], ['task-4', []]]);
    expect(findCycle(g)).toEqual(['task-1', 'task-2', 'task-3', 'task-1']);
    expect(findCycle(new Map([['task-1', ['task-2']], ['task-2', []]]))).toBeNull();
  });

  it('detects the cycle an added edge would create', () => {
    const g = new Map([['task-1', []], ['task-2', ['task-1']], ['task-3', ['task-2']]]);
    expect(cycleIfAdded(g, 'task-1', 'task-3')).toEqual(['task-1', 'task-3', 'task-2', 'task-1']);
    expect(cycleIfAdded(g, 'task-3', 'task-1')).toBeNull();
    expect(cycleIfAdded(g, 'task-2', 'task-2')).toEqual(['task-2', 'task-2']);
  });
});
