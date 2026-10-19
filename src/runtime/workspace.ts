import { dirname, resolve as resolvePath } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { ensureDir, exists } from '../core/fsutil.js';
import { openDb } from './db.js';
import type { RuntimePaths } from './paths.js';
import { BRANCH_PREFIX, git, workspaceLayout, type WorkspaceLayout } from './worktree.js';

const validBranch = (b: string) => /^[A-Za-z0-9._/-]+$/.test(b) && !b.startsWith('-') && !b.includes('..');

export interface ImportResult { head: string; base: string; imported: boolean; repo: string; hostRefs: string[] }

/**
 * Seeds /workspace/repo from a Git bundle. Absent repo: clone (remote `host`, base checked out).
 * Existing repo: fetch into refs/remotes/host/* only — local branches are never rewritten.
 * `imported` is true when the repo was cloned, false when an existing clone was refreshed.
 */
export async function importWorkspace(bundlePath: string, opts: { base: string; remoteUrl?: string; config: Pick<MinionsConfig, 'git'>; layout?: WorkspaceLayout }): Promise<ImportResult> {
  const layout = opts.layout ?? workspaceLayout();
  const bundle = resolvePath(bundlePath);
  if (!validBranch(opts.base)) throw new MinionsError('PRECONDITION', `Invalid base branch name "${opts.base}".`);
  if (!(await exists(bundle))) throw new MinionsError('NOT_FOUND', `Bundle not found: ${bundle}`);
  const heads = await git(dirname(bundle), ['bundle', 'list-heads', bundle], true);
  if (heads.code !== 0) throw new MinionsError('PRECONDITION', `${bundle} is not a readable git bundle: ${heads.stderr.trim()}`);
  if (!heads.stdout.split('\n').some((l) => l.endsWith(` refs/heads/${opts.base}`))) {
    throw new MinionsError('PRECONDITION', `Bundle does not contain base branch ${opts.base}.`, 'Export the bundle from the configured base branch.');
  }
  const repo = layout.repo;
  let imported = false;
  if (!(await exists(repo))) {
    await ensureDir(layout.root);
    await git(layout.root, ['clone', '--origin', 'host', '--branch', opts.base, bundle, repo]);
    imported = true;
  } else {
    const inside = await git(repo, ['rev-parse', '--is-inside-work-tree'], true);
    if (inside.code !== 0) throw new MinionsError('PRECONDITION', `${repo} exists but is not a git repository.`, 'Inspect the workspace volume manually.');
    await git(repo, ['fetch', '--no-tags', bundle, '+refs/heads/*:refs/remotes/host/*']);
  }
  const id = opts.config.git.identity;
  await git(repo, ['config', 'user.name', id.name]);
  await git(repo, ['config', 'user.email', id.email]);
  if (opts.remoteUrl) {
    const has = await git(repo, ['remote', 'get-url', 'origin'], true);
    await git(repo, has.code === 0 ? ['remote', 'set-url', 'origin', opts.remoteUrl] : ['remote', 'add', 'origin', opts.remoteUrl]);
    // Recorded only; never fetched in v0.1 (no credentials in the container).
  }
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const hostRefs = (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/host/'])).stdout.split('\n').filter(Boolean);
  return { head, base: opts.base, imported, repo, hostRefs };
}

/** Writes a bundle containing the base branch and every agent/* branch. */
export async function exportWorkspace(outPath: string, opts: { base: string; layout?: WorkspaceLayout }): Promise<{ path: string; refs: string[] }> {
  const layout = opts.layout ?? workspaceLayout();
  const repo = layout.repo;
  if (!(await exists(repo))) throw new MinionsError('PRECONDITION', `No workspace repository at ${repo}.`, 'Run `minions import` on the host first.');
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname)', `refs/heads/${BRANCH_PREFIX}`])).stdout.split('\n').filter(Boolean);
  const baseRef = `refs/heads/${opts.base}`;
  const hasBase = (await git(repo, ['rev-parse', '--verify', '--quiet', baseRef], true)).code === 0;
  if (hasBase) refs.unshift(baseRef);
  if (!refs.length) throw new MinionsError('PRECONDITION', 'Nothing to export: no base branch and no agent/* branches.');
  const path = resolvePath(outPath);
  await ensureDir(dirname(path));
  await git(repo, ['bundle', 'create', path, ...refs]);
  return { path, refs };
}

/** Idempotent: creates the /state layout, the runtime DB and the Backlog.md config. */
export async function setupState(paths: RuntimePaths, writeBacklogConfig: (root: string) => Promise<{ path: string; changed: boolean }>): Promise<{ state: string; dirs: string[]; db: string; schemaVersion: number; backlogConfig: { path: string; changed: boolean } }> {
  const dirs = [paths.state, paths.backlog, paths.notes, paths.import, paths.exports, paths.logs];
  for (const d of dirs) await ensureDir(d);
  const db = openDb(paths.db);
  let schemaVersion: number;
  try { schemaVersion = Number(db.getMeta('schema_version')); } finally { db.close(); }
  const backlogConfig = await writeBacklogConfig(paths.backlog);
  return { state: paths.state, dirs, db: paths.db, schemaVersion, backlogConfig };
}
