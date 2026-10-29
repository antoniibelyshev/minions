// QA regressions for the minions-owned channel server (task-67.2): error and retry handling of the shared Bot API
// client as the server sees it, access.json failure modes, and the one-kill-per-launch rule across a clean restart.
// Fake Bot API (an injected fetch behind the real BotApi) and a fake process table only: no network, no real token.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotApi, type TelegramUpdate } from '../../src/telegram/bot-api.js';
import { CHANNEL_BOT_ERRORS, ChannelServer, type ChannelProc } from '../../src/telegram/channel/server.js';

const TOKEN = '123456789:AAHfaketokenfaketokenfaketoken_-1234';
const BOT_ID = '123456789';
const OWNER = 4242;
const STRANGER = 777;
const LAUNCH = 'launch-qa';
const WRAPPER = 300;
const CLAUDE = 400;
const SELF = 500;

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-channel-qa-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Answer = TelegramUpdate[] | { status: number; description?: string; retryAfter?: number } | 'network';

/** getUpdates and sendMessage each answer from their own queue (then: no updates / a new message id). */
function fakeBot(o: { updates?: Answer[]; sends?: Answer[] } = {}) {
  const updates = [...(o.updates ?? [])];
  const sends = [...(o.sends ?? [])];
  const calls: { method: string; body: Record<string, any> }[] = [];
  let nextId = 100;
  const answer = (a: Answer | undefined, ok: () => Response) => {
    if (a === undefined) return ok();
    if (a === 'network') throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/x`);
    if (Array.isArray(a)) return json(200, { ok: true, result: a });
    return json(a.status, { ok: false, description: a.description ?? `status ${a.status}`, ...(a.retryAfter ? { parameters: { retry_after: a.retryAfter } } : {}) });
  };
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    calls.push({ method, body });
    if (method === 'getUpdates') return answer(updates.shift(), () => json(200, { ok: true, result: [] }));
    if (method === 'sendMessage') return answer(sends.shift(), () => json(200, { ok: true, result: { message_id: nextId++ } }));
    return json(200, { ok: true, result: true });
  }) as typeof fetch;
  const apiSleeps: number[] = [];
  const api = new BotApi({ token: TOKEN, fetch: f, errors: CHANNEL_BOT_ERRORS, sleep: async (ms) => { apiSleeps.push(ms); } });
  return { api, calls, apiSleeps, updates, sendCalls: () => calls.filter((c) => c.method === 'sendMessage') };
}

interface P { cmd: string; parent: number; start: string }
function fakeProc(extra: Record<number, P> = {}) {
  const table: Record<number, P> = {
    [WRAPPER]: { cmd: 'node /usr/local/bin/minions coordinator run', parent: 1, start: 'w' },
    [CLAUDE]: { cmd: 'claude --channels server:minions-telegram', parent: WRAPPER, start: 'c' },
    [SELF]: { cmd: 'node /usr/local/bin/minions telegram channel serve', parent: CLAUDE, start: 's' },
    600: { cmd: 'node /usr/local/bin/minions telegram channel serve', parent: CLAUDE, start: 's2' },
    // A stray official plugin server under a nested `claude -p`.
    700: { cmd: 'bash', parent: CLAUDE, start: 'b' }, 800: { cmd: 'claude -p hi', parent: 700, start: 'n' },
    900: { cmd: 'bun server.ts', parent: 800, start: 'stray' },
    ...extra,
  };
  const killed: [number, string][] = [];
  const proc: ChannelProc = {
    alive: (pid) => !!table[pid],
    cmdline: (pid) => table[pid]?.cmd ?? null,
    parentOf: (pid) => table[pid]?.parent ?? null,
    startTime: (pid) => table[pid]?.start ?? null,
    kill: (pid, s) => { killed.push([pid, s]); },
  };
  return { proc, killed };
}

function server(bot: ReturnType<typeof fakeBot>, o: { proc?: ReturnType<typeof fakeProc>; selfPid?: number } = {}) {
  const proc = o.proc ?? fakeProc();
  const logs: string[] = [];
  const slept: number[] = [];
  const seen: { content: string; meta: Record<string, string> }[] = [];
  const s = new ChannelServer({
    api: bot.api, botId: BOT_ID, stateDir: dir, launchId: LAUNCH,
    readLaunch: async () => ({ pid: WRAPPER, launchId: LAUNCH }),
    proc: proc.proc, selfPid: o.selfPid ?? SELF, log: (l) => logs.push(l), sleep: async (ms) => { slept.push(ms); }, random: () => 1,
    newCode: () => 'abc123', now: () => Date.parse('2026-10-29T12:00:00Z'),
  });
  s.onNotification((n) => seen.push(n));
  return { s, logs, slept, seen, proc };
}

const accessPath = () => join(dir, 'access.json');
const writeAccess = (v: unknown) => writeFileSync(accessPath(), typeof v === 'string' ? v : JSON.stringify(v));
const ownerAccess = (policy = 'allowlist') => writeAccess({ dmPolicy: policy, allowFrom: [String(OWNER)], groups: {}, pending: {} });
const msg = (update_id: number, text: string, from = OWNER, edited = false): TelegramUpdate => {
  const m = { message_id: 1000 + update_id, date: 1_800_000_000, text, from: { id: from }, chat: { id: from, type: 'private' } };
  return edited ? { update_id, edited_message: m } : { update_id, message: m };
};

describe('getUpdates errors: the poll loop keeps going with bounded waits', () => {
  it('waits out a 429 retry_after (clamped to 60 s), retries a network failure after 5 s, and never logs the token', async () => {
    ownerAccess();
    const bot = fakeBot({ updates: [{ status: 429, retryAfter: 3 }, { status: 429, retryAfter: 600 }, 'network', { status: 502 }, [msg(1, 'through')]] });
    const { s, slept, logs, seen } = server(bot);
    await s.activate();
    for (let i = 0; i < 4; i++) expect(await s.pollOnce()).toBe(true);
    expect(slept).toEqual([3000, 60_000, 5000, 5000]);
    expect(s.status.active).toBe(true);
    expect(await s.pollOnce()).toBe(true);
    expect(seen.map((n) => n.content)).toEqual(['through']);
    expect(logs.join('\n')).toContain('could not reach the Telegram Bot API');
    expect(logs.join('\n')).not.toContain('AAHfaketoken');
  });

  it('an aborted long poll ends run() without a retry sleep', async () => {
    ownerAccess();
    const bot = fakeBot({ updates: ['network'] });
    const { s, slept } = server(bot);
    await s.activate();
    const stop = new AbortController();
    stop.abort();
    await s.run(stop.signal);
    expect(await s.pollOnce(stop.signal)).toBe(true);
    expect(slept).toEqual([]);
  });
});

describe('reply tool: Bot API errors become tool errors, the channel stays up', () => {
  it('a 403 (owner blocked the bot) is an isError result without the token; the next reply works', async () => {
    ownerAccess();
    const bot = fakeBot({ sends: [{ status: 403, description: `Forbidden: bot was blocked by the user (bot${TOKEN})` }] });
    const { s } = server(bot);
    await s.activate();
    const r = await s.callTool('reply', { text: 'hello' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/sendMessage returned 403/);
    expect(r.content[0]!.text).not.toContain('AAHfaketoken');
    expect(s.status.active).toBe(true);
    expect((await s.callTool('reply', { text: 'again' })).content[0]!.text).toBe('sent (id: 100)');
  });

  it('a 429 on sendMessage is waited out once and sent; a second 429 is an error', async () => {
    ownerAccess();
    const bot = fakeBot({ sends: [{ status: 429, retryAfter: 2 }, undefined as never, { status: 429, retryAfter: 2 }, { status: 429, retryAfter: 2 }] });
    // undefined in the queue means "answer normally".
    const { s } = server(bot);
    await s.activate();
    expect((await s.callTool('reply', { text: 'one' })).content[0]!.text).toBe('sent (id: 100)');
    expect(bot.apiSleeps).toEqual([2000]);
    const second = await s.callTool('reply', { text: 'two' });
    expect(second.isError).toBe(true);
    expect(bot.sendCalls()).toHaveLength(4);
  });

  it('a bad ref or reply_to sends nothing', async () => {
    ownerAccess();
    const bot = fakeBot();
    const { s } = server(bot);
    await s.activate();
    expect((await s.callTool('reply', { text: 'x', ref: 'bad ref; rm -rf' })).isError).toBe(true);
    expect((await s.callTool('reply', { text: 'x', reply_to: 'abc' })).content[0]!.text).toBe('reply_to must be a message_id');
    expect((await s.callTool('reply', { text: '   ' })).content[0]!.text).toBe('text is required');
    expect(bot.sendCalls()).toEqual([]);
  });
});

describe('access.json failure modes and edits', () => {
  it('a corrupt access.json drops the owner too, refuses replies, and is never rewritten', async () => {
    writeAccess('{"dmPolicy": "allowlist", "allowFrom": ["4242"');
    const bot = fakeBot({ updates: [[msg(1, 'hi'), msg(2, 'let me in', STRANGER)]] });
    const { s, seen, logs } = server(bot);
    await s.activate();
    await s.pollOnce();
    expect(seen).toEqual([]);
    expect(bot.sendCalls()).toEqual([]);
    const r = await s.callTool('reply', { text: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/disabled/);
    expect(readFileSync(accessPath(), 'utf8')).toBe('{"dmPolicy": "allowlist", "allowFrom": ["4242"');
    expect(logs.join('\n')).toContain('not valid JSON');
  });

  it('an absent access.json is the plugin default (pairing): a stranger gets a code, nothing is forwarded', async () => {
    const bot = fakeBot({ updates: [[msg(1, 'hello', STRANGER)]] });
    const { s, seen } = server(bot);
    await s.activate();
    await s.pollOnce();
    expect(seen).toEqual([]);
    expect(bot.sendCalls()[0]!.body.text).toContain('abc123');
    expect(JSON.parse(readFileSync(accessPath(), 'utf8'))).toMatchObject({ dmPolicy: 'pairing', allowFrom: [], pending: { abc123: { senderId: String(STRANGER) } } });
  });

  it('an edit by a stranger never issues a code; an edit by the owner is forwarded as edited', async () => {
    ownerAccess('pairing');
    const bot = fakeBot({ updates: [[msg(1, 'sneaky', STRANGER, true), msg(2, 'fixed typo', OWNER, true), msg(3, '/status', OWNER, true)]] });
    const { s, seen } = server(bot);
    await s.activate();
    await s.pollOnce();
    expect(bot.sendCalls()).toEqual([]);
    expect(JSON.parse(readFileSync(accessPath(), 'utf8')).pending).toEqual({});
    expect(seen.map((n) => [n.content, n.meta.edited])).toEqual([['(edited) fixed typo', 'true'], ['(edited) /status', 'true']]);
  });

  it('bot commands from a stranger under allowlist get no answer', async () => {
    ownerAccess();
    const bot = fakeBot({ updates: [[msg(1, '/start', STRANGER), msg(2, '/status', STRANGER), msg(3, '/help@SomeBot', STRANGER)]] });
    const { s, seen } = server(bot);
    await s.activate();
    await s.pollOnce();
    expect(seen).toEqual([]);
    expect(bot.sendCalls()).toEqual([]);
  });
});

describe('one kill per launch', () => {
  // Defect (QA, task-67.2): close() deletes channel.lock and with it the kill count, so a server of the same launch
  // started after a clean exit (claude restarting the MCP server, `/mcp reconnect minions-telegram`) may SIGTERM a
  // stray poller again. docs/design/telegram-channel.md: "a restarted server of the same launch does not kill again".
  // `it.fails` passes while the defect exists; flip it to `it` once fixed.
  it.fails('a server restarted after a clean exit in the same launch does not kill a second time', async () => {
    ownerAccess();
    writeFileSync(join(dir, 'bot.pid'), '900\n');
    const proc = fakeProc();
    const first = server(fakeBot({ updates: [{ status: 409 }, { status: 409 }, { status: 409 }] }), { proc });
    await first.s.activate();
    for (let i = 0; i < 3; i++) await first.s.pollOnce();
    expect(proc.killed).toEqual([[900, 'SIGTERM']]);
    await first.s.close();

    const second = server(fakeBot({ updates: [{ status: 409 }, { status: 409 }, { status: 409 }] }), { proc, selfPid: 600 });
    await second.s.activate();
    expect(second.s.kills).toBe(1);
    for (let i = 0; i < 3; i++) await second.s.pollOnce();
    expect(proc.killed).toHaveLength(1);
  });
});
