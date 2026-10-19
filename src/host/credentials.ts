// Host-side GitHub credential provisioning (fine-grained personal access token per project).
//
// - The token is entered on the host only (non-echoing TTY prompt or piped stdin), never as argv.
// - Long-lived storage: macOS Keychain (`security`) when available, else a 0600 file in a 0700
//   directory under the host data root (`<root>/credentials/<projectId>/`), outside the repository.
// - `projects/<id>/credentials.json` holds only a reference (backend + locator), never the token.
// - For the container, the token is materialized into `projects/<id>/secrets/github-token` (0600),
//   whose *directory* is bind-mounted read-only at /opt/minions/secrets. The credential store itself
//   is never mounted. The materialized copy is removed on `minions down`.
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import { relative, sep, dirname } from 'node:path';
import { z } from 'zod';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { atomicWrite, ensureDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { credentialStoreDir, credentialStoreFile, projectPaths } from '../core/paths.js';
import type { Runner } from './docker.js';

export type Fetch = typeof fetch;

// ---------------------------------------------------------------- guidance

export const GITHUB_TOKEN_CREATE_URL = 'https://github.com/settings/personal-access-tokens/new';

/** Fine-grained PAT repository permissions minions needs (current and upcoming delivery/CI tasks). */
export const GITHUB_TOKEN_PERMISSIONS = [
  { permission: 'Contents', access: 'Read and write' },
  { permission: 'Pull requests', access: 'Read and write' },
  { permission: 'Checks', access: 'Read-only' },
  { permission: 'Actions', access: 'Read-only' },
  { permission: 'Commit statuses', access: 'Read-only' },
  { permission: 'Metadata', access: 'Read-only' },
] as const;

/** Parses owner/repo from a GitHub remote URL (https or scp-like ssh). */
export function githubRepoFromRemote(remoteUrl: string | null | undefined): { owner: string; repo: string } | null {
  if (!remoteUrl) return null;
  const m = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function githubTokenGuidance(remoteUrl?: string | null): string[] {
  const r = githubRepoFromRemote(remoteUrl);
  return [
    `Create a fine-grained personal access token: ${GITHUB_TOKEN_CREATE_URL}`,
    `  Repository access: Only select repositories -> ${r ? `${r.owner}/${r.repo}` : 'this project\'s repository'}`,
    '  Repository permissions:',
    ...GITHUB_TOKEN_PERMISSIONS.map((p) => `    - ${p.permission}: ${p.access}`),
    '  Grant nothing else (no account permissions, no other repositories). Choose an expiration.',
    'Store it with `minions auth github` (prompted without echo; never pass a token as an argument).',
  ];
}

// ---------------------------------------------------------------- token format

const FINE_GRAINED = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const CLASSIC = /^gh[pousr]_[A-Za-z0-9]{20,255}$/;

/** Validates token shape (also guarantees no whitespace/quotes, so it is safe on a `security -i` line). */
export function checkTokenFormat(raw: string): { token: string; fineGrained: boolean } {
  const token = raw.trim();
  if (!token) throw new MinionsError('INVALID_CONFIG', 'No token entered.', 'Paste the token at the prompt.');
  if (FINE_GRAINED.test(token)) return { token, fineGrained: true };
  if (CLASSIC.test(token)) return { token, fineGrained: false };
  throw new MinionsError('INVALID_CONFIG', 'That does not look like a GitHub token (expected github_pat_…).',
    `Create a fine-grained personal access token at ${GITHUB_TOKEN_CREATE_URL}.`);
}

// ---------------------------------------------------------------- storage backends

export type Backend = 'keychain' | 'file';
export const KEYCHAIN_SERVICE = 'minions.github';

export interface SecretStore {
  readonly backend: Backend;
  /** Stable, non-secret locator stored in credentials.json. */
  ref(projectId: string): string;
  get(projectId: string): Promise<string | null>;
  set(projectId: string, token: string): Promise<void>;
  delete(projectId: string): Promise<void>;
}

/**
 * macOS Keychain via `/usr/bin/security`. The token is written through `security -i` (commands read
 * from stdin), because `add-generic-password -w <value>` would put it in the process argv.
 */
export class KeychainStore implements SecretStore {
  readonly backend = 'keychain' as const;
  constructor(private readonly runner: Runner = run) {}
  ref(projectId: string) { return `keychain:${KEYCHAIN_SERVICE}/${projectId}`; }

  async get(projectId: string): Promise<string | null> {
    const r = await this.runner('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', projectId, '-w'], { allowFailure: true, timeoutMs: 30_000 });
    if (r.code === 0) return r.stdout.replace(/\r?\n$/, '') || null;
    if (r.code === 44) return null; // errSecItemNotFound
    throw new MinionsError('AUTH_REQUIRED', `Could not read the GitHub token from the macOS Keychain (security exit ${r.code}).`,
      'Unlock the login keychain (or allow access when prompted), then retry.');
  }

  async set(projectId: string, token: string): Promise<void> {
    assertProjectId(projectId);
    checkTokenFormat(token);
    const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${projectId} -l minions-github-token -w ${token}\n`;
    await this.runner('security', ['-i'], { input: line, allowFailure: true, timeoutMs: 30_000 });
    // `security -i` may exit 0 even when a command fails: verify by reading back.
    if ((await this.get(projectId)) !== token) {
      throw new MinionsError('AUTH_REQUIRED', 'Could not store the GitHub token in the macOS Keychain.',
        'Unlock the login keychain and retry, or set MINIONS_CREDENTIAL_STORE=file to use a 0600 file.');
    }
  }

  async delete(projectId: string): Promise<void> {
    await this.runner('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', projectId], { allowFailure: true, timeoutMs: 30_000 });
  }
}

/** 0600 file in a 0700 directory under the host data root. */
export class FileStore implements SecretStore {
  readonly backend = 'file' as const;
  path(projectId: string) { return credentialStoreFile(projectId, 'github-token'); }
  ref(projectId: string) { return `file:${this.path(projectId)}`; }

  async get(projectId: string): Promise<string | null> {
    try { return (await readFile(this.path(projectId), 'utf8')).trim() || null; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(projectId: string, token: string): Promise<void> {
    assertProjectId(projectId);
    checkTokenFormat(token);
    const file = this.path(projectId);
    await privateDir(credentialStoreDir());
    await privateDir(dirname(file));
    await atomicWrite(file, token + '\n', { mode: 0o600 });
  }

  async delete(projectId: string): Promise<void> { await rm(this.path(projectId), { force: true }); }
}

async function privateDir(dir: string): Promise<void> {
  await ensureDir(dir, 0o700);
  await chmod(dir, 0o700);
}

const assertProjectId = (id: string) => {
  if (!z.uuid().safeParse(id).success) throw new MinionsError('INTERNAL', 'invalid project id');
};

export interface StoreOptions { runner?: Runner; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }

/** Keychain on macOS when `security` works; else the file store. MINIONS_CREDENTIAL_STORE=file|keychain overrides. */
export async function selectStore(opts: StoreOptions = {}): Promise<SecretStore> {
  const runner = opts.runner ?? run;
  const pref = (opts.env ?? process.env).MINIONS_CREDENTIAL_STORE;
  if (pref === 'file') return new FileStore();
  if (pref === 'keychain') return new KeychainStore(runner);
  if ((opts.platform ?? process.platform) !== 'darwin') return new FileStore();
  const probe = await runner('security', ['list-keychains', '-d', 'user'], { allowFailure: true, timeoutMs: 15_000 });
  return probe.code === 0 ? new KeychainStore(runner) : new FileStore();
}

const storeFor = (backend: Backend, runner: Runner): SecretStore => (backend === 'keychain' ? new KeychainStore(runner) : new FileStore());

// ---------------------------------------------------------------- reference file

export const CredentialsJsonSchema = z.object({
  version: z.literal(1),
  github: z.object({
    backend: z.enum(['keychain', 'file']),
    ref: z.string().min(1),
    kind: z.enum(['fine-grained-pat', 'classic-pat']),
    updatedAt: z.string(),
  }).strict().optional(),
}).strict();
export type CredentialsJson = z.infer<typeof CredentialsJsonSchema>;
export type GithubCredentialRef = NonNullable<CredentialsJson['github']>;

export async function loadCredentialRefs(projectId: string): Promise<CredentialsJson> {
  return (await readJsonIfExists(projectPaths(projectId).credentialsJson, CredentialsJsonSchema)) ?? { version: 1 };
}

async function saveCredentialRefs(projectId: string, refs: CredentialsJson): Promise<void> {
  await writeJson(projectPaths(projectId).credentialsJson, refs, { mode: 0o600 });
}

// ---------------------------------------------------------------- verification (GitHub API)

export type Verification = { status: 'ok' | 'invalid' | 'unverified'; detail: string; login?: string };

/**
 * Checks the token against the GitHub API (repository endpoint when the remote is on GitHub, else
 * /user). The token travels only in the Authorization header; details never include it.
 */
export async function verifyGithubToken(token: string, opts: { remoteUrl?: string | null; fetch?: Fetch; timeoutMs?: number } = {}): Promise<Verification> {
  const f = opts.fetch ?? fetch;
  const repo = githubRepoFromRemote(opts.remoteUrl);
  const url = repo ? `https://api.github.com/repos/${repo.owner}/${repo.repo}` : 'https://api.github.com/user';
  let res: Response;
  try {
    res = await f(url, {
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'minions-cli',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    return { status: 'unverified', detail: `could not reach the GitHub API: ${redact(String((e as Error).message ?? e)).slice(0, 200)}` };
  }
  if (res.status === 401) return { status: 'invalid', detail: 'rejected by GitHub (expired, revoked, or mistyped)' };
  if (res.status === 403 || res.status === 404) {
    return { status: 'invalid', detail: repo ? `token cannot access ${repo.owner}/${repo.repo} (grant it repository access)` : `GitHub returned ${res.status}` };
  }
  if (!res.ok) return { status: 'unverified', detail: `GitHub API returned ${res.status}` };
  const body = await res.json().catch(() => ({})) as { login?: string; full_name?: string; permissions?: { push?: boolean } };
  if (repo) {
    const push = body.permissions?.push;
    return { status: 'ok', detail: `access to ${body.full_name ?? `${repo.owner}/${repo.repo}`}${push === false ? ' (read-only: Contents write permission missing)' : ''}` };
  }
  return { status: 'ok', detail: `authenticated${body.login ? ` as ${body.login}` : ''}`, ...(body.login ? { login: body.login } : {}) };
}

// ---------------------------------------------------------------- provisioning

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return !!r && r !== '..' && !r.startsWith('..' + sep) && !r.startsWith(sep);
};

export interface ProvisionOptions extends StoreOptions {
  projectId: string;
  token: string;
  repoPath: string;
  remoteUrl?: string | null;
  verify?: boolean;
  fetch?: Fetch;
  store?: SecretStore;
}
export interface ProvisionResult {
  projectId: string;
  backend: Backend;
  ref: string;
  kind: GithubCredentialRef['kind'];
  verification: Verification | null;
  warnings: string[];
}

/** Validates, optionally verifies (an invalid token is not stored), stores, and records the reference. */
export async function provisionGithubToken(opts: ProvisionOptions): Promise<ProvisionResult> {
  const runner = opts.runner ?? run;
  const { token, fineGrained } = checkTokenFormat(opts.token);
  const warnings: string[] = [];
  if (!fineGrained) warnings.push('This is a classic token; a fine-grained token limited to this repository is recommended.');
  const paths = projectPaths(opts.projectId);
  for (const p of [credentialStoreDir(), paths.dir]) {
    if (isInside(p, opts.repoPath) || p === opts.repoPath) {
      throw new MinionsError('PRECONDITION', `The minions host data root (${p}) is inside the repository; refusing to store a credential there.`,
        'Set MINIONS_HOME to a directory outside the repository.');
    }
  }
  let verification: Verification | null = null;
  if (opts.verify !== false) {
    verification = await verifyGithubToken(token, { remoteUrl: opts.remoteUrl, fetch: opts.fetch });
    if (verification.status === 'invalid') {
      throw new MinionsError('AUTH_REQUIRED', `GitHub token not stored: ${verification.detail}.`, githubTokenGuidance(opts.remoteUrl).join('\n'));
    }
    if (verification.status === 'unverified') warnings.push(`Token stored without verification: ${verification.detail}.`);
  }
  const store = opts.store ?? await selectStore({ ...opts, runner });
  const prev = (await loadCredentialRefs(opts.projectId)).github;
  await store.set(opts.projectId, token);
  if (prev && prev.backend !== store.backend) await storeFor(prev.backend, runner).delete(opts.projectId);
  const ref: GithubCredentialRef = { backend: store.backend, ref: store.ref(opts.projectId), kind: fineGrained ? 'fine-grained-pat' : 'classic-pat', updatedAt: new Date().toISOString() };
  const refs = await loadCredentialRefs(opts.projectId);
  await saveCredentialRefs(opts.projectId, { ...refs, github: ref });
  return { projectId: opts.projectId, backend: ref.backend, ref: ref.ref, kind: ref.kind, verification, warnings };
}

/** Reads the stored token (host only). Null when none is provisioned. */
export async function readGithubToken(projectId: string, runner: Runner = run): Promise<string | null> {
  const ref = (await loadCredentialRefs(projectId)).github;
  if (!ref) return null;
  return storeFor(ref.backend, runner).get(projectId);
}

/** Deletes the stored token, its reference, and any materialized copy. */
export async function removeGithubToken(projectId: string, runner: Runner = run): Promise<{ removed: boolean; backend: Backend | null }> {
  const refs = await loadCredentialRefs(projectId);
  const ref = refs.github;
  if (ref) await storeFor(ref.backend, runner).delete(projectId);
  await clearSecrets(projectId);
  if (ref) {
    const { github: _drop, ...rest } = refs;
    await saveCredentialRefs(projectId, rest);
  }
  return { removed: !!ref, backend: ref?.backend ?? null };
}

// ---------------------------------------------------------------- container secrets dir

/**
 * Ensures the mounted secrets directory exists (0700) and writes the token into it (0600) via an
 * atomic rename, or removes a stale copy when no token is provisioned. Returns whether a token was written.
 */
export async function materializeSecrets(projectId: string, runner: Runner = run): Promise<{ github: boolean }> {
  const paths = projectPaths(projectId);
  await privateDir(paths.secretsDir);
  const token = await readGithubToken(projectId, runner);
  if (!token) { await rm(paths.githubTokenFile, { force: true }); return { github: false }; }
  await atomicWrite(paths.githubTokenFile, token + '\n', { mode: 0o600 });
  return { github: true };
}

/** Removes materialized secrets (container stopped / uninstall). Keeps the directory for the mount. */
export async function clearSecrets(projectId: string): Promise<void> {
  await rm(projectPaths(projectId).githubTokenFile, { force: true });
}

// ---------------------------------------------------------------- status (doctor)

export type CredentialState = 'ok' | 'missing' | 'invalid' | 'unverified';
export interface CredentialStatus { state: CredentialState; detail: string; backend?: Backend }

export async function githubCredentialStatus(project: { projectId: string; remoteUrl: string | null }, opts: { runner?: Runner; fetch?: Fetch } = {}): Promise<CredentialStatus> {
  const runner = opts.runner ?? run;
  let refs: CredentialsJson;
  try { refs = await loadCredentialRefs(project.projectId); } catch (e) {
    return { state: 'invalid', detail: `credential reference file is invalid: ${redact((e as Error).message).split('\n')[0]}` };
  }
  const ref = refs.github;
  if (!ref) return { state: 'missing', detail: 'no GitHub token provisioned' };
  let token: string | null;
  try { token = await storeFor(ref.backend, runner).get(project.projectId); } catch (e) {
    return { state: 'invalid', backend: ref.backend, detail: redact((e as Error).message) };
  }
  if (!token) return { state: 'missing', backend: ref.backend, detail: `reference ${ref.ref} exists but the token is gone` };
  const problems: string[] = [];
  if (ref.backend === 'file') {
    const mode = (await stat(new FileStore().path(project.projectId))).mode & 0o777;
    if (mode & 0o077) problems.push(`token file mode is ${mode.toString(8)} (expected 600)`);
  }
  const v = await verifyGithubToken(token, { remoteUrl: project.remoteUrl, fetch: opts.fetch });
  const where = ref.backend === 'keychain' ? 'macOS Keychain' : '0600 file';
  if (v.status === 'invalid') return { state: 'invalid', backend: ref.backend, detail: `${v.detail} (stored in ${where})` };
  if (v.status === 'unverified') return { state: 'unverified', backend: ref.backend, detail: `stored in ${where}; ${v.detail}` };
  return { state: problems.length ? 'invalid' : 'ok', backend: ref.backend, detail: [`${v.detail}; stored in ${where}`, ...problems].join('; ') };
}
