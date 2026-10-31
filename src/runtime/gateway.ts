// The Telegram gateway (docs/design/autonomy.md Decision 7): with coordinator sessions on and the minions channel server,
// no router model holds the chat. A deterministic process, the wrapper's child in place of the router claude, polls the
// bot, routes each owner message by the routing rules (src/runtime/router.ts), and sends due outbox items itself.
//
// - Inbound: a reply goes to the session of the message it replies to, a poll vote to the asking session, a named task
//   to its task session. A new top-level message opens a fresh thread session, which reads the sessions index first and
//   hands the message over (`coordinator handover`) when it continues an open session. An ambiguous message opens a
//   thread session too, told the candidates.
// - Outbound: each due item goes out as a reply in its session's thread (a question with options as a poll), then is
//   acked and recorded in tg_messages, so the owner's reply routes back. A failed send stops the round (retry backoff).
// - The sessions index (<state>/sessions/index.md): every open session and those closed in the last day, with its topic
//   (`coordinator topic`), last activity and first owner message. Rewritten when it changes; `/sessions` in the chat
//   shows it.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { BotApi } from '../telegram/bot-api.js';
import type { ChannelNotification } from '../telegram/channel/core.js';
import { CHANNEL_BOT_ERRORS, ChannelServer, fileLog, LAUNCH_ENV, readChannelToken, type ChannelProc, type ChannelServerOptions } from '../telegram/channel/server.js';
import type { RuntimeDb, SessionRow } from './db.js';
import { digestStatus, reholdExpired } from './digest.js';
import { ack, fail, pending } from './outbox.js';
import { recordSent, resolveRoute, sendToSession, threadReplyTarget, type RouteRule } from './router.js';
import { routineSettings } from './routine.js';
import { enqueueInbox, getSession, openSession, OWNER_INBOX_SOURCE } from './session-store.js';
import { parseSessionKey, sessionConfigDir, threadSettings } from './sessions.js';
import { closeSession } from './task-sessions.js';

export interface GatewaySender {
  send(o: { text: string; replyTo?: number | null }): Promise<number>;
  sendPoll(o: { question: string; options: string[]; replyTo?: number | null }): Promise<{ messageId: number; pollId: string }>;
}

export interface GatewayDeps {
  db: RuntimeDb;
  state: string;
  config: () => Promise<MinionsConfig>;
  /** The backlog's task ids (a mention of an unknown id is no session); null when unreadable. */
  knownTasks: () => Promise<string[] | null>;
  sender: GatewaySender;
  /** Composes the due digest (`notify digest`): its text and the keys to ack. */
  digest?: () => Promise<{ text: string; keys: string[] } | null>;
  log: (line: string) => void;
  now?: () => Date;
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && Number.isSafeInteger(n) && n > 0 ? n : null;
};

export type InboundResult = { key: string; rule: RouteRule | 'ambiguous-thread' } | { command: 'sessions' };

/** Routes one owner message (a channel notification) to its session's inbox. */
export async function routeInbound(d: GatewayDeps, n: ChannelNotification): Promise<InboundResult> {
  const now = d.now?.() ?? new Date();
  const text = n.content;
  if (/^\/sessions(?:@\w+)?\s*$/i.test(text.trim())) {
    await d.sender.send({ text: formatSessionsIndex(sessionsIndex(d.db, now)), replyTo: num(n.meta.message_id) });
    return { command: 'sessions' };
  }
  const cfg = await d.config();
  // A poll vote: its message id is the poll's, which belongs to the asking session; it starts no thread.
  const vote = !!n.meta.poll_id;
  const messageId = vote ? null : num(n.meta.message_id);
  const replyTo = num(n.meta.reply_to_message_id);
  const route = resolveRoute(d.db, { text, messageId, replyToMessageId: replyTo, threads: threadSettings(cfg).enabled }, { knownTasks: await d.knownTasks().catch(() => null), now });
  let key = route.target;
  let body = route.text;
  let rule: RouteRule | 'ambiguous-thread' = route.rule;
  if (!key) {
    key = messageId ? `thread:${messageId}` : 'general';
    rule = 'ambiguous-thread';
    const list = route.candidates.filter((c) => c.key !== 'general').map((c) => `${c.key} (${c.why})`).join('; ');
    body = `(minions: ${route.why}.${list ? ` It may continue: ${list}. If so, hand it over: \`minions coordinator handover <key> --json\`.` : ''})\n${body}`;
  }
  const answers = route.question ?? (vote && replyTo ? questionOf(d.db, replyTo) : null);
  const reply = n.meta.reply_to_text ? { text: n.meta.reply_to_text, quote: n.meta.quote === 'partial' ? 'partial' as const : 'full' as const } : null;
  sendToSession(d.db, cfg, { key, text: body, state: d.state, messageId, reply, answers, meta: { via: 'gateway' }, now });
  return { key, rule };
}

/** The open question a sent message (a poll) carried, if any. */
function questionOf(db: RuntimeDb, messageId: number): string | null {
  return db.get<{ outbox_key: string }>("SELECT t.outbox_key FROM tg_messages t JOIN outbox o ON o.dedup_key = t.outbox_key WHERE t.message_id = ? AND o.kind = 'question' AND o.answered_at IS NULL", messageId)?.outbox_key ?? null;
}

/** Sends every due outbox item (and a due digest); a failed send stops the round. */
export async function deliverDue(d: GatewayDeps): Promise<{ sent: string[]; failed: string | null }> {
  const now = d.now?.() ?? new Date();
  const cfg = await d.config();
  const clock = () => now;
  try { reholdExpired(d.db, cfg, now); } catch { /* sending never fails on the hold-back */ }
  const sent: string[] = [];
  for (const item of pending(d.db, {}, clock)) {
    const replyTo = threadReplyTarget(d.db, item.session);
    try {
      const id = item.options?.length
        ? (await d.sender.sendPoll({ question: item.text, options: item.options, replyTo })).messageId
        : await d.sender.send({ text: item.text, replyTo });
      ack(d.db, item.key, 'telegram', clock);
      recordSent(d.db, { messageId: id, keys: [item.key], now });
      sent.push(item.key);
    } catch (e) {
      const msg = (e as Error).message;
      fail(d.db, item.key, msg, clock);
      d.log(`minions gateway: sending ${item.key} failed: ${msg}`);
      return { sent, failed: item.key };
    }
  }
  if (d.digest && routineSettings(cfg).enabled && digestStatus(d.db, cfg, now).due) {
    const dg = await d.digest().catch((e: unknown) => { d.log(`minions gateway: composing the digest failed: ${(e as Error).message}`); return null; });
    if (dg?.text.trim()) {
      try {
        const id = await d.sender.send({ text: dg.text, replyTo: null });
        for (const k of dg.keys) ack(d.db, k, 'telegram', clock);
        recordSent(d.db, { messageId: id, keys: dg.keys, now });
        sent.push(...dg.keys);
      } catch (e) {
        d.log(`minions gateway: sending the digest failed: ${(e as Error).message}`);
        return { sent, failed: dg.keys[0] ?? 'digest' };
      }
    }
  }
  return { sent, failed: null };
}

// ---------------------------------------------------------------- sessions index

export interface SessionIndexEntry {
  key: string; kind: SessionRow['kind']; status: SessionRow['status']; taskId: string | null;
  topic: string | null; openedAt: string; lastActivity: string; firstMessage: string | null;
}

const TOPIC_META = 'session_topic:';
export const MAX_TOPIC = 200;
/** How long a closed session stays in the index (a reply reopens it). */
export const INDEX_CLOSED_HOURS = 24;

export function sessionsIndex(db: RuntimeDb, now: Date = new Date()): SessionIndexEntry[] {
  const since = new Date(now.getTime() - INDEX_CLOSED_HOURS * 3600_000).toISOString();
  const rows = db.all<SessionRow>("SELECT * FROM sessions WHERE status = 'open' OR closed_at >= ? ORDER BY status = 'open' DESC, opened_at DESC", since);
  return rows.map((r) => {
    const last = db.get<{ at: string | null }>('SELECT MAX(at) AS at FROM (SELECT MAX(created_at) AS at FROM session_inbox WHERE session_key = ? UNION ALL SELECT MAX(created_at) FROM outbox WHERE session = ?)', r.key, r.key)?.at;
    const first = db.get<{ text: string }>('SELECT text FROM session_inbox WHERE session_key = ? AND source = ? ORDER BY id LIMIT 1', r.key, OWNER_INBOX_SOURCE)?.text ?? null;
    return {
      key: r.key, kind: r.kind, status: r.status, taskId: parseSessionKey(r.key).taskId,
      topic: db.getMeta(`${TOPIC_META}${r.key}`) ?? null, openedAt: r.opened_at, lastActivity: [last, r.last_wake_at, r.opened_at].filter(Boolean).sort().at(-1)!,
      firstMessage: first ? first.replace(/\s+/g, ' ').trim().slice(0, 160) : null,
    };
  });
}

export function formatSessionsIndex(entries: readonly SessionIndexEntry[]): string {
  if (!entries.length) return 'No coordinator sessions.';
  return ['# Coordinator sessions', '', ...entries.map((e) => `- ${e.key} [${e.status}] ${e.topic ?? (e.firstMessage ? `"${e.firstMessage}"` : '(no topic yet)')} · last ${e.lastActivity.slice(0, 16).replace('T', ' ')}`)].join('\n');
}

/** Rewrites <state>/sessions/index.md when it changed; returns its path. */
export async function writeSessionsIndex(db: RuntimeDb, state: string, now: Date = new Date()): Promise<string> {
  const dir = join(state, 'sessions');
  const file = join(dir, 'index.md');
  const text = formatSessionsIndex(sessionsIndex(db, now)) + '\n';
  const cur = await readFile(file, 'utf8').catch(() => null);
  if (cur !== text) { await mkdir(dir, { recursive: true }); await atomicWrite(file, text); }
  return file;
}

/** `coordinator topic`: the one line the index shows for a session. */
export function setSessionTopic(db: RuntimeDb, key: string, topic: string): string {
  const k = parseSessionKey(key).key;
  const t = topic.replace(/\s+/g, ' ').trim().slice(0, MAX_TOPIC);
  if (!t) throw new MinionsError('PRECONDITION', 'The topic is empty.');
  if (!getSession(db, k)) throw new MinionsError('NOT_FOUND', `No session ${k}.`);
  db.setMeta(`${TOPIC_META}${k}`, t);
  return t;
}

/**
 * `coordinator handover <to>`: a thread session found that its messages continue another session. Its owner messages go
 * to `to` (reopened when closed), the thread's Telegram messages and pending items move to `to`, and `from` closes.
 */
export function handoverSession(db: RuntimeDb, cfg: Pick<MinionsConfig, 'coordinator' | 'execution' | 'models'>, o: { from: string; to: string; state: string; now?: Date }): { from: string; to: string; messages: number } {
  const from = parseSessionKey(o.from);
  const to = parseSessionKey(o.to);
  if (from.kind !== 'thread') throw new MinionsError('PRECONDITION', `Only a thread session hands over (this is ${from.key}).`);
  if (from.key === to.key) throw new MinionsError('PRECONDITION', 'A session cannot hand over to itself.');
  if (!getSession(db, to.key)) throw new MinionsError('NOT_FOUND', `No session ${to.key}.`, 'Pick a key from `minions coordinator sessions --json`.');
  const now = o.now ?? new Date();
  return db.transaction(() => {
    const texts = db.all<{ text: string }>('SELECT text FROM session_inbox WHERE session_key = ? AND source = ? ORDER BY id', from.key, OWNER_INBOX_SOURCE).map((r) => r.text);
    if (getSession(db, to.key)!.status !== 'open') openSession(db, to.key, { configDir: sessionConfigDir({ state: o.state }, to.key), model: cfg.models.coordinator ?? null, now });
    if (texts.length) enqueueInbox(db, to.key, OWNER_INBOX_SOURCE, `(the owner wrote this as a new Telegram thread; ${from.key} found it continues this session)\n${texts.join('\n\n')}`, { meta: { handoverFrom: from.key }, now });
    db.exec('UPDATE tg_messages SET session = ? WHERE session = ?', to.key, from.key);
    db.exec('UPDATE outbox SET session = ? WHERE session = ? AND delivered_at IS NULL', to.key, from.key);
    closeSession(db, from.key, `handed over to ${to.key}`, now);
    db.addEvent('session-handover', to.taskId, { from: from.key, to: to.key, messages: texts.length }, now.toISOString());
    return { from: from.key, to: to.key, messages: texts.length };
  });
}

// ---------------------------------------------------------------- process

export interface RunGatewayOptions extends Omit<GatewayDeps, 'sender' | 'log'> {
  env: NodeJS.ProcessEnv;
  /** The channel's own state dir (access.json, offset, lock, message map). */
  telegramStateDir: string;
  logFile: string;
  proc: ChannelProc;
  readLaunch: ChannelServerOptions['readLaunch'];
  signal: AbortSignal;
  /** Seconds between outbound rounds (default 3). */
  tickSeconds?: number;
  /** Also printed to the wrapper's pane (the tmux window shows the gateway). */
  echo?: (line: string) => void;
}

/**
 * `minions telegram gateway`: the wrapper's child in place of the router claude. Token from the file, the launch checks
 * (it must be the wrapper's direct child), then the poll loop and the outbound rounds until the signal aborts.
 */
export async function runGateway(o: RunGatewayOptions): Promise<void> {
  const { token, botId } = await readChannelToken(o.env);
  const file = fileLog(o.logFile);
  const log = (l: string) => { file(l); o.echo?.(redact(l)); };
  const api = new BotApi({ token, errors: CHANNEL_BOT_ERRORS });
  const server = new ChannelServer({
    api, botId, stateDir: o.telegramStateDir, launchId: o.env[LAUNCH_ENV], readLaunch: o.readLaunch, proc: o.proc, log,
    owner: (self, launch) => { const p = o.proc.parentOf(self); return p === null ? 'unknown' : p === launch ? 'coordinator' : 'other'; },
  });
  const st = await server.activate();
  if (!st.active) throw new MinionsError('PRECONDITION', `The Telegram gateway is not active: ${st.reason}.`);
  const deps: GatewayDeps = { ...o, sender: server, log };
  let inbound = Promise.resolve();
  server.onNotification((n) => {
    inbound = inbound.then(() => routeInbound(deps, n)).then(
      (r) => log('command' in r ? `minions gateway: /${r.command}` : `minions gateway: message ${n.meta.message_id ?? '?'} -> ${r.key} (${r.rule})`),
      (e: unknown) => log(`minions gateway: routing message ${n.meta.message_id ?? '?'} failed: ${(e as Error).message}`));
  });
  log('minions gateway: polling Telegram; owner messages go to coordinator sessions');
  const polling = server.run(o.signal).catch((e: unknown) => log(`minions gateway: poll loop ended: ${(e as Error).message}`));
  try {
    while (!o.signal.aborted && server.status.active) {
      await inbound;
      const r = await deliverDue(deps).catch((e: unknown) => { log(`minions gateway: outbound round failed: ${(e as Error).message}`); return null; });
      if (r?.sent.length) log(`minions gateway: sent ${r.sent.join(', ')}`);
      await writeSessionsIndex(o.db, o.state).catch(() => undefined);
      await new Promise<void>((res) => { const t = setTimeout(res, (o.tickSeconds ?? 3) * 1000); o.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
    }
    if (!server.status.active) log(`minions gateway: stopped: ${server.status.reason}`);
  } finally {
    await polling;
    await inbound;
    await server.close();
  }
}
