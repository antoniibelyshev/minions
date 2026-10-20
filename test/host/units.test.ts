import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileDefaults } from '../../src/config/profiles.js';
import { MinionsError } from '../../src/core/errors.js';
import { projectPaths, volumeNames } from '../../src/core/paths.js';
import { composeMajor, discover, proposeVerification, sanitizeRemoteUrl } from '../../src/host/discovery.js';
import { CONTAINER } from '../../src/core/paths.js';
import { DEFAULT_TMP_SIZE_MIB, Compose, buildFingerprint, composeYaml, ensureImage, packageRoot } from '../../src/host/docker.js';
import { ProjectJsonSchema } from '../../src/host/project.js';
import { MinionsConfigSchema } from '../../src/config/schema.js';
import { runtimePaths } from '../../src/runtime/paths.js';
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
      'command: ["sh", "-c", "mkdir -p /home/node/.cache/tmp; exec sleep infinity"]', 'MINIONS_RUNTIME: "container"', 'CLAUDE_CONFIG_DIR: "/home/node/.claude"',
      'MINIONS_CONFIG: "/opt/minions/config/config.json"', 'pull_policy: never', 'LANG: "C.UTF-8"', 'TERM: "xterm-256color"',
      '- "/tmp:rw,nosuid,nodev,size=1024m,uid=1000,gid=1000,mode=1777"', '- "/home/node:rw,nosuid,nodev,uid=1000,gid=1000,mode=0755"',
      'TMPDIR: "/home/node/.cache/tmp"',
    ]) expect(y, line).toContain(line);
    for (const bad of ['docker.sock', 'privileged: true', 'network_mode: host', 'network_mode: "host"', 'pid:', 'devices:', 'cap_add', 'ports:']) {
      expect(y, bad).not.toContain(bad);
    }
    const v = volumeNames(ID);
    for (const n of Object.values(v)) expect(y).toContain(`name: "${n}"`);
    expect(y).toContain('name: "minions-3f2b8c1e"');
  });

  it('caps the /tmp tmpfs (default and container.tmpSizeMiB) and points TMPDIR at a disk-backed, exec-allowed scratch dir', () => {
    const y = composeYaml(project());
    const tmpfs = [...y.matchAll(/^ {6}- "(\/[^:"]+):([^"]*)"$/gm)].map((m) => [m[1]!, m[2]!.split(',')] as const);
    expect(tmpfs.map(([p]) => p)).toEqual(['/tmp', '/home/node']);
    // The RAM-backed /tmp carries a size cap (it counts against mem_limit).
    expect(tmpfs[0]![1]).toContain(`size=${DEFAULT_TMP_SIZE_MIB}m`);
    expect(composeYaml(project({ tmpSizeMiB: 256 }))).toContain('- "/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777"');
    // TMPDIR: exactly one, on the cache volume (ext4 named volume, no noexec), not on a tmpfs and not in /workspace (git checkouts).
    const tmpdir = [...y.matchAll(/^ {6}TMPDIR: "([^"]+)"$/gm)].map((m) => m[1]);
    expect(tmpdir).toEqual([CONTAINER.scratch]);
    const vols = [...y.matchAll(/- type: volume\n\s+source: (\w+)\n\s+target: "([^"]+)"/g)].map((m) => [m[1]!, m[2]!] as const);
    const longest = (dir: string, mounts: string[]) => mounts.filter((m) => dir === m || dir.startsWith(m + '/')).sort((a, b) => b.length - a.length)[0];
    const mountOf = longest(CONTAINER.scratch, [...vols.map(([, t]) => t), ...tmpfs.map(([p]) => p)]);
    expect(mountOf).toBe('/home/node/.cache');
    expect(vols.find(([, t]) => t === mountOf)?.[0]).toBe('cache');
    expect(CONTAINER.scratch.startsWith(CONTAINER.workspace + '/')).toBe(false);
    // The start command creates it before any exec can use TMPDIR.
    expect(y).toMatch(/command: \["sh", "-c", "mkdir -p \/home\/node\/\.cache\/tmp; exec sleep infinity"\]/);
  });

  it('tmpfs/TMPDIR/command lines are well-formed YAML scalars for any valid tmpSizeMiB (tester, task-27)', () => {
    for (const size of [64, 256, 1024, 8192]) {
      const y = composeYaml(project({ tmpSizeMiB: size }));
      const lines = y.split('\n');
      // Exactly one /tmp tmpfs entry with exactly one size option, as an integer MiB count.
      const tmp = lines.filter((l) => /^ {6}- "\/tmp:/.test(l));
      expect(tmp).toHaveLength(1);
      const opts = (JSON.parse(tmp[0]!.trim().slice(2)) as string).split(':')[1]!.split(',');
      expect(opts.filter((o) => o.startsWith('size='))).toEqual([`size=${size}m`]);
      expect(opts).toEqual(expect.arrayContaining(['rw', 'nosuid', 'nodev', 'mode=1777']));
      // /home/node has no size cap (unchanged).
      expect(lines.find((l) => l.includes('"/home/node:'))).not.toContain('size=');
      // The command is a JSON flow sequence (valid YAML) running mkdir then exec sleep.
      const cmd = lines.find((l) => l.startsWith('    command: '))!;
      expect(JSON.parse(cmd.slice('    command: '.length))).toEqual(['sh', '-c', `mkdir -p ${CONTAINER.scratch}; exec sleep infinity`]);
      const td = lines.filter((l) => l.startsWith('      TMPDIR: '));
      expect(td).toHaveLength(1);
      expect(JSON.parse(td[0]!.slice('      TMPDIR: '.length))).toBe(CONTAINER.scratch);
      // No tabs; every indentation is a multiple of two spaces.
      for (const l of lines) {
        expect(l, l).not.toMatch(/^\t/);
        expect((/^ */.exec(l)![0].length) % 2, l).toBe(0);
      }
    }
    // Absent tmpSizeMiB is the default, identical to an explicit default.
    expect(composeYaml(project())).toBe(composeYaml(project({ tmpSizeMiB: DEFAULT_TMP_SIZE_MIB })));
  });

  it('runtime env: the agents\' scratch root is the compose TMPDIR, lease scratch dirs live under it', () => {
    const y = composeYaml(project());
    const tmpdir = /^ {6}TMPDIR: "([^"]+)"$/m.exec(y)?.[1];
    const rp = runtimePaths({});
    expect(rp.tmp).toBe(tmpdir);
    expect(rp.scratch).toBe(`${tmpdir}/leases`);
    // Host runtime / tests (redirected state dir): never the container path; MINIONS_SCRATCH_DIR overrides.
    expect(runtimePaths({ MINIONS_STATE_DIR: '/x/state' }).scratch).toBe('/x/state/cache/tmp/leases');
    expect(runtimePaths({ MINIONS_STATE_DIR: '/x/state', MINIONS_SCRATCH_DIR: '/y/tmp' }).tmp).toBe('/y/tmp');
  });

  it('container.tmpSizeMiB is optional in project.json and config, and bounded below', () => {
    const base = project();
    expect(ProjectJsonSchema.safeParse(base).success).toBe(true);
    expect(ProjectJsonSchema.safeParse({ ...base, container: { ...base.container, tmpSizeMiB: 2048 } }).success).toBe(true);
    expect(ProjectJsonSchema.safeParse({ ...base, container: { ...base.container, tmpSizeMiB: 8 } }).success).toBe(false);
    const cfg = profileDefaults('project-owner', { hasGitHub: false, hasGitHubCredential: false, baseBranch: 'main', identity: { name: 'Ada', email: 'ada@example.com' }, projectId: ID, packageVersion: '0.1.0' }).config;
    expect(cfg.container.memoryMiB).toBe(6144);
    expect(cfg.container.cpus).toBe(4);
    const shape = MinionsConfigSchema.shape.container;
    expect(shape.safeParse({ ...cfg.container, tmpSizeMiB: 512 }).success).toBe(true);
    expect(shape.safeParse({ ...cfg.container, tmpSizeMiB: 1.5 }).success).toBe(false);
  });

  it('bind mounts only the plugin, runtime config and secrets dirs, read-only', () => {
    const y = composeYaml(project());
    const p = projectPaths(ID);
    const binds = [...y.matchAll(/- type: bind\n\s+source: "([^"]+)"\n\s+target: "([^"]+)"\n\s+read_only: (\w+)/g)].map((m) => [m[1], m[2], m[3]]);
    expect(binds).toEqual([[p.pluginDir, '/opt/minions/plugin', 'true'], [p.runtimeDir, '/opt/minions/config', 'true'], [p.secretsDir, '/opt/minions/secrets', 'true']]);
    expect(y.match(/type: bind/g)).toHaveLength(3);
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
    expect(info.join('\n')).toMatch(/Telegram uses the official Claude Code channel plugin/);
    expect(info.join('\n')).toMatch(/auto \(default: Telegram when a bot token is stored for this project with `minions auth telegram`, otherwise terminal\)/);
    expect(questions).toContain('Communication channel (auto/terminal/telegram)');
    expect(r.config.communication.channel).toBe('auto');
    expect(info.join('\n')).toMatch(/Branch push and pull requests are not selectable: the repository has no GitHub remote/);
    expect(info.join('\n')).toMatch(/Auto-merge \(not available in v0\.1\)/);
    expect(questions.some((q) => q.startsWith('Delivery mode'))).toBe(false);
    expect(r.config.delivery.mode).toBe('local');
    for (const q of questions) expect(q).not.toMatch(/token|password|secret|api key/i);
  });

  it('offers branch/pull-request delivery only with a GitHub remote and a stored token', async () => {
    const repo = makeRepo(env.root);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git']);
    const discovery = await discover(repo);
    const run = async (githubCredential: boolean, mode = 'pull-request') => {
      const questions: string[] = [], info: string[] = [];
      const io: WizardIO = {
        ask: async (q, def) => { questions.push(q); return q.startsWith('Starting profile') ? '1' : q.startsWith('Delivery mode') ? mode : def; },
        info: (l) => info.push(l),
      };
      const r = await runWizard({ discovery, projectId: ID, yes: false, io, githubCredential });
      return { r, questions, info: info.join('\n') };
    };
    const ok = await run(true);
    expect(ok.questions.some((q) => q.startsWith('Delivery mode (local/branch/pull-request)'))).toBe(true);
    expect(ok.r.config.delivery).toMatchObject({ mode: 'pull-request', provider: 'github', merge: 'disabled' });
    expect(ok.info).toMatch(/minions never merges/);
    expect((await run(true, 'branch')).r.config.delivery.mode).toBe('branch');
    expect((await run(true, 'local')).r.config.delivery.mode).toBe('local');

    const noToken = await run(false);
    expect(noToken.questions.some((q) => q.startsWith('Delivery mode'))).toBe(false);
    expect(noToken.r.config.delivery.mode).toBe('local');
    expect(noToken.info).toMatch(/not selectable: no GitHub token is stored for this project \(run `minions auth github`/);

    // --yes: project-owner defaults to pull-request only when the token exists.
    expect((await runWizard({ discovery, projectId: ID, yes: true, githubCredential: true })).config.delivery.mode).toBe('pull-request');
    const fallback = await runWizard({ discovery, projectId: ID, yes: true });
    expect(fallback.config.delivery.mode).toBe('local');
    expect(fallback.notes.join('\n')).toMatch(/pull-request delivery .* no GitHub token/);
  });

  it('does not offer branch/pull-request under a profile that denies git.push (supervised)', async () => {
    const repo = makeRepo(env.root);
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git']);
    const discovery = await discover(repo);
    const questions: string[] = [], info: string[] = [];
    const io: WizardIO = { ask: async (q, def) => { questions.push(q); return def; }, info: (l) => info.push(l) };
    const r = await runWizard({ discovery, projectId: ID, yes: false, io, githubCredential: true, profile: 'supervised' });
    expect(questions.some((q) => q.startsWith('Delivery mode'))).toBe(false);
    expect(r.config.delivery.mode).toBe('local');
    expect(info.join('\n')).toMatch(/not selectable: the profile denies git\.push/);
  });

  it('--config with pull-request delivery falls back to local without a GitHub remote, with a reason', async () => {
    const repo = makeRepo(env.root);
    const { writeFileSync } = await import('node:fs');
    const cfg = profileDefaults('project-owner', { hasGitHub: true, hasGitHubCredential: true, baseBranch: 'main', identity: { name: 'A', email: 'a@b' }, projectId: ID, packageVersion: '0.1.0' }).config;
    expect(cfg.delivery.mode).toBe('pull-request');
    const file = join(env.root, 'pr.json');
    writeFileSync(file, JSON.stringify(cfg));
    const r = await runWizard({ discovery: await discover(repo), projectId: ID, yes: false, configFile: file, githubCredential: true });
    expect(r.config.delivery).toMatchObject({ mode: 'local', provider: 'none' });
    expect(r.notes.join('\n')).toMatch(/delivery.mode "pull-request" is not selectable: the repository has no GitHub remote/);
  });

  it('--yes accepts profile defaults without asking', async () => {
    const repo = makeRepo(env.root);
    const r = await runWizard({ discovery: await discover(repo), projectId: ID, yes: true });
    expect(r.asked).toEqual([]);
    expect(r.config).toMatchObject({ profile: 'project-owner', visibility: 'shared' });
    expect(r.config).not.toHaveProperty('permissionMode');
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
