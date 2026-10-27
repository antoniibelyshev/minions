// The unattended routine pass (docs/design/unattended-delivery.md, phase 1, task-68.2): `minions sync --routine`.
//
// One deterministic pass, no model call anywhere in it:
//   1. the routine lock (meta `routine_lock`, {pid, start}: a dead or reused pid is taken over) and the interval
//      (at most once per half tick unless --force; the watchdog only when the last pass is older than 2 ticks);
//   2. the full `minions sync` (intake import, PR and CI observations, merged -> done, closed -> blocked, the
//      auto-merge pass), injected as `sync`;
//   3. the wake decision (decideWake, a pure function) and its action: a fresh coordinator session through the
//      detached restart with the constant wake prompt (never with force), or the separate crash start (recover);
//   4. a `routine` event with the counts, the decision and the reasons (`--last` reads it back).
// Every external effect (gh, git, restart, clock, process table, files) is an injected dependency, so tests run it
// with a fake gh, a fake clock and a fake restart.
import { statSync } from 'node:fs';
import type { MinionsConfig } from '../config/schema.js';
import type { RuntimeDb, RoutineLock } from './db.js';
import type { IntakeSyncReport } from './intake-sync.js';
import type { SyncReport } from './ci.js';
import type { NextReport } from './scheduler.js';
import { lastOwnerMessageAt } from './coordinator-usage.js';
import { TRANSCRIPT_META } from './context-reset.js';
import { localDayStart } from './zoned-time.js';

export const ROUTINE_DEFAULTS = { tickMinutes: 15, minWakeGapMinutes: 30, maxWakesPerDay: 8, digestAt: ['08:00'] as readonly string[], timezone: 'Europe/Berlin' } as const;
/** The main transcript must be idle this long before a wake (the prompt cache has expired by then). */
export const IDLE_MINUTES = 10;
/** No wake within this many minutes of an owner message (the task-58 "latest message" window). */
export const OWNER_ACTIVE_MINUTES = 30;
/** Crash starts (coordinator not running after a crash) per local day (routine.timezone); after that the manager bot reports it. */
export const MAX_CRASH_STARTS_PER_DAY = 2;
/** A recorded coordinator restart this recent means one is in progress: the pass starts nothing. */
export const RESTART_SETTLE_MINUTES = 5;
/** The watchdog runs the pass when the last one is older than this many ticks. */
export const WATCHDOG_TICKS = 2;

export const ROUTINE_EVENT = 'routine';
export const WAKE_EVENT = 'routine-wake';
export const CRASH_START_EVENT = 'routine-crash-start';

export interface RoutineSettings {
  enabled: boolean; tickMinutes: number; minWakeGapMinutes: number; maxWakesPerDay: number;
  /** Local digest times "HH:MM" (phase 4), sorted, in `timezone`. */
  digestAt: string[];
  /** IANA zone of the digest times and of the routine's days (wakes and crash starts per day). */
  timezone: string;
}

/** Effective routine settings: unset = off, every unset field its default. */
export function routineSettings(cfg: Pick<MinionsConfig, 'routine'>): RoutineSettings {
  const r = cfg.routine ?? {};
  return {
    enabled: r.enabled === true,
    tickMinutes: r.tickMinutes ?? ROUTINE_DEFAULTS.tickMinutes,
    minWakeGapMinutes: r.minWakeGapMinutes ?? ROUTINE_DEFAULTS.minWakeGapMinutes,
    maxWakesPerDay: r.maxWakesPerDay ?? ROUTINE_DEFAULTS.maxWakesPerDay,
    digestAt: [...new Set(r.digestAt?.length ? r.digestAt : ROUTINE_DEFAULTS.digestAt)].sort(),
    timezone: r.timezone ?? ROUTINE_DEFAULTS.timezone,
  };
}

export type RoutineTrigger = 'clock' | 'watchdog' | 'manual';
export const ROUTINE_TRIGGERS: readonly RoutineTrigger[] = ['clock', 'watchdog', 'manual'];

/** Why the coordinator should be woken: only work that needs a model (decision 3). */
export type WakeReason =
  | { kind: 'runnable'; taskId: string; role: string; detail: string }
  | { kind: 'unvalidated'; taskId: string; leaseId: string; detail: string }
  | { kind: 'needs-split'; taskId: string; leaseId: string; detail: string }
  | { kind: 'awaiting-human'; taskId: string; detail: string }
  /** The digest is due (phase 4 composes it): always allowed, also at 100% budget and past maxWakesPerDay. */
  | { kind: 'digest'; detail: string };

/** How the coordinator stands, as the pass reads it. */
export interface CoordinatorView {
  /** A live wrapper holds the project coordinator lock. */
  running: boolean;
  /** When the live holder took the lock (running), else null. */
  lockAcquiredAt: string | null;
  /** A lock row whose holder is gone (the wrapper died without releasing it, e.g. SIGKILL). */
  staleLock: boolean;
  /** /state/coordinator-exit.json: how the last wrapper ended. */
  exit: { at: string; code: number; error?: string } | null;
  /** meta coordinator_restart.at: the last recorded restart (upgrade, settings, wake, context reset). */
  lastRestartAt: string | null;
}

export interface WakeInputs {
  now: Date;
  settings: RoutineSettings;
  coordinator: CoordinatorView;
  activeLeases: string[];
  drain: { reason: string } | null;
  startsPaused: boolean;
  budgetExhausted: boolean;
  reasons: WakeReason[];
  /** Last activity of the main session (transcript mtime or the Stop hook's last record; the lock time without one). */
  idleSince: string | null;
  lastOwnerMessageAt: string | null;
  wakesToday: number;
  lastWakeAt: string | null;
  crashStartsToday: number;
}

export type WakeDecision =
  | { action: 'none'; why: string }
  | { action: 'wake'; why: string; digest: boolean }
  | { action: 'crash-start'; why: string };

const minutesSince = (now: Date, at: string | null) => (at ? (now.getTime() - Date.parse(at)) / 60_000 : Infinity);

/** Exit codes of an owner or runtime stop, not a crash: claude /exit (0), SIGINT (130), SIGHUP (129, tmux kill-session), SIGTERM (143). */
const STOP_CODES = new Set([0, 129, 130, 143]);

/** Whether the coordinator's end was a crash (not an owner stop, a restart's kill or a wrapper stopped before claude). */
export function endedByCrash(c: Pick<CoordinatorView, 'exit' | 'staleLock'>): { crash: boolean; why: string } {
  if (c.exit) {
    if (c.exit.error?.startsWith('stopped by ')) return { crash: false, why: `the coordinator was stopped (${c.exit.error})` };
    if (STOP_CODES.has(c.exit.code)) return { crash: false, why: `the coordinator was stopped (exit code ${c.exit.code} at ${c.exit.at})` };
    return { crash: true, why: `the coordinator crashed (exit code ${c.exit.code} at ${c.exit.at}${c.exit.error ? `: ${c.exit.error.slice(0, 120)}` : ''})` };
  }
  if (c.staleLock) return { crash: true, why: 'the coordinator wrapper died without an exit record (its lock holder is gone)' };
  return { crash: false, why: 'the coordinator is not running and no crash is recorded' };
}

/**
 * The wake decision (decision 3), pure. A wake needs a running, idle coordinator with no active lease, no drain,
 * starts open, no owner message for 30 minutes, the wake gap and the daily cap; the digest bypasses the gap, the cap
 * and the budget. A coordinator that is not running is started only after a crash, never during a drain or a
 * restart in progress, at most MAX_CRASH_STARTS_PER_DAY times a day, and not at 100% budget.
 */
export function decideWake(i: WakeInputs): WakeDecision {
  const none = (why: string): WakeDecision => ({ action: 'none', why });
  if (!i.settings.enabled) return none('routine.enabled is off');
  const c = i.coordinator;
  if (!c.running) {
    const crash = endedByCrash(c);
    if (!crash.crash) return none(`${crash.why}: not started (only a crash is restarted)`);
    if (i.drain) return none(`${crash.why}, but a drain is in progress (${i.drain.reason}): the upgrade starts the coordinator itself`);
    if (minutesSince(i.now, c.lastRestartAt) < RESTART_SETTLE_MINUTES) return none(`${crash.why}, but a restart is in progress (recorded ${c.lastRestartAt})`);
    if (i.budgetExhausted) return none(`${crash.why}, but the budget is used up: no crash start`);
    if (i.crashStartsToday >= MAX_CRASH_STARTS_PER_DAY) return none(`${crash.why}; crash start limit reached (${i.crashStartsToday}/${MAX_CRASH_STARTS_PER_DAY} today): left for the owner`);
    return { action: 'crash-start', why: `${crash.why}: starting it with the recovery prompt (${i.crashStartsToday + 1}/${MAX_CRASH_STARTS_PER_DAY} today)` };
  }
  let reasons = i.reasons;
  if (!reasons.length) return none('nothing needs a model');
  const digest = reasons.some((r) => r.kind === 'digest');
  if (i.budgetExhausted) {
    reasons = reasons.filter((r) => r.kind === 'digest');
    if (!reasons.length) return none('the budget is used up: only the digest wakes the coordinator');
  }
  if (i.startsPaused && !digest) return none('starts are paused');
  if (i.activeLeases.length) return none(`${i.activeLeases.length} active worker lease(s) (${i.activeLeases.join(', ')}): the coordinator is busy`);
  if (i.drain) return none(`a drain is in progress (${i.drain.reason})`);
  const owner = minutesSince(i.now, i.lastOwnerMessageAt);
  if (owner < OWNER_ACTIVE_MINUTES) return none(`the owner wrote ${Math.floor(owner)} min ago (no wake within ${OWNER_ACTIVE_MINUTES} min)`);
  const idle = minutesSince(i.now, i.idleSince);
  if (idle < IDLE_MINUTES) return none(`the coordinator was active ${Math.floor(idle)} min ago (needs ${IDLE_MINUTES} min idle)`);
  const what = `${reasons.length} reason(s): ${reasons.slice(0, 3).map((r) => r.detail).join('; ')}${reasons.length > 3 ? '; …' : ''}`;
  if (digest) return { action: 'wake', why: `digest due; ${what}`, digest: true };
  const gap = minutesSince(i.now, i.lastWakeAt);
  if (gap < i.settings.minWakeGapMinutes) return none(`last wake ${Math.floor(gap)} min ago (routine.minWakeGapMinutes ${i.settings.minWakeGapMinutes})`);
  if (i.wakesToday >= i.settings.maxWakesPerDay) return none(`wake limit reached (${i.wakesToday}/${i.settings.maxWakesPerDay} today, routine.maxWakesPerDay)`);
  return { action: 'wake', why: what, digest: false };
}

// ---------------------------------------------------------------- reasons

/** When the main session last did anything (its transcript), else when its lock was taken. */
export function coordinatorIdleSince(db: Pick<RuntimeDb, 'getMeta'>, c: CoordinatorView, mtime: (path: string) => number | null = fileMtime): string | null {
  if (!c.running) return null;
  type Rec = { path?: string; at?: string } | null;
  let rec: Rec = null;
  try { rec = JSON.parse(db.getMeta(TRANSCRIPT_META) ?? 'null') as Rec; } catch { rec = null; }
  // Only this session's transcript: the Stop hook saw it after the current lock was taken.
  if (!rec?.path || !rec.at || (c.lockAcquiredAt && rec.at < c.lockAcquiredAt)) return c.lockAcquiredAt;
  const m = mtime(rec.path);
  const at = Math.max(Date.parse(rec.at), m ?? 0);
  return new Date(at).toISOString();
}

export function fileMtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/**
 * Wake reasons: the stages `work next` lists as runnable (capacity, pauses, drain and the budget already applied),
 * plus what happened while the coordinator was idle (since `since`): an unvalidated result, a needs_split result, a
 * task that reached awaiting-human. Things the coordinator did itself happen inside its turns, before `since`.
 */
export function collectWakeReasons(db: RuntimeDb, next: Pick<NextReport, 'runnable'> | null, since: string | null): WakeReason[] {
  const out: WakeReason[] = [];
  for (const r of next?.runnable ?? []) out.push({ kind: 'runnable', taskId: r.taskId, role: r.role, detail: `${r.taskId} ${r.role} runnable` });
  if (!since) return out;
  for (const l of db.all<{ id: string; task_id: string; status: string; result_json: string | null }>(
    "SELECT id, task_id, status, result_json FROM leases WHERE ended_at >= ? AND status IN ('unvalidated', 'completed') ORDER BY ended_at", since)) {
    if (l.status === 'unvalidated') { out.push({ kind: 'unvalidated', taskId: l.task_id, leaseId: l.id, detail: `${l.task_id}: result of ${l.id} is unvalidated` }); continue; }
    let status: unknown = null;
    try { status = (JSON.parse(l.result_json ?? 'null') as { status?: unknown } | null)?.status; } catch { status = null; }
    if (status === 'needs_split') out.push({ kind: 'needs-split', taskId: l.task_id, leaseId: l.id, detail: `${l.task_id}: ${l.id} asks for a split` });
  }
  const seen = new Set<string>();
  for (const e of db.eventsOfKindSince('record', since)) {
    const d = e.data as { to?: unknown } | null;
    const taskId = e.taskId;
    if (d?.to !== 'awaiting-human' || !taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    out.push({ kind: 'awaiting-human', taskId, detail: `${taskId} needs the owner (awaiting-human): compose the question` });
  }
  return out;
}

// ---------------------------------------------------------------- the pass

export interface RoutineSyncSummary {
  intakeCreated: number;
  synced: number;
  failed: number;
  statusChanges: number;
  merged: number;
  armed: number;
  errors: string[];
}

/** Counts of one `minions sync` (the routine event keeps counts, not the full report). */
export function summarizeSync(r: SyncReport, intake: IntakeSyncReport | null): RoutineSyncSummary {
  return {
    intakeCreated: intake?.created.length ?? 0,
    synced: r.synced,
    failed: r.failed,
    statusChanges: r.tasks.filter((t) => t.statusChange).length,
    merged: r.tasks.filter((t) => t.merge?.merged || t.statusChange?.to === 'done').length,
    armed: r.tasks.filter((t) => t.merge?.armed).length,
    errors: [...(intake?.errors ?? []).map((e) => `intake: ${e}`), ...r.tasks.filter((t) => t.error).map((t) => `${t.taskId}: ${t.error}`)].map((e) => e.slice(0, 300)).slice(0, 10),
  };
}

export interface RoutinePassDeps {
  db: RuntimeDb;
  config: MinionsConfig;
  now: () => Date;
  /** This process (the lock holder) and its start time. */
  pid?: number;
  procStart?: (pid: number) => string | null;
  /** Whether a routine lock holder still runs (pid alive with the recorded start time). */
  lockAlive: (l: RoutineLock) => boolean;
  /** The full `minions sync` (intake, PR/CI observations, merged/closed, the merge pass). */
  sync: () => Promise<RoutineSyncSummary>;
  /** `work next` (null when it fails: no runnable reasons this pass). */
  next: () => Promise<Pick<NextReport, 'runnable'> | null>;
  coordinator: () => Promise<CoordinatorView>;
  /** Active leases as the restart counts them (open process runs included). */
  activeLeases: () => Promise<string[]>;
  budgetExhausted: () => boolean;
  /** An upgrade the host is applying (it starts the coordinator itself): treated like a drain. */
  upgradeInProgress?: () => string | null;
  /** Phase 4: whether a digest is due (src/runtime/digest.ts digestStatus; the detail line), else null. Default: never. */
  digestDue?: () => string | null;
  /** Phase 4: the outbox hold-back (reholdExpired): held items stay for the digest (routine off: released); returns the count. */
  holdBack?: () => number;
  mtime?: (path: string) => number | null;
  /** The fresh wake: `coordinator restart --wake` detached, never with force (scheduleDetachedRestart). */
  wake: () => Promise<string>;
  /** The crash start: `coordinator restart --recover` detached, after its own drain check. */
  crashStart: () => Promise<string>;
}

export type RoutineSkip = 'disabled' | 'locked' | 'interval' | 'fresh';

export interface RoutineReport {
  ran: boolean;
  skipped?: RoutineSkip;
  why: string;
  trigger: RoutineTrigger;
  at: string;
  /** When the clock runs the next pass (last pass + tickMinutes); null when the routine is off. */
  nextAt: string | null;
  lastAt: string | null;
  durationMs?: number;
  sync?: RoutineSyncSummary;
  syncError?: string;
  /** Held notifications moved on to the next digest by the hold-back step. */
  reheld?: number;
  reasons?: WakeReason[];
  decision?: WakeDecision;
  /** What the wake or crash start did (scheduled, or the refusal). */
  outcome?: { ok: boolean; detail: string };
  coordinator: { running: boolean; since: string | null };
}

const plusMinutes = (at: string, m: number) => new Date(Date.parse(at) + m * 60_000).toISOString();
const msg = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 500);

/** Coordinator summary for reports and the watchdog: running since the lock, or down since the exit record. */
const coordinatorLine = (c: CoordinatorView) => ({ running: c.running, since: c.running ? c.lockAcquiredAt : c.exit?.at ?? null });

function drainOrUpgrade(deps: Pick<RoutinePassDeps, 'db' | 'upgradeInProgress'>): { reason: string } | null {
  const d = deps.db.drain();
  if (d) return { reason: d.reason };
  const up = deps.upgradeInProgress?.() ?? null;
  return up ? { reason: `upgrade in progress: ${up}` } : null;
}

export async function runRoutinePass(deps: RoutinePassDeps, opts: { trigger: RoutineTrigger; force?: boolean }): Promise<RoutineReport> {
  const now = deps.now();
  const at = now.toISOString();
  const settings = routineSettings(deps.config);
  const last = deps.db.lastEventOfKind(ROUTINE_EVENT);
  const lastAt = last?.at ?? null;
  const nextAt = settings.enabled ? (lastAt ? plusMinutes(lastAt, settings.tickMinutes) : at) : null;
  const coordinator = await deps.coordinator();
  const base = { trigger: opts.trigger, at, lastAt, nextAt, coordinator: coordinatorLine(coordinator) };
  if (!settings.enabled && opts.trigger !== 'manual') {
    // Routine off: no digest is coming, so items held for it are released here too (as in `notify pending`).
    let reheld: number | undefined;
    if (deps.holdBack) { try { reheld = deps.holdBack(); } catch { /* never stops the pass */ } }
    return { ...base, ran: false, skipped: 'disabled', why: 'routine.enabled is off', ...(reheld ? { reheld } : {}) };
  }
  const age = minutesSince(now, lastAt);
  if (opts.trigger === 'watchdog') {
    if (age < WATCHDOG_TICKS * settings.tickMinutes) return { ...base, ran: false, skipped: 'fresh', why: `the last pass ran ${Math.floor(age)} min ago (the watchdog runs it after ${WATCHDOG_TICKS * settings.tickMinutes} min)` };
  } else if (!opts.force && age < settings.tickMinutes / 2) {
    return { ...base, ran: false, skipped: 'interval', why: `the last pass ran ${Math.floor(age)} min ago (at most once per ${settings.tickMinutes / 2} min; --force runs it anyway)` };
  }
  const pid = deps.pid ?? process.pid;
  const lock = deps.db.acquireRoutineLock(pid, deps.procStart?.(pid) ?? null, deps.lockAlive, now);
  if (!lock) {
    const h = deps.db.routineLock();
    return { ...base, ran: false, skipped: 'locked', why: `another routine pass is running (pid ${h?.pid ?? '?'} since ${h?.at ?? '?'})` };
  }
  try {
    const report: RoutineReport = { ...base, ran: true, why: '' };
    try { report.sync = await deps.sync(); } catch (e) { report.syncError = msg(e); }
    // With the routine on it keeps held items for the digest; off (a manual pass), it releases them.
    if (deps.holdBack) { try { report.reheld = deps.holdBack(); } catch { /* the hold-back never stops the pass */ } }
    // The sync may have changed what the coordinator sees (merged, imported, CI): read the state after it.
    const c = await deps.coordinator();
    report.coordinator = coordinatorLine(c);
    const since = c.running ? coordinatorIdleSince(deps.db, c, deps.mtime) : null;
    let next: Pick<NextReport, 'runnable'> | null = null;
    try { next = await deps.next(); } catch { next = null; }
    const reasons = settings.enabled && c.running ? collectWakeReasons(deps.db, next, since) : [];
    const digest = settings.enabled ? deps.digestDue?.() ?? null : null;
    if (digest) reasons.push({ kind: 'digest', detail: digest });
    const day = localDayStart(deps.now(), settings.timezone);
    const wakes = deps.db.eventsOfKindSince(WAKE_EVENT, day);
    const lastWake = deps.db.lastEventOfKind(WAKE_EVENT);
    const decision = decideWake({
      now: deps.now(), settings, coordinator: c, activeLeases: await deps.activeLeases(), drain: drainOrUpgrade(deps), startsPaused: deps.db.paused().starts,
      budgetExhausted: deps.budgetExhausted(), reasons, idleSince: since, lastOwnerMessageAt: lastOwnerMessageAt(deps.db),
      wakesToday: wakes.length, lastWakeAt: lastWake?.at ?? null, crashStartsToday: deps.db.eventsOfKindSince(CRASH_START_EVENT, day).length,
    });
    report.reasons = reasons;
    report.decision = decision;
    if (decision.action === 'wake') {
      try {
        const detail = await deps.wake();
        report.outcome = { ok: true, detail };
        deps.db.addEvent(WAKE_EVENT, null, { digest: decision.digest, reasons: reasons.map((r) => r.kind), detail }, deps.now().toISOString());
      } catch (e) { report.outcome = { ok: false, detail: msg(e) }; }
    } else if (decision.action === 'crash-start') {
      try {
        const detail = await deps.crashStart();
        report.outcome = { ok: true, detail };
        deps.db.addEvent(CRASH_START_EVENT, null, { why: decision.why, detail }, deps.now().toISOString());
      } catch (e) { report.outcome = { ok: false, detail: msg(e) }; }
    }
    report.why = decision.why;
    report.durationMs = deps.now().getTime() - now.getTime();
    report.nextAt = settings.enabled ? plusMinutes(at, settings.tickMinutes) : null;
    deps.db.addEvent(ROUTINE_EVENT, null, {
      trigger: report.trigger, durationMs: report.durationMs, sync: report.sync ?? null, syncError: report.syncError ?? null, reheld: report.reheld ?? 0,
      reasons: reasons.slice(0, 50), decision, outcome: report.outcome ?? null, coordinator: report.coordinator,
    }, at);
    return report;
  } finally {
    try { deps.db.releaseRoutineLock(lock); } catch { /* a dead holder is taken over next time */ }
  }
}

/** The last recorded pass (`minions sync --routine --last`): what the woken coordinator reads its reasons from. */
export interface RoutineLast {
  enabled: boolean;
  tickMinutes: number;
  last: { at: string; trigger: string; decision: WakeDecision | null; reasons: WakeReason[]; outcome: { ok: boolean; detail: string } | null; sync: RoutineSyncSummary | null; syncError: string | null } | null;
  nextAt: string | null;
  wakesToday: number;
  lastWakeAt: string | null;
}

export function routineLast(db: RuntimeDb, cfg: Pick<MinionsConfig, 'routine'>, now: Date = new Date()): RoutineLast {
  const s = routineSettings(cfg);
  const e = db.lastEventOfKind(ROUTINE_EVENT);
  const d = (e?.data ?? {}) as { trigger?: string; decision?: WakeDecision; reasons?: WakeReason[]; outcome?: { ok: boolean; detail: string }; sync?: RoutineSyncSummary; syncError?: string };
  return {
    enabled: s.enabled, tickMinutes: s.tickMinutes,
    last: e ? { at: e.at, trigger: d.trigger ?? 'unknown', decision: d.decision ?? null, reasons: d.reasons ?? [], outcome: d.outcome ?? null, sync: d.sync ?? null, syncError: d.syncError ?? null } : null,
    nextAt: s.enabled ? (e ? plusMinutes(e.at, s.tickMinutes) : now.toISOString()) : null,
    wakesToday: db.eventsOfKindSince(WAKE_EVENT, localDayStart(now, s.timezone)).length,
    lastWakeAt: db.lastEventOfKind(WAKE_EVENT)?.at ?? null,
  };
}

/** One status line: the last pass and the next one. */
export function humanRoutine(r: RoutineLast): string {
  if (!r.enabled) return `routine: off (routine.enabled)${r.last ? `; last pass ${r.last.at}` : ''}`;
  const last = r.last ? `last pass ${r.last.at} (${r.last.trigger}: ${r.last.decision?.action === 'none' ? r.last.decision.why : r.last.decision?.action ?? 'no decision'})` : 'no pass yet';
  return `routine: every ${r.tickMinutes} min; ${last}; next ${r.nextAt ?? '-'}; wakes today ${r.wakesToday}`;
}

export function humanRoutineReport(r: RoutineReport): string {
  if (!r.ran) return `routine pass skipped (${r.skipped}): ${r.why}`;
  const s = r.sync;
  return [
    `routine pass (${r.trigger}) at ${r.at}: ${s ? `synced ${s.synced}, failed ${s.failed}, ${s.statusChanges} status change(s), ${s.merged} merged, ${s.armed} armed, ${s.intakeCreated} imported` : `sync failed: ${r.syncError ?? 'unknown'}`}`,
    `decision: ${r.decision?.action ?? 'none'} - ${r.why}${r.outcome ? ` (${r.outcome.ok ? 'scheduled' : 'refused'}: ${r.outcome.detail})` : ''}`,
    ...(r.reasons?.length ? ['reasons:', ...r.reasons.map((x) => `  ${x.kind}: ${x.detail}`)] : []),
    `next pass ${r.nextAt ?? '-'}`,
  ].join('\n');
}

// ---------------------------------------------------------------- the clock

export interface RoutineClockDeps {
  /** Current routine settings (re-read each tick: the settings are live). */
  settings: () => Promise<RoutineSettings>;
  /** Runs one pass (the CLI: a bounded child `minions sync --routine --trigger clock`). */
  run: () => Promise<unknown>;
  /** setTimeout-like; returns a cancel function (tests pass a fake clock). */
  timer?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

const realTimer = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); };

/**
 * The wrapper clock (decision 2): a timer chain in the wrapper process, one pass per tickMinutes while
 * routine.enabled. A pass still running when the next tick comes is not doubled (the tick is skipped). Never throws
 * into the wrapper; returns the stop function.
 */
export function startRoutineClock(deps: RoutineClockDeps): () => void {
  const timer = deps.timer ?? realTimer;
  let stopped = false;
  let cancel: (() => void) | null = null;
  let running = false;
  const schedule = (minutes: number) => { if (!stopped) cancel = timer(() => { void tick(); }, minutes * 60_000); };
  const tick = async () => {
    let s: RoutineSettings | null = null;
    try { s = await deps.settings(); } catch (e) { deps.log?.(`minions: routine clock: config unreadable (${msg(e)})`); }
    if (s?.enabled && !running && !stopped) {
      running = true;
      try { await deps.run(); } catch (e) { deps.log?.(`minions: routine pass failed: ${msg(e)}`); } finally { running = false; }
    }
    schedule(s?.tickMinutes ?? ROUTINE_DEFAULTS.tickMinutes);
  };
  // The first pass one tick after the start: the coordinator's own startup (intake, recovery) runs first.
  void deps.settings().then((s) => schedule(s.tickMinutes), () => schedule(ROUTINE_DEFAULTS.tickMinutes));
  return () => { stopped = true; cancel?.(); };
}
