import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { ensureDir, exists } from '../core/fsutil.js';
import { gateGit, hardenedGit, isHostRuntime } from './git-hardening.js';
import { runtimePaths } from './paths.js';

export interface WorkspaceLayout { root: string; repo: string; worktrees: string; review: string }

/** /workspace layout; MINIONS_WORKSPACE (or `root`) overrides the root. */
export function workspaceLayout(root?: string): WorkspaceLayout {
  const r = root ?? runtimePaths().workspace;
  return { root: r, repo: join(r, 'repo'), worktrees: join(r, 'worktrees'), review: join(r, 'review') };
}

export const BRANCH_PREFIX = 'agent/';
const MAX_SLUG = 50;

/** `<task id>-<title>` lowercased, [a-z0-9-] only, collapsed dashes, at most 50 chars. */
export function taskSlug(id: string, title: string): string {
  const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const idPart = clean(id).slice(0, MAX_SLUG) || 'task';
  const titlePart = clean(title);
  const slug = titlePart ? `${idPart}-${titlePart}` : idPart;
  return slug.slice(0, MAX_SLUG).replace(/-+$/, '');
}
export const branchFor = (slug: string) => `${BRANCH_PREFIX}${slug}`;

/** git in the workspace. The host runtime adds the hardening of ./git-hardening.ts (the container is unchanged). */
export const git = (cwd: string, args: string[], allowFailure = false) =>
  isHostRuntime()
    ? hardenedGit(cwd, args, allowFailure)
    : run('git', args, { cwd, allowFailure, timeoutMs: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

/** Ref -> commit. Read with the gate git: the heads and bases the gates bind to ignore replace objects (task-71). */
async function revParse(repo: string, ref: string): Promise<string | null> {
  const r = await gateGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Commit SHA of a local branch, or null if it does not exist. */
export const headOf = (repo: string, branch: string) => revParse(repo, `refs/heads/${branch}`);

/**
 * Resolves the configured base branch (never assumes main): local branch first, then the imported
 * host ref, then origin. PRECONDITION if none exists.
 */
export async function resolveBaseBranch(repo: string, configured: string): Promise<{ branch: string; ref: string; sha: string }> {
  for (const ref of [`refs/heads/${configured}`, `refs/remotes/host/${configured}`, `refs/remotes/origin/${configured}`]) {
    const sha = await revParse(repo, ref);
    if (sha) return { branch: configured, ref, sha };
  }
  throw new MinionsError('PRECONDITION', `Base branch "${configured}" does not exist in ${repo}.`,
    'Run `minions import` on the host to seed the workspace, or fix git.baseBranch in the configuration.');
}

export interface WorktreeEntry { path: string; head: string | null; branch: string | null; detached: boolean }

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null, detached: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
  }
  return out;
}

async function findWorktree(repo: string, path: string): Promise<WorktreeEntry | undefined> {
  const target = real(path);
  return (await listWorktrees(repo)).find((w) => real(w.path) === target);
}

/** True if the worktree has uncommitted or untracked changes. */
export async function isDirty(path: string): Promise<boolean> {
  const r = await git(path, ['status', '--porcelain', '--untracked-files=normal']);
  return r.stdout.trim().length > 0;
}

export interface BranchWorktree { slug: string; branch: string; worktree: string; baseBranch: string; baseSha: string; head: string; created: boolean }

/** Creates or reuses branch agent/<slug> (from the base) and its worktree under worktrees/<slug>. */
export async function ensureBranchWorktree(layout: WorkspaceLayout, slug: string, baseBranch: string): Promise<BranchWorktree> {
  const { repo } = layout;
  const branch = branchFor(slug);
  const worktree = join(layout.worktrees, slug);
  const base = await resolveBaseBranch(repo, baseBranch);
  let created = false;
  if (!(await headOf(repo, branch))) {
    await git(repo, ['branch', '--no-track', branch, base.sha]);
    created = true;
  }
  const existing = await findWorktree(repo, worktree);
  if (existing) {
    if (existing.branch !== branch) {
      throw new MinionsError('PRECONDITION', `Worktree ${worktree} exists but is on ${existing.branch ?? 'a detached HEAD'}, not ${branch}.`,
        'Inspect it manually; minions never removes unknown worktrees.');
    }
  } else {
    if (await exists(worktree)) {
      throw new MinionsError('PRECONDITION', `${worktree} exists but is not a registered git worktree.`, 'Move it aside manually; minions will not delete it.');
    }
    const elsewhere = (await listWorktrees(repo)).find((w) => w.branch === branch);
    if (elsewhere) {
      throw new MinionsError('PRECONDITION', `Branch ${branch} is already checked out at ${elsewhere.path}.`, 'Only one worktree may write a task branch.');
    }
    await ensureDir(layout.worktrees);
    await git(repo, ['worktree', 'add', worktree, branch]);
    created = true;
  }
  return { slug, branch, worktree, baseBranch: base.branch, baseSha: base.sha, head: (await headOf(repo, branch))!, created };
}

/**
 * Detached review worktree under review/<slug> at `sha`. An existing one at another commit is
 * recreated, unless it has uncommitted changes (PRECONDITION; never deleted).
 */
export async function ensureReviewWorktree(layout: WorkspaceLayout, slug: string, sha: string): Promise<{ worktree: string; sha: string; recreated: boolean }> {
  const { repo } = layout;
  const worktree = join(layout.review, slug);
  const commit = await revParse(repo, sha);
  if (!commit) throw new MinionsError('NOT_FOUND', `Commit ${sha} does not exist in ${repo}.`);
  const existing = await findWorktree(repo, worktree);
  let recreated = false;
  if (existing) {
    if (existing.head === commit && existing.detached && !(await isDirty(worktree))) return { worktree, sha: commit, recreated };
    if (await isDirty(worktree)) {
      throw new MinionsError('PRECONDITION', `Review worktree ${worktree} has uncommitted changes; refusing to replace it.`,
        'Inspect and clean it manually (reviewers must not edit code), then claim again.');
    }
    await git(repo, ['worktree', 'remove', worktree]);
    recreated = true;
  } else if (await exists(worktree)) {
    throw new MinionsError('PRECONDITION', `${worktree} exists but is not a registered git worktree.`, 'Move it aside manually; minions will not delete it.');
  }
  await ensureDir(layout.review);
  await git(repo, ['worktree', 'add', '--detach', worktree, commit]);
  return { worktree, sha: commit, recreated };
}
