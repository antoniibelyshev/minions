import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { IdempotencyStore } from '../backlog/types.js';
import { MinionsError } from '../core/errors.js';
import { runtimePaths } from './paths.js';

export const SCHEMA_VERSION = 8;

/** The built-in worker roles (always registered). */
export type BuiltinLeaseRole = 'engineer' | 'tester' | 'reviewer';
/**
 * A lease's worker role: a built-in or a project role registered in the config (src/config/roles.ts),
 * validated against the registry at claim. Leases in the DB keep their role text.
 */
export type LeaseRole = string;
/** active: worker running (or awaiting a correction); completed: valid result; released: no result; unvalidated: invalid after correction. */
export type LeaseStatus = 'active' | 'completed' | 'released' | 'unvalidated';

export interface Lease {
  id: string; task_id: string; role: LeaseRole; attempt: number; holder: string | null;
  worktree: string | null; branch: string | null; base_sha: string | null; head_sha: string | null;
  config_revision: number; started_at: string; ended_at: string | null; status: LeaseStatus;
  result_json: string | null; result_valid: number | null;
  /** Agent runtime the lease was claimed on (agent-runtimes D9 cap); null = a lease from before schema 7, i.e. claude. */
  harness: string | null;
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

/**
 * A role proposal (docs/design/roles-and-workflows.md D2): drafted by the coordinator with
 * `minions config roles propose`, applied on the host with `minions config roles apply <id>`. Never effective
 * by itself. pending: waiting for the owner; applied: the host applied it; superseded: a later proposal for the
 * same role name replaced it.
 */
export type RoleProposalState = 'pending' | 'applied' | 'superseded';
export interface RoleProposalRow { id: string; name: string; json: string; created_at: string; state: RoleProposalState; updated_at: string; applied_revision: number | null }

/**
 * A change request (docs/design/host-manager.md): a setup change the coordinator proposes from the runtime.
 * proposed: waiting for the owner; confirmed: the owner confirmed the host plan and the host is applying it;
 * applied / failed: the host's outcome; rejected: the owner said no; expired: superseded by a newer request of
 * the same kind (and key). Only the host moves a request past proposed.
 */
export const CHANGE_REQUEST_STATUSES = ['proposed', 'confirmed', 'applied', 'failed', 'rejected', 'expired'] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];
export const CHANGE_REQUEST_KINDS = ['config-set', 'restart', 'upgrade'] as const;
export type ChangeRequestKind = (typeof CHANGE_REQUEST_KINDS)[number];
export interface ChangeRequestRow {
  id: string; kind: ChangeRequestKind; payload: string; reason: string | null; created_at: string;
  status: ChangeRequestStatus; updated_at: string; detail: string | null;
}

/** A task's workflow position (D6); `stages_json` holds the stage list including runtime insertions. */
export interface TaskStageRow { task_id: string; workflow: string; stages_json: string; position: number; updated_at: string }

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
  // Notification outbox (src/runtime/outbox.ts): one row per dedup key; delivered rows are kept so a key is sent once.
  4: `
    CREATE TABLE IF NOT EXISTS outbox (
      dedup_key TEXT PRIMARY KEY, kind TEXT NOT NULL, task_id TEXT, text TEXT NOT NULL,
      created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      next_attempt_at TEXT, delivered_at TEXT, delivered_via TEXT);
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(delivered_at, created_at);
  `,
  // Workflow position per task (docs/design/roles-and-workflows.md D6), written by claim and record. Tasks
  // without a row (legacy, or never claimed) derive their position from the backlog status.
  5: `
    CREATE TABLE IF NOT EXISTS task_stages (
      task_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, stages_json TEXT NOT NULL,
      position INTEGER NOT NULL, updated_at TEXT NOT NULL);
  `,
  // Role proposals (D2): stored by the runtime, applied by the host; a row never makes a role effective.
  6: `
    CREATE TABLE IF NOT EXISTS role_proposals (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL,
      state TEXT NOT NULL, updated_at TEXT NOT NULL, applied_revision INTEGER);
    CREATE INDEX IF NOT EXISTS role_proposals_name ON role_proposals(name, state);
  `,
  // The harness a lease was claimed on (docs/design/agent-runtimes.md D9): the phase 1 process-producer cap counts
  // leases by it, not by the current config. Older rows stay NULL and count as claude.
  7: `
    ALTER TABLE leases ADD COLUMN harness TEXT;
  `,
  // Change requests (docs/design/host-manager.md, task-53.3): setup changes the coordinator proposes from the
  // runtime (settings set, settings restart, upgrade). A row is a claim, never an authorization: the host
  // re-validates it against its own config and applies only after the owner confirms the host-computed plan.
  8: `
    CREATE TABLE IF NOT EXISTS change_requests (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
      status TEXT NOT NULL, updated_at TEXT NOT NULL, detail TEXT);
    CREATE INDEX IF NOT EXISTS change_requests_status ON change_requests(status, created_at);
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

/** busy_timeout for every connection, and the time budget for retrying the WAL switch. */
const BUSY_TIMEOUT_MS = 5000;
/** SQLITE_BUSY (primary result code 5, any extended code) as thrown by node:sqlite. */
const isBusy = (e: unknown): boolean => {
  const code = (e as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && (code & 0xff) === 5;
};
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Whether a process with this pid exists (EPERM: exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * `start`: the holder's process start time (/proc/<pid>/stat field 22, clock ticks since boot) when it
 * could be read. With it a reused pid (a tmux client, `minions coordinator sync`) is never the holder.
 */
export interface CoordinatorLock { pid: number; session: string; acquiredAt: string; start?: string }

/** A durable drain request (`minions pause --starts --drain`): workers wind down to a checkpoint and return partial. */
export interface DrainRequest { reason: string; requestedAt: string; eventId: number }
/**
 * How the drain hook tied a delivered notice to a lease: `only` (the single active lease of the role),
 * `transcript` (the lease marker in the subagent's own transcript), `role` (fallback: every active lease
 * of the role, when neither identifies it).
 */
export type DrainNoticeVia = 'only' | 'transcript' | 'role';
/** A `drain-notice` event: the drain hook delivered the notice of drain `eventId` to a worker under `leaseId`. */
export interface DrainNotice { id: number; at: string; taskId: string | null; leaseId: string; eventId: number; agentId: string; agentType: string; tool: string; via: DrainNoticeVia }
type EventRow = { id: number; at: string; task_id: string | null; data_json: string | null };
const drainNoticeOf = (r: EventRow): DrainNotice[] => {
  let d: Record<string, unknown> | null = null;
  try { d = r.data_json ? JSON.parse(r.data_json) as Record<string, unknown> : null; } catch { /* not a notice payload */ }
  if (!d || typeof d.leaseId !== 'string' || typeof d.eventId !== 'number') return [];
  const via = d.via === 'only' || d.via === 'transcript' ? d.via : 'role';
  return [{ id: r.id, at: r.at, taskId: r.task_id, leaseId: d.leaseId, eventId: d.eventId, agentId: String(d.agentId ?? ''), agentType: String(d.agentType ?? ''), tool: String(d.tool ?? ''), via }];
};

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
    this.sql.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    if (path !== ':memory:') this.enableWal();
    this.sql.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  /**
   * Switches the database to WAL. The switch needs an exclusive lock and SQLite returns SQLITE_BUSY for it
   * at once, without calling the busy handler, so concurrent first opens of a fresh database failed with
   * "database is locked" (task-20.3). Retry with a short bounded backoff, then require WAL or fail loudly.
   * On a database already in WAL the pragma is a no-op that takes no write lock.
   */
  private enableWal(): void {
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    let delay = 5;
    let last = '';
    for (;;) {
      try {
        const mode = (this.sql.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode?: unknown } | undefined)?.journal_mode;
        if (String(mode).toLowerCase() === 'wal') return;
        last = `journal_mode is ${String(mode)}`;
      } catch (e) {
        if (!isBusy(e)) { this.sql.close(); throw e; }
        last = (e as Error).message;
      }
      if (Date.now() >= deadline) {
        this.sql.close();
        throw new MinionsError('INTERNAL', `Cannot switch runtime database ${this.path} to WAL mode: ${last}`,
          'Another process kept the database locked; retry, and check for a stuck minions process.');
      }
      sleepSync(Math.max(1, Math.min(delay + Math.floor(Math.random() * delay), deadline - Date.now())));
      delay = Math.min(delay * 2, 100);
    }
  }

  /**
   * Brings the schema up to date. An already-current database is checked with plain reads only: taking
   * the write lock (`BEGIN IMMEDIATE`) on every open made each read-mostly caller (state backup, status,
   * hooks) contend with live writers, and SQLite's busy handler is not fair (it sleeps and polls), so a
   * busy writer could starve an opener past busy_timeout and fail it with "database is locked" (task-20.2).
   */
  private migrate(): void {
    const tooNew = (current: number) => new MinionsError('INCOMPATIBLE_RUNTIME',
      `Runtime database schema ${current} is newer than this build supports (${SCHEMA_VERSION}).`,
      'Upgrade minions; do not downgrade a running installation.');
    if (this.schemaCurrent(tooNew)) return;
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.transaction(() => {
      const current = Number(this.getMeta('schema_version') ?? 0);
      if (current > SCHEMA_VERSION) throw tooNew(current);
      for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
        this.sql.exec(MIGRATIONS[v]!);
        this.setMeta('schema_version', String(v));
      }
      this.sql.prepare('INSERT OR IGNORE INTO guard (id, count) VALUES (1, 0)').run();
    });
  }

  /** Read-only check in one read snapshot (no write lock): schema at SCHEMA_VERSION and the guard row present. Throws when newer. */
  private schemaCurrent(tooNew: (current: number) => MinionsError): boolean {
    this.sql.exec('BEGIN DEFERRED');
    try {
      const tables = new Set((this.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'guard')").all() as { name: string }[]).map((r) => r.name));
      if (!tables.has('meta')) return false;
      const current = Number(this.getMeta('schema_version') ?? 0);
      if (current > SCHEMA_VERSION) throw tooNew(current);
      return current === SCHEMA_VERSION && tables.has('guard') && this.sql.prepare('SELECT 1 FROM guard WHERE id = 1').get() !== undefined;
    } finally {
      this.sql.exec('COMMIT');
    }
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

  // Drain request (controls row `drain`; the flag file is kept in step by src/runtime/drain.ts)
  drain(): DrainRequest | null {
    const v = this.getControl('drain');
    if (!v) return null;
    try { return JSON.parse(v) as DrainRequest; } catch { return null; }
  }
  /** Records a drain request; an active one is kept as is (same eventId), so a repeated request is a no-op. */
  setDrain(reason: string): DrainRequest {
    return this.transaction(() => {
      const cur = this.drain();
      if (cur) return cur;
      const requestedAt = nowIso();
      const eventId = this.addEvent('drain-request', null, { reason, requestedAt });
      const d: DrainRequest = { reason, requestedAt, eventId };
      this.setControl('drain', JSON.stringify(d));
      return d;
    });
  }
  /** Clears the drain request; returns the cleared one (null when none was active). */
  clearDrain(by: string): DrainRequest | null {
    return this.transaction(() => {
      const cur = this.drain();
      if (!cur) return null;
      this.exec("DELETE FROM controls WHERE key = 'drain'");
      this.exec("DELETE FROM meta WHERE key LIKE 'drain_hits:%'");
      this.addEvent('drain-cleared', null, { by, eventId: cur.eventId });
      return cur;
    });
  }
  /**
   * Records that the drain hook delivered the notice of the active drain `eventId` to a worker under
   * `lease` (task-3.10). The hook writes it only on an agent's first call of a drain, never per call.
   */
  recordDrainNotice(lease: { id: string; task_id: string }, n: { eventId: number; agentId: string; agentType: string; tool: string; via: DrainNoticeVia }): number {
    return this.addEvent('drain-notice', lease.task_id, { leaseId: lease.id, eventId: n.eventId, agentId: n.agentId, agentType: n.agentType, tool: n.tool, via: n.via });
  }
  /**
   * Whether this lease received the notice of a drain that was active when it was delivered: a
   * `drain-notice` event for the lease naming a recorded `drain-request`. A drain the lease merely
   * spanned (requested and cleared between two of its tool calls) never reached it and does not count.
   */
  drainNoticeReceived(lease: { id: string; task_id: string }): boolean {
    return this.drainNotices(lease.task_id).some((n) => n.leaseId === lease.id &&
      !!this.get<{ id: number }>("SELECT id FROM events WHERE id = ? AND kind = 'drain-request'", n.eventId));
  }
  /** The `drain-notice` events of a task, oldest first. */
  drainNotices(taskId: string): DrainNotice[] {
    return this.all<EventRow>("SELECT id, at, task_id, data_json FROM events WHERE kind = 'drain-notice' AND task_id = ? ORDER BY id", taskId).flatMap(drainNoticeOf);
  }
  /** The most recent delivered drain notice of any lease (`minions status`: shows the hook fired in a subagent). */
  lastDrainNotice(): DrainNotice | null {
    const r = this.get<EventRow>("SELECT id, at, task_id, data_json FROM events WHERE kind = 'drain-notice' ORDER BY id DESC LIMIT 1");
    return r ? drainNoticeOf(r)[0] ?? null : null;
  }
  /** Counts one drain-hook hit for a worker (per drain request); returns the new count. */
  drainHit(eventId: number, worker: string): number {
    return this.transaction(() => {
      const key = `drain_hits:${eventId}:${worker}`;
      const n = Number(this.getMeta(key) ?? 0) + 1;
      this.setMeta(key, String(n));
      return n;
    });
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

  /** Every row of one kind for a task, any head, oldest first (e.g. the merge arm/disarm history). */
  evidenceOfKind(taskId: string, kind: string): EvidenceRow[] {
    return this.all<EvidenceRow>('SELECT * FROM evidence WHERE task_id = ? AND kind = ? ORDER BY recorded_at, rowid', taskId, kind);
  }

  // Repairs
  repairCycles(taskId: string): number { return this.get<{ cycles: number }>('SELECT cycles FROM repairs WHERE task_id = ?', taskId)?.cycles ?? 0; }
  incrementRepairs(taskId: string): number {
    this.exec('INSERT INTO repairs (task_id, cycles) VALUES (?, 1) ON CONFLICT(task_id) DO UPDATE SET cycles = cycles + 1', taskId);
    return this.repairCycles(taskId);
  }

  // Workflow position (task_stages)
  taskStage(taskId: string): TaskStageRow | undefined { return this.get<TaskStageRow>('SELECT * FROM task_stages WHERE task_id = ?', taskId); }
  setTaskStage(taskId: string, workflow: string, stages: unknown[], position: number): void {
    this.exec(`INSERT INTO task_stages (task_id, workflow, stages_json, position, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET workflow = excluded.workflow, stages_json = excluded.stages_json, position = excluded.position, updated_at = excluded.updated_at`,
      taskId, workflow, JSON.stringify(stages), position, nowIso());
  }

  // Role proposals (D2)
  roleProposal(id: string): RoleProposalRow | undefined { return this.get<RoleProposalRow>('SELECT * FROM role_proposals WHERE id = ?', id); }
  /** Pending proposals (all: every state), oldest first. */
  roleProposals(opts: { all?: boolean } = {}): RoleProposalRow[] {
    return opts.all
      ? this.all<RoleProposalRow>('SELECT * FROM role_proposals ORDER BY created_at, id')
      : this.all<RoleProposalRow>("SELECT * FROM role_proposals WHERE state = 'pending' ORDER BY created_at, id");
  }
  /** Stores a pending proposal; earlier pending proposals for the same role name become `superseded`. */
  addRoleProposal(p: { id: string; name: string; json: string }): { row: RoleProposalRow; superseded: string[] } {
    return this.transaction(() => {
      const at = nowIso();
      const superseded = this.all<{ id: string }>("SELECT id FROM role_proposals WHERE name = ? AND state = 'pending'", p.name).map((r) => r.id);
      this.exec("UPDATE role_proposals SET state = 'superseded', updated_at = ? WHERE name = ? AND state = 'pending'", at, p.name);
      this.exec("INSERT INTO role_proposals (id, name, json, created_at, state, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)", p.id, p.name, p.json, at, at);
      this.addEvent('role-proposed', null, { id: p.id, name: p.name, superseded });
      return { row: this.roleProposal(p.id)!, superseded };
    });
  }
  /** pending -> applied (idempotent for an applied row); false when the proposal is missing or superseded. */
  markRoleProposalApplied(id: string, revision: number | null): boolean {
    return this.transaction(() => {
      const row = this.roleProposal(id);
      if (!row || row.state === 'superseded') return false;
      if (row.state === 'applied') return true;
      this.exec("UPDATE role_proposals SET state = 'applied', applied_revision = ?, updated_at = ? WHERE id = ?", revision, nowIso(), id);
      this.addEvent('role-applied', null, { id, name: row.name, revision });
      return true;
    });
  }

  // Change requests (docs/design/host-manager.md)
  changeRequest(id: string): ChangeRequestRow | undefined { return this.get<ChangeRequestRow>('SELECT * FROM change_requests WHERE id = ?', id); }
  /** Open requests (proposed, confirmed, failed: the owner may retry or reject a failed one); all: every status. Oldest first. */
  changeRequests(opts: { all?: boolean } = {}): ChangeRequestRow[] {
    return opts.all
      ? this.all<ChangeRequestRow>('SELECT * FROM change_requests ORDER BY created_at, id')
      : this.all<ChangeRequestRow>("SELECT * FROM change_requests WHERE status IN ('proposed', 'confirmed', 'failed') ORDER BY created_at, id");
  }
  /**
   * Stores a proposed request. Earlier open requests (proposed or failed) for the same thing (the same kind; for
   * config-set the same key) become `expired`: the newer request replaces them.
   */
  addChangeRequest(r: { id: string; kind: ChangeRequestKind; payload: Record<string, unknown>; reason: string | null }): { row: ChangeRequestRow; expired: string[] } {
    return this.transaction(() => {
      const at = nowIso();
      const keyOf = (payload: string): unknown => { try { return (JSON.parse(payload) as { key?: unknown }).key; } catch { return undefined; } };
      const expired = this.all<{ id: string; payload: string }>("SELECT id, payload FROM change_requests WHERE kind = ? AND status IN ('proposed', 'failed')", r.kind)
        .filter((x) => r.kind !== 'config-set' || keyOf(x.payload) === r.payload.key).map((x) => x.id);
      for (const id of expired) this.exec("UPDATE change_requests SET status = 'expired', detail = ?, updated_at = ? WHERE id = ?", `superseded by ${r.id}`, at, id);
      this.exec("INSERT INTO change_requests (id, kind, payload, reason, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?)",
        r.id, r.kind, JSON.stringify(r.payload), r.reason, at, at);
      this.addEvent('change-requested', null, { id: r.id, kind: r.kind, expired });
      return { row: this.changeRequest(r.id)!, expired };
    });
  }
  /**
   * Moves a request to a new status (the host reports its outcome). Allowed: proposed or failed -> confirmed, applied,
   * failed, rejected or expired; confirmed -> applied or failed; the same status again is a no-op. applied, rejected
   * and expired are final. Throws NOT_FOUND / CONFLICT.
   */
  setChangeRequestStatus(id: string, status: ChangeRequestStatus, detail: string | null = null): ChangeRequestRow {
    return this.transaction(() => {
      const row = this.changeRequest(id);
      if (!row) throw new MinionsError('NOT_FOUND', `No change request ${id}.`, 'List requests with `minions settings requests --all`.');
      if (row.status === status) return row;
      const open = row.status === 'proposed' || row.status === 'failed';
      const ok = (open && status !== 'proposed') || (row.status === 'confirmed' && (status === 'applied' || status === 'failed'));
      if (!ok) throw new MinionsError('CONFLICT', `Change request ${id} is ${row.status}; it cannot become ${status}.`, 'List requests with `minions settings requests --all`.');
      this.exec('UPDATE change_requests SET status = ?, detail = ?, updated_at = ? WHERE id = ?', status, detail, nowIso(), id);
      this.addEvent('change-request', null, { id, from: row.status, to: status });
      return this.changeRequest(id)!;
    });
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
   * same pid+session and process start time. A holder that is not `alive` (crashed wrapper, reused pid)
   * is taken over. Same pid and session but a different recorded start time (both known) is a reused
   * pid, i.e. a new holder: it gets a fresh `acquiredAt` and a `coordinator-lock` event, so a restart
   * watching (pid, acquiredAt) sees the handover (task-40). No live process can share our pid, so no
   * liveness check is needed for it.
   */
  acquireCoordinatorLock(session: string, pid = process.pid, alive: (pid: number, lock?: CoordinatorLock) => boolean = pidAlive, start?: string | null): CoordinatorLock {
    return this.transaction(() => {
      const cur = this.coordinatorLock();
      const samePid = !!cur && cur.pid === pid && cur.session === session;
      const reentrant = samePid && !(cur!.start && start && cur!.start !== start);
      if (cur && !samePid && alive(cur.pid, cur)) {
        throw new MinionsError('CONFLICT', `Another coordinator holds the project lock (pid ${cur.pid}, session ${cur.session}, since ${cur.acquiredAt}).`,
          'Attach to the existing coordinator (minions start) instead of launching a second one.', cur);
      }
      const lock: CoordinatorLock = { pid, session, acquiredAt: reentrant ? cur!.acquiredAt : nowIso(), ...(start ? { start } : {}) };
      this.setMeta('coordinator_lock', JSON.stringify(lock));
      if (!reentrant) this.addEvent('coordinator-lock', null, { ...lock, replaced: cur ?? null });
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
