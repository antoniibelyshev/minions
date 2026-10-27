// Regression (task-71 QA, cases A, B, D, D2): a worker can point the workspace's origin URL at a repository
// of its choice (url.<forged>.insteadOf, pushInsteadOf to the real one) and move the local base refs. The
// sensitive-path gate must take origin's base from the server (an isolated read of minions' recorded https
// URL, cross-checked with the GitHub API) and push to that same URL, so a forged ls-remote can neither
// empty the diff nor let a sensitive change of another task reach the real origin without approval.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitFn } from '../../src/runtime/github.js';
import { gateChangedPaths, originOfRepository, publishTask, type GhFn } from '../../src/runtime/publish.js';
import { git as realGit } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { approvalKeys, ghBranchApi, gitSync, tmp } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';
const TOKEN = 'ghp_' + 'g'.repeat(36);
function put(repo: string, file: string, content: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  gitSync(repo, 'add', '--', file);
}
const commit = (repo: string, msg: string) => { gitSync(repo, 'commit', '-q', '-m', msg); return gitSync(repo, 'rev-parse', 'HEAD'); };

function world() {
  const repo = join(tmp('qa71-'), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  put(repo, 'README.md', 'r\n');
  put(repo, '.github/workflows/ci.yml', 'ci: v1\n');
  const base = commit(repo, 'init');
  const real = join(tmp('qa71-real-'), 'demo.git');
  const forged = join(tmp('qa71-forged-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', real]);
  execFileSync('git', ['init', '-q', '--bare', forged]);
  gitSync(repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(repo, 'config', `url.${real}.insteadOf`, REMOTE);
  gitSync(repo, 'push', '-q', 'origin', 'main');
  gitSync(repo, 'fetch', '-q', 'origin');
  const cfg = defaults();
  cfg.delivery.provider = 'github'; cfg.delivery.mode = 'pull-request';
  const tokenFile = join(tmp(), 'tok'); writeFileSync(tokenFile, TOKEN);
  const keys = approvalKeys();
  const ghCalls: string[][] = [];
  // GitHub (gh reads no repository config): its API answers from the real repository.
  const gh: GhFn = async (args) => {
    const api = ghBranchApi(real, args);
    if (api) return api;
    ghCalls.push(args);
    return args[1] === 'list' ? { code: 0, stdout: '[]', stderr: '' } : { code: 0, stdout: 'https://github.com/acme/demo/pull/9\n', stderr: '' };
  };
  const git: GitFn = (cwd, args, allow) => realGit(cwd, args, allow);
  /** The attack: origin's URL now resolves to `forged`, whose main is `sha`; local base refs moved too. */
  const forge = (sha: string) => {
    gitSync(repo, 'push', '-q', '-f', forged, `${sha}:refs/heads/main`);
    gitSync(repo, 'config', '--unset', `url.${real}.insteadOf`);
    gitSync(repo, 'config', `url.${forged}.insteadOf`, REMOTE);
    gitSync(repo, 'update-ref', 'refs/heads/main', sha);
    gitSync(repo, 'update-ref', 'refs/remotes/origin/main', sha);
    expect(gitSync(repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main').split(/\s+/)[0]).toBe(sha);
  };
  // minions' record names acme/demo; the code-only seam points git at the real (bare) repository for it.
  const publish = (head: string, baseShas: string[]) => publishTask({
    config: cfg, task: { id: 'task-1', title: 'T', description: 'd', acceptanceCriteria: [] } as never,
    repo, branch: 'agent/t', head, git, gh, tokenFile, baseShas, approvals: [], approvalPublicKeyFile: keys.publicKeyFile,
    origin: originOfRepository('acme/demo'), serverUrl: () => real,
  });
  const gate = (head: string, baseShas: string[]) => gateChangedPaths({ git, repo, remote: 'origin', base: 'main', head, branch: 'agent/t', baseShas, sensitivePaths: cfg.sensitivePaths });
  const remoteHas = (ref: string) => { try { gitSync(real, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; } };
  return { repo, base, real, forged, forge, publish, gate, ghCalls, remoteHas };
}

describe('task-71: a forged origin (url.insteadOf) cannot choose the gate base', () => {
  it('normal flow: a non-sensitive PR publishes to the real origin', async () => {
    const w = world();
    gitSync(w.repo, 'checkout', '-q', '-b', 'agent/t');
    put(w.repo, 'src/a.ts', 'a\n');
    const head = commit(w.repo, 'feature');
    expect(await w.publish(head, [w.base])).toMatchObject({ state: 'published', push: 'pushed', sensitivePaths: [] });
    expect(w.remoteHas('refs/heads/agent/t')).toBe(true);
  });

  it('normal flow: a sensitive PR waits for approval', async () => {
    const w = world();
    gitSync(w.repo, 'checkout', '-q', '-b', 'agent/t');
    put(w.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(w.repo, 'ci');
    expect(await w.publish(head, [w.base])).toMatchObject({ state: 'awaiting-approval' });
    expect(w.ghCalls).toHaveLength(0);
  });

  it('A: same-task attacker (forged main contains the head) still waits for approval', async () => {
    const w = world();
    gitSync(w.repo, 'checkout', '-q', '-b', 'agent/t');
    put(w.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(w.repo, 'ci');
    w.forge(gitSync(w.repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'main lookalike'));
    expect(await w.publish(head, [w.base])).toMatchObject({ state: 'awaiting-approval', sensitivePaths: ['.github/workflows/ci.yml'] });
    expect(w.remoteHas('refs/heads/agent/t')).toBe(false);
  });

  it('B: no recorded base and no verified server base: the gate fails closed (the forged ls-remote is never read)', async () => {
    const w = world();
    gitSync(w.repo, 'checkout', '-q', '-b', 'agent/t');
    put(w.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(w.repo, 'ci');
    w.forge(gitSync(w.repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'main lookalike'));
    expect(await w.gate(head, [])).toMatchObject({ ok: false, code: 'PRECONDITION', message: expect.stringMatching(/No trustworthy base/) });
    // publishTask reads the server base itself: the sensitive path is reported against it.
    expect(await w.publish(head, [])).toMatchObject({ state: 'awaiting-approval', sensitivePaths: ['.github/workflows/ci.yml'] });
  });

  it('D: cross-task: worker X poisons local main + insteadOf before task Y is claimed; Y\'s PR waits for approval', async () => {
    const w = world();
    // Worker X: a main lookalike F = base + a workflow change; local main and insteadOf point at it.
    gitSync(w.repo, 'checkout', '-q', '--detach');
    put(w.repo, '.github/workflows/ci.yml', 'evil\n');
    const f = commit(w.repo, 'poison');
    w.forge(f);
    gitSync(w.repo, 'config', `url.${w.real}.pushInsteadOf`, REMOTE); // reads forged, pushes real
    // Task Y, claimed on the poisoned base (the recorded base is F), works innocently on top.
    gitSync(w.repo, 'checkout', '-q', '-b', 'agent/t', f);
    put(w.repo, 'src/y.ts', 'y\n');
    const head = commit(w.repo, 'innocent feature');
    const out = await w.publish(head, [f]);
    expect(out).toMatchObject({ state: 'awaiting-approval' });
    if (out.state === 'awaiting-approval') expect(out.sensitivePaths).toEqual(['.github/workflows/ci.yml']);
    expect(gitSync(w.real, 'rev-parse', 'refs/heads/main')).toBe(w.base);
    expect(w.remoteHas('refs/heads/agent/t')).toBe(false);
    expect(w.ghCalls).toHaveLength(0);
  });

  it('D2: an unreadable origin for reads (pushes still configured to the real one) publishes nothing', async () => {
    const w = world();
    gitSync(w.repo, 'checkout', '-q', '--detach');
    put(w.repo, '.github/workflows/ci.yml', 'evil\n');
    const f = commit(w.repo, 'poison');
    gitSync(w.repo, 'update-ref', 'refs/heads/main', f);
    gitSync(w.repo, 'update-ref', 'refs/remotes/origin/main', f);
    gitSync(w.repo, 'config', '--unset', `url.${w.real}.insteadOf`);
    gitSync(w.repo, 'config', 'url./nonexistent/repo.git.insteadOf', REMOTE);
    gitSync(w.repo, 'config', `url.${w.real}.pushInsteadOf`, REMOTE);
    gitSync(w.repo, 'checkout', '-q', '-b', 'agent/t', f);
    put(w.repo, 'src/y.ts', 'y\n');
    const head = commit(w.repo, 'innocent feature');
    expect(await w.publish(head, [f])).not.toMatchObject({ state: 'published' });
    expect(w.remoteHas('refs/heads/agent/t')).toBe(false);
  });

  it('a server base that is not in the workspace is fetched from the recorded URL (isolated), not from the forged one', async () => {
    const w = world();
    // GitHub merged something the workspace never saw.
    const other = join(tmp('qa71-gh-'), 'gh');
    execFileSync('git', ['clone', '-q', '-b', 'main', w.real, other]);
    put(other, 'merged.txt', 'm\n');
    const merged = commit(other, 'merged on GitHub');
    gitSync(other, 'push', '-q', 'origin', 'main');
    rmSync(other, { recursive: true, force: true });
    gitSync(w.repo, 'checkout', '-q', '-b', 'agent/t');
    put(w.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(w.repo, 'ci');
    w.forge(gitSync(w.repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'main lookalike'));
    const out = await w.publish(head, []);
    expect(out).toMatchObject({ state: 'awaiting-approval', sensitivePaths: ['.github/workflows/ci.yml'] });
    expect(gitSync(w.repo, 'cat-file', '-t', merged)).toBe('commit');
  });
});

describe('task-71: the server origin comes from minions\' own record', () => {
  it('serverOriginOf prefers a recorded PR URL, then the import record; never anything else', async () => {
    const { serverOriginOf, originOfRemoteUrl } = await import('../../src/runtime/publish.js');
    expect(serverOriginOf({ prUrls: [null, 'https://github.com/acme/demo/pull/7'], recorded: 'other/repo' })).toEqual({ https: 'https://github.com/acme/demo.git', repository: 'acme/demo' });
    expect(serverOriginOf({ prUrls: [undefined, 'not a url'], recorded: 'acme/demo' })).toEqual({ https: 'https://github.com/acme/demo.git', repository: 'acme/demo' });
    expect(serverOriginOf({ recorded: '../evil' })).toBeNull();
    expect(serverOriginOf({ recorded: 'a/b/c' })).toBeNull();
    expect(serverOriginOf({})).toBeNull();
    expect(originOfRemoteUrl('git@github.com:acme/demo.git')?.repository).toBe('acme/demo');
    expect(originOfRemoteUrl('https://gitlab.com/acme/demo.git')).toBeNull();
  });
});
