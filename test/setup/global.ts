// Vitest globalSetup (main process, before any worker starts): isolates Claude Code from the user's
// real config. A `claude` started with the user's ~/.claude loads their globally enabled plugins; the
// Telegram channel plugin then replaces the running coordinator's poller and drops its connection.
// Workers inherit CLAUDE_CONFIG_DIR from here; test/setup/claude-guard.ts enforces it per test.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

export default function setup(): () => void {
  // Each vitest project (unit, integration: task-137.1) runs its globalSetup in this one process. The first
  // call isolates; a later one must not count the first temp dir as "real", so it keeps the same setup.
  const done = Symbol.for('minions.test.globalSetup');
  const g = globalThis as Record<symbol, unknown>;
  if (g[done]) return () => {};
  g[done] = true;
  // Every config dir a nested claude must never use: the inherited CLAUDE_CONFIG_DIR, ~/.claude for
  // $HOME and for the passwd home (claude falls back to it when HOME is unset).
  const real = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) real.add(resolve(process.env.CLAUDE_CONFIG_DIR));
  real.add(join(homedir(), '.claude'));
  try { real.add(join(userInfo().homedir, '.claude')); } catch { /* no passwd entry */ }

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'minions-test-claude-config-')));
  process.env.MINIONS_TEST_REAL_CLAUDE_DIRS = JSON.stringify([...real]);
  process.env.MINIONS_TEST_CLAUDE_CONFIG_DIR = dir;
  process.env.CLAUDE_CONFIG_DIR = dir;
  return () => { delete g[done]; rmSync(dir, { recursive: true, force: true }); };
}
