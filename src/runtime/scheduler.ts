import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BacklogAdapter, ScopeFilter, Task, TaskStatus } from '../backlog/types.js';
import { can, matchesAny } from '../config/capabilities.js';
import { isGithubDelivery } from '../config/delivery.js';
import { notReadyReason, sortByPriority } from '../backlog/ready.js';
import { CURRENT_PHASE, HARNESSES, harnessModels, isHarnessId, isProcessHarness, phaseAllows, type HarnessId, type PhaseRules } from '../config/harnesses.js';
import { launchFor, type Launch } from '../config/launch.js';
import { suggestModel, type ModelSuggestion } from '../config/models.js';
import { baseRoleName, defaultMovedGates, ENGINEER_ROLE, exactWorkerRole, harnessRoleEffort, TESTER_ROLE, roleLimit, workerRole, workerRoleNames, type RoleDef } from '../config/roles.js';
import type { MinionsConfig, RoleContract } from '../config/schema.js';
import {
  claimableStatuses, configuredStages, contractOf, derivePosition, finalGateIndex, nextRunnable, parseStages, positionForRole, repairTarget,
  resolveWorkflow, sameStages, stageStatusOf, statusesAt, verifierBefore, withQaTester, workflowNames, type Stage, type Workflow,
} from '../config/workflows.js';
import { verifyApproval } from '../core/approval.js';
import { MinionsError } from '../core/errors.js';
import { syncBaseFromOrigin, type BaseSyncResult } from './base-sync.js';
import type { BuiltinLeaseRole, Lease, LeaseRole, PublicationState, RuntimeDb } from './db.js';
import { removeLeaseFiles, type HandoffPaths } from './handoff.js';
import { corruptRecordHint, hasOpenRun, readRunRecord, removeRunRecord } from './runner/record.js';
import { missingApprovalKeyReason, runtimePaths } from './paths.js';
import { ORIGIN_REPOSITORY_META, publishTask, realGh, serverOriginOf, type GhFn, type PublishInput, type PublishOutcome } from './publish.js';
import type { ServerOrigin, ServerUrlFn } from './base-update.js';
import { isCiCheck, resultContractText, validateResult, type WorkerResult } from './results.js';
import { assertBudgetAllowsStart, billingOf, budgetNotice, latestLeaseUsage, recordLeaseUsage, tokensFromResultUsage, type Billing, type BudgetNotice, type SpendContext } from './spend.js';
import { readRequiredChecks, type RequiredChecksReport } from './ci.js';
import { ciGateFromDb, formatCiGate, type CiGate } from './ci-gate.js';
import { autoMergeTask, type MergeResult } from './merge.js';
import { gateGit } from './git-hardening.js';
import { BRANCH_PREFIX, branchFor, ensureBranchWorktree, ensureReviewWorktree, git, headOf, resolveBaseBranch, taskSlug, workspaceLayout, type WorkspaceLayout } from './worktree.js';

export const LEASE_ROLES: readonly BuiltinLeaseRole[] = ['engineer', 'tester', 'reviewer'];

/** Backlog statuses a role may be claimed from. */
export const ROLE_STATUSES: Record<BuiltinLeaseRole, TaskStatus[]> = {
  engineer: ['ready', 'changes-requested'],
  tester: ['testing'],
  reviewer: ['reviewing'],
};

/** Statuses that occupy active-task capacity even between worker stages. Blocked/human-waiting tasks do not. */
export const IN_FLIGHT: TaskStatus[] = ['implementing', 'testing', 'reviewing', 'changes-requested', 'awaiting-ci', 'merging'];

export interface SchedulerDeps {
  db: RuntimeDb;
  backlog: BacklogAdapter;
  config: MinionsConfig;
  layout?: WorkspaceLayout;
  /** Branch/PR publisher (tests inject one with mocked git/gh). */
  publisher?: (input: PublishInput) => Promise<PublishOutcome>;
  /** Where briefs and submitted results live; their files are removed whenever a lease ends. Omitted: no file cleanup. */
  handoff?: HandoffPaths;
  /** GitHub delivery: pre-claim fetch + fast-forward of the base from origin (tests may inject one). */
  baseSync?: (repo: string, base: string) => Promise<BaseSyncResult>;
  /** Public key verifying host-signed publication approvals (default: runtimePaths().approvalPublicKey). */
  approvalPublicKeyFile?: string;
  /** gh for read-only CI lookups (required checks); tests inject a mock. Default: the PATH wrapper. */
  gh?: GhFn;
  /** Clock for the CI pending timeout and the spend tally (tests). */
  now?: () => Date;
  /** API-key billing or a Claude subscription (default: MINIONS_AUTH_METHOD); only units and wording differ. */
  billing?: Billing;
  /** Harness phase rules (docs/design/agent-runtimes.md D9); default CURRENT_PHASE. Tests inject later phases. */
  phase?: PhaseRules;
  /** Process-harness run records (agent-runtimes D3b). Omitted: no run records are consulted (tests of other paths). */
  runs?: RunControl;
  /**
   * Test seam: where git reaches the recorded origin URL for the verified base reads and the push
   * (base-update.ts ServerUrlFn; default the URL itself). Only code sets it, never config or the environment.
   */
  serverUrl?: ServerUrlFn;
}

/**
 * Run-record hooks of the scheduler (agent-runtimes D3b, task-14.5): `reap` (reapRun) runs before a release ends
 * the lease and may throw to refuse it; claims are refused while a lease of the task has a record that is not
 * `done`; `done` records are removed once their lease ended.
 */
export interface RunControl { state: string; reap(leaseId: string): Promise<{ note: string | null }> }

/** The worker's token total from the coordinator's task notification (`--usage`); cumulative per agent. */
export interface UsageFlag { tokens: number; model?: string | null }

/** Result of a publication attempt (`minions work publish`, or embedded in a record response). */
export interface PublishResponse {
  taskId: string; branch: string; headSha: string; mode: string;
  state: PublicationState; status: TaskStatus; prUrl: string | null;
  /** True only when the pull request is merged (task `done`); an open PR is `delivered`, never merged. */
  merged: boolean;
  /** delivery.merge "auto-when-eligible": the auto-merge pass that followed delivery (src/runtime/merge.ts). */
  merge?: MergeResult;
  push?: 'pushed' | 'already-current'; pr?: 'created' | 'existing' | null;
  reasons?: string[]; sensitivePaths?: string[];
  /** awaiting-approval: why no recorded approval was accepted (missing, invalid signature, other head, expired). */
  approvalError?: string;
  errorCode?: string; retryable?: boolean;
  message: string;
}

/** Lease usage of one worker role; `limited` = an execution.maxByRole (or maxEngineers) limit is set, else max = maxActiveTasks. */
export interface RoleCapacity { active: number; max: number; free: number; limited: boolean }

export interface Capacity {
  activeTaskIds: string[];
  /** Kept for older coordinators: same as byRole.engineer. */
  activeEngineers: number;
  maxActiveTasks: number;
  /** Kept for older coordinators: byRole.engineer.max. */
  maxEngineers: number;
  freeTaskSlots: number;
  /** Kept for older coordinators: byRole.engineer.free. */
  freeEngineerSlots: number;
  /** Every registered worker role (`-deep` variants count as their base role). */
  byRole: Record<string, RoleCapacity>;
}

/** The harness a lease was claimed on; null (a lease from before schema 7) or an unknown id = claude. */
export const leaseHarness = (l: Pick<Lease, 'harness'>): HarnessId => (isHarnessId(l.harness) ? l.harness : 'claude');

/** Labels that opt a task into a per-task tester stage (verification.qaLabels, default ["qa"]). */
export const qaLabelsOf = (cfg: MinionsConfig): string[] => cfg.verification.qaLabels ?? ['qa'];

/**
 * A task with this label is a QA sweep: a tester runs it against the current base branch (not a
 * ticket branch), claimed from `ready`; its findings become new backlog tasks.
 */
export const QA_SWEEP_LABEL = 'qa-sweep';
export const isQaSweep = (task: Pick<Task, 'labels'>): boolean => task.labels.includes(QA_SWEEP_LABEL);

/**
 * A task's position in its workflow (docs/design/roles-and-workflows.md D6): the stage list (with runtime
 * insertions) and the index of the current stage. Stored in task_stages by claim and record.
 */
export interface StagePlan { workflow: string; stages: Stage[]; position: number }


/** One stage `minions work next` lists (D12): claim it with `work claim <taskId>`, spawn `agentType`. */
export interface NextStage {
  taskId: string; title: string; status: TaskStatus; priority: Task['priority'];
  /** "qa-sweep": a tester against the base branch (no workflow, position or count). */
  kind: 'task' | 'qa-sweep';
  role: string;
  /** The Agent `subagent_type`: `minions:<role>`, or `minions:<role>-deep` for risk:high / a repair after a failed attempt. */
  agentType: string;
  position: number | null; count: number | null; workflow: string | null;
  /** D12: stage hint > role model > risk rule > models.default (always the default with selection "fixed"). */
  suggestedModel: string;
  /** The Agent call's `model`: null = omit it (the definition runs suggestedModel, or it is a full ID). */
  agentModel: string | null;
  modelRule: ModelSuggestion['rule'];
  /** The stage role's agent runtime (agent-runtimes D8); `claude` unless the role is on a process harness. */
  harness: HarnessId;
  /**
   * How to start the stage: `agent` = Agent tool with agentType / agentModel (as above); `run` = claim, then the
   * runner command with the lease id (process harness).
   */
  launch: Launch;
  reason: string;
}

/** A stage that could run but cannot start now. */
export interface WaitingStage extends NextStage {
  /**
   * starts: paused, draining or the owner budget; capacity: active task limit; role-capacity: execution.maxByRole;
   * harness-capacity: the phase cap on process-harness producers (agent-runtimes D9); requires: a stage capability not allowed.
   */
  waitingOn: 'starts' | 'capacity' | 'role-capacity' | 'harness-capacity' | 'requires';
  why: string;
}

/** A task in a stage status without a lease from which no stage can be claimed (or whose workflow is not configured). */
export interface StuckTask { taskId: string; status: TaskStatus; reason: string }

export interface NextReport {
  runnable: NextStage[];
  waiting: WaitingStage[];
  stuck: StuckTask[];
  /** Why nothing may start (the error a claim would return), or null. */
  startsBlocked: { code: string; message: string; hint?: string } | null;
  capacity: Capacity;
  message: string;
  /**
   * Config notes the coordinator should relay (absent when there are none): gate roles that `harnesses.default`
   * moved onto a process harness (agent-runtimes D8). Config validation has no warning channel.
   */
  warnings?: string[];
}

/** Why a task needs a tester stage; empty = engineer → reviewer only. `record` = add the QA label to the task. */
export interface QaRequirement { reasons: string[]; record: boolean }

/** Readiness scope from config (mirrors backlog/commands scopeOf, kept local so hooks don't load the CLI module). */
export const scopeOf = (cfg: MinionsConfig): ScopeFilter => ({
  milestone: cfg.intake.scope.milestone, requiredLabels: [...cfg.intake.scope.requiredLabels], allowedPaths: [...cfg.intake.scope.allowedPaths],
});

/** Active tasks = tasks with an active lease ∪ tasks in an in-flight status. */
export function capacityOf(config: MinionsConfig, leases: Lease[], tasks: Task[]): Capacity {
  const ids = new Set(leases.map((l) => l.task_id));
  for (const t of tasks) if (IN_FLIGHT.includes(t.status)) ids.add(t.id);
  const { maxActiveTasks } = config.execution;
  const byRole: Record<string, RoleCapacity> = {};
  for (const role of workerRoleNames(config)) {
    const limit = roleLimit(config, role);
    const max = limit ?? maxActiveTasks;
    const active = leases.filter((l) => baseRoleName(config, l.role) === role).length;
    byRole[role] = { active, max, free: Math.max(0, max - active), limited: limit !== undefined };
  }
  const eng = byRole[ENGINEER_ROLE]!;
  return {
    activeTaskIds: [...ids].sort(), activeEngineers: eng.active, maxActiveTasks, maxEngineers: eng.max,
    freeTaskSlots: Math.max(0, maxActiveTasks - ids.size),
    freeEngineerSlots: eng.free,
    byRole,
  };
}

export interface TaskBrief {
  briefMarker: string;
  leaseId: string;
  role: LeaseRole;
  /** "qa-sweep": a tester checks the base branch head (detached, nothing to commit); "task": a ticket branch. */
  kind: 'task' | 'qa-sweep';
  attempt: number;
  task: {
    id: string; locator: string; title: string; description: string; objective: string;
    acceptanceCriteria: { text: string; done: boolean }[];
    nonGoals: string[]; dependencies: string[]; labels: string[]; parent: string | null; externalLinks: string[];
  };
  relevantDecisions: string[];
  relevantFiles: string[];
  branch: string;
  worktree: string;
  baseBranch: string;
  baseSha: string;
  expectedHead: string;
  verificationCommands: string[];
  authorizedCommands: string[];
  publication: Record<string, string>;
  policy: { taskStart: string; codeEdit: string; gitCommit: string; sensitivePaths: string[]; architecture: string };
  model: string;
  allowedModels: string[];
  effort: string | null;
  /** The role's agent runtime (docs/design/agent-runtimes.md D8); `claude` = an Agent-tool subagent, as before. */
  harness: HarnessId;
  maxTurns: number;
  configRevision: number;
  deliveryMode: string;
  priorFindings: { leaseId: string; role: string; status: string; findings: unknown[]; nextAction: string }[];
  /** Present when the previous stage of this task was wound down by a drain (upgrade): continue from its checkpoint. */
  resume?: DrainResume;
  /**
   * Tester/reviewer with verification.ciAuthority "github": the CI evidence gate for expectedHead at claim
   * time. Only `state: "pass"` lets the worker rely on CI instead of re-running the full verification.
   */
  ci?: CiGate;
  /**
   * The lease's own disk-backed, exec-allowed scratch dir (set by claimWithBrief): the worker uses it as TMPDIR
   * for test runs and tools. Removed when the lease ends and on coordinator start; absent = use the inherited TMPDIR.
   */
  scratchDir?: string;
  /** The workflow stage this lease runs (absent for a QA sweep, which ignores workflows). */
  stage?: { workflow: string; position: number; count: number; role: string; model?: string };
  /**
   * Project roles only (D3): what this stage may change, enforced at record time on the stage diff (claim head
   * to result head). `none`: no commits; `{paths}`: only these globs; `any`: unrestricted.
   */
  editScope?: { edits: 'none' | 'any' | { paths: string[] }; commits: boolean };
  /** The result contract of the role's variant (D4: producer, verifier, gate). */
  resultContract: string;
}

/** The checkpoint a drained worker left: its partial result and the head it committed (`wip:` commit). */
export interface DrainResume {
  fromLeaseId: string; role: LeaseRole; reason: 'drain'; headSha: string | null;
  summary: string; remainingWork: unknown[]; nextAction: string; instruction: string;
}

export interface RecordResponse {
  leaseId: string; taskId: string; role: LeaseRole; valid: boolean;
  errors?: string[]; correctionAllowed?: boolean; unvalidated?: boolean;
  from?: TaskStatus; to?: TaskStatus; approved: boolean; replan: boolean; needsSplit: boolean;
  repairCycles?: number; headSha?: string; message: string;
  /** A partial result returned because of a drain (upgrade): not a failed attempt or a repair cycle. */
  drain?: boolean;
  /** Present when the approval started branch/PR publication. */
  publication?: PublishResponse;
  /** The token total stored for this lease (from --usage, else the result's usage block). */
  usage?: { tokens: number; model: string | null; source: string };
  /** Budget state after this record; `crossed` = a 50/80/100% threshold reached now (report it). */
  budget?: BudgetNotice;
}


const newLeaseId = () => `lease-${randomBytes(6).toString('hex')}`;
const nowIso = () => new Date().toISOString();

/**
 * Command text reduced to what ran: the last `&&`/`;` segment with leading `VAR=value` assignments removed,
 * so `mkdir -p x && TMPDIR=x npm test` matches the configured `npm test`. Still an exact match otherwise.
 */
export function normalizeCheckCommand(command: string): string {
  const last = command.split(/&&|;/).map((p) => p.trim()).filter(Boolean).pop() ?? '';
  return last.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim();
}

/** The full configured verification passed locally (source not ci); with no commands configured, any passing local check. */
export function localVerificationComplete(checks: { command: string; outcome: string; source?: 'local' | 'ci' }[], configured: string[]): boolean {
  const passed = checks.filter((c) => !isCiCheck(c) && c.outcome === 'pass');
  if (!configured.length) return passed.length > 0;
  const ran = new Set(passed.map((c) => normalizeCheckCommand(c.command)));
  return configured.every((cmd) => ran.has(normalizeCheckCommand(cmd)));
}

export class Scheduler {
  readonly db: RuntimeDb;
  readonly backlog: BacklogAdapter;
  readonly config: MinionsConfig;
  readonly layout: WorkspaceLayout;
  private readonly publisher: (input: PublishInput) => Promise<PublishOutcome>;
  private readonly handoff: HandoffPaths | null;
  private readonly baseSync: (repo: string, base: string) => Promise<BaseSyncResult>;
  private readonly approvalPublicKeyFile: string;
  private readonly gh: GhFn;
  private readonly now: () => Date;
  private readonly runs: RunControl | null;
  private readonly serverUrl: ServerUrlFn | undefined;

  constructor(deps: SchedulerDeps) {
    this.serverUrl = deps.serverUrl;
    this.runs = deps.runs ?? null;
    this.db = deps.db; this.backlog = deps.backlog; this.config = deps.config;
    this.layout = deps.layout ?? workspaceLayout();
    this.handoff = deps.handoff ?? null;
    this.publisher = deps.publisher ?? publishTask;
    this.baseSync = deps.baseSync ?? ((repo, base) => syncBaseFromOrigin(repo, base, {
      gh: this.gh, ...this.originOpts(), ...(this.serverUrl ? { serverUrl: this.serverUrl } : {}),
    }));
    this.approvalPublicKeyFile = deps.approvalPublicKeyFile ?? runtimePaths().approvalPublicKey;
    this.gh = deps.gh ?? realGh;
    this.now = deps.now ?? (() => new Date());
    this.billing = deps.billing ?? billingOf();
    this.phase = deps.phase ?? CURRENT_PHASE;
  }

  private readonly phase: PhaseRules;

  private readonly billing: Billing;
  spendContext(): SpendContext { return { db: this.db, billing: this.billing, config: this.config, now: this.now() }; }

  /**
   * Stores the lease's token total: the coordinator's --usage, else the result's usage block. Recorded
   * before the transition so spend is kept even when the record is rejected; the latest figure per lease
   * counts, so re-recording (or a correction) never double-counts.
   *
   * Precedence (task-14.16): a measured figure beats a self-reported one. Measured means any stored source
   * other than `result` (runner = the process harness's own count, record/release = coordinator --usage,
   * manual = `work spend --lease`). The result file is written by the worker and may be hand-edited, so its
   * usage block only fills in when the lease has no measured figure yet; otherwise the stored figure is
   * kept and returned unchanged. An explicit coordinator --usage still always wins and is stored.
   */
  private noteUsage(lease: Lease, raw: unknown, flag: UsageFlag | undefined, source: 'record' | 'release'): RecordResponse['usage'] {
    let tokens = flag?.tokens ?? null;
    let model = flag?.model ?? null;
    let from: 'record' | 'release' | 'result' = source;
    if (raw !== undefined) {
      const v = validateResult(raw);
      if (v.ok && v.result.usage) {
        model ??= v.result.usage.model ?? null;
        if (tokens === null) { tokens = tokensFromResultUsage(v.result.usage); from = 'result'; }
      }
    }
    if (tokens === null) return undefined;
    if (from === 'result') {
      const stored = latestLeaseUsage(this.db, lease.id);
      if (stored && stored.source !== 'result') return stored;
    }
    recordLeaseUsage(this.db, lease.id, { tokens, model, source: from });
    return { tokens, model, source: from };
  }

  private withBudget<T extends object>(r: T, usage: RecordResponse['usage']): T & Pick<RecordResponse, 'usage' | 'budget'> {
    const budget = budgetNotice(this.spendContext()) ?? undefined;
    return { ...r, ...(usage ? { usage } : {}), ...(budget ? { budget } : {}) };
  }

  /**
   * CI evidence gate for a task head (src/runtime/ci-gate.ts): required checks read now (read-only gh
   * api), observations from `minions sync`. Never throws; unreadable required checks are `unknown`.
   * Shared by the tester/reviewer stages and the merge gate (task-1.9).
   */
  async ciGate(taskId: string, head: string): Promise<CiGate> {
    let required: RequiredChecksReport | null = null;
    if (this.config.verification.ciAuthority === 'github') {
      try { required = await readRequiredChecks(this.layout.repo, this.config, { git, gh: this.gh }); } catch { required = null; }
    }
    return ciGateFromDb(this.db, this.config, taskId, head, required, this.now());
  }

  list(opts: { all?: boolean; taskId?: string } = {}): Lease[] { return this.db.leases(opts); }

  async capacity(): Promise<Capacity> {
    return capacityOf(this.config, this.db.activeLeases(), await this.backlog.listTasks());
  }

  /** Branch for a task: recorded branch, else an earlier lease's branch, else agent/<slug>. */
  private branchForTask(task: Task): { slug: string; branch: string } {
    // Only agent/ branches: a QA sweep's tester lease records the base branch, which must never be reused.
    const prior = this.db.leases({ taskId: task.id, all: true }).find((l) => l.branch?.startsWith(BRANCH_PREFIX))?.branch;
    const branch = (task.branch && task.branch.startsWith(BRANCH_PREFIX) ? task.branch : null) ?? prior ?? branchFor(taskSlug(task.id, task.title));
    return { branch, slug: branch.slice(BRANCH_PREFIX.length) };
  }

  /** The workflow a task runs (D5): its assigned name, else the default. A name no longer configured is refused. */
  workflowOf(task: Task): Workflow {
    const wf = resolveWorkflow(this.config, task.workflow);
    if (!wf) {
      throw new MinionsError('PRECONDITION', `Task ${task.id} uses workflow "${task.workflow}", which is not configured (configured: ${workflowNames(this.config).join(', ')}).`,
        `Assign a configured workflow (minions backlog update ${task.id} --expected-version <v> --workflow <name>) or ask the owner to configure it.`);
    }
    return wf;
  }

  /**
   * The task's current stage (D6): the task_stages row when it still matches the configured workflow and
   * the task's status; otherwise (legacy task, status changed outside the stage machine, workflow changed
   * between stages) derived from the status. null = no stage can run from this status.
   */
  stagePlan(task: Task): StagePlan | null {
    const cfg = this.config;
    const wf = this.workflowOf(task);
    const row = this.db.taskStage(task.id);
    if (row && row.workflow === wf.name) {
      const stages = parseStages(row.stages_json);
      if (stages && sameStages(configuredStages(stages), wf.stages) && statusesAt(cfg, stages, row.position).includes(task.status)) {
        return { workflow: wf.name, stages, position: row.position };
      }
    }
    const d = derivePosition(cfg, wf.stages, task.status);
    return d ? { workflow: wf.name, ...d } : null;
  }

  /** Refuses a claim whose role is not the current stage's, or whose status the stage cannot be claimed from. */
  private assertClaimableStage(task: Task, role: LeaseRole, plan: StagePlan | null): void {
    const cfg = this.config;
    const stage = plan?.stages[plan.position];
    if (plan && stage && stage.role === role && claimableStatuses(cfg, plan.stages, plan.position).includes(task.status)) return;
    // Where this role could be claimed from in the workflow (position 0: ready|changes-requested; later: its stage status).
    const stages = plan?.stages ?? this.workflowOf(task).stages;
    const from = new Set<TaskStatus>();
    stages.forEach((s, i) => { if (s.role === role) for (const st of i === 0 ? claimableStatuses(cfg, stages, 0) : [stageStatusOf(cfg, s)]) from.add(st); });
    const allowed = from.size ? [...from] : Object.hasOwn(ROLE_STATUSES, role) ? ROLE_STATUSES[role as BuiltinLeaseRole] : [stageStatusOf(cfg, { role })];
    const current = plan && stage && stage.role !== role
      ? ` The current stage is ${stage.role} (workflow ${plan.workflow}, stage ${plan.position + 1}/${plan.stages.length}).` : '';
    throw new MinionsError('PRECONDITION', `Task ${task.id} is "${task.status}"; a ${role} can only be claimed from ${allowed.join('|')}.${current}`);
  }

  /**
   * D8 `requires`: every capability the role's stage cannot work without must be allowed for the role. A deny
   * refuses the claim (POLICY_DENIED naming the capability): the task stops at this stage until the owner
   * changes the policy. An `ask` refuses it too, with awaiting-human guidance (host-signed approvals for stage
   * capabilities do not exist). Each refusal is recorded as a `stage-refused` event.
   */
  private assertStageRequires(task: Task, def: RoleDef): void {
    for (const cap of def.requires) {
      const effect = can(this.config, cap, { role: def.name });
      if (effect === 'allow') continue;
      this.db.addEvent('stage-refused', task.id, { role: def.name, capability: cap, effect });
      const details = { taskId: task.id, role: def.name, capability: cap, effect, ...(effect === 'ask' ? { awaitingHuman: true } : {}) };
      if (effect === 'deny') {
        throw new MinionsError('POLICY_DENIED', `Task ${task.id}: the ${def.name} stage requires ${cap}, which is denied for role ${def.name} by configuration.`,
          `The task stops at this stage. Do not retry: block the task or ask the owner; only a host-side policy change (capabilities.${cap}, roles.${def.name}.capabilities) lets it run.`, details);
      }
      throw new MinionsError('POLICY_DENIED', `Task ${task.id}: the ${def.name} stage requires ${cap}, which needs human approval ("ask") for role ${def.name}.`,
        `Move the task to awaiting-human (minions backlog update ${task.id} --expected-version <v> --status awaiting-human) and ask the owner to allow ${cap} for role ${def.name} on the host; a stage capability cannot be approved per task.`, details);
    }
  }

  /**
   * D5: a workflow assigned between stages (the stage row names another workflow) resets the position to the
   * first stage of the new workflow without `complete` evidence at the current head (`when: qa` stages count
   * only when QA is required); with evidence for every stage, the final gate (else the last stage) runs again.
   * The task's status moves to that stage's when it cannot be claimed from the current one, and the reset is
   * recorded as a `workflow-reset` event. A changed stage list of the same workflow (a config edit) keeps the
   * status-derived position of stagePlan. Without a stage row or a branch head nothing changes.
   */
  private async reconcileWorkflowChange(task: Task): Promise<Task> {
    const r = await this.workflowReset(task);
    if (!r) return task;
    const updated = r.status !== task.status ? await this.backlog.updateTask(task.id, task.version, { status: r.status }) : task;
    this.db.transaction(() => {
      this.db.setTaskStage(task.id, r.workflow.name, r.workflow.stages, r.position);
      this.db.addEvent('workflow-reset', task.id, { from: r.from, to: r.workflow.name, head: r.head, position: r.position, role: r.workflow.stages[r.position]!.role, fromStatus: task.status, status: r.status });
    });
    return updated;
  }

  /** The reset reconcileWorkflowChange would apply (read-only; `work next` previews it): null = no reset. */
  private async workflowReset(task: Task): Promise<{ from: string; workflow: Workflow; head: string; position: number; status: TaskStatus } | null> {
    const cfg = this.config;
    const row = this.db.taskStage(task.id);
    if (!row) return null;
    const wf = this.workflowOf(task);
    if (row.workflow === wf.name || !wf.stages.length) return null;
    if (!(['ready', 'changes-requested', 'implementing', 'testing', 'reviewing'] as TaskStatus[]).includes(task.status)) return null;
    const head = await headOf(this.layout.repo, this.branchForTask(task).branch);
    if (!head) return null;
    const evidence = this.db.evidenceFor(task.id, head, undefined, cfg.configRevision);
    const done = (s: Stage) => evidence.some((e) => e.kind === s.role && e.outcome === 'complete');
    const qa = wf.stages.some((s) => s.when === 'qa') && (await this.qaRequirement(task, head)).reasons.length > 0;
    let position = wf.stages.findIndex((s) => (s.when !== 'qa' || qa) && !done(s));
    if (position < 0) { const gate = finalGateIndex(cfg, wf.stages); position = gate >= 0 ? gate : wf.stages.length - 1; }
    const status: TaskStatus = claimableStatuses(cfg, wf.stages, position).includes(task.status) ? task.status
      : position === 0 ? 'changes-requested' : stageStatusOf(cfg, wf.stages[position]!);
    return { from: row.workflow, workflow: wf, head, position, status };
  }

  /**
   * The stage a claim of this task would run, without changing anything: the workflow reset of a changed
   * workflow previewed (with the status it would move to), else stagePlan. null plan = no stage can run.
   */
  private async previewStage(task: Task): Promise<{ plan: StagePlan | null; status: TaskStatus; reset: boolean }> {
    const r = await this.workflowReset(task);
    if (r) return { plan: { workflow: r.workflow.name, stages: r.workflow.stages, position: r.position }, status: r.status, reset: true };
    return { plan: this.stagePlan(task), status: task.status, reset: false };
  }

  /**
   * The role a claim without --role runs: the tester for a QA sweep, else the current stage's role (after a
   * previewed workflow reset). PRECONDITION when no stage can run from the task's status.
   */
  async stageRole(taskId: string): Promise<LeaseRole> {
    const task = await this.backlog.getTask(taskId);
    if (isQaSweep(task)) return 'tester';
    const { plan } = await this.previewStage(task);
    const stage = plan?.stages[plan.position];
    if (!plan || !stage) {
      throw new MinionsError('PRECONDITION', `Task ${task.id} is "${task.status}"; no stage of its workflow can be claimed from it.`,
        'Run `minions work next --json` for the runnable stages; re-read the task with `minions backlog show <taskId> --json`.');
    }
    return stage.role;
  }

  /** The stage a lease runs: the row written at claim when it names the lease's role, else the first stage of that role. */
  private leaseStage(task: Task, lease: Lease): StagePlan {
    const row = this.db.taskStage(task.id);
    const stages = row ? parseStages(row.stages_json) : null;
    if (row && stages && stages[row.position]?.role === lease.role) return { workflow: row.workflow, stages, position: row.position };
    const wf = resolveWorkflow(this.config, task.workflow) ?? resolveWorkflow(this.config, null)!;
    return { workflow: wf.name, ...positionForRole(this.config, wf.stages, lease.role) };
  }

  /** Complete evidence for the head from a role with this contract (built-ins: reviewer = gate, tester = verifier). */
  private passedAt(taskId: string, head: string, contract: RoleContract): boolean {
    const cfg = this.config;
    return this.db.evidenceFor(taskId, head, undefined, cfg.configRevision)
      .some((e) => e.outcome === 'complete' && e.kind !== 'check' && workerRole(cfg, e.kind)?.contract === contract);
  }

  /** Whether an ended lease's result was a drain partial (wound down for an upgrade: not a failed attempt). */
  private wasDrained(lease: Lease): boolean {
    return this.db.events(lease.task_id, 'record').some((e) => (e.data as { leaseId?: string; drain?: boolean } | null)?.leaseId === lease.id && (e.data as { drain?: boolean }).drain === true);
  }

  /**
   * D12 "repair after a failed attempt": the role's last recorded attempt on the task failed (an unvalidated
   * result, `blocked` or a non-drain `partial`, or a producer's `needs_changes`), or a producer repairs after
   * an earlier repair did not fix the findings (two or more repair cycles). Released leases do not count.
   */
  private attemptFailed(task: Task, role: string, def: RoleDef): boolean {
    const cfg = this.config;
    const last = this.db.leases({ taskId: task.id, all: true })
      .filter((l) => baseRoleName(cfg, l.role) === role && (l.status === 'completed' || l.status === 'unvalidated')).at(-1);
    if (last) {
      if (last.status === 'unvalidated' || last.result_valid !== 1 || !last.result_json) return true;
      const st = (JSON.parse(last.result_json) as WorkerResult).status;
      if (st === 'blocked' || (st === 'needs_changes' && def.contract === 'producer')) return true;
      if (st === 'partial' && !this.wasDrained(last)) return true;
    }
    return def.contract === 'producer' && task.status === 'changes-requested' && this.db.repairCycles(task.id) >= 2;
  }

  /**
   * `minions work next` (D12, thin runner): every stage a claim could start now, from the stage machine
   * (stagePlan, with a changed workflow's reset previewed), in dispatch order: tasks already under way first,
   * then priority. Capacity is applied greedily in that order (`runnable` fits together; the rest is
   * `waiting` with the limit). Pauses, a drain and the owner budget move everything to `waiting`. Tasks in a
   * stage status that no stage can be claimed from are `stuck` (recover them). Read-only.
   */
  async next(): Promise<NextReport> {
    const cfg = this.config;
    const tasks = await this.backlog.listTasks();
    const leases = this.db.activeLeases();
    const leased = new Set(leases.map((l) => l.task_id));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const readyCtx = { leased, scope: scopeOf(cfg), lookup: (id: string) => byId.get(id) };
    const candidates: NextStage[] = [];
    const stuck: StuckTask[] = [];
    const waiting: WaitingStage[] = [];
    const STAGE_STATUSES: TaskStatus[] = ['ready', 'changes-requested', 'implementing', 'testing', 'reviewing'];
    for (const task of tasks) {
      if (leased.has(task.id) || !STAGE_STATUSES.includes(task.status)) continue;
      if (task.status === 'ready' && notReadyReason(task, readyCtx) !== null) continue;
      if (isQaSweep(task)) {
        // A QA sweep has no stage plan: a tester checks the base branch, claimed from ready only.
        if (task.status !== 'ready') { stuck.push({ taskId: task.id, status: task.status, reason: `QA sweep in "${task.status}" without a lease; a sweep is only claimed from ready` }); continue; }
        const def = workerRole(cfg, TESTER_ROLE)!;
        const m = this.stageSuggestion(def, { roleModel: def.model, contract: def.contract, labels: task.labels, deepVariant: def.deepVariant, harness: def.harness, repairAfterFailure: this.attemptFailed(task, TESTER_ROLE, def) });
        if ('stuck' in m) { stuck.push({ taskId: task.id, status: task.status, reason: m.stuck }); continue; }
        candidates.push(this.nextEntry(task, def, m, { kind: 'qa-sweep', position: null, count: null, workflow: null },
          `QA sweep of ${cfg.git.baseBranch}: a tester checks the base branch head`));
        continue;
      }
      let preview: Awaited<ReturnType<Scheduler['previewStage']>>;
      try { preview = await this.previewStage(task); } catch (e) {
        stuck.push({ taskId: task.id, status: task.status, reason: (e as Error).message });
        continue;
      }
      const { plan, status, reset } = preview;
      const stage = plan?.stages[plan.position];
      if (!plan || !stage || !claimableStatuses(cfg, plan.stages, plan.position).includes(status)) {
        stuck.push({ taskId: task.id, status: task.status, reason: stage
          ? `"${task.status}" without a lease: the current stage (${stage.role}, ${plan!.position + 1}/${plan!.stages.length}) cannot be claimed from it; recover the task (release/restore its status)`
          : `no stage of workflow ${plan?.workflow ?? task.workflow ?? 'default'} runs from "${task.status}"` });
        continue;
      }
      const def = workerRole(cfg, stage.role);
      if (!def) { stuck.push({ taskId: task.id, status: task.status, reason: `stage role ${stage.role} is not registered` }); continue; }
      const m = this.stageSuggestion(def, {
        stageModel: stage.model, roleModel: def.model, contract: def.contract, labels: task.labels, deepVariant: def.deepVariant, harness: def.harness,
        allHinted: configuredStages(plan.stages).every((x) => x.model !== undefined), repairAfterFailure: this.attemptFailed(task, def.name, def),
      });
      if ('stuck' in m) { stuck.push({ taskId: task.id, status: task.status, reason: m.stuck }); continue; }
      const at = `stage ${plan.position + 1}/${plan.stages.length} (${stage.role}) of workflow ${plan.workflow}`;
      const why = [
        task.status === 'changes-requested' ? `changes-requested: repair (cycle ${this.db.repairCycles(task.id)}) at ${at}` : `${task.status}: ${at}`,
        stage.inserted === 'qa' ? 'tester inserted: QA required' : stage.inserted === 'legacy' ? 'stage added for a legacy status' : null,
        reset ? `workflow changed: the claim resets the position by evidence at the head${status !== task.status ? ` and moves the task to ${status}` : ''}` : null,
      ].filter(Boolean).join('; ');
      const entry = this.nextEntry(task, def, m, { kind: 'task', position: plan.position, count: plan.stages.length, workflow: plan.workflow }, why);
      const refused = def.requires.find((cap) => can(cfg, cap, { role: def.name }) !== 'allow');
      if (refused) {
        const effect = can(cfg, refused, { role: def.name });
        waiting.push({ ...entry, waitingOn: 'requires', why: `the ${def.name} stage requires ${refused}, which is ${effect === 'deny' ? 'denied' : 'ask (needs the owner)'} for role ${def.name}` });
        continue;
      }
      candidates.push(entry);
    }
    const started = (t: NextStage) => (t.status === 'ready' ? 1 : 0);
    const ordered = sortByPriority(candidates.map((c) => ({ ...c, id: c.taskId }))).sort((a, b) => started(a) - started(b)).map(({ id: _id, ...c }) => c);
    const cap = capacityOf(cfg, leases, tasks);
    let startsBlocked: NextReport['startsBlocked'] = null;
    try { this.assertStartsAllowed(); } catch (e) {
      const err = e as MinionsError;
      startsBlocked = { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
    }
    const runnable: NextStage[] = [];
    const active = new Set(cap.activeTaskIds);
    const roleActive = new Map(Object.entries(cap.byRole).map(([r, c]) => [r, c.active]));
    let processProducers = this.processProducerLeases(leases);
    for (const c of ordered) {
      if (startsBlocked) { waiting.push({ ...c, waitingOn: 'starts', why: startsBlocked.message }); continue; }
      if (!active.has(c.taskId) && active.size >= cfg.execution.maxActiveTasks) {
        waiting.push({ ...c, waitingOn: 'capacity', why: `active task limit (${active.size}/${cfg.execution.maxActiveTasks})` }); continue;
      }
      const slots = Object.hasOwn(cap.byRole, c.role) ? cap.byRole[c.role]! : undefined;
      const used = roleActive.get(c.role) ?? 0;
      if (slots?.limited && used >= slots.max) { waiting.push({ ...c, waitingOn: 'role-capacity', why: `${c.role} limit (${used}/${slots.max})` }); continue; }
      const processProducer = this.isProcessProducer(c.role, c.harness);
      const producerCap = this.phase.processProducerCap;
      if (processProducer && producerCap !== null && processProducers >= producerCap) {
        waiting.push({ ...c, waitingOn: 'harness-capacity', why: `process-harness producer cap (${processProducers}/${producerCap}, ${this.phase.summary})` }); continue;
      }
      if (processProducer) processProducers++;
      active.add(c.taskId);
      roleActive.set(c.role, used + 1);
      runnable.push(c);
    }
    const message = runnable.length
      ? `${runnable.length} runnable stage(s): ${runnable.slice(0, 5).map((r) => `${r.taskId} ${r.role}`).join(', ')}${runnable.length > 5 ? ', …' : ''}`
      : startsBlocked ? `Nothing runnable: ${startsBlocked.message}`
        : waiting.length ? `Nothing runnable: ${waiting.length} stage(s) waiting (${[...new Set(waiting.map((w) => w.waitingOn))].join(', ')}).`
          : 'Nothing runnable: no ready task and no task waiting for its next stage.';
    const warnings = defaultMovedGates(cfg, this.phase).map(({ role, harness }) =>
      `harnesses.default moves the gate role ${role} onto ${HARNESSES[harness].label} (harness ${harness}); set roles.${role}.harness to claude on the host to keep it on Claude Code, or to ${harness} to make it explicit`);
    return { runnable, waiting, stuck, startsBlocked, capacity: cap, message, ...(warnings.length ? { warnings } : {}) };
  }

  private nextEntry(task: Task, def: RoleDef, m: ModelSuggestion, at: Pick<NextStage, 'kind' | 'position' | 'count' | 'workflow'>, reason: string): NextStage {
    const launch = launchFor(this.config, def, m);
    return {
      taskId: task.id, title: task.title, status: task.status, priority: task.priority, ...at,
      // agentType names the Claude agent definition; a process-harness role has none to spawn (launch.kind "run").
      role: def.name, agentType: launch.kind === 'agent' ? launch.agentType : `minions:${def.name}`,
      suggestedModel: m.model, agentModel: m.agentModel, modelRule: m.rule, harness: def.harness, launch,
      reason: `${reason}; model: ${m.rule}${m.deep ? ', deep variant' : ''}`,
    };
  }

  /**
   * The model suggestion of one `work next` entry, or why the entry is stuck: a role on a process harness without
   * its `harnesses.<id>` block (a config that skipped validateConfig) must not fail the whole listing.
   */
  private stageSuggestion(def: RoleDef, x: Parameters<typeof suggestModel>[1]): ModelSuggestion | { stuck: string } {
    if (isProcessHarness(def.harness) && !harnessModels(this.config, def.harness)) {
      return { stuck: `role ${def.name} runs on harness ${def.harness}, which has no harnesses.${def.harness} block (add it with its models on the host, or set roles.${def.name}.harness to claude)` };
    }
    try { return suggestModel(this.config, x); } catch (e) {
      if (e instanceof MinionsError) return { stuck: `role ${def.name}: ${e.message}` };
      throw e;
    }
  }

  /**
   * Whether a stage of `role` on `harness` is a producer on a process harness (counted by the phase cap,
   * agent-runtimes D9). A role no longer in the config counts as a producer: the cap errs on the safe side.
   */
  private isProcessProducer(role: string, harness: HarnessId): boolean {
    if (!isProcessHarness(harness)) return false;
    return (workerRole(this.config, role)?.contract ?? 'producer') === 'producer';
  }

  /**
   * Active process-harness producer leases, by the harness each lease recorded at claim: a later config change does
   * not move a running lease in or out of the cap. Leases from before schema 7 have none and count as claude.
   */
  private processProducerLeases(leases: Lease[]): number {
    return leases.filter((l) => this.isProcessProducer(l.role, leaseHarness(l))).length;
  }

  /**
   * Phase rules at claim (agent-runtimes D9): the role's process harness must be allowed for it (validateConfig
   * refuses such a config too; this guards a config that skipped it), and the squad-wide cap on active
   * process-harness producer leases holds. Runs inside the claim transaction.
   */
  private assertHarnessAllowed(def: RoleDef, active: Lease[]): void {
    if (!isProcessHarness(def.harness)) return;
    if (!phaseAllows(def.harness, def, this.phase)) {
      throw new MinionsError('POLICY_DENIED', `Role ${def.name} cannot run on harness ${def.harness}: ${this.phase.summary}.`, `Set roles.${def.name}.harness to claude on the host.`);
    }
    const cap = this.phase.processProducerCap;
    if (def.contract !== 'producer' || cap === null) return;
    const n = this.processProducerLeases(active);
    if (n >= cap) {
      throw new MinionsError('CAPACITY', `Process-harness producer cap reached (${n}/${cap}; ${this.phase.summary}).`, 'Wait for the running process-harness producer to finish.', { active: n, max: cap });
    }
  }

  /** Refuses new starts while paused, draining or over the owner budget (claim; `work next` reports the same). */
  private assertStartsAllowed(): void {
    if (this.db.paused().starts) {
      const drain = this.db.drain();
      if (drain) {
        throw new MinionsError('POLICY_DENIED', `Starts are paused for a drain (${drain.reason}, since ${drain.requestedAt}).`,
          'Start nothing while draining: record the partial results of running workers; work resumes after the drain (the upgrade resumes starts and recovery re-dispatches).');
      }
      throw new MinionsError('POLICY_DENIED', 'Starts are paused (paused_starts).', 'Run `minions resume` to allow new work.');
    }
    // Owner budget used up: refuse new claims (running leases continue and are recorded as usual).
    assertBudgetAllowsStart(this.spendContext());
  }

  /**
   * Claims the task's current stage. Without `role` the stage machine picks it (stageRole); with it, the role
   * must be the current stage's (checked below, as before).
   */
  async claim(taskId: string, role?: LeaseRole, opts: { holder?: string } = {}): Promise<TaskBrief> {
    const cfg = this.config;
    if (role !== undefined) {
      // Built-ins and project roles from the registry (exact names; `-deep` is an agent type, not a role).
      const known = typeof role === 'string' ? exactWorkerRole(cfg, role) : undefined;
      if (!known) throw new MinionsError('INVALID_CONFIG', `Unknown role "${String(role).slice(0, 40)}" (${workerRoleNames(cfg).join('|')}).`);
    }
    this.assertStartsAllowed();
    role ??= await this.stageRole(taskId);
    const def = exactWorkerRole(cfg, role);
    if (!def) throw new MinionsError('INVALID_CONFIG', `Unknown role "${String(role).slice(0, 40)}" (${workerRoleNames(cfg).join('|')}).`);
    const startEffect = can(cfg, 'task.start', { role });
    if (startEffect === 'deny') throw new MinionsError('POLICY_DENIED', `task.start is denied for role ${role} by configuration.`);

    const current = await this.backlog.getTask(taskId);
    // An active lease is a CONFLICT regardless of status (the claim itself moved the status on);
    // re-checked inside the transaction below.
    const held = this.db.activeLeases().find((l) => l.task_id === current.id);
    if (held) {
      throw new MinionsError('CONFLICT', `Task ${current.id} already has an active ${held.role} lease (${held.id}).`,
        'One active stage per task: wait for it, record its result, or release it.', { leaseId: held.id, role: held.role });
    }
    await this.assertNoOpenRun(current.id);
    const sweep = isQaSweep(current);
    // A workflow assigned between stages resets the position by evidence at the head (D5); may update the status.
    const task = sweep ? current : await this.reconcileWorkflowChange(current);
    if (sweep && role !== 'tester') {
      throw new MinionsError('PRECONDITION', `Task ${task.id} is a QA sweep (label ${QA_SWEEP_LABEL}); only a tester runs it.`, `Claim it with --role tester.`);
    }
    // The stage machine (D6): the role must be the current stage's, claimable from the task's status. A QA sweep ignores workflows.
    const plan = sweep ? null : this.stagePlan(task);
    if (sweep && task.status !== 'ready') {
      throw new MinionsError('PRECONDITION', `Task ${task.id} is "${task.status}"; a QA sweep can only be claimed from ready.`);
    }
    if (!sweep) this.assertClaimableStage(task, role, plan);
    // D8 `requires`: capabilities the stage cannot work without (deny refuses; ask needs the owner).
    this.assertStageRequires(task, def);
    // One backlog listing per claim (task-24.2): dependency status and capacity both come from it.
    let snapshot: Task[] | undefined;
    const listing = async () => (snapshot ??= await this.backlog.listTasks());
    if ((sweep || plan?.position === 0) && task.status === 'ready') {
      if (!task.authorized) throw new MinionsError('POLICY_DENIED', `Task ${task.id} is not authorized to start.`, 'Label it minions:authorized or enable intake.startReady.');
      const byId = task.dependencies.length ? new Map((await listing()).map((t) => [t.id, t])) : new Map<string, Task>();
      for (const dep of task.dependencies) {
        let d: Task;
        // Not in the listing (e.g. archived or an id spelled differently): view it, as before.
        try { d = byId.get(dep) ?? await this.backlog.getTask(dep); } catch (e) {
          throw new MinionsError('PRECONDITION', `Task ${task.id}: dependency ${dep} cannot be read (${(e as Error).message}).`);
        }
        if (d.status !== 'done' && d.status !== 'delivered') throw new MinionsError('PRECONDITION', `Task ${task.id} depends on ${dep}, which is "${d.status}".`);
      }
    }
    // GitHub delivery: the base recorded for the lease is origin's base as the server reported it and the
    // GitHub API confirmed (base-sync.ts), never the local base ref a worker can move (task-71).
    const verifiedBase = isGithubDelivery(cfg) ? await this.syncBase(task.id, role) : null;
    const allTasks = await listing();
    // A QA sweep's lease is on the base branch itself; its worktree is detached at the base head.
    const sweepBase = sweep ? await resolveBaseBranch(this.layout.repo, cfg.git.baseBranch) : null;
    const { branch, slug } = sweepBase ? { branch: sweepBase.branch, slug: `qa-${taskSlug(task.id, task.title)}` } : this.branchForTask(task);
    const leaseId = newLeaseId();
    const holder = opts.holder ?? `pid:${process.pid}`;

    const attempt = this.db.transaction(() => {
      const active = this.db.activeLeases();
      const mine = active.find((l) => l.task_id === task.id);
      if (mine) {
        throw new MinionsError('CONFLICT', `Task ${task.id} already has an active ${mine.role} lease (${mine.id}).`,
          'One active stage per task: wait for it, record its result, or release it.', { leaseId: mine.id, role: mine.role });
      }
      const cap = capacityOf(cfg, active, allTasks);
      if (!cap.activeTaskIds.includes(task.id) && cap.activeTaskIds.length >= cfg.execution.maxActiveTasks) {
        throw new MinionsError('CAPACITY', `Active task limit reached (${cap.activeTaskIds.length}/${cfg.execution.maxActiveTasks}: ${cap.activeTaskIds.join(', ')}).`,
          'Finish, block, or release an active task first.', cap);
      }
      const slots = Object.hasOwn(cap.byRole, role) ? cap.byRole[role] : undefined;
      if (slots?.limited && slots.active >= slots.max) {
        const label = role === ENGINEER_ROLE ? 'Engineer' : `Role ${role}`;
        throw new MinionsError('CAPACITY', `${label} limit reached (${slots.active}/${slots.max}).`, `Wait for a${role === ENGINEER_ROLE ? 'n' : ''} ${role} to finish.`, cap);
      }
      this.assertHarnessAllowed(def, active);
      const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND role = ?', task.id, role)!.n + 1;
      this.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, branch, config_revision, started_at, status, harness)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`, leaseId, task.id, role, n, holder, branch, cfg.configRevision, nowIso(), def.harness);
      this.db.addEvent('claim', task.id, { leaseId, role, attempt: n, fromStatus: task.status, holder, ...(sweep ? { kind: 'qa-sweep' } : {}) });
      if (plan) this.db.setTaskStage(task.id, plan.workflow, plan.stages, plan.position);
      return n;
    });

    let worktree: string, baseBranch: string, baseSha: string, head: string;
    try {
      if (sweepBase) {
        baseBranch = sweepBase.branch; baseSha = head = sweepBase.sha;
        worktree = (await ensureReviewWorktree(this.layout, slug, head)).worktree;
        this.db.exec('UPDATE leases SET worktree = ?, base_sha = ?, head_sha = ? WHERE id = ?', worktree, baseSha, head, leaseId);
        return this.buildBrief(this.db.lease(leaseId)!, task, { attempt, branch, worktree, baseBranch, baseSha, head, startEffect, sweep });
      }
      // Only a producer may start the branch; verifiers and gates work on what an earlier stage produced.
      if (def.contract !== 'producer' && !(await headOf(this.layout.repo, branch))) {
        const what = def.contract === 'verifier' ? 'test' : def.contract === 'gate' ? 'review' : `run the ${role} stage on`;
        throw new MinionsError('PRECONDITION', `Task ${task.id} has no branch ${branch} to ${what}.`, `Run the ${plan?.stages[0]?.role ?? ENGINEER_ROLE} stage first.`);
      }
      // Worktree kind from the role (D4): review = detached at the exact head (read-only); branch = the task branch.
      if (def.worktree === 'review') {
        const b = await resolveBaseBranch(this.layout.repo, cfg.git.baseBranch);
        baseBranch = b.branch; baseSha = verifiedBase ?? b.sha; head = (await headOf(this.layout.repo, branch))!;
        worktree = (await ensureReviewWorktree(this.layout, slug, head)).worktree;
      } else {
        const wt = await ensureBranchWorktree(this.layout, slug, cfg.git.baseBranch);
        baseBranch = wt.baseBranch; baseSha = verifiedBase ?? wt.baseSha; head = wt.head; worktree = wt.worktree;
      }
      this.db.exec('UPDATE leases SET worktree = ?, base_sha = ?, head_sha = ? WHERE id = ?', worktree, baseSha, head, leaseId);
      // The task sits in the stage's status while it runs (D6): an engineer claimed from ready/changes-requested
      // goes to implementing, as before; a stage claimed from its own status leaves it unchanged.
      const running = plan ? stageStatusOf(cfg, plan.stages[plan.position]!) : def.stageStatus;
      const statusPatch = task.status !== running ? { status: running } : {};
      if (Object.keys(statusPatch).length || task.branch !== branch) {
        const fresh = await this.backlog.getTask(task.id);
        await this.backlog.updateTask(task.id, fresh.version, { ...statusPatch, branch });
      }
    } catch (e) {
      this.endLease(leaseId, 'released', { reason: `claim failed: ${(e as Error).message}` });
      await this.cleanupLeaseFiles(leaseId);
      throw e;
    }

    const brief = this.buildBrief(this.db.lease(leaseId)!, task, { attempt, branch, worktree, baseBranch, baseSha, head, startEffect, plan });
    if (def.contract !== 'producer' && cfg.verification.ciAuthority === 'github') brief.ci = await this.ciGate(task.id, head);
    return brief;
  }

  /**
   * GitHub delivery: origin/<base> is the single source of truth. Fetch it and fast-forward the local
   * base before any lease exists; a fetch failure or a local base that origin does not contain blocks
   * the claim (the error propagates unchanged and is recorded as a `base-sync-blocked` event).
   */
  /**
   * The GitHub repository from minions' own record (publish.ts serverOriginOf): the task's PR URL, else the
   * repository `minions workspace import --remote-url` recorded. `{}` when there is no record (the callee
   * then falls back to the workspace's origin URL, still reached only at that explicit https URL).
   */
  private originOpts(task?: Pick<Task, 'prUrl'> | null): { origin?: ServerOrigin } {
    const origin = serverOriginOf({ prUrls: [task?.prUrl], recorded: this.db.getMeta(ORIGIN_REPOSITORY_META) ?? null });
    return origin ? { origin } : {};
  }

  /** Returns origin's verified base (the commit the lease records), or null for an injected sync without one. */
  private async syncBase(taskId: string, role: LeaseRole): Promise<string | null> {
    const base = this.config.git.baseBranch;
    try {
      const r = await this.baseSync(this.layout.repo, base);
      if (r.action !== 'up-to-date') this.db.addEvent('base-sync', taskId, { role, ...r });
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.to) ? r.to : null;
    } catch (e) {
      const err = e as Partial<MinionsError>;
      this.db.addEvent('base-sync-blocked', taskId, { role, base, code: err.code ?? 'INTERNAL', message: err.message ?? String(e), details: err.details ?? null });
      throw e;
    }
  }

  private buildBrief(lease: Lease, task: Task, x: { attempt: number; branch: string; worktree: string; baseBranch: string; baseSha: string; head: string; startEffect: string; sweep?: boolean; plan?: StagePlan | null }): TaskBrief {
    const cfg = this.config;
    const role = lease.role;
    const def = workerRole(cfg, role);
    if (!def) throw new MinionsError('INVALID_CONFIG', `Lease ${lease.id} has role "${role}", which is not a registered worker role.`);
    const stage = x.plan ? x.plan.stages[x.plan.position] : undefined;
    const priorFindings = this.db.leases({ taskId: task.id, all: true })
      .filter((l) => l.id !== lease.id && l.result_valid === 1 && l.result_json)
      .slice(-3)
      .map((l) => {
        const r = JSON.parse(l.result_json!) as WorkerResult;
        return { leaseId: l.id, role: l.role, status: r.status, findings: r.findings, nextAction: r.nextAction };
      });
    const resume = this.drainResume(task.id, lease, x.branch);
    return {
      briefMarker: `minions-lease: ${lease.id}`,
      leaseId: lease.id,
      role,
      kind: x.sweep ? 'qa-sweep' : 'task',
      attempt: x.attempt,
      task: {
        id: task.id, locator: task.locator, title: task.title, description: task.description, objective: task.description,
        acceptanceCriteria: task.acceptanceCriteria, nonGoals: [], dependencies: task.dependencies,
        labels: task.labels, parent: task.parent, externalLinks: task.externalLinks,
      },
      relevantDecisions: [],
      relevantFiles: [],
      branch: x.branch,
      worktree: x.worktree,
      baseBranch: x.baseBranch,
      baseSha: x.baseSha,
      expectedHead: x.head,
      verificationCommands: [...cfg.verification.commands],
      authorizedCommands: ['git', ...cfg.verification.commands],
      publication: {
        'git.commit': def.worktree === 'review' || !def.commits || x.sweep ? 'deny' : can(cfg, 'git.commit', { role }),
        'git.push': x.sweep ? 'deny' : can(cfg, 'git.push', { role }),
        'pr.create': x.sweep ? 'deny' : can(cfg, 'pr.create', { role }),
      },
      policy: {
        taskStart: x.startEffect, codeEdit: can(cfg, 'code.edit', { role }), gitCommit: can(cfg, 'git.commit', { role }),
        sensitivePaths: [...cfg.sensitivePaths], architecture: cfg.architecture,
      },
      harness: def.harness,
      ...this.briefModel(def, stage),
      maxTurns: cfg.execution.attemptMaxTurns,
      configRevision: cfg.configRevision,
      deliveryMode: cfg.delivery.mode,
      priorFindings,
      ...(resume ? { resume } : {}),
      ...(x.plan && stage ? { stage: { workflow: x.plan.workflow, position: x.plan.position, count: x.plan.stages.length, role: stage.role, ...(stage.model ? { model: stage.model } : {}) } } : {}),
      ...(def.builtin ? {} : { editScope: { edits: typeof def.edits === 'string' ? def.edits : { paths: [...def.edits.paths] }, commits: def.commits } }),
      // A QA sweep checks the base head and commits nothing: the verifier contract without commits.
      resultContract: resultContractText(def.contract, { commits: def.commits && !x.sweep }),
    };
  }

  /**
   * Brief model fields. Claude (unchanged): a stage model hint (D5; in models.allowed by config validation) replaces
   * models.default, effort is in the agent definition. A process harness (agent-runtimes D8): stage hint > role model >
   * harnesses.<id>.models.default (always the default with selection "fixed"), its allowed list, and the base effort
   * mapped onto the harness's scale (the `-deep` choice is the launch entry's).
   */
  private briefModel(def: RoleDef, stage: Stage | undefined): Pick<TaskBrief, 'model' | 'allowedModels' | 'effort'> {
    const cfg = this.config;
    const hm = isProcessHarness(def.harness) ? harnessModels(cfg, def.harness) : undefined;
    if (!hm) return { model: stage?.model ?? cfg.models.default, allowedModels: [...cfg.models.allowed], effort: null };
    const model = cfg.models.selection === 'fixed' ? hm.default : stage?.model ?? def.model ?? hm.default;
    return { model, allowedModels: [...hm.allowed], effort: harnessRoleEffort(cfg, def, false).native };
  }

  /** The last ended lease of the task, when it was a drain partial of the same role: what to continue from. */
  private drainResume(taskId: string, lease: Lease, branch: string): DrainResume | undefined {
    const last = this.db.leases({ taskId, all: true }).filter((l) => l.id !== lease.id && l.status !== 'active').at(-1);
    if (!last || last.role !== lease.role || last.result_valid !== 1 || !last.result_json) return undefined;
    if (!this.wasDrained(last)) return undefined;
    const r = JSON.parse(last.result_json) as WorkerResult;
    const at = last.head_sha ? ` at ${last.head_sha}` : '';
    const def = workerRole(this.config, lease.role);
    const instruction = def?.contract === 'gate'
      ? `The previous review was interrupted by a drain (upgrade). Review ${branch}${at} again from the start; the remaining work lists what was not reviewed yet.`
      : def?.commits === false
        ? `The previous ${lease.role} was interrupted by a drain (upgrade) at ${branch}${at}. Start again from that head (your role does not commit); the remaining work lists what was not done yet.`
        : `The previous ${lease.role} was interrupted by a drain (upgrade) and checkpointed on ${branch}${at} (\`wip:\` commit). Continue from that commit: keep the committed work, do the remaining work, and add normal commits on top (never rewrite or discard the wip: commit).`;
    return { fromLeaseId: last.id, role: last.role, reason: 'drain', headSha: last.head_sha, summary: r.summary, remainingWork: r.findings, nextAction: r.nextAction, instruction };
  }

  private endLease(id: string, status: Lease['status'], data: Record<string, unknown>, result?: { json: string; valid: number }): void {
    this.db.transaction(() => {
      const l = this.db.lease(id);
      if (result) this.db.exec('UPDATE leases SET status = ?, ended_at = ?, result_json = ?, result_valid = ? WHERE id = ?', status, nowIso(), result.json, result.valid, id);
      else this.db.exec('UPDATE leases SET status = ?, ended_at = ? WHERE id = ?', status, nowIso(), id);
      this.db.addEvent(status === 'released' ? 'release' : 'record', l?.task_id ?? null, { leaseId: id, status, ...data });
    });
  }

  private async isAncestor(from: string, to: string): Promise<boolean> {
    // Gate read (task-71): replace objects or grafts cannot make a rewritten head look like a descendant.
    return (await gateGit(this.layout.repo, ['merge-base', '--is-ancestor', from, to], true)).code === 0;
  }

  private preClaimStatus(lease: Lease): TaskStatus | undefined {
    const ev = this.db.events(lease.task_id, 'claim').find((e) => (e.data as { leaseId?: string })?.leaseId === lease.id);
    return (ev?.data as { fromStatus?: TaskStatus } | undefined)?.fromStatus;
  }

  private isSweepLease(lease: Lease): boolean {
    if (lease.role !== 'tester') return false;
    const ev = this.db.events(lease.task_id, 'claim').find((e) => (e.data as { leaseId?: string })?.leaseId === lease.id);
    return (ev?.data as { kind?: string } | undefined)?.kind === 'qa-sweep';
  }

  /** Paths the branch changes against the base (null when the diff cannot be computed). A gate read (gateGit, task-71). */
  private async changedPaths(head: string): Promise<string[] | null> {
    try {
      const base = await resolveBaseBranch(this.layout.repo, this.config.git.baseBranch);
      const d = await gateGit(this.layout.repo, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', '-z', `${base.ref}...${head}`], true);
      return d.code === 0 ? d.stdout.split('\0').filter(Boolean) : null;
    } catch { return null; }
  }

  /**
   * Risk-based testing: a task needs a tester stage when verification.testerRequired is set, it carries a
   * QA label (verification.qaLabels; the coordinator may add one), its diff (or the reported modifiedPaths)
   * touches sensitive paths, the branch diff cannot be computed (fail closed), or the reviewer flagged it (`needsQa`). Sensitive paths and reviewer flags are
   * recorded on the task as the first QA label so later stages and publication see the same requirement.
   */
  async qaRequirement(task: Task, head: string, opts: { paths?: string[]; flagged?: boolean } = {}): Promise<QaRequirement> {
    const cfg = this.config;
    const reasons: string[] = [];
    let record = false;
    if (cfg.verification.testerRequired) reasons.push('verification.testerRequired');
    const label = task.labels.find((l) => qaLabelsOf(cfg).includes(l));
    if (label) reasons.push(`label ${label}`);
    const diff = await this.changedPaths(head);
    // Fail closed: without the branch diff an unreported sensitive change could skip QA.
    if (diff === null) { reasons.push('branch diff unavailable (QA required, fail closed)'); record = !label; }
    const paths = [...new Set([...(opts.paths ?? []), ...(diff ?? [])])];
    const sensitive = paths.filter((p) => matchesAny(p, cfg.sensitivePaths));
    if (sensitive.length) { reasons.push(`sensitive paths (${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? ', …' : ''})`); record = !label; }
    if (opts.flagged) { reasons.push('reviewer flagged needsQa'); record = !label; }
    return { reasons, record };
  }

  /** Paths changed between two commits (the stage diff of an edit-scope check); null when it cannot be computed. A gate read (gateGit, task-71). */
  private async diffPaths(from: string, to: string): Promise<string[] | null> {
    try {
      const d = await gateGit(this.layout.repo, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', '-z', from, to], true);
      return d.code === 0 ? d.stdout.split('\0').filter(Boolean) : null;
    } catch { return null; }
  }

  /**
   * Edit scope (D3), enforced at record time: a role that does not commit must leave the head where the claim
   * found it; a role with `edits.paths` may only change paths matching them in the stage diff (lease head at
   * claim → result head). Renames count as a delete plus an add, so moving a file out of scope is caught.
   * An uncomputable diff is a violation (fail closed). Built-ins: the engineer/tester edit anything; the
   * reviewer's pinned head is checked by the gate rule already.
   */
  private async editScopeErrors(lease: Lease, def: RoleDef, head: string): Promise<string[]> {
    const from = lease.head_sha;
    if (!from || from === head) return [];
    if (!def.commits || def.edits === 'none') {
      return def.contract === 'gate' ? [] : [`edits: role ${def.name} does not commit, but ${lease.branch} moved from ${from} to ${head} during the stage`];
    }
    if (def.edits === 'any') return [];
    const scope = def.edits.paths;
    const changed = await this.diffPaths(from, head);
    if (changed === null) return [`edits: the stage diff ${from}..${head} cannot be computed, so role ${def.name}'s edit scope (${scope.join(', ')}) cannot be verified`];
    const outside = changed.filter((p) => !matchesAny(p, scope));
    if (!outside.length) return [];
    return [`edits: role ${def.name} may only change ${scope.join(', ')}; the stage changed ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? `, … (${outside.length} paths)` : ''} outside that scope. Move those changes out of the branch history of this stage (new commits only; the next stage or an engineer handles them)`];
  }

  /**
   * Puts a task back to its pre-claim status when its claim moved the status (worktree kept): a producer
   * (the engineer: implementing → ready / changes-requested, as before), or a stage claimed from another
   * status than its own (a repair target). Returns the task's status after it, or undefined when the claim
   * left the status alone.
   */
  private async restorePreClaim(lease: Lease): Promise<TaskStatus | undefined> {
    const def = workerRole(this.config, lease.role);
    if (!def) return undefined;
    const pre = this.preClaimStatus(lease);
    if (def.contract !== 'producer' && (!pre || pre === def.stageStatus)) return undefined;
    const from = pre ?? 'ready';
    const t = await this.backlog.getTask(lease.task_id);
    if (t.status !== def.stageStatus) return t.status;
    if (from === t.status) return from;
    await this.backlog.updateTask(t.id, t.version, { status: from });
    return from;
  }

  /**
   * Removes the hand-off files (brief, submitted and rejected result) of an ended lease. Best-effort: a failed
   * delete is logged as a `handoff-cleanup-error` event and never fails the transition.
   */
  private async cleanupLeaseFiles(leaseId: string): Promise<void> {
    // A run that is not done keeps its scratch dir (the clone recovery still checkpoints); a done one is removed.
    let keepScratch = false;
    if (this.runs) {
      keepScratch = await hasOpenRun(this.runs.state, leaseId);
      if (!keepScratch) await removeRunRecord(this.runs.state, leaseId).catch(() => undefined);
    }
    if (!this.handoff) return;
    let errors: string[];
    try { errors = await removeLeaseFiles(this.handoff, leaseId, { keepScratch }); } catch (e) { errors = [(e as Error).message]; }
    if (errors.length) {
      try { this.db.addEvent('handoff-cleanup-error', this.db.lease(leaseId)?.task_id ?? null, { leaseId, errors }); } catch { /* logging only */ }
    }
  }

  /** Returns the active lease; for an ended lease, removes any leftover hand-off files and throws CONFLICT. */
  async requireActive(leaseId: string): Promise<Lease> {
    const lease = this.db.lease(leaseId);
    if (!lease) throw new MinionsError('NOT_FOUND', `Lease ${leaseId} does not exist.`);
    if (lease.status !== 'active') {
      await this.cleanupLeaseFiles(leaseId);
      throw new MinionsError('CONFLICT', `Lease ${leaseId} already ended (${lease.status}).`);
    }
    return lease;
  }

  /**
   * D3b re-claim gate: a task is refused while any of its leases has a run record that is not `done` (its
   * post-exit checks must finish first), so a re-dispatched task never gets a second writer.
   */
  private async assertNoOpenRun(taskId: string): Promise<void> {
    if (!this.runs) return;
    for (const l of this.db.leases({ taskId, all: true })) {
      if (await hasOpenRun(this.runs.state, l.id)) {
        const corrupt = await readRunRecord(this.runs.state, l.id).then(() => null, (e: unknown) => e as Error);
        if (corrupt) {
          throw new MinionsError('POLICY_DENIED', `Task ${taskId} has a process run (${l.id}) whose record cannot be read (${corrupt.message.slice(0, 200)}); it counts as unfinished.`,
            corruptRecordHint(this.runs.state, l.id), { leaseId: l.id });
        }
        throw new MinionsError('POLICY_DENIED', `Task ${taskId} has an unfinished process run (${l.id}): its post-exit checks must finish before the task is claimed again.`,
          `Release ${l.id} if it is still active, or restart the coordinator (\`minions coordinator restart --recover\`), so recovery reaps it.`, { leaseId: l.id });
      }
    }
  }

  /** Releases a lease without a result. The worktree and branch are always preserved. */
  async release(leaseId: string, reason: string, opts: { usage?: UsageFlag } = {}): Promise<{ leaseId: string; taskId: string; worktree: string | null; branch: string | null; status: TaskStatus | null; run?: string } & Pick<RecordResponse, 'usage' | 'budget'>> {
    let lease = await this.requireActive(leaseId);
    // D3b: a process run is reaped (cancelled, or killed and checkpointed) before the lease ends; a failed reap
    // refuses the release, so the lease never ends while its worker may still write.
    const run = this.runs ? (await this.runs.reap(leaseId)).note : null;
    if (this.runs) lease = await this.requireActive(leaseId);
    const usage = this.noteUsage(lease, undefined, opts.usage, 'release');
    this.endLease(leaseId, 'released', { reason, ...(run ? { run } : {}) });
    await this.cleanupLeaseFiles(leaseId);
    let status: TaskStatus | null = null;
    try {
      status = (await this.restorePreClaim(lease)) ?? (await this.backlog.getTask(lease.task_id)).status;
      await this.backlog.addNote(lease.task_id, `minions: ${lease.role} lease ${leaseId} released: ${reason}.${run ? ` Process run: ${run}.` : ''} Worktree kept at ${lease.worktree ?? '(none)'}.`);
    } catch (e) {
      this.db.addEvent('release-backlog-error', lease.task_id, { leaseId, error: (e as Error).message });
    }
    return this.withBudget({ leaseId, taskId: lease.task_id, worktree: lease.worktree, branch: lease.branch, status, ...(run ? { run } : {}) }, usage);
  }

  /**
   * Validates and records a worker result, applies the transition and releases the lease. `usage`: the
   * worker's token total (task notification); the response carries the budget state after it.
   */
  async record(leaseId: string, raw: unknown, opts: { correction?: boolean; usage?: UsageFlag } = {}): Promise<RecordResponse> {
    const lease = await this.requireActive(leaseId);
    const usage = this.noteUsage(lease, raw, opts.usage, 'record');
    return this.withBudget(await this.recordResult(leaseId, raw, opts), usage);
  }

  private async recordResult(leaseId: string, raw: unknown, opts: { correction?: boolean }): Promise<RecordResponse> {
    const lease = await this.requireActive(leaseId);
    const base = { leaseId, taskId: lease.task_id, role: lease.role, approved: false, replan: false, needsSplit: false };
    if (lease.result_valid === 0 && !opts.correction) {
      throw new MinionsError('PRECONDITION', `Lease ${leaseId} has an invalid result awaiting correction.`, 'Re-record with --correction (one correction is allowed).');
    }
    if (opts.correction && lease.result_valid !== 0) {
      throw new MinionsError('PRECONDITION', `Lease ${leaseId} has no invalid result to correct.`, 'Record without --correction.');
    }
    const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
    // The role's contract variant (D4) decides the result rules; a role no longer registered is refused.
    const def = workerRole(this.config, lease.role);
    if (!def) {
      throw new MinionsError('INVALID_CONFIG', `Lease ${leaseId} has role "${lease.role}", which is not a registered worker role in this configuration.`,
        `Release it (minions work release ${leaseId}) or ask the owner to restore the role on the host.`);
    }
    const v = validateResult(raw, def.contract, { ciAuthority: this.config.verification.ciAuthority });
    let errors: string[] = v.ok ? [] : v.errors;
    const result = v.ok ? v.result : undefined;
    let actualHead: string | null = null;
    const sweep = this.isSweepLease(lease);
    if (result && sweep) {
      // A QA sweep checks the base head it was given; the base may move on meanwhile, and the sweep commits nothing.
      actualHead = lease.head_sha;
      if (result.branch !== lease.branch) errors.push(`branch: result names ${result.branch} but the QA sweep ran on ${lease.branch}`);
      if (result.headSha !== lease.head_sha) errors.push(`stale head: result headSha ${result.headSha} but the QA sweep ran against ${lease.head_sha} (sweeps do not commit)`);
    } else if (result) {
      actualHead = lease.branch ? await headOf(this.layout.repo, lease.branch) : null;
      if (result.branch !== lease.branch) errors.push(`branch: result names ${result.branch} but the lease is for ${lease.branch}`);
      if (!actualHead) errors.push(`stale head: branch ${lease.branch} no longer exists`);
      else if (result.headSha !== actualHead) errors.push(`stale head: result headSha ${result.headSha} but ${lease.branch} is at ${actualHead}`);
      else if (def.contract === 'gate' && lease.head_sha && lease.head_sha !== actualHead) {
        // A gate approves the exact head it was given.
        errors.push(`stale head: review started at ${lease.head_sha} but ${lease.branch} moved to ${actualHead}`);
      } else if (def.contract === 'verifier' && lease.head_sha && actualHead !== lease.head_sha &&
        !(await this.isAncestor(lease.head_sha, actualHead))) {
        // Verifiers may add commits on top of the head they were given, but must not rewrite it.
        errors.push(`stale head: testing started at ${lease.head_sha} but ${lease.branch} at ${actualHead} no longer contains it`);
      }
      // Edit scope (D3): enforced on the stage diff, not just recorded in the brief.
      if (actualHead && !errors.length) errors.push(...await this.editScopeErrors(lease, def, actualHead));
    }

    // CI evidence cited by a verifier/gate (tester, reviewer): decided by the runtime gate for the exact head, never by the claim itself.
    let ciGate: CiGate | null = null;
    if (result && !errors.length && !sweep && result.status === 'complete' && def.contract !== 'producer' && result.checks.some(isCiCheck)) {
      ciGate = await this.ciGate(lease.task_id, actualHead!);
      if (ciGate.state === 'pass') {
        const bad = result.checks.filter((c) => isCiCheck(c) && c.outcome === 'pass' && !ciGate!.passed.includes(c.command)).map((c) => c.command);
        if (bad.length) errors.push(`checks: CI evidence entries must name required checks that passed at ${actualHead} (required: ${ciGate.requiredChecks.join(', ')}); not: ${bad.join(', ')}`);
      }
    }

    if (errors.length) {
      if (!opts.correction) {
        this.db.transaction(() => {
          this.db.exec('UPDATE leases SET result_json = ?, result_valid = 0 WHERE id = ?', rawText, leaseId);
          this.db.addEvent('invalid-result', lease.task_id, { leaseId, errors });
        });
        return { ...base, valid: false, errors, correctionAllowed: true,
          message: 'Result rejected; one bounded correction is allowed: fix the listed fields and re-record with --correction.' };
      }
      this.endLease(leaseId, 'unvalidated', { errors }, { json: rawText, valid: 0 });
      await this.cleanupLeaseFiles(leaseId);
      try { await this.restorePreClaim(lease); } catch (e) {
        this.db.addEvent('record-backlog-error', lease.task_id, { leaseId, error: (e as Error).message });
      }
      return { ...base, valid: false, errors, correctionAllowed: false, unvalidated: true,
        message: 'Correction also invalid: the raw result is stored unvalidated and nothing was approved. Interpret it and decide (reclaim, block, or ask the user).' };
    }

    const r = result!;
    const head = actualHead!;
    const cfg = this.config;
    const task = await this.backlog.getTask(lease.task_id);
    const from = task.status;
    let to: TaskStatus = from;
    let approved = false, replan = false, needsSplit = false, repairCycles: number | undefined;
    let publish = false;
    let message = '';
    // The stage this lease ran (D6) and its result-contract variant (D4); a QA sweep ignores workflows.
    const plan = sweep ? null : this.leaseStage(task, lease);
    const stage = plan ? plan.stages[plan.position] : undefined;
    const contract: RoleContract = (stage && contractOf(cfg, stage)) ?? def.contract;
    // Where the task goes next in its workflow; stays put unless the transition below moves it.
    let nextStages: Stage[] = plan?.stages ?? [];
    let nextPos = plan?.position ?? 0;
    // Per-task QA requirement (risk-based testing), evaluated when a producer or gate (engineer, reviewer) finishes.
    const flagged = contract === 'gate' && r.needsQa === true;
    const qa: QaRequirement = !sweep && contract !== 'verifier' && (r.status === 'complete' || flagged)
      ? await this.qaRequirement(task, head, { paths: r.modifiedPaths, flagged })
      : { reasons: [], record: false };
    const qaWhy = qa.reasons.join('; ');
    // A drain partial: this lease received the drain notice (the drain hook records it on delivery) for a
    // drain that was active then, even if the drain is cleared by now. Merely spanning a drain does not count.
    const drained = r.status === 'partial' && !sweep && this.db.drainNoticeReceived(lease);
    // CI not usable as evidence: failing -> repair; otherwise fall back to the result's own local checks, or no approval.
    const localPass = localVerificationComplete(r.checks, cfg.verification.commands);
    const ciBlock: 'fail' | 'unverified' | null = !ciGate || ciGate.state === 'pass' ? null : ciGate.state === 'fail' ? 'fail' : localPass ? null : 'unverified';
    const ciFallback = !!ciGate && ciGate.state !== 'pass' && !ciBlock;
    // D7: a gate/verifier asking for changes sends the task to its repair target; gate results count repair
    // cycles (verifier results do not), and the limit sends the task to awaiting-human for a replan.
    const repair = (): string => {
      to = 'changes-requested';
      if (plan) nextPos = repairTarget(cfg, plan.stages, plan.position);
      if (contract !== 'gate') return '';
      repairCycles = this.db.incrementRepairs(task.id);
      if (repairCycles < cfg.execution.maxRepairCyclesBeforeReplan) return '';
      replan = true; to = 'awaiting-human';
      return `Repair cycle ${repairCycles} reached the limit (${cfg.execution.maxRepairCyclesBeforeReplan}); replan the task before more repairs.`;
    };

    if (sweep) {
      if (r.status === 'complete' || r.status === 'needs_changes') {
        to = 'done';
        message = `QA sweep of ${lease.branch} at ${head} recorded (${r.findings.length} finding(s)). Create a backlog task for each finding (minions backlog create, idempotency key qa:${task.id}:<n>).`;
      } else if (r.status === 'blocked') to = 'blocked';
      else if (r.status === 'needs_split') { to = 'awaiting-human'; needsSplit = true; message = 'QA sweep reported needs_split: create smaller sweep tasks.'; }
      else message = 'Partial QA sweep recorded; status unchanged (claim it again to finish).';
    } else if (ciBlock === 'fail') {
      message = `Not approved: ${formatCiGate(ciGate!)}. Task → changes-requested; repair with the failing checks as findings.`;
      const limit = repair();
      if (limit) message += ` ${limit}`;
    } else if (ciBlock === 'unverified') {
      to = from;
      message = `Not approved: the ${lease.role} relied on CI, but ${formatCiGate(ciGate!)}. Task stays ${from}: ${ciGate!.state === 'pending' ? 'run \`minions sync\` after CI finishes and re-dispatch, or ' : ''}re-dispatch the ${lease.role} with local verification (run the verification commands).`;
    } else switch (r.status) {
      case 'complete': {
        const pos = plan!.position;
        let stages = plan!.stages;
        // A gate approves only with verifier evidence for this head when QA is required: back to the verifier
        // before it (the built-in tester is inserted when the workflow has none there).
        if (contract === 'gate' && qa.reasons.length && !this.passedAt(task.id, head, 'verifier')) {
          const back = verifierBefore(cfg, stages, pos);
          nextStages = back.stages; nextPos = back.position; to = stageStatusOf(cfg, back.stages[back.position]!);
          message = `Approval not applied: QA required (${qaWhy}) and no passing tester evidence for head ${head} at config revision ${cfg.configRevision}. Run the tester.`;
          break;
        }
        // Invariant 3: QA required after a producer and no runnable verifier before the final gate -> insert the tester.
        if (contract === 'producer' && qa.reasons.length) stages = withQaTester(cfg, stages, pos);
        // `when: qa` stages after a verifier: QA evaluated now (not recorded as a label; the verifier does not change the requirement).
        const qaNow = contract !== 'verifier' ? qa.reasons.length > 0
          : stages.slice(pos + 1).some((s) => s.when === 'qa') && (await this.qaRequirement(task, head, { paths: r.modifiedPaths })).reasons.length > 0;
        nextStages = stages;
        const next = nextRunnable(stages, pos, qaNow);
        if (next !== null) {
          nextPos = next; to = stageStatusOf(cfg, stages[next]!);
          if (contract === 'producer' && qa.reasons.length && !cfg.verification.testerRequired && contractOf(cfg, stages[next]!) === 'verifier') {
            message = `Recorded ${lease.role} complete; QA required (${qaWhy}): task → ${to}.`;
          }
          break;
        }
        // Last stage done: deliver as after a reviewer approval, with the gate evidence for the current head.
        const gate = finalGateIndex(cfg, stages);
        const gateOk = gate >= 0 && (contract === 'gate' || this.passedAt(task.id, head, 'gate'));
        if (gate >= 0 && !gateOk && cfg.verification.reviewerRequired) {
          // A stage after the gate moved the head: the gate reviews the new head.
          nextPos = gate; to = stageStatusOf(cfg, stages[gate]!);
          message = `Not delivered: no ${stages[gate]!.role} approval for head ${head} (a stage after it changed the branch); task → ${to}.`;
          break;
        }
        nextPos = stages.length;
        if (!gateOk) to = 'delivered';
        else if (cfg.delivery.mode !== 'local') {
          // Publication (below) decides the final status; the task is never delivered before it succeeds.
          approved = true; publish = true;
        } else { to = 'delivered'; approved = true; message = `Approved at ${head}; delivered locally (export with minions export).`; }
        break;
      }
      case 'needs_changes':
        if (contract === 'producer') { to = this.preClaimStatus(lease) ?? 'ready'; message = `${lease.role === 'engineer' ? 'Engineer' : `Producer ${lease.role}`} reported needs_changes; task returned for re-planning.`; break; }
        message = repair();
        break;
      case 'blocked': to = 'blocked'; break;
      case 'needs_split': to = 'awaiting-human'; needsSplit = true; message = 'Worker reported needs_split: create child tasks idempotently and link dependencies.'; break;
      case 'partial':
        to = contract === 'producer' ? (this.preClaimStatus(lease) ?? 'ready') : from;
        message = drained
          ? `Drain partial recorded (${lease.role}): not a failed attempt or repair cycle. Start nothing while draining; after the drain re-dispatch the same role (its brief carries the remaining work and the wip: checkpoint).`
          : 'Partial result recorded; status unchanged.';
        break;
    }

    // Record the QA requirement on the task (first QA label) so later stages and publication see it.
    const labels = qa.record && to !== 'delivered' ? [...task.labels, qaLabelsOf(cfg)[0]!] : undefined;
    if (to !== from || labels) {
      if (to === 'done' || to === 'delivered') await this.backlog.closeTask(task.id, to);
      else await this.backlog.updateTask(task.id, task.version, { ...(to !== from ? { status: to } : {}), ...(labels ? { labels } : {}) });
    }
    if (labels) this.db.addEvent('qa-required', task.id, { leaseId, role: lease.role, head, reasons: qa.reasons, label: labels.at(-1) });

    this.db.transaction(() => {
      // A stage blocked by the CI gate is not a complete stage (publication checks role evidence 'complete').
      this.db.addEvidence({ task_id: task.id, head_sha: head, kind: lease.role, config_revision: cfg.configRevision,
        outcome: ciBlock ? `ci-${ciGate!.state}` : r.status, details_json: JSON.stringify({ leaseId, verdict: r.verdict ?? null, summary: r.summary }) });
      for (const c of r.checks) {
        this.db.addEvidence({ task_id: task.id, head_sha: head, kind: 'check', config_revision: cfg.configRevision,
          outcome: c.outcome, details_json: JSON.stringify({ leaseId, command: c.command, details: c.details ?? null, source: c.source ?? 'local' }) });
      }
      if (ciGate) {
        this.db.addEvidence({ task_id: task.id, head_sha: head, kind: 'ci-gate', config_revision: cfg.configRevision,
          outcome: ciGate.state, details_json: JSON.stringify({ leaseId, role: lease.role, usedAs: ciGate.state === 'pass' ? 'ci' : ciFallback ? 'local-fallback' : 'none', gate: ciGate }) });
      }
      this.db.exec('UPDATE leases SET head_sha = ? WHERE id = ?', head, leaseId);
      if (plan) this.db.setTaskStage(task.id, plan.workflow, nextStages, nextPos);
      if (publish) this.db.upsertPublication({ task_id: task.id, branch: lease.branch!, head_sha: head, mode: cfg.delivery.mode, config_revision: cfg.configRevision });
      this.endLease(leaseId, 'completed', { from, to, approved, replan, needsSplit, publish, ...(drained ? { drain: true, reason: 'drain' } : {}) }, { json: JSON.stringify(r), valid: 1 });
    });
    await this.cleanupLeaseFiles(leaseId);
    try {
      const ciNote = ciGate ? (ciBlock ? ` (not approved: ${formatCiGate(ciGate)})` : ciFallback ? ` (CI not usable: ${ciGate.state}; accepted on local checks)` : ' (CI evidence: required checks passed)') : '';
      await this.backlog.addNote(task.id, `minions: ${lease.role} ${r.status}${drained ? ' (drain)' : ''}${r.verdict ? ` (${r.verdict})` : ''} at ${head.slice(0, 12)}: ${r.summary}${to === 'testing' && qa.reasons.length ? ` (QA required: ${qaWhy})` : ''}${ciNote}`);
    } catch (e) {
      this.db.addEvent('record-backlog-error', task.id, { leaseId, error: (e as Error).message });
    }
    if (publish) {
      let publication: PublishResponse;
      try { publication = await this.publish(task.id); } catch (e) {
        // The approval and the pending publication are recorded; `minions work publish` retries.
        this.db.addEvent('publish-error', task.id, { error: (e as Error).message });
        publication = {
          taskId: task.id, branch: lease.branch!, headSha: head, mode: cfg.delivery.mode, state: 'pending', status: from, prUrl: null, merged: false,
          errorCode: (e as MinionsError).code ?? 'INTERNAL', retryable: true,
          message: `Approved at ${head}, but publication did not complete (${(e as Error).message}). Retry with \`minions work publish ${task.id}\`.`,
        };
      }
      return { ...base, valid: true, from, to: publication.status, approved, replan, needsSplit, repairCycles, headSha: head, publication, message: publication.message };
    }
    return { ...base, valid: true, from, to, approved, replan, needsSplit, repairCycles, headSha: head, ...(drained ? { drain: true } : {}),
      message: message || `Recorded ${lease.role} ${r.status}; task ${from} → ${to}.` };
  }

  private async setStatus(taskId: string, status: TaskStatus): Promise<Task> {
    const t = await this.backlog.getTask(taskId);
    return t.status === status ? t : this.backlog.updateTask(t.id, t.version, { status });
  }

  private async note(taskId: string, text: string): Promise<void> {
    try { await this.backlog.addNote(taskId, text); } catch (e) {
      this.db.addEvent('publish-backlog-error', taskId, { error: (e as Error).message });
    }
  }

  /**
   * Publishes an approved task (branch / pull-request delivery). Idempotent: reruns after a crash
   * or failure reconcile with the remote branch and an existing PR. The task becomes `delivered`
   * (with prUrl in pull-request mode) only after publication succeeded; it is never merged.
   */
  async publish(taskId: string): Promise<PublishResponse> {
    const cfg = this.config;
    const pub = this.db.publication(taskId);
    if (!pub) {
      throw new MinionsError('PRECONDITION', `Task ${taskId} has no approved publication.`,
        'Publication starts when a reviewer approval is recorded with delivery.mode branch or pull-request.');
    }
    if (cfg.delivery.mode === 'local') {
      throw new MinionsError('PRECONDITION', 'delivery.mode is "local": nothing is published.', 'Export branches with `minions export` on the host.');
    }
    const held = this.db.activeLeases().find((l) => l.task_id === taskId);
    if (held) throw new MinionsError('CONFLICT', `Task ${taskId} has an active ${held.role} lease (${held.id}); publish after it ends.`);
    let task = await this.backlog.getTask(taskId);
    const resp = (state: PublicationState, status: TaskStatus, message: string, extra: Partial<PublishResponse> = {}): PublishResponse =>
      ({ taskId, branch: pub.branch, headSha: pub.head_sha, mode: cfg.delivery.mode, state, status, prUrl: extra.prUrl ?? pub.pr_url, merged: false, ...extra, message });

    if (pub.state === 'published' && task.status === 'delivered' && (cfg.delivery.mode === 'branch' || task.prUrl)) {
      return this.withMerge(resp('published', 'delivered', `Already delivered: ${pub.branch} at ${pub.head_sha}${task.prUrl ? ` (${task.prUrl}, not merged)` : ''}.`, { prUrl: task.prUrl }));
    }

    const failWith = async (code: string, message: string, retryable: boolean): Promise<PublishResponse> => {
      this.db.setPublicationState(taskId, 'failed', { errorCode: code, error: message });
      this.db.addEvent('publish', taskId, { state: 'failed', code, message });
      await this.setStatus(taskId, 'blocked');
      await this.note(taskId, `minions: publication of ${pub.branch} at ${pub.head_sha.slice(0, 12)} failed (${code}): ${message} Local branch kept; retry with \`minions work publish ${taskId}\`.`);
      return resp('failed', 'blocked', `Publication failed (${code}): ${message} The local branch is kept; the task is blocked until \`minions work publish ${taskId}\` succeeds.`, { errorCode: code, retryable });
    };

    const head = await headOf(this.layout.repo, pub.branch);
    if (head !== pub.head_sha) {
      return failWith('PRECONDITION', `${pub.branch} is at ${head ?? '(missing)'}, not the approved head ${pub.head_sha}; test and review the new head before publishing.`, false);
    }
    // Delivery evidence (D6): a complete gate (reviewer) for this head, and a complete verifier (tester) when QA is required.
    const reviewed = this.passedAt(taskId, head, 'gate');
    const tested = this.passedAt(taskId, head, 'verifier') ||
      !(await this.qaRequirement(task, head)).reasons.length;
    if (!reviewed || !tested) {
      return failWith('PRECONDITION', `no ${!reviewed ? 'reviewer approval' : 'passing tester evidence'} for ${head} at config revision ${cfg.configRevision}; run the stage again.`, false);
    }

    const outcome = await this.publisher({
      config: cfg, task, repo: this.layout.repo, branch: pub.branch, head,
      approvals: this.db.approvals(taskId, 'publish', head).map((a) => a.signature),
      // Bases recorded at claim time: the sensitive-path gate must not depend on the movable local base ref.
      baseShas: this.db.leases({ taskId, all: true }).map((l) => l.base_sha),
      approvalPublicKeyFile: this.approvalPublicKeyFile,
      // The server: minions' recorded repository (the task's PR URL, else the import record).
      ...this.originOpts(task),
      ...(this.serverUrl ? { serverUrl: this.serverUrl } : {}),
    });

    if (outcome.state === 'failed') return failWith(outcome.code, outcome.message, outcome.retryable);
    if (outcome.state === 'awaiting-approval') {
      this.db.setPublicationState(taskId, 'awaiting-approval');
      this.db.addEvent('publish', taskId, { state: 'awaiting-approval', reasons: outcome.reasons, sensitivePaths: outcome.sensitivePaths, approvalError: outcome.approvalError });
      await this.setStatus(taskId, 'awaiting-human');
      const how = `the user approves on the host (in the repository, outside the container) with \`minions work approve ${taskId} --head ${head}\`, which signs the approval with the host-held key; then run \`minions work publish ${taskId}\``;
      await this.note(taskId, `minions: publication of ${pub.branch} at ${head.slice(0, 12)} waits for human approval: ${outcome.reasons.join('; ')}.`);
      return resp('awaiting-approval', 'awaiting-human', `Not published: ${outcome.reasons.join('; ')} (${outcome.approvalError}). Nothing was pushed; ask the user — ${how}.`,
        { reasons: outcome.reasons, sensitivePaths: outcome.sensitivePaths, approvalError: outcome.approvalError });
    }

    this.db.setPublicationState(taskId, 'published', { prUrl: outcome.prUrl });
    this.db.addEvent('publish', taskId, { state: 'published', push: outcome.push, pr: outcome.pr, prUrl: outcome.prUrl, head });
    task = await this.backlog.getTask(taskId);
    if ((outcome.prUrl && task.prUrl !== outcome.prUrl) || task.branch !== pub.branch) {
      task = await this.backlog.updateTask(taskId, task.version, { ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}), branch: pub.branch });
    }
    if (task.status !== 'delivered') await this.backlog.closeTask(taskId, 'delivered');
    const what = outcome.prUrl ? `pull request ${outcome.prUrl} (${outcome.pr === 'created' ? 'opened' : 'existing'}, open, not merged)` : `branch ${pub.branch} on origin`;
    await this.note(taskId, `minions: delivered ${pub.branch} at ${head.slice(0, 12)} as ${what}.`);
    return this.withMerge(resp('published', 'delivered', `Delivered ${pub.branch} at ${head} as ${what}.${cfg.delivery.merge === 'auto-when-eligible' ? '' : ' minions does not merge.'}`,
      { prUrl: outcome.prUrl, push: outcome.push, pr: outcome.pr, sensitivePaths: outcome.sensitivePaths }));
  }

  /** Appends the auto-merge pass to a delivered response (only with delivery.merge "auto-when-eligible"). */
  private async withMerge(r: PublishResponse): Promise<PublishResponse> {
    if (this.config.delivery.merge !== 'auto-when-eligible' || this.config.delivery.mode !== 'pull-request') return r;
    let merge: MergeResult;
    try { merge = await this.autoMerge(r.taskId); } catch (e) {
      this.db.addEvent('merge-error', r.taskId, { error: (e as Error).message });
      return { ...r, message: `${r.message} Auto-merge was not evaluated (${(e as Error).message}); \`minions sync ${r.taskId}\` retries.` };
    }
    if (merge.merged) return { ...r, status: 'done', merged: true, merge, message: `${r.message} ${merge.message}` };
    return { ...r, merge, message: `${r.message} ${merge.message}` };
  }

  /**
   * CI-gated auto-merge pass for a delivered task (delivery.merge "auto-when-eligible"; src/runtime/merge.ts):
   * every gate is evaluated for the approved publication head (CI through `ciGate`, the sensitive-path
   * gate, pr.merge policy with host-signed merge approvals); GitHub auto-merge is armed only then, and
   * disarmed when a PR minions armed stops passing. Run by `minions sync` and `minions work publish`.
   */
  async autoMerge(taskId: string): Promise<MergeResult> {
    return autoMergeTask({
      db: this.db, backlog: this.backlog, config: this.config, repo: this.layout.repo, gh: this.gh, git,
      ciGate: (id, head) => this.ciGate(id, head), approvalPublicKeyFile: this.approvalPublicKeyFile, now: this.now,
      ...(this.serverUrl ? { serverUrl: this.serverUrl } : {}),
    }, taskId);
  }

  /**
   * Records a host-signed approval (scope "merge") to merge the delivered PR at its approved head, which
   * pr.merge "ask" requires (the default, and any sensitive-path change). Verified now and again by
   * every auto-merge pass; the DB row only carries the token. A new head needs a new approval.
   */
  approveMerge(taskId: string, opts: { head?: string; by?: string; note?: string; signature?: string; now?: Date } = {}): { taskId: string; headSha: string; approvalId: number; expiresAt: string; message: string } {
    const pub = this.db.publication(taskId);
    if (!pub || pub.state !== 'published' || !pub.pr_url) {
      throw new MinionsError('PRECONDITION', `Task ${taskId} has no delivered pull request to approve for merging.`, 'Merge approval applies after pull-request delivery.');
    }
    if (opts.head && opts.head !== pub.head_sha) {
      throw new MinionsError('CONFLICT', `--head ${opts.head} is not the approved, delivered head (${pub.head_sha}).`, 'Approve the exact head that was reviewed and delivered.');
    }
    if (!opts.signature) {
      throw new MinionsError('PRECONDITION', 'Merge approvals must be signed on the host; an unsigned approval is not accepted.',
        `The user runs \`minions work approve ${taskId} --head ${pub.head_sha} --merge\` on the host, in the repository (not inside the runtime).`);
    }
    let publicKey: string | null = null;
    try { publicKey = readFileSync(this.approvalPublicKeyFile, 'utf8'); } catch { publicKey = null; }
    const check = publicKey
      ? verifyApproval(opts.signature, publicKey, { taskId, head: pub.head_sha, now: opts.now, scope: 'merge' })
      : { ok: false as const, reason: missingApprovalKeyReason(this.approvalPublicKeyFile) };
    if (!check.ok) {
      throw new MinionsError('POLICY_DENIED', `Merge approval rejected: ${check.reason}.`,
        `The user re-runs \`minions work approve ${taskId} --head ${pub.head_sha} --merge\` on the host.`);
    }
    const by = check.payload.by ?? opts.by ?? null;
    const a = this.db.addApproval({ task_id: taskId, scope: 'merge', head_sha: pub.head_sha, approved_by: by, note: opts.note ?? null, signature: opts.signature });
    this.db.addEvent('approval', taskId, { scope: 'merge', head: pub.head_sha, by, approvalId: a.id, kid: check.payload.kid, expiresAt: check.payload.expiresAt });
    return { taskId, headSha: pub.head_sha, approvalId: a.id, expiresAt: check.payload.expiresAt,
      message: `Recorded host-signed approval to merge ${pub.pr_url} at ${pub.head_sha} (valid until ${check.payload.expiresAt}). Run \`minions sync ${taskId}\`; auto-merge is armed once every other gate passes.` };
  }

  /**
   * Records a host-signed human approval to publish the task's approved head (needed when publication
   * touches sensitive paths or git.push / pr.create are "ask"). The signature (made by the host CLI
   * with a key the runtime cannot read) must cover exactly this task and head; it is checked here to
   * fail fast and again by publishTask right before pushing, because the DB row itself is writable by
   * in-runtime code and is not trusted. New commits need a new approval.
   */
  approvePublication(taskId: string, opts: { head?: string; by?: string; note?: string; signature?: string; now?: Date } = {}): { taskId: string; headSha: string; approvalId: number; expiresAt: string; message: string } {
    const pub = this.db.publication(taskId);
    if (!pub) throw new MinionsError('PRECONDITION', `Task ${taskId} has no approved publication to authorize.`, 'Approval applies after the reviewer approved the task.');
    if (pub.state === 'published') throw new MinionsError('PRECONDITION', `Task ${taskId} is already published at ${pub.head_sha}.`);
    if (opts.head && opts.head !== pub.head_sha) {
      throw new MinionsError('CONFLICT', `--head ${opts.head} is not the head awaiting publication (${pub.head_sha}).`, 'Approve the exact head that was reviewed.');
    }
    if (!opts.signature) {
      throw new MinionsError('PRECONDITION', 'Publication approvals must be signed on the host; an unsigned approval is not accepted.',
        `The user runs \`minions work approve ${taskId} --head ${pub.head_sha}\` on the host, in the repository (not inside the runtime).`);
    }
    let publicKey: string | null = null;
    try { publicKey = readFileSync(this.approvalPublicKeyFile, 'utf8'); } catch { publicKey = null; }
    const check = publicKey
      ? verifyApproval(opts.signature, publicKey, { taskId, head: pub.head_sha, now: opts.now })
      : { ok: false as const, reason: missingApprovalKeyReason(this.approvalPublicKeyFile) };
    if (!check.ok) {
      throw new MinionsError('POLICY_DENIED', `Approval rejected: ${check.reason}.`,
        `The user re-runs \`minions work approve ${taskId} --head ${pub.head_sha}\` on the host.`);
    }
    const by = check.payload.by ?? opts.by ?? null;
    const a = this.db.addApproval({ task_id: taskId, scope: 'publish', head_sha: pub.head_sha, approved_by: by, note: opts.note ?? null, signature: opts.signature });
    this.db.addEvent('approval', taskId, { scope: 'publish', head: pub.head_sha, by, approvalId: a.id, kid: check.payload.kid, expiresAt: check.payload.expiresAt });
    return { taskId, headSha: pub.head_sha, approvalId: a.id, expiresAt: check.payload.expiresAt,
      message: `Recorded host-signed approval to publish ${pub.branch} at ${pub.head_sha} (valid until ${check.payload.expiresAt}). Run \`minions work publish ${taskId}\`.` };
  }
}
