import type { MinionsConfig } from './schema.js';

/**
 * Values the Agent tool accepts as `model` (Claude Code 2.1.292). Full model IDs such as `claude-opus-5-5`
 * are valid in agent frontmatter and `--model`, but an Agent call rejects them.
 */
export const AGENT_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

export const isAgentModelAlias = (m: string): boolean => (AGENT_MODEL_ALIASES as readonly string[]).includes(m);

/** Effort precedence lives with the role registry: roles.<r>.effort > models.effortByRole.<r> > models.effort (D9). */
export { engineerDeepEffort, roleEffort } from './roles.js';

/**
 * Agent aliases from cheapest to strongest, for the risk rule of `work next` (D12). `fable` is accepted by the
 * Agent tool but its tier is not documented, so the risk rule never picks it (it can still be a stage hint,
 * a role model or the default).
 */
export const MODEL_TIERS: readonly string[] = ['haiku', 'sonnet', 'opus'];

export const RISK_LOW_LABEL = 'risk:low';
export const RISK_HIGH_LABEL = 'risk:high';

/** What `suggestModel` needs to know about one stage. */
export interface ModelInput {
  /** The stage's `model` hint (D5). */
  stageModel?: string;
  /** `roles.<r>.model`: the model of the role's agent definition. */
  roleModel?: string;
  /** The stage role's contract variant (the risk:low rule applies to gate and verifier stages only). */
  contract: 'producer' | 'verifier' | 'gate';
  labels: readonly string[];
  /** Every configured stage of the task's workflow has a `model` hint (treated like risk:low for unhinted stages). */
  allHinted?: boolean;
  /** The role's previous attempt on this task failed (D12: a repair after a failed attempt). */
  repairAfterFailure?: boolean;
  /** The role has a `-deep` agent variant. */
  deepVariant: boolean;
}

export interface ModelSuggestion {
  /** The suggested model (an entry of models.allowed). */
  model: string;
  /**
   * What to pass as the Agent call's `model`: null = omit it (the agent definition already runs `model`, or
   * `model` is a full ID the Agent tool rejects), else the alias.
   */
  agentModel: string | null;
  /** Spawn the role's `-deep` variant (risk:high or a repair after a failed attempt, when the role has one). */
  deep: boolean;
  /** Which rule chose the model. */
  rule: 'fixed' | 'stage' | 'role' | 'risk-high' | 'repair-after-failure' | 'risk-low' | 'default';
}

type ModelsCfg = Pick<MinionsConfig, 'models'>;

/** The cheapest (`dir` 1) or strongest (`dir` -1) tiered alias in models.allowed, or undefined. */
function tierPick(cfg: ModelsCfg, dir: 1 | -1): string | undefined {
  const tiers = dir === 1 ? MODEL_TIERS : [...MODEL_TIERS].reverse();
  return tiers.find((m) => cfg.models.allowed.includes(m));
}

/**
 * The deterministic model suggestion of `work next` (docs/design/roles-and-workflows.md D12): stage `model` hint >
 * role `model` > risk rule > models.default. Risk rule: `risk:high` (it wins over `risk:low`) or a repair after a
 * failed attempt = the strongest allowed alias (and the `-deep` variant); `risk:low` or an all-hinted workflow =
 * the cheapest allowed alias for gate and verifier stages. With `models.selection` "fixed" the model is always
 * models.default (the `-deep` variant is an effort choice and still applies).
 */
export function suggestModel(cfg: ModelsCfg, x: ModelInput): ModelSuggestion {
  const high = x.labels.includes(RISK_HIGH_LABEL);
  const deep = x.deepVariant && (high || !!x.repairAfterFailure);
  const definition = x.roleModel ?? cfg.models.default;
  const out = (model: string, rule: ModelSuggestion['rule']): ModelSuggestion => ({
    model, rule, deep, agentModel: model === definition || !isAgentModelAlias(model) ? null : model,
  });
  if (cfg.models.selection === 'fixed') return { ...out(cfg.models.default, 'fixed'), agentModel: null };
  if (x.stageModel) return out(x.stageModel, 'stage');
  if (x.roleModel) return out(x.roleModel, 'role');
  if (high || x.repairAfterFailure) {
    const strongest = tierPick(cfg, -1);
    if (strongest) return out(strongest, high ? 'risk-high' : 'repair-after-failure');
  } else if ((x.labels.includes(RISK_LOW_LABEL) || x.allHinted) && x.contract !== 'producer') {
    const cheapest = tierPick(cfg, 1);
    if (cheapest) return out(cheapest, 'risk-low');
  }
  return out(cfg.models.default, 'default');
}
