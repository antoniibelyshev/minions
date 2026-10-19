import { join } from 'node:path';
import { containerPaths } from '../core/paths.js';

/**
 * Runtime (container) paths. MINIONS_STATE_DIR overrides /state, MINIONS_WORKSPACE overrides
 * /workspace and MINIONS_CONFIG overrides the effective config path and MINIONS_SECRETS_DIR the secrets mount (tests, doctor).
 */
export function runtimePaths(env: NodeJS.ProcessEnv = process.env) {
  const c = containerPaths();
  const state = env.MINIONS_STATE_DIR || c.state;
  const workspace = env.MINIONS_WORKSPACE || c.workspace;
  return {
    state,
    db: join(state, 'minions.db'),
    backlog: join(state, 'backlog'),
    notes: join(state, 'notes'),
    import: join(state, 'import'),
    exports: join(state, 'exports'),
    logs: join(state, 'logs'),
    hooksLog: join(state, 'logs', 'hooks.log'),
    workspace,
    repo: join(workspace, 'repo'),
    worktrees: join(workspace, 'worktrees'),
    review: join(workspace, 'review'),
    configJson: env.MINIONS_CONFIG || c.configJson,
    pluginDir: c.pluginDir,
    secretsDir: env.MINIONS_SECRETS_DIR || c.secretsDir,
    telegramTokenFile: join(env.MINIONS_SECRETS_DIR || c.secretsDir, 'telegram-bot-token'),
    /** The official plugin's state dir (same resolution as the plugin: TELEGRAM_STATE_DIR, else CLAUDE_CONFIG_DIR/channels/telegram). */
    telegramStateDir: env.TELEGRAM_STATE_DIR || join(env.CLAUDE_CONFIG_DIR || c.claudeHome, 'channels', 'telegram'),
    /** Written by `minions coordinator run`: what the running coordinator was launched with (no secrets). */
    coordinatorLaunch: join(state, 'coordinator-launch.json'),
    /** Written by `minions coordinator run` when it exits (code, signal, error; no secrets). Read by a detached start. */
    coordinatorExit: join(state, 'coordinator-exit.json'),
    coordinatorPrompt: c.coordinatorPrompt,
  };
}
export type RuntimePaths = ReturnType<typeof runtimePaths>;
