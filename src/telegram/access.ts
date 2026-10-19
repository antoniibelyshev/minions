// Read-only view of the official Telegram plugin's access policy (`<state dir>/access.json`,
// schema documented in the plugin's ACCESS.md). minions never writes this file, never prints
// pending pairing codes or sender ids, and never reads the plugin's .env. Pairing itself is owned
// by the plugin; this module only reports whether the policy matches what minions requires:
// DM policy `allowlist`, exactly one allowlisted sender (the owner), and no groups.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AccessState = 'ok' | 'unpaired' | 'open' | 'invalid';
export interface TelegramAccessStatus {
  state: AccessState;
  /** dmPolicy from access.json (`pairing` is the plugin default when the file is absent). */
  policy: string | null;
  allowlisted: number;
  groups: number;
  detail: string;
  hint?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);
const count = (v: unknown) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : 0);

const PAIR_HINT = 'DM the bot, then type `/telegram:access pair <code>` in the coordinator terminal (not over Telegram), then `/telegram:access policy allowlist`.';

/** Pure evaluation of a parsed access.json (null = file absent). */
export function evaluateAccess(raw: unknown | null): TelegramAccessStatus {
  if (raw === null) {
    return { state: 'unpaired', policy: null, allowlisted: 0, groups: 0, detail: 'not paired yet (no access.json); nobody can control the coordinator over Telegram', hint: PAIR_HINT };
  }
  if (!isObj(raw)) return { state: 'invalid', policy: null, allowlisted: 0, groups: 0, detail: 'access.json is not a JSON object', hint: 'Re-pair from the coordinator terminal with /telegram:access.' };
  const policy = typeof raw.dmPolicy === 'string' ? raw.dmPolicy : 'pairing';
  const allowlisted = ids(raw.allowFrom).length;
  const groups = count(raw.groups);
  const base = { policy, allowlisted, groups };
  if (policy === 'disabled') return { ...base, state: 'unpaired', detail: 'DM policy is disabled; Telegram messages are ignored', hint: PAIR_HINT };
  if (allowlisted === 0) return { ...base, state: 'unpaired', detail: `not paired yet (policy ${policy}, no allowlisted sender)`, hint: PAIR_HINT };
  const problems: string[] = [];
  if (policy !== 'allowlist') problems.push(`DM policy is ${policy}: strangers can still request pairing codes (they cannot control the coordinator)`);
  if (allowlisted > 1) problems.push(`${allowlisted} senders are allowlisted; each can control the coordinator and approve tool-permission prompts`);
  if (groups > 0) problems.push(`${groups} group(s) are enabled; group members can reach the coordinator`);
  if (problems.length) {
    return { ...base, state: 'open', detail: problems.join('; '),
      hint: 'In the coordinator terminal: `/telegram:access policy allowlist`, and remove every sender and group except yourself.' };
  }
  return { ...base, state: 'ok', detail: 'paired with one owner; DM policy allowlist; unpaired senders are dropped' };
}

/**
 * The plugin's documented inbound gate for direct messages, as minions relies on it: only a sender
 * listed in `allowFrom` reaches the coordinator; everyone else is dropped (under `pairing` they only
 * receive a pairing code from the plugin itself). Used by tests and status; never by the transport.
 */
export function senderCanControl(raw: unknown | null, senderId: string | number): boolean {
  if (!isObj(raw)) return false;
  if (raw.dmPolicy === 'disabled') return false;
  return ids(raw.allowFrom).includes(String(senderId));
}

/** Reads `<stateDir>/access.json` (read-only). */
export async function readTelegramAccess(stateDir: string, readText: (p: string) => Promise<string> = (p) => readFile(p, 'utf8')): Promise<TelegramAccessStatus> {
  let text: string;
  try { text = await readText(join(stateDir, 'access.json')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return evaluateAccess(null);
    return { state: 'invalid', policy: null, allowlisted: 0, groups: 0, detail: `access.json unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  try { return evaluateAccess(JSON.parse(text) as unknown); } catch {
    return { state: 'invalid', policy: null, allowlisted: 0, groups: 0, detail: 'access.json is not valid JSON', hint: 'Re-pair from the coordinator terminal with /telegram:access.' };
  }
}
