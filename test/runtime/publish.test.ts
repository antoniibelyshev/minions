import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { RunResult } from '../../src/core/exec.js';
import { mergeReadiness } from '../../src/host/doctor.js';
import { coordinatorSettings } from '../../src/runtime/coordinator.js';
import type { GitFn } from '../../src/runtime/github.js';
import { classifyFailure, publishTask, pullRequestText, type GhFn, type PublishInput } from '../../src/runtime/publish.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { git as realGit } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { approvalKeys, commitFile, ghBranchApi, gitSync, makeEnv, result, tmp, type Env } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';
const TOKEN = 'ghp_' + 'a'.repeat(36);

interface FakePr { url: string; headRefName: string; headRefOid: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; isCrossRepository: boolean; title: string; body: string; base: string }

/** In-memory `gh` for one repository: `pr list` / `pr create`; records every call. */
class FakeGh {
  prs: FakePr[] = [];
  calls: string[][] = [];
  inputs: (string | undefined)[] = [];
  failCreate: string | null = null;
  failList: string | null = null;
  constructor(private bare: string) {}
  fn: GhFn = async (args, opts = {}) => {
    // The verified base read (task-71): GitHub's view of origin's branches is the bare repository.
    const api = ghBranchApi(this.bare, args);
    if (api) return api;
    this.calls.push(args);
    this.inputs.push(opts.input);
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
    const bad = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });
    const flag = (f: string) => args[args.indexOf(f) + 1]!;
    if (args[0] === 'pr' && args[1] === 'list') {
      if (this.failList) return bad(this.failList);
      return ok(JSON.stringify(this.prs.filter((p) => p.headRefName === flag('--head')).map(({ url, headRefName, headRefOid, state, isCrossRepository }) => ({ url, headRefName, headRefOid, state, isCrossRepository }))));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      if (this.failCreate) return bad(this.failCreate);
      const head = flag('--head');
      const oid = execFileSync('git', ['-C', this.bare, 'rev-parse', `refs/heads/${head}`], { encoding: 'utf8' }).trim();
      const url = `https://github.com/acme/demo/pull/${this.prs.length + 1}`;
      this.prs.push({ url, headRefName: head, headRefOid: oid, state: 'OPEN', isCrossRepository: false, title: flag('--title'), body: opts.input ?? '', base: flag('--base') });
      return ok(`Creating pull request for ${head} into ${flag('--base')} in acme/demo\n\n${url}\n`);
    }
    return bad(`unexpected gh call: ${args.join(' ')}`);
  };
}

interface PubEnv extends Env { bare: string; gh: FakeGh; tokenFile: string; sched: Scheduler; gitOverride: { fn?: GitFn }; keys: ReturnType<typeof approvalKeys>; serverUrl: () => string }

/** Runtime env whose origin is https://github.com/acme/demo.git, rewritten (insteadOf) to a local bare repo. */
function pubEnv(mutate?: (c: MinionsConfig) => void): PubEnv {
  const env = makeEnv((c) => {
    c.delivery.provider = 'github';
    c.delivery.mode = 'pull-request';
    mutate?.(c);
  });
  const bare = join(tmp('minions-origin-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitSync(env.layout.repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(env.layout.repo, 'config', `url.${bare}.insteadOf`, REMOTE);
  gitSync(env.layout.repo, 'push', '-q', 'origin', 'main');
  const tokenFile = join(env.root, 'github-token');
  writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const gh = new FakeGh(bare);
  const gitOverride: { fn?: GitFn } = {};
  const keys = approvalKeys();
  // git reaches the recorded https origin at the bare repository (the code-only seam; insteadOf is ignored).
  const serverUrl = () => bare;
  const sched = new Scheduler({
    db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, approvalPublicKeyFile: keys.publicKeyFile,
    gh: (a, o) => gh.fn(a, o), serverUrl,
    publisher: (input: PublishInput) => publishTask({ ...input, gh: gh.fn, tokenFile, git: gitOverride.fn ?? realGit }),
  });
  return { ...env, sched, bare, gh, tokenFile, gitOverride, keys, serverUrl };
}

const remoteHead = (bare: string, branch: string) => {
  try { return execFileSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

/** engineer (commits `file`) → tester → reviewer approve. Returns the reviewer record response. */
async function approveTask(env: PubEnv, id: string, file = 'a.txt') {
  const eng = await env.sched.claim(id, 'engineer');
  mkdirSync(dirname(join(eng.worktree, file)), { recursive: true });
  const head = commitFile(eng.worktree, file, `work ${Math.random()}`);
  await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head }));
  const t = await env.sched.claim(id, 'tester');
  await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head }));
  const rev = await env.sched.claim(id, 'reviewer');
  const r = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve', summary: 'SECRET-WORKER-SUMMARY looks good' }));
  return { r, head, branch: eng.branch };
}

describe('pull-request delivery', () => {
  it('approval pushes agent/<slug>, opens exactly one PR, and records delivered + prUrl; rerun is idempotent', async () => {
    const env = pubEnv();
    env.backlog.add({ id: 'task-1', title: 'Add login', description: 'Users can log in.', acceptanceCriteria: [{ text: 'login works', done: false }] });
    const { r, head, branch } = await approveTask(env, 'task-1');
    expect(branch).toBe('agent/task-1-add-login');
    expect(r.approved).toBe(true);
    expect(r.to).toBe('delivered');
    expect(r.publication).toMatchObject({ state: 'published', status: 'delivered', push: 'pushed', pr: 'created', prUrl: 'https://github.com/acme/demo/pull/1', merged: false });
    expect(r.message).toMatch(/not merged/);
    expect(remoteHead(env.bare, branch)).toBe(head);
    const task = await env.backlog.getTask('task-1');
    expect(task).toMatchObject({ status: 'delivered', prUrl: 'https://github.com/acme/demo/pull/1', branch });
    expect(env.gh.prs).toHaveLength(1);
    expect(env.gh.prs[0]).toMatchObject({ base: 'main', headRefName: branch, headRefOid: head, title: 'Add login' });
    expect(env.db.publication('task-1')).toMatchObject({ state: 'published', head_sha: head, pr_url: 'https://github.com/acme/demo/pull/1' });

    const again = await env.sched.publish('task-1');
    expect(again).toMatchObject({ state: 'published', status: 'delivered', prUrl: 'https://github.com/acme/demo/pull/1', merged: false });
    expect(env.gh.calls.filter((c) => c[1] === 'create')).toHaveLength(1);
    expect(env.gh.calls.flat()).not.toContain('merge');
  });

  it('a failed push leaves the task blocked (not delivered), keeps the local branch, and is retryable', async () => {
    const env = pubEnv();
    env.backlog.add({ id: 'task-1', title: 'Flaky network' });
    // The push goes to the explicit origin URL from an isolated git dir (no GitFn), so the server refuses it.
    const hook = join(env.bare, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\necho "Invalid username or password. Authentication failed for '${REMOTE}/' token ${TOKEN}" >&2\nexit 1\n`, { mode: 0o755 });
    const { r, head, branch } = await approveTask(env, 'task-1');
    expect(r.publication).toMatchObject({ state: 'failed', status: 'blocked', errorCode: 'AUTH_REQUIRED', prUrl: null, merged: false });
    expect(r.publication!.message).not.toContain(TOKEN);
    expect(r.to).toBe('blocked');
    const t = await env.backlog.getTask('task-1');
    expect(t).toMatchObject({ status: 'blocked', prUrl: null });
    expect(gitSync(env.layout.repo, 'rev-parse', `refs/heads/${branch}`)).toBe(head);
    expect(remoteHead(env.bare, branch)).toBeNull();
    expect(env.gh.calls).toHaveLength(0);
    expect(env.backlog.notes.map((n) => n.text).join('\n')).not.toContain(TOKEN);

    rmSync(hook);
    const p = await env.sched.publish('task-1');
    expect(p).toMatchObject({ state: 'published', status: 'delivered', push: 'pushed', pr: 'created' });
    expect(remoteHead(env.bare, branch)).toBe(head);
  });

  it('refuses to overwrite a diverged remote branch (no force push)', async () => {
    const env = pubEnv();
    env.backlog.add({ id: 'task-1', title: 'Diverged' });
    // Someone else pushed an unrelated commit to the same branch name.
    const other = join(tmp(), 'other');
    execFileSync('git', ['clone', '-q', env.bare, other]);
    gitSync(other, 'checkout', '-q', '-b', 'agent/task-1-diverged');
    commitFile(other, 'x.txt', 'foreign');
    gitSync(other, 'push', '-q', 'origin', 'agent/task-1-diverged');
    const foreign = remoteHead(env.bare, 'agent/task-1-diverged');
    const { r } = await approveTask(env, 'task-1');
    expect(r.publication).toMatchObject({ state: 'failed', errorCode: 'CONFLICT', status: 'blocked' });
    expect(remoteHead(env.bare, 'agent/task-1-diverged')).toBe(foreign);
  });

});

describe('sensitive-path gate', () => {
  it('sensitive changes are not pushed until a human approval for that head is recorded', async () => {
    const env = pubEnv();
    env.backlog.add({ id: 'task-1', title: 'Touch CI' });
    const { r, head, branch } = await approveTask(env, 'task-1', '.github/workflows/ci.yml');
    expect(r.publication).toMatchObject({ state: 'awaiting-approval', status: 'awaiting-human', sensitivePaths: ['.github/workflows/ci.yml'], prUrl: null });
    expect(r.publication!.reasons!.join(' ')).toMatch(/git\.push needs human approval: the branch changes sensitive paths \(\.github\/workflows\/ci\.yml\)/);
    expect(r.publication!.message).toContain(`minions work approve task-1 --head ${head}`);
    expect((await env.backlog.getTask('task-1')).status).toBe('awaiting-human');
    expect(remoteHead(env.bare, branch)).toBeNull();
    expect(env.gh.calls).toHaveLength(0);

    // Retrying without approval still publishes nothing.
    expect((await env.sched.publish('task-1')).state).toBe('awaiting-approval');
    expect(remoteHead(env.bare, branch)).toBeNull();

    // Approval must name the exact reviewed head.
    expect(() => env.sched.approvePublication('task-1', { head: 'f'.repeat(40) })).toThrow(/not the head awaiting publication/);
    const a = env.sched.approvePublication('task-1', { head, by: 'user', signature: env.keys.sign('task-1', head, { by: 'user' }) });
    expect(a).toMatchObject({ taskId: 'task-1', headSha: head });
    const p = await env.sched.publish('task-1');
    expect(p).toMatchObject({ state: 'published', status: 'delivered', pr: 'created' });
    expect(remoteHead(env.bare, branch)).toBe(head);
    expect(() => env.sched.approvePublication('task-1', { head, signature: env.keys.sign('task-1', head) })).toThrow(/already published/);
  });

  it('a local base ref moved to the branch head cannot hide sensitive paths: the gate diffs against the base recorded at claim', async () => {
    const env = pubEnv();
    env.backlog.add({ id: 'task-1', title: 'Touch CI' });
    const eng = await env.sched.claim('task-1', 'engineer');
    const claimBase = env.db.lease(eng.leaseId)!.base_sha!;
    mkdirSync(join(eng.worktree, '.github/workflows'), { recursive: true });
    const head = commitFile(eng.worktree, '.github/workflows/ci.yml', 'evil');
    await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head }));
    const t = await env.sched.claim('task-1', 'tester');
    await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head }));
    const rev = await env.sched.claim('task-1', 'reviewer');
    // In-runtime code moves every base ref it can reach to the head, including origin's (with the token).
    const repo = env.layout.repo;
    gitSync(repo, 'update-ref', 'refs/heads/main', head);
    gitSync(repo, 'update-ref', 'refs/remotes/origin/main', head);
    gitSync(repo, 'push', '-q', env.bare, `${head}:refs/heads/main`);
    expect(gitSync(repo, 'diff', '--name-only', `main...${head}`)).toBe(''); // the old ref-based diff would be empty
    expect(claimBase).not.toBe(head);
    const r = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve' }));
    expect(r.publication).toMatchObject({ state: 'awaiting-approval', status: 'awaiting-human', sensitivePaths: ['.github/workflows/ci.yml'] });
    expect(remoteHead(env.bare, rev.branch)).toBeNull();
    expect(env.gh.calls).toHaveLength(0);
  });

  it('coordinator settings deny direct push/merge and recording an approval (the owner signs it on the host)', () => {
    const s = coordinatorSettings(defaults()) as { permissions: { deny: string[]; ask: string[] } };
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(git push *)', 'Bash(gh pr merge *)']));
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(minions work approve *)']));
    expect(s.permissions).not.toHaveProperty('ask');
  });

  it('approve is denied (never allowed, never a blocking prompt) even with program-level options before the subcommand', () => {
    const s = coordinatorSettings(defaults()) as { permissions: { allow: string[]; deny: string[]; ask?: string[] } };
    // Claude Code wildcard semantics: `*` matches any run of characters, including spaces. Precedence deny > ask > allow.
    // Only Bash rules decide a Bash command (the container settings also carry Edit denies for the runtime state).
    const glob = (rule: string, cmd: string) => {
      const b = /^Bash\((.*)\)$/.exec(rule);
      if (!b) return false;
      const m = b[1]!;
      return new RegExp('^' + m.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, (ch) => `\\${ch}`)).join('.*') + '$').test(cmd);
    };
    const decide = (cmd: string) => s.permissions.deny.some((r) => glob(r, cmd)) ? 'deny'
      : (s.permissions.ask ?? []).some((r) => glob(r, cmd)) ? 'ask' : s.permissions.allow.some((r) => glob(r, cmd)) ? 'allow' : 'none';
    for (const cmd of [
      'minions work approve task-1 --head abc', 'minions --json work approve task-1 --head abc', 'minions --json --project x work approve task-1',
      'minions --json work approve', 'minions approve task-1', 'minions --json approve task-1 --head abc',
    ]) expect(decide(cmd), cmd).toBe('deny');
    expect(decide('minions work list')).toBe('allow');
    expect(decide('minions --json status')).toBe('allow');
    expect(decide('git -C x push origin HEAD')).toBe('deny');
    expect(decide('gh pr merge 3')).toBe('deny');
    expect(decide('gh -R o/r pr merge 3')).toBe('deny');
  });
});

describe('branch delivery', () => {
  it('pushes the branch, delivers without a PR, and never calls gh', async () => {
    const env = pubEnv((c) => { c.delivery.mode = 'branch'; });
    env.backlog.add({ id: 'task-1', title: 'Just push' });
    const { r, head, branch } = await approveTask(env, 'task-1');
    expect(r.publication).toMatchObject({ state: 'published', status: 'delivered', push: 'pushed', pr: null, prUrl: null, merged: false });
    expect(remoteHead(env.bare, branch)).toBe(head);
    expect(env.gh.calls).toHaveLength(0);
    expect((await env.sched.publish('task-1')).state).toBe('published');
  });

});

describe('PR text privacy', () => {
  it('private installations: PR text has only title, objective and acceptance criteria', async () => {
    const env = pubEnv((c) => { c.visibility = 'private'; });
    env.backlog.add({ id: 'task-7', title: 'Fix parser', description: 'Parse dates in ISO format.', acceptanceCriteria: [{ text: 'ISO dates parse', done: false }] });
    await env.backlog.addNote('task-7', 'PRIVATE-NOTE: customer Acme is unhappy');
    const { r } = await approveTask(env, 'task-7');
    expect(r.publication?.state).toBe('published');
    const pr = env.gh.prs[0]!;
    expect(pr.title).toBe('Fix parser');
    expect(pr.body).toBe('Parse dates in ISO format.\n\n## Acceptance criteria\n- [ ] ISO dates parse');
    const text = pr.title + pr.body;
    for (const secret of ['PRIVATE-NOTE', 'Acme', 'SECRET-WORKER-SUMMARY', 'task-7', 'minions', 'lease-']) expect(text).not.toContain(secret);
    // Nothing private in any gh argv either (the branch name agent/<slug> is the only task-derived value).
    const argv = JSON.stringify(env.gh.calls);
    for (const secret of ['PRIVATE-NOTE', 'Acme', 'SECRET-WORKER-SUMMARY', 'Parse dates']) expect(argv).not.toContain(secret);
    // The body goes through stdin, not argv.
    expect(env.gh.calls.find((c) => c[1] === 'create')).toContain('--body-file');
  });

  it('shared installations add only the task id and head; meta blocks never leak', () => {
    const task = { id: 'task-3', title: 'T\nitle', description: 'Objective.\n\n<!-- minions:meta {"branch":"agent/x"} -->', acceptanceCriteria: [{ text: 'a', done: true }] };
    const shared = pullRequestText(task, { visibility: 'shared' }, 'a'.repeat(40));
    expect(shared.title).toBe('T itle');
    expect(shared.body).toContain('Task `task-3` at `' + 'a'.repeat(40) + '`');
    expect(shared.body).toContain('- [x] a');
    expect(shared.body).not.toContain('minions:meta');
    const priv = pullRequestText(task, { visibility: 'private' }, 'a'.repeat(40));
    expect(priv.body).toBe('Objective.\n\n## Acceptance criteria\n- [x] a');
  });
});

describe('publication helpers', () => {
  it('classifies git/gh failures', () => {
    expect(classifyFailure('fatal: Authentication failed for https://github.com/o/r/')).toBe('AUTH_REQUIRED');
    expect(classifyFailure('fatal: could not read Username for https://github.com: terminal prompts disabled')).toBe('AUTH_REQUIRED');
    expect(classifyFailure('remote: Permission to o/r.git denied to bot.\nfatal: unable to access ... The requested URL returned error: 403')).toBe('POLICY_DENIED');
    expect(classifyFailure('fatal: unable to access: Could not resolve host: github.com')).toBe('NETWORK_RETRYABLE');
    expect(classifyFailure('something odd')).toBe('INTERNAL');
  });

  it('doctor merge.readiness reports PR delivery availability and auto-merge as off (opt-in) by default', () => {
    const cfg = (mode: 'local' | 'branch' | 'pull-request') => ({ delivery: { ...defaults().delivery, mode, provider: mode === 'local' ? 'none' as const : 'github' as const } });
    const ok = { onGitHub: true, credential: 'ok' as const };
    expect(mergeReadiness(cfg('pull-request'), ok)).toEqual(['ok', expect.stringMatching(/pull-request delivery available.*auto-merge off \(opt-in/)]);
    expect(mergeReadiness(cfg('branch'), ok)[1]).toMatch(/branch delivery available/);
    expect(mergeReadiness(cfg('local'), ok)).toEqual(['unavailable', expect.stringMatching(/pull-request delivery is available.*local integration off/)]);
    expect(mergeReadiness(cfg('local'), { onGitHub: false, credential: null })[1]).toMatch(/needs a GitHub remote and token/);
    expect(mergeReadiness(cfg('pull-request'), { onGitHub: true, credential: 'missing' })[0]).toBe('warn');
    expect(mergeReadiness(cfg('pull-request'), { onGitHub: false, credential: null })[0]).toBe('fail');
    for (const m of ['branch', 'pull-request'] as const) expect(mergeReadiness(cfg(m), ok)[1]).toMatch(/auto-merge off \(opt-in: delivery\.merge "auto-when-eligible"/);
    expect(mergeReadiness(cfg('local'), ok)[1]).toMatch(/local integration off: .*opt-in: delivery\.merge "auto-when-eligible"/);
  });
});
