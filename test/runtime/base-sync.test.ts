// GitHub delivery: origin/<base> is the single source of truth. Every claim fetches origin and only
// fast-forwards the workspace base; anything else blocks the claim (never a local merge). Local delivery
// is unchanged. Real temp repos; origin is a local bare repo behind a github.com URL (insteadOf).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { syncBaseFromOrigin } from '../../src/runtime/base-sync.js';
import type { GitFn } from '../../src/runtime/github.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { git as realGit } from '../../src/runtime/worktree.js';
import type { GhFn } from '../../src/runtime/publish.js';
import { commitFile, ghBranchApi, gitSync, makeEnv, tmp, type Env } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';

/**
 * `srv`: the server seam of the verified base read (task-71). git reaches the recorded https origin at
 * `server.url` (the bare repository unless a test points it elsewhere) and `gh api .../branches/main` answers
 * from the bare repository (or fails when `server.ghDown`).
 */
interface OriginEnv extends Env { bare: string; clone: string; server: { url: string; ghDown: boolean }; srv: { gh: GhFn; serverUrl: () => string } }

/** Workspace whose origin (github.com URL rewritten to a bare repo) has main == the workspace main. */
function originEnv(mode: MinionsConfig['delivery']['mode'] = 'pull-request'): OriginEnv {
  const env = makeEnv((c) => {
    c.delivery.mode = mode;
    if (mode !== 'local') c.delivery.provider = 'github';
  });
  const bare = join(tmp('minions-origin-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitSync(env.layout.repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(env.layout.repo, 'config', `url.${bare}.insteadOf`, REMOTE);
  gitSync(env.layout.repo, 'push', '-q', 'origin', 'main');
  // A second clone stands in for GitHub merging pull requests into origin/main.
  const clone = join(tmp('minions-gh-'), 'gh');
  execFileSync('git', ['clone', '-q', '-b', 'main', bare, clone]);
  const server = { url: bare, ghDown: false };
  const gh: GhFn = async (args) => (server.ghDown ? null : ghBranchApi(bare, args)) ?? { code: 1, stdout: '', stderr: 'error connecting to api.github.com' };
  const srv = { gh, serverUrl: () => server.url };
  const sched = new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, ...srv });
  return { ...env, sched, bare, clone, server, srv };
}

/** A PR merged on GitHub: one commit on origin/main. */
const mergeOnGithub = (e: OriginEnv, file: string) => {
  const sha = commitFile(e.clone, file, `${file}\n`, `merge PR: ${file}`);
  gitSync(e.clone, 'push', '-q', 'origin', 'main');
  return sha;
};
const main = (e: Env) => gitSync(e.layout.repo, 'rev-parse', 'refs/heads/main');
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MinionsError; } throw new Error('expected the claim to fail'); };

describe('pre-claim base sync (GitHub delivery)', () => {
  it('fetches origin and fast-forwards the base before the claim; the brief starts from origin/main', async () => {
    const e = originEnv();
    const merged = mergeOnGithub(e, 'merged.txt');
    e.backlog.add({ id: 'task-1', title: 'After merge' });
    const brief = await e.sched.claim('task-1', 'engineer');
    expect(main(e)).toBe(merged);
    expect(gitSync(e.layout.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(merged);
    expect(brief.baseSha).toBe(merged);
    expect(gitSync(brief.worktree, 'rev-parse', 'HEAD')).toBe(merged);
    // merge --ff-only in the base checkout: no merge commit, the work tree follows.
    expect(gitSync(e.layout.repo, 'rev-list', '--merges', '--count', 'main')).toBe('0');
    expect(gitSync(e.layout.repo, 'status', '--porcelain')).toBe('');
    expect(e.db.events('task-1', 'base-sync')[0]?.data).toMatchObject({ role: 'engineer', action: 'fast-forward', method: 'merge --ff-only', from: e.baseSha, to: merged });
  });

  it('a local commit on the base (e.g. a local merge) blocks the claim; nothing is merged and no lease starts', async () => {
    const e = originEnv();
    const local = commitFile(e.layout.repo, 'local.txt', 'merged locally', 'local merge of agent/x');
    e.backlog.add({ id: 'task-1', title: 'Blocked' });
    const err = await failure(e.sched.claim('task-1', 'engineer'));
    expect(err).toBeInstanceOf(MinionsError);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/Local main \([0-9a-f]{12}\) is 1 commit\(s\) ahead of origin\/main.*single source of truth.*claim was blocked; nothing was merged/);
    expect(err.hint).toMatch(/pull request/);
    expect(main(e)).toBe(local);
    expect(e.sched.list()).toHaveLength(0);
    expect(e.db.leases({ all: true })).toHaveLength(0);
    expect(e.backlog.status('task-1')).toBe('ready');
    expect(e.db.events('task-1', 'base-sync-blocked')[0]?.data).toMatchObject({ role: 'engineer', base: 'main', code: 'CONFLICT', details: { reason: 'ahead', local } });
  });

  it('a diverged base blocks the claim and is left exactly as it was', async () => {
    const e = originEnv();
    const local = commitFile(e.layout.repo, 'local.txt', 'local');
    const merged = mergeOnGithub(e, 'merged.txt');
    e.backlog.add({ id: 'task-1', title: 'Diverged' });
    const err = await failure(e.sched.claim('task-1', 'engineer'));
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toMatch(/has diverged from origin\/main.*1 local, 1 on origin/);
    expect(main(e)).toBe(local);
    expect(gitSync(e.layout.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(merged);
    expect(gitSync(e.layout.repo, 'rev-list', '--merges', '--count', 'main')).toBe('0');
  });

});

describe('local delivery is unchanged', () => {
  it('never fetches: a local base ahead of origin (or no origin at all) does not block the claim', async () => {
    const e = originEnv('local');
    const local = commitFile(e.layout.repo, 'local.txt', 'local');
    gitSync(e.layout.repo, 'remote', 'remove', 'origin');
    e.backlog.add({ id: 'task-1', title: 'Local' });
    const brief = await e.sched.claim('task-1', 'engineer');
    expect(brief.baseSha).toBe(local);
    expect(e.db.events('task-1', 'base-sync')).toHaveLength(0);
    expect(e.db.events('task-1', 'base-sync-blocked')).toHaveLength(0);
  });
});

describe('workspace import under GitHub delivery', () => {
});

describe('pre-claim base sync: edge cases', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('the server read never goes through the workspace git or its url.insteadOf: a forged origin cannot choose the base (task-71)', async () => {
    const e = originEnv();
    const merged = mergeOnGithub(e, 'merged.txt');
    // A worker's forgery: origin's URL now resolves to a repository whose main carries a workflow change,
    // and the local base refs were moved there too.
    gitSync(e.layout.repo, 'checkout', '-q', '--detach');
    mkdirSync(join(e.layout.repo, '.github', 'workflows'), { recursive: true });
    const forgedSha = commitFile(e.layout.repo, '.github/workflows/ci.yml', 'evil\n', 'poison');
    const forged = join(tmp('minions-forged-'), 'demo.git');
    execFileSync('git', ['init', '-q', '--bare', forged]);
    gitSync(e.layout.repo, 'push', '-q', forged, `${forgedSha}:refs/heads/main`);
    gitSync(e.layout.repo, 'config', '--unset', `url.${e.bare}.insteadOf`);
    gitSync(e.layout.repo, 'config', `url.${forged}.insteadOf`, REMOTE);
    gitSync(e.layout.repo, 'update-ref', 'refs/remotes/origin/main', forgedSha);
    const ops: string[] = [];
    const git: GitFn = async (cwd, args, allowFailure) => { ops.push(args[0]!); return realGit(cwd, args, allowFailure); };
    const r = await syncBaseFromOrigin(e.layout.repo, 'main', { ...e.srv, git });
    expect(r).toMatchObject({ to: merged, action: 'fast-forward' });
    expect(ops).not.toContain('fetch');
    expect(ops).not.toContain('ls-remote');
    expect(gitSync(e.layout.repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(merged);
    // A local base moved onto the forgery is ahead of origin's verified base: the claim is blocked.
    gitSync(e.layout.repo, 'update-ref', 'refs/heads/main', forgedSha);
    e.backlog.add({ id: 'task-1', title: 'Forged' });
    const err = await failure(e.sched.claim('task-1', 'engineer'));
    expect(err.code).toBe('CONFLICT');
    expect(e.db.leases({ all: true })).toHaveLength(0);
  });

});
