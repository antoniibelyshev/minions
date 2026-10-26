// The host journal of change-request confirmations (docs/design/host-manager.md, "Confirmation model"):
// <MINIONS_HOME>/manager/journal.jsonl (0600, append-only JSON lines). The container never reads or writes it.
//
// - `offer`: the plan the owner was shown, its digest, the configRevision it was computed against, a 128-bit
//   single-use nonce and the expiry (30 minutes). It also keeps the request as it was read then (kind, payload,
//   reason): a confirmation recomputes the plan from that snapshot, never from the container's row again.
// - `confirmed`: consumes the nonce. Checking the nonce and appending this entry happen under the journal lock,
//   so a second confirmation of the same offer finds it spent ("already handled").
// - `applying` (manager): the child command started. `confirmed` and `applying` carry the writer's pid and process
//   start time, so a manager that starts again can tell an entry of a dead process (interrupted, state unknown) from
//   an apply still running in another process.
// - `applied` / `failed` / `rejected`: the outcome.
// The manager (task-53.4, src/host/manager.ts) adds its own process lock and the offer messages on top of this file.
import { randomBytes } from 'node:crypto';
import { appendFile, chmod, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { ensureDir } from '../core/fsutil.js';
import { managerDir } from '../core/paths.js';
import { procStartTime } from '../runtime/coordinator.js';
import { pidAlive } from '../runtime/db.js';

/** How long the owner has to confirm an offered plan. */
export const CONFIRM_TTL_MS = 30 * 60 * 1000;

export { managerDir };
export const journalPath = () => join(managerDir(), 'journal.jsonl');
const lockPath = () => join(managerDir(), 'journal.lock');

/** The request as the host read it when it built the plan (untrusted content; re-validated on every use). */
export interface RequestSnapshot { id: string; kind: string; payload: Record<string, unknown>; reason: string | null }

export interface OfferEntry {
  type: 'offer'; at: string; projectId: string; requestId: string;
  digest: string; configRevision: number; nonce: string; expiresAt: string;
  request: RequestSnapshot; plan: unknown;
}
export interface OutcomeEntry {
  type: 'confirmed' | 'applying' | 'applied' | 'failed' | 'rejected'; at: string; projectId: string; requestId: string;
  nonce?: string; digest?: string; detail?: string;
  /** confirmed / applying: the process that wrote it (pid and /proc start time when readable). */
  pid?: number; start?: string | null;
}
export type JournalEntry = OfferEntry | OutcomeEntry;

export async function readJournal(): Promise<JournalEntry[]> {
  let text: string;
  try { text = await readFile(journalPath(), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: JournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as JournalEntry); } catch { /* a torn last line is skipped */ }
  }
  return out;
}

async function append(entry: JournalEntry): Promise<void> {
  await ensureDir(managerDir(), 0o700);
  await appendFile(journalPath(), JSON.stringify(entry) + '\n', { mode: 0o600 });
  await chmod(journalPath(), 0o600).catch(() => undefined);
}

/** Runs fn holding <manager>/journal.lock (O_EXCL file with the holder pid; a lock of a dead pid is taken over). */
export async function withJournalLock<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  await ensureDir(managerDir(), 0o700);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const h = await open(lockPath(), 'wx', 0o600);
      await h.writeFile(String(process.pid));
      await h.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = Number.parseInt(await readFile(lockPath(), 'utf8').catch(() => ''), 10);
      if (!pidAlive(holder)) { await rm(lockPath(), { force: true }); continue; }
      if (Date.now() >= deadline) throw new MinionsError('CONFLICT', `The change-request journal is locked by process ${holder}.`, 'Wait for the other `minions settings apply` (or the manager) to finish, then retry.');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await fn(); } finally { await rm(lockPath(), { force: true }); }
}

const nowIso = (now: Date) => now.toISOString();

/** Records an offer for a plan; returns it (nonce and expiry included). */
export async function recordOffer(o: { projectId: string; request: RequestSnapshot; plan: unknown; digest: string; configRevision: number; now?: Date }): Promise<OfferEntry> {
  const now = o.now ?? new Date();
  const entry: OfferEntry = {
    type: 'offer', at: nowIso(now), projectId: o.projectId, requestId: o.request.id, digest: o.digest, configRevision: o.configRevision,
    nonce: randomBytes(16).toString('hex'), expiresAt: new Date(now.getTime() + CONFIRM_TTL_MS).toISOString(), request: o.request, plan: o.plan,
  };
  await withJournalLock(() => append(entry));
  return entry;
}

/** The newest offer for this request and digest, with whether its nonce is spent. */
export async function findOffer(projectId: string, requestId: string, digest: string): Promise<{ offer: OfferEntry; spent: boolean } | null> {
  const entries = await readJournal();
  const offer = entries.filter((e): e is OfferEntry => e.type === 'offer' && e.projectId === projectId && e.requestId === requestId && e.digest === digest).at(-1);
  if (!offer) return null;
  return { offer, spent: entries.some((e) => e.type === 'confirmed' && e.nonce === offer.nonce) };
}

/**
 * Consumes an offer's nonce: under the journal lock, refuses (CONFLICT) when it is already spent, then appends
 * `confirmed`. `check` runs under the lock before the entry is written (the expiry and digest checks).
 */
export async function consumeOffer(offer: OfferEntry, check: () => Promise<void> = async () => undefined, now = new Date()): Promise<void> {
  await withJournalLock(async () => {
    const entries = await readJournal();
    if (entries.some((e) => e.type === 'confirmed' && e.nonce === offer.nonce)) {
      throw new MinionsError('CONFLICT', `Change request ${offer.requestId}: this confirmation was already used (already handled).`, 'List requests with `minions settings requests --all`.', { refusal: 'spent' });
    }
    // Another offer of the same request: applied or rejected is final; confirmed without an outcome is in flight or
    // was interrupted (state unknown). Only a failed request may be confirmed again.
    const last = lastOutcome(entries, offer.projectId, offer.requestId);
    if (last && last.type !== 'failed') {
      throw new MinionsError('CONFLICT', last.type === 'confirmed' || last.type === 'applying'
        ? `Change request ${offer.requestId} was already confirmed at ${last.at} and has no recorded outcome (in progress, or interrupted: state unknown).`
        : `Change request ${offer.requestId} was already ${last.type} at ${last.at} (already handled).`, 'List requests with `minions settings requests --all`.', { refusal: 'handled' });
    }
    await check();
    await append({ type: 'confirmed', at: nowIso(now), projectId: offer.projectId, requestId: offer.requestId, nonce: offer.nonce, digest: offer.digest, ...writer() });
  });
}

export async function recordOutcome(e: Omit<OutcomeEntry, 'at'>, now = new Date()): Promise<void> {
  await withJournalLock(() => append({ ...e, at: nowIso(now) }));
}

/** The pid and process start time of this process (recorded in confirmed / applying entries). */
export const writer = (): { pid: number; start: string | null } => ({ pid: process.pid, start: procStartTime(process.pid) });

/** Whether the process that wrote an entry still runs (same pid and, when both are known, the same start time). */
export function writerAlive(e: { pid?: number; start?: string | null }, alive: (pid: number) => boolean = pidAlive, startOf: (pid: number) => string | null = procStartTime): boolean {
  if (e.pid === undefined || !alive(e.pid)) return false;
  if (!e.start) return true;
  const now = startOf(e.pid);
  return now === null || now === e.start;
}

/** The newest non-offer entry of a request (its current outcome), if any. */
export function lastOutcome(entries: JournalEntry[], projectId: string, requestId: string): OutcomeEntry | undefined {
  return entries.filter((e): e is OutcomeEntry => e.type !== 'offer' && e.projectId === projectId && e.requestId === requestId).at(-1);
}

/** The offer with this nonce (nonces are 128-bit random, unique across projects), with whether it is spent. */
export async function findOfferByNonce(nonce: string): Promise<{ offer: OfferEntry; spent: boolean } | null> {
  const entries = await readJournal();
  const offer = entries.find((e): e is OfferEntry => e.type === 'offer' && e.nonce === nonce);
  if (!offer) return null;
  return { offer, spent: entries.some((e) => e.type === 'confirmed' && e.nonce === nonce) };
}

/**
 * Requests whose newest outcome is `confirmed` or `applying` and whose writer process is gone: the apply was
 * interrupted and its state is unknown. An entry of a process that still runs (another `settings apply`) is left out.
 */
export function interruptedEntries(entries: JournalEntry[], alive: (e: OutcomeEntry) => boolean = (e) => writerAlive(e)): OutcomeEntry[] {
  const lastBy = new Map<string, OutcomeEntry>();
  for (const e of entries) if (e.type !== 'offer') lastBy.set(`${e.projectId}\0${e.requestId}`, e);
  return [...lastBy.values()].filter((e) => (e.type === 'confirmed' || e.type === 'applying') && !alive(e));
}
