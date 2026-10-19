import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportWorkspace, importWorkspace, setupState } from '../../src/runtime/workspace.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { workspaceLayout } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { commitFile, gitSync, initRepo, tmp } from './fixtures.js';

describe('workspace import/export', () => {
  it('round-trips through bundles without rewriting local branches', async () => {
    const root = tmp();
    const host = join(root, 'host');
    mkdirSync(host);
    const hostHead = initRepo(host, 'trunk');
    const bundle1 = join(root, 'in1.bundle');
    gitSync(host, 'bundle', 'create', bundle1, 'trunk');
    const layout = workspaceLayout(join(root, 'workspace'));
    const config = defaults();

    const first = await importWorkspace(bundle1, { base: 'trunk', remoteUrl: 'git@github.com:acme/app.git', config, layout });
    expect(first).toMatchObject({ head: hostHead, base: 'trunk', imported: true });
    expect(gitSync(layout.repo, 'config', 'user.email')).toBe(config.git.identity.email);
    expect(gitSync(layout.repo, 'remote', 'get-url', 'origin')).toBe('git@github.com:acme/app.git');
    expect(gitSync(layout.repo, 'rev-parse', 'refs/remotes/host/trunk')).toBe(hostHead);

    // container work: an agent branch and a diverging local base commit
    gitSync(layout.repo, 'checkout', '-q', '-b', 'agent/task-1-x');
    const agentHead = commitFile(layout.repo, 'feature.txt', 'feature');
    gitSync(layout.repo, 'checkout', '-q', 'trunk');
    const localTrunk = commitFile(layout.repo, 'local.txt', 'local only');

    // host advances; re-import fetches into refs/remotes/host/* only
    const hostHead2 = commitFile(host, 'host.txt', 'host change');
    const bundle2 = join(root, 'in2.bundle');
    gitSync(host, 'bundle', 'create', bundle2, 'trunk');
    const second = await importWorkspace(bundle2, { base: 'trunk', config, layout });
    expect(second.imported).toBe(false);
    expect(gitSync(layout.repo, 'rev-parse', 'refs/heads/trunk')).toBe(localTrunk);
    expect(gitSync(layout.repo, 'rev-parse', 'refs/heads/agent/task-1-x')).toBe(agentHead);
    expect(gitSync(layout.repo, 'rev-parse', 'refs/remotes/host/trunk')).toBe(hostHead2);

    const out = join(root, 'exports', 'out.bundle');
    const ex = await exportWorkspace(out, { base: 'trunk', layout });
    expect(ex.refs).toEqual(['refs/heads/trunk', 'refs/heads/agent/task-1-x']);
    gitSync(host, 'fetch', '-q', out, '+refs/heads/*:refs/remotes/minions/*');
    expect(gitSync(host, 'rev-parse', 'refs/remotes/minions/agent/task-1-x')).toBe(agentHead);
    expect(gitSync(host, 'rev-parse', 'refs/heads/trunk')).toBe(hostHead2); // host branch untouched
    expect(readFileSync(join(layout.repo, 'local.txt'), 'utf8')).toBe('local only');
  });

  it('re-import fast-forwards an undiverged local base so new agent branches start from it', async () => {
    const root = tmp();
    const host = join(root, 'host');
    mkdirSync(host);
    initRepo(host, 'trunk');
    const bundle1 = join(root, 'in1.bundle');
    gitSync(host, 'bundle', 'create', bundle1, 'trunk');
    const layout = workspaceLayout(join(root, 'workspace'));
    const config = defaults();
    await importWorkspace(bundle1, { base: 'trunk', config, layout });

    const hostHead2 = commitFile(host, 'host.txt', 'host change');
    const bundle2 = join(root, 'in2.bundle');
    gitSync(host, 'bundle', 'create', bundle2, 'trunk');
    const second = await importWorkspace(bundle2, { base: 'trunk', config, layout });
    expect(second).toMatchObject({ imported: false, baseFastForwarded: true, head: hostHead2 });
    expect(gitSync(layout.repo, 'rev-parse', 'refs/heads/trunk')).toBe(hostHead2);
  });

  it('rejects bundles without the base branch', async () => {
    const root = tmp();
    const host = join(root, 'host');
    mkdirSync(host);
    initRepo(host, 'main');
    const b = join(root, 'b.bundle');
    gitSync(host, 'bundle', 'create', b, 'main');
    await expect(importWorkspace(b, { base: 'develop', config: defaults(), layout: workspaceLayout(join(root, 'ws')) }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
  });

  it('setup creates the state layout idempotently', async () => {
    const paths = runtimePaths({ MINIONS_STATE_DIR: join(tmp(), 'state') });
    const calls: string[] = [];
    const write = async (r: string) => { calls.push(r); return { path: join(r, 'backlog', 'config.yml'), changed: calls.length === 1 }; };
    const a = await setupState(paths, write);
    const b = await setupState(paths, write);
    for (const d of [paths.backlog, paths.notes, paths.import, paths.exports]) expect(existsSync(d)).toBe(true);
    expect(existsSync(paths.db)).toBe(true);
    expect(a.backlogConfig.changed).toBe(true);
    expect(b.backlogConfig.changed).toBe(false);
    expect(calls).toEqual([paths.backlog, paths.backlog]);
  });
});
