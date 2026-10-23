import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BacklogAdapter, ScopeFilter, Task, TaskStatus } from '../backlog/types.js';
import { can, matchesAny } from '../config/capabilities.js';
import { isGithubDelivery } from '../config/delivery.js';
import { baseRoleName, ENGINEER_ROLE, roleLimit, workerRoleNames } from '../config/roles.js';
import type { MinionsConfig } from '../config/schema.js';
import { verifyApproval } from '../core/approval.js';
import { MinionsError } from '../core/errors.js';
import { syncBaseFromOrigin, type BaseSyncResult } from './base-sync.js';
import type { Lease, LeaseRole, PublicationState, RuntimeDb } from './db.js';
import { removeLeaseFiles, type HandoffPaths } from './handoff.js';
import { missingApprovalKeyReason, runtimePaths } from './paths.js';
import { publishTask, realGh, type GhFn, type PublishInput, type PublishOutcome } from './publish.js';
import { isCiCheck, validateResult, type WorkerResult } from './results.js';
import { assertBudgetAllowsStart, billingOf, budgetNotice, recordLeaseUsage, tokensFromResultUsage, type Billing, type BudgetNotice, type SpendContext } from './spend.js';
import { readRequiredChecks, type RequiredChecksReport } from './ci.js';
import { ciGateFromDb, formatCiGate, type CiGate } from './ci-gate.js';
import { autoMergeTask, type MergeResult } from './merge.js';
import { BRANCH_PREFIX, branchFor, ensureBranchWorktree, ensureReviewWorktree, git, headOf, resolveBaseBranch, taskSlug, workspaceLayout, type WorkspaceLayout } from './worktree.js';

export const LEASE_ROLES: readonly LeaseRole[] = ['engineer', 'tester', 'reviewer'];

/** Backlog statuses a role may be claimed from. */
export const ROLE_STATUSES: Record<LeaseRole, TaskStatus[]> = {
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
}

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

/** Labels that opt a task into a per-task tester stage (verification.qaLabels, default ["qa"]). */
export const qaLabelsOf = (cfg: MinionsConfig): string[] => cfg.verification.qaLabels ?? ['qa'];

/**
 * A task with this label is a QA sweep: a tester runs it against the current base branch (not a
 * ticket branch), claimed from `ready`; its findings become new backlog tasks.
 */
export const QA_SWEEP_LABEL = 'qa-sweep';
export const isQaSweep = (task: Pick<Task, 'labels'>): boolean => task.labels.includes(QA_SWEEP_LABEL);

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

const RESULT_CONTRACT = 'Return exactly one JSON object: {status: complete|needs_changes|blocked|needs_split|partial, summary, branch, headSha (full SHA of the branch head you leave), modifiedPaths[], checks[{command, outcome: pass|fail|skipped, details?, source?: local|ci (ci: a required CI check for this head; tester/reviewer with ciAuthority github only)}], acceptanceEvidence[{criterion, evidence}], findings[], nextAction, verdict?: approve|request-changes (reviewer only), usage? (only when actually available)}.';

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

  constructor(deps: SchedulerDeps) {
    this.db = deps.db; this.backlog = deps.backlog; this.config = deps.config;
    this.layout = deps.layout ?? workspaceLayout();
    this.handoff = deps.handoff ?? null;
    this.publisher = deps.publisher ?? publishTask;
    this.baseSync = deps.baseSync ?? ((repo, base) => syncBaseFromOrigin(repo, base));
    this.approvalPublicKeyFile = deps.approvalPublicKeyFile ?? runtimePaths().approvalPublicKey;
    this.gh = deps.gh ?? realGh;
    this.now = deps.now ?? (() => new Date());
    this.billing = deps.billing ?? billingOf();
  }

  private readonly billing: Billing;
  spendContext(): SpendContext { return { db: this.db, billing: this.billing, config: this.config, now: this.now() }; }

  /**
   * Stores the lease's token total: the coordinator's --usage, else the result's usage block. Recorded
   * before the transition so spend is kept even when the record is rejected; the latest figure per lease
   * counts, so re-recording (or a correction) never double-counts.
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

  async claim(taskId: string, role: LeaseRole, opts: { holder?: string } = {}): Promise<TaskBrief> {
    if (!LEASE_ROLES.includes(role)) throw new MinionsError('INVALID_CONFIG', `Unknown role "${role}" (engineer|tester|reviewer).`);
    const cfg = this.config;
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
    const startEffect = can(cfg, 'task.start', { role });
    if (startEffect === 'deny') throw new MinionsError('POLICY_DENIED', `task.start is denied for role ${role} by configuration.`);

    const task = await this.backlog.getTask(taskId);
    // An active lease is a CONFLICT regardless of status (the claim itself moved the status on);
    // re-checked inside the transaction below.
    const held = this.db.activeLeases().find((l) => l.task_id === task.id);
    if (held) {
      throw new MinionsError('CONFLICT', `Task ${task.id} already has an active ${held.role} lease (${held.id}).`,
        'One active stage per task: wait for it, record its result, or release it.', { leaseId: held.id, role: held.role });
    }
    const sweep = isQaSweep(task);
    if (sweep && role !== 'tester') {
      throw new MinionsError('PRECONDITION', `Task ${task.id} is a QA sweep (label ${QA_SWEEP_LABEL}); only a tester runs it.`, `Claim it with --role tester.`);
    }
    const allowed: TaskStatus[] = sweep ? ['ready'] : ROLE_STATUSES[role];
    if (!allowed.includes(task.status)) {
      throw new MinionsError('PRECONDITION', `Task ${task.id} is "${task.status}"; a ${sweep ? 'QA sweep' : role} can only be claimed from ${allowed.join('|')}.`);
    }
    if ((role === 'engineer' || sweep) && task.status === 'ready') {
      if (!task.authorized) throw new MinionsError('POLICY_DENIED', `Task ${task.id} is not authorized to start.`, 'Label it minions:authorized or enable intake.startReady.');
      for (const dep of task.dependencies) {
        let d: Task;
        try { d = await this.backlog.getTask(dep); } catch (e) {
          throw new MinionsError('PRECONDITION', `Task ${task.id}: dependency ${dep} cannot be read (${(e as Error).message}).`);
        }
        if (d.status !== 'done' && d.status !== 'delivered') throw new MinionsError('PRECONDITION', `Task ${task.id} depends on ${dep}, which is "${d.status}".`);
      }
    }
    if (isGithubDelivery(cfg)) await this.syncBase(task.id, role);
    const allTasks = await this.backlog.listTasks();
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
      const slots = cap.byRole[role];
      if (slots?.limited && slots.active >= slots.max) {
        const label = role === ENGINEER_ROLE ? 'Engineer' : `Role ${role}`;
        throw new MinionsError('CAPACITY', `${label} limit reached (${slots.active}/${slots.max}).`, `Wait for a${role === ENGINEER_ROLE ? 'n' : ''} ${role} to finish.`, cap);
      }
      const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND role = ?', task.id, role)!.n + 1;
      this.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, branch, config_revision, started_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`, leaseId, task.id, role, n, holder, branch, cfg.configRevision, nowIso());
      this.db.addEvent('claim', task.id, { leaseId, role, attempt: n, fromStatus: task.status, holder, ...(sweep ? { kind: 'qa-sweep' } : {}) });
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
      if (role !== 'engineer' && !(await headOf(this.layout.repo, branch))) {
        throw new MinionsError('PRECONDITION', `Task ${task.id} has no branch ${branch} to ${role === 'tester' ? 'test' : 'review'}.`, 'Run the engineer stage first.');
      }
      if (role === 'reviewer') {
        const b = await resolveBaseBranch(this.layout.repo, cfg.git.baseBranch);
        baseBranch = b.branch; baseSha = b.sha; head = (await headOf(this.layout.repo, branch))!;
        worktree = (await ensureReviewWorktree(this.layout, slug, head)).worktree;
      } else {
        const wt = await ensureBranchWorktree(this.layout, slug, cfg.git.baseBranch);
        baseBranch = wt.baseBranch; baseSha = wt.baseSha; head = wt.head; worktree = wt.worktree;
      }
      this.db.exec('UPDATE leases SET worktree = ?, base_sha = ?, head_sha = ? WHERE id = ?', worktree, baseSha, head, leaseId);
      if (role === 'engineer') {
        const fresh = await this.backlog.getTask(task.id);
        await this.backlog.updateTask(task.id, fresh.version, { status: 'implementing', branch });
      } else if (task.branch !== branch) {
        const fresh = await this.backlog.getTask(task.id);
        await this.backlog.updateTask(task.id, fresh.version, { branch });
      }
    } catch (e) {
      this.endLease(leaseId, 'released', { reason: `claim failed: ${(e as Error).message}` });
      await this.cleanupLeaseFiles(leaseId);
      throw e;
    }

    const brief = this.buildBrief(this.db.lease(leaseId)!, task, { attempt, branch, worktree, baseBranch, baseSha, head, startEffect });
    if (role !== 'engineer' && cfg.verification.ciAuthority === 'github') brief.ci = await this.ciGate(task.id, head);
    return brief;
  }

  /**
   * GitHub delivery: origin/<base> is the single source of truth. Fetch it and fast-forward the local
   * base before any lease exists; a fetch failure or a local base that origin does not contain blocks
   * the claim (the error propagates unchanged and is recorded as a `base-sync-blocked` event).
   */
  private async syncBase(taskId: string, role: LeaseRole): Promise<void> {
    const base = this.config.git.baseBranch;
    try {
      const r = await this.baseSync(this.layout.repo, base);
      if (r.action !== 'up-to-date') this.db.addEvent('base-sync', taskId, { role, ...r });
    } catch (e) {
      const err = e as Partial<MinionsError>;
      this.db.addEvent('base-sync-blocked', taskId, { role, base, code: err.code ?? 'INTERNAL', message: err.message ?? String(e), details: err.details ?? null });
      throw e;
    }
  }

  private buildBrief(lease: Lease, task: Task, x: { attempt: number; branch: string; worktree: string; baseBranch: string; baseSha: string; head: string; startEffect: string; sweep?: boolean }): TaskBrief {
    const cfg = this.config;
    const role = lease.role;
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
        'git.commit': role === 'reviewer' || x.sweep ? 'deny' : can(cfg, 'git.commit', { role }),
        'git.push': x.sweep ? 'deny' : can(cfg, 'git.push', { role }),
        'pr.create': x.sweep ? 'deny' : can(cfg, 'pr.create', { role }),
      },
      policy: {
        taskStart: x.startEffect, codeEdit: can(cfg, 'code.edit', { role }), gitCommit: can(cfg, 'git.commit', { role }),
        sensitivePaths: [...cfg.sensitivePaths], architecture: cfg.architecture,
      },
      model: cfg.models.default,
      allowedModels: [...cfg.models.allowed],
      effort: null,
      maxTurns: cfg.execution.attemptMaxTurns,
      configRevision: cfg.configRevision,
      deliveryMode: cfg.delivery.mode,
      priorFindings,
      ...(resume ? { resume } : {}),
      resultContract: RESULT_CONTRACT,
    };
  }

  /** The last ended lease of the task, when it was a drain partial of the same role: what to continue from. */
  private drainResume(taskId: string, lease: Lease, branch: string): DrainResume | undefined {
    const last = this.db.leases({ taskId, all: true }).filter((l) => l.id !== lease.id && l.status !== 'active').at(-1);
    if (!last || last.role !== lease.role || last.result_valid !== 1 || !last.result_json) return undefined;
    const drained = this.db.events(taskId, 'record').some((e) => (e.data as { leaseId?: string; drain?: boolean } | null)?.leaseId === last.id && (e.data as { drain?: boolean }).drain === true);
    if (!drained) return undefined;
    const r = JSON.parse(last.result_json) as WorkerResult;
    const at = last.head_sha ? ` at ${last.head_sha}` : '';
    const instruction = lease.role === 'reviewer'
      ? `The previous review was interrupted by a drain (upgrade). Review ${branch}${at} again from the start; the remaining work lists what was not reviewed yet.`
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
    return (await git(this.layout.repo, ['merge-base', '--is-ancestor', from, to], true)).code === 0;
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

  /** Paths the branch changes against the base (null when the diff cannot be computed). */
  private async changedPaths(head: string): Promise<string[] | null> {
    try {
      const base = await resolveBaseBranch(this.layout.repo, this.config.git.baseBranch);
      const d = await git(this.layout.repo, ['diff', '--name-only', '--no-renames', '-z', `${base.ref}...${head}`], true);
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

  /** Puts an engineer's task back to its pre-claim status so it can be claimed again (worktree kept). */
  private async restoreAfterEngineer(lease: Lease): Promise<TaskStatus | undefined> {
    if (lease.role !== 'engineer') return undefined;
    const from = this.preClaimStatus(lease) ?? 'ready';
    const t = await this.backlog.getTask(lease.task_id);
    if (t.status !== 'implementing') return t.status;
    await this.backlog.updateTask(t.id, t.version, { status: from });
    return from;
  }

  /**
   * Removes the hand-off files (brief, submitted and rejected result) of an ended lease. Best-effort: a failed
   * delete is logged as a `handoff-cleanup-error` event and never fails the transition.
   */
  private async cleanupLeaseFiles(leaseId: string): Promise<void> {
    if (!this.handoff) return;
    let errors: string[];
    try { errors = await removeLeaseFiles(this.handoff, leaseId); } catch (e) { errors = [(e as Error).message]; }
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

  /** Releases a lease without a result. The worktree and branch are always preserved. */
  async release(leaseId: string, reason: string, opts: { usage?: UsageFlag } = {}): Promise<{ leaseId: string; taskId: string; worktree: string | null; branch: string | null; status: TaskStatus | null } & Pick<RecordResponse, 'usage' | 'budget'>> {
    const lease = await this.requireActive(leaseId);
    const usage = this.noteUsage(lease, undefined, opts.usage, 'release');
    this.endLease(leaseId, 'released', { reason });
    await this.cleanupLeaseFiles(leaseId);
    let status: TaskStatus | null = null;
    try {
      status = (await this.restoreAfterEngineer(lease)) ?? (await this.backlog.getTask(lease.task_id)).status;
      await this.backlog.addNote(lease.task_id, `minions: ${lease.role} lease ${leaseId} released: ${reason}. Worktree kept at ${lease.worktree ?? '(none)'}.`);
    } catch (e) {
      this.db.addEvent('release-backlog-error', lease.task_id, { leaseId, error: (e as Error).message });
    }
    return this.withBudget({ leaseId, taskId: lease.task_id, worktree: lease.worktree, branch: lease.branch, status }, usage);
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
    const v = validateResult(raw, lease.role, { ciAuthority: this.config.verification.ciAuthority });
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
      else if (lease.role === 'reviewer' && lease.head_sha && lease.head_sha !== actualHead) {
        errors.push(`stale head: review started at ${lease.head_sha} but ${lease.branch} moved to ${actualHead}`);
      } else if (lease.role === 'tester' && lease.head_sha && actualHead !== lease.head_sha &&
        !(await this.isAncestor(lease.head_sha, actualHead))) {
        // Testers may add commits on top of the head they were given, but must not rewrite it.
        errors.push(`stale head: testing started at ${lease.head_sha} but ${lease.branch} at ${actualHead} no longer contains it`);
      }
    }

    // CI evidence cited by a tester/reviewer: decided by the runtime gate for the exact head, never by the claim itself.
    let ciGate: CiGate | null = null;
    if (result && !errors.length && !sweep && result.status === 'complete' && (lease.role === 'tester' || lease.role === 'reviewer') && result.checks.some(isCiCheck)) {
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
      try { await this.restoreAfterEngineer(lease); } catch (e) {
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
    const afterTesting: TaskStatus = cfg.verification.reviewerRequired ? 'reviewing' : 'delivered';
    // Per-task QA requirement (risk-based testing), evaluated when an engineer or reviewer finishes.
    const flagged = lease.role === 'reviewer' && r.needsQa === true;
    const qa: QaRequirement = !sweep && lease.role !== 'tester' && (r.status === 'complete' || flagged)
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

    if (sweep) {
      if (r.status === 'complete' || r.status === 'needs_changes') {
        to = 'done';
        message = `QA sweep of ${lease.branch} at ${head} recorded (${r.findings.length} finding(s)). Create a backlog task for each finding (minions backlog create, idempotency key qa:${task.id}:<n>).`;
      } else if (r.status === 'blocked') to = 'blocked';
      else if (r.status === 'needs_split') { to = 'awaiting-human'; needsSplit = true; message = 'QA sweep reported needs_split: create smaller sweep tasks.'; }
      else message = 'Partial QA sweep recorded; status unchanged (claim it again to finish).';
    } else if (ciBlock === 'fail') {
      to = 'changes-requested';
      message = `Not approved: ${formatCiGate(ciGate!)}. Task → changes-requested; repair with the failing checks as findings.`;
      if (lease.role === 'reviewer') {
        repairCycles = this.db.incrementRepairs(task.id);
        if (repairCycles >= cfg.execution.maxRepairCyclesBeforeReplan) {
          replan = true; to = 'awaiting-human';
          message += ` Repair cycle ${repairCycles} reached the limit (${cfg.execution.maxRepairCyclesBeforeReplan}); replan the task before more repairs.`;
        }
      }
    } else if (ciBlock === 'unverified') {
      to = from;
      message = `Not approved: the ${lease.role} relied on CI, but ${formatCiGate(ciGate!)}. Task stays ${from}: ${ciGate!.state === 'pending' ? 'run \`minions sync\` after CI finishes and re-dispatch, or ' : ''}re-dispatch the ${lease.role} with local verification (run the verification commands).`;
    } else switch (r.status) {
      case 'complete':
        if (lease.role === 'engineer') {
          to = qa.reasons.length ? 'testing' : afterTesting;
          if (qa.reasons.length && !cfg.verification.testerRequired) message = `Recorded engineer complete; QA required (${qaWhy}): task → testing.`;
        } else if (lease.role === 'tester') to = afterTesting;
        else {
          const testerOk = !qa.reasons.length ||
            this.db.evidenceFor(task.id, head, 'tester', cfg.configRevision).some((e) => e.outcome === 'complete');
          if (testerOk && cfg.delivery.mode !== 'local') {
            // Publication (below) decides the final status; the task is never delivered before it succeeds.
            approved = true; publish = true;
          } else if (testerOk) { to = 'delivered'; approved = true; message = `Approved at ${head}; delivered locally (export with minions export).`; }
          else { to = 'testing'; message = `Approval not applied: QA required (${qaWhy}) and no passing tester evidence for head ${head} at config revision ${cfg.configRevision}. Run the tester.`; }
        }
        break;
      case 'needs_changes':
        if (lease.role === 'engineer') { to = this.preClaimStatus(lease) ?? 'ready'; message = 'Engineer reported needs_changes; task returned for re-planning.'; break; }
        to = 'changes-requested';
        if (lease.role === 'reviewer') {
          repairCycles = this.db.incrementRepairs(task.id);
          if (repairCycles >= cfg.execution.maxRepairCyclesBeforeReplan) {
            replan = true; to = 'awaiting-human';
            message = `Repair cycle ${repairCycles} reached the limit (${cfg.execution.maxRepairCyclesBeforeReplan}); replan the task before more repairs.`;
          }
        }
        break;
      case 'blocked': to = 'blocked'; break;
      case 'needs_split': to = 'awaiting-human'; needsSplit = true; message = 'Worker reported needs_split: create child tasks idempotently and link dependencies.'; break;
      case 'partial':
        to = lease.role === 'engineer' ? (this.preClaimStatus(lease) ?? 'ready') : from;
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
    const reviewed = this.db.evidenceFor(taskId, head, 'reviewer', cfg.configRevision).some((e) => e.outcome === 'complete');
    const tested = this.db.evidenceFor(taskId, head, 'tester', cfg.configRevision).some((e) => e.outcome === 'complete') ||
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
