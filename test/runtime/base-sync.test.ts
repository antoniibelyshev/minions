// GitHub delivery: origin/<base> is the single source of truth. Every claim fetches origin and only
// fast-forwards the workspace base; anything else blocks the claim (never a local merge). Local delivery
// is unchanged. Real temp repos; origin is a local bare repo behind a github.com URL (insteadOf).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { syncBaseFromOrigin } from '../../src/runtime/base-sync.js';
import { importWorkspace } from '../../src/runtime/workspace.js';
import { workspaceLayout } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { commitFile, gitSync, initRepo, makeEnv, tmp, type Env } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';

interface OriginEnv extends Env { bare: string; clone: string }

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
  return { ...env, bare, clone };
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

  it('runs before every claim, for testers and reviewers too', async () => {
    const e = originEnv();
    e.backlog.add({ id: 'task-1', title: 'Roles' });
    const eng = await e.sched.claim('task-1', 'engineer');
    const head = commitFile(eng.worktree, 'a.txt', 'a');
    await e.sched.record(eng.leaseId, { status: 'complete', summary: 's', branch: eng.branch, headSha: head, modifiedPaths: ['a.txt'],
      checks: [{ command: 'npm test', outcome: 'pass' }], acceptanceEvidence: [{ criterion: 'works', evidence: 'ok' }], findings: [], nextAction: 'test' });
    const merged = mergeOnGithub(e, 'other.txt');
    const t = await e.sched.claim('task-1', 'tester');
    expect(main(e)).toBe(merged);
    expect(e.db.events('task-1', 'base-sync').map((x) => (x.data as { role: string }).role)).toEqual(['tester']);
    expect(t.expectedHead).toBe(head); // the task branch itself is never rebased or merged
  });

  it('moves a base that is not checked out with update-ref', async () => {
    const e = originEnv();
    gitSync(e.layout.repo, 'checkout', '-q', '--detach');
    const merged = mergeOnGithub(e, 'merged.txt');
    e.backlog.add({ id: 'task-1', title: 'Detached' });
    await e.sched.claim('task-1', 'engineer');
    expect(main(e)).toBe(merged);
    expect(gitSync(e.layout.repo, 'rev-parse', 'HEAD')).toBe(e.baseSha);
    expect(e.db.events('task-1', 'base-sync')[0]?.data).toMatchObject({ method: 'update-ref' });
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

  it('a failed fetch blocks the claim with a reported error', async () => {
    const e = originEnv();
    gitSync(e.layout.repo, 'config', `url.${join(e.root, 'missing.git')}.insteadOf`, REMOTE);
    gitSync(e.layout.repo, 'config', '--unset', `url.${e.bare}.insteadOf`);
    e.backlog.add({ id: 'task-1', title: 'Offline' });
    const err = await failure(e.sched.claim('task-1', 'engineer'));
    expect(err.message).toMatch(/fetching main from origin failed.*claim was blocked/);
    expect(e.db.leases({ all: true })).toHaveLength(0);
    expect(e.db.events('task-1', 'base-sync-blocked')[0]?.data).toMatchObject({ details: { reason: 'fetch-failed' } });
  });

  it('refuses a workspace without a github.com origin', async () => {
    const e = originEnv('branch');
    gitSync(e.layout.repo, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/demo.git');
    e.backlog.add({ id: 'task-1', title: 'No GitHub' });
    const err = await failure(e.sched.claim('task-1', 'engineer'));
    expect(err.code).toBe('PRECONDITION');
    expect(err.message).toMatch(/no github\.com origin remote/);
  });

  it('creates a missing local base at origin/main', async () => {
    const e = originEnv();
    gitSync(e.layout.repo, 'checkout', '-q', '--detach');
    gitSync(e.layout.repo, 'branch', '-q', '-D', 'main');
    const r = await syncBaseFromOrigin(e.layout.repo, 'main');
    expect(r).toMatchObject({ action: 'created', from: null, to: e.baseSha });
    expect(main(e)).toBe(e.baseSha);
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
  it("baseFrom 'origin' fetches the host refs but never moves the base to the host's base", async () => {
    const root = tmp();
    const host = join(root, 'host');
    mkdirSync(host);
    initRepo(host, 'trunk');
    const bundle1 = join(root, 'in1.bundle');
    gitSync(host, 'bundle', 'create', bundle1, 'trunk');
    const layout = workspaceLayout(join(root, 'workspace'));
    const config = defaults();
    await importWorkspace(bundle1, { base: 'trunk', config, layout });
    const before = gitSync(layout.repo, 'rev-parse', 'refs/heads/trunk');

    // The host's local trunk gains a commit that never went through a PR.
    const hostHead2 = commitFile(host, 'host.txt', 'local host merge');
    const bundle2 = join(root, 'in2.bundle');
    gitSync(host, 'bundle', 'create', bundle2, 'trunk');
    const second = await importWorkspace(bundle2, { base: 'trunk', config, layout, baseFrom: 'origin' });
    expect(second).toMatchObject({ imported: false, baseFastForwarded: false });
    expect(gitSync(layout.repo, 'rev-parse', 'refs/heads/trunk')).toBe(before);
    expect(gitSync(layout.repo, 'rev-parse', 'refs/remotes/host/trunk')).toBe(hostHead2);
  });
});
