// Who owns a process (claudeOwner: the coordinator claude, another, or unknown) and the poller check types, for the
// minions channel server's coordinator-wins rule (src/telegram/channel/server.ts). isOfficialServerCmdline names the
// official plugin's poller that old Docker setups may still start: the server stops it once on a 409 Conflict.
// ---------------------------------------------------------------- poller detection

export type PollerState = 'ok' | 'missing' | 'dead' | 'foreign' | 'unknown' | 'not-applicable';
export interface PollerCheck { state: PollerState; detail: string; hint?: string; pid?: number }

/** Process facts the check needs (systemProcessControl in src/runtime/coordinator.ts implements them). */
export interface PollerProc {
  alive: (pid: number) => boolean;
  cmdline: (pid: number) => string | null;
  parentOf: (pid: number) => number | null;
}

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

/** Whether a /proc cmdline is the official plugin's server (`bun server.ts`). */
export const isOfficialServerCmdline = (cmd: string) => SERVER_CMDLINE.test(cmd);

/**
 * Who owns a process: `coordinator` when its nearest claude ancestor is the coordinator claude (the direct child of
 * the wrapper `coordinatorPid`), `other` otherwise, `unknown` without a process table. Every claude session started
 * from inside the coordinator (a worker's Bash running `claude -p`) also descends from the wrapper, so plain ancestry
 * is not enough. An ancestor whose cmdline is unreadable cannot be told apart from a claude, so the walk fails toward
 * `other`.
 */
export function claudeOwner(pid: number, coordinatorPid: number, proc: Pick<PollerProc, 'cmdline' | 'parentOf'>): 'coordinator' | 'other' | 'unknown' {
  const seen = new Set<number>([pid]);
  let cur = pid;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = proc.parentOf(cur);
    if (parent === null) return i === 0 ? 'unknown' : 'other';
    // Reached init, the wrapper itself, or a cycle without passing a claude: not the coordinator's.
    if (parent <= 1 || parent === coordinatorPid || seen.has(parent)) return 'other';
    seen.add(parent);
    const pcmd = proc.cmdline(parent);
    if (pcmd === null) return 'other';
    if (isClaudeCmdline(pcmd)) return proc.parentOf(parent) === coordinatorPid ? 'coordinator' : 'other';
    cur = parent;
  }
  return 'other';
}
