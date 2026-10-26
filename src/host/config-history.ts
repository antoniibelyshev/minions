// Config history and /undo (docs/design/host-manager.md, "Failure and rollback"; task-53.5.3).
//
// - Before the host manager writes a config change (a confirmed config-set, or an undo), it saves the layer file as
//   it is then: <project dir>/config-history/<requestId>.json (0600, directory 0700) with the key, the layer and file,
//   the effective from/to values, and the file text before. After the write it completes the entry with the file
//   text after. The last 20 entries are kept (oldest removed first).
// - The entry is named by the request id, not the configRevision: a local-layer write (config.local.json) does not
//   bump configRevision, so a revision cannot name it.
// - `/undo <id>` proposes restoring the file text before. It applies only while the file is still exactly what the
//   change wrote (compare-and-swap on the sha256 of the text after; for the shared layer the confirmation's
//   configRevision check comes on top). Otherwise the plan is refused with the drift and nothing is written.
// - The entry is a record, never trusted for where or what to write: the file is derived from the project and the
//   entry's layer (an entry naming another file, project or request is refused), and the undo plan lists every
//   setting the restore changes in that file, with the loosening check over all of them (undoDiff). Anything in the
//   file other than settings (configRevision of the shared layer aside) that would change refuses the undo.
// - A shared-layer restore keeps configRevision monotonic: the restored file gets the current revision + 1
//   (editProjectConfig). A local-layer restore removes config.local.json when it did not exist before.
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, ensureDir, readJsonIfExists, sha256, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import { editProjectConfig } from './config-write.js';
import { refreshDerived } from './install.js';
import { projectConfigPath, resolveEffective, type ProjectJson } from './project.js';
import type { MinionsConfig } from '../config/schema.js';
import {
  currentValue, formatValue, getPath, layerFile, settingDef, SETTINGS, takesEffectOf, type SettingClass, type SettingLayer, type SettingsContext, type TakesEffect,
} from './settings.js';

export const CONFIG_HISTORY_KEEP = 20;
export const configHistoryDir = (projectId: string) => join(projectPaths(projectId).dir, 'config-history');
const ID = /^(?:cr|ow)_[0-9a-f]{8}$/;
const entryPath = (projectId: string, requestId: string) => {
  if (!ID.test(requestId)) throw new MinionsError('PRECONDITION', `"${displayText(requestId)}" is not a change request id.`);
  return join(configHistoryDir(projectId), `${requestId}.json`);
};

const EntrySchema = z.object({
  version: z.literal(1), requestId: z.string(), projectId: z.string(), at: z.string(),
  key: z.string(), layer: z.enum(['local', 'shared']), file: z.string(),
  from: z.unknown(), to: z.unknown(),
  /** The layer file's text before the write (null: the file did not exist). */
  before: z.string().nullable(),
  /** The text after the write (null: the file does not exist after it, e.g. an undo that removed it). */
  after: z.string().nullable(),
  /** False until the write completed (a failed or interrupted write cannot be undone). */
  completed: z.boolean(),
}).strict();
export type HistoryEntry = z.infer<typeof EntrySchema>;

const readText = async (file: string): Promise<string | null> => {
  try { return await readFile(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

async function save(entry: HistoryEntry): Promise<void> {
  const dir = configHistoryDir(entry.projectId);
  await ensureDir(dir, 0o700);
  await writeJson(entryPath(entry.projectId, entry.requestId), entry, { mode: 0o600 });
}

async function prune(projectId: string): Promise<void> {
  const dir = configHistoryDir(projectId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json'));
  const dated: { name: string; at: string }[] = [];
  for (const name of names) {
    const v = await readJsonIfExists(join(dir, name), EntrySchema).catch(() => undefined);
    dated.push({ name, at: v?.at ?? '' });
  }
  dated.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.name.localeCompare(b.name)));
  for (const d of dated.slice(0, Math.max(0, dated.length - CONFIG_HISTORY_KEEP))) await rm(join(dir, d.name), { force: true });
}

export interface HistoryChange { key: string; layer: SettingLayer; file: string; from: unknown; to: unknown }

/** Saves the layer file as it is now, before the write of `requestId`. Returns the entry to complete afterwards. */
export async function beginHistory(project: ProjectJson, requestId: string, c: HistoryChange, now = new Date()): Promise<HistoryEntry> {
  const entry: HistoryEntry = {
    version: 1, requestId, projectId: project.projectId, at: now.toISOString(), key: c.key, layer: c.layer, file: c.file,
    from: c.from, to: c.to, before: await readText(c.file), after: null, completed: false,
  };
  await save(entry);
  await prune(project.projectId);
  return entry;
}

/** Records the file text after a successful write (the compare-and-swap value of a later /undo). */
export async function completeHistory(entry: HistoryEntry): Promise<void> {
  await save({ ...entry, after: await readText(entry.file), completed: true });
}

export async function loadHistory(projectId: string, requestId: string): Promise<HistoryEntry | null> {
  return (await readJsonIfExists(entryPath(projectId, requestId), EntrySchema)) ?? null;
}

/** The check of an undo: the entry, the layer file derived from the project (never the entry's own path), its text now. */
export interface UndoCheck { entry: HistoryEntry; file: string; current: string | null; expectSha256: string; restoreSha256: string }

/** The compare-and-swap value of a file text (null: the file does not exist). */
export const textSha = (t: string | null) => (t === null ? 'absent' : sha256(t));

/**
 * Checks that `requestId` can be undone now: it has a completed history entry, and its layer file is still exactly
 * the text that change wrote. Throws PRECONDITION with the drift otherwise (nothing to undo automatically).
 */
export async function checkUndo(project: ProjectJson, requestId: string): Promise<UndoCheck> {
  const entry = await loadHistory(project.projectId, requestId);
  if (!entry) {
    throw new MinionsError('PRECONDITION', `No config history for ${displayText(requestId)} in project ${project.projectId}: only config changes applied by the host manager are kept (the last ${CONFIG_HISTORY_KEEP}).`,
      'Change the setting back yourself with /set <key> <value>.');
  }
  if (!entry.completed) {
    throw new MinionsError('PRECONDITION', `${requestId} has no completed write in the config history (it failed or was interrupted); nothing to undo.`, 'Check the value with /status or `minions settings --list`.');
  }
  // The entry names its file, project and request, but none of that is trusted: the file is derived from the project.
  const file = layerFile(project, entry.layer);
  if (entry.requestId !== requestId || entry.projectId !== project.projectId || entry.file !== file) {
    throw new MinionsError('PRECONDITION', `The config history entry of ${displayText(requestId)} does not match this project (it names ${displayText(entry.file)}, request ${displayText(entry.requestId)}, project ${displayText(entry.projectId)}; expected ${file}). Nothing was changed.`,
      'Change the setting back yourself with /set <key> <value>.', { refusal: 'history-mismatch' });
  }
  const current = await readText(file);
  if (current !== entry.after) {
    const parse = (t: string | null) => { try { return t === null ? undefined : JSON.parse(t) as unknown; } catch { return undefined; } };
    const now = getPath(parse(current), entry.key);
    throw new MinionsError('PRECONDITION', [
      `Cannot undo ${requestId}: ${file} changed since ${requestId} wrote it, so restoring the old file would also revert the later edits. Nothing was changed.`,
      `drift: ${entry.key} in that file: ${requestId} wrote ${formatValue(getPath(parse(entry.after), entry.key))}, now ${current === null ? '(file removed)' : formatValue(now)}${current !== null && now === getPath(parse(entry.after), entry.key) ? ' (other keys changed)' : ''}.`,
    ].join('\n'), `Change ${entry.key} back yourself with /set ${entry.key} <value>.`, { refusal: 'drift' });
  }
  return { entry, file, current, expectSha256: textSha(current), restoreSha256: textSha(entry.before) };
}

/** One setting an undo changes: its effective value now and after the restore, and what that loosens. */
export interface UndoChange { key: string; from: unknown; to: unknown; class: SettingClass; takesEffect: TakesEffect | null; loosens: string | null }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** Removes a setting leaf from a raw layer object (never creates anything); empty parents are pruned afterwards. */
function dropPath(obj: Raw, key: string): void {
  const segs = key.startsWith('capabilities.') ? ['capabilities', key.slice('capabilities.'.length)] : key.split('.');
  let cur: unknown = obj;
  for (const k of segs.slice(0, -1)) {
    if (!isObj(cur)) return;
    cur = cur[k];
  }
  if (isObj(cur)) delete cur[segs.at(-1)!];
}
function pruneEmpty(v: unknown): unknown {
  if (!isObj(v)) return v;
  const out: Raw = {};
  for (const [k, x] of Object.entries(v)) {
    const p = pruneEmpty(x);
    if (!(isObj(p) && Object.keys(p).length === 0)) out[k] = p;
  }
  return out;
}
/** Leaf paths where two raw values differ (for the refusal text). */
function diffPaths(a: unknown, b: unknown, at = ''): string[] {
  if (isObj(a) && isObj(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((k) => diffPaths(a[k], b[k], at ? `${at}.${k}` : k));
  }
  return sameJson(a, b) ? [] : [at || '(the whole file)'];
}

const parseLayer = (t: string | null, what: string): Raw | undefined => {
  if (t === null) return undefined;
  let v: unknown;
  try { v = JSON.parse(t); } catch { throw new MinionsError('INVALID_CONFIG', `The ${what} does not parse; nothing to restore.`); }
  if (!isObj(v)) throw new MinionsError('INVALID_CONFIG', `The ${what} is not a JSON object; nothing to restore.`);
  return v;
};

const EFFECT_RANK: Record<string, number> = { now: 1, restart: 2, upgrade: 3 };

/**
 * Every setting the restore of `check` changes in its layer file (the file now versus the saved text before), with
 * the effective values now and after (`restored`, from validateRestore) and what each loosens. Refuses
 * (PRECONDITION, refusal 'history-mismatch') when anything else in the file would change (configRevision of the
 * shared layer aside, which moves forward anyway), when nothing would change, or when the entry's own key is not
 * among the changes: the entry was not written by that change.
 */
export function undoDiff(ctx: SettingsContext, check: UndoCheck, restored: MinionsConfig): UndoChange[] {
  const { entry, file } = check;
  const cur = parseLayer(check.current, `current ${file}`) ?? {};
  const before = parseLayer(entry.before, `saved text of ${file} in the config history`) ?? {};
  const roles = new Set([...Object.keys(isObj(cur.roles) ? cur.roles : {}), ...Object.keys(isObj(before.roles) ? before.roles : {})]);
  const keys = [...SETTINGS.map((d) => d.key), ...[...roles].map((r) => `roles.${r}.harness`)]
    .filter((k, i, all) => all.indexOf(k) === i)
    .filter((k) => { const d = settingDef(k); return !!d && d.type !== 'secret' && d.type !== 'control'; });
  const changes: UndoChange[] = [];
  for (const key of keys) {
    if (sameJson(getPath(cur, key), getPath(before, key))) continue;
    const def = settingDef(key)!;
    const from = currentValue(def, ctx);
    const to = currentValue(def, { ...ctx, config: restored });
    const moved = !sameJson(from, to);
    changes.push({ key, from, to, class: def.class, takesEffect: moved ? takesEffectOf(def.class) : null, loosens: moved && def.loosens ? def.loosens(from, to) : null });
  }
  const rest = (raw: Raw) => {
    const c = structuredClone(raw);
    for (const k of keys) dropPath(c, k);
    if (entry.layer === 'shared') delete c.configRevision;
    return pruneEmpty(c);
  };
  const other = diffPaths(rest(cur), rest(before));
  const refuse = (why: string) => new MinionsError('PRECONDITION', `Cannot undo ${entry.requestId}: ${why} Nothing was changed.`,
    `Change the setting back yourself with /set ${entry.key} <value>.`, { refusal: 'history-mismatch' });
  if (other.length) throw refuse(`restoring ${file} from the config history would also change ${other.map((p) => displayText(p)).join(', ')}, which /undo does not restore (not a setting).`);
  if (!changes.length) throw refuse(`restoring ${file} from the config history changes no setting.`);
  if (!changes.some((c) => c.key === entry.key)) {
    throw refuse(`the config history entry names ${displayText(entry.key)}, but restoring it would change ${changes.map((c) => c.key).join(', ')} instead.`);
  }
  // The entry's own key first, then the others in settings order.
  return [...changes.filter((c) => c.key === entry.key), ...changes.filter((c) => c.key !== entry.key)];
}

/** The most demanding takesEffect of the changes (upgrade > restart > now). */
export const strongestEffect = (changes: UndoChange[]): TakesEffect | null =>
  changes.reduce<TakesEffect | null>((m, c) => ((EFFECT_RANK[c.takesEffect ?? ''] ?? 0) > (EFFECT_RANK[m ?? ''] ?? 0) ? c.takesEffect : m), null);

/** Validates the restored file against the other layer (throws INVALID_CONFIG; nothing written); returns the effective config after it. */
export async function validateRestore(project: ProjectJson, entry: HistoryEntry): Promise<MinionsConfig> {
  const projectFile = projectConfigPath(project);
  const localFile = projectPaths(project.projectId).configLocalJson;
  const parse = (t: string | null, what: string): Record<string, unknown> | undefined => {
    if (t === null) return undefined;
    try { return JSON.parse(t) as Record<string, unknown>; } catch {
      throw new MinionsError('INVALID_CONFIG', `The saved ${what} in the config history does not parse; nothing to restore.`);
    }
  };
  const before = parse(entry.before, entry.layer === 'shared' ? projectFile : localFile);
  const projectRaw = entry.layer === 'shared' ? before ?? {} : (await readJsonIfExists<Record<string, unknown>>(projectFile)) ?? {};
  const localRaw = entry.layer === 'local' ? before : await readJsonIfExists<Record<string, unknown>>(localFile);
  return resolveEffective(project, projectRaw, localRaw, { project: projectFile, local: localFile }).config;
}

/**
 * Restores the file text before `requestId` (the undo of that change), as request `undoId`: compare-and-swap on
 * the sha256 of the current text, a history entry of its own (so an undo can be undone), derived files regenerated.
 * Returns refresh warnings.
 */
export async function applyUndo(project: ProjectJson, o: { target: string; expectSha256: string; restoreSha256: string; undoId: string; now?: Date }): Promise<{ entry: HistoryEntry; warnings: string[] }> {
  const { entry, file, expectSha256, restoreSha256 } = await checkUndo(project, o.target);
  if (expectSha256 !== o.expectSha256) {
    throw new MinionsError('CONFLICT', `Cannot undo ${o.target}: ${file} changed since the undo was planned; nothing written.`, 'Send /undo again for a fresh plan.', { refusal: 'drift' });
  }
  // The text written is the one the confirmed plan was computed from (the history entry may not change in between).
  if (restoreSha256 !== o.restoreSha256) {
    throw new MinionsError('CONFLICT', `Cannot undo ${o.target}: its config history entry changed since the undo was planned; nothing written.`, 'Send /undo again for a fresh plan.', { refusal: 'history-mismatch' });
  }
  await validateRestore(project, entry);
  const mine = await beginHistory(project, o.undoId, { key: entry.key, layer: entry.layer, file, from: entry.to, to: entry.from }, o.now);
  let warnings: string[];
  if (entry.layer === 'shared') {
    const before = JSON.parse(entry.before ?? '{}') as Record<string, unknown>;
    const cur = JSON.parse(entry.after!) as Record<string, unknown>;
    warnings = (await editProjectConfig(project, () => ({ ...before }), { expectRevision: Number(cur.configRevision ?? 1) })).warnings;
  } else {
    const projectFile = projectConfigPath(project);
    const projectRaw = (await readJsonIfExists<Record<string, unknown>>(projectFile)) ?? {};
    const localRaw = entry.before === null ? undefined : JSON.parse(entry.before) as Record<string, unknown>;
    const effective = resolveEffective(project, projectRaw, localRaw, { project: projectFile, local: file }).config;
    if (entry.before === null) await rm(file, { force: true });
    else await atomicWrite(file, entry.before, { mode: 0o600 });
    warnings = await refreshDerived(project, effective);
  }
  await completeHistory(mine);
  return { entry, warnings };
}
