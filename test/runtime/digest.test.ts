// task-68.5 (docs/design/unattended-delivery.md decision 7, phase 4): held notifications and the owner digest.
// Local time in an IANA zone (DST, a missed day), the per-kind default holds, the hold-back, the digest wake in
// the routine pass with catch-up, and the deterministic composition with numbered polls. Fake clock throughout.
import { describe, expect, it } from 'vitest';
import { MinionsConfigSchema } from '../../src/config/schema.js';
import { LAST_OWNER_MESSAGE_META } from '../../src/runtime/coordinator-usage.js';
import {
  composeDigest, DEFAULT_HOLDS, digestStatus, holdFor, holdUntil, lastDigestSlot, nextDigestAt, parsePoll, prepareDigest, reholdExpired,
  AUTO_PROMOTE_EVENT, MAX_DIGEST_WAKES_PER_SLOT, type DigestInput,
} from '../../src/runtime/digest.js';
import { ack, enqueue, isHeld, MAX_TEXT_LENGTH, NOTIFICATION_KINDS, pending, type OutboxItem } from '../../src/runtime/outbox.js';
import { routineSettings, runRoutinePass, WAKE_EVENT, type CoordinatorView, type RoutinePassDeps, type RoutineSettings } from '../../src/runtime/routine.js';
import { localDayStart, localStamp, zonedParts, zonedTimeToUtc } from '../../src/runtime/zoned-time.js';
import { makeEnv } from './fixtures.js';

const BERLIN: RoutineSettings = routineSettings({ routine: { enabled: true } });
const at = (iso: string) => new Date(iso);

describe('zoned time (Intl, no dependency)', () => {
  it('maps Berlin wall-clock times to instants across both DST changes of 2026', () => {
    // Summer (CEST, UTC+2), winter (CET, UTC+1); DST ends Sun 25 Oct 2026 and starts Sun 29 Mar 2026.
    expect(zonedTimeToUtc(2026, 10, 24, 8, 0, 'Europe/Berlin').toISOString()).toBe('2026-10-24T06:00:00.000Z');
    expect(zonedTimeToUtc(2026, 10, 25, 8, 0, 'Europe/Berlin').toISOString()).toBe('2026-10-25T07:00:00.000Z');
    expect(zonedTimeToUtc(2026, 3, 28, 8, 0, 'Europe/Berlin').toISOString()).toBe('2026-03-28T07:00:00.000Z');
    expect(zonedTimeToUtc(2026, 3, 29, 8, 0, 'Europe/Berlin').toISOString()).toBe('2026-03-29T06:00:00.000Z');
    // A time inside the spring-forward gap lands after it (02:30 does not exist: 03:30 CEST).
    expect(localStamp(zonedTimeToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin'), 'Europe/Berlin')).toBe('2026-03-29T03:30');
    // Day overflow is normalised; other zones work too.
    expect(zonedTimeToUtc(2026, 12, 32, 8, 0, 'America/New_York').toISOString()).toBe('2027-01-01T13:00:00.000Z');
  });

  it('local parts and the local day start (the routine\'s "today")', () => {
    expect(zonedParts(at('2026-10-26T23:30:00Z'), 'Europe/Berlin')).toMatchObject({ year: 2026, month: 10, day: 27, hour: 0, minute: 30 });
    expect(localDayStart(at('2026-10-26T23:30:00Z'), 'Europe/Berlin')).toBe('2026-10-26T23:00:00.000Z');
    expect(localDayStart(at('2026-07-01T12:00:00Z'), 'Europe/Berlin')).toBe('2026-06-30T22:00:00.000Z');
    expect(localDayStart(at('2026-10-26T23:30:00Z'), 'UTC')).toBe('2026-10-26T00:00:00.000Z');
  });

  it('config: digestAt must be HH:MM, timezone an IANA zone', () => {
    const base = MinionsConfigSchema.shape.routine;
    expect(base.safeParse({ digestAt: ['08:00', '18:30'], timezone: 'Europe/Berlin' }).success).toBe(true);
    expect(base.safeParse({ digestAt: ['8:00'] }).success).toBe(false);
    expect(base.safeParse({ digestAt: ['24:00'] }).success).toBe(false);
    expect(base.safeParse({ digestAt: [] }).success).toBe(false);
    expect(base.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false);
  });
});

describe('digest times', () => {
  it('the last time at or before now and the next one, in the local zone across DST', () => {
    expect(lastDigestSlot(at('2026-10-27T07:00:00Z'), BERLIN)).toEqual({ at: '2026-10-27T07:00:00.000Z', local: '2026-10-27T08:00', key: 'digest:2026-10-27T08:00' });
    expect(lastDigestSlot(at('2026-10-27T06:59:00Z'), BERLIN).local).toBe('2026-10-26T08:00');
    expect(nextDigestAt(at('2026-10-27T06:59:00Z'), BERLIN)).toBe('2026-10-27T07:00:00.000Z');
    expect(nextDigestAt(at('2026-10-27T07:00:00Z'), BERLIN)).toBe('2026-10-28T07:00:00.000Z');
    // Saturday 24 Oct (CEST) -> Sunday 25 Oct (CET): the next 08:00 is 25 h later in UTC.
    expect(nextDigestAt(at('2026-10-24T06:30:00Z'), BERLIN)).toBe('2026-10-25T07:00:00.000Z');
    const two = { digestAt: ['08:00', '18:00'], timezone: 'Europe/Berlin' };
    expect(lastDigestSlot(at('2026-10-27T18:00:00Z'), two).local).toBe('2026-10-27T18:00');
    expect(nextDigestAt(at('2026-10-27T12:00:00Z'), two)).toBe('2026-10-27T17:00:00.000Z');
  });
});

describe('holds', () => {
  const now = at('2026-10-27T10:00:00Z');
  const next = '2026-10-28T07:00:00.000Z';
  const ctx = { settings: BERLIN, now, lastOwnerMessageAt: null };

  it('the per-kind default table: deliveries, features and questions wait; owner replies, approvals and blockers do not', () => {
    expect(Object.keys(DEFAULT_HOLDS).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    const held = NOTIFICATION_KINDS.filter((k) => holdUntil(k, undefined, ctx) !== null);
    expect(held).toEqual(['delivered', 'feature', 'question']);
    expect(holdUntil('delivered', 'default', ctx)).toBe(next);
    for (const k of ['goal-ack', 'status', 'approval', 'blocker', 'other'] as const) expect(holdUntil(k, undefined, ctx)).toBeNull();
  });

  it('explicit holds win; defaults only while the routine is on and the owner is not in the chat', () => {
    expect(holdUntil('status', 'digest', ctx)).toBe(next);
    expect(holdUntil('question', 'none', ctx)).toBeNull();
    const off = { ...ctx, settings: { ...BERLIN, enabled: false } };
    expect(holdUntil('delivered', undefined, off)).toBeNull();
    expect(holdUntil('delivered', 'digest', off)).toBe(next); // explicit: still held until the next digest time
    expect(holdUntil('question', undefined, { ...ctx, lastOwnerMessageAt: '2026-10-27T09:45:00.000Z' })).toBeNull(); // 15 min ago
    expect(holdUntil('question', undefined, { ...ctx, lastOwnerMessageAt: '2026-10-27T09:00:00.000Z' })).toBe(next);
    expect(() => holdUntil('digest', 'digest', ctx)).toThrow(/cannot be held/);
    expect(() => holdUntil('question', 'later', ctx)).toThrow(/Unknown hold/);
  });

  it('a held item is not pending before its time; the hold-back keeps it for the digest while the routine is on', () => {
    const env = makeEnv((c) => { c.routine = { enabled: true }; });
    const clock = () => now;
    enqueue(env.db, { key: 'delivered:task-1:abc', kind: 'delivered', taskId: 'task-1', text: 'Delivered task-1', holdUntil: holdFor(env.db, env.config, 'delivered', undefined, now) }, clock);
    enqueue(env.db, { key: 'blocker:task-2:1', kind: 'blocker', taskId: 'task-2', text: 'task-2 is blocked', holdUntil: holdFor(env.db, env.config, 'blocker', undefined, now) }, clock);
    expect(pending(env.db, {}, clock).map((i) => i.key)).toEqual(['blocker:task-2:1']);
    const item = pending(env.db, { includeWaiting: true }, clock).find((i) => i.key === 'delivered:task-1:abc')!;
    expect(item).toMatchObject({ nextAttemptAt: next, attempts: 0 });
    expect(isHeld(item)).toBe(true);
    // The digest time comes but the digest did not go out yet: the hold-back moves it on to the next digest time.
    const later = at('2026-10-28T07:10:00Z');
    expect(reholdExpired(env.db, env.config, later)).toBe(1);
    expect(pending(env.db, {}, () => later).map((i) => i.key)).toEqual(['blocker:task-2:1']);
    expect(pending(env.db, { includeWaiting: true }, () => later).find((i) => i.key === 'delivered:task-1:abc')!.nextAttemptAt).toBe('2026-10-29T07:00:00.000Z');
    // Routine off: nothing is re-held, the item is due at its time like any other.
    const off = { ...env.config, routine: { enabled: false } };
    expect(reholdExpired(env.db, off, at('2026-10-29T07:05:00Z'))).toBe(0);
    expect(pending(env.db, {}, () => at('2026-10-29T07:05:00Z')).map((i) => i.key)).toContain('delivered:task-1:abc');
  });

  it('the owner message time (Stop hook meta) turns default holds off', () => {
    const env = makeEnv((c) => { c.routine = { enabled: true }; });
    env.db.setMeta(LAST_OWNER_MESSAGE_META, '2026-10-27T09:50:00.000Z');
    expect(holdFor(env.db, env.config, 'question', undefined, now)).toBeNull();
  });
});

describe('digest due (with catch-up)', () => {
  const cfg = { routine: { enabled: true } };

  it('due at its time, not before; once delivered it is done until the next time', () => {
    const env = makeEnv((c) => { c.routine = { enabled: true }; });
    // 07:50 Berlin: the last time is yesterday's 08:00 (never sent: due as a catch-up).
    const before = digestStatus(env.db, cfg, at('2026-10-27T06:50:00Z'));
    expect(before.slot.local).toBe('2026-10-26T08:00');
    ack(env.db, (() => { enqueue(env.db, { key: before.slot.key, kind: 'digest', text: 'old digest' }); return before.slot.key; })());
    expect(digestStatus(env.db, cfg, at('2026-10-27T06:50:00Z')).due).toBeNull();
    const s = digestStatus(env.db, cfg, at('2026-10-27T07:05:00Z'));
    expect(s).toMatchObject({ slot: { local: '2026-10-27T08:00' }, missed: false, deliveredAt: null });
    expect(s.due).toMatch(/^digest 2026-10-27T08:00 \(Europe\/Berlin\) due$/);
    expect(digestStatus(env.db, { routine: { enabled: false } }, at('2026-10-27T07:05:00Z')).due).toBeNull();
  });

  it('a missed time (host asleep) is caught up at the first pass after it; a missed day sends one digest, not two', () => {
    const env = makeEnv();
    // Asleep from Sunday evening to Tuesday 14:00 Berlin: only Tuesday 08:00 counts.
    const s = digestStatus(env.db, cfg, at('2026-10-27T13:00:00Z'));
    expect(s.slot.local).toBe('2026-10-27T08:00');
    expect(s.missed).toBe(true);
    expect(s.due).toMatch(/missed at its time: caught up 360 min late/);
  });

  it('a digest wake counts: no second wake for the same time until the retry, at most two', () => {
    const env = makeEnv();
    env.db.addEvent(WAKE_EVENT, null, { digest: true }, '2026-10-27T07:01:00.000Z');
    expect(digestStatus(env.db, cfg, at('2026-10-27T07:30:00Z')).due).toBeNull();
    expect(digestStatus(env.db, cfg, at('2026-10-27T08:05:00Z')).due).toMatch(/retry/);
    env.db.addEvent(WAKE_EVENT, null, { digest: true }, '2026-10-27T08:05:00.000Z');
    expect(MAX_DIGEST_WAKES_PER_SLOT).toBe(2);
    expect(digestStatus(env.db, cfg, at('2026-10-27T12:00:00Z')).due).toBeNull();
    // A wake for runnable work is not a digest wake.
    const env2 = makeEnv();
    env2.db.addEvent(WAKE_EVENT, null, { digest: false }, '2026-10-27T07:01:00.000Z');
    expect(digestStatus(env2.db, cfg, at('2026-10-27T07:30:00Z')).due).not.toBeNull();
  });
});

describe('the digest wake in the routine pass (fake clock)', () => {
  function passEnv(over: Partial<RoutinePassDeps> = {}) {
    const env = makeEnv((c) => { c.routine = { enabled: true }; });
    let now = at('2026-10-26T15:00:00Z');
    const wakes: string[] = [];
    const coordinator: CoordinatorView = { running: true, lockAcquiredAt: '2026-10-20T00:00:00.000Z', staleLock: false, exit: null, lastRestartAt: null };
    // Yesterday's digest was sent: the pass starts from a clean state.
    enqueue(env.db, { key: 'digest:2026-10-26T08:00', kind: 'digest', text: 'x' }); ack(env.db, 'digest:2026-10-26T08:00');
    const deps: RoutinePassDeps = {
      db: env.db, config: env.config, now: () => now, pid: 1, procStart: () => 's', lockAlive: () => false,
      sync: async () => ({ intakeCreated: 0, synced: 0, failed: 0, statusChanges: 0, merged: 0, armed: 0, errors: [] }),
      next: async () => ({ runnable: [] }), coordinator: async () => coordinator, activeLeases: async () => [],
      budgetExhausted: () => false,
      digestDue: () => digestStatus(env.db, env.config, now).due,
      holdBack: () => reholdExpired(env.db, env.config, now),
      wake: async () => { wakes.push(now.toISOString()); return 'wake scheduled'; },
      crashStart: async () => 'no',
      ...over,
    };
    return { env, deps, wakes, setNow: (d: string) => { now = at(d); } };
  }

  it('no digest before 08:00; one digest wake after it, also at 100% budget and past the daily cap; none again that day', async () => {
    const t = passEnv({ budgetExhausted: () => true });
    t.setNow('2026-10-27T06:45:00Z'); // 07:45 Berlin
    expect((await runRoutinePass(t.deps, { trigger: 'clock' })).decision).toMatchObject({ action: 'none' });
    for (let i = 0; i < 8; i++) t.env.db.addEvent(WAKE_EVENT, null, { digest: false }, '2026-10-26T23:30:00.000Z'); // the cap is used up today (local day)
    t.setNow('2026-10-27T07:00:00Z');
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r.decision).toMatchObject({ action: 'wake', digest: true });
    expect(r.reasons).toEqual([{ kind: 'digest', detail: 'digest 2026-10-27T08:00 (Europe/Berlin) due' }]);
    t.setNow('2026-10-27T07:15:00Z');
    expect((await runRoutinePass(t.deps, { trigger: 'clock' })).decision).toMatchObject({ action: 'none' });
    expect(t.wakes).toEqual(['2026-10-27T07:00:00.000Z']);
  });

  it('catch-up: the host was asleep at 08:00; the first pass afterwards wakes for the digest', async () => {
    const t = passEnv();
    t.setNow('2026-10-27T11:20:00Z');
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r.decision).toMatchObject({ action: 'wake', digest: true });
    expect(r.reasons?.[0]?.detail).toMatch(/caught up/);
  });

  it('the budget at 100% with runnable work: no wake before the digest time (only the digest wakes)', async () => {
    const t = passEnv({ budgetExhausted: () => true, next: async () => ({ runnable: [{ taskId: 'task-1', role: 'engineer' }] as never }) });
    t.setNow('2026-10-27T05:00:00Z');
    expect((await runRoutinePass(t.deps, { trigger: 'clock' })).decision).toMatchObject({ action: 'none', why: expect.stringMatching(/only the digest/) });
  });

  it('the pass runs the hold-back and records it', async () => {
    const t = passEnv();
    enqueue(t.env.db, { key: 'question:task-3:1', kind: 'question', text: 'Which?', holdUntil: '2026-10-26T16:00:00.000Z' });
    t.setNow('2026-10-26T16:30:00Z');
    const r = await runRoutinePass(t.deps, { trigger: 'manual', force: true });
    expect(r.reheld).toBe(1);
    expect((t.env.db.lastEventOfKind('routine')!.data as { reheld: number }).reheld).toBe(1);
  });
});

const item = (over: Partial<OutboxItem> & { key: string; kind: OutboxItem['kind'] }): OutboxItem => ({
  taskId: null, text: 'text', createdAt: '2026-10-26T10:00:00.000Z', attempts: 0, lastError: null, nextAttemptAt: '2026-10-27T07:00:00.000Z', deliveredAt: null, deliveredVia: null, ...over,
});

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    now: at('2026-10-27T07:00:00Z'), timezone: 'Europe/Berlin', key: 'digest:2026-10-27T08:00', since: '2026-10-26T07:00:00.000Z',
    items: [
      item({ key: 'question:task-6:1', kind: 'question', taskId: 'task-6', createdAt: '2026-10-26T12:00:00.000Z', text: 'Which database for task-6?\n1. Postgres (recommended)\n2. SQLite\n3. Other' }),
      item({ key: 'delivered:task-4:abc', kind: 'delivered', taskId: 'task-4', createdAt: '2026-10-26T11:00:00.000Z', text: 'Delivered task-4 Login form:\nhttps://github.com/o/r/pull/4' }),
      item({ key: 'question:task-9:1', kind: 'question', taskId: null, createdAt: '2026-10-26T13:00:00.000Z', text: 'Should I start the docs epic now?' }),
      item({ key: 'blocker:task-7:2', kind: 'blocker', taskId: 'task-7', createdAt: '2026-10-26T09:00:00.000Z', text: 'task-7 is blocked: CI red three times', nextAttemptAt: null }),
    ],
    tasks: [
      { id: 'task-10', title: 'Search', status: 'ready', prUrl: null, priority: 'low' },
      { id: 'task-4', title: 'Login form', status: 'delivered', prUrl: 'https://github.com/o/r/pull/4', priority: null },
      { id: 'task-5', title: 'Settings page', status: 'delivered', prUrl: 'https://github.com/o/r/pull/5', priority: null },
      { id: 'task-6', title: 'Storage', status: 'awaiting-human', prUrl: null, priority: 'high' },
      { id: 'task-7', title: 'Flaky CI', status: 'blocked', prUrl: null, priority: null },
      { id: 'task-8', title: 'Export', status: 'ready', prUrl: null, priority: 'high' },
    ],
    merged: [{ taskId: 'task-3', prUrl: 'https://github.com/o/r/pull/3', at: '2026-10-26T20:00:00.000Z' }],
    approvals: [{ taskId: 'task-5', head: 'a'.repeat(40), scope: 'merge' }],
    autoPromoted: [{ taskId: 'task-10', at: '2026-10-26T21:00:00.000Z' }],
    spend: { todayTokens: 1_234_567, budget: { percent: 45, text: '5M tokens', exhausted: false }, wakesToday: 2, wakeTokensToday: 310_000 },
    runnable: [],
    ...over,
  };
}

describe('composeDigest (deterministic)', () => {
  it('composes the sections in a fixed order with numbered polls, and returns the keys it covers', () => {
    const d = composeDigest(input());
    expect(d.text).toBe([
      'Digest Tue 27 Oct 08:00 (Europe/Berlin)',
      '',
      'Merged:',
      '- task-3 https://github.com/o/r/pull/3',
      '',
      'Delivered, waiting for CI or merge:',
      '- task-5 Settings page https://github.com/o/r/pull/5',
      '',
      'Updates:',
      '- Delivered task-4 Login form: https://github.com/o/r/pull/4',
      '',
      'Waiting for you:',
      `- task-5 Settings page: merge approval, send in the manager chat: /approve task-5 ${'a'.repeat(40)} merge`,
      '- task-6 Storage: needs your answer (Q1)',
      '',
      'Blockers:',
      '- task-7 Flaky CI (blocked)',
      '- task-7 is blocked: CI red three times',
      '',
      'Auto-promoted (reply "cancel <id>" or "hold <id>"):',
      '- task-10 Search',
      '',
      'Spend today:',
      '- 1.2M tokens; coordinator wakes 2 (310k tokens)',
      '- budget 45% of "5M tokens"',
      '',
      'Next up:',
      '- task-8 Export',
      '- task-10 Search',
      '',
      'Questions:',
      'Q1 (task-6) Which database for task-6?',
      '  1. Postgres (recommended)',
      '  2. SQLite',
      '  3. Other',
      'Q2 Should I start the docs epic now?',
      '  reply `Q2 <answer>`',
      '',
      'Answer by number, e.g. `Q1 1`; for Other: `Q1 <n> <your answer>`.',
      '',
      'ref: #digest',
    ].join('\n'));
    expect(d.keys).toEqual(['digest:2026-10-27T08:00', 'delivered:task-4:abc', 'blocker:task-7:2', 'question:task-6:1', 'question:task-9:1']);
    expect(d.left).toEqual([]);
    expect(d.questions.map((q) => [q.n, q.key, q.options])).toEqual([[1, 'question:task-6:1', ['Postgres (recommended)', 'SQLite', 'Other']], [2, 'question:task-9:1', []]]);
  });

  it('the same state in another order gives the same text', () => {
    const a = composeDigest(input());
    const i = input();
    const b = composeDigest({ ...i, items: [...i.items].reverse(), tasks: [...i.tasks!].reverse(), merged: [...i.merged, ...i.merged] });
    expect(b.text).toBe(a.text);
    expect(b.keys).toEqual(a.keys);
  });

  it('runnable stages are "next up" when there are any; an empty state still says something', () => {
    expect(composeDigest(input({ runnable: [{ taskId: 'task-8', role: 'engineer' }] })).text).toContain('Next up:\n- task-8 Export (engineer)\n');
    const empty = composeDigest(input({ items: [], tasks: [], merged: [], approvals: [], autoPromoted: [], spend: null }));
    expect(empty.text).toBe('Digest Tue 27 Oct 08:00 (Europe/Berlin)\n\nNothing new.\n\nref: #digest');
    expect(empty.keys).toEqual(['digest:2026-10-27T08:00']);
    const used = composeDigest(input({ spend: { todayTokens: 5_000_000, budget: { percent: 100, text: '5M tokens', exhausted: true }, wakesToday: 1, wakeTokensToday: 0 } }));
    expect(used.text).toContain('budget 100% of "5M tokens": used up, new starts are refused until you raise it');
  });

  it('stays under the Telegram limit: whole items are left for the next digest, never cut, and not acked', () => {
    const many = Array.from({ length: 40 }, (_, n) => item({ key: `feature:f${n}:x`, kind: 'feature', createdAt: `2026-10-26T10:${String(n).padStart(2, '0')}:00.000Z`, text: `Feature ${n} ${'x'.repeat(150)}` }));
    const d = composeDigest(input({ items: [...input().items, ...many] }));
    expect(d.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(d.left.length).toBeGreaterThan(0);
    for (const k of d.left) expect(d.keys).not.toContain(k);
    expect(d.text).toContain(`${d.left.length} more item(s) follow in the next digest.`);
    expect(d.keys.length + d.left.length).toBe(1 + 4 + 40);
  });

  it('parsePoll: options from numbered or bulleted lines; "Other" always last, never twice', () => {
    expect(parsePoll('Pick one\n- A (recommended)\n- B')).toEqual({ question: 'Pick one', options: ['A (recommended)', 'B', 'Other'] });
    expect(parsePoll('Pick\n1) A\n2) other: say what')).toEqual({ question: 'Pick', options: ['A', 'Other'] });
    expect(parsePoll('Free text?')).toEqual({ question: 'Free text?', options: [] });
  });
});

describe('prepareDigest: stored under its key; acking the keys marks the time done', () => {
  it('compose -> ack -> not due; held items are covered and delivered; a later call composes an extra digest', () => {
    const env = makeEnv((c) => { c.routine = { enabled: true }; });
    const t0 = at('2026-10-27T07:05:00Z');
    enqueue(env.db, { key: 'question:task-6:1', kind: 'question', taskId: 'task-6', text: 'Which?\n1. A (recommended)\n2. B', holdUntil: '2026-10-28T07:00:00.000Z' }, () => t0);
    env.db.addEvent('ci-observation', 'task-3', { prUrl: 'https://github.com/o/r/pull/3', statusChange: { from: 'delivered', to: 'done' } }, '2026-10-27T01:00:00.000Z');
    env.db.addEvent('merge', 'task-5', { state: 'awaiting-approval', head: 'b'.repeat(40), prUrl: 'u' }, '2026-10-27T02:00:00.000Z');
    env.db.addEvent(AUTO_PROMOTE_EVENT, 'task-11', {}, '2026-10-27T03:00:00.000Z');
    const tasks = [{ id: 'task-5', title: 'Five', status: 'delivered' as const, prUrl: 'u', priority: null }];
    const d = prepareDigest(env.db, env.config, { tasks, runnable: [], spend: null }, t0);
    expect(d.key).toBe('digest:2026-10-27T08:00');
    expect(d.text).toContain('- task-3 https://github.com/o/r/pull/3');
    expect(d.text).toContain(`/approve task-5 ${'b'.repeat(40)} merge`);
    expect(d.text).toContain('Auto-promoted');
    expect(d.text).toContain('Q1 (task-6) Which?');
    expect(d.keys).toEqual(['digest:2026-10-27T08:00', 'question:task-6:1']);
    // Composing again before the send replaces the stored text (same key), it does not add a row.
    const again = prepareDigest(env.db, env.config, { tasks, runnable: [], spend: null }, t0);
    expect(again.text).toBe(d.text);
    expect(env.db.all('SELECT dedup_key FROM outbox WHERE kind = ?', 'digest')).toHaveLength(1);
    for (const k of d.keys) ack(env.db, k, 'telegram', () => t0);
    const st = digestStatus(env.db, env.config, t0);
    expect(st.deliveredAt).not.toBeNull();
    expect(st.due).toBeNull();
    expect(st.held).toBe(0);
    // An extra digest after the scheduled one (the owner asked): a new key, the old one untouched.
    const extra = prepareDigest(env.db, env.config, { tasks, runnable: [], spend: null }, at('2026-10-27T09:00:00Z'));
    expect(extra.key).toBe('digest:2026-10-27T10:00');
    expect(extra.text).not.toContain('task-3'); // merged before the previous digest
  });
});
