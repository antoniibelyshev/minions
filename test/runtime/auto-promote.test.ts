// task-68.6 (docs/design/unattended-delivery.md decision 8, phase 5): runtime caps on the coordinator promoting its
// own ideas (agent-hypothesis, idea -> ready). Each cap under and over its limit, the exemptions, the owner override,
// the events the digest lists, and the settings. Fake clock, temp DB, in-memory backlog.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { classifyKey } from '../../src/config/setting-classes.js';
import type { MinionsError } from '../../src/core/errors.js';
import { stageEntryStatuses } from '../../src/config/workflows.js';
import { settingDef } from '../../src/host/settings.js';
import {
  AUTO_PROMOTE_DEFAULTS, AUTO_PROMOTE_EVENT, AUTO_PROMOTE_REFUSED_EVENT, autoPromoteSettings, capRefusals, checkPromotion,
  isCappedPromotion, NEEDS_OWNER_LABEL, OWNER_PROMOTE_EVENT, promotionsToday, type CapInputs, type GuardDeps, type PromotionRequest,
} from '../../src/runtime/auto-promote.js';
import { LAST_OWNER_MESSAGE_META } from '../../src/runtime/coordinator-usage.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { prepareDigest } from '../../src/runtime/digest.js';
import { defaults } from '../helpers.js';
import { FakeBacklog, makeDefaultEnv, tmp } from './fixtures.js';

const NOW = new Date('2026-10-27T10:00:00.000Z'); // 11:00 in Berlin
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const S = autoPromoteSettings({});

const inputs = (over: Partial<CapInputs> = {}): CapInputs => ({
  now: NOW, settings: S, promotedToday: 0, budgetPercent: null, lastOwnerMessageAt: hoursAgo(2), taskLabels: [], parent: null, ...over,
});

describe('capRefusals: each cap under and over its limit', () => {
  it('allows a promotion with every cap under its limit', () => {
    expect(capRefusals(inputs())).toEqual([]);
    expect(capRefusals(inputs({ promotedToday: 2, budgetPercent: 79.9, lastOwnerMessageAt: hoursAgo(3 * 24 - 1), parent: { id: 'task-1', labels: ['design'] } }))).toEqual([]);
  });

  it('perDay: 2 of 3 passes, 3 of 3 refuses; 0 means never', () => {
    expect(capRefusals(inputs({ promotedToday: 2 }))).toEqual([]);
    expect(capRefusals(inputs({ promotedToday: 3 }))).toEqual([expect.stringMatching(/daily cap is reached: 3 of 3/)]);
    expect(capRefusals(inputs({ settings: { ...S, perDay: 0 } }))).toEqual([expect.stringMatching(/auto-promotion is off/)]);
  });

  it('maxBudgetPercent: below passes, at or above refuses; no budget passes', () => {
    expect(capRefusals(inputs({ budgetPercent: 79.9 }))).toEqual([]);
    expect(capRefusals(inputs({ budgetPercent: 80 }))).toEqual([expect.stringMatching(/budget is at 80%/)]);
    expect(capRefusals(inputs({ budgetPercent: 100 }))).toHaveLength(1);
    expect(capRefusals(inputs({ budgetPercent: null }))).toEqual([]);
    expect(capRefusals(inputs({ settings: { ...S, maxBudgetPercent: 50 }, budgetPercent: 60 }))).toHaveLength(1);
  });

  it('ownerSilentDays: within passes, beyond refuses, unknown refuses (fail closed)', () => {
    expect(capRefusals(inputs({ lastOwnerMessageAt: hoursAgo(72) }))).toEqual([]); // exactly 3 days is not more than 3
    expect(capRefusals(inputs({ lastOwnerMessageAt: hoursAgo(73) }))).toEqual([expect.stringMatching(/silent for 3 day/)]);
    expect(capRefusals(inputs({ lastOwnerMessageAt: hoursAgo(24 * 10) }))).toEqual([expect.stringMatching(/silent for 10 day/)]);
    expect(capRefusals(inputs({ lastOwnerMessageAt: null }))).toEqual([expect.stringMatching(/no owner message is on record/)]);
  });

  it('needs-owner: a parent (or the task itself) with the label refuses; other labels pass', () => {
    expect(capRefusals(inputs({ parent: { id: 'task-1', labels: ['design'] } }))).toEqual([]);
    expect(capRefusals(inputs({ parent: { id: 'task-1', labels: [NEEDS_OWNER_LABEL] } }))).toEqual([expect.stringMatching(/parent task-1 carries the label needs-owner/)]);
    expect(capRefusals(inputs({ taskLabels: [NEEDS_OWNER_LABEL] }))).toEqual([expect.stringMatching(/task carries the label needs-owner/)]);
  });

  it('lists every cap that holds at once', () => {
    expect(capRefusals(inputs({ promotedToday: 5, budgetPercent: 95, lastOwnerMessageAt: null, parent: { id: 'p', labels: [NEEDS_OWNER_LABEL] } }))).toHaveLength(4);
  });
});

describe('isCappedPromotion: agent ideas entering a claimable status for the first time', () => {
  const r = (over: Partial<PromotionRequest>): PromotionRequest => ({ taskId: 'task-9', provenance: 'agent-hypothesis', from: 'idea', to: 'ready', labels: [], parent: null, ownerApproved: false, ...over });
  const entry = stageEntryStatuses(defaults());
  const fresh = { everLeased: false, promoted: false, entry };
  const leased = { everLeased: true, promoted: false, entry };
  const promoted = { everLeased: false, promoted: true, entry };
  it('derives the claimable set from the workflow stage statuses', () => {
    expect([...entry].sort()).toEqual(['changes-requested', 'implementing', 'ready', 'reviewing', 'testing']);
    for (const st of ['idea', 'blocked', 'awaiting-human', 'awaiting-ci', 'merging', 'done', 'delivered', 'cancelled'] as const) expect(entry).not.toContain(st);
  });
  it('caps agent-hypothesis idea -> ready, also from blocked and on create', () => {
    expect(isCappedPromotion(r({}), fresh)).toBe(true);
    expect(isCappedPromotion(r({ from: 'blocked' }), fresh)).toBe(true);
    expect(isCappedPromotion(r({ from: null, taskId: null }), fresh)).toBe(true);
  });
  it('caps every non-ready claimable target (changes-requested, implementing, testing, reviewing) for a never-leased task', () => {
    for (const to of ['changes-requested', 'implementing', 'testing', 'reviewing'] as const) {
      expect(isCappedPromotion(r({ to }), fresh)).toBe(true);
      expect(isCappedPromotion(r({ to, from: null, taskId: null }), fresh)).toBe(true);
      expect(isCappedPromotion(r({ to }), leased)).toBe(false);
    }
  });
  it('caps a move inside the claimable set when the task never passed the guard (it got there around it)', () => {
    expect(isCappedPromotion(r({ from: 'ready', to: 'changes-requested' }), fresh)).toBe(true);
    expect(isCappedPromotion(r({ from: 'ready', to: 'ready' }), fresh)).toBe(true);
    expect(isCappedPromotion(r({ from: 'ready', to: 'changes-requested' }), promoted)).toBe(false);
    expect(isCappedPromotion(r({ from: 'idea', to: 'ready' }), promoted)).toBe(true); // demoted to idea: counts again
  });
  it('does not cap owner requests, tickets, observed results, other targets, a promoted ready -> ready, or a task that has run', () => {
    for (const provenance of ['user-decision', 'external-requirement', 'observed-result'] as const) expect(isCappedPromotion(r({ provenance }), fresh)).toBe(false);
    for (const to of ['cancelled', 'idea', 'blocked', 'awaiting-human', 'done'] as const) expect(isCappedPromotion(r({ to }), fresh)).toBe(false);
    expect(isCappedPromotion(r({ from: 'ready' }), promoted)).toBe(false);
    expect(isCappedPromotion(r({ from: 'implementing' }), leased)).toBe(false);
  });
});

// ---------------------------------------------------------------- checkPromotion with a DB

function setup(mutate?: (c: ReturnType<typeof defaults>) => void) {
  const db = new RuntimeDb(join(tmp(), 'minions.db'));
  const backlog = new FakeBacklog();
  const config = defaults();
  mutate?.(config);
  let budget: number | null = null;
  let now = NOW;
  const deps: GuardDeps = { db, config, getTask: (id) => backlog.getTask(id), budgetPercent: () => budget, now: () => now };
  db.setMeta(LAST_OWNER_MESSAGE_META, hoursAgo(1));
  return { db, backlog, config, deps, setBudget: (b: number | null) => { budget = b; }, setNow: (d: Date) => { now = d; } };
}
const idea = (taskId: string, over: Partial<PromotionRequest> = {}): PromotionRequest =>
  ({ taskId, provenance: 'agent-hypothesis', from: 'idea', to: 'ready', labels: [], parent: null, ownerApproved: false, ...over });

async function refusal(p: Promise<unknown>): Promise<MinionsError> {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a refusal');
}

describe('checkPromotion: the runtime guard', () => {
  it('allows 3 a day, records an auto-promote event each, and refuses the 4th with a clear message', async () => {
    const t = setup();
    for (const id of ['task-1', 'task-2', 'task-3']) {
      const ticket = await checkPromotion(idea(id), t.deps);
      expect(ticket?.kind).toBe('auto');
      ticket!.commit(id);
    }
    expect(t.db.eventsOfKindSince(AUTO_PROMOTE_EVENT, '2026-10-26T00:00:00Z').map((e) => e.taskId)).toEqual(['task-1', 'task-2', 'task-3']);
    const err = await refusal(checkPromotion(idea('task-4'), t.deps));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.message).toMatch(/^Auto-promotion refused: task-4 \(agent-hypothesis\) stays idea: the daily cap is reached: 3 of 3/);
    expect(err.hint).toMatch(/ask the owner in the digest/);
    expect((err.details as { refusal: { reasons: string[] } }).refusal.reasons).toHaveLength(1);
    expect(t.db.eventsOfKindSince(AUTO_PROMOTE_REFUSED_EVENT, '2026-10-26T00:00:00Z').map((e) => e.taskId)).toEqual(['task-4']);
    expect(promotionsToday(t.db, NOW, 'Europe/Berlin')).toBe(3); // a refusal is not counted
  });

  it('counts per local day (routine.timezone): yesterday\'s promotions do not count today', async () => {
    const t = setup();
    // 22:30 UTC on 26 Oct is 23:30 in Berlin (still the 26th); 23:30 UTC is 00:30 on the 27th in Berlin.
    t.db.addEvent(AUTO_PROMOTE_EVENT, 'task-a', {}, '2026-10-26T22:30:00.000Z');
    t.db.addEvent(AUTO_PROMOTE_EVENT, 'task-b', {}, '2026-10-26T22:40:00.000Z');
    t.db.addEvent(AUTO_PROMOTE_EVENT, 'task-c', {}, '2026-10-26T23:30:00.000Z');
    expect(promotionsToday(t.db, NOW, 'Europe/Berlin')).toBe(1);
    expect(promotionsToday(t.db, NOW, 'UTC')).toBe(0);
    expect((await checkPromotion(idea('task-d'), t.deps))?.kind).toBe('auto');
  });

  it('perDay from config: 1 allows one, refuses the second', async () => {
    const t = setup((c) => { c.routine = { autoPromote: { perDay: 1 } }; });
    (await checkPromotion(idea('task-1'), t.deps))!.commit('task-1');
    expect((await refusal(checkPromotion(idea('task-2'), t.deps))).message).toMatch(/1 of 1/);
  });

  it('budget: 79% allows, 80% refuses (the default maxBudgetPercent)', async () => {
    const t = setup();
    t.setBudget(79);
    expect(await checkPromotion(idea('task-1'), t.deps)).not.toBeNull();
    t.setBudget(80);
    expect((await refusal(checkPromotion(idea('task-1'), t.deps))).message).toMatch(/budget is at 80%/);
  });

  it('owner silence: 2 days allows, 4 days refuses, no record refuses', async () => {
    const t = setup();
    t.db.setMeta(LAST_OWNER_MESSAGE_META, hoursAgo(48));
    expect(await checkPromotion(idea('task-1'), t.deps)).not.toBeNull();
    t.db.setMeta(LAST_OWNER_MESSAGE_META, hoursAgo(96));
    expect((await refusal(checkPromotion(idea('task-1'), t.deps))).message).toMatch(/silent for 4 day/);
    t.db.deleteMeta(LAST_OWNER_MESSAGE_META);
    expect((await refusal(checkPromotion(idea('task-1'), t.deps))).message).toMatch(/no owner message/);
  });

  it('needs-owner parent: refused; a parent without the label or a missing parent is fine', async () => {
    const t = setup();
    t.backlog.add({ id: 'task-50', labels: [NEEDS_OWNER_LABEL], status: 'idea' });
    t.backlog.add({ id: 'task-51', labels: ['design'], status: 'idea' });
    expect((await refusal(checkPromotion(idea('task-52', { parent: 'task-50' }), t.deps))).message).toMatch(/parent task-50 carries the label needs-owner/);
    expect(await checkPromotion(idea('task-53', { parent: 'task-51' }), t.deps)).not.toBeNull();
    expect(await checkPromotion(idea('task-54', { parent: 'task-404' }), t.deps)).not.toBeNull();
  });

  it('not capped: owner requests, imported issues, observed results; nothing recorded', async () => {
    const t = setup();
    t.db.deleteMeta(LAST_OWNER_MESSAGE_META); // would refuse a capped promotion
    t.setBudget(100);
    for (const provenance of ['user-decision', 'external-requirement', 'observed-result'] as const) {
      expect(await checkPromotion(idea('task-1', { provenance }), t.deps)).toBeNull();
    }
    expect(t.db.eventsOfKindSince(AUTO_PROMOTE_EVENT, '2000-01-01T00:00:00Z')).toEqual([]);
  });

  it('a task that already had a lease goes back to ready without a cap (recover, re-dispatch)', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1', provenance: 'agent-hypothesis', status: 'ready' });
    env.db.addEvent(AUTO_PROMOTE_EVENT, 'task-1', { from: 'idea' });
    await env.sched.claim('task-1');
    const deps: GuardDeps = { db: env.db, config: env.config, getTask: (id) => env.backlog.getTask(id), budgetPercent: () => 100, now: () => NOW };
    expect(await checkPromotion(idea('task-1', { from: 'implementing' }), deps)).toBeNull();
    // A never-leased task under the same conditions is capped.
    expect((await refusal(checkPromotion(idea('task-2'), deps))).code).toBe('POLICY_DENIED');
  });

  it('changes-requested as a target: over the cap refused, under it allowed and counted as an auto-promotion', async () => {
    const t = setup((c) => { c.routine = { autoPromote: { perDay: 1 } }; });
    const ticket = await checkPromotion(idea('task-1', { to: 'changes-requested' }), t.deps);
    expect(ticket?.kind).toBe('auto');
    ticket!.commit('task-1');
    expect(promotionsToday(t.db, NOW, 'Europe/Berlin')).toBe(1);
    const err = await refusal(checkPromotion(idea('task-2', { to: 'changes-requested' }), t.deps));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.message).toMatch(/task-2 \(agent-hypothesis\) stays idea: the daily cap is reached: 1 of 1/);
    // Same for a stage status, and for a ready task that never passed the guard.
    expect((await refusal(checkPromotion(idea('task-3', { to: 'implementing' }), t.deps))).code).toBe('POLICY_DENIED');
    expect((await refusal(checkPromotion(idea('task-4', { from: 'ready', to: 'changes-requested' }), t.deps))).code).toBe('POLICY_DENIED');
    // A promoted task moving within the claimable set is not a new promotion.
    expect(await checkPromotion(idea('task-1', { from: 'changes-requested', to: 'ready' }), t.deps)).toBeNull();
  });

  it('--owner-approved: allowed after a recent owner message, recorded as owner-promote (not counted)', async () => {
    const t = setup((c) => { c.communication.channel = 'telegram'; c.routine = { autoPromote: { perDay: 0 } }; });
    t.db.setMeta(LAST_OWNER_MESSAGE_META, new Date(NOW.getTime() - 10 * 60_000).toISOString());
    const ticket = await checkPromotion(idea('task-1', { ownerApproved: true }), t.deps);
    expect(ticket?.kind).toBe('owner');
    ticket!.commit('task-1');
    expect(t.db.eventsOfKindSince(OWNER_PROMOTE_EVENT, '2000-01-01T00:00:00Z').map((e) => e.taskId)).toEqual(['task-1']);
    expect(promotionsToday(t.db, NOW, 'Europe/Berlin')).toBe(0);
  });

  it('--owner-approved: refused without an owner message in the last 30 minutes; the terminal channel allows it', async () => {
    const t = setup((c) => { c.communication.channel = 'telegram'; });
    t.db.setMeta(LAST_OWNER_MESSAGE_META, new Date(NOW.getTime() - 45 * 60_000).toISOString());
    const err = await refusal(checkPromotion(idea('task-1', { ownerApproved: true }), t.deps));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.message).toMatch(/--owner-approved refused for task-1: no owner message in the last 30 minutes/);
    const term = setup((c) => { c.communication.channel = 'terminal'; });
    term.db.deleteMeta(LAST_OWNER_MESSAGE_META);
    expect((await checkPromotion(idea('task-1', { ownerApproved: true }), term.deps))?.kind).toBe('owner');
  });

  it('auto-promotions are listed in the digest', async () => {
    const env = makeDefaultEnv((c) => { c.routine = { enabled: true }; });
    env.db.setMeta(LAST_OWNER_MESSAGE_META, hoursAgo(1));
    const deps: GuardDeps = { db: env.db, config: env.config, getTask: (id) => env.backlog.getTask(id), budgetPercent: () => null, now: () => new Date('2026-10-27T03:00:00Z') };
    (await checkPromotion(idea('task-11'), deps))!.commit('task-11');
    const tasks = [{ id: 'task-11', title: 'Cache the build', status: 'ready' as const, prUrl: null, priority: null }];
    const d = prepareDigest(env.db, env.config, { tasks, runnable: [], spend: null }, new Date('2026-10-27T07:05:00Z'));
    expect(d.text).toMatch(/Auto-promoted \(reply "cancel <id>" or "hold <id>"\)[\s\S]*task-11/);
  });
});

describe('settings: routine.autoPromote and intake.github.readyLabels', () => {
  it('defaults are 3 / 80% / 3 days and unset fields take them', () => {
    expect(AUTO_PROMOTE_DEFAULTS).toEqual({ perDay: 3, maxBudgetPercent: 80, ownerSilentDays: 3 });
    expect(autoPromoteSettings({})).toMatchObject({ perDay: 3, maxBudgetPercent: 80, ownerSilentDays: 3, timezone: 'Europe/Berlin' });
    expect(autoPromoteSettings({ routine: { autoPromote: { perDay: 1 }, timezone: 'UTC' } })).toMatchObject({ perDay: 1, maxBudgetPercent: 80, timezone: 'UTC' });
  });

  it('the schema validates the caps and the labels', () => {
    const ok = defaults();
    ok.routine = { autoPromote: { perDay: 0, maxBudgetPercent: 100, ownerSilentDays: 1 } };
    ok.intake.github = { enabled: true, repository: 'acme/demo', labels: [], assignee: null, milestone: null, state: 'open', readyLabels: ['minions:ready'] };
    expect(() => validateConfig(ok, 'test')).not.toThrow();
    for (const bad of [{ perDay: -1 }, { maxBudgetPercent: 101 }, { ownerSilentDays: 0 }, { other: 1 }]) {
      const c = defaults(); c.routine = { autoPromote: bad as never };
      expect(() => validateConfig(c, 'test'), JSON.stringify(bad)).toThrow();
    }
    const c = defaults(); c.intake.github = { ...ok.intake.github, readyLabels: ['a,b'] };
    expect(() => validateConfig(c, 'test')).toThrow();
  });

  it('both are host-owned live settings; raising a cap or adding a ready label loosens policy', () => {
    for (const key of ['routine.autoPromote.perDay', 'routine.autoPromote.maxBudgetPercent', 'routine.autoPromote.ownerSilentDays', 'intake.github.readyLabels']) {
      expect(classifyKey(key), key).toMatchObject({ class: 'live', hostOwned: true });
      expect(settingDef(key), key).toMatchObject({ class: 'live', hostOwned: true });
    }
    const perDay = settingDef('routine.autoPromote.perDay')!;
    expect(perDay.loosens!(undefined, 5)).toMatch(/3 -> 5/);
    expect(perDay.loosens!(undefined, 2)).toBeNull();
    expect(settingDef('routine.autoPromote.ownerSilentDays')!.loosens!(3, 7)).toMatch(/3 -> 7/);
    const labels = settingDef('intake.github.readyLabels')!;
    expect(labels.loosens!(undefined, ['minions:ready'])).toMatch(/imported ready/);
    expect(labels.loosens!(['a', 'b'], ['a'])).toMatch(/imported ready/); // fewer labels match more issues
    expect(labels.loosens!(['a'], ['a', 'b'])).toBeNull();
    expect(labels.loosens!(['a'], [])).toBeNull();
  });
});

// ---------------------------------------------------------------- claim-time check

describe('claim: a never-promoted agent idea cannot start, whatever its status', () => {
  it('refuses ready and changes-requested claims without a recorded promotion, and lists them as stuck', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1', provenance: 'agent-hypothesis', status: 'changes-requested' });
    env.backlog.add({ id: 'task-2', provenance: 'agent-hypothesis', status: 'ready' });
    for (const id of ['task-1', 'task-2']) {
      const err = await refusal(env.sched.claim(id));
      expect(err.code, id).toBe('POLICY_DENIED');
      expect(err.message).toMatch(new RegExp(`Task ${id} cannot be claimed: ${id} is an agent idea \\(agent-hypothesis\\) that was never promoted`));
      expect(env.db.leases({ taskId: id, all: true })).toEqual([]);
    }
    expect(env.db.eventsOfKindSince(AUTO_PROMOTE_REFUSED_EVENT, '2000-01-01T00:00:00Z').map((e) => e.taskId)).toEqual(['task-1', 'task-2']);
    const next = await env.sched.next();
    expect(next.runnable.map((s) => s.taskId)).toEqual([]);
    expect(next.stuck.map((s) => s.taskId).sort()).toEqual(['task-1', 'task-2']);
    expect(next.stuck[0]!.reason).toMatch(/never promoted/);
  });

  it('allows the claim after an auto-promote or owner-promote event, and for other provenances', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1', provenance: 'agent-hypothesis', status: 'changes-requested' });
    env.backlog.add({ id: 'task-2', provenance: 'agent-hypothesis', status: 'ready' });
    env.backlog.add({ id: 'task-3', provenance: 'user-decision', status: 'ready' });
    env.db.addEvent(AUTO_PROMOTE_EVENT, 'task-1', { from: 'idea' });
    env.db.addEvent(OWNER_PROMOTE_EVENT, 'task-2', { from: 'idea' });
    const next = await env.sched.next();
    expect(next.stuck).toEqual([]);
    // None refused by the promotion check (some may wait on capacity: the default limit is two active tasks).
    expect([...next.runnable, ...next.waiting].map((s) => s.taskId).sort()).toEqual(['task-1', 'task-2', 'task-3']);
    for (const id of ['task-1', 'task-2']) expect((await env.sched.claim(id)).task.id).toBe(id);
  });
});
