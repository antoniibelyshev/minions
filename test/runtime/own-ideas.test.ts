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

// Kept from the task-68.6 tests (they lived next to the removed caps).
describe('settings: intake.github.readyLabels', () => {
  it('the schema validates the labels', () => {
    const ok = defaults();
    ok.intake.github = { enabled: true, repository: 'acme/demo', labels: [], assignee: null, milestone: null, state: 'open', readyLabels: ['minions:ready'] };
    expect(() => validateConfig(ok, 'test')).not.toThrow();
    const c = defaults(); c.intake.github = { ...ok.intake.github, readyLabels: ['a,b'] };
    expect(() => validateConfig(c, 'test')).toThrow();
  });

  it('is a host-owned live setting; adding a ready label loosens policy', () => {
    expect(classifyKey('intake.github.readyLabels')).toMatchObject({ class: 'live', hostOwned: true });
    expect(settingDef('intake.github.readyLabels')).toMatchObject({ class: 'live', hostOwned: true });
    const labels = settingDef('intake.github.readyLabels')!;
    expect(labels.loosens!(undefined, ['minions:ready'])).toMatch(/imported ready/);
    expect(labels.loosens!(['a', 'b'], ['a'])).toMatch(/imported ready/); // fewer labels match more issues
    expect(labels.loosens!(['a'], ['a', 'b'])).toBeNull();
    expect(labels.loosens!(['a'], [])).toBeNull();
  });
});
