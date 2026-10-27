// The routine's hooks into existing parts (task-68.2): the wrapper clock hook of `coordinator run`, the wake end
// trigger and the woken flag of the coordinator usage tracking, the last owner message time the Stop hook records,
// the baseline's wake count, the routine.* settings and the status routine line. Temp dirs and fakes only: no
// tmux, no claude, no child processes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEY_CLASSES } from '../../src/config/setting-classes.js';
import { currentValue, settingDef, viewSetting, type SettingsContext } from '../../src/host/settings.js';
import type { ProjectJson } from '../../src/host/project.js';
import { collectStatus, humanStatus } from '../../src/runtime/commands.js';
import { coordinatorWrapper, RECOVERY_PROMPT, WAKE_PROMPT, type SpawnLike } from '../../src/runtime/coordinator.js';
import {
  completeOpenSessions, LAST_OWNER_MESSAGE_META, lastOwnerMessageAt, readSessionState, trackCoordinatorUsage,
} from '../../src/runtime/coordinator-usage.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { ROUTINE_EVENT } from '../../src/runtime/routine.js';
import { humanBaseline, spendReport } from '../../src/runtime/spend.js';
import { defaults } from '../helpers.js';
import { makeEnv, tmp } from './fixtures.js';

// ---------------------------------------------------------------- the wrapper clock hook

const terminalCfg = () => { const c = defaults(); c.communication.channel = 'terminal'; return c; };
const autoModes = async () => ['acceptEdits', 'auto'];
const noSignals = { on() { return this; }, removeListener() { return this; } };

function layout() {
  const root = tmp('minions-clock-');
  for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  return {
    ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
    pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
  };
}

function fakeSpawn(order: string[], during?: () => void) {
  const calls: string[][] = [];
  const spawn: SpawnLike = (cmd, args) => {
    calls.push([cmd, ...args]);
    order.push('claude');
    return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => { during?.(); cb(0, null); }); return this; } } as ReturnType<SpawnLike>;
  };
  return { calls, spawn };
}

describe('coordinatorWrapper: the routine clock hook', () => {
  it('starts the clock with the lock held, right before claude, and stops it when the wrapper ends', async () => {
    const paths = layout();
    const order: string[] = [];
    let lockedAtStart = false;
    const { spawn, calls } = fakeSpawn(order, () => order.push('claude-exit'));
    const code = await coordinatorWrapper(async () => terminalCfg(), {
      paths, spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: noSignals,
      onStart: async () => { order.push('startup'); },
      routineClock: () => {
        const db = new RuntimeDb(paths.db); lockedAtStart = !!db.coordinatorLock(); db.close();
        order.push('clock-start');
        return () => { order.push('clock-stop'); };
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(lockedAtStart).toBe(true);
    expect(order).toEqual(['startup', 'clock-start', 'claude', 'claude-exit', 'clock-stop']);
  });

  it('a clock that fails to start is logged and never keeps claude from starting', async () => {
    const paths = layout();
    const order: string[] = [];
    const logs: string[] = [];
    const { spawn, calls } = fakeSpawn(order);
    const code = await coordinatorWrapper(async () => terminalCfg(), {
      paths, spawn, permissionModes: autoModes, env: {}, log: (l) => logs.push(l), signals: noSignals,
      routineClock: () => { throw new Error('timer broke'); },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/the routine clock did not start: timer broke/);
  });

  it('the clock is stopped even when claude cannot be spawned', async () => {
    const paths = layout();
    const order: string[] = [];
    const spawn: SpawnLike = () => { throw new Error('no claude binary'); };
    await coordinatorWrapper(async () => terminalCfg(), {
      paths, spawn, permissionModes: autoModes, env: {}, log: () => {}, signals: noSignals,
      routineClock: () => { order.push('clock-start'); return () => { order.push('clock-stop'); }; },
    }).catch(() => undefined);
    expect(order).toEqual(['clock-start', 'clock-stop']);
  });
});

// ---------------------------------------------------------------- the Stop hook's usage tracking

const cfg = defaults();
const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output });
const asst = (id: string, u: ReturnType<typeof usage>) =>
  ({ type: 'assistant', isSidechain: false, message: { id, role: 'assistant', model: 'claude-opus-4-5', usage: u, content: [{ type: 'text', text: 'ok' }] } });
const user = (text: string) => ({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const owner = (text: string) => `<channel source="telegram" chat_id="1" message_id="9" user="owner" ts="2026-10-27T10:00:00Z">${text}</channel>`;
const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x) + '\n').join('');

function freshDb(): RuntimeDb {
  const db = new RuntimeDb(join(tmp('minions-rhooks-'), 'state', 'minions.db'));
  db.acquireCoordinatorLock('coordinator', 4242, () => false);
  return db;
}
function transcript(content: string, name = 'sess.jsonl'): string {
  const file = join(tmp('minions-rhooks-t-'), name);
  writeFileSync(file, content);
  return file;
}
const track = (db: RuntimeDb, sessionId: string, path: string, now: Date) =>
  trackCoordinatorUsage({ db, config: cfg, env: {}, now }, { transcript_path: path, session_id: sessionId });

describe('coordinator usage: wakes and owner messages', () => {
  it('a session that starts with the wake prompt is woken (not recovered); the baseline counts wakes and their tokens', () => {
    const db = freshDb();
    track(db, 'sess-w', transcript(lines([user(WAKE_PROMPT), asst('w1', usage(10, 1000, 0, 5))]), 'w.jsonl'), new Date('2026-10-27T09:00:00Z'));
    track(db, 'sess-r', transcript(lines([user(RECOVERY_PROMPT), asst('r1', usage(1, 100, 0, 1))]), 'r.jsonl'), new Date('2026-10-27T09:10:00Z'));
    track(db, 'sess-o', transcript(lines([user('/minions:orchestrate wake the queue please'), asst('o1', usage(1, 100, 0, 1))]), 'o.jsonl'), new Date('2026-10-27T09:20:00Z'));
    expect(readSessionState(db, 'sess-w')).toMatchObject({ woken: true, recovered: false });
    expect(readSessionState(db, 'sess-r')).toMatchObject({ woken: false, recovered: true });
    expect(readSessionState(db, 'sess-o')!.woken).toBe(false); // only the exact constant prompt
    const bl = spendReport({ db, config: cfg, billing: 'subscription', now: new Date('2026-10-27T10:00:00Z') }).coordinator.baseline;
    expect(bl.wakes).toEqual({ sessions: 1, tokens: 1015, perWake: 1015 });
    expect(humanBaseline(bl)).toMatch(/routine wakes 1 \(/);
  });

  it('a session ended by a wake restart (coordinator_restart.wake) has the wake end trigger; a plain restart stays restart', () => {
    const db = freshDb();
    track(db, 'sess-a', transcript(lines([asst('a1', usage(1, 100, 0, 1))]), 'a.jsonl'), new Date('2026-10-27T09:00:00Z'));
    db.setMeta('coordinator_restart', JSON.stringify({ at: '2026-10-27T09:30:00.000Z', reason: 'coordinator restart --wake', leases: [], wake: true }));
    track(db, 'sess-b', transcript(lines([user(WAKE_PROMPT), asst('b1', usage(1, 100, 0, 1))]), 'b.jsonl'), new Date('2026-10-27T09:31:00Z'));
    expect(readSessionState(db, 'sess-a')!.ended).toMatchObject({ trigger: 'wake', detail: 'coordinator restart --wake' });
    db.setMeta('coordinator_restart', JSON.stringify({ at: '2026-10-27T10:00:00.000Z', reason: 'settings', leases: [] }));
    completeOpenSessions({ db, config: cfg, now: new Date('2026-10-27T10:01:00Z') });
    expect(readSessionState(db, 'sess-b')!.ended).toMatchObject({ trigger: 'restart' });
    expect(spendReport({ db, config: cfg, billing: 'subscription' }).coordinator.baseline.endedBy).toEqual({ wake: 1, restart: 1 });
  });

  it('the Stop hook records when it last counted a new owner message; Stops without one leave it alone', () => {
    const db = freshDb();
    const file = transcript(lines([user('/minions:orchestrate'), asst('m1', usage(1, 100, 0, 1))]));
    track(db, 'sess-a', file, new Date('2026-10-27T09:00:00Z'));
    expect(lastOwnerMessageAt(db)).toBeNull();
    writeFileSync(file, lines([user('/minions:orchestrate'), asst('m1', usage(1, 100, 0, 1)), user(owner('status?')), asst('m2', usage(1, 200, 0, 1))]));
    track(db, 'sess-a', file, new Date('2026-10-27T09:05:00Z'));
    expect(lastOwnerMessageAt(db)).toBe('2026-10-27T09:05:00.000Z');
    writeFileSync(file, lines([user('/minions:orchestrate'), asst('m1', usage(1, 100, 0, 1)), user(owner('status?')), asst('m2', usage(1, 200, 0, 1)), asst('m3', usage(1, 300, 0, 1))]));
    track(db, 'sess-a', file, new Date('2026-10-27T09:40:00Z'));
    expect(lastOwnerMessageAt(db)).toBe('2026-10-27T09:05:00.000Z');
    db.setMeta(LAST_OWNER_MESSAGE_META, 'garbage');
    expect(lastOwnerMessageAt(db)).toBeNull();
  });
});

// ---------------------------------------------------------------- settings

const settingsCtx = (config = defaults()): SettingsContext => ({
  project: { projectId: 'p', visibility: 'private' } as unknown as ProjectJson, config, provenance: {}, credentials: {} as SettingsContext['credentials'], paused: null,
});

describe('routine.* settings', () => {
  it('routine.enabled shows off when unset, on when set; turning it on loosens policy and it is host-owned', () => {
    const def = settingDef('routine.enabled')!;
    expect(def).toBeDefined();
    expect(currentValue(def, settingsCtx())).toBe(false);
    const on = defaults(); on.routine = { enabled: true };
    expect(currentValue(def, settingsCtx(on))).toBe(true);
    expect(viewSetting(def, settingsCtx())).toMatchObject({ value: false, type: 'bool', class: 'live', hostOwned: true, canLoosen: true });
    expect(def.loosens!(false, true)).toMatch(/starts coordinator sessions on its own/);
    expect(def.loosens!(true, false)).toBeNull();
    expect(KEY_CLASSES.find((k) => k.key === 'routine.enabled')).toMatchObject({ hostOwned: true });
  });

  it('more frequent or more wakes loosen; the interval does not', () => {
    expect(settingDef('routine.minWakeGapMinutes')!.loosens!(undefined, 10)).toMatch(/more often \(every 10 min/);
    expect(settingDef('routine.minWakeGapMinutes')!.loosens!(10, 60)).toBeNull();
    expect(settingDef('routine.maxWakesPerDay')!.loosens!(undefined, 20)).toMatch(/8 -> 20/);
    expect(settingDef('routine.maxWakesPerDay')!.loosens!(8, 2)).toBeNull();
    expect(settingDef('routine.tickMinutes')!.loosens).toBeUndefined();
    expect(currentValue(settingDef('routine.tickMinutes')!, settingsCtx())).toBeUndefined(); // default 15 via routineSettings
  });
});

// ---------------------------------------------------------------- status

describe('status: the routine line', () => {
  it('off by default; on: every N min with the last and the next pass', async () => {
    const off = makeEnv();
    const s = await collectStatus({ db: off.db, config: off.config, backlog: async () => off.backlog });
    expect(s.routine).toMatchObject({ enabled: false, last: null, nextAt: null });
    expect(humanStatus(s)).toMatch(/^routine: off \(routine\.enabled\)$/m);

    const on = makeEnv((c) => { c.routine = { enabled: true, tickMinutes: 10 }; });
    on.db.addEvent(ROUTINE_EVENT, null, { trigger: 'clock', decision: { action: 'none', why: 'nothing needs a model' }, reasons: [] }, '2026-10-27T11:50:00.000Z');
    const t = await collectStatus({ db: on.db, config: on.config, backlog: async () => on.backlog });
    expect(t.routine).toMatchObject({ enabled: true, tickMinutes: 10, last: { at: '2026-10-27T11:50:00.000Z', trigger: 'clock' }, nextAt: '2026-10-27T12:00:00.000Z' });
    expect(humanStatus(t)).toMatch(/routine: every 10 min; last pass 2026-10-27T11:50:00.000Z \(clock: nothing needs a model\); next 2026-10-27T12:00:00.000Z; wakes today 0/);
  });
});
