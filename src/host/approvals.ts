// Host side of signed publication approvals (see src/core/approval.ts and docs/design/bootstrap.md,
// "Host-signed publication approvals").
//
// - Private key: <MINIONS_HOME>/credentials/<projectId>/approval-signing-key (dir 0700, file 0600).
//   The credential store is never mounted into the container and is under a read deny of the host
//   runtime's sandbox.
// - Public key: <project>/runtime/approval-public-key.pem, i.e. /opt/minions/config in the container
//   (read-only bind, a directory mount so a key written later is visible to a running container).
import { chmod, readFile, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { generateApprovalKeyPair, publicKeyOf, signApproval, type ApprovalPayload } from '../core/approval.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, ensureDir } from '../core/fsutil.js';
import { credentialStoreDir, credentialStoreFile, projectPaths } from '../core/paths.js';
import { delegateToRuntime } from './delegate.js';
import { projectForPath } from './registry.js';

export const APPROVAL_SIGNING_KEY_NAME = 'approval-signing-key';

export const approvalSigningKeyFile = (projectId: string) => credentialStoreFile(projectId, APPROVAL_SIGNING_KEY_NAME);
export const approvalPublicKeyFile = (projectId: string) => projectPaths(projectId).approvalPublicKey;

async function readIfExists(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function privateDir(dir: string): Promise<void> {
  await ensureDir(dir, 0o700);
  await chmod(dir, 0o700);
}

/**
 * Returns the project's signing key, creating it on first use, and (re)writes the public key into the
 * runtime config dir when it is missing or differs (so a deleted or swapped public key is repaired).
 */
export async function ensureApprovalKey(projectId: string): Promise<{ privateKeyPem: string; publicKeyPem: string; created: boolean }> {
  const keyFile = approvalSigningKeyFile(projectId);
  let privateKeyPem = await readIfExists(keyFile);
  let created = false;
  if (!privateKeyPem) {
    const pair = generateApprovalKeyPair();
    await privateDir(credentialStoreDir());
    await privateDir(dirname(keyFile));
    await atomicWrite(keyFile, pair.privateKeyPem, { mode: 0o600 });
    privateKeyPem = pair.privateKeyPem;
    created = true;
  }
  let publicKeyPem: string;
  try { publicKeyPem = publicKeyOf(privateKeyPem); } catch (e) {
    throw new MinionsError('INVALID_CONFIG', `The approval signing key ${keyFile} is unusable: ${(e as Error).message}`,
      'Delete that file and approve again (a new key pair is created; earlier unpublished approvals must be re-issued).');
  }
  const pubFile = approvalPublicKeyFile(projectId);
  if ((await readIfExists(pubFile)) !== publicKeyPem) await atomicWrite(pubFile, publicKeyPem, { mode: 0o644 });
  return { privateKeyPem, publicKeyPem, created };
}

/** Signs a publication approval for (taskId, head) with the project's host-held key. */
export async function issueApproval(projectId: string, f: { taskId: string; head: string; by?: string | null; now?: Date; ttlMs?: number }): Promise<{ token: string; payload: ApprovalPayload; keyCreated: boolean }> {
  const key = await ensureApprovalKey(projectId);
  try {
    const { token, payload } = signApproval(key.privateKeyPem, f);
    return { token, payload, keyCreated: key.created };
  } catch (e) {
    throw new MinionsError('PRECONDITION', (e as Error).message, 'Pass the full head SHA shown in the awaiting-approval message.');
  }
}

/** Removes both halves (uninstall). */
export async function removeApprovalKeys(projectId: string): Promise<void> {
  await rm(approvalSigningKeyFile(projectId), { force: true });
  await rm(approvalPublicKeyFile(projectId), { force: true });
}

/**
 * `minions work approve <taskId> --head <sha>` on the host: signs with the host-held key, then
 * records the token in the agent runtime (`work approve ... --signature <token>`, delegated). The
 * runtime verifies it now and again before every push. Returns the delegated exit code.
 */
export async function approveOnHost(taskId: string, o: { head: string; by?: string; note?: string; json: boolean; cwd?: string },
  deps: { delegate?: (args: string[], opts: { json: boolean; cwd?: string }) => Promise<number>; projectId?: string } = {}): Promise<number> {
  const projectId = deps.projectId ?? (await projectForPath(o.cwd ?? process.cwd())).projectId;
  const by = o.by ?? userInfo().username;
  const { token } = await issueApproval(projectId, { taskId, head: o.head, by });
  const args = ['work', 'approve', taskId, '--head', o.head, '--by', by, ...(o.note ? ['--note', o.note] : []), '--signature', token];
  const delegate = deps.delegate ?? delegateToRuntime;
  return delegate(args, { json: o.json, cwd: o.cwd });
}
