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
//   (src/runtime/coordinator.ts `hostSettings`); bypassPermissions stays disabled.
import { spawn } from 'node:child_process';
import { chmod, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { atomicWrite, ensureDir, exists } from '../core/fsutil.js';
import { hostRoot, hostRuntimePaths, projectPaths } from '../core/paths.js';
import { shQuote } from '../runtime/coordinator.js';
import { KEY_HELPER_TTL_MS, authOf, isKeyAuth, resolveOnPath } from './auth.js';
import { packageRoot, type Runner } from './docker.js';
import type { ProjectJson } from './project.js';

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

/** Variables that must never leak from the user's shell into agent processes. */
const DROP_ENV = ['TMUX', 'TMUX_PANE', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'TELEGRAM_BOT_TOKEN'];

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
    MINIONS_RUNTIME: 'host',
    MINIONS_HOME: hostRoot(),
    MINIONS_PROJECT_ID: project.projectId,
    MINIONS_PROJECT_DIR: pp.dir,
    MINIONS_WORKSPACE: hp.workspace,
    MINIONS_STATE_DIR: hp.state,
    MINIONS_CONFIG: pp.runtimeConfigJson,
    MINIONS_SECRETS_DIR: pp.secretsDir,
    MINIONS_PLUGIN_DIR: pp.pluginDir,
    MINIONS_TMUX_SOCKET: hp.tmuxSocket,
    MINIONS_AUTH_METHOD: auth.method,
    MINIONS_GIT_CREDENTIAL_HELPER: `!${shQuote(hp.minionsShim)} git-credential`,
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    ...(isKeyAuth(auth) ? { CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(KEY_HELPER_TTL_MS) } : {}),
    ...(auth.env ?? {}),
  };
}

/** Full environment of host-runtime processes: the user's environment minus tokens/tmux, plus the runtime variables. */
export function hostRuntimeEnv(project: ProjectJson, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!DROP_ENV.includes(k) && !k.startsWith('MINIONS_')) env[k] = v;
  Object.assign(env, hostRuntimeVars(project));
  const bin = hostRuntimePaths(project.projectId).bin;
  env.PATH = [bin, ...(base.PATH ?? '').split(':').filter((d) => d && d !== bin)].join(':');
  return env;
}

export function minionsShim(project: ProjectJson, target: ShimTarget): string {
  const bin = hostRuntimePaths(project.projectId).bin;
  const L = ['#!/bin/sh', `# Generated by minions: host runtime of project ${project.projectId}. Regenerated on every \`minions start\`; do not edit.`];
  for (const k of DROP_ENV) L.push(`unset ${k}`);
  for (const [k, v] of Object.entries(hostRuntimeVars(project))) L.push(`${k}=${shQuote(v)}; export ${k}`);
  L.push(`case ":$PATH:" in *:${shQuote(bin)}:*) ;; *) PATH=${shQuote(bin)}:"$PATH"; export PATH ;; esac`);
  L.push(`exec ${shQuote(target.node)} ${shQuote(target.cli)} "$@"`);
  return L.join('\n') + '\n';
}

/** Host gh wrapper from docker/gh-wrapper.sh: same token handling, host paths. */
export async function ghShim(realGh: string, tokenFile: string, root: string = packageRoot()): Promise<string> {
  const src = await readFile(join(root, 'docker', 'gh-wrapper.sh'), 'utf8');
  const out = src
    .replace(/^REAL_GH=.*$/m, `REAL_GH=${shQuote(realGh)}`)
    .replace(/^TOKEN_FILE=.*$/m, `TOKEN_FILE=${shQuote(tokenFile)}`)
    .replace('# minions gh wrapper, installed as /usr/local/bin/gh (the real binary is /opt/gh/bin/gh, off PATH).',
      '# minions gh wrapper for the host runtime (generated; the real gh is REAL_GH). Your own gh login is not used.');
  if (!out.includes(`REAL_GH=${shQuote(realGh)}`)) throw new MinionsError('INTERNAL', 'gh wrapper template has an unexpected shape.');
  return out;
}

/**
 * Writes the shims (0755 in a 0700 dir) and creates the 0700 host runtime dirs. The gh shim exists
 * only when gh is installed on the host (needed for pull-request delivery).
 */
export async function prepareHostRuntime(project: ProjectJson, opts: { target?: ShimTarget; pathEnv?: string } = {}): Promise<{ gh: string | null }> {
  const hp = hostRuntimePaths(project.projectId);
  for (const d of [hp.root, hp.bin, hp.workspace, hp.state]) { await ensureDir(d, 0o700); await chmod(d, 0o700); }
  await ensureDir(projectPaths(project.projectId).secretsDir, 0o700);
  await atomicWrite(hp.minionsShim, minionsShim(project, opts.target ?? defaultShimTarget()), { mode: 0o755 });
  const pathEnv = (opts.pathEnv ?? process.env.PATH ?? '').split(':').filter((d) => d && d !== hp.bin).join(':');
  const gh = await resolveOnPath('gh', pathEnv);
  if (gh) await atomicWrite(hp.ghShim, await ghShim(gh, projectPaths(project.projectId).githubTokenFile), { mode: 0o755 });
  else await rm(hp.ghShim, { force: true });
  return { gh };
}

// ---------------------------------------------------------------- lifecycle

/** Host-runtime counterpart of `Compose` for the operations the host CLI needs. */
export class HostRuntime {
  constructor(readonly project: ProjectJson, private readonly runner: Runner = run) {}

  get paths() { return hostRuntimePaths(this.project.projectId); }
  env(base: NodeJS.ProcessEnv = process.env) { return hostRuntimeEnv(this.project, base); }
  /** Human hint for attaching to the coordinator's dedicated tmux server. */
  get attachCommand() { return `tmux -L ${this.paths.tmuxSocket} attach -t coordinator`; }

  /** Runs `minions …` through the shim (or another command with the runtime environment); output captured. */
  exec(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const [cmd, ...rest] = args;
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
    const r = await this.runner('tmux', ['-L', this.paths.tmuxSocket, 'has-session', '-t', 'coordinator'], { allowFailure: true, timeoutMs: 10_000 });
    return r.code === 0;
  }

  /** Stops the coordinator: kills the dedicated tmux server (only minions sessions live there). */
  async down(): Promise<boolean> {
    const was = await this.isRunning();
    await this.runner('tmux', ['-L', this.paths.tmuxSocket, 'kill-server'], { allowFailure: true, timeoutMs: 10_000 });
    return was;
  }

  async prepared(): Promise<boolean> { return exists(this.paths.minionsShim); }

  /** Transfer target: bundles go through <project>/host/state/{import,exports}. */
  transferTarget() {
    const hp = this.paths;
    return {
      dirs: { import: hp.import, exports: hp.exports },
      exec: (args: string[], opts?: RunOptions) => this.exec(args, opts),
      putFile: async (local: string, remote: string) => { await ensureDir(hp.import, 0o700); await copyFile(local, remote); },
      getFile: async (remote: string, local: string) => { await copyFile(remote, local); },
    };
  }
}

// ---------------------------------------------------------------- host tools

export interface HostTool { name: string; required: boolean; ok: boolean; version: string | null; hint: string; detail: string }

const TOOLS: { name: string; args: string[]; required: boolean; hint: string; tested?: string; purpose: string }[] = [
  { name: 'tmux', args: ['-V'], required: true, hint: 'brew install tmux', purpose: 'runs the coordinator session' },
  { name: 'claude', args: ['--version'], required: true, hint: 'npm install -g @anthropic-ai/claude-code (or brew install --cask claude-code)', tested: '2.1.292', purpose: 'Claude Code' },
  { name: 'backlog', args: ['--version'], required: true, hint: 'npm install -g backlog.md@1.54.0', tested: '1.54.0', purpose: 'Backlog.md CLI' },
  { name: 'git', args: ['--version'], required: true, hint: 'xcode-select --install (or brew install git)', purpose: 'workspace clone' },
  { name: 'gh', args: ['--version'], required: false, hint: 'brew install gh (needed only for pull-request delivery)', purpose: 'GitHub CLI' },
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
    out.push({ name: t.name, required: t.required, ok, version, hint: t.hint,
      detail: ok ? `${version}${untested}` : `${t.name} not found on PATH (${t.purpose})` });
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
