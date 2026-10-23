/**
 * Values the Agent tool accepts as `model` (Claude Code 2.1.292). Full model IDs such as `claude-opus-5-5`
 * are valid in agent frontmatter and `--model`, but an Agent call rejects them.
 */
export const AGENT_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;

export const isAgentModelAlias = (m: string): boolean => (AGENT_MODEL_ALIASES as readonly string[]).includes(m);

/** Effort precedence lives with the role registry: roles.<r>.effort > models.effortByRole.<r> > models.effort (D9). */
export { engineerDeepEffort, roleEffort } from './roles.js';
