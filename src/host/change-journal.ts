// The host journal of change-request confirmations (docs/design/host-manager.md, "Confirmation model"):
// <MINIONS_HOME>/manager/journal.jsonl (0600, append-only JSON lines; compacted once large, see below). The container never reads or writes it.
//
// - `offer`: the plan the owner was shown, its digest, the configRevision it was computed against, a 128-bit
//   single-use nonce and the expiry (30 minutes). It also keeps the request as it was read then (kind, payload,
//   reason): a confirmation recomputes the plan from that snapshot, never from the container's row again.
// - `confirmed`: consumes the nonce. Checking the nonce and appending this entry happen under the journal lock,
//   so a second confirmation of the same offer finds it spent ("already handled"). Slow work (the upgrade dry run)
//   stays outside the lock: other writers give up after 10 s (task-53.11).
// - `applying` (manager): the child command started. `confirmed` and `applying` carry the writer's pid and process
//   start time, so a manager that starts again can tell an entry of a dead process (interrupted, state unknown) from
//   an apply still running in another process.
// - `applied` / `failed` / `rejected`: the outcome.
// - Owner-initiated requests (task-53.5.3: /set, /sync, /upgrade, /restart, /undo in the manager chat) have no
//   container row. Their id is host-generated (`ow_` + 8 hex, never the container's `cr_`), their snapshot says
//   `origin: 'owner'`, and they live only in this journal: nothing marks a runtime row for them.
// - An owner command typed in the paired manager chat (task-78) carries `typed`, the Telegram message it came from
//   (`telegram:<botId>:<chatId>:<messageId>`); there is at most one offer per message, so a redelivered update is
//   "already handled", never planned or applied twice. A typed plan that loosens nothing and runs no container-built
//   code on the host is applied without a tap: its offer (`direct`) and its `confirmed` entry are appended together,
//   as one step under the journal lock. Its nonce is minted and spent in that step, so no tap can ever use it.
// - Compaction (task-90): once the file reaches COMPACT_AT_BYTES, the append that finds it there rewrites the file
//   (under the same journal lock, atomically) without the oldest closed requests; compactEntries says what is kept.
// The manager (task-53.4, src/host/manager.ts) adds its own process lock and the offer messages on top of this file.
import { randomBytes } from 'node:crypto';
import { appendFile, chmod, open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isChangeRequestId } from '../runtime/change-requests.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, ensureDir } from '../core/fsutil.js';
import { managerDir } from '../core/paths.js';
import { procStartTime } from '../runtime/coordinator.js';
import { pidAlive } from '../runtime/db.js';

/** How long the owner has to confirm an offered plan. */
export const CONFIRM_TTL_MS = 30 * 60 * 1000;

export { managerDir };
export const journalPath = () => join(managerDir(), 'journal.jsonl');
const lockPath = () => join(managerDir(), 'journal.lock');

/**
 * The request as the host read it when it built the plan (untrusted content; re-validated on every use).
 * `origin: 'owner'`: typed by the owner in the manager chat (an `ow_` id that only the host mints); absent for a
 * container request.
 */
export interface RequestSnapshot {
  id: string; kind: string; payload: Record<string, unknown>; reason: string | null; origin?: 'owner';
  /**
   * 'assistant': an owner request the manager's assistant proposed from the owner's plain-language message (task-65.4).
   * Only on an owner request; absent for typed commands and container requests, so their digests stay unchanged.
   */
  via?: 'assistant';
}

/** Ids of owner-initiated requests: minted by the host manager, never by the container (whose ids are `cr_`). */
export const OWNER_REQUEST_ID_PATTERN = /^ow_[0-9a-f]{8}$/;
export const isOwnerRequestId = (s: string) => OWNER_REQUEST_ID_PATTERN.test(s);
export const newOwnerRequestId = () => `ow_${randomBytes(4).toString('hex')}`;
/** A request id an offer may carry: a container request (`cr_`) or an owner-initiated one (`ow_`). */
export const isOfferRequestId = (s: string) => isChangeRequestId(s) || isOwnerRequestId(s);
/** True only for an owner-initiated request: the host-minted id and the owner origin together. */
export const isOwnerRequest = (r: Pick<RequestSnapshot, 'id' | 'origin'>) => r.origin === 'owner' && isOwnerRequestId(r.id);

export interface OfferEntry {
  type: 'offer'; at: string; projectId: string; requestId: string;
  digest: string; configRevision: number; nonce: string; expiresAt: string;
  request: RequestSnapshot; plan: unknown;
  /** Owner-typed (task-78): the chat message the command came from (TYPED_KEY_PATTERN); one offer per message. */
  typed?: string;
  /** Confirmed in the same step it was recorded: an owner-typed plan applied without a tap (task-78). */
  direct?: true;
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

const lines = (entries: JournalEntry[]) => entries.map((e) => JSON.stringify(e) + '\n').join('');

/** Only under the journal lock (every writer holds it), so a compaction never loses an entry another writer appends. */
async function append(...entries: JournalEntry[]): Promise<void> {
  await ensureDir(managerDir(), 0o700);
  // One write for all the lines (a torn last line is skipped when read: at worst a direct offer stays unconfirmed,
  // which only a Confirm tap could then apply).
  await appendFile(journalPath(), lines(entries), { mode: 0o600 });
  await chmod(journalPath(), 0o600).catch(() => undefined);
  // The entries are written: a failed compaction only leaves the file longer, it never fails the append.
  await compactIfLarge().catch(() => undefined);
}

/** The journal size from which an append compacts it (a stat per append; the file is read only past this size). */
export const COMPACT_AT_BYTES = 1024 * 1024;
/** Closed requests a compaction keeps (newest first): history, redelivery checks and the owner's views. */
export const KEEP_CLOSED_REQUESTS = 100;
/**
 * Applied config changes (config-set, undo) a compaction keeps per project, newest first, whatever the other closed
 * requests: the /undo candidates come from them. As many as the config history keeps (CONFIG_HISTORY_KEEP of
 * config-history.ts): an older change cannot be undone anyway.
 */
export const KEEP_UNDO_PER_PROJECT = 20;

const CLOSED_TYPES: ReadonlySet<string> = new Set(['applied', 'failed', 'rejected']);

/**
 * The entries a compaction keeps, in their order. Entries are grouped by request (project and request id); a request
 * is kept or dropped whole. Kept: every request whose newest entry is not applied / failed / rejected (an open offer,
 * a confirmed or applying one: in flight or interrupted; anything unknown too); per project the newest `keepUndo`
 * applied config-set / undo requests (a suffix in applied order, so an undo is never dropped while the change it
 * reverted is kept); and the newest `keepClosed` other closed requests. Older closed requests are dropped.
 *
 * Tombstones (task-90 repair; chosen over "keep until the runtime row is closed" and "treat missing-and-old as
 * handled"): a dropped container request (`cr_`) whose outcome is applied or rejected keeps one line, its final
 * outcome without the details (`{type, at, projectId, requestId}`). The runtime row is marked after the journal entry
 * and that mark is best effort, so the row can still read `proposed`; the manager's poll (needsOffer) and every
 * confirmation (assertOfferOpen, via lastOutcome) then still see "already handled", so the request is never offered
 * or applied again. Compaction cannot ask the runtime (it runs under the journal lock in append, with no container
 * access), and a horizon rule would need a timestamp the poll can trust for every row. A dropped failed request needs
 * no tombstone (a failed request may be offered and confirmed again anyway); an owner request (`ow_`) has no runtime
 * row. Tombstones cost about 100 bytes each and are kept. Returns `entries` itself when nothing changes (an existing
 * tombstone stays as it is).
 */
export function compactEntries(entries: JournalEntry[], o: { keepClosed?: number; keepUndo?: number } = {}): JournalEntry[] {
  const keepClosed = o.keepClosed ?? KEEP_CLOSED_REQUESTS;
  const keepUndo = o.keepUndo ?? KEEP_UNDO_PER_PROJECT;
  const keyOf = (e: JournalEntry) => `${e.projectId}\0${e.requestId}`;
  const last = new Map<string, { at: number; e: JournalEntry }>();
  const kinds = new Map<string, unknown>();
  const count = new Map<string, number>();
  entries.forEach((e, at) => {
    last.set(keyOf(e), { at, e });
    count.set(keyOf(e), (count.get(keyOf(e)) ?? 0) + 1);
    if (e.type === 'offer') kinds.set(keyOf(e), (e.request as Partial<RequestSnapshot> | undefined)?.kind);
  });
  const closed = [...last].filter(([, v]) => CLOSED_TYPES.has(v.e.type)).sort((a, b) => b[1].at - a[1].at);
  const undoKept = new Map<string, number>();
  const drop = new Set<string>();
  /** Dropped requests that leave a tombstone: key -> the index (in `entries`) of the final outcome it replaces. */
  const tombs = new Map<string, number>();
  let tail = 0;
  for (const [key, { at, e }] of closed) {
    const kind = kinds.get(key);
    if (e.type === 'applied' && (kind === 'config-set' || kind === 'undo')) {
      const n = undoKept.get(e.projectId) ?? 0;
      if (n < keepUndo) { undoKept.set(e.projectId, n + 1); continue; }
    }
    if (tail < keepClosed) { tail++; continue; }
    if (needsTombstone(e)) {
      if (count.get(key) === 1 && isTombstone(e)) continue; // already a tombstone: unchanged
      tombs.set(key, at);
    }
    drop.add(key);
  }
  if (!drop.size) return entries;
  const out: JournalEntry[] = [];
  entries.forEach((e, at) => {
    const key = keyOf(e);
    if (!drop.has(key)) out.push(e);
    else if (tombs.get(key) === at) out.push(tombstoneOf(e as OutcomeEntry));
  });
  return out;
}

/** A closed container request whose outcome must outlive compaction (see compactEntries). */
const needsTombstone = (e: JournalEntry) => (e.type === 'applied' || e.type === 'rejected') && isChangeRequestId(e.requestId);
const tombstoneOf = (e: OutcomeEntry): OutcomeEntry => ({ type: e.type, at: e.at, projectId: e.projectId, requestId: e.requestId });
const isTombstone = (e: JournalEntry) => Object.keys(e).length === 4;

/** Under the journal lock: from COMPACT_AT_BYTES on, rewrites the journal (temp file, rename) without what compactEntries drops. */
async function compactIfLarge(): Promise<void> {
  if ((await stat(journalPath())).size < COMPACT_AT_BYTES) return;
  const entries = await readJournal();
  const kept = compactEntries(entries);
  if (kept === entries) return;
  await atomicWrite(journalPath(), lines(kept), { mode: 0o600 });
}

/**
 * A lock file is created empty (O_EXCL) and its holder is written right after. A file without a readable holder that
 * is younger than this is in that window: held, not stale. Only an older one (its writer died between the two steps)
 * is taken over.
 */
export const LOCK_WRITE_GRACE_MS = 2_000;

/**
 * The state of a lock file another writer created: `gone` (removed meanwhile: try again now), `stale` (its holder is
 * dead, or it stayed without a holder past LOCK_WRITE_GRACE_MS: take it over) or `held` (pid null: not written yet).
 *
 * task-80: a lock read in the create-then-write window used to count as dead and was taken over, so two
 * confirmations of one offer could both pass the spent check under "the" lock and both apply.
 */
export async function lockFileState(
  path: string, holderOf: (text: string) => number | null, alive: (pid: number) => boolean = pidAlive,
): Promise<{ state: 'gone' } | { state: 'stale' } | { state: 'held'; pid: number | null }> {
  const gone = (e: unknown) => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'gone' as const }; throw e; };
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (e) { return gone(e); }
  const pid = holderOf(text);
  if (pid !== null) return alive(pid) ? { state: 'held', pid } : { state: 'stale' };
  let mtime: number;
  try { mtime = (await stat(path)).mtimeMs; } catch (e) { return gone(e); }
  return Date.now() - mtime > LOCK_WRITE_GRACE_MS ? { state: 'stale' } : { state: 'held', pid: null };
}

/** The journal lock's holder pid: the file reads `<pid> <token>` (older writers wrote only `<pid>`). */
const journalHolder = (text: string): number | null => {
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Runs fn holding <manager>/journal.lock (O_EXCL file with the holder pid and a token). A lock of a dead pid is taken
 * over; one still being written is not (lockFileState). The release removes the file only while it carries this
 * holder's token.
 */
export async function withJournalLock<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  await ensureDir(managerDir(), 0o700);
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid} ${randomBytes(8).toString('hex')}`;
  for (;;) {
    let h: Awaited<ReturnType<typeof open>>;
    try {
      h = await open(lockPath(), 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const s = await lockFileState(lockPath(), journalHolder);
      if (s.state === 'gone') continue;
      if (s.state === 'stale') { await rm(lockPath(), { force: true }); continue; }
      if (Date.now() >= deadline) {
        throw new MinionsError('CONFLICT', `The change-request journal is locked by ${s.pid === null ? 'another process' : `process ${s.pid}`}.`,
          'Wait for the other `minions settings apply` (or the manager) to finish, then retry.');
      }
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    try {
      await h.writeFile(token);
      await h.close();
    } catch (e) {
      await h.close().catch(() => undefined);
      await rm(lockPath(), { force: true });
      throw e;
    }
    break;
  }
  try { return await fn(); } finally {
    if (await readFile(lockPath(), 'utf8').catch(() => '') === token) await rm(lockPath(), { force: true });
  }
}

const nowIso = (now: Date) => now.toISOString();

/** The chat message an owner-typed command came from: `telegram:<botId>:<chatId>:<messageId>`. */
export const TYPED_KEY_PATTERN = /^telegram:\d{1,20}:-?\d{1,20}:\d{1,20}$/;

/**
 * Records an offer for a plan; returns it (nonce and expiry included).
 *
 * `typed` (an owner-typed command, task-78): refused with CONFLICT (`details.refusal` redelivered, `details.requestId`
 * the earlier request) when an offer for the same chat message is already journaled, so a redelivered update is never
 * handled twice. `confirmed` (only with `typed`, only for an owner request): the `confirmed` entry is appended in the
 * same locked step, so the nonce is spent before anything could show it; the caller applies the plan next.
 */
export async function recordOffer(o: {
  projectId: string; request: RequestSnapshot; plan: unknown; digest: string; configRevision: number; now?: Date; typed?: string; confirmed?: boolean;
}): Promise<OfferEntry> {
  const now = o.now ?? new Date();
  if (o.typed !== undefined && !TYPED_KEY_PATTERN.test(o.typed)) throw new MinionsError('INTERNAL', 'malformed owner message key; nothing recorded.');
  if (o.confirmed && (o.typed === undefined || !isOwnerRequest(o.request))) {
    throw new MinionsError('INTERNAL', `request ${o.request.id}: only an owner-typed request is confirmed when it is recorded; nothing recorded.`);
  }
  const entry: OfferEntry = {
    type: 'offer', at: nowIso(now), projectId: o.projectId, requestId: o.request.id, digest: o.digest, configRevision: o.configRevision,
    nonce: randomBytes(16).toString('hex'), expiresAt: new Date(now.getTime() + CONFIRM_TTL_MS).toISOString(), request: o.request, plan: o.plan,
    ...(o.typed !== undefined ? { typed: o.typed } : {}), ...(o.confirmed ? { direct: true as const } : {}),
  };
  await withJournalLock(async () => {
    if (o.typed !== undefined) {
      const earlier = (await readJournal()).find((e): e is OfferEntry => e.type === 'offer' && e.typed === o.typed);
      if (earlier) {
        throw new MinionsError('CONFLICT', `this message was already handled as ${earlier.requestId} (a redelivered update); nothing was done again.`, undefined,
          { refusal: 'redelivered', requestId: earlier.requestId, projectId: earlier.projectId });
      }
    }
    await append(entry, ...(o.confirmed ? [{
      type: 'confirmed' as const, at: nowIso(now), projectId: entry.projectId, requestId: entry.requestId, nonce: entry.nonce, digest: entry.digest, detail: 'typed by the owner', ...writer(),
    }] : []));
  });
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
    assertOfferOpen(await readJournal(), offer);
    await check();
    await append({ type: 'confirmed', at: nowIso(now), projectId: offer.projectId, requestId: offer.requestId, nonce: offer.nonce, digest: offer.digest, ...writer() });
  });
}

/**
 * Throws CONFLICT when the offer's nonce is spent (`details.refusal` spent) or the request already handled
 * (handled). consumeOffer runs it under the lock; callers may also run it before slow work as an early refusal
 * (that read is advisory only: the check under the lock decides).
 */
export function assertOfferOpen(entries: JournalEntry[], offer: OfferEntry): void {
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
