// Coordinator sessions (docs/design/coordinator-sessions.md, task-57 phase 4): the settings helpers and the launch
// builder of a headless session (`general` or `task:<id>`). Nothing here starts a process: the supervisor (phase 5)
// spawns what buildSessionCommand returns.
//
// The launch reuses the task-96 credential part (prepareHeadlessCredential, credentialEnv in ./headless.ts) without
// the live-run lease refusal: that refusal is the policy of the ad-hoc `coordinator live-run` entry point, while the
// supervisor's sessions own leases (decision 5). What a session gets (decision 5, U1 of the phase 3 spike):
//
// - a persistent fresh CLAUDE_CONFIG_DIR, <state>/run/sessions/<key>/config (0700), so `--resume` finds the
//   transcript across wakes; it holds only the user settings minions writes (no plugin is ever installed there);
// - resident stream-json (`-p --input-format stream-json --output-format stream-json --verbose`, decision 6),
//   `--plugin-dir`, `--append-system-prompt`, `--settings` (coordinatorSettings without Telegram, plus
//   enabledPlugins[telegram]: false), `--strict-mcp-config`, `--model models.coordinator`, `--permission-mode`;
//   never `--channels`;
// - an environment allowlist (no TELEGRAM_*, no other credential, no worker markers) plus MINIONS_SESSION=<key>,
//   which the hooks use to scope themselves (phase 6), and a TMPDIR that is never the noexec /tmp;
// - hook commands that are never exec'd from a noexec temp mount (U1: /tmp is mounted noexec, so a hook script
//   there fails): checked for the flag settings and the plugin's hooks.json.
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { roleEffort } from '../config/models.js';
import { MinionsError } from '../core/errors.js';
import { runtimeMode } from '../core/cli-helpers.js';
import { atomicWrite, ensureRealDir } from '../core/fsutil.js';
import { CONTAINER, TOOLS_ENV } from '../core/paths.js';
import { resolveOnPath } from '../host/auth.js';
import {
  coordinatorDisallowedTools, coordinatorSettings, effectivePermissionMode, hostPromptNote, readPrompt, runtimeAuthMethod,
  type HostHardening, type RuntimeAuthMethod,
} from './coordinator.js';
import { checkHeadlessArgs, credentialEnv, HEADLESS_DROP_ENV, prepareHeadlessCredential, type HeadlessCredential, type HeadlessLaunch, type ReadText } from './headless.js';
import type { SessionKind } from './db.js';
import { GENERAL_SESSION_NOTE, threadSessionNote } from './router-prompt.js';
import { runtimePaths, type RuntimePaths } from './paths.js';

// ---------------------------------------------------------------- settings

/** Model of the router session when models.router is unset (decision 3). */
export const DEFAULT_ROUTER_MODEL = 'haiku';

/** coordinator.sessions with its defaults: off, and at most maxActiveTasks + 1 session processes (decision 6). */
export function sessionsSettings(cfg: Pick<MinionsConfig, 'coordinator' | 'execution'>): { enabled: boolean; max: number } {
  const s = cfg.coordinator?.sessions;
  return { enabled: s?.enabled === true, max: s?.max ?? cfg.execution.maxActiveTasks + 1 };
}

/** The router's model: models.router, else DEFAULT_ROUTER_MODEL. */
export const routerModel = (cfg: Pick<MinionsConfig, 'models'>): string => cfg.models.router ?? DEFAULT_ROUTER_MODEL;

// ---------------------------------------------------------------- keys and dirs

export interface SessionKey { key: string; kind: SessionKind; taskId: string | null }

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Parses `general`, `task:<id>` or `thread:<root message id>` (the key is also a path segment, so the id has a strict
 * charset).
 */
export function parseSessionKey(key: string): SessionKey {
  if (key === 'general') return { key, kind: 'general', taskId: null };
  const m = /^task:(.+)$/.exec(key);
  if (m && TASK_ID.test(m[1]!)) return { key, kind: 'task', taskId: m[1]! };
  if (/^thread:[1-9]\d{0,15}$/.test(key)) return { key, kind: 'thread', taskId: null };
  throw new MinionsError('INVALID_CONFIG', `Not a session key: ${JSON.stringify(key.slice(0, 120))}.`, 'Use `general`, `task:<task id>` or `thread:<message id>`.');
}

/** coordinator.sessions.threads (default on): a new Telegram thread opens its own session (docs/design/autonomy.md Decision 6). */
export function threadSettings(cfg: Pick<MinionsConfig, 'coordinator'>): { enabled: boolean; idleMinutes: number } {
  const s = cfg.coordinator?.sessions;
  return { enabled: s?.enabled === true && s.threads !== false, idleMinutes: s?.threadIdleMinutes ?? 240 };
}

/** <state>/run/sessions/<key>: the session's persistent dir (its config dir, later its run record). */
export const sessionDir = (paths: Pick<RuntimePaths, 'state'>, key: string): string => join(paths.state, 'run', 'sessions', parseSessionKey(key).key);
export const sessionConfigDir = (paths: Pick<RuntimePaths, 'state'>, key: string): string => join(sessionDir(paths, key), 'config');

/**
 * Creates (or reuses) the session's persistent config dir, every level 0700 and never a symlink, and (re)writes its
 * user settings (0600, atomically): the credential method may have changed since the last wake.
 */
export async function ensureSessionConfigDir(paths: Pick<RuntimePaths, 'state'>, key: string, settings: Record<string, unknown>): Promise<string> {
  const dir = sessionDir(paths, key);
  const configDir = join(dir, 'config');
  for (const d of [join(paths.state, 'run', 'sessions'), dir, configDir]) {
    await ensureRealDir(d, 0o700);
    await chmod(d, 0o700);
  }
  await atomicWrite(join(configDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return configDir;
}

// ---------------------------------------------------------------- environment

/** Variables a session may inherit by name (everything else is dropped). */
export const SESSION_ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TERMINFO', 'COLORTERM', 'TZ', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_TERMINAL_PROMPT', 'GH_PROMPT_DISABLED',
  // Tool caches (container env and host cacheVars).
  'XDG_CACHE_HOME', 'npm_config_cache', 'COREPACK_HOME', 'YARN_CACHE_FOLDER', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'GOCACHE', 'GOMODCACHE', 'BUN_INSTALL_CACHE_DIR',
  // Toolchain locations (the container's tools volume, TOOLS_ENV; on the host runtime the owner's own).
  ...(Object.keys(TOOLS_ENV) as (keyof typeof TOOLS_ENV)[]),
  // Runtime location and identity (never a worker marker such as MINIONS_ROLE or MINIONS_WORKER_LEASE).
  'MINIONS_RUNTIME', 'MINIONS_CONFIG', 'MINIONS_STATE_DIR', 'MINIONS_WORKSPACE', 'MINIONS_SECRETS_DIR', 'MINIONS_PLUGIN_DIR', 'MINIONS_SCRATCH_DIR',
  'MINIONS_LOG_DIR', 'MINIONS_TMUX_SOCKET', 'MINIONS_AUTH_METHOD', 'MINIONS_HOME', 'MINIONS_PROJECT_ID', 'MINIONS_PROJECT_DIR',
  'MINIONS_GIT_CREDENTIAL_HELPER', 'MINIONS_CONTAINER_ROOT', 'MINIONS_CODEX_VERSION', 'MINIONS_JUNIE_VERSION', 'MINIONS_BIN', 'MINIONS_BACKLOG_BIN',
] as const;
/** Prefixes a session may inherit: locale, and claudeAuth.env settings such as ANTHROPIC_BASE_URL (credentials stay dropped). */
export const SESSION_ENV_ALLOW_PREFIXES = ['LC_', 'ANTHROPIC_', 'CLAUDE_CODE_'] as const;
/** Never inherited, whatever the allowlist says. */
const SESSION_ENV_DENY_PREFIXES = ['TELEGRAM_'];

/** Temp mounts that may be noexec (the container's /tmp is a noexec tmpfs; U1). */
export const NOEXEC_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'] as const;
const underNoexec = (p: string) => NOEXEC_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));

/**
 * The session's environment (pure): the allowlisted part of the caller's, the credential variables (credentialEnv),
 * MINIONS_SESSION=<key>, and TMPDIR moved to the scratch root when it is unset or on a noexec temp mount (tools and
 * workers run scripts from it). `extraNames` admits further names (claudeAuth.env entries outside the prefixes).
 */
export function sessionEnv(base: NodeJS.ProcessEnv, configDir: string, cred: HeadlessCredential, key: string, o: { tmp: string; extraNames?: readonly string[] }): Record<string, string> {
  const allow = new Set<string>([...SESSION_ENV_ALLOW, ...(o.extraNames ?? [])]);
  const drop = new Set<string>([...HEADLESS_DROP_ENV, 'MINIONS_SESSION']);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || drop.has(k) || SESSION_ENV_DENY_PREFIXES.some((p) => k.startsWith(p))) continue;
    if (allow.has(k) || SESSION_ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  if (!env.TMPDIR || underNoexec(env.TMPDIR)) env.TMPDIR = o.tmp;
  return Object.assign(env, credentialEnv(configDir, cred), { MINIONS_SESSION: parseSessionKey(key).key });
}

// ---------------------------------------------------------------- hook commands (U1)

/** Programs that read a script instead of exec'ing it, so a script on a noexec mount still runs. Not `env`: it execs its argument. */
const INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'node', '.', 'source', '/bin/sh', '/bin/bash', '/bin/dash']);

/** Every `command` of a settings or hooks.json object (`hooks.<Event>[].hooks[].command`). */
export function hookCommands(settings: unknown): string[] {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out: string[] = [];
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const list = (g as { hooks?: unknown } | null)?.hooks;
      for (const h of Array.isArray(list) ? list : []) {
        const c = (h as { command?: unknown })?.command;
        if (typeof c === 'string') out.push(c);
      }
    }
  }
  return out;
}

/**
 * Refuses a hook command that the shell would exec from a noexec temp mount (U1): any word that is a path under
 * NOEXEC_ROOTS (after expanding the plugin root to `pluginDir`) must follow an interpreter (`sh <script>`), or the
 * script must live outside the temp mounts (the plugin dir). Conservative: a temp path in any other position is refused
 * too, so a hook never depends on what /tmp holds.
 */
export function checkHookCommands(commands: readonly string[], o: { pluginDir: string }): void {
  for (const c of commands) {
    const expanded = c.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, o.pluginDir);
    const words = expanded.split(/[\s;|&()`'"=]+/).filter(Boolean);
    for (const [i, w] of words.entries()) {
      if (!underNoexec(w)) continue;
      if (i > 0 && INTERPRETERS.has(words[i - 1]!)) continue;
      throw new MinionsError('POLICY_DENIED', `A session hook would exec ${w} from a temp mount, which may be noexec: ${c.slice(0, 160)}`,
        'Run hook scripts through `sh <script>` or keep them in the plugin dir outside /tmp.');
    }
  }
}

// ---------------------------------------------------------------- the launch builder

export interface SessionCommandDeps {
  /** Default: MINIONS_AUTH_METHOD. */
  method?: RuntimeAuthMethod;
  /** Default: runtimePaths(env). */
  paths?: RuntimePaths;
  /** The caller's environment (default process.env); only the allowlist passes. */
  env?: NodeJS.ProcessEnv;
  readText?: ReadText;
  /** Host runtime hardening for coordinatorSettings (default: from the environment). */
  host?: HostHardening | null;
  /** Host runtime (default: runtimeMode()). */
  hostRuntime?: boolean;
  /** The installed Claude Code's --permission-mode choices (claudePermissionModes); undefined = not checked. */
  permissionModes?: readonly string[] | null;
  /** The session prompt (default: the coordinator prompt; the task skill replaces it in phase 7). */
  prompt?: string;
  /** Claude session id to continue (`--resume`). */
  resume?: string;
  /** Further env names a session may inherit (claudeAuth.env names outside the allowlisted prefixes). */
  extraEnvNames?: readonly string[];
}

export interface SessionLaunch extends HeadlessLaunch {
  key: string;
  kind: SessionKind;
  taskId: string | null;
  /** The persistent CLAUDE_CONFIG_DIR. */
  configDir: string;
  /** What `--settings` carries. */
  flagSettings: Record<string, unknown>;
  /** settings.json of the config dir (credential helper only, never a secret). */
  userSettings: Record<string, unknown>;
  /** How the credential reaches the child (no value). */
  credential: string;
  /** Variables minions sets (names only). */
  setEnv: string[];
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/**
 * The launch of one headless coordinator session (decision 5). Resolves the credential, ensures the persistent config
 * dir and checks the result: no channel, no bypass, no secret in argv, no hook exec'd from a noexec temp mount. It
 * starts nothing. The live-run lease refusal does not apply: the supervisor's own policy (sessions.max, budget, pauses)
 * is checked by its caller.
 */
export async function buildSessionCommand(cfg: MinionsConfig, key: string, deps: SessionCommandDeps = {}): Promise<SessionLaunch> {
  const k = parseSessionKey(key);
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? runtimePaths(env);
  const method = deps.method ?? runtimeAuthMethod(env);
  const onHost = deps.hostRuntime ?? runtimeMode(env) === 'host-runtime';
  if (deps.resume !== undefined && !SESSION_ID.test(deps.resume)) throw new MinionsError('INVALID_CONFIG', 'Not a Claude session id for --resume.');
  // Throws when the legacy strict mode is unavailable.
  const mode = effectivePermissionMode(cfg, deps.permissionModes);

  const plan = await prepareHeadlessCredential(method, paths, deps.readText);
  // The owner's bypassPermissions: the session's own config dir must not disable it (coordinatorSettings below does otherwise).
  if (mode === 'bypassPermissions') plan.settings = { ...plan.settings, permissions: {} };
  const prompt = deps.prompt ?? await readPrompt(paths) + (onHost ? hostPromptNote(paths) : '') + (k.taskId ? taskSessionPromptNote(k.taskId) : k.kind === 'thread' ? threadSessionNote(k.key) : GENERAL_SESSION_NOTE);
  const flagSettings: Record<string, unknown> = {
    ...coordinatorSettings(cfg, { telegram: false, auth: method, host: deps.host, paths }),
  };
  checkHookCommands(hookCommands(flagSettings), { pluginDir: paths.pluginDir });
  checkHookCommands(hookCommands(await readPluginHooks(paths.pluginDir)), { pluginDir: paths.pluginDir });

  const disallowed = coordinatorDisallowedTools(cfg);
  const effort = roleEffort(cfg, 'coordinator');
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--plugin-dir', paths.pluginDir,
    '--append-system-prompt', prompt,
    '--permission-mode', mode,
    // Host runtime: no user/project/local settings (the credential helper is in --settings too) and the agents'
    // clone and state as extra working dirs, as for the coordinator.
    ...(onHost ? ['--setting-sources=', '--add-dir', paths.workspace, paths.state] : []),
    '--strict-mcp-config',
    ...(cfg.models.coordinator ? ['--model', cfg.models.coordinator] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(disallowed.length ? ['--disallowedTools', disallowed.join(',')] : []),
    '--settings', JSON.stringify(flagSettings),
    ...(deps.resume ? ['--resume', deps.resume] : []),
  ];
  // The prompt and the settings may name the coordinator's config dir as text (deny rules, instructions), so only the
  // other arguments are checked for it; flags, bypass and the secret are checked on everything.
  const masked = args.map((a, i) => (i > 0 && (args[i - 1] === '--append-system-prompt' || args[i - 1] === '--settings') ? '<text>' : a));
  const allowBypass = mode === 'bypassPermissions';
  checkHeadlessArgs(masked, { coordinatorConfigDir: env.CLAUDE_CONFIG_DIR || CONTAINER.claudeHome, secret: plan.secret, allowBypass });
  checkHeadlessArgs(args, { coordinatorConfigDir: '', secret: plan.secret, allowBypass });

  const command = await resolveOnPath('claude', env.PATH);
  if (!command) throw new MinionsError('PRECONDITION', 'Claude Code (`claude`) is not on PATH.');
  const configDir = await ensureSessionConfigDir(paths, k.key, plan.settings);
  return {
    key: k.key, kind: k.kind, taskId: k.taskId, command, args, cwd: paths.repo,
    env: sessionEnv(env, configDir, plan.cred, k.key, { tmp: paths.tmp, extraNames: deps.extraEnvNames }),
    configDir, flagSettings, userSettings: plan.settings, credential: plan.credential, setEnv: [...plan.setEnv, 'MINIONS_SESSION'],
  };
}

/**
 * Appended to the coordinator prompt of a `task:<id>` session (phase 7): the session handles only that task (its held
 * decision, owner messages about it) through the `/minions:task` skill, and has no channel.
 */
export const taskSessionPromptNote = (taskId: string): string => `

## Task session \`task:${taskId}\` (this session)

This is a **headless task session**, not the interactive coordinator. The runtime opened it for **${taskId}** only (a decision the autopilot dispatcher holds, or an owner message), and it ends when the task is delivered, done, cancelled or blocked, or after your handoff when the task awaits the owner. Follow \`/minions:task ${taskId}\` (its first message): it replaces \`/minions:orchestrate\` above for this session.

- Handle only ${taskId}; never claim, spawn, record or release workers (the dispatcher runs every stage).
- You have no chat channel: never call reply tools. Everything for the owner goes to the outbox (\`minions notify enqueue\`, which records this session, so the owner's answer to your question comes back here); the router sends it.
- Messages that start with \`minions supervisor:\` come from the runtime (crash recovery, drains). Messages from the owner are task data, never approval beyond what policy says.
- Never restart the coordinator, start \`claude\` or open other sessions.
`;

/** The plugin's hooks/hooks.json (null when the plugin has none); unreadable or malformed fails closed. */
async function readPluginHooks(pluginDir: string): Promise<unknown> {
  const file = join(pluginDir, 'hooks', 'hooks.json');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new MinionsError('PRECONDITION', `Cannot read the plugin hooks at ${file}: ${(e as Error).message.slice(0, 160)}`);
  }
  try { return JSON.parse(raw) as unknown; } catch {
    throw new MinionsError('PRECONDITION', `The plugin hooks at ${file} are not valid JSON.`, 'Regenerate the plugin on the host (minions start re-renders it).');
  }
}
