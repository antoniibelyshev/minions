import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const { MinionsError } = await import('../../src/core/errors.js');
const { projectPaths, repoPaths } = await import('../../src/core/paths.js');
const { loadRegistry } = await import('../../src/host/registry.js');
const { runUninstall } = await import('../../src/host/uninstall.js');
const { dockerDown, dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const init = (path: string, extra: Partial<Parameters<typeof runInit>[0]> = {}) =>
  runInit({ path, yes: true, dockerProbe: dockerUp, ...extra });

async function failure(p: Promise<unknown>) {
  try { await p; } catch (e) { if (e instanceof MinionsError) return e; throw e; }
  throw new Error('expected MinionsError');
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('init', () => {
  it('is idempotent on rerun (no writes, same manifest)', async () => {
    const repo = makeRepo(env.root);
    const first = await init(repo, { visibility: 'private' });
    expect(first.applied!.written.length).toBeGreaterThan(4);
    const paths = projectPaths(first.plan.projectId);
    const manifest = readFileSync(paths.manifestJson, 'utf8');
    const mtime = statSync(paths.manifestJson).mtimeMs;
    const second = await init(repo);
    expect(second.plan.projectId).toBe(first.plan.projectId);
    expect(second.applied!.written).toEqual([]);
    expect(second.applied!.removed).toEqual([]);
    expect(second.plan.writes.every((w) => w.action === 'unchanged')).toBe(true);
    expect(readFileSync(paths.manifestJson, 'utf8')).toBe(manifest);
    expect(statSync(paths.manifestJson).mtimeMs).toBe(mtime);
    expect(existsSync(paths.journalJson)).toBe(false);
  });

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

  it('detects user-edited generated files (drift) and leaves them alone', async () => {
    const repo = makeRepo(env.root);
    const r = await init(repo, { visibility: 'private' });
    const paths = projectPaths(r.plan.projectId);
    const engineer = join(paths.pluginDir, 'agents', 'engineer.md');
    writeFileSync(engineer, 'user edit\n');
    // Regenerate with different config so the generated content would change.
    const cfg = JSON.parse(readFileSync(paths.configJson, 'utf8'));
    cfg.execution.maxEngineers = 1;
    const cfgFile = join(env.root, 'cfg.json');
    writeFileSync(cfgFile, JSON.stringify(cfg));
    const again = await runInit({ path: repo, configFile: cfgFile, dockerProbe: dockerUp });
    const w = again.plan.writes.find((x) => x.path === engineer)!;
    expect(w.action).toBe('drift');
    expect(again.applied!.skipped.map((s) => s.path)).toContain(engineer);
    expect(readFileSync(engineer, 'utf8')).toBe('user edit\n');
    expect(again.plan.writes.find((x) => x.path === paths.configJson)!.action).toBe('update');
    // Still reported on the next run.
    expect((await init(repo, { dryRun: true })).plan.writes.find((x) => x.path === engineer)!.action).toBe('drift');
  });

  it('never overwrites a non-manifest user file (CONFLICT) and rolls back nothing written', async () => {
    const repo = makeRepo(env.root);
    mkdirSync(join(repo, '.minions'));
    writeFileSync(join(repo, '.minions', 'README.md'), 'mine\n');
    const e = await failure(init(repo, { visibility: 'shared' }));
    expect(e.code).toBe('CONFLICT');
    expect(readFileSync(join(repo, '.minions', 'README.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(repo, '.minions', 'config.json'))).toBe(false);
    expect(Object.keys((await loadRegistry()).projects)).toEqual([]);
  });

  it('rolls back created files when apply fails midway', async () => {
    const repo = makeRepo(env.root);
    const first = await init(repo, { visibility: 'shared' });
    git(repo, 'add', '.minions'); git(repo, 'commit', '-q', '-m', 'minions');
    // Fresh machine: empty MINIONS_HOME; the shared config pins the project id.
    rmSync(env.home, { recursive: true, force: true });
    const paths = projectPaths(first.plan.projectId);
    // runtime/ is a file, so writing runtime/config.json fails after earlier files were created.
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(join(paths.dir, 'runtime'), 'blocker');
    await expect(init(repo)).rejects.toThrow();
    expect(listFiles(paths.dir)).toEqual([join(paths.dir, 'runtime')]);
    expect(existsSync(join(env.home, 'registry.json'))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
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

  it('detects a copied shared identity and requires --attach or --new-identity', async () => {
    const a = makeRepo(env.root, 'a');
    const ra = await init(a, { visibility: 'shared' });
    git(a, 'add', '.minions'); git(a, 'commit', '-q', '-m', 'minions');
    const b = join(env.root, 'b');
    cpSync(a, b, { recursive: true });
    const e = await failure(init(b));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toMatch(/copied project identity/);
    expect(e.hint).toMatch(/--attach/);
    expect(e.hint).toMatch(/--new-identity/);
    const rb = await init(b, { newIdentity: true });
    expect(rb.plan.projectId).not.toBe(ra.plan.projectId);
    expect(JSON.parse(readFileSync(repoPaths(b).configJson, 'utf8')).projectId).toBe(rb.plan.projectId);
    expect(JSON.parse(readFileSync(repoPaths(a).configJson, 'utf8')).projectId).toBe(ra.plan.projectId);
    expect(Object.keys((await loadRegistry()).projects).sort()).toEqual([ra.plan.projectId, rb.plan.projectId].sort());
  });

  it('--attach rebinds a moved clone to its existing project', async () => {
    const a = makeRepo(env.root, 'a');
    const ra = await init(a, { visibility: 'shared' });
    const b = join(env.root, 'moved');
    cpSync(a, b, { recursive: true });
    const rb = await init(b, { attach: true });
    expect(rb.plan.projectId).toBe(ra.plan.projectId);
    expect((await loadRegistry()).projects[ra.plan.projectId]!.repoPath).toBe(b);
  });

  it('fails with DOCKER_UNAVAILABLE and writes nothing when Docker is down', async () => {
    const repo = makeRepo(env.root);
    const e = await failure(runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerDown }));
    expect(e.code).toBe('DOCKER_UNAVAILABLE');
    expect(e.message).toMatch(/no host fallback/);
    expect(existsSync(env.home)).toBe(false);
    // dry-run still works and reports it
    const dry = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerDown, dryRun: true });
    expect(dry.plan.warnings.join(' ')).toMatch(/Docker daemon is not reachable/);
    expect(existsSync(env.home)).toBe(false);
  });

  it('plan lists permissions, verification commands, unavailable capabilities and external setup', async () => {
    const repo = makeRepo(env.root);
    const r = await init(repo, { visibility: 'private', profile: 'personal-work', dryRun: true });
    expect(r.plan.verificationCommands).toEqual(['npm run lint', 'npm test']);
    expect(r.plan.permissions.deny).toContain('deploy.execute');
    expect(r.plan.unavailable.features).not.toContain('Telegram');
    expect(r.plan.externalSetup.join('\n')).toMatch(/\/login/);
    expect(r.plan.writes.every((w) => w.action === 'create')).toBe(true);
  });

  it('generated files contain no secrets', async () => {
    const repo = makeRepo(env.root);
    const secret = 'sk-ant-api03-SECRETSECRETSECRET1234567890';
    writeFileSync(join(repo, '.env'), `ANTHROPIC_API_KEY=${secret}\n`);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = secret;
    try {
      const r = await init(repo, { visibility: 'shared' });
      const files = [...listFiles(projectPaths(r.plan.projectId).dir), ...listFiles(repoPaths(repo).dir), join(env.home, 'registry.json')];
      expect(files.length).toBeGreaterThan(5);
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        expect(text, f).not.toContain(secret);
        expect(text, f).not.toMatch(/sk-ant-|ghp_|github_pat_|ANTHROPIC_API_KEY|BEGIN [A-Z ]*PRIVATE KEY/);
      }
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('uninstall removes only unchanged manifest files and the registry entry', async () => {
    const repo = makeRepo(env.root);
    const r = await init(repo, { visibility: 'private' });
    const paths = projectPaths(r.plan.projectId);
    writeFileSync(paths.configJson, readFileSync(paths.configJson, 'utf8') + ' ');
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const u = await runUninstall({ cwd: repo, runner });
    expect(u.kept.map((k) => k.path)).toEqual([paths.configJson]);
    expect(existsSync(paths.composeYaml)).toBe(false);
    expect(existsSync(paths.configJson)).toBe(true);
    expect(u.volumesKept).toHaveLength(4);
    expect(runner).toHaveBeenCalledWith('docker', expect.arrayContaining(['down']), expect.anything());
    expect(JSON.stringify(runner.mock.calls)).not.toContain('"-v"');
    expect((await loadRegistry()).projects[r.plan.projectId]).toBeUndefined();
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('uninstall --delete-data requires confirmation', async () => {
    const repo = makeRepo(env.root);
    await init(repo, { visibility: 'private' });
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const e = await failure(runUninstall({ cwd: repo, deleteData: true, runner, confirm: async () => false }));
    expect(e.code).toBe('PRECONDITION');
    expect(runner).not.toHaveBeenCalled();
    await runUninstall({ cwd: repo, deleteData: true, yes: true, runner });
    expect(runner).toHaveBeenCalledWith('docker', expect.arrayContaining(['down', '-v']), expect.anything());
  });
});


describe('CI setup guidance', () => {
  it('prints an external CI setup plan for a GitHub repo without CI and writes no workflow files', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const r = await init(repo, { visibility: 'shared' });
    const setup = r.plan.externalSetup.join('\n');
    expect(setup).toMatch(/never creates workflows or changes branch protection/);
    expect(setup).toMatch(/Add a CI workflow yourself/);
    expect(setup).toContain('https://github.com/acme/demo/settings/branches');
    expect(setup).toMatch(/Require status checks to pass/);
    expect(existsSync(join(repo, '.github'))).toBe(false);
    expect(listFiles(repo).some((f) => f.includes('.github'))).toBe(false);
  });

  it('with existing workflows only explains how to require the checks; no plan without a GitHub remote', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    const wf = join(repo, '.github', 'workflows', 'ci.yml');
    writeFileSync(wf, 'name: ci\n');
    const r = await init(repo, { visibility: 'private' });
    const setup = r.plan.externalSetup.join('\n');
    expect(setup).not.toMatch(/Add a CI workflow yourself/);
    expect(setup).toMatch(/Mark the check required for/);
    expect(readFileSync(wf, 'utf8')).toBe('name: ci\n');
    expect(readdirSync(join(repo, '.github', 'workflows'))).toEqual(['ci.yml']);

    const plain = makeRepo(env.root, 'plain');
    expect((await init(plain, { visibility: 'private' })).plan.externalSetup.join('\n')).not.toMatch(/CI setup/);
  });
});
