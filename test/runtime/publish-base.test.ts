// Adversarial tests for the sensitive-path gate's choice of base (task-1.12): the diff must not be
// emptied or shrunk by in-runtime code moving refs, and ordinary delivery must keep working.
// Real git throughout (temp workspace + temp bare origin); never the live /state or DB.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitFn } from '../../src/runtime/github.js';
import { publishTask, type GhFn } from '../../src/runtime/publish.js';
import { git as realGit } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { approvalKeys, gitSync, tmp } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';
const TOKEN = 'ghp_' + 'c'.repeat(36);

function put(repo: string, file: string, content: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  gitSync(repo, 'add', '--', file);
}
const commit = (repo: string, msg: string) => { gitSync(repo, 'commit', '-q', '-m', msg); return gitSync(repo, 'rev-parse', 'HEAD'); };

/** Workspace whose origin (github URL) is rewritten to a temp bare repo; main pushed; agent/t checked out. */
function setup() {
  const repo = join(tmp('minions-gate-'), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  put(repo, 'README.md', 'r\n');
  put(repo, '.github/workflows/ci.yml', 'ci: v1\n');
  const claimBase = commit(repo, 'init');
  const bare = join(tmp('minions-gate-origin-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitSync(repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(repo, 'config', `url.${bare}.insteadOf`, REMOTE);
  gitSync(repo, 'push', '-q', 'origin', 'main');
  gitSync(repo, 'fetch', '-q', 'origin');
  gitSync(repo, 'checkout', '-q', '-b', 'agent/t');
  const cfg = defaults();
  cfg.delivery.provider = 'github'; cfg.delivery.mode = 'branch';
  const tokenFile = join(tmp(), 'tok'); writeFileSync(tokenFile, TOKEN);
  const keys = approvalKeys();
  const calls: string[][] = [];
  let lsRemoteFails = false;
  const git: GitFn = async (cwd, args, allow) => {
    calls.push(args);
    if (lsRemoteFails && args[0] === 'ls-remote') return { code: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host' };
    return realGit(cwd, args, allow);
  };
  const gh: GhFn = async () => ({ code: 1, stdout: '', stderr: 'gh must not run in branch mode' });
  const run = (head: string, baseShas: (string | null)[], approved = false) => publishTask({
    config: cfg, task: { id: 'task-1', title: 'T', description: 'd', acceptanceCriteria: [] } as never,
    repo, branch: 'agent/t', head, git, gh, tokenFile, baseShas,
    approvals: approved ? [keys.sign('task-1', head)] : [], approvalPublicKeyFile: keys.publicKeyFile,
  });
  const remoteHead = (ref: string) => { try { return gitSync(bare, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; } };
  return { repo, bare, cfg, claimBase, calls, run, remoteHead, setLsRemoteFails: (v: boolean) => { lsRemoteFails = v; } };
}

describe('sensitive-path gate: bases the runtime cannot move', () => {
  it('a recorded base rewritten to a descendant of the head does not hide paths while origin still has the real base', async () => {
    const t = setup();
    put(t.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(t.repo, 'touch ci');
    put(t.repo, 'later.txt', 'x');
    const descendant = commit(t.repo, 'descendant');
    gitSync(t.repo, 'update-ref', 'refs/heads/main', descendant);
    gitSync(t.repo, 'update-ref', 'refs/remotes/origin/main', descendant);
    expect(gitSync(t.repo, 'diff', '--name-only', `${descendant}...${head}`)).toBe('');
    const out = await t.run(head, [descendant, head]);
    expect(out).toMatchObject({ state: 'awaiting-approval', sensitivePaths: ['.github/workflows/ci.yml'] });
    expect(t.remoteHead('refs/heads/agent/t')).toBeNull();
  });

  it('a recorded base that is not an ancestor of the head (unrelated history) cannot shrink the diff below origin\'s', async () => {
    const t = setup();
    put(t.repo, '.github/workflows/ci.yml', 'evil\n');
    put(t.repo, 'a.txt', 'a');
    const head = commit(t.repo, 'touch ci');
    // An orphan commit whose tree equals the head's: diff head vs it would be empty, and there is no merge base.
    const orphan = gitSync(t.repo, 'commit-tree', `${head}^{tree}`, '-m', 'orphan');
    const out = await t.run(head, [orphan]);
    // No merge base: the gate fails closed rather than evaluating a partial diff; nothing is pushed.
    expect(out).toMatchObject({ state: 'failed', code: 'INTERNAL', message: expect.stringMatching(/no merge base/) });
    expect(t.remoteHead('refs/heads/agent/t')).toBeNull();
  });

  it('deleting or renaming a sensitive file counts against the recorded base even with every local base ref moved to the head', async () => {
    for (const op of ['delete', 'rename'] as const) {
      const t = setup();
      if (op === 'delete') gitSync(t.repo, 'rm', '-q', '--', '.github/workflows/ci.yml');
      else gitSync(t.repo, 'mv', '--', '.github/workflows/ci.yml', 'moved-ci.yml');
      const head = commit(t.repo, op);
      for (const ref of ['refs/heads/main', 'refs/remotes/origin/main']) gitSync(t.repo, 'update-ref', ref, head);
      t.setLsRemoteFails(true); // only the recorded base is trusted
      const out = await t.run(head, [t.claimBase]);
      expect(out, op).toMatchObject({ state: 'awaiting-approval', sensitivePaths: ['.github/workflows/ci.yml'] });
    }
  });

  it('ls-remote failure: falls back to the recorded base for the gate, then fails the publication without pushing', async () => {
    const t = setup();
    put(t.repo, 'a.txt', 'a');
    const head = commit(t.repo, 'plain');
    t.setLsRemoteFails(true);
    expect(await t.run(head, [t.claimBase])).toMatchObject({ state: 'failed' });
    expect(t.calls.some((a) => a[0] === 'push')).toBe(false);
    // No recorded base and no remote: fail closed before any gate evaluation, even though refs/heads/main exists.
    expect(await t.run(head, [])).toMatchObject({ state: 'failed', code: 'PRECONDITION', message: expect.stringMatching(/No trustworthy base/) });
  });

  it('a branch that merged main in after the claim: the gate still sees its own sensitive change (merging only adds paths)', async () => {
    const t = setup();
    put(t.repo, '.github/workflows/ci.yml', 'evil\n');
    commit(t.repo, 'touch ci');
    // main moves on (non-sensitive) and the branch merges it.
    gitSync(t.repo, 'checkout', '-q', 'main');
    put(t.repo, 'main-only.txt', 'm');
    const mainTip = commit(t.repo, 'main progress');
    gitSync(t.repo, 'push', '-q', 'origin', 'main');
    gitSync(t.repo, 'checkout', '-q', 'agent/t');
    gitSync(t.repo, 'merge', '-q', '--no-edit', 'main');
    const head = gitSync(t.repo, 'rev-parse', 'HEAD');
    const out = await t.run(head, [t.claimBase, mainTip]);
    expect(out.state).toBe('awaiting-approval');
    if (out.state !== 'awaiting-approval') return;
    expect(out.sensitivePaths).toEqual(['.github/workflows/ci.yml']);
    // The union also includes main's own post-claim change vs the claim base (over-reporting, never hiding).
    expect(out.changedPaths).toEqual(expect.arrayContaining(['.github/workflows/ci.yml', 'main-only.txt']));
  });

  it('unusual file names (leading dashes, quotes, newlines, pathspec magic, "--") are reported verbatim and matched', async () => {
    const t = setup();
    const names = ['-- --cached', '--output=x', ':(exclude).github', 'quo"te\'s.txt', 'new\nline.txt', '*', '.github/workflows/-x.yml', '.github/workflows/:(top)y.yml'];
    for (const n of names) put(t.repo, n, 'x');
    const head = commit(t.repo, 'odd names');
    for (const ref of ['refs/heads/main', 'refs/remotes/origin/main']) gitSync(t.repo, 'update-ref', ref, head);
    const out = await t.run(head, [t.claimBase]);
    expect(out.state).toBe('awaiting-approval');
    if (out.state !== 'awaiting-approval') return;
    expect([...out.changedPaths].sort()).toEqual([...names].sort());
    expect([...out.sensitivePaths].sort()).toEqual(['.github/workflows/-x.yml', '.github/workflows/:(top)y.yml'].sort());
    expect(t.remoteHead('refs/heads/agent/t')).toBeNull();
  });

  it('recorded base values that look like options or revision expressions are ignored, never passed to git diff', async () => {
    const t = setup();
    put(t.repo, 'a.txt', 'a');
    const head = commit(t.repo, 'plain');
    const hostile = ['--output=/tmp/pwn', `${head}`.slice(0, 39), 'HEAD', `${t.claimBase}^`, `${t.claimBase} --cached`, `${t.claimBase.toUpperCase()}`];
    await t.run(head, hostile);
    const diffArgs = t.calls.filter((a) => a[0] === 'diff').map((a) => a[a.length - 1]!);
    expect(diffArgs.length).toBeGreaterThan(0);
    for (const arg of diffArgs) expect(arg.split('...')[0]).toMatch(/^(?:[0-9a-f]{40}|refs\/(?:heads|remotes\/(?:origin|host))\/main)$/);
  });
});

describe('sensitive-path gate: ordinary delivery still works', () => {
  it('a recorded base that was garbage-collected is skipped; origin\'s base carries the gate and the branch is pushed', async () => {
    const t = setup();
    put(t.repo, 'a.txt', 'a');
    const head = commit(t.repo, 'plain');
    const gone = 'd'.repeat(40);
    const out = await t.run(head, [gone, null]);
    expect(out).toMatchObject({ state: 'published', push: 'pushed', changedPaths: ['a.txt'], sensitivePaths: [] });
    expect(t.remoteHead('refs/heads/agent/t')).toBe(head);
  });

  it('a repeat publish after new commits fast-forwards; the gate re-evaluates and catches a sensitive change added later', async () => {
    const t = setup();
    put(t.repo, 'a.txt', 'a');
    const h1 = commit(t.repo, 'one');
    expect(await t.run(h1, [t.claimBase])).toMatchObject({ state: 'published', push: 'pushed' });
    put(t.repo, 'b.txt', 'b');
    const h2 = commit(t.repo, 'two');
    expect(await t.run(h2, [t.claimBase])).toMatchObject({ state: 'published', push: 'pushed', changedPaths: expect.arrayContaining(['a.txt', 'b.txt']) });
    expect(t.remoteHead('refs/heads/agent/t')).toBe(h2);
    expect(await t.run(h2, [t.claimBase])).toMatchObject({ state: 'published', push: 'already-current' });
    put(t.repo, '.github/workflows/ci.yml', 'later\n');
    const h3 = commit(t.repo, 'three');
    expect(await t.run(h3, [t.claimBase])).toMatchObject({ state: 'awaiting-approval', sensitivePaths: ['.github/workflows/ci.yml'] });
    expect(await t.run(h3, [t.claimBase], true)).toMatchObject({ state: 'published', push: 'pushed' });
    expect(t.remoteHead('refs/heads/agent/t')).toBe(h3);
  });

  it('local delivery runs no git at all (no gate, no ls-remote)', async () => {
    const t = setup();
    t.cfg.delivery.mode = 'local';
    const out = await t.run(gitSync(t.repo, 'rev-parse', 'HEAD'), []);
    expect(out).toMatchObject({ state: 'failed', code: 'PRECONDITION', message: expect.stringMatching(/local/) });
    expect(t.calls).toHaveLength(0);
  });

  it('many leases do not multiply diff work: duplicate recorded bases are diffed once', async () => {
    const t = setup();
    put(t.repo, 'a.txt', 'a');
    const head = commit(t.repo, 'plain');
    const recorded = Array.from({ length: 500 }, (_, i) => (i % 3 === 0 ? null : t.claimBase));
    const started = Date.now();
    expect(await t.run(head, recorded)).toMatchObject({ state: 'published' });
    const diffs = t.calls.filter((a) => a[0] === 'diff');
    const revParses = t.calls.filter((a) => a[0] === 'rev-parse');
    // claimBase == origin/main == refs/heads/main tip by SHA, but they are distinct strings: at most one diff
    // per distinct recorded SHA + the remote SHA (deduped with it) + the three local refs.
    expect(diffs).toHaveLength(3); // the recorded SHA equals origin's base here, so it is diffed once
    expect(revParses.length).toBeLessThanOrEqual(6);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

