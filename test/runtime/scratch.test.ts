import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  briefPath, claimWithBrief, compactClaim, scratchDirOf, sweepScratch, sweepScratchOnStart, type HandoffPaths,
} from '../../src/runtime/handoff.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { commitFile, makeEnv, result, type Env } from './fixtures.js';

// Per-lease scratch dirs under the disk-backed TMPDIR (task-27): created at claim, removed when the lease
// ends and on coordinator start. Only a lease's own dir is ever removed.

const paths = (env: Env): HandoffPaths => ({
  briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results'), scratch: join(env.root, 'cache', 'tmp', 'leases'),
});
const sched = (env: Env, p: HandoffPaths) => new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, handoff: p });

async function claim(env: Env, s: Scheduler, id = 'task-1') {
  env.backlog.add({ id });
  const brief = await claimWithBrief(s, paths(env), id, 'engineer');
  // Leftover test data, nested, as a test run would leave it.
  mkdirSync(join(brief.scratchDir!, 'vitest-abc', 'deep'), { recursive: true });
  writeFileSync(join(brief.scratchDir!, 'vitest-abc', 'deep', 'big.bin'), 'x'.repeat(1024));
  return brief;
}

describe('lease scratch dirs', () => {
  it('claim creates a private scratch dir and names it in the stored brief and the compact claim', async () => {
    const env = makeEnv();
    const p = paths(env);
    env.backlog.add({ id: 'task-1' });
    const brief = await claimWithBrief(sched(env, p), p, 'task-1', 'engineer');
    expect(brief.scratchDir).toBe(join(p.scratch!, brief.leaseId));
    expect(statSync(brief.scratchDir!).isDirectory()).toBe(true);
    expect(statSync(brief.scratchDir!).mode & 0o777).toBe(0o700);
    expect(brief.scratchDir!.startsWith(brief.worktree)).toBe(false);
    expect(JSON.parse(readFileSync(briefPath(p, brief.leaseId), 'utf8')).scratchDir).toBe(brief.scratchDir);
    expect(compactClaim(brief).scratchDir).toBe(brief.scratchDir);
  });

  it('without a scratch parent there is no scratch dir (and nothing to clean)', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const p = { briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') };
    const brief = await claimWithBrief(env.sched, p, 'task-1', 'engineer');
    expect(brief.scratchDir).toBeUndefined();
    expect(compactClaim(brief)).not.toHaveProperty('scratchDir');
    expect(scratchDirOf(p, brief.leaseId)).toBeNull();
  });

  it('recording the result removes only that lease\'s scratch dir; the worktree, other leases\' dirs and other entries stay', async () => {
    const env = makeEnv();
    const p = paths(env);
    const s = sched(env, p);
    const a = await claim(env, s, 'task-1');
    const b = await claim(env, s, 'task-2');
    const other = join(p.scratch!, '..', 'not-a-lease-file');
    writeFileSync(other, 'keep');
    mkdirSync(join(p.scratch!, 'random-dir'));
    const head = commitFile(a.worktree, 'a.txt', 'work');
    expect((await s.record(a.leaseId, JSON.stringify(result({ branch: a.branch, headSha: head }))))).toMatchObject({ valid: true });
    expect(existsSync(a.scratchDir!)).toBe(false);
    expect(existsSync(b.scratchDir!)).toBe(true);
    expect(existsSync(join(b.scratchDir!, 'vitest-abc', 'deep', 'big.bin'))).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(p.scratch!, 'random-dir'))).toBe(true);
    expect(existsSync(join(a.worktree, 'a.txt'))).toBe(true);
  });

  it('release (stale lease) removes the scratch dir too', async () => {
    const env = makeEnv();
    const p = paths(env);
    const s = sched(env, p);
    const a = await claim(env, s);
    await s.release(a.leaseId, 'stale lease: worker gone');
    expect(existsSync(a.scratchDir!)).toBe(false);
    expect(existsSync(a.worktree)).toBe(true);
  });

  it('a symlink in place of a lease scratch dir is removed without following it', async () => {
    const env = makeEnv();
    const p = paths(env);
    const s = sched(env, p);
    const a = await claim(env, s);
    const victim = join(env.root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'precious'), 'x');
    rmSync(a.scratchDir!, { recursive: true });
    symlinkSync(victim, a.scratchDir!);
    await s.release(a.leaseId, 'done');
    expect(existsSync(a.scratchDir!)).toBe(false);
    expect(existsSync(join(victim, 'precious'))).toBe(true);
  });

  it('coordinator start sweeps the dirs of ended and unknown leases, keeps active ones and non-lease entries', async () => {
    const env = makeEnv();
    const p = paths(env);
    // A scheduler without scratch cleanup ends a lease, leaving its dir behind (as a crash would).
    const noClean = new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout });
    const ended = await claim(env, noClean, 'task-1');
    await noClean.release(ended.leaseId, 'crash');
    const active = await claim(env, noClean, 'task-2');
    const unknown = join(p.scratch!, 'lease-deadbeef0000');
    mkdirSync(unknown);
    const foreign = join(p.scratch!, 'notalease');
    mkdirSync(foreign);
    expect(existsSync(ended.scratchDir!)).toBe(true);

    const logs: string[] = [];
    await sweepScratchOnStart(env.db, p, (l) => logs.push(l));
    expect(existsSync(ended.scratchDir!)).toBe(false);
    expect(existsSync(unknown)).toBe(false);
    expect(existsSync(active.scratchDir!)).toBe(true);
    expect(existsSync(join(active.scratchDir!, 'vitest-abc', 'deep', 'big.bin'))).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(active.worktree)).toBe(true);
    expect(logs.join('\n')).toMatch(/removed 2 leftover lease scratch dir/);

    // Idempotent; a missing parent is not an error.
    expect(await sweepScratch(p, [active.leaseId])).toEqual({ removed: [], errors: [] });
    expect(await sweepScratch({ ...p, scratch: join(env.root, 'missing') }, [])).toEqual({ removed: [], errors: [] });
    expect(await sweepScratch({ briefs: p.briefs, results: p.results }, [])).toEqual({ removed: [], errors: [] });
  });

  it('a startup sweep failure is logged, never thrown', async () => {
    const env = makeEnv();
    const logs: string[] = [];
    const broken = { activeLeases: () => { throw new Error('db locked'); } };
    await sweepScratchOnStart(broken as never, paths(env), (l) => logs.push(l));
    expect(logs.join('\n')).toMatch(/scratch sweep failed: db locked/);
  });
});
