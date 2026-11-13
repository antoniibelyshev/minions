// Orphaned runtime helpers (doctor, host runtime): `minions coordinator supervise` and `minions work dispatch`
// processes started in this project's state dir that are not the current lock holders. A state restore that
// swapped the DB under them (before the restore stopped them, or a dispatcher started in between) leaves such a
// pair looping on the replaced DB. Doctor only reports them with the exact `kill` command; it never signals.
import { readlinkSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readProcessLocks, type ProcessLockKey, type SupervisorLock } from '../runtime/db.js';
import { parsePsLine, PS_BIN, psArgs } from '../runtime/process-facts.js';

export type HelperKind = 'supervisor' | 'dispatcher';
/** A running helper process: `startTime` as the lock records it (epoch seconds from ps, /proc ticks), null when unknown. */
export interface HelperProcess { pid: number; kind: HelperKind; startTime: string | null; cwd: string | null; cmdline: string }
interface Check { name: string; status: 'ok' | 'warn'; detail: string; hint?: string }

const HELPER_CMDLINES: [HelperKind, RegExp][] = [
  ['supervisor', /(^|[\s/])coordinator\s+supervise(\s|$)/],
  ['dispatcher', /(^|[\s/])work\s+dispatch(\s|$)/],
];
const LOCK_OF: Record<HelperKind, ProcessLockKey> = { supervisor: 'supervisor_lock', dispatcher: 'dispatcher_lock' };
const COMMAND_OF: Record<HelperKind, string> = { supervisor: 'coordinator supervise', dispatcher: 'work dispatch' };

export const helperKindOf = (cmdline: string): HelperKind | null => HELPER_CMDLINES.find(([, re]) => re.test(cmdline))?.[0] ?? null;

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

/** The lock holder: same pid, and the same start time when both are known (a reused pid is not the holder). */
const isHolder = (p: HelperProcess, l: SupervisorLock | null): boolean => !!l && l.pid === p.pid && (l.start === null || p.startTime === null || l.start === p.startTime);

/**
 * The `helpers.orphans` check: helpers whose cwd is `state` but which do not hold their lock in the live DB
 * (`locks`; null when the DB could not be read, and then nothing is reported).
 */
export function orphanHelperCheck(procs: HelperProcess[], state: string, locks: Record<ProcessLockKey, SupervisorLock | null> | null): Check {
  const name = 'helpers.orphans';
  const dir = real(state);
  const mine = procs.filter((p) => p.cwd !== null && real(p.cwd) === dir);
  if (!locks) return { name, status: 'ok', detail: `${mine.length} supervisor/dispatcher process(es) in this project's state dir; lock holders not readable, nothing checked` };
  const orphans = mine.filter((p) => !isHolder(p, locks[LOCK_OF[p.kind]]));
  if (!orphans.length) return { name, status: 'ok', detail: `no orphaned \`coordinator supervise\` / \`work dispatch\` process (${mine.length} running, all lock holders)` };
  const list = orphans.map((p) => `\`${COMMAND_OF[p.kind]}\` pid ${p.pid}`).join(', ');
  return {
    name, status: 'warn',
    detail: `${orphans.length} orphaned helper process(es) of this project not holding their lock: ${list} (left over from a state restore? they keep running on a replaced database)`,
    hint: `Check them with \`ps -o pid,lstart,command -p ${orphans.map((p) => p.pid).join(',')}\`, then stop them: \`kill ${orphans.map((p) => p.pid).join(' ')}\` (the coordinator restarts its own helpers when needed).`,
  };
}

/** Runs a command; its stdout, or null when it failed (the doctor's runner, or a fake in tests). */
export type TextRunner = (cmd: string, args: string[]) => Promise<string | null>;

/** The process's cwd: `lsof` on macOS, /proc/<pid>/cwd elsewhere; null when unreadable. */
export async function processCwd(pid: number, o: { platform?: NodeJS.Platform; run: TextRunner; proc?: string }): Promise<string | null> {
  if ((o.platform ?? process.platform) === 'darwin') {
    const out = await o.run(LSOF_BIN, ['-a', '-d', 'cwd', '-p', String(pid), '-Fn']).catch(() => null);
    const line = out?.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  }
  try { return readlinkSync(join(o.proc ?? '/proc', String(pid), 'cwd')); } catch { return null; }
}

const LSOF_BIN = '/usr/sbin/lsof';

/** Running supervise/dispatch processes with their cwd: `ps` + `lsof` through `run` on macOS, /proc elsewhere. */
export async function listHelperProcesses(o: { run: TextRunner; platform?: NodeJS.Platform; proc?: string; cwdOf?: (pid: number) => Promise<string | null> }): Promise<HelperProcess[]> {
  const platform = o.platform ?? process.platform;
  const cwdOf = o.cwdOf ?? ((pid: number) => processCwd(pid, { platform, run: o.run, ...(o.proc ? { proc: o.proc } : {}) }));
  const rows: { pid: number; startTime: string | null; cmdline: string }[] = [];
  if (platform === 'darwin') {
    const out = await o.run(PS_BIN, psArgs()).catch(() => null);
    for (const line of (out ?? '').split('\n')) {
      const p = parsePsLine(line);
      if (p) rows.push({ pid: p.pid, startTime: p.startTime, cmdline: p.cmdline });
    }
  } else {
    const proc = o.proc ?? '/proc';
    let pids: string[] = [];
    try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { /* no /proc */ }
    for (const n of pids) {
      try {
        const cmdline = readFileSync(join(proc, n, 'cmdline'), 'utf8').split('\0').join(' ').trim();
        const stat = readFileSync(join(proc, n, 'stat'), 'utf8');
        const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        rows.push({ pid: Number(n), startTime: start && /^\d+$/.test(start) ? start : null, cmdline });
      } catch { /* gone */ }
    }
  }
  const out: HelperProcess[] = [];
  for (const r of rows) {
    if (r.pid === process.pid) continue;
    const kind = helperKindOf(r.cmdline);
    if (kind) out.push({ ...r, kind, cwd: await cwdOf(r.pid) });
  }
  return out;
}

/** Doctor entry point: the check for the host runtime's state dir and DB. */
export async function hostOrphanHelperCheck(state: string, db: string, procs: () => Promise<HelperProcess[]>): Promise<Check> {
  let list: HelperProcess[] = [];
  try { list = await procs(); } catch { list = []; }
  return orphanHelperCheck(list, state, readProcessLocks(db));
}
