// Task-57 phase 8: the router's deterministic part (src/runtime/router.ts): routing rules, handing a message to a
// session, waiting for due outbound items, the sent-message map, and the restart blockers. DB only: no claude, no bot.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { DIGEST_QUESTIONS_META } from '../../src/runtime/digest.js';
import { ack, enqueue, pending } from '../../src/runtime/outbox.js';
import {
  heldBySession, openQuestions, recordSent, resolveRoute, sendToSession, sessionKeyOf,
} from '../../src/runtime/router.js';
import { getSession, openSession, pendingInbox, updateSession } from '../../src/runtime/session-store.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

let db: RuntimeDb;
let state: string;
beforeEach(() => { state = tmp('minions-router-'); db = new RuntimeDb(join(state, 'minions.db')); });
afterEach(() => db.close());

const sessionsCfg = (on = true): MinionsConfig => { const c = defaults(); c.coordinator = { ...c.coordinator, sessions: { enabled: on } }; return c; };
const NOW = new Date('2026-10-29T10:00:00.000Z');
const clock = () => NOW;

/** A question the session `session` asked, sent to the owner. */
function askedQuestion(key: string, session: string | null, taskId: string | null = null) {
  enqueue(db, { key, kind: 'question', taskId, text: 'Which way?\n1. A\n2. B', session }, clock);
  ack(db, key, 'telegram', clock);
}

describe('resolveRoute: the routing rules', () => {
  const route = (text: string, o: { replyTo?: number; knownTasks?: string[] | null } = {}) =>
    resolveRoute(db, { text, replyToMessageId: o.replyTo ?? null }, { knownTasks: o.knownTasks === undefined ? ['task-57', 'task-57.12', 'task-3'] : o.knownTasks, now: NOW });

  it.each([
    // [text, target, rule]
    ['Can we add a dark mode?', 'general', 'general'],
    ['/s task-57 please also cover the digest', 'task:task-57', 'session'],
    ['/s task:task-3 go on', 'task:task-3', 'session'],
    ['/s general what is next?', 'general', 'session'],
    ['How is task-57.12 going?', 'task:task-57.12', 'task'],
    ['Is TASK-3 blocked?', 'task:task-3', 'task'],
    ['Something like task-999 maybe', 'general', 'general'], // not a known task
    ['42', 'general', 'general'], // a bare number with no open question
    ['Q1 2', 'general', 'general'], // no digest question
  ] as const)('%s -> %s (%s)', (text, target, rule) => {
    const r = route(text);
    expect(r).toMatchObject({ target, rule });
    expect(r.candidates).toEqual([]);
  });

  it('strips the /s prefix from the handed-over text, and refuses a key that is no session', () => {
    expect(route('/s task-57 please also cover the digest').text).toBe('please also cover the digest');
    const bad = route('/s banana hello');
    expect(bad).toMatchObject({ target: null, rule: 'ambiguous' });
    expect(bad.candidates.map((c) => c.key)).toEqual(['general']);
  });

  it('several tasks named: ambiguous, each task and general as candidates', () => {
    const r = route('Compare task-57 with task-3');
    expect(r).toMatchObject({ target: null, rule: 'ambiguous' });
    expect(r.candidates.map((c) => c.key)).toEqual(['task:task-57', 'task:task-3', 'general']);
  });

  it('with an unreadable backlog every task id counts', () => {
    expect(route('Something like task-999 maybe', { knownTasks: null })).toMatchObject({ target: 'task:task-999', rule: 'task' });
  });

  it('a reply or a #ref to a sent message routes to the session that sent it (before a task mention)', () => {
    enqueue(db, { key: 'delivered:task-3:abc', kind: 'delivered', taskId: 'task-3', text: 'Delivered task-3', session: 'task:task-3' }, clock);
    recordSent(db, { messageId: 501, keys: ['delivered:task-3:abc'], ref: '501', now: NOW });
    expect(route('thanks, and task-57?', { replyTo: 501 })).toMatchObject({ target: 'task:task-3', rule: 'reply' });
    expect(route('about #501: ship it')).toMatchObject({ target: 'task:task-3', rule: 'ref' });
    // An unknown reply target falls through to the other rules.
    expect(route('thanks', { replyTo: 999 })).toMatchObject({ target: 'general', rule: 'general' });
    // A message that carried items of two sessions (a digest) is ambiguous.
    enqueue(db, { key: 'blocker:task-57:1', kind: 'blocker', taskId: 'task-57', text: 'Blocked', session: 'task:task-57' }, clock);
    recordSent(db, { messageId: 600, keys: ['delivered:task-3:abc', 'blocker:task-57:1'], now: NOW });
    const r = route('ok', { replyTo: 600 });
    expect(r.rule).toBe('ambiguous');
    expect(r.candidates.map((c) => c.key)).toEqual(['task:task-3', 'task:task-57', 'general']);
  });

  it('a bare number answers the one open question, back to the session that asked', () => {
    askedQuestion('question:task-57:1', 'task:task-57', 'task-57');
    expect(route('2')).toMatchObject({ target: 'task:task-57', rule: 'question', question: 'question:task-57:1' });
    // A question the single coordinator (or the router) asked has no session: the general session gets the answer.
    askedQuestion('question:general:1', null);
    const r = route('1');
    expect(r).toMatchObject({ target: null, rule: 'ambiguous' });
    expect(r.candidates.map((c) => [c.key, c.question])).toEqual([['task:task-57', 'question:task-57:1'], ['general', 'question:general:1']]);
  });

  it('`Q<n> <answer>` uses the numbers of the latest delivered digest', () => {
    askedQuestion('question:task-57:1', 'task:task-57', 'task-57');
    askedQuestion('question:task-3:1', 'task:task-3', 'task-3');
    enqueue(db, { key: 'digest:2026-10-29T08:00', kind: 'digest', text: 'digest' }, clock);
    db.setMeta(`${DIGEST_QUESTIONS_META}digest:2026-10-29T08:00`, JSON.stringify([{ n: 1, key: 'question:task-3:1' }, { n: 2, key: 'question:task-57:1' }]));
    ack(db, 'digest:2026-10-29T08:00', 'telegram', clock);
    expect(route('Q1 2')).toMatchObject({ target: 'task:task-3', rule: 'question', question: 'question:task-3:1' });
    expect(route('q2 1 but faster')).toMatchObject({ target: 'task:task-57', question: 'question:task-57:1' });
    expect(route('Q3 1')).toMatchObject({ target: 'general', rule: 'general' });
  });

  it('`Q<n>` falls back to the only open question when no digest numbered it; a numbered one is not guessed', () => {
    askedQuestion('question:task-57:1', 'task:task-57', 'task-57');
    expect(route('Q1 2')).toMatchObject({ target: 'task:task-57', rule: 'question', question: 'question:task-57:1' });
    enqueue(db, { key: 'digest:2026-10-29T08:00', kind: 'digest', text: 'digest' }, clock);
    db.setMeta(`${DIGEST_QUESTIONS_META}digest:2026-10-29T08:00`, JSON.stringify([{ n: 1, key: 'question:task-57:1' }]));
    ack(db, 'digest:2026-10-29T08:00', 'telegram', clock);
    expect(route('Q2 1')).toMatchObject({ target: 'general', rule: 'general' });
  });

  it('answered, undelivered and old questions are not open', () => {
    askedQuestion('question:task-57:1', 'task:task-57', 'task-57');
    enqueue(db, { key: 'question:task-3:1', kind: 'question', text: 'Not sent yet', session: 'task:task-3' }, clock);
    expect(openQuestions(db, NOW).map((q) => q.key)).toEqual(['question:task-57:1']);
    sendToSession(db, sessionsCfg(), { key: 'task:task-57', text: '2', state, answers: 'question:task-57:1', now: NOW });
    expect(openQuestions(db, NOW)).toEqual([]);
    askedQuestion('question:task-3:2', 'task:task-3');
    expect(openQuestions(db, new Date(NOW.getTime() + 8 * 24 * 3600_000))).toEqual([]);
  });
});

describe('sendToSession (coordinator send)', () => {
  it('queues the owner message for the session (source owner), opening a task session that has none with its kickoff first', () => {
    const r = sendToSession(db, sessionsCfg(), { key: 'task-57', text: '  please hurry  ', state, meta: { messageId: 7 }, now: NOW });
    expect(r).toMatchObject({ key: 'task:task-57', reopened: false, answered: null });
    expect(getSession(db, 'task:task-57')?.status).toBe('open');
    const inbox = pendingInbox(db, 'task:task-57');
    expect(inbox[0]).toMatchObject({ source: 'owner', text: expect.stringMatching(/^\/minions:task task-57\n\nminions supervisor: the owner wrote/) });
    expect(inbox.slice(1).map((m) => [m.source, m.text, m.meta_json])).toEqual([['owner', 'please hurry', '{"messageId":7}']]);
    // A second message to the now open session queues no second kickoff.
    sendToSession(db, sessionsCfg(), { key: 'task-57', text: 'and more', state, now: NOW });
    expect(pendingInbox(db, 'task:task-57').filter((m) => m.text.startsWith('/minions:task'))).toHaveLength(1);
  });

  it('reopens a closed or failed session; leaves opening `general` to the supervisor', () => {
    openSession(db, 'task:task-3', { configDir: '/c', now: NOW });
    updateSession(db, 'task:task-3', { status: 'failed', failure: 'resumes exhausted', claude_session_id: 'abc-1' });
    expect(sendToSession(db, sessionsCfg(), { key: 'task:task-3', text: 'retry it', state, now: NOW }).reopened).toBe(true);
    expect(getSession(db, 'task:task-3')).toMatchObject({ status: 'open', failure: null, claude_session_id: 'abc-1' });

    sendToSession(db, sessionsCfg(), { key: 'general', text: 'hello', state, now: NOW });
    expect(getSession(db, 'general')).toBeNull();
    expect(pendingInbox(db, 'general')).toHaveLength(1);
  });

  it('refuses with sessions off, for a non-session key (the router is none) and for an empty text', () => {
    const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as MinionsError).code; } return 'ok'; };
    expect(code(() => sendToSession(db, sessionsCfg(false), { key: 'general', text: 'hi', state }))).toBe('PRECONDITION');
    expect(code(() => sendToSession(db, sessionsCfg(), { key: 'router', text: 'hi', state }))).toBe('PRECONDITION');
    expect(code(() => sendToSession(db, sessionsCfg(), { key: 'general', text: '   ', state }))).toBe('PRECONDITION');
    expect(db.all('SELECT * FROM session_inbox')).toEqual([]);
  });
});

describe('outbound: notify enqueue --session and notify ack --message-id', () => {
  it('the outbox keeps the session; recordSent maps the message id to each key and its session', () => {
    enqueue(db, { key: 'status:general:1', kind: 'status', text: 'All fine', session: 'general' }, clock);
    enqueue(db, { key: 'blocker:task-57:1', kind: 'blocker', text: 'Needs a token', session: 'task:task-57' }, clock);
    expect(pending(db, {}, clock).map((i) => [i.key, i.session])).toEqual([['status:general:1', 'general'], ['blocker:task-57:1', 'task:task-57']]);
    expect(recordSent(db, { messageId: 77, keys: ['status:general:1', 'blocker:task-57:1', 'unknown:1'], ref: '77', now: NOW })).toBe(3);
    expect(db.all('SELECT message_id, ref, outbox_key, text_head, session FROM tg_messages ORDER BY id')).toEqual([
      { message_id: 77, ref: '77', outbox_key: 'status:general:1', text_head: 'All fine', session: 'general' },
      { message_id: 77, ref: '77', outbox_key: 'blocker:task-57:1', text_head: 'Needs a token', session: 'task:task-57' },
      { message_id: 77, ref: '77', outbox_key: 'unknown:1', text_head: null, session: null },
    ]);
    expect(() => recordSent(db, { messageId: 0, keys: ['x'] })).toThrow(/Telegram message id/);
  });
});

describe('helpers', () => {
  it('sessionKeyOf accepts general, task:<id> and bare task ids, never the router', () => {
    expect(['general', 'task:task-1', 'task-2.3', 'router', 'x', ''].map(sessionKeyOf)).toEqual(['general', 'task:task-1', 'task:task-2.3', null, null, null]);
  });

  it('heldBySession: task and general session leases never block a router restart; the single coordinator\'s do', () => {
    expect([null, '', 'coordinator', 'task:task-1', 'general', 'router'].map(heldBySession)).toEqual([false, false, false, true, true, false]);
  });
});
