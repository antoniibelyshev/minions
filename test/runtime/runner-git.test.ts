// task-14.4: the hardened runner git helper (docs/design/agent-runtimes.md D3a, git-hardening.ts runnerGit*).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runnerGit, runnerGitArgv, runnerGitEnv } from '../../src/runtime/git-hardening.js';
import { cloneConfigTemplate } from '../../src/runtime/runner/repo.js';
import { gitSync, initRepo, tmp } from './fixtures.js';

const pairs = (argv: string[]) => argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]!] : []));

describe('runnerGitArgv', () => {
  it('every call carries an explicit --git-dir / --work-tree and the hardened -c set', () => {
    const argv = runnerGitArgv({ gitDir: '/r/.git', workTree: '/r' }, ['status', '--porcelain']);
    expect(argv.slice(0, 2)).toEqual(['--git-dir=/r/.git', '--work-tree=/r']);
    const c = pairs(argv);
    for (const v of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.untrackedCache=false', 'commit.gpgSign=false', 'transfer.fsckObjects=true',
      'core.logAllRefUpdates=false', 'core.commitGraph=false', 'core.useReplaceRefs=false', 'protocol.file.allow=never', 'gc.auto=0']) expect(c).toContain(v);
    expect(argv.slice(-2)).toEqual(['status', '--porcelain']);
  });

  it('commit and merge get --no-verify --no-gpg-sign; fetch and clone get the file transport and an explicit upload-pack', () => {
    expect(runnerGitArgv({ gitDir: '/r/.git' }, ['commit', '-m', 'x']).slice(-5)).toEqual(['commit', '--no-verify', '--no-gpg-sign', '-m', 'x']);
    expect(runnerGitArgv({ gitDir: '/r/.git' }, ['merge', '--ff-only', 'y']).slice(-5)).toEqual(['merge', '--no-verify', '--no-gpg-sign', '--ff-only', 'y']);
    const f = runnerGitArgv({ gitDir: '/r/.git' }, ['fetch', '/c', 'a:b']);
    expect(f.slice(-4)).toEqual(['fetch', '--upload-pack=git-upload-pack', '/c', 'a:b']);
    expect(pairs(f)).toContain('protocol.file.allow=always');
    expect(pairs(f)).not.toContain('protocol.file.allow=never');
    const cl = runnerGitArgv(null, ['clone', '/a', '/b']);
    expect(cl[0]).not.toMatch(/^--git-dir/);
    expect(pairs(cl)).toContain('protocol.file.allow=always');
  });

  it('refuses a call without an explicit git dir (git must never discover a repository) and relative paths', () => {
    expect(() => runnerGitArgv(null, ['status'])).toThrow(/explicit --git-dir/);
    expect(() => runnerGitArgv({ gitDir: 'rel/.git' }, ['status'])).toThrow(/absolute/);
    expect(() => runnerGitArgv({ gitDir: '/r/.git' }, ['clone', '/a', '/b'])).toThrow(/clone takes no --git-dir/);
  });

  it('the environment drops every inherited GIT_* variable and pins the global config to the runner file', () => {
    const env = runnerGitEnv({ PATH: '/bin', GIT_DIR: '/evil', GIT_COMMON_DIR: '/evil', GIT_OBJECT_DIRECTORY: '/evil', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/evil', GIT_CONFIG_GLOBAL: '/evil', GIT_WORK_TREE: '/evil' }, '/run/gitconfig');
    expect(Object.entries(env).filter(([k, v]) => k.startsWith('GIT_') && v === '/evil')).toEqual([]);
    expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: '/run/gitconfig', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', PATH: '/bin' });
  });
});

describe('runnerGit against a planted repository config', () => {
  it('core.fsmonitor, core.hooksPath and filter markers never run (a plain git control run does)', async () => {
    const root = tmp('minions-rgit-');
    const repo = join(root, 'repo');
    initRepo(repo);
    const marker = join(root, 'MARKER');
    const evil = join(root, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\necho ran >> ${marker}\ncat\n`, { mode: 0o755 });
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'pre-commit'), `#!/bin/sh\necho ran >> ${marker}\n`, { mode: 0o755 });
    gitSync(repo, 'config', 'core.fsmonitor', evil);
    gitSync(repo, 'config', 'core.hooksPath', join(root, 'hooks'));
    gitSync(repo, 'config', 'filter.evil.clean', evil);
    writeFileSync(join(repo, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    const globalConfig = join(root, 'gitconfig');
    writeFileSync(globalConfig, '');
    const target = { gitDir: join(repo, '.git'), workTree: repo };
    const opts = { globalConfig, identity: { name: 'r', email: 'r@x' } };
    await runnerGit(target, ['status', '--porcelain'], false, opts);
    await runnerGit(target, ['add', '-A'], false, opts);
    await runnerGit(target, ['commit', '-q', '-m', 'safe'], false, opts);
    expect(existsSync(marker)).toBe(false);
    // Control: the same repository with plain git runs the planted programs.
    writeFileSync(join(repo, 'g.txt'), 'y\n');
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    expect(existsSync(marker)).toBe(true);
  });

  it('verify runs before every call and stops it', async () => {
    const root = tmp('minions-rgit-');
    initRepo(join(root, 'repo'));
    writeFileSync(join(root, 'gitconfig'), '');
    await expect(runnerGit({ gitDir: join(root, 'repo', '.git'), verify: async () => { throw new Error('pointer changed'); } }, ['rev-parse', 'HEAD'], false, { globalConfig: join(root, 'gitconfig') }))
      .rejects.toThrow('pointer changed');
  });

  it('the clone config template has no include, remote or hooks and turns reflogs off', () => {
    const t = cloneConfigTemplate({ name: 'Ada\n[include]', email: 'a@x' });
    expect(t).toContain('logallrefupdates = false');
    expect(t).toContain('name = minions worker');
    expect(t).not.toMatch(/include|remote|hooks/);
  });
});
