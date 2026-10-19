// communication.channel resolution: the one place that turns the configured value
// (terminal | telegram | auto) plus the facts of this project (bot token, runtime, network, plugin
// probe) into the effective channel and a precise reason. Used by the coordinator launch
// (decideTelegram), `minions status`, `minions channel show`, doctor, start and the wizard.
//
// - terminal: always terminal.
// - telegram: explicit choice; when unusable it falls back to terminal with a reason, and callers warn.
// - auto: Telegram when a bot token is stored for the project AND the runtime is docker (and the
//   network/plugin allow it, same fallback semantics as "telegram"); otherwise terminal, quietly
//   when no token is stored or the runtime is host.
import type { ChannelSetting } from '../config/schema.js';
import type { TelegramProbeReport } from './probe.js';

export type EffectiveChannel = 'terminal' | 'telegram';

export const HOST_TELEGRAM_REASON = 'the host runtime starts Claude Code without user settings, plugins installed there, or MCP servers (--setting-sources=, --strict-mcp-config), so the Telegram channel plugin is unavailable; use the Docker runtime for Telegram';
export const TOKEN_MISSING_REASON = 'Telegram bot token is not provisioned; run `minions auth telegram` on the host';

export type ChannelCause =
  | 'configured-terminal' | 'no-token' | 'invalid-token' | 'host-runtime' | 'network-none'
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
    return out('terminal', 'no-token', `auto: no Telegram bot token is stored for this project (\`minions auth telegram\` enables Telegram)${f.runtime === 'host' ? '; Telegram is also unavailable in the host runtime' : ''}`, false);
  }
  if (f.runtime === 'host') return out('terminal', 'host-runtime', `${pre}${HOST_TELEGRAM_REASON}`, true);
  if (f.network === 'none') return out('terminal', 'network-none', `${pre}container.network is none; the Telegram plugin needs api.telegram.org and the npm registry`, true);
  if (f.token === 'missing') return out('terminal', 'no-token', TOKEN_MISSING_REASON, true);
  if (f.token === 'invalid') return out('terminal', 'invalid-token', `${pre}the Telegram bot token is ${f.tokenDetail ?? 'invalid'}; run \`minions auth telegram\` on the host`, true);
  if (f.probe === undefined) return out('telegram', 'unchecked', `${pre}Telegram bot token stored; plugin availability is checked when the coordinator starts`, true);
  if (f.probe === null) return out('terminal', 'probe-not-run', `${pre}the Telegram capability probe did not run`, true);
  if (!f.probe.available) {
    const hint = f.probe.items.find((i) => i.status !== 'ok' && i.status !== 'unknown' && i.hint)?.hint;
    return out('terminal', 'plugin-unavailable', `${pre}${f.probe.summary}${hint ? ` (${hint})` : ''}`, true);
  }
  return out('telegram', 'enabled', `${pre}Telegram bot token stored and the official plugin is available`, true);
}

/** One line for humans: "auto -> telegram (reason)". */
export const formatChannel = (r: Pick<ChannelResolution, 'configured' | 'effective' | 'reason'>) =>
  `${r.configured}${r.configured === r.effective ? '' : ` -> ${r.effective}`} (${r.reason})`;
