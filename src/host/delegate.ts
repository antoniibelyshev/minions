// Runs `minions <args>` inside the project container for the repo at cwd
// (docker compose exec -T app minions ...), streams output, and returns the exit code.
import { MinionsError } from '../core/errors.js';
import { Compose } from './docker.js';
import { projectForPath } from './registry.js';

export async function delegateToContainer(args: string[], opts: { json: boolean; cwd?: string }): Promise<number> {
  const { projectId } = await projectForPath(opts.cwd ?? process.cwd());
  const compose = new Compose(projectId);
  if (!(await compose.isRunning())) {
    throw new MinionsError('PRECONDITION', 'The project container is not running.', 'Run `minions start` (or `minions start --no-attach`) first.');
  }
  const argv = ['minions', ...args];
  if (opts.json && !argv.includes('--json')) argv.push('--json');
  return compose.execInherit(argv, { tty: false });
}
