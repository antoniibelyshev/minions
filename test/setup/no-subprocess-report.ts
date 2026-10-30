// Vitest globalSetup for the unit tier (task-137.1): collects the subprocess starts test/setup/no-subprocess.ts
// refused and fails the run if there were any. That guard also fails the test, but Vitest runs no hooks in a
// file whose tests are all skipped, so a caught spawn there (an availability probe deciding a skipIf) would
// otherwise pass unnoticed.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'minions-test-spawn-log-'));
  const log = join(dir, 'spawns.log');
  process.env.MINIONS_TEST_SPAWN_LOG = log;
  return () => {
    let text = '';
    try { text = readFileSync(log, 'utf8'); } catch { /* no violations */ }
    rmSync(dir, { recursive: true, force: true });
    if (!text) return;
    const files = [...new Set(text.trim().split('\n').map((l) => l.split('\t')[0]))];
    throw new Error(`unit tier: these test files start subprocesses; move them to INTEGRATION_TESTS in test/tiers.ts:\n${files.join('\n')}\n\n${text}`);
  };
}
