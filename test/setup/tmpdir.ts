// Vitest setupFiles (runs per test file): points TMPDIR at a private dir and removes it in afterAll, so the
// many mkdtemp() dirs the suites create (minions-rt-*, minions-gh-*, ...) do not pile up on the cache volume.
// os.tmpdir() reads TMPDIR on each call, so every helper picks this up.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'minions-test-tmp-')));
process.env.TMPDIR = dir;
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
