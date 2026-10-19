import { join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { exists, sha256 } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { AUTHORIZED_LABEL, cycleIfAdded, filterReady } from './ready.js';
import type { BacklogAdapter, CreateTaskInput, IdempotencyStore, Provenance, ScopeFilter, Task, TaskStatus } from './types.js';

export interface BacklogMdOptions {
  /** Backlog.md project root (contains backlog/config.yml). Default /state/backlog. */
  root?: string;
  /** CLI binary. Default: env MINIONS_BACKLOG_BIN, else `backlog` on PATH. */
  bin?: string;
  idempotency: IdempotencyStore;
  /** Profile allows starting ready tasks without the minions:authorized label. */
  startReady?: boolean;
  timeoutMs?: number;
  /** Max concurrent `task view` calls in listTasks. */
  concurrency?: number;
}

export const TASK_STATUSES: readonly TaskStatus[] = ['idea', 'ready', 'implementing', 'testing', 'reviewing',
  'changes-requested', 'awaiting-human', 'awaiting-ci', 'merging', 'done', 'delivered', 'blocked', 'cancelled'];
const PROVENANCES: readonly Provenance[] = ['external-requirement', 'user-decision', 'agent-hypothesis', 'observed-result'];
const DEFAULT_PROVENANCE: Provenance = 'user-decision';

// ---------------------------------------------------------------- meta block

export interface MinionsMeta {
  provenance?: Provenance; branch?: string | null; externalLinks?: string[];
  commits?: string[]; prUrl?: string | null; [k: string]: unknown;
}

const META_RE = /<!-- minions:meta (.*?) -->/;

/** Splits a Backlog.md description into user content and the minions meta block. */
export function parseDescription(raw: string | null | undefined): { user: string; meta: MinionsMeta; hasMeta: boolean } {
  const text = raw ?? '';
  const m = META_RE.exec(text);
  if (!m) return { user: text.trim(), meta: {}, hasMeta: false };
  let meta: unknown;
  try { meta = JSON.parse(m[1]!); } catch { return { user: text.trim(), meta: {}, hasMeta: false }; }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return { user: text.trim(), meta: {}, hasMeta: false };
  const before = text.slice(0, m.index).trimEnd();
  const after = text.slice(m.index + m[0].length).trimStart();
  return { user: [before, after].filter(Boolean).join('\n\n'), meta: meta as MinionsMeta, hasMeta: true };
}

/** One-line meta comment; `<`/`>` are escaped so the JSON can never close the comment. */
export function metaLine(meta: MinionsMeta): string {
  const json = JSON.stringify(meta).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!-- minions:meta ${json} -->`;
}

/** New description from user content + meta (meta appended at the end). */
export function composeDescription(user: string, meta: MinionsMeta): string {
  const u = user.trim();
  return u ? `${u}\n\n${metaLine(meta)}` : metaLine(meta);
}

/** Replaces the meta block in place, keeping surrounding user content verbatim. */
export function replaceMeta(raw: string, meta: MinionsMeta): string {
  return META_RE.test(raw) ? raw.replace(META_RE, () => metaLine(meta)).trim() : composeDescription(raw, meta);
}

// ---------------------------------------------------------------- mapping

/** "TASK-12" | "backlogmd:TASK-12" | "task-12" -> "task-12". */
export function normalizeId(id: string): string {
  return id.trim().replace(/^backlogmd:/i, '').toLowerCase();
}
const backendId = (id: string) => normalizeId(id).toUpperCase();

interface RawTask {
  id: string; title?: string; status?: string; priority?: string | null; labels?: string[];
  milestone?: string | null; parentTaskId?: string | null; description?: string | null;
  dependencies?: string[]; acceptanceCriteria?: { index: number; text: string; checked: boolean }[];
  archived?: boolean; [k: string]: unknown;
}

const VERSION_FIELDS = ['id', 'title', 'status', 'archived', 'type', 'priority', 'project', 'assignees', 'reporter',
  'labels', 'milestone', 'parentTaskId', 'references', 'modifiedFiles', 'ordinal', 'dueDate', 'description',
  'dependencies', 'documentation', 'acceptanceCriteria', 'definitionOfDone', 'implementationPlan',
  'implementationNotes', 'comments', 'finalSummary'] as const;

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
};

/** sha256 over the task's own content (excludes derived fields like dependencyGraph/readiness). */
export function taskVersion(raw: RawTask): string {
  const picked: Record<string, unknown> = {};
  for (const k of VERSION_FIELDS) picked[k] = raw[k] ?? null;
  return sha256(canonical(picked));
}

function mapStatus(s: string | undefined): TaskStatus {
  const v = (s ?? '').toLowerCase();
  return (TASK_STATUSES as readonly string[]).includes(v) ? (v as TaskStatus) : 'idea';
}
function mapPriority(p: string | null | undefined): Task['priority'] {
  const v = (p ?? '').toLowerCase();
  return v === 'high' || v === 'medium' || v === 'low' ? v : null;
}

export function toTask(raw: RawTask, opts: { startReady?: boolean } = {}): Task {
  const { user, meta } = parseDescription(raw.description);
  const labels = raw.labels ?? [];
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    id: normalizeId(raw.id),
    locator: `backlogmd:${raw.id.toUpperCase()}`,
    title: raw.title ?? '',
    description: user,
    acceptanceCriteria: (raw.acceptanceCriteria ?? []).map((a) => ({ text: a.text, done: !!a.checked })),
    status: mapStatus(raw.status),
    priority: mapPriority(raw.priority),
    dependencies: (raw.dependencies ?? []).map(normalizeId),
    parent: raw.parentTaskId ? normalizeId(raw.parentTaskId) : null,
    externalLinks: strArr(meta.externalLinks),
    labels,
    authorized: labels.includes(AUTHORIZED_LABEL) || !!opts.startReady,
    branch: typeof meta.branch === 'string' ? meta.branch : null,
    commits: strArr(meta.commits),
    prUrl: typeof meta.prUrl === 'string' ? meta.prUrl : null,
    provenance: PROVENANCES.includes(meta.provenance as Provenance) ? (meta.provenance as Provenance) : DEFAULT_PROVENANCE,
    version: taskVersion(raw),
    milestone: raw.milestone ?? null,
  };
}

// ---------------------------------------------------------------- adapter

type Patch = Parameters<BacklogAdapter['updateTask']>[2];

export class BacklogMdAdapter implements BacklogAdapter {
  readonly root: string;
  readonly bin: string;
  private readonly idem: IdempotencyStore;
  private readonly startReady: boolean;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private initialized = false;

  constructor(opts: BacklogMdOptions) {
    this.root = opts.root ?? '/state/backlog';
    this.bin = opts.bin ?? (process.env.MINIONS_BACKLOG_BIN || 'backlog');
    this.idem = opts.idempotency;
    this.startReady = !!opts.startReady;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
  }

  private async cli(args: string[]): Promise<string> {
    if (!this.initialized) {
      if (!(await exists(join(this.root, 'backlog', 'config.yml')))) {
        throw new MinionsError('PRECONDITION', `Backlog.md project not initialized at ${this.root}`,
          'Run `minions workspace setup` to create backlog/config.yml.');
      }
      this.initialized = true;
    }
    const r = await run(this.bin, args, {
      cwd: this.root, allowFailure: true, timeoutMs: this.timeoutMs,
      env: { ...process.env, BACKLOG_CWD: this.root, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    if (r.code === 0) return r.stdout;
    const err = redact(r.stderr.trim()).slice(-2000);
    const details = { args: args.slice(0, 3).map(redact), code: r.code };
    if (r.timedOut) throw new MinionsError('INTERNAL', `backlog ${args.slice(0, 2).join(' ')} timed out after ${this.timeoutMs}ms`, undefined, details);
    if (r.code === 127 && /ENOENT|not found/i.test(r.stderr)) {
      throw new MinionsError('NOT_FOUND', `Backlog.md CLI not found: ${this.bin}`, 'Install backlog.md or set MINIONS_BACKLOG_BIN.');
    }
    if (/do not exist|not found/i.test(err)) throw new MinionsError('NOT_FOUND', err, undefined, details);
    if (/cycle|cannot depend on itself/i.test(err)) throw new MinionsError('CONFLICT', err, undefined, details);
    if (/^Invalid |error: /im.test(err)) throw new MinionsError('PRECONDITION', err, undefined, details);
    throw new MinionsError('INTERNAL', `backlog ${args.slice(0, 2).join(' ')} failed (exit ${r.code})${err ? `: ${err}` : ''}`, undefined, details);
  }

  private async cliJson<T>(args: string[]): Promise<T> {
    const out = await this.cli(args);
    try { return JSON.parse(out) as T; } catch {
      throw new MinionsError('INTERNAL', `backlog ${args.slice(0, 2).join(' ')} returned invalid JSON`);
    }
  }

  private async viewRaw(id: string): Promise<RawTask> {
    const r = await this.cliJson<{ task?: RawTask }>(['task', 'view', backendId(id), '--json']);
    if (!r.task || typeof r.task.id !== 'string') throw new MinionsError('INTERNAL', `backlog task view ${id}: unexpected output`);
    return r.task;
  }

  private async listRaw(): Promise<RawTask[]> {
    const r = await this.cliJson<{ tasks?: RawTask[] }>(['task', 'list', '--json']);
    return (r.tasks ?? []).filter((t) => typeof t.id === 'string' && !t.archived);
  }

  private task(raw: RawTask): Task { return toTask(raw, { startReady: this.startReady }); }

  /** Views ids with bounded concurrency; failed lookups are undefined when tolerant. */
  private async viewMany(ids: string[], tolerant: boolean): Promise<(RawTask | undefined)[]> {
    const out: (RawTask | undefined)[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        try { out[i] = await this.viewRaw(ids[i]!); } catch (e) { if (!tolerant) throw e; out[i] = undefined; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, ids.length) }, worker));
    return out;
  }

  async capabilities() {
    const v = (await this.cli(['--version'])).trim();
    return { backend: 'backlogmd', version: v, supports: ['create', 'update', 'dependencies', 'notes', 'labels', 'priority', 'parent', 'acceptance-criteria', 'milestone'] };
  }

  async listTasks(): Promise<Task[]> {
    const list = await this.listRaw();
    const raws = await this.viewMany(list.map((t) => t.id), false);
    return raws.map((r) => this.task(r!));
  }

  async listReady(limit: number, leasedIds: Set<string>, scope: ScopeFilter): Promise<Task[]> {
    if (limit <= 0) return [];
    const list = await this.listRaw();
    const summary = new Map(list.map((t) => [normalizeId(t.id), this.task(t)]));
    // Only candidates need full details (dependencies); dependency status comes from the list.
    const candidates = list.filter((t) => mapStatus(t.status) === 'ready').map((t) => t.id);
    const viewed = (await this.viewMany(candidates, true)).filter((r): r is RawTask => !!r).map((r) => this.task(r));
    return filterReady(viewed, { leased: new Set([...leasedIds].map(normalizeId)), scope, lookup: (id) => summary.get(id) }, limit);
  }

  async getTask(id: string): Promise<Task> {
    return this.task(await this.viewRaw(id));
  }

  async createTask(input: CreateTaskInput): Promise<{ task: Task; created: boolean }> {
    const key = input.idempotencyKey?.trim();
    if (!key) throw new MinionsError('PRECONDITION', 'createTask requires an idempotency key');
    const known = this.idem.get(key);
    if (known) {
      try { return { task: await this.getTask(known), created: false }; } catch (e) {
        if (!(e instanceof MinionsError && e.code === 'NOT_FOUND')) throw e;
      }
    }
    const title = input.title?.trim();
    if (!title || /[\r\n]/.test(title)) throw new MinionsError('PRECONDITION', 'Task title must be a non-empty single line');
    const labels = input.labels ?? [];
    checkLabels(labels);
    const meta: MinionsMeta = { provenance: input.provenance ?? DEFAULT_PROVENANCE };
    const args = ['task', 'create', `--description=${composeDescription(input.description ?? '', meta)}`];
    for (const ac of input.acceptanceCriteria ?? []) args.push(`--ac=${ac}`);
    if (input.priority) args.push(`--priority=${input.priority}`);
    if (labels.length) args.push(`--labels=${labels.join(',')}`);
    if (input.dependencies?.length) args.push(`--dep=${input.dependencies.map(backendId).join(',')}`);
    if (input.parent) args.push(`--parent=${backendId(input.parent)}`);
    if (input.status) args.push(`--status=${input.status}`);
    args.push('--', title);
    const out = await this.cli(args);
    const m = /Created task (\S+)/.exec(out);
    if (!m) throw new MinionsError('INTERNAL', 'backlog task create: could not parse the created task id', undefined, { stdout: out.slice(0, 500) });
    const id = normalizeId(m[1]!);
    this.idem.put(key, id);
    return { task: await this.getTask(id), created: true };
  }

  async updateTask(id: string, expectedVersion: string, patch: Patch): Promise<Task> {
    const raw = await this.viewRaw(id);
    const cur = this.task(raw);
    if (cur.version !== expectedVersion) {
      throw new MinionsError('CONFLICT', `Task ${cur.id} changed since version ${expectedVersion.slice(0, 12)} (now ${cur.version.slice(0, 12)})`,
        'Re-read the task (minions backlog show) and retry with the current version.', { id: cur.id, expected: expectedVersion, actual: cur.version });
    }
    const args: string[] = [];
    if (patch.title !== undefined && patch.title !== cur.title) {
      if (!patch.title.trim() || /[\r\n]/.test(patch.title)) throw new MinionsError('PRECONDITION', 'Task title must be a non-empty single line');
      args.push(`--title=${patch.title}`);
    }
    if (patch.status !== undefined && patch.status !== cur.status) args.push(`--status=${patch.status}`);
    if (patch.priority !== undefined && patch.priority !== cur.priority) {
      if (patch.priority === null) throw new MinionsError('PRECONDITION', 'Backlog.md cannot clear a task priority', 'Set high, medium or low instead.');
      args.push(`--priority=${patch.priority}`);
    }
    if (patch.labels !== undefined) {
      checkLabels(patch.labels);
      const add = patch.labels.filter((l) => !cur.labels.includes(l));
      const remove = cur.labels.filter((l) => !patch.labels!.includes(l));
      if (patch.labels.length === 0 && cur.labels.length) args.push('--clear-labels');
      else {
        if (add.length) args.push(`--add-label=${add.join(',')}`);
        if (remove.length) args.push(`--remove-label=${remove.join(',')}`);
      }
    }
    const descChanged = patch.description !== undefined && patch.description.trim() !== cur.description;
    const branchChanged = 'branch' in patch && patch.branch !== undefined && patch.branch !== cur.branch;
    if (descChanged || branchChanged) {
      const parsed = parseDescription(raw.description);
      const meta: MinionsMeta = { provenance: cur.provenance, ...parsed.meta };
      if (branchChanged) meta.branch = patch.branch ?? null;
      const desc = descChanged ? composeDescription(patch.description!, meta) : replaceMeta(raw.description ?? '', meta);
      args.push(`--description=${desc}`);
    }
    if (!args.length) return cur;
    await this.cli(['task', 'edit', backendId(cur.id), ...args]);
    return this.getTask(cur.id);
  }

  async addDependency(id: string, dependsOn: string): Promise<Task> {
    const [task, dep] = await Promise.all([this.getTask(id), this.getTask(dependsOn)]);
    if (task.dependencies.includes(dep.id)) return task;
    const all = await this.listTasks();
    const graph = new Map(all.map((t) => [t.id, t.dependencies]));
    graph.set(task.id, task.dependencies);
    const cycle = cycleIfAdded(graph, task.id, dep.id);
    if (cycle) {
      throw new MinionsError('CONFLICT', `Adding dependency ${task.id} -> ${dep.id} would create a cycle: ${cycle.join(' -> ')}`,
        'Remove one of the dependencies in the cycle or split the task.', { cycle });
    }
    await this.cli(['task', 'edit', backendId(task.id), `--dep=${[...task.dependencies, dep.id].map(backendId).join(',')}`]);
    return this.getTask(task.id);
  }

  async addNote(id: string, text: string): Promise<void> {
    if (!text.trim()) throw new MinionsError('PRECONDITION', 'Note text is empty');
    await this.cli(['task', 'edit', backendId(id), `--append-notes=${text}`]);
  }

  async closeTask(id: string, status: 'done' | 'delivered' | 'cancelled'): Promise<Task> {
    await this.cli(['task', 'edit', backendId(id), `--status=${status}`]);
    return this.getTask(id);
  }

  exportTasks(): Promise<Task[]> { return this.listTasks(); }
}

function checkLabels(labels: string[]): void {
  for (const l of labels) {
    if (!l.trim() || /[,\r\n]/.test(l)) throw new MinionsError('PRECONDITION', `Invalid label "${l}": labels must be non-empty and contain no commas or newlines`);
  }
}
