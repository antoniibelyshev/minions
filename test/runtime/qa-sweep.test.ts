import { describe, expect, it, vi } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import { commitFile, gitSync, makeDefaultEnv, result } from './fixtures.js';
// Unit tier: git runs on the in-memory fake (./fake-git.ts).
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as MinionsError).code; }
  return 'OK';
};

describe('QA sweeps against the base branch', () => {
  it('a qa-sweep task is run by a tester on a detached worktree at the base head and closes as done', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-9', title: 'QA sweep after five merges', labels: ['qa-sweep'] });
    expect(await code(env.sched.claim('task-9', 'engineer'))).toBe('PRECONDITION');
    expect(await code(env.sched.claim('task-9', 'reviewer'))).toBe('PRECONDITION');

    const b = await env.sched.claim('task-9', 'tester');
    expect(b).toMatchObject({ kind: 'qa-sweep', branch: 'main', baseBranch: 'main', expectedHead: env.baseSha, baseSha: env.baseSha });
    expect(b.publication['git.commit']).toBe('deny');
    expect(gitSync(b.worktree, 'rev-parse', 'HEAD')).toBe(env.baseSha);
    expect(gitSync(b.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD'); // detached, main untouched
    expect(env.backlog.status('task-9')).toBe('ready');

    // main moves on during the sweep: the sweep still reports the head it checked
    commitFile(env.layout.repo, 'merged.txt', 'another merge');
    const bad = await env.sched.record(b.leaseId, result({ branch: 'main', headSha: gitSync(env.layout.repo, 'rev-parse', 'HEAD') }));
    expect(bad.valid).toBe(false);
    expect(bad.errors!.join()).toMatch(/QA sweep ran against/);
    const ok = await env.sched.record(b.leaseId, result({ branch: 'main', headSha: env.baseSha, findings: ['install.sh drops --flag passthrough'] }), { correction: true });
    expect(ok).toMatchObject({ valid: true, from: 'ready', to: 'done', approved: false });
    expect(ok.message).toMatch(/Create a backlog task for each finding/);
    expect(env.backlog.status('task-9')).toBe('done');
    expect(env.backlog.tasks.get('task-9')!.branch).toBeNull();
    expect(gitSync(env.layout.repo, 'branch', '--list', 'agent/*')).toBe('');
  });

  it('a partial sweep stays ready and can be claimed again; release keeps it ready', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-9', labels: ['qa-sweep'] });
    const b = await env.sched.claim('task-9', 'tester');
    expect(await env.sched.record(b.leaseId, result({ status: 'partial', branch: 'main', headSha: env.baseSha }))).toMatchObject({ to: 'ready' });
    const b2 = await env.sched.claim('task-9', 'tester');
    expect(b2.attempt).toBe(2);
    expect((await env.sched.release(b2.leaseId, 'stop')).status).toBe('ready');
  });

  it('an engineer claim after the qa-sweep label is removed uses agent/<slug>, never the base branch', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-9', labels: ['qa-sweep'] });
    const b = await env.sched.claim('task-9', 'tester');
    expect(b.branch).toBe('main');
    await env.sched.record(b.leaseId, result({ status: 'partial', branch: 'main', headSha: env.baseSha }));
    env.backlog.tasks.get('task-9')!.labels = [];
    const e = await env.sched.claim('task-9', 'engineer');
    expect(e.branch).toMatch(/^agent\/task-9/);
    expect(gitSync(e.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(e.branch);
  });

  it('an unauthorized sweep is not started', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-9', labels: ['qa-sweep'], authorized: false });
    expect(await code(env.sched.claim('task-9', 'tester'))).toBe('POLICY_DENIED');
  });

  it('a commit made in the detached sweep worktree is rejected and leaves main untouched', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-9', labels: ['qa-sweep'] });
    const b = await env.sched.claim('task-9', 'tester');
    const committed = commitFile(b.worktree, 'oops.txt', 'x');
    expect(gitSync(env.layout.repo, 'rev-parse', 'main')).toBe(env.baseSha);
    const bad = await env.sched.record(b.leaseId, result({ branch: 'main', headSha: committed }));
    expect(bad.valid).toBe(false);
    expect(bad.errors!.join()).toMatch(/sweeps do not commit/);
    expect(env.backlog.status('task-9')).toBe('ready');
  });

  it('a sweep task cannot be claimed by an engineer even from changes-requested', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-9', labels: ['qa-sweep'], status: 'changes-requested' });
    await expect(env.sched.claim('task-9', 'engineer')).rejects.toMatchObject({ code: 'PRECONDITION' });
  });
});
