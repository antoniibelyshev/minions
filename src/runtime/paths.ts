import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { APPROVAL_PUBLIC_KEY_NAME } from '../core/approval.js';
import { containerPaths } from '../core/paths.js';

/**
 * Literal container paths for the approval verifier. Deliberately not derived from containerPaths()
 * (MINIONS_CONTAINER_ROOT) or any other env var: in-container code can set those.
 */
export const CONTAINER_CONFIG_DIR = '/opt/minions/config';
export const CONTAINER_APPROVAL_PUBLIC_KEY = `${CONTAINER_CONFIG_DIR}/${APPROVAL_PUBLIC_KEY_NAME}`;

/**
 * True inside the minions container, decided by the filesystem (the read-only config bind exists),
 * not by MINIONS_RUNTIME, which an agent can unset. The host runtime has no such directory.
 */
export const inMinionsContainer = (): boolean => existsSync(CONTAINER_CONFIG_DIR);

/**
 * Public key verifying host-signed publication approvals. In the container (detected from the
 * filesystem, or MINIONS_RUNTIME=container) it is always the literal read-only bind path, whatever
 * MINIONS_CONTAINER_ROOT, MINIONS_CONFIG or MINIONS_RUNTIME say. Only the host runtime (no container
 * dir) uses its runtime config dir, which the shim pins via MINIONS_CONFIG. `inContainer` is
 * injectable for tests (which may themselves run inside a minions container).
 */
export function approvalPublicKeyPath(env: NodeJS.ProcessEnv = process.env, inContainer: boolean = inMinionsContainer()): string {
  if (inContainer || env.MINIONS_RUNTIME === 'container' || !env.MINIONS_CONFIG) return CONTAINER_APPROVAL_PUBLIC_KEY;
  return join(dirname(env.MINIONS_CONFIG), APPROVAL_PUBLIC_KEY_NAME);
}

/**
 * Why no approval public key could be read from `file`, naming the path tried. The host runtime with
 * MINIONS_CONFIG unset falls back to the container's literal path, which never exists on the host:
 * that is a misconfigured launch (the shim always sets MINIONS_CONFIG), not a missing first approval.
 * Verification fails closed either way; this only makes the reason accurate.
 */
export function missingApprovalKeyReason(file: string, env: NodeJS.ProcessEnv = process.env, inContainer: boolean = inMinionsContainer()): string {
  if (!inContainer && env.MINIONS_RUNTIME === 'host' && !env.MINIONS_CONFIG) {
    return `no approval public key at ${file}: this is the host runtime but MINIONS_CONFIG is unset, so the verifier fell back to the container path; ` +
      'start the host runtime through `minions start` (its shim sets MINIONS_CONFIG to the runtime config dir that holds the key)';
  }
  return `no approval public key at ${file} (the host writes it on the first \`minions work approve\`)`;
}

/**
 * Agent runtime paths. Defaults are the container paths; the environment overrides them, which is how
 * the host runtime (MINIONS_RUNTIME=host, no Docker) points the same code at <project>/host/...:
 * MINIONS_STATE_DIR (/state), MINIONS_WORKSPACE (/workspace), MINIONS_CONFIG (effective config),
 * MINIONS_SECRETS_DIR (/opt/minions/secrets), MINIONS_PLUGIN_DIR (/opt/minions/plugin) and
 * MINIONS_TMUX_SOCKET (dedicated `tmux -L` server; unset = default server) and MINIONS_SCRATCH_DIR
 * (scratch root, default the container TMPDIR). Tests use them too.
 */
export function runtimePaths(env: NodeJS.ProcessEnv = process.env, opts: { inContainer?: boolean } = {}) {
  const c = containerPaths();
  const state = env.MINIONS_STATE_DIR || c.state;
  const workspace = env.MINIONS_WORKSPACE || c.workspace;
  const secretsDir = env.MINIONS_SECRETS_DIR || c.secretsDir;
  const pluginDir = env.MINIONS_PLUGIN_DIR || c.pluginDir;
  // Scratch root: the container's TMPDIR on the cache volume. A redirected state dir (host runtime,
  // tests) keeps it inside that state dir (<state>/cache/tmp), never in the container path.
  const tmp = env.MINIONS_SCRATCH_DIR || (env.MINIONS_STATE_DIR ? join(state, 'cache', 'tmp') : c.scratch);
  return {
    state,
    db: join(state, 'minions.db'),
    backlog: join(state, 'backlog'),
    notes: join(state, 'notes'),
    /** Stored worker briefs (`work claim` writes, `work brief` reads). */
    briefs: join(state, 'briefs'),
    /** Submitted worker results (`work submit` writes, `work record --submitted` reads). */
    results: join(state, 'results'),
    import: join(state, 'import'),
    exports: join(state, 'exports'),
    logs: join(state, 'logs'),
    /** Disk-backed, exec-allowed scratch root (the container's TMPDIR; MINIONS_SCRATCH_DIR overrides). */
    tmp,
    /** Per-lease scratch dirs `<scratch>/<leaseId>`: created at claim, removed when the lease ends and on coordinator start. */
    scratch: join(tmp, 'leases'),
    /** The minions-owned TMPDIR root the start-time stale sweep may clean: only the default, never an overridden (possibly shared) MINIONS_SCRATCH_DIR. */
    tmpRoot: env.MINIONS_SCRATCH_DIR ? undefined : tmp,
    /** Flag file present while a drain is requested (`minions pause --drain`); the worker drain hook tests only for it. */
    drainFlag: join(state, 'run', 'drain'),
    /** Host runtime: MINIONS_LOG_DIR (<project>/host/logs) keeps the unsandboxed hooks' log out of agent-writable dirs. */
    hooksLog: join(env.MINIONS_LOG_DIR || join(state, 'logs'), 'hooks.log'),
    workspace,
    repo: join(workspace, 'repo'),
    worktrees: join(workspace, 'worktrees'),
    review: join(workspace, 'review'),
    configJson: env.MINIONS_CONFIG || c.configJson,
    /** Public key verifying host-signed publication approvals (see approvalPublicKeyPath; never env-redirectable in the container). */
    approvalPublicKey: approvalPublicKeyPath(env, opts.inContainer ?? inMinionsContainer()),
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
    /** Written by `minions coordinator run` when it exits (code, signal, error; no secrets). Read by a detached start. */
    coordinatorExit: join(state, 'coordinator-exit.json'),
    coordinatorPrompt: join(pluginDir, 'coordinator.md'),
  };
}
export type RuntimePaths = ReturnType<typeof runtimePaths>;
