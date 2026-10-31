import { DEFAULT_SENSITIVE_PATHS, INDEPENDENT_SENSITIVE_PATHS, defaultCapabilities } from './capabilities.js';
import { MODES, type MinionsConfig, type Mode } from './schema.js';

export interface ModeContext {
  baseBranch: string;
  identity: { name: string; email: string };
  projectId: string;
  packageVersion: string;
}

/** The init profiles before the two modes: personal-work and supervised both meant an owner who merges. */
const LEGACY_PROFILES: Record<string, Mode> = { 'project-owner': 'independent', 'personal-work': 'supervised', supervised: 'supervised' };

/** A mode name, or the mode an old profile name maps to; undefined otherwise. */
export function toMode(v: unknown): Mode | undefined {
  if ((MODES as readonly unknown[]).includes(v)) return v as Mode;
  return typeof v === 'string' && Object.hasOwn(LEGACY_PROFILES, v) ? LEGACY_PROFILES[v] : undefined;
}

/** Explicit config values of a mode (docs/design/autonomy.md Decision 11). */
export function modeDefaults(mode: Mode, ctx: ModeContext): MinionsConfig {
  const independent = mode === 'independent';
  return {
    schemaVersion: 1,
    configRevision: 1,
    projectId: ctx.projectId,
    packageVersion: ctx.packageVersion,
    mode,
    visibility: independent ? 'shared' : 'private',
    backlog: { backend: 'backlogmd', ownership: independent ? 'direct' : 'assigned' },
    intake: {
      sources: independent ? ['user', 'milestone'] : ['user'],
      startReady: true,
      scope: { milestone: null, externalAssignee: null, requiredLabels: [], allowedPaths: ['**'] },
    },
    container: {
      required: true, workspace: 'named-volume', cpus: 4, memoryMiB: 6144, pidsLimit: 512,
      publishPorts: [], network: 'outbound-internet', mountHostRepository: false, mountDockerSocket: false,
    },
    execution: {
      maxActiveTasks: independent ? 3 : 2, maxEngineers: independent ? 2 : 1,
      oneActiveStagePerTask: true, maxRepairCyclesBeforeReplan: 3, attemptMaxTurns: 80,
    },
    models: { default: 'sonnet', allowed: ['sonnet', 'opus', 'haiku'], selection: 'coordinator' },
    delivery: { merge: independent ? 'auto-when-eligible' : 'disabled' },
    verification: { commands: [], testerRequired: false, reviewerRequired: true },
    communication: { channel: independent ? 'auto' : 'terminal', progress: 'milestones' },
    budgets: independent ? { taskUsd: 5, dailyUsd: 20 } : { taskUsd: null, dailyUsd: null },
    capabilities: defaultCapabilities(mode),
    sensitivePaths: [...(independent ? INDEPENDENT_SENSITIVE_PATHS : DEFAULT_SENSITIVE_PATHS)],
    architecture: independent ? 'decide' : 'propose',
    git: { baseBranch: ctx.baseBranch, identity: { ...ctx.identity } },
    // coordinator.permissionMode and contextReset stay unset: auto permission mode, routine context resets on.
    ...(independent ? {
      coordinator: { sessions: { enabled: true, threads: true } },
      routine: { enabled: true, digestAt: ['09:00'] },
    } : {}),
  };
}

/**
 * Keys a mode decides; `minions mode set` rewrites them in the project layer. Visibility is fixed at install, and
 * everything else (verification, container, models, roles, workflows) belongs to the project.
 */
export const MODE_KEYS = [
  'mode', 'backlog.ownership', 'intake.sources', 'intake.startReady', 'execution.maxActiveTasks', 'execution.maxEngineers',
  'delivery.merge', 'communication.channel', 'budgets', 'capabilities', 'sensitivePaths', 'architecture',
  'coordinator.sessions', 'routine',
] as const;
