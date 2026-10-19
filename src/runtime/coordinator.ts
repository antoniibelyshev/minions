import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { runtimePaths, type RuntimePaths } from './paths.js';

export const TMUX_SESSION = 'coordinator';

export interface CoordinatorCommand { cmd: string; args: string[]; cwd: string }

/** Claude Code settings passed with --settings: an allowlist for deterministic CLIs; bypass mode disabled. */
export function coordinatorSettings(cfg: MinionsConfig): Record<string, unknown> {
  const allow = ['Bash(minions *)', 'Bash(minions)', 'Bash(git *)', 'Bash(backlog *)'];
  for (const c of cfg.verification.commands) allow.push(`Bash(${c})`, `Bash(${c} *)`);
  return {
    permissions: {
      allow: [...new Set(allow)],
      deny: ['Bash(git push *)', 'Bash(git push)'], // v0.1 delivers locally only
      disableBypassPermissionsMode: 'disable',
    },
  };
}

/** argv for `tmux new-session -A -s coordinator -c <repo> -- claude …` (no shell anywhere). */
export async function buildCoordinatorCommand(cfg: MinionsConfig, paths: RuntimePaths = runtimePaths()): Promise<CoordinatorCommand> {
  if ((cfg.permissionMode as string) === 'bypassPermissions') {
    throw new MinionsError('POLICY_DENIED', 'permissionMode bypassPermissions is never allowed for the coordinator.');
  }
  let prompt: string;
  try { prompt = await readFile(paths.coordinatorPrompt, 'utf8'); } catch (e) {
    throw new MinionsError('NOT_FOUND', `Coordinator prompt not found at ${paths.coordinatorPrompt} (${(e as Error).message}).`,
      'Regenerate the plugin on the host (minions start re-renders it).');
  }
  return {
    cmd: 'tmux',
    cwd: paths.repo,
    args: [
      'new-session', '-A', '-s', TMUX_SESSION, '-c', paths.repo, '--',
      'claude',
      '--plugin-dir', paths.pluginDir,
      '--append-system-prompt', prompt,
      '--permission-mode', cfg.permissionMode,
      '--settings', JSON.stringify(coordinatorSettings(cfg)),
    ],
  };
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
    const child = spawn(c.cmd, c.args, { cwd: c.cwd, stdio: 'inherit', shell: false });
    child.on('error', (e) => reject(new MinionsError('INCOMPATIBLE_RUNTIME', `Failed to start tmux: ${e.message}`)));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}
