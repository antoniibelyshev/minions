import { dirname, resolve as resolvePath } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { ensureDir, exists } from '../core/fsutil.js';
import { openDb } from './db.js';
import { configureOrigin, type OriginResult } from './github.js';
import type { RuntimePaths } from './paths.js';
import { BRANCH_PREFIX, git, workspaceLayout, type WorkspaceLayout } from './worktree.js';

const validBranch = (b: string) => /^[A-Za-z0-9._/-]+$/.test(b) && !b.startsWith('-') && !b.includes('..');

export interface ImportResult {
  head: string; base: string; imported: boolean; baseFastForwarded: boolean; repo: string; hostRefs: string[];
  /** Present only when a GitHub token file is mounted (readable or not); absent = unchanged v0.1 behaviour. */
  origin?: OriginResult;
}

/**
 * Seeds /workspace/repo from a Git bundle. Absent repo: clone (remote `host`, base checked out).
 * Existing repo: fetch into refs/remotes/host/*; the local base branch is only fast-forwarded (so new
 * agent branches start from the refreshed base) and never rewritten — a diverged base is left alone.
 * `imported` is true when the repo was cloned, false when an existing clone was refreshed.
 */
export async function importWorkspace(bundlePath: string, opts: { base: string; remoteUrl?: string; config: Pick<MinionsConfig, 'git'>; layout?: WorkspaceLayout; tokenFile?: string }): Promise<ImportResult> {
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
  let baseFastForwarded = false;
  if (!(await exists(repo))) {
    await ensureDir(layout.root);
    await git(layout.root, ['clone', '--origin', 'host', '--branch', opts.base, bundle, repo]);
    imported = true;
  } else {
    const inside = await git(repo, ['rev-parse', '--is-inside-work-tree'], true);
    if (inside.code !== 0) throw new MinionsError('PRECONDITION', `${repo} exists but is not a git repository.`, 'Inspect the workspace volume manually.');
    await git(repo, ['fetch', '--no-tags', bundle, '+refs/heads/*:refs/remotes/host/*']);
    baseFastForwarded = await fastForwardBase(repo, opts.base);
  }
  const id = opts.config.git.identity;
  await git(repo, ['config', 'user.name', id.name]);
  await git(repo, ['config', 'user.email', id.email]);
  // Without a mounted GitHub token the URL is recorded verbatim and never fetched (unchanged v0.1
  // behaviour); with one, origin becomes the https URL backed by the credential helper.
  const origin = await configureOrigin(repo, { remoteUrl: opts.remoteUrl, base: opts.base, tokenFile: opts.tokenFile });
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const hostRefs = (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes/host/'])).stdout.split('\n').filter(Boolean);
  return { head, base: opts.base, imported, baseFastForwarded, repo, hostRefs, ...(origin ? { origin } : {}) };
}

/** Fast-forwards the local base branch to refs/remotes/host/<base> when that is a pure fast-forward. */
async function fastForwardBase(repo: string, base: string): Promise<boolean> {
  const local = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], true);
  const host = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/host/${base}`], true);
  if (local.code !== 0 || host.code !== 0 || local.stdout.trim() === host.stdout.trim()) return false;
  if ((await git(repo, ['merge-base', '--is-ancestor', local.stdout.trim(), host.stdout.trim()], true)).code !== 0) return false;
  const current = (await git(repo, ['symbolic-ref', '--quiet', 'HEAD'], true)).stdout.trim();
  const r = current === `refs/heads/${base}`
    ? await git(repo, ['merge', '--ff-only', '--quiet', `refs/remotes/host/${base}`], true)
    : await git(repo, ['update-ref', `refs/heads/${base}`, host.stdout.trim(), local.stdout.trim()], true);
  return r.code === 0;
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
  const dirs = [paths.state, paths.backlog, paths.notes, paths.briefs, paths.results, paths.import, paths.exports, paths.logs];
  for (const d of dirs) await ensureDir(d);
  const db = openDb(paths.db);
  let schemaVersion: number;
  try { schemaVersion = Number(db.getMeta('schema_version')); } finally { db.close(); }
  const backlogConfig = await writeBacklogConfig(paths.backlog);
  return { state: paths.state, dirs, db: paths.db, schemaVersion, backlogConfig };
}
