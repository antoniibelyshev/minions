// Task-57 phase 5 (docs/design/coordinator-sessions.md decisions 6 and 7): the session supervisor. Every session
// process is a fake resident claude (test/fixtures/fake-claude-session.mjs, run by node); no real claude ever starts.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { coordinatorWrapper, type SpawnLike } from '../../src/runtime/coordinator.js';
import { RuntimeDb, type SupervisorLock } from '../../src/runtime/db.js';
import { clearDrain, requestDrain } from '../../src/runtime/drain.js';
import { coordinatorOnlyWorkCommand } from '../../src/runtime/hooks.js';
import { pending } from '../../src/runtime/outbox.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { hostIdentity, procIdentity, procStat } from '../../src/runtime/runner/record.js';
import { enqueueInbox, getSession, openSession, pendingInbox, updateSession } from '../../src/runtime/session-store.js';
import { buildSessionCommand, sessionConfigDir } from '../../src/runtime/sessions.js';
import {
  createSessionRecord, MAX_SESSION_RESUMES, readSessionRecord, reapSessionRecord, runSupervisor, sessionRunRecordPath, startSupervisorWatch, supervisorAlive,
  supervisorEnv, supervisorLockState, type LockProcessView, type SessionLauncher, type SupervisorDeps, type SupervisorSpawn, type SupervisorTiming,
} from '../../src/runtime/supervisor.js';
import { defaults, HAS_PROCFS } from '../helpers.js';
import { tmp } from './fixtures.js';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude-session.mjs');
const FAST: Partial<SupervisorTiming> = { tickMs: 25, pollMs: 25, configMs: 60_000, interruptGraceMs: 200, killGraceMs: 500, drainGraceMs: 800, reapGraceMs: 300 };
const TG = '123456:telegram-bot-token-value';

const children: ChildProcess[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) s();
  for (const c of children.splice(0)) { try { process.kill(-c.pid!, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } }
});

const sessionsOn = (on = true): MinionsConfig => { const c = defaults(); c.coordinator = { ...c.coordinator, sessions: { enabled: on } }; return c; };
const uniq = (p: string) => `task:${p}-${Math.random().toString(36).slice(2, 8)}`;

interface FakeEvent { ev: string; pid?: number; argv?: string[]; text?: string; name?: string; env?: { MINIONS_SESSION: string | null; CLAUDE_CONFIG_DIR: string | null; TMPDIR: string | null; telegram: string[]; secrets: string[] } }
const events = (file: string): FakeEvent[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeEvent) : []);

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out waiting for: ${what}`);
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const dead = async (pid: number) => { const s = await procStat(pid); return !s || s.state === 'Z'; };

function setup(fakeEnv: Record<string, string> = {}) {
  const root = tmp('minions-sup-');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  const db = new RuntimeDb(join(state, 'minions.db'));
  const log = join(root, 'fake.log');
  const cfg = sessionsOn();
  const launches: { key: string; resume: string | null }[] = [];
  const launch: SessionLauncher = async (_c, key, o) => {
    launches.push({ key, resume: o.resume ?? null });
    return { command: process.execPath, args: [FAKE, ...(o.resume ? ['--resume', o.resume] : [])], cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_LOG: log, MINIONS_SESSION: key, ...fakeEnv } };
  };
  const open = (key: string) => openSession(db, key, { configDir: sessionConfigDir({ state }, key) });
  return { root, state, db, log, cfg, launches, launch, open };
}
type Setup = ReturnType<typeof setup>;

function start(s: Setup, extra: Partial<SupervisorDeps> = {}) {
  const ac = new AbortController();
  const lines: string[] = [];
  const done = runSupervisor({ db: s.db, state: s.state, config: async () => s.cfg, launch: s.launch, timing: FAST, signal: ac.signal, log: (l) => lines.push(l), ...extra });
  stops.push(() => ac.abort());
  return { stop: async () => { ac.abort(); return done; }, done, lines };
}

// ---------------------------------------------------------------- the lock

describe('supervisor lock: reuse-safe', () => {
  const lock = (o: Partial<SupervisorLock> = {}): SupervisorLock => ({ pid: 4242, start: '1000', bootId: 'boot-a', at: '2026-10-29T00:00:00.000Z', ...o });
  const view = (o: Partial<LockProcessView> = {}): LockProcessView => ({
    alive: () => true, startTime: () => '1000', cmdline: () => 'node /usr/bin/minions coordinator supervise', bootId: () => 'boot-a', ...o,
  });

  it('a holder is live only with the same pid, start time, boot and a supervise command line', () => {
    expect(supervisorAlive(lock(), view())).toBe(true);
    expect(supervisorAlive(lock(), view({ alive: () => false }))).toBe(false);
    // PID reuse: the pid runs again, but it is another process (another start time, or another boot).
    expect(supervisorAlive(lock(), view({ startTime: () => '2000' }))).toBe(false);
    expect(supervisorAlive(lock(), view({ bootId: () => 'boot-b' }))).toBe(false);
    // A reused pid that runs something else (a tmux client, `coordinator status`).
    expect(supervisorAlive(lock(), view({ cmdline: () => 'minions coordinator status' }))).toBe(false);
    expect(supervisorAlive(lock(), view({ cmdline: () => 'tmux attach' }))).toBe(false);
    // Without /proc (macOS host runtime) a live pid stays the holder: refused, never taken over.
    expect(supervisorAlive(lock(), view({ startTime: () => null, cmdline: () => null, bootId: () => null }))).toBe(true);
  });

  it('a live holder keeps the lock; a stale one (dead or reused pid) is taken over', () => {
    const db = new RuntimeDb(join(tmp('minions-suplock-'), 'minions.db'));
    expect(supervisorLockState(db)).toEqual({ state: 'none', lock: null });
    const first = db.acquireSupervisorLock({ pid: 4242, start: '1000', bootId: 'boot-a' }, () => false)!;
    expect(first.pid).toBe(4242);
    expect(db.acquireSupervisorLock({ pid: 5151, start: '3000', bootId: 'boot-a' }, (l) => supervisorAlive(l, view()))).toBeNull();
    expect(db.supervisorLock()?.pid).toBe(4242);
    expect(supervisorLockState(db, view()).state).toBe('live');
    expect(supervisorLockState(db, view({ startTime: () => '9999' })).state).toBe('stale');
    const second = db.acquireSupervisorLock({ pid: 5151, start: '3000', bootId: 'boot-a' }, (l) => supervisorAlive(l, view({ startTime: () => '9999' })))!;
    expect(second.pid).toBe(5151);
    expect(db.releaseSupervisorLock(first)).toBe(false);
    expect(db.releaseSupervisorLock(second)).toBe(true);
    expect(db.supervisorLock()).toBeNull();
  });

  it.skipIf(!HAS_PROCFS)('with the real /proc: a live process that is not a supervisor never holds the lock', async () => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(c);
    const id = (await procIdentity(c.pid!))!;
    const host = await hostIdentity();
    const db = new RuntimeDb(join(tmp('minions-suplock-'), 'minions.db'));
    db.acquireSupervisorLock({ pid: c.pid!, start: id.startTime, bootId: host?.bootId ?? null }, () => false);
    expect(supervisorLockState(db).state).toBe('stale');
  });

  it('a second supervisor exits with `conflict` and starts nothing', async () => {
    const s = setup();
    s.db.acquireSupervisorLock({ pid: 4242, start: '1000', bootId: null }, () => false);
    s.open('general');
    enqueueInbox(s.db, 'general', 'router', 'hello');
    const r = await runSupervisor({ db: s.db, state: s.state, config: async () => s.cfg, launch: s.launch, timing: FAST, lockAlive: () => true });
    expect(r.exit).toBe('conflict');
    expect(r.holder?.pid).toBe(4242);
    expect(s.launches).toEqual([]);
  });

  it('subagents may not run `minions coordinator supervise`', () => {
    expect(coordinatorOnlyWorkCommand('minions coordinator supervise')).toBe('minions coordinator supervise');
  });
});

// ---------------------------------------------------------------- processes

describe('session processes (fake claude)', { timeout: 30_000 }, () => {
  it.skipIf(!HAS_PROCFS)('spawns one resident process per session, records it, delivers the inbox to its stdin and keeps the claude session id', async () => {
    const s = setup();
    const key = uniq('spawn');
    s.open(key);
    enqueueInbox(s.db, key, 'router', 'hello');
    const sup = start(s);
    await until('first message', () => events(s.log).some((e) => e.ev === 'msg' && e.text === 'hello'));
    const startEv = events(s.log).find((e) => e.ev === 'start')!;
    // The run record names the process; it leads its own process group (supervise.ts).
    const rec = (await readSessionRecord(s.state, key))!;
    expect(rec.process?.pid).toBe(startEv.pid);
    expect((await procStat(startEv.pid!))?.pgrp).toBe(startEv.pid);
    expect(rec.supervisor?.pid).toBe(process.pid);
    expect(s.db.supervisorLock()?.pid).toBe(process.pid);
    await until('session id', () => getSession(s.db, key)?.claude_session_id === 'sess-1');
    expect(pendingInbox(s.db, key)).toEqual([]);
    // Resident: a later message goes to the same process, no second start.
    enqueueInbox(s.db, key, 'router', 'second');
    await until('second message', () => events(s.log).some((e) => e.ev === 'msg' && e.text === 'second'));
    expect(events(s.log).filter((e) => e.ev === 'start')).toHaveLength(1);
    expect(s.launches).toEqual([{ key, resume: null }]);

    const r = await sup.stop();
    expect(r.exit).toBe('stopped');
    expect(await dead(startEv.pid!)).toBe(true);
    expect(existsSync(sessionRunRecordPath(s.state, key))).toBe(false);
    expect(s.db.supervisorLock()).toBeNull();
    // Stopped by the supervisor: no crash, and a notice makes the next supervisor resume it.
    expect(getSession(s.db, key)).toMatchObject({ status: 'open', resumes: 0 });
    expect(pendingInbox(s.db, key).map((m) => m.source)).toEqual(['supervisor']);
  });

  it('a session process that crashes is resumed with --resume <id>; a completed turn resets the count', async () => {
    const s = setup();
    const key = uniq('crash');
    s.open(key);
    enqueueInbox(s.db, key, 'router', 'please CRASH now');
    const sup = start(s);
    await until('resumed', () => s.launches.length === 2);
    expect(s.launches[1]).toEqual({ key, resume: 'sess-1' });
    await until('resume notice', () => events(s.log).some((e) => e.ev === 'msg' && /ended unexpectedly/.test(e.text ?? '')));
    const starts = events(s.log).filter((e) => e.ev === 'start');
    expect(starts[1]?.argv).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
    // The notice's turn completed (a stream-json result): the count is back to 0.
    await until('count reset', () => getSession(s.db, key)?.resumes === 0);
    expect(getSession(s.db, key)?.status).toBe('open');
    await sup.stop();
  });

  it(`after ${MAX_SESSION_RESUMES} resumes without a completed turn the session is failed and the owner gets an outbox blocker`, async () => {
    const s = setup({ FAKE_MODE: 'crash-on-start' });
    const key = uniq('limit');
    s.open(key);
    enqueueInbox(s.db, key, 'router', 'hello');
    const sup = start(s);
    await until('failed', () => getSession(s.db, key)?.status === 'failed');
    expect(s.launches.map((l) => l.resume)).toEqual([null, 'sess-1', 'sess-1']);
    const row = getSession(s.db, key)!;
    expect(row.resumes).toBe(MAX_SESSION_RESUMES);
    expect(row.failure).toMatch(/exited with code 4.*boom at start/);
    const blockers = pending(s.db).filter((i) => i.kind === 'blocker');
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.key).toBe(`session-failed:${key}:${row.opened_at}`);
    expect(blockers[0]!.text).toContain(`Coordinator session ${key} failed`);
    expect(blockers[0]!.taskId).toBe(key.slice('task:'.length));
    // Failed stays failed: nothing starts it again, even with a new message.
    enqueueInbox(s.db, key, 'router', 'anyone?');
    await settle();
    expect(s.launches).toHaveLength(3);
    await sup.stop();
  });

  it('a drain delivers only the drain notice, ends the session, starts nothing, and resumes it when the drain clears', async () => {
    const s = setup();
    const key = uniq('drain');
    s.open(key);
    enqueueInbox(s.db, key, 'router', 'hello');
    const sup = start(s);
    await until('first message', () => events(s.log).some((e) => e.ev === 'msg' && e.text === 'hello'));
    const flag = { drainFlag: join(s.state, 'run', 'drain') };
    requestDrain(s.db, flag, 'upgrade to 0.2');
    enqueueInbox(s.db, key, 'router', 'not during a drain');
    await until('drain notice and stdin end', () => {
      const ev = events(s.log);
      return ev.some((e) => e.ev === 'msg' && /drain in progress \(upgrade to 0\.2\)/.test(e.text ?? '')) && ev.some((e) => e.ev === 'eof');
    });
    await until('record removed', () => !existsSync(sessionRunRecordPath(s.state, key)));
    await settle();
    expect(s.launches).toHaveLength(1);
    expect(events(s.log).some((e) => e.text === 'not during a drain')).toBe(false);
    expect(getSession(s.db, key)).toMatchObject({ status: 'open', resumes: 0 });

    // The drain kept starts paused (drain.ts); the upgrade behind it lifts both.
    clearDrain(s.db, flag, 'test');
    s.db.setPaused({ starts: false });
    await until('resumed after the drain', () => s.launches.length === 2);
    expect(s.launches[1]).toEqual({ key, resume: 'sess-1' });
    await until('held message delivered', () => events(s.log).some((e) => e.text === 'not during a drain'));
    await sup.stop();
  });

  it('a session that does not end within the drain grace is stopped by its process group (no crash counted)', async () => {
    const s = setup({ FAKE_MODE: 'ignore-eof' });
    const key = uniq('grace');
    s.open(key);
    enqueueInbox(s.db, key, 'router', 'hello');
    const sup = start(s);
    await until('first message', () => events(s.log).some((e) => e.text === 'hello'));
    requestDrain(s.db, { drainFlag: join(s.state, 'run', 'drain') }, 'upgrade');
    await until('stopped after the grace', () => events(s.log).some((e) => e.ev === 'signal' && e.name === 'SIGINT'));
    await until('record removed', () => !existsSync(sessionRunRecordPath(s.state, key)));
    expect(getSession(s.db, key)).toMatchObject({ status: 'open', resumes: 0, failure: null });
    expect(s.launches).toHaveLength(1);
    await sup.stop();
  });

  it('closing a session ends its process without a resume notice', async () => {
    const s = setup();
    const key = uniq('close');
    s.open(key);
    enqueueInbox(s.db, key, 'router', 'hello');
    const sup = start(s);
    await until('first message', () => events(s.log).some((e) => e.text === 'hello'));
    updateSession(s.db, key, { status: 'closed', closed_at: new Date().toISOString() });
    await until('eof', () => events(s.log).some((e) => e.ev === 'eof'));
    await until('record removed', () => !existsSync(sessionRunRecordPath(s.state, key)));
    expect(pendingInbox(s.db, key)).toEqual([]);
    expect(getSession(s.db, key)?.resumes).toBe(0);
    await sup.stop();
  });

  it('never runs more than coordinator.sessions.max processes; an idle one yields its slot to a waiting session', async () => {
    const s = setup();
    s.cfg.coordinator = { ...s.cfg.coordinator, sessions: { enabled: true, max: 1 } };
    const a = uniq('max-a'), b = uniq('max-b');
    for (const k of [a, b]) { s.open(k); enqueueInbox(s.db, k, 'router', `hi ${k}`); }
    const sup = start(s);
    await until('both started', () => events(s.log).filter((e) => e.ev === 'start').length === 2);
    // One at a time: the first process ended (stdin closed while idle) before the second started.
    const evs = events(s.log).map((e) => e.ev);
    expect(evs.indexOf('eof')).toBeGreaterThan(-1);
    expect(evs.indexOf('eof')).toBeLessThan(evs.lastIndexOf('start'));
    // The yielded session stays open, with no resume notice queued: it resumes on its next message.
    const first = s.launches[0]!.key;
    expect(getSession(s.db, first)).toMatchObject({ status: 'open', resumes: 0 });
    expect(pendingInbox(s.db, first)).toEqual([]);
    await sup.stop();
  });

  it('opens the general session on its first message', async () => {
    const s = setup();
    enqueueInbox(s.db, 'general', 'router', 'what is the status?');
    const sup = start(s);
    await until('general started', () => events(s.log).some((e) => e.text === 'what is the status?'));
    expect(getSession(s.db, 'general')).toMatchObject({ kind: 'general', status: 'open' });
    await sup.stop();
  });

  it('exits without a lock or a start when sessions are off', async () => {
    const s = setup();
    s.cfg = sessionsOn(false);
    enqueueInbox(s.db, 'general', 'router', 'hello');
    const r = await runSupervisor({ db: s.db, state: s.state, config: async () => s.cfg, launch: s.launch, timing: FAST });
    expect(r.exit).toBe('disabled');
    expect(s.db.supervisorLock()).toBeNull();
    expect(s.launches).toEqual([]);
    expect(getSession(s.db, 'general')).toBeNull();
  });
});

// ---------------------------------------------------------------- orphans

describe.skipIf(!HAS_PROCFS)('orphans from run records (supervisor restart)', { timeout: 30_000 }, () => {
  // A leader in its own group with a group member, plus a marked process that left the group (setsid escapee).
  const ORPHAN = `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const forever = ['-e', 'setInterval(() => {}, 1000)'];
    const member = spawn(process.execPath, forever, { stdio: 'ignore' });
    const escapee = spawn(process.execPath, forever, { stdio: 'ignore', detached: true });
    writeFileSync(process.argv[1], JSON.stringify({ member: member.pid, escapee: escapee.pid }));
    process.on('SIGTERM', () => {}); // only SIGKILL ends it
    setInterval(() => {}, 1000);`;

  it('stops a live orphan by its identity (group, members, marked escapees) and resumes the session', async () => {
    const s = setup();
    const key = uniq('orphan');
    const pids = join(s.root, 'orphan.json');
    const leader = spawn(process.execPath, ['-e', ORPHAN, pids], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, [`MINIONS_SESSION`]: key } });
    children.push(leader);
    await until('orphan up', () => existsSync(pids) && readFileSync(pids, 'utf8').length > 0);
    const { member, escapee } = JSON.parse(readFileSync(pids, 'utf8')) as { member: number; escapee: number };
    // An unrelated live process (no session marker) whose pid a stale record names with another start time (a reused pid).
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env.PATH } });
    const decoyKey = uniq('decoy');
    children.push(decoy);
    const host = await hostIdentity();
    const at = new Date().toISOString();
    await createSessionRecord(s.state, { version: 1, key, host, supervisor: { pid: 999_999, startTime: '1' }, process: await procIdentity(leader.pid!), resume: 'sess-9', createdAt: at, updatedAt: at });
    await createSessionRecord(s.state, { version: 1, key: decoyKey, host, supervisor: null, process: { pid: decoy.pid!, startTime: '1' }, resume: null, createdAt: at, updatedAt: at });
    s.open(key);
    updateSession(s.db, key, { claude_session_id: 'sess-9' });

    const sup = start(s);
    await until('resumed', () => s.launches.length === 1);
    expect(s.launches[0]).toEqual({ key, resume: 'sess-9' });
    for (const pid of [leader.pid!, member, escapee]) await until(`pid ${pid} killed`, () => dead(pid));
    // The reused pid is left alone; its stale record is removed.
    expect(await dead(decoy.pid!)).toBe(false);
    await until('stale record removed', () => !existsSync(sessionRunRecordPath(s.state, decoyKey)));
    expect(sup.lines.join('\n')).toMatch(new RegExp(`${key.replace('.', '\\.')}: orphan record stopped`));
    // Orphans do not count as crashes.
    expect(getSession(s.db, key)?.resumes).toBe(0);
    await until('resume notice delivered', () => events(s.log).some((e) => /supervisor was restarted/.test(e.text ?? '')));
    await sup.stop();
  });

  it('a stale record whose pid now leads an unrelated detached group leaves that group alone', async () => {
    const s = setup();
    const key = uniq('reused');
    // Detached, so the decoy leads its own group: a group sweep on the stale pid would match it by start time.
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
    children.push(decoy);
    await until('decoy up', async () => !(await dead(decoy.pid!)));
    const at = new Date().toISOString();
    await createSessionRecord(s.state, { version: 1, key, host: await hostIdentity(), supervisor: null, process: { pid: decoy.pid!, startTime: '1' }, resume: null, createdAt: at, updatedAt: at });
    const r = await reapSessionRecord(s.state, key, { graceMs: 100 });
    expect(r).toMatchObject({ key, action: 'removed', killed: [] });
    expect(existsSync(sessionRunRecordPath(s.state, key))).toBe(false);
    await new Promise((res) => setTimeout(res, 200));
    expect(await dead(decoy.pid!)).toBe(false);
  });

  it('a record from another boot or container is removed without signalling anything', async () => {
    const s = setup();
    const key = uniq('oldboot');
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env.PATH, MINIONS_SESSION: key } });
    children.push(decoy);
    const at = new Date().toISOString();
    await createSessionRecord(s.state, { version: 1, key, host: { bootId: 'another-boot', containerStart: '1' }, supervisor: null, process: await procIdentity(decoy.pid!), resume: null, createdAt: at, updatedAt: at });
    const sup = start(s);
    await until('record removed', () => !existsSync(sessionRunRecordPath(s.state, key)));
    expect(await dead(decoy.pid!)).toBe(false);
    await sup.stop();
  });
});

// ---------------------------------------------------------------- the real launch builder

describe('a session started through buildSessionCommand', { timeout: 30_000 }, () => {
  it('runs with the session env: no Telegram, no inherited credential, MINIONS_SESSION and its own config dir', async () => {
    const s = setup();
    const root = s.root;
    const bin = join(root, 'bin');
    mkdirSync(bin);
    // The fake is `claude` on PATH, as buildSessionCommand resolves it; FAKE_LOG is set here (the env allowlist drops it).
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nFAKE_LOG=${JSON.stringify(s.log)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    mkdirSync(join(root, 'plugin'), { recursive: true });
    writeFileSync(join(root, 'plugin', 'coordinator.md'), 'session prompt\n');
    mkdirSync(join(root, 'secrets'), { mode: 0o700 });
    mkdirSync(join(root, 'scratch'));
    const paths = runtimePaths({ MINIONS_PLUGIN_DIR: join(root, 'plugin'), MINIONS_STATE_DIR: s.state, MINIONS_WORKSPACE: join(root, 'ws'),
      MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_SCRATCH_DIR: join(root, 'scratch') }, { inContainer: false });
    writeFileSync(paths.apiKeyFile, 'provisioned-key-0123456789abcdef', { mode: 0o600 });
    mkdirSync(paths.repo, { recursive: true }); // the session's cwd
    const env = {
      PATH: `${bin}:/usr/bin:/bin`, HOME: root, TMPDIR: '/tmp', CLAUDE_CONFIG_DIR: join(root, 'coordinator-home'),
      TELEGRAM_BOT_TOKEN: TG, TELEGRAM_STATE_DIR: join(root, 'tg'), ANTHROPIC_API_KEY: 'coordinator-secret', GH_TOKEN: 'gh-secret',
      MINIONS_ROLE: 'engineer', MINIONS_WORKER_LEASE: 'lease-x',
    };
    const key = uniq('real');
    s.open(key);
    enqueueInbox(s.db, key, 'router', 'hello');
    const launch: SessionLauncher = (c, k, o) => buildSessionCommand(c, k, { method: 'api-key', paths, env, host: null, hostRuntime: false, ...(o.resume ? { resume: o.resume } : {}) });
    const sup = start(s, { launch });
    await until('message', () => events(s.log).some((e) => e.text === 'hello')).catch((e: Error) => { throw new Error(`${e.message}\n${sup.lines.join('\n')}`); });
    const ev = events(s.log).find((e) => e.ev === 'start')!;
    expect(ev.env).toMatchObject({ MINIONS_SESSION: key, CLAUDE_CONFIG_DIR: sessionConfigDir(paths, key), telegram: [], secrets: [] });
    expect(ev.env!.TMPDIR).not.toMatch(/^\/tmp(\/|$)/);
    expect(ev.argv).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--strict-mcp-config']));
    expect(ev.argv).not.toContain('--channels');
    expect(ev.argv!.join(' ')).not.toContain(TG);
    await sup.stop();
  });
});

// ---------------------------------------------------------------- the wrapper side

describe('the wrapper starts the supervisor', () => {
  const spawnStub = () => {
    const calls: { cmd: string; args: string[]; opts: Parameters<SupervisorSpawn>[2] }[] = [];
    const fn: SupervisorSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 777, unref() {}, on() { return this; } }; };
    return { calls, fn };
  };
  const base = (o: { state: () => ReturnType<typeof supervisorLockState>; spawn: SupervisorSpawn; clock?: () => number; timer?: (fn: () => void, ms: number) => () => void }) => ({
    state: '/state', log: join(tmp('minions-supwatch-'), 'supervisor.log'), lockState: o.state, spawn: o.spawn, openLog: () => 99, clock: o.clock, timer: o.timer,
    env: { PATH: '/usr/bin', TELEGRAM_BOT_TOKEN: TG, ANTHROPIC_API_KEY: 'x', MINIONS_SESSION: 'general', MINIONS_STATE_DIR: '/state', CLAUDE_CONFIG_DIR: '/home/node/.claude', TMPDIR: '/tmp' },
    tmp: '/home/node/.cache/tmp',
  });
  const stale: ReturnType<typeof supervisorLockState> = { state: 'stale', lock: { pid: 31, start: '1', bootId: null, at: 'x' } };
  const liveLock: ReturnType<typeof supervisorLockState> = { state: 'live', lock: { pid: 32, start: '1', bootId: null, at: 'x' } };

  it('with sessions off: no spawn and no timer', () => {
    const sp = spawnStub();
    let timers = 0;
    const stop = startSupervisorWatch(sessionsOn(false), base({ state: () => ({ state: 'none', lock: null }), spawn: sp.fn, timer: () => { timers++; return () => {}; } }));
    stop();
    expect(sp.calls).toEqual([]);
    expect(timers).toBe(0);
  });

  it('with sessions on: starts it detached without Telegram or credentials, again when its lock is stale, never over a live one', () => {
    const sp = spawnStub();
    let tick: () => void = () => {};
    let state: ReturnType<typeof supervisorLockState> = { state: 'none', lock: null };
    let now = 0;
    const said: string[] = [];
    const stop = startSupervisorWatch(sessionsOn(), { ...base({ state: () => state, spawn: sp.fn, clock: () => now, timer: (fn) => { tick = fn; return () => {}; } }), say: (l) => said.push(l) });
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]).toMatchObject({ cmd: 'minions', args: ['coordinator', 'supervise'], opts: { cwd: '/state', detached: true, stdio: ['ignore', 99, 99] } });
    const env = sp.calls[0]!.opts.env;
    expect(Object.keys(env).filter((k) => k.startsWith('TELEGRAM_') || k === 'ANTHROPIC_API_KEY' || k === 'MINIONS_SESSION')).toEqual([]);
    expect(env).toMatchObject({ MINIONS_STATE_DIR: '/state', CLAUDE_CONFIG_DIR: '/home/node/.claude', TMPDIR: '/home/node/.cache/tmp' });
    // Still coming up (no lock yet): no second start within the grace.
    now = 10_000; tick();
    expect(sp.calls).toHaveLength(1);
    state = liveLock; now = 100_000; tick();
    expect(sp.calls).toHaveLength(1);
    state = stale; now = 200_000; tick();
    expect(sp.calls).toHaveLength(2);
    expect(said.at(-1)).toMatch(/restarted the session supervisor.*pid 31\) was stale/);
    stop();
  });

  it('supervisorEnv keeps the runtime location and moves a noexec TMPDIR', () => {
    expect(supervisorEnv({ PATH: '/bin', TMPDIR: '/tmp/x', MINIONS_WORKER_LEASE: 'lease-1', TELEGRAM_X: '1' }, '/scratch')).toEqual({ PATH: '/bin', TMPDIR: '/scratch' });
  });

  // The wrapper's launch with sessions off is exactly today's: same claude argv, no supervisor start.
  const layout = () => {
    const root = tmp('minions-supwrap-');
    for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
    return { ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }), pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md') };
  };
  const claudeSpawn = () => {
    const calls: string[][] = [];
    const spawn: SpawnLike = (cmd, args) => { calls.push([cmd, ...args]); return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; } } as ReturnType<SpawnLike>; };
    return { calls, spawn };
  };
  const noSignals = { on() { return this; }, removeListener() { return this; } };
  const wrap = async (cfg: MinionsConfig, watch?: NonNullable<Parameters<typeof coordinatorWrapper>[1]>['supervisorWatch']) => {
    const paths = layout();
    const root = join(paths.state, '..');
    const c = claudeSpawn();
    const code = await coordinatorWrapper(async () => cfg, { paths, spawn: c.spawn, permissionModes: async () => ['acceptEdits', 'auto'], env: {}, log: () => {}, signals: noSignals, ...(watch ? { supervisorWatch: watch } : {}) });
    return { code, calls: c.calls.map((a) => a.map((x) => x.replaceAll(root.replace(/\/\.\.$/, ''), '<root>'))) };
  };

  it('coordinatorWrapper: sessions off leaves the launch unchanged and starts no supervisor; sessions on starts it with the lock held', async () => {
    const off = sessionsOn(false);
    off.communication.channel = 'terminal';
    const sp = spawnStub();
    const without = await wrap(off);
    const withWatch = await wrap(off, (cfg) => startSupervisorWatch(cfg, base({ state: () => ({ state: 'none', lock: null }), spawn: sp.fn })));
    expect(withWatch).toEqual(without);
    expect(sp.calls).toEqual([]);

    const on = sessionsOn();
    on.communication.channel = 'terminal';
    const sp2 = spawnStub();
    const r = await wrap(on, (cfg) => startSupervisorWatch(cfg, base({ state: () => ({ state: 'none', lock: null }), spawn: sp2.fn, timer: () => () => {} })));
    expect(r.code).toBe(0);
    // Sessions on without Telegram: the single coordinator's launch (the gateway needs Telegram).
    expect(r.calls).toEqual(without.calls);
    expect(sp2.calls.map((c) => c.args)).toEqual([['coordinator', 'supervise']]);
  });
});
