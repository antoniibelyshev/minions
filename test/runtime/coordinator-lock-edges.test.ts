// Task-40 follow-ups to the task-38 coordinator lock review: the pre-spawn guard is installed before the
// lock is awaited, a signal during the lock wait ends it without taking the lock, and a re-entrant
// acquire by a reused pid (different start time) is a new holder. Fakes and temp state dirs only:
// no tmux, no claude, never the live /state DB. No real timers: every wait is a deferred the test drives.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import {
  acquireCoordinatorLockWaiting, coordinatorWrapper, LockWaitAborted, readExitRecord, syncCoordinator, TMUX_SESSION,
  type CoordinatorLockStore, type SpawnLike,
} from '../../src/runtime/coordinator.js';
import { RuntimeDb, type CoordinatorLock } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const terminalCfg = () => { const c = defaults(); c.communication.channel = 'terminal'; return c; };
const autoModes = async () => ['acceptEdits', 'auto'];
const OTHER_PID = 4242;
const NEW_PID = 5151;

function layout() {
  const root = tmp('minions-lock-edges-');
  for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  return {
    ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
    pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
  };
}

function signalBus() {
  const handlers = new Map<NodeJS.Signals, Set<() => void>>();
  return {
    on(s: NodeJS.Signals, h: () => void) { (handlers.get(s) ?? handlers.set(s, new Set()).get(s)!).add(h); return this; },
    removeListener(s: NodeJS.Signals, h: () => void) { handlers.get(s)?.delete(h); return this; },
    emit(s: NodeJS.Signals) { for (const h of [...(handlers.get(s) ?? [])]) h(); },
    count: () => [...handlers.values()].reduce((a, b) => a + b.size, 0),
  };
}

/** Fake claude: counts spawns; exits on the first signal it is sent. */
function fakeChild() {
  let count = 0;
  let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const spawn: SpawnLike = () => {
    count++;
    return {
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') exit = cb as typeof exit; return this; },
      kill(s?: NodeJS.Signals | number) { setImmediate(() => exit?.(null, s as NodeJS.Signals)); return true; },
    } as unknown as ReturnType<SpawnLike>;
  };
  return { spawn, count: () => count };
}

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

/** Lock store over a real in-memory DB that lets the test act at the moment of each acquire attempt. */
function observedStore(db: RuntimeDb, onAttempt: (n: number) => void): CoordinatorLockStore & { attempts: () => number } {
  let n = 0;
  return {
    coordinatorLock: () => db.coordinatorLock(),
    releaseCoordinatorLock: (s, p) => db.releaseCoordinatorLock(s, p),
    acquireCoordinatorLock: (s, p, a, st) => { onAttempt(++n); return db.acquireCoordinatorLock(s, p, a, st); },
    attempts: () => n,
  };
}

describe('pre-spawn guard covers the lock wait (task-40)', () => {
  it('the guard is installed before the first lock attempt', async () => {
    const paths = layout();
    const db = new RuntimeDb(':memory:');
    const bus = signalBus();
    const child = fakeChild();
    const listenersAtAttempt: number[] = [];
    const store = observedStore(db, () => { listenersAtAttempt.push(bus.count()); });
    const p = coordinatorWrapper(async () => terminalCfg(), { paths, lock: store, spawn: child.spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: bus });
    await new Promise((r) => setImmediate(r));
    expect(listenersAtAttempt).toEqual([4]); // SIGTERM, SIGHUP, SIGINT, SIGQUIT are guarded when the lock is taken
    for (let i = 0; i < 20 && child.count() === 0; i++) await new Promise((r) => setImmediate(r));
    bus.emit('SIGTERM'); // claude runs now: forwarded, the wrapper exits with it
    expect(await p).toBe(143);
    expect(db.coordinatorLock()).toBeUndefined();
  });

  it('a signal that arrives while the lock is being taken releases it, runs no startup step, and never spawns claude', async () => {
    const paths = layout();
    const db = new RuntimeDb(':memory:');
    const bus = signalBus();
    const child = fakeChild();
    const exits: number[] = [];
    let onStartRan = false;
    // The signal lands in the same tick as the (successful) acquire: before the wrapper's await resumes.
    const store = observedStore(db, () => { queueMicrotask(() => bus.emit('SIGHUP')); });
    const code = await coordinatorWrapper(async () => terminalCfg(), {
      paths, lock: store, spawn: child.spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: () => {}, signals: bus,
      onStart: async () => { onStartRan = true; }, exitAfterSignal: (c) => exits.push(c),
    });
    expect(code).toBe(129);
    expect(store.attempts()).toBe(1);
    expect(db.coordinatorLock()).toBeUndefined(); // taken, then released
    expect(onStartRan).toBe(false);
    expect(child.count()).toBe(0);
    expect(bus.count()).toBe(0);
    expect(exits).toEqual([129]);
    expect(await readExitRecord(paths)).toMatchObject({ code: 129, error: 'stopped by SIGHUP before claude started' });
    expect(existsSync(paths.coordinatorLaunch)).toBe(false);
  });

  it('Ctrl-C while waiting for a previous holder ends the wait at once: the holder keeps its lock, exit 130, no claude', async () => {
    const paths = layout();
    const db = new RuntimeDb(':memory:');
    db.acquireCoordinatorLock(TMUX_SESSION, OTHER_PID, () => true, '100');
    const holder = db.coordinatorLock();
    const bus = signalBus();
    const child = fakeChild();
    const exits: number[] = [];
    const sleeping = deferred<void>();
    const store = observedStore(db, () => {});
    const p = coordinatorWrapper(async () => terminalCfg(), {
      paths, lock: store, spawn: child.spawn, permissionModes: autoModes, env: { TMUX: 'x' }, log: () => {}, signals: bus,
      // A live holder and a poll sleep that never ends by itself: only the signal can end the wait.
      lockWait: { alive: () => true, sleep: () => { sleeping.resolve(); return new Promise<void>(() => {}); } },
      exitAfterSignal: (c) => exits.push(c),
    });
    await sleeping.promise;
    expect(bus.count()).toBe(4);
    bus.emit('SIGINT');
    expect(await p).toBe(130);
    expect(store.attempts()).toBe(1); // no attempt after the signal
    expect(db.coordinatorLock()).toEqual(holder); // never taken over, never released by us
    expect(child.count()).toBe(0);
    expect(bus.count()).toBe(0);
    expect(exits).toEqual([130]);
    expect(await readExitRecord(paths)).toMatchObject({ code: 130, error: 'stopped by SIGINT before claude started' });
  });

  it('acquireCoordinatorLockWaiting: an aborted signal stops before the first attempt and during the poll sleep', async () => {
    const db = new RuntimeDb(':memory:');
    const pre = new AbortController(); pre.abort();
    const store = observedStore(db, () => {});
    await expect(acquireCoordinatorLockWaiting(store, { pid: process.pid, session: 's', signal: pre.signal })).rejects.toBeInstanceOf(LockWaitAborted);
    expect(store.attempts()).toBe(0);
    expect(db.coordinatorLock()).toBeUndefined();

    db.acquireCoordinatorLock('s', OTHER_PID, () => true);
    const ctl = new AbortController();
    const waiting = acquireCoordinatorLockWaiting(store, { pid: process.pid, session: 's', alive: () => true, signal: ctl.signal,
      sleep: () => { queueMicrotask(() => ctl.abort()); return new Promise<void>(() => {}); } });
    await expect(waiting).rejects.toBeInstanceOf(LockWaitAborted);
    expect(store.attempts()).toBe(1);
    expect(db.coordinatorLock()).toMatchObject({ pid: OTHER_PID });
    // Without an abort the wait is unchanged: the lock is taken once the holder is gone.
    let gone = false;
    const l = await acquireCoordinatorLockWaiting(store, { pid: process.pid, session: 's', alive: () => !gone, signal: new AbortController().signal, sleep: async () => { gone = true; } });
    expect(l).toMatchObject({ pid: process.pid, session: 's' });
  });
});

describe('re-entrant acquire by a reused pid (task-40)', () => {
  const setLock = (db: RuntimeDb, lock: CoordinatorLock) => db.setMeta('coordinator_lock', JSON.stringify(lock));

  it('same pid and session with a different start time is a new holder: fresh acquiredAt, new start, a lock event', () => {
    const db = new RuntimeDb(':memory:');
    setLock(db, { pid: process.pid, session: 's', acquiredAt: 'old', start: '100' });
    const before = db.lastEventId();
    // The default liveness (pid exists) would call our own pid alive: a differing start must not be a CONFLICT with ourselves.
    const l = db.acquireCoordinatorLock('s', process.pid, undefined, '200');
    expect(l).toMatchObject({ pid: process.pid, session: 's', start: '200' });
    expect(l.acquiredAt).not.toBe('old');
    expect(db.coordinatorLock()).toEqual(l);
    expect(db.lastEventId()).toBe(before + 1);
  });

  it('same pid, session and start (or a start unknown on either side) stays re-entrant: acquiredAt kept, no event', () => {
    for (const [prior, next] of [['100', '100'], [undefined, '100'], ['100', null]] as const) {
      const db = new RuntimeDb(':memory:');
      setLock(db, { pid: process.pid, session: 's', acquiredAt: 'old', ...(prior ? { start: prior } : {}) });
      const before = db.lastEventId();
      const l = db.acquireCoordinatorLock('s', process.pid, () => true, next);
      expect(l.acquiredAt, `${prior}/${next}`).toBe('old');
      expect(db.lastEventId()).toBe(before);
    }
  });

  it('syncCoordinator sees the handover when the new wrapper reuses the stale holder\'s pid with another start time', async () => {
    const paths = layout();
    const db = new RuntimeDb(paths.db);
    setLock(db, { pid: NEW_PID, session: TMUX_SESSION, acquiredAt: 'old', start: '1' });
    let alive = false;
    const runner = async (_cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
      if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
      if (args.includes('new-session')) {
        alive = true;
        db.acquireCoordinatorLock(TMUX_SESSION, NEW_PID, () => true, '2'); // the new wrapper, same pid, new process
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const r = await syncCoordinator(terminalCfg(), { paths, runner, activeLeases: () => [], sleep: async () => {}, lock: db, lockAlive: () => true }, { startDetached: true });
    expect(r).toMatchObject({ running: true });
    expect(r.reason).not.toMatch(/not taken the project lock/);
    db.close();
  });
});
