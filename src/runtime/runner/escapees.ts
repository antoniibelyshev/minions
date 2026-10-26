// The escapee sweep of recovery (docs/design/agent-runtimes.md D3b step 3, U-G6). A process is an escapee of the
// lease being recovered only when all of these hold: its `Seccomp_filters` count in /proc/<pid>/status is above the
// container baseline (it runs under a seccomp filter), its /proc/<pid>/environ carries the runner's marker
// `MINIONS_WORKER_LEASE=<that lease>` (set by the runner for the wrapper and inherited by everything under it), and
// its ancestry reaches no live wrapper. Such a process has lost its supervisor (wrapper SIGKILLed, e.g. by OOM).
//
// Decisions (task-14.5):
// - The marker check keeps the sweep away from unrelated seccomp users (Chromium/Playwright renderers, Claude Code
//   sandboxed commands of other workers) and from the sandboxed children of other runs, including a run that is
//   starting and has not recorded its wrapper yet: those carry another lease id or none. An unreadable environ
//   (another user, a race with exit) counts as unmarked: the sweep never kills what it cannot identify.
// - Residual: a sandboxed process that re-execs with a cleared environment drops the marker and is not swept; the
//   recorded process-group kill still reaches it unless it also left the group.
// - The baseline is PID 1's count (the container init carries Docker's filter, which everything inherits); when
//   PID 1's status is unreadable, the sweeping process's own count.
// - When neither status has the field (Linux < 5.9), the sweep is skipped and says so: the isolation self-test
//   refuses every process-harness launch on such a kernel, so no sandboxed worker can exist there.
// - The sweeping process, its ancestors and PID 1 are never killed. Zombies are skipped (already dead).
// - Everything goes through an injectable /proc root and kill function: unit tests use a fake /proc tree and never
//   signal a real process.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { procStat, type ProcIdentity } from './record.js';

export interface ProcStatus { seccompFilters: number | null; ppid: number | null }

/** `Seccomp_filters` and `PPid` of /proc/<pid>/status; null when the process is gone or the file unreadable. */
export async function procStatus(pid: number, proc = '/proc'): Promise<ProcStatus | null> {
  let text: string;
  try { text = await readFile(join(proc, String(pid), 'status'), 'utf8'); } catch { return null; }
  const field = (name: string) => { const m = new RegExp(`^${name}:\\s*(\\d+)\\s*$`, 'm').exec(text); return m ? Number(m[1]) : null; };
  return { seccompFilters: field('Seccomp_filters'), ppid: field('PPid') };
}

/** The runner's per-run marker (an environment variable of the wrapper and all its descendants). */
export const RUN_MARKER_ENV = 'MINIONS_WORKER_LEASE';

/** True when /proc/<pid>/environ has `MINIONS_WORKER_LEASE=<leaseId>`; false when it has not or is unreadable. */
export async function hasRunMarker(pid: number, leaseId: string, proc = '/proc'): Promise<boolean> {
  let env: string;
  try { env = await readFile(join(proc, String(pid), 'environ'), 'utf8'); } catch { return false; }
  return env.split('\0').includes(`${RUN_MARKER_ENV}=${leaseId}`);
}

export interface EscapeeSweepOptions {
  /** The lease being recovered: only processes carrying its marker are candidates. */
  leaseId: string;
  /** The /proc root (tests: a fake tree). */
  proc?: string;
  /** Wrappers that are still supervising a run: their descendants are spared. */
  liveWrappers: ProcIdentity[];
  /** Default: SIGKILL with process.kill. */
  kill?: (pid: number) => void;
  /** The sweeping process (default process.pid); it and its ancestors are never killed. */
  self?: number;
  /** Passes until one kills nothing (escapees may fork during a pass). */
  maxPasses?: number;
}

export interface EscapeeSweep { killed: number[]; baseline: number | null; skipped: string | null }

async function ancestors(pid: number, proc: string): Promise<number[]> {
  const out: number[] = [];
  const seen = new Set<number>();
  let cur: number | null = pid;
  while (cur !== null && cur > 0 && !seen.has(cur) && out.length < 4096) {
    seen.add(cur);
    out.push(cur);
    cur = (await procStatus(cur, proc))?.ppid ?? null;
  }
  return out;
}

export async function sweepEscapees(o: EscapeeSweepOptions): Promise<EscapeeSweep> {
  const proc = o.proc ?? '/proc';
  const self = o.self ?? process.pid;
  const kill = o.kill ?? ((pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  const baseline = (await procStatus(1, proc))?.seccompFilters ?? (await procStatus(self, proc))?.seccompFilters ?? null;
  if (baseline === null) return { killed: [], baseline: null, skipped: 'Seccomp_filters is not available in /proc/<pid>/status (no sandboxed worker can run here)' };
  const protectedPids = new Set([1, ...await ancestors(self, proc)]);
  const wrappers = new Map<number, string>();
  for (const w of o.liveWrappers) wrappers.set(w.pid, w.startTime);
  const isLiveWrapper = async (pid: number) => {
    const start = wrappers.get(pid);
    if (start === undefined) return false;
    const s = await procStat(pid, proc);
    return !!s && s.startTime === start && s.state !== 'Z';
  };
  const killed: number[] = [];
  for (let pass = 0; pass < (o.maxPasses ?? 3); pass++) {
    let names: string[];
    try { names = await readdir(proc); } catch (e) { return { killed, baseline, skipped: `cannot list ${proc}: ${(e as Error).message}` }; }
    let n = 0;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (protectedPids.has(pid) || killed.includes(pid)) continue;
      const st = await procStatus(pid, proc);
      if (!st || st.seccompFilters === null || st.seccompFilters <= baseline) continue;
      if ((await procStat(pid, proc))?.state === 'Z') continue;
      if (!(await hasRunMarker(pid, o.leaseId, proc))) continue;
      let supervised = false;
      for (const a of await ancestors(pid, proc)) if (await isLiveWrapper(a)) { supervised = true; break; }
      if (supervised) continue;
      kill(pid);
      killed.push(pid);
      n++;
    }
    if (!n) break;
  }
  return { killed, baseline, skipped: null };
}
