/**
 * Role registry (docs/design/roles-and-workflows.md D3, D8, D9): the coordinator, the built-in workers
 * (engineer, tester, reviewer; customizable only through the D9 override fields) and the project roles
 * configured under `roles`. Every lookup of "is this a role, and what is it" goes through here.
 */
import type { ConfigIssue } from '../core/errors.js';
import {
  CURRENT_PHASE, HARNESSES, PROCESS_HARNESS_IDS, harnessBlock, harnessModels, isProcessHarness, phaseAllows, resolveRoleHarness,
  type HarnessId, type PhaseRules,
} from './harnesses.js';
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
/**
 * Evidence kinds the runtime records next to role evidence (`evidence.kind` is the lease role otherwise): a
 * role with one of these names would be confused with them (src/runtime/scheduler.ts passedAt).
 */
export const RESERVED_EVIDENCE_KINDS = ['check', 'ci-gate'] as const;

/** Why `name` cannot be a project role, or null when it can. Built-in worker names are allowed (D9 overrides). */
export function roleNameProblem(name: string): string | null {
  if (!ROLE_NAME_PATTERN.test(name)) return `role name must match ${ROLE_NAME_PATTERN.source}`;
  if (name === COORDINATOR_ROLE) return 'the coordinator is not a configurable role';
  if ((RESERVED_EVIDENCE_KINDS as readonly string[]).includes(name)) return `"${name}" is reserved (an evidence kind of the runtime)`;
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
  /** Agent runtime (docs/design/agent-runtimes.md D8): own `harness` > harnesses.default where the phase allows it > claude. */
  harness: HarnessId;
  requires: Capability[];
  /** The role's policy column (project roles only; built-ins use the hand-written capability table). */
  capabilities: Partial<Record<Capability, Effect>>;
  /** Prompt source: a file relative to the config dir and/or inline text (project roles), or the D9 append (built-ins). */
  prompt?: string;
  promptText?: string;
}

type RolesCfg = Partial<Pick<MinionsConfig, 'roles' | 'harnesses'>>;
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
    harness: resolveRoleHarness(cfg, { contract: BUILTIN_DEFS[name].contract, builtin: true, ...(o?.harness ? { harness: o.harness } : {}) }),
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
    harness: resolveRoleHarness(cfg, { contract: r.contract, builtin: false, ...(r.harness ? { harness: r.harness } : {}) }),
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
export function roleEffort(cfg: Pick<MinionsConfig, 'models'> & RolesCfg, role: Role, harnessDefault?: Effort): Effort | undefined {
  const own = role === COORDINATOR_ROLE ? undefined : (ownEntry(rolesOf(cfg), role) as { effort?: Effort } | undefined)?.effort;
  const byRole = (BUILTIN_ROLES as readonly string[]).includes(role)
    ? cfg.models.effortByRole?.[role as (typeof BUILTIN_ROLES)[number]]
    : undefined;
  // `harnessDefault`: harnesses.<id>.effort of a role on a process harness, between the role's own and models.effort.
  return own ?? byRole ?? harnessDefault ?? cfg.models.effort;
}

const oneAbove = (e: Effort): Effort => EFFORTS[Math.min(EFFORTS.indexOf(e) + 1, EFFORTS.length - 1)]!;

/** Effort of `minions:engineer-deep`: roles.engineer.deepEffort > effortByRole.engineerDeep > one level above the engineer's (capped), else `high`. */
export function engineerDeepEffort(cfg: Pick<MinionsConfig, 'models'> & RolesCfg, harnessDefault?: Effort): Effort {
  const explicit = overrideOf(cfg, ENGINEER_ROLE)?.deepEffort ?? cfg.models.effortByRole?.engineerDeep;
  if (explicit) return explicit;
  const base = roleEffort(cfg, ENGINEER_ROLE, harnessDefault);
  return base ? oneAbove(base) : 'high';
}

/**
 * Effort of a role's `-deep` variant: the engineer's from engineerDeepEffort; a project role's is one level
 * above its own effort (capped), else `high`.
 */
export function deepVariantEffort(cfg: Pick<MinionsConfig, 'models'> & RolesCfg, role: string, harnessDefault?: Effort): Effort {
  if (role === ENGINEER_ROLE) return engineerDeepEffort(cfg, harnessDefault);
  const base = roleEffort(cfg, role, harnessDefault);
  return base ? oneAbove(base) : 'high';
}

/** The effort a role runs at on its harness (agent-runtimes D8), base or `-deep`. */
export interface HarnessEffort {
  /** minions scale (EFFORTS); undefined = the harness's own default. */
  effort: Effort | undefined;
  /** The harness's value for `effort` (Codex model_reasoning_effort, Junie --effort, clamped); null = none passed. */
  native: string | null;
  /** False when `-deep` was asked for but the harness has no effort control: it runs like the base role. */
  deepApplied: boolean;
}

/**
 * Effort of `role` on its harness. Precedence as for Claude, with `harnesses.<id>.effort` before models.effort for a
 * process harness; `-deep` is engineerDeepEffort / deepVariantEffort on the same precedence, mapped onto the
 * harness's scale. A harness without effort control runs `-deep` like the base role.
 */
export function harnessRoleEffort(cfg: Pick<MinionsConfig, 'models'> & RolesCfg, def: Pick<RoleDef, 'name' | 'harness' | 'deepVariant'>, deep: boolean): HarnessEffort {
  const info = HARNESSES[def.harness];
  const harnessDefault = harnessBlock(cfg, def.harness)?.effort;
  const wantDeep = deep && def.deepVariant;
  if (!info.capabilities.effort || !info.effortMap) return { effort: undefined, native: null, deepApplied: false };
  const effort = wantDeep ? deepVariantEffort(cfg, def.name, harnessDefault) : roleEffort(cfg, def.name, harnessDefault);
  return { effort, native: effort ? info.effortMap[effort] : null, deepApplied: wantDeep };
}

/**
 * The worker role a `minions:<agent>` type runs as (D10): `<name>` for every registered worker role and
 * `<name>-deep` only when the role has a deep variant. Undefined for anything else (the coordinator,
 * unknown names, prototype keys, `-deep` of a role without one).
 */
export function agentTypeRole(cfg: DefCfg, agentType: string): RoleDef | undefined {
  const m = /^minions:([a-z][a-z0-9-]{0,40})$/.exec(agentType);
  if (!m) return undefined;
  const name = m[1]!;
  const def = workerRole(cfg, name);
  if (!def) return undefined;
  if (name === def.name) return def;
  return def.deepVariant && name === `${def.name}${DEEP_SUFFIX}` ? def : undefined;
}

/** The registered worker role named exactly `name` (no `-deep`), else undefined: what `work claim|brief|submit --role` accept. */
export function exactWorkerRole(cfg: DefCfg, name: string): RoleDef | undefined {
  const def = workerRole(cfg, name);
  return def && def.name === name ? def : undefined;
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

/** Where a harness's allowed models live in the config, for messages. */
export const modelsPath = (h: HarnessId): string => (isProcessHarness(h) ? `harnesses.${h}.models.allowed` : 'models.allowed');

/**
 * Cross-field checks of `harnesses` and `roles.<r>.harness` (agent-runtimes D8, D9; run by validateConfig): a
 * referenced process harness needs its block, a harness's default model is one of its allowed models, the
 * coordinator never takes a harness, and an explicit role harness must be allowed by the phase rules. Port range
 * and the non-empty tcpConnectPorts list are schema checks. `phase` is a parameter for tests of later phases.
 */
export function harnessConfigIssues(c: MinionsConfig, phase: PhaseRules = CURRENT_PHASE): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });
  const missingBlock = (h: HarnessId) => isProcessHarness(h) && !harnessBlock(c, h);
  const needsBlock = (h: HarnessId) => `harness "${h}" has no harnesses.${h} block (set at least its models: {default, allowed})`;
  const d = c.harnesses?.default;
  if (d && missingBlock(d)) push('harnesses.default', needsBlock(d));
  for (const id of PROCESS_HARNESS_IDS) {
    const m = harnessBlock(c, id)?.models;
    if (m && !m.allowed.includes(m.default)) push(`harnesses.${id}.models.default`, `"${m.default}" is not in harnesses.${id}.models.allowed [${m.allowed.join(', ')}]`);
  }
  for (const [name, raw] of Object.entries(rolesOf(c))) {
    const h = (raw as { harness?: HarnessId } | undefined)?.harness;
    if (h === undefined) continue;
    const at = `roles.${name}.harness`;
    if (name === COORDINATOR_ROLE) { push(at, 'the coordinator always runs on Claude Code; it cannot be assigned a harness (agent-runtimes D9 phase 3)'); continue; }
    const def = roleNameProblem(name) === null ? workerRole(c, name) : undefined;
    if (!def) continue;
    if (missingBlock(h)) push(at, needsBlock(h));
    if (!phaseAllows(h, def, phase)) {
      push(at, `${phase.summary}; ${def.builtin ? 'the built-in' : 'project'} ${def.contract} role ${name} must stay on claude`);
    }
  }
  // A gate on a process harness is read-only towards the squad (D9 phase 2 note, D3.7.4: nothing is fetched back),
  // whether its own `harness` or harnesses.default put it there.
  for (const def of roleRegistry(c)) {
    if (def.contract !== 'gate' || roleNameProblem(def.name) !== null) continue;
    const own = ownHarness(c, def.name);
    const h = phaseRoleHarness(c, def, own, phase);
    if (!isProcessHarness(h)) continue;
    const via = own ? `roles.${def.name}.harness puts` : 'harnesses.default puts';
    const why = (what: string) => `${via} the gate role ${def.name} on harness ${h}; a gate on a process harness is read-only: ${what} (or set roles.${def.name}.harness to claude)`;
    if (def.worktree === 'branch') push(`roles.${def.name}.worktree`, why('its worktree must be "review"'));
    if (def.edits !== 'none') push(`roles.${def.name}.edits`, why('edits must be "none"'));
    if (def.commits) push(`roles.${def.name}.commits`, why('commits must be false'));
  }
  return issues;
}

/** A role's own `roles.<r>.harness` (not harnesses.default), or undefined. */
function ownHarness(c: RolesCfg, name: string): HarnessId | undefined {
  return (ownEntry(rolesOf(c), name) as { harness?: HarnessId } | undefined)?.harness;
}

/** `def`'s harness under `phase` (RoleDef.harness is resolved for CURRENT_PHASE). */
function phaseRoleHarness(c: RolesCfg, def: RoleDef, own: HarnessId | undefined, phase: PhaseRules): HarnessId {
  return resolveRoleHarness(c, { contract: def.contract, builtin: def.builtin, ...(own ? { harness: own } : {}) }, phase);
}

/**
 * Gate roles that `harnesses.default` (not their own `harness`) moves onto a process harness. Config validation has
 * no warning channel, so `minions work next` lists these as warnings: a squad-wide default silently changing where an
 * existing gate runs should be visible. Empty for Claude-only configs.
 */
export function defaultMovedGates(c: DefCfg, phase: PhaseRules = CURRENT_PHASE): { role: string; harness: HarnessId }[] {
  const out: { role: string; harness: HarnessId }[] = [];
  for (const def of roleRegistry(c)) {
    if (def.contract !== 'gate' || roleNameProblem(def.name) !== null || ownHarness(c, def.name)) continue;
    const h = phaseRoleHarness(c, def, undefined, phase);
    if (isProcessHarness(h)) out.push({ role: def.name, harness: h });
  }
  return out;
}

const isRelativePath = (p: string) => !/^(?:[A-Za-z]:)?[\\/]/.test(p) && !p.split(/[\\/]/).includes('..');

/** Cross-field checks of `roles`, role references in capability sub-rules and `execution.maxByRole` (run by validateConfig). */
export function roleConfigIssues(c: MinionsConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });
  for (const [name, raw] of Object.entries(rolesOf(c))) {
    if (raw === undefined) continue;
    const at = `roles.${name}`;
    const problem = roleNameProblem(name);
    if (problem) { push(at, problem); continue; }
    const r = raw as Partial<CustomRoleConfig> & Partial<BuiltinRoleOverride>;
    // The role model is validated against the role's harness (agent-runtimes D8); a missing harness block is
    // reported by harnessConfigIssues.
    const harness = workerRole(c, name)?.harness ?? 'claude';
    const models = harnessModels(c, harness);
    if (r.model !== undefined && models && !models.allowed.includes(r.model)) push(`${at}.model`, `"${r.model}" is not in ${modelsPath(harness)} [${models.allowed.join(', ')}]`);
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
