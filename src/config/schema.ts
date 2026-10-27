import { z } from 'zod';
import { isRequiredCoordinatorTool } from './coordinator-tools.js';
import { HARNESS_IDS, PROCESS_HARNESS_IDS } from './harnesses.js';

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

/** Built-in role names (coordinator + the three built-in workers). Project roles extend this set (src/config/roles.ts). */
export const ROLES = ['coordinator', 'engineer', 'tester', 'reviewer'] as const;
export type BuiltinRole = (typeof ROLES)[number];
/**
 * A role name: a built-in or a project role from `roles` (docs/design/roles-and-workflows.md D8). Any string
 * type-checks; runtime boundaries validate it against the registry (`isRegisteredRole`; `can()` denies unknown roles).
 */
export type Role = string;

export const EffectSchema = z.enum(['allow', 'ask', 'deny']);
export type Effect = z.infer<typeof EffectSchema>;

export const CapabilityRuleSchema = z.union([
  EffectSchema,
  z.object({
    effect: EffectSchema,
    rules: z.array(z.object({
      effect: EffectSchema,
      /** Registered role names (built-ins or `roles` keys); checked by roleConfigIssues (src/config/roles.ts). */
      roles: z.array(z.string().min(1)).min(1).optional(),
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
/** A local clock time "HH:MM" (routine.digestAt). */
export const DIGEST_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** Whether Intl knows this IANA time zone (no dependency: the runtime's ICU data). */
export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
/** Claude Code reasoning effort levels (`--effort`, agent frontmatter `effort`; Claude Code 2.1.292). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** Result-contract variants (D4). */
export const ROLE_CONTRACTS = ['producer', 'verifier', 'gate'] as const;
export type RoleContract = (typeof ROLE_CONTRACTS)[number];
export const ROLE_WORKTREES = ['branch', 'review'] as const;
export type RoleWorktree = (typeof ROLE_WORKTREES)[number];
/** Backlog statuses a stage of the role sits in (D6). */
export const STAGE_STATUSES = ['implementing', 'testing', 'reviewing'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Claude Code tool names (or patterns); minions does not pin the list, only the character set (D3). */
const toolName = z.string().regex(/^[A-Za-z0-9_*()-]+$/, 'must be a tool name (letters, digits, _ * ( ) -)');
/** Prompt file relative to the config directory; checked further by roleConfigIssues. */
const promptFile = z.string().min(1);
const effectColumn = z.object(
  Object.fromEntries(CAPABILITIES.map((c) => [c, EffectSchema.optional()])) as Record<Capability, z.ZodOptional<typeof EffectSchema>>,
).strict();

/** A project-defined worker role (D3). */
export const CustomRoleSchema = z.object({
  description: nonEmpty,
  /** Markdown prompt body, relative to the config dir (e.g. `agents/researcher.md`). Exactly one of prompt / promptText. */
  prompt: promptFile.optional(),
  promptText: nonEmpty.optional(),
  contract: z.enum(ROLE_CONTRACTS),
  /** Default: `review` for gates, else `branch`. */
  worktree: z.enum(ROLE_WORKTREES).optional(),
  /** Default `none`. `review` worktrees imply `none`. */
  edits: z.union([z.enum(['none', 'any']), z.object({ paths: z.array(nonEmpty).min(1) }).strict()]).optional(),
  /** Default: true unless `edits` is `none`. `review` worktrees imply false. */
  commits: z.boolean().optional(),
  tools: z.array(toolName).min(1).optional(),
  /** Must be in the role harness's allowed models (models.allowed for claude). Default: that harness's default model. */
  model: modelId.optional(),
  /** Agent runtime of the role (docs/design/agent-runtimes.md D8); default harnesses.default where the phase allows it, else claude. */
  harness: z.enum(HARNESS_IDS).optional(),
  effort: z.enum(EFFORTS).optional(),
  /** Default execution.attemptMaxTurns. */
  maxTurns: z.number().int().min(1).optional(),
  /** Also generate `minions:<name>-deep`. */
  deepVariant: z.boolean().optional(),
  /** Default: `reviewing` for gates, `testing` for verifiers, `implementing` for producers. */
  stageStatus: z.enum(STAGE_STATUSES).optional(),
  /** Capabilities the stage cannot work without; a deny refuses the claim. */
  requires: z.array(z.enum(CAPABILITIES)).optional(),
  /** This role's column in the policy table (D8): each entry becomes a sub-rule `{effect, roles: [name]}`. */
  capabilities: effectColumn.optional(),
  /**
   * Gate/verifier roles: the role whose stage a `needs_changes` sends the task back to (D7). Default: the
   * nearest earlier producer stage that can commit. Checked by workflowConfigIssues (src/config/workflows.ts).
   */
  repairTo: nonEmpty.optional(),
}).strict();
export type CustomRoleConfig = z.infer<typeof CustomRoleSchema>;

/** Overrides a project may set on a built-in worker (D9); contract, stage status and policy column stay fixed. */
const builtinRoleOverride = {
  /** Appended to the built-in body under "Project instructions". At most one of promptAppend / prompt. */
  promptAppend: nonEmpty.optional(),
  /** File (relative to the config dir) appended like promptAppend. */
  prompt: promptFile.optional(),
  model: modelId.optional(),
  effort: z.enum(EFFORTS).optional(),
  maxTurns: z.number().int().min(1).optional(),
  /** Agent runtime (agent-runtimes D8); a process harness only where the current phase allows it for the role (D9). */
  harness: z.enum(HARNESS_IDS).optional(),
  /** May only remove tools from the built-in definition. */
  tools: z.array(toolName).min(1).optional(),
};
export const BuiltinRoleOverrideSchema = z.object(builtinRoleOverride).strict();
export const EngineerRoleOverrideSchema = z.object({
  ...builtinRoleOverride,
  /** Effort of `minions:engineer-deep`; mirrors models.effortByRole.engineerDeep and wins over it. */
  deepEffort: z.enum(EFFORTS).optional(),
}).strict();
export type BuiltinRoleOverride = z.infer<typeof EngineerRoleOverrideSchema>;

/**
 * `roles`: built-in overrides under their names, project roles under any other name. Name rules and
 * cross-field checks (prompt, model, tools, policy) are in roleConfigIssues (src/config/roles.ts).
 */
export const RolesSchema = z.object({
  engineer: EngineerRoleOverrideSchema.optional(),
  tester: BuiltinRoleOverrideSchema.optional(),
  reviewer: BuiltinRoleOverrideSchema.optional(),
}).catchall(CustomRoleSchema);

/** Models of a process harness: harness-native ids or aliases, chosen by the owner (agent-runtimes D8). */
const HarnessModelsSchema = z.object({ default: modelId, allowed: z.array(modelId).min(1) }).strict();
/** One process harness (`harnesses.codex`, `harnesses.junie`). */
export const ProcessHarnessSchema = z.object({
  models: HarnessModelsSchema,
  /** Reasoning effort of roles on this harness without their own (minions scale, mapped onto the harness's at launch). */
  effort: z.enum(EFFORTS).optional(),
  /** Wall clock per attempt (D3.6); default 60. */
  timeoutMinutes: z.number().int().min(1).max(24 * 60).optional(),
}).strict();
export type ProcessHarnessConfig = z.infer<typeof ProcessHarnessSchema>;
/**
 * Agent runtimes (docs/design/agent-runtimes.md D8). Unset = every worker runs on Claude Code. Cross-field checks
 * (referenced blocks, phase rules, models) are in harnessConfigIssues (src/config/roles.ts).
 */
export const HarnessesSchema = z.object({
  /** Harness of every worker role without its own `harness`, where the current phase allows it (D9); default claude. */
  default: z.enum(HARNESS_IDS).optional(),
  ...(Object.fromEntries(PROCESS_HARNESS_IDS.map((id) => [id, ProcessHarnessSchema.optional()])) as Record<(typeof PROCESS_HARNESS_IDS)[number], z.ZodOptional<typeof ProcessHarnessSchema>>),
  network: z.object({
    /** Landlock TCP connect allowlist for every process worker (D4); never empty (the harness itself needs 443). */
    tcpConnectPorts: z.array(port).min(1, 'must list at least one port (the harness itself needs 443)'),
  }).strict().optional(),
}).strict();
export type HarnessesConfig = z.infer<typeof HarnessesSchema>;

/** Conditions of a conditional workflow stage (D5): `qa` = run only when the task needs QA. */
export const STAGE_WHEN = ['qa'] as const;
/**
 * One workflow stage (D5): a role name, or `{ role, when?, model? }`; `model` is a model hint validated against the
 * stage role's harness (models.allowed for claude). A hint never names a harness (agent-runtimes D8).
 */
export const WorkflowStageSchema = z.union([
  nonEmpty,
  z.object({ role: nonEmpty, when: z.enum(STAGE_WHEN).optional(), model: modelId.optional() }).strict(),
]);
export type WorkflowStageConfig = z.infer<typeof WorkflowStageSchema>;
/**
 * Named workflows (D5): ordered stage lists. `default` replaces the derived default workflow. Names and
 * invariants (roles exist, gate after the last committing stage) are checked by workflowConfigIssues.
 */
export const WorkflowsSchema = z.record(z.string(), z.array(WorkflowStageSchema).min(1));

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
    /** Alias of maxByRole.engineer (kept for older configs); when both are set they must agree. */
    maxEngineers: z.number().int().min(1).optional(),
    /** Concurrent leases per worker role (`-deep` variants count as their base role); a role without a limit is bounded by maxActiveTasks only. */
    maxByRole: z.record(z.string(), z.number().int().min(1)).optional(),
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
  /** Built-in role overrides and project-defined worker roles (docs/design/roles-and-workflows.md D3, D9). */
  roles: RolesSchema.optional(),
  /** Named per-task workflows (docs/design/roles-and-workflows.md D5); unset = only the derived default. */
  workflows: WorkflowsSchema.optional(),
  /** Agent runtimes per role (docs/design/agent-runtimes.md D8); unset = every worker runs on Claude Code. */
  harnesses: HarnessesSchema.optional(),
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
    /**
     * Routine context resets (src/runtime/context-reset.ts): the coordinator writes a short handoff
     * (`minions coordinator handoff`) and restarts itself with a fresh context when no worker lease is active
     * and a trigger holds. Unset = on with the defaults (existing and new projects alike);
     * `{ enabled: false }` is the opt-out. Unset trigger fields take their defaults; `null` turns that trigger off.
     */
    contextReset: z.object({
      enabled: z.boolean(),
      /** Reset once a task was delivered in this session (default true). */
      afterDelivery: z.boolean().optional(),
      /** Reset once the session's context (latest transcript usage) reaches this many tokens (default 60000). */
      contextTokens: z.number().int().min(1000).nullable().optional(),
      /** Reset after this many worker hand-offs (records and releases) in this session (default 10). */
      handoffs: z.number().int().min(1).nullable().optional(),
    }).strict().optional(),
  }).strict().optional(),
  /**
   * Unattended routine (docs/design/unattended-delivery.md, phase 1; src/runtime/routine.ts): a deterministic pass
   * (`minions sync --routine`: intake, PR and CI sync, merge pass, wake decision) every `tickMinutes`, run by the
   * coordinator wrapper's clock (the host manager is the watchdog). It wakes the coordinator with a fresh session only
   * when a model is needed. Unset = off; every unset field takes its default.
   */
  routine: z.object({
    /** Default false: no clock, no watchdog pass, no wake or crash start. */
    enabled: z.boolean().optional(),
    /** Minutes between routine passes (default 15). */
    tickMinutes: z.number().int().min(1).max(1440).optional(),
    /** Minimum minutes between two coordinator wakes (default 30). */
    minWakeGapMinutes: z.number().int().min(1).optional(),
    /** Coordinator wakes per day in `timezone` (default 8; the digest wake always counts and is always allowed). */
    maxWakesPerDay: z.number().int().min(0).optional(),
    /**
     * Local digest times, "HH:MM" in `timezone` (default ["08:00"], phase 4): the routine wakes the coordinator to
     * send one digest with the held notifications and questions; a missed time is caught up at the next pass.
     */
    digestAt: z.array(z.string().regex(DIGEST_TIME, 'must be HH:MM (00:00 to 23:59)')).min(1).max(4).optional(),
    /** IANA time zone of digestAt and of the routine's days (default Europe/Berlin). */
    timezone: z.string().min(1).refine(isTimeZone, 'must be an IANA time zone such as Europe/Berlin').optional(),
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
