import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { IdempotencyStore } from '../backlog/types.js';
import { MinionsError } from '../core/errors.js';
import { runtimePaths } from './paths.js';

export const SCHEMA_VERSION = 3;

export type LeaseRole = 'engineer' | 'tester' | 'reviewer';
/** active: worker running (or awaiting a correction); completed: valid result; released: no result; unvalidated: invalid after correction. */
export type LeaseStatus = 'active' | 'completed' | 'released' | 'unvalidated';

export interface Lease {
  id: string; task_id: string; role: LeaseRole; attempt: number; holder: string | null;
  worktree: string | null; branch: string | null; base_sha: string | null; head_sha: string | null;
  config_revision: number; started_at: string; ended_at: string | null; status: LeaseStatus;
  result_json: string | null; result_valid: number | null;
}

export interface EvidenceRow {
  task_id: string; head_sha: string; kind: string; config_revision: number;
  outcome: string; details_json: string | null; recorded_at: string;
}

/**
 * Publication of an approved task (branch / pull-request delivery). One row per task, bound to the
 * approved head. pending: approved, not yet published (or interrupted); awaiting-approval: needs a
 * recorded human approval (sensitive paths or an "ask" capability); failed: retryable with
 * `minions work publish`; published: pushed (and PR opened in pull-request mode).
 */
export type PublicationState = 'pending' | 'awaiting-approval' | 'failed' | 'published';
export interface PublicationRow {
  task_id: string; branch: string; head_sha: string; mode: string; state: PublicationState;
  pr_url: string | null; error_code: string | null; error: string | null;
  config_revision: number; updated_at: string;
}
/** signature: host-signed approval token (src/core/approval.ts); verified again before every publication. */
export interface ApprovalRow { id: number; task_id: string; scope: string; head_sha: string; approved_by: string | null; note: string | null; recorded_at: string; signature: string | null }

export interface GuardRow { fingerprint: string | null; count: number; last_reason: string | null; updated_at: string | null }
/** The last `controls` event that set one pause flag: its event id, time and the value it set. */
export interface PauseChange { id: number; at: string; value: boolean }

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS controls (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, attempt INTEGER NOT NULL,
      holder TEXT, worktree TEXT, branch TEXT, base_sha TEXT, head_sha TEXT,
      config_revision INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      status TEXT NOT NULL, result_json TEXT, result_valid INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_per_task ON leases(task_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS leases_task ON leases(task_id);
    CREATE TABLE IF NOT EXISTS evidence (
      task_id TEXT NOT NULL, head_sha TEXT NOT NULL, kind TEXT NOT NULL, config_revision INTEGER NOT NULL,
      outcome TEXT NOT NULL, details_json TEXT, recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS evidence_task_head ON evidence(task_id, head_sha);
    CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS guard (
      id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT, count INTEGER NOT NULL DEFAULT 0,
      last_reason TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, data_json TEXT);
    CREATE TABLE IF NOT EXISTS repairs (task_id TEXT PRIMARY KEY, cycles INTEGER NOT NULL DEFAULT 0);
  `,
  2: `
    CREATE TABLE IF NOT EXISTS publications (
      task_id TEXT PRIMARY KEY, branch TEXT NOT NULL, head_sha TEXT NOT NULL, mode TEXT NOT NULL,
      state TEXT NOT NULL, pr_url TEXT, error_code TEXT, error TEXT,
      config_revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, scope TEXT NOT NULL, head_sha TEXT NOT NULL,
      approved_by TEXT, note TEXT, recorded_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS approvals_task_head ON approvals(task_id, scope, head_sha);
  `,
  // Host-signed approvals: the token is stored with the row; rows without one never authorize publication.
  3: `
    ALTER TABLE approvals ADD COLUMN signature TEXT;
  `,
};

let warningFilterInstalled = false;
/** Drops only the node:sqlite ExperimentalWarning (Node 22.x); every other warning passes through. */
function suppressSqliteWarning(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const original = process.emitWarning.bind(process) as (...a: unknown[]) => void;
  (process as { emitWarning: unknown }).emitWarning = (warning: unknown, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : '';
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type
      ?? (warning instanceof Error ? warning.name : undefined);
    if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
    original(warning, ...rest);
  };
}

function loadSqlite(): typeof import('node:sqlite') {
  suppressSqliteWarning();
  const mod = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;
  if (!mod) throw new MinionsError('INCOMPATIBLE_RUNTIME', 'node:sqlite is unavailable in this Node.js build.', 'Use Node.js >= 22.13.');
  return mod;
}

const nowIso = () => new Date().toISOString();

/** Whether a process with this pid exists (EPERM: exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface CoordinatorLock { pid: number; session: string; acquiredAt: string }

export class RuntimeDb {
  readonly path: string;
  readonly sql: DatabaseSync;
  private depth = 0;

  constructor(path = runtimePaths().db) {
    this.path = path;
    const { DatabaseSync } = loadSqlite();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    try {
      this.sql = new DatabaseSync(path);
    } catch (e) {
      throw new MinionsError('INTERNAL', `Cannot open runtime database ${path}: ${(e as Error).message}`);
    }
    this.sql.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.sql.exec('PRAGMA journal_mode = WAL');
    this.sql.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.transaction(() => {
      const current = Number(this.getMeta('schema_version') ?? 0);
      if (current > SCHEMA_VERSION) {
        throw new MinionsError('INCOMPATIBLE_RUNTIME', `Runtime database schema ${current} is newer than this build supports (${SCHEMA_VERSION}).`,
          'Upgrade minions; do not downgrade a running installation.');
      }
      for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
        this.sql.exec(MIGRATIONS[v]!);
        this.setMeta('schema_version', String(v));
      }
      this.sql.prepare('INSERT OR IGNORE INTO guard (id, count) VALUES (1, 0)').run();
    });
  }

  close(): void { if (this.sql.isOpen) this.sql.close(); }

  /** Runs fn in a BEGIN IMMEDIATE transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.sql.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.sql.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    } finally {
      this.depth--;
    }
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] { return this.sql.prepare(query).all(...params) as T[]; }
  get<T>(query: string, ...params: SQLInputValue[]): T | undefined { return this.sql.prepare(query).get(...params) as T | undefined; }
  exec(query: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.sql.prepare(query).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  getMeta(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value; }
  setMeta(key: string, value: string): void { this.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }
  deleteMeta(key: string): void { this.exec('DELETE FROM meta WHERE key = ?', key); }

  getControl(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM controls WHERE key = ?', key)?.value; }
  setControl(key: string, value: string): void { this.exec('INSERT INTO controls (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }

  paused(): { intake: boolean; starts: boolean } {
    return { intake: this.getControl('paused_intake') === '1', starts: this.getControl('paused_starts') === '1' };
  }
  setPaused(which: { intake?: boolean; starts?: boolean }): { intake: boolean; starts: boolean } {
    this.transaction(() => {
      if (which.intake !== undefined) this.setControl('paused_intake', which.intake ? '1' : '0');
      if (which.starts !== undefined) this.setControl('paused_starts', which.starts ? '1' : '0');
      this.addEvent('controls', null, which);
    });
    return this.paused();
  }

  /** The last `controls` event that set intake or starts (lets `minions upgrade` tell its own pause from the user's). */
  lastPauseChange(which: 'intake' | 'starts'): PauseChange | null {
    for (const r of this.all<{ id: number; at: string; data_json: string | null }>("SELECT id, at, data_json FROM events WHERE kind = 'controls' ORDER BY id DESC")) {
      let d: Record<string, unknown> | null = null;
      try { d = r.data_json ? JSON.parse(r.data_json) as Record<string, unknown> : null; } catch { /* not a controls payload */ }
      if (d && typeof d[which] === 'boolean') return { id: r.id, at: r.at, value: d[which] as boolean };
    }
    return null;
  }
  pauseChanges(): { intake: PauseChange | null; starts: PauseChange | null } {
    return { intake: this.lastPauseChange('intake'), starts: this.lastPauseChange('starts') };
  }

  addEvent(kind: string, taskId: string | null, data?: unknown): number {
    return this.exec('INSERT INTO events (at, kind, task_id, data_json) VALUES (?, ?, ?, ?)',
      nowIso(), kind, taskId, data === undefined ? null : JSON.stringify(data)).lastInsertRowid;
  }
  lastEventId(): number { return this.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events')?.id ?? 0; }
  events(taskId: string, kind?: string): { id: number; at: string; kind: string; data: unknown }[] {
    const rows = kind
      ? this.all<{ id: number; at: string; kind: string; data_json: string | null }>('SELECT * FROM events WHERE task_id = ? AND kind = ? ORDER BY id', taskId, kind)
      : this.all<{ id: number; at: string; kind: string; data_json: string | null }>('SELECT * FROM events WHERE task_id = ? ORDER BY id', taskId);
    return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, data: r.data_json ? JSON.parse(r.data_json) : null }));
  }

  // Leases
  lease(id: string): Lease | undefined { return this.get<Lease>('SELECT * FROM leases WHERE id = ?', id); }
  activeLeases(): Lease[] { return this.all<Lease>("SELECT * FROM leases WHERE status = 'active' ORDER BY started_at"); }
  leases(opts: { taskId?: string; all?: boolean } = {}): Lease[] {
    const where: string[] = [], params: SQLInputValue[] = [];
    if (!opts.all) where.push("status = 'active'");
    if (opts.taskId) { where.push('task_id = ?'); params.push(opts.taskId); }
    return this.all<Lease>(`SELECT * FROM leases ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at, rowid`, ...params);
  }

  // Evidence
  addEvidence(e: Omit<EvidenceRow, 'recorded_at'>): void {
    this.exec('INSERT INTO evidence (task_id, head_sha, kind, config_revision, outcome, details_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.task_id, e.head_sha, e.kind, e.config_revision, e.outcome, e.details_json, nowIso());
  }
  /** Evidence is always looked up by the current head SHA; older commits never satisfy a check. */
  evidenceFor(taskId: string, headSha: string, kind?: string, configRevision?: number): EvidenceRow[] {
    let q = 'SELECT * FROM evidence WHERE task_id = ? AND head_sha = ?';
    const p: SQLInputValue[] = [taskId, headSha];
    if (kind) { q += ' AND kind = ?'; p.push(kind); }
    if (configRevision !== undefined) { q += ' AND config_revision = ?'; p.push(configRevision); }
    return this.all<EvidenceRow>(q + ' ORDER BY recorded_at', ...p);
  }

  // Repairs
  repairCycles(taskId: string): number { return this.get<{ cycles: number }>('SELECT cycles FROM repairs WHERE task_id = ?', taskId)?.cycles ?? 0; }
  incrementRepairs(taskId: string): number {
    this.exec('INSERT INTO repairs (task_id, cycles) VALUES (?, 1) ON CONFLICT(task_id) DO UPDATE SET cycles = cycles + 1', taskId);
    return this.repairCycles(taskId);
  }

  // Publications (branch / pull-request delivery)
  publication(taskId: string): PublicationRow | undefined { return this.get<PublicationRow>('SELECT * FROM publications WHERE task_id = ?', taskId); }
  /** Starts (or restarts) the publication of an approved head; a new head resets any earlier state. */
  upsertPublication(p: { task_id: string; branch: string; head_sha: string; mode: string; config_revision: number }): PublicationRow {
    this.exec(`INSERT INTO publications (task_id, branch, head_sha, mode, state, pr_url, error_code, error, config_revision, updated_at)
      VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET branch = excluded.branch, head_sha = excluded.head_sha, mode = excluded.mode,
        state = 'pending', pr_url = NULL, error_code = NULL, error = NULL, config_revision = excluded.config_revision, updated_at = excluded.updated_at`,
      p.task_id, p.branch, p.head_sha, p.mode, p.config_revision, nowIso());
    return this.publication(p.task_id)!;
  }
  setPublicationState(taskId: string, state: PublicationState, x: { prUrl?: string | null; errorCode?: string | null; error?: string | null } = {}): PublicationRow {
    this.exec('UPDATE publications SET state = ?, pr_url = COALESCE(?, pr_url), error_code = ?, error = ?, updated_at = ? WHERE task_id = ?',
      state, x.prUrl ?? null, x.errorCode ?? null, x.error ?? null, nowIso(), taskId);
    return this.publication(taskId)!;
  }

  // Human approvals, bound to a head SHA (a new commit needs a new approval).
  addApproval(a: { task_id: string; scope: string; head_sha: string; approved_by: string | null; note: string | null; signature?: string | null }): ApprovalRow {
    const id = this.exec('INSERT INTO approvals (task_id, scope, head_sha, approved_by, note, recorded_at, signature) VALUES (?, ?, ?, ?, ?, ?, ?)',
      a.task_id, a.scope, a.head_sha, a.approved_by, a.note, nowIso(), a.signature ?? null).lastInsertRowid;
    return this.get<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id)!;
  }
  /** Every approval row for one head, newest first (the runtime verifies their signatures; rows are not trusted). */
  approvals(taskId: string, scope: string, headSha: string): ApprovalRow[] {
    return this.all<ApprovalRow>('SELECT * FROM approvals WHERE task_id = ? AND scope = ? AND head_sha = ? ORDER BY id DESC', taskId, scope, headSha);
  }
  approval(taskId: string, scope: string, headSha: string): ApprovalRow | undefined {
    return this.get<ApprovalRow>('SELECT * FROM approvals WHERE task_id = ? AND scope = ? AND head_sha = ? ORDER BY id DESC LIMIT 1', taskId, scope, headSha);
  }

  // Stop guard
  guard(): GuardRow { return this.get<GuardRow>('SELECT fingerprint, count, last_reason, updated_at FROM guard WHERE id = 1') ?? { fingerprint: null, count: 0, last_reason: null, updated_at: null }; }
  setGuard(g: { fingerprint: string | null; count: number; last_reason: string | null }): void {
    this.exec('INSERT INTO guard (id, fingerprint, count, last_reason, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET fingerprint = excluded.fingerprint, count = excluded.count, last_reason = excluded.last_reason, updated_at = excluded.updated_at',
      g.fingerprint, g.count, g.last_reason, nowIso());
  }

  /** IdempotencyStore backed by the `idempotency` table (for the backlog adapter). */
  readonly idempotency: IdempotencyStore = {
    get: (key) => this.get<{ task_id: string }>('SELECT task_id FROM idempotency WHERE key = ?', key)?.task_id,
    put: (key, taskId) => {
      const existing = this.idempotency.get(key);
      if (existing !== undefined && existing !== taskId) {
        throw new MinionsError('CONFLICT', `Idempotency key ${key} already maps to ${existing}.`);
      }
      this.exec('INSERT OR IGNORE INTO idempotency (key, task_id) VALUES (?, ?)', key, taskId);
    },
  };

  // Coordinator lock (meta row `coordinator_lock`)
  coordinatorLock(): CoordinatorLock | undefined {
    const v = this.getMeta('coordinator_lock');
    return v ? (JSON.parse(v) as CoordinatorLock) : undefined;
  }
  /**
   * Acquires the project coordinator lock; CONFLICT if another live holder has it. Re-entrant for the
   * same pid+session. A holder that is not `alive` (crashed wrapper, reused pid) is taken over.
   */
  acquireCoordinatorLock(session: string, pid = process.pid, alive: (pid: number) => boolean = pidAlive): CoordinatorLock {
    return this.transaction(() => {
      const cur = this.coordinatorLock();
      if (cur && !(cur.pid === pid && cur.session === session) && alive(cur.pid)) {
        throw new MinionsError('CONFLICT', `Another coordinator holds the project lock (pid ${cur.pid}, session ${cur.session}, since ${cur.acquiredAt}).`,
          'Attach to the existing coordinator (minions start) instead of launching a second one.', cur);
      }
      const lock: CoordinatorLock = { pid, session, acquiredAt: cur && cur.pid === pid && cur.session === session ? cur.acquiredAt : nowIso() };
      this.setMeta('coordinator_lock', JSON.stringify(lock));
      if (!cur || cur.pid !== pid || cur.session !== session) this.addEvent('coordinator-lock', null, { ...lock, replaced: cur ?? null });
      return lock;
    });
  }
  releaseCoordinatorLock(session: string, pid = process.pid): boolean {
    return this.transaction(() => {
      const cur = this.coordinatorLock();
      if (!cur || cur.pid !== pid || cur.session !== session) return false;
      this.deleteMeta('coordinator_lock');
      return true;
    });
  }
}

export const openDb = (path?: string) => new RuntimeDb(path);
