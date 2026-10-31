// How the dispatcher starts a worker (docs/design/autonomy.md Decision 1). Two kinds, as `work next` reports them:
//
// - a Claude role: `claude -p --agent minions:<role>` in the lease worktree, headless, with the task-96 credential in
//   a fresh per-lease CLAUDE_CONFIG_DIR, no channel (--strict-mcp-config, Telegram off), the coordinator's permission
//   mode and settings (its allow list and, on the host runtime, its sandbox: exactly what a subagent had), and a
//   plugin generated from the *current* config so role, prompt, model and tool changes apply to the next stage.
//   The worker env carries MINIONS_WORKER_LEASE / MINIONS_WORKER_ROLE, which the hooks treat as "a worker".
// - a process-harness role: `minions work run <leaseId> --json`, the existing runner (it submits by proxy).
//
// Both run under runner/supervise.ts: own process group, wall-clock limit, drain grace, stop when the lease ends.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { runtimeMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, ensureRealDir } from '../core/fsutil.js';
import { CONTAINER } from '../core/paths.js';
import { resolveOnPath } from '../host/auth.js';
import { generatePlugin } from '../plugin/generate.js';
import { TELEGRAM_PLUGIN_ID } from '../telegram/probe.js';
import { coordinatorSettings, effectivePermissionMode, runtimeAuthMethod, type HostHardening, type RuntimeAuthMethod } from './coordinator.js';
import type { RuntimeDb } from './db.js';
import { dispatchRunDir, workerPrompt, type LaunchInput, type WorkerExit, type WorkerHandle } from './dispatcher.js';
import { checkHeadlessArgs, credentialEnv, HEADLESS_DROP_ENV, prepareHeadlessCredential, type HeadlessCredential, type ReadText } from './headless.js';
import { WORKER_LEASE_ENV, WORKER_ROLE_ENV } from './hooks.js';
import type { RuntimePaths } from './paths.js';
import { DEFAULT_TIMING, supervise, type SpawnSpec, type StopReason } from './runner/supervise.js';
import { readManifest, secretEnv, secretManifestPath } from './secrets.js';
import { SESSION_ENV_ALLOW, SESSION_ENV_ALLOW_PREFIXES } from './sessions.js';

/** Plugin dirs kept under <state>/run/dispatch/plugin (one per config the dispatcher has run workers with). */
const KEEP_PLUGINS = 4;

export interface WorkerCommand { argv: string[]; cwd: string; env: Record<string, string>; stdin: string; kind: 'claude' | 'run' }

export interface WorkerLaunchDeps {
  paths: RuntimePaths;
  env?: NodeJS.ProcessEnv;
  method?: RuntimeAuthMethod;
  host?: HostHardening | null;
  hostRuntime?: boolean;
  readText?: ReadText;
  permissionModes?: readonly string[] | null;
  /** Default: generatePlugin into a per-config dir (tests inject a fixed dir). */
  pluginDir?(cfg: MinionsConfig): Promise<string>;
  /** Default: `claude` on PATH. */
  claudeBin?: string;
  minionsBin?: string;
}

/** The project's role prompt dir for shared installs (`.minions/` in the agents' clone), when present. */
const roleConfigDir = (paths: Pick<RuntimePaths, 'repo'>): string | undefined => {
  const d = join(paths.repo, '.minions');
  return existsSync(d) ? d : undefined;
};

/**
 * The plugin generated from `cfg` (cached by a hash of the config): live roles without a coordinator restart. When the
 * runtime cannot render it (a role prompt file only the host can read), the host-generated plugin is used instead.
 */
export async function livePluginDir(cfg: MinionsConfig, paths: RuntimePaths, log?: (l: string) => void): Promise<string> {
  const root = join(dispatchRunDir(paths.state), 'plugin');
  const hash = createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);
  const dir = join(root, hash);
  if (existsSync(join(dir, '.complete'))) return dir;
  try {
    await ensureRealDir(root, 0o700);
    await rm(dir, { recursive: true, force: true });
    await generatePlugin(cfg, dir, { configDir: roleConfigDir(paths) });
    await atomicWrite(join(dir, '.complete'), new Date().toISOString() + '\n');
  } catch (e) {
    log?.(`dispatch: could not render the live plugin (${(e as Error).message.slice(0, 200)}); using the host plugin at ${paths.pluginDir}`);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return paths.pluginDir;
  }
  await prunePlugins(root, hash);
  return dir;
}

async function prunePlugins(root: string, keep: string): Promise<void> {
  let names: string[];
  try { names = await readdir(root); } catch { return; }
  const dated = await Promise.all(names.filter((n) => n !== keep).map(async (n) => ({ n, t: (await stat(join(root, n)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const { n } of dated.sort((a, b) => b.t - a.t).slice(KEEP_PLUGINS - 1)) await rm(join(root, n), { recursive: true, force: true });
}

/** The worker's environment: the session allowlist, the fresh config dir, the one credential, and the worker marker. */
export function workerEnv(base: NodeJS.ProcessEnv, configDir: string, cred: HeadlessCredential, o: { leaseId: string; role: string; tmp: string; scratchDir?: string }): Record<string, string> {
  const allow = new Set<string>(SESSION_ENV_ALLOW);
  const drop = new Set<string>([...HEADLESS_DROP_ENV, 'MINIONS_SESSION']);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || drop.has(k) || k.startsWith('TELEGRAM_')) continue;
    if (allow.has(k) || SESSION_ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
  }
  env.TMPDIR = o.scratchDir ?? o.tmp;
  return Object.assign(env, credentialEnv(configDir, cred), { [WORKER_LEASE_ENV]: o.leaseId, [WORKER_ROLE_ENV]: o.role });
}

const roleSecrets = (paths: { secretsDir: string; configJson: string }, role: string) =>
  secretEnv(paths.secretsDir, readManifest(secretManifestPath(paths.configJson)), role);

/** The command of one worker (pure apart from the credential read, the config dir and the plugin render). */
export async function buildWorkerCommand(i: LaunchInput, deps: WorkerLaunchDeps): Promise<WorkerCommand> {
  const env = deps.env ?? process.env;
  const { stage, claim, cfg } = i;
  if (!claim.worktree) throw new MinionsError('PRECONDITION', `Lease ${claim.leaseId} has no worktree.`);
  if (stage.launch.kind === 'run') {
    if (Object.keys(roleSecrets(deps.paths, claim.role)).length) {
      throw new MinionsError('PRECONDITION', `${claim.role} runs on a process harness, which does not receive owner secrets yet.`, `Run the role on claude, or ask the owner to revoke its secrets (\`minions secrets revoke <NAME> --role ${claim.role}\`).`);
    }
    const bin = deps.minionsBin ?? await resolveOnPath('minions', env.PATH);
    if (!bin) throw new MinionsError('PRECONDITION', '`minions` is not on PATH.');
    // The runner builds its own isolated environment and submits by proxy.
    const runEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.startsWith('TELEGRAM_')) runEnv[k] = v;
    return { kind: 'run', argv: [bin, 'work', 'run', claim.leaseId, '--json'], cwd: deps.paths.repo, env: runEnv, stdin: '' };
  }
  const onHost = deps.hostRuntime ?? runtimeMode(env) === 'host-runtime';
  const method = deps.method ?? runtimeAuthMethod(env);
  const mode = effectivePermissionMode(cfg, deps.permissionModes);
  const plan = await prepareHeadlessCredential(method, deps.paths, deps.readText);
  if (mode === 'bypassPermissions') plan.settings = { ...plan.settings, permissions: {} };
  const flagSettings: Record<string, unknown> = {
    ...coordinatorSettings(cfg, { telegram: false, auth: method, host: deps.host, paths: deps.paths }),
    enabledPlugins: { [TELEGRAM_PLUGIN_ID]: false },
  };
  const pluginDir = deps.pluginDir ? await deps.pluginDir(cfg) : await livePluginDir(cfg, deps.paths);
  const model = stage.agentModel ?? stage.suggestedModel;
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--plugin-dir', pluginDir,
    '--agent', stage.agentType,
    '--permission-mode', mode,
    ...(onHost ? ['--setting-sources=', '--add-dir', deps.paths.state] : []),
    '--strict-mcp-config',
    ...(model ? ['--model', model] : []),
    '--settings', JSON.stringify(flagSettings),
    ...(i.correction?.resume ? ['--resume', i.correction.resume] : []),
  ];
  const masked = args.map((a, n) => (n > 0 && args[n - 1] === '--settings' ? '<text>' : a));
  const allowBypass = mode === 'bypassPermissions';
  checkHeadlessArgs(masked, { coordinatorConfigDir: env.CLAUDE_CONFIG_DIR || CONTAINER.claudeHome, secret: plan.secret, allowBypass });
  checkHeadlessArgs(args, { coordinatorConfigDir: '', secret: plan.secret, allowBypass });
  const bin = deps.claudeBin ?? await resolveOnPath('claude', env.PATH);
  if (!bin) throw new MinionsError('PRECONDITION', 'Claude Code (`claude`) is not on PATH.');
  // A fresh config dir per lease (the correction resumes the session, so it reuses the lease's dir).
  const configDir = join(dispatchRunDir(deps.paths.state), 'config', claim.leaseId);
  await ensureRealDir(join(dispatchRunDir(deps.paths.state), 'config'), 0o700);
  await ensureRealDir(configDir, 0o700);
  await atomicWrite(join(configDir, 'settings.json'), JSON.stringify(plan.settings, null, 2) + '\n', { mode: 0o600 });
  // The coordinator's plain `env`, then the owner secrets granted to the role (docs/design/autonomy.md Decision 4); a
  // granted secret without a value refuses the launch. minions' own variables win over both.
  const secrets = roleSecrets(deps.paths, claim.role);
  return {
    kind: 'claude', argv: [bin, ...args], cwd: claim.worktree,
    env: { ...(cfg.env ?? {}), ...secrets, ...workerEnv(env, configDir, plan.cred, { leaseId: claim.leaseId, role: claim.role, tmp: deps.paths.tmp, ...(claim.scratchDir ? { scratchDir: claim.scratchDir } : {}) }) },
    stdin: workerPrompt(claim, i.correction),
  };
}

/** Usage and session id from a `claude -p --output-format stream-json` line. */
export function parseStreamLine(line: string): { sessionId?: string; tokens?: number; model?: string } | null {
  if (!line.startsWith('{')) return null;
  try {
    const e = JSON.parse(line) as { type?: string; subtype?: string; session_id?: unknown; model?: unknown; usage?: Record<string, unknown>; modelUsage?: Record<string, unknown> };
    const out: { sessionId?: string; tokens?: number; model?: string } = {};
    if (typeof e.session_id === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(e.session_id)) out.sessionId = e.session_id;
    if (e.type === 'system' && typeof e.model === 'string') out.model = e.model;
    if (e.type === 'result' && e.usage) {
      const n = (k: string) => (typeof e.usage![k] === 'number' ? e.usage![k] as number : 0);
      out.tokens = n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
    }
    return out;
  } catch { return null; }
}

/** Usage, model, session id and the last non-JSON lines of a worker's output log. */
export function summarizeWorkerLog(text: string): { tokens: number | null; model: string | null; sessionId: string | null; tail: string } {
  let tokens: number | null = null, model: string | null = null, sessionId: string | null = null;
  const plain: string[] = [];
  for (const line of text.split('\n')) {
    const e = parseStreamLine(line);
    if (!e) { if (line.trim()) plain.push(line); continue; }
    if (e.sessionId) sessionId = e.sessionId;
    if (e.model) model = e.model;
    if (e.tokens !== undefined) tokens = (tokens ?? 0) + e.tokens;
  }
  return { tokens, model, sessionId, tail: plain.slice(-5).join('\n').slice(-2048) };
}

export const workerLogPath = (state: string, leaseId: string) => join(dispatchRunDir(state), `${leaseId}.log`);

/**
 * Starts a worker under supervise.ts and returns its handle (the dispatcher's `launch`). The worker's output goes to
 * its own log file, never a pipe to the dispatcher: a dispatcher restart (an upgrade) must not kill it with SIGPIPE,
 * so the next dispatcher can adopt it.
 */
export function launchWorker(db: RuntimeDb, deps: WorkerLaunchDeps & { log?: (l: string) => void }) {
  return async (i: LaunchInput): Promise<WorkerHandle> => {
    const cmd = await buildWorkerCommand(i, { ...deps, pluginDir: deps.pluginDir ?? ((cfg) => livePluginDir(cfg, deps.paths, deps.log)) });
    const logFile = workerLogPath(deps.paths.state, i.claim.leaseId);
    await ensureRealDir(dispatchRunDir(deps.paths.state), 0o700);
    // Created private first: `>>` keeps the mode (the worker's own umask stays the caller's).
    await appendFile(logFile, '', { mode: 0o600 });
    let pid: number | null = null;
    const spec: SpawnSpec = {
      argv: ['/bin/sh', '-c', 'exec "$0" "$@" >>"$MINIONS_WORKER_LOG" 2>&1', ...cmd.argv],
      cwd: cmd.cwd, env: { ...cmd.env, MINIONS_WORKER_LOG: logFile }, stdin: cmd.stdin,
    };
    let spawned!: () => void;
    const ready = new Promise<void>((r) => { spawned = r; });
    const done = supervise(spec, { ...DEFAULT_TIMING, timeoutMs: i.timeoutMs }, {
      onSpawn: (p) => { pid = p; spawned(); },
      onLine: () => undefined,
      poll: async (): Promise<StopReason | null> => {
        const l = db.lease(i.claim.leaseId);
        if (!l || l.status !== 'active') return 'lease-ended';
        return existsSync(deps.paths.drainFlag) ? 'drain' : null;
      },
    }).then(async (o): Promise<WorkerExit> => {
      const log = summarizeWorkerLog(await readFile(logFile, 'utf8').catch(() => ''));
      return {
        code: o.code, signal: o.signal, stopped: o.stopped, tokens: cmd.kind === 'claude' ? log.tokens : null, model: log.model,
        sessionId: log.sessionId ?? i.correction?.resume ?? null, stderrTail: (o.stderrTail || log.tail).slice(-2048), spawnError: o.spawnError,
      };
    });
    // The run record wants the pid; a spawn error resolves `done` without one.
    await Promise.race([ready, done.then(() => undefined)]);
    return { done, pid: () => pid, sessionId: () => i.correction?.resume ?? null };
  };
}
