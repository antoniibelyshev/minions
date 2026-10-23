// Restart-required detection (host, Docker runtime): does the running container still match what
// `minions upgrade` would give it now? Shared by `minions status` and `minions doctor` (both include it
// in --json). Read-only, never throws: anything that cannot be read is reported as unchecked, and a
// container that is not running (or a Docker that does not answer) is `not-running` / `unknown`.
//
// Reasons (a typed, extensible list; each one is fixed by `minions upgrade`):
// - image:              the container runs an image built from another minions package (its `minions.build`
//                       label differs from the installed package's build fingerprint), or a newer image was
//                       built for the tag after the container was created;
// - cli-version:        `minions --version` inside the container differs from the host CLI's VERSION;
// - credential-mounts:  the secrets directory bind mount is missing, comes from another host path, or is writable;
// - coordinator-launch: the running coordinator's launch record fingerprint (channel, network, bot token
//                       hash) differs from the current one (`coordinatorLaunch` of the container's status).
import { realpathSync } from 'node:fs';
import { run } from '../core/exec.js';
import { CONTAINER, projectPaths } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import type { RunResult } from '../core/exec.js';
import { Compose, buildFingerprint, imageId, packageRoot, type Runner } from './docker.js';
import { loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { runtimeOf } from './runtime.js';
import { MinionsError } from '../core/errors.js';

/** The exact command that applies every restart-required change. */
export const RESTART_COMMAND = 'minions upgrade';

export type RestartReasonKind = 'image' | 'cli-version' | 'credential-mounts' | 'coordinator-launch';
export const RESTART_REASON_KINDS: readonly RestartReasonKind[] = ['image', 'cli-version', 'credential-mounts', 'coordinator-launch'];

export interface RestartReason {
  kind: RestartReasonKind;
  detail: string;
  /** What the running container has / what the host would give it now (when meaningful). */
  running?: string | null;
  current?: string | null;
}

/**
 * required: at least one reason; current: every check ran and none applies; unknown: no reason found
 * but some checks could not run (or Docker did not answer); not-running: no container to compare;
 * not-applicable: host runtime (no container).
 */
export type RestartState = 'required' | 'current' | 'unknown' | 'not-running' | 'not-applicable';

export interface RestartRequired {
  state: RestartState;
  required: boolean;
  reasons: RestartReason[];
  /** Checks that could not run, with why. */
  unchecked: { kind: RestartReasonKind; detail: string }[];
  /** `minions upgrade` when required, else null. */
  command: string | null;
  detail: string;
}

/** Subset of the container's `minions status --json` data used here (absent in images older than task-3.4). */
export interface ContainerStatusLike { coordinatorLaunch?: { state?: string; reason?: string } | null }

export interface RestartCheckOptions {
  projectId: string;
  imageTag: string;
  compose: Compose;
  runner?: Runner;
  /** Build fingerprint of the installed package (default: buildFingerprint(packageRoot())). */
  fingerprint?: string | null;
  /** Host CLI version (default: VERSION). */
  version?: string;
  /** Container status already read by the caller (saves an exec); otherwise `minions status --json` is run. */
  status?: ContainerStatusLike | null;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const lastLine = (r: { stdout: string; stderr: string }) => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? 'no output';
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

function result(reasons: RestartReason[], unchecked: RestartRequired['unchecked']): RestartRequired {
  if (reasons.length) {
    return { state: 'required', required: true, reasons, unchecked, command: RESTART_COMMAND,
      detail: `restart required: ${reasons.map((r) => r.detail).join('; ')}` };
  }
  if (unchecked.length) {
    return { state: 'unknown', required: false, reasons, unchecked, command: null,
      detail: `no restart-required change found, but not everything could be checked: ${unchecked.map((u) => `${u.kind} (${u.detail})`).join('; ')}` };
  }
  return { state: 'current', required: false, reasons, unchecked, command: null, detail: 'the running container matches the installed minions (image, CLI version, credential mounts, coordinator launch)' };
}

export const notApplicable = (detail: string): RestartRequired => ({ state: 'not-applicable', required: false, reasons: [], unchecked: [], command: null, detail });
export const restartUnknown = (detail: string): RestartRequired => ({ state: 'unknown', required: false, reasons: [], unchecked: [], command: null, detail });

/** Parses the data of a `minions status --json` envelope; null when it is not a successful envelope. */
export function parseStatusEnvelope(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  try {
    const env = JSON.parse(line) as { ok?: boolean; data?: unknown };
    return env.ok && env.data && typeof env.data === 'object' ? env.data as Record<string, unknown> : null;
  } catch { return null; }
}

/** The error of an `ok:false` envelope in `stdout` (last line), or null when it is anything else. */
export function parseErrorEnvelope(stdout: string): { code: string; message: string; hint?: string } | null {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  try {
    const env = JSON.parse(line) as { ok?: boolean; error?: { code?: unknown; message?: unknown; hint?: unknown } };
    if (env.ok !== false || !env.error || typeof env.error.message !== 'string') return null;
    return { code: typeof env.error.code === 'string' ? env.error.code : 'INTERNAL', message: env.error.message,
      ...(typeof env.error.hint === 'string' ? { hint: env.error.hint } : {}) };
  } catch { return null; }
}

/** Compares the running container with what `minions upgrade` would give it now. Never throws. */
export async function checkRestartRequired(opts: RestartCheckOptions): Promise<RestartRequired> {
  try {
    return await check(opts);
  } catch (e) {
    return restartUnknown(`restart check failed: ${errMsg(e)}`);
  }
}

async function check(opts: RestartCheckOptions): Promise<RestartRequired> {
  const runner = opts.runner ?? run;
  const { compose } = opts;
  const st = await compose.containerState();
  if (st.state === 'absent') return { state: 'not-running', required: false, reasons: [], unchecked: [], command: null, detail: `container not running (${st.reason}); \`minions start\` uses the current image` };
  if (st.state === 'unknown') return restartUnknown(`container state unknown (${st.reason})`);

  const reasons: RestartReason[] = [];
  const unchecked: RestartRequired['unchecked'] = [];

  // ---- image + credential mounts (docker inspect of the running container) ----
  const c = await compose.inspectRunning().catch(() => null);
  if (!c) {
    unchecked.push({ kind: 'image', detail: 'could not inspect the running container' }, { kind: 'credential-mounts', detail: 'could not inspect the running container' });
  } else {
    let fp: string | null;
    try { fp = opts.fingerprint !== undefined ? opts.fingerprint : buildFingerprint(packageRoot()); } catch { fp = null; }
    const tagId = await imageId(opts.imageTag, runner).catch(() => null);
    if (fp !== null && c.buildLabel !== fp) {
      reasons.push({ kind: 'image', running: c.buildLabel || null, current: fp,
        detail: `the container runs an image built from a different minions package (build ${c.buildLabel || 'unlabeled'}; installed package ${fp})` });
    } else if (tagId !== null && tagId !== c.image) {
      reasons.push({ kind: 'image', running: c.image, current: tagId, detail: `a newer ${opts.imageTag} image was built after the container was created` });
    } else if (fp === null && tagId === null) {
      unchecked.push({ kind: 'image', detail: 'no build fingerprint for the installed package and the image tag could not be inspected' });
    }

    const expected = projectPaths(opts.projectId).secretsDir;
    const m = c.mounts.find((x) => x.destination === CONTAINER.secretsDir);
    if (!m) {
      reasons.push({ kind: 'credential-mounts', running: null, current: expected, detail: `the secrets directory is not mounted at ${CONTAINER.secretsDir} (container created by an older minions)` });
    } else if (m.source !== expected && real(m.source) !== real(expected)) {
      reasons.push({ kind: 'credential-mounts', running: m.source, current: expected, detail: `the secrets directory is mounted from ${m.source}, expected ${expected}` });
    } else if (m.rw) {
      reasons.push({ kind: 'credential-mounts', running: 'rw', current: 'ro', detail: 'the secrets directory is mounted writable (expected read-only)' });
    }
  }

  // ---- CLI version inside the container ----
  const host = opts.version ?? VERSION;
  const v = await compose.exec(['minions', '--version'], { allowFailure: true, timeoutMs: 30_000 }).catch((e): RunResult => ({ code: 1, stdout: '', stderr: errMsg(e) }));
  const cv = v.code === 0 ? v.stdout.trim().split('\n').filter(Boolean).at(-1)?.trim() ?? '' : '';
  if (!cv) unchecked.push({ kind: 'cli-version', detail: `minions --version failed in the container: ${lastLine(v)}` });
  else if (cv !== host) reasons.push({ kind: 'cli-version', running: cv, current: host, detail: `the container runs minions ${cv}, the host CLI is ${host}` });

  // ---- coordinator launch fingerprint (computed inside the container) ----
  let status = opts.status;
  if (status === undefined) {
    const r = await compose.exec(['minions', 'status', '--json'], { allowFailure: true, timeoutMs: 60_000 }).catch((e): RunResult => ({ code: 1, stdout: '', stderr: errMsg(e) }));
    status = parseStatusEnvelope(r.stdout) as ContainerStatusLike | null;
    if (!status) unchecked.push({ kind: 'coordinator-launch', detail: `minions status failed in the container: ${lastLine(r)}` });
  }
  if (status) {
    const l = status.coordinatorLaunch;
    if (!l || typeof l.state !== 'string') {
      // An older image cannot report it; its CLI version mismatch already says why.
      if (!reasons.some((r) => r.kind === 'cli-version')) unchecked.push({ kind: 'coordinator-launch', detail: 'the container does not report the coordinator launch fingerprint' });
    } else if (l.state === 'stale') {
      reasons.push({ kind: 'coordinator-launch', detail: `stale coordinator launch fingerprint: ${l.reason ?? 'launch settings changed'}` });
    } else if (l.state === 'unrecorded') {
      unchecked.push({ kind: 'coordinator-launch', detail: l.reason ?? 'no launch record' });
    }
  }
  return result(reasons, unchecked);
}

/** Human lines for status/doctor output (empty when there is nothing to say). */
export function formatRestartRequired(r: RestartRequired): string[] {
  if (r.state === 'required') return [`restart required (run \`${RESTART_COMMAND}\`):`, ...r.reasons.map((x) => `  - ${x.kind}: ${x.detail}`)];
  if (r.state === 'unknown') return [`restart required: unknown (${r.detail})`];
  if (r.state === 'current') return ['restart required: no'];
  return [];
}

export type HostStatus =
  | { kind: 'delegate' }
  | { kind: 'raw'; result: RunResult }
  | { kind: 'report'; status: Record<string, unknown>; restartRequired: RestartRequired };

/**
 * Host `minions status` for the Docker runtime: the container's `minions status --json` plus the
 * restart-required check. The host runtime keeps the plain delegation (`delegate`); output the host
 * cannot parse is passed through (`raw`).
 */
export async function hostStatus(opts: { cwd: string; args?: string[]; runner?: Runner; fingerprint?: string | null; version?: string }): Promise<HostStatus> {
  const runner = opts.runner ?? run;
  const { projectId } = await projectForPath(opts.cwd);
  const project = await loadProjectJson(projectId);
  if (runtimeOf(project) === 'host') return { kind: 'delegate' };
  const compose = new Compose(projectId, runner);
  if (!(await compose.isRunning())) {
    throw new MinionsError('PRECONDITION', 'The project container is not running.', 'Run `minions start` (or `minions start --no-attach`) first.');
  }
  // Extra status arguments are forwarded to the container's `minions status` (never silently dropped).
  const r = await compose.exec(['minions', 'status', ...(opts.args ?? []).filter((a) => a !== '--json'), '--json'], { allowFailure: true, timeoutMs: 60_000 });
  const status = parseStatusEnvelope(r.stdout);
  if (!status) return { kind: 'raw', result: r };
  const restartRequired = await checkRestartRequired({
    projectId, imageTag: project.imageTag, compose, runner, status: status as ContainerStatusLike,
    ...(opts.fingerprint !== undefined ? { fingerprint: opts.fingerprint } : {}), ...(opts.version !== undefined ? { version: opts.version } : {}),
  });
  return { kind: 'report', status, restartRequired };
}
