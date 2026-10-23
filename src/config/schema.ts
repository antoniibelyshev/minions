import { z } from 'zod';
import { isRequiredCoordinatorTool } from './coordinator-tools.js';

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

/** communication.channel values. */
export const CHANNELS = ['terminal', 'telegram', 'auto'] as const;
export type ChannelSetting = (typeof CHANNELS)[number];

const nonEmpty = z.string().min(1);
/** Model ids/aliases (e.g. `sonnet`, `claude-opus-4-1`, `opus[1m]`); rendered into agent frontmatter, so no whitespace or YAML syntax. */
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@\[\]-]*$/, 'must be a model id or alias (letters, digits, . _ : @ [ ] -)');
/** Git branch name; also passed to git argv, so it may not start with '-' or contain '..'. */
const branchName = z.string().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/, 'must be a plain git branch name');
const port = z.number().int().min(1).max(65535);
/** Claude Code reasoning effort levels (`--effort`, agent frontmatter `effort`; Claude Code 2.1.292). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

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
    /**
     * GitHub-filtered intake sync (src/runtime/intake-sync.ts): `minions sync` and coordinator startup import
     * matching issues into the backlog (read-only on GitHub, additive, idempotent). Unset or disabled = off.
     */
    github: z.object({
      enabled: z.boolean(),
      /** "owner/repo"; null = the workspace origin. */
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/repo"').nullable(),
      /** Issues must carry all of these labels. */
      labels: z.array(z.string().regex(/^[^,\r\n]+$/, 'must be non-empty, without commas or newlines')),
      /** GitHub login, "none" (unassigned) or "*" (any assignee); null = no assignee filter. */
      assignee: z.string().regex(/^(?:\*|none|[A-Za-z0-9][A-Za-z0-9-]{0,38})$/, 'must be a GitHub login, "none" or "*"').nullable(),
      /** Milestone title or number, "none" or "*"; null = no milestone filter. */
      milestone: z.string().regex(/^[^\r\n]+$/, 'must be a single non-empty line').nullable(),
      state: z.enum(['open', 'closed', 'all']),
    }).strict().optional(),
  }).strict(),
  container: z.object({
    required: z.literal(true),
    workspace: z.literal('named-volume'),
    cpus: z.number().positive(),
    memoryMiB: z.number().int().min(512),
    pidsLimit: z.number().int().min(64),
    /** Size cap (MiB) of the container's /tmp tmpfs, which is RAM counted against memoryMiB; unset = 1024. Large temp data goes to TMPDIR on disk. */
    tmpSizeMiB: z.number().int().min(64).optional(),
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
    default: modelId,
    allowed: z.array(modelId).min(1),
    selection: z.enum(['coordinator', 'fixed']),
    /** Reasoning effort for workers (agent frontmatter) and the coordinator (`--effort`); unset = Claude Code default. Fallback for `effortByRole`. */
    effort: z.enum(EFFORTS).optional(),
    /**
     * Per-role reasoning effort; each unset role falls back to `effort`. `engineerDeep` is the higher-effort
     * engineer definition (`minions:engineer-deep`); unset = one level above the engineer's (`high` when that is unset).
     */
    effortByRole: z.object({
      engineer: z.enum(EFFORTS).optional(),
      engineerDeep: z.enum(EFFORTS).optional(),
      tester: z.enum(EFFORTS).optional(),
      reviewer: z.enum(EFFORTS).optional(),
      coordinator: z.enum(EFFORTS).optional(),
    }).strict().optional(),
    /** Model of the coordinator session (`--model`); unset = Claude Code default. Must be in `allowed`. */
    coordinator: modelId.optional(),
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
    /** true: every task gets a tester stage (the old flow). false: only tasks that need QA (qaLabels, sensitive paths, reviewer needsQa). */
    testerRequired: z.boolean(),
    reviewerRequired: z.boolean(),
    /** Labels that opt a task into a tester stage; the first is added when the runtime records a QA need. Default ["qa"]. */
    qaLabels: z.array(nonEmpty).min(1).optional(),
    /**
     * "github": tester/reviewer stages may rely on passing required CI checks (branch protection or
     * rulesets on the base) observed by `minions sync` for the exact head under test/review, instead of
     * re-running the full verification locally (src/runtime/ci-gate.ts). Missing, failing, unknown or
     * pending-too-long CI never approves; the stage falls back to the full local verification (every verification.commands entry passing locally). "none": local only.
     */
    ciAuthority: z.enum(['none', 'github']),
    /** ciAuthority github: minutes required checks may stay pending (from the first observation of a head) before CI counts as timed out. Default 60. */
    ciPendingTimeoutMinutes: z.number().int().min(1).optional(),
  }).strict(),
  communication: z.object({
    /** "auto": Telegram when a bot token is stored and the runtime supports it, else terminal (src/telegram/channel.ts). */
    channel: z.enum(CHANNELS),
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
    baseBranch: branchName,
    identity: z.object({ name: nonEmpty, email: nonEmpty }).strict(),
  }).strict(),
  /** Coordinator session settings (src/runtime/coordinator.ts). */
  coordinator: z.object({
    /**
     * Claude Code permission mode of the coordinator session (container runtime). Unset = "auto": a
     * classifier may approve actions outside the allow list; the deny and ask rules still apply.
     * "acceptEdits" opts back into prompting for every non-allowlisted Bash call. Never bypassPermissions.
     */
    permissionMode: z.enum(['auto', 'acceptEdits']).optional(),
    /**
     * Claude Code tools removed from the coordinator session (`--disallowedTools`). Unset = the default
     * trim (COORDINATOR_DISALLOWED_TOOLS, src/config/coordinator-tools.ts); a list replaces it; [] keeps
     * every tool. Agent, SendMessage, Bash, Read/Edit/Write, Skill, the Telegram tools and the other
     * tools the coordinator needs cannot be listed. Takes effect at the next coordinator restart.
     */
    disallowedTools: z.array(nonEmpty).refine((l) => !l.some(isRequiredCoordinatorTool), {
      message: 'must not name a tool the coordinator needs (Agent, Task, SendMessage, TaskStop, ListAgents, PushNotification, AskUserQuestion, Bash, Read, Edit, Write, Grep, Glob, Skill, ToolSearch, Telegram MCP tools)',
    }).optional(),
    /**
     * Tool search for the coordinator (ENABLE_TOOL_SEARCH in the session's settings env): rarely used
     * tools are loaded on demand instead of sent in full with every request. Unset = on; false leaves
     * the choice to Claude Code.
     */
    toolSearch: z.boolean().optional(),
    /** Claude Code's bundled skills (dataviz, code-review, loop, ...) in the coordinator session. Unset = off; plugin skills (minions:*, telegram:*) always stay. */
    bundledSkills: z.boolean().optional(),
  }).strict().optional(),
  /**
   * Legacy coordinator permission mode. Only "default" is still honoured (as a stricter choice) when
   * coordinator.permissionMode is unset; "acceptEdits" and "auto" mean the default (auto).
   */
  permissionMode: z.enum(['default', 'acceptEdits', 'auto']).optional(),
}).strict();

export type MinionsConfig = z.infer<typeof MinionsConfigSchema>;

export function configJsonSchema(): Record<string, unknown> {
  return {
    title: 'Minions configuration',
    ...z.toJSONSchema(MinionsConfigSchema, { target: 'draft-2020-12', reused: 'ref' }),
  };
}
