// Verified base update and derived approval (decision record: docs/design/bootstrap.md, "Base update and
// derived approval"; design: docs/design/unattended-delivery.md decision 5, task-68.3).
//
// - A delivered PR at its approved head H that GitHub reports BEHIND (or DIRTY, when a local merge-tree
//   finds it clean) is updated by code, without a model: B = origin's base (ls-remote, fetched), the tree
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
//   means, so any such attribute (in either tree, .git/info/attributes or the checkout) refuses the update
//   and the derivation.
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { redact } from '../core/output.js';
import type { EvidenceRow, RuntimeDb } from './db.js';
import type { GitFn } from './github.js';

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
const cfgArgs = (kv: string[]) => kv.flatMap((v) => ['-c', v]);

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const tail = (s: string) => redact(s.trim().split('\n').slice(-3).join(' | ')).slice(0, 400);

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

/**
 * Refuses merge drivers that make a textual merge "clean" by other rules: every .gitattributes in the
 * given commits' trees, .git/info/attributes and the checkout's top-level .gitattributes. Returns the
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
  const gp = await git(repo, ['rev-parse', '--git-path', 'info/attributes'], true);
  const local: string[] = [join(repo, '.gitattributes')];
  if (gp.code === 0 && gp.stdout.trim()) { const p = gp.stdout.trim(); local.push(isAbsolute(p) ? p : join(repo, p)); }
  for (const f of local) {
    const text = await readFile(f, 'utf8').catch(() => null);
    if (text !== null) for (const l of unsafeMergeAttributes(text)) problems.push(`${f}: ${l}`);
  }
  return problems;
}

/** `git merge-tree --write-tree` of two commits with fixed options and built-in drivers only. */
export async function mergeTree(git: GitFn, repo: string, ours: string, theirs: string): Promise<MergeTreeResult> {
  const attrs = await mergeAttributeProblems(git, repo, [ours, theirs]);
  if (attrs.length) return { state: 'refused', message: `custom or union merge drivers are configured (${attrs.slice(0, 5).join('; ')}); a base update needs built-in merges` };
  const r = await git(repo, [...cfgArgs(MERGE_TREE_CONFIG), 'merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', ours, theirs], true);
  const parts = r.stdout.split('\0');
  const tree = parts[0]?.trim() ?? '';
  if (r.code === 0 && FULL_SHA.test(tree)) return { state: 'clean', tree };
  if (r.code === 1 && FULL_SHA.test(tree)) return { state: 'conflict', files: [...new Set(parts.slice(1).filter(Boolean))] };
  return { state: 'error', message: `git merge-tree failed: ${tail(r.stderr || r.stdout) || `exit ${r.code}`}` };
}

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

/** H' = commit-tree <tree> -p H -p B, with the runtime's git identity, unsigned. */
export async function commitMerge(git: GitFn, repo: string, o: { tree: string; head: string; base: string; baseBranch: string; identity: MinionsConfig['git']['identity'] }): Promise<{ sha: string } | { error: string }> {
  const msg = `Merge ${o.baseBranch} (${o.base.slice(0, 12)}) into the approved head ${o.head.slice(0, 12)}\n\nBase update by minions: a clean merge-tree of the approved head and origin/${o.baseBranch}; no other change.`;
  const r = await git(repo, [...cfgArgs([`user.name=${o.identity.name}`, `user.email=${o.identity.email}`, 'commit.gpgSign=false']),
    'commit-tree', o.tree, '-p', o.head, '-p', o.base, '-m', msg], true);
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

/** Verifies one link from git objects. `record` is the candidate base-update evidence for `head` (a hint). */
export async function verifyLink(git: GitFn, repo: string, head: string, record: Pick<EvidenceRow, 'details_json' | 'config_revision'> | undefined, o: { serverBase: string | null; configRevision: number }): Promise<BaseUpdateLink> {
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
  const mt = await mergeTree(git, repo, from!, base!);
  if (mt.state !== 'clean') problems.push(mt.state === 'conflict' ? `merge-tree of ${from!.slice(0, 12)} and ${base!.slice(0, 12)} conflicts (${mt.files.slice(0, 5).join(', ')})` : mt.message);
  else {
    checks.tree = mt.tree === tree;
    if (!checks.tree) problems.push(`tree of ${head.slice(0, 12)} (${String(tree).slice(0, 12)}) is not the merge-tree of its parents (${mt.tree.slice(0, 12)})`);
  }
  return link;
}

/** origin's base as the server reports it (ls-remote), or null. */
export async function serverBaseOf(git: GitFn, repo: string, remote: string, base: string): Promise<string | null> {
  const ls = await git(repo, ['ls-remote', '--heads', remote, `refs/heads/${base}`], true);
  const sha = ls.code === 0 ? ls.stdout.trim().split(/\s+/)[0] ?? '' : '';
  return FULL_SHA.test(sha) ? sha : null;
}

/** Fetches origin's base into refs/remotes/origin/<base> (never moves the local base branch). */
export async function fetchBase(git: GitFn, repo: string, remote: string, base: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const f = await git(repo, ['fetch', '--no-tags', remote, `+refs/heads/${base}:refs/remotes/origin/${base}`], true);
  return f.code === 0 ? { ok: true } : { ok: false, message: `fetching ${base} from origin failed: ${tail(f.stderr) || `git exit ${f.code}`}` };
}

/**
 * Follows base-update links from `head` back to a head with reviewer evidence, verifying every link from
 * git objects. Never throws; the result is passed to the pure merge gate, which accepts it only when the
 * chain is contiguous, at most MAX_BASE_UPDATE_CHAIN long, every check holds and it ends at evidence.
 */
export async function deriveApproval(o: {
  git: GitFn; repo: string; db: RuntimeDb; taskId: string; head: string; configRevision: number;
  serverBase: string | null; isReviewed: (head: string) => boolean; maxChain?: number;
}): Promise<DerivedApproval> {
  const max = o.maxChain ?? MAX_BASE_UPDATE_CHAIN;
  const out: DerivedApproval = { head: o.head, reviewedHead: null, links: [], serverBase: o.serverBase, problems: [] };
  let cur = o.head;
  for (;;) {
    if (o.isReviewed(cur)) { if (out.links.length) out.reviewedHead = cur; break; }
    if (out.links.length >= max) { out.problems.push(`more than ${max} base updates since the last review`); break; }
    const record = o.db.evidenceFor(o.taskId, cur, BASE_UPDATE_KIND).at(-1);
    if (!record && !out.links.length) { out.problems.push(`no base-update record for ${cur.slice(0, 12)}`); break; }
    const link = await verifyLink(o.git, o.repo, cur, record, { serverBase: o.serverBase, configRevision: o.configRevision });
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
