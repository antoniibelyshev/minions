import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BacklogAdapter, CreateTaskInput, ScopeFilter, Task, TaskStatus } from '../../src/backlog/types.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { workspaceLayout, type WorkspaceLayout } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
});

export const tmp = (prefix = 'minions-rt-') => mkdtempSync(join(tmpdir(), prefix));

export const gitSync = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function initRepo(dir: string, branch = 'main'): string {
  execFileSync('git', ['init', '-q', '-b', branch, dir]);
  writeFileSync(join(dir, 'README.md'), '# test\n');
  gitSync(dir, 'add', '.');
  gitSync(dir, 'commit', '-q', '-m', 'init');
  return gitSync(dir, 'rev-parse', 'HEAD');
}

export function commitFile(dir: string, file: string, content: string, msg = `edit ${file}`): string {
  writeFileSync(join(dir, file), content);
  gitSync(dir, 'add', file);
  gitSync(dir, 'commit', '-q', '-m', msg);
  return gitSync(dir, 'rev-parse', 'HEAD');
}

/** In-memory BacklogAdapter honouring versions, readiness and dependencies. */
export class FakeBacklog implements BacklogAdapter {
  tasks = new Map<string, Task>();
  notes: { id: string; text: string }[] = [];
  failReady = false;
  private n = 0;
  private bump(t: Task): Task { t.version = `v${++this.n}`; return t; }

  add(partial: Partial<Task> & { id: string }): Task {
    const t: Task = {
      locator: `backlogmd:${partial.id}`, title: `Task ${partial.id}`, description: 'Do the thing.',
      acceptanceCriteria: [{ text: 'works', done: false }], status: 'ready', priority: 'medium',
      dependencies: [], parent: null, externalLinks: [], labels: [], authorized: true, branch: null,
      commits: [], prUrl: null, provenance: 'user-decision', version: '', ...partial,
    };
    this.tasks.set(t.id, this.bump(t));
    return structuredClone(t);
  }
  private must(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new MinionsError('NOT_FOUND', `task ${id} not found`);
    return t;
  }
  async capabilities() { return { backend: 'fake', version: '0', supports: [] }; }
  async listTasks() { if (this.failReady) throw new Error('backlog down'); return [...this.tasks.values()].map((t) => structuredClone(t)); }
  async listReady(limit: number, leased: Set<string>, _scope: ScopeFilter) {
    if (this.failReady) throw new Error('backlog down');
    return [...this.tasks.values()].filter((t) => t.status === 'ready' && t.authorized && !leased.has(t.id) &&
      t.dependencies.every((d) => ['done', 'delivered'].includes(this.tasks.get(d)?.status ?? ''))).slice(0, limit).map((t) => structuredClone(t));
  }
  async getTask(id: string) { return structuredClone(this.must(id)); }
  async createTask(input: CreateTaskInput) {
    const t = this.add({ id: `task-${this.tasks.size + 1}`, title: input.title, status: input.status ?? 'idea' });
    return { task: t, created: true };
  }
  async updateTask(id: string, expectedVersion: string, patch: Partial<Pick<Task, 'status' | 'title' | 'description' | 'priority' | 'labels' | 'branch'>>) {
    const t = this.must(id);
    if (t.version !== expectedVersion) throw new MinionsError('CONFLICT', `version mismatch for ${id}`);
    Object.assign(t, patch);
    return structuredClone(this.bump(t));
  }
  async addDependency(id: string, dep: string) { const t = this.must(id); t.dependencies.push(dep); return structuredClone(this.bump(t)); }
  async addNote(id: string, text: string) { this.must(id); this.notes.push({ id, text }); }
  async closeTask(id: string, status: 'done' | 'delivered' | 'cancelled') { const t = this.must(id); t.status = status; return structuredClone(this.bump(t)); }
  async exportTasks() { return this.listTasks(); }
  status(id: string): TaskStatus { return this.must(id).status; }
}

export interface Env { root: string; layout: WorkspaceLayout; db: RuntimeDb; backlog: FakeBacklog; config: MinionsConfig; sched: Scheduler; baseSha: string }

export function makeEnv(mutate?: (c: MinionsConfig) => void): Env {
  const root = tmp();
  const layout = workspaceLayout(join(root, 'workspace'));
  const baseSha = initRepo(layout.repo);
  const db = new RuntimeDb(join(root, 'state', 'minions.db'));
  const backlog = new FakeBacklog();
  const config = defaults('project-owner');
  mutate?.(config);
  const sched = new Scheduler({ db, backlog, config, layout });
  return { root, layout, db, backlog, config, sched, baseSha };
}

export function result(over: Record<string, unknown> & { branch: string; headSha: string }) {
  return {
    status: 'complete', summary: 'done', modifiedPaths: ['a.txt'],
    checks: [{ command: 'npm test', outcome: 'pass' }], acceptanceEvidence: [{ criterion: 'works', evidence: 'test passes' }],
    findings: [], nextAction: 'continue', ...over,
  };
}
