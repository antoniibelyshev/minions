// The Telegram gateway (docs/design/autonomy.md Decision 7): owner messages routed without a model, due items sent as
// threaded replies and polls, the sessions index, topics and handovers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { isGatewayLaunch } from '../../src/runtime/coordinator.js';
import { deliverDue, formatSessionsIndex, handoverSession, routeInbound, sessionsIndex, setSessionTopic, writeSessionsIndex, type GatewayDeps } from '../../src/runtime/gateway.js';
import { enqueue } from '../../src/runtime/outbox.js';
import { getSession, pendingInbox } from '../../src/runtime/session-store.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

let db: RuntimeDb;
let state: string;
beforeEach(() => { state = tmp('minions-gateway-'); db = new RuntimeDb(join(state, 'minions.db')); });
afterEach(() => db.close());

const cfg = (): MinionsConfig => { const c = defaults(); c.coordinator = { ...c.coordinator, sessions: { enabled: true } }; return c; };
const T0 = new Date('2026-10-31T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function gateway(now = T0, o: { failSend?: boolean } = {}) {
  const sent: { kind: 'text' | 'poll'; text: string; replyTo: number | null | undefined; options?: string[] }[] = [];
  let next = 500;
  const d: GatewayDeps = {
    db, state, config: async () => cfg(), knownTasks: async () => ['task-7'], log: () => undefined, now: () => now,
    sender: {
      send: async ({ text, replyTo }) => { if (o.failSend) throw new Error('network down'); sent.push({ kind: 'text', text, replyTo }); return next++; },
      sendPoll: async ({ question, options, replyTo }) => { sent.push({ kind: 'poll', text: question, replyTo, options }); return { messageId: next++, pollId: 'p1' }; },
    },
  };
  return { d, sent };
}
const msg = (text: string, meta: Record<string, string>) => ({ content: text, meta: { chat_id: '1', ...meta } });

describe('gateway: inbound', () => {
  it('a top-level message opens a thread session; a reply to its answer stays there; a task id goes to the task session', async () => {
    const { d } = gateway();
    expect(await routeInbound(d, msg('set up docs', { message_id: '100' }))).toEqual({ key: 'thread:100', rule: 'thread' });
    expect(getSession(db, 'thread:100')).toMatchObject({ status: 'open' });
    enqueue(db, { key: 'status:thread:100:1', kind: 'status', text: 'On it.', session: 'thread:100' }, () => at(1));
    const out = gateway(at(1));
    await deliverDue(out.d);
    expect(out.sent).toEqual([{ kind: 'text', text: 'On it.', replyTo: 100 }]);
    expect(await routeInbound(d, msg('use mkdocs', { message_id: '102', reply_to_message_id: '500', reply_to_text: 'On it.' }))).toEqual({ key: 'thread:100', rule: 'reply' });
    expect(pendingInbox(db, 'thread:100').map((m) => m.text)).toEqual(['set up docs', '(in reply to: "On it.")\nuse mkdocs']);
    expect(await routeInbound(d, msg('how is task-7?', { message_id: '103' }))).toEqual({ key: 'task:task-7', rule: 'task' });
  });

  it('a question with options goes out as a poll in its thread; the vote routes back and answers it', async () => {
    const { d } = gateway();
    await routeInbound(d, msg('which host?', { message_id: '200' }));
    enqueue(db, { key: 'question:thread:200:1', kind: 'question', text: 'Where should the docs live?', session: 'thread:200', options: ['Pages', 'Netlify'] }, () => at(1));
    const out = gateway(at(1));
    await deliverDue(out.d);
    expect(out.sent).toEqual([{ kind: 'poll', text: 'Where should the docs live?', replyTo: 200, options: ['Pages', 'Netlify'] }]);
    expect(await routeInbound(d, msg('[poll answer] Where should the docs live?: Netlify', { poll_id: 'p1', message_id: '500', reply_to_message_id: '500' }))).toEqual({ key: 'thread:200', rule: 'reply' });
    expect(db.get<{ answered_at: string | null }>("SELECT answered_at FROM outbox WHERE dedup_key = 'question:thread:200:1'")?.answered_at).not.toBeNull();
    expect(getSession(db, 'thread:500')).toBeNull();
  });

  it('/sessions answers with the index, and a failed send stops the round for a retry', async () => {
    const { d, sent } = gateway();
    await routeInbound(d, msg('first topic', { message_id: '300' }));
    expect(await routeInbound(d, msg('/sessions', { message_id: '301' }))).toEqual({ command: 'sessions' });
    expect(sent[0]!.text).toContain('thread:300 [open] "first topic"');
    enqueue(db, { key: 'status:thread:300:1', kind: 'status', text: 'x', session: 'thread:300' }, () => at(1));
    const down = gateway(at(1), { failSend: true });
    expect(await deliverDue(down.d)).toEqual({ sent: [], failed: 'status:thread:300:1' });
    expect(db.get<{ attempts: number }>("SELECT attempts FROM outbox WHERE dedup_key = 'status:thread:300:1'")?.attempts).toBe(1);
  });
});

describe('gateway: sessions index, topics and handover', () => {
  it('a thread session that continues another hands its messages and thread over, then closes', async () => {
    const { d } = gateway();
    await routeInbound(d, msg('build the docs site', { message_id: '400' }));
    setSessionTopic(db, 'thread:400', 'docs site with mkdocs');
    await routeInbound(d, msg('also add a dark theme to the docs', { message_id: '410' }));
    expect(formatSessionsIndex(sessionsIndex(db, at(1)))).toContain('thread:400 [open] docs site with mkdocs');

    expect(handoverSession(db, cfg(), { from: 'thread:410', to: 'thread:400', state, now: at(2) })).toEqual({ from: 'thread:410', to: 'thread:400', messages: 1 });
    expect(getSession(db, 'thread:410')).toMatchObject({ status: 'closed' });
    expect(pendingInbox(db, 'thread:400').at(-1)!.text).toMatch(/thread:410 found it continues this session\)\nalso add a dark theme/);
    // The owner's next reply in the handed-over thread reaches the session it went to.
    expect(await routeInbound(d, msg('and a logo', { message_id: '411', reply_to_message_id: '410' }))).toEqual({ key: 'thread:400', rule: 'reply' });

    expect(() => handoverSession(db, cfg(), { from: 'thread:400', to: 'thread:400', state })).toThrow(/itself/);
    expect(() => handoverSession(db, cfg(), { from: 'general', to: 'thread:400', state })).toThrow(/Only a thread/);
    expect(() => handoverSession(db, cfg(), { from: 'thread:400', to: 'thread:999', state })).toThrow(/No session/);
    const file = await writeSessionsIndex(db, state, at(3));
    expect(readFileSync(file, 'utf8')).toContain('thread:410 [closed]');
  });

  it('the gateway replaces the router only with the minions channel server', () => {
    expect(isGatewayLaunch(cfg(), { enabled: true, server: 'minions' })).toBe(true);
    expect(isGatewayLaunch(cfg(), { enabled: true, server: 'official' })).toBe(false);
    expect(isGatewayLaunch(cfg(), { enabled: false, server: 'minions' })).toBe(false);
    expect(isGatewayLaunch(defaults(), { enabled: true, server: 'minions' })).toBe(false);
  });
});
