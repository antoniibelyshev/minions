// `minions doctor`: host, Docker, container, and configuration readiness. Never prints secrets.
import { DEFERRED_FEATURES, listUnavailable } from '../config/resolve.js';
import { isMinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { redact } from '../core/output.js';
import { VERSION } from '../core/version.js';
import type { MinionsConfig } from '../config/schema.js';
import { clearStaleSecrets, secretCopiesExist, githubCredentialStatus, githubRepoFromRemote, telegramCredentialStatus, type CredentialStatus, type Fetch, type TelegramCredentialStatus } from './credentials.js';
import { dockerProbe, type DockerProbe } from './discovery.js';
import { Compose, buildFingerprint, imageBuildLabel, type Runner } from './docker.js';
import { telegramDoctorCheck } from '../telegram/probe.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unavailable';
export interface Check { name: string; status: CheckStatus; detail: string; hint?: string }
export interface DoctorReport { healthy: boolean; projectId: string | null; checks: Check[] }

const short = (s: string) => redact(s.trim().split('\n').slice(-1)[0] ?? '').slice(0, 300);

export function nodeVersionOk(v: string): boolean {
  const [maj = 0, min = 0] = v.replace(/^v/, '').split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 13);
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
      ? [name, 'warn', `missing: ${s.detail}`, 'Run `minions auth github` (needed for upcoming push/PR delivery).']
      : [name, 'ok', 'missing: not needed (no GitHub remote)'];
    case 'invalid': return [name, 'fail', `invalid: ${s.detail}`, 'Create a new fine-grained token and run `minions auth github`.'];
    case 'unverified': return [name, 'warn', `unverified: ${s.detail}`, 'Check network access to api.github.com and rerun doctor.'];
  }
}

/** telegram.credential: ok / missing / invalid. Never 'fail': terminal mode must stay usable without Telegram. */
function telegramCredentialCheck(s: TelegramCredentialStatus, channel: MinionsConfig['communication']['channel'] | undefined): Check {
  const name = 'telegram.credential';
  const wanted = channel === 'telegram';
  switch (s.state) {
    case 'ok': return { name, status: 'ok', detail: `ok: ${s.detail}${wanted ? '' : ' (unused: communication.channel is terminal)'}` };
    case 'missing': return wanted
      ? { name, status: 'warn', detail: `missing: ${s.detail}`, hint: 'Run `minions auth telegram`; until then the coordinator runs terminal-only.' }
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

export async function runDoctor(opts: { cwd: string; runner?: Runner; probe?: DockerProbe; fetch?: Fetch }): Promise<DoctorReport> {
  const runner = opts.runner ?? run;
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string, hint?: string) => checks.push({ name, status, detail, ...(hint ? { hint } : {}) });

  add('node', nodeVersionOk(process.version) ? 'ok' : 'fail', `host Node ${process.version} (requires >= 22.13)`,
    nodeVersionOk(process.version) ? undefined : 'Install Node 22.13 or newer.');

  const docker = await (opts.probe ?? dockerProbe(runner))();
  add('docker.daemon', docker.daemon ? 'ok' : 'fail', docker.daemon ? `Docker ${docker.serverVersion}` : `not reachable${docker.error ? `: ${short(docker.error)}` : ''}`,
    docker.daemon ? undefined : 'Start Docker Desktop.');
  add('docker.compose', docker.compose ? 'ok' : 'fail', docker.composeVersion ? `Compose ${docker.composeVersion}` : 'docker compose not found',
    docker.compose ? undefined : 'Install Docker Compose v2 or newer (bundled with Docker Desktop).');

  let projectId: string | null = null;
  try {
    const ref = await projectForPath(opts.cwd);
    projectId = ref.projectId;
    const project = await loadProjectJson(ref.projectId);
    add('project', 'ok', `${project.projectId} (${project.visibility}, ${project.profile}) at ${project.repoPath}`);
    let config: MinionsConfig | undefined;
    try {
      const eff = await loadEffectiveConfig(project);
      config = eff.config;
      add('config', 'ok', `valid (revision ${eff.config.configRevision}, package ${eff.config.packageVersion})`);
      for (const u of listUnavailable(eff.config)) add(`config.${u.path}`, 'unavailable', u.reason);
    } catch (e) {
      add('config', 'fail', isMinionsError(e) ? e.message : String(e), 'Fix the configuration file, then rerun doctor.');
    }
    add(...await githubCheck(project, runner, opts.fetch));
    const channel = config?.communication.channel;
    const tgCred = await telegramCredentialStatus(project.projectId, { runner })
      .catch((e): TelegramCredentialStatus => ({ state: 'invalid', detail: `could not check (${short(String((e as Error).message ?? e))})` }));
    checks.push(telegramCredentialCheck(tgCred, channel));
    if (tgCred.sharedWith?.length) {
      add('telegram.bot', 'warn', `bot ${tgCred.botId} is also provisioned for project(s) ${tgCred.sharedWith.join(', ')}; only one coordinator can poll a bot at a time`,
        'Create a separate bot per project (BotFather /newbot) and run `minions auth telegram` in one of them.');
    }
    let tgPlugin: Check | undefined;

    if (docker.daemon && docker.compose) {
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
          add('secrets.copy', 'warn', `token copies left in the secrets directory; not removed because the container state is uncertain (${st.reason})`, 'Run `minions stop`, or `minions start` once Docker is healthy.');
        }
      }
      if (running) {
        const ex = (args: string[]) => compose.exec(args, { allowFailure: true, timeoutMs: 60_000 });
        const auth = await ex(['claude', 'auth', 'status']);
        add('claude.auth', auth.code === 0 ? 'ok' : 'warn', auth.code === 0 ? 'logged in inside the container' : 'not logged in inside the container',
          auth.code === 0 ? undefined : 'Run `minions start` and use /login in the coordinator session.');
        const bl = await ex(['backlog', '--version']);
        add('backlog.cli', bl.code === 0 ? 'ok' : 'fail', bl.code === 0 ? `backlog.md ${short(bl.stdout)}` : `backlog CLI not usable: ${short(bl.stderr || bl.stdout)}`);
        const probe = await ex(['minions', 'coordinator', '--probe', '--json']);
        add('claude.capabilities', probe.code === 0 ? 'ok' : 'fail', probe.code === 0 ? 'Claude Code supports the coordinator launch flags; launch command resolves' : `coordinator probe failed (exit ${probe.code}): ${short(probe.stderr || probe.stdout)}`);
        // Credential-free; never 'fail' because terminal mode must stay usable without Telegram.
        const tg = telegramDoctorCheck(await ex(['minions', 'telegram', 'probe', '--json']));
        add('telegram.plugin', tg.status, tg.detail, tg.hint);
        tgPlugin = checks[checks.length - 1];
        if (channel === 'telegram') checks.push(telegramAccessCheck(await ex(['minions', 'telegram', 'status', '--json'])));
      } else {
        for (const n of ['claude.auth', 'backlog.cli', 'claude.capabilities', 'telegram.plugin']) add(n, 'warn', 'skipped: container not running');
      }
    } else {
      add('container', 'fail', 'skipped: Docker unavailable');
    }
    // Overall Telegram readiness: ok / missing / unavailable (never fail; terminal is the baseline).
    if (channel !== 'telegram') add('telegram', 'ok', 'terminal mode (Telegram not selected)');
    else if (config?.container.network === 'none') add('telegram', 'unavailable', 'unavailable: container.network is none; the coordinator runs terminal-only');
    else if (tgCred.state !== 'ok') add('telegram', 'warn', `${tgCred.state === 'missing' ? 'missing' : 'invalid'}: bot token ${tgCred.state}; the coordinator runs terminal-only`, 'Run `minions auth telegram`.');
    else if (!tgPlugin) add('telegram', 'warn', 'unknown: bot token stored; plugin availability not checked (container not running)', 'Run `minions start`, then rerun doctor.');
    else if (tgPlugin.status !== 'ok') add('telegram', 'unavailable', `unavailable: ${tgPlugin.detail}; the coordinator runs terminal-only`, tgPlugin.hint);
    else add('telegram', 'ok', 'ok: bot token stored and the official plugin is available (see telegram.access for pairing)');
  } catch (e) {
    add('project', 'warn', isMinionsError(e) ? e.message : String(e), 'Run `minions init` in this repository.');
  }

  add('merge.readiness', 'unavailable', 'automatic merge and PR delivery are deferred in v0.1 (local delivery only)');
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
