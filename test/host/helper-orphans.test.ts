// Doctor's orphaned-helper check (host runtime): `coordinator supervise` / `work dispatch` processes running in this
// project's state dir that are not the lock holders of the live DB (left over from a state restore) are reported with
// the exact kill command; nothing is signalled. stopOrphanHelpers (`minions start`, the helpers) stops the ones that
// stay non-holders through the grace period. Fake process tables and temp SQLite DBs only.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostOrphanHelperCheck, listHelperProcesses, orphanHelperCheck, orphanStopLines, processCwd, stopOrphanHelpers, type HelperProcess } from '../../src/host/helper-orphans.js';
import { readProcessLocks, RuntimeDb } from '../../src/runtime/db.js';
import { tmp } from '../runtime/fixtures.js';

function stateWithLocks(sup: { pid: number; start: string } | null, disp: { pid: number; start: string } | null) {
  const state = join(tmp('minions-orphans-'), 'state');
  mkdirSync(state, { recursive: true });
  const db = new RuntimeDb(join(state, 'minions.db'));
  if (sup) db.acquireSupervisorLock({ pid: sup.pid, start: sup.start, bootId: null }, () => false);
  if (disp) db.acquireSupervisorLock({ pid: disp.pid, start: disp.start, bootId: null }, () => false, new Date(), 'dispatcher_lock');
  db.close();
  return { state, db: join(state, 'minions.db') };
}

const proc = (pid: number, kind: HelperProcess['kind'], cwd: string | null, startTime: string | null = String(pid)): HelperProcess =>
  ({ pid, kind, cwd, startTime, cmdline: kind === 'supervisor' ? 'node /usr/local/bin/minions coordinator supervise' : 'node /usr/local/bin/minions work dispatch' });

describe('orphaned supervisor/dispatcher processes (doctor)', () => {
  it('reports helpers in this state dir that do not hold their lock, with the kill command', () => {
    const s = stateWithLocks({ pid: 200, start: '200' }, { pid: 201, start: '201' });
    const locks = readProcessLocks(s.db);
    expect(locks?.supervisor_lock?.pid).toBe(200);
    expect(locks?.dispatcher_lock?.pid).toBe(201);
    const procs = [
      proc(200, 'supervisor', s.state), proc(201, 'dispatcher', s.state), // the holders
      proc(100, 'supervisor', s.state), proc(101, 'dispatcher', s.state), // orphans of a restore
      proc(300, 'supervisor', '/elsewhere/state'), // another project: not ours
      proc(201, 'supervisor', s.state, '999'), // not a holder: the dispatcher lock does not count for a supervisor
    ];
    const c = orphanHelperCheck(procs, s.state, locks);
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/3 orphaned helper process\(es\).*`coordinator supervise` pid 100, `work dispatch` pid 101, `coordinator supervise` pid 201/);
    expect(c.hint).toMatch(/`kill 100 101 201`/);
  });

  it('a reused pid (other start time) is not the holder; all holders: ok; an unreadable DB reports nothing', async () => {
    const s = stateWithLocks({ pid: 200, start: '200' }, null);
    expect(orphanHelperCheck([proc(200, 'supervisor', s.state, '555')], s.state, readProcessLocks(s.db)).status).toBe('warn');
    expect(orphanHelperCheck([proc(200, 'supervisor', s.state)], s.state, readProcessLocks(s.db))).toMatchObject({ status: 'ok', detail: expect.stringMatching(/1 running, all lock holders/) });
    expect(orphanHelperCheck([proc(100, 'supervisor', s.state)], s.state, null).status).toBe('ok');
    expect(readProcessLocks(join(s.state, 'missing.db'))).toBeNull();
    await expect(hostOrphanHelperCheck(s.state, s.db, async () => [proc(7, 'dispatcher', s.state)])).resolves.toMatchObject({ status: 'warn', hint: expect.stringMatching(/kill 7/) });
  });

  it('lists only supervise/dispatch processes, with their cwd (ps and lsof on macOS, through the runner)', async () => {
    const ps = [
      '   10     1    10 S    Mon Nov  2 09:00:00 2026     node /x/minions coordinator supervise',
      '   11     1    11 S    Mon Nov  2 09:00:01 2026     node /x/minions work dispatch',
      '   12     1    12 S    Mon Nov  2 09:00:02 2026     node /x/minions work dispatcher-status',
      '   13     1    13 S    Mon Nov  2 09:00:03 2026     vim notes.md',
    ].join('\n');
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push(cmd);
      if (cmd === '/bin/ps') return ps;
      if (cmd === '/usr/sbin/lsof') return `p${args[4]}\nfcwd\nn/Users/me/Library/Application Support/Minions/projects/p/host/state\n`;
      return null;
    };
    const got = await listHelperProcesses({ run, platform: 'darwin' });
    expect(got.map((p) => [p.pid, p.kind, p.cwd])).toEqual([
      [10, 'supervisor', '/Users/me/Library/Application Support/Minions/projects/p/host/state'],
      [11, 'dispatcher', '/Users/me/Library/Application Support/Minions/projects/p/host/state'],
    ]);
    expect(got[0]!.startTime).toBe(String(Date.UTC(2026, 10, 2, 9, 0, 0) / 1000));
    expect(calls).toEqual(['/bin/ps', '/usr/sbin/lsof', '/usr/sbin/lsof']);
    expect(await processCwd(10, { platform: 'darwin', run: async () => null })).toBeNull();
    // ps unreadable (a fake runner): nothing listed.
    expect(await listHelperProcesses({ run: async () => null, platform: 'darwin' })).toEqual([]);
  });
});

describe('stopping orphaned helpers (minions start, the helpers)', () => {
  /** A process table that SIGTERM empties of the signalled pid, unless it is in `survivors`. */
  function table(initial: HelperProcess[], survivors: number[] = []) {
    let procs = [...initial];
    const signals: [number, string][] = [];
    return {
      signals,
      set: (next: HelperProcess[]) => { procs = next; },
      procs: async () => procs,
      kill: (pid: number, sig: NodeJS.Signals) => { signals.push([pid, sig]); if (!survivors.includes(pid)) procs = procs.filter((p) => p.pid !== pid); },
    };
  }
  const fast = { graceMs: 1, pollMs: 1, timeoutMs: 50 };

  it('SIGTERMs non-holders of this state dir and leaves the holders and other projects alone', async () => {
    const s = stateWithLocks({ pid: 200, start: '200' }, { pid: 201, start: '201' });
    const t = table([proc(200, 'supervisor', s.state), proc(201, 'dispatcher', s.state), proc(100, 'supervisor', s.state), proc(101, 'dispatcher', s.state), proc(300, 'dispatcher', '/elsewhere')]);
    const r = await stopOrphanHelpers(s.state, { procs: t.procs, locks: () => readProcessLocks(s.db), kill: t.kill, ...fast });
    expect(t.signals).toEqual([[100, 'SIGTERM'], [101, 'SIGTERM']]);
    expect(r.stopped.map((p) => p.pid)).toEqual([100, 101]);
    expect(r.failed).toEqual([]);
    expect(orphanStopLines(r)[0]).toMatch(/stopped orphaned `coordinator supervise` pid 100/);
  });

  it('only the given kinds: a dispatcher never stops a supervisor that is still starting', async () => {
    const s = stateWithLocks(null, { pid: 201, start: '201' });
    const t = table([proc(100, 'supervisor', s.state), proc(101, 'dispatcher', s.state)]);
    const r = await stopOrphanHelpers(s.state, { procs: t.procs, locks: () => readProcessLocks(s.db), kill: t.kill, kinds: ['dispatcher'], ...fast });
    expect(t.signals).toEqual([[101, 'SIGTERM']]);
    expect(r.stopped.map((p) => p.pid)).toEqual([101]);
  });

  it('a helper that takes its lock during the grace period, a reused pid or an unknown start time is not signalled', async () => {
    const s = stateWithLocks(null, null);
    const none = readProcessLocks(s.db)!;
    const t = table([proc(100, 'supervisor', s.state), proc(101, 'dispatcher', s.state), proc(102, 'dispatcher', s.state, null)]);
    let scan = 0;
    const r = await stopOrphanHelpers(s.state, {
      ...fast, procs: t.procs, kill: t.kill,
      // The second scan: 100 took its lock, and 101 exited and its pid now belongs to a new dispatcher.
      locks: () => {
        if (scan++ === 0) return none;
        t.set([proc(100, 'supervisor', s.state), proc(101, 'dispatcher', s.state, '777'), proc(102, 'dispatcher', s.state, null)]);
        return { ...none, supervisor_lock: { pid: 100, start: '100', bootId: null, at: '' } };
      },
    });
    expect(t.signals).toEqual([]);
    expect(r).toEqual({ stopped: [], failed: [] });
  });

  it('reports an orphan that survives SIGTERM, and stops nothing when the DB is unreadable', async () => {
    const s = stateWithLocks(null, null);
    const t = table([proc(100, 'supervisor', s.state)], [100]);
    const r = await stopOrphanHelpers(s.state, { procs: t.procs, locks: () => readProcessLocks(s.db), kill: t.kill, ...fast });
    expect(r.failed.map((p) => p.pid)).toEqual([100]);
    expect(orphanStopLines(r)).toEqual(['orphaned `coordinator supervise` pid 100 did not exit after SIGTERM; stop it with `kill 100`']);
    const t2 = table([proc(100, 'supervisor', s.state)]);
    expect(await stopOrphanHelpers(s.state, { procs: t2.procs, locks: () => null, kill: t2.kill, ...fast })).toEqual({ stopped: [], failed: [] });
    expect(t2.signals).toEqual([]);
  });
});
