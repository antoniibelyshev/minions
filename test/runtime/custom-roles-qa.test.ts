// task-33.4 QA: edge cases of custom-role stages beyond custom-roles.test.ts: pre-claim status restore on
// release/partial for project roles, history rewrites under an edit scope, reserved role names in a full
// config, the workflow-reset fallback to the final gate, and repeated `requires` refusals.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { MinionsError } from '../../src/core/errors.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};
const ROLES = {
  researcher: { description: 'Researches.', promptText: 'Research.', contract: 'producer', edits: { paths: ['docs/research/**'] } },
  writer: { description: 'Writes docs.', promptText: 'Write.', contract: 'producer', edits: { paths: ['docs/**'] } },
  checker: { description: 'Checks.', promptText: 'Check.', contract: 'verifier' },
  scribe: { description: 'Edits anything but must not commit.', promptText: 'Scribe.', contract: 'producer', edits: 'any', commits: false },
  fetcher: { description: 'Needs the network.', promptText: 'Fetch.', contract: 'producer', requires: ['network.use'], capabilities: { 'network.use': 'ask' } },
};
const WORKFLOWS = {
  research: ['researcher', 'writer', 'reviewer'],
  checked: ['engineer', 'checker', 'reviewer'],
  scribe: ['scribe', 'engineer', 'reviewer'],
  fetch: ['fetcher', 'engineer', 'reviewer'],
};
const env = () => makeDefaultEnv((c) => {
  (c as { roles?: unknown }).roles = structuredClone(ROLES);
  (c as { workflows?: unknown }).workflows = structuredClone(WORKFLOWS);
});
const mkdirCommit = (dir: string, file: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  return commitFile(dir, file, `x ${Math.random()}`);
};
async function stageIn(e: Env, id: string, role: string, files: string[] = [], over: Record<string, unknown> = {}) {
  const brief = await e.sched.claim(id, role);
  let head = brief.expectedHead;
  for (const f of files) head = mkdirCommit(brief.worktree, f);
  const r = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: files, ...over }));
  return { brief, head, r };
}

describe('config: reserved evidence kinds are refused as project role names', () => {
  it('a full config with a role named "check" or "ci-gate" is invalid', async () => {
    const { defaults } = await import('../helpers.js');
    for (const name of ['check', 'ci-gate']) {
      const roles = { [name]: { description: 'x', promptText: 'x', contract: 'verifier' } };
      expect(() => validateConfig({ ...defaults('project-owner'), roles }), name).toThrow(/reserved/);
    }
  });
});

describe('pre-claim status restore for project roles', () => {
  it('releasing a project producer claimed from ready restores ready', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const b = await e.sched.claim('task-1', 'researcher');
    expect(e.backlog.status('task-1')).toBe('implementing');
    expect((await e.sched.release(b.leaseId, 'retry')).status).toBe('ready');
    expect((await e.sched.claim('task-1', 'researcher')).stage).toMatchObject({ position: 0 });
  });

  it('releasing a project producer claimed as a repair target restores changes-requested', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    await stageIn(e, 'task-1', 'researcher', ['docs/research/a.md']);
    await stageIn(e, 'task-1', 'writer', ['docs/a.md']);
    const rv = await stageIn(e, 'task-1', 'reviewer', [], { status: 'needs_changes', verdict: 'request-changes', modifiedPaths: [] });
    expect(rv.r).toMatchObject({ to: 'changes-requested' });
    const w = await e.sched.claim('task-1', 'writer');
    expect(e.backlog.status('task-1')).toBe('implementing');
    expect((await e.sched.release(w.leaseId, 'retry')).status).toBe('changes-requested');
    expect((await e.sched.claim('task-1', 'writer')).stage).toMatchObject({ position: 1, role: 'writer' });
  });

  it('a project producer partial returns to the pre-claim status; a project verifier partial stays in testing', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const p = await stageIn(e, 'task-1', 'researcher', [], { status: 'partial', modifiedPaths: [] });
    expect(p.r).toMatchObject({ valid: true, to: 'ready' });

    e.backlog.add({ id: 'task-2', workflow: 'checked' });
    await stageIn(e, 'task-2', 'engineer', ['a.txt']);
    expect(e.backlog.status('task-2')).toBe('testing');
    const c = await stageIn(e, 'task-2', 'checker', [], { status: 'partial', modifiedPaths: [] });
    expect(c.r).toMatchObject({ valid: true, to: 'testing' });
    // release of a verifier claimed from its own stage status leaves the status alone
    const c2 = await e.sched.claim('task-2', 'checker');
    expect((await e.sched.release(c2.leaseId, 'retry')).status).toBe('testing');
  });

  it('an unvalidated project producer (second invalid result) restores the pre-claim status', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const b = await e.sched.claim('task-1', 'researcher');
    const head = mkdirCommit(b.worktree, 'src/x.ts');
    expect((await e.sched.record(b.leaseId, result({ branch: b.branch, headSha: head }))).correctionAllowed).toBe(true);
    const r2 = await e.sched.record(b.leaseId, result({ branch: b.branch, headSha: head }), { correction: true });
    expect(r2).toMatchObject({ unvalidated: true });
    expect(e.backlog.status('task-1')).toBe('ready');
  });
});

describe('edit scope: history rewrites and the net diff', () => {
  it('a path-limited producer that rewrites away an earlier stage\'s commit is refused (the removed paths are in the diff)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const r = await stageIn(e, 'task-1', 'researcher', ['docs/research/a.md']);
    expect(r.r.valid).toBe(true);
    const w = await e.sched.claim('task-1', 'writer');
    // writer (docs/**) resets the branch to before the researcher's work and adds src/ via a rewrite
    gitSync(w.worktree, 'reset', '-q', '--hard', r.brief.expectedHead);
    const head = mkdirCommit(w.worktree, 'src/evil.ts');
    const rec = await e.sched.record(w.leaseId, result({ branch: w.branch, headSha: head }));
    expect(rec.valid).toBe(false);
    expect(rec.errors!.join()).toMatch(/src\/evil\.ts/);
  });

  it('a glob boundary: docs/research/** does not cover docs/researchers/x.md', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const r = await stageIn(e, 'task-1', 'researcher', ['docs/researchers/x.md']);
    expect(r.r.valid).toBe(false);
    expect(r.r.errors!.join()).toMatch(/docs\/researchers\/x\.md outside that scope/);
  });

  // Regression (QA, task-33.4): editScopeErrors checks commits before the edits "any" shortcut, so a
  // commits: false role cannot move the head even with edits "any".
  it('a role with commits: false must not move the head even when edits is "any"', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'scribe' });
    const b = await e.sched.claim('task-1', 'scribe');
    expect(b.editScope).toEqual({ edits: 'any', commits: false });
    expect(b.publication['git.commit']).toBe('deny');
    const head = commitFile(b.worktree, 'notes.md', 'x');
    const r = await e.sched.record(b.leaseId, result({ branch: b.branch, headSha: head }));
    expect(r.valid).toBe(false);
    expect(r.errors!.join()).toMatch(/does not commit/);
  });
});

describe('requires: repeated refusals and no side effects', () => {
  it('an ask refusal leaves no lease, no status change, and logs one stage-refused event per attempt', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'fetch' });
    for (let i = 0; i < 2; i++) expect((await err(e.sched.claim('task-1', 'fetcher'))).code).toBe('POLICY_DENIED');
    expect(e.db.activeLeases()).toHaveLength(0);
    expect(e.db.leases({ taskId: 'task-1', all: true })).toHaveLength(0);
    expect(e.backlog.status('task-1')).toBe('ready');
    expect(e.db.events('task-1', 'stage-refused')).toHaveLength(2);
  });
});

describe('workflow-reset with evidence for every stage', () => {
  it('falls back to the final gate when each stage of the new workflow has complete evidence at the head', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'checked' });
    const eng = await stageIn(e, 'task-1', 'engineer', ['a.txt']);
    await stageIn(e, 'task-1', 'checker', [], { modifiedPaths: [] });
    expect(e.backlog.status('task-1')).toBe('reviewing');
    // the reviewer asks for nothing yet; switch to the default workflow (engineer, tester when qa, reviewer)
    const t = e.backlog.tasks.get('task-1')!;
    await e.backlog.updateTask('task-1', t.version, { workflow: 'default' as never });
    const rv = await e.sched.claim('task-1', 'reviewer');
    expect(rv.stage).toMatchObject({ workflow: 'default', role: 'reviewer' });
    expect(rv.expectedHead).toBe(eng.head);
    expect(e.db.events('task-1', 'workflow-reset')).toEqual([expect.objectContaining({ data: expect.objectContaining({ from: 'checked', to: 'default', role: 'reviewer' }) })]);
  });
});
