// `minions settings --list --json` and `minions settings set <key> <value>` through the real program
// (commander wiring, --json envelopes, --yes, the `config list|set` aliases). Docker is faked as not running.
import { existsSync, readFileSync } from 'node:fs';
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
// This suite runs the host CLI; the dev container it may run in has /opt/minions/config (the container marker).
vi.mock('../../src/runtime/paths.js', async (orig) => ({ ...await orig<typeof import('../../src/runtime/paths.js')>(), inMinionsContainer: () => false }));

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

  it('without a terminal, plain `minions settings` opens the menu (numbered prompts), not a refusal; --list never opens it', async () => {
    const { repo } = await install();
    const { Command } = await import('commander');
    const { registerSettings } = await import('../../src/host/settings-cli.js');
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    try {
      const opened: { layer: string }[] = [];
      const program = new Command().option('--json');
      registerSettings(program, { confirm: async () => null, menu: async (_p, o) => { opened.push(o); } });
      program.exitOverride();
      await program.parseAsync(['node', 'minions', 'settings']);
      expect(opened).toEqual([{ layer: 'local' }]);
      const w = process.stdout.write.bind(process.stdout);
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try { await program.parseAsync(['node', 'minions', 'settings', '--list']); } finally { process.stdout.write = w; }
      expect(opened).toHaveLength(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('settings --list / --list --json and set errors never contain a stored token', async () => {
    const { repo, projectId } = await install();
    await C.provisionTelegramToken({ projectId, token: TOKEN, repoPath: repo, verify: false });
    const outs = [
      await cli(repo, ['settings', '--list']),
      await cli(repo, ['settings', '--list', '--json']),
      await cli(repo, ['config', 'list']),
      await cli(repo, ['settings', 'set', 'secrets.telegram', TOKEN]),
      await cli(repo, ['settings', 'set', 'secrets.telegram', TOKEN, '--json']),
    ];
    expect(outs[0]!.out).toMatch(/secrets\.telegram = provisioned/);
    expect(outs[3]!.code).not.toBe(0);
    for (const { out } of outs) {
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain('AAHfake');
    }
  });

  it('set: the reverse order (maxEngineers before maxActiveTasks) fails with a clear message and writes nothing', async () => {
    const { repo, local } = await install();
    const r = await cli(repo, ['settings', 'set', 'execution.maxEngineers', '3', '--yes', '--json']);
    expect(r.code).not.toBe(0);
    const err = envelope(r.out).error!;
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toMatch(/maxEngineers/);
    expect(err.message).toMatch(/maxActiveTasks/);
    const human = await cli(repo, ['settings', 'set', 'execution.maxEngineers', '3', '--yes']);
    expect(human.code).not.toBe(0);
    expect(human.out).toMatch(/maxEngineers[\s\S]*maxActiveTasks/);
    expect(existsSync(local)).toBe(false);
  });

  it('set without --yes and without a terminal (human output): a loosening change is refused with a hint to pass --yes', async () => {
    const { repo, local } = await install();
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    try {
      const r = await cli(repo, ['settings', 'set', 'execution.maxActiveTasks', '3']);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/loosens policy/);
      expect(r.out).toMatch(/--yes/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
    expect(existsSync(local)).toBe(false);
  });
});

describe('settings set: what took effect now vs needs a restart or an upgrade (task-53.2)', () => {
  it('--json reports class, hostOwned and takesEffect for live, restart and host-owned keys; --list --json carries the new fields', async () => {
    const { repo } = await install();
    const live = envelope((await cli(repo, ['settings', 'set', 'execution.maxActiveTasks', '3', '--yes', '--json'])).out);
    expect(live.ok).toBe(true);
    expect(live.data).toMatchObject({ key: 'execution.maxActiveTasks', class: 'live', hostOwned: false, takesEffect: 'now',
      needsRestart: false, needsUpgrade: false, restart: null, written: true });
    expect(live.data.effect).toMatch(/^takes effect now: the runtime reads the regenerated config on its next command/);

    const restart = envelope((await cli(repo, ['settings', 'set', 'communication.progress', 'quiet', '--no-restart', '--json'])).out);
    expect(restart.data).toMatchObject({ class: 'restart', hostOwned: false, takesEffect: 'restart', needsRestart: true, needsUpgrade: false,
      restart: { action: 'offered' } });
    expect(restart.data.effect).toMatch(/after a coordinator restart/);

    const owned = envelope((await cli(repo, ['settings', 'set', 'capabilities.git.push', 'deny', '--no-restart', '--json'])).out);
    expect(owned.data).toMatchObject({ class: 'restart', hostOwned: true, takesEffect: 'restart' });

    // Unchanged: nothing takes effect.
    const same = envelope((await cli(repo, ['settings', 'set', 'execution.maxActiveTasks', '3', '--yes', '--json'])).out);
    expect(same.data).toMatchObject({ changed: false, takesEffect: null, effect: '' });

    const list = envelope((await cli(repo, ['settings', '--list', '--json'])).out).data as { settings: Record<string, unknown>[] };
    const row = (k: string) => list.settings.find((s) => s.key === k)!;
    expect(row('execution.maxActiveTasks')).toMatchObject({ apply: 'live', class: 'live', hostOwned: false, needsRestart: false, needsUpgrade: false });
    expect(row('delivery.mode')).toMatchObject({ apply: 'prompt', class: 'restart', hostOwned: true, needsRestart: true, needsUpgrade: false });
    expect(row('models.coordinator')).toMatchObject({ apply: 'launch', class: 'restart', hostOwned: false, needsRestart: true });
    for (const s of list.settings) expect(Object.keys(s), String(s.key)).toEqual(expect.arrayContaining(['class', 'hostOwned', 'needsUpgrade', 'apply', 'needsRestart']));
  });

  it('human output says when the change takes effect; --dry-run says it would', async () => {
    const { repo } = await install();
    const live = (await cli(repo, ['settings', 'set', 'execution.maxRepairCyclesBeforeReplan', '2'])).out;
    expect(live).toMatch(/takes effect now: the runtime reads the regenerated config on its next command/);
    expect(live).not.toMatch(/coordinator restart:/);
    const restart = (await cli(repo, ['settings', 'set', 'models.effortByRole.coordinator', 'high', '--no-restart'])).out;
    expect(restart).toMatch(/takes effect after a coordinator restart/);
    expect(restart).toMatch(/coordinator restart: offered/);
    const dry = (await cli(repo, ['settings', 'set', 'communication.progress', 'tasks', '--dry-run'])).out;
    expect(dry).toMatch(/would take effect after a coordinator restart/);
    const list = (await cli(repo, ['settings', '--list'])).out;
    expect(list).toMatch(/delivery\.mode = \S+ +\([^)]*; restart; host-owned\)/);
    expect(list).toMatch(/execution\.maxActiveTasks = \S+ +\(project config\)\n/);
  });
});

describe('settings set delivery.requiredChecksConfigured (task-79)', () => {
  it('is listed under Delivery as a live, host-owned bool; turning it on loosens (needs --yes) and takes effect now; off needs no confirmation', async () => {
    const { repo, local } = await install();
    const list = envelope((await cli(repo, ['settings', '--list', '--json'])).out).data as { settings: Record<string, unknown>[] };
    expect(list.settings.find((s) => s.key === 'delivery.requiredChecksConfigured')).toMatchObject({ group: 'Delivery', type: 'bool', value: false,
      apply: 'live', class: 'live', hostOwned: true, needsRestart: false, canLoosen: true });

    const refused = await cli(repo, ['settings', 'set', 'delivery.requiredChecksConfigured', 'true', '--json']);
    expect(refused.code).not.toBe(0);
    expect(envelope(refused.out).error).toMatchObject({ code: 'POLICY_DENIED' });
    expect(envelope(refused.out).error!.message).toMatch(/auto-merge may arm for pull requests once their required checks pass/);

    const on = envelope((await cli(repo, ['settings', 'set', 'delivery.requiredChecksConfigured', 'true', '--yes', '--json'])).out);
    expect(on.ok).toBe(true);
    expect(on.data).toMatchObject({ key: 'delivery.requiredChecksConfigured', from: false, to: true, written: true, class: 'live', hostOwned: true,
      takesEffect: 'now', needsRestart: false, loosens: expect.stringMatching(/auto-merge may arm/) });
    expect(JSON.parse(readFileSync(local, 'utf8')).delivery).toEqual({ requiredChecksConfigured: true });

    // Turning it off tightens: no confirmation needed.
    const off = envelope((await cli(repo, ['settings', 'set', 'delivery.requiredChecksConfigured', 'false', '--json'])).out);
    expect(off.data).toMatchObject({ from: true, to: false, written: true, loosens: null });
    expect(JSON.parse(readFileSync(local, 'utf8')).delivery).toEqual({ requiredChecksConfigured: false });
  });
});

describe('settings change requests on the host CLI (task-53.3)', () => {
  it('set --expect-revision: a stale revision is refused with CONFLICT (exit 4) and writes nothing; the current one writes', async () => {
    const { repo, local } = await install();
    const stale = await cli(repo, ['settings', 'set', 'communication.progress', 'quiet', '--no-restart', '--expect-revision', '99', '--json']);
    expect(stale.code).toBe(4);
    expect(envelope(stale.out).error).toMatchObject({ code: 'CONFLICT' });
    expect(envelope(stale.out).error!.message).toMatch(/not 99: the configuration changed since this change was planned; nothing written/);
    expect(existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')).communication?.progress : undefined).toBeUndefined();
    const ok = await cli(repo, ['settings', 'set', 'communication.progress', 'quiet', '--no-restart', '--expect-revision', '1', '--json']);
    expect(ok.code).toBe(0);
    expect(envelope(ok.out).data).toMatchObject({ written: true });
    expect((await cli(repo, ['settings', 'set', 'communication.progress', 'tasks', '--expect-revision', 'x', '--json'])).out).toMatch(/--expect-revision must be a whole number/);
    expect((await cli(repo, ['settings', 'set', 'communication.progress', 'tasks', '--reason', 'r', '--json'])).out).toMatch(/--reason is for change requests recorded in the runtime/);
  });

  it('settings requests / apply / reject need the runtime (it holds the requests); restart --dry-run restarts nothing', async () => {
    const { repo } = await install();
    for (const args of [['settings', 'requests'], ['settings', 'apply', 'cr_00000001'], ['settings', 'reject', 'cr_00000001']]) {
      const r = await cli(repo, [...args, '--json']);
      expect(envelope(r.out).error, args.join(' ')).toMatchObject({ code: 'PRECONDITION' });
      expect(envelope(r.out).error!.message).toMatch(/runtime is not running/);
    }
    const dry = await cli(repo, ['settings', 'restart', '--dry-run', '--json']);
    expect(envelope(dry.out).data).toMatchObject({ action: 'skipped' });
  });
});
