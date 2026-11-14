// Vitest setupFiles for the unit tier only (task-137.1): any subprocess start fails the test file, so a test
// that spawns (git, the built CLI, npm, the Bun backlog binary, docker, a shell), directly or through src/,
// cannot sit in the unit tier. Such a file belongs in INTEGRATION_TESTS (test/tiers.ts).
//
// Same technique as claude-guard.ts: the child_process functions are wrapped on the builtin module and
// re-synced into its ESM named exports. A call throws, and the violation is also recorded and rethrown in
// afterEach, so code that catches the error (a "git missing" fallback) still fails the test. Tests that
// vi.mock('node:child_process') never reach the real module and are unaffected. Vitest runs no hooks in a file
// whose tests are all skipped, so each violation is also appended to MINIONS_TEST_SPAWN_LOG, and
// test/setup/no-subprocess-report.ts fails the unit run when that log is not empty (a caught spawn at import
// time, e.g. a `backlog --version` probe deciding a skipIf, still lands the file in the right tier).
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { afterAll, afterEach, expect } from 'vitest';

const GUARDED = Symbol.for('minions.test.noSubprocess');
type AnyFn = ((...a: unknown[]) => unknown) & { [GUARDED]?: true; [promisify.custom]?: unknown };
const mod = cp as unknown as Record<string, AnyFn>;
const violations: string[] = ((globalThis as Record<symbol, unknown>)[Symbol.for('minions.test.noSubprocess.violations')] ??= []) as string[];

function refuse(name: string, a: unknown[]): never {
  const what = [a[0], ...(Array.isArray(a[1]) ? (a[1] as unknown[]) : [])].map(String).join(' ').slice(0, 200);
  const msg = `unit tier: ${name}(\`${what}\`) starts a subprocess. Unit tests must not spawn (directly or through src/); `
    + 'move this file to INTEGRATION_TESTS in test/tiers.ts, or mock the call.';
  violations.push(msg);
  const log = process.env.MINIONS_TEST_SPAWN_LOG;
  if (log) appendFileSync(log, `${expect.getState().testPath ?? '(unknown file)'}\t${msg}\n`);
  throw new Error(msg);
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const orig = mod[name]!;
  if (orig[GUARDED]) continue;
  const wrapped: AnyFn = (...a: unknown[]) => refuse(name, a);
  wrapped[GUARDED] = true;
  if (orig[promisify.custom]) wrapped[promisify.custom] = (...a: unknown[]) => refuse(name, a);
  mod[name] = wrapped;
}
syncBuiltinESMExports();

const fail = () => { if (violations.length) throw new Error(violations.splice(0).join('\n')); };
afterEach(fail);
// A spawn at import time or in a beforeAll/afterAll hook happens outside any test.
afterAll(fail);
