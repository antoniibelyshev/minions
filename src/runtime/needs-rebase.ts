// Needs-rebase stage (decision record: docs/design/bootstrap.md, "Needs-rebase stage"; design:
// docs/design/unattended-delivery.md decision 6, task-68.4).
//
// - A delivered PR that conflicts with its base (GitHub DIRTY / CONFLICTING, confirmed by an isolated
//   merge-tree after a fresh fetch, pr-scan.ts) gets a repair round instead of hanging: auto-merge disarmed
//   (by the scan), the label `minions:needs-rebase`, delivered -> changes-requested, the stage position at
//   the repair target (the first producer). Not a new status: changes-requested already routes to the
//   engineer and counts as in-flight capacity. `work next` sorts labelled tasks before every other candidate.
// - The round is recorded as `needs-rebase` evidence on the conflicting head {head, base, baseBranch, files,
//   prUrl, round}; it is not a repair cycle (repairs are not incremented). execution.maxRebaseCycles (default
//   2) caps the rounds per task: the next conflict goes to awaiting-human with a question (outbox kind
//   `question`; task-68.5 holds questions for the digest).
// - Briefs: every stage of a labelled task gets `rebase` {previousHead, base, conflictFiles, guidance}; the
//   engineer is told to merge the base into the branch (never rebase or force-push: the PR is reused and
//   publication pushes fast-forward only). The reviewer also gets the resolution diff: `git diff
//   <merge-tree with conflict markers> <new head>`, i.e. exactly the hand-resolved lines.
// - The label is removed when the task is delivered again (publication reuses the open PR, findPr).
import type { MinionsConfig } from '../config/schema.js';
import type { Task } from '../backlog/types.js';
import { redact } from '../core/output.js';
import { mergeTree, withIsolatedRepo, type CleanGitOptions } from './base-update.js';
import type { EvidenceRow, RuntimeDb } from './db.js';

export const NEEDS_REBASE_LABEL = 'minions:needs-rebase';
export const NEEDS_REBASE_KIND = 'needs-rebase';
export const DEFAULT_MAX_REBASE_CYCLES = 2;
/** The resolution diff in a reviewer brief is cut at this size (the reviewer reads the rest in the worktree). */
export const RESOLUTION_DIFF_MAX_BYTES = 64 * 1024;

export const maxRebaseCyclesOf = (cfg: MinionsConfig): number => cfg.execution.maxRebaseCycles ?? DEFAULT_MAX_REBASE_CYCLES;
export const needsRebase = (task: Pick<Task, 'labels'>): boolean => task.labels.includes(NEEDS_REBASE_LABEL);

/** One recorded conflict round (`needs-rebase` evidence details). */
export interface RebaseRound {
  head: string; base: string; baseBranch: string; files: string[]; prUrl: string | null; round: number;
  findings: string[]; nextAction: string;
}

/** What a brief of a labelled task carries (TaskBrief.rebase). */
export interface RebaseBrief {
  /** The approved head that conflicted (the PR head before this round). */
  previousHead: string;
  /** The base commit it conflicted with, and the base branch. */
  base: string; baseBranch: string;
  conflictFiles: string[];
  prUrl: string | null;
  round: number; maxRounds: number;
  guidance: string;
  /** Reviewer only: `git diff <merge-tree with conflict markers> <head>`; null with `resolutionDiffError` when it cannot be computed. */
  resolutionDiff?: string | null;
  resolutionDiffTruncated?: boolean;
  resolutionDiffError?: string;
}

export function parseRound(row: Pick<EvidenceRow, 'details_json'>): RebaseRound | null {
  try {
    const v = JSON.parse(row.details_json ?? '') as Partial<RebaseRound>;
    if (typeof v.head !== 'string' || typeof v.base !== 'string' || !Array.isArray(v.files)) return null;
    return {
      head: v.head, base: v.base, baseBranch: String(v.baseBranch ?? ''), files: v.files.filter((f): f is string => typeof f === 'string'),
      prUrl: typeof v.prUrl === 'string' ? v.prUrl : null, round: Number(v.round ?? 0),
      findings: Array.isArray(v.findings) ? v.findings.filter((f): f is string => typeof f === 'string') : [], nextAction: String(v.nextAction ?? ''),
    };
  } catch { return null; }
}

/** Needs-rebase rounds started for a task (each conflict sent to the engineer; the limit is not one). */
export function rebaseRounds(db: RuntimeDb, taskId: string): number {
  return db.evidenceOfKind(taskId, NEEDS_REBASE_KIND).filter((e) => e.outcome === 'changes-requested').length;
}

/** The latest round sent to the engineer, with its evidence row. */
export function latestRound(db: RuntimeDb, taskId: string): { row: EvidenceRow; round: RebaseRound } | null {
  const row = db.evidenceOfKind(taskId, NEEDS_REBASE_KIND).filter((e) => e.outcome === 'changes-requested').at(-1);
  const round = row ? parseRound(row) : null;
  return row && round ? { row, round } : null;
}

const list = (files: string[]) => `${files.slice(0, 10).join(', ')}${files.length > 10 ? `, … (${files.length} files)` : ''}`;

/** The findings and next action of a round (priorFindings of the engineer brief, and the backlog note). */
export function roundText(c: { head: string; base: string; baseBranch: string; files: string[]; prUrl: string | null }): { findings: string[]; nextAction: string; guidance: string } {
  const b = c.baseBranch;
  const guidance = `Merge ${b} into the branch (\`git merge ${b}\`; the claim synced the local ${b} with origin, or \`git fetch origin ${b} && git merge FETCH_HEAD\`), resolve the conflicts keeping both sides' intent, run the verification, and commit the merge. Never rebase, amend or force-push: the PR${c.prUrl ? ` ${c.prUrl}` : ''} is reused and publication pushes fast-forward only, so the result must contain ${c.head.slice(0, 12)}.`;
  return {
    findings: [
      `conflicts with ${b} at ${c.base.slice(0, 12)} in ${list(c.files)}; merge origin/${b} into the branch, resolve, never rebase or force-push`,
    ],
    nextAction: `Merge ${b} into the branch on top of ${c.head.slice(0, 12)}, resolve ${list(c.files)}, verify and commit; the PR is reused.`,
    guidance,
  };
}

export function rebaseBrief(round: RebaseRound, cfg: MinionsConfig): RebaseBrief {
  return {
    previousHead: round.head, base: round.base, baseBranch: round.baseBranch || cfg.git.baseBranch, conflictFiles: [...round.files], prUrl: round.prUrl,
    round: round.round, maxRounds: maxRebaseCyclesOf(cfg), guidance: roundText({ ...round, baseBranch: round.baseBranch || cfg.git.baseBranch }).guidance,
  };
}

const tail = (s: string) => redact(s.trim().split('\n').slice(-3).join(' | ')).slice(0, 400);

/**
 * The resolution diff for the reviewer: `git diff <merge-tree with conflict markers> <head>`. The merge is the
 * newest merge commit on the ancestry path previousHead..head (its two parents re-merged, so the diff shows only
 * the hand-resolved lines and what was committed after the merge); without one, previousHead merged with the
 * recorded base. Allowlisted git in an isolated dir (base-update.ts), like the merge-tree of the scan.
 */
export async function resolutionDiff(repo: string, o: { previousHead: string; base: string; head: string }, opts: CleanGitOptions & { maxBytes?: number } = {}):
  Promise<{ diff: string; truncated: boolean; ours: string; theirs: string } | { error: string }> {
  const max = opts.maxBytes ?? RESOLUTION_DIFF_MAX_BYTES;
  try {
    const pair = await withIsolatedRepo(repo, async (iso): Promise<{ ours: string; theirs: string } | { error: string }> => {
      const merges = await iso.git(iso.dir, ['rev-list', '--merges', '--ancestry-path', `${o.previousHead}..${o.head}`, '--'], true);
      if (merges.code !== 0) return { error: `cannot list merges ${o.previousHead.slice(0, 12)}..${o.head.slice(0, 12)}: ${tail(merges.stderr) || `git exit ${merges.code}`}` };
      const m = merges.stdout.trim().split('\n').filter(Boolean)[0];
      if (!m) return { ours: o.previousHead, theirs: o.base };
      const p = await iso.git(iso.dir, ['rev-list', '--parents', '-n', '1', m, '--'], true);
      const parents = p.code === 0 ? p.stdout.trim().split(/\s+/).slice(1) : [];
      if (parents.length !== 2) return { error: `merge ${m.slice(0, 12)} does not have exactly two parents` };
      return { ours: parents[0]!, theirs: parents[1]! };
    }, opts);
    if ('error' in pair) return pair;
    const mt = await mergeTree(repo, pair.ours, pair.theirs, opts);
    if (!('tree' in mt)) return { error: mt.message };
    const tree = mt.tree;
    const d = await withIsolatedRepo(repo, (iso) => iso.git(iso.dir, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', tree, o.head, '--'], true), opts);
    if (d.code !== 0) return { error: `git diff failed: ${tail(d.stderr) || `git exit ${d.code}`}` };
    const buf = Buffer.from(d.stdout, 'utf8');
    const truncated = buf.length > max;
    return { diff: truncated ? buf.subarray(0, max).toString('utf8') : d.stdout, truncated, ours: pair.ours, theirs: pair.theirs };
  } catch (e) {
    return { error: `resolution diff not computed: ${tail(String((e as Error)?.message ?? e))}` };
  }
}
