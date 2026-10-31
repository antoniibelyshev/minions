// Thread sessions (docs/design/autonomy.md Decision 6): a new Telegram thread opens its own coordinator session,
// replies stay in it, its answers go back as replies in the thread, and its questions go out as native polls.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { enqueue, pending } from '../../src/runtime/outbox.js';
import { recordSent, resolveRoute, sendToSession, threadReplyTarget, withReplyContext } from '../../src/runtime/router.js';
import { getSession, pendingInbox, sessionsByStatus } from '../../src/runtime/session-store.js';
import { parseSessionKey, threadSettings } from '../../src/runtime/sessions.js';
import { taskSessionPass } from '../../src/runtime/task-sessions.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

let db: RuntimeDb;
let state: string;
beforeEach(() => { state = tmp('minions-threads-'); db = new RuntimeDb(join(state, 'minions.db')); });
afterEach(() => db.close());

const cfg = (sessions: Record<string, unknown> = {}): MinionsConfig => { const c = defaults(); c.coordinator = { ...c.coordinator, sessions: { enabled: true, ...sessions } }; return c; };
const T0 = new Date('2026-10-31T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe('thread sessions', () => {
  it('a top-level owner message opens a new thread session; a reply to it or to the bot stays there', () => {
    expect(parseSessionKey('thread:42')).toEqual({ key: 'thread:42', kind: 'thread', taskId: null });
    expect(() => parseSessionKey('thread:x')).toThrow();
    const threads = threadSettings(cfg()).enabled;
    expect(threads).toBe(true);

    const first = resolveRoute(db, { text: 'set up the docs site', messageId: 100, threads });
    expect(first).toMatchObject({ target: 'thread:100', rule: 'thread' });
    sendToSession(db, cfg(), { key: first.target!, text: first.text, state, messageId: 100, now: T0 });
    expect(getSession(db, 'thread:100')).toMatchObject({ kind: 'thread', status: 'open' });

    // The session answers; the router sends it as a reply in the thread and records it.
    enqueue(db, { key: 'status:thread:100:1', kind: 'status', text: 'On it.', session: 'thread:100' }, () => at(1));
    expect(threadReplyTarget(db, 'thread:100')).toBe(100);
    recordSent(db, { messageId: 101, keys: ['status:thread:100:1'], now: at(1) });
    expect(threadReplyTarget(db, 'thread:100')).toBe(101);

    // The owner replies to the bot's answer, then to their own first message: both stay in the thread.
    expect(resolveRoute(db, { text: 'use mkdocs', messageId: 102, replyToMessageId: 101, threads })).toMatchObject({ target: 'thread:100', rule: 'reply' });
    sendToSession(db, cfg(), { key: 'thread:100', text: 'use mkdocs', state, messageId: 102, reply: { text: 'On it.' }, now: at(2) });
    expect(resolveRoute(db, { text: 'and a dark theme', messageId: 103, replyToMessageId: 100, threads })).toMatchObject({ target: 'thread:100', rule: 'reply' });

    // Another top-level message: another thread.
    expect(resolveRoute(db, { text: 'how much did we spend?', messageId: 104, threads })).toMatchObject({ target: 'thread:104', rule: 'thread' });
    // Threads off: new topics still go to general.
    expect(resolveRoute(db, { text: 'hi', messageId: 105, threads: threadSettings(cfg({ threads: false })).enabled })).toMatchObject({ target: 'general' });

    const inbox = pendingInbox(db, 'thread:100').map((m) => m.text);
    expect(inbox).toEqual(['set up the docs site', '(in reply to: "On it.")\nuse mkdocs']);
  });

  it('a question with options goes out as a poll, and the vote routes back to the asking session', () => {
    sendToSession(db, cfg(), { key: 'thread:200', text: 'which host?', state, messageId: 200, now: T0 });
    enqueue(db, { key: 'question:thread:200:1', kind: 'question', text: 'Where should the docs live?', session: 'thread:200', options: ['GitHub Pages', 'Netlify'] }, () => at(1));
    expect(pending(db, {}, () => at(1))[0]).toMatchObject({ key: 'question:thread:200:1', options: ['GitHub Pages', 'Netlify'] });
    recordSent(db, { messageId: 201, keys: ['question:thread:200:1'], now: at(1) });
    // The channel delivers the vote as a message replying to the poll.
    expect(resolveRoute(db, { text: '[poll answer] Where should the docs live?: Netlify', messageId: 201, replyToMessageId: 201, threads: true }))
      .toMatchObject({ target: 'thread:200', rule: 'reply' });
    expect(() => enqueue(db, { key: 'q2', kind: 'status', text: 'x', options: ['a', 'b'] })).toThrow(/Only a question/);
    expect(() => enqueue(db, { key: 'q3', kind: 'question', text: 'x', options: ['a'] })).toThrow(/2 to 10/);
    expect(() => enqueue(db, { key: 'q4', kind: 'question', text: 'x', options: ['a', 'a'] })).toThrow(/distinct/);
  });

  it('a quiet thread session closes; a later reply reopens it', async () => {
    sendToSession(db, cfg(), { key: 'thread:300', text: 'hello', state, messageId: 300, now: T0 });
    db.exec('UPDATE session_inbox SET delivered_at = ? WHERE session_key = ?', at(1).toISOString(), 'thread:300');
    const deps = (now: Date) => ({ db, config: cfg({ threadIdleMinutes: 60 }), state, now: () => now, tasks: async () => [], runnable: async () => [], budgetExhausted: () => false }) as never;
    expect((await taskSessionPass(deps(at(30)))).closed).toEqual([]);
    const r = await taskSessionPass(deps(at(61)));
    expect(r.closed).toEqual([expect.objectContaining({ key: 'thread:300' })]);
    expect(sessionsByStatus(db, 'open').map((s) => s.key)).not.toContain('thread:300');
    expect(sendToSession(db, cfg(), { key: 'thread:300', text: 'one more thing', state, messageId: 301, now: at(90) }).reopened).toBe(true);
  });

  it('names the reply context in one line', () => {
    expect(withReplyContext('yes', null)).toBe('yes');
    expect(withReplyContext('yes', { text: 'Ship\nit?', quote: 'partial' })).toBe('(in reply to the quoted part: "Ship it?")\nyes');
  });
});
