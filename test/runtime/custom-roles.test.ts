// task-33.4: custom-role stages (docs/design/roles-and-workflows.md D3, D4, D8): validateResult by contract
// variant, per-variant result contracts, worktree kind from the role, edit scope enforced at record,
// `requires` checked at claim, and end-to-end scheduler runs of project-role workflows.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { roleNameProblem } from '../../src/config/roles.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { MinionsError } from '../../src/core/errors.js';
import { resultContractText, validateResult } from '../../src/runtime/results.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';

const err = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};
const SHA = 'a'.repeat(40);
const base = (over: Record<string, unknown> = {}) => result({ branch: 'agent/x', headSha: SHA, ...over });

const ROLES = {
  researcher: { description: 'Researches; writes notes.', promptText: 'Research.', contract: 'producer', edits: { paths: ['docs/research/**'] } },
  writer: { description: 'Writes docs.', promptText: 'Write.', contract: 'producer', edits: { paths: ['docs/**'] } },
  analyst: { description: 'Read-only analysis.', promptText: 'Analyse.', contract: 'producer' },
  checker: { description: 'Checks the docs build.', promptText: 'Check.', contract: 'verifier' },
  auditor: { description: 'Audits the head.', promptText: 'Audit.', contract: 'gate' },
  'deploy-engineer': { description: 'Deploys an approved head.', promptText: 'Deploy.', contract: 'producer', requires: ['deploy.execute'], capabilities: { 'deploy.execute': 'allow' } },
  fetcher: { description: 'Needs the network.', promptText: 'Fetch.', contract: 'producer', requires: ['network.use'], capabilities: { 'network.use': 'ask' } },
};
const WORKFLOWS = {
  research: ['researcher', 'writer', 'reviewer'],
  deploy: ['engineer', 'reviewer', 'deploy-engineer'],
  audit: ['engineer', 'auditor'],
  analysis: ['analyst', 'engineer', 'reviewer'],
  checked: ['engineer', 'checker', 'reviewer'],
  fetch: ['fetcher', 'engineer', 'reviewer'],
};
const withRoles = (c: MinionsConfig) => {
  (c as { roles?: unknown }).roles = structuredClone(ROLES);
  (c as { workflows?: unknown }).workflows = structuredClone(WORKFLOWS);
};
const env = () => makeDefaultEnv(withRoles);

/** Claims `role`, commits `files` (when given) and records a result; returns the brief and the record response. */
async function stage(e: Env, id: string, role: string, files: string[] = [], over: Record<string, unknown> = {}) {
  const brief = await e.sched.claim(id, role);
  let head = brief.expectedHead;
  for (const f of files) head = commitFile(brief.worktree, f, `${role} ${Math.random()}`);
  const r = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: files, ...over }));
  return { brief, head, r };
}
/** Commits `file` (creating its parent directories); returns the new head. */
const mkdirCommit = (dir: string, file: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  return commitFile(dir, file, `x ${Math.random()}`);
};

/** Like stage(), creating parent directories of the files. */
async function stageIn(e: Env, id: string, role: string, files: string[] = [], over: Record<string, unknown> = {}) {
  const brief = await e.sched.claim(id, role);
  let head = brief.expectedHead;
  for (const f of files) head = mkdirCommit(brief.worktree, f);
  const r = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: files, ...over }));
  return { brief, head, r };
}

describe('config: the test roles and workflows are valid, reserved names', () => {
  it('validates ROLES and WORKFLOWS under the project-owner defaults', async () => {
    const { defaults } = await import('../helpers.js');
    expect(() => validateConfig({ ...defaults('project-owner'), roles: ROLES, workflows: WORKFLOWS })).not.toThrow();
  });

  it('reserves the runtime evidence kinds "check" and "ci-gate" as role names (33.3 review nit)', () => {
    expect(roleNameProblem('check')).toMatch(/reserved/);
    expect(roleNameProblem('ci-gate')).toMatch(/reserved/);
    expect(roleNameProblem('checker')).toBeNull();
  });
});

describe('validateResult by contract variant (D4)', () => {
  it('producer: no verdict, no needsQa, no CI evidence; failing checks allowed on complete', () => {
    expect(validateResult(base(), 'producer').ok).toBe(true);
    expect(validateResult(base({ checks: [{ command: 'npm test', outcome: 'fail' }] }), 'producer').ok).toBe(true);
    for (const over of [{ verdict: 'approve' }, { needsQa: true }, { checks: [{ command: 'test', outcome: 'pass', source: 'ci' }] }]) {
      const v = validateResult(base(over), 'producer', { ciAuthority: 'github' });
      expect(v.ok, JSON.stringify(over)).toBe(false);
    }
  });

  it('verifier: no verdict or needsQa; complete cannot fail checks; may cite CI with ciAuthority github', () => {
    expect(validateResult(base({ checks: [{ command: 'test', outcome: 'pass', source: 'ci' }] }), 'verifier', { ciAuthority: 'github' }).ok).toBe(true);
    expect(validateResult(base({ verdict: 'approve' }), 'verifier').ok).toBe(false);
    expect(validateResult(base({ needsQa: true }), 'verifier').ok).toBe(false);
    const failed = validateResult(base({ checks: [{ command: 'npm test', outcome: 'fail' }] }), 'verifier');
    expect(failed.ok ? [] : failed.errors).toEqual([expect.stringMatching(/cannot report failing checks/)]);
    expect(validateResult(base({ status: 'needs_changes', checks: [{ command: 'npm test', outcome: 'fail' }] }), 'verifier').ok).toBe(true);
  });

  it('gate: complete requires approve; needs_changes cannot approve; may set needsQa', () => {
    expect(validateResult(base({ verdict: 'approve', needsQa: true }), 'gate').ok).toBe(true);
    expect(validateResult(base(), 'gate').ok).toBe(false);
    expect(validateResult(base({ status: 'needs_changes', verdict: 'approve' }), 'gate').ok).toBe(false);
    expect(validateResult(base({ status: 'needs_changes', verdict: 'request-changes' }), 'gate').ok).toBe(true);
  });

  it('a built-in role name is its variant (engineer = producer, tester = verifier, reviewer = gate)', () => {
    const samples = [base(), base({ verdict: 'approve' }), base({ needsQa: true }), base({ checks: [{ command: 'npm test', outcome: 'fail' }] }),
      base({ status: 'needs_changes', verdict: 'request-changes' })];
    for (const [role, contract] of [['engineer', 'producer'], ['tester', 'verifier'], ['reviewer', 'gate']] as const) {
      for (const s of samples) expect(validateResult(s, role).ok, `${role} ${JSON.stringify(s)}`).toBe(validateResult(s, contract).ok);
    }
  });

  it('blocked, needs_split and partial are accepted for every variant', () => {
    for (const contract of ['producer', 'verifier', 'gate'] as const) {
      for (const status of ['blocked', 'needs_split', 'partial']) expect(validateResult(base({ status }), contract).ok, `${contract} ${status}`).toBe(true);
    }
  });
});

describe('result contract text per variant (D4)', () => {
  it('a producer is never told about verdict, needsQa or CI evidence; verifier and gate are', () => {
    const p = resultContractText('producer');
    expect(p).not.toMatch(/verdict\?|verdict:|needsQa\?|source\?/);
    expect(resultContractText('verifier')).toMatch(/source\?: local\|ci/);
    expect(resultContractText('verifier')).not.toMatch(/verdict:/);
    const g = resultContractText('gate');
    expect(g).toMatch(/verdict: approve\|request-changes/);
    expect(g).toMatch(/needsQa\?/);
    expect(g).toMatch(/head must not move/);
  });

  it('briefs carry the variant text: engineer (producer), reviewer (gate), project roles by their contract', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'audit' });
    const eng = await stage(e, 'task-1', 'engineer', ['a.txt']);
    expect(eng.brief.resultContract).toBe(resultContractText('producer'));
    expect(eng.brief.editScope).toBeUndefined(); // built-in briefs are unchanged
    const audit = await e.sched.claim('task-1', 'auditor');
    expect(audit.resultContract).toBe(resultContractText('gate', { commits: false }));
    expect(audit.editScope).toEqual({ edits: 'none', commits: false });
    expect(audit.publication['git.commit']).toBe('deny');
  });
});

describe('worktree kind from the role (D4)', () => {
  it('a project gate runs in a detached review worktree at the exact head; a project producer on the branch', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'audit' });
    const eng = await stage(e, 'task-1', 'engineer', ['a.txt']);
    expect(eng.r).toMatchObject({ valid: true, to: 'reviewing' });
    const audit = await e.sched.claim('task-1', 'auditor');
    expect(audit.worktree).not.toBe(eng.brief.worktree);
    expect(gitSync(audit.worktree, 'rev-parse', 'HEAD')).toBe(eng.head);
    expect(() => gitSync(audit.worktree, 'symbolic-ref', '-q', 'HEAD')).toThrow(); // detached
    // the gate's head must not move, and its verdict rules apply
    const noVerdict = await e.sched.record(audit.leaseId, result({ branch: audit.branch, headSha: eng.head, modifiedPaths: [] }));
    expect(noVerdict).toMatchObject({ valid: false, correctionAllowed: true });
    expect(noVerdict.errors!.join()).toMatch(/must have verdict "approve"/);
    const ok = await e.sched.record(audit.leaseId, result({ branch: audit.branch, headSha: eng.head, modifiedPaths: [], verdict: 'approve' }), { correction: true });
    expect(ok).toMatchObject({ valid: true, approved: true, to: 'delivered' });

    e.backlog.add({ id: 'task-2', workflow: 'research' });
    const res = await e.sched.claim('task-2', 'researcher');
    expect(gitSync(res.worktree, 'symbolic-ref', '--short', 'HEAD')).toBe(res.branch);
    expect(e.backlog.status('task-2')).toBe('implementing');
  });

  it('a project gate asking for changes repairs to the producer and counts a repair cycle', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'audit' });
    const eng = await stage(e, 'task-1', 'engineer', ['a.txt']);
    const audit = await stage(e, 'task-1', 'auditor', [], { status: 'needs_changes', verdict: 'request-changes', modifiedPaths: [] });
    expect(audit.head).toBe(eng.head);
    expect(audit.r).toMatchObject({ valid: true, to: 'changes-requested', repairCycles: 1 });
    expect((await e.sched.claim('task-1', 'engineer')).stage).toMatchObject({ position: 0, role: 'engineer' });
  });

  it('a producer result with a verdict is rejected at record (rules by contract, not role name)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const r = await stageIn(e, 'task-1', 'researcher', ['docs/research/notes.md'], { verdict: 'approve' });
    expect(r.r).toMatchObject({ valid: false });
    expect(r.r.errors!.join()).toMatch(/only reviewer \(gate\) results carry a verdict/);
  });
});

describe('edit scope enforced at record (D3)', () => {
  it('a path-limited role is refused for a change outside edits.paths, with one correction allowed', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const brief = await e.sched.claim('task-1', 'researcher');
    expect(brief.editScope).toEqual({ edits: { paths: ['docs/research/**'] }, commits: true });
    mkdirCommit(brief.worktree, 'docs/research/notes.md');
    const head = mkdirCommit(brief.worktree, 'src/app.ts');
    const r1 = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: ['docs/research/notes.md'] }));
    expect(r1).toMatchObject({ valid: false, correctionAllowed: true });
    expect(r1.errors!.join()).toMatch(/edits: role researcher may only change docs\/research\/\*\*; the stage changed src\/app\.ts outside that scope/);
    expect(e.db.events('task-1', 'invalid-result')).toHaveLength(1);
    // the correction is still out of scope (the commit is in the stage history): unvalidated, nothing approved, task restored
    const r2 = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }), { correction: true });
    expect(r2).toMatchObject({ valid: false, correctionAllowed: false, unvalidated: true, approved: false });
    expect(e.backlog.status('task-1')).toBe('ready');
  });

  it('a correction whose new commits revert the out-of-scope change is accepted (the net stage diff claim head → result head counts)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const brief = await e.sched.claim('task-1', 'researcher');
    mkdirCommit(brief.worktree, 'docs/research/notes.md');
    const bad = mkdirCommit(brief.worktree, 'src/app.ts');
    expect((await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: bad }))).valid).toBe(false);
    gitSync(brief.worktree, 'rm', '-q', 'src/app.ts');
    gitSync(brief.worktree, 'commit', '-q', '-m', 'revert out-of-scope file');
    const fixed = gitSync(brief.worktree, 'rev-parse', 'HEAD');
    // Net diff claim head → result head is back in scope: accepted.
    const r = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: fixed, modifiedPaths: ['docs/research/notes.md'] }), { correction: true });
    expect(r).toMatchObject({ valid: true, to: 'implementing' });
    expect(e.db.taskStage('task-1')!.position).toBe(1);
  });

  it('moving a file out of scope (rename) is a change outside the scope', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    const brief = await e.sched.claim('task-1', 'researcher');
    gitSync(brief.worktree, 'mv', 'README.md', 'docs-readme.md');
    gitSync(brief.worktree, 'commit', '-q', '-m', 'move');
    const head = gitSync(brief.worktree, 'rev-parse', 'HEAD');
    const r = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head, modifiedPaths: [] }));
    expect(r.valid).toBe(false);
    expect(r.errors!.join()).toMatch(/README\.md/);
    expect(r.errors!.join()).toMatch(/docs-readme\.md/);
  });

  it('a read-only role (edits none) that commits anything is refused', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'analysis' });
    const brief = await e.sched.claim('task-1', 'analyst');
    expect(brief.editScope).toEqual({ edits: 'none', commits: false });
    expect(brief.publication['git.commit']).toBe('deny');
    expect(brief.policy).toMatchObject({ codeEdit: 'deny', gitCommit: 'deny' });
    expect(brief.resultContract).toMatch(/you do not commit/);
    const head = commitFile(brief.worktree, 'notes.md', 'x');
    const r = await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }));
    expect(r).toMatchObject({ valid: false, correctionAllowed: true });
    expect(r.errors!.join()).toMatch(/edits: role analyst does not commit, but agent\/.* moved from [0-9a-f]{40} to [0-9a-f]{40}/);
  });

  it('a read-only role that leaves the head alone is accepted and the workflow moves on', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'analysis' });
    const r = await stage(e, 'task-1', 'analyst', [], { modifiedPaths: [] });
    expect(r.r).toMatchObject({ valid: true, to: 'implementing' });
    expect(e.db.taskStage('task-1')!.position).toBe(1);
    const eng = await stage(e, 'task-1', 'engineer', ['x.ts']);
    expect(eng.brief.stage).toMatchObject({ workflow: 'analysis', position: 1, role: 'engineer' });
    expect(eng.r).toMatchObject({ valid: true, to: 'reviewing' });
  });

  it('built-in engineer and tester stay unrestricted', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    const eng = await stageIn(e, 'task-1', 'engineer', ['src/a.ts', 'docs/b.md', 'README.md']);
    expect(eng.r).toMatchObject({ valid: true });
  });
});

describe('requires checked at claim (D8)', () => {
  it('deny: POLICY_DENIED naming the capability, no lease created, the event recorded', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'fetch' });
    e.config.capabilities['network.use'] = 'deny';
    const x = await err(e.sched.claim('task-1', 'fetcher'));
    expect(x.code).toBe('POLICY_DENIED');
    expect(x.message).toMatch(/requires network\.use, which is denied for role fetcher/);
    expect(x.details).toMatchObject({ capability: 'network.use', effect: 'deny' });
    expect(e.db.activeLeases()).toHaveLength(0);
    expect(e.backlog.status('task-1')).toBe('ready');
    expect(e.db.events('task-1', 'stage-refused')).toHaveLength(1);
  });

  it('ask: refused with awaiting-human guidance', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'fetch' });
    const x = await err(e.sched.claim('task-1', 'fetcher'));
    expect(x.code).toBe('POLICY_DENIED');
    expect(x.message).toMatch(/requires network\.use, which needs human approval \("ask"\)/);
    expect(x.hint).toMatch(/--status awaiting-human/);
    expect(x.details).toMatchObject({ capability: 'network.use', effect: 'ask', awaitingHuman: true });
    expect(e.db.activeLeases()).toHaveLength(0);
  });

  it('allow: the stage is claimable', async () => {
    const e = makeDefaultEnv((c) => { withRoles(c); (c as { roles: Record<string, unknown> }).roles.fetcher = { ...ROLES.fetcher, capabilities: {} }; });
    e.backlog.add({ id: 'task-1', workflow: 'fetch' });
    expect((await e.sched.claim('task-1', 'fetcher')).stage).toMatchObject({ role: 'fetcher', position: 0 });
  });
});

describe('end-to-end: researcher → writer → reviewer', () => {
  it('runs the research workflow to delivery; the researcher commits only docs/research/**', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    // researcher: an out-of-scope commit is refused, then a clean stage on a fresh claim
    const bad = await e.sched.claim('task-1', 'researcher');
    expect(bad.stage).toEqual({ workflow: 'research', position: 0, count: 3, role: 'researcher' });
    expect(bad.resultContract).toBe(resultContractText('producer'));
    const badHead = mkdirCommit(bad.worktree, 'docs/guide.md');
    expect((await e.sched.record(bad.leaseId, result({ branch: bad.branch, headSha: badHead }))).errors!.join()).toMatch(/docs\/guide\.md outside that scope/);
    await e.sched.release(bad.leaseId, 'out of scope');
    expect(e.backlog.status('task-1')).toBe('ready');
    gitSync(bad.worktree, 'reset', '-q', '--hard', bad.expectedHead);

    const research = await stageIn(e, 'task-1', 'researcher', ['docs/research/notes.md']);
    expect(research.r).toMatchObject({ valid: true, from: 'implementing', to: 'implementing' });
    expect(e.db.taskStage('task-1')!.position).toBe(1);

    const writer = await stageIn(e, 'task-1', 'writer', ['docs/guide.md']);
    expect(writer.brief.stage).toMatchObject({ position: 1, role: 'writer' });
    expect(writer.brief.expectedHead).toBe(research.head);
    expect(writer.brief.editScope).toEqual({ edits: { paths: ['docs/**'] }, commits: true });
    expect(writer.r).toMatchObject({ valid: true, to: 'reviewing' });

    const rev = await e.sched.claim('task-1', 'reviewer');
    expect(rev.stage).toMatchObject({ position: 2, role: 'reviewer' });
    expect(rev.expectedHead).toBe(writer.head);
    const done = await e.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: rev.expectedHead, verdict: 'approve', modifiedPaths: [] }));
    expect(done).toMatchObject({ valid: true, approved: true, to: 'delivered' });
    // evidence by role at each head
    expect(e.db.evidenceFor('task-1', research.head).some((x) => x.kind === 'researcher' && x.outcome === 'complete')).toBe(true);
    expect(e.db.evidenceFor('task-1', writer.head).some((x) => x.kind === 'reviewer' && x.outcome === 'complete')).toBe(true);
  });

  it('a reviewer request-changes repairs to the nearest committing producer (the writer)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    await stageIn(e, 'task-1', 'researcher', ['docs/research/notes.md']);
    await stageIn(e, 'task-1', 'writer', ['docs/guide.md']);
    const rv = await stage(e, 'task-1', 'reviewer', [], { status: 'needs_changes', verdict: 'request-changes', modifiedPaths: [] });
    expect(rv.r).toMatchObject({ to: 'changes-requested', repairCycles: 1 });
    expect(e.db.taskStage('task-1')!.position).toBe(1);
    const again = await stageIn(e, 'task-1', 'writer', ['docs/guide2.md']);
    expect(again.brief.stage).toMatchObject({ position: 1, role: 'writer' });
    expect(again.r).toMatchObject({ valid: true, from: 'implementing', to: 'reviewing' });
  });

  it('a released later producer keeps its stage claimable', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1', workflow: 'research' });
    await stageIn(e, 'task-1', 'researcher', ['docs/research/notes.md']);
    const w = await e.sched.claim('task-1', 'writer');
    expect((await e.sched.release(w.leaseId, 'retry')).status).toBe('implementing');
    expect((await e.sched.claim('task-1', 'writer')).stage).toMatchObject({ position: 1 });
  });
});

describe('end-to-end: engineer → deploy-engineer under the default deploy.execute deny', () => {
  it('stops at the deploy stage with POLICY_DENIED; the role column cannot lift the base deny', async () => {
    const e = env();
    expect(e.config.capabilities['deploy.execute']).toBe('deny');
    e.backlog.add({ id: 'task-1', workflow: 'deploy' });
    const eng = await stage(e, 'task-1', 'engineer', ['a.txt']);
    expect(eng.r).toMatchObject({ valid: true, to: 'reviewing' });
    const rv = await stage(e, 'task-1', 'reviewer', [], { verdict: 'approve', modifiedPaths: [] });
    // approval is not delivery: the deploy stage is next
    expect(rv.r).toMatchObject({ valid: true, approved: false, to: 'implementing' });
    expect(e.db.taskStage('task-1')!.position).toBe(2);
    const x = await err(e.sched.claim('task-1', 'deploy-engineer'));
    expect(x.code).toBe('POLICY_DENIED');
    expect(x.message).toMatch(/the deploy-engineer stage requires deploy\.execute, which is denied for role deploy-engineer/);
    expect(x.hint).toMatch(/stops at this stage/);
    // the task stays at the deploy stage, nothing delivered, other roles refused
    expect(e.backlog.status('task-1')).toBe('implementing');
    expect(e.db.taskStage('task-1')!.position).toBe(2);
    expect(e.db.activeLeases()).toHaveLength(0);
    expect((await err(e.sched.claim('task-1', 'engineer'))).code).toBe('PRECONDITION');
    expect(e.db.events('task-1', 'stage-refused')).toEqual([expect.objectContaining({ data: expect.objectContaining({ capability: 'deploy.execute', effect: 'deny' }) })]);
  });
});

describe('workflow assigned between stages: evidence-at-head reset (33.3 review nit)', () => {
  it('a verifier added mid-flight to a task already in reviewing runs before the reviewer', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    const eng = await stage(e, 'task-1', 'engineer', ['a.txt']);
    expect(eng.r).toMatchObject({ to: 'reviewing' });
    const t = e.backlog.tasks.get('task-1')!;
    await e.backlog.updateTask('task-1', t.version, { workflow: 'checked' });
    const x = await err(e.sched.claim('task-1', 'reviewer'));
    expect(x.code).toBe('PRECONDITION');
    expect(x.message).toMatch(/The current stage is checker \(workflow checked, stage 2\/3\)/);
    expect(e.backlog.status('task-1')).toBe('testing');
    expect(e.db.events('task-1', 'workflow-reset')).toEqual([expect.objectContaining({
      data: expect.objectContaining({ from: 'default', to: 'checked', position: 1, role: 'checker', fromStatus: 'reviewing', status: 'testing', head: eng.head }),
    })]);
    const chk = await stage(e, 'task-1', 'checker', [], { modifiedPaths: [] });
    expect(chk.brief.stage).toMatchObject({ workflow: 'checked', position: 1, role: 'checker' });
    expect(chk.r).toMatchObject({ valid: true, to: 'reviewing' });
    const rv = await stage(e, 'task-1', 'reviewer', [], { verdict: 'approve', modifiedPaths: [] });
    expect(rv.r).toMatchObject({ approved: true, to: 'delivered' });
  });

  it('a new first producer without evidence at the head resets to position 0 (changes-requested)', async () => {
    const e = env();
    e.backlog.add({ id: 'task-1' });
    await stage(e, 'task-1', 'engineer', ['a.txt']);
    const t = e.backlog.tasks.get('task-1')!;
    await e.backlog.updateTask('task-1', t.version, { workflow: 'analysis' });
    const b = await e.sched.claim('task-1', 'analyst');
    expect(b.stage).toMatchObject({ workflow: 'analysis', position: 0 });
    expect(e.backlog.status('task-1')).toBe('implementing');
    expect(e.db.events('task-1', 'workflow-reset')[0]!.data).toMatchObject({ status: 'changes-requested', position: 0 });
  });
});

