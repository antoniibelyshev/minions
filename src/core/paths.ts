import { homedir } from 'node:os';
import { join } from 'node:path';

/** Host data root. MINIONS_HOME overrides (tests). */
export function hostRoot(): string {
  if (process.env.MINIONS_HOME) return process.env.MINIONS_HOME;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Minions');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'minions');
}

export const registryPath = () => join(hostRoot(), 'registry.json');
/** Host-wide defaults applied to new projects at init (e.g. { claudeAuth }). */
export const defaultsPath = () => join(hostRoot(), 'defaults.json');
/** Host credential store for the file backend (0700 dirs, 0600 files). Never mounted into a container. */
export const credentialStoreDir = () => join(hostRoot(), 'credentials');
export const credentialStoreFile = (projectId: string, name: string) => join(credentialStoreDir(), projectId, name);
export const projectDir = (projectId: string) => join(hostRoot(), 'projects', projectId);

export function projectPaths(projectId: string) {
  const dir = projectDir(projectId);
  return {
    dir,
    projectJson: join(dir, 'project.json'),
    configJson: join(dir, 'config.json'),
    configLocalJson: join(dir, 'config.local.json'),
    manifestJson: join(dir, 'manifest.json'),
    journalJson: join(dir, 'journal.json'),
    composeYaml: join(dir, 'compose.yaml'),
    runtimeDir: join(dir, 'runtime'),
    runtimeConfigJson: join(dir, 'runtime', 'config.json'),
    /** Public half of the host-held approval signing key (read-only for agents; see src/host/approvals.ts). */
    approvalPublicKey: join(dir, 'runtime', 'approval-public-key.pem'),
    pluginDir: join(dir, 'plugin'),
    /** Host-side plugin of the setup assistant (`minions setup assist`), regenerated on every launch. */
    assistantPluginDir: join(dir, 'assistant-plugin'),
    exportsDir: join(dir, 'exports'),
    /** Host-only credential references (never mounted). */
    credentialsJson: join(dir, 'credentials.json'),
    /**
     * Host-provisioned secret files (dir 0700, files 0600), bind-mounted read-only as a directory at
     * /opt/minions/secrets: the Claude key copy plus materialized GitHub/Telegram tokens.
     */
    secretsDir: join(dir, 'secrets'),
    apiKeyFile: join(dir, 'secrets', 'anthropic-api-key'),
    githubTokenFile: join(dir, 'secrets', 'github-token'),
    telegramTokenFile: join(dir, 'secrets', 'telegram-bot-token'),
    /** Non-secret record of the last key refresh (time, redacted error). */
    authStateJson: join(dir, 'auth-state.json'),
    logsDir: join(dir, 'logs'),
    /** Host runtime (no Docker) only: the agents' own clone, state, and PATH shims. */
    hostDir: join(dir, 'host'),
  };
}
export type ProjectPaths = ReturnType<typeof projectPaths>;

/**
 * Host runtime layout (`runtime: "host"` in project.json). The agents never work in the user's
 * checkout: they get a separate clone under <project>/host/workspace, seeded from a Git bundle of the
 * base branch exactly like the container workspace.
 */
export function hostRuntimePaths(projectId: string) {
  const root = join(projectDir(projectId), 'host');
  return {
    root,
    workspace: join(root, 'workspace'),
    repo: join(root, 'workspace', 'repo'),
    state: join(root, 'state'),
    /** Tool caches (npm, XDG, corepack, pip, ...) of the agents: inside the state dir, never ~/.npm or ~/.cache. */
    cache: join(root, 'state', 'cache'),
    /**
     * Bundle transfer dirs owned by the host CLI (not agent-writable: the sandbox may write only the
     * workspace and state): bundles are never copied through a path an agent could swap for a symlink.
     */
    transfer: join(root, 'transfer'),
    import: join(root, 'transfer', 'import'),
    exports: join(root, 'transfer', 'exports'),
    /** Logs written by unsandboxed hook processes (MINIONS_LOG_DIR); outside the agent-writable dirs. */
    logs: join(root, 'logs'),
    /** PATH shims: `minions` (pins the runtime environment) and the `gh` token wrapper. */
    bin: join(root, 'bin'),
    minionsShim: join(root, 'bin', 'minions'),
    ghShim: join(root, 'bin', 'gh'),
    /**
     * Dedicated tmux server socket name (`tmux -L`), so the user's own tmux server is never touched.
     * tmux keeps it in its private per-user directory (/tmp/tmux-<uid>, 0700, ownership-checked);
     * sandboxed commands get no Unix sockets and no access to that directory (see hostSettings). A
     * `-S <project>/host/...` socket is not used: that path exceeds the 104-byte macOS socket path limit.
     */
    tmuxSocket: `minions-${shortId(projectId)}`,
  };
}
export type HostRuntimePaths = ReturnType<typeof hostRuntimePaths>;

/** Shared-install files inside the repository. */
export function repoPaths(repoPath: string) {
  const dir = join(repoPath, '.minions');
  return { dir, configJson: join(dir, 'config.json'), readme: join(dir, 'README.md') };
}

/** Container paths; MINIONS_CONTAINER_ROOT prefixes them (tests only). */
export function containerPaths(root = process.env.MINIONS_CONTAINER_ROOT ?? '') {
  const p = (s: string) => root + s;
  return {
    pluginDir: p('/opt/minions/plugin'),
    coordinatorPrompt: p('/opt/minions/plugin/coordinator.md'),
    configDir: p('/opt/minions/config'),
    secretsDir: p('/opt/minions/secrets'),
    githubTokenFile: p('/opt/minions/secrets/github-token'),
    telegramTokenFile: p('/opt/minions/secrets/telegram-bot-token'),
    /** Host-provisioned Claude key (api-key/helper methods), read by the in-container apiKeyHelper. */
    apiKeyFile: p('/opt/minions/secrets/anthropic-api-key'),
    configJson: p('/opt/minions/config/config.json'),
    /** Public key that verifies host-signed publication approvals (the private key never enters the container). */
    approvalPublicKey: p('/opt/minions/config/approval-public-key.pem'),
    projectJson: p('/opt/minions/config/project.json'),
    workspace: p('/workspace'),
    repo: p('/workspace/repo'),
    worktrees: p('/workspace/worktrees'),
    review: p('/workspace/review'),
    state: p('/state'),
    db: p('/state/minions.db'),
    backlog: p('/state/backlog'),
    notes: p('/state/notes'),
    import: p('/state/import'),
    exports: p('/state/exports'),
    claudeHome: p('/home/node/.claude'),
    cache: p('/home/node/.cache'),
    /**
     * Disk-backed scratch dir (TMPDIR) on the cache volume: exec-allowed (the /tmp and /home/node tmpfs
     * mounts are noexec), outside every git checkout, and not counted against the container memory limit.
     */
    scratch: p('/home/node/.cache/tmp'),
    /** Official Telegram plugin state (access.json, .env, pairing codes); owned by the plugin. */
    telegramStateDir: p('/home/node/.claude/channels/telegram'),
  };
}
export const CONTAINER = containerPaths('');

/**
 * In-container path of the GitHub token (read-only). The directory is bind-mounted, not the file,
 * so atomic host-side replacements (new inode) stay visible to a running container.
 */
export const GITHUB_TOKEN_CONTAINER_PATH = CONTAINER.githubTokenFile;
/** In-container path of the Telegram bot token (read-only; read only by `minions coordinator run`). */
export const TELEGRAM_TOKEN_CONTAINER_PATH = CONTAINER.telegramTokenFile;

export const SERVICE_NAME = 'app';
export const shortId = (projectId: string) => projectId.slice(0, 8).toLowerCase();
export const composeProjectName = (projectId: string) => `minions-${shortId(projectId)}`;
export function volumeNames(projectId: string) {
  const b = composeProjectName(projectId);
  return { workspace: `${b}-workspace`, state: `${b}-state`, claude: `${b}-claude`, cache: `${b}-cache` };
}
export const imageTag = (packageVersion: string) => `minions-runtime:${packageVersion}`;
