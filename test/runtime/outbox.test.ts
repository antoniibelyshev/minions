// Notification outbox (task-2.3, spec §611): notifications are recorded with a dedup key before they are
// sent, survive a channel outage (and a restart), and are delivered once after recovery. A fake transport
// stands in for Telegram; temp SQLite DBs only.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeDb } from '../../src/runtime/db.js';
import {
  ack, BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffMs, counts, enqueue, fail, flush, MAX_TEXT_LENGTH, pending, redactError,
  type NotificationTransport, type OutboxItem,
} from '../../src/runtime/outbox.js';
import { collectStatus } from '../../src/runtime/commands.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const dbPath = () => join(tmp('minions-outbox-'), 'state', 'minions.db');

/** A controllable clock: tests move time forward instead of sleeping. */
function clock(start = Date.parse('2026-10-23T10:00:00.000Z')) {
  let t = start;
  const now = () => new Date(t);
  return { now, advance: (ms: number) => { t += ms; } };
}

/** Fake transport: records every successful send; throws while `down`. */
class FakeTransport implements NotificationTransport {
  readonly name = 'fake';
  down = false;
  delivered: OutboxItem[] = [];
  attempts = 0;
  async send(item: OutboxItem): Promise<void> {
    this.attempts++;
    if (this.down) throw new Error('fetch failed: getaddrinfo ENOTFOUND api.telegram.org (bot 123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll)');
    this.delivered.push(item);
  }
}

describe('notification outbox', () => {
  it('survives a transport outage (and a restart) and delivers each notification exactly once after recovery', async () => {
    const path = dbPath();
    const c = clock();
    let db = new RuntimeDb(path);
    const transport = new FakeTransport();

    enqueue(db, { key: 'goal-ack:101', kind: 'goal-ack', text: 'Got it: dark mode. Planning now.' }, c.now);
    enqueue(db, { key: 'delivered:task-7:abc123', kind: 'delivered', taskId: 'task-7', text: 'Delivered task-7: https://github.com/o/r/pull/9' }, c.now);
    c.advance(1);
    enqueue(db, { key: 'blocker:task-8:1', kind: 'blocker', taskId: 'task-8', text: 'task-8 is blocked: needs an API key decision.' }, c.now);

    // Outage: the first send fails, the pass stops, nothing is lost.
    transport.down = true;
    const r1 = await flush(db, transport, {}, c.now);
    expect(r1.sent).toEqual([]);
    expect(r1.failed).toHaveLength(1);
    expect(r1.failed[0]!.key).toBe('goal-ack:101');
    expect(r1.failed[0]!.error).not.toContain('AAAbbbCCC'); // credentials are masked in stored errors
    expect(r1.remaining).toBe(3);
    expect(transport.attempts).toBe(1); // stops at the first failure instead of hammering a dead channel

    // The coordinator re-records the same events while the channel is down: dedup keeps one row each.
    expect(enqueue(db, { key: 'goal-ack:101', kind: 'goal-ack', text: 'Got it: dark mode. Planning now.' }, c.now).created).toBe(false);
    expect(enqueue(db, { key: 'delivered:task-7:abc123', kind: 'delivered', text: 'again' }, c.now).created).toBe(false);
    expect(counts(db, c.now)).toMatchObject({ pending: 3, waiting: 1, due: 2, delivered: 0 });

    // A later wake during the outage: the backed-off item waits, the others are tried and fail again.
    const r2 = await flush(db, transport, {}, c.now);
    expect(r2.sent).toEqual([]);
    expect(r2.failed.map((f) => f.key)).toEqual(['delivered:task-7:abc123']);

    // Runtime restart while Telegram is still down: the outbox is durable.
    db.close();
    db = new RuntimeDb(path);
    expect(counts(db, c.now).pending).toBe(3);

    // Recovery: after the backoff, one pass delivers everything in order, once.
    transport.down = false;
    c.advance(BACKOFF_MAX_MS);
    const r3 = await flush(db, transport, {}, c.now);
    expect(r3.failed).toEqual([]);
    expect(r3.sent).toEqual(['goal-ack:101', 'delivered:task-7:abc123', 'blocker:task-8:1']);
    expect(r3.remaining).toBe(0);
    expect(transport.delivered.map((i) => i.text)).toEqual([
      'Got it: dark mode. Planning now.', 'Delivered task-7: https://github.com/o/r/pull/9', 'task-8 is blocked: needs an API key decision.',
    ]);

    // Later passes and re-recording delivered keys never resend.
    await flush(db, transport, {}, c.now);
    expect(enqueue(db, { key: 'delivered:task-7:abc123', kind: 'delivered', text: 'Delivered task-7' }, c.now)).toMatchObject({ created: false, item: { deliveredVia: 'fake' } });
    await flush(db, transport, {}, c.now);
    expect(transport.delivered.map((i) => i.key)).toEqual(['goal-ack:101', 'delivered:task-7:abc123', 'blocker:task-8:1']);
    expect(counts(db, c.now)).toMatchObject({ pending: 0, delivered: 3 });
    db.close();
  });

  it('pending lists due items oldest first; --all includes those inside a backoff', () => {
    const db = new RuntimeDb(dbPath());
    const c = clock();
    enqueue(db, { key: 'a', kind: 'status', text: 'A' }, c.now);
    c.advance(1);
    enqueue(db, { key: 'b', kind: 'status', text: 'B' }, c.now);
    fail(db, 'a', 'timeout', c.now);
    expect(pending(db, {}, c.now).map((i) => i.key)).toEqual(['b']);
    expect(pending(db, { includeWaiting: true }, c.now).map((i) => i.key)).toEqual(['a', 'b']);
    expect(pending(db, { includeWaiting: true, limit: 1 }, c.now).map((i) => i.key)).toEqual(['a']);
    c.advance(BACKOFF_BASE_MS);
    expect(pending(db, {}, c.now).map((i) => i.key)).toEqual(['a', 'b']);
    const item = fail(db, 'a', 'timeout again', c.now);
    expect(item).toMatchObject({ attempts: 2, lastError: 'timeout again' });
    expect(Date.parse(item.nextAttemptAt!) - c.now().getTime()).toBe(2 * BACKOFF_BASE_MS);
  });

  it('backoff doubles per attempt and is capped', () => {
    expect(backoffMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffMs(50)).toBe(BACKOFF_MAX_MS);
  });

  it('ack is idempotent and keeps the first delivery; fail after delivery changes nothing', () => {
    const db = new RuntimeDb(dbPath());
    const c = clock();
    enqueue(db, { key: 'approval:task-3:abc', kind: 'approval', taskId: 'task-3', text: 'Approve task-3?' }, c.now);
    const first = ack(db, 'approval:task-3:abc', 'telegram', c.now);
    expect(first.alreadyDelivered).toBe(false);
    c.advance(1000);
    const again = ack(db, 'approval:task-3:abc', 'terminal', c.now);
    expect(again).toMatchObject({ alreadyDelivered: true, item: { deliveredVia: 'telegram', deliveredAt: first.item.deliveredAt } });
    expect(fail(db, 'approval:task-3:abc', 'late error', c.now)).toMatchObject({ attempts: 0, lastError: null });
    expect(db.events('task-3').map((e) => e.kind)).toEqual(['notify-enqueue', 'notify-delivered']);
  });

  it('validates keys, kinds and text; unknown keys are NOT_FOUND', () => {
    const db = new RuntimeDb(dbPath());
    const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as { code?: string }).code; } };
    expect(code(() => enqueue(db, { key: 'has space', kind: 'status', text: 'x' }))).toBe('PRECONDITION');
    expect(code(() => enqueue(db, { key: 'k', kind: 'shout', text: 'x' }))).toBe('PRECONDITION');
    expect(code(() => enqueue(db, { key: 'k', kind: 'status', text: '   ' }))).toBe('PRECONDITION');
    expect(code(() => enqueue(db, { key: 'k', kind: 'status', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }))).toBe('PRECONDITION');
    expect(code(() => ack(db, 'missing'))).toBe('NOT_FOUND');
    expect(code(() => fail(db, 'missing', 'e'))).toBe('NOT_FOUND');
  });

  it('masks credentials and truncates stored errors', () => {
    expect(redactError('401 for bot 123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll')).toBe('401 for bot [redacted]');
    expect(redactError('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactError('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it('minions status reports pending notifications so nothing is lost if the channel never returns', async () => {
    const db = new RuntimeDb(dbPath());
    enqueue(db, { key: 'blocker:task-1:1', kind: 'blocker', taskId: 'task-1', text: 'blocked' });
    const s = await collectStatus({ db, config: defaults('project-owner'), backlog: async () => { throw new Error('no backlog'); } });
    expect(s.notifications).toMatchObject({ pending: 1, delivered: 0 });
  });
});
