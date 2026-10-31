// task-130: the auto-promotion caps are gone. A never-promoted agent idea is claimed like any other task, with no
// owner message on record; an old config that still carries routine.autoPromote loads and the block is ignored.
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { classifyKey } from '../../src/config/setting-classes.js';
import { settingDef } from '../../src/host/settings.js';
import { lastOwnerMessageAt } from '../../src/runtime/coordinator-usage.js';
import { defaults } from '../helpers.js';
import { makeDefaultEnv } from './fixtures.js';

describe('claim: an agent idea set ready starts without a recorded promotion or an owner message', () => {
  it('lists ready and changes-requested agent ideas as claimable, not stuck, and claims them', async () => {
    const env = makeDefaultEnv();
    expect(lastOwnerMessageAt(env.db)).toBeNull();
    env.backlog.add({ id: 'task-1', provenance: 'agent-hypothesis', status: 'changes-requested' });
    env.backlog.add({ id: 'task-2', provenance: 'agent-hypothesis', status: 'ready' });
    const next = await env.sched.next();
    expect(next.stuck).toEqual([]);
    // Some may wait on capacity (the default limit is two active tasks); none is refused.
    expect([...next.runnable, ...next.waiting].map((s) => s.taskId).sort()).toEqual(['task-1', 'task-2']);
    for (const id of ['task-1', 'task-2']) expect((await env.sched.claim(id)).task.id).toBe(id);
    expect(env.db.all('SELECT kind FROM events WHERE kind LIKE ?', 'auto-promote%')).toEqual([]);
  });
});

describe('config: routine.autoPromote is legacy', () => {
  it('an old config carrying the block still loads', () => {
    const c = defaults();
    c.routine = { autoPromote: { perDay: 0, maxBudgetPercent: 100, ownerSilentDays: 1 } };
    expect(() => validateConfig(c, 'test')).not.toThrow();
  });

  it('is no longer a host setting', () => {
    for (const key of ['routine.autoPromote.perDay', 'routine.autoPromote.maxBudgetPercent', 'routine.autoPromote.ownerSilentDays']) {
      expect(settingDef(key), key).toBeUndefined();
    }
  });
});
