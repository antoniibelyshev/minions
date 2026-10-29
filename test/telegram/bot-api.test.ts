// The shared Bot API client (task-67.2): error mapping, token redaction, 429 retry and the persisted offset. A fake
// fetch only; no network and no real token.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BotApi, nextOffset, OffsetFile } from '../../src/telegram/bot-api.js';
import { MinionsError } from '../../src/core/errors.js';

const TOKEN = '123456789:AAHfaketokenfaketokenfaketoken_-1234';
const ERRORS = {
  auth: { message: 'token rejected', hint: 'store it again' },
  conflict: { message: 'another poller', hint: 'stop it' },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(answers: (() => Response | Promise<Response>)[]) {
  const urls: string[] = [];
  const slept: number[] = [];
  const f = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  }) as typeof fetch;
  return { urls, slept, api: new BotApi({ token: TOKEN, fetch: f, errors: ERRORS, sleep: async (ms) => { slept.push(ms); } }) };
}

const fails = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MinionsError; } throw new Error('did not throw'); };

describe('BotApi error mapping', () => {
  it('maps 401 and 404 to AUTH_REQUIRED and 409 to CONFLICT with the caller wording', async () => {
    for (const status of [401, 404]) {
      const e = await fails(api([() => json(status, { ok: false })]).api.call('getMe', {}));
      expect(e.code).toBe('AUTH_REQUIRED');
      expect(e.message).toBe('token rejected');
      expect(e.hint).toBe('store it again');
    }
    const c = await fails(api([() => json(409, { ok: false, description: 'Conflict: terminated by other getUpdates request' })]).api.call('getUpdates', {}));
    expect(c.code).toBe('CONFLICT');
    expect(c.message).toBe('another poller');
  });

  it('maps 429 to NETWORK_RETRYABLE with retryAfterMs, and callRetry waits once then succeeds', async () => {
    const e = await fails(api([() => json(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } })]).api.call('sendMessage', {}));
    expect(e.code).toBe('NETWORK_RETRYABLE');
    expect(e.details).toEqual({ retryAfterMs: 3000 });
    const r = api([() => json(429, { ok: false, parameters: { retry_after: 2 } }), () => json(200, { ok: true, result: { message_id: 7 } })]);
    expect(await r.api.sendMessage(1, 'hi')).toBe(7);
    expect(r.slept).toEqual([2000]);
  });

  it('does not wait out a 429 longer than 30 s', async () => {
    const r = api([() => json(429, { ok: false, parameters: { retry_after: 60 } })]);
    const e = await fails(r.api.callRetry('sendMessage', {}));
    expect(e.details).toEqual({ retryAfterMs: 60_000 });
    expect(r.slept).toEqual([]);
  });

  it('never puts the token in an error message (fetch failure, Telegram description)', async () => {
    const net = await fails(api([() => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`); }]).api.call('getMe', {}));
    expect(net.code).toBe('NETWORK_RETRYABLE');
    expect(net.message).not.toContain(TOKEN);
    expect(net.message).not.toContain('AAHfaketoken');
    const bad = await fails(api([() => json(400, { ok: false, description: `Bad Request: bot${TOKEN} broke` })]).api.call('sendMessage', {}));
    expect(bad.message).toContain('returned 400');
    expect(bad.message).not.toContain('AAHfaketoken');
    expect(new BotApi({ token: TOKEN, errors: ERRORS }).redact(`x ${TOKEN} y`)).not.toContain('AAHfaketoken');
  });

  it('sends the token only in the URL path and a reply as reply_parameters', async () => {
    let body: Record<string, unknown> = {};
    const f = (async (_u: string | URL | Request, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return json(200, { ok: true, result: { message_id: 9 } }); }) as typeof fetch;
    const a = new BotApi({ token: TOKEN, fetch: f, errors: ERRORS });
    await a.sendMessage(42, 'hello', { replyTo: 5 });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body).toMatchObject({ chat_id: 42, text: 'hello', reply_parameters: { message_id: 5 } });
  });
});

describe('OffsetFile', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('persists the offset per bot with 0600 and ignores a file of another bot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-offset-'));
    const path = join(dir, 'state', 'offset.json');
    const o = new OffsetFile(path, '123456789');
    expect(await o.load()).toBeUndefined();
    await o.save(41);
    expect(await o.load()).toBe(41);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, botId: '123456789', offset: 41 });
    expect(await new OffsetFile(path, '987654321').load()).toBeUndefined();
    writeFileSync(path, '{"version":2}');
    await expect(o.load()).rejects.toThrow();
  });

  it('nextOffset is the highest update id + 1 and never goes back', () => {
    expect(nextOffset(undefined, [{ update_id: 5 }, { update_id: 3 }])).toBe(6);
    expect(nextOffset(10, [{ update_id: 3 }])).toBe(10);
    expect(nextOffset(10, [])).toBe(10);
  });
});
