import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileDefaults } from '../src/config/profiles.js';
import type { Profile } from '../src/config/schema.js';

export const ctx = {
  hasGitHub: true,
  baseBranch: 'main',
  identity: { name: 'Ada', email: 'ada@example.com' },
  projectId: '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f',
  packageVersion: '0.1.0',
};
export const defaults = (p: Profile = 'project-owner', c = ctx) => profileDefaults(p, c).config;

/**
 * Runs a PreToolUse hook command string the way Claude Code does (through a shell, hook JSON on stdin)
 * with a controlled PATH. `minions` is the fake binary's script, or null for no binary on PATH.
 * Returns the exit status (2 is the only blocking one) and stdout.
 */
export function runHookCommand(command: string, minions: string | null, stdin = '{}'): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'minions-hookcmd-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (minions !== null) { writeFileSync(join(bin, 'minions'), minions); chmodSync(join(bin, 'minions'), 0o755); }
  const r = spawnSync('sh', ['-c', command], { input: stdin, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout };
}

/** Fake `minions` binaries for runHookCommand. */
export const FAKE_MINIONS = {
  crash: '#!/bin/sh\necho "TypeError: boom" >&2\nexit 1\n',
  killed: '#!/bin/sh\nkill -9 $$\n',
  allow: '#!/bin/sh\ncat >/dev/null\nexit 0\n',
  deny: '#!/bin/sh\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}\'\nexit 0\n',
};
