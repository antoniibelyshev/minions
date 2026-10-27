// Pre-claim base sync for GitHub delivery (decision record: docs/design/bootstrap.md,
// "origin/<base> as the single source of truth").
//
// - Before every claim origin's <base> is read from the server and verified (publish.ts verifiedGateBase:
//   an isolated ls-remote of minions' recorded https URL, cross-checked with the GitHub API, then an
//   isolated fetch of that commit when it is missing), refs/remotes/origin/<base> is pointed at it, and the
//   local <base> moves forward to it: `merge --ff-only` where <base> is checked out, else
//   `update-ref <ref> <new> <old>`. Never a merge commit, rebase, reset or force.
// - A local <base> that is ahead of or diverged from origin/<base> (something was committed or merged
//   into it locally) blocks the claim with CONFLICT; a failed fetch blocks it with the classified
//   error. The claim never starts on a base that origin does not have.
// - Both runtimes reach the server only at that explicit URL from an isolated git dir: no url.*insteadOf,
//   remote.* or credential.* config of the agent-writable workspace changes what is read (task-71). The
//   verified commit (`to`) is the base the scheduler records for the lease (leases.base_sha), never the
//   local <base> ref, which a worker can move. gh down or a disagreement between git and the API blocks
//   the claim.
// Local delivery never calls this.
import { MinionsError } from '../core/errors.js';
import { redact } from '../core/output.js';
import type { ServerOrigin, ServerUrlFn } from './base-update.js';
import type { GitFn } from './github.js';
import { originOfRemoteUrl, realGh, verifiedGateBase, type GhFn } from './publish.js';
import { git as realGit, listWorktrees } from './worktree.js';

export interface BaseSyncResult {
  base: string;
  /** refs/remotes/origin/<base>. */
  originRef: string;
  from: string | null;
  to: string;
  action: 'up-to-date' | 'fast-forward' | 'created';
  method: 'merge --ff-only' | 'update-ref' | null;
}

const short = (sha: string | null) => sha?.slice(0, 12) ?? '(none)';
const tail = (s: string) => redact(s.trim()).split('\n').slice(-3).join(' ').slice(0, 500);

export interface BaseSyncOptions {
  git?: GitFn;
  /** gh for the GitHub API cross-check (default the PATH wrapper). */
  gh?: GhFn;
  /**
   * The repository from minions' own record (publish.ts serverOriginOf). Absent: the workspace's origin
   * URL, normalized (installs imported before the record existed); the reads still go to that explicit URL.
   */
  origin?: ServerOrigin | null;
  /** Test seam: where git reaches the origin URL (base-update.ts ServerUrlFn). */
  serverUrl?: ServerUrlFn;
}

export async function syncBaseFromOrigin(repo: string, base: string, opts: BaseSyncOptions = {}): Promise<BaseSyncResult> {
  const git = opts.git ?? realGit;
  const originRef = `refs/remotes/origin/${base}`;
  const blocked = 'The claim was blocked; nothing was merged.';

  let origin = opts.origin;
  let remoteUrl = '';
  if (origin === undefined) {
    const url = await git(repo, ['config', '--get', 'remote.origin.url'], true);
    remoteUrl = url.code === 0 ? url.stdout.trim() : '';
    origin = originOfRemoteUrl(remoteUrl);
  }
  if (!origin) {
    throw new MinionsError('PRECONDITION', `Cannot sync ${base} before the claim: the workspace has no github.com origin remote${remoteUrl ? ' (origin is not a github.com repository)' : ''}. ${blocked}`,
      'GitHub delivery takes the base from origin: run `minions start` on the host (it records origin from the host repository) and check `minions auth github`.',
      { base, reason: 'no-origin' });
  }
  const sha = async (ref: string) => {
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const local = await sha(`refs/heads/${base}`);
  const vb = await verifiedGateBase({ repo, gh: opts.gh ?? realGh, origin, base, haves: local ? [local] : [], ...(opts.serverUrl ? { serverUrl: opts.serverUrl } : {}) });
  if (!vb.ok) {
    throw new MinionsError(vb.code === 'CONFLICT' ? 'CONFLICT' : vb.code === 'AUTH_REQUIRED' || vb.code === 'POLICY_DENIED' ? vb.code : 'NETWORK_RETRYABLE',
      `Cannot sync ${base} before the claim: origin's ${base} could not be read and verified (${vb.message}). ${blocked}`,
      'Fix the network or GitHub credential (`minions auth github` on the host), then claim again. A disagreement between git and the GitHub API means the workspace git config may be tampered with: inspect url.* / remote.* in the workspace .git/config.',
      { base, reason: 'fetch-failed' });
  }
  const to = vb.sha;
  // The remote-tracking ref follows the verified commit (only a hint for tools; nothing trusts it).
  await git(repo, ['update-ref', '-m', 'minions: verified base from origin', originRef, to], true);
  const from = local;
  if (from === to) return { base, originRef, from, to, action: 'up-to-date', method: null };
  if (!from) {
    const c = await git(repo, ['update-ref', '-m', 'minions: create base from origin', `refs/heads/${base}`, to, ''], true);
    if (c.code !== 0) throw new MinionsError('INTERNAL', `Cannot create ${base} at ${originRef}: ${tail(c.stderr)}. ${blocked}`);
    return { base, originRef, from, to, action: 'created', method: 'update-ref' };
  }
  if ((await git(repo, ['merge-base', '--is-ancestor', from, to], true)).code !== 0) {
    const count = await git(repo, ['rev-list', '--left-right', '--count', `${from}...${to}`], true);
    const [ahead = '?', behind = '?'] = count.code === 0 ? count.stdout.trim().split(/\s+/) : [];
    const state = behind === '0' ? `is ${ahead} commit(s) ahead of` : `has diverged from`;
    throw new MinionsError('CONFLICT',
      `Local ${base} (${short(from)}) ${state} origin/${base} (${short(to)}${behind !== '0' ? `; ${ahead} local, ${behind} on origin` : ''}). ` +
      `With GitHub delivery origin/${base} is the single source of truth and nothing merges into the local ${base}. ${blocked}`,
      `Land those commits on GitHub through a pull request (or drop them from the workspace ${base}), then claim again. Ask the user before discarding anything.`,
      { base, reason: behind === '0' ? 'ahead' : 'diverged', local: from, origin: to, ahead, behind });
  }
  const wt = (await listWorktrees(repo)).find((w) => w.branch === base);
  const r = wt
    ? await git(wt.path, ['merge', '--ff-only', '--quiet', to], true)
    : await git(repo, ['update-ref', '-m', 'minions: fast-forward base from origin', `refs/heads/${base}`, to, from], true);
  if (r.code !== 0) {
    throw new MinionsError('CONFLICT',
      `Cannot fast-forward ${base} ${short(from)} -> ${short(to)}${wt ? ` in ${wt.path}` : ''}: ${tail(r.stderr || r.stdout) || `git exit ${r.code}`}. ${blocked}`,
      wt ? `Clean the ${base} checkout at ${wt.path} (it must not carry local changes), then claim again.` : 'Check the workspace repository, then claim again.',
      { base, reason: 'fast-forward-failed', local: from, origin: to });
  }
  return { base, originRef, from, to, action: 'fast-forward', method: wt ? 'merge --ff-only' : 'update-ref' };
}
