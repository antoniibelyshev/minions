// Task-6: the host runtime coordinator launch with the minions Telegram channel server. Fakes only (spawn,
// claude --version, shim); no tmux, claude, Telegram or network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import {
  buildClaudeCommand, hostSettings, minionsChannelPollerStatus, hostHardeningFromEnv, MINIONS_TELEGRAM_HOOK_MATCHER, PRINT_LAUNCH_ID, printChannelServer, runCoordinator,
  TELEGRAM_HOOK_COMMAND, TELEGRAM_TOKEN_ENV, type LaunchRecord, type SpawnLike,
} from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { DEV_CHANNELS_FLAG, MINIONS_CHANNEL_SPEC } from '../../src/telegram/channel/launch.js';
import { LAUNCH_ENV, TOKEN_FILE_ENV } from '../../src/telegram/channel/server.js';
import { TELEGRAM_CHANNEL_SPEC } from '../../src/telegram/probe.js';
import { preTelegramHook } from '../../src/runtime/hooks.js';
import { telegramReadiness } from '../../src/host/doctor.js';
import { resolveChannel } from '../../src/telegram/channel.js';
import { loadAccessFile, runAccessCommand } from '../../src/telegram/channel/access-cli.js';
import { gate } from '../../src/telegram/channel/core.js';
import { defaults } from '../helpers.js';
import { tmp } from '../runtime/fixtures.js';

const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const saved = { ...process.env };

function hostLayout(token: string | null = TOKEN) {
  const root = tmp('minions-host-tg-');
  const project = join(root, 'projects', 'p1');
  const env = {
    MINIONS_RUNTIME: 'host', MINIONS_HOME: root, MINIONS_PROJECT_DIR: project,
    MINIONS_WORKSPACE: join(project, 'host', 'workspace'), MINIONS_STATE_DIR: join(project, 'host', 'state'), MINIONS_SECRETS_DIR: join(project, 'host', 'secrets'),
  };
  for (const d of [env.MINIONS_WORKSPACE, env.MINIONS_STATE_DIR, env.MINIONS_SECRETS_DIR, join(project, 'host', 'bin'), join(root, 'plugin')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  if (token !== null) writeFileSync(join(env.MINIONS_SECRETS_DIR, 'telegram-bot-token'), token + '\n', { mode: 0o600 });
  for (const k of Object.keys(process.env)) if (k.startsWith('MINIONS_') || k === 'TELEGRAM_STATE_DIR' || k === 'CLAUDE_CONFIG_DIR') delete process.env[k];
  Object.assign(process.env, env);
  const paths = { ...runtimePaths(process.env), pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md') };
  return { root, project, paths };
}

const telegramCfg = (channel: MinionsConfig['communication']['channel'] = 'telegram'): MinionsConfig => { const c = defaults(); c.communication.channel = channel; return c; };
const modes = async () => ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];

function fakeSpawn() {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnLike = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; } } as ReturnType<SpawnLike>;
  };
  return { calls, spawn };
}

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
const settingsOf = (args: string[]) => JSON.parse(argAfter(args, '--settings')) as { permissions: { allow: string[] }; hooks?: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }; enabledPlugins?: unknown };

afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

describe('host coordinator launch with the minions channel server', () => {
  it('starts claude with only our MCP server and the dev channel flag; the token is never in env or argv', async () => {
    const { paths } = hostLayout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    const code = await runCoordinator(telegramCfg(), {
      paths, spawn, permissionModes: modes, env: { PATH: '/usr/bin', [TELEGRAM_TOKEN_ENV]: TOKEN }, log: (l) => logs.push(l),
      claudeVersion: async () => '2.1.308 (Claude Code)', exists: () => true, newLaunchId: () => 'launch-abc',
    });
    expect(code).toBe(0);
    const { args, env } = calls[0]!;
    // Token: not in the env (even when the parent had it), argv, logs or the launch record.
    expect(env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    const recText = readFileSync(paths.coordinatorLaunch, 'utf8');
    expect(recText).not.toContain(TOKEN);
    // Only our server, next to --strict-mcp-config; the plugin's --channels is not used.
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--channels');
    expect(args).not.toContain(TELEGRAM_CHANNEL_SPEC);
    expect(argAfter(args, DEV_CHANNELS_FLAG)).toBe(MINIONS_CHANNEL_SPEC);
    const mcp = JSON.parse(argAfter(args, '--mcp-config')) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['minions-telegram']);
    const srv = mcp.mcpServers['minions-telegram']!;
    expect(srv.command).toBe(paths.minionsShim);
    expect(srv.args).toEqual(['telegram', 'channel', 'serve']);
    expect(srv.env).toEqual({ [TOKEN_FILE_ENV]: paths.telegramTokenFile, [LAUNCH_ENV]: 'launch-abc', TELEGRAM_STATE_DIR: paths.telegramStateDir });
    // The launch record carries the same launch id, so the server activates only for this launch.
    const rec = JSON.parse(recText) as LaunchRecord;
    expect(rec.launchId).toBe('launch-abc');
    expect(rec.telegram).toMatchObject({ enabled: true, server: 'minions' });
    // Allow list and the coordinator-only hook on the new prefix; no plugin enabled.
    const s = settingsOf(args);
    expect(s.permissions.allow).toContain('mcp__minions-telegram__reply');
    expect(s.permissions.allow.some((a) => a.startsWith('mcp__plugin_telegram'))).toBe(false);
    expect(s.hooks!.PreToolUse).toEqual([expect.objectContaining({ matcher: MINIONS_TELEGRAM_HOOK_MATCHER, hooks: [expect.objectContaining({ command: TELEGRAM_HOOK_COMMAND })] })]);
    expect(s.enabledPlugins).toBeUndefined();
    expect(logs.join('\n')).toMatch(/Loading development channels/);
  });

  it('falls back to terminal with a precise reason: old Claude Code, missing shim, no token', async () => {
    const cases: [Parameters<typeof runCoordinator>[1], string | null, RegExp][] = [
      [{ claudeVersion: async () => '2.1.200 (Claude Code)', exists: () => true }, TOKEN, /Claude Code 2\.1\.200 predates the development channel flag/],
      [{ claudeVersion: async () => '2.1.308 (Claude Code)', exists: () => false }, TOKEN, /host runtime shim that starts the channel server is missing/],
      [{ claudeVersion: async () => { throw new Error('must not run'); }, exists: () => true }, null, /bot token is not provisioned/],
    ];
    for (const [deps, token, reason] of cases) {
      const { paths } = hostLayout(token);
      const { calls, spawn } = fakeSpawn();
      const logs: string[] = [];
      await runCoordinator(telegramCfg(), { ...deps, paths, spawn, permissionModes: modes, env: {}, log: (l) => logs.push(l) });
      const { args, env } = calls[0]!;
      expect(args).not.toContain('--mcp-config');
      expect(args).not.toContain(DEV_CHANNELS_FLAG);
      expect(env).not.toHaveProperty(TELEGRAM_TOKEN_ENV);
      const rec = JSON.parse(readFileSync(paths.coordinatorLaunch, 'utf8')) as LaunchRecord;
      expect(rec.telegram.enabled).toBe(false);
      expect(rec.telegram.reason).toMatch(reason);
      expect(rec.launchId).toBeUndefined();
      expect(logs.join('\n')).toMatch(reason);
    }
  });

  it('--print-command on the host: placeholder launch id instead of an INTERNAL error', async () => {
    const { paths } = hostLayout();
    const c = await buildClaudeCommand(telegramCfg(), paths, { telegram: true, permissionModes: await modes(), channelServer: printChannelServer(paths) });
    expect(argAfter(c.args, '--mcp-config')).toContain(PRINT_LAUNCH_ID);
    expect(JSON.stringify(c.args)).not.toContain(TOKEN);
    // Without a shim path the plain command is shown.
    expect(printChannelServer({ ...paths, minionsShim: null }).command).toBe('minions');
  });

  it('sandboxed commands cannot read the token file or the channel state dir', () => {
    const { paths } = hostLayout();
    const h = hostHardeningFromEnv(process.env, paths);
    const s = hostSettings(h);
    const sandbox = s.sandbox as { filesystem: { denyRead: string[] } };
    expect(sandbox.filesystem.denyRead).toContain(paths.telegramTokenFile);
    expect(s.deny).toContain(`Read(/${paths.telegramTokenFile})`);
    expect(s.deny.some((d) => d.startsWith('Read(') && d.includes('channels/telegram'))).toBe(true);
  });
});

describe('host runtime: hook, poller status and doctor readiness', () => {
  it('the pre-telegram hook allows the coordinator on the new prefix and denies subagents there', () => {
    const call = (extra: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name: 'mcp__minions-telegram__reply', tool_input: { chat_id: '1', text: 'hi' }, ...extra });
    expect(preTelegramHook(call({})).reason).toMatch(/^allow: mcp__minions-telegram__reply from the coordinator/);
    expect(JSON.stringify(preTelegramHook(call({ agent_id: 'a1', agent_type: 'minions:engineer' })).stdout)).toMatch(/deny/);
    expect(JSON.stringify(preTelegramHook(call({ tool_name: 'mcp__minions-telegram__' })).stdout)).toMatch(/deny/);
  });

  it('poller status follows channel.lock of this launch', async () => {
    const dir = tmp('minions-host-lock-');
    const rec: LaunchRecord = { version: 1, pid: 10, startedAt: '', fingerprint: '', channel: 'telegram', telegram: { enabled: true, server: 'minions', reason: '' }, launchId: 'L1' };
    const proc = { alive: (pid: number) => pid === 10 || pid === 20, startTime: () => 'S' };
    const lock = (o: Record<string, unknown>) => writeFileSync(join(dir, 'channel.lock'), JSON.stringify({ version: 1, pid: 20, start: 'S', launchId: 'L1', kills: 0, ...o }));
    expect(await minionsChannelPollerStatus(rec, { telegramStateDir: dir }, proc)).toMatchObject({ state: 'missing' });
    lock({});
    expect(await minionsChannelPollerStatus(rec, { telegramStateDir: dir }, proc)).toMatchObject({ state: 'ok', pid: 20 });
    lock({ launchId: 'OTHER' });
    expect(await minionsChannelPollerStatus(rec, { telegramStateDir: dir }, proc)).toMatchObject({ state: 'missing', detail: expect.stringMatching(/another coordinator launch/) });
    lock({ pid: 30 });
    expect(await minionsChannelPollerStatus(rec, { telegramStateDir: dir }, proc)).toMatchObject({ state: 'dead', pid: 30 });
  });

  it('doctor names the minions channel server on the host, or terminal with the precise reason', () => {
    const facts = { token: 'ok', runtime: 'host', network: 'outbound-internet' } as const;
    const okRes = resolveChannel('telegram', { ...facts, probe: { available: true, summary: 'ok', items: [] } });
    expect(telegramReadiness(okRes, undefined, 'stored' as never, 'host')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/minions channel server is available \(host runtime\)/) });
    const old = 'the minions Telegram channel server cannot start: Claude Code 2.1.200 predates the development channel flag';
    const badRes = resolveChannel('telegram', { ...facts, probe: { available: false, summary: old, items: [] } });
    const check = { name: 'telegram.server', status: 'unavailable' as const, detail: old, hint: 'Update Claude Code on the host.' };
    expect(telegramReadiness(badRes, check, 'stored' as never, 'host')).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/predates.*terminal-only/), hint: 'Update Claude Code on the host.' });
    expect(telegramReadiness(resolveChannel('telegram', facts), undefined, 'stored' as never, 'host').detail).toMatch(/minions channel server was not checked/);
  });
});

describe('host pairing CLI (minions telegram access) and the server gate', () => {
  const NOW = Date.parse('2026-10-29T12:00:00Z');
  const dm = (from: number) => ({ message_id: 1, date: NOW / 1000, text: 'hi', from: { id: from }, chat: { id: from, type: 'private' as const } });

  it('refuses without a TTY or confirmation; a paired owner is delivered, non-owner senders are dropped', async () => {
    const dir = tmp('minions-host-access-');
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: { abc123: { senderId: '4242', chatId: '4242', createdAt: NOW, expiresAt: NOW + 3_600_000, replies: 1 } } }));
    const pair = { kind: 'pair' as const, code: 'abc123' };
    await expect(runAccessCommand(dir, pair, { isTty: false, ask: async () => 'pair', now: () => NOW })).rejects.toThrow(/interactive terminal/);
    await expect(runAccessCommand(dir, pair, { isTty: true, ask: async () => 'yes', now: () => NOW })).rejects.toThrow(/Not confirmed/);
    expect((await loadAccessFile(dir)).allowFrom).toEqual([]);
    expect(await runAccessCommand(dir, pair, { isTty: true, ask: async () => 'pair', now: () => NOW })).toMatchObject({ changed: true, senderId: '4242' });
    await runAccessCommand(dir, { kind: 'policy', policy: 'allowlist' }, { isTty: true, ask: async () => 'yes', now: () => NOW });
    const access = await loadAccessFile(dir);
    expect(gate(access, dm(4242), NOW, () => 'x').action).toBe('deliver');
    expect(gate(access, dm(777), NOW, () => 'x').action).toBe('drop');
  });
});
