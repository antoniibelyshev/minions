import type { Command } from 'commander';
import { MinionsError } from './errors.js';
import { handleError } from './output.js';

/**
 * - `host`: the trusted host CLI (MINIONS_RUNTIME unset).
 * - `container`: the agent runtime inside the project container (MINIONS_RUNTIME=container, set in the image).
 * - `host-runtime`: the agent runtime running directly on the host without Docker (MINIONS_RUNTIME=host,
 *   set only by the host CLI for the processes it launches: coordinator, hooks, helpers).
 */
export type RuntimeMode = 'host' | 'container' | 'host-runtime';
/** `runtime` = either agent runtime (container or host-runtime). */
export type RequiredMode = 'host' | 'container' | 'runtime';

export const runtimeMode = (env: NodeJS.ProcessEnv = process.env): RuntimeMode =>
  env.MINIONS_RUNTIME === 'container' ? 'container' : env.MINIONS_RUNTIME === 'host' ? 'host-runtime' : 'host';

/** True inside an agent runtime (container or host runtime). */
export const isAgentRuntime = (env: NodeJS.ProcessEnv = process.env) => runtimeMode(env) !== 'host';

export function requireMode(mode: RequiredMode): void {
  const actual = runtimeMode();
  const ok = mode === 'runtime' ? actual !== 'host' : actual === mode;
  if (ok) return;
  if (mode === 'host') {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `This command runs only in the host CLI (current: ${actual}).`,
      actual === 'container' ? 'Run it on the host, not inside the minions container.'
        : 'Run it from your own terminal; agent processes of the host runtime cannot run host-control commands.');
  }
  throw new MinionsError('INCOMPATIBLE_RUNTIME', `This command runs only in the agent runtime (current: ${actual}).`,
    'It is used by the coordinator inside the runtime (container, or the host runtime launched by `minions start`).');
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
