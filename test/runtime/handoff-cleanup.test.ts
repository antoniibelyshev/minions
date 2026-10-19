import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import {
  briefPath, claimWithBrief, recordSubmitted, rejectedPath, submissionPath, submitResult, type HandoffPaths,
} from '../../src/runtime/handoff.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, makeEnv, result, type Env } from './fixtures.js';

// Hand-off files (brief, submission, rejected submission) are removed whenever a lease ends (task-9).

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

const files = (p: HandoffPaths, id: string) => ({
  brief: existsSync(briefPath(p, id)), submission: existsSync(submissionPath(p, id)), rejected: existsSync(rejectedPath(p, id)),
});
const none = { brief: false, submission: false, rejected: false };

describe('lease files are removed when a lease ends', () => {
  it('successful record (after a rejected first attempt) removes the brief, submission and rejected file; the DB keeps the result', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, 'not json', owner);
    expect((await recordSubmitted(env.sched, p, brief.leaseId)).correctionAllowed).toBe(true);
    expect(files(p, brief.leaseId)).toEqual({ brief: true, submission: false, rejected: true });
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head, summary: 'fixed' })), owner);
    expect((await recordSubmitted(env.sched, p, brief.leaseId, { correction: true })).valid).toBe(true);
    expect(files(p, brief.leaseId)).toEqual(none);
    expect(JSON.parse(env.db.lease(brief.leaseId)!.result_json!).summary).toBe('fixed');
  });

  it('a valid result recorded on stdin also removes the brief', async () => {
    const env = makeEnv();
    const { brief, head } = await engineer(env);
    const p = paths(env);
    expect(files(p, brief.leaseId).brief).toBe(true);
    expect((await env.sched.record(brief.leaseId, json(result({ branch: brief.branch, headSha: head })))).valid).toBe(true);
    expect(files(p, brief.leaseId)).toEqual(none);
  });

  it('an unvalidated final record removes all files and keeps the raw result in the DB', async () => {
    const env = makeEnv();
    const { brief, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, 'not json', owner);
    await recordSubmitted(env.sched, p, brief.leaseId);
    await submitResult(env.db, p, brief.leaseId, '{"still":"bad"}', owner);
    const r = await recordSubmitted(env.sched, p, brief.leaseId, { correction: true });
    expect(r.unvalidated).toBe(true);
    expect(files(p, brief.leaseId)).toEqual(none);
    expect(env.db.lease(brief.leaseId)!.result_json).toBe('{"still":"bad"}');
  });

  it('release (e.g. a stale lease in recovery) removes the brief, a pending submission and a rejected one', async () => {
    const env = makeEnv();
    const { brief, owner } = await engineer(env);
    const p = paths(env);
    await submitResult(env.db, p, brief.leaseId, 'not json', owner);
    await recordSubmitted(env.sched, p, brief.leaseId); // moved aside as rejected
    await submitResult(env.db, p, brief.leaseId, '{"pending":true}', owner);
    expect(files(p, brief.leaseId)).toEqual({ brief: true, submission: true, rejected: true });
    await env.sched.release(brief.leaseId, 'stale lease: worker gone');
    expect(files(p, brief.leaseId)).toEqual(none);
    expect(env.db.lease(brief.leaseId)!.status).toBe('released');
  });

  it('record --submitted on an ended lease reports CONFLICT before reading and removes leftover files', async () => {
    const env = makeEnv();
    const { brief, head, owner } = await engineer(env);
    const p = paths(env);
    // A scheduler without hand-off paths ends the lease and leaves the files behind.
    const bare = new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout });
    await submitResult(env.db, p, brief.leaseId, json(result({ branch: brief.branch, headSha: head })), owner);
    await bare.release(brief.leaseId, 'worker died');
    writeFileSync(rejectedPath(p, brief.leaseId), 'old');
    expect(files(p, brief.leaseId)).toEqual({ brief: true, submission: true, rejected: true });
    const e = await fail(recordSubmitted(env.sched, p, brief.leaseId));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toMatch(/already ended \(released\)/);
    expect(files(p, brief.leaseId)).toEqual(none);
  });

  it('record --submitted on an ended lease with no file still reports CONFLICT, not NOT_FOUND', async () => {
    const env = makeEnv();
    const { brief } = await engineer(env);
    await env.sched.release(brief.leaseId, 'done');
    expect((await fail(recordSubmitted(env.sched, paths(env), brief.leaseId))).code).toBe('CONFLICT');
    expect((await fail(recordSubmitted(env.sched, paths(env), brief.leaseId, { correction: true }))).code).toBe('CONFLICT');
  });

  it('stdin record and release on an ended lease also remove leftover files', async () => {
    const env = makeEnv();
    const { brief, owner } = await engineer(env);
    const p = paths(env);
    const bare = new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout });
    await submitResult(env.db, p, brief.leaseId, '{}', owner);
    await bare.release(brief.leaseId, 'worker died');
    expect((await fail(env.sched.record(brief.leaseId, '{}'))).code).toBe('CONFLICT');
    expect(files(p, brief.leaseId)).toEqual(none);
    writeFileSync(submissionPath(p, brief.leaseId), '{}');
    expect((await fail(env.sched.release(brief.leaseId, 'again'))).code).toBe('CONFLICT');
    expect(files(p, brief.leaseId)).toEqual(none);
  });

  it('a failed delete is logged and does not fail the transition', async () => {
    const env = makeEnv();
    const { brief } = await engineer(env);
    const p = paths(env);
    // A non-empty directory where the submission should be: rm (without recursive) fails.
    mkdirSync(join(submissionPath(p, brief.leaseId), 'x'), { recursive: true });
    const r = await env.sched.release(brief.leaseId, 'worker died');
    expect(r.status).toBe('ready');
    expect(env.db.lease(brief.leaseId)!.status).toBe('released');
    expect(existsSync(briefPath(p, brief.leaseId))).toBe(false); // the other files are still removed
    const ev = env.db.events('task-1', 'handoff-cleanup-error');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ leaseId: brief.leaseId });
    expect(((ev[0]!.data as { errors: string[] }).errors)[0]).toContain(submissionPath(p, brief.leaseId));
  });
});
