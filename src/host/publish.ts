// Publishing (docs/design/autonomy.md Decision 17): pushing the agents' base branch at one exact commit, from the owner's
// checkout with the owner's git credentials, after the owner approved that commit. The trusted host publisher
// (src/host/publisher.ts) and `minions settings requests publish <id>` on the host call it; nothing in a runtime does.
//
// - planPublish reads only git: the commit must be in the checkout (exported by `minions pull`'s exportRepo), on the
//   agents' base (refs/remotes/minions/<base>), and a fast-forward of origin/<base> fetched just before. The outgoing
//   range is scanned (scanRange) for secret-like files, secret-shaped content in added lines, and large files; any hit
//   refuses the publish and is reported by path and kind, never by value.
// - publishCommit pushes exactly that commit: `git push origin <sha>:refs/heads/<base>` (direct; no force, so the
//   remote refuses anything but a fast-forward even if origin moved after the check) or a `minions/publish-<sha>`
//   branch plus `gh pr create` (pull-request). Direct mode then fast-forwards the owner's checkout only when it is on
//   the base branch and has no tracked changes (src/host/pull.ts fastForwardBase); nothing else in the working tree
//   is touched.
// - git runs with HOST_GIT (hooks off, fsmonitor off): the commits are agent-authored, and a hooks path inside the work
//   tree would run their scripts outside any sandbox with the owner's credentials. No terminal prompts
//   (GIT_TERMINAL_PROMPT=0): an unattended push that needs a password fails and says so.
import { MinionsError } from '../core/errors.js';
import { run, type RunOptions, type RunResult } from '../core/exec.js';
import { redact } from '../core/output.js';
import { HOST_GIT } from './discovery.js';
import type { Runner } from './docker.js';
import { fastForwardBase, type FfResult } from './pull.js';
import { secretLikePaths } from './transfer.js';

/** POSIX shell quoting (git runs GIT_SSH_COMMAND through a shell). */
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export const PUBLISH_MODES = ['direct', 'pull-request'] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];
export const PUBLISH_REMOTE = 'origin';
/** A file at or above this size (bytes) in the outgoing range refuses the publish. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
/** The scanned diff of the outgoing range is capped; a larger range is refused rather than half scanned. */
export const SCAN_MAX_BYTES = 64 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Secret shapes looked for in added lines (best effort, never complete). Names only are reported. */
export const SECRET_CONTENT_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'Anthropic API key', re: /\bsk-ant-(?:api|oat|admin)\d{2}-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'GitHub token', re: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/ },
  { name: 'Telegram bot token', re: /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

export interface ScanHit { kind: 'secret-file' | 'secret-content' | 'large-file' | 'unscannable'; path: string; detail: string }

export interface PublishPlan {
  base: string;
  sha: string;
  remote: string;
  /** The remote URL with any embedded credentials removed (null: no such remote). */
  remoteUrl: string | null;
  /** origin/<base> before the push (null: the remote has no such branch yet; the push creates it). */
  from: string | null;
  /** Commits in from..sha, and the first subjects (newest first). */
  commits: number;
  subjects: string[];
  /** Files the range changes. */
  files: number;
  hits: ScanHit[];
  /** Why this cannot be published (null: it can). */
  refusal: { code: 'no-remote' | 'unknown-commit' | 'not-on-base' | 'fetch-failed' | 'up-to-date' | 'diverged' | 'scan'; message: string } | null;
}

export interface PublishEnvOptions { deployKey?: string | null; env?: NodeJS.ProcessEnv }

/** The environment of every git and gh call here: no prompts; a repo-scoped deploy key when configured. */
export function publishEnv(o: PublishEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GH_PROMPT_DISABLED: '1', SSH_ASKPASS_REQUIRE: 'never' };
  if (o.deployKey) env.GIT_SSH_COMMAND = `ssh -i ${shellQuote(o.deployKey)} -o IdentitiesOnly=yes -o BatchMode=yes`;
  return env;
}

type Git = (args: string[], opts?: Partial<RunOptions>) => Promise<RunResult>;

function gitIn(repo: string, runner: Runner, env: NodeJS.ProcessEnv): Git {
  return (args, opts = {}) => runner('git', [...HOST_GIT, ...args], { cwd: repo, allowFailure: true, timeoutMs: 120_000, env, ...opts });
}

const tail = (r: RunResult) => redact((r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' ')).slice(0, 300);
const short = (sha: string) => sha.slice(0, 12);

/** Whether `url` reaches the remote over SSH (scp-style `user@host:path` or ssh://). */
export const isSshUrl = (url: string | null): boolean => !!url && (/^ssh:\/\//i.test(url) || /^[^/@:]+@[^/:]+:/.test(url) || /^git\+ssh:\/\//i.test(url));

/** `git remote get-url <remote>` with embedded credentials removed; null when the remote does not exist. */
export async function remoteUrlOf(repo: string, runner: Runner = run, remote = PUBLISH_REMOTE): Promise<string | null> {
  const r = await gitIn(repo, runner, publishEnv())(['remote', 'get-url', remote], { timeoutMs: 15_000 });
  if (r.code !== 0 || !r.stdout.trim()) return null;
  const url = r.stdout.trim();
  try { const u = new URL(url); if (u.username || u.password) { u.username = ''; u.password = ''; return u.toString(); } } catch { /* scp-style */ }
  return url;
}

/** Scans from..to (from null: everything reachable from `to`): secret-like files, secret-shaped added lines, large files. */
export async function scanRange(git: Git, from: string | null, to: string): Promise<{ files: number; hits: ScanHit[] }> {
  const base = from ?? EMPTY_TREE;
  const hits: ScanHit[] = [];
  const names = await git(['diff', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', base, to]);
  if (names.code !== 0) return { files: 0, hits: [{ kind: 'unscannable', path: '', detail: `git diff failed: ${tail(names)}` }] };
  const files = names.stdout.split('\0').filter(Boolean);
  for (const p of secretLikePaths(files)) hits.push({ kind: 'secret-file', path: p, detail: 'a file name that commonly holds secrets' });
  // Large files: the new blob of every added or modified path.
  const raw = await git(['diff', '--raw', '--no-renames', '--no-abbrev', '--diff-filter=AMT', '-z', base, to]);
  if (raw.code === 0) {
    const parts = raw.stdout.split('\0').filter(Boolean);
    const blobs: { path: string; blob: string }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const meta = parts[i]!.split(' ');
      const blob = meta[3];
      if (blob && /^[0-9a-f]{40,64}$/.test(blob) && meta[1] !== '160000') blobs.push({ path: parts[i + 1]!, blob });
    }
    if (blobs.length) {
      const sizes = await git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: blobs.map((b) => b.blob).join('\n') + '\n' });
      const size = new Map(sizes.stdout.split('\n').filter(Boolean).map((l) => { const [o, s] = l.split(' '); return [o!, Number(s)] as const; }));
      for (const b of blobs) {
        const n = size.get(b.blob) ?? 0;
        if (n >= LARGE_FILE_BYTES) hits.push({ kind: 'large-file', path: b.path, detail: `${(n / 1024 / 1024).toFixed(1)} MiB (limit ${LARGE_FILE_BYTES / 1024 / 1024} MiB)` });
      }
    }
  }
  // Secret-shaped content in added lines (text diffs only; binary files show no lines).
  const diff = await git(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, to], { maxOutputBytes: SCAN_MAX_BYTES, timeoutMs: 300_000 });
  if (diff.outputLimited) hits.push({ kind: 'unscannable', path: '', detail: `the outgoing diff is larger than ${SCAN_MAX_BYTES / 1024 / 1024} MiB; publish it yourself after a review` });
  else if (diff.code !== 0) hits.push({ kind: 'unscannable', path: '', detail: `git diff failed: ${tail(diff)}` });
  else {
    let path = '';
    const seen = new Set<string>();
    for (const line of diff.stdout.split('\n')) {
      if (line.startsWith('+++ ')) { path = line.slice(4).replace(/^b\//, ''); continue; }
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      for (const p of SECRET_CONTENT_PATTERNS) {
        const key = `${path}\0${p.name}`;
        if (!seen.has(key) && p.re.test(line)) { seen.add(key); hits.push({ kind: 'secret-content', path, detail: `an added line looks like a ${p.name}` }); }
      }
    }
  }
  return { files: files.length, hits };
}

export interface PlanOptions extends PublishEnvOptions {
  repo: string;
  base: string;
  sha: string;
  runner?: Runner;
  /** The agents' base the commit must be on (default refs/remotes/minions/<base>, what `minions pull` fetched). */
  agentsRef?: string;
}

/** Everything the owner is shown and the push relies on, read from git. Never pushes. */
export async function planPublish(o: PlanOptions): Promise<PublishPlan> {
  const runner = o.runner ?? run;
  const git = gitIn(o.repo, runner, publishEnv(o));
  const plan: PublishPlan = { base: o.base, sha: o.sha, remote: PUBLISH_REMOTE, remoteUrl: null, from: null, commits: 0, subjects: [], files: 0, hits: [], refusal: null };
  const refuse = (code: NonNullable<PublishPlan['refusal']>['code'], message: string) => { plan.refusal = { code, message }; return plan; };
  if (!/^[0-9a-f]{40}$/.test(o.sha)) return refuse('unknown-commit', `${o.sha.slice(0, 60)} is not a full commit SHA`);
  plan.remoteUrl = await remoteUrlOf(o.repo, runner);
  if (!plan.remoteUrl) return refuse('no-remote', 'publishing is unavailable: the checkout has no git remote "origin"');
  if ((await git(['cat-file', '-e', `${o.sha}^{commit}`])).code !== 0) return refuse('unknown-commit', `commit ${short(o.sha)} is not in the checkout (the agents' branches were not exported, or it is not theirs)`);
  const agents = o.agentsRef ?? `refs/remotes/minions/${o.base}`;
  if ((await git(['merge-base', '--is-ancestor', o.sha, agents])).code !== 0) return refuse('not-on-base', `commit ${short(o.sha)} is not on the agents' ${o.base} (${agents.replace(/^refs\/remotes\//, '')})`);
  const tracking = `refs/remotes/${PUBLISH_REMOTE}/${o.base}`;
  const fetch = await git(['fetch', '--no-tags', '--no-recurse-submodules', PUBLISH_REMOTE, `+refs/heads/${o.base}:${tracking}`], { timeoutMs: 300_000 });
  if (fetch.code !== 0) {
    // A remote without the branch yet: the push creates it. Anything else (network, authentication) refuses.
    if (!/couldn't find remote ref|could not find remote ref/i.test(fetch.stderr)) return refuse('fetch-failed', `git fetch ${PUBLISH_REMOTE} ${o.base} failed: ${tail(fetch)}`);
    await git(['update-ref', '-d', tracking]);
  } else {
    const r = await git(['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`]);
    plan.from = r.code === 0 ? r.stdout.trim() : null;
  }
  if (plan.from) {
    if (plan.from === o.sha || (await git(['merge-base', '--is-ancestor', o.sha, plan.from])).code === 0) return refuse('up-to-date', `${PUBLISH_REMOTE}/${o.base} already contains ${short(o.sha)}`);
    if ((await git(['merge-base', '--is-ancestor', plan.from, o.sha])).code !== 0) {
      return refuse('diverged', `${PUBLISH_REMOTE}/${o.base} (${short(plan.from)}) moved and ${short(o.sha)} is not a fast-forward of it: integrate the remote changes first (the agents' base must contain ${PUBLISH_REMOTE}/${o.base})`);
    }
  }
  const range = plan.from ? [`${plan.from}..${o.sha}`] : [o.sha, '--not', `--remotes=${PUBLISH_REMOTE}`];
  const count = await git(['rev-list', '--count', ...range]);
  plan.commits = count.code === 0 ? Number(count.stdout.trim()) || 0 : 0;
  const log = await git(['log', '--no-color', '--format=%s', '-n', '20', ...range]);
  plan.subjects = log.code === 0 ? log.stdout.split('\n').filter(Boolean) : [];
  const scan = await scanRange(git, plan.from, o.sha);
  plan.files = scan.files;
  plan.hits = scan.hits;
  if (plan.hits.length) return refuse('scan', `the outgoing range has ${plan.hits.length} finding(s): ${formatHits(plan.hits)}`);
  return plan;
}

export const formatHits = (hits: ScanHit[]): string =>
  `${hits.slice(0, 5).map((h) => `${h.path ? `${h.path}: ` : ''}${h.detail}`).join('; ')}${hits.length > 5 ? `; and ${hits.length - 5} more` : ''}`;

export interface PublishResult {
  mode: PublishMode;
  base: string;
  sha: string;
  /** The ref pushed to (refs/heads/<base> or refs/heads/minions/publish-<sha>). */
  ref: string;
  /** Pull-request mode: the PR URL. */
  prUrl: string | null;
  /** Direct mode: what happened to the owner's checkout. */
  checkout: FfResult | null;
}

export interface PublishOptions extends PlanOptions {
  mode: PublishMode;
  /** The plan the owner approved (planPublish right before; refused plans are rejected here too). */
  plan: PublishPlan;
  /** Pull-request title and body. */
  title?: string;
  body?: string;
}

export const prBranch = (sha: string) => `minions/publish-${sha.slice(0, 12)}`;

/** Pushes the approved commit. Throws PRECONDITION with the git or gh error when the push or the PR fails. */
export async function publishCommit(o: PublishOptions): Promise<PublishResult> {
  const runner = o.runner ?? run;
  const env = publishEnv(o);
  const git = gitIn(o.repo, runner, env);
  if (o.plan.refusal) throw new MinionsError('PRECONDITION', `not published: ${o.plan.refusal.message}`);
  if (o.plan.sha !== o.sha || o.plan.base !== o.base) throw new MinionsError('INTERNAL', 'the plan does not match the commit being published');
  const ref = o.mode === 'direct' ? `refs/heads/${o.base}` : `refs/heads/${prBranch(o.sha)}`;
  // Never forced: the remote accepts only a fast-forward, so a push that raced someone else's is refused, not lost.
  const push = await git(['push', '--no-verify', PUBLISH_REMOTE, `${o.sha}:${ref}`], { timeoutMs: 600_000 });
  if (push.code !== 0) {
    throw new MinionsError('PRECONDITION', `git push ${PUBLISH_REMOTE} ${short(o.sha)}:${ref.replace(/^refs\/heads\//, '')} failed: ${tail(push)}`,
      /could not read|permission denied|authentication|publickey|403|401/i.test(push.stderr) ? authHint(o.plan.remoteUrl, o.deployKey) : undefined);
  }
  if (o.mode === 'direct') {
    await git(['update-ref', `refs/remotes/${PUBLISH_REMOTE}/${o.base}`, o.sha]);
    const checkout = await fastForwardBase(o.repo, o.base, runner, { to: o.sha, target: short(o.sha) }).catch((e: unknown): FfResult =>
      ({ action: 'skipped', reason: `could not check the checkout: ${(e as Error).message}`, base: o.base, from: null, to: o.sha, applied: false }));
    return { mode: 'direct', base: o.base, sha: o.sha, ref, prUrl: null, checkout };
  }
  const branch = prBranch(o.sha);
  const title = (o.title ?? `minions: publish ${o.plan.commits} commit(s) to ${o.base}`).slice(0, 200);
  const body = (o.body ?? '').slice(0, 60_000);
  const gh = (args: string[]) => runner('gh', args, { cwd: o.repo, env, allowFailure: true, timeoutMs: 120_000 });
  const pr = await gh(['pr', 'create', '--base', o.base, '--head', branch, '--title', title, '--body', body]);
  let url = /https?:\/\/\S+/.exec(pr.stdout)?.[0] ?? null;
  if (pr.code !== 0) {
    // A PR for this branch already exists (the same commit was approved twice): report it instead of failing.
    const view = /already exists/i.test(pr.stderr) ? await gh(['pr', 'view', branch, '--json', 'url', '--jq', '.url']) : null;
    url = view?.code === 0 ? /https?:\/\/\S+/.exec(view.stdout)?.[0] ?? null : null;
    if (!url) {
      throw new MinionsError('PRECONDITION', `pushed ${branch}, but \`gh pr create\` failed: ${tail(pr)}`,
        pr.code === 127 || /ENOENT|not found/i.test(pr.stderr) ? 'Install the GitHub CLI (`gh`) and run `gh auth login` on this host, or set publish.mode direct.' : 'Check `gh auth status` on this host; the branch is pushed, open the PR by hand if needed.');
    }
  }
  return { mode: 'pull-request', base: o.base, sha: o.sha, ref, prUrl: url, checkout: null };
}

/** What to do when a push cannot authenticate. */
export function authHint(remoteUrl: string | null, deployKey?: string | null): string {
  if (deployKey) return `Check that the deploy key ${deployKey} is added to the repository with write access.`;
  if (isSshUrl(remoteUrl)) return 'The push uses your SSH keys: the publisher service needs a running ssh-agent with the key loaded (SSH_AUTH_SOCK), or set a repo-scoped deploy key with `minions settings set publish.deployKey <path>`.';
  return 'The push uses your git credential helper (HTTPS): make sure it can answer without a prompt (`git push` works in a terminal), or use an SSH remote with a deploy key.';
}

/** Credentials the publisher service will push with, as far as the host can tell without pushing (doctor, the service heartbeat). */
export function pushAuthFacts(remoteUrl: string | null, env: NodeJS.ProcessEnv, deployKey?: string | null): { ok: boolean; detail: string } {
  if (!remoteUrl) return { ok: false, detail: 'no git remote "origin": publishing is unavailable' };
  if (deployKey) return { ok: true, detail: `deploy key ${deployKey}` };
  if (!isSshUrl(remoteUrl)) return { ok: true, detail: 'HTTPS remote: the owner\'s git credential helper' };
  return env.SSH_AUTH_SOCK ? { ok: true, detail: 'SSH remote: the owner\'s ssh-agent (SSH_AUTH_SOCK set)' } : { ok: false, detail: 'SSH remote, but SSH_AUTH_SOCK is not set: pushes cannot use your ssh-agent' };
}
