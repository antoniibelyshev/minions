// Publishing against real git (integration tier): a bare repository as origin, the owner's clone with the agents' base
// exported as refs/remotes/minions/<base> (what `minions pull` leaves), and planPublish / publishCommit from
// src/host/publish.ts: the binding to the agents' base, the fast-forward check, the secret and large-file scan, the
// direct push with the owner's checkout fast-forward, and pull-request mode with a stubbed `gh`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../src/core/exec.js';
import { LARGE_FILE_BYTES, planPublish, prBranch, publishCommit } from '../../src/host/publish.js';
import { git, makeRepo, tempDir } from './fixtures.js';

const ID = ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com'];
const roots: string[] = [];
const saved = process.env.GIT_CONFIG_GLOBAL;
beforeAll(() => { process.env.GIT_CONFIG_GLOBAL = '/dev/null'; });
afterAll(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved;
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function commit(repo: string, files: Record<string, string | Buffer>, message: string): string {
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), c); }
  git(repo, 'add', '-A', '-f'); // -f: the seed ignores .env, and the scan must see one anyway
  git(repo, ...ID, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** origin (bare), the owner's clone on main, and an agents' clone whose main is two commits ahead, exported to the owner. */
function world(agentFiles: Record<string, string | Buffer>[] = [{ 'src/a.ts': 'export const a = 1;\n' }, { 'src/b.ts': 'export const b = 2;\n' }]) {
  const root = tempDir('minions-publish-');
  roots.push(root);
  const seed = makeRepo(root, 'seed');
  const origin = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', seed, origin);
  const owner = join(root, 'owner');
  git(root, 'clone', '-q', origin, owner);
  const agents = join(root, 'agents');
  git(root, 'clone', '-q', origin, agents);
  const base = git(owner, 'rev-parse', 'HEAD');
  let head = base;
  agentFiles.forEach((f, i) => { head = commit(agents, f, `agent work ${i + 1}`); });
  git(owner, 'fetch', '-q', agents, '+refs/heads/*:refs/remotes/minions/*');
  return { root, origin, owner, agents, base, head };
}

const originHead = (w: { origin: string }, branch = 'main') => git(w.origin, 'rev-parse', `refs/heads/${branch}`);

describe('planPublish', () => {
  it('plans the outgoing range of an exported commit that fast-forwards origin', async () => {
    const w = world();
    const p = await planPublish({ repo: w.owner, base: 'main', sha: w.head });
    expect(p).toMatchObject({ refusal: null, from: w.base, commits: 2, files: 2, hits: [], subjects: ['agent work 2', 'agent work 1'] });
    expect(p.remoteUrl).toBe(w.origin);
  });

  it('refuses a commit that is unknown, or not on the agents\' base', async () => {
    const w = world();
    expect((await planPublish({ repo: w.owner, base: 'main', sha: 'f'.repeat(40) })).refusal?.code).toBe('unknown-commit');
    git(w.agents, 'checkout', '-q', '-b', 'side');
    const side = commit(w.agents, { 'side.txt': 'x\n' }, 'side');
    git(w.owner, 'fetch', '-q', w.agents, '+refs/heads/*:refs/remotes/minions/*');
    const p = await planPublish({ repo: w.owner, base: 'main', sha: side });
    expect(p.refusal).toMatchObject({ code: 'not-on-base', message: expect.stringMatching(/not on the agents' main \(minions\/main\)/) });
  });

  it('refuses when origin moved (not a fast-forward) and when there is nothing new', async () => {
    const w = world();
    const other = join(w.root, 'other');
    git(w.root, 'clone', '-q', w.origin, other);
    commit(other, { 'theirs.txt': 'x\n' }, 'pushed elsewhere');
    git(other, 'push', '-q', 'origin', 'main');
    expect((await planPublish({ repo: w.owner, base: 'main', sha: w.head })).refusal?.code).toBe('diverged');
    const v = world();
    expect((await planPublish({ repo: v.owner, base: 'main', sha: v.base })).refusal?.code).toBe('up-to-date');
  });

  it('is unavailable without a remote', async () => {
    const w = world();
    git(w.owner, 'remote', 'remove', 'origin');
    expect((await planPublish({ repo: w.owner, base: 'main', sha: w.head })).refusal).toMatchObject({ code: 'no-remote', message: expect.stringMatching(/publishing is unavailable/) });
  });

  it('refuses secret-like files, secret-shaped added lines and large files, naming paths but never values', async () => {
    const key = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const w = world([{ '.env': 'API=1\n', 'docs/setup.md': 'fine\n' }, { 'deploy/id': `${key}\n`, 'src/conf.ts': `export const t = "${token}";\n` }, { 'assets/big.bin': Buffer.alloc(LARGE_FILE_BYTES + 1, 1) }]);
    const p = await planPublish({ repo: w.owner, base: 'main', sha: w.head });
    expect(p.refusal?.code).toBe('scan');
    expect(p.hits.map((h) => [h.kind, h.path]).sort()).toEqual([
      ['large-file', 'assets/big.bin'], ['secret-content', 'deploy/id'], ['secret-content', 'src/conf.ts'], ['secret-file', '.env'],
    ]);
    expect(JSON.stringify(p)).not.toContain(token);
    expect(JSON.stringify(p)).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
    // An example env file is not a secret.
    const ok = world([{ '.env.example': 'API=\n' }]);
    expect((await planPublish({ repo: ok.owner, base: 'main', sha: ok.head })).refusal).toBeNull();
  });
});

describe('publishCommit', () => {
  it('direct: pushes exactly the approved commit and fast-forwards the clean checkout on the base', async () => {
    const w = world();
    const plan = await planPublish({ repo: w.owner, base: 'main', sha: w.head });
    const r = await publishCommit({ repo: w.owner, base: 'main', sha: w.head, plan, mode: 'direct' });
    expect(originHead(w)).toBe(w.head);
    expect(r).toMatchObject({ mode: 'direct', ref: 'refs/heads/main', checkout: { action: 'fast-forward', applied: true } });
    expect(git(w.owner, 'rev-parse', 'HEAD')).toBe(w.head);
  });

  it('direct: leaves a checkout with tracked changes (or on another branch) alone, keeping its untracked files', async () => {
    const w = world();
    writeFileSync(join(w.owner, 'README.md'), '# my edit\n');
    writeFileSync(join(w.owner, 'notes.txt'), 'mine\n');
    const plan = await planPublish({ repo: w.owner, base: 'main', sha: w.head });
    const r = await publishCommit({ repo: w.owner, base: 'main', sha: w.head, plan, mode: 'direct' });
    expect(originHead(w)).toBe(w.head);
    expect(r.checkout).toMatchObject({ applied: false, reason: expect.stringMatching(/uncommitted change/) });
    expect(git(w.owner, 'rev-parse', 'HEAD')).toBe(w.base);
    expect(git(w.owner, 'status', '--porcelain')).toContain('notes.txt');
  });

  it('direct: a push that raced another one is refused by the remote, never forced', async () => {
    const w = world();
    const plan = await planPublish({ repo: w.owner, base: 'main', sha: w.head });
    const other = join(w.root, 'other');
    git(w.root, 'clone', '-q', w.origin, other);
    const theirs = commit(other, { 'theirs.txt': 'x\n' }, 'pushed meanwhile');
    git(other, 'push', '-q', 'origin', 'main');
    await expect(publishCommit({ repo: w.owner, base: 'main', sha: w.head, plan, mode: 'direct' })).rejects.toThrow(/git push origin .* failed/);
    expect(originHead(w)).toBe(theirs);
  });

  it('creates the base on a remote that does not have it yet', async () => {
    const w = world();
    git(w.agents, 'checkout', '-q', '-b', 'release');
    const head = commit(w.agents, { 'r.txt': 'r\n' }, 'release work');
    git(w.owner, 'fetch', '-q', w.agents, '+refs/heads/*:refs/remotes/minions/*');
    const plan = await planPublish({ repo: w.owner, base: 'release', sha: head });
    expect(plan).toMatchObject({ refusal: null, from: null, commits: 3 });
    await publishCommit({ repo: w.owner, base: 'release', sha: head, plan, mode: 'direct' });
    expect(originHead(w, 'release')).toBe(head);
  });

  it('pull-request: pushes a branch, opens the PR with gh, and leaves the base alone', async () => {
    const w = world();
    const calls: { cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
    const runner = async (cmd: string, args: string[], opts: RunOptions = {}) => {
      if (cmd !== 'gh') return run(cmd, args, opts);
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      return { code: 0, stdout: 'Creating pull request...\nhttps://github.com/owner/repo/pull/7\n', stderr: '' };
    };
    const plan = await planPublish({ repo: w.owner, base: 'main', sha: w.head, runner });
    const r = await publishCommit({ repo: w.owner, base: 'main', sha: w.head, plan, mode: 'pull-request', runner, title: 'Checkout flow', body: 'Tasks: task-1' });
    expect(r).toMatchObject({ mode: 'pull-request', prUrl: 'https://github.com/owner/repo/pull/7', checkout: null, ref: `refs/heads/${prBranch(w.head)}` });
    expect(git(w.origin, 'rev-parse', `refs/heads/${prBranch(w.head)}`)).toBe(w.head);
    expect(originHead(w)).toBe(w.base);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['pr', 'create', '--base', 'main', '--head', prBranch(w.head), '--title', 'Checkout flow', '--body', 'Tasks: task-1']);
    expect(calls[0]!.cwd).toBe(w.owner);
    expect(calls[0]!.env?.GH_PROMPT_DISABLED).toBe('1');
  });

  it('pull-request: a missing gh is reported with what to do, after the branch was pushed', async () => {
    const w = world();
    const runner = async (cmd: string, args: string[], opts: RunOptions = {}) => (cmd === 'gh' ? { code: 127, stdout: '', stderr: 'spawn gh ENOENT' } : run(cmd, args, opts));
    const plan = await planPublish({ repo: w.owner, base: 'main', sha: w.head, runner });
    await expect(publishCommit({ repo: w.owner, base: 'main', sha: w.head, plan, mode: 'pull-request', runner })).rejects.toMatchObject({ hint: expect.stringMatching(/Install the GitHub CLI/) });
    expect(git(w.origin, 'rev-parse', `refs/heads/${prBranch(w.head)}`)).toBe(w.head);
  });

  it('never pushes a refused plan', async () => {
    const w = world([{ '.env': 'X=1\n' }]);
    const plan = await planPublish({ repo: w.owner, base: 'main', sha: w.head });
    await expect(publishCommit({ repo: w.owner, base: 'main', sha: w.head, plan, mode: 'direct' })).rejects.toThrow(/not published/);
    expect(originHead(w)).toBe(w.base);
  });
});
