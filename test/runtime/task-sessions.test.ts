// Task-57 phase 7 (docs/design/coordinator-sessions.md decision 4): task sessions. The open/close/reopen pass on a
// real DB and scheduler, per-task recovery, and the supervisor driving a fake resident claude
// (test/fixtures/fake-claude-session.mjs, run by node); no real claude ever starts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskStatus } from '../../src/backlog/types.js';
import { noteTranscript, SESSION_HANDOFF_EVENT } from '../../src/runtime/context-reset.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { clearDrain, requestDrain } from '../../src/runtime/drain.js';
import { routineLast, WAKE_EVENT } from '../../src/runtime/routine.js';
import { ROUTER_INBOX_SOURCE, sendToSession } from '../../src/runtime/router.js';
import { enqueueInbox, getSession, markInboxDelivered, pendingInbox, updateSession } from '../../src/runtime/session-store.js';
import { runSupervisor, type SessionLauncher, type SupervisorTiming } from '../../src/runtime/supervisor.js';
import {
  closeReason, openRefusal, recoverTaskSession, SESSION_CLOSE_EVENT, taskSessionPass, type RunnableStage, type TaskSessionDeps,
} from '../../src/runtime/task-sessions.js';
import { makeEnv, type Env } from './fixtures.js';

const T0 = new Date('2026-10-29T10:00:00.000Z');
const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude-session.mjs');

function env(o: { max?: number; routine?: boolean; maxActive?: number } = {}): Env & { state: string } {
  const e = makeEnv((c) => {
    c.coordinator = { ...c.coordinator, sessions: { enabled: true, ...(o.max ? { max: o.max } : {}) } };
    if (o.maxActive) { c.execution.maxActiveTasks = o.maxActive; c.execution.maxEngineers = o.maxActive; }
    if (o.routine) c.routine = { enabled: true, minWakeGapMinutes: 30, maxWakesPerDay: 2 };
  });
  return { ...e, state: join(e.root, 'state') };
}

/** Pass deps; `stages` (when given) replaces `work next` so the gates are tested on their own. */
function deps(e: Env & { state: string }, o: { now?: () => Date; stages?: () => RunnableStage[]; budget?: boolean } = {}): TaskSessionDeps {
  return {
    db: e.db, config: e.config, state: e.state, now: o.now ?? (() => T0),
    runnable: async () => (o.stages ? o.stages() : (await e.sched.next()).runnable.map((s) => ({ taskId: s.taskId, role: s.role }))),
    tasks: async () => e.backlog.listTasks(),
    budgetExhausted: () => o.budget ?? false,
  };
}
const setStatus = (e: Env, id: string, status: TaskStatus) => { e.backlog.tasks.get(id)!.status = status; };

describe('taskSessionPass: opens task sessions within the limits', () => {
  it('opens task:<id> with a /minions:task kickoff for each runnable stage up to coordinator.sessions.max, once', async () => {
    const e = env({ max: 2, maxActive: 3 });
    for (const id of ['task-1', 'task-2', 'task-3']) e.backlog.add({ id });
    const r = await taskSessionPass(deps(e));
    expect(r.opened.map((o) => o.key)).toEqual(['task:task-1', 'task:task-2']);
    expect(r.refused).toEqual([{ taskId: 'task-3', why: expect.stringMatching(/2 session\(s\) open \(coordinator.sessions.max 2\)/) }]);
    expect(getSession(e.db, 'task:task-1')).toMatchObject({ kind: 'task', status: 'open' });
    expect(pendingInbox(e.db, 'task:task-1').map((m) => m.text)).toEqual([expect.stringMatching(/^\/minions:task task-1\n/)]);
    expect(e.db.lastEventOfKind(WAKE_EVENT)?.data).toMatchObject({ session: 'task:task-2', role: 'engineer', reopened: false });
    // Again: nothing new is opened and no second kickoff is queued; the open ones are reported for nudges.
    const again = await taskSessionPass(deps(e));
    expect(again.opened).toEqual([]);
    expect(again.runnableOpen).toEqual(['task-1', 'task-2']);
    expect(pendingInbox(e.db, 'task:task-1')).toHaveLength(1);
  });

  it('refuses at the budget, while starts are paused and during a drain; opens nothing with sessions off', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    const stages = () => [{ taskId: 'task-1', role: 'engineer' }];
    expect((await taskSessionPass(deps(e, { stages, budget: true }))).refused).toEqual([{ taskId: 'task-1', why: 'the owner budget is used up' }]);
    e.db.setPaused({ starts: true });
    expect((await taskSessionPass(deps(e, { stages }))).refused).toEqual([{ taskId: 'task-1', why: 'starts are paused' }]);
    e.db.setPaused({ starts: false });
    const flag = { drainFlag: join(e.state, 'run', 'drain') };
    requestDrain(e.db, flag, 'upgrade to 0.2');
    expect((await taskSessionPass(deps(e, { stages }))).refused[0]!.why).toMatch(/drain is in progress \(upgrade to 0.2\)/);
    clearDrain(e.db, flag, 'test');
    e.db.setPaused({ starts: false });
    e.config.coordinator = { ...e.config.coordinator, sessions: { enabled: false } };
    expect(await taskSessionPass(deps(e, { stages }))).toEqual({ opened: [], closed: [], refused: [], runnableOpen: [] });
    expect(getSession(e.db, 'task:task-1')).toBeNull();
    e.config.coordinator = { ...e.config.coordinator, sessions: { enabled: true } };
    expect((await taskSessionPass(deps(e, { stages }))).opened).toHaveLength(1);
  });

  it('with routine.enabled, the wake gap and daily cap count task session opens together with coordinator wakes', async () => {
    const e = env({ routine: true, maxActive: 3 });
    for (const id of ['task-1', 'task-2', 'task-3']) e.backlog.add({ id });
    let now = T0;
    const d = deps(e, { now: () => now });
    const first = await taskSessionPass(d);
    expect(first.opened.map((o) => o.taskId)).toEqual(['task-1']);
    expect(first.refused.map((x) => x.why)).toEqual([expect.stringMatching(/minWakeGapMinutes 30/), expect.stringMatching(/minWakeGapMinutes 30/)]);
    now = new Date(T0.getTime() + 31 * 60_000);
    expect((await taskSessionPass(d)).opened.map((o) => o.taskId)).toEqual(['task-2']);
    now = new Date(T0.getTime() + 62 * 60_000);
    expect((await taskSessionPass(d)).refused).toEqual([{ taskId: 'task-3', why: expect.stringMatching(/wake limit reached \(2\/2 today/) }]);
    expect(routineLast(e.db, e.config, now).wakesToday).toBe(2);
    // Without the routine there is no gap or cap (attended dispatch, like the single coordinator).
    expect(openRefusal(deps(env()), T0, 0)).toBeNull();
  });
});

describe('taskSessionPass: close and reopen (decision 4)', () => {
  it('closes at delivered, done, cancelled or blocked, never while a worker of the task runs', async () => {
    const e = env({ maxActive: 4, max: 5 });
    for (const id of ['task-1', 'task-2', 'task-3', 'task-4']) e.backlog.add({ id });
    await taskSessionPass(deps(e));
    await e.sched.claim('task-4', undefined, { holder: 'task:task-4' });
    setStatus(e, 'task-1', 'delivered'); setStatus(e, 'task-2', 'done'); setStatus(e, 'task-3', 'cancelled'); setStatus(e, 'task-4', 'blocked');
    const r = await taskSessionPass(deps(e));
    expect(r.closed.map((c) => [c.key, c.reason])).toEqual([['task:task-1', 'the task is delivered'], ['task:task-2', 'the task is done'], ['task:task-3', 'the task is cancelled']]);
    expect(getSession(e.db, 'task:task-1')).toMatchObject({ status: 'closed', closed_at: T0.toISOString() });
    expect(getSession(e.db, 'task:task-4')?.status).toBe('open');
    expect(e.db.lastEventOfKind(SESSION_CLOSE_EVENT)?.data).toMatchObject({ key: 'task:task-3' });
  });

  it('closes at awaiting-human only after the session wrote its handoff, and reopens when the task is runnable again', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await taskSessionPass(deps(e));
    updateSession(e.db, 'task:task-1', { claude_session_id: 'sess-1' });
    setStatus(e, 'task-1', 'awaiting-human');
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-1' }); // an earlier handoff (a reset) does not count
    e.db.addEvent('record', 'task-1', { leaseId: 'lease-1', to: 'awaiting-human' });
    expect(closeReason(e.db, 'task:task-1', { id: 'task-1', status: 'awaiting-human' })).toBeNull();
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-other' });
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed).toEqual([]);
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-1' });
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed).toEqual([{ key: 'task:task-1', taskId: 'task-1', reason: expect.stringMatching(/awaits the owner and the session wrote its handoff/) }]);
    // The owner answered: runnable again. Reopened with the claude session id kept (the transcript continues).
    for (const m of pendingInbox(e.db, 'task:task-1')) e.db.exec('UPDATE session_inbox SET delivered_at = ? WHERE id = ?', T0.toISOString(), m.id);
    setStatus(e, 'task-1', 'changes-requested');
    const r = await taskSessionPass(deps(e, { stages: () => [{ taskId: 'task-1', role: 'engineer' }] }));
    expect(r.opened).toEqual([{ key: 'task:task-1', taskId: 'task-1', role: 'engineer', reopened: true }]);
    expect(getSession(e.db, 'task:task-1')).toMatchObject({ status: 'open', claude_session_id: 'sess-1', closed_at: null });
    expect(pendingInbox(e.db, 'task:task-1')[0]!.text).toMatch(/^\/minions:task task-1\n.*reopened.*Read your handoff first/s);
  });

  // Review of task-57.12: `coordinator send` reopens a closed session for an owner message; the next pass must not
  // close it again before the supervisor delivers that message (it would stay in a closed session's inbox for good).
  const deliverAll = (e: Env, key: string) => { for (const m of pendingInbox(e.db, key)) markInboxDelivered(e.db, m.id, T0); };

  it('a delivered task: a session reopened by send stays open while the owner message is pending, then closes', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await taskSessionPass(deps(e));
    deliverAll(e, 'task:task-1');
    setStatus(e, 'task-1', 'delivered');
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed.map((c) => c.key)).toEqual(['task:task-1']);
    const sent = sendToSession(e.db, e.config, { key: 'task:task-1', text: 'thanks, looks good', state: e.state, now: T0 });
    expect(sent.reopened).toBe(true);
    // The pass runs before the supervisor delivers: the session stays open with the owner message pending.
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed).toEqual([]);
    expect(getSession(e.db, 'task:task-1')?.status).toBe('open');
    expect(pendingInbox(e.db, 'task:task-1', { sources: [ROUTER_INBOX_SOURCE] }).map((m) => m.text)).toEqual(['thanks, looks good']);
    // Delivered: the next pass closes it.
    deliverAll(e, 'task:task-1');
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed).toEqual([{ key: 'task:task-1', taskId: 'task-1', reason: 'the task is delivered' }]);
  });

  it('awaiting-human with a handoff: a session reopened by send stays open while the owner answer is pending, then closes', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await taskSessionPass(deps(e));
    deliverAll(e, 'task:task-1');
    setStatus(e, 'task-1', 'awaiting-human');
    e.db.addEvent('record', 'task-1', { leaseId: 'lease-1', to: 'awaiting-human' });
    e.db.addEvent(SESSION_HANDOFF_EVENT, 'task-1', { session: 'task:task-1' });
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed.map((c) => c.key)).toEqual(['task:task-1']);
    sendToSession(e.db, e.config, { key: 'task:task-1', text: '1', state: e.state, now: T0 });
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed).toEqual([]);
    expect(getSession(e.db, 'task:task-1')?.status).toBe('open');
    expect(pendingInbox(e.db, 'task:task-1').map((m) => m.text)).toEqual(['1']);
    deliverAll(e, 'task:task-1');
    expect((await taskSessionPass(deps(e, { stages: () => [] }))).closed.map((c) => c.key)).toEqual(['task:task-1']);
  });

  it('never reopens a failed session (the owner does)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await taskSessionPass(deps(e));
    updateSession(e.db, 'task:task-1', { status: 'failed', failure: 'boom' });
    const r = await taskSessionPass(deps(e));
    expect(r.opened).toEqual([]);
    expect(r.refused).toEqual([{ taskId: 'task-1', why: expect.stringMatching(/its session failed \(boom\)/) }]);
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

const FAST: Partial<SupervisorTiming> = { tickMs: 25, pollMs: 25, configMs: 60_000, interruptGraceMs: 200, killGraceMs: 500, drainGraceMs: 800, reapGraceMs: 300, openMs: 50, nudgeMs: 60_000 };
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
  it('opens a session for a runnable stage, starts it with /minions:task, and closes its process at delivered', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    const s = supervise(e);
    await until('the kickoff reaches the session', () => events(s.log).some((x) => x.ev === 'msg' && x.text?.startsWith('/minions:task task-1')));
    expect(events(s.log).find((x) => x.ev === 'start')?.env?.MINIONS_SESSION).toBe('task:task-1');
    expect(s.launches).toEqual([{ key: 'task:task-1', resume: null }]);
    setStatus(e, 'task-1', 'delivered');
    await until('the session process gets EOF', () => events(s.log).some((x) => x.ev === 'eof'));
    await until('closed', () => getSession(e.db, 'task:task-1')?.status === 'closed');
    const r = await s.stop();
    expect(r).toMatchObject({ opened: 1, closed: 1, starts: 1 });
  });

  it('after a crash, releases the leases the session held and resumes it with the per-task recovery notice', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    const s = supervise(e);
    await until('the kickoff reaches the session', () => events(s.log).some((x) => x.ev === 'msg' && x.text?.startsWith('/minions:task task-1')));
    // The session claimed the engineer stage (its key is the holder), then its process dies mid-turn.
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
  it('its Stop guard no longer pushes it to dispatch (sessions off: unchanged)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    const load = () => ({ db: e.db, backlog: e.backlog, config: e.config });
    const input = { hook_event_name: 'Stop', session_id: 'coord-1' };
    expect((await stopHook(input, load, {})).reason).toBe('allow: coordinator sessions are on: task sessions dispatch');
    e.config.coordinator = { ...e.config.coordinator, sessions: { enabled: false } };
    const off = await stopHook(input, load, {});
    expect(JSON.parse(off.stdout!)).toMatchObject({ decision: 'block', reason: expect.stringMatching(/run \/minions:orchestrate/) });
  });

  it('work next is not held by the single coordinator\'s reset barrier (the supervisor reads it); sessions off it is', async () => {
    const e = env({ maxActive: 3 });
    e.config.coordinator = { ...e.config.coordinator, contextReset: { enabled: true, afterDelivery: false, contextTokens: null, handoffs: null, barrierTokens: 100_000 } };
    e.db.acquireCoordinatorLock('coordinator', 4242, () => false);
    for (const id of ['task-1', 'task-2']) e.backlog.add({ id });
    await e.sched.claim('task-1', undefined, { holder: 'task:task-1' });
    const file = join(e.root, 'sess.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 0, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0, output_tokens: 0 } } }) + '\n');
    noteTranscript(e.db, { transcript_path: file, session_id: 'sess' });
    expect((await e.sched.next()).runnable.map((s) => s.taskId)).toEqual(['task-2']);
    e.config.coordinator = { ...e.config.coordinator, sessions: { enabled: false } };
    expect((await e.sched.next()).resetPending?.decision).toBe('context-reset-pending');
  });
});
