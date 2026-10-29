// Headless Claude runs that minions launches (task-96): the coordinator's controlled live runs (`minions coordinator
// live-run`) and, later, the task-57 per-task sessions. Each starts in a fresh, empty CLAUDE_CONFIG_DIR, so it loads
// no plugin of the coordinator's config (the Telegram channel above all: one poller per bot) and cannot take the bot.
// A fresh config dir has no /login state, so the credential comes from the host-provisioned secrets dir:
//
// - login: the headless token the owner stored with `minions auth set login --headless-token` (`claude setup-token`;
//   materialized at <secrets>/claude-headless-token). It reaches the child only in its environment, as
//   CLAUDE_CODE_OAUTH_TOKEN (sk-ant-oat01-…) or ANTHROPIC_API_KEY (sk-ant-api03-…).
// - api-key / helper (jbcentral is a helper preset): no extra owner step. The fresh dir's user settings get the same
//   apiKeyHelper as the coordinator (`cat <secrets>/anthropic-api-key`), so the host-refreshed key file is re-read; the
//   key itself is never copied. claudeAuth.env (e.g. ANTHROPIC_BASE_URL) stays in the inherited environment.
//
// Never: the secret in argv (checked), in a file minions writes (the settings hold only the helper command), in the
// coordinator's config, or in output. Credential variables of the caller's environment (and the Telegram bot token)
// never pass through: the child gets exactly one credential, from this module.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { CONTAINER } from '../core/paths.js';
import { resolveOnPath } from '../host/auth.js';
import { checkClaudeTokenFormat, claudeTokenEnvName } from '../host/credentials.js';
import { apiKeyHelperFor, type RuntimeAuthMethod } from './coordinator.js';
import type { RuntimePaths } from './paths.js';

/** Claude Code re-runs the apiKeyHelper after this TTL (same value as the container env, src/host/auth.ts). */
const KEY_HELPER_TTL_MS = 5 * 60_000;

export type HeadlessCredential =
  | { method: 'login'; envName: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY'; token: string; source: string }
  | { method: 'api-key' | 'helper'; apiKeyHelper: string; source: string };

export type ReadText = (path: string) => Promise<string>;
const defaultRead: ReadText = (p) => readFile(p, 'utf8');

const SETUP_HINT = 'On the host: run `claude setup-token`, then `minions auth set login --headless-token` (the token is prompted without echo, or '
  + 'piped with --stdin). A running container sees it at once; otherwise run `minions start`.';

/**
 * The credential of a headless run for this runtime's auth method (MINIONS_AUTH_METHOD, set by the host). The login
 * token is read from the mounted secrets dir and validated (its shape decides the variable); for the key methods only
 * the key file's presence is checked, its value is left to the apiKeyHelper.
 */
export async function resolveHeadlessCredential(method: RuntimeAuthMethod, paths: Pick<RuntimePaths, 'claudeHeadlessTokenFile' | 'apiKeyFile'>, readText: ReadText = defaultRead): Promise<HeadlessCredential> {
  if (method === 'login') {
    let raw: string;
    try { raw = await readText(paths.claudeHeadlessTokenFile); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new MinionsError('AUTH_REQUIRED', `No headless Claude token at ${paths.claudeHeadlessTokenFile} (${code === 'ENOENT' ? 'not provisioned' : code ?? 'unreadable'}): the login method needs one for runs in a fresh config dir.`, SETUP_HINT);
    }
    let parsed: ReturnType<typeof checkClaudeTokenFormat>;
    try { parsed = checkClaudeTokenFormat(raw); } catch {
      throw new MinionsError('AUTH_REQUIRED', `The headless Claude token at ${paths.claudeHeadlessTokenFile} is not a Claude token.`, SETUP_HINT);
    }
    return { method, envName: claudeTokenEnvName(parsed.kind), token: parsed.token, source: paths.claudeHeadlessTokenFile };
  }
  let present = false;
  try { present = (await readText(paths.apiKeyFile)).trim().length > 0; } catch { present = false; }
  if (!present) {
    throw new MinionsError('AUTH_REQUIRED', `The Claude key is not provisioned at ${paths.apiKeyFile} (${method} method).`,
      'On the host: `minions auth refresh` (or `minions start`), then retry.');
  }
  return { method, apiKeyHelper: apiKeyHelperFor(paths), source: paths.apiKeyFile };
}

/**
 * User settings of the fresh config dir: bypass mode off (as for the coordinator), and the apiKeyHelper for the key
 * methods. Never a secret: the helper is a command that reads the key file.
 */
export function headlessSettings(cred: HeadlessCredential): Record<string, unknown> {
  return {
    permissions: { disableBypassPermissionsMode: 'disable' },
    ...(cred.method === 'login' ? {} : { apiKeyHelper: cred.apiKeyHelper }),
  };
}

/**
 * Variables of the caller's environment that never reach a headless run: every Claude credential (the child gets
 * exactly one, from resolveHeadlessCredential), the config dir (it gets the fresh one), the Telegram bot token and
 * state dir (the coordinator's claude gets them; no other session may poll the bot), other host-provisioned tokens,
 * and the markers of the calling Claude Code session (a nested session would refuse to start or attach to it).
 */
export const HEADLESS_DROP_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CONFIG_DIR',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_STATE_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT',
] as const;

/**
 * The variables minions itself sets for a headless child (pure): the fresh config dir, no auto-update, and the one
 * credential (the login token, or the helper TTL for the key methods). Shared by the live run and the task-57 sessions.
 */
export function credentialEnv(configDir: string, cred: HeadlessCredential): Record<string, string> {
  if (!isAbsolute(configDir)) throw new MinionsError('INTERNAL', 'the headless config dir must be an absolute path');
  // A controlled run never updates the CLI in place.
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: '1' };
  if (cred.method === 'login') env[cred.envName] = cred.token;
  else env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS = String(KEY_HELPER_TTL_MS);
  return env;
}

/** The child's environment (pure): the caller's minus HEADLESS_DROP_ENV, the fresh config dir, and the one credential. */
export function headlessEnv(base: NodeJS.ProcessEnv, configDir: string, cred: HeadlessCredential): Record<string, string> {
  const set = credentialEnv(configDir, cred);
  const drop = new Set<string>(HEADLESS_DROP_ENV);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !drop.has(k)) env[k] = v;
  return Object.assign(env, set);
}

/**
 * The credential part of a headless launch, without any policy check (task-57 phase 4): the credential for the auth
 * method, the fresh config dir's user settings, how the credential reaches the child and the names of the variables
 * minions sets. Each entry point applies its own policy before calling it: `liveRun` refuses while a worker lease is
 * active; the session supervisor does not (its sessions own leases).
 */
export interface HeadlessCredentialPlan {
  cred: HeadlessCredential;
  /** User settings of the fresh config dir (headlessSettings). */
  settings: Record<string, unknown>;
  /** How the credential reaches the child (never the value). */
  credential: string;
  /** Variables minions sets for the child (names only). */
  setEnv: string[];
  /** The value argv must never carry (login method), for checkHeadlessArgs. */
  secret: string | undefined;
}

export async function prepareHeadlessCredential(method: RuntimeAuthMethod, paths: Pick<RuntimePaths, 'claudeHeadlessTokenFile' | 'apiKeyFile'>, readText?: ReadText): Promise<HeadlessCredentialPlan> {
  const cred = await resolveHeadlessCredential(method, paths, readText);
  return {
    cred,
    settings: headlessSettings(cred),
    credential: cred.method === 'login' ? `${cred.envName} in the child's environment (from ${cred.source}; value not shown)` : `apiKeyHelper reading ${cred.source} (fresh config dir settings)`,
    setEnv: ['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', cred.method === 'login' ? cred.envName : 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS'],
    secret: cred.method === 'login' ? cred.token : undefined,
  };
}

// ---------------------------------------------------------------- run dir

export interface HeadlessRunDir {
  /** <scratch root>/headless/run-<random>, 0700. */
  root: string;
  /** CLAUDE_CONFIG_DIR of the run: empty but for settings.json. */
  configDir: string;
}

const privateMkdir = async (dir: string) => { await mkdir(dir, { mode: 0o700 }); await chmod(dir, 0o700); };

/** Creates a fresh run dir under the scratch root (never reused) with the run's settings.json (0600). */
export async function createHeadlessRunDir(paths: Pick<RuntimePaths, 'tmp'>, settings: Record<string, unknown>): Promise<HeadlessRunDir> {
  const parent = join(paths.tmp, 'headless');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const root = join(parent, `run-${randomBytes(12).toString('hex')}`);
  await privateMkdir(root); // fails if it exists
  const d: HeadlessRunDir = { root, configDir: join(root, 'config') };
  try {
    await privateMkdir(d.configDir);
    await writeFile(join(d.configDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) { await removeHeadlessRunDir(d); throw e; }
  return d;
}

/** Removes a run dir; true when it is gone. Never throws. */
export async function removeHeadlessRunDir(d: Pick<HeadlessRunDir, 'root'>): Promise<boolean> {
  try { await rm(d.root, { recursive: true, force: true }); return true; } catch { return false; }
}

// ---------------------------------------------------------------- argv checks (pure)

/** Flags a controlled live run may not pass: no bypass mode, no channels (the Telegram plugin is a channel). */
const REFUSED_FLAGS = ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--channels', '--dangerously-load-development-channels'];

/**
 * Refuses claude arguments that would defeat the isolation: bypass mode (unless the owner configured it: `allowBypass`), channels, any path into the coordinator's
 * own config dir (its plugins, settings or login), and the secret itself. Returns the arguments unchanged.
 */
export function checkHeadlessArgs(args: readonly string[], o: { coordinatorConfigDir: string; secret?: string; allowBypass?: boolean }): string[] {
  const home = o.coordinatorConfigDir.replace(/\/+$/, '');
  for (const [i, a] of args.entries()) {
    const flag = a.split('=')[0]!;
    if (REFUSED_FLAGS.includes(flag)) throw new MinionsError('POLICY_DENIED', `\`${flag}\` is not allowed in a live Claude run.`, 'Live runs keep the permission checks and load no channel.');
    const mode = a === '--permission-mode' ? args[i + 1] : flag === '--permission-mode' ? a.slice(a.indexOf('=') + 1) : undefined;
    if (mode === 'bypassPermissions' && !o.allowBypass) throw new MinionsError('POLICY_DENIED', 'A live Claude run never uses the bypassPermissions mode.');
    if (home && (a === home || a.includes(`${home}/`) || a.endsWith(home))) {
      throw new MinionsError('POLICY_DENIED', `A live Claude run may not use the coordinator's config dir (${home}).`, 'Pass plugin dirs and settings from outside it (for example /opt/minions/plugin).');
    }
    if (o.secret && a.includes(o.secret)) throw new MinionsError('INTERNAL', 'refusing to put a secret in argv');
  }
  return [...args];
}

// ---------------------------------------------------------------- the live run

export interface HeadlessLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** The parts of a child process the live run needs (tests inject a fake). */
export interface ChildLike {
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export type HeadlessSpawn = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; stdio: 'inherit' }) => ChildLike;
const defaultSpawn: HeadlessSpawn = (cmd, args, opts) => nodeSpawn(cmd, args, opts);

export interface LiveRunDeps {
  /** Active worker leases (and unfinished process runs): a live run is refused while there is any. */
  activeLeases: () => { id: string }[];
  method: RuntimeAuthMethod;
  paths: Pick<RuntimePaths, 'claudeHeadlessTokenFile' | 'apiKeyFile' | 'tmp'>;
  env?: NodeJS.ProcessEnv;
  readText?: ReadText;
  spawn?: HeadlessSpawn;
  /** One line for the caller's stderr (never contains a secret). */
  log?: (line: string) => void;
  /** Signals forwarded to the child while it runs. */
  signals?: Pick<NodeJS.Process, 'on' | 'off'>;
}

export interface LiveRunOptions {
  /** Working directory of the run (default: the caller's). */
  cwd?: string;
  /** Keep the run dir (transcripts in its config dir) instead of removing it. */
  keepDir?: boolean;
  /** Only report what would run (nothing is created or spawned; a refusal is reported, not thrown). */
  dryRun?: boolean;
}

/** What a live run did (or would do). Contains no secret: env shows only which variables minions set, not values. */
export interface LiveRunReport {
  dryRun: boolean;
  method: RuntimeAuthMethod;
  /** How the credential reaches the child. */
  credential: string;
  command: string;
  args: string[];
  cwd: string;
  configDir: string | null;
  keptDir: boolean;
  settings: Record<string, unknown>;
  /** Variables minions sets for the child (names only). */
  setEnv: string[];
  /** Why a real run would be refused (dry run only). */
  refused: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function refusal(leases: { id: string }[]): MinionsError | null {
  if (!leases.length) return null;
  const ids = leases.map((l) => l.id);
  return new MinionsError('CONFLICT', `Refusing a live Claude run while ${ids.length} worker lease(s) are active (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}).`,
    'Wait until no worker runs (`minions status`), or drain the queue first (`minions pause --starts --drain`), then retry.');
}

/**
 * `minions coordinator live-run -- <claude args>`: one headless claude in a fresh CLAUDE_CONFIG_DIR with the runtime's
 * credential, stdio inherited (pipe the prompt on stdin), refused while any worker lease is active. The run dir is
 * removed afterwards unless keepDir. Resolves with the report; the caller exits with the child's code.
 */
export async function liveRun(claudeArgs: readonly string[], o: LiveRunOptions, deps: LiveRunDeps): Promise<LiveRunReport> {
  const env = deps.env ?? process.env;
  const leases = deps.activeLeases();
  const refused = refusal(leases);
  if (refused && !o.dryRun) throw refused;
  // The credential part is shared with the session builder (src/runtime/sessions.ts); the lease refusal above is
  // this entry point's own policy.
  const { cred, settings, credential, setEnv, secret } = await prepareHeadlessCredential(deps.method, deps.paths, deps.readText);
  const args = checkHeadlessArgs(claudeArgs, { coordinatorConfigDir: env.CLAUDE_CONFIG_DIR || CONTAINER.claudeHome, secret });
  const command = await resolveOnPath('claude', env.PATH);
  if (!command) throw new MinionsError('PRECONDITION', 'Claude Code (`claude`) is not on PATH.');
  const cwd = o.cwd ?? process.cwd();
  if (!isAbsolute(cwd)) throw new MinionsError('INVALID_CONFIG', '--cwd must be an absolute path.');
  const report: LiveRunReport = { dryRun: !!o.dryRun, method: deps.method, credential, command, args, cwd, configDir: null, keptDir: false, settings, setEnv, refused: refused?.message ?? null, exitCode: null, signal: null };
  if (o.dryRun) return report;

  const dir = await createHeadlessRunDir(deps.paths, settings);
  report.configDir = dir.configDir;
  const launch: HeadlessLaunch = { command, args, cwd, env: headlessEnv(env, dir.configDir, cred) };
  const signals = deps.signals ?? process;
  let child: ChildLike | null = null;
  const forward = (s: NodeJS.Signals) => () => { child?.kill(s); };
  const handlers = (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map((s) => [s, forward(s)] as const);
  try {
    deps.log?.(`live run: ${deps.method} method, ${credential}; config dir ${dir.configDir}`);
    for (const [s, h] of handlers) signals.on(s, h);
    const r = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child = (deps.spawn ?? defaultSpawn)(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    report.exitCode = r.code;
    report.signal = r.signal;
  } catch (e) {
    throw new MinionsError('PRECONDITION', `could not start claude: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    for (const [s, h] of handlers) signals.off(s, h);
    if (o.keepDir) report.keptDir = true;
    else await removeHeadlessRunDir(dir);
  }
  return report;
}

/** The exit code of the live-run command: the child's, 128+n for a signal. */
export const liveRunExitCode = (r: Pick<LiveRunReport, 'exitCode' | 'signal'>) =>
  r.exitCode ?? (r.signal ? 128 + (osConstants.signals[r.signal] ?? 15) : 1);
