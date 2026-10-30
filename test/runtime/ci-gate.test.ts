import { describe, expect, it } from 'vitest';
import { ciAuthorityReadiness } from '../../src/host/doctor.js';
import type { RequiredChecksReport } from '../../src/runtime/ci.js';
import { summarizeChecks } from '../../src/runtime/ci.js';
import { evaluateCiGate, type CiGateInput } from '../../src/runtime/ci-gate.js';
import { validateResult } from '../../src/runtime/results.js';
import { localVerificationComplete } from '../../src/runtime/scheduler.js';
import { defaults } from '../helpers.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const T0 = '2026-10-20T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000);

const required = (checks: string[], state: RequiredChecksReport['state'] = 'configured'): RequiredChecksReport =>
  ({ repository: 'acme/demo', baseBranch: 'main', state, requiredChecks: checks, protection: { protected: true, contexts: checks }, rulesets: { contexts: [] }, workflows: 1, errors: state === 'unknown' ? ['branch protection unreadable: HTTP 403'] : [] });
const obs = (head: string, checks: { name: string; state: string }[] | undefined, recorded_at = T0) =>
  ({ head_sha: head, recorded_at, details_json: JSON.stringify({ prState: 'OPEN', ci: checks ? { state: 'x', checks } : { state: 'passing' } }) });
const gate = (over: Partial<CiGateInput>) => evaluateCiGate({ ciAuthority: 'github', head: HEAD, required: required(['test']), observations: [], now: at(5), timeoutMinutes: 30, ...over });

describe('CI evidence gate (pure decision, fail closed)', () => {
  it('passes only when every required check passed for the exact head', () => {
    const g = gate({ required: required(['test', 'lint']), observations: [obs(HEAD, [{ name: 'test', state: 'pass' }, { name: 'lint', state: 'pass' }, { name: 'docs', state: 'fail' }])] });
    expect(g).toMatchObject({ state: 'pass', head: HEAD, requiredChecks: ['test', 'lint'], passed: ['test', 'lint'], reasons: [] });
  });

  it('never approves on disabled, unreadable or absent required checks, or a missing observation', () => {
    const passing = [obs(HEAD, [{ name: 'test', state: 'pass' }])];
    expect(gate({ ciAuthority: 'none', observations: passing }).state).toBe('disabled');
    expect(gate({ required: null, observations: passing }).state).toBe('unknown');
    expect(gate({ required: required([], 'unknown'), observations: passing })).toMatchObject({ state: 'unknown', reasons: [expect.stringMatching(/HTTP 403/)] });
    expect(gate({ required: required([], 'none'), observations: passing })).toMatchObject({ state: 'unknown', reasons: [expect.stringMatching(/never treated as zero required checks/)] });
    expect(gate({ observations: [] })).toMatchObject({ state: 'missing' });
    // An observation of another head is not evidence for this one.
    expect(gate({ observations: [obs(OTHER, [{ name: 'test', state: 'pass' }])] }).state).toBe('missing');
    // An older observation without per-check results is not evidence either.
    expect(gate({ observations: [obs(HEAD, undefined)] }).state).toBe('unknown');
  });

  it('failing, skipped and pending required checks never pass; pending turns into timeout', () => {
    expect(gate({ observations: [obs(HEAD, [{ name: 'test', state: 'fail' }])] })).toMatchObject({ state: 'fail', failed: ['test'] });
    // Two runs of the same name: the worst counts.
    expect(gate({ observations: [obs(HEAD, [{ name: 'test', state: 'pass' }, { name: 'test', state: 'fail' }])] }).state).toBe('fail');
    expect(gate({ observations: [obs(HEAD, [{ name: 'test', state: 'skipped' }])] })).toMatchObject({ state: 'unknown', reasons: [expect.stringMatching(/skipped/)] });
    const pending = [obs(HEAD, [{ name: 'test', state: 'pending' }])];
    expect(gate({ observations: pending, now: at(10) })).toMatchObject({ state: 'pending', pending: ['test'] });
    // A required check not reported at all is expected, i.e. pending.
    expect(gate({ observations: [obs(HEAD, [{ name: 'other', state: 'pass' }])], now: at(10) }).state).toBe('pending');
    // Timeout counts from the first observation of the head, not the latest.
    expect(gate({ observations: [...pending, obs(HEAD, [{ name: 'test', state: 'pending' }], at(29).toISOString())], now: at(31) })).toMatchObject({ state: 'timeout' });
  });
});

describe('local verification matching', () => {
  const cfgd = ['npm run typecheck', 'npm test'];
  it('requires every configured command, exact after env assignments and chaining', () => {
    expect(localVerificationComplete([{ command: 'npm run typecheck', outcome: 'pass' }, { command: 'npm test', outcome: 'pass' }], cfgd)).toBe(true);
    expect(localVerificationComplete([{ command: 'npm run typecheck', outcome: 'pass' }, { command: 'mkdir -p x && TMPDIR=x npm test', outcome: 'pass' }], cfgd)).toBe(true);
    expect(localVerificationComplete([{ command: 'TMPDIR=x npm test', outcome: 'pass' }], cfgd)).toBe(false);
    expect(localVerificationComplete([{ command: 'npm test --silent', outcome: 'pass' }, { command: 'npm run typecheck', outcome: 'pass' }], cfgd)).toBe(false);
    expect(localVerificationComplete([{ command: 'npm run typecheck', outcome: 'pass' }, { command: 'npm test', outcome: 'pass', source: 'ci' }], cfgd)).toBe(false);
    expect(localVerificationComplete([], [])).toBe(false);
    expect(localVerificationComplete([{ command: 'x', outcome: 'pass' }], [])).toBe(true);
  });

  it('does not loosen: no || split, lookalikes, case, a failing run, quoted && stay unmatched', () => {
    const one = ['npm test'];
    const m = (command: string, outcome = 'pass') => localVerificationComplete([{ command, outcome }], one);
    expect(m('npm test')).toBe(true);
    expect(m('npm test || true')).toBe(false);
    expect(m('true || npm test')).toBe(false);
    expect(m('npm test | tee out')).toBe(false);
    expect(m('npm test:fast')).toBe(false);
    expect(m('NPM TEST')).toBe(false);
    expect(m('echo "a && npm test"')).toBe(false);
    expect(m('npm test && echo done')).toBe(false);
    expect(m('npm test', 'fail')).toBe(false);
    expect(m('npm test', 'skipped')).toBe(false);
    expect(localVerificationComplete([{ command: 'npm run typecheck:fast', outcome: 'pass' }], ['npm run typecheck'])).toBe(false);
    expect(localVerificationComplete([{ command: 'npm   test', outcome: 'pass' }], one)).toBe(false);
  });
});

describe('per-check results in sync observations', () => {
  it('keeps each check by name and source; skipped stays apart from pass', () => {
    expect(summarizeChecks([
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'e2e', status: 'QUEUED', conclusion: null },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' },
    ]).checks).toEqual([
      { name: 'test', state: 'pass', source: 'check-run' }, { name: 'docs', state: 'skipped', source: 'check-run' }, { name: 'lint', state: 'fail', source: 'check-run' }, { name: 'e2e', state: 'pending', source: 'check-run' }, { name: 'ci/legacy', state: 'pass', source: 'status' },
    ]);
  });
});

describe('result contract: CI evidence entries', () => {
  const base = { status: 'complete', summary: 's', branch: 'agent/x', headSha: HEAD, modifiedPaths: [], acceptanceEvidence: [], findings: [], nextAction: 'n' };
  const ciCheck = { command: 'test', outcome: 'pass', source: 'ci', details: 'required check, GitHub Actions' };

  it('accepts source "ci" from testers and reviewers with ciAuthority github', () => {
    expect(validateResult({ ...base, checks: [ciCheck] }, 'tester', { ciAuthority: 'github' }).ok).toBe(true);
    expect(validateResult({ ...base, verdict: 'approve', checks: [ciCheck, { command: 'npm run lint', outcome: 'pass', source: 'local' }] }, 'reviewer', { ciAuthority: 'github' }).ok).toBe(true);
  });

  it('rejects CI entries without ciAuthority github, from engineers, skipped, or an unknown source', () => {
    const errs = (raw: unknown, role: 'engineer' | 'tester' | 'reviewer', ciAuthority?: 'none' | 'github') => {
      const v = validateResult(raw, role, { ciAuthority });
      return v.ok ? [] : v.errors;
    };
    expect(errs({ ...base, checks: [ciCheck] }, 'tester')).toEqual([expect.stringMatching(/need verification\.ciAuthority "github"/)]);
    expect(errs({ ...base, checks: [ciCheck] }, 'tester', 'none')).toHaveLength(1);
    expect(errs({ ...base, checks: [ciCheck] }, 'engineer', 'github')).toEqual([expect.stringMatching(/only tester and reviewer/)]);
    expect(errs({ ...base, checks: [{ ...ciCheck, outcome: 'skipped' }] }, 'tester', 'github')).toEqual([expect.stringMatching(/pass or fail, not skipped/)]);
    expect(errs({ ...base, checks: [{ ...ciCheck, outcome: 'fail' }] }, 'tester', 'github')).toEqual([expect.stringMatching(/cannot report failing checks/)]);
    expect(errs({ ...base, checks: [{ ...ciCheck, source: 'github' }] }, 'tester', 'github')).toHaveLength(1);
    // Local checks without a source keep working everywhere.
    expect(errs({ ...base, checks: [{ command: 'npm test', outcome: 'pass' }] }, 'engineer')).toEqual([]);
  });
});

describe('doctor ci.authority readiness', () => {
  const cfg = (ci: 'none' | 'github', mode: 'local' | 'pull-request' = 'pull-request') => {
    const c = defaults();
    c.verification.ciAuthority = ci;
    c.delivery.mode = mode;
    return c;
  };
  it('is ready only with ciAuthority github, pull-request delivery and readable required checks; never fails', () => {
    expect(ciAuthorityReadiness(cfg('github'), required(['test']), { onGitHub: true })).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^ready: required checks on main \(test\).*timeout 60 min/) });
    expect(ciAuthorityReadiness(cfg('github'), required([], 'none'), { onGitHub: true })).toMatchObject({ status: 'warn', detail: expect.stringMatching(/no required status checks.*fall back to local/) });
    expect(ciAuthorityReadiness(cfg('github'), required([], 'unknown'), { onGitHub: true })).toMatchObject({ status: 'warn', detail: expect.stringMatching(/could not be read/) });
    expect(ciAuthorityReadiness(cfg('github'), null, { onGitHub: false }).status).toBe('warn');
    expect(ciAuthorityReadiness(cfg('github', 'local'), required(['test']), { onGitHub: true })).toMatchObject({ status: 'warn', detail: expect.stringMatching(/delivery\.mode is local/) });
    expect(ciAuthorityReadiness(cfg('none'), required(['test']), { onGitHub: true })).toMatchObject({ status: 'ok', hint: expect.stringMatching(/verification\.ciAuthority to "github"/) });
    expect(ciAuthorityReadiness(cfg('none'), null, { onGitHub: false })).toMatchObject({ status: 'ok', detail: expect.stringMatching(/verify locally/) });
  });
});
