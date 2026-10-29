// Reset barrier (task-57.6, docs/design/coordinator-sessions.md decision 2 and phase 1): once the coordinator's
// context reaches `coordinator.contextReset.barrierTokens` and only running workers block the reset, new starts are
// held (claim, advance, next), the Stop guard allows the stop, and the reset becomes due once the last worker is
// recorded or released. Below the barrier, with an unknown context, with the barrier off or during a drain, nothing
// changes. Temp state dirs, a fake backlog and a written transcript only.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/resolve.js';
import { MinionsError } from '../../src/core/errors.js';
import { advanceLease, nextDecision } from '../../src/runtime/advance.js';
import { collectStatus, humanStatus } from '../../src/runtime/commands.js';
import { contextResetCheck, contextResetSettings, DEFAULT_BARRIER_TOKENS, noteTranscript, withContextReset } from '../../src/runtime/context-reset.js';
import { claimWithBrief, submitResult, type HandoffPaths } from '../../src/runtime/handoff.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { defaults } from '../helpers.js';
import { commitFile, makeDefaultEnv, result, tmp, type Env } from './fixtures.js';

type ResetCfg = NonNullable<NonNullable<MinionsConfig['coordinator']>['contextReset']>;

const paths = (env: Env): HandoffPaths => ({ briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') });

/** Three task slots; the context-reset fields given (the other triggers off, so only the barrier counts). */
function barrierEnv(reset: Partial<ResetCfg> = {}): Env {
  const env = makeDefaultEnv((c) => {
    c.execution.maxActiveTasks = 3; c.execution.maxEngineers = 3;
    c.coordinator = { contextReset: { enabled: true, afterDelivery: false, contextTokens: null, handoffs: null, ...reset } };
  });
  env.db.acquireCoordinatorLock('coordinator', 4242, () => false);
  for (const id of ['task-1', 'task-2', 'task-3']) env.backlog.add({ id });
  return env;
}

/** The Stop hook's transcript record with a latest main-session turn of `tokens` context. */
function setContext(env: Env, tokens: number): string {
  const file = join(tmp('minions-barrier-'), 'sess.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 0 } } }) + '\n');
  noteTranscript(env.db, { transcript_path: file, session_id: 'sess' });
  return file;
}

async function submitEngineer(env: Env, taskId: string) {
  const brief = await claimWithBrief(env.sched, paths(env), taskId, 'engineer');
  const head = commitFile(brief.worktree, `${brief.leaseId}.txt`, 'work');
  await submitResult(env.db, paths(env), brief.leaseId, JSON.stringify(result({ branch: brief.branch, headSha: head })), { role: brief.role, cwd: brief.worktree });
  return brief;
}

const deps = (env: Env) => ({ db: env.db, config: env.config });

describe('reset barrier (task-57.6)', () => {
  it('setting: default 120k, null = off, validated like contextTokens', () => {
    expect(DEFAULT_BARRIER_TOKENS).toBe(120_000);
    expect(contextResetSettings(defaults()).barrierTokens).toBe(120_000);
    const off = { ...defaults(), coordinator: { contextReset: { enabled: true, barrierTokens: null } } };
    expect(validateConfig(off, 'x').coordinator?.contextReset?.barrierTokens).toBeNull();
    expect(contextResetSettings(off).barrierTokens).toBeNull();
    expect(() => validateConfig({ ...defaults(), coordinator: { contextReset: { enabled: true, barrierTokens: 10 } } }, 'x')).toThrow(/barrierTokens/);
  });

  it('at the barrier with workers running: claim, next and advance start nothing; the Stop guard allows; the last record makes the reset due', async () => {
    const env = barrierEnv();
    const e1 = await submitEngineer(env, 'task-1');
    const e2 = await claimWithBrief(env.sched, paths(env), 'task-2', 'engineer');
    const transcript = setContext(env, 130_000);

    const c = contextResetCheck(deps(env));
    expect(c).toMatchObject({ due: false, triggers: ['context'], barrier: { tokens: 120_000, reached: true, pending: true } });
    expect(c.reason).toMatch(/^context reset pending: context 130000 >= the barrier 120000 tokens; new stages wait until 2 running worker\(s\) return/);

    // work claim: refused with the decision and a hint; no lease was created.
    const err = await env.sched.claim('task-3', 'engineer').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinionsError);
    expect(err).toMatchObject({ code: 'PRECONDITION', details: { decision: 'context-reset-pending', contextTokens: 130_000, barrierTokens: 120_000 } });
    expect((err as MinionsError).hint).toMatch(/Start nothing new/);
    expect(env.db.activeLeases().map((l) => l.task_id).sort()).toEqual(['task-1', 'task-2']);

    // work next: the ready stage waits on the reset.
    const next = await env.sched.next();
    expect(next.runnable).toEqual([]);
    expect(next.waiting).toEqual([expect.objectContaining({ taskId: 'task-3', role: 'engineer', waitingOn: 'context-reset' })]);
    expect(next.resetPending).toMatchObject({ decision: 'context-reset-pending' });
    expect(next.message).toMatch(/^Nothing runnable: context reset pending/);
    expect(nextDecision(env.db, next)).toMatchObject({ kind: 'context-reset-pending', hint: expect.stringMatching(/Start nothing new/) });

    // The Stop guard lets the coordinator stop (runnable work exists, but its start is held).
    const stop = await stopHook({ transcript_path: transcript, session_id: 'sess' }, () => ({ db: env.db, backlog: env.backlog, config: env.config }));
    expect(stop.stdout).toBeUndefined();
    expect(stop.reason).toMatch(/^allow: context reset pending/);

    // status shows the barrier.
    const status = await collectStatus({ db: env.db, config: env.config, backlog: async () => env.backlog });
    expect(status.contextReset).toMatchObject({ due: false, barrier: { pending: true } });
    expect(humanStatus(status)).toMatch(/context reset: pending \(.*context 130k, barrier 120k reached: new starts held/);

    // work advance: the record still happens; the next stage (task-1 reviewer) is not claimed.
    const adv = await advanceLease(env.sched, paths(env), e1.leaseId, {}, deps(env));
    expect(adv.record).toMatchObject({ valid: true, to: 'reviewing' });
    expect(adv.record.contextReset).toBeUndefined(); // task-2's engineer still runs
    expect(adv.next).toBeUndefined();
    expect(adv.decision).toMatchObject({ kind: 'context-reset-pending' });
    expect(adv.decision!.waiting).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-1', role: 'reviewer', waitingOn: 'context-reset' }),
      expect.objectContaining({ taskId: 'task-3', role: 'engineer', waitingOn: 'context-reset' }),
    ]));

    // The last running worker is released: the reset is due (the barrier is a context trigger on its own).
    const rel = withContextReset(await env.sched.release(e2.leaseId, 'owner cancelled'), env);
    expect(rel.contextReset).toEqual({ due: true, reason: 'context reset due: context 130000 >= the barrier 120000 tokens', steps: expect.any(Array) });
    expect(contextResetCheck(deps(env)).barrier).toEqual({ tokens: 120_000, reached: true, pending: false });
  });

  it('contextReset.enabled: false at the barrier with workers running: claim, next and advance are not held (task-57.16)', async () => {
    const env = barrierEnv({ enabled: false });
    const e1 = await submitEngineer(env, 'task-1');
    await claimWithBrief(env.sched, paths(env), 'task-2', 'engineer');
    setContext(env, 130_000);

    // The context is past the barrier, but resets are off: nothing is pending or due.
    const c = contextResetCheck(deps(env));
    expect(c).toMatchObject({ enabled: false, due: false, barrier: { tokens: 120_000, reached: true, pending: false } });
    expect(c.reason).not.toMatch(/pending/);

    // work next: task-3 is runnable, no reset decision.
    const next = await env.sched.next();
    expect(next.resetPending).toBeUndefined();
    expect(next.runnable.map((s) => s.taskId)).toContain('task-3');
    expect(next.waiting.filter((w) => w.waitingOn === 'context-reset')).toEqual([]);
    expect(nextDecision(env.db, next)?.kind).not.toBe('context-reset-pending');

    // work advance: the record happens and the decision is not a reset hold.
    const adv = await advanceLease(env.sched, paths(env), e1.leaseId, {}, deps(env));
    expect(adv.record).toMatchObject({ valid: true, to: 'reviewing' });
    expect(adv.record.contextReset).toBeUndefined();
    expect(adv.decision?.kind).not.toBe('context-reset-pending');
    expect((adv.decision?.waiting ?? []).filter((w) => w.waitingOn === 'context-reset')).toEqual([]);

    // work claim: goes through.
    await expect(env.sched.claim('task-3', 'engineer')).resolves.toMatchObject({ task: { id: 'task-3' } });
  });

  it('nothing changes below the barrier, with an unknown context, with the barrier off, or during a drain', async () => {
    // Below the barrier: claims go on.
    let env = barrierEnv();
    await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    setContext(env, 119_999);
    expect(contextResetCheck(deps(env)).barrier).toMatchObject({ reached: false, pending: false });
    expect((await env.sched.next()).resetPending).toBeUndefined();
    await expect(env.sched.claim('task-2', 'engineer')).resolves.toMatchObject({ task: { id: 'task-2' } });

    // Unknown context (no transcript recorded this session): no barrier.
    env = barrierEnv();
    await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    expect(contextResetCheck(deps(env))).toMatchObject({ session: { contextTokens: null }, barrier: { pending: false } });
    await expect(env.sched.claim('task-2', 'engineer')).resolves.toMatchObject({ task: { id: 'task-2' } });

    // barrierTokens: null: no barrier at any size.
    env = barrierEnv({ barrierTokens: null });
    await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    setContext(env, 500_000);
    expect(contextResetCheck(deps(env))).toMatchObject({ triggers: [], barrier: { tokens: null, pending: false } });
    const n = await env.sched.next();
    expect(n.runnable.map((s) => s.taskId)).toContain('task-2');
    await expect(env.sched.claim('task-2', 'engineer')).resolves.toMatchObject({ task: { id: 'task-2' } });

    // A drain keeps its own behaviour: no barrier (starts are held by the drain, the stage waits on `starts`).
    env = barrierEnv();
    await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    setContext(env, 130_000);
    env.db.setDrain('upgrade');
    expect(contextResetCheck(deps(env)).barrier).toMatchObject({ reached: true, pending: false });
    expect((await env.sched.next()).resetPending).toBeUndefined();
  });
});
