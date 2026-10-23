// QA (task-20): restore hardening beyond the engineer's cases: hand-crafted tar headers (hard links,
// devices, GNU long names, PAX path overrides), path spellings, manifest order, a failure while
// staging, rollback when the swap fails midway, and a DB snapshot taken while another process writes.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { createStateBackup, parseStateBackup, readTar, restoreStateBackup, writeTar, type StateManifest, type TarEntry } from '../../src/runtime/state-backup.js';
import { tmp } from './fixtures.js';

const paths = (root: string) => runtimePaths({ MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_WORKSPACE: join(root, 'ws') } as NodeJS.ProcessEnv, { inContainer: false });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function put(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) Object.assign(out, tree(f, base), { [`${f.slice(base.length + 1)}/`]: '' });
    else out[f.slice(base.length + 1)] = readFileSync(f).toString('base64');
  }
  return out;
}

async function backupFile(): Promise<{ file: string; entries: TarEntry[] }> {
  const root = tmp('minions-qa-src-');
  const p = paths(root);
  put(join(p.backlog, 'backlog', 'tasks', 'task-1 - One.md'), '---\nid: task-1\n---\n');
  put(join(p.notes, 'memo.md'), 'memo\n');
  openDb(p.db).close();
  const file = join(tmp('minions-qa-out-'), 'state.tar.gz');
  await createStateBackup(p, file);
  return { file, entries: readTar(gunzipSync(readFileSync(file))) };
}

function target(): { p: ReturnType<typeof paths> } {
  const p = paths(tmp('minions-qa-dst-'));
  openDb(p.db).close();
  put(join(p.notes, 'current.md'), 'current\n');
  put(join(p.results, 'r.json'), '{}\n');
  return { p };
}

/** A raw ustar header with any type flag and link name (the module's writer only emits '0', '5', 'x'). */
function rawHeader(name: string, size: number, type: string, link = ''): Buffer {
  const h = Buffer.alloc(512);
  const oct = (off: number, len: number, v: number) => h.write(v.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
  h.write(name, 0, 100); oct(100, 8, 0o644); oct(108, 8, 0); oct(116, 8, 0); oct(124, 12, size); oct(136, 12, 1_700_000_000);
  h.fill(' ', 148, 156); h.write(type, 156, 1); h.write(link, 157, 100); h.write('ustar\0', 257); h.write('00', 263);
  let s = 0; for (const b of h) s += b;
  h.write(s.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}
const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);

/** The valid archive's entries (without the end marker) followed by raw blocks, re-gzipped. */
function withRaw(entries: TarEntry[], raw: Buffer[]): string {
  const body = writeTar(entries);
  const f = join(tmp('minions-qa-bad-'), 'bad.tar.gz');
  writeFileSync(f, gzipSync(Buffer.concat([body.subarray(0, body.length - 1024), ...raw, Buffer.alloc(1024)])));
  return f;
}

function addListed(entries: TarEntry[], extra: TarEntry[]): TarEntry[] {
  const m = JSON.parse(entries[0]!.data.toString()) as StateManifest;
  for (const e of extra) if (e.type === 'file') m.files.push({ path: e.path, size: e.data.length, sha256: sha(e.data) });
  return [{ ...entries[0]!, data: Buffer.from(JSON.stringify(m)) }, ...entries.slice(1), ...extra];
}

async function expectUntouched(file: string, code: string | RegExp, message: RegExp): Promise<void> {
  const { p } = target();
  const before = tree(p.state);
  const err = await restoreStateBackup(p, file, { alive: () => false }).then(() => null, (e: unknown) => e as { code: string; message: string });
  expect(err).not.toBeNull();
  if (typeof code === 'string') expect(err!.code).toBe(code); else expect(err!.code).toMatch(code);
  expect(err!.message).toMatch(message);
  expect(tree(p.state)).toEqual(before);
  expect(readdirSync(p.state).filter((n) => n.startsWith('.restore-staging-'))).toEqual([]);
}

describe('state restore: crafted tar headers', () => {
  it('refuses hard-link, character-device and GNU long-name entries', async () => {
    const { entries } = await backupFile();
    await expectUntouched(withRaw(entries, [rawHeader('notes/hl', 0, '1', 'minions.db')]), 'PRECONDITION', /unsupported type "1"/);
    await expectUntouched(withRaw(entries, [rawHeader('notes/dev', 0, '3')]), 'PRECONDITION', /unsupported type "3"/);
    const long = Buffer.from(`notes/${'g'.repeat(150)}\0`);
    await expectUntouched(withRaw(entries, [rawHeader('././@LongLink', long.length, 'L'), long, pad(long.length)]), 'PRECONDITION', /unsupported type "L"/);
  });

  it('applies the path checks to a PAX path override, not to the innocent ustar name', async () => {
    const { entries } = await backupFile();
    const data = Buffer.from('x');
    const listed = addListed(entries, []);
    const m = JSON.parse(listed[0]!.data.toString()) as StateManifest;
    m.files.push({ path: '../../pax-escaped.txt', size: 1, sha256: sha(data) });
    const es = [{ ...listed[0]!, data: Buffer.from(JSON.stringify(m)) }, ...listed.slice(1)];
    const rec = Buffer.from('30 path=../../pax-escaped.txt\n');
    const f = withRaw(es, [rawHeader('PaxHeaders/x', rec.length, 'x'), rec, pad(rec.length), rawHeader('notes/ok.txt', 1, '0'), data, pad(1)]);
    await expectUntouched(f, 'PRECONDITION', /"\.\.\/\.\.\/pax-escaped\.txt" is outside the allowed state paths/);
  });

  it('refuses backslash, empty and "." path segments', async () => {
    for (const path of ['notes\\..\\..\\bs', 'notes//double', 'notes/./dot', 'notes/']) {
      const { entries } = await backupFile();
      const f = join(tmp('minions-qa-bad-'), 'bad.tar.gz');
      writeFileSync(f, gzipSync(writeTar(addListed(entries, [{ path, type: 'file', data: Buffer.from('x'), mode: 0o644 }]))));
      await expectUntouched(f, 'PRECONDITION', /outside the allowed state paths|not in the manifest|listed in the manifest/);
    }
  });

  it('requires manifest.json to be the first entry', async () => {
    const { entries } = await backupFile();
    const f = join(tmp('minions-qa-bad-'), 'bad.tar.gz');
    writeFileSync(f, gzipSync(writeTar([entries[1]!, entries[0]!, ...entries.slice(2)])));
    await expectUntouched(f, 'PRECONDITION', /manifest\.json is not the first entry/);
  });

  it('a file/directory clash fails while staging and leaves the state and no staging dir behind', async () => {
    const { entries } = await backupFile();
    const f = join(tmp('minions-qa-bad-'), 'bad.tar.gz');
    writeFileSync(f, gzipSync(writeTar(addListed(entries, [{ path: 'notes/memo.md/child', type: 'file', data: Buffer.from('x'), mode: 0o644 }]))));
    // The raw fs error (EEXIST/ENOTDIR) is mapped to a clear PRECONDITION naming the entry; nothing changed.
    await expectUntouched(f, 'PRECONDITION', /not a valid minions state backup: entry "notes\/memo\.md\/child" clashes with another entry/i);
  });

  it('the archive is readable by the system tar (plain ustar + gzip)', async (ctx) => {
    let tarOk = true;
    try { execFileSync('tar', ['--version'], { stdio: 'ignore' }); } catch { tarOk = false; }
    if (!tarOk) ctx.skip();
    const { file } = await backupFile();
    const names = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
    expect(names[0]).toBe('manifest.json');
    expect(names).toContain('minions.db');
    expect(names).toContain('notes/memo.md');
  });
});

describe('state restore: rollback', () => {
  it('moves the previous state back when the swap fails midway', async (ctx) => {
    if (process.getuid?.() === 0) ctx.skip(); // root ignores the directory permission that induces the failure
    const { file } = await backupFile();
    const { p } = target();
    const before = tree(p.state);
    // Renaming a directory to another parent needs write permission on it: backlog, notes and briefs
    // move out, then results fails.
    chmodSync(p.results, 0o555);
    try {
      const err = await restoreStateBackup(p, file, { alive: () => false }).then(() => null, (e: unknown) => e as { code: string; message: string; hint?: string });
      expect(err).toMatchObject({ code: 'INTERNAL' });
      expect(err!.message).toMatch(/while swapping files/);
      expect(err!.hint).toMatch(/moved back/);
    } finally { chmodSync(p.results, 0o755); }
    const after = tree(p.state);
    for (const k of Object.keys(after)) if (k.startsWith('pre-restore/')) delete after[k];
    expect(after).toEqual(before);
    expect(readFileSync(join(p.notes, 'current.md'), 'utf8')).toBe('current\n');
    expect(readdirSync(p.state).filter((n) => n.startsWith('.restore-staging-'))).toEqual([]);
    expect(existsSync(join(p.state, 'pre-restore'))).toBe(false); // the emptied stamp dir is not left behind
  });
});

describe('state backup: DB snapshot under a concurrent writer', () => {
  it('snapshots taken while another process commits are whole transactions and restore cleanly', async () => {
    const root = tmp('minions-qa-wal-');
    const p = paths(root);
    openDb(p.db).close();
    const BATCH = 50;
    // A separate process commits batches of BATCH events in WAL mode until told to stop.
    const writer = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=5000');
      const ins = db.prepare("INSERT INTO events (kind, task_id, data_json, at) VALUES ('qa-wal', NULL, ?, ?)");
      let stop = false; process.stdin.on('data', () => { stop = true; }); process.stdin.resume();
      let n = 0; process.stdout.write('ready\\n');
      (function loop() {
        if (stop) { db.close(); process.exit(0); }
        db.exec('BEGIN IMMEDIATE');
        for (let i = 0; i < ${BATCH}; i++) ins.run(JSON.stringify({ n: n++, pad: 'x'.repeat(200) }), new Date().toISOString());
        db.exec('COMMIT');
        setImmediate(loop);
      })();
    `, p.db], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((res, rej) => {
        writer.stdout.once('data', () => res());
        writer.once('error', rej);
        writer.once('exit', (code, signal) => rej(new Error(`writer exited before it was ready (code ${code}, signal ${signal})`)));
      });
      await new Promise((r) => setTimeout(r, 200));
      const counts: number[] = [];
      for (let i = 0; i < 3; i++) {
        const out = join(tmp('minions-qa-wal-out-'), 'state.tar.gz');
        await createStateBackup(p, out);
        parseStateBackup(readFileSync(out));
        const dst = paths(tmp('minions-qa-wal-dst-'));
        await restoreStateBackup(dst, out);
        const d = openDb(dst.db);
        try {
          expect(d.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check).toBe('ok');
          const n = d.get<{ c: number }>("SELECT count(*) AS c FROM events WHERE kind = 'qa-wal'")!.c;
          expect(n % BATCH).toBe(0);
          counts.push(n);
        } finally { d.close(); }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(counts.at(-1)!).toBeGreaterThan(0);
    } finally {
      if (writer.pid !== undefined && writer.exitCode === null && writer.signalCode === null) {
        writer.stdin.write('stop\n');
        await new Promise((r) => writer.once('exit', r));
      }
    }
  }, 60_000);
});
