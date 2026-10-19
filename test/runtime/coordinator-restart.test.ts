// `minions coordinator restart [--recover] [--force]`: kill + detached relaunch with a recovery startup
// prompt. Everything runs with fakes (tmux runner, spawn); no tmux, claude, or network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { coordinatorRestartRecorder } from '../../src/runtime/commands.js';
import {
  buildClaudeCommand, buildCoordinatorCommand, RECOVERY_PROMPT, restartCoordinator, runCoordinator, type SpawnLike,
} from '../../src/runtime/coordinator.js';
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
    await runCoordinator(defaults(), { paths, spawn, env: {}, log: () => {} }); // writes a current launch record
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
    await runCoordinator(defaults(), { paths, spawn, env: {}, log: () => {}, startupPrompt: RECOVERY_PROMPT });
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
