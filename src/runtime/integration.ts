// Local integration engine (design: docs/design/local-auto-integration.md, "Where the merge runs" and
// "Landing on main"; phase 1, task-82.1). A library only: nothing in record, the scheduler or the CLI calls
// it yet (the queue, lock and verify runner are phase 2).
//
// - integrationCandidate(B, H): the merge commit C of the base B and the approved head H, built as an object
//   only (`git merge-tree --write-tree B H`, then `git commit-tree <tree> -p B -p H`) in the isolated git dir
//   of isolated-git.ts (withIsolatedRepo, MERGE_TREE_CONFIG, refusal of custom and union merge drivers). No ref
//   and no checkout ever holds a half merge. A conflict returns the conflicted paths.
// - integrationChangedPaths(B, C): the paths of B..C (isolated, no rename detection, so both sides of a
//   rename count) and those matching sensitivePaths.
// - revertOfRevertCheck: B contains a revert of an earlier landed candidate of this task and neither H nor B
//   reverts that revert -> refused. The runtime never reverts the base by itself.
// - land(C, B): moves the base only as a fast-forward from exactly B. Where the base branch is checked out:
//   a dirty checkout (staged or unstaged changes to tracked files) is refused, then `git merge --ff-only C`
//   (hardened, allowlisted environment; git itself refuses when untracked files would be overwritten).
//   Elsewhere: `git update-ref refs/heads/<base> C B` (compare-and-swap). A refusal leaves the base unchanged.
import type { MinionsConfig } from '../config/schema.js';
import { matchesAny } from '../config/capabilities.js';
import type { RunResult } from '../core/exec.js';
import { cfgArgs, FULL_SHA, isolatedCommitTree, isolatedMergeTree, tail, withEmptyHome, withIsolatedRepo, type IsolatedRepo } from './isolated-git.js';
import { allowlistedGit, filterOverrides, gateGit, hardenedGitArgs } from './git-hardening.js';
import { parseWorktreeList } from './worktree.js';

export const INTEGRATION_TRAILER_TASK = 'Minions-Task';
export const INTEGRATION_TRAILER_HEAD = 'Minions-Approved-Head';

const errText = (e: unknown) => tail(String((e as Error)?.message ?? e));
// Control characters would let a branch or task id inject trailers or extra message lines.
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The message of an integration merge commit: the subject `Merge branch '<branch>'` (as a manual merge of the
 * agent branch) and the trailers Minions-Task and Minions-Approved-Head. Throws on control characters.
 */
export function integrationMessage(o: { branch: string; taskId: string; head: string }): string {
  for (const [k, v] of Object.entries(o)) {
    if (!v || CONTROL.test(v)) throw new Error(`integration message: invalid ${k} ${JSON.stringify(v)}`);
  }
  if (!FULL_SHA.test(o.head)) throw new Error(`integration message: the approved head must be a full SHA, not ${JSON.stringify(o.head)}`);
  return `Merge branch '${o.branch}'\n\n${INTEGRATION_TRAILER_TASK}: ${o.taskId}\n${INTEGRATION_TRAILER_HEAD}: ${o.head}\n`;
}

export interface CandidateInput {
  /** B: the base commit (refs/heads/<base> as the caller read it). Full SHA. */
  base: string;
  /** H: the approved head. Full SHA. */
  head: string;
  /** The task's branch, for the subject (agent/<slug>). */
  branch: string;
  taskId: string;
  identity: MinionsConfig['git']['identity'];
}

export type CandidateResult =
  /** C = commit-tree(merge-tree(B, H)) with parents (B, H); it exists only as an object. */
  | { state: 'clean'; candidate: string; tree: string; base: string; head: string }
  /** H is already contained in B: nothing to merge. */
  | { state: 'already-merged'; base: string; head: string }
  | { state: 'conflict'; files: string[]; base: string; head: string }
  /** A custom or union merge driver applies (never treated as clean). */
  | { state: 'refused'; message: string; base: string; head: string }
  | { state: 'error'; message: string; base: string; head: string };

async function isCommit(iso: IsolatedRepo, sha: string): Promise<boolean> {
  return (await iso.git(iso.dir, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], true)).code === 0;
}
async function isAncestor(iso: IsolatedRepo, a: string, b: string): Promise<boolean | null> {
  const r = await iso.git(iso.dir, ['merge-base', '--is-ancestor', a, b], true);
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/**
 * Builds the integration candidate C of base B and approved head H in an isolated git dir (see the header).
 * Never throws; every failure is a result state.
 */
export async function integrationCandidate(repo: string, o: CandidateInput, opts: { signal?: AbortSignal } = {}): Promise<CandidateResult> {
  const ids = { base: o.base, head: o.head };
  let message: string;
  try { message = integrationMessage({ branch: o.branch, taskId: o.taskId, head: o.head }); } catch (e) { return { state: 'error', message: errText(e), ...ids }; }
  if (!FULL_SHA.test(o.base)) return { state: 'error', message: `the base must be a full SHA, not ${JSON.stringify(o.base)}`, ...ids };
  try {
    return await withIsolatedRepo(repo, async (iso): Promise<CandidateResult> => {
      for (const [k, sha] of Object.entries(ids)) {
        if (!(await isCommit(iso, sha))) return { state: 'error', message: `the ${k} ${sha.slice(0, 12)} is not a commit in ${repo}`, ...ids };
      }
      const contained = await isAncestor(iso, o.head, o.base);
      if (contained === null) return { state: 'error', message: `cannot check whether ${o.head.slice(0, 12)} is on ${o.base.slice(0, 12)}`, ...ids };
      if (contained) return { state: 'already-merged', ...ids };
      const mt = await isolatedMergeTree(iso, o.base, o.head, 'an integration');
      if (mt.state === 'conflict') return { state: 'conflict', files: mt.files, ...ids };
      if (mt.state !== 'clean') return { state: mt.state, message: mt.message, ...ids };
      const c = await isolatedCommitTree(iso, { tree: mt.tree, parents: [o.base, o.head], message, identity: o.identity });
      if ('error' in c) return { state: 'error', message: c.error, ...ids };
      return { state: 'clean', candidate: c.sha, tree: mt.tree, ...ids };
    }, opts);
  } catch (e) {
    return { state: 'error', message: `the integration candidate was not built: ${errText(e)}`, ...ids };
  }
}

export type ChangedPathsResult = { ok: true; changed: string[]; sensitive: string[] } | { ok: false; message: string };

/** The paths B..C changes (isolated diff, renames off) and the ones matching `sensitivePaths`. Never throws. */
export async function integrationChangedPaths(repo: string, base: string, candidate: string, sensitivePaths: string[], opts: { signal?: AbortSignal } = {}): Promise<ChangedPathsResult> {
  try {
    const r = await withIsolatedRepo(repo, (iso) => iso.git(iso.dir, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, candidate, '--'], true), opts);
    if (r.code !== 0) return { ok: false, message: `git diff ${base.slice(0, 12)}..${candidate.slice(0, 12)} failed: ${tail(r.stderr) || `exit ${r.code}`}` };
    const changed = [...new Set(r.stdout.split('\0').filter(Boolean))];
    return { ok: true, changed, sensitive: changed.filter((p) => matchesAny(p, sensitivePaths)) };
  } catch (e) {
    return { ok: false, message: `the changed paths were not read: ${errText(e)}` };
  }
}

export type RevertCheckResult =
  | { state: 'ok' }
  /** `revert` (on the base) reverts the earlier landed candidate `reverted`, and H does not revert `revert`. */
  | { state: 'refused'; revert: string; reverted: string; message: string }
  | { state: 'error'; message: string };

/** Commits reachable from `revs` whose message contains `This reverts commit <sha>`. */
async function revertsOf(iso: IsolatedRepo, sha: string, revs: string[]): Promise<string[] | null> {
  const r = await iso.git(iso.dir, ['log', '--no-show-signature', '--format=%H', '--fixed-strings', `--grep=This reverts commit ${sha}`, ...revs, '--'], true);
  return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter((l) => FULL_SHA.test(l)) : null;
}

/**
 * The revert-of-revert check. `landed` are the earlier landed candidates of this task (C_prev from the
 * integrations record). When the base contains a revert R of one of them, H (or the base itself) must contain
 * a revert of R; otherwise the merge would not bring the reverted changes back (they are already in the
 * base's history) while the task looks integrated, so the integration is refused. Never throws.
 */
export async function revertOfRevertCheck(repo: string, o: { base: string; head: string; landed: string[] }, opts: { signal?: AbortSignal } = {}): Promise<RevertCheckResult> {
  const prev = [...new Set(o.landed)].filter((s) => FULL_SHA.test(s));
  if (!prev.length) return { state: 'ok' };
  try {
    return await withIsolatedRepo(repo, async (iso): Promise<RevertCheckResult> => {
      for (const c of prev) {
        const reverts = await revertsOf(iso, c, [o.base]);
        if (!reverts) return { state: 'error', message: `cannot search ${o.base.slice(0, 12)} for reverts of ${c.slice(0, 12)}` };
        for (const r of reverts) {
          const undone = await revertsOf(iso, r, [o.head, o.base]);
          if (!undone) return { state: 'error', message: `cannot search ${o.head.slice(0, 12)} for a revert of ${r.slice(0, 12)}` };
          if (!undone.length) {
            return { state: 'refused', revert: r, reverted: c,
              message: `${r.slice(0, 12)} on the base reverts the earlier integration ${c.slice(0, 12)} of this task; revert ${r} on the branch first` };
          }
        }
      }
      return { state: 'ok' };
    }, opts);
  } catch (e) {
    return { state: 'error', message: `the revert check was not run: ${errText(e)}` };
  }
}

// ---------------------------------------------------------------- landing

export type LandResult =
  | { state: 'landed'; method: 'merge --ff-only' | 'update-ref'; checkout: string | null; from: string; to: string }
  /** The base is not B any more (moved, deleted or unreadable as a commit): nothing was changed. */
  | { state: 'moved'; expected: string; current: string | null }
  /** The checkout of the base has staged or unstaged changes to tracked files: nothing was changed. */
  | { state: 'dirty'; checkout: string; paths: string[] }
  /** git refused the fast-forward (for example untracked files would be overwritten): the base is unchanged. */
  | { state: 'refused'; checkout: string; message: string }
  /** C is not a fast-forward of B, or git failed. `baseUnchanged` reports what was read afterwards. */
  | { state: 'error'; message: string; baseUnchanged: boolean };

/** `-c` options of the checkout calls on top of hardenedGitArgs: no replace refs, commit graph, hooks or fsmonitor. */
const CHECKOUT_CONFIG = [
  'core.useReplaceRefs=false', 'core.commitGraph=false', 'core.untrackedCache=false', 'core.fsmonitor=false', 'core.hooksPath=/dev/null',
  'core.attributesFile=/dev/null', 'merge.verifySignatures=false', 'merge.autoStash=false', 'commit.gpgSign=false',
];
/** `-c` options of the compare-and-swap in the repository (no reference-transaction hook). */
const REF_CONFIG = ['core.hooksPath=/dev/null', 'core.useReplaceRefs=false', 'core.fsmonitor=false'];

/**
 * One git call in the checkout `path` with the allowlisted environment (empty HOME, no global or system
 * config), the hardened `-c` options, an explicit work tree and every filter driver of the repository
 * config emptied (read right before, as hardenedGit does).
 */
export async function checkoutGit(path: string, args: string[], home: string): Promise<RunResult> {
  const lead = [...hardenedGitArgs().slice(0, -1), ...cfgArgs(CHECKOUT_CONFIG), `--work-tree=${path}`, '--no-pager'];
  const list = await allowlistedGit(path, [...lead, 'config', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'], true, { home });
  if (list.code !== 0 && list.code !== 1) return list;
  let filters: string[];
  try { filters = filterOverrides(list.stdout); } catch (e) { return { code: 128, stdout: '', stderr: String((e as Error)?.message ?? e) }; }
  return allowlistedGit(path, [...lead.slice(0, -1), ...filters, '--no-pager', ...args], true, { home });
}

/**
 * The paths of `git status --porcelain=v1 -z`: `XY path` entries, where a rename or copy (X or Y is R or C) is
 * followed by its source path as a separate entry, which is a whole path (no status prefix).
 */
export function porcelainPaths(stdout: string): string[] {
  const parts = stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    out.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2)) && parts[i + 1]) out.push(parts[++i]!);
  }
  return out;
}

async function refSha(repo: string, ref: string): Promise<string | null> {
  const r = await gateGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
  return r.code === 0 && FULL_SHA.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

/**
 * Moves refs/heads/<baseBranch> from exactly `base` (B) to `candidate` (C), only as a fast-forward (see the
 * header). Never throws; every refusal leaves the base unchanged.
 */
export async function land(repo: string, o: { candidate: string; base: string; baseBranch: string }): Promise<LandResult> {
  const ref = `refs/heads/${o.baseBranch}`;
  const unchanged = async () => (await refSha(repo, ref)) === o.base;
  try {
    if (!FULL_SHA.test(o.candidate) || !FULL_SHA.test(o.base)) return { state: 'error', message: 'land needs full SHAs for the candidate and the base', baseUnchanged: await unchanged() };
    const ff = await withIsolatedRepo(repo, async (iso) => (await isCommit(iso, o.candidate)) && (await isAncestor(iso, o.base, o.candidate)) === true);
    if (!ff) return { state: 'error', message: `${o.candidate.slice(0, 12)} is not a commit that descends from ${o.base.slice(0, 12)}; only a fast-forward lands`, baseUnchanged: await unchanged() };
    const current = await refSha(repo, ref);
    if (current !== o.base) return { state: 'moved', expected: o.base, current };
    const wl = await gateGit(repo, ['worktree', 'list', '--porcelain'], true);
    if (wl.code !== 0) return { state: 'error', message: `git worktree list failed: ${tail(wl.stderr) || `exit ${wl.code}`}`, baseUnchanged: true };
    const wt = parseWorktreeList(wl.stdout).find((w) => w.branch === o.baseBranch && !w.detached);
    return await withEmptyHome(async (home): Promise<LandResult> => {
      if (!wt) {
        const r = await allowlistedGit(repo, [...cfgArgs(REF_CONFIG), 'update-ref', '-m', `minions: integrate ${o.candidate.slice(0, 12)}`, ref, o.candidate, o.base], true, { home });
        if (r.code === 0) return { state: 'landed', method: 'update-ref', checkout: null, from: o.base, to: o.candidate };
        const now = await refSha(repo, ref);
        return now !== o.base ? { state: 'moved', expected: o.base, current: now } : { state: 'error', message: `git update-ref failed: ${tail(r.stderr) || `exit ${r.code}`}`, baseUnchanged: true };
      }
      const st = await checkoutGit(wt.path, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none'], home);
      if (st.code !== 0) return { state: 'error', message: `git status in ${wt.path} failed: ${tail(st.stderr) || `exit ${st.code}`}`, baseUnchanged: true };
      const paths = porcelainPaths(st.stdout);
      if (paths.length) return { state: 'dirty', checkout: wt.path, paths };
      // Re-read right before the fast-forward (the window is one git call).
      if ((await refSha(repo, ref)) !== o.base) return { state: 'moved', expected: o.base, current: await refSha(repo, ref) };
      const m = await checkoutGit(wt.path, ['merge', '--ff-only', '--quiet', '--no-stat', '--no-verify', o.candidate], home);
      const now = await refSha(repo, ref);
      if (m.code === 0 && now === o.candidate) return { state: 'landed', method: 'merge --ff-only', checkout: wt.path, from: o.base, to: o.candidate };
      if (now === o.base) return { state: 'refused', checkout: wt.path, message: `git merge --ff-only refused in ${wt.path}: ${tail(m.stderr || m.stdout) || `exit ${m.code}`}` };
      return { state: 'error', message: `after git merge --ff-only in ${wt.path} the base is ${now?.slice(0, 12) ?? '(none)'}: ${tail(m.stderr || m.stdout) || `exit ${m.code}`}`, baseUnchanged: false };
    });
  } catch (e) {
    return { state: 'error', message: `land failed: ${errText(e)}`, baseUnchanged: await unchanged().catch(() => false) };
  }
}
