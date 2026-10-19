import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { setIdempotencyStore, setReadyContext } from '../backlog/commands.js';
import { openBacklog, writeBacklogConfig } from '../backlog/factory.js';
import type { BacklogAdapter, IdempotencyStore } from '../backlog/types.js';
import { validateConfig } from '../config/resolve.js';
import type { MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode, runtimeMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { readJson } from '../core/fsutil.js';
import { emit } from '../core/output.js';
import { delegateToContainer } from '../host/delegate.js';
import { buildCoordinatorCommand, launchCoordinator, probeRuntime } from './coordinator.js';
import { openDb, type Lease, type LeaseRole, type RuntimeDb } from './db.js';
import { runHook } from './hooks.js';
import { runtimePaths } from './paths.js';
import { capacityOf, LEASE_ROLES, Scheduler } from './scheduler.js';
import { exportWorkspace, importWorkspace, setupState } from './workspace.js';
import { workspaceLayout } from './worktree.js';

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
  return (backlog ??= openBacklog(await getConfig(), { idempotency: lazyIdempotency, root: runtimePaths().backlog }));
}

async function context() {
  const cfg = await getConfig();
  return { config: cfg, db: getDb(), backlog: await getBacklog() };
}

const scheduler = async () => new Scheduler({ ...(await context()), layout: workspaceLayout() });

async function readInput(file?: string): Promise<string> {
  if (file && file !== '-') return readFile(file, 'utf8');
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', 'Expected the worker result on stdin.', 'Pipe the JSON in or pass --result-file <path>.');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const leaseLine = (l: Lease) => `${l.id}  ${l.task_id.padEnd(10)} ${l.role.padEnd(9)} #${l.attempt} ${l.status.padEnd(11)} ${l.branch ?? '-'}  ${l.worktree ?? '-'}`;

// ---------------------------------------------------------------- status

export interface StatusReport {
  paused: { intake: boolean; starts: boolean };
  configRevision: number;
  profile: string;
  deliveryMode: string;
  queue: Record<string, number>;
  activeLeases: Pick<Lease, 'id' | 'task_id' | 'role' | 'attempt' | 'branch' | 'worktree' | 'head_sha' | 'started_at'>[];
  capacity: { activeTasks: number; maxActiveTasks: number; activeEngineers: number; maxEngineers: number } | null;
  guard: { lastReason: string | null; updatedAt: string | null };
  coordinatorLock: unknown;
  backlogError?: string;
}

export async function collectStatus(deps: { db: RuntimeDb; config: MinionsConfig; backlog: () => Promise<BacklogAdapter> }): Promise<StatusReport> {
  const { db: d, config: cfg } = deps;
  const leases = d.activeLeases();
  const report: StatusReport = {
    paused: d.paused(), configRevision: cfg.configRevision, profile: cfg.profile, deliveryMode: cfg.delivery.mode,
    queue: {}, capacity: null,
    activeLeases: leases.map((l) => ({ id: l.id, task_id: l.task_id, role: l.role, attempt: l.attempt, branch: l.branch, worktree: l.worktree, head_sha: l.head_sha, started_at: l.started_at })),
    guard: { lastReason: d.guard().last_reason, updatedAt: d.guard().updated_at },
    coordinatorLock: d.coordinatorLock() ?? null,
  };
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

function humanStatus(s: StatusReport): string {
  const out = [
    `config revision ${s.configRevision}  profile ${s.profile}  delivery ${s.deliveryMode}`,
    `paused: intake=${s.paused.intake} starts=${s.paused.starts}`,
    s.capacity ? `capacity: ${s.capacity.activeTasks}/${s.capacity.maxActiveTasks} tasks, ${s.capacity.activeEngineers}/${s.capacity.maxEngineers} engineers` : 'capacity: unknown',
    `queue: ${Object.entries(s.queue).map(([k, v]) => `${k}=${v}`).join(' ') || '(empty)'}`,
    `stop guard: ${s.guard.lastReason ?? '-'}`,
  ];
  if (s.backlogError) out.push(`backlog error: ${s.backlogError}`);
  out.push(s.activeLeases.length ? 'active leases:' : 'active leases: none', ...s.activeLeases.map((l) => `  ${l.id} ${l.task_id} ${l.role} #${l.attempt} ${l.branch ?? ''}`));
  return out.join('\n');
}

/** Host mode: run the same command inside the container and exit with its code. */
async function delegate(cmd: Command): Promise<void> {
  const code = await delegateToContainer(process.argv.slice(2), { json: globalOpts(cmd).json });
  process.exit(code);
}

// ---------------------------------------------------------------- register

/** Registers runtime commands on the root program. */
export function register(program: Command): void {
  if (runtimeMode() === 'container') {
    // Give `backlog ...` the lease/pause view and DB-backed idempotency (lazy: no DB opened until used).
    setIdempotencyStore(lazyIdempotency);
    setReadyContext(() => {
      const d = getDb();
      return { leased: new Set(d.activeLeases().map((l) => l.task_id)), paused: d.paused().starts };
    });
  }

  // work
  const work = program.command('work').description('Claim, record and release worker leases (container only)');
  work.command('claim <taskId>').description('Claim a task for a worker role; returns the task brief')
    .requiredOption('--role <role>', 'engineer | tester | reviewer')
    .option('--holder <holder>', 'who holds the lease (default: this process)')
    .action(action(async (taskId: string, o: { role: string; holder?: string }, cmd: Command) => {
      requireMode('container');
      if (!(LEASE_ROLES as readonly string[]).includes(o.role)) throw new MinionsError('PRECONDITION', `--role must be engineer, tester or reviewer (got ${o.role}).`);
      const brief = await (await scheduler()).claim(taskId, o.role as LeaseRole, { holder: o.holder });
      emit(brief, { json: globalOpts(cmd).json, human: (b) => `${b.briefMarker}\n${JSON.stringify(b, null, 2)}` });
    }));
  work.command('record <leaseId>').description('Record a worker result (JSON on stdin or --result-file)')
    .option('--result-file <path>', 'read the WorkerResult from a file ("-" = stdin)')
    .option('--correction', 'the single allowed correction after an invalid result')
    .action(action(async (leaseId: string, o: { resultFile?: string; correction?: boolean }, cmd: Command) => {
      requireMode('container');
      const raw = await readInput(o.resultFile);
      const r = await (await scheduler()).record(leaseId, raw, { correction: !!o.correction });
      emit(r, { json: globalOpts(cmd).json, human: (d) => [d.message, ...(d.errors ?? []).map((e: string) => `  - ${e}`)].join('\n') });
    }));
  work.command('release <leaseId>').description('Release a lease without a result (worktree is kept)')
    .requiredOption('--reason <text>', 'why the lease is released')
    .action(action(async (leaseId: string, o: { reason: string }, cmd: Command) => {
      requireMode('container');
      const r = await (await scheduler()).release(leaseId, o.reason);
      emit(r, { json: globalOpts(cmd).json, human: (d) => `Released ${d.leaseId} (${d.taskId}); worktree kept at ${d.worktree ?? '-'}` });
    }));
  work.command('list').description('List active leases')
    .option('--all', 'include ended leases')
    .action(action(async (o: { all?: boolean }, cmd: Command) => {
      requireMode('container');
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

  // coordinator
  program.command('coordinator').description('Launch or attach the coordinator Claude Code session (tmux)')
    .option('--print-command', 'print the launch argv without running it')
    .option('--probe', 'check that Claude Code and tmux support the launch flags, then exit')
    .action(action(async (o: { printCommand?: boolean; probe?: boolean }, cmd: Command) => {
      const cfg = await getConfig();
      if (o.probe) {
        const r = { ...(await probeRuntime()), command: await buildCoordinatorCommand(cfg) };
        emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => `Claude Code ${d.claudeVersion}, ${d.tmuxVersion}: launch flags supported` });
        return;
      }
      if (o.printCommand) {
        emit(await buildCoordinatorCommand(cfg), { json: globalOpts(cmd).json, human: (c) => JSON.stringify([c.cmd, ...c.args]) });
        return;
      }
      requireMode('container');
      process.exitCode = await launchCoordinator(cfg);
    }));

  // workspace
  const ws = program.command('workspace').description('Container workspace and state setup (container only)');
  ws.command('setup').description('Create /state layout, runtime DB and Backlog.md config (idempotent)')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('container');
      const r = await setupState(runtimePaths(), writeBacklogConfig);
      emit(r, { json: globalOpts(cmd).json, human: (d) => `State ready at ${d.state} (schema ${d.schemaVersion}); backlog config ${d.backlogConfig.changed ? 'written' : 'unchanged'}` });
    }));
  ws.command('import <bundlePath>').description('Clone or refresh /workspace/repo from a git bundle')
    .requiredOption('--base <branch>', 'base branch')
    .option('--remote-url <url>', 'origin URL to record (not fetched)')
    .action(action(async (bundle: string, o: { base: string; remoteUrl?: string }, cmd: Command) => {
      requireMode('container');
      const r = await importWorkspace(bundle, { base: o.base, remoteUrl: o.remoteUrl, config: await getConfig() });
      emit(r, { json: globalOpts(cmd).json, human: (d) => `${d.imported ? 'Cloned' : 'Refreshed'} ${d.repo} at ${d.head} (base ${d.base})` });
    }));
  ws.command('export <outPath>').description('Write a bundle with the base branch and agent/* branches')
    .action(action(async (out: string, _o: unknown, cmd: Command) => {
      requireMode('container');
      const r = await exportWorkspace(out, { base: (await getConfig()).git.baseBranch });
      emit(r, { json: globalOpts(cmd).json, human: (d) => `Wrote ${d.path}\n${d.refs.join('\n')}` });
    }));

  // status / pause / resume (host mode delegates to the container)
  program.command('status').description('Show queue, workers, pause state, config revision and delivery mode')
    .action(action(async (_o: unknown, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const r = await collectStatus({ db: getDb(), config: await getConfig(), backlog: getBacklog });
      emit(r, { json: globalOpts(cmd).json, human: humanStatus });
    }));
  const pauseLike = (name: 'pause' | 'resume') => program.command(name)
    .description(name === 'pause' ? 'Pause intake and/or new starts (default: both)' : 'Resume intake and/or new starts (default: both)')
    .option('--intake', 'only intake')
    .option('--starts', 'only new task starts')
    .action(action(async (o: { intake?: boolean; starts?: boolean }, cmd: Command) => {
      if (runtimeMode() === 'host') return delegate(cmd);
      const both = !o.intake && !o.starts;
      const value = name === 'pause';
      const paused = getDb().setPaused({ intake: both || o.intake ? value : undefined, starts: both || o.starts ? value : undefined });
      emit({ paused }, { json: globalOpts(cmd).json, human: (d) => `paused: intake=${d.paused.intake} starts=${d.paused.starts}` });
    }));
  pauseLike('pause');
  pauseLike('resume');
}
