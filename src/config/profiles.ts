import { DEFAULT_SENSITIVE_PATHS, defaultCapabilities } from './capabilities.js';
import type { MinionsConfig, Profile } from './schema.js';

export interface ProfileContext {
  baseBranch: string;
  identity: { name: string; email: string };
  projectId: string;
  packageVersion: string;
}

/** Explicit config values for a profile (spec §4). */
export function profileDefaults(profile: Profile, ctx: ProfileContext): { config: MinionsConfig; notes: string[] } {
  const notes: string[] = [];
  const owner = profile === 'project-owner';
  const supervised = profile === 'supervised';

  const config: MinionsConfig = {
    schemaVersion: 1,
    configRevision: 1,
    projectId: ctx.projectId,
    packageVersion: ctx.packageVersion,
    profile,
    visibility: owner ? 'shared' : 'private',
    backlog: { backend: 'backlogmd', ownership: owner ? 'direct' : supervised ? 'assigned' : 'personal' },
    intake: {
      sources: owner ? ['user', 'milestone'] : supervised ? ['user'] : ['user', 'external'],
      startReady: !supervised, // supervised starts only tasks labelled minions:authorized
      scope: { milestone: null, externalAssignee: null, requiredLabels: [], allowedPaths: ['**'] },
    },
    container: {
      required: true, workspace: 'named-volume', cpus: 4, memoryMiB: 6144, pidsLimit: 512,
      publishPorts: [], network: 'outbound-internet', mountHostRepository: false, mountDockerSocket: false,
    },
    execution: {
      maxActiveTasks: supervised ? 1 : 2, maxEngineers: supervised ? 1 : 2,
      oneActiveStagePerTask: true, maxRepairCyclesBeforeReplan: 3, attemptMaxTurns: 80,
    },
    models: { default: 'sonnet', allowed: ['sonnet', 'opus', 'haiku'], selection: 'coordinator' },
    delivery: { merge: 'disabled' },
    verification: { commands: [], testerRequired: false, reviewerRequired: true },
    communication: { channel: 'auto', progress: 'milestones' },
    budgets: { taskUsd: null, dailyUsd: null },
    capabilities: defaultCapabilities(profile),
    sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
    architecture: owner ? 'decide' : 'propose',
    git: { baseBranch: ctx.baseBranch, identity: { ...ctx.identity } },
    // coordinator.permissionMode is left unset: the coordinator runs in "auto" (src/runtime/coordinator.ts).
    // coordinator.contextReset is left unset too: routine context resets are on by default (task-45).
  };
  return { config, notes };
}
