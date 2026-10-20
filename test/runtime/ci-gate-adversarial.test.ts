// Adversarial tests for the CI evidence gate (task-1.11, tester). Everything runs on a temp runtime DB and a
// mocked gh; nothing touches the live state.
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { requiredChecksStatus, summarizeChecks, syncTasks, type ApiGet, type RequiredChecksReport } from '../../src/runtime/ci.js';
import { evaluateCiGate, type CiGateInput } from '../../src/runtime/ci-gate.js';
import type { GhFn } from '../../src/runtime/publish.js';
import { validateResult } from '../../src/runtime/results.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

const HEAD = 'a'.repeat(40);
const T0 = '2026-10-20T10:00:00.000Z';
const R = '/repos/acme/demo';
const PR = 'https://github.com/acme/demo/pull/7';
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (status: number, msg = 'error'): RunResult => ({ code: 1, stdout: `{"message":"${msg}"}`, stderr: `gh: ${msg} (HTTP ${status})` });

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

// ---------------------------------------------------------------- scheduler + mocked gh

interface MockState { head: string; rollup: unknown[]; api: (path: string) => RunResult | null; prView: () => RunResult | null }
function mockGh(st: MockState) {
  const calls: string[][] = [];
  const fn: GhFn = async (args) => {
    calls.push(args);
    if (args[0] === 'api') {
      expect(args.slice(1, 3)).toEqual(['--method', 'GET']);
      const path = args.at(-1)!;
      const custom = st.api(path);
      if (custom) return custom;
      if (path === `${R}/branches/main`) return ok(JSON.stringify({ protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['test'] } } }));
      if (path === `${R}/rules/branches/main`) return ok('[]');
      if (path.startsWith(`${R}/actions/workflows`)) return ok('{"total_count":1}');
      return fail(404, 'Not Found');
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      return st.prView() ?? ok(JSON.stringify({ url: PR, state: 'OPEN', isDraft: false, headRefOid: st.head, baseRefName: 'main', mergedAt: null, mergeStateStatus: 'BLOCKED', statusCheckRollup: st.rollup }));
    }
    return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { fn, calls };
}

interface CiEnv extends Env { st: MockState; calls: string[][]; gh: GhFn; head: string }
async function ciEnv(ci: 'github' | 'none' = 'github'): Promise<CiEnv> {
  const env = makeDefaultEnv((c) => { c.verification.ciAuthority = ci; c.verification.ciPendingTimeoutMinutes = 30; });
  gitSync(env.layout.repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  const st: MockState = { head: '', rollup: [], api: () => null, prView: () => null };
  const gh = mockGh(st);
  const sched = new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, gh: gh.fn });
  env.backlog.add({ id: 'task-1' });
  const b = await sched.claim('task-1', 'engineer');
  const head = commitFile(b.worktree, 'a.txt', 'a');
  await sched.record(b.leaseId, result({ branch: b.branch, headSha: head }));
  st.head = head;
  env.backlog.tasks.get('task-1')!.prUrl = PR;
  return { ...env, sched, st, calls: gh.calls, gh: gh.fn, head };
}
const passing = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const sync = (env: CiEnv) => syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: env.gh });
const ciOnly = { checks: [{ command: 'test', outcome: 'pass', source: 'ci' }] };
async function review(env: CiEnv, over: Record<string, unknown> = ciOnly) {
  const brief = await env.sched.claim('task-1', 'reviewer');
  const rec = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', ...over }));
  return { brief, rec };
}

describe('scheduler: head binding and fail-closed paths (mocked gh)', () => {
  it('CI passing on a different PR head (force-push) never counts for the reviewed head', async () => {
    const env = await ciEnv();
    env.st.head = 'c'.repeat(40); // PR head moved away from the local branch head
    env.st.rollup = passing;
    await sync(env);
    expect(env.db.evidenceFor('task-1', 'c'.repeat(40), 'ci')).toHaveLength(1);
    const { brief, rec } = await review(env);
    expect(brief.ci?.state).toBe('missing');
    expect(rec).toMatchObject({ approved: false, to: 'reviewing' });
  });

  it('a pass observed before the branch moved does not carry over after a sync observes the new head failing', async () => {
    const env = await ciEnv();
    env.st.rollup = passing;
    await sync(env);
    env.backlog.tasks.get('task-1')!.status = 'changes-requested';
    const b = await env.sched.claim('task-1', 'engineer');
    const h2 = commitFile(b.worktree, 'b.txt', 'b');
    await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: h2 }));
    env.st.head = h2;
    env.st.rollup = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];
    await sync(env);
    const { brief, rec } = await review(env);
    expect(brief.ci).toMatchObject({ state: 'fail', head: h2 });
    expect(rec).toMatchObject({ approved: false, to: 'changes-requested' });
  });

  it('CI failing at record time overrides a pass at claim time (re-evaluated at record)', async () => {
    const env = await ciEnv();
    env.st.rollup = passing;
    await sync(env);
    const brief = await env.sched.claim('task-1', 'reviewer');
    expect(brief.ci?.state).toBe('pass');
    env.st.rollup = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];
    await sync(env);
    const rec = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', ...ciOnly }));
    expect(rec).toMatchObject({ approved: false, to: 'changes-requested' });
  });

  describe('a required check pinned to an app (protection checks[].app_id)', () => {
    const pinnedProtection = (p: string) => p === `${R}/branches/main`
      ? ok(JSON.stringify({ protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['test'], checks: [{ context: 'test', app_id: 15368 }] } } }))
      : null;
    const runs = (appId: number, conclusion = 'success') => ok(JSON.stringify({ total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion, app: { id: appId } }] }));

    it('sync reads check-run apps for the head; the pinned app passing is approval', async () => {
      const env = await ciEnv();
      env.st.rollup = passing;
      env.st.api = (p) => pinnedProtection(p) ?? (p === `${R}/commits/${env.head}/check-runs?per_page=100` ? runs(15368) : null);
      const s = await sync(env);
      expect(s.tasks[0]!.gate?.state).toBe('pass');
      expect(s.tasks[0]!.ci?.checks).toEqual([{ name: 'test', state: 'pass', source: 'check-run', appId: 15368 }]);
      const { rec } = await review(env);
      expect(rec).toMatchObject({ approved: true });
    });

    it('a same-named check from another app, or a forged status, is not approval', async () => {
      const env = await ciEnv();
      env.st.rollup = [{ __typename: 'StatusContext', context: 'test', state: 'SUCCESS' }, ...passing];
      env.st.api = (p) => pinnedProtection(p) ?? (p.includes('/check-runs') ? runs(999) : null);
      const s = await sync(env);
      expect(s.tasks[0]!.gate?.state).toBe('pending');
      const { rec } = await review(env);
      expect(rec).toMatchObject({ approved: false, to: 'reviewing' });
    });

    it('check runs unreadable: the pinned check cannot be attributed (unknown, warning), never approval', async () => {
      const env = await ciEnv();
      env.st.rollup = passing;
      env.st.api = (p) => pinnedProtection(p) ?? (p.includes('/check-runs') ? fail(403, 'Resource not accessible') : null);
      const s = await sync(env);
      expect(s.tasks[0]!.gate?.state).toBe('unknown');
      expect(s.tasks[0]!.warnings.join(' ')).toMatch(/pinned to an app cannot be verified/);
      const { rec } = await review(env);
      expect(rec).toMatchObject({ approved: false, to: 'reviewing' });
    });
  });

  it('required checks becoming unreadable at record time (rate limit) is not approval', async () => {
    const env = await ciEnv();
    env.st.rollup = passing;
    await sync(env);
    const brief = await env.sched.claim('task-1', 'reviewer');
    env.st.api = () => fail(403, 'API rate limit exceeded');
    const rec = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', ...ciOnly }));
    expect(rec).toMatchObject({ approved: false, to: 'reviewing' });
    expect(env.db.evidenceFor('task-1', env.head, 'reviewer').map((e) => e.outcome)).toEqual(['ci-unknown']);
  });

  it('a thrown gh (transport crash) and an empty required set are unknown, never pass', async () => {
    const env = await ciEnv();
    env.st.rollup = passing;
    await sync(env);
    env.st.api = () => { throw new Error('spawn gh ENOENT'); };
    expect((await env.sched.ciGate('task-1', env.head)).state).toBe('unknown');
    env.st.api = (p) => p === `${R}/branches/main` ? ok(JSON.stringify({ protected: false })) : null;
    expect((await env.sched.ciGate('task-1', env.head)).state).toBe('unknown');
  });

  it('a failed `gh pr view` records no observation: a tester citing CI that was never observed is not approved', async () => {
    const env = await ciEnv();
    env.st.prView = () => fail(502, 'Bad Gateway');
    const s = await sync(env);
    expect(s.tasks[0]!.error).toMatch(/gh pr view failed/);
    env.backlog.tasks.get('task-1')!.status = 'testing';
    const tb = await env.sched.claim('task-1', 'tester');
    expect(tb.ci?.state).toBe('missing');
    const rec = await env.sched.record(tb.leaseId, result({ branch: tb.branch, headSha: tb.expectedHead, ...ciOnly }));
    expect(rec).toMatchObject({ to: 'testing' });
    expect(env.db.evidenceFor('task-1', env.head, 'tester').map((e) => e.outcome)).toEqual(['ci-missing']);
  });

  it('a result with failing local checks plus passing CI is rejected as complete', async () => {
    const env = await ciEnv();
    env.st.rollup = passing;
    await sync(env);
    const { rec } = await review(env, { checks: [...ciOnly.checks, { command: 'npm test', outcome: 'fail' }] });
    expect(rec).toMatchObject({ valid: false });
    expect(rec.errors!.join(' ')).toMatch(/cannot report failing checks/);
  });

  it('a CI entry that claims fail while needs_changes goes the normal repair path without approval', async () => {
    const env = await ciEnv();
    env.st.rollup = passing;
    await sync(env);
    const { rec } = await review(env, { status: 'needs_changes', verdict: 'request-changes', checks: [{ command: 'test', outcome: 'fail', source: 'ci' }] });
    expect(rec).toMatchObject({ valid: true, approved: false, to: 'changes-requested' });
  });

  it('mixing a valid CI entry with an invented one is rejected even when the gate passes', async () => {
    const env = await ciEnv();
    env.st.rollup = passing;
    await sync(env);
    const { rec } = await review(env, { checks: [...ciOnly.checks, { command: 'e2e', outcome: 'pass', source: 'ci' }] });
    expect(rec).toMatchObject({ valid: false });
    expect(rec.errors!.join(' ')).toMatch(/not: e2e/);
  });
});

describe('ciAuthority none: unchanged behaviour', () => {
  it('makes no gh calls on claim/record/sync gate, carries no brief.ci and records no ci-gate evidence', async () => {
    const env = await ciEnv('none');
    env.st.rollup = passing;
    const s = await sync(env);
    expect(s.tasks[0]!.gate).toBeUndefined();
    expect(env.calls.filter((c) => c[0] === 'api')).toEqual([]);
    const { brief, rec } = await review(env, { checks: [{ command: 'npm test', outcome: 'pass' }] });
    expect(brief.ci).toBeUndefined();
    expect(rec).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    expect(env.db.evidenceFor('task-1', env.head, 'ci-gate')).toEqual([]);
    expect(env.db.evidenceFor('task-1', env.head, 'reviewer').map((e) => e.outcome)).toEqual(['complete']);
    expect(env.calls.filter((c) => c[0] === 'api')).toEqual([]);
  });

  it('validateResult without options rejects CI entries (default = none)', () => {
    const v = validateResult({ status: 'complete', summary: 's', branch: 'b', headSha: HEAD, modifiedPaths: [], checks: ciOnly.checks, acceptanceEvidence: [], findings: [], nextAction: 'n' }, 'tester');
    expect(v.ok).toBe(false);
  });
});

describe('app pinning through sync (attempt-2 probes, mocked gh)', () => {
  const RUNS = (head: string) => `${R}/commits/${head}/check-runs?per_page=100`;
  const protect = (checks: { context: string; app_id: unknown }[]) =>
    ok(JSON.stringify({ protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: checks.map((c) => c.context), checks } } }));
  const cr = (name: string, conclusion: string | null, app: unknown, status = 'completed') => ({ name, status, conclusion, app: { id: app } });
  const filler = (n: number) => Array.from({ length: n }, (_, k) => cr(`other-${k}`, 'success', 15368));
  async function pinnedEnv(opts: { protection?: { context: string; app_id: unknown }[]; ruleset?: { context: string; integration_id: unknown }[]; runs: unknown; rollup?: unknown[] }) {
    const env = await ciEnv();
    env.st.rollup = opts.rollup ?? passing;
    env.st.api = (p) => {
      if (p === `${R}/branches/main`) return protect(opts.protection ?? [{ context: 'test', app_id: 15368 }]);
      if (p === `${R}/rules/branches/main`) return ok(JSON.stringify(opts.ruleset ? [{ type: 'required_status_checks', parameters: { required_status_checks: opts.ruleset } }] : []));
      if (p === RUNS(env.head)) return ok(JSON.stringify(opts.runs));
      if (p.includes('/check-runs')) return fail(404, 'Not Found'); // any page-2 request: not served
      return null;
    };
    return env;
  }

  it('pinned run only on page 2 of check-runs (>100 runs): not approval', async () => {
    const env = await pinnedEnv({ runs: { total_count: 101, check_runs: filler(100) } });
    const s = await sync(env);
    expect(s.tasks[0]!.gate?.state).not.toBe('pass');
    expect((await review(env)).rec).toMatchObject({ approved: false });
  });

  it('failing pinned run on page 2 of check-runs is found by pagination: fail', async () => {
    const env = await pinnedEnv({
      runs: { total_count: 101, check_runs: [cr('test', 'success', 15368), ...filler(99)] },
      rollup: passing,
    });
    const orig = env.st.api;
    env.st.api = (p) => p === `${RUNS(env.head)}&page=2` ? ok(JSON.stringify({ total_count: 101, check_runs: [cr('test', 'failure', 15368)] })) : orig(p);
    const s = await sync(env);
    expect(s.tasks[0]!.gate?.state).toBe('fail');
  });

  it('pagination cap hit (total_count never reached): unreadable, gate unknown, never approval', async () => {
    const env = await pinnedEnv({ runs: { total_count: 5000, check_runs: [cr('test', 'success', 15368), ...filler(99)] } });
    const orig = env.st.api;
    env.st.api = (p) => p.includes('&page=') ? ok(JSON.stringify({ total_count: 5000, check_runs: filler(100) })) : orig(p);
    const s = await sync(env);
    expect(env.calls.filter((c) => c.at(-1)!.includes('/check-runs')).length).toBe(10);
    expect(s.tasks[0]!.gate?.state).toBe('unknown');
    expect(s.tasks[0]!.warnings.join(' ')).toContain('unreadable');
    expect((await review(env)).rec).toMatchObject({ approved: false });
  });

  it('a failing rollup run is kept when the app-aware runs are merged in: fail', async () => {
    const env = await pinnedEnv({
      runs: { total_count: 1, check_runs: [cr('test', 'success', 15368)] },
      rollup: [...passing, { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    expect((await sync(env)).tasks[0]!.gate?.state).toBe('fail');
  });

  it('same app, two runs of the same name, one failing: fail', async () => {
    const env = await pinnedEnv({ runs: { total_count: 2, check_runs: [cr('test', 'success', 15368), cr('test', 'failure', 15368)] } });
    const s = await sync(env);
    expect(s.tasks[0]!.gate?.state).toBe('fail');
    expect((await review(env)).rec).toMatchObject({ approved: false, to: 'changes-requested' });
  });

  it('a check-run app id given as a string is not attributed to the pinned app (unknown, never pass)', async () => {
    const env = await pinnedEnv({ runs: { total_count: 1, check_runs: [cr('test', 'success', '15368')] } });
    const s = await sync(env);
    expect(s.tasks[0]!.ci?.checks).toEqual([{ name: 'test', state: 'pass', source: 'check-run' }]);
    expect(s.tasks[0]!.gate?.state).toBe('unknown');
  });

  it('a passing rollup run is dropped as a duplicate, yet the app-aware list alone satisfies the pinned check: pass', async () => {
    const env = await pinnedEnv({ runs: { total_count: 1, check_runs: [cr('test', 'success', 15368)] }, rollup: passing });
    expect((await sync(env)).tasks[0]!.gate?.state).toBe('pass');
  });

  it('a protection app_id given as a string degrades to an unpinned (name-only) requirement', async () => {
    const env = await pinnedEnv({ protection: [{ context: 'test', app_id: '15368' }], runs: { total_count: 0, check_runs: [] } });
    const s = await sync(env);
    // No pin -> no check-runs read; the rollup's passing `test` satisfies it by name (documented residual).
    expect(env.calls.some((c) => c.at(-1)!.includes('/check-runs'))).toBe(false);
    expect(s.tasks[0]!.gate?.state).toBe('pass');
  });

  it('ruleset integration_id and protection app_id disagreeing: both apps must pass', async () => {
    const both = { protection: [{ context: 'test', app_id: 15368 }], ruleset: [{ context: 'test', integration_id: 999 }] };
    const one = await pinnedEnv({ ...both, runs: { total_count: 1, check_runs: [cr('test', 'success', 15368)] } });
    expect((await sync(one)).tasks[0]!.gate?.state).toBe('pending');
    const failing = await pinnedEnv({ ...both, runs: { total_count: 2, check_runs: [cr('test', 'success', 15368), cr('test', 'failure', 999)] } });
    expect((await sync(failing)).tasks[0]!.gate?.state).toBe('fail');
    const ok2 = await pinnedEnv({ ...both, runs: { total_count: 2, check_runs: [cr('test', 'success', 15368), cr('test', 'success', 999)] } });
    expect((await sync(ok2)).tasks[0]!.gate?.state).toBe('pass');
  });

  it('pinned + unpinned requirement for the same context: the pin is required and the name-only one sees every source', async () => {
    const env = await pinnedEnv({ protection: [{ context: 'test', app_id: null }], ruleset: [{ context: 'test', integration_id: 15368 }],
      runs: { total_count: 1, check_runs: [cr('test', 'success', 15368)] },
      rollup: [{ __typename: 'StatusContext', context: 'test', state: 'FAILURE' }] });
    expect((await sync(env)).tasks[0]!.gate?.state).toBe('fail');
  });

  // Judgement: GitHub ignores statuses (and other apps) for a check pinned to an app, so a failing
  // same-name commit status does not block the merge there either; the gate mirrors that.
  it('a pinned check passing plus a same-name failing commit status: pass (mirrors GitHub pin semantics)', async () => {
    const env = await pinnedEnv({ runs: { total_count: 1, check_runs: [cr('test', 'success', 15368)] },
      rollup: [{ __typename: 'StatusContext', context: 'test', state: 'FAILURE' }, ...passing] });
    const s = await sync(env);
    expect(s.tasks[0]!.ci?.checks).toEqual(expect.arrayContaining([{ name: 'test', state: 'fail', source: 'status' }]));
    expect(s.tasks[0]!.gate?.state).toBe('pass');
  });
});
