// Secrets ownership for Linux hosts with uid != 1000 (task-25.2): private-group sharing via group_add
// and 0750/0640 modes, refusal for shared groups, and the unchanged macOS / uid-1000 path.
// All identity facts are fakes (no getent, no real /etc/passwd).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPaths } from '../../src/core/paths.js';
import { writeKeyFile, ensureSecretsDir } from '../../src/host/auth.js';
import { authPlan } from '../../src/host/auth-cli.js';
import { materializeSecrets, provisionGithubToken } from '../../src/host/credentials.js';
import { composeYaml } from '../../src/host/docker.js';
import { linuxDockerChecks, linuxHostFacts, unknownLinuxFacts, type LinuxHostFacts } from '../../src/host/linux-host.js';
import type { ProjectJson } from '../../src/host/project.js';
import {
  dockerLooksRootless, parseGroup, parsePasswd, prepareSecretsDir, probeSecretsAccess, secretsAccessFor, type SecretsAccess,
} from '../../src/host/secrets-access.js';
import { makeRepo, withHome } from './fixtures.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';
const project: ProjectJson = {
  version: 1, projectId: ID, repoPath: '/home/x/repo', gitCommonDir: '/home/x/repo/.git', visibility: 'private',
  profile: 'personal-work', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null,
  gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet' },
};

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  '# comment',
  'ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash',
  'ada:x:1001:1001:Ada:/home/ada:/bin/bash',
  'bob:x:1002:100:Bob:/home/bob:/bin/bash',
  'carol:x:1003:1003:Carol:/home/carol:/bin/bash',
  'dave:x:1004:1003:Dave:/home/dave:/bin/bash',
  'erin:x:1005:1005:Erin:/home/erin:/bin/bash',
  'frank:x:1006:1006:Frank:/home/frank:/bin/bash',
  'gina:x:1007:1007:Gina:/home/gina:/bin/bash',
  '+::::::',
].join('\n') + '\n';
const GROUP = [
  'root:x:0:',
  'users:x:100:alice,bob',
  'ubuntu:x:1000:',
  'ada:x:1001:',
  'carol:x:1003:',
  'erin:x:1005:erin,mallory',
  'staff:x:1006:',
  'gina:x:1007:gina',
].join('\n') + '\n';
const linux = (uid: number | null, passwd: string | null = PASSWD, group: string | null = GROUP) =>
  secretsAccessFor({ platform: 'linux', uid, passwd, group });
const fakeRead = (files: Record<string, string>) => (p: string) => files[p] ?? null;
const GROUP_ACCESS: SecretsAccess = { mode: 'group', gid: 1001, group: 'ada', user: 'ada' };

describe('secretsAccessFor (pure, fake /etc/passwd + /etc/group)', () => {
  it('parses passwd/group lines, skipping comments, blanks and NIS +/- entries', () => {
    expect(parsePasswd(PASSWD).map((u) => u.name)).not.toContain('+');
    expect(parsePasswd(PASSWD).find((u) => u.name === 'ada')).toEqual({ name: 'ada', uid: 1001, gid: 1001 });
    expect(parseGroup(GROUP).find((g) => g.name === 'users')).toEqual({ name: 'users', gid: 100, members: ['alice', 'bob'] });
    expect(parseGroup(GROUP).find((g) => g.name === 'ada')?.members).toEqual([]);
  });

  it('macOS, unknown uid and host uid 1000: owner mode (no group sharing)', () => {
    expect(secretsAccessFor({ platform: 'darwin', uid: 501, passwd: PASSWD, group: GROUP })).toEqual({ mode: 'owner' });
    expect(linux(null)).toEqual({ mode: 'owner' });
    expect(linux(1000)).toEqual({ mode: 'owner' });
  });

  it('uid 1001 with a private user group: group mode with its gid', () => {
    expect(linux(1001)).toEqual(GROUP_ACCESS);
    // The user listed as the only explicit member still counts as private.
    expect(linux(1007)).toEqual({ mode: 'group', gid: 1007, group: 'gina', user: 'gina' });
  });

  it('shared primary group (users with members): unsupported, naming the other members', () => {
    const a = linux(1002);
    expect(a.mode).toBe('unsupported');
    expect(a.mode === 'unsupported' && a.reason).toContain('users (gid 100) is not a private user group (other members: alice)');
  });

  it('refuses a group that another account uses as primary group, has extra members, or is named differently', () => {
    const shared = linux(1003);
    expect(shared.mode === 'unsupported' && shared.reason).toContain('other members: dave');
    const extra = linux(1005);
    expect(extra.mode === 'unsupported' && extra.reason).toContain('other members: mallory');
    const renamed = linux(1006);
    expect(renamed.mode === 'unsupported' && renamed.reason).toContain('its name differs from the user frank');
  });

  it('refuses root, unknown accounts, missing groups and unreadable files', () => {
    expect(linux(0).mode).toBe('unsupported');
    const missing = linux(4242);
    expect(missing.mode === 'unsupported' && missing.reason).toContain('no entry in /etc/passwd');
    const noGroup = linux(1001, PASSWD, 'root:x:0:\n');
    expect(noGroup.mode === 'unsupported' && noGroup.reason).toContain('no entry in /etc/group');
    expect(linux(1001, null).mode).toBe('unsupported');
  });

  it('probeSecretsAccess reads only the injected files, and nothing at all for macOS or uid 1000', () => {
    const read = fakeRead({ '/etc/passwd': PASSWD, '/etc/group': GROUP });
    expect(probeSecretsAccess({ platform: 'linux', uid: 1001, readFile: read })).toEqual(GROUP_ACCESS);
    const never = (p: string): string | null => { throw new Error(`unexpected read ${p}`); };
    expect(probeSecretsAccess({ platform: 'darwin', uid: 501, readFile: never })).toEqual({ mode: 'owner' });
    expect(probeSecretsAccess({ platform: 'linux', uid: 1000, readFile: never })).toEqual({ mode: 'owner' });
  });
});

describe('compose.yaml group_add', () => {
  let env: ReturnType<typeof withHome>;
  beforeEach(() => { env = withHome(); });
  afterEach(() => env.cleanup());

  it('owner and unsupported modes produce the same compose.yaml, without group_add', () => {
    const owner = composeYaml(project, { mode: 'owner' });
    expect(owner).not.toContain('group_add');
    expect(composeYaml(project, { mode: 'unsupported', reason: 'x' })).toBe(owner);
  });

  it('private group: only a group_add line with the host gid is added, right after user', () => {
    const owner = composeYaml(project, { mode: 'owner' });
    const grp = composeYaml(project, GROUP_ACCESS);
    expect(grp).toContain('    user: "1000:1000"\n    group_add: ["1001"]\n');
    expect(grp.replace('    group_add: ["1001"]\n', '')).toBe(owner);
    expect(grp).toContain('user: "1000:1000"'); // never runs as the host uid, never chowns
  });
});

describe('secrets directory modes', () => {
  let env: ReturnType<typeof withHome>;
  let prevStore: string | undefined;
  beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
  afterEach(() => {
    if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
    env.cleanup();
  });
  const mode = (p: string) => statSync(p).mode & 0o777;
  // The test user's own primary gid stands in for the private group (chown to it needs no privilege).
  const own = (): SecretsAccess => ({ mode: 'group', gid: process.getgid!(), group: 'self', user: 'self' });

  it('owner mode: dir 0700, token and key files 0600 (unchanged)', async () => {
    const repo = makeRepo(env.root);
    await provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
    const p = projectPaths(ID);
    await materializeSecrets(ID, undefined, { mode: 'owner' });
    await writeKeyFile(ID, 'sk-test', { mode: 'owner' });
    expect(mode(p.secretsDir)).toBe(0o700);
    expect(mode(p.githubTokenFile)).toBe(0o600);
    expect(mode(p.apiKeyFile)).toBe(0o600);
  });

  it('group mode: dir 0750, files 0640 with the group, owner unchanged, no temp files', async () => {
    const repo = makeRepo(env.root);
    await provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
    const p = projectPaths(ID);
    const old = process.umask(0o077); // a strict umask must not narrow the group bits
    try {
      await materializeSecrets(ID, undefined, own());
      await writeKeyFile(ID, 'sk-test', own());
    } finally { process.umask(old); }
    for (const f of [p.secretsDir, p.githubTokenFile, p.apiKeyFile]) {
      expect(statSync(f).gid).toBe(process.getgid!());
      expect(statSync(f).uid).toBe(process.getuid!());
    }
    expect(mode(p.secretsDir)).toBe(0o750);
    expect(mode(p.githubTokenFile)).toBe(0o640);
    expect(mode(p.apiKeyFile)).toBe(0o640);
    expect(readFileSync(p.githubTokenFile, 'utf8')).toBe(TOKEN + '\n');
    expect(readdirSync(p.secretsDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('switching modes re-applies them to files already in the directory; symlinks are left alone', async () => {
    const p = projectPaths(ID);
    await writeKeyFile(ID, 'sk-test', own());
    expect(mode(p.apiKeyFile)).toBe(0o640);
    await ensureSecretsDir(ID, { mode: 'owner' });
    expect(mode(p.secretsDir)).toBe(0o700);
    expect(mode(p.apiKeyFile)).toBe(0o600);
    const outside = `${env.root}/outside`;
    writeFileSync(outside, 'x', { mode: 0o600 });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(outside, `${p.secretsDir}/link`);
    await prepareSecretsDir(p.secretsDir, own());
    expect(mode(p.apiKeyFile)).toBe(0o640);
    expect(lstatSync(`${p.secretsDir}/link`).isSymbolicLink()).toBe(true);
    expect(mode(outside)).toBe(0o600); // never followed
  });
});

describe('doctor docker.uid', () => {
  const SEC_ROOTFUL = ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'];
  const facts = (f: Partial<LinuxHostFacts>): LinuxHostFacts => ({ ...unknownLinuxFacts(), securityOptions: SEC_ROOTFUL, ...f });
  const uidCheck = (f: LinuxHostFacts) => linuxDockerChecks(f, '/r').find((c) => c.name === 'docker.uid');

  it('uid 1000: ok as before', () => {
    expect(uidCheck(facts({ uid: 1000, secretsAccess: { mode: 'owner' } }))?.status).toBe('ok');
  });

  it('uid 1001 with a private group: ok, naming the group and group_add', () => {
    const c = uidCheck(facts({ uid: 1001, secretsAccess: GROUP_ACCESS }))!;
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('ada (gid 1001)');
    expect(c.detail).toContain('group_add');
  });

  it('shared group: refusal with the reason; never suggests chown or ACLs for uid 1000', () => {
    const c = uidCheck(facts({ uid: 1002, secretsAccess: linux(1002) }))!;
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('users (gid 100) is not a private user group');
    expect(c.hint).toContain('never chowns');
    expect(c.hint).toContain('never grants it ACLs');
  });

  it('rootless Docker stays unsupported: rootless warning, no uid check even with a private group', () => {
    const c = linuxDockerChecks(facts({ securityOptions: ['name=rootless'], uid: 1001, secretsAccess: GROUP_ACCESS }), '/r');
    expect(c.map((x) => [x.name, x.status])).toEqual([['docker.rootless', 'warn']]);
  });

  it('linuxHostFacts derives secretsAccess from the injected passwd/group files', async () => {
    const runner = async () => ({ code: 127, stdout: '', stderr: 'ENOENT' });
    const down = { daemon: false, serverVersion: null, compose: true, composeVersion: '2.29.1', error: 'x' };
    const read = fakeRead({ '/etc/passwd': PASSWD, '/etc/group': GROUP });
    expect((await linuxHostFacts(runner, down, { env: {}, uid: 1001, exists: async () => false, readFile: read })).secretsAccess).toEqual(GROUP_ACCESS);
    expect((await linuxHostFacts(runner, down, { env: {}, uid: 1002, exists: async () => false, readFile: read })).secretsAccess?.mode).toBe('unsupported');
  });
});

describe('task-25.2 repair: duplicate gids, chown ordering, rootless, plan label', () => {
  it('every /etc/group entry with the gid counts: an alias entry with another member makes the group shared', () => {
    const p = 'ada:x:1001:1001::/h:/bin/sh\n';
    const a = secretsAccessFor({ platform: 'linux', uid: 1001, passwd: p, group: 'ada:x:1001:\nada-alias:x:1001:bob\n' });
    expect(a).toEqual({ mode: 'unsupported', reason: expect.stringContaining('other members: bob') });
    // An alias without other members is still private; the first (getgrgid) entry must carry the user's name.
    expect(secretsAccessFor({ platform: 'linux', uid: 1001, passwd: p, group: 'ada:x:1001:\nada-alias:x:1001:ada\n' }).mode).toBe('group');
    expect(secretsAccessFor({ platform: 'linux', uid: 1001, passwd: p, group: 'ada-alias:x:1001:\nada:x:1001:\n' }).mode).toBe('unsupported');
    // Another passwd account with the same primary gid, even with a clean /etc/group.
    expect(secretsAccessFor({ platform: 'linux', uid: 1001, passwd: p + 'svc:x:1500:1001::/h:/bin/sh\n', group: 'ada:x:1001:\n' }).mode).toBe('unsupported');
  });

  it('rootless Docker (env/context heuristic or explicit) keeps owner mode and compose.yaml without group_add', () => {
    const files = { '/etc/passwd': PASSWD, '/etc/group': GROUP };
    const probe = (env: NodeJS.ProcessEnv, extra: Record<string, string> = {}, rootless?: boolean) =>
      probeSecretsAccess({ platform: 'linux', uid: 1001, env, readFile: fakeRead({ ...files, ...extra }), ...(rootless !== undefined ? { rootless } : {}) });
    expect(probe({})).toEqual(GROUP_ACCESS);
    expect(probe({ DOCKER_HOST: 'unix:///var/run/docker.sock' })).toEqual(GROUP_ACCESS);
    expect(probe({ DOCKER_HOST: 'tcp://10.0.0.1:2376' })).toEqual(GROUP_ACCESS);
    expect(probe({ DOCKER_HOST: 'unix:///run/user/1001/docker.sock' })).toEqual({ mode: 'owner' });
    expect(probe({ DOCKER_HOST: 'unix:///xdg/docker.sock', XDG_RUNTIME_DIR: '/xdg/' })).toEqual({ mode: 'owner' });
    expect(probe({}, {}, true)).toEqual({ mode: 'owner' });
    expect(probe({ DOCKER_HOST: 'unix:///run/user/1001/docker.sock' }, {}, false)).toEqual(GROUP_ACCESS); // docker info wins
    expect(composeYaml(project, probe({ DOCKER_HOST: 'unix:///run/user/1001/docker.sock' }))).toBe(composeYaml(project, { mode: 'owner' }));
    expect(secretsAccessFor({ platform: 'linux', uid: 1001, passwd: PASSWD, group: GROUP, rootless: true })).toEqual({ mode: 'owner' });
  });

  it('dockerLooksRootless follows DOCKER_CONTEXT / currentContext to the context endpoint', () => {
    const cfg = '/h/.docker';
    const meta = (name: string) => `${cfg}/contexts/meta/${createHash('sha256').update(name).digest('hex')}/meta.json`;
    const ep = (host: string) => JSON.stringify({ Name: 'x', Endpoints: { docker: { Host: host } } });
    const read = fakeRead({
      [`${cfg}/config.json`]: JSON.stringify({ currentContext: 'rootless' }),
      [meta('rootless')]: ep('unix:///run/user/1001/docker.sock'),
      [meta('remote')]: ep('ssh://me@box'),
    });
    expect(dockerLooksRootless({ uid: 1001, env: { HOME: '/h' }, readFile: read })).toBe(true);
    expect(dockerLooksRootless({ uid: 1001, env: { HOME: '/h', DOCKER_CONTEXT: 'remote' }, readFile: read })).toBe(false);
    expect(dockerLooksRootless({ uid: 1001, env: { HOME: '/h', DOCKER_CONTEXT: 'default' }, readFile: read })).toBe(false);
    expect(dockerLooksRootless({ uid: 1001, env: { DOCKER_CONFIG: '/none' }, readFile: read })).toBe(false);
    expect(dockerLooksRootless({ uid: 1001, env: { DOCKER_CONFIG: '/none', DOCKER_CONTEXT: 'rootless' }, readFile: read })).toBe(true);
    expect(dockerLooksRootless({ uid: 1001, env: { DOCKER_HOST: 'unix:///run/user/1002/docker.sock' }, readFile: read })).toBe(false);
  });

  it('doctor: rootless from docker info gives owner mode, the rootless warning and no uid check', async () => {
    const runner = async (cmd: string) => (cmd === 'docker'
      ? { code: 0, stdout: '["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]\n', stderr: '' }
      : { code: 127, stdout: '', stderr: 'ENOENT' });
    const up = { daemon: true, serverVersion: '27.0', compose: true, composeVersion: '2.29.1' };
    const read = fakeRead({ '/etc/passwd': PASSWD, '/etc/group': GROUP });
    const f = await linuxHostFacts(runner, up, { env: {}, uid: 1001, exists: async () => false, readFile: read });
    expect(f.secretsAccess).toEqual({ mode: 'owner' });
    const checks = linuxDockerChecks(f, '/r');
    expect(checks.map((c) => [c.name, c.status])).toEqual([['docker.rootless', 'warn']]);
  });

  describe('chown before widening', () => {
    let env: ReturnType<typeof withHome>;
    beforeEach(() => { env = withHome(); });
    afterEach(() => env.cleanup());
    const mode = (p: string) => statSync(p).mode & 0o777;
    // gid 0 is never ours in an unprivileged run, so chown(-1, 0) fails with EPERM.
    const foreign: SecretsAccess = { mode: 'group', gid: 0, group: 'root', user: 'x' };
    const privileged = () => process.getuid!() === 0 || process.getgid!() === 0;

    it('a failed group change leaves an existing dir 0700 and its files 0600', async () => {
      if (privileged()) return;
      const dir = `${env.root}/sec`;
      await prepareSecretsDir(dir, { mode: 'owner' });
      writeFileSync(`${dir}/k`, 'x', { mode: 0o600 });
      await expect(prepareSecretsDir(dir, foreign)).rejects.toThrow();
      expect(mode(dir)).toBe(0o700);
      expect(mode(`${dir}/k`)).toBe(0o600);
    });

    it('a failed group change on a new dir leaves it 0700', async () => {
      if (privileged()) return;
      const dir = `${env.root}/fresh`;
      await expect(prepareSecretsDir(dir, foreign)).rejects.toThrow();
      expect(mode(dir)).toBe(0o700);
    });
  });

  it('auth plan shows the real key file mode (0600 owner, 0640 private group)', () => {
    const env = withHome();
    try {
      const key = { method: 'api-key' as const, source: { type: 'env' as const, name: 'MY_KEY' } };
      expect(authPlan(key, ID, { mode: 'owner' }).writes.at(-1)).toMatch(/\(0600\)$/);
      expect(authPlan(key, ID, GROUP_ACCESS).writes.at(-1)).toMatch(/\(0640\)$/);
      expect(authPlan(key, ID, GROUP_ACCESS).writes.join(' ')).not.toContain('0600');
    } finally { env.cleanup(); }
  });
});
