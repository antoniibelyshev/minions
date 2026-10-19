import type { Command } from 'commander';
import { MinionsError } from './errors.js';
import { handleError } from './output.js';

export type RuntimeMode = 'host' | 'container';

export const runtimeMode = (): RuntimeMode => (process.env.MINIONS_RUNTIME === 'container' ? 'container' : 'host');

export function requireMode(mode: RuntimeMode): void {
  const actual = runtimeMode();
  if (actual !== mode) {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `This command runs only on the ${mode} (current: ${actual}).`,
      mode === 'container' ? 'Run it inside the container: docker compose exec app minions …, or via the coordinator.'
        : 'Run it on the host, not inside the minions container.');
  }
}

/** Global flags of the command (incl. root --json). */
export function globalOpts(cmd: Command): { json: boolean; dryRun: boolean } {
  const o = cmd.optsWithGlobals() as { json?: boolean; dryRun?: boolean };
  return { json: !!o.json, dryRun: !!o.dryRun };
}

export const wantsJson = (argv: string[] = process.argv) => argv.includes('--json');

/**
 * Wraps a commander action: errors are emitted respecting --json and exit with the mapped code.
 * The handler receives commander's args unchanged (…positionals, options, command).
 */
export function action<A extends unknown[]>(fn: (...args: A) => unknown | Promise<unknown>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const cmd = args[args.length - 1] as Command | undefined;
    try {
      await fn(...args);
    } catch (err) {
      const json = cmd && typeof cmd.optsWithGlobals === 'function' ? globalOpts(cmd).json : wantsJson();
      handleError(err, { json });
    }
  };
}
