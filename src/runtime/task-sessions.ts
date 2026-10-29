// Task sessions (docs/design/coordinator-sessions.md decision 4, task-57 phase 7): when a `task:<id>` session is
// opened, closed and reopened. One deterministic pass (taskSessionPass), no model call: the supervisor runs it on its
// own cadence and the routine pass runs it instead of waking the coordinator for runnable stages. Opening a session
// is a row plus a kickoff inbox message (`/minions:task <id>`); the supervisor then starts its process.
//
// Architecture decisions (task-57.11):
// - Open: a runnable stage (`work next`, so capacity, pauses, drain and the budget are already applied) of a task
//   without an open session opens `task:<id>` (a closed one is reopened, keeping its claude session id so the
//   transcript continues). Refused while draining or an upgrade runs, while starts are paused, at the budget, when
//   coordinator.sessions.max sessions are open, and, with routine.enabled, by the routine's caps: every open is a
//   `routine-wake` event (data.session = key), so routine.minWakeGapMinutes and routine.maxWakesPerDay count task
//   session opens and coordinator wakes together. With the routine off there is no gap or daily cap (an attended
//   project dispatches continuously, as the single coordinator does). A `failed` session is never reopened by the
//   pass (its owner blocker says so); the owner reopens it.
// - Close (decision 4): at `delivered`, `done`, `cancelled` or `blocked`, when the task left the backlog, and at
//   `awaiting-human` once the session wrote its handoff (a `session-handoff` event of the key after the task's last
//   `record`). Closing sets the row `closed`; the supervisor sees it and closes the process's stdin, so the last turn
//   (the summary to the outbox) still finishes.
// - Nudge: a task that is runnable while its session is open gets a short supervisor message when its process is
//   idle (the supervisor decides; at most once per nudge gap), e.g. after its claim waited for capacity.
// - Recover (one task after its session process ended without a clean close): before the session is resumed, the
//   leases it held are reconciled: a lease whose worker already submitted is left for the session to record
//   (`work advance`); the others are released (their workers died with the process), so the stage is runnable again.
import type { Task, TaskStatus } from '../backlog/types.js';
import type { MinionsConfig } from '../config/schema.js';
import { SESSION_HANDOFF_EVENT } from './context-reset.js';
import type { Lease, RuntimeDb } from './db.js';
import { routineSettings, WAKE_EVENT } from './routine.js';
import { enqueueInbox, getSession, openSession, OWNER_INBOX_SOURCE, pendingInbox, sessionsByStatus, updateSession } from './session-store.js';
import { parseSessionKey, sessionConfigDir, sessionsSettings } from './sessions.js';
import { localDayStart } from './zoned-time.js';

/** Statuses that close a task session (decision 4); `awaiting-human` closes after the session's handoff. */
export const CLOSING_STATUSES: readonly TaskStatus[] = ['delivered', 'done', 'cancelled', 'blocked'];
/** Inbox source of the opener's messages (kickoff, reopen, nudge): the supervisor's. */
export const TASK_SESSION_SOURCE = 'supervisor';
export const SESSION_CLOSE_EVENT = 'session-close';
export const SESSION_RECOVER_EVENT = 'session-recover';

export const taskSessionKey = (taskId: string): string => parseSessionKey(`task:${taskId}`).key;
/** The kickoff message of a task session: the task skill. */
export const taskKickoff = (taskId: string, why: string): string => `/minions:task ${taskId}\n\nminions supervisor: ${why}`;

export interface RunnableStage { taskId: string; role: string }

export interface TaskSessionDeps {
  db: RuntimeDb;
  config: MinionsConfig;
  state: string;
  now?: () => Date;
  /** `work next` runnable stages; null when it could not be read (nothing is opened then). */
  runnable: () => Promise<RunnableStage[] | null>;
  /** The backlog tasks (close rules); null when unreadable (nothing is closed then). */
  tasks: () => Promise<Pick<Task, 'id' | 'status'>[] | null>;
  budgetExhausted: () => boolean;
  /** An upgrade the host applies right now (treated like a drain). */
  upgradeInProgress?: () => string | null;
}

export interface TaskSessionPass {
  opened: { key: string; taskId: string; role: string; reopened: boolean }[];
  closed: { key: string; taskId: string; reason: string }[];
  /** Runnable tasks that got no session, with why (the first refusal ends the opens of this pass). */
  refused: { taskId: string; why: string }[];
  /** Runnable tasks whose session is already open (the supervisor may nudge an idle one). */
  runnableOpen: string[];
}

const minutesSince = (now: Date, at: string | null | undefined) => (at ? (now.getTime() - Date.parse(at)) / 60_000 : Infinity);

/** Why no task session may be opened now, or null. `open` is the number of open sessions. */
export function openRefusal(d: Pick<TaskSessionDeps, 'db' | 'config' | 'budgetExhausted' | 'upgradeInProgress'>, now: Date, open: number): string | null {
  const drain = d.db.drain();
  if (drain) return `a drain is in progress (${drain.reason})`;
  const up = d.upgradeInProgress?.() ?? null;
  if (up) return `an upgrade is in progress (${up})`;
  if (d.db.paused().starts) return 'starts are paused';
  if (d.budgetExhausted()) return 'the owner budget is used up';
  const { max } = sessionsSettings(d.config);
  if (open >= max) return `${open} session(s) open (coordinator.sessions.max ${max})`;
  const r = routineSettings(d.config);
  if (r.enabled) {
    const last = d.db.lastEventOfKind(WAKE_EVENT);
    const gap = minutesSince(now, last?.at);
    if (gap < r.minWakeGapMinutes) return `last wake or session open ${Math.floor(gap)} min ago (routine.minWakeGapMinutes ${r.minWakeGapMinutes})`;
    const today = d.db.eventsOfKindSince(WAKE_EVENT, localDayStart(now, r.timezone)).length;
    if (today >= r.maxWakesPerDay) return `wake limit reached (${today}/${r.maxWakesPerDay} today, routine.maxWakesPerDay)`;
  }
  return null;
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

/** One pass: close what decision 4 closes, then open (or reopen) sessions for runnable stages within the limits. */
export async function taskSessionPass(d: TaskSessionDeps): Promise<TaskSessionPass> {
  const now = (d.now ?? (() => new Date()))();
  const db = d.db;
  const out: TaskSessionPass = { opened: [], closed: [], refused: [], runnableOpen: [] };
  if (!sessionsSettings(d.config).enabled) return out;

  const open = sessionsByStatus(db, 'open');
  const openTasks = open.filter((s) => s.kind === 'task');
  if (openTasks.length) {
    const tasks = await d.tasks();
    if (tasks) {
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const s of openTasks) {
        const taskId = parseSessionKey(s.key).taskId!;
        // A worker of the task still runs: the session records it first.
        if (db.activeLeases().some((l) => l.task_id === taskId)) continue;
        // An owner message waits for this session (send reopened it): it closes on a later pass, after that turn.
        if (pendingInbox(db, s.key, { sources: [OWNER_INBOX_SOURCE] }).length) continue;
        const why = closeReason(db, s.key, byId.get(taskId));
        if (why && closeSession(db, s.key, why, now)) out.closed.push({ key: s.key, taskId, reason: why });
      }
    }
  }

  const stages = await d.runnable();
  if (!stages) return out;
  const seen = new Set<string>();
  let openCount = sessionsByStatus(db, 'open').length;
  let limit: string | null = null;
  for (const st of stages) {
    if (seen.has(st.taskId)) continue;
    seen.add(st.taskId);
    let key: string;
    try { key = taskSessionKey(st.taskId); } catch { out.refused.push({ taskId: st.taskId, why: 'the task id cannot be a session key' }); continue; }
    const row = getSession(db, key);
    if (row?.status === 'open') { out.runnableOpen.push(st.taskId); continue; }
    if (row?.status === 'failed') { out.refused.push({ taskId: st.taskId, why: `its session failed (${row.failure ?? 'unknown'}); the owner reopens it` }); continue; }
    // The limits are global: once one refuses, it refuses the rest of this pass too.
    limit ??= openRefusal(d, now, openCount);
    if (limit) { out.refused.push({ taskId: st.taskId, why: limit }); continue; }
    const reopened = !!row;
    openSession(db, key, { configDir: sessionConfigDir({ state: d.state }, key), model: d.config.models.coordinator ?? null, now });
    enqueueInbox(db, key, TASK_SESSION_SOURCE, taskKickoff(st.taskId, reopened
      ? `this session was reopened: ${st.taskId} has a runnable ${st.role} stage again. Read your handoff first.`
      : `${st.taskId} has a runnable ${st.role} stage.`), { now });
    db.addEvent(WAKE_EVENT, st.taskId, { session: key, role: st.role, reopened }, now.toISOString());
    openCount++;
    out.opened.push({ key, taskId: st.taskId, role: st.role, reopened });
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
    ...(r.submitted.length ? [`Submitted but not recorded: ${r.submitted.join(', ')}: record each with \`minions work advance <leaseId> --task ${taskId} --json\` (no --usage: the worker's notification was lost).`] : []),
    ...(r.released.length ? [`Released (their workers died with the process; worktrees and commits are kept): ${r.released.join(', ')}. Check the worktree for uncommitted changes and mention them in the next brief, then claim the stage again.`] : []),
    ...(r.errors.length ? [`Could not reconcile: ${r.errors.join('; ')}. Check \`minions work list --json\`.`] : []),
  ].join('\n');
}
