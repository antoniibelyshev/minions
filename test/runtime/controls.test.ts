// Plain-language owner controls (task-2.3): each maps to a `minions` command that also runs from the
// host terminal without Claude, and `work cancel` releases worker leases best effort.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/program.js';
import { cancelWork, CONTROLS, controlsTable, matchControl } from '../../src/runtime/controls.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { defaults } from '../helpers.js';
import { makeEnv } from './fixtures.js';

describe('control mapping', () => {
  it.each([
    ['pause intake', ['pause', '--intake']],
    ['Pause starts.', ['pause', '--starts']],
    ['pause', ['pause']],
    ['resume', ['resume']],
    ['Resume intake', ['resume', '--intake']],
    ['status?', ['status']],
    ['/status', ['status']],
    ['sync', ['sync']],
    ['cancel task-2.3', ['work', 'cancel', 'task-2.3', '--reason', 'owner cancelled']],
    ['Cancel TASK-7', ['work', 'cancel', 'task-7', '--reason', 'owner cancelled']],
    ['cancel all', ['work', 'cancel', '--all', '--reason', 'owner cancelled']],
  ])('"%s" maps to minions %j', (text, argv) => {
    expect(matchControl(text)?.argv).toEqual(argv);
  });

  it('leaves anything else to the coordinator', () => {
    for (const text of ['please pause intake for the weekend', 'cancel the dark mode idea', 'cancel task-7; rm -rf /', 'what is the status of task-3?', '']) {
      expect(matchControl(text), text).toBeNull();
    }
  });

  it('quotes nothing unsafe into the shell command', () => {
    expect(matchControl('cancel task-7')!.command).toBe("minions work cancel task-7 --reason 'owner cancelled'");
  });

  it('every control resolves to a registered command and its options', () => {
    const program = buildProgram();
    for (const c of CONTROLS) {
      const argv = c.argv.map((a) => (a === '<task>' ? 'task-1' : a));
      let cmd: Command = program;
      const rest = [...argv];
      while (rest.length && !rest[0]!.startsWith('-')) {
        const next = cmd.commands.find((x) => x.name() === rest[0]);
        if (!next) break;
        cmd = next;
        rest.shift();
      }
      expect(cmd, c.id).not.toBe(program);
      for (const flag of rest.filter((a) => a.startsWith('--'))) {
        expect(cmd.options.map((o) => o.long), `${c.id} ${flag}`).toContain(flag);
      }
    }
  });

  it('terminal equivalents run from the host CLI without Claude: they delegate to the project runtime', async () => {
    // An empty host registry: delegation fails with NOT_FOUND (no project), proving the host path is
    // taken. A runtime-only command would fail with INCOMPATIBLE_RUNTIME instead.
    const home = mkdtempSync(join(tmpdir(), 'minions-controls-home-'));
    const saved = { home: process.env.MINIONS_HOME, runtime: process.env.MINIONS_RUNTIME };
    process.env.MINIONS_HOME = home;
    delete process.env.MINIONS_RUNTIME;
    try {
      const commands = [...CONTROLS.map((c) => c.argv.map((a) => (a === '<task>' ? 'task-1' : a))), ['notify', 'pending'], ['notify', 'ack', 'k']];
      for (const argv of commands) {
        const { out } = await runInProcess([...argv, '--json']);
        const parsed = JSON.parse(out.trim().split('\n').pop()!) as { ok: boolean; error?: { code: string } };
        expect(parsed.ok, argv.join(' ')).toBe(false);
        expect(parsed.error?.code, argv.join(' ')).toBe('NOT_FOUND');
      }
    } finally {
      if (saved.home === undefined) delete process.env.MINIONS_HOME; else process.env.MINIONS_HOME = saved.home;
      if (saved.runtime !== undefined) process.env.MINIONS_RUNTIME = saved.runtime;
    }
  });

  it('the coordinator prompt carries the control table and the outbox flow (Telegram only)', async () => {
    const gen = async (channel: 'telegram' | 'terminal') => {
      const cfg = defaults();
      cfg.communication.channel = channel;
      const dir = mkdtempSync(join(tmpdir(), 'minions-controls-plugin-'));
      await generatePlugin(cfg, dir);
      const { readFile } = await import('node:fs/promises');
      return { coord: await readFile(join(dir, 'coordinator.md'), 'utf8'), orch: await readFile(join(dir, 'skills', 'orchestrate', 'SKILL.md'), 'utf8') };
    };
    const tg = await gen('telegram');
    expect(tg.coord).toContain(controlsTable());
    expect(tg.coord).toContain('minions notify enqueue --key <key>');
    expect(tg.coord).toContain('minions notify ack <key> --json');
    expect(tg.orch).toContain('minions notify pending --json');
    const term = await gen('terminal');
    expect(term.coord).not.toContain('minions notify');
    expect(term.orch).not.toContain('minions notify');
  });
});

describe('minions work cancel (best effort)', () => {
  it('releases the active leases of the named tasks, keeps worktrees, and reports idle tasks', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', title: 'One' });
    env.backlog.add({ id: 'task-2', title: 'Two' });
    const b1 = await env.sched.claim('task-1', 'engineer');
    const b2 = await env.sched.claim('task-2', 'engineer');
    const r = await cancelWork({ db: env.db, release: (id, why) => env.sched.release(id, why) }, { taskIds: ['task-1', 'task-9'] }, 'owner cancelled');
    expect(r.released).toEqual([expect.objectContaining({ leaseId: b1.leaseId, taskId: 'task-1', role: 'engineer', worktree: b1.worktree })]);
    expect(r.idle).toEqual(['task-9']);
    expect(env.db.lease(b1.leaseId)!.status).toBe('released');
    expect(env.db.lease(b2.leaseId)!.status).toBe('active');
    expect(env.backlog.notes.some((n) => n.id === 'task-1' && n.text.includes('owner cancelled'))).toBe(true);
  });

  it('--all continues past a failing release and reports it', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', title: 'One' });
    env.backlog.add({ id: 'task-2', title: 'Two' });
    const b1 = await env.sched.claim('task-1', 'engineer');
    const b2 = await env.sched.claim('task-2', 'engineer');
    const r = await cancelWork({
      db: env.db,
      release: async (id, why) => { if (id === b1.leaseId) throw new Error('boom'); return env.sched.release(id, why); },
    }, { taskIds: [], all: true }, 'stop all');
    expect(r.failed).toEqual([{ leaseId: b1.leaseId, taskId: 'task-1', error: 'boom' }]);
    expect(r.released.map((x) => x.leaseId)).toEqual([b2.leaseId]);
    expect(env.db.activeLeases().map((l) => l.id)).toEqual([b1.leaseId]);
  });
});

/** Runs the CLI in-process (host mode) and captures stdout/stderr; process.exit is trapped. */
async function runInProcess(args: string[]): Promise<{ out: string }> {
  const program = buildProgram();
  let out = '';
  const capture = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } });
    cmd.commands.forEach(capture);
  };
  capture(program);
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const exit = process.exit.bind(process);
  const before = process.exitCode;
  const sink = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  process.exit = ((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as typeof process.exit;
  try {
    await program.parseAsync(['node', 'minions', ...args]);
  } catch { /* exit trapped */ } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    process.exit = exit;
    process.exitCode = before;
  }
  return { out };
}
