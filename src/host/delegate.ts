// Runs `minions <args>` in the project's agent runtime for the repo at cwd and returns the exit code:
// inside the container (docker compose exec -T app minions ...) or, for the host runtime, through
// the host runtime's `minions` shim (same code, MINIONS_RUNTIME=host and the host paths).
import { MinionsError } from '../core/errors.js';
import { Compose } from './docker.js';
import { loadProjectJson } from './project.js';
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
