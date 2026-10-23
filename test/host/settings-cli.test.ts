// `minions settings --list --json` and `minions settings set <key> <value>` through the real program
// (commander wiring, --json envelopes, --yes, the `config list|set` aliases). Docker is faked as not running.
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  class Compose extends real.Compose { override async isRunning() { return false; } }
  return { ...real, Compose };
});

const { buildProgram } = await import('../../src/program.js');
const { runInit } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const C = await import('../../src/host/credentials.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');

const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
let env: ReturnType<typeof withHome>;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  env = withHome();
  prev = { store: process.env.MINIONS_CREDENTIAL_STORE, runtime: process.env.MINIONS_RUNTIME };
  process.env.MINIONS_CREDENTIAL_STORE = 'file';
  delete process.env.MINIONS_RUNTIME;
});
afterEach(() => {
  for (const [k, name] of [['store', 'MINIONS_CREDENTIAL_STORE'], ['runtime', 'MINIONS_RUNTIME']] as const) {
    if (prev[k] === undefined) delete process.env[name]; else process.env[name] = prev[k];
  }
  vi.restoreAllMocks();
  env.cleanup();
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

const envelope = (out: string) => JSON.parse(out.trim().split('\n').at(-1)!) as { ok: boolean; data?: any; error?: { code: string; message: string } };

async function install() {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  return { repo, projectId: r.plan.projectId, local: projectPaths(r.plan.projectId).configLocalJson };
}

describe('minions settings (CLI)', () => {
  it('--list --json: every setting with value and source; tokens only as provisioned/missing', async () => {
    const { repo, projectId } = await install();
    await C.provisionTelegramToken({ projectId, token: TOKEN, repoPath: repo, verify: false });
    const { out, code } = await cli(repo, ['settings', '--list', '--json']);
    expect(code).toBe(0);
    expect(out).not.toContain('AAHfake');
    const d = envelope(out).data as { settings: { key: string; value: unknown; source: string }[] };
    expect(d.settings.find((s) => s.key === 'execution.maxActiveTasks')).toMatchObject({ value: 2, source: 'project config' });
    expect(d.settings.find((s) => s.key === 'secrets.telegram')).toMatchObject({ value: 'provisioned' });
  });

  it('set --json: a loosening change is refused without --yes, applied with it; the config set alias works too', async () => {
    const { repo, local } = await install();
    const refused = await cli(repo, ['settings', 'set', 'execution.maxActiveTasks', '3', '--json']);
    expect(refused.code).not.toBe(0);
    expect(envelope(refused.out).error).toMatchObject({ code: 'POLICY_DENIED' });
    const ok = await cli(repo, ['settings', 'set', 'execution.maxActiveTasks', '3', '--yes', '--json']);
    expect(ok.code).toBe(0);
    expect(envelope(ok.out).data).toMatchObject({ key: 'execution.maxActiveTasks', from: 2, to: 3, layer: 'local', written: true });
    const alias = await cli(repo, ['config', 'set', 'execution.maxEngineers', '3', '--yes']);
    expect(alias.code).toBe(0);
    expect(alias.out).toContain('execution.maxEngineers: 2 -> 3');
    expect(JSON.parse(readFileSync(local, 'utf8'))).toEqual({ execution: { maxActiveTasks: 3, maxEngineers: 3 } });
    const list = await cli(repo, ['config', 'list']);
    expect(list.out).toContain('execution.maxEngineers = 3  (local override)');
    const show = await cli(repo, ['config', 'show', '--json']);
    expect(envelope(show.out).data.execution.maxEngineers).toBe(3);
  });

  it('set: a restart-needing change with the runtime down reports not-running; --shared is refused on a private install', async () => {
    const { repo } = await install();
    const r = await cli(repo, ['settings', 'set', 'communication.progress', 'tasks', '--json']);
    expect(envelope(r.out).data).toMatchObject({ written: true, needsRestart: true, restart: { action: 'not-running' } });
    const s = await cli(repo, ['settings', 'set', 'communication.progress', 'quiet', '--shared', '--json']);
    expect(envelope(s.out).error).toMatchObject({ code: 'PRECONDITION' });
  });

  it('without a terminal, plain `minions settings` points at --list / set', async () => {
    const { repo } = await install();
    const r = await cli(repo, ['settings']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/needs a terminal/);
  });
});
