// Task sessions (docs/design/coordinator-sessions.md decision 4, task-57 phase 7): when a `task:<id>` session is
// closed. One deterministic pass (taskSessionPass), no model call, that the supervisor runs on its own cadence. Since
// docs/design/autonomy.md Decision 10 a task session never dispatches: it is opened (or reopened) for a held
// decision of the autopilot dispatcher (notifyHold) or an owner message about the task (the gateway).
//
// Architecture decisions (task-57.11):
// - Close (decision 4): at `delivered`, `done`, `cancelled` or `blocked`, when the task left the backlog, and at
//   `awaiting-human` once the session wrote its handoff (a `session-handoff` event of the key after the task's last
//   `record`). Closing sets the row `closed`; the supervisor sees it and closes the process's stdin, so the last turn
//   (the summary to the outbox) still finishes. Thread sessions close after a quiet period.
// - Recover (one task after its session process ended without a clean close): before the session is resumed, the
//   leases it held (from before Decision 10) are reconciled: a lease whose
//   worker already submitted is left for the session to record; the others are released, so the stage is runnable again.
import type { Task, TaskStatus } from '../backlog/types.js';
import type { MinionsConfig } from '../config/schema.js';
import { SESSION_HANDOFF_EVENT } from './context-reset.js';
import type { Lease, RuntimeDb } from './db.js';
import { getSession, OWNER_INBOX_SOURCE, pendingInbox, sessionsByStatus, updateSession } from './session-store.js';
import { parseSessionKey, sessionsSettings, threadSettings } from './sessions.js';

/** Statuses that close a task session (decision 4); `awaiting-human` closes after the session's handoff. */
export const CLOSING_STATUSES: readonly TaskStatus[] = ['delivered', 'done', 'cancelled', 'blocked'];
/** Inbox source of the supervisor's messages (kickoff, recovery). */
export const TASK_SESSION_SOURCE = 'supervisor';
export const SESSION_CLOSE_EVENT = 'session-close';
export const SESSION_RECOVER_EVENT = 'session-recover';

export const taskSessionKey = (taskId: string): string => parseSessionKey(`task:${taskId}`).key;
/** The kickoff message of a task session: the task skill. */
export const taskKickoff = (taskId: string, why: string): string => `/minions:task ${taskId}\n\nminions supervisor: ${why}`;

export interface TaskSessionDeps {
  db: RuntimeDb;
  config: MinionsConfig;
  now?: () => Date;
  /** The backlog tasks (close rules); null when unreadable (nothing is closed then). */
  tasks: () => Promise<Pick<Task, 'id' | 'status'>[] | null>;
}

export interface TaskSessionPass {
  closed: { key: string; taskId: string | null; reason: string }[];
}

/** Why an open task session should close now (decision 4), or null. */
export function closeReason(db: RuntimeDb, key: string, task: Pick<Task, 'id' | 'status'> | undefined): string | null {
  if (!task) return 'the task is no longer in the backlog';
  if (CLOSING_STATUSES.includes(task.status)) return `the task is ${task.status}`;
  if (task.status !== 'awaiting-human') return null;
  const lastRecord = db.get<{ id: number | null }>("SELECT MAX(id) AS id FROM events WHERE task_id = ? AND kind = 'record'", task.id)?.id ?? 0;
  const handoffs = db.all<{ id: number; data_json: string | null }>('SELECT id, data_json FROM events WHERE kind = ? AND id > ? ORDER BY id', SESSION_HANDOFF_EVENT, lastRecord);
  const written = handoffs.some((h) => { try { return (JSON.parse(h.data_json ?? 'null') as { session?: unknown } | null)?.session === key; } catch { return false; } });
  return written ? 'the task awaits the owner and the session wrote its handoff' : null;
}

/** Closes a session row (the supervisor ends its process); false when it was not open. */
export function closeSession(db: RuntimeDb, key: string, reason: string, now: Date = new Date()): boolean {
  const row = getSession(db, key);
  if (!row || row.status !== 'open') return false;
  updateSession(db, key, { status: 'closed', closed_at: now.toISOString() });
  db.addEvent(SESSION_CLOSE_EVENT, parseSessionKey(key).taskId, { key, reason });
  return true;
}

/** One pass: close the task and thread sessions decision 4 and the thread idle limit close. */
export async function taskSessionPass(d: TaskSessionDeps): Promise<TaskSessionPass> {
  const now = (d.now ?? (() => new Date()))();
  const db = d.db;
  const out: TaskSessionPass = { closed: [] };
  if (!sessionsSettings(d.config).enabled) return out;

  const open = sessionsByStatus(db, 'open');
  const openTasks = open.filter((s) => s.kind === 'task');
  if (openTasks.length) {
    const tasks = await d.tasks();
    if (tasks) {
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const s of openTasks) {
        const taskId = parseSessionKey(s.key).taskId!;
        // A worker of the task still runs: the session may still be needed for its result.
        if (db.activeLeases().some((l) => l.task_id === taskId)) continue;
        // An owner message waits for this session (send reopened it): it closes on a later pass, after that turn.
        if (pendingInbox(db, s.key, { sources: [OWNER_INBOX_SOURCE] }).length) continue;
        const why = closeReason(db, s.key, byId.get(taskId));
        if (why && closeSession(db, s.key, why, now)) out.closed.push({ key: s.key, taskId, reason: why });
      }
    }
  }

  // Thread sessions (docs/design/autonomy.md Decision 6) close after a quiet period; a later reply reopens them.
  const { idleMinutes } = threadSettings(d.config);
  for (const s of open.filter((x) => x.kind === 'thread')) {
    if (db.activeLeases().some((l) => l.holder === s.key) || pendingInbox(db, s.key).length) continue;
    const last = db.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM session_inbox WHERE session_key = ?', s.key)?.at;
    const since = [s.opened_at, s.last_wake_at, last].filter((x): x is string => !!x).sort().at(-1)!;
    if (now.getTime() - Date.parse(since) < idleMinutes * 60_000) continue;
    const why = `quiet for ${idleMinutes} min (coordinator.sessions.threadIdleMinutes)`;
    if (closeSession(db, s.key, why, now)) out.closed.push({ key: s.key, taskId: null, reason: why });
  }
  return out;
}

export interface RecoverOutcome { released: string[]; submitted: string[]; errors: string[] }

/**
 * Per-task recovery after a session process ended without a clean close (decision 4, "a session process dies
 * mid-turn"): the leases the session held. A submitted result is left for the session to record; the others are
 * released (their workers died with the process). `release` is Scheduler.release in the CLI.
 */
export async function recoverTaskSession(db: RuntimeDb, key: string, o: { hasSubmission: (leaseId: string) => Promise<boolean>; release: (leaseId: string, reason: string) => Promise<unknown> }): Promise<RecoverOutcome> {
  const k = parseSessionKey(key);
  const out: RecoverOutcome = { released: [], submitted: [], errors: [] };
  if (k.kind !== 'task') return out;
  const held = db.activeLeases().filter((l: Lease) => l.holder === k.key && l.task_id === k.taskId);
  for (const l of held) {
    try {
      if (await o.hasSubmission(l.id)) { out.submitted.push(l.id); continue; }
      await o.release(l.id, `recovered: the ${k.key} session process ended, its worker is not running`);
      out.released.push(l.id);
    } catch (e) { out.errors.push(`${l.id}: ${(e as Error).message.slice(0, 200)}`); }
  }
  if (held.length) db.addEvent(SESSION_RECOVER_EVENT, k.taskId, { key: k.key, ...out });
  return out;
}

/** The message a resumed task session gets about its recovered leases (null when there were none). */
export function recoverNotice(taskId: string, r: RecoverOutcome): string | null {
  if (!r.released.length && !r.submitted.length && !r.errors.length) return null;
  return [
    `minions supervisor: per-task recovery for ${taskId} (/minions:task ${taskId}, Recover).`,
    ...(r.submitted.length ? [`Submitted but not recorded: ${r.submitted.join(', ')}: record each with \`minions work record <leaseId> --submitted --json\`.`] : []),
    ...(r.released.length ? [`Released (their workers died with the process; worktrees and commits are kept): ${r.released.join(', ')}. The autopilot dispatcher runs the stage again; note uncommitted changes in the worktree on the task (\`minions backlog note\`).`] : []),
    ...(r.errors.length ? [`Could not reconcile: ${r.errors.join('; ')}. Check \`minions work list --json\`.`] : []),
  ].join('\n');
}
