// task-39: GitHub intake follow-ups from the task-19 review, the parts that need real processes: a hung fake gh on
// PATH killed by the stop signal or the budget, run()'s signal handling on real children, and the provenance fallback
// through the real Backlog.md CLI. Temp dirs only; never the live /state. The in-process parts (provenance fallback,
// the aborted list read report) are in intake-followups-tester.test.ts (unit tier).
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BacklogMdAdapter } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { run } from '../../src/core/exec.js';
import { intakeOnStart } from '../../src/runtime/commands.js';
import type { ApiGet } from '../../src/runtime/ci.js';
import { intakeProvenanceFallback, syncIntake, type GithubIntakeConfig } from '../../src/runtime/intake-sync.js';
import { makeDefaultEnv } from './fixtures.js';

const REPO = 'acme/demo';
const FILTER: GithubIntakeConfig = { enabled: true, repository: REPO, labels: ['minions'], assignee: null, milestone: null, state: 'open' };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const issue = (n: number) => ({ number: n, title: `Issue ${n}`, body: '', state: 'open', html_url: `https://github.com/${REPO}/issues/${n}`, assignees: [], labels: [{ name: 'minions' }], milestone: null });

const dirs: string[] = [];
const oldPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = oldPath;
  for (const d of dirs.splice(0)) {
    const pidFile = join(d, 'hung.pid');
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('startup intake: the abort kills the in-flight gh child (item 1)', () => {
  it('the wrapper stop signal kills a hung gh long before the budget or the per-call timeout', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const d = mkdtempSync(join(tmpdir(), 'minions-gh-stop-'));
    dirs.push(d);
    writeFileSync(join(d, 'gh'), ['#!/bin/sh', `echo $$ > '${d}/hung.pid'`, 'exec sleep 120'].join('\n'));
    chmodSync(join(d, 'gh'), 0o755);
    process.env.PATH = `${d}:${oldPath}`;
    const stop = new AbortController();
    const t0 = Date.now();
    const pass = intakeOnStart(e.config, () => {}, (o) => syncIntake({ db: e.db, backlog: e.backlog, config: e.config, ...o }), 60_000, stop.signal);
    for (let i = 0; i < 50 && !existsSync(join(d, 'hung.pid')); i++) await sleep(50);
    const pid = Number(readFileSync(join(d, 'hung.pid'), 'utf8'));
    expect(alive(pid)).toBe(true);
    stop.abort();
    await pass;
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = !alive(pid); if (!gone) await sleep(100); }
    expect(gone).toBe(true);
    // SIGTERM ends `sleep` at once; well under the 60 s budget (and the SIGKILL grace).
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 20_000);

  it('the budget abort kills the gh child too', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const d = mkdtempSync(join(tmpdir(), 'minions-gh-budget-'));
    dirs.push(d);
    writeFileSync(join(d, 'gh'), ['#!/bin/sh', `echo $$ > '${d}/hung.pid'`, 'exec sleep 120'].join('\n'));
    chmodSync(join(d, 'gh'), 0o755);
    process.env.PATH = `${d}:${oldPath}`;
    let seenSignal: AbortSignal | undefined;
    await intakeOnStart(e.config, () => {}, (o) => { seenSignal = o.signal; return syncIntake({ db: e.db, backlog: e.backlog, config: e.config, ...o }); }, 500);
    expect(seenSignal?.aborted).toBe(true);
    const pid = Number(readFileSync(join(d, 'hung.pid'), 'utf8'));
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) { gone = !alive(pid); if (!gone) await sleep(100); }
    expect(gone).toBe(true);
  }, 20_000);
});

describe('provenance fallback for intake-tracked tasks (item 2): real Backlog.md', () => {
  const hasCli = (() => { try { execFileSync('backlog', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasCli)('an imported task whose meta block was removed reads as external-requirement', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const root = mkdtempSync(join(tmpdir(), 'minions-bl-prov-'));
    dirs.push(root);
    await writeBacklogConfig(root);
    const backlog = new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), provenanceFallback: intakeProvenanceFallback(() => e.db) });
    const api: ApiGet = async (path) => (path.includes('/issues?') ? { status: 200, body: [issue(1)] } : { status: 404, body: null });
    const r = await syncIntake({ db: e.db, backlog, config: e.config, api });
    expect(r.created).toEqual(['task-1']);
    const owner = await backlog.createTask({ title: 'Owner request', provenance: 'user-decision', idempotencyKey: 'owner-request' });
    for (const id of ['TASK-1', owner.task.id.toUpperCase()]) execFileSync('backlog', ['task', 'edit', id, '--description', 'meta block lost'], { cwd: root, stdio: 'ignore' });
    expect((await backlog.getTask('task-1')).provenance).toBe('external-requirement');
    expect((await backlog.getTask(owner.task.id)).provenance).toBe('user-decision');
  }, 60_000);
});

const HANG = ['-e', 'setTimeout(()=>{}, 10000)'];

describe('run(): signal listeners and abort/timeout interplay', () => {
  it('removes its abort listener when the child exits normally, fails, or times out', async () => {
    const ctl = new AbortController();
    await run('node', ['-e', 'process.exit(0)'], { signal: ctl.signal });
    await run('node', ['-e', 'process.exit(3)'], { signal: ctl.signal, allowFailure: true });
    await expect(run('node', ['-e', 'process.exit(3)'], { signal: ctl.signal })).rejects.toThrow(/exited with code 3/);
    await run('node', HANG, { signal: ctl.signal, timeoutMs: 150, allowFailure: true });
    await run('definitely-not-a-command-xyz', [], { signal: ctl.signal }).catch(() => {});
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
    // Aborting after all runs settled is harmless.
    ctl.abort();
  });

  it('many sequential runs sharing one signal do not accumulate listeners', async () => {
    const ctl = new AbortController();
    for (let i = 0; i < 15; i++) await run('node', ['-e', '0'], { signal: ctl.signal });
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
  });

  it('timeout first, then abort: reported as timed out (124), not aborted, and not killed twice', async () => {
    const ctl = new AbortController();
    const t = Date.now();
    const p = run('node', HANG, { signal: ctl.signal, timeoutMs: 150, allowFailure: true });
    setTimeout(() => ctl.abort(), 160);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBeUndefined();
    expect(r.code).toBe(124);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('abort first, then timeout: reported as aborted (130), not timed out', async () => {
    const ctl = new AbortController();
    // Ignores SIGTERM so the timeout fires during the SIGKILL grace (injected 800 ms: abort at 300, timeout at 600).
    const p = run('node', ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'], { signal: ctl.signal, timeoutMs: 600, allowFailure: true, killGraceMs: 800 });
    await new Promise((res) => setTimeout(res, 300));
    ctl.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBeUndefined();
    expect(r.code).toBe(130);
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
  }, 10_000);

  it('without a signal the timeout path is unchanged (rejects with timed out, code 124 with allowFailure)', async () => {
    await expect(run('node', HANG, { timeoutMs: 150 })).rejects.toMatchObject({ details: expect.objectContaining({ timedOut: true, code: 124 }) });
    const r = await run('node', HANG, { timeoutMs: 150, allowFailure: true });
    expect(r).toMatchObject({ timedOut: true, code: 124 });
    expect('aborted' in r).toBe(false);
    const f = await run('node', ['-e', 'process.stderr.write("e"); process.exit(2)'], { allowFailure: true });
    expect(f).toEqual({ code: 2, stdout: '', stderr: 'e' });
  });
});
