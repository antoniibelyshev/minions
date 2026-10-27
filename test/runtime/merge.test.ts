// CI-gated auto-merge (task-1.9): every gh call is mocked; nothing touches GitHub or the live /state.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signApproval, verifyApproval } from '../../src/core/approval.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import type { RunResult } from '../../src/core/exec.js';
import { approveOnHost } from '../../src/host/approvals.js';
import { autoMergeReadiness, mergeReadiness } from '../../src/host/doctor.js';
import { formatSync, syncTasks, type RequiredChecksReport } from '../../src/runtime/ci.js';
import type { CiGate } from '../../src/runtime/ci-gate.js';
import { armedByMinions, evaluateMergeGate, type MergeGateInput } from '../../src/runtime/merge.js';
import { publishTask, type GhFn, type PublishInput } from '../../src/runtime/publish.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { defaults } from '../helpers.js';
import { approvalKeys, commitFile, gitSync, makeDefaultEnv, result, tmp, type Env } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';
const TOKEN = 'ghp_' + 'a'.repeat(36);
const R = '/repos/acme/demo';

interface Pr {
  url: string; headRefName: string; headRefOid: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean; base: string;
  mergeStateStatus: string; autoMergeRequest: { mergeMethod: string } | null; mergedAt: string | null; rollup: unknown[];
}

const okRun = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

/** Mocked GitHub for one repository: required checks (GET), PR list/create/view, and `pr merge`. */
class MergeGh {
  prs: Pr[] = [];
  calls: string[][] = [];
  required: string[] = ['test'];
  armError: string | null = null;
  directError: string | null = null;
  disableError: string | null = null;
  /** gh/GitHub merges right away when auto-merge is requested and nothing is pending. */
  mergeOnArm = false;
  constructor(private bare: string) {}
  pr(i = 0) { return this.prs[i]!; }
  merges() { return this.calls.filter((c) => c[0] === 'pr' && c[1] === 'merge'); }
  fn: GhFn = async (args) => {
    this.calls.push(args);
    if (args.includes('--admin')) throw new Error('minions must never pass --admin');
    const flag = (f: string) => args[args.indexOf(f) + 1]!;
    if (args[0] === 'api') {
      expect(args.slice(1, 3)).toEqual(['--method', 'GET']);
      const path = args.at(-1)!;
      // The commit is the verified base read (task-71): GitHub's view of origin's main is the bare repository.
      if (path === `${R}/branches/main`) {
        const sha = execFileSync('git', ['-C', this.bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
        return okRun(JSON.stringify({ name: 'main', commit: { sha }, protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: this.required } } }));
      }
      if (path === `${R}/rules/branches/main`) return okRun('[]');
      if (path.startsWith(`${R}/actions/workflows`)) return okRun(JSON.stringify({ total_count: 1 }));
      return bad('gh: Not Found (HTTP 404)');
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return okRun(JSON.stringify(this.prs.filter((p) => p.headRefName === flag('--head')).map((p) => ({ url: p.url, headRefName: p.headRefName, headRefOid: p.headRefOid, state: p.state, isCrossRepository: false }))));
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const head = flag('--head');
      const oid = execFileSync('git', ['-C', this.bare, 'rev-parse', `refs/heads/${head}`], { encoding: 'utf8' }).trim();
      const url = `https://github.com/acme/demo/pull/${this.prs.length + 1}`;
      this.prs.push({ url, headRefName: head, headRefOid: oid, state: 'OPEN', isDraft: false, base: flag('--base'), mergeStateStatus: 'BLOCKED', autoMergeRequest: null, mergedAt: null, rollup: [] });
      return okRun(`${url}\n`);
    }
    const p = this.prs.find((x) => x.url === args[2]);
    if (args[0] === 'pr' && args[1] === 'view' && p) {
      return okRun(JSON.stringify({ url: p.url, state: p.state, isDraft: p.isDraft, headRefOid: p.headRefOid, baseRefName: p.base, mergedAt: p.mergedAt, closedAt: null,
        mergeStateStatus: p.mergeStateStatus, autoMergeRequest: p.autoMergeRequest, isCrossRepository: false, statusCheckRollup: p.rollup }));
    }
    if (args[0] === 'pr' && args[1] === 'merge' && p) {
      if (args.includes('--disable-auto')) {
        if (this.disableError) return bad(this.disableError);
        p.autoMergeRequest = null;
        return okRun('');
      }
      if (args.includes('--match-head-commit') && flag('--match-head-commit') !== p.headRefOid) return bad('GraphQL: Head branch was modified. Review and try the merge again.');
      if (args.includes('--auto')) {
        if (this.armError) return bad(this.armError);
        if (this.mergeOnArm) { p.state = 'MERGED'; p.mergedAt = '2026-10-20T12:00:00Z'; return okRun(''); }
        p.autoMergeRequest = { mergeMethod: args.find((a) => /^--(squash|merge|rebase)$/.test(a))!.slice(2).toUpperCase() };
        return okRun('');
      }
      if (this.directError) return bad(this.directError);
      p.state = 'MERGED'; p.mergedAt = '2026-10-20T12:00:00Z';
      return okRun('');
    }
    return bad(`unexpected gh call: ${args.join(' ')}`);
  };
}

interface MEnv extends Env { gh: MergeGh; keys: ReturnType<typeof approvalKeys>; bare: string }

/** Pull-request delivery with auto-merge opted in, CI authority github, required check `test`. */
function mergeEnv(mutate?: (c: MinionsConfig) => void): MEnv {
  const env = makeDefaultEnv((c) => {
    c.delivery.provider = 'github';
    c.delivery.mode = 'pull-request';
    c.delivery.merge = 'auto-when-eligible';
    c.delivery.requiredChecksConfigured = true;
    c.verification.ciAuthority = 'github';
    mutate?.(c);
  });
  const bare = join(tmp('minions-origin-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitSync(env.layout.repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(env.layout.repo, 'config', `url.${bare}.insteadOf`, REMOTE);
  gitSync(env.layout.repo, 'push', '-q', 'origin', 'main');
  const tokenFile = join(env.root, 'github-token');
  writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const gh = new MergeGh(bare);
  const keys = approvalKeys();
  const sched = new Scheduler({
    db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, approvalPublicKeyFile: keys.publicKeyFile, gh: gh.fn,
    serverUrl: () => bare, // git reaches the recorded https origin at the bare repository (code-only seam)
    publisher: (input: PublishInput) => publishTask({ ...input, gh: gh.fn, tokenFile }),
  });
  return { ...env, sched, gh, keys, bare };
}

/** engineer commits `file` → (tester when required) → reviewer approves → publication. */
async function deliver(env: MEnv, id: string, file = 'a.txt') {
  env.backlog.add({ id, title: `Feature ${id}` });
  const eng = await env.sched.claim(id, 'engineer');
  mkdirSync(dirname(join(eng.worktree, file)), { recursive: true });
  const head = commitFile(eng.worktree, file, `work ${Math.random()}`);
  const e = await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head, modifiedPaths: [file] }));
  if (e.to === 'testing') {
    const t = await env.sched.claim(id, 'tester');
    await env.sched.record(t.leaseId, result({ branch: t.branch, headSha: head }));
  }
  const rev = await env.sched.claim(id, 'reviewer');
  const r = await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: head, verdict: 'approve' }));
  return { r, head, branch: eng.branch };
}

const passing = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const failing = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }];
const sync = (env: MEnv, ids?: string[]) => syncTasks({ db: env.db, backlog: env.backlog, config: env.config, gh: env.gh.fn, merge: (id) => env.sched.autoMerge(id) }, { taskIds: ids });
const mergeToken = (env: MEnv, taskId: string, head: string, o: { now?: Date; ttlMs?: number } = {}) =>
  signApproval(env.keys.privateKeyPem, { taskId, head, by: 'owner', scope: 'merge', ...o }).token;
const mergeHistory = (env: MEnv, id: string) => env.db.evidenceOfKind(id, 'merge').map((e) => e.outcome);

describe('CI-gated auto-merge (mocked gh)', () => {
  it('arms only after required checks pass for the approved head and a host-signed merge approval (pr.merge ask); merged is distinct from delivered', async () => {
    const env = mergeEnv();
    const { r, head } = await deliver(env, 'task-1');
    // Delivered, PR open: the merge pass runs at once but CI has not reported for this head.
    expect(r.publication).toMatchObject({ state: 'published', status: 'delivered', merged: false, merge: { state: 'waiting', armed: false } });
    expect(r.publication!.merge!.reasons.join(' ')).toMatch(/CI gate missing/);
    expect(env.gh.merges()).toEqual([]);
    const url = env.gh.pr().url;

    // Required check passes for the head; pr.merge is "ask" (project-owner default): no approval yet.
    env.gh.pr().rollup = passing;
    let s = await sync(env);
    expect(s.tasks[0]!.merge).toMatchObject({ state: 'awaiting-approval', armed: false, reasons: ['pr.merge needs human approval by configuration'] });
    expect(s.tasks[0]!.merge!.message).toContain(`minions work approve task-1 --head ${head} --merge`);
    expect(env.gh.merges()).toEqual([]);
    expect(env.backlog.status('task-1')).toBe('delivered');

    // A container-written, unsigned approval row authorizes nothing.
    env.db.addApproval({ task_id: 'task-1', scope: 'merge', head_sha: head, approved_by: 'agent', note: null, signature: null });
    expect((await env.sched.autoMerge('task-1')).state).toBe('awaiting-approval');
    // A publish-scoped token is not a merge approval, neither at recording nor when stored directly.
    expect(() => env.sched.approveMerge('task-1', { head, signature: env.keys.sign('task-1', head) })).toThrow(/publish approval, not a merge approval/);
    env.db.addApproval({ task_id: 'task-1', scope: 'merge', head_sha: head, approved_by: 'x', note: null, signature: env.keys.sign('task-1', head) });
    expect(await env.sched.autoMerge('task-1')).toMatchObject({ state: 'awaiting-approval', approvalError: expect.stringMatching(/not a merge approval/) });
    expect(() => env.sched.approveMerge('task-1', { head })).toThrow(/signed on the host/);

    const a = env.sched.approveMerge('task-1', { head, signature: mergeToken(env, 'task-1', head) });
    expect(a.message).toMatch(/minions sync task-1/);
    s = await sync(env);
    expect(s.tasks[0]!.merge).toMatchObject({ state: 'armed', armed: true, merged: false, action: 'armed', head });
    expect(env.gh.merges()).toEqual([['pr', 'merge', url, '--auto', '--squash', '--match-head-commit', head]]);
    expect(env.gh.pr().autoMergeRequest).toEqual({ mergeMethod: 'SQUASH' });
    // Armed is still delivered (PR open), not merged.
    expect(env.backlog.status('task-1')).toBe('delivered');
    expect(formatSync(s)).toMatch(/merge armed: Auto-merge enabled/);

    // Idempotent: a second pass does not arm again.
    await sync(env);
    expect(env.gh.merges()).toHaveLength(1);

    // GitHub merges (branch protection satisfied); sync reconciles: done, merge evidence "merged".
    Object.assign(env.gh.pr(), { state: 'MERGED', mergedAt: '2026-10-20T12:00:00Z', autoMergeRequest: null });
    s = await sync(env);
    expect(s.tasks[0]!.statusChange).toEqual({ from: 'delivered', to: 'done' });
    expect(env.backlog.status('task-1')).toBe('done');
    // Recorded on change only (the approval error changed once while waiting for approval).
    expect(mergeHistory(env, 'task-1')).toEqual(['waiting', 'awaiting-approval', 'awaiting-approval', 'armed', 'merged']);
    expect(env.backlog.notes.at(-1)!.text).toMatch(/merged at 2026-10-20T12:00:00Z; task done \(merged\)/);
  });

  it('never arms with failing, pending, unreadable or unconfigured required checks', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    await deliver(env, 'task-1');
    env.gh.pr().rollup = failing;
    expect((await sync(env)).tasks[0]!.merge).toMatchObject({ state: 'waiting', reasons: [expect.stringMatching(/CI gate fail/)] });
    env.gh.pr().rollup = [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null }];
    expect((await sync(env)).tasks[0]!.merge!.reasons.join(' ')).toMatch(/CI gate pending/);
    // A passing check that is not the required one is not evidence.
    env.gh.pr().rollup = [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    expect((await sync(env)).tasks[0]!.merge!.state).toBe('waiting');
    // No required checks on the base: never treated as zero required checks.
    env.gh.required = [];
    env.gh.pr().rollup = passing;
    expect((await sync(env)).tasks[0]!.merge!.reasons.join(' ')).toMatch(/CI gate unknown.*never treated as zero required checks/);
    // delivery.requiredChecksConfigured false blocks too, even with checks passing.
    env.gh.required = ['test'];
    env.config.delivery.requiredChecksConfigured = false;
    expect((await sync(env)).tasks[0]!.merge!.reasons).toContain('delivery.requiredChecksConfigured is false (never treated as zero required checks)');
    env.config.delivery.requiredChecksConfigured = true;
    expect((await sync(env)).tasks[0]!.merge).toMatchObject({ state: 'armed' });
    expect(env.gh.merges()).toHaveLength(1);
  });

  it('task-71: a forged origin (url.insteadOf) plus a recorded base moved past the head cannot hide a sensitive path from the merge gate', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    const { r, head } = await deliver(env, 'task-1', 'infra/main.tf');
    expect(r.publication?.state).toBe('awaiting-approval');
    env.sched.approvePublication('task-1', { head, signature: env.keys.sign('task-1', head) });
    await env.sched.publish('task-1');
    env.gh.pr().rollup = passing;
    // The attack: a main lookalike F with the head's tree on top of the head, served by a forged repository
    // that origin's URL now resolves to; local base refs and the recorded lease bases moved to F as well.
    const repo = env.layout.repo;
    const f = gitSync(repo, 'commit-tree', `${head}^{tree}`, '-p', head, '-m', 'main lookalike');
    const forged = join(tmp('minions-forged-'), 'demo.git');
    execFileSync('git', ['init', '-q', '--bare', forged]);
    gitSync(repo, 'push', '-q', forged, `${f}:refs/heads/main`);
    gitSync(repo, 'config', '--unset', `url.${env.bare}.insteadOf`);
    gitSync(repo, 'config', `url.${forged}.insteadOf`, REMOTE);
    for (const ref of ['refs/heads/main', 'refs/remotes/origin/main']) gitSync(repo, 'update-ref', ref, f);
    env.db.exec('UPDATE leases SET base_sha = ? WHERE task_id = ?', f, 'task-1');
    expect(gitSync(repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main').split(/\s+/)[0]).toBe(f);
    // The merge gate reads origin's base at the recorded PR URL (the seam: the real bare repository) and
    // cross-checks it with the API: the sensitive path stays, so pr.merge is upgraded to ask.
    const m = (await sync(env, ['task-1'])).tasks[0]!.merge!;
    expect(m).toMatchObject({ state: 'awaiting-approval', reasons: [expect.stringMatching(/sensitive paths \(infra\/main\.tf\)/)] });
    expect(env.gh.calls.some((c) => c[0] === 'pr' && c[1] === 'merge')).toBe(false);
  });

  it('task-71: the merge gate fails closed when origin\'s base cannot be verified (git and the API disagree)', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    await deliver(env, 'task-1');
    env.gh.pr().rollup = passing;
    // GitHub's API reports a main that git (the seam) does not see.
    const stale = join(tmp('minions-stale-'), 'demo.git');
    execFileSync('git', ['clone', '-q', '--bare', env.bare, stale]);
    commitFile(env.layout.repo, 'later.txt', 'l');
    gitSync(env.layout.repo, 'push', '-q', env.bare, 'HEAD:refs/heads/main');
    env.sched = new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, approvalPublicKeyFile: env.keys.publicKeyFile, gh: env.gh.fn, serverUrl: () => stale });
    const m = (await sync(env, ['task-1'])).tasks[0]!.merge!;
    expect(m.state).not.toBe('armed');
    expect(m.reasons.join(' ')).toMatch(/could not be verified.*for git but .* for the GitHub API/);
    expect(env.gh.merges()).toEqual([]);
  });

  it('pr.merge allow arms without approval; a sensitive-path change upgrades it to ask; deny never arms', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    await deliver(env, 'task-1');
    env.gh.pr().rollup = passing;
    expect((await sync(env, ['task-1'])).tasks[0]!.merge).toMatchObject({ state: 'armed' });

    // Sensitive path: publication needs a host-signed publish approval, the merge a separate merge approval.
    const { r, head } = await deliver(env, 'task-2', 'infra/main.tf');
    expect(r.publication?.state).toBe('awaiting-approval');
    env.sched.approvePublication('task-2', { head, signature: env.keys.sign('task-2', head) });
    expect((await env.sched.publish('task-2')).merge).toMatchObject({ state: 'waiting' });
    env.gh.pr(1).rollup = passing;
    const m = (await sync(env, ['task-2'])).tasks[0]!.merge!;
    expect(m).toMatchObject({ state: 'awaiting-approval', reasons: [expect.stringMatching(/sensitive paths \(infra\/main\.tf\)/)] });
    // The publish approval for the same head does not authorize the merge (it is a publish-scope row).
    expect(m.approvalError).toBe('no host-signed approval is recorded');
    env.sched.approveMerge('task-2', { head, signature: mergeToken(env, 'task-2', head) });
    expect((await sync(env, ['task-2'])).tasks[0]!.merge).toMatchObject({ state: 'armed' });

    const denied = mergeEnv((c) => { c.capabilities['pr.merge'] = 'deny'; });
    const d = await deliver(denied, 'task-1');
    denied.gh.pr().rollup = passing;
    denied.db.addApproval({ task_id: 'task-1', scope: 'merge', head_sha: d.head, approved_by: 'owner', note: null, signature: mergeToken(denied, 'task-1', d.head) });
    expect((await sync(denied)).tasks[0]!.merge).toMatchObject({ state: 'denied', reasons: expect.arrayContaining(['pr.merge is denied by policy']) });
    expect(denied.gh.merges()).toEqual([]);
  });

  it('disarms when the PR head moves away from the approved head, and when a gate stops passing', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    const { head } = await deliver(env, 'task-1');
    env.gh.pr().rollup = passing;
    expect((await sync(env)).tasks[0]!.merge!.state).toBe('armed');
    const url = env.gh.pr().url;

    // Someone pushes another commit to the PR branch: auto-merge is disabled, never re-armed for it.
    const other = 'f'.repeat(40);
    env.gh.pr().headRefOid = other;
    let m = (await sync(env)).tasks[0]!.merge!;
    expect(m).toMatchObject({ state: 'disarmed', action: 'disarmed' });
    expect(m.reasons.join(' ')).toMatch(new RegExp(`PR head ${other.slice(0, 12)} is not the approved head ${head.slice(0, 12)}`));
    expect(env.gh.merges().at(-1)).toEqual(['pr', 'merge', url, '--disable-auto']);
    expect(env.gh.pr().autoMergeRequest).toBeNull();
    await sync(env);
    expect(env.gh.merges()).toHaveLength(2);

    // Back at the approved head and passing: armed again; then CI fails at that head: disarmed.
    env.gh.pr().headRefOid = head;
    expect((await sync(env)).tasks[0]!.merge!.state).toBe('armed');
    env.gh.pr().rollup = failing;
    m = (await sync(env)).tasks[0]!.merge!;
    expect(m.state).toBe('disarmed');
    expect(m.reasons.join(' ')).toMatch(/CI gate fail/);

    // The owner turns auto-merge off: what minions armed is disarmed, nothing new is armed.
    env.gh.pr().rollup = passing;
    expect((await sync(env)).tasks[0]!.merge!.state).toBe('armed');
    env.config.delivery.merge = 'disabled';
    expect((await sync(env)).tasks[0]!.merge).toMatchObject({ state: 'disarmed', reasons: expect.arrayContaining([expect.stringMatching(/delivery\.merge is "disabled"/)]) });
    const before = env.gh.calls.length;
    const off = await sync(env);
    expect(off.tasks[0]!.merge).toBeUndefined();
    expect(env.gh.calls.slice(before).filter((c) => c[1] === 'merge')).toEqual([]);
    expect(armedByMinions(env.db.evidenceOfKind('task-1', 'merge'))).toBe(false);
  });

  it('leaves auto-merge that was enabled outside minions alone when a gate fails', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    await deliver(env, 'task-1');
    env.gh.pr().autoMergeRequest = { mergeMethod: 'MERGE' };
    env.gh.pr().rollup = failing;
    const m = (await sync(env)).tasks[0]!.merge!;
    expect(m.state).toBe('waiting');
    expect(m.message).toMatch(/enabled on GitHub outside minions; left as is/);
    expect(env.gh.merges()).toEqual([]);
  });

  it('a PR GitHub reports already mergeable (clean status) is merged without --auto only when mergeStateStatus is CLEAN', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; c.delivery.method = 'rebase'; });
    const { head } = await deliver(env, 'task-1');
    env.gh.pr().rollup = passing;
    env.gh.armError = 'GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)';
    env.gh.pr().mergeStateStatus = 'BLOCKED';
    expect((await sync(env)).tasks[0]!.merge).toMatchObject({ state: 'failed', armed: false });
    expect(env.gh.merges()).toHaveLength(1); // only the --auto attempt

    env.gh.pr().mergeStateStatus = 'CLEAN';
    const s = await sync(env);
    expect(s.tasks[0]!.merge).toMatchObject({ state: 'merged', merged: true, action: 'merged' });
    expect(env.gh.merges().at(-1)).toEqual(['pr', 'merge', env.gh.pr().url, '--rebase', '--match-head-commit', head]);
    expect(env.backlog.status('task-1')).toBe('done');
    expect(s.tasks[0]!.statusChange).toEqual({ from: 'delivered', to: 'done' });
  });

  it('gh merging at once on --auto is read back as merged; arm failures are reported with a settings hint', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    await deliver(env, 'task-1');
    env.gh.pr().rollup = passing;
    env.gh.armError = 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)';
    const f = (await sync(env)).tasks[0]!.merge!;
    expect(f).toMatchObject({ state: 'failed' });
    expect(f.message).toMatch(/Allow auto-merge/);
    env.gh.armError = null;
    env.gh.mergeOnArm = true;
    const p = await env.sched.publish('task-1');
    expect(p).toMatchObject({ state: 'published', status: 'done', merged: true, merge: { state: 'merged', action: 'merged' } });
    expect(env.backlog.status('task-1')).toBe('done');
  });

  it('a merged PR whose task holds an active lease is recorded merged but the status is left alone', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    await deliver(env, 'task-1');
    env.gh.pr().rollup = passing;
    expect((await sync(env)).tasks[0]!.merge!.state).toBe('armed');
    env.db.activeLeases = () => [{ task_id: 'task-1' } as never];
    Object.assign(env.gh.pr(), { state: 'MERGED', mergedAt: '2026-10-20T12:00:00Z', autoMergeRequest: null });
    const m = await env.sched.autoMerge('task-1');
    expect(m).toMatchObject({ state: 'merged', merged: true });
    expect(m.message).toMatch(/active lease; status left unchanged/);
    expect(mergeHistory(env, 'task-1').at(-1)).toBe('merged');
    expect(env.backlog.status('task-1')).not.toBe('done');
  });

  it('a failed --disable-auto is reported as failed with auto-merge still armed', async () => {
    const env = mergeEnv((c) => { c.capabilities['pr.merge'] = 'allow'; });
    await deliver(env, 'task-1');
    env.gh.pr().rollup = passing;
    expect((await sync(env)).tasks[0]!.merge!.state).toBe('armed');
    env.gh.pr().rollup = failing;
    env.gh.disableError = 'gh: HTTP 502';
    const m = (await sync(env)).tasks[0]!.merge!;
    expect(m).toMatchObject({ state: 'failed', armed: true });
    expect(m.message).toMatch(/could not be disabled/);
    expect(env.gh.pr().autoMergeRequest).not.toBeNull();
    expect(armedByMinions(env.db.evidenceOfKind('task-1', 'merge'))).toBe(true);
    env.gh.disableError = null;
    expect((await sync(env)).tasks[0]!.merge!.state).toBe('disarmed');
  });

  it('sync reconciles a PR merged on GitHub with auto-merge off: done, merge evidence recorded once', async () => {
    const env = mergeEnv((c) => { c.delivery.merge = 'disabled'; });
    await deliver(env, 'task-1');
    Object.assign(env.gh.pr(), { state: 'MERGED', mergedAt: '2026-10-20T12:00:00Z' });
    const s = await sync(env);
    expect(s.tasks[0]!.statusChange).toEqual({ from: 'delivered', to: 'done' });
    expect(env.backlog.status('task-1')).toBe('done');
    expect(mergeHistory(env, 'task-1')).toEqual(['merged']);
    expect(env.db.evidenceOfKind('task-1', 'merge')[0]!.details_json).toContain('"how":"github"');
    await sync(env);
    expect(mergeHistory(env, 'task-1')).toEqual(['merged']);
    expect(env.gh.merges()).toEqual([]);
  });

  it('formatSync prints the merge line with state and message', () => {
    const text = formatSync({ synced: 1, failed: 0, tasks: [{
      taskId: 'task-1', prUrl: 'https://github.com/acme/demo/pull/1', prState: 'OPEN', headSha: 'a'.repeat(40), changed: false, warnings: [],
      ci: { state: 'passing', total: 1, passed: 1, failed: [], pending: [], checks: [] },
      merge: { taskId: 'task-1', state: 'failed', prUrl: null, head: null, armed: false, merged: false, reasons: [], action: 'none', message: 'gh exploded' },
    }] });
    expect(text).toContain('\n  merge failed: gh exploded');
  });

  it('auto-merge off: delivery and sync make no merge calls and say minions does not merge', async () => {
    const env = mergeEnv((c) => { c.delivery.merge = 'disabled'; c.capabilities['pr.merge'] = 'allow'; });
    const { r } = await deliver(env, 'task-1');
    expect(r.publication).toMatchObject({ state: 'published', merged: false });
    expect(r.publication!.merge).toBeUndefined();
    expect(r.publication!.message).toMatch(/minions does not merge/);
    env.gh.pr().rollup = passing;
    expect((await sync(env)).tasks[0]!.merge).toBeUndefined();
    expect(env.gh.merges()).toEqual([]);
  });

  it('approveMerge binds the exact delivered head and rejects expired tokens', async () => {
    const env = mergeEnv();
    const { head } = await deliver(env, 'task-1');
    expect(() => env.sched.approveMerge('task-1', { head: 'e'.repeat(40), signature: mergeToken(env, 'task-1', 'e'.repeat(40)) })).toThrow(/not the approved, delivered head/);
    expect(() => env.sched.approveMerge('task-1', { head, signature: mergeToken(env, 'task-2', head) })).toThrow(/for task task-2/);
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    expect(() => env.sched.approveMerge('task-1', { head, signature: mergeToken(env, 'task-1', head, { now: old }) })).toThrow(/expired/);
    expect(() => env.sched.approveMerge('task-9', { head, signature: mergeToken(env, 'task-9', head) })).toThrow(/no delivered pull request/);
    // A merge token is not a publication approval either.
    expect(verifyApproval(mergeToken(env, 'task-1', head), env.keys.publicKeyPem, { taskId: 'task-1', head }).ok).toBe(false);
  });
});

describe('merge gate (pure)', () => {
  const HEAD = 'a'.repeat(40);
  const pass: CiGate = { state: 'pass', head: HEAD, requiredChecks: ['test'], passed: ['test'], failed: [], pending: [], observedAt: null, firstObservedAt: null, timeoutMinutes: 60, reasons: [] };
  const cfg = () => {
    const c = defaults('project-owner');
    Object.assign(c.delivery, { provider: 'github', mode: 'pull-request', merge: 'auto-when-eligible', requiredChecksConfigured: true });
    c.verification.ciAuthority = 'github';
    return c;
  };
  const input = (over: Partial<MergeGateInput> = {}): MergeGateInput => ({
    config: cfg(), approvedHead: HEAD, reviewed: true, ci: pass,
    pr: { state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefName: 'main', isCrossRepository: false },
    paths: { ok: true, changedPaths: ['src/a.ts'], sensitivePaths: [] },
    approval: () => ({ ok: true }), ...over,
  });

  it('is eligible only when every gate passes', () => {
    expect(evaluateMergeGate(input())).toMatchObject({ state: 'eligible', reasons: [] });
    expect(evaluateMergeGate(input({ approval: () => ({ ok: false, reason: 'no host-signed approval is recorded' }) }))).toMatchObject({ state: 'awaiting-approval', approvalError: 'no host-signed approval is recorded' });
    const waiting = (over: Partial<MergeGateInput>, re: RegExp) => {
      const g = evaluateMergeGate(input(over));
      expect(g.state).toBe('waiting');
      expect(g.reasons.join(' ')).toMatch(re);
    };
    waiting({ pr: { ...input().pr, headRefOid: 'b'.repeat(40) } }, /is not the approved head/);
    waiting({ pr: { ...input().pr, isDraft: true } }, /draft/);
    waiting({ pr: { ...input().pr, baseRefName: 'dev' } }, /targets dev/);
    waiting({ pr: { ...input().pr, isCrossRepository: true } }, /another repository/);
    waiting({ reviewed: false }, /no reviewer approval/);
    waiting({ ci: { ...pass, state: 'missing', reasons: ['no CI observation'] } }, /CI gate missing/);
    waiting({ paths: { ok: false, message: 'No trustworthy base' } }, /sensitive-path gate: No trustworthy base/);
    const c = cfg(); c.verification.ciAuthority = 'none';
    waiting({ config: c }, /ciAuthority is not "github"/);
    const off = cfg(); off.delivery.merge = 'disabled';
    waiting({ config: off }, /opt-in/);
    const deny = cfg(); deny.capabilities['pr.merge'] = 'deny';
    expect(evaluateMergeGate(input({ config: deny }))).toMatchObject({ state: 'denied' });
    // Sensitive path with pr.merge allow still needs the approval.
    const allow = cfg(); allow.capabilities['pr.merge'] = 'allow';
    let asked = 0;
    expect(evaluateMergeGate(input({ config: allow, approval: () => { asked++; return { ok: true }; } })).state).toBe('eligible');
    expect(asked).toBe(0);
    expect(evaluateMergeGate(input({ config: allow, paths: { ok: true, changedPaths: ['.github/workflows/ci.yml'], sensitivePaths: ['.github/workflows/ci.yml'] }, approval: () => ({ ok: false, reason: 'none' }) })))
      .toMatchObject({ state: 'awaiting-approval', reasons: [expect.stringMatching(/sensitive paths \(\.github\/workflows\/ci\.yml\)/)] });
  });
});

describe('auto-merge readiness and approvals on the host', () => {
  const rc = (state: RequiredChecksReport['state'], checks: string[] = ['test']): RequiredChecksReport =>
    ({ repository: 'acme/demo', baseBranch: 'main', state, requiredChecks: state === 'configured' ? checks : [], protection: null, rulesets: null, workflows: 1, errors: [] });
  const cfg = (over: (c: MinionsConfig) => void = () => {}) => {
    const c = defaults('project-owner');
    Object.assign(c.delivery, { provider: 'github', mode: 'pull-request' });
    over(c);
    return c;
  };
  const ok = { onGitHub: true, credential: 'ok' as const };

  it('doctor merge.readiness: off by default, ready with every prerequisite, otherwise warn with reasons', () => {
    expect(autoMergeReadiness(cfg(), ok, rc('configured'))).toMatchObject({ enabled: false, ready: false });
    expect(mergeReadiness(cfg(), ok, rc('configured'))).toEqual(['ok', expect.stringMatching(/auto-merge off \(opt-in/)]);
    const on = cfg((c) => { c.delivery.merge = 'auto-when-eligible'; });
    const [st, detail] = mergeReadiness(on, ok, rc('none'));
    expect(st).toBe('warn');
    expect(detail).toMatch(/auto-merge enabled but not usable: delivery\.requiredChecksConfigured is false.*ciAuthority is not "github".*no required status checks on main/);
    const ready = cfg((c) => { c.delivery.merge = 'auto-when-eligible'; c.delivery.requiredChecksConfigured = true; c.verification.ciAuthority = 'github'; });
    expect(mergeReadiness(ready, ok, rc('configured'))).toEqual(['ok', expect.stringMatching(/auto-merge ready.*required checks \(test\).*--merge/)]);
    expect(mergeReadiness(ready, ok, rc('unknown'))[1]).toMatch(/could not be read/);
    expect(mergeReadiness(ready, { onGitHub: true, credential: 'missing' }, rc('configured'))[0]).toBe('warn');
    const denied = cfg((c) => { c.delivery.merge = 'auto-when-eligible'; c.delivery.requiredChecksConfigured = true; c.verification.ciAuthority = 'github'; c.capabilities['pr.merge'] = 'deny'; });
    expect(autoMergeReadiness(denied, ok, rc('configured')).reasons).toContain('pr.merge is denied by policy');
    const allowed = cfg((c) => { c.delivery.merge = 'auto-when-eligible'; c.delivery.requiredChecksConfigured = true; c.verification.ciAuthority = 'github'; c.capabilities['pr.merge'] = 'allow'; });
    expect(autoMergeReadiness(allowed, ok, rc('configured')).detail).not.toMatch(/--merge/);
  });

  it('`minions work approve --merge` on the host signs a merge-scoped token and delegates --merge', async () => {
    const home = tmp('minions-home-');
    const prev = process.env.MINIONS_HOME;
    process.env.MINIONS_HOME = home;
    try {
      let args: string[] = [];
      const code = await approveOnHost('task-1', { head: 'c'.repeat(40), json: true, merge: true, by: 'owner' },
        { projectId: 'p1', inContainer: false, delegate: async (a) => { args = a; return 0; } });
      expect(code).toBe(0);
      expect(args.slice(0, 7)).toEqual(['work', 'approve', 'task-1', '--head', 'c'.repeat(40), '--by', 'owner']);
      expect(args).toContain('--merge');
      const token = args[args.indexOf('--signature') + 1]!;
      expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({ scope: 'merge', taskId: 'task-1', head: 'c'.repeat(40) });
    } finally {
      if (prev === undefined) delete process.env.MINIONS_HOME; else process.env.MINIONS_HOME = prev;
    }
  });
});
