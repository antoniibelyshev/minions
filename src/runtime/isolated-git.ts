// Isolated git for the local integration (integration.ts): every git call whose result a landing depends on
// (merge-tree, ancestry, diffs, commit-tree) runs in an isolated git dir (withIsolatedRepo): its own config,
// HEAD, refs, info and index, an empty work tree outside the checkout, and only the repository's object store
// (a symlink, so a merge-tree's tree object lands there for commit-tree). Nothing in the checkout's working
// tree, index, .git/config, .git/info/attributes, replace refs or grafts can change the result. On git >= 2.42
// `attr.tree` is pinned to the empty tree.
// - Custom merge drivers, `merge=union` and a `merge.default` other than text change what a "clean" merge
//   means, so any such attribute in either commit's tree refuses the merge.
// - None of these calls sees the minions process environment: they run with an allowlisted one
//   (git-hardening.ts allowlistedGit: locale, PATH, TZ, TMPDIR; an empty HOME; no global or system config or
//   attributes; only the GIT_* variables set there). An agent invoking a minions command chooses that
//   environment, so GIT_COMMON_DIR, GIT_GRAFT_FILE, GIT_CONFIG_PARAMETERS, GIT_ATTR_SOURCE, HOME/.gitconfig and
//   the like must not count. These calls therefore never go through a caller's GitFn.
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import type { RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';
import { allowlistedGit } from './git-hardening.js';

export type GitFn = (cwd: string, args: string[], allowFailure?: boolean) => Promise<RunResult>;

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
/** `-c k=v` pairs for a list of `k=v` options. */
export const cfgArgs = (kv: string[]) => kv.flatMap((v) => ['-c', v]);

/** A full object name (sha1 or sha256). */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The last lines of git output, redacted and bounded (for messages). */
export const tail = (s: string) => redact(s.trim().split('\n').slice(-3).join(' | ')).slice(0, 400);

export type MergeTreeResult =
  | { state: 'clean'; tree: string }
  | { state: 'conflict'; files: string[] }
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

/** Runs `fn` with an empty directory as git's HOME (removed afterwards). */
export async function withEmptyHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'minions-home-'));
  try { return await fn(home); } finally { await rm(home, { recursive: true, force: true }).catch(() => {}); }
}

/**
 * Runs `fn` against an isolated git dir that shares only `repo`'s object store (see the header). Every
 * call, including locating the object store, uses the allowlisted environment (never the caller's
 * GitFn). The temporary directory (under os.tmpdir(), never inside a checkout; it also holds the empty
 * HOME) is removed afterwards. Throws when the repository's object store cannot be located.
 */
export async function withIsolatedRepo<T>(repo: string, fn: (iso: IsolatedRepo) => Promise<T>, opts: CleanGitOptions = {}): Promise<T> {
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
    const iso: GitFn = (_cwd, args, allowFailure) => allowlistedGit(work, [...lead, ...args], !!allowFailure, clean);
    return await fn({ git: iso, dir: work, objectFormat: format });
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
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

/**
 * The merge-tree of `ours` and `theirs` inside an already isolated git dir. `purpose` names the operation in the refusal.
 */
export async function isolatedMergeTree(iso: IsolatedRepo, ours: string, theirs: string, purpose: string): Promise<MergeTreeResult> {
  const { git, dir: repo } = iso;
  const attrs = await mergeAttributeProblems(git, repo, [ours, theirs]);
  if (attrs.length) return { state: 'refused', message: `custom or union merge drivers are configured (${attrs.slice(0, 5).join('; ')}); ${purpose} needs built-in merges` };
  const r = await git(repo, [...cfgArgs(MERGE_TREE_CONFIG), 'merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', ours, theirs], true);
  const parts = r.stdout.split('\0');
  const tree = parts[0]?.trim() ?? '';
  if (r.code === 0 && FULL_SHA.test(tree)) return { state: 'clean', tree };
  if (r.code === 1 && FULL_SHA.test(tree)) return { state: 'conflict', files: [...new Set(parts.slice(1).filter(Boolean))] };
  return { state: 'error', message: `git merge-tree failed: ${tail(r.stderr || r.stdout) || `exit ${r.code}`}` };
}

/**
 * `commit-tree <tree> -p <parent>... -m <message>` inside an isolated git dir with `identity` as author and
 * committer, unsigned: the caller's GIT_AUTHOR_* / GIT_COMMITTER_* and config never count.
 */
export async function isolatedCommitTree(iso: IsolatedRepo, o: { tree: string; parents: string[]; message: string; identity: MinionsConfig['git']['identity'] }): Promise<{ sha: string } | { error: string }> {
  const r = await iso.git(iso.dir, [...cfgArgs([`user.name=${o.identity.name}`, `user.email=${o.identity.email}`, 'commit.gpgSign=false']),
    'commit-tree', o.tree, ...o.parents.flatMap((p) => ['-p', p]), '-m', o.message], true);
  const sha = r.stdout.trim();
  return r.code === 0 && FULL_SHA.test(sha) ? { sha } : { error: `git commit-tree failed: ${tail(r.stderr) || `exit ${r.code}`}` };
}
