// `minions workspace state-import --force` through the command layer (task-20.1): a forced restore over a
// running coordinator with an active worker lease, from a backup that itself has an active lease. The
// restored leases are released (so the documented `minions settings restart`, which runs `coordinator
// restart --recover` and refuses while leases are active, works), and the live coordinator's lock row
// survives the swap (so no second coordinator can start before the restart).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { register } from '../../src/runtime/commands.js';
import { coordinatorPidAlive, restartCoordinator } from '../../src/runtime/coordinator.js';
import { openDb, type RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { createStateBackup, RESTORE_RELEASE_REASON } from '../../src/runtime/state-backup.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

let root = '';
let wrapper: ChildProcess | undefined;
beforeAll(() => {
  root = tmp('minions-restore-cmd-');
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
afterAll(() => { wrapper?.kill('SIGKILL'); });

async function run(...args: string[]): Promise<{ ok: boolean; data?: any; error?: { code: string; message: string; hint?: string; details?: any } }> {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  register(program);
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c }); }) as typeof process.exit);
  try {
    await program.parseAsync(['node', 'minions', ...args, '--json']);
  } catch (e) {
    if ((e as { exitCode?: number }).exitCode === undefined) throw e;
  } finally {
    vi.restoreAllMocks();
  }
  return JSON.parse(out.join('').trim().split('\n').pop()!);
}

const insertLease = (d: RuntimeDb, id: string, task: string) =>
  d.exec(`INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES (?, ?, 'engineer', 1, 3, '2026-10-23T00:00:00Z', 'active')`, id, task);

/** A process whose command line looks like the coordinator wrapper (`minions coordinator run`). */
async function fakeWrapper(): Promise<number> {
  wrapper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'minions', 'coordinator', 'run'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 100));
  return wrapper.pid!;
}

/** Fake tmux: tracks whether the session exists; killing it ends the old wrapper. */
function tmux(onKill: () => void) {
  let alive = true;
  const runner = async (_cmd: string, args: string[]): Promise<RunResult> => {
    if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'kill-session') { alive = false; onKill(); return { code: 0, stdout: '', stderr: '' }; }
    if (args.includes('new-session')) { alive = true; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return runner;
}

describe('minions workspace state-import --force (command layer)', () => {
  it('releases the restored leases, keeps the live lock, and the documented restart then succeeds', async () => {
    // Backup of a runtime that had a worker in flight.
    const srcRoot = tmp('minions-restore-src-');
    const src = runtimePaths({ MINIONS_STATE_DIR: join(srcRoot, 'state'), MINIONS_SECRETS_DIR: join(srcRoot, 'secrets'), MINIONS_WORKSPACE: join(srcRoot, 'ws') } as NodeJS.ProcessEnv, { inContainer: false });
    mkdirSync(join(src.notes), { recursive: true });
    writeFileSync(join(src.notes, 'n.md'), 'note\n');
    const sdb = openDb(src.db);
    insertLease(sdb, 'src-1', 'task-5');
    sdb.setMeta('coordinator_lock', JSON.stringify({ pid: 999999, session: 'coordinator', acquiredAt: 'then' }));
    sdb.close();
    const archive = join(srcRoot, 'state.tar.gz');
    await createStateBackup(src, archive);

    // The live runtime: a running coordinator and a worker lease of its own.
    const p = runtimePaths();
    const pid = await fakeWrapper();
    expect(coordinatorPidAlive(pid)).toBe(true);
    const liveLock = { pid, session: 'coordinator', acquiredAt: '2026-10-23T10:00:00.000Z' };
    const ldb = openDb(p.db);
    insertLease(ldb, 'live-1', 'task-9');
    ldb.setMeta('coordinator_lock', JSON.stringify(liveLock));
    ldb.close();

    const refused = await run('workspace', 'state-import', archive);
    expect(refused).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { activeLeases: ['live-1'], coordinatorPid: pid } } });
    expect(refused.error!.hint).toMatch(/--force .*released.*`minions settings restart`/);

    const r = await run('workspace', 'state-import', archive, '--force');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ forced: true, restoredActiveLeases: ['src-1'], releasedLeases: ['src-1'], preservedLockPid: pid });
    expect(r.data.warnings.join('\n')).toMatch(/minions settings restart/);

    // No active lease is left, so `coordinator restart` is not refused.
    expect((await run('work', 'list')).data.leases).toEqual([]);
    const db = openDb(p.db);
    try {
      expect(db.lease('src-1')).toMatchObject({ status: 'released' });
      expect(db.lease('live-1')).toBeUndefined(); // the restored DB replaced the live one
      const rel = db.events('task-5', 'release');
      expect(rel.at(-1)!.data).toMatchObject({ leaseId: 'src-1', reason: RESTORE_RELEASE_REASON });
      expect(rel.at(-1)!.data).not.toHaveProperty('direct'); // released by the scheduler, not the DB fallback

      // The live coordinator's lock row survived the swap: a second coordinator is refused.
      expect(db.coordinatorLock()).toEqual(liveLock);
      expect(() => db.acquireCoordinatorLock('second', 4242)).toThrow(/Another coordinator holds the project lock/);

      // `minions settings restart` runs `coordinator restart --recover` (not forced) in the runtime.
      let killed = false;
      const res = await restartCoordinator(defaults('project-owner'), {
        paths: p, runner: tmux(() => { killed = true; wrapper!.kill('SIGKILL'); }), activeLeases: () => db.activeLeases(),
        lock: db, lockAlive: (lp) => lp === pid ? !killed : false, sleep: async () => {}, handoverWaitMs: 0,
      }, { recover: true });
      expect(res).toMatchObject({ action: 'restarted' });
      expect(res.reason).toMatch(/recovery prompt/);
    } finally { db.close(); }
  });
});
