// Runs `minions <args>` in the project's agent runtime for the repo at cwd and returns the exit code:
// inside the container (docker compose exec -T app minions ...) or, for the host runtime, through
// the host runtime's `minions` shim (same code, MINIONS_RUNTIME=host and the host paths).
import { MinionsError } from '../core/errors.js';
import { Compose } from './docker.js';
import type { RunResult } from '../core/exec.js';
import { loadProjectJson, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { HostRuntime, prepareHostRuntime, runtimeOf } from './runtime.js';

export async function delegateToRuntime(args: string[], opts: { json: boolean; cwd?: string }): Promise<number> {
  const { projectId } = await projectForPath(opts.cwd ?? process.cwd());
  const argv = ['minions', ...args];
  if (opts.json && !argv.includes('--json')) argv.push('--json');
  const project = await loadProjectJson(projectId);
  if (runtimeOf(project) === 'host') {
    const host = new HostRuntime(project);
    if (!(await host.prepared())) {
      throw new MinionsError('PRECONDITION', 'The host runtime has not been started for this project.', 'Run `minions start` (or `minions start --no-attach`) first.');
    }
    await prepareHostRuntime(project); // refresh the shim (package may have moved)
    return host.execInherit(argv);
  }
  const compose = new Compose(projectId);
  if (!(await compose.isRunning())) {
    throw new MinionsError('PRECONDITION', 'The project container is not running.', 'Run `minions start` (or `minions start --no-attach`) first.');
  }
  // --json stdout must stay byte-exact for parsers; the JSON emitter already escapes all control characters.
  return compose.execInherit(argv, { tty: false, rawStdout: argv.includes('--json') });
}

/** @deprecated name kept for existing callers; delegates to the configured runtime. */
export const delegateToContainer = delegateToRuntime;

/** Limits of a captured delegate exec whose output is untrusted (the host manager's polls). */
export const DELEGATE_TIMEOUT_MS = 30_000;
export const DELEGATE_MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Runs `minions <args>` (args include the leading `minions`) in the project's runtime with captured output, a
 * timeout and an output cap (the child is killed when either is hit; see `timedOut` / `outputLimited`). Never
 * throws for a failing command: the caller decides (the output is untrusted container output).
 */
export function delegateCapture(project: ProjectJson, args: string[], o: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<RunResult> {
  const opts = { allowFailure: true, timeoutMs: o.timeoutMs ?? DELEGATE_TIMEOUT_MS, maxOutputBytes: o.maxOutputBytes ?? DELEGATE_MAX_OUTPUT_BYTES };
  return runtimeOf(project) === 'host' ? new HostRuntime(project).exec(args, opts) : new Compose(project.projectId).exec(args, opts);
}
