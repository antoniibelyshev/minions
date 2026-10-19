import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import {
  briefPath, claimWithBrief, fetchBrief, recordSubmitted, rejectedPath, submissionPath, submitResult, type HandoffPaths,
} from '../../src/runtime/handoff.js';
import { commitFile, makeEnv, result, type Env } from './fixtures.js';

// Edge cases for the file hand-off (task-9). Everything lives in per-test temp dirs, never in /state.

const paths = (env: Env): HandoffPaths => ({ briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') });
const fail = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a failure');
};
const json = (v: unknown) => JSON.stringify(v);

async function engineer(env: Env) {
  env.backlog.add({ id: 'task-1' });
  const brief = await claimWithBrief(env.sched, paths(env), 'task-1', 'engineer');
  const head = commitFile(brief.worktree, 'a.txt', 'work');
  return { brief, head, owner: { role: 'engineer', cwd: brief.worktree } };
}

describe('record --submitted matches the stdin path', () => {
  const strip = (r: Record<string, unknown>) => { const { message: _m, ...rest } = r; return rest; };

  it('invalid, then invalid correction: same responses, lease and task state as stdin', async () => {
    const inputs = ['not json', '{"status":"complete"}'];
    const viaStdin = makeEnv();
    const s = await engineer(viaStdin);
    const stdin1 = await viaStdin.sched.record(s.brief.leaseId, inputs[0]!);
    const stdin2 = await viaStdin.sched.record(s.brief.leaseId, inputs[1]!, { correction: true });

    const viaFile = makeEnv();
    const f = await engineer(viaFile);
    const p = paths(viaFile);
    await submitResult(viaFile.db, p, f.brief.leaseId, inputs[0]!, f.owner);
    const file1 = await recordSubmitted(viaFile.sched, p, f.brief.leaseId);
    await submitResult(viaFile.db, p, f.brief.leaseId, inputs[1]!, f.owner);
    const file2 = await recordSubmitted(viaFile.sched, p, f.brief.leaseId, { correction: true });

    const norm = (r: Record<string, unknown>, leaseId: string) => JSON.parse(JSON.stringify(strip(r)).split(leaseId).join('L'));
    expect(norm(file1 as never, f.brief.leaseId)).toEqual(norm(stdin1 as never, s.brief.leaseId));
    expect(norm(file2 as never, f.brief.leaseId)).toEqual(norm(stdin2 as never, s.brief.leaseId));
    expect(file2).toMatchObject({ valid: false, correctionAllowed: false, unvalidated: true });
    expect(viaFile.db.lease(f.brief.leaseId)!.status).toBe(viaStdin.db.lease(s.brief.leaseId)!.status);
    expect(viaFile.db.lease(f.brief.leaseId)!.result_json).toBe(inputs[1]);
    expect(viaFile.backlog.status('task-1')).toBe(viaStdin.backlog.status('task-1'));
    // no third attempt: the lease has ended
    expect((await fail(submitResult(viaFile.db, p, f.brief.leaseId, '{}', f.owner))).code).toBe('CONFLICT');
    expect((await fail(recordSubmitted(viaFile.sched, p, f.brief.leaseId, { correction: true }))).code).toBe('NOT_FOUND');
  });

  it('--correction before any invalid result is refused exactly as on stdin and keeps the submission', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    const e = await fail(recordSubmitted(env.sched, p, brief.leaseId, { correction: true }));
    expect(e.code).toBe('PRECONDITION');
    expect(e.message).toMatch(/no invalid result to correct/);
    expect(existsSync(submissionPath(p, brief.leaseId))).toBe(true);
    expect((await recordSubmitted(env.sched, p, brief.leaseId)).valid).toBe(true);
  });

  it('detects a stale head through --submitted and lets the correction fix it', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    const moved = commitFile(brief.worktree, 'b.txt', 'later'); // branch moves after the result was written
    const r = await recordSubmitted(env.sched, p, brief.leaseId);
    expect(r).toMatchObject({ valid: false, correctionAllowed: true });
    expect(r.errors!.join('\n')).toContain(`stale head: result headSha ${head} but ${brief.branch} is at ${moved}`);
    expect(env.backlog.status('task-1')).toBe('implementing');
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: moved })), owner);
    expect(await recordSubmitted(env.sched, p, brief.leaseId, { correction: true })).toMatchObject({ valid: true, to: 'testing' });
  });

  it('a stale reviewer head via --submitted is rejected', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    await recordSubmitted(env.sched, p, brief.leaseId);
    const t = await claimWithBrief(env.sched, p, 'task-1', 'tester');
    await submitResult(env.db, p, t.leaseId, json(result({ branch: brief.branch, headSha: head })), { role: 'tester', cwd: t.worktree });
    await recordSubmitted(env.sched, p, t.leaseId);
    const rev = await claimWithBrief(env.sched, p, 'task-1', 'reviewer');
    const moved = commitFile(brief.worktree, 'c.txt', 'sneaky');
    await submitResult(env.db, p, rev.leaseId, json(result({ branch: brief.branch, headSha: moved, verdict: 'approve' })), { role: 'reviewer', cwd: rev.worktree });
    const r = await recordSubmitted(env.sched, p, rev.leaseId);
    expect(r.valid).toBe(false);
    expect(r.approved).toBe(false);
    expect(r.errors!.join('\n')).toMatch(/stale head: review started at/);
  });
});

describe('ownership edge cases', () => {
  it('symlinks and .. in the cwd resolve to the real location', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const p = paths(env);
    const b = await claimWithBrief(env.sched, p, 'task-1', 'engineer');
    const caller = (cwd: string) => ({ role: 'engineer', cwd });
    // a symlink inside the worktree that points at the coordinator repo is not the worktree
    const escape = join(b.worktree, 'escape');
    symlinkSync(env.layout.repo, escape);
    expect((await fail(fetchBrief(env.db, p, b.leaseId, caller(escape)))).code).toBe('POLICY_DENIED');
    // .. tricks
    expect((await fail(fetchBrief(env.db, p, b.leaseId, caller(join(b.worktree, '..'))))).code).toBe('POLICY_DENIED');
    expect((await fail(fetchBrief(env.db, p, b.leaseId, caller(`${b.worktree}/../${b.worktree.split('/').pop()}-x`)))).code).toBe('POLICY_DENIED');
    expect((await fail(fetchBrief(env.db, p, b.leaseId, caller(`${env.layout.repo}/../..`)))).code).toBe('POLICY_DENIED');
    expect((await fail(fetchBrief(env.db, p, b.leaseId, caller(`${b.worktree}/../../../../..`)))).code).toBe('POLICY_DENIED');
    // a path that leaves and re-enters the worktree is still inside it
    const sub = join(b.worktree, 'src');
    mkdirSync(sub);
    expect((await fetchBrief(env.db, p, b.leaseId, caller(`${sub}/../src`))).leaseId).toBe(b.leaseId);
    // a symlink elsewhere that points into the worktree is the worktree (realpath)
    const link = join(env.root, 'link-to-wt');
    symlinkSync(b.worktree, link);
    expect((await fetchBrief(env.db, p, b.leaseId, caller(link))).leaseId).toBe(b.leaseId);
    // submissions follow the same rule
    expect((await fail(submitResult(env.db, p, b.leaseId, '{}', caller(escape)))).code).toBe('POLICY_DENIED');
    expect(existsSync(submissionPath(p, b.leaseId))).toBe(false);
  });

  it('lease ids cannot traverse paths', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const p = paths(env);
    const b = await claimWithBrief(env.sched, p, 'task-1', 'engineer');
    const caller = { role: 'engineer', cwd: b.worktree };
    for (const id of ['lease-../../minions', 'lease-a/b', '../lease-x', 'lease-a\\b', 'lease-.', 'lease-', '', `${b.leaseId}/../x`, `${b.leaseId}\n`]) {
      expect((await fail(fetchBrief(env.db, p, id, caller))).code, JSON.stringify(id)).toBe('PRECONDITION');
      expect((await fail(submitResult(env.db, p, id, '{}', caller))).code, JSON.stringify(id)).toBe('PRECONDITION');
      expect((await fail(recordSubmitted(env.sched, p, id))).code, JSON.stringify(id)).toBe('PRECONDITION');
      expect(() => briefPath(p, id)).toThrow(/Invalid lease id/);
    }
  });

  it('a tester cannot read the engineer brief of the same task once its own lease is active', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    await recordSubmitted(env.sched, p, brief.leaseId);
    const t = await claimWithBrief(env.sched, p, 'task-1', 'tester');
    // same worktree, but the engineer lease has ended
    expect((await fail(fetchBrief(env.db, p, brief.leaseId, { role: 'engineer', cwd: t.worktree }))).code).toBe('CONFLICT');
    expect((await fail(fetchBrief(env.db, p, t.leaseId, { role: 'engineer', cwd: t.worktree }))).code).toBe('POLICY_DENIED');
    expect((await fetchBrief(env.db, p, t.leaseId, { role: 'tester', cwd: t.worktree })).role).toBe('tester');
  });
});

describe('concurrency and lifecycle', () => {
  it('two submits before record: the last one is what gets recorded', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    const first = json(result({ branch: brief.branch, headSha: head, summary: 'first' }));
    const second = json(result({ branch: brief.branch, headSha: head, summary: 'second' }));
    const [a, b] = await Promise.all([submitResult(env.db, p, brief.leaseId, first, owner), submitResult(env.db, p, brief.leaseId, second, owner)]);
    expect([a.path, b.path]).toEqual([submissionPath(p, brief.leaseId), submissionPath(p, brief.leaseId)]);
    const stored = readFileSync(submissionPath(p, brief.leaseId), 'utf8');
    expect([first, second]).toContain(stored); // never a torn mix of the two (atomic write)
    await submitResult(env.db, p, brief.leaseId, second, owner);
    expect((await recordSubmitted(env.sched, p, brief.leaseId)).valid).toBe(true);
    expect(JSON.parse(env.db.lease(brief.leaseId)!.result_json!).summary).toBe('second');
    expect(env.db.events('task-1', 'submit')).toHaveLength(3);
  });

  it('recording twice: the second record finds nothing and the transition is applied once', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    expect((await recordSubmitted(env.sched, p, brief.leaseId)).to).toBe('testing');
    expect((await fail(recordSubmitted(env.sched, p, brief.leaseId))).code).toBe('NOT_FOUND');
    expect(env.backlog.status('task-1')).toBe('testing');
  });

  it('record after release is refused and cannot apply a transition', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    await env.sched.release(brief.leaseId, 'worker died');
    expect((await fail(recordSubmitted(env.sched, p, brief.leaseId))).code).toBe('CONFLICT');
    expect(env.db.lease(brief.leaseId)!.status).toBe('released');
    expect(env.backlog.status('task-1')).toBe('ready');
    // a new lease for the same task never picks up the old submission
    const again = await claimWithBrief(env.sched, p, 'task-1', 'engineer');
    expect(again.leaseId).not.toBe(brief.leaseId);
    expect((await fail(recordSubmitted(env.sched, p, again.leaseId))).code).toBe('NOT_FOUND');
  });

  it('a rejected file left over from the first attempt does not satisfy a correction', async () => {
    const env = makeEnv();
    const { brief, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, 'garbage', owner);
    await recordSubmitted(env.sched, p, brief.leaseId);
    expect(readFileSync(rejectedPath(p, brief.leaseId), 'utf8')).toBe('garbage');
    expect(existsSync(submissionPath(p, brief.leaseId))).toBe(false);
    // the correction can still arrive on stdin instead of a file
    const r = await env.sched.record(brief.leaseId, '{}', { correction: true });
    expect(r).toMatchObject({ unvalidated: true });
  });
});

describe('full claim output is unchanged', () => {
  it('claimWithBrief returns exactly what Scheduler.claim returns (same keys and values)', async () => {
    const a = makeEnv();
    a.backlog.add({ id: 'task-1' });
    const plain = await a.sched.claim('task-1', 'engineer');
    const b = makeEnv();
    b.backlog.add({ id: 'task-1' });
    const stored = await claimWithBrief(b.sched, paths(b), 'task-1', 'engineer');
    expect(Object.keys(stored).sort()).toEqual(Object.keys(plain).sort());
    expect(stored.briefMarker).toBe(`minions-lease: ${stored.leaseId}`);
    expect(JSON.parse(readFileSync(briefPath(paths(b), stored.leaseId), 'utf8'))).toEqual(stored);
  });

  it('a brief that cannot be stored releases the lease again', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const blocker = join(env.root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const e = await fail(claimWithBrief(env.sched, { briefs: join(blocker, 'briefs'), results: paths(env).results }, 'task-1', 'engineer'));
    expect(e).toBeInstanceOf(Error);
    expect(env.db.activeLeases()).toHaveLength(0);
    expect(env.backlog.status('task-1')).toBe('ready');
  });
});
