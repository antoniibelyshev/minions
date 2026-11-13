import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { dependencyDoneStatuses } from '../config/delivery.js';
import { validateConfig } from '../config/resolve.js';
import { workflowNames } from '../config/workflows.js';
import type { MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { readJson } from '../core/fsutil.js';
import { emit } from '../core/output.js';
import { containerPaths } from '../core/paths.js';
import { TASK_STATUSES } from './backlogmd.js';
import { MemoryIdempotencyStore, openBacklog } from './factory.js';
import { assertIntakeOpen } from './intake.js';
import type { BacklogAdapter, IdempotencyStore, Provenance, ScopeFilter, Task, TaskStatus } from './types.js';
import { withControl } from '../runtime/control.js';
import { runtimePaths } from '../runtime/paths.js';
import { GOAL_STATUSES, goalsView, readGoalsState, readGoalsText, runtimeGoalsPath, writeGoalsState, type GoalStatus, type GoalsView } from '../runtime/goals.js';

// ---------------------------------------------------------------- hooks set by the runtime

export interface ReadyHookState { leased: Set<string>; paused: boolean }
let readyContext: () => ReadyHookState | Promise<ReadyHookState> = () => ({ leased: new Set(), paused: false });
let idempotencyStore: IdempotencyStore = new MemoryIdempotencyStore();
let intakePaused: () => boolean | Promise<boolean> = () => false;

/** Runtime installs this at startup: active-lease task ids and paused_starts from the DB. */
export function setReadyContext(fn: () => ReadyHookState | Promise<ReadyHookState>): void { readyContext = fn; }
/** Runtime installs the DB-backed idempotency store at startup. */
export function setIdempotencyStore(store: IdempotencyStore): void { idempotencyStore = store; }
/** Runtime installs this at startup: paused_intake from the DB (`backlog create` refuses new intake while set). */
export function setIntakePausedContext(fn: () => boolean | Promise<boolean>): void { intakePaused = fn; }


// ---------------------------------------------------------------- config + adapter

/** Reads the effective config: env MINIONS_CONFIG, default /opt/minions/config/config.json, plus the control overlay. */
export async function loadRuntimeConfig(path = process.env.MINIONS_CONFIG || containerPaths().configJson): Promise<MinionsConfig> {
  return withControl(validateConfig(await readJson(path), path), runtimePaths().state);
}

async function open(): Promise<{ cfg: MinionsConfig; backlog: BacklogAdapter }> {
  const cfg = await loadRuntimeConfig();
  return { cfg, backlog: openBacklog(cfg, { idempotency: idempotencyStore }) };
}

export const scopeOf = (cfg: MinionsConfig): ScopeFilter => ({
  milestone: cfg.intake.scope.milestone,
  requiredLabels: cfg.intake.scope.requiredLabels,
  allowedPaths: cfg.intake.scope.allowedPaths,
});

// ---------------------------------------------------------------- helpers

const PRIORITIES = ['high', 'medium', 'low'] as const;
const PROVENANCES: readonly Provenance[] = ['external-requirement', 'user-decision', 'agent-hypothesis', 'observed-result'];

function oneOf<T extends string>(name: string, v: string | undefined, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  const x = v.toLowerCase();
  if (!(allowed as readonly string[]).includes(x)) {
    throw new MinionsError('PRECONDITION', `Invalid ${name} "${v}" (expected one of: ${allowed.join(', ')})`);
  }
  return x as T;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];
const OWNER_APPROVED_HELP = 'no-op, accepted for compatibility (there are no auto-promotion caps any more)';

/**
 * --workflow: a named workflow from config (docs/design/roles-and-workflows.md D5). Only configured names
 * are accepted (they passed the config invariants); an inline stage list is not.
 */
export function checkWorkflowName(cfg: MinionsConfig, name: string): string {
  const known = workflowNames(cfg);
  if (!known.includes(name)) {
    throw new MinionsError('PRECONDITION', `Unknown workflow "${name}" (configured: ${known.join(', ')}).`,
      'Use a workflow configured under "workflows" in the project config; the owner adds new ones on the host.');
  }
  return name;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', 'Expected input on stdin', 'Pipe the text in, or pass it as an option.');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const readTextFile = (f: string) => (f === '-' ? readStdin() : readFile(f, 'utf8'));

const line = (t: Task) => `${t.id.padEnd(10)} ${t.status.padEnd(17)} ${(t.priority ?? '-').padEnd(6)} ${t.title}`;
const lines = (ts: Task[]) => (ts.length ? ts.map(line).join('\n') : '(no tasks)');
function detail(t: Task): string {
  const out = [`${t.id}  ${t.title}`, `status: ${t.status}  priority: ${t.priority ?? '-'}  authorized: ${t.authorized}`,
    `labels: ${t.labels.join(', ') || '-'}  deps: ${t.dependencies.join(', ') || '-'}  parent: ${t.parent ?? '-'}`,
    `branch: ${t.branch ?? '-'}  provenance: ${t.provenance}  workflow: ${t.workflow ?? 'default'}`, `version: ${t.version}`];
  if (t.description) out.push('', t.description);
  if (t.acceptanceCriteria.length) out.push('', ...t.acceptanceCriteria.map((a, i) => `[${a.done ? 'x' : ' '}] #${i + 1} ${a.text}`));
  if (t.notes) out.push('', 'notes:', t.notes);
  return out.join('\n');
}

/** The goals view for `backlog goals`: the runtime's goals copy, the marks, and the backlog for the retrospective check. */
async function loadGoals(tasks?: Task[] | null): Promise<GoalsView & { path: string }> {
  const paths = runtimePaths();
  const path = runtimeGoalsPath(paths.configJson);
  const text = readGoalsText(path);
  return { path, ...goalsView(text, readGoalsState(paths.state), tasks ?? (text === null ? null : await (await open()).backlog.listTasks())) };
}

function humanGoalsList(v: GoalsView): string {
  if (!v.present) return 'No goals file (the owner writes goals.md next to the project config; `minions start` copies it in).';
  const out = v.goals.map((g) => `${g.id.padEnd(24)} ${g.status.padEnd(7)}${g.mark ? ' (marked)' : '         '} ${g.title}${g.measure ? `\n${' '.repeat(34)}measure: ${g.measure}` : ''}`);
  if (v.exhausted) out.push(`planning found nothing worthwhile left at ${v.exhausted.at}: ${v.exhausted.reason}`);
  if (v.retro) out.push(`retrospective: ${v.retro.due ? 'due' : 'not due'} (${v.retro.doneSince} task(s) done${v.retro.goalsDoneSince ? `, ${v.retro.goalsDoneSince} goal(s) done` : ''} since ${v.retro.last?.at ?? 'the start'})`);
  return out.join('\n') || '(no goals)';
}

// ---------------------------------------------------------------- compact listing

/** Fields `--compact` keeps for `backlog list|ready` (coordinator reads without full descriptions). */
export const COMPACT_FIELDS = ['id', 'title', 'status', 'priority', 'dependencies'] as const;
export const TASK_FIELDS: readonly (keyof Task)[] = ['id', 'locator', 'title', 'description', 'acceptanceCriteria', 'status', 'priority',
  'dependencies', 'parent', 'externalLinks', 'labels', 'authorized', 'branch', 'commits', 'provenance', 'version', 'milestone', 'workflow'];

/** Resolves `--fields a,b` / `--compact` into a field list (undefined = full tasks). Unknown fields are an error. */
export function selectFields(o: { fields?: string; compact?: boolean }): (keyof Task)[] | undefined {
  if (o.fields === undefined) return o.compact ? [...COMPACT_FIELDS] : undefined;
  const fields = o.fields.split(',').map((f) => f.trim()).filter(Boolean);
  const unknown = fields.filter((f) => !(TASK_FIELDS as readonly string[]).includes(f));
  if (unknown.length || !fields.length) {
    throw new MinionsError('PRECONDITION', `Unknown task field(s) in --fields: ${unknown.join(', ') || '(none given)'}.`, `Allowed: ${TASK_FIELDS.join(', ')}.`);
  }
  return [...new Set(fields)] as (keyof Task)[];
}

/** Keeps only the selected fields of each task (all fields when `fields` is undefined). */
export function projectTasks(tasks: Task[], fields?: readonly (keyof Task)[]): Partial<Task>[] {
  if (!fields) return tasks;
  return tasks.map((t) => Object.fromEntries(fields.filter((f) => f in t).map((f) => [f, t[f]])) as Partial<Task>);
}


// ---------------------------------------------------------------- commands

/** Registers backlog commands on the root program. */
export function register(program: Command): void {
  const bl = program.command('backlog').description('Query and edit the task backlog (container only)');

  const FIELDS_HELP = `JSON output keeps only these task fields (comma-separated; e.g. ${COMPACT_FIELDS.join(',')})`;
  const COMPACT_HELP = `same as --fields ${COMPACT_FIELDS.join(',')}`;

  bl.command('ready').description('List tasks ready to start (priority order)')
    .option('--limit <n>', 'maximum number of tasks', '10')
    .option('--fields <list>', FIELDS_HELP)
    .option('--compact', COMPACT_HELP)
    .action(action(async (opts: { limit: string; fields?: string; compact?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 0) throw new MinionsError('PRECONDITION', `--limit must be a non-negative integer (got ${opts.limit})`);
      const fields = selectFields(opts);
      const { cfg, backlog } = await open();
      const ctx = await readyContext();
      const tasks = ctx.paused ? [] : await backlog.listReady(limit, ctx.leased, scopeOf(cfg), dependencyDoneStatuses(cfg));
      emit({ paused: ctx.paused, tasks: projectTasks(tasks, fields) }, { json: globalOpts(cmd).json, human: (d) => (d.paused ? 'Starts are paused.\n' : '') + lines(tasks) });
    }));

  bl.command('list').description('List all tasks')
    .option('--fields <list>', FIELDS_HELP)
    .option('--compact', COMPACT_HELP)
    .action(action(async (opts: { fields?: string; compact?: boolean }, cmd: Command) => {
      requireMode('runtime');
      const fields = selectFields(opts);
      const { backlog } = await open();
      const tasks = await backlog.listTasks();
      emit({ tasks: projectTasks(tasks, fields) }, { json: globalOpts(cmd).json, human: () => lines(tasks) });
    }));

  bl.command('show <id>').description('Show one task, with its notes (the most recent ~8 KB)')
    .action(action(async (id: string, _opts: unknown, cmd: Command) => {
      requireMode('runtime');
      const { backlog } = await open();
      emit(await backlog.getTask(id), { json: globalOpts(cmd).json, human: detail });
    }));

  bl.command('create').description('Create a task (idempotent by --key)')
    .requiredOption('--title <title>', 'task title')
    .option('--description <text>', 'description text')
    .option('--description-file <file>', 'read the description from a file ("-" = stdin)')
    .option('--ac <text>', 'acceptance criterion (repeatable)', collect)
    .option('--priority <p>', 'high | medium | low')
    .option('--dep <id>', 'dependency task id (repeatable)', collect)
    .option('--parent <id>', 'parent task id')
    .option('--label <label>', 'label (repeatable)', collect)
    .option('--status <status>', 'initial status (default idea)')
    .option('--provenance <p>', PROVENANCES.join(' | '))
    .option('--workflow <name>', 'named workflow from config (default: the default workflow)')
    .option('--owner-approved', OWNER_APPROVED_HELP)
    .requiredOption('--key <idempotencyKey>', 'idempotency key; repeating it returns the existing task')
    .action(action(async (o: { title: string; description?: string; descriptionFile?: string; ac?: string[]; priority?: string;
      dep?: string[]; parent?: string; label?: string[]; status?: string; provenance?: string; workflow?: string; key: string }, cmd: Command) => {
      requireMode('runtime');
      if (o.description !== undefined && o.descriptionFile !== undefined) throw new MinionsError('PRECONDITION', 'Use --description or --description-file, not both');
      const description = o.descriptionFile !== undefined ? await readTextFile(o.descriptionFile) : o.description;
      const input = {
        title: o.title, description, acceptanceCriteria: o.ac, dependencies: o.dep, parent: o.parent, labels: o.label,
        priority: oneOf('priority', o.priority, PRIORITIES), status: oneOf<TaskStatus>('status', o.status, TASK_STATUSES),
        provenance: oneOf('provenance', o.provenance, PROVENANCES), idempotencyKey: o.key,
      };
      assertIntakeOpen(input, await intakePaused());
      const { cfg, backlog } = await open();
      const workflow = o.workflow !== undefined ? { workflow: checkWorkflowName(cfg, o.workflow) } : {};
      const r = await backlog.createTask({ ...input, ...workflow });
      emit(r, { json: globalOpts(cmd).json, human: (d) => `${d.created ? 'Created' : 'Exists'} ${d.task.id}: ${d.task.title}` });
    }));

  bl.command('update <id>').description('Update a task (optimistic concurrency via --expected-version)')
    .requiredOption('--expected-version <v>', 'version from `backlog show`')
    .option('--status <status>', 'new status')
    .option('--title <title>', 'new title')
    .option('--priority <p>', 'high | medium | low')
    .option('--label <label>', 'replace labels (repeatable)', collect)
    .option('--description-file <file>', 'replace the description from a file ("-" = stdin)')
    .option('--branch <branch>', 'record the task branch')
    .option('--workflow <name>', 'assign a named workflow from config (only between stages)')
    .option('--owner-approved', OWNER_APPROVED_HELP)
    .action(action(async (id: string, o: { expectedVersion: string; status?: string; title?: string; priority?: string;
      label?: string[]; descriptionFile?: string; branch?: string; workflow?: string }, cmd: Command) => {
      requireMode('runtime');
      const patch: Parameters<BacklogAdapter['updateTask']>[2] = {};
      const status = oneOf<TaskStatus>('status', o.status, TASK_STATUSES);
      const priority = oneOf('priority', o.priority, PRIORITIES);
      if (status) patch.status = status;
      if (priority) patch.priority = priority;
      if (o.title !== undefined) patch.title = o.title;
      if (o.label) patch.labels = o.label;
      if (o.branch !== undefined) patch.branch = o.branch;
      if (o.descriptionFile !== undefined) patch.description = await readTextFile(o.descriptionFile);
      const { cfg, backlog } = await open();
      if (o.workflow !== undefined) {
        patch.workflow = checkWorkflowName(cfg, o.workflow);
        // Only between stages (D5): a running stage keeps the workflow it was claimed under.
        const task = await backlog.getTask(id);
        if ((await readyContext()).leased.has(task.id)) {
          throw new MinionsError('CONFLICT', `Task ${task.id} has an active stage; change its workflow between stages.`, 'Wait for the running stage to be recorded or released.');
        }
      }
      const t = await backlog.updateTask(id, o.expectedVersion, patch);
      emit(t, { json: globalOpts(cmd).json, human: (d) => `Updated ${d.id} (version ${d.version.slice(0, 12)})` });
    }));

  bl.command('note <id>').description('Append an implementation note (text from --text or stdin)')
    .option('--text <text>', 'note text')
    .action(action(async (id: string, o: { text?: string }, cmd: Command) => {
      requireMode('runtime');
      const text = o.text ?? (await readStdin());
      const { backlog } = await open();
      await backlog.addNote(id, text);
      emit({ id, noted: true }, { json: globalOpts(cmd).json, human: () => `Noted ${id}` });
    }));

  // Standing goals (docs/design/autonomy.md Decision 15): the owner writes them, the coordinator marks them.
  const goals = bl.command('goals').description('The owner\'s standing goals (goals.md next to the project config, copied in by the host) with your marks, and whether a retrospective is due')
    .action(action(async (_opts: unknown, cmd: Command) => {
      requireMode('runtime');
      const v = await loadGoals();
      emit(v, { json: globalOpts(cmd).json, human: humanGoalsList });
    }));
  goals.command('set <id> <status>').description(`Mark a goal ${GOAL_STATUSES.join(' | ')} (the owner's own Status line wins once they change it)`)
    .requiredOption('--reason <text>', 'why (e.g. the measurement that meets the goal)')
    .action(action(async (id: string, status: string, o: { reason: string }, cmd: Command) => {
      requireMode('runtime');
      const st = oneOf<GoalStatus>('status', status, GOAL_STATUSES)!;
      const v = await loadGoals();
      const g = v.goals.find((x) => x.id === id);
      if (!g) throw new MinionsError('NOT_FOUND', `No goal "${id}"${v.present ? '' : ' (no goals file)'}.`, `Goals: ${v.goals.map((x) => x.id).join(', ') || 'none'}.`);
      const state = readGoalsState(runtimePaths().state);
      const at = new Date().toISOString();
      if (st === g.fileStatus) delete state.marks[id]; else state.marks[id] = { status: st, fileStatus: g.fileStatus, at, reason: o.reason.slice(0, 500) };
      state.log.push({ at, what: `set ${st}`, id, reason: o.reason.slice(0, 500) });
      await writeGoalsState(runtimePaths().state, state);
      emit({ id, status: st, fileStatus: g.fileStatus }, { json: globalOpts(cmd).json, human: () => `Goal ${id}: ${st}${st !== g.fileStatus ? ` (the goals file says ${g.fileStatus}; tell the owner)` : ''}` });
    }));
  goals.command('record <what>').description('Record `idle` (planning found nothing worthwhile left: no planning wake until the goals change) or `retro` (a retrospective ran)')
    .requiredOption('--reason <text>', 'idle: why nothing is left; retro: a one-line summary')
    .action(action(async (what: string, o: { reason: string }, cmd: Command) => {
      requireMode('runtime');
      const kind = oneOf('record', what, ['idle', 'retro'] as const)!;
      const { backlog } = await open();
      const tasks = kind === 'retro' ? await backlog.listTasks() : null;
      const v = await loadGoals(tasks);
      const state = readGoalsState(runtimePaths().state);
      const at = new Date().toISOString();
      const reason = o.reason.slice(0, 500);
      if (kind === 'idle') {
        if (!v.hash) throw new MinionsError('PRECONDITION', 'There is no goals file: nothing to plan for.', 'The owner adds goals.md next to the project config and runs `minions start`.');
        state.exhausted = { hash: v.hash, at, reason };
      } else state.retro = { at, done: tasks!.filter((t) => t.status === 'done').length, summary: reason };
      state.log.push({ at, what: `record ${kind}`, reason });
      await writeGoalsState(runtimePaths().state, state);
      emit({ recorded: kind, at }, { json: globalOpts(cmd).json, human: () => (kind === 'idle' ? 'Recorded: nothing worthwhile left; no planning wake until the goals change.' : 'Recorded the retrospective.') });
    }));

  bl.command('export').description('Export all tasks as JSON')
    .action(action(async (_opts: unknown, cmd: Command) => {
      requireMode('runtime');
      const { backlog } = await open();
      const tasks = await backlog.exportTasks();
      emit({ tasks }, { json: globalOpts(cmd).json, human: (d) => JSON.stringify(d.tasks, null, 2) });
    }));
}
