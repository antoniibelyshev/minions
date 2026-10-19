import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BacklogAdapter } from '../backlog/types.js';
import type { MinionsConfig } from '../config/schema.js';
import { sha256 } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import type { LeaseRole, RuntimeDb } from './db.js';
import { runtimePaths } from './paths.js';
import { capacityOf, scopeOf } from './scheduler.js';

export interface HookDeps { db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig }
export type HookLoader = () => HookDeps | Promise<HookDeps>;
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

const WORKER = /^minions:(engineer|tester|reviewer)$/;
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
  if (!m) return deny(`Unknown minions agent type "${type}".`);
  const role = m[1] as LeaseRole;
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

/** Entry point for `minions hook stop|pre-agent`: reads stdin, prints the decision, never throws, exits 0. */
export async function runHook(kind: 'stop' | 'pre-agent', load: HookLoader, stdinText?: string): Promise<HookOutput> {
  let out: HookOutput;
  try {
    const text = stdinText ?? (await readStdin());
    let input: unknown = {};
    let parseError: string | undefined;
    try { input = text.trim() ? JSON.parse(text) : {}; } catch (e) { parseError = (e as Error).message; }
    if (parseError) {
      out = kind === 'stop' ? { reason: `allow: unreadable hook input (${parseError})` } : deny(`minions could not parse the hook input (${parseError}).`);
    } else {
      out = kind === 'stop' ? await stopHook(input, load) : await preAgentHook(input, load);
    }
  } catch (e) {
    out = kind === 'stop' ? { reason: `allow: internal error (${(e as Error).message})` } : deny(`minions hook failed (${(e as Error).message}).`);
  }
  hookLog(`${kind} ${out.reason}`);
  if (out.stdout) process.stdout.write(out.stdout + '\n');
  return out;
}
