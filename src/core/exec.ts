import { spawn } from 'node:child_process';
import { MinionsError } from './errors.js';
import { redact } from './output.js';

export interface RunOptions { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; allowFailure?: boolean }
export interface RunResult { code: number; stdout: string; stderr: string; timedOut?: boolean }

const tail = (s: string, n = 2000) => (s.length > n ? '…' + s.slice(-n) : s);

/** Spawns cmd with argv args (never through a shell). Throws INTERNAL on non-zero/timeout unless allowFailure. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: opts.env ?? process.env, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    let killTimer: NodeJS.Timeout | undefined;
    const timer = opts.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, opts.timeoutMs) : undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
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
      if (result.code === 0 || opts.allowFailure) return resolve(result);
      const why = timedOut ? `timed out after ${opts.timeoutMs}ms` : `exited with code ${result.code}`;
      reject(new MinionsError('INTERNAL', `${cmd} ${why}${stderr.trim() ? `: ${redact(tail(stderr.trim()))}` : ''}`,
        undefined, { cmd, args: args.map(redact), code: result.code, timedOut }));
    }));
    child.stdin.on('error', () => {}); // child may exit before reading stdin
    child.stdin.end(opts.input ?? '');
  });
}
