// Drain: a durable request that running workers wind down to a safe checkpoint (`minions upgrade`).
// The request lives in the runtime DB (controls row `drain` + `drain-request` event); a flag file at
// <state>/run/drain mirrors it so the per-tool-call worker hook can skip node entirely while no drain is
// active (`[ ! -e <flag> ] || minions hook drain`). Starts stay paused for the whole drain.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DrainRequest, PauseChange, RuntimeDb } from './db.js';

export interface DrainPaths { drainFlag: string }

/** Writes (or refreshes) the flag file for an active request; never throws (the DB row is authoritative). */
function writeFlag(p: DrainPaths, d: DrainRequest): void {
  try {
    mkdirSync(dirname(p.drainFlag), { recursive: true, mode: 0o755 });
    writeFileSync(p.drainFlag, JSON.stringify(d) + '\n', { mode: 0o644 });
  } catch { /* the hook then simply does not fire; --timeout/--now remain the fallback */ }
}

/**
 * Pauses starts (when not paused already: an existing pause keeps its `controls` event, so
 * `minions upgrade` still recognizes whose pause it is) and records the drain request.
 */
export function requestDrain(db: RuntimeDb, p: DrainPaths, reason: string): { drain: DrainRequest; paused: { intake: boolean; starts: boolean }; pauseChanges: { intake: PauseChange | null; starts: PauseChange | null } } {
  const drain = db.transaction(() => {
    if (!db.paused().starts) db.setPaused({ starts: true });
    return db.setDrain(reason);
  });
  writeFlag(p, drain);
  return { drain, paused: db.paused(), pauseChanges: db.pauseChanges() };
}

/** Clears the request and removes the flag file (also a stale flag without a DB row). */
export function clearDrain(db: RuntimeDb, p: DrainPaths, by: string): DrainRequest | null {
  const cleared = db.clearDrain(by);
  try { rmSync(p.drainFlag, { force: true }); } catch { /* best effort */ }
  return cleared;
}

/** The shell gate for the worker drain hook: node starts only while the flag file exists. */
export const DRAIN_HOOK_COMMAND = '[ ! -e ${MINIONS_STATE_DIR:-/state}/run/drain ] || minions hook drain';
