// The session supervisor (docs/design/coordinator-sessions.md decisions 6 and 7, task-57 phase 5): the hidden
// `minions coordinator supervise`, a deterministic node process that starts and stops the headless coordinator
// sessions. It is the only code path that starts a session's claude; no model ever starts one.
//
// Architecture decisions (task-57.9):
// - Lock: meta row `supervisor_lock` {pid, start, bootId, at}, taken in one IMMEDIATE transaction (never seen
//   half-written, the property task-53.12 got for the manager lock from temp+link). A holder is live only while its
//   pid runs with the recorded start time, in the same boot, with a `coordinator supervise` command line where /proc
//   shows one: a reused pid never keeps a stale lock. The supervisor re-reads the row every tick and stops when it is
//   no longer the holder.
// - Run record: <state>/run/sessions/<key>/run.json, created with O_EXCL before the spawn (one process per session)
//   and updated with the process identity (pid = pgid, start time) once it exists; removed when its exit is handled.
// - Process model (decision 6): one resident `-p --input-format stream-json` process per open session, spawned and
//   stopped through runner/supervise.ts (own process group; SIGINT, SIGTERM, SIGKILL; wall-clock timeout; drain
//   grace). Inbox messages are written to its stdin as stream-json user messages; it is ended by closing stdin
//   (claude exits once its background tasks finish), with the drain grace as the hard limit.
// - When a process runs: an `open` session with undelivered inbox messages gets one (within coordinator.sessions.max,
//   never during a drain, and while starts are paused only for an owner message). It stays resident until the session
//   is no longer open (stdin closed), a drain (drain notice, stdin closed), the supervisor stops, or a crash. The
//   `general` session is opened on its first message; task sessions are opened, closed and reopened by the task
//   session pass (./task-sessions.ts, phase 7), run every timing.openMs.
// - Task sessions (phase 7): an open task session whose task is runnable while its process is idle (its last turn
//   ended, nothing pending) gets a nudge, at most once per timing.nudgeMs. Before a task session is resumed (a crash,
//   a drain, a supervisor restart), its leases are recovered (recoverTaskSession) and the outcome is in its inbox.
// - Resumes: a process that ends without being asked to is a crash. The session is resumed (`--resume <claude session
//   id>`, prompted by a supervisor notice in its inbox) at most MAX_SESSION_RESUMES times in a row; a completed turn
//   (a stream-json `result`) resets the count. One more crash marks it `failed` and queues an outbox `blocker`.
//   Processes stopped by a drain or a supervisor stop, and orphans, get a notice too but do not count.
// - Orphans: a resident process's stdin and stdout are pipes of the supervisor that started it, so a new supervisor
//   cannot take one over in place. At start it reaps every record: a live process whose identity matches the record
//   (same boot and container, pid and start time) is stopped by its process group, remaining group members started
//   after it are killed, and so is every process that carries the session's marker MINIONS_SESSION=<key> and started
//   after it (descendants that left the group). The session is then resumed from its transcript. Nothing is ever
//   signalled on a pid alone: a reused pid has another start time and is left alone.
// - No Telegram: the supervisor's env drops TELEGRAM_* and every credential variable (supervisorEnv), and each
//   session's env is the phase 4 allowlist (sessionEnv). No worker Landlock sandbox: a session needs the
//   coordinator's rights (decision 7).
// - The wrapper (`coordinator run`) starts the supervisor detached (its own session, output in
//   <state>/logs/supervisor.log) when coordinator.sessions.enabled is on, and starts it again whenever its lock is
//   missing or stale (startSupervisorWatch). With sessions off nothing is started and no timer runs.
import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, readFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { pidAlive, type RuntimeDb, type SessionRow, type SupervisorLock } from './db.js';
import { HEADLESS_DROP_ENV } from './headless.js';
import { systemProcessFacts, type ProcessFacts } from './process-facts.js';
import { enqueue } from './outbox.js';
import { ancestorsOf, hasEnvEntry } from './runner/escapees.js';
import { groupMembers, hostIdentity, isAlive, procIdentity, procStat, sameHost, type HostIdentity, type ProcIdentity } from './runner/record.js';
import { supervise, type StopReason, type SuperviseOutcome } from './runner/supervise.js';
import { enqueueInbox, getSession, keysWithPendingInbox, markInboxDelivered, openSession, pendingInbox, updateSession } from './session-store.js';
import { NOEXEC_ROOTS, parseSessionKey, sessionConfigDir, sessionDir, sessionsSettings } from './sessions.js';
import { recoverNotice, TASK_SESSION_SOURCE, type RecoverOutcome, type TaskSessionPass } from './task-sessions.js';

/** Resumes in a row (without a completed turn) before a session is marked failed. */
export const MAX_SESSION_RESUMES = 2;
/** The marker every process of a session inherits (sessionEnv sets it). */
export const SESSION_MARKER_ENV = 'MINIONS_SESSION';
/** Inbox sources: the supervisor's own notices, and drain notices (the only ones delivered during a drain). */
export const SUPERVISOR_SOURCE = 'supervisor';
export const DRAIN_SOURCE = 'drain';
/** An inbox message from the owner may wake a session while starts are paused. */
export const OWNER_SOURCE = 'owner';

const SUPERVISOR_CMDLINE = /(^|[\s/])coordinator\s+supervise(\s|$)/;

export interface SupervisorTiming {
  /** Main loop: start due sessions, check the lock. */
  tickMs: number;
  /** supervise.ts poll: inbox delivery, close, drain and stop checks. */
  pollMs: number;
  /** Config re-read (sessions turned off, sessions.max). */
  configMs: number;
  /** Wall-clock limit of one session process (then it is stopped and counts as a crash). */
  timeoutMs: number;
  /** SIGINT -> SIGTERM and SIGTERM -> SIGKILL (supervise.ts). */
  interruptGraceMs: number;
  killGraceMs: number;
  /** After stdin is closed for a drain or close: how long the session may finish its turn and its workers. */
  drainGraceMs: number;
  /** Orphan stop: SIGTERM -> SIGKILL. */
  reapGraceMs: number;
  /** Task session pass: open, close and reopen (phase 7). */
  openMs: number;
  /** At most one nudge per idle task session in this time. */
  nudgeMs: number;
}
export const DEFAULT_SUPERVISOR_TIMING: SupervisorTiming = {
  tickMs: 2_000, pollMs: 1_000, configMs: 15_000, timeoutMs: 24 * 3_600_000, interruptGraceMs: 5_000, killGraceMs: 15_000,
  drainGraceMs: 10 * 60_000, reapGraceMs: 5_000, openMs: 30_000, nudgeMs: 5 * 60_000,
};

// ---------------------------------------------------------------- lock

/** Process inspection for the lock check (injectable for tests). */
export interface LockProcessView {
  alive(pid: number): boolean;
  startTime(pid: number): string | null;
  cmdline(pid: number): string | null;
  bootId(): string | null;
}

const readProcText = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const procfsLockView: LockProcessView = {
  alive: pidAlive,
  startTime: (pid) => {
    const stat = readProcText(`/proc/${pid}/stat`);
    const v = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return v && /^\d+$/.test(v) ? v : null;
  },
  cmdline: (pid) => readProcText(`/proc/${pid}/cmdline`)?.split('\0').join(' ').trim() ?? null,
  bootId: () => readProcText('/proc/sys/kernel/random/boot_id')?.trim() || null,
};

/**
 * The lock view for a platform: `ps` and `sysctl` on darwin (or `facts` when given), /proc elsewhere. Its start time
 * and boot id are the ones runner/record.ts procIdentity/hostIdentity record in the lock on the same platform.
 */
export function lockViewFor(platform: NodeJS.Platform = process.platform, facts?: ProcessFacts): LockProcessView {
  const ps = facts ?? systemProcessFacts(platform);
  if (!ps) return procfsLockView;
  return {
    alive: pidAlive,
    startTime: (pid) => ps.process(pid)?.startTime ?? null,
    cmdline: (pid) => ps.process(pid)?.cmdline ?? null,
    bootId: () => ps.bootId(),
  };
}
export const systemLockView: LockProcessView = lockViewFor();

/**
 * Whether a supervisor lock holder still runs: the pid exists, in the boot it was taken in, with the recorded start
 * time, and its command line is `minions coordinator supervise` (/proc, or `ps` on macOS). When none of these can be
 * read a live pid counts as the holder (a second supervisor is refused, nothing is signalled).
 */
export function supervisorAlive(l: SupervisorLock, pc: LockProcessView = systemLockView, cmdline: RegExp = SUPERVISOR_CMDLINE): boolean {
  if (!pc.alive(l.pid)) return false;
  const boot = pc.bootId();
  if (l.bootId && boot && l.bootId !== boot) return false;
  if (l.start) {
    const s = pc.startTime(l.pid);
    if (s !== null && s !== l.start) return false;
  }
  const cmd = pc.cmdline(l.pid);
  return cmd === null || cmdline.test(cmd);
}

export type SupervisorLockState = { state: 'none'; lock: null } | { state: 'live' | 'stale'; lock: SupervisorLock };

export function supervisorLockState(db: Pick<RuntimeDb, 'supervisorLock'>, pc: LockProcessView = systemLockView): SupervisorLockState {
  const lock = db.supervisorLock();
  if (!lock) return { state: 'none', lock: null };
  return { state: supervisorAlive(lock, pc) ? 'live' : 'stale', lock };
}

// ---------------------------------------------------------------- run records

export interface SessionRunRecord {
  version: 1;
  key: string;
  /** The boot and container the process ran in; a record from another one has no live process. */
  host: HostIdentity | null;
  /** The supervisor that started it. */
  supervisor: ProcIdentity | null;
  /** The session process (pid = pgid); null until it exists. */
  process: ProcIdentity | null;
  /** The claude session id it was started with (`--resume`), or null for a fresh session. */
  resume: string | null;
  createdAt: string;
  updatedAt: string;
}

export const sessionRunRecordPath = (state: string, key: string) => join(sessionDir({ state }, key), 'run.json');
const sessionsRoot = (state: string) => join(state, 'run', 'sessions');

/** Creates the record exclusively: CONFLICT when one exists (the session has a process, or an unreaped record). */
export async function createSessionRecord(state: string, rec: SessionRunRecord): Promise<void> {
  const dir = sessionDir({ state }, rec.key);
  await mkdir(sessionsRoot(state), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  let fh;
  try {
    fh = await open(join(dir, 'run.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MinionsError('CONFLICT', `Session ${rec.key} already has a run record: at most one process per session.`);
    throw e;
  }
  try { await fh.writeFile(JSON.stringify(rec, null, 2) + '\n'); await fh.sync(); } finally { await fh.close(); }
}

export async function updateSessionRecord(state: string, rec: SessionRunRecord, patch: Partial<SessionRunRecord>, now = new Date()): Promise<SessionRunRecord> {
  const next = { ...rec, ...patch, updatedAt: now.toISOString() };
  await atomicWrite(sessionRunRecordPath(state, rec.key), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** Null for no record; an unreadable one throws (fail closed: its processes cannot be identified). */
export async function readSessionRecord(state: string, key: string): Promise<SessionRunRecord | null> {
  let text: string;
  try { text = await readFile(sessionRunRecordPath(state, key), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const r = JSON.parse(text) as SessionRunRecord;
    if (r?.version !== 1 || r.key !== key) throw new Error('shape');
    return r;
  } catch {
    throw new MinionsError('INTERNAL', `The session run record ${sessionRunRecordPath(state, key)} is unreadable: its processes cannot be identified.`,
      `Check that no process of the session is left (\`grep -ls '${SESSION_MARKER_ENV}=${key}' /proc/[0-9]*/environ\`; SIGKILL any it lists), then remove the file.`);
  }
}

export const removeSessionRecord = (state: string, key: string): Promise<void> => rm(sessionRunRecordPath(state, key), { force: true });

/** Session keys with a run record. */
export async function listSessionRecords(state: string): Promise<string[]> {
  let names: string[];
  try { names = await readdir(sessionsRoot(state)); } catch { return []; }
  const out: string[] = [];
  for (const n of names.sort()) {
    try { parseSessionKey(n); } catch { continue; }
    try { await readFile(join(sessionsRoot(state), n, 'run.json')); out.push(n); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.push(n); }
  }
  return out;
}

// ---------------------------------------------------------------- orphan reaping

export interface ReapOptions {
  proc?: string;
  /** Default: process.kill; a negative pid is a process group. */
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  graceMs?: number;
  /** The reaping process (never killed, nor its ancestors). */
  self?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReapResult {
  key: string;
  /** stopped: a live process of the record was stopped; removed: nothing of it ran; kept: left in place (see note). */
  action: 'stopped' | 'removed' | 'kept';
  killed: number[];
  note?: string;
}

const defaultKill = (pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* gone */ } };
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Stops whatever is left of a session's process from its run record and removes the record. Signals only processes
 * identified by the record: the group leader with its recorded start time, members of its group started no earlier
 * (only while that leader still matched the record), and processes carrying MINIONS_SESSION=<key> started no earlier
 * (the reaper and its ancestors are spared).
 */
export async function reapSessionRecord(state: string, key: string, o: ReapOptions = {}): Promise<ReapResult> {
  const proc = o.proc ?? '/proc';
  const kill = o.kill ?? defaultKill;
  const sleep = o.sleep ?? sleepMs;
  const rec = await readSessionRecord(state, key);
  if (!rec) return { key, action: 'removed', killed: [], note: 'no record' };
  if (!sameHost(rec.host, await hostIdentity(proc))) {
    await removeSessionRecord(state, key);
    return { key, action: 'removed', killed: [], note: 'record from another boot or container' };
  }
  const leader = rec.process;
  const notBefore = leader?.startTime ?? rec.supervisor?.startTime ?? null;
  const killed: number[] = [];
  let stopped = false;
  if (leader && await isAlive(leader, proc)) {
    stopped = true;
    kill(-leader.pid, 'SIGTERM');
    const grace = o.graceMs ?? DEFAULT_SUPERVISOR_TIMING.reapGraceMs;
    for (let waited = 0; waited < grace && await isAlive(leader, proc); waited += 50) await sleep(50);
    // Re-checked right before the signal: only the recorded process's group.
    if (await isAlive(leader, proc)) kill(-leader.pid, 'SIGKILL');
    killed.push(leader.pid);
  }
  if (notBefore !== null) {
    const spared = new Set([1, ...await ancestorsOf(o.self ?? process.pid, proc)]);
    // The group is swept only when its leader matched the record: a dead leader's pid may now lead an unrelated,
    // newer group (any detached spawn), which the start-time filter alone does not exclude.
    const members = leader && stopped ? await groupMembers(leader.pid, notBefore, proc) : [];
    for (const pid of members) if (!spared.has(pid)) { kill(pid, 'SIGKILL'); killed.push(pid); }
    for (const pid of await markedProcesses(key, notBefore, proc)) {
      if (spared.has(pid) || killed.includes(pid)) continue;
      kill(pid, 'SIGKILL');
      killed.push(pid);
    }
  }
  await removeSessionRecord(state, key);
  return { key, action: stopped || killed.length ? 'stopped' : 'removed', killed: [...new Set(killed)] };
}

/** Live processes with MINIONS_SESSION=<key> in their environ, started no earlier than `notBefore`. */
async function markedProcesses(key: string, notBefore: string, proc: string): Promise<number[]> {
  let names: string[];
  try { names = await readdir(proc); } catch { return []; }
  const out: number[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = Number(n);
    const s = await procStat(pid, proc);
    if (!s || s.state === 'Z' || BigInt(s.startTime) < BigInt(notBefore)) continue;
    if (await hasEnvEntry(pid, `${SESSION_MARKER_ENV}=${key}`, proc)) out.push(pid);
  }
  return out;
}

// ---------------------------------------------------------------- the supervisor

/** What starts a session process: buildSessionCommand in the CLI, a fake claude in tests. */
export type SessionLauncher = (cfg: MinionsConfig, key: string, o: { resume?: string }) => Promise<{ command: string; args: string[]; cwd: string; env: Record<string, string> }>;

export interface SupervisorDeps {
  db: RuntimeDb;
  state: string;
  /** Re-read every timing.configMs. */
  config: () => Promise<MinionsConfig>;
  launch: SessionLauncher;
  timing?: Partial<SupervisorTiming>;
  proc?: string;
  log?: (line: string) => void;
  /** Lock holder liveness (default supervisorAlive). */
  lockAlive?: (l: SupervisorLock) => boolean;
  /** Ends the supervisor: sessions are stopped and resumed by the next one. */
  signal?: AbortSignal;
  now?: () => Date;
  reap?: Omit<ReapOptions, 'proc'>;
  /** Task sessions (phase 7); without it the supervisor opens no task session (as in phase 5). */
  tasks?: SupervisorTaskDeps;
}

export interface SupervisorTaskDeps {
  /** taskSessionPass with the runtime context (work next, the backlog, the budget). */
  pass: (cfg: MinionsConfig) => Promise<TaskSessionPass>;
  /** recoverTaskSession with the runtime context (submission files, Scheduler.release). */
  recover: (key: string) => Promise<RecoverOutcome>;
}

export type SupervisorExit = 'disabled' | 'conflict' | 'stopped' | 'lock-lost';
export interface SupervisorReport { exit: SupervisorExit; holder: SupervisorLock | null; reaped: ReapResult[]; reapErrors: { key: string; error: string }[]; starts: number; opened: number; closed: number }

type EndReason = 'close' | 'drain' | 'disabled' | 'shutdown';

interface Live {
  key: string;
  taskId: string | null;
  stdin: Writable | null;
  /** Set when the supervisor closed stdin (the exit that follows is no crash). */
  ending: EndReason | null;
  /** Stop at once (the supervisor ends). */
  stopNow: boolean;
  /** A turn is in progress: a message was written and its `result` has not come yet. */
  busy: boolean;
  record: SessionRunRecord;
  done: Promise<void>;
}

/** A stream-json user message (one line). */
export const userMessageLine = (text: string): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

export function describeExit(o: SuperviseOutcome, timeoutMs: number): string {
  const how = o.spawnError ? `could not be started (${o.spawnError})`
    : o.stopped === 'timeout' ? `ran past its ${Math.round(timeoutMs / 60_000)} min limit and was stopped`
      : o.signal ? `was killed by ${o.signal}` : `exited with code ${o.code}`;
  const tail = o.stderrTail.trim().split('\n').slice(-2).join(' | ');
  return redact(`the session process ${how}${tail ? `: ${tail}` : ''}`).slice(0, 600);
}

export async function runSupervisor(d: SupervisorDeps): Promise<SupervisorReport> {
  const t: SupervisorTiming = { ...DEFAULT_SUPERVISOR_TIMING, ...d.timing };
  const log = d.log ?? (() => undefined);
  const proc = d.proc ?? '/proc';
  const now = d.now ?? (() => new Date());
  const db = d.db;
  const report: SupervisorReport = { exit: 'stopped', holder: null, reaped: [], reapErrors: [], starts: 0, opened: 0, closed: 0 };
  let cfg = await d.config();
  if (!sessionsSettings(cfg).enabled) return { ...report, exit: 'disabled' };

  const self = await procIdentity(process.pid, proc);
  const host = await hostIdentity(proc);
  const lock = db.acquireSupervisorLock({ pid: process.pid, start: self?.startTime ?? null, bootId: host?.bootId ?? null }, d.lockAlive ?? ((l) => supervisorAlive(l)), now());
  if (!lock) return { ...report, exit: 'conflict', holder: db.supervisorLock() };
  report.holder = lock;
  log(`minions supervisor: started (pid ${process.pid})`);

  const live = new Map<string, Live>();
  let stopping: EndReason | null = null;
  let exit: SupervisorExit = 'stopped';

  const notice = (key: string, source: string, text: string) => {
    if (pendingInbox(db, key, { sources: [source] }).length) return;
    enqueueInbox(db, key, source, text, { now: now() });
  };
  const deliver = (l: Live, sources?: readonly string[]) => {
    for (const m of pendingInbox(db, l.key, sources ? { sources } : {})) {
      const s = l.stdin;
      if (!s || s.writableEnded || s.destroyed) return;
      s.write(userMessageLine(m.text));
      l.busy = true;
      markInboxDelivered(db, m.id, now());
    }
  };
  const end = (l: Live, why: EndReason) => {
    l.ending ??= why;
    try { l.stdin?.end(); } catch { /* gone */ }
  };

  const fail = (row: SessionRow, failure: string) => {
    const k = parseSessionKey(row.key);
    updateSession(db, row.key, { status: 'failed', failure, closed_at: now().toISOString() });
    db.addEvent('session-failed', k.taskId, { key: row.key, resumes: row.resumes, failure });
    const text = `Coordinator session ${row.key} failed: ${failure}. It was resumed ${row.resumes} times without completing a turn and is now marked failed; nothing restarts it until it is reopened.`;
    try { enqueue(db, { key: `session-failed:${row.key}:${row.opened_at}`, kind: 'blocker', taskId: k.taskId, text: text.slice(0, 3_900) }, now); } catch (e) { log(`minions supervisor: could not queue the blocker for ${row.key}: ${(e as Error).message}`); }
    log(`minions supervisor: ${row.key} failed (${failure})`);
  };

  /** A crash (or a start that failed): resume, or mark failed after MAX_SESSION_RESUMES. */
  const crashed = (key: string, failure: string) => {
    const row = getSession(db, key);
    if (!row || row.status !== 'open') return;
    if (row.resumes >= MAX_SESSION_RESUMES) { fail(row, failure); return; }
    const n = row.resumes + 1;
    updateSession(db, key, { resumes: n, failure });
    db.addEvent('session-crash', row.kind === 'task' ? parseSessionKey(key).taskId : null, { key, resume: n, failure });
    notice(key, SUPERVISOR_SOURCE, `minions supervisor: this session's process ended unexpectedly (${failure}); it was resumed (resume ${n} of ${MAX_SESSION_RESUMES}). `
      + 'Workers you had running died with it: check `minions work list` and your task\'s state before you continue.');
    log(`minions supervisor: ${key} crashed, resume ${n} of ${MAX_SESSION_RESUMES} (${failure})`);
  };

  const onLine = (l: Live, line: string) => {
    let ev: { type?: unknown; subtype?: unknown; session_id?: unknown };
    try { ev = JSON.parse(line) as typeof ev; } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    const row = getSession(db, l.key);
    if (!row) return;
    if (typeof ev.session_id === 'string' && SESSION_ID.test(ev.session_id) && ev.session_id !== row.claude_session_id) updateSession(db, l.key, { claude_session_id: ev.session_id });
    if (ev.type === 'result') l.busy = false;
    if (ev.type === 'result' && row.resumes > 0) updateSession(db, l.key, { resumes: 0, failure: null });
  };

  const poll = async (l: Live): Promise<StopReason | null> => {
    if (l.stopNow) return 'cancel';
    const row = getSession(db, l.key);
    if (!row || row.status !== 'open') { end(l, 'close'); return 'drain'; }
    const drain = db.drain();
    if (drain) {
      if (!l.ending) {
        notice(l.key, DRAIN_SOURCE, `minions drain in progress (${drain.reason}): do not claim or start new stages. Your running workers commit their work in progress (wip:) and return partial results; record them, then end your turn. This process stops after that; the supervisor resumes the session once the drain is over.`);
        deliver(l, [DRAIN_SOURCE]);
        end(l, 'drain');
      }
      return 'drain';
    }
    if (stopping === 'disabled') { end(l, 'disabled'); return 'drain'; }
    if (!l.ending) deliver(l);
    return null;
  };

  const onExit = async (l: Live, out: SuperviseOutcome) => {
    try { await removeSessionRecord(d.state, l.key); } catch (e) { log(`minions supervisor: could not remove the run record of ${l.key}: ${(e as Error).message}`); }
    const ours = l.ending ?? (l.stopNow ? 'shutdown' : null);
    db.addEvent('session-exit', l.taskId, { key: l.key, code: out.code, signal: out.signal, stopped: out.stopped, ending: ours });
    const row = getSession(db, l.key);
    if (!row || row.status !== 'open' || ours === 'close') return;
    if (ours) {
      notice(l.key, SUPERVISOR_SOURCE, `minions supervisor: this session's process was stopped (${ours === 'drain' ? 'a drain' : 'the supervisor stopped'}) and is now resumed. Continue where you left off; check \`minions work list\` for leases you held.`);
      return;
    }
    crashed(l.key, describeExit(out, t.timeoutMs));
  };

  const start = async (row: SessionRow) => {
    const key = row.key;
    const resume = row.claude_session_id ?? undefined;
    let launch: Awaited<ReturnType<SessionLauncher>>;
    try { launch = await d.launch(cfg, key, resume ? { resume } : {}); } catch (e) {
      crashed(key, redact(`the session could not be launched: ${(e as Error).message}`).slice(0, 600));
      return;
    }
    const at = now().toISOString();
    let record: SessionRunRecord = { version: 1, key, host, supervisor: self, process: null, resume: resume ?? null, createdAt: at, updatedAt: at };
    try { await createSessionRecord(d.state, record); } catch (e) {
      // Not ours (no live entry): left by a process whose exit was not handled. Reap it; the next tick starts.
      log(`minions supervisor: ${key}: ${(e as Error).message} Reaping it.`);
      try { report.reaped.push(await reapSessionRecord(d.state, key, { graceMs: t.reapGraceMs, ...d.reap, proc })); } catch (r) { report.reapErrors.push({ key, error: (r as Error).message }); }
      return;
    }
    if (row.kind === 'task' && d.tasks) {
      // Per-task recovery (phase 7): the record is ours, so no process of the session runs; the leases it held are
      // reconciled before the session resumes.
      try {
        const r = await d.tasks.recover(key);
        const text = recoverNotice(parseSessionKey(key).taskId!, r);
        if (text) {
          enqueueInbox(db, key, SUPERVISOR_SOURCE, text, { now: now() });
          log(`minions supervisor: ${key}: recovered (released ${r.released.length}, submitted ${r.submitted.length}${r.errors.length ? `, errors ${r.errors.length}` : ''})`);
        }
      } catch (e) { log(`minions supervisor: ${key}: recovery failed: ${(e as Error).message}`); }
    }
    const l: Live = { key, taskId: parseSessionKey(key).taskId, stdin: null, ending: null, stopNow: false, busy: false, record, done: Promise.resolve() };
    live.set(key, l);
    updateSession(db, key, { last_wake_at: at });
    db.addEvent('session-start', l.taskId, { key, resume: resume ?? null });
    report.starts++;
    log(`minions supervisor: ${key} started${resume ? ` (--resume ${resume})` : ''}`);
    l.done = supervise({ argv: [launch.command, ...launch.args], cwd: launch.cwd, env: launch.env, stdin: 'open' },
      { timeoutMs: t.timeoutMs, pollMs: t.pollMs, killGraceMs: t.killGraceMs, interruptGraceMs: t.interruptGraceMs, drainGraceMs: t.drainGraceMs },
      {
        onSpawn: async (pid, stdin) => {
          l.stdin = stdin;
          stdin?.on('error', () => undefined);
          const id = await procIdentity(pid, proc);
          // Unreadable identity (no /proc): the record keeps null and a later reap relies on the marker sweep.
          record = l.record = await updateSessionRecord(d.state, record, { process: id });
          if (!l.ending && !l.stopNow && !db.drain()) deliver(l);
        },
        onLine: (line) => { try { onLine(l, line); } catch (e) { log(`minions supervisor: ${key}: ${(e as Error).message}`); } },
        poll: () => poll(l),
      })
      .then((out) => onExit(l, out))
      .catch((e: unknown) => log(`minions supervisor: ${key}: ${(e as Error).message}`))
      .finally(() => { live.delete(key); });
  };

  const startDue = async () => {
    if (db.drain()) return;
    const { max } = sessionsSettings(cfg);
    const paused = db.paused().starts;
    const keys = keysWithPendingInbox(db);
    if (keys.includes('general') && !getSession(db, 'general')) {
      openSession(db, 'general', { configDir: sessionConfigDir({ state: d.state }, 'general'), model: cfg.models.coordinator ?? null, now: now() });
    }
    for (const key of keys) {
      if (live.size >= max || stopping) break;
      if (live.has(key)) continue;
      const row = getSession(db, key);
      if (!row || row.status !== 'open') continue;
      if (paused && !pendingInbox(db, key, { sources: [OWNER_SOURCE] }).length) continue;
      await start(row);
    }
  };

  // Task sessions (phase 7): the open/close/reopen pass, then nudges for runnable tasks whose session idles.
  const nudged = new Map<string, number>();
  const taskPass = async () => {
    if (!d.tasks || stopping) return;
    const r = await d.tasks.pass(cfg);
    report.opened += r.opened.length;
    report.closed += r.closed.length;
    for (const o of r.opened) log(`minions supervisor: ${o.key} ${o.reopened ? 'reopened' : 'opened'} (${o.role} runnable)`);
    for (const c of r.closed) log(`minions supervisor: ${c.key} closed (${c.reason})`);
    if (r.refused.length) log(`minions supervisor: no session for ${r.refused.slice(0, 3).map((x) => `${x.taskId} (${x.why})`).join(', ')}${r.refused.length > 3 ? ', …' : ''}`);
    for (const taskId of r.runnableOpen) {
      const key = `task:${taskId}`;
      const l = live.get(key);
      // A live process mid-turn or ending is left alone; an open session without a process gets one through the nudge.
      if ((l && (l.busy || l.ending)) || pendingInbox(db, key).length) continue;
      if (Date.now() - (nudged.get(key) ?? -Infinity) < t.nudgeMs) continue;
      nudged.set(key, Date.now());
      enqueueInbox(db, key, TASK_SESSION_SOURCE, `minions supervisor: ${taskId} has a runnable stage now. Continue with /minions:task ${taskId} (claim it).`, { now: now() });
    }
  };

  const abortable = (ms: number) => new Promise<void>((res) => {
    const done = () => { clearTimeout(timer); d.signal?.removeEventListener('abort', done); res(); };
    const timer = setTimeout(done, ms);
    d.signal?.addEventListener('abort', done, { once: true });
  });

  try {
    // Orphans first (decision 7): nothing of a previous supervisor's sessions keeps running unobserved.
    for (const key of await listSessionRecords(d.state)) {
      try {
        const r = await reapSessionRecord(d.state, key, { graceMs: t.reapGraceMs, ...d.reap, proc });
        report.reaped.push(r);
        log(`minions supervisor: ${key}: orphan record ${r.action}${r.killed.length ? ` (killed ${r.killed.join(', ')})` : ''}${r.note ? ` (${r.note})` : ''}`);
        if (getSession(db, key)?.status === 'open') {
          notice(key, SUPERVISOR_SOURCE, 'minions supervisor: the session supervisor was restarted and this session\'s previous process was stopped; it is now resumed. Continue where you left off; check `minions work list` for leases you held.');
        }
      } catch (e) {
        report.reapErrors.push({ key, error: (e as Error).message });
        log(`minions supervisor: could not reap the run record of ${key}: ${(e as Error).message}`);
      }
    }
    let configAt = Date.now();
    let passAt = -Infinity;
    while (!d.signal?.aborted && !stopping) {
      const cur = db.supervisorLock();
      if (!cur || cur.pid !== lock.pid || cur.at !== lock.at) { exit = 'lock-lost'; stopping = 'shutdown'; log('minions supervisor: the lock was taken over; stopping'); break; }
      if (Date.now() - configAt >= t.configMs) {
        configAt = Date.now();
        try { cfg = await d.config(); } catch (e) { log(`minions supervisor: config unreadable, keeping the last one (${(e as Error).message})`); }
        if (!sessionsSettings(cfg).enabled) { exit = 'disabled'; stopping = 'disabled'; log('minions supervisor: coordinator.sessions.enabled is off; ending the sessions'); break; }
      }
      if (Date.now() - passAt >= t.openMs) {
        passAt = Date.now();
        try { await taskPass(); } catch (e) { log(`minions supervisor: task session pass: ${(e as Error).message}`); }
      }
      try { await startDue(); } catch (e) { log(`minions supervisor: ${(e as Error).message}`); }
      await abortable(t.tickMs);
    }
  } finally {
    stopping ??= 'shutdown';
    // Turned off: sessions end their turn (stdin closed, drain grace); otherwise they stop now and resume next time.
    for (const l of live.values()) { if (stopping === 'disabled') end(l, 'disabled'); else l.stopNow = true; }
    await Promise.all([...live.values()].map((l) => l.done));
    db.releaseSupervisorLock(lock);
    log(`minions supervisor: stopped (${exit})`);
  }
  return { ...report, exit };
}

// ---------------------------------------------------------------- the wrapper side

/** The supervisor's environment: the wrapper's without Telegram, credential variables or session and worker markers. */
export function supervisorEnv(base: NodeJS.ProcessEnv, tmp?: string): Record<string, string> {
  // CLAUDE_CONFIG_DIR stays: buildSessionCommand checks that no session argument points into the coordinator's.
  const drop = new Set<string>([...HEADLESS_DROP_ENV.filter((k) => k !== 'CLAUDE_CONFIG_DIR'), SESSION_MARKER_ENV, 'MINIONS_ROLE', 'MINIONS_WORKER_LEASE', 'TMUX', 'TMUX_PANE']);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop.has(k) && !k.startsWith('TELEGRAM_')) env[k] = v;
  if (tmp && (!env.TMPDIR || NOEXEC_ROOTS.some((r) => env.TMPDIR === r || env.TMPDIR!.startsWith(`${r}/`)))) env.TMPDIR = tmp;
  return env;
}

export type SupervisorSpawn = (cmd: string, args: string[], opts: { cwd: string; detached: true; stdio: ['ignore', number, number]; env: Record<string, string> }) => { pid?: number; unref(): void; on(event: 'error', cb: (e: Error) => void): unknown };

export interface SupervisorStartDeps {
  /** <state>: cwd of the supervisor. */
  state: string;
  /** <state>/logs/supervisor.log. */
  log: string;
  env?: NodeJS.ProcessEnv;
  /** Exec-allowed temp root for TMPDIR (paths.tmp). */
  tmp?: string;
  spawn?: SupervisorSpawn;
  openLog?: (file: string) => number;
}

/** Starts `minions coordinator supervise` detached (its own session), output appended to the log. Returns its pid. */
export function spawnSupervisor(o: SupervisorStartDeps): number | null {
  const openLog = o.openLog ?? ((f: string) => { mkdirSync(dirname(f), { recursive: true }); return openSync(f, 'a', 0o600); });
  const fd = openLog(o.log);
  try {
    const spawn: SupervisorSpawn = o.spawn ?? ((c, a, x) => nodeSpawn(c, a, x));
    const child = spawn('minions', ['coordinator', 'supervise'], { cwd: o.state, detached: true, stdio: ['ignore', fd, fd], env: supervisorEnv(o.env ?? process.env, o.tmp) });
    child.on('error', () => { /* the next watch tick sees no live lock and tries again */ });
    child.unref();
    return child.pid ?? null;
  } finally {
    try { closeSync(fd); } catch { /* the child holds its own copy */ }
  }
}

export interface SupervisorWatchDeps extends SupervisorStartDeps {
  lockState: () => SupervisorLockState;
  /** Check interval (default 60 s). */
  intervalMs?: number;
  /** A start this recent is still coming up: no second one (default 30 s). */
  startGraceMs?: number;
  timer?: (fn: () => void, ms: number) => () => void;
  clock?: () => number;
  say?: (line: string) => void;
}

const realTimer = (fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return () => clearInterval(h); };

/**
 * The wrapper's supervisor watch: with coordinator.sessions.enabled it starts the supervisor now and again whenever
 * its lock is missing or stale. With sessions off it does nothing at all (no timer, no spawn) and returns a no-op.
 * The setting is restart-class: the wrapper decides once, at its start.
 */
export function startSupervisorWatch(cfg: Pick<MinionsConfig, 'coordinator' | 'execution'>, o: SupervisorWatchDeps): () => void {
  if (!sessionsSettings(cfg).enabled) return () => undefined;
  const clock = o.clock ?? Date.now;
  const grace = o.startGraceMs ?? 30_000;
  let lastStart = -Infinity;
  const check = () => {
    try {
      const s = o.lockState();
      if (s.state === 'live' || clock() - lastStart < grace) return;
      lastStart = clock();
      const pid = spawnSupervisor(o);
      o.say?.(s.state === 'stale'
        ? `minions: restarted the session supervisor (pid ${pid ?? '?'}); its lock (pid ${s.lock.pid}) was stale`
        : `minions: started the session supervisor (pid ${pid ?? '?'}; output: ${o.log})`);
    } catch (e) { o.say?.(`minions: could not start the session supervisor: ${redact((e as Error).message).slice(0, 300)}`); }
  };
  check();
  return (o.timer ?? realTimer)(check, o.intervalMs ?? 60_000);
}
