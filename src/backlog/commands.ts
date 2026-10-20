import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { validateConfig } from '../config/resolve.js';
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

/** Reads the effective config: env MINIONS_CONFIG, default /opt/minions/config/config.json. */
export async function loadRuntimeConfig(path = process.env.MINIONS_CONFIG || containerPaths().configJson): Promise<MinionsConfig> {
  return validateConfig(await readJson(path), path);
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
    `branch: ${t.branch ?? '-'}  provenance: ${t.provenance}`, `version: ${t.version}`];
  if (t.description) out.push('', t.description);
  if (t.acceptanceCriteria.length) out.push('', ...t.acceptanceCriteria.map((a, i) => `[${a.done ? 'x' : ' '}] #${i + 1} ${a.text}`));
  return out.join('\n');
}

// ---------------------------------------------------------------- compact listing

/** Fields `--compact` keeps for `backlog list|ready` (coordinator reads without full descriptions). */
export const COMPACT_FIELDS = ['id', 'title', 'status', 'priority', 'dependencies'] as const;
export const TASK_FIELDS: readonly (keyof Task)[] = ['id', 'locator', 'title', 'description', 'acceptanceCriteria', 'status', 'priority',
  'dependencies', 'parent', 'externalLinks', 'labels', 'authorized', 'branch', 'commits', 'prUrl', 'provenance', 'version', 'milestone'];

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
      const tasks = ctx.paused ? [] : await backlog.listReady(limit, ctx.leased, scopeOf(cfg));
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

  bl.command('show <id>').description('Show one task')
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
    .requiredOption('--key <idempotencyKey>', 'idempotency key; repeating it returns the existing task')
    .action(action(async (o: { title: string; description?: string; descriptionFile?: string; ac?: string[]; priority?: string;
      dep?: string[]; parent?: string; label?: string[]; status?: string; provenance?: string; key: string }, cmd: Command) => {
      requireMode('runtime');
      if (o.description !== undefined && o.descriptionFile !== undefined) throw new MinionsError('PRECONDITION', 'Use --description or --description-file, not both');
      const description = o.descriptionFile !== undefined ? await readTextFile(o.descriptionFile) : o.description;
      const input = {
        title: o.title, description, acceptanceCriteria: o.ac, dependencies: o.dep, parent: o.parent, labels: o.label,
        priority: oneOf('priority', o.priority, PRIORITIES), status: oneOf<TaskStatus>('status', o.status, TASK_STATUSES),
        provenance: oneOf('provenance', o.provenance, PROVENANCES), idempotencyKey: o.key,
      };
      assertIntakeOpen(input, await intakePaused());
      const { backlog } = await open();
      const r = await backlog.createTask(input);
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
    .action(action(async (id: string, o: { expectedVersion: string; status?: string; title?: string; priority?: string;
      label?: string[]; descriptionFile?: string; branch?: string }, cmd: Command) => {
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
      const { backlog } = await open();
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

  bl.command('export').description('Export all tasks as JSON')
    .action(action(async (_opts: unknown, cmd: Command) => {
      requireMode('runtime');
      const { backlog } = await open();
      const tasks = await backlog.exportTasks();
      emit({ tasks }, { json: globalOpts(cmd).json, human: (d) => JSON.stringify(d.tasks, null, 2) });
    }));
}
