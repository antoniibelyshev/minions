// Branch and pull-request delivery for the github provider (decision record: docs/design/bootstrap.md,
// "Branch and pull-request delivery").
//
// - Publication is a deterministic helper run by the runtime, never by a model: `minions work record`
//   calls it when a reviewer approval is accepted, `minions work publish <taskId>` retries it.
// - Gates: git.push (and pr.create in pull-request mode) are evaluated against the paths the branch
//   changes relative to the base: the union of diffs against the base SHAs recorded at claim time,
//   origin's base (ls-remote) and the local base refs; a movable local ref alone never suffices. `deny` fails; `ask` (including the sensitive-path upgrade
//   allow -> ask) requires a host-signed human approval for exactly the approved head SHA, verified
//   here against the runtime's read-only public key right before anything is pushed (src/core/approval.ts).
//   Approval rows in the runtime DB are only carriers of tokens: an unsigned or forged row fails closed.
// - Idempotent: the remote branch and open PRs are inspected first; an up-to-date remote branch is
//   not pushed again and an existing PR for the head branch is reused, never duplicated.
// - Never merges (opt-in auto-merge is a separate pass: src/runtime/merge.ts), never force-pushes, never passes the token anywhere (git uses the repository
//   credential helper, gh the wrapper; see src/runtime/github.ts).
import { readFile } from 'node:fs/promises';
import { can, matchesAny } from '../config/capabilities.js';
import type { Capability, MinionsConfig } from '../config/schema.js';
import type { Task } from '../backlog/types.js';
import type { ErrorCode } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';
import { verifyAnyApproval } from '../core/approval.js';
import { normalizeGithubRemote, readGithubToken, type GitFn } from './github.js';
import { isHostRuntime } from './git-hardening.js';
import { missingApprovalKeyReason, runtimePaths } from './paths.js';
import { git as realGit } from './worktree.js';

export type GhFn = (args: string[], opts?: { input?: string; cwd?: string }) => Promise<RunResult>;

/** gh via the PATH wrapper (/usr/local/bin/gh injects the mounted token for that process only). */
/** `signal` (optional) kills an in-flight gh on abort (SIGTERM, then SIGKILL), like the timeout. */
export const ghWithTimeout = (timeoutMs: number, signal?: AbortSignal): GhFn => (args, opts = {}) =>
  run('gh', args, { cwd: opts.cwd, input: opts.input, allowFailure: true, timeoutMs, signal, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });
export const realGh: GhFn = ghWithTimeout(120_000);

export interface PublishInput {
  config: MinionsConfig;
  task: Task;
  repo: string;
  branch: string;
  /** Approved head; exactly this commit is published. */
  head: string;
  /** Host-signed approval tokens recorded for this task and head (scope publish); verified, never trusted as is. */
  approvals: (string | null)[];
  /**
   * Base commits recorded in the runtime DB when this task's leases were claimed (leases.base_sha).
   * The sensitive-path gate diffs against these (and the remote's base), never only against a local
   * ref that in-runtime code can move. None usable (and no remote base available locally) fails closed.
   */
  baseShas?: (string | null)[];
  /** Public key verifying approvals (default: the runtime's read-only /opt/minions/config/approval-public-key.pem). */
  approvalPublicKeyFile?: string;
  /** Clock for approval expiry (tests). */
  now?: Date;
  git?: GitFn;
  gh?: GhFn;
  tokenFile?: string;
}

export type PublishOutcome =
  | { state: 'published'; mode: 'branch' | 'pull-request'; push: 'pushed' | 'already-current'; pr: 'created' | 'existing' | null;
      prUrl: string | null; repository: string; changedPaths: string[]; sensitivePaths: string[] }
  | { state: 'awaiting-approval'; reasons: string[]; changedPaths: string[]; sensitivePaths: string[]; approvalError: string }
  | { state: 'failed'; code: ErrorCode; message: string; retryable: boolean };

const fail = (code: ErrorCode, message: string): PublishOutcome =>
  ({ state: 'failed', code, message: redact(message), retryable: code === 'NETWORK_RETRYABLE' || code === 'AUTH_REQUIRED' || code === 'INTERNAL' });

const lastLines = (s: string) => redact(s.trim().split('\n').slice(-3).join(' | ')).slice(0, 500);

/** Maps git/gh stderr to a stable error code. */
export function classifyFailure(stderr: string): ErrorCode {
  const s = stderr.toLowerCase();
  if (/authentication failed|could not read username|invalid username or password|bad credentials|http 401|\b401\b|gh auth login|no github token/.test(s)) return 'AUTH_REQUIRED';
  if (/\b403\b|permission to .* denied|permission denied|not have permission|resource not accessible|protected branch|write access .* not granted/.test(s)) return 'POLICY_DENIED';
  if (/could not resolve host|timed out|timeout|connection (reset|refused|closed)|network is unreachable|http 5\d\d|\b50[234]\b|tls|ssl|unable to access|temporary failure/.test(s)) return 'NETWORK_RETRYABLE';
  return 'INTERNAL';
}

const META_RE = /<!-- minions:meta .*? -->/g;

/**
 * PR title and body from shared task fields only: title, objective (description), acceptance
 * criteria. Shared installations add the task id and head SHA; private installations add nothing
 * else (no ids, notes, handoffs, worker results, or decision records ever appear).
 */
export function pullRequestText(task: Pick<Task, 'id' | 'title' | 'description' | 'acceptanceCriteria'>, cfg: Pick<MinionsConfig, 'visibility'> & { delivery?: Pick<MinionsConfig['delivery'], 'merge'> }, head: string): { title: string; body: string } {
  const title = task.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 256) || 'Agent change';
  const parts: string[] = [];
  const desc = task.description.replace(META_RE, '').trim();
  if (desc) parts.push(desc);
  if (task.acceptanceCriteria.length) {
    parts.push(['## Acceptance criteria', ...task.acceptanceCriteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text.replace(/[\r\n]+/g, ' ').trim()}`)].join('\n'));
  }
  if (cfg.visibility === 'shared') {
    parts.push(cfg.delivery?.merge === 'auto-when-eligible'
      ? `---\nTask \`${task.id}\` at \`${head}\`, opened by minions. minions may enable GitHub auto-merge for this head once the required checks pass and policy allows it; GitHub branch protection still decides.`
      : `---\nTask \`${task.id}\` at \`${head}\`, opened by minions. minions never merges: review and merge through your normal process.`);
  }
  return { title, body: parts.join('\n\n') || title };
}

interface PrInfo { url: string; headRefOid: string; headRefName: string; state: string; isCrossRepository?: boolean }

async function findPr(gh: GhFn, cwd: string, repository: string, branch: string, head: string): Promise<{ pr?: PrInfo; error?: PublishOutcome }> {
  const r = await gh(['pr', 'list', '--repo', repository, '--head', branch, '--state', 'all', '--limit', '20',
    '--json', 'url,headRefOid,headRefName,state,isCrossRepository'], { cwd });
  if (r.code !== 0) return { error: fail(classifyFailure(r.stderr), `gh pr list failed: ${lastLines(r.stderr || r.stdout) || `exit ${r.code}`}`) };
  let list: PrInfo[];
  try { list = JSON.parse(r.stdout || '[]') as PrInfo[]; } catch { return { error: fail('INTERNAL', 'gh pr list returned invalid JSON') }; }
  const own = list.filter((p) => p.headRefName === branch && !p.isCrossRepository);
  // An open PR follows the branch, so it is reused whatever head it showed; a merged one only for the same head.
  const pr = own.find((p) => p.state === 'OPEN') ?? own.find((p) => p.state === 'MERGED' && p.headRefOid === head);
  return { pr };
}

/** The public key PEM, or null when absent/unreadable (verification then fails closed). */
async function readPublicKey(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); } catch { return null; }
}

const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Bases for the sensitive-path diff. `trusted`: base SHAs recorded in the runtime DB at claim time
 * and origin's current base (read with ls-remote, i.e. from the server), each only when the commit is
 * present locally. `local`: the workspace's base refs, which in-runtime code can move; they are
 * diffed too (they can only add paths) but never suffice on their own.
 */
async function gateBases(git: GitFn, repo: string, remote: string, base: string, recorded: (string | null)[]): Promise<{ trusted: string[]; local: string[] }> {
  const hasCommit = async (rev: string) => (await git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], true)).code === 0;
  const trusted: string[] = [];
  for (const sha of new Set(recorded.filter((s): s is string => !!s && FULL_SHA_RE.test(s)))) {
    if (await hasCommit(sha)) trusted.push(sha);
  }
  const ls = await git(repo, ['ls-remote', '--heads', remote, `refs/heads/${base}`], true);
  const remoteBase = ls.code === 0 ? ls.stdout.trim().split(/\s+/)[0] ?? '' : '';
  if (FULL_SHA_RE.test(remoteBase) && await hasCommit(remoteBase)) trusted.push(remoteBase);
  const local: string[] = [];
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`, `refs/remotes/host/${base}`]) {
    if (await hasCommit(ref)) local.push(ref);
  }
  return { trusted, local };
}

const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

/** origin as a github.com repository: the normalized URL, `owner/repo`, and the remote name git should use. */
export async function githubOrigin(git: GitFn, repo: string): Promise<{ https: string; repository: string; remote: string } | null> {
  const o = await git(repo, ['config', '--get', 'remote.origin.url'], true);
  const https = o.code === 0 ? normalizeGithubRemote(o.stdout.trim()) : null;
  if (!https) return null;
  // The host runtime names the normalized https URL instead of the agent-writable `origin` remote
  // (no pushurl / receivepack from the workspace).
  return { https, repository: https.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''), remote: isHostRuntime() ? https : 'origin' };
}

/**
 * The sensitive-path gate's input: paths `head` changes relative to the base, as the union over every
 * base the gate knows of (see gateBases). Fails closed without a trustworthy base. Shared by
 * publication and the merge gate (src/runtime/merge.ts).
 */
export async function gateChangedPaths(o: { git: GitFn; repo: string; remote: string; base: string; head: string; branch: string; baseShas: (string | null)[]; sensitivePaths: string[] }):
  Promise<{ ok: true; changedPaths: string[]; sensitivePaths: string[] } | { ok: false; code: ErrorCode; message: string }> {
  const bases = await gateBases(o.git, o.repo, o.remote, o.base, o.baseShas);
  if (!bases.trusted.length) {
    return { ok: false, code: 'PRECONDITION', message: `No trustworthy base for ${o.branch}: no base SHA recorded at claim time is present in the workspace and origin's ${o.base} is not available locally; refusing to evaluate the sensitive-path gate against a movable local ref.` };
  }
  const changed = new Set<string>();
  for (const b of new Set([...bases.trusted, ...bases.local])) {
    // Unrelated history (no merge base) is a state problem, not a transient one: a retry fails the same
    // way. Fail closed and non-retryable; the base is never skipped, so no path can drop out (task-40).
    const mb = await o.git(o.repo, ['merge-base', b, o.head], true);
    if (mb.code === 1 && !mb.stdout.trim()) {
      return { ok: false, code: 'PRECONDITION', message: `Cannot evaluate the sensitive-path gate for ${o.branch}: no merge base between ${o.base} (${b}) and ${o.head} (unrelated history). Rebuild the branch on ${o.base} or check whether the base ref was rewritten; a retry fails the same way.` };
    }
    if (mb.code !== 0) return { ok: false, code: 'INTERNAL', message: `Cannot find the merge base of ${o.branch} and ${o.base} (${b}): ${lastLines(mb.stderr)}` };
    const d = await o.git(o.repo, ['diff', '--name-only', '--no-renames', '-z', `${b}...${o.head}`], true);
    if (d.code !== 0) return { ok: false, code: 'INTERNAL', message: `Cannot diff ${o.branch} against ${o.base} (${b}): ${lastLines(d.stderr)}` };
    for (const f of d.stdout.split('\0')) if (f) changed.add(f);
  }
  const changedPaths = [...changed];
  return { ok: true, changedPaths, sensitivePaths: changedPaths.filter((p) => matchesAny(p, o.sensitivePaths)) };
}

/** Publishes an approved head according to delivery.mode. Never throws for expected failures. */
export async function publishTask(input: PublishInput): Promise<PublishOutcome> {
  const { config: cfg, repo, branch, head } = input;
  const git = input.git ?? realGit;
  const gh = input.gh ?? realGh;
  const mode = cfg.delivery.mode;
  if (mode === 'local') return fail('PRECONDITION', 'delivery.mode is "local": nothing is published.');
  if (cfg.delivery.provider !== 'github') return fail('INVALID_CONFIG', `delivery.mode "${mode}" needs delivery.provider "github".`);

  // 1. Origin and credential.
  const origin = await githubOrigin(git, repo);
  if (!origin) return fail('PRECONDITION', 'origin is not a github.com repository; branch/PR delivery needs a GitHub remote (minions start records it from the host repository).');
  const { repository, remote } = origin;
  const token = await readGithubToken(input.tokenFile);
  if (token.state !== 'ok') {
    return fail('AUTH_REQUIRED', token.state === 'absent' ? 'No GitHub token is provisioned; run `minions auth github` on the host, then `minions work publish`.' : token.message);
  }

  // 2. Changed paths vs the base (renames split so moving a file out of a sensitive path still counts),
  // as the union over every base the gate knows of. At least one must be trustworthy: a base SHA
  // recorded at claim time, or the remote's current base. Local refs (refs/heads/<base>, the
  // remote-tracking refs) are movable by in-runtime code, so they can only add paths, never hide any.
  const base = cfg.git.baseBranch;
  const gated = await gateChangedPaths({ git, repo, remote, base, head, branch, baseShas: input.baseShas ?? [], sensitivePaths: cfg.sensitivePaths });
  if (!gated.ok) return fail(gated.code, gated.message);
  const { changedPaths, sensitivePaths } = gated;

  // 3. Capability gates.
  const caps: Capability[] = mode === 'pull-request' ? ['git.push', 'pr.create'] : ['git.push'];
  const reasons: string[] = [];
  for (const cap of caps) {
    const effect = can(cfg, cap, { paths: changedPaths });
    if (effect === 'deny') return fail('POLICY_DENIED', `${cap} is denied by configuration; ${branch} was not published.`);
    if (effect === 'ask') {
      reasons.push(sensitivePaths.length
        ? `${cap} needs human approval: the branch changes sensitive paths (${sensitivePaths.slice(0, 10).join(', ')}${sensitivePaths.length > 10 ? ', …' : ''})`
        : `${cap} needs human approval by configuration`);
    }
  }
  if (reasons.length) {
    const keyFile = input.approvalPublicKeyFile ?? runtimePaths().approvalPublicKey;
    const pem = await readPublicKey(keyFile);
    const check = pem
      ? verifyAnyApproval(input.approvals, pem, { taskId: input.task.id, head, now: input.now })
      : { ok: false as const, reason: missingApprovalKeyReason(keyFile) };
    if (!check.ok) return { state: 'awaiting-approval', reasons, changedPaths, sensitivePaths, approvalError: check.reason };
  }

  // 4. Remote branch: reconcile, fast-forward only, never force.
  const ghCwd = isHostRuntime() ? '/' : repo; // gh gets --repo; outside the workspace it never runs git there
  const ls = await git(repo, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], true);
  if (ls.code !== 0) return fail(classifyFailure(ls.stderr), `Cannot read origin: ${lastLines(ls.stderr) || `git exit ${ls.code}`}`);
  const remoteSha = ls.stdout.trim().split(/\s+/)[0] || null;
  let push: 'pushed' | 'already-current' = 'already-current';
  if (remoteSha !== head) {
    if (remoteSha && (await git(repo, ['merge-base', '--is-ancestor', remoteSha, head], true)).code !== 0) {
      return fail('CONFLICT', `origin/${branch} is at ${remoteSha}, which is not an ancestor of the approved head ${head}; refusing to overwrite it (no force push).`);
    }
    const p = await git(repo, ['push', '--porcelain', remote, `${head}:refs/heads/${branch}`], true);
    if (p.code !== 0) return fail(classifyFailure(p.stderr), `git push to origin failed: ${lastLines(p.stderr) || `git exit ${p.code}`}`);
    push = 'pushed';
  }
  if (mode === 'branch') return { state: 'published', mode, push, pr: null, prUrl: null, repository, changedPaths, sensitivePaths };

  // 5. Pull request: reuse an existing one for this head branch, else open exactly one.
  const found = await findPr(gh, ghCwd, repository, branch, head);
  if (found.error) return found.error;
  if (found.pr) return { state: 'published', mode, push, pr: 'existing', prUrl: found.pr.url, repository, changedPaths, sensitivePaths };
  const text = pullRequestText(input.task, cfg, head);
  const c = await gh(['pr', 'create', '--repo', repository, '--base', base, '--head', branch, '--title', text.title, '--body-file', '-'], { cwd: ghCwd, input: text.body });
  if (c.code !== 0) {
    // A concurrent or interrupted earlier run may have opened it; reconcile once.
    const again = await findPr(gh, ghCwd, repository, branch, head);
    if (again.pr) return { state: 'published', mode, push, pr: 'existing', prUrl: again.pr.url, repository, changedPaths, sensitivePaths };
    return fail(classifyFailure(c.stderr), `gh pr create failed: ${lastLines(c.stderr || c.stdout) || `exit ${c.code}`}`);
  }
  const url = PR_URL_RE.exec(c.stdout)?.[0];
  if (!url) {
    const again = await findPr(gh, ghCwd, repository, branch, head);
    if (again.pr) return { state: 'published', mode, push, pr: 'created', prUrl: again.pr.url, repository, changedPaths, sensitivePaths };
    return fail('INTERNAL', 'gh pr create did not report a pull request URL.');
  }
  return { state: 'published', mode, push, pr: 'created', prUrl: url, repository, changedPaths, sensitivePaths };
}
