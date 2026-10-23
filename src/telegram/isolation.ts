// Telegram poller isolation (task-51). The official plugin's MCP server writes <state dir>/bot.pid and
// SIGTERMs whatever server.ts process the file names ("replacing stale poller"): Telegram allows one
// getUpdates consumer per bot token. Every claude session that loads the plugin and sees the token
// therefore takes the bot away from the coordinator. The token reaches more than the coordinator: it is
// in the coordinator claude's environment, which its Bash tool (and so every worker's commands and any
// `claude -p` they start) inherits.
//
// Decision: the plugin is turned off at user scope (CLAUDE_CONFIG_DIR/settings.json "enabledPlugins":
// { "telegram@claude-plugins-official": false }) and enabled only by the coordinator launch, through
// its --settings (flag settings, which Claude Code applies after user, project and local settings) plus
// --channels. A nested claude session then never loads the plugin, token or not. Checked against Claude
// Code 2.1.292: the enabled-plugin resolution walks managed, user, project, local, then flag settings,
// a later true/false replacing an earlier one; --channels only gates channel notifications of servers
// that are loaded, so it never loads a disabled plugin by itself.
//
// Rejected alternative: keeping the token away from other sessions (a private TELEGRAM_STATE_DIR/.env).
// The plugin reads the token and its state dir from the environment, and anything the coordinator's
// MCP server inherits, its Bash tool inherits too, so no env-based split exists.
//
// Detection: checkTelegramPoller reads bot.pid and checks that the process is alive, is the plugin's
// server.ts, and that its nearest claude ancestor is the coordinator claude (the direct child of the
// coordinator wrapper). Descending from the wrapper is not enough: worker Bash commands, and any
// nested `claude -p` they start, run under the coordinator claude too.
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../core/fsutil.js';
import { TELEGRAM_PLUGIN_ID } from './probe.js';

export type UserScopeResult =
  | { state: 'disabled'; detail: string }
  | { state: 'already-disabled'; detail: string }
  | { state: 'absent'; detail: string }
  | { state: 'error'; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Sets enabledPlugins[telegram@claude-plugins-official] to false in the user settings file, keeping
 * every other key. An installed plugin without an entry counts as enabled (defaultEnabled), so the
 * entry is written explicitly. `create`: write the file when it does not exist (the coordinator is
 * about to enable Telegram); otherwise a missing file is left alone. An unparseable file is never
 * rewritten. Never throws.
 */
export async function disableTelegramAtUserScope(file: string, opts: { create?: boolean; readText?: (p: string) => Promise<string>; write?: (p: string, data: string) => Promise<void> } = {}): Promise<UserScopeResult> {
  const readText = opts.readText ?? ((p: string) => readFile(p, 'utf8'));
  const write = opts.write ?? ((p: string, d: string) => atomicWrite(p, d, { mode: 0o600 }));
  let settings: Record<string, unknown> = {};
  try {
    const text = await readText(file);
    let parsed: unknown;
    try { parsed = text.trim() ? JSON.parse(text) : {}; } catch (e) {
      return { state: 'error', detail: `${file} is not valid JSON (${(e as Error).message}); left unchanged` };
    }
    if (!isObj(parsed)) return { state: 'error', detail: `${file} is not a JSON object; left unchanged` };
    settings = parsed;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return { state: 'error', detail: `${file} is unreadable (${code ?? (e as Error).message})` };
    if (!opts.create) return { state: 'absent', detail: `${file} does not exist` };
  }
  const plugins = settings.enabledPlugins;
  if (plugins !== undefined && !isObj(plugins)) return { state: 'error', detail: `${file}: enabledPlugins is not an object; left unchanged` };
  if (plugins?.[TELEGRAM_PLUGIN_ID] === false) return { state: 'already-disabled', detail: `${TELEGRAM_PLUGIN_ID} is off at user scope` };
  const next = { ...settings, enabledPlugins: { ...(plugins ?? {}), [TELEGRAM_PLUGIN_ID]: false } };
  try { await write(file, JSON.stringify(next, null, 2) + '\n'); } catch (e) {
    return { state: 'error', detail: `could not write ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  }
  return { state: 'disabled', detail: `turned ${TELEGRAM_PLUGIN_ID} off at user scope in ${file}: only the coordinator launch enables it, so other claude sessions never start a competing poller` };
}

// ---------------------------------------------------------------- poller detection

export type PollerState = 'ok' | 'missing' | 'dead' | 'foreign' | 'unknown' | 'not-applicable';
export interface PollerCheck { state: PollerState; detail: string; hint?: string; pid?: number }

/** Process facts the check needs (systemProcessControl in src/runtime/coordinator.ts implements them). */
export interface PollerProc {
  alive: (pid: number) => boolean;
  cmdline: (pid: number) => string | null;
  parentOf: (pid: number) => number | null;
}

/** How to get the channel back (coordinator guidance, status and doctor). */
export const POLLER_RECOVERY_HINT = 'In the coordinator terminal (attach with `minions start`) run /mcp and reconnect plugin:telegram:telegram; '
  + 'or, when no worker is running, restart the coordinator: `minions coordinator restart --recover`. '
  + 'If /mcp does not list plugin:telegram:telegram at all, the plugin never loaded in the coordinator: restart it (same command) instead, and check `minions doctor` (telegram.plugin). '
  + 'Never start other claude sessions with the Telegram plugin in this container.';

/** server.ts of the plugin (bun runs it as `bun server.ts`, the pid the plugin writes). */
const SERVER_CMDLINE = /(^|[\s/])server\.ts(\s|$)/;
const MAX_DEPTH = 64;
const CLAUDE_BIN = /^claude(\.exe|\.js)?$/;
const CLAUDE_PKG = /@anthropic-ai[\\/]claude-code[\\/]/;
const INTERPRETERS = new Set(['node', 'nodejs', 'bun']);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Whether a /proc cmdline (argv joined by spaces) is a Claude Code process: argv0 is the claude binary,
 * or node/bun running the Claude Code package. Only argv0 (and argv1 after an interpreter) count, so a
 * shell whose command string mentions claude (`bash -c "claude -p hi"`) is not one.
 */
export function isClaudeCmdline(cmd: string): boolean {
  const [argv0 = '', argv1 = ''] = cmd.trim().split(/\s+/);
  if (CLAUDE_BIN.test(base(argv0)) || CLAUDE_PKG.test(argv0)) return true;
  return INTERPRETERS.has(base(argv0)) && (CLAUDE_BIN.test(base(argv1)) || CLAUDE_PKG.test(argv1));
}

/**
 * Whether the Telegram poller named by bot.pid belongs to the running coordinator. `coordinatorPid`:
 * the wrapper (`minions coordinator run`, the launch record's pid), an ancestor of claude and so of its
 * MCP servers. `telegram`: whether that coordinator was launched with the channel. Never throws.
 */
export async function checkTelegramPoller(input: {
  pidFile: string;
  coordinatorPid: number | null;
  telegram: boolean;
  proc: PollerProc;
  readText?: (p: string) => Promise<string>;
}): Promise<PollerCheck> {
  const { proc } = input;
  if (!input.telegram) return { state: 'not-applicable', detail: 'the running coordinator was launched without the Telegram channel' };
  if (!input.coordinatorPid || !proc.alive(input.coordinatorPid)) return { state: 'not-applicable', detail: 'coordinator is not running' };
  let text: string;
  try { text = await (input.readText ?? ((p: string) => readFile(p, 'utf8')))(input.pidFile); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'missing', detail: `no Telegram poller: ${input.pidFile} is missing, so the coordinator's channel is not receiving messages`, hint: POLLER_RECOVERY_HINT };
    return { state: 'unknown', detail: `${input.pidFile} is unreadable (${code ?? 'error'})` };
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 1) return { state: 'missing', detail: `no Telegram poller: ${input.pidFile} holds no pid`, hint: POLLER_RECOVERY_HINT };
  if (!proc.alive(pid)) return { state: 'dead', pid, detail: `Telegram poller pid ${pid} (bot.pid) has exited, so the coordinator's channel is not receiving messages`, hint: POLLER_RECOVERY_HINT };
  const cmd = proc.cmdline(pid);
  if (cmd !== null && !SERVER_CMDLINE.test(cmd)) return { state: 'dead', pid, detail: `bot.pid names pid ${pid}, which is not a Telegram plugin server (stale pid file); no poller is running`, hint: POLLER_RECOVERY_HINT };
  // Ownership: the nearest claude ancestor of the poller must be the coordinator claude, the wrapper's
  // direct child. Every claude session started from inside the coordinator (a worker's Bash running
  // `claude -p`) also descends from the wrapper, so plain ancestry is not enough. An ancestor whose
  // cmdline is unreadable cannot be told apart from a claude, so the walk fails toward foreign.
  const seen = new Set<number>([pid]);
  let cur = pid;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = proc.parentOf(cur);
    if (parent === null) {
      if (i === 0) return { state: 'unknown', pid, detail: `cannot tell which session owns Telegram poller pid ${pid} (no process table)` };
      break;
    }
    // Reached init, the wrapper itself, or a cycle without passing a claude: not the coordinator's.
    if (parent <= 1 || parent === input.coordinatorPid || seen.has(parent)) break;
    seen.add(parent);
    const pcmd = proc.cmdline(parent);
    if (pcmd === null) break;
    if (isClaudeCmdline(pcmd)) {
      if (proc.parentOf(parent) === input.coordinatorPid) return { state: 'ok', pid, detail: `Telegram poller pid ${pid} belongs to the coordinator` };
      break;
    }
    cur = parent;
  }
  return { state: 'foreign', pid, detail: `Telegram poller pid ${pid} (bot.pid) is not the coordinator's: another claude session took the bot, and the coordinator no longer receives messages`, hint: POLLER_RECOVERY_HINT };
}
