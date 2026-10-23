/**
 * Role registry (docs/design/roles-and-workflows.md D3, D8, D9): the coordinator, the built-in workers
 * (engineer, tester, reviewer; customizable only through the D9 override fields) and the project roles
 * configured under `roles`. Every lookup of "is this a role, and what is it" goes through here.
 */
import type { ConfigIssue } from '../core/errors.js';
import {
  CAPABILITIES, EFFORTS, ROLES,
  type BuiltinRoleOverride, type Capability, type CustomRoleConfig, type Effect, type Effort, type MinionsConfig,
  type Role, type RoleContract, type RoleWorktree, type StageStatus,
} from './schema.js';

export const COORDINATOR_ROLE = 'coordinator';
export const ENGINEER_ROLE = 'engineer';
export const TESTER_ROLE = 'tester';
export const REVIEWER_ROLE = 'reviewer';
/** Built-in worker roles, in pipeline order. */
export const BUILTIN_WORKER_ROLES = [ENGINEER_ROLE, TESTER_ROLE, REVIEWER_ROLE] as const;
export type BuiltinWorkerRole = (typeof BUILTIN_WORKER_ROLES)[number];
/** Coordinator + built-in workers (same list as schema ROLES). */
export const BUILTIN_ROLES = ROLES;

export const isBuiltinWorkerRole = (name: string): name is BuiltinWorkerRole => (BUILTIN_WORKER_ROLES as readonly string[]).includes(name);
export const isBuiltinRole = (name: string): boolean => (BUILTIN_ROLES as readonly string[]).includes(name);

/** Project role names: lowercase, 2-31 chars (D3). */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
/** Plugin skill names; a role may not shadow them (`minions:<name>`). */
export const SKILL_NAMES = ['orchestrate', 'status', 'recover', 'intake', 'maintain-context'] as const;
export const DEEP_SUFFIX = '-deep';

/** Why `name` cannot be a project role, or null when it can. Built-in worker names are allowed (D9 overrides). */
export function roleNameProblem(name: string): string | null {
  if (!ROLE_NAME_PATTERN.test(name)) return `role name must match ${ROLE_NAME_PATTERN.source}`;
  if (name === COORDINATOR_ROLE) return 'the coordinator is not a configurable role';
  if (name.endsWith(DEEP_SUFFIX)) return `role name must not end in "${DEEP_SUFFIX}" (use deepVariant)`;
  if ((SKILL_NAMES as readonly string[]).includes(name)) return `"${name}" is a minions skill name`;
  return null;
}

/** Tools of the built-in worker definitions (templates/plugin/agents/*.md); overrides may only remove from these. */
export const BUILTIN_TOOLS: Record<BuiltinWorkerRole, readonly string[]> = {
  engineer: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
  tester: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
  reviewer: ['Read', 'Grep', 'Glob', 'Bash'],
};

/** Capabilities a project role is denied unless its column says otherwise (D8): workers never need them. */
export const CUSTOM_ROLE_DENY_BY_DEFAULT: readonly Capability[] = CAPABILITIES.filter((c) =>
  c === 'pr.merge' || c.startsWith('external.') || c === 'ci.edit' || c === 'infrastructure.edit' || c === 'deploy.execute');

export type RoleEdits = 'none' | 'any' | { paths: string[] };

/** A resolved worker role: defaults applied, the same shape for built-ins and project roles. */
export interface RoleDef {
  name: string;
  builtin: boolean;
  description: string;
  contract: RoleContract;
  worktree: RoleWorktree;
  stageStatus: StageStatus;
  edits: RoleEdits;
  commits: boolean;
  /** Frontmatter allowlist; undefined = the built-in template's own list. */
  tools?: string[];
  model?: string;
  effort?: Effort;
  maxTurns: number;
  deepVariant: boolean;
  requires: Capability[];
  /** The role's policy column (project roles only; built-ins use the hand-written capability table). */
  capabilities: Partial<Record<Capability, Effect>>;
  /** Prompt source: a file relative to the config dir and/or inline text (project roles), or the D9 append (built-ins). */
  prompt?: string;
  promptText?: string;
}

type RolesCfg = Partial<Pick<MinionsConfig, 'roles'>>;
type Entries = Record<string, unknown>;
const rolesOf = (cfg: RolesCfg): Entries => (cfg.roles ?? {}) as Entries;
/** Own-property lookup: never finds keys inherited from Object.prototype (`constructor`, `__proto__`, ...). */
const ownEntry = <T>(obj: Record<string, T> | undefined, key: string): T | undefined => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
const overrideOf = (cfg: RolesCfg, name: BuiltinWorkerRole): BuiltinRoleOverride | undefined => ownEntry(rolesOf(cfg), name) as BuiltinRoleOverride | undefined;

/** Configured project roles (not the built-in overrides), in config order. */
export function customRoles(cfg: RolesCfg): [string, CustomRoleConfig][] {
  return Object.entries(rolesOf(cfg)).filter(([n, v]) => !isBuiltinWorkerRole(n) && v !== undefined) as [string, CustomRoleConfig][];
}

const BUILTIN_DEFS: Record<BuiltinWorkerRole, Pick<RoleDef, 'description' | 'contract' | 'worktree' | 'stageStatus' | 'edits' | 'commits'>> = {
  engineer: { description: 'Implements a task on its branch.', contract: 'producer', worktree: 'branch', stageStatus: 'implementing', edits: 'any', commits: true },
  tester: { description: 'System-level QA of a task or the base branch.', contract: 'verifier', worktree: 'branch', stageStatus: 'testing', edits: 'any', commits: true },
  reviewer: { description: 'Reviews the exact head of a task; read-only.', contract: 'gate', worktree: 'review', stageStatus: 'reviewing', edits: 'none', commits: false },
};

const DEFAULT_STAGE_STATUS: Record<RoleContract, StageStatus> = { producer: 'implementing', verifier: 'testing', gate: 'reviewing' };

type DefCfg = RolesCfg & Pick<MinionsConfig, 'execution'>;

function builtinDef(cfg: DefCfg, name: BuiltinWorkerRole): RoleDef {
  const o = overrideOf(cfg, name);
  return {
    name, builtin: true, ...BUILTIN_DEFS[name],
    ...(o?.tools ? { tools: [...o.tools] } : {}),
    ...(o?.model ? { model: o.model } : {}),
    ...(o?.effort ? { effort: o.effort } : {}),
    maxTurns: o?.maxTurns ?? cfg.execution.attemptMaxTurns,
    deepVariant: name === ENGINEER_ROLE,
    requires: [], capabilities: {},
    ...(o?.prompt ? { prompt: o.prompt } : {}),
    ...(o?.promptAppend ? { promptText: o.promptAppend } : {}),
  };
}

function customDef(cfg: DefCfg, name: string, r: CustomRoleConfig): RoleDef {
  const worktree = r.worktree ?? (r.contract === 'gate' ? 'review' : 'branch');
  const edits: RoleEdits = worktree === 'review' ? 'none' : (r.edits ?? 'none');
  const commits = worktree === 'review' ? false : (r.commits ?? edits !== 'none');
  return {
    name, builtin: false, description: r.description, contract: r.contract, worktree,
    stageStatus: r.stageStatus ?? DEFAULT_STAGE_STATUS[r.contract],
    edits: typeof edits === 'string' ? edits : { paths: [...edits.paths] }, commits,
    ...(r.tools ? { tools: [...r.tools] } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
    maxTurns: r.maxTurns ?? cfg.execution.attemptMaxTurns,
    deepVariant: r.deepVariant ?? false,
    requires: [...(r.requires ?? [])],
    capabilities: { ...(r.capabilities ?? {}) },
    ...(r.prompt ? { prompt: r.prompt } : {}),
    ...(r.promptText ? { promptText: r.promptText } : {}),
  };
}

/** Worker roles of a config: the built-ins (with their overrides), then the project roles. */
export function roleRegistry(cfg: DefCfg): RoleDef[] {
  return [...BUILTIN_WORKER_ROLES.map((n) => builtinDef(cfg, n)), ...customRoles(cfg).map(([n, r]) => customDef(cfg, n, r))];
}

/** One worker role by name (`<name>-deep` resolves to its base role when it has a deep variant); undefined = not registered. */
export function workerRole(cfg: DefCfg, name: string): RoleDef | undefined {
  const base = baseRoleName(cfg, name);
  if (isBuiltinWorkerRole(base)) return builtinDef(cfg, base);
  const r = ownEntry(rolesOf(cfg), base) as CustomRoleConfig | undefined;
  return r && roleNameProblem(base) === null ? customDef(cfg, base, r) : undefined;
}

/** Every role name the registry knows: the coordinator, the built-in workers and the project roles. */
export function registeredRoleNames(cfg: RolesCfg): string[] {
  return [...BUILTIN_ROLES, ...customRoles(cfg).map(([n]) => n)];
}

/** Worker role names (built-ins first), i.e. the lease roles a config allows. */
export function workerRoleNames(cfg: RolesCfg): string[] {
  return [...BUILTIN_WORKER_ROLES, ...customRoles(cfg).map(([n]) => n)];
}

/** True for the coordinator, a built-in worker or a configured project role (exact name, no `-deep`). */
export function isRegisteredRole(cfg: RolesCfg, name: string): boolean {
  if (isBuiltinRole(name)) return true;
  return customRoles(cfg).some(([n]) => n === name) && roleNameProblem(name) === null;
}

/** Strips `-deep` when the base role has a deep variant (engineer always; project roles with deepVariant). */
export function baseRoleName(cfg: RolesCfg, name: string): string {
  if (!name.endsWith(DEEP_SUFFIX)) return name;
  const base = name.slice(0, -DEEP_SUFFIX.length);
  if (base === ENGINEER_ROLE) return base;
  const r = ownEntry(rolesOf(cfg), base) as CustomRoleConfig | undefined;
  return r && !isBuiltinWorkerRole(base) && r.deepVariant ? base : name;
}

/**
 * Concurrency limit of a worker role: `execution.maxByRole.<role>`, for the engineer also its alias
 * `execution.maxEngineers`; undefined = bounded only by maxActiveTasks.
 */
export function roleLimit(cfg: Pick<MinionsConfig, 'execution'>, role: Role): number | undefined {
  const byRole = ownEntry(cfg.execution.maxByRole, role);
  if (byRole !== undefined) return byRole;
  return role === ENGINEER_ROLE ? cfg.execution.maxEngineers : undefined;
}

/**
 * Effective reasoning effort of a role (D9): `roles.<r>.effort` > `models.effortByRole.<r>` (built-ins and the
 * coordinator) > `models.effort`; undefined = Claude Code default.
 */
export function roleEffort(cfg: Pick<MinionsConfig, 'models'> & RolesCfg, role: Role): Effort | undefined {
  const own = role === COORDINATOR_ROLE ? undefined : (ownEntry(rolesOf(cfg), role) as { effort?: Effort } | undefined)?.effort;
  const byRole = (BUILTIN_ROLES as readonly string[]).includes(role)
    ? cfg.models.effortByRole?.[role as (typeof BUILTIN_ROLES)[number]]
    : undefined;
  return own ?? byRole ?? cfg.models.effort;
}

/** Effort of `minions:engineer-deep`: roles.engineer.deepEffort > effortByRole.engineerDeep > one level above the engineer's (capped), else `high`. */
export function engineerDeepEffort(cfg: Pick<MinionsConfig, 'models'> & RolesCfg): Effort {
  const explicit = overrideOf(cfg, ENGINEER_ROLE)?.deepEffort ?? cfg.models.effortByRole?.engineerDeep;
  if (explicit) return explicit;
  const base = roleEffort(cfg, ENGINEER_ROLE);
  if (!base) return 'high';
  return EFFORTS[Math.min(EFFORTS.indexOf(base) + 1, EFFORTS.length - 1)]!;
}

export interface RoleSubRule { effect: Effect; roles: string[]; paths?: string[] }

/**
 * Sub-rules a project role's column adds to `capability` (D8): explicit column entries; else `deny` for
 * CUSTOM_ROLE_DENY_BY_DEFAULT; plus `deny` for code.edit / git.commit when `edits` is none / `commits` false.
 * Built-in and unknown roles get none (built-ins use the hand-written table; `can()` denies unknown roles).
 */
export function roleColumnRules(cfg: RolesCfg, role: string, capability: Capability): RoleSubRule[] {
  if (isBuiltinRole(role)) return [];
  const r = ownEntry(rolesOf(cfg), role) as CustomRoleConfig | undefined;
  if (!r || roleNameProblem(role) !== null) return [];
  const worktree = r.worktree ?? (r.contract === 'gate' ? 'review' : 'branch');
  const edits = worktree === 'review' ? 'none' : (r.edits ?? 'none');
  const commits = worktree === 'review' ? false : (r.commits ?? edits !== 'none');
  const out: RoleSubRule[] = [];
  const given = r.capabilities?.[capability];
  if (given) out.push({ effect: given, roles: [role] });
  else if (CUSTOM_ROLE_DENY_BY_DEFAULT.includes(capability)) out.push({ effect: 'deny', roles: [role] });
  if ((capability === 'code.edit' && edits === 'none') || (capability === 'git.commit' && !commits)) out.push({ effect: 'deny', roles: [role] });
  return out;
}

const isRelativePath = (p: string) => !/^(?:[A-Za-z]:)?[\\/]/.test(p) && !p.split(/[\\/]/).includes('..');

/** Cross-field checks of `roles`, role references in capability sub-rules and `execution.maxByRole` (run by validateConfig). */
export function roleConfigIssues(c: MinionsConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });
  const allowed = c.models.allowed;
  for (const [name, raw] of Object.entries(rolesOf(c))) {
    if (raw === undefined) continue;
    const at = `roles.${name}`;
    const problem = roleNameProblem(name);
    if (problem) { push(at, problem); continue; }
    const r = raw as Partial<CustomRoleConfig> & Partial<BuiltinRoleOverride>;
    if (r.model !== undefined && !allowed.includes(r.model)) push(`${at}.model`, `"${r.model}" is not in models.allowed [${allowed.join(', ')}]`);
    if (r.prompt !== undefined && !isRelativePath(r.prompt)) push(`${at}.prompt`, 'must be a path relative to the config directory, without ".."');
    if (isBuiltinWorkerRole(name)) {
      if (r.prompt !== undefined && r.promptAppend !== undefined) push(at, 'set at most one of prompt and promptAppend');
      const extra = (r.tools ?? []).filter((t) => !BUILTIN_TOOLS[name].includes(t));
      if (extra.length) push(`${at}.tools`, `may only remove tools from the built-in ${name} (${BUILTIN_TOOLS[name].join(', ')}); not built in: ${extra.join(', ')}`);
      continue;
    }
    if ((r.prompt === undefined) === (r.promptText === undefined)) push(at, 'set exactly one of prompt and promptText');
    const review = (r.worktree ?? (r.contract === 'gate' ? 'review' : 'branch')) === 'review';
    if (review && r.edits !== undefined && r.edits !== 'none') push(`${at}.edits`, 'a review worktree is read-only: edits must be "none"');
    if (review && r.commits === true) push(`${at}.commits`, 'a review worktree is read-only: commits must be false');
    if (!review && (r.edits ?? 'none') === 'none' && r.commits === true) push(`${at}.commits`, 'a role without edits cannot commit (set edits)');
  }
  const known = new Set(registeredRoleNames(c));
  for (const cap of CAPABILITIES) {
    const rule = c.capabilities[cap];
    if (typeof rule === 'string') continue;
    (rule.rules ?? []).forEach((sub, i) => {
      for (const role of sub.roles ?? []) {
        if (!known.has(role)) push(`capabilities.${cap}.rules.${i}.roles`, `unknown role "${role}" (known: ${[...known].join(', ')})`);
      }
    });
  }
  const { maxActiveTasks, maxEngineers, maxByRole } = c.execution;
  const workers = new Set(workerRoleNames(c));
  for (const [role, n] of Object.entries(maxByRole ?? {})) {
    if (!workers.has(role)) push(`execution.maxByRole.${role}`, `unknown worker role "${role}" (known: ${[...workers].join(', ')}; -deep variants count as their base role)`);
    else if (n > maxActiveTasks) push(`execution.maxByRole.${role}`, `must be <= execution.maxActiveTasks (${n} > ${maxActiveTasks})`);
  }
  const engineerByRole = maxByRole?.[ENGINEER_ROLE];
  if (maxEngineers !== undefined && engineerByRole !== undefined && maxEngineers !== engineerByRole) {
    push('execution.maxEngineers', `is an alias of execution.maxByRole.engineer and must agree with it (${maxEngineers} != ${engineerByRole}); set only maxByRole.engineer`);
  } else if (engineerByRole === undefined && maxEngineers !== undefined && maxEngineers > maxActiveTasks) {
    push('execution.maxEngineers', `must be <= execution.maxActiveTasks (${maxEngineers} > ${maxActiveTasks})`);
  }
  return issues;
}
