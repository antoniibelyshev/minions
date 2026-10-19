import { homedir } from 'node:os';
import { join } from 'node:path';
import { containerPaths } from '../core/paths.js';

/**
 * Agent runtime paths. Defaults are the container paths; the environment overrides them, which is how
 * the host runtime (MINIONS_RUNTIME=host, no Docker) points the same code at <project>/host/...:
 * MINIONS_STATE_DIR (/state), MINIONS_WORKSPACE (/workspace), MINIONS_CONFIG (effective config),
 * MINIONS_SECRETS_DIR (/opt/minions/secrets), MINIONS_PLUGIN_DIR (/opt/minions/plugin) and
 * MINIONS_TMUX_SOCKET (dedicated `tmux -L` server; unset = default server). Tests use them too.
 */
export function runtimePaths(env: NodeJS.ProcessEnv = process.env) {
  const c = containerPaths();
  const state = env.MINIONS_STATE_DIR || c.state;
  const workspace = env.MINIONS_WORKSPACE || c.workspace;
  const secretsDir = env.MINIONS_SECRETS_DIR || c.secretsDir;
  const pluginDir = env.MINIONS_PLUGIN_DIR || c.pluginDir;
  return {
    state,
    db: join(state, 'minions.db'),
    backlog: join(state, 'backlog'),
    notes: join(state, 'notes'),
    import: join(state, 'import'),
    exports: join(state, 'exports'),
    logs: join(state, 'logs'),
    /** Host runtime: MINIONS_LOG_DIR (<project>/host/logs) keeps the unsandboxed hooks' log out of agent-writable dirs. */
    hooksLog: join(env.MINIONS_LOG_DIR || join(state, 'logs'), 'hooks.log'),
    workspace,
    repo: join(workspace, 'repo'),
    worktrees: join(workspace, 'worktrees'),
    review: join(workspace, 'review'),
    configJson: env.MINIONS_CONFIG || c.configJson,
    pluginDir,
    secretsDir,
    telegramTokenFile: join(secretsDir, 'telegram-bot-token'),
    githubTokenFile: join(secretsDir, 'github-token'),
    apiKeyFile: join(secretsDir, 'anthropic-api-key'),
    tmuxSocket: env.MINIONS_TMUX_SOCKET || null,
    /** The official plugin's state dir (same resolution as the plugin: TELEGRAM_STATE_DIR, else CLAUDE_CONFIG_DIR/channels/telegram). */
    telegramStateDir: env.TELEGRAM_STATE_DIR || join(env.CLAUDE_CONFIG_DIR || (env.MINIONS_RUNTIME === 'host' ? join(homedir(), '.claude') : c.claudeHome), 'channels', 'telegram'),
    /** Written by `minions coordinator run`: what the running coordinator was launched with (no secrets). */
    coordinatorLaunch: join(state, 'coordinator-launch.json'),
    coordinatorPrompt: join(pluginDir, 'coordinator.md'),
  };
}
export type RuntimePaths = ReturnType<typeof runtimePaths>;
