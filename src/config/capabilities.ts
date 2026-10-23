import { isRegisteredRole, roleColumnRules } from './roles.js';
import { CAPABILITIES, type Capability, type CapabilityRule, type Effect, type MinionsConfig, type Profile, type Role } from './schema.js';

export { CAPABILITIES };
export type { Capability, CapabilityRule, Effect, Role };

const RANK: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };
export const strictness = (e: Effect) => RANK[e];
export const stricter = (a: Effect, b: Effect): Effect => (RANK[a] >= RANK[b] ? a : b);

/** Spec §14 defaults (`.agent-squad/**` is `.minions/**` here). */
export const DEFAULT_SENSITIVE_PATHS = [
  '.github/workflows/**', '.github/CODEOWNERS', '.minions/**', '.claude/**',
  'CLAUDE.md', 'AGENTS.md', 'automation/**',
  'infra/**', 'infrastructure/**', 'deploy/**', 'terraform/**',
  '**/migrations/**',
];

/** Capabilities whose effect is upgraded allow→ask when a sensitive path is touched. */
export const PUBLICATION_CAPABILITIES: Capability[] = ['git.push', 'pr.create', 'pr.merge'];

const globCache = new Map<string, RegExp>();
/** Minimal glob: `**` any depth (incl. zero dirs), `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; src += '(?:.*/)?'; } else src += '.*';
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  globCache.set(glob, re);
  return re;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
export const matchesAny = (path: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(norm(path)));

export interface CanContext { role?: Role; paths?: string[] }

/**
 * Evaluates a capability. A role that is not in the registry (coordinator, built-in workers, configured
 * `roles`) is denied everything. Deny anywhere (base or matching rule) wins; otherwise matching
 * role/path rules override the base (strictest among them); a project role's column (`roles.<r>.capabilities`
 * and its defaults, src/config/roles.ts) adds sub-rules for that role. Sensitive paths upgrade allow→ask
 * for publication capabilities.
 */
export function can(config: Pick<MinionsConfig, 'capabilities' | 'sensitivePaths'> & Partial<Pick<MinionsConfig, 'roles'>>, capability: Capability, ctx: CanContext = {}): Effect {
  if (ctx.role !== undefined && !isRegisteredRole(config, ctx.role)) return 'deny';
  const rule = config.capabilities[capability];
  const base: Effect = typeof rule === 'string' ? rule : rule.effect;
  const paths = ctx.paths ?? [];
  let effect = base;
  const rules = [...(typeof rule === 'string' ? [] : rule.rules ?? []), ...(ctx.role !== undefined ? roleColumnRules(config, ctx.role, capability) : [])];
  if (rules.length && base !== 'deny') {
    const matching = rules.filter((r) =>
      (!r.roles || (ctx.role !== undefined && r.roles.includes(ctx.role))) &&
      (!r.paths || paths.some((p) => matchesAny(p, r.paths!))));
    if (matching.length) effect = matching.map((r) => r.effect).reduce(stricter);
  }
  if (effect === 'allow' && PUBLICATION_CAPABILITIES.includes(capability) && paths.some((p) => matchesAny(p, config.sensitivePaths))) {
    effect = 'ask';
  }
  return effect;
}

/** All effects appearing in a rule (base + sub-rules). */
export const ruleEffects = (r: CapabilityRule): Effect[] =>
  typeof r === 'string' ? [r] : [r.effect, ...(r.rules ?? []).map((x) => x.effect)];

type Table = Record<Capability, CapabilityRule>;
// Workers that only verify or review must not edit code.
const noEditFor = (effect: Effect, roles: Role[]): CapabilityRule => ({ effect, rules: [{ effect: 'deny', roles }] });

const PROJECT_OWNER: Table = {
  'task.read': 'allow', 'task.create': 'allow', 'task.update': 'allow', 'task.start': 'allow',
  'external.read': 'allow', 'external.comment': 'ask', 'external.changeStatus': 'ask', 'external.create': 'ask',
  'code.edit': noEditFor('allow', ['reviewer']), 'dependencies.edit': 'allow', 'architecture.change': 'allow', 'migrations.edit': 'allow',
  'git.commit': 'allow', 'git.push': 'allow',
  'pr.create': 'allow', 'pr.review': 'allow', 'pr.merge': 'ask',
  'ci.edit': 'ask', 'infrastructure.edit': 'ask',
  'network.use': 'allow',
  'deploy.execute': 'deny',
};

const PERSONAL_WORK: Table = {
  ...PROJECT_OWNER,
  'external.comment': 'deny', 'external.changeStatus': 'deny', 'external.create': 'deny',
  'dependencies.edit': 'ask', 'architecture.change': 'ask', 'migrations.edit': 'ask',
  'git.push': 'ask', 'pr.create': 'ask', 'pr.review': 'ask', 'pr.merge': 'deny',
  'ci.edit': 'deny',
};

const SUPERVISED: Table = {
  ...PROJECT_OWNER,
  'dependencies.edit': 'ask', 'architecture.change': 'ask', 'migrations.edit': 'ask',
  'git.push': 'deny', 'pr.create': 'deny', 'pr.review': 'ask', 'pr.merge': 'deny',
};

export const DEFAULT_CAPABILITIES: Record<Profile, Table> = {
  'project-owner': PROJECT_OWNER, 'personal-work': PERSONAL_WORK, supervised: SUPERVISED,
};

export const defaultCapabilities = (profile: Profile): Table => structuredClone(DEFAULT_CAPABILITIES[profile]);
