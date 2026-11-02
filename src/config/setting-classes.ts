// Settings classification (task-44): every key of the
// config schema has a class that says how a change takes effect, and a host-owned flag.
//
// - live:     the runtime reads the regenerated runtime config.json on its next command or claim (the
//             coordinator's prompt text catches up at its next restart, which is mentioned, not forced);
// - restart:  baked into the generated prompt, the plugin or the coordinator launch arguments, so the graceful
//             coordinator restart (`minions settings restart`) applies it;
// - recreate: compose, the image or mounts, so `minions upgrade` applies it (container recreated, volumes kept);
// - fixed:    identity, literals or derived values; changed by `minions setup`, not by `settings set`.
// hostOwned keys are policy, permissions and isolation: the container can never propose them (task-53.3 adds
// the refusals; here the flag is metadata and display).
//
// An entry covers its key and everything below it (`capabilities` covers `capabilities.git.commit`); the most
// specific entry wins. test/config/setting-classes.test.ts walks MinionsConfigSchema and fails when a key has
// no entry, so a new schema key cannot ship unclassified.
import { z } from 'zod';
import { MinionsConfigSchema } from './schema.js';

export const SETTING_CLASSES = ['live', 'restart', 'recreate', 'fixed'] as const;
export type SettingClass = (typeof SETTING_CLASSES)[number];

export interface KeyClass {
  /** Dotted schema path; covers the subtree below it. */
  key: string;
  class: SettingClass;
  hostOwned: boolean;
  reason: string;
}

const entries = (keys: string[], cls: SettingClass, hostOwned: boolean, reason: string): KeyClass[] =>
  keys.map((key) => ({ key, class: cls, hostOwned, reason }));

/** The classification table of the design doc, one entry per key or subtree. */
export const KEY_CLASSES: readonly KeyClass[] = [
  // ---- live
  ...entries(['execution.maxActiveTasks', 'execution.maxEngineers', 'execution.maxByRole', 'execution.maxRepairCyclesBeforeReplan'], 'live', false,
    'enforced by `work claim` / the scheduler on each call'),
  ...entries(['coordinator.contextReset'], 'live', false, 'read by context-reset.ts on each check'),
  ...entries(['verification.commands', 'verification.setupCommands', 'verification.periodic', 'delivery.integrationTimeoutMinutes'], 'live', false,
    'the dispatcher and the local integrator read them per verification'),
  ...entries(['intake.scope', 'intake.sources'], 'live', false, 'backlog readiness filter per call'),
  ...entries(['routine'], 'live', false, 'read by each routine pass (`minions sync --routine`) and the wrapper clock'),
  ...entries(['routine.enabled'], 'live', true, 'lets the runtime start coordinator sessions on its own (wakes, crash starts: model spend)'),
  ...entries(['budgets'], 'live', true, 'spend caps the scheduler checks per claim; only the owner changes them (/budget in Telegram, or the host config), never the coordinator'),
  ...entries(['coordinator.sessions.max'], 'live', false, 'cap read by the session supervisor before it opens a session'),
  ...entries(['coordinator.sessions.threads', 'coordinator.sessions.threadIdleMinutes'], 'live', false, 'read by `coordinator route` and the session pass on each call'),
  ...entries(['dispatch'], 'live', false, 'the dispatcher re-reads it every pass (docs/design/autonomy.md Decision 1)'),
  ...entries(['env'], 'live', false, 'the dispatcher puts it into each new worker env (docs/design/autonomy.md Decision 4)'),
  // ---- restart
  ...entries(['execution.attemptMaxTurns'], 'restart', false, 'written into the agent definitions (plugin)'),
  ...entries(['communication.progress'], 'restart', false, 'prompt text'),
  ...entries(['models.default', 'models.allowed', 'models.selection', 'models.effortByRole.engineer', 'models.effortByRole.engineerDeep',
    'models.effortByRole.tester', 'models.effortByRole.reviewer'], 'restart', false, 'agent definitions and prompt'),
  ...entries(['models.coordinator', 'models.effort', 'models.effortByRole.coordinator'], 'restart', false, 'coordinator --model / --effort'),
  ...entries(['coordinator.toolSearch'], 'restart', false, 'coordinator --settings env'),
  ...entries(['models.router'], 'restart', false, 'router --model (sessions on)'),
  // ---- restart, host-owned
  ...entries(['communication.channel'], 'restart', true, 'coordinator --channels: decides who can steer the coordinator'),
  ...entries(['capabilities', 'sensitivePaths', 'architecture', 'intake.startReady'], 'restart', true,
    'policy and approvals (prompt plus runtime gates)'),
  ...entries(['delivery', 'verification.reviewerRequired'], 'restart', true,
    'what reaches the base branch through the local integrator, and with which checks'),
  ...entries(['coordinator.permissionMode', 'coordinator.sandbox', 'coordinator.sshHosts', 'coordinator.disallowedTools', 'coordinator.bundledSkills', 'permissionMode'], 'restart', true,
    'coordinator permissions'),
  ...entries(['coordinator.sessions.enabled'], 'restart', true, 'the wrapper starts the session supervisor, which starts headless coordinator sessions on its own (model spend)'),
  ...entries(['roles', 'workflows', 'harnesses'], 'restart', true, 'tools, edit scopes and process harnesses'),
  // ---- recreate
  ...entries(['git.identity'], 'recreate', false, 'applied only by workspace setup (install, upgrade or start)'),
  ...entries(['container.cpus', 'container.memoryMiB', 'container.pidsLimit', 'container.tmpSizeMiB'], 'recreate', false, 'compose resource limits'),
  ...entries(['container.aptPackages'], 'recreate', false,
    'a derived image built by `minions upgrade` or the `minions start` of a stopped container (the container is the boundary: packages add no power)'),
  ...entries(['container.network', 'container.publishPorts', 'container.mountHostRepository', 'container.mountDockerSocket'], 'recreate', true,
    'isolation of the container'),
  // ---- fixed
  ...entries(['schemaVersion', 'configRevision', 'projectId', 'packageVersion', 'mode', 'visibility', 'backlog', 'git.baseBranch',
    'container.required', 'container.workspace', 'execution.oneActiveStagePerTask'], 'fixed', false, 'identity, literals or derived: a re-setup'),
];

const covers = (entry: string, path: string) => path === entry || path.startsWith(entry + '.');

/** The most specific classification entry covering `path` (a dotted schema path), or undefined. */
export function classifyKey(path: string): KeyClass | undefined {
  let best: KeyClass | undefined;
  for (const e of KEY_CLASSES) if (covers(e.key, path) && (!best || e.key.length > best.key.length)) best = e;
  return best;
}

const unwrap = (s: z.ZodType): z.ZodType => {
  let cur = s;
  while (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable || cur instanceof z.ZodDefault) cur = cur.unwrap() as z.ZodType;
  return cur;
};

/**
 * Every leaf key of MinionsConfigSchema as a dotted path: objects are walked into, anything else (records,
 * arrays, unions, enums, literals) is a leaf. Catch-all entries (project roles) sit below their object's key.
 */
export function schemaKeyPaths(schema: z.ZodType = MinionsConfigSchema, prefix = ''): string[] {
  const s = unwrap(schema);
  if (!(s instanceof z.ZodObject)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodType>)) out.push(...schemaKeyPaths(v, prefix ? `${prefix}.${k}` : k));
  return out.length || !prefix ? out : [prefix];
}
