// The local integrator's user-facing surface (task-82.4, docs/design/local-auto-integration.md phase 4): the flaky
// rerun (Decision 2), the status block and the doctor problems (incl. a crash during `git merge --ff-only`), owner
// notices, the digest lines, the backstops, and the merge-approval refusal after a failed integration.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { signApproval, verifyAnyApproval } from '../../src/core/approval.js';
import { integrationDoctorChecks, mergeReadiness } from '../../src/host/doctor.js';
import { composeDigest, digestInput } from '../../src/runtime/digest.js';
import {
  collectIntegrationStatus, humanIntegration, integratorKickDecision, kickInputs, startIntegrationWatch, type KickInputs,
} from '../../src/runtime/integration-status.js';
import { FLAKY_OUTCOME, INTEGRATION_HALT_META, INTEGRATION_LOCK_META, integrationRows, runIntegrator, type IntegratorDeps } from '../../src/runtime/integrator.js';
import { pending } from '../../src/runtime/outbox.js';
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

async function approveTask(env: Env, id: string, file = `${id}.txt`, content = `work ${Math.random()}`) {
  const eng = await env.sched.claim(id, 'engineer');
  mkdirSync(dirname(join(eng.worktree, file)), { recursive: true });
  const head = commitFile(eng.worktree, file, content);
  await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head, modifiedPaths: [file] }));
  const t = await env.sched.claim(id, 'tester');
  await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head, modifiedPaths: [file] }));
  const rev = await env.sched.claim(id, 'reviewer');
  await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve', modifiedPaths: [file] }));
  return { head, branch: eng.branch };
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
const status = (env: LocalEnv) => collectIntegrationStatus({ db: env.db, config: env.config, repo: env.layout.repo, tasks: env.backlog.tasks ? [...env.backlog.tasks.values()] : null });
const DEAD_PID = 4_194_000;

describe('Decision 2: a failed verification command is rerun once', () => {
  it('a pass on the rerun lands the task (done) with a flaky event and an owner notice to file a follow-up', async () => {
    const flag = join(makeEnv().root, 'flaky-flag');
    const env = localEnv((c) => { c.verification.commands = ['true', `if [ -f '${flag}' ]; then exit 0; fi; touch '${flag}'; echo flaky-once; exit 1`]; });
    env.backlog.add({ id: 'task-1', title: 'Flaky' });
    const { head } = await approveTask(env, 'task-1');
    const rep = await integrate(env);
    expect(rep.settled.map((x) => x.phase)).toEqual(['landed']);
    const row = integrationRows(env.db, 'task-1').at(-1)!;
    expect(row.outcome).toBe(FLAKY_OUTCOME);
    expect(row.detail).toMatch(/flaky: `if \[ -f .*` failed once and passed on the rerun/);
    expect((await env.backlog.getTask('task-1')).status).toBe('done');
    gitSync(env.layout.repo, 'merge-base', '--is-ancestor', head, 'main');
    expect(env.db.eventsOfKindSince('integration-flaky', '1970-01-01').map((e) => e.taskId)).toEqual(['task-1']);
    const notes = pending(env.db, { includeWaiting: true });
    expect(notes.find((n) => n.key.startsWith('integration-flaky:task-1:'))?.text).toMatch(/passed only on its rerun \(flaky\).*File a follow-up task/);
    expect(humanIntegration((await status(env))!).join('\n')).toMatch(/last: task-1 landed \(flaky\)/);
  });

  it('two failures are red: main unchanged, changes-requested, and a one-line notice', async () => {
    const env = localEnv((c) => { c.verification.commands = ['echo always-red; exit 2']; });
    env.backlog.add({ id: 'task-1', title: 'Red' });
    await approveTask(env, 'task-1');
    const before = mainOf(env);
    await integrate(env);
    const row = integrationRows(env.db, 'task-1').at(-1)!;
    expect(row.phase).toBe('red');
    expect(row.detail).toMatch(/failed twice: failed again on its rerun \(exit 2\)/);
    expect(mainOf(env)).toBe(before);
    expect((await env.backlog.getTask('task-1')).status).toBe('changes-requested');
    const n = pending(env.db, { includeWaiting: true }).find((x) => x.key.startsWith('integration-red:task-1:'));
    expect(n).toMatchObject({ kind: 'other', taskId: 'task-1' });
    expect(n!.text).toMatch(/integration red .* main is unchanged, task → changes-requested for a repair/);
  });
});

describe('status integration block', () => {
  it('is absent outside local delivery and when local integration was never used', async () => {
    const pr = localEnv((c) => { c.delivery.mode = 'pull-request'; c.delivery.provider = 'github'; });
    expect(await status(pr)).toBeNull();
    const off = localEnv((c) => { c.delivery.merge = 'disabled'; });
    expect(await status(off)).toBeNull();
  });

  it('shows the queue with waiting reasons, an awaiting approval, the last result and the base', async () => {
    const env = localEnv((c) => { c.sensitivePaths = ['secret/**']; });
    env.backlog.add({ id: 'task-1', title: 'Sensitive' });
    env.backlog.add({ id: 'task-2', title: 'Base' });
    env.backlog.add({ id: 'task-3', title: 'Dependent', dependencies: ['task-2'] });
    const s1 = await approveTask(env, 'task-1', 'secret/key.txt');
    await integrate(env);
    expect((await env.backlog.getTask('task-1')).status).toBe('awaiting-human');
    await approveTask(env, 'task-2');
    // task-3 is approved but its dependency is not on main yet: queued behind it (dependency wait).
    env.db.exec("UPDATE integrations SET queued_at = '2000-01-01T00:00:00.000Z' WHERE task_id = 'task-2'");
    await env.backlog.updateTask('task-2', (await env.backlog.getTask('task-2')).version, { status: 'merging' });
    const fakeHead = 'a'.repeat(40);
    env.db.exec("INSERT INTO integrations (task_id, branch, head_sha, phase, attempt, queued_at) VALUES ('task-3', 'agent/task-3', ?, 'queued', 0, '2001-01-01T00:00:00.000Z')", fakeHead);
    const s = (await status(env))!;
    expect(s.enabled).toBe(true);
    expect(s.queue.map((q) => [q.taskId, q.waiting])).toEqual([['task-2', null], ['task-3', 'dependency task-2 (merging)']]);
    expect(s.awaitingApproval).toEqual([{ taskId: 'task-1', head: s1.head, detail: expect.stringMatching(/sensitive paths need a signed merge approval/) }]);
    expect(s.last).toMatchObject({ taskId: 'task-1', phase: 'awaiting-approval' });
    expect(s.lock.state).toBe('none');
    expect(s.base).toBe(mainOf(env));
    expect(s.problems).toEqual([]);
    const text = humanIntegration(s).join('\n');
    expect(text).toMatch(/^integration: on; idle; base [0-9a-f]{12}/);
    expect(text).toContain('queue: task-2, task-3 (dependency task-2 (merging))');
    expect(text).toContain(`awaiting approval: task-1 at ${s1.head} (on the host: minions work approve task-1 --head ${s1.head} --merge)`);
    // A pause shows as the waiting reason of every entry.
    env.db.setPaused({ starts: true });
    expect((await status(env))!.queue.every((q) => q.waiting === 'starts paused')).toBe(true);
  });

  it('a running integration shows phase and elapsed time; a dead holder is a stale-lock problem', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Running' });
    await approveTask(env, 'task-1');
    env.db.exec("UPDATE integrations SET phase = 'verifying', attempt = 1, started_at = '2026-10-29T10:00:00.000Z' WHERE task_id = 'task-1'");
    env.db.setMeta(INTEGRATION_LOCK_META, JSON.stringify({ pid: DEAD_PID, start: '1', bootId: null, at: '2026-10-29T10:00:00.000Z' }));
    const s = (await collectIntegrationStatus({ db: env.db, config: env.config, repo: env.layout.repo, now: new Date('2026-10-29T10:03:12.000Z') }))!;
    expect(s.current).toMatchObject({ taskId: 'task-1', phase: 'verifying', attempt: 1, elapsedSeconds: 192 });
    expect(humanIntegration(s).join('\n')).toMatch(/current: task-1 verifying for 3m12s \(attempt 1/);
    expect(s.problems).toEqual([expect.objectContaining({ name: 'integration.lock', status: 'warn', detail: expect.stringMatching(new RegExp(`pid ${DEAD_PID} .* no longer runs \\(task-1 verifying left running\\)`)) })]);
  });

  it('doctor: a crash during git merge --ff-only (row in landing, checkout changed) fails with the checkout --force fix', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'Landing' });
    const { head } = await approveTask(env, 'task-1');
    const B = mainOf(env);
    env.db.exec("UPDATE integrations SET phase = 'landing', attempt = 1, base_sha = ?, candidate_sha = ? WHERE task_id = 'task-1'", B, head);
    env.db.setMeta(INTEGRATION_LOCK_META, JSON.stringify({ pid: DEAD_PID, start: '1', bootId: null, at: '2026-10-29T10:00:00.000Z' }));
    // The partly updated working tree: a tracked file differs from main while main still points at B.
    const tracked = gitSync(env.layout.repo, 'ls-files').split('\n')[0]!;
    writeFileSync(join(env.layout.repo, tracked), 'half-updated by an interrupted fast-forward\n');
    const s = (await status(env))!;
    expect(s.checkout).toMatchObject({ state: 'dirty', paths: [tracked] });
    const crash = s.problems.find((p) => p.name === 'integration.checkout')!;
    expect(crash).toMatchObject({ status: 'fail', detail: expect.stringMatching(new RegExp(`stopped during \`git merge --ff-only\` of task-1 .* while main still points at ${B}`)) });
    expect(crash.hint).toMatch(/save any edits of your own, then run `git checkout --force main`/);
    // The host doctor turns the runtime's status JSON into checks.
    const checks = integrationDoctorChecks({ code: 0, stdout: JSON.stringify({ ok: true, data: { integration: s } }) });
    expect(checks.map((c) => [c.name, c.status])).toEqual([['integration.checkout', 'fail'], ['integration.lock', 'warn']]);
    expect(checks[0]!.hint).toContain('git checkout --force main');
  });

  it('doctor: a halted queue warns with --adopt-base; a healthy block is one ok line; no block, no checks', () => {
    const halted = { enabled: true, lock: { state: 'none' }, queue: [{}], problems: [{ name: 'integration.queue', status: 'warn', detail: 'the integration queue is halted since x: main was reset', hint: 'run `minions work integrate --adopt-base`' }] };
    expect(integrationDoctorChecks({ code: 0, stdout: JSON.stringify({ ok: true, data: { integration: halted } }) })).toEqual([
      { name: 'integration.queue', status: 'warn', detail: expect.stringMatching(/halted/), hint: expect.stringMatching(/--adopt-base/) }]);
    expect(integrationDoctorChecks({ code: 0, stdout: JSON.stringify({ ok: true, data: { integration: { enabled: true, lock: { state: 'live' }, queue: [{}, {}], problems: [] } } }) }))
      .toEqual([{ name: 'integration', status: 'ok', detail: 'local integration on; integrator running; 2 queued' }]);
    expect(integrationDoctorChecks({ code: 0, stdout: JSON.stringify({ ok: true, data: {} }) })).toEqual([]);
    expect(integrationDoctorChecks({ code: 1, stdout: '' })).toEqual([]);
  });

  it('a halt recorded by the integrator is a queue problem in status', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'x' });
    await approveTask(env, 'task-1');
    env.db.setMeta(INTEGRATION_HALT_META, JSON.stringify({ reason: 'main does not descend from the last integrated base', at: '2026-10-29T09:00:00.000Z', base: null, expected: null }));
    const s = (await status(env))!;
    expect(s.queue[0]!.waiting).toBe('queue halted');
    expect(s.problems.map((p) => p.name)).toEqual(['integration.queue']);
  });
});

describe('doctor merge.readiness is mode-aware in local delivery', () => {
  const cfg = (merge: 'disabled' | 'auto-when-eligible', baseMerge: 'allow' | 'ask' | 'deny' = 'allow', commands = ['npm test']) => {
    const c = makeEnv().config;
    return { ...c, delivery: { ...c.delivery, mode: 'local' as const, provider: 'none' as const, merge }, verification: { ...c.verification, commands }, capabilities: { ...c.capabilities, 'base.merge': baseMerge } };
  };
  const gh = { onGitHub: false, credential: null };
  it('ready -> ok (no GitHub needed), not usable -> warn with the reasons, off -> unavailable', () => {
    expect(mergeReadiness(cfg('auto-when-eligible'), gh)).toEqual(['ok', expect.stringMatching(/local integration ready: the runtime merges each approved head, runs the verification \(npm test\)/)]);
    expect(mergeReadiness(cfg('auto-when-eligible', 'ask'), gh)[1]).toMatch(/base\.merge "ask": each landing needs `minions work approve/);
    const warn = mergeReadiness(cfg('auto-when-eligible', 'allow', []), gh);
    expect(warn[0]).toBe('warn');
    expect(warn[1]).toMatch(/local integration enabled but not usable: verification\.commands is empty/);
    expect(mergeReadiness(cfg('auto-when-eligible', 'deny'), gh)[1]).toMatch(/base\.merge is denied by policy/);
    expect(mergeReadiness(cfg('disabled'), gh)[0]).toBe('unavailable');
  });
});

describe('backstops: routine-tick watch and --recover', () => {
  const base: KickInputs = { enabled: true, queued: 1, running: 0, lock: 'none', halted: false, draining: false, startsPaused: false };
  it('starts only with a queued entry (or a dead holder to recover) and no live holder, halt, drain or pause', () => {
    expect(integratorKickDecision(base)).toMatchObject({ start: true });
    expect(integratorKickDecision({ ...base, queued: 0 })).toMatchObject({ start: false, why: 'nothing queued' });
    expect(integratorKickDecision({ ...base, queued: 0, lock: 'stale', running: 1 })).toMatchObject({ start: true, why: expect.stringMatching(/recover/) });
    for (const over of [{ enabled: false }, { lock: 'live' as const }, { halted: true }, { draining: true }, { startsPaused: true }]) {
      expect(integratorKickDecision({ ...base, ...over }).start, JSON.stringify(over)).toBe(false);
    }
  });

  it('kickInputs reads the queue, lock and switch from the runtime state', async () => {
    const env = localEnv();
    env.backlog.add({ id: 'task-1', title: 'x' });
    await approveTask(env, 'task-1');
    expect(kickInputs(env.db, env.config)).toEqual({ enabled: true, queued: 1, running: 0, lock: 'none', halted: false, draining: false, startsPaused: false });
    expect(integratorKickDecision(kickInputs(env.db, { ...env.config, delivery: { ...env.config.delivery, merge: 'disabled' } })).start).toBe(false);
  });

  it('the wrapper watch checks at once and every tick, without a second start inside the grace window', async () => {
    let fire: (() => void) | null = null;
    let now = 0;
    let starts = 0;
    let inputs: KickInputs = base;
    const lines: string[] = [];
    const stop = startIntegrationWatch({ decide: () => inputs, start: () => { starts++; return 42; }, timer: (fn) => { fire = fn; return () => { fire = null; }; }, clock: () => now, say: (l) => lines.push(l) });
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(1);
    expect(lines[0]).toMatch(/started the local integrator \(pid 42\): 1 queued/);
    now = 10_000; fire!(); await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(1);
    now = 61_000; inputs = { ...base, lock: 'live' }; fire!(); await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(1);
    inputs = base; fire!(); await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(2);
    stop();
    expect(fire).toBeNull();
  });
});

describe('digest and merge approval', () => {
  it('lists a pending local merge approval with the merge scope, landings as merged, and integration failures', async () => {
    const env = localEnv((c) => { c.sensitivePaths = ['secret/**']; });
    env.backlog.add({ id: 'task-1', title: 'Sensitive' });
    env.backlog.add({ id: 'task-2', title: 'Lands' });
    env.backlog.add({ id: 'task-3', title: 'Conflicts' });
    const s1 = await approveTask(env, 'task-1', 'secret/a.txt');
    await approveTask(env, 'task-2');
    await integrate(env);
    // task-3 conflicts with a commit on main.
    await approveTask(env, 'task-3', 'shared.txt', 'branch\n');
    commitFile(env.layout.repo, 'shared.txt', 'main\n');
    await integrate(env);
    expect(integrationRows(env.db, 'task-3').at(-1)!.phase).toBe('conflict');
    const now = new Date();
    const d = composeDigest(digestInput(env.db, { routine: {} }, { tasks: [...env.backlog.tasks.values()], runnable: [], spend: null }, now));
    expect(d.text).toContain(`- task-1 Sensitive: merge approval, send in the manager chat: /approve task-1 ${s1.head} merge`);
    expect(d.text).toMatch(/Merged:\n- task-2 Lands/);
    expect(d.text).toMatch(/Integration:\n- task-3 Conflicts: integration conflict, sent back for a repair - merging .* conflicts in: shared\.txt/);
    // The settle hook also queued one-line notices: the approval and the conflict.
    const keys = pending(env.db, { includeWaiting: true }).map((n) => n.key);
    expect(keys).toEqual(expect.arrayContaining([`integration-approval:task-1:${s1.head}`, expect.stringMatching(/^integration-conflict:task-3:/)]));
  });

  it('work approve --merge refuses a failed integration and accepts one waiting for approval', async () => {
    const env = localEnv((c) => { c.verification.commands = ['exit 1']; });
    env.backlog.add({ id: 'task-1', title: 'Red' });
    const { head } = await approveTask(env, 'task-1');
    await integrate(env);
    expect(env.db.publication('task-1')).toMatchObject({ state: 'failed', error_code: 'red' });
    const sig = signApproval(env.keys.privateKeyFile, { taskId: 'task-1', head, scope: 'merge' });
    expect(() => env.sched.approveMerge('task-1', { head, signature: sig })).toThrow(/integration of task-1 at [0-9a-f]{40} failed \(red\): a merge approval cannot land it/);
  });
});
