// communication.channel resolution (src/telegram/channel.ts): the matrix of configured value × token ×
// runtime, the plugin probe fallback, and the coordinator launch decision built on it.
import { describe, expect, it } from 'vitest';
import type { ChannelSetting, MinionsConfig } from '../../src/config/schema.js';
import type { RunResult } from '../../src/core/exec.js';
import { decideTelegram } from '../../src/runtime/coordinator.js';
import { HOST_TELEGRAM_REASON, resolveChannel, type ChannelFacts } from '../../src/telegram/channel.js';
import { evaluateTelegram, TELEGRAM_PLUGIN_ID } from '../../src/telegram/probe.js';
import { defaults } from '../helpers.js';

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const facts = (bun = true) => ({
  claude: ok('2.1.292 (Claude Code)\n'), bun: bun ? ok('1.4.3\n') : { code: 127, stdout: '', stderr: 'bun: not found' },
  marketplaces: ok(JSON.stringify([{ name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' }])),
  plugins: ok(JSON.stringify([{ id: TELEGRAM_PLUGIN_ID, version: '0.0.7', scope: 'user', enabled: true }])),
  managed: { present: false } as const,
});
const available = () => evaluateTelegram(facts());
const noBun = () => evaluateTelegram(facts(false));
const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';

describe('resolution matrix: channel × token stored × runtime', () => {
  const cases: [ChannelSetting, ChannelFacts['token'], ChannelFacts['runtime'], 'terminal' | 'telegram', boolean, RegExp][] = [
    ['terminal', 'ok', 'docker', 'terminal', false, /^communication.channel is terminal$/],
    ['terminal', 'missing', 'docker', 'terminal', false, /^communication.channel is terminal$/],
    ['terminal', 'ok', 'host', 'terminal', false, /^communication.channel is terminal$/],
    ['terminal', 'missing', 'host', 'terminal', false, /^communication.channel is terminal$/],
    ['auto', 'ok', 'docker', 'telegram', true, /^auto: Telegram bot token stored and the official plugin is available$/],
    ['auto', 'missing', 'docker', 'terminal', false, /^auto: no Telegram bot token is stored.*minions auth telegram/],
    ['auto', 'ok', 'host', 'terminal', true, /^auto: the host runtime/],
    ['auto', 'missing', 'host', 'terminal', false, /^auto: no Telegram bot token.*also unavailable in the host runtime/],
    ['telegram', 'ok', 'docker', 'telegram', true, /official plugin is available/],
    ['telegram', 'missing', 'docker', 'terminal', true, /not provisioned; run `minions auth telegram`/],
    ['telegram', 'ok', 'host', 'terminal', true, /^the host runtime/],
    ['telegram', 'missing', 'host', 'terminal', true, /^the host runtime/],
  ];
  for (const [channel, token, runtime, effective, wants, reason] of cases) {
    it(`${channel} / token ${token} / ${runtime} -> ${effective}`, () => {
      const r = resolveChannel(channel, { token, runtime, network: 'outbound-internet', probe: available() });
      expect(r).toMatchObject({ configured: channel, effective, wantsTelegram: wants, degraded: wants && effective === 'terminal' });
      expect(r.reason).toMatch(reason);
    });
  }

  it('auto follows the telegram fallback semantics: network none, invalid token, probe not run / failing', () => {
    const base = { token: 'ok', runtime: 'docker', network: 'outbound-internet' } as const;
    expect(resolveChannel('auto', { ...base, network: 'none', probe: available() })).toMatchObject({ effective: 'terminal', cause: 'network-none', degraded: true });
    expect(resolveChannel('auto', { ...base, token: 'invalid', tokenDetail: 'not a Telegram bot token', probe: available() }))
      .toMatchObject({ effective: 'terminal', cause: 'invalid-token', reason: expect.stringMatching(/not a Telegram bot token/) });
    expect(resolveChannel('auto', { ...base, probe: null })).toMatchObject({ effective: 'terminal', cause: 'probe-not-run' });
    const failing = resolveChannel('auto', { ...base, probe: noBun() });
    expect(failing).toMatchObject({ effective: 'terminal', cause: 'plugin-unavailable', degraded: true });
    expect(failing.reason).toMatch(/^auto: .*Bun is not installed/);
    // Host-side prediction (no probe): Telegram expected, decided at launch.
    expect(resolveChannel('auto', base)).toMatchObject({ effective: 'telegram', cause: 'unchecked' });
    expect(resolveChannel('telegram', base)).toMatchObject({ effective: 'telegram', cause: 'unchecked' });
  });
});

describe('coordinator launch decision uses the same resolution', () => {
  const cfg = (channel: ChannelSetting, over: Partial<MinionsConfig['container']> = {}) => {
    const c = defaults();
    c.communication.channel = channel;
    Object.assign(c.container, over);
    return c;
  };
  const tok = { state: 'ok' as const, token: TOKEN, botId: '123456789' };

  it('profile default is auto', () => {
    expect(defaults().communication.channel).toBe('auto');
    expect(defaults('personal-work').communication.channel).toBe('auto');
    expect(defaults('supervised').communication.channel).toBe('auto');
  });

  it('auto: enabled with a mounted token and an available plugin in docker; terminal otherwise', () => {
    expect(decideTelegram(cfg('auto'), tok, available(), false)).toMatchObject({ enabled: true, reason: expect.stringMatching(/auto: bot token stored/) });
    expect(decideTelegram(cfg('auto'), { state: 'missing' }, null, false)).toMatchObject({ enabled: false, reason: expect.stringMatching(/^auto: no Telegram bot token/) });
    expect(decideTelegram(cfg('auto'), tok, available(), true)).toEqual({ enabled: false, reason: `auto: ${HOST_TELEGRAM_REASON}` });
    expect(decideTelegram(cfg('auto'), tok, noBun(), false)).toMatchObject({ enabled: false, reason: expect.stringMatching(/Bun is not installed/) });
    expect(decideTelegram(cfg('auto', { network: 'none' }), tok, available(), false)).toMatchObject({ enabled: false, reason: expect.stringMatching(/network is none/) });
  });

  it('explicit telegram and terminal keep their semantics', () => {
    expect(decideTelegram(cfg('telegram'), tok, available(), false)).toMatchObject({ enabled: true });
    expect(decideTelegram(cfg('telegram'), tok, available(), true)).toEqual({ enabled: false, reason: HOST_TELEGRAM_REASON });
    expect(decideTelegram(cfg('terminal'), tok, available(), false)).toEqual({ enabled: false, reason: 'communication.channel is terminal' });
  });
});
