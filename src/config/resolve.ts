import { MinionsError, invalidConfig, zodIssues, type ConfigIssue } from '../core/errors.js';
import { CAPABILITIES, can, ruleEffects, stricter, strictness } from './capabilities.js';
import { autoMergeConfigReasons } from './delivery.js';
import { ENGINEER_ROLE, harnessConfigIssues, registeredRoleNames, roleConfigIssues, roleLimit } from './roles.js';
import { workflowConfigIssues } from './workflows.js';
import { MinionsConfigSchema, CapabilityRuleSchema, type Capability, type CapabilityRule, type MinionsConfig } from './schema.js';

export const SUPPORTED = {
  backlog: ['backlogmd'],
  communication: ['terminal', 'telegram', 'auto'],
} as const;

/** Features deferred in v0.1; doctor and the wizard report them as unavailable. */
export const DEFERRED_FEATURES = [
  'config plan/apply transactions', 'backlog migration', 'upgrade plan and schema migration',
  'companion containers', 'shared backlog versioned in Git',
] as const;

export interface Unavailable { path: string; value: unknown; reason: string }

/** Settings in a (valid) config that this build cannot honour. */
export function listUnavailable(config: MinionsConfig): Unavailable[] {
  const out: Unavailable[] = [];
  const has = (list: readonly string[], v: string) => list.includes(v);
  if (!has(SUPPORTED.backlog, config.backlog.backend)) out.push({ path: 'backlog.backend', value: config.backlog.backend, reason: 'only Backlog.md is supported in v0.1' });
  if (!has(SUPPORTED.communication, config.communication.channel)) out.push({ path: 'communication.channel', value: config.communication.channel, reason: 'this communication channel is not supported in v0.1' });
  if (config.communication.channel === 'telegram' && config.container.network === 'none') {
    out.push({ path: 'communication.channel', value: 'telegram', reason: 'Telegram needs outbound network (api.telegram.org, and the npm registry for the plugin\'s dependencies) but container.network is none; the coordinator runs terminal-only' });
  }
  if (config.delivery.merge === 'auto-when-eligible') {
    const why = autoMergeConfigReasons(config);
      if (why.length) out.push({ path: 'delivery.merge', value: config.delivery.merge, reason: `local integration is unavailable: ${why.join('; ')}` });
  }
  return out;
}

function crossFieldIssues(c: MinionsConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (!(SUPPORTED.backlog as readonly string[]).includes(c.backlog.backend)) issues.push({ path: 'backlog.backend', message: `"${c.backlog.backend}" is not supported by this build (supported: ${SUPPORTED.backlog.join(', ')})` });
  if (!(SUPPORTED.communication as readonly string[]).includes(c.communication.channel)) issues.push({ path: 'communication.channel', message: `"${c.communication.channel}" is not supported by this build (supported: ${SUPPORTED.communication.join(', ')})` });
  if (!c.models.allowed.includes(c.models.default)) issues.push({ path: 'models.default', message: `"${c.models.default}" is not in models.allowed [${c.models.allowed.join(', ')}]` });
  if (c.models.coordinator !== undefined && !c.models.allowed.includes(c.models.coordinator)) issues.push({ path: 'models.coordinator', message: `"${c.models.coordinator}" is not in models.allowed [${c.models.allowed.join(', ')}]` });
  if (c.models.router !== undefined && !c.models.allowed.includes(c.models.router)) issues.push({ path: 'models.router', message: `"${c.models.router}" is not in models.allowed [${c.models.allowed.join(', ')}]` });
  if (c.container.mountDockerSocket) issues.push({ path: 'container.mountDockerSocket', message: 'must be false: the Docker socket grants host control' });
  if (c.container.mountHostRepository) issues.push({ path: 'container.mountHostRepository', message: 'must be false: the workspace lives in a named volume' });
  // roles, role references in capability sub-rules, execution.maxByRole / maxEngineers (incl. <= maxActiveTasks).
  issues.push(...roleConfigIssues(c));
  // harnesses blocks, roles.<r>.harness and the phase rules (docs/design/agent-runtimes.md D8, D9).
  issues.push(...harnessConfigIssues(c));
  // workflows (D5 invariants 1-2, stage model hints) and roles.<r>.repairTo.
  issues.push(...workflowConfigIssues(c));
  return issues;
}

/**
 * Removed keys, accepted in any layer and dropped: the GitHub delivery (docs/design/autonomy.md Decision 8) and the
 * dispatch mode (Decision 10; `coordinator.contextReset.barrierTokens` below).
 */
const LEGACY_KEYS: Record<string, readonly string[]> = {
  backlog: ['repository'],
  intake: ['github'],
  delivery: ['provider', 'mode', 'method', 'deleteMergedBranches', 'identityMode', 'requireIndependentApproval', 'requiredChecksConfigured'],
  verification: ['ciAuthority', 'ciPendingTimeoutMinutes'],
  capabilities: ['git.push', 'pr.create', 'pr.review', 'pr.merge'],
  dispatch: ['mode'],
};

/**
 * A copy of a config (or a layer of one) without the legacy keys. delivery.merge "manual" (never implemented) becomes
 * "disabled", and so does an "auto-when-eligible" that meant GitHub auto-merge (delivery.mode branch or pull-request):
 * it never switches local integration on by itself. Anything that is not an object is returned as is.
 */
export function stripLegacyKeys(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  const out: Obj = { ...raw };
  for (const [section, keys] of Object.entries(LEGACY_KEYS)) {
    const sec = out[section];
    if (!isObj(sec) || !(keys.some((k) => k in sec) || (section === 'delivery' && sec.merge === 'manual'))) continue;
    const next: Obj = { ...sec };
    for (const k of keys) delete next[k];
    if (section === 'delivery' && (next.merge === 'manual' || (next.merge === 'auto-when-eligible' && typeof sec.mode === 'string' && sec.mode !== 'local'))) next.merge = 'disabled';
    out[section] = next;
  }
  if (isObj(out.backlog) && out.backlog.backend === 'github') out.backlog = { ...out.backlog, backend: 'backlogmd' };
  const reset = isObj(out.coordinator) ? out.coordinator.contextReset : undefined;
  if (isObj(reset) && 'barrierTokens' in reset) {
    const { barrierTokens: _b, ...rest } = reset;
    out.coordinator = { ...(out.coordinator as Obj), contextReset: rest };
  }
  // Project roles name capabilities too: their policy column and `requires`.
  const legacyCap = (c: unknown) => LEGACY_KEYS.capabilities!.includes(c as string);
  if (isObj(out.roles)) {
    out.roles = Object.fromEntries(Object.entries(out.roles).map(([name, r]) => {
      if (!isObj(r)) return [name, r];
      const next: Obj = { ...r };
      if (isObj(r.capabilities)) next.capabilities = Object.fromEntries(Object.entries(r.capabilities).filter(([c]) => !legacyCap(c)));
      if (Array.isArray(r.requires)) next.requires = r.requires.filter((c) => !legacyCap(c));
      return [name, next];
    }));
  }
  return out;
}

/** Strict schema parse (after stripLegacyKeys) + cross-field checks. Throws INVALID_CONFIG listing dotted paths. */
export function validateConfig(raw: unknown, source?: string): MinionsConfig {
  const r = MinionsConfigSchema.safeParse(stripLegacyKeys(raw));
  if (!r.success) throw invalidConfig(zodIssues(r.error.issues), source);
  const issues = crossFieldIssues(r.data);
  if (issues.length) throw invalidConfig(issues, source);
  return r.data;
}

export type Source = 'default' | 'project' | 'local' | 'control' | 'session';
export interface EffectiveConfig { config: MinionsConfig; provenance: Record<string, Source> }
export interface ResolveInput {
  defaults: MinionsConfig;
  project?: unknown;
  local?: unknown;
  /** In-memory, non-persistent; may only narrow. */
  session?: unknown;
  /** Labels used in error messages (e.g. file paths). */
  sources?: Partial<Record<Source, string>>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leaves: non-objects, arrays, and individual capability entries. */
function walk(v: unknown, path: string[], fn: (path: string[], v: unknown) => void): void {
  if (isObj(v) && !(path.length === 2 && path[0] === 'capabilities')) {
    for (const [k, x] of Object.entries(v)) walk(x, [...path, k], fn);
  } else if (path.length) fn(path, v);
}

/** Deep merge; arrays and capability entries replace. Records provenance for overlay leaves. */
function overlay(base: Obj, layer: unknown, source: Source, prov: Record<string, Source>, label: string): Obj {
  if (layer === undefined) return base;
  if (!isObj(layer)) throw invalidConfig([{ path: '', message: 'must be a JSON object' }], label);
  const out = structuredClone(base);
  walk(layer, [], (path, v) => {
    let cur: Obj = out;
    for (const k of path.slice(0, -1)) {
      if (!isObj(cur[k])) cur[k] = {};
      cur = cur[k] as Obj;
    }
    cur[path.at(-1)!] = structuredClone(v);
    // Drop provenance of anything the new leaf replaced.
    const key = path.join('.');
    for (const p of Object.keys(prov)) if (p.startsWith(key + '.')) delete prov[p];
    prov[key] = source;
  });
  syncEngineerAlias(out, layer, source, prov);
  return out;
}

/**
 * execution.maxEngineers is an alias of execution.maxByRole.engineer: a layer that sets only one of them
 * replaces the other one inherited from lower layers, so e.g. a project that writes maxByRole.engineer is not
 * contradicted by the maxEngineers of the defaults. Within one layer both may be set; validation then
 * requires them to agree.
 */
function syncEngineerAlias(out: Obj, layer: Obj, source: Source, prov: Record<string, Source>): void {
  const ex = isObj(layer.execution) ? layer.execution : undefined;
  if (!ex || !isObj(out.execution)) return;
  const byRole = isObj(ex.maxByRole) ? ex.maxByRole : undefined;
  const setsAlias = ex.maxEngineers !== undefined, setsByRole = byRole?.engineer !== undefined;
  if (setsAlias === setsByRole) return;
  const outEx = out.execution as Obj;
  if (setsAlias && isObj(outEx.maxByRole) && outEx.maxByRole.engineer !== undefined) {
    outEx.maxByRole = { ...outEx.maxByRole, engineer: ex.maxEngineers };
    prov['execution.maxByRole.engineer'] = source;
  } else if (setsByRole && outEx.maxEngineers !== undefined) {
    outEx.maxEngineers = byRole!.engineer;
    prov['execution.maxEngineers'] = source;
  }
}

const json = (v: unknown) => JSON.stringify(v);
const asObj = (r: CapabilityRule) => (typeof r === 'string' ? { effect: r, rules: [] } : { effect: r.effect, rules: r.rules ?? [] });

/** Denials from the project layer must survive config.local.json. */
function checkDenyPreserved(project: MinionsConfig, merged: MinionsConfig, label: string): void {
  for (const cap of CAPABILITIES) {
    const p = asObj(project.capabilities[cap]), m = asObj(merged.capabilities[cap]);
    const lost = (p.effect === 'deny' && m.effect !== 'deny') ||
      p.rules.some((r) => r.effect === 'deny' && !m.rules.some((x) => json(x) === json(r)));
    if (lost) {
      throw new MinionsError('POLICY_DENIED', `capabilities.${cap}: ${label} cannot remove a deny set by project configuration.`,
        'Change the project configuration explicitly to lift a denial.', { path: `capabilities.${cap}` });
    }
    // Project role columns (roles.<r>.capabilities and their defaults) are denials too.
    for (const role of registeredRoleNames(project)) {
      if (can(project, cap, { role }) === 'deny' && can(merged, cap, { role }) !== 'deny') {
        throw new MinionsError('POLICY_DENIED', `roles.${role}: ${label} cannot lift the deny of ${cap} set by project configuration.`,
          'Change the project configuration explicitly to lift a denial.', { path: `roles.${role}.capabilities.${cap}` });
      }
    }
  }
}

const widen = (path: string, why: string) => new MinionsError('POLICY_DENIED',
  `${path}: session override would widen policy (${why}).`, 'Session overrides may only narrow; persistent expansion needs a config change.', { path });

/** Applies session overrides to a resolved config, rejecting anything that would widen it. */
function applySession(base: MinionsConfig, session: unknown, prov: Record<string, Source>): MinionsConfig {
  if (!isObj(session)) throw invalidConfig([{ path: '', message: 'must be an object' }], 'session overrides');
  const out = structuredClone(base) as MinionsConfig;
  walk(session, [], (segs, v) => {
    const path = segs.join('.');
    const [head, key] = segs;
    const num = (cur: number) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw invalidConfig([{ path, message: 'must be a positive integer' }], 'session overrides');
      if (v > cur) throw widen(path, `${v} > ${cur}`);
      return v;
    };
    const onlyTrue = (cur: boolean) => { if (v !== true && v !== cur) throw widen(path, 'cannot disable'); return cur || v === true; };
    if (head === 'capabilities' && segs.length === 2) {
      const cap = key as Capability;
      if (!(CAPABILITIES as readonly string[]).includes(cap)) throw invalidConfig([{ path, message: 'unknown capability' }], 'session overrides');
      const parsed = CapabilityRuleSchema.safeParse(v);
      if (!parsed.success || typeof parsed.data !== 'string') throw invalidConfig([{ path, message: 'session overrides must be a plain effect (allow|ask|deny)' }], 'session overrides');
      const cur = asObj(out.capabilities[cap]);
      if (strictness(parsed.data) < strictness(cur.effect)) throw widen(path, `${parsed.data} over ${cur.effect}`);
      const e = parsed.data;
      // Raise every rule to at least the override so role/path rules cannot stay looser.
      out.capabilities[cap] = cur.rules.length ? { effect: stricter(cur.effect, e), rules: cur.rules.map((r) => ({ ...r, effect: stricter(r.effect, e) })) } : stricter(cur.effect, e);
    } else if (path === 'execution.maxEngineers') {
      // Alias of maxByRole.engineer: narrow both so they keep agreeing; unset = bounded by maxActiveTasks.
      const n = num(roleLimit(out, ENGINEER_ROLE) ?? out.execution.maxActiveTasks);
      out.execution.maxEngineers = n;
      if (out.execution.maxByRole?.[ENGINEER_ROLE] !== undefined) out.execution.maxByRole[ENGINEER_ROLE] = n;
    } else if (head === 'execution' && key === 'maxByRole' && segs.length === 3) {
      const role = segs[2]!;
      const n = num(roleLimit(out, role) ?? out.execution.maxActiveTasks);
      out.execution.maxByRole = { ...out.execution.maxByRole, [role]: n };
      if (role === ENGINEER_ROLE && out.execution.maxEngineers !== undefined) out.execution.maxEngineers = n;
    } else if (head === 'execution' && segs.length === 2 && key !== 'oneActiveStagePerTask' && key !== 'maxByRole' && key! in out.execution) {
      const k = key as 'maxActiveTasks' | 'maxRepairCyclesBeforeReplan' | 'attemptMaxTurns';
      out.execution[k] = num(out.execution[k]);
    } else if (path === 'models.allowed') {
      if (!Array.isArray(v) || !v.length || !v.every((m) => out.models.allowed.includes(m))) throw widen(path, 'not a subset of allowed models');
      out.models.allowed = v as string[];
    } else if (path === 'models.default') {
      if (typeof v !== 'string' || !base.models.allowed.includes(v)) throw widen(path, `"${String(v)}" is not an allowed model`);
      out.models.default = v;
    } else if (path === 'intake.startReady') {
      if (v !== false && v !== base.intake.startReady) throw widen(path, 'cannot enable');
      out.intake.startReady = v as boolean;
    } else if (path === 'intake.scope.requiredLabels') {
      if (!Array.isArray(v) || !base.intake.scope.requiredLabels.every((l) => v.includes(l))) throw widen(path, 'must keep existing required labels');
      out.intake.scope.requiredLabels = v as string[];
    } else if (path === 'verification.testerRequired' || path === 'verification.reviewerRequired') {
      const k = key as 'testerRequired' | 'reviewerRequired';
      out.verification[k] = onlyTrue(base.verification[k]);
    } else if (path === 'sensitivePaths') {
      if (!Array.isArray(v) || !base.sensitivePaths.every((p) => v.includes(p))) throw widen(path, 'must keep existing sensitive paths');
      out.sensitivePaths = v as string[];
    } else if (path === 'communication.progress') {
      out.communication.progress = v as MinionsConfig['communication']['progress'];
    } else {
      throw new MinionsError('INVALID_CONFIG', `${path}: not a session-overridable setting.`,
        'Change it in the project configuration instead.', { path });
    }
    for (const p of Object.keys(prov)) if (p === path || p.startsWith(path + '.')) delete prov[p];
    if (head === 'capabilities') prov[path] = 'session';
    else walk({ [segs.at(-1)!]: v }, segs.slice(0, -1), (s) => (prov[s.join('.')] = 'session'));
  });
  return validateConfig(out, 'session overrides');
}

/**
 * The two choices that drop the agents' last local boundary (no permission prompts at all, no host sandbox) are the
 * owner's alone: the project layer may be committed to the repository, so only config.local.json may make them.
 */
function checkHostOnlyChoices(project: MinionsConfig, label: string): void {
  if (project.coordinator?.permissionMode === 'bypassPermissions') {
    throw new MinionsError('POLICY_DENIED', `coordinator.permissionMode: ${label} cannot select bypassPermissions.`,
      'Set it in the host-only config.local.json: `minions settings set coordinator.permissionMode bypassPermissions`.', { path: 'coordinator.permissionMode' });
  }
  if (project.coordinator?.sandbox === false) {
    throw new MinionsError('POLICY_DENIED', `coordinator.sandbox: ${label} cannot turn the host sandbox off.`,
      'Set it in the host-only config.local.json: `minions settings set coordinator.sandbox false`.', { path: 'coordinator.sandbox' });
  }
}

/**
 * A resolved config with the coordinator's control overlay on top (docs/design/autonomy.md Decision 3). The runtime
 * applies it to the config the host resolved; it is trusted like the local layer but without the deny-preservation
 * check (the owner gave the coordinator full control).
 */
export function applyControl(base: MinionsConfig, control: unknown, label = 'control overlay'): MinionsConfig {
  if (control === undefined) return base;
  return validateConfig(overlay(base as unknown as Obj, control, 'control', {}, label), label);
}

/** defaults < project < local < session (the runtime adds control, applyControl). Returns the validated config with per-leaf provenance. */
export function resolve(input: ResolveInput): EffectiveConfig {
  const label = (s: Source) => input.sources?.[s] ?? `${s} configuration`;
  const prov: Record<string, Source> = {};
  walk(input.defaults, [], (p) => (prov[p.join('.')] = 'default'));
  let merged = overlay(input.defaults as unknown as Obj, input.project, 'project', prov, label('project'));
  const project = validateConfig(merged, label('project'));
  checkHostOnlyChoices(project, label('project'));
  merged = overlay(merged, input.local, 'local', prov, label('local'));
  let config = validateConfig(merged, input.local === undefined ? label('project') : label('local'));
  if (input.local !== undefined) checkDenyPreserved(project, config, label('local'));
  if (input.session !== undefined) config = applySession(config, input.session, prov);
  return { config, provenance: prov };
}
