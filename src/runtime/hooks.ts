import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BacklogAdapter } from '../backlog/types.js';
import { AGENT_MODEL_ALIASES, isAgentModelAlias } from '../config/models.js';
import type { MinionsConfig } from '../config/schema.js';
import { sha256 } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import type { LeaseRole, RuntimeDb } from './db.js';
import { runtimePaths } from './paths.js';
import { capacityOf, scopeOf } from './scheduler.js';

export interface HookDeps { db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig }
export type HookLoader = () => HookDeps | Promise<HookDeps>;
/** The drain hook needs only the runtime DB (it runs on every worker tool call during a drain). */
export type DrainLoader = () => Pick<HookDeps, 'db'> | Promise<Pick<HookDeps, 'db'>>;
/** stdout: exact text Claude Code reads (absent = allow). Exit code is always 0. */
export interface HookOutput { stdout?: string; reason: string }

export const MAX_LOG_BYTES = 1024 * 1024;
export const NO_PROGRESS_LIMIT = 2;

/** Control characters (incl. ESC, CR, LF) are escaped so a logged string cannot forge lines or terminal sequences. */
const sanitizeLogLine = (s: string) => redact(s).slice(0, 2000).replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, (c) => (c === '\n' ? '\\n' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`));

/**
 * Appends a redacted, sanitized line to hooks.log (/state/logs; the host runtime uses <project>/host/logs,
 * outside the agent-writable dirs, via MINIONS_LOG_DIR), rotating to hooks.log.1 at ~1MB. Hooks run
 * outside the Claude Code sandbox, so the file is opened with O_NOFOLLOW and must be a regular file:
 * a symlink planted at the log path is never followed. Never throws.
 */
export function hookLog(line: string, path = runtimePaths().hooksLog): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const st = lstatSync(path);
      if (st.isFile() && st.size >= MAX_LOG_BYTES) renameSync(path, `${path}.1`);
    } catch { /* no log yet */ }
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!fstatSync(fd).isFile()) return;
      writeSync(fd, `${new Date().toISOString()} ${sanitizeLogLine(line)}\n`);
    } finally { closeSync(fd); }
  } catch { /* logging must never break a hook */ }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True if the Stop input reports a running background subagent/task. */
function backgroundRunning(input: Record<string, unknown>): boolean {
  const bt = input.background_tasks;
  if (!Array.isArray(bt)) return false;
  return bt.some((t) => !isObj(t) || typeof t.status !== 'string' || /^(running|pending|in[_-]?progress|active|started)$/i.test(t.status));
}

const block = (reason: string): HookOutput => ({ stdout: JSON.stringify({ decision: 'block', reason }), reason });

/**
 * Stop guard: blocks only when authorized runnable work and capacity exist and state has progressed;
 * otherwise allows stopping. Any internal failure allows stopping.
 */
export async function stopHook(input: unknown, load: HookLoader): Promise<HookOutput> {
  const inp = isObj(input) ? input : {};
  let deps: HookDeps;
  try { deps = await load(); } catch (e) { return { reason: `allow: state unavailable (${(e as Error).message})` }; }
  const { db, backlog, config } = deps;
  const allow = (reason: string, detail = reason): HookOutput => {
    try { db.setGuard({ fingerprint: null, count: 0, last_reason: reason }); } catch { /* ignore */ }
    return { reason: `allow: ${detail}` };
  };
  try {
    if (db.paused().starts) return allow('paused');
    if (backgroundRunning(inp)) return allow('background-running', 'a background subagent is still running');
    const leases = db.activeLeases();
    const leased = new Set(leases.map((l) => l.task_id));
    let ready, tasks;
    try {
      ready = await backlog.listReady(50, leased, scopeOf(config));
      tasks = await backlog.listTasks();
    } catch (e) {
      return allow('backlog-error', `backlog query failed (${(e as Error).message})`);
    }
    const cap = capacityOf(config, leases, tasks);
    const canStart = cap.freeTaskSlots > 0 && cap.freeEngineerSlots > 0;
    const startable = canStart ? ready.filter((t) => !leased.has(t.id)) : [];
    const continuing = tasks.filter((t) => !leased.has(t.id) &&
      (t.status === 'testing' || t.status === 'reviewing' || (t.status === 'changes-requested' && cap.freeEngineerSlots > 0)));
    if (!startable.length && !continuing.length) {
      return ready.length ? allow('no-capacity', `${ready.length} ready but no capacity`) : allow('no-ready', 'no runnable tasks');
    }
    const fingerprint = sha256(JSON.stringify({
      ready: ready.map((t) => t.id).sort(),
      continuing: continuing.map((t) => `${t.id}:${t.status}`).sort(),
      leases: leases.map((l) => l.id).sort(),
      lastEvent: db.lastEventId(),
    }));
    const g = db.guard();
    if (g.fingerprint === fingerprint && g.count >= NO_PROGRESS_LIMIT) {
      db.setGuard({ fingerprint, count: g.count, last_reason: 'no-progress' });
      return { reason: 'allow: no-progress (state unchanged after repeated continuation)' };
    }
    const count = g.fingerprint === fingerprint ? g.count + 1 : 1;
    db.setGuard({ fingerprint, count, last_reason: 'continue' });
    const parts: string[] = [];
    if (startable.length) parts.push(`${startable.length} ready task(s) (${startable.slice(0, 5).map((t) => t.id).join(', ')}), capacity ${Math.min(cap.freeTaskSlots, cap.freeEngineerSlots)}`);
    if (continuing.length) parts.push(`${continuing.length} task(s) awaiting the next stage (${continuing.slice(0, 5).map((t) => `${t.id}:${t.status}`).join(', ')})`);
    return block(`minions: ${parts.join('; ')}; run /minions:orchestrate to dispatch the next one. If nothing can proceed, report why and stop.`);
  } catch (e) {
    return { reason: `allow: internal error (${(e as Error).message})` };
  }
}

/** Worker agent types; `engineer-deep` (the higher-effort engineer definition) runs under an engineer lease. */
const WORKER = /^minions:(engineer|tester|reviewer)(-deep)?$/;
const MARKER = /minions-lease:\s*(lease-[A-Za-z0-9_-]+)/g;

const deny = (reason: string): HookOutput => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  reason: `deny: ${reason}`,
});

/** PreToolUse(Agent) guard: minions workers need a prompt naming an active lease for that role. Fails closed. */
export async function preAgentHook(input: unknown, load: HookLoader): Promise<HookOutput> {
  const inp = isObj(input) ? input : {};
  const ti = isObj(inp.tool_input) ? inp.tool_input : {};
  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type : '';
  if (!type.startsWith('minions:')) return { reason: `allow: not a minions worker (${type || 'none'})` };
  const m = WORKER.exec(type);
  if (!m || (m[2] && m[1] !== 'engineer')) return deny(`Unknown minions agent type "${type}".`);
  const role = m[1] as LeaseRole;
  // The Agent tool only accepts model aliases; a full id would fail the launch with a less useful error.
  if (typeof ti.model === 'string' && ti.model && !isAgentModelAlias(ti.model)) {
    return deny(`model "${ti.model}" is not an Agent model alias (${AGENT_MODEL_ALIASES.join('|')}). Omit \`model\` to use the model set in the ${type} definition, or pass an allowed alias.`);
  }
  try {
    const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
    const ids = [...prompt.matchAll(MARKER)].map((x) => x[1]!);
    if (!ids.length) {
      return deny(`${type} needs a claimed lease: run \`minions work claim <taskId> --role ${role} --json\` and include its briefMarker ("minions-lease: <leaseId>") in the prompt.`);
    }
    const { db } = await load();
    for (const id of ids) {
      const l = db.lease(id);
      if (l && l.status === 'active' && l.role === role) return { reason: `allow: ${type} under lease ${id} for ${l.task_id}` };
    }
    return deny(`No active ${role} lease matches ${ids.join(', ')}. Claim the task with \`minions work claim <taskId> --role ${role} --json\` first.`);
  } catch (e) {
    return deny(`minions could not verify the lease (${(e as Error).message}); refusing to launch ${type}.`);
  }
}

/**
 * PreToolUse(Telegram MCP tools) guard, registered by the coordinator's --settings when Telegram is on.
 * Telegram tools are coordinator-only: a call from any subagent (Claude Code sets agent_id/agent_type in
 * hook input inside a subagent) is denied, whatever its type. The main coordinator thread is allowed.
 */
export function preTelegramHook(input: unknown): HookOutput {
  const inp = isObj(input) ? input : {};
  const tool = typeof inp.tool_name === 'string' ? inp.tool_name : 'a Telegram tool';
  const agentId = typeof inp.agent_id === 'string' ? inp.agent_id : '';
  const agentType = typeof inp.agent_type === 'string' ? inp.agent_type : '';
  if (agentId || agentType) {
    return deny(`${tool} is coordinator-only; subagents (${agentType || 'unknown type'}) cannot use Telegram tools. Return what you want sent to the coordinator instead.`);
  }
  return { reason: `allow: ${tool} from the coordinator` };
}

// ---------------------------------------------------------------- drain (PreToolUse, every tool)

/** Tool calls a leased worker may make freely after the first drain notice, before it is restricted. */
export const DRAIN_GRACE_CALLS = 10;
const DRAIN_READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite']);
/** git subcommands that record or inspect work; anything that could discard uncommitted changes is absent. */
const DRAIN_GIT = new Set(['add', 'commit', 'status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'ls-files']);
const DRAIN_SHELL = new Set(['cd', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'echo', 'grep', 'true']);

/** Splits a shell line on unquoted `&&`, `||`, `;`, `|`; stops at an unquoted `<<` (the heredoc body is data). */
function shellSegments(cmd: string): { segments: string[]; redirect: boolean } {
  const segments: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let redirect = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') { cur += c + (cmd[++i] ?? ''); continue; } cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '<' && cmd[i + 1] === '<') break;
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      segments.push(cur); cur = '';
      if ((c === '|' && cmd[i + 1] === '|') || c === '&') i++;
      continue;
    }
    // Output redirection writes files; only `>/dev/null` and `2>&1` are harmless.
    if (c === '>' && !/^>\s*\/dev\/null\b/.test(cmd.slice(i)) && !(cmd[i - 1] === '2' && cmd.startsWith('>&1', i))) redirect = true;
    cur += c;
  }
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), redirect };
}

/** True for Bash lines that only commit, inspect, or submit the result (no edits, no discarding). */
export function drainSafeBash(command: string): boolean {
  if (/^\s*(?:cd\s+\S+\s*&&\s*)?minions\s+work\s+(?:submit|brief)\b/.test(command)) return true;
  const { segments, redirect } = shellSegments(command);
  if (redirect || !segments.length) return false;
  return segments.every((s) => {
    const words = s.split(/\s+/);
    if (words[0] === 'git') {
      let i = 1;
      while (words[i] === '-C' || words[i] === '-c') i += 2;
      while (words[i]?.startsWith('--no-pager') || words[i] === '--no-optional-locks') i++;
      return DRAIN_GIT.has(words[i] ?? '') && !(words[i] === 'branch' && words.slice(i + 1).some((w) => /^-[dDmMfc]|^--(delete|move|force|copy)/.test(w)));
    }
    if (words[0] === 'minions') return words[1] === 'work' && (words[2] === 'submit' || words[2] === 'brief');
    return DRAIN_SHELL.has(words[0]!);
  });
}

const drainAllowed = (tool: string, ti: Record<string, unknown>): boolean =>
  DRAIN_READ_ONLY_TOOLS.has(tool) || /Handback$/.test(tool) || (tool === 'Bash' && typeof ti.command === 'string' && drainSafeBash(ti.command));

/** What the worker is told on its first tool call after a drain request, by role. */
export function drainNotice(role: LeaseRole, reason: string): string {
  const head = reason === 'upgrade' ? 'Upgrade pending' : `Drain requested (${reason})`;
  const what = role === 'reviewer'
    ? `${head}: stop the review now. You have nothing to commit: return a partial WorkerResult right away (findings so far; the remaining review work in findings and nextAction). The review reruns later at the same head.`
    : role === 'tester'
      ? `${head}: reach a safe checkpoint now. If you changed tests, commit them on your branch (message prefix \`wip:\`); if you have nothing to commit, return a partial WorkerResult right away. List the remaining testing in findings and nextAction.`
      : `${head}: reach a safe checkpoint now. Commit work in progress on your branch (message prefix \`wip:\`), then return a partial WorkerResult that lists the remaining work.`;
  return `${what} Never discard uncommitted changes (no reset, checkout, restore, clean or stash). After about ${DRAIN_GRACE_CALLS} more tool calls only read-only tools, git (add/commit/status/log/diff) and \`minions work submit\` are allowed.`;
}

const addContext = (text: string, reason: string): HookOutput => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }), reason,
});

/**
 * PreToolUse(every tool) drain hook; the plugin runs it only while the drain flag file exists. It acts
 * only on minions worker subagents (hook input `agent_id` + a `minions:<role>` `agent_type`) while an
 * active lease of that role exists: the first call gets the checkpoint notice as context, then after
 * DRAIN_GRACE_CALLS everything but read-only tools, git and `minions work submit` is denied. The
 * coordinator (no agent_id), other subagents and unleased sessions are always allowed. An error allows
 * the call, except for a minions worker during a drain, which is restricted (fails closed).
 */
export async function drainHook(input: unknown, load: DrainLoader): Promise<HookOutput> {
  const inp = isObj(input) ? input : {};
  const agentId = typeof inp.agent_id === 'string' ? inp.agent_id : '';
  const agentType = typeof inp.agent_type === 'string' ? inp.agent_type : '';
  const tool = typeof inp.tool_name === 'string' ? inp.tool_name : '';
  const ti = isObj(inp.tool_input) ? inp.tool_input : {};
  const m = WORKER.exec(agentType);
  if (!agentId || !m) return { reason: `allow: not a minions worker (${agentId ? agentType || 'unknown type' : 'main thread'})` };
  const role = m[1] as LeaseRole;
  try {
    const { db } = await load();
    const drain = db.drain();
    if (!drain) return { reason: 'allow: no drain requested' };
    if (!db.activeLeases().some((l) => l.role === role)) return { reason: `allow: no active ${role} lease` };
    const hits = db.drainHit(drain.eventId, agentId);
    if (hits === 1) return addContext(drainNotice(role, drain.reason), `context: drain notice to ${agentType} ${agentId}`);
    if (hits <= DRAIN_GRACE_CALLS + 1 || drainAllowed(tool, ti)) return { reason: `allow: ${agentType} ${agentId} ${tool} during drain (call ${hits})` };
    return deny(`Drain in progress (${drain.reason}): only read-only tools, git (add/commit/status/log/diff) and \`minions work submit\` are allowed now. ` +
      'Commit work in progress on your branch (message prefix `wip:`), then return a partial WorkerResult that lists the remaining work. Uncommitted changes are never discarded.');
  } catch (e) {
    if (drainAllowed(tool, ti)) return { reason: `allow: ${tool} (drain state unreadable: ${(e as Error).message})` };
    return deny(`minions could not read the drain state (${(e as Error).message}); while a drain is pending only read-only tools, git and \`minions work submit\` are allowed. Commit work in progress (\`wip:\`) and return a partial WorkerResult.`);
  }
}

async function readStdin(timeoutMs = 5000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => { process.stdin.pause(); resolve(data); }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => (data += d));
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
  });
}

export type HookKind = 'stop' | 'pre-agent' | 'pre-telegram' | 'drain';

/** Hooks that allow on unreadable input or an internal error (the others fail closed). */
const failsOpen = (kind: HookKind) => kind === 'stop' || kind === 'drain';

/** Entry point for `minions hook stop|pre-agent|pre-telegram|drain`: reads stdin, prints the decision, never throws, exits 0. */
export async function runHook(kind: HookKind, load: HookLoader | DrainLoader, stdinText?: string): Promise<HookOutput> {
  let out: HookOutput;
  try {
    const text = stdinText ?? (await readStdin());
    let input: unknown = {};
    let parseError: string | undefined;
    try { input = text.trim() ? JSON.parse(text) : {}; } catch (e) { parseError = (e as Error).message; }
    if (parseError) {
      out = failsOpen(kind) ? { reason: `allow: unreadable hook input (${parseError})` } : deny(`minions could not parse the hook input (${parseError}).`);
    } else {
      out = kind === 'drain' ? await drainHook(input, load) : kind === 'pre-telegram' ? preTelegramHook(input)
        : kind === 'stop' ? await stopHook(input, load as HookLoader) : await preAgentHook(input, load as HookLoader);
    }
  } catch (e) {
    out = failsOpen(kind) ? { reason: `allow: internal error (${(e as Error).message})` } : deny(`minions hook failed (${(e as Error).message}).`);
  }
  hookLog(`${kind} ${out.reason}`);
  if (out.stdout) process.stdout.write(out.stdout + '\n');
  return out;
}
