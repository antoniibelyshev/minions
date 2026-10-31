// End-to-end check of the Backlog.md adapter against the real CLI: create (idempotent), versions and CONFLICT,
// the meta block, dependencies and cycles, readiness, notes and close. The pure parts and the CLI error mapping
// are unit-tested in backlogmd-unit.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BacklogMdAdapter } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { MinionsError } from '../../src/core/errors.js';

const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'backlog')));
const hasCli = !!process.env.MINIONS_BACKLOG_BIN || onPath;

const code = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof MinionsError ? e : undefined; }
  return undefined;
};

describe.skipIf(!hasCli)('Backlog.md adapter (real CLI)', () => {
  let root: string;
  let idem: MemoryIdempotencyStore;
  let a: BacklogMdAdapter;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'minions-bl-'));
    await writeBacklogConfig(root);
    idem = new MemoryIdempotencyStore();
    a = new BacklogMdAdapter({ root, idempotency: idem });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports capabilities', async () => {
    expect((await a.capabilities()).backend).toBe('backlogmd');
  });

  it('creates tasks idempotently and maps fields', async () => {
    const r = await a.createTask({ title: 'First task', description: 'Do the thing\n\nwith detail', acceptanceCriteria: ['works', 'tested'],
      priority: 'high', labels: ['minions:authorized', 'x'], status: 'ready', provenance: 'agent-hypothesis', idempotencyKey: 'k1' });
    expect(r.created).toBe(true);
    expect(r.task).toMatchObject({ id: 'task-1', locator: 'backlogmd:TASK-1', title: 'First task', description: 'Do the thing\n\nwith detail',
      status: 'ready', priority: 'high', authorized: true, provenance: 'agent-hypothesis', branch: null,
      acceptanceCriteria: [{ text: 'works', done: false }, { text: 'tested', done: false }] });
    const again = await a.createTask({ title: 'First task', idempotencyKey: 'k1' });
    expect(again.created).toBe(false);
    expect(again.task.id).toBe('task-1');
    expect((await a.listTasks()).length).toBe(1);
  });

  it('detects concurrent edits via version', async () => {
    const t = await a.getTask('TASK-1');
    expect(t.version).toBe((await a.getTask('backlogmd:TASK-1')).version);
    await a.addNote('task-1', 'someone else wrote this');
    const e = await code(a.updateTask('task-1', t.version, { status: 'implementing' }));
    expect(e?.code).toBe('CONFLICT');
    const fresh = await a.getTask('task-1');
    const upd = await a.updateTask('task-1', fresh.version, { status: 'implementing', labels: ['minions:authorized', 'y'] });
    expect(upd.status).toBe('implementing');
    expect(upd.labels.sort()).toEqual(['minions:authorized', 'y']);
    expect(upd.version).not.toBe(fresh.version);
  });

  it('round-trips meta and preserves user content', async () => {
    const t = await a.getTask('task-1');
    const u = await a.updateTask('task-1', t.version, { branch: 'agent/first-task' });
    expect(u).toMatchObject({ branch: 'agent/first-task', description: 'Do the thing\n\nwith detail', provenance: 'agent-hypothesis' });
    const u2 = await a.updateTask('task-1', u.version, { description: 'New text' });
    expect(u2).toMatchObject({ branch: 'agent/first-task', description: 'New text', provenance: 'agent-hypothesis' });
  });

  it('adds dependencies (merging) and rejects cycles with the path', async () => {
    const b = (await a.createTask({ title: 'Second', idempotencyKey: 'k2' })).task;
    const c = (await a.createTask({ title: 'Third', idempotencyKey: 'k3', dependencies: ['task-2'] })).task;
    expect(c.dependencies).toEqual(['task-2']);
    const d = (await a.createTask({ title: 'Fourth', idempotencyKey: 'k4' })).task;
    const c2 = await a.addDependency(c.id, d.id);
    expect(c2.dependencies.sort()).toEqual(['task-2', 'task-4']);
    await a.addDependency(b.id, 'task-1');
    const e = await code(a.addDependency('task-1', c.id));
    expect(e?.code).toBe('CONFLICT');
    expect(e?.message).toContain('task-1 -> task-3 -> task-2 -> task-1');
    expect((await code(a.addDependency('task-1', 'task-1')))?.code).toBe('CONFLICT');
    expect((await code(a.addDependency('task-1', 'task-99')))?.code).toBe('NOT_FOUND');
  });

  it('reads the backlog with one listing when adding a dependency (task-24.2)', async () => {
    // task-3 already depends on task-4: the listing answers it, no task view per end.
    const before = a.spawnCount;
    expect((await a.addDependency('TASK-3', 'task-4')).dependencies.sort()).toEqual(['task-2', 'task-4']);
    expect(a.spawnCount - before).toBe(1);
  });

  it('lists ready tasks per contract', async () => {
    const scope = { milestone: null, requiredLabels: [], allowedPaths: ['**'] };
    const r = (await a.createTask({ title: 'Ready one', status: 'ready', labels: ['minions:authorized'], idempotencyKey: 'k5', dependencies: ['task-4'] })).task;
    expect(await a.listReady(10, new Set(), scope)).toEqual([]); // task-4 not done; task-1 implementing
    await a.closeTask('task-4', 'done');
    expect((await a.listReady(10, new Set(), scope)).map((t) => t.id)).toEqual([r.id]);
    expect(await a.listReady(10, new Set([r.id]), scope)).toEqual([]);
  });

  it('appends notes and closes tasks', async () => {
    await a.addNote('task-2', 'note A');
    await a.addNote('task-2', 'note B');
    const out = readFileSync(join(root, 'backlog', 'tasks', 'task-2 - Second.md'), 'utf8');
    expect(out).toContain('note A');
    expect(out).toContain('note B');
    // getTask carries the notes Backlog.md stores (task-98); listings leave them out.
    expect((await a.getTask('task-2')).notes).toBe('note A\n\nnote B');
    expect((await a.listTasks()).every((t) => !('notes' in t))).toBe(true);
    expect((await a.closeTask('task-2', 'delivered')).status).toBe('delivered');
    expect((await code(a.getTask('task-77')))?.code).toBe('NOT_FOUND');
    expect((await a.exportTasks()).length).toBe(5);
  });

  it('stores the workflow name in the meta block (create, update, clear)', async () => {
    const t = (await a.createTask({ title: 'Docs task', description: 'Write docs', workflow: 'docs', idempotencyKey: 'k-wf' })).task;
    expect(t).toMatchObject({ workflow: 'docs', description: 'Write docs' });
    const u = await a.updateTask(t.id, t.version, { workflow: 'research', branch: 'agent/docs' });
    expect(u).toMatchObject({ workflow: 'research', branch: 'agent/docs', description: 'Write docs' });
    const cleared = await a.updateTask(t.id, u.version, { workflow: null });
    expect(cleared.workflow).toBeUndefined();
    expect(cleared.branch).toBe('agent/docs');
    expect('workflow' in (await a.getTask('task-1'))).toBe(false);
  });
});
