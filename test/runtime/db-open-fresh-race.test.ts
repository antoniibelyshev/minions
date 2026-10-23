// task-20.3: several processes opening a brand-new runtime DB at the same moment failed with
// "database is locked" at `PRAGMA journal_mode = WAL`: the switch to WAL needs an exclusive lock and
// SQLite returns SQLITE_BUSY for it at once, without calling the busy handler. RuntimeDb now retries the
// switch with a bounded backoff and fails loudly when the database is still not in WAL afterwards.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { tmp } from './fixtures.js';

const repo = resolve(__dirname, '..', '..');
const PROCS = 6;
const ROUNDS = 10;
let bundle: string;

beforeAll(async () => {
  const root = tmp('minions-fresh-race-');
  const entry = join(root, 'entry.ts');
  // Each child spins until the shared start time, so all of them open the fresh DB at the same moment.
  writeFileSync(entry, `
import { RuntimeDb } from ${JSON.stringify(join(repo, 'src/runtime/db.ts'))};
const [path, at] = [process.argv[2]!, Number(process.argv[3])];
while (Date.now() < at) { /* barrier */ }
try { new RuntimeDb(path).close(); process.stdout.write('ok'); }
catch (e) { process.stdout.write('ERR ' + (e as Error).message); }
`);
  bundle = join(root, 'open.mjs');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['node:*'], logLevel: 'silent' });
}, 30_000);

function run(child: ChildProcess): Promise<string> {
  let out = '';
  child.stdout!.on('data', (d) => { out += String(d); });
  let err = '';
  child.stderr!.on('data', (d) => { err += String(d); });
  return new Promise((res, rej) => {
    child.once('error', rej);
    child.once('exit', () => res(out.trim() === 'ok' ? 'ok' : `${out.trim()} ${err.trim()}`.trim()));
  });
}

/** A separate process that opens path in rollback-journal mode and holds a read (SHARED) lock for holdMs. */
async function holdSharedLock(path: string, holdMs: number): Promise<{ done: Promise<void> }> {
  const child = spawn(process.execPath, ['-e', `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('CREATE TABLE IF NOT EXISTS pin (x)');
    db.exec('BEGIN'); db.prepare('SELECT count(*) FROM pin').get();
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, ${holdMs});
  `, path], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((res, rej) => {
    child.stdout!.once('data', () => res());
    child.once('error', rej);
    child.once('exit', (code) => rej(new Error(`lock holder exited early (code ${code})`)));
  });
  return { done: new Promise((res) => child.once('exit', () => res())) };
}

describe('runtime DB: concurrent first opens of a fresh database', () => {
  it(`${PROCS} processes opening the same fresh DB at once all succeed, over ${ROUNDS} rounds`, async () => {
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const dir = tmp('minions-fresh-race-db-');
      mkdirSync(dir, { recursive: true });
      const db = join(dir, 'runtime.db');
      const at = Date.now() + 400; // leaves time for every child to start before the barrier
      const outs = await Promise.all(Array.from({ length: PROCS }, () =>
        run(spawn(process.execPath, [bundle, db, String(at)], { stdio: ['ignore', 'pipe', 'pipe'] }))));
      failures.push(...outs.filter((o) => o !== 'ok').map((o) => `round ${round}: ${o}`));
      const check = new DatabaseSync(db);
      try {
        expect(check.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
        expect(check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: String(SCHEMA_VERSION) });
        expect(check.prepare('SELECT count(*) AS c FROM guard').get()).toEqual({ c: 1 });
      } finally { check.close(); }
    }
    // Before the fix a large share of these opens failed with "database is locked".
    expect(failures).toEqual([]);
  }, 120_000);

  it('waits out a brief lock another process holds on the fresh DB', async () => {
    const db = join(tmp('minions-fresh-held-'), 'runtime.db');
    const holder = await holdSharedLock(db, 600);
    const started = Date.now();
    const d = openDb(db);
    try {
      expect(Date.now() - started).toBeGreaterThanOrEqual(300); // it waited for the holder instead of failing
      expect(d.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
      expect(d.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    } finally { d.close(); }
    await holder.done;
  }, 30_000);

  it('fails loudly when the DB cannot be switched to WAL within the retry budget', async () => {
    const db = join(tmp('minions-fresh-stuck-'), 'runtime.db');
    const holder = await holdSharedLock(db, 8000);
    const started = Date.now();
    expect(() => openDb(db)).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('WAL mode') }));
    expect(Date.now() - started).toBeLessThan(7000); // bounded by the 5 s budget
    await holder.done;
  }, 30_000);
});
