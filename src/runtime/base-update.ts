// Verified base update and derived approval (decision record: docs/design/bootstrap.md, "Base update and
// derived approval"; design: docs/design/unattended-delivery.md decision 5, task-68.3).
//
// - A delivered PR at its approved head H that GitHub reports BEHIND (or DIRTY, when a local merge-tree
//   finds it clean) is updated by code, without a model: B = origin's base (verified, fetched), the tree
//   of `git merge-tree --write-tree H B` (fixed options, built-in merge drivers only), `git commit-tree
//   <tree> -p H -p B` with the runtime's git identity gives H'. H' is pushed as a fast-forward of the PR
//   branch (never force; a rejection means someone else pushed), and `publications.head_sha` moves to H'.
// - A `base-update` evidence row {from: H, base: B, tree} on H' is written before the push. It is only a
//   hint: the merge gate recomputes every condition from git objects (deriveApproval below), and the pure
//   gate (merge.ts evaluateMergeGate) checks the verified result. Reviewer evidence for H counts for H'
//   when, for every link of the chain H -> H' -> H'' (at most MAX_BASE_UPDATE_CHAIN links), H' has exactly
//   the parents (H, B), B is an ancestor of (or equal to) the server's base, tree(H') equals a clean
//   merge-tree(H, B), and the link was recorded at the current config revision. CI is never derived.
// - Custom merge drivers, `merge=union` and a `merge.default` other than text change what a "clean" merge
//   means, so any such attribute in either commit's tree refuses the update and the derivation.
// - Every git call whose result the update or the derived approval depends on (merge-tree, parents, trees,
//   ancestry, the per-link diff, commit-tree) runs in an isolated git dir (withIsolatedRepo): its own
//   config, HEAD, refs, info and index, an empty work tree outside the checkout, and only the repository's
//   object store (a symlink, so the merge-tree's tree object lands there for commit-tree). Nothing in the
//   checkout's working tree, index, .git/config, .git/info/attributes, replace refs or grafts can change
//   the result. On git >= 2.42 `attr.tree` is pinned to the empty tree.
// - None of these calls (nor the ls-remote / fetch of the server's base) sees the minions process
//   environment: they run with an allowlisted one (git-hardening.ts allowlistedGit: locale, PATH, TZ,
//   TMPDIR; an empty HOME; no global or system config or attributes; only the GIT_* variables set there).
//   An agent invoking a minions command chooses that environment, so GIT_COMMON_DIR, GIT_GRAFT_FILE,
//   GIT_CONFIG_PARAMETERS, GIT_ATTR_SOURCE, HOME/.gitconfig and the like must not count. These calls
//   therefore never go through a caller's GitFn.
// - The server is the repository of the recorded PR URL (originOfPrUrl), never the workspace's `origin`
//   remote: ls-remote, fetch and push run in the isolated git dir against that explicit https URL (no
//   url.* / remote.* / http.* / credential.* config of the repository; the credential helper is passed on
//   the command line), and the base SHA is cross-checked with GitHub's API (verifiedServerBase; gh reads no
//   repository config). A mismatch or an unavailable gh fails closed.
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import type { RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';
import type { EvidenceRow, RuntimeDb } from './db.js';
import { allowlistedGit, isHostRuntime } from './git-hardening.js';
import { GIT_CREDENTIAL_HELPER, GITHUB_CREDENTIAL_KEY, type GitFn } from './github.js';
import type { GhFn } from './publish.js';

/** Longest chain of base updates a derived approval follows (H -> H' -> ... ); longer chains need a new review. */
export const MAX_BASE_UPDATE_CHAIN = 8;
export const BASE_UPDATE_KIND = 'base-update';

/**
 * Fixed options for every merge-tree call: the result must not depend on the repository's (agent-writable)
 * merge configuration. Built-in text merge for unspecified paths, renames on, no renormalization, no
 * user attributes file.
 */
export const MERGE_TREE_CONFIG = [
  'merge.default=text', 'merge.renames=true', 'merge.directoryRenames=conflict', 'merge.renormalize=false',
  'merge.conflictStyle=merge', 'merge.renameLimit=7000', 'diff.renames=true', 'core.attributesFile=/dev/null',
];
/**
 * Fixed options of every isolated call: no commit-graph (a worker-writable file in the object store that
 * could lie about parents), no replace refs, no untracked cache, no hooks. No automatic gc or maintenance:
 * the isolated dir shares the repository's object store but has none of its refs, so a gc there (after a
 * fetch) would prune the repository's objects.
 */
export const ISOLATED_GIT_CONFIG = [
  'core.commitGraph=false', 'core.useReplaceRefs=false', 'core.untrackedCache=false', 'core.hooksPath=/dev/null', 'core.fsmonitor=false',
  'gc.auto=0', 'maintenance.auto=false', 'fetch.writeCommitGraph=false', 'submodule.recurse=false', 'fetch.recurseSubmodules=false',
];
/** The empty tree per object format: git >= 2.42 reads attributes from `attr.tree` when set (pinned to nothing). */
const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};
const cfgArgs = (kv: string[]) => kv.flatMap((v) => ['-c', v]);

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const tail = (s: string) => redact(s.trim().split('\n').slice(-3).join(' | ')).slice(0, 400);

export type MergeTreeResult =
  | { state: 'clean'; tree: string }
  /** `tree`: the merged tree with conflict markers (the needs-rebase resolution diff compares the resolved head with it). */
  | { state: 'conflict'; files: string[]; tree: string }
  /** A custom or union merge driver applies, or git failed: never treated as clean. */
  | { state: 'refused' | 'error'; message: string };

/** Merge-driver values that keep merge-tree's built-in, conflict-reporting semantics. */
const BUILTIN_MERGE = new Set(['text', 'binary']);

/** `merge=<driver>` assignments in a gitattributes text that are not built-in text/binary (union and custom drivers). */
export function unsafeMergeAttributes(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Macro definitions ([attr]name merge=union ...) count too: a macro can set the driver.
    for (const tok of line.split(/\s+/).slice(1)) {
      const m = /^merge=(.*)$/.exec(tok);
      if (m && !BUILTIN_MERGE.has(m[1]!)) out.push(line);
    }
  }
  return out;
}

async function blobText(git: GitFn, repo: string, rev: string, path: string): Promise<string | null> {
  const r = await git(repo, ['cat-file', 'blob', `${rev}:${path}`], true);
  return r.code === 0 ? r.stdout : null;
}

/** An isolated view of a repository: run `git(dir, args)` (the GitFn below ignores its cwd argument). */
export interface IsolatedRepo { git: GitFn; dir: string; objectFormat: string }

/** Options of the allowlisted calls: an abort signal (the scan's budget) kills in-flight children. */
export interface CleanGitOptions { signal?: AbortSignal }
/** withIsolatedRepo: `network` keeps the proxy and MINIONS_* variables (git-hardening.ts allowlistedGitEnv) for ls-remote / fetch / push. */
export interface IsolatedOptions extends CleanGitOptions { network?: boolean }

/** Runs `fn` with an empty directory as git's HOME (removed afterwards). */
async function withEmptyHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'minions-home-'));
  try { return await fn(home); } finally { await rm(home, { recursive: true, force: true }).catch(() => {}); }
}

/**
 * Runs `fn` against an isolated git dir that shares only `repo`'s object store (see the header). Every
 * call, including locating the object store, uses the allowlisted environment (never the caller's
 * GitFn). The temporary directory (under os.tmpdir(), never inside a checkout; it also holds the empty
 * HOME) is removed afterwards. Throws when the repository's object store cannot be located.
 */
export async function withIsolatedRepo<T>(repo: string, fn: (iso: IsolatedRepo) => Promise<T>, opts: IsolatedOptions = {}): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'minions-iso-'));
  try {
    const home = join(root, 'home'), gitDir = join(root, 'git'), work = join(root, 'wt');
    await mkdir(home);
    const clean = { home, ...(opts.signal ? { signal: opts.signal } : {}) };
    const op = await allowlistedGit(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects', '--show-object-format'], true, clean);
    const [objects = '', format = ''] = op.code === 0 ? op.stdout.trim().split('\n').map((l) => l.trim()) : [];
    if (!objects || !isAbsolute(objects) || !EMPTY_TREE[format]) throw new Error(`cannot locate the object store of ${repo}: ${tail(op.stderr) || `git exit ${op.code}`}`);
    await mkdir(join(gitDir, 'refs', 'heads'), { recursive: true });
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await mkdir(work);
    await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/minions-isolated\n');
    // gc / maintenance off in the file too (see ISOLATED_GIT_CONFIG): a gc here would prune the shared store.
    await writeFile(join(gitDir, 'config'), (format === 'sha1'
      ? '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'
      : `[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = ${format}\n`) + '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
    await symlink(objects, join(gitDir, 'objects'));
    const lead = [`--git-dir=${gitDir}`, `--work-tree=${work}`, ...cfgArgs([...ISOLATED_GIT_CONFIG, `attr.tree=${EMPTY_TREE[format]}`])];
    const run = { ...clean, ...(opts.network ? { network: true } : {}) };
    const iso: GitFn = (_cwd, args, allowFailure) => allowlistedGit(work, [...lead, ...args], !!allowFailure, run);
    return await fn({ git: iso, dir: work, objectFormat: format });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** One allowlisted git call in an isolated git dir; a setup failure is returned as exit 128. */
export async function isolatedGit(repo: string, args: string[], opts: CleanGitOptions = {}): Promise<RunResult> {
  try {
    return await withIsolatedRepo(repo, (iso) => iso.git(iso.dir, args, true), opts);
  } catch (e) {
    return { code: 128, stdout: '', stderr: String((e as Error)?.message ?? e) };
  }
}

/** Whether `sha` is a commit in `repo`'s object store (isolated). */
export async function commitExists(repo: string, sha: string, opts: CleanGitOptions = {}): Promise<boolean> {
  return (await isolatedGit(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], opts)).code === 0;
}

/**
 * Refuses merge drivers that make a textual merge "clean" by other rules: every .gitattributes in the
 * given commits' trees (the isolated merge reads no other attributes, and the allowlisted environment
 * has no GIT_ATTR_SOURCE: see the header). Returns the
 * offending lines (empty = only built-in drivers).
 */
export async function mergeAttributeProblems(git: GitFn, repo: string, revs: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const rev of new Set(revs)) {
    const ls = await git(repo, ['ls-tree', '-r', '-z', '--name-only', rev], true);
    if (ls.code !== 0) { problems.push(`cannot list ${rev.slice(0, 12)}: ${tail(ls.stderr)}`); continue; }
    for (const p of ls.stdout.split('\0').filter((f) => f === '.gitattributes' || f.endsWith('/.gitattributes'))) {
      const text = await blobText(git, repo, rev, p);
      if (text === null) { problems.push(`cannot read ${p} at ${rev.slice(0, 12)}`); continue; }
      for (const l of unsafeMergeAttributes(text)) problems.push(`${p} at ${rev.slice(0, 12)}: ${l}`);
    }
  }
  return problems;
}

/**
 * `git merge-tree --write-tree` of two commits with fixed options and built-in drivers only, run in an
 * isolated git dir (withIsolatedRepo): the checkout's working tree, index and config never count.
 */
export async function mergeTree(repo: string, ours: string, theirs: string, opts: CleanGitOptions = {}): Promise<MergeTreeResult> {
  try {
    return await withIsolatedRepo(repo, (iso) => isolatedMergeTree(iso, ours, theirs), opts);
  } catch (e) {
    return { state: 'error', message: `git merge-tree not run: ${tail(String((e as Error)?.message ?? e))}` };
  }
}

async function isolatedMergeTree(iso: IsolatedRepo, ours: string, theirs: string): Promise<MergeTreeResult> {
  const { git, dir: repo } = iso;
  const attrs = await mergeAttributeProblems(git, repo, [ours, theirs]);
  if (attrs.length) return { state: 'refused', message: `custom or union merge drivers are configured (${attrs.slice(0, 5).join('; ')}); a base update needs built-in merges` };
  const r = await git(repo, [...cfgArgs(MERGE_TREE_CONFIG), 'merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', ours, theirs], true);
  const parts = r.stdout.split('\0');
  const tree = parts[0]?.trim() ?? '';
  if (r.code === 0 && FULL_SHA.test(tree)) return { state: 'clean', tree };
  if (r.code === 1 && FULL_SHA.test(tree)) return { state: 'conflict', files: [...new Set(parts.slice(1).filter(Boolean))], tree };
  return { state: 'error', message: `git merge-tree failed: ${tail(r.stderr || r.stdout) || `exit ${r.code}`}` };
}

// The GitFn helpers here (commitParents, treeOf, hasCommit, mergeAttributeProblems) take an IsolatedRepo's git.
export async function commitParents(git: GitFn, repo: string, sha: string): Promise<string[] | null> {
  const r = await git(repo, ['rev-list', '--parents', '-n', '1', sha, '--'], true);
  if (r.code !== 0) return null;
  const all = r.stdout.trim().split(/\s+/);
  return all[0] === sha ? all.slice(1) : null;
}

export async function treeOf(git: GitFn, repo: string, sha: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`], true);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function hasCommit(git: GitFn, repo: string, sha: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], true)).code === 0;
}

/**
 * H' = commit-tree <tree> -p H -p B, with the runtime's git identity, unsigned. Isolated (the commit object
 * lands in the repository's object store), so no GIT_AUTHOR_* / GIT_COMMITTER_* or config of the caller counts.
 */
export async function commitMerge(repo: string, o: { tree: string; head: string; base: string; baseBranch: string; identity: MinionsConfig['git']['identity'] }, opts: CleanGitOptions = {}): Promise<{ sha: string } | { error: string }> {
  const msg = `Merge ${o.baseBranch} (${o.base.slice(0, 12)}) into the approved head ${o.head.slice(0, 12)}\n\nBase update by minions: a clean merge-tree of the approved head and origin/${o.baseBranch}; no other change.`;
  const r = await isolatedGit(repo, [...cfgArgs([`user.name=${o.identity.name}`, `user.email=${o.identity.email}`, 'commit.gpgSign=false']),
    'commit-tree', o.tree, '-p', o.head, '-p', o.base, '-m', msg], opts);
  const sha = r.stdout.trim();
  return r.code === 0 && FULL_SHA.test(sha) ? { sha } : { error: `git commit-tree failed: ${tail(r.stderr) || `exit ${r.code}`}` };
}

// ---------------------------------------------------------------- derived approval

export interface BaseUpdateRecord { from: string; base: string; tree: string }

/** The facts of one link H -> H', each recomputed from git objects (the record only names the candidate). */
export interface BaseUpdateLink {
  head: string;
  /** Parent 1 and 2 as git reports them (not as the record claims). */
  from: string | null;
  base: string | null;
  checks: {
    /** A base-update record exists for this head and agrees with git (parents and tree). */
    record: boolean;
    /** Exactly two parents. */
    parents: boolean;
    /** Parent 2 is an ancestor of, or equal to, the server's base. */
    ancestry: boolean;
    /** tree(head) equals a clean merge-tree(parent 1, parent 2). */
    tree: boolean;
    /** The record was written at the current config revision. */
    revision: boolean;
  };
  problems: string[];
}

export interface DerivedApproval {
  /** The head the merge gate evaluates (the approved publication head). */
  head: string;
  /** Where the chain ends at reviewer evidence; null when it does not. */
  reviewedHead: string | null;
  links: BaseUpdateLink[];
  /** The server's base the ancestry was checked against. */
  serverBase: string | null;
  problems: string[];
}

export function parseBaseUpdate(row: Pick<EvidenceRow, 'details_json'>): BaseUpdateRecord | null {
  try {
    const d = JSON.parse(row.details_json ?? 'null') as Partial<BaseUpdateRecord> | null;
    if (d && typeof d.from === 'string' && typeof d.base === 'string' && typeof d.tree === 'string') return { from: d.from, base: d.base, tree: d.tree };
  } catch { /* not a record */ }
  return null;
}

/**
 * Verifies one link from git objects. `record` is the candidate base-update evidence for `head` (a hint).
 * Every git call runs in an isolated git dir (withIsolatedRepo); a failure to set it up fails the link.
 */
export async function verifyLink(repo: string, head: string, record: Pick<EvidenceRow, 'details_json' | 'config_revision'> | undefined, o: { serverBase: string | null; configRevision: number } & CleanGitOptions): Promise<BaseUpdateLink> {
  try {
    return await withIsolatedRepo(repo, (iso) => verifyLinkIn(iso, head, record, o), o.signal ? { signal: o.signal } : {});
  } catch (e) {
    return { head, from: null, base: null, checks: { record: false, parents: false, ancestry: false, tree: false, revision: false },
      problems: [`cannot verify ${head.slice(0, 12)}: ${tail(String((e as Error)?.message ?? e))}`] };
  }
}

async function verifyLinkIn(iso: IsolatedRepo, head: string, record: Pick<EvidenceRow, 'details_json' | 'config_revision'> | undefined, o: { serverBase: string | null; configRevision: number }): Promise<BaseUpdateLink> {
  const { git, dir: repo } = iso;
  const problems: string[] = [];
  const checks = { record: false, parents: false, ancestry: false, tree: false, revision: false };
  const parents = await commitParents(git, repo, head);
  const [from = null, base = null] = parents ?? [];
  const link: BaseUpdateLink = { head, from, base, checks, problems };
  if (!parents) { problems.push(`${head.slice(0, 12)} is not a commit in the workspace`); return link; }
  checks.parents = parents.length === 2;
  if (!checks.parents) problems.push(`${head.slice(0, 12)} has ${parents.length} parent(s), not exactly (approved head, base)`);
  const rec = record ? parseBaseUpdate(record) : null;
  const tree = await treeOf(git, repo, head);
  if (!rec) problems.push(`no base-update record for ${head.slice(0, 12)}`);
  else if (rec.from !== from || rec.base !== base) problems.push(`the base-update record of ${head.slice(0, 12)} names parents (${rec.from.slice(0, 12)}, ${rec.base.slice(0, 12)}) but git has (${String(from).slice(0, 12)}, ${String(base).slice(0, 12)})`);
  else if (rec.tree !== tree) problems.push(`the base-update record of ${head.slice(0, 12)} names tree ${rec.tree.slice(0, 12)} but the commit has ${String(tree).slice(0, 12)}`);
  else checks.record = true;
  checks.revision = !!record && record.config_revision === o.configRevision;
  if (record && !checks.revision) problems.push(`the base update to ${head.slice(0, 12)} was recorded at config revision ${record.config_revision}, not ${o.configRevision}`);
  if (!checks.parents) return link;
  if (!o.serverBase) problems.push('the server\'s base could not be read');
  else if (!(await hasCommit(git, repo, o.serverBase))) problems.push(`the server's base ${o.serverBase.slice(0, 12)} is not in the workspace`);
  else {
    checks.ancestry = (await git(repo, ['merge-base', '--is-ancestor', base!, o.serverBase], true)).code === 0;
    if (!checks.ancestry) problems.push(`parent 2 ${base!.slice(0, 12)} of ${head.slice(0, 12)} is not on the server's base ${o.serverBase.slice(0, 12)}`);
  }
  const mt = await isolatedMergeTree(iso, from!, base!);
  if (mt.state !== 'clean') problems.push(mt.state === 'conflict' ? `merge-tree of ${from!.slice(0, 12)} and ${base!.slice(0, 12)} conflicts (${mt.files.slice(0, 5).join(', ')})` : mt.message);
  else {
    checks.tree = mt.tree === tree;
    if (!checks.tree) problems.push(`tree of ${head.slice(0, 12)} (${String(tree).slice(0, 12)}) is not the merge-tree of its parents (${mt.tree.slice(0, 12)})`);
  }
  return link;
}

// ---------------------------------------------------------------- the server (origin on GitHub)

/** The GitHub repository a task was delivered to, from minions' own record (the publication's PR URL). */
export interface ServerOrigin { https: string; repository: string }
/**
 * Test seam: the URL git contacts for a recorded https origin (default: the URL itself). Only code sets it
 * (tests point it at a local bare repository); never config, the environment or the repository.
 */
export type ServerUrlFn = (https: string) => string;
export interface ServerOptions extends CleanGitOptions { serverUrl?: ServerUrlFn }

const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+$/;

/** The origin of a recorded PR URL (`https://github.com/<o>/<r>/pull/<n>`), or null. */
export function originOfPrUrl(prUrl: string | null | undefined): ServerOrigin | null {
  const m = PR_URL.exec(String(prUrl ?? '').trim());
  if (!m) return null;
  const [, owner, repo] = m as unknown as [string, string, string];
  if ([owner, repo].some((p) => p === '.' || p === '..' || p.startsWith('-') || p.endsWith('.git'))) return null;
  return { https: `https://github.com/${owner}/${repo}.git`, repository: `${owner}/${repo}` };
}

/**
 * Credential helper of a network call, given explicitly (the isolated config has none). The host runtime's
 * hardened `-c` options (allowlistedGit) already reset the list and add its shim; the container names the
 * literal helper path (never an environment variable an agent could set).
 */
const credentialArgs = () => (isHostRuntime() ? [] : cfgArgs(['credential.helper=', `${GITHUB_CREDENTIAL_KEY}=${GIT_CREDENTIAL_HELPER}`]));
/** Fixed options of the isolated network calls (on top of ISOLATED_GIT_CONFIG). */
const NETWORK_GIT_CONFIG = ['credential.interactive=false', 'http.followRedirects=initial', 'push.gpgSign=false'];

/**
 * One network call in an isolated git dir (withIsolatedRepo: its own config with no url.*, remote.*,
 * http.* or credential sections; the allowlisted environment with an empty HOME and no global or system
 * config) against the explicit URL of the recorded origin. Nothing in the repository's .git/config
 * (insteadOf, pushInsteadOf, pushurl, a proxy, a helper) or the caller's environment changes where it goes.
 */
async function serverGit<T>(repo: string, fn: (run: (args: string[]) => Promise<RunResult>, iso: IsolatedRepo) => Promise<T>, opts: CleanGitOptions): Promise<T> {
  return withIsolatedRepo(repo, (iso) => fn((args) => iso.git(iso.dir, [...credentialArgs(), ...cfgArgs(NETWORK_GIT_CONFIG), ...args], true), iso),
    { ...(opts.signal ? { signal: opts.signal } : {}), network: true });
}
const urlOf = (origin: ServerOrigin, opts: ServerOptions) => (opts.serverUrl ?? ((u: string) => u))(origin.https);

/** The SHA of exactly `refs/heads/<branch>` in `ls-remote` output (patterns match ref tails, so filter). */
function refSha(stdout: string, branch: string): string | null {
  for (const line of stdout.split('\n')) {
    const [sha = '', ref = ''] = line.trim().split(/\s+/);
    if (ref === `refs/heads/${branch}` && FULL_SHA.test(sha)) return sha;
  }
  return null;
}

/** origin's branch `branch` as the server reports it (isolated ls-remote against the recorded URL), or null. */
export async function serverRefOf(repo: string, origin: ServerOrigin, branch: string, opts: ServerOptions = {}): Promise<string | null> {
  try {
    const ls = await serverGit(repo, (git) => git(['ls-remote', '--heads', urlOf(origin, opts), `refs/heads/${branch}`]), opts);
    return ls.code === 0 ? refSha(ls.stdout, branch) : null;
  } catch { return null; }
}

/**
 * GitHub's own view of `branch` (`gh api repos/<o>/<r>/branches/<branch>`, pinned to github.com): gh reads
 * no repository config, so a git-side redirect cannot also forge this. Null when gh fails or says nothing.
 */
export async function githubBranchSha(gh: GhFn, origin: ServerOrigin, branch: string, opts: CleanGitOptions = {}): Promise<{ sha: string } | { error: string }> {
  const path = `/repos/${origin.repository}/branches/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const r = await gh(['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '--hostname', 'github.com', path], { cwd: '/', ...(opts.signal ? { signal: opts.signal } : {}) });
  if (r.code !== 0) return { error: `gh api ${path} failed: ${tail(r.stderr || r.stdout) || `exit ${r.code}`}` };
  try {
    const sha = (JSON.parse(r.stdout) as { commit?: { sha?: unknown } } | null)?.commit?.sha;
    if (typeof sha === 'string' && FULL_SHA.test(sha)) return { sha };
  } catch { /* below */ }
  return { error: `gh api ${path} returned no commit SHA` };
}

/**
 * The server's `base`, cross-checked: the isolated ls-remote against the recorded URL and GitHub's API must
 * name the same commit. A mismatch or an unavailable gh refuses (fail closed); the API is asked first, so
 * nothing goes over the network when it already fails.
 */
export async function verifiedServerBase(o: { repo: string; gh: GhFn; origin: ServerOrigin; base: string } & ServerOptions): Promise<{ sha: string } | { error: string }> {
  const api = await githubBranchSha(o.gh, o.origin, o.base, o);
  if ('error' in api) return { error: `cannot verify origin's ${o.base} with the GitHub API (${api.error})` };
  const git = await serverRefOf(o.repo, o.origin, o.base, o);
  if (!git) return { error: `origin's ${o.base} could not be read from ${o.origin.https}` };
  if (git !== api.sha) return { error: `origin's ${o.base} is ${git.slice(0, 12)} for git but ${api.sha.slice(0, 12)} for the GitHub API; refusing (retried on the next pass)` };
  return { sha: git };
}

/**
 * Fetches origin's `base` from the recorded URL into the shared object store (isolated; `haves` are commits
 * the server is known to have, so only new objects come). Then points the repository's
 * refs/remotes/origin/<base> at the fetched tip so the objects stay referenced (never the local base branch).
 */
export async function fetchBase(repo: string, origin: ServerOrigin, base: string, opts: ServerOptions & { haves?: string[] } = {}): Promise<{ ok: true } | { ok: false; message: string }> {
  let tip = '';
  try {
    const f = await serverGit(repo, async (git, iso) => {
      for (const [i, h] of [...new Set(opts.haves ?? [])].filter((x) => FULL_SHA.test(x)).entries()) {
        await iso.git(iso.dir, ['update-ref', `refs/minions/have/${i}`, h], true); // only a negotiation hint; a missing commit is skipped
      }
      const r = await git(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', urlOf(origin, opts), `+refs/heads/${base}:refs/minions/fetched`]);
      if (r.code === 0) tip = (await iso.git(iso.dir, ['rev-parse', '--verify', '--quiet', 'refs/minions/fetched^{commit}'], true)).stdout.trim();
      return r;
    }, opts);
    if (f.code !== 0) return { ok: false, message: `fetching ${base} from origin failed: ${tail(f.stderr) || `git exit ${f.code}`}` };
  } catch (e) {
    return { ok: false, message: `fetching ${base} from origin failed: ${tail(String((e as Error)?.message ?? e))}` };
  }
  if (FULL_SHA.test(tip)) {
    await withEmptyHome((home) => allowlistedGit(repo, ['-c', 'core.hooksPath=/dev/null', 'update-ref', '-m', 'minions: fetch', `refs/remotes/origin/${base}`, tip], true,
      { home, ...(opts.signal ? { signal: opts.signal } : {}) })).catch(() => undefined);
  }
  return { ok: true };
}

/**
 * Pushes `sha` to `refs/heads/<branch>` of the recorded origin URL (isolated: no pushInsteadOf, pushurl or
 * hook of the repository; never forced, so the server refuses anything but a fast-forward).
 */
export async function pushToServer(repo: string, origin: ServerOrigin, sha: string, branch: string, opts: ServerOptions = {}): Promise<RunResult> {
  try {
    return await serverGit(repo, (git) => git(['push', '--porcelain', '--no-verify', '--no-recurse-submodules', urlOf(origin, opts), `${sha}:refs/heads/${branch}`]), opts);
  } catch (e) {
    return { code: 128, stdout: '', stderr: String((e as Error)?.message ?? e) };
  }
}

/**
 * Follows base-update links from `head` back to a head with reviewer evidence, verifying every link from
 * git objects. Never throws; the result is passed to the pure merge gate, which accepts it only when the
 * chain is contiguous, at most MAX_BASE_UPDATE_CHAIN long, every check holds and it ends at evidence.
 */
export async function deriveApproval(o: {
  repo: string; db: RuntimeDb; taskId: string; head: string; configRevision: number;
  serverBase: string | null; isReviewed: (head: string) => boolean; maxChain?: number; signal?: AbortSignal;
}): Promise<DerivedApproval> {
  const max = o.maxChain ?? MAX_BASE_UPDATE_CHAIN;
  const out: DerivedApproval = { head: o.head, reviewedHead: null, links: [], serverBase: o.serverBase, problems: [] };
  let cur = o.head;
  for (;;) {
    if (o.isReviewed(cur)) { if (out.links.length) out.reviewedHead = cur; break; }
    if (out.links.length >= max) { out.problems.push(`more than ${max} base updates since the last review`); break; }
    const record = o.db.evidenceFor(o.taskId, cur, BASE_UPDATE_KIND).at(-1);
    if (!record && !out.links.length) { out.problems.push(`no base-update record for ${cur.slice(0, 12)}`); break; }
    const link = await verifyLink(o.repo, cur, record, { serverBase: o.serverBase, configRevision: o.configRevision, ...(o.signal ? { signal: o.signal } : {}) });
    out.links.push(link);
    if (link.problems.length || !link.from) { out.problems.push(...link.problems); break; }
    cur = link.from;
  }
  return out;
}

/**
 * Pure acceptance of a derived approval (used by evaluateMergeGate): the chain starts at the approved
 * head, every link is contiguous and verified, it is at most `max` links long and ends at a reviewed head.
 */
export function derivedApprovalProblems(d: DerivedApproval | undefined, approvedHead: string, max = MAX_BASE_UPDATE_CHAIN): string[] {
  if (!d) return ['no base-update chain'];
  const p: string[] = [];
  if (d.head !== approvedHead) p.push(`the derivation is for ${d.head.slice(0, 12)}, not the approved head`);
  if (!d.links.length) p.push('no base-update chain');
  if (d.links.length > max) p.push(`more than ${max} base updates since the last review`);
  let expect = approvedHead;
  for (const l of d.links) {
    if (l.head !== expect) { p.push(`the chain is broken at ${l.head.slice(0, 12)}`); break; }
    const failed = Object.entries(l.checks).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length || l.problems.length || !l.from) { p.push(...(l.problems.length ? l.problems : [`base update to ${l.head.slice(0, 12)} fails: ${failed.join(', ')}`])); break; }
    expect = l.from;
  }
  if (!p.length && d.reviewedHead !== expect) p.push('the chain does not end at reviewer evidence');
  if (!p.length && d.problems.length) p.push(...d.problems);
  return p;
}
