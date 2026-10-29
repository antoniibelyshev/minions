// The Stop guard of a coordinator session (docs/design/coordinator-sessions.md decision 9, phase 6). The single
// coordinator's guard (stopHook in ./hooks.ts) looks at the whole backlog; a session's looks only at its own task:
//
// - `router` and `general`: off (they never dispatch, so nothing is left undone when they stop);
// - `task:<id>`: blocks only while that task has a stage to dispatch now (ready with capacity, or awaiting its next
//   stage), no worker of it runs, starts are not held (pause, budget, the session's own reset barrier) and the
//   task's state moved since the last continuation. Its no-progress fingerprint is kept per session (meta
//   `stop_guard:<key>`), never in the single coordinator's guard row.
//
// Any failure allows the stop, like the single coordinator's guard.
import { filterReady } from '../backlog/ready.js';
import type { Task } from '../backlog/types.js';
import { dependencyDoneStatuses } from '../config/delivery.js';
import { sha256 } from '../core/fsutil.js';
import { resetBarrier } from './context-reset.js';
import type { HookDeps, HookOutput } from './hooks.js';
import { capacityOf, scopeOf } from './scheduler.js';
import { scopedMetaKey, type SessionScope } from './session-scope.js';
import { currentBudget } from './spend.js';

export const SESSION_GUARD_META = 'stop_guard';
/** Continuations without progress before the guard lets the session stop (as the single coordinator's NO_PROGRESS_LIMIT). */
const NO_PROGRESS_LIMIT = 2;

interface GuardState { fingerprint: string | null; count: number; lastReason: string | null }

function readGuard(db: HookDeps['db'], scope: SessionScope): GuardState {
  try {
    const v = db.getMeta(scopedMetaKey(SESSION_GUARD_META, scope));
    const g = v ? JSON.parse(v) as Partial<GuardState> : null;
    return { fingerprint: typeof g?.fingerprint === 'string' ? g.fingerprint : null, count: typeof g?.count === 'number' ? g.count : 0, lastReason: typeof g?.lastReason === 'string' ? g.lastReason : null };
  } catch { return { fingerprint: null, count: 0, lastReason: null }; }
}
function writeGuard(db: HookDeps['db'], scope: SessionScope, g: GuardState): void {
  try { db.setMeta(scopedMetaKey(SESSION_GUARD_META, scope), JSON.stringify(g)); } catch { /* best-effort */ }
}

export async function sessionStopGuard(deps: HookDeps, scope: SessionScope, backgroundRunning: boolean): Promise<HookOutput> {
  const { db, backlog, config } = deps;
  if (scope.kind !== 'task' || !scope.taskId) return { reason: `allow: the Stop guard is off for the ${scope.key} session` };
  const taskId = scope.taskId;
  const allow = (reason: string, detail = reason): HookOutput => {
    writeGuard(db, scope, { fingerprint: null, count: 0, lastReason: reason });
    return { reason: `allow: ${detail}` };
  };
  try {
    if (db.paused().starts) return allow('paused');
    if (currentBudget({ db, config })?.exhausted) return allow('budget', 'the owner budget is used up (new claims are refused)');
    const barrier = resetBarrier({ db, config, session: scope });
    if (barrier) return allow('context-reset-pending', barrier.reason);
    if (backgroundRunning) return allow('background-running', 'a background subagent is still running');
    const leases = db.activeLeases();
    if (leases.some((l) => l.task_id === taskId)) return allow('task-leased', `a worker of ${taskId} is running`);
    let tasks: Task[];
    try { tasks = await backlog.listTasks(); } catch (e) { return allow('backlog-error', `backlog query failed (${(e as Error).message})`); }
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return allow('no-task', `${taskId} is not in the backlog`);
    const leased = new Set(leases.map((l) => l.task_id));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const cap = capacityOf(config, leases, tasks);
    const ready = filterReady(tasks, { leased, scope: scopeOf(config), lookup: (id) => byId.get(id), completed: dependencyDoneStatuses(config) }, 50).some((t) => t.id === taskId);
    const startable = ready && cap.freeTaskSlots > 0 && cap.freeEngineerSlots > 0;
    const continuing = task.status === 'testing' || task.status === 'reviewing' || (task.status === 'changes-requested' && cap.freeEngineerSlots > 0);
    if (!startable && !continuing) return ready ? allow('no-capacity', `${taskId} is ready but no capacity`) : allow('no-ready', `${taskId} has no stage to dispatch now (${task.status})`);
    const fingerprint = sha256(JSON.stringify({
      task: `${task.id}:${task.status}`,
      // Only this task's events are progress for its session (usage is recorded on every Stop).
      lastEvent: db.get<{ id: number | null }>("SELECT MAX(id) AS id FROM events WHERE task_id = ? AND kind != 'usage'", taskId)?.id ?? 0,
    }));
    const g = readGuard(db, scope);
    if (g.fingerprint === fingerprint && g.count >= NO_PROGRESS_LIMIT) {
      writeGuard(db, scope, { fingerprint, count: g.count, lastReason: 'no-progress' });
      return { reason: 'allow: no-progress (state unchanged after repeated continuation)' };
    }
    writeGuard(db, scope, { fingerprint, count: g.fingerprint === fingerprint ? g.count + 1 : 1, lastReason: 'continue' });
    const reason = `minions: ${taskId} ${startable ? 'is ready to start' : `awaits its next stage (${task.status})`}; claim and dispatch it (work claim ${taskId}, then work advance --task ${taskId}). If nothing can proceed, report why and stop.`;
    return { stdout: JSON.stringify({ decision: 'block', reason }), reason };
  } catch (e) {
    return { reason: `allow: internal error (${(e as Error).message})` };
  }
}
