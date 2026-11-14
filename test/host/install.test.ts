import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitAll, fsStatus } from './fs-git.js';
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (cfg: { mode: string; execution: { maxEngineers: number } }, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await mkdir(j(outDir, 'agents'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'agents', 'engineer.md'), `mode ${cfg.mode} engineers ${cfg.execution.maxEngineers}\n`);
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
  runInit({ mode: 'independent', path, yes: true, dockerProbe: dockerUp, ...extra });

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
    const again = await runInit({ mode: 'independent', path: repo, configFile: cfgFile, dockerProbe: dockerUp });
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
    commitAll(repo, 'minions');
    // Fresh machine: empty MINIONS_HOME; the shared config pins the project id.
    rmSync(env.home, { recursive: true, force: true });
    const paths = projectPaths(first.plan.projectId);
    // runtime/ is a file, so writing runtime/config.json fails after earlier files were created.
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(join(paths.dir, 'runtime'), 'blocker');
    await expect(init(repo)).rejects.toThrow();
    expect(listFiles(paths.dir)).toEqual([join(paths.dir, 'runtime')]);
    expect(existsSync(join(env.home, 'registry.json'))).toBe(false);
    expect(fsStatus(repo).join('\n')).toBe('');
  });

  it('detects a copied shared identity and requires --attach or --new-identity', async () => {
    const a = makeRepo(env.root, 'a');
    const ra = await init(a, { visibility: 'shared' });
    commitAll(a, 'minions');
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
    const e = await failure(runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', dockerProbe: dockerDown }));
    expect(e.code).toBe('DOCKER_UNAVAILABLE');
    expect(e.message).toMatch(/never falls back to the host/);
    expect(existsSync(env.home)).toBe(false);
    // dry-run still works and reports it
    const dry = await runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', dockerProbe: dockerDown, dryRun: true });
    expect(dry.plan.warnings.join(' ')).toMatch(/Docker daemon is not reachable/);
    expect(existsSync(env.home)).toBe(false);
  });

  it('plan lists permissions, verification commands, unavailable capabilities and external setup', async () => {
    const repo = makeRepo(env.root);
    const r = await init(repo, { visibility: 'private', mode: 'supervised', dryRun: true });
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
    expect(u.volumesKept).toHaveLength(5);
    expect(runner).toHaveBeenCalledWith('docker', expect.arrayContaining(['down']), expect.anything());
    expect(JSON.stringify(runner.mock.calls)).not.toContain('"-v"');
    expect((await loadRegistry()).projects[r.plan.projectId]).toBeUndefined();
    expect(fsStatus(repo).join('\n')).toBe('');
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
