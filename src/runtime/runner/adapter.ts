// Process-harness adapters (docs/design/agent-runtimes.md D1, D6). An adapter only translates: lease + role +
// config -> how to start the process (a pure `plan`), plus usage parsing. The lease, permission, isolation and
// git logic lives once in the runner (run.ts). Production adapters (Codex, Junie) are child tasks 4 and 5; this
// file defines the contract and the test-only `fake` adapter, which no config can select (the runner takes it
// only as an injected adapter).
import { isAbsolute } from 'node:path';
import { MinionsError } from '../../core/errors.js';

export interface LaunchInput {
  lease: { id: string; taskId: string; role: string; attempt: number };
  role: { name: string; contract: 'producer' | 'verifier' | 'gate'; edits: 'none' | 'any' | { paths: string[] }; commits: boolean };
  /** The per-lease clone `<scratch>/work`: the process cwd. Never the lease worktree. */
  checkout: string;
  /** The shared lease worktree, for reference only: the worker gets no access to it. */
  leaseWorktree: string;
  gitObjectsDir: string;
  scratchDir: string;
  harnessHome: string;
  instructions: string;
  briefFile: string;
  resultFile: string;
  model: string | null;
  effort: string | null;
  maxSteps: number;
  /** Path of the credential file the runner reads (the value never reaches the plan). */
  credential: { kind: string; file: string } | null;
}

export interface LaunchPlan {
  /** Never contains a secret (sandboxArgv refuses one). argv[0] is the executable. */
  argv: string[];
  /** Harness variables; the runner adds the allowlisted base env and refuses denied names. */
  env: Record<string, string>;
  /** env name -> credential kind, filled from the mounted secret file at spawn. */
  secretEnv: Record<string, string>;
  /** Per-lease files the runner writes before the spawn (only inside the scratch dir). */
  files: { path: string; content: string; mode: number }[];
  /** Prompt via stdin (keeps argv short and out of `ps`); null = stdin closed at once. */
  stdin: string | null;
}

export interface UsageEvent { inputTokens: number; outputTokens: number; cachedInputTokens?: number }

export interface ProcessAdapter {
  readonly id: string;
  plan(input: LaunchInput): LaunchPlan;
  /** One stdout line -> event (usage, the final message). */
  parseEvent?(line: string): { usage?: UsageEvent; finalMessage?: string } | null;
  /** Final usage after exit, from the collected events. */
  finalUsage?(events: UsageEvent[]): { tokens: number; detail: Record<string, number> } | null;
}

/** Sum of the usage events (the default for adapters that report per-turn deltas). */
export function sumUsage(events: UsageEvent[]): { tokens: number; detail: Record<string, number> } | null {
  if (!events.length) return null;
  const input = events.reduce((n, e) => n + e.inputTokens, 0);
  const output = events.reduce((n, e) => n + e.outputTokens, 0);
  const cached = events.reduce((n, e) => n + (e.cachedInputTokens ?? 0), 0);
  return { tokens: input + output, detail: { inputTokens: input, outputTokens: output, cachedInputTokens: cached } };
}

/** Env names a plan may never set: Claude, Anthropic, GitHub, git and Telegram variables (D3.5). */
const DENIED_ENV = /^(CLAUDE_|ANTHROPIC_|GIT_|GH_|GITHUB_|TELEGRAM_|SSH_|LD_|NODE_OPTIONS$|BASH_ENV$|ENV$)/;
export function checkPlanEnv(names: Iterable<string>): void {
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) || DENIED_ENV.test(n)) {
      throw new MinionsError('INTERNAL', `harness adapter plan sets a denied environment variable ${JSON.stringify(n.slice(0, 60))}`, 'This is a bug in the harness adapter.');
    }
  }
}

// ------------------------------------------------------------------------------------------------ fake adapter

/**
 * The test harness (D10): `test/fixtures/fake-harness.mjs`, a Node script driven by a scenario file. The
 * scenario is written into the harness home; usage arrives as `{"type":"usage",...}` JSONL on stdout, the final
 * message as `{"type":"final","text":...}`.
 */
export function fakeAdapter(opts: { script: string; scenario: unknown; node?: string; secretEnv?: Record<string, string> }): ProcessAdapter {
  if (!isAbsolute(opts.script)) throw new MinionsError('INTERNAL', 'fake adapter: the script path must be absolute');
  return {
    id: 'fake',
    plan(input) {
      const scenarioFile = `${input.harnessHome}/scenario.json`;
      return {
        argv: [opts.node ?? process.execPath, opts.script],
        env: { FAKE_SCENARIO: scenarioFile, FAKE_ROLE: input.role.name },
        secretEnv: opts.secretEnv ?? {},
        files: [{ path: scenarioFile, content: JSON.stringify(opts.scenario), mode: 0o600 }],
        stdin: input.instructions,
      };
    },
    parseEvent(line) {
      if (!line.startsWith('{')) return null;
      try {
        const e = JSON.parse(line) as { type?: string; input?: number; output?: number; cached?: number; text?: string };
        if (e.type === 'usage' && Number.isFinite(e.input) && Number.isFinite(e.output)) {
          return { usage: { inputTokens: e.input!, outputTokens: e.output!, ...(e.cached ? { cachedInputTokens: e.cached } : {}) } };
        }
        if (e.type === 'final' && typeof e.text === 'string') return { finalMessage: e.text };
      } catch { /* not an event */ }
      return null;
    },
    finalUsage: sumUsage,
  };
}
