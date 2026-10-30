// Shared unit-tier harness for the `minions backlog ...` CLI tests (task-137.2.3): an in-memory BacklogAdapter
// standing in for Backlog.md, and an in-process runner for buildProgram that captures the JSON output.
// Test files swap the real adapter in with:
//
//   vi.mock('../../src/backlog/factory.js', async (orig) => (await import('./harness.js')).mockFactory(await orig()));
//
// Such a file must not import src/backlog/factory.js itself: with a static import of the mocked module in the test
// file, src/ kept the real openBacklog (observed with vitest 4), and the CLI spawned Backlog.md.
//
// The real Backlog.md CLI round trip (argument mapping, task files, notes, versions) stays covered end to end by
// test/backlog/backlogmd.test.ts and test/backlog/taskfile.test.ts in the integration tier.
import type { Command } from 'commander';
import { boundNotes, normalizeId } from '../../src/backlog/backlogmd.js';
import type * as Factory from '../../src/backlog/factory.js';
import { AUTHORIZED_LABEL, cycleIfAdded } from '../../src/backlog/ready.js';
import type { BacklogAdapter, CreateTaskInput, IdempotencyStore, ScopeFilter, Task, TaskStatus } from '../../src/backlog/types.js';
import { MinionsError } from '../../src/core/errors.js';
import { runtimePaths } from '../../src/runtime/paths.js';

type Patch = Parameters<BacklogAdapter['updateTask']>[2];

/** In-memory Backlog.md: idempotent creates, content versions (a note changes it), notes only on getTask. */
export class MemoryBacklog implements BacklogAdapter {
  /** One backlog per root, so tasks persist across CLI invocations (each opens the backlog anew). */
  static readonly byRoot = new Map<string, MemoryBacklog>();
  private readonly tasks = new Map<string, { task: Task; notes: string[] }>();
  private n = 0;
  constructor(public idempotency: IdempotencyStore, public startReady = false) {}

  private bump(t: Task): void { t.version = `v${++this.n}`; }
  private must(id: string) {
    const e = this.tasks.get(normalizeId(id));
    if (!e) throw new MinionsError('NOT_FOUND', `Task ${id} not found`);
    return e;
  }
  private out(t: Task): Task { return structuredClone({ ...t, authorized: t.labels.includes(AUTHORIZED_LABEL) || this.startReady }); }

  async capabilities() { return { backend: 'memory', version: '0', supports: [] }; }
  async listTasks() { return [...this.tasks.values()].map((e) => this.out(e.task)); }
  async exportTasks() { return this.listTasks(); }
  async listReady(limit: number, leased: Set<string>, _scope: ScopeFilter, completed: ReadonlySet<TaskStatus> = new Set(['done', 'delivered'])) {
    return (await this.listTasks()).filter((t) => t.status === 'ready' && t.authorized && !leased.has(t.id)
      && t.dependencies.every((d) => completed.has(this.tasks.get(d)?.task.status ?? 'idea'))).slice(0, limit);
  }
  async getTask(id: string) {
    const e = this.must(id);
    return { ...this.out(e.task), notes: boundNotes(e.notes.join('\n\n')) };
  }
  async createTask(input: CreateTaskInput) {
    const known = this.idempotency.get(input.idempotencyKey);
    if (known && this.tasks.has(known)) return { task: await this.getTask(known), created: false };
    const id = input.parent ? `${normalizeId(input.parent)}.${[...this.tasks.keys()].filter((k) => k.startsWith(`${normalizeId(input.parent!)}.`)).length + 1}`
      : `task-${[...this.tasks.keys()].filter((k) => !k.includes('.')).length + 1}`;
    const task: Task = {
      id, locator: `backlogmd:${id.toUpperCase()}`, title: input.title, description: input.description ?? '',
      acceptanceCriteria: (input.acceptanceCriteria ?? []).map((text) => ({ text, done: false })), status: input.status ?? 'idea',
      priority: input.priority ?? null, dependencies: (input.dependencies ?? []).map(normalizeId), parent: input.parent ? normalizeId(input.parent) : null,
      externalLinks: input.externalLinks ?? [], labels: input.labels ?? [], authorized: false, branch: null, commits: [], prUrl: null,
      provenance: input.provenance ?? 'user-decision', version: '', milestone: null, ...(input.workflow ? { workflow: input.workflow } : {}),
    };
    this.bump(task);
    this.tasks.set(id, { task, notes: [] });
    this.idempotency.put(input.idempotencyKey, id);
    return { task: await this.getTask(id), created: true };
  }
  async updateTask(id: string, expectedVersion: string, patch: Patch) {
    const { task } = this.must(id);
    if (task.version !== expectedVersion) throw new MinionsError('CONFLICT', `Task ${task.id} changed since version ${expectedVersion}`);
    const { workflow, ...rest } = patch;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (task as unknown as Record<string, unknown>)[k] = v;
    if (workflow === null) delete task.workflow; else if (workflow !== undefined) task.workflow = workflow;
    this.bump(task);
    return this.getTask(task.id);
  }
  async addDependency(id: string, dependsOn: string) {
    const { task } = this.must(id);
    const dep = this.must(dependsOn).task;
    const cycle = cycleIfAdded(new Map([...this.tasks.values()].map((e) => [e.task.id, e.task.dependencies])), task.id, dep.id);
    if (cycle) throw new MinionsError('CONFLICT', `cycle: ${cycle.join(' -> ')}`);
    if (!task.dependencies.includes(dep.id)) { task.dependencies.push(dep.id); this.bump(task); }
    return this.getTask(task.id);
  }
  async addNote(id: string, text: string) {
    if (!text.trim()) throw new MinionsError('PRECONDITION', 'Note text is empty');
    const e = this.must(id);
    e.notes.push(text.trim());
    this.bump(e.task);
  }
  async closeTask(id: string, status: 'done' | 'delivered' | 'cancelled') {
    const { task } = this.must(id);
    task.status = status;
    this.bump(task);
    return this.getTask(task.id);
  }
}

/** The factory module with openBacklog returning the root's MemoryBacklog (backend validation stays real). */
export function mockFactory(real: typeof Factory): typeof Factory {
  return {
    ...real,
    openBacklog: (cfg, deps) => {
      real.openBacklog(cfg, deps); // throws INCOMPATIBLE_RUNTIME for a deferred backend; constructing spawns nothing
      const root = deps.root ?? runtimePaths().backlog;
      const b = MemoryBacklog.byRoot.get(root) ?? new MemoryBacklog(deps.idempotency, cfg.intake.startReady);
      b.idempotency = deps.idempotency;
      MemoryBacklog.byRoot.set(root, b);
      return b;
    },
  };
}

export interface CliBody { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; hint?: string } }

/** Runs `minions <args> --json` in-process; returns the captured output, the exit code and the parsed body. */
export async function runCli(args: string[]): Promise<{ out: string; code: number; body: CliBody }> {
  const { buildProgram } = await import('../../src/program.js');
  const program = buildProgram();
  let out = '';
  const capture = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } });
    cmd.commands.forEach(capture);
  };
  capture(program);
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const sink = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  const exit = process.exit.bind(process);
  process.exit = ((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as typeof process.exit;
  const before = process.exitCode;
  let code = 0;
  try {
    await program.parseAsync(['node', 'minions', ...args, '--json']);
    code = process.exitCode === before ? 0 : Number(process.exitCode);
  } catch (err) {
    code = (err as { exitCode?: number }).exitCode ?? 1;
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    process.exit = exit;
    process.exitCode = before;
  }
  let body: CliBody = { ok: false };
  try { body = JSON.parse(out) as CliBody; } catch { /* not JSON */ }
  return { out, code, body };
}
