// task-14.5 (agent-runtimes child task 8, D3b): orphan recovery and launch guards. reapRun from `work release`
// (Scheduler.release with run hooks), coordinator start and restarts (recoverRuns), the owner lock that keeps a
// reaper from racing the live runner, the escapee sweep against a fake /proc tree (no real process is signalled),
// the re-claim gate in `work claim`, restart counting of unfinished runs, and the lease-ended fetch-back false
// positive from the task-14.4 review. Isolation is `none`; never starts a real harness or a Claude session.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_RULES } from '../../src/config/harnesses.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { MinionsError } from '../../src/core/errors.js';
import { scheduleDetachedRestart } from '../../src/runtime/coordinator.js';
import { claimWithBrief } from '../../src/runtime/handoff.js';
import { fakeAdapter } from '../../src/runtime/runner/adapter.js';
import { sweepEscapees } from '../../src/runtime/runner/escapees.js';
import {
  acquireOwner, createRunRecord, hostIdentity, openRunsSync, ownerLockPath, ownerToken, procIdentity, readOwner, readRunRecord, runDir, runRecordPath,
  withOpenRuns, type RunRecord,
} from '../../src/runtime/runner/record.js';
import { reapRun, recoverRuns, runLease, type ReapDeps, type RunnerDeps } from '../../src/runtime/runner/run.js';
import { Scheduler, type TaskBrief } from '../../src/runtime/scheduler.js';
import { gitSync, makeDefaultEnv, type Env } from './fixtures.js';

const SCRIPT = resolve(__dirname, '..', 'fixtures', 'fake-harness.mjs');
const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol'] }, timeoutMinutes: 5 };
const set = (c: MinionsConfig, patch: Record<string, unknown>) => Object.assign(c as unknown as Record<string, unknown>, structuredClone(patch));
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MinionsError; } throw new Error('expected a rejection'); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phase = PHASE_RULES['1a'];

interface Rig extends Env {
  paths: RunnerDeps['paths'];
  deps: (scenario: unknown, over?: Partial<RunnerDeps>) => RunnerDeps;
  reapDeps: (over?: Partial<ReapDeps>) => ReapDeps;
  /** A scheduler without run hooks (the pre-task-14.5 release path). */
  plain: Scheduler;
}

/** The built-in engineer on harness codex; `sched` has the run hooks production wires in (reap before release). */
function rig(): Rig {
  const e = makeDefaultEnv((c) => set(c, { harnesses: { codex: CODEX }, roles: { engineer: { harness: 'codex' } } }));
  const state = join(e.root, 'state');
  const paths = { state, briefs: join(state, 'briefs'), results: join(state, 'results'), scratch: join(e.root, 'scratch'), secretsDir: join(e.root, 'secrets'), drainFlag: join(state, 'run', 'drain') };
  const reapDeps = (over: Partial<ReapDeps> = {}): ReapDeps => ({ db: e.db, paths, env: process.env, escapees: null, waitMs: 10_000, pollMs: 50, ...over });
  e.sched = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, handoff: paths, phase, runs: { state, reap: (id) => reapRun(id, reapDeps()) } });
  const plain = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, handoff: paths, phase });
  const deps = (scenario: unknown, over: Partial<RunnerDeps> = {}): RunnerDeps => ({
    db: e.db, config: e.config, paths, commonDir: join(e.layout.repo, '.git'), adapters: { codex: fakeAdapter({ script: SCRIPT, scenario }) },
    isolation: { kind: 'none' }, phase, callerEnv: {}, callerCwd: e.root, env: process.env,
    timing: { pollMs: 50, killGraceMs: 400, drainGraceMs: 200 }, ...over,
  });
  return { ...e, paths, deps, reapDeps, plain };
}

async function claim(r: Rig, id = 'task-1'): Promise<TaskBrief> {
  if (!r.backlog.tasks.has(id)) r.backlog.add({ id });
  return claimWithBrief(r.sched, r.paths, id, undefined);
}

async function running(r: Rig, b: TaskBrief, steps: unknown[]) {
  const p = runLease(b.leaseId, r.deps({ steps }));
  for (let i = 0; i < 100; i++) {
    const rec = await readRunRecord(r.paths.state, b.leaseId);
    if (rec?.phase === 'running') return { p, rec };
    await sleep(50);
  }
  throw new Error('the run never started');
}

const headOf = (r: Rig, branch: string) => gitSync(r.layout.repo, 'rev-parse', `refs/heads/${branch}`);
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim());

/** Simulates a SIGKILLed runner: the record and its owner lock name a process that is gone. */
function forgeDeadRunner(r: Rig, rec: RunRecord) {
  const runner = { pid: deadPid(), startTime: '1' };
  writeFileSync(runRecordPath(r.paths.state, rec.leaseId), JSON.stringify({ ...rec, runner }));
  const lock = JSON.parse(readFileSync(ownerLockPath(r.paths.state, rec.leaseId), 'utf8')) as Record<string, unknown>;
  writeFileSync(ownerLockPath(r.paths.state, rec.leaseId), JSON.stringify({ ...lock, ...runner }));
}

/** A minimal record that is not done (a crash left it; no processes, no snapshot). */
async function strayRecord(r: Rig, leaseId: string, taskId = 'task-1', patch: Partial<RunRecord> = {}) {
  await createRunRecord(r.paths.state, { version: 1, leaseId, taskId, role: { name: 'engineer', contract: 'producer', commits: true, edits: 'any', harness: 'codex' }, claimHead: r.baseSha, phase: 'running', host: null, runner: null, wrapper: null, pgid: null, leaseGit: null } as unknown as RunRecord);
  if (Object.keys(patch).length) writeFileSync(runRecordPath(r.paths.state, leaseId), JSON.stringify({ ...await readRunRecord(r.paths.state, leaseId), ...patch }));
}

describe('work release reaps the run before the lease ends', () => {
  it('a live runner is cancelled: it checkpoints a wip: commit, and the release response and note name it; the done record is removed', async () => {
    const r = rig();
    const b = await claim(r);
    const { p } = await running(r, b, [{ op: 'write', path: 'half.txt', content: 'half\n' }, { op: 'sleep', ms: 60_000 }]);
    await sleep(200);
    const rel = await r.sched.release(b.leaseId, 'recovered: worker not running');
    const out = await p;
    expect(out).toMatchObject({ exit: { stopped: 'cancel' }, violations: [] });
    const head = headOf(r, b.branch);
    expect(out.wipCommit).toBe(head);
    expect(gitSync(r.layout.repo, 'log', '-1', '--format=%s', head)).toBe('wip: runner checkpoint (cancel: recovery)');
    expect(readFileSync(join(b.worktree, 'half.txt'), 'utf8')).toBe('half\n');
    expect(rel.run).toContain(`work in progress is committed as ${head}`);
    expect(r.backlog.notes.at(-1)?.text).toContain(`Process run: run ended (cancel); work in progress is committed as ${head}.`);
    expect(r.db.lease(b.leaseId)?.status).toBe('released');
    // Done and the lease ended: the record dir and the scratch dir are gone.
    expect(existsSync(runDir(r.paths.state, b.leaseId))).toBe(false);
    expect(existsSync(join(r.paths.scratch, b.leaseId))).toBe(false);
  });

  it('a lost runner: the worker group is killed and post-exit checkpoints before the lease ends; the old runner backs off', async () => {
    const r = rig();
    const b = await claim(r);
    const { p, rec } = await running(r, b, [{ op: 'write', path: 'w.txt', content: 'w\n' }, { op: 'sleep', ms: 60_000 }]);
    await sleep(200);
    forgeDeadRunner(r, rec);
    const rel = await r.sched.release(b.leaseId, 'recovered: worker not running');
    const head = headOf(r, b.branch);
    expect(gitSync(r.layout.repo, 'log', '-1', '--format=%s', head)).toBe('wip: runner checkpoint (recovered: runner lost)');
    expect(rel.run).toBe(`recovered: runner lost; work in progress is committed as ${head}`);
    expect(r.backlog.notes.at(-1)?.text).toContain('recovered: runner lost; work in progress is committed as');
    expect(r.db.events('task-1', 'run-recovered').map((e) => e.data)).toContainEqual(expect.objectContaining({ leaseId: b.leaseId, wipCommit: head }));
    expect(await p).toMatchObject({ submitted: false, error: expect.stringMatching(/taken over by recovery/) });
  });

  it('a failed reap refuses the release: the lease stays active', async () => {
    const r = rig();
    const b = await claim(r);
    const s = new Scheduler({ db: r.db, backlog: r.backlog, config: r.config, layout: r.layout, handoff: r.paths, phase, runs: { state: r.paths.state, reap: async () => { throw new Error('reap failed'); } } });
    await expect(s.release(b.leaseId, 'x')).rejects.toThrow(/reap failed/);
    expect(r.db.lease(b.leaseId)?.status).toBe('active');
  });

  it('a lease without a run (Claude worker) releases as before, with no run note', async () => {
    const r = rig();
    r.config.roles!.engineer = { harness: 'claude' } as never;
    const b = await claim(r);
    const rel = await r.sched.release(b.leaseId, 'x');
    expect(rel.run).toBeUndefined();
    expect(r.backlog.notes.at(-1)?.text).not.toContain('Process run');
  });
});

describe('owner lock: recovery never races the live runner', () => {
  it('a live reaper holding the lock makes a second reap a CONFLICT; a dead holder is taken over', async () => {
    const r = rig();
    const b = await claim(r);
    await strayRecord(r, b.leaseId);
    const host = await hostIdentity();
    const me = (await procIdentity(process.pid))!;
    // The live holder: this test process, as another reaper would be.
    expect(await acquireOwner(r.paths.state, b.leaseId, ownerToken(me, 'reaper', host))).toEqual({ ok: true });
    const e = await err(reapRun(b.leaseId, r.reapDeps({ waitMs: 200 })));
    expect(e.code).toBe('CONFLICT');
    expect((await readRunRecord(r.paths.state, b.leaseId))?.phase).toBe('running');
    // The holder dies: its lock is stale and the reap goes through.
    writeFileSync(ownerLockPath(r.paths.state, b.leaseId), JSON.stringify({ ...ownerToken({ pid: deadPid(), startTime: '1' }, 'reaper', host) }));
    expect((await reapRun(b.leaseId, r.reapDeps())).action).toBe('recovered');
    expect((await readRunRecord(r.paths.state, b.leaseId))?.phase).toBe('done');
    expect(await readOwner(r.paths.state, b.leaseId)).toBeNull();
  });

  it('a lock from another boot is stale even if its pid is alive here', async () => {
    const r = rig();
    const b = await claim(r);
    await strayRecord(r, b.leaseId);
    const me = (await procIdentity(process.pid))!;
    writeFileSync(ownerLockPath(r.paths.state, b.leaseId), JSON.stringify(ownerToken(me, 'runner', { bootId: 'another-boot', containerStart: '1' })));
    expect((await reapRun(b.leaseId, r.reapDeps({ waitMs: 200 }))).action).toBe('recovered');
  });

  it('an unreadable lock fails closed', async () => {
    const r = rig();
    const b = await claim(r);
    await strayRecord(r, b.leaseId);
    writeFileSync(ownerLockPath(r.paths.state, b.leaseId), 'garbage');
    expect((await err(reapRun(b.leaseId, r.reapDeps()))).code).toBe('INTERNAL');
  });

  it('work run refuses to start when it cannot identify itself or its host (recovery could not tell it is alive)', async () => {
    const r = rig();
    const b = await claim(r);
    const empty = join(r.root, 'empty-proc');
    mkdirSync(empty);
    const e = await err(runLease(b.leaseId, r.deps({ steps: [] }, { proc: empty })));
    expect(e.code).toBe('PRECONDITION');
    expect(await readRunRecord(r.paths.state, b.leaseId)).toBeNull();
  });
});

describe('re-claim gate in work claim', () => {
  it('refuses a task while any of its leases has a record that is not done, even after an out-of-order release', async () => {
    const r = rig();
    const b = await claim(r);
    await strayRecord(r, b.leaseId);
    await r.plain.release(b.leaseId, 'released without a reap');
    const e = await err(claim(r));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toMatch(new RegExp(`unfinished process run \\(${b.leaseId}\\)`));
    expect(r.db.activeLeases()).toEqual([]);
    // A restart reaps the orphan; the task can be claimed again and the done record of the ended lease is removed.
    const sweep = await recoverRuns(r.reapDeps(), 'orphans');
    expect(sweep.reaped.map((x) => x.action)).toEqual(['recovered']);
    expect(sweep.removed).toEqual([b.leaseId]);
    expect((await claim(r)).leaseId).not.toBe(b.leaseId);
  });

  it('an unreadable record counts as not done', async () => {
    const r = rig();
    const b = await claim(r);
    await strayRecord(r, b.leaseId);
    writeFileSync(runRecordPath(r.paths.state, b.leaseId), '{not json');
    await r.plain.release(b.leaseId, 'x');
    expect((await err(claim(r))).code).toBe('POLICY_DENIED');
    expect(openRunsSync(r.paths.state)).toEqual([b.leaseId]);
  });

  it('a scheduler release keeps the scratch dir of a run that is not done (recovery still checkpoints its clone)', async () => {
    const r = rig();
    const b = await claim(r);
    const s = new Scheduler({ db: r.db, backlog: r.backlog, config: r.config, layout: r.layout, handoff: r.paths, phase, runs: { state: r.paths.state, reap: async () => ({ note: null }) } });
    await strayRecord(r, b.leaseId);
    mkdirSync(join(r.paths.scratch, b.leaseId, 'work'), { recursive: true });
    await s.release(b.leaseId, 'x');
    expect(existsSync(join(r.paths.scratch, b.leaseId, 'work'))).toBe(true);
    expect(existsSync(runDir(r.paths.state, b.leaseId))).toBe(true);
  });
});

describe('coordinator start and restarts', () => {
  it('coordinator start (scope all) reaps records of active leases too; orphans scope leaves them to their release', async () => {
    const r = rig();
    const b = await claim(r);
    const { p, rec } = await running(r, b, [{ op: 'write', path: 'w.txt', content: 'w\n' }, { op: 'sleep', ms: 60_000 }]);
    await sleep(200);
    forgeDeadRunner(r, rec);
    expect((await recoverRuns(r.reapDeps(), 'orphans')).reaped).toEqual([]);
    const sweep = await recoverRuns(r.reapDeps(), 'all');
    expect(sweep.reaped.map((x) => [x.leaseId, x.action])).toEqual([[b.leaseId, 'recovered']]);
    expect(sweep.removed).toEqual([]); // the lease is still active: its record stays until the release
    expect(gitSync(r.layout.repo, 'log', '-1', '--format=%s', headOf(r, b.branch))).toBe('wip: runner checkpoint (recovered: runner lost)');
    await p;
    // The recover skill then releases it; the note repeats the recovered checkpoint.
    const rel = await r.sched.release(b.leaseId, 'recovered: worker not running');
    expect(rel.run).toMatch(/^recovered: runner lost; work in progress is committed as [0-9a-f]{40}$/);
    expect(existsSync(runDir(r.paths.state, b.leaseId))).toBe(false);
  });

  it('restarts count records that are not done as running workers', async () => {
    const r = rig();
    await strayRecord(r, 'lease-orphan1');
    const workers = withOpenRuns(() => [], r.paths.state);
    expect(workers()).toEqual([{ id: 'lease-orphan1 (unfinished process run)' }]);
    expect(() => scheduleDetachedRestart({ activeLeases: workers, drain: () => null, log: join(r.root, 'log'), cwd: r.root, spawn: () => { throw new Error('must not spawn'); } }, { recover: true }))
      .toThrow(/1 active worker lease\(s\) \(lease-orphan1 \(unfinished process run\)\)/);
    // An active lease's own record is not counted twice.
    expect(withOpenRuns(() => [{ id: 'lease-orphan1' }], r.paths.state)()).toEqual([{ id: 'lease-orphan1' }]);
    // Reaped first (no active lease), nothing is left to count.
    await recoverRuns(r.reapDeps(), 'orphans');
    expect(workers()).toEqual([]);
  });
});

describe('lease ended before post-exit (task-14.4 review false positive)', () => {
  it('a release without a reap removes the clone mid-run: no harness violation, nothing fetched, the record says why', async () => {
    const r = rig();
    const b = await claim(r);
    const p = runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'a.txt' }, { op: 'sleep', ms: 60_000 }] }));
    for (let i = 0; i < 100 && (await readRunRecord(r.paths.state, b.leaseId))?.phase !== 'running'; i++) await sleep(50);
    await sleep(300);
    await r.plain.release(b.leaseId, 'old release path');
    const out = await p;
    expect(out).toMatchObject({ exit: { stopped: 'lease-ended' }, violations: [], submitted: false });
    expect(r.db.events('task-1', 'harness-violation')).toEqual([]);
    expect((await readRunRecord(r.paths.state, b.leaseId))?.outcome).toMatchObject({ violations: [], note: expect.stringMatching(/clone was removed when the lease ended; nothing fetched/) });
    expect(headOf(r, b.branch)).toBe(b.expectedHead);
  });

  it('a reap after the lease ended and the worktree was removed reports no violation either', async () => {
    const r = rig();
    const b = await claim(r);
    const { p, rec } = await running(r, b, [{ op: 'write', path: 'w.txt', content: 'w\n' }, { op: 'sleep', ms: 60_000 }]);
    await sleep(200);
    forgeDeadRunner(r, rec);
    r.db.exec("UPDATE leases SET status = 'released' WHERE id = ?", b.leaseId);
    rmSync(b.worktree, { recursive: true, force: true });
    const reaped = await reapRun(b.leaseId, r.reapDeps());
    expect(reaped.post).toMatchObject({ violations: [], fetched: false, note: expect.stringMatching(/lease worktree was removed/) });
    expect(r.db.events('task-1', 'harness-violation')).toEqual([]);
    await p;
  });
});

// ------------------------------------------------------------------------------------- escapee sweep (fake /proc)

interface FakeProc { pid: number; ppid: number; filters?: number | null; state?: string; start?: string; pgrp?: number }
function fakeProc(root: string, procs: FakeProc[]): string {
  const dir = join(root, 'proc');
  for (const p of procs) {
    mkdirSync(join(dir, String(p.pid)), { recursive: true });
    const rest = [p.state ?? 'S', p.ppid, p.pgrp ?? p.pid, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, p.start ?? '100'];
    writeFileSync(join(dir, String(p.pid), 'stat'), `${p.pid} (x y) ${rest.join(' ')} 0 0\n`);
    writeFileSync(join(dir, String(p.pid), 'status'), `Name:\tx\nPPid:\t${p.ppid}\n${p.filters === null ? '' : `Seccomp:\t2\nSeccomp_filters:\t${p.filters ?? 1}\n`}`);
  }
  mkdirSync(join(dir, 'sys', 'kernel', 'random'), { recursive: true });
  writeFileSync(join(dir, 'sys', 'kernel', 'random', 'boot_id'), 'fake-boot\n');
  writeFileSync(join(dir, 'self-not-a-pid'), '');
  return dir;
}

describe('escapee sweep (Seccomp_filters above the container baseline, injectable /proc)', () => {
  const tree = (root: string) => fakeProc(root, [
    { pid: 1, ppid: 0 },
    { pid: 50, ppid: 1 }, // the sweeper
    { pid: 100, ppid: 50, start: '500' }, // a live wrapper of another run
    { pid: 101, ppid: 100, filters: 2 }, // its sandboxed worker: spared
    { pid: 102, ppid: 101, filters: 3 }, // and that worker's child: spared
    { pid: 200, ppid: 1, filters: 2 }, // escapee reparented to init: killed
    { pid: 201, ppid: 200, filters: 2 }, // its child: killed
    { pid: 300, ppid: 1, filters: 2, state: 'Z' }, // zombie: skipped
    { pid: 400, ppid: 1 }, // unsandboxed process at the baseline: never touched
    { pid: 500, ppid: 1, start: '900' }, // a wrapper whose recorded start time does not match
    { pid: 501, ppid: 500, filters: 2 }, // so its worker counts as unsupervised: killed
  ]);

  it('kills only sandboxed processes whose ancestry reaches no live wrapper, never the sweeper, its ancestors or init', async () => {
    const proc = tree(makeDefaultEnv().root);
    const killed: number[] = [];
    const r = await sweepEscapees({ proc, self: 50, liveWrappers: [{ pid: 100, startTime: '500' }, { pid: 500, startTime: '1' }], kill: (pid) => killed.push(pid) });
    expect(r).toMatchObject({ baseline: 1, skipped: null });
    expect(killed.sort((a, b) => a - b)).toEqual([200, 201, 501]);
  });

  it('the baseline is init\'s count, so a sweeper that is itself sandboxed still sees escapees', async () => {
    const proc = fakeProc(makeDefaultEnv().root, [{ pid: 1, ppid: 0 }, { pid: 60, ppid: 1, filters: 2 }, { pid: 61, ppid: 1, filters: 2 }]);
    const killed: number[] = [];
    await sweepEscapees({ proc, self: 60, liveWrappers: [], kill: (pid) => killed.push(pid) });
    expect(killed).toEqual([61]);
  });

  it('skips (and says so) when Seccomp_filters is unavailable', async () => {
    const proc = fakeProc(makeDefaultEnv().root, [{ pid: 1, ppid: 0, filters: null }, { pid: 50, ppid: 1, filters: null }, { pid: 70, ppid: 1, filters: null }]);
    const killed: number[] = [];
    const r = await sweepEscapees({ proc, self: 50, liveWrappers: [], kill: (pid) => killed.push(pid) });
    expect(r.skipped).toMatch(/Seccomp_filters is not available/);
    expect(killed).toEqual([]);
  });

  it('reapRun sweeps after killing the recorded group (fake /proc for the sweep, real kills only for the recorded processes)', async () => {
    const r = rig();
    const b = await claim(r);
    const { p, rec } = await running(r, b, [{ op: 'sleep', ms: 60_000 }]);
    forgeDeadRunner(r, rec);
    const proc = fakeProc(r.root, [{ pid: 1, ppid: 0 }, { pid: process.pid, ppid: 1 }, { pid: 777, ppid: 1, filters: 2 }]);
    const killed: number[] = [];
    // The fake kill removes the process from the fake tree, as a real SIGKILL would.
    const reaped = await reapRun(b.leaseId, r.reapDeps({ escapees: { proc, kill: (pid) => { killed.push(pid); rmSync(join(proc, String(pid)), { recursive: true }); } } }));
    expect(killed).toEqual([777]);
    expect(reaped).toMatchObject({ action: 'recovered', escapees: { killed: [777], baseline: 1 } });
    expect(reaped.killed).toEqual(expect.arrayContaining([rec.pgid, 777]));
    expect(r.db.events('task-1', 'run-recovered').map((e) => e.data)).toContainEqual(expect.objectContaining({ escapees: [777] }));
    await p;
  });
});
