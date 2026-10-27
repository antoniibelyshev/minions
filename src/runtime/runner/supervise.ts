// Spawn and supervision of a process worker (docs/design/agent-runtimes.md D3.5, D3.6). The worker runs in its
// own process group (the minions-sandbox wrapper calls setsid; without the wrapper, in tests, Node's `detached`
// does). Stop = SIGINT to the group (Codex handles only SIGINT gracefully: it interrupts the turn and flushes its
// output, agent-runtimes U-C4), SIGTERM after a short interrupt grace, then SIGKILL after the kill grace. After the leader exits the group is SIGKILLed again
// so no member is left behind before post-exit starts (the wrapper additionally reaps setsid escapees as a
// subreaper; D4 "Process lifetime").
import { spawn } from 'node:child_process';

export type StopReason = 'timeout' | 'cancel' | 'drain' | 'lease-ended';

export interface SuperviseTiming {
  /** Wall-clock limit of the worker. */
  timeoutMs: number;
  /** How often the lease, the cancel mark and the drain are checked (D3.6: 5 s). */
  pollMs: number;
  /** SIGTERM -> SIGKILL (D4: 15 s). */
  killGraceMs: number;
  /** SIGINT -> SIGTERM (default INTERRUPT_GRACE_MS; never longer than killGraceMs). */
  interruptGraceMs?: number;
  /** Drain grace before the worker is stopped (D3.6: 120 s). */
  drainGraceMs: number;
}
/** SIGINT -> SIGTERM: long enough for Codex to end its turn and write its last events. */
export const INTERRUPT_GRACE_MS = 5_000;
export const DEFAULT_TIMING: Omit<SuperviseTiming, 'timeoutMs'> = { pollMs: 5_000, killGraceMs: 15_000, drainGraceMs: 120_000 };

export interface SpawnSpec { argv: string[]; cwd: string; env: Record<string, string>; stdin: string | null }

export interface SuperviseHooks {
  /** Called once the process exists (pid = pgid). */
  onSpawn(pid: number): Promise<void> | void;
  /** One stdout line. */
  onLine(line: string): void;
  /** Polled: why the worker must stop now, or 'drain' to start the grace; null = keep running. */
  poll(): Promise<StopReason | null>;
}

export interface SuperviseOutcome {
  code: number | null;
  signal: string | null;
  stopped: StopReason | null;
  stderrTail: string;
  spawnError: string | null;
}

const STDERR_TAIL = 2048;

const killGroup = (pgid: number, sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* gone */ } };

export function supervise(spec: SpawnSpec, timing: SuperviseTiming, hooks: SuperviseHooks): Promise<SuperviseOutcome> {
  return new Promise((resolveOutcome) => {
    let stopped: StopReason | null = null;
    let stderr = '';
    let buf = '';
    let termTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let polling = false;
    const interruptGraceMs = Math.min(timing.interruptGraceMs ?? INTERRUPT_GRACE_MS, timing.killGraceMs);
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd, env: spec.env, detached: true, shell: false, windowsHide: true,
      // Only stdin, stdout and stderr are passed (Node closes every other descriptor on exec).
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    const stop = (why: StopReason) => {
      if (stopped || pid === undefined) return;
      stopped = why;
      killGroup(pid, 'SIGINT');
      termTimer = setTimeout(() => {
        killGroup(pid, 'SIGTERM');
        killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), timing.killGraceMs);
      }, interruptGraceMs);
    };
    const deadline = setTimeout(() => stop('timeout'), timing.timeoutMs);
    const ticker = setInterval(() => {
      if (polling || stopped) return;
      polling = true;
      hooks.poll().then((why) => {
        if (!why) return;
        if (why === 'drain') { drainTimer ??= setTimeout(() => stop('drain'), timing.drainGraceMs); return; }
        stop(why);
      }, () => stop('cancel')).finally(() => { polling = false; });
    }, timing.pollMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.length <= 1 << 20) hooks.onLine(line); }
      if (buf.length > 1 << 20) buf = '';
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-STDERR_TAIL * 2); });
    child.stdin.on('error', () => undefined);
    if (spec.stdin !== null) child.stdin.end(spec.stdin); else child.stdin.end();
    let spawnError: string | null = null;
    const finish = (code: number | null, signal: string | null) => {
      clearTimeout(deadline); clearInterval(ticker); clearTimeout(termTimer); clearTimeout(killTimer); clearTimeout(drainTimer);
      if (pid !== undefined) killGroup(pid, 'SIGKILL');
      if (buf) hooks.onLine(buf);
      resolveOutcome({ code, signal, stopped, stderrTail: stderr.slice(-STDERR_TAIL), spawnError });
    };
    child.on('error', (e) => { spawnError = e.message; if (pid === undefined) once(null, null); });
    let closeTimer: NodeJS.Timeout | undefined;
    let done = false;
    const once = (code: number | null, signal: string | null) => { if (done) return; done = true; clearTimeout(closeTimer); finish(code, signal); };
    // The leader exited: SIGKILL the rest of the group at once; a descendant that still holds stdout open must not stall post-exit.
    child.on('exit', (code, signal) => {
      if (pid !== undefined) killGroup(pid, 'SIGKILL');
      closeTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); once(code, signal); }, timing.killGraceMs);
    });
    child.on('close', (code, signal) => once(code, signal));
    if (pid !== undefined) Promise.resolve(hooks.onSpawn(pid)).catch(() => stop('cancel'));
  });
}
