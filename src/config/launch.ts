/**
 * How the coordinator starts a stage (docs/design/agent-runtimes.md D1, D8): the `launch` entry of `minions work
 * next`. A Claude role is an Agent-tool spawn (`kind: "agent"`, unchanged behaviour); a role on a process harness is
 * claimed and then started with `minions work run <leaseId> --json` (`kind: "run"`; the runner is child task 3).
 */
import { HARNESSES, isProcessHarness, type ProcessHarnessId } from './harnesses.js';
import type { ModelSuggestion } from './models.js';
import { DEEP_SUFFIX, harnessRoleEffort, type RoleDef } from './roles.js';
import type { MinionsConfig } from './schema.js';

/** The runner command after claim; `<leaseId>` is the lease the claim returned. */
export const RUN_COMMAND_TEMPLATE = 'minions work run <leaseId> --json';
export const runCommand = (leaseId: string): string => RUN_COMMAND_TEMPLATE.replace('<leaseId>', leaseId);

export type Launch =
  | {
    kind: 'agent';
    /** The Agent `subagent_type`: `minions:<role>`, or `minions:<role>-deep`. */
    agentType: string;
    /** The Agent call's `model`: null = omit it. */
    agentModel: string | null;
  }
  | {
    kind: 'run';
    /** Run after `work claim`, with `<leaseId>` replaced (Bash, run_in_background), then record when it exits. */
    command: string;
    harness: ProcessHarnessId;
    /** Harness-native model id or alias (harnesses.<id>.models). */
    model: string;
    /** The harness's effort value (already mapped and clamped), or null = the harness default. */
    effort: string | null;
    /** The `-deep` effort is applied (false when not asked for, or the harness has no effort control). */
    deep: boolean;
    /** Set when `-deep` was suggested but the harness cannot honour it (D8). */
    note?: string;
  };

type LaunchCfg = Pick<MinionsConfig, 'models'> & Partial<Pick<MinionsConfig, 'roles' | 'harnesses'>>;

/** The launch entry for a stage of `def` with model suggestion `m`. */
export function launchFor(cfg: LaunchCfg, def: RoleDef, m: ModelSuggestion): Launch {
  if (!isProcessHarness(def.harness)) {
    return { kind: 'agent', agentType: `minions:${def.name}${m.deep ? DEEP_SUFFIX : ''}`, agentModel: m.agentModel };
  }
  const e = harnessRoleEffort(cfg, def, m.deep);
  return {
    kind: 'run', command: RUN_COMMAND_TEMPLATE, harness: def.harness, model: m.model, effort: e.native, deep: e.deepApplied,
    ...(m.deep && !e.deepApplied ? { note: `${HARNESSES[def.harness].label} has no effort control: the ${def.name}${DEEP_SUFFIX} suggestion runs like ${def.name}` } : {}),
  };
}
