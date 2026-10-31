import { readFile } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Option, type Command } from 'commander';
import { setIdempotencyStore, setIntakePausedContext, setProvenanceFallback, setReadyContext } from '../backlog/commands.js';
import { openBacklog, writeBacklogConfig } from '../backlog/factory.js';
import type { BacklogAdapter, IdempotencyStore, Task } from '../backlog/types.js';
import { validateConfig } from '../config/resolve.js';
import { isGithubDelivery } from '../config/delivery.js';
import type { MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode, runtimeMode } from '../core/cli-helpers.js';
import { displayText, stripControlChars, truncateCodePoints } from '../core/control-chars.js';
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { EXIT_CODES, MinionsError, type ErrorCode } from '../core/errors.js';
import { readJson } from '../core/fsutil.js';
import { emit, redact, reportError } from '../core/output.js';
import { approveOnHost } from '../host/approvals.js';
import { delegateToRuntime } from '../host/delegate.js';
import { applyDoctorExit, formatDoctor, runDoctor } from '../host/doctor.js';
import { formatRestartRequired, hostStatus, parseErrorEnvelope } from '../host/restart-required.js';
import { formatManagerOverview, managerOverview, managerOverviewJson } from '../host/manager-status.js';
import { listChangeRequests } from './change-requests.js';
import { readTelegramAccess } from '../telegram/access.js';
import { installTelegramPlugin } from '../telegram/install.js';
import { formatTelegramProbe, probeTelegram } from '../telegram/probe.js';
import { resolveChannel } from '../telegram/channel.js';
import { runChannelServer } from '../telegram/channel/server.js';
import { formatAccessResult, runAccessCommand, type AccessAction } from '../telegram/channel/access-cli.js';
import { createInterface } from 'node:readline/promises';
import type { PollerCheck } from '../telegram/isolation.js';
import {
  buildClaudeCommand, buildCoordinatorCommand, hostChannelReport, printChannelServer, telegramPollerStatus, claudePermissionModes, coordinatorWrapper, launchCoordinator, permissionModesNeeded, probeRuntime, readLaunchRecord, readMountedToken, RECOVERY_PROMPT,
  restartCoordinator, runtimeChannelFacts, scheduleDetachedRestart, syncCoordinator, coordinatorLaunchStatus, type LaunchStatus,
  coordinatorPidAlive, procStartTime, readExitRecord, runtimeAuthMethod, systemProcessControl, scheduleCrashStart, TELEGRAM_TOKEN_ENV, WAKE_PROMPT,
} from './coordinator.js';
import { pidAlive } from './db.js';
import { run as runChild } from '../core/exec.js';
import {
  humanRoutine, humanRoutineReport, ROUTINE_TRIGGERS, routineLast, routineSettings, runRoutinePass, startRoutineClock, summarizeSync,
  type CoordinatorView, type RoutineLast, type RoutineTrigger,
} from './routine.js';
import { currentBudget } from './spend.js';
import { openDb, type DrainNotice, type DrainRequest, type Lease, type PauseChange, type RuntimeDb } from './db.js';
import { clearDrain, requestDrain } from './drain.js';
import { claimWithBrief, compactClaim, fetchBrief, recordSubmitted, requireWorkerRole, submissionPath, submitResult, sweepScratchOnStart, type CompactClaim } from './handoff.js';
import { advanceLease, humanAdvance } from './advance.js';
import { runHook } from './hooks.js';
import { completeOpenSessions, noteResetRequest } from './coordinator-usage.js';
import { budgetNotice, humanBaseline, humanSpend, parseTokens, recordLeaseUsage, recordSessionUsage, setBudget, spendReport, type SpendReport } from './spend.js';
import { runtimePaths } from './paths.js';
import { controlApply, controlSet, controlShow, controlUndo, controlUnset, parseValue, readJournal, withControl, type ControlChange } from './control.js';
import { contextResetCheck, HANDOFF_MAX_BYTES, humanContextReset, readHandoff, TRANSCRIPT_META, withContextReset, writeHandoff, type ContextResetCheck } from './context-reset.js';
import { handoffPathFor, sessionScope } from './session-scope.js';
export { withContextReset } from './context-reset.js';
import { capacityOf, Scheduler, type NextReport, type NextStage, type RoleCapacity, type UsageFlag } from './scheduler.js';
import { gitCredential } from './github.js';
import { ciStatus, formatCiStatus, formatSync, syncTasks, type SyncReport } from './ci.js';
import { formatIntake, intakeProvenanceFallback, originRepository, syncIntake, type IntakeSyncReport } from './intake-sync.js';
import { ghWithTimeout, ORIGIN_REPOSITORY_META, originOfRemoteUrl, type GhFn } from './publish.js';
import { exportWorkspace, importWorkspace, setupState } from './workspace.js';
import { createStateBackup, releaseRestoredLeases, restoreStateBackup } from './state-backup.js';
import { cancelWork, formatCancel } from './controls.js';
import { ack, counts as outboxCounts, enqueue, fail, formatCounts, formatItems, pending, type OutboxCounts } from './outbox.js';
import { digestStatus, holdFor, humanDigest, humanDigestStatus, prepareDigest, reholdExpired, type DigestStatus } from './digest.js';
import { git, workspaceLayout } from './worktree.js';
import { containerPaths } from '../core/paths.js';
import { formatWorkProbe, workProbe } from './sandbox/probe.js';
import { containerProtectedPaths } from './sandbox/rules.js';
import { cachedSandboxSelfTest, containerRealTargets, probeIdentity, runSandboxSelfTest } from './sandbox/selftest.js';
import { SANDBOX_BIN } from './sandbox/rules.js';
import { HARNESS_PROMPTS_DIR } from '../plugin/generate.js';
import { PROCESS_ADAPTERS } from './runner/adapters.js';
import { reapRun, recoverRuns, runLease, type ReapDeps, type RecoverySweep, type RunOutput } from './runner/run.js';
import { hasOpenRun, isAlive, openRunsSync, procIdentity, withOpenRuns } from './runner/record.js';
import { clearHold, DISPATCH_HOLDER, dispatcherLockState, dispatchMode, readHolds, runDispatcher, type DispatchHold } from './dispatcher.js';
import { launchWorker } from './dispatch-launch.js';
import { liveRun, liveRunExitCode, type LiveRunReport } from './headless.js';
import { buildSessionCommand, sessionConfigDir, sessionsSettings } from './sessions.js';
import { enqueueInbox, openSession } from './session-store.js';
import { heldBySession, recordSent, resolveRoute, sendToSession, sessionKeyOf, waitForOutbound, type RouteResult, type WaitResult } from './router.js';
import { runSupervisor, startSupervisorWatch, supervisorEnv, supervisorLockState, type SupervisorReport, type SupervisorTaskDeps } from './supervisor.js';
import { adoptIntegrationBase, runIntegrator, startIntegratorDetached, type IntegratorReport } from './integrator.js';
import { collectIntegrationStatus, humanIntegration, kickInputs, kickIntegratorIfNeeded, startIntegrationWatch, type IntegrationStatus } from './integration-status.js';
import { verifyAnyApproval } from '../core/approval.js';
import { recoverTaskSession, taskSessionPass, type TaskSessionDeps } from './task-sessions.js';

/** Human output of `minions work next`. */
export function humanNext(r: NextReport): string {
  const line = (x: NextStage) => x.launch.kind === 'run'
    ? `  ${x.taskId} ${x.role} -> claim, then ${x.launch.command} (${x.launch.harness}, model ${x.launch.model}${x.launch.deep ? ', deep' : ''}): ${x.reason}`
    : `  ${x.taskId} ${x.role} -> ${x.agentType}${x.agentModel ? ` (model ${x.agentModel})` : ''}: ${x.reason}`;
  return [
    r.message,
    ...r.runnable.map(line),
    ...(r.waiting.length ? ['waiting:', ...r.waiting.map((w) => `  ${w.taskId} ${w.role}: ${w.why}`)] : []),
    ...(r.stuck.length ? ['stuck:', ...r.stuck.map((t) => `  ${t.taskId} (${t.status}): ${t.reason}`)] : []),
    ...(r.warnings ?? []).map((w) => `warning: ${w}`),
  ].join('\n');
}

// ---------------------------------------------------------------- lazy runtime context

let db: RuntimeDb | undefined;
let config: MinionsConfig | undefined;
let backlog: BacklogAdapter | undefined;

const getDb = (): RuntimeDb => (db ??= openDb(runtimePaths().db));
/** Drops the cached DB and backlog handles (a state restore swaps the files under them). */
function resetRuntimeHandles(): void {
  db?.close();
  db = undefined;
  backlog = undefined;
}

/** Effective config from MINIONS_CONFIG (default /opt/minions/config/config.json), strictly validated. */
export async function loadRuntimeConfig(path = runtimePaths().configJson): Promise<MinionsConfig> {
  return withControl(validateConfig(await readJson(path), path), runtimePaths().state);
}
async function getConfig(): Promise<MinionsConfig> { return (config ??= await loadRuntimeConfig()); }

/** DB-backed idempotency store that opens the DB on first use. */
const lazyIdempotency: IdempotencyStore = {
  get: (key) => getDb().idempotency.get(key),
  put: (key, taskId) => getDb().idempotency.put(key, taskId),
};

async function getBacklog(): Promise<BacklogAdapter> {
  return (backlog ??= openBacklog(await getConfig(), { idempotency: lazyIdempotency, root: runtimePaths().backlog, provenanceFallback: intakeProvenanceFallback(getDb) }));
}

async function context() {
  const cfg = await getConfig();
  return { config: cfg, db: getDb(), backlog: await getBacklog() };
}

/** Records a requested coordinator restart: last one in meta (as `sync` does) and a `coordinator-restart` event. */
export const coordinatorRestartRecorder = (d: RuntimeDb) => (info: { at: string; reason: string; leases: string[]; recover?: boolean }): void => {
  d.setMeta('coordinator_restart', JSON.stringify(info));
  d.addEvent('coordinator-restart', null, info);
};

/** One intake pass with the runtime context (`minions sync` and coordinator startup). */
export async function runIntakeSync(opts: { signal?: AbortSignal; gh?: GhFn } = {}): Promise<IntakeSyncReport> {
  const { db: d, backlog: b, config: cfg } = await context();
  return syncIntake({ db: d, backlog: b, config: cfg, originRepository: () => originRepository(workspaceLayout().repo, git), ...opts });
}

/** Overall time budget of the startup intake pass (`minions sync` keeps the per-call gh timeout). */
export const STARTUP_INTAKE_BUDGET_MS = 25_000;
/** Extra wait after the abort for the pass to save its state before the coordinator starts anyway. */
const STARTUP_INTAKE_GRACE_MS = 2_000;

/**
 * Coordinator startup: one intake pass when intake.github is enabled. Bounded by `budgetMs`: the pass
 * is aborted (in-flight gh children are killed on the abort, SIGTERM then SIGKILL after 2 s; also when
 * `stop` aborts) and, should it still not return, the coordinator
 * starts without waiting for it; the next `minions sync` completes the import.
 */
export const intakeOnStart = async (
  cfg: MinionsConfig, log: (line: string) => void,
  sync: (opts: { signal: AbortSignal; gh?: GhFn }) => Promise<IntakeSyncReport> = runIntakeSync,
  budgetMs = STARTUP_INTAKE_BUDGET_MS,
  /** Aborted by the wrapper on a signal before claude starts (task-38): the pass is aborted with it. */
  stop?: AbortSignal,
): Promise<void> => {
  if (!cfg.intake.github?.enabled || stop?.aborted) return;
  const ctl = new AbortController();
  const onStop = () => ctl.abort();
  stop?.addEventListener('abort', onStop, { once: true });
  const timers: NodeJS.Timeout[] = [];
  const late = new Promise<null>((resolve) => {
    timers.push(setTimeout(() => ctl.abort(), budgetMs));
    timers.push(setTimeout(() => resolve(null), budgetMs + STARTUP_INTAKE_GRACE_MS));
  });
  // The gh children share the pass signal: the budget abort and the pre-spawn guard (`stop`) kill them.
  const pass = sync({ signal: ctl.signal, gh: ghWithTimeout(budgetMs, ctl.signal) });
  pass.catch(() => { /* reported below when it settles in time; ignored after the start */ });
  try {
    const r = await Promise.race([pass, late]);
    if (r) log(`minions: ${formatIntake(r).split('\n').join('\nminions: ')}`);
    else log(`minions: intake sync did not finish within ${Math.round(budgetMs / 1000)} s; starting the coordinator without it (run \`minions sync\` later)`);
  } finally {
    stop?.removeEventListener('abort', onStop);
    ctl.abort();
    for (const t of timers) clearTimeout(t);
  }
};

/** reapRun in production: the real /proc, including the escapee sweep (agent-runtimes D3b). */
const reapDeps = (): ReapDeps => ({ db: getDb(), paths: runtimePaths(), env: process.env, escapees: {} });
const scheduler = async () => new Scheduler({
  ...(await context()), layout: workspaceLayout(), handoff: runtimePaths(),
  runs: { state: runtimePaths().state, reap: (leaseId) => reapRun(leaseId, reapDeps()) },
});

/**
 * Restarts count process runs that are not `done` as running workers (D3b). Records whose lease already ended
 * are reaped first (the result is logged to stderr); what is left counts.
 */
async function restartWorkers(d: RuntimeDb, o: { exceptSessions?: boolean } = {}): Promise<() => { id: string }[]> {
  const r = await recoverRuns(reapDeps(), 'orphans');
  logRecovery(r, (line) => process.stderr.write(line + '\n'));
  const all = withOpenRuns(() => d.activeLeases(), runtimePaths().state); // contextResetCheck counts the same way
  return leaseBlockers(d, all, o);
}

/** `notify enqueue --session`, else MINIONS_SESSION (a task or the general session; the router and none record null). */
function notifySession(explicit: string | undefined): string | null {
  if (explicit !== undefined) {
    const k = sessionKeyOf(explicit);
    if (!k) throw new MinionsError('PRECONDITION', `Not a session key: ${JSON.stringify(explicit.slice(0, 120))}.`, 'Use general or task:<task id>.');
    return k;
  }
  const scope = sessionScope();
  return scope && scope.kind !== 'router' ? scope.key : null;
}

/**
 * With coordinator sessions on (task-57 phase 8) the coordinator is the router: leases held by a headless session run
 * under the supervisor, so they never block a router restart, reset or digest wake. Live runs still count every lease.
 */
export function leaseBlockers<T extends { id: string }>(d: Pick<RuntimeDb, 'lease'>, leases: () => T[], o: { exceptSessions?: boolean } = {}): () => T[] {
  // The dispatcher's workers (docs/design/autonomy.md Decision 1) are never the coordinator's: they run on without it.
  return () => leases().filter((l) => {
    const holder = d.lease(l.id.split(' ')[0]!)?.holder;
    return holder !== DISPATCH_HOLDER && !(o.exceptSessions && heldBySession(holder));
  });
}

/** `minions sync`: intake (full sync only), then PR/CI observations with the auto-merge pass (the runtime's own gates). */
async function fullSync(taskIds: string[] = []): Promise<{ report: SyncReport; intake: IntakeSyncReport | null }> {
  const { db: d, backlog: b, config: cfg } = await context();
  // Intake runs on a full sync only (`minions sync <taskIds>` refreshes just those PRs).
  const intake = taskIds.length ? null : await runIntakeSync();
  const sched = await scheduler();
  return { report: await syncTasks({ db: d, backlog: b, config: cfg, merge: (id) => sched.autoMerge(id) }, { taskIds }), intake };
}

/** How the coordinator stands: a live lock holder, a dead one, the exit record and the last recorded restart. */
export async function coordinatorView(d: RuntimeDb, paths = runtimePaths()): Promise<CoordinatorView> {
  const lock = d.coordinatorLock();
  const running = !!lock && coordinatorPidAlive(lock.pid, lock);
  const exit = await readExitRecord(paths);
  let lastRestartAt: string | null = null;
  try { lastRestartAt = (JSON.parse(d.getMeta('coordinator_restart') ?? 'null') as { at?: string } | null)?.at ?? null; } catch { lastRestartAt = null; }
  return { running, lockAcquiredAt: running ? lock!.acquiredAt : null, staleLock: !!lock && !running, exit: exit ? { at: exit.at, code: exit.code, ...(exit.error ? { error: exit.error } : {}) } : null, lastRestartAt };
}

/** An upgrade the host is applying right now (a confirmed upgrade change request), or null. */
function upgradeInProgress(d: RuntimeDb): string | null {
  try { const u = listChangeRequests(d).find((r) => r.kind === 'upgrade' && r.status === 'confirmed'); return u ? `change request ${u.id}` : null; } catch { return null; }
}

/** The routine pass with the runtime context: real gh, git, process table and detached restarts. */
async function routineDeps(): Promise<Parameters<typeof runRoutinePass>[0]> {
  const d = getDb();
  const cfg = await getConfig();
  const paths = runtimePaths();
  const all = withOpenRuns(() => d.activeLeases(), paths.state);
  const leases = () => leaseBlockers(d, all, { exceptSessions: sessionsSettings(cfg).enabled })().map((l) => l.id);
  const log = join(paths.logs, 'routine.log');
  return {
    db: d, config: cfg, now: () => new Date(), procStart: procStartTime,
    lockAlive: (l) => pidAlive(l.pid) && (!l.start || procStartTime(l.pid) === l.start),
    sync: async () => { const r = await fullSync(); return summarizeSync(r.report, r.intake); },
    next: async () => (await scheduler()).next(),
    coordinator: () => coordinatorView(d, paths),
    activeLeases: async () => leases(),
    budgetExhausted: () => { try { return currentBudget({ db: d, config: cfg })?.exhausted ?? false; } catch { return false; } },
    upgradeInProgress: () => upgradeInProgress(d),
    digestDue: (now) => digestStatus(d, cfg, now).due,
    holdBack: (now) => reholdExpired(d, cfg, now),
    // Never with force: scheduleDetachedRestart refuses with an active lease or a drain (and the detached restart checks again).
    wake: async () => scheduleDetachedRestart({ activeLeases: () => leases().map((id) => ({ id })), drain: () => d.drain(), log, cwd: paths.state }, { wake: true }).reason,
    crashStart: async () => scheduleCrashStart({ drain: () => d.drain(), upgrade: () => upgradeInProgress(d), log, cwd: paths.state }).reason,
    // Sessions on (task-57 phase 7): runnable stages open task sessions, under the same limits as the supervisor's pass.
    openTaskSessions: () => taskSessionPass(taskSessionDeps(cfg)),
  };
}

/**
 * The task session pass (task-57 phase 7) with the runtime context and the given config: `work next` and the backlog
 * through a scheduler built on that config (the supervisor re-reads it), the owner budget and an upgrade in progress.
 */
function taskSessionDeps(cfg: MinionsConfig): TaskSessionDeps {
  const d = getDb();
  const paths = runtimePaths();
  const b = openBacklog(cfg, { idempotency: lazyIdempotency, root: paths.backlog, provenanceFallback: intakeProvenanceFallback(getDb) });
  const sched = new Scheduler({ config: cfg, db: d, backlog: b, layout: workspaceLayout(), handoff: paths, runs: { state: paths.state, reap: (leaseId) => reapRun(leaseId, reapDeps()) } });
  return {
    db: d, config: cfg, state: paths.state,
    runnable: async () => { try { return (await sched.next()).runnable.map((st) => ({ taskId: st.taskId, role: st.role })); } catch { return null; } },
    tasks: async () => { try { return await b.listTasks(); } catch { return null; } },
    budgetExhausted: () => { try { return currentBudget({ db: d, config: cfg })?.exhausted ?? false; } catch { return false; } },
    upgradeInProgress: () => upgradeInProgress(d),
  };
}

/** The supervisor's task session deps: the pass, and per-task recovery (submission files, Scheduler.release). */
export function supervisorTaskDeps(): SupervisorTaskDeps {
  return {
    pass: (cfg) => taskSessionPass(taskSessionDeps(cfg)),
    recover: async (key) => recoverTaskSession(getDb(), key, {
      hasSubmission: async (leaseId) => existsSync(submissionPath(runtimePaths(), leaseId)),
      release: async (leaseId, reason) => (await scheduler()).release(leaseId, reason),
    }),
  };
}

/** Bound of one clock pass (the child process is killed after it). */
export const ROUTINE_PASS_TIMEOUT_MS = 5 * 60_000;

/** The wrapper clock: each tick runs `minions sync --routine --trigger clock` as a bounded child (fresh config, own DB handle). */
export function wrapperRoutineClock(log: (line: string) => void): () => void {
  return startRoutineClock({
    settings: async () => routineSettings(await loadRuntimeConfig()),
    run: async () => {
      const env = { ...process.env };
      delete env[TELEGRAM_TOKEN_ENV]; // the pass never needs the bot token
      const r = await runChild('minions', ['sync', '--routine', '--trigger', 'clock', '--json'], { allowFailure: true, timeoutMs: ROUTINE_PASS_TIMEOUT_MS, env, cwd: runtimePaths().state, maxOutputBytes: 1024 * 1024 });
      if (r.timedOut) log(`minions: routine pass timed out after ${ROUTINE_PASS_TIMEOUT_MS / 60_000} min`);
    },
    log,
  });
}

/** Starts `minions work integrate` detached (output in <logs>/integration/integrator.log), as Scheduler.record does. */
function startIntegrator(): number | null {
  const paths = runtimePaths();
  return startIntegratorDetached({ log: join(paths.logs, 'integration', 'integrator.log'), cwd: paths.repo });
}

/**
 * The wrapper's integration backstop (task-82.4): every minute (and at the start, which covers
 * `coordinator restart --recover`), starts the local integrator when queued integrations have no live holder.
 * The config is re-read each check (delivery.merge and base.merge are live settings).
 */
export function wrapperIntegrationWatch(_cfg: MinionsConfig, log: (line: string) => void): () => void {
  return startIntegrationWatch({ decide: async () => kickInputs(getDb(), await loadRuntimeConfig()), start: startIntegrator, say: log });
}

/**
 * The wrapper's session supervisor watch (task-57 phase 5): with coordinator.sessions.enabled it starts
 * `minions coordinator supervise` detached and again whenever its lock is stale; with sessions off it does nothing.
 */
export function wrapperSupervisorWatch(cfg: MinionsConfig, log: (line: string) => void): () => void {
  const paths = runtimePaths();
  return startSupervisorWatch(cfg, { state: paths.state, log: join(paths.logs, 'supervisor.log'), tmp: paths.tmp, lockState: () => supervisorLockState(getDb()), say: log });
}

/**
 * A dispatcher hold reaches the coordinator (docs/design/autonomy.md Decision 1): with sessions on, the task's own
 * session gets it in its inbox (and is opened); otherwise the routine's wake reasons and the Stop hook pick up the
 * `dispatch-decision` event and the hold itself.
 */
function notifyHold(d: RuntimeDb, hold: DispatchHold, cfg: MinionsConfig): void {
  if (!sessionsSettings(cfg).enabled) return;
  const key = `task:${hold.taskId}`;
  const paths = runtimePaths();
  openSession(d, key, { configDir: sessionConfigDir(paths, key) });
  enqueueInbox(d, key, DISPATCH_HOLDER, `minions dispatcher: ${hold.taskId} needs your decision (${hold.kind}): ${hold.message}${hold.errors?.length ? `\nerrors:\n${hold.errors.map((e) => `- ${e}`).join('\n')}` : ''}\nHandle it (claim, update or split the task), then \`minions work autopilot resume ${hold.taskId}\` if the status did not change.`);
}

/** The wrapper's dispatcher watch: with dispatch.mode auto (re-read every check: the mode is live) it keeps `minions work dispatch` running. */
export function wrapperDispatchWatch(_cfg: MinionsConfig, log: (line: string) => void): () => void {
  const paths = runtimePaths();
  let lastStart = -Infinity;
  const check = async () => {
    try {
      if (dispatchMode(await loadRuntimeConfig()) !== 'auto') return;
      const s = dispatcherLockState(getDb());
      if (s.state === 'live' || Date.now() - lastStart < 30_000) return;
      lastStart = Date.now();
      const pid = spawnDetachedMinions(['work', 'dispatch'], { cwd: paths.state, log: join(paths.logs, 'dispatcher.log'), env: supervisorEnv(process.env, paths.tmp) });
      log(`minions: started the dispatcher (pid ${pid ?? '?'}; output: ${join(paths.logs, 'dispatcher.log')})`);
    } catch (e) { log(`minions: could not start the dispatcher: ${redact((e as Error).message).slice(0, 300)}`); }
  };
  void check();
  const h = setInterval(() => { void check(); }, 20_000);
  h.unref?.();
  return () => clearInterval(h);
}

/** Spawns `minions <args>` detached with output appended to `log`; returns its pid. */
function spawnDetachedMinions(args: string[], o: { cwd: string; log: string; env: Record<string, string> }): number | null {
  mkdirSync(dirname(o.log), { recursive: true });
  const fd = openSync(o.log, 'a', 0o600);
  try {
    const child = nodeSpawn('minions', args, { cwd: o.cwd, detached: true, stdio: ['ignore', fd, fd], env: o.env });
    child.on('error', () => { /* the next check sees no live lock and tries again */ });
    child.unref();
    return child.pid ?? null;
  } finally { try { closeSync(fd); } catch { /* the child holds its own copy */ } }
}

function logRecovery(r: RecoverySweep, log: (line: string) => void): void {
  for (const x of r.reaped) log(`minions: process run ${x.leaseId}: ${x.action}${x.note ? ` (${x.note})` : ''}`);
  for (const e of r.errors) log(`minions: could not reap the process run of ${e.leaseId}: ${e.error}`);
}

async function readInput(file?: string, what = 'the worker result', hint = 'Pipe the JSON in, pass --result-file <path>, or (record) use --submitted.'): Promise<string> {
  if (file && file !== '-') return readFile(file, 'utf8');
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', `Expected ${what} on stdin.`, hint);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const leaseLine = (l: Lease) => `${l.id}  ${l.task_id.padEnd(10)} ${l.role.padEnd(9)} #${l.attempt} ${l.status.padEnd(11)} ${l.branch ?? '-'}  ${l.worktree ?? '-'}`;

// ---------------------------------------------------------------- status

export interface StatusReport {
  paused: { intake: boolean; starts: boolean };
  /** Last event that set each pause flag (event id + time); `minions upgrade` uses it to recognize its own pause. */
  pauseChanges: { intake: PauseChange | null; starts: PauseChange | null };
  /** Active drain request (`minions pause --starts --drain`): leased workers wind down and return partial results. */
  draining: DrainRequest | null;
  /** The last drain notice the worker hook delivered (task-3.10): proof the '*' PreToolUse hook fired in a subagent with agent_id/agent_type. */
  lastDrainNotice?: DrainNotice | null;
  configRevision: number;
  profile: string;
  deliveryMode: string;
  queue: Record<string, number>;
  activeLeases: Pick<Lease, 'id' | 'task_id' | 'role' | 'attempt' | 'branch' | 'worktree' | 'head_sha' | 'started_at'>[];
  /** byRole: lease usage per worker role (`limited` = an execution.maxByRole / maxEngineers limit applies). */
  capacity: { activeTasks: number; maxActiveTasks: number; activeEngineers: number; maxEngineers: number; byRole: Record<string, RoleCapacity> } | null;
  guard: { lastReason: string | null; updatedAt: string | null };
  coordinatorLock: unknown;
  /** communication.channel: configured vs effective (running coordinator's launch decision, else predicted). */
  channel?: ChannelStatus;
  /** Running coordinator vs the current launch fingerprint (stale: restart required; the host reports `minions upgrade`). */
  coordinatorLaunch?: LaunchStatus;
  /** Task-51: whether the Telegram poller (bot.pid) is the running coordinator's; another claude session can take the bot. */
  telegramPoller?: PollerCheck;
  /** Notification outbox: undelivered items wait here until the coordinator sends them (`minions notify pending`). */
  notifications?: OutboxCounts;
  /** Spend tally (tokens; estimated USD with API-key billing) and the owner budget (src/runtime/spend.ts). */
  spend?: SpendReport;
  /** Routine context resets (coordinator.contextReset; src/runtime/context-reset.ts): triggers and blockers for this session. */
  contextReset?: Omit<ContextResetCheck, 'steps'>;
  /** The unattended routine (task-68.2): settings, the last pass and the next one (src/runtime/routine.ts). */
  routine?: RoutineLast;
  /** The owner digest (task-68.5): its times, the last one and whether it was sent, held items. */
  digest?: DigestStatus;
  /** Open change requests (proposed, confirmed, failed) waiting for the host: the manager or `minions settings apply`. */
  changeRequests?: { open: number; items: { id: string; kind: string; status: string; summary: string; createdAt: string }[] };
  /** The local integrator (local delivery; docs/design/local-auto-integration.md): lock, current run, queue, last result, problems. */
  integration?: IntegrationStatus;
  backlogError?: string;
}

export interface ChannelStatus {
  configured: MinionsConfig['communication']['channel'];
  effective: 'terminal' | 'telegram';
  reason: string;
  /** launch: decided by the running coordinator; predicted: no launch recorded (the probe runs at launch). */
  source: 'launch' | 'predicted';
  /** The running coordinator was launched with another channel setting: `minions upgrade`. */
  restartRequired?: boolean;
}

/** Channel status inside the runtime: the launch record when the coordinator ran, else a prediction from the mounted token. */
export async function runtimeChannelStatus(cfg: MinionsConfig, paths = runtimePaths()): Promise<ChannelStatus> {
  const rec = await readLaunchRecord(paths);
  if (rec) {
    return {
      configured: cfg.communication.channel, effective: rec.telegram.enabled ? 'telegram' : 'terminal', reason: rec.telegram.reason, source: 'launch',
      ...(rec.channel !== cfg.communication.channel ? { restartRequired: true } : {}),
    };
  }
  const r = resolveChannel(cfg.communication.channel, runtimeChannelFacts(cfg, await readMountedToken(paths.telegramTokenFile), undefined));
  return { configured: r.configured, effective: r.effective, reason: r.reason, source: 'predicted' };
}

export async function collectStatus(deps: { db: RuntimeDb; config: MinionsConfig; state?: string; backlog: () => Promise<BacklogAdapter>; channel?: () => Promise<ChannelStatus>; launch?: () => Promise<LaunchStatus>; poller?: () => Promise<PollerCheck>;
  /** The local integrator's block (the CLI passes collectIntegrationStatus for /workspace/repo); omitted: no block. */
  integration?: (tasks: Task[] | null) => Promise<IntegrationStatus | null> }): Promise<StatusReport> {
  const { db: d, config: cfg } = deps;
  const leases = d.activeLeases();
  const report: StatusReport = {
    paused: d.paused(), pauseChanges: d.pauseChanges(), draining: d.drain(), configRevision: cfg.configRevision, profile: cfg.profile, deliveryMode: cfg.delivery.mode,
    queue: {}, capacity: null,
    activeLeases: leases.map((l) => ({ id: l.id, task_id: l.task_id, role: l.role, attempt: l.attempt, branch: l.branch, worktree: l.worktree, head_sha: l.head_sha, started_at: l.started_at })),
    guard: { lastReason: d.guard().last_reason, updatedAt: d.guard().updated_at },
    coordinatorLock: d.coordinatorLock() ?? null,
  };
  try { report.lastDrainNotice = d.lastDrainNotice(); } catch { /* status never fails on it */ }
  if (deps.channel) report.channel = await deps.channel().catch(() => undefined);
  if (deps.launch) report.coordinatorLaunch = await deps.launch().catch(() => undefined);
  if (deps.poller) report.telegramPoller = await deps.poller().catch(() => undefined);
  try { report.notifications = outboxCounts(d); } catch { /* an older DB without the outbox: omit */ }
  try {
    const open = listChangeRequests(d);
    report.changeRequests = { open: open.length, items: open.slice(0, CHANGE_REQUESTS_SHOWN).map((r) => ({ id: r.id, kind: r.kind, status: r.status, summary: r.summary, createdAt: r.createdAt })) };
  } catch { /* an older DB without change requests: omit */ }
  try { report.spend = spendReport({ db: d, config: cfg }); } catch { /* status never fails on the tally */ }
  try { report.routine = routineLast(d, cfg); } catch { /* status never fails on the routine */ }
  try { if (cfg.routine?.enabled) report.digest = digestStatus(d, cfg); } catch { /* status never fails on the digest */ }
  try { const { steps: _s, ...c } = contextResetCheck({ db: d, config: cfg, ...(deps.state !== undefined ? { state: deps.state } : {}) }); report.contextReset = c; } catch { /* status never fails on the reset check */ }
  let tasks: Task[] | null = null;
  try {
    tasks = await (await deps.backlog()).listTasks();
    for (const t of tasks) report.queue[t.status] = (report.queue[t.status] ?? 0) + 1;
    const cap = capacityOf(cfg, leases, tasks);
    report.capacity = { activeTasks: cap.activeTaskIds.length, maxActiveTasks: cap.maxActiveTasks, activeEngineers: cap.activeEngineers, maxEngineers: cap.maxEngineers, byRole: cap.byRole };
  } catch (e) {
    report.backlogError = (e as Error).message;
  }
  if (deps.integration) {
    try { const i = await deps.integration(tasks); if (i) report.integration = i; } catch { /* status never fails on the integration block */ }
  }
  return report;
}

/** Per-role usage for humanStatus: limited roles as active/max, the others as an active count (bounded by the task limit). */
function roleCapacityLine(c: NonNullable<StatusReport['capacity']>): string {
  const roles = c.byRole ? Object.entries(c.byRole) : [];
  if (!roles.length) return `${c.activeEngineers}/${c.maxEngineers} engineers`;
  return roles.map(([r, x]) => (x.limited ? `${x.active}/${x.max} ${r}` : `${x.active} ${r}`)).join(', ');
}

export function humanStatus(s: StatusReport): string {
  const out = [
    `config revision ${s.configRevision}  profile ${s.profile}  delivery ${s.deliveryMode}`,
    `paused: intake=${s.paused.intake} starts=${s.paused.starts}`,
    ...(s.draining ? [`draining: ${s.draining.reason} since ${s.draining.requestedAt} (${s.activeLeases.length} lease(s) winding down)`] : []),
    ...(s.lastDrainNotice ? [`last drain notice: ${s.lastDrainNotice.at} to ${s.lastDrainNotice.agentType} ${s.lastDrainNotice.agentId} (lease ${s.lastDrainNotice.leaseId}, ${s.lastDrainNotice.taskId ?? '-'}, drain event ${s.lastDrainNotice.eventId}, via ${s.lastDrainNotice.via})`] : []),
    ...(s.channel ? [`channel: configured ${s.channel.configured}, effective ${s.channel.effective} (${s.channel.source === 'launch' ? 'running coordinator' : 'predicted'}: ${s.channel.reason})${s.channel.restartRequired ? '; restart required: `minions upgrade`' : ''}`] : []),
    ...(s.telegramPoller && s.telegramPoller.state !== 'not-applicable' ? [humanPoller(s.telegramPoller)] : []),
    s.capacity ? `capacity: ${s.capacity.activeTasks}/${s.capacity.maxActiveTasks} tasks, ${roleCapacityLine(s.capacity)}` : 'capacity: unknown',
    `queue: ${Object.entries(s.queue).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)'}`,
    `stop guard: ${s.guard.lastReason ?? '-'}`,
    ...(s.notifications?.pending ? [formatCounts(s.notifications)] : []),
    ...(s.changeRequests?.open ? humanChangeRequests(s.changeRequests) : []),
    ...(s.spend ? humanSpend(s.spend).split('\n') : []),
    ...(s.contextReset?.enabled ? [humanContextReset(s.contextReset)] : []),
    ...(s.routine ? [humanRoutine(s.routine)] : []),
    ...(s.digest ? [humanDigestStatus(s.digest)] : []),
    ...(s.integration ? humanIntegration(s.integration) : []),
  ];
  if (s.backlogError) out.push(`backlog error: ${s.backlogError}`);
  out.push(s.activeLeases.length ? 'active leases:' : 'active leases: none', ...s.activeLeases.map((l) => `  ${l.id} ${l.task_id} ${l.role} #${l.attempt} ${l.branch ?? ''}`));
  return out.join('\n');
}

const CHANGE_REQUESTS_SHOWN = 10;

/** Change requests in `minions status`: they wait in the runtime until the host manager (or the terminal) handles them. */
function humanChangeRequests(c: NonNullable<StatusReport['changeRequests']>): string[] {
  const line = (v: string, max: number) => truncateCodePoints(displayText(v).replace(/\s+/g, ' '), max);
  return [
    `change requests: ${c.open} open (the host manager offers them; on the host: \`minions settings requests\`, \`settings apply <id>\`)`,
    ...c.items.map((r) => `  ${line(r.id, 20)} ${line(r.status, 12)} ${line(r.summary, 160)}`),
    ...(c.open > c.items.length ? [`  … ${c.open - c.items.length} more`] : []),
  ];
}

/** One status line for the Telegram poller; a problem carries the recovery hint. */
export function humanPoller(p: PollerCheck): string {
  return `telegram poller: ${p.state === 'ok' ? 'ok' : `PROBLEM (${p.state})`}: ${p.detail}${p.hint ? `\n  hint: ${p.hint}` : ''}`;
}

export interface PauseOptions { intake?: boolean; starts?: boolean; drain?: boolean; reason?: string }

/**
 * `minions pause|resume`. Without flags both intake and starts change. `pause --drain` pauses starts
 * (keeping an existing pause and its event) and records a drain request; `resume --drain` only clears
 * the drain; resuming starts always clears it too.
 */
export function pauseControl(d: RuntimeDb, paths: { drainFlag: string }, name: 'pause' | 'resume', o: PauseOptions) {
  const value = name === 'pause';
  let paused = d.paused();
  if (o.drain) {
    if (value) paused = requestDrain(d, paths, o.reason?.trim() || 'manual').paused;
    else clearDrain(d, paths, 'resume --drain');
    if (o.intake || (!value && o.starts)) paused = d.setPaused({ intake: o.intake ? value : undefined, starts: !value && o.starts ? false : undefined });
  } else {
    if (o.reason !== undefined) throw new MinionsError('PRECONDITION', '--reason is only used with --drain.');
    const both = !o.intake && !o.starts;
    const starts = both || o.starts ? value : undefined;
    paused = d.setPaused({ intake: both || o.intake ? value : undefined, starts });
    if (starts === false) clearDrain(d, paths, 'resume --starts');
  }
  return { paused, pauseChanges: d.pauseChanges(), draining: d.drain() };
}

/** Host CLI: run the same command in the project runtime (container or host runtime) and exit with its code. */
/**
 * Relays the container's `minions status --json` output the host cannot use as a report. Human mode shows an
 * `ok:false` envelope as a formatted error (message and hint); everything else is passed through with control
 * characters stripped. The container's exit code is kept (1 when it reported none).
 */
export function relayRawStatus(result: { code: number; stdout: string; stderr: string }, opts: { json: boolean }): void {
  const env = opts.json ? null : parseErrorEnvelope(result.stdout);
  if (env) {
    const known = Object.hasOwn(EXIT_CODES, env.code) ? env.code as ErrorCode : 'INTERNAL';
    reportError(new MinionsError(known, env.message, env.hint), { json: false });
  } else {
    if (result.stdout) process.stdout.write(stripControlChars(result.stdout));
    if (result.stderr) process.stderr.write(stripControlChars(result.stderr));
  }
  process.exitCode = result.code || 1;
}

async function delegate(cmd: Command): Promise<void> {
  const code = await delegateToRuntime(process.argv.slice(2), { json: globalOpts(cmd).json });
  process.exit(code);
}

// ---------------------------------------------------------------- spend

const USAGE_HELP = 'the worker\'s token total from the task notification (subagent_tokens; cumulative, the latest figure per lease counts)';

function usageFlag(o: { usage?: string; model?: string }): UsageFlag | undefined {
  if (o.usage === undefined) {
    if (o.model !== undefined) throw new MinionsError('PRECONDITION', '--model is only used with --usage.');
    return undefined;
  }
  return { tokens: parseTokens(o.usage), model: o.model ?? null };
}

/**
 * Default id for `work spend --session`: the Claude session the Stop hook saw in the current coordinator
 * session (so a figure set by hand overrides that session's measured one instead of adding to it), else
 * the lock session name.
 */
export function currentSessionKey(d: RuntimeDb): string {
  const lock = d.coordinatorLock();
  try {
    const t = JSON.parse(d.getMeta(TRANSCRIPT_META) ?? 'null') as { sessionId?: string | null; at?: string } | null;
    if (t?.sessionId && lock && t.at && t.at >= lock.acquiredAt) return t.sessionId;
  } catch { /* unreadable: fall back */ }
  return lock?.session ?? 'coordinator';
}

/** `minions work spend`: optional budget change and usage record, then the spend report. */
export async function spendCommand(o: { budget?: string; by?: string; lease?: string; session?: string | boolean; tokens?: string; model?: string },
  deps: { db?: RuntimeDb; config?: MinionsConfig } = {}): Promise<SpendReport & { notice?: string }> {
  const d = deps.db ?? getDb();
  const cfg = deps.config ?? await getConfig();
  const ctx = { db: d, config: cfg };
  if ((o.lease || o.session) && o.tokens === undefined) throw new MinionsError('PRECONDITION', '--lease and --session need --tokens <n>.');
  if (o.tokens !== undefined && !o.lease && !o.session) throw new MinionsError('PRECONDITION', '--tokens needs --lease <leaseId> or --session.');
  if (o.lease && o.session) throw new MinionsError('PRECONDITION', 'Use --lease or --session, not both.');
  if (o.by !== undefined && o.budget === undefined) throw new MinionsError('PRECONDITION', '--by is only used with --budget.');
  if (o.budget !== undefined) setBudget(ctx, o.budget, o.by ?? null);
  if (o.tokens !== undefined) {
    const u = { tokens: parseTokens(o.tokens), model: o.model ?? null, source: 'manual' as const };
    if (o.lease) recordLeaseUsage(d, o.lease, u);
    else recordSessionUsage(d, typeof o.session === 'string' ? o.session : currentSessionKey(d), u);
  }
  const notice = o.tokens !== undefined || o.budget !== undefined ? budgetNotice(ctx)?.message : undefined;
  return { ...spendReport(ctx), ...(notice ? { notice } : {}) };
}

// ---------------------------------------------------------------- context reset

const resetLine = (d: { contextReset?: { reason: string } }) => (d.contextReset ? [d.contextReset.reason] : []);

// ---------------------------------------------------------------- register

/** Registers runtime commands on the root program. */
export function register(program: Command): void {
  if (runtimeMode() !== 'host') {
    // Give `backlog ...` the lease/pause view and DB-backed idempotency (lazy: no DB opened until used).
    setIdempotencyStore(lazyIdempotency);
    setReadyContext(() => {
      const d = getDb();
      return { leased: new Set(d.activeLeases().map((l) => l.task_id)), paused: d.paused().starts };
    });
    setIntakePausedContext(() => getDb().paused().intake);
    setProvenanceFallback(intakeProvenanceFallback(getDb));
  }

  // control (docs/design/autonomy.md Decision 3): the coordinator-owned config overlay, applied at once
  const control = program.command('control').description('Coordinator-owned configuration: change any setting, role (worker profile) or workflow at once, without the owner (journaled; undo with `control undo`)');
  const controlDeps = async () => {
    requireMode('runtime');
    const paths = runtimePaths();
    return { state: paths.state, base: validateConfig(await readJson(paths.configJson), paths.configJson), actor: process.env.MINIONS_SESSION ? `coordinator (${process.env.MINIONS_SESSION})` : 'coordinator' };
  };
  const humanChange = (c: ControlChange) => [c.message, ...c.keys.map((k) => `  ${k.key}: ${k.appliesOn}${k.hostOwned ? ' (host-owned: the owner is notified)' : ''}`)].join('\n');
  const noticeHostOwned = (c: ControlChange, reason: string) => {
    const owned = c.keys.filter((k) => k.hostOwned).map((k) => k.key);
    if (owned.length) enqueue(getDb(), { key: `control-${c.revision}`, kind: 'status', text: `Coordinator changed ${owned.join(', ')} (control revision ${c.revision}): ${reason}. Undo: minions control undo ${c.revision}` });
  };
  control.command('show').description('The overlay, its revision, and the effective value of every key it sets')
    .action(action(async (_o: unknown, cmd: Command) => {
      const d = await controlDeps();
      emit(controlShow(d), { json: globalOpts(cmd).json, human: (r: ReturnType<typeof controlShow>) => [`control revision ${r.revision}${r.updatedAt ? ` (${r.updatedAt})` : ''}`, ...Object.entries(r.effective).map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)].join('\n') });
    }));
  control.command('set <key> <value>').description('Set any config key (dotted path; the value is JSON, or a plain string), e.g. `control set workflows.default \'["engineer","reviewer"]\'`')
    .requiredOption('--reason <text>', 'why (journaled)')
    .action(action(async (key: string, value: string, o: { reason: string }, cmd: Command) => {
      const c = await controlSet(await controlDeps(), key, parseValue(value), o.reason);
      noticeHostOwned(c, o.reason);
      emit(c, { json: globalOpts(cmd).json, human: humanChange });
    }));
  control.command('unset <key>').description('Remove a key from the overlay (the value falls back to the project and host configuration)')
    .requiredOption('--reason <text>', 'why (journaled)')
    .action(action(async (key: string, o: { reason: string }, cmd: Command) => {
      const c = await controlUnset(await controlDeps(), key, o.reason);
      noticeHostOwned(c, o.reason);
      emit(c, { json: globalOpts(cmd).json, human: humanChange });
    }));
  control.command('apply').description('Merge a partial config (JSON file or stdin) into the overlay in one change, e.g. a new role plus the workflow that uses it')
    .requiredOption('--file <path>', 'the partial config ("-" = stdin)')
    .requiredOption('--reason <text>', 'why (journaled)')
    .action(action(async (o: { file: string; reason: string }, cmd: Command) => {
      let partial: unknown;
      try { partial = JSON.parse(await readInput(o.file, 'the partial config JSON', 'Pass --file <path>, or --file - with the JSON on stdin.')); } catch { throw new MinionsError('PRECONDITION', 'The file is not valid JSON.'); }
      const c = await controlApply(await controlDeps(), partial, o.reason);
      noticeHostOwned(c, o.reason);
      emit(c, { json: globalOpts(cmd).json, human: humanChange });
    }));
  control.command('undo [revision]').description('Restore the overlay as it was before a revision (default: the last change); the undo is itself a new revision')
    .requiredOption('--reason <text>', 'why (journaled)')
    .action(action(async (revision: string | undefined, o: { reason: string }, cmd: Command) => {
      const rev = revision === undefined ? undefined : Number(revision);
      if (rev !== undefined && !Number.isInteger(rev)) throw new MinionsError('PRECONDITION', `Invalid revision "${revision}".`);
      const c = await controlUndo(await controlDeps(), o.reason, rev);
      noticeHostOwned(c, o.reason);
      emit(c, { json: globalOpts(cmd).json, human: humanChange });
    }));
  control.command('log').description('The control journal, newest first')
    .option('--limit <n>', 'entries', '20')
    .action(action(async (o: { limit: string }, cmd: Command) => {
      const d = await controlDeps();
      const entries = readJournal(d.state).reverse().slice(0, Math.max(1, Number(o.limit) || 20)).map(({ before: _b, ...e }) => e);
      emit(entries, { json: globalOpts(cmd).json, human: (es: typeof entries) => es.map((e) => `${e.revision} ${e.at} ${e.actor} ${e.op} ${e.keys.join(', ')}: ${e.reason}`).join('\n') || 'No control changes.' });
    }));

  // work
  const work = program.command('work').description('Claim, record and release worker leases (container only)');
  work.command('next').description('List the stages that can be claimed now (task, role, agent type, workflow position, suggested model, reason), in dispatch order')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('runtime');
      emit(await (await scheduler()).next(), { json: globalOpts(cmd).json, human: humanNext });
    }));
  work.command('claim <taskId>').description('Claim the current stage of a task; returns the task brief (stored for `work brief`)')
    .option('--role <role>', 'expected stage role (engineer | tester | reviewer | a project role); refused unless it is the current stage\'s. Default: the stage machine picks it')
    .option('--holder <holder>', 'who holds the lease (default: this process)')
    .option('--compact', 'print only leaseId, briefMarker, task, role, attempt, branch, worktree, expectedHead (the worker fetches the full brief)')
    .action(action(async (taskId: string, o: { role?: string; holder?: string; compact?: boolean }, cmd: Command) => {
      requireMode('runtime');
      // Built-ins and project roles alike: the stage machine places the role in the task's workflow (D6); without --role it picks it.
      const def = o.role === undefined ? undefined : requireWorkerRole(await getConfig(), o.role);
      const brief = await claimWithBrief(await scheduler(), runtimePaths(), taskId, def?.name, { holder: o.holder });
      if (o.compact) emit(compactClaim(brief), { json: globalOpts(cmd).json, human: (c: CompactClaim) => `${c.briefMarker}\nworktree: ${c.worktree}\nbranch: ${c.branch} @ ${c.expectedHead}` });
      else emit(brief, { json: globalOpts(cmd).json, human: (b) => `${b.briefMarker}\n${JSON.stringify(b, null, 2)}` });
    }));
  work.command('brief <leaseId>').description('Worker: fetch the full brief of your own lease (run from inside its worktree)')
    .requiredOption('--role <role>', 'your role (as in your prompt): engineer | tester | reviewer | a project role')
    .action(action(async (leaseId: string, o: { role: string }, cmd: Command) => {
      requireMode('runtime');
      const b = await fetchBrief(getDb(), runtimePaths(), leaseId, { role: o.role, cwd: process.cwd(), config: await getConfig() });
      emit(b, { json: globalOpts(cmd).json, human: (x) => JSON.stringify(x, null, 2) });
    }));
  work.command('submit <leaseId>').description('Worker: submit your WorkerResult JSON (stdin or --result-file) for the coordinator to record')
    .requiredOption('--role <role>', 'your role (as in your prompt): engineer | tester | reviewer | a project role')
    .option('--result-file <path>', 'read the WorkerResult from a file ("-" = stdin)')
    .action(action(async (leaseId: string, o: { role: string; resultFile?: string }, cmd: Command) => {
      requireMode('runtime');
      const cfg = await getConfig();
      requireWorkerRole(cfg, o.role); // before reading the result: an unknown role never gets that far
      const raw = await readInput(o.resultFile);
      const r = await submitResult(getDb(), runtimePaths(), leaseId, raw, { role: o.role, cwd: process.cwd(), config: cfg });
      emit(r, { json: globalOpts(cmd).json, human: (d) => d.message });
    }));
  work.command('record <leaseId>').description('Record a worker result (submitted file, JSON on stdin, or --result-file)')
    .option('--submitted', 'record the result the worker stored with `minions work submit` (no JSON passes through the coordinator)')
    .option('--result-file <path>', 'read the WorkerResult from a file ("-" = stdin)')
    .option('--correction', 'the single allowed correction after an invalid result')
    .option('--usage <tokens>', USAGE_HELP)
    .option('--model <name>', 'model the worker ran on (for the USD estimate with API-key billing)')
    .action(action(async (leaseId: string, o: { submitted?: boolean; resultFile?: string; correction?: boolean; usage?: string; model?: string }, cmd: Command) => {
      requireMode('runtime');
      if (o.submitted && o.resultFile) throw new MinionsError('PRECONDITION', 'Use --submitted or --result-file, not both.');
      const opts = { correction: !!o.correction, usage: usageFlag(o) };
      const r = o.submitted
        ? await recordSubmitted(await scheduler(), runtimePaths(), leaseId, opts)
        : await (await scheduler()).record(leaseId, await readInput(o.resultFile), opts);
      const out = withContextReset(r, { db: getDb(), config: await getConfig(), state: runtimePaths().state });
      emit(out, { json: globalOpts(cmd).json, human: (d: typeof out) => [d.message, ...(d.errors ?? []).map((e: string) => `  - ${e}`), ...(d.budget ? [d.budget.message] : []), ...resetLine(d)].join('\n') });
    }));
  work.command('advance <leaseId>').description('Coordinator: record the submitted result (as `record --submitted`), then claim the next runnable stage (as `claim --compact`: the same task first, else `work next` order) and return its Agent parameters, or a decision when you must judge (never claims while paused, draining, over budget or after an invalid result)')
    .option('--correction', 'the single allowed correction after an invalid result')
    .option('--usage <tokens>', USAGE_HELP)
    .option('--model <name>', 'model the worker ran on (for the USD estimate with API-key billing)')
    .option('--task <id>', 'only this task: the lease must be one of its stages, and only its next stage is claimed (the default in a task session)')
    .action(action(async (leaseId: string, o: { correction?: boolean; usage?: string; model?: string; task?: string }, cmd: Command) => {
      requireMode('runtime');
      const opts = { correction: !!o.correction, usage: usageFlag(o), ...(o.task !== undefined ? { task: o.task } : {}) };
      const r = await advanceLease(await scheduler(), runtimePaths(), leaseId, opts, { db: getDb(), config: await getConfig(), state: runtimePaths().state });
      emit(r, { json: globalOpts(cmd).json, human: humanAdvance });
    }));
  work.command('release <leaseId>').description('Release a lease without a result (worktree is kept)')
    .requiredOption('--reason <text>', 'why the lease is released')
    .option('--usage <tokens>', USAGE_HELP)
    .option('--model <name>', 'model the worker ran on (for the USD estimate with API-key billing)')
    .action(action(async (leaseId: string, o: { reason: string; usage?: string; model?: string }, cmd: Command) => {
      requireMode('runtime');
      const r = withContextReset(await (await scheduler()).release(leaseId, o.reason, { usage: usageFlag(o) }), { db: getDb(), config: await getConfig(), state: runtimePaths().state });
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [`Released ${d.leaseId} (${d.taskId}); worktree kept at ${d.worktree ?? '-'}`, ...(d.run ? [`process run: ${d.run}`] : []), ...(d.budget ? [d.budget.message] : []), ...resetLine(d)].join('\n') });
    }));
  work.command('spend').description('Spend tally and owner budget: show it, set the budget in plain language, or record usage after the fact')
    .option('--budget <amount>', 'set the budget, e.g. "5M tokens", "500k tokens per day", "$50" (API-key billing), "20 attempts"; "off" clears it')
    .option('--by <name>', 'who set the budget (e.g. owner via Telegram)')
    .option('--lease <leaseId>', 'record the token total for this lease (any status; the latest figure per lease counts)')
    .option('--session [id]', 'record the coordinator session\'s own token total (default id: the coordinator lock session)')
    .option('--tokens <n>', 'cumulative token total for --lease or --session')
    .option('--model <name>', 'model, for the USD estimate with API-key billing')
    .action(action(async (o: { budget?: string; by?: string; lease?: string; session?: string | boolean; tokens?: string; model?: string }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      emit(await spendCommand(o), { json: globalOpts(cmd).json, human: (d) => [humanSpend(d), humanBaseline(d.coordinator.baseline), ...(d.notice ? [d.notice] : [])].join('\n') });
    }));
  work.command('cancel [taskIds...]').description('Best-effort cancel: release every active worker lease of the given tasks (or --all) without a result and mark those tasks blocked; worktrees and branches are kept')
    .option('--all', 'cancel every active lease')
    .option('--reason <text>', 'why (recorded in the backlog note)', 'cancelled by the owner')
    .action(action(async (taskIds: string[], o: { all?: boolean; reason: string }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      if (!o.all && !taskIds.length) throw new MinionsError('PRECONDITION', 'Name the task(s) to cancel, or pass --all.');
      if (o.all && taskIds.length) throw new MinionsError('PRECONDITION', 'Use task ids or --all, not both.');
      const s = await scheduler();
      const r = await cancelWork({ db: getDb(), release: (id, why) => s.release(id, why), backlog: await getBacklog() }, { taskIds, all: !!o.all }, o.reason);
      emit(r, { json: globalOpts(cmd).json, human: formatCancel });
      if (r.failed.length || r.blockFailed.length) process.exitCode = 1;
    }));
  work.command('publish <taskId>').description('Publish an approved task (branch / pull-request delivery), or in local delivery with local integration on queue its integration again; idempotent, retryable')
    .action(action(async (taskId: string, _o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const r = await (await scheduler()).publish(taskId);
      emit(r, { json: globalOpts(cmd).json, human: (d) => d.message });
      if (r.state === 'failed') process.exitCode = 1;
    }));
  work.command('approve <taskId>').description('Approve publishing the approved head (sensitive paths / "ask" publication), or with --merge merging its delivered PR (pr.merge "ask") or landing its local integration (base.merge "ask", sensitive paths); run on the host, which signs the approval')
    .requiredOption('--head <sha>', 'the full approved head SHA being authorized (binds the approval to that commit)')
    .option('--merge', 'approve merging the delivered pull request at that head (CI-gated auto-merge), or the local integration of that head, instead of publishing it')
    .option('--by <name>', 'who approved (default: the host user)')
    .option('--note <text>', 'why')
    .addOption(new Option('--signature <token>', 'host-signed approval token (set by the host CLI when it delegates; never needed by hand)').hideHelp())
    .action(action(async (taskId: string, o: { head: string; merge?: boolean; by?: string; note?: string; signature?: string }, cmd: Command) => {
      if (runtimeMode() === 'host') {
        if (o.signature) throw new MinionsError('PRECONDITION', 'The host CLI signs approvals itself; --signature is only accepted inside the agent runtime.');
        process.exit(await approveOnHost(taskId, { head: o.head, by: o.by, note: o.note, merge: !!o.merge, json: globalOpts(cmd).json }));
      }
      const s = await scheduler();
      const opts = { head: o.head, by: o.by, note: o.note, signature: o.signature };
      const r = o.merge ? s.approveMerge(taskId, opts) : s.approvePublication(taskId, opts);
      emit(r, { json: globalOpts(cmd).json, human: (d) => d.message });
    }));
  work.command('probe').description('Process-harness probe (no credentials, no model request): configured harness binaries and pinned versions, the minions-sandbox isolation self-test (cached per container start), loopback listeners on allowed TCP connect ports')
    .option('--refresh', 'run the isolation self-test again instead of using the cached result')
    .action(action(async (o: { refresh?: boolean }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      if (runtimeMode() === 'host-runtime') {
        throw new MinionsError('PRECONDITION', 'Process harnesses run only in the Docker runtime; the host runtime refuses them.', 'Switch with `minions runtime set docker`.');
      }
      const paths = runtimePaths();
      const c = containerPaths();
      const r = await workProbe({
        config: await getConfig(),
        cacheFile: join(paths.state, 'run', 'sandbox-probe.json'),
        scratchRoot: paths.tmp,
        protectedPaths: containerProtectedPaths({ state: paths.state, secretsDir: paths.secretsDir, configDir: c.configDir, pluginDir: paths.pluginDir, claudeHome: c.claudeHome, workspace: paths.workspace },
          { commonDir: join(paths.repo, '.git') }),
        real: await containerRealTargets({ db: paths.db, secretsDir: paths.secretsDir, claudeHome: c.claudeHome, repo: paths.repo, state: paths.state, worktrees: paths.worktrees }),
        refresh: !!o.refresh,
      });
      emit(r, { json: globalOpts(cmd).json, human: formatWorkProbe });
    }));
  work.command('run <leaseId>').description('Coordinator: run the process-harness worker of a claimed lease (launch gate, isolated per-lease clone, supervision, post-exit checks, fast-forward fetch-back, submit by proxy); prints one JSON line when the worker ends')
    .action(action(async (leaseId: string, _o: unknown, cmd: Command) => {
      requireMode('runtime');
      if (runtimeMode() === 'host-runtime') {
        throw new MinionsError('PRECONDITION', 'Process harnesses run only in the Docker runtime; the host runtime refuses them.', 'Switch with `minions runtime set docker`.');
      }
      const paths = runtimePaths();
      const c = containerPaths();
      const cfg = await getConfig();
      const protectedPaths = containerProtectedPaths({ state: paths.state, secretsDir: paths.secretsDir, configDir: c.configDir, pluginDir: paths.pluginDir, claudeHome: c.claudeHome, workspace: paths.workspace },
        { commonDir: join(paths.repo, '.git') });
      const real = await containerRealTargets({ db: paths.db, secretsDir: paths.secretsDir, claudeHome: c.claudeHome, repo: paths.repo, state: paths.state, worktrees: paths.worktrees });
      const r = await runLease(leaseId, {
        db: getDb(), config: cfg, paths, commonDir: join(paths.repo, '.git'), adapters: PROCESS_ADAPTERS, rolePromptDir: join(paths.pluginDir, HARNESS_PROMPTS_DIR),
        isolation: {
          kind: 'sandbox', protectedPaths,
          selfTest: async () => cachedSandboxSelfTest({
            cacheFile: join(paths.state, 'run', 'sandbox-probe.json'), identity: await probeIdentity(SANDBOX_BIN),
            run: () => runSandboxSelfTest({ parent: paths.tmp, protectedPaths, tcpConnectPorts: cfg.harnesses?.network?.tcpConnectPorts, real }),
          }),
        },
      });
      emit(r, { json: globalOpts(cmd).json, human: (d: RunOutput) => JSON.stringify(d) });
      if (r.error) process.exitCode = 1;
    }));
  // Task-82.2: the local integrator (src/runtime/integrator.ts). Hidden: phase 3 starts it detached after a local
  // approval; the worker hooks refuse it to subagents like `work run`.
  work.command('integrate', { hidden: true }).description('Internal: the local integrator; takes the integration lock, recovers a crashed run, then merges, verifies and lands the queued approved heads one at a time until the queue is empty (container only)')
    .option('--adopt-base', 'clear a halted queue and take the current base branch as the integration base (after checking the reset or rewrite is intended)')
    .action(action(async (o: { adoptBase?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const paths = runtimePaths();
      const { config: cfg, db: d, backlog: b } = await context();
      if (o.adoptBase) {
        const r = await adoptIntegrationBase(d, paths.repo, cfg.git.baseBranch);
        emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `integration base: ${x.base}${x.clearedHalt ? ` (halt cleared: ${x.clearedHalt.reason})` : ''}` });
        return;
      }
      const stop = new AbortController();
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, () => stop.abort());
      const r = await runIntegrator({
        db: d, repo: paths.repo, integrationDir: paths.integration,
        runDir: join(paths.state, 'run', 'integration'), logDir: join(paths.logs, 'integration'),
        config: () => loadRuntimeConfig(), signal: stop.signal,
        unmetDependencies: async (taskId) => {
          const t = await b.getTask(taskId);
          const out: string[] = [];
          for (const dep of t.dependencies) {
            const s = await b.getTask(dep).then((x) => x.status, () => null);
            if (s !== 'done') out.push(dep);
          }
          return out;
        },
        approved: async (row) => {
          const pem = await readFile(paths.approvalPublicKey, 'utf8').catch(() => null);
          return !!pem && verifyAnyApproval(d.approvals(row.task_id, 'merge', row.head_sha).map((a) => a.signature), pem, { taskId: row.task_id, head: row.head_sha, scope: 'merge' }).ok;
        },
        // Task-82.3: a terminal row moves its task (landed -> done, failure -> changes-requested, ...), with the
        // config as it is now (the integrator may run for a long time).
        onSettled: async (row) => {
          const s = new Scheduler({ config: await loadRuntimeConfig(), db: d, backlog: b, layout: workspaceLayout(), handoff: paths });
          const out = await s.settleIntegration(row);
          process.stderr.write(`${new Date().toISOString()} minions integrator: ${out.taskId}: ${out.message}\n`);
        },
        log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
      });
      emit(r, { json: globalOpts(cmd).json, human: (x: IntegratorReport) => x.exit === 'conflict'
        ? `integrator: already running (pid ${x.holder?.pid ?? '?'})`
        : `integrator: ${x.exit} (${x.settled.map((s) => `${s.taskId} ${s.phase}`).join(', ') || 'nothing settled'}${x.recovered.length ? `; ${x.recovered.length} recovered` : ''}${x.waiting.length ? `; waiting: ${x.waiting.map((w) => `${w.taskId} on ${w.on.join(', ')}`).join('; ')}` : ''})` });
    }));
  work.command('dispatch', { hidden: true }).description('Internal: the autopilot dispatcher the wrapper starts detached with dispatch.mode auto; claims runnable stages, runs each as a headless worker, records results and hands decisions to the coordinator (docs/design/autonomy.md Decision 1)')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('runtime');
      const stop = new AbortController();
      for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => stop.abort());
      const paths = runtimePaths();
      const d = getDb();
      const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${redact(line)}\n`);
      const r = await runDispatcher({
        db: d, paths, signal: stop.signal,
        config: () => loadRuntimeConfig(),
        scheduler: async (cfg) => new Scheduler({ config: cfg, db: d, backlog: await getBacklog(), layout: workspaceLayout(), handoff: paths, runs: { state: paths.state, reap: (leaseId) => reapRun(leaseId, reapDeps()) } }),
        launch: launchWorker(d, { paths, log }),
        taskStatus: async (_s, taskId) => (await (await getBacklog()).getTask(taskId)).status,
        notify: (hold, cfg) => notifyHold(d, hold, cfg),
        workerAlive: (rec) => isAlive(rec.pid !== null && rec.procStart ? { pid: rec.pid, startTime: rec.procStart } : null),
        procStart: async (pid) => (await procIdentity(pid))?.startTime ?? null,
        log,
      });
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `dispatcher: ${x.exit} (${x.passes} passes)` });
    }));
  const autopilot = work.command('autopilot').description('The autopilot dispatcher (dispatch.mode auto): what it runs, which tasks wait for your decision, and resume a task after you handled it');
  autopilot.command('status').description('Mode, the dispatcher process, its running workers and the held tasks (each with the decision it needs)')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('runtime');
      const d = getDb();
      const cfg = await getConfig();
      const lock = dispatcherLockState(d);
      const workers = d.activeLeases().filter((l) => l.holder === DISPATCH_HOLDER).map((l) => ({ leaseId: l.id, taskId: l.task_id, role: l.role, startedAt: l.started_at }));
      const holds = Object.values(readHolds(d));
      const r = { mode: dispatchMode(cfg), dispatcher: lock.state, pid: lock.lock?.pid ?? null, workers, holds };
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => [
        `dispatch mode ${x.mode}; dispatcher ${x.dispatcher}${x.pid ? ` (pid ${x.pid})` : ''}`,
        ...x.workers.map((w) => `  running ${w.taskId} ${w.role} (${w.leaseId}) since ${w.startedAt}`),
        ...x.holds.map((h) => `  held ${h.taskId}: ${h.kind}: ${h.message}`),
      ].join('\n') });
    }));
  autopilot.command('resume <taskId>').description('Clear the hold of a task once you handled its decision (a hold also clears itself when the task status changes or you claim a stage)')
    .action(action(async (taskId: string, _o: unknown, cmd: Command) => {
      requireMode('runtime');
      const cleared = clearHold(getDb(), taskId, 'coordinator: work autopilot resume');
      emit({ taskId, cleared }, { json: globalOpts(cmd).json, human: () => cleared ? `${taskId}: the dispatcher picks it up again.` : `${taskId} was not held.` });
    }));
  work.command('list').description('List active leases')
    .option('--all', 'include ended leases')
    .action(action(async (o: { all?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const leases = getDb().leases({ all: !!o.all });
      emit({ leases }, { json: globalOpts(cmd).json, human: (d) => (d.leases.length ? d.leases.map(leaseLine).join('\n') : '(no leases)') });
    }));

  // notify: the durable notification outbox (src/runtime/outbox.ts). Record before sending, ack after.
  const notify = program.command('notify').description('Notification outbox: record owner notifications before sending, list pending ones, acknowledge or fail them (no LLM is woken to resend)');
  notify.command('enqueue').description('Record a notification (text on stdin) under a dedup key; an existing key is a no-op')
    .requiredOption('--key <key>', 'dedup key, e.g. delivered:<taskId>:<headSha>, goal-ack:<messageId>, blocker:<taskId>:<attempt>')
    .requiredOption('--kind <kind>', 'goal-ack | delivered | feature | blocker | approval | question | status | digest | other')
    .option('--task <taskId>', 'related task')
    .option('--text-file <path>', 'read the text from a file ("-" = stdin, the default)')
    .addOption(new Option('--hold <hold>', 'digest: hold it for the next owner digest; none: send now; default: per kind (delivered, feature and question are held while routine.enabled and the owner is not in the chat)'))
    .option('--session <key>', 'the coordinator session it comes from (general | task:<id>; default: MINIONS_SESSION): an answer to a question routes back to it')
    .action(action(async (o: { key: string; kind: string; task?: string; textFile?: string; hold?: string; session?: string }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const session = notifySession(o.session);
      const text = await readInput(o.textFile, 'the notification text', 'Pipe the text in (never pass it as an argument) or use --text-file <path>.');
      const d = getDb();
      const holdUntil = holdFor(d, await getConfig(), o.kind, o.hold);
      const r = { ...enqueue(d, { key: o.key, kind: o.kind, taskId: o.task ?? null, text, holdUntil, session }), heldUntil: holdUntil };
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => (x.created ? `queued ${x.item.key}${x.item.nextAttemptAt && x.item.attempts === 0 ? ` (held for the digest at ${x.item.nextAttemptAt})` : ''}` : `${x.item.key} already ${x.item.deliveredAt ? 'delivered' : 'queued'} (no-op)`) });
    }));
  notify.command('pending').description('List undelivered notifications due now, oldest first (send each, then ack it)')
    .option('--all', 'include those waiting for a retry backoff')
    .option('--limit <n>', 'at most n items', (v) => Number.parseInt(v, 10))
    .action(action(async (o: { all?: boolean; limit?: number }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const d = getDb();
      // The hold-back first: while the routine is on, a held item whose time came waits for the digest.
      try { reholdExpired(d, await getConfig()); } catch { /* listing never fails on the hold-back */ }
      const r = { items: pending(d, { includeWaiting: !!o.all, limit: o.limit }), counts: outboxCounts(d) };
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `${formatItems(x.items)}\n${formatCounts(x.counts)}` });
    }));
  notify.command('digest').description('Compose the owner digest (held updates, waiting approvals, blockers, spend, next up, questions as numbered polls) and store it under its key; send the text with one reply, then ack the returned keys')
    .option('--status', 'only show whether a digest is due (times, the last one, held items)')
    .action(action(async (o: { status?: boolean }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const d = getDb();
      const cfg = await getConfig();
      if (o.status) {
        const st = digestStatus(d, cfg);
        emit(st, { json: globalOpts(cmd).json, human: humanDigestStatus });
        return;
      }
      let tasks: Awaited<ReturnType<BacklogAdapter['listTasks']>> | null = null;
      try { tasks = await (await getBacklog()).listTasks(); } catch { tasks = null; }
      let runnable: { taskId: string; role: string }[] = [];
      try { runnable = (await (await scheduler()).next()).runnable.map((r) => ({ taskId: r.taskId, role: r.role })); } catch { runnable = []; }
      let spend: SpendReport | null = null;
      try { spend = spendReport({ db: d, config: cfg }); } catch { spend = null; }
      const r = prepareDigest(d, cfg, { tasks, runnable, spend });
      emit(r, { json: globalOpts(cmd).json, human: humanDigest });
    }));
  notify.command('ack <keys...>').description('Mark notifications delivered (after the send succeeded); repeating it is a no-op')
    .option('--via <transport>', 'the transport that delivered it', 'telegram')
    .option('--message-id <id>', 'the Telegram message id the reply returned (sent (id: N)): recorded in tg_messages, so a reply or #ref to it routes back to the session', (v) => Number(v))
    .option('--ref <ref>', 'the ref footer sent with it (default: none)')
    .action(action(async (keys: string[], o: { via: string; messageId?: number; ref?: string }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const d = getDb();
      const r = { acked: keys.map((k) => { const a = ack(d, k, o.via); return { key: k, alreadyDelivered: a.alreadyDelivered }; }), ...(o.messageId !== undefined ? { recorded: recordSent(d, { messageId: o.messageId, keys, ref: o.ref ?? null }) } : {}) };
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => x.acked.map((a) => `${a.key}: ${a.alreadyDelivered ? 'already delivered' : 'delivered'}`).join('\n') });
    }));
  notify.command('fail <key>').description('Record a failed send; the notification stays pending and is retried after a backoff')
    .requiredOption('--error <message>', 'short error (credentials are masked; truncated)')
    .action(action(async (key: string, o: { error: string }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const r = fail(getDb(), key, o.error);
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `${x.key}: attempt ${x.attempts} failed; next retry after ${x.nextAttemptAt ?? '-'}` });
    }));

  // hooks (never fail toward Claude Code: always exit 0)
  const hook = program.command('hook').description('Claude Code hook handlers (container only)');
  // Exit explicitly once the decision is written: an open stdin or DB handle must not keep node alive (a hang
  // would defeat the fail-closed gates). The empty write's callback fires after earlier stdout writes flushed.
  const exitHook = () => { process.stdout.write('', () => process.exit(0)); };
  const hookLoader = async () => context();
  hook.command('stop').description('Stop hook: continue only when runnable work and capacity exist')
    .action(async () => { await runHook('stop', hookLoader); exitHook(); });
  hook.command('pre-agent').description('PreToolUse(Agent) hook: minions workers need an active lease')
    .action(async () => { await runHook('pre-agent', hookLoader); exitHook(); });
  hook.command('pre-bash').description('PreToolUse(Bash) hook: subagents cannot run coordinator-only minions commands (work run|claim|advance|release, state writes) or name the runtime state dir')
    .action(async () => { await runHook('pre-bash', async () => { throw new Error('pre-bash needs no runtime context'); }); exitHook(); });
  hook.command('pre-file').description('PreToolUse(file tools) hook: subagents cannot write, read or search the runtime state dir (DB, backlog, briefs, results)')
    .action(async () => { await runHook('pre-file', async () => { throw new Error('pre-file needs no runtime context'); }); exitHook(); });
  hook.command('pre-telegram').description('PreToolUse(Telegram tools) hook: only the coordinator itself may use them, never a subagent')
    .action(async () => { await runHook('pre-telegram', hookLoader); exitHook(); });
  // DB plus the config when it loads (role contracts for the notice; no backlog): it runs on every worker tool call while a drain is requested.
  hook.command('drain').description('PreToolUse(every tool) hook during a drain: leased workers commit work in progress and return partial results')
    .action(async () => { await runHook('drain', async () => ({ db: getDb(), config: await getConfig().catch(() => undefined) })); exitHook(); });

  // coordinator
  const coord = program.command('coordinator').description('Launch or attach the coordinator Claude Code session (tmux)')
    .option('--print-command', 'print the launch argv without running it (no secrets)')
    .option('--probe', 'check that Claude Code and tmux support the launch flags, then exit')
    .action(action(async (o: { printCommand?: boolean; probe?: boolean }, cmd: Command) => {
      const cfg = await getConfig();
      if (o.probe) {
        const r = { ...(await probeRuntime(cfg)), command: await buildCoordinatorCommand(cfg) };
        emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => `Claude Code ${d.claudeVersion}, ${d.tmuxVersion}: launch flags supported\n` +
          (d.permission.fallback ? `permission mode: acceptEdits (fallback) - ${d.permission.reason}` : `permission mode: ${d.permission.mode} (${d.permission.reason})`) });
        return;
      }
      if (o.printCommand) {
        // Same permission-mode check as the launch: auto only when this Claude Code offers it; default under the name it lists.
        const permissionModes = permissionModesNeeded(cfg) ? await claudePermissionModes() : undefined;
        const paths = runtimePaths();
        const telegram = cfg.communication.channel !== 'terminal';
        // Host runtime: the launch id is made per launch, so the printed argv shows a placeholder for it.
        const channelServer = telegram && runtimeMode() === 'host-runtime' ? printChannelServer(paths) : undefined;
        const r = { tmux: await buildCoordinatorCommand(cfg), claude: await buildClaudeCommand(cfg, paths, { telegram, permissionModes, ...(channelServer ? { channelServer } : {}) }) };
        emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [JSON.stringify([d.tmux.cmd, ...d.tmux.args]), JSON.stringify([d.claude.cmd, ...d.claude.args])].join('\n') });
        return;
      }
      requireMode('runtime');
      process.exitCode = await launchCoordinator(cfg);
    }));
  coord.command('run').description('Exec wrapper started by tmux: decides Telegram, then runs claude (container only)')
    .option('--recover', 'start claude with the recovery prompt (recover skill, then resume the queue)')
    .addOption(new Option('--wake', 'start claude with the routine wake prompt (/minions:orchestrate wake)').hideHelp())
    .action(action(async (o: { recover?: boolean; wake?: boolean }) => {
      requireMode('runtime');
      if (o.recover && o.wake) throw new MinionsError('PRECONDITION', 'Use --recover or --wake, not both.');
      // A signal before claude starts (startup intake included): exit now rather than wait for work still in flight.
      process.exitCode = await coordinatorWrapper(getConfig, {
        ...(o.recover ? { startupPrompt: RECOVERY_PROMPT } : o.wake ? { startupPrompt: WAKE_PROMPT } : {}),
        routineClock: wrapperRoutineClock,
        supervisorWatch: wrapperSupervisorWatch,
        integrationWatch: wrapperIntegrationWatch,
        dispatchWatch: wrapperDispatchWatch,
        onStart: async (c, l, stop) => {
          // D3b: no process run of the previous session outlives it. Every record that is not done is reaped
          // (cancel or kill, escapee sweep, wip: checkpoint) before anything else touches its scratch dir.
          let open: string[] = [];
          try {
            logRecovery(await recoverRuns(reapDeps(), 'all'), l);
            open = openRunsSync(runtimePaths().state);
          } catch (e) { l(`minions: process-run recovery failed: ${(e as Error).message.slice(0, 300)}`); open = openRunsSync(runtimePaths().state); }
          // Coordinator token tracking (task-57.1): the previous session's last turns, from its transcript, and why it ended.
          try { completeOpenSessions({ db: getDb(), config: c }); } catch { /* best-effort */ }
          // Restart/crash recovery: drop the scratch dirs of leases that ended (active ones, and unreaped runs, keep theirs).
          await sweepScratchOnStart(getDb(), runtimePaths(), l, open);
          await intakeOnStart(c, l, undefined, undefined, stop);
        },
        exitAfterSignal: (c) => process.exit(c),
      });
    }));
  coord.command('sync').description('Apply restart-required Telegram changes with a controlled coordinator restart (container only)')
    .option('--force', 'restart even while worker leases are active (they stay recorded for recovery)')
    .option('--start-detached', 'start the coordinator session without attaching when it is not running')
    .action(action(async (o: { force?: boolean; startDetached?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const d = getDb();
      const workers = await restartWorkers(d, { exceptSessions: sessionsSettings(await getConfig()).enabled });
      const r = await syncCoordinator(await getConfig(), {
        activeLeases: workers,
        recordRestart: (info) => d.setMeta('coordinator_restart', JSON.stringify(info)),
        lock: d,
      }, o);
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `coordinator: ${x.action} (${x.reason})` });
    }));
  coord.command('restart').description('Kill the coordinator session and relaunch it detached (container only; used by the host upgrade)')
    .option('--recover', 'start with the recovery prompt: reconcile leases, re-dispatch, resume the queue')
    .option('--force', 'restart even while worker leases are active (they stay recorded for recovery)')
    .option('--detach', 'advanced: run the restart in a detached process and return at once (the coordinator restarting itself; output in <state>/logs/context-reset.log)')
    .addOption(new Option('--wake', 'start with the routine wake prompt (the routine pass; never with --force)').hideHelp())
    .action(action(async (o: { force?: boolean; recover?: boolean; detach?: boolean; wake?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const d = getDb();
      const workers = await restartWorkers(d, { exceptSessions: sessionsSettings(await getConfig()).enabled });
      if (o.detach) {
        const paths = runtimePaths();
        const s = scheduleDetachedRestart({ activeLeases: workers, drain: () => d.drain(), log: join(paths.logs, 'context-reset.log'), cwd: paths.state }, o);
        // The ending session's trigger for the coordinator baseline (task-57.1): which reset triggers held.
        try { noteResetRequest(d, contextResetCheck({ db: d, config: await getConfig(), state: paths.state }).triggers); } catch { /* best-effort */ }
        emit(s, { json: globalOpts(cmd).json, human: (x: typeof s) => `coordinator: ${x.action} (${x.reason})` });
        return;
      }
      const r = await restartCoordinator(await getConfig(), {
        activeLeases: workers,
        recordRestart: coordinatorRestartRecorder(d),
        lock: d,
      }, o);
      // --recover backstop (task-82.4): a queued integration whose detached start was lost starts again here.
      if (o.recover) await kickIntegratorIfNeeded({ decide: async () => kickInputs(d, await getConfig()), start: startIntegrator, say: (l) => process.stderr.write(l + '\n') });
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `coordinator: ${x.action} (${x.reason})` });
    }));

  coord.command('handoff').description(`Advanced (used by the coordinator itself): write the context-reset handoff from stdin (at most ${HANDOFF_MAX_BYTES} bytes, secrets redacted, replaces the previous one), --read it at startup, or --check whether a reset is due (container only)`)
    .option('--read', 'print the stored handoff (a fresh coordinator reads it at startup)')
    .option('--check', 'report whether a context reset is due: triggers, blockers (active leases, drain) and the steps')
    .action(action(async (o: { read?: boolean; check?: boolean }, cmd: Command) => {
      requireMode('runtime');
      if (o.read && o.check) throw new MinionsError('PRECONDITION', 'Use --read or --check, not both.');
      const paths = runtimePaths();
      const json = globalOpts(cmd).json;
      // A coordinator session (MINIONS_SESSION; a malformed value is refused) keeps its own handoff (phase 6).
      const scope = sessionScope();
      const handoffPath = handoffPathFor(paths.state, scope, paths.coordinatorHandoff);
      if (o.read) {
        const h = readHandoff(handoffPath);
        emit(h, { json, human: (d: typeof h) => (d.present ? `handoff written ${d.writtenAt} (${d.ageMinutes} min ago, ${d.bytes} bytes):\n${d.text}` : 'no handoff stored') });
        return;
      }
      if (o.check) {
        const c = contextResetCheck({ db: getDb(), config: await getConfig(), state: paths.state });
        emit(c, { json, human: (d: typeof c) => [d.reason, ...(d.steps ?? []).map((x, i) => `  ${i + 1}. ${x}`)].join('\n') });
        return;
      }
      const raw = await readInput(undefined, 'the handoff text', 'Pipe the note in with a quoted heredoc; --read prints the stored one, --check reports whether a reset is due.');
      const r = await writeHandoff({ db: getDb(), path: handoffPath, scope }, raw);
      emit(r, { json, human: (d: typeof r) => `handoff stored (${d.bytes}/${d.maxBytes} bytes${d.redactions ? `, ${d.redactions} secret(s) redacted` : ''}${d.replaced ? ', replaced the previous one' : ''})` });
    }));

  // Task-57 phase 5: the session supervisor (src/runtime/supervisor.ts). Hidden: the wrapper starts it detached when
  // coordinator.sessions.enabled is on; the worker hooks refuse it to subagents like live-run.
  coord.command('supervise', { hidden: true }).description('Internal: the session supervisor the wrapper starts detached with coordinator.sessions.enabled; starts and stops the headless coordinator sessions (container only)')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('runtime');
      const paths = runtimePaths();
      const stop = new AbortController();
      for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, () => stop.abort());
      // Asked once, like the coordinator launch: auto only where this Claude Code offers it.
      let modes: Promise<readonly string[] | null> | undefined;
      const r = await runSupervisor({
        db: getDb(), state: paths.state, config: () => loadRuntimeConfig(), signal: stop.signal,
        launch: async (c, key, o) => buildSessionCommand(c, key, {
          ...(o.resume ? { resume: o.resume } : {}),
          permissionModes: permissionModesNeeded(c) ? await (modes ??= claudePermissionModes().catch(() => null)) : undefined,
        }),
        log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
        tasks: supervisorTaskDeps(),
      });
      emit(r, { json: globalOpts(cmd).json, human: (x: SupervisorReport) => x.exit === 'conflict'
        ? `session supervisor: already running (pid ${x.holder?.pid ?? '?'})`
        : `session supervisor: ${x.exit} (${x.starts} session start(s), ${x.opened} task session(s) opened, ${x.closed} closed, ${x.reaped.length} orphan record(s) reaped)` });
    }));

  // Task-57 phase 8: the router's deterministic helpers (src/runtime/router.ts). Coordinator-only like supervise.
  coord.command('route').description('Router: resolve which coordinator session an owner message (stdin) goes to: a reply, /s <key>, a #ref, a task id, an open question, else general; or ambiguous with candidates (container only)')
    .option('--reply-to <messageId>', 'the bot message it replies to (channel meta reply_to_message_id)', (v) => Number(v))
    .action(action(async (o: { replyTo?: number }, cmd: Command) => {
      requireMode('runtime');
      const text = await readInput(undefined, 'the owner message', 'Pipe the message in with a quoted heredoc.');
      let knownTasks: string[] | null = null;
      try { knownTasks = (await (await getBacklog()).listTasks()).map((t) => t.id); } catch { knownTasks = null; }
      const r = resolveRoute(getDb(), { text, replyToMessageId: o.replyTo ?? null }, { knownTasks });
      emit(r, { json: globalOpts(cmd).json, human: (x: RouteResult) => x.target ? `${x.target} (${x.rule}: ${x.why})` : `ambiguous (${x.why}): ${x.candidates.map((c, i) => `${i + 1}. ${c.key}`).join(' ')}` });
    }));
  coord.command('send <key>').description('Router: hand an owner message (stdin) to a coordinator session (general | task:<id>); the supervisor delivers it and reopens a closed session (container only)')
    .option('--answers <questionKey>', 'the open question it answers (from coordinator route): marked answered')
    .option('--message-id <id>', 'the owner message id (kept with the inbox message)', (v) => Number(v))
    .action(action(async (key: string, o: { answers?: string; messageId?: number }, cmd: Command) => {
      requireMode('runtime');
      const text = await readInput(undefined, 'the owner message', 'Pipe the message in with a quoted heredoc.');
      const r = sendToSession(getDb(), await getConfig(), { key, text, state: runtimePaths().state, answers: o.answers ?? null, ...(o.messageId !== undefined ? { meta: { messageId: o.messageId } } : {}) });
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `queued for ${x.key}${x.reopened ? ' (reopened)' : ''}${x.answered ? `; ${x.answered} answered` : ''}` });
    }));
  coord.command('wait').description('Router: wait until an outbox item or the digest is due (or the timeout), then exit; run it in the background (container only)')
    .option('--timeout <minutes>', 'give up after this many minutes', (v) => Number(v), 30)
    .option('--poll <seconds>', 'check interval', (v) => Number(v), 5)
    .action(action(async (o: { timeout: number; poll: number }, cmd: Command) => {
      requireMode('runtime');
      if (!(o.timeout > 0) || !(o.poll > 0)) throw new MinionsError('PRECONDITION', '--timeout and --poll must be positive numbers.');
      const d = getDb();
      const cfg = await getConfig();
      const stop = new AbortController();
      for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => stop.abort());
      const r = await waitForOutbound({
        db: d, timeoutMs: o.timeout * 60_000, pollMs: o.poll * 1000, signal: stop.signal,
        // As the routine pass: no digest is due while the routine is off.
        digestDue: (now) => (routineSettings(cfg).enabled ? digestStatus(d, cfg, now).due : null), holdBack: (now) => { reholdExpired(d, cfg, now); },
        sleep: (ms) => new Promise<void>((res) => { const t = setTimeout(res, ms); stop.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); }),
      });
      emit(r, { json: globalOpts(cmd).json, human: (x: WaitResult) => x.reason === 'due' ? `due: ${x.items.map((i) => i.key).join(', ')}` : x.reason === 'digest' ? `digest due: ${x.digest}` : x.reason });
    }));

  // Task-96: the coordinator's controlled live Claude run. Coordinator-only (the pre-bash hook refuses it to every
  // subagent, like `work run|claim|release`), refused while any worker lease is active, fresh CLAUDE_CONFIG_DIR.
  coord.command('live-run').description('Coordinator only: run one headless claude for a controlled live check in a fresh CLAUDE_CONFIG_DIR with the runtime\'s Claude credential (claude args after --, prompt on stdin); refused while any worker lease is active (container only)')
    .argument('[claudeArgs...]', 'arguments for claude, after --')
    .option('--cwd <dir>', 'absolute working directory of the run (default: the current one)')
    .option('--keep-dir', 'keep the run dir (the fresh config dir with its transcripts) instead of removing it')
    .option('--dry-run', 'show what would run (credential path, argv, settings; never a secret) without running it')
    .action(action(async (claudeArgs: string[], o: { cwd?: string; keepDir?: boolean }, cmd: Command) => {
      requireMode('runtime');
      if (runtimeMode() === 'host-runtime') {
        throw new MinionsError('PRECONDITION', 'Live Claude runs are not available in the host runtime: its Bash commands are sandboxed (no secrets dir, no Anthropic API network), and it has no Telegram channel to protect.',
          'Run the check from your own terminal on the host, or use the Docker runtime.');
      }
      const { json, dryRun } = globalOpts(cmd);
      const d = getDb();
      const workers = dryRun ? withOpenRuns(() => d.activeLeases(), runtimePaths().state) : await restartWorkers(d);
      const r = await liveRun(claudeArgs, { cwd: o.cwd, keepDir: o.keepDir, dryRun }, {
        activeLeases: workers, method: runtimeAuthMethod(), paths: runtimePaths(), log: (line) => process.stderr.write(line + '\n'),
      });
      if (dryRun) {
        emit(r, { json, human: (x: LiveRunReport) => [`live run (dry run): ${x.method} method; credential: ${x.credential}`, `  argv: ${JSON.stringify([x.command, ...x.args])}`,
          `  cwd: ${x.cwd}`, `  fresh config dir settings: ${JSON.stringify(x.settings)}`, `  env set by minions: ${x.setEnv.join(', ')}`,
          ...(x.refused ? [`  refused now: ${x.refused}`] : [])].join('\n') });
        return;
      }
      // stdout belongs to claude: minions' own lines go to stderr.
      process.stderr.write(`live run: claude ${r.signal ? `ended by ${r.signal}` : `exited with code ${r.exitCode}`}; ${r.keptDir ? `run dir kept at ${r.configDir}` : 'run dir removed'}\n`);
      process.exitCode = liveRunExitCode(r);
    }));

  // telegram: credential-free capability probe. Host mode delegates to the container, where Claude Code runs.
  const tg = program.command('telegram').description('Telegram channel support (docs/design/telegram.md, docs/design/telegram-channel.md)');
  tg.command('probe').description('Report whether the Telegram channel is usable: the official plugin (Docker) or the minions channel server (host runtime); needs no credentials')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      if (runtimeMode() === 'host-runtime') {
        // Task-6: the host runtime runs the minions channel server, not the plugin. The token file is only checked for
        // format here; its content never leaves this process.
        const paths = runtimePaths();
        emit(await hostChannelReport(await readMountedToken(paths.telegramTokenFile), paths), { json: globalOpts(cmd).json, human: formatTelegramProbe });
        return;
      }
      emit(await probeTelegram(), { json: globalOpts(cmd).json, human: formatTelegramProbe });
    }));
  tg.command('install').description('Install the official Telegram channel plugin at user scope in the claude volume (needs network, no login)')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      if (runtimeMode() === 'host-runtime') {
        throw new MinionsError('PRECONDITION', 'The official Telegram plugin is not used in the host runtime: it would install a plugin into your own Claude Code setup. The host runtime uses the minions channel server instead (nothing to install).',
          'Store a bot token with `minions auth telegram`, then `minions start`; `minions telegram probe` checks the server.');
      }
      const r = await installTelegramPlugin();
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [`marketplace ${d.marketplace}; plugin ${d.plugin} (version ${d.version ?? 'unknown'})`, ...d.warnings.map((w) => `warning: ${w}`)].join('\n') });
    }));
  // The minions-owned channel server (task-67.2, docs/design/telegram-channel.md). The host runtime launch loads it (task-6).
  const tgChannel = tg.command('channel').description('The minions-owned Telegram channel server (MCP over stdio; started by the coordinator launch only)');
  tgChannel.command('serve').description('Serve the Telegram channel on stdin/stdout (JSON-RPC); reads the bot token only from $MINIONS_TELEGRAM_TOKEN_FILE')
    .action(action(async () => {
      requireMode('runtime');
      const paths = runtimePaths();
      await runChannelServer({
        env: process.env, stateDir: paths.telegramStateDir, logFile: join(paths.logs, 'telegram-channel.log'), proc: systemProcessControl,
        readLaunch: () => readLaunchRecord(paths), input: process.stdin, output: process.stdout,
      });
    }));
  tg.command('status').description('Pairing/allowlist policy and whether the running coordinator has Telegram (no codes, ids or tokens)')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const paths = runtimePaths();
      const r = { access: await readTelegramAccess(paths.telegramStateDir, undefined, { host: runtimeMode() === 'host-runtime' }), coordinator: await readLaunchRecord(paths), poller: await telegramPollerStatus({ paths }) };
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [
        `access: ${d.access.state} - ${d.access.detail}${d.access.hint ? `\n  hint: ${d.access.hint}` : ''}`,
        `coordinator: ${d.coordinator ? (d.coordinator.telegram.enabled ? 'Telegram enabled' : `terminal only (${d.coordinator.telegram.reason})`) : 'no launch recorded'}`,
        ...(d.poller.state !== 'not-applicable' ? [humanPoller(d.poller)] : []),
      ].join('\n') });
    }));

  // Pairing for the minions channel server (task-6): a terminal command, never a skill the model can run.
  const tgAccess = tg.command('access').description('Pair and manage who may use the Telegram channel (host runtime; interactive terminal only, with a typed confirmation)');
  const accessAction = (make: (...a: string[]) => AccessAction) => action(async (...args: unknown[]) => {
    const cmd = args[args.length - 1] as Command;
    if (runtimeMode() === 'host') return delegate(cmd);
    requireMode('runtime');
    if (runtimeMode() !== 'host-runtime') {
      throw new MinionsError('PRECONDITION', 'In the Docker runtime the official Telegram plugin owns pairing.',
        'Pair in the coordinator terminal: /telegram:access pair <code>, then /telegram:access policy allowlist.');
    }
    const isTty = !!process.stdin.isTTY && !!process.stdout.isTTY;
    const ask = async (q: string) => {
      if (!isTty) return null;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return await rl.question(`${q} `); } finally { rl.close(); }
    };
    const r = await runAccessCommand(runtimePaths().telegramStateDir, make(...(args.slice(0, -2) as string[])), { isTty, ask });
    emit(r, { json: globalOpts(cmd).json, human: formatAccessResult });
  });
  tgAccess.command('pair <code>').description('Approve the pairing code the bot sent you in a DM')
    .action(accessAction((code) => ({ kind: 'pair', code: code! })));
  tgAccess.command('policy <policy>').description('Set the DM policy: allowlist (recommended once paired), pairing, or disabled')
    .action(accessAction((policy) => ({ kind: 'policy', policy: policy! })));
  tgAccess.command('remove <senderId>').description('Remove a sender from the allowlist')
    .action(accessAction((senderId) => ({ kind: 'remove', senderId: senderId! })));
  tgAccess.command('list').description('Show the DM policy, the allowlisted senders and the number of pending codes')
    .action(accessAction(() => ({ kind: 'list' })));

  // workspace
  const ws = program.command('workspace').description('Container workspace and state setup (container only)');
  ws.command('setup').description('Create /state layout, runtime DB and Backlog.md config (idempotent)')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('runtime');
      const r = await setupState(runtimePaths(), writeBacklogConfig);
      emit(r, { json: globalOpts(cmd).json, human: (d) => `State ready at ${d.state} (schema ${d.schemaVersion}); backlog config ${d.backlogConfig.changed ? 'written' : 'unchanged'}` });
    }));
  ws.command('import <bundlePath>').description('Clone or refresh /workspace/repo from a git bundle')
    .requiredOption('--base <branch>', 'base branch')
    .option('--remote-url <url>', 'origin URL to record (fetched over https only when a GitHub token is mounted)')
    .action(action(async (bundle: string, o: { base: string; remoteUrl?: string }, cmd: Command) => {
      requireMode('runtime');
      const config = await getConfig();
      const r = await importWorkspace(bundle, { base: o.base, remoteUrl: o.remoteUrl, config, baseFrom: isGithubDelivery(config) ? 'origin' : 'host' });
      // minions' own record of the GitHub repository (publish.ts serverOriginOf): the verified base reads and
      // the push go to it, never to whatever the agent-writable .git/config names (task-71).
      const repository = originOfRemoteUrl(o.remoteUrl)?.repository;
      if (repository) getDb().setMeta(ORIGIN_REPOSITORY_META, repository);
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [`${d.imported ? 'Cloned' : 'Refreshed'} ${d.repo} at ${d.head} (base ${d.base})`,
        ...(d.origin ? [`origin ${d.origin.url}: ${d.origin.authenticated ? 'authenticated' : 'not authenticated'}, ${d.origin.fetched ? `fetched ${d.base}` : 'not fetched'}`] : []),
        ...(d.origin?.warnings ?? []).map((w) => `warning: ${w}`)].join('\n') });
    }));

  // git credential helper (configured per repository by `workspace import` when a token is mounted).
  // Reads the mounted token at use time; answers only `get` for https://github.com; no JSON envelope.
  // The hidden --token-file takes a file path only (tests point it away from the real mount); the
  // token value itself is never accepted on argv or via the environment.
  program.command('git-credential <operation>', { hidden: true })
    .description('git credential helper for https://github.com backed by the mounted GitHub token')
    .addOption(new Option('--token-file <path>', 'read the token from this file instead of the mounted secret').hideHelp())
    .action(async (operation: string, o: { tokenFile?: string }) => {
      const chunks: Buffer[] = [];
      if (!process.stdin.isTTY) for await (const c of process.stdin) chunks.push(c as Buffer);
      const r = await gitCredential(operation, Buffer.concat(chunks).toString('utf8'), { tokenFile: o.tokenFile });
      if (r.stderr) process.stderr.write(r.stderr + '\n');
      if (r.stdout) process.stdout.write(r.stdout);
      process.exitCode = 0;
    });
  ws.command('export <outPath>').description('Write a bundle with the base branch and agent/* branches')
    .action(action(async (out: string, _o: unknown, cmd: Command) => {
      requireMode('runtime');
      const r = await exportWorkspace(out, { base: (await getConfig()).git.baseBranch });
      emit(r, { json: globalOpts(cmd).json, human: (d) => `Wrote ${d.path}\n${d.refs.join('\n')}` });
    }));

  // State backup/restore (host: `minions export --state` / `minions import --state`; src/runtime/state-backup.ts).
  ws.command('state-export <outPath>').description('Write a state backup (backlog, notes, briefs, results, DB snapshot; no secrets) to a new file')
    .action(action(async (out: string, _o: unknown, cmd: Command) => {
      requireMode('runtime');
      const r = await createStateBackup(runtimePaths(), out);
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [`Wrote ${d.path} (${d.files} files, ${d.bytes} bytes, schema ${d.schemaVersion})`,
        ...d.skipped.map((s) => `skipped ${s.path}: ${s.reason}`)].join('\n') });
    }));
  ws.command('state-import <archive>').description('Restore a state backup written by state-export (refused while leases or the coordinator are active unless --force); leases the backup has active are released')
    .option('--force', 'restore even while worker leases are active or a coordinator holds the project lock')
    .action(action(async (archive: string, o: { force?: boolean }, cmd: Command) => {
      requireMode('runtime');
      // The swap replaces the DB and backlog files: handles opened before it would keep the replaced ones.
      resetRuntimeHandles();
      const r = await restoreStateBackup(runtimePaths(), archive, { force: o.force });
      resetRuntimeHandles();
      // The restored leases have no worker here, and `coordinator restart` refuses while any is active.
      const s = r.restoredActiveLeases.length ? await scheduler().catch(() => null) : null;
      const state = runtimePaths().state;
      const rel = await releaseRestoredLeases(getDb(), s ? (id, why) => s.release(id, why) : null, undefined, (id) => hasOpenRun(state, id));
      for (const f of rel.failed) r.warnings.push(`Lease ${f.leaseId} was ended directly in the DB (${f.error}); check its task's backlog status.`);
      for (const k of rel.kept) {
        r.warnings.push(`Lease ${k.leaseId} stays active: it has an unfinished process run and its release failed (${k.error}). `
          + `Run \`minions work release ${k.leaseId} --reason restored\` once that is fixed (or \`minions coordinator restart --recover\`).`);
      }
      const out = { ...r, releasedLeases: rel.released };
      emit(out, { json: globalOpts(cmd).json, human: (d: typeof out) => [`Restored ${d.restored.files} files from a backup of ${d.restored.createdAt} (schema ${d.restored.schemaVersion}).`,
        ...(d.previous ? [`Previous state moved to ${d.previous}`] : []), ...(d.releasedLeases.length ? [`Released restored lease(s): ${d.releasedLeases.join(', ')}`] : []),
        ...d.warnings.map((w) => `warning: ${w}`)].join('\n') });
    }));

  // sync: one-shot GitHub intake import (when intake.github is enabled) plus a refresh of PR state and
  // CI check results (no polling loop); host delegates.
  program.command('sync [taskIds...]').description('Import issues matching intake.github into the backlog (when enabled), refresh pull-request state and CI check results for tasks with a PR; reconcile merged/closed PRs; with delivery.merge auto-when-eligible, arm/disarm GitHub auto-merge for PRs that pass every gate')
    // The unattended routine pass (docs/design/unattended-delivery.md; src/runtime/routine.ts): internal, so hidden.
    .addOption(new Option('--routine', 'run the routine pass: sync, merge pass, wake decision, routine event (routine.enabled)').hideHelp())
    .addOption(new Option('--last', 'with --routine: print the last recorded pass (the woken coordinator reads its reasons here)').hideHelp())
    .addOption(new Option('--force', 'with --routine: run even within half an interval of the last pass').hideHelp())
    .addOption(new Option('--trigger <who>', 'with --routine: clock, watchdog or manual (default manual)').hideHelp())
    .action(action(async (taskIds: string[], o: { routine?: boolean; last?: boolean; force?: boolean; trigger?: string }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      if (o.routine || o.last || o.force || o.trigger) {
        if (!o.routine) throw new MinionsError('PRECONDITION', '--last, --force and --trigger go with --routine.');
        if (taskIds.length) throw new MinionsError('PRECONDITION', 'The routine pass syncs every task; it takes no task ids.');
        if (o.last) {
          const r = routineLast(getDb(), await getConfig());
          emit(r, { json: globalOpts(cmd).json, human: (x: RoutineLast) => [humanRoutine(x), ...(x.last?.reasons ?? []).map((w) => `  ${w.kind}: ${w.detail}`)].join('\n') });
          return;
        }
        const trigger = (o.trigger ?? 'manual') as RoutineTrigger;
        if (!ROUTINE_TRIGGERS.includes(trigger)) throw new MinionsError('PRECONDITION', `--trigger must be one of ${ROUTINE_TRIGGERS.join(', ')}.`);
        const r = await runRoutinePass(await routineDeps(), { trigger, force: o.force });
        emit(r, { json: globalOpts(cmd).json, human: humanRoutineReport });
        if (r.syncError || (r.sync?.failed ?? 0) > 0) process.exitCode = 1;
        return;
      }
      const d = getDb();
      const { report: rep, intake } = await fullSync(taskIds);
      const r: SyncReport & { intake: IntakeSyncReport | null; notifications: OutboxCounts } = {
        ...rep, intake,
        // Pending notifications are retried by whoever runs sync (the coordinator sends them; nothing is woken).
        notifications: outboxCounts(d),
      };
      emit(r, { json: globalOpts(cmd).json, human: (x) => [...(x.intake?.enabled ? [formatIntake(x.intake)] : []), formatSync(x),
        ...(x.notifications.pending ? [`${formatCounts(x.notifications)} (send with \`minions notify pending\`)`] : [])].join('\n') });
      if (r.failed || intake?.errors.length || r.tasks.some((t) => t.merge?.state === 'failed')) process.exitCode = 1;
    }));

  // ci: read-only required-checks status for the base branch (used by `minions doctor`).
  const ci = program.command('ci').description('CI awareness (read-only; minions never creates workflows or changes branch protection)');
  ci.command('status').description('Report required status checks on the base branch and the external CI setup plan')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const r = await ciStatus(workspaceLayout().repo, await getConfig(), { git });
      emit(r, { json: globalOpts(cmd).json, human: formatCiStatus });
    }));

  // status / pause / resume (host mode delegates to the container)
  program.command('status').description('Show queue, workers, pause state, config revision, delivery mode and channel (configured vs effective); --check: host health checks (same as `doctor`)')
    .option('--check', 'run the host health checks (tools, Docker, container, Claude auth, configuration) instead; same as `minions doctor`')
    .action(action(async (o: { check?: boolean }, cmd: Command) => {
      if (o.check) {
        requireMode('host');
        const r = await runDoctor({ cwd: process.cwd() });
        emit(r, { json: globalOpts(cmd).json, human: formatDoctor });
        applyDoctorExit(r);
        return;
      }
      if (runtimeMode() === 'host') {
        // Docker runtime: the container's status plus the host-side restart-required check (`minions upgrade`).
        const h = await hostStatus({ cwd: process.cwd(), args: cmd.args });
        // The host manager (service, process, bot, pending requests): host-wide, read-only, never fails status.
        const mgr = await managerOverview().catch(() => null);
        if (h.kind === 'delegate') {
          // The host runtime answers itself; the manager block goes first (human mode only, so --json stays one envelope).
          if (mgr && !globalOpts(cmd).json) writeSync(1, `${formatManagerOverview(mgr).join('\n')}\n\n`);
          return delegate(cmd);
        }
        if (h.kind === 'raw') {
          relayRawStatus(h.result, { json: globalOpts(cmd).json });
          return;
        }
        emit({ ...h.status, restartRequired: h.restartRequired, ...(mgr ? { manager: managerOverviewJson(mgr) } : {}) }, { json: globalOpts(cmd).json, human: () => {
          let base: string;
          try { base = humanStatus(h.status as unknown as StatusReport); } catch { base = JSON.stringify(h.status, null, 2); }
          return [base, ...formatRestartRequired(h.restartRequired), ...(mgr ? ['', ...formatManagerOverview(mgr)] : [])].join('\n');
        } });
        return;
      }
      const cfg = await getConfig();
      const r = await collectStatus({ db: getDb(), config: cfg, state: runtimePaths().state, backlog: getBacklog, channel: () => runtimeChannelStatus(cfg), launch: () => coordinatorLaunchStatus(cfg), poller: () => telegramPollerStatus(),
        integration: (tasks) => collectIntegrationStatus({ db: getDb(), config: cfg, repo: runtimePaths().repo, tasks }) });
      emit(r, { json: globalOpts(cmd).json, human: humanStatus });
    }));
  const pauseLike = (name: 'pause' | 'resume') => {
    const c = program.command(name)
      .description(name === 'pause'
        ? 'Pause intake and/or new starts (default: both); --drain also asks running workers to wind down'
        : 'Resume intake and/or new starts (default: both); resuming starts also clears a drain')
      .option('--intake', 'only intake')
      .option('--starts', 'only new task starts');
    if (name === 'pause') {
      c.option('--drain', 'pause starts and ask leased workers to commit work in progress and return partial results (used by `minions upgrade`)')
        .option('--reason <text>', 'why the drain is requested (with --drain)');
    } else c.option('--drain', 'only clear a drain request (starts stay as they are)');
    return c.action(action(async (o: PauseOptions, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      emit(pauseControl(getDb(), runtimePaths(), name, o), { json: globalOpts(cmd).json,
        human: (x) => `paused: intake=${x.paused.intake} starts=${x.paused.starts}${x.draining ? `; draining (${x.draining.reason})` : ''}` });
    }));
  };
  pauseLike('pause');
  pauseLike('resume');
}
