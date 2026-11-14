// Process facts without /proc (docs/design/host-runtime.md, gap 2 and phase 1): the macOS view of a process (parent,
// process group, state, start time, command line) and of the boot, from `ps` and `sysctl`.
//
// Architecture decision (task-103.2): the platform switch lives at the three "system" defaults only, and each picks
// its backend once from `process.platform` through systemProcessFacts():
// - `systemProcessControl` and `procStartTime` (src/runtime/coordinator.ts): the coordinator lock, the stuck
//   coordinator escalation, signalDescendants, checkTelegramPoller and the channel server's claudeOwner;
// - `systemLockView` (src/runtime/supervisor.ts): the supervisor lock and the integration_lock (integratorAlive);
// - the `proc` source of src/runtime/runner/record.ts (procStat, procIdentity, isAlive, hostIdentity, groupMembers):
//   the run records, the supervisor's session records and the integrator's verify group recovery. A `proc` argument
//   is either a /proc root (a string, the Linux code path, unchanged) or a ProcessFacts object; the default `/proc`
//   resolves to the ps view on darwin.
// On Linux nothing changes: /proc stays the only source. Tests inject a ProcessFacts built on fake `ps`/`sysctl`
// runners (psProcessFacts), or pick a platform explicitly (processControlFor, lockViewFor, systemProcessFacts).
//
// Rules:
// - `ps` runs with LC_ALL=C and TZ=UTC, so `lstart` is always `Dow Mon DD HH:MM:SS YYYY` in UTC. The start time is
//   kept as epoch seconds (a decimal string): it compares as a string for identity and as a number for "started no
//   earlier than" (groupMembers). It has one-second resolution, so lock checks also compare the command line.
// - A command that fails or prints nothing reads as unknown (null), never as a different process: callers fall back
//   to their no-/proc behaviour (refuse rather than signal).
// - Boot id: `sysctl -n kern.bootsessionuuid` (a UUID per boot), else `kern.boottime` (`boottime:<sec>.<usec>`).
import { execFileSync } from 'node:child_process';

/** One process as `ps` reports it. `startTime`: epoch seconds (string); `state`: the first `stat` letter (`Z` = zombie). */
export interface ProcessFact { pid: number; ppid: number; pgid: number; state: string; startTime: string; cmdline: string }

/** Process table and boot identity of a host without /proc. */
export interface ProcessFacts {
  /** The process, or null when it does not exist or cannot be read. */
  process(pid: number): ProcessFact | null;
  /** One snapshot of all processes (empty when unreadable). */
  list(): ProcessFact[];
  /** An id that changes on every reboot; null when unreadable. */
  bootId(): string | null;
}

/** Runs a command with a fixed environment; its stdout, or null when it failed. */
export type CommandRunner = (cmd: string, args: string[]) => string | null;

export const PS_BIN = '/bin/ps';
export const SYSCTL_BIN = '/usr/sbin/sysctl';
/** One `-o` per field: with `pid=,ppid=` POSIX ps reads the rest of the list as the header of the first field. */
export const PS_FIELDS = ['-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='];
/** `-ww`: never truncate the command line to a terminal width. */
export const psArgs = (pid?: number): string[] => ['-ww', ...PS_FIELDS, ...(pid === undefined ? ['-A'] : ['-p', String(pid)])];

export const systemCommandRunner: CommandRunner = (cmd, args) => {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
      env: { PATH: '/bin:/usr/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
    });
  } catch { return null; }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// pid ppid pgid stat | Dow Mon DD HH:MM:SS YYYY | command (the rest of the line, spaces kept)
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})(?:\s(.*))?$/;

/** Parses one line of `ps` output (fields as in PS_FIELDS, C locale, UTC); null when it does not match. */
export function parsePsLine(line: string): ProcessFact | null {
  const m = PS_LINE.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  const month = MONTHS.indexOf(m[5]!);
  if (month < 0) return null;
  const ms = Date.UTC(Number(m[10]), month, Number(m[6]), Number(m[7]), Number(m[8]), Number(m[9]));
  if (!Number.isFinite(ms)) return null;
  return {
    pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), state: m[4]!.charAt(0),
    startTime: String(Math.floor(ms / 1000)), cmdline: (m[11] ?? '').trim(),
  };
}

/** The boot id from `sysctl`: kern.bootsessionuuid, else kern.boottime (`{ sec = N, usec = M } ...`). */
export function bootIdFrom(run: CommandRunner): string | null {
  const uuid = run(SYSCTL_BIN, ['-n', 'kern.bootsessionuuid'])?.trim();
  if (uuid) return uuid;
  const bt = run(SYSCTL_BIN, ['-n', 'kern.boottime']);
  const m = bt ? /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(bt) : null;
  return m ? `boottime:${m[1]}.${m[2]}` : null;
}

/** ProcessFacts from `ps` and `sysctl` (macOS). `run` is injectable for tests. */
export function psProcessFacts(run: CommandRunner = systemCommandRunner): ProcessFacts {
  const rows = (out: string | null) => (out ?? '').split('\n').map(parsePsLine).filter((p): p is ProcessFact => p !== null);
  return {
    process(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return rows(run(PS_BIN, psArgs(pid))).find((p) => p.pid === pid) ?? null;
    },
    list: () => rows(run(PS_BIN, psArgs())),
    bootId: () => bootIdFrom(run),
  };
}

let systemPs: ProcessFacts | undefined;
/** The ps view on darwin (one shared instance); null elsewhere, where /proc is the source. */
export function systemProcessFacts(platform: NodeJS.Platform = process.platform): ProcessFacts | null {
  if (platform !== 'darwin') return null;
  return (systemPs ??= psProcessFacts());
}
