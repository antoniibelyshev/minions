// The channel server's pure core (task-67.2): gate and pairing, reply metadata, the ref footer, the outbound chat check
// and the 409 backoff rule.
import { describe, expect, it } from 'vitest';
import {
  assertAllowedChat, conflictBackoffMs, ConflictTracker, CONFLICT_BACKOFF_CAP_MS, gate, MessageMap, normalizeRef, parseAccess, pollAnswerNotification, pollArgs, toNotification, withRefFooter,
} from '../../src/telegram/channel/core.js';
import type { TelegramMessage } from '../../src/telegram/bot-api.js';

const OWNER = 4242;
const BOT = '123456789';
const NOW = Date.parse('2026-10-29T12:00:00Z');
const dm = (text: string, o: Omit<Partial<TelegramMessage>, 'from'> & { from?: number } = {}): TelegramMessage => {
  const { from, ...rest } = o;
  return { message_id: 10, date: NOW / 1000, text, from: { id: from ?? OWNER, username: 'owner' }, chat: { id: from ?? OWNER, type: 'private' }, ...rest };
};
const allow = parseAccess({ dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {} });

describe('gate', () => {
  it('delivers the allowlisted owner and drops strangers, groups, bots and forwards', () => {
    expect(gate(allow, dm('hi'), NOW, () => 'abc123').action).toBe('deliver');
    expect(gate(allow, dm('hi', { from: 777 }), NOW, () => 'abc123').action).toBe('drop');
    expect(gate(allow, { ...dm('hi'), chat: { id: -100, type: 'supergroup' } }, NOW, () => 'x').action).toBe('drop');
    expect(gate(allow, { ...dm('hi'), from: { id: OWNER, is_bot: true } }, NOW, () => 'x').action).toBe('drop');
    expect(gate(allow, dm('hi', { forward_origin: { type: 'user' } }), NOW, () => 'x').action).toBe('drop');
    expect(gate({ ...allow, dmPolicy: 'disabled' }, dm('hi'), NOW, () => 'x').action).toBe('drop');
  });

  it('gives an unknown DM sender a pairing code under pairing: one resend, then silence; at most three pending', () => {
    let access = parseAccess(null);
    const first = gate(access, dm('hi', { from: 777 }), NOW, () => 'aaa111');
    expect(first).toMatchObject({ action: 'pair', code: 'aaa111', isResend: false });
    if (first.action !== 'pair') throw new Error('expected pair');
    expect(first.access.pending.aaa111).toMatchObject({ senderId: '777', chatId: '777', replies: 1, expiresAt: NOW + 3_600_000 });
    access = first.access;
    const again = gate(access, dm('hi', { from: 777 }), NOW, () => 'zzz999');
    expect(again).toMatchObject({ action: 'pair', code: 'aaa111', isResend: true });
    if (again.action !== 'pair') throw new Error('expected pair');
    expect(gate(again.access, dm('hi', { from: 777 }), NOW, () => 'zzz999').action).toBe('drop');
    let a = again.access;
    for (const [id, code] of [[778, 'b'], [779, 'c']] as const) {
      const r = gate(a, dm('x', { from: id }), NOW, () => code);
      if (r.action !== 'pair') throw new Error('expected pair');
      a = r.access;
    }
    expect(gate(a, dm('x', { from: 780 }), NOW, () => 'd').action).toBe('drop');
    // Expired codes are pruned: a new code is possible again an hour later.
    expect(gate(a, dm('x', { from: 780 }), NOW + 3_600_001, () => 'd').action).toBe('pair');
  });

  it('keeps unknown access.json keys when serializing', () => {
    const a = parseAccess({ dmPolicy: 'allowlist', allowFrom: [1], ackReaction: '👀' });
    expect(a.allowFrom).toEqual(['1']);
    expect(a.rest).toEqual({ ackReaction: '👀' });
  });
});

describe('toNotification', () => {
  it('carries the reply metadata: the full replied text, the sender of it and the ref this bot sent', () => {
    const map = new MessageMap();
    map.record({ messageId: 55, chatId: String(OWNER), ref: '58', textHead: 'Deploy done?\n\nref: #58', sentAt: '' });
    const n = toNotification(dm('yes', { reply_to_message: { message_id: 55, text: 'Deploy   done?\n\nref: #58', from: { id: Number(BOT), is_bot: true } } }), { botId: BOT, messages: map });
    expect(n?.content).toBe('yes');
    expect(n?.meta).toMatchObject({ chat_id: String(OWNER), message_id: '10', user: 'owner', user_id: String(OWNER),
      reply_to_message_id: '55', reply_to_from: 'bot', reply_to_text: 'Deploy done? ref: #58', quote: 'full', reply_to_ref: '58' });
  });

  it('uses the partial quote when the owner selected part of the message, cut to one line of 300', () => {
    const long = 'x'.repeat(400);
    const n = toNotification(dm('this one', { quote: { text: `${long}\nmore`, is_manual: true }, reply_to_message: { message_id: 56, text: 'whole', from: { id: OWNER } } }), { botId: BOT, messages: new MessageMap() });
    expect(n?.meta.quote).toBe('partial');
    expect(n?.meta.reply_to_from).toBe('owner');
    expect(n?.meta.reply_to_text).toHaveLength(300);
    expect(n?.meta.reply_to_text).not.toContain('\n');
    expect(n?.meta.reply_to_ref).toBeUndefined();
  });

  it('a reply to an unknown message has no ref; media gets a placeholder; edits are marked', () => {
    const n = toNotification(dm('ok', { reply_to_message: { message_id: 99 } }), { botId: BOT, messages: new MessageMap() });
    expect(n?.meta.reply_to_message_id).toBe('99');
    expect(n?.meta).not.toHaveProperty('reply_to_ref');
    expect(n?.meta).not.toHaveProperty('reply_to_text');
    const photo = toNotification({ ...dm(''), text: undefined, photo: [{ file_id: 'small' }, { file_id: 'big' }] }, { botId: BOT, messages: new MessageMap() });
    expect(photo).toMatchObject({ content: '(photo)', meta: { attachment_kind: 'photo', attachment_file_id: 'big' } });
    expect(toNotification(dm('fixed'), { botId: BOT, messages: new MessageMap(), edited: true })).toMatchObject({ content: '(edited) fixed', meta: { edited: 'true' } });
  });
});

describe('outbound', () => {
  it('appends the ref footer and validates refs', () => {
    expect(withRefFooter('done  ', '58')).toBe('done\n\nref: #58');
    expect(withRefFooter('done', null)).toBe('done');
    expect(normalizeRef('#task-67')).toBe('task-67');
    expect(normalizeRef(undefined)).toBeNull();
    expect(() => normalizeRef('a b\nref: #1')).toThrow();
  });

  it('assertAllowedChat defaults to the single owner DM and refuses other chats', () => {
    expect(assertAllowedChat(allow)).toBe(String(OWNER));
    expect(assertAllowedChat(allow, String(OWNER))).toBe(String(OWNER));
    expect(() => assertAllowedChat(allow, '777')).toThrow(/not allowlisted/);
    expect(() => assertAllowedChat(parseAccess(null))).toThrow(/No chat is paired/);
  });
});

describe('409 backoff', () => {
  it('is 1 s, 2 s, 4 s ... capped at 30 s, jittered down by at most a quarter', () => {
    expect(conflictBackoffMs(1, () => 1)).toBe(1000);
    expect(conflictBackoffMs(2, () => 1)).toBe(2000);
    expect(conflictBackoffMs(3, () => 0)).toBe(3000);
    for (let n = 1; n < 40; n++) expect(conflictBackoffMs(n, Math.random)).toBeLessThanOrEqual(CONFLICT_BACKOFF_CAP_MS);
  });

  it('a single 409 retries; three in a row is persistent; a success resets the run', () => {
    const t = new ConflictTracker(() => 1);
    expect(t.onConflict()).toEqual({ action: 'retry', delayMs: 1000 });
    t.onSuccess();
    expect(t.onConflict().action).toBe('retry');
    expect(t.onConflict().action).toBe('retry');
    expect(t.onConflict().action).toBe('persistent');
  });
});

describe('polls and the reply default (autonomy.md Decision 5)', () => {
  const withPoll = () => {
    const map = new MessageMap(3);
    map.record({ messageId: 50, chatId: String(OWNER), ref: '58', textHead: 'Q?', sentAt: '', poll: { pollId: 'p1', question: 'Q?', options: ['yes', 'no'] } });
    return map;
  };

  it('pollArgs trims and checks the Telegram limits', () => {
    expect(pollArgs({ question: ' Q? ', options: [' a', 'b '] })).toEqual({ question: 'Q?', options: ['a', 'b'], multiple: false });
    expect(pollArgs({ question: 'Q', options: ['a', 'b'], multiple: true }).multiple).toBe(true);
    expect(() => pollArgs({ question: '', options: ['a', 'b'] })).toThrow(/question/);
    expect(() => pollArgs({ question: 'x'.repeat(301), options: ['a', 'b'] })).toThrow(/question/);
    expect(() => pollArgs({ question: 'Q', options: ['a'] })).toThrow(/2 to 10/);
    expect(() => pollArgs({ question: 'Q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).toThrow(/2 to 10/);
    expect(() => pollArgs({ question: 'Q', options: ['a', 'x'.repeat(101)] })).toThrow(/1 to 100/);
    expect(() => pollArgs({ question: 'Q', options: ['a', 3] })).toThrow(/1 to 100/);
    expect(() => pollArgs({ question: 'Q', options: ['a', 'a'] })).toThrow(/distinct/);
    expect(() => pollArgs({ question: 'Q', options: ['a', 'b'], multiple: 'yes' })).toThrow(/multiple/);
  });

  it('pollAnswerNotification names the chosen options for the owner and drops everyone and everything else', () => {
    const o = { access: allow, messages: withPoll(), now: NOW };
    const r = pollAnswerNotification({ poll_id: 'p1', option_ids: [1], user: { id: OWNER, username: 'owner' } }, o);
    expect(r).toMatchObject({ action: 'deliver', notification: { content: '[poll answer] Q?: no', meta: {
      chat_id: String(OWNER), message_id: '50', reply_to_message_id: '50', reply_to_from: 'bot', poll_id: 'p1', option_ids: '1', reply_to_ref: '58', user: 'owner',
    } } });
    expect(pollAnswerNotification({ poll_id: 'p1', option_ids: [], user: { id: OWNER } }, o)).toMatchObject({ notification: { content: '[poll answer] Q?: (vote retracted)' } });
    expect(pollAnswerNotification({ poll_id: 'p1', option_ids: [0], user: { id: 777 } }, o)).toEqual({ action: 'drop', why: 'poll voter not allowlisted' });
    expect(pollAnswerNotification({ poll_id: 'p1', option_ids: [0], user: { id: OWNER, is_bot: true } }, o)).toMatchObject({ action: 'drop' });
    expect(pollAnswerNotification({ poll_id: 'p1', option_ids: [0], voter_chat: { id: -1 } }, o)).toMatchObject({ action: 'drop' });
    expect(pollAnswerNotification({ poll_id: 'p2', option_ids: [0], user: { id: OWNER } }, o)).toEqual({ action: 'drop', why: 'unknown poll' });
    expect(pollAnswerNotification({ poll_id: 'p1', option_ids: [0], user: { id: OWNER } }, { ...o, access: { ...allow, dmPolicy: 'disabled' } })).toMatchObject({ action: 'drop' });
  });

  it('the message map keeps polls and the newest inbound id through JSON, and stays bounded', () => {
    const map = withPoll();
    map.noteInbound(String(OWNER), 40);
    map.noteInbound(String(OWNER), 30);
    expect(map.lastInbound(String(OWNER))).toBe(40);
    const back = MessageMap.from(JSON.parse(JSON.stringify(map.toJSON())), 3);
    expect(back.findPoll('p1')).toMatchObject({ messageId: 50, ref: '58', poll: { options: ['yes', 'no'] } });
    expect(back.lastInbound(String(OWNER))).toBe(40);
    for (let i = 1; i <= 3; i++) back.record({ messageId: 60 + i, chatId: String(OWNER), ref: null, textHead: '', sentAt: '' });
    expect(back.findPoll('p1')).toBeUndefined();
    expect(MessageMap.from({ version: 1, messages: [], lastInbound: { x: 'bad' } }).lastInbound('x')).toBeUndefined();
  });
});
