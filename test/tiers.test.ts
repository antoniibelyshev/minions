// The unit/integration split (task-137.1): the list in test/tiers.ts stays exact, and the unit tier's
// subprocess guard is really installed (this file runs in the unit tier).
import cp, { execFileSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTEGRATION_TESTS } from './tiers.js';

const ROOT = join(import.meta.dirname, '..');
const ALL = (readdirSync(join(ROOT, 'test'), { recursive: true, encoding: 'utf8' }))
  .filter((f) => f.endsWith('.test.ts')).map((f) => relative(ROOT, join(ROOT, 'test', f)).split('\\').join('/')).sort();
const matches = (entry: string, file: string) => (entry.endsWith('/**') ? file.startsWith(entry.slice(0, -2)) : file === entry);

describe('test tiers', () => {
  it('every integration entry names existing test files, once', () => {
    expect(new Set(INTEGRATION_TESTS).size).toBe(INTEGRATION_TESTS.length);
    for (const entry of INTEGRATION_TESTS) expect(ALL.some((f) => matches(entry, f)), entry).toBe(true);
    for (const f of ALL) expect(INTEGRATION_TESTS.filter((e) => matches(e, f)).length, f).toBeLessThanOrEqual(1);
  });

  it('this file is in the unit tier, and the unit tier refuses subprocesses', async () => {
    expect(INTEGRATION_TESTS.some((e) => matches(e, 'test/tiers.test.ts'))).toBe(false);
    const g = globalThis as Record<symbol, unknown>;
    const violations = g[Symbol.for('minions.test.noSubprocess.violations')] as string[];
    const log = process.env.MINIONS_TEST_SPAWN_LOG;
    // Probe with the log off, then drop the recorded violations: the refusal itself is what is under test.
    delete process.env.MINIONS_TEST_SPAWN_LOG;
    try {
      expect(() => execFileSync('true')).toThrow(/unit tier: execFileSync\(`true`\) starts a subprocess/);
      expect(() => spawn('git', ['status'])).toThrow(/unit tier: spawn\(`git status`\)/);
      expect(() => cp.exec('echo hi')).toThrow(/unit tier: exec/);
    } finally {
      violations.splice(0);
      if (log !== undefined) process.env.MINIONS_TEST_SPAWN_LOG = log;
    }
  });
});
