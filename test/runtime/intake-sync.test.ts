// GitHub-filtered intake sync: mocked gh (read-only GETs only), temp state dirs, never the live /state.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BacklogMdAdapter } from '../../src/backlog/backlogmd.js';
import { writeBacklogConfig } from '../../src/backlog/factory.js';
import type { CreateTaskInput, Task } from '../../src/backlog/types.js';
import { validateConfig } from '../../src/config/resolve.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { RunResult } from '../../src/core/exec.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import {
  formatIntake, importStatus, INTAKE_MAX_PAGES, INTAKE_STATE_META, intakeKey, issuesPath, originRepository, syncIntake, type GithubIntakeConfig,
} from '../../src/runtime/intake-sync.js';
import { intakeOnStart } from '../../src/runtime/commands.js';
import type { GhFn } from '../../src/runtime/publish.js';
import { defaults } from '../helpers.js';
import { FakeBacklog, initRepo, makeDefaultEnv, tmp, type Env } from './fixtures.js';

const REPO = 'acme/demo';
const FILTER: GithubIntakeConfig = { enabled: true, repository: REPO, labels: ['minions'], assignee: null, milestone: null, state: 'open' };

const ok = (body: unknown): RunResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
const notFound: RunResult = { code: 1, stdout: JSON.stringify({ message: 'Not Found' }), stderr: 'gh: Not Found (HTTP 404)' };

interface FakeIssue { number: number; title?: string; body?: string; state?: string; assignees?: string[]; labels?: string[]; pr?: boolean }
const raw = (i: FakeIssue) => ({
  number: i.number, title: i.title ?? `Issue ${i.number}`, body: i.body ?? `Body of ${i.number}`, state: i.state ?? 'open',
  html_url: `https://github.com/${REPO}/issues/${i.number}`, assignees: (i.assignees ?? []).map((login) => ({ login })),
  labels: (i.labels ?? ['minions']).map((name) => ({ name })), milestone: null, ...(i.pr ? { pull_request: { url: 'x' } } : {}),
});

/**
 * Fake `gh`: serves the filtered list (page 1) from `list`, single issues from `all`, and records every
 * call. Anything that is not `gh api --method GET` fails, so a write attempt shows up as an error.
 */
function fakeGh(filter: GithubIntakeConfig = FILTER) {
  const s = { list: [] as FakeIssue[], all: new Map<number, FakeIssue>(), fail: false, calls: [] as string[][], routes: {} as Record<string, RunResult> };
  const fn: GhFn = async (args) => {
    s.calls.push(args);
    if (args[0] !== 'api' || args[1] !== '--method' || args[2] !== 'GET') return { code: 1, stdout: '', stderr: `refused non-GET gh call: ${args.join(' ')}` };
    const path = args[args.length - 1]!;
    if (s.routes[path]) return s.routes[path]!;
    if (s.fail) return { code: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' };
    if (path === issuesPath(REPO, filter, filter.milestone, 1)) return ok(s.list.map(raw));
    const m = new RegExp(`^/repos/${REPO}/issues/(\\d+)$`).exec(path);
    if (m) { const i = s.all.get(Number(m[1])); return i ? ok(raw(i)) : notFound; }
    return notFound;
  };
  const set = (issues: FakeIssue[]) => { s.list = issues; for (const i of issues) s.all.set(i.number, i); };
  return { s, fn, set };
}

function expectReadOnly(calls: string[][]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.slice(0, 3)).toEqual(['api', '--method', 'GET']);
    expect(c.some((a) => /^(-f|-F|--field|--raw-field|--input|-X)$/.test(a))).toBe(false);
  }
}

/** FakeBacklog that keeps the creation input (links, provenance, description) like the real adapter. */
class RecordingBacklog extends FakeBacklog {
  inputs: CreateTaskInput[] = [];
  override async createTask(input: CreateTaskInput) {
    this.inputs.push(input);
    const t = this.add({ id: `task-${this.tasks.size + 1}`, title: input.title, description: input.description ?? '', status: input.status ?? 'idea',
      externalLinks: input.externalLinks ?? [], provenance: input.provenance ?? 'user-decision', acceptanceCriteria: [] });
    return { task: t, created: true };
  }
}

function env(filter: GithubIntakeConfig | null = FILTER) {
  const e: Env = makeDefaultEnv((c) => { if (filter) c.intake.github = { ...filter }; });
  const backlog = new RecordingBacklog();
  const gh = fakeGh(filter ?? FILTER);
  const run = () => syncIntake({ db: e.db, backlog, config: e.config, gh: gh.fn });
  return { ...e, backlog, gh, run };
}

const events = (db: RuntimeDb, kind: string) => db.all<{ task_id: string | null; data_json: string }>('SELECT task_id, data_json FROM events WHERE kind = ? ORDER BY id', kind)
  .map((r): Record<string, unknown> & { taskId: string | null } => ({ taskId: r.task_id, ...(JSON.parse(r.data_json) as Record<string, unknown>) }));
const byLink = (tasks: Task[], n: number) => tasks.find((t) => t.externalLinks.includes(`https://github.com/${REPO}/issues/${n}`));

describe('intake sync: import', () => {
  it('imports matching issues (not pull requests) with provenance, link and intake key; reruns create no duplicates', async () => {
    const x = env();
    x.gh.set([{ number: 1, title: 'Fix login', body: 'Steps to reproduce' }, { number: 2, assignees: ['octocat'] }, { number: 3, pr: true }]);
    const r = await x.run();
    expect(r).toMatchObject({ enabled: true, repository: REPO, matched: 2, created: ['task-1', 'task-2'], existing: 0, skippedIntakePaused: 0, complete: true, errors: [] });
    const tasks = await x.backlog.listTasks();
    expect(tasks).toHaveLength(2);
    const t1 = byLink(tasks, 1)!;
    expect(t1).toMatchObject({ title: 'Fix login', status: 'idea', provenance: 'external-requirement' });
    expect(t1.description).toContain('Steps to reproduce');
    expect(t1.description).toContain(`Imported from GitHub issue https://github.com/${REPO}/issues/1`);
    expect(x.backlog.inputs.map((i) => i.idempotencyKey)).toEqual([intakeKey(REPO, 1), intakeKey(REPO, 2)]);
    expect(intakeKey(REPO, 1)).toBe('intake:gh:acme/demo#1');
    expect(x.db.idempotency.get(intakeKey(REPO, 2))).toBe('task-2');
    expect(events(x.db, 'intake-import').map((e) => e.taskId)).toEqual(['task-1', 'task-2']);

    // Rerun (same issues, plus a new one): only the new issue is imported.
    x.gh.set([...x.gh.s.list, { number: 4 }]);
    const again = await x.run();
    expect(again).toMatchObject({ matched: 3, created: ['task-3'], existing: 2, reconciliations: [] });
    const third = await x.run();
    expect(third).toMatchObject({ matched: 3, created: [], existing: 3, reconciliations: [] });
    expect(await x.backlog.listTasks()).toHaveLength(3);
    expect(x.backlog.inputs).toHaveLength(3);
    expect(events(x.db, 'intake-sync')).toHaveLength(3);
    expectReadOnly(x.gh.s.calls);
  });

  it('never overwrites imported task content: edited tasks keep their title, description and status', async () => {
    const x = env();
    x.gh.set([{ number: 1, title: 'Original' }]);
    await x.run();
    const t = (await x.backlog.listTasks())[0]!;
    await x.backlog.updateTask(t.id, t.version, { title: 'Triaged title', description: 'Rewritten by the coordinator', status: 'ready' });
    x.gh.set([{ number: 1, title: 'Renamed on GitHub', body: 'new body' }]);
    expect(await x.run()).toMatchObject({ created: [], existing: 1 });
    expect(await x.backlog.getTask(t.id)).toMatchObject({ title: 'Triaged title', description: 'Rewritten by the coordinator', status: 'ready' });
  });

  it('recognises an already-linked task by its issue URL when the idempotency row is missing (no duplicate)', async () => {
    const x = env();
    x.backlog.add({ id: 'task-9', title: 'Imported earlier', externalLinks: [`https://github.com/${REPO}/issues/5`] });
    x.gh.set([{ number: 5 }]);
    expect(await x.run()).toMatchObject({ created: [], existing: 1 });
    expect(x.db.idempotency.get(intakeKey(REPO, 5))).toBe('task-9');
    expect(x.backlog.inputs).toHaveLength(0);
  });

  it('does not re-import an issue whose linked task was removed from the backlog', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    x.backlog.tasks.clear();
    const r = await x.run();
    expect(r.created).toEqual([]);
    expect(r.warnings.join('\n')).toContain('no longer in the backlog');
  });

  it('is off when intake.github is unset or disabled: no gh calls', async () => {
    for (const f of [null, { ...FILTER, enabled: false }]) {
      const x = env(f);
      const r = await x.run();
      expect(r.enabled).toBe(false);
      expect(x.gh.s.calls).toEqual([]);
      expect(formatIntake(r)).toContain('off');
    }
  });

  it('builds the scoped query (labels, assignee, milestone number from its title, state) with GET only', async () => {
    const f: GithubIntakeConfig = { enabled: true, repository: REPO, labels: ['bug', 'minions'], assignee: 'octocat', milestone: 'v1.0', state: 'all' };
    const x = env(f);
    x.gh.s.routes[`/repos/${REPO}/milestones?state=all&per_page=100`] = ok([{ number: 7, title: 'v1.0' }, { number: 8, title: 'v2' }]);
    x.gh.s.routes[issuesPath(REPO, f, '7', 1)] = ok([raw({ number: 1, labels: ['bug', 'minions'], assignees: ['octocat'] })]);
    const r = await x.run();
    expect(r).toMatchObject({ matched: 1, created: ['task-1'], errors: [] });
    const path = x.gh.s.calls.map((c) => c.at(-1)!).find((p) => p.includes('/issues?'))!;
    const q = new URL(`https://api.github.com${path}`).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ state: 'all', labels: 'bug,minions', assignee: 'octocat', milestone: '7' });
    expectReadOnly(x.gh.s.calls);
  });

  it('an unknown milestone title is an error and imports nothing', async () => {
    const x = env({ ...FILTER, milestone: 'nope' });
    x.gh.s.routes[`/repos/${REPO}/milestones?state=all&per_page=100`] = ok([{ number: 7, title: 'v1.0' }]);
    const r = await x.run();
    expect(r.errors.join()).toContain('milestone "nope" not found');
    expect(await x.backlog.listTasks()).toHaveLength(0);
  });

  it('uses the workspace origin when intake.github.repository is null', async () => {
    const root = tmp('minions-intake-origin-');
    initRepo(root);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/demo.git'], { cwd: root });
    const { git } = await import('../../src/runtime/worktree.js');
    expect(await originRepository(root, git)).toBe(REPO);
    const x = env({ ...FILTER, repository: null });
    x.gh.set([{ number: 1 }]);
    const r = await syncIntake({ db: x.db, backlog: x.backlog, config: x.config, gh: x.gh.fn, originRepository: () => originRepository(root, git) });
    expect(r).toMatchObject({ repository: REPO, created: ['task-1'] });
    const none = await syncIntake({ db: x.db, backlog: x.backlog, config: x.config, gh: x.gh.fn, originRepository: async () => null });
    expect(none.errors.join()).toContain('not a github.com repository');
  });
});

describe('intake sync: pause intake', () => {
  it('skips new issues with a count while intake is paused (sync does not fail); resuming imports them', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    x.db.setPaused({ intake: true });
    x.gh.set([{ number: 1 }, { number: 2 }, { number: 3 }]);
    const r = await x.run();
    expect(r).toMatchObject({ matched: 3, created: [], existing: 1, skippedIntakePaused: 2, errors: [] });
    expect(formatIntake(r)).toContain('2 skipped (intake is paused');
    expect(await x.backlog.listTasks()).toHaveLength(1);
    x.db.setPaused({ intake: false });
    expect(await x.run()).toMatchObject({ created: ['task-2', 'task-3'], skippedIntakePaused: 0 });
  });

  it('reconciliation still runs while intake is paused', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    x.db.setPaused({ intake: true });
    x.gh.s.list = [];
    const r = await x.run();
    expect(r.reconciliations).toMatchObject([{ taskId: 'task-1', action: 'paused' }]);
  });
});

describe('intake sync: reconciliation', () => {
  it('an issue that leaves the filter pauses its task (blocked + note) and records a reconciliation event, once', async () => {
    const x = env();
    x.gh.set([{ number: 1 }, { number: 2 }]);
    await x.run();
    const t = await x.backlog.getTask('task-1');
    await x.backlog.updateTask(t.id, t.version, { status: 'ready' });
    x.gh.s.all.set(1, { number: 1, labels: ['other'] }); // relabelled: no longer matches
    x.gh.s.list = [{ number: 2 }];
    const r = await x.run();
    expect(r.reconciliations).toEqual([expect.objectContaining({ taskId: 'task-1', reason: 'left-filter', action: 'paused', detail: expect.stringContaining('ready -> blocked') })]);
    expect(x.backlog.status('task-1')).toBe('blocked');
    expect(x.backlog.status('task-2')).toBe('idea');
    expect(x.backlog.notes.find((n) => n.id === 'task-1')!.text).toMatch(/no longer matches the intake filter; task paused/);
    expect(x.backlog.tasks.has('task-1')).toBe(true); // never deleted
    expect(events(x.db, 'intake-reconcile')).toEqual([expect.objectContaining({ taskId: 'task-1', reason: 'left-filter', action: 'paused' })]);
    expect(formatIntake(r)).toContain('task-1: left-filter -> paused');

    // Next sync: nothing new to reconcile.
    expect((await x.run()).reconciliations).toEqual([]);
    expect(events(x.db, 'intake-reconcile')).toHaveLength(1);
    expectReadOnly(x.gh.s.calls);
  });

  it('names closed and no-longer-visible issues; finished tasks are left alone', async () => {
    const x = env();
    x.gh.set([{ number: 1 }, { number: 2 }, { number: 3 }]);
    await x.run();
    await x.backlog.closeTask('task-3', 'done');
    x.gh.s.all.set(1, { number: 1, state: 'closed' });
    x.gh.s.all.delete(2);
    x.gh.s.all.set(3, { number: 3, state: 'closed' });
    x.gh.s.list = [];
    const r = await x.run();
    const by = Object.fromEntries(r.reconciliations.map((c) => [c.taskId, c]));
    expect(by['task-1']).toMatchObject({ reason: 'closed', action: 'paused' });
    expect(by['task-2']).toMatchObject({ reason: 'not-visible', action: 'paused' });
    expect(by['task-3']).toMatchObject({ reason: 'closed', action: 'finished' });
    expect(x.backlog.status('task-3')).toBe('done');
  });

  it('a reassigned issue pauses its task, whether it stays in the filter or leaves it', async () => {
    const x = env();
    x.gh.set([{ number: 1, assignees: ['alice'] }, { number: 2, assignees: ['alice'] }, { number: 3 }]);
    await x.run();
    // #1 stays in the filter but is reassigned; #2 is reassigned and leaves an assignee-scoped view; #3 gets its first assignee.
    x.gh.s.all.set(2, { number: 2, assignees: ['bob'], labels: ['other'] });
    x.gh.s.list = [{ number: 1, assignees: ['bob'] }, { number: 3, assignees: ['carol'] }];
    const r = await x.run();
    const by = Object.fromEntries(r.reconciliations.map((c) => [c.taskId, c]));
    expect(by['task-1']).toMatchObject({ reason: 'reassigned', action: 'paused', detail: expect.stringContaining('alice -> bob') });
    expect(by['task-2']).toMatchObject({ reason: 'reassigned', action: 'paused' });
    expect(by['task-3']).toBeUndefined(); // unassigned -> assigned is not a reassignment
    expect(x.backlog.status('task-3')).toBe('idea');
    expect(events(x.db, 'intake-reconcile').map((e) => [e.taskId, e.reason])).toEqual([['task-1', 'reassigned'], ['task-2', 'reassigned']]);
    expect((await x.run()).reconciliations).toEqual([]);
  });

  it('a filter change (e.g. another label) pauses tasks of issues outside the new filter', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    const narrowed = { ...FILTER, labels: ['minions', 'urgent'] };
    const gh2 = fakeGh(narrowed);
    gh2.set([]);
    gh2.s.all.set(1, { number: 1 });
    const config: MinionsConfig = { ...x.config, intake: { ...x.config.intake, github: narrowed } };
    const r = await syncIntake({ db: x.db, backlog: x.backlog, config, gh: gh2.fn });
    expect(r.reconciliations).toMatchObject([{ taskId: 'task-1', reason: 'left-filter', action: 'paused' }]);
  });

  it('a task with an active lease is not moved; it is paused on a later sync once the lease ended', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    x.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, branch, config_revision, started_at, status) VALUES ('l1', 'task-1', 'engineer', 1, 'test', 'agent/x', 1, '2026-01-01T00:00:00Z', 'active')`);
    x.gh.s.list = [];
    const r = await x.run();
    expect(r.reconciliations).toMatchObject([{ taskId: 'task-1', action: 'lease-active' }]);
    expect(x.backlog.status('task-1')).toBe('idea');
    x.db.exec(`UPDATE leases SET status = 'released' WHERE id = 'l1'`);
    const later = await x.run();
    expect(later.reconciliations).toMatchObject([{ taskId: 'task-1', reason: 'left-filter', action: 'paused' }]);
    expect(x.backlog.status('task-1')).toBe('blocked');
    expect((await x.run()).reconciliations).toEqual([]);
  });

  it('an issue that returns to the filter is noted, not resumed automatically', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    x.gh.s.list = [];
    await x.run();
    x.gh.s.list = [{ number: 1 }];
    const r = await x.run();
    expect(r.reconciliations).toMatchObject([{ taskId: 'task-1', reason: 'returned', action: 'none' }]);
    expect(x.backlog.status('task-1')).toBe('blocked');
    expect(x.backlog.notes.at(-1)!.text).toContain('not resumed automatically');
  });

  it('a failed query reports an error and pauses nothing', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    x.gh.s.fail = true;
    const r = await x.run();
    expect(r.errors.join()).toContain('HTTP 401');
    expect(r.reconciliations).toEqual([]);
    expect(x.backlog.status('task-1')).toBe('idea');
  });

  it('a truncated query (more than the page cap) imports what it read but evaluates no departures', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    await x.run();
    const page = (p: number) => Array.from({ length: 100 }, (_, i) => raw({ number: 1000 + p * 100 + i }));
    for (let p = 1; p <= INTAKE_MAX_PAGES; p++) x.gh.s.routes[issuesPath(REPO, FILTER, null, p)] = ok(page(p));
    const r = await x.run();
    expect(r.complete).toBe(false);
    expect(r.warnings.join()).toContain('departures were not evaluated');
    expect(r.created).toHaveLength(INTAKE_MAX_PAGES * 100);
    expect(x.backlog.status('task-1')).toBe('idea');
  });

  it('keeps its sync record in the runtime DB meta', async () => {
    const x = env();
    x.gh.set([{ number: 1, assignees: ['alice'] }]);
    await x.run();
    const state = JSON.parse(x.db.getMeta(INTAKE_STATE_META)!) as { issues: Record<string, { taskId: string; assignees: string[]; inFilter: boolean }> };
    expect(state.issues[intakeKey(REPO, 1)]).toMatchObject({ taskId: 'task-1', assignees: ['alice'], inFilter: true });
  });
});

describe('intake sync: config and startup', () => {
  it('existing configs without intake.github stay valid; the filter is strictly validated', () => {
    const base = defaults();
    expect(validateConfig(base).intake.github).toBeUndefined();
    expect(validateConfig({ ...base, intake: { ...base.intake, github: FILTER } }).intake.github).toEqual(FILTER);
    for (const bad of [{ ...FILTER, repository: 'not a repo' }, { ...FILTER, assignee: 'two words' }, { ...FILTER, state: 'any' }, { ...FILTER, labels: ['a,b'] }, { ...FILTER, extra: 1 }]) {
      expect(() => validateConfig({ ...base, intake: { ...base.intake, github: bad } })).toThrow();
    }
  });

  it('coordinator startup runs one intake pass only when enabled, and logs the summary', async () => {
    const logs: string[] = [];
    let calls = 0;
    const sync = async () => { calls++; return { enabled: true, repository: REPO, matched: 1, created: ['task-1'], createdReady: [], existing: 0, skippedIntakePaused: 0, reconciliations: [], complete: true, warnings: [], errors: [] }; };
    await intakeOnStart(defaults(), (l) => logs.push(l), sync);
    expect(calls).toBe(0);
    const on = defaults(); on.intake.github = { ...FILTER };
    await intakeOnStart(on, (l) => logs.push(l), sync);
    expect(calls).toBe(1);
    expect(logs.join('\n')).toContain('minions: Intake sync from acme/demo: 1 matching issue(s), 1 imported (task-1)');
  });

  it('startup intake has an overall budget: a hung pass is aborted and never stalls the coordinator start', async () => {
    const on = defaults(); on.intake.github = { ...FILTER };
    const logs: string[] = [];
    let signal: AbortSignal | undefined;
    const hung = (o: { signal: AbortSignal }) => { signal = o.signal; return new Promise<never>(() => { /* never settles */ }); };
    const t0 = Date.now();
    await intakeOnStart(on, (l) => logs.push(l), hung, 50);
    expect(Date.now() - t0).toBeLessThan(4_000); // budget + grace, not the 120 s gh timeout
    expect(signal?.aborted).toBe(true);
    expect(logs.join('\n')).toMatch(/intake sync did not finish within .*starting the coordinator without it/);
  });

  it('the wrapper stop signal (task-38) aborts the startup pass; an already stopped wrapper skips it', async () => {
    const on = defaults(); on.intake.github = { ...FILTER };
    let calls = 0;
    let signal: AbortSignal | undefined;
    const sync = (o: { signal: AbortSignal }) => { calls++; signal = o.signal; return new Promise<never>((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
    const pre = new AbortController(); pre.abort();
    await intakeOnStart(on, () => {}, sync, 25_000, pre.signal);
    expect(calls).toBe(0);
    const stop = new AbortController();
    const pass = intakeOnStart(on, () => {}, sync, 25_000, stop.signal);
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(false);
    stop.abort();
    await expect(pass).rejects.toThrow('aborted'); // the wrapper logs it as a failed startup step
    expect(signal?.aborted).toBe(true);
  });

  it('an aborted pass stops reading GitHub, keeps what it imported and never pauses tasks', async () => {
    const x = env();
    x.gh.set([{ number: 1 }, { number: 2 }]);
    await x.run();
    // Issue 2 leaves the filter, but the single-issue read hangs past the budget.
    x.gh.s.list = [{ number: 1 }];
    const ctl = new AbortController();
    const api = async (path: string) => {
      if (/\/issues\/\d+$/.test(path)) { setTimeout(() => ctl.abort(), 10); return new Promise<never>(() => { /* hangs */ }); }
      return { status: 200, body: x.gh.s.list.map(raw) };
    };
    const r = await syncIntake({ db: x.db, backlog: x.backlog, config: x.config, api, signal: ctl.signal });
    expect(r.reconciliations).toEqual([]);
    expect(r.warnings.join('\n')).toContain('time budget exhausted');
    expect(x.backlog.status('task-2')).not.toBe('blocked');
    // The next unbounded pass completes the reconciliation.
    expect((await x.run()).reconciliations).toMatchObject([{ taskId: 'task-2', reason: 'left-filter', action: 'paused' }]);
  });

  it('an already-aborted signal makes no GitHub call and imports nothing', async () => {
    const x = env();
    x.gh.set([{ number: 1 }]);
    const ctl = new AbortController(); ctl.abort();
    const r = await syncIntake({ db: x.db, backlog: x.backlog, config: x.config, gh: x.gh.fn, signal: ctl.signal });
    expect(r.created).toEqual([]);
    expect(r.errors.join('\n')).toContain('time budget exhausted');
    expect(x.gh.s.calls).toEqual([]);
  });
});

describe.skipIf(!process.env.MINIONS_BACKLOG_BIN && !(() => { try { execFileSync('backlog', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })())('intake sync with the real Backlog.md adapter', () => {
  it('imports an issue with its link and provenance; a rerun creates no duplicate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minions-intake-bl-'));
    const db = new RuntimeDb(join(root, 'minions.db'));
    try {
      await writeBacklogConfig(root);
      const backlog = new BacklogMdAdapter({ root, idempotency: db.idempotency });
      const config = defaults(); config.intake.github = { ...FILTER };
      const gh = fakeGh();
      gh.set([{ number: 12, title: 'Real adapter issue', body: 'Body <!-- with a comment -->' }]);
      const r = await syncIntake({ db, backlog, config, gh: gh.fn });
      expect(r.created).toHaveLength(1);
      const t = await backlog.getTask(r.created[0]!);
      expect(t).toMatchObject({ title: 'Real adapter issue', provenance: 'external-requirement', externalLinks: [`https://github.com/${REPO}/issues/12`] });
      expect(db.idempotency.get(intakeKey(REPO, 12))).toBe(t.id);
      expect(await syncIntake({ db, backlog, config, gh: gh.fn })).toMatchObject({ created: [], existing: 1 });
      expect(await backlog.listTasks()).toHaveLength(1);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});

// task-68.6 (unattended delivery phase 5): intake.github.readyLabels, host-owned.
describe('intake sync: readyLabels import ready', () => {
  it('importStatus: every ready label present (case-insensitive) -> ready; one missing, unset or [] -> idea', () => {
    expect(importStatus({ labels: ['minions', 'minions:ready'] }, ['minions:ready'])).toBe('ready');
    expect(importStatus({ labels: ['Minions:Ready', 'P1'] }, ['minions:ready', 'p1'])).toBe('ready');
    expect(importStatus({ labels: ['minions:ready'] }, ['minions:ready', 'p1'])).toBe('idea');
    expect(importStatus({ labels: ['minions:ready'] }, [])).toBe('idea');
    expect(importStatus({ labels: ['minions:ready'] }, undefined)).toBe('idea');
  });

  it('imports labelled issues as ready, the rest as idea; reports and records the status', async () => {
    const x = env({ ...FILTER, readyLabels: ['minions:ready'] });
    x.gh.set([{ number: 1, labels: ['minions', 'minions:ready'] }, { number: 2, labels: ['minions'] }]);
    const r = await x.run();
    expect(r).toMatchObject({ created: ['task-1', 'task-2'], createdReady: ['task-1'], errors: [] });
    const tasks = await x.backlog.listTasks();
    expect(byLink(tasks, 1)).toMatchObject({ status: 'ready', provenance: 'external-requirement' });
    expect(byLink(tasks, 2)).toMatchObject({ status: 'idea' });
    expect(events(x.db, 'intake-import').map((e) => [e.taskId, e.status])).toEqual([['task-1', 'ready'], ['task-2', 'idea']]);
    expect(events(x.db, 'intake-sync').at(-1)).toMatchObject({ created: 2, createdReady: 1 });
    expect(formatIntake(r)).toContain('2 imported (task-1, task-2), 1 as ready (task-1)');
    expectReadOnly(x.gh.s.calls);
  });

  it('without readyLabels every issue is imported as idea (unchanged default)', async () => {
    const x = env();
    x.gh.set([{ number: 1, labels: ['minions', 'minions:ready'] }]);
    const r = await x.run();
    expect(r.createdReady).toEqual([]);
    expect(byLink(await x.backlog.listTasks(), 1)).toMatchObject({ status: 'idea' });
  });

  it('a label added later does not promote an already imported idea (the import decides once)', async () => {
    const x = env({ ...FILTER, readyLabels: ['minions:ready'] });
    x.gh.set([{ number: 1, labels: ['minions'] }]);
    await x.run();
    x.gh.set([{ number: 1, labels: ['minions', 'minions:ready'] }]);
    const r = await x.run();
    expect(r).toMatchObject({ created: [], createdReady: [], existing: 1 });
    expect(byLink(await x.backlog.listTasks(), 1)).toMatchObject({ status: 'idea' });
  });
});
