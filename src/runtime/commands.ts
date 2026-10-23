import { readFile } from 'node:fs/promises';
import { Option, type Command } from 'commander';
import { setIdempotencyStore, setIntakePausedContext, setProvenanceFallback, setReadyContext } from '../backlog/commands.js';
import { openBacklog, writeBacklogConfig } from '../backlog/factory.js';
import type { BacklogAdapter, IdempotencyStore } from '../backlog/types.js';
import { validateConfig } from '../config/resolve.js';
import { isGithubDelivery } from '../config/delivery.js';
import type { MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode, runtimeMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { readJson } from '../core/fsutil.js';
import { emit } from '../core/output.js';
import { approveOnHost } from '../host/approvals.js';
import { delegateToRuntime } from '../host/delegate.js';
import { applyDoctorExit, formatDoctor, runDoctor } from '../host/doctor.js';
import { formatRestartRequired, hostStatus } from '../host/restart-required.js';
import { readTelegramAccess } from '../telegram/access.js';
import { installTelegramPlugin } from '../telegram/install.js';
import { formatTelegramProbe, probeTelegram } from '../telegram/probe.js';
import { resolveChannel } from '../telegram/channel.js';
import {
  buildClaudeCommand, buildCoordinatorCommand, claudePermissionModes, configuredPermissionMode, coordinatorWrapper, launchCoordinator, probeRuntime, readLaunchRecord, readMountedToken, RECOVERY_PROMPT,
  restartCoordinator, runtimeChannelFacts, syncCoordinator, coordinatorLaunchStatus, type LaunchStatus,
} from './coordinator.js';
import { openDb, type DrainRequest, type Lease, type LeaseRole, type PauseChange, type RuntimeDb } from './db.js';
import { clearDrain, requestDrain } from './drain.js';
import { claimWithBrief, compactClaim, fetchBrief, recordSubmitted, submitResult, sweepScratchOnStart, type CompactClaim } from './handoff.js';
import { runHook } from './hooks.js';
import { runtimePaths } from './paths.js';
import { capacityOf, LEASE_ROLES, Scheduler } from './scheduler.js';
import { gitCredential } from './github.js';
import { ciStatus, formatCiStatus, formatSync, syncTasks, type SyncReport } from './ci.js';
import { formatIntake, intakeProvenanceFallback, originRepository, syncIntake, type IntakeSyncReport } from './intake-sync.js';
import { ghWithTimeout, type GhFn } from './publish.js';
import { exportWorkspace, importWorkspace, setupState } from './workspace.js';
import { git, workspaceLayout } from './worktree.js';

// ---------------------------------------------------------------- lazy runtime context

let db: RuntimeDb | undefined;
let config: MinionsConfig | undefined;
let backlog: BacklogAdapter | undefined;

const getDb = (): RuntimeDb => (db ??= openDb(runtimePaths().db));

/** Effective config from MINIONS_CONFIG (default /opt/minions/config/config.json), strictly validated. */
export async function loadRuntimeConfig(path = runtimePaths().configJson): Promise<MinionsConfig> {
  return validateConfig(await readJson(path), path);
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

const scheduler = async () => new Scheduler({ ...(await context()), layout: workspaceLayout(), handoff: runtimePaths() });

async function readInput(file?: string): Promise<string> {
  if (file && file !== '-') return readFile(file, 'utf8');
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', 'Expected the worker result on stdin.', 'Pipe the JSON in, pass --result-file <path>, or (record) use --submitted.');
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
  configRevision: number;
  profile: string;
  deliveryMode: string;
  queue: Record<string, number>;
  activeLeases: Pick<Lease, 'id' | 'task_id' | 'role' | 'attempt' | 'branch' | 'worktree' | 'head_sha' | 'started_at'>[];
  capacity: { activeTasks: number; maxActiveTasks: number; activeEngineers: number; maxEngineers: number } | null;
  guard: { lastReason: string | null; updatedAt: string | null };
  coordinatorLock: unknown;
  /** communication.channel: configured vs effective (running coordinator's launch decision, else predicted). */
  channel?: ChannelStatus;
  /** Running coordinator vs the current launch fingerprint (stale: restart required; the host reports `minions upgrade`). */
  coordinatorLaunch?: LaunchStatus;
  backlogError?: string;
}

export interface ChannelStatus {
  configured: MinionsConfig['communication']['channel'];
  effective: 'terminal' | 'telegram';
  reason: string;
  /** launch: decided by the running coordinator; predicted: no launch recorded (the probe runs at launch). */
  source: 'launch' | 'predicted';
  /** The running coordinator was launched with another channel setting: `minions down && minions start`. */
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

export async function collectStatus(deps: { db: RuntimeDb; config: MinionsConfig; backlog: () => Promise<BacklogAdapter>; channel?: () => Promise<ChannelStatus>; launch?: () => Promise<LaunchStatus> }): Promise<StatusReport> {
  const { db: d, config: cfg } = deps;
  const leases = d.activeLeases();
  const report: StatusReport = {
    paused: d.paused(), pauseChanges: d.pauseChanges(), draining: d.drain(), configRevision: cfg.configRevision, profile: cfg.profile, deliveryMode: cfg.delivery.mode,
    queue: {}, capacity: null,
    activeLeases: leases.map((l) => ({ id: l.id, task_id: l.task_id, role: l.role, attempt: l.attempt, branch: l.branch, worktree: l.worktree, head_sha: l.head_sha, started_at: l.started_at })),
    guard: { lastReason: d.guard().last_reason, updatedAt: d.guard().updated_at },
    coordinatorLock: d.coordinatorLock() ?? null,
  };
  if (deps.channel) report.channel = await deps.channel().catch(() => undefined);
  if (deps.launch) report.coordinatorLaunch = await deps.launch().catch(() => undefined);
  try {
    const tasks = await (await deps.backlog()).listTasks();
    for (const t of tasks) report.queue[t.status] = (report.queue[t.status] ?? 0) + 1;
    const cap = capacityOf(cfg, leases, tasks);
    report.capacity = { activeTasks: cap.activeTaskIds.length, maxActiveTasks: cap.maxActiveTasks, activeEngineers: cap.activeEngineers, maxEngineers: cap.maxEngineers };
  } catch (e) {
    report.backlogError = (e as Error).message;
  }
  return report;
}

export function humanStatus(s: StatusReport): string {
  const out = [
    `config revision ${s.configRevision}  profile ${s.profile}  delivery ${s.deliveryMode}`,
    `paused: intake=${s.paused.intake} starts=${s.paused.starts}`,
    ...(s.draining ? [`draining: ${s.draining.reason} since ${s.draining.requestedAt} (${s.activeLeases.length} lease(s) winding down)`] : []),
    ...(s.channel ? [`channel: configured ${s.channel.configured}, effective ${s.channel.effective} (${s.channel.source === 'launch' ? 'running coordinator' : 'predicted'}: ${s.channel.reason})${s.channel.restartRequired ? '; restart required: `minions down && minions start`' : ''}`] : []),
    s.capacity ? `capacity: ${s.capacity.activeTasks}/${s.capacity.maxActiveTasks} tasks, ${s.capacity.activeEngineers}/${s.capacity.maxEngineers} engineers` : 'capacity: unknown',
    `queue: ${Object.entries(s.queue).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)'}`,
    `stop guard: ${s.guard.lastReason ?? '-'}`,
  ];
  if (s.backlogError) out.push(`backlog error: ${s.backlogError}`);
  out.push(s.activeLeases.length ? 'active leases:' : 'active leases: none', ...s.activeLeases.map((l) => `  ${l.id} ${l.task_id} ${l.role} #${l.attempt} ${l.branch ?? ''}`));
  return out.join('\n');
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
async function delegate(cmd: Command): Promise<void> {
  const code = await delegateToRuntime(process.argv.slice(2), { json: globalOpts(cmd).json });
  process.exit(code);
}

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

  // work
  const work = program.command('work').description('Claim, record and release worker leases (container only)');
  work.command('claim <taskId>').description('Claim a task for a worker role; returns the task brief (stored for `work brief`)')
    .requiredOption('--role <role>', 'engineer | tester | reviewer')
    .option('--holder <holder>', 'who holds the lease (default: this process)')
    .option('--compact', 'print only leaseId, briefMarker, task, role, attempt, branch, worktree, expectedHead (the worker fetches the full brief)')
    .action(action(async (taskId: string, o: { role: string; holder?: string; compact?: boolean }, cmd: Command) => {
      requireMode('runtime');
      if (!(LEASE_ROLES as readonly string[]).includes(o.role)) throw new MinionsError('PRECONDITION', `--role must be engineer, tester or reviewer (got ${o.role}).`);
      const brief = await claimWithBrief(await scheduler(), runtimePaths(), taskId, o.role as LeaseRole, { holder: o.holder });
      if (o.compact) emit(compactClaim(brief), { json: globalOpts(cmd).json, human: (c: CompactClaim) => `${c.briefMarker}\nworktree: ${c.worktree}\nbranch: ${c.branch} @ ${c.expectedHead}` });
      else emit(brief, { json: globalOpts(cmd).json, human: (b) => `${b.briefMarker}\n${JSON.stringify(b, null, 2)}` });
    }));
  work.command('brief <leaseId>').description('Worker: fetch the full brief of your own lease (run from inside its worktree)')
    .requiredOption('--role <role>', 'your role: engineer | tester | reviewer')
    .action(action(async (leaseId: string, o: { role: string }, cmd: Command) => {
      requireMode('runtime');
      const b = await fetchBrief(getDb(), runtimePaths(), leaseId, { role: o.role, cwd: process.cwd() });
      emit(b, { json: globalOpts(cmd).json, human: (x) => JSON.stringify(x, null, 2) });
    }));
  work.command('submit <leaseId>').description('Worker: submit your WorkerResult JSON (stdin or --result-file) for the coordinator to record')
    .requiredOption('--role <role>', 'your role: engineer | tester | reviewer')
    .option('--result-file <path>', 'read the WorkerResult from a file ("-" = stdin)')
    .action(action(async (leaseId: string, o: { role: string; resultFile?: string }, cmd: Command) => {
      requireMode('runtime');
      const raw = await readInput(o.resultFile);
      const r = await submitResult(getDb(), runtimePaths(), leaseId, raw, { role: o.role, cwd: process.cwd() });
      emit(r, { json: globalOpts(cmd).json, human: (d) => d.message });
    }));
  work.command('record <leaseId>').description('Record a worker result (submitted file, JSON on stdin, or --result-file)')
    .option('--submitted', 'record the result the worker stored with `minions work submit` (no JSON passes through the coordinator)')
    .option('--result-file <path>', 'read the WorkerResult from a file ("-" = stdin)')
    .option('--correction', 'the single allowed correction after an invalid result')
    .action(action(async (leaseId: string, o: { submitted?: boolean; resultFile?: string; correction?: boolean }, cmd: Command) => {
      requireMode('runtime');
      if (o.submitted && o.resultFile) throw new MinionsError('PRECONDITION', 'Use --submitted or --result-file, not both.');
      const r = o.submitted
        ? await recordSubmitted(await scheduler(), runtimePaths(), leaseId, { correction: !!o.correction })
        : await (await scheduler()).record(leaseId, await readInput(o.resultFile), { correction: !!o.correction });
      emit(r, { json: globalOpts(cmd).json, human: (d) => [d.message, ...(d.errors ?? []).map((e: string) => `  - ${e}`)].join('\n') });
    }));
  work.command('release <leaseId>').description('Release a lease without a result (worktree is kept)')
    .requiredOption('--reason <text>', 'why the lease is released')
    .action(action(async (leaseId: string, o: { reason: string }, cmd: Command) => {
      requireMode('runtime');
      const r = await (await scheduler()).release(leaseId, o.reason);
      emit(r, { json: globalOpts(cmd).json, human: (d) => `Released ${d.leaseId} (${d.taskId}); worktree kept at ${d.worktree ?? '-'}` });
    }));
  work.command('publish <taskId>').description('Publish an approved task (branch / pull-request delivery); idempotent, retryable')
    .action(action(async (taskId: string, _o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const r = await (await scheduler()).publish(taskId);
      emit(r, { json: globalOpts(cmd).json, human: (d) => d.message });
      if (r.state === 'failed') process.exitCode = 1;
    }));
  work.command('approve <taskId>').description('Approve publishing the approved head (sensitive paths / "ask" publication), or with --merge merging its delivered PR (pr.merge "ask"); run on the host, which signs the approval')
    .requiredOption('--head <sha>', 'the full approved head SHA being authorized (binds the approval to that commit)')
    .option('--merge', 'approve merging the delivered pull request at that head (CI-gated auto-merge) instead of publishing it')
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
  work.command('list').description('List active leases')
    .option('--all', 'include ended leases')
    .action(action(async (o: { all?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const leases = getDb().leases({ all: !!o.all });
      emit({ leases }, { json: globalOpts(cmd).json, human: (d) => (d.leases.length ? d.leases.map(leaseLine).join('\n') : '(no leases)') });
    }));

  // hooks (never fail toward Claude Code: always exit 0)
  const hook = program.command('hook').description('Claude Code hook handlers (container only)');
  const hookLoader = async () => context();
  hook.command('stop').description('Stop hook: continue only when runnable work and capacity exist')
    .action(async () => { await runHook('stop', hookLoader); process.exitCode = 0; });
  hook.command('pre-agent').description('PreToolUse(Agent) hook: minions workers need an active lease')
    .action(async () => { await runHook('pre-agent', hookLoader); process.exitCode = 0; });
  hook.command('pre-telegram').description('PreToolUse(Telegram tools) hook: only the coordinator itself may use them, never a subagent')
    .action(async () => { await runHook('pre-telegram', hookLoader); process.exitCode = 0; });
  // DB only (no config or backlog): it runs on every worker tool call while a drain is requested.
  hook.command('drain').description('PreToolUse(every tool) hook during a drain: leased workers commit work in progress and return partial results')
    .action(async () => { await runHook('drain', () => ({ db: getDb() })); process.exitCode = 0; });

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
        // Same permission-mode check as the launch: auto only when this Claude Code offers it.
        const permissionModes = configuredPermissionMode(cfg) === 'auto' && runtimeMode() !== 'host-runtime' ? await claudePermissionModes() : undefined;
        const r = { tmux: await buildCoordinatorCommand(cfg), claude: await buildClaudeCommand(cfg, runtimePaths(), { telegram: cfg.communication.channel !== 'terminal', permissionModes }) };
        emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [JSON.stringify([d.tmux.cmd, ...d.tmux.args]), JSON.stringify([d.claude.cmd, ...d.claude.args])].join('\n') });
        return;
      }
      requireMode('runtime');
      process.exitCode = await launchCoordinator(cfg);
    }));
  coord.command('run').description('Exec wrapper started by tmux: decides Telegram, then runs claude (container only)')
    .option('--recover', 'start claude with the recovery prompt (recover skill, then resume the queue)')
    .action(action(async (o: { recover?: boolean }) => {
      requireMode('runtime');
      // A signal before claude starts (startup intake included): exit now rather than wait for work still in flight.
      process.exitCode = await coordinatorWrapper(getConfig, {
        ...(o.recover ? { startupPrompt: RECOVERY_PROMPT } : {}),
        onStart: async (c, l, stop) => {
          // Restart/crash recovery: drop the scratch dirs of leases that ended (active ones keep theirs).
          await sweepScratchOnStart(getDb(), runtimePaths(), l);
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
      const r = await syncCoordinator(await getConfig(), {
        activeLeases: () => d.activeLeases(),
        recordRestart: (info) => d.setMeta('coordinator_restart', JSON.stringify(info)),
        lock: d,
      }, o);
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `coordinator: ${x.action} (${x.reason})` });
    }));
  coord.command('restart').description('Kill the coordinator session and relaunch it detached (container only; used by the host upgrade)')
    .option('--recover', 'start with the recovery prompt: reconcile leases, re-dispatch, resume the queue')
    .option('--force', 'restart even while worker leases are active (they stay recorded for recovery)')
    .action(action(async (o: { force?: boolean; recover?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const d = getDb();
      const r = await restartCoordinator(await getConfig(), {
        activeLeases: () => d.activeLeases(),
        recordRestart: coordinatorRestartRecorder(d),
        lock: d,
      }, o);
      emit(r, { json: globalOpts(cmd).json, human: (x: typeof r) => `coordinator: ${x.action} (${x.reason})` });
    }));

  // telegram: credential-free capability probe. Host mode delegates to the container, where Claude Code runs.
  const tg = program.command('telegram').description('Telegram channel plugin support (docs/design/telegram.md)');
  tg.command('probe').description('Report whether the official Telegram channel plugin is usable (needs no credentials)')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      emit(await probeTelegram(), { json: globalOpts(cmd).json, human: formatTelegramProbe });
    }));
  tg.command('install').description('Install the official Telegram channel plugin at user scope in the claude volume (needs network, no login)')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      if (runtimeMode() === 'host-runtime') {
        throw new MinionsError('PRECONDITION', 'The Telegram channel is not available in the host runtime: it would install a plugin into your own Claude Code setup, and the host runtime starts Claude Code without user settings, plugins or MCP servers.',
          'Use the Docker runtime for Telegram (`minions runtime set docker`), or keep the terminal channel.');
      }
      const r = await installTelegramPlugin();
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [`marketplace ${d.marketplace}; plugin ${d.plugin} (version ${d.version ?? 'unknown'})`, ...d.warnings.map((w) => `warning: ${w}`)].join('\n') });
    }));
  tg.command('status').description('Pairing/allowlist policy and whether the running coordinator has Telegram (no codes, ids or tokens)')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const paths = runtimePaths();
      const r = { access: await readTelegramAccess(paths.telegramStateDir), coordinator: await readLaunchRecord(paths) };
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [
        `access: ${d.access.state} - ${d.access.detail}${d.access.hint ? `\n  hint: ${d.access.hint}` : ''}`,
        `coordinator: ${d.coordinator ? (d.coordinator.telegram.enabled ? 'Telegram enabled' : `terminal only (${d.coordinator.telegram.reason})`) : 'no launch recorded'}`,
      ].join('\n') });
    }));

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

  // sync: one-shot GitHub intake import (when intake.github is enabled) plus a refresh of PR state and
  // CI check results (no polling loop); host delegates.
  program.command('sync [taskIds...]').description('Import issues matching intake.github into the backlog (when enabled), refresh pull-request state and CI check results for tasks with a PR; reconcile merged/closed PRs; with delivery.merge auto-when-eligible, arm/disarm GitHub auto-merge for PRs that pass every gate')
    .action(action(async (taskIds: string[], _o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const { db: d, backlog: b, config: cfg } = await context();
      // Intake runs on a full sync only (`minions sync <taskIds>` refreshes just those PRs).
      const intake = taskIds.length ? null : await runIntakeSync();
      // Auto-merge (delivery.merge "auto-when-eligible") runs here, through the runtime's own gates.
      const sched = await scheduler();
      const r: SyncReport & { intake: IntakeSyncReport | null } = { ...(await syncTasks({ db: d, backlog: b, config: cfg, merge: (id) => sched.autoMerge(id) }, { taskIds })), intake };
      emit(r, { json: globalOpts(cmd).json, human: (x) => [...(x.intake?.enabled ? [formatIntake(x.intake)] : []), formatSync(x)].join('\n') });
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
        const h = await hostStatus({ cwd: process.cwd() });
        if (h.kind === 'delegate') return delegate(cmd);
        if (h.kind === 'raw') {
          if (h.result.stdout) process.stdout.write(h.result.stdout);
          if (h.result.stderr) process.stderr.write(h.result.stderr);
          process.exitCode = h.result.code || 1;
          return;
        }
        emit({ ...h.status, restartRequired: h.restartRequired }, { json: globalOpts(cmd).json, human: () => {
          let base: string;
          try { base = humanStatus(h.status as unknown as StatusReport); } catch { base = JSON.stringify(h.status, null, 2); }
          return [base, ...formatRestartRequired(h.restartRequired)].join('\n');
        } });
        return;
      }
      const cfg = await getConfig();
      const r = await collectStatus({ db: getDb(), config: cfg, backlog: getBacklog, channel: () => runtimeChannelStatus(cfg), launch: () => coordinatorLaunchStatus(cfg) });
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
