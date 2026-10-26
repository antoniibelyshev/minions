// `minions upgrade` source phase: --from-container fast-forward against real temp git repos, and the
// installed-CLI check/reinstall with a fake npm (nothing is installed into any real global prefix).
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sourceFingerprint } from '../../scripts/source-fingerprint.mjs';
import { run, type RunOptions, type RunResult } from '../../src/core/exec.js';
import { MinionsError } from '../../src/core/errors.js';
import { Compose } from '../../src/host/docker.js';
import type { ExportResult } from '../../src/host/transfer.js';
import { formatUpgrade, runUpgrade, type UpgradeResult } from '../../src/host/upgrade.js';
import { backupInstalledCli, listCliBackups } from '../../src/host/cli-backup.js';
import { applyCli, checkCli, isMinionsCheckout, runSourcePhase, syncFromContainer, syncFromOrigin, upgradeSourceMode, type SourcePhaseOptions } from '../../src/host/upgrade-source.js';
import { git, makeRepo, tempDir, withHome } from './fixtures.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
let home: ReturnType<typeof withHome>;
beforeEach(() => { home = withHome(); });
afterEach(() => home.cleanup());

// ---------------------------------------------------------------- sync

/** Repo on main plus refs/remotes/minions/main one commit ahead (as an export would leave it). */
function syncRepo() {
  const repo = makeRepo(home.root);
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'tmp');
  writeFileSync(join(repo, 'feature.txt'), 'from the container\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'agent work');
  const ahead = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'update-ref', 'refs/remotes/minions/main', ahead);
  git(repo, 'branch', '-q', '-D', 'tmp');
  let exports = 0;
  const exportRepo = async (): Promise<ExportResult> => { exports++; return { bundle: 'b', refs: ['refs/heads/main'], changes: [{ ref: 'refs/remotes/minions/main', from: base, to: ahead }] }; };
  return { repo, base, ahead, exportRepo, exports: () => exports };
}
const head = (repo: string, ref = 'refs/heads/main') => git(repo, 'rev-parse', ref);
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as MinionsError; } throw new Error('expected a refusal'); };

describe('--from-container sync', () => {
  it('fast-forwards the checked-out branch with merge --ff-only after exporting', async () => {
    const s = syncRepo();
    const r = await syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo });
    expect(s.exports()).toBe(1);
    expect(r).toMatchObject({ action: 'fast-forward', method: 'merge --ff-only', worktree: s.repo, applied: true, from: s.base, to: s.ahead });
    expect(head(s.repo)).toBe(s.ahead);
    expect(readFileSync(join(s.repo, 'feature.txt'), 'utf8')).toBe('from the container\n');
    expect(git(s.repo, 'status', '--porcelain')).toBe('');
    expect(r.exported).toHaveLength(1);
  });

  it('refuses on a dirty tree and keeps the changes and the branch as they were', async () => {
    const s = syncRepo();
    writeFileSync(join(s.repo, 'README.md'), '# local edit\n');
    const e = await reason(syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo }));
    expect(e).toBeInstanceOf(MinionsError);
    expect(e.code).toBe('PRECONDITION');
    expect(e.message).toMatch(/uncommitted or untracked changes.*README\.md.*refusing to move main/);
    expect(head(s.repo)).toBe(s.base);
    expect(readFileSync(join(s.repo, 'README.md'), 'utf8')).toBe('# local edit\n');
  });

  it('refuses on untracked files too', async () => {
    const s = syncRepo();
    writeFileSync(join(s.repo, 'notes.txt'), 'mine\n');
    const e = await reason(syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo }));
    expect(e.message).toContain('notes.txt');
    expect(head(s.repo)).toBe(s.base);
    expect(existsSync(join(s.repo, 'notes.txt'))).toBe(true);
  });

  it('does not count gitignored build output (dist/, node_modules/, *.tgz, .env) as dirty', async () => {
    const s = syncRepo();
    // .env is in the committed .gitignore; the build-output patterns go to info/exclude so history is unchanged.
    writeFileSync(join(s.repo, '.git', 'info', 'exclude'), 'node_modules/\ndist/\n*.tgz\n');
    for (const d of ['node_modules/esbuild', 'dist']) mkdirSync(join(s.repo, d), { recursive: true });
    writeFileSync(join(s.repo, 'node_modules', 'esbuild', 'package.json'), '{}\n');
    writeFileSync(join(s.repo, 'dist', 'cli.js'), '// built\n');
    writeFileSync(join(s.repo, 'minions-0.1.0.tgz'), 'tarball');
    writeFileSync(join(s.repo, '.env'), 'SECRET=1\n');
    const r = await syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo });
    expect(r).toMatchObject({ action: 'fast-forward', method: 'merge --ff-only', applied: true });
    expect(head(s.repo)).toBe(s.ahead);
    for (const f of ['node_modules/esbuild/package.json', 'dist/cli.js', 'minions-0.1.0.tgz', '.env']) expect(existsSync(join(s.repo, f))).toBe(true);
  });

  it('ignores a dirty worktree that does not have the branch checked out', async () => {
    const s = syncRepo();
    const other = join(home.root, 'other-wt');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'side', other, s.base);
    writeFileSync(join(other, 'README.md'), 'unrelated edit\n');
    const r = await syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo });
    expect(r).toMatchObject({ applied: true, worktree: s.repo });
    expect(readFileSync(join(other, 'README.md'), 'utf8')).toBe('unrelated edit\n');
    expect(head(s.repo, 'refs/heads/side')).toBe(s.base);
  });

  it('a staged-only change counts as dirty, also when the branch is not checked out', async () => {
    const s = syncRepo();
    writeFileSync(join(s.repo, 'staged.txt'), 'staged\n');
    git(s.repo, 'add', 'staged.txt');
    expect((await reason(syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo }))).message).toContain('staged.txt');
    expect(head(s.repo)).toBe(s.base);
    git(s.repo, 'checkout', '-q', '-b', 'work');
    const e = await reason(syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo }));
    expect(e.code).toBe('PRECONDITION');
    expect(head(s.repo)).toBe(s.base);
    expect(git(s.repo, 'diff', '--cached', '--name-only')).toBe('staged.txt');
  });

  it('refuses a divergence (no merge, no reset, no force)', async () => {
    const s = syncRepo();
    writeFileSync(join(s.repo, 'host.txt'), 'host work\n');
    git(s.repo, 'add', '.');
    git(s.repo, 'commit', '-q', '-m', 'host work');
    const local = head(s.repo);
    const e = await reason(syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo }));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toMatch(/have diverged/);
    expect(e.hint).toMatch(/Nothing was changed/);
    expect(head(s.repo)).toBe(local);
    expect(existsSync(join(s.repo, 'host.txt'))).toBe(true);
    expect(head(s.repo, 'refs/remotes/minions/main')).toBe(s.ahead);
  });

  it('moves a branch that is not checked out with update-ref and leaves HEAD and the tree alone', async () => {
    const s = syncRepo();
    git(s.repo, 'checkout', '-q', '-b', 'work');
    const r = await syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo });
    expect(r).toMatchObject({ action: 'fast-forward', method: 'update-ref', worktree: null, applied: true });
    expect(head(s.repo)).toBe(s.ahead);
    expect(git(s.repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/work');
    expect(head(s.repo, 'HEAD')).toBe(s.base);
    expect(existsSync(join(s.repo, 'feature.txt'))).toBe(false);
    expect(git(s.repo, 'reflog', 'show', '-1', '--format=%gs', 'refs/heads/main')).toContain('minions upgrade --from-container');
  });

  it('uses the worktree that has the branch checked out, and refuses when that worktree is dirty', async () => {
    const s = syncRepo();
    git(s.repo, 'checkout', '-q', '-b', 'work');
    const wt = join(home.root, 'wt');
    git(s.repo, 'worktree', 'add', '-q', wt, 'main');
    writeFileSync(join(wt, 'README.md'), 'edit in the worktree\n');
    const e = await reason(syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo }));
    expect(e.message).toContain(wt);
    expect(head(s.repo)).toBe(s.base);
    git(wt, 'checkout', '-q', '--', 'README.md');
    const r = await syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo });
    expect(r).toMatchObject({ method: 'merge --ff-only', worktree: wt, applied: true });
    expect(existsSync(join(wt, 'feature.txt'))).toBe(true);
  });

  it('fast-forwards a chosen branch other than the base', async () => {
    const s = syncRepo();
    git(s.repo, 'branch', 'release', s.base);
    const r = await syncFromContainer({ repo: s.repo, branch: 'release', baseBranch: 'main', exportRepo: s.exportRepo });
    expect(r).toMatchObject({ branch: 'release', target: 'refs/remotes/minions/main', method: 'update-ref' });
    expect(head(s.repo, 'refs/heads/release')).toBe(s.ahead);
    expect(head(s.repo)).toBe(s.base);
  });

  it('skips when up to date or ahead, and refuses a missing branch or target', async () => {
    const s = syncRepo();
    git(s.repo, 'merge', '-q', '--ff-only', s.ahead);
    expect((await syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo })).action).toBe('up-to-date');
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'more');
    const ahead = await syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo });
    expect(ahead).toMatchObject({ action: 'ahead', applied: false });
    expect((await reason(syncFromContainer({ repo: s.repo, branch: 'nope', baseBranch: 'main', exportRepo: s.exportRepo }))).message).toMatch(/no branch nope/);
    expect((await reason(syncFromContainer({ repo: s.repo, branch: 'main', baseBranch: 'dev', exportRepo: s.exportRepo }))).message).toMatch(/minions\/dev does not exist/);
    expect((await reason(syncFromContainer({ repo: s.repo, branch: '-x', baseBranch: 'main', exportRepo: s.exportRepo }))).message).toMatch(/not a valid branch/);
  });

  it('dry run: no export and no ref change, the plan is reported', async () => {
    const s = syncRepo();
    const p = await runSourcePhase({ ...phaseBase(), dryRun: true, sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo } });
    expect(s.exports()).toBe(0);
    expect(head(s.repo)).toBe(s.base);
    expect(p.ok).toBe(true);
    expect(p.steps[0]).toMatchObject({ id: 'sync', status: 'planned' });
    expect(p.steps[0]!.detail).toMatch(/merge --ff-only/);
    // A refusal shows up as a failed step in the plan instead of an error.
    writeFileSync(join(s.repo, 'README.md'), 'dirty\n');
    const q = await runSourcePhase({ ...phaseBase(), dryRun: true, sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo } });
    expect(q.ok).toBe(false);
    expect(q.steps[0]).toMatchObject({ id: 'sync', status: 'failed' });
    expect(q.steps[0]!.detail).toMatch(/would refuse/);
  });
});

// ---------------------------------------------------------------- cli

interface NpmWorld { globalRoot: string; checkout: string; calls: string[]; fail?: 'install' | 'build' | 'backup'; lsResolved?: string }

/** Minions checkout with sources and (optionally) build deps. */
function checkout(version = '0.2.0', deps = true): string {
  const dir = join(home.root, 'minions-src');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'minions', version }));
  writeFileSync(join(dir, 'src', 'cli.ts'), 'export {};\n');
  if (deps) for (const d of ['esbuild', 'zod', 'commander']) { mkdirSync(join(dir, 'node_modules', d), { recursive: true }); writeFileSync(join(dir, 'node_modules', d, 'package.json'), '{}'); }
  return dir;
}
const stampDist = (dir: string, version: string, source: string | null, kind: 'packed' | 'source') => {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'build.json'), JSON.stringify({ version, source, kind }));
  writeFileSync(join(dir, 'dist', 'cli.js'), '// cli\n');
};
/** A real-directory global install (packed / git / unknown). */
function realInstall(g: string, version: string, source: string | null, kind: 'packed' | 'source', extra: Record<string, string> = {}) {
  const dir = join(g, 'minions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'minions', version, ...extra }));
  stampDist(dir, version, source, kind);
  return dir;
}

function fakeNpm(w: NpmWorld) {
  return async (cmd: string, args: string[], o?: RunOptions): Promise<RunResult> => {
    const line = `${cmd} ${args.join(' ')}`;
    w.calls.push(line);
    if (cmd !== 'npm') return { code: 1, stdout: '', stderr: `unexpected ${line}` };
    if (args[0] === 'root') return { code: 0, stdout: w.globalRoot + '\n', stderr: '' };
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify({ dependencies: { minions: { version: '0', ...(w.lsResolved ? { resolved: w.lsResolved } : {}) } } }), stderr: '' };
    const version = (JSON.parse(readFileSync(join(w.checkout, 'package.json'), 'utf8')) as { version: string }).version;
    const kind = o?.env?.MINIONS_BUILD_KIND === 'packed' ? 'packed' : 'source';
    if (args[0] === 'ci') { for (const d of ['esbuild', 'zod', 'commander']) { mkdirSync(join(w.checkout, 'node_modules', d), { recursive: true }); writeFileSync(join(w.checkout, 'node_modules', d, 'package.json'), '{}'); } return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'run' && args[1] === 'build') {
      if (w.fail === 'build') return { code: 1, stdout: '', stderr: 'esbuild: syntax error' };
      expect(o?.cwd).toBe(w.checkout);
      stampDist(w.checkout, version, sourceFingerprint(w.checkout), kind);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'pack' && args.includes('--ignore-scripts')) {
      // The backup of the current install (src/host/cli-backup.ts): packed from the global install, scripts off.
      expect(args[1]).toBe(join(w.globalRoot, 'minions'));
      if (w.fail === 'backup') return { code: 1, stdout: '', stderr: 'ENOSPC' };
      const v = (JSON.parse(readFileSync(join(args[1]!, 'package.json'), 'utf8')) as { version: string }).version;
      writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, `minions-${v}.tgz`), `installed ${v}`);
      return { code: 0, stdout: `minions-${v}.tgz\n`, stderr: '' };
    }
    if (args[0] === 'pack') {
      expect(o?.cwd).toBe(w.checkout);
      expect(kind).toBe('packed');
      writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, `minions-${version}.tgz`), 'tgz');
      return { code: 0, stdout: `minions-${version}.tgz\n`, stderr: '' };
    }
    if (args[0] === 'install' && args.includes('-g')) {
      const tgz = args.at(-1)!;
      expect(existsSync(tgz)).toBe(true);
      expect(tgz.startsWith(w.globalRoot)).toBe(false);
      if (w.fail === 'install') return { code: 1, stdout: '', stderr: 'EACCES' };
      realInstall(w.globalRoot, version, sourceFingerprint(w.checkout), 'packed');
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${line}` };
  };
}
const mutatingNpm = (calls: string[]) => calls.filter((c) => !/^npm (root|ls) /.test(c));

function phaseBase(over: Partial<SourcePhaseOptions> = {}): SourcePhaseOptions {
  return { sync: null, checkout: null, continueArgs: ['--json', 'upgrade'], rerun: 'minions upgrade', ...over };
}
const childResult = (): UpgradeResult => ({
  projectId: ID, dryRun: false, ok: true, interrupted: [], coordinator: null,
  image: { tag: 't', rebuild: false, fingerprint: null, previous: null },
  steps: [{ id: 'cli', status: 'skipped', detail: 'matches' }, { id: 'preflight', status: 'done', detail: 'container running' }],
});

describe('installed CLI check', () => {
  let g: string;
  beforeEach(() => { g = tempDir('minions-global-'); });

  it('does nothing when the installed CLI matches the checkout', async () => {
    const c = checkout();
    realInstall(g, '0.2.0', sourceFingerprint(c), 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const r = await checkCli({ checkout: c, runner: fakeNpm(w) });
    expect(r).toMatchObject({ differs: false, action: 'none', command: null });
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('rebuilds a linked install of the checkout, then continues the upgrade on the new CLI', async () => {
    const c = checkout();
    stampDist(c, '0.2.0', 'old0000000000000', 'source');
    symlinkSync(c, join(g, 'minions'));
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [], lsResolved: `file:${c}` };
    const spawned: [string, string[]][] = [];
    const p = await runSourcePhase<UpgradeResult>(phaseBase({
      checkout: c, runner: fakeNpm(w), continueArgs: ['--json', 'upgrade', '--now'], rebuildCli: true,
      spawnCli: async (cli, args) => { spawned.push([cli, args]); return { code: 0, stdout: JSON.stringify({ ok: true, data: childResult() }) + '\n', stderr: '' }; },
    }));
    expect(p.cli).toMatchObject({ action: 'rebuild', differs: true });
    expect(p.cli!.installed.kind).toBe('link');
    expect(mutatingNpm(w.calls)).toEqual(['npm run build']);
    expect(spawned).toEqual([[join(c, 'dist', 'cli.js'), ['--json', 'upgrade', '--now']]]);
    expect(p.stop).toBeNull();
    expect(p.continued?.steps.map((s) => s.id)).toEqual(['cli', 'preflight']);
  });

  it('reinstalls a packed install from a tarball packed outside the global prefix', async () => {
    const c = checkout('0.2.0', false);
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase<UpgradeResult>(phaseBase({
      checkout: c, runner: fakeNpm(w), rebuildCli: true,
      spawnCli: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: childResult() }), stderr: '' }),
    }));
    expect(p.cli).toMatchObject({ action: 'reinstall', reason: 'installed 0.1.0 != checkout 0.2.0' });
    expect(mutatingNpm(w.calls).map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['npm ci', 'npm pack', 'npm pack', 'npm install']);
    expect(p.cli!.installed.version).toBe('0.2.0');
    // The install it replaced was kept first (task-53.7).
    const backups = await listCliBackups();
    expect(backups.map((b) => b.version)).toEqual(['0.1.0']);
    expect(readFileSync(backups[0]!.file, 'utf8')).toBe('installed 0.1.0');
    expect(statSync(backups[0]!.file).mode & 0o777).toBe(0o600);
    expect(backups[0]!.file.startsWith(join(home.home, 'manager', 'cli-backup'))).toBe(true);
    expect(p.steps).toEqual([expect.objectContaining({ id: 'cli', status: 'done' })]);
    expect(p.continued).not.toBeNull();
  });

  it('prints the exact uninstall + install command for a git-URL install and stops (no npm changes)', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', null, 'source', { _resolved: 'git+ssh://git@github.com/antoniibelyshev/minions.git#abc' });
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    let spawned = 0;
    const p = await runSourcePhase(phaseBase({ checkout: c, runner: fakeNpm(w), rerun: 'minions upgrade --timeout 60', spawnCli: async () => { spawned++; return { code: 0, stdout: '', stderr: '' }; } }));
    expect(p.cli!.installed.kind).toBe('git');
    expect(p.stop).toEqual({
      reason: 'installed 0.1.0 != checkout 0.2.0',
      command: `cd ${c} && npm ci && MINIONS_BUILD_KIND=packed npm pack && npm uninstall -g minions && npm install -g ./minions-0.2.0.tgz`,
      rerun: 'minions upgrade --timeout 60',
    });
    expect(p.steps[0]).toMatchObject({ id: 'cli', status: 'failed' });
    expect(mutatingNpm(w.calls)).toEqual([]);
    expect(spawned).toBe(0);
  });

  it('treats an unstamped real-directory install as unsafe (git and tarball installs look alike to npm)', async () => {
    const c = checkout();
    realInstall(g, '0.2.0', 'old0000000000000', 'source');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const r = await checkCli({ checkout: c, runner: fakeNpm(w) });
    expect(r).toMatchObject({ differs: true, action: 'manual' });
    expect(r.installed.kind).toBe('unknown');
    expect(r.reason).toMatch(/installed source old0000000000000 != checkout/);
  });

  it('a git install as npm 10 leaves it (no resolved in npm ls, stamp kind source) is unknown and still stops with the command', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'source');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase(phaseBase({ checkout: c, runner: fakeNpm(w), spawnCli: async () => { throw new Error('must not spawn'); } }));
    expect(p.cli!.installed.kind).toBe('unknown');
    expect(p.stop?.command).toBe(`cd ${c} && npm ci && MINIONS_BUILD_KIND=packed npm pack && npm uninstall -g minions && npm install -g ./minions-0.2.0.tgz`);
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('an old install.sh install without dist/build.json is unknown: stops with the command, never reinstalls', async () => {
    const c = checkout();
    const dir = join(g, 'minions');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'minions', version: '0.2.0' }));
    writeFileSync(join(dir, 'dist', 'cli.js'), '// old cli\n');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase(phaseBase({ checkout: c, runner: fakeNpm(w), spawnCli: async () => { throw new Error('must not spawn'); } }));
    expect(p.cli).toMatchObject({ differs: true, action: 'manual', reason: 'the installed CLI has no build stamp (dist/build.json)' });
    expect(p.cli!.installed).toMatchObject({ kind: 'unknown', stamp: null });
    expect(p.stop).toMatchObject({ command: expect.stringContaining('npm uninstall -g minions && npm install -g ./minions-0.2.0.tgz') });
    expect(mutatingNpm(w.calls)).toEqual([]);
    // The dry run plans the stop and runs nothing either.
    const w2: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const d = await runSourcePhase(phaseBase({ dryRun: true, checkout: c, runner: fakeNpm(w2) }));
    expect(d.steps[0]).toMatchObject({ id: 'cli', status: 'planned' });
    expect(d.steps[0]!.detail).toContain('stop and print');
    expect(mutatingNpm(w2.calls)).toEqual([]);
  });

  it('a link to a different checkout is not rebuilt (manual command for this checkout)', async () => {
    const c = checkout();
    const elsewhere = join(home.root, 'other-minions');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ name: 'minions', version: '0.2.0' }));
    stampDist(elsewhere, '0.2.0', 'old0000000000000', 'source');
    symlinkSync(elsewhere, join(g, 'minions'));
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const r = await checkCli({ checkout: c, runner: fakeNpm(w) });
    expect(r).toMatchObject({ differs: true, action: 'manual' });
    expect(r.installed.kind).toBe('link');
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('never reinstalls twice: the continued CLI stops with the command when it still differs', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const r = await checkCli({ checkout: c, runner: fakeNpm({ globalRoot: g, checkout: c, calls: [] }), handoff: true });
    expect(r.action).toBe('manual');
    expect(r.reason).toMatch(/still different after the reinstall/);
  });

  it('without --rebuild-cli never runs npm on the host: stops with the command and a rerun that opts in', async () => {
    for (const kind of ['packed', 'link'] as const) {
      const gg = tempDir('minions-global-');
      const c = checkout();
      if (kind === 'packed') realInstall(gg, '0.1.0', 'old0000000000000', 'packed');
      else { stampDist(c, '0.2.0', 'old0000000000000', 'source'); symlinkSync(c, join(gg, 'minions')); }
      const w: NpmWorld = { globalRoot: gg, checkout: c, calls: [], ...(kind === 'link' ? { lsResolved: `file:${c}` } : {}) };
      const p = await runSourcePhase(phaseBase({ checkout: c, runner: fakeNpm(w), spawnCli: async () => { throw new Error('must not spawn'); } }));
      expect(mutatingNpm(w.calls)).toEqual([]);
      expect(p.ok).toBe(false);
      expect(p.stop?.reason).toMatch(/runs the checkout's npm scripts and build on this host/);
      expect(p.stop?.rerun).toMatch(/--rebuild-cli$/);
    }
  });

  it('never builds commits just fast-forwarded from the container in the same run, even with --rebuild-cli', async () => {
    const s = syncRepo();
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase(phaseBase({
      checkout: c, runner: fakeNpm(w), rebuildCli: true, spawnCli: async () => { throw new Error('must not spawn'); },
      sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo, runner: run },
    }));
    expect(p.sync).toMatchObject({ action: 'fast-forward', applied: true });
    expect(mutatingNpm(w.calls)).toEqual([]);
    expect(p.stop?.reason).toMatch(/just fast-forwarded to commits from the container .*review them/);
  });

  it('keeps only the last 2 backups of the replaced CLI', async () => {
    const c = checkout('0.2.0', false);
    for (const [i, v] of ['0.1.0', '0.1.1', '0.1.2'].entries()) {
      realInstall(g, v, 'old0000000000000', 'packed');
      const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
      const check = await checkCli({ checkout: c, runner: fakeNpm(w) });
      await applyCli(check, { runner: fakeNpm(w), backup: (dir, ver, o) => backupInstalledCli(dir, ver, { ...o, now: new Date(Date.UTC(2026, 9, 26, 10, i)) }) });
    }
    expect((await listCliBackups()).map((b) => b.version)).toEqual(['0.1.1', '0.1.2']);
  });

  it('a backup that cannot be made stops the reinstall: npm install -g never runs', async () => {
    const c = checkout('0.2.0', false);
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [], fail: 'backup' };
    const p = await runSourcePhase(phaseBase({ checkout: c, runner: fakeNpm(w), rebuildCli: true, spawnCli: async () => { throw new Error('must not spawn'); } }));
    expect(p.stop?.reason).toMatch(/backing up the current CLI failed, so nothing was installed: npm pack of the current CLI failed: ENOSPC/);
    expect(w.calls.some((l) => l.startsWith('npm install'))).toBe(false);
    expect(await listCliBackups()).toEqual([]);
  });

  it('stops with the command when the reinstall fails, before any container step', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [], fail: 'install' };
    const p = await runSourcePhase(phaseBase({ checkout: c, runner: fakeNpm(w), rebuildCli: true, spawnCli: async () => { throw new Error('must not spawn'); } }));
    expect(p.stop?.reason).toMatch(/reinstall failed: npm install failed: EACCES/);
    expect(p.steps[0]).toMatchObject({ id: 'cli', status: 'failed' });
  });

  it('dry run: reports the planned reinstall without running npm', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase(phaseBase({ dryRun: true, checkout: c, runner: fakeNpm(w), rebuildCli: true }));
    expect(p.steps[0]).toMatchObject({ id: 'cli', status: 'planned' });
    expect(p.steps[0]!.detail).toMatch(/reinstall from the checkout .*then continue on the new CLI/);
    expect(p.ok).toBe(true);
    expect(p.stop).toBeNull();
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('dry run: without --rebuild-cli, or with a planned fast-forward, plans the stop and is not ok', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase(phaseBase({ dryRun: true, checkout: c, runner: fakeNpm(w) }));
    expect(p.ok).toBe(false);
    expect(p.stop).toBeNull();
    expect(p.steps[0]).toMatchObject({ id: 'cli', status: 'planned', detail: expect.stringMatching(/^would stop: .*rerun with --rebuild-cli/) });
    const s = syncRepo();
    const q = await runSourcePhase(phaseBase({
      dryRun: true, checkout: c, runner: fakeNpm(w), rebuildCli: true,
      sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo, runner: run },
    }));
    expect(q.sync).toMatchObject({ action: 'fast-forward', applied: false });
    expect(q.ok).toBe(false);
    expect(q.steps.at(-1)).toMatchObject({ id: 'cli', status: 'planned', detail: expect.stringMatching(/^would stop: .*would be fast-forwarded to commits from the container/) });
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('after a fast-forward, logs the stop and then the fetched range to review, and builds nothing (even with --rebuild-cli)', async () => {
    // The project repo is a minions checkout with a linked global install; the container is one commit ahead.
    const repo = makeRepo(home.root, 'minions-co');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'minions', version: '0.2.0' }));
    writeFileSync(join(repo, 'src', 'cli.ts'), 'export {};\n');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules/\ndist/\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'checkout');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'tmp');
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'agent work: add feature');
    const ahead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/minions/main', ahead);
    git(repo, 'branch', '-q', '-D', 'tmp');
    for (const d of ['esbuild', 'zod', 'commander']) { mkdirSync(join(repo, 'node_modules', d), { recursive: true }); writeFileSync(join(repo, 'node_modules', d, 'package.json'), '{}'); }
    stampDist(repo, '0.2.0', 'old0000000000000', 'source');
    symlinkSync(repo, join(g, 'minions'));
    const w: NpmWorld = { globalRoot: g, checkout: repo, calls: [], lsResolved: `file:${repo}` };
    const logs: string[] = [];
    const exportRepo = async (): Promise<ExportResult> => ({ bundle: 'b', refs: ['refs/heads/main'], changes: [{ ref: 'refs/remotes/minions/main', from: base, to: ahead }] });
    const p = await runSourcePhase<UpgradeResult>(phaseBase({
      checkout: repo, runner: fakeNpm(w), log: (m) => logs.push(m), rebuildCli: true,
      sync: { repo, branch: 'main', baseBranch: 'main', exportRepo, runner: run },
      spawnCli: async () => { throw new Error('must not spawn'); },
    }));
    expect(p.cli?.action).toBe('rebuild');
    expect(p.ok).toBe(false);
    expect(p.stop?.rerun).toMatch(/--rebuild-cli$/);
    expect(mutatingNpm(w.calls)).toEqual([]);
    expect(logs[0]).toMatch(/^sync: fast-forwarded main/);
    expect(logs[1]).toMatch(/^cli: .*just fast-forwarded to commits from the container .*review them/);
    expect(logs[2]).toMatch(new RegExp(`^cli: not built in this run; review the commits fetched from the container \\(${base.slice(0, 12)}\\.\\.${ahead.slice(0, 12)}\\)`));
    expect(logs[3]).toMatch(/^ {2}[0-9a-f]+ agent work: add feature$/);
    expect(logs).toHaveLength(4);
    expect(logs.some((l) => /rebuilt|rebuilding/.test(l))).toBe(false);
  });

  it('with --rebuild-cli logs in order: what is built, the npm commands, then the result', async () => {
    const c = checkout();
    stampDist(c, '0.2.0', 'old0000000000000', 'source');
    symlinkSync(c, join(g, 'minions'));
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [], lsResolved: `file:${c}` };
    const logs: string[] = [];
    const p = await runSourcePhase<UpgradeResult>(phaseBase({
      checkout: c, runner: fakeNpm(w), log: (m) => logs.push(m), rebuildCli: true,
      spawnCli: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: childResult() }), stderr: '' }),
    }));
    expect(p.cli?.action).toBe('rebuild');
    expect(logs[0]).toMatch(/^cli: .*; rebuilding the linked checkout/);
    expect(logs[1]).toMatch(/^cli: npm /);
    expect(logs.at(-2)).toMatch(/^cli: .*; rebuilt \(/);
    expect(logs.at(-1)).toMatch(/^cli: continuing the upgrade on the new CLI/);
    expect(logs.filter((l) => l.startsWith('cli: ') && /rebuilt/.test(l))).toHaveLength(1);
  });

  it('dry run: a stop at the cli step makes the plan not ok', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', null, 'source', { _resolved: 'git+ssh://git@github.com/antoniibelyshev/minions.git#abc' });
    const p = await runSourcePhase(phaseBase({ dryRun: true, checkout: c, runner: fakeNpm({ globalRoot: g, checkout: c, calls: [] }) }));
    expect(p.ok).toBe(false);
    expect(p.stop).toBeNull();
    expect(p.steps[0]).toMatchObject({ id: 'cli', status: 'planned', detail: expect.stringContaining('stop and print') });
  });

  it('without --rebuild-cli the stop is one failed cli step, logged once, with no range and no rebuild line', async () => {
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const logs: string[] = [];
    const p = await runSourcePhase(phaseBase({ checkout: c, runner: fakeNpm(w), log: (m) => logs.push(m), spawnCli: async () => { throw new Error('must not spawn'); } }));
    expect(p.steps.filter((s) => s.id === 'cli')).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({ id: 'cli', status: 'failed', detail: expect.stringMatching(/rerun with --rebuild-cli/) });
    expect(p.stop?.rerun).toBe('minions upgrade --rebuild-cli');
    expect(logs).toEqual([`cli: ${p.steps[0]!.detail}`]);
    expect(logs[0]).toMatch(/rerun with --rebuild-cli/);
    expect(logs.some((l) => /not built in this run|rebuilding the linked|reinstalling from|rebuilt|reinstalled/.test(l))).toBe(false);
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('a fast-forward without --rebuild-cli also stops on the fast-forward reason and logs the range', async () => {
    const s = syncRepo();
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const logs: string[] = [];
    const p = await runSourcePhase(phaseBase({
      checkout: c, runner: fakeNpm(w), log: (m) => logs.push(m), spawnCli: async () => { throw new Error('must not spawn'); },
      sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo, runner: run },
    }));
    expect(p.ok).toBe(false);
    expect(p.stop?.reason).toMatch(/just fast-forwarded to commits from the container/);
    expect(p.stop?.rerun).toBe('minions upgrade --rebuild-cli');
    expect(logs.some((l) => l.startsWith(`cli: not built in this run; review the commits fetched from the container (${s.base.slice(0, 12)}..${s.ahead.slice(0, 12)})`))).toBe(true);
    expect(logs.some((l) => /^ {2}[0-9a-f]+ agent work$/.test(l))).toBe(true);
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('dry run with --rebuild-cli and nothing to fast-forward plans the rebuild and stays ok', async () => {
    const s = syncRepo();
    git(s.repo, 'merge', '-q', '--ff-only', s.ahead);
    const c = checkout();
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase(phaseBase({
      dryRun: true, checkout: c, runner: fakeNpm(w), rebuildCli: true,
      sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo, runner: run },
    }));
    expect(p.sync?.action).toBe('up-to-date');
    expect(p.ok).toBe(true);
    expect(p.steps.at(-1)).toMatchObject({ id: 'cli', status: 'planned' });
    expect(p.steps.at(-1)!.detail).not.toMatch(/would stop/);
    expect(mutatingNpm(w.calls)).toEqual([]);
  });

  it('a matching CLI is not gated: a planned fast-forward without --rebuild-cli stays ok', async () => {
    const s = syncRepo();
    const c = checkout();
    realInstall(g, '0.2.0', sourceFingerprint(c), 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: c, calls: [] };
    const p = await runSourcePhase(phaseBase({
      dryRun: true, checkout: c, runner: fakeNpm(w),
      sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo, runner: run },
    }));
    expect(p.sync).toMatchObject({ action: 'fast-forward', applied: false });
    expect(p.ok).toBe(true);
    expect(p.stop).toBeNull();
    expect(p.steps.at(-1)).toMatchObject({ id: 'cli' });
    expect(p.steps.at(-1)!.detail).not.toMatch(/would stop/);
  });

  it('skips the check outside a minions checkout', async () => {
    expect(isMinionsCheckout(makeRepo(home.root, 'demo'))).toBe(false);
    expect(isMinionsCheckout(checkout())).toBe(true);
    const p = await runSourcePhase(phaseBase());
    expect(p.steps).toEqual([expect.objectContaining({ id: 'cli', status: 'skipped' })]);
  });
});

// ---------------------------------------------------------------- GitHub delivery: origin/<base>

describe('GitHub delivery: the CLI comes from the reviewed origin/<base> commit', () => {
  let g: string;
  beforeEach(() => { g = tempDir('minions-global-'); });

  /** Minions checkout as a git repo on main, pushed to a bare origin; `merge` lands a PR on origin/main. */
  function originCheckout() {
    const c = checkout();
    writeFileSync(join(c, '.gitignore'), 'node_modules/\ndist/\n*.tgz\n');
    git(c, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git(c, 'config', k!, v!);
    git(c, 'add', '.');
    git(c, 'commit', '-q', '-m', 'init');
    const bare = join(tempDir('minions-origin-'), 'origin.git');
    git(home.root, 'init', '-q', '--bare', bare);
    git(c, 'remote', 'add', 'origin', bare);
    git(c, 'push', '-q', 'origin', 'main');
    const gh = join(tempDir('minions-gh-'), 'gh');
    git(home.root, 'clone', '-q', '-b', 'main', bare, gh);
    for (const [k, v] of [['user.name', 'GitHub'], ['user.email', 'gh@example.com'], ['commit.gpgsign', 'false']]) git(gh, 'config', k!, v!);
    const merge = (file: string) => {
      mkdirSync(join(gh, 'src'), { recursive: true });
      writeFileSync(join(gh, 'src', file), `export const x = '${file}';\n`);
      git(gh, 'add', '.');
      git(gh, 'commit', '-q', '-m', `Merge pull request: ${file}`);
      git(gh, 'push', '-q', 'origin', 'main');
      return git(gh, 'rev-parse', 'HEAD');
    };
    return { c, bare, merge, base: git(c, 'rev-parse', 'HEAD') };
  }
  const origin = (o: ReturnType<typeof originCheckout>) => ({ repo: o.c, baseBranch: 'main', remote: o.bare, runner: run });

  it('fetches origin, fast-forwards the checked-out base, and builds that reviewed commit in the same run (--rebuild-cli)', async () => {
    const o = originCheckout();
    const merged = o.merge('feature.ts');
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: o.c, calls: [] };
    const p = await runSourcePhase<UpgradeResult>(phaseBase({
      checkout: o.c, origin: origin(o), runner: fakeNpm(w), rebuildCli: true,
      spawnCli: async () => ({ code: 0, stdout: JSON.stringify({ ok: true, data: childResult() }) + '\n', stderr: '' }),
    }));
    expect(p.sync).toMatchObject({ source: 'origin', action: 'fast-forward', method: 'merge --ff-only', applied: true, from: o.base, to: merged, target: 'refs/remotes/origin/main' });
    expect(head(o.c)).toBe(merged);
    expect(readFileSync(join(o.c, 'src', 'feature.ts'), 'utf8')).toContain('feature.ts');
    expect(mutatingNpm(w.calls).map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['npm pack', 'npm pack', 'npm install']);
    expect(p.stop).toBeNull();
    expect(p.steps.map((s) => s.id)).toEqual(['sync', 'cli']);
  });

  it('stops before building when the checkout is not exactly origin/<base> (local commits, other branch, dirty tree)', async () => {
    const cases: [string, (o: ReturnType<typeof originCheckout>) => void, RegExp][] = [
      ['local commit', (o) => { writeFileSync(join(o.c, 'src', 'local.ts'), 'export {};\n'); git(o.c, 'add', '.'); git(o.c, 'commit', '-q', '-m', 'local merge'); }, /is at [0-9a-f]{12}, not the reviewed origin\/main commit/],
      ['other branch', (o) => { git(o.c, 'checkout', '-q', '-b', 'feature'); writeFileSync(join(o.c, 'src', 'f.ts'), 'export {};\n'); git(o.c, 'add', '.'); git(o.c, 'commit', '-q', '-m', 'wip'); }, /not the reviewed origin\/main commit/],
      ['untracked file', (o) => { writeFileSync(join(o.c, 'src', 'scratch.ts'), 'export {};\n'); }, /uncommitted or untracked changes.*not the reviewed origin\/main commit/],
    ];
    for (const [name, mutate, re] of cases) {
      home.cleanup(); home = withHome();
      const gg = tempDir('minions-global-');
      const o = originCheckout();
      mutate(o);
      realInstall(gg, '0.1.0', 'old0000000000000', 'packed');
      const w: NpmWorld = { globalRoot: gg, checkout: o.c, calls: [] };
      const p = await runSourcePhase(phaseBase({ checkout: o.c, origin: origin(o), runner: fakeNpm(w), rebuildCli: true, spawnCli: async () => { throw new Error('must not spawn'); } }));
      expect(mutatingNpm(w.calls), name).toEqual([]);
      expect(p.ok, name).toBe(false);
      expect(p.stop?.reason, name).toMatch(re);
      expect(p.stop?.reason, name).toMatch(/with GitHub delivery the CLI is built only from origin\/main/);
      expect(p.stop?.command, name).toMatch(/git merge --ff-only origin\/main/);
    }
  });

  it('base not checked out (checkout on another branch): the base moves by update-ref, but the CLI is not built from the other branch', async () => {
    const o = originCheckout();
    git(o.c, 'checkout', '-q', '-b', 'feature');
    const merged = o.merge('feature.ts');
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: o.c, calls: [] };
    const p = await runSourcePhase(phaseBase({ checkout: o.c, origin: origin(o), runner: fakeNpm(w), rebuildCli: true, spawnCli: async () => { throw new Error('must not spawn'); } }));
    expect(p.sync).toMatchObject({ source: 'origin', action: 'fast-forward', method: 'update-ref', applied: true, from: o.base, to: merged, worktree: null });
    expect(git(o.c, 'rev-parse', 'refs/heads/main')).toBe(merged);
    expect(head(o.c, 'HEAD')).toBe(o.base);
    expect(git(o.c, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    expect(mutatingNpm(w.calls)).toEqual([]);
    expect(p.ok).toBe(false);
    expect(p.stop?.reason).toMatch(/not the reviewed origin\/main commit/);
    expect(p.stop?.command).toMatch(/git switch main/);
  });

  it('a diverged base refuses the whole upgrade; nothing is merged', async () => {
    const o = originCheckout();
    writeFileSync(join(o.c, 'src', 'local.ts'), 'export {};\n');
    git(o.c, 'add', '.');
    git(o.c, 'commit', '-q', '-m', 'local');
    const local = head(o.c);
    o.merge('remote.ts');
    const e = await reason(runSourcePhase(phaseBase({ checkout: o.c, origin: origin(o) })));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toMatch(/upgrade \(origin\/main\): main .* and refs\/remotes\/origin\/main .* have diverged/);
    expect(head(o.c)).toBe(local);
    expect(git(o.c, 'rev-list', '--merges', '--count', 'main')).toBe('0');
  });

  it('a failed fetch refuses with NETWORK_RETRYABLE and changes nothing', async () => {
    const o = originCheckout();
    const e = await reason(syncFromOrigin({ repo: o.c, baseBranch: 'main', remote: join(home.root, 'missing.git') }));
    expect(e.code).toBe('NETWORK_RETRYABLE');
    expect(e.message).toMatch(/fetching main from origin failed/);
    expect(head(o.c)).toBe(o.base);
  });

  it('dry run: no fetch and no ref change; the plan builds after the planned fast-forward', async () => {
    const o = originCheckout();
    git(o.c, 'fetch', '-q', 'origin');
    const merged = o.merge('later.ts'); // not fetched yet: the dry run must not see it
    const p = await runSourcePhase(phaseBase({ dryRun: true, checkout: o.c, origin: origin(o) }));
    expect(p.sync).toMatchObject({ source: 'origin', action: 'up-to-date' });
    expect(git(o.c, 'rev-parse', 'refs/remotes/origin/main')).not.toBe(merged);
    expect(head(o.c)).toBe(o.base);
  });

  it('dry run with a planned origin fast-forward and --rebuild-cli plans the build (only container commits wait a run)', async () => {
    const o = originCheckout();
    o.merge('reviewed.ts');
    git(o.c, 'fetch', '-q', 'origin');
    realInstall(g, '0.1.0', 'old0000000000000', 'packed');
    const w: NpmWorld = { globalRoot: g, checkout: o.c, calls: [] };
    const logs: string[] = [];
    const p = await runSourcePhase(phaseBase({ dryRun: true, checkout: o.c, origin: origin(o), runner: fakeNpm(w), rebuildCli: true, log: (m) => logs.push(m) }));
    expect(p.sync).toMatchObject({ source: 'origin', action: 'fast-forward', applied: false });
    expect(p.ok).toBe(true);
    expect(p.stop).toBeNull();
    const cli = p.steps.find((s) => s.id === 'cli');
    expect(cli?.status).toBe('planned');
    expect(cli?.detail).not.toMatch(/would stop|from the container/);
    expect(logs.join('\n')).not.toMatch(/fetched from the container/);
    expect(mutatingNpm(w.calls)).toEqual([]);
    expect(head(o.c)).toBe(o.base);
  });

  it('upgradeSourceMode: --from-container is local-delivery only; GitHub delivery always takes origin', () => {
    expect(upgradeSourceMode({ githubDelivery: false, fromContainer: true, checkout: null, baseBranch: 'main' })).toBe('container');
    expect(upgradeSourceMode({ githubDelivery: false, fromContainer: false, checkout: '/c', baseBranch: 'main' })).toBe('checkout');
    expect(upgradeSourceMode({ githubDelivery: false, fromContainer: false, checkout: null, baseBranch: 'main' })).toBe('none');
    expect(upgradeSourceMode({ githubDelivery: true, fromContainer: false, checkout: '/c', baseBranch: 'main' })).toBe('origin');
    expect(upgradeSourceMode({ githubDelivery: true, fromContainer: false, checkout: null, baseBranch: 'main' })).toBe('none');
    let err: MinionsError | null = null;
    try { upgradeSourceMode({ githubDelivery: true, fromContainer: true, checkout: '/c', baseBranch: 'trunk' }); } catch (e) { err = e as MinionsError; }
    expect(err?.code).toBe('PRECONDITION');
    expect(err?.message).toMatch(/--from-container is available with local delivery only.*origin\/trunk is the single source of truth/);
  });

  it('never combines the container sync with the origin source', async () => {
    const o = originCheckout();
    const s = syncRepo();
    const e = await reason(runSourcePhase(phaseBase({ checkout: o.c, origin: origin(o), sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo } })));
    expect(e.code).toBe('PRECONDITION');
    expect(s.exports()).toBe(0);
  });
});

describe('runUpgrade with the source phase', () => {
  const docker: string[][] = [];
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => { docker.push([cmd, ...args]); return { code: 1, stdout: '', stderr: 'no docker in this test' }; };
  const base = { projectId: ID, imageTag: 'minions-runtime:test', compose: new Compose(ID, runner), runner, timeoutSec: 0,
    refresh: async () => [], importRepo: async () => { throw new Error('unused'); } };
  beforeEach(() => { docker.length = 0; });

  it('stops before any container step and prints the command (human and --json shapes)', async () => {
    const stop = { reason: 'installed 0.1.0 != checkout 0.2.0', command: 'cd /src && npm ci && npm uninstall -g minions && npm install -g ./minions-0.2.0.tgz', rerun: 'minions upgrade' };
    const r = await runUpgrade({ ...base, source: async () => ({ ok: true, steps: [{ id: 'cli', status: 'failed', detail: 'x' }], sync: null, cli: null, stop, continued: null }) });
    expect(docker).toEqual([]);
    expect(r).toMatchObject({ ok: false, stopped: stop });
    expect(r.steps.map((s) => s.id)).toEqual(['cli']);
    const text = formatUpgrade(r);
    expect(text).toContain('stopped');
    expect(text).toContain(stop.command);
    expect(text).toContain('nothing in the container changed');
    expect(JSON.parse(JSON.stringify(r))).toMatchObject({ stopped: { command: stop.command } });
  });

  it('returns the continued result with the source steps first and runs no container step itself', async () => {
    const r = await runUpgrade({ ...base, source: async () => ({ ok: true, steps: [{ id: 'sync', status: 'done', detail: 'ff' }, { id: 'cli', status: 'done', detail: 'reinstalled' }], sync: null, cli: null, stop: null, continued: childResult() }) });
    expect(docker).toEqual([]);
    expect(r.continued).toBe(true);
    // The continued CLI's own "matches" cli step is not repeated.
    expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['sync:done', 'cli:done', 'preflight:done']);
    expect(formatUpgrade(r)).toContain('newly installed CLI');
  });

  it('propagates a sync refusal before any container step', async () => {
    const s = syncRepo();
    writeFileSync(join(s.repo, 'README.md'), 'dirty\n');
    await expect(runUpgrade({ ...base, source: () => runSourcePhase(phaseBase({ sync: { repo: s.repo, branch: 'main', baseBranch: 'main', exportRepo: s.exportRepo } })) }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(docker).toEqual([]);
  });
});

describe('source fingerprint', () => {
  it('changes with the sources, ignores docs and skips symlinks', () => {
    const c = checkout();
    const a = sourceFingerprint(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    mkdirSync(join(c, 'docs'));
    writeFileSync(join(c, 'docs', 'x.md'), 'doc');
    symlinkSync('/etc/hostname', join(c, 'src', 'link.ts'));
    expect(sourceFingerprint(c)).toBe(a);
    writeFileSync(join(c, 'src', 'cli.ts'), 'export const x = 1;\n');
    expect(sourceFingerprint(c)).not.toBe(a);
    expect(sourceFingerprint(join(c, 'nope'))).toBeNull();
  });
});
