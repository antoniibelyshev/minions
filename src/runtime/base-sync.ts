// Pre-claim base sync for GitHub delivery (decision record: docs/design/bootstrap.md,
// "origin/<base> as the single source of truth").
//
// - Before every claim the workspace fetches <base> from origin into refs/remotes/origin/<base>, then
//   moves the local <base> forward to it: `merge --ff-only` where <base> is checked out, else
//   `update-ref <ref> <new> <old>`. Never a merge commit, rebase, reset or force.
// - A local <base> that is ahead of or diverged from origin/<base> (something was committed or merged
//   into it locally) blocks the claim with CONFLICT; a failed fetch blocks it with the classified
//   error. The claim never starts on a base that origin does not have.
// - The host runtime fetches from the normalized https URL (never through agent-writable remote
//   settings), as configureOrigin and publishTask do.
// Local delivery never calls this.
import { MinionsError } from '../core/errors.js';
import { redact } from '../core/output.js';
import { isHostRuntime } from './git-hardening.js';
import { normalizeGithubRemote, type GitFn } from './github.js';
import { classifyFailure } from './publish.js';
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

export async function syncBaseFromOrigin(repo: string, base: string, opts: { git?: GitFn } = {}): Promise<BaseSyncResult> {
  const git = opts.git ?? realGit;
  const originRef = `refs/remotes/origin/${base}`;
  const blocked = 'The claim was blocked; nothing was merged.';

  const url = await git(repo, ['config', '--get', 'remote.origin.url'], true);
  const remoteUrl = url.code === 0 ? url.stdout.trim() : '';
  const https = normalizeGithubRemote(remoteUrl);
  if (!https) {
    throw new MinionsError('PRECONDITION', `Cannot sync ${base} before the claim: the workspace has no github.com origin remote${remoteUrl ? ' (origin is not a github.com repository)' : ''}. ${blocked}`,
      'GitHub delivery takes the base from origin: run `minions start` on the host (it records origin from the host repository) and check `minions auth github`.',
      { base, reason: 'no-origin' });
  }
  const f = await git(repo, ['fetch', '--no-tags', isHostRuntime() ? https : 'origin', `+refs/heads/${base}:${originRef}`], true);
  if (f.code !== 0) {
    const code = classifyFailure(f.stderr);
    throw new MinionsError(code === 'INTERNAL' ? 'NETWORK_RETRYABLE' : code,
      `Cannot sync ${base} before the claim: fetching ${base} from origin failed: ${tail(f.stderr) || `git exit ${f.code}`}. ${blocked}`,
      'Fix the network or GitHub credential (`minions auth github` on the host), then claim again.', { base, reason: 'fetch-failed' });
  }
  const sha = async (ref: string) => {
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const to = await sha(originRef);
  if (!to) throw new MinionsError('INTERNAL', `Fetched ${base} from origin but ${originRef} does not resolve. ${blocked}`);
  const from = await sha(`refs/heads/${base}`);
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
