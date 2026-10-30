import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { INTEGRATION_TESTS } from './test/tiers.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const docker = process.env.MINIONS_DOCKER_TESTS === '1';

/**
 * Bounded concurrency (task-81). The container caps tasks at pids.max = 512, and that limit counts threads,
 * not processes: with vitest's default (one worker per core but one) a single suite peaked near 190 threads,
 * so the integration gate and two worker suites running at once hit the cap ("failed to create new OS
 * thread", spawn EAGAIN, a vitest EPIPE). Four workers are as fast here (the suite is subprocess-bound), and
 * MINIONS_TEST_MAX_WORKERS overrides the cap (e.g. 1 on a tiny machine, more on an idle host).
 */
const maxWorkers = Number(process.env.MINIONS_TEST_MAX_WORKERS) || 4;
// Fewer threads per child process, inherited by the workers and everything the tests spawn (set before any
// worker starts; an explicit value wins). Each `backlog` CLI call (a Bun binary) starts concurrent-JIT
// threads per core, 8-30 per call under load instead of 3; every node process starts 4 V8 platform threads
// (7 threads idle, 4 with a pool of 1) and a libuv pool of 4 on first fs use. Code under test that scrubs
// NODE_OPTIONS from a child env still does; this only trims threads where the variable is inherited.
process.env.BUN_JSC_useConcurrentJIT ??= '0';
process.env.UV_THREADPOOL_SIZE ??= '2';
if (!/--v8-pool-size/.test(process.env.NODE_OPTIONS ?? '')) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --v8-pool-size=1`.trim();
// Hermetic MINIONS_* environment (task-5). A worker or coordinator runs `npm test` with its runtime's
// MINIONS_* set: MINIONS_SESSION (task-57 phase 6) scopes claims, context resets and hooks to that session;
// MINIONS_RUNTIME=host flips the runtime the code under test detects; MINIONS_HOME, MINIONS_STATE_DIR,
// MINIONS_CONFIG, MINIONS_WORKSPACE and friends point at the live install. Every test that needs one sets it
// itself, so the suite starts with none of them. Kept: the switches that only steer the suite (MINIONS_TEST_*,
// MINIONS_DOCKER_TESTS, MINIONS_SANDBOX_TEST_BIN, MINIONS_DEBUG, and MINIONS_LIVE_* outside a worker lease,
// whose live runs only the coordinator starts).
const KEEP_ENV = /^MINIONS_(TEST_.+|DOCKER_TESTS|SANDBOX_TEST_BIN|DEBUG)$/;
const inWorker = !!process.env.MINIONS_WORKER_LEASE;
for (const name of Object.keys(process.env)) {
  if (!name.startsWith('MINIONS_') || KEEP_ENV.test(name)) continue;
  if (!inWorker && /^MINIONS_LIVE_/.test(name)) continue;
  delete process.env[name];
}
// Tokens go to the 0600 file store under the test's MINIONS_HOME, never the user's login Keychain or keyring: the
// host-wide items (minions.manager, ...) have a fixed account, so a macOS run of setup overwrote the real manager
// token, and an isolated HOME (the integration gate) made the write fail. Tests of the other stores set it themselves.
process.env.MINIONS_CREDENTIAL_STORE = 'file';

/**
 * Two tiers (task-137.1), as vitest projects: `unit` (no subprocesses, git repos or network; enforced by
 * test/setup/no-subprocess.ts) and `integration` (the files listed in test/tiers.ts). `npm test` runs both;
 * `npm run test:unit` / `npm run test:integration` select one with --project.
 */
const shared = {
  define: { __MINIONS_VERSION__: JSON.stringify(pkg.version) },
} as const;
const sharedTest = {
  exclude: ['node_modules/**', 'dist/**', ...(docker ? [] : ['test/docker/**'])],
  // Headroom for the local integration gate (task-81): `npm test` runs on the merged tree while other
  // workers run their own suites, and many tests here do real git and subprocess work that takes ~1 s idle
  // but ran past the 5 s default under that load. A higher default only gives slow-but-correct tests time;
  // a failing assertion still fails at once, and there are no retries. Tests asserting wall-clock bounds
  // must not depend on this: they inject their clock or budget instead (task-93, task-95).
  testTimeout: 20_000,
  hookTimeout: 30_000,
  // Claude Code never runs against the user's real ~/.claude (its plugins, e.g. the Telegram channel).
  globalSetup: ['test/setup/global.ts'],
  setupFiles: ['test/setup/claude-guard.ts', 'test/setup/tmpdir.ts'],
};

export default defineConfig({
  ...shared,
  test: {
    maxWorkers,
    projects: [
      {
        ...shared,
        test: {
          ...sharedTest,
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...sharedTest.exclude, ...INTEGRATION_TESTS],
          globalSetup: [...sharedTest.globalSetup, 'test/setup/no-subprocess-report.ts'],
          setupFiles: [...sharedTest.setupFiles, 'test/setup/no-subprocess.ts'],
        },
      },
      { ...shared, test: { ...sharedTest, name: 'integration', include: [...INTEGRATION_TESTS] } },
    ],
    // Only active with --coverage (`npm run coverage`); `npm test` does not instrument.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
