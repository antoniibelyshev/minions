// Orphaned runtime helpers (doctor, host runtime): `minions coordinator supervise` and `minions work dispatch`
// processes started in this project's state dir that are not the current lock holders. A state restore that
// swapped the DB under them (before the restore stopped them, or a dispatcher started in between) leaves such a
// pair looping on the replaced DB. Doctor reports them with the exact `kill` command and never signals;
// stopOrphanHelpers stops them: `minions start` (host runtime, both kinds) and a supervisor or dispatcher right after
// it takes its lock (its own kind only). A process is stopped only when it is still the same non-holder (pid, start
// time, kind, cwd) after ORPHAN_GRACE_MS, so a helper that has just started and not yet taken its lock is left alone,
// and one whose start time is unknown is never signalled. SIGTERM only, then a bounded wait; a survivor is reported.
import { readlinkSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../core/exec.js';
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

const inStateDir = (procs: HelperProcess[], state: string): HelperProcess[] => {
  const dir = real(state);
  return procs.filter((p) => p.cwd !== null && real(p.cwd) === dir);
};

/** Helpers whose cwd is `state` and which do not hold their lock in `locks`. */
export const findOrphans = (procs: HelperProcess[], state: string, locks: Record<ProcessLockKey, SupervisorLock | null>): HelperProcess[] =>
  inStateDir(procs, state).filter((p) => !isHolder(p, locks[LOCK_OF[p.kind]]));

/**
 * The `helpers.orphans` check: helpers whose cwd is `state` but which do not hold their lock in the live DB
 * (`locks`; null when the DB could not be read, and then nothing is reported).
 */
export function orphanHelperCheck(procs: HelperProcess[], state: string, locks: Record<ProcessLockKey, SupervisorLock | null> | null): Check {
  const name = 'helpers.orphans';
  const mine = inStateDir(procs, state);
  if (!locks) return { name, status: 'ok', detail: `${mine.length} supervisor/dispatcher process(es) in this project's state dir; lock holders not readable, nothing checked` };
  const orphans = findOrphans(procs, state, locks);
  if (!orphans.length) return { name, status: 'ok', detail: `no orphaned \`coordinator supervise\` / \`work dispatch\` process (${mine.length} running, all lock holders)` };
  const list = orphans.map((p) => `\`${COMMAND_OF[p.kind]}\` pid ${p.pid}`).join(', ');
  return {
    name, status: 'warn',
    detail: `${orphans.length} orphaned helper process(es) of this project not holding their lock: ${list} (left over from a state restore? they keep running on a replaced database)`,
    hint: `\`minions start\` stops them; or check them with \`ps -o pid,lstart,command -p ${orphans.map((p) => p.pid).join(',')}\` and run \`kill ${orphans.map((p) => p.pid).join(' ')}\` (the coordinator restarts its own helpers when needed).`,
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

/** How long a helper must stay a non-holder before it is stopped: a helper takes its lock right after it starts. */
export const ORPHAN_GRACE_MS = 5_000;
/** How long stopOrphanHelpers waits for SIGTERM'd orphans to exit. */
export const ORPHAN_STOP_TIMEOUT_MS = 20_000;

export interface StopOrphansDeps {
  procs: () => Promise<HelperProcess[]>;
  /** The live DB's lock rows; null when unreadable (then nothing is stopped). */
  locks: () => Record<ProcessLockKey, SupervisorLock | null> | null;
  /** The kinds to stop (default both). A helper stops only its own kind, so a sibling starting up is never raced. */
  kinds?: HelperKind[];
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  graceMs?: number;
  timeoutMs?: number;
  pollMs?: number;
}
export interface OrphanStop { stopped: HelperProcess[]; failed: HelperProcess[] }

const sameProcess = (a: HelperProcess, b: HelperProcess): boolean => a.pid === b.pid && a.kind === b.kind && a.startTime !== null && a.startTime === b.startTime;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops this state dir's orphaned helpers (see the header): SIGTERM, then a bounded wait. */
export async function stopOrphanHelpers(state: string, d: StopOrphansDeps): Promise<OrphanStop> {
  const kinds = d.kinds ?? ['supervisor', 'dispatcher'];
  const scan = async () => {
    const locks = d.locks();
    return locks ? findOrphans(await d.procs(), state, locks).filter((p) => kinds.includes(p.kind) && p.startTime !== null) : [];
  };
  const first = await scan();
  if (!first.length) return { stopped: [], failed: [] };
  await sleep(d.graceMs ?? ORPHAN_GRACE_MS);
  const targets = (await scan()).filter((p) => first.some((f) => sameProcess(f, p)));
  const kill = d.kill ?? ((pid, sig) => { process.kill(pid, sig); });
  for (const t of targets) { try { kill(t.pid, 'SIGTERM'); } catch { /* gone, or not ours to signal: the wait reports it */ } }
  const left = async () => { const now = await d.procs(); return targets.filter((t) => now.some((p) => sameProcess(t, p))); };
  const deadline = Date.now() + (d.timeoutMs ?? ORPHAN_STOP_TIMEOUT_MS);
  let failed = targets.length ? await left() : [];
  while (failed.length && Date.now() < deadline) {
    await sleep(d.pollMs ?? 200);
    failed = await left();
  }
  return { stopped: targets.filter((t) => !failed.includes(t)), failed };
}

/** ps/lsof runner in UTC and the C locale, as the locks record start times (process-facts.ts parsePsLine). */
export const helperTextRunner: TextRunner = async (cmd, args) => {
  const r = await run(cmd, args, { allowFailure: true, timeoutMs: 30_000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } });
  return r.code === 0 ? r.stdout : null;
};

/** stopOrphanHelpers for a state dir with the live DB and the system process table (`minions start`, the helpers). */
export const stopStateDirOrphans = (state: string, db: string, kinds?: HelperKind[]): Promise<OrphanStop> =>
  stopOrphanHelpers(state, { procs: () => listHelperProcesses({ run: helperTextRunner }), locks: () => readProcessLocks(db), ...(kinds ? { kinds } : {}) });

/** One line per stopped or surviving orphan, for a log or the terminal. */
export const orphanStopLines = (r: OrphanStop): string[] => [
  ...r.stopped.map((p) => `stopped orphaned \`${COMMAND_OF[p.kind]}\` pid ${p.pid} (not the lock holder of this project's runtime DB)`),
  ...r.failed.map((p) => `orphaned \`${COMMAND_OF[p.kind]}\` pid ${p.pid} did not exit after SIGTERM; stop it with \`kill ${p.pid}\``),
];
