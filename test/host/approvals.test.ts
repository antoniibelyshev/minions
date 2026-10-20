import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateApprovalKeyPair, signApproval, verifyApproval, verifyAnyApproval } from '../../src/core/approval.js';
import { CONTAINER, credentialStoreDir, projectPaths } from '../../src/core/paths.js';
import { approvalPublicKeyFile, approvalSigningKeyFile, approveOnHost, ensureApprovalKey, issueApproval, removeApprovalKeys } from '../../src/host/approvals.js';
import { composeYaml } from '../../src/host/docker.js';
import { hostSettings } from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
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
    // Inside the container the verifier ignores MINIONS_CONFIG (agent-settable) for the key path.
    expect(runtimePaths({ MINIONS_RUNTIME: 'container', MINIONS_CONFIG: '/state/evil/config.json' }).approvalPublicKey).toBe(CONTAINER.approvalPublicKey);
    expect(runtimePaths({ MINIONS_RUNTIME: 'host', MINIONS_CONFIG: projectPaths(ID).runtimeConfigJson }).approvalPublicKey).toBe(projectPaths(ID).approvalPublicKey);
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
      projectId: ID, delegate: async (args) => { calls.push(args); return 0; },
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

    await expect(approveOnHost('task-7', { head: 'a1b2c3d', json: false }, { projectId: ID, delegate: async () => 0 }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(issueApproval(ID, { taskId: 'task-7', head: 'main' })).rejects.toThrow(/full commit SHA/);
  });
});
