// `minions doctor`: host, Docker, container, and configuration readiness. Never prints secrets.
import { DEFERRED_FEATURES, listUnavailable } from '../config/resolve.js';
import type { MinionsConfig } from '../config/schema.js';
import { isMinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { redact } from '../core/output.js';
import { VERSION } from '../core/version.js';
import { githubCredentialStatus, githubRepoFromRemote, type CredentialStatus, type Fetch } from './credentials.js';
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
      ? [name, 'warn', `missing: ${s.detail}`, 'Run `minions auth github` (needed for branch/pull-request delivery).']
      : [name, 'ok', 'missing: not needed (no GitHub remote)'];
    case 'invalid': return [name, 'fail', `invalid: ${s.detail}`, 'Create a new fine-grained token and run `minions auth github`.'];
    case 'unverified': return [name, 'warn', `unverified: ${s.detail}`, 'Check network access to api.github.com and rerun doctor.'];
  }
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
  let effective: MinionsConfig | null = null;
  const github: { onGitHub: boolean; credential: CredentialStatus['state'] | null } = { onGitHub: false, credential: null };
  try {
    const ref = await projectForPath(opts.cwd);
    projectId = ref.projectId;
    const project = await loadProjectJson(ref.projectId);
    add('project', 'ok', `${project.projectId} (${project.visibility}, ${project.profile}) at ${project.repoPath}`);
    try {
      const eff = await loadEffectiveConfig(project);
      effective = eff.config;
      add('config', 'ok', `valid (revision ${eff.config.configRevision}, package ${eff.config.packageVersion})`);
      for (const u of listUnavailable(eff.config)) add(`config.${u.path}`, 'unavailable', u.reason);
    } catch (e) {
      add('config', 'fail', isMinionsError(e) ? e.message : String(e), 'Fix the configuration file, then rerun doctor.');
    }
    const gc = await githubCheck(project, runner, opts.fetch);
    add(...gc);
    github.onGitHub = githubRepoFromRemote(project.remoteUrl) !== null;
    github.credential = (['ok', 'missing', 'invalid', 'unverified'] as const).find((s) => gc[2].startsWith(`${s}:`)) ?? null;

    if (docker.daemon && docker.compose) {
      const label = await imageBuildLabel(project.imageTag, runner);
      const fp = buildFingerprint();
      if (label === null) add('image', 'warn', `${project.imageTag} not built yet`, '`minions start` builds it.');
      else if (fp !== null && label !== fp) add('image', 'warn', `${project.imageTag} was built from a different minions package`, '`minions start` rebuilds it and recreates the container.');
      else add('image', 'ok', project.imageTag);
      const compose = new Compose(project.projectId, runner);
      const running = await compose.isRunning();
      add('container', running ? 'ok' : 'warn', running ? `${compose.name} running` : `${compose.name} not running`, running ? undefined : 'Run `minions start`.');
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
      } else {
        for (const n of ['claude.auth', 'backlog.cli', 'claude.capabilities', 'telegram.plugin']) add(n, 'warn', 'skipped: container not running');
      }
    } else {
      add('container', 'fail', 'skipped: Docker unavailable');
    }
  } catch (e) {
    add('project', 'warn', isMinionsError(e) ? e.message : String(e), 'Run `minions init` in this repository.');
  }

  add('merge.readiness', ...mergeReadiness(effective, github));
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
