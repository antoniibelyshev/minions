// task-14.11 QA: upgrade paths for schema 7 (leases.harness): concurrent v6 opens, v6 backup restore, newer-schema refusal.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { createStateBackup, parseStateBackup, readTar, restoreStateBackup, writeTar } from '../../src/runtime/state-backup.js';
import { tmp } from './fixtures.js';

const paths = (root: string) => runtimePaths({ MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_WORKSPACE: join(root, 'ws') } as NodeJS.ProcessEnv, { inContainer: false });
const LEASE = "INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('lease-a', 'task-1', 'engineer', 1, 3, '2026-10-23T00:00:00Z', 'active')";

/** A genuine v6 database: current schema minus leases.harness, version 6, one active lease. */
function makeV6(dbPath: string): void {
  openDb(dbPath).close();
  const raw = new DatabaseSync(dbPath);
  raw.exec('ALTER TABLE leases DROP COLUMN harness');
  raw.exec(LEASE);
  raw.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.close();
}

describe('schema 7 upgrade (task-14.11 QA)', () => {
  it('concurrent opens of a v6 DB in separate processes all succeed and leave one intact v7 DB', async () => {
    const p = paths(tmp('minions-v6-conc-'));
    makeV6(p.db);
    const dir = tmp('minions-v6-script-');
    const bundle = join(dir, 'open.mjs');
    const entry = join(dir, 'entry.ts');
    writeFileSync(entry, `import { openDb } from ${JSON.stringify(join(process.cwd(), 'src/runtime/db.ts'))}; openDb(process.argv[2]!).close();`);
    const built = spawnSync(join(process.cwd(), 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=esm', '--external:node:*', `--outfile=${bundle}`], { encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    const kids = Array.from({ length: 6 }, () => new Promise<{ code: number | null; err: string }>((res) => {
      const c = spawn(process.execPath, [bundle, p.db], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => { err += String(d); });
      c.on('close', (code) => res({ code, err }));
    }));
    for (const r of await Promise.all(kids)) expect(r.code, r.err).toBe(0);
    const db = openDb(p.db);
    try {
      expect(db.getMeta('schema_version')).toBe('7');
      expect(db.activeLeases()).toHaveLength(1);
      expect(db.activeLeases()[0]).toMatchObject({ id: 'lease-a', harness: null });
      expect(db.get<{ c: number }>("SELECT count(*) AS c FROM pragma_table_info('leases') WHERE name = 'harness'")!.c).toBe(1);
      expect(db.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check).toBe('ok');
    } finally { db.close(); }
  }, 60000);

  it('a backup taken at v6 restores on v7 and migrates on open, keeping the lease', async () => {
    const src = paths(tmp('minions-v6-src-'));
    openDb(src.db).close();
    const file = join(tmp('minions-v6-out-'), 'state.tar.gz');
    await createStateBackup(src, file);
    // createStateBackup migrates its source first, so hand-build the v6 archive: swap in a v6 DB and fix the manifest.
    const v6p = paths(tmp('minions-v6-db-'));
    makeV6(v6p.db);
    const v6db = readFileSync(v6p.db);
    const entries = readTar(gunzipSync(readFileSync(file))).map((e) => {
      if (e.path === 'minions.db') return { ...e, data: v6db };
      if (e.path === 'manifest.json') {
        const m = JSON.parse(e.data.toString());
        m.schemaVersion = 6;
        const row = m.files.find((x: { path: string }) => x.path === 'minions.db');
        row.size = v6db.length; row.sha256 = createHash('sha256').update(v6db).digest('hex');
        return { ...e, data: Buffer.from(JSON.stringify(m)) };
      }
      return e;
    });
    writeFileSync(file, gzipSync(writeTar(entries)));
    expect(parseStateBackup(readFileSync(file)).manifest.schemaVersion).toBe(6);
    const dst = paths(tmp('minions-v6-dst-'));
    await restoreStateBackup(dst, file, { alive: () => false });
    const db = openDb(dst.db);
    try {
      expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
      expect(db.activeLeases()[0]).toMatchObject({ id: 'lease-a', harness: null });
    } finally { db.close(); }
  });

  it('a v7 backup records schemaVersion 7; a build that knows only older schemas refuses a newer one (INCOMPATIBLE_RUNTIME)', async () => {
    const src = paths(tmp('minions-v7-src-'));
    openDb(src.db).close();
    const file = join(tmp('minions-v7-out-'), 'state.tar.gz');
    expect((await createStateBackup(src, file)).schemaVersion).toBe(7);
    // Emulate older code by forging schema SCHEMA_VERSION+1: the same `schemaVersion > known` check an older build applies to 7.
    const entries = readTar(gunzipSync(readFileSync(file))).map((e) => e.path === 'manifest.json'
      ? { ...e, data: Buffer.from(JSON.stringify({ ...JSON.parse(e.data.toString()), schemaVersion: SCHEMA_VERSION + 1 })) } : e);
    expect(() => parseStateBackup(gzipSync(writeTar(entries)))).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RUNTIME' }));
  });

  it('a DB newer than the build knows is refused untouched (what older code does with a v7 DB)', () => {
    const p = paths(tmp('minions-vnew-'));
    openDb(p.db).close();
    const raw = new DatabaseSync(p.db);
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    raw.close();
    expect(() => openDb(p.db)).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RUNTIME' }));
    const after = new DatabaseSync(p.db);
    expect((after.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe(String(SCHEMA_VERSION + 1));
    after.close();
  });
});
