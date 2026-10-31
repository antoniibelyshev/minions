// Coordinator-stored secrets (docs/design/autonomy.md Decision 4): named values the coordinator puts into the
// project's secret store itself, and the dispatcher hands to the worker roles that declare them (`roles.<r>.secrets`).
//
// - Store: <state>/control/secrets/<NAME>, the dir 0700 and each file 0600, written atomically. NAME is an env-style
//   variable name (SECRET_NAME). The value comes from stdin only (never argv), is never printed or journaled; the
//   journal (<state>/control/journal.jsonl, shared with the control layer) records the name and a sha256 prefix.
// - Workers never read the store: the state dir is denied to them by the worker guards; the dispatcher reads the
//   declared values and sets them in that worker's env only.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SECRET_NAME } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite } from '../core/fsutil.js';
import { controlDir, journalPath } from './control.js';

export const MAX_SECRET_BYTES = 64 * 1024;
/** Names minions itself sets in a worker env: a stored secret may never shadow them. */
const RESERVED = /^(CLAUDE_|ANTHROPIC_|MINIONS_|TELEGRAM_|PATH$|HOME$|TMPDIR$|NODE_OPTIONS$|LD_|DYLD_)/;

export const secretsDir = (state: string) => join(controlDir(state), 'secrets');

export function checkSecretName(name: string): string {
  if (!SECRET_NAME.test(name)) throw new MinionsError('PRECONDITION', `Invalid secret name "${name.slice(0, 70)}".`, 'Use an env-style name: A-Z, 0-9 and _, starting with a letter (e.g. NPM_TOKEN).');
  if (RESERVED.test(name)) throw new MinionsError('PRECONDITION', `The secret name ${name} is reserved (minions sets it for workers).`, 'Choose another name.');
  return name;
}

const fingerprint = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 12);

async function journal(state: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(controlDir(state), { recursive: true, mode: 0o700 });
  await appendFile(journalPath(state), JSON.stringify({ revision: null, kind: 'secret', ...entry }) + '\n', { mode: 0o600 });
}

/** Stores a secret (replacing any value of that name); returns its fingerprint, never the value. */
export async function setSecret(state: string, name: string, value: string, o: { reason: string; actor?: string; now?: Date }): Promise<{ name: string; bytes: number; sha256: string; replaced: boolean }> {
  checkSecretName(name);
  const v = value.replace(/\r?\n$/, '');
  if (!v) throw new MinionsError('PRECONDITION', 'The secret is empty.', 'Pipe the value on stdin.');
  if (Buffer.byteLength(v) > MAX_SECRET_BYTES) throw new MinionsError('PRECONDITION', `The secret is larger than ${MAX_SECRET_BYTES} bytes.`);
  if (!o.reason.trim()) throw new MinionsError('PRECONDITION', 'A reason is required.', 'Say what the secret is for in --reason.');
  const dir = secretsDir(state);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  let replaced = false;
  try { statSync(file); replaced = true; } catch { /* new */ }
  await atomicWrite(file, v, { mode: 0o600 });
  const sha256 = fingerprint(v);
  await journal(state, { at: (o.now ?? new Date()).toISOString(), actor: o.actor ?? 'coordinator', reason: o.reason.trim().slice(0, 500), op: replaced ? 'secret-replace' : 'secret-set', keys: [name], sha256 });
  return { name, bytes: Buffer.byteLength(v), sha256, replaced };
}

export async function removeSecret(state: string, name: string, o: { reason: string; actor?: string; now?: Date }): Promise<{ name: string; removed: boolean }> {
  checkSecretName(name);
  const file = join(secretsDir(state), name);
  let removed = false;
  try { statSync(file); removed = true; } catch { /* absent */ }
  await rm(file, { force: true });
  if (removed) await journal(state, { at: (o.now ?? new Date()).toISOString(), actor: o.actor ?? 'coordinator', reason: o.reason.trim().slice(0, 500), op: 'secret-remove', keys: [name] });
  return { name, removed };
}

/** Names, sizes and set times (never values). */
export function listSecrets(state: string): { name: string; bytes: number; setAt: string }[] {
  let names: string[];
  try { names = readdirSync(secretsDir(state)); } catch { return []; }
  return names.filter((n) => SECRET_NAME.test(n)).sort().map((n) => {
    const st = statSync(join(secretsDir(state), n));
    return { name: n, bytes: st.size, setAt: st.mtime.toISOString() };
  });
}

/** The values of `names` for a worker env; a declared secret that is not stored is an error (the stage cannot run). */
export function secretEnv(state: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    checkSecretName(n);
    try { out[n] = readFileSync(join(secretsDir(state), n), 'utf8'); } catch {
      throw new MinionsError('PRECONDITION', `The role needs the secret ${n}, which is not stored.`, `Store it with \`minions secrets set ${n} --reason <why>\` (value on stdin), or ask the owner for it.`);
    }
  }
  return out;
}
