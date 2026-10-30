import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileDefaults } from '../src/config/profiles.js';
import type { Profile } from '../src/config/schema.js';
import { HANG_GUARD_TIMEOUT_TEST, HOOK_WRAPPER_TIMEOUT_S } from '../src/runtime/hook-guard.js';

export const ctx = {
  hasGitHub: true,
  baseBranch: 'main',
  identity: { name: 'Ada', email: 'ada@example.com' },
  projectId: '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f',
  packageVersion: '0.1.0',
};
export const defaults = (p: Profile = 'project-owner', c = ctx) => profileDefaults(p, c).config;

/**
 * Whether this host has the Linux /proc the runtime's process code reads. Container-only code (the process runner and
 * its recovery, the session supervisor, the integrator's verify group) identifies processes and the host by /proc
 * (boot id, start times) and fails closed without it; the runtime always runs in the Linux container. Tests of those
 * paths skip on the macOS host gate (task-105) until the host runtime has a ps-based view (docs/design/host-runtime.md).
 */
export const HAS_PROCFS = process.platform === 'linux';

/**
 * The hook commands wrap `minions` in coreutils `timeout` (`timeout 20 minions hook ... || exit 2`); they run in the
 * Linux runtime image, which has it. A host without one (macOS) gets test/fixtures/timeout-shim.mjs, which keeps the
 * exit codes the wrapper relies on, so the tests still run the real command strings there (task-105).
 * MINIONS_TEST_TIMEOUT_SHIM=1 uses the shim on Linux too.
 */
const TIMEOUT_SHIM = (process.env.MINIONS_TEST_TIMEOUT_SHIM === '1'
  || spawnSync('sh', ['-c', 'command -v timeout'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }).status !== 0)
  ? join(import.meta.dirname, 'fixtures', 'timeout-shim.mjs') : null;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Runs a PreToolUse hook command string the way Claude Code does (through a shell, hook JSON on stdin)
 * with a controlled PATH. `minions` is the fake binary's script, or null for no binary on PATH.
 * Returns the exit status (2 is the only blocking one), stdout and stderr (stderr lets a test prove the
 * fake actually ran, rather than failing to exec, e.g. from a noexec TMPDIR).
 */
export function runHookCommand(command: string, minions: string | null, stdin = '{}'): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'minions-hookcmd-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (minions !== null) { writeFileSync(join(bin, 'minions'), minions); chmodSync(join(bin, 'minions'), 0o755); }
  if (TIMEOUT_SHIM) { writeFileSync(join(bin, 'timeout'), `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(TIMEOUT_SHIM)} "$@"\n`); chmodSync(join(bin, 'timeout'), 0o755); }
  const r = spawnSync('sh', ['-c', command], { input: stdin, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** True when runHookCommand's PATH has coreutils `timeout` (Linux; not stock macOS). */
export const HAS_COREUTILS_TIMEOUT = spawnSync('sh', ['-c', 'command -v timeout'], { env: { PATH: '/usr/bin:/bin' } }).status === 0;

/**
 * A hook command with its hang guard (src/runtime/hook-guard.ts) forced to one branch (`coreutils` or the `perl`
 * fallback) and/or a shorter deadline. Throws when the command has no guard, so a test cannot silently test nothing.
 */
export function withHangGuard(command: string, o: { guard?: 'coreutils' | 'perl'; seconds?: number }): string {
  if (!/; then timeout \d+ minions hook /.test(command)) throw new Error(`no hang guard in: ${command}`);
  let c = command;
  if (o.guard) c = c.replaceAll(HANG_GUARD_TIMEOUT_TEST, o.guard === 'coreutils' ? 'true' : 'false');
  if (o.seconds !== undefined) c = c.replaceAll(` ${HOOK_WRAPPER_TIMEOUT_S} minions hook `, ` ${o.seconds} minions hook `);
  return c;
}

/** Fake `minions` binaries for runHookCommand. */
export const FAKE_MINIONS = {
  crash: '#!/bin/sh\necho "TypeError: boom" >&2\nexit 1\n',
  killed: '#!/bin/sh\nkill -9 $$\n',
  allow: '#!/bin/sh\ncat >/dev/null\nexit 0\n',
  terminated: '#!/bin/sh\necho "minions-fake: terminating" >&2\nkill -TERM $$\n',
  /** A valid "allow" decision on stdout but a non-zero exit: the wrapper must still turn it into exit 2. */
  allowThenFail: '#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'\necho "minions-fake: failing" >&2\nexit 3\n',
  /** The minions shim exists but its interpreter does not (exec fails with 127). */
  noNode: '#!/bin/sh\nexec /nonexistent/node /nonexistent/cli.js "$@"\n',
  deny: '#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}\'\nexit 0\n',
};
