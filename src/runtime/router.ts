// The router's deterministic part (docs/design/coordinator-sessions.md, Routing model; task-57 phase 8): which session
// an owner message goes to (`coordinator route`), handing it over (`coordinator send`), waiting for due outbound items
// (`coordinator wait`) and the sent-message map (`tg_messages`, filled by `notify ack --message-id`). No model call and
// no Telegram I/O: the router claude reads and writes the channel, these helpers only read and write the runtime DB.
//
// Architecture decisions (task-57.12):
// - Rules, first match wins: (1) a reply to a bot message whose `tg_messages` row names a session (only once a channel
//   passes reply metadata, task-67; with plugin 0.0.7 the router passes none); (2) an explicit session: `/s <key>`, a
//   ref `#<message id>` found in `tg_messages`, or exactly one known task id in the text (`task-57.12`; several are
//   `ambiguous`); (3) `Q<n> <answer>` matching exactly one open question of the latest delivered digest, or a bare
//   number while exactly one question is open (several: `ambiguous`); (4) otherwise `general`.
// - An open question is a delivered outbox `question` item without `answered_at`, delivered in the last 7 days. Its
//   session is the outbox item's `session` (set by `notify enqueue`, by default from MINIONS_SESSION); none (the
//   single coordinator or the router asked) is `general`. `coordinator send --answers <key>` marks it answered.
// - `send` reopens a closed or failed session for an owner message (the owner reopens a failed one; decision 4) and
//   leaves opening `general` to the supervisor (it opens it on its first message). It refuses while sessions are off.
// - `wait` returns as soon as an outbox item is due (task-session summaries, questions, blockers) or the digest is due,
//   else after its timeout; the router runs it in the background and is woken by its completion (no restart).
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import type { RuntimeDb } from './db.js';
import { DIGEST_QUESTIONS_META } from './digest.js';
import { pending, type OutboxItem } from './outbox.js';
import { enqueueInbox, getSession, openSession } from './session-store.js';
import { parseSessionKey, sessionConfigDir, sessionsSettings } from './sessions.js';

export type RouteRule = 'reply' | 'session' | 'ref' | 'task' | 'question' | 'general' | 'ambiguous';
export interface RouteInput {
  text: string;
  /** The replied-to bot message (channel meta `reply_to_message_id`), when the channel passes it. */
  replyToMessageId?: number | null;
}
export interface RouteCandidate { key: string; why: string; question?: string }
export interface RouteResult {
  /** The session key, or null when `ambiguous`. */
  target: string | null;
  rule: RouteRule;
  why: string;
  /** The text to hand over (`/s <key>` stripped). */
  text: string;
  /** The open question this message answers (pass it to `send --answers`). */
  question: string | null;
  /** For `ambiguous`: the choices for the router's poll, the recommended first. */
  candidates: RouteCandidate[];
}
export interface OpenQuestion { key: string; session: string; taskId: string | null; n: number | null; deliveredAt: string }

/** How long a delivered question stays answerable by a bare number or `Q<n>`. */
export const QUESTION_OPEN_DAYS = 7;
/** Inbox source of routed owner messages (the supervisor delivers them also while starts are paused). */
export const ROUTER_INBOX_SOURCE = 'owner';
export const MAX_ROUTED_TEXT = 16_000;

const TASK_MENTION = /\b(task-\d+(?:\.\d+)*)\b/gi;
const EXPLICIT = /^\s*\/s\s+(\S+)\s*([\s\S]*)$/i;
const REF = /(?:^|\s)#(\d{1,12})\b/;
const Q_ANSWER = /^\s*Q(\d{1,3})\s+\S/i;
const BARE_NUMBER = /^\s*(\d{1,3})\s*[.)]?\s*$/;

/** `general`, `task:<id>` or a bare task id (`task-57`) as a session key; null when it is none. */
export function sessionKeyOf(raw: string): string | null {
  const v = raw.trim();
  try { return parseSessionKey(v).key; } catch { /* maybe a bare task id */ }
  try { return /^task-/i.test(v) ? parseSessionKey(`task:${v}`).key : null; } catch { return null; }
}

const sessionOrGeneral = (s: string | null | undefined): string => (s && sessionKeyOf(s)) || 'general';

/** Sessions recorded for a sent message id (`tg_messages`), distinct; [] when the message is unknown. */
export function sessionsOfMessage(db: RuntimeDb, o: { messageId?: number; ref?: string }): string[] {
  const rows = o.messageId !== undefined
    ? db.all<{ session: string | null }>('SELECT session FROM tg_messages WHERE message_id = ? ORDER BY id', o.messageId)
    : db.all<{ session: string | null }>('SELECT session FROM tg_messages WHERE ref = ? OR message_id = ? ORDER BY id', o.ref ?? '', Number(o.ref ?? -1));
  return [...new Set(rows.map((r) => sessionOrGeneral(r.session)))];
}

/** Delivered, unanswered questions of the last QUESTION_OPEN_DAYS, oldest first, numbered from the latest delivered digest. */
export function openQuestions(db: RuntimeDb, now: Date = new Date()): OpenQuestion[] {
  const since = new Date(now.getTime() - QUESTION_OPEN_DAYS * 24 * 3600_000).toISOString();
  const rows = db.all<{ dedup_key: string; session: string | null; task_id: string | null; delivered_at: string }>(
    "SELECT dedup_key, session, task_id, delivered_at FROM outbox WHERE kind = 'question' AND delivered_at IS NOT NULL AND answered_at IS NULL AND delivered_at >= ? ORDER BY delivered_at, rowid", since);
  const digest = db.get<{ dedup_key: string }>("SELECT dedup_key FROM outbox WHERE kind = 'digest' AND delivered_at IS NOT NULL ORDER BY delivered_at DESC, rowid DESC LIMIT 1");
  const numbers = new Map<string, number>();
  if (digest) {
    try {
      const list = JSON.parse(db.getMeta(`${DIGEST_QUESTIONS_META}${digest.dedup_key}`) ?? '[]') as { n?: unknown; key?: unknown }[];
      for (const q of Array.isArray(list) ? list : []) if (typeof q.key === 'string' && typeof q.n === 'number') numbers.set(q.key, q.n);
    } catch { /* no numbers */ }
  }
  return rows.map((r) => ({ key: r.dedup_key, session: sessionOrGeneral(r.session), taskId: r.task_id, n: numbers.get(r.dedup_key) ?? null, deliveredAt: r.delivered_at }));
}

const result = (target: string, rule: RouteRule, why: string, text: string, question: string | null = null): RouteResult =>
  ({ target, rule, why, text, question, candidates: [] });
const ambiguous = (why: string, text: string, candidates: RouteCandidate[]): RouteResult =>
  ({ target: null, rule: 'ambiguous', why, text, question: null, candidates: [...candidates, ...(candidates.some((c) => c.key === 'general') ? [] : [{ key: 'general', why: 'a new topic for the general session' }])] });

/**
 * Resolves the session of one inbound owner message (the routing model's rules 1 to 4). `knownTasks`: the backlog's
 * task ids (a mention of an unknown id is not a session); null when the backlog could not be read (any id counts).
 */
export function resolveRoute(db: RuntimeDb, input: RouteInput, o: { knownTasks?: readonly string[] | null; now?: Date } = {}): RouteResult {
  const text = input.text;
  // Rule 1: a reply to a message the bot sent for a session.
  if (input.replyToMessageId !== undefined && input.replyToMessageId !== null) {
    const s = sessionsOfMessage(db, { messageId: input.replyToMessageId });
    if (s.length === 1) return result(s[0]!, 'reply', `a reply to message ${input.replyToMessageId} of ${s[0]}`, text);
    if (s.length > 1) return ambiguous(`message ${input.replyToMessageId} carried items of several sessions`, text, s.map((k) => ({ key: k, why: `message ${input.replyToMessageId}` })));
  }
  // Rule 2: a session named explicitly.
  const explicit = EXPLICIT.exec(text);
  if (explicit) {
    const key = sessionKeyOf(explicit[1]!);
    const rest = explicit[2]!.trim() || text.trim();
    if (key) return result(key, 'session', `named with /s ${key}`, rest);
    return ambiguous(`/s ${explicit[1]!.slice(0, 60)} is not a session (use general or a task id)`, rest, []);
  }
  const ref = REF.exec(text);
  if (ref) {
    const s = sessionsOfMessage(db, { ref: ref[1]! });
    if (s.length === 1) return result(s[0]!, 'ref', `ref #${ref[1]} is a message of ${s[0]}`, text);
    if (s.length > 1) return ambiguous(`ref #${ref[1]} carried items of several sessions`, text, s.map((k) => ({ key: k, why: `ref #${ref[1]}` })));
  }
  const known = o.knownTasks ? new Set(o.knownTasks.map((t) => t.toLowerCase())) : null;
  const mentioned = [...new Set([...text.matchAll(TASK_MENTION)].map((m) => m[1]!.toLowerCase()))]
    .filter((id) => !known || known.has(id))
    .flatMap((id) => { const k = sessionKeyOf(id); return k ? [{ id, key: k }] : []; });
  if (mentioned.length === 1) return result(mentioned[0]!.key, 'task', `names ${mentioned[0]!.id}`, text);
  if (mentioned.length > 1) return ambiguous(`names several tasks (${mentioned.map((m) => m.id).join(', ')})`, text, mentioned.map((m) => ({ key: m.key, why: `names ${m.id}` })));
  // Rule 3: the answer to an open question.
  const qa = Q_ANSWER.exec(text);
  const bare = BARE_NUMBER.exec(text);
  if (qa || bare) {
    const open = openQuestions(db, o.now);
    if (qa) {
      const n = Number(qa[1]);
      const match = open.filter((q) => q.n === n);
      if (match.length === 1) return result(match[0]!.session, 'question', `answers Q${n} (${match[0]!.key})`, text, match[0]!.key);
    } else if (open.length === 1) {
      return result(open[0]!.session, 'question', `a bare number while one question is open (${open[0]!.key})`, text, open[0]!.key);
    } else if (open.length > 1) {
      return ambiguous(`a bare number while ${open.length} questions are open`, text, open.map((q) => ({ key: q.session, why: `question ${q.n ? `Q${q.n} ` : ''}${q.key}`, question: q.key })));
    }
  }
  // Rule 4: a new topic.
  return result('general', 'general', 'no reply, session, ref, task or open question matched: a new topic', text);
}

// ---------------------------------------------------------------- send

export interface SendResult { key: string; inboxId: number; reopened: boolean; answered: string | null }

/**
 * Hands one owner message to a session's inbox (`coordinator send <key>`). A closed or failed session is reopened (the
 * owner wrote to it); `general` is opened by the supervisor on its first message. `answers` marks that question answered.
 */
export function sendToSession(db: RuntimeDb, cfg: Pick<MinionsConfig, 'coordinator' | 'execution' | 'models'>, o: { key: string; text: string; state: string; meta?: unknown; answers?: string | null; now?: Date }): SendResult {
  if (!sessionsSettings(cfg).enabled) {
    throw new MinionsError('PRECONDITION', 'Coordinator sessions are off (coordinator.sessions.enabled), so there is no session to send to.', 'Handle the message yourself.');
  }
  const key = sessionKeyOf(o.key);
  if (!key) throw new MinionsError('PRECONDITION', `Not a session key: ${JSON.stringify(o.key.slice(0, 120))}.`, 'Use `general` or `task:<task id>`.');
  const text = o.text.trim();
  if (!text) throw new MinionsError('PRECONDITION', 'The message is empty.', 'Pipe the owner message in on stdin.');
  if (text.length > MAX_ROUTED_TEXT) throw new MinionsError('PRECONDITION', `The message is ${text.length} characters (max ${MAX_ROUTED_TEXT}).`);
  const now = o.now ?? new Date();
  return db.transaction(() => {
    const row = getSession(db, key);
    const reopened = !!row && row.status !== 'open';
    if (reopened) openSession(db, key, { configDir: sessionConfigDir({ state: o.state }, key), model: cfg.models.coordinator ?? null, now });
    else if (!row && parseSessionKey(key).kind === 'task') openSession(db, key, { configDir: sessionConfigDir({ state: o.state }, key), model: cfg.models.coordinator ?? null, now });
    const inboxId = enqueueInbox(db, key, ROUTER_INBOX_SOURCE, text, { meta: o.meta, now });
    let answered: string | null = null;
    if (o.answers && db.exec("UPDATE outbox SET answered_at = ? WHERE dedup_key = ? AND kind = 'question' AND answered_at IS NULL", now.toISOString(), o.answers).changes > 0) answered = o.answers;
    db.addEvent('route-send', parseSessionKey(key).taskId, { key, inboxId, reopened, ...(answered ? { answered } : {}) }, now.toISOString());
    return { key, inboxId, reopened, answered };
  });
}

// ---------------------------------------------------------------- wait

export type WaitReason = 'due' | 'digest' | 'timeout' | 'stopped';
export interface WaitResult { reason: WaitReason; items: Pick<OutboxItem, 'key' | 'kind' | 'taskId' | 'session'>[]; digest: string | null; waitedMs: number }

export interface WaitDeps {
  db: RuntimeDb;
  /** Whether the digest is due now (digestStatus(...).due), else null. */
  digestDue?: (now: Date) => string | null;
  /** The digest hold-back (reholdExpired) before each look, so a held item is not reported as due. */
  holdBack?: (now: Date) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  timeoutMs: number;
}

/** `coordinator wait`: returns once an outbox item or the digest is due, or at the timeout (the router then waits again). */
export async function waitForOutbound(d: WaitDeps): Promise<WaitResult> {
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const start = now().getTime();
  for (;;) {
    const at = now();
    try { d.holdBack?.(at); } catch { /* the wait never fails on the hold-back */ }
    const items = pending(d.db, {}, () => at);
    const digest = d.digestDue?.(at) ?? null;
    const waitedMs = at.getTime() - start;
    if (items.length || digest) {
      return { reason: items.length ? 'due' : 'digest', items: items.map((i) => ({ key: i.key, kind: i.kind, taskId: i.taskId, session: i.session })), digest, waitedMs };
    }
    if (d.signal?.aborted) return { reason: 'stopped', items: [], digest: null, waitedMs };
    if (waitedMs >= d.timeoutMs) return { reason: 'timeout', items: [], digest: null, waitedMs };
    await sleep(Math.min(d.pollMs ?? 5_000, Math.max(1, d.timeoutMs - waitedMs)));
  }
}

// ---------------------------------------------------------------- sent-message map

/**
 * Records that `keys` went out in Telegram message `messageId` (`notify ack --message-id`): one `tg_messages` row per
 * key with its session, so a reply or a `#ref` to that message routes back. Unknown keys are recorded without a session.
 */
export function recordSent(db: RuntimeDb, o: { messageId: number; keys: readonly string[]; ref?: string | null; now?: Date }): number {
  if (!Number.isSafeInteger(o.messageId) || o.messageId <= 0) throw new MinionsError('PRECONDITION', `Not a Telegram message id: ${o.messageId}.`, 'Pass the id the reply tool returned (`sent (id: N)`).');
  const at = (o.now ?? new Date()).toISOString();
  let n = 0;
  db.transaction(() => {
    for (const key of o.keys) {
      const item = db.get<{ session: string | null; text: string }>('SELECT session, text FROM outbox WHERE dedup_key = ?', key);
      db.exec('INSERT INTO tg_messages (message_id, ref, outbox_key, text_head, session, sent_at) VALUES (?, ?, ?, ?, ?, ?)',
        o.messageId, o.ref ?? null, key, item ? item.text.slice(0, 120) : null, item?.session ?? null, at);
      n++;
    }
  });
  return n;
}

// ---------------------------------------------------------------- restart blockers

/** A lease held by a headless session (`task:<id>`, `general`): its worker runs under the supervisor, not the router. */
export const heldBySession = (holder: string | null | undefined): boolean => !!holder && (holder === 'general' || holder.startsWith('task:'));
