// QA (task-20.1): `minions workspace state-import` through the command layer beyond the happy path:
// a plain restore into a quiet runtime releases the restored leases, a failed swap leaves the live state
// (DB, lock row, active lease) intact and the command's handles usable, minions' own secret names are
// listed as skipped in the manifest while similar names are archived, and repeated restores keep 3 copies.
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { register } from '../../src/runtime/commands.js';
import { openDb, type RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { createStateBackup, parseStateBackup, PRE_RESTORE_KEEP } from '../../src/runtime/state-backup.js';
import { readFileSync } from 'node:fs';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

let root = '';
beforeAll(() => {
  root = tmp('minions-restore-qa-');
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify(defaults('project-owner')));
  process.env.MINIONS_RUNTIME = 'container';
  process.env.MINIONS_STATE_DIR = join(root, 'state');
  process.env.MINIONS_SECRETS_DIR = join(root, 'secrets');
  process.env.MINIONS_CONFIG = join(root, 'config.json');
  process.env.MINIONS_WORKSPACE = join(root, 'workspace');
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

async function run(...args: string[]): Promise<{ ok: boolean; data?: any; error?: { code: string; message: string; hint?: string; details?: any } }> {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  register(program);
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c }); }) as typeof process.exit);
  try { await program.parseAsync(['node', 'minions', ...args, '--json']); } catch (e) {
    if ((e as { exitCode?: number }).exitCode === undefined) throw e;
  } finally { vi.restoreAllMocks(); }
  return JSON.parse(out.join('').trim().split('\n').pop()!);
}

const insertLease = (d: RuntimeDb, id: string, task: string) =>
  d.exec(`INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES (?, ?, 'engineer', 1, 3, '2026-10-23T00:00:00Z', 'active')`, id, task);

async function makeBackup(withLease: boolean, extra?: (notes: string) => void): Promise<string> {
  const srcRoot = tmp('minions-restore-qa-src-');
  const src = runtimePaths({ MINIONS_STATE_DIR: join(srcRoot, 'state'), MINIONS_SECRETS_DIR: join(srcRoot, 'secrets'), MINIONS_WORKSPACE: join(srcRoot, 'ws') } as NodeJS.ProcessEnv, { inContainer: false });
  mkdirSync(src.notes, { recursive: true });
  writeFileSync(join(src.notes, 'n.md'), 'note\n');
  extra?.(src.notes);
  const sdb = openDb(src.db);
  if (withLease) insertLease(sdb, 'bk-1', 'task-5');
  sdb.close();
  const archive = join(srcRoot, 'state.tar.gz');
  await createStateBackup(src, archive);
  return archive;
}

describe('state-import (command layer) QA', () => {
  it('lists minions secret names as skipped in the manifest and archives similar names', async () => {
    const archive = await makeBackup(false, (notes) => {
      for (const n of ['anthropic-api-key', 'github-token', 'telegram-bot-token', 'approval-signing-key', 'github-token.md', 'my-github-token', 'telegram-bot-token-notes.txt']) writeFileSync(join(notes, n), 'x\n');
    });
    const parsed = parseStateBackup(readFileSync(archive));
    const files = [...parsed.files.keys()];
    for (const n of ['anthropic-api-key', 'github-token', 'telegram-bot-token', 'approval-signing-key']) {
      expect(files).not.toContain(`notes/${n}`);
      expect(parsed.manifest.skipped.map((s) => s.path)).toContain(`notes/${n}`);
    }
    for (const n of ['github-token.md', 'my-github-token', 'telegram-bot-token-notes.txt']) {
      expect(files).toContain(`notes/${n}`);
      expect(parsed.manifest.skipped.map((s) => s.path)).not.toContain(`notes/${n}`);
    }
  });

  it('a plain restore into a runtime without a DB releases the restored active leases', async () => {
    const archive = await makeBackup(true);
    const r = await run('workspace', 'state-import', archive);
    expect(r).toMatchObject({ ok: true, data: { forced: false, restoredActiveLeases: ['bk-1'], releasedLeases: ['bk-1'], preservedLockPid: null } });
    expect((await run('work', 'list')).data.leases).toEqual([]);
  });

  it('a restore without --force is refused while a live lease exists, and changes nothing', async () => {
    const p = runtimePaths();
    const db = openDb(p.db);
    insertLease(db, 'live-1', 'task-9');
    db.close();
    const archive = await makeBackup(true);
    const r = await run('workspace', 'state-import', archive);
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { activeLeases: ['live-1'] } } });
    const d2 = openDb(p.db);
    try { expect(d2.lease('live-1')).toMatchObject({ status: 'active' }); expect(d2.lease('bk-1')).toMatchObject({ status: 'released' }); } finally { d2.close(); }
  });

  it('a swap that fails midway leaves the live DB, lease and lock row intact and releases nothing', async (ctx) => {
    if (process.getuid?.() === 0) ctx.skip();
    const p = runtimePaths();
    const lock = { pid: process.pid, session: 'coordinator', acquiredAt: '2026-10-23T10:00:00.000Z' };
    const db = openDb(p.db);
    db.setMeta('coordinator_lock', JSON.stringify(lock));
    const releasesBefore = db.events('task-5', 'release').length;
    db.close();
    const archive = await makeBackup(true);
    chmodSync(p.results, 0o555); // renaming results out of the state dir needs write permission on it
    let r;
    try { r = await run('workspace', 'state-import', archive, '--force'); } finally { chmodSync(p.results, 0o755); }
    expect(r).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(r!.error!.message).toMatch(/while swapping files/);
    const d2 = openDb(p.db);
    try {
      expect(d2.lease('live-1')).toMatchObject({ status: 'active' });
      expect(d2.coordinatorLock()).toEqual(lock);
      expect(d2.events('task-5', 'release')).toHaveLength(releasesBefore);
    } finally { d2.close(); }
    expect(readdirSync(p.state).filter((n) => n.startsWith('.restore-staging-'))).toEqual([]);
    // The command's handles still work against the live DB afterwards.
    expect((await run('work', 'list')).data.leases.map((l: { id: string }) => l.id)).toEqual(['live-1']);
  });

  it(`repeated forced restores keep exactly ${PRE_RESTORE_KEEP} pre-restore copies`, async () => {
    const p = runtimePaths();
    for (let i = 0; i < 5; i++) {
      const archive = await makeBackup(false);
      const r = await run('workspace', 'state-import', archive, '--force');
      expect(r.ok).toBe(true);
      await new Promise((res) => setTimeout(res, 15)); // stamps sort by time
    }
    expect(existsSync(join(p.state, 'pre-restore'))).toBe(true);
    expect(readdirSync(join(p.state, 'pre-restore'))).toHaveLength(PRE_RESTORE_KEEP);
  });
});
