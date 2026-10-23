// task-20.2: opening an already-current runtime DB must not take the write lock. It used to run
// `BEGIN IMMEDIATE` in migrate() on every open, so a state backup (or any reader) opened while another
// process kept committing could starve past busy_timeout and fail with "database is locked".
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { createStateBackup } from '../../src/runtime/state-backup.js';
import { tmp } from './fixtures.js';

const paths = (root: string) => runtimePaths({ MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_WORKSPACE: join(root, 'ws') } as NodeJS.ProcessEnv, { inContainer: false });

/** Runs fn while a second connection holds the write lock (BEGIN IMMEDIATE) on dbPath. */
async function withWriteLockHeld<T>(dbPath: string, fn: () => Promise<T> | T): Promise<T> {
  const other = new DatabaseSync(dbPath);
  other.exec('BEGIN IMMEDIATE');
  other.exec("INSERT INTO events (kind, task_id, data_json, at) VALUES ('held', NULL, NULL, 'now')");
  try { return await fn(); } finally { other.exec('ROLLBACK'); other.close(); }
}

describe('runtime DB open under a held write lock', () => {
  it('opens an already-current DB with reads only, without waiting for the writer', async () => {
    const p = paths(tmp('minions-open-'));
    openDb(p.db).close();
    await withWriteLockHeld(p.db, () => {
      const started = Date.now();
      const db = openDb(p.db);
      try {
        expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
        expect(db.guard().count).toBe(0);
      } finally { db.close(); }
      // Before the fix this blocked for the whole busy_timeout (5 s) and then threw "database is locked".
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  it('takes a state backup (VACUUM INTO) while another connection holds the write lock', async () => {
    const p = paths(tmp('minions-open-backup-'));
    openDb(p.db).close();
    const out = join(tmp('minions-open-backup-out-'), 'state.tar.gz');
    const res = await withWriteLockHeld(p.db, () => createStateBackup(p, out));
    expect(res.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('still takes the migration path for a fresh DB and for a missing guard row', () => {
    const p = paths(tmp('minions-open-migrate-'));
    openDb(p.db).close();
    const raw = new DatabaseSync(p.db);
    raw.exec('DELETE FROM guard');
    raw.close();
    const db = openDb(p.db);
    try {
      expect(db.get<{ c: number }>('SELECT count(*) AS c FROM guard WHERE id = 1')!.c).toBe(1);
    } finally { db.close(); }

    const fresh = paths(tmp('minions-open-fresh-'));
    const f = openDb(fresh.db);
    try { expect(f.getMeta('schema_version')).toBe(String(SCHEMA_VERSION)); } finally { f.close(); }
  });

  it('rejects a newer schema without needing the write lock', async () => {
    const p = paths(tmp('minions-open-newer-'));
    openDb(p.db).close();
    const raw = new DatabaseSync(p.db);
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    raw.close();
    await withWriteLockHeld(p.db, () => {
      const started = Date.now();
      expect(() => openDb(p.db)).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RUNTIME' }));
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
