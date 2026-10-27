import { spawn } from 'node:child_process';
import { MinionsError } from './errors.js';
import { redact } from './output.js';

export interface RunOptions {
  cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; allowFailure?: boolean;
  /**
   * Aborting kills the child like the timeout does (SIGTERM, SIGKILL after a short grace); the result then
   * has `aborted: true` and code 130. Already aborted: nothing is spawned. Optional; no effect when absent.
   */
  signal?: AbortSignal;
  /**
   * Cap on stdout plus stderr in bytes: once exceeded, the child is killed like on a timeout, the output kept so far
   * stays (cut at the cap) and the result has `outputLimited: true` (code 125 unless it timed out or was aborted).
   */
  maxOutputBytes?: number;
  /**
   * POSIX: the child leads its own process group, and the timeout, abort and output cap signal the whole group
   * (SIGTERM, SIGKILL after the grace), so grandchildren that keep the output pipes open cannot hold the call. Without
   * it only the direct child is signalled. Ignored on Windows.
   */
  killGroup?: boolean;
}
export interface RunResult { code: number; stdout: string; stderr: string; timedOut?: boolean; aborted?: boolean; outputLimited?: boolean }

/** Grace between SIGTERM and SIGKILL (timeout and abort). */
const KILL_GRACE_MS = 2000;

const tail = (s: string, n = 2000) => (s.length > n ? '…' + s.slice(-n) : s);

/** Spawns cmd with argv args (never through a shell). Throws INTERNAL on non-zero/timeout/abort unless allowFailure. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      if (opts.allowFailure) return resolve({ code: 130, stdout: '', stderr: '', aborted: true });
      return reject(new MinionsError('INTERNAL', `${cmd} was aborted before it started`, undefined, { cmd, args: args.map(redact), aborted: true }));
    }
    const group = opts.killGroup === true && process.platform !== 'win32';
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: opts.env ?? process.env, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(group ? { detached: true } : {}),
    });
    /** Signals the child, or its whole process group (a group already gone falls back to the child, then to nothing). */
    const signal = (sig: NodeJS.Signals) => {
      if (group && child.pid !== undefined) {
        try { process.kill(-child.pid, sig); return; } catch { /* the group is gone */ }
      }
      try { child.kill(sig); } catch { /* gone */ }
    };
    let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false, outputLimited = false, bytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const take = (d: string): string => {
      if (opts.maxOutputBytes === undefined) return d;
      if (outputLimited) return '';
      const n = Buffer.byteLength(d);
      if (bytes + n <= opts.maxOutputBytes) { bytes += n; return d; }
      const keep = Buffer.from(d).subarray(0, Math.max(0, opts.maxOutputBytes - bytes)).toString('utf8');
      bytes = opts.maxOutputBytes;
      outputLimited = true;
      terminate();
      return keep;
    };
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += take(d)));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += take(d)));
    const terminate = () => {
      if (killTimer || settled) return;
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = opts.timeoutMs ? setTimeout(() => { if (!aborted) timedOut = true; terminate(); }, opts.timeoutMs) : undefined;
    const onAbort = () => { if (!timedOut) aborted = true; terminate(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Killed as a group: what is left of the group (a grandchild that ignored SIGTERM and let go of the pipes) gets
      // its SIGKILL now, while the group id still names this call's processes.
      if (killTimer && group && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (err: NodeJS.ErrnoException) => finish(() => {
      if (opts.allowFailure) return resolve({ code: 127, stdout, stderr: stderr + String(err.message) });
      reject(err.code === 'ENOENT'
        ? new MinionsError('NOT_FOUND', `Command not found: ${cmd}`, `Install ${cmd} or check PATH.`)
        : new MinionsError('INTERNAL', `Failed to run ${cmd}: ${err.message}`));
    }));
    child.on('close', (code, signal) => finish(() => {
      const result: RunResult = { code: code ?? (signal ? 128 : 1), stdout, stderr };
      if (timedOut) { result.timedOut = true; result.code = 124; }
      if (aborted) { result.aborted = true; result.code = 130; }
      if (outputLimited) { result.outputLimited = true; if (!timedOut && !aborted) result.code = 125; }
      if (result.code === 0 || opts.allowFailure) return resolve(result);
      const why = timedOut ? `timed out after ${opts.timeoutMs}ms` : aborted ? 'was aborted' : outputLimited ? `wrote more than ${opts.maxOutputBytes} bytes of output` : `exited with code ${result.code}`;
      reject(new MinionsError('INTERNAL', `${cmd} ${why}${stderr.trim() ? `: ${redact(tail(stderr.trim()))}` : ''}`,
        undefined, { cmd, args: args.map(redact), code: result.code, timedOut, ...(aborted ? { aborted } : {}) }));
    }));
    child.stdin.on('error', () => {}); // child may exit before reading stdin
    child.stdin.end(opts.input ?? '');
  });
}
