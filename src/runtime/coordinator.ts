import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { atomicWrite } from '../core/fsutil.js';
import { probeTelegram, TELEGRAM_CHANNEL_SPEC, type TelegramProbeReport } from '../telegram/probe.js';
import { checkTelegramTokenFormat } from '../telegram/token.js';
import { runtimePaths, type RuntimePaths } from './paths.js';

export const TMUX_SESSION = 'coordinator';
/** Environment variable the official Telegram plugin reads its bot token from. */
export const TELEGRAM_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN';
/** Tools of the official plugin's MCP server (plugin MCP tools are named mcp__plugin_<plugin>_<server>__<tool>). */
export const TELEGRAM_TOOLS = ['reply', 'react', 'edit_message'].map((t) => `mcp__plugin_telegram_telegram__${t}`);

export interface CoordinatorCommand { cmd: string; args: string[]; cwd: string }
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Claude Code settings passed with --settings: an allowlist for deterministic CLIs; bypass mode disabled. */
export function coordinatorSettings(cfg: MinionsConfig, opts: { telegram?: boolean } = {}): Record<string, unknown> {
  const allow = ['Bash(minions *)', 'Bash(minions)', 'Bash(git *)', 'Bash(backlog *)'];
  for (const c of cfg.verification.commands) allow.push(`Bash(${c})`, `Bash(${c} *)`);
  // Replies go only to allowlisted chats (the plugin gates outbound messages too).
  if (opts.telegram) allow.push(...TELEGRAM_TOOLS);
  return {
    permissions: {
      allow: [...new Set(allow)],
      // v0.1 delivers locally only; also cover global options before the subcommand (git -C x push).
      deny: ['Bash(git push *)', 'Bash(git push)', 'Bash(git * push *)', 'Bash(git * push)'],
      disableBypassPermissionsMode: 'disable',
    },
  };
}

function assertNoBypass(cfg: MinionsConfig): void {
  if ((cfg.permissionMode as string) === 'bypassPermissions') {
    throw new MinionsError('POLICY_DENIED', 'permissionMode bypassPermissions is never allowed for the coordinator.');
  }
}

async function readPrompt(paths: RuntimePaths): Promise<string> {
  try { return await readFile(paths.coordinatorPrompt, 'utf8'); } catch (e) {
    throw new MinionsError('NOT_FOUND', `Coordinator prompt not found at ${paths.coordinatorPrompt} (${(e as Error).message}).`,
      'Regenerate the plugin on the host (minions start re-renders it).');
  }
}

/**
 * argv for `tmux -u new-session -A -s coordinator -c <repo> -- minions coordinator run` (no shell
 * anywhere; -u forces UTF-8 for the TUI). tmux runs the exec wrapper instead of `claude`, so the bot
 * token never enters tmux's environment. `detached` starts the session without attaching (-d).
 */
export async function buildCoordinatorCommand(cfg: MinionsConfig, paths: RuntimePaths = runtimePaths(), opts: { detached?: boolean } = {}): Promise<CoordinatorCommand> {
  assertNoBypass(cfg);
  await readPrompt(paths); // fail here (doctor --probe), not inside the tmux pane
  return {
    cmd: 'tmux',
    cwd: paths.repo,
    args: ['-u', 'new-session', opts.detached ? '-d' : '-A', '-s', TMUX_SESSION, '-c', paths.repo, '--', 'minions', 'coordinator', 'run'],
  };
}

/** argv of the coordinator's claude process. Never contains a secret. */
export async function buildClaudeCommand(cfg: MinionsConfig, paths: RuntimePaths = runtimePaths(), opts: { telegram?: boolean } = {}): Promise<CoordinatorCommand> {
  assertNoBypass(cfg);
  const prompt = await readPrompt(paths);
  return {
    cmd: 'claude',
    cwd: paths.repo,
    args: [
      '--plugin-dir', paths.pluginDir,
      '--append-system-prompt', prompt,
      '--permission-mode', cfg.permissionMode,
      '--settings', JSON.stringify(coordinatorSettings(cfg, opts)),
      ...(opts.telegram ? ['--channels', TELEGRAM_CHANNEL_SPEC] : []),
    ],
  };
}

// ---------------------------------------------------------------- Telegram launch decision

export type MountedToken = { state: 'missing' } | { state: 'invalid'; detail: string } | { state: 'ok'; token: string; botId: string };

/** Reads the read-only token mount. Validates the format before the value goes anywhere. */
export async function readMountedToken(file: string, readText: (p: string) => Promise<string> = (p) => readFile(p, 'utf8')): Promise<MountedToken> {
  let text: string;
  try { text = await readText(file); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid', detail: `unreadable (${code ?? 'error'})` };
  }
  if (!text.trim()) return { state: 'missing' };
  try { return { state: 'ok', ...checkTelegramTokenFormat(text) }; } catch { return { state: 'invalid', detail: 'not a Telegram bot token' }; }
}

export interface TelegramDecision { enabled: boolean; reason: string }

/** Whether this coordinator launch gets --channels and the token. Every "no" carries a precise reason. */
export function decideTelegram(cfg: MinionsConfig, token: MountedToken, probe: TelegramProbeReport | null): TelegramDecision {
  if (cfg.communication.channel !== 'telegram') return { enabled: false, reason: 'communication.channel is terminal' };
  if (cfg.container.network === 'none') return { enabled: false, reason: 'container.network is none; the Telegram plugin needs api.telegram.org and the npm registry' };
  if (token.state === 'missing') return { enabled: false, reason: 'Telegram bot token is not provisioned; run `minions auth telegram` on the host' };
  if (token.state === 'invalid') return { enabled: false, reason: `the mounted Telegram bot token is ${token.detail}; run \`minions auth telegram\` on the host` };
  if (!probe) return { enabled: false, reason: 'the Telegram capability probe did not run' };
  if (!probe.available) {
    const hint = probe.items.find((i) => i.status !== 'ok' && i.status !== 'unknown' && i.hint)?.hint;
    return { enabled: false, reason: `${probe.summary}${hint ? ` (${hint})` : ''}` };
  }
  return { enabled: true, reason: `Telegram enabled: ${TELEGRAM_CHANNEL_SPEC}` };
}

/**
 * What a launch depends on: the channel setting and the token (as a truncated hash; the record is
 * not a secret). A difference between the running coordinator and the current state is a
 * restart-required Telegram change (spec: "Telegram changes: controlled coordinator restart").
 */
export function launchFingerprint(cfg: MinionsConfig, token: MountedToken): string {
  const tok = token.state === 'ok' ? createHash('sha256').update(token.token).digest('hex').slice(0, 16) : token.state;
  return createHash('sha256').update(JSON.stringify({ channel: cfg.communication.channel, network: cfg.container.network, token: tok })).digest('hex').slice(0, 16);
}

export interface LaunchRecord {
  version: 1;
  pid: number;
  startedAt: string;
  fingerprint: string;
  channel: MinionsConfig['communication']['channel'];
  telegram: TelegramDecision;
}

export async function readLaunchRecord(paths: RuntimePaths = runtimePaths()): Promise<LaunchRecord | null> {
  try {
    const v = JSON.parse(await readFile(paths.coordinatorLaunch, 'utf8')) as LaunchRecord;
    return v && v.version === 1 && typeof v.fingerprint === 'string' ? v : null;
  } catch { return null; }
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'inherit'; shell: false }): {
    on(event: 'error', cb: (e: Error) => void): unknown;
    on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  };
}

export interface RunCoordinatorDeps {
  paths?: RuntimePaths;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  probe?: () => Promise<TelegramProbeReport>;
  readText?: (p: string) => Promise<string>;
  log?: (line: string) => void;
}

/**
 * `minions coordinator run` (exec wrapper started by tmux). Decides Telegram, records the launch,
 * and runs claude. The bot token goes only into this child's environment: never argv, never the
 * tmux environment, never a file. Any inherited TELEGRAM_BOT_TOKEN is dropped when Telegram is off.
 */
export async function runCoordinator(cfg: MinionsConfig, deps: RunCoordinatorDeps = {}): Promise<number> {
  const paths = deps.paths ?? runtimePaths();
  const log = deps.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const wantsTelegram = cfg.communication.channel === 'telegram';
  const token = await readMountedToken(paths.telegramTokenFile, deps.readText);
  let probe: TelegramProbeReport | null = null;
  if (wantsTelegram && cfg.container.network !== 'none' && token.state === 'ok') {
    try { probe = await (deps.probe ?? (() => probeTelegram()))(); } catch { probe = null; }
  }
  const decision = decideTelegram(cfg, token, probe);
  if (wantsTelegram) log(decision.enabled ? `minions: ${decision.reason}` : `minions: Telegram disabled for this session: ${decision.reason}. Terminal mode is active.`);
  const c = await buildClaudeCommand(cfg, paths, { telegram: decision.enabled });
  const env: NodeJS.ProcessEnv = { ...(deps.env ?? process.env) };
  delete env[TELEGRAM_TOKEN_ENV];
  if (decision.enabled && token.state === 'ok') env[TELEGRAM_TOKEN_ENV] = token.token;
  const record: LaunchRecord = { version: 1, pid: process.pid, startedAt: new Date().toISOString(), fingerprint: launchFingerprint(cfg, token), channel: cfg.communication.channel, telegram: decision };
  await atomicWrite(paths.coordinatorLaunch, JSON.stringify(record, null, 2) + '\n').catch(() => { /* state not writable: restart detection degrades */ });
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnLike);
  return new Promise((resolve, reject) => {
    const child = spawn(c.cmd, c.args, { cwd: c.cwd, env, stdio: 'inherit', shell: false });
    child.on('error', (e) => reject(new MinionsError('INCOMPATIBLE_RUNTIME', `Failed to start claude: ${e.message}`)));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

// ---------------------------------------------------------------- controlled restart

export interface SyncResult {
  action: 'none' | 'started' | 'restarted' | 'restart-pending' | 'unchanged';
  running: boolean;
  reason: string;
  telegram: TelegramDecision | null;
}

export interface SyncDeps {
  paths?: RuntimePaths;
  runner?: Runner;
  activeLeases: () => { id: string }[];
  recordRestart?: (info: { at: string; reason: string; leases: string[] }) => void;
  readText?: (p: string) => Promise<string>;
}

const tmuxHas = async (runner: Runner) => (await runner('tmux', ['has-session', '-t', TMUX_SESSION], { allowFailure: true, timeoutMs: 10_000 })).code === 0;

/**
 * `minions coordinator sync`: applies restart-required Telegram changes with a controlled restart.
 * When the running coordinator was launched with a different channel/token, it is stopped (tmux
 * session killed) only if no worker lease is active (or `force`); in-flight leases stay recorded in
 * the runtime DB for `recover`. `startDetached` then (re)starts the session without a terminal, so
 * Telegram works with nobody attached.
 */
export async function syncCoordinator(cfg: MinionsConfig, deps: SyncDeps, opts: { force?: boolean; startDetached?: boolean } = {}): Promise<SyncResult> {
  const paths = deps.paths ?? runtimePaths();
  const runner = deps.runner ?? run;
  let running = await tmuxHas(runner);
  const token = await readMountedToken(paths.telegramTokenFile, deps.readText);
  const want = launchFingerprint(cfg, token);
  const rec = await readLaunchRecord(paths);
  let action: SyncResult['action'] = running ? 'unchanged' : 'none';
  let reason = running ? 'coordinator is running with the current Telegram configuration' : 'coordinator is not running';
  if (running && rec && rec.fingerprint !== want) {
    const leases = deps.activeLeases().map((l) => l.id);
    reason = rec.channel !== cfg.communication.channel
      ? `communication.channel changed (${rec.channel} -> ${cfg.communication.channel})`
      : 'Telegram configuration changed (bot token or network)';
    if (leases.length && !opts.force) {
      return { action: 'restart-pending', running, reason: `${reason}; restart deferred: ${leases.length} active worker lease(s) (${leases.join(', ')}). Rerun with --force, or after they finish.`, telegram: rec.telegram };
    }
    deps.recordRestart?.({ at: new Date().toISOString(), reason, leases });
    await runner('tmux', ['kill-session', '-t', TMUX_SESSION], { allowFailure: true, timeoutMs: 10_000 });
    running = false;
    action = 'restarted';
  } else if (running && !rec) {
    reason = 'coordinator is running without a launch record (started by an older minions); restart it to apply Telegram settings';
  }
  if (!running && opts.startDetached) {
    const c = await buildCoordinatorCommand(cfg, paths, { detached: true });
    const r = await runner(c.cmd, c.args, { cwd: c.cwd, allowFailure: true, timeoutMs: 30_000 });
    if (r.code !== 0) throw new MinionsError('INCOMPATIBLE_RUNTIME', `Failed to start the coordinator session: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    running = true;
    if (action === 'none') { action = 'started'; reason = 'coordinator started detached'; } else reason += '; coordinator relaunched detached';
  }
  return { action, running, reason, telegram: rec?.telegram ?? null };
}

/** Verifies the installed Claude Code and tmux support what the launcher needs. */
export async function probeRuntime(): Promise<{ claudeVersion: string; tmuxVersion: string }> {
  const ver = await run('claude', ['--version'], { allowFailure: true, timeoutMs: 30_000 });
  if (ver.code !== 0) {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `\`claude --version\` failed (exit ${ver.code}): ${(ver.stderr || ver.stdout).trim().slice(0, 300)}`,
      'Claude Code must be installed in the image (@anthropic-ai/claude-code).');
  }
  const help = await run('claude', ['--help'], { allowFailure: true, timeoutMs: 30_000 });
  const text = help.stdout + help.stderr;
  const missing = ['--plugin-dir', '--append-system-prompt', '--permission-mode', '--settings'].filter((f) => !text.includes(f));
  if (help.code !== 0 || missing.length) {
    throw new MinionsError('INCOMPATIBLE_RUNTIME',
      `Claude Code ${ver.stdout.trim()} does not support required flags: ${missing.join(', ') || '(claude --help failed)'}.`,
      'Use the Claude Code version pinned by the minions image (see docs/compatibility.md).');
  }
  const tmux = await run('tmux', ['-V'], { allowFailure: true, timeoutMs: 10_000 });
  if (tmux.code !== 0) throw new MinionsError('INCOMPATIBLE_RUNTIME', 'tmux is not available in the container.', 'Rebuild the minions image.');
  return { claudeVersion: ver.stdout.trim(), tmuxVersion: tmux.stdout.trim() };
}

/** Launches (or attaches to) the coordinator tmux session with inherited stdio. Resolves with the exit code. */
export async function launchCoordinator(cfg: MinionsConfig, paths: RuntimePaths = runtimePaths()): Promise<number> {
  await probeRuntime();
  const c = await buildCoordinatorCommand(cfg, paths);
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(c.cmd, c.args, { cwd: c.cwd, stdio: 'inherit', shell: false });
    child.on('error', (e) => reject(new MinionsError('INCOMPATIBLE_RUNTIME', `Failed to start tmux: ${e.message}`)));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
