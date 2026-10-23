// Explicit repository transfer between host and container via Git bundles (spec §3A "Repository access").
// Import copies committed history of the base branch only; export fetches agent branches into
// refs/remotes/minions/* on the host (never touches local branches or the working tree).
import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { matchesAny } from '../config/capabilities.js';
import { MinionsError } from '../core/errors.js';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { ensureDir } from '../core/fsutil.js';
import { CONTAINER, SERVICE_NAME, projectPaths } from '../core/paths.js';
import { HOST_GIT } from './discovery.js';
import { Compose, type Runner } from './docker.js';
import { parseStateBackup, stateBackupName, type StateExportResult, type StateImportResult, type StateManifest } from '../runtime/state-backup.js';
import type { ProjectJson } from './project.js';

/** Tracked paths that commonly hold secrets. Detection is best effort, never complete. */
export const SECRET_FILE_PATTERNS = [
  '**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.keystore', '**/*.jks',
  '**/id_rsa', '**/id_rsa.*', '**/id_dsa', '**/id_ecdsa', '**/id_ed25519', '**/id_ed25519.*',
  '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials.json', '**/service-account*.json', '**/*.tfstate',
];
const SAFE_SUFFIXES = ['.env.example', '.env.sample', '.env.template', '.pub'];

export function secretLikePaths(tracked: string[]): string[] {
  return tracked.filter((p) => matchesAny(p, SECRET_FILE_PATTERNS) && !SAFE_SUFFIXES.some((s) => p.endsWith(s)));
}

/**
 * Where bundles go and how runtime commands run: the container (docker compose cp/exec) or the host
 * runtime (<project>/host/state/{import,exports}, the `minions` shim). Remote paths are runtime paths.
 */
export interface TransferTarget {
  dirs: { import: string; exports: string };
  /** True when `dirs` are paths on the host filesystem (host runtime); false for container paths. */
  hostFs?: boolean;
  exec(args: string[], opts?: RunOptions): Promise<RunResult>;
  putFile(local: string, remote: string): Promise<void>;
  getFile(remote: string, local: string): Promise<void>;
  /** Best-effort removal of a runtime transfer file (a state archive copy once it was fetched or restored). */
  removeFile?(remote: string): Promise<void>;
}

/** Removes a transfer copy in the runtime; a failure leaves only a stale file, never fails the command. */
const discard = async (target: TransferTarget, remote: string) => { await target.removeFile?.(remote).catch(() => undefined); };

export function composeTarget(compose: Compose): TransferTarget {
  return {
    dirs: { import: CONTAINER.import, exports: CONTAINER.exports },
    exec: (args, opts) => compose.exec(args, opts),
    putFile: (local, remote) => compose.cp(local, `${SERVICE_NAME}:${remote}`),
    getFile: (remote, local) => compose.cp(`${SERVICE_NAME}:${remote}`, local),
    removeFile: async (remote) => { await compose.exec(['rm', '-f', '--', remote], { allowFailure: true, timeoutMs: 30_000 }); },
  };
}

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string; hint?: string; details?: unknown } }
/** Data of the last `{ok,data}` JSON line printed by a container-side `minions … --json` command. */
export function parseEnvelope<T>(stdout: string, what: string): T {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  let env: Envelope<T>;
  try { env = JSON.parse(line) as Envelope<T>; } catch {
    throw new MinionsError('INTERNAL', `${what}: unexpected output from the container.`, undefined, { stdout: stdout.slice(-500) });
  }
  if (!env.ok) throw new MinionsError('INTERNAL', `${what} failed in the container: ${env.error?.message ?? 'unknown error'}`, env.error?.hint, env.error);
  return env.data as T;
}

export interface ImportResult { bundle: string; commit: string; baseBranch: string; warnings: string[]; container: { head?: string; base?: string; imported?: boolean; origin?: { url: string; authenticated: boolean; fetched: boolean; warnings: string[] } } }

export async function importRepo(project: ProjectJson, opts: { runner?: Runner; repoPath?: string; compose?: Compose; target?: TransferTarget } = {}): Promise<ImportResult> {
  const runner = opts.runner ?? run;
  const repo = opts.repoPath ?? project.repoPath;
  const target = opts.target ?? composeTarget(opts.compose ?? new Compose(project.projectId, runner));
  const git = (args: string[], allowFailure = false) => runner('git', [...HOST_GIT, ...args], { cwd: repo, allowFailure, timeoutMs: 300_000 });
  const base = project.baseBranch;

  const ref = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`], true);
  if (ref.code !== 0) {
    throw new MinionsError('PRECONDITION', `Base branch "${base}" does not exist locally in ${repo}.`,
      `Create or fetch it (e.g. \`git fetch origin ${base}:${base}\`), or change git.baseBranch in the configuration.`);
  }
  const commit = ref.stdout.trim();
  const warnings: string[] = [];
  const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'], true)).stdout.split('\n').filter(Boolean);
  const modified = status.filter((l) => !l.startsWith('??'));
  const untracked = status.filter((l) => l.startsWith('??'));
  if (modified.length) warnings.push(`${modified.length} uncommitted change(s) in the working tree are NOT imported (only committed history of ${base}).`);
  if (untracked.length) warnings.push(`${untracked.length} untracked file(s) are NOT imported.`);
  warnings.push('Ignored files (e.g. .env) are never imported.');
  const tracked = (await git(['ls-tree', '-r', '--name-only', '-z', commit], true)).stdout.split('\0').filter(Boolean);
  const secrets = secretLikePaths(tracked);
  if (secrets.length) {
    warnings.push(`Tracked files that may contain secrets are part of the committed history and WILL be imported: ${secrets.slice(0, 20).join(', ')}${secrets.length > 20 ? ' …' : ''}. Detection is not complete.`);
  }

  const tmp = await mkdtemp(join(tmpdir(), 'minions-import-'));
  const file = `import-${commit.slice(0, 12)}.bundle`;
  const bundle = join(tmp, file);
  try {
    await git(['bundle', 'create', bundle, `refs/heads/${base}`]);
    await target.putFile(bundle, `${target.dirs.import}/${file}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const args = ['minions', 'workspace', 'import', `${target.dirs.import}/${file}`, '--base', base];
  if (project.remoteUrl) args.push('--remote-url', project.remoteUrl);
  args.push('--json');
  const r = await target.exec(args, { allowFailure: true, timeoutMs: 600_000 });
  const data = parseEnvelope<ImportResult['container']>(r.stdout, 'workspace import');
  return { bundle: file, commit, baseBranch: base, warnings, container: data ?? {} };
}

export interface ExportResult { bundle: string; refs: string[]; changes: { ref: string; from: string | null; to: string | null }[] }

async function minionsRefs(runner: Runner, repo: string): Promise<Map<string, string>> {
  const r = await runner('git', [...HOST_GIT, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/minions/'], { cwd: repo, allowFailure: true });
  return new Map(r.stdout.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]));
}

export async function exportRepo(project: ProjectJson, opts: { runner?: Runner; repoPath?: string; compose?: Compose; target?: TransferTarget } = {}): Promise<ExportResult> {
  const runner = opts.runner ?? run;
  const repo = opts.repoPath ?? project.repoPath;
  const target = opts.target ?? composeTarget(opts.compose ?? new Compose(project.projectId, runner));
  const file = `export-${new Date().toISOString().replace(/[:.]/g, '-')}.bundle`;
  const r = await target.exec(['minions', 'workspace', 'export', `${target.dirs.exports}/${file}`, '--json'], { allowFailure: true, timeoutMs: 600_000 });
  const data = parseEnvelope<{ path: string; refs: string[] }>(r.stdout, 'workspace export');
  const exportsDir = projectPaths(project.projectId).exportsDir;
  await ensureDir(exportsDir);
  // The bundle name is chosen here, never taken from container output; the copied file must be a
  // regular file (an agent could swap it for a symlink or directory inside the container).
  const local = join(exportsDir, file);
  // Host runtime: refuse a non-regular bundle before copying it (copyFile follows symlinks).
  if (target.hostFs) {
    const src = await lstat(`${target.dirs.exports}/${file}`).catch(() => null);
    if (!src?.isFile()) throw new MinionsError('PRECONDITION', 'The exported bundle is not a regular file; refusing to fetch it.', `Inspect ${target.dirs.exports}.`);
  }
  await target.getFile(`${target.dirs.exports}/${file}`, local);
  const st = await lstat(local).catch(() => null);
  if (!st?.isFile()) {
    await rm(local, { recursive: true, force: true });
    throw new MinionsError('PRECONDITION', 'The exported bundle is not a regular file; refusing to fetch it.', `Inspect ${target.dirs.exports} in the runtime.`);
  }
  const before = await minionsRefs(runner, repo);
  // Remote-tracking refs under refs/remotes/minions/ are minions-owned; forced updates there never touch local branches.
  await runner('git', [...HOST_GIT, 'fetch', '--no-tags', '--no-recurse-submodules', '--prune', local, '+refs/heads/*:refs/remotes/minions/*'], { cwd: repo, timeoutMs: 300_000 });
  const after = await minionsRefs(runner, repo);
  const changes: ExportResult['changes'] = [];
  for (const ref of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(ref) ?? null, to = after.get(ref) ?? null;
    if (from !== to) changes.push({ ref, from, to });
  }
  return { bundle: local, refs: data.refs ?? [], changes: changes.sort((a, b) => a.ref.localeCompare(b.ref)) };
}

export interface StateExportHostResult {
  archive: string; bytes: number; sha256: string; createdAt: string; schemaVersion: number; files: number;
  skipped: StateManifest['skipped']; activeLeases: number;
}

/**
 * State backup (`minions export --state [file]`): the runtime writes the archive into its exports dir
 * (`minions workspace state-export`), the host copies it out (regular file only) to `out` (default
 * <project>/exports/state-<time>.tar.gz; never overwritten) and validates it before reporting success.
 */
export async function exportState(project: ProjectJson, opts: { out?: string; runner?: Runner; compose?: Compose; target?: TransferTarget; now?: Date } = {}): Promise<StateExportHostResult> {
  const runner = opts.runner ?? run;
  const target = opts.target ?? composeTarget(opts.compose ?? new Compose(project.projectId, runner));
  const file = stateBackupName(opts.now);
  const local = opts.out ? resolvePath(opts.out) : join(projectPaths(project.projectId).exportsDir, file);
  if (await lstat(local).catch(() => null)) throw new MinionsError('CONFLICT', `${local} already exists; refusing to overwrite it.`, 'Choose another file name or remove it.');
  const remote = `${target.dirs.exports}/${file}`;
  try {
    return await fetchStateBackup(target, remote, local);
  } finally { await discard(target, remote); }
}

async function fetchStateBackup(target: TransferTarget, remote: string, local: string): Promise<StateExportHostResult> {
  const r = await target.exec(['minions', 'workspace', 'state-export', remote, '--json'], { allowFailure: true, timeoutMs: 600_000 });
  const data = parseEnvelope<StateExportResult>(r.stdout, 'workspace state-export');
  await ensureDir(dirname(local));
  if (target.hostFs) {
    const src = await lstat(remote).catch(() => null);
    if (!src?.isFile()) throw new MinionsError('PRECONDITION', 'The state backup is not a regular file; refusing to fetch it.', `Inspect ${target.dirs.exports}.`);
  }
  await target.getFile(remote, local);
  const st = await lstat(local).catch(() => null);
  if (!st?.isFile()) {
    await rm(local, { recursive: true, force: true });
    throw new MinionsError('PRECONDITION', 'The state backup is not a regular file; refusing to fetch it.', `Inspect ${target.dirs.exports} in the runtime.`);
  }
  await chmod(local, 0o600);
  // Validate the copy (structure, manifest, checksums) so a reported backup is a restorable one.
  try { parseStateBackup(await readFile(local)); } catch (e) { await rm(local, { force: true }); throw e; }
  return { archive: local, bytes: st.size, sha256: data.sha256, createdAt: data.createdAt, schemaVersion: data.schemaVersion, files: data.files, skipped: data.skipped ?? [], activeLeases: data.activeLeases ?? 0 };
}

/** Reads and validates a state backup on the host (no runtime state is touched). */
export async function inspectStateBackup(file: string): Promise<{ archive: string; manifest: StateManifest }> {
  const path = resolvePath(file);
  const st = await lstat(path).catch(() => null);
  if (!st) throw new MinionsError('NOT_FOUND', `State backup not found: ${path}`);
  if (!st.isFile()) throw new MinionsError('PRECONDITION', `${path} is not a regular file; refusing to read it.`);
  return { archive: path, manifest: parseStateBackup(await readFile(path)).manifest };
}

export interface StateImportHostResult { archive: string; createdAt: string; schemaVersion: number; files: number; container: StateImportResult }

/**
 * State restore (`minions import --state <file> [--force]`): the archive is validated on the host
 * first (nothing is copied when it is invalid), copied into the runtime import dir, and restored by
 * `minions workspace state-import`, which validates again and refuses while the runtime is in use.
 */
export async function importState(project: ProjectJson, file: string, opts: { force?: boolean; runner?: Runner; compose?: Compose; target?: TransferTarget; now?: Date } = {}): Promise<StateImportHostResult> {
  const { archive, manifest } = await inspectStateBackup(file);
  const runner = opts.runner ?? run;
  const target = opts.target ?? composeTarget(opts.compose ?? new Compose(project.projectId, runner));
  const name = `import-${stateBackupName(opts.now)}`;
  const remote = `${target.dirs.import}/${name}`;
  let data: StateImportResult;
  try {
    await target.putFile(archive, remote);
    const r = await target.exec(['minions', 'workspace', 'state-import', remote, ...(opts.force ? ['--force'] : []), '--json'], { allowFailure: true, timeoutMs: 600_000 });
    data = parseEnvelope<StateImportResult>(r.stdout, 'workspace state-import');
  } catch (e) {
    // Keep the runtime's own error code (CONFLICT while in use, PRECONDITION for an invalid archive)
    // and its own details (not the whole error envelope nested under details).
    const d = (e as MinionsError).details as { code?: string; message?: string; hint?: string; details?: unknown } | undefined;
    if (e instanceof MinionsError && d?.code && d.message) throw new MinionsError(d.code as MinionsError['code'], d.message, d.hint, d.details);
    throw e;
  } finally { await discard(target, remote); }
  return { archive, createdAt: manifest.createdAt, schemaVersion: manifest.schemaVersion, files: manifest.files.length, container: data };
}
