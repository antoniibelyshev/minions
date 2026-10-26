// The run record of a process-harness lease (docs/design/agent-runtimes.md D3.2, D3b):
// `<state>/run/leases/<leaseId>/run.json`, created with O_EXCL before anything else and updated at each phase.
// It is the one-process-per-lease lock and everything recovery (`reapRun`) needs after a crash: cleanup is
// driven by the record, never by runner memory. The record dir also holds the runner-owned files the worker
// must never write (sandbox rules, the runner's git global config and clone template) and the cancel mark.
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MinionsError } from '../../core/errors.js';
import { atomicWrite } from '../../core/fsutil.js';

export type RunPhase = 'prepared' | 'running' | 'post-exit' | 'done';

/** A process, identified by pid plus start time (/proc/<pid>/stat field 22, clock ticks since boot). */
export interface ProcIdentity { pid: number; startTime: string }

/** The boot and container instance a record was written in; a record from another one has no live processes. */
export interface HostIdentity { bootId: string; containerStart: string }

/** The lease's own git files (D3.4 snapshot): content, or null when the file did not exist. */
export interface LeaseGitSnapshot {
  commonDir: string;
  /** `<common>/worktrees/<name>`. */
  worktreeGitDir: string;
  files: Record<string, string | null>;
  claimHead: string;
}

/** What post-exit needs to know about the role, frozen at prepare time (the config may change during the run). */
export interface RunRole { name: string; contract: 'producer' | 'verifier' | 'gate'; commits: boolean; edits: 'none' | 'any' | { paths: string[] }; harness: string }

export interface RunRecord {
  version: 1;
  leaseId: string;
  taskId: string;
  role: RunRole;
  branch: string;
  claimHead: string;
  leaseWorktree: string;
  scratchDir: string;
  checkout: string;
  host: HostIdentity | null;
  runner: ProcIdentity | null;
  wrapper: ProcIdentity | null;
  pgid: number | null;
  phase: RunPhase;
  leaseGit: LeaseGitSnapshot | null;
  /** Wall-clock deadline of the worker (ISO). */
  deadline: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set at `done`: what happened (submitted status, wip commit, violations). */
  outcome?: { status: string | null; submitted: boolean; wipCommit: string | null; violations: string[]; head: string | null; reason: string };
}

const LEASE_ID = /^lease-[A-Za-z0-9_-]+$/;

export const runLeasesDir = (state: string) => join(state, 'run', 'leases');
export function runDir(state: string, leaseId: string): string {
  if (!LEASE_ID.test(leaseId)) throw new MinionsError('PRECONDITION', `Invalid lease id "${leaseId}".`);
  return join(runLeasesDir(state), leaseId);
}
export const runRecordPath = (state: string, leaseId: string) => join(runDir(state, leaseId), 'run.json');
export const cancelMarkPath = (state: string, leaseId: string) => join(runDir(state, leaseId), 'cancel');

/**
 * Creates the record exclusively: a second `work run` of one lease (or a run after a crash that left the record)
 * fails here with POLICY_DENIED. Returns the record dir.
 */
export async function createRunRecord(state: string, rec: RunRecord): Promise<string> {
  const dir = runDir(state, rec.leaseId);
  await mkdir(runLeasesDir(state), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  let fh;
  try {
    fh = await open(join(dir, 'run.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MinionsError('POLICY_DENIED', `Lease ${rec.leaseId} already has a run record: a lease runs at most once.`,
        'Release the lease (`minions work release`) and claim the task again for a new attempt.');
    }
    throw e;
  }
  try { await fh.writeFile(JSON.stringify(rec, null, 2) + '\n'); await fh.sync(); } finally { await fh.close(); }
  return dir;
}

export async function readRunRecord(state: string, leaseId: string): Promise<RunRecord | null> {
  let text: string;
  try { text = await readFile(runRecordPath(state, leaseId), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try { return JSON.parse(text) as RunRecord; } catch {
    // Fail closed: an unreadable record counts as a run that is not done.
    throw new MinionsError('INTERNAL', `The run record of ${leaseId} is unreadable.`, `Inspect ${runRecordPath(state, leaseId)}.`);
  }
}

/** Atomically rewrites the record with `patch` applied; returns the new record. */
export async function updateRunRecord(state: string, rec: RunRecord, patch: Partial<RunRecord>, now = new Date()): Promise<RunRecord> {
  const next: RunRecord = { ...rec, ...patch, updatedAt: now.toISOString() };
  await atomicWrite(runRecordPath(state, rec.leaseId), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** Whether a record that is not `done` exists for the lease (an unreadable record counts as not done). */
export async function hasOpenRun(state: string, leaseId: string): Promise<boolean> {
  try { const r = await readRunRecord(state, leaseId); return !!r && r.phase !== 'done'; } catch { return true; }
}

/** Lease ids with a record dir (any phase). */
export async function listRunRecords(state: string): Promise<string[]> {
  try { return (await readdir(runLeasesDir(state))).filter((n) => LEASE_ID.test(n)).sort(); } catch { return []; }
}

export async function markCancel(state: string, leaseId: string, reason: string): Promise<void> {
  await atomicWrite(cancelMarkPath(state, leaseId), JSON.stringify({ reason, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
export const cancelMarked = (state: string, leaseId: string): Promise<boolean> => stat(cancelMarkPath(state, leaseId)).then(() => true, () => false);

/** Removes a `done` record dir (when the lease has ended). Refuses any other phase. */
export async function removeRunRecord(state: string, leaseId: string): Promise<boolean> {
  const r = await readRunRecord(state, leaseId).catch(() => undefined);
  if (r === null) { await rm(runDir(state, leaseId), { recursive: true, force: true }); return true; }
  if (!r || r.phase !== 'done') return false;
  await rm(runDir(state, leaseId), { recursive: true, force: true });
  return true;
}

// ------------------------------------------------------------------------------------------------ identities

/** Field 22 (start time) and field 5 (pgrp) of /proc/<pid>/stat; null when the process is gone. */
export async function procStat(pid: number, proc = '/proc'): Promise<{ startTime: string; pgrp: number; state: string } | null> {
  try {
    const text = await readFile(join(proc, String(pid), 'stat'), 'utf8');
    const f = text.slice(text.lastIndexOf(')') + 2).split(' ');
    // f[0] is field 3 (state); field n is f[n - 3].
    const startTime = f[19], pgrp = Number(f[2]), state = f[0] ?? '';
    if (!startTime || !/^\d+$/.test(startTime)) return null;
    return { startTime, pgrp, state };
  } catch { return null; }
}

export async function procIdentity(pid: number, proc = '/proc'): Promise<ProcIdentity | null> {
  const s = await procStat(pid, proc);
  return s ? { pid, startTime: s.startTime } : null;
}

/** Alive and the same process (not a reused pid); a zombie counts as gone. */
export async function isAlive(p: ProcIdentity | null, proc = '/proc'): Promise<boolean> {
  if (!p) return false;
  const s = await procStat(p.pid, proc);
  return !!s && s.startTime === p.startTime && s.state !== 'Z';
}

export async function hostIdentity(proc = '/proc'): Promise<HostIdentity | null> {
  try {
    const bootId = (await readFile(join(proc, 'sys', 'kernel', 'random', 'boot_id'), 'utf8')).trim();
    const init = await procStat(1, proc);
    if (!bootId || !init) return null;
    return { bootId, containerStart: init.startTime };
  } catch { return null; }
}

export const sameHost = (a: HostIdentity | null, b: HostIdentity | null): boolean =>
  !!a && !!b && a.bootId === b.bootId && a.containerStart === b.containerStart;

/** Live members of process group `pgid` started no earlier than `notBefore` (guards against a reused pgid). */
export async function groupMembers(pgid: number, notBefore: string, proc = '/proc'): Promise<number[]> {
  const out: number[] = [];
  let names: string[];
  try { names = await readdir(proc); } catch { return out; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const s = await procStat(Number(n), proc);
    if (s && s.pgrp === pgid && s.state !== 'Z' && BigInt(s.startTime) >= BigInt(notBefore)) out.push(Number(n));
  }
  return out;
}
