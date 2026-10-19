import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { requiredChecksReadiness } from '../../src/host/doctor.js';
import { ciSetupPlan, ciStatus, fetchApi, ghApi, requiredChecksStatus, summarizeChecks, syncTasks, formatSync, type ApiGet } from '../../src/runtime/ci.js';
import type { GitFn } from '../../src/runtime/github.js';
import type { GhFn } from '../../src/runtime/publish.js';
import { defaults } from '../helpers.js';
import { makeEnv } from './fixtures.js';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const httpErr = (status: number, msg = 'Not Found'): RunResult => ({ code: 1, stdout: JSON.stringify({ message: msg }), stderr: `gh: ${msg} (HTTP ${status})` });

/** Fake `gh` serving `gh api` GETs from a route table and `gh pr view` from a PR table; records every call. */
function fakeGh(routes: Record<string, RunResult>, prs: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const fn: GhFn = async (args) => {
    calls.push(args);
    if (args[0] === 'api') return routes[args[args.length - 1]!] ?? httpErr(404);
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = prs[args[2]!];
      return pr ? ok(JSON.stringify(pr)) : { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest' };
    }
    return { code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}` };
  };
  return { fn, calls };
}

/** No call may mutate GitHub: only `gh api --method GET ...` and `gh pr view`. */
function expectReadOnly(calls: string[][]) {
  for (const c of calls) {
    if (c[0] === 'api') {
      expect(c.slice(1, 3)).toEqual(['--method', 'GET']);
      expect(c.some((a) => /^(-f|-F|--field|--raw-field|--input|-X)$/.test(a))).toBe(false);
    } else {
      expect(c.slice(0, 2)).toEqual(['pr', 'view']);
    }
  }
}

const R = '/repos/acme/demo';
const branch = (protection: unknown, prot = true) => ok(JSON.stringify({ name: 'main', protected: prot, protection }));
const rules = (contexts: string[]) => ok(JSON.stringify(contexts.length ? [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } }] : []));
const workflows = (n: number) => ok(JSON.stringify({ total_count: n, workflows: [] }));

describe('required checks (read-only gh api)', () => {
  it('collects required checks from branch protection and rulesets', async () => {
    const gh = fakeGh({
      [`${R}/branches/main`]: branch({ enabled: true, required_status_checks: { enforcement_level: 'non_admins', contexts: ['build'], checks: [{ context: 'build' }, { context: 'lint' }] } }),
      [`${R}/rules/branches/main`]: rules(['test']),
      [`${R}/actions/workflows?per_page=1`]: workflows(2),
    });
    const rc = await requiredChecksStatus(ghApi(gh.fn), 'acme/demo', 'main');
    expect(rc).toMatchObject({ state: 'configured', requiredChecks: ['build', 'lint', 'test'], workflows: 2, errors: [] });
    expect(gh.calls).toHaveLength(3);
    expectReadOnly(gh.calls);
  });

  it('reports none when the branch is unprotected and no rulesets apply; enforcement off counts as none', async () => {
    const none = fakeGh({ [`${R}/branches/main`]: branch(undefined, false), [`${R}/rules/branches/main`]: rules([]), [`${R}/actions/workflows?per_page=1`]: workflows(0) });
    expect(await requiredChecksStatus(ghApi(none.fn), 'acme/demo', 'main')).toMatchObject({ state: 'none', requiredChecks: [], workflows: 0 });
    const off = fakeGh({ [`${R}/branches/main`]: branch({ required_status_checks: { enforcement_level: 'off', contexts: ['build'] } }) });
    // rules 404 (no rulesets endpoint for this repo) still allows "none"; workflows unreadable -> null.
    expect(await requiredChecksStatus(ghApi(off.fn), 'acme/demo', 'main')).toMatchObject({ state: 'none', workflows: null });
  });

  it('is unknown (never "none") when protection cannot be read', async () => {
    const gh = fakeGh({ [`${R}/branches/main`]: httpErr(403, 'Resource not accessible by personal access token'), [`${R}/rules/branches/main`]: rules([]) });
    const rc = await requiredChecksStatus(ghApi(gh.fn), 'acme/demo', 'main');
    expect(rc.state).toBe('unknown');
    expect(rc.errors.join()).toMatch(/HTTP 403/);
    const missing = await requiredChecksStatus(ghApi(fakeGh({}).fn), 'acme/demo', 'main');
    expect(missing.state).toBe('unknown');
    expect(missing.errors.join()).toMatch(/not found/);
  });

  it('encodes branch names with slashes per segment', async () => {
    const gh = fakeGh({});
    await requiredChecksStatus(ghApi(gh.fn), 'acme/demo', 'release/1.0');
    expect(gh.calls.map((c) => c.at(-1))).toContain(`${R}/branches/release/1.0`);
  });

  it('fetchApi (host fallback) only issues GET with the token in a header', async () => {
    const seen: { url: string; method?: string; auth: string | null }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify(String(url).includes('/rules/') ? [] : { protected: false }), { status: 200 });
    }) as typeof fetch;
    const rc = await requiredChecksStatus(fetchApi('ghp_x', f), 'acme/demo', 'main');
    expect(rc.state).toBe('none');
    expect(seen.every((s) => s.method === 'GET' && s.auth === 'Bearer ghp_x' && s.url.startsWith('https://api.github.com/repos/acme/demo/'))).toBe(true);
    const down = fetchApi('t', (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch);
    expect(await down('/x')).toMatchObject({ status: 0, error: expect.stringMatching(/ENOTFOUND/) });
  });

  it('ciStatus reads origin and reports the setup plan; non-GitHub origins are not applicable', async () => {
    const config = defaults();
    const gitFor = (url: string | null): GitFn => async () => (url ? ok(url + '\n') : { code: 1, stdout: '', stderr: '' });
    const gh = fakeGh({ [`${R}/branches/main`]: branch(undefined, false), [`${R}/rules/branches/main`]: rules([]), [`${R}/actions/workflows?per_page=1`]: workflows(0) });
    const s = await ciStatus('/repo', config, { git: gitFor('git@github.com:acme/demo.git'), gh: gh.fn });
    expect(s).toMatchObject({ repository: 'acme/demo', requiredChecksConfigured: false, requiredChecks: { state: 'none' } });
    expect(s.setupPlan.join('\n')).toMatch(/Add a CI workflow yourself/);
    expectReadOnly(gh.calls);
    const local = await ciStatus('/repo', config, { git: gitFor(null), gh: fakeGh({}).fn });
    expect(local).toMatchObject({ repository: null, requiredChecks: null, setupPlan: [] });
  });
});

describe('CI setup plan (printed, never applied)', () => {
  it('suggests a workflow with the verification commands and how to require the check', () => {
    const plan = ciSetupPlan({ hasWorkflows: false, requiredChecks: 'none', verificationCommands: ['npm run typecheck', 'npm test'], baseBranch: 'trunk', repository: 'acme/demo' }).join('\n');
    expect(plan).toMatch(/never creates workflows or changes branch protection/);
    expect(plan).toContain('npm run typecheck; npm test');
    expect(plan).toContain('https://github.com/acme/demo/settings/branches');
    expect(plan).toMatch(/Require status checks to pass/);
    expect(plan).toMatch(/requiredChecksConfigured to true/);
    expect(plan).toMatch(/usable for local work and pull-request delivery/);
  });
  it('skips the workflow step when workflows exist, and is empty when checks are required', () => {
    const plan = ciSetupPlan({ hasWorkflows: true, requiredChecks: 'none', verificationCommands: [], baseBranch: 'main' });
    expect(plan.join('\n')).not.toMatch(/Add a CI workflow/);
    expect(plan.join('\n')).toMatch(/Mark the check required for main/);
    expect(ciSetupPlan({ hasWorkflows: true, requiredChecks: 'configured', verificationCommands: [], baseBranch: 'main' })).toEqual([]);
  });
});

describe('doctor ci.requiredChecks readiness', () => {
  const rc = (state: 'configured' | 'none' | 'unknown', checks: string[] = [], wf: number | null = 1) =>
    ({ repository: 'acme/demo', baseBranch: 'main', state, requiredChecks: checks, protection: null, rulesets: null, workflows: wf, errors: state === 'unknown' ? ['HTTP 403'] : [] });
  const cfg = (flag: boolean) => { const c = defaults(); c.delivery.requiredChecksConfigured = flag; return c; };

  it('maps observations to delivery.requiredChecksConfigured and never fails', () => {
    expect(requiredChecksReadiness(cfg(true), rc('configured', ['build']), { onGitHub: true })).toMatchObject({ status: 'ok', detail: expect.stringContaining('build') });
    expect(requiredChecksReadiness(cfg(false), rc('configured', ['build']), { onGitHub: true })).toMatchObject({ status: 'ok', hint: expect.stringMatching(/to true/) });
    const none = requiredChecksReadiness(cfg(false), rc('none', [], 0), { onGitHub: true });
    expect(none).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/no CI workflows.*usable for local work and pull-request delivery; automatic merge unavailable/) });
    expect(none.hint).toMatch(/Add a CI workflow yourself/);
    expect(requiredChecksReadiness(cfg(true), rc('none'), { onGitHub: true })).toMatchObject({ status: 'warn', detail: expect.stringMatching(/never treated as zero/) });
    expect(requiredChecksReadiness(cfg(false), rc('unknown'), { onGitHub: true })).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^unknown: .*HTTP 403/) });
    expect(requiredChecksReadiness(cfg(false), null, { onGitHub: true, unknownReason: 'GitHub credential missing' }).detail).toMatch(/credential missing/);
    expect(requiredChecksReadiness(cfg(false), null, { onGitHub: false }).status).toBe('unavailable');
  });
});

describe('check rollup', () => {
  it('classifies check runs and commit statuses', () => {
    expect(summarizeChecks([])).toMatchObject({ state: 'no-checks', total: 0 });
    expect(summarizeChecks(undefined).state).toBe('no-checks');
    const pass = [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' }, { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' }];
    expect(summarizeChecks(pass)).toMatchObject({ state: 'passing', total: 3, passed: 3 });
    expect(summarizeChecks([...pass, { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null }])).toMatchObject({ state: 'awaiting-ci', pending: ['test'] });
    expect(summarizeChecks([...pass, { __typename: 'StatusContext', context: 'ext', state: 'PENDING' }]).state).toBe('awaiting-ci');
    expect(summarizeChecks([...pass, { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }, { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }]))
      .toMatchObject({ state: 'failing', failed: ['lint'], pending: ['test'] });
    expect(summarizeChecks([{ __typename: 'StatusContext', context: 'ext', state: 'ERROR' }]).failed).toEqual(['ext']);
  });
});

describe('minions sync', () => {
  const HEAD = 'a'.repeat(40);
  const url = (n: number) => `https://github.com/acme/demo/pull/${n}`;
  const pr = (n: number, state: string, rollup: unknown[], extra: Record<string, unknown> = {}) =>
    ({ url: url(n), state, isDraft: false, headRefOid: HEAD, baseRefName: 'main', mergedAt: state === 'MERGED' ? '2026-10-19T00:00:00Z' : null, closedAt: null, mergeStateStatus: 'BLOCKED', statusCheckRollup: rollup, ...extra });
  const run = (name: string, conclusion: string | null) => ({ __typename: 'CheckRun', name, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', conclusion });

  it('records PR state and CI results as head-bound evidence, notes only on change, never writes to GitHub', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'delivered', prUrl: url(1) });
    env.backlog.add({ id: 'task-2', status: 'delivered', prUrl: url(2) });
    env.backlog.add({ id: 'task-3', status: 'ready' }); // no PR: not synced
    env.backlog.add({ id: 'task-4', status: 'done', prUrl: url(4) }); // already reconciled: skipped
    const prs: Record<string, unknown> = { [url(1)]: pr(1, 'OPEN', [run('build', null)]), [url(2)]: pr(2, 'OPEN', [run('build', 'FAILURE')]) };
    const gh = fakeGh({}, prs);
    const r1 = await syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: gh.fn });
    expect(r1).toMatchObject({ synced: 2, failed: 0 });
    expect(r1.tasks.map((t) => [t.taskId, t.prState, t.ci?.state, t.changed])).toEqual([['task-1', 'OPEN', 'awaiting-ci', true], ['task-2', 'OPEN', 'failing', true]]);
    expect(env.db.evidenceFor('task-2', HEAD, 'ci')[0]).toMatchObject({ outcome: 'open:failing', config_revision: env.config.configRevision });
    expect(env.backlog.notes.map((n) => n.id)).toEqual(['task-1', 'task-2']);
    expect(env.backlog.notes[1]!.text).toMatch(/CI failing \(failed: build\).*never merges/);
    expect(env.backlog.status('task-1')).toBe('delivered');
    expectReadOnly(gh.calls);
    expect(gh.calls.every((c) => c[0] === 'pr' && c[1] === 'view')).toBe(true);

    // Second sync with the same observations: no new notes; then CI passes on task-1.
    await syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: gh.fn });
    expect(env.backlog.notes).toHaveLength(2);
    prs[url(1)] = pr(1, 'OPEN', [run('build', 'SUCCESS')]);
    const r3 = await syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: gh.fn });
    expect(r3.tasks.find((t) => t.taskId === 'task-1')).toMatchObject({ changed: true, ci: { state: 'passing' } });
    expect(env.backlog.notes).toHaveLength(3);
    expect(formatSync(r3)).toMatch(/task-1: PR open at a{12}; CI passing \(1\/1 passed\)/);
  });

  it('reconciles merged PRs to done and closed PRs to blocked; leased tasks are left alone', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'delivered', prUrl: url(1) });
    env.backlog.add({ id: 'task-2', status: 'delivered', prUrl: url(2) });
    env.backlog.add({ id: 'task-3', status: 'delivered', prUrl: url(3) });
    env.db.sql.prepare(`INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('l1', 'task-3', 'engineer', 1, 1, 'now', 'active')`).run();
    const gh = fakeGh({}, { [url(1)]: pr(1, 'MERGED', [run('build', 'SUCCESS')]), [url(2)]: pr(2, 'CLOSED', []), [url(3)]: pr(3, 'MERGED', []) });
    const r = await syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: gh.fn });
    expect(r.tasks.find((t) => t.taskId === 'task-1')).toMatchObject({ prState: 'MERGED', statusChange: { from: 'delivered', to: 'done' } });
    expect(r.tasks.find((t) => t.taskId === 'task-2')).toMatchObject({ prState: 'CLOSED', ci: { state: 'no-checks' }, statusChange: { from: 'delivered', to: 'blocked' } });
    expect(r.tasks.find((t) => t.taskId === 'task-3')!.warnings.join()).toMatch(/active lease/);
    expect([env.backlog.status('task-1'), env.backlog.status('task-2'), env.backlog.status('task-3')]).toEqual(['done', 'blocked', 'delivered']);
    expect(env.backlog.notes.some((n) => n.id === 'task-2' && /closed without merging/.test(n.text))).toBe(true);
    // Merged task is not synced again; blocked (closed) one still is, without changing status again.
    const again = await syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: gh.fn });
    expect(again.tasks.map((t) => t.taskId)).toEqual(['task-2', 'task-3']);
    expect(again.tasks[0]!.statusChange).toBeUndefined();
  });

  it('reports per-task gh failures and head mismatches without throwing; can sync selected tasks', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'delivered', prUrl: url(1) });
    env.backlog.add({ id: 'task-2', status: 'delivered', prUrl: url(2) });
    env.db.upsertPublication({ task_id: 'task-2', branch: 'agent/x', head_sha: 'b'.repeat(40), mode: 'pull-request', config_revision: 1 });
    const gh = fakeGh({}, { [url(2)]: pr(2, 'OPEN', []) });
    const r = await syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: gh.fn });
    expect(r).toMatchObject({ synced: 1, failed: 1 });
    expect(r.tasks[0]!.error).toMatch(/gh pr view failed/);
    expect(r.tasks[1]!.warnings.join()).toMatch(/differs from the approved head/);
    const only = await syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: gh.fn }, { taskIds: ['task-2'] });
    expect(only.tasks.map((t) => t.taskId)).toEqual(['task-2']);
  });
});
