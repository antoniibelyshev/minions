// QA for task-82.3 (docs/design/local-auto-integration.md phase 3): whole loops through the scheduler and the
// integrator that local-integration.test.ts checks one step at a time: a conflict repaired by the engineer and
// landed on the second approval, a transient failure retried with `work publish`, a settle for a superseded head
// and base.merge turned to deny while a head waits.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { verifyAnyApproval } from '../../src/core/approval.js';
import { integrationRows, runIntegrator, type IntegratorDeps } from '../../src/runtime/integrator.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
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

/** tester → reviewer approve at `head` (the engineer stage already recorded it). */
async function testAndApprove(env: Env, id: string, head: string, files: string[]) {
  const t = await env.sched.claim(id, 'tester');
  await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head, modifiedPaths: files }));
  const rev = await env.sched.claim(id, 'reviewer');
  return env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve', modifiedPaths: files }));
}

async function approveTask(env: Env, id: string, file = `${id}.txt`, content = `work ${Math.random()}`) {
  const eng = await env.sched.claim(id, 'engineer');
  mkdirSync(dirname(join(eng.worktree, file)), { recursive: true });
  const head = commitFile(eng.worktree, file, content);
  await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head, modifiedPaths: [file] }));
  const r = await testAndApprove(env, id, head, [file]);
  return { r, head, branch: eng.branch, worktree: eng.worktree };
}

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

describe('local integration: whole loops (QA)', () => {
  it('conflict → engineer repair (merges main) → re-approval queues the new head → landed → done', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Conflicting then repaired' });
    const first = await approveTask(env, 'task-1', 'shared.txt', 'from the branch\n');
    const B = commitFile(env.layout.repo, 'shared.txt', 'from main\n');
    await integrate(env);
    expect((await env.backlog.getTask('task-1')).status).toBe('changes-requested');
    expect(env.db.repairCycles('task-1')).toBe(1);

    // The repair stage is the engineer; its brief carries the integrator finding.
    const next = await env.sched.next();
    expect(next.runnable.map((c) => [c.taskId, c.role])).toContainEqual(['task-1', 'engineer']);
    const eng = await env.sched.claim('task-1', 'engineer');
    expect(eng.priorFindings.some((f) => f.role === 'integrator')).toBe(true);
    gitSync(eng.worktree, 'merge', '-q', '-X', 'ours', '-m', 'merge main', 'main');
    const repaired = gitSync(eng.worktree, 'rev-parse', 'HEAD');
    expect(repaired).not.toBe(first.head);
    await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: repaired, modifiedPaths: ['shared.txt'] }));
    const r = await testAndApprove(env, 'task-1', repaired, ['shared.txt']);
    expect(r).toMatchObject({ approved: true, to: 'merging', publication: { state: 'queued', headSha: repaired } });
    expect(env.db.publication('task-1')).toMatchObject({ head_sha: repaired, state: 'queued', mode: 'local' });
    expect(integrationRows(env.db, 'task-1').map((x) => [x.phase, x.head_sha])).toEqual([['conflict', first.head], ['queued', repaired]]);
    expect(env.starts).toBe(2);

    await integrate(env);
    expect(contains(env, repaired)).toBe(true);
    expect(contains(env, B)).toBe(true);
    expect((await env.backlog.getTask('task-1')).status).toBe('done');
    expect(env.db.publication('task-1')!.state).toBe('published');
  });

  it('transient failure → blocked; after the cause is fixed, work publish re-queues and lands it', async () => {
    const env = localEnv((c) => { c.verification.setupCommands = ['exit 7']; });
    env.backlog.add({ id: 'task-1', title: 'Transient' });
    const { head } = await approveTask(env, 'task-1');
    const before = mainOf(env);
    await integrate(env);
    expect(mainOf(env)).toBe(before);
    expect((await env.backlog.getTask('task-1')).status).toBe('blocked');
    expect(env.db.publication('task-1')).toMatchObject({ state: 'failed', error_code: 'TRANSIENT' });
    // Transient failures are not repair cycles and do not brief an engineer.
    expect(env.db.repairCycles('task-1')).toBe(0);
    expect(env.backlog.notes.map((n) => n.text).join('\n')).toContain('minions work publish task-1');

    env.config.verification.setupCommands = [];
    expect(await env.sched.publish('task-1')).toMatchObject({ mode: 'local', state: 'queued', status: 'merging' });
    expect(env.starts).toBe(2);
    await integrate(env);
    expect(contains(env, head)).toBe(true);
    expect((await env.backlog.getTask('task-1')).status).toBe('done');
  });

  it('a settle for a head that is no longer the approved head changes nothing', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Stale' });
    const { head } = await approveTask(env, 'task-1');
    const row = integrationRows(env.db, 'task-1')[0]!;
    const out = await env.sched.settleIntegration({ ...row, phase: 'landed', head_sha: 'a'.repeat(40) });
    expect(out.status).toBeNull();
    expect((await env.backlog.getTask('task-1')).status).toBe('merging');
    expect(env.db.publication('task-1')).toMatchObject({ head_sha: head, state: 'queued' });
  });

  it('base.merge turned to deny while the head waits: the task ends delivered and main is untouched', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Policy flip' });
    await approveTask(env, 'task-1');
    const before = mainOf(env);
    env.config.capabilities['base.merge'] = 'deny';
    await integrate(env);
    expect(mainOf(env)).toBe(before);
    expect((await env.backlog.getTask('task-1')).status).toBe('delivered');
    expect(env.db.publication('task-1')).toMatchObject({ state: 'failed', error_code: 'POLICY_DENIED' });
  });
});
