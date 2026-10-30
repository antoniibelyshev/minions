// task-3: on the macOS host runtime the coordinator sandbox cannot create <repo>/.git/worktrees (the Edit deny of
// .git/worktrees/*/config.worktree becomes a sandbox write deny that also refuses its missing ancestors), so every
// `minions work claim` failed. The host CLI now creates the directory outside the sandbox, the sandboxed claim fails
// with a clear hint when it is gone, and the protection of config.worktree, .git/config and .git/hooks stays.
// No real claude or sandbox: the generated settings are checked, and local temp repos only.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), 'coordinator\n');
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { hostRuntimePaths } = await import('../../src/core/paths.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const { HostRuntime, ensureHostWorktreesDir, hostWorktreesDirState, prepareHostRuntime } = await import('../../src/host/runtime.js');
const { hostSettings } = await import('../../src/runtime/coordinator.js');
const { ensureBranchWorktree, ensureGitWorktreesDir, ensureReviewWorktree, workspaceLayout } = await import('../../src/runtime/worktree.js');
const { dockerDown, git, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
const saved = { ...process.env };
beforeEach(() => { env = withHome(); });
afterEach(() => {
  env.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

/** Claude Code permission-rule path glob -> RegExp: `**` any depth, `*` one segment. */
const ruleRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);

describe('generated host settings: git control files stay unwritable, .git/worktrees/<name>/ does not', () => {
  const ws = '/Users/u/Library/Application Support/Minions/projects/p1/host/workspace';
  const h = {
    home: '/Users/u', hostRoot: '/Users/u/Library/Application Support/Minions', projectDir: '/Users/u/Library/Application Support/Minions/projects/p1',
    workspace: ws, state: '/Users/u/Library/Application Support/Minions/projects/p1/host/state',
    secretsDir: '/Users/u/Library/Application Support/Minions/projects/p1/secrets', credentialsDir: '/Users/u/Library/Application Support/Minions/credentials',
  };
  const s = hostSettings(h);
  const fsSettings = s.sandbox.filesystem as { allowWrite: string[]; denyWrite: string[] };
  // Edit rules as absolute path globs (`//abs` -> `/abs`).
  const editGlobs = s.deny.filter((d) => d.startsWith('Edit(//')).map((d) => d.slice('Edit(/'.length, -1));
  const editDenied = (p: string) => editGlobs.some((g) => ruleRegex(g).test(p));
  const writeDenied = (p: string) => fsSettings.denyWrite.some((d) => p === d || p.startsWith(`${d}/`)) || editDenied(p);
  const git = `${ws}/repo/.git`;

  it('config.worktree (main and linked worktrees), .git/config and .git/hooks are write-denied', () => {
    expect(fsSettings.allowWrite).toContain(ws);
    for (const p of [`${git}/config`, `${git}/config.worktree`, `${git}/hooks/pre-commit`, `${git}/hooks/sub/x`,
      `${git}/worktrees/task-1-x/config.worktree`, `${git}/worktrees/review-x/config.worktree`]) expect(writeDenied(p), p).toBe(true);
    expect(fsSettings.denyWrite).toEqual(expect.arrayContaining([`${git}/config`, `${git}/hooks`]));
    expect(s.deny).toContain(`Edit(/${git}/worktrees/*/config.worktree)`);
  });

  it('git worktree add can write .git/worktrees/<name>/ and its admin files (only config.worktree matches)', () => {
    for (const p of [`${git}/worktrees`, `${git}/worktrees/task-1-x`, `${git}/worktrees/task-1-x/HEAD`, `${git}/worktrees/task-1-x/gitdir`,
      `${git}/worktrees/task-1-x/commondir`, `${git}/worktrees/task-1-x/index`, `${git}/worktrees/task-1-x/logs/HEAD`,
      `${git}/objects/ab/cdef`, `${git}/refs/heads/agent/x`, `${ws}/worktrees/task-1-x/src/a.ts`]) expect(writeDenied(p), p).toBe(false);
    // No rule names .git/worktrees itself or everything under it (that would block every worker worktree).
    expect(s.deny.some((d) => /\/\.git\/worktrees(\/\*\*)?\)$/.test(d))).toBe(false);
    expect(fsSettings.denyWrite.some((d) => d.includes('.git/worktrees'))).toBe(false);
  });
});

describe('ensureHostWorktreesDir (host CLI, outside the sandbox)', () => {
  it('no repo yet: nothing created; a fresh clone gets .git/worktrees; idempotent', async () => {
    const repo = join(env.root, 'ws', 'repo');
    expect(await ensureHostWorktreesDir(repo)).toBe('no-repo');
    expect(existsSync(repo)).toBe(false);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    expect(await hostWorktreesDirState(repo)).toBe('missing');
    expect(await ensureHostWorktreesDir(repo)).toBe('ok');
    expect(lstatSync(join(repo, '.git', 'worktrees')).isDirectory()).toBe(true);
    expect(await ensureHostWorktreesDir(repo)).toBe('ok');
  });

  it('never follows a symlinked .git or .git/worktrees', async () => {
    const target = join(env.root, 'target');
    mkdirSync(target);
    const repo = join(env.root, 'repo');
    mkdirSync(repo);
    symlinkSync(target, join(repo, '.git'));
    expect(await ensureHostWorktreesDir(repo)).toBe('invalid');
    expect(existsSync(join(target, 'worktrees'))).toBe(false);
    const repo2 = join(env.root, 'repo2');
    mkdirSync(join(repo2, '.git'), { recursive: true });
    symlinkSync(target, join(repo2, '.git', 'worktrees'));
    expect(await ensureHostWorktreesDir(repo2)).toBe('invalid');
  });

  it('prepareHostRuntime (every start/restart) and the transfer target (first import) create it', async () => {
    const path = makeRepo(env.root);
    const r = await runInit({ path, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    const project = await loadProjectJson(r.plan.projectId);
    const hp = hostRuntimePaths(project.projectId);
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/x' }, runner: async () => ok() });
    expect(existsSync(hp.repo)).toBe(false); // nothing invented before the clone
    // The first `workspace import` (a fake here) clones the repo: the transfer exec creates .git/worktrees after it.
    const runner = async () => { mkdirSync(hp.repo, { recursive: true }); git(hp.repo, 'init', '-q'); return ok('{"ok":true,"data":{}}'); };
    await new HostRuntime(project, runner).transferTarget().exec(['minions', 'workspace', 'import', 'x.bundle', '--json']);
    expect(lstatSync(join(hp.repo, '.git', 'worktrees')).isDirectory()).toBe(true);
    // git removes an empty .git/worktrees (last worktree removed / pruned): the next start recreates it.
    rmSync(join(hp.repo, '.git', 'worktrees'), { recursive: true });
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/x' }, runner: async () => ok() });
    expect(lstatSync(join(hp.repo, '.git', 'worktrees')).isDirectory()).toBe(true);
  });
});

describe('claim worktrees (engineer and review) with .git/worktrees', () => {
  const seeded = () => {
    const root = join(env.root, 'workspace');
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return workspaceLayout(root);
  };

  it('engineer and review worktrees are created when .git/worktrees was pre-created (and when git may create it)', async () => {
    const layout = seeded();
    expect(await ensureHostWorktreesDir(layout.repo)).toBe('ok');
    const b = await ensureBranchWorktree(layout, 'task-1-x', 'main');
    expect(existsSync(join(b.worktree, 'a.txt'))).toBe(true);
    const r = await ensureReviewWorktree(layout, 'task-1-x', b.head);
    expect(existsSync(join(r.worktree, 'a.txt'))).toBe(true);
    expect(existsSync(join(layout.repo, '.git', 'worktrees', 'task-1-x'))).toBe(true);
  });

  it('host runtime: a claim with no .git/worktrees (fresh clone, or pruned after the last worktree) creates it, then engineer and review worktrees', async () => {
    const layout = seeded();
    expect(await hostWorktreesDirState(layout.repo)).toBe('missing');
    process.env.MINIONS_RUNTIME = 'host';
    const b = await ensureBranchWorktree(layout, 'task-2-y', 'main');
    const r = await ensureReviewWorktree(layout, 'task-2-y', b.head);
    expect(existsSync(join(b.worktree, 'a.txt'))).toBe(true);
    expect(existsSync(join(r.worktree, 'a.txt'))).toBe(true);
    // git drops the empty .git/worktrees when the last worktree goes; the next claim recreates it.
    git(layout.repo, 'worktree', 'remove', r.worktree);
    git(layout.repo, 'worktree', 'remove', b.worktree);
    expect(await hostWorktreesDirState(layout.repo)).toBe('missing');
    const again = await ensureBranchWorktree(layout, 'task-2-y', 'main');
    expect(again.created).toBe(true);
    expect(await hostWorktreesDirState(layout.repo)).toBe('ok');
  });

  it.skipIf(process.getuid?.() === 0)('host runtime: a .git/worktrees the sandbox cannot create fails with a clear hint, not git\'s error', async () => {
    const layout = seeded();
    const gitDir = join(layout.repo, '.git');
    chmodSync(gitDir, 0o555); // stands in for the sandbox write deny of the missing ancestor
    try {
      process.env.MINIONS_RUNTIME = 'host';
      await expect(ensureGitWorktreesDir(layout.repo)).rejects.toMatchObject({ code: 'PRECONDITION', hint: expect.stringMatching(/minions start --no-attach/) });
      delete process.env.MINIONS_RUNTIME;
      await expect(ensureGitWorktreesDir(layout.repo)).resolves.toBeUndefined(); // container: git reports it
    } finally { chmodSync(gitDir, 0o755); }
    await ensureGitWorktreesDir(layout.repo);
    expect(existsSync(join(gitDir, 'worktrees'))).toBe(true);
    execFileSync('git', ['-C', layout.repo, 'status'], { stdio: 'ignore' });
  });
});
