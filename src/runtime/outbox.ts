// Notification outbox (spec §611, docs/design/telegram.md#notification-outbox): every notification the
// coordinator owes the owner (goal acknowledgements, deliveries with links, blockers, approvals,
// on-demand status) is recorded in the runtime DB under a dedup key *before* it is sent and acknowledged
// after. A channel outage therefore loses nothing: pending rows are retried on the next interaction or
// `minions sync`, and a key that was delivered once is never sent again. Nothing here wakes an LLM: the
// outbox is only read when the coordinator is awake anyway. Transport-agnostic: Telegram (the plugin's
// `reply` tool, called by the coordinator) is one transport; tests use a fake one.
import type { RuntimeDb } from './db.js';
import { MinionsError } from '../core/errors.js';

export const NOTIFICATION_KINDS = ['goal-ack', 'delivered', 'feature', 'blocker', 'approval', 'question', 'status', 'other'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Telegram's message limit is 4096 characters; keep notifications short and below it. */
export const MAX_TEXT_LENGTH = 4000;
/** Stable, readable keys such as `delivered:task-2.3:<sha>` or `goal-ack:<message id>`. */
export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@#+=-]{0,199}$/;
const MAX_ERROR_LENGTH = 300;
/** Retry backoff after a failed send: 30 s doubling per attempt, capped at 30 min. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;

export interface OutboxItem {
  key: string; kind: NotificationKind; taskId: string | null; text: string; createdAt: string;
  attempts: number; lastError: string | null; nextAttemptAt: string | null;
  deliveredAt: string | null; deliveredVia: string | null;
}

interface OutboxRow {
  dedup_key: string; kind: string; task_id: string | null; text: string; created_at: string;
  attempts: number; last_error: string | null; next_attempt_at: string | null; delivered_at: string | null; delivered_via: string | null;
}

const toItem = (r: OutboxRow): OutboxItem => ({
  key: r.dedup_key, kind: r.kind as NotificationKind, taskId: r.task_id, text: r.text, createdAt: r.created_at,
  attempts: r.attempts, lastError: r.last_error, nextAttemptAt: r.next_attempt_at, deliveredAt: r.delivered_at, deliveredVia: r.delivered_via,
});

/** A channel that can deliver one notification; it throws when the send fails. */
export interface NotificationTransport {
  readonly name: string;
  send(item: OutboxItem): Promise<void>;
}

type Clock = () => Date;
const systemClock: Clock = () => new Date();

export const backoffMs = (attempts: number): number => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);

/**
 * Credential-like keys whose `key=value` / `key: value` value is masked (case-insensitive, also with a
 * prefix such as `client_secret`, `x-access-token` or a JSON-quoted key).
 */
const SECRET_KEY = String.raw`\b([\w-]*?(?:password|passwd|api[_-]?key|secret|token|authorization))`;

/**
 * Shortens an error and masks anything that looks like a credential: bot tokens, GitHub tokens, the
 * token after `Bearer`, and the values of password/passwd/api_key/apikey/secret/token/authorization
 * keys. Prose such as "Bearer token is missing" is left readable (a bearer token has 8+ characters).
 */
export function redactError(message: string): string {
  const masked = message
    .replace(/(?:bot)?\d{6,}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/gi, '[redacted]')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bbearer\s+(?!\[redacted\])[^\s"',;]{8,}/gi, 'Bearer [redacted]')
    .replace(new RegExp(`${SECRET_KEY}(\\s*["']?\\s*[:=]\\s*["']?)(?!\\[redacted\\]|bearer\\s)[^\\s"'&,;]+`, 'gi'), '$1$2[redacted]')
    // "token <value>" without a separator: only values that look generated (12+ chars with a digit).
    .replace(/\b(token|authorization)(\s+)(?!\[redacted\])(?=[^\s"']*\d)[^\s"']{12,}/gi, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return masked.length > MAX_ERROR_LENGTH ? `${masked.slice(0, MAX_ERROR_LENGTH - 1)}…` : masked;
}

function get(db: RuntimeDb, key: string): OutboxItem | undefined {
  const r = db.get<OutboxRow>('SELECT * FROM outbox WHERE dedup_key = ?', key);
  return r ? toItem(r) : undefined;
}

function requireItem(db: RuntimeDb, key: string): OutboxItem {
  const item = get(db, key);
  if (!item) throw new MinionsError('NOT_FOUND', `No notification with key ${key}.`, 'List pending ones with `minions notify pending`.');
  return item;
}

export interface EnqueueInput { key: string; kind: string; taskId?: string | null; text: string }
export interface EnqueueResult { created: boolean; item: OutboxItem }

/** Records a notification; an existing key (pending or delivered) is a no-op that returns the stored row. */
export function enqueue(db: RuntimeDb, input: EnqueueInput, clock: Clock = systemClock): EnqueueResult {
  const key = input.key.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new MinionsError('PRECONDITION', `Invalid notification key ${JSON.stringify(input.key)}.`, 'Use 1-200 characters: letters, digits and . _ : / @ # + = - (for example delivered:task-2.3:<sha>).');
  }
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(input.kind)) {
    throw new MinionsError('PRECONDITION', `Unknown notification kind ${input.kind}.`, `Use one of: ${NOTIFICATION_KINDS.join(', ')}.`);
  }
  const text = input.text.trim();
  if (!text) throw new MinionsError('PRECONDITION', 'The notification text is empty.', 'Pass the text on stdin.');
  if (text.length > MAX_TEXT_LENGTH) throw new MinionsError('PRECONDITION', `The notification text is ${text.length} characters (max ${MAX_TEXT_LENGTH}).`, 'Shorten it: report outcomes, not logs.');
  return db.transaction(() => {
    const existing = get(db, key);
    if (existing) return { created: false, item: existing };
    db.exec('INSERT INTO outbox (dedup_key, kind, task_id, text, created_at, attempts) VALUES (?, ?, ?, ?, ?, 0)',
      key, input.kind, input.taskId ?? null, text, clock().toISOString());
    db.addEvent('notify-enqueue', input.taskId ?? null, { key, kind: input.kind });
    return { created: true, item: get(db, key)! };
  });
}

/**
 * Undelivered notifications, oldest first. By default only those due now (not inside a retry backoff);
 * `includeWaiting` lists every undelivered one.
 */
export function pending(db: RuntimeDb, opts: { includeWaiting?: boolean; limit?: number } = {}, clock: Clock = systemClock): OutboxItem[] {
  const now = clock().toISOString();
  const rows = opts.includeWaiting
    ? db.all<OutboxRow>('SELECT * FROM outbox WHERE delivered_at IS NULL ORDER BY created_at, rowid')
    : db.all<OutboxRow>('SELECT * FROM outbox WHERE delivered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, rowid', now);
  const items = rows.map(toItem);
  return opts.limit !== undefined ? items.slice(0, opts.limit) : items;
}

/** Marks a notification delivered. Acknowledging an already delivered key is a no-op (it keeps the first delivery). */
export function ack(db: RuntimeDb, key: string, via = 'unknown', clock: Clock = systemClock): { item: OutboxItem; alreadyDelivered: boolean } {
  return db.transaction(() => {
    const item = requireItem(db, key);
    if (item.deliveredAt) return { item, alreadyDelivered: true };
    db.exec('UPDATE outbox SET delivered_at = ?, delivered_via = ?, next_attempt_at = NULL WHERE dedup_key = ?', clock().toISOString(), via, key);
    db.addEvent('notify-delivered', item.taskId, { key, via });
    return { item: get(db, key)!, alreadyDelivered: false };
  });
}

/** Records a failed send: counts the attempt and schedules the next one after a backoff. The row is never dropped. */
export function fail(db: RuntimeDb, key: string, error: string, clock: Clock = systemClock): OutboxItem {
  return db.transaction(() => {
    const item = requireItem(db, key);
    if (item.deliveredAt) return item;
    const attempts = item.attempts + 1;
    const next = new Date(clock().getTime() + backoffMs(attempts)).toISOString();
    db.exec('UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE dedup_key = ?', attempts, redactError(error) || 'send failed', next, key);
    return get(db, key)!;
  });
}

export interface OutboxCounts { pending: number; due: number; waiting: number; delivered: number; oldestPendingAt: string | null }

export function counts(db: RuntimeDb, clock: Clock = systemClock): OutboxCounts {
  const now = clock().toISOString();
  const r = db.get<{ pending: number; due: number; delivered: number; oldest: string | null }>(
    `SELECT SUM(delivered_at IS NULL) AS pending,
            SUM(delivered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) AS due,
            SUM(delivered_at IS NOT NULL) AS delivered,
            MIN(CASE WHEN delivered_at IS NULL THEN created_at END) AS oldest
     FROM outbox`, now);
  const p = Number(r?.pending ?? 0), d = Number(r?.due ?? 0);
  return { pending: p, due: d, waiting: p - d, delivered: Number(r?.delivered ?? 0), oldestPendingAt: r?.oldest ?? null };
}

export interface FlushReport { sent: string[]; failed: { key: string; error: string }[]; remaining: number }

/**
 * Sends the due notifications through `transport`, acknowledging each one after it was sent. The first
 * failure stops the pass (the channel is most likely down): that item is recorded as failed and the
 * rest stay pending, untouched, for the next pass. Delivery is at least once: a crash between the send
 * and the ack can repeat that one message.
 */
export async function flush(db: RuntimeDb, transport: NotificationTransport, opts: { limit?: number } = {}, clock: Clock = systemClock): Promise<FlushReport> {
  const report: FlushReport = { sent: [], failed: [], remaining: 0 };
  for (const item of pending(db, { limit: opts.limit }, clock)) {
    // Re-check: another pass may have delivered it meanwhile.
    if (get(db, item.key)?.deliveredAt) continue;
    try {
      await transport.send(item);
    } catch (e) {
      const failed = fail(db, item.key, (e as Error)?.message ?? String(e), clock);
      report.failed.push({ key: item.key, error: failed.lastError ?? 'send failed' });
      break;
    }
    ack(db, item.key, transport.name, clock);
    report.sent.push(item.key);
  }
  report.remaining = counts(db, clock).pending;
  return report;
}

/** One line per item for the terminal (the text is the owner's own notification, shown as is). */
export function formatItems(items: OutboxItem[]): string {
  if (!items.length) return '(no pending notifications)';
  return items.map((i) => `${i.key}  [${i.kind}${i.taskId ? ` ${i.taskId}` : ''}] attempts=${i.attempts}${i.lastError ? ` last error: ${i.lastError}` : ''}\n  ${i.text.split('\n').join('\n  ')}`).join('\n');
}

export const formatCounts = (c: OutboxCounts): string =>
  `notifications: ${c.pending} pending${c.waiting ? ` (${c.waiting} waiting to retry)` : ''}${c.oldestPendingAt ? `, oldest ${c.oldestPendingAt}` : ''}`;
