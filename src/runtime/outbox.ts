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
 * prefix such as `client_secret`, `x-access-token`, `aws_secret_access_key`, `X-Amz-Signature` or a
 * JSON-quoted key).
 */
const SECRET_KEY = String.raw`\b([\w-]*?(?:password|passwd|api[_-]?key|(?:secret|access|private)[_-]?key|secret|token|authorization|signature|credentials?))`;
/** Auth scheme words after an authorization key: they belong to the separator, the value follows them. */
const AUTH_SCHEME = String.raw`(?:bearer|token|basic|digest|negotiate|ntlm|aws4-hmac-sha256)\s`;
/** Schemes whose header credential is masked whole (Bearer has its own rule that keeps prose readable). */
const AUTH_HEADER_SCHEME = String.raw`(?:token|basic|digest|negotiate|ntlm|aws4-hmac-sha256)`;
/** Horizontal whitespace, or a line break that folds the header onto an indented next line. */
const HWS = String.raw`(?:[^\S\n]|\n(?=[ \t]))`;
/**
 * One credential item: a token68 (`dXNlcjpw==`) or an auth param (`key=token`, `key = "quoted"`,
 * `SignedHeaders=host;range`). Its parts, in order:
 * - a JSON escape (`\"`, `\\`) of a header logged inside a JSON string;
 * - whitespace around a param's `=` (`nc = 1`);
 * - a quoted value with `\"` escapes, closed by a quote not followed by a word character, `"`, `\` or
 *   `=` (so `)`, `.`, `]`, `'`, `-`, `,`, `;`, whitespace or the end may follow it, while the `="` of
 *   Base64 padding before the quote that closes an enclosing string is not taken for a value);
 * - a quoted value closed by a quote right before a word character (`response="x"y`), if it has no
 *   whitespace or JSON separator (`,:;{}[]`): the text between Base64 padding and the next string's
 *   opening quote in JSON always has one;
 * - an unterminated quoted value (a cut-off message), up to the line end;
 * - a JSON-escaped quoted value (`=\"John Doe\"`);
 * - any other character except whitespace, `"`, `\` and `,`. An unescaped quote ends the item.
 */
const AUTH_ITEM = String.raw`(?:\\.|[^\S\n]+(?==)|=[^\S\n]*"(?:[^"\\\n]|\\.)*"(?=[^\w"\\=]|$)|=[^\S\n]*"[^\s"\\,:;{}[\]]+"(?=\w)|=[^\S\n]*"(?:[^\s"\\]|\\.)(?:[^"\\\n]|\\.)*(?=\n|$)|=[^\S\n]*\\"(?:[^"\\\n]|\\\\\\.|\\[^"\\\n])*\\"|(?<=[^\S\n])=[^\S\n]+|[^\s"\\,])+`;
/** Before a further item: `,` or whitespace, then the next `key=` param. */
const AUTH_NEXT_ITEM = String.raw`(?:${HWS}*,${HWS}*|${HWS}+)(?=[\w-]+[^\S\n]*=)`;
/**
 * The whole credential of an Authorization header: its items up to the first thing that is not one,
 * so trailing prose such as ` -> 401 Unauthorized`, ` (retrying)` or `, retrying` stays readable. A
 * folded header (a line break before an indented continuation) counts as whitespace. Nothing follows
 * this pattern in its rule, so a match never fails after the first item and nothing backtracks into it.
 */
const AUTH_HEADER_VALUE = String.raw`${AUTH_ITEM}(?:${AUTH_NEXT_ITEM}${AUTH_ITEM})*`;
/** Longer inputs are cut before masking: the patterns cost O(n^2) on long runs, and only 300 chars are kept. */
const MAX_REDACT_INPUT = 4000;

/**
 * Shortens an error and masks anything that looks like a credential: bot tokens, GitHub tokens, URL
 * userinfo passwords, the value after `Bearer`, the whole credential (every param) of an
 * `Authorization:` or `Proxy-Authorization:` header (also URL-encoded) after its
 * token/Basic/Digest/Negotiate/NTLM/AWS4-HMAC-SHA256 scheme, the values (whole, when quoted) of
 * password/passwd/api_key/apikey/secret/token/authorization/signature/credential and
 * secret_key/access_key/private_key keys, and generated-looking values after `token`/`apikey`. Prose such as "Bearer token is missing" is left readable
 * (a bearer token has 8+ characters).
 */
export function redactError(message: string): string {
  const masked = message.slice(0, MAX_REDACT_INPUT)
    .replace(/(?:bot)?\d{6,}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/gi, '[redacted]')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    // https://user:pass@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\bbearer\s+(?!\[redacted\])[^\s"',;]{8,}/gi, 'Bearer [redacted]')
    // Authorization / Proxy-Authorization header with a scheme: mask the whole rest of the value.
    .replace(new RegExp(String.raw`\b((?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?${AUTH_HEADER_SCHEME}\s+)(?!\[redacted\])${AUTH_HEADER_VALUE}`, 'gi'), '$1[redacted]')
    // URL-encoded header (`Authorization%3A%20Basic%20...` in a query string or a logged request).
    .replace(new RegExp(String.raw`\b((?:proxy-)?authorization(?:%22)?%3A(?:%20|\+)*(?:%22)?${AUTH_HEADER_SCHEME}(?:%20|\+)+)(?!\[redacted\])[^\s&"']+`, 'gi'), '$1[redacted]')
    // Quoted value: mask up to the closing quote.
    .replace(new RegExp(`${SECRET_KEY}(\\s*["']?\\s*[:=]\\s*)(["'])(?!\\[redacted\\]|${AUTH_SCHEME})(?:(?!\\3)[^\\n])+`, 'gi'), '$1$2$3[redacted]')
    .replace(new RegExp(`${SECRET_KEY}(\\s*["']?\\s*[:=]\\s*["']?)(?!\\[redacted\\]|${AUTH_SCHEME})[^\\s"'&,;]+`, 'gi'), '$1$2[redacted]')
    // "token <value>" / "apikey <value>" without a separator: only generated-looking values (12+ chars with a digit).
    .replace(/\b(token|authorization|api[_-]?key)(\s+)(?!\[redacted\])(?=[^\s"']*\d)[^\s"']{12,}/gi, '$1$2[redacted]')
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
