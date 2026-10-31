// The minions-owned Telegram channel, pure core (docs/design/telegram-channel.md, "Server shape" layer 2; task-67.2).
// No I/O: the access gate and pairing codes, inbound update -> channel notification mapping (reply metadata, poll
// answers), the outbound chat check, the ref footer, poll arguments, the message map, bot command answers and the 409 backoff rule. The server
// (./server.ts) reads and writes files and talks to the Bot API.
//
// - access.json keeps the official plugin's schema and semantics (dmPolicy pairing | allowlist | disabled, allowFrom,
//   groups, pending), so an existing pairing works unchanged. Groups are always ignored (minions supports one owner in
//   a DM). A bot sender and a forwarded message are dropped (only what the owner types counts).
// - Meta values are strings the sender cannot forge; content stays untrusted owner text. Quoted text is one line of at
//   most 300 characters.
import { displayText, truncateCodePoints } from '../../core/control-chars.js';
import { MinionsError } from '../../core/errors.js';
import { isForwarded, oneLine, type TelegramMessage, type TelegramPollAnswer, type TelegramUpdate } from '../bot-api.js';

// ---------------------------------------------------------------- access

export type DmPolicy = 'pairing' | 'allowlist' | 'disabled';
export interface PendingEntry { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
export interface ChannelAccess {
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groups: Record<string, unknown>;
  pending: Record<string, PendingEntry>;
  /** Every other key of the file, kept as it was on a write. */
  rest: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const PAIRING_TTL_MS = 60 * 60 * 1000;
export const MAX_PENDING = 3;

/** access.json as the plugin reads it (null: the file is absent, the plugin default `pairing`). */
export function parseAccess(raw: unknown | null): ChannelAccess {
  if (!isObj(raw)) return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {}, rest: {} };
  const { dmPolicy, allowFrom, groups, pending, ...rest } = raw;
  const policy: DmPolicy = dmPolicy === 'allowlist' || dmPolicy === 'disabled' ? dmPolicy : 'pairing';
  const pend: Record<string, PendingEntry> = {};
  if (isObj(pending)) {
    for (const [code, p] of Object.entries(pending)) {
      if (isObj(p) && typeof p.senderId === 'string' && typeof p.expiresAt === 'number') {
        pend[code] = { senderId: p.senderId, chatId: String(p.chatId ?? p.senderId), createdAt: Number(p.createdAt ?? 0), expiresAt: p.expiresAt, replies: Number(p.replies ?? 1) };
      }
    }
  }
  return {
    dmPolicy: policy,
    allowFrom: Array.isArray(allowFrom) ? allowFrom.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : [],
    groups: isObj(groups) ? groups : {}, pending: pend, rest,
  };
}

/** The file form of an access value (the schema of the official plugin). */
export const serializeAccess = (a: ChannelAccess) => ({ ...a.rest, dmPolicy: a.dmPolicy, allowFrom: a.allowFrom, groups: a.groups, pending: a.pending });

/** A disabled access (access.json unreadable or corrupt): nothing gets through, nothing is written. */
export const LOCKED_ACCESS: ChannelAccess = { dmPolicy: 'disabled', allowFrom: [], groups: {}, pending: {}, rest: {} };

export type GateResult =
  | { action: 'deliver' }
  | { action: 'drop'; why: string }
  /** Pairing: send `code` to the sender; `access` is the new value to write. */
  | { action: 'pair'; code: string; isResend: boolean; access: ChannelAccess };

/**
 * The inbound gate for one message (the plugin's rule, DM only): an allowlisted sender in a private chat is delivered;
 * under `pairing` an unknown DM sender gets a code (at most two replies per code, at most three pending codes, 1 h);
 * everything else is dropped. `newCode` makes the 6-character code (tests pass a fixed one).
 */
export function gate(access: ChannelAccess, m: TelegramMessage, now: number, newCode: () => string): GateResult {
  const from = m.from;
  if (!from || !m.chat) return { action: 'drop', why: 'no sender' };
  if (from.is_bot === true) return { action: 'drop', why: 'bot sender' };
  if (m.chat.type !== 'private') return { action: 'drop', why: `chat type ${m.chat.type ?? 'unknown'} (groups are never forwarded)` };
  if (isForwarded(m)) return { action: 'drop', why: 'forwarded message' };
  if (access.dmPolicy === 'disabled') return { action: 'drop', why: 'DM policy disabled' };
  const sender = String(from.id);
  if (access.allowFrom.includes(sender)) return { action: 'deliver' };
  if (access.dmPolicy === 'allowlist') return { action: 'drop', why: 'sender not allowlisted' };
  const pending: Record<string, PendingEntry> = {};
  for (const [c, p] of Object.entries(access.pending)) if (p.expiresAt >= now) pending[c] = { ...p };
  for (const [code, p] of Object.entries(pending)) {
    if (p.senderId !== sender) continue;
    if (p.replies >= 2) return { action: 'drop', why: 'pairing code already sent twice' };
    p.replies += 1;
    return { action: 'pair', code, isResend: true, access: { ...access, pending } };
  }
  if (Object.keys(pending).length >= MAX_PENDING) return { action: 'drop', why: 'too many pending pairing codes' };
  const code = newCode();
  pending[code] = { senderId: sender, chatId: String(m.chat.id), createdAt: now, expiresAt: now + PAIRING_TTL_MS, replies: 1 };
  return { action: 'pair', code, isResend: false, access: { ...access, pending } };
}

export const pairingText = (code: string, isResend: boolean) =>
  `${isResend ? 'Still pending' : 'Pairing required'}: ask the owner to approve code ${code} in the coordinator terminal (never over Telegram).`;

/**
 * The outbound check of every tool: the chat must be in allowFrom (Telegram DM chat_id == user_id). Without a chat_id
 * the single allowlisted owner DM is used; none or several is an error.
 */
export function assertAllowedChat(access: ChannelAccess, chatId?: string): string {
  if (access.dmPolicy === 'disabled') throw new MinionsError('PRECONDITION', 'The Telegram DM policy is disabled; nothing is sent.');
  if (chatId === undefined || chatId === '') {
    if (access.allowFrom.length !== 1) {
      throw new MinionsError('PRECONDITION', access.allowFrom.length ? 'Several chats are allowlisted: pass chat_id.' : 'No chat is paired yet; nothing is sent.');
    }
    return access.allowFrom[0]!;
  }
  if (!access.allowFrom.includes(chatId)) throw new MinionsError('PRECONDITION', `chat ${displayText(chatId).slice(0, 40)} is not allowlisted; nothing is sent.`);
  return chatId;
}

// ---------------------------------------------------------------- bot commands

export const BOT_COMMANDS = ['start', 'help', 'status'] as const;
export type BotCommand = typeof BOT_COMMANDS[number];

/** `/start`, `/help`, `/status` (optionally `@botname`), else null. */
export function botCommand(text: string | undefined): BotCommand | null {
  const m = /^\/(start|help|status)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec((text ?? '').trim());
  return m ? (m[1] as BotCommand) : null;
}

/**
 * The server's own answer to a bot command in a DM, or null (dropped: not a DM, a bot, policy disabled, or a stranger
 * under `allowlist`). /status never shows another sender's code or any id.
 */
export function commandReply(cmd: BotCommand, access: ChannelAccess, m: TelegramMessage, now: number): string | null {
  if (!m.from || m.from.is_bot === true || m.chat?.type !== 'private' || access.dmPolicy === 'disabled') return null;
  const sender = String(m.from.id);
  const owner = access.allowFrom.includes(sender);
  if (!owner && access.dmPolicy === 'allowlist') return null;
  if (cmd === 'start') return 'This bot connects Telegram to a minions coordinator. To pair: DM me anything to get a 6-character code, then the owner approves it in the coordinator terminal. After that, your DMs reach the coordinator.';
  if (cmd === 'help') return 'Messages you send here reach the minions coordinator once you are paired. Text and replies are forwarded; answers come back here.\n/start - pairing instructions\n/status - your pairing state';
  if (owner) return 'Paired: your messages reach the coordinator.';
  const mine = Object.entries(access.pending).find(([, p]) => p.senderId === sender && p.expiresAt >= now);
  return mine ? `Pairing pending: code ${mine[0]}, to be approved in the coordinator terminal.` : 'Not paired. Send me a message to get a pairing code.';
}

// ---------------------------------------------------------------- message map

/** A native poll the bot sent (docs/design/autonomy.md Decision 5); kept with its message so an answer can be named. */
export interface SentPoll { pollId: string; question: string; options: string[] }
export interface SentMessage { messageId: number; chatId: string; ref: string | null; textHead: string; sentAt: string; poll?: SentPoll }

const parsePoll = (p: unknown): SentPoll | undefined =>
  isObj(p) && typeof p.pollId === 'string' && typeof p.question === 'string' && Array.isArray(p.options) && p.options.every((o) => typeof o === 'string')
    ? { pollId: p.pollId, question: p.question, options: p.options as string[] } : undefined;

/**
 * The bot's own sent messages and polls (bounded, newest kept): reply_to_ref lookup, poll answers and, later,
 * edit_message ownership. Also the newest inbound owner message per chat (the default reply_to of `reply`).
 */
export class MessageMap {
  private readonly items = new Map<string, SentMessage>();
  private readonly inbound = new Map<string, number>();
  constructor(private readonly max = 500) {}
  private static key = (chatId: string, messageId: number) => `${chatId}:${messageId}`;
  record(m: SentMessage): void {
    const k = MessageMap.key(m.chatId, m.messageId);
    this.items.delete(k);
    this.items.set(k, m);
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }
  get(chatId: string, messageId: number): SentMessage | undefined { return this.items.get(MessageMap.key(chatId, messageId)); }
  /** The sent message of a poll id (a poll evicted from the map is unknown). */
  findPoll(pollId: string): SentMessage | undefined {
    for (const m of this.items.values()) if (m.poll?.pollId === pollId) return m;
    return undefined;
  }
  /** Records an inbound message id of a chat; an older id (e.g. an edit) does not move the newest back. */
  noteInbound(chatId: string, messageId: number): void {
    if ((this.inbound.get(chatId) ?? 0) >= messageId) return;
    this.inbound.delete(chatId);
    this.inbound.set(chatId, messageId);
    while (this.inbound.size > 50) this.inbound.delete(this.inbound.keys().next().value!);
  }
  lastInbound(chatId: string): number | undefined { return this.inbound.get(chatId); }
  toJSON(): { version: 1; messages: SentMessage[]; lastInbound: Record<string, number> } {
    return { version: 1, messages: [...this.items.values()], lastInbound: Object.fromEntries(this.inbound) };
  }
  static from(raw: unknown, max = 500): MessageMap {
    const map = new MessageMap(max);
    const list = isObj(raw) && raw.version === 1 && Array.isArray(raw.messages) ? raw.messages : [];
    for (const m of list) {
      if (isObj(m) && typeof m.messageId === 'number' && typeof m.chatId === 'string') {
        const poll = parsePoll(m.poll);
        map.record({ messageId: m.messageId, chatId: m.chatId, ref: typeof m.ref === 'string' ? m.ref : null, textHead: typeof m.textHead === 'string' ? m.textHead : '', sentAt: typeof m.sentAt === 'string' ? m.sentAt : '', ...(poll ? { poll } : {}) });
      }
    }
    if (isObj(raw) && raw.version === 1 && isObj(raw.lastInbound)) {
      for (const [chatId, id] of Object.entries(raw.lastInbound)) if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) map.noteInbound(chatId, id);
    }
    return map;
  }
}

// ---------------------------------------------------------------- outbound text

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** A ref argument (`#58`, `58`, `task-67`) without its `#`; an invalid one is an error. */
export function normalizeRef(ref: unknown): string | null {
  if (ref === undefined || ref === null || ref === '') return null;
  const r = String(ref).trim().replace(/^#/, '');
  if (!REF_PATTERN.test(r)) throw new MinionsError('INVALID_CONFIG', 'ref must be a short id such as 58 or task-67 (letters, digits, . _ : -).');
  return r;
}

export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;

/** The `poll` tool arguments as Telegram accepts them (question 1..300, 2..10 distinct options of 1..100 characters). */
export function pollArgs(args: Record<string, unknown>): { question: string; options: string[]; multiple: boolean } {
  const bad = (msg: string) => new MinionsError('INVALID_CONFIG', msg);
  const question = typeof args.question === 'string' ? args.question.trim() : '';
  if (!question || [...question].length > POLL_QUESTION_MAX) throw bad(`question is required (at most ${POLL_QUESTION_MAX} characters).`);
  const options = (Array.isArray(args.options) ? args.options : []).map((o) => (typeof o === 'string' ? o.trim() : ''));
  if (options.length < 2 || options.length > 10) throw bad('options must be 2 to 10 strings.');
  if (options.some((o) => !o || [...o].length > POLL_OPTION_MAX)) throw bad(`every option must be 1 to ${POLL_OPTION_MAX} characters.`);
  if (new Set(options).size !== options.length) throw bad('options must be distinct.');
  if (args.multiple !== undefined && typeof args.multiple !== 'boolean') throw bad('multiple must be true or false.');
  return { question, options, multiple: args.multiple === true };
}

/** The reply body with the `ref: #<ref>` footer the server appends (the model no longer types it). */
export const withRefFooter = (text: string, ref: string | null) => (ref ? `${text.replace(/\s+$/, '')}\n\nref: #${ref}` : text);

// ---------------------------------------------------------------- inbound

export interface ChannelNotification { content: string; meta: Record<string, string> }
export const QUOTE_MAX_CHARS = 300;

const safeName = (s: string | undefined) => (s ? displayText(s).replace(/[<>[\]\r\n;"]/g, '_').slice(0, 120) : undefined);

function attachment(m: TelegramMessage): { kind: string; fileId: string; name?: string; placeholder: string } | null {
  if (m.photo?.length) return { kind: 'photo', fileId: m.photo[m.photo.length - 1]!.file_id, placeholder: '(photo)' };
  if (m.document) return { kind: 'document', fileId: m.document.file_id, name: safeName(m.document.file_name), placeholder: `(document: ${safeName(m.document.file_name) ?? 'file'})` };
  if (m.voice) return { kind: 'voice', fileId: m.voice.file_id, placeholder: '(voice message)' };
  if (m.audio) return { kind: 'audio', fileId: m.audio.file_id, name: safeName(m.audio.file_name), placeholder: '(audio)' };
  if (m.video) return { kind: 'video', fileId: m.video.file_id, name: safeName(m.video.file_name), placeholder: '(video)' };
  if (m.sticker) return { kind: 'sticker', fileId: m.sticker.file_id, placeholder: `(sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''})` };
  return null;
}

/**
 * One gated owner message (or edit) as a `notifications/claude/channel` payload, with the reply metadata:
 * reply_to_message_id, reply_to_from (bot | owner), reply_to_text (Telegram's quote when the owner selected part of the
 * message, else the start of the replied message), quote (partial | full) and reply_to_ref (the ref this bot sent with
 * that message). Null when the message carries nothing to forward.
 */
export function toNotification(m: TelegramMessage, o: { botId: string; messages: MessageMap; edited?: boolean }): ChannelNotification | null {
  if (!m.from || !m.chat) return null;
  const att = attachment(m);
  const body = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : att?.placeholder;
  if (body === undefined || body === '') return null;
  const chatId = String(m.chat.id);
  const meta: Record<string, string> = {
    chat_id: chatId,
    ...(typeof m.message_id === 'number' ? { message_id: String(m.message_id) } : {}),
    user: safeName(m.from.username) ?? String(m.from.id),
    user_id: String(m.from.id),
    ts: new Date((m.date ?? 0) * 1000).toISOString(),
  };
  if (att) {
    meta.attachment_kind = att.kind;
    meta.attachment_file_id = att.fileId;
    if (att.name) meta.attachment_name = att.name;
  }
  const r = m.reply_to_message;
  if (r && typeof r.message_id === 'number') {
    meta.reply_to_message_id = String(r.message_id);
    if (r.from?.is_bot === true && String(r.from.id) === o.botId) meta.reply_to_from = 'bot';
    else if (r.from && r.from.id === m.from.id) meta.reply_to_from = 'owner';
    const quoted = typeof m.quote?.text === 'string' && m.quote.text.trim() ? m.quote.text : null;
    const sent = o.messages.get(chatId, r.message_id);
    const whole = typeof r.text === 'string' ? r.text : typeof r.caption === 'string' ? r.caption : sent?.textHead;
    const text = quoted ?? whole;
    if (text) {
      meta.reply_to_text = oneLine(text, QUOTE_MAX_CHARS);
      meta.quote = quoted ? 'partial' : 'full';
    }
    if (sent?.ref) meta.reply_to_ref = sent.ref;
  }
  if (o.edited) meta.edited = 'true';
  return { content: o.edited ? `(edited) ${body}` : body, meta };
}

/**
 * A poll_answer as a channel notification: `[poll answer] <question>: <option texts>` (`(vote retracted)` when the
 * owner took the vote back), meta poll_id, option_ids, message_id and reply_to_message_id = the poll message,
 * reply_to_ref = the poll's ref. A poll_answer has no chat: the voter must be the allowlisted owner (DM policy not
 * disabled) and the poll one this bot sent; anything else is dropped.
 */
export function pollAnswerNotification(a: TelegramPollAnswer, o: { access: ChannelAccess; messages: MessageMap; now: number }):
{ action: 'deliver'; notification: ChannelNotification; poll: SentMessage } | { action: 'drop'; why: string } {
  if (!a.user) return { action: 'drop', why: 'poll answer without a user (a chat vote)' };
  if (a.user.is_bot === true) return { action: 'drop', why: 'bot sender' };
  if (o.access.dmPolicy === 'disabled') return { action: 'drop', why: 'DM policy disabled' };
  const userId = String(a.user.id);
  if (!o.access.allowFrom.includes(userId)) return { action: 'drop', why: 'poll voter not allowlisted' };
  const sent = typeof a.poll_id === 'string' ? o.messages.findPoll(a.poll_id) : undefined;
  if (!sent?.poll) return { action: 'drop', why: 'unknown poll' };
  const { poll } = sent;
  const ids = (a.option_ids ?? []).filter((i) => Number.isSafeInteger(i) && i >= 0);
  const question = oneLine(poll.question, POLL_QUESTION_MAX);
  const answer = ids.length ? ids.map((i) => oneLine(poll.options[i] ?? `option ${i}`, POLL_OPTION_MAX)).join('; ') : '(vote retracted)';
  const meta: Record<string, string> = {
    chat_id: sent.chatId, message_id: String(sent.messageId), reply_to_message_id: String(sent.messageId), reply_to_from: 'bot',
    reply_to_text: question, quote: 'full', poll_id: poll.pollId, option_ids: ids.join(','),
    user: safeName(a.user.username) ?? userId, user_id: userId, ts: new Date(o.now).toISOString(),
    ...(sent.ref ? { reply_to_ref: sent.ref } : {}),
  };
  return { action: 'deliver', notification: { content: `[poll answer] ${question}: ${answer}`, meta }, poll: sent };
}

/** The message of an update the channel reads (a new message or an edit). */
export const updateMessage = (u: TelegramUpdate): { m: TelegramMessage; edited: boolean } | null =>
  u.message ? { m: u.message, edited: false } : u.edited_message ? { m: u.edited_message, edited: true } : null;

/** The first characters of a sent message, kept in the message map (a reply to it shows them when Telegram does not). */
export const textHead = (text: string) => truncateCodePoints(text, QUOTE_MAX_CHARS);

// ---------------------------------------------------------------- 409 handling

/** A run of this many `409 Conflict` answers to getUpdates in a row is persistent; fewer is a race and only retried. */
export const CONFLICT_RUN = 3;
export const CONFLICT_BACKOFF_CAP_MS = 30_000;

/** Backoff before retry n (1-based) after a 409: 1 s, 2 s, 4 s, ... capped at 30 s, jittered down by at most 25 %. */
export function conflictBackoffMs(n: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, n - 1), CONFLICT_BACKOFF_CAP_MS);
  return Math.round(base * (0.75 + 0.25 * Math.min(Math.max(random(), 0), 1)));
}

export type ConflictStep = { action: 'retry'; delayMs: number } | { action: 'persistent' };

/** Counts 409s in a row; a success resets the run. */
export class ConflictTracker {
  private run = 0;
  constructor(private readonly random: () => number = Math.random) {}
  onConflict(): ConflictStep {
    this.run += 1;
    if (this.run >= CONFLICT_RUN) { this.run = 0; return { action: 'persistent' }; }
    return { action: 'retry', delayMs: conflictBackoffMs(this.run, this.random) };
  }
  onSuccess(): void { this.run = 0; }
}
