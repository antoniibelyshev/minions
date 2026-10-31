import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';
// Unit tier: git runs on the in-memory fake (./fake-git.ts).
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));

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
    commitAt(b.worktree, '.husky/pre-commit', 'echo\n'); // lands on the branch after the engineer stage
    const rr = await review(env, 'task-1');
    expect(rr).toMatchObject({ approved: false, to: 'testing' });
    expect(rr.message).toMatch(/sensitive paths \(\.husky\/pre-commit\)/);
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
});
