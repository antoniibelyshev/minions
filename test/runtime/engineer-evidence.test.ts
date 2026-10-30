// task-137.3: a complete engineer result must carry passing typecheck + unit-tier evidence. The scheduler
// passes verification.commands for the built-in engineer; validateResult refuses a complete result with a
// failing check, a skipped configured command or no passing test run. blocked/partial stay allowed.
import { describe, expect, it } from 'vitest';
import { validateResult } from '../../src/runtime/results.js';

const SHA = 'a'.repeat(40);
const CONFIGURED = ['npm run typecheck', 'npm test'];
const pass = (command: string) => ({ command, outcome: 'pass' as const });
const res = (checks: unknown[], status = 'complete') => ({
  status, summary: 'done', branch: 'agent/x', headSha: SHA, modifiedPaths: ['a.ts'], checks,
  acceptanceEvidence: [{ criterion: 'works', evidence: 'test' }], findings: [], nextAction: 'review',
});
const errorsOf = (raw: unknown, ...cmds: [string[] | undefined] | []) => {
  const v = validateResult(raw, 'engineer', { verificationCommands: cmds.length ? cmds[0] : CONFIGURED });
  return v.ok ? [] : v.errors;
};

describe('engineer complete needs passing verification evidence', () => {
  it('accepts typecheck plus the unit tier instead of the full configured suite', () => {
    expect(errorsOf(res([pass('npm run typecheck'), pass('npm run test:unit')]))).toEqual([]);
    // Env-prefixed forms (the lease scratch dir, which may contain a space) count too.
    expect(errorsOf(res([pass('npm run typecheck'), pass('TMPDIR="/state/cache/tmp/leases/a b" npm run test:unit')]))).toEqual([]);
    // Targeted files and the full suite are test runs as well.
    expect(errorsOf(res([pass('npm run typecheck'), pass('npx vitest run test/runtime/engineer-evidence.test.ts')]))).toEqual([]);
    expect(errorsOf(res([pass('npm run typecheck'), pass('npm test')]))).toEqual([]);
  });

  it('refuses a failing check', () => {
    const errs = errorsOf(res([pass('npm run typecheck'), { command: 'npm run test:unit', outcome: 'fail' }]));
    expect(errs).toEqual([
      expect.stringMatching(/complete engineer \(producer\) result cannot report failing checks \(npm run test:unit\); fix them, or use partial or blocked/),
      expect.stringMatching(/needs a passing test run/), // the failed unit run is the only test run
    ]);
    // A failing extra check is refused even when the typecheck and the unit tier passed.
    expect(errorsOf(res([pass('npm run typecheck'), pass('npm run test:unit'), { command: 'npm run lint', outcome: 'fail' }])))
      .toEqual([expect.stringMatching(/cannot report failing checks \(npm run lint\)/)]);
  });

  it('refuses a missing run: no checks, no test run, or a configured command reported skipped', () => {
    expect(errorsOf(res([]))).toEqual([expect.stringMatching(/needs passing verification evidence .*configured: npm run typecheck, npm test/)]);
    expect(errorsOf(res([pass('npm run typecheck')]))).toEqual([expect.stringMatching(/needs a passing test run \(the unit tier/)]);
    expect(errorsOf(res([{ command: 'TMPDIR=/x npm run typecheck', outcome: 'skipped' }, pass('npm run test:unit')])))
      .toEqual([expect.stringMatching(/cannot skip configured verification \(npm run typecheck\)/)]);
  });

  it('blocked, partial and needs_split stay allowed with failing or missing runs', () => {
    for (const status of ['blocked', 'partial', 'needs_split']) {
      expect(errorsOf(res([{ command: 'npm run test:unit', outcome: 'fail' }], status)), status).toEqual([]);
      expect(errorsOf(res([], status)), status).toEqual([]);
    }
  });

  it('with no verification configured, only failing checks are refused', () => {
    expect(errorsOf(res([]), [])).toEqual([]);
    expect(errorsOf(res([{ command: 'make check', outcome: 'fail' }]), [])).toEqual([expect.stringMatching(/cannot report failing checks/)]);
  });

  it('without verificationCommands (custom producer roles) the producer rules are unchanged', () => {
    expect(errorsOf(res([{ command: 'npm test', outcome: 'fail' }]), undefined)).toEqual([]);
    expect(validateResult(res([]), 'producer').ok).toBe(true);
  });

  it('a configured command without "test" in it needs no test run', () => {
    expect(errorsOf(res([pass('cargo build')]), ['cargo build'])).toEqual([]);
  });
});
