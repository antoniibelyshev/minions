// Read-only repository inspection. Reads Git metadata and files as data; never runs repository
// scripts, package managers, or builds (spec §7 "Read-only discovery", §3A).
import { readdir, readFile, stat } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { run, type RunOptions, type RunResult } from '../core/exec.js';

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

export interface DockerStatus {
  daemon: boolean;
  serverVersion: string | null;
  compose: boolean;
  composeVersion: string | null;
  error?: string;
}
export type DockerProbe = () => Promise<DockerStatus>;

export interface Discovery {
  repoPath: string;
  git: {
    currentBranch: string | null;
    baseBranch: string;
    remoteUrl: string | null;
    hasGitHub: boolean;
    dirty: boolean;
    userName: string | null;
    userEmail: string | null;
  };
  instructions: { claudeMd: boolean; agentsMd: boolean; claudeDir: boolean; contributing: string | null };
  packageJson: { present: boolean; scripts: Record<string, string>; packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' };
  verificationCommands: string[];
  ciWorkflows: string[];
  dockerfile: boolean;
  host: { cpus: number; memoryMiB: number; platform: string; arch: string };
}

const isFile = async (p: string) => (await stat(p).catch(() => null))?.isFile() ?? false;
const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;

/**
 * Leading `git` options for host-side git calls: never run an fsmonitor daemon, hooks, or a pager
 * from repository configuration while minions inspects or transfers the repo.
 */
export const HOST_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-pager'];

/** Drops embedded credentials (`https://user:token@host/…`) from a remote URL; scp-style URLs are kept. */
export function sanitizeRemoteUrl(url: string | null): string | null {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    if (u.protocol === 'ssh:') { u.password = ''; return u.toString(); } // ssh user name is not a secret
    u.username = ''; u.password = '';
    return u.toString();
  } catch { return url; }
}

async function gitOut(runner: Runner, cwd: string, args: string[]): Promise<string | null> {
  const r = await runner('git', [...HOST_GIT, ...args], { cwd, allowFailure: true, timeoutMs: 15_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** Parses `docker compose version --short` output into a major version (v2+ required). */
export function composeMajor(version: string | null): number {
  const m = /^v?(\d+)\./.exec(version?.trim() ?? '');
  return m ? Number(m[1]) : 0;
}

export function dockerProbe(runner: Runner = run): DockerProbe {
  return async () => {
    const info = await runner('docker', ['info', '--format', '{{.ServerVersion}}'], { allowFailure: true, timeoutMs: 20_000 });
    const daemon = info.code === 0 && !!info.stdout.trim();
    const comp = await runner('docker', ['compose', 'version', '--short'], { allowFailure: true, timeoutMs: 20_000 });
    const composeVersion = comp.code === 0 ? comp.stdout.trim() || null : null;
    const status: DockerStatus = {
      daemon, serverVersion: daemon ? info.stdout.trim() : null,
      compose: composeMajor(composeVersion) >= 2, composeVersion,
    };
    if (!daemon) status.error = (info.stderr || info.stdout).trim().split('\n').slice(-1)[0] || 'docker info failed';
    return status;
  };
}

function lockfileManager(files: Set<string>): Discovery['packageJson']['packageManager'] {
  if (files.has('pnpm-lock.yaml')) return 'pnpm';
  if (files.has('yarn.lock')) return 'yarn';
  if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun';
  return 'npm';
}

/** Proposed verification commands from package.json script names (data only; nothing is run). */
export function proposeVerification(scripts: Record<string, string>, pm: Discovery['packageJson']['packageManager']): string[] {
  const out: string[] = [];
  const runScript = (name: string) => (pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`);
  for (const name of ['typecheck', 'lint']) if (scripts[name]) out.push(runScript(name));
  const t = scripts.test;
  if (t && !/no test specified/.test(t)) out.push(pm === 'npm' ? 'npm test' : `${pm} test`);
  return out;
}

export async function discover(repoPath: string, runner: Runner = run): Promise<Discovery> {
  const g = (args: string[]) => gitOut(runner, repoPath, args);
  const currentBranch = await g(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const originHead = await g(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const baseBranch = originHead?.replace(/^origin\//, '') || currentBranch || 'main';
  const remoteUrl = sanitizeRemoteUrl(await g(['config', '--get', 'remote.origin.url']));
  const status = await g(['status', '--porcelain', '--untracked-files=no']);
  const top = new Set(await readdir(repoPath).catch(() => [] as string[]));

  const contributing = ['CONTRIBUTING.md', 'CONTRIBUTING', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'];
  let contributingPath: string | null = null;
  for (const c of contributing) if (await isFile(join(repoPath, c))) { contributingPath = c; break; }

  let scripts: Record<string, string> = {};
  const pkgPresent = top.has('package.json');
  if (pkgPresent) {
    try {
      const pkg = JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf8')) as { scripts?: unknown };
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        scripts = Object.fromEntries(Object.entries(pkg.scripts as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
      }
    } catch { /* malformed package.json: treat as no scripts */ }
  }
  const packageManager = lockfileManager(top);

  const wfDir = join(repoPath, '.github', 'workflows');
  const ciWorkflows = (await readdir(wfDir).catch(() => [] as string[])).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
  for (const f of ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml']) if (await isFile(join(repoPath, f))) ciWorkflows.push(f);

  return {
    repoPath,
    git: {
      currentBranch, baseBranch, remoteUrl,
      hasGitHub: !!remoteUrl && /github\.com[:/]/.test(remoteUrl),
      dirty: !!status,
      userName: await g(['config', '--get', 'user.name']),
      userEmail: await g(['config', '--get', 'user.email']),
    },
    instructions: {
      claudeMd: top.has('CLAUDE.md'), agentsMd: top.has('AGENTS.md'),
      claudeDir: await isDir(join(repoPath, '.claude')), contributing: contributingPath,
    },
    packageJson: { present: pkgPresent, scripts, packageManager },
    verificationCommands: proposeVerification(scripts, packageManager),
    ciWorkflows,
    dockerfile: top.has('Dockerfile') || top.has('Containerfile'),
    host: { cpus: cpus().length, memoryMiB: Math.floor(totalmem() / 1048576), platform: process.platform, arch: process.arch },
  };
}
