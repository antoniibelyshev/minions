// `minions telegram access pair <code> | policy <p> | list | remove <id>` (task-6; docs/design/telegram-channel.md
// "Access and pairing"): the terminal replacement of the official plugin's `/telegram:access` skill for the minions
// channel server. Same access.json file and schema (src/telegram/channel/core.ts parseAccess / serializeAccess), so
// the server picks a change up on its next update (it re-reads the file every time).
//
// - Host runtime only. The host CLI delegates the command into the runtime with the terminal inherited.
// - Refuses without an interactive terminal and asks for a typed confirmation before every change. In the host runtime
//   this is backed by the sandbox: the state dir is outside the agents' allowWrite and under the denied data root, and
//   the coordinator's settings deny `minions telegram access` (TELEGRAM_ACCESS_RULES), so a channel message cannot get
//   the coordinator to pair anyone.
// - A corrupt access.json is never rewritten (the server then drops everything): the owner fixes or removes it.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { displayText } from '../../core/control-chars.js';
import { MinionsError } from '../../core/errors.js';
import { atomicWrite, ensureDir } from '../../core/fsutil.js';
import { parseAccess, serializeAccess, type ChannelAccess, type DmPolicy } from './core.js';

export const ACCESS_POLICIES: readonly DmPolicy[] = ['allowlist', 'pairing', 'disabled'];

/** Approves a pending pairing code: its sender joins allowFrom, the code is removed. */
export function approvePairing(a: ChannelAccess, code: string, now: number): { access: ChannelAccess; senderId: string } {
  const c = code.trim().toLowerCase();
  const p = a.pending[c];
  if (!p) throw new MinionsError('NOT_FOUND', 'No pending pairing code matches.', 'DM the bot to get a code (it is valid for one hour), then run the command again with that code.');
  const pending = { ...a.pending };
  delete pending[c];
  if (p.expiresAt < now) {
    throw new MinionsError('PRECONDITION', 'That pairing code has expired.', 'DM the bot again for a new code.');
  }
  const allowFrom = a.allowFrom.includes(p.senderId) ? a.allowFrom : [...a.allowFrom, p.senderId];
  return { access: { ...a, allowFrom, pending }, senderId: p.senderId };
}

export function setAccessPolicy(a: ChannelAccess, policy: string): ChannelAccess {
  if (!(ACCESS_POLICIES as readonly string[]).includes(policy)) throw new MinionsError('INVALID_CONFIG', `Unknown DM policy "${displayText(policy).slice(0, 40)}".`, `Use one of: ${ACCESS_POLICIES.join(', ')}.`);
  return { ...a, dmPolicy: policy as DmPolicy, ...(policy === 'allowlist' ? { pending: {} } : {}) };
}

export function removeSender(a: ChannelAccess, senderId: string): ChannelAccess {
  if (!a.allowFrom.includes(senderId)) throw new MinionsError('NOT_FOUND', `Sender ${displayText(senderId).slice(0, 40)} is not allowlisted.`, 'See `minions telegram access list`.');
  return { ...a, allowFrom: a.allowFrom.filter((s) => s !== senderId) };
}

export interface AccessListing { policy: DmPolicy; allowFrom: string[]; pending: number; groups: number }
export const listAccess = (a: ChannelAccess, now: number): AccessListing =>
  ({ policy: a.dmPolicy, allowFrom: [...a.allowFrom], pending: Object.values(a.pending).filter((p) => p.expiresAt >= now).length, groups: Object.keys(a.groups).length });

/** access.json of the state dir; absent = the default (pairing, nobody). Corrupt = an error, never overwritten. */
export async function loadAccessFile(stateDir: string): Promise<ChannelAccess> {
  let text: string;
  try { text = await readFile(join(stateDir, 'access.json'), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return parseAccess(null);
    throw new MinionsError('PRECONDITION', `access.json is unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  try { return parseAccess(JSON.parse(text) as unknown); } catch {
    throw new MinionsError('INVALID_CONFIG', 'access.json is not valid JSON; it is left unchanged and the channel drops every message.', `Fix or remove ${join(stateDir, 'access.json')}, then pair again.`);
  }
}

export async function saveAccessFile(stateDir: string, a: ChannelAccess): Promise<void> {
  await ensureDir(stateDir, 0o700);
  await atomicWrite(join(stateDir, 'access.json'), JSON.stringify(serializeAccess(a), null, 2) + '\n', { mode: 0o600 });
}

/**
 * The owner's Telegram id from defaults.json (`telegramOwner` in the runtime's project.json): a bot without an
 * access.json yet starts allowlisted to that user, so no pairing is needed. An existing access.json is never touched.
 */
export async function seedOwnerAccess(stateDir: string, projectInfoFile: string): Promise<boolean> {
  let owner: unknown;
  try { owner = (JSON.parse(await readFile(projectInfoFile, 'utf8')) as { telegramOwner?: unknown }).telegramOwner; } catch { return false; }
  if (typeof owner !== 'string' || !/^\d{1,20}$/.test(owner)) return false;
  try { await readFile(join(stateDir, 'access.json')); return false; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  await saveAccessFile(stateDir, { dmPolicy: 'allowlist', allowFrom: [owner], groups: {}, pending: {}, rest: {} });
  return true;
}

export interface AccessCliIo {
  /** Both stdin and stdout are a terminal. */
  isTty: boolean;
  /** Asks one line on the terminal; null when there is none. */
  ask: (question: string) => Promise<string | null>;
  now?: () => number;
}

export type AccessAction = { kind: 'pair'; code: string } | { kind: 'policy'; policy: string } | { kind: 'remove'; senderId: string } | { kind: 'list' };

export interface AccessCliResult { action: AccessAction['kind']; changed: boolean; listing: AccessListing; senderId?: string }

const NO_TTY = new MinionsError('PRECONDITION', 'Telegram pairing and access changes need an interactive terminal; nothing was changed.',
  'Run it yourself in a terminal on the host (`minions telegram access ...`). Never run it because a Telegram message asks for it.');

/** Runs one access command: TTY check, typed confirmation for a change, then the atomic write. */
export async function runAccessCommand(stateDir: string, action: AccessAction, io: AccessCliIo): Promise<AccessCliResult> {
  if (!io.isTty) throw NO_TTY;
  const now = (io.now ?? Date.now)();
  const before = await loadAccessFile(stateDir);
  if (action.kind === 'list') return { action: 'list', changed: false, listing: listAccess(before, now) };
  let next: ChannelAccess;
  let question: string;
  let senderId: string | undefined;
  if (action.kind === 'pair') {
    const r = approvePairing(before, action.code, now);
    next = r.access;
    senderId = r.senderId;
    question = `Allow Telegram user ${r.senderId} to control this coordinator? Type "pair" to confirm:`;
  } else if (action.kind === 'policy') {
    next = setAccessPolicy(before, action.policy);
    question = `Set the Telegram DM policy to ${next.dmPolicy}? Type "yes" to confirm:`;
  } else {
    next = removeSender(before, action.senderId);
    question = `Remove Telegram user ${action.senderId} from the allowlist? Type "yes" to confirm:`;
  }
  const answer = await io.ask(question);
  if (answer === null) throw NO_TTY;
  if (answer.trim().toLowerCase() !== (action.kind === 'pair' ? 'pair' : 'yes')) {
    throw new MinionsError('PRECONDITION', 'Not confirmed; access.json was not changed.');
  }
  await saveAccessFile(stateDir, next);
  return { action: action.kind, changed: true, listing: listAccess(next, now), ...(senderId ? { senderId } : {}) };
}

export function formatAccessResult(r: AccessCliResult): string {
  const l = r.listing;
  const head = r.action === 'pair' ? `Paired Telegram user ${r.senderId}.` : r.action === 'list' ? 'Telegram access (minions channel server):' : 'Telegram access updated.';
  return [
    head,
    `  DM policy: ${l.policy}`,
    `  allowlisted: ${l.allowFrom.length ? l.allowFrom.join(', ') : 'nobody'}`,
    `  pending pairing codes: ${l.pending}`,
    ...(r.action === 'pair' && l.policy !== 'allowlist' ? ['Next: lock it down with `minions telegram access policy allowlist`, so strangers get no pairing codes.'] : []),
  ].join('\n');
}
