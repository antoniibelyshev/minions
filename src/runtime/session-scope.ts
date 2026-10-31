// Session scoping (docs/design/coordinator-sessions.md decision 9, task-57 phase 6). A headless coordinator session
// runs with MINIONS_SESSION=<key> (sessionEnv in ./sessions.ts); the hooks and the coordinator's own state use it to
// scope themselves to that session:
//
// - the Stop guard looks only at the session's task (`task:<id>`) or is off (`general`, `router`);
// - the transcript record is meta `coordinator_transcript:<key>`;
// - coordinator usage states carry the role (`router`, `task`, `general`) and the key, and a new session completes
//   only the open states of the same key;
// - contextResetCheck counts only the session's own leases (holder = key) and events;
// - the handoff file is `<state>/coordinator-handoff.<key>.json`;
// - a lease's holder is the key, and `work advance` in a task session claims only that task's next stage.
//
// Unset (or empty), nothing changes: every helper here returns the single-coordinator value. A malformed value is
// never trusted: commands refuse it (sessionScope throws), hooks fall back to allowing the stop and record nothing.
import { join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { parseSessionKey } from './sessions.js';

export const SESSION_ENV = 'MINIONS_SESSION';
/** The router is the existing coordinator launch (decision 3): not a headless session row, but scoped like one. */
export const ROUTER_SESSION = 'router';

export type SessionScopeKind = 'router' | 'task' | 'general' | 'thread';
export interface SessionScope { key: string; kind: SessionScopeKind; taskId: string | null }

/** Parses a session key: `router`, `general`, `task:<id>` or `thread:<root message id>` (parseSessionKey); throws MinionsError otherwise. */
export function parseScope(raw: string): SessionScope {
  if (raw === ROUTER_SESSION) return { key: raw, kind: 'router', taskId: null };
  const k = parseSessionKey(raw);
  return { key: k.key, kind: k.kind, taskId: k.taskId };
}

/**
 * The session this process belongs to: null when MINIONS_SESSION is unset or empty (the single coordinator).
 * Throws INVALID_CONFIG on a malformed value (commands refuse to run with it).
 */
export function sessionScope(env: NodeJS.ProcessEnv = process.env): SessionScope | null {
  const raw = env[SESSION_ENV];
  if (raw === undefined || raw === '') return null;
  try { return parseScope(raw); } catch (e) {
    throw new MinionsError('INVALID_CONFIG', `${SESSION_ENV} is not a session key: ${JSON.stringify(raw.slice(0, 120))}.`,
      (e as MinionsError).hint ?? 'Use `router`, `general` or `task:<task id>`, or unset it.');
  }
}

/** For hooks (never throw): the scope, or `invalid` when the value is malformed. */
export function hookScope(env: NodeJS.ProcessEnv = process.env): { scope: SessionScope | null; invalid: boolean } {
  try { return { scope: sessionScope(env), invalid: false }; } catch { return { scope: null, invalid: true }; }
}

/** A meta key scoped to the session: `<base>:<key>`, or `<base>` itself without a session. */
export const scopedMetaKey = (base: string, scope: SessionScope | null): string => (scope ? `${base}:${scope.key}` : base);

/** The coordinator handoff file: `<state>/coordinator-handoff.json`, or `<state>/coordinator-handoff.<key>.json` in a session. */
export const handoffPathFor = (state: string, scope: SessionScope | null, single: string = join(state, 'coordinator-handoff.json')): string =>
  (scope ? join(state, `coordinator-handoff.${scope.key}.json`) : single);
