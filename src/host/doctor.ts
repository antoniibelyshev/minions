// `minions doctor`: host, Docker, container, and configuration readiness. Never prints secrets.
import { stat } from 'node:fs/promises';
import { DEFERRED_FEATURES, listUnavailable } from '../config/resolve.js';
import { isMinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { redact } from '../core/output.js';
import { CONTAINER } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { DEFAULT_REFRESH_MINUTES, authOf, containerEnv, describeSource, expandHome, isKeyAuth, maskValue, resolveOnPath, secretStatus, type ClaudeAuth } from './auth.js';
import type { MinionsConfig } from '../config/schema.js';
import { ciSetupPlan, fetchApi, requiredChecksStatus, type RequiredChecksReport } from '../runtime/ci.js';
import { clearStaleSecrets, secretCopiesExist, githubCredentialStatus, readGithubToken, githubRepoFromRemote, telegramCredentialStatus, type CredentialStatus, type Fetch, type TelegramCredentialStatus } from './credentials.js';
import { dockerProbe, type DockerProbe } from './discovery.js';
import { Compose, buildFingerprint, imageBuildLabel, type Runner } from './docker.js';
import { telegramDoctorCheck } from '../telegram/probe.js';
import { resolveChannel, type ChannelResolution } from '../telegram/channel.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { githubHints, inspectGithub } from './github-setup.js';
import { HOST_RUNTIME_SHORT, HostRuntime, hostTools, prepareHostRuntime, runtimeOf } from './runtime.js';
import type { ProjectJson } from './project.js';
import { projectPaths } from '../core/paths.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unavailable';
export interface Check { name: string; status: CheckStatus; detail: string; hint?: string }
export interface DoctorReport { healthy: boolean; projectId: string | null; checks: Check[] }

const short = (s: string) => redact(s.trim().split('\n').slice(-1)[0] ?? '').slice(0, 300);

export function nodeVersionOk(v: string): boolean {
  const [maj = 0, min = 0] = v.replace(/^v/, '').split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 13);
}

/**
 * In-container reachability of $ANTHROPIC_BASE_URL (read from the container env, never passed in argv):
 * any HTTP status means reachable. A HEAD request costs no tokens. Prints only "HTTP <status>" or "ERR <code>".
 */
export const REACH_SCRIPT = 'fetch(process.env.ANTHROPIC_BASE_URL,{method:"HEAD",redirect:"manual",signal:AbortSignal.timeout(8000)})'
  + '.then(r=>console.log("HTTP "+r.status),e=>{console.log("ERR "+((e.cause&&(e.cause.code||e.cause.message))||e.name));process.exitCode=1})';

type Add = (name: string, status: CheckStatus, detail: string, hint?: string) => void;

/** Host-side auth checks that need no container: method, secret file, helper/source resolvable. */
async function hostAuthChecks(projectId: string, a: ClaudeAuth, add: Add): Promise<void> {
  add('claude.auth.method', 'ok', `${a.method}${a.preset ? ` (${a.preset})` : ''}: ${describeSource(a)}`);
  if (!isKeyAuth(a)) return;
  const s = await secretStatus(projectId);
  const limit = a.method === 'helper' ? 2 * (a.refreshMinutes ?? DEFAULT_REFRESH_MINUTES) : null;
  if (!s.present) add('claude.auth.secret', 'warn', 'key file not provisioned yet', '`minions start` or `minions auth refresh` provisions it.');
  else if (s.mode !== '0600') add('claude.auth.secret', 'warn', `key file mode ${s.mode} (expected 0600)`, 'Run `minions auth refresh` to rewrite it.');
  else if (limit !== null && (s.ageMinutes ?? 0) > limit) add('claude.auth.secret', 'warn', `key file is ${s.ageMinutes} min old (refresh every ${limit / 2} min)`, 'Run `minions auth refresh`.');
  else add('claude.auth.secret', 'ok', `key file present (0600), refreshed ${s.updatedAt}`);
  if (a.method === 'helper') {
    const p = await resolveOnPath(a.command[0]!);
    add('claude.auth.helper', p ? 'ok' : 'fail', p ? `helper \`${a.command[0]}\` resolves to ${p}` : `helper \`${a.command[0]}\` not found on PATH`,
      p ? undefined : a.preset === 'jbcentral' ? 'Install JetBrains Central on the host and make sure `central` is on PATH.' : 'Fix the command with `minions auth set helper`.');
  } else if (a.source.type === 'env') {
    add('claude.auth.source', process.env[a.source.name] ? 'ok' : 'warn', `${a.source.name} ${process.env[a.source.name] ? 'is set' : 'is not set'} in this shell`);
  } else if (a.source.type === 'file') {
    const st = await stat(expandHome(a.source.path)).catch(() => null);
    add('claude.auth.source', st?.isFile() ? 'ok' : 'fail', st?.isFile() ? `key file ${a.source.path} exists` : `key file ${a.source.path} not found`);
  }
}

/** github.credential: ok / missing / invalid (/ unverified when the API is unreachable). Never includes the token. */
async function githubCheck(project: { projectId: string; remoteUrl: string | null }, runner: Runner, f?: Fetch): Promise<[string, CheckStatus, string, string?]> {
  const name = 'github.credential';
  const onGitHub = githubRepoFromRemote(project.remoteUrl) !== null;
  let s: CredentialStatus;
  try { s = await githubCredentialStatus(project, { runner, fetch: f }); } catch (e) {
    return [name, 'warn', `invalid: could not check (${short(String((e as Error).message ?? e))})`, 'Run `minions auth github` to store the token again.'];
  }
  switch (s.state) {
    case 'ok': return [name, 'ok', `ok: ${s.detail}`];
    case 'missing': return onGitHub
      ? [name, 'warn', `missing: ${s.detail}`, 'Run `minions auth github` (needed for branch/pull-request delivery).']
      : [name, 'ok', 'missing: not needed (no GitHub remote)'];
    case 'invalid': return [name, 'fail', `invalid: ${s.detail}`, 'Create a new fine-grained token and run `minions auth github`.'];
    case 'unverified': return [name, 'warn', `unverified: ${s.detail}`, 'Check network access to api.github.com and rerun doctor.'];
  }
}

/**
 * github.setup: the GitHub section with one actionable next step (remote, base branch on the remote,
 * token, delivery). Local git data and stored references only; the token check is github.credential.
 */
async function githubSetupCheck(project: ProjectJson, repoPath: string, credential: CredentialStatus['state'] | null, runner: Runner): Promise<Check> {
  const name = 'github.setup';
  const s = await inspectGithub(project, repoPath, { runner }).catch(() => null);
  if (!s) return { name, status: 'warn', detail: 'could not inspect the repository remote', hint: 'Run `minions setup github`.' };
  if (!s.repository) {
    return { name, status: 'ok', detail: s.nonGithubOrigin ? `not set up: origin is not on github.com; delivery stays local` : 'not set up: no GitHub remote; delivery stays local',
      hint: githubHints(s)[0] ?? 'Run `minions setup github`.' };
  }
  const parts = [`origin ${s.repository}`, `base ${s.baseBranch} ${s.baseOnRemote ? 'on origin' : 'not known on origin'}`, `token ${credential ?? s.token}`, `delivery ${s.deliveryMode ?? 'unknown'}`];
  const hints = githubHints(s);
  const ready = s.token === 'stored' && credential === 'ok' && s.baseOnRemote !== false;
  return { name, status: ready ? 'ok' : 'warn', detail: `${ready ? 'ready' : 'incomplete'}: ${parts.join(', ')}`, ...(hints.length ? { hint: hints.join(' ') } : credential && credential !== 'ok' ? { hint: 'Run `minions setup github` to replace the token.' } : {}) };
}

/**
 * merge.readiness: what delivery can do now. PR/branch delivery is available with a GitHub remote and
 * credential; minions never merges and auto-merge is always reported as deferred.
 */
export function mergeReadiness(config: Pick<MinionsConfig, 'delivery'> | null, github: { onGitHub: boolean; credential: CredentialStatus['state'] | null }): [CheckStatus, string, string?] {
  const deferred = 'auto-merge is deferred (minions never merges)';
  const ready = github.onGitHub && github.credential === 'ok';
  if (!config) return ['unavailable', `configuration not loaded; ${deferred}`];
  const mode = config.delivery.mode;
  if (mode === 'local') {
    return ['unavailable', ready
      ? `local delivery (nothing is pushed); pull-request delivery is available: set delivery.mode "pull-request"; ${deferred}`
      : `local delivery only: branch/pull-request delivery needs ${github.onGitHub ? 'a valid GitHub token' : 'a GitHub remote and token'}; ${deferred}`];
  }
  const what = mode === 'pull-request' ? 'pull-request delivery available (push agent/<slug> and open a PR, never merged)' : 'branch delivery available (push agent/<slug>)';
  if (!github.onGitHub) return ['fail', `delivery.mode "${mode}" but the repository has no GitHub remote; ${deferred}`, 'Add a github.com origin or set delivery.mode "local".'];
  if (ready) return ['ok', `${what}; ${deferred}`];
  return ['warn', `delivery.mode "${mode}" cannot publish: GitHub credential ${github.credential ?? 'unknown'}; ${deferred}`, 'Run `minions auth github`; approved tasks wait (blocked) until `minions work publish` succeeds.'];
}

/**
 * ci.requiredChecks: whether the base branch has required status checks (read-only observation) and
 * how that maps to delivery.requiredChecksConfigured. No CI / no required checks is usable for local
 * work and pull-request delivery, never for automatic merge. Never 'fail'.
 */
export function requiredChecksReadiness(
  config: Pick<MinionsConfig, 'delivery' | 'verification' | 'git'> | null,
  rc: RequiredChecksReport | null,
  ctx: { onGitHub: boolean; unknownReason?: string; localWorkflows?: number },
): Check {
  const name = 'ci.requiredChecks';
  const noMerge = 'usable for local work and pull-request delivery; automatic merge unavailable';
  if (!ctx.onGitHub) return { name, status: 'unavailable', detail: `no GitHub remote: CI observation not applicable; ${noMerge}` };
  if (!config) return { name, status: 'unavailable', detail: 'configuration not loaded' };
  const flag = config.delivery.requiredChecksConfigured;
  const base = config.git.baseBranch;
  if (!rc || rc.state === 'unknown') {
    const why = ctx.unknownReason ?? rc?.errors.join('; ') ?? 'not checked';
    return { name, status: 'warn', detail: `unknown: required checks on ${base} could not be read (${why}); delivery.requiredChecksConfigured ${flag}`,
      hint: 'Rerun doctor with the container running and a GitHub token that can read the repository (`minions auth github`).' };
  }
  const workflows = rc.workflows ?? ctx.localWorkflows ?? null;
  if (rc.state === 'configured') {
    const detail = `required checks on ${base}: ${rc.requiredChecks.join(', ')}; delivery.requiredChecksConfigured ${flag}`;
    return flag
      ? { name, status: 'ok', detail: `${detail}; automatic merge is deferred (minions never merges)` }
      : { name, status: 'ok', detail, hint: 'Set delivery.requiredChecksConfigured to true to record that these checks gate merging.' };
  }
  const plan = ciSetupPlan({ hasWorkflows: workflows === null ? null : workflows > 0, requiredChecks: rc.state, verificationCommands: config.verification.commands, baseBranch: base, repository: rc.repository });
  const hint = plan.join('\n       ');
  const what = `no required status checks on ${base}${workflows === 0 ? ' and no CI workflows' : workflows ? ` (${workflows} workflow(s), none required)` : ''}`;
  if (flag) return { name, status: 'warn', detail: `${what}, but delivery.requiredChecksConfigured is true (never treated as zero required checks); ${noMerge}`, hint: `Set delivery.requiredChecksConfigured to false, or configure required checks:\n       ${hint}` };
  return { name, status: 'unavailable', detail: `${what}: ${noMerge}`, hint };
}

/** telegram.credential: ok / missing / invalid. Never 'fail': terminal mode must stay usable without Telegram. */
function telegramCredentialCheck(s: TelegramCredentialStatus, channel: MinionsConfig['communication']['channel'] | undefined): Check {
  const name = 'telegram.credential';
  switch (s.state) {
    case 'ok': return { name, status: 'ok', detail: `ok: ${s.detail}${channel === 'terminal' || !channel ? ' (unused: communication.channel is terminal; `minions channel set auto` uses it)' : ''}` };
    case 'missing': return channel === 'telegram'
      ? { name, status: 'warn', detail: `missing: ${s.detail}`, hint: 'Run `minions auth telegram`; until then the coordinator runs terminal-only.' }
      : channel === 'auto'
        ? { name, status: 'ok', detail: 'missing: optional (communication.channel is auto: terminal until a bot token is stored)', hint: 'For Telegram: create a bot with BotFather, then `minions auth telegram` and `minions down && minions start`.' }
        : { name, status: 'ok', detail: 'missing: not needed (communication.channel is terminal)' };
    default: return { name, status: 'warn', detail: `invalid: ${s.detail}`, hint: 'Store the token again with `minions auth telegram`.' };
  }
}

function telegramAccessCheck(r: { code: number; stdout: string; stderr: string }): Check {
  const name = 'telegram.access';
  let data: { access?: { state?: string; detail?: string; hint?: string }; coordinator?: { telegram?: { enabled?: boolean; reason?: string } } | null } | undefined;
  try { const env = JSON.parse(r.stdout) as { ok?: boolean; data?: typeof data }; if (env.ok) data = env.data; } catch { /* below */ }
  if (r.code !== 0 || !data?.access?.state) return { name, status: 'warn', detail: `telegram status unavailable: ${short(r.stderr || r.stdout) || 'no output'}`, hint: '`minions start` rebuilds an outdated image.' };
  const launched = data.coordinator?.telegram;
  const suffix = launched ? (launched.enabled ? '; running coordinator has Telegram' : `; running coordinator is terminal-only (${launched.reason ?? 'unknown reason'})`) : '';
  const detail = redact(`${data.access.state}: ${data.access.detail ?? ''}${suffix}`);
  return { name, status: data.access.state === 'ok' ? 'ok' : 'warn', detail, ...(data.access.hint ? { hint: redact(data.access.hint) } : {}) };
}

/**
 * setup: obvious configuration gaps left after init (no verification commands, GitHub remote without a
 * working token, Telegram selected without a bot token), with a pointer to the setup assistant.
 */
export function setupGapsCheck(config: Pick<MinionsConfig, 'verification' | 'communication'>,
  s: { onGitHub: boolean; githubCredential: CredentialStatus['state'] | null; telegramToken: TelegramCredentialStatus['state'] }): Check {
  const gaps: string[] = [];
  if (!config.verification.commands.length) gaps.push('no verification commands (verification.commands is empty)');
  if (s.onGitHub && s.githubCredential === 'missing') gaps.push('GitHub remote without a stored token');
  if (config.communication.channel === 'telegram' && s.telegramToken !== 'ok') gaps.push('Telegram selected without a valid bot token');
  if (config.communication.channel === 'auto' && s.telegramToken === 'invalid') gaps.push('the stored Telegram bot token is invalid (communication.channel auto)');
  return gaps.length
    ? { name: 'setup', status: 'warn', detail: `incomplete: ${gaps.join('; ')}`, hint: 'Run `minions setup assist` (AI setup assistant in Claude Code) to finish the remaining setup, or follow the hints above.' }
    : { name: 'setup', status: 'ok', detail: 'no obvious gaps (verification commands set; credentials match the configured delivery and channel)' };
}

/** Overall Telegram readiness from the channel resolution. Never 'fail': terminal is the baseline. */
export function telegramReadiness(res: ChannelResolution, tgPlugin: Check | undefined, token: TelegramCredentialStatus['state']): Check {
  const name = 'telegram';
  if (res.configured === 'terminal') return { name, status: 'ok', detail: 'terminal mode (Telegram not selected)' };
  if (!res.wantsTelegram) return { name, status: 'ok', detail: `auto: terminal mode (${res.reason})` };
  switch (res.cause) {
    case 'host-runtime': return { name, status: 'unavailable', detail: `unavailable: ${res.reason}; the coordinator runs terminal-only`, hint: 'Switch with `minions runtime set docker`, or `minions channel set terminal`.' };
    case 'network-none': return { name, status: 'unavailable', detail: 'unavailable: container.network is none; the coordinator runs terminal-only' };
    case 'no-token': case 'invalid-token':
      return { name, status: 'warn', detail: `${token === 'missing' ? 'missing' : 'invalid'}: bot token ${token}; the coordinator runs terminal-only`, hint: 'Run `minions auth telegram`.' };
    case 'unchecked': return { name, status: 'warn', detail: 'unknown: bot token stored; plugin availability not checked (container not running)', hint: 'Run `minions start`, then rerun doctor.' };
    case 'plugin-unavailable': case 'probe-not-run':
      return { name, status: 'unavailable', detail: `unavailable: ${tgPlugin?.detail ?? res.reason}; the coordinator runs terminal-only`, ...(tgPlugin?.hint ? { hint: tgPlugin.hint } : {}) };
    default: return { name, status: 'ok', detail: `ok: bot token stored and the official plugin is available${res.configured === 'auto' ? ' (communication.channel auto)' : ''} (see telegram.access for pairing)` };
  }
}

/** Launch permission mode reported by `minions coordinator --probe --json` (undefined: older output). */
function probePermission(stdout: string): { mode: string; fallback: boolean; reason: string } | undefined {
  try {
    const p = (JSON.parse(stdout) as { data?: { permission?: { mode?: unknown; fallback?: unknown; reason?: unknown } } }).data?.permission;
    return p && typeof p.mode === 'string' ? { mode: p.mode, fallback: p.fallback === true, reason: String(p.reason ?? '') } : undefined;
  } catch { return undefined; }
}

/** Host runtime: coordinator session, Claude auth on the host, launch probe, Telegram plugin (via the runtime shim). */
async function hostRuntimeChecks(project: ProjectJson, auth: ClaudeAuth, baseUrl: string | undefined, wantsTelegram: boolean,
  runner: Runner, add: Add, checks: Check[]): Promise<Check | undefined> {
  const host = new HostRuntime(project, runner);
  const running = await host.isRunning();
  add('coordinator', running ? 'ok' : 'warn', running ? `tmux server ${host.paths.tmuxSocket} has the coordinator session` : `not running (tmux server ${host.paths.tmuxSocket})`,
    running ? undefined : 'Run `minions start`.');
  if (!running && await clearStaleSecrets(project.projectId, false).catch(() => false)) {
    add('secrets.copy', 'warn', 'removed stale token copies from the secrets directory (host runtime not running)', '`minions start` writes them again.');
  }
  if (isKeyAuth(auth)) {
    const readable = await access(projectPaths(project.projectId).apiKeyFile, constants.R_OK).then(() => true, () => false);
    add('claude.auth', readable ? 'ok' : 'fail', readable ? 'key file readable; Claude Code uses apiKeyHelper' : 'key file not provisioned', readable ? undefined : 'Run `minions auth refresh`.');
  } else {
    const r = await runner('claude', ['auth', 'status'], { allowFailure: true, timeoutMs: 60_000 });
    add('claude.auth', r.code === 0 ? 'ok' : 'warn', r.code === 0 ? 'Claude Code on the host is logged in (your own login is used)' : 'Claude Code on the host is not logged in',
      r.code === 0 ? undefined : 'Run `claude` and /login once, or choose a key method with `minions auth set`.');
  }
  if (baseUrl) {
    const ok = await fetch(baseUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) }).then((res) => `HTTP ${res.status}`, () => null);
    add('claude.baseUrl', ok ? 'ok' : 'fail', ok ? `${maskValue(baseUrl)} reachable from the host (${ok})` : `${maskValue(baseUrl)} not reachable from the host`,
      ok ? undefined : 'Check the URL and that the service is running.');
  }
  if (!(await host.prepared())) {
    for (const n of ['claude.capabilities', 'telegram.plugin']) add(n, 'warn', 'skipped: host runtime not prepared yet', 'Run `minions start --no-attach`.');
    return undefined;
  }
  await prepareHostRuntime(project).catch(() => undefined);
  const ex = (args: string[]) => host.exec(args, { allowFailure: true, timeoutMs: 60_000 });
  const probe = await ex(['minions', 'coordinator', '--probe', '--json']);
  add('claude.capabilities', probe.code === 0 ? 'ok' : 'fail', probe.code === 0 ? 'Claude Code supports the coordinator launch flags; launch command resolves; sandbox settings applied' : `coordinator probe failed (exit ${probe.code}): ${short(probe.stderr || probe.stdout)}`);
  const tg = telegramDoctorCheck(await ex(['minions', 'telegram', 'probe', '--json']));
  add('telegram.plugin', tg.status, tg.detail, tg.hint);
  const tgPlugin = checks[checks.length - 1];
  if (wantsTelegram) checks.push(telegramAccessCheck(await ex(['minions', 'telegram', 'status', '--json'])));
  return tgPlugin;
}

/** `minions ci status --json` output from the container (gh api); null when unavailable (e.g. an older image). */
function parseCiStatus(r: { code: number; stdout: string }): RequiredChecksReport | null {
  if (r.code !== 0) return null;
  try {
    const env = JSON.parse(r.stdout) as { ok?: boolean; data?: { requiredChecks?: RequiredChecksReport | null } };
    const rc = env.ok ? env.data?.requiredChecks : null;
    return rc && typeof rc.state === 'string' && rc.state !== 'unknown' ? rc : null;
  } catch { return null; }
}

/** Host fallback: read-only GETs with the stored token when the container cannot answer. */
async function hostRequiredChecks(project: { projectId: string; remoteUrl: string | null }, config: MinionsConfig | undefined, credential: CredentialStatus['state'] | null,
  runner: Runner, f?: Fetch): Promise<{ rc: RequiredChecksReport | null; reason?: string }> {
  const r = githubRepoFromRemote(project.remoteUrl);
  if (!r || !config) return { rc: null, reason: 'configuration not loaded' };
  if (credential !== 'ok') return { rc: null, reason: `GitHub credential ${credential ?? 'unknown'}` };
  const token = await readGithubToken(project.projectId, runner).catch(() => null);
  if (!token) return { rc: null, reason: 'GitHub token unreadable' };
  return { rc: await requiredChecksStatus(fetchApi(token, f), `${r.owner}/${r.repo}`, config.git.baseBranch) };
}

export async function runDoctor(opts: { cwd: string; runner?: Runner; probe?: DockerProbe; fetch?: Fetch }): Promise<DoctorReport> {
  const runner = opts.runner ?? run;
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string, hint?: string) => checks.push({ name, status, detail, ...(hint ? { hint } : {}) });

  add('node', nodeVersionOk(process.version) ? 'ok' : 'fail', `host Node ${process.version} (requires >= 22.13)`,
    nodeVersionOk(process.version) ? undefined : 'Install Node 22.13 or newer.');

  // The runtime decides which checks apply (host runtime: no Docker; host tools instead).
  const pre = await projectForPath(opts.cwd).then((r) => loadProjectJson(r.projectId)).catch(() => null);
  const hostMode = !!pre && runtimeOf(pre) === 'host';
  const docker = hostMode
    ? { daemon: false, compose: false, serverVersion: null, composeVersion: null }
    : await (opts.probe ?? dockerProbe(runner))();
  if (hostMode) {
    add('runtime', 'warn', HOST_RUNTIME_SHORT, 'Switch back with `minions runtime set docker` (recommended for untrusted repositories).');
    for (const t of await hostTools(runner)) {
      add(`host.${t.name}`, t.ok ? 'ok' : t.required ? 'fail' : 'warn', t.detail, t.ok ? undefined : `Install: ${t.hint}`);
    }
  } else {
    if (pre) add('runtime', 'ok', 'docker (hardened container)');
    add('docker.daemon', docker.daemon ? 'ok' : 'fail', docker.daemon ? `Docker ${docker.serverVersion}` : `not reachable${docker.error ? `: ${short(docker.error)}` : ''}`,
      docker.daemon ? undefined : 'Start Docker Desktop.');
    add('docker.compose', docker.compose ? 'ok' : 'fail', docker.composeVersion ? `Compose ${docker.composeVersion}` : 'docker compose not found',
      docker.compose ? undefined : 'Install Docker Compose v2 or newer (bundled with Docker Desktop).');
  }

  let projectId: string | null = null;
  let effective: MinionsConfig | null = null;
  const github: { onGitHub: boolean; credential: CredentialStatus['state'] | null } = { onGitHub: false, credential: null };
  // Required status checks on the base branch (read-only GET only; never modifies repository settings).
  let ci: { rc: RequiredChecksReport | null; reason?: string } = { rc: null, reason: 'project not found' };
  try {
    const ref = await projectForPath(opts.cwd);
    projectId = ref.projectId;
    const project = pre ?? await loadProjectJson(ref.projectId);
    add('project', 'ok', `${project.projectId} (${project.visibility}, ${project.profile}) at ${project.repoPath}`);
    const auth = authOf(project);
    await hostAuthChecks(project.projectId, auth, add);
    const baseUrl = containerEnv(auth).ANTHROPIC_BASE_URL;
    let config: MinionsConfig | undefined;
    try {
      const eff = await loadEffectiveConfig(project);
      effective = config = eff.config;
      add('config', 'ok', `valid (revision ${eff.config.configRevision}, package ${eff.config.packageVersion})`);
      for (const u of listUnavailable(eff.config)) add(`config.${u.path}`, 'unavailable', u.reason);
    } catch (e) {
      add('config', 'fail', isMinionsError(e) ? e.message : String(e), 'Fix the configuration file, then rerun doctor.');
    }
    const gc = await githubCheck(project, runner, opts.fetch);
    add(...gc);
    github.onGitHub = githubRepoFromRemote(project.remoteUrl) !== null;
    github.credential = (['ok', 'missing', 'invalid', 'unverified'] as const).find((s) => gc[2].startsWith(`${s}:`)) ?? null;
    checks.push(await githubSetupCheck(project, ref.repoPath, github.credential, runner));
    const channel = config?.communication.channel;
    const tgCred = await telegramCredentialStatus(project.projectId, { runner })
      .catch((e): TelegramCredentialStatus => ({ state: 'invalid', detail: `could not check (${short(String((e as Error).message ?? e))})` }));
    checks.push(telegramCredentialCheck(tgCred, channel));
    const tokenFact = tgCred.state === 'missing' ? 'missing' : tgCred.state === 'invalid' ? 'invalid' : 'ok';
    const facts = { token: tokenFact, tokenDetail: tgCred.detail, runtime: runtimeOf(project), network: config?.container.network ?? 'outbound-internet' } as const;
    const wantsTelegram = !!channel && resolveChannel(channel, facts).wantsTelegram;
    if (tgCred.sharedWith?.length) {
      add('telegram.bot', 'warn', `bot ${tgCred.botId} is also provisioned for project(s) ${tgCred.sharedWith.join(', ')}; only one coordinator can poll a bot at a time`,
        'Create a separate bot per project (BotFather /newbot) and run `minions auth telegram` in one of them.');
    }
    let tgPlugin: Check | undefined;

    if (hostMode) {
      tgPlugin = await hostRuntimeChecks(project, auth, baseUrl, wantsTelegram, runner, add, checks);
    } else if (docker.daemon && docker.compose) {
      const label = await imageBuildLabel(project.imageTag, runner);
      const fp = buildFingerprint();
      if (label === null) add('image', 'warn', `${project.imageTag} not built yet`, '`minions start` builds it.');
      else if (fp !== null && label !== fp) add('image', 'warn', `${project.imageTag} was built from a different minions package`, '`minions start` rebuilds it and recreates the container.');
      else add('image', 'ok', project.imageTag);
      const compose = new Compose(project.projectId, runner);
      const running = await compose.isRunning();
      add('container', running ? 'ok' : 'warn', running ? `${compose.name} running` : `${compose.name} not running`, running ? undefined : 'Run `minions start`.');
      if (!running) {
        // Crash/reboot/Docker quit can leave plaintext token copies; the originals stay in the credential store.
        // Delete only when the container is confirmed gone (a restarting/paused/unknown one may still need them).
        const st = await compose.containerState();
        if (st.state === 'absent') {
          const removed = await clearStaleSecrets(project.projectId, false).catch(() => false);
          if (removed) add('secrets.copy', 'warn', 'removed stale token copies from the secrets directory (container not running)', '`minions start` writes them again.');
        } else if (await secretCopiesExist(project.projectId).catch(() => false)) {
          add('secrets.copy', 'warn', `token copies left in the secrets directory; not removed because the container state is uncertain (${st.reason})`, 'Run `minions down`, or `minions start` once Docker is healthy.');
        }
      }
      if (running) {
        const ex = (args: string[]) => compose.exec(args, { allowFailure: true, timeoutMs: 60_000 });
        if (isKeyAuth(auth)) {
          const r = await ex(['test', '-r', CONTAINER.apiKeyFile]);
          add('claude.auth', r.code === 0 ? 'ok' : 'fail', r.code === 0 ? `key readable at ${CONTAINER.apiKeyFile} (read-only mount); Claude uses apiKeyHelper` : `key not readable at ${CONTAINER.apiKeyFile} inside the container`,
            r.code === 0 ? undefined : 'Run `minions auth refresh`, then `minions start` (recreates the container with the secrets mount).');
        } else {
          const r = await ex(['claude', 'auth', 'status']);
          add('claude.auth', r.code === 0 ? 'ok' : 'warn', r.code === 0 ? 'logged in inside the container' : 'not logged in inside the container',
            r.code === 0 ? undefined : 'Run `minions start` and use /login in the coordinator session.');
        }
        if (baseUrl) {
          const r = await ex(['node', '-e', REACH_SCRIPT]);
          const out = short(r.stdout);
          add('claude.baseUrl', r.code === 0 && out.startsWith('HTTP ') ? 'ok' : 'fail',
            r.code === 0 && out.startsWith('HTTP ') ? `${maskValue(baseUrl)} reachable from the container (${out})` : `${maskValue(baseUrl)} not reachable from the container: ${out || short(r.stderr) || `exit ${r.code}`}`,
            r.code === 0 ? undefined : auth.preset === 'jbcentral' ? 'Make sure the Central proxy is running on the host (`minions auth refresh` starts it), then `minions start`.' : 'Check the URL and that the service listens on the host.');
        }
        const bl = await ex(['backlog', '--version']);
        add('backlog.cli', bl.code === 0 ? 'ok' : 'fail', bl.code === 0 ? `backlog.md ${short(bl.stdout)}` : `backlog CLI not usable: ${short(bl.stderr || bl.stdout)}`);
        const probe = await ex(['minions', 'coordinator', '--probe', '--json']);
        const perm = probe.code === 0 ? probePermission(probe.stdout) : undefined;
        add('claude.capabilities', probe.code !== 0 ? 'fail' : perm?.fallback ? 'warn' : 'ok', probe.code === 0
          ? `Claude Code supports the coordinator launch flags; launch command resolves${perm ? `; permission mode ${perm.mode}${perm.fallback ? ` (${perm.reason})` : ''}` : ''}`
          : `coordinator probe failed (exit ${probe.code}): ${short(probe.stderr || probe.stdout)}`);
        // Credential-free; never 'fail' because terminal mode must stay usable without Telegram.
        const tg = telegramDoctorCheck(await ex(['minions', 'telegram', 'probe', '--json']));
        add('telegram.plugin', tg.status, tg.detail, tg.hint);
        tgPlugin = checks[checks.length - 1];
        if (wantsTelegram) checks.push(telegramAccessCheck(await ex(['minions', 'telegram', 'status', '--json'])));
        if (github.onGitHub) ci = { rc: parseCiStatus(await ex(['minions', 'ci', 'status', '--json'])) };
      } else {
        for (const n of ['claude.auth', ...(baseUrl ? ['claude.baseUrl'] : []), 'backlog.cli', 'claude.capabilities', 'telegram.plugin']) add(n, 'warn', 'skipped: container not running');
      }
    } else {
      add('container', 'fail', 'skipped: Docker unavailable');
    }
    if (github.onGitHub && !ci.rc) ci = await hostRequiredChecks(project, config, github.credential, runner, opts.fetch);
    // Overall Telegram readiness: ok / missing / unavailable (never fail; terminal is the baseline).
    if (channel) {
      const probe = tgPlugin ? { available: tgPlugin.status === 'ok', summary: tgPlugin.detail, items: [] } : undefined;
      const res = resolveChannel(channel, { ...facts, probe });
      add('communication.channel', 'ok', `configured ${res.configured}, effective ${res.effective}${res.cause === 'unchecked' ? ' (predicted)' : ''}: ${res.reason}`);
      checks.push(telegramReadiness(res, tgPlugin, tgCred.state));
    }
    if (config) checks.push(setupGapsCheck(config, { onGitHub: github.onGitHub, githubCredential: github.credential, telegramToken: tgCred.state }));
  } catch (e) {
    add('project', 'warn', isMinionsError(e) ? e.message : String(e), 'Run `minions init` in this repository.');
  }

  add('merge.readiness', ...mergeReadiness(effective, github));
  checks.push(requiredChecksReadiness(effective, ci.rc, { onGitHub: github.onGitHub, unknownReason: ci.reason }));
  add('features', 'unavailable', DEFERRED_FEATURES.join(', '));
  add('package', 'ok', `minions ${VERSION}`);
  return { healthy: !checks.some((c) => c.status === 'fail'), projectId, checks };
}

export function formatDoctor(r: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', unavailable: 'n/a ' };
  const L = r.checks.map((c) => `[${icon[c.status]}] ${c.name}: ${c.detail}${c.hint ? `\n       hint: ${c.hint}` : ''}`);
  L.push('', r.healthy ? 'No blocking problems found.' : 'Blocking problems found (FAIL).');
  return L.join('\n');
}
