// `minions upgrade` (host): moves a running project onto the installed minions package without losing
// progress. The host drives the container through `docker compose exec`; lease and pause state stay in
// the runtime DB (state volume). Decision record: docs/design/bootstrap.md, "Upgrade".
//
// Order: preflight -> pause starts -> drain leases -> refresh derived files -> image (rebuilt only when
// the build fingerprint changed) -> secrets -> recreate the container (named volumes kept) -> workspace
// setup -> origin configuration (importRepo) -> resume starts -> coordinator restart --recover.
//
// - Starts are resumed before the coordinator restarts: its recovery prompt dispatches only when starts
//   are not paused. Starts paused by the user before the upgrade stay paused.
// - Any failure before the container is recreated resumes starts and leaves the running container as is.
//   After the recreate, every remaining step is still attempted (best effort) and failures are reported.
// - A pause made by an upgrade that did not finish is remembered in <project dir>/upgrade.json, so a rerun
//   (or the remaining steps) still resumes it.
// - Never `compose down -v`, never removes volumes, never re-clones the workspace: the repository clone,
//   worktrees, Backlog.md tasks, runtime DB and Claude login all live in named volumes.
// - Before all of that, the optional source phase (src/host/upgrade-source.ts) runs: --from-container
//   fast-forwards a host branch to the container's base branch, and an installed CLI that differs from
//   the project's minions checkout is rebuilt/reinstalled (the rest then runs on the new CLI) or the
//   exact command is printed and the upgrade stops before any container step.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { readJsonIfExists, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import { materializeSecrets, upClearingSecretsOnFailure } from './credentials.js';
import { buildFingerprint, ensureImage, imageBuildLabel, packageRoot, type Compose, type Runner } from './docker.js';
import { parseEnvelope, type ImportResult } from './transfer.js';
import type { CliCheck, SourcePhase, SourceStop, SyncResult } from './upgrade-source.js';

export const DEFAULT_UPGRADE_TIMEOUT_SEC = 1800;
export const UPGRADE_RELEASE_REASON = 'interrupted by minions upgrade --now (container recreated); re-dispatch on recovery';

export type UpgradeStepId = 'sync' | 'cli' | 'preflight' | 'pause' | 'drain' | 'files' | 'image' | 'secrets' | 'recreate' | 'workspace' | 'origin' | 'resume' | 'coordinator';
export const UPGRADE_STEPS: readonly UpgradeStepId[] = ['sync', 'cli', 'preflight', 'pause', 'drain', 'files', 'image', 'secrets', 'recreate', 'workspace', 'origin', 'resume', 'coordinator'];
export type UpgradeStepStatus = 'done' | 'skipped' | 'failed' | 'planned';
export interface UpgradeStep { id: UpgradeStepId; status: UpgradeStepStatus; detail: string }

export interface LeaseInfo { id: string; task_id: string; role: string }

export interface UpgradeResult {
  projectId: string;
  dryRun: boolean;
  /** Every executed step succeeded (dry run: the plan is executable as far as can be told). */
  ok: boolean;
  steps: UpgradeStep[];
  /** Leases released by --now (their tasks are re-dispatched by the coordinator's recovery). */
  interrupted: LeaseInfo[];
  image: { tag: string; rebuild: boolean; fingerprint: string | null; previous: string | null };
  coordinator: { action?: string; running?: boolean; reason?: string } | null;
  /** Source phase (present when it ran): the --from-container fast-forward and the installed-CLI check. */
  sync?: SyncResult | null;
  cli?: CliCheck | null;
  /** The upgrade stopped before the container steps: run `command`, then `rerun`. */
  stopped?: SourceStop | null;
  /** The container steps ran on the newly installed CLI (after a rebuild/reinstall). */
  continued?: boolean;
}

export interface UpgradeOptions {
  projectId: string;
  imageTag: string;
  compose: Compose;
  /** Seconds to wait for active leases to end (0: do not wait). */
  timeoutSec: number;
  /** Release the leases still active when the wait ends instead of aborting. */
  now?: boolean;
  dryRun?: boolean;
  /** Runner for image inspect/build (the compose handle carries its own). */
  runner?: Runner;
  /** Package root the image is built from (default: the running CLI's package). */
  root?: string;
  /** Regenerates compose.yaml, the runtime config and the plugin from the installed package. */
  refresh: () => Promise<string[]>;
  /** Re-runs the repository import, which (re)configures origin; an existing clone is only refreshed. */
  importRepo: () => Promise<ImportResult>;
  materialize?: () => Promise<unknown>;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  pollMs?: number;
  /** Source phase run first (--from-container sync and the CLI check); see src/host/upgrade-source.ts. */
  source?: () => Promise<SourcePhase<UpgradeResult>>;
}

interface Marker { pausedStarts: boolean; at: string }
const markerPath = (projectId: string) => join(projectPaths(projectId).dir, 'upgrade.json');

const lastLine = (r: { stdout: string; stderr: string }) =>
  (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? 'no output';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const leaseLabel = (l: LeaseInfo) => `${l.id} (${l.task_id}, ${l.role})`;

export async function runUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const { compose, projectId } = opts;
  const log = opts.log ?? (() => undefined);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = opts.clock ?? Date.now;
  const pollMs = opts.pollMs ?? 5000;
  const root = opts.root ?? packageRoot();
  const steps: UpgradeStep[] = [];
  const step = (id: UpgradeStepId, status: UpgradeStepStatus, detail: string) => { steps.push({ id, status, detail }); if (!opts.dryRun) log(`${id}: ${detail}`); };
  const result: UpgradeResult = {
    projectId, dryRun: !!opts.dryRun, ok: true, steps, interrupted: [],
    image: { tag: opts.imageTag, rebuild: false, fingerprint: null, previous: null }, coordinator: null,
  };

  // ---- source phase (host only; before any container step) ----
  if (opts.source) {
    const s = await opts.source();
    steps.push(...s.steps);
    result.sync = s.sync; result.cli = s.cli; result.stopped = s.stop;
    if (!s.ok) result.ok = false;
    if (s.stop) { result.ok = false; return result; }
    if (s.continued) return { ...s.continued, steps: [...steps, ...s.continued.steps], sync: s.sync, cli: s.cli, stopped: null, continued: true };
  }

  // Container-side status: pause state and active leases (runtime DB in the state volume).
  const status = async (): Promise<{ paused: { intake: boolean; starts: boolean }; activeLeases: LeaseInfo[] }> => {
    const r = await compose.exec(['minions', 'status', '--json'], { allowFailure: true, timeoutMs: 60_000 });
    const d = parseEnvelope<{ paused: { intake: boolean; starts: boolean }; activeLeases: LeaseInfo[] }>(r.stdout, 'status');
    return { paused: d.paused, activeLeases: d.activeLeases ?? [] };
  };
  const execOk = async (args: string[], what: string, timeoutMs = 120_000) => {
    const r = await compose.exec(args, { allowFailure: true, timeoutMs });
    if (r.code !== 0) throw new MinionsError('INTERNAL', `${what} failed in the container: ${lastLine(r)}`);
    return r;
  };

  // ---- preflight (read-only) ----
  const container = await compose.containerState();
  const fingerprint = buildFingerprint(root);
  const previous = await imageBuildLabel(opts.imageTag, opts.runner).catch(() => null);
  const rebuild = previous === null || (fingerprint !== null && previous !== fingerprint);
  result.image = { tag: opts.imageTag, rebuild, fingerprint, previous };
  const marker = await readJsonIfExists<Marker>(markerPath(projectId)).catch(() => undefined);
  let before: Awaited<ReturnType<typeof status>> | null = null;
  let preflightError: string | null = null;
  if (container.state === 'unknown') preflightError = `container state is unknown (${container.reason})`;
  else if (rebuild && fingerprint === null) preflightError = `the package at ${root} has no dist/cli.js; cannot build the runtime image`;
  else if (container.state === 'running') {
    try { before = await status(); } catch (e) { preflightError = `cannot read the runtime status: ${errMsg(e)}`; }
  }
  const running = container.state === 'running';
  // Starts paused by an unfinished upgrade count as ours; starts paused by the user stay paused.
  const userPaused = !!before?.paused.starts && !marker?.pausedStarts;

  if (opts.dryRun) {
    const p = (id: UpgradeStepId, detail: string) => step(id, 'planned', detail);
    if (preflightError) { step('preflight', 'failed', preflightError); result.ok = false; }
    else step('preflight', 'done', `container ${container.state}; image ${rebuild ? (previous === null ? 'missing' : 'outdated') : 'current'}`);
    if (!running) { step('pause', 'skipped', 'container not running'); step('drain', 'skipped', 'container not running'); }
    else {
      if (userPaused) step('pause', 'skipped', 'starts already paused (left paused)'); else p('pause', 'pause new starts (minions pause --starts)');
      const n = before?.activeLeases.length ?? 0;
      p('drain', n === 0 ? 'no active leases' : opts.now && opts.timeoutSec === 0
        ? `release ${n} active lease(s) now and report them interrupted: ${before!.activeLeases.map(leaseLabel).join(', ')}`
        : `wait up to ${opts.timeoutSec}s for ${n} active lease(s), then ${opts.now ? 'release the rest (reported interrupted)' : 'abort and resume starts'}`);
    }
    p('files', 'regenerate compose.yaml, runtime config and plugin from the installed package');
    if (rebuild) p('image', `build ${opts.imageTag} (${previous === null ? 'missing' : 'fingerprint changed'})`); else step('image', 'skipped', 'fingerprint unchanged; no rebuild');
    p('secrets', 'materialize stored tokens into the secrets mount');
    p('recreate', 'docker compose up --force-recreate (named volumes kept)');
    p('workspace', 'minions workspace setup');
    p('origin', 'refresh the repository import and origin configuration (existing clone kept)');
    if (userPaused) step('resume', 'skipped', 'starts were paused before the upgrade; left paused'); else p('resume', 'resume new starts (minions resume --starts)');
    p('coordinator', 'minions coordinator restart --recover');
    return result;
  }

  if (preflightError) {
    step('preflight', 'failed', preflightError);
    throw new MinionsError('PRECONDITION', `Upgrade not started: ${preflightError}.`,
      container.state === 'unknown' ? 'Check `docker compose ps` for the project, then rerun `minions upgrade`.' : 'Fix the cause and rerun `minions upgrade`.', { steps });
  }
  step('preflight', 'done', `container ${container.state}; image ${rebuild ? 'needs a rebuild' : 'current'}`);

  // From here until the recreate, a failure resumes what we paused and leaves the container running.
  let ownPause = !!marker?.pausedStarts;
  const resume = async () => {
    await execOk(['minions', 'resume', '--starts', '--json'], 'resume');
    ownPause = false;
    await rm(markerPath(projectId), { force: true });
  };
  const aborted = new WeakSet<object>();
  const abort = async (id: UpgradeStepId, e: unknown): Promise<never> => {
    if (e && typeof e === 'object' && aborted.has(e)) throw e; // already reported by an inner abort
    if (!steps.some((s) => s.id === id)) step(id, 'failed', errMsg(e));
    if (ownPause && running) {
      try { await resume(); step('resume', 'done', 'starts resumed after the aborted upgrade'); }
      catch (re) { step('resume', 'failed', `${errMsg(re)}; run \`minions resume --starts\``); }
    }
    const err = e instanceof MinionsError ? e : new MinionsError('INTERNAL', errMsg(e));
    const out = new MinionsError(err.code, `Upgrade aborted at ${id}: ${err.message}`, err.hint ?? 'The container was not recreated; fix the cause and rerun `minions upgrade`.', { steps });
    aborted.add(out);
    throw out;
  };

  // ---- pause + drain ----
  if (!running) {
    step('pause', 'skipped', 'container not running');
    step('drain', 'skipped', 'container not running');
  } else {
    if (userPaused) step('pause', 'skipped', 'starts already paused (left paused after the upgrade)');
    else if (before!.paused.starts) step('pause', 'skipped', 'starts still paused by an unfinished upgrade (resumed at the end)');
    else {
      try {
        await writeJson(markerPath(projectId), { pausedStarts: true, at: new Date().toISOString() } satisfies Marker);
        ownPause = true;
        await execOk(['minions', 'pause', '--starts', '--json'], 'pause');
        step('pause', 'done', 'new starts paused');
      } catch (e) { await abort('pause', e); }
    }
    try {
      const deadline = clock() + opts.timeoutSec * 1000;
      let leases = before!.activeLeases;
      let shown = '';
      for (;;) {
        if (leases.length === 0) break;
        const ids = leases.map((l) => l.id).join(',');
        if (ids !== shown) { log(`waiting for ${leases.length} active lease(s): ${leases.map(leaseLabel).join(', ')}`); shown = ids; }
        if (clock() >= deadline) break;
        await sleep(Math.min(pollMs, Math.max(0, deadline - clock())));
        leases = (await status()).activeLeases;
      }
      if (leases.length === 0) step('drain', 'done', 'no active leases');
      else if (!opts.now) {
        step('drain', 'failed', `${leases.length} lease(s) still active after ${opts.timeoutSec}s: ${leases.map(leaseLabel).join(', ')}`);
        await abort('drain', new MinionsError('PRECONDITION', `${leases.length} worker lease(s) still active after ${opts.timeoutSec}s (${leases.map((l) => l.task_id).join(', ')})`,
          'Starts were resumed and the container was not touched. Rerun with a longer --timeout, or with --now to release them (their tasks are re-dispatched after the upgrade).'));
      } else {
        for (const l of leases) {
          await execOk(['minions', 'work', 'release', l.id, '--reason', UPGRADE_RELEASE_REASON, '--json'], `work release ${l.id}`);
          result.interrupted.push({ id: l.id, task_id: l.task_id, role: l.role });
        }
        step('drain', 'done', `released ${leases.length} lease(s) as interrupted: ${leases.map(leaseLabel).join(', ')}`);
      }
    } catch (e) { await abort('drain', e); }
  }

  // ---- files + image ----
  try {
    const warnings = await opts.refresh();
    for (const w of warnings) log(`warning: ${w}`);
    step('files', 'done', 'derived files regenerated');
  } catch (e) { await abort('files', e); }
  try {
    const built = await ensureImage(opts.imageTag, { runner: opts.runner, root, onBuild: log });
    result.image.rebuild = built;
    step('image', built ? 'done' : 'skipped', built ? `built ${opts.imageTag}` : 'fingerprint unchanged; no rebuild');
  } catch (e) { await abort('image', e); }

  // ---- secrets + recreate ----
  try {
    await (opts.materialize ?? (() => materializeSecrets(projectId)))();
    step('secrets', 'done', 'stored tokens materialized');
  } catch (e) { step('secrets', 'failed', `a stored token is not available to the container: ${errMsg(e)}`); result.ok = false; }
  try {
    await upClearingSecretsOnFailure({ up: () => compose.recreate() }, projectId);
    step('recreate', 'done', 'container recreated; named volumes kept');
  } catch (e) {
    step('recreate', 'failed', errMsg(e));
    throw new MinionsError('INTERNAL', `Upgrade failed while recreating the container: ${errMsg(e)}`,
      'Volumes are intact. Rerun `minions upgrade` (it also resumes the starts it paused) or `minions start`.', { steps });
  }

  // ---- after the recreate: best effort, every step attempted ----
  const attempt = async (id: UpgradeStepId, fn: () => Promise<string>) => {
    try { step(id, 'done', await fn()); } catch (e) { step(id, 'failed', errMsg(e)); result.ok = false; }
  };
  await attempt('workspace', async () => { await execOk(['minions', 'workspace', 'setup', '--json'], 'workspace setup'); return 'state layout and runtime DB checked'; });
  await attempt('origin', async () => {
    const r = await opts.importRepo();
    for (const w of [...r.warnings, ...(r.container.origin?.warnings ?? [])]) log(`warning: ${w}`);
    return r.container.origin ? `origin ${r.container.origin.url} (${r.container.origin.authenticated ? 'authenticated' : 'not authenticated'})` : `${r.baseBranch} refreshed; no origin`;
  });
  if (ownPause) await attempt('resume', async () => { await resume(); return 'new starts resumed'; });
  else step('resume', 'skipped', userPaused ? 'starts were paused before the upgrade; left paused' : 'starts were not paused by the upgrade');
  await attempt('coordinator', async () => {
    const r = await compose.exec(['minions', 'coordinator', 'restart', '--recover', '--json'], { allowFailure: true, timeoutMs: 120_000 });
    const d = parseEnvelope<{ action?: string; running?: boolean; reason?: string }>(r.stdout, 'coordinator restart');
    result.coordinator = d;
    return `${d.action ?? 'unknown'} (${d.reason ?? ''})`;
  });
  return result;
}

export function formatUpgrade(r: UpgradeResult): string {
  const mark: Record<UpgradeStepStatus, string> = { done: 'ok  ', skipped: 'skip', failed: 'FAIL', planned: 'plan' };
  return [
    r.dryRun ? `Upgrade plan for ${r.projectId} (dry run; nothing changed):` : `Upgrade of ${r.projectId}: ${r.stopped ? 'stopped' : r.ok ? 'complete' : 'finished with failures'}.`,
    ...r.steps.map((s) => `  [${mark[s.status]}] ${s.id}: ${s.detail}`),
    ...(r.stopped ? [`Stopped before the container steps (nothing in the container changed): ${r.stopped.reason}.`, 'Run:', `  ${r.stopped.command}`, 'then:', `  ${r.stopped.rerun}`] : []),
    ...(r.continued ? ['The container steps ran on the newly installed CLI.'] : []),
    ...(r.interrupted.length ? [`Interrupted leases (re-dispatched by the coordinator's recovery): ${r.interrupted.map(leaseLabel).join(', ')}`] : []),
  ].join('\n');
}
