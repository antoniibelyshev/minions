// Explicit repository transfer between host and container via Git bundles (spec §3A "Repository access").
// Import copies committed history of the base branch only; export fetches agent branches into
// refs/remotes/minions/* on the host (never touches local branches or the working tree).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { matchesAny } from '../config/capabilities.js';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { ensureDir } from '../core/fsutil.js';
import { CONTAINER, SERVICE_NAME, projectPaths } from '../core/paths.js';
import { Compose, type Runner } from './docker.js';
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

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string; hint?: string } }
function parseEnvelope<T>(stdout: string, what: string): T {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  let env: Envelope<T>;
  try { env = JSON.parse(line) as Envelope<T>; } catch {
    throw new MinionsError('INTERNAL', `${what}: unexpected output from the container.`, undefined, { stdout: stdout.slice(-500) });
  }
  if (!env.ok) throw new MinionsError('INTERNAL', `${what} failed in the container: ${env.error?.message ?? 'unknown error'}`, env.error?.hint, env.error);
  return env.data as T;
}

export interface ImportResult { bundle: string; commit: string; baseBranch: string; warnings: string[]; container: { head?: string; base?: string; imported?: boolean } }

export async function importRepo(project: ProjectJson, opts: { runner?: Runner; repoPath?: string; compose?: Compose } = {}): Promise<ImportResult> {
  const runner = opts.runner ?? run;
  const repo = opts.repoPath ?? project.repoPath;
  const compose = opts.compose ?? new Compose(project.projectId, runner);
  const git = (args: string[], allowFailure = false) => runner('git', args, { cwd: repo, allowFailure, timeoutMs: 300_000 });
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
    await git(['bundle', 'create', bundle, base]);
    await compose.cp(bundle, `${SERVICE_NAME}:${CONTAINER.import}/${file}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const args = ['minions', 'workspace', 'import', `${CONTAINER.import}/${file}`, '--base', base];
  if (project.remoteUrl) args.push('--remote-url', project.remoteUrl);
  args.push('--json');
  const r = await compose.exec(args, { allowFailure: true, timeoutMs: 600_000 });
  const data = parseEnvelope<ImportResult['container']>(r.stdout, 'workspace import');
  return { bundle: file, commit, baseBranch: base, warnings, container: data ?? {} };
}

export interface ExportResult { bundle: string; refs: string[]; changes: { ref: string; from: string | null; to: string | null }[] }

async function minionsRefs(runner: Runner, repo: string): Promise<Map<string, string>> {
  const r = await runner('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/minions/'], { cwd: repo, allowFailure: true });
  return new Map(r.stdout.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]));
}

export async function exportRepo(project: ProjectJson, opts: { runner?: Runner; repoPath?: string; compose?: Compose } = {}): Promise<ExportResult> {
  const runner = opts.runner ?? run;
  const repo = opts.repoPath ?? project.repoPath;
  const compose = opts.compose ?? new Compose(project.projectId, runner);
  const file = `export-${new Date().toISOString().replace(/[:.]/g, '-')}.bundle`;
  const r = await compose.exec(['minions', 'workspace', 'export', `${CONTAINER.exports}/${file}`, '--json'], { allowFailure: true, timeoutMs: 600_000 });
  const data = parseEnvelope<{ path: string; refs: string[] }>(r.stdout, 'workspace export');
  const exportsDir = projectPaths(project.projectId).exportsDir;
  await ensureDir(exportsDir);
  const local = join(exportsDir, basename(data.path || file));
  await compose.cp(`${SERVICE_NAME}:${data.path || `${CONTAINER.exports}/${file}`}`, local);
  const before = await minionsRefs(runner, repo);
  // Remote-tracking refs under refs/remotes/minions/ are minions-owned; forced updates there never touch local branches.
  await runner('git', ['fetch', '--no-tags', '--prune', local, '+refs/heads/*:refs/remotes/minions/*'], { cwd: repo, timeoutMs: 300_000 });
  const after = await minionsRefs(runner, repo);
  const changes: ExportResult['changes'] = [];
  for (const ref of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(ref) ?? null, to = after.get(ref) ?? null;
    if (from !== to) changes.push({ ref, from, to });
  }
  return { bundle: local, refs: data.refs ?? [], changes: changes.sort((a, b) => a.ref.localeCompare(b.ref)) };
}
