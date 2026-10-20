import { DEFAULT_SENSITIVE_PATHS, defaultCapabilities } from './capabilities.js';
import type { MinionsConfig, Profile } from './schema.js';

export interface ProfileContext {
  hasGitHub: boolean;
  /** A GitHub token is stored for this project (`minions auth github`). Branch/PR delivery needs both. */
  hasGitHubCredential?: boolean;
  baseBranch: string;
  identity: { name: string; email: string };
  projectId: string;
  packageVersion: string;
}

/** Why branch/PR delivery cannot be selected, or null when a GitHub remote and a stored token exist. */
export function githubDeliveryUnavailableReason(ctx: Pick<ProfileContext, 'hasGitHub' | 'hasGitHubCredential'>): string | null {
  if (!ctx.hasGitHub) return 'the repository has no GitHub remote (origin is not on github.com)';
  if (!ctx.hasGitHubCredential) return 'no GitHub token is stored for this project (run `minions auth github`, then set delivery.mode)';
  return null;
}

/**
 * Explicit config values for a profile (spec §4). Where the profile's intent needs a feature this
 * build lacks (GitHub Issues, auto-merge, GitHub CI authority) or a prerequisite is missing (PR
 * delivery without a GitHub remote and token) the supported fallback is used and a note explains it.
 */
export function profileDefaults(profile: Profile, ctx: ProfileContext): { config: MinionsConfig; notes: string[] } {
  const notes: string[] = [];
  const owner = profile === 'project-owner';
  const supervised = profile === 'supervised';

  const githubBlocked = githubDeliveryUnavailableReason(ctx);
  // project-owner publishes through pull requests when it can; the others start local (personal-work
  // may opt in; each push then needs recorded human approval because git.push is "ask").
  const prDelivery = owner && githubBlocked === null;
  if (owner && ctx.hasGitHub) {
    notes.push('unavailable: GitHub Issues backlog (project-owner default) is deferred in v0.1; using Backlog.md.');
    if (githubBlocked) notes.push(`unavailable: pull-request delivery (project-owner default) needs a GitHub remote and token: ${githubBlocked}; using local delivery.`);
    notes.push('unavailable: auto-merge-when-eligible is deferred in v0.1; merge stays disabled (minions never merges).');
    notes.push('unavailable: GitHub CI authority is deferred in v0.1; verification.ciAuthority is "none".');
  } else if (profile === 'personal-work') {
    notes.push(githubBlocked
      ? `unavailable: pull-request delivery needs a GitHub remote and token: ${githubBlocked}; using local delivery.`
      : 'pull-request delivery is available (set delivery.mode "pull-request"); every push then needs recorded human approval (git.push is "ask").');
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
      provider: prDelivery ? 'github' : 'none', mode: prDelivery ? 'pull-request' : 'local', merge: 'disabled', method: 'squash', deleteMergedBranches: true,
      identityMode: 'git-identity', requireIndependentApproval: true, requiredChecksConfigured: false,
    },
    verification: { commands: [], testerRequired: false, reviewerRequired: true, ciAuthority: 'none' },
    communication: { channel: 'auto', progress: 'milestones' },
    budgets: { taskUsd: null, dailyUsd: null },
    capabilities: defaultCapabilities(profile),
    sensitivePaths: [...DEFAULT_SENSITIVE_PATHS],
    architecture: owner ? 'decide' : 'propose',
    git: { baseBranch: ctx.baseBranch, identity: { ...ctx.identity } },
    // coordinator.permissionMode is left unset: the coordinator runs in "auto" (src/runtime/coordinator.ts).
  };
  return { config, notes };
}
