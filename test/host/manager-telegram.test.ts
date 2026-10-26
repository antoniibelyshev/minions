// Host manager bot, part 2 (task-53.5.2): the Bot API ManagerTransport. Temp MINIONS_HOME and a fake Bot API (fetch)
// with a fake clock: no network, Docker or live state. The core side (HostManager's /status and /requests views) runs
// against a journal written by the test.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const T = await import('../../src/host/manager-telegram.js');
const M = await import('../../src/host/manager.js');
const J = await import('../../src/host/change-journal.js');
const { managerDir } = await import('../../src/core/paths.js');
const { truncateCodePoints } = await import('../../src/core/control-chars.js');
const { withHome } = await import('./fixtures.js');
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;
type ManagerAccess = import('../../src/host/manager-bot.js').ManagerAccess;
type ManagerOffer = import('../../src/host/manager.js').ManagerOffer;
type ManagerCommands = import('../../src/host/manager.js').ManagerCommands;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type ProjectJson = import('../../src/host/project.js').ProjectJson;

const OWNER = 4242;
const STRANGER = 777;
const TOKEN = '555666777:MMHmanagermanagermanagermanager_-9876';
const ACCESS: ManagerAccess = { version: 1, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T00:00:00.000Z' };
const RID = 'cr_0a1b2c3d';
const NONCE = 'f'.repeat(32);
const NONCE2 = 'e'.repeat(32);
const PID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msg = (update_id: number, text: string, o: { from?: number; chat?: number; type?: string; bot?: boolean } = {}): TelegramUpdate => ({
  update_id, message: { message_id: 1000 + update_id, text, from: { id: o.from ?? OWNER, is_bot: o.bot ?? false }, chat: { id: o.chat ?? o.from ?? OWNER, type: o.type ?? 'private' } },
});
const tap = (update_id: number, data: string, o: { from?: number; chat?: number; type?: string; messageId?: number } = {}): TelegramUpdate => ({
  update_id, callback_query: { id: `cb${update_id}`, data, from: { id: o.from ?? OWNER }, message: { message_id: o.messageId ?? 50, chat: { id: o.chat ?? o.from ?? OWNER, type: o.type ?? 'private' } } },
});

/** A fake Bot API: getUpdates answers the queued batches (then nothing), sendMessage returns increasing message ids. */
function botApi(batches: TelegramUpdate[][] = [], o: { statuses?: (number | 'throw' | 429)[]; retryAfter?: number; sendStatus?: number[] } = {}) {
  const calls: { token: string; method: string; body: Record<string, any> }[] = [];
  const clock = { t: Date.parse('2026-10-26T12:00:00Z') };
  const statuses = [...(o.statuses ?? [])];
  const sendStatus = [...(o.sendStatus ?? [])];
  let nextId = 100;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(String(url));
    if (!m) throw new Error(`unexpected url ${String(url)}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    calls.push({ token: m[1]!, method: m[2]!, body });
    if (m[2] === 'sendMessage') {
      const st = sendStatus.shift();
      if (st === 429) return json(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: o.retryAfter ?? 2 } });
      if (st && st !== 200) return json(st, { ok: false, description: 'Bad Request' });
      return json(200, { ok: true, result: { message_id: nextId++ } });
    }
    if (m[2] === 'answerCallbackQuery' || m[2] === 'editMessageText') return json(200, { ok: true, result: true });
    if (m[2] === 'getUpdates') {
      const st = statuses.shift();
      if (st === 'throw') throw new TypeError(`fetch failed for ${String(url)}`);
      if (st === 429) return json(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: o.retryAfter ?? 2 } });
      if (st !== undefined && st !== 200) return json(st, { ok: false, description: 'error' });
      const b = batches.shift() ?? [];
      const offset = typeof body.offset === 'number' ? body.offset : 0;
      return json(200, { ok: true, result: b.filter((u) => u.update_id >= offset) });
    }
    return json(404, { ok: false });
  }) as typeof fetch;
  const of = (method: string) => calls.filter((c) => c.method === method);
  return { f, calls, of, clock, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };
}

function transport(api: ReturnType<typeof botApi>, o: { lookup?: Parameters<typeof T.telegramTransport>[0]['lookupOffer']; logs?: string[] } = {}) {
  return T.telegramTransport({
    token: TOKEN, access: ACCESS, fetch: api.f, now: api.now, sleep: api.sleep,
    log: (l) => o.logs?.push(l), lookupOffer: o.lookup ?? (async () => null),
  });
}

const offer = (over: Partial<ManagerOffer> = {}): ManagerOffer => ({
  projectId: PID, requestId: RID, kind: 'config-set', nonce: NONCE, digest: 'd'.repeat(64), expiresAt: '2026-10-26T12:30:00.000Z',
  summary: 'set execution.maxActiveTasks: 2 -> 4', text: 'change request cr_0a1b2c3d (config-set)\nreason (from the container, untrusted): "go faster"', loosens: null, ...over,
});

const fakeCommands = (o: Partial<ManagerCommands> = {}): ManagerCommands => ({
  projects: async () => [{ projectId: PID, name: 'acme' }, { projectId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', name: 'other' }],
  status: async (id) => `status for ${id ?? 'all'}`,
  pending: async () => [],
  propose: async () => { throw new Error('propose not faked'); },
  ...o,
});

// ---------------------------------------------------------------- callback data

describe('callback data', () => {
  it('is c|r|d:<requestId>:<nonce>, within 64 bytes, and parses back; anything else is refused', () => {
    for (const a of ['c', 'r', 'd'] as const) {
      const d = T.callbackData(a, RID, NONCE);
      expect(d).toBe(`${a}:${RID}:${NONCE}`);
      expect(Buffer.byteLength(d)).toBeLessThanOrEqual(T.CALLBACK_DATA_MAX_BYTES);
      expect(T.parseCallbackData(d)).toEqual({ action: a, requestId: RID, nonce: NONCE });
    }
    expect(() => T.callbackData('c', 'cr_nothex!', NONCE)).toThrow();
    expect(() => T.callbackData('c', RID, 'abc')).toThrow();
    for (const bad of [undefined, 42, '', 'x:cr_0a1b2c3d:' + NONCE, `c:${RID}`, `c:${RID}:${NONCE.toUpperCase()}`, `c:${RID}:${NONCE}:extra`, `c:${RID}:${'f'.repeat(64)}`]) {
      expect(T.parseCallbackData(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- owner only

describe('owner only', () => {
  it('drops updates from other users, groups and bots silently: no message, no answerCallbackQuery, no event', async () => {
    const api = botApi([[
      msg(1, '/status', { from: STRANGER }),
      msg(2, '/status', { chat: -100, type: 'group' }),
      msg(3, '/status', { bot: true }),
      tap(4, `c:${RID}:${NONCE}`, { from: STRANGER }),
      tap(5, `c:${RID}:${NONCE}`, { chat: -100, type: 'supergroup' }),
      msg(6, 'hello', { from: STRANGER, chat: OWNER }),
    ]]);
    const t = transport(api);
    t.attach(fakeCommands());
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.calls.map((c) => c.method)).toEqual(['getUpdates']);
    // ...but the offset still advances past them.
    await t.receive(30_000);
    expect(api.of('getUpdates')[1]!.body.offset).toBe(7);
  });

  it('every call goes to the Bot API with the token only in the URL path, sends only to the paired chat, plain text', async () => {
    const api = botApi([[msg(1, '/help')]]);
    const t = transport(api);
    await t.sendOffer(offer());
    await t.receive(30_000);
    for (const c of api.calls) {
      expect(c.token).toBe(TOKEN);
      expect(JSON.stringify(c.body)).not.toContain(TOKEN);
      expect(c.body.parse_mode).toBeUndefined();
    }
    for (const c of api.of('sendMessage')) expect(c.body.chat_id).toBe(OWNER);
    expect(api.of('getUpdates')[0]!.body.allowed_updates).toEqual(['message', 'callback_query']);
  });
});

// ---------------------------------------------------------------- offers, taps, outcomes

describe('offers and taps', () => {
  it('an offer has Confirm / Reject buttons with c:/r: callback data; a Confirm tap is answered and becomes a confirm event', async () => {
    const api = botApi();
    const t = transport(api);
    await t.sendOffer(offer());
    const sent = api.of('sendMessage')[0]!.body;
    expect(sent.text).toContain(`Change request ${RID} (project ${PID}): set execution.maxActiveTasks: 2 -> 4`);
    expect(sent.text).toContain('reason (from the container, untrusted)');
    expect(sent.text).toContain('Confirm or Reject before 2026-10-26T12:30:00.000Z');
    expect(sent.reply_markup).toEqual({ inline_keyboard: [[
      { text: 'Confirm', callback_data: `c:${RID}:${NONCE}` },
      { text: 'Reject', callback_data: `r:${RID}:${NONCE}` },
    ]] });
    const api2 = botApi([[tap(9, `c:${RID}:${NONCE}`, { messageId: 100 })]]);
    const t2 = transport(api2);
    await t2.sendOffer(offer());
    expect(await t2.receive(30_000)).toEqual([{ type: 'confirm', requestId: RID, nonce: NONCE }]);
    expect(api2.of('answerCallbackQuery')).toEqual([expect.objectContaining({ body: expect.objectContaining({ callback_query_id: 'cb9' }) })]);
  });

  it('a Reject tap becomes a reject event; a rejected outcome edits the offer and is sent as a new message', async () => {
    const api = botApi([[tap(3, `r:${RID}:${NONCE}`, { messageId: 100 })]]);
    const t = transport(api);
    await t.sendOffer(offer());
    expect(await t.receive(30_000)).toEqual([{ type: 'reject', requestId: RID, nonce: NONCE }]);
    expect(api.of('answerCallbackQuery')).toHaveLength(1);
    await t.sendOutcome({ status: 'rejected', projectId: PID, requestId: RID, text: `change request ${RID} rejected (nothing applied)` });
    expect(api.of('editMessageText')[0]!.body).toMatchObject({ chat_id: OWNER, message_id: 100, text: expect.stringContaining('Rejected') });
    expect(api.of('sendMessage').at(-1)!.body.text).toBe(`change request ${RID} rejected (nothing applied)`);
  });

  it('applying edits the tapped message to "Applying…" (buttons removed); the outcome is a new message', async () => {
    const api = botApi([[tap(3, `c:${RID}:${NONCE}`, { messageId: 100 })]]);
    const t = transport(api);
    await t.sendOffer(offer());
    await t.receive(30_000);
    const before = api.of('sendMessage').length;
    await t.sendOutcome({ status: 'applying', projectId: PID, requestId: RID, text: `Applying change request ${RID} (project ${PID}): set x…` });
    const edit = api.of('editMessageText');
    expect(edit).toHaveLength(1);
    expect(edit[0]!.body).toMatchObject({ chat_id: OWNER, message_id: 100 });
    expect(edit[0]!.body.text).toMatch(/^Applying/);
    expect(edit[0]!.body.reply_markup).toBeUndefined();
    expect(api.of('sendMessage')).toHaveLength(before);
    await t.sendOutcome({ status: 'applied', projectId: PID, requestId: RID, text: `change request ${RID}: applied - x` });
    expect(api.of('editMessageText')).toHaveLength(1);
    expect(api.of('sendMessage')).toHaveLength(before + 1);
    expect(api.of('sendMessage').at(-1)!.body.text).toContain('applied');
  });

  it('applying without a known message (or a failed edit) is sent as a new message', async () => {
    const api = botApi();
    const t = transport(api);
    await t.sendOutcome({ status: 'applying', projectId: PID, requestId: RID, text: 'Applying…' });
    expect(api.of('editMessageText')).toHaveLength(0);
    expect(api.of('sendMessage')).toHaveLength(1);
  });

  it('a malformed button is answered and produces no event', async () => {
    const api = botApi([[tap(1, 'c:cr_zz:123'), tap(2, `c:${RID}:${NONCE}:x`)]]);
    const t = transport(api);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.of('answerCallbackQuery')).toHaveLength(2);
  });

  it('untrusted text is sent as plain text with control characters stripped; long text is cut below the Telegram limit', async () => {
    const api = botApi();
    const t = transport(api);
    await t.sendOffer(offer({ text: `evil \u001b[31mred\u0007 <b>bold</b> ${'x'.repeat(6000)}` }));
    const text = String(api.of('sendMessage')[0]!.body.text);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text).toContain('<b>bold</b>'); // literal: no parse_mode
    expect(text.length).toBeLessThanOrEqual(T.MESSAGE_MAX_CHARS);
    expect(text).toContain('cut');
  });
});

// ---------------------------------------------------------------- double tap

describe('double tap for plans that loosen policy', () => {
  const LOOSE = 'agents may push branches to GitHub';

  it('the first Confirm only asks again (risk named in one line); the second tap within 2 minutes confirms', async () => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}`, { messageId: 100 })], [tap(2, `d:${RID}:${NONCE}`, { messageId: 101 })]]);
    const t = transport(api);
    await t.sendOffer(offer({ loosens: `${LOOSE}\nsecond line` }));
    expect(api.of('sendMessage')[0]!.body.text).toContain('Confirm asks a second time');
    expect(await t.receive(30_000)).toEqual([]);
    const ask = api.of('sendMessage').at(-1)!.body;
    const riskLine = String(ask.text).split('\n').find((l) => l.includes('Risk:'))!;
    expect(riskLine).toContain(`${LOOSE} second line`);
    expect(ask.text).toContain('within 2 minutes');
    expect(ask.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Confirm again', callback_data: `d:${RID}:${NONCE}` }]] });
    api.clock.t += T.DOUBLE_TAP_MS - 1000;
    expect(await t.receive(30_000)).toEqual([{ type: 'confirm', requestId: RID, nonce: NONCE }]);
    expect(api.of('answerCallbackQuery')).toHaveLength(2);
    // Applying edits the original offer message.
    await t.sendOutcome({ status: 'applying', projectId: PID, requestId: RID, text: 'Applying…' });
    expect(api.of('editMessageText')[0]!.body.message_id).toBe(100);
  });

  it('a second tap after 2 minutes, without a first tap, or for another request sends nothing to the core', async () => {
    const api = botApi([
      [tap(1, `c:${RID}:${NONCE}`)], [tap(2, `d:${RID}:${NONCE}`)],
      [tap(3, `d:${RID}:${NONCE2}`)],
      [tap(4, `c:${RID}:${NONCE}`)], [tap(5, `d:cr_99999999:${NONCE}`)],
    ]);
    const t = transport(api);
    await t.sendOffer(offer({ loosens: LOOSE }));
    expect(await t.receive(30_000)).toEqual([]);
    api.clock.t += T.DOUBLE_TAP_MS + 1;
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.of('sendMessage').at(-1)!.body.text).toContain('expired');
    expect(await t.receive(30_000)).toEqual([]);
    expect(await t.receive(30_000)).toEqual([]);
    expect(await t.receive(30_000)).toEqual([]);
  });

  it('an offer this process did not send (after a restart) is looked up in the journal for loosens', async () => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}`)]]);
    const t = transport(api, { lookup: async (n) => (n === NONCE ? { requestId: RID, summary: 's', loosens: LOOSE } : null) });
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.of('sendMessage').at(-1)!.body.text).toContain(`Risk: ${LOOSE}`);
    // The default lookup reads the journal.
    mkdirSync(managerDir(), { recursive: true });
    writeFileSync(J.journalPath(), JSON.stringify({ type: 'offer', at: 'x', projectId: PID, requestId: RID, digest: 'd', configRevision: 1, nonce: NONCE, expiresAt: 'x', request: {}, plan: { loosens: LOOSE } }) + '\n');
    const api2 = botApi([[tap(2, `c:${RID}:${NONCE}`)]]);
    const t2 = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api2.f, now: api2.now, sleep: api2.sleep });
    expect(await t2.receive(30_000)).toEqual([]);
    expect(api2.of('sendMessage').at(-1)!.body.text).toContain('Second confirmation');
  });

  it('a non-loosening offer confirms on the first tap', async () => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}`)]]);
    const t = transport(api);
    await t.sendOffer(offer());
    expect(await t.receive(30_000)).toEqual([{ type: 'confirm', requestId: RID, nonce: NONCE }]);
  });
});

// ---------------------------------------------------------------- polling

describe('getUpdates', () => {
  it('persists the offset (0600 in a 0700 dir) and resumes from it after a restart; another bot\'s offset is ignored', async () => {
    const api = botApi([[msg(41, '/help'), msg(42, '/help')]]);
    await transport(api).receive(30_000);
    const file = T.telegramOffsetPath();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, botId: '555666777', offset: 43 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(managerDir()).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    const api2 = botApi();
    await transport(api2).receive(30_000);
    expect(api2.of('getUpdates')[0]!.body.offset).toBe(43);
    const api3 = botApi();
    await T.telegramTransport({ token: TOKEN, access: { ...ACCESS, botId: '111222333' }, fetch: api3.f, now: api3.now, sleep: api3.sleep }).receive(30_000);
    expect(api3.of('getUpdates')[0]!.body.offset).toBeUndefined();
  });

  it('the long poll never waits longer than asked (at most 25 s)', async () => {
    const api = botApi();
    const t = transport(api);
    await t.receive(120_000);
    await t.receive(7_500);
    await t.receive(400);
    expect(api.of('getUpdates').map((c) => c.body.timeout)).toEqual([25, 7, 0]);
  });

  it('409 is "another process polls the manager bot" (CONFLICT); 401 is a rejected token; neither includes the token', async () => {
    const conflict = await transport(botApi([], { statuses: [409] })).receive(30_000).then(() => null, (e) => e);
    expect(conflict).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Another process polls the manager bot') });
    const denied = await transport(botApi([], { statuses: [401] })).receive(30_000).then(() => null, (e) => e);
    expect(denied).toMatchObject({ code: 'AUTH_REQUIRED' });
    const net = await transport(botApi([], { statuses: ['throw'] })).receive(30_000).then(() => null, (e) => e);
    expect(net).toMatchObject({ code: 'NETWORK_RETRYABLE' });
    for (const e of [conflict, denied, net]) expect(`${e.message} ${e.hint ?? ''}`).not.toContain(TOKEN.split(':')[1]);
  });

  it('429 waits retry_after (bounded by the wait) and returns no events; sendMessage retries once after a 429', async () => {
    const api = botApi([], { statuses: [429], retryAfter: 3 });
    const t = transport(api);
    const start = api.now();
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.now() - start).toBe(3000);
    const api2 = botApi([], { sendStatus: [429], retryAfter: 2 });
    await transport(api2).sendOffer(offer());
    expect(api2.of('sendMessage')).toHaveLength(2);
    const api3 = botApi([], { sendStatus: [400] });
    await expect(transport(api3).sendOffer(offer())).rejects.toMatchObject({ code: 'NETWORK_RETRYABLE' });
  });

  it('an aborted receive returns no events', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const f = (async (_u: unknown, init?: RequestInit) => { if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError'); return json(200, { ok: true, result: [] }); }) as typeof fetch;
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: f });
    expect(await t.receive(30_000, ctl.signal)).toEqual([]);
  });
});

// ---------------------------------------------------------------- commands

describe('commands', () => {
  it('anything outside the fixed command set gets the help text', async () => {
    const api = botApi([[msg(1, 'hello'), msg(2, '/reboot now'), msg(3, '/start'), msg(4, '/help'), msg(5, ''), msg(6, '/deploy x y')]]);
    const t = transport(api);
    t.attach(fakeCommands());
    await t.receive(30_000);
    const texts = api.of('sendMessage').map((c) => c.body.text);
    expect(texts).toEqual(Array(6).fill(T.HELP_TEXT));
    for (const c of ['/status', '/requests', '/project', '/help', '/set', '/sync', '/upgrade', '/restart', '/undo', '/approve']) expect(T.HELP_TEXT).toContain(c);
  });

  it('/status and /requests use the attached commands; /requests sends each pending offer with its buttons', async () => {
    const seen: (string | null)[] = [];
    const api = botApi([[msg(1, '/status'), msg(2, '/requests@acme_manager_bot')]]);
    const t = transport(api);
    t.attach(fakeCommands({
      status: async (id) => { seen.push(id); return 'acme: running\u001b[2J'; },
      pending: async () => [offer(), offer({ requestId: 'cr_11111111', nonce: NONCE2 })],
    }));
    await t.receive(30_000);
    const sent = api.of('sendMessage');
    expect(sent[0]!.body.text).toBe('acme: running');
    expect(sent[1]!.body.text).toBe('2 pending change request(s):');
    expect(sent[2]!.body.reply_markup.inline_keyboard[0][0].callback_data).toBe(`c:${RID}:${NONCE}`);
    expect(sent[3]!.body.reply_markup.inline_keyboard[0][1].callback_data).toBe(`r:cr_11111111:${NONCE2}`);
    expect(seen).toEqual([null]);
  });

  it('/requests with nothing pending says so; a failing command reports the error; before attach it asks to retry', async () => {
    const api = botApi([[msg(1, '/requests')], [msg(2, '/status')]]);
    const t = transport(api);
    await t.receive(30_000);
    expect(api.of('sendMessage')[0]!.body.text).toContain('starting');
    t.attach(fakeCommands({ status: async () => { throw new Error(`boom ${TOKEN}`); } }));
    await t.receive(30_000);
    const text = String(api.of('sendMessage')[1]!.body.text);
    expect(text).toContain('/status failed: boom');
    expect(text).not.toContain(TOKEN);
    const api2 = botApi([[msg(10, '/requests')]]);
    const t2 = transport(api2);
    t2.attach(fakeCommands());
    await t2.receive(30_000);
    expect(api2.of('sendMessage')[0]!.body.text).toBe('No pending change requests.');
  });

  it('/project lists the projects, picks one by name or id prefix (then /status and /requests filter), /project all resets', async () => {
    const seen: (string | null)[] = [];
    const api = botApi([[msg(1, '/project'), msg(2, '/project ACME'), msg(3, '/status'), msg(4, '/requests'), msg(5, '/project nope'), msg(6, '/project 9a8b'), msg(7, '/project all'), msg(8, '/status')]]);
    const t = transport(api);
    t.attach(fakeCommands({ status: async (id) => { seen.push(id); return 's'; }, pending: async (id) => { seen.push(`pending:${id}`); return []; } }));
    await t.receive(30_000);
    const texts = api.of('sendMessage').map((c) => String(c.body.text));
    expect(texts[0]).toContain(`acme (${PID})`);
    expect(texts[0]).toContain('other (');
    expect(texts[1]).toContain(`Project picked: acme (${PID})`);
    expect(texts[3]).toBe(`No pending change requests for project ${PID}.`);
    expect(texts[4]).toContain('No project matches "nope"');
    expect(texts[5]).toContain('Project picked: other');
    expect(texts[6]).toBe('Showing every project.');
    expect(seen).toEqual([PID, `pending:${PID}`, null]);
  });
});

// ---------------------------------------------------------------- the core's views and the transport choice

describe('HostManager views and transport choice', () => {
  const project = { projectId: PID, repoPath: '/r/acme' } as ProjectJson;
  const plan = (requestId: string, loosens: string | null) => ({
    requestId, projectId: PID, kind: 'config-set', configRevision: 3, reason: '"go"', loosens, interrupts: null, upgradeSteps: null,
    change: { key: 'execution.maxActiveTasks', from: 2, to: 4, layer: 'project', file: 'config.json', class: 'live', takesEffect: null },
    steps: [`minions settings set execution.maxActiveTasks 4 --yes`],
  });
  const entry = (requestId: string, nonce: string, loosens: string | null = null) => ({
    type: 'offer', at: '2026-10-26T11:00:00.000Z', projectId: PID, requestId, digest: 'a'.repeat(64), configRevision: 3, nonce,
    expiresAt: '2026-10-26T11:30:00.000Z', request: { id: requestId, kind: 'config-set', payload: {}, reason: 'go' }, plan: plan(requestId, loosens),
  });
  function manager(o: { running?: boolean; statusOut?: string } = {}) {
    const deps = {
      transport: M.logTransport(() => undefined), projects: async () => [project], loadProject: async () => project,
      running: async () => o.running ?? true,
      delegate: async () => ({ code: 0, stdout: o.statusOut ?? '', stderr: '' }),
      runChild: async () => ({ code: 0, stdout: '', stderr: '' }), upgrade: async () => ({ ok: true, summary: '' }),
      now: () => new Date('2026-10-26T12:00:00Z'), sleep: async () => undefined, log: () => undefined,
    } as unknown as ManagerDeps;
    return new M.HostManager(deps);
  }

  it('pending offers come from the journal: newest entry an offer (handled ones are left out)', async () => {
    mkdirSync(managerDir(), { recursive: true });
    writeFileSync(J.journalPath(), [
      entry('cr_00000001', '1'.repeat(32)),
      entry('cr_00000002', '2'.repeat(32), 'agents may push'),
      { type: 'rejected', at: 'x', projectId: PID, requestId: 'cr_00000001' },
      entry('cr_00000003', '3'.repeat(32)),
      { type: 'confirmed', at: 'x', projectId: PID, requestId: 'cr_00000003', nonce: '3'.repeat(32) },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const m = manager();
    const pending = await m.commands().pending(null);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: 'cr_00000002', nonce: '2'.repeat(32), loosens: 'agents may push', summary: 'set execution.maxActiveTasks: 2 -> 4' });
    expect(pending[0]!.text).toContain('LOOSENS POLICY');
    expect(await m.commands().pending('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')).toEqual([]);
    expect(await m.commands().projects()).toEqual([{ projectId: PID, name: 'acme' }]);
  });

  it('/status shows the runtime, the coordinator, active leases and pending requests from typed fields only', async () => {
    mkdirSync(managerDir(), { recursive: true });
    writeFileSync(J.journalPath(), JSON.stringify(entry('cr_00000002', '2'.repeat(32))) + '\n');
    const status = { ok: true, data: { coordinatorLaunch: { state: 'stale', reason: 'channel changed\u001b[2J' }, activeLeases: [{ task_id: 'task-7', role: 'engineer' }], paused: { intake: false, starts: true } } };
    const text = await manager({ statusOut: JSON.stringify(status) + '\n' }).commands().status(null);
    expect(text).toContain(`acme (${PID})`);
    expect(text).toContain('runtime: running');
    expect(text).toContain('coordinator: running, restart required (channel changed): `minions upgrade`');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('active leases: 1 (task-7 engineer)');
    expect(text).toContain('paused: starts');
    expect(text).toContain('pending change requests: 1 (cr_00000002: set execution.maxActiveTasks: 2 -> 4)');
    const stopped = await manager({ running: false }).commands().status(null);
    expect(stopped).toContain('runtime: stopped');
    const garbage = await manager({ statusOut: 'not json' }).commands().status(null);
    expect(garbage).toContain('coordinator: unknown');
    expect(await manager().commands().status('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')).toContain('not registered');
  });

  it('runManager attaches the commands to the transport', async () => {
    let attached: ManagerCommands | null = null;
    const ctl = new AbortController();
    ctl.abort();
    const tr = { ...M.logTransport(() => undefined), attach: (c: ManagerCommands) => { attached = c; } };
    const deps = { transport: tr, projects: async () => [], loadProject: async () => project, running: async () => false, delegate: async () => ({ code: 0, stdout: '', stderr: '' }),
      runChild: async () => ({ code: 0, stdout: '', stderr: '' }), upgrade: async () => ({ ok: true, summary: '' }), now: () => new Date(), sleep: async () => undefined, log: () => undefined } as unknown as ManagerDeps;
    await M.runManager(deps, ctl.signal);
    expect(attached).not.toBeNull();
    expect(await attached!.projects()).toEqual([]);
  });

  it('chooseTransport: the bot when paired with a token of the same bot, else the log transport; never the token in the detail', async () => {
    const base = { write: () => undefined, log: () => undefined };
    const paired = await M.chooseTransport({ ...base, loadAccess: async () => ACCESS, readToken: async () => TOKEN });
    expect(paired.kind).toBe('telegram');
    expect(paired.transport).toBeInstanceOf(T.TelegramTransport);
    expect(paired.detail).not.toContain(TOKEN.split(':')[1]);
    expect((await M.chooseTransport({ ...base, loadAccess: async () => null, readToken: async () => TOKEN })).kind).toBe('log');
    expect((await M.chooseTransport({ ...base, loadAccess: async () => ACCESS, readToken: async () => null })).kind).toBe('log');
    const other = await M.chooseTransport({ ...base, loadAccess: async () => ({ ...ACCESS, botId: '111222333' }), readToken: async () => TOKEN });
    expect(other).toMatchObject({ kind: 'log', detail: expect.stringContaining('another manager bot') });
    // Unpaired by default in a fresh home.
    expect((await M.chooseTransport(base)).kind).toBe('log');
  });
});

// ---------------------------------------------------------------- QA edge cases (task-53.5.2 QA)

describe('QA edge cases', () => {
  const LOOSE = 'agents may push branches to GitHub';
  const fwd = (u: TelegramUpdate, extra: Record<string, unknown>): TelegramUpdate => ({ ...u, message: { ...u.message!, ...extra } as TelegramUpdate['message'] });

  it('a tap by another user on the owner\'s private message, inline-mode taps and edited messages are dropped silently', async () => {
    const api = botApi([[
      tap(1, `c:${RID}:${NONCE}`, { from: STRANGER, chat: OWNER }),
      tap(2, `r:${RID}:${NONCE}`, { from: STRANGER, chat: OWNER }),
      { update_id: 3, callback_query: { id: 'cb3', data: `c:${RID}:${NONCE}`, from: { id: OWNER } } }, // inline message: no chat
      { update_id: 4, edited_message: { message_id: 7, text: '/status', from: { id: OWNER }, chat: { id: OWNER, type: 'private' } } } as unknown as TelegramUpdate,
      { update_id: 5, callback_query: { id: 'cb5', data: `c:${RID}:${NONCE}`, from: { id: OWNER, is_bot: true }, message: { message_id: 1, chat: { id: OWNER, type: 'private' } } } },
    ]]);
    const t = transport(api);
    t.attach(fakeCommands());
    await t.sendOffer(offer({ loosens: LOOSE }));
    const before = api.calls.length;
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.calls.slice(before).map((c) => c.method)).toEqual(['getUpdates']);
  });

  it('a stranger\'s d: tap after the owner\'s first tap neither confirms nor disarms; the owner\'s d: tap still confirms', async () => {
    const api = botApi([
      [tap(1, `c:${RID}:${NONCE}`)],
      [tap(2, `d:${RID}:${NONCE}`, { from: STRANGER, chat: OWNER })],
      [tap(3, `d:${RID}:${NONCE}`)],
    ]);
    const t = transport(api);
    await t.sendOffer(offer({ loosens: LOOSE }));
    expect(await t.receive(30_000)).toEqual([]);
    expect(await t.receive(30_000)).toEqual([]);
    expect(await t.receive(30_000)).toEqual([{ type: 'confirm', requestId: RID, nonce: NONCE }]);
  });

  it('the second tap at exactly 2 minutes confirms; one millisecond later it does not', async () => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}`)], [tap(2, `d:${RID}:${NONCE}`)], [tap(3, `c:${RID}:${NONCE}`)], [tap(4, `d:${RID}:${NONCE}`)]]);
    const t = transport(api);
    await t.sendOffer(offer({ loosens: LOOSE }));
    await t.receive(30_000);
    api.clock.t += T.DOUBLE_TAP_MS;
    expect(await t.receive(30_000)).toEqual([{ type: 'confirm', requestId: RID, nonce: NONCE }]);
    await t.receive(30_000);
    api.clock.t += T.DOUBLE_TAP_MS + 1;
    expect(await t.receive(30_000)).toEqual([]);
  });

  it('a replayed d: tap sends nothing; repeated c: taps on a loosening offer never confirm', async () => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}`), tap(2, `c:${RID}:${NONCE}`), tap(3, `c:${RID}:${NONCE}`)], [tap(4, `d:${RID}:${NONCE}`), tap(5, `d:${RID}:${NONCE}`)]]);
    const t = transport(api);
    await t.sendOffer(offer({ loosens: LOOSE }));
    expect(await t.receive(30_000)).toEqual([]);
    expect(await t.receive(30_000)).toEqual([{ type: 'confirm', requestId: RID, nonce: NONCE }]);
  });

  it('a c: tap on a loosening offer from the journal never confirms, and a failing journal lookup sends nothing', async () => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}`)]]);
    const t = transport(api, { lookup: async () => ({ requestId: RID, summary: 's', loosens: LOOSE }) });
    expect(await t.receive(30_000)).toEqual([]);
    const logs: string[] = [];
    const api2 = botApi([[tap(2, `c:${RID}:${NONCE}`)]]);
    const t2 = transport(api2, { logs, lookup: async () => { throw new Error('journal unreadable'); } });
    expect(await t2.receive(30_000)).toEqual([]);
    expect(api2.of('answerCallbackQuery')[0]!.body.text).toContain('nothing done');
  });

  it('oversized callback data is answered and refused', async () => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}${'f'.repeat(40)}`), tap(2, 'x'.repeat(5000))]]);
    const t = transport(api);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.of('answerCallbackQuery')).toHaveLength(2);
  });

  it('a corrupt offset file is logged (without the token) and ignored; the next batch rewrites it', async () => {
    mkdirSync(managerDir(), { recursive: true });
    writeFileSync(T.telegramOffsetPath(), '{not json');
    const logs: string[] = [];
    const api = botApi([[msg(9, '/help')]]);
    await transport(api, { logs }).receive(30_000);
    expect(api.of('getUpdates')[0]!.body.offset).toBeUndefined();
    expect(logs.join('\n')).toContain('unreadable getUpdates offset');
    expect(JSON.parse(readFileSync(T.telegramOffsetPath(), 'utf8'))).toMatchObject({ offset: 10 });
    writeFileSync(T.telegramOffsetPath(), JSON.stringify({ version: 1, botId: '555666777', offset: -3 }));
    const api2 = botApi();
    await transport(api2, { logs }).receive(30_000);
    expect(api2.of('getUpdates')[0]!.body.offset).toBeUndefined();
  });

  it('404 is a rejected token; a 429 error and every log line never include the token', async () => {
    const denied = await transport(botApi([], { statuses: [404] })).receive(30_000).then(() => null, (e) => e);
    expect(denied).toMatchObject({ code: 'AUTH_REQUIRED' });
    const secret = TOKEN.split(':')[1]!;
    const logs: string[] = [];
    const leaky = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').at(-1);
      if (method === 'getUpdates') return json(200, { ok: true, result: [tap(1, `c:${RID}:${NONCE}`, { messageId: 100 })] });
      if (method === 'answerCallbackQuery' || method === 'editMessageText') throw new TypeError(`Failed to fetch ${String(url)}`);
      if (method === 'sendMessage') return json(400, { ok: false, description: `Bad Request: echo ${String(url)}` });
      return json(200, { ok: true, result: true });
    }) as typeof fetch;
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: leaky, log: (l) => logs.push(l), lookupOffer: async () => null, sleep: async () => undefined });
    await t.receive(30_000);
    await t.sendOutcome({ status: 'applying', projectId: PID, requestId: RID, text: 'Applying…' }).catch((e) => logs.push(String(e.message)));
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const l of logs) expect(l).not.toContain(secret);
  });

  it.each([
    ['forward_origin', { forward_origin: { type: 'user', sender_user: { id: STRANGER } } }],
    ['forward_from (older API shape)', { forward_from: { id: STRANGER } }],
    ['forward_from_chat (older API shape)', { forward_from_chat: { id: -100123, type: 'channel' } }],
    ['forward_date alone (older API shape)', { forward_date: 1_790_000_000 }],
  ])('a message the owner forwards (%s) is ignored silently', async (_name, extra) => {
    const api = botApi([[fwd(msg(1, '/status'), extra), fwd(msg(2, '/help'), extra), fwd(msg(3, 'hello'), extra)]]);
    const t = transport(api);
    t.attach(fakeCommands());
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.of('sendMessage')).toEqual([]);
    expect(api.of('answerCallbackQuery')).toEqual([]);
  });

  it('the owner\'s own message next to a forwarded one is still answered', async () => {
    const api = botApi([[fwd(msg(1, '/status'), { forward_date: 1_790_000_000 }), msg(2, '/status')]]);
    const t = transport(api);
    t.attach(fakeCommands());
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.of('sendMessage').map((c) => c.body.text)).toEqual(['status for all']);
  });

  it('isForwarded sees every forward field and nothing else', () => {
    expect(T.isForwarded({ text: '/status' })).toBe(false);
    expect(T.isForwarded({ text: '/status', forward_origin: {} })).toBe(true);
    expect(T.isForwarded({ text: '/status', forward_from: { id: 1 } })).toBe(true);
    expect(T.isForwarded({ text: '/status', forward_from_chat: { id: 1 } })).toBe(true);
    expect(T.isForwarded({ text: '/status', forward_date: 0 })).toBe(true);
  });
});

// ---------------------------------------------------------------- code-point-safe truncation

describe('truncation never splits a surrogate pair', () => {
  const EMOJI = '\u{1F600}'; // two UTF-16 units
  /** String.prototype.isWellFormed (Node 20+; the TS lib here predates it). */
  const wellFormed = (s: string) => (s as unknown as { isWellFormed(): boolean }).isWellFormed();

  it('truncateCodePoints backs off a lone high surrogate and stays within the limit', () => {
    for (const prefix of ['', 'a', 'ab', 'abc']) {
      const s = prefix + EMOJI.repeat(50);
      for (let max = 0; max <= 20; max++) {
        const t = truncateCodePoints(s, max);
        expect(wellFormed(t)).toBe(true);
        expect(t.length).toBeLessThanOrEqual(max);
        expect(t.length).toBeGreaterThanOrEqual(max - 1);
        expect(s.startsWith(t)).toBe(true);
      }
    }
    expect(truncateCodePoints('short', 100)).toBe('short');
    expect(truncateCodePoints(`ab${EMOJI}`, 4)).toBe(`ab${EMOJI}`);
  });

  it.each(['', 'a', 'ab', 'abc'])('long emoji offers, summaries and risk lines are cut well formed (prefix %j)', async (prefix) => {
    const api = botApi([[tap(1, `c:${RID}:${NONCE}`, { messageId: 100 })]]);
    const t = transport(api);
    const long = prefix + EMOJI.repeat(3000);
    await t.sendOffer(offer({ text: long, summary: long, loosens: long }));
    expect(await t.receive(30_000)).toEqual([]); // first tap of a loosening plan: the risk line message
    const sent = api.of('sendMessage').map((c) => String(c.body.text));
    expect(sent).toHaveLength(2);
    for (const text of sent) {
      expect(wellFormed(text)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(T.MESSAGE_MAX_CHARS);
    }
    await t.sendOutcome({ status: 'applied', projectId: PID, requestId: RID, text: long });
    await t.sendOutcome({ status: 'applying', projectId: PID, requestId: RID, text: long });
    for (const c of [...api.of('sendMessage'), ...api.of('editMessageText')]) expect(wellFormed(String(c.body.text))).toBe(true);
  });

  it.each(['', 'a'])('a network error with emoji is cut well formed (prefix %j)', async (prefix) => {
    const f = (async () => { throw new TypeError(prefix + EMOJI.repeat(300)); }) as typeof fetch;
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: f, log: () => undefined, lookupOffer: async () => null, sleep: async () => undefined });
    const err = await t.receive(30_000).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('could not reach the Telegram Bot API');
    expect(wellFormed(err!.message)).toBe(true);
  });

  it.each(['', 'a'])('/status lines from the runtime are cut well formed (prefix %j)', (prefix) => {
    const long = prefix + EMOJI.repeat(300);
    const lines = M.runtimeStatusLines({ coordinatorLaunch: { state: 'stale', reason: long }, activeLeases: [{ task_id: long, role: long }] });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(wellFormed(l)).toBe(true);
    expect(lines.join('\n')).toContain(EMOJI);
  });
});
