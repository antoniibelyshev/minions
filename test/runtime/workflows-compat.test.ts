// Tester coverage for task-33.3: backward compatibility of the stage machine without `workflows`, stale or
// mismatched task_stages rows, removed workflows, the changes-requested capture rule and delivery evidence.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { MinionsError } from '../../src/core/errors.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};
async function engineer(env: Env, id: string, file = 'a.txt', over: Record<string, unknown> = {}) {
  const brief = await env.sched.claim(id, 'engineer');
  const head = commitFile(brief.worktree, file, `work ${Math.random()}`);
  const r = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: [file], ...over }));
  return { brief, head, r };
}
async function tester(env: Env, id: string, opts: { commit?: boolean; over?: Record<string, unknown> } = {}) {
  const brief = await env.sched.claim(id, 'tester');
  const head = opts.commit ? commitFile(brief.worktree, 'test.txt', `t ${Math.random()}`) : brief.expectedHead;
  return { brief, head, r: await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: opts.commit ? ['test.txt'] : [], ...opts.over })) };
}
async function reviewer(env: Env, id: string, over: Record<string, unknown> = {}) {
  const brief = await env.sched.claim(id, 'reviewer');
  return { brief, r: await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', modifiedPaths: [], ...over })) };
}
const changes = { status: 'needs_changes', verdict: 'request-changes' };
const pos = (env: Env, id: string) => env.db.taskStage(id)?.position;
/** The same runtime (DB, backlog, repo) under a changed config, as after a config reload. */
function reconfigure(env: Env, mutate: (c: MinionsConfig) => void): Env {
  const config = structuredClone(env.config);
  mutate(config);
  const sched = new Scheduler({ db: env.db, backlog: env.backlog, config, layout: env.layout, handoff: { briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') } });
  return { ...env, config, sched };
}

describe('no workflows configured: the built-in pipeline is unchanged', () => {
  it('risk-based default: engineer without QA reasons goes straight to reviewing, then delivered; brief.model stays models.default', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const e = await engineer(env, 'task-1');
    expect(e.brief.model).toBe(env.config.models.default);
    expect(e.brief.stage).toEqual({ workflow: 'default', position: 0, count: 3, role: 'engineer' });
    expect(e.r).toMatchObject({ valid: true, from: 'implementing', to: 'reviewing' });
    expect(e.r.message ?? '').not.toMatch(/QA required/);
    expect((await err(env.sched.claim('task-1', 'tester'))).code).toBe('PRECONDITION');
    const rv = await reviewer(env, 'task-1');
    expect(rv.brief.model).toBe(env.config.models.default);
    expect(rv.r).toMatchObject({ approved: true, to: 'delivered' });
    expect(rv.r.message).toMatch(/^Approved at [0-9a-f]{40}; delivered locally/);
  });

  it('testerRequired: engineer → testing even without QA reasons, and no "QA required" message', async () => {
    const env = makeDefaultEnv((c) => { c.verification.testerRequired = true; });
    env.backlog.add({ id: 'task-1' });
    const e = await engineer(env, 'task-1');
    expect(e.r).toMatchObject({ to: 'testing' });
    expect(e.r.message ?? '').not.toMatch(/QA required/);
    expect((await tester(env, 'task-1')).r).toMatchObject({ to: 'reviewing' });
    expect((await reviewer(env, 'task-1')).r).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('reviewerRequired false, no QA: engineer → delivered without approval (as before)', async () => {
    const env = makeDefaultEnv((c) => { c.verification.reviewerRequired = false; });
    env.backlog.add({ id: 'task-1' });
    const e = await engineer(env, 'task-1');
    expect(e.brief.stage!.count).toBe(2);
    expect(e.r).toMatchObject({ to: 'delivered', approved: false });
  });

  it('reviewerRequired false with QA: engineer → testing → delivered (tester last, no approval)', async () => {
    const env = makeDefaultEnv((c) => { c.verification.reviewerRequired = false; });
    env.backlog.add({ id: 'task-1', labels: ['qa'] });
    expect((await engineer(env, 'task-1')).r).toMatchObject({ to: 'testing' });
    expect((await tester(env, 'task-1')).r).toMatchObject({ to: 'delivered', approved: false });
  });

  it('reviewerRequired false: an optional reviewer on a reviewing task still runs (appended stage) and approves', async () => {
    const env = makeDefaultEnv((c) => { c.verification.reviewerRequired = false; });
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    env.backlog.tasks.get('task-1')!.status = 'reviewing';
    const rv = await reviewer(env, 'task-1');
    expect(rv.brief.stage).toMatchObject({ workflow: 'default', position: 2, count: 3, role: 'reviewer' });
    expect(rv.r).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('reviewer request-changes repairs to the engineer and counts cycles up to the replan limit (default limit)', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const limit = env.config.execution.maxRepairCyclesBeforeReplan;
    for (let i = 1; i <= limit; i++) {
      await engineer(env, 'task-1');
      const rv = await reviewer(env, 'task-1', changes);
      expect(rv.r.repairCycles).toBe(i);
      if (i < limit) { expect(rv.r).toMatchObject({ to: 'changes-requested', replan: false }); expect(pos(env, 'task-1')).toBe(0); }
      else expect(rv.r).toMatchObject({ to: 'awaiting-human', replan: true });
    }
  });

  it('engineer needs_changes returns the task to its pre-claim status (ready / changes-requested), not a repair', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const first = await engineer(env, 'task-1', 'a.txt', { status: 'needs_changes' });
    expect(first.r).toMatchObject({ to: 'ready' });
    expect(first.r.repairCycles).toBeUndefined();
    await engineer(env, 'task-1');
    await reviewer(env, 'task-1', changes);
    const again = await engineer(env, 'task-1', 'a.txt', { status: 'needs_changes' });
    expect(again.r).toMatchObject({ from: 'implementing', to: 'changes-requested' });
    expect(env.db.repairCycles('task-1')).toBe(1);
  });

  it('a lease claimed before task_stages existed (no row at record) records as before', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    const b = await env.sched.claim('task-1', 'reviewer');
    env.db.exec('DELETE FROM task_stages');
    const r = await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: b.expectedHead, modifiedPaths: [], ...changes }));
    expect(r).toMatchObject({ to: 'changes-requested', repairCycles: 1 });
    expect(pos(env, 'task-1')).toBe(0);
  });

  it('a QA-required reviewer approval without tester evidence goes back to testing (default workflow tester, no insertion)', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    env.backlog.tasks.get('task-1')!.labels.push('qa');
    const rv = await reviewer(env, 'task-1');
    expect(rv.r).toMatchObject({ approved: false, to: 'testing' });
    const row = env.db.taskStage('task-1')!;
    expect(JSON.parse(row.stages_json)).toEqual([{ role: 'engineer' }, { role: 'tester', when: 'qa' }, { role: 'reviewer' }]);
    expect(row.position).toBe(1);
  });
});

describe('stale or mismatched task_stages rows', () => {
  it('a corrupt stages_json falls back to the status', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    env.db.exec("UPDATE task_stages SET stages_json = 'not json'");
    expect(env.sched.stagePlan(env.backlog.tasks.get('task-1')!)).toMatchObject({ workflow: 'default', position: 2 });
    env.db.exec(`UPDATE task_stages SET stages_json = '[{"x":1}]'`);
    expect(env.sched.stagePlan(env.backlog.tasks.get('task-1')!)).toMatchObject({ workflow: 'default', position: 2 });
    expect((await reviewer(env, 'task-1')).r).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('a row for another workflow name is ignored', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = { docs: ['engineer', 'reviewer'] }; });
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    env.db.setTaskStage('task-1', 'docs', [{ role: 'engineer' }, { role: 'reviewer' }], 1);
    expect(env.sched.stagePlan(env.backlog.tasks.get('task-1')!)).toMatchObject({ workflow: 'default', position: 2 });
  });

  it('a workflow whose stages changed in config ignores the stored row and derives from the status', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = { docs: ['engineer', 'reviewer'] }; });
    env.backlog.add({ id: 'task-1', workflow: 'docs' });
    await engineer(env, 'task-1');
    expect(pos(env, 'task-1')).toBe(1);
    const env2 = reconfigure(env, (c) => { c.workflows = { docs: ['engineer', 'tester', 'reviewer'] }; });
    const plan = env2.sched.stagePlan(env2.backlog.tasks.get('task-1')!)!;
    expect(plan.stages.map((s) => s.role)).toEqual(['engineer', 'tester', 'reviewer']);
    expect(plan.position).toBe(2);
    expect((await reviewer(env2, 'task-1')).r).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('a status set outside the stage machine (CI sync → changes-requested) on a tester/reviewer stage routes to the engineer', async () => {
    const env = makeDefaultEnv((c) => { c.verification.testerRequired = true; });
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    expect(pos(env, 'task-1')).toBe(1);
    env.backlog.tasks.get('task-1')!.status = 'changes-requested';
    expect((await err(env.sched.claim('task-1', 'tester'))).code).toBe('PRECONDITION');
    expect((await env.sched.claim('task-1', 'engineer')).stage!.position).toBe(0);
  });

  it('statuses no stage runs from (blocked, awaiting-human, idea) have no plan and refuse every role', async () => {
    const env = makeDefaultEnv();
    for (const status of ['blocked', 'awaiting-human', 'idea'] as const) {
      env.backlog.add({ id: `t-${status}`, status });
      expect(env.sched.stagePlan(env.backlog.tasks.get(`t-${status}`)!)).toBeNull();
      for (const role of ['engineer', 'tester', 'reviewer'] as const) {
        expect((await err(env.sched.claim(`t-${status}`, role))).code, `${status} ${role}`).toBe('PRECONDITION');
      }
    }
  });
});

describe('a workflow removed from the config', () => {
  it('an in-flight lease still records; the next claim is refused until a configured workflow is assigned', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = { docs: ['engineer', 'reviewer'] }; });
    env.backlog.add({ id: 'task-1', workflow: 'docs' });
    const b = await env.sched.claim('task-1', 'engineer');
    const head = commitFile(b.worktree, 'a.txt', 'x');
    const env2 = reconfigure(env, (c) => { delete c.workflows; });
    const r = await env2.sched.record(b.leaseId, result({ branch: b.branch, headSha: head }));
    expect(r).toMatchObject({ valid: true, to: 'reviewing' });
    const e = await err(env2.sched.claim('task-1', 'reviewer'));
    expect(e.code).toBe('PRECONDITION');
    expect(e.message).toMatch(/workflow "docs", which is not configured/);
    expect(e.hint).toMatch(/--workflow/);
    const t = env2.backlog.tasks.get('task-1')!;
    await env2.backlog.updateTask('task-1', t.version, { workflow: null });
    const rv = await reviewer(env2, 'task-1');
    expect(rv.brief.stage).toMatchObject({ workflow: 'default', position: 2 });
    expect(rv.r).toMatchObject({ approved: true, to: 'delivered' });
  });
});

describe('changes-requested capture rule', () => {
  const TWICE = { twice: ['engineer', 'reviewer', 'engineer', 'reviewer'] };

  it('a later producer that a later gate repairs to is claimed from changes-requested at its own position', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = TWICE; });
    env.backlog.add({ id: 'task-1', workflow: 'twice' });
    await engineer(env, 'task-1');
    expect((await reviewer(env, 'task-1')).r).toMatchObject({ approved: false, to: 'implementing' });
    expect(pos(env, 'task-1')).toBe(2);
    const second = await engineer(env, 'task-1', 'b.txt');
    expect(second.brief.stage).toMatchObject({ workflow: 'twice', position: 2 });
    expect(second.r).toMatchObject({ to: 'reviewing' });
    const rv = await reviewer(env, 'task-1', changes);
    expect(rv.r).toMatchObject({ to: 'changes-requested', repairCycles: 1 });
    expect(pos(env, 'task-1')).toBe(2);
    expect((await env.sched.claim('task-1', 'engineer')).stage!.position).toBe(2);
  });

  it('changes-requested set outside the machine on the first gate does not stay at the gate', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = TWICE; });
    env.backlog.add({ id: 'task-1', workflow: 'twice' });
    await engineer(env, 'task-1');
    expect(pos(env, 'task-1')).toBe(1);
    env.backlog.tasks.get('task-1')!.status = 'changes-requested';
    expect((await err(env.sched.claim('task-1', 'reviewer'))).code).toBe('PRECONDITION');
    expect((await env.sched.claim('task-1', 'engineer')).stage!.position).toBe(0);
  });

  it('the first gate request-changes repairs to the first engineer', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = TWICE; });
    env.backlog.add({ id: 'task-1', workflow: 'twice' });
    await engineer(env, 'task-1');
    expect((await reviewer(env, 'task-1', changes)).r).toMatchObject({ to: 'changes-requested', repairCycles: 1 });
    expect(pos(env, 'task-1')).toBe(0);
  });
});

describe('delivery evidence is for the current head', () => {
  const AFTER = { after: ['engineer', 'reviewer', 'tester'] };

  it('a stage after the gate that commits: the earlier approval does not approve the new head', async () => {
    const env = makeDefaultEnv((c) => { c.verification.reviewerRequired = false; c.workflows = AFTER; });
    env.backlog.add({ id: 'task-1', workflow: 'after' });
    await engineer(env, 'task-1');
    const rv = await reviewer(env, 'task-1');
    expect(rv.r).toMatchObject({ approved: false, to: 'testing' });
    const t = await tester(env, 'task-1', { commit: true });
    expect(t.head).not.toBe(rv.brief.expectedHead);
    expect(t.r).toMatchObject({ valid: true, approved: false, to: 'delivered' });
    expect(t.r.message ?? '').not.toMatch(/Approved at/);
    expect(env.db.publication('task-1')).toBeUndefined();
  });

  it('a stage after the gate that does not commit: delivered with the gate approval for that same head', async () => {
    const env = makeDefaultEnv((c) => { c.verification.reviewerRequired = false; c.workflows = AFTER; });
    env.backlog.add({ id: 'task-1', workflow: 'after' });
    await engineer(env, 'task-1');
    const rv = await reviewer(env, 'task-1');
    const t = await tester(env, 'task-1');
    expect(t.r).toMatchObject({ approved: true, to: 'delivered' });
    expect(t.r.message).toContain(`Approved at ${rv.brief.expectedHead}`);
  });

  it('an approval recorded for an old head is not reused once the branch moves (reviewer pinned to its head)', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const e = await engineer(env, 'task-1');
    const b = await env.sched.claim('task-1', 'reviewer');
    // The branch moves while the review runs: the approval names the old head and is rejected.
    const moved = commitFile(e.brief.worktree, 'late.txt', 'late');
    expect(gitSync(env.layout.repo, 'rev-parse', b.branch)).toBe(moved);
    const r = await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: b.expectedHead, verdict: 'approve', modifiedPaths: [] }));
    expect(r.valid).toBe(false);
    expect(r.errors!.join(' ')).toMatch(/stale head/);
    expect(env.backlog.status('task-1')).not.toBe('delivered');
  });
});
