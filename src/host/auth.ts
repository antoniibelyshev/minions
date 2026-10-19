// Host-controlled Claude authorization (project.json `claudeAuth`, <MINIONS_HOME>/defaults.json).
//
// Methods: `login` (interactive /login inside the container, state in the claude volume), `api-key`
// (the host reads a key from a file, the Keychain or an environment variable) and `helper` (the host
// runs a fixed argv command that prints a key). For the key methods the trusted host CLI writes the
// key to projects/<id>/secrets/anthropic-api-key (dir 0700, file 0600, atomic replace); the secrets
// DIRECTORY is bind-mounted read-only so refreshed files (new inodes) are visible in the container.
// This setting lives only in host-side files: a repository can never make the host run a command.
import { constants } from 'node:fs';
import { access, appendFile, chmod, readFile, rm, stat, truncate } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { MinionsError } from '../core/errors.js';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { atomicWrite, ensureDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { CONTAINER, defaultsPath, projectPaths } from '../core/paths.js';

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Env names a claudeAuth.env entry may not set: secrets never go in env, and runtime basics stay fixed. */
const RESERVED_ENV = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'HOME', 'PATH', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL', 'npm_config_cache', 'XDG_CACHE_HOME',
  'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);
const envName = z.string().regex(ENV_NAME, 'must be an environment variable name');
const EnvSchema = z.record(envName, z.string().max(4096));

const common = {
  /** Extra container environment (non-secret, e.g. ANTHROPIC_BASE_URL). Values are masked in output. */
  env: EnvSchema.optional(),
  /** Rewrite 127.0.0.1/localhost/[::1] hosts in env values to host.docker.internal (default true). */
  rewriteLoopback: z.boolean().optional(),
  /** Preset this setting was expanded from (display only). */
  preset: z.string().min(1).optional(),
};

export const KeySourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal('keychain'), service: z.string().min(1), account: z.string().min(1) }).strict(),
  z.object({ type: z.literal('env'), name: envName }).strict(),
]);
export type KeySource = z.infer<typeof KeySourceSchema>;

export const ClaudeAuthSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('login'), ...common }).strict(),
  z.object({ method: z.literal('api-key'), source: KeySourceSchema, ...common }).strict(),
  z.object({
    method: z.literal('helper'),
    /** argv, executed on the host without a shell. */
    command: z.array(z.string().min(1)).min(1),
    refreshMinutes: z.number().int().min(1).max(1440).optional(),
    timeoutMs: z.number().int().min(1000).max(600_000).optional(),
    ...common,
  }).strict(),
]).superRefine((a, ctx) => {
  for (const k of Object.keys(a.env ?? {})) {
    if (RESERVED_ENV.has(k) || k.startsWith('MINIONS_')) ctx.addIssue({ code: 'custom', path: ['env', k], message: 'reserved: cannot be set through claudeAuth.env (secrets never go in env)' });
  }
});
export type ClaudeAuth = z.infer<typeof ClaudeAuthSchema>;
export type AuthMethod = ClaudeAuth['method'];
export type KeyAuth = Exclude<ClaudeAuth, { method: 'login' }>;

export const DEFAULT_AUTH: ClaudeAuth = { method: 'login' };
export const DEFAULT_REFRESH_MINUTES = 30;
export const DEFAULT_HELPER_TIMEOUT_MS = 120_000;
/** Claude Code re-runs the in-container apiKeyHelper (`cat <file>`) after this TTL. */
export const KEY_HELPER_TTL_MS = 5 * 60_000;
export { API_KEY_HELPER } from '../runtime/coordinator.js';

export const isKeyAuth = (a: ClaudeAuth): a is KeyAuth => a.method !== 'login';
export const authOf = (p: { claudeAuth?: ClaudeAuth }): ClaudeAuth => p.claudeAuth ?? DEFAULT_AUTH;

// ---------------------------------------------------------------- env handling

const LOOPBACK = /^([a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?)(127(?:\.\d{1,3}){3}|localhost|\[::1\])(?=[:/?#]|$)/i;

/** Replaces a loopback host in a URL-shaped value with host.docker.internal; other values unchanged. */
export const rewriteLoopback = (value: string): string => value.replace(LOOPBACK, '$1host.docker.internal');

/** Container env from claudeAuth.env (after the loopback rewrite unless disabled). */
export function containerEnv(a: ClaudeAuth): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.env ?? {})) out[k] = a.rewriteLoopback === false ? v : rewriteLoopback(v);
  return out;
}

/** Masks an env value for display: URLs keep scheme+host:port, everything else is hidden. */
export function maskValue(value: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/?#]*@)?([^/?#]*)(.*)$/i.exec(value);
  if (m) return `${m[1]}${m[2]}${m[3] ? '/***' : ''}`;
  return value ? '***' : '';
}
export const maskEnv = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, maskValue(v)]));

/** Parses `K=V` pairs (repeatable --env). */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    const k = i > 0 ? p.slice(0, i) : '';
    if (!ENV_NAME.test(k)) throw new MinionsError('INVALID_CONFIG', `--env expects NAME=VALUE (got "${k || p.slice(0, 40)}=…").`);
    out[k] = p.slice(i + 1);
  }
  return out;
}

// ---------------------------------------------------------------- presets

export interface PresetContext { home?: string; baseUrl?: string }
export interface Preset {
  description: string;
  /** Executable that marks the preset as available (PATH lookup only, never executed for detection). */
  detect: string;
  expand(ctx: PresetContext): Promise<KeyAuth>;
}

/** Reads only env.ANTHROPIC_BASE_URL from the host ~/.claude/settings.json (nothing else is used). */
export async function hostClaudeBaseUrl(home: string = homedir()): Promise<string | undefined> {
  const file = join(home, '.claude', 'settings.json');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
  const v = (raw as { env?: { ANTHROPIC_BASE_URL?: unknown } } | null)?.env?.ANTHROPIC_BASE_URL;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function checkUrl(u: string, what: string): string {
  let parsed: URL;
  try { parsed = new URL(u); } catch { throw new MinionsError('INVALID_CONFIG', `${what} is not a valid URL.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new MinionsError('INVALID_CONFIG', `${what} must be an http(s) URL.`);
  return u;
}

export const PRESETS: Record<string, Preset> = {
  jbcentral: {
    description: 'JetBrains Central: host `central` prints the key; Claude talks to the local Central proxy',
    detect: 'central',
    async expand(ctx) {
      const base = ctx.baseUrl ?? await hostClaudeBaseUrl(ctx.home);
      if (!base) {
        throw new MinionsError('PRECONDITION', 'JetBrains Central: env.ANTHROPIC_BASE_URL not found in ~/.claude/settings.json.',
          'Run `central add claude` on the host to configure Claude for Central, or pass --base-url <url>.');
      }
      return {
        method: 'helper', preset: 'jbcentral',
        command: ['central', 'proxy', 'start', '--ensure-updated', '--caller', 'agent', '--return-key'],
        env: { ANTHROPIC_BASE_URL: checkUrl(base, 'Central base URL') },
      };
    },
  },
};
export const PRESET_NAMES = Object.keys(PRESETS);

/** PATH lookup only (never executes the command). */
export async function resolveOnPath(cmd: string, pathEnv: string | undefined = process.env.PATH): Promise<string | null> {
  const ok = async (p: string) => { try { await access(p, constants.X_OK); return (await stat(p)).isFile(); } catch { return false; } };
  if (cmd.includes('/')) return isAbsolute(cmd) && await ok(cmd) ? cmd : null;
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir && await ok(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

// ---------------------------------------------------------------- defaults.json

export const DefaultsSchema = z.object({ claudeAuth: ClaudeAuthSchema.optional() }).strict();
export type Defaults = z.infer<typeof DefaultsSchema>;
export const loadDefaults = async (): Promise<Defaults> => (await readJsonIfExists(defaultsPath(), DefaultsSchema)) ?? {};
export async function saveDefaults(d: Defaults): Promise<void> { await writeJson(defaultsPath(), d, { mode: 0o600 }); }

// ---------------------------------------------------------------- description (never contains secrets)

export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

export function describeSource(a: ClaudeAuth): string {
  if (a.method === 'login') return 'interactive /login inside the container (state in the project claude volume)';
  if (a.method === 'helper') return `host command ${JSON.stringify(a.command)} (argv, no shell)`;
  const s = a.source;
  if (s.type === 'file') return `host file ${s.path}`;
  if (s.type === 'keychain') return `macOS Keychain generic password (service "${s.service}", account "${s.account}")`;
  return `host environment variable ${s.name} (of the minions CLI process)`;
}

export interface AuthSummary {
  method: AuthMethod;
  preset: string | null;
  source: string;
  command: string[] | null;
  refreshMinutes: number | null;
  env: Record<string, string>;
  containerEnv: Record<string, string>;
  mount: string | null;
}

export function summarize(a: ClaudeAuth, secretsDir?: string): AuthSummary {
  return {
    method: a.method,
    preset: a.preset ?? null,
    source: describeSource(a),
    command: a.method === 'helper' ? a.command : null,
    refreshMinutes: a.method === 'helper' ? a.refreshMinutes ?? DEFAULT_REFRESH_MINUTES : null,
    env: maskEnv(a.env ?? {}),
    containerEnv: maskEnv(containerEnv(a)),
    mount: isKeyAuth(a) ? `${secretsDir ?? '<project>/secrets'} -> ${CONTAINER.secretsDir} (read-only directory)` : null,
  };
}

// ---------------------------------------------------------------- obtaining the key (host only)

/** Masks long token-like runs so helper stderr can be shown without leaking credentials. */
const scrub = (s: string) => redact(s).replace(/[A-Za-z0-9+/_=.~-]{24,}/g, '[REDACTED]');
const lastLine = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

function keyFromOutput(text: string, what: string): string {
  const key = lastLine(text);
  if (!key) throw new MinionsError('AUTH_REQUIRED', `${what} produced an empty key.`);
  if (/\s/.test(key) || key.length < 8) throw new MinionsError('AUTH_REQUIRED', `${what} did not produce a single-token key.`, 'The key must be printed alone on the last line of output.');
  return key;
}

export interface KeyDeps { runner?: Runner; env?: NodeJS.ProcessEnv }

/** Obtains the key on the host. Never logs or returns it anywhere but the caller. */
export async function obtainKey(a: KeyAuth, deps: KeyDeps = {}): Promise<string> {
  const runner = deps.runner ?? run;
  if (a.method === 'helper') {
    const [cmd, ...args] = a.command;
    const r = await runner(cmd!, args, { allowFailure: true, timeoutMs: a.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS, env: deps.env });
    if (r.code !== 0) {
      const why = r.timedOut ? `timed out after ${a.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS}ms` : r.code === 127 ? 'not found or not executable' : `exited with code ${r.code}`;
      const err = scrub(lastLine(r.stderr)).slice(0, 200);
      throw new MinionsError('AUTH_REQUIRED', `Claude key helper \`${cmd}\` ${why}${err ? `: ${err}` : ''}.`,
        a.preset === 'jbcentral' ? 'Check that JetBrains Central works on the host (`central add claude`), then run `minions auth refresh`.'
          : 'Fix the helper command (`minions auth show`), then run `minions auth refresh`.');
    }
    return keyFromOutput(r.stdout, `Helper \`${cmd}\``);
  }
  const s = a.source;
  if (s.type === 'file') {
    const p = expandHome(s.path);
    let text: string;
    try { text = await readFile(p, 'utf8'); } catch (e) {
      throw new MinionsError('AUTH_REQUIRED', `Cannot read the API key file ${p} (${(e as NodeJS.ErrnoException).code ?? 'error'}).`, 'Create it (mode 0600, outside any repository) or run `minions auth set api-key --file <path>`.');
    }
    return keyFromOutput(text, `Key file ${p}`);
  }
  if (s.type === 'keychain') {
    const r = await runner('security', ['find-generic-password', '-s', s.service, '-a', s.account, '-w'], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code !== 0) {
      throw new MinionsError('AUTH_REQUIRED', `Keychain item (service "${s.service}", account "${s.account}") not found or access denied.`,
        `Add it with: security add-generic-password -s ${JSON.stringify(s.service)} -a ${JSON.stringify(s.account)} -w`);
    }
    return keyFromOutput(r.stdout, 'Keychain item');
  }
  const v = (deps.env ?? process.env)[s.name];
  if (!v) throw new MinionsError('AUTH_REQUIRED', `Environment variable ${s.name} is not set for the minions CLI.`, `Export ${s.name} in the shell that runs \`minions start\`.`);
  return keyFromOutput(v, `Environment variable ${s.name}`);
}

// ---------------------------------------------------------------- provisioning

const AuthStateSchema = z.object({
  lastRefreshAt: z.string().optional(),
  lastAttemptAt: z.string().optional(),
  lastError: z.string().optional(),
}).strict();
export type AuthState = z.infer<typeof AuthStateSchema>;
export const loadAuthState = async (projectId: string): Promise<AuthState> =>
  (await readJsonIfExists(projectPaths(projectId).authStateJson, AuthStateSchema).catch(() => undefined)) ?? {};

/** Creates projects/<id>/secrets with mode 0700 (the compose bind source must exist). */
export async function ensureSecretsDir(projectId: string): Promise<string> {
  const dir = projectPaths(projectId).secretsDir;
  await ensureDir(dir, 0o700);
  await chmod(dir, 0o700);
  return dir;
}

export async function writeKeyFile(projectId: string, key: string): Promise<void> {
  await ensureSecretsDir(projectId);
  await atomicWrite(projectPaths(projectId).apiKeyFile, key, { mode: 0o600 });
}

export async function removeKeyFile(projectId: string): Promise<boolean> {
  const f = projectPaths(projectId).apiKeyFile;
  const had = await stat(f).then(() => true, () => false);
  await rm(f, { force: true });
  return had;
}

const LOG_LIMIT = 64 * 1024;
async function logAuth(projectId: string, line: string): Promise<void> {
  const p = projectPaths(projectId);
  const file = join(p.logsDir, 'auth.log');
  try {
    await ensureDir(p.logsDir, 0o700);
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size > LOG_LIMIT) await truncate(file, 0);
    await appendFile(file, `${new Date().toISOString()} ${scrub(line)}\n`, { mode: 0o600 });
  } catch { /* logging is best effort */ }
}

export interface RefreshResult { refreshedAt: string; secretFile: string }

/**
 * Obtains the key and atomically replaces the secret file. On failure the previous key file is kept,
 * the (redacted) error is recorded in auth-state.json and logs/auth.log, and the error is rethrown.
 */
export async function refreshKey(projectId: string, a: KeyAuth, deps: KeyDeps = {}): Promise<RefreshResult> {
  const p = projectPaths(projectId);
  const state = await loadAuthState(projectId);
  const now = new Date().toISOString();
  try {
    const key = await obtainKey(a, deps);
    await writeKeyFile(projectId, key);
    await writeJson(p.authStateJson, { lastRefreshAt: now, lastAttemptAt: now }, { mode: 0o600 });
    return { refreshedAt: now, secretFile: p.apiKeyFile };
  } catch (e) {
    const msg = scrub(e instanceof Error ? e.message : String(e)).slice(0, 300);
    await writeJson(p.authStateJson, { ...state, lastAttemptAt: now, lastError: msg }, { mode: 0o600 }).catch(() => {});
    await logAuth(projectId, `refresh failed: ${msg}`);
    if (e instanceof MinionsError) throw e;
    throw new MinionsError('AUTH_REQUIRED', `Claude key refresh failed: ${msg}`, 'Run `minions auth show` and `minions auth refresh`.');
  }
}

/**
 * Re-runs the helper every refreshMinutes while `minions start` stays attached. The timer is unref'd;
 * failures keep the old key and produce one redacted warning line. Returns a stop function.
 */
export function startRefreshTimer(projectId: string, a: ClaudeAuth, opts: KeyDeps & { onWarn?: (line: string) => void; intervalMs?: number } = {}): () => void {
  if (a.method !== 'helper') return () => {};
  const ms = opts.intervalMs ?? (a.refreshMinutes ?? DEFAULT_REFRESH_MINUTES) * 60_000;
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    refreshKey(projectId, a, opts)
      .catch((e) => opts.onWarn?.(`warning: Claude key refresh failed (keeping the previous key): ${scrub((e as Error).message).slice(0, 200)}`))
      .finally(() => { busy = false; });
  }, ms);
  t.unref();
  return () => clearInterval(t);
}

export interface SecretStatus { present: boolean; path: string; updatedAt: string | null; ageMinutes: number | null; mode: string | null }

export async function secretStatus(projectId: string): Promise<SecretStatus> {
  const path = projectPaths(projectId).apiKeyFile;
  const s = await stat(path).catch(() => null);
  if (!s) return { present: false, path, updatedAt: null, ageMinutes: null, mode: null };
  return { present: true, path, updatedAt: s.mtime.toISOString(), ageMinutes: Math.floor((Date.now() - s.mtimeMs) / 60_000), mode: (s.mode & 0o777).toString(8).padStart(4, '0') };
}
