// The host manager's own Telegram bot, part 1 (docs/design/host-manager.md, "Token isolation for the manager bot";
// task-53.5.1): entering the manager-bot-token and pairing the owner from the host terminal.
//
// - The token is host-wide (MANAGER_CREDENTIAL in credentials.ts): Keychain / Secret Service / a 0600 file under
//   <MINIONS_HOME>/credentials/manager/. It is entered only through the hidden prompt or a pipe, never argv, and it
//   never reaches a project's secrets directory, compose env, config, logs or --json output.
// - The bot-id guard (bot-guard.ts) refuses a manager bot that is any project's coordinator bot.
// - Pairing (pairManagerBot) is a terminal action only (`minions setup`): it shows a one-time code and long-polls
//   getUpdates until the owner sends that code to the bot in a private chat (10 minutes). The sender's numeric
//   user id and private chat id go to <MINIONS_HOME>/manager/access.json (0600). Group chats never pair. The later
//   Bot API transport (task-53.5.2) reads the same file through loadManagerAccess / isOwnerUpdate and must never
//   pair or re-pair on its own.
import { randomInt } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { z } from 'zod';
import { MinionsError } from '../core/errors.js';
import { ensureDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { managerDir, managerPaths } from '../core/paths.js';
import { BOTFATHER_URL, checkTelegramTokenFormat } from '../telegram/token.js';
import { assertManagerBotDistinct, type BotGuardDeps } from './bot-guard.js';
import {
  loadManagerCredentialRef, storeManagerToken, verifyTelegramToken,
  type Backend, type Fetch, type SecretStore, type StoreOptions, type Verification,
} from './credentials.js';

/** How long a pairing code is valid. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Manager bot creation steps. Contains no secret. */
export function managerBotGuidance(): string[] {
  return [
    'The host manager has its own Telegram bot, separate from every coordinator bot. It asks you to confirm',
    '  setup changes a coordinator requested; nothing is applied without your confirmation.',
    `Create a new bot: open ${BOTFATHER_URL}, send /newbot, and copy the token. Then /setjoingroups -> Disable:`,
    '  the manager works only in your private chat with it.',
    'Never reuse a coordinator bot: a coordinator token is mounted into its container, the manager token never is.',
    'The token stays on this host (Keychain, Secret Service or a 0600 file); only the manager process reads it.',
  ];
}

// ---------------------------------------------------------------- token entry

export interface ManagerProvisionOptions extends StoreOptions, Pick<BotGuardDeps, 'projectsUsingBot'> {
  token: string;
  /** Bot API getMe check; only with the user's explicit consent (default off). */
  verify?: boolean;
  fetch?: Fetch;
  store?: SecretStore;
}
export interface ManagerProvisionResult {
  backend: Backend;
  ref: string;
  botId: string;
  verification: Verification | null;
  /** The previous pairing belonged to another bot and was removed. */
  pairingCleared: boolean;
  warnings: string[];
}

/**
 * Validates the format, refuses a coordinator bot (CONFLICT), optionally verifies with getMe (an invalid token is not
 * stored), stores the token and records its bot id. A token of a different bot clears the old pairing.
 */
export async function provisionManagerToken(opts: ManagerProvisionOptions): Promise<ManagerProvisionResult> {
  const { token, botId } = checkTelegramTokenFormat(opts.token);
  await assertManagerBotDistinct(botId, opts);
  const warnings: string[] = [];
  let verification: Verification | null = null;
  if (opts.verify) {
    verification = await verifyTelegramToken(token, { fetch: opts.fetch });
    if (verification.status === 'invalid') {
      throw new MinionsError('AUTH_REQUIRED', `Manager bot token not stored: ${verification.detail}.`, `Copy the token again from ${BOTFATHER_URL} (/mybots -> API Token).`);
    }
    if (verification.status === 'unverified') warnings.push(`Token stored without verification: ${verification.detail}.`);
  }
  const prev = await loadManagerCredentialRef().catch(() => null);
  const ref = await storeManagerToken(token, opts);
  let pairingCleared = false;
  if (prev?.botId !== botId) {
    const access = await loadManagerAccess().catch(() => 'invalid' as const);
    if (access) { await clearManagerAccess(); pairingCleared = true; }
  }
  return { backend: ref.backend, ref: ref.ref, botId, verification, pairingCleared, warnings };
}

// ---------------------------------------------------------------- owner access (access.json)

export const ManagerAccessSchema = z.object({
  version: z.literal(1),
  /** The manager bot this pairing belongs to; a token of another bot needs a new pairing. */
  botId: z.string().regex(/^\d{6,12}$/),
  /** Numeric Telegram user id of the owner (never the username, which can change hands). */
  userId: z.number().int().positive(),
  /** The owner's private chat with the bot. */
  chatId: z.number().int(),
  pairedAt: z.string(),
}).strict();
export type ManagerAccess = z.infer<typeof ManagerAccessSchema>;

/** The recorded owner, or null when not paired. An unreadable file is an error (INVALID_CONFIG). */
export async function loadManagerAccess(): Promise<ManagerAccess | null> {
  return (await readJsonIfExists(managerPaths().accessJson, ManagerAccessSchema)) ?? null;
}

export async function saveManagerAccess(access: ManagerAccess): Promise<void> {
  const a = ManagerAccessSchema.parse(access);
  await ensureDir(managerDir(), 0o700);
  await chmod(managerDir(), 0o700);
  await writeJson(managerPaths().accessJson, a, { mode: 0o600 });
}

export async function clearManagerAccess(): Promise<void> {
  await rm(managerPaths().accessJson, { force: true });
}

/** The parts of a Bot API update the owner check reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: { message_id?: number; text?: string; from?: { id: number; is_bot?: boolean }; chat?: { id: number; type?: string } };
  callback_query?: {
    id?: string; data?: string; from?: { id: number; is_bot?: boolean };
    message?: { message_id?: number; chat?: { id: number; type?: string } };
  };
}

/**
 * True only for an update from the paired owner in the paired private chat (a message or a button tap). Everything
 * else (other users, groups, channels, the owner in a group) is dropped by the transport without a reply.
 */
export function isOwnerUpdate(access: ManagerAccess, u: TelegramUpdate): boolean {
  const from = u.message?.from ?? u.callback_query?.from;
  const chat = u.message?.chat ?? u.callback_query?.message?.chat;
  return !!from && !!chat && from.is_bot !== true && chat.type === 'private' && from.id === access.userId && chat.id === access.chatId;
}

// ---------------------------------------------------------------- terminal pairing

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** A one-time pairing code: 8 characters (40 bits), shown as XXXX-XXXX. */
export function pairingCode(): string {
  let c = '';
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const normalizeCode = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();

export interface PairingOptions {
  token: string;
  /** Bot id of `token` (recorded with the pairing). */
  botId: string;
  fetch?: Fetch;
  /** Clock and sleep (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default PAIRING_TTL_MS (10 minutes). */
  ttlMs?: number;
  /** Long-poll seconds per getUpdates call (default 25). */
  pollSeconds?: number;
  /** Fixed code (tests); default a fresh pairingCode(). */
  code?: string;
  /** Called once with the code to show, before polling starts. */
  onCode?: (code: string, expiresAt: Date) => void;
}
export type PairingResult = { status: 'paired'; access: ManagerAccess } | { status: 'expired'; detail: string };

interface BotApiBody { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } }

/**
 * Shows a one-time code and waits (at most ttlMs) for the owner to send it to the manager bot in a private chat.
 * Messages from groups, from bots, or with any other text are skipped without a reply. On a match the sender's user id
 * and chat id are written to access.json (replacing an older pairing only then), the code message is acknowledged so
 * the manager does not see it again, and a short confirmation is sent. 401/404: the token is rejected (AUTH_REQUIRED);
 * 409: another process polls this bot or a webhook is set (CONFLICT). Network errors are retried until the deadline.
 * Errors never include the token (it travels only in the request URL path).
 */
export async function pairManagerBot(opts: PairingOptions): Promise<PairingResult> {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ttl = opts.ttlMs ?? PAIRING_TTL_MS;
  const poll = opts.pollSeconds ?? 25;
  const code = opts.code ?? pairingCode();
  const want = normalizeCode(code);
  const deadline = now() + ttl;
  const call = (method: string, body: Record<string, unknown>, timeoutMs: number) => f(`https://api.telegram.org/bot${opts.token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  opts.onCode?.(code, new Date(deadline));
  let offset: number | undefined;
  let lastProblem = '';
  while (now() < deadline) {
    const wait = Math.max(0, Math.min(poll, Math.floor((deadline - now()) / 1000)));
    let res: Response;
    try {
      res = await call('getUpdates', { ...(offset !== undefined ? { offset } : {}), timeout: wait, allowed_updates: ['message'] }, (wait + 15) * 1000);
    } catch (e) {
      lastProblem = `could not reach the Telegram Bot API: ${redact(String((e as Error).message ?? e)).slice(0, 200)}`;
      await sleep(3000);
      continue;
    }
    if (res.status === 401 || res.status === 404) {
      throw new MinionsError('AUTH_REQUIRED', 'The manager bot token was rejected by Telegram (revoked or mistyped); nothing was paired.',
        `Store the token again with \`minions setup\` (copy it from ${BOTFATHER_URL}, /mybots -> API Token).`);
    }
    if (res.status === 409) {
      throw new MinionsError('CONFLICT', 'Another process polls the manager bot (Telegram getUpdates 409 Conflict), or a webhook is set; nothing was paired.',
        'Stop the other poller (a running host manager, or a coordinator wrongly given this token), or remove the webhook, then pair again with `minions setup`.');
    }
    const body = await res.json().catch((): BotApiBody => ({})) as BotApiBody;
    if (!res.ok || body.ok !== true || !Array.isArray(body.result)) {
      lastProblem = `Telegram Bot API returned ${res.status}`;
      const retry = typeof body.parameters?.retry_after === 'number' ? body.parameters.retry_after * 1000 : 3000;
      await sleep(Math.min(Math.max(retry, 1000), 60_000));
      continue;
    }
    lastProblem = '';
    for (const u of body.result as TelegramUpdate[]) {
      if (typeof u?.update_id !== 'number') continue;
      offset = Math.max(offset ?? 0, u.update_id + 1);
      const m = u.message;
      if (!m?.from || !m.chat || m.from.is_bot === true || m.chat.type !== 'private') continue; // no groups, no bots
      if (typeof m.text !== 'string' || normalizeCode(m.text) !== want) continue;
      if (!Number.isSafeInteger(m.from.id) || m.from.id <= 0 || !Number.isSafeInteger(m.chat.id)) continue;
      const access: ManagerAccess = { version: 1, botId: opts.botId, userId: m.from.id, chatId: m.chat.id, pairedAt: new Date(now()).toISOString() };
      await saveManagerAccess(access);
      // Acknowledge everything up to the code message, then confirm in the chat (best effort).
      await call('getUpdates', { offset, timeout: 0 }, 15_000).catch(() => undefined);
      await call('sendMessage', { chat_id: m.chat.id, text: 'Paired: this private chat is now the owner chat of the minions host manager. Pairing again is possible only from the host terminal.' }, 15_000).catch(() => undefined);
      return { status: 'paired', access };
    }
  }
  return { status: 'expired', detail: `no matching code arrived within ${Math.round(ttl / 60_000)} minutes${lastProblem ? ` (last problem: ${lastProblem})` : ''}` };
}
