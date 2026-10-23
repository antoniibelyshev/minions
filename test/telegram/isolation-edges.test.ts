// Task-51 tester edge cases: user-scope disable on odd settings files through the real launch path,
// poller detection corner cases, and the nested-session hijack the incident was about. Fakes only:
// no claude, no tmux, no real ~/.claude, no real bot.pid.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { RunResult } from '../../src/core/exec.js';
import { telegramPollerCheck } from '../../src/host/doctor.js';
import { runCoordinator, telegramPollerStatus, type SpawnLike } from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { checkTelegramPoller, disableTelegramAtUserScope, isClaudeCmdline, POLLER_RECOVERY_HINT, type PollerProc } from '../../src/telegram/isolation.js';
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

function layout() {
  const root = tmp('minions-tg-edge-');
  for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  writeFileSync(join(root, 'secrets', 'telegram-bot-token'), TOKEN + '\n', { mode: 0o600 });
  const paths = {
    ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
    pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
  };
  mkdirSync(join(paths.claudeUserSettings, '..'), { recursive: true });
  return { root, paths };
}
function fakeSpawn() {
  const calls: { args: string[] }[] = [];
  const spawn: SpawnLike = (_cmd, args) => {
    calls.push({ args });
    return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; } } as ReturnType<SpawnLike>;
  };
  return { calls, spawn };
}
const flagPlugins = (args: string[]) => (JSON.parse(args[args.indexOf('--settings') + 1]!) as { enabledPlugins?: unknown }).enabledPlugins;

describe('runCoordinator user-scope disable: odd settings files', () => {
  it('a malformed settings.json is left byte-for-byte, a warning is logged, and the coordinator still enables Telegram for itself', async () => {
    const { paths } = layout();
    writeFileSync(paths.claudeUserSettings, '{ "theme": "dark", ');
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(telegramCfg(), { paths, spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: (l) => logs.push(l) });
    expect(readFileSync(paths.claudeUserSettings, 'utf8')).toBe('{ "theme": "dark", ');
    expect(logs.join('\n')).toMatch(/warning: could not turn the Telegram plugin off at user scope \(.*not valid JSON.*\); other claude sessions/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('--channels');
    expect(flagPlugins(calls[0]!.args)).toEqual({ [TELEGRAM_PLUGIN_ID]: true });
  });

  it('a JSON array or a non-object enabledPlugins is never rewritten', async () => {
    for (const body of ['[1,2]', JSON.stringify({ theme: 'x', enabledPlugins: 'all' })]) {
      const { paths } = layout();
      writeFileSync(paths.claudeUserSettings, body);
      const logs: string[] = [];
      await runCoordinator(telegramCfg(), { paths, spawn: fakeSpawn().spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: (l) => logs.push(l) });
      expect(readFileSync(paths.claudeUserSettings, 'utf8')).toBe(body);
      expect(logs.join('\n')).toMatch(/warning: could not turn the Telegram plugin off at user scope/);
    }
  });

  it('an empty file counts as {} and gets the off entry', async () => {
    const { paths } = layout();
    writeFileSync(paths.claudeUserSettings, '  \n');
    await runCoordinator(telegramCfg(), { paths, spawn: fakeSpawn().spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: () => {} });
    expect(JSON.parse(readFileSync(paths.claudeUserSettings, 'utf8'))).toEqual({ enabledPlugins: { [TELEGRAM_PLUGIN_ID]: false } });
  });

  it('keeps every other enabledPlugins entry (true, false, version lists) and every other key, with mode 0600', async () => {
    const { paths } = layout();
    const before = { model: 'opus', hooks: { Stop: [] }, enabledPlugins: { 'a@m': true, 'b@m': false, 'c@m': ['>=1'], [TELEGRAM_PLUGIN_ID]: true } };
    writeFileSync(paths.claudeUserSettings, JSON.stringify(before));
    await runCoordinator(telegramCfg(), { paths, spawn: fakeSpawn().spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: () => {} });
    expect(JSON.parse(readFileSync(paths.claudeUserSettings, 'utf8'))).toEqual({ ...before, enabledPlugins: { ...before.enabledPlugins, [TELEGRAM_PLUGIN_ID]: false } });
    expect(statSync(paths.claudeUserSettings).mode & 0o777).toBe(0o600);
  });

  it('a userScope that throws is caught: warning logged, claude still launched', async () => {
    const { paths } = layout();
    const { calls, spawn } = fakeSpawn();
    const logs: string[] = [];
    await runCoordinator(telegramCfg(), { paths, spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: (l) => logs.push(l),
      userScope: async () => { throw new Error('boom'); } });
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/warning: could not turn the Telegram plugin off at user scope \(boom\)/);
  });

  it('passes create only for a Telegram launch', async () => {
    const { paths } = layout();
    const seen: boolean[] = [];
    const userScope = async (_f: string, o: { create: boolean }) => { seen.push(o.create); return { state: 'absent' as const, detail: '' }; };
    await runCoordinator(telegramCfg(), { paths, spawn: fakeSpawn().spawn, env: {}, permissionModes: autoModes, probe: async () => available(), log: () => {}, userScope });
    const term = defaults(); term.communication.channel = 'terminal';
    await runCoordinator(term, { paths, spawn: fakeSpawn().spawn, env: {}, permissionModes: autoModes, log: () => {}, userScope });
    expect(seen).toEqual([true, false]);
  });
});

describe('disableTelegramAtUserScope: read and write failures', () => {
  it('an unreadable file (EACCES) is an error and nothing is written', async () => {
    let wrote = false;
    const r = await disableTelegramAtUserScope('/x/settings.json', { create: true,
      readText: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, write: async () => { wrote = true; } });
    expect(r).toMatchObject({ state: 'error', detail: expect.stringMatching(/unreadable \(EACCES\)/) });
    expect(wrote).toBe(false);
  });
  it('a failing write is an error, not a throw', async () => {
    const r = await disableTelegramAtUserScope('/x/settings.json', { readText: async () => '{}', write: async () => { throw Object.assign(new Error('ro'), { code: 'EROFS' }); } });
    expect(r).toMatchObject({ state: 'error', detail: expect.stringMatching(/could not write .*EROFS/) });
  });
  it('already off: no write at all', async () => {
    let wrote = false;
    const r = await disableTelegramAtUserScope('/x/settings.json', { readText: async () => JSON.stringify({ enabledPlugins: { [TELEGRAM_PLUGIN_ID]: false } }), write: async () => { wrote = true; } });
    expect(r.state).toBe('already-disabled');
    expect(wrote).toBe(false);
  });
});

describe('poller detection corner cases', () => {
  // Real container shape (ps --forest, 2026-10-23): tmux <- wrapper <- claude <- bun run <- bun server.ts.
  // The coordinator claude's Bash tool (and so every worker subagent's commands) runs as a child of
  // that claude: 300 <- 700 (bash) <- 710 (nested `claude -p`) <- 720 (bun run) <- 730 (bun server.ts).
  const tree: Record<number, { parent: number; cmd: string }> = {
    100: { parent: 1, cmd: 'tmux' }, 200: { parent: 100, cmd: 'node /usr/local/bin/minions coordinator run --recover' },
    300: { parent: 200, cmd: 'claude --plugin-dir /opt/minions/plugin --channels plugin:telegram@claude-plugins-official' },
    400: { parent: 300, cmd: 'bun run --cwd /p --shell=bun --silent start' }, 500: { parent: 400, cmd: '/usr/local/bin/bun server.ts' },
    700: { parent: 300, cmd: '/bin/bash -c claude -p hi' }, 710: { parent: 700, cmd: 'claude -p hi' },
    720: { parent: 710, cmd: 'bun run --cwd /p --shell=bun --silent start' }, 730: { parent: 720, cmd: '/usr/local/bin/bun server.ts' },
    800: { parent: 801, cmd: 'bun server.ts' }, 801: { parent: 800, cmd: 'loop' }, // a parent cycle (corrupt table)
    850: { parent: 851, cmd: 'bun server.ts' }, // parent vanished mid-walk
  };
  const proc: PollerProc = { alive: (p) => p in tree || p === 851, cmdline: (p) => tree[p]?.cmd ?? null, parentOf: (p) => tree[p]?.parent ?? null };
  const check = (pidText: string, over: Partial<Parameters<typeof checkTelegramPoller>[0]> = {}) => checkTelegramPoller({
    pidFile: '/s/bot.pid', coordinatorPid: 200, telegram: true, proc, readText: async () => pidText, ...over,
  });

  it('the coordinator\'s own MCP server (bun run wrapper between claude and server.ts) is ok', async () => {
    expect(await check('500\n')).toMatchObject({ state: 'ok', pid: 500 });
  });
  it('garbage, pid 1 and negative pids count as no poller', async () => {
    for (const t of ['abc', '1', '-5', '0']) expect((await check(t)).state).toBe('missing');
  });
  it('a parent cycle or a vanished parent ends the walk as foreign, never hangs', async () => {
    expect((await check('800')).state).toBe('foreign');
    expect((await check('850')).state).toBe('foreign');
  });
  it('an unreadable bot.pid is unknown (no hint), and doctor shows it as warn', async () => {
    const r = await check('', { readText: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    expect(r).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/EACCES/) });
    const d = telegramPollerCheck({ code: 0, stdout: JSON.stringify({ ok: true, data: { poller: r } }) });
    expect(d).toMatchObject({ name: 'telegram.poller', status: 'warn' });
  });
  it('doctor warns with the hint for missing and dead pollers', async () => {
    for (const r of [await check('abc'), await check('9999')]) {
      expect(telegramPollerCheck({ code: 0, stdout: JSON.stringify({ ok: true, data: { poller: r } }) })).toMatchObject({ status: 'warn', hint: POLLER_RECOVERY_HINT });
    }
    expect(telegramPollerCheck({ code: 0, stdout: 'not json' })).toBeNull();
    expect(telegramPollerCheck({ code: 0, stdout: JSON.stringify({ ok: false }) })).toBeNull();
  });

  // The incident's hijacker was a `claude -p` started from inside the coordinator's process tree (a
  // worker subagent's Bash runs under the coordinator claude). Its server.ts descends from the wrapper
  // too; it is foreign because its nearest claude ancestor is not the wrapper's child.
  it('a poller started by a nested claude -p under the coordinator claude is foreign', async () => {
    expect(await check('730')).toMatchObject({ state: 'foreign', pid: 730, hint: POLLER_RECOVERY_HINT });
  });

  it('the real coordinator tree (wrapper -> claude -> bun run -> bun server.ts) is ok, also with claude run by node', async () => {
    // Copied from the live container (ps, 2026-10-23): argv0 `claude`, a long --append-system-prompt.
    const live: Record<number, { parent: number; cmd: string }> = {
      1559057: { parent: 1559000, cmd: 'node /usr/local/bin/minions coordinator run' },
      1559095: { parent: 1559057, cmd: 'claude --plugin-dir /opt/minions/plugin --append-system-prompt # Minions coordinator\n\nYou are the coordinator --permission-mode auto --settings {"permissions":{}}' },
      1559142: { parent: 1559095, cmd: 'bun run --cwd /home/node/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --shell=bun --silent start' },
      1559149: { parent: 1559142, cmd: '/usr/local/bin/bun server.ts' },
      1621313: { parent: 1559095, cmd: '/bin/bash -c source snap.sh && eval \'claude -p hi\'' },
      1621320: { parent: 1621313, cmd: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi' },
      1621330: { parent: 1621320, cmd: 'bun run --cwd /p --shell=bun --silent start' },
      1621340: { parent: 1621330, cmd: '/usr/local/bin/bun server.ts' },
    };
    const liveProc: PollerProc = { alive: (p) => p in live || p === 1559000, cmdline: (p) => live[p]?.cmd ?? null, parentOf: (p) => live[p]?.parent ?? null };
    const run = (pid: string, coordinatorPid = 1559057, p = liveProc) => checkTelegramPoller({ pidFile: '/s/bot.pid', coordinatorPid, telegram: true, proc: p, readText: async () => pid });
    expect(await run('1559149')).toMatchObject({ state: 'ok', pid: 1559149 });
    expect((await run('1621340')).state).toBe('foreign'); // node-run nested claude under a worker's bash
    const viaNode: Record<number, { parent: number; cmd: string }> = { ...live, 1559095: { parent: 1559057, cmd: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --channels x' } };
    expect((await run('1559149', 1559057, { ...liveProc, cmdline: (p) => viaNode[p]?.cmd ?? null })).state).toBe('ok');
  });

  it('fails toward foreign when no claude sits between poller and wrapper, or an ancestor is unreadable', async () => {
    const t: Record<number, { parent: number; cmd: string | null }> = {
      200: { parent: 1, cmd: 'node minions coordinator run' },
      310: { parent: 200, cmd: 'bun run start' }, 320: { parent: 310, cmd: 'bun server.ts' }, // server.ts straight under the wrapper
      330: { parent: 200, cmd: null }, 340: { parent: 330, cmd: 'bun server.ts' }, // unreadable ancestor
      350: { parent: 1, cmd: 'bun server.ts' }, // orphan reparented to init
    };
    const p: PollerProc = { alive: (x) => x in t, cmdline: (x) => t[x]?.cmd ?? null, parentOf: (x) => t[x]?.parent ?? null };
    for (const pid of ['320', '340', '350']) expect((await check(pid, { proc: p })).state).toBe('foreign');
  });

  it('isClaudeCmdline looks at argv0 (and argv1 after an interpreter) only', () => {
    for (const c of ['claude -p hi', '/usr/local/bin/claude --channels x', 'claude.exe', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe -p',
      'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'bun /x/claude']) expect(isClaudeCmdline(c)).toBe(true);
    for (const c of ['/bin/bash -c claude -p hi', 'timeout 60 claude -p', 'bun run start', 'bun server.ts', 'node minions coordinator run', 'claude-plugin x', '', 'vim claude'])
      expect(isClaudeCmdline(c)).toBe(false);
  });

  it('telegramPollerStatus: a launch record without Telegram is not applicable; a dead wrapper too', async () => {
    const { paths } = layout();
    const rec = (enabled: boolean, pid: number) => writeFileSync(paths.coordinatorLaunch, JSON.stringify({ version: 1, pid, startedAt: 'x', fingerprint: 'f', channel: 'telegram', telegram: { enabled, reason: 'r' } }));
    rec(false, 200);
    expect((await telegramPollerStatus({ paths, proc, readText: async () => '730' })).state).toBe('not-applicable');
    rec(true, 4242);
    expect((await telegramPollerStatus({ paths, proc, readText: async () => '500' })).state).toBe('not-applicable');
    rec(true, 200);
    expect((await telegramPollerStatus({ paths, proc, readText: async () => '500' })).state).toBe('ok');
  });
});
