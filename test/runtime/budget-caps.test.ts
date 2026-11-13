// The owner's spend caps (docs/design/autonomy.md Decisions 13 and 15): USD caps (budgets.dailyUsd / taskUsd) against
// the estimate, enforced with API-key billing only; token caps (budgets.dailyTokens / taskTokens) against the recorded
// tokens, enforced on any billing. The day starts at local midnight in routine.timezone.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { assertBudgetAllowsStart, dayCapWarning, humanSpend, spendCaps, spendReport } from '../../src/runtime/spend.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

let db: RuntimeDb;
beforeEach(() => { db = new RuntimeDb(join(tmp('minions-caps-'), 'minions.db')); });
afterEach(() => db.close());

const NOW = new Date('2026-10-31T12:00:00.000Z');
/** A worker's cumulative usage figure for a lease of `task` (1M sonnet tokens = ~$3 at the input rate). */
const usage = (task: string, lease: string, tokens: number, at = NOW) =>
  db.addEvent('usage', task, { key: `lease:${lease}`, scope: 'lease', leaseId: lease, tokens, model: 'sonnet', source: 'record' }, at.toISOString());
/** A coordinator session's cumulative figure. */
const session = (id: string, tokens: number, at = NOW) =>
  db.addEvent('usage', null, { key: `session:${id}`, scope: 'session', session: id, tokens, model: 'sonnet', source: 'transcript' }, at.toISOString());
type Budgets = MinionsConfig['budgets'];
const cfg = (budgets: Budgets, timezone?: string): MinionsConfig => ({ ...defaults(), budgets, ...(timezone ? { routine: { timezone } } : {}) });
const off: Budgets = { dailyUsd: null, taskUsd: null };
const ctx = (budgets: Budgets, billing: 'api-key' | 'subscription' = 'api-key', now = NOW, timezone?: string) => ({ db, billing, config: cfg(budgets, timezone), now });

describe('USD caps', () => {
  it('measures today (local day) and per task, and lists tasks at the per-task cap', () => {
    usage('task-1', 'l1', 2_000_000);
    usage('task-2', 'l2', 1_000_000);
    usage('task-2', 'l0', 1_000_000, new Date('2026-10-30T12:00:00.000Z')); // yesterday: per task, not today
    const c = spendCaps(ctx({ dailyUsd: 10, taskUsd: 5 }), 'task-2');
    expect(c).toEqual({
      enforced: true, timezone: 'Europe/Berlin', dayStart: '2026-10-30T23:00:00.000Z',
      day: { capUsd: 10, usedUsd: 9, capTokens: null, tokens: 3_000_000, usdReached: false, tokensReached: false, exhausted: false },
      task: {
        capUsd: 5, capTokens: null, taskId: 'task-2', usedUsd: 6, usedTokens: 2_000_000, exhausted: true,
        atCap: ['task-1', 'task-2'], atCapUsd: { 'task-1': 6, 'task-2': 6 }, atCapTokens: { 'task-1': 2_000_000, 'task-2': 2_000_000 }, blocked: ['task-1', 'task-2'],
      },
    });
  });

  it('refuses a start at the daily cap or for a task at its cap; never on a subscription', () => {
    usage('task-1', 'l1', 2_000_000);
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: null, taskUsd: 5 }), 'task-1')).toThrow(/^Per-task spend cap reached for task-1: ~\$6\.00 of \$5 \(estimated\)/);
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: null, taskUsd: 5 }), 'task-2')).not.toThrow();
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: 5, taskUsd: null }), 'task-2')).toThrow(/^Daily spend cap reached: ~\$6\.00 of \$5 \(estimated\) today/);
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: 5, taskUsd: 5 }, 'subscription'), 'task-1')).not.toThrow();
    expect(() => assertBudgetAllowsStart(ctx(off), 'task-1')).not.toThrow();
    // On a subscription the USD caps stop nothing: the task is shown at the cap, not blocked.
    expect(spendCaps(ctx({ dailyUsd: 5, taskUsd: 5 }, 'subscription')).task).toMatchObject({ atCap: ['task-1'], blocked: [] });
  });

  it('status shows the caps and the tasks at the per-task cap', () => {
    usage('task-1', 'l1', 2_000_000);
    const line = (budgets: Budgets, billing: 'api-key' | 'subscription' = 'api-key') =>
      humanSpend(spendReport(ctx(budgets, billing))).split('\n').slice(2);
    expect(line({ dailyUsd: 40, taskUsd: 5 })).toEqual(['spend caps: daily ~$6.00 of $40; per-task $5 (reached: task-1 ~$6.00)']);
    expect(line({ dailyUsd: 5, taskUsd: null })).toEqual(['spend caps: daily ~$6.00 of $5 (reached: new stages wait); per-task off']);
    expect(line({ dailyUsd: 40, taskUsd: null }, 'subscription')).toEqual(['spend caps: daily ~$6.00 of $40; per-task off (not enforced: subscription billing)']);
    expect(line(off)).toEqual(['budget: none']);
  });
});

describe('token caps', () => {
  it('the daily cap counts the coordinator and the workers; the per-task cap only the task\'s workers', () => {
    usage('task-1', 'l1', 3_000_000);
    session('s1', 2_000_000);
    const c = spendCaps(ctx({ ...off, dailyTokens: 5_000_000, taskTokens: 4_000_000 }, 'subscription'), 'task-1');
    expect(c.day).toEqual({ capUsd: null, usedUsd: 15, capTokens: 5_000_000, tokens: 5_000_000, usdReached: false, tokensReached: true, exhausted: true });
    expect(c.task).toMatchObject({ capTokens: 4_000_000, usedTokens: 3_000_000, exhausted: false, atCap: [], blocked: [] });
  });

  it('are enforced on a subscription: daily before any start, per task for that task only', () => {
    usage('task-1', 'l1', 4_000_000);
    const sub = (b: Partial<Budgets>) => ctx({ ...off, ...b }, 'subscription');
    expect(() => assertBudgetAllowsStart(sub({ taskTokens: 4_000_000 }), 'task-1')).toThrow(/^Per-task spend cap reached for task-1: 4M of 4M tokens\. Its next stage is refused\./);
    expect(() => assertBudgetAllowsStart(sub({ taskTokens: 4_000_000 }), 'task-2')).not.toThrow();
    expect(() => assertBudgetAllowsStart(sub({ dailyTokens: 4_000_000 }), 'task-2')).toThrow(/^Daily spend cap reached: 4M of 4M tokens today \(since 2026-10-30T23:00:00\.000Z, Europe\/Berlin midnight\)/);
    expect(() => assertBudgetAllowsStart(sub({ dailyTokens: 4_000_001 }))).not.toThrow();
    expect(spendCaps(sub({ taskTokens: 4_000_000 })).task.blocked).toEqual(['task-1']);
  });

  it('with API-key billing either cap stops work, and the message names the one reached', () => {
    usage('task-1', 'l1', 2_000_000); // ~$6
    const api = (b: Partial<Budgets>) => ctx({ ...off, ...b });
    expect(() => assertBudgetAllowsStart(api({ dailyUsd: 100, dailyTokens: 1_000_000 }))).toThrow(/^Daily spend cap reached: 2M of 1M tokens today/);
    expect(() => assertBudgetAllowsStart(api({ dailyUsd: 5, dailyTokens: 10_000_000 }))).toThrow(/^Daily spend cap reached: ~\$6\.00 of \$5 \(estimated\) today/);
    expect(() => assertBudgetAllowsStart(api({ taskUsd: 5, taskTokens: 1_000_000 }), 'task-1')).toThrow(/^Per-task spend cap reached for task-1: 2M of 1M tokens, ~\$6\.00 of \$5 \(estimated\)\./);
    expect(() => assertBudgetAllowsStart(api({ dailyUsd: 100, dailyTokens: 10_000_000, taskUsd: 100, taskTokens: 10_000_000 }), 'task-1')).not.toThrow();
  });

  it('the day resets at local midnight in routine.timezone, not at UTC midnight', () => {
    const b: Budgets = { ...off, dailyTokens: 1_000_000 };
    // Berlin is UTC+1 here (after the DST change on Oct 25): its Oct 31 starts at 2026-10-30T23:00Z.
    usage('task-1', 'l1', 1_000_000, new Date('2026-10-30T22:30:00.000Z'));
    expect(spendCaps(ctx(b, 'subscription', new Date('2026-10-30T22:50:00.000Z'))).day).toMatchObject({ tokens: 1_000_000, exhausted: true });
    // Past Berlin midnight: a new day, nothing counted yet.
    expect(spendCaps(ctx(b, 'subscription', new Date('2026-10-30T23:10:00.000Z'))).day).toMatchObject({ tokens: 0, exhausted: false });
    // With routine.timezone UTC the same instant is still Oct 30.
    expect(spendCaps(ctx(b, 'subscription', new Date('2026-10-30T23:10:00.000Z'), 'UTC'))).toMatchObject({ dayStart: '2026-10-30T00:00:00.000Z', day: { tokens: 1_000_000, exhausted: true } });
    // A figure that grows across midnight counts only its growth since midnight.
    usage('task-1', 'l1', 1_400_000, new Date('2026-10-30T23:30:00.000Z'));
    expect(spendCaps(ctx(b, 'subscription', new Date('2026-10-30T23:40:00.000Z'))).day.tokens).toBe(400_000);
  });

  it('warns at 50% and 80% of an enforced daily cap, not below and not at the cap', () => {
    const warn = (tokens: number, b: Partial<Budgets> = { dailyTokens: 10_000_000 }, billing: 'api-key' | 'subscription' = 'subscription') => {
      db.exec("DELETE FROM events WHERE kind = 'usage'");
      usage('task-1', 'l1', tokens);
      return dayCapWarning(spendCaps(ctx({ ...off, ...b }, billing)));
    };
    expect(warn(4_900_000)).toBeNull();
    expect(warn(5_000_000)).toMatchObject({ threshold: 50, key: 'tokens:10000000:50', text: expect.stringMatching(/^Daily spend cap 50% reached: 5M of 10M tokens today \(Europe\/Berlin\)/) });
    expect(warn(8_100_000)).toMatchObject({ threshold: 80, key: 'tokens:10000000:80' });
    expect(warn(10_000_000)).toBeNull();
    // A USD cap warns only where it is enforced; the higher share wins.
    expect(warn(2_000_000, { dailyUsd: 10 }, 'subscription')).toBeNull();
    expect(warn(2_000_000, { dailyUsd: 10 }, 'api-key')).toMatchObject({ threshold: 50, key: 'usd:10:50' });
    expect(warn(2_000_000, { dailyUsd: 7, dailyTokens: 3_000_000 }, 'api-key')).toMatchObject({ threshold: 80, key: 'usd:7:80' });
  });

  it('status says enforced when token caps are set and keeps the USD display', () => {
    usage('task-9', 'l9', 6_100_000);
    usage('task-2', 'l2', 1_000_000);
    const line = (budgets: Partial<Budgets>, billing: 'api-key' | 'subscription' = 'subscription') =>
      humanSpend(spendReport(ctx({ ...off, ...budgets }, billing))).split('\n').slice(2);
    expect(line({ dailyUsd: 40, taskUsd: 25, dailyTokens: 20_000_000, taskTokens: 4_000_000 })).toEqual([
      'spend caps (day from Europe/Berlin midnight): daily 7.1M of 20M tokens, ~$21.30 of $40; per-task 4M tokens, $25 (reached: task-9 6.1M tokens ~$18.30) (token caps enforced; USD not enforced: subscription billing)',
    ]);
    expect(line({ dailyTokens: 5_000_000 })).toEqual(['spend caps (day from Europe/Berlin midnight): daily 7.1M of 5M tokens (reached: new stages wait); per-task off (enforced)']);
    expect(line({ taskTokens: 4_000_000, taskUsd: 25 }, 'api-key')).toEqual(['spend caps (day from Europe/Berlin midnight): daily off; per-task 4M tokens, $25 (reached: task-9 6.1M tokens ~$18.30) (enforced)']);
    const json = spendReport(ctx({ ...off, dailyTokens: 20_000_000 }, 'subscription')).caps!;
    expect(json).toMatchObject({ enforced: false, timezone: 'Europe/Berlin', day: { capTokens: 20_000_000, tokens: 7_100_000, exhausted: false } });
  });
});
