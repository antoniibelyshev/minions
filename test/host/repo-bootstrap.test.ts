// New projects (docs/design/autonomy.md phase 6): init/setup create the repository in an empty directory.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../../src/core/exec.js';
import { bootstrapRepo } from '../../src/host/repo-bootstrap.js';

let root: string;
const saved: Record<string, string | undefined> = {};
const ENV = { GIT_CONFIG_GLOBAL: '', GIT_CONFIG_NOSYSTEM: '1' };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'minions-bootstrap-'));
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = Test\n\temail = test@example.test\n');
  for (const [k, v] of Object.entries({ ...ENV, GIT_CONFIG_GLOBAL: join(root, 'gitconfig') })) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});
const git = async (dir: string, ...args: string[]) => (await run('git', ['-C', dir, ...args], { allowFailure: true })).stdout.trim();

describe('repository bootstrap', () => {
  it('an empty directory becomes a repository on main with an empty first commit; a second run changes nothing', async () => {
    const dir = join(root, 'new'); mkdirSync(dir);
    writeFileSync(join(dir, '.DS_Store'), '');
    expect(await bootstrapRepo(dir)).toEqual(['Created a Git repository on main with an empty first commit.']);
    expect(await git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(await git(dir, 'ls-tree', '-r', 'HEAD')).toBe('');
    expect(await bootstrapRepo(dir)).toEqual([]);
  });

  it('a repository without commits gets the first commit; its staged files stay staged and uncommitted', async () => {
    const dir = join(root, 'unborn'); mkdirSync(dir);
    await git(dir, 'init', '-b', 'trunk');
    writeFileSync(join(dir, 'a.txt'), 'a');
    await git(dir, 'add', 'a.txt');
    expect(await bootstrapRepo(dir)).toEqual(['Created an empty first commit (the repository has no commits).']);
    expect(await git(dir, 'ls-tree', '-r', '--name-only', 'trunk')).toBe('');
    expect(await git(dir, 'diff', '--cached', '--name-only')).toBe('a.txt');
  });

  it('refuses a non-empty non-repository, and a dry run creates nothing', async () => {
    const dir = join(root, 'files'); mkdirSync(dir);
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    await expect(bootstrapRepo(dir)).rejects.toThrow(/not empty/);
    const empty = join(root, 'empty'); mkdirSync(empty);
    await expect(bootstrapRepo(empty, { dryRun: true })).rejects.toThrow(/without --dry-run minions creates/);
    expect(await git(empty, 'rev-parse', '--git-dir')).toBe('');
  });
});
