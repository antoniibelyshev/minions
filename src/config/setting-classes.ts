// Settings classification (docs/design/host-manager.md, "Settings classification (task-44)"): every key of the
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
// An entry covers its key and everything below it (`capabilities` covers `capabilities.git.push`); the most
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
  ...entries(['verification.commands', 'verification.qaLabels', 'verification.ciPendingTimeoutMinutes'], 'live', false,
    'briefs and the CI gate read them per lease'),
  ...entries(['intake.github'], 'live', false, '`minions sync` and coordinator startup read them per run'),
  ...entries(['intake.scope', 'intake.sources'], 'live', false, 'backlog readiness filter per call'),
  ...entries(['routine'], 'live', false, 'read by each routine pass (`minions sync --routine`) and the wrapper clock'),
  ...entries(['routine.enabled'], 'live', true, 'lets the runtime start coordinator sessions on its own (wakes, crash starts: model spend)'),
  // ---- restart
  ...entries(['execution.attemptMaxTurns'], 'restart', false, 'written into the agent definitions (plugin)'),
  ...entries(['budgets'], 'restart', false, 'prompt text only (not enforced in v0.1)'),
  ...entries(['communication.progress'], 'restart', false, 'prompt text'),
  ...entries(['models.default', 'models.allowed', 'models.selection', 'models.effortByRole.engineer', 'models.effortByRole.engineerDeep',
    'models.effortByRole.tester', 'models.effortByRole.reviewer'], 'restart', false, 'agent definitions and prompt'),
  ...entries(['models.coordinator', 'models.effort', 'models.effortByRole.coordinator'], 'restart', false, 'coordinator --model / --effort'),
  ...entries(['coordinator.toolSearch'], 'restart', false, 'coordinator --settings env'),
  // ---- restart, host-owned
  ...entries(['communication.channel'], 'restart', true, 'coordinator --channels: decides who can steer the coordinator'),
  ...entries(['capabilities', 'sensitivePaths', 'architecture', 'intake.startReady'], 'restart', true,
    'policy and approvals (prompt plus runtime gates)'),
  ...entries(['delivery', 'verification.testerRequired', 'verification.reviewerRequired', 'verification.ciAuthority'], 'restart', true,
    'what reaches GitHub, and with which checks'),
  ...entries(['coordinator.permissionMode', 'coordinator.disallowedTools', 'coordinator.bundledSkills', 'permissionMode'], 'restart', true,
    'coordinator permissions'),
  ...entries(['roles', 'workflows', 'harnesses'], 'restart', true, 'tools, edit scopes and process harnesses'),
  // ---- recreate
  ...entries(['git.identity'], 'recreate', false, 'applied only by workspace setup (install, upgrade or start)'),
  ...entries(['container.cpus', 'container.memoryMiB', 'container.pidsLimit', 'container.tmpSizeMiB'], 'recreate', false, 'compose resource limits'),
  ...entries(['container.network', 'container.publishPorts', 'container.mountHostRepository', 'container.mountDockerSocket'], 'recreate', true,
    'isolation of the container'),
  // ---- fixed
  ...entries(['schemaVersion', 'configRevision', 'projectId', 'packageVersion', 'profile', 'visibility', 'backlog', 'git.baseBranch',
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
