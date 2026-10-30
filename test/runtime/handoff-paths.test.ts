// Hand-off file paths (task-9) in the unit tier: a lease id can never name a path outside the briefs and results
// directories, whichever entry point receives it. The claim → submit → record flows are in handoff.test.ts.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import { briefPath, fetchBrief, recordSubmitted, rejectedPath, submissionPath, submitResult, type HandoffPaths } from '../../src/runtime/handoff.js';
import { makeDbEnv } from './fixtures.js';

const fail = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a failure');
};

describe('hand-off paths', () => {
  it('lease ids cannot traverse paths', async () => {
    const env = makeDbEnv();
    const p: HandoffPaths = { briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') };
    const caller = { role: 'engineer', cwd: env.layout.repo };
    for (const id of ['lease-../../minions', 'lease-a/b', '../lease-x', 'lease-a\\b', 'lease-.', 'lease-', '', 'lease-abc/../x', 'lease-abc\n']) {
      expect((await fail(fetchBrief(env.db, p, id, caller))).code, JSON.stringify(id)).toBe('PRECONDITION');
      expect((await fail(submitResult(env.db, p, id, '{}', caller))).code, JSON.stringify(id)).toBe('PRECONDITION');
      expect((await fail(recordSubmitted(env.sched, p, id))).code, JSON.stringify(id)).toBe('PRECONDITION');
      for (const f of [briefPath, submissionPath, rejectedPath]) expect(() => f(p, id)).toThrow(/Invalid lease id/);
    }
  });

  it('a valid lease id maps into the briefs and results directories', () => {
    const p: HandoffPaths = { briefs: '/s/briefs', results: '/s/results' };
    expect(briefPath(p, 'lease-0123abcd')).toMatch(/^\/s\/briefs\/lease-0123abcd/);
    expect(submissionPath(p, 'lease-0123abcd')).toMatch(/^\/s\/results\/lease-0123abcd/);
    expect(rejectedPath(p, 'lease-0123abcd')).toMatch(/^\/s\/results\/lease-0123abcd/);
  });
});
