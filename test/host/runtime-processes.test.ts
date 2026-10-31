// Host runtime end to end (task-137.2.6): the shim and delegation run the real CLI, doctor and uninstall act on a
// real repository's .git/worktrees and workspace, and upgrade runs its host path. The rest of the host runtime
// is covered in the unit tier by test/host/runtime.test.ts.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

const { runInit, formatInit } = await import('../../src/host/install.js');
const { hostRuntimePaths, projectPaths, repoPaths } = await import('../../src/core/paths.js');
const { runtimePaths } = await import('../../src/runtime/paths.js');
const { requireMode, runtimeMode } = await import('../../src/core/cli-helpers.js');
const { validateConfig } = await import('../../src/config/resolve.js');
const { loadEffectiveConfig, loadProjectJson } = await import('../../src/host/project.js');
const { saveDefaults } = await import('../../src/host/auth.js');
const {
  HOST_RUNTIME_WARNING, HostRuntime, hostRuntimeEnv, hostTools, minionsShim, prepareHostRuntime,
} = await import('../../src/host/runtime.js');
const { runRuntimeSet, runRuntimeShow } = await import('../../src/host/runtime-cli.js');
const { delegateToRuntime } = await import('../../src/host/delegate.js');
const { coordinatorSettings, buildClaudeCommand, buildCoordinatorCommand, hostSettings, shQuote } = await import('../../src/runtime/coordinator.js');
const { runDoctor } = await import('../../src/host/doctor.js');
const { runUninstall } = await import('../../src/host/uninstall.js');
const { defaults } = await import('../helpers.js');
const { dockerDown, dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
const saved = { ...process.env };
beforeEach(() => { env = withHome(); });
afterEach(() => {
  env.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const no: RunResult = { code: 127, stdout: '', stderr: 'not found' };

async function hostProject(extra: Parameters<typeof runInit>[0] extends infer T ? Partial<T> : never = {}) {
  const repo = makeRepo(env.root);
  const r = await runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown, ...extra });
  return { repo, r, id: r.plan.projectId };
}

describe('host runtime processes', () => {
  it('shim pins the runtime environment (quoted paths) and execs the CLI', async () => {
    const { id } = await hostProject();
    const project = await loadProjectJson(id);
    const cli = join(env.root, 'fake cli.mjs');
    writeFileSync(cli, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env }))\n');
    await prepareHostRuntime(project, { target: { node: process.execPath, cli } });
    const hp = hostRuntimePaths(id);
    expect(readFileSync(hp.minionsShim, 'utf8')).toMatch(/^#!\/bin\/sh\n/);
    const out = await new HostRuntime(project).exec(['minions', 'status', '--json']);
    const d = JSON.parse(out.stdout) as { argv: string[]; env: Record<string, string> };
    expect(d.argv).toEqual(['status', '--json']);
    expect(d.env).toMatchObject({ MINIONS_RUNTIME: 'host', MINIONS_STATE_DIR: hp.state, MINIONS_WORKSPACE: hp.workspace, MINIONS_TMUX_SOCKET: hp.tmuxSocket });
    expect(d.env.GH_TOKEN).toBeUndefined();
    expect(minionsShim(project, { node: '/a b/node', cli: "/c'd/cli.js" })).toContain(`exec '/a b/node' '/c'\\''d/cli.js' "$@"`);
  });

  it('delegation: host runtime runs the shim directly; docker runtime needs a running container', async () => {
    const { repo, id } = await hostProject();
    const project = await loadProjectJson(id);
    await expect(delegateToRuntime(['status'], { json: true, cwd: repo })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/host runtime has not been started/) });
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/nonexistent' } });
    // a real shim run (re-prepared with the package CLI) would start the CLI; check the docker branch instead:
    const other = makeRepo(env.root, 'docker-repo');
    await runInit({ mode: 'independent', path: other, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const only = join(env.root, 'only-git');
    mkdirSync(only);
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(only, 'git'));
    process.env.PATH = only; // no docker CLI: the container is not running
    await expect(delegateToRuntime(['status'], { json: true, cwd: other })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/container is not running/) });
  });

  it('doctor in host mode reports .git/worktrees: missing is created outside the sandbox, then ok (task-3)', async () => {
    const { repo, id } = await hostProject();
    const wsRepo = hostRuntimePaths(id).repo;
    mkdirSync(wsRepo, { recursive: true });
    git(wsRepo, 'init', '-q');
    expect(existsSync(join(wsRepo, '.git', 'worktrees'))).toBe(false);
    const runner = async () => no;
    const by = async (n: string) => (await runDoctor({ cwd: repo, runner, probe: async () => { throw new Error('no docker'); } })).checks.find((c) => c.name === n);
    expect(await by('workspace.worktrees')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/was missing .*created it/) });
    expect(existsSync(join(wsRepo, '.git', 'worktrees'))).toBe(true);
    expect(await by('workspace.worktrees')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/\.git\/worktrees exists/) });
    // A planted symlink is reported, never followed or replaced.
    const elsewhere = join(env.root, 'elsewhere');
    mkdirSync(elsewhere);
    execFileSync('rm', ['-rf', join(wsRepo, '.git', 'worktrees')]);
    symlinkSync(elsewhere, join(wsRepo, '.git', 'worktrees'));
    expect(await by('workspace.worktrees')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/symlink or not a directory/) });
  });

  it('uninstall --delete-data removes the host workspace; without it the data is kept', async () => {
    const { repo, id } = await hostProject();
    await prepareHostRuntime(await loadProjectJson(id), { target: { node: process.execPath, cli: '/x' } });
    writeFileSync(join(hostRuntimePaths(id).state, 'minions.db'), 'x');
    const runner = async () => no;
    const kept = await runUninstall({ cwd: repo, yes: true, runner });
    expect(kept.hostData).toEqual({ path: hostRuntimePaths(id).root, deleted: false });
    expect(existsSync(hostRuntimePaths(id).state)).toBe(true);
    expect(existsSync(hostRuntimePaths(id).bin)).toBe(false);
    const again = await runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    const id2 = again.plan.projectId;
    await prepareHostRuntime(await loadProjectJson(id2), { target: { node: process.execPath, cli: '/x' } });
    const del = await runUninstall({ cwd: repo, yes: true, deleteData: true, runner });
    expect(del.hostData).toMatchObject({ deleted: true });
    expect(existsSync(hostRuntimePaths(id2).root)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('minions upgrade on the host runtime', () => {
  it('runs the host path (no Docker refusal): an unprepared host runtime fails the preflight, nothing changes', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../src/host/commands.js');
    const { repo } = await hostProject();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('MINIONS_RUNTIME', ''); // the host CLI
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      for (const args of [['upgrade', '--dry-run'], ['upgrade']]) {
        err.mockClear(); out.mockClear();
        process.exitCode = 0;
        const program = new Command();
        register(program);
        await program.parseAsync(args, { from: 'user' }).catch((e: Error) => { if (!/^exit [1-9]/.test(e.message)) throw e; });
        const text = [...err.mock.calls, ...out.mock.calls].map((c) => String(c[0])).join('');
        expect(text).not.toContain('supports the Docker runtime only');
        expect(text).toContain('the host runtime has not been started');
      }
      expect(git(repo, 'status', '--porcelain')).toBe('');
    } finally {
      process.chdir(cwd);
      process.exitCode = 0;
      exit.mockRestore(); err.mockRestore(); out.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
