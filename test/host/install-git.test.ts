// End-to-end `minions init` against real git (task-137.2.6): what git itself reports after init (status with
// dirty, untracked and ignored files) and how real linked worktrees map to one project. The rest of init is
// covered in the unit tier by test/host/install.test.ts, which answers init's git queries from the files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (cfg: { profile: string; execution: { maxEngineers: number } }, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await mkdir(j(outDir, 'agents'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'agents', 'engineer.md'), `profile ${cfg.profile} engineers ${cfg.execution.maxEngineers}\n`);
      await writeFile(j(outDir, 'coordinator.md'), 'coordinator\n');
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { projectPaths, repoPaths } = await import('../../src/core/paths.js');
const { loadRegistry } = await import('../../src/host/registry.js');
const { dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const init = (path: string, extra: Partial<Parameters<typeof runInit>[0]> = {}) =>
  runInit({ path, yes: true, dockerProbe: dockerUp, ...extra });

describe('init against real git', () => {
  it('private init leaves git status unchanged, including dirty files', async () => {
    const repo = makeRepo(env.root);
    writeFileSync(join(repo, 'README.md'), '# edited\n');
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n');
    const before = git(repo, 'status', '--porcelain', '--ignored');
    const r = await init(repo, { visibility: 'private' });
    expect(git(repo, 'status', '--porcelain', '--ignored')).toBe(before);
    expect(r.plan.writes.some((w) => w.inRepo)).toBe(false);
    expect(existsSync(repoPaths(repo).dir)).toBe(false);
    const paths = projectPaths(r.plan.projectId);
    for (const p of [paths.projectJson, paths.configJson, paths.composeYaml, paths.runtimeConfigJson, join(paths.pluginDir, 'coordinator.md')]) {
      expect(existsSync(p), p).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(paths.manifestJson, 'utf8'));
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain(join(paths.pluginDir, 'agents', 'engineer.md'));
  });

  it('shared init preserves CLAUDE.md, agent config and dirty files; writes only .minions/', async () => {
    const repo = makeRepo(env.root);
    writeFileSync(join(repo, 'CLAUDE.md'), 'my instructions\n');
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"x":1}\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'claude');
    writeFileSync(join(repo, 'CLAUDE.md'), 'my instructions\nlocal edit\n');
    writeFileSync(join(repo, 'wip.txt'), 'wip\n');
    const r = await init(repo, { visibility: 'shared' });
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe('my instructions\nlocal edit\n');
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe('{"x":1}\n');
    expect(readFileSync(join(repo, 'wip.txt'), 'utf8')).toBe('wip\n');
    const status = git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').map((l) => l.trim()).sort();
    expect(status).toEqual(['?? .minions/README.md', '?? .minions/config.json', '?? wip.txt', 'M CLAUDE.md']);
    const shared = JSON.parse(readFileSync(repoPaths(repo).configJson, 'utf8'));
    expect(shared.projectId).toBe(r.plan.projectId);
    expect(shared.visibility).toBe('shared');
    expect(shared.git.identity).toBeUndefined(); // personal identity stays on the host
    const eff = JSON.parse(readFileSync(projectPaths(r.plan.projectId).runtimeConfigJson, 'utf8'));
    expect(eff.git.identity).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect((await init(repo)).applied!.written).toEqual([]);
  });

  it('two worktrees of one repository map to the same project', async () => {
    const repo = makeRepo(env.root);
    const a = await init(repo, { visibility: 'private' });
    const wt = join(env.root, 'wt');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feature');
    const b = await init(wt);
    expect(b.plan.projectId).toBe(a.plan.projectId);
    expect(b.plan.identitySource).toBe('registry');
    expect(Object.keys((await loadRegistry()).projects)).toEqual([a.plan.projectId]);
    expect(b.applied!.written).toEqual([]);
  });
});
