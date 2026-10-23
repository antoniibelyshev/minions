// task-14.11: harness phase rules hardening (task-14.2 review follow-ups; docs/design/agent-runtimes.md D8, D9).
// (1) gates on a process harness are read-only, and harnesses.default moving a gate is visible in `work next`;
// (2) the lease records its harness at claim and the phase 1 producer cap counts by it;
// (3) a process role without its harnesses.<id> block makes one `work next` entry stuck, not the whole command fail.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_RULES } from '../../src/config/harnesses.js';
import { validateConfig } from '../../src/config/resolve.js';
import { defaultMovedGates, harnessConfigIssues } from '../../src/config/roles.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { humanNext } from '../../src/runtime/commands.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { Scheduler, leaseHarness } from '../../src/runtime/scheduler.js';
import { defaults } from '../helpers.js';
import { commitFile, makeDefaultEnv, result, tmp, type Env } from './fixtures.js';

const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol', 'gpt-6.1-mini'] } };
const gate = (over: Record<string, unknown> = {}) => ({ description: 'Second-opinion review.', promptText: 'Review the head.', contract: 'gate', ...over });
const producer = (over: Record<string, unknown> = {}) => ({ description: 'Makes things.', promptText: 'Make.', contract: 'producer', edits: 'any', ...over });

const cfgWith = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...defaults(), ...patch });
const raw = (patch: Record<string, unknown>): MinionsConfig => cfgWith(patch) as unknown as MinionsConfig;
function issues(patch: Record<string, unknown>): { path: string; message: string }[] {
  try { validateConfig(cfgWith(patch), 'test'); } catch (e) {
    if (e instanceof MinionsError) return (e.details as { issues: { path: string; message: string }[] }).issues;
    throw e;
  }
  return [];
}
const paths = (patch: Record<string, unknown>) => issues(patch).map((i) => i.path);

const set = (c: MinionsConfig, patch: Record<string, unknown>) => Object.assign(c as unknown as Record<string, unknown>, structuredClone(patch));
const schedWith = (e: Env, config: MinionsConfig, phase = PHASE_RULES['1a']) => new Scheduler({ db: e.db, backlog: e.backlog, config, layout: e.layout, phase });
const cloneCfg = (c: MinionsConfig, patch: Record<string, unknown>): MinionsConfig => { const out = structuredClone(c); set(out, patch); return out; };
async function engineerStage(e: Env, id: string) {
  const brief = await e.sched.claim(id, 'engineer');
  mkdirSync(dirname(join(brief.worktree, 'a.txt')), { recursive: true });
  const head = commitFile(brief.worktree, 'a.txt', `x ${Math.random()}`);
  await e.sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }));
  return brief;
}

describe('(1) a gate on a process harness is read-only (validateConfig)', () => {
  const h = { codex: CODEX };

  it('refuses a branch worktree, edits and commits for a gate with its own process harness', () => {
    const got = issues({ harnesses: h, roles: { judge: gate({ harness: 'codex', worktree: 'branch', edits: 'any' }) } });
    expect(got.map((i) => i.path)).toEqual(['roles.judge.worktree', 'roles.judge.edits', 'roles.judge.commits']);
    expect(got[0]!.message).toMatch(/roles\.judge\.harness puts the gate role judge on harness codex; a gate on a process harness is read-only: its worktree must be "review"/);
    // Commits default from edits; an explicit commits: false still leaves the edits and the worktree refused.
    expect(paths({ harnesses: h, roles: { judge: gate({ harness: 'codex', worktree: 'branch', edits: { paths: ['docs/**'] }, commits: false }) } }))
      .toEqual(['roles.judge.worktree', 'roles.judge.edits']);
    // A branch worktree alone (no edits, no commits) is still refused: nothing is fetched back from a process gate.
    expect(paths({ harnesses: h, roles: { judge: gate({ harness: 'codex', worktree: 'branch' }) } })).toEqual(['roles.judge.worktree']);
  });

  it('refuses the same when harnesses.default moves the gate, and says so', () => {
    const got = issues({ harnesses: { default: 'codex', ...h }, roles: { judge: gate({ worktree: 'branch', edits: 'any' }) } });
    expect(got.map((i) => i.path)).toEqual(['roles.judge.worktree', 'roles.judge.edits', 'roles.judge.commits']);
    expect(got[1]!.message).toMatch(/^harnesses\.default puts the gate role judge on harness codex; .*edits must be "none" \(or set roles\.judge\.harness to claude\)/);
    // Pinning the gate to claude keeps the writable gate valid under the codex default.
    expect(paths({ harnesses: { default: 'codex', ...h }, roles: { judge: gate({ harness: 'claude', worktree: 'branch', edits: 'any' }) } })).toEqual([]);
  });

  it('a read-only gate on a process harness stays valid; Claude-only configs are unchanged', () => {
    expect(paths({ harnesses: h, roles: { 'codex-reviewer': gate({ harness: 'codex' }) } })).toEqual([]);
    expect(paths({ harnesses: h, roles: { judge: gate({ harness: 'codex', worktree: 'review' }) } })).toEqual([]);
    expect(paths({ roles: { judge: gate({ worktree: 'branch', edits: 'any' }) } })).toEqual([]);
    expect(paths({ harnesses: h, roles: { judge: gate({ worktree: 'branch', edits: 'any' }) } })).toEqual([]);
  });

  it('follows the phase passed in: phase 2 puts the built-in reviewer (read-only) on the default without an issue', () => {
    const c = raw({ harnesses: { default: 'codex', ...h }, roles: { judge: gate({ worktree: 'branch', edits: 'any' }) } });
    expect(harnessConfigIssues(c, PHASE_RULES['2']).map((i) => i.path)).toEqual(['roles.judge.worktree', 'roles.judge.edits', 'roles.judge.commits']);
    const ok = raw({ harnesses: { default: 'codex', ...h } });
    expect(harnessConfigIssues(ok, PHASE_RULES['2'])).toEqual([]);
    expect(defaultMovedGates(ok, PHASE_RULES['2'])).toEqual([{ role: 'reviewer', harness: 'codex' }]);
    expect(defaultMovedGates(ok, PHASE_RULES['1b'])).toEqual([]);
  });

  it('defaultMovedGates lists only gates the default moved (not explicit ones, not Claude-only configs)', () => {
    expect(defaultMovedGates(raw({}))).toEqual([]);
    expect(defaultMovedGates(raw({ roles: { judge: gate() } }))).toEqual([]);
    expect(defaultMovedGates(raw({ harnesses: h, roles: { judge: gate({ harness: 'codex' }) } }))).toEqual([]);
    expect(defaultMovedGates(raw({ harnesses: { default: 'codex', ...h }, roles: { judge: gate(), pinned: gate({ harness: 'claude' }), maker: producer() } })))
      .toEqual([{ role: 'judge', harness: 'codex' }]);
  });
});

describe('(1) work next warns when harnesses.default moves a gate', () => {
  it('lists a warning (JSON and human output) for the moved gate', async () => {
    const e = makeDefaultEnv((c) => set(c, { harnesses: { default: 'codex', codex: CODEX }, roles: { judge: gate() } }));
    e.backlog.add({ id: 'task-1' });
    const n = await e.sched.next();
    expect(n.warnings).toEqual([expect.stringMatching(/^harnesses\.default moves the gate role judge onto OpenAI Codex CLI \(harness codex\); set roles\.judge\.harness to claude/)]);
    expect(humanNext(n)).toMatch(/\nwarning: harnesses\.default moves the gate role judge/);
    expect(n.runnable.map((r) => r.taskId)).toEqual(['task-1']);
  });

  it('a Claude-only config (or an explicit gate harness) has no warnings key', async () => {
    const e = makeDefaultEnv((c) => set(c, { roles: { judge: gate() } }));
    e.backlog.add({ id: 'task-1' });
    const n = await e.sched.next();
    expect(n).not.toHaveProperty('warnings');
    expect(humanNext(n)).not.toMatch(/warning:/);
    const p = makeDefaultEnv((c) => set(c, { harnesses: { codex: CODEX }, roles: { judge: gate({ harness: 'codex' }) } }));
    expect(await p.sched.next()).not.toHaveProperty('warnings');
  });
});

describe('(2) the lease records its harness at claim; the producer cap counts by it', () => {
  const engineerOnCodex = { harnesses: { codex: CODEX }, roles: { engineer: { harness: 'codex' } } };

  it('claim stores the harness: claude for a Claude role, the process harness otherwise', async () => {
    const e = makeDefaultEnv((c) => set(c, { harnesses: { codex: CODEX }, roles: { 'codex-reviewer': gate({ harness: 'codex' }) }, workflows: { pilot: ['engineer', 'codex-reviewer'] } }));
    e.backlog.add({ id: 'task-1', workflow: 'pilot' });
    const eng = await engineerStage(e, 'task-1');
    expect(e.db.lease(eng.leaseId)!.harness).toBe('claude');
    const rev = await e.sched.claim('task-1');
    expect(e.db.lease(rev.leaseId)).toMatchObject({ role: 'codex-reviewer', harness: 'codex' });
  });

  it('a lease claimed on a process harness keeps counting after the config moves its role back to claude', async () => {
    const e = makeDefaultEnv((c) => set(c, engineerOnCodex));
    const a = schedWith(e, e.config);
    e.backlog.add({ id: 'task-1' });
    const brief = await a.claim('task-1');
    expect(e.db.lease(brief.leaseId)!.harness).toBe('codex');
    // Later config: the engineer is back on claude; a project producer runs on codex.
    const later = cloneCfg(e.config, { roles: { maker: producer({ harness: 'codex' }) }, workflows: { make: ['maker', 'reviewer'] } });
    e.backlog.add({ id: 'task-3', workflow: 'make' });
    const b = schedWith(e, later);
    const n = await b.next();
    expect(n.runnable).toEqual([]);
    expect(n.waiting).toEqual([expect.objectContaining({ taskId: 'task-3', role: 'maker', waitingOn: 'harness-capacity', why: expect.stringMatching(/\(1\/1/) })]);
    const x = await b.claim('task-3').then(() => null, (err: MinionsError) => err);
    expect(x?.code).toBe('CAPACITY');
    expect(x?.message).toMatch(/Process-harness producer cap reached \(1\/1/);
  });

  it('a lease claimed on claude does not count after the config moves its role onto a process harness', async () => {
    const e = makeDefaultEnv();
    e.backlog.add({ id: 'task-1', priority: 'high' });
    e.backlog.add({ id: 'task-2' });
    const brief = await e.sched.claim('task-1');
    expect(e.db.lease(brief.leaseId)!.harness).toBe('claude');
    const b = schedWith(e, cloneCfg(e.config, engineerOnCodex));
    const n = await b.next();
    expect(n.runnable).toEqual([expect.objectContaining({ taskId: 'task-2', harness: 'codex' })]);
    expect(n.waiting).toEqual([]);
    expect((await b.claim('task-2')).harness).toBe('codex');
  });

  it('a lease from before schema 7 (no harness) counts as claude', async () => {
    const e = makeDefaultEnv((c) => set(c, engineerOnCodex));
    e.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, branch, config_revision, started_at, status)
      VALUES ('lease-old', 'task-9', 'engineer', 1, 'test', 'agent/task-9', ?, '2026-01-01T00:00:00Z', 'active')`, e.config.configRevision);
    expect(e.db.lease('lease-old')!.harness).toBeNull();
    expect(leaseHarness(e.db.lease('lease-old')!)).toBe('claude');
    expect(leaseHarness({ harness: 'not-a-harness' })).toBe('claude');
    e.backlog.add({ id: 'task-1' });
    const b = schedWith(e, e.config);
    expect((await b.next()).runnable).toEqual([expect.objectContaining({ taskId: 'task-1', harness: 'codex' })]);
    expect((await b.claim('task-1')).harness).toBe('codex');
  });
});

describe('(3) work next degrades per entry for a missing harnesses.<id> block', () => {
  it('lists the stage of a process role without its block as stuck and the other stages normally', async () => {
    // Validation skipped: judge names codex, but there is no harnesses.codex block.
    const e = makeDefaultEnv((c) => set(c, { roles: { judge: gate({ harness: 'codex' }) }, workflows: { pilot: ['engineer', 'judge'] } }));
    e.backlog.add({ id: 'task-1', workflow: 'pilot', priority: 'high' });
    e.backlog.add({ id: 'task-2' });
    await engineerStage(e, 'task-1');
    const n = await e.sched.next();
    expect(n.stuck).toEqual([{ taskId: 'task-1', status: 'reviewing', reason: expect.stringMatching(/role judge runs on harness codex, which has no harnesses\.codex block/) }]);
    expect(n.runnable.map((r) => `${r.taskId} ${r.role}`)).toEqual(['task-2 engineer']);
    expect(humanNext(n)).toMatch(/stuck:\n {2}task-1 \(reviewing\): role judge runs on harness codex/);
  });

  it('a QA sweep whose tester sits on a process harness without a block is stuck too (phase 2)', async () => {
    const e = makeDefaultEnv((c) => set(c, { roles: { tester: { harness: 'codex' } } }));
    const b = schedWith(e, e.config, PHASE_RULES['2']);
    e.backlog.add({ id: 'task-1', labels: ['qa-sweep'] });
    e.backlog.add({ id: 'task-2' });
    const n = await b.next();
    expect(n.stuck).toEqual([expect.objectContaining({ taskId: 'task-1', reason: expect.stringMatching(/role tester runs on harness codex/) })]);
    expect(n.runnable.map((r) => r.taskId)).toEqual(['task-2']);
  });
});

describe('(2) migration 7: leases.harness', () => {
  it('adds the column to a populated v6 database; existing leases keep NULL (claude); reopening is idempotent', () => {
    const path = join(tmp('minions-mig7-'), 'minions.db');
    const v6 = new RuntimeDb(path);
    v6.exec('ALTER TABLE leases DROP COLUMN harness');
    v6.setMeta('schema_version', '6');
    v6.exec("INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('lease-a', 'task-1', 'engineer', 1, 3, '2026-10-23T00:00:00Z', 'active')");
    v6.close();
    expect(SCHEMA_VERSION).toBe(7);
    for (const round of [1, 2]) {
      const db = new RuntimeDb(path);
      try {
        expect(db.getMeta('schema_version')).toBe('7');
        const [l] = db.activeLeases();
        expect(l).toMatchObject({ id: 'lease-a', harness: round === 1 ? null : 'codex' });
        expect(leaseHarness(l!)).toBe(round === 1 ? 'claude' : 'codex');
        if (round === 1) db.exec("UPDATE leases SET harness = 'codex' WHERE id = 'lease-a'");
      } finally { db.close(); }
    }
  });
});
