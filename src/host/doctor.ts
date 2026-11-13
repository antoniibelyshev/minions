// `minions doctor`: host, Docker, container, and configuration readiness. Never prints secrets.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFERRED_FEATURES, listUnavailable } from '../config/resolve.js';
import { can } from '../config/capabilities.js';
import { autoMergeConfigReasons } from '../config/delivery.js';
import { isMinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { redact } from '../core/output.js';
import { CONTAINER } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { DEFAULT_REFRESH_MINUTES, authOf, containerEnv, describeSource, expandHome, isKeyAuth, maskValue, resolveOnPath, secretStatus, type ClaudeAuth } from './auth.js';
import type { MinionsConfig } from '../config/schema.js';
import { clearStaleSecrets, secretCopiesExist, telegramCredentialStatus, type TelegramCredentialStatus } from './credentials.js';
import { dockerProbe, type DockerProbe, type DockerStatus } from './discovery.js';
import { composeHint, daemonHint, linuxDockerChecks, linuxHostFacts, unknownLinuxFacts, type LinuxHostFacts } from './linux-host.js';
import { Compose, buildFingerprint, imageBuildLabel, runtimeImageTag, tmpSizeMiB, type Runner } from './docker.js';
import { RESTART_COMMAND, checkRestartRequired, notApplicable, restartUnknown, type RestartRequired } from './restart-required.js';
import { telegramDoctorCheck } from '../telegram/probe.js';
import { fastPathHint } from '../backlog/taskfile.js';
import { resolveChannel, type ChannelResolution } from '../telegram/channel.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { mergeOverlay, projectOverlayText } from './control-overlay.js';
import type { EffectiveConfig } from '../config/resolve.js';
import { checkPlugin, pluginMismatch, type PluginCheck } from './install.js';
import { projectForPath } from './registry.js';
import { harnessChecks, harnessSkipChecks, parseWorkProbe } from './harness-checks.js';
import { hostOrphanHelperCheck, listHelperProcesses, type HelperProcess } from './helper-orphans.js';
import { harnessView } from '../runtime/sandbox/probe.js';
import { HANG_GUARD_TIMEOUT_TEST, hangGuarded } from '../runtime/hook-guard.js';
import { HOST_RUNTIME_SHORT, HostRuntime, ensureHostWorktreesDir, hostTools, hostWorktreesDirState, prepareHostRuntime, runtimeOf, type WorktreesDirState } from './runtime.js';
import type { ProjectJson } from './project.js';
import { projectPaths } from '../core/paths.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unavailable';
export interface Check { name: string; status: CheckStatus; detail: string; hint?: string }
/** `restartRequired`: the shared restart-required check (also the `restart` check; never a FAIL). */
export interface DoctorReport { healthy: boolean; projectId: string | null; checks: Check[]; restartRequired: RestartRequired }

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

/** /tmp (RAM-backed tmpfs, counted against the container memory limit) usage at or above this percentage warns. */
export const TMP_WARN_PERCENT = 80;
/** Disk scratch (TMPDIR on the cache volume) usage at or above this percentage warns. */
export const SCRATCH_WARN_PERCENT = 90;

interface DfRow { sizeKiB: number; usedKiB: number; percent: number; mount: string }

/** Parses `df -Pk <paths>` output (one row per argument, in order, after the header); unparseable rows are skipped. */
export function parseDf(out: string): DfRow[] {
  const rows: DfRow[] = [];
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const [sizeKiB, usedKiB] = [Number(f[1]), Number(f[2])];
    const percent = Number(f[4]!.replace('%', ''));
    if (![sizeKiB, usedKiB, percent].every(Number.isFinite)) continue;
    rows.push({ sizeKiB, usedKiB, percent, mount: f.slice(5).join(' ') });
  }
  return rows;
}

const mib = (kib: number) => `${Math.round(kib / 1024)} MiB`;

/**
 * container.tmp / container.scratch from `df -Pk /tmp <scratch>` run in the container. /tmp is RAM: high
 * usage (leftover test data, deleted-but-open files) is memory pressure and ENOSPC for tests, so it warns
 * from TMP_WARN_PERCENT. A /tmp size other than the configured cap, or a missing scratch dir, means the
 * container was created from an older compose.yaml. Never 'fail'.
 */
export function tmpUsageChecks(r: { code: number; stdout: string; stderr: string }, o: { capMiB: number; scratch: string }): Check[] {
  const rows = parseDf(r.stdout);
  const recreate = 'Run `minions upgrade` to regenerate compose.yaml and recreate the container from it (volumes kept).';
  const tmp = rows.find((x) => x.mount === '/tmp');
  const out: Check[] = [];
  if (!tmp) {
    out.push({ name: 'container.tmp', status: 'warn', detail: `could not read /tmp usage: ${short(r.stderr || r.stdout) || `exit ${r.code}`}` });
  } else {
    const detail = `/tmp ${tmp.percent}% used (${mib(tmp.usedKiB)} of ${mib(tmp.sizeKiB)}, RAM-backed tmpfs)`;
    const capKiB = o.capMiB * 1024;
    if (tmp.percent >= TMP_WARN_PERCENT) {
      out.push({ name: 'container.tmp', status: 'warn', detail: `${detail}: at or above ${TMP_WARN_PERCENT}%; it counts against the container memory limit`,
        hint: `Large temp data belongs in TMPDIR (${o.scratch}, on disk). Look for leftover test temp data or deleted-but-open files (lsof); \`minions down\` then \`minions start\` empties /tmp; raise container.tmpSizeMiB if more is really needed.` });
    } else if (tmp.sizeKiB !== capKiB) {
      out.push({ name: 'container.tmp', status: 'warn', detail: `${detail}; expected a ${o.capMiB} MiB cap (container created from an older compose.yaml)`, hint: recreate });
    } else {
      out.push({ name: 'container.tmp', status: 'ok', detail });
    }
  }
  const scratch = rows.find((x) => x !== tmp);
  if (!scratch) {
    out.push({ name: 'container.scratch', status: 'warn', detail: `TMPDIR scratch dir ${o.scratch} not found in the container`, hint: recreate });
  } else if (scratch.percent >= SCRATCH_WARN_PERCENT) {
    out.push({ name: 'container.scratch', status: 'warn', detail: `${o.scratch} (TMPDIR, cache volume) disk ${scratch.percent}% used (${mib(scratch.usedKiB)} of ${mib(scratch.sizeKiB)})`,
      hint: `Free disk space in Docker (docker system df) or remove leftover data under ${o.scratch}.` });
  } else {
    out.push({ name: 'container.scratch', status: 'ok', detail: `${o.scratch} (TMPDIR, disk-backed) on a volume ${scratch.percent}% used` });
  }
  return out;
}

/** Host-side auth checks that need no container: method, secret file, helper/source resolvable. */
export async function hostAuthChecks(projectId: string, a: ClaudeAuth, add: Add, runtime: 'docker' | 'host' = 'docker'): Promise<void> {
  add('claude.auth.method', 'ok', `${a.method}${a.preset ? ` (${a.preset})` : ''}: ${describeSource(a, runtime)}`);
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

/**
 * Local integration part of merge.readiness: off (opt-in), ready, or enabled with the reasons it cannot be used
 * (docs/design/local-auto-integration.md).
 */
export function autoMergeReadiness(
  config: Pick<MinionsConfig, 'delivery'> & Partial<Pick<MinionsConfig, 'verification' | 'capabilities' | 'sensitivePaths'>>,
): { ready: boolean; enabled: boolean; reasons: string[]; detail: string } {
  const enabled = config.delivery.merge === 'auto-when-eligible';
  if (!enabled) return { ready: false, enabled, reasons: [], detail: `local integration off: approved tasks end delivered and the coordinator merges them (opt-in: delivery.merge "auto-when-eligible" or \`minions setup\`; currently "${config.delivery.merge}")` };
  const why = autoMergeConfigReasons(config);
  if (why.length) return { ready: false, enabled, reasons: why, detail: `local integration enabled but not usable: ${why.join('; ')}` };
  const ask = config.capabilities && config.sensitivePaths ? can({ capabilities: config.capabilities, sensitivePaths: config.sensitivePaths }, 'base.merge') === 'ask' : false;
  const cmds = config.verification?.commands ?? [];
  return { ready: true, enabled, reasons: [], detail: `local integration ready: the runtime merges each approved head, runs the verification (${cmds.join(', ')}) on the merged tree and lands it on the base when it passes${ask ? '; base.merge "ask": each landing needs \`minions work approve <taskId> --head <sha>\` on the host' : '; sensitive paths need \`minions work approve <taskId> --head <sha>\` on the host'}` };
}

/** merge.readiness: local integration off, ready, or enabled-but-not-usable with reasons. Nothing is ever pushed. */
export function mergeReadiness(
  config: (Pick<MinionsConfig, 'delivery'> & Partial<Pick<MinionsConfig, 'verification' | 'capabilities' | 'sensitivePaths'>>) | null,
): [CheckStatus, string, string?] {
  if (!config) return ['unavailable', 'configuration not loaded; local integration not evaluated'];
  const am = autoMergeReadiness(config);
  if (am.enabled && am.ready) return ['ok', `local delivery (nothing is pushed); ${am.detail}`];
  if (am.enabled) return ['warn', `local delivery (nothing is pushed); ${am.detail}`, 'Fix the reasons above, or set delivery.merge "disabled" (the coordinator then merges approved branches).'];
  return ['ok', `local delivery (nothing is pushed); ${am.detail}`];
}

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
 * telegram.poller (task-51): whether the bot.pid poller is the running coordinator's, from the same
 * `minions telegram status --json`. Another claude session in the container that loads the plugin
 * replaces the coordinator's poller; this says so, with the recovery hint. Absent from older images.
 */
export function telegramPollerCheck(r: { code: number; stdout: string }): Check | null {
  if (r.code !== 0) return null;
  let p: { state?: string; detail?: string; hint?: string } | undefined;
  try { const env = JSON.parse(r.stdout) as { ok?: boolean; data?: { poller?: typeof p } }; if (env.ok) p = env.data?.poller; } catch { return null; }
  if (!p?.state || p.state === 'not-applicable') return null;
  const status = p.state === 'ok' ? 'ok' : 'warn';
  return { name: 'telegram.poller', status, detail: redact(p.detail ?? p.state), ...(p.hint && status !== 'ok' ? { hint: redact(p.hint) } : {}) };
}

/** telegram.server, telegram.access and telegram.poller from the runtime. Returns the server check. */
async function telegramRuntimeChecks(ex: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>, wantsTelegram: boolean, checks: Check[], opts: { host?: boolean } = {}): Promise<Check> {
  const tg = telegramDoctorCheck(await ex(['minions', 'telegram', 'probe', '--json']));
  const status = wantsTelegram ? await ex(['minions', 'telegram', 'status', '--json']) : null;
  const name = 'telegram.server';
  checks.push({ name, status: tg.status, detail: tg.detail, ...(tg.hint ? { hint: tg.hint } : {}) });
  if (status) { checks.push(telegramAccessCheck(status)); const pc = telegramPollerCheck(status); if (pc) checks.push(pc); }
  return { name, status: tg.status, detail: tg.detail, ...(tg.hint ? { hint: tg.hint } : {}) };
}

/**
 * setup: obvious configuration gaps left after init (no verification commands, no setup commands for the local
 * integration of a Node project, Telegram selected without a bot token).
 */
export function setupGapsCheck(config: Pick<MinionsConfig, 'verification' | 'communication'> & Partial<Pick<MinionsConfig, 'delivery'>>,
  s: { telegramToken: TelegramCredentialStatus['state']; nodeProject?: boolean }): Check {
  const gaps: string[] = [];
  if (!config.verification.commands.length) gaps.push('no verification commands (verification.commands is empty)');
  // Local integration verifies in its own worktree, which has no node_modules unless setup installs them (task-136).
  const localIntegration = config.delivery?.merge === 'auto-when-eligible';
  if (s.nodeProject && localIntegration && !config.verification.setupCommands?.length) {
    gaps.push('local integration is on for a Node project but verification.setupCommands is empty: the integration worktree has no node_modules, so verification fails with "command not found" (set it to e.g. `npm ci`, `pnpm i --frozen-lockfile` or `yarn --immutable`)');
  }
  if (config.communication.channel === 'telegram' && s.telegramToken !== 'ok') gaps.push('Telegram selected without a valid bot token');
  if (config.communication.channel === 'auto' && s.telegramToken === 'invalid') gaps.push('the stored Telegram bot token is invalid (communication.channel auto)');
  return gaps.length
    ? { name: 'setup', status: 'warn', detail: `incomplete: ${gaps.join('; ')}`, hint: 'Set the missing values with `minions settings set <key> <value>` (or ask the coordinator), or follow the hints above.' }
    : { name: 'setup', status: 'ok', detail: 'no obvious gaps (verification commands set; credentials match the configured channel)' };
}

/** Overall Telegram readiness from the channel resolution. Never 'fail': terminal is the baseline. */
export function telegramReadiness(res: ChannelResolution, tgPlugin: Check | undefined, token: TelegramCredentialStatus['state'], runtime: 'docker' | 'host' = 'docker'): Check {
  const name = 'telegram';
  const host = runtime === 'host';
  if (res.configured === 'terminal') return { name, status: 'ok', detail: 'terminal mode (Telegram not selected)' };
  if (!res.wantsTelegram) return { name, status: 'ok', detail: `auto: terminal mode (${res.reason})` };
  switch (res.cause) {
    case 'network-none': return { name, status: 'unavailable', detail: 'unavailable: container.network is none; the coordinator runs terminal-only' };
    case 'no-token': case 'invalid-token':
      return { name, status: 'warn', detail: `${token === 'missing' ? 'missing' : 'invalid'}: bot token ${token}; the coordinator runs terminal-only`, hint: 'Run `minions auth telegram`.' };
    case 'unchecked': return { name, status: 'warn', detail: `unknown: bot token stored; the minions channel server was not checked (${host ? 'host runtime not prepared' : 'container not running'})`, hint: 'Run `minions start`, then rerun doctor.' };
    case 'plugin-unavailable': case 'probe-not-run':
      return { name, status: 'unavailable', detail: `unavailable: ${tgPlugin?.detail ?? res.reason}; the coordinator runs terminal-only`, ...(tgPlugin?.hint ? { hint: tgPlugin.hint } : {}) };
    default: return { name, status: 'ok', detail: `ok: bot token stored and the minions channel server is available${res.configured === 'auto' ? ' (communication.channel auto)' : ''} (see telegram.access for pairing)` };
  }
}

/** Launch permission mode reported by `minions coordinator --probe --json` (undefined: older output). */
function probePermission(stdout: string): { mode: string; fallback: boolean; reason: string } | undefined {
  try {
    const p = (JSON.parse(stdout) as { data?: { permission?: { mode?: unknown; fallback?: unknown; reason?: unknown } } }).data?.permission;
    return p && typeof p.mode === 'string' ? { mode: p.mode, fallback: p.fallback === true, reason: String(p.reason ?? '') } : undefined;
  } catch { return undefined; }
}

/**
 * workspace.worktrees (task-3): the coordinator sandbox cannot create <repo>/.git/worktrees, so `minions work claim`
 * fails without it. A missing directory is created here, outside the sandbox, and reported.
 */
export async function worktreesDirCheck(repo: string, add: Add): Promise<WorktreesDirState> {
  const dir = `${repo}/.git/worktrees`;
  const before = await hostWorktreesDirState(repo);
  const after = before === 'missing' ? await ensureHostWorktreesDir(repo).catch((): WorktreesDirState => 'missing') : before;
  const start = 'Run `minions start --no-attach` (it creates the directory outside the sandbox).';
  if (after === 'no-repo') add('workspace.worktrees', 'warn', 'skipped: the host workspace has no repository yet', start);
  else if (after === 'invalid') add('workspace.worktrees', 'fail', `${dir} (or .git) is a symlink or not a directory; worker worktrees cannot be created`, `Remove it, then ${start[0]!.toLowerCase()}${start.slice(1)}`);
  else if (after === 'missing') add('workspace.worktrees', 'fail', `${dir} is missing and could not be created; \`minions work claim\` fails in the sandbox`, `Create it on the host: mkdir '${dir}'`);
  else if (before === 'missing') add('workspace.worktrees', 'warn', `${dir} was missing (sandboxed \`git worktree add\` cannot create it); created it`);
  else add('workspace.worktrees', 'ok', `${dir} exists; worker worktrees can be created from the sandbox`);
  return after;
}

/** Host runtime: coordinator session, Claude auth on the host, launch probe, Telegram plugin (via the runtime shim). */
async function hostRuntimeChecks(project: ProjectJson, auth: ClaudeAuth, baseUrl: string | undefined, wantsTelegram: boolean,
  runner: Runner, add: Add, checks: Check[], wantsIntegration = false, helperProcesses?: () => Promise<HelperProcess[]>): Promise<Check | undefined> {
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
  // The fail-closed hooks need their hang guard (coreutils `timeout`, else perl): without both every hook blocks.
  const guard = await runner('sh', ['-c', `${HANG_GUARD_TIMEOUT_TEST} && echo timeout || echo perl; ${hangGuarded('true', 5)}`], { allowFailure: true, timeoutMs: 15_000 });
  const via = guard.stdout.trim().split('\n')[0];
  add('hooks.hangGuard', guard.code === 0 ? 'ok' : 'fail',
    guard.code === 0 ? `hook hang guard works (${via === 'timeout' ? 'coreutils timeout' : 'perl watchdog'})` : `hook hang guard failed (exit ${guard.code}): neither coreutils timeout nor perl works, so every worker hook blocks`,
    guard.code === 0 ? undefined : 'Install perl or coreutils (`brew install coreutils` provides gtimeout; link it as `timeout` on PATH).');
  await worktreesDirCheck(host.paths.repo, add);
  // Supervisor/dispatcher processes of this project that are not the lock holders (e.g. after a state restore).
  const text = async (cmd: string, args: string[]) => { const r = await runner(cmd, args, { allowFailure: true, timeoutMs: 30_000 }); return r.code === 0 ? r.stdout : null; };
  checks.push(await hostOrphanHelperCheck(host.paths.state, join(host.paths.state, 'minions.db'), helperProcesses ?? (() => listHelperProcesses({ run: text }))));
  if (!(await host.prepared())) {
    for (const n of ['claude.capabilities', 'telegram.server']) add(n, 'warn', 'skipped: host runtime not prepared yet', 'Run `minions start --no-attach`.');
    return undefined;
  }
  await prepareHostRuntime(project).catch(() => undefined);
  const ex = (args: string[]) => host.exec(args, { allowFailure: true, timeoutMs: 60_000 });
  const probe = await ex(['minions', 'coordinator', '--probe', '--json']);
  if (wantsIntegration) checks.push(...integrationDoctorChecks(await ex(['minions', 'status', '--json'])));
  add('claude.capabilities', probe.code === 0 ? 'ok' : 'fail', probe.code === 0 ? 'Claude Code supports the coordinator launch flags; launch command resolves; sandbox settings applied' : `coordinator probe failed (exit ${probe.code}): ${short(probe.stderr || probe.stdout)}`);
  return telegramRuntimeChecks(ex, wantsTelegram, checks, { host: true });
}

/**
 * integration.* checks (local integration, task-82.4) from the runtime's `minions status --json`: its integration
 * block carries the problems the runtime derived (stale lock, halted queue, a dirty checkout, a crash during
 * `git merge --ff-only`). No block (an older image): no checks. One ok line when all is well.
 */
export function integrationDoctorChecks(r: { code: number; stdout: string }): Check[] {
  if (r.code !== 0) return [];
  try {
    const env = JSON.parse(r.stdout) as { ok?: boolean; data?: { integration?: { enabled?: boolean; problems?: unknown; queue?: unknown[]; lock?: { state?: string } } } };
    const i = env.ok ? env.data?.integration : undefined;
    if (!i || typeof i !== 'object') return [];
    const problems = Array.isArray(i.problems) ? i.problems.filter((p): p is Check & { status: 'warn' | 'fail' } =>
      !!p && typeof (p as Check).name === 'string' && ((p as Check).status === 'warn' || (p as Check).status === 'fail') && typeof (p as Check).detail === 'string') : [];
    if (problems.length) return problems.map((p) => ({ name: p.name, status: p.status, detail: redact(p.detail).slice(0, 600), ...(typeof p.hint === 'string' ? { hint: redact(p.hint).slice(0, 600) } : {}) }));
    const queued = Array.isArray(i.queue) ? i.queue.length : 0;
    return [{ name: 'integration', status: 'ok', detail: `local integration ${i.enabled ? 'on' : 'off'}; ${i.lock?.state === 'live' ? 'integrator running' : 'integrator idle'}; ${queued} queued` }];
  } catch { return []; }
}

/**
 * The `backlog.cli` check from `backlog --version` in the container. A release outside the line the
 * in-process task reader was validated against is a warning, not a failure: listings still work, through
 * one `backlog task view` per task (task-24.9).
 */
export function backlogCliCheck(r: { code: number; stdout: string; stderr: string }): Check {
  const name = 'backlog.cli';
  if (r.code !== 0) return { name, status: 'fail', detail: `backlog CLI not usable: ${short(r.stderr || r.stdout)}` };
  const v = short(r.stdout);
  const note = fastPathHint(v);
  return note
    ? { name, status: 'warn', detail: `backlog.md ${v}: ${note}`, hint: 'Use the backlog.md version the minions image ships (`minions upgrade`), or ignore if listings are fast enough.' }
    : { name, status: 'ok', detail: `backlog.md ${v}` };
}

/** The generated plugin (mounted read-only into the container) against what the installed package renders. */
export function pluginDoctorCheck(c: PluginCheck | Error, hostRuntime = false): Check {
  const refresh = hostRuntime ? '`minions down && minions start`' : '`minions upgrade` (or `minions down && minions start`)';
  if (c instanceof Error) return { name: 'plugin', status: 'warn', detail: `could not compare the plugin with the installed package: ${short(c.message)}` };
  const mismatch = pluginMismatch(c);
  if (mismatch === null) return { name: 'plugin', status: 'ok', detail: `${c.files} file(s) match the installed package (minions ${VERSION})` };
  return { name: 'plugin', status: 'warn', detail: `${c.dir}: ${mismatch}; the coordinator and workers run with these definitions`,
    hint: `Run ${refresh} to regenerate it from the installed package; files you edited are kept (delete them to regenerate).` };
}

/** The `restart` check from the shared restart-required result. Never 'fail': it only advises `minions upgrade`. */
export function restartCheck(r: RestartRequired): Check {
  const name = 'restart';
  switch (r.state) {
    case 'required': return { name, status: 'warn', detail: `restart required: ${r.reasons.map((x) => `${x.kind}: ${x.detail}`).join('; ')}`, hint: `Run \`${RESTART_COMMAND}\`.` };
    case 'current': return { name, status: 'ok', detail: r.detail };
    case 'not-running': return { name, status: 'ok', detail: r.detail };
    case 'not-applicable': return { name, status: 'unavailable', detail: r.detail };
    default: return { name, status: 'warn', detail: `unknown: ${r.detail}` };
  }
}

export async function runDoctor(opts: {
  cwd: string; runner?: Runner; probe?: DockerProbe; fingerprint?: string | null; version?: string;
  /** Host platform (tests); defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Linux fact probe (tests); defaults to linuxHostFacts through the runner. */
  linuxFacts?: (runner: Runner, docker: DockerStatus) => Promise<LinuxHostFacts>;
  /** Host runtime: running supervise/dispatch processes (tests); defaults to ps/lsof (or /proc). */
  helperProcesses?: () => Promise<HelperProcess[]>;
}): Promise<DoctorReport> {
  const runner = opts.runner ?? run;
  const checks: Check[] = [];
  let restart: RestartRequired = restartUnknown('project not found');
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
    // Linux (Docker Engine, no Desktop): probed facts pick the exact fix; other platforms keep the Desktop hints.
    const platform = opts.platform ?? process.platform;
    const facts = platform === 'linux'
      ? await (opts.linuxFacts ?? ((r, d) => linuxHostFacts(r, d)))(runner, docker).catch(() => unknownLinuxFacts())
      : unknownLinuxFacts();
    add('docker.daemon', docker.daemon ? 'ok' : 'fail', docker.daemon ? `Docker ${docker.serverVersion}` : `not reachable${docker.error ? `: ${short(docker.error)}` : ''}`,
      docker.daemon ? undefined : daemonHint(platform, docker, facts));
    add('docker.compose', docker.compose ? 'ok' : 'fail', docker.composeVersion ? `Compose ${docker.composeVersion}` : 'docker compose not found',
      docker.compose ? undefined : composeHint(platform, docker, facts));
    if (platform === 'linux' && docker.daemon) for (const c of linuxDockerChecks(facts)) checks.push(c);
  }

  let projectId: string | null = null;
  let effective: MinionsConfig | null = null;
  try {
    const ref = await projectForPath(opts.cwd);
    projectId = ref.projectId;
    const project = pre ?? await loadProjectJson(ref.projectId);
    add('project', 'ok', `${project.projectId} (${project.visibility}, ${project.mode}) at ${project.repoPath}`);
    const auth = authOf(project);
    await hostAuthChecks(project.projectId, auth, add, runtimeOf(project));
    const baseUrl = containerEnv(auth).ANTHROPIC_BASE_URL;
    let config: MinionsConfig | undefined;
    let baseEff: EffectiveConfig | null = null;
    /** The coordinator's control overlay on top of the host config (the runtime applies it): setup and merge.readiness see it. */
    const useOverlay = (text: string | null, err?: unknown) => {
      if (!baseEff) return;
      const m = mergeOverlay(baseEff, text);
      const warning = err !== undefined ? `the coordinator's control overlay could not be read (${short(String((err as Error)?.message ?? err))}); the host config alone is shown` : m.warning;
      if (warning) add('config.overlay', 'warn', warning, 'Inspect it in the runtime with `minions control show`.');
      else if (m.overlayKeys.length) add('config.overlay', 'ok', `the coordinator's control overlay sets ${m.overlayKeys.join(', ')} (applied on top of the host config)`);
      effective = config = m.config;
    };
    try {
      const eff = await loadEffectiveConfig(project);
      effective = config = eff.config;
      baseEff = eff;
      add('config', 'ok', `valid (revision ${eff.config.configRevision}, package ${eff.config.packageVersion})`);
      for (const u of listUnavailable(eff.config)) add(`config.${u.path}`, 'unavailable', u.reason);
      checks.push(pluginDoctorCheck(await checkPlugin(project, eff.config).catch((e: unknown) => e instanceof Error ? e : new Error(String(e))), hostMode));
      // Host runtime: the overlay is a local file. Docker: read below once the container is known to run.
      if (hostMode) await projectOverlayText(project).then((t) => useOverlay(t), (e: unknown) => useOverlay(null, e));
    } catch (e) {
      add('config', 'fail', isMinionsError(e) ? e.message : String(e), 'Fix the configuration file, then rerun doctor.');
    }
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

    // Process harnesses (D7): only when the config assigns one; Claude-only projects get no harness.* checks.
    const harnesses = harnessView(config);
    if (hostMode) {
      restart = notApplicable('host runtime: no container to restart');
      tgPlugin = await hostRuntimeChecks(project, auth, baseUrl, wantsTelegram, runner, add, checks, !!config, opts.helperProcesses);
      checks.push(...harnessSkipChecks(harnesses, 'host-runtime'));
    } else if (docker.daemon && docker.compose) {
      const tag = runtimeImageTag(project);
      const label = await imageBuildLabel(tag, runner);
      const fp = opts.fingerprint !== undefined ? opts.fingerprint : buildFingerprint();
      if (label === null) add('image', 'warn', `${tag} not built yet`, '`minions start` builds it.');
      else if (fp !== null && label !== fp) add('image', 'warn', `${tag} was built from a different minions package`, '`minions start` rebuilds it and recreates the container.');
      else add('image', 'ok', tag);
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
        if (baseEff) await projectOverlayText(project, { running: async () => true, exec: ex }).then((t) => useOverlay(t), (e: unknown) => useOverlay(null, e));
        checks.push(...tmpUsageChecks(await ex(['df', '-Pk', '/tmp', CONTAINER.scratch]), { capMiB: tmpSizeMiB(project.container), scratch: CONTAINER.scratch }));
        checks.push(backlogCliCheck(await ex(['backlog', '--version'])));
        if (config) checks.push(...integrationDoctorChecks(await ex(['minions', 'status', '--json'])));
        const probe = await ex(['minions', 'coordinator', '--probe', '--json']);
        const perm = probe.code === 0 ? probePermission(probe.stdout) : undefined;
        add('claude.capabilities', probe.code !== 0 ? 'fail' : perm?.fallback ? 'warn' : 'ok', probe.code === 0
          ? `Claude Code supports the coordinator launch flags; launch command resolves${perm ? `; permission mode ${perm.mode}${perm.fallback ? ` (${perm.reason})` : ''}` : ''}`
          : `coordinator probe failed (exit ${probe.code}): ${short(probe.stderr || probe.stdout)}`);
        // Credential-free; never 'fail' because terminal mode must stay usable without Telegram.
        tgPlugin = await telegramRuntimeChecks(ex, wantsTelegram, checks);
        // The self-test takes a few seconds on the first run per container start (cached after that).
        if (harnesses.processHarnesses.length) {
          const probe = await compose.exec(['minions', 'work', 'probe', '--json'], { allowFailure: true, timeoutMs: 180_000 });
          checks.push(...harnessChecks(harnesses, parseWorkProbe(probe)));
        }
      } else {
        for (const n of ['claude.auth', ...(baseUrl ? ['claude.baseUrl'] : []), 'container.tmp', 'container.scratch', 'backlog.cli', 'claude.capabilities', 'telegram.plugin']) add(n, 'warn', 'skipped: container not running');
        checks.push(...harnessSkipChecks(harnesses, 'not-running'));
      }
      restart = await checkRestartRequired({ projectId: project.projectId, imageTag: runtimeImageTag(project), compose, runner,
        ...(effective ? { apt: { project, config: effective } } : {}),
        ...(opts.fingerprint !== undefined ? { fingerprint: opts.fingerprint } : {}), ...(opts.version !== undefined ? { version: opts.version } : {}) });
    } else {
      add('container', 'fail', 'skipped: Docker unavailable');
      checks.push(...harnessSkipChecks(harnesses, 'no-docker'));
      restart = restartUnknown('Docker unavailable');
    }
    // Overall Telegram readiness: ok / missing / unavailable (never fail; terminal is the baseline).
    if (channel) {
      const probe = tgPlugin ? { available: tgPlugin.status === 'ok', summary: tgPlugin.detail, items: [] } : undefined;
      const res = resolveChannel(channel, { ...facts, probe });
      add('communication.channel', 'ok', `configured ${res.configured}, effective ${res.effective}${res.cause === 'unchecked' ? ' (predicted)' : ''}: ${res.reason}`);
      checks.push(telegramReadiness(res, tgPlugin, tgCred.state, facts.runtime));
    }
    if (config) {
      const nodeProject = await stat(join(ref.repoPath, 'package.json')).then((x) => x.isFile(), () => false);
      checks.push(setupGapsCheck(config, { telegramToken: tgCred.state, nodeProject }));
    }
  } catch (e) {
    add('project', 'warn', isMinionsError(e) ? e.message : String(e), 'Run `minions init` in this repository.');
  }

  add('merge.readiness', ...mergeReadiness(effective));
  add('features', 'unavailable', DEFERRED_FEATURES.join(', '));
  if (projectId) checks.push(restartCheck(restart));
  add('package', 'ok', `minions ${VERSION}`);
  return { healthy: !checks.some((c) => c.status === 'fail'), projectId, checks, restartRequired: restart };
}

export function formatDoctor(r: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', unavailable: 'n/a ' };
  const L = r.checks.map((c) => `[${icon[c.status]}] ${c.name}: ${c.detail}${c.hint ? `\n       hint: ${c.hint}` : ''}`);
  L.push('', r.healthy ? 'No blocking problems found.' : 'Blocking problems found (FAIL).');
  return L.join('\n');
}

/** Blocking problems (a FAIL check) make `doctor` / `status --check` exit non-zero; warnings keep exit 0. */
export function applyDoctorExit(r: DoctorReport): void {
  if (!r.healthy) process.exitCode = 1;
}
