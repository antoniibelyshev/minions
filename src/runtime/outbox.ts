// Notification outbox (spec §611, docs/design/telegram.md#notification-outbox): every notification the
// coordinator owes the owner (goal acknowledgements, deliveries with links, blockers, approvals,
// on-demand status) is recorded in the runtime DB under a dedup key *before* it is sent and acknowledged
// after. A channel outage therefore loses nothing: pending rows are retried on the next interaction or
// `minions sync`, and a key that was delivered once is never sent again. Nothing here wakes an LLM: the
// outbox is only read when the coordinator is awake anyway. Transport-agnostic: Telegram (the plugin's
// `reply` tool, called by the coordinator) is one transport; tests use a fake one.
import type { RuntimeDb } from './db.js';
import { MinionsError } from '../core/errors.js';

export const NOTIFICATION_KINDS = ['goal-ack', 'delivered', 'feature', 'blocker', 'approval', 'question', 'status', 'digest', 'other'] as const;
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
/** Schemes whose header credential is masked whole by {@link maskAuthHeaders}. */
const AUTH_HEADER_SCHEME = String.raw`(?:bearer|token|basic|digest|negotiate|ntlm|aws4-hmac-sha256)`;
/** An `Authorization:` / `Proxy-Authorization=` header up to its scheme; the credential follows. */
const AUTH_HEADER = new RegExp(String.raw`\b((?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?${AUTH_HEADER_SCHEME}\s+)(?!\[redacted\])`, 'gi');
/** One character of an unquoted value: anything but whitespace, quotes and the listed separators, or an escape pair other than `\"`. */
const valueChar = (exclude: string) => String.raw`(?:[^\s"'\\${exclude}]|\\[^\s"])`;
/** Longer inputs are cut before masking: some patterns cost O(n^2) on long runs, and only 300 chars are kept. */
const MAX_REDACT_INPUT = 4000;

const isHws = (c: string | undefined): c is string => c !== undefined && c !== '\n' && /\s/.test(c);
/** A line break that folds a header onto an indented next line. */
const isFold = (s: string, i: number) => s[i] === '\n' && (s[i + 1] === ' ' || s[i + 1] === '\t');
/** After a `"`: these characters (or the end) mean the quote closes a string, not opens a value. */
const CLOSES_STRING = /[\s,:;.)\]}']/;
/**
 * True when the `"` at `i` may close a string: the end follows it, or one of {@link CLOSES_STRING}. In
 * valid JSON the only unescaped `"` inside a string is its closing one, which is always followed by one
 * of these, so any other `"` is a raw quote (a stray one, or a quoted value) and must not stop masking.
 */
const closesString = (s: string, i: number) => i + 1 >= s.length || CLOSES_STRING.test(s[i + 1]!);
const NEXT_PARAM = /[\w-]+[^\S\n]*=/y;

/** True when `i` sits inside a double-quoted (JSON) string: an odd number of unescaped `"` precede it on its line. */
function insideString(s: string, i: number): boolean {
  let open = false;
  for (let k = s.lastIndexOf('\n', i - 1) + 1; k < i; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '"') open = !open;
  }
  return open;
}

/** Index after a `"`-quoted value starting at `i` (its `\` escapes included), or the line end if it is not closed. */
function skipQuoted(s: string, i: number): number {
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] !== undefined && s[k + 1] !== '\n') k++;
    else if (s[k] === '"') return k + 1;
    else if (s[k] === '\n') return k;
  }
  return s.length;
}

/** Index after a JSON-escaped quoted value (`\"John Doe\"`, a raw `\"` inside it being `\\\"`) starting at `i`. */
function skipEscapedQuoted(s: string, i: number): number {
  for (let k = i + 2; k < s.length; k++) {
    if (s.startsWith('\\\\\\', k)) k += 3;
    else if (s.startsWith('\\"', k)) return k + 2;
    else if (s[k] === '\\' && s[k + 1] !== undefined && s[k + 1] !== '\n') k++;
    else if (s[k] === '"' || s[k] === '\n') return k;
  }
  return s.length;
}

/**
 * The credential inside a double-quoted string: everything up to the string's end, i.e. the first
 * unescaped `"` that can close it (`\"` and `\\` are escape pairs; see {@link closesString}), or a line
 * end that does not fold the header. Any other `"` opens a quoted value (a header logged with raw
 * quotes, such as `Bearer "x"` or `response="x"`, after a stray quote earlier on the line), which is
 * skipped whole; Base64 padding before the closing quote (`==",`) is not taken for one.
 */
function credentialInString(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += s[i + 1] !== undefined && s[i + 1] !== '\n' ? 2 : 1; continue; }
    if (c === '\n' && !isFold(s, i)) break;
    if (c === '"') {
      if (!closesString(s, i)) { i = skipQuoted(s, i); continue; }
      break;
    }
    i++;
  }
  return i;
}

/**
 * One credential item in plain text: a token68 (`dXNlcjpw==`) or an auth param (`key=token`,
 * `key = "quoted"`, `SignedHeaders=host;range`), with `\` escape pairs. A quoted value after `=` is
 * skipped whole (also when JSON-escaped), and so is any other `"` not followed by a character that
 * closes a string (a quoted credential, `Bearer "x"`; see {@link closesString}). The item then goes on
 * up to whitespace, `,`, a line end or a closing `"`, so text glued to the value (`"x"y`) is masked too.
 */
function credentialItem(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += s[i + 1] !== undefined && s[i + 1] !== '\n' ? 2 : 1; continue; }
    if (c === '=') {
      let k = i + 1;
      while (isHws(s[k])) k++;
      if (s[k] === '"') i = skipQuoted(s, k);
      else if (s.startsWith('\\"', k)) i = skipEscapedQuoted(s, k);
      // Whitespace after `=` (`nc = 1`, `response= x`) belongs to the param, except after `==` Base64 padding.
      else i = s[i - 1] === '=' ? i + 1 : k;
      continue;
    }
    if (c === '"' && !closesString(s, i)) { i = skipQuoted(s, i); continue; }
    if (c === '"' || c === ',' || c === '\n') break;
    if (isHws(c)) {
      let k = i;
      while (isHws(s[k])) k++;
      if (s[k] === '=') { i = k; continue; }
      break;
    }
    i++;
  }
  return i;
}

/** Skips the separators between credential items: whitespace, commas and folded line breaks. */
function skipSeparators(s: string, i: number): number {
  while (i < s.length && (isHws(s[i]) || s[i] === ',' || isFold(s, i))) i++;
  return i;
}

/**
 * The credential in plain text: its items, separated by whitespace or commas, while the next one is a
 * `key=` param. Trailing prose such as ` -> 401 Unauthorized`, ` (retrying)` or `, retrying` stays readable.
 */
function credentialInText(s: string, start: number): number {
  let end = credentialItem(s, skipSeparators(s, start));
  for (;;) {
    const next = skipSeparators(s, end);
    NEXT_PARAM.lastIndex = next;
    if (next === end || !NEXT_PARAM.test(s)) return end;
    end = credentialItem(s, next);
  }
}

/**
 * Masks the whole credential of every `Authorization:` / `Proxy-Authorization:` header after its scheme.
 * One rule decides where it ends: inside a double-quoted (JSON) string, at the string's end (see
 * {@link credentialInString}), so the enclosing JSON stays valid; in plain text, after its last
 * credential item (see {@link credentialInText}). Over-masking a trailing character is accepted; a
 * credential character is never left unmasked before that boundary.
 */
function maskAuthHeaders(s: string): string {
  let out = '';
  let from = 0;
  AUTH_HEADER.lastIndex = 0;
  for (let m = AUTH_HEADER.exec(s); m; m = AUTH_HEADER.exec(s)) {
    const start = m.index + m[0].length;
    const end = insideString(s, start) ? credentialInString(s, start) : credentialInText(s, start);
    if (end > start) {
      out += `${s.slice(from, start)}[redacted]`;
      from = end;
    }
    AUTH_HEADER.lastIndex = Math.max(end, start);
  }
  return out + s.slice(from);
}

/** Index of the first unescaped `"` in `text[from, to)` that can close a string (see {@link closesString}), or -1. */
function closingQuote(text: string, from: number, to: number): number {
  for (let k = from; k < to; k++) {
    if (text[k] === '\\') k++;
    else if (text[k] === '"' && closesString(text, k)) return k;
  }
  return -1;
}

/**
 * Replacer for `key = "value"` / `key: 'value'`. Inside a JSON string, a `"` after the separator that
 * can close it (see {@link closesString}) does close it: the value is empty, nothing is masked. Any
 * other `"` opens a value, so a stray quote earlier on the line does not stop masking. A `'`-quoted
 * value inside a string ends where that string ends.
 */
function maskQuotedValue(match: string, key: string, sep: string, quote: string, offset: number, text: string): string {
  const at = offset + key.length + sep.length;
  const matchEnd = offset + match.length;
  const inString = insideString(text, at);
  if (quote === '"' && inString && closesString(text, at)) return match;
  const end = inString ? closingQuote(text, at + 1, matchEnd) : -1;
  if (end === at + 1) return match;
  return `${key}${sep}${quote}[redacted]${end < 0 ? '' : text.slice(end, matchEnd)}`;
}

/** Replacer for `key=value`: a `"` that ends the separator but closes a JSON string is not an opening quote. */
function maskUnquotedValue(match: string, key: string, sep: string, offset: number, text: string): string {
  const quoteAt = offset + key.length + sep.length - 1;
  if (sep.endsWith('"') && !sep.endsWith('\\"') && insideString(text, quoteAt) && closesString(text, quoteAt)) return match;
  return `${key}${sep}[redacted]`;
}

/**
 * Shortens an error and masks anything that looks like a credential: bot tokens, GitHub tokens, URL
 * userinfo passwords, the whole credential (every param) of an `Authorization:` or
 * `Proxy-Authorization:` header (also URL-encoded) after its
 * Bearer/token/Basic/Digest/Negotiate/NTLM/AWS4-HMAC-SHA256 scheme, the value after a bare `Bearer`, the
 * values (whole, when quoted) of password/passwd/api_key/apikey/secret/token/authorization/signature/
 * credential and secret_key/access_key/private_key keys, and generated-looking values after
 * `token`/`apikey`. Prose such as "Bearer token is missing" is left readable (a bearer token has 8+
 * characters). Masking never consumes the `\` of a `\"` escape, and stops at a `"` only where that
 * quote can close a string ({@link closesString}), so a JSON text stays valid JSON while a stray quote
 * earlier on a plain-text line never lets a later credential through.
 */
export function redactError(message: string): string {
  const masked = maskAuthHeaders(message.slice(0, MAX_REDACT_INPUT)
    .replace(/(?:bot)?\d{6,}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/gi, '[redacted]')
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    // https://user:pass@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"]*:)(?:[^\s/@"\\]|\\\S)+@/gi, '$1[redacted]@'))
    // A bare Bearer token, also quoted (`Bearer "x"`, `Bearer \"x\"`); a `"` that can close a string does not open one.
    .replace(new RegExp(String.raw`\bbearer\s+((?:\\?"(?![\s,:;.)\]}']|$)|')?)(?!\[redacted\])${valueChar(',;')}{8,}`, 'gi'), 'Bearer $1[redacted]')
    // URL-encoded header (`Authorization%3A%20Basic%20...` in a query string or a logged request).
    .replace(new RegExp(String.raw`\b((?:proxy-)?authorization(?:%22)?%3A(?:%20|\+)*(?:%22)?${AUTH_HEADER_SCHEME}(?:%20|\+)+)(?!\[redacted\])${valueChar('&')}+`, 'gi'), '$1[redacted]')
    // Quoted value: mask up to the closing quote (`\` escapes included).
    .replace(new RegExp(`${SECRET_KEY}(\\s*["']?\\s*[:=]\\s*)(["'])(?!\\[redacted\\]|${AUTH_SCHEME})(?:\\\\[^\\n]|(?!\\3)[^\\\\\\n])+`, 'gi'), maskQuotedValue)
    .replace(new RegExp(`${SECRET_KEY}(\\s*\\\\?["']?\\s*[:=]\\s*(?:\\\\?["'])?)(?!\\[redacted\\]|${AUTH_SCHEME})${valueChar('&,;')}+`, 'gi'), maskUnquotedValue)
    // "token <value>" / "apikey <value>" without a separator: only generated-looking values (12+ chars with a digit).
    .replace(new RegExp(String.raw`\b(token|authorization|api[_-]?key)(\s+)(?!\[redacted\])(?=[^\s"']*\d)${valueChar('')}{12,}`, 'gi'), '$1$2[redacted]')
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

export interface EnqueueInput {
  key: string; kind: string; taskId?: string | null; text: string;
  /**
   * Held for the digest (task-68.5, src/runtime/digest.ts): `next_attempt_at` is set to this instant, so
   * pending() does not return the item before it. A held row is one with no attempt yet and a next_attempt_at.
   */
  holdUntil?: string | null;
}
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
    db.exec('INSERT INTO outbox (dedup_key, kind, task_id, text, created_at, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      key, input.kind, input.taskId ?? null, text, clock().toISOString(), input.holdUntil ?? null);
    db.addEvent('notify-enqueue', input.taskId ?? null, { key, kind: input.kind, ...(input.holdUntil ? { holdUntil: input.holdUntil } : {}) });
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

/** Held for the digest: undelivered, never attempted, with a next attempt time (a failed send has attempts > 0). */
export const isHeld = (i: Pick<OutboxItem, 'attempts' | 'nextAttemptAt' | 'deliveredAt'>): boolean => !i.deliveredAt && i.attempts === 0 && i.nextAttemptAt !== null;

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
