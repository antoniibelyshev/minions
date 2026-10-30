import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerProbe } from '../../src/host/discovery.js';
import { fromTemplate } from '../repo-template.js';

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Temp git repo with one commit on main and a configured identity. */
export function makeRepo(root: string, name = 'repo'): string {
  const repo = join(root, name);
  fromTemplate('host-make-repo', repo, (d) => { buildRepo(d); return ''; });
  return repo;
}

function buildRepo(repo: string): void {
  execFileSync('mkdir', ['-p', repo]);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Ada Lovelace');
  git(repo, 'config', 'user.email', 'ada@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', lint: 'eslint .' } }, null, 2));
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
}

export const dockerUp: DockerProbe = async () => ({ daemon: true, serverVersion: '29.8.2', compose: true, composeVersion: '5.5.1' });
export const dockerDown: DockerProbe = async () => ({ daemon: false, serverVersion: null, compose: true, composeVersion: '5.5.1', error: 'Cannot connect to the Docker daemon' });

export function withHome(): { home: string; root: string; cleanup: () => void } {
  const root = tempDir('minions-test-');
  const home = join(root, 'home');
  const prev = process.env.MINIONS_HOME;
  process.env.MINIONS_HOME = home;
  return { home, root, cleanup: () => { if (prev === undefined) delete process.env.MINIONS_HOME; else process.env.MINIONS_HOME = prev; rmSync(root, { recursive: true, force: true }); } };
}

/**
 * Shared init output (task-104.3). Most host tests start from `minions init --yes` on a fresh repository, and
 * init (wizard, plan, plugin generation, manifest, registry) costs ~60 ms idle and many times that under load.
 * Each test file runs the real init once per visibility into a template root (repo + MINIONS_HOME) and every
 * later call copies that template into the test's own root, so each test still gets a fresh, private copy.
 * The copy is the same install at the new path: absolute template paths in the copied files (registry,
 * project.json, compose.yaml, manifest paths) are rewritten to the new root, and manifest hashes of rewritten
 * files are recomputed. The project id is the template's; every test has its own MINIONS_HOME, so it never
 * meets the template's or another test's state. Module state is per test file, so a file that mocks the plugin
 * generator gets templates built with its mock. Tests about init itself (flags, reruns, upgrades of an existing
 * install, the wizard) call `runInit` directly instead.
 *
 * Falls back to a real init when the target repository or MINIONS_HOME already has content (a second project
 * in the same home, or a test that prepared host state first), so the result never depends on the shortcut.
 */
export async function initFromTemplate(root: string, opts: { visibility?: 'private' | 'shared'; name?: string } = {}): Promise<{ repo: string; projectId: string }> {
  const visibility = opts.visibility ?? 'private';
  const name = opts.name ?? 'repo';
  const repo = join(root, name);
  const home = process.env.MINIONS_HOME;
  if (!home) throw new Error('initFromTemplate needs MINIONS_HOME (use withHome())');
  // Loaded on first use: most files importing these fixtures never run init.
  const { runInit } = await import('../../src/host/install.js');
  const real = async () => {
    makeRepo(root, opts.name);
    return { repo, projectId: (await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp })).plan.projectId };
  };
  if (!isEmptyDir(repo) || !isEmptyDir(home)) return real();
  const key = [visibility, name, ...INIT_ENV.map((v) => process.env[v] ?? '')].join('\0');
  let t = initTemplates.get(key);
  if (!t || !existsSync(t.repo)) {
    const tRoot = tempDir('minions-init-template-');
    const tHome = join(tRoot, 'home');
    process.env.MINIONS_HOME = tHome;
    try {
      const tRepo = makeRepo(tRoot, name);
      const r = await runInit({ path: tRepo, yes: true, visibility, dockerProbe: dockerUp });
      t = { repo: tRepo, home: tHome, projectId: r.plan.projectId };
    } finally { process.env.MINIONS_HOME = home; }
    initTemplates.set(key, t);
  }
  cpSync(t.repo, repo, { recursive: true });
  cpSync(t.home, home, { recursive: true });
  const rewritten = new Set<string>();
  for (const dir of [repo, home]) rewritePaths(dir, [[t.repo, repo], [t.home, home]], rewritten);
  const manifest = join(home, 'projects', t.projectId, 'manifest.json');
  if (existsSync(manifest)) {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { files: { path: string; sha256: string }[] };
    for (const f of m.files) if (rewritten.has(f.path)) f.sha256 = createHash('sha256').update(readFileSync(f.path)).digest('hex');
    writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
  }
  return { repo, projectId: t.projectId };
}

const initTemplates = new Map<string, { repo: string; home: string; projectId: string }>();
/** Env that changes what init writes or how it behaves: part of the template key. */
const INIT_ENV = ['MINIONS_CREDENTIAL_STORE', 'MINIONS_TEMPLATES', 'PATH', 'HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

function isEmptyDir(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

/** Applies each [from, to] replacement to every file under `dir` (git objects are compressed and path-free; skipped). */
function rewritePaths(dir: string, pairs: [string, string][], rewritten: Set<string>): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!(e.name === 'objects' && dir.endsWith('.git'))) rewritePaths(p, pairs, rewritten); continue; }
    if (!e.isFile()) continue;
    const text = readFileSync(p, 'utf8');
    let out = text;
    for (const [from, to] of pairs) out = out.split(from).join(to);
    if (out === text) continue;
    writeFileSync(p, out);
    rewritten.add(p);
  }
}
