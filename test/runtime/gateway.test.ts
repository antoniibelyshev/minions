// The Telegram gateway (docs/design/autonomy.md Decision 7): owner messages routed without a model, due items sent as
// threaded replies and polls, the sessions index, topics and handovers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { isGatewayLaunch } from '../../src/runtime/coordinator.js';
import { BUDGET_USAGE, deliverDue, formatSessionsIndex, handoverSession, parseBudgetCommand, routeInbound, sessionsIndex, setSessionTopic, writeSessionsIndex, type GatewayDeps } from '../../src/runtime/gateway.js';
import { enqueue } from '../../src/runtime/outbox.js';
import { getSession, pendingInbox } from '../../src/runtime/session-store.js';
import { readJournal, withControl } from '../../src/runtime/control.js';
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

describe('gateway: /budget', () => {
  it('parses show, day and task with an amount or off; anything else is usage', () => {
    expect(parseBudgetCommand('/budget')).toEqual({ kind: 'show' });
    expect(parseBudgetCommand(' /budget@minions_bot ')).toEqual({ kind: 'show' });
    expect(parseBudgetCommand('/budget day 25')).toEqual({ kind: 'set', key: 'dailyUsd', usd: 25 });
    expect(parseBudgetCommand('/budget daily $7.5')).toEqual({ kind: 'set', key: 'dailyUsd', usd: 7.5 });
    expect(parseBudgetCommand('/budget task off')).toEqual({ kind: 'set', key: 'taskUsd', usd: null });
    expect(parseBudgetCommand('/budget task 0')).toMatchObject({ kind: 'usage' });
    expect(parseBudgetCommand('/budget task -3')).toMatchObject({ kind: 'usage' });
    expect(parseBudgetCommand('/budget week 5')).toMatchObject({ kind: 'usage' });
    expect(parseBudgetCommand('/budget day')).toMatchObject({ kind: 'usage' });
    expect(parseBudgetCommand('/budgets')).toBeNull();
    expect(parseBudgetCommand('raise the /budget day 50')).toBeNull();
    expect(parseBudgetCommand('(edited) /budget day 50')).toBeNull();
  });

  const budgetGateway = (owner: string | null) => {
    const g = gateway();
    g.d.controlBase = async () => cfg();
    g.d.billing = 'api-key';
    if (owner !== null) g.d.isOwner = async (id) => id === owner;
    return g;
  };

  it('the paired owner changes a cap: written to the control overlay as the owner, confirmed, never routed to a session', async () => {
    const { d, sent } = budgetGateway('42');
    expect(await routeInbound(d, msg('/budget day 20', { message_id: '700', user_id: '42' }))).toEqual({ command: 'budget' });
    expect(sent[0]).toMatchObject({ kind: 'text', replyTo: 700 });
    expect(sent[0]!.text).toMatch(/^Daily cap set to \$20 \(control revision 1; applies to the next claim\)\.\nToday \(UTC\): ~\$0\.00 est\. \(0 tok\) of daily cap \$20\.\nPer-task cap: off\./);
    expect(withControl(cfg(), state).budgets).toEqual({ dailyUsd: 20, taskUsd: null });
    expect(readJournal(state)[0]).toMatchObject({ actor: 'owner (telegram)', keys: ['budgets.dailyUsd'] });
    expect(getSession(db, 'thread:700')).toBeNull();
    await routeInbound(d, msg('/budget day off', { message_id: '701', user_id: '42' }));
    expect(withControl(cfg(), state).budgets.dailyUsd).toBeNull();
    await routeInbound(d, msg('/budget', { message_id: '702', user_id: '42' }));
    expect(sent[2]!.text).toContain('of daily cap off');
  });

  it('refuses a change from anyone but the paired owner (or without an owner check), and a poll vote is never a command', async () => {
    for (const [owner, user] of [['42', '43'], [null, '42']] as const) {
      const { d, sent } = budgetGateway(owner);
      expect(await routeInbound(d, msg('/budget task 1', { message_id: '710', user_id: user }))).toEqual({ command: 'budget' });
      expect(sent[0]!.text).toBe('Only the paired owner changes the budget.');
      expect(readJournal(state)).toEqual([]);
    }
    const { d, sent } = budgetGateway('42');
    await routeInbound(d, msg('/budget week 3', { message_id: '711', user_id: '42' }));
    expect(sent[0]!.text).toBe(`unknown cap "week". ${BUDGET_USAGE}`);
    expect(await routeInbound(d, msg('/budget day 999', { poll_id: 'p9', message_id: '712', user_id: '42' }))).not.toEqual({ command: 'budget' });
    expect(readJournal(state)).toEqual([]);
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

  it('the index shows each session\'s tokens and estimated cost, a task session\'s workers, and a total', async () => {
    const { d } = gateway();
    await routeInbound(d, msg('cost me', { message_id: '500' }));
    const usage = (data: Record<string, unknown>, taskId: string | null = null) => db.addEvent('usage', taskId, data);
    // Two claude sessions of thread:500 (a reset): both count. Components are weighted (cache read 0.1x, write 1.25x, output 5x).
    usage({ key: 'session:s1', scope: 'session', session: 's1', sessionKey: 'thread:500', tokens: 100_000, model: 'claude-opus-5-5', source: 'transcript', components: { input: 0, cacheRead: 100_000, cacheWrite: 0, output: 0 } });
    usage({ key: 'session:s2', scope: 'session', session: 's2', sessionKey: 'thread:500', tokens: 20_000, model: 'claude-opus-5-5', source: 'transcript', components: { input: 0, cacheRead: 0, cacheWrite: 20_000, output: 0 } });
    db.exec("INSERT INTO sessions (key, kind, claude_session_id, status, model, config_dir, opened_at, resumes) VALUES ('task:task-7', 'task', NULL, 'open', NULL, '/x', ?, 0)", T0.toISOString());
    usage({ key: 'lease:l1', scope: 'lease', leaseId: 'l1', role: 'engineer', attempt: 1, tokens: 1_000_000, model: 'claude-sonnet-5-5', source: 'record' }, 'task-7');
    const idx = sessionsIndex(db, at(1), 'api-key');
    expect(idx.find((e) => e.key === 'thread:500')!.spend).toEqual({ tokens: 120_000, usd: 0.18, workerTokens: 0, workerUsd: 0 });
    expect(idx.find((e) => e.key === 'task:task-7')!.spend).toMatchObject({ tokens: 0, workerTokens: 1_000_000, workerUsd: 3 });
    const text = formatSessionsIndex(idx);
    expect(text).toContain('thread:500 [open] "cost me" · 120k tok ~$0.18');
    expect(text).toContain('+ workers 1.0M tok ~$3.00');
    expect(text).toMatch(/Total: 1\.1M tok ~\$3\.18/);
    // A subscription: tokens only.
    expect(formatSessionsIndex(sessionsIndex(db, at(1), 'subscription'))).toContain('thread:500 [open] "cost me" · 120k tok ·');
  });

  it('the gateway replaces the router only with the minions channel server', () => {
    expect(isGatewayLaunch(cfg(), { enabled: true, server: 'minions' })).toBe(true);
    expect(isGatewayLaunch(cfg(), { enabled: true, server: 'official' })).toBe(false);
    expect(isGatewayLaunch(cfg(), { enabled: false, server: 'minions' })).toBe(false);
    expect(isGatewayLaunch(defaults(), { enabled: true, server: 'minions' })).toBe(false);
  });
});
