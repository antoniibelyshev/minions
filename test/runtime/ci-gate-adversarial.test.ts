// Adversarial tests for the CI evidence gate (task-1.11, tester). Everything runs on a temp runtime DB and a
// mocked gh; nothing touches the live state.
import { describe, expect, it } from 'vitest';
import { requiredChecksStatus, summarizeChecks, type ApiGet, type RequiredChecksReport } from '../../src/runtime/ci.js';
import { evaluateCiGate, type CiGateInput } from '../../src/runtime/ci-gate.js';
import { validateResult } from '../../src/runtime/results.js';

const HEAD = 'a'.repeat(40);
const T0 = '2026-10-20T10:00:00.000Z';
const R = '/repos/acme/demo';

const report = (checks: string[]): RequiredChecksReport =>
  ({ repository: 'acme/demo', baseBranch: 'main', state: 'configured', requiredChecks: checks, protection: { protected: true, contexts: checks }, rulesets: { contexts: [] }, workflows: 1, errors: [] });
const obs = (checks: { name: string; state: string }[], head = HEAD, recorded_at = T0) =>
  ({ head_sha: head, recorded_at, details_json: JSON.stringify({ ci: { checks } }) });
const gate = (over: Partial<CiGateInput>) => evaluateCiGate({ ciAuthority: 'github', head: HEAD, required: report(['test']), observations: [], now: new Date(Date.parse(T0) + 60_000), timeoutMinutes: 30, ...over });

/** ApiGet from a path -> response map; unknown paths are 404. */
const api = (m: Record<string, { status: number; body?: unknown; error?: string }>): ApiGet =>
  async (p) => m[p] ? { body: null, ...m[p]! } : { status: 404, body: null, error: 'HTTP 404' };
const protection = (contexts: string[]) => ({ status: 200, body: { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts } } } });
const rulesetsFor = (contexts: string[]) => ({ status: 200, body: [{ type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) } }] });

describe('required checks come only from protection/rulesets, never from what ran', () => {
  it('a check that ran but is not required does not satisfy a required one', () => {
    expect(gate({ observations: [obs([{ name: 'lint', state: 'pass' }, { name: 'Test', state: 'pass' }, { name: 'test ', state: 'pass' }])] }).state).toBe('pending');
  });

  it('an empty rollup with required checks configured is pending, then timeout; never pass', () => {
    expect(gate({ observations: [obs([])] }).state).toBe('pending');
    expect(gate({ observations: [obs([])], now: new Date(Date.parse(T0) + 31 * 60_000) }).state).toBe('timeout');
  });

  it('protection and rulesets are unioned', async () => {
    const r = await requiredChecksStatus(api({ [`${R}/branches/main`]: protection(['lint']), [`${R}/rules/branches/main`]: rulesetsFor(['test']) }), 'acme/demo', 'main');
    expect(r).toMatchObject({ state: 'configured', requiredChecks: ['lint', 'test'] });
    expect(gate({ required: r, observations: [obs([{ name: 'lint', state: 'pass' }])] }).state).toBe('pending');
  });

  it('protection with enforcement off and no rulesets is "none" -> gate unknown (not zero required checks)', async () => {
    const r = await requiredChecksStatus(api({
      [`${R}/branches/main`]: { status: 200, body: { protected: true, protection: { required_status_checks: { enforcement_level: 'off', contexts: ['test'] } } } },
    }), 'acme/demo', 'main');
    expect(r.state).toBe('none');
    expect(gate({ required: r, observations: [obs([{ name: 'test', state: 'pass' }])] }).state).toBe('unknown');
  });

  it('branch 404, protection 403 or a rate limit on both sources is unknown', async () => {
    for (const s of [404, 403, 429, 0]) {
      const r = await requiredChecksStatus(api({ [`${R}/branches/main`]: { status: s, error: `HTTP ${s}` }, [`${R}/rules/branches/main`]: { status: s === 404 ? 404 : s, error: `HTTP ${s}` } }), 'acme/demo', 'main');
      expect(r.state).toBe('unknown');
      expect(gate({ required: r, observations: [obs([{ name: 'test', state: 'pass' }])] }).state).toBe('unknown');
    }
  });

  // Fixed defect: a partial read (one source readable with checks, the other erroring) is `unknown`, because the
  // unreadable source may require more checks than the readable one lists.
  it('a partial read (rulesets unreadable) is not evidence', async () => {
    const r = await requiredChecksStatus(api({ [`${R}/branches/main`]: protection(['lint']), [`${R}/rules/branches/main`]: { status: 500, error: 'HTTP 500' } }), 'acme/demo', 'main');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.state).toBe('unknown');
    // The unreadable ruleset may require `test`, which is failing here; the gate must not pass on `lint` alone.
    expect(gate({ required: r, observations: [obs([{ name: 'lint', state: 'pass' }, { name: 'test', state: 'fail' }])] }).state).not.toBe('pass');
  });

  it('a partial read (protection unreadable, rulesets readable) is not evidence', async () => {
    const r = await requiredChecksStatus(api({ [`${R}/branches/main`]: { status: 403, error: 'HTTP 403' }, [`${R}/rules/branches/main`]: rulesetsFor(['lint']) }), 'acme/demo', 'main');
    expect(r.state).toBe('unknown');
    expect(gate({ required: r, observations: [obs([{ name: 'lint', state: 'pass' }])] }).state).toBe('unknown');
  });

  it('a 404 for rules still means "no rulesets" (protection alone is a complete read)', async () => {
    const r = await requiredChecksStatus(api({ [`${R}/branches/main`]: protection(['lint']) }), 'acme/demo', 'main');
    expect(r).toMatchObject({ state: 'configured', requiredChecks: ['lint'], requirements: [{ context: 'lint', appId: null }] });
  });

  it('app pins are read from protection checks[].app_id and ruleset integration_id (null / -1 = any source)', async () => {
    const r = await requiredChecksStatus(api({
      [`${R}/branches/main`]: { status: 200, body: { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['lint', 'build', 'any'], checks: [{ context: 'lint', app_id: 15368 }, { context: 'build', app_id: -1 }, { context: 'any', app_id: null }] } } } },
      [`${R}/rules/branches/main`]: rulesetsFor(['test']),
    }), 'acme/demo', 'main');
    expect(r.requirements).toEqual([
      { context: 'any', appId: null }, { context: 'build', appId: null }, { context: 'lint', appId: 15368 }, { context: 'test', appId: 15368 },
    ]);
  });
});

describe('check identity (name collisions, other apps)', () => {
  const status = (context: string, state: string) => ({ __typename: 'StatusContext', context, state });
  const run = (name: string, conclusion: string | null, status = conclusion ? 'COMPLETED' : 'IN_PROGRESS') => ({ __typename: 'CheckRun', name, status, conclusion });

  it('a fake passing commit status cannot mask the real failing or pending check of the same name (worst wins)', () => {
    const failing = summarizeChecks([run('test', 'FAILURE'), status('test', 'SUCCESS')]).checks;
    expect(gate({ observations: [obs(failing)] }).state).toBe('fail');
    const pending = summarizeChecks([status('test', 'SUCCESS'), run('test', null)]).checks;
    expect(gate({ observations: [obs(pending)] }).state).toBe('pending');
  });

  // RESIDUAL (documented in docs/design/bootstrap.md): a required check that GitHub does not pin to an app is
  // matched by name only, as GitHub itself does, so a commit status named `test` satisfies it.
  it('residual: an unpinned required check is satisfied by a lone commit status with its name', () => {
    const forged = summarizeChecks([status('test', 'SUCCESS')]).checks;
    expect(gate({ observations: [obs(forged)] }).state).toBe('pass');
  });

  const pinned = (appId = 15368): RequiredChecksReport => ({ ...report(['test']), requirements: [{ context: 'test', appId }] });
  const appRun = (name: string, conclusion: string | null, appId: number) => ({ ...run(name, conclusion), appId });

  it('a pinned required check is satisfied only by a check run of that app', () => {
    expect(gate({ required: pinned(), observations: [obs(summarizeChecks([appRun('test', 'SUCCESS', 15368)]).checks)] }).state).toBe('pass');
    // A forged status or another app's run of the same name is ignored: still pending (then timeout), never pass.
    const forged = summarizeChecks([status('test', 'SUCCESS'), appRun('test', 'SUCCESS', 999)]).checks;
    expect(gate({ required: pinned(), observations: [obs(forged)] }).state).toBe('pending');
    expect(gate({ required: pinned(), observations: [obs(forged)], now: new Date(Date.parse(T0) + 31 * 60_000) }).state).toBe('timeout');
    // The pinned app's failure is not masked by an impostor's pass.
    expect(gate({ required: pinned(), observations: [obs(summarizeChecks([appRun('test', 'FAILURE', 15368), appRun('test', 'SUCCESS', 999)]).checks)] }).state).toBe('fail');
  });

  it('a pinned required check whose run has no known app (rollup without apps) is unknown, never pass', () => {
    const g = gate({ required: pinned(), observations: [obs(summarizeChecks([run('test', 'SUCCESS')]).checks)] });
    expect(g.state).toBe('unknown');
    expect(g.reasons.join(' ')).toMatch(/app 15368/);
  });

  it('neutral counts as pass (as GitHub does for required checks); skipped and stale do not', () => {
    expect(gate({ observations: [obs(summarizeChecks([run('test', 'NEUTRAL')]).checks)] }).state).toBe('pass');
    expect(gate({ observations: [obs(summarizeChecks([run('test', 'SKIPPED')]).checks)] }).state).toBe('unknown');
    expect(gate({ observations: [obs(summarizeChecks([run('test', 'STALE')]).checks)] }).state).toBe('fail');
    expect(gate({ observations: [obs(summarizeChecks([status('test', 'EXPECTED')]).checks)] }).state).toBe('pending');
    expect(gate({ observations: [obs(summarizeChecks([status('test', 'ERROR')]).checks)] }).state).toBe('fail');
  });

  // Fixed defect: a COMPLETED check run with a missing or unrecognised conclusion is pending, not pass.
  it('a completed check with no or an unknown conclusion is not a pass', () => {
    for (const c of [null, '', 'SOMETHING_NEW']) {
      const checks = summarizeChecks([{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: c }]).checks;
      expect(gate({ observations: [obs(checks)] }).state).not.toBe('pass');
    }
  });

  it('malformed observation details are not evidence', () => {
    for (const details_json of ['not json', 'null', '{"ci":{"checks":{"test":"pass"}}}', '{"ci":null}']) {
      expect(gate({ observations: [{ head_sha: HEAD, recorded_at: T0, details_json }] }).state).toBe('unknown');
    }
  });

  it('the latest observation of the head decides (a re-run that now fails is not masked by an earlier pass)', () => {
    const g = gate({ observations: [obs([{ name: 'test', state: 'fail' }], HEAD, '2026-10-20T10:00:30.000Z'), obs([{ name: 'test', state: 'pass' }])] });
    expect(g.state).toBe('fail');
  });
});

// ---------------------------------------------------------------- result contract by ciAuthority

const ciOnly = { checks: [{ command: 'test', outcome: 'pass', source: 'ci' }] };

describe('ciAuthority none: unchanged behaviour', () => {

  it('validateResult without options rejects CI entries (default = none)', () => {
    const v = validateResult({ status: 'complete', summary: 's', branch: 'b', headSha: HEAD, modifiedPaths: [], checks: ciOnly.checks, acceptanceEvidence: [], findings: [], nextAction: 'n' }, 'tester');
    expect(v.ok).toBe(false);
  });
});
