// The `sessions` and `session_inbox` rows (schema 10; docs/design/coordinator-sessions.md, task-57 phases 4 and 5).
// The supervisor (src/runtime/supervisor.ts) reads and writes them; later phases open task sessions (phase 7) and
// route owner messages into the inbox (phase 8) through the same helpers.
import type { RuntimeDb, SessionInboxRow, SessionRow, SessionStatus } from './db.js';
import { parseSessionKey } from './sessions.js';

export const getSession = (db: RuntimeDb, key: string): SessionRow | null =>
  db.get<SessionRow>('SELECT * FROM sessions WHERE key = ?', key) ?? null;

export const sessionsByStatus = (db: RuntimeDb, status: SessionStatus): SessionRow[] =>
  db.all<SessionRow>('SELECT * FROM sessions WHERE status = ? ORDER BY opened_at, key', status);

/**
 * Opens a session (insert), or reopens a closed or failed one: status `open`, the resume count and the failure
 * cleared, the claude session id kept (so `--resume` continues the transcript). An open session is left as it is.
 */
export function openSession(db: RuntimeDb, key: string, o: { configDir: string; model?: string | null; now?: Date }): SessionRow {
  const k = parseSessionKey(key);
  const at = (o.now ?? new Date()).toISOString();
  return db.transaction(() => {
    const cur = getSession(db, k.key);
    if (cur?.status === 'open') return cur;
    if (cur) {
      db.exec('UPDATE sessions SET status = ?, opened_at = ?, closed_at = NULL, resumes = 0, failure = NULL, model = ?, config_dir = ? WHERE key = ?',
        'open', at, o.model ?? cur.model, o.configDir, k.key);
    } else {
      db.exec('INSERT INTO sessions (key, kind, claude_session_id, status, model, config_dir, opened_at, resumes) VALUES (?, ?, NULL, ?, ?, ?, ?, 0)',
        k.key, k.kind, 'open', o.model ?? null, o.configDir, at);
    }
    db.addEvent('session-open', k.taskId, { key: k.key, reopened: !!cur });
    return getSession(db, k.key)!;
  });
}

export type SessionPatch = Partial<Pick<SessionRow, 'claude_session_id' | 'status' | 'model' | 'last_wake_at' | 'closed_at' | 'resumes' | 'failure'>>;

const PATCH_COLUMNS = ['claude_session_id', 'status', 'model', 'last_wake_at', 'closed_at', 'resumes', 'failure'] as const;

export function updateSession(db: RuntimeDb, key: string, patch: SessionPatch): void {
  const cols = PATCH_COLUMNS.filter((c) => patch[c] !== undefined);
  if (!cols.length) return;
  db.exec(`UPDATE sessions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE key = ?`, ...cols.map((c) => patch[c] as string | number | null), key);
}

/** Queues a message for a session (it need not be open yet). Returns the inbox id. */
export function enqueueInbox(db: RuntimeDb, key: string, source: string, text: string, o: { meta?: unknown; now?: Date } = {}): number {
  const k = parseSessionKey(key);
  return db.exec('INSERT INTO session_inbox (session_key, source, text, meta_json, created_at) VALUES (?, ?, ?, ?, ?)',
    k.key, source, text, o.meta === undefined ? null : JSON.stringify(o.meta), (o.now ?? new Date()).toISOString()).lastInsertRowid;
}

/** Undelivered messages of a session, oldest first; `sources` limits them (drain: only drain notices). */
export function pendingInbox(db: RuntimeDb, key: string, o: { sources?: readonly string[] } = {}): SessionInboxRow[] {
  const rows = db.all<SessionInboxRow>('SELECT * FROM session_inbox WHERE session_key = ? AND delivered_at IS NULL ORDER BY id', key);
  return o.sources ? rows.filter((r) => o.sources!.includes(r.source)) : rows;
}

/** Session keys with undelivered messages. */
export const keysWithPendingInbox = (db: RuntimeDb): string[] =>
  db.all<{ session_key: string }>('SELECT DISTINCT session_key FROM session_inbox WHERE delivered_at IS NULL ORDER BY session_key').map((r) => r.session_key);

/** Marks a message handed over; false when it already was. */
export const markInboxDelivered = (db: RuntimeDb, id: number, now: Date = new Date()): boolean =>
  db.exec('UPDATE session_inbox SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL', now.toISOString(), id).changes > 0;
