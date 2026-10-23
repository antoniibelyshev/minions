import { MinionsError, invalidConfig, zodIssues, type ConfigIssue } from '../core/errors.js';
import { CAPABILITIES, ruleEffects, stricter, strictness } from './capabilities.js';
import { autoMergeConfigReasons } from './delivery.js';
import { MinionsConfigSchema, CapabilityRuleSchema, type Capability, type CapabilityRule, type MinionsConfig } from './schema.js';

export const SUPPORTED = {
  backlog: ['backlogmd'],
  delivery: ['local', 'branch', 'pull-request'],
  communication: ['terminal', 'telegram', 'auto'],
} as const;

/** Features deferred in v0.1; doctor and the wizard report them as unavailable. */
export const DEFERRED_FEATURES = [
  'GitHub Issues backend', 'merge requests (delivery.merge "manual")', 'review publication',
  'config plan/apply transactions', 'backlog migration', 'upgrade plan and schema migration', 'budgets',
  'companion containers', 'GitHub App short-lived tokens (a fine-grained PAT is used instead)',
  'CODEOWNERS mapping of sensitive paths', 'shared backlog versioned in Git',
] as const;

export interface Unavailable { path: string; value: unknown; reason: string }

/** Settings in a (valid) config that this build cannot honour. */
export function listUnavailable(config: MinionsConfig): Unavailable[] {
  const out: Unavailable[] = [];
  const has = (list: readonly string[], v: string) => list.includes(v);
  if (!has(SUPPORTED.backlog, config.backlog.backend)) out.push({ path: 'backlog.backend', value: config.backlog.backend, reason: 'only Backlog.md is supported in v0.1' });
  if (!has(SUPPORTED.delivery, config.delivery.mode)) out.push({ path: 'delivery.mode', value: config.delivery.mode, reason: `delivery mode is not supported (supported: ${SUPPORTED.delivery.join(', ')})` });
  if (!has(SUPPORTED.communication, config.communication.channel)) out.push({ path: 'communication.channel', value: config.communication.channel, reason: 'this communication channel is not supported in v0.1' });
  if (config.communication.channel === 'telegram' && config.container.network === 'none') {
    out.push({ path: 'communication.channel', value: 'telegram', reason: 'Telegram needs outbound network (api.telegram.org, and the npm registry for the plugin\'s dependencies) but container.network is none; the coordinator runs terminal-only' });
  }
  if (config.delivery.merge === 'auto-when-eligible') {
    const why = autoMergeConfigReasons(config);
    if (why.length) out.push({ path: 'delivery.merge', value: config.delivery.merge, reason: `automatic merge is unavailable: ${why.join('; ')}` });
  } else if (config.delivery.merge === 'manual') {
    out.push({ path: 'delivery.merge', value: 'manual', reason: config.delivery.mode === 'pull-request'
      ? 'merge requests through minions are deferred; minions never merges: merge the pull request through your normal process'
      : 'merge requests need pull-request delivery and are deferred in v0.1' });
  }
  if (config.budgets.taskUsd !== null || config.budgets.dailyUsd !== null) out.push({ path: 'budgets', value: config.budgets, reason: 'budgets are not enforced in v0.1' });
  return out;
}

function crossFieldIssues(c: MinionsConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (!(SUPPORTED.delivery as readonly string[]).includes(c.delivery.mode)) issues.push({ path: 'delivery.mode', message: `"${c.delivery.mode}" is not supported by this build (supported: ${SUPPORTED.delivery.join(', ')})` });
  if (!(SUPPORTED.backlog as readonly string[]).includes(c.backlog.backend)) issues.push({ path: 'backlog.backend', message: `"${c.backlog.backend}" is not supported by this build (supported: ${SUPPORTED.backlog.join(', ')})` });
  if (!(SUPPORTED.communication as readonly string[]).includes(c.communication.channel)) issues.push({ path: 'communication.channel', message: `"${c.communication.channel}" is not supported by this build (supported: ${SUPPORTED.communication.join(', ')})` });
  if (c.delivery.mode !== 'local' && c.delivery.provider !== 'github') issues.push({ path: 'delivery.provider', message: `delivery.mode "${c.delivery.mode}" publishes to GitHub and needs delivery.provider "github" (got "${c.delivery.provider}")` });
  if (c.execution.maxEngineers > c.execution.maxActiveTasks) issues.push({ path: 'execution.maxEngineers', message: `must be <= execution.maxActiveTasks (${c.execution.maxEngineers} > ${c.execution.maxActiveTasks})` });
  if (!c.models.allowed.includes(c.models.default)) issues.push({ path: 'models.default', message: `"${c.models.default}" is not in models.allowed [${c.models.allowed.join(', ')}]` });
  if (c.models.coordinator !== undefined && !c.models.allowed.includes(c.models.coordinator)) issues.push({ path: 'models.coordinator', message: `"${c.models.coordinator}" is not in models.allowed [${c.models.allowed.join(', ')}]` });
  if (c.container.mountDockerSocket) issues.push({ path: 'container.mountDockerSocket', message: 'must be false: the Docker socket grants host control' });
  if (c.container.mountHostRepository) issues.push({ path: 'container.mountHostRepository', message: 'must be false: the workspace lives in a named volume' });
  return issues;
}

/** Strict schema parse + cross-field checks. Throws INVALID_CONFIG listing dotted paths. */
export function validateConfig(raw: unknown, source?: string): MinionsConfig {
  const r = MinionsConfigSchema.safeParse(raw);
  if (!r.success) throw invalidConfig(zodIssues(r.error.issues), source);
  const issues = crossFieldIssues(r.data);
  if (issues.length) throw invalidConfig(issues, source);
  return r.data;
}

export type Source = 'default' | 'project' | 'local' | 'session';
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
  return out;
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
    } else if (head === 'execution' && segs.length === 2 && key !== 'oneActiveStagePerTask' && key! in out.execution) {
      const k = key as 'maxActiveTasks' | 'maxEngineers' | 'maxRepairCyclesBeforeReplan' | 'attemptMaxTurns';
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

/** defaults < project < local < session. Returns the validated config with per-leaf provenance. */
export function resolve(input: ResolveInput): EffectiveConfig {
  const label = (s: Source) => input.sources?.[s] ?? `${s} configuration`;
  const prov: Record<string, Source> = {};
  walk(input.defaults, [], (p) => (prov[p.join('.')] = 'default'));
  let merged = overlay(input.defaults as unknown as Obj, input.project, 'project', prov, label('project'));
  const project = validateConfig(merged, label('project'));
  merged = overlay(merged, input.local, 'local', prov, label('local'));
  let config = validateConfig(merged, input.local === undefined ? label('project') : label('local'));
  if (input.local !== undefined) checkDenyPreserved(project, config, label('local'));
  if (input.session !== undefined) config = applySession(config, input.session, prov);
  return { config, provenance: prov };
}
