import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateApprovalKeyPair, signApproval, verifyApproval, verifyAnyApproval } from '../../src/core/approval.js';
import { CONTAINER, credentialStoreDir, projectPaths } from '../../src/core/paths.js';
import { approvalPublicKeyFile, approvalSigningKeyFile, approveOnHost, ensureApprovalKey, issueApproval, removeApprovalKeys } from '../../src/host/approvals.js';
import { composeYaml } from '../../src/host/docker.js';
import { hostSettings } from '../../src/runtime/coordinator.js';
import { approvalPublicKeyPath, CONTAINER_APPROVAL_PUBLIC_KEY, inMinionsContainer, missingApprovalKeyReason, runtimePaths } from '../../src/runtime/paths.js';
import { withHome } from './fixtures.js';

const HEAD = 'a1'.repeat(20);
const mode = (p: string) => statSync(p).mode & 0o777;

describe('approval tokens (src/core/approval.ts)', () => {
  const pair = generateApprovalKeyPair();
  const sign = (taskId: string, head: string, o: { now?: Date } = {}) => signApproval(pair.privateKeyPem, { taskId, head, by: 'ada', ...o }).token;

  it('a valid signature for the exact task and head verifies', () => {
    const r = verifyApproval(sign('task-1', HEAD), pair.publicKeyPem, { taskId: 'task-1', head: HEAD });
    expect(r).toMatchObject({ ok: true, payload: { taskId: 'task-1', head: HEAD, by: 'ada', scope: 'publish', v: 1 } });
  });

  it('fails closed: wrong head, wrong task, tampered, foreign key, unsigned, no key, expired, future', () => {
    const t = sign('task-1', HEAD);
    const want = { taskId: 'task-1', head: HEAD };
    expect(verifyApproval(t, pair.publicKeyPem, { ...want, head: 'b2'.repeat(20) })).toMatchObject({ ok: false, reason: expect.stringMatching(/for head/) });
    expect(verifyApproval(t, pair.publicKeyPem, { ...want, taskId: 'task-2' })).toMatchObject({ ok: false, reason: expect.stringMatching(/for task/) });
    const [p0, p1, p2] = t.split('.');
    const swapped = Buffer.from(Buffer.from(p1!, 'base64url').toString().replace(HEAD, 'c3'.repeat(20))).toString('base64url');
    expect(verifyApproval(`${p0}.${swapped}.${p2}`, pair.publicKeyPem, { ...want, head: 'c3'.repeat(20) }).ok).toBe(false);
    expect(verifyApproval(t, generateApprovalKeyPair().publicKeyPem, want)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature is invalid/) });
    expect(verifyApproval(null, pair.publicKeyPem, want)).toMatchObject({ ok: false, reason: expect.stringMatching(/no host-signed approval/) });
    expect(verifyApproval(t, null, want)).toMatchObject({ ok: false, reason: expect.stringMatching(/no approval public key/) });
    expect(verifyApproval(t, 'garbage', want)).toMatchObject({ ok: false, reason: expect.stringMatching(/unusable/) });
    expect(verifyApproval(sign('task-1', HEAD, { now: new Date(Date.now() - 8 * 86_400_000) }), pair.publicKeyPem, want).ok).toBe(false);
    expect(verifyApproval(sign('task-1', HEAD, { now: new Date(Date.now() + 3_600_000) }), pair.publicKeyPem, want)).toMatchObject({ ok: false, reason: expect.stringMatching(/future/) });
    expect(verifyAnyApproval([null, 'junk', t], pair.publicKeyPem, want).ok).toBe(true);
    expect(verifyAnyApproval([null, 'junk'], pair.publicKeyPem, want).ok).toBe(false);
  });

  it('only binds full commit SHAs (no abbreviations or refs)', () => {
    for (const head of ['a1b2c3d', 'main', 'HEAD', HEAD.toUpperCase()]) expect(() => sign('task-1', head), head).toThrow(/full commit SHA/);
    expect(() => sign('task-1', 'd4'.repeat(32))).not.toThrow(); // sha256 repositories
  });
});

describe('host-held approval key', () => {
  let env: ReturnType<typeof withHome>;
  let ID: string;
  beforeEach(() => { env = withHome(); ID = randomUUID(); });
  afterEach(() => env.cleanup());

  it('keeps the private key in the host credential store (0600 in a 0700 dir) and publishes only the public key', async () => {
    const k = await ensureApprovalKey(ID);
    expect(k.created).toBe(true);
    const keyFile = approvalSigningKeyFile(ID);
    expect(keyFile.startsWith(credentialStoreDir() + '/')).toBe(true);
    expect(mode(keyFile)).toBe(0o600);
    expect(mode(dirname(keyFile))).toBe(0o700);
    expect(readFileSync(approvalPublicKeyFile(ID), 'utf8')).toBe(k.publicKeyPem);
    expect(approvalPublicKeyFile(ID)).toBe(projectPaths(ID).approvalPublicKey);
    expect(readFileSync(approvalPublicKeyFile(ID), 'utf8')).not.toMatch(/PRIVATE KEY/);
    // Idempotent, and a swapped public key is repaired from the private key.
    writeFileSync(approvalPublicKeyFile(ID), generateApprovalKeyPair().publicKeyPem);
    const again = await ensureApprovalKey(ID);
    expect(again).toMatchObject({ created: false, privateKeyPem: k.privateKeyPem });
    expect(readFileSync(approvalPublicKeyFile(ID), 'utf8')).toBe(k.publicKeyPem);
    await removeApprovalKeys(ID);
    expect(existsSync(keyFile) || existsSync(approvalPublicKeyFile(ID))).toBe(false);
  });

  it('the signing key is absent from the container: no bind covers it; the public key path is a fixed read-only bind', async () => {
    await ensureApprovalKey(ID);
    const y = composeYaml({
      version: 1, projectId: ID, repoPath: '/Users/x/repo', gitCommonDir: '/Users/x/repo/.git', visibility: 'private',
      profile: 'personal-work', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null,
      gitIdentity: { name: 'Ada', email: 'ada@example.com' },
      container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet' },
    });
    const binds = [...y.matchAll(/- type: bind\n\s+source: "([^"]+)"\n\s+target: "([^"]+)"\n\s+read_only: true/g)].map((m) => ({ source: m[1]!, target: m[2]! }));
    expect(binds.length).toBeGreaterThan(0);
    const keyFile = approvalSigningKeyFile(ID);
    for (const b of binds) expect(keyFile.startsWith(b.source + '/'), b.source).toBe(false);
    expect(y).not.toContain(credentialStoreDir());
    // The public key reaches the container through the read-only runtime config bind.
    expect(binds).toContainEqual({ source: projectPaths(ID).runtimeDir, target: CONTAINER.configDir });
    expect(CONTAINER.approvalPublicKey.startsWith(CONTAINER.configDir + '/')).toBe(true);
    // Host runtime (no container config dir): the shim-pinned runtime config dir.
    expect(runtimePaths({ MINIONS_RUNTIME: 'host', MINIONS_CONFIG: projectPaths(ID).runtimeConfigJson }, { inContainer: false }).approvalPublicKey).toBe(projectPaths(ID).approvalPublicKey);
  });

  it('inside the container the verifier key path is the literal read-only bind, whatever the env says', () => {
    const LITERAL = '/opt/minions/config/approval-public-key.pem';
    expect(CONTAINER_APPROVAL_PUBLIC_KEY).toBe(LITERAL);
    const evil = [
      {},
      { MINIONS_CONTAINER_ROOT: '/tmp/evil' },
      { MINIONS_CONFIG: '/tmp/evil/config.json' },
      { MINIONS_RUNTIME: 'host' },
      { MINIONS_RUNTIME: 'container', MINIONS_CONFIG: '/state/evil/config.json' },
      { MINIONS_RUNTIME: 'host', MINIONS_CONFIG: '/tmp/evil/config.json' },
      { MINIONS_CONTAINER_ROOT: '/tmp/evil', MINIONS_CONFIG: '/tmp/evil/config.json', MINIONS_RUNTIME: 'host' },
      { MINIONS_CONTAINER_ROOT: '/tmp/evil', MINIONS_CONFIG: '/tmp/evil/config.json', MINIONS_RUNTIME: 'container' },
    ];
    for (const env of evil) {
      // Container detected from the filesystem: env never redirects the key.
      expect(approvalPublicKeyPath(env, true), JSON.stringify(env)).toBe(LITERAL);
      expect(runtimePaths(env, { inContainer: true }).approvalPublicKey, JSON.stringify(env)).toBe(LITERAL);
    }
    // MINIONS_RUNTIME=container alone also pins it, even without the directory, and so does a missing MINIONS_CONFIG.
    expect(approvalPublicKeyPath({ MINIONS_RUNTIME: 'container', MINIONS_CONTAINER_ROOT: '/tmp/evil', MINIONS_CONFIG: '/tmp/evil/c.json' }, false)).toBe(LITERAL);
    expect(approvalPublicKeyPath({ MINIONS_CONTAINER_ROOT: '/tmp/evil' }, false)).toBe(LITERAL);
    // The process env is not consulted for the container root either (containerPaths() would honour it).
    const prev = process.env.MINIONS_CONTAINER_ROOT;
    process.env.MINIONS_CONTAINER_ROOT = '/tmp/evil';
    try {
      expect(runtimePaths({ ...process.env, MINIONS_RUNTIME: 'container' }).approvalPublicKey).toBe(LITERAL);
    } finally {
      if (prev === undefined) delete process.env.MINIONS_CONTAINER_ROOT; else process.env.MINIONS_CONTAINER_ROOT = prev;
    }
  });

  // The real default probe (no injected inContainer). Only meaningful where the read-only bind exists,
  // i.e. when the suite itself runs inside a minions container; skipped on a plain host.
  const realContainer = existsSync('/opt/minions/config');
  it.runIf(realContainer)('default probe in a real container: no env combination redirects the key (runtimePaths() reads process.env)', () => {
    const LITERAL = '/opt/minions/config/approval-public-key.pem';
    expect(inMinionsContainer()).toBe(true);
    const keys = ['MINIONS_CONTAINER_ROOT', 'MINIONS_CONFIG', 'MINIONS_RUNTIME'] as const;
    const choices: Record<(typeof keys)[number], (string | undefined)[]> = {
      MINIONS_CONTAINER_ROOT: [undefined, '', '/tmp/evil'],
      MINIONS_CONFIG: [undefined, '', '/tmp/evil/runtime/config.json'],
      MINIONS_RUNTIME: [undefined, '', 'host', 'container'],
    };
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const a of choices.MINIONS_CONTAINER_ROOT) for (const b of choices.MINIONS_CONFIG) for (const c of choices.MINIONS_RUNTIME) {
        const combo = { MINIONS_CONTAINER_ROOT: a, MINIONS_CONFIG: b, MINIONS_RUNTIME: c };
        for (const k of keys) { if (combo[k] === undefined) delete process.env[k]; else process.env[k] = combo[k]; }
        expect(runtimePaths().approvalPublicKey, JSON.stringify(combo)).toBe(LITERAL);
        expect(approvalPublicKeyPath(), JSON.stringify(combo)).toBe(LITERAL);
        expect(runtimePaths({ ...process.env }).approvalPublicKey, JSON.stringify(combo)).toBe(LITERAL);
      }
    } finally {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  it.runIf(realContainer)('default probe in a real container: host-side `work approve` is refused even with MINIONS_RUNTIME unset', async () => {
    const prev = process.env.MINIONS_RUNTIME;
    delete process.env.MINIONS_RUNTIME;
    let delegated = false;
    try {
      await expect(approveOnHost('task-7', { head: HEAD, json: true }, { projectId: ID, delegate: async () => { delegated = true; return 0; } }))
        .rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    } finally {
      if (prev === undefined) delete process.env.MINIONS_RUNTIME; else process.env.MINIONS_RUNTIME = prev;
    }
    expect(delegated).toBe(false);
    expect(existsSync(approvalSigningKeyFile(ID))).toBe(false);
  });

  it('host runtime with MINIONS_CONFIG unset fails closed: the absent container key, never an agent-chosen file', () => {
    expect(approvalPublicKeyPath({ MINIONS_RUNTIME: 'host' }, false)).toBe(CONTAINER_APPROVAL_PUBLIC_KEY);
    expect(approvalPublicKeyPath({ MINIONS_RUNTIME: 'host', MINIONS_CONFIG: '' }, false)).toBe(CONTAINER_APPROVAL_PUBLIC_KEY);
    const pair = generateApprovalKeyPair();
    const t = signApproval(pair.privateKeyPem, { taskId: 'task-1', head: HEAD }).token;
    expect(verifyApproval(t, null, { taskId: 'task-1', head: HEAD })).toMatchObject({ ok: false, reason: expect.stringMatching(/no approval public key/) });
  });

  it('host runtime with MINIONS_CONFIG unset: the fail-closed reason names the key path it tried and the unset MINIONS_CONFIG, not a missing first approval', () => {
    for (const env of [{ MINIONS_RUNTIME: 'host' }, { MINIONS_RUNTIME: 'host', MINIONS_CONFIG: '' }]) {
      const file = approvalPublicKeyPath(env, false);
      const reason = missingApprovalKeyReason(file, env, false);
      expect(reason).toContain(`no approval public key at ${CONTAINER_APPROVAL_PUBLIC_KEY}`);
      expect(reason).toMatch(/host runtime but MINIONS_CONFIG is unset/);
      expect(reason).not.toMatch(/first .minions work approve/);
    }
    // Container, or a correctly launched host runtime: the path tried plus the first-approve hint.
    expect(missingApprovalKeyReason(CONTAINER_APPROVAL_PUBLIC_KEY, {}, true)).toBe(`no approval public key at ${CONTAINER_APPROVAL_PUBLIC_KEY} (the host writes it on the first \`minions work approve\`)`);
    const hostEnv = { MINIONS_RUNTIME: 'host', MINIONS_CONFIG: '/home/u/p/runtime/config.json' };
    expect(missingApprovalKeyReason(approvalPublicKeyPath(hostEnv, false), hostEnv, false)).toMatch(/^no approval public key at \/home\/u\/p\/runtime\/approval-public-key\.pem \(the host writes it/);
  });

  it('host-mode `work approve` is refused inside the container before any key is written', async () => {
    let delegated = false;
    await expect(approveOnHost('task-7', { head: HEAD, json: true }, { projectId: ID, inContainer: true, delegate: async () => { delegated = true; return 0; } }))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    expect(delegated).toBe(false);
    expect(existsSync(approvalSigningKeyFile(ID))).toBe(false);
  });

  it('host runtime: sandboxed commands cannot read the signing key, may read the public key, and cannot edit it', () => {
    const pp = projectPaths(ID);
    const s = hostSettings({
      home: '/nonexistent-home', workspace: `${pp.dir}/host/workspace`, state: `${pp.dir}/host/state`, secretsDir: pp.secretsDir,
      credentialsDir: credentialStoreDir(), projectDir: pp.dir, pluginDir: pp.pluginDir,
    });
    const fs = s.sandbox.filesystem as { denyRead: string[]; allowRead: string[] };
    const keyFile = approvalSigningKeyFile(ID);
    expect(fs.denyRead.some((d) => keyFile.startsWith(d + '/'))).toBe(true);
    expect(fs.allowRead.some((d) => keyFile.startsWith(d + '/') || keyFile === d)).toBe(false);
    expect(fs.allowRead).toContain(pp.runtimeDir);
    expect(s.deny).toContain(`Edit(/${pp.dir}/runtime/**)`);
  });

  it('`work approve` on the host signs and delegates a token the runtime verifies for exactly that head', async () => {
    const calls: string[][] = [];
    const code = await approveOnHost('task-7', { head: HEAD, note: 'ok', json: true }, {
      projectId: ID, inContainer: false, delegate: async (args) => { calls.push(args); return 0; },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const args = calls[0]!;
    expect(args.slice(0, 5)).toEqual(['work', 'approve', 'task-7', '--head', HEAD]);
    expect(args).toEqual(expect.arrayContaining(['--note', 'ok', '--by']));
    const token = args[args.indexOf('--signature') + 1]!;
    const pub = readFileSync(approvalPublicKeyFile(ID), 'utf8');
    expect(verifyApproval(token, pub, { taskId: 'task-7', head: HEAD }).ok).toBe(true);
    expect(verifyApproval(token, pub, { taskId: 'task-7', head: 'e5'.repeat(20) }).ok).toBe(false);
    expect(token).not.toContain('PRIVATE');

    await expect(approveOnHost('task-7', { head: 'a1b2c3d', json: false }, { projectId: ID, inContainer: false, delegate: async () => 0 }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(issueApproval(ID, { taskId: 'task-7', head: 'main' })).rejects.toThrow(/full commit SHA/);
  });
});
