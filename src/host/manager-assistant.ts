// The host manager's natural-language assistant, part 2: the Claude invocation and its settings
// (docs/design/host-manager-assistant.md, "Invocation", "Failure and fallback"; task-65.2). The context bundle and the
// proposal schema (task-65.3) and the chat wiring (task-65.4) build on this module.
//
// One message is one `claude -p` call that can do nothing but answer:
// - argv (buildAssistantInvocation, pure): no tools (`--tools ""` plus every built-in tool and the setup assistant's
//   deny rules in --disallowedTools), an empty MCP config with --strict-mcp-config, permission mode default (never
//   bypass, acceptEdits, auto or dontAsk) and bypass disabled through --settings, no plugin dir, no channels. Never a
//   secret and never the owner's text: the input goes on stdin.
// - A fresh run dir per call, <MINIONS_HOME>/manager/assistant/run-<random> (0700), holding the CLAUDE_CONFIG_DIR, an
//   empty cwd and a throwaway HOME. It is removed after the call, also after a failure or a timeout. The user's own
//   ~/.claude (plugins, the Telegram channel, logins, transcripts) is never loaded.
// - env: an allowlist (PASS_ENV of the host runtime without CLAUDE_CONFIG_DIR, LC_*, absolute PATH entries), the run
//   dir, and the manager Claude token as CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. Nothing else passes through.
// - Bounds: a 60 s timeout (the child's whole process group is killed), a 64 KiB output cap, a 64 KiB input cap.
// - Fail closed: `claude --version` and `claude --help` are checked once (probeClaude) against a minimum version and
//   the safety flags above; if one is missing the assistant is unavailable with that reason and never runs.
// assistant.json and the token are read per call, so `minions setup` changes need no manager restart.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { displayText, truncateCodePoints } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { ensureRealDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { managerDir, managerPaths } from '../core/paths.js';
import { ASSISTANT_DENIED_COMMANDS, ASSISTANT_SETTINGS, assistantDeniedPaths } from './assistant.js';
import { resolveOnPath } from './auth.js';
import {
  claudeTokenEnvName, loadManagerClaudeCredentialRef, managerClaudeCredentialStatus, readManagerClaudeToken,
  type ClaudeTokenKind, type ManagerClaudeCredentialStatus,
} from './credentials.js';
import { PASS_ENV } from './runtime.js';

export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

// ---------------------------------------------------------------- assistant.json

export const ASSISTANT_MODELS = ['sonnet', 'haiku', 'opus'] as const;
export type AssistantModel = typeof ASSISTANT_MODELS[number];
export const DEFAULT_ASSISTANT_MODEL: AssistantModel = 'sonnet';
export const DEFAULT_DAILY_LIMIT = 50;

/** <MINIONS_HOME>/manager/assistant.json (0600). Written by `minions setup` and, later, by `/assistant on|off`. */
export const AssistantConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  model: z.enum(ASSISTANT_MODELS),
  /** Calls per day before the manager answers with the deterministic fallback. */
  dailyLimit: z.number().int().min(1).max(1000),
}).strict();
export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;

export const defaultAssistantConfig = (): AssistantConfig => ({ version: 1, enabled: false, model: DEFAULT_ASSISTANT_MODEL, dailyLimit: DEFAULT_DAILY_LIMIT });

/** The assistant settings, or null when none are recorded. An unreadable file is an error (INVALID_CONFIG). */
export async function loadAssistantConfig(): Promise<AssistantConfig | null> {
  return (await readJsonIfExists(managerPaths().assistantJson, AssistantConfigSchema)) ?? null;
}

export async function saveAssistantConfig(c: AssistantConfig): Promise<void> {
  const v = AssistantConfigSchema.parse(c);
  await ensureRealDir(managerDir(), 0o700);
  await chmod(managerDir(), 0o700);
  await writeJson(managerPaths().assistantJson, v, { mode: 0o600 });
}

/** Setup guidance for the assistant sub-step. Contains no secret. */
export function managerAssistantGuidance(): string[] {
  return [
    'The assistant lets you write to the manager bot in plain language ("switch to manual merges"). It only explains and',
    '  proposes: every change is still the host plan you confirm with a tap. Slash commands keep working without it.',
    'Each message is one `claude -p` call on this host with no tools and a fresh, empty config directory (never your',
    `  own ~/.claude login or plugins). It needs its own Claude token: run \`claude setup-token\` (Claude subscription) or`,
    `  create an Anthropic API key, then paste it at the hidden prompt. Limit: ${DEFAULT_DAILY_LIMIT} calls per day by default.`,
    'The token stays on this host (Keychain, Secret Service or a 0600 file); only the manager process reads it.',
  ];
}

export async function removeAssistantConfig(): Promise<void> {
  await rm(managerPaths().assistantJson, { force: true });
  await rm(managerPaths().assistantUsageJson, { force: true });
}

// ---------------------------------------------------------------- usage (calls today, last error)

/**
 * <MINIONS_HOME>/manager/assistant-usage.json (0600): the calls of the current UTC day, the day the over-limit notice
 * was last sent, and the last error of a call. Written by the manager only (one call at a time); read by
 * `minions status` and doctor. Holds no owner text, no answer and no secret: an error reason is the host's own text.
 */
export const AssistantUsageSchema = z.object({
  version: z.literal(1),
  /** UTC day (YYYY-MM-DD) the count belongs to. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  calls: z.number().int().min(0),
  /** The day the "daily limit reached" reason was last shown (once a day; later messages get the command list only). */
  limitNoticeDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  lastError: z.object({ at: z.string(), failure: z.string().max(40), reason: z.string().max(400) }).strict().nullable(),
}).strict();
export type AssistantUsage = z.infer<typeof AssistantUsageSchema>;

/** The UTC day of a date (the daily limit resets at 00:00 UTC). */
export const usageDay = (now: Date) => now.toISOString().slice(0, 10);

/** The usage of now's day: a count of another day reads as 0 (the last error and the notice day stay). Never throws. */
export async function loadAssistantUsage(now: Date = new Date()): Promise<AssistantUsage> {
  const day = usageDay(now);
  let u: AssistantUsage | null = null;
  try { u = (await readJsonIfExists(managerPaths().assistantUsageJson, AssistantUsageSchema)) ?? null; } catch { u = null; }
  if (!u) return { version: 1, day, calls: 0, limitNoticeDay: null, lastError: null };
  return u.day === day ? u : { ...u, day, calls: 0 };
}

export async function saveAssistantUsage(u: AssistantUsage): Promise<void> {
  const v = AssistantUsageSchema.parse(u);
  await ensureRealDir(managerDir(), 0o700);
  await chmod(managerDir(), 0o700);
  await writeJson(managerPaths().assistantUsageJson, v, { mode: 0o600 });
}

// ---------------------------------------------------------------- bounds

export const ASSISTANT_TIMEOUT_MS = 60_000;
/** stdout plus stderr of one call. */
export const ASSISTANT_OUTPUT_CAP = 64 * 1024;
/** stdin of one call (context bundle, history and the owner's text). */
export const ASSISTANT_INPUT_CAP = 64 * 1024;
/** The system prompt travels in argv: the fixed template only (no owner text, no secret), and bounded. */
export const ASSISTANT_SYSTEM_PROMPT_CAP = 32 * 1024;
/** Per call, where the CLI supports --max-budget-usd. */
export const ASSISTANT_MAX_BUDGET_USD = '0.25';
const PROBE_TIMEOUT_MS = 15_000;
/** Run dirs older than this are leftovers of a crashed manager (a call lasts at most the timeout plus the kill grace). */
export const STALE_RUN_MS = 10 * 60_000;

// ---------------------------------------------------------------- CLI capabilities (fail closed)

/** Oldest Claude Code accepted at all; the flag check below is what really decides. */
export const MIN_CLAUDE_VERSION = '2.0.0';

/** Flags the call cannot run safely without. A CLI that lacks one disables the assistant. */
export const REQUIRED_FLAGS = [
  '--print', '--model', '--output-format', '--system-prompt', '--tools', '--disallowedTools', '--mcp-config', '--strict-mcp-config',
  '--settings', '--permission-mode',
] as const;

/** Extra bounds used when the installed CLI has them (the safety does not depend on them). */
export const OPTIONAL_FLAGS = [
  '--json-schema', '--no-session-persistence', '--max-budget-usd', '--max-turns', '--permission-prompts', '--disable-slash-commands', '--restricted',
  '--setting-sources',
] as const;

/**
 * The built-in tools, denied by name as defence in depth: `--tools ""` already removes them all. Unknown names in a
 * deny list are harmless, so the list may name tools an older CLI does not have.
 */
export const BUILTIN_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'PowerShell', 'REPL', 'Monitor', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead',
  'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'TodoRead', 'Skill', 'SlashCommand', 'ExitPlanMode',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'SendUserMessage',
] as const;

/**
 * Permission modes that may be passed: `default`, or `manual`, which newer CLIs list instead (it maps to default).
 * TODO(task-70): once task-70 merges, use the shared strictPermissionModeArg of src/runtime/permission-modes.ts in
 * checkCapabilities. Its logic is the same as here: `default` when listed, else `manual`, `default` when the choices are
 * not listed, and fail closed when they list neither.
 */
const DEFAULT_MODE_NAMES = ['default', 'manual'] as const;
export type AssistantPermissionMode = typeof DEFAULT_MODE_NAMES[number];

export interface ClaudeHelp {
  /** Every option name defined in the help (long and short forms and aliases), e.g. `--tools`, `-p`. */
  flags: Set<string>;
  /** `(choices: "a", "b")` of an option, keyed by each of its names. */
  choices: Map<string, string[]>;
}

/**
 * Parses `claude --help`. Only option definitions count (a line that starts with two spaces and a dash): a flag that
 * is merely mentioned in another option's description is not "present", so a missing flag is never mistaken for one.
 */
export function parseClaudeHelp(text: string): ClaudeHelp {
  const flags = new Set<string>();
  const choices = new Map<string, string[]>();
  let current: string[] = [];
  let desc = '';
  const flush = () => {
    const m = /\(choices:\s*((?:"[^"]*"\s*,?\s*)+)/.exec(desc);
    if (m && current.length) {
      const list = [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
      for (const n of current) choices.set(n, list);
    }
    current = []; desc = '';
  };
  for (const line of text.split(/\r?\n/)) {
    const def = /^ {2}(-[^\s].*?)(?: {2,}(.*))?$/.exec(line);
    if (def) {
      flush();
      const spec = def[1]!.split(/\s[<[]/)[0]!;
      current = [...spec.matchAll(/(?:^|[\s,])(--?[A-Za-z][A-Za-z0-9-]*)/g)].map((x) => x[1]!);
      for (const n of current) flags.add(n);
      desc = def[2] ?? '';
    } else if (/^\S/.test(line)) flush();
    else desc += ' ' + line.trim();
  }
  flush();
  return { flags, choices };
}

/** `2.1.292 (Claude Code)` -> `2.1.292`; null when unrecognizable. */
export function parseClaudeVersion(text: string): string | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)\b/.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export interface ClaudeCapabilities {
  /** Absolute path of the claude executable that was checked (the call runs exactly this one). */
  claudePath: string;
  version: string;
  permissionMode: AssistantPermissionMode;
  jsonSchema: boolean;
  noSessionPersistence: boolean;
  maxBudget: boolean;
  maxTurns: boolean;
  /** `--permission-prompts none`: anything that would prompt is denied. */
  permissionPromptsNone: boolean;
  disableSlashCommands: boolean;
  /** `--restricted`: no code-running tools, user/project/local settings files ignored, bypass refused. */
  restricted: boolean;
  /**
   * `--setting-sources`: without --restricted the call passes `--setting-sources user`, so no project or local settings
   * file loads (the user source is the fresh, empty CLAUDE_CONFIG_DIR of the call).
   */
  settingSources: boolean;
}
export type CapabilityCheck = { ok: true; caps: ClaudeCapabilities } | { ok: false; reason: string };

/** Decides from the `--version` and `--help` output (pure). */
export function checkCapabilities(claudePath: string, versionOut: string, helpOut: string): CapabilityCheck {
  const version = parseClaudeVersion(versionOut);
  if (!version) return { ok: false, reason: 'could not read the Claude Code version (`claude --version`)' };
  if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) return { ok: false, reason: `Claude Code ${version} is older than ${MIN_CLAUDE_VERSION}; update it (\`claude update\`)` };
  const help = parseClaudeHelp(helpOut);
  const missing = REQUIRED_FLAGS.filter((f) => !help.flags.has(f));
  if (missing.length) return { ok: false, reason: `Claude Code ${version} lacks the safety flag(s) ${missing.join(', ')}; update it (\`claude update\`)` };
  const modes = help.choices.get('--permission-mode');
  const permissionMode = !modes ? 'default' : DEFAULT_MODE_NAMES.find((m) => modes.includes(m));
  if (!permissionMode) return { ok: false, reason: `Claude Code ${version} offers no default permission mode (choices: ${modes!.join(', ')})` };
  const prompts = help.choices.get('--permission-prompts');
  return {
    ok: true,
    caps: {
      claudePath, version, permissionMode,
      jsonSchema: help.flags.has('--json-schema'),
      noSessionPersistence: help.flags.has('--no-session-persistence'),
      maxBudget: help.flags.has('--max-budget-usd'),
      maxTurns: help.flags.has('--max-turns'),
      permissionPromptsNone: help.flags.has('--permission-prompts') && (!prompts || prompts.includes('none')),
      disableSlashCommands: help.flags.has('--disable-slash-commands'),
      restricted: help.flags.has('--restricted'),
      settingSources: help.flags.has('--setting-sources'),
    },
  };
}

/**
 * Finds `claude` on PATH and checks it (two short runs: `--version`, `--help`, in a fresh run dir with the allowlisted
 * environment and no credential, so not even the check loads the user's config). Never throws.
 */
export async function probeClaude(o: { runner?: Runner; env?: NodeJS.ProcessEnv } = {}): Promise<CapabilityCheck> {
  const runner = o.runner ?? run;
  const env = o.env ?? process.env;
  const claudePath = await resolveOnPath('claude', env.PATH);
  if (!claudePath) return { ok: false, reason: 'Claude Code (`claude`) is not on PATH' };
  let dir: RunDir | null = null;
  try {
    dir = await createRunDir();
    const childEnv = { ...assistantBaseEnv(env), ...runDirEnv(dir) };
    const opts: RunOptions = { cwd: dir.cwd, env: childEnv, timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: 256 * 1024, allowFailure: true };
    const v = await runner(claudePath, ['--version'], opts);
    if (v.code !== 0) return { ok: false, reason: `\`claude --version\` failed (exit ${v.code})` };
    const h = await runner(claudePath, ['--help'], opts);
    if (h.code !== 0) return { ok: false, reason: `\`claude --help\` failed (exit ${h.code})` };
    return checkCapabilities(claudePath, v.stdout, h.stdout);
  } catch (e) {
    return { ok: false, reason: `could not check Claude Code: ${short(e)}` };
  } finally {
    if (dir) await removeRunDir(dir);
  }
}

// ---------------------------------------------------------------- run dir

export interface RunDir {
  /** <MINIONS_HOME>/manager/assistant/run-<random>, 0700. */
  root: string;
  /** CLAUDE_CONFIG_DIR of the call. */
  configDir: string;
  /** The call's cwd: empty, so no CLAUDE.md, project settings or repository files load. */
  cwd: string;
  /** HOME of the call: nothing under the user's home is read or written through ~. */
  home: string;
}

async function privateMkdir(dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
}

/** Creates a fresh run dir (0700, under a 0700 parent that must be a real directory). */
export async function createRunDir(): Promise<RunDir> {
  const parent = managerPaths().assistantRunsDir;
  await ensureRealDir(managerDir(), 0o700);
  await chmod(managerDir(), 0o700);
  await ensureRealDir(parent, 0o700);
  await chmod(parent, 0o700);
  const root = join(parent, `run-${randomBytes(12).toString('hex')}`);
  await privateMkdir(root); // fails if it exists: never reuses a dir
  const d: RunDir = { root, configDir: join(root, 'config'), cwd: join(root, 'cwd'), home: join(root, 'home') };
  try {
    for (const p of [d.configDir, d.cwd, d.home]) await privateMkdir(p);
  } catch (e) { await removeRunDir(d); throw e; }
  return d;
}

/** Removes a run dir; true when it is gone. Never throws. */
export async function removeRunDir(d: Pick<RunDir, 'root'>): Promise<boolean> {
  try { await rm(d.root, { recursive: true, force: true }); return true; } catch { return false; }
}

/** Removes run dirs a crashed manager left behind (older than STALE_RUN_MS). Never throws. */
export async function sweepStaleRunDirs(now: Date = new Date()): Promise<string[]> {
  const parent = managerPaths().assistantRunsDir;
  const removed: string[] = [];
  let names: string[];
  try { names = await readdir(parent); } catch { return removed; }
  for (const n of names) {
    if (!/^run-[0-9a-f]+$/.test(n)) continue;
    const p = join(parent, n);
    try {
      if (now.getTime() - (await stat(p)).mtimeMs > STALE_RUN_MS) { await rm(p, { recursive: true, force: true }); removed.push(p); }
    } catch { /* gone already */ }
  }
  return removed;
}

// ---------------------------------------------------------------- environment and argv (pure)

/** Credential variables that only the builder sets (exactly one of them, from the manager Claude token). */
const CREDENTIAL_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * The allowlisted part of the manager's environment: PASS_ENV of the host runtime without CLAUDE_CONFIG_DIR (the call
 * gets its own), LC_*, and PATH with absolute entries only. No credential, no MINIONS_*, nothing else.
 */
export function assistantBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === 'CLAUDE_CONFIG_DIR' || CREDENTIAL_ENV.includes(k)) continue;
    if (PASS_ENV.has(k) || k.startsWith('LC_')) out[k] = v;
  }
  out.PATH = (env.PATH ?? '').split(':').filter((d) => d && isAbsolute(d)).join(':');
  return out;
}

/** The run dir part of the child environment (also used by the capability probe). */
export const runDirEnv = (d: RunDir): Record<string, string> => ({
  CLAUDE_CONFIG_DIR: d.configDir,
  HOME: d.home,
  // A per-message call never updates the CLI, reports errors or sends telemetry.
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});

export interface InvocationInput {
  caps: ClaudeCapabilities;
  model: AssistantModel;
  /** The fixed system prompt template (no owner text, no secret): it travels in argv. */
  systemPrompt: string;
  /** JSON Schema for --json-schema (used only when the CLI has the flag). */
  jsonSchema?: object;
  runDir: RunDir;
  credential: { token: string; kind: ClaudeTokenKind };
  /** assistantBaseEnv(...) of the manager's environment. */
  baseEnv: Record<string, string>;
}
export interface Invocation { command: string; args: string[]; env: Record<string, string>; cwd: string }

/** The empty MCP config: with --strict-mcp-config no other MCP server loads. */
export const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

/**
 * The exact command of one assistant call (pure; tests assert the argv). Every variadic option (--tools,
 * --disallowedTools, --mcp-config) is followed by another option, and there is no positional argument: the input is
 * stdin. The token is only in env, under the variable of its kind.
 */
export function buildAssistantInvocation(i: InvocationInput): Invocation {
  if (!(ASSISTANT_MODELS as readonly string[]).includes(i.model)) throw new MinionsError('INVALID_CONFIG', `unknown assistant model ${JSON.stringify(i.model)}`);
  if (!DEFAULT_MODE_NAMES.includes(i.caps.permissionMode)) throw new MinionsError('INTERNAL', 'the assistant runs in the default permission mode only');
  if (!i.systemPrompt.trim() || i.systemPrompt.startsWith('-') || i.systemPrompt.length > ASSISTANT_SYSTEM_PROMPT_CAP) {
    throw new MinionsError('INTERNAL', `the assistant system prompt must be non-empty, not start with "-", and at most ${ASSISTANT_SYSTEM_PROMPT_CAP} characters`);
  }
  if (!isAbsolute(i.caps.claudePath)) throw new MinionsError('INTERNAL', 'claude must be an absolute path');
  const c = i.caps;
  const args = [
    '-p',
    '--model', i.model,
    '--output-format', 'json',
    '--tools', '',
    '--disallowedTools', ...BUILTIN_TOOLS, ...ASSISTANT_DENIED_COMMANDS, ...assistantDeniedPaths(),
    '--mcp-config', EMPTY_MCP_CONFIG,
    '--strict-mcp-config',
    '--settings', JSON.stringify(ASSISTANT_SETTINGS),
    '--permission-mode', c.permissionMode,
    ...(c.permissionPromptsNone ? ['--permission-prompts', 'none'] : []),
    ...(c.noSessionPersistence ? ['--no-session-persistence'] : []),
    ...(c.disableSlashCommands ? ['--disable-slash-commands'] : []),
    ...(c.restricted ? ['--restricted'] : c.settingSources ? ['--setting-sources', 'user'] : []),
    ...(c.maxTurns ? ['--max-turns', '1'] : []),
    ...(c.maxBudget ? ['--max-budget-usd', ASSISTANT_MAX_BUDGET_USD] : []),
    ...(i.jsonSchema && c.jsonSchema ? ['--json-schema', JSON.stringify(i.jsonSchema)] : []),
    '--system-prompt', i.systemPrompt,
  ];
  if (args.some((a) => a.includes(i.credential.token))) throw new MinionsError('INTERNAL', 'refusing to put a secret in argv');
  const env: Record<string, string> = { ...i.baseEnv };
  for (const k of CREDENTIAL_ENV) delete env[k];
  Object.assign(env, runDirEnv(i.runDir), { [claudeTokenEnvName(i.credential.kind)]: i.credential.token });
  return { command: c.claudePath, args, env, cwd: i.runDir.cwd };
}

// ---------------------------------------------------------------- one call

export type AssistantFailure = 'unavailable' | 'input-too-large' | 'spawn' | 'timeout' | 'aborted' | 'output-cap' | 'auth' | 'exit' | 'invalid-json' | 'error';
export type AssistantOutcome =
  | { ok: true; text: string; structured?: unknown; costUsd?: number }
  | { ok: false; failure: AssistantFailure; reason: string };

const AUTH_ERROR = /\b401\b|authentication_error|invalid api key|invalid x-api-key|invalid bearer token|oauth token (?:has )?expired|token (?:has )?expired|please run \/login|not logged in|credentials? (?:are |is )?invalid/i;
const AUTH_REASON = 'Claude rejected the assistant token (expired, revoked or mistyped): store a new one with `minions setup` (host manager step)';

const short = (e: unknown, max = 200) => truncateCodePoints(displayText(redact(String((e as Error)?.message ?? e))).replace(/\s+/g, ' ').trim(), max);

/**
 * Maps the child's result to an outcome (pure). `--output-format json` prints one object
 * `{type: 'result', subtype, is_error, result, structured_output?, total_cost_usd?}`; anything else is invalid.
 * Reasons never contain the model's answer or a secret.
 */
export function interpretOutput(r: RunResult, o: { timeoutMs?: number; outputCap?: number } = {}): AssistantOutcome {
  if (r.aborted) return { ok: false, failure: 'aborted', reason: 'the call was cancelled' };
  if (r.timedOut) return { ok: false, failure: 'timeout', reason: `no answer within ${Math.ceil((o.timeoutMs ?? ASSISTANT_TIMEOUT_MS) / 1000)} s` };
  if (r.outputLimited) return { ok: false, failure: 'output-cap', reason: `the answer exceeded ${Math.round((o.outputCap ?? ASSISTANT_OUTPUT_CAP) / 1024)} KiB` };
  let parsed: unknown;
  try { parsed = JSON.parse(r.stdout.trim()); } catch { parsed = undefined; }
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const resultText = typeof obj?.result === 'string' ? obj.result : '';
  if ((r.code !== 0 || obj?.is_error === true) && (AUTH_ERROR.test(r.stderr) || AUTH_ERROR.test(resultText))) return { ok: false, failure: 'auth', reason: AUTH_REASON };
  if (r.code === 127 && !obj) return { ok: false, failure: 'spawn', reason: `could not start claude: ${short(r.stderr)}` };
  if (r.code !== 0) return { ok: false, failure: 'exit', reason: `claude exited with code ${r.code}${r.stderr.trim() ? `: ${short(r.stderr, 160)}` : ''}` };
  if (!obj || obj.type !== 'result') return { ok: false, failure: 'invalid-json', reason: 'the answer was not the expected JSON result' };
  if (obj.is_error === true || obj.subtype !== 'success') {
    return { ok: false, failure: 'error', reason: `claude reported an error (${typeof obj.subtype === 'string' ? short(obj.subtype, 60) : 'unknown'})` };
  }
  if (typeof obj.result !== 'string') return { ok: false, failure: 'invalid-json', reason: 'the answer has no result text' };
  const cost = typeof obj.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd) ? obj.total_cost_usd : undefined;
  return { ok: true, text: obj.result, ...(obj.structured_output !== undefined ? { structured: obj.structured_output } : {}), ...(cost !== undefined ? { costUsd: cost } : {}) };
}

export interface CallOptions {
  caps: ClaudeCapabilities;
  model: AssistantModel;
  systemPrompt: string;
  /** stdin: the context bundle, history and the owner's text. Never argv. */
  input: string;
  jsonSchema?: object;
  credential: { token: string; kind: ClaudeTokenKind };
  /** Spawns the child (tests: a fake). Defaults to src/core/exec.ts `run` (no shell; SIGTERM, then SIGKILL, to the whole process group). */
  runner?: Runner;
  /** The manager's environment (only the allowlist passes). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputCap?: number;
  signal?: AbortSignal;
  now?: Date;
}

/**
 * One assistant call: a fresh run dir, the child with the input on stdin, bounded by the timeout and the output cap,
 * then the run dir is removed (also on failure, timeout or a throwing runner). Never throws.
 */
export async function runAssistantCall(o: CallOptions): Promise<AssistantOutcome> {
  if (Buffer.byteLength(o.input) > ASSISTANT_INPUT_CAP) return { ok: false, failure: 'input-too-large', reason: `the input exceeds ${ASSISTANT_INPUT_CAP / 1024} KiB` };
  const timeoutMs = o.timeoutMs ?? ASSISTANT_TIMEOUT_MS;
  const outputCap = o.outputCap ?? ASSISTANT_OUTPUT_CAP;
  await sweepStaleRunDirs(o.now);
  let dir: RunDir | null = null;
  try {
    dir = await createRunDir();
    const inv = buildAssistantInvocation({
      caps: o.caps, model: o.model, systemPrompt: o.systemPrompt, ...(o.jsonSchema ? { jsonSchema: o.jsonSchema } : {}),
      runDir: dir, credential: o.credential, baseEnv: assistantBaseEnv(o.env ?? process.env),
    });
    const r = await (o.runner ?? run)(inv.command, inv.args, {
      cwd: inv.cwd, env: inv.env, input: o.input, timeoutMs, maxOutputBytes: outputCap, allowFailure: true, killGroup: true, ...(o.signal ? { signal: o.signal } : {}),
    });
    return interpretOutput(r, { timeoutMs, outputCap });
  } catch (e) {
    return { ok: false, failure: 'spawn', reason: `could not run claude: ${short(e)}` };
  } finally {
    if (dir) await removeRunDir(dir);
  }
}

// ---------------------------------------------------------------- availability and the manager-facing runner

export type Availability =
  | { available: true; config: AssistantConfig; caps: ClaudeCapabilities }
  | { available: false; reason: string };

export interface ManagerAssistantDeps {
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  loadConfig?: () => Promise<AssistantConfig | null>;
  readCredential?: () => Promise<{ token: string; kind: ClaudeTokenKind } | null>;
  /** Capability check (default probeClaude); called at most once per ManagerAssistant. */
  probe?: () => Promise<CapabilityCheck>;
  timeoutMs?: number;
  outputCap?: number;
}

export interface ManagerAssistant {
  /** Whether a call would run now (switched on, a token stored, a checked CLI). Never throws. */
  availability(): Promise<Availability>;
  /** One call; an unavailable assistant answers `{ok: false, failure: 'unavailable'}` without spawning. Never throws. */
  ask(o: { systemPrompt: string; input: string; jsonSchema?: object; signal?: AbortSignal }): Promise<AssistantOutcome>;
}

/**
 * The manager's assistant runner. assistant.json and the token are read for every call (setup changes apply without
 * a restart); the CLI is checked once, on first use, and a failed check keeps the assistant off until the manager
 * restarts (fail closed: it never runs with a CLI that lacked a safety flag).
 */
export function createManagerAssistant(deps: ManagerAssistantDeps = {}): ManagerAssistant {
  let probed: Promise<CapabilityCheck> | null = null;
  const probe = () => (probed ??= (deps.probe ?? (() => probeClaude({ ...(deps.runner ? { runner: deps.runner } : {}), ...(deps.env ? { env: deps.env } : {}) })))()
    .catch((e): CapabilityCheck => ({ ok: false, reason: `could not check Claude Code: ${short(e)}` })));
  const availability = async (): Promise<Availability> => {
    let config: AssistantConfig | null;
    try { config = await (deps.loadConfig ?? loadAssistantConfig)(); } catch (e) { return { available: false, reason: `assistant.json is unreadable: ${short(e, 120)}` }; }
    if (!config) return { available: false, reason: 'not set up (`minions setup`, host manager step)' };
    if (!config.enabled) return { available: false, reason: 'switched off' };
    const check = await probe();
    if (!check.ok) return { available: false, reason: check.reason };
    return { available: true, config, caps: check.caps };
  };
  return {
    availability,
    async ask(o) {
      const a = await availability();
      if (!a.available) return { ok: false, failure: 'unavailable', reason: a.reason };
      let credential: { token: string; kind: ClaudeTokenKind } | null;
      try { credential = await (deps.readCredential ?? (() => readManagerClaudeToken(deps.runner ?? run)))(); } catch (e) {
        return { ok: false, failure: 'unavailable', reason: `the Claude token cannot be read: ${short(e, 120)}` };
      }
      if (!credential) return { ok: false, failure: 'unavailable', reason: 'no Claude token stored (`minions setup`, host manager step)' };
      return runAssistantCall({
        caps: a.caps, model: a.config.model, systemPrompt: o.systemPrompt, input: o.input, credential,
        ...(o.jsonSchema ? { jsonSchema: o.jsonSchema } : {}), ...(o.signal ? { signal: o.signal } : {}),
        ...(deps.runner ? { runner: deps.runner } : {}), ...(deps.env ? { env: deps.env } : {}),
        ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}), ...(deps.outputCap ? { outputCap: deps.outputCap } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------- status and doctor

export interface AssistantOverview {
  /** assistant.json exists or a Claude token is stored. */
  setUp: boolean;
  enabled: boolean;
  model: AssistantModel | null;
  dailyLimit: number | null;
  /** From the reference file only (`doctor` reads the store itself): ok = a token is recorded. */
  credential: 'ok' | 'missing' | 'invalid';
  credentialKind: ClaudeTokenKind | null;
  /** Calls of the current UTC day (assistant-usage.json). */
  callsToday: number;
  /** The last failed call (host text, no owner text, no secret), or null. */
  lastError: { at: string; reason: string } | null;
  errors: string[];
}

/**
 * Read-only: assistant.json and the token's reference file. No claude run, no network, and no secret store access (so
 * `minions status` never triggers a Keychain prompt); never the token.
 */
export async function assistantOverview(now: Date = new Date()): Promise<AssistantOverview> {
  const errors: string[] = [];
  const config = await loadAssistantConfig().catch((e) => { errors.push(`assistant.json: ${short(e, 160)}`); return null; });
  let credential: AssistantOverview['credential'] = 'missing';
  let ref: Awaited<ReturnType<typeof loadManagerClaudeCredentialRef>> = null;
  try { ref = await loadManagerClaudeCredentialRef(); if (ref) credential = 'ok'; } catch (e) {
    credential = 'invalid';
    errors.push(`manager Claude credential reference: ${short(e, 160)}`);
  }
  const usage = await loadAssistantUsage(now);
  return {
    setUp: !!config || credential !== 'missing', enabled: config?.enabled ?? false, model: config?.model ?? null, dailyLimit: config?.dailyLimit ?? null,
    credential, credentialKind: ref?.kind ?? null, callsToday: usage.calls,
    lastError: usage.lastError ? { at: usage.lastError.at, reason: usage.lastError.reason } : null, errors,
  };
}

/** One `minions status` line for the manager block. */
export function formatAssistantLine(a: AssistantOverview): string {
  if (!a.setUp) return 'assistant: not set up (optional: `minions setup`, host manager step)';
  const token = a.credential === 'ok' ? 'token stored' : a.credential === 'missing' ? 'no token' : 'token invalid';
  const calls = a.dailyLimit ? `, ${a.callsToday} of ${a.dailyLimit} calls today` : a.callsToday ? `, ${a.callsToday} calls today` : '';
  return `assistant: ${a.enabled ? 'on' : 'off'}${a.model ? `, ${a.model}` : ''}${calls}, ${token}${a.lastError ? `; last error ${a.lastError.at}: ${short(a.lastError.reason, 300)}` : ''}`;
}

export interface AssistantCheck { name: 'manager.assistant'; status: 'ok' | 'warn' | 'unavailable'; detail: string; hint?: string }

/**
 * manager.assistant for doctor / `status --check`: warns, never fails (the typed commands are the baseline). Checks the
 * CLI (probeClaude: `--version` and `--help` only, never a model call) only when the assistant is switched on.
 */
export async function assistantCheck(o: { runner?: Runner; probe?: () => Promise<CapabilityCheck> } = {}): Promise<AssistantCheck> {
  const name = 'manager.assistant' as const;
  const setup = 'Run `minions setup` in a terminal (host manager step, natural-language assistant).';
  let config: AssistantConfig | null;
  try { config = await loadAssistantConfig(); } catch (e) {
    return { name, status: 'warn', detail: `assistant.json is unreadable (${short(e, 160)}): the assistant stays off`, hint: setup };
  }
  const cred = await managerClaudeCredentialStatus(o).catch((e): ManagerClaudeCredentialStatus => ({ state: 'invalid', detail: short(e, 160) }));
  if (!config && !cred.backend && cred.state === 'missing') return { name, status: 'ok', detail: 'not set up (optional: plain-language requests in the manager chat)' };
  if (!config?.enabled) {
    return cred.state === 'invalid'
      ? { name, status: 'warn', detail: `off; the stored Claude token is invalid: ${cred.detail}`, hint: setup }
      : { name, status: 'ok', detail: `off${cred.state === 'ok' ? ' (Claude token stored)' : ''}` };
  }
  const usage = await loadAssistantUsage();
  const on = `on (${config.model}, limit ${config.dailyLimit} calls/day${usage.calls ? `, ${usage.calls} today` : ''})`;
  const lastError = usage.lastError ? `; last error ${usage.lastError.at}: ${short(usage.lastError.reason, 300)}` : '';
  if (cred.state !== 'ok') return { name, status: 'warn', detail: `${on}, but ${cred.state === 'missing' ? 'no Claude token is stored' : `the Claude token is invalid: ${cred.detail}`}: the manager answers with the command list`, hint: setup };
  const check = await (o.probe ?? (() => probeClaude(o.runner ? { runner: o.runner } : {})))().catch((e): CapabilityCheck => ({ ok: false, reason: short(e) }));
  if (!check.ok) return { name, status: 'warn', detail: `${on}, but unavailable: ${check.reason}`, hint: 'Install or update Claude Code on this host (`claude update`); the manager answers with the command list until then.' };
  return { name, status: 'ok', detail: `${on}; ${cred.detail}; Claude Code ${check.caps.version}${lastError}` };
}
