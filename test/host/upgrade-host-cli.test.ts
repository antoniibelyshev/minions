// `minions upgrade --from-container` on the host runtime through the real program (task-7): a CLI inside the
// agent-writable host dirs is refused before anything is touched, the shim included. packageRoot is faked to put
// the running CLI inside the workspace; nothing is installed, exported or started for real.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';

const fake = vi.hoisted(() => ({ root: null as string | null }));
vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      return [];
    },
  };
});
vi.mock('../../src/host/docker.js', async (orig) => {
  const real = await orig<typeof import('../../src/host/docker.js')>();
  return { ...real, packageRoot: (from?: string) => fake.root ?? real.packageRoot(from) };
});
vi.mock('../../src/runtime/paths.js', async (orig) => ({ ...await orig<typeof import('../../src/runtime/paths.js')>(), inMinionsContainer: () => false }));

const { buildProgram } = await import('../../src/program.js');
const { hostRuntimePaths } = await import('../../src/core/paths.js');
const { runInit } = await import('../../src/host/install.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const { prepareHostRuntime } = await import('../../src/host/runtime.js');
const { dockerDown, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
const saved = { ...process.env };
beforeEach(() => {
  env = withHome();
  process.env.MINIONS_CREDENTIAL_STORE = 'file';
  delete process.env.MINIONS_RUNTIME;
});
afterEach(() => {
  fake.root = null;
  vi.restoreAllMocks();
  env.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

async function cli(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const program = buildProgram();
  let out = '';
  const capture = (cmd: Command) => { cmd.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } }); cmd.commands.forEach(capture); };
  capture(program);
  const w = process.stdout.write.bind(process.stdout), we = process.stderr.write.bind(process.stderr), exit = process.exit.bind(process);
  const sink = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  process.stdout.write = sink; process.stderr.write = sink;
  process.exit = ((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as typeof process.exit;
  const before = process.exitCode;
  let code = 0;
  try { await program.parseAsync(['node', 'minions', ...args]); code = process.exitCode === before ? 0 : Number(process.exitCode); }
  catch (e) { code = (e as { exitCode?: number }).exitCode ?? 1; }
  finally { process.stdout.write = w; process.stderr.write = we; process.exit = exit; process.exitCode = before; }
  return { out, code };
}
const envelope = (out: string) => JSON.parse(out.trim().split('\n').at(-1)!) as { ok: boolean; error?: { code: string; message: string } };
const ok = (): RunResult => ({ code: 0, stdout: '', stderr: '' });

describe('minions upgrade --from-container on the host runtime (CLI)', () => {
  it('refuses a CLI inside the agent-writable workspace before touching the shim', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    const id = r.plan.projectId;
    const project = await loadProjectJson(id);
    const hp = hostRuntimePaths(id);
    // A started host runtime whose shim runs a safe CLI outside the host dirs.
    const safeCli = join(env.root, 'installed', 'node_modules', 'minions', 'dist', 'cli.js');
    mkdirSync(join(safeCli, '..'), { recursive: true });
    writeFileSync(safeCli, '');
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: safeCli }, runner: async () => ok() });
    const shimBefore = readFileSync(hp.minionsShim, 'utf8');
    const mtimeBefore = statSync(hp.minionsShim).mtimeMs;
    expect(shimBefore).toContain(safeCli);

    // The running CLI is a copy inside the agent-writable workspace.
    fake.root = join(hp.workspace, 'evil', 'node_modules', 'minions');
    mkdirSync(join(fake.root, 'dist'), { recursive: true });
    writeFileSync(join(fake.root, 'dist', 'cli.js'), '');
    writeFileSync(join(fake.root, 'package.json'), JSON.stringify({ name: 'minions' }));

    const { out, code } = await cli(repo, ['--json', 'upgrade', '--from-container']);
    expect(code).not.toBe(0);
    const e = envelope(out);
    expect(e.ok).toBe(false);
    expect(e.error).toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/^Upgrade not started: the CLI the shims would run .* is inside the agent-writable/) });
    expect(readFileSync(hp.minionsShim, 'utf8')).toBe(shimBefore);
    expect(statSync(hp.minionsShim).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(hp.minionsShim, 'utf8')).not.toContain(join(fake.root, 'dist', 'cli.js'));
  });

  it('prepareHostRuntime refuses a shim target inside the agent-writable dirs and leaves the shim as it was', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    const project = await loadProjectJson(r.plan.projectId);
    const hp = hostRuntimePaths(project.projectId);
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/opt/minions/dist/cli.js' }, runner: async () => ok() });
    const before = readFileSync(hp.minionsShim, 'utf8');
    for (const dir of [hp.workspace, hp.state]) {
      const cli = join(dir, 'm', 'dist', 'cli.js');
      await expect(prepareHostRuntime(project, { target: { node: process.execPath, cli }, runner: async () => ok() }))
        .rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/Refusing to point the host runtime shim at .* agent-writable/) });
      expect(readFileSync(hp.minionsShim, 'utf8')).toBe(before);
    }
  });
});
