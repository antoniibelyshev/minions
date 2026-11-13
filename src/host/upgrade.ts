// `minions upgrade` (host): moves a running project onto the installed minions package without losing
// progress. The host drives the container through `docker compose exec`; lease and pause state stay in
// the runtime DB (state volume). Decision record: docs/design/bootstrap.md, "Upgrade".
//
// Order: preflight -> pause starts + request a drain -> wait for the leases to wind down -> refresh derived files -> image (rebuilt only when
// the build fingerprint changed) -> secrets -> recreate the container (named volumes kept) -> workspace
// setup -> origin configuration (importRepo) -> resume starts -> coordinator restart --recover.
//
// - Starts are resumed before the coordinator restarts: its recovery prompt dispatches only when starts
//   are not paused. Starts paused by the user before the upgrade stay paused.
// - Any failure before the container is recreated (including a secrets failure) resumes starts and leaves
//   the running container as is. After the recreate, every remaining step is still attempted (best effort)
//   and failures are reported.
// - A pause made by an upgrade that did not finish is remembered in <project dir>/upgrade.json with its
//   runtime `controls` event id, so a rerun resumes exactly that pause and never a later one by the user.
// - SIGINT/SIGTERM before the recreate resumes the starts this upgrade paused and prints a rerun hint;
//   after the recreate has started it only prints the hint (the marker makes the rerun finish the job).
// - The drain request (`minions pause --starts --drain --reason upgrade`, durable in the runtime DB) makes
//   running workers commit work in progress (`wip:`) and return partial results (a PreToolUse hook in the
//   plugin); recovery re-dispatches their tasks. Resuming starts clears it; when the starts stay paused
//   (the user's pause) the finish or abort clears it with `minions resume --drain`. A runtime without
//   drain support (an older image) is only waited for. --timeout/--now stay the hard fallback.
// - The drain tolerates a few failed status polls (backoff), and a --now release answered with CONFLICT
//   "already ended" means the lease finished on its own.
// - Never `compose down -v`, never removes volumes, never re-clones the workspace: the repository clone,
//   worktrees, Backlog.md tasks, runtime DB and Claude login all live in named volumes.
// - Before all of that, the optional source phase (src/host/upgrade-source.ts) runs: --from-container
//   fast-forwards a host branch to the container's base branch, and an installed CLI that differs from
//   the project's minions checkout is rebuilt/reinstalled (the rest then runs on the new CLI) or the
//   exact command is printed and the upgrade stops before any container step.
// - Host runtime (opts.host, task-7): the same source phase, preflight, pause, drain, files, secrets, resume and
//   coordinator steps run through the project's minions shim instead of `docker compose exec`. There is no image,
//   container or import step: in their place the `shim` step regenerates the minions shim for the installed
//   CLI (prepareHostRuntime), and it is the point of no return the recreate is for Docker. The preflight refuses a
//   CLI that lives in (or links into) the agent-writable host runtime dirs: the shims run it outside the sandbox.
//   The coordinator restart (no --force) is refused while a worker lease is active, so it runs only after the drain.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { readJsonIfExists, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import type { RunOptions, RunResult } from '../core/exec.js';
import { materializeSecrets, upClearingSecretsOnFailure } from './credentials.js';
import { aptImageTag, buildFingerprint, ensureAptImage, ensureImage, imageBuildLabel, packageRoot, type Compose, type Runner } from './docker.js';
import { parseEnvelope, type ImportResult } from './transfer.js';
import type { CliCheck, SourcePhase, SourceStop, SyncResult } from './upgrade-source.js';
import { isChangeRequestId } from '../runtime/change-requests.js';

export const DEFAULT_UPGRADE_TIMEOUT_SEC = 1800;
/** --timeout <seconds>: a whole number >= 0 (empty is refused); default DEFAULT_UPGRADE_TIMEOUT_SEC, or 0 with --now. */
export function upgradeTimeout(raw: string | undefined, now: boolean): number {
  if (raw === undefined) return now ? 0 : DEFAULT_UPGRADE_TIMEOUT_SEC;
  const n = /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) throw new MinionsError('PRECONDITION', `--timeout must be a whole number of seconds (got "${raw}").`);
  return n;
}
export const UPGRADE_RELEASE_REASON = 'interrupted by minions upgrade --now (container recreated); re-dispatch on recovery';

export type UpgradeStepId = 'sync' | 'cli' | 'preflight' | 'pause' | 'drain' | 'files' | 'image' | 'secrets' | 'recreate' | 'shim' | 'workspace' | 'import' | 'resume' | 'coordinator';
export const UPGRADE_STEPS: readonly UpgradeStepId[] = ['sync', 'cli', 'preflight', 'pause', 'drain', 'files', 'image', 'secrets', 'recreate', 'shim', 'workspace', 'import', 'resume', 'coordinator'];
/** The steps of a host-runtime upgrade (no image, container or origin step; `shim` takes the recreate's place). */
export const HOST_UPGRADE_STEPS: readonly UpgradeStepId[] = ['sync', 'cli', 'preflight', 'pause', 'drain', 'files', 'secrets', 'shim', 'workspace', 'resume', 'coordinator'];

/** What a host-runtime upgrade drives instead of the container (src/host/upgrade-host.ts builds it; faked in tests). */
export interface HostUpgradeTarget {
  /** Runs `minions ...` through the project's minions shim (HostRuntime.exec). */
  exec: (args: string[], opts?: RunOptions) => Promise<RunResult>;
  /** The host runtime was prepared by `minions start` (its shim exists), so its runtime DB is reachable. */
  prepared: () => Promise<boolean>;
  /** Why the CLI the shims would run is unsafe (inside or linked into the agent-writable dirs); null when it is safe. */
  cliProblem: () => Promise<string | null>;
  /** The dry-run detail of the shim step. */
  shimPlan: string;
  /** Regenerates the minions shim for the installed CLI; returns the step detail. */
  regenerate: () => Promise<string>;
}
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
  /** After the files step: how the plugin the container mounts compares with the installed package (null: not checked). */
  plugin?: { matches: boolean; detail: string } | null;
  /** Open upgrade requests (proposed or failed) this successful upgrade marked `applied` (absent: none, or not read). */
  requestsApplied?: string[];
}

export interface UpgradeOptions {
  projectId: string;
  imageTag: string;
  /** Docker runtime: the project container. Exactly one of compose and host is given. */
  compose?: Compose;
  /** Host runtime: the shims, instead of a container (task-7). */
  host?: HostUpgradeTarget;
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
  /** Docker: container.aptPackages after `refresh` (the image step builds their derived image; absent = none). */
  aptPackages?: () => readonly string[] | undefined;
  /** After the refresh: how the plugin on disk differs from the installed package (null: it matches). */
  checkPlugin?: () => Promise<string | null>;
  /** Re-runs the repository import, which (re)configures origin; an existing clone is only refreshed (Docker only). */
  importRepo?: () => Promise<ImportResult>;
  materialize?: () => Promise<unknown>;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  pollMs?: number;
  /** Source phase run first (--from-container sync and the CLI check); see src/host/upgrade-source.ts. */
  source?: () => Promise<SourcePhase<UpgradeResult>>;
  /** SIGINT/SIGTERM handling during the container steps (default: the process signals). */
  interrupt?: InterruptHooks;
}

export interface InterruptHooks {
  /** Subscribes `handler` to SIGINT and SIGTERM; returns the unsubscribe. */
  subscribe: (handler: (signal: NodeJS.Signals) => void) => () => void;
  /** Ends the process once the interrupt is handled. */
  exit: (code: number) => void;
  /** The one-line rerun hint (also in --json mode: stdout carries only the envelope). */
  notice: (msg: string) => void;
}

export const processInterrupts: InterruptHooks = {
  subscribe: (handler) => {
    const f = (s: NodeJS.Signals) => handler(s);
    process.on('SIGINT', f); process.on('SIGTERM', f);
    return () => { process.off('SIGINT', f); process.off('SIGTERM', f); };
  },
  exit: (code) => process.exit(code),
  notice: (msg) => { process.stderr.write(msg + '\n'); },
};

/** Waits between the attempts of a failed drain status poll (then the drain gives up). */
export const STATUS_RETRY_MS: readonly number[] = [2_000, 5_000, 10_000];
/** A marker without an event id owns a pause recorded within this window around its timestamp. */
const MARKER_WINDOW_MS = { before: 60_000, after: 180_000 };

interface PauseChange { id: number; at: string; value: boolean }
interface RuntimeStatus {
  paused: { intake: boolean; starts: boolean };
  activeLeases: LeaseInfo[];
  /** Last event that set each pause flag; absent from runtimes older than task-3.6. */
  pauseChanges?: { starts: PauseChange | null };
  /** Active drain request; absent from runtimes older than task-3.7. */
  draining?: { reason: string; requestedAt: string; eventId: number } | null;
}
export const UPGRADE_DRAIN_REASON = 'upgrade';
const DRAIN_PAUSE = ['minions', 'pause', '--starts', '--drain', '--reason', UPGRADE_DRAIN_REASON, '--json'];
/** The runtime rejected --drain (an image from before task-3.7). */
const noDrainSupport = (e: unknown) => /unknown option/i.test(errMsg(e));
/** <project dir>/upgrade.json: the pause this upgrade made (the runtime `controls` event id when known). */
export interface UpgradeMarker { pausedStarts: boolean; at: string; eventId?: number }
const markerPath = (projectId: string) => join(projectPaths(projectId).dir, 'upgrade.json');

/**
 * True when the current starts pause is the one an earlier, unfinished upgrade recorded in its marker.
 * A pause the user made later (for example after resuming by hand) is a different `controls` event and
 * stays the user's. Runtimes that do not report pause events leave only the marker to go by.
 */
export function inheritedPause(marker: UpgradeMarker | undefined, s: RuntimeStatus | null): boolean {
  if (!marker?.pausedStarts || !s?.paused.starts) return false;
  const ch = s.pauseChanges?.starts;
  if (ch === undefined) return true;
  if (!ch || !ch.value) return false;
  if (typeof marker.eventId === 'number') return ch.id === marker.eventId;
  const t = Date.parse(ch.at), m = Date.parse(marker.at);
  return Number.isFinite(t) && Number.isFinite(m) && t >= m - MARKER_WINDOW_MS.before && t <= m + MARKER_WINDOW_MS.after;
}

const lastLine = (r: { stdout: string; stderr: string }) =>
  (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? 'no output';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const leaseLabel = (l: LeaseInfo) => `${l.id} (${l.task_id}, ${l.role})`;
const signalExit = (s: NodeJS.Signals) => (s === 'SIGTERM' ? 143 : 130);

/** `work release` refused because the lease already ended (CONFLICT): it finished on its own after the last poll. */
function alreadyEnded(r: { stdout: string; stderr: string }): boolean {
  const line = r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  try {
    const env = JSON.parse(line) as { ok?: boolean; error?: { code?: string; message?: string } };
    if (env.ok === false) return env.error?.code === 'CONFLICT' && /already ended/.test(env.error.message ?? '');
  } catch { /* not an envelope: fall back to the human message */ }
  return /\balready ended\b/.test(r.stderr);
}

export async function runUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const { projectId } = opts;
  const host = opts.host ?? null;
  const compose = opts.compose ?? null;
  if (!host === !compose) throw new MinionsError('INTERNAL', 'runUpgrade needs exactly one of compose (Docker) and host (host runtime).');
  const exec = (args: string[], o: RunOptions): Promise<RunResult> => (host ? host.exec(args, o) : compose!.exec(args, o));
  const where = host ? 'the host runtime' : 'the container';
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
    if (s.continued) {
      // The continued CLI re-checks itself: its "matches" cli step repeats what this one just did.
      const rest = s.continued.steps.filter((x) => !(x.id === 'cli' && x.status === 'skipped') && !(x.id === 'sync' && x.status === 'skipped'));
      return { ...s.continued, steps: [...steps, ...rest], sync: s.sync, cli: s.cli, stopped: s.continued.stopped ?? null, continued: true };
    }
  }

  // Container-side status: pause state and active leases (runtime DB in the state volume).
  const status = async (): Promise<RuntimeStatus> => {
    const r = await exec(['minions', 'status', '--json'], { allowFailure: true, timeoutMs: 60_000 });
    if (r.code !== 0 && !r.stdout.trim()) throw new MinionsError('INTERNAL', `status failed in ${where}: ${lastLine(r)}`);
    const d = parseEnvelope<RuntimeStatus>(r.stdout, 'status');
    return { paused: d.paused, activeLeases: d.activeLeases ?? [], ...(d.pauseChanges ? { pauseChanges: d.pauseChanges } : {}), ...(d.draining !== undefined ? { draining: d.draining } : {}) };
  };
  const execOk = async (args: string[], what: string, timeoutMs = 120_000) => {
    const r = await exec(args, { allowFailure: true, timeoutMs });
    if (r.code !== 0) throw new MinionsError('INTERNAL', `${what} failed in ${where}: ${lastLine(r)}`);
    return r;
  };

  // ---- preflight (read-only) ----
  // Host runtime: "running" means prepared (the shim reaches the runtime DB; the coordinator need not run).
  const container: { state: 'running' | 'absent' | 'unknown'; reason: string } = host
    ? (await host.prepared() ? { state: 'running', reason: 'host runtime prepared' } : { state: 'absent', reason: 'the host runtime has not been started' })
    : await compose!.containerState();
  const fingerprint = host ? null : buildFingerprint(root);
  const previous = host ? null : await imageBuildLabel(opts.imageTag, opts.runner).catch(() => null);
  const rebuild = !host && (previous === null || (fingerprint !== null && previous !== fingerprint));
  const cliProblem = host && container.state === 'running' ? await host.cliProblem() : null;
  result.image = { tag: opts.imageTag, rebuild, fingerprint, previous };
  const marker = await readJsonIfExists<UpgradeMarker>(markerPath(projectId)).catch(() => undefined);
  let before: RuntimeStatus | null = null;
  let preflightError: string | null = null;
  if (host && container.state !== 'running') preflightError = 'the host runtime has not been started for this project (run `minions start --no-attach` first)';
  else if (cliProblem) preflightError = cliProblem;
  else if (container.state === 'unknown') preflightError = `container state is unknown (${container.reason})`;
  else if (rebuild && fingerprint === null) preflightError = `the package at ${root} has no dist/cli.js; cannot build the runtime image`;
  else if (container.state === 'running') {
    try { before = await status(); } catch (e) { preflightError = `cannot read the runtime status: ${errMsg(e)}`; }
  }
  const running = container.state === 'running';
  // Starts paused by an unfinished upgrade (the very pause its marker recorded) count as ours; any other
  // pause, including one the user made after a manual resume, is the user's and stays paused.
  const inherited = inheritedPause(marker, before);
  const userPaused = !!before?.paused.starts && !inherited;

  if (opts.dryRun) {
    const p = (id: UpgradeStepId, detail: string) => step(id, 'planned', detail);
    if (preflightError) { step('preflight', 'failed', preflightError); result.ok = false; }
    else step('preflight', 'done', host ? 'host runtime prepared; the installed CLI is outside the agent-writable dirs' : `container ${container.state}; image ${rebuild ? (previous === null ? 'missing' : 'outdated') : 'current'}`);
    if (!running) { step('pause', 'skipped', `${host ? 'host runtime' : 'container'} not running`); step('drain', 'skipped', `${host ? 'host runtime' : 'container'} not running`); }
    else {
      if (userPaused) step('pause', 'skipped', 'starts already paused (left paused)');
      else if (inherited) step('pause', 'skipped', 'starts still paused by an unfinished upgrade (resumed at the end)');
      else p('pause', 'pause new starts and request a drain (minions pause --starts --drain)');
      const n = before?.activeLeases.length ?? 0;
      p('drain', n === 0 ? 'no active leases' : opts.now && opts.timeoutSec === 0
        ? `release ${n} active lease(s) now and report them interrupted: ${before!.activeLeases.map(leaseLabel).join(', ')}`
        : `ask ${n} worker(s) to commit work in progress and return partial results, wait up to ${opts.timeoutSec}s, then ${opts.now ? 'release the rest (reported interrupted)' : 'abort and resume starts'}`);
    }
    if (host) {
      p('files', 'regenerate the runtime config and plugin from the installed package');
      p('secrets', 'materialize stored tokens into the project secrets dir');
      p('shim', host.shimPlan);
      p('workspace', 'minions workspace setup (through the shim)');
      if (userPaused) step('resume', 'skipped', 'starts were paused before the upgrade; left paused'); else p('resume', 'resume new starts (minions resume --starts)');
      p('coordinator', 'minions coordinator restart --recover (through the shim; refused while a worker lease is active, so only after the drain)');
      return result;
    }
    p('files', 'regenerate compose.yaml, runtime config and plugin from the installed package');
    if (rebuild) p('image', `build ${opts.imageTag} (${previous === null ? 'missing' : 'fingerprint changed'})`); else step('image', 'skipped', 'fingerprint unchanged; no rebuild');
    p('secrets', 'materialize stored tokens into the secrets mount');
    p('recreate', 'docker compose up --force-recreate (named volumes kept)');
    p('workspace', 'minions workspace setup');
    p('import', 'refresh the repository import (existing clone kept)');
    if (userPaused) step('resume', 'skipped', 'starts were paused before the upgrade; left paused'); else p('resume', 'resume new starts (minions resume --starts)');
    p('coordinator', 'minions coordinator restart --recover');
    return result;
  }

  if (preflightError) {
    step('preflight', 'failed', preflightError);
    throw new MinionsError('PRECONDITION', `Upgrade not started: ${preflightError}.`,
      host ? 'Fix the cause and rerun `minions upgrade`.' : container.state === 'unknown' ? 'Check `docker compose ps` for the project, then rerun `minions upgrade`.' : 'Fix the cause and rerun `minions upgrade`.', { steps });
  }
  step('preflight', 'done', host ? 'host runtime prepared; the installed CLI is outside the agent-writable dirs' : `container ${container.state}; image ${rebuild ? 'needs a rebuild' : 'current'}`);
  // With the container down the pause state is unreadable until the recreate: the marker is checked then.
  const deferred = !running && !!marker?.pausedStarts;
  // A marker whose pause is gone or is not ours any more is stale: drop it so it cannot claim a later pause.
  if (marker && !inherited && !deferred) await rm(markerPath(projectId), { force: true });

  // From here until the recreate, a failure (or SIGINT/SIGTERM) resumes what we paused and leaves the
  // container running.
  let ownPause = inherited;
  // A drain this upgrade asked for, or one left by an earlier run: the finish or abort clears it.
  let drainRequested = !!before?.draining;
  const resume = async () => {
    await execOk(['minions', 'resume', '--starts', '--json'], 'resume');
    ownPause = false;
    drainRequested = false; // resuming starts clears the drain
    await rm(markerPath(projectId), { force: true });
  };
  /** Clears only the drain (the starts stay paused: the user's pause). */
  const clearDrain = async () => {
    await execOk(['minions', 'resume', '--drain', '--json'], 'drain clear');
    drainRequested = false;
  };
  /** Abort/interrupt clean-up: resume our pause (which clears the drain), else clear only the drain. */
  const undo = async (): Promise<string> => {
    if (ownPause) { await resume(); return 'starts resumed'; }
    if (drainRequested) { await clearDrain(); return 'drain request cleared (starts left paused)'; }
    return '';
  };

  // ---- interrupt handling ----
  const hooks = opts.interrupt ?? processInterrupts;
  let recreating = false;
  let interrupted: NodeJS.Signals | null = null;
  let handled: Promise<void> = Promise.resolve();
  let pausing: Promise<unknown> | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    if (interrupted) { hooks.exit(signalExit(sig)); return; } // a second signal: exit now
    interrupted = sig;
    handled = (async () => {
      if (recreating) {
        hooks.notice(`minions upgrade interrupted (${sig}) after the ${host ? 'shim regeneration' : 'container recreate'} started; ${host ? 'the workspace is' : 'volumes are'} kept. Rerun \`minions upgrade\` to finish (it resumes the starts it paused).`);
        return;
      }
      await pausing?.catch(() => undefined); // an in-flight pause must not land after the resume
      let state = host ? 'the shims were not regenerated' : 'the container was not recreated';
      if ((ownPause || drainRequested) && running) {
        const which = ownPause ? '--starts' : '--drain';
        try { const done = await undo(); if (done) state += done === 'starts resumed' ? ' and starts were resumed' : ` and the ${done}`; }
        catch (e) { state += `; starts are still paused (${errMsg(e)}): run \`minions resume ${which}\`,`; }
      }
      hooks.notice(`minions upgrade interrupted (${sig}): ${state}. Rerun \`minions upgrade\` to upgrade.`);
    })();
    void handled.finally(() => hooks.exit(signalExit(sig)));
  };

  const aborted = new WeakSet<object>();
  /** Stops the main flow once an interrupt was handled (the handler already resumed and printed the hint). */
  const checkpoint = async () => {
    if (!interrupted) return;
    await handled;
    const out = new MinionsError('PRECONDITION', `Upgrade interrupted (${interrupted}).`, 'Rerun `minions upgrade`.', { steps });
    aborted.add(out);
    throw out;
  };
  const abort = async (id: UpgradeStepId, e: unknown): Promise<never> => {
    if (e && typeof e === 'object' && aborted.has(e)) throw e; // already reported by an inner abort
    await checkpoint();
    if (!steps.some((s) => s.id === id)) step(id, 'failed', errMsg(e));
    if ((ownPause || drainRequested) && running) {
      const which = ownPause ? '--starts' : '--drain';
      try { step('resume', 'done', `${await undo()} after the aborted upgrade`); }
      catch (re) { step('resume', 'failed', `${errMsg(re)}; run \`minions resume ${which}\``); }
    }
    const err = e instanceof MinionsError ? e : new MinionsError('INTERNAL', errMsg(e));
    const out = new MinionsError(err.code, `Upgrade aborted at ${id}: ${err.message}`, err.hint ?? 'The container was not recreated; fix the cause and rerun `minions upgrade`.', { steps });
    aborted.add(out);
    throw out;
  };

  /** A drain poll that tolerates a few failed `status` calls (busy container, slow exec) before giving up. */
  const pollStatus = async (): Promise<RuntimeStatus> => {
    for (let i = 0; ; i++) {
      try { return await status(); } catch (e) {
        if (i >= STATUS_RETRY_MS.length) throw new MinionsError('INTERNAL', `the status poll failed ${i + 1} times in a row: ${errMsg(e)}`);
        log(`drain: status poll failed (${errMsg(e)}); retrying in ${STATUS_RETRY_MS[i]! / 1000}s`);
        await sleep(STATUS_RETRY_MS[i]!);
        await checkpoint();
      }
    }
  };

  const containerSteps = async (): Promise<UpgradeResult> => {
    // ---- pause + drain ----
    if (!running) {
      step('pause', 'skipped', 'container not running');
      step('drain', 'skipped', 'container not running');
    } else {
      if (userPaused) step('pause', 'skipped', 'starts already paused (left paused after the upgrade)');
      else if (inherited) step('pause', 'skipped', 'starts still paused by an unfinished upgrade (resumed at the end)');
      else {
        try {
          const at = new Date().toISOString();
          await writeJson(markerPath(projectId), { pausedStarts: true, at } satisfies UpgradeMarker);
          ownPause = true;
          // One call pauses starts and records the drain request; an older runtime only pauses.
          const r = await (pausing = execOk(DRAIN_PAUSE, 'pause').then((x) => { drainRequested = true; return x; }, (e: unknown) => {
            if (!noDrainSupport(e)) throw e;
            log('pause: the running runtime does not support drain requests; its workers are only waited for');
            return execOk(['minions', 'pause', '--starts', '--json'], 'pause');
          }));
          // Remember which pause event is ours, so a stale marker can never claim a later user pause.
          let eventId: number | undefined;
          try { eventId = parseEnvelope<{ pauseChanges?: { starts?: PauseChange | null } }>(r.stdout, 'pause').pauseChanges?.starts?.id; } catch { /* older runtime */ }
          if (typeof eventId === 'number') await writeJson(markerPath(projectId), { pausedStarts: true, at, eventId } satisfies UpgradeMarker);
          step('pause', 'done', drainRequested ? 'new starts paused; drain requested' : 'new starts paused');
          await checkpoint();
        } catch (e) { await abort('pause', e); }
      }
      // Starts were already paused: still ask running workers to wind down (the pause itself is kept).
      if ((userPaused || inherited) && before!.activeLeases.length && !before!.draining) {
        try {
          await (pausing = execOk(DRAIN_PAUSE, 'drain request'));
          drainRequested = true;
          log('pause: drain requested (starts were already paused)');
        } catch (e) {
          log(`pause: could not request a drain (${errMsg(e)}); the workers are only waited for`);
        }
        await checkpoint();
      }
      try {
        const deadline = clock() + opts.timeoutSec * 1000;
        let leases = before!.activeLeases;
        let shown = '';
        for (;;) {
          if (leases.length === 0) break;
          const ids = leases.map((l) => l.id).join(',');
          if (ids !== shown) { log(`${drainRequested ? 'winding down' : 'waiting for'} ${leases.length} active lease(s): ${leases.map(leaseLabel).join(', ')}`); shown = ids; }
          if (clock() >= deadline) break;
          await sleep(Math.min(pollMs, Math.max(0, deadline - clock())));
          await checkpoint();
          leases = (await pollStatus()).activeLeases;
        }
        const started = before!.activeLeases.length;
        if (leases.length === 0) step('drain', 'done', started && drainRequested ? `${started} lease(s) wound down; their tasks are re-dispatched after the upgrade` : 'no active leases');
        else if (!opts.now) {
          step('drain', 'failed', `${leases.length} lease(s) still active after ${opts.timeoutSec}s: ${leases.map(leaseLabel).join(', ')}`);
          await abort('drain', new MinionsError('PRECONDITION', `${leases.length} worker lease(s) still active after ${opts.timeoutSec}s (${leases.map((l) => l.task_id).join(', ')})`,
            'Starts were resumed and the container was not touched. Rerun with a longer --timeout, or with --now to release them (their tasks are re-dispatched after the upgrade).'));
        } else {
          const ended: LeaseInfo[] = [];
          for (const l of leases) {
            await checkpoint();
            const r = await exec(['minions', 'work', 'release', l.id, '--reason', UPGRADE_RELEASE_REASON, '--json'], { allowFailure: true, timeoutMs: 120_000 });
            if (r.code === 0) { result.interrupted.push({ id: l.id, task_id: l.task_id, role: l.role }); continue; }
            // The lease ended between the last poll and its release: it finished normally, nothing to interrupt.
            if (alreadyEnded(r)) { ended.push(l); continue; }
            const done = result.interrupted.length ? `; already released (re-dispatched after the upgrade): ${result.interrupted.map(leaseLabel).join(', ')}` : '';
            step('drain', 'failed', `work release ${l.id} failed: ${lastLine(r)}${done}`);
            await abort('drain', new MinionsError('INTERNAL', `work release ${l.id} failed in ${where}: ${lastLine(r)}${done}`));
          }
          const parts = [
            ...(result.interrupted.length ? [`released ${result.interrupted.length} lease(s) as interrupted: ${result.interrupted.map(leaseLabel).join(', ')}`] : []),
            ...(ended.length ? [`${ended.length} lease(s) ended on their own before the release: ${ended.map(leaseLabel).join(', ')}`] : []),
          ];
          step('drain', 'done', parts.join('; '));
        }
      } catch (e) { await abort('drain', e); }
    }

    // ---- files + image ----
    try {
      const warnings = await opts.refresh();
      for (const w of warnings) log(`warning: ${w}`);
      // Report a plugin that still differs (files edited by the user are kept): the container mounts it as is.
      let plugin = '';
      if (opts.checkPlugin) {
        const mismatch = await opts.checkPlugin().catch((e: unknown) => `could not be compared with the installed package: ${errMsg(e)}`);
        result.plugin = { matches: mismatch === null, detail: mismatch ?? 'matches the installed package' };
        plugin = `; plugin ${result.plugin.detail}`;
        if (mismatch !== null) log(`warning: plugin ${mismatch}`);
      }
      step('files', 'done', `derived files regenerated${plugin}`);
      await checkpoint();
    } catch (e) { await abort('files', e); }
    if (!host) try {
      const built = await ensureImage(opts.imageTag, { runner: opts.runner, root, onBuild: log });
      const apt = opts.aptPackages?.();
      const aptBuilt = await ensureAptImage(opts.imageTag, apt, { runner: opts.runner, onBuild: log });
      result.image.rebuild = built || aptBuilt;
      const builtTags = [...(built ? [opts.imageTag] : []), ...(aptBuilt ? [aptImageTag(opts.imageTag, apt)] : [])];
      step('image', builtTags.length ? 'done' : 'skipped', builtTags.length ? `built ${builtTags.join(', ')}` : 'fingerprint unchanged; no rebuild');
      await checkpoint();
    } catch (e) { await abort('image', e); }

    // ---- secrets + recreate ----
    // A token that cannot be read now would be missing in the new container: stop while the old one still runs.
    try {
      await (opts.materialize ?? (() => materializeSecrets(projectId)))();
      step('secrets', 'done', 'stored tokens materialized');
      await checkpoint();
    } catch (e) {
      await abort('secrets', aborted.has(e as object) ? e : new MinionsError('PRECONDITION', `a stored token is not available to the container: ${errMsg(e)}`,
        'The container was not recreated. Check the credentials with `minions doctor` (or `minions auth telegram`), then rerun `minions upgrade`.'));
    }
    recreating = true;
    if (host) {
      try { step('shim', 'done', await host.regenerate()); } catch (e) {
        step('shim', 'failed', errMsg(e));
        throw new MinionsError('INTERNAL', `Upgrade failed while regenerating the host runtime shims: ${errMsg(e)}`,
          'Rerun `minions upgrade` (it also resumes the starts it paused) or `minions start --no-attach`.', { steps });
      }
    } else try {
      await upClearingSecretsOnFailure({ up: () => compose!.recreate() }, projectId);
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
    if (!host) await attempt('import', async () => {
      if (!opts.importRepo) throw new MinionsError('INTERNAL', 'no repository import given');
      const r = await opts.importRepo();
      for (const w of r.warnings) log(`warning: ${w}`);
      return `${r.baseBranch} refreshed`;
    });
    let notOurs = userPaused ? 'starts were paused before the upgrade; left paused' : 'starts were not paused by the upgrade';
    if (deferred) {
      try {
        const s = await status();
        ownPause = inheritedPause(marker, s);
        if (!ownPause) {
          await rm(markerPath(projectId), { force: true });
          if (s.paused.starts) notOurs = 'starts are paused, but not by the unfinished upgrade; left paused';
        }
      } catch { ownPause = true; /* unreadable: trust the marker, as before */ }
    }
    if (ownPause) await attempt('resume', async () => { await resume(); return 'new starts resumed'; });
    else if (drainRequested) await attempt('resume', async () => { await clearDrain(); return `drain request cleared; ${notOurs}`; });
    else step('resume', 'skipped', notOurs);
    await attempt('coordinator', async () => {
      const r = await exec(['minions', 'coordinator', 'restart', '--recover', '--json'], { allowFailure: true, timeoutMs: 120_000 });
      const d = parseEnvelope<{ action?: string; running?: boolean; reason?: string }>(r.stdout, 'coordinator restart');
      result.coordinator = d;
      return `${d.action ?? 'unknown'} (${d.reason ?? ''})`;
    });
    if (result.ok) {
      const applied = await closeOpenRequests(exec, new Date(clock()).toISOString()).catch((e: unknown) => { log(`warning: upgrade requests not marked applied: ${errMsg(e)}`); return []; });
      if (applied.length) { result.requestsApplied = applied; log(`requests: marked ${applied.join(', ')} applied`); }
    }
    return result;
  };

  const off = hooks.subscribe(onSignal);
  try { return await containerSteps(); } finally { off(); }
}


/**
 * After a successful upgrade: the runtime's open upgrade requests (proposed or failed; recorded by the coordinator
 * with `minions upgrade --from-container`) are covered by it, so they are marked `applied`. A `confirmed` request is
 * being applied by the host self-update script, which reports its own outcome: left alone. Best effort.
 */
export async function closeOpenRequests(exec: (args: string[], o: RunOptions) => Promise<RunResult>, at: string): Promise<string[]> {
  const r = await exec(['minions', 'settings', 'requests', '--json'], { allowFailure: true, timeoutMs: 60_000 });
  if (r.code !== 0) throw new MinionsError('INTERNAL', `settings requests failed: ${lastLine(r)}`);
  const d = parseEnvelope<{ requests?: { id?: unknown; kind?: unknown; status?: unknown }[] }>(r.stdout, 'settings requests');
  const ids = (Array.isArray(d.requests) ? d.requests : [])
    .filter((q) => q.kind === 'upgrade' && (q.status === 'proposed' || q.status === 'failed') && typeof q.id === 'string' && isChangeRequestId(q.id))
    .map((q) => q.id as string);
  const done: string[] = [];
  for (const id of ids) {
    const m = await exec(['minions', 'settings', 'requests', 'mark', id, '--status', 'applied', '--detail', `applied by \`minions upgrade\` on the host at ${at}`, '--json'], { allowFailure: true, timeoutMs: 60_000 });
    if (m.code === 0) done.push(id);
  }
  return done;
}

export function formatUpgrade(r: UpgradeResult): string {
  const mark: Record<UpgradeStepStatus, string> = { done: 'ok  ', skipped: 'skip', failed: 'FAIL', planned: 'plan' };
  return [
    r.dryRun ? `Upgrade plan for ${r.projectId} (dry run; nothing changed):` : `Upgrade of ${r.projectId}: ${r.stopped ? 'stopped' : r.ok ? 'complete' : 'finished with failures'}.`,
    ...r.steps.map((s) => `  [${mark[s.status]}] ${s.id}: ${s.detail}`),
    ...(r.stopped ? [`Stopped before the container steps (nothing in the container changed): ${r.stopped.reason}.`, 'Run:', `  ${r.stopped.command}`, 'then:', `  ${r.stopped.rerun}`] : []),
    ...(r.continued ? ['The container steps ran on the newly installed CLI.'] : []),
    ...(r.interrupted.length ? [`Interrupted leases (re-dispatched by the coordinator's recovery): ${r.interrupted.map(leaseLabel).join(', ')}`] : []),
    ...(r.requestsApplied?.length ? [`Upgrade request(s) marked applied: ${r.requestsApplied.join(', ')}`] : []),
  ].join('\n');
}
