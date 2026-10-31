// macOS process facts (task-103.2, docs/design/host-runtime.md phase 1): the `ps`/`sysctl` view behind the coordinator
// lock, signalDescendants, the Telegram poller check, the supervisor and integration locks, and the run records. No
// real macOS here: fake `ps` and `sysctl` runners render a process table the way macOS prints it (C locale, UTC).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  coordinatorPidAlive, descendantsOf, processControlFor, psProcessControl, signalDescendants, systemProcessControl, type ProcessControl,
} from '../../src/runtime/coordinator.js';
import type { SupervisorLock } from '../../src/runtime/db.js';
import { integratorAlive, reapVerifyGroup } from '../../src/runtime/integrator.js';
import {
  bootIdFrom, parsePsLine, PS_BIN, psArgs, psProcessFacts, SYSCTL_BIN, systemCommandRunner, systemProcessFacts, type CommandRunner, type ProcessFacts,
} from '../../src/runtime/process-facts.js';
import { groupMembers, hostIdentity, isAlive, procIdentity, procStat, sameHost } from '../../src/runtime/runner/record.js';
import { lockViewFor, supervisorAlive, systemLockView } from '../../src/runtime/supervisor.js';
import { claudeOwner } from '../../src/telegram/isolation.js';

interface FakeProc { pid: number; ppid: number; pgid?: number; stat?: string; start: number; cmd: string }

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
/** `lstart` as macOS prints it with LC_ALL=C TZ=UTC: `Thu Oct  9 10:00:00 2026` (day padded to two columns). */
const lstart = (epochSec: number) => {
  const d = new Date(epochSec * 1000);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
};
const psLine = (p: FakeProc) => `${String(p.pid).padStart(5)} ${String(p.ppid).padStart(5)} ${String(p.pgid ?? p.pid).padStart(5)} ${(p.stat ?? 'S').padEnd(4)} ${lstart(p.start)} ${p.cmd}`;

/** A fake `ps`/`sysctl` runner over a mutable table; records every call. */
function fakeHost(procs: FakeProc[], boot: { uuid?: string | null; boottime?: string | null } = { uuid: 'BOOT-1' }) {
  const calls: string[][] = [];
  const state = { procs, boot };
  const run: CommandRunner = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === PS_BIN) {
      const i = args.indexOf('-p');
      const rows = i >= 0 ? state.procs.filter((p) => p.pid === Number(args[i + 1])) : state.procs;
      if (i >= 0 && !rows.length) return null; // ps exits 1 for a missing pid
      return rows.map(psLine).join('\n') + '\n';
    }
    if (cmd === SYSCTL_BIN && args.includes('kern.bootsessionuuid')) return state.boot.uuid ? `${state.boot.uuid}\n` : null;
    if (cmd === SYSCTL_BIN && args.includes('kern.boottime')) return state.boot.boottime ?? null;
    return null;
  };
  return { run, calls, state, facts: psProcessFacts(run) };
}

const T0 = 1_793_000_000; // 2026-10-26
const SELF = process.pid; // a live pid, so the kill(0) liveness check passes for it

describe('ps output parsing', () => {
  it('keeps the spaces of a command line and reads lstart as UTC epoch seconds', () => {
    const p = parsePsLine(`  812     1   812 Ss   Thu Oct  9 07:05:03 2026 /usr/local/bin/node /Users/ada/Library/Application Support/minions/cli.js coordinator run  --x`);
    expect(p).toEqual({ pid: 812, ppid: 1, pgid: 812, state: 'S', startTime: String(Date.UTC(2026, 9, 9, 7, 5, 3) / 1000),
      cmdline: '/usr/local/bin/node /Users/ada/Library/Application Support/minions/cli.js coordinator run  --x' });
    expect(parsePsLine(psLine({ pid: 9, ppid: 2, stat: 'Z', start: T0, cmd: '<defunct>' }))).toMatchObject({ pid: 9, state: 'Z', startTime: String(T0) });
  });

  it('rejects lines that are not in the C-locale lstart format', () => {
    expect(parsePsLine('')).toBeNull();
    expect(parsePsLine('  PID  PPID')).toBeNull();
    expect(parsePsLine('  812     1   812 Ss   jeu 9 oct 07:05:03 2026 node x')).toBeNull(); // a French locale
    expect(parsePsLine('  812     1   812 Ss   Thu Okt  9 07:05:03 2026 node x')).toBeNull();
  });

  it('asks ps for one -o per field, unlimited width, one pid or all; runs with LC_ALL=C and TZ=UTC', () => {
    expect(psArgs(42)).toEqual(['-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command=', '-p', '42']);
    expect(psArgs().at(-1)).toBe('-A');
    const env = systemCommandRunner('/usr/bin/env', []) ?? '';
    expect(env.split('\n')).toEqual(expect.arrayContaining(['LC_ALL=C', 'TZ=UTC']));
    expect(systemCommandRunner('/nonexistent/ps', [])).toBeNull();
  });

  it('boot id: kern.bootsessionuuid, else kern.boottime, else unknown', () => {
    expect(bootIdFrom(fakeHost([], { uuid: 'A1B2-C3' }).run)).toBe('A1B2-C3');
    expect(bootIdFrom(fakeHost([], { uuid: null, boottime: '{ sec = 1792990000, usec = 51234 } Sun Oct 25 08:46:40 2026\n' }).run)).toBe('boottime:1792990000.51234');
    expect(bootIdFrom(fakeHost([], { uuid: null, boottime: null }).run)).toBeNull();
  });
});

describe('platform selection', () => {
  it('uses ps on darwin only; Linux keeps /proc', () => {
    expect(systemProcessFacts('linux')).toBeNull();
    expect(systemProcessFacts('darwin')).not.toBeNull();
    if (process.platform !== 'linux') return;
    expect(systemProcessControl.table).toBeUndefined(); // the /proc control, unchanged
    expect(processControlFor('linux').cmdline(process.pid)).toBe(readFileSync(`/proc/${process.pid}/cmdline`, 'utf8').split('\0').join(' ').trim());
    expect(lockViewFor('linux').bootId()).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    expect(systemLockView.bootId()).toBe(lockViewFor('linux').bootId());
  });
});

describe('coordinator lock and descendants from ps', () => {
  const wrapper = (start = T0): FakeProc => ({ pid: SELF, ppid: 1, start, cmd: '/usr/local/bin/node /Users/ada/Library/Application Support/minions/cli.js coordinator run' });

  it('a holder is live with the recorded start time and a wrapper command line; a reused pid is not', () => {
    const h = fakeHost([wrapper()]);
    const pc = processControlFor('darwin', h.facts);
    expect(pc.startTime(SELF)).toBe(String(T0));
    expect(coordinatorPidAlive(SELF, { start: String(T0) }, pc)).toBe(true);
    // PID reuse: same pid, later start (another process now) -> the lock is free.
    h.state.procs = [wrapper(T0 + 3600)];
    expect(coordinatorPidAlive(SELF, { start: String(T0) }, pc)).toBe(false);
    // Same start second but another program (reused within the second): the command line decides.
    h.state.procs = [{ ...wrapper(), cmd: 'tmux new-session -A -s coordinator minions coordinator run' }];
    expect(coordinatorPidAlive(SELF, { start: String(T0) }, pc)).toBe(false);
    // ps cannot read it: the old no-/proc rule (a live pid counts as the holder; nothing is signalled).
    h.state.procs = [];
    expect(coordinatorPidAlive(SELF, { start: String(T0) }, pc)).toBe(true);
  });

  it('signalDescendants walks one ps snapshot deepest first and re-checks each parent before signalling', () => {
    const h = fakeHost([
      { pid: 100, ppid: 1, start: T0, cmd: 'node cli.js coordinator run' },
      { pid: 101, ppid: 100, start: T0, cmd: 'claude --channels plugin:telegram' },
      { pid: 102, ppid: 101, start: T0, cmd: 'bun server.ts' },
      { pid: 103, ppid: 101, start: T0, cmd: 'node mcp.js' },
      { pid: 200, ppid: 1, start: T0, cmd: 'unrelated' },
    ]);
    const killed: string[] = [];
    const pc: ProcessControl = { ...psProcessControl(h.facts), alive: (p) => h.state.procs.some((x) => x.pid === p), kill: (p, s) => { killed.push(`${s} ${p}`); } };
    expect(descendantsOf(pc, 100).map((d) => d.pid)).toEqual([103, 102, 101]);
    expect(h.calls.filter((c) => c.includes('-A'))).toHaveLength(1); // one snapshot, not one ps per pid
    // 103 was reparented to launchd after the snapshot: the fresh ps re-check before the signal skips it.
    const snapshot = pc.table!();
    h.state.procs = h.state.procs.map((p) => (p.pid === 103 ? { ...p, ppid: 1 } : p));
    const stale: ProcessControl = { ...pc, table: () => snapshot };
    expect(signalDescendants(stale, 100, 'SIGKILL', () => true)).toEqual(['SIGKILL 102', 'SIGKILL 101']);
    expect(killed).toEqual(['SIGKILL 102', 'SIGKILL 101']);
  });
});

describe('Telegram poller ownership from ps', () => {
  const table: FakeProc[] = [
    { pid: SELF, ppid: 1, start: T0, cmd: 'node cli.js coordinator run' },
    { pid: 5001, ppid: SELF, start: T0, cmd: '/Users/ada/.local/bin/claude --channels plugin:telegram@claude-plugins-official' },
    { pid: 5002, ppid: 5001, start: T0, cmd: 'bun run --cwd /Users/ada/Library/Application Support/tg --silent start' },
    { pid: 5003, ppid: 5002, start: T0, cmd: 'bun server.ts' },
    { pid: 6001, ppid: 5001, start: T0, cmd: 'bash -c claude -p hi' },
    { pid: 6002, ppid: 6001, start: T0, cmd: 'node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi' },
    { pid: 6003, ppid: 6002, start: T0, cmd: 'bun server.ts' },
  ];

  it('claudeOwner tells the coordinator claude from a nested session (no longer unknown on macOS)', () => {
    const pc = psProcessControl(fakeHost(table).facts);
    expect(claudeOwner(5003, SELF, pc)).toBe('coordinator');
    expect(claudeOwner(6003, SELF, pc)).toBe('other');
    expect(claudeOwner(4242, SELF, pc)).toBe('unknown'); // not in the table
  });


});

describe('supervisor and integration locks from ps and sysctl', () => {
  const integrator = (start = T0, cmd = '/usr/local/bin/node /Users/ada/minions/cli.js work integrate --detached'): FakeProc => ({ pid: SELF, ppid: 1, start, cmd });
  const launchd: FakeProc = { pid: 1, ppid: 0, start: T0 - 86_400, cmd: '/sbin/launchd' };
  /** The lock exactly as runIntegrator/runSupervisor record it: procIdentity and hostIdentity from the same source. */
  async function takeLock(facts: ProcessFacts): Promise<SupervisorLock> {
    const self = await procIdentity(SELF, facts);
    const host = await hostIdentity(facts);
    return { pid: SELF, start: self?.startTime ?? null, bootId: host?.bootId ?? null, at: new Date(T0 * 1000).toISOString() };
  }

  it('integratorAlive: live in the same boot, stale after a reboot, after PID reuse or with another command line', async () => {
    const h = fakeHost([launchd, integrator()]);
    const lock = await takeLock(h.facts);
    expect(lock).toMatchObject({ start: String(T0), bootId: 'BOOT-1' });
    const view = lockViewFor('darwin', h.facts);
    expect(integratorAlive(lock, view)).toBe(true);
    // Reboot: the pid exists again (a new process), the boot session differs.
    h.state.boot = { uuid: 'BOOT-2' };
    expect(integratorAlive(lock, view)).toBe(false);
    h.state.boot = { uuid: 'BOOT-1' };
    // PID reuse: same pid, another start time.
    h.state.procs = [launchd, integrator(T0 + 60)];
    expect(integratorAlive(lock, view)).toBe(false);
    // Same pid and start second, but not `work integrate`.
    h.state.procs = [launchd, integrator(T0, 'node cli.js work record x')];
    expect(integratorAlive(lock, view)).toBe(false);
  });

  it('a pre-reboot lock is stale even when only kern.boottime is readable', async () => {
    const h = fakeHost([launchd, integrator()], { uuid: null, boottime: '{ sec = 1792990000, usec = 1 } Sun Oct 25 2026\n' });
    const lock = await takeLock(h.facts);
    expect(lock.bootId).toBe('boottime:1792990000.1');
    const view = lockViewFor('darwin', h.facts);
    expect(integratorAlive(lock, view)).toBe(true);
    h.state.boot = { uuid: null, boottime: '{ sec = 1793100000, usec = 9 } Tue Oct 27 2026\n' };
    expect(integratorAlive(lock, view)).toBe(false);
  });

  it('supervisorAlive follows the same rule with the `coordinator supervise` command line', async () => {
    const h = fakeHost([launchd, { pid: SELF, ppid: 1, start: T0, cmd: 'node /Users/ada/minions/cli.js coordinator supervise' }]);
    const lock = await takeLock(h.facts);
    const view = lockViewFor('darwin', h.facts);
    expect(supervisorAlive(lock, view)).toBe(true);
    h.state.boot = { uuid: 'BOOT-2' };
    expect(supervisorAlive(lock, view)).toBe(false);
  });
});

describe('run record identities from ps and sysctl', () => {
  const launchd: FakeProc = { pid: 1, ppid: 0, start: T0 - 86_400, cmd: '/sbin/launchd' };

  it('hostIdentity is the boot session and launchd start; a reboot is another host', async () => {
    const h = fakeHost([launchd]);
    const before = await hostIdentity(h.facts);
    expect(before).toEqual({ bootId: 'BOOT-1', containerStart: String(T0 - 86_400) });
    h.state.boot = { uuid: 'BOOT-2' };
    h.state.procs = [{ ...launchd, start: T0 + 100 }];
    expect(sameHost(before, await hostIdentity(h.facts))).toBe(false);
    h.state.boot = { uuid: null, boottime: null };
    expect(await hostIdentity(h.facts)).toBeNull();
  });

  it('isAlive: same pid and start; a reused pid or a zombie is gone', async () => {
    const h = fakeHost([launchd, { pid: 700, ppid: 1, start: T0, cmd: 'npm test' }]);
    const id = await procIdentity(700, h.facts);
    expect(id).toEqual({ pid: 700, startTime: String(T0) });
    expect(await isAlive(id, h.facts)).toBe(true);
    h.state.procs = [launchd, { pid: 700, ppid: 1, start: T0 + 5, cmd: 'npm test' }];
    expect(await isAlive(id, h.facts)).toBe(false);
    h.state.procs = [launchd, { pid: 700, ppid: 1, stat: 'Z', start: T0, cmd: '<defunct>' }];
    expect(await isAlive(id, h.facts)).toBe(false);
    expect(await procStat(701, h.facts)).toBeNull();
  });

  it('reapVerifyGroup stops only the recorded leader group, never after a reboot or PID reuse', async () => {
    const group: FakeProc[] = [
      launchd,
      { pid: 700, ppid: 1, pgid: 700, start: T0, cmd: 'sh -c npm test' },
      { pid: 701, ppid: 700, pgid: 700, start: T0 + 1, cmd: 'node vitest' },
      { pid: 702, ppid: 1, pgid: 700, start: T0 - 10, cmd: 'older member of a reused pgid' },
      { pid: 703, ppid: 701, pgid: 700, stat: 'Z', start: T0 + 2, cmd: '<defunct>' },
      { pid: 800, ppid: 1, pgid: 800, start: T0, cmd: 'other group' },
    ];
    const row = { verify_pid: 700, verify_start: String(T0), verify_boot: 'BOOT-1' };
    const run = async (h: ReturnType<typeof fakeHost>) => {
      const sent: string[] = [];
      const pids = await reapVerifyGroup(row, { proc: h.facts, graceMs: 0, sleep: async () => undefined, kill: (pid, sig) => {
        sent.push(`${sig} ${pid}`);
        if (pid === -700 && sig === 'SIGKILL') h.state.procs = h.state.procs.filter((p) => p.pid !== 700);
      } });
      return { pids, sent };
    };
    expect(await groupMembers(700, String(T0), fakeHost(group).facts)).toEqual([700, 701]);
    const live = await run(fakeHost([...group]));
    expect(live.pids.sort()).toEqual([700, 701]);
    expect(live.sent).toEqual(['SIGTERM -700', 'SIGKILL -700', 'SIGKILL 701']);
    expect(await run(fakeHost([...group], { uuid: 'BOOT-2' }))).toEqual({ pids: [], sent: [] }); // rebooted
    const reused = group.map((p) => (p.pid === 700 ? { ...p, start: T0 + 500 } : p));
    expect(await run(fakeHost(reused))).toEqual({ pids: [], sent: [] }); // pid 700 is another process now
  });
});
