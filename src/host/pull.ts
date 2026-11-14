// `minions pull` (docs/design/autonomy.md Decision 13): the agents' branches into refs/remotes/minions/* (exportRepo, with
// minions/task-<id> for delivered and landed tasks), then the user's base branch fast-forwarded to minions/<base> when that
// is a plain fast-forward of a clean checkout that has the base checked out. Anything else is reported and left alone:
// never a merge commit, reset, checkout, stash or update of a branch that is not checked out.
//
// Clean means no tracked change (modified, staged, deleted, conflicted). Untracked files (for example the owner's own
// `.minions/` in a shared install) do not block, as they do not block `git merge --ff-only`, unless the incoming range
// adds a path one of them occupies (untrackedInTheWay): then nothing moves and the path is named. Git would refuse that
// merge too (and would overwrite an ignored file silently: that case is refused here as well).
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../core/exec.js';
import { run } from '../core/exec.js';
import { HOST_GIT } from './discovery.js';
import type { Runner } from './docker.js';

export interface FfFacts {
  base: string;
  /** The checkout's current branch (null: detached HEAD). */
  current: string | null;
  /** Uncommitted tracked entries in the checkout (modified, staged, deleted); untracked files do not count. */
  dirty: number;
  /** Paths the incoming range adds that an untracked (or ignored) file of the checkout occupies (absent: none). */
  inTheWay?: string[];
  /** The local base branch and minions/<base> (null: missing). */
  from: string | null;
  to: string | null;
  /** Whether `from` is an ancestor of `to`, and the reverse. */
  canFastForward: boolean;
  contains: boolean;
}

export type FfAction = 'fast-forward' | 'up-to-date' | 'skipped';
export interface FfDecision { action: FfAction; reason: string }

const short = (sha: string | null) => sha?.slice(0, 12) ?? '(none)';

/** Whether to fast-forward the base, and why (or why not). Pure. */
export function ffDecision(f: FfFacts): FfDecision {
  const target = `minions/${f.base}`;
  if (!f.to) return { action: 'skipped', reason: `the agents have no ${f.base} branch (${target} missing)` };
  if (!f.from) return { action: 'skipped', reason: `no local ${f.base} branch` };
  if (f.from === f.to) return { action: 'up-to-date', reason: `${f.base} is at ${target} (${short(f.to)})` };
  if (f.contains) return { action: 'up-to-date', reason: `${f.base} (${short(f.from)}) already contains ${target}` };
  if (!f.canFastForward) return { action: 'skipped', reason: `${f.base} and ${target} have diverged: merge it yourself (git merge ${target})` };
  if (f.current !== f.base) return { action: 'skipped', reason: `the checkout is on ${f.current ?? 'a detached HEAD'}, not ${f.base}: git switch ${f.base} && git merge --ff-only ${target}` };
  if (f.dirty) return { action: 'skipped', reason: `the working tree has ${f.dirty} uncommitted change(s) to tracked files: commit or stash, then git merge --ff-only ${target}` };
  if (f.inTheWay?.length) return { action: 'skipped', reason: `${target} adds ${inTheWayList(f.inTheWay)}, which an untracked file in the checkout occupies: move it away, then git merge --ff-only ${target}` };
  return { action: 'fast-forward', reason: `${f.base} ${short(f.from)} -> ${short(f.to)}` };
}

/** `a, b, c` (the first five, then a count). */
export const inTheWayList = (paths: string[]): string => `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`;

/** Tracked changes only: `git status --porcelain --untracked-files=no` (untracked files never block a fast-forward by themselves). */
export const TRACKED_STATUS = ['status', '--porcelain', '--untracked-files=no'];

/**
 * Paths the range `from..to` adds that already exist in the working tree `dir` and are not tracked at `from`: an
 * untracked or ignored file (or directory) at an added path, or an untracked file where an added path needs a
 * directory. A fast-forward would have to overwrite them. Unreadable diff: [] (the merge itself still refuses).
 */
export async function untrackedInTheWay(git: (args: string[]) => Promise<RunResult>, dir: string, from: string, to: string): Promise<string[]> {
  const d = await git(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', from, to]);
  if (d.code !== 0) return [];
  const exists = (p: string) => { try { return lstatSync(join(dir, p)); } catch { return null; } };
  const hits = new Set<string>();
  for (const path of d.stdout.split('\0').filter(Boolean)) {
    if (exists(path)) { hits.add(path); continue; }
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const st = exists(parent);
      if (!st) break;
      if (st.isDirectory()) continue;
      // A file where the range needs a directory: an obstacle unless it is tracked at `from` (the range replaces it).
      if ((await git(['cat-file', '-e', `${from}:${parent}`])).code !== 0) hits.add(parent);
      break;
    }
  }
  return [...hits].sort();
}

export interface FfResult extends FfDecision { base: string; from: string | null; to: string | null; applied: boolean }

/** Reads the facts in `repo`, decides, and runs `git merge --ff-only` when it fast-forwards. */
export async function fastForwardBase(repo: string, base: string, runner: Runner = run): Promise<FfResult> {
  const git = (args: string[]) => runner('git', [...HOST_GIT, ...args], { cwd: repo, allowFailure: true, timeoutMs: 120_000 });
  const sha = async (ref: string) => { const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return r.code === 0 ? r.stdout.trim() : null; };
  const ancestor = async (a: string, b: string) => (await git(['merge-base', '--is-ancestor', a, b])).code === 0;
  const from = await sha(`refs/heads/${base}`);
  const to = await sha(`refs/remotes/minions/${base}`);
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const status = await git(TRACKED_STATUS);
  const facts: FfFacts = {
    base, from, to, current: head.code === 0 ? head.stdout.trim() : null,
    // An unreadable status counts as dirty: never move a tree we could not check.
    dirty: status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : 1,
    canFastForward: !!from && !!to && from !== to && await ancestor(from, to),
    contains: !!from && !!to && from !== to && await ancestor(to, from),
  };
  let d = ffDecision(facts);
  if (d.action === 'fast-forward') {
    const top = await git(['rev-parse', '--show-toplevel']);
    const inTheWay = await untrackedInTheWay(git, top.code === 0 ? top.stdout.trim() : repo, from!, to!);
    if (inTheWay.length) d = ffDecision({ ...facts, inTheWay });
  }
  if (d.action !== 'fast-forward') return { ...d, base, from, to, applied: false };
  const r = await git(['merge', '--ff-only', '--no-edit', to!]);
  if (r.code !== 0) return { action: 'skipped', reason: `git merge --ff-only failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, base, from, to, applied: false };
  return { ...d, base, from, to, applied: true };
}
