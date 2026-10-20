// `minions coordinator restart [--recover] [--force]`: kill + detached relaunch with a recovery startup
// prompt. Everything runs with fakes (tmux runner, spawn); no tmux, claude, or network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { Command } from 'commander';
import type { MinionsConfig } from '../../src/config/schema.js';
import { coordinatorRestartRecorder, register } from '../../src/runtime/commands.js';
import {
  buildClaudeCommand, buildCoordinatorCommand, RECOVERY_PROMPT, restartCoordinator, runCoordinator, TELEGRAM_TOKEN_ENV, type SpawnLike,
} from '../../src/runtime/coordinator.js';
import { evaluateTelegram, TELEGRAM_CHANNEL_SPEC, TELEGRAM_PLUGIN_ID, type TelegramProbeReport } from '../../src/telegram/probe.js';
import { openDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

function layout() {
  const root = tmp('minions-restart-');
  for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
  return {
    ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
    pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
  };
}

/** Fake tmux: tracks whether the session exists. */
function tmux(running: boolean) {
  const calls: string[][] = [];
  let alive = running;
  const runner = async (_cmd: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'kill-session') { alive = false; return { code: 0, stdout: '', stderr: '' }; }
    if (args.includes('new-session')) { alive = true; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { calls, runner };
}

const noSleep = async () => {};
/** --permission-mode choices of the installed Claude Code: never the real `claude --help` (task-38). */
const autoModes = async () => ['acceptEdits', 'auto'];

describe('coordinator restart --recover', () => {
  it('kills the running session and relaunches it detached with the recovery wrapper flag', async () => {
    const paths = layout();
    const t = tmux(true);
    const recorded: unknown[] = [];
    const r = await restartCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [], recordRestart: (i) => recorded.push(i), sleep: noSleep }, { recover: true });
    expect(r).toMatchObject({ action: 'restarted', running: true });
    expect(r.reason).toBe('restart requested; coordinator relaunched detached with the recovery prompt');
    expect(t.calls.map((a) => a.slice(0, 3))).toEqual([
      ['has-session', '-t', 'coordinator'], ['kill-session', '-t', 'coordinator'], ['-u', 'new-session', '-d'], ['has-session', '-t', 'coordinator'],
    ]);
    expect(t.calls[2]!.slice(-4)).toEqual(['minions', 'coordinator', 'run', '--recover']);
    expect(recorded).toEqual([expect.objectContaining({ reason: 'restart requested', leases: [], recover: true })]);
  });

  it('restarts even when the launch fingerprint is unchanged; without --recover the wrapper gets no flag', async () => {
    const paths = layout();
    const { spawn } = fakeSpawn();
    await runCoordinator(defaults(), { paths, spawn, permissionModes: autoModes, env: {}, log: () => {} }); // writes a current launch record
    const t = tmux(true);
    const r = await restartCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [], sleep: noSleep });
    expect(r.action).toBe('restarted');
    expect(t.calls[2]!.slice(-3)).toEqual(['minions', 'coordinator', 'run']);
  });

  it('starts detached when the session is not running and still records the restart', async () => {
    const paths = layout();
    const t = tmux(false);
    const recorded: { leases: string[] }[] = [];
    const r = await restartCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [{ id: 'stale-1' }], recordRestart: (i) => recorded.push(i), sleep: noSleep }, { recover: true });
    expect(r).toMatchObject({ action: 'started', running: true });
    expect(t.calls.some((a) => a[0] === 'kill-session')).toBe(false);
    expect(recorded[0]!.leases).toEqual(['stale-1']); // stale leases of a dead session are left for recover
  });

  it('refuses while worker leases are active in a running session unless --force', async () => {
    const paths = layout();
    const t = tmux(true);
    let recorded = 0;
    const deps = { paths, runner: t.runner, activeLeases: () => [{ id: 'lease-1' }], recordRestart: () => { recorded++; }, sleep: noSleep };
    await expect(restartCoordinator(defaults(), deps, { recover: true })).rejects.toMatchObject({
      code: 'PRECONDITION', message: expect.stringMatching(/restart refused: .*1 active worker lease\(s\) \(lease-1\)/),
    });
    expect(t.calls).toEqual([['has-session', '-t', 'coordinator']]);
    expect(recorded).toBe(0);
    const forced = await restartCoordinator(defaults(), deps, { recover: true, force: true });
    expect(forced.action).toBe('restarted');
    expect(recorded).toBe(1);
  });

  it('records the restart as a coordinator-restart event in the runtime DB', async () => {
    const db = openDb(join(tmp('minions-restart-db-'), 'runtime.db'));
    const t = tmux(true);
    await restartCoordinator(defaults(), { paths: layout(), runner: t.runner, activeLeases: () => [], recordRestart: coordinatorRestartRecorder(db), sleep: noSleep }, { recover: true });
    const rows = db.all<{ kind: string; task_id: string | null; data_json: string }>("SELECT * FROM events WHERE kind = 'coordinator-restart'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_id).toBeNull();
    expect(JSON.parse(rows[0]!.data_json)).toMatchObject({ reason: 'restart requested', leases: [], recover: true });
    expect(JSON.parse(db.getMeta('coordinator_restart')!)).toMatchObject({ recover: true });
  });
});

function fakeSpawn() {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn: SpawnLike = (cmd, args) => {
    calls.push({ cmd, args });
    return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; } } as ReturnType<SpawnLike>;
  };
  return { calls, spawn };
}

describe('recovery startup prompt', () => {
  it('the wrapper passes the recovery prompt to claude as the first user message, after --', async () => {
    const paths = layout();
    const { calls, spawn } = fakeSpawn();
    await runCoordinator(defaults(), { paths, spawn, permissionModes: autoModes, env: {}, log: () => {}, startupPrompt: RECOVERY_PROMPT });
    expect(calls[0]!.args.slice(-2)).toEqual(['--', RECOVERY_PROMPT]);
    const plain = await buildClaudeCommand(defaults(), paths);
    expect(plain.args).not.toContain(RECOVERY_PROMPT);
    expect(calls[0]!.args.slice(0, -2)).toEqual(plain.args);
  });

  it('runs the recover skill, then resumes the queue with orchestrate', () => {
    expect(RECOVERY_PROMPT.startsWith('/minions:recover ')).toBe(true);
    expect(RECOVERY_PROMPT).toContain('/minions:orchestrate');
    expect(RECOVERY_PROMPT).not.toMatch(/^-/);
  });

  it('tmux argv carries only the --recover flag, never the prompt text', async () => {
    const c = await buildCoordinatorCommand(defaults(), layout(), { detached: true, recover: true });
    expect(c.args.slice(-4)).toEqual(['minions', 'coordinator', 'run', '--recover']);
    expect(c.args.join(' ')).not.toContain('orchestrate');
  });
});

// Tester additions: Telegram argv ordering, unchanged plain launch, early death on the restart path,
// --force without a session, secret-free restart events, and CLI wiring.
const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const okRun = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const available = (): TelegramProbeReport => evaluateTelegram({
  claude: okRun('2.1.292 (Claude Code)\n'), bun: okRun('1.4.3\n'),
  marketplaces: okRun(JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' }])),
  plugins: okRun(JSON.stringify([{ id: TELEGRAM_PLUGIN_ID, version: '0.0.7', scope: 'user', enabled: true }])),
  managed: { present: false },
});
const telegramCfg = (): MinionsConfig => { const c = defaults(); c.communication.channel = 'telegram'; return c; };
function tgLayout() {
  const paths = layout();
  writeFileSync(paths.telegramTokenFile, TOKEN + '\n', { mode: 0o600 });
  return paths;
}

describe('recovery prompt with Telegram enabled', () => {
  it('puts `--` and the prompt after every option, including --channels; the token stays in env only', async () => {
    const paths = tgLayout();
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawn: SpawnLike = (_cmd, args, opts) => {
      calls.push({ args, env: opts.env });
      return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; } } as ReturnType<SpawnLike>;
    };
    await runCoordinator(telegramCfg(), { paths, spawn, permissionModes: autoModes, env: {}, probe: async () => available(), log: () => {}, startupPrompt: RECOVERY_PROMPT });
    const args = calls[0]!.args;
    expect(args.slice(-4)).toEqual(['--channels', TELEGRAM_CHANNEL_SPEC, '--', RECOVERY_PROMPT]);
    const dashdash = args.indexOf('--');
    expect(args.filter((a, i) => i < dashdash && a === '--')).toEqual([]);
    expect(args.slice(dashdash + 1)).toEqual([RECOVERY_PROMPT]);
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(calls[0]!.env[TELEGRAM_TOKEN_ENV]).toBe(TOKEN);
  });

  it('a plain launch (no startup prompt) has no `--` and keeps the --settings/--channels order', async () => {
    const paths = tgLayout();
    const calls: string[][] = [];
    const spawn: SpawnLike = (_cmd, args) => {
      calls.push(args);
      return { on(event: string, cb: (...a: unknown[]) => void) { if (event === 'exit') setImmediate(() => cb(0, null)); return this; } } as ReturnType<SpawnLike>;
    };
    await runCoordinator(telegramCfg(), { paths, spawn, permissionModes: autoModes, env: {}, probe: async () => available(), log: () => {} });
    expect(calls[0]).not.toContain('--');
    expect(calls[0]!.slice(-2)).toEqual(['--channels', TELEGRAM_CHANNEL_SPEC]);
    expect(calls[0]!.indexOf('--settings')).toBeLessThan(calls[0]!.indexOf('--channels'));
    expect(calls[0]).toEqual((await buildClaudeCommand(telegramCfg(), paths, { telegram: true })).args);
  });

  it('attached and detached tmux argv without recover are unchanged', async () => {
    const paths = layout();
    const attached = await buildCoordinatorCommand(defaults(), paths);
    expect(attached.args).toEqual(['-u', 'new-session', '-A', '-s', 'coordinator', '-c', paths.repo, '--', 'minions', 'coordinator', 'run']);
    const detached = await buildCoordinatorCommand(defaults(), paths, { detached: true });
    expect(detached.args).toEqual(['-u', 'new-session', '-d', '-s', 'coordinator', '-c', paths.repo, '--', 'minions', 'coordinator', 'run']);
  });
});

describe('coordinator restart edge cases', () => {
  /** tmux whose new session dies right away (the wrapper failed); optionally writes an exit record. */
  function dyingTmux(running: boolean, onStart?: () => void) {
    const calls: string[][] = [];
    let alive = running;
    const runner = async (_cmd: string, args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') { alive = false; return okRun(''); }
      if (args.includes('new-session')) { onStart?.(); alive = false; return okRun(''); }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { calls, runner };
  }

  it('settle check still applies: a wrapper that dies right after a restart fails with its exit error', async () => {
    const paths = layout();
    const t = dyingTmux(true, () => writeFileSync(paths.coordinatorExit, JSON.stringify({ version: 1, pid: 1, at: 'x', code: 1, error: 'coordinator prompt missing' })));
    let slept = -1;
    await expect(restartCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [], sleep: async (ms) => { slept = ms; } }, { recover: true }))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/exited right after starting: coordinator prompt missing/) });
    expect(slept).toBe(2000);
    expect(t.calls.map((a) => a[0] === 'has-session' || a[0] === 'kill-session' ? a[0] : 'new-session')).toEqual(['has-session', 'kill-session', 'new-session', 'has-session']);
  });

  it('a stale exit record from an earlier session is cleared before the restart launch', async () => {
    const paths = layout();
    writeFileSync(paths.coordinatorExit, JSON.stringify({ version: 1, pid: 1, at: 'old', code: 7, error: 'stale old error' }));
    const t = dyingTmux(false);
    await expect(restartCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [], sleep: noSleep }, { recover: true }))
      .rejects.toMatchObject({ message: expect.stringMatching(/no exit record was written/) });
  });

  it('a failing tmux new-session is reported, not treated as started', async () => {
    const paths = layout();
    const runner = async (_cmd: string, args: string[]): Promise<RunResult> =>
      args[0] === 'has-session' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'duplicate session: coordinator' };
    await expect(restartCoordinator(defaults(), { paths, runner, activeLeases: () => [], sleep: noSleep }))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/duplicate session: coordinator/) });
  });

  it('--force without a running session just starts detached (no kill) and records the stale leases', async () => {
    const paths = layout();
    const t = tmux(false);
    const recorded: { reason: string; leases: string[]; recover?: boolean }[] = [];
    const r = await restartCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [{ id: 'stale-1' }, { id: 'stale-2' }], recordRestart: (i) => recorded.push(i), sleep: noSleep }, { force: true });
    expect(r).toMatchObject({ action: 'started', running: true, reason: 'coordinator started detached' });
    expect(t.calls.some((a) => a[0] === 'kill-session')).toBe(false);
    expect(t.calls.find((a) => a.includes('new-session'))!.slice(-3)).toEqual(['minions', 'coordinator', 'run']);
    expect(recorded).toEqual([expect.objectContaining({ reason: 'restart requested; coordinator was not running', leases: ['stale-1', 'stale-2'] })]);
    expect(recorded[0]).not.toHaveProperty('recover');
  });

  it('the forced restart event lists lease ids but never the bot token', async () => {
    const paths = tgLayout();
    const { spawn } = fakeSpawn();
    await runCoordinator(telegramCfg(), { paths, spawn, permissionModes: autoModes, env: {}, probe: async () => available(), log: () => {} });
    const db = openDb(join(tmp('minions-restart-db-'), 'runtime.db'));
    const t = tmux(true);
    const r = await restartCoordinator(telegramCfg(), { paths, runner: t.runner, activeLeases: () => [{ id: 'lease-9' }], recordRestart: coordinatorRestartRecorder(db), sleep: noSleep }, { recover: true, force: true });
    expect(r.action).toBe('restarted');
    const rows = db.all<{ data_json: string }>("SELECT data_json FROM events WHERE kind = 'coordinator-restart'");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.data_json)).toMatchObject({ reason: 'restart requested', leases: ['lease-9'], recover: true });
    const stored = rows[0]!.data_json + db.getMeta('coordinator_restart')! + JSON.stringify(t.calls);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(TOKEN.split(':')[1]!.slice(0, 10));
  });

  it('a running session with a changed fingerprint keeps the config-change reason', async () => {
    const paths = tgLayout();
    const { spawn } = fakeSpawn();
    await runCoordinator(telegramCfg(), { paths, spawn, permissionModes: autoModes, env: {}, probe: async () => available(), log: () => {} });
    const t = tmux(true);
    const r = await restartCoordinator(defaults(), { paths, runner: t.runner, activeLeases: () => [], sleep: noSleep });
    expect(r).toMatchObject({ action: 'restarted', reason: 'communication.channel changed (telegram -> auto); coordinator relaunched detached' });
  });
});

describe('CLI wiring', () => {
  it('registers `coordinator restart --recover --force` and `coordinator run --recover`', () => {
    const program = new Command();
    register(program);
    const coord = program.commands.find((c) => c.name() === 'coordinator')!;
    const flags = (name: string) => coord.commands.find((c) => c.name() === name)!.options.map((o) => o.long);
    expect(flags('restart').sort()).toEqual(['--force', '--recover']);
    expect(flags('run')).toEqual(['--recover']);
    expect(flags('sync').sort()).toEqual(['--force', '--start-detached']);
  });
});
