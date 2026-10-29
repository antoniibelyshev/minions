// Local integration wired to approval, policy and repair (task-82.3, docs/design/local-auto-integration.md phase 3):
// work record queues the approved head, the integrator (fake verification commands) lands it or hands it back,
// base.merge policy and sensitive paths need a signed merge approval, and the dependency rule follows the switch.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterReady } from '../../src/backlog/ready.js';
import { can } from '../../src/config/capabilities.js';
import { autoMergeConfigReasons, dependencyDoneStatuses, localIntegrationEnabled } from '../../src/config/delivery.js';
import { listUnavailable } from '../../src/config/resolve.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { signApproval, verifyAnyApproval } from '../../src/core/approval.js';
import { integrationRows, runIntegrator, type IntegratorDeps } from '../../src/runtime/integrator.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { defaults } from '../helpers.js';
import { approvalKeys, commitFile, gitSync, makeEnv, result, type Env } from './fixtures.js';

interface LocalEnv extends Env { keys: ReturnType<typeof approvalKeys>; starts: number }

function localEnv(mutate?: (c: MinionsConfig) => void): LocalEnv {
  const keys = approvalKeys();
  const env = makeEnv((c) => {
    c.delivery.mode = 'local'; c.delivery.provider = 'none'; c.delivery.merge = 'auto-when-eligible';
    c.verification.commands = ['true'];
    c.verification.setupCommands = [];
    mutate?.(c);
  });
  const out = { ...env, keys, starts: 0 } as LocalEnv;
  out.sched = new Scheduler({
    db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, approvalPublicKeyFile: keys.publicKeyFile,
    handoff: { briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') },
    startIntegrator: () => { out.starts++; },
  });
  return out;
}

/** engineer (commits `file`) → tester → reviewer approve. */
async function approveTask(env: Env, id: string, file = `${id}.txt`, content = `work ${Math.random()}`) {
  const eng = await env.sched.claim(id, 'engineer');
  mkdirSync(dirname(join(eng.worktree, file)), { recursive: true });
  const head = commitFile(eng.worktree, file, content);
  await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head, modifiedPaths: [file] }));
  const t = await env.sched.claim(id, 'tester');
  await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head, modifiedPaths: [file] }));
  const rev = await env.sched.claim(id, 'reviewer');
  const r = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve', modifiedPaths: [file] }));
  return { r, head, branch: eng.branch };
}

/** Runs the integrator against the env's repository with the scheduler's settle hook (as `work integrate` does). */
function integrate(env: LocalEnv) {
  const deps: IntegratorDeps = {
    db: env.db, repo: env.layout.repo,
    integrationDir: join(env.root, 'integration'), runDir: join(env.root, 'run', 'integration'), logDir: join(env.root, 'logs', 'integration'),
    config: () => env.config, env: { PATH: process.env.PATH },
    timing: { pollMs: 50, killGraceMs: 500, reapGraceMs: 500 },
    approved: (row) => verifyAnyApproval(env.db.approvals(row.task_id, 'merge', row.head_sha).map((a) => a.signature), readFileSync(env.keys.publicKeyFile, 'utf8'),
      { taskId: row.task_id, head: row.head_sha, scope: 'merge' }).ok,
    onSettled: async (row) => { await env.sched.settleIntegration(row); },
  };
  return runIntegrator(deps);
}

const mainOf = (env: Env) => gitSync(env.layout.repo, 'rev-parse', 'refs/heads/main');
const contains = (env: Env, sha: string) => { try { gitSync(env.layout.repo, 'merge-base', '--is-ancestor', sha, 'main'); return true; } catch { return false; } };

describe('local approval queues an integration', () => {
  it('approval → merging, a local publication, a detached start; landing → done with the head on main', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Add thing' });
    const { r, head, branch } = await approveTask(env, 'task-1');
    expect(r).toMatchObject({ approved: true, to: 'merging', publication: { mode: 'local', state: 'queued', status: 'merging', headSha: head } });
    expect((await env.backlog.getTask('task-1')).status).toBe('merging');
    expect(env.db.publication('task-1')).toMatchObject({ mode: 'local', state: 'queued', head_sha: head, branch });
    expect(integrationRows(env.db, 'task-1').map((x) => [x.phase, x.head_sha])).toEqual([['queued', head]]);
    expect(env.starts).toBe(1);
    expect(contains(env, head)).toBe(false);

    const rep = await integrate(env);
    expect(rep.settled.map((x) => x.phase)).toEqual(['landed']);
    expect(contains(env, head)).toBe(true);
    expect((await env.backlog.getTask('task-1')).status).toBe('done');
    expect(env.db.publication('task-1')!.state).toBe('published');
    expect(env.backlog.notes.map((n) => n.text).join('\n')).toMatch(/merged into main at [0-9a-f]{40}/);
    // A landed task re-published is a no-op.
    expect(await env.sched.publish('task-1')).toMatchObject({ state: 'published', status: 'done', mode: 'local' });
  });

  it('switch off (delivery.merge disabled): approval still ends delivered, nothing is queued', async () => {
    const env = localEnv((c) => { c.delivery.merge = 'disabled'; });
    env.backlog.add({ id: 'task-1', title: 'Old path' });
    const { r } = await approveTask(env, 'task-1');
    expect(r.to).toBe('delivered');
    expect(r.message).toMatch(/delivered locally/);
    expect(integrationRows(env.db, 'task-1')).toEqual([]);
    expect(env.starts).toBe(0);
    await expect(env.sched.publish('task-1')).rejects.toThrow(/has no approved publication|nothing is published/);
  });

  it('base.merge deny (supervised): approval ends delivered and the integrator never runs', async () => {
    const env = localEnv((c) => { c.capabilities['base.merge'] = 'deny'; });
    env.backlog.add({ id: 'task-1', title: 'Supervised' });
    const { r } = await approveTask(env, 'task-1');
    expect(r.to).toBe('delivered');
    expect(integrationRows(env.db, 'task-1')).toEqual([]);
    expect(env.starts).toBe(0);
  });
});

describe('repair hand-back', () => {
  it('a conflict leaves main unchanged, sends the task to changes-requested and briefs the engineer with an integrator finding', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Conflicting' });
    const { head } = await approveTask(env, 'task-1', 'shared.txt', 'from the branch\n');
    // main moves with a conflicting change before the integrator runs.
    const B = commitFile(env.layout.repo, 'shared.txt', 'from main\n');
    await integrate(env);
    expect(mainOf(env)).toBe(B);
    const task = await env.backlog.getTask('task-1');
    expect(task.status).toBe('changes-requested');
    expect(env.db.publication('task-1')).toMatchObject({ state: 'failed', error_code: 'conflict' });
    expect(env.db.evidenceOfKind('task-1', 'integration').some((e) => e.outcome === 'conflict')).toBe(true);

    const eng = await env.sched.claim('task-1', 'engineer');
    const integ = eng.priorFindings.find((f) => f.role === 'integrator');
    expect(integ).toBeDefined();
    expect(integ!.findings.join('\n')).toMatch(/integration conflict: .*shared\.txt/);
    expect(integ!.findings.join('\n')).toContain(B);
    expect(integ!.findings.join('\n')).toContain(head);
    expect(integ!.nextAction).toMatch(/Merge main into the branch, fix the conflicts/);
  });

  it('a red verification counts a repair cycle; at the limit the task goes to awaiting-human', async () => {
    const env = localEnv((c) => { c.verification.commands = ['echo boom-from-tests; exit 3']; c.execution.maxRepairCyclesBeforeReplan = 1; });
    env.backlog.add({ id: 'task-1', title: 'Red' });
    const before = mainOf(env);
    await approveTask(env, 'task-1');
    await integrate(env);
    expect(mainOf(env)).toBe(before);
    expect((await env.backlog.getTask('task-1')).status).toBe('awaiting-human');
    expect(env.backlog.notes.map((n) => n.text).join('\n')).toMatch(/integration red .*repair cycle 1, the limit 1/);
  });

  it('a red verification under the limit is changes-requested with the failing command in the finding', async () => {
    const env = localEnv((c) => { c.verification.commands = ['echo boom-from-tests; exit 3']; });
    env.backlog.add({ id: 'task-1', title: 'Red' });
    await approveTask(env, 'task-1');
    await integrate(env);
    expect((await env.backlog.getTask('task-1')).status).toBe('changes-requested');
    const eng = await env.sched.claim('task-1', 'engineer');
    const integ = eng.priorFindings.find((f) => f.role === 'integrator')!;
    expect(integ.findings[0]).toMatch(/integration red: .*boom-from-tests/s);
    expect(integ.nextAction).toMatch(/failing verification/);
  });
});

describe('policy: sensitive paths and base.merge ask', () => {
  it('a sensitive path waits in awaiting-human; work approve --merge then work publish lands it', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Touch CI' });
    const { head } = await approveTask(env, 'task-1', '.github/workflows/ci.yml', 'on: push\n');
    expect(env.db.publication('task-1')!.mode).toBe('local');
    const before = mainOf(env);
    await integrate(env);
    expect(mainOf(env)).toBe(before);
    expect((await env.backlog.getTask('task-1')).status).toBe('awaiting-human');
    expect(env.db.publication('task-1')!.state).toBe('awaiting-approval');
    expect(env.backlog.notes.map((n) => n.text).join('\n')).toContain(`minions work approve task-1 --head ${head} --merge`);

    // Unsigned or wrong-head approvals are refused; a signed merge approval is recorded.
    expect(() => env.sched.approveMerge('task-1', { head })).toThrow(/signed on the host/);
    expect(() => env.sched.approveMerge('task-1', { head: 'f'.repeat(40), signature: 'x' })).toThrow(/not the approved/);
    const a = env.sched.approveMerge('task-1', { head, signature: signApproval(env.keys.privateKeyPem, { taskId: 'task-1', head, by: 'owner', scope: 'merge' }).token });
    expect(a.message).toMatch(/minions work publish task-1/);

    const p = await env.sched.publish('task-1');
    expect(p).toMatchObject({ mode: 'local', state: 'queued', status: 'merging' });
    expect((await env.backlog.getTask('task-1')).status).toBe('merging');
    expect(env.starts).toBe(2);
    await integrate(env);
    expect(contains(env, head)).toBe(true);
    expect((await env.backlog.getTask('task-1')).status).toBe('done');
    expect(() => env.sched.approveMerge('task-1', { head, signature: 'x' })).toThrow(/already integrated/);
  });

  it('base.merge "ask" (personal-work) needs a merge approval even without sensitive paths', async () => {
    const env = localEnv((c) => { c.capabilities['base.merge'] = 'ask'; });
    env.backlog.add({ id: 'task-1', title: 'Ask' });
    const before = mainOf(env);
    await approveTask(env, 'task-1');
    await integrate(env);
    expect(mainOf(env)).toBe(before);
    expect((await env.backlog.getTask('task-1')).status).toBe('awaiting-human');
    expect(env.db.publication('task-1')!.error).toMatch(/base\.merge is "ask"/);
  });

  it('work publish refuses to re-queue a head that is no longer the branch head', async () => {
    const env = localEnv((c) => { c.capabilities['base.merge'] = 'ask'; });
    env.backlog.add({ id: 'task-1', title: 'Moved' });
    const { branch } = await approveTask(env, 'task-1');
    await integrate(env);
    // The branch moves after the approval (its worktree is still checked out).
    const wt = gitSync(env.layout.repo, 'worktree', 'list', '--porcelain').split('\n\n').find((b) => b.includes(`branch refs/heads/${branch}`))!.split('\n')[0]!.slice('worktree '.length);
    commitFile(wt, 'later.txt', 'later\n');
    await expect(env.sched.publish('task-1')).rejects.toThrow(/not the approved head/);
  });
});

describe('base.merge capability and mode-aware auto-merge reasons', () => {
  it('profile defaults: owner allow, personal ask, supervised deny; a sensitive path upgrades allow to ask', () => {
    expect(can(defaults('project-owner'), 'base.merge')).toBe('allow');
    expect(can(defaults('personal-work'), 'base.merge')).toBe('ask');
    expect(can(defaults('supervised'), 'base.merge')).toBe('deny');
    expect(can(defaults('project-owner'), 'base.merge', { paths: ['.github/workflows/ci.yml'] })).toBe('ask');
    expect(can(defaults('project-owner'), 'base.merge', { paths: ['src/a.ts'] })).toBe('allow');
  });

  const local = (mutate?: (c: MinionsConfig) => void) => {
    const c = defaults('project-owner');
    c.delivery.mode = 'local'; c.delivery.provider = 'none'; c.delivery.merge = 'auto-when-eligible';
    c.verification.commands = ['npm test'];
    mutate?.(c);
    return c;
  };

  it('local mode: integration readiness reasons only, and listUnavailable no longer reports it unavailable', () => {
    expect(autoMergeConfigReasons(local())).toEqual([]);
    expect(localIntegrationEnabled(local())).toBe(true);
    expect(listUnavailable(local()).find((u) => u.path === 'delivery.merge')).toBeUndefined();
    expect(autoMergeConfigReasons(local((c) => { c.capabilities['base.merge'] = 'deny'; }))).toEqual([expect.stringMatching(/base\.merge is denied/)]);
    expect(autoMergeConfigReasons(local((c) => { c.verification.commands = []; }))).toEqual([expect.stringMatching(/verification\.commands is empty/)]);
    expect(listUnavailable(local((c) => { c.verification.commands = []; })).find((u) => u.path === 'delivery.merge')?.reason).toMatch(/verification\.commands is empty/);
    expect(localIntegrationEnabled(local((c) => { c.delivery.merge = 'disabled'; }))).toBe(false);
  });

  it('pull-request mode is unchanged (pinned)', () => {
    const c = defaults('project-owner');
    c.delivery.mode = 'pull-request'; c.delivery.provider = 'github'; c.delivery.merge = 'auto-when-eligible';
    expect(autoMergeConfigReasons(c)).toEqual([
      'delivery.requiredChecksConfigured is false (never treated as zero required checks)',
      'verification.ciAuthority is not "github": required checks are not read as merge evidence',
    ]);
    c.capabilities['pr.merge'] = 'deny';
    expect(autoMergeConfigReasons(c)).toContain('pr.merge is denied by policy');
    c.delivery.mode = 'branch';
    expect(autoMergeConfigReasons(c)).toContain('auto-merge needs pull-request delivery to GitHub (delivery.mode is "branch")');
    expect(localIntegrationEnabled(c)).toBe(false);
    expect(dependencyDoneStatuses(c)).toEqual(new Set(['done', 'delivered']));
  });
});

describe('dependency rule and capacity', () => {
  it('with local integration on only done satisfies a dependency, in listReady and the claim check', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Dep', status: 'delivered' });
    env.backlog.add({ id: 'task-2', title: 'Dependent', dependencies: ['task-1'] });
    expect(dependencyDoneStatuses(env.config)).toEqual(new Set(['done']));
    const tasks = await env.backlog.listTasks();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ready = (completed: ReadonlySet<string>) => filterReady(tasks, { leased: new Set(), scope: { milestone: null, requiredLabels: [] } as never, lookup: (id) => byId.get(id), completed: completed as never }, 10).map((t) => t.id);
    expect(ready(dependencyDoneStatuses(env.config))).not.toContain('task-2');
    await expect(env.sched.claim('task-2', 'engineer')).rejects.toThrow(/depends on task-1, which is "delivered"/);
    env.backlog.tasks.get('task-1')!.status = 'merging';
    await expect(env.sched.claim('task-2', 'engineer')).rejects.toThrow(/which is "merging"/);
    env.backlog.tasks.get('task-1')!.status = 'done';
    await expect(env.sched.claim('task-2', 'engineer')).resolves.toMatchObject({ role: 'engineer' });
  });

  it('switch off or base.merge deny: delivered still satisfies a dependency', async () => {
    for (const mutate of [(c: MinionsConfig) => { c.delivery.merge = 'disabled'; }, (c: MinionsConfig) => { c.capabilities['base.merge'] = 'deny'; }]) {
      const env = localEnv(mutate);
      env.backlog.add({ id: 'task-1', title: 'Dep', status: 'delivered' });
      env.backlog.add({ id: 'task-2', title: 'Dependent', dependencies: ['task-1'] });
      expect(dependencyDoneStatuses(env.config)).toEqual(new Set(['done', 'delivered']));
      await expect(env.sched.claim('task-2', 'engineer')).resolves.toMatchObject({ role: 'engineer' });
    }
  });

  it('a merging task does not count against maxActiveTasks', async () => {
    const env = localEnv((c) => { c.execution.maxActiveTasks = 1; });
    env.backlog.add({ id: 'task-1', title: 'Merging' });
    await approveTask(env, 'task-1');
    expect((await env.backlog.getTask('task-1')).status).toBe('merging');
    env.backlog.add({ id: 'task-2', title: 'Next' });
    await expect(env.sched.claim('task-2', 'engineer')).resolves.toMatchObject({ role: 'engineer' });
  });
});
