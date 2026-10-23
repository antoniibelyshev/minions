// QA for task-25.2: end-to-end probe -> compose.yaml / secret file writes with fake /etc/passwd and
// /etc/group, mode transitions on real files, and edge cases of the private-group decision.
// The test user's own primary gid stands in for the private group (chown to it needs no privilege).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWrite } from '../../src/core/fsutil.js';
import { projectPaths } from '../../src/core/paths.js';
import { ensureSecretsDir, writeKeyFile } from '../../src/host/auth.js';
import { materializeSecrets, provisionGithubToken } from '../../src/host/credentials.js';
import { composeYaml } from '../../src/host/docker.js';
import type { ProjectJson } from '../../src/host/project.js';
import { dockerLooksRootless, probeSecretsAccess, secretsAccessFor, type SecretsAccess } from '../../src/host/secrets-access.js';
import { makeRepo, withHome } from './fixtures.js';

const ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const TOKEN = 'github_pat_11QAQAQAQ0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';
const project: ProjectJson = {
  version: 1, projectId: ID, repoPath: '/home/x/repo', gitCommonDir: '/home/x/repo/.git', visibility: 'private',
  profile: 'personal-work', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null,
  gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet' },
};

const gid = process.getgid!();
// Fake host: "ada" (uid 4001) has the private group whose gid is the test user's real gid;
// "bob" (uid 4002) has the shared group "users" (gid 100).
const passwd = (extra = '') => `ada:x:4001:${gid}::/home/ada:/bin/sh\nbob:x:4002:100::/home/bob:/bin/sh\n${extra}`;
const group = (extra = '') => `ada:x:${gid}:\nusers:x:100:alice,bob\n${extra}`;
const read = (p: string, g: string) => (path: string) => (path === '/etc/passwd' ? p : path === '/etc/group' ? g : null);
const mode = (p: string) => statSync(p).mode & 0o777;

describe('private-group decision edge cases', () => {
  const linux = (uid: number, p: string, g: string) => secretsAccessFor({ platform: 'linux', uid, passwd: p, group: g });

  // Regression (QA lease-5780628b324c): members of every /etc/group entry with the gid count, not just the first.
  it('a second /etc/group entry with the same gid and other members is not a private group', () => {
    // Two group names sharing one gid: bob is a member of gid 1001 through the alias entry.
    const a = linux(1001, 'ada:x:1001:1001::/h:/bin/sh\n', 'ada:x:1001:\nada-alias:x:1001:bob\n');
    expect(a.mode).toBe('unsupported');
  });

  it('a second passwd account with the same primary gid makes the group shared', () => {
    expect(linux(1001, 'ada:x:1001:1001::/h:/bin/sh\nsvc:x:1500:1001::/h:/bin/sh\n', 'ada:x:1001:\n').mode).toBe('unsupported');
  });

  it('macOS ignores passwd/group entirely (owner), even for a private group', () => {
    expect(secretsAccessFor({ platform: 'darwin', uid: 4001, passwd: passwd(), group: group() })).toEqual({ mode: 'owner' });
  });
});

describe('probe -> compose.yaml', () => {
  it('private group: group_add with the gid; shared group, uid 1000 and macOS: no group_add and identical output', () => {
    const priv = probeSecretsAccess({ platform: 'linux', uid: 4001, readFile: read(passwd(), group()) });
    const shared = probeSecretsAccess({ platform: 'linux', uid: 4002, readFile: read(passwd(), group()) });
    const never = () => { throw new Error('must not read'); };
    const owner1000 = probeSecretsAccess({ platform: 'linux', uid: 1000, readFile: never });
    const mac = probeSecretsAccess({ platform: 'darwin', uid: 501, readFile: never });
    const base = composeYaml(project, { mode: 'owner' });
    expect(composeYaml(project, priv)).toContain(`    group_add: ["${gid}"]\n`);
    expect(composeYaml(project, priv).match(/group_add/g)).toHaveLength(1);
    for (const a of [shared, owner1000, mac]) expect(composeYaml(project, a)).toBe(base);
    expect(base).toContain('user: "1000:1000"');
  });
});

describe('real secret writes and transitions', () => {
  let env: ReturnType<typeof withHome>;
  let prevStore: string | undefined;
  beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
  afterEach(() => {
    if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
    env.cleanup();
  });

  it('private -> shared group (e.g. a member added): re-provision narrows the dir and every file back to owner-only', async () => {
    const repo = makeRepo(env.root);
    await provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
    const p = projectPaths(ID);
    const priv = probeSecretsAccess({ platform: 'linux', uid: 4001, readFile: read(passwd(), group()) });
    expect(priv.mode).toBe('group');
    await materializeSecrets(ID, undefined, priv);
    await writeKeyFile(ID, 'sk-qa', priv);
    expect([mode(p.secretsDir), mode(p.githubTokenFile), mode(p.apiKeyFile)]).toEqual([0o750, 0o640, 0o640]);
    expect(statSync(p.githubTokenFile).gid).toBe(gid);

    // Someone joins ada's group: the next probe refuses, and the next materialize re-modes everything.
    const nowShared = probeSecretsAccess({ platform: 'linux', uid: 4001, readFile: read(passwd(), `ada:x:${gid}:mallory\n`) });
    expect(nowShared.mode).toBe('unsupported');
    await materializeSecrets(ID, undefined, nowShared);
    expect([mode(p.secretsDir), mode(p.githubTokenFile), mode(p.apiKeyFile)]).toEqual([0o700, 0o600, 0o600]);
    expect(composeYaml(project, nowShared)).not.toContain('group_add');
  });

  it('a key refresh alone (writeKeyFile) also narrows the other existing files when the group became shared', async () => {
    const p = projectPaths(ID);
    const priv: SecretsAccess = { mode: 'group', gid, group: 'ada', user: 'ada' };
    await writeKeyFile(ID, 'sk-1', priv);
    writeFileSync(`${p.secretsDir}/github-token`, 'x\n', { mode: 0o640 });
    await writeKeyFile(ID, 'sk-2', { mode: 'unsupported', reason: 'shared' });
    expect(mode(p.apiKeyFile)).toBe(0o600);
    expect(mode(`${p.secretsDir}/github-token`)).toBe(0o600);
    expect(mode(p.secretsDir)).toBe(0o700);
    expect(readFileSync(p.apiKeyFile, 'utf8')).toBe('sk-2');
  });

  it('owner -> private group (uid change): existing 0600 files are widened only to 0640 with the group, never world bits', async () => {
    const p = projectPaths(ID);
    await writeKeyFile(ID, 'sk-1', { mode: 'owner' });
    writeFileSync(`${p.secretsDir}/stray`, 'x', { mode: 0o666 }); // umask 022 -> 0644
    await ensureSecretsDir(ID, { mode: 'group', gid, group: 'ada', user: 'ada' });
    for (const n of readdirSync(p.secretsDir)) expect(mode(`${p.secretsDir}/${n}`) & 0o007).toBe(0);
    expect(mode(p.apiKeyFile)).toBe(0o640);
    expect(mode(`${p.secretsDir}/stray`)).toBe(0o640);
  });

  it('atomicWrite with a gid the user cannot use fails closed: no temp file, the old file and its mode stay', async () => {
    const dir = `${env.root}/sec`;
    const f = `${dir}/k`;
    await atomicWrite(f, 'old', { mode: 0o600 });
    const foreign = gid === 0 ? null : 0; // gid 0 (root) is never ours in the unprivileged test run
    if (foreign === null || process.getuid!() === 0) return;
    await expect(atomicWrite(f, 'new', { mode: 0o640, gid: foreign })).rejects.toThrow();
    expect(readFileSync(f, 'utf8')).toBe('old');
    expect(mode(f)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['k']);
  });
});

// QA retest (lease-9efabf6b6c0c): more private-group variants, the rootless heuristic on odd inputs, and
// byte-identical output for uid 1000 / macOS whatever the Docker env says.
describe('private-group variants (retest)', () => {
  const P = 'ada:x:1001:1001::/h:/bin/sh\n';
  const linux = (g: string, p = P) => secretsAccessFor({ platform: 'linux', uid: 1001, passwd: p, group: g });

  it('another member listed in the primary entry itself is refused', () => {
    expect(linux('ada:x:1001:bob\n')).toEqual({ mode: 'unsupported', reason: expect.stringContaining('other members: bob') });
    expect(linux('ada:x:1001:ada,bob\n').mode).toBe('unsupported');
  });

  it('second passwd account with the same primary gid is refused even when it is listed nowhere in /etc/group', () => {
    const a = linux('ada:x:1001:\n', `${P}svc:x:1500:1001::/h:/bin/sh\n`);
    expect(a).toEqual({ mode: 'unsupported', reason: expect.stringContaining('other members: svc') });
    // A duplicate passwd entry for the same uid under another name also counts as another account.
    expect(linux('ada:x:1001:\n', `${P}ada2:x:1001:1001::/h:/bin/sh\n`).mode).toBe('unsupported');
  });

  it('whitespace, trailing commas and CRLF in member lists neither hide members nor invent them', () => {
    expect(linux('ada:x:1001:bob,\n').mode).toBe('unsupported');
    expect(linux('ada:x:1001: bob \n').mode).toBe('unsupported');
    expect(linux('ada:x:1001:,bob\r\n').mode).toBe('unsupported');
    expect(linux('ada:x:1001:ada , \n').mode).toBe('group');
    expect(linux('ada:x:1001:,,\r\n').mode).toBe('group');
    expect(linux('ada:x:1001:\r\n', 'ada:x:1001:1001::/h:/bin/sh\r\n').mode).toBe('group');
  });

  it('malformed lines are skipped without throwing and never turn a shared group private', () => {
    const junk = 'garbage\n::\n:x:1001:bob\nnogid:x::bob\nneg:x:-1:bob\n';
    expect(linux(`${junk}ada:x:1001:\n`, `${P}broken\n:x:1:1001\nzz:x:abc:1001\n`).mode).toBe('group');
    expect(linux(`ada:x:1001:\n${junk}alias:x:1001:carol\n`).mode).toBe('unsupported');
    // An alias with the same gid but a different first entry name stays refused.
    expect(linux('staff:x:1001:\nada:x:1001:\n').mode).toBe('unsupported');
    // Empty files: no passwd entry / no group entry.
    expect(linux('', '').mode).toBe('unsupported');
    expect(linux('').mode).toBe('unsupported');
  });
});

describe('dockerLooksRootless on odd env and context files (retest)', () => {
  const meta = (cfg: string, name: string) => `${cfg}/contexts/meta/${createHash('sha256').update(name).digest('hex')}/meta.json`;
  const reader = (files: Record<string, string>) => (p: string) => (p in files ? files[p]! : null);

  it('never throws on malformed config.json / meta.json and treats them as rootful', () => {
    const cfg = '/c';
    const bad = ['', '{', 'null', '5', '"x"', '[]', '{"currentContext":5}', '{"currentContext":{}}', '{"currentContext":""}'];
    for (const c of bad) {
      expect(dockerLooksRootless({ uid: 1001, env: { DOCKER_CONFIG: cfg }, readFile: reader({ [`${cfg}/config.json`]: c }) })).toBe(false);
    }
    const metas = ['', '{', 'null', '[]', '{"Endpoints":null}', '{"Endpoints":{"docker":null}}', '{"Endpoints":{"docker":{"Host":5}}}',
      '{"Endpoints":{"docker":"unix:///run/user/1001/docker.sock"}}'];
    for (const m of metas) {
      const files = { [`${cfg}/config.json`]: '{"currentContext":"work"}', [meta(cfg, 'work')]: m };
      expect(dockerLooksRootless({ uid: 1001, env: { DOCKER_CONFIG: cfg }, readFile: reader(files) })).toBe(false);
      // A context literally named "rootless" with an unreadable endpoint is taken as rootless.
      const rl = { [`${cfg}/config.json`]: '{"currentContext":"rootless"}', [meta(cfg, 'rootless')]: m };
      expect(dockerLooksRootless({ uid: 1001, env: { DOCKER_CONFIG: cfg }, readFile: reader(rl) })).toBe(true);
    }
    const throwing = () => { throw new Error('io'); };
    expect(() => dockerLooksRootless({ uid: 1001, env: { DOCKER_HOST: 'unix:///run/user/1001/d.sock' }, readFile: throwing })).not.toThrow();
  });

  it('odd DOCKER_HOST / XDG_RUNTIME_DIR values', () => {
    const r = (env: NodeJS.ProcessEnv) => dockerLooksRootless({ uid: 1001, env: { DOCKER_CONFIG: '/none', ...env }, readFile: () => null });
    expect(r({ DOCKER_HOST: 'unix://' })).toBe(false);
    expect(r({ DOCKER_HOST: '' })).toBe(false);
    expect(r({ DOCKER_HOST: 'ssh://me@box' })).toBe(false);
    expect(r({ DOCKER_HOST: 'unix:///run/user/10011/docker.sock' })).toBe(false); // another uid's prefix
    expect(r({ DOCKER_HOST: 'unix:///run/user/1001/docker.sock' })).toBe(true);
    expect(r({ DOCKER_HOST: 'unix:///xdg/docker.sock', XDG_RUNTIME_DIR: '/xdg///' })).toBe(true);
    expect(r({ DOCKER_HOST: 'unix:///xdgx/docker.sock', XDG_RUNTIME_DIR: '/xdg' })).toBe(false);
    expect(r({ DOCKER_HOST: 'unix:///var/run/docker.sock', XDG_RUNTIME_DIR: '' })).toBe(false);
    expect(r({ DOCKER_HOST: 'unix:///var/run/docker.sock', XDG_RUNTIME_DIR: 'relative' })).toBe(false);
  });

  it('uid 1000 and macOS: compose.yaml is byte-identical whatever the Docker env says, and nothing is read', () => {
    const never = () => { throw new Error('must not read'); };
    const base = composeYaml(project, { mode: 'owner' });
    const envs: NodeJS.ProcessEnv[] = [{}, { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, { DOCKER_CONTEXT: 'rootless' },
      { DOCKER_HOST: 'unix:///var/run/docker.sock' }, { XDG_RUNTIME_DIR: '/run/user/1000' }];
    for (const e of envs) {
      expect(composeYaml(project, probeSecretsAccess({ platform: 'linux', uid: 1000, env: e, readFile: never }))).toBe(base);
      expect(composeYaml(project, probeSecretsAccess({ platform: 'darwin', uid: 501, env: e, readFile: never }))).toBe(base);
    }
    expect(base).not.toContain('group_add');
  });
});
