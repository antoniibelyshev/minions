// The autopilot dispatcher (docs/design/autonomy.md Decision 1): stages move dev -> review -> delivered without the
// coordinator; decisions park the task (a hold) and reach the coordinator.
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { DISPATCH_HOLDER, Dispatcher, clearHold, readHolds, workerPrompt, type DispatchHold, type LaunchInput, type WorkerExit, type WorkerHandle } from '../../src/runtime/dispatcher.js';
import { claimWithBrief, submitResult, type HandoffPaths } from '../../src/runtime/handoff.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { asWorkerInput, preBashHook, stopHook, WORKER_LEASE_ENV } from '../../src/runtime/hooks.js';
import { parseStreamLine, summarizeWorkerLog, workerEnv } from '../../src/runtime/dispatch-launch.js';
import { collectWakeReasons } from '../../src/runtime/routine.js';
import { commitFile, makeDefaultEnv, result, type Env } from './fixtures.js';
// Unit tier: git runs on the in-memory fake (./fake-git.ts).
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));

const paths = (env: Env): HandoffPaths & { state: string } => ({ briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results'), state: join(env.root, 'state') });

/** What a fake worker does for a role: commit (producers) and submit `over`, or submit nothing. */
type Script = (i: LaunchInput) => Record<string, unknown> | null;

const exit = (over: Partial<WorkerExit> = {}): WorkerExit => ({ code: 0, signal: null, stopped: null, tokens: 1000, model: 'sonnet', sessionId: 'sess-1', stderrTail: '', spawnError: null, ...over });

function setup(script: Script, mutate?: (c: MinionsConfig) => void, exitOf: (i: LaunchInput) => WorkerExit = () => exit()) {
  const env = makeDefaultEnv((c) => { mutate?.(c); });
  const launches: LaunchInput[] = [];
  const notified: DispatchHold[] = [];
  const launch = async (i: LaunchInput): Promise<WorkerHandle> => {
    launches.push(i);
    const over = script(i);
    if (over) {
      const head = i.claim.role === 'engineer' ? commitFile(i.claim.worktree, `${i.claim.leaseId}-${launches.length}.txt`, 'work') : env.db.lease(i.claim.leaseId)!.head_sha ?? i.claim.expectedHead;
      await submitResult(env.db, paths(env), i.claim.leaseId, JSON.stringify(result({ branch: i.claim.branch, headSha: head, ...over })), { role: i.claim.role, cwd: i.claim.worktree });
    }
    return { done: Promise.resolve(exitOf(i)), pid: () => 4242, sessionId: () => 'sess-1' };
  };
  const disp = new Dispatcher({
    db: env.db, paths: paths(env), config: async () => structuredClone(env.config),
    // As in production: a scheduler on each pass's fresh config.
    scheduler: async (cfg) => new Scheduler({ db: env.db, backlog: env.backlog, config: cfg, layout: env.layout, handoff: paths(env) }), launch,
    taskStatus: async (_s, id) => (await env.backlog.getTask(id)).status, notify: (h) => { notified.push(h); },
  });
  return { env, disp, launches, notified };
}

/** Passes until nothing starts (each started worker's exit is recorded before the next pass). */
async function drive(disp: Dispatcher, max = 10): Promise<number> {
  let started = 0;
  for (let i = 0; i < max; i++) {
    const r = await disp.pass();
    await disp.settled();
    if (!r.started.length) break;
    started += r.started.length;
  }
  return started;
}

describe('dispatcher: the automatic flow', () => {
  it('takes a ready task through engineer and reviewer to delivered without the coordinator', async () => {
    const { env, disp, launches, notified } = setup((i) => (i.claim.role === 'reviewer' ? { verdict: 'approve' } : {}));
    env.backlog.add({ id: 'task-1' });
    expect(await drive(disp)).toBe(2);
    expect(launches.map((l) => `${l.stage.taskId}:${l.stage.role}`)).toEqual(['task-1:engineer', 'task-1:reviewer']);
    expect(launches[0]!.stage.agentType).toBe('minions:engineer');
    expect((await env.backlog.getTask('task-1')).status).toBe('delivered');
    expect(env.db.all<{ holder: string }>('SELECT holder FROM leases').every((l) => l.holder === DISPATCH_HOLDER)).toBe(true);
    expect(notified).toEqual([]);
    expect(readHolds(env.db)).toEqual({});
  });

  it('a workflow change applies to the next stage: dropping the tester while the engineer runs', async () => {
    let env!: Env;
    const { env: e, disp, launches } = setup((i) => {
      if (i.claim.role === 'engineer') { env.config.workflows = { default: ['engineer', 'reviewer'] }; env.config.verification.testerRequired = false; } // `minions control set ...`
      return i.claim.role === 'reviewer' ? { verdict: 'approve' } : {};
    }, (c) => { c.verification.testerRequired = true; });
    env = e;
    env.backlog.add({ id: 'task-1' });
    await drive(disp);
    expect(launches.map((l) => l.stage.role)).toEqual(['engineer', 'reviewer']);
    expect((await env.backlog.getTask('task-1')).status).toBe('delivered');
  });

  it('a task already waiting for a removed stage moves on to the next one', async () => {
    let env!: Env;
    const { env: e, disp, launches } = setup((i) => (i.claim.role === 'reviewer' ? { verdict: 'approve' } : {}), (c) => { c.verification.testerRequired = true; });
    env = e;
    env.backlog.add({ id: 'task-1' });
    await disp.pass(); await disp.settled(); // engineer -> testing
    expect((await env.backlog.getTask('task-1')).status).toBe('testing');
    env.config.workflows = { default: ['engineer', 'reviewer'] };
    env.config.verification.testerRequired = false;
    await drive(disp);
    expect(launches.map((l) => l.stage.role)).toEqual(['engineer', 'reviewer']);
    expect((await env.backlog.getTask('task-1')).status).toBe('delivered');
  });

  it('the flow decides whether the work lands: with local integration on, a flow without merge stops at delivered', async () => {
    const { env, disp } = setup((i) => (i.claim.role === 'reviewer' ? { verdict: 'approve' } : {}), (c) => {
      c.delivery.merge = 'auto-when-eligible'; c.verification.commands = ['npm test'];
      c.workflows = { review: ['engineer', 'reviewer', 'ci'], land: ['engineer', 'reviewer', 'ci', 'merge'] };
    });
    env.backlog.add({ id: 'task-1', workflow: 'review' } as never);
    env.backlog.add({ id: 'task-2', workflow: 'land' } as never);
    env.config.execution.maxActiveTasks = 2; env.config.execution.maxEngineers = 2;
    await drive(disp);
    expect((await env.backlog.getTask('task-1')).status).toBe('delivered');
    expect((await env.backlog.getTask('task-2')).status).toBe('merging');
  });

  it('runs a repair cycle on its own: reviewer request-changes -> engineer -> reviewer', async () => {
    let reviews = 0;
    const { env, disp, launches } = setup((i) => {
      if (i.claim.role !== 'reviewer') return {};
      return ++reviews === 1 ? { status: 'needs_changes', verdict: 'request-changes', findings: ['add a test'] } : { verdict: 'approve' };
    });
    env.backlog.add({ id: 'task-1' });
    await drive(disp);
    expect(launches.map((l) => l.stage.role)).toEqual(['engineer', 'reviewer', 'engineer', 'reviewer']);
    expect((await env.backlog.getTask('task-1')).status).toBe('delivered');
  });

  it('a worker that ends without a result parks the task for the coordinator and frees the lease', async () => {
    const { env, disp, notified } = setup(() => null);
    env.backlog.add({ id: 'task-1' });
    await drive(disp);
    expect(env.db.activeLeases()).toEqual([]);
    expect(readHolds(env.db)['task-1']).toMatchObject({ kind: 'no-result', leaseId: expect.stringMatching(/^lease-/) });
    expect(notified.map((h) => h.kind)).toEqual(['no-result']);
    // Held: never claimed again until the coordinator acts.
    expect((await disp.pass()).started).toEqual([]);
    expect(collectWakeReasons(env.db)).toEqual([expect.objectContaining({ kind: 'dispatch-decision', taskId: 'task-1' })]);
    expect(clearHold(env.db, 'task-1', 'handled')).toBe(true);
    expect((await disp.pass()).started.map((s) => s.taskId)).toEqual(['task-1']);
  });

  it('a worker stopped for a drain is released without a decision; the stage stays runnable', async () => {
    const { env, disp, notified } = setup(() => null, undefined, () => exit({ stopped: 'drain', code: null, signal: 'SIGINT' }));
    env.backlog.add({ id: 'task-1' });
    await disp.pass(); await disp.settled();
    expect(env.db.activeLeases()).toEqual([]);
    expect(readHolds(env.db)).toEqual({});
    expect(notified).toEqual([]);
  });

  it('a failure while recording never leaves the lease active: it is released and the task held', async () => {
    const { env, disp } = setup(() => ({}));
    env.backlog.add({ id: 'task-1' });
    let n = 0;
    // The pass reads the config once; the exit handling's first read fails.
    (disp as unknown as { d: { config: () => Promise<MinionsConfig> } }).d.config = async () => { if (n++ === 1) throw new Error('config unreadable'); return structuredClone(env.config); };
    await disp.pass();
    await disp.settled();
    expect(env.db.activeLeases()).toEqual([]);
    expect(readHolds(env.db)['task-1']).toMatchObject({ kind: 'no-result' });
  });

  it('a hold clears itself when the coordinator changes the task status', async () => {
    const { env, disp } = setup((i) => (i.claim.role === 'engineer' ? { status: 'blocked', findings: ['needs a key'] } : { verdict: 'approve' }));
    env.backlog.add({ id: 'task-1' });
    await drive(disp);
    const h = readHolds(env.db)['task-1'];
    expect(h?.kind).toBe('blocked');
    const t = await env.backlog.getTask('task-1');
    await env.backlog.updateTask('task-1', t.version, { status: 'ready' }); // the coordinator unblocked it
    const r = await disp.pass();
    expect(r.cleared).toEqual(['task-1']);
  });

  it('an invalid result gets one automatic correction on the same lease, with the errors', async () => {
    let n = 0;
    const { env, disp, launches } = setup((i) => {
      if (i.claim.role === 'reviewer') return { verdict: 'approve' };
      n++;
      return n === 1 ? { checks: [{ command: 'npm test', outcome: 'fail' }] } : {};
    });
    env.backlog.add({ id: 'task-1' });
    await drive(disp);
    expect(launches[1]).toMatchObject({ correction: { resume: 'sess-1' } });
    expect(launches[1]!.claim.leaseId).toBe(launches[0]!.claim.leaseId);
    expect(launches[1]!.correction!.errors.length).toBeGreaterThan(0);
    expect(workerPrompt(launches[1]!.claim, launches[1]!.correction)).toMatch(/rejected[\s\S]*only correction/);
    expect(launches.map((l) => l.stage.role)).toEqual(['engineer', 'engineer', 'reviewer']);
  });

  it('recovers a previous dispatcher\'s lease: a submitted result is recorded, one without is released', async () => {
    const { env, disp } = setup((i) => (i.claim.role === 'reviewer' ? { verdict: 'approve' } : {}), (c) => { c.execution.maxActiveTasks = 2; c.execution.maxEngineers = 2; });
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const a = await claimWithBrief(env.sched, paths(env), 'task-1', undefined, { holder: DISPATCH_HOLDER });
    const head = commitFile(a.worktree, 'x.txt', 'x');
    await submitResult(env.db, paths(env), a.leaseId, JSON.stringify(result({ branch: a.branch, headSha: head })), { role: a.role, cwd: a.worktree });
    const b = await claimWithBrief(env.sched, paths(env), 'task-2', undefined, { holder: DISPATCH_HOLDER });
    const r = await disp.recover();
    expect(r).toEqual({ recorded: [a.leaseId], released: [b.leaseId], adopted: [] });
    expect((await env.backlog.getTask('task-1')).status).toBe('reviewing');
    expect(env.db.activeLeases()).toEqual([]);
  });
});

describe('headless worker plumbing', () => {
  it('hooks treat a headless worker as a worker, never as the coordinator', async () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'minions work claim task-9' }, cwd: '/workspace/repo' };
    expect(asWorkerInput(input, {})).toBe(input);
    const w = asWorkerInput(input, { [WORKER_LEASE_ENV]: 'lease-1', MINIONS_WORKER_ROLE: 'engineer' }) as Record<string, unknown>;
    expect(w).toMatchObject({ agent_id: 'headless-lease-1', agent_type: 'minions:engineer' });
    expect(preBashHook(input).reason).toMatch(/^allow/);
    expect(preBashHook(w).reason).toMatch(/^deny/);
    const stop = await stopHook({}, async () => { throw new Error('not loaded'); }, { [WORKER_LEASE_ENV]: 'lease-1' });
    expect(stop.reason).toMatch(/allow: headless worker/);
  });

  it('the worker env carries the lease marker and never the coordinator\'s Telegram or credentials', () => {
    const env = workerEnv({ PATH: '/bin', TELEGRAM_BOT_TOKEN: 'x', GH_TOKEN: 'y', ANTHROPIC_API_KEY: 'z', MINIONS_SESSION: 'general', SECRET_THING: 's' }, '/state/run/dispatch/config/lease-1',
      { method: 'login', envName: 'CLAUDE_CODE_OAUTH_TOKEN', token: 'tok', source: 'f' }, { leaseId: 'lease-1', role: 'engineer', tmp: '/tmp/x', scratchDir: '/scratch/lease-1' });
    expect(env).toMatchObject({ PATH: '/bin', MINIONS_WORKER_LEASE: 'lease-1', MINIONS_WORKER_ROLE: 'engineer', CLAUDE_CODE_OAUTH_TOKEN: 'tok', TMPDIR: '/scratch/lease-1', CLAUDE_CONFIG_DIR: '/state/run/dispatch/config/lease-1' });
    for (const k of ['TELEGRAM_BOT_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'MINIONS_SESSION', 'SECRET_THING']) expect(env).not.toHaveProperty(k);
  });

  it('reads usage and the session id from the stream-json log', () => {
    const log = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123', model: 'claude-sonnet' }),
      'some stderr line',
      JSON.stringify({ type: 'result', session_id: 'abc-123', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 } }),
    ].join('\n');
    expect(parseStreamLine('not json')).toBeNull();
    expect(summarizeWorkerLog(log)).toEqual({ tokens: 116, model: 'claude-sonnet', sessionId: 'abc-123', tail: 'some stderr line' });
  });
});
