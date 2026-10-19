import { join } from 'node:path';
import { containerPaths } from '../core/paths.js';

/**
 * Runtime (container) paths. MINIONS_STATE_DIR overrides /state, MINIONS_WORKSPACE overrides
 * /workspace and MINIONS_CONFIG overrides the effective config path (tests, doctor).
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
    coordinatorPrompt: c.coordinatorPrompt,
  };
}
export type RuntimePaths = ReturnType<typeof runtimePaths>;
