import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { ciAuthorityReadiness } from '../../src/host/doctor.js';
import type { RequiredChecksReport } from '../../src/runtime/ci.js';
import { formatSync, summarizeChecks, syncTasks } from '../../src/runtime/ci.js';
import { evaluateCiGate, type CiGateInput } from '../../src/runtime/ci-gate.js';
import type { GhFn } from '../../src/runtime/publish.js';
import { validateResult } from '../../src/runtime/results.js';
import { localVerificationComplete, Scheduler } from '../../src/runtime/scheduler.js';
import { defaults } from '../helpers.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

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

// ---------------------------------------------------------------- scheduler + mocked gh

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const R = '/repos/acme/demo';
const PR = 'https://github.com/acme/demo/pull/7';

/** Mocked gh: read-only `gh api` GETs for required checks, `gh pr view` for the PR. Every call is recorded. */
function mockGh(o: { required?: string[] | 'forbidden'; pr?: () => unknown }) {
  const calls: string[][] = [];
  const fn: GhFn = async (args) => {
    calls.push(args);
    if (args[0] === 'api') {
      expect(args.slice(1, 3)).toEqual(['--method', 'GET']);
      const path = args.at(-1)!;
      if (o.required === 'forbidden') return { code: 1, stdout: '{"message":"Forbidden"}', stderr: 'gh: Forbidden (HTTP 403)' };
      if (path === `${R}/branches/main`) return ok(JSON.stringify({ name: 'main', protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: o.required ?? [] } } }));
      if (path === `${R}/rules/branches/main`) return ok('[]');
      if (path.startsWith(`${R}/actions/workflows`)) return ok(JSON.stringify({ total_count: 1 }));
      return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    }
    if (args[0] === 'pr' && args[1] === 'view' && o.pr) return ok(JSON.stringify(o.pr()));
    return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { fn, calls };
}

interface CiEnv extends Env { gh: ReturnType<typeof mockGh>; clock: { now: Date }; head: string; setRollup(r: unknown[]): void }

/** Default env with ciAuthority github, a github.com origin, and task-1 implemented and in `reviewing` with an open PR. */
async function ciEnv(o: { required?: string[] | 'forbidden'; mutate?: Parameters<typeof makeDefaultEnv>[0] } = {}): Promise<CiEnv> {
  const env = makeDefaultEnv((c) => { c.verification.ciAuthority = 'github'; c.verification.ciPendingTimeoutMinutes = 30; o.mutate?.(c); });
  gitSync(env.layout.repo, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
  let rollup: unknown[] = [];
  const state = { head: '' };
  const gh = mockGh({ required: o.required ?? ['test'], pr: () => ({ url: PR, state: 'OPEN', isDraft: false, headRefOid: state.head, baseRefName: 'main', mergedAt: null, closedAt: null, mergeStateStatus: 'BLOCKED', statusCheckRollup: rollup }) });
  const clock = { now: new Date() }; // sync records observations at wall-clock time
  const sched = new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, gh: gh.fn, now: () => clock.now });
  env.backlog.add({ id: 'task-1' });
  const b = await sched.claim('task-1', 'engineer');
  const head = commitFile(b.worktree, 'a.txt', 'a');
  expect(await sched.record(b.leaseId, result({ branch: b.branch, headSha: head }))).toMatchObject({ to: 'reviewing' });
  state.head = head;
  const t = env.backlog.tasks.get('task-1')!;
  t.prUrl = PR; // the PR at this head (e.g. a re-review of a published branch)
  return { ...env, sched, gh, clock, head, setRollup: (r) => { rollup = r; } };
}
const run = (name: string, conclusion: string | null) => ({ __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion });
const sync = (env: CiEnv) => syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: env.gh.fn });
const ciOnly = { checks: [{ command: 'test', outcome: 'pass', source: 'ci' }] };

async function review(env: CiEnv, over: Record<string, unknown> = ciOnly) {
  const brief = await env.sched.claim('task-1', 'reviewer');
  const rec = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', ...over }));
  return { brief, rec };
}
const reviewerOutcomes = (env: CiEnv) => env.db.evidenceFor('task-1', env.head, 'reviewer').map((e) => e.outcome);

describe('CI authority in the reviewer stage (mocked gh)', () => {
  it('passing required checks bound to the reviewed head satisfy the stage', async () => {
    const env = await ciEnv();
    env.setRollup([run('test', 'SUCCESS'), run('docs', 'FAILURE')]); // docs is not required
    const s = await sync(env);
    expect(s.tasks[0]!.gate).toMatchObject({ state: 'pass', head: env.head });
    expect(formatSync(s)).toMatch(/CI gate pass at .*required test/);
    const { brief, rec } = await review(env);
    expect(brief.ci).toMatchObject({ state: 'pass', requiredChecks: ['test'] });
    expect(rec).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    expect(reviewerOutcomes(env)).toEqual(['complete']);
    expect(env.db.evidenceFor('task-1', env.head, 'ci-gate')[0]).toMatchObject({ outcome: 'pass' });
    expect(env.db.evidenceFor('task-1', env.head, 'check').map((e) => JSON.parse(e.details_json!).source)).toEqual(['local', 'ci']); // engineer's, reviewer's
    // Only read-only calls were made.
    expect(env.gh.calls.every((c) => (c[0] === 'api' && c[2] === 'GET') || (c[0] === 'pr' && c[1] === 'view'))).toBe(true);
  });

  it('failing required CI never approves: task → changes-requested', async () => {
    const env = await ciEnv();
    env.setRollup([run('test', 'FAILURE')]);
    await sync(env);
    const { brief, rec } = await review(env, { checks: [...ciOnly.checks, { command: 'npm test', outcome: 'pass' }] });
    expect(brief.ci?.state).toBe('fail');
    expect(rec).toMatchObject({ valid: true, approved: false, to: 'changes-requested' });
    expect(rec.message).toMatch(/required checks failing.*test/);
    expect(reviewerOutcomes(env)).toEqual(['ci-fail']);
  });

  it('missing CI never approves; the task stays in review for a local-verification re-run', async () => {
    const env = await ciEnv();
    const { rec } = await review(env);
    expect(rec).toMatchObject({ valid: true, approved: false, to: 'reviewing' });
    expect(rec.message).toMatch(/CI gate missing.*local verification/);
    expect(reviewerOutcomes(env)).toEqual(['ci-missing']);
    expect(env.backlog.notes.at(-1)!.text).toMatch(/not approved: CI gate missing/);
  });

  it('pending CI never approves; past the timeout it falls back to the full local verification', async () => {
    const env = await ciEnv({ mutate: (c) => { c.verification.commands = ['npm run typecheck', 'npm test']; } });
    env.setRollup([run('test', null)]);
    await sync(env);
    const first = await review(env);
    expect(first.rec).toMatchObject({ approved: false, to: 'reviewing' });
    expect(first.rec.message).toMatch(/CI gate pending.*minions sync/);

    env.clock.now = new Date(Date.now() + 31 * 60_000);
    const second = await review(env);
    expect(second.brief.ci?.state).toBe('timeout');
    expect(second.rec).toMatchObject({ approved: false, to: 'reviewing' });
    expect(second.rec.message).toMatch(/CI gate timeout/);

    // Local verification (the fallback) is accepted; CI is not what approved it.
    // A subset of the configured commands (or a CI-sourced entry) is not the full verification.
    const subset = await review(env, { checks: [...ciOnly.checks, { command: 'npm test', outcome: 'pass', source: 'local' }] });
    expect(subset.rec).toMatchObject({ approved: false, to: 'reviewing' });
    // Env-prefixed / chained forms of the configured commands match; the full set approves.
    const third = await review(env, { checks: [...ciOnly.checks, { command: 'npm run typecheck', outcome: 'pass', source: 'local' }, { command: 'mkdir -p /x && TMPDIR=/x npm test', outcome: 'pass', source: 'local' }] });
    expect(third.rec).toMatchObject({ approved: true, to: 'delivered' });
    expect(JSON.parse(env.db.evidenceFor('task-1', env.head, 'ci-gate').at(-1)!.details_json!)).toMatchObject({ usedAs: 'local-fallback' });
    expect(reviewerOutcomes(env)).toEqual(['ci-pending', 'ci-timeout', 'ci-timeout', 'complete']);
  });

  it('a configured command reporting fail never approves (rejected as invalid, not approved)', async () => {
    const env = await ciEnv({ mutate: (c) => { c.verification.commands = ['npm test']; } });
    const { rec } = await review(env, { checks: [...ciOnly.checks, { command: 'npm test', outcome: 'fail', source: 'local' }] });
    expect(rec).toMatchObject({ valid: false, correctionAllowed: true });
    expect(rec.approved).toBeFalsy();
    expect(rec.errors!.join(' ')).toMatch(/cannot report failing checks/);
    expect(env.backlog.tasks.get('task-1')!.status).toBe('reviewing');
    expect(reviewerOutcomes(env)).not.toContain('complete');
  });

  it('unreadable required checks are not evidence (never treated as zero required checks)', async () => {
    const env = await ciEnv({ required: 'forbidden' });
    env.setRollup([run('test', 'SUCCESS')]);
    await sync(env);
    const { brief, rec } = await review(env);
    expect(brief.ci?.state).toBe('unknown');
    expect(rec).toMatchObject({ approved: false, to: 'reviewing' });
  });

  it('a CI entry naming a check that is not a passing required check is rejected (correctable)', async () => {
    const env = await ciEnv();
    env.setRollup([run('test', 'SUCCESS'), run('docs', 'SUCCESS')]);
    await sync(env);
    const { rec } = await review(env, { checks: [{ command: 'docs', outcome: 'pass', source: 'ci' }] });
    expect(rec).toMatchObject({ valid: false, correctionAllowed: true });
    expect(rec.errors!.join(' ')).toMatch(/must name required checks that passed/);
  });

  it('a new head needs its own observation: CI of an earlier head never carries over', async () => {
    const env = await ciEnv();
    env.setRollup([run('test', 'SUCCESS')]);
    await sync(env); // observed at the engineer's head
    env.backlog.tasks.get('task-1')!.status = 'changes-requested';
    const b = await env.sched.claim('task-1', 'engineer');
    const h2 = commitFile(b.worktree, 'b.txt', 'b');
    await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: h2 }));
    const { brief, rec } = await review(env);
    expect(brief.expectedHead).toBe(h2);
    expect(brief.ci?.state).toBe('missing');
    expect(rec).toMatchObject({ approved: false, to: 'reviewing' });
  });

  it('testers can rely on CI too; without ciAuthority the brief carries no CI gate', async () => {
    const env = await ciEnv({ mutate: (c) => { c.verification.qaLabels = ['qa']; } });
    env.setRollup([run('test', 'SUCCESS')]);
    await sync(env);
    env.backlog.tasks.get('task-1')!.status = 'testing';
    const tb = await env.sched.claim('task-1', 'tester');
    expect(tb.ci?.state).toBe('pass');
    expect(await env.sched.record(tb.leaseId, result({ branch: tb.branch, headSha: tb.expectedHead, ...ciOnly }))).toMatchObject({ valid: true, to: 'reviewing' });

    const plain = makeDefaultEnv();
    plain.backlog.add({ id: 'task-1' });
    const b = await plain.sched.claim('task-1', 'engineer');
    await plain.sched.record(b.leaseId, result({ branch: b.branch, headSha: commitFile(b.worktree, 'a.txt', 'a') }));
    const rb = await plain.sched.claim('task-1', 'reviewer');
    expect(rb.ci).toBeUndefined();
    const rec = await plain.sched.record(rb.leaseId, result({ branch: rb.branch, headSha: rb.expectedHead, verdict: 'approve', ...ciOnly }));
    expect(rec).toMatchObject({ valid: false });
    expect(rec.errors!.join(' ')).toMatch(/ciAuthority "github"/);
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
