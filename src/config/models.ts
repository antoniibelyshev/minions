import { EFFORTS, type Effort, type MinionsConfig, type Role } from './schema.js';

/**
 * Values the Agent tool accepts as `model` (Claude Code 2.1.292). Full model IDs such as `claude-opus-5-5`
 * are valid in agent frontmatter and `--model`, but an Agent call rejects them.
 */
export const AGENT_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

export const isAgentModelAlias = (m: string): boolean => (AGENT_MODEL_ALIASES as readonly string[]).includes(m);

/** Effective reasoning effort for a role: `models.effortByRole.<role>`, else `models.effort`; undefined = Claude Code default. */
export function roleEffort(cfg: Pick<MinionsConfig, 'models'>, role: Role): Effort | undefined {
  return cfg.models.effortByRole?.[role] ?? cfg.models.effort;
}

/** Effort of the `engineer-deep` definition: explicit, else one level above the engineer's (capped at `max`), else `high`. */
export function engineerDeepEffort(cfg: Pick<MinionsConfig, 'models'>): Effort {
  const explicit = cfg.models.effortByRole?.engineerDeep;
  if (explicit) return explicit;
  const base = roleEffort(cfg, 'engineer');
  if (!base) return 'high';
  return EFFORTS[Math.min(EFFORTS.indexOf(base) + 1, EFFORTS.length - 1)]!;
}
