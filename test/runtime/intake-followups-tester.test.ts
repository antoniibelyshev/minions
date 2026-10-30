// task-39 tester and follow-ups: the in-process parts of the GitHub intake follow-ups (the provenance fallback hook,
// its cost, and the aborted list read report). No live /state. The parts with real processes (a hung gh, run()'s
// signal handling, the real Backlog.md CLI) are in intake-followups.test.ts.
import { describe, expect, it } from 'vitest';
import { toTask } from '../../src/backlog/backlogmd.js';
import type { ApiGet } from '../../src/runtime/ci.js';
import {
  formatIntake, INTAKE_ABORTED, INTAKE_STATE_META, intakeKey, intakeProvenanceFallback, intakeTrackedTaskIds, syncIntake, type GithubIntakeConfig,
} from '../../src/runtime/intake-sync.js';
import { makeUnitDefaultEnv } from './fixtures.js';

const REPO = 'acme/demo';
const FILTER: GithubIntakeConfig = { enabled: true, repository: REPO, labels: ['minions'], assignee: null, milestone: null, state: 'open' };
const issue = (n: number) => ({ number: n, title: `Issue ${n}`, body: '', state: 'open', html_url: `https://github.com/${REPO}/issues/${n}`, assignees: [], labels: [{ name: 'minions' }], milestone: null });

describe('provenance fallback for intake-tracked tasks (item 2)', () => {
  const rawNoMeta = { id: 'TASK-7', title: 'Imported', description: 'An issue body without a meta block' };
  const rawBadMeta = { id: 'TASK-7', title: 'Imported', description: 'Body\n\n<!-- minions:meta {not json} -->' };
  const rawMetaNoProv = { id: 'TASK-7', title: 'Imported', description: 'Body\n\n<!-- minions:meta {"branch":null} -->' };

  it('tracked tasks fall back to external-requirement; other tasks keep user-decision; a valid meta provenance wins', () => {
    const e = makeUnitDefaultEnv();
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
    const e = makeUnitDefaultEnv();
    e.db.setMeta(INTAKE_STATE_META, '{broken');
    expect(intakeProvenanceFallback(() => e.db)('task-1')).toBeUndefined();
  });
});

describe('aborted list read report (item 4)', () => {
  it('an aborted or failed list read reports no matched count, not the pages read so far', async () => {
    const e = makeUnitDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
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
    const base = { enabled: true, repository: REPO, created: [], createdReady: [], existing: 2, skippedIntakePaused: 0, reconciliations: [], warnings: [], errors: [] };
    expect(formatIntake({ ...base, matched: 2, complete: true })).toContain(': 2 matching issue(s), 0 imported, 2 already');
    expect(formatIntake({ ...base, matched: 1000, complete: false })).toContain(': at least 1000 matching issue(s)');
  });
});

describe('provenance fallback hook: cost', () => {
  it('only consults the DB for tasks without a usable meta provenance', () => {
    let calls = 0;
    const fallback = (id: string) => { calls++; return id === 'task-1' ? 'external-requirement' as const : undefined; };
    const good = { id: 'TASK-1', description: 'B\n\n<!-- minions:meta {"provenance":"user-decision"} -->' };
    for (let i = 0; i < 50; i++) toTask(good, { provenanceFallback: fallback });
    expect(calls).toBe(0);
    toTask({ id: 'TASK-1', description: 'no meta' }, { provenanceFallback: fallback });
    expect(calls).toBe(1);
  });

  it('stays cheap with a large sync record and many meta-less tasks', () => {
    const e = makeUnitDefaultEnv();
    const issues: Record<string, unknown> = {};
    for (let n = 1; n <= 1000; n++) {
      issues[intakeKey('acme/demo', n)] = { taskId: `task-${n}`, url: `https://github.com/acme/demo/issues/${n}`, repository: 'acme/demo', number: n, assignees: [], inFilter: true, lastSeenAt: 'x' };
    }
    e.db.setMeta(INTAKE_STATE_META, JSON.stringify({ version: 1, issues }));
    const fallback = intakeProvenanceFallback(() => e.db);
    const t = Date.now();
    for (let i = 1; i <= 500; i++) expect(toTask({ id: `TASK-${i}`, description: 'x' }, { provenanceFallback: fallback }).provenance).toBe('external-requirement');
    // Generous bound: 500 meta reads + parses of a 1000-entry record.
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('a getMeta that throws falls back to the default instead of breaking the read', () => {
    const fallback = intakeProvenanceFallback(() => ({ getMeta: () => { throw new Error('database is locked'); } }));
    expect(toTask({ id: 'TASK-1', description: 'x' }, { provenanceFallback: fallback }).provenance).toBe('user-decision');
  });

  it('a db getter that throws falls back to the default instead of breaking the read', () => {
    const fallback = intakeProvenanceFallback(() => { throw new Error('SQLITE_CANTOPEN'); });
    expect(toTask({ id: 'TASK-1', description: 'x' }, { provenanceFallback: fallback }).provenance).toBe('user-decision');
  });
});
