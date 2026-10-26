// The per-lease repository of a process worker (docs/design/agent-runtimes.md D3.4, D3.7, D3a): a private clone
// under the lease scratch dir that borrows the shared objects read-only, a snapshot of the lease's own git files
// in the shared repository, the post-exit sanitizing of the worker-written clone, the branch rule and the
// fast-forward-only fetch-back with fsck. Every git command goes through runnerGit (git-hardening.ts).
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MinionsError } from '../../core/errors.js';
import { runnerGit, type RawRun, type RunnerGitTarget } from '../git-hardening.js';
import type { RunResult } from '../../core/exec.js';
import type { LeaseGitSnapshot, RunRole } from './record.js';

export const RUNNER_IDENTITY = { name: 'minions-runner', email: 'minions-runner@minions.invalid' } as const;

export interface RepoContext {
  leaseId: string;
  branch: string;
  claimHead: string;
  leaseWorktree: string;
  /** `<scratch>/work`. */
  checkout: string;
  /** The runner-owned git global config file (outside the scratch dir). */
  globalConfig: string;
  /** Committer identity written into the clone's config for the worker's own commits. */
  workerIdentity: { name: string; email: string };
  run?: RawRun;
  env?: NodeJS.ProcessEnv;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** O_NOFOLLOW write: a symlink (or another non-file) at `path` is removed first, never followed. */
export async function writeNoFollow(path: string, content: string, mode = 0o644): Promise<void> {
  const st = await lstat(path).catch(() => null);
  if (st && !st.isFile()) await rm(path, { recursive: true, force: true });
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, mode);
  try { await fh.writeFile(content); } finally { await fh.close(); }
}

/** Reads a regular file without following a symlink; null when absent; throws `not a regular file` otherwise. */
async function readRegular(path: string): Promise<string | null> {
  const st = await lstat(path).catch(() => null);
  if (!st) return null;
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await fh.readFile('utf8'); } finally { await fh.close(); }
}

// ------------------------------------------------------------------------------------------ lease git files

/**
 * The lease's own git files (D3.4): `<leaseWorktree>/.git`, the worktree admin dir's `gitdir`, `commondir`,
 * `config.worktree` (or its absence) and `HEAD`. Resolved without git, every pointer checked against the expected
 * shared repository. No other shared file or ref is recorded: other actors change those legitimately.
 */
export async function snapshotLeaseGit(leaseWorktree: string, expectedCommon: string, claimHead: string): Promise<LeaseGitSnapshot> {
  const fail = (why: string) => new MinionsError('PRECONDITION', `lease worktree ${leaseWorktree}: ${why}`, 'Release the lease and claim the task again (the worktree is recreated).');
  const dotGit = join(leaseWorktree, '.git');
  const pointer = await readRegular(dotGit).catch((e: Error) => { throw fail(e.message); });
  const m = pointer ? /^gitdir: (.+)\n?$/.exec(pointer) : null;
  if (!m || !isAbsolute(m[1]!)) throw fail('.git is not a linked-worktree pointer file');
  const worktreeGitDir = m[1]!;
  const st = await lstat(worktreeGitDir).catch(() => null);
  if (!st?.isDirectory()) throw fail(`${worktreeGitDir} is not a directory`);
  const names = ['gitdir', 'commondir', 'config.worktree', 'HEAD'];
  const files: Record<string, string | null> = { [dotGit]: pointer };
  for (const n of names) files[join(worktreeGitDir, n)] = await readRegular(join(worktreeGitDir, n)).catch((e: Error) => { throw fail(e.message); });
  const commondir = files[join(worktreeGitDir, 'commondir')];
  if (!commondir) throw fail('the worktree admin dir has no commondir');
  const commonDir = resolve(worktreeGitDir, commondir.trim());
  if (real(commonDir) !== real(expectedCommon)) throw fail(`its common dir ${commonDir} is not the shared repository ${expectedCommon}`);
  if (dirname(worktreeGitDir) !== join(commonDir, 'worktrees') && real(dirname(worktreeGitDir)) !== real(join(commonDir, 'worktrees'))) throw fail('the admin dir is not under <common>/worktrees');
  if ((files[join(worktreeGitDir, 'gitdir')] ?? '').trim() !== dotGit && real((files[join(worktreeGitDir, 'gitdir')] ?? '').trim()) !== real(dotGit)) throw fail('the admin dir does not point back at the worktree');
  return { commonDir, worktreeGitDir, files, claimHead };
}

/** Paths whose content or type differs from the snapshot. */
export async function diffLeaseGit(s: LeaseGitSnapshot): Promise<string[]> {
  const out: string[] = [];
  for (const [path, want] of Object.entries(s.files)) {
    let have: string | null;
    try { have = await readRegular(path); } catch { out.push(path); continue; }
    if (have !== want) out.push(path);
  }
  return out;
}

/** Restores the recorded content (O_NOFOLLOW; a symlink in its place is removed first). */
export async function restoreLeaseGit(s: LeaseGitSnapshot, paths: string[]): Promise<void> {
  for (const path of paths) {
    const want = s.files[path];
    if (want === undefined) continue;
    if (want === null) { await rm(path, { recursive: true, force: true }); continue; }
    await writeNoFollow(path, want);
  }
}

/** runnerGit `verify` for shared-side calls: the lease git files must still match the snapshot. */
const leaseGitVerifier = (s: LeaseGitSnapshot) => async () => {
  const bad = await diffLeaseGit(s);
  if (bad.length) throw new MinionsError('POLICY_DENIED', `harness-violation: lease git files changed during post-exit: ${bad.join(', ')}`);
};

export const sharedTarget = (s: LeaseGitSnapshot): RunnerGitTarget => ({ gitDir: s.commonDir, verify: leaseGitVerifier(s) });
export const leaseWorktreeTarget = (s: LeaseGitSnapshot, leaseWorktree: string): RunnerGitTarget => ({ gitDir: s.worktreeGitDir, workTree: leaseWorktree, verify: leaseGitVerifier(s) });

// ------------------------------------------------------------------------------------------------ the clone

/** The runner's config for the clone: no include/includeIf, no remotes, no hooks, no reflogs, no auto gc. */
export function cloneConfigTemplate(identity: { name: string; email: string }): string {
  const safe = (v: string, fallback: string) => (/^[^\n\r"\\[\]]{1,200}$/.test(v) && !/^\s|\s$/.test(v) ? v : fallback);
  return [
    '[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = false',
    '[gc]', '\tauto = 0',
    '[user]', `\tname = ${safe(identity.name, 'minions worker')}`, `\temail = ${safe(identity.email, 'minions-worker@minions.invalid')}`,
    '',
  ].join('\n');
}

const cloneGitDir = (checkout: string) => join(checkout, '.git');

/**
 * runnerGit `verify` for clone calls: `.git` is a real directory and its config is exactly the runner's template
 * (the runner only calls git on the clone right after writing it).
 */
const cloneVerifier = (ctx: RepoContext) => async () => {
  const w = await lstat(ctx.checkout).catch(() => null);
  const g = await lstat(cloneGitDir(ctx.checkout)).catch(() => null);
  const cfg = await readRegular(join(cloneGitDir(ctx.checkout), 'config')).catch(() => undefined);
  if (!w?.isDirectory() || !g?.isDirectory() || cfg !== cloneConfigTemplate(ctx.workerIdentity)) {
    throw new MinionsError('POLICY_DENIED', 'harness-violation: the per-lease clone changed after the runner sanitized it');
  }
};
export const cloneTarget = (ctx: RepoContext): RunnerGitTarget => ({ gitDir: cloneGitDir(ctx.checkout), workTree: ctx.checkout, verify: cloneVerifier(ctx) });

const git = (ctx: RepoContext, target: RunnerGitTarget | null, args: string[], allowFailure = false, cwd?: string): Promise<RunResult> =>
  runnerGit(target, args, allowFailure, { globalConfig: ctx.globalConfig, env: ctx.env, run: ctx.run, ...(cwd ? { cwd } : {}) });

/** Control files the runner rewrites or removes in the clone (D3.7.2). */
async function writeCloneControl(ctx: RepoContext, commonDir: string): Promise<void> {
  const gd = cloneGitDir(ctx.checkout);
  await writeNoFollow(join(gd, 'config'), cloneConfigTemplate(ctx.workerIdentity));
  await writeNoFollow(join(gd, 'HEAD'), `ref: refs/heads/${ctx.branch}\n`);
  await mkdir(join(gd, 'objects', 'info'), { recursive: true });
  await writeNoFollow(join(gd, 'objects', 'info', 'alternates'), `${join(commonDir, 'objects')}\n`);
  for (const p of ['objects/info/http-alternates', 'objects/info/commit-graph', 'objects/info/commit-graphs', 'hooks', 'info', 'commondir', 'gitdir',
    'config.worktree', 'worktrees', 'modules', 'shallow', 'FETCH_HEAD', 'MERGE_HEAD', 'ORIG_HEAD', 'index.lock', 'HEAD.lock', 'config.lock']) {
    await rm(join(gd, p), { recursive: true, force: true });
  }
}

/**
 * Creates `<scratch>/work`: `clone --shared --single-branch --no-tags --no-checkout` of the lease branch from the
 * shared repository (empty runner template, so no hooks), the control files rewritten, then the checkout. The
 * clone's branch head must be the claim head.
 */
export async function createClone(ctx: RepoContext, snap: LeaseGitSnapshot, templateDir: string): Promise<void> {
  if (await lstat(ctx.checkout).catch(() => null)) throw new MinionsError('PRECONDITION', `${ctx.checkout} already exists: the lease ran before.`);
  await mkdir(templateDir, { recursive: true, mode: 0o700 });
  await leaseGitVerifier(snap)();
  await git(ctx, null, ['clone', '--quiet', '--shared', '--single-branch', '--branch', ctx.branch, '--no-tags', '--no-checkout', `--template=${templateDir}`, snap.commonDir, ctx.checkout], false, dirname(ctx.checkout));
  await writeCloneControl(ctx, snap.commonDir);
  await git(ctx, cloneTarget(ctx), ['checkout', '--quiet', '-f', ctx.branch]);
  const head = await branchHead(ctx);
  if (head !== ctx.claimHead) {
    throw new MinionsError('PRECONDITION', `The lease branch ${ctx.branch} is at ${head ?? '(missing)'}, not at the claim head ${ctx.claimHead}.`, 'Release the lease and claim the task again.');
  }
}

async function branchHead(ctx: RepoContext): Promise<string | null> {
  const r = await git(ctx, cloneTarget(ctx), ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}^{commit}`], true);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Post-exit 7.2: `lstat` the whole `.git` tree of the clone first. `.git` must be a real directory and nothing
 * below it may be a symlink or a special file (a symlink would turn the runner's next write into a write anywhere,
 * `/state` included). Returns the violations; when there are none, the control files are rewritten.
 */
export async function sanitizeClone(ctx: RepoContext, commonDir: string): Promise<string[]> {
  const violations: string[] = [];
  const w = await lstat(ctx.checkout).catch(() => null);
  if (!w || w.isSymbolicLink() || !w.isDirectory()) return [`clone: ${ctx.checkout} is not a real directory`];
  const gd = cloneGitDir(ctx.checkout);
  const g = await lstat(gd).catch(() => null);
  if (!g || g.isSymbolicLink() || !g.isDirectory()) return [`clone: ${gd} is not a real directory (${g ? (g.isSymbolicLink() ? 'a symlink' : 'a file') : 'missing'})`];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) violations.push(`clone: symlink in the git dir: ${p}`);
      else if (e.isDirectory()) await walk(p);
      else if (!e.isFile()) violations.push(`clone: special file in the git dir: ${p}`);
      if (violations.length >= 20) return;
    }
  };
  await walk(gd);
  if (violations.length) return violations;
  await writeCloneControl(ctx, commonDir);
  return [];
}

/**
 * Post-exit 7.3: a `wip:` commit in the clone (drain, timeout, recovery) of the paths inside `edits`, authored by
 * the runner. Returns the new head, or null when there was nothing to commit.
 */
export async function wipCommit(ctx: RepoContext, role: RunRole, reason: string): Promise<string | null> {
  if (!role.commits || role.contract === 'gate' || role.edits === 'none') return null;
  const spec = role.edits === 'any' ? [] : ['--', ...role.edits.paths.map((p) => `:(glob)${p}`)];
  const t = cloneTarget(ctx);
  await git(ctx, t, ['add', '-A', ...spec]);
  const staged = await git(ctx, t, ['diff', '--cached', '--quiet'], true);
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new MinionsError('INTERNAL', `git diff --cached failed in the clone: ${staged.stderr.trim().slice(0, 200)}`);
  await runnerGit(t, ['commit', '--quiet', '-m', `wip: runner checkpoint (${reason})`], false, {
    globalConfig: ctx.globalConfig, run: ctx.run, env: ctx.env, identity: RUNNER_IDENTITY,
  });
  return branchHead(ctx);
}

export interface FetchBack { head: string; fetched: boolean; violations: string[] }

/**
 * Post-exit 7.4 and 7.5. A gate, or a role with `commits: false`, must leave the branch at the claim head and
 * nothing is fetched. Otherwise the claim head must be an ancestor of the clone's head; then the branch is fetched
 * into `refs/minions/incoming/<lease>` (fsck on), the shared branch must still be at the claim head, and the lease
 * worktree fast-forwards to it (branch and checkout together). No other ref is ever touched.
 */
export async function branchRuleAndFetch(ctx: RepoContext, snap: LeaseGitSnapshot, role: RunRole): Promise<FetchBack> {
  const stay = { head: ctx.claimHead, fetched: false };
  const head = await branchHead(ctx);
  if (!head) return { ...stay, violations: [`branch: the clone has no branch ${ctx.branch}`] };
  if (head === ctx.claimHead) return { ...stay, violations: [] };
  if (role.contract === 'gate' || !role.commits) {
    return { ...stay, violations: [`branch: a ${role.contract === 'gate' ? 'gate' : 'commits: false role'} moved ${ctx.branch} from ${ctx.claimHead} to ${head}`] };
  }
  const anc = await git(ctx, cloneTarget(ctx), ['merge-base', '--is-ancestor', ctx.claimHead, head], true);
  if (anc.code === 1) return { ...stay, violations: [`branch: ${head} is not a fast-forward of the claim head ${ctx.claimHead}`] };
  if (anc.code !== 0) return { ...stay, violations: [`branch: the ancestry check failed: ${anc.stderr.trim().slice(0, 200)}`] };
  const wtHead = snap.files[join(snap.worktreeGitDir, 'HEAD')];
  if (wtHead?.trim() !== `ref: refs/heads/${ctx.branch}`) return { ...stay, violations: [`branch: the lease worktree is not on ${ctx.branch}`] };
  const incoming = `refs/minions/incoming/${ctx.leaseId}`;
  const shared = sharedTarget(snap);
  await git(ctx, shared, ['update-ref', '-d', incoming], true);
  const f = await git(ctx, shared, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', ctx.checkout, `refs/heads/${ctx.branch}:${incoming}`], true);
  if (f.code !== 0) return { ...stay, violations: [`fetch: rejected (fsck or transfer): ${f.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`] };
  try {
    const cur = await git(ctx, shared, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.branch}`], true);
    if (cur.stdout.trim() !== ctx.claimHead) return { ...stay, violations: [`branch: ${ctx.branch} moved in the shared repository during the run (${cur.stdout.trim() || 'deleted'}); nothing fetched`] };
    const got = await git(ctx, shared, ['rev-parse', '--verify', '--quiet', `${incoming}^{commit}`], true);
    if (got.stdout.trim() !== head) return { ...stay, violations: ['fetch: the fetched head is not the clone head'] };
    const m = await git(ctx, leaseWorktreeTarget(snap, ctx.leaseWorktree), ['merge', '--quiet', '--ff-only', incoming], true);
    if (m.code !== 0) return { ...stay, violations: [`fetch: fast-forward of the lease worktree failed: ${m.stderr.trim().slice(0, 300)}`] };
  } finally {
    await git(ctx, shared, ['update-ref', '-d', incoming], true).catch(() => undefined);
  }
  return { head, fetched: true, violations: [] };
}
