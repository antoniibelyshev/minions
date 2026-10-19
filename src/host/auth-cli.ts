// `minions auth show|set|refresh` (host only). Plans show what host command runs and what is mounted;
// key values are never printed, logged, or written anywhere but the 0600 secret file.
import { Option, type Command } from 'commander';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { parseWith } from '../core/fsutil.js';
import { emit } from '../core/output.js';
import { CONTAINER, defaultsPath, projectPaths } from '../core/paths.js';
import {
  API_KEY_HELPER, ClaudeAuthSchema, PRESETS, PRESET_NAMES, authOf, checkUrl, ensureSecretsDir, isKeyAuth, loadAuthState,
  loadDefaults, parseEnvPairs, refreshKey, removeKeyFile, resolveOnPath, saveDefaults, secretStatus, summarize,
  type AuthState, type AuthSummary, type ClaudeAuth, type Runner, type SecretStatus,
} from './auth.js';
import { projectJsonBytes, refreshDerived, writeGenerated } from './install.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';

export interface AuthSetFlags {
  file?: string;
  keychainService?: string;
  keychainAccount?: string;
  envVar?: string;
  command?: string[];
  env?: string[];
  baseUrl?: string;
  refreshMinutes?: string;
  timeoutMs?: string;
  rewriteLoopback?: boolean;
  global?: boolean;
  yes?: boolean;
}

export const AUTH_SET_METHODS = ['login', 'api-key', 'helper', ...PRESET_NAMES];

const intFlag = (v: string | undefined, name: string, min: number, max: number) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new MinionsError('INVALID_CONFIG', `${name} must be a whole number between ${min} and ${max}.`);
  return n;
};

/** Builds and validates a ClaudeAuth from `auth set` arguments. Presets read host files only here. */
export async function buildAuth(method: string, argv: string[], o: AuthSetFlags, ctx: { home?: string } = {}): Promise<ClaudeAuth> {
  if (!AUTH_SET_METHODS.includes(method)) {
    throw new MinionsError('INVALID_CONFIG', `Unknown method "${method}".`, `Use one of: ${AUTH_SET_METHODS.join(', ')}.`);
  }
  const extraEnv = parseEnvPairs(o.env ?? []);
  const refreshMinutes = intFlag(o.refreshMinutes, '--refresh-minutes', 1, 1440);
  const timeoutMs = intFlag(o.timeoutMs, '--timeout-ms', 1000, 600_000);
  const sources = [o.file !== undefined, o.keychainService !== undefined || o.keychainAccount !== undefined, o.envVar !== undefined].filter(Boolean).length;
  const command = o.command?.length ? o.command : argv;
  if (o.command?.length && argv.length) throw new MinionsError('INVALID_CONFIG', 'Pass the helper command either with --command or after --, not both.');
  if (method !== 'api-key' && sources) throw new MinionsError('INVALID_CONFIG', '--file / --keychain-* / --env-var apply only to `auth set api-key`.');
  if (method !== 'helper' && command.length) throw new MinionsError('INVALID_CONFIG', 'A command applies only to `auth set helper`.');
  const helperish = method === 'helper' || PRESETS[method] !== undefined;
  if (!helperish && (refreshMinutes !== undefined || timeoutMs !== undefined)) throw new MinionsError('INVALID_CONFIG', '--refresh-minutes / --timeout-ms apply only to helper methods.');
  if (o.baseUrl !== undefined) checkUrl(o.baseUrl, '--base-url');

  let a: ClaudeAuth;
  const preset = PRESETS[method];
  if (preset) {
    a = await preset.expand({ home: ctx.home, baseUrl: o.baseUrl });
  } else {
    const env: Record<string, string> = o.baseUrl !== undefined ? { ANTHROPIC_BASE_URL: o.baseUrl } : {};
    if (method === 'login') a = { method: 'login', env };
    else if (method === 'helper') {
      if (!command.length) throw new MinionsError('INVALID_CONFIG', 'auth set helper needs a command.', 'Example: minions auth set helper -- /path/to/print-key --flag');
      a = { method: 'helper', command, env };
    } else {
      if (sources !== 1) throw new MinionsError('INVALID_CONFIG', 'auth set api-key needs exactly one source.', 'Use --file <path>, --keychain-service <s> --keychain-account <a>, or --env-var <NAME>.');
      if (o.file !== undefined) a = { method: 'api-key', source: { type: 'file', path: o.file }, env };
      else if (o.envVar !== undefined) a = { method: 'api-key', source: { type: 'env', name: o.envVar }, env };
      else {
        if (!o.keychainService || !o.keychainAccount) throw new MinionsError('INVALID_CONFIG', 'Keychain source needs both --keychain-service and --keychain-account.');
        a = { method: 'api-key', source: { type: 'keychain', service: o.keychainService, account: o.keychainAccount }, env };
      }
    }
  }
  a.env = { ...(a.env ?? {}), ...extraEnv };
  if (!Object.keys(a.env).length) delete a.env;
  if (a.method === 'helper') {
    if (refreshMinutes !== undefined) a.refreshMinutes = refreshMinutes;
    if (timeoutMs !== undefined) a.timeoutMs = timeoutMs;
  }
  if (o.rewriteLoopback === false) a.rewriteLoopback = false;
  return parseWith(ClaudeAuthSchema, a, 'auth set');
}

export interface AuthPlan {
  scope: 'project' | 'global';
  projectId: string | null;
  auth: AuthSummary;
  hostReads: string;
  containerSettings: { apiKeyHelper: string } | null;
  writes: string[];
  notes: string[];
}

export function authPlan(a: ClaudeAuth, projectId: string | null): AuthPlan {
  const paths = projectId ? projectPaths(projectId) : null;
  const notes: string[] = [];
  if (isKeyAuth(a)) {
    notes.push('The key is readable by any process in the container (all agents share it).');
    if (a.method === 'helper') notes.push('The helper command runs on the host with your user rights; it is stored only in host-side configuration.');
  }
  if (projectId) notes.push('compose.yaml is regenerated; `minions start` recreates the container with the new settings.');
  else notes.push('Applies to projects created by `minions init` from now on; existing projects keep their setting.');
  return {
    scope: projectId ? 'project' : 'global',
    projectId,
    auth: summarize(a, paths?.secretsDir),
    hostReads: a.method === 'login' ? 'nothing (no key is provisioned)'
      : `${summarize(a).source}; on every \`minions start\`, \`minions auth refresh\`${a.method === 'helper' ? ` and every ${a.refreshMinutes ?? 30} min while \`minions start\` is attached` : ''}`,
    containerSettings: isKeyAuth(a) ? { apiKeyHelper: API_KEY_HELPER } : null,
    writes: projectId ? [paths!.projectJson, paths!.composeYaml, ...(isKeyAuth(a) ? [`${paths!.apiKeyFile} (0600)`] : [])] : [defaultsPath()],
    notes,
  };
}

const envLines = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';

export function formatAuthPlan(p: AuthPlan): string {
  const L = [`Claude authorization ${p.scope === 'global' ? 'default for new projects' : `for project ${p.projectId}`}: ${p.auth.method}${p.auth.preset ? ` (preset ${p.auth.preset})` : ''}`];
  L.push(`  host reads: ${p.hostReads}`);
  if (p.auth.command) L.push(`  host command (argv, no shell): ${JSON.stringify(p.auth.command)}`);
  L.push(`  container env: ${envLines(p.auth.containerEnv)}`);
  L.push(`  mount: ${p.auth.mount ?? 'none'}`);
  if (p.containerSettings) L.push(`  Claude Code in the container: apiKeyHelper "${p.containerSettings.apiKeyHelper}"`);
  L.push(`  writes: ${p.writes.join(', ')}`);
  for (const n of p.notes) L.push(`  note: ${n}`);
  return L.join('\n');
}

export interface AuthSetResult {
  dryRun: boolean;
  applied: boolean;
  plan: AuthPlan;
  provisioned?: { refreshedAt: string } | null;
  removedKeyFile?: boolean;
  warnings: string[];
}

export interface AuthDeps { cwd: string; runner?: Runner; home?: string; env?: NodeJS.ProcessEnv; confirm?: (plan: string) => Promise<boolean> }

export async function runAuthSet(method: string, argv: string[], o: AuthSetFlags & { dryRun?: boolean }, deps: AuthDeps): Promise<AuthSetResult> {
  const a = await buildAuth(method, argv, o, { home: deps.home });
  const ref = o.global ? null : await projectForPath(deps.cwd);
  const plan = authPlan(a, ref?.projectId ?? null);
  const warnings: string[] = [];
  if (a.method === 'helper') {
    const cmd = a.command[0]!;
    if (!(await resolveOnPath(cmd, deps.env?.PATH ?? process.env.PATH))) warnings.push(`helper command \`${cmd}\` is not on PATH (or not executable) for this shell.`);
  }
  if (o.dryRun) return { dryRun: true, applied: false, plan, warnings };
  if (!o.yes) {
    const ok = deps.confirm ? await deps.confirm(formatAuthPlan(plan)) : false;
    if (!ok) throw new MinionsError('PRECONDITION', 'Not confirmed; nothing was changed.', 'Pass --yes to apply non-interactively, or --dry-run to only show the plan.');
  }
  if (!ref) {
    await saveDefaults({ ...(await loadDefaults()), claudeAuth: a });
    return { dryRun: false, applied: true, plan, warnings };
  }
  const project = { ...(await loadProjectJson(ref.projectId)), claudeAuth: a };
  await writeGenerated(project.projectId, projectPaths(project.projectId).projectJson, projectJsonBytes(project));
  if (isKeyAuth(a)) await ensureSecretsDir(project.projectId);
  const eff = await loadEffectiveConfig(project);
  warnings.push(...await refreshDerived(project, eff.config));
  const result: AuthSetResult = { dryRun: false, applied: true, plan, warnings };
  if (isKeyAuth(a)) {
    try { result.provisioned = await refreshKey(project.projectId, a, { runner: deps.runner, env: deps.env }); } catch (e) {
      result.provisioned = null;
      warnings.push(`setting saved, but the key could not be provisioned yet: ${(e as Error).message} Run \`minions auth refresh\` after fixing it.`);
    }
  } else {
    result.removedKeyFile = await removeKeyFile(project.projectId);
  }
  return result;
}

export interface AuthShowResult {
  scope: 'project' | 'global';
  projectId: string | null;
  explicit: boolean;
  auth: AuthSummary;
  secret: SecretStatus | null;
  state: AuthState | null;
  globalDefault: AuthSummary | null;
}

export async function runAuthShow(o: { global?: boolean }, deps: AuthDeps): Promise<AuthShowResult> {
  const defaults = await loadDefaults();
  if (o.global) {
    return { scope: 'global', projectId: null, explicit: !!defaults.claudeAuth, auth: summarize(defaults.claudeAuth ?? { method: 'login' }), secret: null, state: null, globalDefault: null };
  }
  const { projectId } = await projectForPath(deps.cwd);
  const project = await loadProjectJson(projectId);
  const a = authOf(project);
  return {
    scope: 'project', projectId, explicit: !!project.claudeAuth,
    auth: summarize(a, projectPaths(projectId).secretsDir),
    secret: isKeyAuth(a) ? await secretStatus(projectId) : null,
    state: isKeyAuth(a) ? await loadAuthState(projectId) : null,
    globalDefault: defaults.claudeAuth ? summarize(defaults.claudeAuth) : null,
  };
}

export function formatAuthShow(r: AuthShowResult): string {
  const L = [`Claude authorization (${r.scope === 'global' ? 'global default for new projects' : `project ${r.projectId}`}): ${r.auth.method}${r.auth.preset ? ` (preset ${r.auth.preset})` : ''}${r.explicit ? '' : ' [default]'}`];
  L.push(`  source: ${r.auth.source}`);
  if (r.auth.refreshMinutes) L.push(`  refresh: on start, \`minions auth refresh\`, and every ${r.auth.refreshMinutes} min while attached`);
  L.push(`  container env: ${envLines(r.auth.containerEnv)}`);
  L.push(`  mount: ${r.auth.mount ?? 'none'}`);
  if (r.secret) L.push(`  secret file: ${r.secret.present ? `present (mode ${r.secret.mode}), last refreshed ${r.secret.updatedAt}` : 'missing — run `minions auth refresh` or `minions start`'}`);
  if (r.state?.lastError) L.push(`  last refresh error (${r.state.lastAttemptAt}): ${r.state.lastError}`);
  if (r.globalDefault) L.push(`  global default: ${r.globalDefault.method}${r.globalDefault.preset ? ` (${r.globalDefault.preset})` : ''}`);
  return L.join('\n');
}

export async function runAuthRefresh(deps: AuthDeps): Promise<{ projectId: string; method: string; refreshed: boolean; refreshedAt?: string; secretFile?: string; note?: string }> {
  const { projectId } = await projectForPath(deps.cwd);
  const a = authOf(await loadProjectJson(projectId));
  if (!isKeyAuth(a)) return { projectId, method: a.method, refreshed: false, note: 'login method: nothing to refresh (log in with /login inside the container)' };
  const r = await refreshKey(projectId, a, { runner: deps.runner, env: deps.env });
  return { projectId, method: a.method, refreshed: true, ...r };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** Registers `minions auth …`. `confirm` prints the plan and asks (TTY only). */
export function registerAuth(program: Command, confirm: (plan: string) => Promise<boolean>): void {
  const auth = program.command('auth').description('Show or change how Claude is authorized inside the project container (host-side setting)');

  auth.command('show')
    .description('Show the method, source, container env (masked) and secret file status; never the key')
    .option('--global', 'show the global default for new projects')
    .action(action(async (o: { global?: boolean }, cmd: Command) => {
      requireMode('host');
      emit(await runAuthShow(o, { cwd: process.cwd() }), { json: globalOpts(cmd).json, human: formatAuthShow });
    }));

  auth.command('set <method> [argv...]')
    .description(`Set Claude authorization: ${AUTH_SET_METHODS.join(' | ')} (helper argv after --)`)
    .option('--file <path>', 'api-key: read the key from this host file')
    .option('--keychain-service <service>', 'api-key: macOS Keychain generic password service')
    .option('--keychain-account <account>', 'api-key: macOS Keychain generic password account')
    .option('--env-var <name>', 'api-key: read the key from this host environment variable')
    .option('--command <arg...>', 'helper: argv of the host command that prints the key (or pass it after --)')
    .option('--env <NAME=VALUE>', 'extra container env, e.g. ANTHROPIC_BASE_URL (repeatable)', collect)
    .option('--base-url <url>', 'ANTHROPIC_BASE_URL for the container (overrides the jbcentral preset lookup)')
    .option('--refresh-minutes <n>', 'helper: re-run interval while `minions start` is attached (default 30)')
    .option('--timeout-ms <n>', 'helper: timeout of one helper run (default 120000)')
    .option('--no-rewrite-loopback', 'keep 127.0.0.1/localhost in env values (default: rewrite to host.docker.internal)')
    .option('--global', 'set the default for new projects (<MINIONS_HOME>/defaults.json)')
    .option('--dry-run', 'show the plan without changing anything')
    .addOption(new Option('-y, --yes', 'apply without asking'))
    .action(action(async (method: string, argv: string[], o: AuthSetFlags & { dryRun?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      const r = await runAuthSet(method, argv, o, { cwd: process.cwd(), confirm: json ? undefined : confirm });
      emit(r, { json, human: (d: AuthSetResult) => [
        formatAuthPlan(d.plan),
        d.dryRun ? 'Dry run: nothing was changed.' : 'Saved.',
        ...(d.provisioned ? [`Key provisioned at ${d.provisioned.refreshedAt} (value not shown).`] : []),
        ...(d.removedKeyFile ? ['Removed the previously provisioned key file.'] : []),
        ...d.warnings.map((w) => `warning: ${w}`),
        ...(!d.dryRun && d.plan.scope === 'project' ? ['Run `minions start` to apply it to the container.'] : []),
      ].join('\n') });
    }));

  auth.command('refresh')
    .description('Re-read the key (run the helper / read the source) and replace the secret file')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const r = await runAuthRefresh({ cwd: process.cwd() });
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => d.refreshed ? `Claude key refreshed at ${d.refreshedAt} (value not shown); mounted at ${CONTAINER.apiKeyFile}.` : d.note! });
    }));
}
