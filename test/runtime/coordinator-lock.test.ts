// One coordinator per project: the wrapper (`minions coordinator run`) holds the runtime DB lock while
// claude runs. Temp state dirs and fakes only: no tmux, no claude, never the live /state DB.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { MinionsError } from '../../src/core/errors.js';
import {
  acquireCoordinatorLockWaiting, coordinatorPidAlive, coordinatorWrapper, lockSession, procStartTime, readExitRecord, syncCoordinator,
  ESCALATE_KILL_MS, ESCALATE_TERM_MS, LOCK_RELEASE_WAIT_MS, LOCK_WAIT_MS, STUCK_TERM_WAIT_MS, stopStuckCoordinator,
  TMUX_SESSION, waitForLockRelease, type ProcessControl, type SpawnLike,
} from '../../src/runtime/coordinator.js';
import { intakeOnStart, STARTUP_INTAKE_BUDGET_MS } from '../../src/runtime/commands.js';
import { pidAlive, RuntimeDb } from '../../src/runtime/db.js';
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

  it('startup work (intake sync) runs with the lock held, before claude; a failure is logged and the coordinator still starts', async () => {
    const { paths } = layout();
    const order: string[] = [];
    const logs: string[] = [];
    const { spawn, calls } = fakeSpawn(() => order.push('claude'));
    const onStart = async () => {
      const db = new RuntimeDb(paths.db); order.push(db.coordinatorLock() ? 'start:locked' : 'start:unlocked'); db.close();
      throw new Error('gh exploded');
    };
    const code = await coordinatorWrapper(async () => terminalCfg(), { paths, spawn, permissionModes: autoModes, env: { TMUX: '/tmp/tmux-1/default,1,0' }, log: (l) => logs.push(l), signals: noSignals, onStart });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(order).toEqual(['start:locked', 'claude']);
    expect(logs.join('\n')).toContain('startup step failed (the coordinator starts anyway): gh exploded');
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
    const pc = (cmd: string | null, start: string | null = null) => ({ alive: (p: number) => p === process.pid, cmdline: () => cmd, startTime: () => start });
    expect(coordinatorPidAlive(2 ** 22 + 12345, undefined, pc('node minions coordinator run'))).toBe(false);
    expect(coordinatorPidAlive(process.pid, undefined, pc('sleep 100'))).toBe(false);
    expect(coordinatorPidAlive(process.pid, undefined, pc('node /usr/local/bin/minions coordinator run --recover'))).toBe(true);
    expect(coordinatorPidAlive(process.pid, undefined, pc(null))).toBe(true);
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
function procTable(o: { dieOn?: NodeJS.Signals[]; cmdline?: (pid: number) => string | null; startTime?: (pid: number) => string | null; extra?: Record<number, { cmd: string; parent: number }> } = {}) {
  const dead = new Set<number>();
  const kills: string[] = [];
  const cmd: Record<number, string> = { [OTHER_PID]: WRAPPER_CMD, [CLAUDE_PID]: 'claude --plugin-dir /opt/minions/plugin', 777: 'sleep 100', 888: 'claude --print hi' };
  const parent: Record<number, number> = { [OTHER_PID]: 1, [CLAUDE_PID]: OTHER_PID, 777: OTHER_PID, 888: 1 };
  for (const [p, e] of Object.entries(o.extra ?? {})) { cmd[Number(p)] = e.cmd; parent[Number(p)] = e.parent; }
  const proc: ProcessControl = {
    alive: (p) => p in cmd && !dead.has(p),
    cmdline: (p) => (o.cmdline ? o.cmdline(p) : cmd[p] ?? null),
    parentOf: (p) => parent[p] ?? null,
    startTime: (p) => o.startTime?.(p) ?? null,
    pids: () => [1, OTHER_PID, CLAUDE_PID, 777, 888, ...Object.keys(o.extra ?? {}).map(Number)],
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

  /** Fake claude that runs until it gets a signal it does not ignore; `spawned` resolves when it starts. */
  function signalledChild(ignore: NodeJS.Signals[] = [], pid?: number) {
    const kills: string[] = [];
    let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    let markSpawned: () => void = () => {};
    const spawned = new Promise<void>((r) => { markSpawned = r; });
    let count = 0;
    const spawn: SpawnLike = () => {
      count++;
      markSpawned();
      return {
        pid,
        on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') exit = cb as typeof exit; return this; },
        kill(s?: NodeJS.Signals | number) { kills.push(String(s)); if (!ignore.includes(s as NodeJS.Signals)) setImmediate(() => exit?.(null, s as NodeJS.Signals)); return true; },
      } as unknown as ReturnType<SpawnLike>;
    };
    return { spawn, kills, spawned, count: () => count };
  }

  /** Manual timer: the test fires the escalation steps itself (no real waiting). */
  function manualTimer() {
    const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const timer = (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; pending.push(t); return () => { t.cancelled = true; }; };
    const fire = (ms: number) => { for (const t of pending) if (t.ms === ms && !t.cancelled) t.fn(); };
    return { timer, pending, fire };
  }

  it('tmux kill-session (SIGHUP) is forwarded to claude; the wrapper exits 129 and releases the lock', async () => {
    const { paths } = layout();
    const bus = signalBus();
    const child = signalledChild();
    const t = manualTimer();
    const p = coordinatorWrapper(async () => terminalCfg(), { paths, spawn: child.spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: () => {}, signals: bus, timer: t.timer });
    await child.spawned; // deterministic: the handlers are installed in the same tick as the spawn
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
    await child.spawned; // deterministic: the handlers are installed in the same tick as the spawn
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
    await child.spawned; // deterministic: the handlers are installed in the same tick as the spawn
    bus.emit('SIGTERM');
    expect(t.pending.map((x) => x.ms)).toEqual([ESCALATE_KILL_MS]);
    t.fire(ESCALATE_KILL_MS);
    expect(await p).toBe(137);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  // task-38: the probe window between taking the lock and spawning claude.
  describe('signals before claude starts (probe window)', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
    const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    const lockOf = (paths: ReturnType<typeof layout>['paths']) => { const db = new RuntimeDb(paths.db); const l = db.coordinatorLock(); db.close(); return l; };

    it('SIGHUP during `claude --help` releases the lock, exits 129, and never starts claude', async () => {
      vi.stubEnv('MINIONS_RUNTIME', 'container');
      const { paths } = layout();
      const bus = signalBus();
      const child = signalledChild();
      const probing = deferred<void>();
      const help = deferred<string[] | null>();
      const exits: number[] = [];
      const p = coordinatorWrapper(async () => terminalCfg(), {
        paths, spawn: child.spawn, permissionModes: () => { probing.resolve(); return help.promise; }, env: { TMUX: 'x' }, log: () => {}, signals: bus,
        exitAfterSignal: (c) => exits.push(c),
      });
      await probing.promise;
      expect(lockOf(paths)).toMatchObject({ pid: process.pid, session: TMUX_SESSION });
      expect(bus.count()).toBe(4); // SIGTERM, SIGHUP, SIGINT, SIGQUIT guarded while the probe runs
      bus.emit('SIGHUP');
      expect(await p).toBe(129);
      expect(lockOf(paths)).toBeUndefined();
      expect(bus.count()).toBe(0);
      expect(exits).toEqual([129]);
      expect(await readExitRecord(paths)).toMatchObject({ code: 129, error: 'stopped by SIGHUP before claude started' });
      help.resolve(['acceptEdits', 'auto']); // the probe finishes late: the cancelled launch stops there
      await flush();
      expect(child.count()).toBe(0);
      expect(existsSync(paths.coordinatorLaunch)).toBe(false); // a successor's launch record is never overwritten
    });

    it('Ctrl-C (SIGINT) during the Telegram probe releases the lock and exits 130', async () => {
      vi.stubEnv('MINIONS_RUNTIME', 'container');
      const { paths } = layout();
      writeFileSync(paths.telegramTokenFile, '123456789:AAHfakefakefakefakefakefakefake_-0123\n', { mode: 0o600 });
      const cfg = defaults(); cfg.communication.channel = 'telegram';
      const bus = signalBus();
      const child = signalledChild();
      const probing = deferred<void>();
      const report = deferred<never>();
      const p = coordinatorWrapper(async () => cfg, {
        paths, spawn: child.spawn, permissionModes: autoModes, probe: () => { probing.resolve(); return report.promise; }, env: {}, log: () => {}, signals: bus,
      });
      await probing.promise;
      expect(lockOf(paths)).toMatchObject({ pid: process.pid });
      bus.emit('SIGINT');
      bus.emit('SIGTERM'); // a second signal changes nothing
      expect(await p).toBe(130);
      expect(lockOf(paths)).toBeUndefined();
      expect(bus.count()).toBe(0);
      await flush();
      expect(child.count()).toBe(0);
    });

    // Merge of task-19: the GitHub startup intake runs between the lock and the spawn, inside the guard.
    it('SIGHUP during the startup intake aborts the pass, releases the lock, exits 129, and never starts claude', async () => {
      const { paths } = layout();
      const cfg = terminalCfg();
      cfg.intake.github = { enabled: true, repository: 'acme/demo', labels: [], assignee: null, milestone: null, state: 'open' };
      const bus = signalBus();
      const child = signalledChild();
      const syncing = deferred<AbortSignal>();
      const exits: number[] = [];
      const logs: string[] = [];
      // The real CLI wiring (intakeOnStart with the wrapper's stop signal) and the default 25 s budget.
      const sync = (o: { signal: AbortSignal }) => { syncing.resolve(o.signal); return new Promise<never>((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
      const t0 = Date.now();
      const p = coordinatorWrapper(async () => cfg, {
        paths, spawn: child.spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: (l) => logs.push(l), signals: bus,
        onStart: (c, l, stop) => intakeOnStart(c, l, sync, undefined, stop), exitAfterSignal: (c) => exits.push(c),
      });
      const passSignal = await syncing.promise;
      expect(lockOf(paths)).toMatchObject({ pid: process.pid, session: TMUX_SESSION });
      expect(bus.count()).toBe(4); // guarded during the intake
      bus.emit('SIGHUP');
      expect(await p).toBe(129);
      expect(Date.now() - t0).toBeLessThan(STARTUP_INTAKE_BUDGET_MS); // promptly, not after the intake budget
      expect(passSignal.aborted).toBe(true); // the intake pass is aborted with the wrapper
      expect(lockOf(paths)).toBeUndefined();
      expect(bus.count()).toBe(0);
      expect(exits).toEqual([129]);
      expect(await readExitRecord(paths)).toMatchObject({ code: 129, error: 'stopped by SIGHUP before claude started' });
      await flush();
      expect(child.count()).toBe(0);
      expect(existsSync(paths.coordinatorLaunch)).toBe(false);
    });

    it('a startup step that ignores the stop signal neither delays the exit nor starts claude when it finishes late', async () => {
      const { paths } = layout();
      const bus = signalBus();
      const child = signalledChild();
      const started = deferred<AbortSignal>();
      const finish = deferred<void>();
      const p = coordinatorWrapper(async () => terminalCfg(), {
        paths, spawn: child.spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: bus,
        onStart: async (_c, _l, stop) => { started.resolve(stop); await finish.promise; },
      });
      const stop = await started.promise;
      expect(stop.aborted).toBe(false);
      bus.emit('SIGTERM');
      expect(await p).toBe(143);
      expect(stop.aborted).toBe(true);
      expect(lockOf(paths)).toBeUndefined();
      finish.resolve(); // the step returns after the wrapper ended: runCoordinator must not run
      await flush();
      expect(child.count()).toBe(0);
      expect(existsSync(paths.coordinatorLaunch)).toBe(false);
    });

    it('without a signal the startup step gets a live stop signal and claude starts after it', async () => {
      const { paths } = layout();
      const bus = signalBus();
      const child = signalledChild();
      let seen: AbortSignal | undefined;
      const p = coordinatorWrapper(async () => terminalCfg(), {
        paths, spawn: child.spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: bus, timer: manualTimer().timer,
        onStart: async (_c, _l, stop) => { seen = stop; },
      });
      await child.spawned;
      expect(seen?.aborted).toBe(false);
      bus.emit('SIGTERM'); // forwarded to claude now, not the guard
      expect(await p).toBe(143);
      expect(child.kills).toEqual(['SIGTERM']);
    });

    it('once claude is spawned the guard is gone: the same signal is forwarded to claude instead', async () => {
      const { paths } = layout();
      const bus = signalBus();
      const child = signalledChild();
      const p = coordinatorWrapper(async () => terminalCfg(), { paths, spawn: child.spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: bus, timer: manualTimer().timer });
      await child.spawned;
      expect(bus.count()).toBe(4); // runCoordinator's handlers only (SIGINT, SIGQUIT ignored; SIGTERM, SIGHUP forwarded)
      bus.emit('SIGINT');
      bus.emit('SIGTERM');
      expect(await p).toBe(143);
      expect(child.kills).toEqual(['SIGTERM']);
      expect(await readExitRecord(paths)).toEqual(expect.not.objectContaining({ error: expect.anything() }));
    });
  });

  // task-38: SIGKILL gives claude no chance to stop its MCP servers (the Telegram poller).
  it('the SIGKILL escalation first kills claude\'s MCP descendants (deepest first, verified by /proc parent), nothing else', async () => {
    const { paths } = layout();
    const bus = signalBus();
    const order: string[] = [];
    const child = signalledChild(['SIGHUP', 'SIGTERM'], CLAUDE_PID);
    const spawn: SpawnLike = (...a) => { const c = child.spawn(...a); const kill = c.kill!.bind(c); c.kill = (s) => { order.push(`${s} claude`); return kill(s); }; return c; };
    const t = procTable({ extra: { 6001: { cmd: 'bun run --cwd /plugins/telegram start', parent: CLAUDE_PID }, 6002: { cmd: 'bun server.ts', parent: 6001 }, 6003: { cmd: 'bun other', parent: 1 } } });
    const proc: ProcessControl = { ...t.proc, kill: (p, s) => { order.push(`${s} ${p}`); t.proc.kill(p, s); } };
    const timer = manualTimer();
    const p = coordinatorWrapper(async () => terminalCfg(), { paths, spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: bus, timer: timer.timer, proc });
    await child.spawned;
    bus.emit('SIGHUP');
    timer.fire(ESCALATE_TERM_MS);
    expect(order).toEqual(['SIGHUP claude', 'SIGTERM claude']); // graceful steps leave the MCP servers to claude
    timer.fire(ESCALATE_KILL_MS);
    expect(await p).toBe(137);
    expect(order).toEqual(['SIGHUP claude', 'SIGTERM claude', 'SIGKILL 6002', 'SIGKILL 6001', 'SIGKILL claude']);
    expect(t.kills.join(' ')).not.toMatch(/6003|777|888|4242/);
  });

  it('without /proc no MCP descendant is found: only claude is killed (its servers get stdin EOF)', async () => {
    const { paths } = layout();
    const bus = signalBus();
    const child = signalledChild(['SIGTERM'], CLAUDE_PID);
    const kills: string[] = [];
    const proc: ProcessControl = { alive: () => true, cmdline: () => null, parentOf: () => null, startTime: () => null, pids: () => [], kill: (p, s) => { kills.push(`${s} ${p}`); } };
    const timer = manualTimer();
    const p = coordinatorWrapper(async () => terminalCfg(), { paths, spawn: child.spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: bus, timer: timer.timer, proc });
    await child.spawned;
    bus.emit('SIGTERM');
    timer.fire(ESCALATE_KILL_MS);
    expect(await p).toBe(137);
    expect(kills).toEqual([]);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

// task-38: the lock records the holder's process start time, so a reused pid is never the holder.
describe('lock holder identity (start time)', () => {
  const TMUX_CLIENT = 'tmux -L minions -u new-session -A -s coordinator -c /workspace/repo minions coordinator run --recover';
  const pcOf = (cmd: string | null, start: string | null) => ({ alive: () => true, cmdline: () => cmd, startTime: () => start });

  it('coordinatorPidAlive: a matching start time is the holder; a different one (pid reused) is not', () => {
    expect(coordinatorPidAlive(OTHER_PID, { start: '100' }, pcOf(WRAPPER_CMD, '100'))).toBe(true);
    expect(coordinatorPidAlive(OTHER_PID, { start: '100' }, pcOf(WRAPPER_CMD, '250'))).toBe(false);
    expect(coordinatorPidAlive(OTHER_PID, { start: '100' }, pcOf(TMUX_CLIENT, '250'))).toBe(false);
  });

  it('coordinatorPidAlive: tmux clients and `minions coordinator sync/status` never pass the cmdline check (older locks without a start time)', () => {
    for (const cmd of [TMUX_CLIENT, `/usr/bin/${TMUX_CLIENT}`, 'node /usr/local/bin/minions coordinator sync --start-detached', 'node /usr/local/bin/minions coordinator status', 'node /usr/local/bin/minions coordinator restart --recover']) {
      expect(coordinatorPidAlive(OTHER_PID, undefined, pcOf(cmd, null)), cmd).toBe(false);
      expect(coordinatorPidAlive(OTHER_PID, { start: '100' }, pcOf(cmd, '100')), cmd).toBe(false);
    }
    expect(coordinatorPidAlive(OTHER_PID, undefined, pcOf(WRAPPER_CMD, null))).toBe(true);
  });

  it('without /proc (macOS host runtime) a live pid stays the holder: a second coordinator is refused, not signalled', () => {
    expect(coordinatorPidAlive(OTHER_PID, { start: '100' }, pcOf(null, null))).toBe(true);
  });

  it('reads the real start time from /proc where it exists', () => {
    const start = procStartTime(process.pid);
    if (!existsSync('/proc/self/stat')) { expect(start).toBeNull(); return; }
    expect(start).toMatch(/^\d+$/);
    expect(procStartTime(process.pid)).toBe(start); // stable for the process lifetime
    const pc = { alive: pidAlive, cmdline: () => WRAPPER_CMD, startTime: procStartTime };
    expect(coordinatorPidAlive(process.pid, { start: start! }, pc)).toBe(true);
    expect(coordinatorPidAlive(process.pid, { start: String(Number(start) + 1) }, pc)).toBe(false);
  });

  it('the wrapper records its start time in the lock', async () => {
    const db = new RuntimeDb(':memory:');
    const l = await acquireCoordinatorLockWaiting(db, { pid: process.pid, session: 's' });
    expect(l.start).toBe(procStartTime(process.pid) ?? undefined);
    expect(db.coordinatorLock()).toEqual(l);
    expect((await acquireCoordinatorLockWaiting(new RuntimeDb(':memory:'), { pid: process.pid, session: 's', start: null })).start).toBeUndefined();
  });

  it('a holder pid reused by a tmux client is taken over without waiting', async () => {
    const db = new RuntimeDb(':memory:');
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true, '100');
    expect(db.coordinatorLock()).toMatchObject({ pid: OTHER_PID, start: '100' });
    const sleeps: number[] = [];
    const l = await acquireCoordinatorLockWaiting(db, {
      pid: NEW_PID, session: TMUX_SESSION, start: '900', alive: (p, lock) => coordinatorPidAlive(p, lock, pcOf(TMUX_CLIENT, '777')), sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(l).toMatchObject({ pid: NEW_PID, start: '900' });
    expect(sleeps).toEqual([]);
  });

  it('stopStuckCoordinator never signals a holder pid whose start time differs or cannot be read', async () => {
    for (const startTime of [(p: number) => (p === OTHER_PID ? '250' : null), () => null]) {
      const db = new RuntimeDb(':memory:');
      db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true, '100');
      const t = procTable({ startTime });
      const r = await stopStuckCoordinator(db, OTHER_PID, { proc: t.proc, alive: () => true, sleep: async () => {} });
      expect(r).toEqual({ released: false, signalled: [], verified: false });
      expect(t.kills).toEqual([]);
    }
  });

  it('stopStuckCoordinator with a matching start time stops the wrapper, its claude, and claude\'s MCP servers first', async () => {
    const db = new RuntimeDb(':memory:');
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true, '100');
    const t = procTable({ startTime: (p) => (p === OTHER_PID ? '100' : null), extra: { 6001: { cmd: 'bun server.ts', parent: CLAUDE_PID } } });
    const r = await stopStuckCoordinator(db, OTHER_PID, { proc: t.proc, sleep: async () => {} });
    expect(r).toMatchObject({ released: true, verified: true, signalled: [`SIGTERM ${OTHER_PID}`, 'SIGKILL 6001', `SIGKILL ${CLAUDE_PID}`, `SIGKILL ${OTHER_PID}`] });
  });
});
