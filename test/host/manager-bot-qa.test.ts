// QA edge cases for the host manager bot, part 1 (task-53.5.1): token non-leak on the getMe failure path and the
// reverse guard, pairing filters (edited messages, channels, supergroups, normalized codes, late codes), the TTL
// bound, and the reusable helpers readManagerToken / loadManagerAccess / isOwnerUpdate. Temp MINIONS_HOME, file
// credential store, fake Bot API and fake clock: no Keychain, network, Docker or live state.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const C = await import('../../src/host/credentials.js');
const M = await import('../../src/host/manager-bot.js');
const { managerChecks } = await import('../../src/host/doctor.js');
const { managerPaths, projectPaths } = await import('../../src/core/paths.js');
const { withHome } = await import('./fixtures.js');

const A = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const MGR = '555666777:MMHmanagermanagermanagermanager_-9876';
const SECRET = MGR.split(':')[1]!;
const OWNER = 4242;
const access = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T12:00:00.000Z' };

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

const tokenFile = () => join(env.home, 'credentials', 'manager', 'manager-bot-token');
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

/** Fake getUpdates: hands out `updates` once (no offset), then empty long polls that advance the clock. */
function api(updates: unknown[]) {
  const clock = { t: 0 };
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let handed = false;
  const f = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ method, body });
    if (method === 'sendMessage') return ok({});
    if (method !== 'getUpdates') throw new Error(`unexpected ${method}`);
    if (!handed && body.offset === undefined) { handed = true; clock.t += 1000; return ok(updates); }
    clock.t += Number(body.timeout ?? 0) * 1000 + 1000;
    return ok([]);
  }) as unknown as typeof fetch;
  return { f, sent, clock, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };
}

describe('manager token: non-leak on error paths', () => {
  it('getMe network failure that echoes the request URL: stored unverified, the warning is redacted', async () => {
    const f = (async (u: string) => { throw new Error(`connect ECONNREFUSED ${u}`); }) as unknown as typeof fetch;
    const r = await M.provisionManagerToken({ token: MGR, verify: true, fetch: f });
    expect(r.verification?.status).toBe('unverified');
    expect(r.warnings.length).toBe(1);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(await C.readManagerToken()).toBe(MGR);
  });

  it('getMe 5xx: stored with a warning; never the token', async () => {
    const f = (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch;
    const r = await M.provisionManagerToken({ token: MGR, verify: true, fetch: f });
    expect(r.warnings.join(' ')).toContain('502');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('reverse guard: a coordinator token equal to the manager bot is refused before anything is written for the project', async () => {
    await M.provisionManagerToken({ token: MGR });
    const e = await C.provisionTelegramToken({ projectId: A, token: MGR, repoPath: join(env.root, 'repo') }).then(() => null, (x: Error & { code?: string; hint?: string }) => x);
    expect(e?.code).toBe('CONFLICT');
    expect(`${e?.message} ${e?.hint}`).not.toContain(SECRET);
    expect(existsSync(join(env.home, 'credentials', A))).toBe(false);
    expect(existsSync(projectPaths(A).credentialsJson)).toBe(false);
  });

  it('readManagerToken: null when the token is gone; a non-token stored value is refused without echoing it', async () => {
    expect(await C.readManagerToken()).toBeNull();
    await M.provisionManagerToken({ token: MGR });
    writeFileSync(tokenFile(), 'not-a-token-SENSITIVE\n', { mode: 0o600 });
    const e = await C.readManagerToken().then(() => null, (x: Error & { code?: string }) => x);
    expect(e?.code).toBe('INVALID_CONFIG');
    expect(e?.message).not.toContain('SENSITIVE');
    rmSync(tokenFile());
    expect(await C.readManagerToken()).toBeNull();
  });

  it('doctor: reference present but token gone is a warn, never fail, never the token', async () => {
    await M.provisionManagerToken({ token: MGR });
    rmSync(tokenFile());
    const c = await managerChecks();
    expect(c.find((x) => x.name === 'manager.token')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^missing:/) });
    for (const x of c) expect(x.status).not.toBe('fail');
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });
});

describe('terminal pairing: filters and TTL', () => {
  it('skips edited messages, channel posts, supergroups and senders without an id; accepts a normalized code from the private chat', async () => {
    const code = 'K7QP-M3XA';
    const b = api([
      { update_id: 10, edited_message: { text: code, from: { id: 1 }, chat: { id: 1, type: 'private' } } },
      { update_id: 11, channel_post: { text: code, chat: { id: -1001, type: 'channel' } } },
      { update_id: 12, message: { text: code, from: { id: 2 }, chat: { id: -1002, type: 'supergroup' } } },
      { update_id: 13, message: { text: code, chat: { id: 3, type: 'private' } } },
      { update_id: 14, message: { text: code, from: { id: 0 }, chat: { id: 0, type: 'private' } } },
      { update_id: 15, message: { text: ` k7qp m3xa `, from: { id: OWNER }, chat: { id: OWNER, type: 'private' } } },
    ]);
    const r = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: b.f, now: b.now, sleep: b.sleep, code });
    expect(r).toMatchObject({ status: 'paired', access: { userId: OWNER, chatId: OWNER, botId: '555666777' } });
    expect(await M.loadManagerAccess()).toMatchObject({ userId: OWNER, chatId: OWNER });
    // The confirmation goes only to the paired private chat, and the code message is acknowledged.
    expect(b.sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.chat_id)).toEqual([OWNER]);
    expect(b.sent.some((s) => s.method === 'getUpdates' && s.body.offset === 16)).toBe(true);
  });

  it('never polls past the 10 minute TTL and records nothing when the code never arrives', async () => {
    const b = api([]);
    const r = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: b.f, now: b.now, sleep: b.sleep, code: 'AAAA-BBBB' });
    expect(r.status).toBe('expired');
    for (const s of b.sent) expect(Number(s.body.timeout)).toBeLessThanOrEqual(25);
    // The last long poll started before the deadline and could not outlast it by more than its timeout.
    expect(b.clock.t).toBeLessThanOrEqual(M.PAIRING_TTL_MS + 26_000);
    expect(existsSync(managerPaths().accessJson)).toBe(false);
  });
});

describe('reusable helpers', () => {
  it('loadManagerAccess: null when absent; extra fields, string ids or a zero user id are invalid (INVALID_CONFIG)', async () => {
    expect(await M.loadManagerAccess()).toBeNull();
    mkdirSync(managerPaths().dir, { recursive: true });
    for (const bad of [{ ...access, extra: 1 }, { ...access, userId: String(OWNER) }, { ...access, userId: 0 }, { ...access, botId: 'abc' }]) {
      writeFileSync(managerPaths().accessJson, JSON.stringify(bad));
      await expect(M.loadManagerAccess()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    await expect(M.saveManagerAccess({ ...access, userId: -5 })).rejects.toThrow();
    await M.saveManagerAccess(access);
    expect(await M.loadManagerAccess()).toEqual(access);
  });

  it('isOwnerUpdate rejects bots, missing chat type, string ids, the owner in another chat and other users in the owner chat', () => {
    const u = (from: unknown, chat: unknown) => ({ update_id: 1, message: { from, chat } }) as never;
    expect(M.isOwnerUpdate(access, u({ id: OWNER }, { id: OWNER, type: 'private' }))).toBe(true);
    expect(M.isOwnerUpdate(access, u({ id: OWNER, is_bot: true }, { id: OWNER, type: 'private' }))).toBe(false);
    expect(M.isOwnerUpdate(access, u({ id: OWNER }, { id: OWNER }))).toBe(false);
    expect(M.isOwnerUpdate(access, u({ id: String(OWNER) }, { id: String(OWNER), type: 'private' }))).toBe(false);
    expect(M.isOwnerUpdate(access, u({ id: OWNER }, { id: OWNER + 1, type: 'private' }))).toBe(false);
    expect(M.isOwnerUpdate(access, u({ id: OWNER + 1 }, { id: OWNER, type: 'private' }))).toBe(false);
    expect(M.isOwnerUpdate(access, { update_id: 2, callback_query: { from: { id: OWNER }, message: { chat: { id: OWNER, type: 'group' } } } })).toBe(false);
    expect(M.isOwnerUpdate(access, { update_id: 3, callback_query: { from: { id: OWNER } } })).toBe(false);
  });

  it('isOwnerUpdate takes sender and chat from the same part: mixed message/callback updates are rejected (task-53.5.5)', () => {
    const ownerFrom = { id: OWNER };
    const ownerChat = { id: OWNER, type: 'private' };
    const strangerFrom = { id: OWNER + 1 };
    const strangerChat = { id: OWNER + 1, type: 'private' };
    // message without a sender + the owner's button tap
    expect(M.isOwnerUpdate(access, { update_id: 10, message: { chat: ownerChat }, callback_query: { from: ownerFrom, message: { chat: ownerChat } } })).toBe(false);
    // message without a chat + the owner's button tap in the owner chat
    expect(M.isOwnerUpdate(access, { update_id: 11, message: { from: ownerFrom }, callback_query: { from: ownerFrom, message: { chat: ownerChat } } })).toBe(false);
    // owner sender on the message, the private chat only on the callback
    expect(M.isOwnerUpdate(access, { update_id: 12, message: { from: ownerFrom }, callback_query: { message: { chat: ownerChat } } })).toBe(false);
    // stranger message in the owner chat + owner callback elsewhere
    expect(M.isOwnerUpdate(access, { update_id: 13, message: { from: strangerFrom, chat: ownerChat }, callback_query: { from: ownerFrom, message: { chat: strangerChat } } })).toBe(false);
    // callback from a stranger on a message in the owner chat, with an owner-sender message lacking a chat
    expect(M.isOwnerUpdate(access, { update_id: 14, message: { from: ownerFrom }, callback_query: { from: strangerFrom, message: { chat: ownerChat } } })).toBe(false);
    // callback: owner sender but no message chat
    expect(M.isOwnerUpdate(access, { update_id: 15, callback_query: { from: ownerFrom, message: {} } })).toBe(false);
    // callback: chat but no sender
    expect(M.isOwnerUpdate(access, { update_id: 16, callback_query: { message: { chat: ownerChat } } })).toBe(false);
    // well-formed single parts still pass
    expect(M.isOwnerUpdate(access, { update_id: 17, message: { from: ownerFrom, chat: ownerChat } })).toBe(true);
    expect(M.isOwnerUpdate(access, { update_id: 18, callback_query: { from: ownerFrom, message: { chat: ownerChat } } })).toBe(true);
  });

  it('does not poll back to back with timeout 0 in the last second before the deadline', async () => {
    const b = api([]);
    // Short TTL and polls that return quickly (400 ms of fake time each, never 1 s+): the old loop reached
    // timeout-0 polls in the last second. The clock otherwise moves only through the fake sleep.
    const timeouts: number[] = [];
    let overflow = false;
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/getUpdates')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { timeout?: number };
        timeouts.push(Number(body.timeout));
        if (timeouts.length > 20) { overflow = true; b.clock.t += 10 * 60_000; } else b.clock.t += 400;
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      return b.f(url, init);
    }) as typeof fetch;
    const r = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: f, now: b.now, sleep: b.sleep, code: 'AAAA-BBBB', ttlMs: 1500 });
    expect(r.status).toBe('expired');
    expect(overflow).toBe(false);
    expect(timeouts).not.toContain(0);
    expect(timeouts.length).toBeLessThanOrEqual(3);
  });
});
