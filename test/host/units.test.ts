import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileDefaults } from '../../src/config/profiles.js';
import { MinionsError } from '../../src/core/errors.js';
import { projectPaths, volumeNames } from '../../src/core/paths.js';
import { composeMajor, discover, proposeVerification, sanitizeRemoteUrl } from '../../src/host/discovery.js';
import { Compose, buildFingerprint, composeYaml, ensureImage, packageRoot } from '../../src/host/docker.js';
import { nodeVersionOk } from '../../src/host/doctor.js';
import type { ProjectJson } from '../../src/host/project.js';
import { bindProject, resolveIdentity, sharedProjectId, type Registry } from '../../src/host/registry.js';
import { exportRepo, secretLikePaths } from '../../src/host/transfer.js';
import { parsePorts, runWizard, type WizardIO } from '../../src/host/wizard.js';
import { makeRepo, withHome } from './fixtures.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const project = (over: Partial<ProjectJson['container']> = {}): ProjectJson => ({
  version: 1, projectId: ID, repoPath: '/Users/x/repo', gitCommonDir: '/Users/x/repo/.git', visibility: 'private',
  profile: 'personal-work', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null,
  gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet', ...over },
});

describe('compose generation', () => {
  let env: ReturnType<typeof withHome>;
  beforeEach(() => { env = withHome(); });
  afterEach(() => env.cleanup());

  it('has every security setting from the container contract', () => {
    const y = composeYaml(project());
    for (const line of [
      'user: "1000:1000"', 'read_only: true', 'cap_drop: ["ALL"]', 'security_opt: ["no-new-privileges:true"]',
      'init: true', 'privileged: false', 'cpus: 4', 'mem_limit: "6144m"', 'pids_limit: 512',
      'command: ["sleep", "infinity"]', 'MINIONS_RUNTIME: "container"', 'CLAUDE_CONFIG_DIR: "/home/node/.claude"',
      'MINIONS_CONFIG: "/opt/minions/config/config.json"', 'pull_policy: never', 'LANG: "C.UTF-8"', 'TERM: "xterm-256color"',
      '- "/tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777"', '- "/home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=0755"',
    ]) expect(y, line).toContain(line);
    for (const bad of ['docker.sock', 'privileged: true', 'network_mode: host', 'network_mode: "host"', 'pid:', 'devices:', 'cap_add', 'ports:']) {
      expect(y, bad).not.toContain(bad);
    }
    const v = volumeNames(ID);
    for (const n of Object.values(v)) expect(y).toContain(`name: "${n}"`);
    expect(y).toContain('name: "minions-3f2b8c1e"');
  });

  it('bind mounts only the plugin and runtime config dirs, read-only', () => {
    const y = composeYaml(project());
    const p = projectPaths(ID);
    const binds = [...y.matchAll(/- type: bind\n\s+source: "([^"]+)"\n\s+target: "([^"]+)"\n\s+read_only: (\w+)/g)].map((m) => [m[1], m[2], m[3]]);
    expect(binds).toEqual([[p.pluginDir, '/opt/minions/plugin', 'true'], [p.runtimeDir, '/opt/minions/config', 'true']]);
    expect(y.match(/type: bind/g)).toHaveLength(2);
    const vols = [...y.matchAll(/- type: volume\n\s+source: (\w+)\n\s+target: "([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(vols).toEqual([['workspace', '/workspace'], ['state', '/state'], ['claude', '/home/node/.claude'], ['cache', '/home/node/.cache']]);
  });

  it('publishes ports only on loopback when configured', () => {
    const y = composeYaml(project({ publishPorts: [{ host: 3000, container: 3000 }, { host: 8081, container: 80 }], cpus: 2.5 }));
    expect(y).toContain('ports:\n      - "127.0.0.1:3000:3000"\n      - "127.0.0.1:8081:80"\n');
    expect(y).toContain('cpus: 2.5');
    const ports = [...y.matchAll(/^\s+- "(\d[^"]*)"$/gm)].map((m) => m[1]);
    for (const port of ports) expect(port).toMatch(/^127\.0\.0\.1:/);
  });

  it('network none disables networking and ports', () => {
    const y = composeYaml(project({ network: 'none', publishPorts: [{ host: 3000, container: 3000 }] }));
    expect(y).toContain('network_mode: "none"');
    expect(y).not.toContain('ports:');
  });

  it('compose argv is fixed: docker compose -p <name> -f <file>', async () => {
    const calls: string[][] = [];
    const c = new Compose(ID, async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: 'abc\n', stderr: '' }; });
    expect(await c.isRunning()).toBe(true);
    await c.exec(['minions', 'status', '--json']);
    expect(calls[0]).toEqual(['docker', 'compose', '-p', 'minions-3f2b8c1e', '-f', projectPaths(ID).composeYaml, 'ps', '--status', 'running', '-q', 'app']);
    expect(calls[1]!.slice(6)).toEqual(['exec', '-T', 'app', 'minions', 'status', '--json']);
  });

  it('ensureImage builds from the package root with docker/Dockerfile only when missing', async () => {
    const calls: string[][] = [];
    const root = packageRoot();
    const runner = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: args[0] === 'image' ? 1 : 0, stdout: '', stderr: '' }; };
    const built = await ensureImage('minions-runtime:9.9.9', { runner, root: join(root) }).catch((e: MinionsError) => e);
    if (built instanceof MinionsError) { expect(built.code).toBe('PRECONDITION'); return; } // dist/ not built in this checkout
    expect(built).toBe(true);
    expect(calls[1]).toEqual(['docker', 'build', '-t', 'minions-runtime:9.9.9', '--label', `minions.build=${buildFingerprint(root)}`, '-f', join(root, 'docker', 'Dockerfile'), root]);
  });

  it('ensureImage rebuilds only when the build label differs from the installed package', async () => {
    const root = packageRoot();
    const fp = buildFingerprint(root);
    if (fp === null) return; // dist/ not built in this checkout
    for (const [label, rebuild] of [[fp, false], ['stale', true], ['<no value>', true]] as const) {
      const calls: string[][] = [];
      const runner = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: `${label}\n`, stderr: '' }; };
      expect(await ensureImage('minions-runtime:9.9.9', { runner, root })).toBe(rebuild);
      expect(calls.some((c) => c[1] === 'build')).toBe(rebuild);
    }
  });
});

describe('registry identity', () => {
  const reg = (projects: Registry['projects'] = {}): Registry => ({ version: 1, projects });
  const entry = (dir: string) => ({ gitCommonDir: dir, repoPath: dir.replace(/\/\.git$/, ''), visibility: 'shared' as const });

  it('new repo gets a fresh uuid; registered repo keeps its id', () => {
    const a = resolveIdentity(reg(), { commonDir: '/r/.git' });
    expect(a.source).toBe('new');
    expect(a.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveIdentity(reg({ [ID]: entry('/r/.git') }), { commonDir: '/r/.git' })).toEqual({ projectId: ID, source: 'registry' });
  });

  it('adopts an unregistered shared id (fresh clone on a new machine)', () => {
    expect(resolveIdentity(reg(), { commonDir: '/r/.git', sharedId: ID })).toEqual({ projectId: ID, source: 'shared' });
  });

  it('rejects a shared id bound to another repository unless --attach / --new-identity', () => {
    const r = reg({ [ID]: entry('/other/.git') });
    expect(() => resolveIdentity(r, { commonDir: '/r/.git', sharedId: ID })).toThrow(/copied project identity/);
    expect(resolveIdentity(r, { commonDir: '/r/.git', sharedId: ID, attach: true }).source).toBe('attached');
    const n = resolveIdentity(r, { commonDir: '/r/.git', sharedId: ID, newIdentity: true });
    expect(n.projectId).not.toBe(ID);
    expect(n.replacesSharedId).toBe(ID);
  });

  it('ignores a shared projectId that is not a UUID (it becomes a host path segment)', async () => {
    const env = withHome();
    try {
      const repo = makeRepo(env.root);
      mkdirSync(join(repo, '.minions'));
      for (const bad of ['../../../../tmp/evil', `${ID}/../x`, 42]) {
        writeFileSync(join(repo, '.minions', 'config.json'), JSON.stringify({ projectId: bad }));
        expect(await sharedProjectId(repo)).toBeUndefined();
      }
      writeFileSync(join(repo, '.minions', 'config.json'), JSON.stringify({ projectId: ID }));
      expect(await sharedProjectId(repo)).toBe(ID);
    } finally { env.cleanup(); }
  });

  it('bindProject replaces older bindings of the same common dir', () => {
    const r = bindProject(reg({ old: entry('/r/.git'), [ID]: entry('/x/.git') }), 'new', entry('/r/.git'));
    expect(Object.keys(r.projects).sort()).toEqual([ID, 'new'].sort());
  });
});

describe('discovery', () => {
  let env: ReturnType<typeof withHome>;
  beforeEach(() => { env = withHome(); });
  afterEach(() => env.cleanup());

  it('reads git metadata and package scripts without running them', async () => {
    const repo = makeRepo(env.root);
    const d = await discover(repo);
    expect(d.git).toMatchObject({ currentBranch: 'main', baseBranch: 'main', remoteUrl: null, dirty: false, userName: 'Ada Lovelace', userEmail: 'ada@example.com' });
    expect(d.verificationCommands).toEqual(['npm run lint', 'npm test']);
    expect(d.instructions).toMatchObject({ claudeMd: false, agentsMd: false, claudeDir: false });
    expect(d.dockerfile).toBe(false);
    expect(d.host.cpus).toBeGreaterThan(0);
  });

  it('proposes commands per package manager and skips placeholder test scripts', () => {
    expect(proposeVerification({ test: 'echo "Error: no test specified" && exit 1' }, 'npm')).toEqual([]);
    expect(proposeVerification({ test: 'jest', typecheck: 'tsc' }, 'pnpm')).toEqual(['pnpm run typecheck', 'pnpm test']);
  });

  it('strips credentials embedded in the remote URL', () => {
    expect(sanitizeRemoteUrl('https://x-access-token:ghp_secret@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('https://ghp_secret@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl('ssh://git:pw@github.com/o/r.git')).toBe('ssh://git@github.com/o/r.git');
    expect(sanitizeRemoteUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(sanitizeRemoteUrl('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(sanitizeRemoteUrl(null)).toBeNull();
  });

  it('requires compose v2+', () => {
    expect(composeMajor('v2.29.1')).toBe(2);
    expect(composeMajor('5.5.1')).toBe(5);
    expect(composeMajor('1.29.2')).toBe(1);
    expect(composeMajor(null)).toBe(0);
  });
});

describe('wizard', () => {
  let env: ReturnType<typeof withHome>;
  beforeEach(() => { env = withHome(); });
  afterEach(() => env.cleanup());

  it('asks material questions with defaults, marks deferred options, never asks for secrets', async () => {
    const repo = makeRepo(env.root);
    const discovery = await discover(repo);
    const questions: string[] = [];
    const info: string[] = [];
    const answers: Record<string, string> = { 'Starting profile': '3', 'Container CPUs': '2', 'Preview ports': '3000' };
    const io: WizardIO = {
      ask: async (q, def) => { questions.push(q); const k = Object.keys(answers).find((a) => q.startsWith(a)); return k ? answers[k]! : def; },
      info: (l) => info.push(l),
    };
    const r = await runWizard({ discovery, projectId: ID, yes: false, io });
    expect(r.config.profile).toBe('supervised');
    expect(r.config.visibility).toBe('private');
    expect(r.config.intake.startReady).toBe(false);
    expect(r.config.container.cpus).toBe(2);
    expect(r.config.container.publishPorts).toEqual([{ host: 3000, container: 3000 }]);
    expect(r.config.verification.commands).toEqual(['npm run lint', 'npm test']);
    expect(info.join('\n')).toMatch(/GitHub Issues \(not available in v0\.1\)/);
    expect(info.join('\n')).toMatch(/Telegram \(not available in v0\.1\)/);
    expect(info.join('\n')).toMatch(/pull requests, auto-merge \(not available in v0\.1\)/);
    for (const q of questions) expect(q).not.toMatch(/token|password|secret|api key/i);
  });

  it('--yes accepts profile defaults without asking', async () => {
    const repo = makeRepo(env.root);
    const r = await runWizard({ discovery: await discover(repo), projectId: ID, yes: true });
    expect(r.asked).toEqual([]);
    expect(r.config).toMatchObject({ profile: 'project-owner', visibility: 'shared', permissionMode: 'acceptEdits' });
  });

  it('--config uses a validated file; unknown fields fail', async () => {
    const repo = makeRepo(env.root);
    const { writeFileSync } = await import('node:fs');
    const cfg = profileDefaults('supervised', { hasGitHub: false, baseBranch: 'main', identity: { name: 'A', email: 'a@b' }, projectId: ID, packageVersion: '0.1.0' }).config;
    const good = join(env.root, 'good.json');
    writeFileSync(good, JSON.stringify(cfg));
    const r = await runWizard({ discovery: await discover(repo), projectId: ID, yes: false, configFile: good });
    expect(r.config.profile).toBe('supervised');
    const bad = join(env.root, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...cfg, extra: 1 }));
    await expect(runWizard({ discovery: await discover(repo), projectId: ID, yes: false, configFile: bad })).rejects.toThrow(/extra: unknown field/);
  });

  it('parses port mappings', () => {
    expect(parsePorts('none')).toEqual([]);
    expect(parsePorts('3000, 8080:80')).toEqual([{ host: 3000, container: 3000 }, { host: 8080, container: 80 }]);
    expect(() => parsePorts('0:1')).toThrow();
    expect(() => parsePorts('abc')).toThrow();
  });
});

describe('transfer + doctor helpers', () => {
  it('flags tracked secret-looking files but not examples', () => {
    expect(secretLikePaths(['.env', 'app/.env.production', '.env.example', 'certs/server.pem', 'keys/id_rsa', 'keys/id_rsa.pub', 'src/index.ts', '.npmrc']))
      .toEqual(['.env', 'app/.env.production', 'certs/server.pem', 'keys/id_rsa', '.npmrc']);
  });

  it('export uses its own bundle name and refuses a copied file that is not a regular file', async () => {
    const env = withHome();
    try {
      const repo = makeRepo(env.root);
      const copies: string[][] = [];
      const fake = {
        // container output names a traversal path: it must be ignored
        exec: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, data: { path: '/state/exports/..', refs: ['refs/heads/main'] } }) }),
        cp: async (src: string, dst: string) => { copies.push([src, dst]); symlinkSync(join(repo, '.git', 'config'), dst); },
      } as unknown as Compose;
      await expect(exportRepo({ ...project(), repoPath: repo }, { compose: fake, repoPath: repo })).rejects.toMatchObject({ code: 'PRECONDITION' });
      expect(copies).toHaveLength(1);
      expect(copies[0]![0]).toMatch(/^app:\/state\/exports\/export-[\w-]+\.bundle$/);
      expect(copies[0]![1]).toBe(join(projectPaths(ID).exportsDir, copies[0]![0]!.split('/').pop()!));
      expect(existsSync(copies[0]![1]!)).toBe(false);
    } finally { env.cleanup(); }
  });

  it('node version check', () => {
    expect(nodeVersionOk('v22.13.0')).toBe(true);
    expect(nodeVersionOk('v22.12.1')).toBe(false);
    expect(nodeVersionOk('v25.1.0')).toBe(true);
  });
});
