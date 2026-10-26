// task-14.4 tester: adversarial regressions for the process runner (`minions work run`) with the fake harness.
// Isolation is `none` (no minions-sandbox here), so every case below is something the post-exit checks and the
// hardened runner git must catch on their own. Never starts a real harness or a Claude session.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHASE_RULES } from '../../src/config/harnesses.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { requestDrain } from '../../src/runtime/drain.js';
import { submissionPath } from '../../src/runtime/handoff.js';
import { fakeAdapter, type ProcessAdapter } from '../../src/runtime/runner/adapter.js';
import { readRunRecord } from '../../src/runtime/runner/record.js';
import { runLease, type RunnerDeps } from '../../src/runtime/runner/run.js';
import { Scheduler, type TaskBrief } from '../../src/runtime/scheduler.js';
import { commitFile, gitSync, makeDefaultEnv, type Env } from './fixtures.js';

const SCRIPT = resolve(__dirname, '..', 'fixtures', 'fake-harness.mjs');
const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol'] }, timeoutMinutes: 5 };
const set = (c: MinionsConfig, patch: Record<string, unknown>) => Object.assign(c as unknown as Record<string, unknown>, structuredClone(patch));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'sk-fake-tester-secret-0123456789abcdef';

interface Rig extends Env { paths: RunnerDeps['paths']; deps: (scenario: unknown, over?: Partial<RunnerDeps>) => RunnerDeps; common: string }

function rig(mutate?: (c: MinionsConfig) => void, phase = PHASE_RULES['1a']): Rig {
  const e = makeDefaultEnv((c) => { set(c, { harnesses: { codex: CODEX }, roles: { engineer: { harness: 'codex' } } }); mutate?.(c); });
  const state = join(e.root, 'state');
  const paths = { state, briefs: join(state, 'briefs'), results: join(state, 'results'), scratch: join(e.root, 'scratch'), secretsDir: join(e.root, 'secrets'), drainFlag: join(state, 'run', 'drain') };
  e.sched = new Scheduler({ db: e.db, backlog: e.backlog, config: e.config, layout: e.layout, handoff: paths, phase });
  const common = join(e.layout.repo, '.git');
  const deps = (scenario: unknown, over: Partial<RunnerDeps> = {}): RunnerDeps => ({
    db: e.db, config: e.config, paths, commonDir: common, adapters: { codex: fakeAdapter({ script: SCRIPT, scenario }) },
    isolation: { kind: 'none' }, phase, callerEnv: {}, callerCwd: e.root, env: process.env,
    timing: { pollMs: 50, killGraceMs: 400, drainGraceMs: 200 }, ...over,
  });
  return { ...e, paths, deps, common };
}

async function claim(r: Rig, id = 'task-1'): Promise<TaskBrief> {
  if (!r.backlog.tasks.has(id)) r.backlog.add({ id });
  const { claimWithBrief } = await import('../../src/runtime/handoff.js');
  return claimWithBrief(r.sched, r.paths, id, undefined);
}

const headOf = (r: Rig, branch: string) => gitSync(r.layout.repo, 'rev-parse', `refs/heads/${branch}`);
const submitted = (r: Rig, b: TaskBrief) => JSON.parse(readFileSync(submissionPath(r.paths, b.leaseId), 'utf8')) as { status: string; findings: string[]; headSha: string };
const alive = (pid: number) => { try { process.kill(pid, 0); return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };

/** Every file below `dir` (no symlink following). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}

async function attacked(script: string | ((c: { r: Rig; b: TaskBrief; stateFile: string; stateDir: string }) => string), extra: unknown[] = [{ op: 'result' }]) {
  const r = rig();
  const b = await claim(r);
  const stateDir = join(r.root, 'state-dir');
  mkdirSync(stateDir);
  const stateFile = join(stateDir, 'precious');
  writeFileSync(stateFile, 'precious\n');
  const s = typeof script === 'function' ? script({ r, b, stateFile, stateDir }) : script;
  const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'sh', script: s }, ...extra] }));
  return { r, b, out, stateFile, stateDir };
}

function nothingFetched(x: Awaited<ReturnType<typeof attacked>>, pattern: RegExp) {
  expect(x.out.violations.join('\n')).toMatch(pattern);
  expect(headOf(x.r, x.b.branch)).toBe(x.b.expectedHead);
  expect(x.out).toMatchObject({ submitted: true, status: 'blocked' });
  expect(gitSync(x.r.layout.repo, 'for-each-ref', 'refs/minions')).toBe('');
  expect(gitSync(x.b.worktree, 'rev-parse', 'HEAD')).toBe(x.b.expectedHead);
}

describe('tester: the whole .git tree is checked, not only hooks', () => {
  it('a symlinked objects fan-out directory into a "state" dir', async () => {
    const x = await attacked(({ stateDir }) => `echo a > a.txt && git add a.txt && git commit -qm a && ln -s ${stateDir} .git/objects/zz`);
    nothingFetched(x, /symlink in the git dir: .*objects\/zz/);
    expect(readdirSync(x.stateDir)).toEqual(['precious']);
  });

  it('a symlink in objects/pack and in logs/ (deep, below a real directory)', async () => {
    const x = await attacked(({ stateFile }) => `echo a > a.txt && git add a.txt && git commit -qm a && mkdir -p .git/logs/refs/heads/deep/er && ln -s ${stateFile} .git/logs/refs/heads/deep/er/x && ln -s ${stateFile} .git/objects/pack/pack-evil.idx`);
    nothingFetched(x, /symlink in the git dir: .*(logs\/refs\/heads\/deep\/er\/x|objects\/pack\/pack-evil\.idx)/);
    expect(readFileSync(x.stateFile, 'utf8')).toBe('precious\n');
  });

  it('a FIFO in the git dir is a special-file violation (and the runner does not hang on it)', async () => {
    const x = await attacked('echo a > a.txt && git add a.txt && git commit -qm a && mkfifo .git/refs/heads/fifo');
    nothingFetched(x, /special file in the git dir: .*refs\/heads\/fifo/);
  });
});

describe('tester: forged history never fetches', () => {
  it('a replace ref (git replace --graft) faking the claim head as parent of an orphan commit', async () => {
    const x = await attacked('T=$(git write-tree) && C=$(git commit-tree $T -m orphan) && git replace --graft $C $CLAIM && git update-ref refs/heads/$BRANCH $C');
    nothingFetched(x, /not a fast-forward/);
    expect(gitSync(x.r.layout.repo, 'for-each-ref', 'refs/replace')).toBe('');
  });

  it('an info/grafts file faking the ancestry', async () => {
    const x = await attacked('T=$(git write-tree) && C=$(git commit-tree $T -m orphan) && mkdir -p .git/info && echo "$C $CLAIM" > .git/info/grafts && git update-ref refs/heads/$BRANCH $C');
    nothingFetched(x, /not a fast-forward/);
  });

  it('a loose object whose content is another commit (hash mismatch) is never fetched', async () => {
    // C1 is an orphan (not a fast-forward); its object file holds C2, a child of the claim head.
    const script = [
      'echo evil > a.txt && git add a.txt && T=$(git write-tree)',
      'C1=$(git commit-tree $T -m orphan) && C2=$(git commit-tree $T -p $CLAIM -m forged)',
      'f() { echo .git/objects/$(echo $1 | cut -c1-2)/$(echo $1 | cut -c3-); }',
      // The ref first (update-ref checks the hash), then the object file swapped under it.
      'git update-ref refs/heads/$BRANCH $C1',
      'chmod u+w $(f $C1) && cp $(f $C2) $(f $C1) && rm -f $(f $C2)',
    ].join(' && ');
    const x = await attacked(script);
    // Either the runner's own read sees the hash mismatch or fsck on the fetch does: C1 never lands in the shared repo.
    nothingFetched(x, /fetch: rejected|the clone has no branch|not a fast-forward/);
    expect(gitSync(x.r.layout.repo, 'cat-file', '-t', x.b.expectedHead)).toBe('commit');
  });
});

describe('tester: no secrets in argv', () => {
  it('neither the worker nor any runner git call carries the secret in argv; it lands in no state, scratch or git file', async () => {
    const r = rig();
    const b = await claim(r);
    mkdirSync(r.paths.secretsDir, { recursive: true });
    writeFileSync(join(r.paths.secretsDir, 'fake-key'), `${SECRET}\n`);
    // A git shim first on PATH logs the argv of every git process (runner and worker).
    const bin = join(r.root, 'shim');
    mkdirSync(bin);
    const log = join(r.root, 'git-argv.log');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const scenario = { steps: [{ op: 'commit', file: 'a.txt', content: 'x\n' }, { op: 'result' }] };
    const out = await runLease(b.leaseId, r.deps(scenario, { env, adapters: { codex: fakeAdapter({ script: SCRIPT, scenario, secretEnv: { FAKE_API_KEY: 'fake-key' } }) } }));
    expect(out).toMatchObject({ submitted: true, status: 'complete', violations: [] });
    const calls = readFileSync(log, 'utf8');
    expect(calls).toMatch(/--git-dir=.*fetch/);
    expect(calls).not.toContain(SECRET);
    for (const f of [...filesUnder(r.paths.state).filter((p) => !p.endsWith('.db') && !p.includes('.db-')), ...filesUnder(join(r.paths.scratch, b.leaseId)), ...filesUnder(r.common)]) {
      expect(readFileSync(f).includes(SECRET), f).toBe(false);
    }
    expect(JSON.stringify(r.db.events('task-1'))).not.toContain(SECRET);
  });

  it('an adapter plan that puts the secret in argv is refused before the spawn; the error and the result do not echo it', async () => {
    const r = rig();
    const b = await claim(r);
    mkdirSync(r.paths.secretsDir, { recursive: true });
    writeFileSync(join(r.paths.secretsDir, 'fake-key'), `${SECRET}\n`);
    const pidFile = join(r.root, 'spawned.pid');
    const base = fakeAdapter({ script: SCRIPT, scenario: { steps: [{ op: 'pidfile', path: pidFile }, { op: 'result' }] }, secretEnv: { FAKE_API_KEY: 'fake-key' } });
    const leaky: ProcessAdapter = { ...base, plan: (i) => { const p = base.plan(i); return { ...p, argv: [...p.argv, `--api-key=${SECRET}`] }; } };
    const out = await runLease(b.leaseId, r.deps({}, { adapters: { codex: leaky } }));
    expect(out.error).toMatch(/secret in its argv/);
    expect(out.error).not.toContain(SECRET);
    expect(existsSync(pidFile)).toBe(false);
    expect(out).toMatchObject({ submitted: true, status: 'blocked' });
    expect(readFileSync(submissionPath(r.paths, b.leaseId), 'utf8')).not.toContain(SECRET);
    expect((await readRunRecord(r.paths.state, b.leaseId))?.phase).toBe('done');
  });
});

describe('tester: stopping leaves no process behind', () => {
  it('timeout: a worker ignoring SIGTERM and its (same-group) grandchild are both gone', async () => {
    const r = rig();
    const b = await claim(r);
    const workerPid = join(r.root, 'worker.pid');
    const gcPid = join(r.root, 'gc.pid');
    const steps = [{ op: 'ignoreTerm' }, { op: 'pidfile', path: workerPid }, { op: 'grandchild', pidFile: gcPid }, { op: 'sleep', ms: 30_000 }];
    const out = await runLease(b.leaseId, r.deps({ steps }, { timing: { timeoutMs: 700, pollMs: 50, killGraceMs: 300, drainGraceMs: 100 } }));
    expect(out).toMatchObject({ status: 'partial', exit: { stopped: 'timeout' } });
    await sleep(100);
    expect(alive(Number(readFileSync(workerPid, 'utf8')))).toBe(false);
    expect(alive(Number(readFileSync(gcPid, 'utf8')))).toBe(false);
  });

  it('cancel by release: the worker and its grandchild are gone and the record is done', async () => {
    const r = rig();
    const b = await claim(r);
    const workerPid = join(r.root, 'worker.pid');
    const gcPid = join(r.root, 'gc.pid');
    const p = runLease(b.leaseId, r.deps({ steps: [{ op: 'ignoreTerm' }, { op: 'pidfile', path: workerPid }, { op: 'grandchild', pidFile: gcPid }, { op: 'sleep', ms: 30_000 }] }));
    for (let i = 0; i < 100 && !existsSync(gcPid); i++) await sleep(50);
    await r.sched.release(b.leaseId, 'owner cancel');
    const out = await p;
    expect(out).toMatchObject({ submitted: false, exit: { stopped: 'lease-ended' } });
    await sleep(100);
    expect(alive(Number(readFileSync(workerPid, 'utf8')))).toBe(false);
    expect(alive(Number(readFileSync(gcPid, 'utf8')))).toBe(false);
    expect((await readRunRecord(r.paths.state, b.leaseId))?.phase).toBe('done');
  });

  it('drain with nothing to commit: partial, no wip: commit, branch at the claim head', async () => {
    const r = rig();
    const b = await claim(r);
    const p = runLease(b.leaseId, r.deps({ steps: [{ op: 'sleep', ms: 30_000 }] }));
    for (let i = 0; i < 100 && (await readRunRecord(r.paths.state, b.leaseId))?.phase !== 'running'; i++) await sleep(50);
    requestDrain(r.db, r.paths, 'upgrade');
    const out = await p;
    expect(out).toMatchObject({ status: 'partial', wipCommit: null, exit: { stopped: 'drain' } });
    expect(headOf(r, b.branch)).toBe(b.expectedHead);
    expect(submitted(r, b).headSha).toBe(b.expectedHead);
  });
});

describe('tester: the shared side', () => {
  it('the lease branch moved in the shared repository during the run: nothing is fetched and the other commit stays', async () => {
    const r = rig();
    const b = await claim(r);
    const p = runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'a.txt', content: 'mine\n' }, { op: 'sleep', ms: 600 }, { op: 'result' }] }));
    await sleep(200);
    const theirs = commitFile(b.worktree, 'b.txt', 'theirs\n');
    const out = await p;
    expect(out.violations.join('\n')).toMatch(/moved in the shared repository during the run/);
    expect(headOf(r, b.branch)).toBe(theirs);
    expect(existsSync(join(b.worktree, 'a.txt'))).toBe(false);
  });

  it('planted hooks, fsmonitor and filters in the shared config never run during the fetch-back and fast-forward', async () => {
    const r = rig();
    const b = await claim(r);
    const marker = join(r.root, 'MARKER');
    const evil = join(r.root, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\necho ran >> ${marker}\ncat\n`, { mode: 0o755 });
    const hook = `#!/bin/sh\necho ran >> ${marker}\n`;
    const steps = [
      { op: 'commit', file: '.gitattributes', content: '* filter=evil\n' },
      { op: 'commit', file: 'a.txt', content: 'x\n' },
      { op: 'result' },
      // An L1 gap: the worker writes the shared git dir (hooks, config).
      { op: 'append', path: join(r.common, 'config'), content: `[core]\n\tfsmonitor = ${evil}\n[filter "evil"]\n\tclean = ${evil}\n\tsmudge = ${evil}\n\trequired = true\n` },
      ...['post-merge', 'post-checkout', 'reference-transaction', 'pre-merge-commit'].map((h) => ({ op: 'write', path: join(r.common, 'hooks', h), content: hook })),
    ];
    for (const h of ['post-merge', 'post-checkout', 'reference-transaction']) { mkdirSync(join(r.common, 'hooks'), { recursive: true }); writeFileSync(join(r.common, 'hooks', h), hook, { mode: 0o755 }); }
    const out = await runLease(b.leaseId, r.deps({ steps }));
    expect(existsSync(marker)).toBe(false);
    expect(out).toMatchObject({ status: 'complete', violations: [] });
    expect(readFileSync(join(b.worktree, 'a.txt'), 'utf8')).toBe('x\n');
  });

  it('a config.worktree planted in the lease admin dir (absent at the snapshot) is a violation, removed before any shared git call', async () => {
    const r = rig();
    const b = await claim(r);
    const marker = join(r.root, 'MARKER');
    const evil = join(r.root, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\necho ran >> ${marker}\n`, { mode: 0o755 });
    const admin = readFileSync(join(b.worktree, '.git'), 'utf8').replace(/^gitdir: /, '').trim();
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'a.txt' }, { op: 'write', path: join(admin, 'config.worktree'), content: `[core]\n\tfsmonitor = ${evil}\n\thooksPath = ${r.root}\n` }, { op: 'result' }] }));
    expect(out.violations.join('\n')).toMatch(/lease git files changed: .*config\.worktree/);
    expect(existsSync(join(admin, 'config.worktree'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(headOf(r, b.branch)).toBe(b.expectedHead);
  });
});

describe('tester: hard links in the git dirs the runner rewrites', () => {
  // KNOWN DEFECT (task-14.4 QA): a hard link passes lstat as a regular file, and writeNoFollow (repo.ts) opens it
  // with O_TRUNC, so the runner writes through it to whatever file it is linked to. Under L1 the link into /state
  // is denied (Landlock REFER); without L1 the post-exit rewrite must still not write through, as with symlinks.
  // These are it.fails until the runner refuses nlink > 1 or replaces files by rename: flip them to it() then.
  it.fails('.git/config hard-linked to a "state" file is not overwritten by the sanitize rewrite', async () => {
    const r = rig();
    const b = await claim(r);
    const stateFile = join(r.root, 'state-dir', 'precious');
    mkdirSync(join(r.root, 'state-dir'));
    writeFileSync(stateFile, 'precious\n');
    chmodSync(stateFile, 0o644);
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'a.txt' }, { op: 'result' }, { op: 'sh', script: `rm .git/config && ln ${stateFile} .git/config` }] }));
    expect(statSync(stateFile).nlink).toBeGreaterThanOrEqual(1);
    expect(readFileSync(stateFile, 'utf8')).toBe('precious\n');
  });

  it.fails('the lease worktree .git pointer hard-linked to a "state" file is not overwritten by the restore', async () => {
    const r = rig();
    const b = await claim(r);
    const stateFile = join(r.root, 'state-dir', 'precious');
    mkdirSync(join(r.root, 'state-dir'));
    writeFileSync(stateFile, 'precious\n');
    const dotGit = join(b.worktree, '.git');
    const out = await runLease(b.leaseId, r.deps({ steps: [{ op: 'commit', file: 'a.txt' }, { op: 'result' }, { op: 'sh', script: `rm ${dotGit} && ln ${stateFile} ${dotGit}` }] }));
    expect(out.violations.join('\n')).toMatch(/lease git files changed/);
    expect(readFileSync(stateFile, 'utf8')).toBe('precious\n');
  });
});
