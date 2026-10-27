/**
 * Workflow model (docs/design/roles-and-workflows.md D5-D7): a task runs an ordered list of stages, each a
 * worker role from the registry (src/config/roles.ts). The default workflow is derived from the
 * verification settings and equals the built-in pipeline (engineer -> tester on QA -> reviewer); a project
 * may configure named workflows (and replace `default`). These are pure functions over the config; the
 * scheduler (src/runtime/scheduler.ts) keeps the per-task position in the `task_stages` table.
 */
import type { TaskStatus } from '../backlog/types.js';
import type { ConfigIssue } from '../core/errors.js';
import { harnessModels } from './harnesses.js';
import { COORDINATOR_ROLE, REVIEWER_ROLE, ROLE_NAME_PATTERN, TESTER_ROLE, modelsPath, workerRole, workerRoleNames, type RoleDef } from './roles.js';
import { STAGE_STATUSES, type MinionsConfig, type RoleContract, type WorkflowStageConfig } from './schema.js';

export const DEFAULT_WORKFLOW = 'default';

/**
 * A resolved stage. `inserted` marks a stage the runtime added to the configured list: the built-in tester
 * of invariant 3 (`qa`) or, for a legacy task whose status names a stage its workflow lacks, `legacy`.
 */
export interface Stage { role: string; when?: 'qa'; model?: string; inserted?: 'qa' | 'legacy' }
export interface Workflow { name: string; stages: Stage[] }

type WfCfg = Pick<MinionsConfig, 'verification' | 'execution' | 'models'> & Partial<Pick<MinionsConfig, 'roles' | 'workflows' | 'harnesses'>>;

const own = <T>(obj: Record<string, T> | undefined, key: string): T | undefined => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

export const normalizeStage = (s: WorkflowStageConfig): Stage =>
  typeof s === 'string' ? { role: s } : { role: s.role, ...(s.when ? { when: s.when } : {}), ...(s.model ? { model: s.model } : {}) };

/** The derived default (D5): engineer, tester (always with testerRequired, else on QA), reviewer when required. */
export function derivedDefaultWorkflow(cfg: Pick<MinionsConfig, 'verification'>): Stage[] {
  return [
    { role: 'engineer' },
    cfg.verification.testerRequired ? { role: TESTER_ROLE } : { role: TESTER_ROLE, when: 'qa' },
    ...(cfg.verification.reviewerRequired ? [{ role: REVIEWER_ROLE }] : []),
  ];
}

/** Workflow names a task may be assigned: `default` plus the configured ones. */
export function workflowNames(cfg: Partial<Pick<MinionsConfig, 'workflows'>>): string[] {
  return [...new Set([DEFAULT_WORKFLOW, ...Object.keys(cfg.workflows ?? {})])];
}

/** The workflow a task runs: its assigned name (null/undefined = default); undefined when the name is not configured. */
export function resolveWorkflow(cfg: WfCfg, name: string | null | undefined): Workflow | undefined {
  const n = name ?? DEFAULT_WORKFLOW;
  const configured = own(cfg.workflows, n);
  if (configured) return { name: n, stages: configured.map(normalizeStage) };
  return n === DEFAULT_WORKFLOW ? { name: n, stages: derivedDefaultWorkflow(cfg) } : undefined;
}

export const roleOf = (cfg: WfCfg, s: Stage): RoleDef | undefined => workerRole(cfg, s.role);
export const contractOf = (cfg: WfCfg, s: Stage): RoleContract | undefined => roleOf(cfg, s)?.contract;
/** The backlog status a stage sits in while pending or running (D6). */
export const stageStatusOf = (cfg: WfCfg, s: Stage): TaskStatus => roleOf(cfg, s)?.stageStatus ?? 'implementing';

/** Index of the last gate stage, or -1. */
export function finalGateIndex(cfg: WfCfg, stages: Stage[]): number {
  for (let i = stages.length - 1; i >= 0; i--) if (contractOf(cfg, stages[i]!) === 'gate') return i;
  return -1;
}

/**
 * Invariant 3 (D5): with QA required, a runnable verifier must run after `position` and before the final
 * gate (or before the end when the final gate is not ahead). Returns the stages with the built-in tester
 * inserted there when none does, else the stages unchanged.
 */
export function withQaTester(cfg: WfCfg, stages: Stage[], position: number): Stage[] {
  const gate = finalGateIndex(cfg, stages);
  const end = gate > position ? gate : stages.length;
  for (let i = position + 1; i < end; i++) if (contractOf(cfg, stages[i]!) === 'verifier') return stages;
  return [...stages.slice(0, end), { role: TESTER_ROLE, inserted: 'qa' }, ...stages.slice(end)];
}

/** The next runnable stage after `position` (`when: qa` stages run only with QA reasons); null = workflow finished. */
export function nextRunnable(stages: Stage[], position: number, qaRequired: boolean): number | null {
  for (let i = position + 1; i < stages.length; i++) if (stages[i]!.when !== 'qa' || qaRequired) return i;
  return null;
}

/**
 * Where a gate/verifier `needs_changes` sends the task (D7): the nearest earlier stage of `roles.<r>.repairTo`
 * when set, else the nearest earlier producer that can commit, else the first stage. Verifiers are not
 * repair targets by default: they check work, they do not redo it (the built-in tester can commit, but a
 * reviewer's request-changes goes to the engineer, as before workflows).
 */
export function repairTarget(cfg: WfCfg, stages: Stage[], position: number): number {
  const stage = stages[position];
  const to = stage ? (own(cfg.roles as Record<string, { repairTo?: string } | undefined> | undefined, stage.role)?.repairTo) : undefined;
  if (to) for (let i = position - 1; i >= 0; i--) if (stages[i]!.role === to) return i;
  for (let i = position - 1; i >= 0; i--) {
    const r = roleOf(cfg, stages[i]!);
    if (r?.contract === 'producer' && r.commits) return i;
  }
  return 0;
}

/** Whether a later gate/verifier stage sends its repairs to `position` (D7). */
export function isRepairTarget(cfg: WfCfg, stages: Stage[], position: number): boolean {
  for (let j = position + 1; j < stages.length; j++) {
    const c = contractOf(cfg, stages[j]!);
    if ((c === 'gate' || c === 'verifier') && repairTarget(cfg, stages, j) === position) return true;
  }
  return false;
}

/**
 * Statuses the stage at `position` can be claimed from (D6): position 0 from ready / changes-requested, later
 * ones from their stageStatus, and from changes-requested when a later stage repairs to them.
 */
export function claimableStatuses(cfg: WfCfg, stages: Stage[], position: number): TaskStatus[] {
  if (position === 0) return ['ready', 'changes-requested'];
  const s = stages[position];
  if (!s) return [];
  return isRepairTarget(cfg, stages, position) ? [stageStatusOf(cfg, s), 'changes-requested'] : [stageStatusOf(cfg, s)];
}

/**
 * Every status a stage can be claimed from or sits in, over all configured workflows and the default (D6), plus
 * the statuses derivePosition maps onto a stage (ready, changes-requested and the built-in stage statuses, which
 * get an inserted tester / appended reviewer). A task entering one of these can be started by a claim; the
 * auto-promotion caps (src/runtime/auto-promote.ts) guard every move into this set.
 */
export function stageEntryStatuses(cfg: WfCfg): TaskStatus[] {
  const out = new Set<TaskStatus>(['ready', 'changes-requested', ...STAGE_STATUSES]);
  for (const name of workflowNames(cfg)) {
    const stages = resolveWorkflow(cfg, name)?.stages ?? [];
    stages.forEach((_s, i) => { for (const st of statusesAt(cfg, stages, i)) out.add(st); });
  }
  return [...out];
}

/** Statuses consistent with a task sitting at `position`: claimable, or the stage running. */
export function statusesAt(cfg: WfCfg, stages: Stage[], position: number): TaskStatus[] {
  const s = stages[position];
  if (!s) return [];
  return [...new Set([...claimableStatuses(cfg, stages, position), stageStatusOf(cfg, s)])];
}

/**
 * Position of a task without a stage row (legacy tasks, or a status changed outside the stage machine), from
 * its status (D6): ready / changes-requested / implementing = the first producer; otherwise the first stage
 * whose stageStatus is the status. A `testing` task whose workflow has no testing stage gets the inserted
 * tester (invariant 3); a `reviewing` one without a reviewing stage gets the built-in reviewer appended (the
 * optional reviewer of a config without reviewerRequired). null = no stage can run from this status.
 */
export function derivePosition(cfg: WfCfg, stages: Stage[], status: TaskStatus): { stages: Stage[]; position: number } | null {
  if (status === 'ready' || status === 'changes-requested' || status === 'implementing') {
    const i = stages.findIndex((s) => contractOf(cfg, s) === 'producer');
    return { stages, position: Math.max(0, i) };
  }
  const i = stages.findIndex((s) => stageStatusOf(cfg, s) === status && contractOf(cfg, s) !== 'producer');
  if (i >= 0) return { stages, position: i };
  if (status === 'testing') {
    const withTester = withQaTester(cfg, stages, 0);
    const at = withTester.findIndex((s) => s.inserted === 'qa');
    if (at >= 0) return { stages: withTester, position: at };
  }
  if (status === 'reviewing') return { stages: [...stages, { role: REVIEWER_ROLE, inserted: 'legacy' }], position: stages.length };
  return null;
}

/** The configured part of a stored stage list (runtime insertions removed), to compare with the config. */
export const configuredStages = (stages: Stage[]): Stage[] => stages.filter((s) => !s.inserted);
export const sameStages = (a: Stage[], b: Stage[]): boolean => JSON.stringify(a.map(normalizeStage)) === JSON.stringify(b.map(normalizeStage));

/** Invariants 1 and 2 (D5) plus stage model hints, for one workflow. */
export function workflowProblems(cfg: WfCfg, stages: Stage[]): { index: number | null; message: string }[] {
  const out: { index: number | null; message: string }[] = [];
  const workers = workerRoleNames(cfg);
  stages.forEach((s, i) => {
    if (s.role === COORDINATOR_ROLE) out.push({ index: i, message: 'the coordinator cannot be a workflow stage' });
    else if (!workerRole(cfg, s.role) || s.role.endsWith('-deep')) out.push({ index: i, message: `unknown role "${s.role}" (known: ${workers.join(', ')})` });
    // A hint is a model of the stage role's harness, never a harness (agent-runtimes D8); no block = reported elsewhere.
    const harness = workerRole(cfg, s.role)?.harness ?? 'claude';
    const models = harnessModels(cfg, harness);
    if (s.model !== undefined && models && !models.allowed.includes(s.model)) out.push({ index: i, message: `model "${s.model}" is not in ${modelsPath(harness)} [${models.allowed.join(', ')}]` });
  });
  if (out.length) return out;
  if (cfg.verification.reviewerRequired) {
    let lastCommit = -1;
    stages.forEach((s, i) => { if (roleOf(cfg, s)?.commits) lastCommit = i; });
    const gateAfter = stages.some((s, i) => i > lastCommit && contractOf(cfg, s) === 'gate');
    if (!gateAfter) {
      out.push({ index: null, message: lastCommit >= 0
        ? `verification.reviewerRequired: a gate stage (e.g. reviewer) must come after the last stage that can commit (${stages[lastCommit]!.role}, stage ${lastCommit + 1})`
        : 'verification.reviewerRequired: the workflow needs a gate stage (e.g. reviewer)' });
    }
  }
  return out;
}

/** Cross-field checks of `workflows` and `roles.<r>.repairTo` (run by validateConfig). */
export function workflowConfigIssues(c: MinionsConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [name, list] of Object.entries(c.workflows ?? {})) {
    const at = `workflows.${name}`;
    if (!ROLE_NAME_PATTERN.test(name)) { issues.push({ path: at, message: `workflow name must match ${ROLE_NAME_PATTERN.source}` }); continue; }
    for (const p of workflowProblems(c, list.map(normalizeStage))) issues.push({ path: p.index === null ? at : `${at}.${p.index}`, message: p.message });
  }
  for (const [name, raw] of Object.entries(c.roles ?? {})) {
    const to = (raw as { repairTo?: string } | undefined)?.repairTo;
    if (to === undefined) continue;
    const r = workerRole(c, name);
    if (r && r.contract === 'producer') issues.push({ path: `roles.${name}.repairTo`, message: 'only gate and verifier roles have a repair target' });
    if (to === name) issues.push({ path: `roles.${name}.repairTo`, message: 'a role cannot be its own repair target' });
    else if (!workerRole(c, to) || to.endsWith('-deep')) issues.push({ path: `roles.${name}.repairTo`, message: `unknown worker role "${to}" (known: ${workerRoleNames(c).join(', ')})` });
  }
  return issues;
}

/**
 * Where a gate that needs QA evidence sends the task (D6): the nearest verifier stage between the last
 * producer before the gate and the gate; without one, the built-in tester inserted right before the gate.
 */
export function verifierBefore(cfg: WfCfg, stages: Stage[], position: number): { stages: Stage[]; position: number } {
  for (let i = position - 1; i >= 0; i--) {
    const c = contractOf(cfg, stages[i]!);
    if (c === 'verifier') return { stages, position: i };
    if (c === 'producer') break;
  }
  return { stages: [...stages.slice(0, position), { role: TESTER_ROLE, inserted: 'qa' }, ...stages.slice(position)], position };
}

/**
 * The stage a lease of `role` runs when no stage row names it (a lease claimed before task_stages existed):
 * the first stage of that role, else the inserted tester / appended reviewer of derivePosition.
 */
export function positionForRole(cfg: WfCfg, stages: Stage[], role: string): { stages: Stage[]; position: number } {
  const i = stages.findIndex((s) => s.role === role);
  if (i >= 0) return { stages, position: i };
  if (role === TESTER_ROLE) {
    const withTester = withQaTester(cfg, stages, 0);
    const at = withTester.findIndex((s) => s.inserted === 'qa');
    if (at >= 0) return { stages: withTester, position: at };
  }
  return { stages: [...stages, { role, inserted: 'legacy' }], position: stages.length };
}

/** Parses a stored stage list; null when it is not one. */
export function parseStages(json: string): Stage[] | null {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'object' && s !== null && typeof (s as Stage).role === 'string')) return null;
    return v as Stage[];
  } catch { return null; }
}
