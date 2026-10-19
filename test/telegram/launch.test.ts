// Coordinator launch with Telegram: the exec wrapper, the launch decision, and the controlled restart.
// Everything runs with fakes (spawn, runner, probe); no tmux, claude, or network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import {
  buildClaudeCommand, decideTelegram, launchFingerprint, readMountedToken, runCoordinator, syncCoordinator,
  TELEGRAM_TOKEN_ENV, TELEGRAM_TOOLS, type SpawnLike,
} from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { evaluateTelegram, TELEGRAM_CHANNEL_SPEC, TELEGRAM_PLUGIN_ID, type TelegramProbeReport } from '../../src/telegram/probe.js';
import { defaults } from '../helpers.js';
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
    expect(decideTelegram(defaults(), tok, available())).toEqual({ enabled: false, reason: 'communication.channel is terminal' });
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
    const code = await runCoordinator(telegramCfg(), { paths, spawn, env: parentEnv, probe: async () => available(), log: (l) => logs.push(l) });
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
    await runCoordinator(telegramCfg(), { paths, spawn, env: { [TELEGRAM_TOKEN_ENV]: TOKEN }, probe: async () => { probed = true; return available(); }, log: (l) => logs.push(l) });
    expect(calls[0]!.args).not.toContain('--channels');
    expect(calls[0]!.env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    expect(logs.join('\n')).toMatch(/Telegram disabled for this session: Telegram bot token is not provisioned.*Terminal mode is active/);
    expect(probed).toBe(false);
  });

  it('terminal channel: no probe, no token, no Telegram message', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(defaults(), { paths, spawn, env: {}, probe: async () => { throw new Error('must not probe'); }, log: (l) => logs.push(l) });
    expect(calls[0]!.args).not.toContain('--channels');
    expect(calls[0]!.env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    expect(logs).toEqual([]);
  });

  it('probe failure keeps terminal mode', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(telegramCfg(), { paths, spawn, env: {}, probe: async () => noBun(), log: (l) => logs.push(l) });
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
    await runCoordinator(cfg, { paths, spawn, env: {}, probe: async () => available(), log: () => {} });
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
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [], recordRestart: (i) => restarts.push(i) }, { startDetached: true });
    expect(r.action).toBe('restarted');
    expect(r.reason).toMatch(/Telegram configuration changed/);
    expect(t.calls.map((c) => c.args.slice(0, 3))).toEqual([['has-session', '-t', 'coordinator'], ['kill-session', '-t', 'coordinator'], ['-u', 'new-session', '-d']]);
    expect(t.calls[2]!.args.slice(-3)).toEqual(['minions', 'coordinator', 'run']);
    expect(JSON.stringify(t.calls)).not.toContain(TOKEN2);
    expect(restarts).toHaveLength(1);

    await launchWith(paths, telegramCfg());
    const t2 = tmux(true);
    const r2 = await syncCoordinator(defaults(), { paths, runner: t2.runner, activeLeases: () => [] });
    expect(r2).toMatchObject({ action: 'restarted', running: false, reason: 'communication.channel changed (telegram -> terminal)' });
  });

  it('defers the restart while worker leases are active unless forced', async () => {
    const { paths } = layout();
    await launchWith(paths, telegramCfg());
    const t = tmux(true);
    const r = await syncCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [{ id: 'lease-1' }] });
    expect(r.action).toBe('restart-pending');
    expect(r.reason).toMatch(/1 active worker lease\(s\) \(lease-1\)/);
    expect(t.calls.some((c) => c.args[0] === 'kill-session')).toBe(false);
    const forced = await syncCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [{ id: 'lease-1' }] }, { force: true });
    expect(forced.action).toBe('restarted');
  });

  it('starts detached when not running (Telegram with nobody attached)', async () => {
    const { paths } = layout();
    const t = tmux(false);
    expect((await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [] })).action).toBe('none');
    const r = await syncCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [] }, { startDetached: true });
    expect(r).toMatchObject({ action: 'started', running: true });
  });

  it('fingerprint depends on channel and token, not on the token text itself', () => {
    const tok = (t: string) => ({ state: 'ok' as const, token: t, botId: '123456789' });
    expect(launchFingerprint(telegramCfg(), tok(TOKEN))).not.toBe(launchFingerprint(telegramCfg(), tok(TOKEN2)));
    expect(launchFingerprint(telegramCfg(), tok(TOKEN))).not.toBe(launchFingerprint(defaults(), tok(TOKEN)));
    expect(launchFingerprint(telegramCfg(), tok(TOKEN))).not.toContain(TOKEN.slice(0, 12));
  });
});
