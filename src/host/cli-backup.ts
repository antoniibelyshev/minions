// CLI backup (task-53.7).
//
// - Before `minions upgrade` replaces a packed global install with `npm install -g`, the current install directory is
//   archived as it is (a gzipped tar with every entry under `package/`, the layout `npm install -g <tgz>` reads) into
//   <MINIONS_HOME>/manager/cli-backup/minions-<version>-<UTC stamp>.tgz (0600, directory 0700). The last 2 are kept.
//   No npm runs for the backup: `npm pack <dir>` runs the package's `prepare` script for a directory even with
//   --ignore-scripts (npm 10.9: pacote's directory fetcher always prepares), and scripts/prepare.mjs is not shipped,
//   so that always failed. The archive keeps every file byte for byte (also the build fingerprint inputs); only
//   regular files and directories go in (symlinks and a top-level node_modules are left out, as npm pack does).
//   A backup that cannot be made stops the reinstall: nothing is installed then.
// - Rolling back is `npm install -g <backup>` (scripts/dev/self-update.mjs does it after a failed health check).
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { copyRegularFileNoFollow, ensureRealDir } from '../core/fsutil.js';
import { managerDir } from '../core/paths.js';

export const CLI_BACKUP_KEEP = 2;
export const cliBackupDir = () => join(managerDir(), 'cli-backup');
/** minions-<version>-<YYYYMMDDTHHMMSSmmmZ>.tgz: the only names the backup directory is read for. */
export const CLI_BACKUP_NAME = /^minions-([0-9A-Za-z][0-9A-Za-z.+-]{0,63})-(\d{8}T\d{9}Z)\.tgz$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export interface CliBackup { name: string; file: string; version: string; stamp: string }

const stampOf = (d: Date) => d.toISOString().replace(/[-:.]/g, '');

/** The backups, oldest first (by the stamp in the name). Files with other names are ignored. */
export async function listCliBackups(): Promise<CliBackup[]> {
  const dir = cliBackupDir();
  const out: CliBackup[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const m = CLI_BACKUP_NAME.exec(name);
    if (m) out.push({ name, file: join(dir, name), version: m[1]!, stamp: m[2]! });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.name.localeCompare(b.name)));
}

async function prune(): Promise<void> {
  const all = await listCliBackups();
  for (const b of all.slice(0, Math.max(0, all.length - CLI_BACKUP_KEEP))) await rm(b.file, { force: true });
}

const zeros = (n: number) => Buffer.alloc(n);
const pad = (size: number) => zeros((512 - (size % 512)) % 512);
type TarType = '0' | '5' | 'x';

/** One 512-byte ustar header; `name` must fit the 100-byte field (tarEntry adds a pax path record otherwise). */
function tarHeader(name: string, o: { size: number; mode: number; mtimeMs: number; type: TarType }): Buffer {
  const h = zeros(512);
  const oct = (v: number, at: number, len: number) => { h.write(v.toString(8).padStart(len - 1, '0'), at, len - 1, 'ascii'); };
  h.write(name, 0, 100, 'utf8');
  oct(o.mode & 0o7777, 100, 8);
  oct(0, 108, 8); // uid
  oct(0, 116, 8); // gid
  oct(o.size, 124, 12);
  oct(Math.max(0, Math.floor(o.mtimeMs / 1000)), 136, 12);
  h.fill(0x20, 148, 156); // the checksum counts as spaces while it is summed
  h.write(o.type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** The blocks of one member: a pax `path` record first when the name does not fit the 100-byte field. */
function tarEntry(name: string, o: { size: number; mode: number; mtimeMs: number; type: '0' | '5' }): Buffer[] {
  const out: Buffer[] = [];
  if (Buffer.byteLength(name) >= 100) {
    const body = (n: number) => `${n} path=${name}\n`;
    let len = Buffer.byteLength(body(0));
    while (Buffer.byteLength(body(len)) !== len) len = Buffer.byteLength(body(len));
    const rec = Buffer.from(body(len));
    out.push(tarHeader('PaxHeader', { size: rec.length, mode: 0o644, mtimeMs: o.mtimeMs, type: 'x' }), rec, pad(rec.length));
    name = Buffer.from(name).subarray(0, 99).toString('latin1');
  }
  out.push(tarHeader(name, o));
  return out;
}

/** The tar stream of `root` under `package/`: directories and regular files in sorted order, then the end blocks. */
async function* tarOf(root: string, skipped: string[]): AsyncGenerator<Buffer> {
  async function* walk(dir: string, rel: string): AsyncGenerator<Buffer> {
    for (const n of (await readdir(dir)).sort()) {
      const relName = rel ? `${rel}/${n}` : n;
      if (!rel && n === 'node_modules') { skipped.push(relName); continue; }
      const abs = join(dir, n);
      const st = await lstat(abs);
      if (st.isDirectory()) {
        yield* tarEntry(`package/${relName}/`, { size: 0, mode: st.mode, mtimeMs: st.mtimeMs, type: '5' });
        yield* walk(abs, relName);
      } else if (st.isFile()) {
        const data = await readFile(abs);
        yield* tarEntry(`package/${relName}`, { size: data.length, mode: st.mode, mtimeMs: st.mtimeMs, type: '0' });
        yield data;
        yield pad(data.length);
      } else skipped.push(relName);
    }
  }
  const st = await lstat(root);
  yield* tarEntry('package/', { size: 0, mode: st.mode, mtimeMs: st.mtimeMs, type: '5' });
  yield* walk(root, '');
  yield zeros(1024);
}

/**
 * Archives the global install at `installDir` (a gzipped tar under `package/`, written in a temp directory; no npm
 * and none of the package's scripts run) and keeps it in the backup directory (last 2). Throws when the directory is
 * not a package or the archive cannot be written: the caller must not install then.
 */
export async function backupInstalledCli(installDir: string, version: string | null, o: { now?: Date; log?: (m: string) => void } = {}): Promise<CliBackup> {
  const tmp = await mkdtemp(join(tmpdir(), 'minions-cli-backup-'));
  try {
    o.log?.(`cli: backing up the current CLI (archiving ${installDir})`);
    const root = await lstat(installDir).catch(() => null);
    if (!root?.isDirectory()) throw new MinionsError('INTERNAL', `the current CLI at ${displayText(installDir)} is not a directory.`);
    const pkg = await lstat(join(installDir, 'package.json')).catch(() => null);
    if (!pkg?.isFile()) throw new MinionsError('INTERNAL', `the current CLI at ${displayText(installDir)} has no package.json.`);
    const tgz = join(tmp, 'backup.tgz');
    const skipped: string[] = [];
    try {
      await pipeline(Readable.from(tarOf(installDir, skipped)), createGzip(), createWriteStream(tgz, { mode: 0o600 }));
    } catch (e) { throw new MinionsError('INTERNAL', `archiving the current CLI failed: ${displayText((e as Error).message).slice(0, 300)}`); }
    if (skipped.length) o.log?.(`cli: left out of the backup (node_modules, or not a regular file or directory): ${skipped.slice(0, 5).map((n) => displayText(n)).join(', ')}${skipped.length > 5 ? ', ...' : ''}`);
    const dir = cliBackupDir();
    await ensureRealDir(dir, 0o700);
    const v = version && SAFE_VERSION.test(version) ? version : 'unknown';
    const name = `minions-${v}-${stampOf(o.now ?? new Date())}.tgz`;
    await copyRegularFileNoFollow(tgz, join(dir, name), 0o600);
    await prune();
    o.log?.(`cli: kept the current CLI as ${join(dir, name)}`);
    return { name, file: join(dir, name), version: v, stamp: CLI_BACKUP_NAME.exec(name)![2]! };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
