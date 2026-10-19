// Access boundary as far as minions controls it: minions only reads access.json (never writes it),
// requires a single allowlisted owner, and relies on the plugin's documented gate that drops
// unpaired senders. Fixtures follow the plugin's ACCESS.md schema.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAccess, readTelegramAccess, senderCanControl } from '../../src/telegram/access.js';
import { tmp } from '../runtime/fixtures.js';

const OWNER = '111111111';
const STRANGER = '999999999';
const locked = { dmPolicy: 'allowlist', allowFrom: [OWNER], groups: {}, pending: { ABC123: { senderId: STRANGER } } };

describe('Telegram access policy', () => {
  it('ok only for allowlist policy with exactly one owner and no groups', () => {
    expect(evaluateAccess(locked)).toMatchObject({ state: 'ok', policy: 'allowlist', allowlisted: 1, groups: 0 });
    expect(evaluateAccess(null).state).toBe('unpaired');
    expect(evaluateAccess({ dmPolicy: 'pairing', allowFrom: [] }).state).toBe('unpaired');
    expect(evaluateAccess({ dmPolicy: 'disabled', allowFrom: [OWNER] }).state).toBe('unpaired');
    expect(evaluateAccess({ dmPolicy: 'pairing', allowFrom: [OWNER] })).toMatchObject({ state: 'open', detail: expect.stringMatching(/strangers can still request pairing codes/) });
    expect(evaluateAccess({ dmPolicy: 'allowlist', allowFrom: [OWNER, STRANGER] })).toMatchObject({ state: 'open', detail: expect.stringMatching(/2 senders are allowlisted.*approve tool-permission prompts/) });
    expect(evaluateAccess({ dmPolicy: 'allowlist', allowFrom: [OWNER], groups: { '-100123': { requireMention: true } } }).state).toBe('open');
    expect(evaluateAccess([1, 2]).state).toBe('invalid');
  });

  it('unpaired senders cannot control the coordinator; only the paired owner can', () => {
    expect(senderCanControl(locked, OWNER)).toBe(true);
    expect(senderCanControl(locked, Number(OWNER))).toBe(true);
    expect(senderCanControl(locked, STRANGER)).toBe(false); // pending pairing code does not grant access
    expect(senderCanControl({ dmPolicy: 'pairing', allowFrom: [] }, STRANGER)).toBe(false);
    expect(senderCanControl({ dmPolicy: 'disabled', allowFrom: [OWNER] }, OWNER)).toBe(false);
    expect(senderCanControl(null, OWNER)).toBe(false);
  });

  it('status never reveals pending codes or sender ids', async () => {
    const dir = tmp('minions-tg-access-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'access.json'), JSON.stringify(locked));
    const s = await readTelegramAccess(dir);
    expect(s.state).toBe('ok');
    const text = JSON.stringify(s);
    for (const secret of ['ABC123', OWNER, STRANGER]) expect(text).not.toContain(secret);
    expect((await readTelegramAccess(join(dir, 'nope'))).state).toBe('unpaired');
    writeFileSync(join(dir, 'access.json'), '{nope');
    expect((await readTelegramAccess(dir)).state).toBe('invalid');
  });
});
