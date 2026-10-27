// The unattended routine pass (task-68.2, docs/design/unattended-delivery.md phase 1): the pure wake decision, the
// pass with its lock, interval, events and wake/crash-start actions, and the wrapper clock. Everything runs with
// fakes: a fake gh (real syncTasks), a fake clock, a fake restart spawn. No tmux, claude or network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import type { RoutineLock } from '../../src/runtime/db.js';
import { syncTasks } from '../../src/runtime/ci.js';
import { scheduleCrashStart, scheduleDetachedRestart, WAKE_PROMPT, buildCoordinatorCommand, type DetachedSpawn } from '../../src/runtime/coordinator.js';
import { LAST_OWNER_MESSAGE_META } from '../../src/runtime/coordinator-usage.js';
import { TRANSCRIPT_META } from '../../src/runtime/context-reset.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import type { GhFn } from '../../src/runtime/publish.js';
import {
  collectWakeReasons, coordinatorIdleSince, CRASH_START_EVENT, decideWake, endedByCrash, humanRoutine, humanRoutineReport, MAX_CRASH_STARTS_PER_DAY,
  ROUTINE_EVENT, routineLast, routineSettings, runRoutinePass, startRoutineClock, summarizeSync, WAKE_EVENT,
  type CoordinatorView, type RoutinePassDeps, type RoutineSettings, type WakeInputs, type WakeReason,
} from '../../src/runtime/routine.js';
import { makeEnv, tmp } from './fixtures.js';

const T0 = new Date('2026-10-27T12:00:00.000Z');
const ago = (min: number, from = T0) => new Date(from.getTime() - min * 60_000).toISOString();
const ON: RoutineSettings = { enabled: true, tickMinutes: 15, minWakeGapMinutes: 30, maxWakesPerDay: 8 };
const running = (over: Partial<CoordinatorView> = {}): CoordinatorView => ({ running: true, lockAcquiredAt: ago(120), staleLock: false, exit: null, lastRestartAt: null, ...over });
const down = (over: Partial<CoordinatorView> = {}): CoordinatorView => ({ running: false, lockAcquiredAt: null, staleLock: false, exit: null, lastRestartAt: null, ...over });
const runnable: WakeReason = { kind: 'runnable', taskId: 'task-1', role: 'engineer', detail: 'task-1 engineer runnable' };
const digest: WakeReason = { kind: 'digest', detail: 'digest 08:00 due' };

const inputs = (over: Partial<WakeInputs> = {}): WakeInputs => ({
  now: T0, settings: ON, coordinator: running(), activeLeases: [], drain: null, startsPaused: false, budgetExhausted: false,
  reasons: [runnable], idleSince: ago(20), lastOwnerMessageAt: ago(90), wakesToday: 0, lastWakeAt: null, crashStartsToday: 0, ...over,
});

describe('routine settings', () => {
  it('unset = off with the defaults; set fields win', () => {
    expect(routineSettings({})).toEqual({ enabled: false, tickMinutes: 15, minWakeGapMinutes: 30, maxWakesPerDay: 8 });
    expect(routineSettings({ routine: { enabled: true, tickMinutes: 5 } })).toEqual({ enabled: true, tickMinutes: 5, minWakeGapMinutes: 30, maxWakesPerDay: 8 });
  });
});

describe('decideWake (pure)', () => {
  it('wakes an idle running coordinator for a runnable stage within every limit', () => {
    expect(decideWake(inputs())).toMatchObject({ action: 'wake', digest: false });
  });

  it.each<[string, Partial<WakeInputs>, RegExp]>([
    ['routine off', { settings: { ...ON, enabled: false } }, /routine.enabled is off/],
    ['nothing needs a model', { reasons: [] }, /nothing needs a model/],
    ['an active lease (never restart under a worker)', { activeLeases: ['lease-1'] }, /1 active worker lease/],
    ['a drain', { drain: { reason: 'upgrade' } }, /drain is in progress/],
    ['starts paused', { startsPaused: true }, /starts are paused/],
    ['an owner message 10 min ago', { lastOwnerMessageAt: ago(10) }, /owner wrote 10 min ago/],
    ['transcript active 3 min ago', { idleSince: ago(3) }, /active 3 min ago/],
    ['the wake gap', { lastWakeAt: ago(20) }, /minWakeGapMinutes 30/],
    ['the daily cap', { wakesToday: 8 }, /wake limit reached \(8\/8/],
    ['the budget used up', { budgetExhausted: true }, /only the digest wakes/],
  ])('no wake: %s', (_n, over, why) => {
    const d = decideWake(inputs(over));
    expect(d.action).toBe('none');
    expect(d.why).toMatch(why);
  });

  it('the digest wake passes the budget, the gap and the daily cap, but never an active lease or a live conversation', () => {
    expect(decideWake(inputs({ reasons: [runnable, digest], budgetExhausted: true, wakesToday: 8, lastWakeAt: ago(5) }))).toMatchObject({ action: 'wake', digest: true });
    expect(decideWake(inputs({ reasons: [digest], activeLeases: ['l'] })).action).toBe('none');
    expect(decideWake(inputs({ reasons: [digest], lastOwnerMessageAt: ago(1) })).action).toBe('none');
    expect(decideWake(inputs({ reasons: [digest], startsPaused: true })).action).toBe('wake');
  });

  it('an idle-since of null (no session state) is idle; an owner message never recorded is no conversation', () => {
    expect(decideWake(inputs({ idleSince: null, lastOwnerMessageAt: null })).action).toBe('wake');
  });

  it('a coordinator that is not running starts only after a crash', () => {
    expect(decideWake(inputs({ coordinator: down({ exit: { at: ago(5), code: 0 } }) }))).toMatchObject({ action: 'none', why: expect.stringMatching(/stopped \(exit code 0/) });
    expect(decideWake(inputs({ coordinator: down({ exit: { at: ago(5), code: 130 } }) })).action).toBe('none'); // Ctrl-C
    expect(decideWake(inputs({ coordinator: down({ exit: { at: ago(5), code: 129 } }) })).action).toBe('none'); // tmux kill-session
    expect(decideWake(inputs({ coordinator: down({ exit: { at: ago(5), code: 143, error: 'stopped by SIGTERM before claude started' } }) })).action).toBe('none');
    expect(decideWake(inputs({ coordinator: down() })).why).toMatch(/no crash is recorded/);
    expect(decideWake(inputs({ coordinator: down({ exit: { at: ago(5), code: 1 } }) }))).toMatchObject({ action: 'crash-start', why: expect.stringMatching(/crashed \(exit code 1.*1\/2 today/) });
    expect(decideWake(inputs({ coordinator: down({ staleLock: true }) })).action).toBe('crash-start');
  });

  it('a crash start refuses during a drain or upgrade, a restart in progress, at 100% budget, and after 2 a day', () => {
    const crashed = down({ exit: { at: ago(5), code: 137 } });
    expect(decideWake(inputs({ coordinator: crashed, drain: { reason: 'upgrade in progress: change request cr_1' } })).why).toMatch(/drain is in progress/);
    expect(decideWake(inputs({ coordinator: { ...crashed, lastRestartAt: ago(2) } })).why).toMatch(/restart is in progress/);
    expect(decideWake(inputs({ coordinator: crashed, budgetExhausted: true })).why).toMatch(/budget is used up/);
    expect(decideWake(inputs({ coordinator: crashed, crashStartsToday: MAX_CRASH_STARTS_PER_DAY })).why).toMatch(/limit reached \(2\/2/);
    // Leases left by the crashed session do not block the crash start: nothing runs that it could kill.
    expect(decideWake(inputs({ coordinator: crashed, activeLeases: ['l1'] })).action).toBe('crash-start');
  });

  it('endedByCrash: stop codes and stopped-before-start are not crashes', () => {
    expect(endedByCrash({ exit: { at: 'x', code: 143 }, staleLock: false }).crash).toBe(false);
    expect(endedByCrash({ exit: { at: 'x', code: 2, error: 'boom' }, staleLock: false })).toMatchObject({ crash: true, why: expect.stringMatching(/boom/) });
  });
});

/** A routine pass over a real DB with a fake clock, fake sync, fake next and fake restarts. */
function passEnv(over: Partial<RoutinePassDeps> = {}) {
  const env = makeEnv((c) => { c.routine = { enabled: true }; });
  let now = T0;
  const calls = { wake: 0, crash: 0, sync: 0 };
  let coordinator = running();
  const deps: RoutinePassDeps = {
    db: env.db, config: env.config, now: () => now, pid: 1111, procStart: () => 's1', lockAlive: () => true,
    sync: async () => { calls.sync++; return { intakeCreated: 0, synced: 1, failed: 0, statusChanges: 0, merged: 0, armed: 0, errors: [] }; },
    next: async () => ({ runnable: [] }),
    coordinator: async () => coordinator,
    activeLeases: async () => [],
    budgetExhausted: () => false,
    wake: async () => { calls.wake++; return 'wake scheduled'; },
    crashStart: async () => { calls.crash++; return 'start scheduled'; },
    ...over,
  };
  return {
    env, deps, calls,
    setNow: (d: Date) => { now = d; },
    setCoordinator: (c: CoordinatorView) => { coordinator = c; },
  };
}

const runnableNext = async () => ({ runnable: [{ taskId: 'task-1', role: 'engineer' }] as never });

describe('runRoutinePass', () => {
  it('runs sync, records a routine event with counts and the decision, and shows last/next', async () => {
    const t = passEnv();
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r).toMatchObject({ ran: true, trigger: 'clock', sync: { synced: 1 }, decision: { action: 'none', why: 'nothing needs a model' }, nextAt: '2026-10-27T12:15:00.000Z' });
    const ev = t.env.db.lastEventOfKind(ROUTINE_EVENT)!;
    expect(ev.data).toMatchObject({ trigger: 'clock', sync: { synced: 1 }, decision: { action: 'none' } });
    const last = routineLast(t.env.db, t.env.config, T0);
    expect(last).toMatchObject({ enabled: true, tickMinutes: 15, last: { trigger: 'clock' }, nextAt: expect.stringMatching(/T12:15:00/) });
    expect(humanRoutine(last)).toMatch(/routine: every 15 min; last pass .* next 2026-10-27T12:15/);
    expect(humanRoutineReport(r)).toMatch(/synced 1, failed 0/);
    expect(t.env.db.routineLock()).toBeNull(); // released
  });

  it('routine off: clock and watchdog do nothing; a manual pass syncs but never wakes', async () => {
    const t = passEnv({ next: runnableNext });
    t.env.config.routine = undefined;
    expect(await runRoutinePass(t.deps, { trigger: 'clock' })).toMatchObject({ ran: false, skipped: 'disabled', nextAt: null });
    expect(await runRoutinePass(t.deps, { trigger: 'watchdog' })).toMatchObject({ ran: false, skipped: 'disabled' });
    expect(t.calls.sync).toBe(0);
    const m = await runRoutinePass(t.deps, { trigger: 'manual' });
    expect(m).toMatchObject({ ran: true, decision: { action: 'none', why: 'routine.enabled is off' } });
    expect(t.calls).toMatchObject({ sync: 1, wake: 0 });
  });

  it('interval: at most once per half tick unless --force; the watchdog only after 2 ticks', async () => {
    const t = passEnv();
    await runRoutinePass(t.deps, { trigger: 'clock' });
    t.env.db.exec(`UPDATE events SET at = ? WHERE kind = 'routine'`, ago(5));
    expect(await runRoutinePass(t.deps, { trigger: 'clock' })).toMatchObject({ ran: false, skipped: 'interval' });
    expect(await runRoutinePass(t.deps, { trigger: 'manual', force: true })).toMatchObject({ ran: true });
    t.env.db.exec(`UPDATE events SET at = ? WHERE kind = 'routine'`, ago(29));
    expect(await runRoutinePass(t.deps, { trigger: 'watchdog' })).toMatchObject({ ran: false, skipped: 'fresh' });
    expect(await runRoutinePass(t.deps, { trigger: 'watchdog', force: true })).toMatchObject({ ran: false, skipped: 'fresh' }); // no force for the watchdog
    t.env.db.exec(`UPDATE events SET at = ? WHERE kind = 'routine'`, ago(31));
    expect(await runRoutinePass(t.deps, { trigger: 'watchdog' })).toMatchObject({ ran: true, trigger: 'watchdog' });
  });

  it('the lock refuses a second pass while its live holder runs; a dead or reused holder is taken over', async () => {
    const t = passEnv();
    const alive = new Set<number>([2222]);
    t.deps.lockAlive = (l: RoutineLock) => alive.has(l.pid) && l.start === 's2';
    expect(t.env.db.acquireRoutineLock(2222, 's2', () => false, T0)).not.toBeNull();
    expect(await runRoutinePass(t.deps, { trigger: 'clock' })).toMatchObject({ ran: false, skipped: 'locked', why: expect.stringMatching(/pid 2222/) });
    t.env.db.exec(`UPDATE meta SET value = ? WHERE key = 'routine_lock'`, JSON.stringify({ pid: 2222, start: 'old', at: T0.toISOString() })); // reused pid
    expect(await runRoutinePass(t.deps, { trigger: 'clock' })).toMatchObject({ ran: true });
    alive.clear();
    t.env.db.acquireRoutineLock(2222, 's2', () => false, T0);
    t.env.db.exec(`DELETE FROM events WHERE kind = 'routine'`);
    expect(await runRoutinePass(t.deps, { trigger: 'clock' })).toMatchObject({ ran: true });
  });

  it('a failing sync is recorded and the pass still decides', async () => {
    const t = passEnv({ sync: async () => { throw new Error('gh down'); }, next: runnableNext });
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r).toMatchObject({ ran: true, syncError: 'gh down', decision: { action: 'wake' } });
  });

  it('wakes through the fake restart, records routine-wake, then the gap and the daily cap hold', async () => {
    const t = passEnv({ next: runnableNext });
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r).toMatchObject({ decision: { action: 'wake' }, outcome: { ok: true, detail: 'wake scheduled' }, reasons: [{ kind: 'runnable', taskId: 'task-1' }] });
    expect(t.env.db.eventsOfKindSince(WAKE_EVENT, ago(60))).toHaveLength(1);
    expect(routineLast(t.env.db, t.env.config, T0)).toMatchObject({ wakesToday: 1, last: { reasons: [{ kind: 'runnable' }] } });
    t.setNow(new Date(T0.getTime() + 15 * 60_000));
    expect(await runRoutinePass(t.deps, { trigger: 'clock' })).toMatchObject({ decision: { action: 'none', why: expect.stringMatching(/last wake 15 min ago/) } });
    expect(t.calls.wake).toBe(1);
    t.env.config.routine = { enabled: true, maxWakesPerDay: 1 };
    t.setNow(new Date(T0.getTime() + 60 * 60_000));
    expect(await runRoutinePass(t.deps, { trigger: 'clock' })).toMatchObject({ decision: { action: 'none', why: expect.stringMatching(/wake limit reached \(1\/1/) } });
  });

  it('a refused wake (a lease appeared) is reported and not counted', async () => {
    const t = passEnv({ next: runnableNext, wake: async () => { throw new Error('Coordinator restart refused: 1 active worker lease(s) (l1).'); } });
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r.outcome).toMatchObject({ ok: false, detail: expect.stringMatching(/refused/) });
    expect(t.env.db.eventsOfKindSince(WAKE_EVENT, ago(60))).toHaveLength(0);
  });

  it('owner activity and transcript activity block the wake (recorded owner message time, transcript mtime)', async () => {
    const t = passEnv({ next: runnableNext, mtime: () => Date.parse(ago(2)) });
    t.env.db.setMeta(TRANSCRIPT_META, JSON.stringify({ path: '/x/t.jsonl', at: ago(30) }));
    expect((await runRoutinePass(t.deps, { trigger: 'clock' })).decision!.why).toMatch(/active 2 min ago/);
    t.deps.mtime = () => Date.parse(ago(40));
    t.env.db.setMeta(LAST_OWNER_MESSAGE_META, ago(12));
    expect((await runRoutinePass(t.deps, { trigger: 'manual', force: true })).decision!.why).toMatch(/owner wrote 12 min ago/);
    t.env.db.setMeta(LAST_OWNER_MESSAGE_META, ago(45));
    expect((await runRoutinePass(t.deps, { trigger: 'manual', force: true })).decision!.action).toBe('wake');
  });

  it('crash start: separate path, recorded, at most 2 a day', async () => {
    const t = passEnv();
    t.setCoordinator(down({ exit: { at: ago(30), code: 1 } }));
    for (let i = 0; i < 3; i++) {
      t.setNow(new Date(T0.getTime() + i * 20 * 60_000));
      await runRoutinePass(t.deps, { trigger: 'watchdog', force: true });
      t.env.db.exec(`UPDATE events SET at = ? WHERE kind = 'routine'`, ago(60, new Date(T0.getTime() + i * 20 * 60_000)));
    }
    expect(t.calls).toMatchObject({ crash: 2, wake: 0 });
    expect(t.env.db.eventsOfKindSince(CRASH_START_EVENT, ago(600))).toHaveLength(2);
    expect(routineLast(t.env.db, t.env.config, T0).last!.decision).toMatchObject({ action: 'none', why: expect.stringMatching(/limit reached \(2\/2/) });
  });

  it('a watchdog report carries the coordinator state for "not running since"', async () => {
    const t = passEnv();
    t.setCoordinator(down({ exit: { at: ago(45), code: 0 } }));
    const r = await runRoutinePass(t.deps, { trigger: 'watchdog' });
    expect(r.coordinator).toEqual({ running: false, since: ago(45) });
    expect(r.decision!.action).toBe('none');
  });

  it('an upgrade in progress is treated like a drain', async () => {
    const t = passEnv({ upgradeInProgress: () => 'change request cr_12345678' });
    t.setCoordinator(down({ staleLock: true }));
    expect((await runRoutinePass(t.deps, { trigger: 'clock' })).decision!.why).toMatch(/upgrade in progress: change request cr_12345678/);
    expect(t.calls.crash).toBe(0);
  });
});

describe('wake reasons', () => {
  it('runnable stages, plus unvalidated / needs_split results and awaiting-human records since the coordinator was last active', () => {
    const t = passEnv();
    const db = t.env.db;
    const ins = (id: string, task: string, status: string, ended: string, result: unknown) => db.exec(
      'INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, ended_at, status, result_json) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)',
      id, task, 'engineer', ago(200), ended, status, JSON.stringify(result));
    ins('l-old', 'task-0', 'unvalidated', ago(100), {});
    ins('l-unv', 'task-2', 'unvalidated', ago(5), {});
    ins('l-split', 'task-3', 'completed', ago(5), { status: 'needs_split' });
    ins('l-done', 'task-4', 'completed', ago(5), { status: 'complete' });
    db.exec('INSERT INTO events (at, kind, task_id, data_json) VALUES (?, ?, ?, ?)', ago(4), 'record', 'task-5', JSON.stringify({ leaseId: 'l5', to: 'awaiting-human' }));
    db.exec('INSERT INTO events (at, kind, task_id, data_json) VALUES (?, ?, ?, ?)', ago(4), 'record', 'task-6', JSON.stringify({ leaseId: 'l6', to: 'reviewing' }));
    const r = collectWakeReasons(db, { runnable: [{ taskId: 'task-1', role: 'tester' }] as never }, ago(30));
    expect(r.map((x) => [x.kind, 'taskId' in x ? x.taskId : null])).toEqual([
      ['runnable', 'task-1'], ['unvalidated', 'task-2'], ['needs-split', 'task-3'], ['awaiting-human', 'task-5'],
    ]);
  });

  it('idle since: the transcript of this session, else the lock time', () => {
    const t = passEnv();
    const c = running({ lockAcquiredAt: ago(60) });
    expect(coordinatorIdleSince(t.env.db, c)).toBe(ago(60)); // no transcript record
    t.env.db.setMeta(TRANSCRIPT_META, JSON.stringify({ path: '/x.jsonl', at: ago(90) })); // previous session's
    expect(coordinatorIdleSince(t.env.db, c)).toBe(ago(60));
    t.env.db.setMeta(TRANSCRIPT_META, JSON.stringify({ path: '/x.jsonl', at: ago(20) }));
    expect(coordinatorIdleSince(t.env.db, c, () => Date.parse(ago(7)))).toBe(ago(7));
    expect(coordinatorIdleSince(t.env.db, c, () => null)).toBe(ago(20));
  });
});

describe('the pass sync step with a fake gh (real syncTasks)', () => {
  it('a merged PR closes its task as done and is counted in the routine event', async () => {
    const t = passEnv();
    const url = 'https://github.com/acme/demo/pull/7';
    t.env.backlog.add({ id: 'task-7', status: 'delivered', prUrl: url });
    const pr = { url, state: 'MERGED', isDraft: false, headRefOid: 'a'.repeat(40), baseRefName: 'main', mergedAt: '2026-10-27T11:00:00Z', closedAt: null, mergeStateStatus: 'CLEAN', statusCheckRollup: [] };
    const calls: string[][] = [];
    const gh: GhFn = async (args): Promise<RunResult> => { calls.push(args); return args[0] === 'pr' && args[1] === 'view' && args[2] === url ? { code: 0, stdout: JSON.stringify(pr), stderr: '' } : { code: 1, stdout: '', stderr: 'unexpected' }; };
    t.deps.sync = async () => summarizeSync(await syncTasks({ db: t.env.db, backlog: t.env.backlog, config: t.env.config, gh }), null);
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r.sync).toMatchObject({ synced: 1, statusChanges: 1, merged: 1, failed: 0 });
    expect(t.env.backlog.status('task-7')).toBe('done');
    expect(calls.every((c) => c[0] === 'pr' && c[1] === 'view')).toBe(true); // read-only
  });
});

describe('restart paths (fake spawn)', () => {
  const spawnRec = () => {
    const calls: string[][] = [];
    const spawn: DetachedSpawn = (_c, a) => { calls.push(a); return { pid: 99, unref() {}, on() { return this; } }; };
    return { calls, spawn };
  };
  // A real log file: the restart closes the fd it opened (fd 0 here would close the worker's stdin and abort node).
  const base = { log: join(tmp('minions-restart-log-'), 'restart.log'), cwd: '/' };

  it('the wake is `coordinator restart --wake`, never --force, and refuses with an active lease or a drain', () => {
    const s = spawnRec();
    scheduleDetachedRestart({ ...base, spawn: s.spawn, activeLeases: () => [], drain: () => null }, { wake: true });
    expect(s.calls).toEqual([['coordinator', 'restart', '--wake']]);
    expect(() => scheduleDetachedRestart({ ...base, spawn: s.spawn, activeLeases: () => [{ id: 'l1' }], drain: () => null }, { wake: true })).toThrow(/active worker lease/);
    expect(() => scheduleDetachedRestart({ ...base, spawn: s.spawn, activeLeases: () => [], drain: () => ({ reason: 'upgrade' }) }, { wake: true })).toThrow(/drain/);
    expect(() => scheduleDetachedRestart({ ...base, spawn: s.spawn, activeLeases: () => [], drain: () => null }, { wake: true, recover: true })).toThrow(/not both/);
    expect(s.calls).toHaveLength(1);
  });

  it('the crash start is `coordinator restart --recover` (no --force) and refuses during a drain or an upgrade', () => {
    const s = spawnRec();
    scheduleCrashStart({ ...base, spawn: s.spawn, drain: () => null });
    expect(s.calls).toEqual([['coordinator', 'restart', '--recover']]);
    expect(() => scheduleCrashStart({ ...base, spawn: s.spawn, drain: () => ({ reason: 'upgrade' }) })).toThrow(/drain/);
    expect(() => scheduleCrashStart({ ...base, spawn: s.spawn, drain: () => null, upgrade: () => 'cr_1' })).toThrow(/upgrade is in progress/);
    expect(s.calls).toHaveLength(1);
  });

  it('a woken session runs `coordinator run --wake`, whose first message is the constant wake prompt', async () => {
    const root = tmp('minions-wake-');
    for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
    const paths = { ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }), pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md') };
    const cfg = makeEnv().config;
    const c = await buildCoordinatorCommand(cfg, paths, { detached: true, wake: true });
    expect(c.args.slice(-4)).toEqual(['minions', 'coordinator', 'run', '--wake']);
    expect(WAKE_PROMPT).toBe('/minions:orchestrate wake');
  });
});

describe('startRoutineClock (fake clock)', () => {
  function fakeTimer() {
    const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      timer: (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; pending.push(t); return () => { t.cancelled = true; }; },
      fire: async () => { const t = pending.filter((x) => !x.cancelled).shift(); if (!t) return false; pending.splice(pending.indexOf(t), 1); t.fn(); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); return true; },
      pending: () => pending.filter((x) => !x.cancelled),
    };
  }
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

  it('ticks every tickMinutes while enabled, re-reads the settings, skips while off, and stops', async () => {
    const ft = fakeTimer();
    let s: RoutineSettings = { ...ON, tickMinutes: 15 };
    let runs = 0;
    const stop = startRoutineClock({ settings: async () => s, run: async () => { runs++; }, timer: ft.timer });
    await settle();
    expect(ft.pending().map((p) => p.ms)).toEqual([15 * 60_000]);
    expect(runs).toBe(0); // the first pass one tick after the start
    await ft.fire();
    expect(runs).toBe(1);
    s = { ...s, enabled: false, tickMinutes: 5 };
    await ft.fire();
    expect(runs).toBe(1); // off: no pass, the clock keeps checking
    expect(ft.pending().map((p) => p.ms)).toEqual([5 * 60_000]);
    stop();
    expect(ft.pending()).toHaveLength(0);
  });

  it('a pass that throws never stops the clock; an unreadable config uses the default interval', async () => {
    const ft = fakeTimer();
    let fail = true;
    const log: string[] = [];
    startRoutineClock({ settings: async () => { if (fail) throw new Error('bad config'); return ON; }, run: async () => { throw new Error('boom'); }, timer: ft.timer, log: (l) => log.push(l) });
    await settle();
    expect(ft.pending().map((p) => p.ms)).toEqual([15 * 60_000]);
    await ft.fire();
    expect(log.join()).toMatch(/config unreadable/);
    fail = false;
    await ft.fire();
    expect(log.join()).toMatch(/routine pass failed: boom/);
    expect(ft.pending()).toHaveLength(1);
  });

  it('a pass still running is never doubled', async () => {
    const ft = fakeTimer();
    let release!: () => void;
    let runs = 0;
    startRoutineClock({ settings: async () => ON, run: () => { runs++; return new Promise<void>((r) => { release = r; }); }, timer: ft.timer });
    await settle();
    void ft.fire(); // starts a pass that hangs; the next tick is scheduled only after it
    await settle();
    expect(runs).toBe(1);
    expect(ft.pending()).toHaveLength(0);
    release();
    await settle();
    expect(ft.pending()).toHaveLength(1);
  });
});

describe('schema 9: the events(kind, at) index for the routine reads', () => {
  it('a schema-8 database migrates to 9 with the index and keeps its events', async () => {
    const { RuntimeDb, SCHEMA_VERSION } = await import('../../src/runtime/db.js');
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    const file = join(tmp('minions-schema9-'), 'v8.db');
    const v8 = new RuntimeDb(file);
    v8.exec('DROP INDEX events_kind_at');
    v8.setMeta('schema_version', '8');
    v8.addEvent(ROUTINE_EVENT, null, { trigger: 'clock' }, ago(5));
    v8.close();
    const up = new RuntimeDb(file);
    try {
      expect(up.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
      expect(up.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_kind_at'")).toHaveLength(1);
      expect(up.lastEventOfKind(ROUTINE_EVENT)).toMatchObject({ at: ago(5), data: { trigger: 'clock' } });
    } finally { up.close(); }
  });
});
