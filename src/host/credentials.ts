// Host-side credential provisioning, shared by every credential kind (GitHub fine-grained PAT,
// Telegram bot token). Per project:
//
// - The token is entered on the host only (non-echoing TTY prompt or piped stdin), never as argv.
// - Long-lived storage: macOS Keychain (`security`) when available, else a 0600 file in a 0700
//   directory under the host data root (`<root>/credentials/<projectId>/`), outside the repository.
// - `projects/<id>/credentials.json` holds only a reference (backend + locator), never the token.
// - For the container, each token is materialized into `projects/<id>/secrets/<kind file>` (0600),
//   whose *directory* is bind-mounted read-only at /opt/minions/secrets. The credential store itself
//   is never mounted. Materialized copies are removed on `minions down`.
// - The Telegram bot token is read inside the container only by `minions coordinator run`, which
//   passes it to the coordinator's claude process through the environment (never argv, tmux, or files).
import { chmod, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { atomicWrite, ensureDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { credentialStoreDir, credentialStoreFile, projectPaths } from '../core/paths.js';
import { BOTFATHER_URL, checkTelegramTokenFormat } from '../telegram/token.js';
import { loadRegistry } from './registry.js';

export { BOTFATHER_URL, checkTelegramTokenFormat };
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

// ---------------------------------------------------------------- Telegram bot token

/** Bot creation, pairing and allowlisting steps (docs/design/telegram.md, "Wizard flow"). Contains no secret. */
export function telegramBotGuidance(): string[] {
  return [
    'Telegram uses the official Claude Code channel plugin (telegram@claude-plugins-official), a research preview:',
    '  it needs Anthropic authentication (claude.ai or a Console API key; not Bedrock/Vertex/Foundry), and',
    '  claude.ai Team/Enterprise organizations need an Owner to enable channels. Terminal mode always keeps working.',
    `Create a bot: open ${BOTFATHER_URL}, send /newbot, choose a display name and a unique username ending in "bot",`,
    '  and copy the token BotFather sends. Optional: /setjoingroups -> Disable (DM-only use).',
    'One coordinator per bot: Telegram lets only one process poll a bot token, so use a separate bot for each project',
    '  you run at the same time (a second poller takes the bot over or fails with 409 Conflict).',
    'Store the token with `minions auth telegram` (prompted without echo; never pass it as an argument).',
    'Pair in the coordinator terminal after `minions start`: DM your bot, it replies with a 6-character code; type',
    '  /telegram:access pair <code>, then lock down with /telegram:access policy allowlist.',
    'Pair only yourself: every allowlisted sender can control the coordinator and approve tool-permission prompts.',
    '  Unpaired senders get no access; their messages are dropped before they reach the coordinator.',
    'Residual risk: the coordinator and its tools can read the token inside the container (mount and environment).',
  ];
}

/** Result of the optional, consented Bot API getMe check. The token travels only in the request URL path. */
export async function verifyTelegramToken(token: string, opts: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<Verification> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (e) {
    return { status: 'unverified', detail: `could not reach the Telegram Bot API: ${redact(String((e as Error).message ?? e)).slice(0, 200)}` };
  }
  if (res.status === 401 || res.status === 404) return { status: 'invalid', detail: 'rejected by Telegram (revoked or mistyped token)' };
  if (!res.ok) return { status: 'unverified', detail: `Telegram Bot API returned ${res.status}` };
  const body = await res.json().catch(() => ({})) as { ok?: boolean; result?: { username?: string; is_bot?: boolean } };
  const username = typeof body.result?.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(body.result.username) ? body.result.username : undefined;
  if (body.ok !== true) return { status: 'unverified', detail: 'Telegram Bot API returned an unexpected response' };
  return { status: 'ok', detail: `bot ${username ? '@' + username : '(unknown username)'}`, ...(username ? { login: username } : {}) };
}

// ---------------------------------------------------------------- credential kinds

/** One host-held secret type. Every kind shares the stores, reference file and secrets mount. */
export interface CredentialKind {
  readonly name: 'github' | 'telegram';
  /** Human label used in messages. */
  readonly label: string;
  readonly keychainService: string;
  readonly keychainLabel: string;
  /** File name in the host file store and in the mounted secrets directory. */
  readonly fileName: string;
  /** Validates and normalizes the token (throws INVALID_CONFIG). */
  check(raw: string): string;
  /** Hint for re-provisioning. */
  readonly command: string;
}

export const GITHUB_CREDENTIAL: CredentialKind = {
  name: 'github', label: 'GitHub token', keychainService: 'minions.github', keychainLabel: 'minions-github-token',
  fileName: 'github-token', check: (raw) => checkTokenFormat(raw).token, command: 'minions auth github',
};
export const TELEGRAM_CREDENTIAL: CredentialKind = {
  name: 'telegram', label: 'Telegram bot token', keychainService: 'minions.telegram', keychainLabel: 'minions-telegram-bot-token',
  fileName: 'telegram-bot-token', check: (raw) => checkTelegramTokenFormat(raw).token, command: 'minions auth telegram',
};
export const CREDENTIAL_KINDS = [GITHUB_CREDENTIAL, TELEGRAM_CREDENTIAL] as const;

// ---------------------------------------------------------------- storage backends

export type Backend = 'keychain' | 'file';
export const KEYCHAIN_SERVICE = GITHUB_CREDENTIAL.keychainService;

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
  constructor(private readonly runner: Runner = run, readonly kind: CredentialKind = GITHUB_CREDENTIAL) {}
  ref(projectId: string) { return `keychain:${this.kind.keychainService}/${projectId}`; }

  async get(projectId: string): Promise<string | null> {
    const r = await this.runner('security', ['find-generic-password', '-s', this.kind.keychainService, '-a', projectId, '-w'], { allowFailure: true, timeoutMs: 30_000 });
    if (r.code === 0) return r.stdout.replace(/\r?\n$/, '') || null;
    if (r.code === 44) return null; // errSecItemNotFound
    throw new MinionsError('AUTH_REQUIRED', `Could not read the ${this.kind.label} from the macOS Keychain (security exit ${r.code}).`,
      'Unlock the login keychain (or allow access when prompted), then retry.');
  }

  async set(projectId: string, token: string): Promise<void> {
    assertProjectId(projectId);
    this.kind.check(token); // also guarantees the value cannot break out of the `security -i` line
    const line = `add-generic-password -U -s ${this.kind.keychainService} -a ${projectId} -l ${this.kind.keychainLabel} -w ${token}\n`;
    await this.runner('security', ['-i'], { input: line, allowFailure: true, timeoutMs: 30_000 });
    // `security -i` may exit 0 even when a command fails: verify by reading back.
    if ((await this.get(projectId)) !== token) {
      throw new MinionsError('AUTH_REQUIRED', `Could not store the ${this.kind.label} in the macOS Keychain.`,
        'Unlock the login keychain and retry, or set MINIONS_CREDENTIAL_STORE=file to use a 0600 file.');
    }
  }

  async delete(projectId: string): Promise<void> {
    await this.runner('security', ['delete-generic-password', '-s', this.kind.keychainService, '-a', projectId], { allowFailure: true, timeoutMs: 30_000 });
  }
}

/** 0600 file in a 0700 directory under the host data root. */
export class FileStore implements SecretStore {
  readonly backend = 'file' as const;
  constructor(readonly kind: CredentialKind = GITHUB_CREDENTIAL) {}
  path(projectId: string) { return credentialStoreFile(projectId, this.kind.fileName); }
  ref(projectId: string) { return `file:${this.path(projectId)}`; }

  async get(projectId: string): Promise<string | null> {
    try { return (await readFile(this.path(projectId), 'utf8')).trim() || null; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(projectId: string, token: string): Promise<void> {
    assertProjectId(projectId);
    this.kind.check(token);
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

export interface StoreOptions { runner?: Runner; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; kind?: CredentialKind }

/** Keychain on macOS when `security` works; else the file store. MINIONS_CREDENTIAL_STORE=file|keychain overrides. */
export async function selectStore(opts: StoreOptions = {}): Promise<SecretStore> {
  const runner = opts.runner ?? run;
  const kind = opts.kind ?? GITHUB_CREDENTIAL;
  const pref = (opts.env ?? process.env).MINIONS_CREDENTIAL_STORE;
  if (pref === 'file') return new FileStore(kind);
  if (pref === 'keychain') return new KeychainStore(runner, kind);
  if ((opts.platform ?? process.platform) !== 'darwin') return new FileStore(kind);
  const probe = await runner('security', ['list-keychains', '-d', 'user'], { allowFailure: true, timeoutMs: 15_000 });
  return probe.code === 0 ? new KeychainStore(runner, kind) : new FileStore(kind);
}

const storeFor = (backend: Backend, runner: Runner, kind: CredentialKind = GITHUB_CREDENTIAL): SecretStore =>
  (backend === 'keychain' ? new KeychainStore(runner, kind) : new FileStore(kind));

// ---------------------------------------------------------------- reference file

export const CredentialsJsonSchema = z.object({
  version: z.literal(1),
  github: z.object({
    backend: z.enum(['keychain', 'file']),
    ref: z.string().min(1),
    kind: z.enum(['fine-grained-pat', 'classic-pat']),
    updatedAt: z.string(),
  }).strict().optional(),
  telegram: z.object({
    backend: z.enum(['keychain', 'file']),
    ref: z.string().min(1),
    /** Non-secret numeric bot id (token prefix): detects one bot shared by two projects. */
    botId: z.string().regex(/^\d{6,12}$/),
    updatedAt: z.string(),
  }).strict().optional(),
}).strict();
export type CredentialsJson = z.infer<typeof CredentialsJsonSchema>;
export type GithubCredentialRef = NonNullable<CredentialsJson['github']>;
export type TelegramCredentialRef = NonNullable<CredentialsJson['telegram']>;

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

function assertOutsideRepo(projectId: string, repoPath: string): void {
  for (const p of [credentialStoreDir(), projectPaths(projectId).dir]) {
    if (isInside(p, repoPath) || p === repoPath) {
      throw new MinionsError('PRECONDITION', `The minions host data root (${p}) is inside the repository; refusing to store a credential there.`,
        'Set MINIONS_HOME to a directory outside the repository.');
    }
  }
}

/** Validates, optionally verifies (an invalid token is not stored), stores, and records the reference. */
export async function provisionGithubToken(opts: ProvisionOptions): Promise<ProvisionResult> {
  const runner = opts.runner ?? run;
  const { token, fineGrained } = checkTokenFormat(opts.token);
  const warnings: string[] = [];
  if (!fineGrained) warnings.push('This is a classic token; a fine-grained token limited to this repository is recommended.');
  assertOutsideRepo(opts.projectId, opts.repoPath);
  let verification: Verification | null = null;
  if (opts.verify !== false) {
    verification = await verifyGithubToken(token, { remoteUrl: opts.remoteUrl, fetch: opts.fetch });
    if (verification.status === 'invalid') {
      throw new MinionsError('AUTH_REQUIRED', `GitHub token not stored: ${verification.detail}.`, githubTokenGuidance(opts.remoteUrl).join('\n'));
    }
    if (verification.status === 'unverified') warnings.push(`Token stored without verification: ${verification.detail}.`);
  }
  const { backend, ref } = await storeToken(opts, GITHUB_CREDENTIAL, token, runner);
  const entry: GithubCredentialRef = { backend, ref, kind: fineGrained ? 'fine-grained-pat' : 'classic-pat', updatedAt: new Date().toISOString() };
  const refs = await loadCredentialRefs(opts.projectId);
  await saveCredentialRefs(opts.projectId, { ...refs, github: entry });
  return { projectId: opts.projectId, backend, ref, kind: entry.kind, verification, warnings };
}

/** Stores the token in the selected backend and deletes a copy left in a previous backend. */
async function storeToken(opts: ProvisionOptions | TelegramProvisionOptions, kind: CredentialKind, token: string, runner: Runner): Promise<{ backend: Backend; ref: string }> {
  const store = opts.store ?? await selectStore({ ...opts, runner, kind });
  const prev = (await loadCredentialRefs(opts.projectId))[kind.name];
  await store.set(opts.projectId, token);
  if (prev && prev.backend !== store.backend) await storeFor(prev.backend, runner, kind).delete(opts.projectId);
  return { backend: store.backend, ref: store.ref(opts.projectId) };
}

/** Reads the stored token of one kind (host only). Null when none is provisioned. */
export async function readToken(projectId: string, kind: CredentialKind, runner: Runner = run): Promise<string | null> {
  const ref = (await loadCredentialRefs(projectId))[kind.name];
  if (!ref) return null;
  return storeFor(ref.backend, runner, kind).get(projectId);
}

/** Reads the stored GitHub token (host only). Null when none is provisioned. */
export async function readGithubToken(projectId: string, runner: Runner = run): Promise<string | null> {
  return readToken(projectId, GITHUB_CREDENTIAL, runner);
}

/** Deletes the stored token of one kind, its reference, and its materialized copy. */
export async function removeToken(projectId: string, kind: CredentialKind, runner: Runner = run): Promise<{ removed: boolean; backend: Backend | null }> {
  const refs = await loadCredentialRefs(projectId);
  const ref = refs[kind.name];
  if (ref) await storeFor(ref.backend, runner, kind).delete(projectId);
  await rm(secretFile(projectId, kind), { force: true });
  if (ref) {
    const rest: CredentialsJson = { ...refs };
    delete rest[kind.name];
    await saveCredentialRefs(projectId, rest);
  }
  return { removed: !!ref, backend: ref?.backend ?? null };
}

/** Deletes the stored GitHub token, its reference, and any materialized copy. */
export async function removeGithubToken(projectId: string, runner: Runner = run): Promise<{ removed: boolean; backend: Backend | null }> {
  return removeToken(projectId, GITHUB_CREDENTIAL, runner);
}

// ---------------------------------------------------------------- Telegram provisioning

export interface TelegramProvisionOptions extends StoreOptions {
  projectId: string;
  token: string;
  repoPath: string;
  /** Bot API getMe check; only with the user's explicit consent (default off). */
  verify?: boolean;
  fetch?: Fetch;
  store?: SecretStore;
}
export interface TelegramProvisionResult {
  projectId: string;
  backend: Backend;
  ref: string;
  botId: string;
  verification: Verification | null;
  /** Other registered projects that already use this bot (one coordinator per bot). */
  sharedWith: string[];
  warnings: string[];
}

/** Registered projects (other than `exceptProjectId`) whose stored Telegram reference has this bot id. */
export async function projectsUsingBot(botId: string, exceptProjectId?: string): Promise<string[]> {
  const reg = await loadRegistry().catch(() => ({ version: 1 as const, projects: {} }));
  const out: string[] = [];
  for (const id of Object.keys(reg.projects)) {
    if (id === exceptProjectId) continue;
    const t = (await loadCredentialRefs(id).catch((): CredentialsJson => ({ version: 1 }))).telegram;
    if (t?.botId === botId) out.push(id);
  }
  return out.sort();
}

const oneBotWarning = (ids: string[]) =>
  `This bot is already provisioned for project(s) ${ids.join(', ')}. Only one coordinator can poll a bot at a time; use a separate bot (BotFather /newbot) for each project you run simultaneously.`;

/** Validates, optionally verifies with getMe (an invalid token is not stored), stores, and records the non-secret bot id. */
export async function provisionTelegramToken(opts: TelegramProvisionOptions): Promise<TelegramProvisionResult> {
  const runner = opts.runner ?? run;
  const { token, botId } = checkTelegramTokenFormat(opts.token);
  assertOutsideRepo(opts.projectId, opts.repoPath);
  const warnings: string[] = [];
  let verification: Verification | null = null;
  if (opts.verify) {
    verification = await verifyTelegramToken(token, { fetch: opts.fetch });
    if (verification.status === 'invalid') {
      throw new MinionsError('AUTH_REQUIRED', `Telegram bot token not stored: ${verification.detail}.`, `Copy the token again from ${BOTFATHER_URL} (/mybots -> API Token).`);
    }
    if (verification.status === 'unverified') warnings.push(`Token stored without verification: ${verification.detail}.`);
  }
  const sharedWith = await projectsUsingBot(botId, opts.projectId);
  if (sharedWith.length) warnings.push(oneBotWarning(sharedWith));
  const { backend, ref } = await storeToken(opts, TELEGRAM_CREDENTIAL, token, runner);
  const refs = await loadCredentialRefs(opts.projectId);
  await saveCredentialRefs(opts.projectId, { ...refs, telegram: { backend, ref, botId, updatedAt: new Date().toISOString() } });
  return { projectId: opts.projectId, backend, ref, botId, verification, sharedWith, warnings };
}

export const readTelegramToken = (projectId: string, runner: Runner = run) => readToken(projectId, TELEGRAM_CREDENTIAL, runner);
export const removeTelegramToken = (projectId: string, runner: Runner = run) => removeToken(projectId, TELEGRAM_CREDENTIAL, runner);

// ---------------------------------------------------------------- container secrets dir

/** Host path of a kind's materialized copy inside the mounted secrets directory. */
export const secretFile = (projectId: string, kind: CredentialKind) => join(projectPaths(projectId).secretsDir, kind.fileName);

export type Materialized = Record<CredentialKind['name'], boolean>;

/**
 * Ensures the mounted secrets directory exists (0700) and writes every provisioned token into it
 * (0600) via an atomic rename, removing stale copies of kinds that are not provisioned. A store read
 * failure for one kind removes its copy and is rethrown after the other kinds are handled.
 */
export async function materializeSecrets(projectId: string, runner: Runner = run): Promise<Materialized> {
  await privateDir(projectPaths(projectId).secretsDir);
  const out = { github: false, telegram: false } as Materialized;
  let failure: unknown;
  for (const kind of CREDENTIAL_KINDS) {
    const file = secretFile(projectId, kind);
    let token: string | null = null;
    try { token = await readToken(projectId, kind, runner); } catch (e) { failure ??= e; }
    if (!token) { await rm(file, { force: true }); continue; }
    await atomicWrite(file, token + '\n', { mode: 0o600 });
    out[kind.name] = true;
  }
  if (failure) throw failure;
  return out;
}

/** Removes materialized secrets (container stopped / uninstall). Keeps the directory for the mount. */
export async function clearSecrets(projectId: string): Promise<void> {
  for (const kind of CREDENTIAL_KINDS) await rm(secretFile(projectId, kind), { force: true });
}

// ---------------------------------------------------------------- status (doctor)

export type CredentialState = 'ok' | 'missing' | 'invalid' | 'unverified';
export interface CredentialStatus { state: CredentialState; detail: string; backend?: Backend }

async function fileModeProblem(kind: CredentialKind, projectId: string): Promise<string | null> {
  const mode = (await stat(new FileStore(kind).path(projectId))).mode & 0o777;
  return mode & 0o077 ? `token file mode is ${mode.toString(8)} (expected 600)` : null;
}

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
    const p = await fileModeProblem(GITHUB_CREDENTIAL, project.projectId);
    if (p) problems.push(p);
  }
  const v = await verifyGithubToken(token, { remoteUrl: project.remoteUrl, fetch: opts.fetch });
  const where = ref.backend === 'keychain' ? 'macOS Keychain' : '0600 file';
  if (v.status === 'invalid') return { state: 'invalid', backend: ref.backend, detail: `${v.detail} (stored in ${where})` };
  if (v.status === 'unverified') return { state: 'unverified', backend: ref.backend, detail: `stored in ${where}; ${v.detail}` };
  return { state: problems.length ? 'invalid' : 'ok', backend: ref.backend, detail: [`${v.detail}; stored in ${where}`, ...problems].join('; ') };
}

export interface TelegramCredentialStatus extends CredentialStatus { botId?: string; sharedWith?: string[] }

/** Telegram bot token: presence, format, file mode, and one-bot-per-project. No network call; never includes the token. */
export async function telegramCredentialStatus(projectId: string, opts: { runner?: Runner } = {}): Promise<TelegramCredentialStatus> {
  const runner = opts.runner ?? run;
  let refs: CredentialsJson;
  try { refs = await loadCredentialRefs(projectId); } catch (e) {
    return { state: 'invalid', detail: `credential reference file is invalid: ${redact((e as Error).message).split('\n')[0]}` };
  }
  const ref = refs.telegram;
  if (!ref) return { state: 'missing', detail: 'no Telegram bot token provisioned' };
  let token: string | null;
  try { token = await storeFor(ref.backend, runner, TELEGRAM_CREDENTIAL).get(projectId); } catch (e) {
    return { state: 'invalid', backend: ref.backend, botId: ref.botId, detail: redact((e as Error).message) };
  }
  if (!token) return { state: 'missing', backend: ref.backend, botId: ref.botId, detail: `reference ${ref.ref} exists but the token is gone` };
  const where = ref.backend === 'keychain' ? 'macOS Keychain' : '0600 file';
  const problems: string[] = [];
  try {
    if (checkTelegramTokenFormat(token).botId !== ref.botId) problems.push('stored token does not match the recorded bot id');
  } catch { problems.push('stored value is not a Telegram bot token'); }
  if (ref.backend === 'file') {
    const p = await fileModeProblem(TELEGRAM_CREDENTIAL, projectId);
    if (p) problems.push(p);
  }
  const sharedWith = await projectsUsingBot(ref.botId, projectId);
  if (problems.length) return { state: 'invalid', backend: ref.backend, botId: ref.botId, sharedWith, detail: `bot ${ref.botId}; stored in ${where}; ${problems.join('; ')}` };
  return { state: 'ok', backend: ref.backend, botId: ref.botId, sharedWith, detail: `bot ${ref.botId}; stored in ${where}` };
}

/** True when any materialized secret copy exists on the host. */
export async function secretCopiesExist(projectId: string): Promise<boolean> {
  for (const kind of CREDENTIAL_KINDS) if (await stat(secretFile(projectId, kind)).then(() => true, () => false)) return true;
  return false;
}

/**
 * Removes materialized copies left behind when no container is running (host crash, reboot, Docker
 * quit). Never touches the Keychain / file-store originals. Returns true when something was removed.
 */
export async function clearStaleSecrets(projectId: string, containerRunning: boolean): Promise<boolean> {
  if (containerRunning || !(await secretCopiesExist(projectId))) return false;
  await clearSecrets(projectId);
  return true;
}

/** Runs `compose.up()`; if it fails, the freshly materialized plaintext copies are removed before rethrowing. */
export async function upClearingSecretsOnFailure(compose: { up(): Promise<void> }, projectId: string): Promise<void> {
  try { await compose.up(); } catch (e) { await clearSecrets(projectId).catch(() => undefined); throw e; }
}
