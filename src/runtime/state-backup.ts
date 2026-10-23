// Runtime state backup and restore (`minions export --state` / `minions import --state` on the host,
// `minions workspace state-export` / `state-import` in the runtime). The archive is a gzip'd ustar
// tarball: `manifest.json` first (format, version, creation time, schema version, per-file size and
// sha256), then a consistent snapshot of the runtime DB (`VACUUM INTO`, never the live -wal/-shm
// files) and the regular files of an allowlist of state dirs. Secrets never live in the state dir;
// as defence in depth, symlinks, hard-linked files, secret-looking names and files that contain a
// mounted secret value are skipped (and listed in the manifest), never archived.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { matchesAny } from '../config/capabilities.js';
import { MinionsError } from '../core/errors.js';
import { VERSION } from '../core/version.js';
import { coordinatorPidAlive, type LockAlive } from './coordinator.js';
import type { CoordinatorLock, RuntimeDb } from './db.js';
import { openDb, SCHEMA_VERSION } from './db.js';
import type { RuntimePaths } from './paths.js';

export const STATE_BACKUP_FORMAT = 'minions-state-backup';
export const STATE_BACKUP_VERSION = 1;
export const MANIFEST_NAME = 'manifest.json';
export const DB_NAME = 'minions.db';
/** State dirs that are archived (recursively). import/exports/logs/cache/run/claude are never archived. */
export const STATE_BACKUP_DIRS = ['backlog', 'notes', 'briefs', 'results'] as const;
/** Top-level state files that are archived when present (the DB is archived as a snapshot, separately). */
export const STATE_BACKUP_FILES = ['coordinator-handoff.json'] as const;
/** Largest archive (and largest unpacked content) a restore reads. */
export const STATE_BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * minions' own secret file names: the mounted secrets (src/core/paths.ts `apiKeyFile`, `githubTokenFile`,
 * `telegramTokenFile`; src/host/credentials.ts `fileName`) and the host's approval signing key
 * (src/host/approvals.ts). A copy of one of them inside an archived dir is never archived.
 */
export const MINIONS_SECRET_FILE_NAMES = ['anthropic-api-key', 'github-token', 'telegram-bot-token', 'approval-signing-key'] as const;

/** File names that commonly hold secrets; never archived even inside an allowed dir. */
export const SECRET_NAME_PATTERNS = [
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa', '**/id_rsa.*', '**/id_ed25519', '**/id_ed25519.*',
  '**/id_ecdsa', '**/.npmrc', '**/.netrc', '**/credentials.json', '**/.credentials.json',
  ...MINIONS_SECRET_FILE_NAMES.map((n) => `**/${n}`),
];

export interface ManifestFile { path: string; size: number; sha256: string }
export interface StateManifest {
  format: typeof STATE_BACKUP_FORMAT;
  version: number;
  createdAt: string;
  minionsVersion: string;
  /** Runtime DB schema version of the snapshot. */
  schemaVersion: number;
  dirs: string[];
  files: ManifestFile[];
  /** Paths found in the state dir but not archived, with the reason (symlink, hard link, secret-like, ...). */
  skipped: { path: string; reason: string }[];
}

// ---------------------------------------------------------------------------------------------------
// Minimal ustar (POSIX.1-1988) writer/reader with PAX `path` records for long names. Only regular
// files ('0') and directories ('5') are written or accepted; every other entry type is refused.

const BLOCK = 512;

function octal(buf: Buffer, off: number, len: number, value: number): void {
  buf.write(value.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
}

function header(name: string, size: number, type: '0' | '5' | 'x', mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(' ', 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

const pad = (n: number) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, 'utf8');
}

export interface TarEntry { path: string; type: 'file' | 'dir'; data: Buffer; mode: number }

export function writeTar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const name = e.type === 'dir' ? `${e.path}/` : e.path;
    if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) {
      const pax = paxRecord('path', name);
      out.push(header(`PaxHeaders/${basename(e.path)}`.slice(0, 99), pax.length, 'x', 0o644, mtime), pax, pad(pax.length));
    }
    const size = e.type === 'dir' ? 0 : e.data.length;
    out.push(header(Buffer.byteLength(name) > 100 ? name.slice(0, 99) : name, size, e.type === 'dir' ? '5' : '0', e.mode, mtime));
    if (size) out.push(e.data, pad(size));
  }
  out.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(out);
}

const invalid = (why: string) => new MinionsError('PRECONDITION', `Not a valid minions state backup: ${why}.`,
  'Use an archive written by `minions export --state`; nothing was changed.');

function readOctal(h: Buffer, off: number, len: number, what: string): number {
  const s = h.subarray(off, off + len).toString('ascii').replace(/[\0 ]+$/g, '').trim();
  if (!/^[0-7]*$/.test(s)) throw invalid(`bad ${what} field in a tar header`);
  return s ? parseInt(s, 8) : 0;
}

export function readTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let off = 0;
  let paxPath: string | undefined;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) return entries;
    const stored = readOctal(h, 148, 8, 'checksum');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== stored) throw invalid('tar header checksum mismatch');
    const size = readOctal(h, 124, 12, 'size');
    const type = String.fromCharCode(h[156]!);
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const mode = readOctal(h, 100, 8, 'mode');
    off += BLOCK;
    if (off + size > buf.length) throw invalid('truncated tar entry');
    const data = buf.subarray(off, off + size);
    off += size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === 'x') {
      for (const m of data.toString('utf8').matchAll(/^\d+ ([^=\n]+)=([^\n]*)$/gm)) if (m[1] === 'path') paxPath = m[2];
      continue;
    }
    const name = paxPath ?? (prefix ? `${prefix}/${rawName}` : rawName);
    paxPath = undefined;
    if (type === '0' || type === '\0') entries.push({ path: name, type: 'file', data: Buffer.from(data), mode });
    else if (type === '5') entries.push({ path: name.replace(/\/+$/, ''), type: 'dir', data: Buffer.alloc(0), mode });
    else throw invalid(`entry ${JSON.stringify(name)} has unsupported type ${JSON.stringify(type)} (only regular files and directories are allowed)`);
  }
  throw invalid('missing end-of-archive marker');
}

// ---------------------------------------------------------------------------------------------------

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Whether `p` is a safe relative archive path inside the allowlist (no absolute path, `..`, `.` or empty segment). */
export function allowedArchivePath(p: string, type: 'file' | 'dir'): boolean {
  if (!p || p.includes('\0') || p.includes('\\') || p.startsWith('/')) return false;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (type === 'file' && segs.length === 1) return p === DB_NAME || p === MANIFEST_NAME || (STATE_BACKUP_FILES as readonly string[]).includes(p);
  return (STATE_BACKUP_DIRS as readonly string[]).includes(segs[0]!);
}

/** Secret values mounted for this runtime (files in the secrets dir); archived content must not contain any. */
async function secretValues(secretsDir: string): Promise<string[]> {
  const names = await readdir(secretsDir).catch(() => [] as string[]);
  const out: string[] = [];
  for (const n of names) {
    const f = join(secretsDir, n);
    const st = await lstat(f).catch(() => null);
    if (!st?.isFile() || st.size > 64 * 1024) continue;
    const v = (await readFile(f, 'utf8').catch(() => '')).trim();
    if (v.length >= 8) out.push(v);
  }
  return out;
}

export interface StateExportResult {
  path: string; bytes: number; sha256: string; createdAt: string; schemaVersion: number;
  files: number; skipped: StateManifest['skipped']; activeLeases: number;
}

/**
 * Writes a state backup of `paths.state` to `outFile` (created exclusively, 0600). The DB is
 * snapshotted with `VACUUM INTO`, which is transactionally consistent while other connections write.
 */
export async function createStateBackup(paths: Pick<RuntimePaths, 'state' | 'db' | 'secretsDir'>, outFile: string, opts: { now?: Date } = {}): Promise<StateExportResult> {
  const createdAt = (opts.now ?? new Date()).toISOString();
  const secrets = await secretValues(paths.secretsDir);
  const holdsSecret = (b: Buffer) => secrets.some((s) => b.includes(s));
  const skipped: StateManifest['skipped'] = [];
  const entries: TarEntry[] = [];
  const dirs: string[] = [];

  async function walk(rel: string): Promise<void> {
    const abs = join(paths.state, ...rel.split('/'));
    const st = await lstat(abs).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); return; }
    if (st.isDirectory()) {
      dirs.push(rel);
      entries.push({ path: rel, type: 'dir', data: Buffer.alloc(0), mode: st.mode & 0o777 });
      for (const n of (await readdir(abs)).sort()) await walk(`${rel}/${n}`);
      return;
    }
    if (!st.isFile()) { skipped.push({ path: rel, reason: 'not a regular file' }); return; }
    if (st.nlink > 1) { skipped.push({ path: rel, reason: 'hard link' }); return; }
    if (matchesAny(rel, SECRET_NAME_PATTERNS)) { skipped.push({ path: rel, reason: 'secret-like name' }); return; }
    const data = await readFile(abs);
    if (holdsSecret(data)) { skipped.push({ path: rel, reason: 'contains a mounted secret value' }); return; }
    entries.push({ path: rel, type: 'file', data, mode: st.mode & 0o666 });
  }
  for (const d of STATE_BACKUP_DIRS) await walk(d);
  for (const f of STATE_BACKUP_FILES) await walk(f);

  // Consistent DB snapshot. The temp dir sits next to the output (exports dir), never inside an archived dir.
  const tmp = await mkdtemp(join(dirname(outFile), '.state-snapshot-'));
  let schemaVersion: number;
  let activeLeases: number;
  let dbData: Buffer;
  try {
    const snap = join(tmp, DB_NAME);
    const db = openDb(paths.db);
    try {
      schemaVersion = Number(db.getMeta('schema_version') ?? SCHEMA_VERSION);
      activeLeases = db.activeLeases().length;
      db.sql.prepare('VACUUM INTO ?').run(snap);
    } finally { db.close(); }
    dbData = await readFile(snap);
  } finally { await rm(tmp, { recursive: true, force: true }); }
  if (holdsSecret(dbData)) {
    throw new MinionsError('PRECONDITION', 'The runtime database contains a mounted secret value; refusing to write a state backup.',
      'Find and remove the secret from the runtime state (it should never be stored there), then rerun.');
  }
  entries.unshift({ path: DB_NAME, type: 'file', data: dbData, mode: 0o644 });

  const files = entries.filter((e) => e.type === 'file').map((e) => ({ path: e.path, size: e.data.length, sha256: sha256(e.data) }));
  const manifest: StateManifest = {
    format: STATE_BACKUP_FORMAT, version: STATE_BACKUP_VERSION, createdAt, minionsVersion: VERSION, schemaVersion,
    dirs, files, skipped,
  };
  const mbuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const gz = gzipSync(writeTar([{ path: MANIFEST_NAME, type: 'file', data: mbuf, mode: 0o644 }, ...entries], Math.floor(Date.parse(createdAt) / 1000)));
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, gz, { flag: 'wx', mode: 0o600 });
  return { path: outFile, bytes: gz.length, sha256: sha256(gz), createdAt, schemaVersion, files: files.length, skipped, activeLeases };
}

export interface ParsedStateBackup { manifest: StateManifest; files: Map<string, TarEntry>; dirs: string[] }

/**
 * Parses and validates a state backup without touching any state: gzip, tar structure, entry types
 * and paths (allowlist only), the manifest (format, version, schema version), and every file's size
 * and sha256 against the manifest (no missing, extra or duplicate files).
 */
export function parseStateBackup(gz: Buffer): ParsedStateBackup {
  if (gz.length > STATE_BACKUP_MAX_BYTES) throw invalid('archive is larger than 1 GiB');
  let tar: Buffer;
  try { tar = gunzipSync(gz, { maxOutputLength: STATE_BACKUP_MAX_BYTES }); } catch (e) { throw invalid(`not a gzip archive (${(e as Error).message})`); }
  const entries = readTar(tar);
  const first = entries[0];
  if (!first || first.path !== MANIFEST_NAME || first.type !== 'file') throw invalid(`${MANIFEST_NAME} is not the first entry`);
  let m: StateManifest;
  try { m = JSON.parse(first.data.toString('utf8')) as StateManifest; } catch { throw invalid(`${MANIFEST_NAME} is not JSON`); }
  if (!m || typeof m !== 'object' || m.format !== STATE_BACKUP_FORMAT) throw invalid(`${MANIFEST_NAME} has the wrong format marker`);
  if (m.version !== STATE_BACKUP_VERSION) {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `State backup format version ${String(m.version)} is not supported (this build reads version ${STATE_BACKUP_VERSION}).`,
      'Restore it with the minions version that wrote it, or upgrade minions.');
  }
  if (!Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) throw invalid('missing schema version');
  if (m.schemaVersion > SCHEMA_VERSION) {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `State backup schema ${m.schemaVersion} is newer than this build supports (${SCHEMA_VERSION}).`,
      'Upgrade minions before restoring this backup.');
  }
  if (!Array.isArray(m.files) || !Array.isArray(m.dirs)) throw invalid('manifest file list missing');
  const files = new Map<string, TarEntry>();
  const dirs: string[] = [];
  for (const e of entries.slice(1)) {
    if (!allowedArchivePath(e.path, e.type) || e.path === MANIFEST_NAME) throw invalid(`entry ${JSON.stringify(e.path)} is outside the allowed state paths`);
    if (e.type === 'dir') { dirs.push(e.path); continue; }
    if (files.has(e.path)) throw invalid(`duplicate entry ${JSON.stringify(e.path)}`);
    files.set(e.path, e);
  }
  const listed = new Set<string>();
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || listed.has(f.path)) throw invalid('malformed or duplicate manifest file entry');
    listed.add(f.path);
    const e = files.get(f.path);
    if (!e) throw invalid(`${f.path} is listed in the manifest but missing from the archive`);
    if (e.data.length !== f.size || sha256(e.data) !== f.sha256) throw invalid(`${f.path} does not match its manifest checksum`);
  }
  for (const p of files.keys()) if (!listed.has(p)) throw invalid(`${p} is in the archive but not in the manifest`);
  if (!files.has(DB_NAME)) throw invalid(`the database snapshot ${DB_NAME} is missing`);
  if (files.get(DB_NAME)!.data.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw invalid(`${DB_NAME} is not an SQLite database`);
  return { manifest: m, files, dirs };
}

export interface StateImportResult {
  restored: { files: number; dirs: number; createdAt: string; schemaVersion: number; minionsVersion: string };
  /** Where the replaced state was moved (kept for manual recovery), or null when there was none. */
  previous: string | null;
  forced: boolean;
  warnings: string[];
  /** Leases the backup had marked active (no worker holds them in this runtime; the command layer releases them). */
  restoredActiveLeases: string[];
  /** Leases released after the restore (`minions workspace state-import`; absent from older runtimes). */
  releasedLeases?: string[];
  /** pid of the live coordinator whose lock row was carried into the restored DB, or null. */
  preservedLockPid: number | null;
  /** Older `pre-restore/<stamp>` dirs removed (the newest PRE_RESTORE_KEEP are kept). */
  pruned: string[];
}

/** Top-level state entries a restore replaces (the DB together with its WAL files). */
const REPLACED = [...STATE_BACKUP_DIRS, ...STATE_BACKUP_FILES, DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`];
/** How many `<state>/pre-restore/<stamp>/` copies of replaced state a restore keeps (newest first). */
export const PRE_RESTORE_KEEP = 3;
/** Release reason of the leases a restore brought back as active. */
export const RESTORE_RELEASE_REASON = 'state restore: the restored lease has no worker in this runtime';
/** What to run after a forced restore (host command; it runs `minions coordinator restart --recover`). */
export const RESTORE_RESTART_HINT = 'run `minions settings restart` (host) so the coordinator restarts with the recovery prompt and re-dispatches the released tasks';

const clashCodes = new Set(['EEXIST', 'ENOTDIR', 'EISDIR']);

/**
 * Restores a state backup into `paths.state`. Validates the whole archive first, refuses while a
 * worker lease is active or a live coordinator holds the project lock (unless `force`), stages the
 * files inside the state dir, checks the DB snapshot (opens, migrates, integrity_check), then swaps
 * the replaced entries out to `<state>/pre-restore/<stamp>/` and the staged ones in, and prunes all
 * but the newest PRE_RESTORE_KEEP pre-restore copies. The restored DB's coordinator lock row named a
 * process of the source runtime: it is replaced with the live coordinator's row when one holds the
 * lock (forced restore; so no second coordinator can start before the restart), else cleared.
 * Leases the backup had active are reported in `restoredActiveLeases`; `releaseRestoredLeases`
 * releases them (the command layer does so right after the restore).
 */
export async function restoreStateBackup(paths: Pick<RuntimePaths, 'state' | 'db'>, archive: string, opts: { force?: boolean; alive?: LockAlive; now?: Date } = {}): Promise<StateImportResult> {
  const st = await lstat(archive).catch(() => null);
  if (!st) throw new MinionsError('NOT_FOUND', `State backup not found: ${archive}`);
  if (!st.isFile()) throw new MinionsError('PRECONDITION', `${archive} is not a regular file; refusing to read it.`);
  const parsed = parseStateBackup(await readFile(archive));
  const warnings: string[] = [];
  let liveLock: CoordinatorLock | null = null;

  const live = await lstat(paths.db).catch(() => null);
  if (live) {
    const db = openDb(paths.db);
    try {
      const leases = db.activeLeases();
      const lock = db.coordinatorLock();
      const lockLive = !!lock && (opts.alive ?? coordinatorPidAlive)(lock.pid, lock);
      if (lockLive) liveLock = lock!;
      if (leases.length || lockLive) {
        const what = [...(leases.length ? [`${leases.length} active worker lease(s) (${leases.map((l) => l.id).join(', ')})`] : []),
          ...(lockLive ? [`a running coordinator (pid ${lock!.pid})`] : [])].join(' and ');
        if (!opts.force) {
          throw new MinionsError('CONFLICT', `Refusing to restore runtime state while it is in use: ${what}.`,
            `Let the workers finish (minions status) or cancel them (minions work cancel --all), then rerun; or run minions pause --starts first (a running coordinator could claim new leases) and pass --force (leases the backup has active are released) and then ${RESTORE_RESTART_HINT}.`,
            { activeLeases: leases.map((l) => l.id), coordinatorPid: lockLive ? lock!.pid : null });
        }
        warnings.push(`Restored over ${what} (--force). Workers still running lose their lease (their submit is refused; worktrees and branches are kept). Now ${RESTORE_RESTART_HINT}.`);
      }
    } finally { db.close(); }
  }

  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  await mkdir(paths.state, { recursive: true });
  const staging = await mkdtemp(join(paths.state, '.restore-staging-'));
  let previous: string | null = null;
  let restoredActiveLeases: string[] = [];
  try {
    let current = '';
    try {
      for (const d of new Set([...STATE_BACKUP_DIRS, ...parsed.dirs])) { current = d; await mkdir(join(staging, ...d.split('/')), { recursive: true }); }
      for (const [p, e] of parsed.files) {
        current = p;
        const dst = join(staging, ...p.split('/'));
        await mkdir(dirname(dst), { recursive: true });
        const mode = p === DB_NAME ? 0o644 : (e.mode & 0o666) || 0o644;
        await writeFile(dst, e.data, { flag: 'wx', mode });
      }
    } catch (err) {
      if (clashCodes.has((err as NodeJS.ErrnoException).code ?? '')) throw invalid(`entry ${JSON.stringify(current)} clashes with another entry (a file and a directory share a path)`);
      throw err;
    }
    // The snapshot must open, migrate to this build's schema and pass an integrity check.
    const sdb = (() => {
      try { return openDb(join(staging, DB_NAME)); } catch (err) { throw invalid(`the database snapshot does not open (${(err as Error).message})`); }
    })();
    try {
      const ok = sdb.get<{ integrity_check: string }>('PRAGMA integrity_check');
      if (ok?.integrity_check !== 'ok') throw invalid(`the database snapshot fails its integrity check (${ok?.integrity_check ?? 'no result'})`);
      if (liveLock) sdb.setMeta('coordinator_lock', JSON.stringify(liveLock));
      else sdb.deleteMeta('coordinator_lock');
      restoredActiveLeases = sdb.activeLeases().map((l) => l.id);
      sdb.addEvent('state-restore', null, { backupCreatedAt: parsed.manifest.createdAt, forced: !!opts.force, restoredActiveLeases, preservedLockPid: liveLock?.pid ?? null });
      sdb.sql.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { sdb.close(); }

    // Swap: move what is replaced aside, then move the staged entries in. On failure, undo.
    const present: string[] = [];
    for (const n of REPLACED) if (await lstat(join(paths.state, n)).catch(() => null)) present.push(n);
    if (present.length) {
      previous = join(paths.state, 'pre-restore', stamp);
      await mkdir(previous, { recursive: true });
    }
    const movedOut: string[] = [];
    const movedIn: string[] = [];
    try {
      for (const n of present) { await rename(join(paths.state, n), join(previous!, n)); movedOut.push(n); }
      for (const n of await readdir(staging)) { await rename(join(staging, n), join(paths.state, n)); movedIn.push(n); }
    } catch (err) {
      for (const n of movedIn) await rename(join(paths.state, n), join(staging, n)).catch(() => undefined);
      for (const n of movedOut) await rename(join(previous!, n), join(paths.state, n)).catch(() => undefined);
      // Everything moved back: drop the now empty stamp dir (rmdir refuses a non-empty one).
      if (previous) { await rmdir(previous).catch(() => undefined); await rmdir(dirname(previous)).catch(() => undefined); }
      throw new MinionsError('INTERNAL', `Restoring the runtime state failed while swapping files: ${(err as Error).message}`,
        previous ? `The previous state was moved back; anything left over is in ${previous}.` : undefined);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const pruned = await prunePreRestore(join(paths.state, 'pre-restore'), PRE_RESTORE_KEEP, previous);
  if (restoredActiveLeases.length) {
    warnings.push(`The backup has ${restoredActiveLeases.length} lease(s) marked active (${restoredActiveLeases.join(', ')}); no worker holds them in this runtime, so they are released.`);
  }
  const m = parsed.manifest;
  return {
    restored: { files: parsed.files.size, dirs: parsed.dirs.length, createdAt: m.createdAt, schemaVersion: m.schemaVersion, minionsVersion: m.minionsVersion },
    previous, forced: !!opts.force, warnings, restoredActiveLeases, preservedLockPid: liveLock?.pid ?? null, pruned,
  };
}

/** Removes empty `pre-restore/<stamp>` dirs and all but the newest `keep` others (stamps sort by time).
 * `protect` (the copy this restore just made) is never removed and counts as one of the kept. */
export async function prunePreRestore(dir: string, keep: number, protect: string | null = null): Promise<string[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  const removed: string[] = [];
  const kept: string[] = [];
  for (const n of names) {
    const p = join(dir, n);
    const st = await lstat(p).catch(() => null);
    if (!st?.isDirectory()) continue;
    if ((await readdir(p).catch(() => ['?'])).length === 0) { await rmdir(p).catch(() => undefined); removed.push(p); } else kept.push(p);
  }
  const others = kept.filter((p) => p !== protect);
  const room = Math.max(0, keep - (protect && kept.includes(protect) ? 1 : 0));
  for (const p of others.slice(0, Math.max(0, others.length - room))) {
    await rm(p, { recursive: true, force: true });
    removed.push(p);
  }
  return removed;
}

export interface RestoredLeaseRelease { released: string[]; failed: { leaseId: string; error: string }[] }

/**
 * Releases every lease the restored DB has active (task-20.1): no worker holds them in this runtime,
 * and `minions coordinator restart` refuses while any is active. `release` is the scheduler's release
 * (pre-claim backlog status, backlog note, hand-off files); a lease it fails on is ended directly in
 * the DB so the restart is never blocked by it.
 */
export async function releaseRestoredLeases(db: RuntimeDb, release: ((leaseId: string, reason: string) => Promise<unknown>) | null, reason = RESTORE_RELEASE_REASON): Promise<RestoredLeaseRelease> {
  const out: RestoredLeaseRelease = { released: [], failed: [] };
  for (const l of db.activeLeases()) {
    let err: Error | null = release ? null : new Error('the scheduler is unavailable');
    if (release) { try { await release(l.id, reason); } catch (e) { err = e as Error; } }
    if (err && db.lease(l.id)?.status === 'active') {
      db.transaction(() => {
        db.exec("UPDATE leases SET status = 'released', ended_at = ? WHERE id = ? AND status = 'active'", new Date().toISOString(), l.id);
        db.addEvent('release', l.task_id, { leaseId: l.id, status: 'released', reason, direct: true, error: err!.message });
      });
      out.failed.push({ leaseId: l.id, error: err.message });
    }
    out.released.push(l.id);
  }
  return out;
}

/** Archive name for a backup written at `now` (chosen by the host, never taken from runtime output). */
export const stateBackupName = (now = new Date()) => `state-${now.toISOString().replace(/[:.]/g, '-')}.tar.gz`;
