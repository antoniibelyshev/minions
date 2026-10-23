// QA sweep tooling (task-24): `npm run coverage` instruments only on demand, `npm test` stays a plain
// `vitest run`, and the coverage provider matches the installed vitest major (vitest refuses a mismatch).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  scripts: Record<string, string>; devDependencies: Record<string, string>;
};
const major = (range: string) => /\d+/.exec(range)?.[0];

describe('QA sweep tooling', () => {
  it('keeps npm test uninstrumented and adds npm run coverage', () => {
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.scripts.coverage).toBe('vitest run --coverage');
  });

  it('pins @vitest/coverage-v8 to the vitest major, also in the lockfile', () => {
    const v8 = pkg.devDependencies['@vitest/coverage-v8'];
    expect(v8).toBeDefined();
    expect(major(v8!)).toBe(major(pkg.devDependencies.vitest!));
    const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8')) as { packages: Record<string, { version?: string }> };
    expect(lock.packages['node_modules/@vitest/coverage-v8']?.version).toBe(lock.packages['node_modules/vitest']?.version);
  });

  it('ships the perf probe and the pilot report the recipe refers to', () => {
    expect(pkg.scripts['qa:perf']).toContain('scripts/qa-perf.mjs');
    expect(existsSync(new URL('scripts/qa-perf.mjs', root))).toBe(true);
    const doc = readFileSync(new URL('docs/qa/2026-10-pilot.md', root), 'utf8');
    for (const s of ['npm run coverage', 'npm run qa:perf', 'qa-pilot:']) expect(doc).toContain(s);
  });
});
