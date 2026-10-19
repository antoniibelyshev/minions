import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), 'coordinator\n');
      return [];
    },
  };
});

const C = await import('../../src/host/credentials.js');
const { CONTAINER, GITHUB_TOKEN_CONTAINER_PATH, credentialStoreDir, projectPaths } = await import('../../src/core/paths.js');
const { composeYaml } = await import('../../src/host/docker.js');
const { runInit, formatInit } = await import('../../src/host/install.js');
const { runDoctor, formatDoctor } = await import('../../src/host/doctor.js');
const { runUninstall } = await import('../../src/host/uninstall.js');
const { readSecret } = await import('../../src/host/wizard.js');
const { DEFERRED_FEATURES } = await import('../../src/config/resolve.js');
const { redact } = await import('../../src/core/output.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { dockerDown, dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');
type RunResult = import('../../src/core/exec.js').RunResult;
type RunOptions = import('../../src/core/exec.js').RunOptions;

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';
const TOKEN2 = 'github_pat_22ZYXWVUT9876543210_zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQ9876543210';
const REMOTE = 'https://github.com/acme/demo.git';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

type Call = { cmd: string; args: string[]; opts?: RunOptions };
/** Fake runner; records every call so tests can assert the token never appears in argv. */
function recorder(handler: (c: Call) => RunResult | undefined = () => undefined) {
  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    const c = { cmd, args, opts };
    calls.push(c);
    return handler(c) ?? { code: 1, stdout: '', stderr: 'unavailable' };
  };
  return { calls, runner };
}

/** Fake GitHub API. */
function github(status: number, body: unknown = {}) {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, seen };
}
const okRepo = () => github(200, { full_name: 'acme/demo', permissions: { push: true } });

const mode = (p: string) => statSync(p).mode & 0o777;
function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('token format and guidance', () => {
  it('accepts fine-grained and classic tokens, rejects anything else', () => {
    expect(C.checkTokenFormat(`  ${TOKEN}\n`)).toEqual({ token: TOKEN, fineGrained: true });
    expect(C.checkTokenFormat('ghp_' + 'a'.repeat(36)).fineGrained).toBe(false);
    for (const bad of ['', 'hunter2', `${TOKEN} -w x`, `${TOKEN}"`, 'github_pat_short']) expect(() => C.checkTokenFormat(bad)).toThrow(MinionsError);
  });

  it('guidance lists every required permission and the creation link', () => {
    const g = C.githubTokenGuidance(REMOTE).join('\n');
    expect(g).toContain('https://github.com/settings/personal-access-tokens/new');
    expect(g).toContain('acme/demo');
    for (const p of ['Contents: Read and write', 'Pull requests: Read and write', 'Checks: Read-only', 'Actions: Read-only', 'Commit statuses: Read-only', 'Metadata: Read-only']) {
      expect(g).toContain(p);
    }
  });

  it('parses GitHub remotes', () => {
    expect(C.githubRepoFromRemote('git@github.com:acme/demo.git')).toEqual({ owner: 'acme', repo: 'demo' });
    expect(C.githubRepoFromRemote('https://github.com/acme/demo')).toEqual({ owner: 'acme', repo: 'demo' });
    expect(C.githubRepoFromRemote('https://gitlab.com/acme/demo.git')).toBeNull();
  });

  it('GitHub credential provisioning is no longer deferred', () => {
    expect(DEFERRED_FEATURES as readonly string[]).not.toContain('GitHub credential provisioning');
  });
});

describe('file store', () => {
  it('stores a 0600 file in 0700 dirs under the host data root; reference file holds no token', async () => {
    const repo = makeRepo(env.root);
    const { f } = okRepo();
    const r = await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, remoteUrl: REMOTE, fetch: f });
    expect(r).toMatchObject({ backend: 'file', kind: 'fine-grained-pat', verification: { status: 'ok' } });
    const file = new C.FileStore().path(ID);
    expect(file.startsWith(credentialStoreDir() + '/')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(TOKEN + '\n');
    expect(mode(file)).toBe(0o600);
    expect(mode(join(credentialStoreDir(), ID))).toBe(0o700);
    expect(mode(credentialStoreDir())).toBe(0o700);
    const refText = readFileSync(projectPaths(ID).credentialsJson, 'utf8');
    expect(refText).not.toContain(TOKEN);
    expect(JSON.parse(refText).github).toMatchObject({ backend: 'file', ref: `file:${file}` });
    expect(mode(projectPaths(ID).credentialsJson)).toBe(0o600);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    // Nothing was written into the repository.
    for (const p of allFiles(repo)) expect(readFileSync(p, 'utf8')).not.toContain(TOKEN);
    expect(await C.readGithubToken(ID)).toBe(TOKEN);
  });

  it('does not store a token GitHub rejects', async () => {
    const repo = makeRepo(env.root);
    const { f } = github(401, { message: 'Bad credentials' });
    await expect(C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, remoteUrl: REMOTE, fetch: f })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(existsSync(new C.FileStore().path(ID))).toBe(false);
    expect(existsSync(projectPaths(ID).credentialsJson)).toBe(false);
  });

  it('refuses to store credentials when the host data root is inside the repository', async () => {
    const repo = makeRepo(env.root);
    const prev = process.env.MINIONS_HOME;
    process.env.MINIONS_HOME = join(repo, '.minions-home');
    try {
      await expect(C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false })).rejects.toMatchObject({ code: 'PRECONDITION' });
      expect(existsSync(join(repo, '.minions-home'))).toBe(false);
    } finally { process.env.MINIONS_HOME = prev; }
  });

  it('remove deletes the token, reference and materialized copy', async () => {
    const repo = makeRepo(env.root);
    await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
    await C.materializeSecrets(ID);
    expect(await C.removeGithubToken(ID)).toEqual({ removed: true, backend: 'file' });
    expect(existsSync(new C.FileStore().path(ID))).toBe(false);
    expect(existsSync(projectPaths(ID).githubTokenFile)).toBe(false);
    expect((await C.loadCredentialRefs(ID)).github).toBeUndefined();
  });
});

describe('keychain store', () => {
  function fakeKeychain() {
    let stored: string | null = null;
    return recorder(({ cmd, args, opts }) => {
      if (cmd !== 'security') return undefined;
      if (args[0] === '-i') {
        const m = / -w (\S+)\n$/.exec(opts?.input ?? '');
        if (m) stored = m[1]!;
        return { code: 0, stdout: 'security> ', stderr: '' };
      }
      if (args[0] === 'find-generic-password') return stored ? { code: 0, stdout: stored + '\n', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
      if (args[0] === 'delete-generic-password') { stored = null; return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'list-keychains') return { code: 0, stdout: '"login.keychain-db"', stderr: '' };
      return undefined;
    });
  }

  it('passes the token on stdin (security -i), never in argv, and verifies by reading back', async () => {
    const { calls, runner } = fakeKeychain();
    const ks = new C.KeychainStore(runner);
    await ks.set(ID, TOKEN);
    expect(await ks.get(ID)).toBe(TOKEN);
    const add = calls.find((c) => c.args[0] === '-i')!;
    expect(add.args).toEqual(['-i']);
    expect(add.opts?.input).toBe(`add-generic-password -U -s minions.github -a ${ID} -l minions-github-token -w ${TOKEN}\n`);
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
    expect(ks.ref(ID)).toBe(`keychain:minions.github/${ID}`);
    await ks.delete(ID);
    expect(await ks.get(ID)).toBeNull();
  });

  it('fails loudly when the write did not land (locked keychain)', async () => {
    const { runner } = recorder(({ args }) => args[0] === '-i' ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: '' });
    await expect(new C.KeychainStore(runner).set(ID, TOKEN)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('selectStore: keychain on macOS when `security` works, file elsewhere, env override wins', async () => {
    const { runner } = fakeKeychain();
    expect((await C.selectStore({ runner, platform: 'darwin', env: {} })).backend).toBe('keychain');
    expect((await C.selectStore({ runner, platform: 'linux', env: {} })).backend).toBe('file');
    expect((await C.selectStore({ runner: recorder().runner, platform: 'darwin', env: {} })).backend).toBe('file');
    expect((await C.selectStore({ runner, platform: 'darwin', env: { MINIONS_CREDENTIAL_STORE: 'file' } })).backend).toBe('file');
  });

  it('provisioning via keychain records a reference and materializes from the keychain', async () => {
    const repo = makeRepo(env.root);
    const { calls, runner } = fakeKeychain();
    const r = await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false, runner, env: {}, platform: 'darwin' });
    expect(r.backend).toBe('keychain');
    expect(existsSync(new C.FileStore().path(ID))).toBe(false);
    expect(await C.materializeSecrets(ID, runner)).toEqual({ github: true, telegram: false });
    expect(readFileSync(projectPaths(ID).githubTokenFile, 'utf8')).toBe(TOKEN + '\n');
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
  });

  it('a store read failure keeps the last materialized copy (the running container keeps the token) and rethrows', async () => {
    const repo = makeRepo(env.root);
    const { runner } = fakeKeychain();
    await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false, runner, env: {}, platform: 'darwin' });
    await C.materializeSecrets(ID, runner);
    const locked = recorder(({ cmd }) => (cmd === 'security' ? { code: 51, stdout: '', stderr: 'locked' } : undefined)).runner;
    await expect(C.materializeSecrets(ID, locked)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(readFileSync(projectPaths(ID).githubTokenFile, 'utf8')).toBe(TOKEN + '\n');
    // A token that is really gone (removed from the store) still drops the copy.
    await C.materializeSecrets(ID, fakeKeychain().runner);
    expect(existsSync(projectPaths(ID).githubTokenFile)).toBe(false);
  });

  const TG = '123456789:AAHfakefakefakefakefakefakefake_-0123';
  const TG2 = '123456789:AAHrotatedrotatedrotatedrotated_-9876';
  const lockedKeychain = () => recorder(({ cmd }) => (cmd === 'security' ? { code: 51, stdout: '', stderr: 'locked' } : undefined)).runner;

  it('one kind failing to read does not stop the other kind: it is still refreshed, the failing copy is kept, then the error is rethrown', async () => {
    const repo = makeRepo(env.root);
    const { runner } = fakeKeychain();
    const p = projectPaths(ID);
    await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false, runner, env: {}, platform: 'darwin' });
    await C.provisionTelegramToken({ projectId: ID, token: TG, repoPath: repo, runner, env: {}, platform: 'linux' });
    expect(await C.materializeSecrets(ID, runner)).toEqual({ github: true, telegram: true });
    // Rotate the file-stored telegram token, then lock the keychain that holds the github token.
    await C.provisionTelegramToken({ projectId: ID, token: TG2, repoPath: repo, runner, env: {}, platform: 'linux' });
    await expect(C.materializeSecrets(ID, lockedKeychain())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(readFileSync(p.githubTokenFile, 'utf8')).toBe(TOKEN + '\n');
    expect(readFileSync(p.telegramTokenFile, 'utf8')).toBe(TG2 + '\n');
    expect(mode(p.githubTokenFile)).toBe(0o600);
    expect(mode(p.telegramTokenFile)).toBe(0o600);
    // A kind that is really absent is still removed while the other kind fails to read.
    await C.removeTelegramToken(ID, runner);
    await expect(C.materializeSecrets(ID, lockedKeychain())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(existsSync(p.telegramTokenFile)).toBe(false);
    expect(readFileSync(p.githubTokenFile, 'utf8')).toBe(TOKEN + '\n');
    expect(readdirSync(p.secretsDir)).toEqual(['github-token']);
  });

  it('a read failure on the later kind (telegram) keeps its copy after the earlier kind (github) is written', async () => {
    const repo = makeRepo(env.root);
    const { runner } = fakeKeychain();
    const p = projectPaths(ID);
    await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false, runner, env: {}, platform: 'linux' });
    await C.provisionTelegramToken({ projectId: ID, token: TG, repoPath: repo, runner, env: {}, platform: 'darwin' });
    await C.materializeSecrets(ID, runner);
    await C.provisionGithubToken({ projectId: ID, token: TOKEN2, repoPath: repo, verify: false, runner, env: {}, platform: 'linux' });
    await expect(C.materializeSecrets(ID, lockedKeychain())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(readFileSync(p.githubTokenFile, 'utf8')).toBe(TOKEN2 + '\n');
    expect(readFileSync(p.telegramTokenFile, 'utf8')).toBe(TG + '\n');
  });
});

describe('container mount', () => {
  it('mounts the secrets directory read-only at a fixed path; never the credential store or a single file', () => {
    const y = composeYaml({
      version: 1, projectId: ID, repoPath: '/Users/x/repo', gitCommonDir: '/Users/x/repo/.git', visibility: 'private',
      profile: 'personal-work', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: REMOTE,
      gitIdentity: { name: 'Ada', email: 'ada@example.com' },
      container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet' },
    });
    expect(GITHUB_TOKEN_CONTAINER_PATH).toBe('/opt/minions/secrets/github-token');
    expect(GITHUB_TOKEN_CONTAINER_PATH.startsWith(CONTAINER.secretsDir + '/')).toBe(true);
    const p = projectPaths(ID);
    expect(y).toContain(`- type: bind\n        source: "${p.secretsDir}"\n        target: "/opt/minions/secrets"\n        read_only: true\n`);
    expect(y).not.toContain(credentialStoreDir());
    expect(y).not.toContain(p.githubTokenFile);
    expect(y).not.toContain(p.credentialsJson);
    expect(y).not.toMatch(/keychain/i);
    expect(y).not.toContain('secrets:\n  '); // no compose top-level single-file secrets
  });

  it('token updates replace the file atomically (new inode) and stay visible through the directory path', async () => {
    const repo = makeRepo(env.root);
    await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
    const p = projectPaths(ID);
    expect(await C.materializeSecrets(ID)).toEqual({ github: true, telegram: false });
    expect(mode(p.secretsDir)).toBe(0o700);
    expect(mode(p.githubTokenFile)).toBe(0o600);
    const ino = statSync(p.githubTokenFile).ino;
    await C.provisionGithubToken({ projectId: ID, token: TOKEN2, repoPath: repo, verify: false });
    await C.materializeSecrets(ID);
    expect(statSync(p.githubTokenFile).ino).not.toBe(ino); // a single-file bind mount would go stale here
    expect(readFileSync(p.githubTokenFile, 'utf8')).toBe(TOKEN2 + '\n');
    expect(readdirSync(p.secretsDir)).toEqual(['github-token']); // no temp files left behind
    await C.clearSecrets(ID);
    expect(existsSync(p.githubTokenFile)).toBe(false);
    expect(existsSync(p.secretsDir)).toBe(true); // the mount source stays
  });

  it('materialize without a provisioned token leaves an empty secrets dir', async () => {
    expect(await C.materializeSecrets(ID)).toEqual({ github: false, telegram: false });
    expect(readdirSync(projectPaths(ID).secretsDir)).toEqual([]);
  });
});

describe('verification and redaction', () => {
  it('sends the token only in the Authorization header to the repository endpoint', async () => {
    const { f, seen } = okRepo();
    expect(await C.verifyGithubToken(TOKEN, { remoteUrl: REMOTE, fetch: f })).toEqual({ status: 'ok', detail: 'access to acme/demo' });
    expect(seen).toEqual([{ url: 'https://api.github.com/repos/acme/demo', auth: `Bearer ${TOKEN}` }]);
  });

  it('maps statuses: 401/404 invalid, network error unverified (redacted)', async () => {
    expect((await C.verifyGithubToken(TOKEN, { remoteUrl: REMOTE, fetch: github(401).f })).status).toBe('invalid');
    expect((await C.verifyGithubToken(TOKEN, { remoteUrl: REMOTE, fetch: github(404).f })).detail).toMatch(/cannot access acme\/demo/);
    const boom = (async () => { throw new Error(`connect failed for ${TOKEN}`); }) as unknown as typeof fetch;
    const v = await C.verifyGithubToken(TOKEN, { remoteUrl: REMOTE, fetch: boom });
    expect(v.status).toBe('unverified');
    expect(v.detail).not.toContain(TOKEN);
    expect(v.detail).toContain('github_pat_[REDACTED]');
    const ro = await C.verifyGithubToken(TOKEN, { remoteUrl: REMOTE, fetch: github(200, { full_name: 'acme/demo', permissions: { push: false } }).f });
    expect(ro.detail).toMatch(/read-only/);
  });

  it('core redact masks the token formats', () => {
    expect(redact(`x ${TOKEN} y`)).toBe('x github_pat_[REDACTED] y');
    expect(redact('ghp_' + 'a'.repeat(36))).toBe('gh*_[REDACTED]');
  });

  it('credential status: missing, ok, invalid, insecure file mode', async () => {
    const repo = makeRepo(env.root);
    const proj = { projectId: ID, remoteUrl: REMOTE };
    expect((await C.githubCredentialStatus(proj, { fetch: okRepo().f })).state).toBe('missing');
    await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
    expect(await C.githubCredentialStatus(proj, { fetch: okRepo().f })).toMatchObject({ state: 'ok', backend: 'file' });
    const bad = await C.githubCredentialStatus(proj, { fetch: github(401).f });
    expect(bad.state).toBe('invalid');
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
    const { chmodSync } = await import('node:fs');
    chmodSync(new C.FileStore().path(ID), 0o644);
    expect(await C.githubCredentialStatus(proj, { fetch: okRepo().f })).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/mode is 644/) });
  });
});

describe('non-echoing prompt', () => {
  function tty() {
    const s = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (b: boolean) => unknown };
    s.isTTY = true; s.isRaw = false;
    const modes: boolean[] = [];
    s.setRawMode = (b: boolean) => { modes.push(b); s.isRaw = b; return s; };
    let out = '';
    const output = { write: (c: string | Uint8Array) => { out += String(c); return true; } };
    return { s, modes, output, out: () => out };
  }

  it('reads the token in raw mode and echoes nothing of it', async () => {
    const t = tty();
    const p = readSecret('Token: ', t.s as unknown as NodeJS.ReadStream, t.output);
    t.s.write('\x1b[200~' + TOKEN + 'x\x1b[201~');
    t.s.write('\x7f'); // backspace removes the stray "x"
    t.s.write('\r');
    expect(await p).toBe(TOKEN);
    expect(t.out()).toBe('Token: \n');
    expect(t.modes).toEqual([true, false]);
  });

  it('Ctrl-C cancels; a non-TTY input is refused', async () => {
    const t = tty();
    const p = readSecret('Token: ', t.s as unknown as NodeJS.ReadStream, t.output);
    t.s.write('abc\x03');
    await expect(p).rejects.toMatchObject({ code: 'PRECONDITION' });
    const pipe = new PassThrough() as unknown as NodeJS.ReadStream;
    await expect(readSecret('Token: ', pipe, t.output)).rejects.toMatchObject({ code: 'PRECONDITION' });
  });
});

describe('init and doctor integration', () => {
  const answering = (secrets: string[], store = 'y') => {
    const asked: string[] = [];
    const info: string[] = [];
    return {
      asked, info,
      io: {
        ask: async (q: string, def: string) => { asked.push(q); return q.startsWith('Store a GitHub token') ? store : def; },
        info: (l: string) => info.push(l),
        secret: async (prompt: string) => { asked.push(`secret:${prompt}`); return secrets.shift() ?? ''; },
      },
    };
  };

  it('interactive init on a GitHub repo prints guidance and stores the token via the secret prompt', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', REMOTE);
    const a = answering([TOKEN]);
    const r = await runInit({ path: repo, yes: false, visibility: 'private', io: a.io, dockerProbe: dockerUp, fetch: okRepo().f });
    expect(r.github).toMatchObject({ status: 'stored', provisioned: { backend: 'file' } });
    expect(a.asked).toContain('secret:GitHub token (input hidden): ');
    expect(a.info.join('\n')).toContain('Pull requests: Read and write');
    expect(await C.readGithubToken(r.plan.projectId)).toBe(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(formatInit(r)).not.toContain(TOKEN);
    expect(r.plan.externalSetup.join('\n')).toContain('Contents: Read and write');
    expect(existsSync(projectPaths(r.plan.projectId).secretsDir)).toBe(true);
    // Neither the repo nor generated (tracked/manifest) files contain the token.
    for (const p of [...allFiles(repo), ...allFiles(projectPaths(r.plan.projectId).pluginDir), projectPaths(r.plan.projectId).composeYaml,
      projectPaths(r.plan.projectId).projectJson, projectPaths(r.plan.projectId).configJson, projectPaths(r.plan.projectId).runtimeConfigJson]) {
      expect(readFileSync(p, 'utf8'), p).not.toContain(TOKEN);
    }

    // doctor: ok, without printing the token.
    const doc = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner, fetch: okRepo().f });
    const gh = doc.checks.find((c) => c.name === 'github.credential')!;
    expect(gh).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^ok: access to acme\/demo/) });
    expect(JSON.stringify(doc) + formatDoctor(doc)).not.toContain(TOKEN);
    expect(doc.checks.find((c) => c.name === 'features')!.detail).not.toMatch(/credential/);

    // doctor: invalid
    const inv = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner, fetch: github(401).f });
    expect(inv.checks.find((c) => c.name === 'github.credential')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^invalid:/) });
    expect(JSON.stringify(inv) + formatDoctor(inv)).not.toContain(TOKEN);

    // uninstall keeps the credential, removes the materialized copy.
    await C.materializeSecrets(r.plan.projectId);
    const u = await runUninstall({ cwd: repo, runner: recorder().runner });
    expect(u.kept.some((k) => k.reason.includes('GitHub token kept'))).toBe(true);
    expect(existsSync(projectPaths(r.plan.projectId).githubTokenFile)).toBe(false);
    expect(existsSync(new C.FileStore().path(r.plan.projectId))).toBe(true);
  });

  it('declining the offer stores nothing; doctor reports missing', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', REMOTE);
    const a = answering([], 'n');
    const r = await runInit({ path: repo, yes: false, visibility: 'private', io: a.io, dockerProbe: dockerUp, fetch: okRepo().f });
    expect(r.github?.status).toBe('skipped');
    expect(a.asked.some((q) => q.startsWith('secret:'))).toBe(false);
    expect(r.nextSteps.join('\n')).toContain('minions auth github');
    const doc = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner, fetch: okRepo().f });
    expect(doc.checks.find((c) => c.name === 'github.credential')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^missing:/) });
  });

  it('non-interactive init never prompts; repos without a GitHub remote are not offered a token', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    expect(r.github).toBeUndefined();
    expect(r.plan.externalSetup.join('\n')).not.toContain('personal-access-tokens');
    const doc = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner, fetch: okRepo().f });
    expect(doc.checks.find((c) => c.name === 'github.credential')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^missing: not needed/) });
  });
});

describe('security edge cases (tester)', () => {
  const PREFIX = 'github_pat_11ABCDEFG0123456789_abcdefghij';
  const hostile = [
    `${PREFIX}\nadd-generic-password -s evil -w x`,
    `${PREFIX} -w other`,
    `${PREFIX}"; rm -rf /`,
    `${PREFIX}'`,
    `${PREFIX}\\`,
    `${PREFIX};x`,
    `${PREFIX}$(id)`,
    `${PREFIX}\`id\``,
    `${PREFIX}\r\nfoo`,
    `${PREFIX}\u0000`,
  ];

  it('security -i is never invoked for tokens with whitespace, quotes or metacharacters', async () => {
    const { calls, runner } = recorder();
    const ks = new C.KeychainStore(runner);
    for (const t of hostile) {
      expect(() => C.checkTokenFormat(t)).toThrow();
      await expect(ks.set(ID, t)).rejects.toBeInstanceOf(MinionsError);
    }
    expect(calls).toEqual([]);
  });

  it('security -i is never invoked with a non-UUID project id', async () => {
    const { calls, runner } = recorder();
    for (const id of ['x -w y', `${ID}\nfoo`, '../../etc', `${ID} `]) {
      await expect(new C.KeychainStore(runner).set(id, TOKEN)).rejects.toBeInstanceOf(MinionsError);
      await expect(new C.FileStore().set(id, TOKEN)).rejects.toBeInstanceOf(MinionsError);
    }
    expect(calls).toEqual([]);
  });

  it('surrounding whitespace/newlines are trimmed (stdin-style input)', () => {
    expect(C.checkTokenFormat(`  ${TOKEN}\r\n`).token).toBe(TOKEN);
    expect(C.checkTokenFormat(`${TOKEN}\n\n`).token).toBe(TOKEN);
  });

  it('format errors do not echo the rejected input', () => {
    try { C.checkTokenFormat('hunter2-secret-value'); expect.unreachable(); } catch (e) {
      expect(JSON.stringify(e) + (e as Error).message + ((e as { hint?: string }).hint ?? '')).not.toContain('hunter2');
    }
  });

  it('file permissions hold under a permissive umask and leave no temp files', async () => {
    const repo = makeRepo(env.root);
    const old = process.umask(0o000);
    try {
      await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
      await C.provisionGithubToken({ projectId: ID, token: TOKEN2, repoPath: repo, verify: false });
      await C.materializeSecrets(ID);
    } finally { process.umask(old); }
    expect(mode(new C.FileStore().path(ID))).toBe(0o600);
    expect(mode(join(credentialStoreDir(), ID))).toBe(0o700);
    expect(mode(projectPaths(ID).githubTokenFile)).toBe(0o600);
    expect(mode(projectPaths(ID).secretsDir)).toBe(0o700);
    expect(mode(projectPaths(ID).credentialsJson)).toBe(0o600);
    for (const dir of [join(credentialStoreDir(), ID), projectPaths(ID).secretsDir]) {
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }
    expect(readFileSync(projectPaths(ID).githubTokenFile, 'utf8')).toBe(TOKEN2 + '\n');
  });

  it('a network error that echoes the token is redacted; Authorization header is not in results', async () => {
    const f = (async (_u: unknown, init?: RequestInit) => {
      throw new Error(`connect failed, headers: Authorization: Bearer ${new Headers(init?.headers).get('authorization')?.slice(7)}`);
    }) as unknown as typeof fetch;
    const v = await C.verifyGithubToken(TOKEN, { remoteUrl: REMOTE, fetch: f });
    expect(v.status).toBe('unverified');
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect(JSON.stringify(v)).not.toContain('11ABCDEFG0123456789_abcdefghij');
  });

  it('HTTP error bodies echoing the token never reach the result', async () => {
    for (const status of [401, 403, 404, 500]) {
      const v = await C.verifyGithubToken(TOKEN, { remoteUrl: REMOTE, fetch: github(status, { message: `bad ${TOKEN}` }).f });
      expect(JSON.stringify(v)).not.toContain(TOKEN);
    }
  });

  it('unverified status is reported for network failure and 5xx; token never in status', async () => {
    const repo = makeRepo(env.root);
    await C.provisionGithubToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: false });
    const proj = { projectId: ID, remoteUrl: REMOTE };
    const s5 = await C.githubCredentialStatus(proj, { fetch: github(503).f });
    expect(s5.state).toBe('unverified');
    const net = await C.githubCredentialStatus(proj, { fetch: (async () => { throw new Error(`boom ${TOKEN}`); }) as unknown as typeof fetch });
    expect(net.state).toBe('unverified');
    expect(JSON.stringify([s5, net])).not.toContain(TOKEN);
  });

  it('removing when nothing is provisioned is a no-op', async () => {
    expect(await C.removeGithubToken(ID)).toEqual({ removed: false, backend: null });
  });
});

describe('doctor ci.requiredChecks (read-only, mocked GitHub API)', () => {
  const io = { ask: async (q: string, def: string) => (q.startsWith('Store a GitHub token') ? 'y' : def), info: () => {}, secret: async () => TOKEN };
  /** Route-aware fake api.github.com; records method and path of every request. */
  function api(routes: Record<string, [number, unknown]>) {
    const seen: { method: string; path: string }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      seen.push({ method: init?.method ?? 'GET', path: u.pathname + u.search });
      const [status, body] = routes[u.pathname + u.search] ?? (u.pathname === '/repos/acme/demo' || u.pathname === '/user' ? [200, { full_name: 'acme/demo', login: 'ada', permissions: { push: true } }] : [404, { message: 'Not Found' }]);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { f, seen };
  }

  it('host fallback reports required checks, only issues GETs, and never prints the token', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', REMOTE);
    await runInit({ path: repo, yes: false, visibility: 'private', io, dockerProbe: dockerUp, fetch: okRepo().f });
    const ok = api({
      '/repos/acme/demo/branches/main': [200, { protected: true, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['build'] } } }],
      '/repos/acme/demo/rules/branches/main': [200, []],
      '/repos/acme/demo/actions/workflows?per_page=1': [200, { total_count: 1 }],
    });
    const doc = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner, fetch: ok.f });
    expect(doc.checks.find((c) => c.name === 'ci.requiredChecks')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/required checks on main: build; delivery.requiredChecksConfigured false/) });
    expect(ok.seen.every((s) => s.method === 'GET')).toBe(true);
    expect(ok.seen.map((s) => s.path)).toContain('/repos/acme/demo/branches/main');
    expect(JSON.stringify(doc) + formatDoctor(doc)).not.toContain(TOKEN);

    const none = api({ '/repos/acme/demo/branches/main': [200, { protected: false }], '/repos/acme/demo/rules/branches/main': [200, []], '/repos/acme/demo/actions/workflows?per_page=1': [200, { total_count: 0 }] });
    const d2 = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner, fetch: none.f });
    const c2 = d2.checks.find((c) => c.name === 'ci.requiredChecks')!;
    expect(c2).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/no required status checks on main and no CI workflows: usable for local work and pull-request delivery; automatic merge unavailable/) });
    expect(formatDoctor(d2)).toMatch(/Add a CI workflow yourself/);
    expect(d2.healthy === doc.healthy).toBe(true); // no CI never makes doctor unhealthy
    expect(none.seen.every((s) => s.method === 'GET')).toBe(true);
  });

  it('uses `minions ci status --json` in a running container', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', REMOTE);
    await runInit({ path: repo, yes: false, visibility: 'private', io, dockerProbe: dockerUp, fetch: okRepo().f });
    const rc = { repository: 'acme/demo', baseBranch: 'main', state: 'configured', requiredChecks: ['ci/test'], protection: null, rulesets: { contexts: ['ci/test'] }, workflows: 3, errors: [] };
    const rec = recorder((c) => {
      const a = c.args.join(' ');
      if (c.cmd !== 'docker') return undefined;
      if (a.startsWith('image inspect')) return { code: 0, stdout: 'x\n', stderr: '' };
      if (a.includes(' ps --status running')) return { code: 0, stdout: 'abc\n', stderr: '' };
      if (a.endsWith('ci status --json')) return { code: 0, stdout: JSON.stringify({ ok: true, data: { repository: 'acme/demo', requiredChecks: rc, requiredChecksConfigured: false, setupPlan: [] } }), stderr: '' };
      return undefined;
    });
    const ok = api({});
    const doc = await runDoctor({ cwd: repo, probe: dockerUp, runner: rec.runner, fetch: ok.f });
    expect(doc.checks.find((c) => c.name === 'ci.requiredChecks')).toMatchObject({ status: 'ok', detail: expect.stringContaining('ci/test') });
    expect(rec.calls.some((c) => c.args.join(' ').endsWith('minions ci status --json'))).toBe(true);
    expect(ok.seen.some((s) => s.path.includes('/branches/'))).toBe(false); // no host fallback needed
  });
});
