// The host manager's own Telegram bot, part 2 (docs/design/host-manager.md, "Confirmation model" and "Token isolation
// for the manager bot"; task-53.5.2): the Bot API ManagerTransport that `minions manager run` uses once the manager bot
// is paired (a stored manager-bot-token and <MINIONS_HOME>/manager/access.json).
//
// - fetch only (getUpdates long poll, sendMessage with an inline keyboard, answerCallbackQuery, editMessageText). The
//   token travels only in the request URL path; errors are redacted and never include it.
// - Owner only: an update that isOwnerUpdate rejects (another user, a group, a bot) is dropped without any reply, not
//   even answerCallbackQuery. A forwarded message (forward_origin, forward_from, forward_from_chat or forward_date) is
//   ignored the same way, even from the owner: only what the owner types counts. This transport never pairs or re-pairs.
// - Plain text only (no parse_mode), so untrusted text cannot inject markup; it is displayText'd anyway.
// - Offers carry Confirm / Reject buttons: callback_data `c:<requestId>:<nonce>` and `r:<requestId>:<nonce>` (46 bytes,
//   within Telegram's 64). The core trusts only the nonce; the transport only turns taps into events.
// - A plan with `loosens` asks twice: the first Confirm sends a second message naming the risk in one line with a
//   `d:<requestId>:<nonce>` button that must be tapped within 2 minutes. Only that second tap sends the confirm event.
// - The `applying` outcome edits the tapped offer message to "Applying…" (and removes its buttons); every other outcome
//   is a new message, so the owner's phone notifies.
// - The getUpdates offset is persisted in <MINIONS_HOME>/manager/telegram-offset.json (0600, dir 0700) before a batch
//   is handled, so a restart does not replay old taps (and the journal's single-use nonce covers the rest).
// - 409 is "another process polls the manager bot" (CONFLICT); 401/404 is a rejected token (AUTH_REQUIRED); 429 waits
//   retry_after.
// - /settings [query] (task-65.1): read-only, the settings of the picked project with value, source, when a change takes
//   effect and the host-owned mark; a group name or a key substring narrows it; cut to one message with a "N more" tail.
//   Secrets show only set / unset. An unknown /set key gets the closest keys; a /set whose value is already in effect
//   gets a plain explanation (ManagerNotice), not a "failed" line.
// - A fixed command set: /status, /requests, /project [name], /settings [query], /help (and /start), and the owner change commands
//   /set <key> <value> [shared], /sync, /upgrade, /restart, /undo <id> (task-53.5.3). Anything else gets the help text.
// - The dev-only /rebuild_cli (task-53.7) is accepted and listed in the help text only when
//   ManagerCommands.devRebuild says it exists; elsewhere it is an unknown command like any other.
//   A change command only asks the core for a plan (ManagerCommands.propose) and shows it as an offer with Confirm /
//   Reject: typing it is never consent, and the tap goes through the same confirmation as a container request.
// - /approve <task> <sha> [merge] (task-53.5.4): only a full 40-character lowercase head SHA parses (a short or
//   non-hex one gets the usage line). Its plan always loosens, so it always needs the double tap.
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { displayText, truncateCodePoints } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { ensureDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { managerDir } from '../core/paths.js';
import { findOfferByNonce, isOfferRequestId, isOwnerRequestId } from './change-journal.js';
import { APPROVE_HEAD_PATTERN, APPROVE_TASK_ID_PATTERN } from './change-requests.js';
import type { Fetch } from './credentials.js';
import { isOwnerUpdate, type ManagerAccess, type TelegramUpdate } from './manager-bot.js';
import { ManagerNotice, type ManagerCommands, type ManagerEvent, type ManagerOffer, type ManagerOutcome, type ManagerTransport, type OwnerCommand } from './manager.js';
import { closestSettingKeys, formatValue, SETTING_GROUPS, type SettingView } from './settings.js';

/** Telegram's callback_data limit. */
export const CALLBACK_DATA_MAX_BYTES = 64;
/** The second tap for a plan with `loosens` must come within this time of the first. */
export const DOUBLE_TAP_MS = 2 * 60_000;
/** Telegram allows 4096 characters per message; longer text is cut with a note. */
export const MESSAGE_MAX_CHARS = 4000;
export const telegramOffsetPath = () => join(managerDir(), 'telegram-offset.json');

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export type CallbackAction = 'c' | 'r' | 'd';
/** `c` confirm, `r` reject, `d` the second confirmation of a plan that loosens policy. */
export function callbackData(action: CallbackAction, requestId: string, nonce: string): string {
  const data = `${action}:${requestId}:${nonce}`;
  if (!isOfferRequestId(requestId) || !NONCE_PATTERN.test(nonce) || Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) {
    throw new MinionsError('INTERNAL', `callback data for ${displayText(requestId)} is malformed or over ${CALLBACK_DATA_MAX_BYTES} bytes.`);
  }
  return data;
}

export function parseCallbackData(data: unknown): { action: CallbackAction; requestId: string; nonce: string } | null {
  if (typeof data !== 'string' || Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) return null;
  const m = /^([crd]):([^:]+):([^:]+)$/.exec(data);
  if (!m || !isOfferRequestId(m[2]!) || !NONCE_PATTERN.test(m[3]!)) return null;
  return { action: m[1] as CallbackAction, requestId: m[2]!, nonce: m[3]! };
}

/** True for a forwarded message, in the current (forward_origin) or the older (forward_from, forward_date, ...) shape. */
export function isForwarded(m: NonNullable<TelegramUpdate['message']>): boolean {
  return m.forward_origin != null || m.forward_from != null || m.forward_from_chat != null || m.forward_date != null;
}

/** One line, plain, bounded: for the risk line of the double tap. */
const oneLine = (s: string, max = 300) => {
  const t = displayText(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${truncateCodePoints(t, max - 1)}…` : t;
};
const clip = (s: string) => (s.length > MESSAGE_MAX_CHARS ? `${truncateCodePoints(s, MESSAGE_MAX_CHARS - 40)}\n… (cut: the message was too long)` : s);

const REBUILD_HELP_MARK = '\u0000rebuild';
/** Shown only where the dev-only request exists (host CLI from a minions source checkout, project minions). */
export const REBUILD_HELP_LINE = '/rebuild_cli - dev only: rebuild the host CLI from the commits in this checkout, then upgrade (shows git log, diffstat and sensitive paths; always asks twice)';
const HELP_LINES = [
  'minions host manager. Commands:',
  '/status - per project: runtime, coordinator, active leases, pending change requests',
  '/requests - pending change requests, each with Confirm / Reject buttons',
  '/project [name] - list the projects, or pick the one the other commands use',
  '/settings [query] - the settings with value, source, when a change takes effect and the host-owned mark; query: a group (e.g. delivery) or part of a key',
  '/set <key> <value> [shared] - change a setting (like minions settings set; local layer unless "shared"); host-owned keys too',
  '/sync - fast-forward the host base branch (local delivery: from the container; GitHub delivery: from origin)',
  '/upgrade - minions upgrade; the dry-run plan is shown first',
  '/restart - graceful coordinator restart (refused while workers are active; then "Restart when idle" and "Drain now" are offered)',
  '/undo <id> - restore the config file as it was before change <id> (only while nothing changed it since)',
  '/approve <task> <sha> [merge] - sign an approval to publish (or with "merge": to merge) <task> at that full head SHA (always asks twice)',
  '/help - this text',
  REBUILD_HELP_MARK,
  'Change requests from the coordinators arrive here by themselves. A command you type only shows a plan: nothing is applied until you tap Confirm (twice when it loosens policy).',
];
/** The help text; the /rebuild_cli line only when the dev-only request exists. */
export const helpText = (devRebuild = false) => HELP_LINES.flatMap((l) => (l === REBUILD_HELP_MARK ? (devRebuild ? [REBUILD_HELP_LINE] : []) : [l])).join('\n');
export const HELP_TEXT = helpText(false);

/** Usage line per change command (sent when the arguments do not parse). */
const USAGE: Record<string, string> = {
  set: 'Usage: /set <key> <value> [shared], e.g. /set execution.maxActiveTasks 3 (value "default" unsets an optional setting). Keys: /settings, or minions settings --list on the host.',
  undo: 'Usage: /undo <id>, the id of an applied config change (cr_... or ow_...).',
  approve: 'Usage: /approve <task> <sha> [merge], e.g. /approve task-12 <sha>. <sha> must be the full 40-character lowercase head SHA from the awaiting-approval message (short or non-hex SHAs are refused). Without "merge" it approves publishing that head; with "merge" it approves merging its delivered pull request.',
  sync: 'Usage: /sync (no arguments).', upgrade: 'Usage: /upgrade (no arguments).', restart: 'Usage: /restart (no arguments).',
  rebuild_cli: 'Usage: /rebuild_cli (no arguments).',
};
const CHANGE_COMMANDS = ['set', 'sync', 'upgrade', 'restart', 'undo', 'approve'];
/** Dev-only: accepted only when ManagerCommands.devRebuild says so; otherwise it is an unknown command (help text). */
const DEV_COMMANDS = ['rebuild_cli'];

/** Parses the arguments of an owner change command; null when they do not parse (the usage line is sent). */
export function parseOwnerCommand(cmd: string, arg: string): OwnerCommand | null {
  const words = arg.split(/\s+/).filter(Boolean);
  if (cmd === 'set') {
    const shared = words.at(-1) === 'shared' && words.length >= 3;
    const parts = shared ? words.slice(0, -1) : words;
    const [key, ...rest] = parts;
    const value = rest.join(' ');
    // A value is passed to `minions settings set` as one argv element: one that starts with "-" would read as a flag.
    if (!key || !/^[A-Za-z0-9_.-]+$/.test(key) || !value || value.startsWith('-') || value.length > 500) return null;
    return { kind: 'config-set', key, value, layer: shared ? 'shared' : 'local' };
  }
  if (cmd === 'undo') return words.length === 1 && isOfferRequestId(words[0]!) ? { kind: 'undo', target: words[0]! } : null;
  if (cmd === 'approve') {
    const [taskId, head, scope, ...extra] = words;
    if (!taskId || !head || extra.length || (scope !== undefined && scope !== 'merge')) return null;
    if (!APPROVE_TASK_ID_PATTERN.test(taskId) || !APPROVE_HEAD_PATTERN.test(head)) return null;
    return { kind: 'approve', taskId, head, merge: scope === 'merge' };
  }
  if (cmd === 'sync' || cmd === 'upgrade' || cmd === 'restart') return words.length ? null : { kind: cmd };
  if (cmd === 'rebuild_cli') return words.length ? null : { kind: 'rebuild-cli' };
  return null;
}

/** When a change of a setting takes effect, in a word (secrets: the auth command that changes them). */
function takesEffectWord(v: SettingView): string {
  if (v.type === 'secret') return `minions auth ${v.key.slice('secrets.'.length)}`;
  return v.needsUpgrade ? 'upgrade' : v.needsRestart ? 'restart' : 'now';
}

/** A setting's value for the chat: secrets only set / unset (the view never holds a secret anyway); one bounded line. */
function settingValueText(v: SettingView): string {
  if (v.type === 'secret') return v.value === 'provisioned' ? 'set' : 'unset';
  return oneLine(formatValue(v.value), 120);
}

/** One line per setting: `key = value (source; takes effect) [host-owned]`. */
export const settingLine = (v: SettingView) =>
  `${v.key} = ${settingValueText(v)} (${v.source}; ${takesEffectWord(v)})${v.hostOwned ? ' [host-owned]' : ''}`;

/**
 * The /settings reply: settings filtered by a group name (case-insensitive) or else a key substring, grouped, cut
 * below `max` characters with a "N more, narrow the query" tail. No match: the closest keys and the groups.
 */
export function formatSettingsList(project: { projectId: string; name: string }, all: SettingView[], query: string, max = MESSAGE_MAX_CHARS): string {
  const q = query.trim().toLowerCase();
  const group = SETTING_GROUPS.find((g) => g.toLowerCase() === q);
  const hits = !q ? all : group ? all.filter((v) => v.group === group) : all.filter((v) => v.key.toLowerCase().includes(q));
  const groups = `Groups: ${SETTING_GROUPS.map((g) => g.toLowerCase()).join(', ')}.`;
  if (!hits.length) {
    const near = closestSettingKeys(q, all.map((v) => v.key));
    return [`No setting matches "${oneLine(query, 80)}".`, ...(near.length ? [`Closest keys: ${near.join(', ')}.`] : []), groups].join('\n');
  }
  const head = [
    `Settings of ${displayText(project.name)} (${hits.length === all.length ? `all ${all.length}` : `${hits.length} of ${all.length}`}):`,
    'key = value (source; takes effect: now, restart = coordinator restart, upgrade = minions upgrade) [host-owned: never changed from the container]',
  ];
  const foot = ['', 'Change one with /set <key> <value> [shared].'];
  const tail = (n: number) => `… ${n} more, narrow the query: /settings <group or part of a key>. ${groups}`;
  const lines = [...head];
  let used = head.join('\n').length + foot.join('\n').length + tail(hits.length).length + 2;
  let shown = 0;
  let current: string | null = null;
  for (const v of hits) {
    const block = [...(v.group !== current ? ['', v.group] : []), `  ${settingLine(v)}`];
    const size = block.join('\n').length + 1;
    if (used + size > max) break;
    lines.push(...block);
    used += size;
    current = v.group;
    shown++;
  }
  const rest = hits.length - shown;
  return [...lines, ...(rest ? ['', tail(rest)] : foot)].join('\n');
}

const OffsetSchema = z.object({ version: z.literal(1), botId: z.string(), offset: z.number().int().nonnegative() }).strict();

interface BotApiBody { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }
interface KnownOffer { requestId: string; summary: string; loosens: string | null; messageId: number | null }

export interface TelegramTransportOptions {
  token: string;
  access: ManagerAccess;
  fetch?: Fetch;
  /** Clock and sleep (tests). */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Long-poll seconds per getUpdates call (default 25; never more than the wait the core asks for). */
  pollSeconds?: number;
  log?: (line: string) => void;
  /** The offer behind a nonce (default: the journal), for a tap on an offer this process did not send. */
  lookupOffer?: (nonce: string) => Promise<{ requestId: string; summary: string; loosens: string | null } | null>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

async function journalOffer(nonce: string): Promise<{ requestId: string; summary: string; loosens: string | null } | null> {
  const found = await findOfferByNonce(nonce);
  if (!found) return null;
  const plan = found.offer.plan as { loosens?: unknown } | null;
  return { requestId: found.offer.requestId, summary: found.offer.requestId, loosens: typeof plan?.loosens === 'string' ? plan.loosens : null };
}

export class TelegramTransport implements ManagerTransport {
  private readonly f: Fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly log: (line: string) => void;
  private commands: ManagerCommands | null = null;
  private offset: number | undefined;
  private offsetLoaded = false;
  /** Offers by nonce (what was sent, and the message that shows it). */
  private readonly offers = new Map<string, KnownOffer>();
  /** The message to edit to "Applying…" per request: the tapped one. */
  private readonly tapped = new Map<string, number>();
  /** First taps of a loosening plan: nonce -> deadline of the second tap. */
  private readonly armed = new Map<string, { requestId: string; until: number; messageId: number | null }>();
  /** The project /status and /requests show (null: all). */
  private selected: string | null = null;

  constructor(private readonly opts: TelegramTransportOptions) {
    this.f = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.log = opts.log ?? (() => undefined);
  }

  attach(commands: ManagerCommands): void { this.commands = commands; }

  // ------------------------------------------------------------ Bot API

  /** One Bot API call. Errors are MinionsErrors without the token; `details.retryAfterMs` on 429. */
  private async call(method: string, body: Record<string, unknown>, timeoutMs = 15_000, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.f(`https://api.telegram.org/bot${this.opts.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new MinionsError('NETWORK_RETRYABLE', `could not reach the Telegram Bot API (${method}): ${truncateCodePoints(redact(String((e as Error)?.message ?? e)), 200)}`);
    }
    if (res.status === 401 || res.status === 404) {
      throw new MinionsError('AUTH_REQUIRED', 'The manager bot token was rejected by Telegram (revoked or mistyped).',
        'Store the token again with `minions setup`, then restart the host manager.');
    }
    if (res.status === 409) {
      throw new MinionsError('CONFLICT', 'Another process polls the manager bot (Telegram getUpdates 409 Conflict), or a webhook is set.',
        'Stop the other poller (another host manager, or a coordinator wrongly given this token), or remove the webhook.');
    }
    const parsed = await res.json().catch((): BotApiBody => ({})) as BotApiBody;
    if (!res.ok || parsed.ok !== true) {
      const retry = typeof parsed.parameters?.retry_after === 'number' ? parsed.parameters.retry_after * 1000 : undefined;
      const why = typeof parsed.description === 'string' ? `: ${oneLine(redact(parsed.description), 200)}` : '';
      throw new MinionsError('NETWORK_RETRYABLE', `Telegram Bot API ${method} returned ${res.status}${why}`, undefined, retry !== undefined ? { retryAfterMs: retry } : undefined);
    }
    return parsed.result;
  }

  /** A call that waits out one 429 (at most 30 s) and tries once more. */
  private async callRetry(method: string, body: Record<string, unknown>): Promise<unknown> {
    try { return await this.call(method, body); } catch (e) {
      const retry = (e as MinionsError).details && ((e as MinionsError).details as { retryAfterMs?: number }).retryAfterMs;
      if (typeof retry !== 'number' || retry > 30_000) throw e;
      await this.sleep(Math.max(retry, 1000));
      return this.call(method, body);
    }
  }

  private async send(text: string, keyboard?: { text: string; callback_data: string }[][]): Promise<number | null> {
    const r = await this.callRetry('sendMessage', {
      chat_id: this.opts.access.chatId, text: clip(text), disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }) as { message_id?: unknown } | null;
    return typeof r?.message_id === 'number' ? r.message_id : null;
  }

  /** Edits a message's text and drops its buttons. False when Telegram refused (the caller then sends a new message). */
  private async edit(messageId: number, text: string): Promise<boolean> {
    try {
      await this.callRetry('editMessageText', { chat_id: this.opts.access.chatId, message_id: messageId, text: clip(text) });
      return true;
    } catch (e) {
      this.log(`telegram: editing message ${messageId} failed: ${(e as Error).message}`);
      return false;
    }
  }

  private async answer(callbackId: string | undefined, text: string): Promise<void> {
    if (!callbackId) return;
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: truncateCodePoints(text, 190) })
      .catch((e) => this.log(`telegram: answerCallbackQuery failed: ${(e as Error).message}`));
  }

  // ------------------------------------------------------------ offset

  private async loadOffset(): Promise<void> {
    if (this.offsetLoaded) return;
    this.offsetLoaded = true;
    try {
      const v = await readJsonIfExists(telegramOffsetPath(), OffsetSchema);
      if (v && v.botId === this.opts.access.botId) this.offset = v.offset;
    } catch (e) {
      this.log(`telegram: ignoring an unreadable getUpdates offset file: ${(e as Error).message}`);
    }
  }

  private async saveOffset(): Promise<void> {
    if (this.offset === undefined) return;
    await ensureDir(managerDir(), 0o700);
    await chmod(managerDir(), 0o700);
    await writeJson(telegramOffsetPath(), { version: 1, botId: this.opts.access.botId, offset: this.offset }, { mode: 0o600 });
  }

  // ------------------------------------------------------------ ManagerTransport

  async sendOffer(o: ManagerOffer): Promise<void> {
    const keyboard = [[
      { text: 'Confirm', callback_data: callbackData('c', o.requestId, o.nonce) },
      { text: 'Reject', callback_data: callbackData('r', o.requestId, o.nonce) },
    ]];
    const expired = Date.parse(o.expiresAt) <= this.now();
    const text = [
      `${isOwnerRequestId(o.requestId) ? 'Your request' : 'Change request'} ${o.requestId} (project ${o.projectId}): ${oneLine(o.summary)}`,
      '',
      displayText(o.text),
      '',
      ...(o.loosens ? [`This change loosens policy (${oneLine(o.loosens)}): Confirm asks a second time.`] : []),
      expired ? 'This offer expired: Confirm brings a fresh offer.' : `Confirm or Reject before ${o.expiresAt}.`,
    ].join('\n');
    const messageId = await this.send(text, keyboard);
    this.offers.set(o.nonce, { requestId: o.requestId, summary: o.summary, loosens: o.loosens, messageId });
  }

  async sendOutcome(o: ManagerOutcome): Promise<void> {
    const text = displayText(o.text);
    const msg = o.requestId ? this.tapped.get(o.requestId) : undefined;
    if (o.status === 'applying' && msg !== undefined && (await this.edit(msg, text))) return;
    if (o.status === 'rejected' && msg !== undefined) await this.edit(msg, `Rejected: ${text.split('\n')[0]}`);
    if (o.requestId && o.status !== 'applying' && o.status !== 'refused') {
      this.tapped.delete(o.requestId);
      for (const [nonce, k] of this.offers) if (k.requestId === o.requestId) this.offers.delete(nonce);
    }
    await this.send(text);
  }

  async receive(waitMs: number, signal?: AbortSignal): Promise<ManagerEvent[]> {
    await this.loadOffset();
    const secs = Math.max(0, Math.min(this.opts.pollSeconds ?? 25, Math.floor(waitMs / 1000)));
    let updates: unknown;
    try {
      updates = await this.call('getUpdates', {
        ...(this.offset !== undefined ? { offset: this.offset } : {}), timeout: secs, allowed_updates: ['message', 'callback_query'],
      }, (secs + 15) * 1000, signal);
    } catch (e) {
      if (signal?.aborted) return [];
      const retry = ((e as MinionsError).details as { retryAfterMs?: number } | undefined)?.retryAfterMs;
      if (typeof retry === 'number') { await this.sleep(Math.min(Math.max(retry, 1000), Math.max(waitMs, 0)), signal); return []; }
      throw e;
    }
    if (!Array.isArray(updates)) return [];
    const batch = (updates as TelegramUpdate[]).filter((u) => typeof u?.update_id === 'number' && Number.isSafeInteger(u.update_id));
    if (!batch.length) return [];
    // Acknowledge first (at most once): a crash while handling never replays these taps after a restart.
    this.offset = Math.max(this.offset ?? 0, ...batch.map((u) => u.update_id + 1));
    await this.saveOffset().catch((e) => this.log(`telegram: saving the getUpdates offset failed: ${(e as Error).message}`));
    const events: ManagerEvent[] = [];
    for (const u of batch) {
      if (!isOwnerUpdate(this.opts.access, u)) continue; // dropped silently: no reply, no answerCallbackQuery
      try {
        if (u.callback_query) {
          const ev = await this.onTap(u.callback_query);
          if (ev) events.push(ev);
        } else if (u.message) {
          if (isForwarded(u.message)) continue; // ignored silently: a forward is not the owner's own command
          await this.onMessage(typeof u.message.text === 'string' ? u.message.text : '');
        }
      } catch (e) {
        this.log(`telegram: handling update ${u.update_id} failed: ${(e as Error).message}`);
      }
    }
    return events;
  }

  // ------------------------------------------------------------ taps

  private async onTap(q: NonNullable<TelegramUpdate['callback_query']>): Promise<ManagerEvent | null> {
    const cb = parseCallbackData(q.data);
    const messageId = typeof q.message?.message_id === 'number' ? q.message.message_id : null;
    if (!cb) { await this.answer(q.id, 'Unknown button; nothing done.'); return null; }
    const { action, requestId, nonce } = cb;
    if (action === 'r') {
      await this.answer(q.id, 'Rejecting…');
      if (messageId !== null) this.tapped.set(requestId, messageId);
      return { type: 'reject', requestId, nonce };
    }
    if (action === 'd') {
      const armed = this.armed.get(nonce);
      this.armed.delete(nonce);
      if (!armed || armed.requestId !== requestId || this.now() > armed.until) {
        await this.answer(q.id, 'The second confirmation expired.');
        await this.send(`The second confirmation of change request ${requestId} expired (it must come within ${DOUBLE_TAP_MS / 60_000} minutes of the first). Nothing applied; tap Confirm on the offer again.`);
        return null;
      }
      await this.answer(q.id, 'Confirmed.');
      const target = armed.messageId ?? messageId;
      if (target !== null) this.tapped.set(requestId, target);
      return { type: 'confirm', requestId, nonce };
    }
    // action 'c': the loosening check (this process's offer, else the journal's). Unknown: the core refuses it.
    let known: { requestId: string; summary: string; loosens: string | null } | null = this.offers.get(nonce) ?? null;
    if (!known) {
      try { known = await (this.opts.lookupOffer ?? journalOffer)(nonce); } catch (e) {
        await this.answer(q.id, 'Could not read the offer; nothing done.');
        this.log(`telegram: reading the offer for ${requestId} failed: ${(e as Error).message}`);
        return null;
      }
    }
    if (known && known.requestId === requestId && known.loosens) {
      for (const [n, a] of this.armed) if (this.now() > a.until) this.armed.delete(n);
      this.armed.set(nonce, { requestId, until: this.now() + DOUBLE_TAP_MS, messageId });
      await this.answer(q.id, 'A second confirmation is needed.');
      await this.send(
        `Second confirmation for change request ${requestId}. Risk: ${oneLine(known.loosens)}\nTap "Confirm again" within ${DOUBLE_TAP_MS / 60_000} minutes to apply; otherwise nothing happens.`,
        [[{ text: 'Confirm again', callback_data: callbackData('d', requestId, nonce) }]],
      );
      return null;
    }
    await this.answer(q.id, 'Confirming…');
    if (messageId !== null) this.tapped.set(requestId, messageId);
    return { type: 'confirm', requestId, nonce };
  }

  // ------------------------------------------------------------ commands

  private async onMessage(text: string): Promise<void> {
    const m = /^\/([a-z][a-z_]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
    const cmd = m?.[1] ?? '';
    const arg = (m?.[2] ?? '').trim();
    const dev = await this.devRebuild();
    const change = CHANGE_COMMANDS.includes(cmd) || (dev && DEV_COMMANDS.includes(cmd));
    if (!['status', 'requests', 'project', 'settings'].includes(cmd) && !change) { await this.send(helpText(dev)); return; }
    if (!this.commands) { await this.send('The host manager is starting; try again in a moment.'); return; }
    try {
      if (change) await this.change(cmd, arg);
      else if (cmd === 'status') await this.send(displayText(await this.commands.status(this.selected)));
      else if (cmd === 'requests') await this.requests();
      else if (cmd === 'settings') await this.settings(arg);
      else await this.project(arg);
    } catch (e) {
      if (e instanceof ManagerNotice) { await this.send(displayText(e.message)); return; }
      await this.send(`/${cmd} failed: ${displayText(redact((e as Error).message))}`);
    }
  }

  /** An owner change command: the core builds and journals the plan; it is shown as an offer. Nothing applies here. */
  private async change(cmd: string, arg: string): Promise<void> {
    const c = parseOwnerCommand(cmd, arg);
    if (!c) { await this.send(USAGE[cmd]!); return; }
    if (c.kind === 'upgrade' || c.kind === 'sync' || c.kind === 'rebuild-cli') await this.send(`Planning /${cmd} (a dry run on the host)…`);
    const offer = await this.commands!.propose(this.selected, c);
    await this.sendOffer(offer);
  }

  /** Whether the dev-only /rebuild_cli exists for the picked project (or any); false when it cannot be told. */
  private async devRebuild(): Promise<boolean> {
    try { return (await this.commands?.devRebuild?.(this.selected)) === true; } catch { return false; }
  }

  private async settings(arg: string): Promise<void> {
    if (!this.commands!.settings) { await this.send('/settings is not available in this host manager.'); return; }
    const r = await this.commands!.settings(this.selected);
    await this.send(formatSettingsList(r, r.settings, arg));
  }

  private async requests(): Promise<void> {
    const pending = await this.commands!.pending(this.selected);
    if (!pending.length) { await this.send(`No pending change requests${this.selected ? ` for project ${this.selected}` : ''}.`); return; }
    await this.send(`${pending.length} pending change request(s):`);
    for (const o of pending) await this.sendOffer(o);
  }

  private async project(arg: string): Promise<void> {
    const projects = await this.commands!.projects();
    if (!arg) {
      const lines = projects.map((p) => `${p.projectId === this.selected ? '* ' : '  '}${displayText(p.name)} (${p.projectId})`);
      await this.send([projects.length ? 'Projects:' : 'No registered projects.', ...lines,
        this.selected ? 'Send /project all to show every project again.' : 'Showing every project. Send /project <name> to pick one.'].join('\n'));
      return;
    }
    if (arg === 'all') { this.selected = null; await this.send('Showing every project.'); return; }
    const want = arg.toLowerCase();
    let hits = projects.filter((p) => p.projectId === want || p.name.toLowerCase() === want);
    if (!hits.length && want.length >= 4) hits = projects.filter((p) => p.projectId.startsWith(want));
    if (hits.length !== 1) {
      await this.send(`${hits.length ? 'Several projects match' : 'No project matches'} "${oneLine(arg, 80)}". Send /project to list them.`);
      return;
    }
    this.selected = hits[0]!.projectId;
    await this.send(`Project picked: ${displayText(hits[0]!.name)} (${hits[0]!.projectId}). /status and /requests show only this project.`);
  }
}

export function telegramTransport(opts: TelegramTransportOptions): TelegramTransport {
  return new TelegramTransport(opts);
}
