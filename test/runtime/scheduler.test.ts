import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MinionsError } from '../../src/core/errors.js';
import type { TaskBrief } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeEnv, result, type Env } from './fixtures.js';

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as MinionsError).code; }
  return 'OK';
};

/** Engineer claims, commits a file, records complete. Returns the brief and new head. */
async function engineerPass(env: Env, id: string, file = 'a.txt', content = `work ${Math.random()}`) {
  const brief = await env.sched.claim(id, 'engineer');
  const head = commitFile(brief.worktree, file, content);
  const r = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }));
  return { brief, head, r };
}
async function testerPass(env: Env, id: string) {
  const brief = await env.sched.claim(id, 'tester');
  const r = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead }));
  return { brief, r };
}

describe('scheduler claim', () => {
  it('returns a brief with the lease marker and required fields', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', title: 'Add Login page!' });
    const b: TaskBrief = await env.sched.claim('task-1', 'engineer');
    expect(b.briefMarker).toBe(`minions-lease: ${b.leaseId}`);
    expect(b.branch).toBe('agent/task-1-add-login-page');
    expect(b.worktree).toBe(join(env.layout.worktrees, 'task-1-add-login-page'));
    expect(b.baseBranch).toBe('main');
    expect(b.baseSha).toBe(env.baseSha);
    expect(b.expectedHead).toBe(env.baseSha);
    expect(b.task.description).toBe('Do the thing.');
    for (const k of ['role', 'attempt', 'verificationCommands', 'priorFindings', 'model', 'maxTurns', 'configRevision']) expect(b).toHaveProperty(k);
    expect(env.backlog.status('task-1')).toBe('implementing');
    expect(gitSync(b.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(b.branch);
  });

  it('the same task cannot be claimed twice, even concurrently', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const results = await Promise.allSettled([env.sched.claim('task-1', 'engineer'), env.sched.claim('task-1', 'engineer')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rej = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(['CONFLICT', 'PRECONDITION']).toContain((rej.reason as MinionsError).code);
    expect(await code(env.sched.claim('task-1', 'engineer'))).toBe('CONFLICT'); // active lease wins over status
    expect(env.db.activeLeases()).toHaveLength(1);
  });

  it('default config allows at most 2 active tasks and 2 engineers', async () => {
    const env = makeEnv();
    for (const id of ['task-1', 'task-2', 'task-3']) env.backlog.add({ id });
    await env.sched.claim('task-1', 'engineer');
    await env.sched.claim('task-2', 'engineer');
    expect(await code(env.sched.claim('task-3', 'engineer'))).toBe('CAPACITY');

    const env2 = makeEnv((c) => { c.execution.maxActiveTasks = 3; });
    for (const id of ['task-1', 'task-2', 'task-3']) env2.backlog.add({ id });
    await env2.sched.claim('task-1', 'engineer');
    await env2.sched.claim('task-2', 'engineer');
    const err = await env2.sched.claim('task-3', 'engineer').catch((e: MinionsError) => e);
    expect((err as MinionsError).code).toBe('CAPACITY');
    expect((err as MinionsError).message).toMatch(/Engineer limit/);
  });

  it('a task between stages still occupies active capacity', async () => {
    const env = makeEnv();
    for (const id of ['task-1', 'task-2', 'task-3']) env.backlog.add({ id });
    await engineerPass(env, 'task-1');
    expect(env.backlog.status('task-1')).toBe('testing');
    await env.sched.claim('task-2', 'engineer');
    expect(await code(env.sched.claim('task-3', 'engineer'))).toBe('CAPACITY');
    // a blocked task releases capacity
    env.backlog.tasks.get('task-1')!.status = 'blocked';
    expect(await code(env.sched.claim('task-3', 'engineer'))).toBe('OK');
  });

  it('engineer and tester never hold the task concurrently', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const eng = await env.sched.claim('task-1', 'engineer');
    expect(await code(env.sched.claim('task-1', 'tester'))).toBe('CONFLICT');
    env.backlog.tasks.get('task-1')!.status = 'testing'; // even if the status were forced
    expect(await code(env.sched.claim('task-1', 'tester'))).toBe('CONFLICT');
    env.backlog.tasks.get('task-1')!.status = 'implementing';
    const head = commitFile(eng.worktree, 'a.txt', 'x');
    await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head }));
    const tester = await env.sched.claim('task-1', 'tester');
    expect(tester.worktree).toBe(eng.worktree);
    expect(env.db.activeLeases().map((l) => l.role)).toEqual(['tester']);
  });

  it('refuses paused starts, denied task.start, unauthorized and dependency-blocked tasks', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2', authorized: false });
    env.backlog.add({ id: 'task-3', dependencies: ['task-1'] });
    env.db.setPaused({ starts: true });
    expect(await code(env.sched.claim('task-1', 'engineer'))).toBe('POLICY_DENIED');
    env.db.setPaused({ starts: false });
    expect(await code(env.sched.claim('task-2', 'engineer'))).toBe('POLICY_DENIED');
    expect(await code(env.sched.claim('task-3', 'engineer'))).toBe('PRECONDITION');
    const denied = makeEnv((c) => { c.capabilities['task.start'] = 'deny'; });
    denied.backlog.add({ id: 'task-1' });
    expect(await code(denied.sched.claim('task-1', 'engineer'))).toBe('POLICY_DENIED');
  });
});

describe('reviewer worktree', () => {
  it('is detached at the intended commit and recreated when the head moves', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const { brief, head } = await engineerPass(env, 'task-1');
    await testerPass(env, 'task-1');
    const rev = await env.sched.claim('task-1', 'reviewer');
    expect(rev.worktree).toBe(join(env.layout.review, brief.worktree.split('/').pop()!));
    expect(gitSync(rev.worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(gitSync(rev.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached
    await env.sched.release(rev.leaseId, 'try again');

    const head2 = commitFile(brief.worktree, 'b.txt', 'more');
    const rev2 = await env.sched.claim('task-1', 'reviewer');
    expect(rev2.expectedHead).toBe(head2);
    expect(gitSync(rev2.worktree, 'rev-parse', 'HEAD')).toBe(head2);
    await env.sched.release(rev2.leaseId, 'again');

    // a dirty review worktree is never replaced
    commitFile(brief.worktree, 'c.txt', 'even more');
    writeFileSync(join(rev2.worktree, 'scratch.txt'), 'uncommitted');
    expect(await code(env.sched.claim('task-1', 'reviewer'))).toBe('PRECONDITION');
    expect(existsSync(join(rev2.worktree, 'scratch.txt'))).toBe(true);
  });
});

describe('scheduler record', () => {
  it('runs the full pipeline to delivered with evidence per head and config revision', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const { head, r } = await engineerPass(env, 'task-1');
    expect(r).toMatchObject({ valid: true, from: 'implementing', to: 'testing' });
    const t = await testerPass(env, 'task-1');
    expect(t.r).toMatchObject({ valid: true, to: 'reviewing' });
    const rev = await env.sched.claim('task-1', 'reviewer');
    const rr = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve' }));
    expect(rr).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    expect(env.backlog.status('task-1')).toBe('delivered');
    const ev = env.db.evidenceFor('task-1', head);
    expect(ev.map((e) => e.kind)).toEqual(expect.arrayContaining(['engineer', 'tester', 'reviewer', 'check']));
    expect(ev.every((e) => e.config_revision === env.config.configRevision)).toBe(true);
    expect(env.db.activeLeases()).toHaveLength(0);
  });

  it('an invalid result cannot approve; one correction, then stored unvalidated', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const { head } = await engineerPass(env, 'task-1');
    await testerPass(env, 'task-1');
    const rev = await env.sched.claim('task-1', 'reviewer');

    const bad = await env.sched.record(rev.leaseId, '{"status":"complete","verdict":"approve"}');
    expect(bad).toMatchObject({ valid: false, approved: false, correctionAllowed: true });
    expect(env.backlog.status('task-1')).toBe('reviewing');
    expect(env.db.lease(rev.leaseId)!.result_valid).toBe(0);
    expect(await code(env.sched.record(rev.leaseId, '{}'))).toBe('PRECONDITION'); // must be --correction

    // complete without approve verdict is invalid for a reviewer
    const bad2 = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head }), { correction: true });
    expect(bad2).toMatchObject({ valid: false, approved: false, unvalidated: true, correctionAllowed: false });
    expect(env.db.lease(rev.leaseId)!.status).toBe('unvalidated');
    expect(env.backlog.status('task-1')).toBe('reviewing');
    expect(env.db.evidenceFor('task-1', head, 'reviewer')).toHaveLength(0);
    expect(await code(env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve' }), { correction: true }))).toBe('CONFLICT');
  });

  it('a valid correction is accepted', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    const head = commitFile(b.worktree, 'a.txt', 'x');
    expect((await env.sched.record(b.leaseId, 'not json')).valid).toBe(false);
    const ok = await env.sched.record(b.leaseId, '```json\n' + JSON.stringify(result({ branch: b.branch, headSha: head })) + '\n```', { correction: true });
    expect(ok).toMatchObject({ valid: true, to: 'testing' });
  });

  it('a stale head invalidates the result and earlier evidence', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    const old = commitFile(b.worktree, 'a.txt', '1');
    commitFile(b.worktree, 'a.txt', '2');
    const stale = await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: old }));
    expect(stale.valid).toBe(false);
    expect(stale.errors!.join()).toMatch(/stale head/);
    const head = gitSync(b.worktree, 'rev-parse', 'HEAD');
    await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: head }), { correction: true });
    await testerPass(env, 'task-1');

    // a new commit after testing: tester evidence for the old head no longer counts
    const newHead = commitFile(b.worktree, 'late.txt', 'late change');
    const rev = await env.sched.claim('task-1', 'reviewer');
    const rr = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: newHead, verdict: 'approve' }));
    expect(rr).toMatchObject({ valid: true, approved: false, to: 'testing' });
    expect(rr.message).toMatch(/no passing tester evidence/);
    expect(env.backlog.status('task-1')).toBe('testing');

    // reviewer whose branch moved during review is stale
    await testerPass(env, 'task-1');
    const rev2 = await env.sched.claim('task-1', 'reviewer');
    const moved = commitFile(b.worktree, 'during.txt', 'x');
    const r2 = await env.sched.record(rev2.leaseId, result({ branch: rev2.branch, headSha: moved, verdict: 'approve' }));
    expect(r2.valid).toBe(false);
    expect(r2.errors!.join()).toMatch(/review started at/);
  });

  it('repeated repair cycles trigger replan', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    let last;
    for (let i = 1; i <= env.config.execution.maxRepairCyclesBeforeReplan; i++) {
      await engineerPass(env, 'task-1', 'a.txt', `attempt ${i}`);
      await testerPass(env, 'task-1');
      const rev = await env.sched.claim('task-1', 'reviewer');
      last = await env.sched.record(rev.leaseId, result({ status: 'needs_changes', branch: rev.branch, headSha: rev.expectedHead, verdict: 'request-changes', findings: [`issue ${i}`] }));
      if (i < env.config.execution.maxRepairCyclesBeforeReplan) expect(last).toMatchObject({ replan: false, to: 'changes-requested' });
    }
    expect(last).toMatchObject({ replan: true, to: 'awaiting-human', repairCycles: 3 });
    expect(env.backlog.status('task-1')).toBe('awaiting-human');
  });

  it('prior findings are carried into the next brief; attempts count up', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    await engineerPass(env, 'task-1');
    await testerPass(env, 'task-1');
    const rev = await env.sched.claim('task-1', 'reviewer');
    await env.sched.record(rev.leaseId, result({ status: 'needs_changes', branch: rev.branch, headSha: rev.expectedHead, findings: ['missing null check'] }));
    const b = await env.sched.claim('task-1', 'engineer');
    expect(b.attempt).toBe(2);
    expect(b.priorFindings.some((f) => f.findings.includes('missing null check'))).toBe(true);
  });

  it('needs_split and blocked transitions', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const a = await env.sched.claim('task-1', 'engineer');
    expect(await env.sched.record(a.leaseId, result({ status: 'needs_split', branch: a.branch, headSha: a.expectedHead }))).toMatchObject({ needsSplit: true, to: 'awaiting-human' });
    const b = await env.sched.claim('task-2', 'engineer');
    expect(await env.sched.record(b.leaseId, result({ status: 'blocked', branch: b.branch, headSha: b.expectedHead }))).toMatchObject({ to: 'blocked' });
  });
});

describe('release', () => {
  it('worker failure preserves the worktree and lets the task be claimed again', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    writeFileSync(join(b.worktree, 'wip.txt'), 'half done');
    const head = commitFile(b.worktree, 'committed.txt', 'kept');
    const rel = await env.sched.release(b.leaseId, 'worker crashed');
    expect(rel).toMatchObject({ worktree: b.worktree, status: 'ready' });
    expect(readFileSync(join(b.worktree, 'wip.txt'), 'utf8')).toBe('half done');
    expect(env.db.lease(b.leaseId)!.status).toBe('released');
    expect(await code(env.sched.release(b.leaseId, 'again'))).toBe('CONFLICT');
    const again = await env.sched.claim('task-1', 'engineer');
    expect(again.worktree).toBe(b.worktree);
    expect(again.expectedHead).toBe(head);
    expect(existsSync(join(again.worktree, 'wip.txt'))).toBe(true);
  });
});
