// PR scan and verified base update (task-68.3): git fixture repos (a bare "GitHub" origin), a fake gh; no network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { run as runCmd, type RunResult } from '../../src/core/exec.js';
import {
  attributeEnvProblems, BASE_UPDATE_KIND, commitMerge, deriveApproval, derivedApprovalProblems, mergeTree, unsafeMergeAttributes, withIsolatedRepo, type DerivedApproval,
} from '../../src/runtime/base-update.js';
import { syncTasks } from '../../src/runtime/ci.js';
import type { CiGate } from '../../src/runtime/ci-gate.js';
import { hardenedGit } from '../../src/runtime/git-hardening.js';
import type { GitFn } from '../../src/runtime/github.js';
import { evaluateMergeGate } from '../../src/runtime/merge.js';
import { boundedScan, runPrScan, type ScanReport } from '../../src/runtime/pr-scan.js';
import { publishTask, type GhFn, type PublishInput } from '../../src/runtime/publish.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { abortableGit, git as realGit } from '../../src/runtime/worktree.js';
import { approvalKeys, commitFile, gitSync, makeDefaultEnv, result, tmp, type Env } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';
const TOKEN = 'ghp_' + 'a'.repeat(36);
const R = '/repos/acme/demo';
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });
const passing = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const failing = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];

interface Pr { url: string; headRefName: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergeStateStatus: string; mergeable: string; autoMergeRequest: unknown; rollup: Record<string, unknown[]> }

/** Fake GitHub: the PR head is read live from the bare origin, so pushes move it; CI rollups are per head. */
class ScanGh {
  prs: Pr[] = [];
  calls: string[][] = [];
  constructor(private bare: string) {}
  head(p: Pr) { return execFileSync('git', ['-C', this.bare, 'rev-parse', `refs/heads/${p.headRefName}`], { encoding: 'utf8' }).trim(); }
  lists() { return this.calls.filter((c) => c[0] === 'pr' && c[1] === 'list' && c.includes('--state') && c[c.indexOf('--state') + 1] === 'open' && !c.includes('--head')); }
  merges() { return this.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge'); }
  fn: GhFn = async (args) => {
    this.calls.push(args);
    const flag = (f: string) => args[args.indexOf(f) + 1]!;
    if (args[0] === 'api') {
      const path = args.at(-1)!;
      if (path === `${R}/branches/main`) return ok(JSON.stringify({ name: 'main', protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['test'] } } }));
      if (path === `${R}/rules/branches/main`) return ok('[]');
      if (path.startsWith(`${R}/actions/workflows`)) return ok(JSON.stringify({ total_count: 1 }));
      return bad('gh: Not Found (HTTP 404)');
    }
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('--head')) {
      return ok(JSON.stringify(this.prs.filter((p) => p.headRefName === flag('--head')).map((p) => ({ url: p.url, headRefName: p.headRefName, headRefOid: this.head(p), state: p.state, isCrossRepository: false }))));
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      expect(flag('--json')).toBe('number,url,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,isDraft');
      return ok(JSON.stringify(this.prs.filter((p) => p.state === 'OPEN').map((p, i) => ({ number: i + 1, url: p.url, headRefOid: this.head(p), headRefName: p.headRefName, baseRefName: 'main', mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus, isDraft: false }))));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const url = `https://github.com/acme/demo/pull/${this.prs.length + 1}`;
      this.prs.push({ url, headRefName: flag('--head'), state: 'OPEN', mergeStateStatus: 'BLOCKED', mergeable: 'MERGEABLE', autoMergeRequest: null, rollup: {} });
      return ok(`${url}\n`);
    }
    const p = this.prs.find((x) => x.url === args[2]);
    if (args[0] === 'pr' && args[1] === 'view' && p) {
      const head = this.head(p);
      return ok(JSON.stringify({ url: p.url, state: p.state, isDraft: false, headRefOid: head, baseRefName: 'main', mergedAt: null, closedAt: null,
        mergeStateStatus: p.mergeStateStatus, autoMergeRequest: p.autoMergeRequest, isCrossRepository: false, statusCheckRollup: p.rollup[head] ?? [] }));
    }
    if (args[0] === 'pr' && args[1] === 'merge' && p) {
      if (args.includes('--disable-auto')) { p.autoMergeRequest = null; return ok(''); }
      if (flag('--match-head-commit') !== this.head(p)) return bad('GraphQL: Head branch was modified.');
      p.autoMergeRequest = { mergeMethod: 'SQUASH' };
      return ok('');
    }
    return bad(`unexpected gh call: ${args.join(' ')}`);
  };
}

interface SEnv extends Env { gh: ScanGh; bare: string; other: string }

function scanEnv(mutate?: (c: MinionsConfig) => void): SEnv {
  const env = makeDefaultEnv((c) => {
    c.delivery.provider = 'github';
    c.delivery.mode = 'pull-request';
    c.delivery.merge = 'auto-when-eligible';
    c.delivery.requiredChecksConfigured = true;
    c.verification.ciAuthority = 'github';
    c.capabilities['pr.merge'] = 'allow';
    mutate?.(c);
  });
  const bare = join(tmp('minions-origin-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitSync(env.layout.repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(env.layout.repo, 'config', `url.${bare}.insteadOf`, REMOTE);
  gitSync(env.layout.repo, 'push', '-q', 'origin', 'main');
  // Another clone stands in for other PRs landing on main.
  const other = join(tmp('minions-other-'), 'clone');
  execFileSync('git', ['clone', '-q', bare, other]);
  const tokenFile = join(env.root, 'github-token');
  writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const gh = new ScanGh(bare);
  const keys = approvalKeys();
  const sched = new Scheduler({
    db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, approvalPublicKeyFile: keys.publicKeyFile, gh: gh.fn,
    publisher: (input: PublishInput) => publishTask({ ...input, gh: gh.fn, tokenFile }),
  });
  return { ...env, sched, gh, bare, other };
}

/** engineer commits `file` -> reviewer approves -> published as a PR (delivered). */
async function deliver(env: SEnv, id: string, file = 'a.txt', content = `work ${id}\n`) {
  env.backlog.add({ id, title: `Feature ${id}` });
  const eng = await env.sched.claim(id, 'engineer');
  const head = commitFile(eng.worktree, file, content);
  const e = await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head, modifiedPaths: [file] }));
  if (e.to === 'testing') {
    const t = await env.sched.claim(id, 'tester');
    await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head }));
  }
  const rev = await env.sched.claim(id, 'reviewer');
  const r = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve' }));
  expect(r.publication?.state).toBe('published');
  return { head, branch: eng.branch, worktree: eng.worktree, pr: env.gh.prs.at(-1)! };
}

/** Lands a commit on origin's main from the other clone; returns the new base. */
function landOnMain(env: SEnv, file: string, content: string): string {
  gitSync(env.other, 'pull', '-q', '--ff-only', 'origin', 'main');
  mkdirSync(dirname(join(env.other, file)), { recursive: true });
  writeFileSync(join(env.other, file), content);
  gitSync(env.other, 'add', file);
  gitSync(env.other, 'commit', '-q', '-m', `main: ${file}`);
  gitSync(env.other, 'push', '-q', 'origin', 'HEAD:main');
  return gitSync(env.other, 'rev-parse', 'HEAD');
}

const sync = (env: SEnv) => syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: env.gh.fn, merge: (id) => env.sched.autoMerge(id), scan: (ids) => env.sched.scanPullRequests({ taskIds: ids }) });
const scan = (env: SEnv) => env.sched.scanPullRequests();
const action = (s: ScanReport, id: string) => s.tasks.find((t) => t.taskId === id);
const bareHead = (env: SEnv, branch: string) => gitSync(env.bare, 'rev-parse', `refs/heads/${branch}`);
const parents = (env: SEnv, sha: string) => gitSync(env.layout.repo, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);

describe('PR scan: BEHIND -> verified base update', () => {
  it('clean: merge-tree, commit-tree (H, B), fast-forward push, base-update evidence, publication head moved; derived approval with CI at the new head', async () => {
    const env = scanEnv();
    const { head: H, branch, worktree, pr } = await deliver(env, 'task-1');
    const B = landOnMain(env, 'main.txt', 'from main\n');
    pr.mergeStateStatus = 'BEHIND';

    const before = env.gh.lists().length;
    const s = await scan(env);
    expect(env.gh.lists().length - before).toBe(1); // one gh pr list per scan
    const t = action(s, 'task-1')!;
    expect(t).toMatchObject({ action: 'base-updated', base: B });
    const H2 = t.newHead!;
    expect(bareHead(env, branch)).toBe(H2);
    expect(parents(env, H2)).toEqual([H, B]);
    expect(gitSync(env.layout.repo, 'merge-base', '--is-ancestor', H, H2)).toBe(''); // fast-forward of H
    expect(env.db.publication('task-1')!.head_sha).toBe(H2);
    expect(gitSync(env.layout.repo, 'rev-parse', `refs/heads/${branch}`)).toBe(H2);
    expect(gitSync(worktree, 'rev-parse', 'HEAD')).toBe(H2); // the clean worktree moved with it
    expect(gitSync(worktree, 'status', '--porcelain')).toBe('');
    const ev = env.db.evidenceFor('task-1', H2, BASE_UPDATE_KIND);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.details_json!)).toEqual({ from: H, base: B, tree: gitSync(env.layout.repo, 'rev-parse', `${H2}^{tree}`) });
    expect(env.backlog.status('task-1')).toBe('delivered');

    // CI is never derived: without checks at H' the gate waits on CI only (the review carries over).
    pr.mergeStateStatus = 'BLOCKED';
    pr.rollup[H] = passing;
    let m = await env.sched.autoMerge('task-1');
    expect(m.state).toBe('waiting');
    expect(m.reasons.join(' ')).toMatch(/CI gate missing/);
    expect(m.reasons.join(' ')).not.toMatch(/reviewer approval/);
    pr.rollup[H2] = [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null }];
    await sync(env);
    expect((await env.sched.autoMerge('task-1')).reasons.join(' ')).toMatch(/CI gate pending/);

    pr.rollup[H2] = passing;
    const r = await sync(env);
    expect(r.tasks[0]!.merge).toMatchObject({ state: 'armed', head: H2 });
    expect(env.gh.merges().at(-1)).toEqual(['pr', 'merge', pr.url, '--auto', '--squash', '--match-head-commit', H2]);
  });

  it('disarms auto-merge minions armed before pushing the base update', async () => {
    const env = scanEnv();
    const { head: H, pr } = await deliver(env, 'task-1');
    pr.rollup[H] = passing;
    expect((await sync(env)).tasks[0]!.merge?.state).toBe('armed');
    landOnMain(env, 'main.txt', 'x\n');
    pr.mergeStateStatus = 'BEHIND';
    const s = await scan(env);
    expect(action(s, 'task-1')!.action).toBe('base-updated');
    const calls = env.gh.merges().map((c) => c.join(' '));
    expect(calls.at(-1)).toBe(`pr merge ${pr.url} --disable-auto`);
    expect(env.db.evidenceOfKind('task-1', 'merge').at(-1)!.outcome).toBe('disarmed');
  });

  it('conflict: confirmed by merge-tree, reported (needs-rebase hook), nothing pushed or moved', async () => {
    const env = scanEnv();
    const { head: H, branch } = await deliver(env, 'task-1', 'shared.txt', 'branch side\n');
    const B = landOnMain(env, 'shared.txt', 'main side\n');
    env.gh.prs[0]!.mergeStateStatus = 'DIRTY';
    env.gh.prs[0]!.mergeable = 'CONFLICTING';
    const seen: unknown[] = [];
    const s = await env.sched.scanPullRequests({ onConflict: async (c) => { seen.push(c); } });
    expect(action(s, 'task-1')).toMatchObject({ action: 'conflict', conflictFiles: ['shared.txt'], base: B });
    expect(seen).toEqual([expect.objectContaining({ taskId: 'task-1', head: H, base: B, files: ['shared.txt'] })]);
    expect(bareHead(env, branch)).toBe(H);
    expect(env.db.publication('task-1')!.head_sha).toBe(H);
    expect(env.backlog.status('task-1')).toBe('delivered');
  });

  it('DIRTY that a fresh merge-tree finds clean is updated like BEHIND', async () => {
    const env = scanEnv();
    await deliver(env, 'task-1');
    landOnMain(env, 'main.txt', 'x\n');
    env.gh.prs[0]!.mergeStateStatus = 'DIRTY';
    expect(action(await scan(env), 'task-1')!.action).toBe('base-updated');
  });

  it('non-fast-forward: a push that races another push is rejected, skipped and recorded; nothing moves', async () => {
    const env = scanEnv();
    const { head: H, branch } = await deliver(env, 'task-1');
    landOnMain(env, 'main.txt', 'x\n');
    env.gh.prs[0]!.mergeStateStatus = 'BEHIND';
    // Someone pushes to the PR branch right before minions' push (after its ls-remote check).
    const racing: GitFn = async (cwd, args, allow) => {
      if (args[0] === 'push') {
        gitSync(env.other, 'fetch', '-q', 'origin', branch);
        gitSync(env.other, 'checkout', '-q', '-B', 'side', 'FETCH_HEAD');
        writeFileSync(join(env.other, 'side.txt'), 'foreign\n');
        gitSync(env.other, 'add', 'side.txt');
        gitSync(env.other, 'commit', '-q', '-m', 'foreign');
        gitSync(env.other, 'push', '-q', 'origin', `HEAD:${branch}`);
      }
      return realGit(cwd, args, allow);
    };
    const s = await runPrScan(scanDeps(env, { git: racing }));
    expect(action(s, 'task-1')).toMatchObject({ action: 'base-update-failed', message: expect.stringMatching(/someone else pushed/) });
    expect(env.db.publication('task-1')!.head_sha).toBe(H);
    expect(gitSync(env.layout.repo, 'rev-parse', `refs/heads/${branch}`)).toBe(H);
    expect(env.db.events('task-1', 'base-update').at(-1)!.data).toMatchObject({ state: 'rejected' });
    // The foreign head is never adopted.
    expect(action(await scan(env), 'task-1')!.action).toBe('foreign-push');
  });

  it('chain: H -> H\' -> H\'\' keeps the derived approval; one update in flight until CI at the new head finishes', async () => {
    const env = scanEnv();
    const { head: H, pr } = await deliver(env, 'task-1');
    landOnMain(env, 'm1.txt', '1\n');
    pr.mergeStateStatus = 'BEHIND';
    const H1 = action(await scan(env), 'task-1')!.newHead!;
    landOnMain(env, 'm2.txt', '2\n');
    // CI at H' has not finished: the next update waits (the scan inside sync defers it).
    let s = await sync(env);
    expect(action(s.scan!, 'task-1')).toMatchObject({ action: 'deferred' });
    pr.rollup[H1] = passing;
    pr.mergeStateStatus = 'BLOCKED';
    await sync(env); // observes CI pass at H' (arms; a base update disarms below)
    pr.mergeStateStatus = 'BEHIND';
    s = await sync(env);
    const H2 = action(s.scan!, 'task-1')!.newHead!;
    expect(parents(env, H2)).toEqual([H1, expect.any(String)]);
    expect(parents(env, H1)[0]).toBe(H);
    pr.rollup[H2] = passing;
    pr.mergeStateStatus = 'BLOCKED';
    const r = await sync(env);
    expect(r.tasks[0]!.merge).toMatchObject({ state: 'armed', head: H2 });

    // The chain cap: a derivation limited to 1 link does not reach the reviewed head.
    const serverBase = gitSync(env.bare, 'rev-parse', 'refs/heads/main');
    const isReviewed = (h: string) => h === H;
    const d1 = await deriveApproval({ git: realGit, repo: env.layout.repo, db: env.db, taskId: 'task-1', head: H2, configRevision: env.config.configRevision, serverBase, isReviewed, maxChain: 1 });
    expect(d1.reviewedHead).toBeNull();
    expect(derivedApprovalProblems(d1, H2).join(' ')).toMatch(/more than 1 base updates|does not end at reviewer evidence/);
    const d2 = await deriveApproval({ git: realGit, repo: env.layout.repo, db: env.db, taskId: 'task-1', head: H2, configRevision: env.config.configRevision, serverBase, isReviewed });
    expect(d2.reviewedHead).toBe(H);
    expect(derivedApprovalProblems(d2, H2)).toEqual([]);
  });

  it('one update in flight across PRs: the second behind PR waits for the first one\'s CI', async () => {
    const env = scanEnv();
    await deliver(env, 'task-1', 'a.txt');
    await deliver(env, 'task-2', 'b.txt');
    landOnMain(env, 'main.txt', 'x\n');
    for (const p of env.gh.prs) p.mergeStateStatus = 'BEHIND';
    const s = await scan(env);
    expect(s.tasks.map((t) => t.action).sort()).toEqual(['base-updated', 'deferred']);
    expect(s.tasks.find((t) => t.action === 'deferred')!.message).toMatch(/one in flight/);
  });

  it('routine.maxBaseUpdatesPerTask caps updates per task (0 = off)', async () => {
    const env = scanEnv((c) => { c.routine = { maxBaseUpdatesPerTask: 0 }; });
    const { head: H } = await deliver(env, 'task-1');
    landOnMain(env, 'main.txt', 'x\n');
    env.gh.prs[0]!.mergeStateStatus = 'BEHIND';
    expect(action(await scan(env), 'task-1')).toMatchObject({ action: 'skipped', message: expect.stringMatching(/maxBaseUpdatesPerTask reached \(0\/0/) });
    expect(env.db.publication('task-1')!.head_sha).toBe(H);
  });

  it('refuses custom and union merge drivers (.gitattributes): no base update', async () => {
    const env = scanEnv();
    const { head: H } = await deliver(env, 'task-1');
    landOnMain(env, '.gitattributes', '*.txt merge=union\n');
    env.gh.prs[0]!.mergeStateStatus = 'BEHIND';
    expect(action(await scan(env), 'task-1')).toMatchObject({ action: 'skipped', message: expect.stringMatching(/union merge drivers/) });
    expect(env.db.publication('task-1')!.head_sha).toBe(H);
    expect(unsafeMergeAttributes('# c\n*.lock merge=ours\n*.md merge=text\n*.bin merge=binary -diff\n[attr]u merge=union')).toEqual(['*.lock merge=ours', '[attr]u merge=union']);
  });

  it('never touches a task with an active lease, and is off without auto-merge (no gh call)', async () => {
    const env = scanEnv();
    await deliver(env, 'task-1');
    landOnMain(env, 'main.txt', 'x\n');
    env.gh.prs[0]!.mergeStateStatus = 'BEHIND';
    env.db.exec("INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('lease-x', 'task-1', 'engineer', 9, 1, '2026-01-01', 'active')");
    expect(action(await scan(env), 'task-1')).toMatchObject({ action: 'skipped', message: expect.stringMatching(/active lease/) });
    env.db.exec("UPDATE leases SET status = 'released' WHERE id = 'lease-x'");

    const offEnv = scanEnv((c) => { c.delivery.merge = 'disabled'; });
    const n = offEnv.gh.calls.length;
    expect((await scan(offEnv)).state).toBe('off');
    expect(offEnv.gh.calls.length).toBe(n);
  });
});

/** ScanDeps for runPrScan with injected git (the scheduler wires the same). */
function scanDeps(env: SEnv, o: { git?: GitFn } = {}) {
  return {
    db: env.db, backlog: env.backlog, config: env.config, repo: env.layout.repo, gh: env.gh.fn, git: o.git ?? realGit,
    ciGate: (id: string, head: string) => env.sched.ciGate(id, head),
    ciRepair: (id: string, head: string, f: string[]) => env.sched.ciRepair(id, head, f),
  };
}

describe('derived approval is recomputed from git objects (the record is only a hint)', () => {
  /** A delivered task whose publication and PR were moved to `forged` with a base-update record `rec` (a forged DB). */
  async function forge(env: SEnv, make: (H: string, B: string) => { sha: string; rec: Record<string, string>; revision?: number }) {
    const { head: H, branch, pr } = await deliver(env, 'task-1');
    const B = landOnMain(env, 'main.txt', 'x\n');
    gitSync(env.layout.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const f = make(H, B);
    env.db.addEvidence({ task_id: 'task-1', head_sha: f.sha, kind: BASE_UPDATE_KIND, config_revision: f.revision ?? env.config.configRevision, outcome: 'prepared', details_json: JSON.stringify(f.rec) });
    gitSync(env.layout.repo, 'push', '-q', 'origin', `${f.sha}:refs/heads/${branch}`);
    expect(env.db.movePublicationHead('task-1', H, f.sha)).toBe(true);
    pr.rollup[f.sha] = passing;
    await sync(env);
    return { H, B, sha: f.sha };
  }
  const tree = (env: SEnv, rev: string) => gitSync(env.layout.repo, 'rev-parse', `${rev}^{tree}`);
  const commit = (env: SEnv, t: string, ...ps: string[]) => gitSync(env.layout.repo, 'commit-tree', t, ...ps.flatMap((p) => ['-p', p]), '-m', 'forged');

  it('forged parent: a second parent that is not on the server base is refused (ancestry)', async () => {
    const env = scanEnv();
    const { sha } = await forge(env, (H) => {
      // An agent-made "base" with unreviewed content, merged cleanly.
      const x2 = commitFile(join(env.layout.repo), 'evil.txt', 'unreviewed\n'); // on local main, never pushed
      const mt = gitSync(env.layout.repo, 'merge-tree', '--write-tree', H, x2);
      return { sha: commit(env, mt, H, x2), rec: { from: H, base: x2, tree: mt } };
    });
    const m = await env.sched.autoMerge('task-1');
    expect(m.state).toBe('waiting');
    expect(m.reasons.join(' ')).toMatch(/derived approval refused: .*not on the server's base/);
    expect(m.head).toBe(sha);
  });

  it('forged record: a record naming other parents than git has is refused', async () => {
    const env = scanEnv();
    await forge(env, (H, B) => {
      const mt = gitSync(env.layout.repo, 'merge-tree', '--write-tree', H, B);
      // Real (H, B) merge, but the record claims a different base (and so a different parent).
      return { sha: commit(env, mt, H, B), rec: { from: H, base: H, tree: mt } };
    });
    expect((await env.sched.autoMerge('task-1')).reasons.join(' ')).toMatch(/derived approval refused: .*names parents/);
  });

  it('tree mismatch: parents (H, B) but a tree that is not their merge-tree is refused', async () => {
    const env = scanEnv();
    await forge(env, (H, B) => {
      const wt = join(tmp('minions-forge-'), 'wt');
      gitSync(env.layout.repo, 'worktree', 'add', '-q', '--detach', wt, B);
      gitSync(wt, 'merge', '-q', '--no-edit', H);
      commitFile(wt, 'extra.txt', 'sneaked in\n');
      const t = tree(env, gitSync(wt, 'rev-parse', 'HEAD'));
      return { sha: commit(env, t, H, B), rec: { from: H, base: B, tree: t } };
    });
    expect((await env.sched.autoMerge('task-1')).reasons.join(' ')).toMatch(/derived approval refused: .*is not the merge-tree of its parents/);
  });

  it('a record from another config revision is refused (revision)', async () => {
    const env = scanEnv();
    await forge(env, (H, B) => {
      const mt = gitSync(env.layout.repo, 'merge-tree', '--write-tree', H, B);
      return { sha: commit(env, mt, H, B), rec: { from: H, base: B, tree: mt }, revision: env.config.configRevision + 7 };
    });
    expect((await env.sched.autoMerge('task-1')).reasons.join(' ')).toMatch(/derived approval refused: .*config revision/);
  });

  it('a genuine (H, B) merge-tree commit passes, and its sensitive paths are the union (reviewed paths + diff(B, H\'))', async () => {
    const env = scanEnv((c) => { c.sensitivePaths = ['main.txt']; });
    await forge(env, (H, B) => {
      const mt = gitSync(env.layout.repo, 'merge-tree', '--write-tree', H, B);
      return { sha: commit(env, mt, H, B), rec: { from: H, base: B, tree: mt } };
    });
    // Reviewed (derived) and CI pass at H'; main.txt came from main and is not the branch's change.
    expect((await env.sched.autoMerge('task-1')).state).toBe('armed');
    // The reviewed head's paths stay in the union: a.txt becoming sensitive needs a human merge approval.
    env.config.sensitivePaths.push('a.txt');
    const m = await env.sched.autoMerge('task-1');
    expect(m.state).toBe('disarmed');
    expect(m.reasons.join(' ')).toMatch(/sensitive paths \(a\.txt\)/);
  });
});

describe('crash window between the push and moving the publication head', () => {
  it('adopts a pushed head that is a verified base update; anything else is a foreign push', async () => {
    const env = scanEnv();
    const { head: H, branch } = await deliver(env, 'task-1');
    const B = landOnMain(env, 'main.txt', 'x\n');
    gitSync(env.layout.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const mt = await mergeTree(realGit, env.layout.repo, H, B);
    if (mt.state !== 'clean') throw new Error('expected clean');
    const made = await commitMerge(realGit, env.layout.repo, { tree: mt.tree, head: H, base: B, baseBranch: 'main', identity: env.config.git.identity });
    if ('error' in made) throw new Error(made.error);
    env.db.addEvidence({ task_id: 'task-1', head_sha: made.sha, kind: BASE_UPDATE_KIND, config_revision: env.config.configRevision, outcome: 'prepared', details_json: JSON.stringify({ from: H, base: B, tree: mt.tree }) });
    gitSync(env.layout.repo, 'push', '-q', 'origin', `${made.sha}:refs/heads/${branch}`);
    // ... the process died here: publication still at H.
    const s = await scan(env);
    expect(action(s, 'task-1')).toMatchObject({ action: 'adopted', newHead: made.sha });
    expect(env.db.publication('task-1')!.head_sha).toBe(made.sha);
    expect(gitSync(env.layout.repo, 'rev-parse', `refs/heads/${branch}`)).toBe(made.sha);
  });

  it('a pushed head without a valid record is left alone as a foreign push', async () => {
    const env = scanEnv();
    const { head: H, branch } = await deliver(env, 'task-1');
    gitSync(env.other, 'fetch', '-q', 'origin', branch);
    gitSync(env.other, 'checkout', '-q', '-B', 'x', 'FETCH_HEAD');
    const F = commitFile(env.other, 'f.txt', 'foreign\n');
    gitSync(env.other, 'push', '-q', 'origin', `HEAD:${branch}`);
    const s = await scan(env);
    expect(action(s, 'task-1')).toMatchObject({ action: 'foreign-push' });
    expect(env.db.publication('task-1')!.head_sha).toBe(H);
    expect(env.db.events('task-1', 'foreign-push')).toHaveLength(1);
    await scan(env);
    expect(env.db.events('task-1', 'foreign-push')).toHaveLength(1); // once per head
    expect(F).not.toBe(H);
  });
});

describe('CI failure at the approved head -> changes-requested as a repair cycle', () => {
  it('moves the task to the engineer with the failing checks as findings; at a base update it says semantic conflict', async () => {
    const env = scanEnv();
    const { pr } = await deliver(env, 'task-1');
    landOnMain(env, 'main.txt', 'x\n');
    pr.mergeStateStatus = 'BEHIND';
    const H2 = action(await scan(env), 'task-1')!.newHead!;
    pr.mergeStateStatus = 'BLOCKED';
    pr.rollup[H2] = failing;
    const s = await sync(env);
    expect(action(s.scan!, 'task-1')).toMatchObject({ action: 'ci-repair', to: 'changes-requested', repairCycles: 1 });
    expect(env.backlog.status('task-1')).toBe('changes-requested');
    expect(env.db.repairCycles('task-1')).toBe(1);
    // The merge pass never arms a task under repair.
    pr.rollup[H2] = passing;
    expect((await env.sched.autoMerge('task-1')).reasons.join(' ')).toMatch(/the task is changes-requested, not delivered/);
    // The engineer brief carries the findings.
    const brief = await env.sched.claim('task-1', 'engineer');
    const ci = brief.priorFindings.find((f) => f.role === 'ci')!;
    expect(ci.findings.join(' ')).toMatch(/required checks fail at the approved head .* test/);
    expect(ci.findings.join(' ')).toMatch(/likely a semantic conflict/);
    expect(brief.expectedHead).toBe(H2);
  });

  it('at the repair limit the task goes to awaiting-human (replan)', async () => {
    const env = scanEnv((c) => { c.execution.maxRepairCyclesBeforeReplan = 1; });
    const { head: H, pr } = await deliver(env, 'task-1');
    pr.rollup[H] = failing;
    const s = await sync(env);
    expect(action(s.scan!, 'task-1')).toMatchObject({ action: 'ci-repair', to: 'awaiting-human' });
    expect(env.backlog.status('task-1')).toBe('awaiting-human');
  });
});

describe('merge gate: derived approval is checked structurally (pure)', () => {
  const ci: CiGate = { state: 'pass', head: 'h2', requiredChecks: ['test'], passed: ['test'], failed: [], pending: [], observedAt: null, firstObservedAt: null, timeoutMinutes: 60, reasons: [] };
  const sha = (c: string) => c.repeat(40);
  const link = (head: string, from: string, over: Partial<DerivedApproval['links'][0]['checks']> = {}) =>
    ({ head, from, base: sha('b'), checks: { record: true, parents: true, ancestry: true, tree: true, revision: true, ...over }, problems: [] });
  const gate = (derived: DerivedApproval | undefined, reviewed = false) => evaluateMergeGate({
    config: scanEnv().config, approvedHead: sha('2'), reviewed, taskStatus: 'delivered', ...(derived ? { derived } : {}), ci: { ...ci, head: sha('2') },
    pr: { headRefOid: sha('2'), baseRefName: 'main', isDraft: false }, paths: { ok: true, changedPaths: ['a.txt'], sensitivePaths: [] }, approval: () => ({ ok: true }),
  });
  it('accepts a contiguous verified chain ending at reviewer evidence and refuses anything else', () => {
    const good: DerivedApproval = { head: sha('2'), reviewedHead: sha('0'), serverBase: sha('b'), problems: [], links: [link(sha('2'), sha('1')), link(sha('1'), sha('0'))] };
    expect(gate(good).state).toBe('eligible');
    expect(gate(undefined).reasons.join(' ')).toMatch(/no reviewer approval/);
    expect(gate({ ...good, links: [link(sha('2'), sha('1')), link(sha('9'), sha('0'))] }).reasons.join(' ')).toMatch(/chain is broken/);
    expect(gate({ ...good, links: [link(sha('2'), sha('1'), { ancestry: false }), link(sha('1'), sha('0'))] }).reasons.join(' ')).toMatch(/fails: ancestry/);
    expect(gate({ ...good, reviewedHead: sha('7') }).reasons.join(' ')).toMatch(/does not end at reviewer evidence/);
    expect(gate({ ...good, head: sha('3') }).reasons.join(' ')).toMatch(/not the approved head/);
    const long = Array.from({ length: 9 }, (_, i) => link(sha(String(9 - i)), sha(String(8 - i))));
    expect(gate({ ...good, head: sha('9'), links: long }).state).toBe('waiting');
  });
});

describe('boundedScan (after work record / release)', () => {
  it('never throws, reports errors and stops waiting at the budget', async () => {
    expect(await boundedScan(async () => { throw new Error('boom'); })).toMatchObject({ state: 'error', message: expect.stringMatching(/boom/) });
    expect(await boundedScan(() => new Promise(() => {}), 20)).toMatchObject({ state: 'budget' });
    let seen = 0;
    const r = await boundedScan(async (deadline) => { seen = deadline; return { state: 'ran', prs: 0, tasks: [], message: 'ok' }; }, 60_000, () => 1000);
    expect(r).toMatchObject({ state: 'ran', message: 'ok' });
    expect(seen).toBe(61_000);
  });
});

describe('merge attributes outside the commits\' trees never count (isolated merge-tree)', () => {
  /** The PR and main each add sub/s.txt with a different last line: a real conflict. */
  async function conflicting(env: SEnv) {
    const d = await deliver(env, 'task-1', 'sub/s.txt', 'l1\nl2\nBRANCH\n');
    const B = landOnMain(env, 'sub/s.txt', 'l1\nl2\nMAIN\n');
    d.pr.mergeStateStatus = 'DIRTY';
    d.pr.mergeable = 'CONFLICTING';
    return { ...d, B };
  }
  /** What an agent can write in the runtime checkout: an untracked, nested .gitattributes with merge=union. */
  const plantUnion = (env: SEnv) => writeFileSync(join(env.layout.repo, 'sub', '.gitattributes'), 's.txt merge=union\n');

  it('regression: an untracked nested .gitattributes (and the index, info/attributes, merge.default) in the checkout does not make a conflict clean', async () => {
    const env = scanEnv();
    const { head: H, branch, B } = await conflicting(env);
    expect(action(await scan(env), 'task-1')).toMatchObject({ action: 'conflict', conflictFiles: ['sub/s.txt'] });

    mkdirSync(join(env.layout.repo, 'sub'), { recursive: true });
    plantUnion(env);
    // Plain git in the checkout follows it (the defect this guards against): the merge is "clean" there.
    expect(gitSync(env.layout.repo, 'merge-tree', '--write-tree', H, B)).toMatch(/^[0-9a-f]{40}$/);
    let s = await scan(env);
    expect(action(s, 'task-1')).toMatchObject({ action: 'conflict', conflictFiles: ['sub/s.txt'], base: B });

    // The same through the checkout's index, .git/info/attributes and the repository config.
    gitSync(env.layout.repo, 'add', '-f', 'sub/.gitattributes');
    writeFileSync(join(env.layout.repo, '.git', 'info', 'attributes'), 'sub/s.txt merge=union\n');
    gitSync(env.layout.repo, 'config', 'merge.default', 'union');
    s = await scan(env);
    expect(action(s, 'task-1')).toMatchObject({ action: 'conflict', conflictFiles: ['sub/s.txt'] });

    // Nothing was updated, recorded or pushed.
    expect(bareHead(env, branch)).toBe(H);
    expect(env.db.publication('task-1')!.head_sha).toBe(H);
    expect(env.db.evidenceOfKind('task-1', BASE_UPDATE_KIND)).toHaveLength(0);
    expect(env.db.events('task-1', 'base-update')).toHaveLength(0);
  });

  it('a union-merged H\' made by git in the checkout never gets the derived approval (merge gate re-check is isolated too)', async () => {
    const env = scanEnv();
    const { head: H, branch, pr, B } = await conflicting(env);
    gitSync(env.layout.repo, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    mkdirSync(join(env.layout.repo, 'sub'), { recursive: true });
    plantUnion(env);
    const t = gitSync(env.layout.repo, 'merge-tree', '--write-tree', H, B);
    const H2 = gitSync(env.layout.repo, 'commit-tree', t, '-p', H, '-p', B, '-m', 'union merge');
    env.db.addEvidence({ task_id: 'task-1', head_sha: H2, kind: BASE_UPDATE_KIND, config_revision: env.config.configRevision, outcome: 'prepared', details_json: JSON.stringify({ from: H, base: B, tree: t }) });
    gitSync(env.layout.repo, 'push', '-q', 'origin', `${H2}:refs/heads/${branch}`);
    expect(env.db.movePublicationHead('task-1', H, H2)).toBe(true);
    pr.mergeStateStatus = 'BLOCKED';
    pr.mergeable = 'MERGEABLE';
    pr.rollup[H2] = passing;
    const r = await sync(env);
    expect(r.tasks[0]!.merge?.state).toBe('waiting');
    const m = await env.sched.autoMerge('task-1');
    expect(m.state).toBe('waiting');
    expect(m.reasons.join(' ')).toMatch(/derived approval refused: .*conflicts \(sub\/s\.txt\)/);
    expect(env.gh.merges().filter((c) => c.includes('--auto'))).toHaveLength(0);
  });
});

describe('merge gate: the task status must be readable', () => {
  it('refuses to arm when the backlog read fails (fail closed), arms once it is readable', async () => {
    const env = scanEnv();
    const { head: H, pr } = await deliver(env, 'task-1');
    pr.rollup[H] = passing;
    const spy = vi.spyOn(env.backlog, 'getTask').mockRejectedValue(new Error('backlog unavailable'));
    const m = (await sync(env)).tasks[0]!.merge!;
    spy.mockRestore();
    expect(m.state).toBe('waiting');
    expect(m.reasons).toEqual(['the task status could not be read from the backlog']); // CI and review pass
    expect(env.gh.merges()).toHaveLength(0);
    expect((await sync(env)).tasks[0]!.merge?.state).toBe('armed');
  });
});

describe('boundedScan cancels the scan at the budget', () => {
  it('aborts the signal: an in-flight child is killed, not just abandoned', async () => {
    let sig: AbortSignal | undefined;
    let child: Promise<RunResult> | undefined;
    const t0 = Date.now();
    const r = await boundedScan((_deadline, signal) => {
      sig = signal;
      child = runCmd('sleep', ['30'], { signal, allowFailure: true });
      return child.then((): ScanReport => ({ state: 'ran', prs: 0, tasks: [], message: 'late' }));
    }, 50);
    expect(r.state).toBe('budget');
    expect(sig!.aborted).toBe(true);
    const c = await child!;
    expect(c).toMatchObject({ aborted: true, code: 130 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    // abortableGit spawns nothing once aborted.
    expect(await abortableGit(sig!)(process.cwd(), ['--version'], true)).toMatchObject({ aborted: true, code: 130 });
  });

  it('an aborted scan stops before the next task: no base update is started', async () => {
    const env = scanEnv();
    const { head: H, branch } = await deliver(env, 'task-1');
    landOnMain(env, 'main.txt', 'x\n');
    env.gh.prs[0]!.mergeStateStatus = 'BEHIND';
    const ctl = new AbortController();
    ctl.abort();
    const s = await runPrScan({ ...scanDeps(env), signal: ctl.signal });
    expect(s.state).toBe('budget');
    expect(action(s, 'task-1')).toMatchObject({ action: 'deferred', message: expect.stringMatching(/aborted/) });
    expect(bareHead(env, branch)).toBe(H);
    expect(env.db.publication('task-1')!.head_sha).toBe(H);
  });
});

describe('withIsolatedRepo / mergeTree on fixture repos', () => {
  /** base -> (ours, theirs) each changing f.txt's last line (conflict) or different files (clean). */
  function repoWith(format: 'sha1' | 'sha256', conflict: boolean) {
    const repo = join(tmp('minions-iso-repo-'), 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', `--object-format=${format}`, repo]);
    commitFile(repo, 'sub/f.txt', 'l1\nl2\n');
    gitSync(repo, 'checkout', '-q', '-b', 'ours');
    const ours = commitFile(repo, conflict ? 'sub/f.txt' : 'o.txt', 'l1\nl2\nOURS\n');
    gitSync(repo, 'checkout', '-q', 'main');
    const theirs = commitFile(repo, conflict ? 'sub/f.txt' : 't.txt', 'l1\nl2\nTHEIRS\n');
    writeFileSync(join(repo, 'sub', '.gitattributes'), 'f.txt merge=union\n'); // untracked, in the checkout
    return { repo, ours, theirs };
  }
  const hardened: GitFn = (cwd, args, allow) => hardenedGit(cwd, args, !!allow);

  for (const format of ['sha1', 'sha256'] as const) {
    it(`${format}: clean merges write the tree into the repository's object store; checkout attributes are ignored (container and host git)`, async () => {
      for (const g of [realGit, hardened]) {
        const c = repoWith(format, false);
        const mt = await mergeTree(g, c.repo, c.ours, c.theirs);
        expect(mt.state).toBe('clean');
        if (mt.state !== 'clean') continue;
        expect(gitSync(c.repo, 'cat-file', '-t', mt.tree)).toBe('tree'); // commit-tree in the repo can use it
        const x = repoWith(format, true);
        expect(await mergeTree(g, x.repo, x.ours, x.theirs)).toMatchObject({ state: 'conflict', files: ['sub/f.txt'] });
      }
    });
  }

  it('leaves no temporary directory behind and refuses GIT_ATTR_SOURCE in the environment', async () => {
    const c = repoWith('sha1', false);
    let dir = '';
    await withIsolatedRepo(realGit, c.repo, async (iso) => { dir = iso.dir; expect(existsSync(dir)).toBe(true); });
    expect(existsSync(dirname(dir))).toBe(false);
    expect(attributeEnvProblems({ GIT_ATTR_SOURCE: 'HEAD' })).toEqual(['GIT_ATTR_SOURCE is set in the environment']);
    expect(attributeEnvProblems({})).toEqual([]);
    process.env.GIT_ATTR_SOURCE = 'HEAD';
    try {
      expect(await mergeTree(realGit, c.repo, c.ours, c.theirs)).toMatchObject({ state: 'refused', message: expect.stringMatching(/GIT_ATTR_SOURCE/) });
    } finally { delete process.env.GIT_ATTR_SOURCE; }
  });
});
