// Host runtime: the owner's opt-in to a looser coordinator permission mode (task-8).
//
// On the host runtime the coordinator runs in permission mode `default` unless the owner sets
// coordinator.permissionMode ("auto" or "acceptEdits") in the host-only config.local.json layer
// (`minions settings set coordinator.permissionMode auto` on the host). The merged runtime config cannot tell
// that layer apart from the repository's .minions/config.json, so the host CLI writes the local layer's value,
// and only that, into `host-permission.json` next to the runtime config (<project>/runtime: read-only for the
// agents, outside the workspace and state they may write). The runtime honours it only when:
// - it runs on the host (never in the container, where the file is never consulted),
// - MINIONS_CONFIG is set (the shim pins it to <project>/runtime/config.json, like the approval key),
// - the file is not inside the agent-writable workspace or state,
// - the file is valid and names "auto" or "acceptEdits" (bypassPermissions / dontAsk are refused), and
// - the merged runtime config carries the same coordinator.permissionMode (the local layer wins the merge,
//   so a mismatch means a stale or hand-edited file).
// Anything else fails closed to `default`. Only the mode changes: the allow/deny/ask rules, the sandbox and
// the sensitive-path rules are the same in every mode (coordinatorSettings never reads the mode).
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inMinionsContainer } from './paths.js';

/** File name next to the runtime config (<project>/runtime/host-permission.json). */
export const HOST_PERMISSION_FILE = 'host-permission.json';

/** Modes the owner may opt the host-runtime coordinator into. Never bypassPermissions or dontAsk. */
export const HOST_OPT_IN_MODES = ['auto', 'acceptEdits'] as const;
export type HostOptInMode = typeof HOST_OPT_IN_MODES[number];

/** Modes that are never allowed for the coordinator, from any layer. */
export const FORBIDDEN_PERMISSION_MODES = ['bypassPermissions', 'dontAsk'] as const;

/** What the host writes: the host-only layer's coordinator.permissionMode (null: unset or not an opt-in mode). */
export interface HostPermissionRecord {
  version: 1;
  coordinatorPermissionMode: HostOptInMode | null;
  /** The host-only layer the value came from (config.local.json of the project; not a secret). */
  source: string;
}

/** The owner's opt-in as the runtime honours it. */
export interface HostPermissionLayer {
  mode: HostOptInMode;
  /** Path of the host-only config.local.json the value came from. */
  source: string;
}

export interface HostPermissionRead {
  layer: HostPermissionLayer | null;
  /** Why an opt-in present on disk was not honoured (fail closed); absent when there was nothing to honour. */
  note?: string;
}

const isOptIn = (v: unknown): v is HostOptInMode => typeof v === 'string' && (HOST_OPT_IN_MODES as readonly string[]).includes(v);

/**
 * Host side: the record for <project>/runtime/host-permission.json from the raw config.local.json layer. Only
 * that layer is read, never the merged config or the repository's .minions/config.json.
 */
export function hostPermissionRecord(localRaw: unknown, localFile: string): HostPermissionRecord {
  const v = localRaw && typeof localRaw === 'object' && !Array.isArray(localRaw)
    ? ((localRaw as { coordinator?: { permissionMode?: unknown } }).coordinator?.permissionMode) : undefined;
  return { version: 1, coordinatorPermissionMode: isOptIn(v) ? v : null, source: localFile };
}

/**
 * Where the runtime reads the record: next to the runtime config the shim pins (MINIONS_CONFIG). null in the
 * container (detected from the filesystem or MINIONS_RUNTIME=container) and when MINIONS_CONFIG is unset: then
 * no opt-in is ever honoured.
 */
export function hostPermissionPath(env: NodeJS.ProcessEnv = process.env, inContainer: boolean = inMinionsContainer()): string | null {
  if (inContainer || env.MINIONS_RUNTIME === 'container' || !env.MINIONS_CONFIG) return null;
  return join(dirname(env.MINIONS_CONFIG), HOST_PERMISSION_FILE);
}

const realOr = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Runtime side: reads the owner's opt-in. Never throws; every doubt is "no opt-in" (permission mode default).
 * `agentWritable`: directories the agents may write (workspace, state); a record there is never honoured.
 */
export function readHostPermission(file: string | null, agentWritable: readonly string[], read: (p: string) => string = (p) => readFileSync(p, 'utf8')): HostPermissionRead {
  if (!file) return { layer: null };
  const real = realOr(file);
  const writable = agentWritable.filter(Boolean).map(realOr);
  if (writable.some((d) => inside(real, d) || inside(resolve(file), d))) {
    return { layer: null, note: `${file} is inside an agent-writable directory; the opt-in is ignored` };
  }
  let text: string;
  try { text = read(file); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { layer: null } : { layer: null, note: `${file} is not readable (${(e as Error).message}); the opt-in is ignored` };
  }
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { layer: null, note: `${file} is not valid JSON; the opt-in is ignored` }; }
  const r = v as Partial<HostPermissionRecord> | null;
  if (!r || typeof r !== 'object' || r.version !== 1 || typeof r.source !== 'string') return { layer: null, note: `${file} is not a host permission record; the opt-in is ignored` };
  if (r.coordinatorPermissionMode === null || r.coordinatorPermissionMode === undefined) return { layer: null };
  if (!isOptIn(r.coordinatorPermissionMode)) {
    return { layer: null, note: `${file} names permission mode ${JSON.stringify(r.coordinatorPermissionMode)}, which the coordinator may never use; the opt-in is ignored` };
  }
  return { layer: { mode: r.coordinatorPermissionMode, source: r.source } };
}

/**
 * Which layer chose the mode (task-8). host-local: the host runtime honoured coordinator.permissionMode from the
 * host-only config.local.json; host-default: the host runtime's strict default (no opt-in there; a value from
 * the repository or shared config is ignored); config: the container's merged config set it; default: the
 * container's built-in default (auto).
 */
export type PermissionModeSource = 'host-local' | 'host-default' | 'config' | 'default';

/** Human label of a decision's source layer (status, doctor, probe). */
export function permissionSourceLabel(d: { source: PermissionModeSource; sourceFile?: string }): string {
  switch (d.source) {
    case 'host-local': return `host-only config.local.json${d.sourceFile ? ` (${d.sourceFile})` : ''}`;
    case 'host-default': return 'host runtime default';
    case 'config': return 'project configuration';
    default: return 'built-in default';
  }
}
