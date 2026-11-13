// The coordinator's control overlay (src/runtime/control.ts, docs/design/autonomy.md Decision 3) on the host side, for
// what the host reports about the effective config: doctor (setup gaps, merge.readiness) and the `minions settings`
// listing. The runtime applies the overlay on top of the config the host resolves, so a host view without it says
// "no verification commands" while the coordinator has set them.
//
// - Host runtime: the overlay is a local file (<host state>/control/overlay.json); read directly.
// - Docker: it lives in the state volume; read through the running container (as src/host/tools.ts does for
//   container.aptPackages). With the container down it is not read (a throwaway container per doctor or settings
//   call is too slow): the host view then lacks the overlay, as before.
// The overlay is container-written: it is merged only when the whole result validates; otherwise it is ignored with a
// warning. Nothing here writes it.
import { readFile } from 'node:fs/promises';
import { applyControl, type EffectiveConfig, type Source } from '../config/resolve.js';
import type { RunResult } from '../core/exec.js';
import { hostRuntimePaths } from '../core/paths.js';
import { overlayPath } from '../runtime/control.js';
import type { ProjectJson } from './project.js';
import { runtimeOf } from './runtime-kind.js';
import { READ_OVERLAY } from './tools.js';

const MAX_OVERLAY_BYTES = 1_000_000;

export interface OverlayAccess {
  /** Docker: whether the container runs (the overlay is read only then). */
  running?: () => Promise<boolean>;
  /** Docker: runs a command in the container. */
  exec?: (args: string[]) => Promise<RunResult>;
}

/** The overlay file's text, or null when there is none or it cannot be reached (Docker with the container down). */
export async function projectOverlayText(project: Pick<ProjectJson, 'projectId' | 'runtime'>, access: OverlayAccess = {}): Promise<string | null> {
  if (runtimeOf(project) === 'host') {
    try { return (await readFile(overlayPath(hostRuntimePaths(project.projectId).state), 'utf8')).slice(0, MAX_OVERLAY_BYTES); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  if (!access.running || !access.exec || !(await access.running().catch(() => false))) return null;
  const r = await access.exec(READ_OVERLAY);
  if (r.code !== 0) throw new Error(`reading the control overlay in the container failed (exit ${r.code})`);
  return r.stdout;
}

export interface WithOverlay extends EffectiveConfig {
  /** Dotted keys the overlay sets (their provenance is `control`). */
  overlayKeys: string[];
  /** Why the overlay was not merged (unreadable or invalid). */
  warning?: string;
}

/** The effective config with the overlay text merged on top (null text: unchanged). Never throws. */
export function mergeOverlay(eff: EffectiveConfig, text: string | null): WithOverlay {
  if (text === null || !text.trim()) return { ...eff, overlayKeys: [] };
  let cfg: unknown;
  try {
    const v = JSON.parse(text) as { config?: unknown } | null;
    cfg = v && typeof v === 'object' ? v.config : undefined;
  } catch { return { ...eff, overlayKeys: [], warning: 'the coordinator\'s control overlay is not valid JSON; ignored' }; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !Object.keys(cfg).length) return { ...eff, overlayKeys: [] };
  const prov: Record<string, Source> = { ...eff.provenance };
  try {
    const config = applyControl(eff.config, cfg, 'control overlay', prov);
    const overlayKeys = Object.entries(prov).filter(([, s]) => s === 'control').map(([k]) => k);
    return { config, provenance: prov, overlayKeys };
  } catch (e) {
    return { ...eff, overlayKeys: [], warning: `the coordinator's control overlay does not validate on top of the host config (${(e as Error).message.slice(0, 200)}); ignored` };
  }
}
