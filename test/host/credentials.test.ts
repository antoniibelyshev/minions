import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));

// Secrets modes under the default (owner) access, whoever runs the suite: see pin-secrets-access.ts.
vi.mock('../../src/host/secrets-access.js', async (orig) => (await import('./pin-secrets-access.js')).pinOwnerAccess(await orig()));
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
const { CONTAINER, credentialStoreDir, projectPaths } = await import('../../src/core/paths.js');
const { composeYaml } = await import('../../src/host/docker.js');
const { runInit } = await import('../../src/host/install.js');
const { readSecret } = await import('../../src/host/wizard.js');
const { redact } = await import('../../src/core/output.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { makeRepo, withHome } = await import('./fixtures.js');
type RunResult = import('../../src/core/exec.js').RunResult;
type RunOptions = import('../../src/core/exec.js').RunOptions;

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const TOKEN = 'sk-proj-11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';
const TOKEN2 = 'sk-proj-22ZYXWVUT9876543210_zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQ9876543210';
const REMOTE = '/srv/git/acme/demo.git';

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

const mode = (p: string) => statSync(p).mode & 0o777;
function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('file store', () => {
  it('stores a 0600 file in 0700 dirs under the host data root; reference file holds no token', async () => {
    const repo = makeRepo(env.root);
    const r = await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo });
    expect(r).toMatchObject({ backend: 'file' });
    const file = new C.FileStore(C.CODEX_CREDENTIAL).path(ID);
    expect(file.startsWith(credentialStoreDir() + '/')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(TOKEN + '\n');
    expect(mode(file)).toBe(0o600);
    expect(mode(join(credentialStoreDir(), ID))).toBe(0o700);
    expect(mode(credentialStoreDir())).toBe(0o700);
    const refText = readFileSync(projectPaths(ID).credentialsJson, 'utf8');
    expect(refText).not.toContain(TOKEN);
    expect(JSON.parse(refText).codex).toMatchObject({ backend: 'file', ref: `file:${file}` });
    expect(mode(projectPaths(ID).credentialsJson)).toBe(0o600);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    // Nothing was written into the repository.
    for (const p of allFiles(repo)) expect(readFileSync(p, 'utf8')).not.toContain(TOKEN);
    expect(await C.readCodexKey(ID)).toBe(TOKEN);
  });

  it('refuses to store credentials when the host data root is inside the repository', async () => {
    const repo = makeRepo(env.root);
    const prev = process.env.MINIONS_HOME;
    process.env.MINIONS_HOME = join(repo, '.minions-home');
    try {
      await expect(C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo })).rejects.toMatchObject({ code: 'PRECONDITION' });
      expect(existsSync(join(repo, '.minions-home'))).toBe(false);
    } finally { process.env.MINIONS_HOME = prev; }
  });

  it('remove deletes the token, reference and materialized copy', async () => {
    const repo = makeRepo(env.root);
    await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo });
    await C.materializeSecrets(ID);
    expect(await C.removeCodexKey(ID)).toEqual({ removed: true, backend: 'file' });
    expect(existsSync(new C.FileStore(C.CODEX_CREDENTIAL).path(ID))).toBe(false);
    expect(existsSync(projectPaths(ID).codexKeyFile)).toBe(false);
    expect((await C.loadCredentialRefs(ID)).codex).toBeUndefined();
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
    const ks = new C.KeychainStore(runner, C.CODEX_CREDENTIAL);
    await ks.set(ID, TOKEN);
    expect(await ks.get(ID)).toBe(TOKEN);
    const add = calls.find((c) => c.args[0] === '-i')!;
    expect(add.args).toEqual(['-i']);
    expect(add.opts?.input).toBe(`add-generic-password -U -s minions.codex -a ${ID} -l minions-codex-api-key -w ${TOKEN}\n`);
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
    expect(ks.ref(ID)).toBe(`keychain:minions.codex/${ID}`);
    await ks.delete(ID);
    expect(await ks.get(ID)).toBeNull();
  });

  it('fails loudly when the write did not land (locked keychain)', async () => {
    const { runner } = recorder(({ args }) => args[0] === '-i' ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: '' });
    await expect(new C.KeychainStore(runner, C.CODEX_CREDENTIAL).set(ID, TOKEN)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('selectStore: keychain on macOS when `security` works, file elsewhere, env override wins', async () => {
    const { runner } = fakeKeychain();
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'darwin', env: {} })).backend).toBe('keychain');
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'linux', env: {} })).backend).toBe('file');
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner: recorder().runner, platform: 'darwin', env: {} })).backend).toBe('file');
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'darwin', env: { MINIONS_CREDENTIAL_STORE: 'file' } })).backend).toBe('file');
  });

  it('provisioning via keychain records a reference and materializes from the keychain', async () => {
    const repo = makeRepo(env.root);
    const { calls, runner } = fakeKeychain();
    const r = await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo, runner, env: {}, platform: 'darwin' });
    expect(r.backend).toBe('keychain');
    expect(existsSync(new C.FileStore(C.CODEX_CREDENTIAL).path(ID))).toBe(false);
    expect(await C.materializeSecrets(ID, runner)).toEqual({ telegram: false, codex: true, claude: false });
    expect(readFileSync(projectPaths(ID).codexKeyFile, 'utf8')).toBe(TOKEN + '\n');
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
  });

  it('a store read failure keeps the last materialized copy (the running container keeps the token) and rethrows', async () => {
    const repo = makeRepo(env.root);
    const { runner } = fakeKeychain();
    await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo, runner, env: {}, platform: 'darwin' });
    await C.materializeSecrets(ID, runner);
    const locked = recorder(({ cmd }) => (cmd === 'security' ? { code: 51, stdout: '', stderr: 'locked' } : undefined)).runner;
    await expect(C.materializeSecrets(ID, locked)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(readFileSync(projectPaths(ID).codexKeyFile, 'utf8')).toBe(TOKEN + '\n');
    // A token that is really gone (removed from the store) still drops the copy.
    await C.materializeSecrets(ID, fakeKeychain().runner);
    expect(existsSync(projectPaths(ID).codexKeyFile)).toBe(false);
  });

  const TG = '123456789:AAHfakefakefakefakefakefakefake_-0123';
  const TG2 = '123456789:AAHrotatedrotatedrotatedrotated_-9876';
  const lockedKeychain = () => recorder(({ cmd }) => (cmd === 'security' ? { code: 51, stdout: '', stderr: 'locked' } : undefined)).runner;

  it('one kind failing to read does not stop the other kind: it is still refreshed, the failing copy is kept, then the error is rethrown', async () => {
    const repo = makeRepo(env.root);
    const { runner } = fakeKeychain();
    const p = projectPaths(ID);
    await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo, runner, env: {}, platform: 'darwin' });
    await C.provisionTelegramToken({ projectId: ID, token: TG, repoPath: repo, runner, env: {}, platform: 'linux' });
    expect(await C.materializeSecrets(ID, runner)).toEqual({ telegram: true, codex: true, claude: false });
    // Rotate the file-stored telegram token, then lock the keychain that holds the Codex key.
    await C.provisionTelegramToken({ projectId: ID, token: TG2, repoPath: repo, runner, env: {}, platform: 'linux' });
    await expect(C.materializeSecrets(ID, lockedKeychain())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(readFileSync(p.codexKeyFile, 'utf8')).toBe(TOKEN + '\n');
    expect(readFileSync(p.telegramTokenFile, 'utf8')).toBe(TG2 + '\n');
    expect(mode(p.codexKeyFile)).toBe(0o600);
    expect(mode(p.telegramTokenFile)).toBe(0o600);
    // A kind that is really absent is still removed while the other kind fails to read.
    await C.removeTelegramToken(ID, runner);
    await expect(C.materializeSecrets(ID, lockedKeychain())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(existsSync(p.telegramTokenFile)).toBe(false);
    expect(readFileSync(p.codexKeyFile, 'utf8')).toBe(TOKEN + '\n');
    expect(readdirSync(p.secretsDir)).toEqual(['codex-api-key']);
  });

  it('a read failure on one kind (telegram) keeps its copy while the other kind (codex) is refreshed', async () => {
    const repo = makeRepo(env.root);
    const { runner } = fakeKeychain();
    const p = projectPaths(ID);
    await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo, runner, env: {}, platform: 'linux' });
    await C.provisionTelegramToken({ projectId: ID, token: TG, repoPath: repo, runner, env: {}, platform: 'darwin' });
    await C.materializeSecrets(ID, runner);
    await C.provisionCodexKey({ projectId: ID, token: TOKEN2, repoPath: repo, runner, env: {}, platform: 'linux' });
    await expect(C.materializeSecrets(ID, lockedKeychain())).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(readFileSync(p.codexKeyFile, 'utf8')).toBe(TOKEN2 + '\n');
    expect(readFileSync(p.telegramTokenFile, 'utf8')).toBe(TG + '\n');
  });
});

describe('secret service store (Linux, secret-tool)', () => {
  const DBUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' };
  /** Fake libsecret: items keyed by "service/account"; lookup exits 1 with empty stderr when absent. */
  function fakeSecretTool(opts: { broken?: string } = {}) {
    const items = new Map<string, string>();
    const key = (a: string[]) => `${a[a.indexOf('service') + 1]}/${a[a.indexOf('account') + 1]}`;
    const rec = recorder(({ cmd, args, opts: o }) => {
      if (cmd !== 'secret-tool') return undefined;
      if (opts.broken) return { code: 1, stdout: '', stderr: opts.broken };
      if (args[0] === 'store') { items.set(key(args), o?.input ?? ''); return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'lookup') { const v = items.get(key(args)); return v === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: v, stderr: '' }; }
      if (args[0] === 'clear') { items.delete(key(args)); return { code: 0, stdout: '', stderr: '' }; }
      return undefined;
    });
    return { ...rec, items };
  }

  it('passes the token on stdin (secret-tool store), never in argv, and verifies by reading back', async () => {
    const { calls, runner, items } = fakeSecretTool();
    const ss = new C.SecretServiceStore(runner, C.CODEX_CREDENTIAL);
    await ss.set(ID, TOKEN);
    expect(await ss.get(ID)).toBe(TOKEN);
    const store = calls.find((c) => c.args[0] === 'store')!;
    expect(store.args).toEqual(['store', '--label=minions-codex-api-key', 'service', 'minions.codex', 'account', ID]);
    expect(store.opts?.input).toBe(TOKEN);
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
    expect(ss.ref(ID)).toBe(`secret-service:minions.codex/${ID}`);
    await ss.delete(ID);
    expect(await ss.get(ID)).toBeNull();
    expect(items.size).toBe(0);
  });

  it('a locked or unreachable keyring is an error, not a missing token; a failed store fails loudly', async () => {
    const { runner } = fakeSecretTool({ broken: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' });
    await expect(new C.SecretServiceStore(runner, C.CODEX_CREDENTIAL).get(ID)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(new C.SecretServiceStore(runner, C.CODEX_CREDENTIAL).set(ID, TOKEN)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('selectStore: Secret Service on Linux when secret-tool reaches one, else the 0600 file; macOS unchanged', async () => {
    const { runner } = fakeSecretTool();
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'linux', env: DBUS, hostRuntime: false })).backend).toBe('secret-service');
    // No session bus (headless/SSH): no probe at all, file store.
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'linux', env: {}, hostRuntime: false })).backend).toBe('file');
    // secret-tool missing or no provider: file store.
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner: recorder().runner, platform: 'linux', env: DBUS, hostRuntime: false })).backend).toBe('file');
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner: fakeSecretTool({ broken: 'No such interface org.freedesktop.Secret.Service' }).runner, platform: 'linux', env: DBUS, hostRuntime: false })).backend).toBe('file');
    // macOS never probes secret-tool.
    const mac = fakeSecretTool();
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner: mac.runner, platform: 'darwin', env: DBUS, hostRuntime: false })).backend).toBe('file');
    expect(mac.calls.some((c) => c.cmd === 'secret-tool')).toBe(false);
    // Overrides: file always wins; secret-service forced; host runtime forces the file store.
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'linux', env: { ...DBUS, MINIONS_CREDENTIAL_STORE: 'file' }, hostRuntime: false })).backend).toBe('file');
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'darwin', env: { MINIONS_CREDENTIAL_STORE: 'secret-service' }, hostRuntime: false })).backend).toBe('secret-service');
    expect((await C.selectStore({ kind: C.CODEX_CREDENTIAL, runner, platform: 'linux', env: DBUS, hostRuntime: true })).backend).toBe('file');
  });

  it('provisioning records a secret-service reference, materializes a 0600 copy, and removal clears the keyring item', async () => {
    const repo = makeRepo(env.root);
    const { calls, runner, items } = fakeSecretTool();
    const r = await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo, runner, env: DBUS, platform: 'linux' });
    expect(r.backend).toBe('secret-service');
    expect(C.backendLabel(r.backend)).toBe('the Secret Service keyring (secret-tool)');
    expect(existsSync(new C.FileStore(C.CODEX_CREDENTIAL).path(ID))).toBe(false);
    expect((await C.loadCredentialRefs(ID)).codex).toMatchObject({ backend: 'secret-service', ref: `secret-service:minions.codex/${ID}` });
    expect(await C.materializeSecrets(ID, runner)).toEqual({ telegram: false, codex: true, claude: false });
    expect(readFileSync(projectPaths(ID).codexKeyFile, 'utf8')).toBe(TOKEN + '\n');
    expect(mode(projectPaths(ID).codexKeyFile)).toBe(0o600);
    expect((await C.codexCredentialStatus(ID, { runner })).detail).toContain('Secret Service keyring');
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
    await C.removeCodexKey(ID, runner);
    expect(items.size).toBe(0);
  });

  it('switching to the file store deletes the keyring copy', async () => {
    const repo = makeRepo(env.root);
    const { runner, items } = fakeSecretTool();
    await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo, runner, env: DBUS, platform: 'linux' });
    expect(items.size).toBe(1);
    await C.provisionCodexKey({ projectId: ID, token: TOKEN2, repoPath: repo, runner, env: {}, platform: 'linux' });
    expect(items.size).toBe(0);
    expect((await C.loadCredentialRefs(ID)).codex?.backend).toBe('file');
    expect(await C.readCodexKey(ID, runner)).toBe(TOKEN2);
  });
  it('host runtime: moveKeychainTokensToFileStore also moves Secret Service tokens to the 0600 file store', async () => {
    const repo = makeRepo(env.root);
    const { runner, items } = fakeSecretTool();
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: async () => ({ daemon: true, serverVersion: '1', compose: true, composeVersion: '2.29.1' }) });
    const pid = r.plan.projectId;
    await C.provisionCodexKey({ projectId: pid, token: TOKEN, repoPath: repo, runner, env: DBUS, platform: 'linux', hostRuntime: false });
    expect((await C.loadCredentialRefs(pid)).codex?.backend).toBe('secret-service');
    const moved = await C.moveKeychainTokensToFileStore(runner);
    expect(moved).toEqual({ moved: [{ projectId: pid, kind: 'codex' }], warnings: [] });
    expect((await C.loadCredentialRefs(pid)).codex?.backend).toBe('file');
    expect(items.size).toBe(0);
    expect(mode(new C.FileStore(C.CODEX_CREDENTIAL).path(pid))).toBe(0o600);
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
    expect(CONTAINER.codexKeyFile).toBe('/opt/minions/secrets/codex-api-key');
    const p = projectPaths(ID);
    expect(y).toContain(`- type: bind\n        source: "${p.secretsDir}"\n        target: "/opt/minions/secrets"\n        read_only: true\n`);
    expect(y).not.toContain(credentialStoreDir());
    expect(y).not.toContain(p.codexKeyFile);
    expect(y).not.toContain(p.credentialsJson);
    expect(y).not.toMatch(/keychain/i);
    expect(y).not.toContain('secrets:\n  '); // no compose top-level single-file secrets
  });

  it('token updates replace the file atomically (new inode) and stay visible through the directory path', async () => {
    const repo = makeRepo(env.root);
    await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo });
    const p = projectPaths(ID);
    expect(await C.materializeSecrets(ID)).toEqual({ telegram: false, codex: true, claude: false });
    expect(mode(p.secretsDir)).toBe(0o700);
    expect(mode(p.codexKeyFile)).toBe(0o600);
    const ino = statSync(p.codexKeyFile).ino;
    await C.provisionCodexKey({ projectId: ID, token: TOKEN2, repoPath: repo });
    await C.materializeSecrets(ID);
    expect(statSync(p.codexKeyFile).ino).not.toBe(ino); // a single-file bind mount would go stale here
    expect(readFileSync(p.codexKeyFile, 'utf8')).toBe(TOKEN2 + '\n');
    expect(readdirSync(p.secretsDir)).toEqual(['codex-api-key']); // no temp files left behind
    await C.clearSecrets(ID);
    expect(existsSync(p.codexKeyFile)).toBe(false);
    expect(existsSync(p.secretsDir)).toBe(true); // the mount source stays
  });

  it('materialize without a provisioned token leaves an empty secrets dir', async () => {
    expect(await C.materializeSecrets(ID)).toEqual({ telegram: false, codex: false, claude: false });
    expect(readdirSync(projectPaths(ID).secretsDir)).toEqual([]);
  });
});

describe('status and redaction', () => {
  it('core redact masks the token formats', () => {
    expect(redact(`x ${TOKEN} y`)).toBe('x sk-[REDACTED] y');
  });

  it('credential status: missing, ok, insecure file mode', async () => {
    const repo = makeRepo(env.root);
    expect((await C.codexCredentialStatus(ID)).state).toBe('missing');
    await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo });
    expect(await C.codexCredentialStatus(ID)).toMatchObject({ state: 'ok', backend: 'file' });
    const { chmodSync } = await import('node:fs');
    chmodSync(new C.FileStore(C.CODEX_CREDENTIAL).path(ID), 0o644);
    expect(await C.codexCredentialStatus(ID)).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/mode is 644/) });
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

describe('security edge cases (tester)', () => {
  const PREFIX = 'sk-proj-11ABCDEFG0123456789_abcdefghij';
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
    const ks = new C.KeychainStore(runner, C.CODEX_CREDENTIAL);
    for (const t of hostile) {
      expect(() => C.checkOpenAiKeyFormat(t)).toThrow();
      await expect(ks.set(ID, t)).rejects.toBeInstanceOf(MinionsError);
    }
    expect(calls).toEqual([]);
  });

  it('security -i is never invoked with a non-UUID project id', async () => {
    const { calls, runner } = recorder();
    for (const id of ['x -w y', `${ID}\nfoo`, '../../etc', `${ID} `]) {
      await expect(new C.KeychainStore(runner, C.CODEX_CREDENTIAL).set(id, TOKEN)).rejects.toBeInstanceOf(MinionsError);
      await expect(new C.FileStore(C.CODEX_CREDENTIAL).set(id, TOKEN)).rejects.toBeInstanceOf(MinionsError);
    }
    expect(calls).toEqual([]);
  });

  it('surrounding whitespace/newlines are trimmed (stdin-style input)', () => {
    expect(C.checkOpenAiKeyFormat(`  ${TOKEN}\r\n`).token).toBe(TOKEN);
    expect(C.checkOpenAiKeyFormat(`${TOKEN}\n\n`).token).toBe(TOKEN);
  });

  it('format errors do not echo the rejected input', () => {
    try { C.checkOpenAiKeyFormat('hunter2-secret-value'); expect.unreachable(); } catch (e) {
      expect(JSON.stringify(e) + (e as Error).message + ((e as { hint?: string }).hint ?? '')).not.toContain('hunter2');
    }
  });

  it('file permissions hold under a permissive umask and leave no temp files', async () => {
    const repo = makeRepo(env.root);
    const old = process.umask(0o000);
    try {
      await C.provisionCodexKey({ projectId: ID, token: TOKEN, repoPath: repo });
      await C.provisionCodexKey({ projectId: ID, token: TOKEN2, repoPath: repo });
      await C.materializeSecrets(ID);
    } finally { process.umask(old); }
    expect(mode(new C.FileStore(C.CODEX_CREDENTIAL).path(ID))).toBe(0o600);
    expect(mode(join(credentialStoreDir(), ID))).toBe(0o700);
    expect(mode(projectPaths(ID).codexKeyFile)).toBe(0o600);
    expect(mode(projectPaths(ID).secretsDir)).toBe(0o700);
    expect(mode(projectPaths(ID).credentialsJson)).toBe(0o600);
    for (const dir of [join(credentialStoreDir(), ID), projectPaths(ID).secretsDir]) {
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    }
    expect(readFileSync(projectPaths(ID).codexKeyFile, 'utf8')).toBe(TOKEN2 + '\n');
  });

  it('removing when nothing is provisioned is a no-op', async () => {
    expect(await C.removeCodexKey(ID)).toEqual({ removed: false, backend: null });
  });
});

