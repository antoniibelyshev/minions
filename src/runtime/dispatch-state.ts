// Dispatcher state the hooks, the routine and the CLI read without loading the dispatcher itself
// (docs/design/autonomy.md Decision 1): the settings and the holds (tasks parked for a coordinator decision).
import type { MinionsConfig } from '../config/schema.js';
import type { RecordDecisionKind } from './advance.js';
import type { RuntimeDb } from './db.js';

export const DISPATCH_EVENT = 'dispatch-decision';
export const HOLDS_META = 'dispatch_holds';
export const DEFAULT_TICK_SECONDS = 10;
export const DEFAULT_WORKER_TIMEOUT_MINUTES = 120;

export const dispatchSettings = (cfg: Pick<MinionsConfig, 'dispatch'>) => ({
  tickMs: (cfg.dispatch?.tickSeconds ?? DEFAULT_TICK_SECONDS) * 1000,
  workerTimeoutMs: (cfg.dispatch?.workerTimeoutMinutes ?? DEFAULT_WORKER_TIMEOUT_MINUTES) * 60_000,
});

export type HoldKind = RecordDecisionKind | 'claim-failed' | 'no-result' | 'launch-failed';
export interface DispatchHold {
  taskId: string; kind: HoldKind; message: string; leaseId: string | null; at: string;
  /** The task's status when it was held: a different status later means the coordinator acted. */
  status: string | null;
  errors?: string[];
}

export function readHolds(db: Pick<RuntimeDb, 'getMeta'>): Record<string, DispatchHold> {
  try {
    const v = JSON.parse(db.getMeta(HOLDS_META) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, DispatchHold> : {};
  } catch { return {}; }
}
export const writeHolds = (db: Pick<RuntimeDb, 'setMeta'>, h: Record<string, DispatchHold>) => db.setMeta(HOLDS_META, JSON.stringify(h));

/** `minions work autopilot resume <taskId>`: the coordinator handled the decision; true when a hold was cleared. */
export function clearHold(db: Pick<RuntimeDb, 'getMeta' | 'setMeta' | 'addEvent'>, taskId: string, why: string): boolean {
  const h = readHolds(db);
  if (!h[taskId]) return false;
  delete h[taskId];
  writeHolds(db, h);
  db.addEvent('dispatch-resume', taskId, { why });
  return true;
}
