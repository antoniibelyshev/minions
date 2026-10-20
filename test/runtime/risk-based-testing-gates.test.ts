import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { BaseSyncResult } from '../../src/runtime/base-sync.js';
import type { PublishInput, PublishOutcome } from '../../src/runtime/publish.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

/** Commits a file at `rel` (creating parent directories) in `dir`. */
function commitAt(dir: string, rel: string, content: string): string {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
  gitSync(dir, 'add', rel);
  gitSync(dir, 'commit', '-q', '-m', `add ${rel}`);
  return gitSync(dir, 'rev-parse', 'HEAD');
}

async function tester(env: Env, id: string, commit?: string) {
  const brief = await env.sched.claim(id, 'tester');
  const head = commit ? commitFile(brief.worktree, commit, 'test') : brief.expectedHead;
  return env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }));
}
async function review(env: Env, id: string, over: Record<string, unknown> = {}) {
  const brief = await env.sched.claim(id, 'reviewer');
  return env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', ...over }));
}

describe('risk-based testing: sensitive paths changed only by delete or rename', () => {
  it('deleting a sensitive file (not reported in modifiedPaths) still routes through a tester', async () => {
    const env = makeDefaultEnv();
    commitAt(env.layout.repo, 'CLAUDE.md', '# rules\n');
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    gitSync(b.worktree, 'rm', '-q', 'CLAUDE.md');
    gitSync(b.worktree, 'commit', '-q', '-m', 'drop CLAUDE.md');
    const head = gitSync(b.worktree, 'rev-parse', 'HEAD');
    const r = await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: head, modifiedPaths: [] }));
    expect(r).toMatchObject({ valid: true, to: 'testing' });
    expect(r.message).toMatch(/sensitive paths \(CLAUDE\.md\)/);
    expect(env.backlog.tasks.get('task-1')!.labels).toEqual(['qa']);
  });

  it('renaming a file out of a sensitive directory still routes through a tester', async () => {
    const env = makeDefaultEnv();
    commitAt(env.layout.repo, '.claude/settings.json', '{}\n');
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    mkdirSync(join(b.worktree, 'docs'), { recursive: true });
    gitSync(b.worktree, 'mv', '.claude/settings.json', 'docs/settings.json');
    gitSync(b.worktree, 'commit', '-q', '-m', 'move settings');
    const head = gitSync(b.worktree, 'rev-parse', 'HEAD');
    const r = await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: head, modifiedPaths: ['docs/settings.json'] }));
    expect(r).toMatchObject({ valid: true, to: 'testing' });
    expect(r.message).toMatch(/\.claude\/settings\.json/);
  });

  it('a sensitive change the reviewer approves without tester evidence is not delivered', async () => {
    // e.g. the engineer stage predates the sensitive commit: the reviewer gate re-checks the branch diff.
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    const h1 = commitFile(b.worktree, 'a.txt', 'a');
    expect(await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: h1 }))).toMatchObject({ to: 'reviewing' });
    commitAt(b.worktree, 'automation/run.sh', 'echo\n'); // lands on the branch after the engineer stage
    const rr = await review(env, 'task-1');
    expect(rr).toMatchObject({ approved: false, to: 'testing' });
    expect(rr.message).toMatch(/sensitive paths \(automation\/run\.sh\)/);
    expect(env.backlog.status('task-1')).toBe('testing');
  });
});

describe('risk-based testing: reviewer needsQa does not loop', () => {
  it('needsQa again after a passing tester on the same head approves and delivers', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: commitFile(b.worktree, 'a.txt', 'a') }));
    expect(await review(env, 'task-1', { needsQa: true })).toMatchObject({ approved: false, to: 'testing' });
    expect(await tester(env, 'task-1')).toMatchObject({ to: 'reviewing' });
    expect(await review(env, 'task-1', { needsQa: true })).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    expect(env.backlog.tasks.get('task-1')!.labels).toEqual(['qa']); // recorded once, not duplicated
    expect(env.db.events('task-1', 'qa-required')).toHaveLength(1);
  });

  it('a tester that adds commits leaves evidence on the new head, so the next approval applies', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: commitFile(b.worktree, 'a.txt', 'a') }));
    await review(env, 'task-1', { needsQa: true });
    expect(await tester(env, 'task-1', 'qa.test.txt')).toMatchObject({ valid: true, to: 'reviewing' });
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
  });
});

describe('risk-based testing: QA sweeps never commit', () => {
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

describe('risk-based testing: publish gate (non-local delivery)', () => {
  function branchEnv(mutate?: (c: MinionsConfig) => void) {
    const env = makeDefaultEnv((c) => { c.delivery.mode = 'branch'; mutate?.(c); });
    const calls: PublishInput[] = [];
    const next: { outcome: PublishOutcome } = {
      outcome: { state: 'published', mode: 'branch', push: 'pushed', pr: null, prUrl: null, repository: 'acme/demo', changedPaths: [], sensitivePaths: [] },
    };
    const sync = async (_repo: string, base: string): Promise<BaseSyncResult> =>
      ({ base, originRef: `refs/remotes/origin/${base}`, from: null, to: env.baseSha, action: 'up-to-date' } as BaseSyncResult);
    const sched = new Scheduler({
      db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, baseSync: sync,
      publisher: async (input) => { calls.push(input); return next.outcome; },
    });
    return { ...env, sched, calls, next };
  }
  async function engineer(env: Env, file = 'a.txt') {
    const b = await env.sched.claim('task-1', 'engineer');
    const head = commitAt(b.worktree, file, `w ${Math.random()}`);
    return env.sched.record(b.leaseId, result({ branch: b.branch, headSha: head, modifiedPaths: [file] }));
  }

  it('a plain task publishes after review without a tester', async () => {
    const env = branchEnv();
    env.backlog.add({ id: 'task-1' });
    expect(await engineer(env)).toMatchObject({ to: 'reviewing' });
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
    expect(env.calls).toHaveLength(1);
  });

  it('reviewer needsQa does not publish until a tester passed on the head', async () => {
    const env = branchEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env);
    expect(await review(env, 'task-1', { needsQa: true })).toMatchObject({ approved: false, to: 'testing' });
    expect(env.calls).toHaveLength(0);
    expect(env.db.publication('task-1')).toBeFalsy();
    await tester(env, 'task-1');
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
    expect(env.calls).toHaveLength(1);
  });

  it('a sensitive-path task publishes only after the tester stage', async () => {
    const env = branchEnv();
    env.backlog.add({ id: 'task-1' });
    expect(await engineer(env, 'infra/main.tf')).toMatchObject({ to: 'testing' });
    await tester(env, 'task-1');
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
    expect(env.calls).toHaveLength(1);
  });

  it('a publish retry re-checks the QA requirement (label added after approval) and refuses without tester evidence', async () => {
    const env = branchEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env);
    env.next.outcome = { state: 'failed', code: 'NETWORK_RETRYABLE', message: 'network down', retryable: true };
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'blocked' });
    expect(env.calls).toHaveLength(1);
    env.backlog.tasks.get('task-1')!.labels = ['qa'];
    env.next.outcome = { state: 'published', mode: 'branch', push: 'pushed', pr: null, prUrl: null, repository: 'acme/demo', changedPaths: [], sensitivePaths: [] };
    const p = await env.sched.publish('task-1');
    expect(p).toMatchObject({ state: 'failed', status: 'blocked', errorCode: 'PRECONDITION' });
    expect(p.message).toMatch(/passing tester evidence/);
    expect(env.calls).toHaveLength(1); // the publisher was not called again
  });

  it('testerRequired: true still gates publication on tester evidence', async () => {
    const env = branchEnv((c) => { c.verification.testerRequired = true; });
    env.backlog.add({ id: 'task-1' });
    expect(await engineer(env)).toMatchObject({ to: 'testing' });
    await tester(env, 'task-1');
    expect(await review(env, 'task-1')).toMatchObject({ approved: true, to: 'delivered' });
    expect(env.calls).toHaveLength(1);
  });
});

describe('risk-based testing: fails closed when the branch diff cannot be computed', () => {
  /** Simulates an unresolvable base or failing git diff. */
  function breakDiff(sched: Scheduler) {
    (sched as unknown as { changedPaths: () => Promise<null> }).changedPaths = async () => null;
  }
  const reason = /branch diff unavailable \(QA required, fail closed\)/;

  it('engineer complete goes to testing and the requirement is recorded on the task', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    breakDiff(env.sched);
    const r = await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: commitFile(b.worktree, 'a.txt', 'a') }));
    expect(r).toMatchObject({ valid: true, to: 'testing' });
    expect(r.message).toMatch(reason);
    expect(env.backlog.tasks.get('task-1')!.labels).toEqual(['qa']);
  });

  it('a configured base branch that does not resolve also requires QA', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    const head = commitFile(b.worktree, 'a.txt', 'a');
    env.config.git.baseBranch = 'no-such-base';
    const req = await env.sched.qaRequirement(env.backlog.tasks.get('task-1')!, head);
    expect(req.reasons.join()).toMatch(reason);
    expect(req.record).toBe(true);
  });

  it('approve without tester evidence is refused and goes to testing', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    expect(await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: commitFile(b.worktree, 'a.txt', 'a') }))).toMatchObject({ to: 'reviewing' });
    breakDiff(env.sched);
    const rr = await review(env, 'task-1');
    expect(rr).toMatchObject({ approved: false, to: 'testing' });
    expect(rr.message).toMatch(reason);
  });

  it('publish without tester evidence is refused', async () => {
    const env = makeDefaultEnv((c) => { c.delivery.mode = 'branch'; });
    const calls: PublishInput[] = [];
    const outcome: { v: PublishOutcome } = { v: { state: 'failed', code: 'NETWORK_RETRYABLE', message: 'network down', retryable: true } };
    const sched = new Scheduler({
      db: env.db, backlog: env.backlog, config: env.config, layout: env.layout,
      baseSync: async (_repo: string, base: string): Promise<BaseSyncResult> =>
        ({ base, originRef: `refs/remotes/origin/${base}`, from: null, to: env.baseSha, action: 'up-to-date' } as BaseSyncResult),
      publisher: async (input) => { calls.push(input); return outcome.v; },
    });
    const e2: Env = { ...env, sched };
    env.backlog.add({ id: 'task-1' });
    const b = await sched.claim('task-1', 'engineer');
    await sched.record(b.leaseId, result({ branch: b.branch, headSha: commitFile(b.worktree, 'a.txt', 'a') }));
    expect(await review(e2, 'task-1')).toMatchObject({ approved: true, to: 'blocked' });
    expect(calls).toHaveLength(1);
    breakDiff(sched);
    outcome.v = { state: 'published', mode: 'branch', push: 'pushed', pr: null, prUrl: null, repository: 'acme/demo', changedPaths: [], sensitivePaths: [] };
    const p = await sched.publish('task-1');
    expect(p).toMatchObject({ state: 'failed', status: 'blocked', errorCode: 'PRECONDITION' });
    expect(p.message).toMatch(/passing tester evidence/);
    expect(calls).toHaveLength(1);
  });
});
