// Doctor's orphaned-helper check (host runtime): `coordinator supervise` / `work dispatch` processes running in this
// project's state dir that are not the lock holders of the live DB (left over from a state restore) are reported with
// the exact kill command; nothing is signalled. Fake process tables and temp SQLite DBs only.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostOrphanHelperCheck, listHelperProcesses, orphanHelperCheck, processCwd, type HelperProcess } from '../../src/host/helper-orphans.js';
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
