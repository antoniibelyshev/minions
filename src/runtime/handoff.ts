import { realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, writeJson } from '../core/fsutil.js';
import type { Lease, LeaseRole, RuntimeDb } from './db.js';
import type { RecordResponse, Scheduler, TaskBrief } from './scheduler.js';

/**
 * File-based worker hand-offs (keeps large JSON out of the coordinator's context).
 *
 * - Briefs: `work claim` stores the full brief at `<briefs>/<leaseId>.json`; the worker fetches it with
 *   `minions work brief <leaseId> --role <role>` from inside its worktree. The coordinator only reads
 *   the compact claim output and passes the `minions-lease:` marker plus notes.
 * - Results: the worker writes its WorkerResult with `minions work submit <leaseId> --role <role>`
 *   (stdin) to `<results>/<leaseId>.json`; the coordinator records it with
 *   `minions work record <leaseId> --submitted` without reading it.
 *
 * Ownership (decision): a lease's brief/submission is usable only while the lease is active, by a caller
 * naming the lease's role, whose working directory is inside the lease's worktree. One active stage per
 * task and one worktree per task (review worktrees are separate) mean a worker in its own worktree can
 * only reach its own lease. Lease ids are checked for shape so they can never escape the directories.
 */
export interface HandoffPaths {
  briefs: string;
  results: string;
  /**
   * Parent of the per-lease scratch dirs (`<scratch>/<leaseId>`, under the disk-backed TMPDIR). Omitted: no
   * scratch dirs. Only a lease's own dir is ever removed: never a worktree, the TMPDIR root or other entries.
   */
  scratch?: string;
}

const LEASE_ID = /^lease-[A-Za-z0-9_-]+$/;

function checkId(leaseId: string): void {
  if (!LEASE_ID.test(leaseId)) throw new MinionsError('PRECONDITION', `Invalid lease id "${leaseId}".`, 'Use the id from the `minions-lease: <leaseId>` line of your prompt.');
}

export const briefPath = (p: HandoffPaths, leaseId: string) => { checkId(leaseId); return join(p.briefs, `${leaseId}.json`); };
export const submissionPath = (p: HandoffPaths, leaseId: string) => { checkId(leaseId); return join(p.results, `${leaseId}.json`); };
export const rejectedPath = (p: HandoffPaths, leaseId: string) => { checkId(leaseId); return join(p.results, `${leaseId}.rejected.json`); };
/** The lease's scratch dir, or null when no scratch parent is configured. */
export const scratchDirOf = (p: HandoffPaths, leaseId: string): string | null => { checkId(leaseId); return p.scratch ? join(p.scratch, leaseId) : null; };

/** Removes one lease's scratch dir (recursive; a symlink in its place is removed, never followed). */
async function removeScratch(p: HandoffPaths, leaseId: string): Promise<string[]> {
  const dir = scratchDirOf(p, leaseId);
  if (!dir) return [];
  try { await rm(dir, { recursive: true, force: true }); return []; } catch (e) { return [`${dir}: ${(e as Error).message}`]; }
}

/**
 * Coordinator start (restart, crash recovery): removes the scratch dirs of every lease that is not active.
 * Workers are subagents of the coordinator session, so an ended lease's dir is leftover data. Active leases
 * keep theirs (recovery may still resume or release them; release removes it). Entries that are not lease
 * dirs are left alone. Best-effort: failures are returned, never thrown.
 */
export async function sweepScratch(p: HandoffPaths, activeLeaseIds: Iterable<string>): Promise<{ removed: string[]; errors: string[] }> {
  const out = { removed: [] as string[], errors: [] as string[] };
  if (!p.scratch) return out;
  let names: string[];
  try { names = await readdir(p.scratch); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') out.errors.push(`${p.scratch}: ${(e as Error).message}`);
    return out;
  }
  const keep = new Set(activeLeaseIds);
  for (const name of names.sort()) {
    if (!LEASE_ID.test(name) || keep.has(name)) continue;
    const errs = await removeScratch(p, name);
    if (errs.length) out.errors.push(...errs); else out.removed.push(name);
  }
  return out;
}

/**
 * Removes a lease's hand-off files (brief, pending and rejected submission). Called whenever a lease ends;
 * best-effort: returns the failures instead of throwing so the caller can log them without failing the transition.
 * The DB keeps the recorded `result_json`.
 */
export async function removeLeaseFiles(p: HandoffPaths, leaseId: string): Promise<string[]> {
  if (!LEASE_ID.test(leaseId)) return [];
  const errors: string[] = [];
  for (const path of [briefPath(p, leaseId), submissionPath(p, leaseId), rejectedPath(p, leaseId)]) {
    try { await rm(path, { force: true }); } catch (e) { errors.push(`${path}: ${(e as Error).message}`); }
  }
  errors.push(...await removeScratch(p, leaseId));
  return errors;
}

/** Coordinator startup step: sweeps leftover scratch dirs of ended leases and logs what it did. Never throws. */
export async function sweepScratchOnStart(db: Pick<RuntimeDb, 'activeLeases'>, p: HandoffPaths, log: (line: string) => void): Promise<void> {
  try {
    const r = await sweepScratch(p, db.activeLeases().map((l) => l.id));
    if (r.removed.length) log(`minions: removed ${r.removed.length} leftover lease scratch dir(s) under ${p.scratch}`);
    if (r.errors.length) log(`minions: could not remove some lease scratch dirs: ${r.errors.join('; ').slice(0, 500)}`);
  } catch (e) { log(`minions: lease scratch sweep failed: ${(e as Error).message.slice(0, 300)}`); }
}

/** Creates the lease's scratch dir (0700). Best-effort: null when unconfigured or not creatable (the worker then uses TMPDIR). */
export async function ensureScratchDir(p: HandoffPaths, leaseId: string): Promise<string | null> {
  const dir = scratchDirOf(p, leaseId);
  if (!dir) return null;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return (await lstat(dir)).isDirectory() ? dir : null;
  } catch { return null; }
}

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

function inside(dir: string, cwd: string): boolean {
  const rel = relative(real(dir), real(cwd));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Throws unless the caller (role + cwd) is the worker of this active lease. Returns the lease. */
export function assertLeaseOwner(db: RuntimeDb, leaseId: string, caller: { role: string; cwd: string }): Lease {
  checkId(leaseId);
  const lease = db.lease(leaseId);
  if (!lease) throw new MinionsError('NOT_FOUND', `Lease ${leaseId} does not exist.`);
  if (lease.status !== 'active') throw new MinionsError('CONFLICT', `Lease ${leaseId} already ended (${lease.status}).`);
  if (caller.role !== lease.role) {
    throw new MinionsError('POLICY_DENIED', `Lease ${leaseId} belongs to a ${lease.role}, not a ${caller.role}.`, 'Use the lease from your own prompt and your own role.');
  }
  if (!lease.worktree) throw new MinionsError('PRECONDITION', `Lease ${leaseId} has no worktree yet.`);
  if (!inside(lease.worktree, caller.cwd)) {
    throw new MinionsError('POLICY_DENIED', `Only the worker of lease ${leaseId} may use it: run this from inside its worktree.`,
      `cd ${lease.worktree} first (your prompt names it).`);
  }
  return lease;
}

/** Stores the full brief for the worker to fetch. */
export async function saveBrief(p: HandoffPaths, brief: TaskBrief): Promise<string> {
  const path = briefPath(p, brief.leaseId);
  await writeJson(path, brief, { mode: 0o600 });
  return path;
}

/** Claims a task, creates its scratch dir and stores its brief; releases the lease again if the brief cannot be stored. */
export async function claimWithBrief(sched: Scheduler, p: HandoffPaths, taskId: string, role: LeaseRole, opts: { holder?: string } = {}): Promise<TaskBrief> {
  const claimed = await sched.claim(taskId, role, opts);
  const scratchDir = await ensureScratchDir(p, claimed.leaseId);
  const brief: TaskBrief = scratchDir ? { ...claimed, scratchDir } : claimed;
  try {
    await saveBrief(p, brief);
  } catch (e) {
    await sched.release(brief.leaseId, `could not store the brief: ${(e as Error).message}`).catch(() => undefined);
    throw e;
  }
  return brief;
}

/** What the coordinator needs from a claim; the worker fetches the rest itself. */
export interface CompactClaim {
  leaseId: string; briefMarker: string; taskId: string; title: string; role: LeaseRole; attempt: number;
  branch: string; worktree: string; expectedHead: string; briefCommand: string;
  /** The lease's disk-backed scratch dir (removed when the lease ends); absent when none was created. */
  scratchDir?: string;
}

export const compactClaim = (b: TaskBrief): CompactClaim => ({
  leaseId: b.leaseId, briefMarker: b.briefMarker, taskId: b.task.id, title: b.task.title, role: b.role, attempt: b.attempt,
  branch: b.branch, worktree: b.worktree, expectedHead: b.expectedHead,
  briefCommand: `minions work brief ${b.leaseId} --role ${b.role} --json`,
  ...(b.scratchDir ? { scratchDir: b.scratchDir } : {}),
});

/** Returns the stored brief, only to the lease's own worker. */
export async function fetchBrief(db: RuntimeDb, p: HandoffPaths, leaseId: string, caller: { role: string; cwd: string }): Promise<TaskBrief> {
  assertLeaseOwner(db, leaseId, caller);
  try {
    return JSON.parse(await readFile(briefPath(p, leaseId), 'utf8')) as TaskBrief;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MinionsError('NOT_FOUND', `No stored brief for lease ${leaseId}.`, 'The lease was claimed without a stored brief; ask the coordinator to paste the brief or reclaim the task.');
    }
    throw e;
  }
}

export interface SubmitResponse { leaseId: string; path: string; bytes: number; replaced: boolean; message: string }

/**
 * Stores a worker's raw result for the coordinator to record. Content is not judged here: `record`
 * validates it exactly as a piped result. A later submit replaces an earlier one (until recorded).
 */
export async function submitResult(db: RuntimeDb, p: HandoffPaths, leaseId: string, raw: string, caller: { role: string; cwd: string }): Promise<SubmitResponse> {
  assertLeaseOwner(db, leaseId, caller);
  if (!raw.trim()) throw new MinionsError('PRECONDITION', 'Empty result: nothing submitted.', 'Pipe the WorkerResult JSON on stdin.');
  const path = submissionPath(p, leaseId);
  let replaced = false;
  try { await stat(path); replaced = true; } catch { /* first submission */ }
  await atomicWrite(path, raw, { mode: 0o600 });
  db.addEvent('submit', db.lease(leaseId)!.task_id, { leaseId, bytes: Buffer.byteLength(raw), replaced });
  return { leaseId, path, bytes: Buffer.byteLength(raw), replaced, message: `Submitted the result for ${leaseId}. End with a one-line summary; the coordinator records it.` };
}

/** Reads the pending submission or fails with a hint. */
export async function readSubmission(p: HandoffPaths, leaseId: string, opts: { correction?: boolean } = {}): Promise<string> {
  try {
    return await readFile(submissionPath(p, leaseId), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    throw new MinionsError('NOT_FOUND', opts.correction
      ? `No corrected result submitted for lease ${leaseId} (the rejected one was set aside).`
      : `No submitted result for lease ${leaseId}.`,
    `Ask the worker to run \`minions work submit ${leaseId} --role <role> --json\` with its WorkerResult on stdin, or pipe the result to \`minions work record ${leaseId}${opts.correction ? ' --correction' : ''}\`.`);
  }
}

/**
 * `minions work record <leaseId> --submitted`: records the submitted file with the same validation and
 * correction semantics as stdin. A rejected submission is moved aside so a correction must be a new submit;
 * once the result is final (valid, or unvalidated after the correction) the lease's files are removed (the DB keeps it).
 * The lease is checked first, so an ended lease reports CONFLICT rather than a missing file.
 */
export async function recordSubmitted(sched: Scheduler, p: HandoffPaths, leaseId: string, opts: { correction?: boolean } = {}): Promise<RecordResponse> {
  checkId(leaseId);
  await sched.requireActive(leaseId);
  const raw = await readSubmission(p, leaseId, opts);
  const r = await sched.record(leaseId, raw, opts);
  const path = submissionPath(p, leaseId);
  if (!r.valid && r.correctionAllowed) {
    await rename(path, rejectedPath(p, leaseId));
    return { ...r, message: `Result rejected; one bounded correction is allowed: relay the listed errors to the worker, have it fix them and run \`minions work submit ${leaseId}\` again, then \`minions work record ${leaseId} --submitted --correction\`.` };
  } else {
    // The scheduler already cleaned up its configured paths; this covers a caller passing other paths.
    await removeLeaseFiles(p, leaseId);
  }
  return r;
}
