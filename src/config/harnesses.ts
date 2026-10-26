/**
 * Harness registry and phase rules (docs/design/agent-runtimes.md D1, D8, D9). A harness is the agent runtime a
 * worker role runs on: `claude` (in-session, spawned by the coordinator's Agent tool) or a process harness (a
 * separate OS process that `minions work run` starts; child task 3). This module is pure data plus lookups over the
 * config: no adapter code (plan, probe, usage parsing) lives here yet.
 *
 * Architecture decisions recorded here (task-14.2):
 * - The registry is a static list (claude, codex, junie). The test-only `fake` adapter (D6) lives with the runner
 *   (src/runtime/runner/adapter.ts) and is injected by tests only; config validation refuses it (not in the schema enum).
 * - Phase rules are code (D9), selected by CURRENT_PHASE. The owner picked phase 1 option (b): a process harness
 *   only for project gate roles. Option (a) keeps that allowance, so a `codex-reviewer` pilot config stays valid
 *   when the switch to (a) happens, and adds producer roles with the squad-wide cap of one.
 * - `harnesses.default` applies only to the roles the current phase allows on a process harness; every other
 *   role stays on Claude Code (D8 "In phase 1 it applies only to the roles the chosen phase 1 option allows").
 *   An explicit `roles.<r>.harness` that the phase does not allow is a config error instead.
 * - Effort keeps the minions scale (EFFORTS) in config and is mapped onto the harness scale at launch, clamped to
 *   the harness's strongest level (Codex `model_reasoning_effort`, Junie `--effort low|medium|high`).
 */
import type { Effort, MinionsConfig, ProcessHarnessConfig, RoleContract } from './schema.js';

/** Harness ids a config may name (`harnesses.default`, `roles.<r>.harness`). */
export const HARNESS_IDS = ['claude', 'codex', 'junie'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
/** Harnesses that run as a separate process and need a `harnesses.<id>` block. */
export const PROCESS_HARNESS_IDS = ['codex', 'junie'] as const;
export type ProcessHarnessId = (typeof PROCESS_HARNESS_IDS)[number];
export const DEFAULT_HARNESS: HarnessId = 'claude';
/** Wall clock per process-harness attempt when `harnesses.<id>.timeoutMinutes` is unset (D3.6). */
export const DEFAULT_HARNESS_TIMEOUT_MINUTES = 60;

/** What a harness can do (D1 HarnessCapabilities). */
export interface HarnessCapabilities {
  launch: 'in-session' | 'process';
  /** What the harness would use on its own; minions does not rely on it (L1 is the boundary, D4). */
  nativeSandbox: 'none' | 'bwrap' | 'srt' | 'seatbelt';
  /** A schema-conformant final answer (e.g. `codex exec --output-schema`). */
  structuredFinalOutput: boolean;
  usageEvents: 'jsonl' | 'session-file' | 'notification' | 'none';
  /** A documented per-run step/turn limit. */
  maxSteps: boolean;
  /** A reasoning-effort control. Without one, `-deep` runs like the base role (D8). */
  effort: boolean;
}

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  capabilities: HarnessCapabilities;
  /** minions effort -> the harness's own effort value; null when the harness has no effort control. */
  effortMap: Readonly<Record<Effort, string>> | null;
}

/** The static harness registry (D1, D6). Capability flags follow the evaluations in the design doc. */
export const HARNESSES: Readonly<Record<HarnessId, HarnessInfo>> = {
  claude: {
    id: 'claude', label: 'Claude Code',
    capabilities: { launch: 'in-session', nativeSandbox: 'srt', structuredFinalOutput: false, usageEvents: 'notification', maxSteps: true, effort: true },
    effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  },
  codex: {
    id: 'codex', label: 'OpenAI Codex CLI',
    // U-C1: no documented per-run step limit (the runner uses the wall clock).
    capabilities: { launch: 'process', nativeSandbox: 'bwrap', structuredFinalOutput: true, usageEvents: 'jsonl', maxSteps: false, effort: true },
    // `-c model_reasoning_effort=<v>`; Codex's strongest level is xhigh, so `max` clamps to it (child task 4 re-checks the pinned version).
    effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' },
  },
  junie: {
    id: 'junie', label: 'JetBrains Junie CLI',
    capabilities: { launch: 'process', nativeSandbox: 'srt', structuredFinalOutput: false, usageEvents: 'session-file', maxSteps: true, effort: true },
    // `--effort low|medium|high`, clamped to high (D8).
    effortMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' },
  },
};

export const isHarnessId = (v: unknown): v is HarnessId => typeof v === 'string' && (HARNESS_IDS as readonly string[]).includes(v);
export const harnessInfo = (id: HarnessId): HarnessInfo => HARNESSES[id];
export const isProcessHarness = (id: HarnessId): id is ProcessHarnessId => HARNESSES[id].capabilities.launch === 'process';

/** The harness's value for a minions effort level, or null when the harness has no effort control. */
export function nativeEffort(id: HarnessId, effort: Effort): string | null {
  const info = HARNESSES[id];
  return info.capabilities.effort && info.effortMap ? info.effortMap[effort] : null;
}

type HarnessCfg = Partial<Pick<MinionsConfig, 'harnesses'>> & Pick<MinionsConfig, 'models'>;

/** The `harnesses.<id>` block of a process harness, or undefined. */
export function harnessBlock(cfg: Partial<Pick<MinionsConfig, 'harnesses'>>, id: HarnessId): ProcessHarnessConfig | undefined {
  return isProcessHarness(id) ? cfg.harnesses?.[id] : undefined;
}

/**
 * Model ids a role on `id` may use: top-level `models` for claude (unchanged), `harnesses.<id>.models` otherwise.
 * Undefined when a process harness has no block (validateConfig reports that).
 */
export function harnessModels(cfg: HarnessCfg, id: HarnessId): { default: string; allowed: string[] } | undefined {
  if (!isProcessHarness(id)) return { default: cfg.models.default, allowed: cfg.models.allowed };
  return harnessBlock(cfg, id)?.models;
}

// ---------------------------------------------------------------------------------------------------------
// Phase rules (D9).

export type PhaseId = '1a' | '1b' | '2';

/** Which roles may run on a process harness: by contract, project roles only or built-ins as well. */
export interface ProcessAllowance { contract: RoleContract; roles: 'project' | 'all' }

export interface PhaseRules {
  id: PhaseId;
  summary: string;
  process: readonly ProcessAllowance[];
  /** Active producer leases on a process harness, squad-wide; null = no cap. Enforced by claim and `work next`. */
  processProducerCap: number | null;
}

/** Phase 1 cap on concurrent process-harness producer leases (D9 option a). */
export const PHASE1_PROCESS_PRODUCER_CAP = 1;

export const PHASE_RULES: Readonly<Record<PhaseId, PhaseRules>> = {
  '1b': {
    id: '1b', summary: 'phase 1, option (b): a process harness only for project gate roles (read-only reviewer pilot, e.g. codex-reviewer)',
    process: [{ contract: 'gate', roles: 'project' }],
    processProducerCap: PHASE1_PROCESS_PRODUCER_CAP,
  },
  '1a': {
    id: '1a', summary: `phase 1, option (a): a process harness for producer roles (at most ${PHASE1_PROCESS_PRODUCER_CAP} active squad-wide) and project gate roles`,
    process: [{ contract: 'producer', roles: 'all' }, { contract: 'gate', roles: 'project' }],
    processProducerCap: PHASE1_PROCESS_PRODUCER_CAP,
  },
  '2': {
    id: '2', summary: 'phase 2: a process harness for producer, verifier and gate roles',
    process: [{ contract: 'producer', roles: 'all' }, { contract: 'verifier', roles: 'all' }, { contract: 'gate', roles: 'all' }],
    processProducerCap: null,
  },
};

/** The phase this build enforces. The owner chose phase 1 option (b) (task-14.2); child tasks switch it. */
export const CURRENT_PHASE: PhaseRules = PHASE_RULES['1b'];

/** Whether `role` may run on harness `id` in `phase`. Claude (in-session) is always allowed for worker roles. */
export function phaseAllows(id: HarnessId, role: { contract: RoleContract; builtin: boolean }, phase: PhaseRules = CURRENT_PHASE): boolean {
  if (!isProcessHarness(id)) return true;
  return phase.process.some((a) => a.contract === role.contract && (a.roles === 'all' || !role.builtin));
}

/** The harness a worker role runs on: its own `harness`, else `harnesses.default` when the phase allows it, else claude. */
export function resolveRoleHarness(
  cfg: Partial<Pick<MinionsConfig, 'harnesses'>>, role: { contract: RoleContract; builtin: boolean; harness?: HarnessId }, phase: PhaseRules = CURRENT_PHASE,
): HarnessId {
  if (role.harness) return role.harness;
  const d = cfg.harnesses?.default ?? DEFAULT_HARNESS;
  return phaseAllows(d, role, phase) ? d : DEFAULT_HARNESS;
}
