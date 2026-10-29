// The local integrator (docs/design/local-auto-integration.md phase 2, task-82.2): the integration queue, its lock,
// the verify runner in the persistent integration worktree, and crash recovery. It drives the phase 1 engine
// (./integration.ts) and is run by the hidden `minions work integrate`. Phase 3 (task-82.3) wires it up: a local
// approval with local integration on queues the head and starts the integrator detached (Scheduler.record,
// startIntegratorDetached), and onSettled moves the task (Scheduler.settleIntegration: landed -> done, a failure
// -> changes-requested with an integrator finding, awaiting-approval -> awaiting-human).
//
// Architecture decisions (task-82.2):
// - Lock: meta row `integration_lock` {pid, start, bootId, at}, taken in one IMMEDIATE transaction, with the
//   supervisor's liveness rule (pid, start time, boot, and a `work integrate` command line where /proc, or `ps` on macOS, shows one).
//   Whoever holds the lock is the only integrator, so at start every row in a running phase (merging, verifying,
//   landing) belongs to a dead holder and is recovered.
// - Record: one `integrations` row per queued (task, head). `phase` is its state: queued -> merging -> verifying ->
//   landing -> landed, or a terminal conflict | red | refused | awaiting-approval | transient. A stop (drain,
//   signal), a moved base, a dirty checkout and recovery put the row back to `queued` without counting an attempt;
//   `outcome` and `detail` keep why. `attempt` counts runs; a transient failure (timeout, setup failure, git error)
//   is retried once (MAX_INTEGRATION_ATTEMPTS), then the row ends `transient`.
// - Base: meta `integration_base` is the last SHA the integrator landed or adopted. A fast-forward of the base made
//   outside the integrator is adopted (`integration-base-adopted` event); anything else halts the queue (meta
//   `integration_halted`) until `work integrate --adopt-base`. Fail closed.
// - Verify runner: the detached worktree `/workspace/integration` (recreated when missing or broken), reset with
//   `checkout --detach --force C` and `clean -ffdx -e node_modules` (hardened git, never in /workspace/repo).
//   verification.setupCommands run only when they or the lockfile hash changed since the last successful setup.
//   Each command runs as `sh -c` in its own process group (runner/supervise.ts) with the per-command timeout
//   delivery.integrationTimeoutMinutes and an allowlisted env: PATH, LANG, TZ, CI=1, MINIONS_TEST_MAX_WORKERS=2,
//   a fresh HOME, MINIONS_HOME and TMPDIR under <state>/run/integration (no coordinator or Telegram secrets).
//   Output goes to <state>/logs/integration/<task>-<row>.log; the tail goes into the row's detail.
//   A failing command is `red`; a timeout, a spawn error or a setup failure is transient.
// - Pause and drain: while starts are paused or a drain is active no new integration starts. A drain (or SIGTERM)
//   stops a running verification at once (its group is killed) and re-queues the row without an attempt; only the
//   landing (two git calls) is allowed to finish.
// - Recovery: the recorded verify group is stopped only while its leader still matches the record (pid, start
//   time, boot); then, when the base contains the recorded candidate C, the row is `landed` (the crash came after
//   the swap) and integration_base = C; otherwise it is re-queued. /workspace/repo is never touched.
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, type WriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { can } from '../config/capabilities.js';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { redact } from '../core/output.js';
import { FULL_SHA, withEmptyHome } from './base-update.js';
import type { RuntimeDb, SupervisorLock } from './db.js';
import { allowlistedGit, gateGit } from './git-hardening.js';
import { enqueue } from './outbox.js';
import { checkoutGit, integrationCandidate, integrationChangedPaths, land, revertOfRevertCheck } from './integration.js';
import { groupMembers, hostIdentity, isAlive, procIdentity, type ProcSource } from './runner/record.js';
import { supervise, type StopReason } from './runner/supervise.js';
import { systemLockView, type LockProcessView } from './supervisor.js';

export const INTEGRATION_LOCK_META = 'integration_lock';
export const INTEGRATION_BASE_META = 'integration_base';
export const INTEGRATION_HALT_META = 'integration_halted';
/** Counted runs of one queued integration: the first plus one automatic retry of a transient failure. */
export const MAX_INTEGRATION_ATTEMPTS = 2;
export const DEFAULT_INTEGRATION_TIMEOUT_MINUTES = 30;
/** `outcome` of a landed row whose verification passed only on a rerun of a failed command (Decision 2). */
export const FLAKY_OUTCOME = 'landed-flaky';
/** Test workers of the gate's verification (design: fixed configuration). */
export const INTEGRATION_TEST_WORKERS = '2';
/** Lockfiles whose content decides whether verification.setupCommands run again. */
export const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

export const OPEN_PHASES = ['queued', 'merging', 'verifying', 'landing'] as const;
export const RUNNING_PHASES = ['merging', 'verifying', 'landing'] as const;
export const TERMINAL_PHASES = ['landed', 'conflict', 'red', 'refused', 'awaiting-approval', 'transient'] as const;
export type IntegrationPhase = (typeof OPEN_PHASES)[number] | (typeof TERMINAL_PHASES)[number];

export interface IntegrationRow {
  id: number; task_id: string; branch: string; head_sha: string; base_sha: string | null; candidate_sha: string | null;
  phase: IntegrationPhase; attempt: number; verify_pid: number | null; verify_start: string | null; verify_boot: string | null;
  queued_at: string; started_at: string | null; ended_at: string | null; outcome: string | null; detail: string | null; log_path: string | null;
}

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
const DETAIL_MAX = 3_000;
const clip = (s: string) => redact(s).slice(-DETAIL_MAX);

// ---------------------------------------------------------------- queue

/**
 * Queues the integration of the approved head `head` of `taskId`. Idempotent for the same head. A queued row of
 * another head is moved to the new head (attempts reset); a running one is a CONFLICT (stop it first).
 */
export function enqueueIntegration(db: RuntimeDb, o: { taskId: string; branch: string; head: string }, now: Date = new Date()): IntegrationRow {
  if (!FULL_SHA.test(o.head)) throw new MinionsError('PRECONDITION', `the approved head must be a full SHA, not ${JSON.stringify(o.head)}`);
  return db.transaction(() => {
    const open = openIntegration(db, o.taskId);
    if (open && open.head_sha === o.head && open.branch === o.branch) return open;
    if (open && open.phase !== 'queued') throw new MinionsError('CONFLICT', `the integration of ${o.taskId} (${open.head_sha.slice(0, 12)}) is ${open.phase}; it cannot be re-queued for another head now`);
    if (open) {
      db.exec('UPDATE integrations SET head_sha = ?, branch = ?, attempt = 0, queued_at = ?, outcome = NULL, detail = NULL WHERE id = ?', o.head, o.branch, now.toISOString(), open.id);
    } else {
      db.exec('INSERT INTO integrations (task_id, branch, head_sha, phase, attempt, queued_at) VALUES (?, ?, ?, \'queued\', 0, ?)', o.taskId, o.branch, o.head, now.toISOString());
    }
    const row = openIntegration(db, o.taskId)!;
    db.addEvent('integration-queued', o.taskId, { id: row.id, head: o.head, branch: o.branch });
    return row;
  });
}

export const openIntegration = (db: RuntimeDb, taskId: string): IntegrationRow | null =>
  db.get<IntegrationRow>(`SELECT * FROM integrations WHERE task_id = ? AND phase IN (${inList(OPEN_PHASES)}) ORDER BY id DESC LIMIT 1`, taskId) ?? null;
export const integrationRows = (db: RuntimeDb, taskId?: string): IntegrationRow[] => taskId
  ? db.all<IntegrationRow>('SELECT * FROM integrations WHERE task_id = ? ORDER BY id', taskId)
  : db.all<IntegrationRow>('SELECT * FROM integrations ORDER BY id');
/** Queued integrations, oldest first. */
export const integrationQueue = (db: RuntimeDb): IntegrationRow[] =>
  db.all<IntegrationRow>("SELECT * FROM integrations WHERE phase = 'queued' ORDER BY queued_at, id");
const getRow = (db: RuntimeDb, id: number) => db.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', id)!;

export interface IntegrationHalt { reason: string; at: string; base: string | null; expected: string | null }
export function integrationHalt(db: RuntimeDb): IntegrationHalt | null {
  try { const v = db.getMeta(INTEGRATION_HALT_META); return v ? JSON.parse(v) as IntegrationHalt : null; } catch { return { reason: 'unreadable halt record', at: '', base: null, expected: null }; }
}

// ---------------------------------------------------------------- lock

export type IntegrationLock = SupervisorLock;
const INTEGRATOR_CMDLINE = /(^|[\s/])work\s+integrate(\s|$)/;

/** Whether an integration lock holder still runs (the supervisor rule: pid, boot, start time, `work integrate`). */
export function integratorAlive(l: IntegrationLock, pc: LockProcessView = systemLockView): boolean {
  if (!pc.alive(l.pid)) return false;
  const boot = pc.bootId();
  if (l.bootId && boot && l.bootId !== boot) return false;
  if (l.start) {
    const s = pc.startTime(l.pid);
    if (s !== null && s !== l.start) return false;
  }
  const cmd = pc.cmdline(l.pid);
  return cmd === null || INTEGRATOR_CMDLINE.test(cmd);
}

export function integrationLock(db: RuntimeDb): IntegrationLock | null {
  try {
    const v = db.getMeta(INTEGRATION_LOCK_META);
    const l = v ? JSON.parse(v) as IntegrationLock : null;
    return l && typeof l.pid === 'number' ? { pid: l.pid, start: l.start ?? null, bootId: l.bootId ?? null, at: String(l.at) } : null;
  } catch { return null; }
}

export type IntegrationLockState = { state: 'none'; lock: null } | { state: 'live' | 'stale'; lock: IntegrationLock };
export function integrationLockState(db: RuntimeDb, pc: LockProcessView = systemLockView): IntegrationLockState {
  const lock = integrationLock(db);
  if (!lock) return { state: 'none', lock: null };
  return { state: integratorAlive(lock, pc) ? 'live' : 'stale', lock };
}

/** Takes the lock unless a live holder (by `alive`) has it; returns the lock taken and the one it replaced. */
export function acquireIntegrationLock(db: RuntimeDb, me: Omit<IntegrationLock, 'at'>, alive: (l: IntegrationLock) => boolean, now: Date = new Date()): { lock: IntegrationLock; replaced: IntegrationLock | null } | null {
  return db.transaction(() => {
    const cur = integrationLock(db);
    if (cur && !(cur.pid === me.pid && cur.start === me.start && cur.bootId === me.bootId) && alive(cur)) return null;
    const lock: IntegrationLock = { pid: me.pid, start: me.start, bootId: me.bootId, at: now.toISOString() };
    db.setMeta(INTEGRATION_LOCK_META, JSON.stringify(lock));
    db.addEvent('integration-lock', null, { ...lock, replaced: cur });
    return { lock, replaced: cur };
  });
}

export function releaseIntegrationLock(db: RuntimeDb, lock: Pick<IntegrationLock, 'pid' | 'at'>): boolean {
  return db.transaction(() => {
    const cur = integrationLock(db);
    if (!cur || cur.pid !== lock.pid || cur.at !== lock.at) return false;
    db.deleteMeta(INTEGRATION_LOCK_META);
    return true;
  });
}

// ---------------------------------------------------------------- verify runner

export interface VerifyTiming {
  /** Per command; default delivery.integrationTimeoutMinutes. */
  commandTimeoutMs?: number;
  /** How often a running command checks for a drain or stop (default 2 s). */
  pollMs?: number;
  /** SIGTERM -> SIGKILL of a stopped command (default 15 s). */
  killGraceMs?: number;
}

/** A verification command that failed once and passed on its one rerun (Decision 2: a flaky notice, no repair cycle). */
export interface FlakyCommand { command: string; detail: string }

export type VerifyResult =
  | { state: 'passed'; flaky?: FlakyCommand[] }
  | { state: 'red'; command: string; detail: string }
  | { state: 'transient'; detail: string }
  | { state: 'stopped' };

export interface VerifyInput {
  repo: string;
  /** The persistent integration worktree. */
  dir: string;
  /** <state>/run/integration: setup hash, fresh HOME, MINIONS_HOME, TMPDIR. */
  runDir: string;
  candidate: string;
  setupCommands: string[];
  commands: string[];
  timeoutMs: number;
  logPath: string;
  /** Base env (PATH, LANG and TZ are read from it; nothing else). */
  env?: NodeJS.ProcessEnv;
  timing?: VerifyTiming;
  /** Polled while a command runs: true stops it (drain, signal). */
  shouldStop: () => boolean | Promise<boolean>;
  /** The command's process group leader exists (pid = pgid). */
  onSpawn?: (pid: number) => void | Promise<void>;
  /** Rerun a failed verification command once before it counts as red (Decision 2; default true). */
  rerunFailed?: boolean;
}

/** The allowlisted env of a verification command (see the header). */
export function verifyEnv(base: NodeJS.ProcessEnv, runDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH || '/usr/local/bin:/usr/bin:/bin',
    CI: '1',
    MINIONS_TEST_MAX_WORKERS: INTEGRATION_TEST_WORKERS,
    HOME: join(runDir, 'home'),
    MINIONS_HOME: join(runDir, 'minions-home'),
    TMPDIR: join(runDir, 'tmp'),
  };
  for (const k of ['LANG', 'TZ'] as const) if (base[k]) env[k] = base[k]!;
  return env;
}

/** sha256 of the setup commands and the lockfiles in `dir` (missing files count as absent). */
export function setupHash(dir: string, setupCommands: string[]): string {
  const h = createHash('sha256').update(JSON.stringify(setupCommands));
  for (const f of LOCKFILES) {
    const p = join(dir, f);
    h.update(`\0${f}\0`);
    if (existsSync(p)) { try { h.update(readFileSync(p)); } catch { h.update('\0unreadable'); } }
  }
  return h.digest('hex');
}

/** -c options of the worktree creation in the repository: no hooks, replace refs or fsmonitor. */
const ADD_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.useReplaceRefs=false', '-c', 'core.fsmonitor=false'];

async function isWorktreeOf(repo: string, dir: string): Promise<boolean> {
  if (!existsSync(join(dir, '.git'))) return false;
  const [a, b] = await Promise.all([
    gateGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true),
    gateGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true),
  ]);
  return a.code === 0 && b.code === 0 && a.stdout.trim() === b.stdout.trim();
}

/** (Re)creates the detached integration worktree when needed, then resets it to exactly `candidate`. */
export async function prepareIntegrationWorktree(repo: string, dir: string, candidate: string): Promise<{ ok: true; recreated: boolean } | { ok: false; message: string }> {
  return withEmptyHome(async (home) => {
    const reset = async (): Promise<string | null> => {
      const co = await checkoutGit(dir, ['checkout', '--detach', '--force', '--quiet', candidate], home);
      if (co.code !== 0) return `git checkout ${candidate.slice(0, 12)} failed: ${co.stderr.trim().slice(-400) || `exit ${co.code}`}`;
      const cl = await checkoutGit(dir, ['clean', '-ffdx', '--quiet', '-e', 'node_modules'], home);
      if (cl.code !== 0) return `git clean failed: ${cl.stderr.trim().slice(-400) || `exit ${cl.code}`}`;
      const head = await gateGit(dir, ['rev-parse', 'HEAD'], true);
      return head.code === 0 && head.stdout.trim() === candidate ? null : `the integration worktree is at ${head.stdout.trim().slice(0, 12) || '(unknown)'}, not ${candidate.slice(0, 12)}`;
    };
    let problem: string | null = 'missing';
    if (await isWorktreeOf(repo, dir)) problem = await reset();
    if (!problem) return { ok: true, recreated: false };
    // Missing or broken: recreate it once.
    await rm(dir, { recursive: true, force: true });
    await allowlistedGit(repo, ['worktree', 'prune'], true, { home });
    const add = await allowlistedGit(repo, [...ADD_CONFIG, 'worktree', 'add', '--detach', '--no-checkout', '--force', dir, candidate], true, { home });
    if (add.code !== 0) return { ok: false, message: `git worktree add ${dir} failed: ${add.stderr.trim().slice(-400) || `exit ${add.code}`}` };
    const again = await reset();
    return again ? { ok: false, message: again } : { ok: true, recreated: true };
  });
}

type CommandOutcome = { state: 'passed' } | { state: 'failed'; code: number | null; signal: string | null } | { state: 'timeout' } | { state: 'stopped' } | { state: 'spawn-error'; message: string };

const TAIL_LINES = 30;

async function runOne(cmd: string, i: VerifyInput, log: WriteStream, tail: string[]): Promise<CommandOutcome> {
  log.write(`\n$ ${cmd}\n`);
  const t = i.timing ?? {};
  const out = await supervise(
    { argv: ['sh', '-c', `exec 2>&1\n${cmd}`], cwd: i.dir, env: verifyEnv(i.env ?? process.env, i.runDir), stdin: null },
    { timeoutMs: i.timeoutMs, pollMs: t.pollMs ?? 2_000, killGraceMs: t.killGraceMs ?? 15_000, interruptGraceMs: 0, drainGraceMs: 0 },
    {
      onSpawn: async (pid) => { await i.onSpawn?.(pid); },
      onLine: (line) => { log.write(line + '\n'); tail.push(line); if (tail.length > TAIL_LINES) tail.shift(); },
      poll: async (): Promise<StopReason | null> => (await i.shouldStop()) ? 'drain' : null,
    },
  );
  if (out.spawnError && out.code === null) return { state: 'spawn-error', message: out.spawnError };
  if (out.stopped === 'timeout') return { state: 'timeout' };
  if (out.stopped) return { state: 'stopped' };
  return out.code === 0 ? { state: 'passed' } : { state: 'failed', code: out.code, signal: out.signal };
}

/** Runs the gate on `candidate` (see the header). Never throws. */
export async function runVerification(i: VerifyInput): Promise<VerifyResult> {
  let log: WriteStream | null = null;
  try {
    await mkdir(join(i.logPath, '..'), { recursive: true });
    log = createWriteStream(i.logPath, { flags: 'a' });
    log.on('error', () => undefined);
    log.write(`# ${new Date().toISOString()} integration of ${i.candidate}\n`);
    const prep = await prepareIntegrationWorktree(i.repo, i.dir, i.candidate);
    if (!prep.ok) return { state: 'transient', detail: `the integration worktree could not be prepared: ${prep.message}` };
    // The setup marker describes the worktree it was made in: a recreated worktree (node_modules gone) runs setup again.
    const hashFile = join(i.runDir, 'setup-hash');
    if (prep.recreated) await rm(hashFile, { force: true });
    for (const sub of ['home', 'minions-home', 'tmp']) {
      await rm(join(i.runDir, sub), { recursive: true, force: true });
      await mkdir(join(i.runDir, sub), { recursive: true });
    }
    const tail: string[] = [];
    const minutes = `${Math.round(i.timeoutMs / 60_000 * 10) / 10} min`;
    if (i.setupCommands.length) {
      const hash = setupHash(i.dir, i.setupCommands);
      const done = await readFile(hashFile, 'utf8').then((s) => s.trim(), () => '');
      if (done !== hash) {
        await rm(hashFile, { force: true });
        for (const cmd of i.setupCommands) {
          const r = await runOne(cmd, i, log, tail);
          if (r.state === 'stopped') return r;
          if (r.state !== 'passed') {
            const why = r.state === 'timeout' ? `timed out after ${minutes}` : r.state === 'spawn-error' ? `could not start: ${r.message}` : `failed (${r.signal ?? `exit ${r.code}`})`;
            return { state: 'transient', detail: clip(`setup command \`${cmd}\` ${why}\n${tail.join('\n')}`) };
          }
        }
        await writeFile(hashFile, hash + '\n');
      }
    }
    const flaky: FlakyCommand[] = [];
    for (const cmd of i.commands) {
      tail.length = 0;
      const r = await runOne(cmd, i, log, tail);
      if (r.state === 'passed') continue;
      if (r.state === 'stopped') return r;
      if (r.state === 'timeout') return { state: 'transient', detail: clip(`\`${cmd}\` timed out after ${minutes}\n${tail.join('\n')}`) };
      if (r.state === 'spawn-error') return { state: 'transient', detail: clip(`\`${cmd}\` could not start: ${r.message}`) };
      const first = clip(`\`${cmd}\` failed (${r.signal ?? `exit ${r.code}`})\n${tail.join('\n')}`);
      // Decision 2: a failed command is rerun once, in place (same tree, nothing reset). A pass on the rerun
      // continues (the landing carries a flaky notice); a second failure (or a rerun that does not finish) is red.
      if (i.rerunFailed === false) return { state: 'red', command: cmd, detail: first };
      log.write(`\n# ${cmd} failed; rerunning it once (flaky check)\n`);
      tail.length = 0;
      const again = await runOne(cmd, i, log, tail);
      if (again.state === 'stopped') return again;
      if (again.state === 'passed') { flaky.push({ command: cmd, detail: first }); continue; }
      const why = again.state === 'failed' ? `failed again on its rerun (${again.signal ?? `exit ${again.code}`})` : again.state === 'timeout' ? `timed out on its rerun after ${minutes}` : `could not start on its rerun: ${again.message}`;
      return { state: 'red', command: cmd, detail: clip(`\`${cmd}\` failed twice: ${why}\n${tail.join('\n')}`) };
    }
    return flaky.length ? { state: 'passed', flaky } : { state: 'passed' };
  } catch (e) {
    return { state: 'transient', detail: clip(`the verification did not run: ${(e as Error)?.message ?? e}`) };
  } finally {
    await new Promise<void>((r) => (log ? log.end(r) : r()));
  }
}

// ---------------------------------------------------------------- recovery

export interface ReapVerifyOptions { proc?: ProcSource; kill?: (pid: number, sig: NodeJS.Signals) => void; graceMs?: number; sleep?: (ms: number) => Promise<void> }
const defaultKill = (pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* gone */ } };
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Stops the verification group recorded on `row`, only while its leader still matches the record (pid, start
 * time, boot): a reused pid is left alone, and the group is swept only when the leader matched. Returns the pids
 * signalled.
 */
export async function reapVerifyGroup(row: Pick<IntegrationRow, 'verify_pid' | 'verify_start' | 'verify_boot'>, o: ReapVerifyOptions = {}): Promise<number[]> {
  const proc = o.proc ?? '/proc';
  const kill = o.kill ?? defaultKill;
  const sleep = o.sleep ?? sleepMs;
  if (!row.verify_pid || !row.verify_start) return [];
  const host = await hostIdentity(proc);
  if (row.verify_boot && host && host.bootId !== row.verify_boot) return [];
  const leader = { pid: row.verify_pid, startTime: row.verify_start };
  if (!(await isAlive(leader, proc))) return [];
  const killed = [leader.pid];
  kill(-leader.pid, 'SIGTERM');
  const grace = o.graceMs ?? 5_000;
  for (let waited = 0; waited < grace && await isAlive(leader, proc); waited += 50) await sleep(50);
  if (await isAlive(leader, proc)) kill(-leader.pid, 'SIGKILL');
  for (const pid of await groupMembers(leader.pid, leader.startTime, proc)) {
    if (pid === process.pid || pid === 1) continue;
    kill(pid, 'SIGKILL');
    killed.push(pid);
  }
  return [...new Set(killed)];
}

// ---------------------------------------------------------------- the integrator

export interface IntegratorDeps {
  db: RuntimeDb;
  /** The repository whose base branch is integrated into (/workspace/repo). */
  repo: string;
  /** The persistent integration worktree (/workspace/integration). */
  integrationDir: string;
  /** <state>/run/integration. */
  runDir: string;
  /** <state>/logs/integration. */
  logDir: string;
  config: () => MinionsConfig | Promise<MinionsConfig>;
  /** Dependencies of the task that are not integrated yet (the task waits). Default: none. */
  unmetDependencies?: (taskId: string) => string[] | Promise<string[]>;
  /** Whether a signed merge approval covers (task, head); asked when base.merge is "ask" for the change (always for sensitive paths). Default: never (fail closed). */
  approved?: (row: IntegrationRow, sensitive: string[]) => boolean | Promise<boolean>;
  /** Called when a row reaches a terminal phase (phase 3 moves the task). Errors are logged, not fatal. */
  onSettled?: (row: IntegrationRow) => void | Promise<void>;
  /** Stops the integrator: a running verification is stopped and re-queued (SIGTERM). */
  signal?: AbortSignal;
  /** Base env of the verification commands (only PATH, LANG and TZ are read). */
  env?: NodeJS.ProcessEnv;
  timing?: VerifyTiming & { reapGraceMs?: number };
  lockAlive?: (l: IntegrationLock) => boolean;
  proc?: ProcSource;
  now?: () => Date;
  log?: (line: string) => void;
}

export type IntegratorExit = 'empty' | 'waiting' | 'conflict' | 'paused' | 'draining' | 'stopped' | 'halted' | 'checkout-dirty' | 'lock-lost';
export interface IntegratorReport {
  exit: IntegratorExit;
  holder: IntegrationLock | null;
  recovered: { id: number; taskId: string; outcome: 'landed' | 'requeued'; killed: number[] }[];
  settled: { id: number; taskId: string; phase: IntegrationPhase }[];
  /** Queued tasks left waiting, with why. */
  waiting: { taskId: string; on: string[] }[];
}

/** Reads refs/heads/<branch> as a full SHA (null when missing). */
async function baseSha(repo: string, branch: string): Promise<string | null> {
  const r = await gateGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], true);
  const s = r.stdout.trim();
  return r.code === 0 && FULL_SHA.test(s) ? s : null;
}
async function isAncestor(repo: string, a: string, b: string): Promise<boolean> {
  return (await gateGit(repo, ['merge-base', '--is-ancestor', a, b], true)).code === 0;
}

/**
 * The hidden `minions work integrate`: takes the lock, recovers what a dead holder left, then integrates the queue
 * one task at a time until it is empty (or every entry waits), a pause, drain or stop, a halt, or a dirty checkout.
 */
export async function runIntegrator(d: IntegratorDeps): Promise<IntegratorReport> {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? (() => undefined);
  const proc = d.proc ?? '/proc';
  const report: IntegratorReport = { exit: 'empty', holder: null, recovered: [], settled: [], waiting: [] };
  const self = await procIdentity(process.pid, proc);
  const host = await hostIdentity(proc);
  const taken = acquireIntegrationLock(d.db, { pid: process.pid, start: self?.startTime ?? null, bootId: host?.bootId ?? null }, d.lockAlive ?? ((l) => integratorAlive(l)), now());
  if (!taken) return { ...report, exit: 'conflict', holder: integrationLock(d.db) };
  const lock = taken.lock;
  report.holder = lock;
  const holdsLock = () => { const cur = integrationLock(d.db); return !!cur && cur.pid === lock.pid && cur.at === lock.at; };
  const stopRequested = () => !!d.signal?.aborted || !!d.db.drain() || !holdsLock();
  const event = (kind: string, row: IntegrationRow, data: Record<string, unknown> = {}) => d.db.addEvent(kind, row.task_id, { id: row.id, head: row.head_sha, ...data });

  const settle = async (row: IntegrationRow, phase: (typeof TERMINAL_PHASES)[number], detail: string | null, extra: Partial<IntegrationRow> = {}): Promise<void> => {
    d.db.transaction(() => {
      d.db.exec('UPDATE integrations SET phase = ?, outcome = ?, detail = ?, ended_at = ?, candidate_sha = COALESCE(?, candidate_sha), verify_pid = NULL, verify_start = NULL, verify_boot = NULL WHERE id = ?',
        phase, extra.outcome ?? phase, detail === null ? null : clip(detail), now().toISOString(), extra.candidate_sha ?? null, row.id);
      event(`integration-${phase}`, row, { base: row.base_sha, candidate: extra.candidate_sha ?? row.candidate_sha, detail: detail?.slice(0, 500) ?? null });
    });
    const done = getRow(d.db, row.id);
    report.settled.push({ id: row.id, taskId: row.task_id, phase });
    log(`minions integrator: ${row.task_id} ${phase}${detail ? `: ${detail.split('\n')[0]}` : ''}`);
    try { await d.onSettled?.(done); } catch (e) { log(`minions integrator: onSettled for ${row.task_id} failed: ${(e as Error).message}`); }
  };
  /** Back to queued; `uncount` drops the attempt this run counted. */
  const requeue = (row: IntegrationRow, outcome: string, detail: string | null, uncount: boolean) => {
    d.db.transaction(() => {
      d.db.exec(`UPDATE integrations SET phase = 'queued', attempt = MAX(0, attempt - ?), outcome = ?, detail = ?, candidate_sha = NULL,
        verify_pid = NULL, verify_start = NULL, verify_boot = NULL WHERE id = ?`, uncount ? 1 : 0, outcome, detail === null ? null : clip(detail), row.id);
      event('integration-requeued', row, { outcome, counted: !uncount, detail: detail?.slice(0, 500) ?? null });
    });
  };
  const transient = async (row: IntegrationRow, detail: string) => {
    const cur = getRow(d.db, row.id);
    if (cur.attempt < MAX_INTEGRATION_ATTEMPTS) requeue(cur, 'transient', detail, false);
    else await settle(cur, 'transient', detail);
  };
  const halt = (reason: string, base: string | null, expected: string | null) => {
    const h: IntegrationHalt = { reason, at: now().toISOString(), base, expected };
    d.db.transaction(() => { d.db.setMeta(INTEGRATION_HALT_META, JSON.stringify(h)); d.db.addEvent('integration-halted', null, h); });
    notice({ key: `integration-halted:${h.at}`, kind: 'blocker', text: `Integration queue halted: ${reason}. Nothing lands until the owner checks it; \`minions work integrate --adopt-base\` takes the current base after that (see \`minions doctor\`).` });
    log(`minions integrator: halted: ${reason}`);
  };
  /** An owner notice (src/runtime/outbox.ts); a failure to queue it never stops the integrator. */
  const notice = (n: { key: string; kind: 'blocker' | 'other'; taskId?: string; text: string }) => {
    try { enqueue(d.db, { ...n, text: n.text.slice(0, 3_900) }, now); } catch (e) { log(`minions integrator: could not queue the notice ${n.key}: ${(e as Error).message}`); }
  };

  try {
    const cfg0 = await d.config();
    // ---- recovery: every running row belongs to a dead holder (we hold the lock now)
    for (const row of d.db.all<IntegrationRow>(`SELECT * FROM integrations WHERE phase IN (${inList(RUNNING_PHASES)}) ORDER BY id`)) {
      const killed = await reapVerifyGroup(row, { proc, ...(d.timing?.reapGraceMs !== undefined ? { graceMs: d.timing.reapGraceMs } : {}) });
      const main = await baseSha(d.repo, cfg0.git.baseBranch);
      if (row.candidate_sha && main && await isAncestor(d.repo, row.candidate_sha, main)) {
        d.db.setMeta(INTEGRATION_BASE_META, row.candidate_sha);
        await settle(row, 'landed', `recovered: ${cfg0.git.baseBranch} already contains ${row.candidate_sha}`);
        report.recovered.push({ id: row.id, taskId: row.task_id, outcome: 'landed', killed });
      } else {
        requeue(row, 'recovered', `the integrator holding the lock stopped during ${row.phase}`, true);
        report.recovered.push({ id: row.id, taskId: row.task_id, outcome: 'requeued', killed });
      }
    }

    for (;;) {
      if (!holdsLock()) { report.exit = 'lock-lost'; break; }
      if (d.signal?.aborted) { report.exit = 'stopped'; break; }
      if (integrationHalt(d.db)) { report.exit = 'halted'; break; }
      if (d.db.drain()) { report.exit = 'draining'; break; }
      if (d.db.paused().starts) { report.exit = 'paused'; break; }
      const queue = integrationQueue(d.db);
      if (!queue.length) { report.exit = 'empty'; break; }
      report.waiting = [];
      let row: IntegrationRow | null = null;
      for (const q of queue) {
        const unmet = await d.unmetDependencies?.(q.task_id) ?? [];
        const open = unmet.filter((dep) => !d.db.get('SELECT 1 FROM integrations WHERE task_id = ? AND phase = \'landed\' LIMIT 1', dep));
        if (open.length) { report.waiting.push({ taskId: q.task_id, on: open }); continue; }
        row = q;
        break;
      }
      if (!row) { report.exit = 'waiting'; break; }
      report.waiting = [];
      let r: IntegratorExit | null;
      try { r = await integrateOne(row); } catch (e) {
        // An unexpected throw must not leave the row running (the next pass would recover and retry it forever):
        // count it as a transient failure, so it is retried once and then ends `transient`.
        const cur = getRow(d.db, row.id);
        const msg = `the integrator failed during ${cur.phase}: ${(e as Error)?.message ?? e}`;
        log(`minions integrator: ${row.task_id}: ${msg}`);
        if ((RUNNING_PHASES as readonly string[]).includes(cur.phase)) {
          d.db.exec('UPDATE integrations SET verify_pid = NULL, verify_start = NULL, verify_boot = NULL WHERE id = ?', cur.id);
          await transient(getRow(d.db, cur.id), msg);
        }
        r = null;
      }
      if (r) { report.exit = r; break; }
    }
  } finally {
    releaseIntegrationLock(d.db, lock);
  }
  return report;

  /** One integration of `row`; returns an exit reason when the loop must stop. */
  async function integrateOne(queued: IntegrationRow): Promise<IntegratorExit | null> {
    const cfg = await d.config();
    const branch = cfg.git.baseBranch;
    const B = await baseSha(d.repo, branch);
    if (!B) { halt(`refs/heads/${branch} cannot be read in ${d.repo}`, null, d.db.getMeta(INTEGRATION_BASE_META) ?? null); return 'halted'; }
    // Step 1: the base must be the last integrated or adopted SHA, or a fast-forward of it.
    const known = d.db.getMeta(INTEGRATION_BASE_META) ?? null;
    if (known !== B) {
      if (known && !(await isAncestor(d.repo, known, B))) {
        halt(`${branch} is at ${B}, which does not descend from the last integrated base ${known} (a reset or rewrite)`, B, known);
        return 'halted';
      }
      d.db.transaction(() => { d.db.setMeta(INTEGRATION_BASE_META, B); d.db.addEvent('integration-base-adopted', null, { from: known, to: B }); });
    }
    const logPath = join(d.logDir, `${queued.task_id.replace(/[^A-Za-z0-9._-]/g, '_')}-${queued.id}.log`);
    d.db.exec("UPDATE integrations SET phase = 'merging', attempt = attempt + 1, base_sha = ?, candidate_sha = NULL, started_at = ?, ended_at = NULL, log_path = ? WHERE id = ? AND phase = 'queued'",
      B, now().toISOString(), logPath, queued.id);
    let row = getRow(d.db, queued.id);
    event('integration-started', row, { base: B, attempt: row.attempt });
    /** A stop (signal, drain, lost lock) in any phase: back to queued without an attempt; main is untouched. */
    const stopped = (where: string): IntegratorExit => {
      requeue(row, 'stopped', `stopped ${where}`, true);
      return d.signal?.aborted ? 'stopped' : d.db.drain() ? 'draining' : 'lock-lost';
    };

    const cand = await integrationCandidate(d.repo, { base: B, head: row.head_sha, branch: row.branch, taskId: row.task_id, identity: cfg.git.identity }, d.signal ? { signal: d.signal } : {});
    // An abort kills the merge's git children, so a non-clean result then says nothing about the task.
    if (cand.state !== 'clean' && stopRequested()) return stopped('during the merge');
    if (cand.state === 'already-merged') { await settle(row, 'landed', `${row.head_sha} is already contained in ${branch} (${B})`); return null; }
    if (cand.state === 'conflict') { await settle(row, 'conflict', `merging ${row.head_sha} into ${branch} (${B}) conflicts in: ${cand.files.join(', ')}`); return null; }
    if (cand.state === 'refused') { await settle(row, 'refused', cand.message); return null; }
    if (cand.state === 'error') { await transient(row, cand.message); return null; }
    const C = cand.candidate;
    d.db.exec('UPDATE integrations SET candidate_sha = ? WHERE id = ?', C, row.id);
    row = getRow(d.db, row.id);

    const paths = await integrationChangedPaths(d.repo, B, C, cfg.sensitivePaths, d.signal ? { signal: d.signal } : {});
    if (!paths.ok && stopRequested()) return stopped('during the changed-paths check');
    if (!paths.ok) { await transient(row, paths.message); return null; }
    // Policy (task-82.3): base.merge for the changed paths (a sensitive path upgrades allow to ask). deny ends the
    // row awaiting-approval with the reason (the task is then left to the user); ask needs a signed merge approval.
    const effect = can(cfg, 'base.merge', { paths: paths.changed });
    if (effect === 'deny') { await settle(row, 'awaiting-approval', 'base.merge is denied by policy: the user integrates this branch'); return null; }
    if (effect === 'ask' && !(await (d.approved?.(row, paths.sensitive) ?? false))) {
      await settle(row, 'awaiting-approval', paths.sensitive.length
        ? `sensitive paths need a signed merge approval of ${row.head_sha}: ${paths.sensitive.join(', ')}`
        : `base.merge is "ask": the landing needs a signed merge approval of ${row.head_sha}`);
      return null;
    }
    const landedBefore = d.db.all<{ candidate_sha: string }>("SELECT candidate_sha FROM integrations WHERE task_id = ? AND phase = 'landed' AND candidate_sha IS NOT NULL AND id <> ?", row.task_id, row.id).map((x) => x.candidate_sha);
    const rev = await revertOfRevertCheck(d.repo, { base: B, head: row.head_sha, landed: landedBefore });
    if (rev.state !== 'ok' && stopRequested()) return stopped('during the revert check');
    if (rev.state === 'refused') { await settle(row, 'refused', rev.message); return null; }
    if (rev.state === 'error') { await transient(row, rev.message); return null; }

    if (stopRequested()) return stopped('before the verification');
    d.db.exec("UPDATE integrations SET phase = 'verifying' WHERE id = ?", row.id);
    row = getRow(d.db, row.id);
    const timeoutMs = d.timing?.commandTimeoutMs ?? (cfg.delivery.integrationTimeoutMinutes ?? DEFAULT_INTEGRATION_TIMEOUT_MINUTES) * 60_000;
    const v = await runVerification({
      repo: d.repo, dir: d.integrationDir, runDir: d.runDir, candidate: C, logPath, timeoutMs,
      setupCommands: cfg.verification.setupCommands ?? [], commands: cfg.verification.commands,
      ...(d.env ? { env: d.env } : {}), ...(d.timing ? { timing: d.timing } : {}),
      shouldStop: stopRequested,
      onSpawn: async (pid) => {
        const id = await procIdentity(pid, proc);
        d.db.exec('UPDATE integrations SET verify_pid = ?, verify_start = ?, verify_boot = ? WHERE id = ?', pid, id?.startTime ?? null, host?.bootId ?? null, row.id);
      },
    });
    d.db.exec('UPDATE integrations SET verify_pid = NULL, verify_start = NULL, verify_boot = NULL WHERE id = ?', row.id);
    if (v.state === 'stopped') return stopped('during the setup or verification');
    // A command killed by the stop may exit before the poll notices it: never count that as red or transient.
    if (v.state !== 'passed' && stopRequested()) return stopped('during the setup or verification');
    if (v.state === 'red') { await settle(row, 'red', v.detail); return null; }
    if (v.state === 'transient') { await transient(row, v.detail); return null; }
    const flaky = v.flaky ?? [];

    // Landing: only a fast-forward of exactly B.
    d.db.exec("UPDATE integrations SET phase = 'landing' WHERE id = ?", row.id);
    row = getRow(d.db, row.id);
    const l = await land(d.repo, { candidate: C, base: B, baseBranch: branch });
    if (l.state === 'landed') {
      d.db.setMeta(INTEGRATION_BASE_META, C);
      // Only a landed candidate is "merged, but flaky": a requeue or transient failure must not report it.
      if (flaky.length) event('integration-flaky', row, { candidate: C, commands: flaky.map((f) => f.command), detail: flaky.map((f) => f.detail.slice(0, 500)) });
      const flakyNote = flaky.length ? `; flaky: ${flaky.map((f) => `\`${f.command}\``).join(', ')} failed once and passed on the rerun` : '';
      await settle(row, 'landed', `merged into ${branch} at ${C} (${l.method})${flakyNote}`, flaky.length ? { outcome: FLAKY_OUTCOME } : {});
      d.db.addEvent('integrated', row.task_id, { id: row.id, candidate: C, base: B, head: row.head_sha, paths: paths.changed.slice(0, 200), changedCount: paths.changed.length });
      return null;
    }
    if (l.state === 'moved') { requeue(row, 'base-moved', `${branch} moved from ${B} to ${l.current ?? '(none)'} before the landing`, true); return null; }
    if (l.state === 'dirty' || l.state === 'refused') {
      const why = l.state === 'dirty' ? `checkout not clean: ${l.checkout} has changes to ${l.paths.slice(0, 10).join(', ')}` : l.message;
      requeue(row, 'checkout-dirty', why, true);
      notice({ key: `integration-checkout-dirty:${row.id}:${B}`, kind: 'blocker', taskId: row.task_id, text: `Integration of ${row.task_id} paused: ${why}. ${branch} is unchanged; it lands once the checkout is clean (the integrator retries on its next start).` });
      return 'checkout-dirty';
    }
    if (l.baseUnchanged) { await transient(row, l.message); return null; }
    // The base moved in an unknown way during the landing: leave the row in `landing` for recovery and halt.
    halt(`the landing of ${row.task_id} left ${branch} in an unexpected state: ${l.message}`, await baseSha(d.repo, branch), B);
    return 'halted';
  }
}

/**
 * `work integrate --adopt-base`: clears a halt and takes the current base as the integration base (the owner
 * checked that the reset or rewrite is intended).
 */
export async function adoptIntegrationBase(db: RuntimeDb, repo: string, baseBranch: string, pc: LockProcessView = systemLockView): Promise<{ base: string; clearedHalt: IntegrationHalt | null }> {
  // A running integrator owns the base record: never move it under a live holder.
  const held = integrationLockState(db, pc);
  if (held.state === 'live') throw new MinionsError('CONFLICT', `the integrator is running (pid ${held.lock.pid}); adopt the base after it exits`);
  const base = await baseSha(repo, baseBranch);
  if (!base) throw new MinionsError('PRECONDITION', `refs/heads/${baseBranch} cannot be read in ${repo}`);
  return db.transaction(() => {
    const clearedHalt = integrationHalt(db);
    db.deleteMeta(INTEGRATION_HALT_META);
    const from = db.getMeta(INTEGRATION_BASE_META) ?? null;
    db.setMeta(INTEGRATION_BASE_META, base);
    db.addEvent('integration-base-adopted', null, { from, to: base, manual: true, clearedHalt });
    return { base, clearedHalt };
  });
}


export interface DetachedIntegratorDeps {
  /** Output of the detached integrator (appended). */
  log: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number | undefined; on(ev: 'error', fn: (e: Error) => void): unknown; unref(): void };
}

/**
 * Starts the hidden integrator command detached (its own session; the caller's tool call does not own it), as
 * coordinator.ts scheduleDetachedRestart does. A second integrator exits at once on the held lock, so starting
 * one per queued integration is safe. Returns the pid (null when the spawn failed early).
 */
export function startIntegratorDetached(d: DetachedIntegratorDeps): number | null {
  mkdirSync(dirname(d.log), { recursive: true });
  const fd = openSync(d.log, 'a', 0o600);
  try {
    const spawn = d.spawn ?? ((c: string, a: string[], o: SpawnOptions) => nodeSpawn(c, a, o));
    const child = spawn('minions', ['work', 'integrate'], { cwd: d.cwd, detached: true, stdio: ['ignore', fd, fd], env: d.env ?? process.env });
    child.on('error', () => { /* nothing to report to; the routine tick and `work publish` start it again */ });
    child.unref();
    return child.pid ?? null;
  } finally {
    try { closeSync(fd); } catch { /* the child holds its own copy */ }
  }
}
