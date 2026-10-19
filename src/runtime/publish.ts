// Branch and pull-request delivery for the github provider (decision record: docs/design/bootstrap.md,
// "Branch and pull-request delivery").
//
// - Publication is a deterministic helper run by the runtime, never by a model: `minions work record`
//   calls it when a reviewer approval is accepted, `minions work publish <taskId>` retries it.
// - Gates: git.push (and pr.create in pull-request mode) are evaluated against the paths the branch
//   changes relative to the base. `deny` fails; `ask` (including the sensitive-path upgrade
//   allow -> ask) requires a recorded human approval bound to the approved head SHA.
// - Idempotent: the remote branch and open PRs are inspected first; an up-to-date remote branch is
//   not pushed again and an existing PR for the head branch is reused, never duplicated.
// - Never merges, never force-pushes, never passes the token anywhere (git uses the repository
//   credential helper, gh the wrapper; see src/runtime/github.ts).
import { can, matchesAny } from '../config/capabilities.js';
import type { Capability, MinionsConfig } from '../config/schema.js';
import type { Task } from '../backlog/types.js';
import type { ErrorCode } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';
import { normalizeGithubRemote, readGithubToken, type GitFn } from './github.js';
import { isHostRuntime } from './git-hardening.js';
import { git as realGit } from './worktree.js';

export type GhFn = (args: string[], opts?: { input?: string; cwd?: string }) => Promise<RunResult>;

/** gh via the PATH wrapper (/usr/local/bin/gh injects the mounted token for that process only). */
export const realGh: GhFn = (args, opts = {}) =>
  run('gh', args, { cwd: opts.cwd, input: opts.input, allowFailure: true, timeoutMs: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });

export interface PublishInput {
  config: MinionsConfig;
  task: Task;
  repo: string;
  branch: string;
  /** Approved head; exactly this commit is published. */
  head: string;
  /** A human approval (scope publish) is recorded for this head. */
  humanApproved: boolean;
  git?: GitFn;
  gh?: GhFn;
  tokenFile?: string;
}

export type PublishOutcome =
  | { state: 'published'; mode: 'branch' | 'pull-request'; push: 'pushed' | 'already-current'; pr: 'created' | 'existing' | null;
      prUrl: string | null; repository: string; changedPaths: string[]; sensitivePaths: string[] }
  | { state: 'awaiting-approval'; reasons: string[]; changedPaths: string[]; sensitivePaths: string[] }
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
export function pullRequestText(task: Pick<Task, 'id' | 'title' | 'description' | 'acceptanceCriteria'>, cfg: Pick<MinionsConfig, 'visibility'>, head: string): { title: string; body: string } {
  const title = task.title.replace(/[\r\n]+/g, ' ').trim().slice(0, 256) || 'Agent change';
  const parts: string[] = [];
  const desc = task.description.replace(META_RE, '').trim();
  if (desc) parts.push(desc);
  if (task.acceptanceCriteria.length) {
    parts.push(['## Acceptance criteria', ...task.acceptanceCriteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text.replace(/[\r\n]+/g, ' ').trim()}`)].join('\n'));
  }
  if (cfg.visibility === 'shared') {
    parts.push(`---\nTask \`${task.id}\` at \`${head}\`, opened by minions. minions never merges: review and merge through your normal process.`);
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

const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

/** Publishes an approved head according to delivery.mode. Never throws for expected failures. */
export async function publishTask(input: PublishInput): Promise<PublishOutcome> {
  const { config: cfg, repo, branch, head } = input;
  const git = input.git ?? realGit;
  const gh = input.gh ?? realGh;
  const mode = cfg.delivery.mode;
  if (mode === 'local') return fail('PRECONDITION', 'delivery.mode is "local": nothing is published.');
  if (cfg.delivery.provider !== 'github') return fail('INVALID_CONFIG', `delivery.mode "${mode}" needs delivery.provider "github".`);

  // 1. Origin and credential.
  const o = await git(repo, ['config', '--get', 'remote.origin.url'], true);
  const https = o.code === 0 ? normalizeGithubRemote(o.stdout.trim()) : null;
  if (!https) return fail('PRECONDITION', 'origin is not a github.com repository; branch/PR delivery needs a GitHub remote (minions start records it from the host repository).');
  const repository = https.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const token = await readGithubToken(input.tokenFile);
  if (token.state !== 'ok') {
    return fail('AUTH_REQUIRED', token.state === 'absent' ? 'No GitHub token is provisioned; run `minions auth github` on the host, then `minions work publish`.' : token.message);
  }

  // 2. Changed paths vs the base (renames split so moving a file out of a sensitive path still counts).
  const base = cfg.git.baseBranch;
  let baseRef: string | null = null;
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`, `refs/remotes/host/${base}`]) {
    if ((await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], true)).code === 0) { baseRef = ref; break; }
  }
  if (!baseRef) return fail('PRECONDITION', `Base branch "${base}" does not exist in the workspace.`);
  const d = await git(repo, ['diff', '--name-only', '--no-renames', '-z', `${baseRef}...${head}`], true);
  if (d.code !== 0) return fail('INTERNAL', `Cannot diff ${branch} against ${base}: ${lastLines(d.stderr)}`);
  const changedPaths = d.stdout.split('\0').filter(Boolean);
  const sensitivePaths = changedPaths.filter((p) => matchesAny(p, cfg.sensitivePaths));

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
  if (reasons.length && !input.humanApproved) return { state: 'awaiting-approval', reasons, changedPaths, sensitivePaths };

  // 4. Remote branch: reconcile, fast-forward only, never force. The host runtime names the normalized
  // https URL instead of the agent-writable `origin` remote (no pushurl / receivepack from the workspace).
  const remote = isHostRuntime() ? https : 'origin';
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
