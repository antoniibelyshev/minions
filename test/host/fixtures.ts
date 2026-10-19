import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerProbe } from '../../src/host/discovery.js';

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Temp git repo with one commit on main and a configured identity. */
export function makeRepo(root: string, name = 'repo'): string {
  const repo = join(root, name);
  execFileSync('mkdir', ['-p', repo]);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Ada Lovelace');
  git(repo, 'config', 'user.email', 'ada@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', lint: 'eslint .' } }, null, 2));
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

export const dockerUp: DockerProbe = async () => ({ daemon: true, serverVersion: '29.8.2', compose: true, composeVersion: '5.5.1' });
export const dockerDown: DockerProbe = async () => ({ daemon: false, serverVersion: null, compose: true, composeVersion: '5.5.1', error: 'Cannot connect to the Docker daemon' });

export function withHome(): { home: string; root: string; cleanup: () => void } {
  const root = tempDir('minions-test-');
  const home = join(root, 'home');
  const prev = process.env.MINIONS_HOME;
  process.env.MINIONS_HOME = home;
  return { home, root, cleanup: () => { if (prev === undefined) delete process.env.MINIONS_HOME; else process.env.MINIONS_HOME = prev; rmSync(root, { recursive: true, force: true }); } };
}
