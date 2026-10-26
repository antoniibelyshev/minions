// `minions settings` (host): the everyday settings model shared by the interactive menu
// (src/host/settings-menu.ts), `settings --list --json` and `settings set <key> <value>`.
//
// Each setting declares its group, type, a one-line effect, how a change takes effect, and when a change
// loosens policy:
// - every save regenerates the derived files (runtime config.json, compose, the mounted plugin) through
//   refreshDerived, so the runtime enforces `live` settings on its next command (each `minions work ...`
//   call reads the regenerated runtime config);
// - `prompt` settings live in the coordinator's prompt and the agent definitions (the plugin), which Claude
//   Code reads at session start; `launch` settings are coordinator launch arguments (channel, model,
//   effort, permission mode). Both need a coordinator restart (offered, graceful: refused while workers run);
// - `recreate` settings are compose, image or mount settings: `minions upgrade` applies them (container recreated).
// Each setting also carries its class (live / restart / recreate) and hostOwned flag, consistent with the schema
// classification (src/config/setting-classes.ts); a change request from the runtime (src/runtime/change-requests.ts)
// for a hostOwned key is refused when recorded and again by the host (src/host/change-requests.ts).
// Writes go to the host-only config.local.json by default; the shared .minions/config.json (a sensitive,
// committed path) only with an explicit `shared` choice on a shared install. Values are validated with the
// full config schema (resolveEffective) before anything is written. Secrets are never read or shown: token
// items report only provisioned / missing.
import { CAPABILITIES, strictness, ruleEffects } from '../config/capabilities.js';
import { COORDINATOR_DISALLOWED_TOOLS } from '../config/coordinator-tools.js';
import type { Source } from '../config/resolve.js';
import { EFFORTS, type CapabilityRule, type MinionsConfig } from '../config/schema.js';
import { classifyKey, type SettingClass } from '../config/setting-classes.js';
import { MinionsError } from '../core/errors.js';
import { usdPerMTok } from '../runtime/spend.js';
import { atomicWrite, readJsonIfExists } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import { editProjectConfig, revisionConflict } from './config-write.js';
import { loadCredentialRefs, type CredentialsJson } from './credentials.js';
import { refreshDerived } from './install.js';
import { loadEffectiveConfig, projectConfigPath, resolveEffective, type ProjectJson } from './project.js';

export const SETTING_GROUPS = ['Delivery', 'Verification', 'Reporting', 'Models', 'Concurrency', 'Policy', 'Permissions', 'Integrations', 'Pause'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** live: enforced by the runtime from the regenerated config; prompt/launch: needs a coordinator restart; recreate: needs `minions upgrade`. */
export type SettingApply = 'live' | 'prompt' | 'launch' | 'recreate';
export type { SettingClass };

/** The class of an apply mode (prompt and launch both mean a coordinator restart). */
export const applyClass = (apply: SettingApply): Exclude<SettingClass, 'fixed'> =>
  apply === 'live' ? 'live' : apply === 'recreate' ? 'recreate' : 'restart';

/** When a change takes effect: now (the next runtime command), after a coordinator restart, or after `minions upgrade`. */
export type TakesEffect = 'now' | 'restart' | 'upgrade';
export const takesEffectOf = (cls: SettingClass): TakesEffect | null =>
  cls === 'live' ? 'now' : cls === 'restart' ? 'restart' : cls === 'recreate' ? 'upgrade' : null;
export type SettingType = 'enum' | 'int' | 'bool' | 'model' | 'models' | 'list' | 'secret' | 'control';
export type SettingLayer = 'local' | 'shared';

type Value = unknown;

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  type: SettingType;
  choices?: readonly string[];
  min?: number;
  /** May be unset (value `default` removes it from the layer). */
  optional?: boolean;
  apply: SettingApply;
  /** How a change takes effect (from apply; the guard test checks it against the schema classification). */
  class: SettingClass;
  /** Host-owned: policy, permissions or isolation; the container can never propose it. */
  hostOwned: boolean;
  /** What a change from `from` to `to` newly allows, or null when it does not loosen policy. */
  loosens?: (from: Value, to: Value) => string | null;
}

const RESTART_WHY: Record<SettingApply, string> = {
  live: 'takes effect on the next runtime command (the coordinator prompt catches up on its next restart)',
  prompt: 'the coordinator and worker definitions read it at session start: needs a coordinator restart',
  launch: 'a coordinator launch setting: needs a coordinator restart',
  recreate: 'a container setting (compose, image or mounts): needs `minions upgrade` (the container is recreated, volumes kept)',
};

const more = (what: string) => (from: Value, to: Value) => (typeof from === 'number' && typeof to === 'number' && to > from ? `${what} (${from} -> ${to})` : null);
const turnsOff = (what: string) => (from: Value, to: Value) => (from === true && to === false ? what : null);
const turnsOn = (what: string) => (from: Value, to: Value) => (from !== true && to === true ? what : null);
const price = (m: Value) => (typeof m === 'string' ? usdPerMTok(m) : null);
const priceText = (m: Value) => { const p = price(m); return p === null ? `${String(m)} (no known price)` : `${String(m)} ~$${p}/MTok`; };
/** A default model that costs more per token (or whose price is unknown: it may cost more) loosens spend. */
const pricierDefault = (from: Value, to: Value): string | null => {
  if (from === to || typeof to !== 'string') return null;
  const pf = price(from); const pt = price(to);
  if (pf !== null && pt !== null && pt <= pf) return null;
  return `workers default to a ${pf !== null && pt !== null ? 'pricier' : 'possibly pricier'} model (${priceText(from)} -> ${priceText(to)}; higher spend)`;
};
/** Models newly added to the allowed list: the coordinator may pick them per worker. */
const widensModels = (from: Value, to: Value): string | null => {
  const was = Array.isArray(from) ? (from as string[]) : [];
  const added = (Array.isArray(to) ? (to as string[]) : []).filter((m) => !was.includes(m));
  return added.length ? `the coordinator may pick ${added.join(', ')} for workers (higher spend possible)` : null;
};
/** Effective coordinator tool trim: unset = the default list. */
const trimOf = (v: Value): string[] => (Array.isArray(v) ? (v as string[]) : [...COORDINATOR_DISALLOWED_TOOLS]);
const capRank =(r: Value): number => {
  if (r === undefined || r === null) return 0;
  const effects = ruleEffects(r as CapabilityRule);
  return Math.max(...effects.map(strictness));
};

/** A setting as declared below; class and hostOwned are filled in by withClass. */
type DeclaredSetting = Omit<SettingDef, 'class' | 'hostOwned'> & { hostOwned?: boolean };

/**
 * Fills in class (from apply) and hostOwned: schema keys take the flag from the classification table
 * (src/config/setting-classes.ts); items outside the schema (secrets, pause controls) declare it.
 */
const withClass = (d: DeclaredSetting): SettingDef =>
  ({ ...d, class: applyClass(d.apply), hostOwned: d.hostOwned ?? classifyKey(d.key)?.hostOwned ?? false });

const DECLARED: readonly DeclaredSetting[] = [
  // ---- Delivery
  { key: 'delivery.mode', group: 'Delivery', label: 'Delivery mode', type: 'enum', choices: ['local', 'branch', 'pull-request'], apply: 'prompt',
    description: 'local: commits stay in the runtime; branch: push agent/<slug>; pull-request: push and open a PR',
    loosens: (f, t) => (f === 'local' && t !== 'local' ? `agents push agent/<slug> branches to GitHub${t === 'pull-request' ? ' and open pull requests' : ''}` : f === 'branch' && t === 'pull-request' ? 'agents open pull requests on GitHub' : null) },
  { key: 'delivery.merge', group: 'Delivery', label: 'Merge mode', type: 'enum', choices: ['disabled', 'manual', 'auto-when-eligible'], apply: 'prompt',
    description: 'whether minions merges pull requests: never, on request, or automatically when CI and approvals pass',
    loosens: (f, t) => (t === 'auto-when-eligible' ? 'pull requests that pass every gate are merged on GitHub without asking' : f === 'disabled' && t === 'manual' ? 'minions may merge pull requests on GitHub when asked' : null) },
  // ---- Verification
  { key: 'verification.testerRequired', group: 'Verification', label: 'Tester on every task', type: 'bool', apply: 'prompt',
    description: 'true: every task gets a tester stage; false: only tasks that need QA (labels, sensitive paths, reviewer request)',
    loosens: turnsOff('tasks without a QA need are delivered without a tester stage') },
  { key: 'verification.reviewerRequired', group: 'Verification', label: 'Reviewer required', type: 'bool', apply: 'prompt',
    description: 'whether every task needs an independent reviewer approval before delivery',
    loosens: turnsOff('tasks can be delivered without a reviewer approval') },
  { key: 'verification.ciAuthority', group: 'Verification', label: 'CI authority', type: 'enum', choices: ['none', 'github'], apply: 'prompt',
    description: 'github: passing required CI checks may replace the full local verification; none: local only',
    loosens: (f, t) => (f === 'none' && t === 'github' ? 'testers and reviewers may rely on passing GitHub CI instead of re-running verification locally' : null) },
  // ---- Reporting
  { key: 'communication.progress', group: 'Reporting', label: 'Progress reports', type: 'enum', choices: ['milestones', 'tasks', 'quiet'], apply: 'prompt',
    description: 'what the coordinator reports unprompted: feature milestones, every task, or only blockers' },
  { key: 'communication.channel', group: 'Reporting', label: 'Channel', type: 'enum', choices: ['terminal', 'telegram', 'auto'], apply: 'launch',
    description: 'where the coordinator talks to you; auto = Telegram when a bot token is stored' },
  // ---- Models
  { key: 'models.default', group: 'Models', label: 'Default model', type: 'model', apply: 'prompt',
    description: 'model of the worker definitions (must be in the allowed list)',
    loosens: pricierDefault },
  { key: 'models.allowed', group: 'Models', label: 'Allowed models', type: 'models', apply: 'prompt',
    description: 'models the coordinator may pick per worker (comma-separated)',
    loosens: widensModels },
  { key: 'models.selection', group: 'Models', label: 'Model selection', type: 'enum', choices: ['coordinator', 'fixed'], apply: 'prompt',
    description: 'coordinator: picks an allowed model per worker; fixed: always the default model' ,
    loosens: (f, t) => (f === 'fixed' && t === 'coordinator' ? 'the coordinator may pick other allowed models per worker (possibly pricier)' : null) },
  { key: 'models.coordinator', group: 'Models', label: 'Coordinator model', type: 'model', optional: true, apply: 'launch',
    description: 'model of the coordinator session (default: the Claude Code default)' },
  { key: 'models.effort', group: 'Models', label: 'Effort (all roles)', type: 'enum', choices: EFFORTS, optional: true, apply: 'launch',
    description: 'reasoning effort fallback for every role (default: the Claude Code default)' },
  ...(['engineer', 'engineerDeep', 'tester', 'reviewer', 'coordinator'] as const).map((role): DeclaredSetting => ({
    key: `models.effortByRole.${role}`, group: 'Models', label: `Effort: ${role}`, type: 'enum', choices: EFFORTS, optional: true,
    apply: role === 'coordinator' ? 'launch' : 'prompt', description: `reasoning effort of the ${role} (default: models.effort)`,
  })),
  // ---- Concurrency
  { key: 'execution.maxActiveTasks', group: 'Concurrency', label: 'Max active tasks', type: 'int', min: 1, apply: 'live',
    description: 'tasks that may be in flight at once (more parallel work, more spend)',
    loosens: more('more tasks may run in parallel (higher spend)') },
  { key: 'execution.maxEngineers', group: 'Concurrency', label: 'Max engineers', type: 'int', min: 1, apply: 'live',
    description: 'engineer workers at once (must be <= max active tasks)',
    loosens: more('more engineers may run at once (higher spend)') },
  // prompt, not live: the cap Claude Code enforces is the worker definitions' `maxTurns` frontmatter (read at
  // session start); only the brief's informational maxTurns follows the new value at the next claim.
  { key: 'execution.attemptMaxTurns', group: 'Concurrency', label: 'Max turns per attempt', type: 'int', min: 1, apply: 'prompt',
    description: 'turn budget of one worker attempt (worker definitions: needs a coordinator restart)',
    loosens: more('each worker attempt may run longer (higher spend)') },
  { key: 'execution.maxRepairCyclesBeforeReplan', group: 'Concurrency', label: 'Repair cycles before replan', type: 'int', min: 1, apply: 'live',
    description: 'failed fix cycles before the coordinator replans a task',
    loosens: more('more failed fix cycles may run before a task is replanned (higher spend)') },
  // ---- Policy
  { key: 'intake.startReady', group: 'Policy', label: 'Start ready tasks', type: 'bool', apply: 'prompt',
    description: 'whether the coordinator starts ready tasks without asking you first',
    loosens: (f, t) => (f === false && t === true ? 'the coordinator starts ready tasks without asking' : null) },
  { key: 'architecture', group: 'Policy', label: 'Architecture decisions', type: 'enum', choices: ['decide', 'propose'], apply: 'prompt',
    description: 'decide: agents make and record architecture decisions within a task; propose: they ask first',
    loosens: (f, t) => (f === 'propose' && t === 'decide' ? 'agents make architecture decisions without asking' : null) },
  { key: 'coordinator.permissionMode', group: 'Policy', label: 'Coordinator permission mode', type: 'enum', choices: ['auto', 'acceptEdits'], optional: true, apply: 'launch',
    description: 'auto: a classifier may approve actions outside the allow list; acceptEdits: prompt for every other Bash call',
    loosens: (f, t) => ((f === 'acceptEdits') && (t === 'auto' || t === undefined) ? 'a classifier may approve coordinator actions outside the allow list without prompting' : null) },
  { key: 'coordinator.contextReset.enabled', group: 'Policy', label: 'Routine context resets', type: 'bool', apply: 'live',
    description: 'the coordinator hands off and restarts with a fresh context when idle' },
  { key: 'coordinator.disallowedTools', group: 'Policy', label: 'Coordinator tool trim', type: 'list', optional: true, apply: 'launch',
    description: 'Claude Code tools removed from the coordinator session (default: the built-in trim; none: keep every tool; tools it needs cannot be listed)',
    loosens: (f, t) => {
      const back = trimOf(f).filter((x) => !trimOf(t).includes(x));
      return back.length ? `the coordinator gets back ${back.length > 5 ? `${back.slice(0, 5).join(', ')} and ${back.length - 5} more` : back.join(', ')}` : null;
    } },
  { key: 'coordinator.toolSearch', group: 'Policy', label: 'Coordinator tool search', type: 'bool', optional: true, apply: 'launch',
    description: 'true: rarely used tools are loaded on demand (smaller requests); false: Claude Code decides' },
  { key: 'coordinator.bundledSkills', group: 'Policy', label: 'Coordinator bundled skills', type: 'bool', optional: true, apply: 'launch',
    description: "Claude Code's bundled skills in the coordinator session (plugin skills always stay)",
    loosens: turnsOn("the coordinator session gets Claude Code's bundled skills (more tools and context)") },
  // ---- Permissions (capabilities)
  ...CAPABILITIES.map((cap): DeclaredSetting => ({
    key: `capabilities.${cap}`, group: 'Permissions', label: cap, type: 'enum', choices: ['allow', 'ask', 'deny'], apply: 'prompt',
    description: `allow: agents may ${cap} on their own; ask: needs your approval; deny: never`,
    loosens: (f, t) => (capRank(t) < capRank(f) ? `${cap} becomes "${String(t)}" (was ${JSON.stringify(f)}): ${t === 'allow' ? 'agents may do it without asking' : 'agents may do it with your approval'}` : null),
  })),
  // ---- Integrations (never shows a secret)
  { key: 'secrets.github', group: 'Integrations', label: 'GitHub token', type: 'secret', apply: 'live', hostOwned: true,
    description: 'GitHub token for branch/PR delivery (`minions auth github`)' },
  { key: 'secrets.telegram', group: 'Integrations', label: 'Telegram bot token', type: 'secret', apply: 'launch', hostOwned: true,
    description: 'Telegram bot token for the Telegram channel (`minions auth telegram`)' },
  // ---- Pause (runtime controls)
  { key: 'pause.intake', group: 'Pause', label: 'Intake paused', type: 'control', apply: 'live', hostOwned: false,
    description: 'paused: the coordinator takes no new tasks into the backlog' },
  { key: 'pause.starts', group: 'Pause', label: 'Starts paused', type: 'control', apply: 'live', hostOwned: false,
    description: 'paused: no new task starts; running workers continue' },
];

export const SETTINGS: readonly SettingDef[] = DECLARED.map(withClass);

export const settingDef = (key: string): SettingDef | undefined => SETTINGS.find((s) => s.key === key);

export function requireSetting(key: string): SettingDef {
  const d = settingDef(key);
  if (!d) throw new MinionsError('INVALID_CONFIG', `Unknown setting: ${key}`, 'Run `minions settings --list` for the settings that can be changed.', { path: key });
  return d;
}

// ---------------------------------------------------------------- reading

export type SourceLabel = 'profile default' | 'shared config' | 'project config' | 'local override' | 'session' | 'credential store' | 'runtime';

export interface SettingView {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  type: SettingType;
  choices?: readonly string[];
  /** May be unset (`default`). */
  optional?: boolean;
  /** Current effective value; secrets: "provisioned" / "missing"; controls: "paused" / "running" / null (runtime not reachable). */
  value: Value;
  source: SourceLabel;
  apply: SettingApply;
  /** live / restart / recreate. */
  class: SettingClass;
  /** Host-owned: the container can never propose a change. */
  hostOwned: boolean;
  needsRegenerate: boolean;
  /** A change needs a coordinator restart (class restart). */
  needsRestart: boolean;
  /** A change needs `minions upgrade` (class recreate: the container is recreated). */
  needsUpgrade: boolean;
  /** One-line note on how a change takes effect. */
  effect: string;
  /** Whether a change of this setting can loosen policy (a confirmation lists what it allows). */
  canLoosen: boolean;
}

export interface SettingsContext {
  project: ProjectJson;
  config: MinionsConfig;
  provenance: Record<string, Source>;
  credentials: CredentialsJson;
  /** Runtime pause flags; null when the runtime is not running or did not answer. */
  paused: { intake: boolean; starts: boolean } | null;
}

export function getPath(obj: unknown, path: string): Value {
  if (path.startsWith('capabilities.')) return (obj as { capabilities?: Record<string, unknown> })?.capabilities?.[path.slice('capabilities.'.length)];
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const pathSegs = (path: string) => (path.startsWith('capabilities.') ? ['capabilities', path.slice('capabilities.'.length)] : path.split('.'));

/** Sets (or, for undefined, removes) a leaf in a raw layer object; creates intermediate objects. */
export function setPath(obj: Record<string, unknown>, path: string, value: Value): Record<string, unknown> {
  const segs = pathSegs(path);
  let cur = obj;
  for (const k of segs.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const leaf = segs.at(-1)!;
  if (value === undefined) delete cur[leaf]; else cur[leaf] = value;
  return obj;
}

function sourceOf(def: SettingDef, ctx: SettingsContext): SourceLabel {
  if (def.type === 'secret') return 'credential store';
  if (def.type === 'control') return 'runtime';
  const prov = ctx.provenance[def.key] ?? Object.entries(ctx.provenance).find(([k]) => k.startsWith(def.key + '.'))?.[1];
  if (prov === 'local') return 'local override';
  if (prov === 'project') return ctx.project.visibility === 'shared' ? 'shared config' : 'project config';
  if (prov === 'session') return 'session';
  return 'profile default';
}

export function currentValue(def: SettingDef, ctx: SettingsContext): Value {
  if (def.type === 'secret') return ctx.credentials[def.key === 'secrets.github' ? 'github' : 'telegram'] ? 'provisioned' : 'missing';
  if (def.type === 'control') {
    if (!ctx.paused) return null;
    return ctx.paused[def.key === 'pause.intake' ? 'intake' : 'starts'] ? 'paused' : 'running';
  }
  const v = getPath(ctx.config, def.key);
  if (def.key === 'coordinator.contextReset.enabled' && v === undefined) return true; // unset = on
  if (def.key === 'coordinator.toolSearch' && v === undefined) return true; // unset = on
  if (def.key === 'coordinator.bundledSkills' && v === undefined) return false; // unset = off
  return v;
}

export function viewSetting(def: SettingDef, ctx: SettingsContext): SettingView {
  const isConfig = def.type !== 'secret' && def.type !== 'control';
  return {
    key: def.key, group: def.group, label: def.label, description: def.description, type: def.type,
    ...(def.choices ? { choices: def.choices } : {}), ...(def.optional ? { optional: true } : {}),
    value: currentValue(def, ctx), source: sourceOf(def, ctx), apply: def.apply, class: def.class, hostOwned: def.hostOwned,
    needsRegenerate: isConfig, needsRestart: isConfig && def.class === 'restart', needsUpgrade: isConfig && def.class === 'recreate',
    effect: isConfig ? RESTART_WHY[def.apply] : def.type === 'secret' ? `run \`minions auth ${def.key.slice('secrets.'.length)}\` to change it` : 'applied to the running runtime at once',
    canLoosen: !!def.loosens,
  };
}

export const listSettings = (ctx: SettingsContext): SettingView[] => SETTINGS.map((d) => viewSetting(d, ctx));

export interface SettingsDeps {
  /** Pause flags of the running runtime (null when it is not running or did not answer). */
  pausedState?: (project: ProjectJson) => Promise<SettingsContext['paused']>;
}

export async function loadSettingsContext(project: ProjectJson, deps: SettingsDeps = {}): Promise<SettingsContext> {
  const eff = await loadEffectiveConfig(project);
  const credentials = await loadCredentialRefs(project.projectId).catch((): CredentialsJson => ({ version: 1 }));
  const paused = deps.pausedState ? await deps.pausedState(project).catch(() => null) : null;
  return { project, config: eff.config, provenance: eff.provenance, credentials, paused };
}

// ---------------------------------------------------------------- parsing

const BOOL: Record<string, boolean> = { true: true, false: false, on: true, off: false, yes: true, no: false, '1': true, '0': false };

/** Parses a CLI/menu value for a setting. `default` unsets optional settings. Throws INVALID_CONFIG. */
export function parseSettingValue(def: SettingDef, input: string): Value {
  const s = input.trim();
  const bad = (msg: string) => new MinionsError('INVALID_CONFIG', `${def.key}: ${msg} (got "${s}")`, def.choices ? `Choices: ${def.choices.join(', ')}${def.optional ? ', default' : ''}` : undefined, { path: def.key });
  if (def.optional && (s === 'default' || s === '')) return undefined;
  switch (def.type) {
    case 'int': {
      if (!/^\d+$/.test(s)) throw bad('must be a whole number');
      const n = Number(s);
      if (def.min !== undefined && n < def.min) throw bad(`must be at least ${def.min}`);
      return n;
    }
    case 'bool': {
      const b = BOOL[s.toLowerCase()];
      if (b === undefined) throw bad('must be true or false');
      return b;
    }
    case 'enum':
      if (!def.choices!.includes(s)) throw bad('not one of the choices');
      return s;
    case 'model':
      if (!s) throw bad('must not be empty');
      return s;
    case 'list': {
      if (s === 'none') return [];
      const list = s.split(',').map((x) => x.trim()).filter(Boolean);
      if (!list.length) throw bad('must list at least one entry, or none');
      return list;
    }
    case 'models': {
      const list = s.split(',').map((x) => x.trim()).filter(Boolean);
      if (!list.length) throw bad('must list at least one model');
      return list;
    }
    case 'control':
      if (s !== 'paused' && s !== 'running' && s !== 'pause' && s !== 'resume') throw bad('must be paused or running');
      return s === 'paused' || s === 'pause' ? 'paused' : 'running';
    case 'secret':
      throw new MinionsError('PRECONDITION', `${def.key} is a secret and cannot be set here.`, `Run \`minions auth ${def.key.slice('secrets.'.length)}\` (the token is read without echo).`, { path: def.key });
  }
}

// ---------------------------------------------------------------- planning and writing

export interface SettingChange {
  key: string;
  from: Value;
  to: Value;
  layer: SettingLayer;
  /** File the value is written to. */
  file: string;
  changed: boolean;
  /** What the change newly allows (null: does not loosen policy). */
  loosens: string | null;
  /** The change needs a coordinator restart (class restart). */
  needsRestart: boolean;
  /** The change needs `minions upgrade` (class recreate). */
  needsUpgrade: boolean;
  apply: SettingApply;
  class: SettingClass;
  hostOwned: boolean;
  /** The effective config after the change (validated). */
  effective: MinionsConfig;
  /** The effective configRevision the change was planned against (`--expect-revision` compares with it). */
  revision: number;
  warnings: string[];
}

const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

/** The layer file for a write; `shared` needs a shared install (it is the committed .minions/config.json). */
export function layerFile(project: ProjectJson, layer: SettingLayer): string {
  if (layer === 'shared') {
    if (project.visibility !== 'shared') {
      throw new MinionsError('PRECONDITION', 'This is a private install: there is no shared configuration to write.', 'Omit --shared; settings go to the host-only config.local.json.');
    }
    return projectConfigPath(project);
  }
  return projectPaths(project.projectId).configLocalJson;
}

/**
 * Plans a config setting change: validates the new value with the full schema against every layer
 * (nothing is written). Throws INVALID_CONFIG / POLICY_DENIED like a config load would.
 */
export async function planSetting(ctx: SettingsContext, key: string, to: Value, layer: SettingLayer = 'local'): Promise<SettingChange> {
  const def = requireSetting(key);
  if (def.type === 'secret' || def.type === 'control') throw new MinionsError('PRECONDITION', `${key} is not a configuration setting.`);
  const { project } = ctx;
  const file = layerFile(project, layer);
  const projectFile = projectConfigPath(project);
  const projectRaw = (await readJsonIfExists<Record<string, unknown>>(projectFile)) ?? {};
  const localFile = projectPaths(project.projectId).configLocalJson;
  const localRaw = await readJsonIfExists<Record<string, unknown>>(localFile);
  if (localRaw !== undefined && (typeof localRaw !== 'object' || localRaw === null || Array.isArray(localRaw))) {
    throw new MinionsError('INVALID_CONFIG', `${localFile}: must be a JSON object; not changed.`, 'Fix the file by hand, then rerun.');
  }
  const from = currentValue(def, ctx);
  const revision = resolveEffective(project, projectRaw, localRaw, { project: projectFile, local: localFile }).config.configRevision;
  const nextProject = layer === 'shared' ? setPath(structuredClone(projectRaw), key, to) : projectRaw;
  const nextLocal = layer === 'local' ? setPath(structuredClone(localRaw ?? {}), key, to) : localRaw;
  const effective = resolveEffective(project, nextProject, nextLocal, { project: projectFile, local: localFile }).config;
  const now = currentValue(def, { ...ctx, config: effective });
  const warnings: string[] = [];
  if (layer === 'shared' && localRaw !== undefined && getPath(localRaw, key) !== undefined && !same(now, to)) {
    warnings.push(`${key} is overridden in ${localFile}; the local value still wins on this host.`);
  }
  const changed = !same(from, now);
  return {
    key, from, to, layer, file, changed, loosens: changed && def.loosens ? def.loosens(from, now) : null,
    needsRestart: changed && def.class === 'restart', needsUpgrade: changed && def.class === 'recreate',
    apply: def.apply, class: def.class, hostOwned: def.hostOwned, effective, revision, warnings,
  };
}

/**
 * Writes a planned change to its layer and regenerates the derived files. Returns refresh warnings.
 * expectRevision: refuse (CONFLICT, nothing written) unless the config is still at that revision (the shared
 * file's configRevision, which editProjectConfig checks; for the local layer the effective configRevision of
 * the current files). A local-layer write does not bump configRevision (config.local.json is host-only).
 */
export async function writeSetting(project: ProjectJson, change: SettingChange, opts: { expectRevision?: number } = {}): Promise<string[]> {
  if (change.layer === 'shared') {
    const r = await editProjectConfig(project, (raw) => setPath(raw, change.key, change.to), { expectRevision: opts.expectRevision });
    return r.warnings;
  }
  const localFile = projectPaths(project.projectId).configLocalJson;
  const localRaw = (await readJsonIfExists<Record<string, unknown>>(localFile)) ?? {};
  const next = setPath(structuredClone(localRaw), change.key, change.to);
  const projectRaw = (await readJsonIfExists<Record<string, unknown>>(projectConfigPath(project))) ?? {};
  if (opts.expectRevision !== undefined) {
    const now = resolveEffective(project, projectRaw, localRaw, { project: projectConfigPath(project), local: localFile }).config.configRevision;
    if (now !== opts.expectRevision) throw revisionConflict(projectConfigPath(project), opts.expectRevision, now);
  }
  const effective = resolveEffective(project, projectRaw, next, { project: projectConfigPath(project), local: localFile }).config; // re-validate against the current files
  await atomicWrite(localFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return refreshDerived(project, effective);
}

/** Human form of a value (lists comma-separated, capabilities as their effect, unset as "default"). */
export function formatValue(v: Value): string {
  if (v === undefined) return 'default';
  if (v === null) return 'unknown';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') {
    const r = v as { effect?: string; rules?: unknown[] };
    if (r.effect) return `${r.effect} (+${r.rules?.length ?? 0} rule${r.rules?.length === 1 ? '' : 's'})`;
    return JSON.stringify(v);
  }
  return String(v);
}
