import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BacklogAdapter, CreateTaskInput, ScopeFilter, Task, TaskStatus } from '../../src/backlog/types.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { generateApprovalKeyPair, signApproval } from '../../src/core/approval.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { workspaceLayout, type WorkspaceLayout } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { fromTemplate } from '../repo-template.js';
import { fakeGitActive, fakeGitSync, fakeInitRepo } from './fake-git.js';

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
});

export const tmp = (prefix = 'minions-rt-') => mkdtempSync(join(tmpdir(), prefix));

/** git in `cwd`; on the in-memory fake when the test file installed it (./fake-git.ts). */
export const gitSync = (cwd: string, ...args: string[]) => fakeGitActive() ? fakeGitSync(cwd, ...args) :
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository with one commit (README.md) on `branch`; returns its SHA. Copied from a per-file template (task-104). */
export function initRepo(dir: string, branch = 'main'): string {
  if (fakeGitActive()) return fakeInitRepo(dir, branch);
  return fromTemplate(`runtime-init:${branch}`, dir, (d) => {
    execFileSync('git', ['init', '-q', '-b', branch, d]);
    writeFileSync(join(d, 'README.md'), '# test\n');
    gitSync(d, 'add', '.');
    gitSync(d, 'commit', '-q', '-m', 'init');
    return gitSync(d, 'rev-parse', 'HEAD');
  });
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
      commits: [], provenance: 'user-decision', version: '', ...partial,
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
    const t = this.add({ id: `task-${this.tasks.size + 1}`, title: input.title, status: input.status ?? 'idea', ...(input.workflow ? { workflow: input.workflow } : {}),
      ...(input.labels ? { labels: input.labels } : {}), ...(input.description ? { description: input.description } : {}) });
    return { task: t, created: true };
  }
  async updateTask(id: string, expectedVersion: string, patch: Partial<Pick<Task, 'status' | 'title' | 'description' | 'priority' | 'labels' | 'branch'>> & { workflow?: string | null }) {
    const t = this.must(id);
    if (t.version !== expectedVersion) throw new MinionsError('CONFLICT', `version mismatch for ${id}`);
    const { workflow, ...rest } = patch;
    Object.assign(t, rest);
    if (workflow === null) delete t.workflow; else if (workflow !== undefined) t.workflow = workflow;
    return structuredClone(this.bump(t));
  }
  async addDependency(id: string, dep: string) { const t = this.must(id); t.dependencies.push(dep); return structuredClone(this.bump(t)); }
  async addNote(id: string, text: string) { this.must(id); this.notes.push({ id, text }); }
  async closeTask(id: string, status: 'done' | 'delivered' | 'cancelled') { const t = this.must(id); t.status = status; return structuredClone(this.bump(t)); }
  async exportTasks() { return this.listTasks(); }
  status(id: string): TaskStatus { return this.must(id).status; }
}

export interface Env { root: string; layout: WorkspaceLayout; db: RuntimeDb; backlog: FakeBacklog; config: MinionsConfig; sched: Scheduler; baseSha: string }

/** A default workflow with a tester stage (a custom flow), which the pipeline tests exercise. */
export const TESTER_FLOW = ['engineer', 'tester', 'reviewer'];

/**
 * Runtime env on the project-owner defaults, except a `workflows.default` with a tester stage (TESTER_FLOW) so the
 * pipeline tests keep exercising engineer → tester → reviewer. Use makeDefaultEnv for the real default (engineer →
 * reviewer).
 */
export function makeEnv(mutate?: (c: MinionsConfig) => void): Env {
  return makeDefaultEnv((c) => { c.workflows = { ...c.workflows, default: [...TESTER_FLOW] }; mutate?.(c); });
}

/**
 * A runtime env with no git repository (the unit tier, task-137.2.2): the DB, fake backlog, config and
 * scheduler for code that never reaches the workspace git (sync over a fake gh, gates over recorded rows).
 * baseSha is a placeholder.
 */
export function makeDbEnv(mutate?: (c: MinionsConfig) => void): Env {
  return makeDefaultEnv((c) => { c.workflows = { ...c.workflows, default: [...TESTER_FLOW] }; mutate?.(c); }, { git: false });
}

export function makeDefaultEnv(mutate?: (c: MinionsConfig) => void, o: { git?: boolean } = {}): Env {
  const root = tmp();
  const layout = workspaceLayout(join(root, 'workspace'));
  const baseSha = o.git === false ? '0'.repeat(40) : initRepo(layout.repo);
  const db = new RuntimeDb(join(root, 'state', 'minions.db'));
  const backlog = new FakeBacklog();
  const config = defaults('project-owner');
  mutate?.(config);
  const sched = new Scheduler({ db, backlog, config, layout, handoff: { briefs: join(root, 'state', 'briefs'), results: join(root, 'state', 'results') } });
  return { root, layout, db, backlog, config, sched, baseSha };
}

export function result(over: Record<string, unknown> & { branch: string; headSha: string }) {
  return {
    status: 'complete', summary: 'done', modifiedPaths: ['a.txt'],
    checks: [{ command: 'npm test', outcome: 'pass' }], acceptanceEvidence: [{ criterion: 'works', evidence: 'test passes' }],
    findings: [], nextAction: 'continue', ...over,
  };
}

/**
 * A throwaway host approval key pair: the public half in a temp file (the runtime's view), the
 * private half only in memory (stands in for the host credential store the runtime cannot read).
 */
export function approvalKeys() {
  const pair = generateApprovalKeyPair();
  const publicKeyFile = join(tmp('minions-approval-'), 'approval-public-key.pem');
  writeFileSync(publicKeyFile, pair.publicKeyPem);
  return {
    ...pair, publicKeyFile,
    sign: (taskId: string, head: string, o: { by?: string; now?: Date; ttlMs?: number } = {}) => signApproval(pair.privateKeyPem, { taskId, head, ...o }).token,
  };
}

/**
 * The server side of the verified origin reads (task-71): `gh api ... /repos/<o>/<r>/branches/<b>` answered
 * from a local bare repository that stands in for GitHub (git reaches it through the `serverUrl` seam,
 * `() => bare`). Returns null for any other gh call, so a test's fake gh can delegate to it first.
 */
export function ghBranchApi(bare: string, args: string[]): { code: number; stdout: string; stderr: string } | null {
  if (args[0] !== 'api') return null;
  const path = args.find((a) => a.startsWith('/repos/')) ?? '';
  const m = /^\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/.exec(path);
  if (!m) return null;
  const branch = m[1]!.split('/').map(decodeURIComponent).join('/');
  try {
    const sha = execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { code: 0, stdout: JSON.stringify({ name: branch, commit: { sha } }), stderr: '' };
  } catch {
    return { code: 1, stdout: '', stderr: 'gh: Branch not found (HTTP 404)' };
  }
}
