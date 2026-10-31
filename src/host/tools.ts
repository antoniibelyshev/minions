// Tools in the container (docs/design/autonomy.md Decision 14), host side: which container.aptPackages the image
// should carry, and `minions tools reset` (the tools volume).
//
// The coordinator sets container.aptPackages in its control overlay, which lives in the state volume; the host reads
// it from there (through the running container, or a throwaway read-only container on the base image when it is
// down). The overlay is container-written: only that one key is taken, and only when it validates.
import { MinionsError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { CONTAINER, TOOLS_DIR, projectPaths, volumeNames } from '../core/paths.js';
import { AptPackagesSchema, type MinionsConfig } from '../config/schema.js';
import { overlayPath } from '../runtime/control.js';
import { Compose, normalizeAptPackages, type Runner } from './docker.js';
import { projectJsonBytes, writeGenerated } from './install.js';
import { ProjectJsonSchema, type ProjectJson } from './project.js';

const OVERLAY = overlayPath(CONTAINER.state);
/** Prints the overlay, or `{}` when there is none. */
const READ_OVERLAY = ['sh', '-c', 'if [ -e "$1" ]; then cat "$1"; else echo "{}"; fi', 'sh', OVERLAY];
const MAX_OVERLAY_BYTES = 1_000_000;
const lastLine = (r: RunResult) => (r.stderr || r.stdout).trim().split('\n').filter(Boolean).at(-1)?.slice(0, 200) ?? 'no output';

/** The overlay's container.aptPackages: absent (undefined) or the validated list. Throws on anything else. */
export function overlayAptPackages(text: string): string[] | undefined {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error('the control overlay is not valid JSON'); }
  const pkgs = (v as { config?: { container?: { aptPackages?: unknown } } } | null)?.config?.container?.aptPackages;
  if (pkgs === undefined) return undefined;
  const r = AptPackagesSchema.safeParse(pkgs);
  if (!r.success) throw new Error('container.aptPackages in the control overlay is invalid');
  return r.data;
}

/**
 * Reads the control overlay text from the state volume: through the running container, else (container down) with a
 * throwaway container on `baseTag` that mounts only the state volume, read-only, without network. `{}` when the
 * state volume does not exist yet.
 */
export async function readControlOverlay(projectId: string, baseTag: string, opts: { compose?: Compose; runner?: Runner } = {}): Promise<string> {
  const runner = opts.runner ?? run;
  const compose = opts.compose ?? new Compose(projectId, runner);
  if (await compose.isRunning().catch(() => false)) {
    const r = await compose.exec(READ_OVERLAY, { allowFailure: true, timeoutMs: 30_000, maxOutputBytes: MAX_OVERLAY_BYTES });
    if (r.code !== 0) throw new Error(`reading it in the container failed: ${lastLine(r)}`);
    return r.stdout;
  }
  const vol = volumeNames(projectId).state;
  if ((await runner('docker', ['volume', 'inspect', vol], { allowFailure: true, timeoutMs: 30_000 })).code !== 0) return '{}';
  const r = await runner('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--user', '1000:1000', '--mount', `type=volume,source=${vol},target=${CONTAINER.state},readonly`, '--entrypoint', READ_OVERLAY[0]!,
    baseTag, ...READ_OVERLAY.slice(1)], { allowFailure: true, timeoutMs: 120_000, maxOutputBytes: MAX_OVERLAY_BYTES });
  if (r.code !== 0) throw new Error(`reading it from the state volume failed: ${lastLine(r)}`);
  return r.stdout;
}

export interface AptPlan {
  /** What the image should carry (sorted, unique). */
  desired: string[];
  /** What project.json (and so compose.yaml and the image) has now. */
  current: string[];
  changed: boolean;
  /** Where `desired` comes from. */
  source: 'control' | 'config' | 'unchanged';
  /** Why the overlay could not be used (then the config value counts, or the current list when the config has none). */
  warning?: string;
}

/** The control overlay's value wins over the host config's (Decision 3 layering); an unreadable overlay keeps the current list. */
export async function planAptPackages(project: Pick<ProjectJson, 'container'>, config: Pick<MinionsConfig, 'container'>, readOverlay: () => Promise<string>): Promise<AptPlan> {
  const current = normalizeAptPackages(project.container.aptPackages);
  let fromControl: string[] | undefined;
  try { fromControl = overlayAptPackages(await readOverlay()); } catch (e) {
    const warning = `container.aptPackages from the coordinator's control overlay not read (${(e as Error).message}); the image keeps its packages`;
    return { desired: current, current, changed: false, source: 'unchanged', warning };
  }
  const desired = normalizeAptPackages(fromControl ?? config.container.aptPackages);
  return { desired, current, changed: desired.join(' ') !== current.join(' '), source: fromControl !== undefined ? 'control' : 'config' };
}

/** One line: what changes in the image. */
export function describeAptChange(p: Pick<AptPlan, 'desired' | 'current'>): string {
  const added = p.desired.filter((x) => !p.current.includes(x));
  const removed = p.current.filter((x) => !p.desired.includes(x));
  return [added.length ? `+${added.join(' +')}` : '', removed.length ? `-${removed.join(' -')}` : ''].filter(Boolean).join(' ') || 'no change';
}

/** project.json with container.aptPackages = `desired` (written only when it changed); returns the (possibly new) record. */
export async function syncAptPackages(project: ProjectJson, desired: readonly string[]): Promise<ProjectJson> {
  const list = normalizeAptPackages(desired);
  if (list.join(' ') === normalizeAptPackages(project.container.aptPackages).join(' ')) return project;
  const { aptPackages: _old, ...rest } = project.container;
  const next = ProjectJsonSchema.parse({ ...project, container: list.length ? { ...rest, aptPackages: list } : rest });
  await writeGenerated(project.projectId, projectPaths(project.projectId).projectJson, projectJsonBytes(next));
  return next;
}

// ---------------------------------------------------------------- tools reset

export interface ToolsResetResult {
  projectId: string;
  volume: string;
  /** The container was running and was stopped first. */
  stopped: boolean;
  removed: boolean;
  dryRun: boolean;
}

/**
 * `minions tools reset`: deletes the tools volume, so the next `minions start` mounts a fresh one (the image's empty
 * layout). The container must be down: a running one is stopped first only after `confirm` (or --yes).
 */
export async function toolsReset(project: ProjectJson, opts: {
  yes?: boolean; dryRun?: boolean; runner?: Runner; compose?: Compose;
  confirm: (question: string) => Promise<boolean | null>;
  /** Called after the container is stopped (clears the materialized secrets). */
  afterStop?: () => Promise<void>;
}): Promise<ToolsResetResult> {
  const runner = opts.runner ?? run;
  const compose = opts.compose ?? new Compose(project.projectId, runner);
  const volume = volumeNames(project.projectId).tools;
  const st = await compose.containerState();
  if (st.state === 'unknown') throw new MinionsError('PRECONDITION', `Container state unknown (${st.reason}); the tools volume was left alone.`, 'Check `docker compose ps` for the project, or run `minions down` first.');
  const running = st.state === 'running';
  const exists = (await runner('docker', ['volume', 'inspect', volume], { allowFailure: true, timeoutMs: 30_000 })).code === 0;
  const result: ToolsResetResult = { projectId: project.projectId, volume, stopped: false, removed: false, dryRun: !!opts.dryRun };
  if (opts.dryRun || !exists) return result;
  if (running && !opts.yes) {
    const ok = await opts.confirm(`The container is running. Stop it (workers are interrupted) and delete ${volume} (${TOOLS_DIR})? (y/N)`);
    if (ok === null) throw new MinionsError('PRECONDITION', 'The container is running.', 'Stop it with `minions down` first, or pass --yes to stop it here.');
    if (!ok) throw new MinionsError('PRECONDITION', 'Cancelled; nothing changed.');
  }
  // Also removes a stopped container, which would keep the volume in use.
  await compose.down();
  if (running) { result.stopped = true; await opts.afterStop?.(); }
  await runner('docker', ['volume', 'rm', volume], { timeoutMs: 60_000 });
  result.removed = true;
  return result;
}

export function formatToolsReset(r: ToolsResetResult): string {
  if (r.dryRun) return `Would delete ${r.volume} (${TOOLS_DIR}), stopping the container first if it runs.`;
  if (!r.removed) return `${r.volume} does not exist; nothing to reset.`;
  return `Deleted ${r.volume}${r.stopped ? ' (the container was stopped)' : ''}. \`minions start\` mounts a fresh ${TOOLS_DIR}.`;
}
