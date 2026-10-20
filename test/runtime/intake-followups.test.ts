// task-39: GitHub intake follow-ups from the task-19 review. Temp dirs and a fake gh on PATH only; never the live /state.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BacklogMdAdapter, toTask } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { intakeOnStart } from '../../src/runtime/commands.js';
import type { ApiGet } from '../../src/runtime/ci.js';
import {
  formatIntake, INTAKE_ABORTED, INTAKE_STATE_META, intakeKey, intakeProvenanceFallback, intakeTrackedTaskIds, syncIntake, type GithubIntakeConfig,
} from '../../src/runtime/intake-sync.js';
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

describe('provenance fallback for intake-tracked tasks (item 2)', () => {
  const rawNoMeta = { id: 'TASK-7', title: 'Imported', description: 'An issue body without a meta block' };
  const rawBadMeta = { id: 'TASK-7', title: 'Imported', description: 'Body\n\n<!-- minions:meta {not json} -->' };
  const rawMetaNoProv = { id: 'TASK-7', title: 'Imported', description: 'Body\n\n<!-- minions:meta {"branch":null} -->' };

  it('tracked tasks fall back to external-requirement; other tasks keep user-decision; a valid meta provenance wins', () => {
    const e = makeDefaultEnv();
    const fallback = intakeProvenanceFallback(() => e.db);
    expect(fallback('task-7')).toBeUndefined(); // no sync record yet
    e.db.setMeta(INTAKE_STATE_META, JSON.stringify({ version: 1, issues: {
      [intakeKey(REPO, 3)]: { taskId: 'task-7', url: `https://github.com/${REPO}/issues/3`, repository: REPO, number: 3, assignees: [], inFilter: true, lastSeenAt: 'x' },
    } }));
    expect([...intakeTrackedTaskIds(e.db)]).toEqual(['task-7']);
    for (const raw of [rawNoMeta, rawBadMeta, rawMetaNoProv]) {
      expect(toTask(raw, { provenanceFallback: fallback }).provenance).toBe('external-requirement');
      expect(toTask(raw).provenance).toBe('user-decision'); // the adapter default is unchanged without the hook
      expect(toTask({ ...raw, id: 'TASK-8' }, { provenanceFallback: fallback }).provenance).toBe('user-decision');
    }
    const withMeta = { id: 'TASK-7', description: 'Body\n\n<!-- minions:meta {"provenance":"agent-hypothesis"} -->' };
    expect(toTask(withMeta, { provenanceFallback: fallback }).provenance).toBe('agent-hypothesis');
  });

  it('a malformed sync record never throws and tracks nothing', () => {
    const e = makeDefaultEnv();
    e.db.setMeta(INTAKE_STATE_META, '{broken');
    expect(intakeProvenanceFallback(() => e.db)('task-1')).toBeUndefined();
  });

  const hasCli = (() => { try { execFileSync('backlog', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  it.skipIf(!hasCli)('real Backlog.md adapter: an imported task whose meta block was removed reads as external-requirement', async () => {
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

describe('aborted list read report (item 4)', () => {
  it('an aborted or failed list read reports no matched count, not the pages read so far', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const ctl = new AbortController();
    const page1 = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    const api: ApiGet = (path) => {
      if (/[?&]page=1(&|$)/.test(path)) return Promise.resolve({ status: 200, body: page1 });
      ctl.abort(); // the budget runs out while page 2 is in flight
      return new Promise(() => { /* never answers */ });
    };
    const r = await syncIntake({ db: e.db, backlog: e.backlog, config: e.config, api, signal: ctl.signal });
    expect(r.matched).toBeNull();
    expect(r.created).toEqual([]);
    expect(r.errors.join('\n')).toContain(INTAKE_ABORTED);
    const text = formatIntake(r);
    expect(text).not.toMatch(/100 matching/);
    expect(text).toContain('issue list not read, nothing imported');
    const ev = e.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE kind = ?', 'intake-sync');
    expect(JSON.parse(ev.at(-1)!.data_json)).toMatchObject({ matched: null, created: 0 });

    const failed = await syncIntake({ db: e.db, backlog: e.backlog, config: e.config, api: async () => ({ status: 401, body: null, error: 'Bad credentials' }) });
    expect(failed.matched).toBeNull();
    expect(formatIntake(failed)).toContain('issue list not read');
  });

  it('a complete read still reports the count; a truncated one says "at least"', () => {
    const base = { enabled: true, repository: REPO, created: [], existing: 2, skippedIntakePaused: 0, reconciliations: [], warnings: [], errors: [] };
    expect(formatIntake({ ...base, matched: 2, complete: true })).toContain(': 2 matching issue(s), 0 imported, 2 already');
    expect(formatIntake({ ...base, matched: 1000, complete: false })).toContain(': at least 1000 matching issue(s)');
  });
});
