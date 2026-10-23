// task-20.2 QA: the read-only "schema current" fast path must not skip real migrations.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { tmp } from './fixtures.js';

const paths = (root: string) => runtimePaths({ MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_WORKSPACE: join(root, 'ws') } as NodeJS.ProcessEnv, { inContainer: false });

describe('runtime DB upgrade from an older schema', () => {
  it('migrates a schema_version 3 DB (no outbox/task_stages/role_proposals) and keeps its data', () => {
    const p = paths(tmp('minions-open-upgrade-'));
    openDb(p.db).close();
    const raw = new DatabaseSync(p.db);
    raw.exec("INSERT INTO events (kind, task_id, data_json, at) VALUES ('keep', NULL, NULL, 'now')");
    raw.exec('DROP TABLE outbox; DROP TABLE task_stages; DROP INDEX role_proposals_name; DROP TABLE role_proposals');
    raw.exec("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
    raw.close();
    const db = openDb(p.db);
    try {
      expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
      for (const t of ['outbox', 'task_stages', 'role_proposals']) expect(db.get(`SELECT count(*) AS c FROM ${t}`)).toEqual({ c: 0 });
      expect(db.get<{ c: number }>("SELECT count(*) AS c FROM events WHERE kind = 'keep'")!.c).toBe(1);
    } finally { db.close(); }
  });

  it('migrates a DB with a meta table but no schema_version row', () => {
    const p = paths(tmp('minions-open-nometa-'));
    mkdirSync(dirname(p.db), { recursive: true });
    const raw = new DatabaseSync(p.db);
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.close();
    const db = openDb(p.db);
    try { expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION)); } finally { db.close(); }
  });
});
