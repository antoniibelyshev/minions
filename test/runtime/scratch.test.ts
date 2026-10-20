import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  briefPath, claimWithBrief, compactClaim, ensureScratchDir, removeLeaseFiles, scratchDirOf, sweepScratch, sweepScratchOnStart, type HandoffPaths,
} from '../../src/runtime/handoff.js';
import { runtimePaths } from '../../src/runtime/paths.js';
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

// Deletion safety (tester, task-27): nothing outside <scratch>/<leaseId> is ever removed, whatever the
// lease id, the entries found by the sweep or the configured roots look like.
describe('lease scratch deletion safety', () => {
  it('lease ids that could escape the scratch parent are rejected before any path is built', async () => {
    const env = makeEnv();
    const p = paths(env);
    // Bait: dirs a traversal would reach (the scratch parent's parent and the parent itself).
    mkdirSync(join(p.scratch!, 'lease-a', 'b'), { recursive: true });
    mkdirSync(join(p.scratch!, '..', 'x'), { recursive: true });
    for (const bad of ['..', '.', '', '../x', 'lease-a/../../x', 'lease-a/b', '/etc', 'lease-..', 'lease-a\0b', 'lease-a.json']) {
      expect(() => scratchDirOf(p, bad), JSON.stringify(bad)).toThrow();
      // removeLeaseFiles is a no-op for malformed ids (pre-existing contract): nothing is removed.
      expect(await removeLeaseFiles(p, bad), JSON.stringify(bad)).toEqual([]);
      expect(await ensureScratchDir(p, bad).catch(() => 'threw')).toBe('threw');
    }
    expect(existsSync(join(p.scratch!, 'lease-a', 'b'))).toBe(true);
    expect(existsSync(join(p.scratch!, '..', 'x'))).toBe(true);
    expect(existsSync(p.scratch!)).toBe(true);
  });

  it('an empty scratch root means no scratch at all, never the cwd or /leases', async () => {
    const env = makeEnv();
    const p = { ...paths(env), scratch: '' };
    expect(scratchDirOf(p, 'lease-abc')).toBeNull();
    expect(await ensureScratchDir(p, 'lease-abc')).toBeNull();
    expect(await sweepScratch(p, [])).toEqual({ removed: [], errors: [] });
    expect(await removeLeaseFiles(p, 'lease-abc')).toEqual([]);
    // Empty env values fall back to the absolute container default, never a relative path or "/leases".
    for (const e of [{}, { TMPDIR: '' }, { MINIONS_SCRATCH_DIR: '' }, { MINIONS_SCRATCH_DIR: '', MINIONS_STATE_DIR: '' }, { TMPDIR: '/elsewhere' }]) {
      const rp = runtimePaths(e);
      expect(rp.scratch, JSON.stringify(e)).toBe('/home/node/.cache/tmp/leases');
      expect(isAbsolute(rp.tmp)).toBe(true);
    }
  });

  it('the sweep removes lease-named symlinks and files without following them and skips names that are not lease ids', async () => {
    const env = makeEnv();
    const p = paths(env);
    mkdirSync(p.scratch!, { recursive: true });
    const victim = join(env.root, 'victim');
    mkdirSync(join(victim, 'lease-inner'), { recursive: true });
    writeFileSync(join(victim, 'precious'), 'x');
    symlinkSync(victim, join(p.scratch!, 'lease-link'));
    writeFileSync(join(p.scratch!, 'lease-file'), 'x');
    const kept = ['lease-x.json', '.lease-hidden', 'lease-', 'xlease-a', 'lease-a b'];
    for (const n of kept) mkdirSync(join(p.scratch!, n));
    // A lease dir nested inside a foreign entry is not a sweep target either.
    mkdirSync(join(p.scratch!, 'lease-x.json', 'lease-nested'));

    const r = await sweepScratch(p, []);
    expect(r).toEqual({ removed: ['lease-file', 'lease-link'], errors: [] });
    expect(existsSync(join(victim, 'precious'))).toBe(true);
    expect(existsSync(join(victim, 'lease-inner'))).toBe(true);
    expect(readdirSync(p.scratch!).sort()).toEqual([...kept].sort());
    expect(existsSync(join(p.scratch!, 'lease-x.json', 'lease-nested'))).toBe(true);
    // The parent dir and its siblings (the TMPDIR root) stay.
    expect(existsSync(join(p.scratch!, '..'))).toBe(true);
  });

  it('unreadable or unremovable scratch dirs are reported, never thrown, and leave the coordinator start going', async () => {
    const env = makeEnv();
    const p = paths(env);
    mkdirSync(join(p.scratch!, 'lease-stuck', 'sub'), { recursive: true });
    const logs: string[] = [];
    try {
      // Removal fails: the parent is read-only.
      chmodSync(p.scratch!, 0o500);
      const r = await sweepScratch(p, []);
      if (process.getuid?.() !== 0) {
        expect(r.removed).toEqual([]);
        expect(r.errors.join('\n')).toContain('lease-stuck');
      }
      await sweepScratchOnStart(env.db, p, (l) => logs.push(l));
      // Listing fails: the parent is unreadable.
      chmodSync(p.scratch!, 0o000);
      const r2 = await sweepScratch(p, []);
      if (process.getuid?.() !== 0) expect(r2.errors.join('\n')).toContain(p.scratch!);
      await sweepScratchOnStart(env.db, p, (l) => logs.push(l));
    } finally {
      chmodSync(p.scratch!, 0o700);
    }
    if (process.getuid?.() !== 0) expect(logs.join('\n')).toMatch(/could not remove some lease scratch dirs/);
    // A scratch root that is a file (not a dir) is an error, not a crash.
    const fileRoot = join(env.root, 'scratch-file');
    writeFileSync(fileRoot, 'x');
    expect((await sweepScratch({ ...p, scratch: fileRoot }, [])).errors).toHaveLength(1);
    expect(existsSync(fileRoot)).toBe(true);
  });

  it('a scratch dir that cannot be created does not block the claim: the brief just has no scratchDir', async () => {
    const env = makeEnv();
    const p = paths(env);
    mkdirSync(join(p.scratch!, '..'), { recursive: true });
    writeFileSync(p.scratch!, 'not a dir');
    env.backlog.add({ id: 'task-1' });
    const brief = await claimWithBrief(sched(env, p), p, 'task-1', 'engineer');
    expect(brief.scratchDir).toBeUndefined();
    expect(existsSync(briefPath(p, brief.leaseId))).toBe(true);
    expect(readFileSync(p.scratch!, 'utf8')).toBe('not a dir');
  });
});
