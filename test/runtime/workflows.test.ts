import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { commitFile, makeDefaultEnv, result, tmp, type Env } from './fixtures.js';

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};
const DOCS = { docs: ['engineer', { role: 'reviewer' as const, model: 'haiku' }] };

async function engineer(env: Env, id: string, file = 'a.txt') {
  const brief = await env.sched.claim(id, 'engineer');
  const head = commitFile(brief.worktree, file, `work ${Math.random()}`);
  const r = await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: [file] }));
  return { brief, head, r };
}
async function tester(env: Env, id: string) {
  const brief = await env.sched.claim(id, 'tester');
  return { brief, r: await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead })) };
}
async function reviewer(env: Env, id: string, over: Record<string, unknown> = {}) {
  const brief = await env.sched.claim(id, 'reviewer');
  return { brief, r: await env.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: brief.expectedHead, verdict: 'approve', ...over })) };
}
const stageRow = (env: Env, id: string) => {
  const row = env.db.taskStage(id);
  return row ? { workflow: row.workflow, position: row.position, roles: (JSON.parse(row.stages_json) as { role: string }[]).map((s) => s.role) } : undefined;
};

describe('workflows: the docs workflow', () => {
  it('runs engineer → reviewer (haiku hint) → delivered, with the position stored per stage', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = DOCS; });
    env.backlog.add({ id: 'task-1', workflow: 'docs' });
    const { brief, r } = await engineer(env, 'task-1');
    expect(brief.stage).toEqual({ workflow: 'docs', position: 0, count: 2, role: 'engineer' });
    expect(brief.model).toBe('sonnet');
    expect(r).toMatchObject({ valid: true, from: 'implementing', to: 'reviewing' });
    expect(stageRow(env, 'task-1')).toEqual({ workflow: 'docs', position: 1, roles: ['engineer', 'reviewer'] });
    const rev = await reviewer(env, 'task-1');
    expect(rev.brief.model).toBe('haiku');
    expect(rev.brief.stage).toEqual({ workflow: 'docs', position: 1, count: 2, role: 'reviewer', model: 'haiku' });
    expect(rev.r).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    expect(stageRow(env, 'task-1')!.position).toBe(2);
  });

  it('claim is validated by the current stage role', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = DOCS; });
    env.backlog.add({ id: 'task-1', workflow: 'docs' });
    await engineer(env, 'task-1');
    const e = await err(env.sched.claim('task-1', 'engineer'));
    expect(e.code).toBe('PRECONDITION');
    expect(e.message).toMatch(/can only be claimed from ready\|changes-requested\. The current stage is reviewer \(workflow docs, stage 2\/2\)/);
    expect((await err(env.sched.claim('task-1', 'tester'))).code).toBe('PRECONDITION');
  });

  it('refuses a task whose workflow is not configured', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1', workflow: 'docs' });
    const e = await err(env.sched.claim('task-1', 'engineer'));
    expect(e.code).toBe('PRECONDITION');
    expect(e.message).toMatch(/workflow "docs", which is not configured \(configured: default\)/);
    expect(env.db.activeLeases()).toHaveLength(0);
  });
});

describe('workflows: QA cannot be skipped by choosing a workflow (invariant 3)', () => {
  it('a QA label inserts the built-in tester before the final gate of a workflow without one', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = DOCS; });
    env.backlog.add({ id: 'task-1', workflow: 'docs', labels: ['qa'] });
    const { r } = await engineer(env, 'task-1');
    expect(r).toMatchObject({ to: 'testing' });
    expect(r.message).toMatch(/QA required \(label qa\): task → testing/);
    expect(stageRow(env, 'task-1')).toEqual({ workflow: 'docs', position: 1, roles: ['engineer', 'tester', 'reviewer'] });
    expect((await err(env.sched.claim('task-1', 'reviewer'))).code).toBe('PRECONDITION');
    expect((await tester(env, 'task-1')).r).toMatchObject({ to: 'reviewing' });
    expect((await reviewer(env, 'task-1')).r).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('a sensitive path gets a tester in any workflow, and the QA label is recorded', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = DOCS; });
    env.backlog.add({ id: 'task-1', workflow: 'docs' });
    const { r } = await engineer(env, 'task-1', 'CLAUDE.md');
    expect(r).toMatchObject({ to: 'testing' });
    expect(env.backlog.tasks.get('task-1')!.labels).toContain('qa');
  });

  it('a gate flagging needsQa sends the task to an inserted tester, then back to the gate', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = DOCS; });
    env.backlog.add({ id: 'task-1', workflow: 'docs' });
    await engineer(env, 'task-1');
    const first = await reviewer(env, 'task-1', { needsQa: true });
    expect(first.r).toMatchObject({ approved: false, to: 'testing' });
    expect(first.r.message).toMatch(/no passing tester evidence/);
    expect(stageRow(env, 'task-1')).toEqual({ workflow: 'docs', position: 1, roles: ['engineer', 'tester', 'reviewer'] });
    expect((await tester(env, 'task-1')).r).toMatchObject({ to: 'reviewing' });
    expect((await reviewer(env, 'task-1')).r).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('a QA sweep ignores workflows (tester only)', async () => {
    const env = makeDefaultEnv((c) => { c.workflows = DOCS; });
    env.backlog.add({ id: 'task-1', workflow: 'docs', labels: ['qa-sweep'] });
    expect((await err(env.sched.claim('task-1', 'engineer'))).code).toBe('PRECONDITION');
    const b = await env.sched.claim('task-1', 'tester');
    expect(b.kind).toBe('qa-sweep');
    expect(b.stage).toBeUndefined();
    expect(env.db.taskStage('task-1')).toBeUndefined();
  });
});

describe('workflows: repair targets and replan', () => {
  it('a reviewer request-changes goes to the engineer (not the committing tester before it) and counts repair cycles', async () => {
    const env = makeDefaultEnv((c) => { c.verification.testerRequired = true; c.execution.maxRepairCyclesBeforeReplan = 2; });
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    await tester(env, 'task-1');
    const first = await reviewer(env, 'task-1', { status: 'needs_changes', verdict: 'request-changes' });
    expect(first.r).toMatchObject({ to: 'changes-requested', repairCycles: 1, replan: false });
    expect(stageRow(env, 'task-1')!.position).toBe(0);
    expect((await err(env.sched.claim('task-1', 'tester'))).code).toBe('PRECONDITION');
    await engineer(env, 'task-1');
    await tester(env, 'task-1');
    const second = await reviewer(env, 'task-1', { status: 'needs_changes', verdict: 'request-changes' });
    expect(second.r).toMatchObject({ to: 'awaiting-human', repairCycles: 2, replan: true });
  });

  it('a tester needs_changes goes to the engineer without counting a repair cycle', async () => {
    const env = makeDefaultEnv((c) => { c.verification.testerRequired = true; });
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    const b = await env.sched.claim('task-1', 'tester');
    const r = await env.sched.record(b.leaseId, result({ branch: b.branch, headSha: b.expectedHead, status: 'needs_changes' }));
    expect(r).toMatchObject({ to: 'changes-requested' });
    expect(r.repairCycles).toBeUndefined();
    expect(env.db.repairCycles('task-1')).toBe(0);
    expect(stageRow(env, 'task-1')!.position).toBe(0);
    expect((await engineer(env, 'task-1')).r).toMatchObject({ from: 'implementing', to: 'testing' });
  });
});

describe('workflows: legacy tasks and assignment', () => {
  it('tasks without a stage row derive the position from their status', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const { brief } = await engineer(env, 'task-1');
    env.db.exec('DELETE FROM task_stages');
    // Forced to testing (e.g. an older runtime put it there): the tester stage is current.
    env.backlog.tasks.get('task-1')!.status = 'testing';
    const t = await env.sched.claim('task-1', 'tester');
    expect(t.stage).toMatchObject({ workflow: 'default', position: 1, role: 'tester' });
    expect((await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: t.expectedHead }))).to).toBe('reviewing');
    env.db.exec('DELETE FROM task_stages');
    const rv = await reviewer(env, 'task-1');
    expect(rv.brief.stage).toMatchObject({ position: 2, role: 'reviewer' });
    expect(rv.r).toMatchObject({ approved: true, to: 'delivered' });
    expect(brief.stage!.position).toBe(0);
  });

  it('a stale stage row (status changed outside the stage machine) yields to the status', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    expect(stageRow(env, 'task-1')!.position).toBe(2);
    env.backlog.tasks.get('task-1')!.status = 'ready';
    expect((await env.sched.claim('task-1', 'engineer')).stage!.position).toBe(0);
  });

  it('a workflow changed between stages takes effect at the next claim', async () => {
    const env = makeDefaultEnv((c) => { c.verification.testerRequired = true; c.workflows = DOCS; });
    env.backlog.add({ id: 'task-1' });
    await engineer(env, 'task-1');
    expect(env.backlog.status('task-1')).toBe('testing');
    const t = env.backlog.tasks.get('task-1')!;
    await env.backlog.updateTask('task-1', t.version, { workflow: 'docs', status: 'reviewing' });
    const rv = await reviewer(env, 'task-1');
    expect(rv.brief.stage).toMatchObject({ workflow: 'docs', position: 1 });
  });

  it('migrates a v4 database to the task_stages schema', () => {
    const path = join(tmp(), 'm.db');
    const v4 = new RuntimeDb(path);
    v4.exec('DROP TABLE task_stages');
    v4.setMeta('schema_version', '4');
    v4.close();
    const up = new RuntimeDb(path);
    expect(SCHEMA_VERSION).toBe(5);
    expect(up.getMeta('schema_version')).toBe('5');
    up.setTaskStage('task-1', 'default', [{ role: 'engineer' }], 0);
    expect(up.taskStage('task-1')).toMatchObject({ workflow: 'default', position: 0 });
    up.close();
  });
});
