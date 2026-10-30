// End-to-end claim -> brief -> submit -> record on real git (integration tier). The pipeline rules themselves are
// unit-tested on the in-memory git of ./fake-git.ts (scheduler, work-next, advance, workflows, custom-roles,
// risk-based-testing, ...); these few flows keep the real `git worktree`, rev-parse, merge-base and diff behind them.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MinionsError } from '../../src/core/errors.js';
import { advanceLease } from '../../src/runtime/advance.js';
import { claimWithBrief, fetchBrief, recordSubmitted, submitResult, type HandoffPaths } from '../../src/runtime/handoff.js';
import type { TaskBrief } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, makeEnv, result, type Env } from './fixtures.js';

const paths = (env: Env): HandoffPaths => ({ briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') });

/** What a worker does: fetch its brief from inside the worktree, then store its WorkerResult. */
async function work(env: Env, claimed: TaskBrief, over: Record<string, unknown> = {}, file?: string): Promise<TaskBrief> {
  const brief = await fetchBrief(env.db, paths(env), claimed.leaseId, { role: claimed.role, cwd: claimed.worktree });
  expect(brief).toMatchObject({ leaseId: claimed.leaseId, role: claimed.role, worktree: claimed.worktree });
  const head = file ? commitFile(brief.worktree, file, `work ${brief.leaseId}\n`) : brief.expectedHead;
  await submitResult(env.db, paths(env), brief.leaseId, JSON.stringify(result({ branch: brief.branch, headSha: head, ...over })), { role: brief.role, cwd: brief.worktree });
  return brief;
}

describe('claim -> brief -> submit -> record (real git)', () => {
  it('engineer, tester and reviewer take a task to delivered, with evidence bound to the real head', async () => {
    const env = makeEnv(); // testerRequired: engineer -> tester -> reviewer
    env.backlog.add({ id: 'task-1', title: 'Add login' });
    const e = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    expect(e).toMatchObject({ branch: 'agent/task-1-add-login', baseBranch: 'main', baseSha: env.baseSha, expectedHead: env.baseSha });
    expect(gitSync(e.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(e.branch);
    await work(env, e, {}, 'a.txt');
    const head = gitSync(e.worktree, 'rev-parse', 'HEAD');
    expect(await recordSubmitted(env.sched, paths(env), e.leaseId)).toMatchObject({ valid: true, from: 'implementing', to: 'testing' });

    const t = await claimWithBrief(env.sched, paths(env), 'task-1', 'tester');
    expect(t).toMatchObject({ worktree: e.worktree, expectedHead: head });
    await work(env, t);
    expect(await recordSubmitted(env.sched, paths(env), t.leaseId)).toMatchObject({ valid: true, to: 'reviewing' });

    const r = await claimWithBrief(env.sched, paths(env), 'task-1', 'reviewer');
    expect(r.worktree).toBe(join(env.layout.review, 'task-1-add-login'));
    expect(gitSync(r.worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(gitSync(r.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached
    await work(env, r, { verdict: 'approve' });
    expect(await recordSubmitted(env.sched, paths(env), r.leaseId)).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    expect(env.backlog.status('task-1')).toBe('delivered');
    expect(env.db.evidenceFor('task-1', head).map((x) => x.kind)).toEqual(expect.arrayContaining(['engineer', 'tester', 'reviewer']));
    expect(env.db.activeLeases()).toHaveLength(0);
  });

  it('a stale or moved head is refused, and a dirty review worktree is never replaced', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const e = await env.sched.claim('task-1', 'engineer');
    const old = commitFile(e.worktree, 'a.txt', '1');
    const head = commitFile(e.worktree, 'a.txt', '2');
    const stale = await env.sched.record(e.leaseId, result({ branch: e.branch, headSha: old }));
    expect(stale.valid).toBe(false);
    expect(stale.errors!.join()).toMatch(/stale head/);
    expect(await env.sched.record(e.leaseId, result({ branch: e.branch, headSha: head }), { correction: true })).toMatchObject({ valid: true });
    const t = await env.sched.claim('task-1', 'tester');
    await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head }));

    const rev = await env.sched.claim('task-1', 'reviewer');
    const moved = commitFile(e.worktree, 'during.txt', 'x');
    const r = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: moved, verdict: 'approve' }));
    expect(r.valid).toBe(false);
    expect(r.errors!.join()).toMatch(/review started at/);
    await env.sched.release(rev.leaseId, 'again');

    writeFileSync(join(rev.worktree, 'scratch.txt'), 'uncommitted');
    const err = await env.sched.claim('task-1', 'reviewer').catch((x: MinionsError) => x);
    expect((err as MinionsError).code).toBe('PRECONDITION');
    expect(existsSync(join(rev.worktree, 'scratch.txt'))).toBe(true);
  });

  it('the diff gate sees a rename out of a sensitive directory (real `git diff --no-renames`), and advance claims the tester', async () => {
    const env = makeDefaultEnv(); // risk-based testing: a tester only when the change needs one
    mkdirSync(join(env.layout.repo, '.claude'));
    commitFile(env.layout.repo, '.claude/settings.json', '{}\n');
    env.backlog.add({ id: 'task-1' });
    const e = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
    mkdirSync(join(e.worktree, 'docs'), { recursive: true });
    gitSync(e.worktree, 'mv', '.claude/settings.json', 'docs/settings.json');
    gitSync(e.worktree, 'commit', '-q', '-m', 'move settings');
    await work(env, e, { headSha: gitSync(e.worktree, 'rev-parse', 'HEAD'), modifiedPaths: ['docs/settings.json'] });
    // The worker reported only the new path; the base...head diff of the real repository names the old one too.
    const submitted = await advanceLease(env.sched, paths(env), e.leaseId, {}, { db: env.db, config: env.config });
    expect(submitted.record).toMatchObject({ valid: true, to: 'testing' });
    expect(submitted.record.message).toMatch(/\.claude\/settings\.json/);
    expect(submitted.next).toMatchObject({ taskId: 'task-1', role: 'tester' });
  });
});
