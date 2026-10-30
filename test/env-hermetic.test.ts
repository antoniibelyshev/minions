// Task-5: the suite never sees the ambient MINIONS_* environment of the runtime that starts `npm test` (a worker on
// the host runtime has MINIONS_RUNTIME=host, MINIONS_HOME, MINIONS_STATE_DIR, ... pointing at the live install).
// vitest.config.ts drops them before any worker starts; only the suite's own switches stay.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const KEPT = /^MINIONS_(TEST_.+|DOCKER_TESTS|SANDBOX_TEST_BIN|DEBUG|LIVE_.+)$/;

describe('hermetic MINIONS_* environment', () => {
  it('no runtime MINIONS_* variable reaches a test file or the processes it starts', () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith('MINIONS_') && !KEPT.test(k))).toEqual([]);
    const child = spawnSync('sh', ['-c', 'env'], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.split('=')[0]!);
    expect(child.filter((k) => k.startsWith('MINIONS_') && !KEPT.test(k))).toEqual([]);
  });
});
