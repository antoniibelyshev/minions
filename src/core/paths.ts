import { homedir } from 'node:os';
import { join } from 'node:path';

/** Host data root. MINIONS_HOME overrides (tests). */
export function hostRoot(): string {
  if (process.env.MINIONS_HOME) return process.env.MINIONS_HOME;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Minions');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'minions');
}

export const registryPath = () => join(hostRoot(), 'registry.json');
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
    pluginDir: join(dir, 'plugin'),
    exportsDir: join(dir, 'exports'),
    /** Host-only credential references (never mounted). */
    credentialsJson: join(dir, 'credentials.json'),
    /** Materialized secret files, bind-mounted read-only into the container as a directory. */
    secretsDir: join(dir, 'secrets'),
    githubTokenFile: join(dir, 'secrets', 'github-token'),
    telegramTokenFile: join(dir, 'secrets', 'telegram-bot-token'),
  };
}
export type ProjectPaths = ReturnType<typeof projectPaths>;

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
    configJson: p('/opt/minions/config/config.json'),
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
