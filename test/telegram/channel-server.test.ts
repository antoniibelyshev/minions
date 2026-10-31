// The minions-owned channel server (task-67.2, phase 1) with a fake Bot API (an injected fetch behind the real BotApi)
// and a fake MCP client (paired streams through serveStdio). No network, no real token, no claude session.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotApi, type TelegramUpdate } from '../../src/telegram/bot-api.js';
import {
  acquireChannelLock, CHANNEL_BOT_ERRORS, ChannelServer, NOT_ACTIVE, OTHER_POLLER, readChannelToken, serveStdio, type ChannelProc,
} from '../../src/telegram/channel/server.js';

const TOKEN = '123456789:AAHfaketokenfaketokenfaketoken_-1234';
const BOT_ID = '123456789';
const OWNER = 4242;
const LAUNCH = 'launch-1';
const WRAPPER = 300;
const CLAUDE = 400;
const SELF = 500;

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tg-channel-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The fake Bot API: getUpdates answers queued batches or HTTP statuses (then nothing); sendMessage returns ids. */
function fakeBot(queue: (TelegramUpdate[] | number | { status: number; description: string })[] = []) {
  const calls: { url: string; method: string; body: Record<string, any> }[] = [];
  let nextId = 100;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    calls.push({ url: String(url), method, body });
    if (method === 'sendMessage') return json(200, { ok: true, result: { message_id: nextId++ } });
    if (method === 'sendPoll') return json(200, { ok: true, result: { message_id: nextId++, poll: { id: `poll-${nextId - 1}` } } });
    if (method === 'getUpdates') {
      const next = queue.shift();
      if (next === undefined) return json(200, { ok: true, result: [] });
      if (typeof next === 'number') return json(next, { ok: false, description: 'Conflict' });
      if (!Array.isArray(next)) return json(next.status, { ok: false, description: next.description });
      return json(200, { ok: true, result: next });
    }
    return json(200, { ok: true, result: true });
  }) as typeof fetch;
  return { calls, queue, api: new BotApi({ token: TOKEN, fetch: f, errors: CHANNEL_BOT_ERRORS, sleep: async () => undefined }), sends: () => calls.filter((c) => c.method === 'sendMessage') };
}

interface P { cmd: string; parent: number; start: string; alive?: boolean }
/** A process table: the wrapper, the coordinator claude, this server as its child. */
function fakeProc(extra: Record<number, P> = {}) {
  const table: Record<number, P> = {
    [WRAPPER]: { cmd: 'node /usr/local/bin/minions coordinator run', parent: 1, start: 'w' },
    [CLAUDE]: { cmd: 'claude --dangerously-load-development-channels server:minions-telegram', parent: WRAPPER, start: 'c' },
    [SELF]: { cmd: 'node /usr/local/bin/minions telegram channel serve', parent: CLAUDE, start: 's' },
    ...extra,
  };
  const killed: [number, string][] = [];
  const proc: ChannelProc = {
    alive: (pid) => !!table[pid] && table[pid]!.alive !== false,
    cmdline: (pid) => table[pid]?.cmd ?? null,
    parentOf: (pid) => table[pid]?.parent ?? null,
    startTime: (pid) => table[pid]?.start ?? null,
    kill: (pid, s) => { killed.push([pid, s]); },
  };
  return { table, proc, killed };
}

function server(bot: ReturnType<typeof fakeBot>, o: { launchId?: string | undefined; record?: { pid: number; launchId?: string } | null; proc?: ReturnType<typeof fakeProc>; selfPid?: number } = {}) {
  const proc = o.proc ?? fakeProc();
  const logs: string[] = [];
  const slept: number[] = [];
  const s = new ChannelServer({
    api: bot.api, botId: BOT_ID, stateDir: dir, launchId: 'launchId' in o ? o.launchId : LAUNCH,
    readLaunch: async () => (o.record === undefined ? { pid: WRAPPER, launchId: LAUNCH } : o.record),
    proc: proc.proc, selfPid: o.selfPid ?? SELF, log: (l) => logs.push(l), sleep: async (ms) => { slept.push(ms); }, random: () => 1,
    newCode: () => 'abc123', now: () => Date.parse('2026-10-29T12:00:00Z'),
  });
  return { s, logs, slept, proc };
}

const writeAccess = (v: unknown) => writeFileSync(join(dir, 'access.json'), JSON.stringify(v));
const ownerAccess = () => writeAccess({ dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {} });
const dm = (update_id: number, text: string, o: { from?: number; reply?: TelegramUpdate['message']; quote?: string; type?: string } = {}): TelegramUpdate => ({
  update_id, message: {
    message_id: 1000 + update_id, date: 1_800_000_000, text, from: { id: o.from ?? OWNER, username: 'owner' }, chat: { id: o.from ?? OWNER, type: o.type ?? 'private' },
    ...(o.reply ? { reply_to_message: o.reply } : {}), ...(o.quote ? { quote: { text: o.quote, is_manual: true } } : {}),
  },
});

/** The fake MCP client: writes requests to the server's stdin, collects every line it writes to stdout. */
function mcpClient(s: ChannelServer) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  let buf = '';
  output.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const done = serveStdio(s, input, output);
  let id = 0;
  const request = async (method: string, params?: unknown) => {
    const myId = ++id;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, ...(params ? { params } : {}) }) + '\n');
    for (let t = 0; t < 200; t++) {
      const r = lines.find((l) => l.id === myId);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 2));
    }
    throw new Error(`no answer to ${method}`);
  };
  const notify = (method: string) => { input.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); };
  const close = async () => { input.end(); await done; };
  return { request, notify, close, lines, notifications: () => lines.filter((l) => l.method === 'notifications/claude/channel') };
}

describe('main message flow', () => {
  it('handshake, inbound owner message, reply with reply_to and ref, then the owner replying to that message gets reply_to_ref', async () => {
    ownerAccess();
    const bot = fakeBot([[dm(1, 'deploy?')]]);
    const { s } = server(bot);
    expect(await s.activate()).toEqual({ active: true });
    const c = mcpClient(s);
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    expect(init.result.capabilities.experimental).toEqual({ 'claude/channel': {} });
    expect(init.result.serverInfo.name).toBe('minions-telegram');
    c.notify('notifications/initialized');
    expect((await c.request('tools/list')).result.tools.map((t: { name: string }) => t.name)).toEqual(['reply', 'poll', 'close_poll']);

    expect(await s.pollOnce()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(c.notifications()).toHaveLength(1);
    expect(c.notifications()[0].params).toMatchObject({ content: 'deploy?', meta: { chat_id: String(OWNER), message_id: '1001', user_id: String(OWNER) } });

    const r = await c.request('tools/call', { name: 'reply', arguments: { text: 'Deployed.', reply_to: '1001', ref: '#58' } });
    expect(r.result).toEqual({ content: [{ type: 'text', text: 'sent (id: 100)' }] });
    const sent = bot.sends().at(-1)!.body;
    expect(sent).toMatchObject({ chat_id: String(OWNER), text: 'Deployed.\n\nref: #58', reply_parameters: { message_id: 1001 } });
    expect(statSync(join(dir, 'channel-messages.json')).mode & 0o777).toBe(0o600);
    // The map keeps the text without the ref footer, for replies where Telegram omits reply_to_message.text.
    expect(JSON.parse(readFileSync(join(dir, 'channel-messages.json'), 'utf8')).messages).toMatchObject([{ messageId: 100, ref: '58', textHead: 'Deployed.' }]);

    // Telegram sends the replied message back; the quoted part and the ref come from the message map.
    bot.queue.push([dm(2, 'and staging?', { reply: { message_id: 100, text: 'Deployed.\n\nref: #58', from: { id: Number(BOT_ID), is_bot: true } }, quote: 'Deployed.' })]);
    await s.pollOnce();
    await new Promise((r2) => setTimeout(r2, 5));
    expect(c.notifications()[1].params.meta).toMatchObject({
      reply_to_message_id: '100', reply_to_from: 'bot', reply_to_text: 'Deployed.', quote: 'partial', reply_to_ref: '58',
    });
    // The token never reaches the MCP client.
    expect(JSON.stringify(c.lines)).not.toContain('AAHfaketoken');
    await c.close();
  });

  it('refuses a reply to a chat that is not allowlisted, and an unknown method gets -32601', async () => {
    ownerAccess();
    const { s } = server(fakeBot());
    await s.activate();
    const c = mcpClient(s);
    const r = await c.request('tools/call', { name: 'reply', arguments: { text: 'hi', chat_id: '777' } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/not allowlisted/);
    expect((await c.request('resources/list')).error.code).toBe(-32601);
    await c.close();
  });

  it('drops strangers and groups under allowlist; under pairing a stranger gets a code that lands in access.json', async () => {
    ownerAccess();
    const bot = fakeBot([[dm(1, 'hi', { from: 777 }), dm(2, 'hi group', { type: 'group' })]]);
    const { s } = server(bot);
    await s.activate();
    const seen: unknown[] = [];
    s.onNotification((n) => seen.push(n));
    await s.pollOnce();
    expect(seen).toEqual([]);
    expect(bot.sends()).toEqual([]);

    writeAccess({ dmPolicy: 'pairing', allowFrom: [String(OWNER)], groups: {}, pending: {} });
    bot.queue.push([dm(3, 'let me in', { from: 777 })]);
    await s.pollOnce();
    expect(seen).toEqual([]);
    expect(bot.sends()[0]!.body).toMatchObject({ chat_id: 777, text: expect.stringContaining('abc123') });
    const access = JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8'));
    expect(access.pending.abc123).toMatchObject({ senderId: '777', chatId: '777', replies: 1 });
    expect(statSync(join(dir, 'access.json')).mode & 0o777).toBe(0o600);
  });

  it('answers /status itself without forwarding it', async () => {
    ownerAccess();
    const bot = fakeBot([[dm(1, '/status')]]);
    const { s } = server(bot);
    await s.activate();
    const seen: unknown[] = [];
    s.onNotification((n) => seen.push(n));
    await s.pollOnce();
    expect(seen).toEqual([]);
    expect(bot.sends()[0]!.body.text).toMatch(/^Paired/);
  });

  it('persists the offset before handling, so a restarted server does not replay the batch', async () => {
    ownerAccess();
    const bot = fakeBot([[dm(7, 'one')]]);
    const { s } = server(bot);
    await s.activate();
    await s.pollOnce();
    expect(JSON.parse(readFileSync(join(dir, 'channel-offset.json'), 'utf8'))).toEqual({ version: 1, botId: BOT_ID, offset: 8 });
    await s.close();
    const again = server(bot);
    await again.s.activate();
    await again.s.pollOnce();
    expect(bot.calls.filter((c) => c.method === 'getUpdates').at(-1)!.body.offset).toBe(8);
  });
});

describe('coordinator wins, strays lose', () => {
  it('does not poll without the launch id, with another launch id, or under a foreign claude; tools say why', async () => {
    ownerAccess();
    for (const o of [{ launchId: undefined }, { record: { pid: WRAPPER, launchId: 'other' } }, { record: null }]) {
      const bot = fakeBot([[dm(1, 'x')]]);
      const { s } = server(bot, o);
      expect((await s.activate()).active).toBe(false);
      expect(await s.pollOnce()).toBe(false);
      expect(bot.calls).toEqual([]);
      const r = await s.callTool('reply', { text: 'hi' });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain(NOT_ACTIVE);
    }
    // A nested `claude -p` under a worker's Bash under the coordinator claude: its nearest claude is not the coordinator's.
    const proc = fakeProc({ 700: { cmd: 'bash -c claude -p hi', parent: CLAUDE, start: 'b' }, 800: { cmd: 'claude -p hi', parent: 700, start: 'n' },
      900: { cmd: 'node minions telegram channel serve', parent: 800, start: 'x' } });
    const nested = server(fakeBot(), { proc, selfPid: 900 });
    expect(await nested.s.activate()).toEqual({ active: false, reason: 'this server was not started by the coordinator launch' });
    expect(existsSync(join(dir, 'channel.lock'))).toBe(false);
  });

  it('a live lock holder keeps the channel; a stale lock (dead or reused pid) is taken over', async () => {
    const proc = fakeProc({ 600: { cmd: 'node minions telegram channel serve', parent: CLAUDE, start: 'h' } });
    const path = join(dir, 'channel.lock');
    writeFileSync(path, JSON.stringify({ version: 1, pid: 600, start: 'h', launchId: LAUNCH, kills: 0 }));
    expect(await server(fakeBot(), { proc }).s.activate()).toEqual({ active: false, reason: 'channel.lock is held by pid 600' });
    // Same pid, other start time: the pid was reused, the lock is stale.
    writeFileSync(path, JSON.stringify({ version: 1, pid: 600, start: 'old', launchId: LAUNCH, kills: 0 }));
    expect(await acquireChannelLock(path, { pid: SELF, start: 's', launchId: LAUNCH }, proc.proc)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(SELF);
  });
});

describe('409 handling', () => {
  const stray = () => fakeProc({
    700: { cmd: 'bash', parent: CLAUDE, start: 'b' }, 800: { cmd: 'claude -p hi', parent: 700, start: 'n' },
    900: { cmd: 'bun server.ts', parent: 800, start: 'stray' },
  });
  const botPid = (pid: number) => writeFileSync(join(dir, 'bot.pid'), `${pid}\n`);

  it('a single 409 only retries after a bounded backoff', async () => {
    ownerAccess();
    const bot = fakeBot([409, [dm(1, 'after')]]);
    const { s, slept, proc } = server(bot, { proc: stray() });
    botPid(900);
    await s.activate();
    expect(await s.pollOnce()).toBe(true);
    expect(slept).toEqual([1000]);
    expect(await s.pollOnce()).toBe(true);
    expect(proc.killed).toEqual([]);
    expect(s.status.active).toBe(true);
  });

  it('three in a row stops a stray official server.ts once; a second run after the kill stops polling instead', async () => {
    ownerAccess();
    const bot = fakeBot([409, 409, 409, 409, 409, 409]);
    const { s, proc, slept } = server(bot, { proc: stray() });
    botPid(900);
    await s.activate();
    for (let i = 0; i < 3; i++) expect(await s.pollOnce()).toBe(true);
    expect(proc.killed).toEqual([[900, 'SIGTERM']]);
    expect(JSON.parse(readFileSync(join(dir, 'channel.lock'), 'utf8')).kills).toBe(1);
    expect(slept.every((ms) => ms <= 30_000)).toBe(true);
    expect(await s.pollOnce()).toBe(true);
    expect(await s.pollOnce()).toBe(true);
    expect(await s.pollOnce()).toBe(false);
    expect(proc.killed).toHaveLength(1);
    expect(s.status).toMatchObject({ active: false, reason: expect.stringContaining(OTHER_POLLER) });
    expect((await s.callTool('reply', { text: 'x' })).content[0]!.text).toContain(OTHER_POLLER);
  });

  it('never signals a pid whose argv is not an official server.ts (PID reuse) or one under the coordinator claude', async () => {
    ownerAccess();
    const reused = fakeProc({ 900: { cmd: 'vim notes.txt', parent: 1, start: 'v' } });
    const a = server(fakeBot([409, 409, 409]), { proc: reused });
    botPid(900);
    await a.s.activate();
    for (let i = 0; i < 2; i++) await a.s.pollOnce();
    expect(await a.s.pollOnce()).toBe(false);
    expect(reused.killed).toEqual([]);
    expect(a.s.status).toMatchObject({ active: false, reason: expect.stringContaining('not an official plugin server') });
    await a.s.close();

    const own = fakeProc({ 900: { cmd: 'bun server.ts', parent: CLAUDE, start: 'o' } });
    const b = server(fakeBot([409, 409, 409]), { proc: own });
    await b.s.activate();
    for (let i = 0; i < 3; i++) await b.s.pollOnce();
    expect(own.killed).toEqual([]);
  });

  it('a restarted server of the same launch does not kill again (the count is in the lock file)', async () => {
    ownerAccess();
    const proc = stray();
    writeFileSync(join(dir, 'channel.lock'), JSON.stringify({ version: 1, pid: 650, start: 'dead', launchId: LAUNCH, kills: 1 }));
    botPid(900);
    const { s } = server(fakeBot([409, 409, 409]), { proc });
    await s.activate();
    expect(s.kills).toBe(1);
    for (let i = 0; i < 2; i++) await s.pollOnce();
    expect(await s.pollOnce()).toBe(false);
    expect(proc.killed).toEqual([]);
  });

  it('401 stops polling with a reason and the token never reaches the log', async () => {
    ownerAccess();
    const { s, logs } = server(fakeBot([{ status: 400, description: `bad bot${TOKEN}` }, 401]));
    await s.activate();
    expect(await s.pollOnce()).toBe(true);
    expect(await s.pollOnce()).toBe(false);
    expect(s.status).toMatchObject({ active: false, reason: expect.stringContaining('rejected') });
    expect(logs.join('\n')).toContain('returned 400');
    expect(logs.join('\n')).not.toContain('AAHfaketoken');
  });
});

describe('polls and threaded replies (autonomy.md Decision 5)', () => {
  const answer = (update_id: number, poll_id: string, option_ids: number[], from = OWNER): TelegramUpdate =>
    ({ update_id, poll_answer: { poll_id, option_ids, user: { id: from, username: 'owner' } } });

  it('poll sends a non-anonymous sendPoll; the owner\'s vote and its retraction become notifications; close_poll stops it', async () => {
    ownerAccess();
    const bot = fakeBot();
    const { s, logs } = server(bot);
    await s.activate();
    const c = mcpClient(s);
    expect(JSON.stringify((await c.request('initialize', {})).result.instructions)).toMatch(/poll answer/);
    const r = await c.request('tools/call', { name: 'poll', arguments: { question: 'Ship which?', options: ['A', 'B', 'C'], multiple: true, reply_to: '77', ref: 'task-9' } });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ poll_id: 'poll-100', message_id: 100 });
    expect(bot.calls.find((x) => x.method === 'sendPoll')!.body).toEqual({
      chat_id: String(OWNER), question: 'Ship which?', options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }], is_anonymous: false, allows_multiple_answers: true,
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    });
    expect(JSON.parse(readFileSync(join(dir, 'channel-messages.json'), 'utf8')).messages[0].poll).toEqual({ pollId: 'poll-100', question: 'Ship which?', options: ['A', 'B', 'C'] });

    bot.queue.push([answer(1, 'poll-100', [0, 2]), answer(2, 'poll-100', [], 777), answer(3, 'poll-unknown', [1]), answer(4, 'poll-100', [])]);
    await s.pollOnce();
    await new Promise((res) => setTimeout(res, 5));
    expect(bot.calls.find((x) => x.method === 'getUpdates')!.body.allowed_updates).toEqual(['message', 'edited_message', 'poll_answer']);
    const ns = c.notifications().map((n) => n.params);
    expect(ns).toHaveLength(2);
    expect(ns[0]).toMatchObject({
      content: '[poll answer] Ship which?: A; C',
      meta: { poll_id: 'poll-100', option_ids: '0,2', message_id: '100', reply_to_message_id: '100', reply_to_ref: 'task-9', user_id: String(OWNER) },
    });
    expect(ns[1]).toMatchObject({ content: '[poll answer] Ship which?: (vote retracted)', meta: { option_ids: '' } });
    expect(logs.join('\n')).toMatch(/dropped a poll answer: poll voter not allowlisted[\s\S]*dropped a poll answer: unknown poll/);

    expect((await c.request('tools/call', { name: 'close_poll', arguments: { poll_id: 'poll-100' } })).result.content[0].text).toMatch(/closed/);
    expect(bot.calls.find((x) => x.method === 'stopPoll')!.body).toEqual({ chat_id: String(OWNER), message_id: 100 });
    expect((await c.request('tools/call', { name: 'close_poll', arguments: { poll_id: 'nope' } })).result.isError).toBe(true);
    expect((await c.request('tools/call', { name: 'poll', arguments: { question: 'Q', options: ['only'] } })).result.content[0].text).toMatch(/2 to 10/);
    await c.close();
  });

  it('reply defaults reply_to to the owner\'s newest message (kept across a restart); an explicit reply_to wins; an edit does not move it back', async () => {
    ownerAccess();
    const bot = fakeBot([[dm(1, 'first'), dm(2, 'second')]]);
    const { s } = server(bot);
    await s.activate();
    await s.pollOnce();
    await s.callTool('reply', { text: 'ok' });
    expect(bot.sends().at(-1)!.body.reply_parameters).toEqual({ message_id: 1002, allow_sending_without_reply: true });
    bot.queue.push([{ update_id: 3, edited_message: { ...dm(1, 'first!').message!, message_id: 1001 } }]);
    await s.pollOnce();
    await s.callTool('reply', { text: 'explicit', reply_to: '1001' });
    expect(bot.sends().at(-1)!.body.reply_parameters).toEqual({ message_id: 1001, allow_sending_without_reply: true });
    expect((await s.callTool('reply', { text: 'bad', reply_to: 'x' })).isError).toBe(true);

    const again = server(bot).s;
    await again.activate();
    await again.callTool('reply', { text: 'after restart' });
    expect(bot.sends().at(-1)!.body.reply_parameters).toEqual({ message_id: 1002, allow_sending_without_reply: true });
  });

  it('reply without any inbound message sends no reply_parameters', async () => {
    ownerAccess();
    const bot = fakeBot();
    const { s } = server(bot);
    await s.activate();
    await s.callTool('reply', { text: 'hello' });
    expect(bot.sends().at(-1)!.body.reply_parameters).toBeUndefined();
  });
});

describe('token from file', () => {
  it('reads only the file MINIONS_TELEGRAM_TOKEN_FILE names, never TELEGRAM_BOT_TOKEN, and never echoes a bad file', async () => {
    const file = join(dir, 'token');
    writeFileSync(file, `${TOKEN}\n`);
    expect(await readChannelToken({ MINIONS_TELEGRAM_TOKEN_FILE: file })).toEqual({ token: TOKEN, botId: BOT_ID });
    await expect(readChannelToken({ TELEGRAM_BOT_TOKEN: TOKEN })).rejects.toThrow(/MINIONS_TELEGRAM_TOKEN_FILE is not set/);
    writeFileSync(file, 'sk-not-a-bot-token-but-secret');
    const e = await readChannelToken({ MINIONS_TELEGRAM_TOKEN_FILE: file }).catch((x: Error) => x);
    expect((e as Error).message).toMatch(/does not hold a bot token/);
    expect((e as Error).message).not.toContain('sk-not-a-bot');
    await expect(readChannelToken({ MINIONS_TELEGRAM_TOKEN_FILE: join(dir, 'missing') })).rejects.toThrow(/unreadable \(ENOENT\)/);
  });
});
