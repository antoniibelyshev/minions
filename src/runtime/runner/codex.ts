// The OpenAI Codex CLI adapter (docs/design/agent-runtimes.md D6, child task 4). Pure translation: lease + role ->
// `codex exec` argv, env, per-lease files and the stdin prompt; plus the JSONL usage / final-message parser.
// The lease, permission, isolation and git logic stays in the runner (run.ts).
//
// Architecture decisions (task-14.6), checked against the pinned version's source (rust-v0.164.0) and the docs:
// - Gate plan first (phase 1 option b). plan() refuses producer and verifier roles with PRECONDITION until their
//   plans land (the phase rules refuse them earlier anyway), so no role runs on an untested plan.
// - Config is a minions-generated `$CODEX_HOME/config.toml` in the per-lease harness home, not `-c` overrides:
//   it is the only user config Codex loads (CODEX_HOME is empty and per lease), it keeps paths out of argv quoting,
//   and it is snapshot-tested. `--strict-config` makes an unknown key (a renamed setting after a version bump) a
//   startup error instead of a silently ignored safety setting.
// - No `--ask-for-approval`: `codex exec` has no such flag in 0.164 (it is not in SharedCliOptions; clap would
//   refuse it). Exec forces `approval_policy = never` itself and rejects approval requests instead of blocking
//   (U-C5); the config repeats `approval_policy = "never"`.
// - `web_search = "disabled"`: with a full-access sandbox the default turns to "live" web search.
// - Usage: `turn.completed.usage` is the thread's cumulative total (exec's JSONL processor reports
//   `last_total_token_usage`), and one `codex exec` runs one turn. The final usage is therefore the last event,
//   not a sum (a sum would double count if a future version emitted several turns).
// - The output schema is strict-mode JSON Schema (Codex sends it with `strict: true`): every property required,
//   optional fields nullable, `additionalProperties: false`. The final message is normalized back to the
//   WorkerResult shape (null optional fields dropped) before the runner submits it.
import { join } from 'node:path';
import type { RoleContract } from '../../config/schema.js';
import { MinionsError } from '../../core/errors.js';
import { RESULT_STATUSES } from '../results.js';
import type { LaunchInput, LaunchPlan, ProcessAdapter, UsageEvent } from './adapter.js';

/** The secret file (in the mounted secrets dir) the runner reads into CODEX_API_KEY; the `codex` credential kind. */
export const CODEX_API_KEY_FILE = 'codex-api-key';
/** Contracts this build has a Codex plan for (gate first; producer and verifier follow). */
export const CODEX_PLANNED_CONTRACTS: readonly RoleContract[] = ['gate'];

// ------------------------------------------------------------------------------------- the output schema

const str = { type: 'string' } as const;
const nullable = (t: 'string' | 'boolean' | 'integer') => ({ type: [t, 'null'] });

/**
 * The WorkerResult as a strict-mode JSON Schema for `codex exec --output-schema`, per contract variant. A subset
 * of WorkerResultSchema: findings are plain strings, no `usage` (the runner records usage from the JSONL events),
 * and only a gate has `verdict` / `needsQa`. Length and SHA rules stay with validateResult at record time.
 */
export function codexOutputSchema(contract: RoleContract): Record<string, unknown> {
  const check = {
    type: 'object', additionalProperties: false,
    properties: {
      command: str, outcome: { type: 'string', enum: ['pass', 'fail', 'skipped'] }, details: nullable('string'),
      ...(contract === 'producer' ? {} : { source: { type: ['string', 'null'], enum: ['local', 'ci', null] } }),
    },
    required: ['command', 'outcome', 'details', ...(contract === 'producer' ? [] : ['source'])],
  };
  const properties: Record<string, unknown> = {
    status: { type: 'string', enum: [...RESULT_STATUSES] },
    summary: str,
    branch: str,
    headSha: str,
    modifiedPaths: { type: 'array', items: str },
    checks: { type: 'array', items: check },
    acceptanceEvidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { criterion: str, evidence: str }, required: ['criterion', 'evidence'] } },
    findings: { type: 'array', items: str },
    nextAction: str,
  };
  if (contract === 'gate') {
    properties.verdict = { type: ['string', 'null'], enum: ['approve', 'request-changes', null] };
    properties.needsQa = nullable('boolean');
  }
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

/** Optional WorkerResult fields that strict mode forces to be present: a null there means "absent". */
const OPTIONAL_TOP = ['verdict', 'needsQa', 'usage'] as const;
const OPTIONAL_CHECK = ['details', 'source'] as const;

/**
 * A schema-conformant final message -> WorkerResult JSON text: null optional fields are dropped (WorkerResultSchema
 * is strict and has no nulls). Anything that is not a JSON object is returned unchanged for the runner to judge.
 */
export function normalizeCodexResult(text: string): string {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return text; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return text;
  const o = { ...(v as Record<string, unknown>) };
  for (const k of OPTIONAL_TOP) if (o[k] === null) delete o[k];
  if (Array.isArray(o.checks)) {
    o.checks = o.checks.map((c: unknown) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return c;
      const cc = { ...(c as Record<string, unknown>) };
      for (const k of OPTIONAL_CHECK) if (cc[k] === null) delete cc[k];
      return cc;
    });
  }
  return JSON.stringify(o);
}

// ------------------------------------------------------------------------------------------- the config

/** A TOML basic string (JSON string escapes are a subset of TOML's). */
const toml = (s: string) => JSON.stringify(s);

/** The per-lease `$CODEX_HOME/config.toml` (D5, D6). Deterministic: snapshot-tested. */
export function codexConfigToml(input: Pick<LaunchInput, 'lease' | 'checkout' | 'effort' | 'briefFile' | 'resultFile'>): string {
  const L = [
    `# Generated by minions for lease ${input.lease.id} (docs/design/agent-runtimes.md D6). The only user config this run loads.`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'web_search = "disabled"',
    'check_for_update_on_startup = false',
    ...(input.effort ? [`model_reasoning_effort = ${toml(input.effort)}`] : []),
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[feedback]',
    'enabled = false',
    '',
    '[history]',
    'persistence = "none"',
    '',
    '# Commands Codex spawns get the core variables only, never *KEY* / *SECRET* / *TOKEN* (CODEX_API_KEY included).',
    '[shell_environment_policy]',
    'inherit = "core"',
    'ignore_default_excludes = false',
    '',
    '[shell_environment_policy.set]',
    `MINIONS_WORKER_LEASE = ${toml(input.lease.id)}`,
    `MINIONS_ROLE = ${toml(input.lease.role)}`,
    `MINIONS_BRIEF_FILE = ${toml(input.briefFile)}`,
    `MINIONS_RESULT_FILE = ${toml(input.resultFile)}`,
    '',
    '# No repository-provided .codex/ config, hooks or rules.',
    `[projects.${toml(input.checkout)}]`,
    'trust_level = "untrusted"',
    '',
  ];
  return L.join('\n');
}

// ------------------------------------------------------------------------------------------- the prompt

function contractGuide(contract: RoleContract): string {
  if (contract === 'gate') {
    return [
      'You are a read-only gate (reviewer). Do not commit, amend, reset or switch branches: the head must not move,',
      'and the runner treats any moved head as a violation. Builds and tests may write files in the checkout; nothing',
      'you write is kept. Report defects as findings; complete requires verdict "approve", needs_changes means',
      '"request-changes".',
    ].join(' ');
  }
  return '';
}

/** The stdin prompt: the Codex-specific preamble, then the runner's instructions (role prompt, contract, brief). */
export function codexPrompt(input: LaunchInput): string {
  const guide = contractGuide(input.role.contract);
  return [
    `Non-interactive minions worker on the OpenAI Codex CLI (role ${input.role.name}, contract ${input.role.contract}).`,
    `Your checkout: ${input.checkout}. Brief: ${input.briefFile}. Result file: ${input.resultFile}.`,
    'Nobody answers questions or approves actions during this run. Do not use the network except for the model.',
    ...(guide ? [guide] : []),
    'On Codex your final message is your result: make it exactly one WorkerResult JSON object (it is checked against',
    'a JSON schema; use null for optional fields that do not apply). The runner stores it; you need not write the result file.',
    '',
    input.instructions,
  ].join('\n');
}

// ------------------------------------------------------------------------------------------- the adapter

export interface CodexAdapterOptions {
  /** argv prefix that starts Codex (default `['codex']`, the pinned install on PATH). Tests point it at a fake. */
  command?: string[];
}

/** The planned invocation (D6), argv only; secrets never appear here (CODEX_API_KEY comes from secretEnv). */
export function codexArgv(input: LaunchInput, command: readonly string[], files: { schema: string; lastMessage: string }): string[] {
  return [
    ...command, 'exec',
    '--json', '--ephemeral', '--strict-config', '--ignore-rules', '--color', 'never',
    '--cd', input.checkout,
    // D4: L1 (minions-sandbox) is the boundary; Codex's own Linux sandbox needs user namespaces (U-C2).
    '--sandbox', 'danger-full-access',
    ...(input.model ? ['--model', input.model] : []),
    '--output-schema', files.schema,
    '--output-last-message', files.lastMessage,
    '-',
  ];
}

export function codexAdapter(opts: CodexAdapterOptions = {}): ProcessAdapter {
  const command = opts.command ?? ['codex'];
  if (!command.length) throw new MinionsError('INTERNAL', 'codex adapter: empty command');
  return {
    id: 'codex',
    plan(input: LaunchInput): LaunchPlan {
      if (!CODEX_PLANNED_CONTRACTS.includes(input.role.contract)) {
        throw new MinionsError('PRECONDITION', `The Codex adapter has no plan for ${input.role.contract} roles yet (role ${input.role.name}); gate roles come first (agent-runtimes D9 option b).`,
          `Set roles.${input.role.name}.harness to claude.`);
      }
      const dir = join(input.scratchDir, 'codex');
      const files = { schema: join(dir, 'worker-result.schema.json'), lastMessage: join(dir, 'last-message.json') };
      return {
        argv: codexArgv(input, command, files),
        env: { CODEX_HOME: input.harnessHome, NO_COLOR: '1', RUST_LOG: 'error' },
        secretEnv: { CODEX_API_KEY: CODEX_API_KEY_FILE },
        files: [
          { path: join(input.harnessHome, 'config.toml'), content: codexConfigToml(input), mode: 0o600 },
          { path: files.schema, content: JSON.stringify(codexOutputSchema(input.role.contract), null, 2) + '\n', mode: 0o600 },
        ],
        stdin: codexPrompt(input),
      };
    },
    parseEvent: parseCodexEvent,
    normalizeResult: normalizeCodexResult,
    finalUsage: lastUsage,
  };
}

// --------------------------------------------------------------------------------------------- the parser

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/**
 * One `codex exec --json` line -> usage (`turn.completed`) or the final message (`item.completed` of an
 * `agent_message`, normalized when it is a WorkerResult object). Other events and non-JSON lines are ignored.
 */
export function parseCodexEvent(line: string): { usage?: UsageEvent; finalMessage?: string } | null {
  if (!line.startsWith('{')) return null;
  let e: { type?: unknown; usage?: Record<string, unknown>; item?: { type?: unknown; text?: unknown } };
  try { e = JSON.parse(line) as typeof e; } catch { return null; }
  if (e.type === 'turn.completed' && e.usage && typeof e.usage === 'object') {
    const input = count(e.usage.input_tokens);
    const output = count(e.usage.output_tokens);
    if (input === null || output === null) return null;
    const cached = count(e.usage.cached_input_tokens);
    return { usage: { inputTokens: input, outputTokens: output, ...(cached ? { cachedInputTokens: cached } : {}) } };
  }
  if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') {
    return { finalMessage: normalizeCodexResult(e.item.text) };
  }
  return null;
}

/**
 * Final usage: the last `turn.completed` total (cumulative per thread). OpenAI counts cached input inside
 * `input_tokens` and reasoning inside `output_tokens`, so tokens = input + output.
 */
export function lastUsage(events: UsageEvent[]): { tokens: number; detail: Record<string, number> } | null {
  const last = events.at(-1);
  if (!last) return null;
  return {
    tokens: last.inputTokens + last.outputTokens,
    detail: { inputTokens: last.inputTokens, outputTokens: last.outputTokens, cachedInputTokens: last.cachedInputTokens ?? 0 },
  };
}
