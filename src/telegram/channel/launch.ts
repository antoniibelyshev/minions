// Launch of the minions-owned Telegram channel server (task-6; docs/design/telegram-channel.md "Launch swap and
// fallback"), in both runtimes: the coordinator claude loads it as its only MCP server, or the gateway runs it.
//
// - The coordinator claude gets `--mcp-config <inline JSON>` with only our server (next to `--strict-mcp-config`, so no
//   other MCP server loads) and `--dangerously-load-development-channels server:minions-telegram` (the tagged spec the
//   task-2 spike read from the Claude Code 2.1.308 binary: `server:<name>` = "manually configured MCP server").
// - The MCP config is passed inline, never as a file: the state dir is agent-writable in the host runtime, and a file
//   there could be swapped for one that starts another command outside the sandbox.
// - The config carries paths and the launch id only (no secret): MINIONS_TELEGRAM_TOKEN_FILE (the server reads the
//   token from it), MINIONS_COORDINATOR_LAUNCH (the server activates only when it matches the launch record) and
//   TELEGRAM_STATE_DIR (access.json, offset, lock, message map).
import type { ProbeItem } from '../probe.js';
import { CHANNEL_SERVER_NAME, LAUNCH_ENV, TOKEN_FILE_ENV } from './server.js';

/** The hidden development-channel flag of Claude Code (research preview; not listed by `claude --help`). */
export const DEV_CHANNELS_FLAG = '--dangerously-load-development-channels';
/** Tagged spec of our --mcp-config server for DEV_CHANNELS_FLAG. */
export const MINIONS_CHANNEL_SPEC = `server:${CHANNEL_SERVER_NAME}`;
/** Prefix of our server's MCP tools (mcp__<server>__<tool>). */
export const MINIONS_TELEGRAM_TOOL_PREFIX = `mcp__${CHANNEL_SERVER_NAME}__`;
/** Tools of our server the coordinator may use without a prompt (phase 1 has only `reply`). */
export const MINIONS_TELEGRAM_TOOLS = ['reply'].map((t) => `${MINIONS_TELEGRAM_TOOL_PREFIX}${t}`);
/**
 * Oldest Claude Code with the tagged DEV_CHANNELS_FLAG: 2.1.292 (the design's check, flags hidden from --help) and
 * 2.1.308 (task-2: both tagged forms read from the binary). Older versions fall back to terminal with a reason.
 */
export const DEV_CHANNELS_MIN_VERSION = '2.1.292';
/** Shown on every launch with the development channel (task-2: Claude Code asks on every interactive start). */
export const DEV_CHANNELS_DIALOG_NOTE = `Claude Code shows "WARNING: Loading development channels" (${MINIONS_CHANNEL_SPEC}) at every start: attach and choose "I am using this for local development"`;

export interface ChannelServerLaunch {
  /** The program that runs `minions` (the host runtime shim; `minions` on PATH in the container). */
  command: string;
  launchId: string;
  tokenFile: string;
  stateDir: string;
}

/** The MCP config with only our server; the inline `--mcp-config` value. No secrets. */
export function minionsChannelMcpConfig(l: ChannelServerLaunch): { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> } {
  return {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        command: l.command,
        args: ['telegram', 'channel', 'serve'],
        env: { [TOKEN_FILE_ENV]: l.tokenFile, [LAUNCH_ENV]: l.launchId, TELEGRAM_STATE_DIR: l.stateDir },
      },
    },
  };
}

/** claude argv for the channel server (inserted before `--settings`; both options end at the next `--` option). */
export const minionsChannelArgs = (l: ChannelServerLaunch): string[] =>
  ['--mcp-config', JSON.stringify(minionsChannelMcpConfig(l)), DEV_CHANNELS_FLAG, MINIONS_CHANNEL_SPEC];

/** `2.1.308 (Claude Code)` -> [2, 1, 308]; null when there is no x.y.z. */
export function parseClaudeVersion(text: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const atLeast = (v: [number, number, number], min: [number, number, number]) => {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! > min[i]!;
  return true;
};

export interface HostChannelServerFacts {
  /** `claude --version` output; null when it failed. */
  claudeVersion: string | null;
  /** The bot token file the server reads. */
  token: 'ok' | 'missing' | 'invalid';
  /** The shim that starts the server exists. */
  command: boolean;
}

/**
 * Readiness of our channel server for a host launch, in the probe report shape resolveChannel reads (available,
 * summary, items). It never reads the token itself (the caller passes its state) and never starts a session.
 */
export interface HostChannelServerReport {
  availability: 'available' | 'unavailable';
  available: boolean;
  summary: string;
  channelSpec: string;
  claudeVersion: string | null;
  items: ProbeItem[];
  unverified: string[];
}

/** What this check cannot verify without a live session or the Bot API. */
export const HOST_CHANNEL_UNVERIFIED: readonly string[] = [
  'the development channel confirmation at start (Claude Code asks on every interactive start; attach to answer it)',
  'org policy for channels (claude.ai Team/Enterprise: channelsEnabled in managed settings)',
  'bot token validity with Telegram, pairing and allowlist state',
  'exclusive polling: another process polling the same bot token gets 409 Conflict',
];

export function hostChannelServerProbe(f: HostChannelServerFacts): HostChannelServerReport {
  const items: ProbeItem[] = [];
  const v = parseClaudeVersion(f.claudeVersion);
  const min = parseClaudeVersion(DEV_CHANNELS_MIN_VERSION)!;
  if (!v) {
    items.push({ name: 'claude', status: 'missing', detail: `could not read the Claude Code version (\`claude --version\`${f.claudeVersion ? `: ${f.claudeVersion.slice(0, 80)}` : ' failed'}), so the development channel flag ${DEV_CHANNELS_FLAG} cannot be confirmed`, hint: 'Install Claude Code on the host (it must be on PATH).' });
  } else if (!atLeast(v, min)) {
    items.push({ name: 'claude', status: 'missing', detail: `Claude Code ${v.join('.')} predates the development channel flag ${DEV_CHANNELS_FLAG} ${MINIONS_CHANNEL_SPEC} (needs ${DEV_CHANNELS_MIN_VERSION} or newer)`, hint: 'Update Claude Code on the host.' });
  } else {
    items.push({ name: 'claude', status: 'ok', detail: `Claude Code ${v.join('.')}: ${DEV_CHANNELS_FLAG} ${MINIONS_CHANNEL_SPEC}` });
  }
  if (f.token === 'ok') items.push({ name: 'token', status: 'ok', detail: 'bot token file present (read only by the channel server)' });
  else items.push({ name: 'token', status: 'missing', detail: f.token === 'missing' ? 'no Telegram bot token file for this project' : 'the Telegram bot token file does not hold a bot token', hint: 'Run `minions auth telegram` on the host, then `minions start`.' });
  if (f.command) items.push({ name: 'server', status: 'ok', detail: `the minions channel server (${CHANNEL_SERVER_NAME}) starts through the host runtime shim` });
  else items.push({ name: 'server', status: 'missing', detail: 'the host runtime shim that starts the channel server is missing', hint: 'Run `minions start` on the host.' });
  const bad = items.find((i) => i.status !== 'ok');
  return {
    availability: bad ? 'unavailable' : 'available',
    available: !bad,
    summary: bad ? `the minions Telegram channel server cannot start: ${bad.detail}` : `the minions Telegram channel server is available (${MINIONS_CHANNEL_SPEC})`,
    items, channelSpec: MINIONS_CHANNEL_SPEC, claudeVersion: v ? v.join('.') : null, unverified: [...HOST_CHANNEL_UNVERIFIED],
  };
}
