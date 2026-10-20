import { describe, expect, it } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import { validateResult } from '../../src/runtime/results.js';
import { PROFILES } from '../../src/config/schema.js';
import { defaults } from '../helpers.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as MinionsError).code; }
  return 'OK';
};

async function engineer(env: Env, id: string, file = 'a.txt', modifiedPaths: string[] = [file]) {
  const brief = await env.sched.claim(id, 'engineer');
  const head = commitFile(brief.worktree, file, `work ${Math.random()}`);
  const r = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths }));
  return { brief, head, r };
}
async function tester(env: Env, id: string) {
  const brief = await env.sched.claim(id, 'tester');
  return env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead }));
}
async function review(env: Env, id: string, over: Record<string, unknown> = {}) {
  const brief = await env.sched.claim(id, 'reviewer');
  return env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', ...over }));
}

describe('risk-based testing: default pipeline', () => {
  it('the profile default no longer requires a tester for every task', () => {
    for (const p of PROFILES) {
      expect(defaults(p).verification.testerRequired).toBe(false);
    }
  });

  it('default profile: engineer → reviewer → delivered without a tester stage', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const { head, r } = await engineer(env, 'task-1');
    expect(r).toMatchObject({ valid: true, from: 'implementing', to: 'reviewing' });
    expect(await code(env.sched.claim('task-1', 'tester'))).toBe('PRECONDITION');
    expect(await review(env, 'task-1')).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    expect(env.backlog.status('task-1')).toBe('delivered');
    expect(env.db.evidenceFor('task-1', head, 'tester')).toHaveLength(0);
    expect(env.backlog.tasks.get('task-1')!.labels).toEqual([]);
  });

  it('testerRequired: true keeps the old engineer → tester → reviewer flow and gate', async () => {
    const env = makeDefaultEnv((c) => { c.verification.testerRequired = true; });
    env.backlog.add({ id: 'task-1' });
    const { brief, r } = await engineer(env, 'task-1');
    expect(r).toMatchObject({ to: 'testing' });
    expect(await tester(env, 'task-1')).toMatchObject({ to: 'reviewing' });
    // a new commit after testing invalidates the tester evidence: approval is not applied
    commitFile(brief.worktree, 'late.txt', 'late');
    const rr = await review(env, 'task-1');
    expect(rr).toMatchObject({ approved: false, to: 'testing' });
    expect(rr.message).toMatch(/verification\.testerRequired/);
    expect(await tester(env, 'task-1')).toMatchObject({ to: 'reviewing' });
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
  });
});

describe('risk-based testing: per-task QA opt-in', () => {
  it('a task labelled qa goes through a tester', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1', labels: ['qa'] });
    const { r } = await engineer(env, 'task-1');
    expect(r).toMatchObject({ to: 'testing' });
    expect(r.message).toMatch(/QA required \(label qa\)/);
    expect(await tester(env, 'task-1')).toMatchObject({ to: 'reviewing' });
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('a configured QA label (verification.qaLabels) opts in; the default label then does not', async () => {
    const env = makeDefaultEnv((c) => { c.verification.qaLabels = ['needs-qa', 'risky']; });
    env.backlog.add({ id: 'task-1', labels: ['risky'] });
    env.backlog.add({ id: 'task-2', labels: ['qa'] });
    expect((await engineer(env, 'task-1')).r).toMatchObject({ to: 'testing' });
    expect((await engineer(env, 'task-2', 'b.txt')).r).toMatchObject({ to: 'reviewing' });
  });

  it('a QA label added by the coordinator after the engineer stage blocks approval without tester evidence', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    env.backlog.tasks.get('task-1')!.labels = ['qa']; // minions backlog update task-1 --label qa
    const rr = await review(env, 'task-1');
    expect(rr).toMatchObject({ approved: false, to: 'testing' });
    expect(rr.message).toMatch(/no passing tester evidence/);
    expect(await tester(env, 'task-1')).toMatchObject({ to: 'reviewing' });
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('touching sensitive paths routes through a tester and records the requirement on the task', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const { r, head } = await engineer(env, 'task-1', 'CLAUDE.md');
    expect(r).toMatchObject({ to: 'testing' });
    expect(r.message).toMatch(/sensitive paths \(CLAUDE\.md\)/);
    expect(env.backlog.tasks.get('task-1')!.labels).toEqual(['qa']);
    const ev = env.db.events('task-1', 'qa-required');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ role: 'engineer', head, label: 'qa' });
    expect(env.backlog.notes.some((n) => n.id === 'task-1' && /QA required: sensitive paths/.test(n.text))).toBe(true);
    expect(await tester(env, 'task-1')).toMatchObject({ to: 'reviewing' });
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('sensitive paths are detected from the branch diff even when modifiedPaths omits them', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const { r } = await engineer(env, 'task-1', 'AGENTS.md', ['src/unrelated.ts']);
    expect(r).toMatchObject({ to: 'testing' });
  });

  it('a reviewer needsQa flag moves the task to testing instead of delivered, then delivers after QA', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const { head } = await engineer(env, 'task-1');
    const rr = await review(env, 'task-1', { needsQa: true });
    expect(rr).toMatchObject({ valid: true, approved: false, to: 'testing' });
    expect(rr.message).toMatch(/reviewer flagged needsQa/);
    expect(env.backlog.status('task-1')).toBe('testing');
    expect(env.backlog.tasks.get('task-1')!.labels).toEqual(['qa']);
    expect(env.db.evidenceFor('task-1', head, 'reviewer')).toHaveLength(1);
    expect(await tester(env, 'task-1')).toMatchObject({ to: 'reviewing' });
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('a reviewer may request changes and QA together; the repaired task then goes through a tester', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    const rr = await review(env, 'task-1', { status: 'needs_changes', verdict: 'request-changes', needsQa: true, findings: ['add an install test'] });
    expect(rr).toMatchObject({ to: 'changes-requested' });
    expect(env.backlog.tasks.get('task-1')!.labels).toEqual(['qa']);
    expect((await engineer(env, 'task-1', 'b.txt')).r).toMatchObject({ to: 'testing' });
  });

  it('only reviewers may set needsQa', () => {
    const r = result({ branch: 'agent/x', headSha: 'a'.repeat(40), needsQa: true });
    expect(validateResult(r, 'reviewer').ok).toBe(false); // complete reviewer needs approve
    expect(validateResult({ ...r, verdict: 'approve' }, 'reviewer').ok).toBe(true);
    for (const role of ['engineer', 'tester'] as const) {
      const v = validateResult(r, role);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.join()).toMatch(/needsQa: only reviewer/);
    }
  });
});

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
});
