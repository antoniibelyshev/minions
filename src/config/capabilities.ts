import { isRegisteredRole, roleColumnRules } from './roles.js';
import { CAPABILITIES, type Capability, type CapabilityRule, type Effect, type MinionsConfig, type Mode, type Role } from './schema.js';

export { CAPABILITIES };
export type { Capability, CapabilityRule, Effect, Role };

const RANK: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };
export const strictness = (e: Effect) => RANK[e];
export const stricter = (a: Effect, b: Effect): Effect => (RANK[a] >= RANK[b] ? a : b);

/** Paths whose change could take control of the agents or the owner's tooling: independent mode needs approval for them. */
export const INDEPENDENT_SENSITIVE_PATHS = ['.claude/**', '.minions/**', 'CLAUDE.md', 'AGENTS.md', '.githooks/**', '.husky/**', '.github/workflows/**'];

/** Supervised mode (the owner merges everything anyway). */
export const DEFAULT_SENSITIVE_PATHS = [
  '.github/workflows/**', '.github/CODEOWNERS', '.minions/**', '.claude/**',
  'CLAUDE.md', 'AGENTS.md', 'automation/**',
  'infra/**', 'infrastructure/**', 'deploy/**', 'terraform/**',
  '**/migrations/**',
];

/** Capabilities whose effect is upgraded allow→ask when a sensitive path is touched (the local integrator). */
export const LANDING_CAPABILITIES: Capability[] = ['base.merge'];

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
 * for the landing capability (base.merge).
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
  if (effect === 'allow' && LANDING_CAPABILITIES.includes(capability) && paths.some((p) => matchesAny(p, config.sensitivePaths))) {
    effect = 'ask';
  }
  return effect;
}

/** All effects appearing in a rule (base + sub-rules). */
export const ruleEffects = (r: CapabilityRule): Effect[] =>
  typeof r === 'string' ? [r] : [r.effect, ...(r.rules ?? []).map((x) => x.effect)];

type Table = Record<Capability, CapabilityRule>;

/**
 * Mode policy (docs/design/autonomy.md Decision 11): everything is allowed except deploying; reviewers never edit
 * code. Only landing on the base differs: independent lands approved work itself, supervised leaves it to the owner.
 */
export function defaultCapabilities(mode: Mode): Table {
  return {
    'task.read': 'allow', 'task.create': 'allow', 'task.update': 'allow', 'task.start': 'allow',
    'code.edit': { effect: 'allow', rules: [{ effect: 'deny', roles: ['reviewer'] }] },
    'dependencies.edit': 'allow', 'architecture.change': 'allow', 'migrations.edit': 'allow',
    'git.commit': 'allow',
    'base.merge': mode === 'independent' ? 'allow' : 'deny',
    'ci.edit': 'allow', 'infrastructure.edit': 'allow',
    'network.use': 'allow',
    'deploy.execute': 'deny',
  };
}
