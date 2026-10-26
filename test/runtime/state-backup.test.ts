import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION, type RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import {
  createStateBackup, MINIONS_SECRET_FILE_NAMES, parseStateBackup, PRE_RESTORE_KEEP, readTar, releaseRestoredLeases, restoreStateBackup, RESTORE_RELEASE_REASON, writeTar,
  type StateManifest, type TarEntry,
} from '../../src/runtime/state-backup.js';
import { projectPaths } from '../../src/core/paths.js';
import { APPROVAL_SIGNING_KEY_NAME } from '../../src/host/approvals.js';
import { GITHUB_CREDENTIAL, TELEGRAM_CREDENTIAL } from '../../src/host/credentials.js';
import { basename } from 'node:path';
import { tmp } from './fixtures.js';

const SECRET = 'ghp_TESTSECRETVALUE0123456789';
const LONG = `backlog/backlog/tasks/task-20 - ${'State-backup-restore-and-a-troubleshooting-guide-'.repeat(3)}é.md`;

function paths(root: string) {
  return runtimePaths({ MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_WORKSPACE: join(root, 'ws') } as NodeJS.ProcessEnv, { inContainer: false });
}

function put(file: string, content: string | Buffer): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

function insertLease(d: RuntimeDb, id: string, status: string, task = `task-${id}`): void {
  d.exec(`INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES (?, ?, 'engineer', 1, 3, '2026-10-23T00:00:00Z', ?)`, id, task, status);
}

/** A populated runtime state with excluded dirs, a secret, a symlink to it and a hard link. */
function seed(): { root: string; p: ReturnType<typeof paths>; db: RuntimeDb } {
  const root = tmp('minions-state-src-');
  const p = paths(root);
  put(join(root, 'secrets', 'github-token'), `${SECRET}\n`);
  put(join(root, 'secrets', 'telegram-bot-token'), '123456:TELEGRAMTOKENVALUE\n');
  put(join(p.backlog, 'backlog', 'config.yml'), 'project_name: test\n');
  put(join(p.backlog, 'backlog', 'tasks', 'task-1 - First.md'), '---\nid: task-1\n---\nhello\n');
  put(join(p.state, LONG), 'long name\n');
  mkdirSync(join(p.backlog, 'backlog', 'drafts'), { recursive: true });
  put(join(p.notes, 'decision.md'), 'we decided\n');
  put(join(p.notes, 'leak.md'), `token was ${SECRET}\n`);
  put(join(p.notes, '.env'), 'X=1\n');
  symlinkSync(join(root, 'secrets', 'github-token'), join(p.notes, 'token-link'));
  put(join(p.briefs, 'lease-a.json'), '{"brief":1}\n');
  put(join(p.results, 'lease-b.json'), '{"result":1}\n');
  linkSync(join(p.briefs, 'lease-a.json'), join(p.results, 'hardlink.json'));
  put(p.coordinatorHandoff, '{"text":"handoff"}\n');
  for (const d of ['import', 'exports', 'logs', 'cache/tmp', 'claude', 'run']) put(join(p.state, d, 'x.txt'), `${d}\n`);
  put(join(p.state, 'coordinator-launch.json'), '{}\n');
  const db = openDb(p.db);
  insertLease(db, 'l1', 'completed');
  insertLease(db, 'l2', 'released');
  db.setControl('paused_intake', '1');
  db.addEvent('test', 'task-1', { n: 1 });
  db.setMeta('coordinator_lock', JSON.stringify({ pid: 999999, session: 's', acquiredAt: 'x' }));
  return { root, p, db };
}

function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    const st = statSync(f);
    if (st.isDirectory()) Object.assign(out, tree(f, base), { [`${f.slice(base.length + 1)}/`]: '' });
    else out[f.slice(base.length + 1)] = readFileSync(f).toString('base64');
  }
  return out;
}

function rows(file: string) {
  const d = openDb(file);
  try {
    return {
      leases: d.all('SELECT * FROM leases ORDER BY id'),
      events: d.all('SELECT * FROM events ORDER BY id'),
      controls: d.all('SELECT * FROM controls ORDER BY key'),
      meta: d.all("SELECT * FROM meta WHERE key <> 'coordinator_lock' ORDER BY key"),
      lock: d.coordinatorLock() ?? null,
    };
  } finally { d.close(); }
}

const freshTarget = () => { const root = tmp('minions-state-dst-'); const p = paths(root); openDb(p.db).close(); return { root, p }; };

async function backup(): Promise<{ src: ReturnType<typeof seed>; file: string }> {
  const src = seed();
  const file = join(tmp('minions-state-out-'), 'state.tar.gz');
  await createStateBackup(src.p, file);
  return { src, file };
}

describe('state backup', () => {
  it('round-trips backlog, notes, briefs, results, handoff and DB rows into a fresh state', async () => {
    const { src, file } = await backup();
    // The source DB connection is still open in WAL mode: the snapshot sees its committed rows.
    const before = rows(src.p.db);
    src.db.close();
    const dst = freshTarget();
    const r = await restoreStateBackup(dst.p, file, { alive: () => false });
    expect(r.previous).toMatch(/pre-restore/);
    for (const d of ['backlog', 'notes', 'briefs', 'results'] as const) {
      const want = tree(src.p[d]);
      // Skipped entries (secret-bearing, secret-like name, symlink, hard link) are the only differences.
      for (const k of Object.keys(want)) if (/leak\.md|\.env|token-link|hardlink|lease-a/.test(k)) delete want[k];
      const got = tree(dst.p[d]);
      if (d === 'briefs') delete got['lease-a.json'];
      expect(got).toEqual(want);
    }
    expect(readFileSync(join(dst.p.state, LONG), 'utf8')).toBe('long name\n');
    expect(statSync(join(dst.p.backlog, 'backlog', 'drafts')).isDirectory()).toBe(true);
    expect(readFileSync(dst.p.coordinatorHandoff, 'utf8')).toBe('{"text":"handoff"}\n');
    const after = rows(dst.p.db);
    expect(after.leases).toEqual(before.leases);
    // The restore appends one audit event; every backed-up event is unchanged.
    expect(after.events.slice(0, -1)).toEqual(before.events);
    expect(after.events.at(-1)).toMatchObject({ kind: 'state-restore' });
    expect(after.controls).toEqual(before.controls);
    expect(after.meta).toEqual(before.meta);
    expect(after.lock).toBeNull(); // the source runtime's lock row is cleared
    for (const d of ['logs', 'import', 'exports', 'cache', 'claude', 'run']) expect(existsSync(join(dst.p.state, d))).toBe(false);
  });

  it('contains no secrets, no excluded dirs and no symlinks or hard links', async () => {
    const { src, file } = await backup();
    src.db.close();
    const gz = readFileSync(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const tar = gunzipSync(gz);
    expect(tar.includes(SECRET)).toBe(false);
    expect(tar.includes('TELEGRAMTOKENVALUE')).toBe(false);
    const { manifest, files } = parseStateBackup(gz);
    const names = [...files.keys()];
    expect(names).toContain('minions.db');
    expect(names).toContain(LONG);
    expect(names.every((n) => /^(minions\.db|coordinator-handoff\.json|(backlog|notes|briefs|results)\/.+)$/.test(n))).toBe(true);
    for (const bad of ['notes/leak.md', 'notes/.env', 'notes/token-link', 'results/hardlink.json', 'briefs/lease-a.json']) expect(names).not.toContain(bad);
    expect(Object.fromEntries(manifest.skipped.map((s) => [s.path, s.reason]))).toMatchObject({
      'notes/leak.md': 'contains a mounted secret value', 'notes/.env': 'secret-like name', 'notes/token-link': 'symlink', 'results/hardlink.json': 'hard link',
    });
    expect(manifest).toMatchObject({ format: 'minions-state-backup', version: 1, schemaVersion: SCHEMA_VERSION });
    for (const f of manifest.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to back up a DB that contains a mounted secret', async () => {
    const src = seed();
    src.db.addEvent('oops', null, { token: SECRET });
    src.db.close();
    const out = join(tmp('minions-state-out-'), 'state.tar.gz');
    await expect(createStateBackup(src.p, out)).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(existsSync(out)).toBe(false);
  });

  it('never overwrites an existing output file', async () => {
    const src = seed(); src.db.close();
    const out = join(tmp('minions-state-out-'), 'state.tar.gz');
    writeFileSync(out, 'keep');
    await expect(createStateBackup(src.p, out)).rejects.toThrow();
    expect(readFileSync(out, 'utf8')).toBe('keep');
  });
});

describe('state restore guards', () => {
  it('refuses while a worker lease is active, and restores with force', async () => {
    const { src, file } = await backup(); src.db.close();
    const dst = freshTarget();
    const d = openDb(dst.p.db); insertLease(d, 'live', 'active'); d.close();
    put(join(dst.p.notes, 'current.md'), 'current\n');
    await expect(restoreStateBackup(dst.p, file, { alive: () => false })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readFileSync(join(dst.p.notes, 'current.md'), 'utf8')).toBe('current\n');
    expect(rows(dst.p.db).leases.map((l) => (l as { id: string }).id)).toEqual(['live']);
    const r = await restoreStateBackup(dst.p, file, { alive: () => false, force: true });
    expect(r.forced).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/--force/);
    expect(existsSync(join(dst.p.notes, 'current.md'))).toBe(false);
    expect(readFileSync(join(r.previous!, 'notes', 'current.md'), 'utf8')).toBe('current\n');
    expect(rows(dst.p.db).leases.map((l) => (l as { id: string }).id)).toEqual(['l1', 'l2']);
  });

  it('refuses while a live coordinator holds the lock; a dead holder does not block', async () => {
    const { src, file } = await backup(); src.db.close();
    const dst = freshTarget();
    const d = openDb(dst.p.db); d.setMeta('coordinator_lock', JSON.stringify({ pid: 4242, session: 's', acquiredAt: 'x' })); d.close();
    await expect(restoreStateBackup(dst.p, file, { alive: (pid) => pid === 4242 })).rejects.toMatchObject({ code: 'CONFLICT', details: { coordinatorPid: 4242 } });
    await expect(restoreStateBackup(dst.p, file, { alive: () => false })).resolves.toMatchObject({ forced: false });
  });

  it('restores into a state dir that has no DB yet', async () => {
    const { src, file } = await backup(); src.db.close();
    const root = tmp('minions-state-empty-');
    const p = paths(root);
    const r = await restoreStateBackup(p, file);
    expect(r.previous).toBeNull();
    expect(rows(p.db).leases).toHaveLength(2);
  });
});

describe('state backup validation', () => {
  const entries = async (): Promise<TarEntry[]> => { const { src, file } = await backup(); src.db.close(); return readTar(gunzipSync(readFileSync(file))); };
  const write = (es: TarEntry[]) => { const f = join(tmp('minions-state-bad-'), 'bad.tar.gz'); writeFileSync(f, gzipSync(writeTar(es))); return f; };
  const withManifest = (es: TarEntry[], edit: (m: StateManifest) => void): TarEntry[] => {
    const m = JSON.parse(es[0]!.data.toString()) as StateManifest; edit(m);
    return [{ ...es[0]!, data: Buffer.from(JSON.stringify(m)) }, ...es.slice(1)];
  };

  async function expectUntouched(file: string, code: string, message?: RegExp): Promise<void> {
    const dst = freshTarget();
    put(join(dst.p.notes, 'current.md'), 'current\n');
    const before = tree(dst.p.state);
    const err = await restoreStateBackup(dst.p, file, { alive: () => false }).then(() => null, (e: unknown) => e as { code: string; message: string });
    expect(err).toMatchObject({ code });
    if (message) expect(err!.message).toMatch(message);
    expect(tree(dst.p.state)).toEqual(before);
  }

  it('rejects a file whose content does not match its checksum', async () => {
    const es = await entries();
    const i = es.findIndex((e) => e.path === 'notes/decision.md');
    es[i] = { ...es[i]!, data: Buffer.from('tampered!!\n') };
    await expectUntouched(write(es), 'PRECONDITION', /checksum/);
  });

  it('rejects path traversal, absolute paths and paths outside the allowlist', async () => {
    for (const path of ['../evil', 'notes/../../evil', '/etc/passwd', 'logs/x.txt', 'claude/.credentials.json', 'evil.txt']) {
      const es = await entries();
      const data = Buffer.from('x');
      const f = write(withManifest([...es, { path, type: 'file', data, mode: 0o644 }], (m) => m.files.push({ path, size: 1, sha256: createHash('sha256').update(data).digest('hex') })));
      await expectUntouched(f, 'PRECONDITION', /outside the allowed state paths/);
    }
  });

  it('rejects symlink entries and other non-regular types', async () => {
    const es = await entries();
    const good = writeTar(es);
    // Patch the type of the second entry header to '2' (symlink) and fix its checksum.
    const off = 512 + Math.ceil(es[0]!.data.length / 512) * 512;
    const h = Buffer.from(good);
    h[off + 156] = '2'.charCodeAt(0);
    h.fill(' ', off + 148, off + 156);
    let sum = 0; for (let i = off; i < off + 512; i++) sum += h[i]!;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', off + 148, 8, 'ascii');
    const f = join(tmp('minions-state-bad-'), 'link.tar.gz'); writeFileSync(f, gzipSync(h));
    await expectUntouched(f, 'PRECONDITION', /unsupported type/);
  });

  it('rejects a missing manifest, an unknown format, extra and missing files', async () => {
    const es = await entries();
    await expectUntouched(write(es.slice(1)), 'PRECONDITION');
    await expectUntouched(write(withManifest(es, (m) => { (m as { format: string }).format = 'other'; })), 'PRECONDITION');
    await expectUntouched(write(withManifest(es, (m) => { m.files = m.files.filter((f) => f.path !== 'notes/decision.md'); })), 'PRECONDITION');
    await expectUntouched(write(es.filter((e) => e.path !== 'notes/decision.md')), 'PRECONDITION');
    const notGzip = join(tmp('minions-state-bad-'), 'x.tar.gz'); writeFileSync(notGzip, 'not an archive');
    await expectUntouched(notGzip, 'PRECONDITION');
  });

  it('rejects a newer format version or schema', async () => {
    const es = await entries();
    await expectUntouched(write(withManifest(es, (m) => { m.version = 2; })), 'INCOMPATIBLE_RUNTIME');
    await expectUntouched(write(withManifest(es, (m) => { m.schemaVersion = SCHEMA_VERSION + 1; })), 'INCOMPATIBLE_RUNTIME');
  });
});

describe('state backup: minions secret file names (task-20.1)', () => {
  it('lists the real secret file names of the host and the runtime', () => {
    const pp = projectPaths('3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f');
    const rp = runtimePaths();
    const real = [pp.apiKeyFile, pp.githubTokenFile, pp.telegramTokenFile, rp.apiKeyFile, rp.githubTokenFile, rp.telegramTokenFile].map((f) => basename(f));
    for (const n of [...real, GITHUB_CREDENTIAL.fileName, TELEGRAM_CREDENTIAL.fileName, APPROVAL_SIGNING_KEY_NAME]) expect(MINIONS_SECRET_FILE_NAMES).toContain(n);
    expect([...MINIONS_SECRET_FILE_NAMES].sort()).toEqual(['anthropic-api-key', 'approval-signing-key', 'github-token', 'telegram-bot-token']);
  });

  it('never archives a copy of a minions secret file inside an archived dir', async () => {
    const src = seed();
    const names = ['notes/telegram-bot-token', 'briefs/sub/github-token', 'results/anthropic-api-key', 'backlog/approval-signing-key'];
    for (const n of names) put(join(src.p.state, n), 'not-a-mounted-value\n');
    put(join(src.p.notes, 'github-token-rotation.md'), 'a note about rotating the token\n'); // a similar name is still archived
    const file = join(tmp('minions-state-out-'), 'state.tar.gz');
    const r = await createStateBackup(src.p, file);
    src.db.close();
    for (const n of names) expect(r.skipped).toContainEqual({ path: n, reason: 'secret-like name' });
    const paths = readTar(gunzipSync(readFileSync(file))).map((e) => e.path);
    for (const n of names) expect(paths).not.toContain(n);
    expect(paths).toContain('notes/github-token-rotation.md');
  });
});

describe('state restore: coordinator lock, restored leases, pre-restore pruning (task-20.1)', () => {
  it('a forced restore over a live coordinator carries its lock row into the restored DB', async () => {
    const { src, file } = await backup(); src.db.close();
    const dst = freshTarget();
    const lock = { pid: 4242, session: 'coordinator', acquiredAt: '2026-10-23T10:00:00.000Z' };
    const d = openDb(dst.p.db); d.setMeta('coordinator_lock', JSON.stringify(lock)); d.close();
    const alive = (pid: number) => pid === 4242;
    const r = await restoreStateBackup(dst.p, file, { alive, force: true });
    expect(r.preservedLockPid).toBe(4242);
    expect(r.warnings.join('\n')).toMatch(/running coordinator \(pid 4242\).*minions settings restart/s);
    const after = openDb(dst.p.db);
    try {
      expect(after.coordinatorLock()).toEqual(lock); // not the backup's pid 999999, and not cleared
      expect(() => after.acquireCoordinatorLock('second', 5151, alive)).toThrow(/Another coordinator holds the project lock/);
      expect(after.all<{ data_json: string }>("SELECT data_json FROM events WHERE kind = 'state-restore'").map((e) => JSON.parse(e.data_json))).toEqual([
        expect.objectContaining({ forced: true, preservedLockPid: 4242, restoredActiveLeases: [] }),
      ]);
    } finally { after.close(); }
  });

  it('a dead holder\'s lock row is not carried over', async () => {
    const { src, file } = await backup(); src.db.close();
    const dst = freshTarget();
    const d = openDb(dst.p.db); d.setMeta('coordinator_lock', JSON.stringify({ pid: 4242, session: 'coordinator', acquiredAt: 'x' })); d.close();
    const r = await restoreStateBackup(dst.p, file, { alive: () => false });
    expect(r.preservedLockPid).toBeNull();
    expect(rows(dst.p.db).lock).toBeNull();
  });

  it('reports the backup\'s active leases; releaseRestoredLeases ends them (DB fallback without a scheduler)', async () => {
    const src = seed();
    insertLease(src.db, 'a1', 'active', 'task-a');
    insertLease(src.db, 'a2', 'active', 'task-b');
    const file = join(tmp('minions-state-out-'), 'state.tar.gz');
    await createStateBackup(src.p, file); src.db.close();
    const dst = freshTarget();
    const r = await restoreStateBackup(dst.p, file, { alive: () => false });
    expect(r.restoredActiveLeases.sort()).toEqual(['a1', 'a2']);
    expect(r.warnings.join('\n')).toMatch(/2 lease\(s\) marked active/);
    const d = openDb(dst.p.db);
    try {
      const calls: string[] = [];
      // a1: the scheduler release fails; a2: no lease is left active either way.
      const rel = await releaseRestoredLeases(d, async (id) => { calls.push(id); if (id === 'a1') throw new Error('backlog unavailable'); d.exec("UPDATE leases SET status = 'released' WHERE id = ?", id); });
      expect(calls.sort()).toEqual(['a1', 'a2']);
      expect(rel.released.sort()).toEqual(['a1', 'a2']);
      expect(rel.failed).toEqual([{ leaseId: 'a1', error: 'backlog unavailable' }]);
      expect(d.activeLeases()).toEqual([]);
      expect(d.events('task-a', 'release').at(-1)!.data).toMatchObject({ leaseId: 'a1', reason: RESTORE_RELEASE_REASON, direct: true });
      // No scheduler at all: everything is ended in the DB.
      insertLease(d, 'a3', 'active', 'task-c');
      expect((await releaseRestoredLeases(d, null)).failed.map((f) => f.leaseId)).toEqual(['a3']);
      expect(d.activeLeases()).toEqual([]);
    } finally { d.close(); }
  });

  it('a lease whose release fails while it may have an unfinished process run stays active (task-14.5)', async () => {
    const src = seed();
    insertLease(src.db, 'b1', 'active', 'task-a');
    insertLease(src.db, 'b2', 'active', 'task-b');
    insertLease(src.db, 'b3', 'active', 'task-c');
    const file = join(tmp('minions-state-out-'), 'state.tar.gz');
    await createStateBackup(src.p, file); src.db.close();
    const dst = freshTarget();
    await restoreStateBackup(dst.p, file, { alive: () => false });
    const d = openDb(dst.p.db);
    try {
      // b1: the reap fails (open run); b2: the backlog fails (no run); b3: hasOpenRun itself throws (fails closed).
      const open = async (id: string) => { if (id === 'b3') throw new Error('unreadable'); return id === 'b1'; };
      const rel = await releaseRestoredLeases(d, async (id) => { throw new Error(id === 'b2' ? 'backlog unavailable' : 'CONFLICT: runner alive'); }, RESTORE_RELEASE_REASON, open);
      expect(rel.kept.map((k) => k.leaseId).sort()).toEqual(['b1', 'b3']);
      expect(rel.kept.find((k) => k.leaseId === 'b1')?.error).toBe('CONFLICT: runner alive');
      expect(rel.failed.map((f) => f.leaseId)).toEqual(['b2']);
      expect(rel.released).toEqual(['b2']);
      expect(d.activeLeases().map((l) => l.id).sort()).toEqual(['b1', 'b3']);
      expect(d.events('task-a', 'release-refused').at(-1)!.data).toMatchObject({ leaseId: 'b1', reason: RESTORE_RELEASE_REASON });
      expect(d.events('task-a', 'release')).toEqual([]);
      // No scheduler: an open run still keeps the lease.
      expect((await releaseRestoredLeases(d, null, RESTORE_RELEASE_REASON, async (id) => id === 'b1')).kept.map((k) => k.leaseId)).toEqual(['b1']);
      expect(d.activeLeases().map((l) => l.id)).toEqual(['b1']);
    } finally { d.close(); }
  });

  it(`keeps only the newest ${PRE_RESTORE_KEEP} pre-restore copies and drops empty stamp dirs`, async () => {
    const { src, file } = await backup(); src.db.close();
    const dst = freshTarget();
    mkdirSync(join(dst.p.state, 'pre-restore', '2020-01-01T00-00-00-000Z'), { recursive: true }); // empty leftover
    const prev: string[] = [];
    for (let i = 0; i < PRE_RESTORE_KEEP + 2; i++) {
      const r = await restoreStateBackup(dst.p, file, { alive: () => false, now: new Date(Date.UTC(2026, 9, 23, 12, i)) });
      prev.push(r.previous!);
    }
    const left = readdirSync(join(dst.p.state, 'pre-restore')).sort();
    expect(left).toEqual(prev.slice(-PRE_RESTORE_KEEP).map((x) => basename(x)));
    for (const n of left) expect(existsSync(join(dst.p.state, 'pre-restore', n, 'minions.db'))).toBe(true);
  });

  it('never prunes the copy the current restore made, even when the clock is behind existing stamps', async () => {
    const { src, file } = await backup(); src.db.close();
    const dst = freshTarget();
    for (let i = 0; i < PRE_RESTORE_KEEP + 1; i++) {
      const d = join(dst.p.state, 'pre-restore', `2099-01-0${i + 1}T00-00-00-000Z`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'marker'), 'x');
    }
    const r = await restoreStateBackup(dst.p, file, { alive: () => false, now: new Date(Date.UTC(2026, 9, 23, 12, 0)) });
    expect(existsSync(r.previous!)).toBe(true);
    expect(readdirSync(join(dst.p.state, 'pre-restore')).length).toBeLessThanOrEqual(PRE_RESTORE_KEEP);
  });
});
