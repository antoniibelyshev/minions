import { DEFAULT_SENSITIVE_PATHS, defaultCapabilities } from './capabilities.js';
import type { MinionsConfig, Profile } from './schema.js';

export interface ProfileContext {
  hasGitHub: boolean;
  baseBranch: string;
  identity: { name: string; email: string };
  projectId: string;
  packageVersion: string;
}

/**
 * Explicit config values for a profile (spec §4). Where the profile's intent needs a feature this
 * build lacks (GitHub Issues, PR delivery, auto-merge, GitHub CI authority) the supported fallback is
 * used and a note explains it.
 */
export function profileDefaults(profile: Profile, ctx: ProfileContext): { config: MinionsConfig; notes: string[] } {
  const notes: string[] = [];
  const owner = profile === 'project-owner';
  const supervised = profile === 'supervised';

  if (owner && ctx.hasGitHub) {
    notes.push('unavailable: GitHub Issues backlog (project-owner default) is deferred in v0.1; using Backlog.md.');
    notes.push('unavailable: branch/PR delivery and auto-merge-when-eligible are deferred in v0.1; using local delivery with merge disabled.');
    notes.push('unavailable: GitHub CI authority requires PR delivery; verification.ciAuthority is "none".');
  } else if (profile === 'personal-work') {
    notes.push('unavailable: PR publication via the existing contribution process is deferred in v0.1; using local delivery.');
  }

  const config: MinionsConfig = {
    schemaVersion: 1,
    configRevision: 1,
    projectId: ctx.projectId,
    packageVersion: ctx.packageVersion,
    profile,
    visibility: owner ? 'shared' : 'private',
    backlog: { backend: 'backlogmd', ownership: owner ? 'direct' : supervised ? 'assigned' : 'personal', repository: null },
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
    delivery: {
      provider: 'none', mode: 'local', merge: 'disabled', method: 'squash', deleteMergedBranches: true,
      identityMode: 'git-identity', requireIndependentApproval: true, requiredChecksConfigured: false,
    },
    verification: { commands: [], testerRequired: true, reviewerRequired: true, ciAuthority: 'none' },
    communication: { channel: 'terminal', progress: 'milestones' },
    budgets: { taskUsd: null, dailyUsd: null },
    capabilities: defaultCapabilities(profile),
    sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
    architecture: owner ? 'decide' : 'propose',
    git: { baseBranch: ctx.baseBranch, identity: { ...ctx.identity } },
    permissionMode: 'acceptEdits',
  };
  return { config, notes };
}
