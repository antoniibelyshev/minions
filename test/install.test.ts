// Packaging invariants for `npm install -g github:antoniibelyshev/minions` (git-URL installs).
// No network: reads package.json, runs `npm pack --dry-run --ignore-scripts`, and exercises the
// prepare-hook helpers against temp dirs. The full install is scripts/verify-git-install.sh.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_DEPS, inGitDepPrepare, localNpmEnv, missingBuildDeps, strayGlobalLink } from '../scripts/prepare.mjs';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  license?: string;
  repository?: { type: string; url: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Environment without npm_* variables inherited from `npm test` / `npx` (they can change npm pack's output). */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));

/** Files the CLI and the runtime image build read from the installed package root. */
const RUNTIME_ASSETS = ['package.json', 'docker/Dockerfile', 'docker/gh-wrapper.sh', 'schema/config.schema.json', 'templates/plugin'];

describe('package.json for git-URL installs', () => {
  it('builds on install through the prepare hook', () => {
    expect(pkg.scripts.prepare).toBe('node scripts/prepare.mjs');
    expect(pkg.scripts.build).toBeDefined();
    expect(pkg.bin.minions).toBe('dist/cli.js');
  });

  it('points at the GitHub repository', () => {
    expect(pkg.repository?.url).toBe('git+https://github.com/antoniibelyshev/minions.git');
  });

  it('declares every build-time package (installed for git deps as devDependencies)', () => {
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dep of BUILD_DEPS) expect(declared, dep).toHaveProperty(dep);
    expect(declared).toHaveProperty('typescript');
  });

  it('ships dist and the runtime assets', () => {
    for (const f of ['dist', 'templates', 'docker', 'schema']) expect(pkg.files).toContain(f);
    for (const f of RUNTIME_ASSETS) expect(existsSync(join(root, f)), f).toBe(true);
  });

  it('keeps runtime assets tracked by git (dist is built, not committed)', () => {
    const tracked = spawnSync('git', ['ls-files', '--', 'templates', 'docker', 'schema'], { cwd: root, encoding: 'utf8' });
    if (tracked.status !== 0) return; // not a git checkout (e.g. unpacked tarball)
    for (const f of RUNTIME_ASSETS.filter((a) => a !== 'package.json')) {
      expect(tracked.stdout.split('\n').some((l) => l === f || l.startsWith(`${f}/`)), f).toBe(true);
    }
    expect(spawnSync('git', ['check-ignore', '-q', 'dist/cli.js'], { cwd: root }).status).toBe(0);
  });

  it('npm pack includes the runtime assets and dist', () => {
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    const files = (JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    for (const f of RUNTIME_ASSETS) expect(files.some((p) => p === f || p.startsWith(`${f}/`)), f).toBe(true);
    expect(files).toContain('templates/plugin/.claude-plugin/plugin.json');
    if (existsSync(join(root, 'dist', 'cli.js'))) expect(files).toContain('dist/cli.js');
    expect(files.some((p) => p.startsWith('src/') || p.startsWith('test/') || p.startsWith('node_modules/'))).toBe(false);
  });

  it('declares MIT license and includes LICENSE in npm pack', () => {
    expect(pkg.license).toBe('MIT');
    expect(existsSync(join(root, 'LICENSE')), 'LICENSE file exists').toBe(true);
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', env: cleanEnv() });
    expect(r.status, r.stderr).toBe(0);
    const files = (JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    expect(files).toContain('LICENSE');
  });
});

describe('prepare hook helpers', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'minions-prepare-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('finds the build deps in this checkout and reports them missing in an empty dir', () => {
    expect(missingBuildDeps(root)).toEqual([]);
    const empty = tmp();
    expect(missingBuildDeps(empty)).toEqual(BUILD_DEPS);
  });

  it('strips inherited global npm settings for the nested install', () => {
    const env = localNpmEnv({ PATH: '/bin', npm_config_global: 'true', npm_config_prefix: '/p', npm_config_omit: 'dev', npm_config_cache: '/c' });
    expect(env).toEqual({ PATH: '/bin', npm_config_cache: '/c' });
  });

  /** A temp dir shaped like pacote's git clone: `<cache>/_cacache/tmp/git-clone<random>`. */
  const gitClone = () => {
    const dir = join(tmp(), '_cacache', 'tmp', 'git-cloneAbC123');
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const pacoteEnv = { _PACOTE_NO_PREPARE_: 'git+ssh://git@github.com/antoniibelyshev/minions.git#0123abc' };

  it('recognises npm git-dependency preparation only with both pacote signals', () => {
    const clone = gitClone();
    expect(inGitDepPrepare(pacoteEnv, clone)).toBe(true);
    expect(inGitDepPrepare({}, clone)).toBe(false); // no _PACOTE_NO_PREPARE_
    expect(inGitDepPrepare(pacoteEnv, tmp())).toBe(false); // not a git-clone temp dir
    expect(inGitDepPrepare(pacoteEnv, root)).toBe(false); // a checkout
  });

  it('detects the stray global link to the clone only during a global git-dep install', () => {
    const prefix = tmp();
    const clone = gitClone();
    mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
    const link = join(prefix, 'lib', 'node_modules', 'minions');
    symlinkSync(clone, link);
    const env = { ...pacoteEnv, npm_config_global: 'true', npm_config_prefix: prefix };
    expect(strayGlobalLink(env, clone, 'linux')).toBe(link);
    expect(strayGlobalLink({ ...pacoteEnv, npm_config_prefix: prefix }, clone, 'linux')).toBeNull();
    expect(strayGlobalLink(env, gitClone(), 'linux')).toBeNull(); // link points elsewhere
    rmSync(link);
    mkdirSync(link);
    expect(strayGlobalLink(env, clone, 'linux')).toBeNull(); // a real directory is left alone
  });

  it('leaves the link alone for a plain `npm install -g .` from a checkout', () => {
    const prefix = tmp();
    const checkout = tmp();
    mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
    const link = join(prefix, 'lib', 'node_modules', 'minions');
    symlinkSync(checkout, link);
    const env = { npm_config_global: 'true', npm_config_prefix: prefix };
    expect(strayGlobalLink(env, checkout, 'linux')).toBeNull();
    // Even a stray _PACOTE_NO_PREPARE_ (a parent git-dep install) is not enough outside a git-clone dir.
    expect(strayGlobalLink({ ...env, ...pacoteEnv }, checkout, 'linux')).toBeNull();
  });
});
