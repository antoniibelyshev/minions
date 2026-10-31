// `minions pull` (docs/design/autonomy.md Decision 13): the agents' branches into refs/remotes/minions/* (exportRepo, with
// minions/task-<id> for delivered and landed tasks), then the user's base branch fast-forwarded to minions/<base> when that
// is a plain fast-forward of a clean checkout that has the base checked out. Anything else is reported and left alone:
// never a merge commit, reset, checkout, stash or update of a branch that is not checked out.
import { run } from '../core/exec.js';
import { HOST_GIT } from './discovery.js';
import type { Runner } from './docker.js';

export interface FfFacts {
  base: string;
  /** The checkout's current branch (null: detached HEAD). */
  current: string | null;
  /** Uncommitted or untracked entries in the checkout. */
  dirty: number;
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
  if (f.dirty) return { action: 'skipped', reason: `the working tree has ${f.dirty} uncommitted or untracked change(s): commit or stash, then git merge --ff-only ${target}` };
  return { action: 'fast-forward', reason: `${f.base} ${short(f.from)} -> ${short(f.to)}` };
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
  const status = await git(['status', '--porcelain']);
  const facts: FfFacts = {
    base, from, to, current: head.code === 0 ? head.stdout.trim() : null,
    // An unreadable status counts as dirty: never move a tree we could not check.
    dirty: status.code === 0 ? status.stdout.split('\n').filter(Boolean).length : 1,
    canFastForward: !!from && !!to && from !== to && await ancestor(from, to),
    contains: !!from && !!to && from !== to && await ancestor(to, from),
  };
  const d = ffDecision(facts);
  if (d.action !== 'fast-forward') return { ...d, base, from, to, applied: false };
  const r = await git(['merge', '--ff-only', '--no-edit', to!]);
  if (r.code !== 0) return { action: 'skipped', reason: `git merge --ff-only failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, base, from, to, applied: false };
  return { ...d, base, from, to, applied: true };
}
