// communication.channel resolution: the one place that turns the configured value
// (terminal | telegram | auto) plus the facts of this project (bot token, runtime, network, plugin
// probe) into the effective channel and a precise reason. Used by the coordinator launch
// (decideTelegram), `minions status`, `minions channel show`, doctor, start and the wizard.
//
// - terminal: always terminal.
// - telegram: explicit choice; when unusable it falls back to terminal with a reason, and callers warn.
// - auto: Telegram when a bot token is stored for the project (and the network/plugin or, on the host,
//   the minions channel server allow it, same fallback semantics as "telegram"); otherwise terminal,
//   quietly when no token is stored.
//
// Both runtimes run the minions-owned channel server (`--mcp-config` + the development channel flag, or the gateway;
// src/telegram/channel/launch.ts). The "probe" is hostChannelServerProbe (Claude Code version, token file, command);
// container.network applies to Docker only.
import type { ChannelSetting } from '../config/schema.js';
import type { TelegramProbeReport } from './probe.js';

export type EffectiveChannel = 'terminal' | 'telegram';

export const TOKEN_MISSING_REASON = 'Telegram bot token is not provisioned; run `minions auth telegram` on the host';

export type ChannelCause =
  | 'configured-terminal' | 'no-token' | 'invalid-token' | 'network-none'
  | 'probe-not-run' | 'plugin-unavailable' | 'unchecked' | 'enabled';

export interface ChannelFacts {
  /** Bot token: stored on the host (credential reference) or mounted in the runtime. */
  token: 'ok' | 'missing' | 'invalid';
  tokenDetail?: string;
  runtime: 'docker' | 'host';
  network: 'outbound-internet' | 'none';
  /**
   * Plugin capability probe. undefined = not checked here (host-side prediction: the launch decides);
   * null = the launch tried and the probe did not run.
   */
  probe?: Pick<TelegramProbeReport, 'available' | 'summary' | 'items'> | null;
}

export interface ChannelResolution {
  configured: ChannelSetting;
  effective: EffectiveChannel;
  reason: string;
  cause: ChannelCause;
  /**
   * Telegram is intended: "telegram", or "auto" with a stored token. Plugin install, detached start
   * and warnings apply only then; "auto" without a token is plain terminal mode.
   */
  wantsTelegram: boolean;
  /** Telegram is intended but this launch/runtime falls back to terminal (callers warn). */
  degraded: boolean;
}

export function resolveChannel(configured: ChannelSetting, f: ChannelFacts): ChannelResolution {
  const out = (effective: EffectiveChannel, cause: ChannelCause, reason: string, wantsTelegram: boolean): ChannelResolution =>
    ({ configured, effective, cause, reason, wantsTelegram, degraded: wantsTelegram && effective === 'terminal' });
  if (configured === 'terminal') return out('terminal', 'configured-terminal', 'communication.channel is terminal', false);
  const auto = configured === 'auto';
  const pre = auto ? 'auto: ' : '';
  if (auto && f.token === 'missing') {
    return out('terminal', 'no-token', 'auto: no Telegram bot token is stored for this project (`minions auth telegram` enables Telegram)', false);
  }
  const host = f.runtime === 'host';
  if (!host && f.network === 'none') return out('terminal', 'network-none', `${pre}container.network is none; the Telegram channel needs api.telegram.org`, true);
  if (f.token === 'missing') return out('terminal', 'no-token', TOKEN_MISSING_REASON, true);
  if (f.token === 'invalid') return out('terminal', 'invalid-token', `${pre}the Telegram bot token is ${f.tokenDetail ?? 'invalid'}; run \`minions auth telegram\` on the host`, true);
  if (f.probe === undefined) return out('telegram', 'unchecked', `${pre}Telegram bot token stored; the minions channel server is checked when the coordinator starts`, true);
  if (f.probe === null) return out('terminal', 'probe-not-run', `${pre}the Telegram channel server check did not run`, true);
  if (!f.probe.available) {
    const hint = f.probe.items.find((i) => i.status !== 'ok' && i.status !== 'unknown' && i.hint)?.hint;
    return out('terminal', 'plugin-unavailable', `${pre}${f.probe.summary}${hint ? ` (${hint})` : ''}`, true);
  }
  return out('telegram', 'enabled', `${pre}Telegram bot token stored and the minions channel server is available`, true);
}

/** One line for humans: "auto -> telegram (reason)". */
export const formatChannel = (r: Pick<ChannelResolution, 'configured' | 'effective' | 'reason'>) =>
  `${r.configured}${r.configured === r.effective ? '' : ` -> ${r.effective}`} (${r.reason})`;
