import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BacklogAdapter } from '../backlog/types.js';
import { AGENT_MODEL_ALIASES, isAgentModelAlias } from '../config/models.js';
import { agentTypeRole, DEEP_SUFFIX, workerRoleNames } from '../config/roles.js';
import type { MinionsConfig, RoleContract } from '../config/schema.js';
import { sha256 } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import type { DrainNoticeVia, LeaseRole, RuntimeDb } from './db.js';
import { TELEGRAM_TOOL_PREFIX } from './coordinator.js';
import { runtimePaths } from './paths.js';
import { capacityOf, scopeOf } from './scheduler.js';
import { currentBudget } from './spend.js';
import { noteTranscript } from './context-reset.js';

export interface HookDeps { db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig }
export type HookLoader = () => HookDeps | Promise<HookDeps>;
/** The drain hook needs only the runtime DB (it runs on every worker tool call during a drain). */
export type DrainLoader = () => DrainDeps | Promise<DrainDeps>;
/** The config is optional for the drain hook: without it the lease roles decide and the notice falls back to a generic wording. */
export type DrainDeps = Pick<HookDeps, 'db'> & { config?: MinionsConfig };
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
  // Context-reset trigger input (task-45): the main session's transcript, for its latest usage. Never affects the decision.
  try { noteTranscript(db, inp); } catch { /* best-effort */ }
  const allow = (reason: string, detail = reason): HookOutput => {
    try { db.setGuard({ fingerprint: null, count: 0, last_reason: reason }); } catch { /* ignore */ }
    return { reason: `allow: ${detail}` };
  };
  try {
    if (db.paused().starts) return allow('paused');
    if (currentBudget({ db, config })?.exhausted) return allow('budget', 'the owner budget is used up (new claims are refused)');
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

/**
 * Shape of a worker agent type: `minions:<name>` with a role-name-like name (`<role>-deep` included). Whether
 * the name is a registered role (and whether its `-deep` variant exists) is decided against the config.
 */
const WORKER_TYPE = /^minions:[a-z][a-z0-9-]{0,40}$/;
const MARKER = /minions-lease:\s*(lease-[A-Za-z0-9_-]+)/g;

const deny = (reason: string): HookOutput => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  reason: `deny: ${reason}`,
});

/**
 * PreToolUse(Agent) guard (D10): `minions:<role>` and `minions:<role>-deep` (only for a role with a deep
 * variant) are accepted iff the role is in the registry of the runtime config and the prompt names an active
 * lease of that role. Every other `minions:*` type is denied. Fails closed (an unreadable config or DB denies).
 */
export async function preAgentHook(input: unknown, load: HookLoader): Promise<HookOutput> {
  const inp = isObj(input) ? input : {};
  const ti = isObj(inp.tool_input) ? inp.tool_input : {};
  const type = typeof ti.subagent_type === 'string' ? ti.subagent_type : '';
  if (!type.startsWith('minions:')) return { reason: `allow: not a minions worker (${type || 'none'})` };
  const shown = JSON.stringify(type.slice(0, 80)).slice(1, -1);
  // Cheap syntactic check first: no config or DB read for a type no role could have.
  if (!WORKER_TYPE.test(type)) return deny(`Unknown minions agent type "${shown}".`);
  // The Agent tool only accepts model aliases; a full id would fail the launch with a less useful error.
  if (typeof ti.model === 'string' && ti.model && !isAgentModelAlias(ti.model)) {
    return deny(`model "${ti.model}" is not an Agent model alias (${AGENT_MODEL_ALIASES.join('|')}). Omit \`model\` to use the model set in the ${type} definition, or pass an allowed alias.`);
  }
  try {
    const { db, config } = await load();
    const def = agentTypeRole(config, type);
    if (!def) return deny(`Unknown minions agent type "${shown}": not a registered worker role (${workerRoleNames(config).join(', ')}) or the deep variant of one.`);
    const role = def.name;
    const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
    const ids = [...prompt.matchAll(MARKER)].map((x) => x[1]!);
    if (!ids.length) {
      return deny(`${type} needs a claimed lease: run \`minions work claim <taskId> --role ${role} --json\` and include its briefMarker ("minions-lease: <leaseId>") in the prompt.`);
    }
    for (const id of ids) {
      const l = db.lease(id);
      if (l && l.status === 'active' && (l.role as string) === role) return { reason: `allow: ${type} under lease ${id} for ${l.task_id}` };
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
 *
 * Fails closed on input it cannot decide: non-object input and a missing or non-Telegram tool_name are
 * denied. agent_id / agent_type count as set whenever they are anything but undefined/null, so a
 * non-string or empty value is treated as a subagent marker (deny) rather than ignored.
 */
export function preTelegramHook(input: unknown): HookOutput {
  if (!isObj(input)) return deny('minions could not read the Telegram hook input (not a JSON object); refusing the call.');
  const tool = input.tool_name;
  if (typeof tool !== 'string' || !tool.startsWith(TELEGRAM_TOOL_PREFIX) || tool.length === TELEGRAM_TOOL_PREFIX.length) {
    const what = typeof tool === 'string' ? `a non-Telegram tool_name (${JSON.stringify(tool.slice(0, 80))})` : 'no tool_name';
    return deny(`minions pre-telegram hook got ${what}; refusing the call.`);
  }
  const isSet = (v: unknown) => v !== undefined && v !== null;
  if (isSet(input.agent_id) || isSet(input.agent_type)) {
    const agentType = typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : 'unknown type';
    return deny(`${tool} is coordinator-only; subagents (${agentType}) cannot use Telegram tools. Return what you want sent to the coordinator instead.`);
  }
  return { reason: `allow: ${tool} from the coordinator` };
}

// ---------------------------------------------------------------- drain (PreToolUse, every tool)

/** Tool calls a leased worker may make freely after the first drain notice, before it is restricted. */
export const DRAIN_GRACE_CALLS = 10;
const DRAIN_READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite']);
/**
 * The upgrade-drain Bash check (task-3.9): a strict allowlist of whole command forms. Anything it does
 * not recognize is denied; shell grammar beyond these forms is never interpreted.
 *
 * A line without a newline is one or more simple commands joined only by `&&`, optionally starting with
 * `cd <path> &&`. Words are plain (`[A-Za-z0-9_./:=@%+,-]`), single-quoted (no newline), or double-quoted
 * without `$`, a backtick, `\` or a newline; adjacent parts join into one word. Any other character
 * outside quotes is denied, so substitutions, expansions, globs, `;`, `<`, `>`, `!`, `#`, tabs and
 * newlines never reach a shell. A simple command may end with the exact tokens `>/dev/null` and `2>&1`,
 * then `| head -<n>` or `| tail -<n>`. The command name must be a plain word and one of:
 *
 * - `git [-C <path>] [--no-pager] <sub>` with `status|log|diff|show|rev-parse` (no `--ou…` argument,
 *   which git expands to `--output=<file>`), `branch` (no args or one of `--show-current -a -r --list`),
 *   `add <paths|-A|-u>` and `commit -m <quoted message>` (no other flags: no `--amend`, `-a`, `-c`).
 *   `git -c` is denied (core.fsmonitor, core.pager and aliases run commands).
 * - `ls`, `cat <file>`, `pwd`, `echo`, and `minions work submit|brief <lease> [--role <r>] --json`.
 *
 * A line with a newline must be one of three heredoc forms, matched structurally; the body is not parsed:
 * - `[cd <path> && ]minions work submit <lease> [--role <r>] --json <<'RESULT'\n<body>\nRESULT[\n]`,
 *   with no body line exactly `RESULT` (the worker result contract).
 * - `[cd <path> && ][git add … && ]git commit -m "$(cat <<'EOF'\n<body>\nEOF\n)"` and nothing after; no
 *   body line may start with `EOF` (inside `$( )` bash also ends the body at a line like `EOF)`).
 * - `[cd <path> && ][git add … && ]git commit -F - <<'EOF'\n<body>\nEOF[\n]`, no body line exactly `EOF`.
 * The delimiters are single-quoted, so the shell never expands the body.
 *
 * This drain is a cooperative safeguard, not a sandbox: allowed git commands can run programs set in
 * repo config/attributes (core.fsmonitor, diff.external, filter/textconv drivers, commit hooks), and
 * `git -C <path>` or `cd <path>` can point at a repo with pre-staged config. This residual is accepted
 * as the same trust class as worker code already running.
 */
interface ShellWord { text: string; quoted: boolean }
type ShellToken = { kind: 'and' | 'pipe' } | { kind: 'redirect'; text: string } | { kind: 'word'; word: ShellWord };

const PLAIN_CHAR = /^[A-Za-z0-9_./:=@%+,-]$/;
const DRAIN_REDIRECTS = ['2>&1', '>/dev/null'];

function drainTokens(line: string): ShellToken[] | null {
  const tokens: ShellToken[] = [];
  const boundary = (n: number) => n === line.length || line[n] === ' ';
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') { i++; continue; }
    if (line.startsWith('&&', i)) { tokens.push({ kind: 'and' }); i += 2; continue; }
    if (line[i] === '|' && boundary(i + 1)) { tokens.push({ kind: 'pipe' }); i++; continue; }
    const redirect = DRAIN_REDIRECTS.find((r) => line.startsWith(r, i) && boundary(i + r.length));
    if (redirect) { tokens.push({ kind: 'redirect', text: redirect }); i += redirect.length; continue; }
    let text = '';
    let quoted = false;
    const start = i;
    while (i < line.length) {
      const c = line[i]!;
      if (c === "'" || c === '"') {
        const end = line.indexOf(c, i + 1);
        if (end < 0) return null;
        const body = line.slice(i + 1, end);
        if (body.includes('\n') || (c === '"' && /[$`\\]/.test(body))) return null;
        text += body; quoted = true; i = end + 1;
      } else if (PLAIN_CHAR.test(c)) { text += c; i++; }
      else break;
    }
    if (i === start || !(boundary(i) || line.startsWith('&&', i))) return null;
    tokens.push({ kind: 'word', word: { text, quoted } });
  }
  return tokens;
}

/** A newline-free line as its `&&`-joined simple commands (words; `tail` when redirects or a pipe follow), or null. */
function drainChain(line: string): { words: ShellWord[]; tail: boolean }[] | null {
  if (line.includes('\n')) return null;
  const tokens = drainTokens(line);
  if (!tokens) return null;
  const commands: { words: ShellWord[]; tail: boolean }[] = [];
  let k = 0;
  for (;;) {
    const words: ShellWord[] = [];
    while (tokens[k]?.kind === 'word') words.push((tokens[k++] as { word: ShellWord }).word);
    if (!words.length) return null;
    const seen = new Set<string>();
    let tail = false;
    for (let t = tokens[k]; t?.kind === 'redirect'; t = tokens[++k]) {
      if (seen.has(t.text)) return null;
      seen.add(t.text); tail = true;
    }
    if (tokens[k]?.kind === 'pipe') {
      const [cmd, count] = [tokens[k + 1], tokens[k + 2]];
      if (cmd?.kind !== 'word' || count?.kind !== 'word' || cmd.word.quoted || count.word.quoted) return null;
      if (!['head', 'tail'].includes(cmd.word.text) || !/^-[1-9][0-9]{0,5}$/.test(count.word.text)) return null;
      k += 3; tail = true;
    }
    commands.push({ words, tail });
    if (k === tokens.length) return commands;
    if (tokens[k]!.kind !== 'and') return null;
    k++;
  }
}

const DRAIN_GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse']);
const DRAIN_GIT_BRANCH_ARGS = new Set(['--show-current', '-a', '-r', '--list']);

/** `git` with at most one `-C <path>` and one `--no-pager`: the index of the subcommand word, or -1. Other global options (`-c`) are denied. */
function gitSubcommandAt(words: ShellWord[]): number {
  let i = 1;
  let cd = false;
  let pager = false;
  for (;;) {
    const w = words[i];
    if (!w || w.quoted) return -1;
    if (w.text === '-C' && !cd && words[i + 1]) { cd = true; i += 2; }
    else if (w.text === '--no-pager' && !pager) { pager = true; i++; }
    else return w.text.startsWith('-') ? -1 : i;
  }
}

const isGitCommit = (words: ShellWord[]) => words[0]?.text === 'git' && !words[0].quoted && gitSubcommandAt(words) === words.length - 1 && words.at(-1)!.text === 'commit';

function drainGitOk(words: ShellWord[]): boolean {
  const at = gitSubcommandAt(words);
  if (at < 0) return false;
  const sub = words[at]!.text;
  const args = words.slice(at + 1);
  // git expands unambiguous long-option prefixes: `--ou`, `--outp` all mean `--output=<file>`.
  if (DRAIN_GIT_READ.has(sub)) return !args.some((a) => a.text.startsWith('--ou'));
  if (sub === 'branch') return args.length === 0 || (args.length === 1 && DRAIN_GIT_BRANCH_ARGS.has(args[0]!.text));
  if (sub === 'add') {
    const dashdash = args.findIndex((a) => a.text === '--');
    return (dashdash < 0 ? args : args.slice(0, dashdash)).every((a) => a.text === '-A' || a.text === '-u' || !a.text.startsWith('-'));
  }
  if (sub === 'commit') return args.length === 2 && args[0]!.text === '-m' && !args[0]!.quoted && args[1]!.quoted;
  return false;
}

/** `minions work submit|brief <lease> [--role <r>] --json`. */
function drainMinionsOk(words: ShellWord[], verbs: string[]): boolean {
  const [, work, verb, lease, ...rest] = words.map((w) => (w.quoted ? '' : w.text));
  if (work !== 'work' || !verbs.includes(verb ?? '') || !/^[A-Za-z0-9_-]+$/.test(lease ?? '')) return false;
  const tail = rest.join(' ');
  return tail === '--json' || /^--role [a-z-]+ --json$/.test(tail);
}

/** One simple command at `pos` of `total` in an `&&` chain. */
function drainCommandOk(words: ShellWord[], pos: number, total: number): boolean {
  const name = words[0]!;
  if (name.quoted) return false;
  switch (name.text) {
    case 'cd': return pos === 0 && total > 1 && words.length === 2;
    case 'pwd': return words.length === 1;
    case 'cat': return words.length === 2;
    case 'ls': case 'echo': return true;
    case 'git': return drainGitOk(words);
    case 'minions': return drainMinionsOk(words, ['submit', 'brief']);
    default: return false;
  }
}

/**
 * The head line of a heredoc form (before ` <<'…'`): `[cd <path> && ]` then, for commit forms, `git add …`
 * commands, then the final command, which `last` checks. No redirects or pipes anywhere.
 */
function drainHeredocHead(head: string, last: (words: ShellWord[]) => boolean, adds: boolean): boolean {
  const chain = drainChain(head);
  if (!chain || chain.some((c) => c.tail)) return false;
  return chain.every(({ words }, pos) => {
    if (pos === chain.length - 1) return last(words);
    if (words[0]!.text === 'cd' && !words[0]!.quoted) return drainCommandOk(words, pos, chain.length);
    return adds && words[0]!.text === 'git' && !words[0]!.quoted && words[gitSubcommandAt(words)]?.text === 'add' && drainGitOk(words);
  });
}

/** The body lines of a heredoc closed by `delim` on its own line (plus an optional final newline), or null. */
function heredocBody(rest: string, delim: string): string[] | null {
  const lines = rest.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.pop() !== delim) return null;
  return lines.includes(delim) ? null : lines;
}

const SUBMIT_OPEN = " <<'RESULT'";
const COMMIT_MESSAGE_OPEN = ` -m "$(cat <<'EOF'`;
const COMMIT_FILE_OPEN = " -F - <<'EOF'";

/**
 * True for Bash lines that only commit, inspect, or submit the result (see the allowlist above).
 * Decisions (task-3.9): unknown forms are denied; `git -c` is denied; `git -C <path>` is allowed (workers
 * use it instead of `cd`); `git commit --amend` is denied (it rewrites a commit that may already be recorded).
 */
export function drainSafeBash(command: string): boolean {
  const nl = command.indexOf('\n');
  if (nl < 0) {
    const chain = drainChain(command);
    return !!chain && chain.every(({ words }, pos) => drainCommandOk(words, pos, chain.length));
  }
  const first = command.slice(0, nl);
  const rest = command.slice(nl + 1);
  if (first.endsWith(SUBMIT_OPEN)) {
    return drainHeredocHead(first.slice(0, -SUBMIT_OPEN.length), (w) => w[0]?.text === 'minions' && !w[0].quoted && drainMinionsOk(w, ['submit']), false)
      && heredocBody(rest, 'RESULT') !== null;
  }
  if (first.endsWith(COMMIT_MESSAGE_OPEN)) {
    if (!drainHeredocHead(first.slice(0, -COMMIT_MESSAGE_OPEN.length), isGitCommit, true)) return false;
    const lines = rest.split('\n');
    if (lines.pop() !== ')"' || lines.pop() !== 'EOF') return false;
    return !lines.some((l) => l.startsWith('EOF'));
  }
  if (first.endsWith(COMMIT_FILE_OPEN)) {
    return drainHeredocHead(first.slice(0, -COMMIT_FILE_OPEN.length), isGitCommit, true) && heredocBody(rest, 'EOF') !== null;
  }
  return false;
}

const drainAllowed = (tool: string, ti: Record<string, unknown>): boolean =>
  DRAIN_READ_ONLY_TOOLS.has(tool) || /Handback$/.test(tool) || (tool === 'Bash' && typeof ti.command === 'string' && drainSafeBash(ti.command));

/** How a drain notice is worded (D10): by the role's contract variant, and whether the role commits at all. */
export interface DrainVariant { contract: RoleContract; commits: boolean }
const BUILTIN_DRAIN_VARIANTS: Record<LeaseRole, DrainVariant> = {
  engineer: { contract: 'producer', commits: true },
  tester: { contract: 'verifier', commits: true },
  reviewer: { contract: 'gate', commits: false },
};
const builtinDrainVariant = (role: string): DrainVariant | undefined => (Object.hasOwn(BUILTIN_DRAIN_VARIANTS, role) ? BUILTIN_DRAIN_VARIANTS[role as LeaseRole] : undefined);

/** What the worker is told on its first tool call after a drain request, by contract variant (a role name of a built-in is accepted too). */
export function drainNotice(variant: DrainVariant | RoleContract | LeaseRole, reason: string): string {
  const v: DrainVariant = typeof variant !== 'string' ? variant
    : builtinDrainVariant(variant) ?? { contract: variant as RoleContract, commits: variant !== 'gate' };
  const head = reason === 'upgrade' ? 'Upgrade pending' : `Drain requested (${reason})`;
  const what = v.contract === 'gate'
    ? `${head}: stop the review now. You have nothing to commit: return a partial WorkerResult right away (findings so far; the remaining review work in findings and nextAction). The review reruns later at the same head.`
    : !v.commits
      ? `${head}: stop now. Your role does not commit: return a partial WorkerResult right away (what you found so far; the remaining work in findings and nextAction).`
      : v.contract === 'verifier'
        ? `${head}: reach a safe checkpoint now. If you changed tests, commit them on your branch (message prefix \`wip:\`); if you have nothing to commit, return a partial WorkerResult right away. List the remaining testing in findings and nextAction.`
        : `${head}: reach a safe checkpoint now. Commit work in progress on your branch (message prefix \`wip:\`), then return a partial WorkerResult that lists the remaining work.`;
  return `${what} Never discard uncommitted changes (no reset, checkout, restore, clean or stash). After about ${DRAIN_GRACE_CALLS} more tool calls only read-only tools, git status|log|diff|show|rev-parse, git add <paths|-A|-u>, git commit -m "<quoted msg>" or the $(cat <<'EOF' … EOF) / -F - <<'EOF' forms (no --amend, no -a), cd <path> && …, and minions work submit|brief <lease> [--role <r>] --json are allowed.`;
}

const addContext = (text: string, reason: string): HookOutput => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } }), reason,
});

/** How much of a subagent transcript is searched for its lease marker (the brief is the first message). */
const TRANSCRIPT_HEAD_BYTES = 256 * 1024;

/**
 * The subagent's own transcript: Claude Code keeps it at <session dir>/<session id>/subagents/agent-<agent_id>.jsonl
 * next to the main transcript (`transcript_path`); an `agent_transcript_path` or a `transcript_path`
 * already naming the agent is used as is.
 */
function agentTranscriptPaths(inp: Record<string, unknown>, agentId: string): string[] {
  const out: string[] = [];
  if (typeof inp.agent_transcript_path === 'string') out.push(inp.agent_transcript_path);
  const tp = typeof inp.transcript_path === 'string' ? inp.transcript_path : '';
  if (tp && /^[A-Za-z0-9_-]+$/.test(agentId)) {
    if (basename(tp).includes(agentId)) out.push(tp);
    else out.push(join(dirname(tp), basename(tp, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`));
  }
  return out;
}

function readHead(path: string, max: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(max);
    return buf.subarray(0, readSync(fd, buf, 0, max, 0)).toString('utf8');
  } finally { closeSync(fd); }
}

/**
 * The active lease(s) of the worker's role a delivered drain notice belongs to: the only one, else the
 * one whose `minions-lease:` marker is in the subagent's transcript, else (conservatively) all of them.
 */
export function noticeLeases<L extends { id: string }>(candidates: L[], inp: Record<string, unknown>, agentId: string): { leases: L[]; via: DrainNoticeVia } {
  if (candidates.length === 1) return { leases: candidates, via: 'only' };
  for (const p of agentTranscriptPaths(inp, agentId)) {
    let text: string;
    try { text = readHead(p, TRANSCRIPT_HEAD_BYTES); } catch { continue; }
    const ids = new Set([...text.matchAll(MARKER)].map((m) => m[1]!));
    const hit = candidates.filter((l) => ids.has(l.id));
    if (hit.length) return { leases: hit, via: 'transcript' };
  }
  return { leases: candidates, via: 'role' };
}

/**
 * PreToolUse(every tool) drain hook; the plugin runs it only while the drain flag file exists. It acts
 * only on minions worker subagents (hook input `agent_id` + a `minions:<role>` `agent_type`) while an
 * active lease of that role exists: the first call gets the checkpoint notice as context, then after
 * DRAIN_GRACE_CALLS everything but read-only tools, the Handback tool, and allowlisted Bash commands
 * is denied (see `drainSafeBash` for the allowlist). The coordinator (no agent_id), other subagents and
 * unleased sessions are always allowed. An error allows the call, except for a minions worker during a
 * drain, which is restricted (fails closed).
 */
export async function drainHook(input: unknown, load: DrainLoader): Promise<HookOutput> {
  const inp = isObj(input) ? input : {};
  const agentId = typeof inp.agent_id === 'string' ? inp.agent_id : '';
  const agentType = typeof inp.agent_type === 'string' ? inp.agent_type : '';
  const tool = typeof inp.tool_name === 'string' ? inp.tool_name : '';
  const ti = isObj(inp.tool_input) ? inp.tool_input : {};
  if (!agentId || !WORKER_TYPE.test(agentType)) return { reason: `allow: not a minions worker (${agentId ? agentType || 'unknown type' : 'main thread'})` };
  try {
    const { db, config } = await load();
    const drain = db.drain();
    if (!drain) return { reason: 'allow: no drain requested' };
    const name = agentType.slice('minions:'.length);
    // With the config the registry decides; without it (unreadable) the lease roles do: `<r>-deep` runs under an `<r>` lease.
    const def = config ? agentTypeRole(config, agentType) : undefined;
    if (config && !def) return { reason: `allow: ${agentType} is not a registered worker role` };
    const active = db.activeLeases();
    // Role names never end in `-deep`, so a `-deep` type without the config runs under its base role's lease.
    const role = def?.name ?? (name.endsWith(DEEP_SUFFIX) ? name.slice(0, -DEEP_SUFFIX.length) : name);
    const roleLeases = active.filter((l) => (l.role as string) === role);
    if (!roleLeases.length) return { reason: `allow: no active ${role} lease` };
    // Unknown contract (config unreadable, project role): the verifier wording covers both "commit" and "nothing to commit".
    const variant: DrainVariant = def ? { contract: def.contract, commits: def.commits } : builtinDrainVariant(role) ?? { contract: 'verifier', commits: true };
    const hits = db.drainHit(drain.eventId, agentId);
    if (hits === 1) {
      // Only on delivery (an agent's first call of this drain): tie the notice to its lease (task-3.10).
      let noted: string;
      try {
        const { leases, via } = noticeLeases(roleLeases, inp, agentId);
        for (const l of leases) db.recordDrainNotice(l, { eventId: drain.eventId, agentId, agentType, tool, via });
        noted = `lease ${leases.map((l) => l.id).join(',')} via ${via}`;
      } catch (e) { noted = `notice not recorded: ${(e as Error).message}`; }
      return addContext(drainNotice(variant, drain.reason), `context: drain notice to ${agentType} ${agentId} (${noted})`);
    }
    if (hits <= DRAIN_GRACE_CALLS + 1 || drainAllowed(tool, ti)) return { reason: `allow: ${agentType} ${agentId} ${tool} during drain (call ${hits})` };
    return deny(`Drain in progress (${drain.reason}): git status|log|diff|show|rev-parse, git add <paths|-A|-u>, git commit -m "<quoted msg>" or the $(cat <<'EOF' … EOF) / -F - <<'EOF' forms, cd <path> && …, and minions work submit|brief are allowed. ` +
      'Commit work in progress (`wip:`), then return a partial WorkerResult listing the remaining work. Uncommitted changes are never discarded.');
  } catch (e) {
    if (drainAllowed(tool, ti)) return { reason: `allow: ${tool} (drain state unreadable: ${(e as Error).message})` };
    return deny(`minions could not read the drain state (${(e as Error).message}); while a drain is pending git status|log|diff|show|rev-parse, git add <paths|-A|-u>, git commit, cd <path> && …, and minions work submit|brief are allowed. Commit work in progress (\`wip:\`) and return a partial WorkerResult.`);
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
