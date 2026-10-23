// Coordinator launch with Telegram: the exec wrapper, the launch decision, and the controlled restart.
// Everything runs with fakes (spawn, runner, probe); no tmux, claude, or network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import {
  buildClaudeCommand, decideTelegram, launchFingerprint, readMountedToken, runCoordinator, syncCoordinator,
  coordinatorSettings, coordinatorWrapper, exitCodeOf, readExitRecord, TELEGRAM_ALL_TOOLS, TELEGRAM_HOOK_COMMAND,
  TELEGRAM_TOKEN_ENV, TELEGRAM_TOOLS, type SignalTarget, type SpawnLike,
} from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { evaluateTelegram, TELEGRAM_CHANNEL_SPEC, TELEGRAM_PLUGIN_ID, type TelegramProbeReport } from '../../src/telegram/probe.js';
import { defaults, FAKE_MINIONS, runHookCommand } from '../helpers.js';
import { tmp } from '../runtime/fixtures.js';

const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const TOKEN2 = '123456789:BBHotherotherotherotherotherother_-9876';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const available = (): TelegramProbeReport => evaluateTelegram({
  claude: ok('2.1.292 (Claude Code)\n'), bun: ok('1.4.3\n'),
  marketplaces: ok(JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' }])),
  plugins: ok(JSON.stringify([{ id: TELEGRAM_PLUGIN_ID, version: '0.0.7', scope: 'user', enabled: true }])),
  managed: { present: false },
});
const noBun = (): TelegramProbeReport => evaluateTelegram({ ...factsOf(), bun: { code: 127, stdout: '', stderr: 'bun: not found' } });
const factsOf = () => ({
  claude: ok('2.1.292 (Claude Code)\n'), bun: ok('1.4.3\n'),
  marketplaces: ok(JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' }])),
  plugins: ok(JSON.stringify([{ id: TELEGRAM_PLUGIN_ID, version: '0.0.7', scope: 'user', enabled: true }])),
  managed: { present: false } as const,
});

/** Explicit terminal (the profile default is auto). */
/** --permission-mode choices of Claude Code 2.1.292 (stub for `claude --help`). */
const autoModes = async () => ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const terminalCfg = (): MinionsConfig => { const c = defaults(); c.communication.channel = 'terminal'; return c; };

const telegramCfg = (over: Partial<MinionsConfig['container']> = {}): MinionsConfig => {
  const c = defaults();
  c.communication.channel = 'telegram';
  Object.assign(c.container, over);
  return c;
};

function layout(token: string | null = TOKEN) {
  const root = tmp('minions-tg-');
  mkdirSync(join(root, 'plugin'), { recursive: true });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  if (token !== null) writeFileSync(join(root, 'secrets', 'telegram-bot-token'), token + '\n', { mode: 0o600 });
  const paths = {
    ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
    pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
  };
  return { root, paths };
}

const noSleep = async () => {};

/** Fake process signal target: records listeners so a test can deliver a signal. */
function fakeSignals() {
  const listeners = new Map<string, Set<() => void>>();
  const target: SignalTarget = {
    on(s, l) { if (!listeners.has(s)) listeners.set(s, new Set()); listeners.get(s)!.add(l); return target; },
    removeListener(s, l) { listeners.get(s)?.delete(l); return target; },
  };
  const emit = (s: NodeJS.Signals) => { for (const l of [...(listeners.get(s) ?? [])]) l(); };
  const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { target, emit, count, listeners };
}

/** Fake spawn: records argv and env, exits 0. */
function fakeSpawn() {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnLike = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    return {
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; },
    } as ReturnType<SpawnLike>;
  };
  return { calls, spawn };
}

describe('Telegram launch decision', () => {
  const tok = { state: 'ok' as const, token: TOKEN, botId: '123456789' };
  it('enables Telegram only when selected, networked, provisioned and the probe is available', () => {
    expect(decideTelegram(telegramCfg(), tok, available())).toMatchObject({ enabled: true });
    expect(decideTelegram(terminalCfg(), tok, available())).toEqual({ enabled: false, reason: 'communication.channel is terminal' });
    expect(decideTelegram(telegramCfg({ network: 'none' }), tok, available()).reason).toMatch(/network is none/);
    expect(decideTelegram(telegramCfg(), { state: 'missing' }, available()).reason).toMatch(/not provisioned; run `minions auth telegram`/);
    expect(decideTelegram(telegramCfg(), { state: 'invalid', detail: 'not a Telegram bot token' }, available()).reason).toMatch(/not a Telegram bot token/);
    const r = decideTelegram(telegramCfg(), tok, noBun());
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/Bun is not installed/);
  });

  it('reads and validates the mounted token before use', async () => {
    const { paths } = layout();
    expect(await readMountedToken(paths.telegramTokenFile)).toEqual({ state: 'ok', token: TOKEN, botId: '123456789' });
    expect(await readMountedToken(join(paths.secretsDir, 'absent'))).toEqual({ state: 'missing' });
    writeFileSync(paths.telegramTokenFile, 'x; rm -rf /\n');
    expect(await readMountedToken(paths.telegramTokenFile)).toMatchObject({ state: 'invalid' });
  });

  it('allows the Telegram tools only for a Telegram launch; never bypass mode', async () => {
    const { paths } = layout();
    const on = await buildClaudeCommand(telegramCfg(), paths, { telegram: true });
    const off = await buildClaudeCommand(telegramCfg(), paths, { telegram: false });
    expect(on.args.slice(-2)).toEqual(['--channels', TELEGRAM_CHANNEL_SPEC]);
    expect(off.args).not.toContain('--channels');
    const allow = (c: typeof on) => JSON.parse(c.args[c.args.indexOf('--settings') + 1]!).permissions.allow as string[];
    expect(allow(on)).toEqual(expect.arrayContaining(TELEGRAM_TOOLS));
    expect(allow(off).some((t) => t.startsWith('mcp__'))).toBe(false);
  });
});

describe('coordinator exec wrapper', () => {
  it('passes the token only through the claude child environment, with --channels', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    const parentEnv = { PATH: '/usr/bin', HOME: '/home/node' };
    const code = await runCoordinator(telegramCfg(), { paths, permissionModes: autoModes, spawn, env: parentEnv, probe: async () => available(), log: (l) => logs.push(l) });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.cmd).toBe('claude');
    expect(c.args).toContain('--channels');
    expect(c.env[TELEGRAM_TOKEN_ENV]).toBe(TOKEN);
    expect(c.env.PATH).toBe('/usr/bin');
    // Never in argv, logs, the parent environment, or the launch record.
    expect(JSON.stringify(c.args)).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(parentEnv).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    const rec = readFileSync(paths.coordinatorLaunch, 'utf8');
    expect(rec).not.toContain(TOKEN);
    expect(rec).not.toContain(TOKEN.split(':')[1]!);
    expect(JSON.parse(rec)).toMatchObject({ version: 1, channel: 'telegram', telegram: { enabled: true } });
  });

  it('falls back to terminal with a precise reason and drops an inherited token', async () => {
    const { paths } = layout(null);
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    let probed = false;
    await runCoordinator(telegramCfg(), { paths, permissionModes: autoModes, spawn, env: { [TELEGRAM_TOKEN_ENV]: TOKEN }, probe: async () => { probed = true; return available(); }, log: (l) => logs.push(l) });
    expect(calls[0]!.args).not.toContain('--channels');
    expect(calls[0]!.env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    expect(logs.join('\n')).toMatch(/Telegram disabled for this session: Telegram bot token is not provisioned.*Terminal mode is active/);
    expect(probed).toBe(false);
  });

  it('auto channel: Telegram with a mounted token; quiet terminal mode without one (no probe)', async () => {
    const auto = defaults();
    expect(auto.communication.channel).toBe('auto');
    const withTok = layout();
    const a = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(auto, { paths: withTok.paths, permissionModes: autoModes, spawn: a.spawn, env: {}, probe: async () => available(), log: (l) => logs.push(l) });
    expect(a.calls[0]!.args).toContain('--channels');
    expect(a.calls[0]!.env[TELEGRAM_TOKEN_ENV]).toBe(TOKEN);
    expect(logs.join('\n')).toMatch(/Telegram enabled \(communication.channel auto: bot token stored\)/);

    const noTok = layout(null);
    const b = fakeSpawn();
    const logs2: string[] = [];
    await runCoordinator(auto, { paths: noTok.paths, permissionModes: autoModes, spawn: b.spawn, env: { [TELEGRAM_TOKEN_ENV]: TOKEN }, probe: async () => { throw new Error('must not probe'); }, log: (l) => logs2.push(l) });
    expect(b.calls[0]!.args).not.toContain('--channels');
    expect(b.calls[0]!.env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    expect(logs2.join('\n')).toMatch(/^minions: terminal mode \(auto: no Telegram bot token is stored/);
    expect(logs2.join('\n')).not.toMatch(/disabled/);
  });

  it('terminal channel: no probe, no token, no Telegram message', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(terminalCfg(), { paths, permissionModes: autoModes, spawn, env: {}, probe: async () => { throw new Error('must not probe'); }, log: (l) => logs.push(l) });
    expect(calls[0]!.args).not.toContain('--channels');
    expect(calls[0]!.env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    expect(logs).toEqual([]);
  });

  it('probe failure keeps terminal mode', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(telegramCfg(), { paths, permissionModes: autoModes, spawn, env: {}, probe: async () => noBun(), log: (l) => logs.push(l) });
    expect(calls[0]!.args).not.toContain('--channels');
    expect(calls[0]!.env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    expect(logs.join('\n')).toMatch(/Telegram disabled for this session: .*Bun is not installed/);
  });
});

describe('controlled coordinator restart', () => {
  type Call = { cmd: string; args: string[]; opts?: RunOptions };
  function tmux(running: boolean) {
    const calls: Call[] = [];
    let alive = running;
    const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
      calls.push({ cmd, args, opts });
      if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') { alive = false; return ok(''); }
      if (args.includes('new-session')) { alive = true; return ok(''); }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { calls, runner };
  }
  const launchWith = async (paths: ReturnType<typeof layout>['paths'], cfg: MinionsConfig) => {
    const { spawn } = fakeSpawn();
    await runCoordinator(cfg, { paths, permissionModes: autoModes, spawn, env: {}, probe: async () => available(), log: () => {} });
  };

  it('no change: nothing is restarted', async () => {
    const { paths } = layout();
    await launchWith(paths, telegramCfg());
    const t = tmux(true);
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [] });
    expect(r.action).toBe('unchanged');
    expect(t.calls.map((c) => c.args[0])).toEqual(['has-session']);
  });

  it('token rotation or channel change restarts the session and records why', async () => {
    const { paths } = layout();
    await launchWith(paths, telegramCfg());
    writeFileSync(paths.telegramTokenFile, TOKEN2 + '\n');
    const t = tmux(true);
    const restarts: unknown[] = [];
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [], recordRestart: (i) => restarts.push(i), sleep: noSleep }, { startDetached: true });
    expect(r.action).toBe('restarted');
    expect(r.reason).toMatch(/Telegram configuration changed/);
    expect(t.calls.map((c) => c.args.slice(0, 3))).toEqual([['has-session', '-t', 'coordinator'], ['kill-session', '-t', 'coordinator'], ['-u', 'new-session', '-d'], ['has-session', '-t', 'coordinator']]);
    expect(t.calls[2]!.args.slice(-3)).toEqual(['minions', 'coordinator', 'run']);
    expect(JSON.stringify(t.calls)).not.toContain(TOKEN2);
    expect(restarts).toHaveLength(1);

    await launchWith(paths, telegramCfg());
    const t2 = tmux(true);
    const r2 = await syncCoordinator(terminalCfg(), { paths, runner: t2.runner, activeLeases: () => [] });
    expect(r2).toMatchObject({ action: 'restarted', running: false, reason: 'communication.channel changed (telegram -> terminal)' });
  });

  it('defers the restart while worker leases are active unless forced', async () => {
    const { paths } = layout();
    await launchWith(paths, telegramCfg());
    const t = tmux(true);
    const r = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [{ id: 'lease-1' }] });
    expect(r.action).toBe('restart-pending');
    expect(r.reason).toMatch(/1 active worker lease\(s\) \(lease-1\)/);
    expect(t.calls.some((c) => c.args[0] === 'kill-session')).toBe(false);
    const forced = await syncCoordinator(terminalCfg(), { paths, runner: t.runner, activeLeases: () => [{ id: 'lease-1' }] }, { force: true });
    expect(forced.action).toBe('restarted');
  });

  it('starts detached when not running (Telegram with nobody attached)', async () => {
    const { paths } = layout();
    const t = tmux(false);
    expect((await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [] })).action).toBe('none');
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep: noSleep }, { startDetached: true });
    expect(r).toMatchObject({ action: 'started', running: true });
  });

  it('fingerprint depends on channel and token, not on the token text itself', () => {
    const tok = (t: string) => ({ state: 'ok' as const, token: t, botId: '123456789' });
    expect(launchFingerprint(telegramCfg(), tok(TOKEN))).not.toBe(launchFingerprint(telegramCfg(), tok(TOKEN2)));
    expect(launchFingerprint(telegramCfg(), tok(TOKEN))).not.toBe(launchFingerprint(terminalCfg(), tok(TOKEN)));
    expect(launchFingerprint(telegramCfg(), tok(TOKEN))).not.toContain(TOKEN.slice(0, 12));
  });
});

describe('tester edge cases: terminal mode through the wrapper', () => {
  it('terminal argv is the plain claude argv (no channels, no Telegram tools) and other env is preserved', async () => {
    const { paths } = layout(null);
    const { calls, spawn } = fakeSpawn();
    const parentEnv = { PATH: '/usr/bin', HOME: '/home/node', TELEGRAM_BOT_TOKEN: TOKEN, CLAUDE_CONFIG_DIR: '/home/node/.claude' };
    await runCoordinator(terminalCfg(), { paths, permissionModes: autoModes, spawn, env: parentEnv, log: () => {} });
    const expected = await buildClaudeCommand(terminalCfg(), paths);
    expect(calls[0]!.cmd).toBe('claude');
    expect(calls[0]!.args).toEqual(expected.args);
    expect(calls[0]!.args).not.toContain('--channels');
    expect(calls[0]!.args.join('\n')).not.toContain('mcp__plugin_telegram');
    expect(calls[0]!.env).toEqual({ PATH: '/usr/bin', HOME: '/home/node', CLAUDE_CONFIG_DIR: '/home/node/.claude' });
    expect(parentEnv.TELEGRAM_BOT_TOKEN).toBe(TOKEN); // caller's object is not mutated
  });

  it('a corrupt or hostile mounted token never reaches env or argv and keeps terminal mode', async () => {
    for (const bad of ['garbage', `${TOKEN}\nFOO=bar`, `${TOKEN} --dangerously-skip-permissions`, '$(touch /tmp/x):' + 'a'.repeat(35)]) {
      const { paths } = layout(bad);
      const { calls, spawn } = fakeSpawn();
      const logs: string[] = [];
      await runCoordinator(telegramCfg(), { paths, permissionModes: autoModes, spawn, env: {}, probe: async () => available(), log: (l) => logs.push(l) });
      expect(calls[0]!.args, bad).not.toContain('--channels');
      expect(calls[0]!.env, bad).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
      expect(logs.join('\n'), bad).toMatch(/Telegram disabled.*not a Telegram bot token/);
      expect(logs.join('\n')).not.toContain('touch');
    }
  });

  it('missing coordinator prompt fails with a precise error before spawning claude', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    await expect(runCoordinator(terminalCfg(), { paths: { ...paths, coordinatorPrompt: join(paths.pluginDir, 'nope.md') }, permissionModes: autoModes, spawn, env: {}, log: () => {} }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/Coordinator prompt not found/) });
    expect(calls).toHaveLength(0);
  });

  it('a spawn error is reported precisely; a non-zero claude exit code is propagated', async () => {
    const { paths } = layout(null);
    const failing: SpawnLike = () => ({
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'error') setImmediate(() => cb(new Error('spawn claude ENOENT'))); return this; },
    } as ReturnType<SpawnLike>);
    await expect(runCoordinator(terminalCfg(), { paths, permissionModes: autoModes, spawn: failing, env: {}, log: () => {} }))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/Failed to start claude: spawn claude ENOENT/) });
    const exits: SpawnLike = () => ({
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(null, 'SIGTERM')); return this; },
    } as ReturnType<SpawnLike>);
    expect(await runCoordinator(terminalCfg(), { paths, permissionModes: autoModes, spawn: exits, env: {}, log: () => {}, signals: fakeSignals().target })).toBe(143); // 128 + SIGTERM(15)
  });

  it('an unwritable state dir does not stop the session from launching', async () => {
    const { paths } = layout(null);
    const { calls, spawn } = fakeSpawn();
    await runCoordinator(terminalCfg(), { paths: { ...paths, coordinatorLaunch: join(paths.coordinatorPrompt, 'x', 'launch.json') }, permissionModes: autoModes, spawn, env: {}, log: () => {} });
    expect(calls).toHaveLength(1);
  });

  it('tmux argv is only the wrapper: no env, no token, no claude flags', async () => {
    const { paths } = layout();
    const { buildCoordinatorCommand } = await import('../../src/runtime/coordinator.js');
    const c = await buildCoordinatorCommand(telegramCfg(), paths);
    expect(c.cmd).toBe('tmux');
    expect(c.args.slice(-3)).toEqual(['minions', 'coordinator', 'run']);
    expect(JSON.stringify(c)).not.toMatch(/TELEGRAM|channels|123456789/);
  });
});

describe('tester edge cases: restart with leases', () => {
  const stub = (running: boolean) => {
    const calls: string[][] = [];
    let alive = running;
    const runner = async (_c: string, args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') { alive = false; return ok(''); }
      alive = true; return ok('');
    };
    return { calls, runner };
  };
  const launched = async (paths: ReturnType<typeof layout>['paths'], cfg: MinionsConfig) => {
    const { spawn } = fakeSpawn();
    await runCoordinator(cfg, { paths, permissionModes: autoModes, spawn, env: {}, probe: async () => available(), log: () => {} });
  };

  it('--force restarts but never touches the lease source; the leases are reported for recovery', async () => {
    const { paths } = layout();
    await launched(paths, telegramCfg());
    writeFileSync(paths.telegramTokenFile, TOKEN2 + '\n');
    const leases = [{ id: 'lease-a' }, { id: 'lease-b' }];
    const snapshot = JSON.stringify(leases);
    const rec: { leases: string[] }[] = [];
    const t = stub(true);
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => leases, recordRestart: (i) => rec.push(i) }, { force: true });
    expect(r.action).toBe('restarted');
    expect(rec[0]!.leases).toEqual(['lease-a', 'lease-b']);
    expect(JSON.stringify(leases)).toBe(snapshot);
    expect(t.calls.filter((a) => a[0] === 'kill-session')).toHaveLength(1);
  });

  it('pending restart without force does not record a restart and leaves the session alone', async () => {
    const { paths } = layout();
    await launched(paths, telegramCfg());
    writeFileSync(paths.telegramTokenFile, TOKEN2 + '\n');
    const t = stub(true);
    let recorded = 0;
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [{ id: 'l1' }], recordRestart: () => { recorded++; }, sleep: noSleep }, { startDetached: true });
    expect(r).toMatchObject({ action: 'restart-pending', running: true });
    expect(recorded).toBe(0);
    expect(t.calls).toEqual([['has-session', '-t', 'coordinator']]);
  });

  it('no active leases: restart is immediate; a coordinator with no launch record is not killed', async () => {
    const { paths } = layout();
    const t = stub(true);
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [{ id: 'x' }] });
    expect(r.action).toBe('unchanged');
    expect(r.reason).toMatch(/without a launch record/);
    expect(t.calls.some((a) => a[0] === 'kill-session')).toBe(false);
  });

  it('a failing detached start surfaces the tmux error without the token', async () => {
    const { paths } = layout();
    const runner = async (_c: string, args: string[]): Promise<RunResult> =>
      args[0] === 'has-session' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'tmux: boom' };
    await expect(syncCoordinator(telegramCfg(), { paths, runner, activeLeases: () => [] }, { startDetached: true }))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/tmux: boom/) });
  });
});

describe('wrapper signal handling', () => {
  /** A claude child that stays running until the test ends it; records the signals it was sent. */
  function controllableSpawn() {
    const killed: NodeJS.Signals[] = [];
    let exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const spawn: SpawnLike = () => ({
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') exit = cb as typeof exit; return this; },
      kill(s: NodeJS.Signals) { killed.push(s); return true; },
    } as ReturnType<SpawnLike>);
    return { spawn, killed, finish: (code: number | null, signal: NodeJS.Signals | null) => exit!(code, signal) };
  }
  const settle = () => new Promise((r) => setImmediate(r));

  it('ignores SIGINT/SIGQUIT while claude runs and forwards SIGTERM/SIGHUP; 128+n on signal exit', async () => {
    const { paths } = layout(null);
    const sig = fakeSignals();
    const child = controllableSpawn();
    let done: number | undefined;
    const p = runCoordinator(defaults(), { paths, permissionModes: autoModes, spawn: child.spawn, env: {}, log: () => {}, signals: sig.target }).then((c) => (done = c));
    for (let i = 0; i < 200 && sig.count() < 4; i++) await new Promise((r) => setTimeout(r, 5)); // until claude is spawned
    for (const s of ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'] as const) expect(sig.listeners.get(s)?.size, s).toBe(1);
    sig.emit('SIGINT');
    sig.emit('SIGQUIT');
    await settle();
    expect(done).toBeUndefined(); // the wrapper is still waiting on claude
    expect(child.killed).toEqual([]); // claude gets Ctrl-C from the terminal itself, not from us
    sig.emit('SIGTERM');
    sig.emit('SIGHUP');
    expect(child.killed).toEqual(['SIGTERM', 'SIGHUP']);
    child.finish(null, 'SIGHUP');
    expect(await p).toBe(129);
    expect(sig.count()).toBe(0); // listeners removed after claude exits
  });

  it('removes its listeners when claude fails to start', async () => {
    const { paths } = layout(null);
    const sig = fakeSignals();
    const failing: SpawnLike = () => ({
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'error') setImmediate(() => cb(new Error('ENOENT'))); return this; },
    } as ReturnType<SpawnLike>);
    await expect(runCoordinator(defaults(), { paths, permissionModes: autoModes, spawn: failing, env: {}, log: () => {}, signals: sig.target })).rejects.toThrow(/ENOENT/);
    expect(sig.count()).toBe(0);
  });

  it('exit codes follow the 128+n convention', () => {
    expect(exitCodeOf(0, null)).toBe(0);
    expect(exitCodeOf(3, null)).toBe(3);
    expect(exitCodeOf(null, 'SIGINT')).toBe(130);
    expect(exitCodeOf(null, 'SIGKILL')).toBe(137);
    expect(exitCodeOf(null, 'SIGTERM')).toBe(143);
    expect(exitCodeOf(null, null)).toBe(1);
  });
});

describe('Telegram tools are coordinator-only', () => {
  it('the generated settings gate every Telegram tool behind the pre-telegram hook', async () => {
    const { paths } = layout();
    const on = await buildClaudeCommand(telegramCfg(), paths, { telegram: true });
    const settings = JSON.parse(on.args[on.args.indexOf('--settings') + 1]!);
    const entries = settings.hooks.PreToolUse as { matcher: string; hooks: { type: string; command: string }[] }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hooks).toEqual([{ type: 'command', command: TELEGRAM_HOOK_COMMAND, timeout: 30 }]);
    const matcher = new RegExp(`^(?:${entries[0]!.matcher})$`);
    for (const t of TELEGRAM_ALL_TOOLS) expect(matcher.test(t), t).toBe(true);
    expect(TELEGRAM_ALL_TOOLS).toEqual(['reply', 'react', 'edit_message', 'download_attachment'].map((t) => `mcp__plugin_telegram_telegram__${t}`));
    for (const t of ['Bash', 'Agent', 'mcp__other__reply', 'mcp__plugin_telegram_telegramx']) expect(matcher.test(t), t).toBe(false);
    // Terminal launches carry no Telegram hook (and no Telegram allow).
    expect(coordinatorSettings(telegramCfg())).not.toHaveProperty('hooks');
  });

  it('the generated pre-telegram hook fails closed: a missing or crashing minions blocks the Telegram call', async () => {
    const { paths } = layout();
    const on = await buildClaudeCommand(telegramCfg(), paths, { telegram: true });
    const settings = JSON.parse(on.args[on.args.indexOf('--settings') + 1]!);
    const command = settings.hooks.PreToolUse[0].hooks[0].command as string;
    expect(command).toBe('timeout 20 minions hook pre-telegram || exit 2');
    const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: { chat_id: '1', text: 'hi' } });
    // Exit 2 is the only blocking PreToolUse exit; 127 (not found), 1 (crash) or 137 (killed) would allow the call.
    expect(runHookCommand(command, null, stdin).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.crash, stdin).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.killed, stdin).status).toBe(2);
    // Healthy: the coordinator's own reply goes through (exit 0, no output); a JSON deny is passed on as is.
    expect(runHookCommand(command, FAKE_MINIONS.allow, stdin)).toMatchObject({ status: 0, stdout: '' });
    const denied = runHookCommand(command, FAKE_MINIONS.deny, stdin);
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('detached start detects a wrapper that dies immediately', () => {
  /** tmux fake whose session disappears right after new-session, like a wrapper that exits on startup. */
  function dyingTmux(onStart: () => void = () => {}) {
    const calls: string[][] = [];
    const runner = async (_c: string, args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: "can't find session: coordinator" };
      if (args.includes('new-session')) { onStart(); return ok(''); }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { calls, runner };
  }

  it('reports the wrapper error recorded in the exit record instead of "started"', async () => {
    const { paths } = layout();
    // The real wrapper entry point fails (e.g. invalid config) and records why.
    const t = dyingTmux();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      await coordinatorWrapper(async () => { throw new Error(`invalid config: verification.commands[0] (token ${TOKEN})`); }, { paths }).catch(() => {});
    };
    const err = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep }, { startDetached: true }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/exited right after starting: invalid config: verification\.commands\[0\]/) });
    expect(err.message).not.toContain(TOKEN);
    expect(sleeps).toEqual([2000]);
    expect(t.calls.map((a) => a[0] === 'has-session' ? 'has' : 'new')).toEqual(['has', 'new', 'has']);
  });

  it('reports a non-zero exit code when the wrapper exited without an error message', async () => {
    const { paths } = layout(null);
    const t = dyingTmux();
    const exits: SpawnLike = () => ({
      on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(2, null)); return this; },
    } as ReturnType<SpawnLike>);
    const sleep = async () => { await coordinatorWrapper(async () => defaults(), { paths, spawn: exits, permissionModes: autoModes, env: {}, log: () => {}, signals: fakeSignals().target }); };
    await expect(syncCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [], sleep }, { startDetached: true }))
      .rejects.toMatchObject({ message: expect.stringMatching(/exited with code 2/) });
    expect(await readExitRecord(paths)).toMatchObject({ version: 1, code: 2 });
  });

  it('a stale exit record from an earlier run is not reported as this failure', async () => {
    const { paths } = layout();
    writeFileSync(paths.coordinatorExit, JSON.stringify({ version: 1, pid: 1, at: '2020-01-01T00:00:00Z', code: 1, error: 'old failure' }));
    const t = dyingTmux();
    const err = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [], sleep: noSleep }, { startDetached: true }).catch((e) => e);
    expect(err.message).toMatch(/exited right after starting: no exit record was written/);
    expect(err.message).not.toMatch(/old failure/);
  });
});
