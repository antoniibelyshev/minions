// Local integration engine (task-82.1, docs/design/local-auto-integration.md phase 1): candidate, sensitive
// diff, revert-of-revert check and landing, on real temp repositories (never the workspace checkout).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { integrationCandidate, integrationChangedPaths, integrationMessage, land, revertOfRevertCheck } from '../../src/runtime/integration.js';
import { gitSync, initRepo, tmp } from './fixtures.js';

const identity = { name: 'Minions Integrator', email: 'integrator@example.com' };
const BRANCH = 'agent/task-1-thing';

function commit(dir: string, file: string, content: string, msg = `edit ${file}`): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  gitSync(dir, 'add', file);
  gitSync(dir, 'commit', '-q', '-m', msg);
  return gitSync(dir, 'rev-parse', 'HEAD');
}
/** Commits `file` on `branch` without touching the main checkout (a linked worktree). */
function commitOn(repo: string, branch: string, file: string, content: string): string {
  const wt = join(tmp('minions-integ-wt-'), 'wt');
  gitSync(repo, 'worktree', 'add', '-q', wt, branch);
  const sha = commit(wt, file, content);
  gitSync(repo, 'worktree', 'remove', '--force', wt);
  return sha;
}

/** A repo with main at B (one commit after init, checked out) and the branch at H (one commit on init). */
function setup(o: { headFile?: string; headContent?: string; baseFile?: string; baseContent?: string } = {}) {
  const repo = join(tmp('minions-integ-'), 'repo');
  initRepo(repo);
  gitSync(repo, 'branch', BRANCH);
  const B = commit(repo, o.baseFile ?? 'base.txt', o.baseContent ?? 'base\n', 'base change');
  const H = commitOn(repo, BRANCH, o.headFile ?? 'feature.txt', o.headContent ?? 'feature\n');
  return { repo, B, H };
}
const mainOf = (repo: string) => gitSync(repo, 'rev-parse', 'refs/heads/main');
const candidate = (repo: string, B: string, H: string) => integrationCandidate(repo, { base: B, head: H, branch: BRANCH, taskId: 'task-1', identity });
async function cleanCandidate(repo: string, B: string, H: string): Promise<string> {
  const c = await candidate(repo, B, H);
  if (c.state !== 'clean') throw new Error(`expected a clean candidate, got ${JSON.stringify(c)}`);
  return c.candidate;
}

describe('integrationCandidate', () => {
  it('builds C = merge(B, H) as an object only, with parents (B, H), the subject and the trailers', async () => {
    const { repo, B, H } = setup();
    const c = await candidate(repo, B, H);
    if (c.state !== 'clean') throw new Error(JSON.stringify(c));
    expect(gitSync(repo, 'rev-list', '--parents', '-n', '1', c.candidate).split(' ').slice(1)).toEqual([B, H]);
    expect(gitSync(repo, 'ls-tree', '--name-only', c.candidate).split('\n').sort()).toEqual(['README.md', 'base.txt', 'feature.txt']);
    expect(gitSync(repo, 'log', '-1', '--format=%B', c.candidate)).toBe(`Merge branch '${BRANCH}'\n\nMinions-Task: task-1\nMinions-Approved-Head: ${H}`);
    expect(gitSync(repo, 'log', '-1', '--format=%(trailers:key=Minions-Approved-Head,valueonly)', c.candidate)).toBe(H);
    expect(gitSync(repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', c.candidate)).toBe('Minions Integrator <integrator@example.com>|Minions Integrator <integrator@example.com>');
    // No ref moved, the checkout holds no merge state, no ref points at C.
    expect(mainOf(repo)).toBe(B);
    expect(gitSync(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(gitSync(repo, 'for-each-ref', '--format=%(objectname)').split('\n')).not.toContain(c.candidate);
  });

  it('returns the conflicted paths and leaves main and the checkout unchanged', async () => {
    const { repo, B, H } = setup({ baseFile: 'same.txt', baseContent: 'base\n', headFile: 'same.txt', headContent: 'head\n' });
    expect(await candidate(repo, B, H)).toEqual({ state: 'conflict', files: ['same.txt'], base: B, head: H });
    expect(mainOf(repo)).toBe(B);
    expect(gitSync(repo, 'status', '--porcelain')).toBe('');
  });

  it('ignores merge configuration of the checkout (a union driver in .git/info/attributes)', async () => {
    const { repo, B, H } = setup({ baseFile: 'same.txt', baseContent: 'base\n', headFile: 'same.txt', headContent: 'head\n' });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* merge=union\n');
    expect(await candidate(repo, B, H)).toMatchObject({ state: 'conflict', files: ['same.txt'] });
  });

  it('refuses a custom merge driver committed in a tree', async () => {
    const { repo, B, H } = setup({ headFile: '.gitattributes', headContent: '*.txt merge=ours\n' });
    const c = await candidate(repo, B, H);
    expect(c.state).toBe('refused');
    expect(c.state === 'refused' ? c.message : '').toMatch(/custom or union merge drivers.*an integration needs built-in merges/);
  });

  it('reports a head that is already on the base', async () => {
    const { repo, B } = setup();
    expect((await candidate(repo, B, gitSync(repo, 'rev-parse', 'main~1'))).state).toBe('already-merged');
  });

  it('rejects control characters in the message (no trailer injection)', () => {
    const head = 'a'.repeat(40);
    expect(() => integrationMessage({ branch: "agent/x'\n\nMinions-Approved-Head: b", taskId: 't', head })).toThrow(/invalid branch/);
    expect(() => integrationMessage({ branch: 'agent/x', taskId: 't', head: 'abc' })).toThrow(/full SHA/);
  });
});

describe('integrationChangedPaths', () => {
  it('lists B..C and the paths that match sensitivePaths', async () => {
    const { repo, B } = setup();
    const H = commitOn(repo, BRANCH, '.github/workflows/ci.yml', 'on: push\n');
    const C = await cleanCandidate(repo, B, H);
    expect(await integrationChangedPaths(repo, B, C, ['.github/workflows/**', '**/migrations/**']))
      .toEqual({ ok: true, changed: ['.github/workflows/ci.yml', 'feature.txt'], sensitive: ['.github/workflows/ci.yml'] });
  });
});

describe('revertOfRevertCheck', () => {
  it('refuses a head after a revert of its earlier integration until the branch reverts that revert', async () => {
    const { repo, B, H } = setup();
    const C1 = await cleanCandidate(repo, B, H);
    expect(await land(repo, { candidate: C1, base: B, baseBranch: 'main' })).toMatchObject({ state: 'landed' });
    gitSync(repo, 'revert', '--no-edit', '-m', '1', C1);
    const R = mainOf(repo);
    // The branch continues without reverting the revert.
    const H2 = commitOn(repo, BRANCH, 'feature.txt', 'feature v2\n');
    const r1 = await revertOfRevertCheck(repo, { base: R, head: H2, landed: [C1] });
    expect(r1).toMatchObject({ state: 'refused', revert: R, reverted: C1 });
    expect(r1.state === 'refused' ? r1.message : '').toContain(`revert ${R} on the branch first`);
    // A branch that reverts the revert (then redoes the work) is accepted.
    const wt = join(tmp('minions-integ-wt-'), 'wt');
    gitSync(repo, 'worktree', 'add', '-q', '-b', 'agent/task-1-retry', wt, R);
    gitSync(wt, 'revert', '--no-edit', R);
    const H3 = commit(wt, 'feature.txt', 'feature v2\n');
    gitSync(repo, 'worktree', 'remove', '--force', wt);
    expect(await revertOfRevertCheck(repo, { base: R, head: H3, landed: [C1] })).toEqual({ state: 'ok' });
    // Without an earlier landing there is nothing to check.
    expect(await revertOfRevertCheck(repo, { base: R, head: H2, landed: [] })).toEqual({ state: 'ok' });
  });
});

describe('land', () => {
  it('fast-forwards a clean checkout of main with merge --ff-only', async () => {
    const { repo, B, H } = setup();
    const C = await cleanCandidate(repo, B, H);
    // Repository hooks and filter drivers do not run.
    const marker = join(dirname(repo), 'hook-ran');
    writeFileSync(join(repo, '.git', 'hooks', 'post-merge'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
    gitSync(repo, 'config', 'filter.evil.smudge', `sh -c 'touch ${marker}; cat'`);
    expect(await land(repo, { candidate: C, base: B, baseBranch: 'main' })).toEqual({ state: 'landed', method: 'merge --ff-only', checkout: repo, from: B, to: C });
    expect(mainOf(repo)).toBe(C);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('feature\n');
    expect(existsSync(marker)).toBe(false);
    expect(gitSync(repo, 'status', '--porcelain')).toBe('');
  });

  it('refuses a dirty checkout and leaves the base and the edit unchanged', async () => {
    const { repo, B, H } = setup();
    const C = await cleanCandidate(repo, B, H);
    writeFileSync(join(repo, 'base.txt'), 'my own edit\n');
    expect(await land(repo, { candidate: C, base: B, baseBranch: 'main' })).toEqual({ state: 'dirty', checkout: repo, paths: ['base.txt'] });
    expect(mainOf(repo)).toBe(B);
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('my own edit\n');
  });

  it('reports git refusing to overwrite an untracked file, base unchanged', async () => {
    const { repo, B, H } = setup();
    const C = await cleanCandidate(repo, B, H);
    writeFileSync(join(repo, 'feature.txt'), 'untracked\n');
    expect(await land(repo, { candidate: C, base: B, baseBranch: 'main' })).toMatchObject({ state: 'refused', checkout: repo });
    expect(mainOf(repo)).toBe(B);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('untracked\n');
  });

  it('uses an update-ref compare-and-swap when main is not checked out', async () => {
    const { repo, B, H } = setup();
    gitSync(repo, 'checkout', '-q', '-b', 'elsewhere');
    const C = await cleanCandidate(repo, B, H);
    expect(await land(repo, { candidate: C, base: B, baseBranch: 'main' })).toEqual({ state: 'landed', method: 'update-ref', checkout: null, from: B, to: C });
    expect(mainOf(repo)).toBe(C);
    expect(gitSync(repo, 'rev-parse', 'HEAD')).toBe(B);
  });

  it('a moved base is not overwritten (checkout and compare-and-swap paths)', async () => {
    const { repo, B, H } = setup();
    const C = await cleanCandidate(repo, B, H);
    const B2 = commit(repo, 'other.txt', 'moved\n');
    expect(await land(repo, { candidate: C, base: B, baseBranch: 'main' })).toEqual({ state: 'moved', expected: B, current: B2 });
    expect(mainOf(repo)).toBe(B2);
    gitSync(repo, 'checkout', '-q', '-b', 'elsewhere');
    expect(await land(repo, { candidate: C, base: B, baseBranch: 'main' })).toEqual({ state: 'moved', expected: B, current: B2 });
    expect(mainOf(repo)).toBe(B2);
  });

  it('never lands a candidate that is not a fast-forward of the base', async () => {
    const { repo, B, H } = setup();
    expect(await land(repo, { candidate: H, base: B, baseBranch: 'main' })).toMatchObject({ state: 'error', baseUnchanged: true });
    expect(mainOf(repo)).toBe(B);
  });
});
