import type { ScopeFilter, Task } from './types.js';

/** Statuses that satisfy a dependency. */
export const COMPLETED_STATUSES: ReadonlySet<Task['status']> = new Set(['done', 'delivered']);

export const AUTHORIZED_LABEL = 'minions:authorized';

export interface ReadyContext {
  /** Task ids holding an active lease. */
  leased: Set<string>;
  /** Scope from config `intake.scope`. */
  scope: ScopeFilter;
  /** When true (paused_starts), nothing is ready. */
  paused?: boolean;
  /**
   * Dependency lookup. Return undefined when the dependency is unknown or its lookup failed;
   * such a dependency excludes the task.
   */
  lookup: (id: string) => Task | undefined;
}

export type ExclusionReason = 'paused' | 'status' | 'unauthorized' | 'scope' | 'leased' | 'dependency';

/** Why a task is not ready, or null when it is ready. */
export function notReadyReason(task: Task, ctx: ReadyContext): ExclusionReason | null {
  if (ctx.paused) return 'paused';
  if (task.status !== 'ready') return 'status';
  if (!task.authorized) return 'unauthorized';
  if (!inScope(task, ctx.scope)) return 'scope';
  if (ctx.leased.has(task.id)) return 'leased';
  for (const dep of task.dependencies) {
    const d = ctx.lookup(dep);
    if (!d || !COMPLETED_STATUSES.has(d.status)) return 'dependency';
  }
  return null;
}

/**
 * Scope check. Tasks carry no path list in v0.1, so `allowedPaths` is not evaluated here;
 * path policy is enforced by the capability rules at edit time.
 */
export function inScope(task: Task, scope: ScopeFilter): boolean {
  if (scope.milestone !== null && (task.milestone ?? null) !== scope.milestone) return false;
  return scope.requiredLabels.every((l) => task.labels.includes(l));
}

/** Ready tasks, ordered by priority then id, at most `limit` (limit <= 0 means none). */
export function filterReady(tasks: Task[], ctx: ReadyContext, limit = Infinity): Task[] {
  if (ctx.paused || limit <= 0) return [];
  return sortByPriority(tasks.filter((t) => notReadyReason(t, ctx) === null)).slice(0, limit);
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
export const priorityRank = (p: Task['priority']) => (p === null ? 3 : PRIORITY_RANK[p] ?? 3);

/** Compares ids like "task-2" < "task-10" < "task-10.1" by numeric segments. */
export function compareIds(a: string, b: string): number {
  const segs = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const x = segs(a), y = segs(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const xi = x[i], yi = y[i];
    if (xi === undefined) return -1;
    if (yi === undefined) return 1;
    if (xi !== yi) return xi - yi;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** high > medium > low > null, then id numerically. Returns a new array. */
export function sortByPriority<T extends Pick<Task, 'priority' | 'id'>>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || compareIds(a.id, b.id));
}

/**
 * Finds a dependency cycle in `graph` (id -> dependency ids). Returns the cycle path with the
 * start repeated at the end (e.g. ["task-1","task-2","task-1"]), or null.
 */
export function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = finished
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of graph.get(n) ?? []) {
      const s = state.get(m);
      if (s === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (s === undefined) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of [...graph.keys()].sort(compareIds)) {
    if (state.get(n) === undefined) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Cycle that adding the edge `from -> to` would create, or null. The path starts at `from`
 * and ends at `from` (e.g. ["task-1","task-2","task-1"]).
 */
export function cycleIfAdded(graph: ReadonlyMap<string, readonly string[]>, from: string, to: string): string[] | null {
  if (from === to) return [from, from];
  // BFS from `to` looking for `from`.
  const prev = new Map<string, string>();
  const seen = new Set<string>([to]);
  const queue = [to];
  while (queue.length) {
    const n = queue.shift()!;
    if (n === from) {
      const path = [from];
      let cur = from;
      while (cur !== to) { cur = prev.get(cur)!; path.unshift(cur); }
      return [from, ...path];
    }
    for (const m of graph.get(n) ?? []) {
      if (!seen.has(m)) { seen.add(m); prev.set(m, n); queue.push(m); }
    }
  }
  return null;
}
