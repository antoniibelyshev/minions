// Task-57 phase 7 (docs/design/coordinator-sessions.md decision 4): task sessions. Since docs/design/autonomy.md
// Decision 10 a task session is opened for a held decision or an owner message, never for a runnable stage. The close
// pass on a real DB and scheduler, per-task recovery, and the supervisor driving a fake resident claude
// (test/fixtures/fake-claude-session.mjs, run by node); no real claude ever starts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskStatus } from '../../src/backlog/types.js';
import { SESSION_HANDOFF_EVENT } from '../../src/runtime/context-reset.js';
import { writeHolds } from '../../src/runtime/dispatch-state.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { ROUTER_INBOX_SOURCE, sendToSession } from '../../src/runtime/router.js';
import { enqueueInbox, getSession, markInboxDelivered, openSession, pendingInbox, updateSession } from '../../src/runtime/session-store.js';
import { sessionConfigDir } from '../../src/runtime/sessions.js';
import { runSupervisor, type SessionLauncher, type SupervisorTiming } from '../../src/runtime/supervisor.js';
import { closeReason, recoverTaskSession, SESSION_CLOSE_EVENT, taskKickoff, taskSessionPass, type TaskSessionDeps } from '../../src/runtime/task-sessions.js';
import { makeEnv, type Env } from './fixtures.js';

const T0 = new Date('2026-10-29T10:00:00.000Z');
const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude-session.mjs');

function env(o: { max?: number; maxActive?: number } = {}): Env & { state: string } {
  const e = makeEnv((c) => {
    c.coordinator = { ...c.coordinator, sessions: { enabled: true, ...(o.max ? { max: o.max } : {}) } };
    if (o.maxActive) { c.execution.maxActiveTasks = o.maxActive; c.execution.maxEngineers = o.maxActive; }
  });
  return { ...e, state: join(e.root, 'state') };
}

function deps(e: Env & { state: string }, o: { now?: () => Date } = {}): TaskSessionDeps {
  return { db: e.db, config: e.config, now: o.now ?? (() => T0), tasks: async () => e.backlog.listTasks() };
}
const setStatus = (e: Env, id: string, status: TaskStatus) => { e.backlog.tasks.get(id)!.status = status; };
/** Opens task:<id> as a held decision does (notifyHold): the row plus a kickoff in its inbox. */
const openFor = (e: Env & { state: string }, id: string, now = T0) => {
  openSession(e.db, `task:${id}`, { configDir: sessionConfigDir({ state: e.state }, `task:${id}`), now });
  enqueueInbox(e.db, `task:${id}`, 'dispatcher', taskKickoff(id, `${id} needs your decision (blocked).`), { now });
};

describe('taskSessionPass: close (decision 4)', () => {
  it('never opens a session for a runnable stage; with sessions off it does nothing', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    expect(await taskSessionPass(deps(e))).toEqual({ closed: [] });
    expect(getSession(e.db, 'task:task-1')).toBeNull();
    e.config.coordinator = { ...e.config.coordinator, sessions: { enabled: false } };
    openFor(e, 'task-1');
    setStatus(e, 'task-1', 'done');
    expect(await taskSessionPass(deps(e))).toEqual({ closed: [] });
  });

  it('closes at delivered, done, cancelled or blocked, never while a worker of the task runs', async () => {
    const e = env({ maxActive: 4, max: 5 });
    for (const id of ['task-1', 'task-2', 'task-3', 'task-4']) { e.backlog.add({ id }); openFor(e, id); }
    await e.sched.claim('task-4', undefined, { holder: 'task:task-4' });
    setStatus(e, 'task-1', 'delivered'); setStatus(e, 'task-2', 'done'); setStatus(e, 'task-3', 'cancelled'); setStatus(e, 'task-4', 'blocked');
    const r = await taskSessionPass(deps(e));
    expect(r.closed.map((c) => [c.key, c.reason])).toEqual([['task:task-1', 'the task is delivered'], ['task:task-2', 'the task is done'], ['task:task-3', 'the task is cancelled']]);
    expect(getSession(e.db, 'task:task-1')).toMatchObject({ status: 'closed', closed_at: T0.toISOString() });
    expect(getSession(e.db, 'task:task-4')?.status).toBe('open');
    expect(e.db.lastEventOfKind(SESSION_CLOSE_EVENT)?.data).toMatchObject({ key: 'task:task-3' });
  });

  it('closes at awaiting-human only after the session wrote its handoff; a later hold reopens it with its claude session', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    openFor(e, 'task-1');
    updateSession(e.db, 'task:task-1', { claude_session_id: 'sess-1' });
    setStatus(e, 'task-1', 'awaiting-human');
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-1' }); // an earlier handoff (a reset) does not count
    e.db.addEvent('record', 'task-1', { leaseId: 'lease-1', to: 'awaiting-human' });
    expect(closeReason(e.db, 'task:task-1', { id: 'task-1', status: 'awaiting-human' })).toBeNull();
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-other' });
    expect((await taskSessionPass(deps(e))).closed).toEqual([]);
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-1' });
    expect((await taskSessionPass(deps(e))).closed).toEqual([{ key: 'task:task-1', taskId: 'task-1', reason: expect.stringMatching(/awaits the owner and the session wrote its handoff/) }]);
    openFor(e, 'task-1');
    expect(getSession(e.db, 'task:task-1')).toMatchObject({ status: 'open', claude_session_id: 'sess-1', closed_at: null });
  });

  // Review of task-57.12: `coordinator send` reopens a closed session for an owner message; the next pass must not
  // close it again before the supervisor delivers that message (it would stay in a closed session's inbox for good).
  const deliverAll = (e: Env, key: string) => { for (const m of pendingInbox(e.db, key)) markInboxDelivered(e.db, m.id, T0); };

  it('a delivered task: a session reopened by send stays open while the owner message is pending, then closes', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    openFor(e, 'task-1');
    deliverAll(e, 'task:task-1');
    setStatus(e, 'task-1', 'delivered');
    expect((await taskSessionPass(deps(e))).closed.map((c) => c.key)).toEqual(['task:task-1']);
    const sent = sendToSession(e.db, e.config, { key: 'task:task-1', text: 'thanks, looks good', state: e.state, now: T0 });
    expect(sent.reopened).toBe(true);
    // The pass runs before the supervisor delivers: the session stays open with the owner message pending.
    expect((await taskSessionPass(deps(e))).closed).toEqual([]);
    expect(getSession(e.db, 'task:task-1')?.status).toBe('open');
    expect(pendingInbox(e.db, 'task:task-1', { sources: [ROUTER_INBOX_SOURCE] }).map((m) => m.text)).toEqual(['thanks, looks good']);
    // Delivered: the next pass closes it.
    deliverAll(e, 'task:task-1');
    expect((await taskSessionPass(deps(e))).closed).toEqual([{ key: 'task:task-1', taskId: 'task-1', reason: 'the task is delivered' }]);
  });

  it('awaiting-human with a handoff: a session reopened by send stays open while the owner answer is pending, then closes', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    openFor(e, 'task-1');
    deliverAll(e, 'task:task-1');
    setStatus(e, 'task-1', 'awaiting-human');
    e.db.addEvent('record', 'task-1', { leaseId: 'lease-1', to: 'awaiting-human' });
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-1' });
    expect((await taskSessionPass(deps(e))).closed.map((c) => c.key)).toEqual(['task:task-1']);
    sendToSession(e.db, e.config, { key: 'task:task-1', text: '1', state: e.state, now: T0 });
    expect((await taskSessionPass(deps(e))).closed).toEqual([]);
    expect(getSession(e.db, 'task:task-1')?.status).toBe('open');
    expect(pendingInbox(e.db, 'task:task-1').map((m) => m.text)).toEqual(['1']);
    deliverAll(e, 'task:task-1');
    expect((await taskSessionPass(deps(e))).closed.map((c) => c.key)).toEqual(['task:task-1']);
  });
});

describe('recoverTaskSession: one task after its session process ended', () => {
  it('releases the session\'s leases without a submission (the stage is runnable again) and leaves submitted ones', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    e.backlog.add({ id: 'task-2' });
    const a = await e.sched.claim('task-1', undefined, { holder: 'task:task-1' });
    const other = await e.sched.claim('task-2', undefined, { holder: 'task:task-2' });
    const release = (id: string, reason: string) => e.sched.release(id, reason);
    const kept = await recoverTaskSession(e.db, 'task:task-1', { hasSubmission: async () => true, release });
    expect(kept).toEqual({ released: [], submitted: [a.leaseId], errors: [] });
    expect(e.db.lease(a.leaseId)?.status).toBe('active');
    const r = await recoverTaskSession(e.db, 'task:task-1', { hasSubmission: async () => false, release });
    expect(r).toEqual({ released: [a.leaseId], submitted: [], errors: [] });
    expect(e.db.lease(a.leaseId)?.status).toBe('released');
    expect(e.db.lease(other.leaseId)?.status).toBe('active'); // another session's lease is never touched
    expect((await e.sched.next()).runnable.map((s) => s.taskId)).toContain('task-1');
  });
});

// ---------------------------------------------------------------- the supervisor with a fake claude

const FAST: Partial<SupervisorTiming> = { tickMs: 25, pollMs: 25, configMs: 60_000, interruptGraceMs: 200, killGraceMs: 500, drainGraceMs: 800, reapGraceMs: 300, openMs: 50 };
interface FakeEvent { ev: string; text?: string; argv?: string[]; env?: { MINIONS_SESSION: string | null } }
const events = (file: string): FakeEvent[] => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as FakeEvent) : []);
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out waiting for: ${what}`);
}
const stops: (() => void)[] = [];
afterEach(() => { for (const s of stops.splice(0)) s(); });

function supervise(e: Env & { state: string }) {
  const log = join(e.root, 'fake.log');
  const launches: { key: string; resume: string | null }[] = [];
  const launch: SessionLauncher = async (_c, key, o) => {
    launches.push({ key, resume: o.resume ?? null });
    return { command: process.execPath, args: [FAKE, ...(o.resume ? ['--resume', o.resume] : [])], cwd: e.root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_LOG: log, MINIONS_SESSION: key } };
  };
  const ac = new AbortController();
  const lines: string[] = [];
  const done = runSupervisor({
    db: e.db, state: e.state, config: async () => e.config, launch, timing: FAST, signal: ac.signal, log: (l) => lines.push(l),
    tasks: {
      pass: async () => taskSessionPass(deps(e, { now: () => new Date() })),
      recover: (key) => recoverTaskSession(e.db, key, { hasSubmission: async () => false, release: (id, reason) => e.sched.release(id, reason) }),
    },
  });
  stops.push(() => ac.abort());
  return { log, launches, lines, stop: async () => { ac.abort(); return done; } };
}

describe('the supervisor drives task sessions (fake claude)', { timeout: 30_000 }, () => {
  it('starts a held task\'s session with /minions:task and closes its process at delivered', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    openFor(e, 'task-1', new Date());
    const s = supervise(e);
    await until('the kickoff reaches the session', () => events(s.log).some((x) => x.ev === 'msg' && x.text?.startsWith('/minions:task task-1')));
    expect(events(s.log).find((x) => x.ev === 'start')?.env?.MINIONS_SESSION).toBe('task:task-1');
    expect(s.launches).toEqual([{ key: 'task:task-1', resume: null }]);
    setStatus(e, 'task-1', 'delivered');
    await until('the session process gets EOF', () => events(s.log).some((x) => x.ev === 'eof'));
    await until('closed', () => getSession(e.db, 'task:task-1')?.status === 'closed');
    const r = await s.stop();
    expect(r).toMatchObject({ closed: 1, starts: 1 });
  });

  it('after a crash, releases the leases the session held and resumes it with the per-task recovery notice', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    openFor(e, 'task-1', new Date());
    const s = supervise(e);
    await until('the kickoff reaches the session', () => events(s.log).some((x) => x.ev === 'msg' && x.text?.startsWith('/minions:task task-1')));
    // A lease of the session (from before the dispatcher ran every stage), then its process dies mid-turn.
    const lease = await e.sched.claim('task-1', undefined, { holder: 'task:task-1' });
    enqueueInbox(e.db, 'task:task-1', 'owner', 'CRASH now');
    await until('the recovery notice reaches the resumed session', () => events(s.log).some((x) => x.ev === 'msg' && /per-task recovery for task-1/.test(x.text ?? '')));
    expect(e.db.lease(lease.leaseId)?.status).toBe('released');
    expect(events(s.log).filter((x) => x.ev === 'msg').map((x) => x.text).join('\n')).toMatch(new RegExp(`Released .*${lease.leaseId}`));
    expect(s.launches).toEqual([{ key: 'task:task-1', resume: null }, { key: 'task:task-1', resume: 'sess-1' }]);
    expect(getSession(e.db, 'task:task-1')?.status).toBe('open');
    expect(e.db.lastEventOfKind('session-crash')?.data).toMatchObject({ key: 'task:task-1', resume: 1 });
    await s.stop();
  });
});

describe('the single coordinator with sessions on', () => {
  it('its Stop guard is off: holds go to their task sessions (sessions off: a hold keeps it going)', async () => {
    const e = env();
    writeHolds(e.db, { 'task-1': { taskId: 'task-1', kind: 'blocked', message: 'stuck', leaseId: null, at: T0.toISOString(), status: 'blocked' } });
    const load = () => ({ db: e.db, backlog: e.backlog, config: e.config });
    const input = { hook_event_name: 'Stop', session_id: 'coord-1' };
    expect((await stopHook(input, load, {})).reason).toBe('allow: coordinator sessions are on: holds go to their task sessions');
    e.config.coordinator = { ...e.config.coordinator, sessions: { enabled: false } };
    const off = await stopHook(input, load, {});
    expect(JSON.parse(off.stdout!)).toMatchObject({ decision: 'block', reason: expect.stringMatching(/the dispatcher holds 1 task\(s\) for your decision/) });
  });
});
