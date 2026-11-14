// The unattended routine pass (docs/design/unattended-delivery.md, phase 1, task-68.2): `minions sync --routine`.
//
// One deterministic pass, no model call anywhere in it:
//   1. the routine lock (meta `routine_lock`, {pid, start}: a dead or reused pid is taken over) and the interval
//      (at most once per half tick unless --force; the watchdog only when the last pass is older than 2 ticks);
//   2. the wake decision (decideWake, a pure function) and its action: a fresh coordinator session through the
//      detached restart with the constant wake prompt (never with force), or the separate crash start (recover);
//   3. a `routine` event with the counts, the decision and the reasons (`--last` reads it back).
// The autopilot dispatcher runs every stage (docs/design/autonomy.md Decision 10), so the only work a wake is for is its
// held decisions and the digest. With coordinator.sessions.enabled a hold goes to its task session instead, and only
// the digest still wakes the coordinator.
// Every external effect (restart, clock, process table, files) is an injected dependency, so tests run it with a
// fake clock and a fake restart.
import { statSync } from 'node:fs';
import type { MinionsConfig } from '../config/schema.js';
import type { RuntimeDb, RoutineLock } from './db.js';
import { lastOwnerMessageAt } from './coordinator-usage.js';
import { TRANSCRIPT_META } from './context-reset.js';
import { localDayStart } from './zoned-time.js';
import { readHolds } from './dispatch-state.js';
import type { GoalsView } from './goals.js';

export const ROUTINE_DEFAULTS = {
  tickMinutes: 15, minWakeGapMinutes: 30, maxWakesPerDay: 8, digestAt: ['08:00'] as readonly string[], timezone: 'Europe/Berlin',
  maxPlanWakesPerDay: 4, minPlanGapMinutes: 120,
} as const;
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
/** A wake for planning (docs/design/autonomy.md Decision 16); also recorded as a WAKE_EVENT, so it counts as a wake. */
export const PLAN_WAKE_EVENT = 'routine-plan-wake';
/** The constant planning prompt: the restart's wake reads it from the reasons; a session gets it as its message. */
export const PLAN_PROMPT = '/minions:orchestrate plan';

export interface RoutineSettings {
  enabled: boolean; tickMinutes: number; minWakeGapMinutes: number; maxWakesPerDay: number;
  /** Local digest times "HH:MM" (phase 4), sorted, in `timezone`. */
  digestAt: string[];
  /** IANA zone of the digest times and of the routine's days (wakes and crash starts per day). */
  timezone: string;
  /** Plan when the queue is empty and a goal is open (default: on in independent mode, off in supervised). */
  planWhenIdle: boolean;
  maxPlanWakesPerDay: number;
  minPlanGapMinutes: number;
}

/** Effective routine settings: unset = off, every unset field its default (planWhenIdle: by the mode). */
export function routineSettings(cfg: Pick<MinionsConfig, 'routine'> & { mode?: MinionsConfig['mode'] }): RoutineSettings {
  const r = cfg.routine ?? {};
  return {
    enabled: r.enabled === true,
    tickMinutes: r.tickMinutes ?? ROUTINE_DEFAULTS.tickMinutes,
    minWakeGapMinutes: r.minWakeGapMinutes ?? ROUTINE_DEFAULTS.minWakeGapMinutes,
    maxWakesPerDay: r.maxWakesPerDay ?? ROUTINE_DEFAULTS.maxWakesPerDay,
    digestAt: [...new Set(r.digestAt?.length ? r.digestAt : ROUTINE_DEFAULTS.digestAt)].sort(),
    timezone: r.timezone ?? ROUTINE_DEFAULTS.timezone,
    planWhenIdle: r.planWhenIdle ?? cfg.mode === 'independent',
    maxPlanWakesPerDay: r.maxPlanWakesPerDay ?? ROUTINE_DEFAULTS.maxPlanWakesPerDay,
    minPlanGapMinutes: r.minPlanGapMinutes ?? ROUTINE_DEFAULTS.minPlanGapMinutes,
  };
}

export type RoutineTrigger = 'clock' | 'watchdog' | 'manual';
export const ROUTINE_TRIGGERS: readonly RoutineTrigger[] = ['clock', 'watchdog', 'manual'];

/** Why the coordinator should be woken: only work that needs a model (decision 3). */
export type WakeReason =
  /** The autopilot dispatcher holds a task for a decision (docs/design/autonomy.md Decision 1). */
  | { kind: 'dispatch-decision'; taskId: string; detail: string }
  /** The digest is due (phase 4 composes it): always allowed, also at 100% budget and past maxWakesPerDay. */
  | { kind: 'digest'; detail: string }
  /** The queue is empty and a goal is open: plan the next tasks (Decision 16; planReason). */
  | { kind: 'plan'; detail: string };

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
  /** Plan wakes today and the last one (a `plan` reason's own cap and gap). */
  planWakesToday?: number;
  lastPlanWakeAt?: string | null;
}

export type WakeDecision =
  | { action: 'none'; why: string }
  /** plan: the wake is (also) for planning; with sessions on it goes to the general session instead of a restart. */
  | { action: 'wake'; why: string; digest: boolean; plan: boolean }
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
  // Planning has its own cap and gap on top of the wake's: it never rides along on a digest past them either.
  const planBlock = reasons.some((r) => r.kind === 'plan') ? planCapBlock(i) : null;
  if (planBlock) {
    reasons = reasons.filter((r) => r.kind !== 'plan');
    if (!reasons.length) return none(planBlock);
  }
  const plan = reasons.some((r) => r.kind === 'plan');
  if (i.startsPaused && !digest) return none('starts are paused');
  if (i.activeLeases.length) return none(`${i.activeLeases.length} active worker lease(s) (${i.activeLeases.join(', ')}): the coordinator is busy`);
  if (i.drain) return none(`a drain is in progress (${i.drain.reason})`);
  const owner = minutesSince(i.now, i.lastOwnerMessageAt);
  if (owner < OWNER_ACTIVE_MINUTES) return none(`the owner wrote ${Math.floor(owner)} min ago (no wake within ${OWNER_ACTIVE_MINUTES} min)`);
  const idle = minutesSince(i.now, i.idleSince);
  if (idle < IDLE_MINUTES) return none(`the coordinator was active ${Math.floor(idle)} min ago (needs ${IDLE_MINUTES} min idle)`);
  const what = `${reasons.length} reason(s): ${reasons.slice(0, 3).map((r) => r.detail).join('; ')}${reasons.length > 3 ? '; …' : ''}`;
  if (digest) return { action: 'wake', why: `digest due; ${what}`, digest: true, plan };
  const gap = minutesSince(i.now, i.lastWakeAt);
  if (gap < i.settings.minWakeGapMinutes) return none(`last wake ${Math.floor(gap)} min ago (routine.minWakeGapMinutes ${i.settings.minWakeGapMinutes})`);
  if (i.wakesToday >= i.settings.maxWakesPerDay) return none(`wake limit reached (${i.wakesToday}/${i.settings.maxWakesPerDay} today, routine.maxWakesPerDay)`);
  return { action: 'wake', why: what, digest: false, plan };
}

/** Why a plan reason waits for its own limits (routine.maxPlanWakesPerDay, routine.minPlanGapMinutes), else null. */
function planCapBlock(i: WakeInputs): string | null {
  const today = i.planWakesToday ?? 0;
  if (today >= i.settings.maxPlanWakesPerDay) return `plan wake limit reached (${today}/${i.settings.maxPlanWakesPerDay} today, routine.maxPlanWakesPerDay)`;
  const gap = minutesSince(i.now, i.lastPlanWakeAt ?? null);
  if (gap < i.settings.minPlanGapMinutes) return `last plan wake ${Math.floor(gap)} min ago (routine.minPlanGapMinutes ${i.settings.minPlanGapMinutes})`;
  return null;
}

/** What the pass knows for planning (the CLI reads the goals copy, the goals state and the backlog). */
export interface PlanFacts {
  goals: Pick<GoalsView, 'present' | 'counts' | 'exhausted'>;
  /** Tasks the team is busy with: ready, in a stage, waiting for CI or merging (goals.ts QUEUED_STATUSES). */
  queued: number;
  /** `idea` tasks: a planning pass promotes worthwhile ones before inventing new work. */
  ideas: number;
  intakePaused: boolean;
  /** Sessions on: why the general session cannot take a planning message now (pending messages), else null. */
  sessionBusy?: string | null;
}

/**
 * The plan reason (pure): the queue is empty, a goal is open, intake is open, and planning has not recorded that
 * nothing worthwhile is left for the goals as they are. Returns the reason, or why there is none.
 */
export function planReason(f: PlanFacts): { reason: WakeReason | null; why: string } {
  const no = (why: string) => ({ reason: null, why });
  if (!f.goals.present) return no('no goals file');
  if (!f.goals.counts.open) return no(`no open goal (${f.goals.counts.done} done, ${f.goals.counts.paused} paused)`);
  if (f.queued) return no(`${f.queued} task(s) ready or in flight`);
  if (f.intakePaused) return no('intake is paused');
  if (f.goals.exhausted) return no(`planning found nothing worthwhile left at ${f.goals.exhausted.at} (until the goals change)`);
  if (f.sessionBusy) return no(f.sessionBusy);
  const ideas = f.ideas ? `; ${f.ideas} idea task(s) to weigh first` : '';
  return { reason: { kind: 'plan', detail: `the queue is empty and ${f.goals.counts.open} goal(s) are open${ideas}: plan the next tasks` }, why: 'plan due' };
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
 * Wake reasons: the tasks the autopilot dispatcher holds for a decision. Every unvalidated result, split request and
 * awaiting-human record of a dispatcher worker is a hold too, so nothing else needs a model.
 */
export function collectWakeReasons(db: Pick<RuntimeDb, 'getMeta'>): WakeReason[] {
  return Object.values(readHolds(db)).map((h) => ({ kind: 'dispatch-decision', taskId: h.taskId, detail: `${h.taskId} needs a decision (${h.kind}): ${h.message.slice(0, 120)}` }));
}

// ---------------------------------------------------------------- the pass

export interface RoutinePassDeps {
  db: RuntimeDb;
  config: MinionsConfig;
  now: () => Date;
  /** This process (the lock holder) and its start time. */
  pid?: number;
  procStart?: (pid: number) => string | null;
  /** Whether a routine lock holder still runs (pid alive with the recorded start time). */
  lockAlive: (l: RoutineLock) => boolean;
  coordinator: () => Promise<CoordinatorView>;
  /** Active leases as the restart counts them (open process runs included). */
  activeLeases: () => Promise<string[]>;
  budgetExhausted: () => boolean;
  /** An upgrade the host is applying (it starts the coordinator itself): treated like a drain. */
  upgradeInProgress?: () => string | null;
  /** Phase 4: whether a digest is due (src/runtime/digest.ts digestStatus; the detail line), else null. Default: never. */
  digestDue?: (now: Date) => string | null;
  /** Phase 4: the outbox hold-back (reholdExpired): held items stay for the digest (routine off: released); returns the count. */
  holdBack?: (now: Date) => number;
  mtime?: (path: string) => number | null;
  /** Planning (Decision 16): the goals and the queue, read only when the routine may plan. Default: never plans. */
  planFacts?: () => Promise<PlanFacts>;
  /** Sessions on: hands PLAN_PROMPT to the general session instead of restarting the router. */
  planSession?: () => Promise<string>;
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
  /** Held notifications moved on to the next digest by the hold-back step. */
  reheld?: number;
  reasons?: WakeReason[];
  /** Why the pass did or did not add a plan reason (null: the routine does not plan). */
  plan?: string | null;
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
    if (deps.holdBack) { try { reheld = deps.holdBack(now); } catch { /* never stops the pass */ } }
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
    // With the routine on it keeps held items for the digest; off (a manual pass), it releases them.
    if (deps.holdBack) { try { report.reheld = deps.holdBack(now); } catch { /* the hold-back never stops the pass */ } }
    const c = await deps.coordinator();
    report.coordinator = coordinatorLine(c);
    const since = c.running ? coordinatorIdleSince(deps.db, c, deps.mtime) : null;
    // Sessions on: holds go to their task sessions; nothing but the digest wakes the coordinator.
    const sessionsOn = deps.config.coordinator?.sessions?.enabled === true;
    const reasons = settings.enabled && c.running && !sessionsOn ? collectWakeReasons(deps.db) : [];
    report.plan = await planCheck(deps, settings, c, reasons);
    const digest = settings.enabled ? deps.digestDue?.(deps.now()) ?? null : null;
    // Sessions on and the router running: its background `coordinator wait` returns for the digest, so no restart.
    if (digest && !(sessionsOn && c.running)) reasons.push({ kind: 'digest', detail: digest });
    const day = localDayStart(deps.now(), settings.timezone);
    const wakes = deps.db.eventsOfKindSince(WAKE_EVENT, day);
    const lastWake = deps.db.lastEventOfKind(WAKE_EVENT);
    const decision = decideWake({
      now: deps.now(), settings, coordinator: c, activeLeases: await deps.activeLeases(), drain: drainOrUpgrade(deps), startsPaused: deps.db.paused().starts,
      budgetExhausted: deps.budgetExhausted(), reasons, idleSince: since, lastOwnerMessageAt: lastOwnerMessageAt(deps.db),
      wakesToday: wakes.length, lastWakeAt: lastWake?.at ?? null, crashStartsToday: deps.db.eventsOfKindSince(CRASH_START_EVENT, day).length,
      planWakesToday: deps.db.eventsOfKindSince(PLAN_WAKE_EVENT, day).length, lastPlanWakeAt: deps.db.lastEventOfKind(PLAN_WAKE_EVENT)?.at ?? null,
    });
    report.reasons = reasons;
    report.decision = decision;
    if (decision.action === 'wake') {
      try {
        // Sessions on: only planning reaches here while the router runs (holds go to task sessions, it sends the digest).
        const toSession = decision.plan && sessionsOn && !decision.digest;
        if (toSession && !deps.planSession) throw new Error('no session to plan in');
        const detail = toSession ? await deps.planSession!() : await deps.wake();
        report.outcome = { ok: true, detail };
        const at = deps.now().toISOString();
        deps.db.addEvent(WAKE_EVENT, null, { digest: decision.digest, reasons: reasons.map((r) => r.kind), detail }, at);
        if (decision.plan) deps.db.addEvent(PLAN_WAKE_EVENT, null, { via: toSession ? 'session' : 'restart', detail }, at);
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
      trigger: report.trigger, durationMs: report.durationMs, reheld: report.reheld ?? 0,
      reasons: reasons.slice(0, 50), plan: report.plan ?? null, decision, outcome: report.outcome ?? null, coordinator: report.coordinator,
    }, at);
    return report;
  } finally {
    try { deps.db.releaseRoutineLock(lock); } catch { /* a dead holder is taken over next time */ }
  }
}

/**
 * Adds the plan reason when the routine may plan: on, planWhenIdle, the coordinator running and no held decision
 * (holds come first). Returns why it did or did not (null when planning is off). Never throws.
 */
async function planCheck(deps: Pick<RoutinePassDeps, 'planFacts'>, s: RoutineSettings, c: CoordinatorView, reasons: WakeReason[]): Promise<string | null> {
  if (!s.enabled || !s.planWhenIdle || !deps.planFacts) return null;
  if (!c.running) return 'the coordinator is not running';
  if (reasons.some((r) => r.kind === 'dispatch-decision')) return 'held decisions come first';
  try {
    const p = planReason(await deps.planFacts());
    if (p.reason) reasons.push(p.reason);
    return p.why;
  } catch (e) { return `planning facts unreadable: ${msg(e)}`; }
}

/** The last recorded pass (`minions sync --routine --last`): what the woken coordinator reads its reasons from. */
export interface RoutineLast {
  enabled: boolean;
  tickMinutes: number;
  last: { at: string; trigger: string; decision: WakeDecision | null; reasons: WakeReason[]; outcome: { ok: boolean; detail: string } | null } | null;
  nextAt: string | null;
  wakesToday: number;
  lastWakeAt: string | null;
  /** Planning wakes (Decision 16); null when the routine does not plan (off, or routine.planWhenIdle off). */
  plan: { wakesToday: number; maxPerDay: number; lastAt: string | null; nextAt: string | null; why: string | null } | null;
}

export function routineLast(db: RuntimeDb, cfg: Pick<MinionsConfig, 'routine'> & { mode?: MinionsConfig['mode'] }, now: Date = new Date()): RoutineLast {
  const s = routineSettings(cfg);
  const e = db.lastEventOfKind(ROUTINE_EVENT);
  const d = (e?.data ?? {}) as { trigger?: string; decision?: WakeDecision; reasons?: WakeReason[]; plan?: string | null; outcome?: { ok: boolean; detail: string } };
  const nextAt = s.enabled ? (e ? plusMinutes(e.at, s.tickMinutes) : now.toISOString()) : null;
  const day = localDayStart(now, s.timezone);
  const lastWakeAt = db.lastEventOfKind(WAKE_EVENT)?.at ?? null;
  let plan: RoutineLast['plan'] = null;
  if (s.enabled && s.planWhenIdle) {
    const planToday = db.eventsOfKindSince(PLAN_WAKE_EVENT, day).length;
    const lastAt = db.lastEventOfKind(PLAN_WAKE_EVENT)?.at ?? null;
    // The earliest pass that may plan: the next pass, the plan gap, the wake gap, and tomorrow once today's cap is used.
    const after = [nextAt, lastAt && plusMinutes(lastAt, s.minPlanGapMinutes), lastWakeAt && plusMinutes(lastWakeAt, s.minWakeGapMinutes),
      planToday >= s.maxPlanWakesPerDay ? localDayStart(new Date(Date.parse(day) + 36 * 3_600_000), s.timezone) : null];
    const next = after.filter((x): x is string => !!x).sort().at(-1) ?? null;
    plan = { wakesToday: planToday, maxPerDay: s.maxPlanWakesPerDay, lastAt, nextAt: next, why: d.plan ?? null };
  }
  return {
    enabled: s.enabled, tickMinutes: s.tickMinutes,
    last: e ? { at: e.at, trigger: d.trigger ?? 'unknown', decision: d.decision ?? null, reasons: d.reasons ?? [], outcome: d.outcome ?? null } : null,
    nextAt,
    wakesToday: db.eventsOfKindSince(WAKE_EVENT, day).length,
    lastWakeAt,
    plan,
  };
}

/** One status line: the last pass and the next one. */
export function humanRoutine(r: RoutineLast): string {
  if (!r.enabled) return `routine: off (routine.enabled)${r.last ? `; last pass ${r.last.at}` : ''}`;
  const last = r.last ? `last pass ${r.last.at} (${r.last.trigger}: ${r.last.decision?.action === 'none' ? r.last.decision.why : r.last.decision?.action ?? 'no decision'})` : 'no pass yet';
  return `routine: every ${r.tickMinutes} min; ${last}; next ${r.nextAt ?? '-'}; wakes today ${r.wakesToday}${r.plan ? `\n${humanPlan(r.plan)}` : ''}`;
}

/** The planning line under the routine: last and next plan wake, and why the last pass did not plan. */
export function humanPlan(p: NonNullable<RoutineLast['plan']>): string {
  const why = p.why && p.why !== 'plan due' ? ` (last pass: ${p.why})` : '';
  return `plan wakes: last ${p.lastAt ?? 'never'}; next when the queue is empty, not before ${p.nextAt ?? '-'}; today ${p.wakesToday}/${p.maxPerDay}${why}`;
}

export function humanRoutineReport(r: RoutineReport): string {
  if (!r.ran) return `routine pass skipped (${r.skipped}): ${r.why}`;
  return [
    `routine pass (${r.trigger}) at ${r.at}`,
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
