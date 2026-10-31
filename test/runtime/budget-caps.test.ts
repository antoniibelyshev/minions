// The owner's USD caps (budgets.dailyUsd / budgets.taskUsd, docs/design/autonomy.md Decision 13): estimated USD of
// today's spend and of each task's workers, enforced at claim with API-key billing only.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { assertBudgetAllowsStart, usdCaps } from '../../src/runtime/spend.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

let db: RuntimeDb;
beforeEach(() => { db = new RuntimeDb(join(tmp('minions-caps-'), 'minions.db')); });
afterEach(() => db.close());

const NOW = new Date('2026-10-31T12:00:00.000Z');
/** A worker's cumulative usage figure for a lease of `task` (1M sonnet tokens = ~$3 at the input rate). */
const usage = (task: string, lease: string, tokens: number, at = NOW) =>
  db.addEvent('usage', task, { key: `lease:${lease}`, scope: 'lease', leaseId: lease, tokens, model: 'sonnet', source: 'record' }, at.toISOString());
const cfg = (budgets: MinionsConfig['budgets']): MinionsConfig => ({ ...defaults(), budgets });

describe('USD caps', () => {
  it('measures today (UTC) and per task, and lists tasks at the per-task cap', () => {
    usage('task-1', 'l1', 2_000_000);
    usage('task-2', 'l2', 1_000_000);
    usage('task-2', 'l0', 1_000_000, new Date('2026-10-30T12:00:00.000Z')); // yesterday: per task, not today
    const c = usdCaps({ db, billing: 'api-key', config: cfg({ dailyUsd: 10, taskUsd: 5 }), now: NOW }, 'task-2');
    expect(c).toEqual({
      enforced: true,
      day: { capUsd: 10, usedUsd: 9, tokens: 3_000_000, exhausted: false },
      task: { capUsd: 5, taskId: 'task-2', usedUsd: 6, exhausted: true, atCap: ['task-1', 'task-2'] },
    });
  });

  it('refuses a start at the daily cap or for a task at its cap; never on a subscription', () => {
    usage('task-1', 'l1', 2_000_000);
    const ctx = (budgets: MinionsConfig['budgets'], billing: 'api-key' | 'subscription' = 'api-key') => ({ db, billing, config: cfg(budgets), now: NOW });
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: null, taskUsd: 5 }), 'task-1')).toThrow(/^Per-task spend cap reached for task-1: ~\$6\.00 of \$5/);
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: null, taskUsd: 5 }), 'task-2')).not.toThrow();
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: 5, taskUsd: null }), 'task-2')).toThrow(/^Daily spend cap reached: ~\$6\.00 of \$5 today/);
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: 5, taskUsd: 5 }, 'subscription'), 'task-1')).not.toThrow();
    expect(() => assertBudgetAllowsStart(ctx({ dailyUsd: null, taskUsd: null }), 'task-1')).not.toThrow();
  });
});
