// `minions doctor`: host, Docker, container, and configuration readiness. Never prints secrets.
import { stat } from 'node:fs/promises';
import { DEFERRED_FEATURES, listUnavailable } from '../config/resolve.js';
import { isMinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { redact } from '../core/output.js';
import { CONTAINER } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { DEFAULT_REFRESH_MINUTES, authOf, containerEnv, describeSource, expandHome, isKeyAuth, maskValue, resolveOnPath, secretStatus, type ClaudeAuth } from './auth.js';
import { dockerProbe, type DockerProbe } from './discovery.js';
import { Compose, buildFingerprint, imageBuildLabel, type Runner } from './docker.js';
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

export async function runDoctor(opts: { cwd: string; runner?: Runner; probe?: DockerProbe }): Promise<DoctorReport> {
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
    const auth = authOf(project);
    await hostAuthChecks(project.projectId, auth, add);
    const baseUrl = containerEnv(auth).ANTHROPIC_BASE_URL;
    try {
      const eff = await loadEffectiveConfig(project);
      add('config', 'ok', `valid (revision ${eff.config.configRevision}, package ${eff.config.packageVersion})`);
      for (const u of listUnavailable(eff.config)) add(`config.${u.path}`, 'unavailable', u.reason);
    } catch (e) {
      add('config', 'fail', isMinionsError(e) ? e.message : String(e), 'Fix the configuration file, then rerun doctor.');
    }

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
        add('claude.capabilities', probe.code === 0 ? 'ok' : 'fail', probe.code === 0 ? 'Claude Code supports the coordinator launch flags; launch command resolves' : `coordinator probe failed (exit ${probe.code}): ${short(probe.stderr || probe.stdout)}`);
      } else {
        for (const n of ['claude.auth', ...(baseUrl ? ['claude.baseUrl'] : []), 'backlog.cli', 'claude.capabilities']) add(n, 'warn', 'skipped: container not running');
      }
    } else {
      add('container', 'fail', 'skipped: Docker unavailable');
    }
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
