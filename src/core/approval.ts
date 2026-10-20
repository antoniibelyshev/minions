// Host-signed publication approvals (decision record: docs/design/bootstrap.md, "Host-signed
// publication approvals").
//
// The host CLI holds an Ed25519 private key per project in the host credential store (never mounted
// into the container, under a read deny of the host-runtime sandbox). It signs one approval per task
// and exact head SHA. The agent runtime only has the public key (read-only runtime config dir) and
// verifies the signature right before publishing changes that need a human approval. Anything an
// in-container process can write (the SQLite approvals table, state files, CLI arguments) can at most
// carry a token; it cannot mint one.
//
// Token: `mnap1.<base64url(payload JSON)>.<base64url(Ed25519 signature over "mnap1.<payload part>")>`.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

export const APPROVAL_TOKEN_PREFIX = 'mnap1';
/** File name of the public key in the runtime config dir (/opt/minions/config, <project>/runtime). */
export const APPROVAL_PUBLIC_KEY_NAME = 'approval-public-key.pem';
/** How long a host-signed approval stays valid. A retry after that needs a new approval. */
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated clock difference between host and runtime for `issuedAt`. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Full SHA-1 or SHA-256 object name: approvals bind an exact commit, never an abbreviation or ref. */
export const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface ApprovalPayload {
  v: 1;
  scope: 'publish';
  taskId: string;
  head: string;
  by: string | null;
  issuedAt: string;
  expiresAt: string;
  /** Key id (fingerprint of the signing key's public half). */
  kid: string;
}

export type ApprovalCheck = { ok: true; payload: ApprovalPayload } | { ok: false; reason: string };

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function generateApprovalKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function ed25519Public(pem: string): KeyObject {
  const k = createPublicKey(pem);
  if (k.asymmetricKeyType !== 'ed25519') throw new Error(`approval key is ${k.asymmetricKeyType ?? 'unknown'}, not ed25519`);
  return k;
}

/** Public key PEM of a private key PEM. */
export function publicKeyOf(privateKeyPem: string): string {
  const k = createPrivateKey(privateKeyPem);
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('approval signing key is not ed25519');
  return createPublicKey(k).export({ type: 'spki', format: 'pem' }).toString();
}

/** Short fingerprint of a public key (sha256 of the SPKI DER, 16 hex chars). */
export function approvalKeyId(publicKeyPem: string): string {
  const der = ed25519Public(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** Signs a publication approval for exactly (taskId, head). Host only: needs the private key. */
export function signApproval(privateKeyPem: string, f: { taskId: string; head: string; by?: string | null; now?: Date; ttlMs?: number }): { token: string; payload: ApprovalPayload } {
  if (!FULL_SHA_RE.test(f.head)) throw new Error('--head must be the full commit SHA (40 or 64 lowercase hex characters)');
  if (!f.taskId.trim()) throw new Error('task id is empty');
  const now = f.now ?? new Date();
  const key = createPrivateKey(privateKeyPem);
  const payload: ApprovalPayload = {
    v: 1, scope: 'publish', taskId: f.taskId, head: f.head, by: f.by ?? null,
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + (f.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
    kid: approvalKeyId(publicKeyOf(privateKeyPem)),
  };
  const signed = `${APPROVAL_TOKEN_PREFIX}.${b64u(JSON.stringify(payload))}`;
  return { token: `${signed}.${b64u(sign(null, Buffer.from(signed), key))}`, payload };
}

/**
 * Verifies a token against the runtime's public key for exactly (taskId, head). Fails closed: no
 * key, a malformed/tampered/foreign-key token, another task or head, or an expired approval.
 */
export function verifyApproval(token: string | null | undefined, publicKeyPem: string | null | undefined,
  expect: { taskId: string; head: string; now?: Date }): ApprovalCheck {
  if (!publicKeyPem) return { ok: false, reason: 'no approval public key is provisioned in this runtime (the host creates it on the first `minions work approve`)' };
  if (!token) return { ok: false, reason: 'no host-signed approval is recorded' };
  let key: KeyObject;
  try { key = ed25519Public(publicKeyPem); } catch (e) { return { ok: false, reason: `the approval public key is unusable: ${(e as Error).message}` }; }
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== APPROVAL_TOKEN_PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: 'the approval token is malformed' };
  const signed = `${parts[0]}.${parts[1]}`;
  let good = false;
  try { good = verify(null, Buffer.from(signed), key, Buffer.from(parts[2], 'base64url')); } catch { good = false; }
  if (!good) return { ok: false, reason: 'the approval signature is invalid (tampered, or signed by another key)' };
  let p: ApprovalPayload;
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as ApprovalPayload; } catch { return { ok: false, reason: 'the approval payload is not JSON' }; }
  if (!p || typeof p !== 'object' || p.v !== 1 || p.scope !== 'publish') return { ok: false, reason: 'the approval has an unsupported version or scope' };
  if (p.taskId !== expect.taskId) return { ok: false, reason: `the approval is for task ${String(p.taskId)}, not ${expect.taskId}` };
  if (p.head !== expect.head) return { ok: false, reason: `the approval is for head ${String(p.head)}, not ${expect.head}` };
  const now = (expect.now ?? new Date()).getTime();
  const issued = Date.parse(p.issuedAt), expires = Date.parse(p.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return { ok: false, reason: 'the approval has invalid timestamps' };
  if (issued - CLOCK_SKEW_MS > now) return { ok: false, reason: 'the approval was issued in the future' };
  if (expires <= now) return { ok: false, reason: `the approval expired at ${p.expiresAt}` };
  return { ok: true, payload: p };
}

/** First valid token of several (e.g. every approval row recorded for one head), else the last failure. */
export function verifyAnyApproval(tokens: (string | null | undefined)[], publicKeyPem: string | null | undefined,
  expect: { taskId: string; head: string; now?: Date }): ApprovalCheck {
  let last: ApprovalCheck = verifyApproval(null, publicKeyPem, expect);
  for (const t of tokens) {
    if (!t) continue;
    const r = verifyApproval(t, publicKeyPem, expect);
    if (r.ok) return r;
    last = r;
  }
  return last;
}
