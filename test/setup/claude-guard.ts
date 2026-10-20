// Vitest setupFiles (every worker, before each test file): fails any test that would start `claude`
// with the user's real Claude Code config dir. Such a session loads the user's globally enabled
// plugins; the Telegram channel plugin then kills the running coordinator's poller ("replacing stale
// poller") and drops its Telegram connection. test/setup/global.ts points CLAUDE_CONFIG_DIR at a temp
// dir that child processes inherit; this guard catches a test that overrides or drops it.
//
// The child_process functions are wrapped on the builtin module and re-synced into its ESM named
// exports, so `import { spawn } from 'node:child_process'` in src/ and test/ sees the guarded version.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach } from 'vitest';

const GUARDED = Symbol.for('minions.test.claudeGuard');
type Env = Record<string, string | undefined>;
type Opts = { env?: Env; cwd?: string | URL; shell?: boolean | string } | undefined;

const realDirs = (): Set<string> => {
  try { return new Set(JSON.parse(process.env.MINIONS_TEST_REAL_CLAUDE_DIRS ?? '[]') as string[]); } catch { return new Set(); }
};

if (!process.env.CLAUDE_CONFIG_DIR && process.env.MINIONS_TEST_CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = process.env.MINIONS_TEST_CLAUDE_CONFIG_DIR;

/** `claude` as a word in a shell string: not `.claude/`, `claude-plugin`, or `claude_x`. */
const CLAUDE_WORD = /(^|[\s;&|()`'"/=])claude(\.exe|\.js)?(?=$|[\s;&|()`'"])/;
/** The Claude Code package (the claude symlink points at its bin/claude.exe). */
const CLAUDE_PKG = /@anthropic-ai[\\/]claude-code[\\/]/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Programs that run their arguments as a command (`env claude`, `timeout 60 claude`, `npx claude`). */
const WRAPPERS = new Set(['tmux', 'env', 'timeout', 'nice', 'nohup', 'npx', 'stdbuf', 'xargs', 'sudo', 'setsid', 'script', 'time', 'ionice', 'unbuffer']);

const isClaudeBin = (p: string) => /^claude(\.exe|\.js)?$/.test(basename(p)) || CLAUDE_PKG.test(p);
const namesClaude = (s: string) => CLAUDE_WORD.test(s) || CLAUDE_PKG.test(s);

/** Whether the call would run claude: directly, through a shell string, a shell or wrapper program, or as a tmux pane command. */
export function startsClaude(cmd: string, args: readonly string[], shell: boolean): boolean {
  if (isClaudeBin(cmd)) return true;
  if (shell) return namesClaude([cmd, ...args].join(' '));
  // Any shell flag form (`-c`, `-lc`, `-e -c`) and any wrapper: an argument naming claude counts.
  const name = basename(cmd);
  if (SHELLS.has(name) || WRAPPERS.has(name)) return args.some(namesClaude);
  return false;
}

/** The config dir claude would use with this env and cwd (CLAUDE_CONFIG_DIR, else ~/.claude for HOME or the passwd home). */
export function effectiveConfigDir(env: Env, cwd?: string | URL): string {
  if (env.CLAUDE_CONFIG_DIR) return resolve(cwd === undefined ? process.cwd() : cwd instanceof URL ? cwd.pathname : cwd, env.CLAUDE_CONFIG_DIR);
  let home = env.HOME;
  if (!home) { try { home = userInfo().homedir; } catch { home = '/'; } }
  return join(home, '.claude');
}

/** Shared through globalThis so a test importing this module sees the setup file's instance. */
const violations: string[] = ((globalThis as Record<symbol, unknown>)[Symbol.for('minions.test.claudeGuard.violations')] ??= []) as string[];

/** Returns and clears the recorded violations (for tests of the guard itself). */
export const takeViolations = (): string[] => violations.splice(0);

function check(cmd: unknown, args: readonly string[], opts: Opts): void {
  if (typeof cmd !== 'string') return;
  if (!startsClaude(cmd, args, !!opts?.shell)) return;
  const dir = effectiveConfigDir(opts?.env ?? process.env, opts?.cwd);
  if (!realDirs().has(dir)) return;
  const msg = `test guard: refusing to start \`${[cmd, ...args].join(' ').slice(0, 200)}\` with the real Claude Code config dir ${dir}. `
    + 'Set CLAUDE_CONFIG_DIR (and HOME if needed) to a temp dir in the child env.';
  violations.push(msg);
  throw new Error(msg);
}

/** Splits the overloaded (file, args?, options?, callback?) signature. */
function split(rest: unknown[]): { args: string[]; opts: Opts } {
  const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
  const o = Array.isArray(rest[0]) ? rest[1] : rest[0];
  return { args, opts: o && typeof o === 'object' ? (o as Opts) : undefined };
}

type AnyFn = ((...a: unknown[]) => unknown) & { [GUARDED]?: true; [promisify.custom]?: unknown };
const mod = cp as unknown as Record<string, AnyFn>;

function wrap(name: string, inspect: (a: unknown[]) => void): void {
  const orig = mod[name]!;
  if (orig[GUARDED]) return;
  const wrapped: AnyFn = function (this: unknown, ...a: unknown[]) { inspect(a); return orig.apply(this, a); };
  wrapped[GUARDED] = true;
  const custom = orig[promisify.custom] as AnyFn | undefined;
  if (custom) wrapped[promisify.custom] = function (this: unknown, ...a: unknown[]) { inspect(a); return custom.apply(this, a); };
  mod[name] = wrapped;
}

for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  wrap(name, ([cmd, ...rest]) => { const { args, opts } = split(rest); check(cmd, args, opts); });
}
// fork runs a JS module with node: a fork of a Claude Code entry point starts claude.
wrap('fork', ([modulePath, ...rest]) => {
  if (typeof modulePath === 'string' && isClaudeBin(modulePath)) { const { args, opts } = split(rest); check('claude', args, opts); }
});
for (const name of ['exec', 'execSync']) {
  wrap(name, ([command, o]) => check(command, [], { ...(o && typeof o === 'object' ? (o as Opts) : {}), shell: true }));
}
syncBuiltinESMExports();

afterEach(() => {
  if (violations.length === 0) return;
  const all = takeViolations();
  throw new Error(all.join('\n'));
});
