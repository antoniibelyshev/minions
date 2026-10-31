// Runtime selection (host-controlled `runtime` in project.json / defaults.json) and the host runtime:
// agents run directly on the Mac, without Docker. This is LESS SAFE and is never the default.
//
// - The selection lives only in host-side files (project.json, <MINIONS_HOME>/defaults.json). The
//   strict MinionsConfig schema has no such field, so a repository's .minions/config.json cannot
//   downgrade isolation.
// - Agents never work in the user's checkout: they get their own clone and state under
//   <project>/host/{workspace,state}, seeded from a Git bundle of the base branch (as in the container).
// - Every runtime process (coordinator, hooks, helpers, git credential helper) gets the same environment
//   from the `minions` shim in <project>/host/bin, which pins MINIONS_RUNTIME=host and the paths.
// - The coordinator runs in a dedicated tmux server (`tmux -L minions-<id>`), never the user's default one.
// - Claude Code's sandbox and credential deny rules are added to the coordinator settings
//   (src/runtime/coordinator.ts `hostSettings`) unless the owner turns the sandbox off (coordinator.sandbox false,
//   config.local.json only); bypassPermissions likewise only from config.local.json.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { atomicWrite, copyRegularFileNoFollow, ensureDir, ensureRealDir, exists } from '../core/fsutil.js';
import { hostRoot, hostRuntimePaths, projectPaths } from '../core/paths.js';
import { shQuote } from '../runtime/coordinator.js';
import { hardenedGitArgs, hardenedGitEnv } from '../runtime/git-hardening.js';
import { moveKeychainTokensToFileStore, type MovedToken } from './credentials.js';
import { KEY_HELPER_TTL_MS, authOf, isKeyAuth } from './auth.js';
import { packageRoot, type Runner } from './docker.js';
import type { ProjectJson } from './project.js';
import { fastPathHint } from '../backlog/taskfile.js';

export { RUNTIMES, RuntimeKindSchema, runtimeOf, type RuntimeKind } from './runtime-kind.js';

/** Shown by the wizard, `minions runtime set host`, every `minions start` in host mode, and doctor. */
export const HOST_RUNTIME_WARNING = [
  'WARNING: host runtime (no Docker) is less safe than the container.',
  '  Agents run as your macOS user: they can use your files, Keychain, SSH keys, network and credentials.',
  '  There are no container limits (CPU, memory, processes, read-only filesystem).',
  '  Prompt injection in repository, issue or web content could act on your machine.',
  '  minions enables the Claude Code sandbox and denies common credential paths; that narrows, but is not, a container boundary.',
  '  Use Docker (`minions runtime set docker`) for repositories and tasks you do not fully trust.',
];
export const HOST_RUNTIME_SHORT = 'host runtime (no Docker): agents run as your macOS user with access to your files, Keychain, SSH keys, network and credentials; no container limits. Use Docker for untrusted repositories.';

/** What the user types to confirm switching to the host runtime. */
export const HOST_CONFIRM_WORD = 'host';

// ---------------------------------------------------------------- environment + shims

/**
 * Variables of the user's shell that reach host-runtime processes (allowlist). Everything else (cloud
 * and registry tokens, ANTHROPIC_API_KEY, SSH_AUTH_SOCK, GIT_SSH_COMMAND, NODE_OPTIONS, DYLD_*, ...)
 * is dropped. Proxy and CA variables stay so Claude Code and git work behind a corporate proxy;
 * CLAUDE_CONFIG_DIR stays so the `login` method finds the user's own Claude Code login.
 */
export const PASS_ENV = new Set([
  'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'TERMINFO', 'TMPDIR', 'SHELL', 'COLORTERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  '__CF_USER_TEXT_ENCODING', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CLAUDE_CONFIG_DIR',
]);
const passEnv = (k: string) => PASS_ENV.has(k) || k.startsWith('LC_');

/**
 * Unset by the shim, which also runs from environments minions did not build (a user's shell). The
 * shim keeps the rest so the Claude Code sandbox's own variables (proxy, TMPDIR) survive.
 */
const DROP_ENV = ['TMUX', 'TMUX_PANE', 'TMUX_TMPDIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST', 'TELEGRAM_BOT_TOKEN',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'NODE_OPTIONS',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH'];
/** Prefixes the shim also unsets (cloud credentials, injected git config). */
const DROP_PREFIXES = ['AWS_', 'AZURE_', 'GOOGLE_', 'GCLOUD_', 'CLOUDSDK_', 'GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_', 'DYLD_'];

export interface ShimTarget { node: string; cli: string }
export const defaultShimTarget = (): ShimTarget => ({ node: process.execPath, cli: join(packageRoot(), 'dist', 'cli.js') });

/**
 * MINIONS_* and tool variables of the host runtime (non-secret; also written into the shim). Claude
 * key methods use the apiKeyHelper reading <project>/secrets/anthropic-api-key; `login` reuses the
 * user's own Claude Code login (no CLAUDE_CONFIG_DIR override). claudeAuth.env is passed as is
 * (no loopback rewrite: the host reaches 127.0.0.1 directly).
 */
export function hostRuntimeVars(project: ProjectJson): Record<string, string> {
  const pp = projectPaths(project.projectId);
  const hp = hostRuntimePaths(project.projectId);
  const auth = authOf(project);
  return {
    // claudeAuth.env first: the schema rejects MINIONS_*/PATH/GIT_* names, and the runtime values below win anyway.
    ...(auth.env ?? {}),
    MINIONS_RUNTIME: 'host',
    MINIONS_HOME: hostRoot(),
    MINIONS_PROJECT_ID: project.projectId,
    MINIONS_PROJECT_DIR: pp.dir,
    MINIONS_WORKSPACE: hp.workspace,
    MINIONS_STATE_DIR: hp.state,
    MINIONS_LOG_DIR: hp.logs,
    MINIONS_CONFIG: pp.runtimeConfigJson,
    MINIONS_SECRETS_DIR: pp.secretsDir,
    MINIONS_PLUGIN_DIR: pp.pluginDir,
    MINIONS_TMUX_SOCKET: hp.tmuxSocket,
    MINIONS_AUTH_METHOD: auth.method,
    GIT_TERMINAL_PROMPT: '0',
    // Tool caches live in the agent state, so sandboxed commands never write ~/.npm or ~/.cache (cache poisoning).
    ...cacheVars(hp.cache),
    ...(isKeyAuth(auth) ? { CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(KEY_HELPER_TTL_MS) } : {}),
  };
}

/** Cache locations of common toolchains, all under <state>/cache. */
export const cacheVars = (cache: string): Record<string, string> => ({
  XDG_CACHE_HOME: cache,
  npm_config_cache: join(cache, 'npm'),
  COREPACK_HOME: join(cache, 'corepack'),
  YARN_CACHE_FOLDER: join(cache, 'yarn'),
  PIP_CACHE_DIR: join(cache, 'pip'),
  UV_CACHE_DIR: join(cache, 'uv'),
  GOCACHE: join(cache, 'go-build'),
  GOMODCACHE: join(cache, 'go-mod'),
  BUN_INSTALL_CACHE_DIR: join(cache, 'bun'),
});

/**
 * Full environment of host-runtime processes: an allowlist of the user's environment (PASS_ENV, LC_*),
 * the runtime variables, and PATH with the shim dir first and only absolute entries (a relative entry
 * would resolve inside the agent-writable workspace).
 */
export function hostRuntimeEnv(project: ProjectJson, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (passEnv(k) && v !== undefined) env[k] = v;
  if (env.CLAUDE_CONFIG_DIR && !isAbsolute(env.CLAUDE_CONFIG_DIR)) delete env.CLAUDE_CONFIG_DIR;
  Object.assign(env, hostRuntimeVars(project));
  const bin = hostRuntimePaths(project.projectId).bin;
  env.PATH = [bin, ...(base.PATH ?? '').split(':').filter((d) => d && d !== bin && isAbsolute(d))].join(':');
  return env;
}

export function minionsShim(project: ProjectJson, target: ShimTarget): string {
  const bin = hostRuntimePaths(project.projectId).bin;
  const L = ['#!/bin/sh', `# Generated by minions: host runtime of project ${project.projectId}. Regenerated on every \`minions start\`; do not edit.`];
  L.push(`unset ${DROP_ENV.join(' ')}`);
  const prefixes = DROP_PREFIXES.map((p) => p.replace(/_$/, '')).join('|');
  L.push(`for v in $(env | sed -n -E 's/^((${prefixes})_[A-Za-z0-9_]*)=.*/\\1/p'); do unset "$v"; done`);
  for (const [k, v] of Object.entries(hostRuntimeVars(project))) L.push(`${k}=${shQuote(v)}; export ${k}`);
  L.push(`case ":$PATH:" in *:${shQuote(bin)}:*) ;; *) PATH=${shQuote(bin)}:"$PATH"; export PATH ;; esac`);
  L.push(`exec ${shQuote(target.node)} ${shQuote(target.cli)} "$@"`);
  return L.join('\n') + '\n';
}

/** realpath of the deepest existing ancestor, with the rest appended (a missing file still resolves its links). */
export function realPathOf(p: string): string {
  try { return realpathSync(p); } catch {
    const up = dirname(p);
    return up === p ? p : join(realPathOf(up), basename(p));
  }
}
/** Whether p is dir or below it (lexically). */
export const isInside = (p: string, dir: string): boolean => { const r = relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r)); };

/** The dirs of the host runtime agents may write (the sandbox allows the workspace and the state dir only). */
export function agentWritableDirs(projectId: string): string[] {
  const hp = hostRuntimePaths(projectId);
  return [hp.workspace, hp.state];
}

/** The agent-writable dir one of these paths is in (as given or after resolving symlinks), or null. */
export function agentWritableHit(paths: string[], agentWritable: string[]): { path: string; dir: string } | null {
  const dirs = agentWritable.map((d) => ({ d, r: realPathOf(d) }));
  for (const p of paths) {
    const hit = dirs.find(({ d, r }) => isInside(p, d) || isInside(realPathOf(p), r));
    if (hit) return { path: realPathOf(p), dir: hit.d };
  }
  return null;
}

/**
 * Refuses a shim target inside the agent-writable host dirs (task-7): the shim runs outside the Claude Code
 * sandbox, so pointing it at a CLI an agent can write would let agents run unsandboxed code. Throws before any write.
 */
export function assertShimTargetSafe(projectId: string, target: ShimTarget): void {
  const hit = agentWritableHit([target.cli, dirname(dirname(target.cli))], agentWritableDirs(projectId));
  if (hit) {
    throw new MinionsError('PRECONDITION', `Refusing to point the host runtime shim at ${hit.path}: it is inside the agent-writable ${hit.dir}.`,
      'Run minions from an install outside the host runtime dirs (npm pack in your checkout, then npm install -g <tarball>).');
  }
}

/**
 * Writes the shim (0755 in a 0700 dir) and creates the 0700 host runtime dirs. Tokens still in the macOS
 * Keychain are moved to the 0600 file store first (see moveKeychainTokensToFileStore: sandboxed agent
 * commands can run /usr/bin/security, which every minions Keychain item trusts).
 */
export async function prepareHostRuntime(project: ProjectJson, opts: { target?: ShimTarget; runner?: Runner } = {}): Promise<{ movedToFileStore: MovedToken[]; keychainWarnings: string[] }> {
  const target = opts.target ?? defaultShimTarget();
  assertShimTargetSafe(project.projectId, target); // before any write: a refused target leaves the shim as it was
  const hp = hostRuntimePaths(project.projectId);
  for (const d of [hp.root, hp.bin, hp.workspace, hp.state, hp.cache, hp.logs, hp.transfer, hp.import, hp.exports]) { await ensureRealDir(d, 0o700); await chmod(d, 0o700); }
  await ensureDir(projectPaths(project.projectId).secretsDir, 0o700);
  const moved = await moveKeychainTokensToFileStore(opts.runner ?? run);
  await atomicWrite(hp.minionsShim, minionsShim(project, target), { mode: 0o755 });
  // The gh token wrapper of the removed GitHub delivery (docs/design/autonomy.md Decision 8).
  await rm(join(hp.bin, 'gh'), { force: true });
  await ensureHostWorktreesDir(hp.repo);
  return { movedToFileStore: moved.moved, keychainWarnings: moved.warnings };
}

/**
 * State of `<repo>/.git/worktrees` in the host workspace: `ok` (a real directory), `missing`, `no-repo` (no
 * `.git` directory yet, e.g. before the first import) or `invalid` (`.git` or `.git/worktrees` is a symlink or
 * not a directory).
 */
export type WorktreesDirState = 'ok' | 'missing' | 'no-repo' | 'invalid';

export async function hostWorktreesDirState(repo: string): Promise<WorktreesDirState> {
  const gitDir = await lstat(join(repo, '.git')).catch(() => null);
  if (!gitDir) return 'no-repo';
  if (!gitDir.isDirectory()) return 'invalid';
  const wt = await lstat(join(repo, '.git', 'worktrees')).catch(() => null);
  if (!wt) return 'missing';
  return wt.isDirectory() ? 'ok' : 'invalid';
}

/**
 * Creates `<repo>/.git/worktrees` outside the sandbox (task-3). The coordinator settings deny Edit of
 * `.git/worktrees/<name>/config.worktree` (hostSettings); on macOS Claude Code turns that into a sandbox write
 * deny that also refuses creating the missing ancestors of the denied path, so a sandboxed `git worktree add`
 * could never create `.git/worktrees` itself. Once the directory exists, `.git/worktrees/<name>/` can be created
 * (the glob only matches the `config.worktree` file). Never follows a symlinked `.git`; an invalid layout is
 * left alone and reported (doctor `workspace.worktrees`).
 */
export async function ensureHostWorktreesDir(repo: string): Promise<WorktreesDirState> {
  const state = await hostWorktreesDirState(repo);
  if (state !== 'missing') return state;
  await mkdir(join(repo, '.git', 'worktrees'), { mode: 0o755 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
  return hostWorktreesDirState(repo);
}

// ---------------------------------------------------------------- lifecycle

/** Host-runtime counterpart of `Compose` for the operations the host CLI needs. */
export class HostRuntime {
  constructor(readonly project: ProjectJson, private readonly runner: Runner = run) {}

  get paths() { return hostRuntimePaths(this.project.projectId); }
  env(base: NodeJS.ProcessEnv = process.env) { return hostRuntimeEnv(this.project, base); }
  /** Human hint for attaching to the coordinator's dedicated tmux server. */
  get attachCommand() { return `tmux -L ${this.paths.tmuxSocket} attach -t coordinator`; }

  /**
   * Runs `minions …` through the shim (or another command with the runtime environment); output
   * captured. These processes run OUTSIDE the Claude Code sandbox with a fresh allowlisted environment;
   * `git` gets the host-runtime hardening (src/runtime/git-hardening.ts), because the workspace is agent-writable.
   */
  exec(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const [cmd, ...rest] = args;
    if (cmd === 'git') {
      const env = this.env();
      return this.runner('git', [...hardenedGitArgs(), ...rest], { cwd: this.paths.workspace, timeoutMs: 300_000, ...opts, env: hardenedGitEnv(env) });
    }
    const bin = cmd === 'minions' ? this.paths.minionsShim : cmd!;
    return this.runner(bin, rest, { cwd: this.paths.workspace, timeoutMs: 300_000, ...opts, env: this.env() });
  }

  /** Inherited stdio (the coordinator TUI). Returns the exit code. */
  execInherit(args: string[]): Promise<number> {
    const [cmd, ...rest] = args;
    const bin = cmd === 'minions' ? this.paths.minionsShim : cmd!;
    return new Promise((resolve, reject) => {
      const child = spawn(bin, rest, { stdio: 'inherit', shell: false, env: this.env(), cwd: this.paths.workspace });
      child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT'
        ? new MinionsError('PRECONDITION', `${bin} not found.`, 'Run `minions start` to prepare the host runtime.') : e));
      child.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
    });
  }

  /** True when the coordinator's tmux session exists on the dedicated server. */
  async isRunning(): Promise<boolean> {
    const r = await this.runner('tmux', ['-L', this.paths.tmuxSocket, 'has-session', '-t', 'coordinator'], { allowFailure: true, timeoutMs: 10_000, env: this.env() });
    return r.code === 0;
  }

  /** Stops the coordinator: kills the dedicated tmux server (only minions sessions live there). */
  async down(): Promise<boolean> {
    const was = await this.isRunning();
    // The detached supervisor and dispatcher are not in the tmux server: stop them too, so a start runs current code.
    if (await this.prepared()) await this.exec(['minions', 'coordinator', 'stop-helpers', '--json'], { allowFailure: true, timeoutMs: 30_000 });
    await this.runner('tmux', ['-L', this.paths.tmuxSocket, 'kill-server'], { allowFailure: true, timeoutMs: 10_000, env: this.env() });
    return was;
  }

  async prepared(): Promise<boolean> { return exists(this.paths.minionsShim); }

  /**
   * Transfer target: bundles go through <project>/host/transfer/{import,exports}, which only the host
   * CLI writes (the sandbox may write the workspace and state only). Copies never follow symlinks: the
   * dirs must be real 0700 dirs, sources are opened O_NOFOLLOW and fstat-checked, targets created O_EXCL.
   */
  transferTarget() {
    const hp = this.paths;
    const dirs = async (d: string) => { await ensureRealDir(hp.root); await ensureRealDir(hp.transfer); await ensureRealDir(d); };
    return {
      dirs: { import: hp.import, exports: hp.exports },
      hostFs: true,
      // After every transfer command (e.g. the first `workspace import` clones the repo): .git/worktrees, see ensureHostWorktreesDir.
      exec: async (args: string[], opts?: RunOptions) => { await dirs(hp.exports); try { return await this.exec(args, opts); } finally { await ensureHostWorktreesDir(hp.repo).catch(() => undefined); } },
      putFile: async (local: string, remote: string) => { await dirs(hp.import); await rm(remote, { force: true }); await copyRegularFileNoFollow(local, remote); },
      getFile: async (remote: string, local: string) => { await copyRegularFileNoFollow(remote, local); },
      removeFile: async (remote: string) => { await rm(remote, { force: true }); },
    };
  }
}

// ---------------------------------------------------------------- host tools

export interface HostTool { name: string; required: boolean; ok: boolean; version: string | null; hint: string; detail: string }

/** `note`: extra detail for an installed version (e.g. a slower code path it selects); null adds nothing. */
const TOOLS: { name: string; args: string[]; required: boolean; hint: string; tested?: string; purpose: string; note?: (version: string) => string | null }[] = [
  { name: 'tmux', args: ['-V'], required: true, hint: 'brew install tmux', purpose: 'runs the coordinator session' },
  { name: 'claude', args: ['--version'], required: true, hint: 'npm install -g @anthropic-ai/claude-code (or brew install --cask claude-code)', tested: '2.1.292', purpose: 'Claude Code' },
  { name: 'backlog', args: ['--version'], required: true, hint: 'npm install -g backlog.md@1.54.0', tested: '1.54.0', purpose: 'Backlog.md CLI', note: fastPathHint },
  { name: 'git', args: ['--version'], required: true, hint: 'xcode-select --install (or brew install git)', purpose: 'workspace clone' },
];

const firstLine = (s: string) => s.trim().split('\n')[0]?.trim().slice(0, 120) ?? '';

/** Versions of the host tools the host runtime needs. Only `--version`/`-V` is run. */
export async function hostTools(runner: Runner = run, env: NodeJS.ProcessEnv = process.env): Promise<HostTool[]> {
  const out: HostTool[] = [];
  for (const t of TOOLS) {
    const r = await runner(t.name, t.args, { allowFailure: true, timeoutMs: 30_000, env });
    const ok = r.code === 0;
    const version = ok ? firstLine(r.stdout || r.stderr) : null;
    const untested = ok && t.tested && !version!.includes(t.tested) ? ` (tested with ${t.tested})` : '';
    const note = ok && t.note ? t.note(version!) : null;
    out.push({ name: t.name, required: t.required, ok, version, hint: t.hint,
      detail: ok ? `${version}${untested}${note ? `; ${note}` : ''}` : `${t.name} not found on PATH (${t.purpose})` });
  }
  return out;
}

export async function requireHostTools(runner: Runner = run): Promise<HostTool[]> {
  const tools = await hostTools(runner);
  const missing = tools.filter((t) => t.required && !t.ok);
  if (missing.length) {
    throw new MinionsError('PRECONDITION', `The host runtime needs ${missing.map((t) => t.name).join(', ')} on PATH.`,
      missing.map((t) => `${t.name}: ${t.hint}`).join('\n'));
  }
  return tools;
}
