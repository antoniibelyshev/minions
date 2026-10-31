// The Telegram Bot API client shared by the host manager bot (src/host/manager-telegram.ts) and the minions-owned
// channel server (src/telegram/channel/server.ts); docs/design/telegram-channel.md, "Server shape", layer 1.
//
// - fetch only, JSON bodies, plain text (no parse_mode). The token travels only in the request URL path; every error
//   message is redacted (the token itself and anything token-shaped) and never includes it.
// - Error mapping: 401/404 is a rejected token (AUTH_REQUIRED); 409 is "another process polls this bot" (CONFLICT);
//   anything else that is not `ok` is NETWORK_RETRYABLE, with `details.retryAfterMs` when Telegram sent retry_after
//   (429). A fetch failure is NETWORK_RETRYABLE too. The wording of the AUTH and CONFLICT errors is per caller.
// - callRetry waits out one 429 (at most 30 s) and tries once more.
// - OffsetFile persists the getUpdates offset per bot (0600 file, 0700 dir), so a restart does not replay updates.
import { chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { displayText, truncateCodePoints } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { ensureDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';

export type Fetch = typeof fetch;

/** Telegram allows 4096 characters per message; longer text is cut with a note. */
export const MESSAGE_MAX_CHARS = 4000;

/** One line, plain, bounded. */
export const oneLine = (s: string, max = 300): string => {
  const t = displayText(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${truncateCodePoints(t, max - 1)}…` : t;
};
/** Text cut to MESSAGE_MAX_CHARS with a note. */
export const clip = (s: string): string => (s.length > MESSAGE_MAX_CHARS ? `${truncateCodePoints(s, MESSAGE_MAX_CHARS - 40)}\n… (cut: the message was too long)` : s);

/** The parts of a Bot API user / chat / message / update minions reads. */
export interface TelegramUser { id: number; is_bot?: boolean; username?: string; first_name?: string }
export interface TelegramChat { id: number; type?: string }
export interface TelegramMessage {
  message_id?: number; date?: number; text?: string; caption?: string;
  from?: TelegramUser; chat?: TelegramChat;
  /** Set on a forwarded message (forward_origin in Bot API 7+, forward_from / forward_from_chat / forward_date before). */
  forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown; forward_date?: unknown;
  /** The message this one replies to (Bot API: a Message without its own reply_to_message). */
  reply_to_message?: TelegramMessage;
  /** The part of the replied message the sender selected (Bot API 7.0 TextQuote). */
  quote?: { text?: string; is_manual?: boolean };
  photo?: { file_id: string; file_size?: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  sticker?: { file_id: string; emoji?: string };
  poll?: { id?: string };
}
/** A vote in a non-anonymous poll (Bot API PollAnswer; empty option_ids: the vote was retracted). */
export interface TelegramPollAnswer { poll_id?: string; user?: TelegramUser; voter_chat?: TelegramChat; option_ids?: number[] }
export interface TelegramCallbackQuery { id?: string; data?: string; from?: TelegramUser; message?: TelegramMessage }
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  poll_answer?: TelegramPollAnswer;
}

/** True for a forwarded message, in the current (forward_origin) or the older (forward_from, forward_date, ...) shape. */
export function isForwarded(m: TelegramMessage): boolean {
  return m.forward_origin != null || m.forward_from != null || m.forward_from_chat != null || m.forward_date != null;
}

export type InlineKeyboard = { text: string; callback_data: string }[][];

/** The caller-specific wording of the two errors a human acts on. */
export interface BotApiErrorText {
  auth: { message: string; hint: string };
  conflict: { message: string; hint: string };
}

export interface BotApiOptions {
  token: string;
  fetch?: Fetch;
  errors: BotApiErrorText;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface BotApiBody { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }

export const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** retry_after of a 429 MinionsError, in ms; undefined for any other error. */
export const retryAfterMs = (e: unknown): number | undefined => {
  const v = ((e as MinionsError | undefined)?.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof v === 'number' ? v : undefined;
};

export class BotApi {
  private readonly f: Fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: BotApiOptions) {
    this.f = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Redacts the token (literally and by shape) from any text. */
  redact(text: string): string {
    return redact(this.opts.token ? text.split(this.opts.token).join('[REDACTED_BOT_TOKEN]') : text);
  }

  /** One Bot API call. Errors are MinionsErrors without the token; `details.retryAfterMs` on 429. */
  async call(method: string, body: Record<string, unknown>, timeoutMs = 15_000, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.f(`https://api.telegram.org/bot${this.opts.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new MinionsError('NETWORK_RETRYABLE', `could not reach the Telegram Bot API (${method}): ${truncateCodePoints(this.redact(String((e as Error)?.message ?? e)), 200)}`);
    }
    if (res.status === 401 || res.status === 404) throw new MinionsError('AUTH_REQUIRED', this.opts.errors.auth.message, this.opts.errors.auth.hint);
    if (res.status === 409) throw new MinionsError('CONFLICT', this.opts.errors.conflict.message, this.opts.errors.conflict.hint);
    const parsed = await res.json().catch((): BotApiBody => ({})) as BotApiBody;
    if (!res.ok || parsed.ok !== true) {
      const retry = typeof parsed.parameters?.retry_after === 'number' ? parsed.parameters.retry_after * 1000 : undefined;
      const why = typeof parsed.description === 'string' ? `: ${oneLine(this.redact(parsed.description), 200)}` : '';
      throw new MinionsError('NETWORK_RETRYABLE', `Telegram Bot API ${method} returned ${res.status}${why}`, undefined, retry !== undefined ? { retryAfterMs: retry } : undefined);
    }
    return parsed.result;
  }

  /** A call that waits out one 429 (at most 30 s) and tries once more. */
  async callRetry(method: string, body: Record<string, unknown>): Promise<unknown> {
    try { return await this.call(method, body); } catch (e) {
      const retry = retryAfterMs(e);
      if (typeof retry !== 'number' || retry > 30_000) throw e;
      await this.sleep(Math.max(retry, 1000));
      return this.call(method, body);
    }
  }

  /** getUpdates long poll; only well-formed updates come back. */
  async getUpdates(o: { offset?: number; timeoutSecs: number; allowed: string[]; signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    const updates = await this.call('getUpdates', {
      ...(o.offset !== undefined ? { offset: o.offset } : {}), timeout: o.timeoutSecs, allowed_updates: o.allowed,
    }, (o.timeoutSecs + 15) * 1000, o.signal);
    if (!Array.isArray(updates)) return [];
    return (updates as TelegramUpdate[]).filter((u) => typeof u?.update_id === 'number' && Number.isSafeInteger(u.update_id));
  }

  /** sendMessage (plain text, cut, no link preview); the new message id, or null when Telegram sent none. */
  async sendMessage(chatId: number | string, text: string, o: { keyboard?: InlineKeyboard; replyTo?: number } = {}): Promise<number | null> {
    const r = await this.callRetry('sendMessage', {
      chat_id: chatId, text: clip(text), disable_web_page_preview: true,
      ...(o.replyTo !== undefined ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
      ...(o.keyboard ? { reply_markup: { inline_keyboard: o.keyboard } } : {}),
    }) as { message_id?: unknown } | null;
    return typeof r?.message_id === 'number' ? r.message_id : null;
  }

  /** sendPoll (non-anonymous, so answers arrive as poll_answer updates); the message and poll ids, or null when Telegram sent none. */
  async sendPoll(chatId: number | string, question: string, options: string[], o: { multiple?: boolean; replyTo?: number } = {}): Promise<{ messageId: number; pollId: string } | null> {
    const r = await this.callRetry('sendPoll', {
      chat_id: chatId, question, options: options.map((text) => ({ text })), is_anonymous: false, allows_multiple_answers: o.multiple === true,
      ...(o.replyTo !== undefined ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
    }) as TelegramMessage | null;
    return typeof r?.message_id === 'number' && typeof r.poll?.id === 'string' ? { messageId: r.message_id, pollId: r.poll.id } : null;
  }

  /** stopPoll: closes a poll the bot sent (no more votes). */
  async stopPoll(chatId: number | string, messageId: number): Promise<void> {
    await this.callRetry('stopPoll', { chat_id: chatId, message_id: messageId });
  }

  /** editMessageText (drops the buttons unless a keyboard is given). */
  async editMessageText(chatId: number | string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.callRetry('editMessageText', {
      chat_id: chatId, message_id: messageId, text: clip(text), ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** answerCallbackQuery with a short toast (cut to 190 characters). */
  async answerCallbackQuery(callbackId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: truncateCodePoints(text, 190) });
  }

  async sendChatAction(chatId: number | string, action = 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action });
  }
}

const OffsetSchema = z.object({ version: z.literal(1), botId: z.string(), offset: z.number().int().nonnegative() }).strict();

/**
 * The persisted getUpdates offset of one bot: `{version: 1, botId, offset}` at `path` (0600, its dir 0700). A file of
 * another bot is ignored. Callers save before handling a batch (at-most-once), so a restart never replays it.
 */
export class OffsetFile {
  constructor(private readonly path: string, private readonly botId: string) {}

  /** The stored offset, or undefined (absent, another bot). Throws on an unreadable or malformed file. */
  async load(): Promise<number | undefined> {
    const v = await readJsonIfExists(this.path, OffsetSchema);
    return v && v.botId === this.botId ? v.offset : undefined;
  }

  async save(offset: number): Promise<void> {
    const dir = dirname(this.path);
    await ensureDir(dir, 0o700);
    await chmod(dir, 0o700);
    await writeJson(this.path, { version: 1, botId: this.botId, offset }, { mode: 0o600 });
  }
}

/** The next offset after a batch (the highest update_id + 1, never lower than the current one). */
export const nextOffset = (current: number | undefined, batch: TelegramUpdate[]): number | undefined =>
  batch.length ? Math.max(current ?? 0, ...batch.map((u) => u.update_id + 1)) : current;
