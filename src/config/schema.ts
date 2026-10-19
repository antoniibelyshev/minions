import { z } from 'zod';

export const CAPABILITIES = [
  'task.read', 'task.create', 'task.update', 'task.start',
  'external.read', 'external.comment', 'external.changeStatus', 'external.create',
  'code.edit', 'dependencies.edit', 'architecture.change', 'migrations.edit',
  'git.commit', 'git.push',
  'pr.create', 'pr.review', 'pr.merge',
  'ci.edit', 'infrastructure.edit',
  'network.use',
  'deploy.execute',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ROLES = ['coordinator', 'engineer', 'tester', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const EffectSchema = z.enum(['allow', 'ask', 'deny']);
export type Effect = z.infer<typeof EffectSchema>;

export const CapabilityRuleSchema = z.union([
  EffectSchema,
  z.object({
    effect: EffectSchema,
    rules: z.array(z.object({
      effect: EffectSchema,
      roles: z.array(z.enum(ROLES)).min(1).optional(),
      paths: z.array(z.string().min(1)).min(1).optional(),
    }).strict()).optional(),
  }).strict(),
]);
export type CapabilityRule = z.infer<typeof CapabilityRuleSchema>;

export const CapabilitiesSchema = z.object(
  Object.fromEntries(CAPABILITIES.map((c) => [c, CapabilityRuleSchema])) as Record<Capability, typeof CapabilityRuleSchema>,
).strict();

export const PROFILES = ['project-owner', 'personal-work', 'supervised'] as const;
export type Profile = (typeof PROFILES)[number];

const nonEmpty = z.string().min(1);
const port = z.number().int().min(1).max(65535);

export const MinionsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  configRevision: z.number().int().min(1),
  projectId: z.uuid(),
  packageVersion: nonEmpty,
  profile: z.enum(PROFILES),
  visibility: z.enum(['shared', 'private']),
  backlog: z.object({
    backend: z.enum(['backlogmd', 'github']),
    ownership: z.enum(['direct', 'personal', 'assigned']),
    repository: z.string().nullable(),
  }).strict(),
  intake: z.object({
    sources: z.array(z.enum(['user', 'milestone', 'external'])).min(1),
    startReady: z.boolean(),
    scope: z.object({
      milestone: z.string().nullable(),
      externalAssignee: z.string().nullable(),
      requiredLabels: z.array(nonEmpty),
      allowedPaths: z.array(nonEmpty).min(1),
    }).strict(),
  }).strict(),
  container: z.object({
    required: z.literal(true),
    workspace: z.literal('named-volume'),
    cpus: z.number().positive(),
    memoryMiB: z.number().int().min(512),
    pidsLimit: z.number().int().min(64),
    publishPorts: z.array(z.object({ host: port, container: port }).strict()),
    network: z.enum(['outbound-internet', 'none']),
    mountHostRepository: z.boolean(),
    mountDockerSocket: z.boolean(),
  }).strict(),
  execution: z.object({
    maxActiveTasks: z.number().int().min(1),
    maxEngineers: z.number().int().min(1),
    oneActiveStagePerTask: z.literal(true),
    maxRepairCyclesBeforeReplan: z.number().int().min(1),
    attemptMaxTurns: z.number().int().min(1),
  }).strict(),
  models: z.object({
    default: nonEmpty,
    allowed: z.array(nonEmpty).min(1),
    selection: z.enum(['coordinator', 'fixed']),
  }).strict(),
  delivery: z.object({
    provider: z.enum(['none', 'github']),
    mode: z.enum(['local', 'branch', 'pull-request']),
    merge: z.enum(['disabled', 'manual', 'auto-when-eligible']),
    method: z.enum(['squash', 'merge', 'rebase']),
    deleteMergedBranches: z.boolean(),
    identityMode: z.enum(['git-identity', 'user-token', 'github-apps']),
    requireIndependentApproval: z.boolean(),
    requiredChecksConfigured: z.boolean(),
  }).strict(),
  verification: z.object({
    commands: z.array(nonEmpty),
    testerRequired: z.boolean(),
    reviewerRequired: z.boolean(),
    ciAuthority: z.enum(['none', 'github']),
  }).strict(),
  communication: z.object({
    channel: z.enum(['terminal', 'telegram']),
    progress: z.enum(['milestones', 'tasks', 'quiet']),
  }).strict(),
  budgets: z.object({
    taskUsd: z.number().positive().nullable(),
    dailyUsd: z.number().positive().nullable(),
  }).strict(),
  capabilities: CapabilitiesSchema,
  sensitivePaths: z.array(nonEmpty),
  architecture: z.enum(['decide', 'propose']),
  git: z.object({
    baseBranch: nonEmpty,
    identity: z.object({ name: nonEmpty, email: nonEmpty }).strict(),
  }).strict(),
  permissionMode: z.enum(['default', 'acceptEdits', 'auto']),
}).strict();

export type MinionsConfig = z.infer<typeof MinionsConfigSchema>;

export function configJsonSchema(): Record<string, unknown> {
  return {
    title: 'Minions configuration',
    ...z.toJSONSchema(MinionsConfigSchema, { target: 'draft-2020-12', reused: 'ref' }),
  };
}
