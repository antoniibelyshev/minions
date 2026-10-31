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
// - `/budget` (Decision 13): shows and changes the owner's USD caps, handled here and never routed to a coordinator, so a
//   coordinator cannot raise its own caps. Changes go to the control overlay as the owner's (journaled, live).
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { BotApi } from '../telegram/bot-api.js';
import { parseAccess, type ChannelNotification } from '../telegram/channel/core.js';
import { CHANNEL_BOT_ERRORS, ChannelServer, fileLog, LAUNCH_ENV, readChannelToken, type ChannelProc, type ChannelServerOptions } from '../telegram/channel/server.js';
import type { RuntimeDb, SessionRow } from './db.js';
import { digestStatus, reholdExpired } from './digest.js';
import { billingOf, sessionSpend, usdCaps, type Billing } from './spend.js';
import { controlSet, withControl } from './control.js';
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
  /** The config below the control overlay (`/budget` writes the overlay); without it `/budget` changes are refused. */
  controlBase?: () => Promise<MinionsConfig>;
  /** Whether a Telegram user id is the paired owner (access.json allowFrom); without it `/budget` changes are refused. */
  isOwner?: (userId: string | undefined) => Promise<boolean>;
  billing?: Billing;
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v !== undefined && Number.isSafeInteger(n) && n > 0 ? n : null;
};

export type InboundResult = { key: string; rule: RouteRule | 'ambiguous-thread' } | { command: 'sessions' | 'budget' };

/** Routes one owner message (a channel notification) to its session's inbox. */
export async function routeInbound(d: GatewayDeps, n: ChannelNotification): Promise<InboundResult> {
  const now = d.now?.() ?? new Date();
  const text = n.content;
  if (/^\/sessions(?:@\w+)?\s*$/i.test(text.trim())) {
    await d.sender.send({ text: formatSessionsIndex(sessionsIndex(d.db, now)), replyTo: num(n.meta.message_id) });
    return { command: 'sessions' };
  }
  // A poll vote's text is an option the coordinator wrote: never a command.
  const budget = n.meta.poll_id ? null : parseBudgetCommand(text);
  if (budget) {
    await d.sender.send({ text: await budgetReply(d, budget, n.meta.user_id, now), replyTo: num(n.meta.message_id) });
    return { command: 'budget' };
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

// ---------------------------------------------------------------- /budget

export type BudgetCommand =
  | { kind: 'show' }
  | { kind: 'set'; key: 'dailyUsd' | 'taskUsd'; usd: number | null }
  | { kind: 'usage'; why: string };

export const BUDGET_USAGE = 'Usage: /budget (show), /budget day <usd|off>, /budget task <usd|off>.';

/** `/budget [day|task <usd|off>]`; null when the message is not a /budget command. */
export function parseBudgetCommand(text: string): BudgetCommand | null {
  const m = /^\/budget(?:@\w+)?(?:\s+(.*))?$/is.exec(text.trim());
  if (!m) return null;
  const args = (m[1] ?? '').trim().split(/\s+/).filter(Boolean);
  if (!args.length) return { kind: 'show' };
  const which = args[0]!.toLowerCase();
  const key = which === 'day' || which === 'daily' ? 'dailyUsd' : which === 'task' ? 'taskUsd' : null;
  if (!key) return { kind: 'usage', why: `unknown cap "${args[0]!.slice(0, 20)}"` };
  if (args.length !== 2) return { kind: 'usage', why: `give one amount for the ${which} cap` };
  const v = args[1]!.toLowerCase();
  if (v === 'off' || v === 'none') return { kind: 'set', key, usd: null };
  const usd = Number(v.replace(/^\$/, ''));
  if (!/^\$?\d+(\.\d+)?$/.test(v) || !(usd > 0)) return { kind: 'usage', why: `"${args[1]!.slice(0, 20)}" is not a positive USD amount` };
  return { kind: 'set', key, usd: Math.round(usd * 100) / 100 };
}

const capText = (usd: number | null) => (usd === null ? 'off' : `$${usd}`);

/** Runs a /budget command and returns the reply. Changes need the paired owner and the control base. */
export async function budgetReply(d: GatewayDeps, c: BudgetCommand, userId: string | undefined, now: Date): Promise<string> {
  if (c.kind === 'usage') return `${c.why}. ${BUDGET_USAGE}`;
  if (!d.controlBase) return 'Budget caps are unavailable here (no runtime config).';
  const base = await d.controlBase();
  if (c.kind === 'set') {
    if (!d.isOwner || !(await d.isOwner(userId))) return 'Only the paired owner changes the budget.';
    const key = `budgets.${c.key}`;
    const reason = `owner: /budget ${c.key === 'dailyUsd' ? 'day' : 'task'} ${capText(c.usd)} (Telegram)`;
    const r = await controlSet({ state: d.state, base, actor: 'owner (telegram)', owner: true, now: () => now }, key, c.usd, reason);
    d.db.addEvent('budget-cap', null, { key, usd: c.usd, revision: r.revision, via: 'telegram' }, now.toISOString());
    const head = `${c.key === 'dailyUsd' ? 'Daily' : 'Per-task'} cap ${r.keys.length ? 'set to' : 'already'} ${capText(c.usd)}${r.keys.length ? ` (control revision ${r.revision}; applies to the next claim)` : ''}.`;
    return `${head}\n${budgetSummary(d, withControl(base, d.state), now)}`;
  }
  return budgetSummary(d, withControl(base, d.state), now);
}

function budgetSummary(d: GatewayDeps, cfg: MinionsConfig, now: Date): string {
  const c = usdCaps({ db: d.db, config: cfg, billing: d.billing ?? billingOf(), now });
  const day = `Today (UTC): ~$${c.day.usedUsd.toFixed(2)} est. (${kTok(c.day.tokens)} tok) of daily cap ${capText(c.day.capUsd)}${c.day.exhausted ? ': reached, new starts refused' : ''}.`;
  const task = `Per-task cap: ${capText(c.task.capUsd)}${c.task.atCap.length ? ` (reached: ${c.task.atCap.join(', ')})` : ''}.`;
  const note = c.enforced ? null : 'Not enforced: this runtime uses a Claude subscription (no USD figure); the estimate is the API-rate equivalent.';
  return [day, task, ...(note ? [note] : [])].join('\n');
}

// ---------------------------------------------------------------- sessions index

export interface SessionIndexEntry {
  key: string; kind: SessionRow['kind']; status: SessionRow['status']; taskId: string | null;
  topic: string | null; openedAt: string; lastActivity: string; firstMessage: string | null;
  /** The session's own measured tokens, and its task's workers for a task session (USD only with API billing). */
  spend: { tokens: number; usd?: number; workerTokens: number; workerUsd?: number };
}

const TOPIC_META = 'session_topic:';
export const MAX_TOPIC = 200;
/** How long a closed session stays in the index (a reply reopens it). */
export const INDEX_CLOSED_HOURS = 24;

export function sessionsIndex(db: RuntimeDb, now: Date = new Date(), billing: Billing = billingOf()): SessionIndexEntry[] {
  const spent = sessionSpend(db, billing);
  const since = new Date(now.getTime() - INDEX_CLOSED_HOURS * 3600_000).toISOString();
  const rows = db.all<SessionRow>("SELECT * FROM sessions WHERE status = 'open' OR closed_at >= ? ORDER BY status = 'open' DESC, opened_at DESC", since);
  return rows.map((r) => {
    const last = db.get<{ at: string | null }>('SELECT MAX(at) AS at FROM (SELECT MAX(created_at) AS at FROM session_inbox WHERE session_key = ? UNION ALL SELECT MAX(created_at) FROM outbox WHERE session = ?)', r.key, r.key)?.at;
    const first = db.get<{ text: string }>('SELECT text FROM session_inbox WHERE session_key = ? AND source = ? ORDER BY id LIMIT 1', r.key, OWNER_INBOX_SOURCE)?.text ?? null;
    return {
      key: r.key, kind: r.kind, status: r.status, taskId: parseSessionKey(r.key).taskId,
      topic: db.getMeta(`${TOPIC_META}${r.key}`) ?? null, openedAt: r.opened_at, lastActivity: [last, r.last_wake_at, r.opened_at].filter(Boolean).sort().at(-1)!,
      firstMessage: first ? first.replace(/\s+/g, ' ').trim().slice(0, 160) : null,
      spend: spendOf(spent.get(r.key)),
    };
  });
}

const spendOf = (s: ReturnType<typeof sessionSpend> extends Map<string, infer V> ? V | undefined : never): SessionIndexEntry['spend'] => ({
  tokens: s?.own.tokens ?? 0, ...(s?.own.estimatedUsd !== undefined ? { usd: s.own.estimatedUsd } : {}),
  workerTokens: s?.workers.tokens ?? 0, ...(s?.workers.estimatedUsd !== undefined ? { workerUsd: s.workers.estimatedUsd } : {}),
});

const kTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const cost = (tokens: number, usd?: number) => `${kTok(tokens)} tok${usd !== undefined ? ` ~$${usd.toFixed(2)}` : ''}`;

export function formatSessionsIndex(entries: readonly SessionIndexEntry[]): string {
  if (!entries.length) return 'No coordinator sessions.';
  const line = (e: SessionIndexEntry) => `- ${e.key} [${e.status}] ${e.topic ?? (e.firstMessage ? `"${e.firstMessage}"` : '(no topic yet)')} · ${cost(e.spend.tokens, e.spend.usd)}`
    + `${e.spend.workerTokens ? ` + workers ${cost(e.spend.workerTokens, e.spend.workerUsd)}` : ''} · last ${e.lastActivity.slice(0, 16).replace('T', ' ')}`;
  const tokens = entries.reduce((a, e) => a + e.spend.tokens + e.spend.workerTokens, 0);
  const usd = entries.every((e) => e.spend.usd !== undefined) ? entries.reduce((a, e) => a + (e.spend.usd ?? 0) + (e.spend.workerUsd ?? 0), 0) : undefined;
  return ['# Coordinator sessions', '', ...entries.map(line), '', `Total: ${cost(tokens, usd)} (estimate; the Console usage page is authoritative)`].join('\n');
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
  const accessFile = join(o.telegramStateDir, 'access.json');
  const isOwner = o.isOwner ?? (async (userId: string | undefined) => {
    if (!userId) return false;
    const raw = await readFile(accessFile, 'utf8').then((t) => JSON.parse(t) as unknown, () => null);
    return parseAccess(raw).allowFrom.includes(userId);
  });
  const deps: GatewayDeps = { ...o, sender: server, log, isOwner };
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
