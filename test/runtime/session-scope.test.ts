// Session-scoped hooks and state (docs/design/coordinator-sessions.md decision 9, task-57 phase 6). With
// MINIONS_SESSION set, the Stop guard, the transcript record, usage states, context-reset checks, handoffs, lease
// holders are scoped to the session; unset, nothing changes. Two sessions' hook inputs on one DB,
// temp transcripts and a fake backlog only (no claude run).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextResetCheck, readHandoff, TRANSCRIPT_META, writeHandoff } from '../../src/runtime/context-reset.js';
import { readSessionState, sessionStates } from '../../src/runtime/coordinator-usage.js';
import { claimWithBrief, recordSubmitted, submitResult, type HandoffPaths } from '../../src/runtime/handoff.js';
import { clearHold, writeHolds, type DispatchHold } from '../../src/runtime/dispatch-state.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { handoffPathFor, hookScope, parseScope, sessionScope } from '../../src/runtime/session-scope.js';
import { humanBaseline, spendReport } from '../../src/runtime/spend.js';
import type { TaskBrief } from '../../src/runtime/scheduler.js';
import { commitFile, makeDefaultEnv, result, tmp, type Env } from './fixtures.js';
// Unit tier: git runs on the in-memory fake (./fake-git.ts).
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));

afterEach(() => { delete process.env.MINIONS_SESSION; });

const paths = (env: Env): HandoffPaths => ({ briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') });
const loader = (env: Env) => () => ({ db: env.db, backlog: env.backlog, config: env.config });
const decision = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout) as { decision: string; reason: string } : null);

/** A main-session transcript whose latest turn has `context` tokens. */
function transcript(name: string, context: number, id = name): string {
  const file = join(tmp('minions-scope-'), `${name}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { id: `msg-${id}`, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: context, cache_creation_input_tokens: 0, output_tokens: 10 } } }) + '\n');
  return file;
}
const stopInput = (sessionId: string, path: string) => ({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: path });
const hold = (taskId: string): DispatchHold => ({ taskId, kind: 'blocked', message: `${taskId} is blocked`, leaseId: null, at: '2026-10-31T00:00:00.000Z', status: 'blocked' });
const sessionEnv = (key: string) => ({ MINIONS_SESSION: key });

function scopeEnv(): Env {
  const env = makeDefaultEnv((c) => {
    c.execution.maxActiveTasks = 3; c.execution.maxEngineers = 3;
    c.coordinator = { contextReset: { enabled: true, afterDelivery: true, contextTokens: 50_000, handoffs: null } };
  });
  env.db.acquireCoordinatorLock('coordinator', 4242, () => false);
  env.backlog.add({ id: 'task-1' });
  env.backlog.add({ id: 'task-2', priority: 'high' });
  return env;
}

/** Runs `fn` with MINIONS_SESSION set in this process (claims read it for the holder and the task check). */
async function inSession<T>(key: string, fn: () => Promise<T>): Promise<T> {
  process.env.MINIONS_SESSION = key;
  try { return await fn(); } finally { delete process.env.MINIONS_SESSION; }
}

async function submitFor(env: Env, brief: TaskBrief, over: Record<string, unknown> = {}): Promise<TaskBrief> {
  const head = brief.role === 'engineer' ? commitFile(brief.worktree, `${brief.leaseId}.txt`, 'work') : brief.expectedHead;
  await submitResult(env.db, paths(env), brief.leaseId, JSON.stringify(result({ branch: brief.branch, headSha: head, ...over })), { role: brief.role, cwd: brief.worktree });
  return brief;
}

describe('session keys (MINIONS_SESSION)', () => {
  it('unset or empty is the single coordinator; router, general and task:<id> parse; anything else is refused', () => {
    expect(sessionScope({})).toBeNull();
    expect(sessionScope({ MINIONS_SESSION: '' })).toBeNull();
    expect(parseScope('router')).toEqual({ key: 'router', kind: 'router', taskId: null });
    expect(parseScope('general')).toEqual({ key: 'general', kind: 'general', taskId: null });
    expect(parseScope('task:task-57.10')).toEqual({ key: 'task:task-57.10', kind: 'task', taskId: 'task-57.10' });
    for (const bad of ['task:', 'task:../x', 'Task:1', 'general ', 'task:a/b']) {
      expect(() => sessionScope({ MINIONS_SESSION: bad })).toThrow(/not a session key/);
      expect(hookScope({ MINIONS_SESSION: bad })).toEqual({ scope: null, invalid: true });
    }
    expect(handoffPathFor('/s', null)).toBe('/s/coordinator-handoff.json');
    expect(handoffPathFor('/s', parseScope('task:task-1'))).toBe('/s/coordinator-handoff.task:task-1.json');
  });
});

describe('two sessions on one DB', () => {
  it('keeps transcripts, usage states, resets, handoffs and Stop guards apart', async () => {
    const env = scopeEnv();
    const t1 = transcript('task-1-a', 60_000);
    const g1 = transcript('general-a', 20_000);

    writeHolds(env.db, { 'task-1': hold('task-1'), 'task-2': hold('task-2') });
    // Stop hooks of both sessions: their own transcript records and usage states, never the single coordinator's.
    const taskStop = await stopHook(stopInput('claude-t1', t1), loader(env), sessionEnv('task:task-1'));
    const generalStop = await stopHook(stopInput('claude-g1', g1), loader(env), sessionEnv('general'));
    expect(env.db.getMeta(TRANSCRIPT_META)).toBeUndefined();
    expect(JSON.parse(env.db.getMeta(`${TRANSCRIPT_META}:task:task-1`)!)).toMatchObject({ path: t1, sessionId: 'claude-t1' });
    expect(JSON.parse(env.db.getMeta(`${TRANSCRIPT_META}:general`)!)).toMatchObject({ path: g1, sessionId: 'claude-g1' });
    expect(readSessionState(env.db, 'claude-t1')).toMatchObject({ role: 'task', sessionKey: 'task:task-1', turns: 1 });
    expect(readSessionState(env.db, 'claude-g1')).toMatchObject({ role: 'general', sessionKey: 'general', turns: 1 });

    // Stop guard: off for general; the task session is held only by its own task's hold (task-2 is held too).
    expect(generalStop.stdout).toBeUndefined();
    expect(generalStop.reason).toMatch(/off for the general session/);
    expect(decision(taskStop)?.decision).toBe('block');
    expect(decision(taskStop)?.reason).toMatch(/holds 1 task\(s\) for your decision: task-1 \(blocked\)/);
    expect(decision(taskStop)?.reason).not.toMatch(/task-2/);
    expect(env.db.guard().fingerprint).toBeNull(); // the single coordinator's guard row is untouched

    // A claim in the task session: the holder is the session key; the task session may not claim another task.
    const e1 = await inSession('task:task-1', () => claimWithBrief(env.sched, paths(env), 'task-1', 'engineer'));
    expect(env.db.lease(e1.leaseId)!.holder).toBe('task:task-1');
    await expect(inSession('task:task-1', () => env.sched.claim('task-2', 'engineer'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(inSession('general', () => env.sched.claim('task-2', 'engineer'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(inSession('task:../x', () => env.sched.claim('task-2', 'engineer'))).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(env.db.activeLeases().map((l) => l.task_id)).toEqual(['task-1']);
    // Once its hold is resolved, the task session may stop although task-2 is still held.
    clearHold(env.db, 'task-1', 'test');
    expect((await stopHook(stopInput('claude-t1', t1), loader(env), sessionEnv('task:task-1'))).reason).toMatch(/no decision waits for task-1/);

    // Context resets: each session sees its own context and leases only.
    const taskCheck = contextResetCheck({ db: env.db, config: env.config, session: parseScope('task:task-1') });
    expect(taskCheck).toMatchObject({ due: false, triggers: ['context'], session: { contextTokens: 60_010 } });
    expect(taskCheck.blockers.join(' ')).toMatch(/1 active worker lease\(s\) of session task:task-1/);
    const generalCheck = contextResetCheck({ db: env.db, config: env.config, session: parseScope('general') });
    expect(generalCheck).toMatchObject({ due: false, triggers: [], blockers: [], session: { contextTokens: 20_010, handoffs: 0 } });

    // Handoffs: one file per session, counted for the writer only (and never for the single coordinator).
    const state = join(env.root, 'state');
    await writeHandoff({ db: env.db, path: handoffPathFor(state, parseScope('general')), scope: parseScope('general') }, 'general: owner asked about X');
    expect(readHandoff(handoffPathFor(state, parseScope('general')))).toMatchObject({ present: true, text: 'general: owner asked about X' });
    expect(existsSync(handoffPathFor(state, null))).toBe(false);
    expect(existsSync(handoffPathFor(state, parseScope('task:task-1')))).toBe(false);
    expect(contextResetCheck({ db: env.db, config: env.config, session: parseScope('general') }).session.handoffWritten).toBe(true);
    expect(contextResetCheck({ db: env.db, config: env.config, session: parseScope('task:task-1') }).session.handoffWritten).toBe(false);
    expect(contextResetCheck({ db: env.db, config: env.config, session: null }).session.handoffWritten).toBe(false);

    // The task session's record counts for it, not for general; once its lease ended the reset is due for it alone.
    await submitFor(env, e1);
    expect((await recordSubmitted(env.sched, paths(env), e1.leaseId, {})).valid).toBe(true);
    const after = contextResetCheck({ db: env.db, config: env.config, session: parseScope('task:task-1') });
    expect(after).toMatchObject({ due: true, triggers: ['context'], session: { handoffs: 1 } });
    expect(contextResetCheck({ db: env.db, config: env.config, session: parseScope('general') })).toMatchObject({ due: false, session: { handoffs: 0 } });

    // A new claude session of task:task-1 (after its reset) completes only that key's open state.
    const t2 = transcript('task-1-b', 5_000);
    await stopHook(stopInput('claude-t2', t2), loader(env), sessionEnv('task:task-1'));
    expect(readSessionState(env.db, 'claude-t1')!.ended).toMatchObject({ trigger: 'exit' });
    expect(readSessionState(env.db, 'claude-g1')!.ended).toBeUndefined();
    expect(contextResetCheck({ db: env.db, config: env.config, session: parseScope('task:task-1') }).session).toMatchObject({ contextTokens: 5_010, handoffs: 0 });

    // The baseline shows tokens per role.
    const bl = spendReport({ db: env.db, config: env.config, billing: 'subscription' }).coordinator.baseline;
    expect(bl.perRole).toEqual({
      task: { sessions: 2, open: 1, tokens: 60_010 + 5_010, turns: 2 },
      general: { sessions: 1, open: 1, tokens: 20_010, turns: 1 },
    });
    expect(humanBaseline(bl)).toMatch(/per role: task 65k tokens \(2 session\(s\), 2 turns\); general 20k tokens/);
  });

  it('a malformed MINIONS_SESSION allows the stop and records nothing', async () => {
    const env = scopeEnv();
    const out = await stopHook(stopInput('claude-x', transcript('x', 70_000)), loader(env), sessionEnv('task:../../etc'));
    expect(out).toEqual({ reason: 'allow: MINIONS_SESSION is not a session key (nothing recorded)' });
    expect(env.db.all("SELECT key FROM meta WHERE key LIKE 'coordinator_transcript%' OR key LIKE 'coordinator_usage%' OR key LIKE 'stop_guard%'")).toEqual([]);
  });
});

describe('the router (phase 8)', () => {
  it('resets at 25k, below contextTokens, and a task session\'s active lease does not block it', async () => {
    const env = scopeEnv();
    await inSession('task:task-1', () => claimWithBrief(env.sched, paths(env), 'task-1', 'engineer'));
    const r1 = transcript('router-a', 30_000);
    await stopHook(stopInput('claude-r1', r1), loader(env), sessionEnv('router'));
    expect(contextResetCheck({ db: env.db, config: env.config, session: parseScope('router') })).toMatchObject({ due: true, triggers: ['context'], blockers: [] });
    // The general session at the same context is below its threshold (contextTokens, default 60k).
    await stopHook(stopInput('claude-g1', transcript('general-a', 30_000)), loader(env), sessionEnv('general'));
    expect(contextResetCheck({ db: env.db, config: env.config, session: parseScope('general') })).toMatchObject({ due: false, triggers: [] });
  });
});

describe('MINIONS_SESSION unset: nothing changes', () => {
  it('the Stop hook, usage states, reset check, handoff path, holder and baseline are the single coordinator\'s', async () => {
    const env = scopeEnv();
    writeHolds(env.db, { 'task-2': hold('task-2') });
    const t = transcript('single', 60_000);
    const unset = await stopHook(stopInput('claude-s', t), loader(env), {});
    // The single coordinator's guard: every hold, the guard row, the unkeyed transcript record.
    expect(decision(unset)?.reason).toMatch(/^minions: the dispatcher holds 1 task\(s\) for your decision: task-2 \(blocked\)/);
    expect(env.db.guard()).toMatchObject({ count: 1, last_reason: 'dispatch-decisions' });
    expect(JSON.parse(env.db.getMeta(TRANSCRIPT_META)!)).toMatchObject({ path: t, sessionId: 'claude-s' });
    expect(env.db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE '%:task:%' OR key LIKE '%:general' OR key LIKE 'stop_guard%'")).toEqual([]);
    const s = readSessionState(env.db, 'claude-s')!;
    expect(s.role).toBe('coordinator');
    expect(s).not.toHaveProperty('sessionKey');
    const ev = env.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE kind = 'usage'").map((r) => JSON.parse(r.data_json) as Record<string, unknown>);
    expect(ev.every((e) => !('sessionKey' in e) && e.role === 'coordinator')).toBe(true);

    // An empty value is the same as unset (same output on a twin DB).
    const twin = scopeEnv();
    writeHolds(twin.db, { 'task-2': hold('task-2') });
    expect(await stopHook(stopInput('claude-s', t), loader(twin), { MINIONS_SESSION: '' })).toEqual(unset);

    // contextResetCheck reads MINIONS_SESSION when no session is given: unset = the single coordinator's check.
    expect(contextResetCheck({ db: env.db, config: env.config })).toEqual(contextResetCheck({ db: env.db, config: env.config, session: null }));
    expect(contextResetCheck({ db: env.db, config: env.config }).session.contextTokens).toBe(60_010);
    const e = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    expect(env.db.lease(e.leaseId)!.holder).toBe(`pid:${process.pid}`);
    expect(handoffPathFor(join(env.root, 'state'), sessionScope())).toBe(join(env.root, 'state', 'coordinator-handoff.json'));
    const bl = spendReport({ db: env.db, config: env.config, billing: 'subscription' }).coordinator.baseline;
    expect(bl).not.toHaveProperty('perRole');
    expect(humanBaseline(bl)).not.toMatch(/per role/);
    expect(sessionStates(env.db)).toHaveLength(1);
  });
});

