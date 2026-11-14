// The Stop guard of a coordinator session (docs/design/coordinator-sessions.md decision 9, phase 6). The single
// coordinator's guard (stopHook in ./hooks.ts) looks at every held decision; a session's looks only at its own task:
//
// - `router`, `general` and `thread:<id>`: off (nothing is left undone when they stop);
// - `task:<id>`: blocks only while the autopilot dispatcher holds that task for a decision (docs/design/autonomy.md
//   Decision 10: holds are what a task session is opened for) and the hold changed since the last continuation. Its
//   no-progress fingerprint is kept per session (meta `stop_guard:<key>`), never in the single coordinator's guard row.
//
// Any failure allows the stop, like the single coordinator's guard.
import { readHolds } from './dispatch-state.js';
import { holdsFingerprint, holdsReason, type HookDeps, type HookOutput } from './hooks.js';
import { scopedMetaKey, type SessionScope } from './session-scope.js';

export const SESSION_GUARD_META = 'stop_guard';
/** Continuations without progress before the guard lets the session stop (as the single coordinator's NO_PROGRESS_LIMIT). */
const NO_PROGRESS_LIMIT = 2;

interface GuardState { fingerprint: string | null; count: number; lastReason: string | null }

function readGuard(db: HookDeps['db'], scope: SessionScope): GuardState {
  try {
    const v = db.getMeta(scopedMetaKey(SESSION_GUARD_META, scope));
    const g = v ? JSON.parse(v) as Partial<GuardState> : null;
    return { fingerprint: typeof g?.fingerprint === 'string' ? g.fingerprint : null, count: typeof g?.count === 'number' ? g.count : 0, lastReason: typeof g?.lastReason === 'string' ? g.lastReason : null };
  } catch { return { fingerprint: null, count: 0, lastReason: null }; }
}
function writeGuard(db: HookDeps['db'], scope: SessionScope, g: GuardState): void {
  try { db.setMeta(scopedMetaKey(SESSION_GUARD_META, scope), JSON.stringify(g)); } catch { /* best-effort */ }
}

export function sessionStopGuard(deps: Pick<HookDeps, 'db'>, scope: SessionScope): HookOutput {
  const { db } = deps;
  if (scope.kind !== 'task' || !scope.taskId) return { reason: `allow: the Stop guard is off for the ${scope.key} session` };
  const taskId = scope.taskId;
  try {
    const hold = readHolds(db)[taskId];
    if (!hold) {
      writeGuard(db, scope, { fingerprint: null, count: 0, lastReason: 'no-hold' });
      return { reason: `allow: no decision waits for ${taskId}` };
    }
    const fingerprint = holdsFingerprint([hold]);
    const g = readGuard(db, scope);
    if (g.fingerprint === fingerprint && g.count >= NO_PROGRESS_LIMIT) {
      writeGuard(db, scope, { fingerprint, count: g.count, lastReason: 'no-progress' });
      return { reason: 'allow: no-progress (the held decision is unchanged after repeated continuation)' };
    }
    writeGuard(db, scope, { fingerprint, count: g.fingerprint === fingerprint ? g.count + 1 : 1, lastReason: 'continue' });
    const reason = holdsReason([hold]);
    return { stdout: JSON.stringify({ decision: 'block', reason }), reason };
  } catch (e) {
    return { reason: `allow: internal error (${(e as Error).message})` };
  }
}
