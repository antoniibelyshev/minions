// QA (task-40, item 5): the in-flight mark is per issue and is cleared once the task is linked.
// Fake backlog, mocked read-only GitHub, temp state only.
import { describe, expect, it } from 'vitest';
import type { ApiResponse } from '../../src/runtime/ci.js';
import { INTAKE_INFLIGHT_META, intakeKey, syncIntake, type GithubIntakeConfig } from '../../src/runtime/intake-sync.js';
import { FakeBacklog, makeDefaultEnv } from './fixtures.js';

const REPO = 'acme/demo';
const FILTER: GithubIntakeConfig = { enabled: true, repository: REPO, labels: [], assignee: null, milestone: null, state: 'open' };
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const issue = (n: number) => ({ number: n, title: `Issue ${n}`, body: '', state: 'open', html_url: url(n), assignees: [], labels: [], milestone: null });
const api = (numbers: number[]) => async (path: string): Promise<ApiResponse> =>
  path.startsWith(`/repos/${REPO}/issues?`) ? { status: 200, body: numbers.map(issue) } : { status: 404, body: null, error: 'HTTP 404' };
const marks = (db: { getMeta(k: string): string | undefined }) => JSON.parse(db.getMeta(INTAKE_INFLIGHT_META) ?? '{}') as Record<string, string>;

describe('intake in-flight mark (task-40 QA)', () => {
  it('a fresh mark blocks only its own issue; other issues import and the mark is kept until the task links', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const backlog = new FakeBacklog();
    const now = new Date('2026-10-23T12:00:00Z');
    const at = new Date(now.getTime() - 60_000).toISOString();
    e.db.setMeta(INTAKE_INFLIGHT_META, JSON.stringify({ [intakeKey(REPO, 1)]: at }));
    const r = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1, 2]), now: () => now });
    expect(r.created).toHaveLength(1);
    expect((await backlog.listTasks()).map((t) => t.title)).toEqual([expect.stringContaining('Issue 2')]);
    expect(marks(e.db)).toEqual({ [intakeKey(REPO, 1)]: at }); // #2's own mark was set and cleared; #1's kept

    // The interrupted create for #1 lands: the next pass links it, creates nothing, and drops the mark.
    backlog.add({ id: 'task-99', status: 'idea', externalLinks: [url(1)] });
    const r2 = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1, 2]), now: () => now });
    expect(r2).toMatchObject({ created: [], existing: 2, errors: [] });
    expect(e.db.idempotency.get(intakeKey(REPO, 1))).toBe('task-99');
    expect(e.db.getMeta(INTAKE_INFLIGHT_META)).toBeUndefined();
  });

  it('a corrupt mark row does not block imports and is replaced', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const backlog = new FakeBacklog();
    e.db.setMeta(INTAKE_INFLIGHT_META, 'not json');
    const r = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1]) });
    expect(r).toMatchObject({ errors: [] });
    expect(r.created).toHaveLength(1);
    expect(e.db.getMeta(INTAKE_INFLIGHT_META)).toBeUndefined();
  });
});
