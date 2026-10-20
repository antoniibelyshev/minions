// One coordinator per project: the wrapper (`minions coordinator run`) holds the runtime DB lock while
// claude runs. Temp state dirs and fakes only: no tmux, no claude, never the live /state DB.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { MinionsError } from '../../src/core/errors.js';
import {
  acquireCoordinatorLockWaiting, coordinatorPidAlive, coordinatorWrapper, lockSession, readExitRecord, syncCoordinator,
  TMUX_SESSION, waitForLockRelease, type SpawnLike,
} from '../../src/runtime/coordinator.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const terminalCfg = () => { const c = defaults(); c.communication.channel = 'terminal'; return c; };

function layout() {
  const root = tmp('minions-lock-');
  for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  const paths = {
    ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
    pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
  };
  return { root, paths };
}

const noSignals = { on() { return this; }, removeListener() { return this; } };

/** Fake claude: records the spawn, and lets the test observe the lock while "claude" runs. */
function fakeSpawn(during?: () => void, code = 0) {
  const calls: string[][] = [];
  const spawn: SpawnLike = (cmd, args) => {
    calls.push([cmd, ...args]);
    return {
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => { during?.(); cb(code, null); }); return this; },
    } as ReturnType<SpawnLike>;
  };
  return { calls, spawn };
}

const OTHER_PID = 4242;

describe('project coordinator lock (wrapper)', () => {
  it('the wrapper holds the lock in the project DB while claude runs and releases it on exit', async () => {
    const { paths } = layout();
    let during: unknown;
    const { spawn, calls } = fakeSpawn(() => { const db = new RuntimeDb(paths.db); during = db.coordinatorLock(); db.close(); });
    const code = await coordinatorWrapper(async () => terminalCfg(), { paths, spawn, env: { TMUX: '/tmp/tmux-1/default,1,0' }, log: () => {}, signals: noSignals });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(during).toMatchObject({ pid: process.pid, session: TMUX_SESSION });
    const db = new RuntimeDb(paths.db);
    expect(db.coordinatorLock()).toBeUndefined();
    db.close();
  });

  it('a second coordinator for the same project is refused while the holder is alive', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    writeFileSync(paths.coordinatorLaunch, '{"keep":"the running coordinator\'s record"}\n');
    const { spawn, calls } = fakeSpawn();
    const logs: string[] = [];
    const sleeps: number[] = [];
    const err = await coordinatorWrapper(async () => terminalCfg(), {
      paths, spawn, env: {}, log: (l) => logs.push(l), signals: noSignals,
      lockWait: { alive: (p) => p === OTHER_PID, waitMs: 1000, sleep: async (ms) => { sleeps.push(ms); } },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinionsError);
    expect(err).toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/pid 4242.*second coordinator for this project was refused/) });
    expect((err as MinionsError).hint).toMatch(/minions start/);
    expect(calls).toHaveLength(0); // claude never started
    expect(readFileSync(paths.coordinatorLaunch, 'utf8')).toContain('keep'); // launch record untouched
    expect(db.coordinatorLock()).toMatchObject({ pid: OTHER_PID }); // holder keeps the lock
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000); // waited for a restart first
    expect(logs.join('\n')).toMatch(/waiting for the previous coordinator \(pid 4242\)/);
    expect(await readExitRecord(paths)).toMatchObject({ code: 1, error: expect.stringMatching(/refused/) });
    db.close();
  });

  it('a crashed holder (dead pid) is taken over without waiting', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.setMeta('coordinator_lock', JSON.stringify({ pid: 2 ** 22 + 12345, session: TMUX_SESSION, acquiredAt: 'x' }));
    const sleeps: number[] = [];
    let during: unknown;
    const { spawn } = fakeSpawn(() => { during = db.coordinatorLock(); });
    expect(await coordinatorWrapper(async () => terminalCfg(), { paths, spawn, env: {}, log: () => {}, signals: noSignals, lockWait: { sleep: async (ms) => { sleeps.push(ms); } } })).toBe(0);
    expect(sleeps).toEqual([]);
    expect(during).toMatchObject({ pid: process.pid, session: 'direct' });
    expect(db.coordinatorLock()).toBeUndefined();
    db.close();
  });

  it('restart: the new wrapper waits for the old one to exit instead of deadlocking', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    let oldAlive = true;
    const sleeps: number[] = [];
    const { spawn, calls } = fakeSpawn();
    const code = await coordinatorWrapper(async () => terminalCfg(), {
      paths, spawn, env: { TMUX: 'x' }, log: () => {}, signals: noSignals,
      // The old wrapper exits after the second poll (tmux kill-session SIGHUP -> claude exits -> release).
      lockWait: { alive: (p) => p === OTHER_PID && oldAlive, sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 2) oldAlive = false; } },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(2);
    db.close();
  });

  it('releases the lock even when claude fails to start, and never releases a lock it does not hold', async () => {
    const { paths } = layout();
    const failing: SpawnLike = () => { throw new Error('ENOENT claude'); };
    await expect(coordinatorWrapper(async () => terminalCfg(), { paths, spawn: failing, env: {}, log: () => {}, signals: noSignals })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    const db = new RuntimeDb(paths.db);
    expect(db.coordinatorLock()).toBeUndefined();
    db.acquireCoordinatorLock('other', OTHER_PID, () => true);
    expect(db.releaseCoordinatorLock(TMUX_SESSION, process.pid)).toBe(false);
    expect(db.coordinatorLock()).toMatchObject({ pid: OTHER_PID });
    db.close();
  });

  it('a config error happens before the lock: nothing is taken', async () => {
    const { paths } = layout();
    await expect(coordinatorWrapper(async () => { throw new Error('invalid config'); }, { paths, env: {}, log: () => {} })).rejects.toThrow('invalid config');
    expect(existsSync(paths.db) ? (() => { const db = new RuntimeDb(paths.db); const l = db.coordinatorLock(); db.close(); return l; })() : undefined).toBeUndefined();
  });
});

describe('lock helpers', () => {
  it('lockSession: the tmux session name inside tmux, direct otherwise', () => {
    expect(lockSession({ TMUX: '/tmp/tmux-501/default,123,0' })).toBe(TMUX_SESSION);
    expect(lockSession({})).toBe('direct');
  });

  it('coordinatorPidAlive: dead pid, reused pid (not a coordinator), live wrapper, no /proc', () => {
    expect(coordinatorPidAlive(2 ** 22 + 12345, () => 'node minions coordinator run')).toBe(false);
    expect(coordinatorPidAlive(process.pid, () => 'sleep 100')).toBe(false);
    expect(coordinatorPidAlive(process.pid, () => 'node /usr/local/bin/minions coordinator run --recover')).toBe(true);
    expect(coordinatorPidAlive(process.pid, () => null)).toBe(true);
  });

  it('acquireCoordinatorLockWaiting is re-entrant and rethrows non-conflict errors', async () => {
    const db = new RuntimeDb(':memory:');
    const a = await acquireCoordinatorLockWaiting(db, { pid: process.pid, session: 's' });
    expect(await acquireCoordinatorLockWaiting(db, { pid: process.pid, session: 's' })).toEqual(a);
    const broken = { coordinatorLock: () => undefined, releaseCoordinatorLock: () => false, acquireCoordinatorLock: () => { throw new Error('disk I/O'); } };
    await expect(acquireCoordinatorLockWaiting(broken, { sleep: async () => {} })).rejects.toThrow('disk I/O');
  });

  it('waitForLockRelease: true once the holder is gone, false after the timeout', async () => {
    const db = new RuntimeDb(':memory:');
    expect(await waitForLockRelease(db)).toBe(true);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    expect(await waitForLockRelease(db, { alive: () => true, waitMs: 500, sleep: async () => {} })).toBe(false);
    let n = 0;
    expect(await waitForLockRelease(db, { alive: () => n < 2, sleep: async () => { n++; } })).toBe(true);
  });
});

describe('controlled restart waits for the old coordinator to release the lock', () => {
  function tmux() {
    const calls: string[] = [];
    let alive = true;
    const runner = async (_cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> => {
      calls.push(args[0] === '-u' ? 'new-session' : args[0]!);
      if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') { alive = false; return { code: 0, stdout: '', stderr: '' }; }
      if (args.includes('new-session')) { alive = true; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { calls, runner };
  }

  it('relaunches only after the killed wrapper has exited', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    const t = tmux();
    let oldAlive = true;
    const events: string[] = [];
    const sleep = async (ms: number) => { events.push(`sleep ${ms}`); if (ms === 250) oldAlive = false; };
    const r = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep, lock: db, lockAlive: (p) => p === OTHER_PID && oldAlive }, { restart: true, startDetached: true });
    expect(r).toMatchObject({ action: 'restarted', running: true });
    expect(t.calls).toEqual(['has-session', 'kill-session', 'new-session', 'has-session']);
    expect(events).toEqual(['sleep 250', 'sleep 2000']); // lock poll before the relaunch, then the settle wait
    expect(r.reason).not.toMatch(/had not exited/);
    db.close();
  });

  it('reports a holder that did not exit in time (the new wrapper still waits before refusing)', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    const t = tmux();
    const r = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep: async () => {}, lock: db, lockAlive: () => true, lockReleaseWaitMs: 500 }, { restart: true, startDetached: true });
    expect(r.reason).toMatch(/previous coordinator \(pid 4242\) had not exited yet/);
    db.close();
  });
});
