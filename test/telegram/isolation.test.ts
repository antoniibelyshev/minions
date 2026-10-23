// Task-51: only the coordinator launch may run the Telegram poller. Other claude sessions in the
// container (a worker's `claude -p`, a test harness) inherit the bot token through the coordinator's
// Bash tool, so the plugin itself must not load for them. Everything runs with fakes: no claude, no
// tmux, no real ~/.claude, no real bot.pid.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { RunResult } from '../../src/core/exec.js';
import { telegramPollerCheck } from '../../src/host/doctor.js';
import { humanPoller, humanStatus, type StatusReport } from '../../src/runtime/commands.js';
import { coordinatorSettings, runCoordinator, telegramPollerStatus, type SpawnLike } from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { checkTelegramPoller, disableTelegramAtUserScope, POLLER_RECOVERY_HINT, type PollerProc } from '../../src/telegram/isolation.js';
import { evaluateTelegram, TELEGRAM_PLUGIN_ID, type TelegramProbeReport } from '../../src/telegram/probe.js';
import { defaults } from '../helpers.js';
import { tmp } from '../runtime/fixtures.js';

const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const available = (): TelegramProbeReport => evaluateTelegram({
  claude: ok('2.1.292 (Claude Code)\n'), bun: ok('1.4.3\n'),
  marketplaces: ok(JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' }])),
  plugins: ok(JSON.stringify([{ id: TELEGRAM_PLUGIN_ID, version: '0.0.7', scope: 'user', enabled: false }])),
  managed: { present: false },
});
const autoModes = async () => ['acceptEdits', 'auto'];
const telegramCfg = (): MinionsConfig => { const c = defaults(); c.communication.channel = 'telegram'; return c; };
const terminalCfg = (): MinionsConfig => { const c = defaults(); c.communication.channel = 'terminal'; return c; };

function layout(token: string | null = TOKEN) {
  const root = tmp('minions-tg-iso-');
  for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  if (token !== null) writeFileSync(join(root, 'secrets', 'telegram-bot-token'), token + '\n', { mode: 0o600 });
  const paths = {
    ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
    pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
  };
  return { root, paths };
}

function fakeSpawn() {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const spawn: SpawnLike = (_cmd, args, opts) => {
    calls.push({ args, env: opts.env });
    return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; } } as ReturnType<SpawnLike>;
  };
  return { calls, spawn };
}

type Settings = { enabledPlugins?: Record<string, unknown> } | null;
/**
 * Mirror of Claude Code 2.1.292's enabled-plugin resolution (the bundled `xq()`): managed, user,
 * project, local, then flag (--settings) settings, a later true/false replacing an earlier one. An
 * installed plugin no source mentions is enabled (manifest defaultEnabled, default true).
 */
function pluginLoads(id: string, s: { managed?: Settings; user?: Settings; project?: Settings; local?: Settings; flag?: Settings }): boolean {
  let on: boolean | undefined;
  for (const src of [s.managed, s.user, s.project, s.local, s.flag]) {
    const v = src?.enabledPlugins?.[id];
    if (v === true || Array.isArray(v)) on = true; else if (v === false) on = false;
  }
  return on ?? true;
}
const readJsonFile = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Settings;
const flagSettings = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]!) as Settings;

describe('only the coordinator launch enables the Telegram plugin (root cause)', () => {
  it('after a coordinator launch, a non-coordinator claude process (no --settings) never loads the plugin, so it never starts a poller', async () => {
    const { paths } = layout();
    // The state before the fix: `claude plugin install --scope user` enabled it for every session.
    mkdirSync(join(paths.claudeUserSettings, '..'), { recursive: true });
    writeFileSync(paths.claudeUserSettings, JSON.stringify({ theme: 'dark', enabledPlugins: { [TELEGRAM_PLUGIN_ID]: true, 'other@m': true } }));
    expect(pluginLoads(TELEGRAM_PLUGIN_ID, { user: readJsonFile(paths.claudeUserSettings) })).toBe(true);

    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(telegramCfg(), { paths, spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: (l) => logs.push(l) });

    const user = readJsonFile(paths.claudeUserSettings);
    expect(user).toEqual({ theme: 'dark', enabledPlugins: { [TELEGRAM_PLUGIN_ID]: false, 'other@m': true } }); // other keys kept
    // A worker's `claude -p` (or a test harness) inherits the token from the coordinator's Bash tool,
    // but reads only user/project/local settings: the plugin, and so its poller, never loads.
    expect(calls[0]!.env.TELEGRAM_BOT_TOKEN).toBe(TOKEN);
    expect(pluginLoads(TELEGRAM_PLUGIN_ID, { user })).toBe(false);
    // The coordinator itself enables it through its --settings (flag settings win over user scope) and --channels.
    expect(calls[0]!.args).toContain('--channels');
    expect(flagSettings(calls[0]!.args)?.enabledPlugins).toEqual({ [TELEGRAM_PLUGIN_ID]: true });
    expect(pluginLoads(TELEGRAM_PLUGIN_ID, { user, flag: flagSettings(calls[0]!.args) })).toBe(true);
    expect(logs.join('\n')).toMatch(/turned telegram@claude-plugins-official off at user scope/);

    // Idempotent: the next launch leaves the file alone and logs nothing about it.
    const again: string[] = [];
    await runCoordinator(telegramCfg(), { paths, spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: (l) => again.push(l) });
    expect(again.join('\n')).not.toMatch(/user scope/);
  });

  it('a fresh volume without settings.json gets the explicit off entry (an installed plugin defaults to enabled)', async () => {
    const { paths } = layout();
    expect(existsSync(paths.claudeUserSettings)).toBe(false);
    expect(pluginLoads(TELEGRAM_PLUGIN_ID, {})).toBe(true);
    await runCoordinator(telegramCfg(), { paths, spawn: fakeSpawn().spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: () => {} });
    expect(pluginLoads(TELEGRAM_PLUGIN_ID, { user: readJsonFile(paths.claudeUserSettings) })).toBe(false);
  });

  it('a terminal-only launch does not enable the plugin, and still turns an existing user-scope entry off', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    await runCoordinator(terminalCfg(), { paths, spawn, env: {}, permissionModes: autoModes, log: () => {} });
    expect(flagSettings(calls[0]!.args)).not.toHaveProperty('enabledPlugins');
    expect(existsSync(paths.claudeUserSettings)).toBe(false); // nothing to turn off: no file created

    mkdirSync(join(paths.claudeUserSettings, '..'), { recursive: true });
    writeFileSync(paths.claudeUserSettings, JSON.stringify({ enabledPlugins: { [TELEGRAM_PLUGIN_ID]: true } }));
    await runCoordinator(terminalCfg(), { paths, spawn, env: {}, permissionModes: autoModes, log: () => {} });
    expect(readJsonFile(paths.claudeUserSettings)?.enabledPlugins?.[TELEGRAM_PLUGIN_ID]).toBe(false);
  });

  it('coordinatorSettings enables the plugin only for a Telegram launch', () => {
    expect(coordinatorSettings(defaults(), { telegram: true, auth: 'login', host: null }).enabledPlugins).toEqual({ [TELEGRAM_PLUGIN_ID]: true });
    expect(coordinatorSettings(defaults(), { telegram: false, auth: 'login', host: null })).not.toHaveProperty('enabledPlugins');
  });

  it('a failure to update the user settings warns and still launches', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(telegramCfg(), { paths, spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: (l) => logs.push(l),
      userScope: async () => ({ state: 'error', detail: 'settings.json is not valid JSON' }) });
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/warning: could not turn the Telegram plugin off at user scope \(settings.json is not valid JSON\); other claude sessions/);
  });

  it('tests never point the user settings at the real ~/.claude', () => {
    const state = tmp('minions-tg-paths-');
    expect(runtimePaths({ MINIONS_STATE_DIR: state }).claudeUserSettings).toBe(join(state, 'claude', 'settings.json'));
    expect(runtimePaths({ CLAUDE_CONFIG_DIR: '/x/cfg', MINIONS_STATE_DIR: state }).claudeUserSettings).toBe('/x/cfg/settings.json');
    expect(runtimePaths({}).claudeUserSettings).toBe('/home/node/.claude/settings.json'); // the container default
  });
});

describe('disableTelegramAtUserScope', () => {
  const file = () => join(tmp('minions-tg-us-'), 'settings.json');
  it('turns the entry off and keeps everything else; idempotent', async () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] } }));
    expect((await disableTelegramAtUserScope(f)).state).toBe('disabled');
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ theme: 'dark', permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { [TELEGRAM_PLUGIN_ID]: false } });
    expect((await disableTelegramAtUserScope(f)).state).toBe('already-disabled');
  });
  it('treats a version-constraint list as enabled', async () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ enabledPlugins: { [TELEGRAM_PLUGIN_ID]: ['>=0.0.7'] } }));
    expect((await disableTelegramAtUserScope(f)).state).toBe('disabled');
    expect(JSON.parse(readFileSync(f, 'utf8')).enabledPlugins[TELEGRAM_PLUGIN_ID]).toBe(false);
  });
  it('creates the file only with create; never rewrites an unparseable or odd file', async () => {
    const f = file();
    expect((await disableTelegramAtUserScope(f)).state).toBe('absent');
    expect(existsSync(f)).toBe(false);
    expect((await disableTelegramAtUserScope(f, { create: true })).state).toBe('disabled');
    writeFileSync(f, '{ not json');
    expect(await disableTelegramAtUserScope(f, { create: true })).toMatchObject({ state: 'error', detail: expect.stringMatching(/not valid JSON/) });
    expect(readFileSync(f, 'utf8')).toBe('{ not json');
    writeFileSync(f, JSON.stringify({ enabledPlugins: ['x'] }));
    expect((await disableTelegramAtUserScope(f)).state).toBe('error');
  });
});

describe('Telegram poller detection', () => {
  // Process tree: 1 <- 100 (tmux pane) <- 200 (coordinator wrapper) <- 300 (claude) <- 400 (bun run) <- 500 (bun server.ts)
  //               1 <- 900 (other claude -p) <- 910 (bun run) <- 920 (bun server.ts)
  const tree: Record<number, { parent: number; cmd: string }> = {
    100: { parent: 1, cmd: 'tmux' }, 200: { parent: 100, cmd: 'node minions coordinator run' }, 300: { parent: 200, cmd: 'claude --plugin-dir x' },
    400: { parent: 300, cmd: 'bun run --cwd /p start' }, 500: { parent: 400, cmd: '/usr/local/bin/bun server.ts' },
    900: { parent: 1, cmd: 'claude -p hi' }, 910: { parent: 900, cmd: 'bun run --cwd /p start' }, 920: { parent: 910, cmd: '/usr/local/bin/bun server.ts' },
    600: { parent: 1, cmd: 'vim notes' },
  };
  const proc: PollerProc = { alive: (p) => p in tree, cmdline: (p) => tree[p]?.cmd ?? null, parentOf: (p) => tree[p]?.parent ?? null };
  const noProc: PollerProc = { alive: (p) => p in tree, cmdline: () => null, parentOf: () => null };
  const check = (pidText: string | null, over: Partial<Parameters<typeof checkTelegramPoller>[0]> = {}) => checkTelegramPoller({
    pidFile: '/state/channels/telegram/bot.pid', coordinatorPid: 200, telegram: true, proc,
    readText: async () => { if (pidText === null) throw Object.assign(new Error('nope'), { code: 'ENOENT' }); return pidText; }, ...over,
  });

  it('ok when bot.pid is a server.ts descending from the coordinator wrapper', async () => {
    expect(await check('500')).toMatchObject({ state: 'ok', pid: 500 });
    expect((await check('500')).hint).toBeUndefined();
  });
  it('foreign when another claude session took the bot', async () => {
    const r = await check('920\n');
    expect(r).toMatchObject({ state: 'foreign', pid: 920, hint: POLLER_RECOVERY_HINT });
    expect(r.detail).toMatch(/not the coordinator's/);
  });
  it('missing, dead and stale pid files report no poller with the recovery hint', async () => {
    expect(await check(null)).toMatchObject({ state: 'missing', hint: POLLER_RECOVERY_HINT });
    expect(await check('')).toMatchObject({ state: 'missing' });
    expect(await check('777')).toMatchObject({ state: 'dead', pid: 777, hint: POLLER_RECOVERY_HINT });
    expect(await check('600')).toMatchObject({ state: 'dead', detail: expect.stringMatching(/not a Telegram plugin server/) });
  });
  it('not applicable without a Telegram coordinator; unknown without a process table', async () => {
    expect((await check('500', { telegram: false })).state).toBe('not-applicable');
    expect((await check('500', { coordinatorPid: null })).state).toBe('not-applicable');
    expect((await check('500', { coordinatorPid: 4242 })).state).toBe('not-applicable');
    expect((await check('500', { proc: noProc })).state).toBe('unknown');
  });
  it('the hint names /mcp reconnect and the recover restart', () => {
    expect(POLLER_RECOVERY_HINT).toMatch(/\/mcp and reconnect plugin:telegram:telegram/);
    expect(POLLER_RECOVERY_HINT).toMatch(/minions coordinator restart --recover/);
  });

  it('telegramPollerStatus uses the launch record (wrapper pid, Telegram decision) and the plugin state dir', async () => {
    const { paths } = layout();
    expect((await telegramPollerStatus({ paths, proc })).state).toBe('not-applicable'); // no launch recorded
    writeFileSync(paths.coordinatorLaunch, JSON.stringify({ version: 1, pid: 200, startedAt: 'x', fingerprint: 'f', channel: 'telegram', telegram: { enabled: true, reason: 'r' } }));
    const read = (pid: string) => async (p: string) => { expect(p).toBe(join(paths.telegramStateDir, 'bot.pid')); return pid; };
    expect((await telegramPollerStatus({ paths, proc, readText: read('500') })).state).toBe('ok');
    expect((await telegramPollerStatus({ paths, proc, readText: read('920') })).state).toBe('foreign');
  });

  it('status and doctor report a poller that is not the coordinator\'s, with the fix hint', async () => {
    const foreign = await check('920');
    const line = humanPoller(foreign);
    expect(line).toMatch(/^telegram poller: PROBLEM \(foreign\)/);
    expect(line).toMatch(/hint: .*\/mcp/);
    const base = { paused: { intake: false, starts: false }, configRevision: 1, profile: 'p', deliveryMode: 'local', queue: {}, activeLeases: [], capacity: null, guard: { lastReason: null, updatedAt: null }, coordinatorLock: null } as unknown as StatusReport;
    expect(humanStatus({ ...base, telegramPoller: foreign })).toMatch(/telegram poller: PROBLEM \(foreign\)/);
    expect(humanStatus({ ...base, telegramPoller: { state: 'not-applicable', detail: 'x' } })).not.toMatch(/telegram poller/);

    const tgStatus = (poller: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data: { access: { state: 'ok' }, coordinator: null, poller } }) });
    expect(telegramPollerCheck(tgStatus(foreign))).toMatchObject({ name: 'telegram.poller', status: 'warn', hint: POLLER_RECOVERY_HINT });
    expect(telegramPollerCheck(tgStatus(await check('500')))).toMatchObject({ name: 'telegram.poller', status: 'ok' });
    expect(telegramPollerCheck(tgStatus(await check('500')))).not.toHaveProperty('hint');
    expect(telegramPollerCheck(tgStatus({ state: 'not-applicable', detail: 'x' }))).toBeNull();
    expect(telegramPollerCheck(tgStatus(undefined))).toBeNull(); // an older image
    expect(telegramPollerCheck({ code: 1, stdout: '' })).toBeNull();
  });
});
