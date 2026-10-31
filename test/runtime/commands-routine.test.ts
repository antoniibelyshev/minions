// CLI wiring of the routine pass (task-68.2): `minions sync --routine [--trigger] [--force] [--last]` through the real
// commander program, the runtime DB and the routine event, with the scheduler and the detached restarts stubbed (routine.test.ts covers the pass logic; this covers the flags, the deps the CLI builds, the exit
// code and what `--last` and `status` read back). Nothing here spawns a process.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const h = vi.hoisted(() => ({
  runnable: [] as { taskId: string; role: string }[],
  crashStart: vi.fn(() => ({ action: 'start-scheduled' as const, log: 'x', pid: 1, reason: 'fake crash start' })),
  wake: vi.fn(() => ({ action: 'restart-scheduled' as const, log: 'x', pid: 1, reason: 'fake wake' })),
}));

vi.mock('../../src/backlog/factory.js', async (orig) => ({ ...(await orig<object>()), openBacklog: () => ({}) }));
vi.mock('../../src/runtime/scheduler.js', async (orig) => ({
  ...(await orig<object>()),
  Scheduler: class { next = async () => ({ runnable: h.runnable }); },
}));
vi.mock('../../src/runtime/coordinator.js', async (orig) => ({
  ...(await orig<object>()),
  scheduleCrashStart: h.crashStart,
  scheduleDetachedRestart: h.wake,
}));

// The CLI caches its config per process (each clock pass is a fresh process): reload the module after a change.
let register: (p: Command) => void;

let root = '';
let state = '';
async function writeConfig(routine?: Record<string, unknown>) {
  writeFileSync(join(root, 'config.json'), JSON.stringify({ ...defaults('project-owner'), ...(routine ? { routine } : {}) }));
  vi.resetModules();
  register = (await import('../../src/runtime/commands.js')).register;
}

beforeAll(async () => {
  root = tmp();
  state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  process.env.MINIONS_RUNTIME = 'container';
  process.env.MINIONS_STATE_DIR = state;
  process.env.MINIONS_CONFIG = join(root, 'config.json');
  process.env.MINIONS_WORKSPACE = join(root, 'workspace');
  await writeConfig();
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

async function run(...args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  register(program);
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  // A refused command exits through handleError: record the code instead of ending the test process.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw Object.assign(new Error('exit'), { exitCode: code }); }) as never);
  try {
    await program.parseAsync(['node', 'minions', ...args]);
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode;
    if (code === undefined) throw e;
    out.push(`\nexit ${code}`);
  } finally { vi.restoreAllMocks(); }
  return out.join('');
}
const json = async (...args: string[]) => (JSON.parse(await run('--json', ...args)) as { data: Record<string, any> }).data;

describe('minions sync --routine (CLI)', () => {
  it('rejects sync without --routine and an unknown trigger', async () => {
    for (const args of [['sync'], ['sync', '--last'], ['sync', '--force'], ['sync', '--trigger', 'clock']]) {
      expect(await run('--json', ...args)).toMatch(/only runs the routine pass: pass --routine[\s\S]*exit 11/);
    }
    expect(await run('--json', 'sync', '--routine', '--trigger', 'cron')).toMatch(/--trigger must be one of clock, watchdog, manual/);
  });

  it('routine off: clock and watchdog skip; a manual pass runs, never wakes, and --last reads it', async () => {
    await writeConfig();
    for (const trigger of ['clock', 'watchdog']) {
      const r = await json('sync', '--routine', '--trigger', trigger);
      expect(r).toMatchObject({ ran: false, skipped: 'disabled', nextAt: null });
    }
    const r = await json('sync', '--routine');
    expect(r).toMatchObject({ ran: true, trigger: 'manual', decision: { action: 'none', why: 'routine.enabled is off' } });
    expect(process.exitCode).toBeUndefined();
    const last = await json('sync', '--routine', '--last');
    expect(last).toMatchObject({ enabled: false, last: { at: r.at, trigger: 'manual' }, nextAt: null });
    expect(await run('sync', '--routine', '--last')).toMatch(/^routine: off \(routine\.enabled\); last pass /);
    // A second manual pass right away is refused by the interval; --force runs it.
    expect(await json('sync', '--routine')).toMatchObject({ ran: false, skipped: 'interval' });
    expect(await json('sync', '--routine', '--force')).toMatchObject({ ran: true });
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.crashStart).not.toHaveBeenCalled();
  });

  it('routine on, coordinator crashed (exit record, no lock): the CLI wires the crash start; a stop is never restarted', async () => {
    await writeConfig({ enabled: true, tickMinutes: 15 });
    writeFileSync(join(state, 'coordinator-exit.json'), JSON.stringify({ version: 1, at: new Date(Date.now() - 3_600_000).toISOString(), code: 1, error: 'boom' }));
    const r = await json('sync', '--routine', '--force');
    expect(r).toMatchObject({ ran: true, decision: { action: 'crash-start' }, outcome: { ok: true, detail: 'fake crash start' }, coordinator: { running: false } });
    expect(h.crashStart).toHaveBeenCalledTimes(1);
    expect(h.wake).not.toHaveBeenCalled();
    // An owner stop (exit 0) is not a crash: nothing is started.
    writeFileSync(join(state, 'coordinator-exit.json'), JSON.stringify({ version: 1, at: new Date().toISOString(), code: 0 }));
    const s = await json('sync', '--routine', '--force');
    expect(s.decision).toMatchObject({ action: 'none' });
    expect(h.crashStart).toHaveBeenCalledTimes(1);
    // status shows the last and next pass.
    const st = await json('status');
    expect(st.routine).toMatchObject({ enabled: true, tickMinutes: 15, last: { at: s.at } });
    expect(Date.parse(st.routine.nextAt) - Date.parse(s.at)).toBe(15 * 60_000);
  });
});
