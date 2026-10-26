// CLI backup and roll back (docs/design/host-manager.md, "Failure and rollback", CLI reinstall; task-53.7).
//
// - Before `minions upgrade` replaces a packed global install with `npm install -g`, the current install is packed
//   (`npm pack <install dir> --ignore-scripts`, so none of its scripts run) into
//   <MINIONS_HOME>/manager/cli-backup/minions-<version>-<UTC stamp>.tgz (0600, directory 0700). The last 2 are kept.
//   A backup that cannot be made stops the reinstall: nothing is installed then.
// - After an upgrade that rebuilt or reinstalled the CLI, the host manager checks the new CLI with `minions --version`
//   and `minions --json status` in fresh processes. If either fails it offers "Roll back CLI": an owner request of
//   kind cli-rollback whose plan names the newest backup and its sha256. Only the owner's Confirm runs
//   `npm install -g <backup>` (refused if the file changed since the plan), and the check runs once more.
// - Nothing here runs a second strategy on its own: a failed rollback is reported, never retried.
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { copyRegularFileNoFollow, ensureRealDir, sha256File } from '../core/fsutil.js';
import { managerDir } from '../core/paths.js';
import type { Runner } from './docker.js';

export const CLI_BACKUP_KEEP = 2;
export const cliBackupDir = () => join(managerDir(), 'cli-backup');
/** minions-<version>-<YYYYMMDDTHHMMSSmmmZ>.tgz: the only names the backup directory is read for. */
export const CLI_BACKUP_NAME = /^minions-([0-9A-Za-z][0-9A-Za-z.+-]{0,63})-(\d{8}T\d{9}Z)\.tgz$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const NPM_TIMEOUT_MS = 1_800_000;

export interface CliBackup { name: string; file: string; version: string; stamp: string }

const stampOf = (d: Date) => d.toISOString().replace(/[-:.]/g, '');
const tail = (r: RunResult) => displayText((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')).slice(0, 300);

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

/** The backup with this name, as a regular file in the backup directory (never a symlink); null when there is none. */
export async function findCliBackup(name: string): Promise<CliBackup | null> {
  const m = CLI_BACKUP_NAME.exec(name);
  if (!m) return null;
  const file = join(cliBackupDir(), name);
  try {
    const st = await lstat(file);
    if (!st.isFile()) return null;
  } catch { return null; }
  return { name, file, version: m[1]!, stamp: m[2]! };
}

async function prune(): Promise<void> {
  const all = await listCliBackups();
  for (const b of all.slice(0, Math.max(0, all.length - CLI_BACKUP_KEEP))) await rm(b.file, { force: true });
}

/**
 * Packs the global install at `installDir` (`npm pack <dir> --ignore-scripts` in a temp directory) and keeps the
 * tarball in the backup directory (last 2). Throws when no tarball comes out: the caller must not install then.
 */
export async function backupInstalledCli(installDir: string, version: string | null, o: { runner?: Runner; env?: NodeJS.ProcessEnv; now?: Date; log?: (m: string) => void } = {}): Promise<CliBackup> {
  const runner = o.runner ?? run;
  const tmp = await mkdtemp(join(tmpdir(), 'minions-cli-backup-'));
  try {
    o.log?.(`cli: backing up the current CLI (npm pack ${installDir})`);
    const r = await runner('npm', ['pack', installDir, '--pack-destination', tmp, '--ignore-scripts'], { cwd: tmp, env: o.env, allowFailure: true, timeoutMs: NPM_TIMEOUT_MS });
    if (r.code !== 0) throw new MinionsError('INTERNAL', `npm pack of the current CLI failed: ${tail(r)}`);
    const tgz = (await readdir(tmp)).filter((n) => n.endsWith('.tgz'));
    if (tgz.length !== 1) throw new MinionsError('INTERNAL', `npm pack of the current CLI produced ${tgz.length} tarballs, expected 1.`);
    const dir = cliBackupDir();
    await ensureRealDir(dir, 0o700);
    const v = version && SAFE_VERSION.test(version) ? version : 'unknown';
    const name = `minions-${v}-${stampOf(o.now ?? new Date())}.tgz`;
    await copyRegularFileNoFollow(join(tmp, tgz[0]!), join(dir, name), 0o600);
    await prune();
    o.log?.(`cli: kept the current CLI as ${join(dir, name)}`);
    return { name, file: join(dir, name), version: v, stamp: CLI_BACKUP_NAME.exec(name)![2]! };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

export interface CliHealth { ok: boolean; detail: string }

/**
 * Checks the host CLI in fresh processes: `minions --version` (exit 0, a version line) and `minions --json status`
 * (an ok envelope). `cli(argv)` runs the host CLI with exactly these arguments.
 */
export async function checkCliHealth(cli: (argv: string[]) => Promise<RunResult>): Promise<CliHealth> {
  const problems: string[] = [];
  let version = '';
  try {
    const v = await cli(['--version']);
    version = v.stdout.trim().split('\n').at(-1)?.trim() ?? '';
    if (v.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) problems.push(`\`minions --version\` failed (exit ${v.code})${tail(v) ? `: ${tail(v)}` : ''}`);
  } catch (e) { problems.push(`\`minions --version\` failed: ${displayText((e as Error).message).slice(0, 300)}`); }
  try {
    const s = await cli(['--json', 'status']);
    let env: { ok?: unknown; error?: { message?: unknown } } | null = null;
    try { env = JSON.parse(s.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { env = null; }
    if (!env || env.ok !== true) {
      problems.push(`\`minions status\` failed (exit ${s.code})${env?.error?.message ? `: ${displayText(String(env.error.message)).slice(0, 300)}` : tail(s) ? `: ${tail(s)}` : ''}`);
    }
  } catch (e) { problems.push(`\`minions status\` failed: ${displayText((e as Error).message).slice(0, 300)}`); }
  return problems.length ? { ok: false, detail: problems.join('; ') } : { ok: true, detail: `minions ${displayText(version)} answers --version and status` };
}

/**
 * Reinstalls a backup: refused (nothing installed) unless the file still has `expectSha256`. Then
 * `npm install -g --no-audit --no-fund <backup>` from the backup directory.
 */
export async function installCliBackup(name: string, expectSha256: string, o: { runner?: Runner; log?: (m: string) => void } = {}): Promise<string> {
  const b = await findCliBackup(name);
  if (!b) throw new MinionsError('PRECONDITION', `The CLI backup ${displayText(name)} is gone; nothing was installed.`);
  const sha = await sha256File(b.file);
  if (sha !== expectSha256) {
    throw new MinionsError('CONFLICT', `The CLI backup ${b.name} changed since the plan was shown (sha256 ${sha.slice(0, 12)}, expected ${expectSha256.slice(0, 12)}); nothing was installed.`, undefined, { refusal: 'backup' });
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MINIONS_BUILD_KIND;
  o.log?.(`cli: npm install -g ${b.file}`);
  const r = await (o.runner ?? run)('npm', ['install', '-g', '--no-audit', '--no-fund', b.file], { cwd: cliBackupDir(), env, allowFailure: true, timeoutMs: NPM_TIMEOUT_MS });
  if (r.code !== 0) throw new MinionsError('INTERNAL', `npm install -g of the backup failed: ${tail(r)}`);
  return `reinstalled minions ${b.version} from ${b.file}`;
}
