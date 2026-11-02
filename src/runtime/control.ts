// The control layer (docs/design/autonomy.md Decision 3): a config overlay the coordinator owns and changes itself,
// applied at once, without the owner. Safety comes from validation, the journal, undo and notices.
//
// - Storage: <state>/control/overlay.json ({revision, updatedAt, config}) and <state>/control/journal.jsonl (one line
//   per change, with the overlay before it, so undo restores a snapshot instead of inverting an operation).
// - Every change is validated by merging it onto the base config (the host-resolved runtime config) with the
//   same schema as any other layer; an invalid change is refused and nothing is written.
// - Writes are serialized by an O_EXCL lock file (stale after LOCK_STALE_MS) and atomic (temp + rename).
// - `unset` removes the overlay's key: the value falls back to the lower layers. There is no null-means-delete.
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyControl } from '../config/resolve.js';
import type { MinionsConfig } from '../config/schema.js';
import { classifyKey } from '../config/setting-classes.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite } from '../core/fsutil.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ControlOverlay { revision: number; updatedAt: string | null; config: Obj }
export type ControlOp = 'set' | 'unset' | 'apply' | 'undo';
export interface JournalEntry {
  revision: number; at: string; actor: string; reason: string; op: ControlOp;
  /** Dotted keys the change touched (for `apply` and `undo`: every leaf that differs). */
  keys: string[];
  /** The overlay config before the change (undo restores it). */
  before: Obj;
  /** `undo`: the revision it undid. */
  undid?: number;
}
/** When a changed key takes effect (from its setting class). */
export type AppliesOn = 'next-command' | 'next-stage' | 'coordinator-restart' | 'container-recreate' | 'setup';
export interface ControlChange {
  revision: number; op: ControlOp; keys: { key: string; appliesOn: AppliesOn; hostOwned: boolean }[];
  /** One line for the coordinator. */
  message: string;
}

export const controlDir = (state: string) => join(state, 'control');
export const overlayPath = (state: string) => join(controlDir(state), 'overlay.json');
export const journalPath = (state: string) => join(controlDir(state), 'journal.jsonl');
const lockPath = (state: string) => join(controlDir(state), 'lock');
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const MAX_REASON = 500;
const KEY = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

const EMPTY: ControlOverlay = { revision: 0, updatedAt: null, config: {} };

/** The overlay, or an empty one (revision 0) when none was written. A malformed file is an error, never ignored. */
export function readOverlay(state: string): ControlOverlay {
  let text: string;
  try { text = readFileSync(overlayPath(state), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
    throw e;
  }
  let v: unknown;
  try { v = JSON.parse(text); } catch {
    throw new MinionsError('INVALID_CONFIG', `The control overlay ${overlayPath(state)} is not valid JSON.`, 'Restore it with `minions control undo`, or remove the file.');
  }
  if (!isObj(v) || !Number.isInteger(v.revision) || !isObj(v.config)) {
    throw new MinionsError('INVALID_CONFIG', `The control overlay ${overlayPath(state)} is malformed.`, 'Restore it with `minions control undo`, or remove the file.');
  }
  return { revision: v.revision as number, updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null, config: v.config };
}

/** The base config with the overlay applied (undefined overlay config = the base itself). */
export function withControl(base: MinionsConfig, state: string): MinionsConfig {
  const o = readOverlay(state);
  return Object.keys(o.config).length ? applyControl(base, o.config) : base;
}

export function readJournal(state: string): JournalEntry[] {
  let text: string;
  try { text = readFileSync(journalPath(state), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  // Only entries with a revision and a snapshot are control changes (a torn or foreign line is skipped).
  return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as JournalEntry]; } catch { return []; } })
    .filter((e) => Number.isInteger(e.revision) && isObj(e.before));
}

// ---------------------------------------------------------------- pure helpers

export function parseKey(key: string): string[] {
  if (!KEY.test(key) || key.length > 200) throw new MinionsError('PRECONDITION', `Invalid config key "${key.slice(0, 80)}".`, 'Use a dotted path, e.g. workflows.default or roles.researcher.model.');
  const segs = key.split('.');
  // Capability names contain dots (capabilities.git.commit): the name is one key.
  return segs[0] === 'capabilities' && segs.length > 2 ? ['capabilities', segs.slice(1).join('.')] : segs;
}

/** A JSON value from the command line: JSON when it parses, else the plain string. */
export function parseValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export function setPath(o: Obj, segs: string[], v: unknown): Obj {
  const out = structuredClone(o);
  let cur = out;
  for (const k of segs.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Obj;
  }
  cur[segs.at(-1)!] = structuredClone(v);
  return out;
}

/** Removes a key and every object left empty above it. */
export function unsetPath(o: Obj, segs: string[]): Obj {
  const out = structuredClone(o);
  const chain: Obj[] = [out];
  for (const k of segs.slice(0, -1)) {
    const next = chain.at(-1)![k];
    if (!isObj(next)) return out;
    chain.push(next);
  }
  delete chain.at(-1)![segs.at(-1)!];
  for (let i = chain.length - 1; i > 0; i--) if (!Object.keys(chain[i]!).length) delete chain[i - 1]![segs[i - 1]!];
  return out;
}

/** Deep merge: objects merge, everything else (arrays included) replaces. */
export function mergeObj(base: Obj, layer: Obj): Obj {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(layer)) out[k] = isObj(v) && isObj(out[k]) ? mergeObj(out[k] as Obj, v) : structuredClone(v);
  return out;
}

/** Dotted leaf keys whose values differ between two overlays. */
export function changedKeys(a: Obj, b: Obj, prefix: string[] = []): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if ((isObj(x) || x === undefined) && (isObj(y) || y === undefined)) out.push(...changedKeys((x ?? {}) as Obj, (y ?? {}) as Obj, [...prefix, k]));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push([...prefix, k].join('.'));
  }
  return out;
}

const COORDINATOR_KEYS = ['coordinator', 'models.coordinator', 'models.effort', 'models.effortByRole.coordinator', 'models.router', 'communication', 'permissionMode'];

/**
 * When a key takes effect. Worker-facing restart-class settings (roles, workflows, models, turns, policy) apply to
 * the next stage: the dispatcher generates each worker's plugin from the current config. Coordinator launch and
 * prompt settings wait for its restart; compose settings for a container recreate.
 */
export function appliesOn(key: string): { appliesOn: AppliesOn; hostOwned: boolean } {
  const c = classifyKey(key);
  const hostOwned = c?.hostOwned ?? false;
  if (!c || c.class === 'live') return { appliesOn: 'next-command', hostOwned };
  if (c.class === 'recreate') return { appliesOn: 'container-recreate', hostOwned };
  if (c.class === 'fixed') return { appliesOn: 'setup', hostOwned };
  const coord = COORDINATOR_KEYS.some((k) => key === k || key.startsWith(k + '.'));
  return { appliesOn: coord ? 'coordinator-restart' : 'next-stage', hostOwned };
}

// ---------------------------------------------------------------- writes

/** Serializes control writes: waits up to LOCK_WAIT_MS for another change, takes over a lock older than LOCK_STALE_MS. */
async function withLock<T>(state: string, fn: () => Promise<T>): Promise<T> {
  const p = lockPath(state);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { closeSync(openSync(p, 'wx', 0o600)); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS; } catch { continue; }
      if (stale) { rmSync(p, { force: true }); continue; }
      if (Date.now() > deadline) throw new MinionsError('CONFLICT', 'Another control change is in progress.', 'Retry in a few seconds.');
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try { return await fn(); } finally { rmSync(p, { force: true }); }
}

export interface ControlDeps {
  state: string;
  /** The config below the overlay (the runtime config the host resolved). */
  base: MinionsConfig;
  actor?: string;
  /** The owner's own change (the Telegram gateway's `/budget`): may touch OWNER_ONLY_KEYS. */
  owner?: boolean;
  now?: () => Date;
}

/** Keys only the owner changes (docs/design/autonomy.md Decision 13): the coordinator never raises its own spend caps. */
export const OWNER_ONLY_KEYS = ['budgets', 'coordinator.sshHosts', 'coordinator.unsandboxedCommands', 'coordinator.allowedDomains'];
export const ownerOnlyKey = (key: string) => OWNER_ONLY_KEYS.some((k) => key === k || key.startsWith(k + '.'));

function checkReason(reason: string): string {
  const r = reason.trim();
  if (!r) throw new MinionsError('PRECONDITION', 'A reason is required.', 'Say why in --reason (it goes into the journal).');
  return r.slice(0, MAX_REASON);
}

/** Applies `change` to the overlay read inside the lock (two coordinator sessions never lose each other's change). */
async function commit(d: ControlDeps, op: ControlOp, reason: string, change: (cur: Obj) => Obj, extra: Partial<JournalEntry> = {}): Promise<ControlChange> {
  const why = checkReason(reason);
  await mkdir(controlDir(d.state), { recursive: true, mode: 0o700 });
  return withLock(d.state, async () => {
    const cur = readOverlay(d.state);
    const next = change(cur.config);
    const keys = changedKeys(cur.config, next);
    if (!keys.length) return { revision: cur.revision, op, keys: [], message: `No change (control revision ${cur.revision}).` };
    const owned = d.owner ? [] : keys.filter(ownerOnlyKey);
    if (owned.length) throw new MinionsError('POLICY_DENIED', `Only the owner changes ${owned.join(', ')}.`, 'The owner sets the spend caps with /budget in Telegram; leave them out of the change.');
    // Validate against the real base: an invalid overlay is never written.
    applyControl(d.base, next, `control ${op} (${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', ...' : ''})`);
    const at = (d.now ?? (() => new Date()))().toISOString();
    const revision = cur.revision + 1;
    const entry: JournalEntry = { revision, at, actor: d.actor ?? 'coordinator', reason: why, op, keys, before: cur.config, ...extra };
    await appendFile(journalPath(d.state), JSON.stringify(entry) + '\n', { mode: 0o600 });
    await atomicWrite(overlayPath(d.state), JSON.stringify({ revision, updatedAt: at, config: next }, null, 2) + '\n', { mode: 0o600 });
    const classified = keys.map((key) => ({ key, ...appliesOn(key) }));
    const when = [...new Set(classified.map((k) => k.appliesOn))].join(', ');
    return { revision, op, keys: classified, message: `Control revision ${revision}: ${op} ${keys.join(', ')} (applies: ${when}).` };
  });
}

export async function controlSet(d: ControlDeps, key: string, value: unknown, reason: string): Promise<ControlChange> {
  const segs = parseKey(key);
  return commit(d, 'set', reason, (cur) => setPath(cur, segs, value));
}

export async function controlUnset(d: ControlDeps, key: string, reason: string): Promise<ControlChange> {
  const segs = parseKey(key);
  return commit(d, 'unset', reason, (cur) => unsetPath(cur, segs));
}

/** Merges a partial config into the overlay in one change (e.g. a role and the workflow that uses it). */
export async function controlApply(d: ControlDeps, partial: unknown, reason: string): Promise<ControlChange> {
  if (!isObj(partial)) throw new MinionsError('PRECONDITION', 'The file must hold a JSON object (a partial config).');
  return commit(d, 'apply', reason, (cur) => mergeObj(cur, partial));
}

/**
 * Restores the overlay as it was before `revision` (default: the last change). It is a snapshot restore: the changes
 * made after that revision are reverted too (the response lists every key it changes).
 */
export async function controlUndo(d: ControlDeps, reason: string, revision?: number): Promise<ControlChange> {
  const journal = readJournal(d.state);
  const target = revision === undefined ? journal.at(-1) : journal.find((e) => e.revision === revision);
  if (!target) throw new MinionsError('NOT_FOUND', revision === undefined ? 'Nothing to undo.' : `No control revision ${revision}.`, 'See `minions control log`.');
  return commit(d, 'undo', reason, () => target.before, { undid: target.revision });
}

/** `minions control show`: the overlay, and the effective value of every key it sets. */
export function controlShow(d: Pick<ControlDeps, 'state' | 'base'>): { revision: number; updatedAt: string | null; overlay: Obj; effective: Record<string, unknown> } {
  const o = readOverlay(d.state);
  const eff = Object.keys(o.config).length ? applyControl(d.base, o.config) : d.base;
  const effective: Record<string, unknown> = {};
  for (const key of changedKeys({}, o.config)) {
    let cur: unknown = eff;
    for (const s of key.split('.')) cur = isObj(cur) ? cur[s] : undefined;
    effective[key] = cur;
  }
  return { revision: o.revision, updatedAt: o.updatedAt, overlay: o.config, effective };
}
