// Claude Code `--permission-mode` choices, read from `claude --help`, and the strict ("ask for
// everything outside the allow list") mode's argv name. Claude Code 2.1.292 lists `manual` where older
// versions listed `default` (the same mode under its new name), so callers that want the strict mode
// pass `default` when the CLI lists it, `manual` when it lists only that, and fail closed when it lists
// neither. Never a looser mode. Shared by the coordinator (src/runtime/coordinator.ts) and the setup
// assistant (src/host/assistant.ts); the host manager assistant can switch to it too.
import { run, type RunOptions, type RunResult } from '../core/exec.js';

type HelpRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/**
 * `--permission-mode` choices listed by `claude --help` (commander's `(choices: "a", "b")`), or null
 * when the flag or its choices are not listed. Never guesses: a mode counts only when listed.
 */
export function parsePermissionModes(help: string): string[] | null {
  const at = help.indexOf('--permission-mode');
  if (at < 0) return null;
  const rest = help.slice(at + '--permission-mode'.length);
  const next = rest.search(/\n\s*-{1,2}[A-Za-z]/);
  const m = /\(choices:\s*([^)]*)\)/.exec(next < 0 ? rest : rest.slice(0, next));
  if (!m) return null;
  const modes = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  return modes.length ? modes : null;
}

/** Reads the installed Claude Code's `--permission-mode` choices; null when `claude --help` fails or lists none. */
export async function claudePermissionModes(runner: HelpRunner = run): Promise<string[] | null> {
  const help = await runner('claude', ['--help'], { allowFailure: true, timeoutMs: 30_000 }).catch(() => null);
  if (!help || help.code !== 0) return null;
  return parsePermissionModes(help.stdout + help.stderr);
}

/** Names of the strict permission mode, in order of preference: `default` (older CLIs) or `manual` (2.1.292+). */
export const STRICT_PERMISSION_MODE_NAMES = ['default', 'manual'] as const;
export type StrictPermissionModeArg = typeof STRICT_PERMISSION_MODE_NAMES[number];

export type StrictPermissionModeResult =
  | { ok: true; mode: StrictPermissionModeArg }
  | { ok: false; reason: string };

/**
 * argv value for the strict permission mode given the installed Claude Code's choices: `default` when
 * listed, else `manual` when listed. `modes` null/undefined (choices not readable or not checked):
 * `default`, the historical name, which is never looser (a CLI that rejects it fails the launch). Choices
 * listing neither: not ok, with a reason; callers fail closed and never pick another mode.
 */
export function strictPermissionModeArg(modes: readonly string[] | null | undefined): StrictPermissionModeResult {
  if (!modes) return { ok: true, mode: 'default' };
  const mode = STRICT_PERMISSION_MODE_NAMES.find((m) => modes.includes(m));
  if (mode) return { ok: true, mode };
  return { ok: false, reason: `the installed Claude Code offers neither --permission-mode default nor manual (choices: ${modes.join(', ')})` };
}
