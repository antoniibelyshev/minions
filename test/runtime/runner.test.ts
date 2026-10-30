// task-14.4: the process runner `minions work run` (docs/design/agent-runtimes.md D3, D3a, D3b) with the fake
// harness against real git repositories. Isolation is `none` here (no minions-sandbox in CI): every post-exit check
// must still catch what L1 would have prevented. Never starts a real harness or a Claude session.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_RULES } from '../../src/config/harnesses.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { MinionsError } from '../../src/core/errors.js';
import { requestDrain } from '../../src/runtime/drain.js';
import { recordSubmitted, submissionPath } from '../../src/runtime/handoff.js';
import { fakeAdapter } from '../../src/runtime/runner/adapter.js';
import { createRunRecord, ownerLockPath, readOwner, readRunRecord, runRecordPath, type RunRecord } from '../../src/runtime/runner/record.js';
import { reapRun, runLease, type RunnerDeps } from '../../src/runtime/runner/run.js';
import type { SuperviseTiming } from '../../src/runtime/runner/supervise.js';
import { Scheduler, type TaskBrief } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, result, type Env } from './fixtures.js';
import { HAS_PROCFS } from '../helpers.js';

const SCRIPT = resolve(__dirname, '..', 'fixtures', 'fake-harness.mjs');
const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol'] }, timeoutMinutes: 5 };
const set = (c: MinionsConfig, patch: Record<string, unknown>) => Object.assign(c as unknown as Record<string, unknown>, structuredClone(patch));
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MinionsError; } throw new Error('expected a rejection'); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig extends Env { paths: RunnerDeps['paths']; deps: (scenario: unknown, over?: Partial<RunnerDeps>) => RunnerDeps; common: string }

/** Phase 1a env: the built-in engineer on harness codex (a producer), with handoff and scratch dirs. */
function rig(mutate?: (c: MinionsConfig) => void, phase = PHASE_RULES['1a']): Rig {
  const e = makeDefaultEnv((c) => { set(c, { harnesses: { codex: CODEX }, roles: { engineer: { harness: 'codex' } } }); mutate?.(c); });
  const state = join(e.root, 'state');
  const paths = { state, briefs: join(state, 'briefs'), results: join(state, 'results'), scratch: join(e.root, 'scratch'), secretsDir: join(e.root, 'secrets'), drainFlag: join(state, 'run', 'drain') };
  e.sched = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, handoff: paths, phase });
  const common = join(e.layout.repo, '.git');
  const deps = (scenario: unknown, over: Partial<RunnerDeps> = {}): RunnerDeps => ({
    db: e.db, config: e.config, paths, commonDir: common, adapters: { codex: fakeAdapter({ script: SCRIPT, scenario }) },
    isolation: { kind: 'none' }, phase, callerEnv: {}, callerCwd: e.root, env: process.env,
    timing: { pollMs: 50, killGraceMs: 400, drainGraceMs: 200 }, ...over,
  });
  return { ...e, paths, deps, common };
}

async function claim(r: Rig, id = 'task-1', role?: string): Promise<TaskBrief> {
  if (!r.backlog.tasks.has(id)) r.backlog.add({ id });
  const { claimWithBrief } = await import('../../src/runtime/handoff.js');
  return claimWithBrief(r.sched, r.paths, id, role);
}

const checkoutOf = (r: Rig, b: TaskBrief) => join(r.paths.scratch, b.leaseId, 'work');
const submitted = (r: Rig, b: TaskBrief) => JSON.parse(readFileSync(submissionPath(r.paths, b.leaseId), 'utf8')) as Record<string, unknown> & { status: string; findings: string[]; headSha: string };
const headOf = (r: Rig, branch: string) => gitSync(r.layout.repo, 'rev-parse', `refs/heads/${branch}`);

/**
 * Timing for the timeout tests whose harness must install signal handlers (or write a file) before the stop.
 * From spawn, a 300-400 ms limit let a node start slowed by a loaded machine get the SIGINT before its handlers
 * (it died of it, task-93), and a fixed 2.5 s limit cost every such test 2.5 s. The limit here starts once the
 * harness wrote `ready` (the timeoutStart seam), so a short one is safe; the stop sequence after it is what the
 * tests assert.
 */
const afterReady = (ready: string, timing: Omit<SuperviseTiming, 'timeoutMs' | 'timeoutStart'>): SuperviseTiming =>
  ({ timeoutMs: 300, timeoutStart: waitForFile(ready), ...timing });

/** Polls until the file exists, up to a deadline; false if it never appears. */
async function waitForFile(path: string, deadlineMs = 20_000): Promise<boolean> {
  for (const until = Date.now() + deadlineMs; Date.now() < until;) { if (existsSync(path)) return true; await sleep(25); }
  return existsSync(path);
}

/** Starts a run and waits until the worker is spawned. */
async function running(r: Rig, b: TaskBrief, steps: unknown[]) {
  const p = runLease(b.leaseId, r.deps({ steps }));
  for (const until = Date.now() + 20_000; Date.now() < until;) {
    const rec = await readRunRecord(r.paths.state, b.leaseId);
    if (rec?.phase === 'running') return { p, rec };
    await sleep(50);
  }
  throw new Error('the run never started');
}

describe.skipIf(!HAS_PROCFS)('work run: producer happy path', () => {
  it('runs the fake harness in a private clone, fast-forwards the lease branch, submits by proxy and records usage', async () => {
    const r = rig();
    const b = await claim(r);
    writeFileSync(join(r.root, 'secret-marker'), '');
    mkdirSync(r.paths.secretsDir, { recursive: true });
    writeFileSync(join(r.paths.secretsDir, 'fake-key'), 'sk-fake-very-secret-value\n');
    const scenario = { steps: [{ op: 'echoEnv' }, { op: 'commit', file: 'a.txt', content: 'hello\n' }, { op: 'usage', input: 100, output: 20 }, { op: 'usage', input: 5, output: 1 }, { op: 'result' }] };
    const deps = r.deps(scenario, {
      adapters: { codex: fakeAdapter({ script: SCRIPT, scenario, secretEnv: { FAKE_API_KEY: 'fake-key' } }) },
      env: { ...process.env, GH_TOKEN: 'gh-should-not-leak', CLAUDE_CODE_X: '1', ANTHROPIC_API_KEY: 'nope', GIT_DIR: '/nowhere' },
    });
    const out = await runLease(b.leaseId, deps);
    expect(out).toMatchObject({ leaseId: b.leaseId, submitted: true, status: 'complete', violations: [], usage: { tokens: 126 } });
    expect(out.exit).toMatchObject({ code: 0, stopped: null });
    // Branch and lease worktree moved together; main untouched.
    const head = headOf(r, b.branch);
    expect(head).not.toBe(b.expectedHead);
    expect(gitSync(r.layout.repo, 'merge-base', '--is-ancestor', b.expectedHead, head)).toBe('');
    expect(readFileSync(join(b.worktree, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(gitSync(b.worktree, 'status', '--porcelain')).toBe('');
    expect(headOf(r, 'main')).toBe(r.baseSha);
    expect(gitSync(r.layout.repo, 'for-each-ref', 'refs/minions')).toBe('');
    // The worker saw only its clone, the allowlisted env and the secret in env (never argv).
    const seen = JSON.parse(readFileSync(join(r.paths.scratch, b.leaseId, 'result.json.env'), 'utf8')) as { env: Record<string, string>; argv: string[]; stdin: string };
    expect(seen.env.FAKE_API_KEY).toBe('sk-fake-very-secret-value');
    expect(seen.argv.join(' ')).not.toContain('sk-fake');
    expect(Object.keys(seen.env).filter((k) => /^(GIT_|GH_|CLAUDE|ANTHROPIC)/.test(k))).toEqual([]);
    expect(seen.env).toMatchObject({ HOME: join(r.paths.scratch, b.leaseId, 'harness-home'), TMPDIR: join(r.paths.scratch, b.leaseId, 'tmp'), TERM: 'dumb', MINIONS_WORKER_LEASE: b.leaseId });
    expect(seen.stdin).toContain('$MINIONS_RESULT_FILE');
    const workerBrief = JSON.parse(readFileSync(seen.env.MINIONS_BRIEF_FILE!, 'utf8')) as { worktree: string; leaseWorktree: string };
    expect(workerBrief).toMatchObject({ worktree: checkoutOf(r, b), leaseWorktree: b.worktree });
    // The clone: no reflogs, no remote, runner-owned config.
    const cfg = readFileSync(join(checkoutOf(r, b), '.git', 'config'), 'utf8');
    expect(cfg).toContain('logallrefupdates = false');
    expect(cfg).not.toMatch(/remote|include/);
    // Run record done; usage event tagged with the harness.
    expect(await readRunRecord(r.paths.state, b.leaseId)).toMatchObject({ phase: 'done', outcome: { status: 'complete', submitted: true, head } });
    const usage = r.db.events('task-1', 'usage').map((ev) => ev.data);
    expect(usage).toContainEqual(expect.objectContaining({ leaseId: b.leaseId, tokens: 126, source: 'runner', harness: 'codex' }));
    // The coordinator records it unchanged (the head check sees the fetched head).
    const rec = await recordSubmitted(r.sched, r.paths, b.leaseId);
    expect(rec).toMatchObject({ valid: true });
  });

  it('a final message stands in for a missing result file; no result at all is a synthesized blocked with the stderr tail', async () => {
    const r = rig();
    const b = await claim(r);
    const fake = (await runLease(b.leaseId, r.deps({ steps: [{ op: 'final', result: result({ branch: b.branch, headSha: b.expectedHead, modifiedPaths: [] }) }] })));
    expect(fake).toMatchObject({ submitted: true, status: 'complete' });
    await r.sched.release(b.leaseId, 'next');
    const b2 = await claim(r);
    const none = await runLease(b2.leaseId, r.deps({ steps: [{ op: 'stderr', text: 'boom token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' }], exitCode: 3 }));
    expect(none).toMatchObject({ submitted: true, status: 'blocked', exit: { code: 3 } });
    const s = submitted(r, b2);
    expect(s.headSha).toBe(b2.expectedHead);
    expect(s.findings.join('\n')).toContain('boom');
    expect(s.findings.join('\n')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('work run: launch gate', () => {
  it.skipIf(!HAS_PROCFS)('refuses a worker caller, a Claude lease, a missing adapter, a second run and a sandbox that is not ok', async () => {
    const r = rig();
    const b = await claim(r);
    expect((await err(runLease(b.leaseId, r.deps({}, { callerEnv: { MINIONS_WORKER_LEASE: 'lease-x' } })))).code).toBe('POLICY_DENIED');
    expect((await err(runLease(b.leaseId, r.deps({}, { callerCwd: b.worktree })))).code).toBe('POLICY_DENIED');
    expect((await err(runLease(b.leaseId, r.deps({}, { adapters: {} })))).code).toBe('PRECONDITION');
    const unavailable = { state: 'unavailable' as const, detail: 'no helper', abi: null, arch: null, helperVersion: null, checks: [] };
    const sb = await err(runLease(b.leaseId, r.deps({}, { isolation: { kind: 'sandbox', protectedPaths: [r.paths.state], selfTest: async () => unavailable } })));
    expect(sb.code).toBe('PRECONDITION');
    expect(sb.message).toMatch(/isolation unavailable/);
    // None of the refusals left a record: the real run still works, once.
    await runLease(b.leaseId, r.deps({ steps: [{ op: 'result' }] }));
    const again = await err(runLease(b.leaseId, r.deps({ steps: [] })));
    expect(again.code).toMatch(/POLICY_DENIED|CONFLICT/);
  });

  it('a lease that already has a run record is refused (one process per lease)', async () => {
    const r = rig();
    const b = await claim(r);
    await createRunRecord(r.paths.state, { leaseId: b.leaseId, phase: 'prepared' } as RunRecord);
    const e = await err(runLease(b.leaseId, r.deps({ steps: [] })));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toMatch(/already has a run record/);
  });

  it('a Claude lease is refused: it is spawned with the Agent tool', async () => {
    const r = rig((c) => set(c, { roles: {} }));
    const b = await claim(r);
    expect((await err(runLease(b.leaseId, r.deps({ steps: [] })))).message).toMatch(/runs on Claude Code/);
  });

  it.skipIf(!HAS_PROCFS)('capacity excludes the lease itself: a full role still runs its own lease; a lowered limit refuses it', async () => {
    const r = rig((c) => { c.execution.maxByRole = { engineer: 1 }; c.execution.maxActiveTasks = 1; });
    const b = await claim(r);
    const own = await runLease(b.leaseId, r.deps({ steps: [{ op: 'result' }] }));
    expect(own.error).toBeUndefined();
    expect(own).toMatchObject({ submitted: true });

    const r2 = rig((c) => { c.execution.maxByRole = { engineer: 2 }; c.execution.maxActiveTasks = 2; }, PHASE_RULES['2']);
    await claim(r2, 'task-1');
    const b2 = await claim(r2, 'task-2');
    const lowered = structuredClone(r2.config);
    lowered.execution.maxByRole = { engineer: 1 };
    const e = await err(runLease(b2.leaseId, r2.deps({ steps: [] }, { config: lowered })));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toMatch(/limit reached without this lease \(1\/1\)/);
  });

  it.skipIf(!HAS_PROCFS)('the phase 1 producer cap counts only the other leases', async () => {
    const r = rig();
    const b = await claim(r);
    expect(await runLease(b.leaseId, r.deps({ steps: [{ op: 'result' }] }))).toMatchObject({ submitted: true });
  });

  it('refuses while starts are paused or a drain is pending', async () => {
    const r = rig();
    const b = await claim(r);
    r.db.setPaused({ starts: true });
    expect((await err(runLease(b.leaseId, r.deps({ steps: [] })))).message).toMatch(/paused/);
    r.db.setPaused({ starts: false });
    requestDrain(r.db, r.paths, 'upgrade');
    expect((await err(runLease(b.leaseId, r.deps({ steps: [] })))).message).toMatch(/drain/);
  });

  it('refuses a new run while another lease of the task has a run record that is not done', async () => {
    const r = rig();
    const a = await claim(r);
    await r.sched.release(a.leaseId, 'retry');
    await createRunRecord(r.paths.state, { leaseId: a.leaseId, phase: 'post-exit' } as RunRecord);
    const b = await claim(r);
    const e = await err(runLease(b.leaseId, r.deps({ steps: [] })));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toContain(a.leaseId);
  });
});

// Real subprocesses (git, the node fake harness, its children) with second-scale timings: a limit above the default 5 s.
describe.skipIf(!HAS_PROCFS)('work run: supervise, cancel, timeout, drain', { timeout: 30_000 }, () => {
  it('timeout: the worker (ignoring SIGTERM) is killed, the runner commits wip: and submits partial', async () => {
    const r = rig();
    const b = await claim(r);
    const ready = join(r.root, 'ready.pid');
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'ignoreTerm' }, { op: 'write', path: 'wip.txt', content: 'half\n' }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 30_000 }] },
      { timing: afterReady(ready, { pollMs: 50, killGraceMs: 300, drainGraceMs: 100 }) }));
    expect(out).toMatchObject({ submitted: true, status: 'partial', exit: { stopped: 'timeout' } });
    expect(out.wipCommit).toBe(headOf(r, b.branch));
    expect(gitSync(r.layout.repo, 'log', '-1', '--format=%an %s', out.wipCommit!)).toBe('minions-runner wip: runner checkpoint (timeout)');
    expect(readFileSync(join(b.worktree, 'wip.txt'), 'utf8')).toBe('half\n');
    expect(submitted(r, b)).toMatchObject({ status: 'partial', headSha: out.wipCommit });
  });

  it('task-14.14: a stop sends SIGINT first, SIGTERM after the interrupt grace, then SIGKILL', async () => {
    const r = rig();
    const b = await claim(r);
    const log = join(r.root, 'signals.log');
    const ready = join(r.root, 'ready.pid');
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'logSignals', path: log }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 30_000 }] },
      { timing: afterReady(ready, { pollMs: 50, killGraceMs: 1_000, interruptGraceMs: 1_000, drainGraceMs: 100 }) }));
    expect(out).toMatchObject({ status: 'partial', exit: { stopped: 'timeout', signal: 'SIGKILL' } });
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
    expect(lines.map(([sig]) => sig)).toEqual(['SIGINT', 'SIGTERM']);
    // The times are when the harness handled each signal, so a starved harness handling the SIGINT late
    // shrinks the gap below the grace (194 ms for a 250 ms grace under load, task-93). A 1 s grace with a
    // 500 ms floor still tells a real grace from none (~0 ms) and leaves room for that lag.
    expect(Number(lines[1]![1]) - Number(lines[0]![1])).toBeGreaterThanOrEqual(500);
  });

  it('task-14.14: a worker that stops on SIGINT gets nothing more; the interrupt grace never exceeds the kill grace', async () => {
    const r = rig();
    const b = await claim(r);
    const started = Date.now();
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'sleep', ms: 30_000 }] },
      { timing: { timeoutMs: 300, pollMs: 50, killGraceMs: 300, interruptGraceMs: 60_000, drainGraceMs: 100 } }));
    expect(out).toMatchObject({ status: 'partial', exit: { stopped: 'timeout', signal: 'SIGINT' } });
    expect(Date.now() - started).toBeLessThan(20_000);

    await r.sched.release(b.leaseId, 'next');
    const b2 = await claim(r);
    const log = join(r.root, 'signals2.log');
    const ready = join(r.root, 'ready2.pid');
    const out2 = await runLease(b2.leaseId, r.deps({ steps: [{ op: 'logSignals', path: log }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 30_000 }] },
      { timing: afterReady(ready, { pollMs: 50, killGraceMs: 300, interruptGraceMs: 60_000, drainGraceMs: 100 }) }));
    expect(out2).toMatchObject({ exit: { stopped: 'timeout', signal: 'SIGKILL' } });
    expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('task-14.14 (QA): the SIGINT goes to the whole process group, so a member reached through a wrapper gets it first', async () => {
    const r = rig();
    const b = await claim(r);
    const log = join(r.root, 'member-signals.log');
    // The leader ignores both graceful signals (as minions-sandbox ignores SIGINT); only the group member logs them.
    const ready = join(r.root, 'ready.pid');
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'groupChildLogSignals', path: log }, { op: 'ignoreTerm' }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 30_000 }] },
      { timing: afterReady(ready, { pollMs: 50, killGraceMs: 300, interruptGraceMs: 200, drainGraceMs: 100 }) }));
    expect(out).toMatchObject({ status: 'partial', exit: { stopped: 'timeout', signal: 'SIGKILL' } });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('task-14.14 (QA): a cancel (lease released) stops the worker SIGINT-first too', async () => {
    const r = rig();
    const b = await claim(r);
    const log = join(r.root, 'cancel-signals.log');
    const ready = join(r.root, 'cancel-ready.pid');
    const { p } = await running(r, b, [{ op: 'logSignals', path: log }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 30_000 }]);
    // 'running' is recorded at spawn: releasing then can SIGINT a node that has not installed its handlers yet
    // (it dies of the SIGINT, no log). Cancel once the handlers are in (task-93).
    expect(await waitForFile(ready)).toBe(true);
    await r.sched.release(b.leaseId, 'owner cancel');
    const out = await p;
    expect(out).toMatchObject({ submitted: false, exit: { stopped: 'lease-ended', signal: 'SIGKILL' } });
    expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')[0])).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('task-14.14 (QA): a result file is redacted too, including a spawn secret that needs JSON escaping', async () => {
    const r = rig();
    const b = await claim(r);
    mkdirSync(r.paths.secretsDir, { recursive: true });
    const odd = 'odd"shaped\\secret-7f3a';
    writeFileSync(join(r.paths.secretsDir, 'fake-key'), odd + '\n');
    const gh = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const scenario = { steps: [{ op: 'result', result: { findings: [`env FAKE_API_KEY=${odd}`, `saw ${gh}`] } }] };
    const out = await runLease(b.leaseId, r.deps(scenario, { adapters: { codex: fakeAdapter({ script: SCRIPT, scenario, secretEnv: { FAKE_API_KEY: 'fake-key' } }) } }));
    expect(out).toMatchObject({ submitted: true, status: 'complete' });
    const raw = readFileSync(submissionPath(r.paths, b.leaseId), 'utf8');
    for (const s of [odd, JSON.stringify(odd).slice(1, -1), gh]) expect(raw).not.toContain(s);
    const findings = submitted(r, b).findings;
    expect(findings[0]).toBe('env FAKE_API_KEY=[REDACTED]');
    expect(findings[1]).toMatch(/^saw /);
  });

  it('drain: after the grace the worker is stopped with a wip: commit and a partial result', async () => {
    const r = rig();
    const b = await claim(r);
    const ready = join(r.root, 'drain-ready.pid');
    const { p } = await running(r, b, [{ op: 'write', path: 'd.txt', content: 'd\n' }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 30_000 }]);
    // The drain grace (200 ms) runs from the first poll after the request: drain once the harness wrote d.txt,
    // so a slow node start cannot leave nothing to checkpoint (task-93).
    expect(await waitForFile(ready)).toBe(true);
    requestDrain(r.db, r.paths, 'upgrade');
    const out = await p;
    expect(out).toMatchObject({ status: 'partial', exit: { stopped: 'drain' } });
    expect(gitSync(r.layout.repo, 'log', '-1', '--format=%s', headOf(r, b.branch))).toBe('wip: runner checkpoint (drain)');
  });

  it('cancel by release: the worker is stopped and nothing is submitted for the ended lease', async () => {
    const r = rig();
    const b = await claim(r);
    const workerPid = join(r.root, 'worker.pid');
    const { p } = await running(r, b, [{ op: 'pidfile', path: workerPid }, { op: 'sleep', ms: 30_000 }]);
    // 'running' is recorded at spawn, before node has loaded the harness. Releasing then removes the lease
    // scratch dir (the worker's cwd) under a still-starting node, which can exit on its own before the
    // runner's next poll (stopped: null). Release only once the harness is really in its sleep.
    expect(await waitForFile(workerPid)).toBe(true);
    await r.sched.release(b.leaseId, 'owner cancel');
    const out = await p;
    expect(out).toMatchObject({ submitted: false, exit: { stopped: 'lease-ended' } });
    expect(existsSync(submissionPath(r.paths, b.leaseId))).toBe(false);
    expect((await readRunRecord(r.paths.state, b.leaseId))?.phase).toBe('done');
  });

  it('a group member left behind by the worker is killed when the worker exits', async () => {
    const r = rig();
    const b = await claim(r);
    const pidFile = join(r.root, 'grandchild.pid');
    await runLease(b.leaseId, r.deps({ steps: [{ op: 'grandchild', pidFile }, { op: 'result' }] }));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
    // The grandchild never exits by itself; poll with a deadline instead of a fixed 100 ms (task-93).
    for (const until = Date.now() + 10_000; alive() && Date.now() < until;) await sleep(25);
    expect(alive()).toBe(false);
  });
});

describe.skipIf(!HAS_PROCFS)('work run: git-metadata and branch attacks end with nothing fetched', () => {
  type Steps = unknown[] | ((c: { b: TaskBrief; r: Rig; stateFile: string }) => unknown[]);
  const attacked = async (steps: Steps) => {
    const r = rig();
    const b = await claim(r);
    const stateFile = join(r.root, 'state-fixture');
    writeFileSync(stateFile, 'precious\n');
    const out = await runLease(b.leaseId, r.deps({ steps: typeof steps === 'function' ? steps({ b, r, stateFile }) : steps }));
    return { r, b, out, stateFile };
  };
  const nothingFetched = (x: { r: Rig; b: TaskBrief; out: Awaited<ReturnType<typeof runLease>> }, pattern: RegExp) => {
    expect(headOf(x.r, x.b.branch)).toBe(x.b.expectedHead);
    expect(x.out.violations.join('\n')).toMatch(pattern);
    expect(x.out).toMatchObject({ submitted: true, status: 'blocked' });
    expect(submitted(x.r, x.b).findings.join('\n')).toMatch(/harness-violation/);
    expect(x.r.db.events(x.b.task.id, 'harness-violation')).toHaveLength(1);
  };

  it('.git replaced by a gitdir: pointer file', async () => {
    const x = await attacked([{ op: 'commit', file: 'a.txt' }, { op: 'rm', path: '.git' }, { op: 'write', path: '.git', content: 'gitdir: /somewhere/else\n' }]);
    nothingFetched(x, /not a real directory/);
  });

  it('.git replaced by a symlink', async () => {
    const x = await attacked((c: { b: TaskBrief }) => [{ op: 'symlink', path: '.git', target: join(c.b.worktree, '.git') }]);
    nothingFetched(x, /not a real directory/);
  });

  it('a control file replaced by a symlink into a "state" dir: never written through', async () => {
    const x = await attacked((c: { stateFile: string }) => [{ op: 'commit', file: 'a.txt' }, { op: 'symlink', path: '.git/config', target: c.stateFile }]);
    nothingFetched(x, /symlink in the git dir: .*\.git\/config/);
    expect(readFileSync(x.stateFile, 'utf8')).toBe('precious\n');
  });

  it('a symlink deep in the .git tree (refs, objects) is found too', async () => {
    const x = await attacked((c: { stateFile: string }) => [{ op: 'commit', file: 'a.txt' }, { op: 'symlink', path: '.git/refs/heads/evil', target: c.stateFile }]);
    nothingFetched(x, /symlink in the git dir: .*refs\/heads\/evil/);
  });

  it('hooks, fsmonitor, hooksPath, include, attributes filters, alternates and worktree pointers are neutralized; the marker never runs', async () => {
    const r = rig();
    const b = await claim(r);
    const marker = join(r.root, 'MARKER');
    const evil = join(r.root, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\necho ran >> ${marker}\ncat\n`, { mode: 0o755 });
    const inc = join(r.paths.scratch, b.leaseId, 'tmp', 'inc.cfg');
    const steps = [
      { op: 'commit', file: 'a.txt', content: 'x\n' },
      { op: 'write', path: '.gitattributes', content: '* filter=evil\n' },
      { op: 'commit', file: '.gitattributes', content: '* filter=evil\n' },
      // The result first: the writes below break the worker's own git (that is its problem, not the runner's).
      { op: 'result' },
      { op: 'write', path: inc, content: `[core]\n\tfsmonitor = ${evil}\n` },
      { op: 'append', path: '.git/config', content: `[core]\n\tfsmonitor = ${evil}\n\thooksPath = ${r.root}\n[include]\n\tpath = ${inc}\n[includeIf "gitdir:/"]\n\tpath = ${inc}\n[filter "evil"]\n\tclean = ${evil}\n\tsmudge = ${evil}\n` },
      { op: 'write', path: '.git/hooks/post-merge', content: `#!/bin/sh\necho ran >> ${marker}\n` },
      { op: 'write', path: '.git/hooks/reference-transaction', content: `#!/bin/sh\necho ran >> ${marker}\n` },
      { op: 'write', path: '.git/info/attributes', content: '* filter=evil\n' },
      { op: 'write', path: '.git/commondir', content: '/nowhere\n' },
      { op: 'write', path: '.git/gitdir', content: '/nowhere\n' },
      { op: 'write', path: '.git/config.worktree', content: `[core]\n\tfsmonitor = ${evil}\n` },
      { op: 'write', path: '.git/objects/info/alternates', content: '/nowhere/objects\n' },
    ];
    writeFileSync(join(r.root, 'post-merge'), `#!/bin/sh\necho ran >> ${marker}\n`, { mode: 0o755 });
    const out = await runLease(b.leaseId, r.deps({ steps }));
    expect(out.violations).toEqual([]);
    expect(submitted(r, b).findings).toEqual([]);
    expect(out).toMatchObject({ submitted: true, status: 'complete' });
    expect(headOf(r, b.branch)).not.toBe(b.expectedHead);
    expect(existsSync(marker)).toBe(false);
    const gd = join(checkoutOf(r, b), '.git');
    for (const p of ['hooks', 'info', 'commondir', 'gitdir', 'config.worktree']) expect(existsSync(join(gd, p)), p).toBe(false);
    expect(readFileSync(join(gd, 'objects', 'info', 'alternates'), 'utf8')).toBe(`${join(r.common, 'objects')}\n`);
    expect(readFileSync(join(gd, 'config'), 'utf8')).not.toMatch(/fsmonitor|include|filter/);
  });

  it('a non-fast-forward branch is refused', async () => {
    const x = await attacked([{ op: 'git', args: ['commit', '--amend', '-q', '--allow-empty', '-m', 'rewritten'] }, { op: 'result' }]);
    nothingFetched(x, /not a fast-forward/);
  });

  it('a tree with a .git entry is rejected by fsck on fetch', async () => {
    const x = await attacked([{ op: 'dotgitCommit' }, { op: 'result' }]);
    nothingFetched(x, /fetch: rejected/);
    expect(gitSync(x.r.layout.repo, 'for-each-ref', 'refs/minions')).toBe('');
  });

  it('a write to the lease worktree pointer files (an L1 gap) is a violation and is restored', async () => {
    const r = rig();
    const b = await claim(r);
    const dotGit = join(b.worktree, '.git');
    const before = readFileSync(dotGit, 'utf8');
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'a.txt' }, { op: 'write', path: dotGit, content: 'gitdir: /elsewhere\n' }, { op: 'result' }] }));
    expect(out.violations.join('\n')).toMatch(/lease git files changed/);
    expect(readFileSync(dotGit, 'utf8')).toBe(before);
    expect(headOf(r, b.branch)).toBe(b.expectedHead);
  });
});

describe.skipIf(!HAS_PROCFS)('work run: a gate (phase 1 b pilot)', () => {
  const pilot = () => rig((c) => set(c, { roles: { 'codex-reviewer': { description: 'Codex review.', promptText: 'Review.', contract: 'gate', harness: 'codex' } }, workflows: { pilot: ['engineer', 'codex-reviewer'] } }), PHASE_RULES['1b']);
  async function toGate(r: Rig) {
    r.backlog.add({ id: 'task-1', workflow: 'pilot' });
    const eng = await r.sched.claim('task-1', 'engineer');
    const head = commitFile(eng.worktree, 'a.txt', 'x\n');
    await r.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head }));
    return claim(r, 'task-1');
  }

  it('a gate approves without fetching anything; its builds may write the clone', async () => {
    const r = pilot();
    const b = await toGate(r);
    expect(b.role).toBe('codex-reviewer');
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'write', path: 'build/out.txt', content: 'artifact' }, { op: 'result', result: { verdict: 'approve' } }] }));
    expect(out).toMatchObject({ submitted: true, status: 'complete', violations: [] });
    expect(headOf(r, b.branch)).toBe(b.expectedHead);
    expect(await recordSubmitted(r.sched, r.paths, b.leaseId)).toMatchObject({ valid: true, approved: true });
  });

  it('a commit by a gate is a violation; nothing is fetched', async () => {
    const r = pilot();
    const b = await toGate(r);
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'sneaky.txt' }, { op: 'result', result: { verdict: 'approve' } }] }));
    expect(out.violations.join('\n')).toMatch(/a gate moved/);
    expect(headOf(r, b.branch)).toBe(b.expectedHead);
    expect(out.status).toBe('blocked');
  });
});

describe.skipIf(!HAS_PROCFS)('work run: concurrent writers', () => {
  it('commits on another branch and a merge into main during the run cause no false violation and no rollback', async () => {
    const r = rig();
    const b = await claim(r);
    const p = runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'a.txt', content: 'mine\n' }, { op: 'sleep', ms: 600 }, { op: 'result' }] }));
    await sleep(200);
    gitSync(r.layout.repo, 'checkout', '-q', '-b', 'other');
    const other = commitFile(r.layout.repo, 'o.txt', 'o\n');
    gitSync(r.layout.repo, 'checkout', '-q', 'main');
    gitSync(r.layout.repo, 'merge', '-q', '--no-ff', '-m', 'merge other', 'other');
    const main = headOf(r, 'main');
    const out = await p;
    expect(out).toMatchObject({ violations: [], status: 'complete' });
    expect(headOf(r, 'other')).toBe(other);
    expect(headOf(r, 'main')).toBe(main);
    expect(readFileSync(join(b.worktree, 'a.txt'), 'utf8')).toBe('mine\n');
  });
});

describe.skipIf(!HAS_PROCFS)('reapRun: orphans and recovery', { timeout: 30_000 }, () => {
  /** Simulates a runner that died (SIGKILL): the record names a process that is gone. */
  function forgeDeadRunner(r: Rig, rec: RunRecord, patch: Partial<RunRecord> = {}) {
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const runner = { pid: Number(dead.stdout.trim()), startTime: '1' };
    writeFileSync(runRecordPath(r.paths.state, rec.leaseId), JSON.stringify({ ...rec, runner, ...patch }));
    // The runner's owner lock names the same (dead) process.
    const lock = JSON.parse(readFileSync(ownerLockPath(r.paths.state, rec.leaseId), 'utf8')) as Record<string, unknown>;
    writeFileSync(ownerLockPath(r.paths.state, rec.leaseId), JSON.stringify({ ...lock, ...runner }));
  }

  it('runner lost: the wrapper group is killed, post-exit runs with a wip: commit on the branch, the record is done', async () => {
    const r = rig();
    const b = await claim(r);
    const ready = join(r.root, 'w-ready.pid');
    const { p, rec } = await running(r, b, [{ op: 'write', path: 'w.txt', content: 'w\n' }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 60_000 }]);
    expect(await waitForFile(ready)).toBe(true); // w.txt is written: there is work in progress to recover (task-93)
    forgeDeadRunner(r, rec);
    const reaped = await reapRun(b.leaseId, { db: r.db, paths: r.paths, env: process.env, escapees: null });
    expect(reaped.action).toBe('recovered');
    expect(reaped.killed).toContain(rec.pgid);
    expect(reaped.note).toMatch(/^recovered: runner lost; work in progress is committed as [0-9a-f]{40}$/);
    expect(gitSync(r.layout.repo, 'log', '-1', '--format=%s', headOf(r, b.branch))).toBe('wip: runner checkpoint (recovered: runner lost)');
    expect((await readRunRecord(r.paths.state, b.leaseId))?.phase).toBe('done');
    // The (still running) original runner sees the takeover and submits nothing.
    expect(await p).toMatchObject({ submitted: false, error: expect.stringMatching(/taken over by recovery/) });
  });

  it('a record from another boot goes straight to post-exit (no kill attempted)', async () => {
    const r = rig();
    const b = await claim(r);
    const ready = join(r.root, 'w-ready.pid');
    const { p, rec } = await running(r, b, [{ op: 'write', path: 'w.txt', content: 'w\n' }, { op: 'pidfile', path: ready }, { op: 'sleep', ms: 60_000 }]);
    expect(await waitForFile(ready)).toBe(true); // w.txt is written: there is work in progress to recover (task-93)
    forgeDeadRunner(r, rec, { host: { bootId: 'another-boot', containerStart: '1' } });
    const reaped = await reapRun(b.leaseId, { db: r.db, paths: r.paths, env: process.env, escapees: null });
    expect(reaped).toMatchObject({ action: 'recovered', killed: [] });
    expect(reaped.post?.wipCommit).toBe(headOf(r, b.branch));
    try { process.kill(-rec.pgid!, 'SIGKILL'); } catch { /* gone */ }
    await p;
  });

  it('a live runner is asked to cancel and finishes on its own; no record and done records are no-ops', async () => {
    const r = rig();
    const b = await claim(r);
    expect((await reapRun(b.leaseId, { db: r.db, paths: r.paths, escapees: null })).action).toBe('none');
    const { p } = await running(r, b, [{ op: 'sleep', ms: 60_000 }]);
    const reaped = await reapRun(b.leaseId, { db: r.db, paths: r.paths, waitMs: 10_000, pollMs: 50, escapees: null });
    expect(reaped.action).toBe('cancelled');
    expect(await p).toMatchObject({ exit: { stopped: 'cancel' }, submitted: true, status: 'partial' });
    expect(await readOwner(r.paths.state, b.leaseId)).toBeNull();
    expect((await reapRun(b.leaseId, { db: r.db, paths: r.paths, escapees: null })).action).toBe('none');
    expect(lstatSync(join(r.paths.state, 'run', 'leases', b.leaseId)).isDirectory()).toBe(true);
  });
});
