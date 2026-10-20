// One coordinator per project: the wrapper (`minions coordinator run`) holds the runtime DB lock while
// claude runs. Temp state dirs and fakes only: no tmux, no claude, never the live /state DB.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { MinionsError } from '../../src/core/errors.js';
import {
  acquireCoordinatorLockWaiting, coordinatorPidAlive, coordinatorWrapper, lockSession, readExitRecord, syncCoordinator,
  ESCALATE_KILL_MS, ESCALATE_TERM_MS, LOCK_RELEASE_WAIT_MS, LOCK_WAIT_MS, STUCK_TERM_WAIT_MS, stopStuckCoordinator,
  TMUX_SESSION, waitForLockRelease, type ProcessControl, type SpawnLike,
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

/** The installed Claude Code offers auto: no real `claude --help` (task-36) before the fake spawn. */
const autoModes = async () => ['acceptEdits', 'auto'];

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
    const code = await coordinatorWrapper(async () => terminalCfg(), { paths, spawn, permissionModes: autoModes, env: { TMUX: '/tmp/tmux-1/default,1,0' }, log: () => {}, signals: noSignals });
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
      paths, spawn, permissionModes: autoModes, env: {}, log: (l) => logs.push(l), signals: noSignals,
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
    expect(await coordinatorWrapper(async () => terminalCfg(), { paths, spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: noSignals, lockWait: { sleep: async (ms) => { sleeps.push(ms); } } })).toBe(0);
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
      paths, spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: () => {}, signals: noSignals,
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
    await expect(coordinatorWrapper(async () => terminalCfg(), { paths, spawn: failing, permissionModes: autoModes, env: {}, log: () => {}, signals: noSignals })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
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

const WRAPPER_CMD = 'node /usr/local/bin/minions coordinator run --recover';
const CLAUDE_PID = 4343;
const NEW_PID = 5151;

describe('controlled restart waits for the old coordinator to release the lock', () => {
  /** Fake tmux; `onNew` simulates the wrapper the new session starts. */
  function tmux(onNew?: () => void, liveChecksAfterNew = Number.POSITIVE_INFINITY, runningAtStart = true) {
    const calls: string[] = [];
    let alive = runningAtStart;
    let checksLeft = Number.POSITIVE_INFINITY;
    const runner = async (_cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> => {
      calls.push(args[0] === '-u' ? 'new-session' : args[0]!);
      if (args[0] === 'has-session') { if (alive && checksLeft-- <= 0) alive = false; return { code: alive ? 0 : 1, stdout: '', stderr: '' }; }
      if (args[0] === 'kill-session') { alive = false; return { code: 0, stdout: '', stderr: '' }; }
      if (args.includes('new-session')) { alive = true; checksLeft = liveChecksAfterNew; onNew?.(); return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { calls, runner };
  }

  it('relaunches only after the killed wrapper has exited, and reports success once the new wrapper holds the lock', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    let oldAlive = true;
    const lockAlive = (p: number) => (p === OTHER_PID && oldAlive) || p === NEW_PID;
    const t = tmux(() => { db.acquireCoordinatorLock(TMUX_SESSION, NEW_PID, lockAlive); });
    const events: string[] = [];
    const sleep = async (ms: number) => { events.push(`sleep ${ms}`); if (ms === 250) oldAlive = false; };
    const r = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep, lock: db, lockAlive }, { restart: true, startDetached: true });
    expect(r).toMatchObject({ action: 'restarted', running: true });
    expect(t.calls).toEqual(['has-session', 'kill-session', 'new-session', 'has-session']);
    expect(events).toEqual(['sleep 250', 'sleep 2000']); // lock poll before the relaunch, then the settle wait
    expect(r.reason).not.toMatch(/did not exit|not taken the project lock/);
    db.close();
  });

  it('a fresh start counts only a new lock holder, not the stale record left before the launch', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.setMeta('coordinator_lock', JSON.stringify({ pid: OTHER_PID, session: TMUX_SESSION, acquiredAt: 'old' }));
    // The stale row names a pid that "is alive" (the check is injected); the new wrapper never takes over.
    const t = tmux(undefined, 3, false); // the new session dies on the 4th check
    const err = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep: async () => {}, lock: db, lockAlive: () => true }, { startDetached: true }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/session exited right after starting/) });
    db.close();
  });

  it('(c) a new session that ends before its wrapper takes the lock is an error, not "running"', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    let oldAlive = true;
    // Settle check passes (1 live check), then the session is gone: the wrapper was refused with CONFLICT.
    const t = tmux(() => { writeFileSync(paths.coordinatorExit, JSON.stringify({ version: 1, pid: NEW_PID, at: 'x', code: 1, error: 'Another coordinator holds the project lock (pid 4242). A second coordinator for this project was refused.' })); }, 1);
    const err = await syncCoordinator(terminalCfg(), {
      paths, runner: t.runner, activeLeases: () => [], sleep: async () => { oldAlive = false; }, lock: db, lockAlive: (p) => p === OTHER_PID && oldAlive,
    }, { restart: true, startDetached: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinionsError);
    expect(err).toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/exited right after starting: Another coordinator holds the project lock/) });
    db.close();
  });

  it('(c) a new session still alive after the whole lock wait window counts as running, with a note', async () => {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    const t = tmux(undefined, Number.POSITIVE_INFINITY, false);
    let slept = 0;
    const r = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep: async (ms) => { slept += ms; }, lock: db, lockAlive: () => true }, { startDetached: true });
    expect(r).toMatchObject({ action: 'started', running: true, reason: expect.stringMatching(/alive but has not taken the project lock yet/) });
    expect(slept).toBeGreaterThanOrEqual(2000 + 12_000); // settle + LOCK_WAIT_MS + settle margin
    db.close();
  });

  it('without a lock store (older callers) the settle check alone decides', async () => {
    const { paths } = layout();
    const t = tmux(undefined, Number.POSITIVE_INFINITY, false);
    const r = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep: async () => {} }, { startDetached: true });
    expect(r).toMatchObject({ action: 'started', running: true });
    expect(t.calls).toEqual(['has-session', 'new-session', 'has-session']);
  });
});

/**
 * Fake process table for the stuck-coordinator escalation: the old wrapper (OTHER_PID) with its claude
 * child (CLAUDE_PID), plus an unrelated child of the wrapper and an unrelated claude elsewhere.
 */
function procTable(o: { dieOn?: NodeJS.Signals[]; cmdline?: (pid: number) => string | null } = {}) {
  const dead = new Set<number>();
  const kills: string[] = [];
  const cmd: Record<number, string> = { [OTHER_PID]: WRAPPER_CMD, [CLAUDE_PID]: 'claude --plugin-dir /opt/minions/plugin', 777: 'sleep 100', 888: 'claude --print hi' };
  const parent: Record<number, number> = { [OTHER_PID]: 1, [CLAUDE_PID]: OTHER_PID, 777: OTHER_PID, 888: 1 };
  const proc: ProcessControl = {
    alive: (p) => p in cmd && !dead.has(p),
    cmdline: (p) => (o.cmdline ? o.cmdline(p) : cmd[p] ?? null),
    parentOf: (p) => parent[p] ?? null,
    pids: () => [1, OTHER_PID, CLAUDE_PID, 777, 888],
    kill: (p, s) => {
      if (dead.has(p) || !(p in cmd)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      kills.push(`${s} ${p}`);
      if (s === 'SIGKILL' || o.dieOn?.includes(s)) dead.add(p);
    },
  };
  return { proc, kills, dead };
}

describe('stopStuckCoordinator signals only the verified wrapper and its claude child', () => {
  const holder = () => { const db = new RuntimeDb(':memory:'); db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true); return db; };

  it('SIGTERM first; a wrapper that exits on it is not SIGKILLed', async () => {
    const db = holder();
    const t = procTable({ dieOn: ['SIGTERM'] });
    const r = await stopStuckCoordinator(db, OTHER_PID, { proc: t.proc, sleep: async () => {} });
    expect(r).toMatchObject({ released: true, verified: true });
    expect(t.kills).toEqual([`SIGTERM ${OTHER_PID}`]);
  });

  it('then SIGKILL: the claude child before the wrapper; unrelated processes are never signalled', async () => {
    const db = holder();
    const t = procTable(); // ignores SIGTERM
    const waits: number[] = [];
    const r = await stopStuckCoordinator(db, OTHER_PID, { proc: t.proc, sleep: async (ms) => { waits.push(ms); } });
    expect(r).toMatchObject({ released: true, verified: true, signalled: [`SIGTERM ${OTHER_PID}`, `SIGKILL ${CLAUDE_PID}`, `SIGKILL ${OTHER_PID}`] });
    expect(t.kills).toEqual([`SIGTERM ${OTHER_PID}`, `SIGKILL ${CLAUDE_PID}`, `SIGKILL ${OTHER_PID}`]);
    expect(t.kills.join(' ')).not.toMatch(/ 777| 888/);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5000);
  });

  it('never signals a pid that is not a coordinator wrapper (pid reuse) or cannot be verified (no /proc)', async () => {
    for (const cmdline of [(p: number) => (p === OTHER_PID ? 'postgres: writer' : null), () => null]) {
      const db = holder();
      const t = procTable({ cmdline });
      const r = await stopStuckCoordinator(db, OTHER_PID, { proc: t.proc, alive: () => true, sleep: async () => {} });
      expect(r).toEqual({ released: false, signalled: [], verified: false });
      expect(t.kills).toEqual([]);
    }
  });

  it('re-checks right before each signal: a pid reused between SIGTERM and SIGKILL is left alone', async () => {
    const db = holder();
    let reused = false;
    const t = procTable({ cmdline: (p) => (p === OTHER_PID ? (reused ? 'nginx: worker' : WRAPPER_CMD) : p === CLAUDE_PID ? 'claude' : null) });
    const r = await stopStuckCoordinator(db, OTHER_PID, { proc: t.proc, sleep: async () => { reused = true; } });
    expect(t.kills).toEqual([`SIGTERM ${OTHER_PID}`]); // no SIGKILL to the reused pid, nor to "its" children
    expect(r.released).toBe(true); // a non-coordinator pid no longer counts as the holder
  });

  it('never signals when the lock no longer names that pid', async () => {
    const db = new RuntimeDb(':memory:');
    const t = procTable();
    expect(await stopStuckCoordinator(db, OTHER_PID, { proc: t.proc, sleep: async () => {} })).toMatchObject({ released: true, signalled: [] });
    expect(t.kills).toEqual([]);
  });
});

// Tester (task-17): a restart where the old wrapper outlives the waits (claude ignores SIGHUP, or a slow
// MCP shutdown). One virtual clock drives the real syncCoordinator, a simulation of the new wrapper's
// lock wait inside the new tmux session, and then the real coordinatorWrapper that tmux would start.
describe('restart when the old wrapper is slow to exit', () => {
  function world(oldExitsAtMs: number, procOpts: Parameters<typeof procTable>[0] = {}) {
    const { paths } = layout();
    const db = new RuntimeDb(paths.db);
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true);
    const t = procTable(procOpts);
    let now = 0;
    const sleep = async (ms: number) => { now += ms; };
    const oldAlive = () => now < oldExitsAtMs && !t.dead.has(OTHER_PID);
    const alive = (p: number) => (p === OTHER_PID && oldAlive()) || p === process.pid;
    let session = true;
    let launchedAt = -1;
    let newWrapper: 'waiting' | 'holds' | 'refused' | null = null;
    /** The wrapper inside the new session, as seen from outside: takes the lock, or gives up after LOCK_WAIT_MS. */
    const step = () => {
      if (newWrapper !== 'waiting') return;
      try { db.acquireCoordinatorLock(TMUX_SESSION, process.pid, alive); newWrapper = 'holds'; } catch {
        if (now - launchedAt >= LOCK_WAIT_MS) { newWrapper = 'refused'; session = false; }
      }
    };
    const runner = async (_cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> => {
      step();
      if (args[0] === 'has-session') return { code: session ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') { session = false; return { code: 0, stdout: '', stderr: '' }; }
      if (args.includes('new-session')) { session = true; launchedAt = now; newWrapper = 'waiting'; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const lock = { coordinatorLock: () => { step(); return db.coordinatorLock(); } };
    const sync = () => syncCoordinator(terminalCfg(), { paths, runner, activeLeases: () => [], sleep, lock, lockAlive: alive, proc: t.proc }, { restart: true, startDetached: true });
    /** Runs the real wrapper tmux started (it already took the lock in the simulation: re-entrant). */
    const runNewWrapper = async () => {
      const { spawn, calls } = fakeSpawn();
      const result = await coordinatorWrapper(async () => terminalCfg(), {
        paths, spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: () => {}, signals: noSignals, lockWait: { alive, sleep },
      }).then((code) => ({ code }), (e: unknown) => ({ error: e }));
      session = false; // the pane's only process exited: tmux ends the session
      return { result, claudeStarted: calls.length };
    };
    return { db, t, sync, runNewWrapper, hasSession: () => session, state: () => newWrapper, launched: () => launchedAt };
  }

  it('an old wrapper that exits after its SIGTERM hands over cleanly', async () => {
    const w = world(Number.POSITIVE_INFINITY, { dieOn: ['SIGTERM'] });
    const r = await w.sync();
    expect(r).toMatchObject({ action: 'restarted', running: true, reason: expect.stringMatching(/did not exit in time and was stopped \(SIGTERM 4242\)/) });
    expect(w.state()).toBe('holds');
    expect(w.t.kills).toEqual([`SIGTERM ${OTHER_PID}`]);
    const n = await w.runNewWrapper();
    expect(n.result).toEqual({ code: 0 });
    expect(n.claudeStarted).toBe(1);
    w.db.close();
  });

  it('an old wrapper that exits during the sync wait needs no signal', async () => {
    const w = world(10_000);
    const r = await w.sync();
    expect(r).toMatchObject({ action: 'restarted', running: true });
    expect(w.t.kills).toEqual([]);
    expect(w.launched()).toBeGreaterThanOrEqual(10_000);
    w.db.close();
  });

  it('an old wrapper that never exits is stopped (SIGTERM, then SIGKILL to claude and the wrapper) and the restart really runs', async () => {
    const w = world(Number.POSITIVE_INFINITY); // claude ignores SIGHUP and SIGTERM; only SIGKILL ends it
    const r = await w.sync();
    expect(r).toMatchObject({ action: 'restarted', running: true });
    expect(r.reason).toMatch(/did not exit in time and was stopped \(SIGTERM 4242, SIGKILL 4343, SIGKILL 4242\)/);
    expect(w.t.kills).toEqual([`SIGTERM ${OTHER_PID}`, `SIGKILL ${CLAUDE_PID}`, `SIGKILL ${OTHER_PID}`]);
    expect(w.launched()).toBeGreaterThanOrEqual(LOCK_RELEASE_WAIT_MS + STUCK_TERM_WAIT_MS); // relaunched only after the stop
    expect(w.state()).toBe('holds'); // the new wrapper took the lock: no CONFLICT later
    expect(w.db.coordinatorLock()).toMatchObject({ pid: process.pid, session: TMUX_SESSION });
    expect(w.hasSession()).toBe(true);
    const n = await w.runNewWrapper();
    expect(n.result).toEqual({ code: 0 });
    expect(n.claudeStarted).toBe(1);
    w.db.close();
  });

  it('an old wrapper that cannot be verified is not signalled, and the restart fails clearly instead of relaunching', async () => {
    const w = world(Number.POSITIVE_INFINITY, { cmdline: () => null });
    const err = await w.sync().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinionsError);
    expect(err).toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/previous coordinator \(pid 4242\) did not exit.*not signalled.*not relaunched/) });
    expect(w.t.kills).toEqual([]);
    expect(w.launched()).toBe(-1); // no new session that would only fail later
    w.db.close();
  });
});

describe('wrapper signal handling releases the lock', () => {
  function signalBus() {
    const handlers = new Map<NodeJS.Signals, Set<() => void>>();
    return {
      on(s: NodeJS.Signals, h: () => void) { (handlers.get(s) ?? handlers.set(s, new Set()).get(s)!).add(h); return this; },
      removeListener(s: NodeJS.Signals, h: () => void) { handlers.get(s)?.delete(h); return this; },
      emit(s: NodeJS.Signals) { for (const h of [...(handlers.get(s) ?? [])]) h(); },
      count: () => [...handlers.values()].reduce((a, b) => a + b.size, 0),
    };
  }

  /** Fake claude that runs until it gets a signal it does not ignore. */
  function signalledChild(ignore: NodeJS.Signals[] = []) {
    const kills: string[] = [];
    let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const spawn: SpawnLike = () => ({
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') exit = cb as typeof exit; return this; },
      kill(s?: NodeJS.Signals | number) { kills.push(String(s)); if (!ignore.includes(s as NodeJS.Signals)) setImmediate(() => exit?.(null, s as NodeJS.Signals)); return true; },
    }) as unknown as ReturnType<SpawnLike>;
    return { spawn, kills };
  }

  /** Manual timer: the test fires the escalation steps itself (no real waiting). */
  function manualTimer() {
    const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const timer = (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; pending.push(t); return () => { t.cancelled = true; }; };
    const fire = (ms: number) => { for (const t of pending) if (t.ms === ms && !t.cancelled) t.fn(); };
    return { timer, pending, fire };
  }

  const started = async (paths: ReturnType<typeof layout>['paths']) => {
    for (let i = 0; i < 200; i++) { // config load, lock, spawn (real fs; no fixed sleep)
      const db = new RuntimeDb(paths.db); const l = db.coordinatorLock(); db.close();
      if (l) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('tmux kill-session (SIGHUP) is forwarded to claude; the wrapper exits 129 and releases the lock', async () => {
    const { paths } = layout();
    const bus = signalBus();
    const child = signalledChild();
    const t = manualTimer();
    const p = coordinatorWrapper(async () => terminalCfg(), { paths, spawn: child.spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: () => {}, signals: bus, timer: t.timer });
    await started(paths);
    await new Promise((r) => setImmediate(r));
    const db = new RuntimeDb(paths.db);
    expect(db.coordinatorLock()).toMatchObject({ pid: process.pid, session: TMUX_SESSION });
    bus.emit('SIGHUP');
    expect(await p).toBe(129);
    expect(child.kills).toEqual(['SIGHUP']);
    expect(db.coordinatorLock()).toBeUndefined();
    expect(bus.count()).toBe(0); // handlers removed
    expect(t.pending.every((x) => x.cancelled)).toBe(true); // escalation cancelled on exit
    t.fire(ESCALATE_TERM_MS); t.fire(ESCALATE_KILL_MS);
    expect(child.kills).toEqual(['SIGHUP']); // never signals an exited child
    db.close();
  });

  it('a claude that ignores SIGHUP and SIGTERM is escalated to SIGTERM, then SIGKILL; the wrapper exits and releases the lock', async () => {
    const { paths } = layout();
    const bus = signalBus();
    const child = signalledChild(['SIGHUP', 'SIGTERM']);
    const t = manualTimer();
    let settled = false;
    const p = coordinatorWrapper(async () => terminalCfg(), { paths, spawn: child.spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: () => {}, signals: bus, timer: t.timer }).finally(() => { settled = true; });
    await started(paths);
    await new Promise((r) => setImmediate(r));
    bus.emit('SIGHUP');
    bus.emit('SIGHUP'); // repeated signals do not stack escalations
    expect(t.pending.map((x) => x.ms)).toEqual([ESCALATE_TERM_MS, ESCALATE_KILL_MS]);
    expect(ESCALATE_KILL_MS).toBeLessThan(LOCK_RELEASE_WAIT_MS); // done before the restart stops waiting
    t.fire(ESCALATE_TERM_MS);
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(child.kills).toEqual(['SIGHUP', 'SIGHUP', 'SIGTERM']);
    const db = new RuntimeDb(paths.db);
    expect(db.coordinatorLock()).toMatchObject({ pid: process.pid });
    t.fire(ESCALATE_KILL_MS);
    expect(await p).toBe(137);
    expect(child.kills).toEqual(['SIGHUP', 'SIGHUP', 'SIGTERM', 'SIGKILL']);
    expect(db.coordinatorLock()).toBeUndefined();
    expect(bus.count()).toBe(0);
    db.close();
  });

  it('a first SIGTERM (docker stop) escalates straight to SIGKILL', async () => {
    const { paths } = layout();
    const bus = signalBus();
    const child = signalledChild(['SIGTERM']);
    const t = manualTimer();
    const p = coordinatorWrapper(async () => terminalCfg(), { paths, spawn: child.spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: bus, timer: t.timer });
    await started(paths);
    await new Promise((r) => setImmediate(r));
    bus.emit('SIGTERM');
    expect(t.pending.map((x) => x.ms)).toEqual([ESCALATE_KILL_MS]);
    t.fire(ESCALATE_KILL_MS);
    expect(await p).toBe(137);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
