// Host-side credential provisioning, shared by every credential kind (Telegram bot token, OpenAI API key,
// headless Claude token). Per project:
//
// - The token is entered on the host only (non-echoing TTY prompt or piped stdin), never as argv.
// - Long-lived storage: macOS Keychain (`security`) or, on Linux, the Secret Service keyring
//   (libsecret `secret-tool`) when available, else a 0600 file in a 0700 directory under the host
//   data root (`<root>/credentials/<projectId>/`), outside the repository.
// - `projects/<id>/credentials.json` holds only a reference (backend + locator), never the token.
// - For the container, each token is materialized into `projects/<id>/secrets/<kind file>` (0600;
//   0640 with the private primary group for a Linux host uid != 1000, see secrets-access.ts),
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
import { prepareSecretsDir, probeSecretsAccess, secretFileMode, secretGid, type SecretsAccess } from './secrets-access.js';
import { redact } from '../core/output.js';
import { CLAUDE_HEADLESS_TOKEN_FILE, credentialStoreDir, credentialStoreFile, defaultsPath, projectPaths, publisherPaths } from '../core/paths.js';
import { BOTFATHER_URL, checkTelegramTokenFormat } from '../telegram/token.js';
import { loadRegistry } from './registry.js';

export { BOTFATHER_URL, checkTelegramTokenFormat };
import type { Runner } from './docker.js';

export type Fetch = typeof fetch;

// ---------------------------------------------------------------- OpenAI API key (Codex harness)

export const OPENAI_API_KEYS_URL = 'https://platform.openai.com/api-keys';
const OPENAI_KEY = /^sk-[A-Za-z0-9_-]{20,500}$/;

/** Validates an OpenAI API key's shape (no whitespace or quotes, so it is safe on a `security -i` line). */
export function checkOpenAiKeyFormat(raw: string): { token: string } {
  const token = raw.trim();
  if (!token) throw new MinionsError('INVALID_CONFIG', 'No key entered.', 'Paste the key at the prompt.');
  // An Anthropic key (sk-ant-…) also matches the OpenAI shape; it would only fail at Codex's first request.
  if (token.startsWith('sk-ant-')) {
    throw new MinionsError('INVALID_CONFIG', 'That is an Anthropic API key (sk-ant-…), not an OpenAI API key.',
      `Codex needs an OpenAI project API key from ${OPENAI_API_KEYS_URL}; Claude keys are set with \`minions auth set\`.`);
  }
  if (!OPENAI_KEY.test(token)) throw new MinionsError('INVALID_CONFIG', 'That does not look like an OpenAI API key (expected sk-…).', `Create a project API key at ${OPENAI_API_KEYS_URL}.`);
  return { token };
}

/** Key creation guidance for the Codex harness (agent-runtimes D5). Contains no secret. */
export function codexKeyGuidance(): string[] {
  return [
    'Codex process workers (agent-runtimes D5) use an OpenAI API key, billed at API prices.',
    `  Create a key for a dedicated OpenAI project at ${OPENAI_API_KEYS_URL} and set a usage limit on that project.`,
    '  Only the minions process runner reads it; it reaches `codex exec` as CODEX_API_KEY, never as an argument.',
    'Store it with `minions auth codex` (prompted without echo, or --stdin).',
  ];
}

// ---------------------------------------------------------------- Claude token

export const ANTHROPIC_API_KEYS_URL = 'https://console.anthropic.com/settings/keys';
/** `claude setup-token` OAuth tokens (sk-ant-oat01-…) and Anthropic API keys (sk-ant-api03-…). */
const CLAUDE_TOKEN = /^sk-ant-(oat|api)\d{2}-[A-Za-z0-9_-]{20,500}$/;
export type ClaudeTokenKind = 'oauth-token' | 'api-key';

/**
 * Validates a Claude credential's shape (no whitespace or quotes, so it is safe on a `security -i` line) and tells a
 * long-lived OAuth token (`claude setup-token`, passed as CLAUDE_CODE_OAUTH_TOKEN) from an Anthropic API key (passed
 * as ANTHROPIC_API_KEY). The message never includes the input.
 */
export function checkClaudeTokenFormat(raw: string): { token: string; kind: ClaudeTokenKind } {
  const token = raw.trim();
  if (!token) throw new MinionsError('INVALID_CONFIG', 'No token entered.', 'Paste the token at the prompt.');
  const m = CLAUDE_TOKEN.exec(token);
  if (!m) {
    throw new MinionsError('INVALID_CONFIG', 'That does not look like a Claude token (expected sk-ant-oat01-… from `claude setup-token`, or an Anthropic API key sk-ant-api03-…).',
      `Run \`claude setup-token\` (Claude subscription) or create an API key at ${ANTHROPIC_API_KEYS_URL}.`);
  }
  return { token, kind: m[1] === 'oat' ? 'oauth-token' : 'api-key' };
}

/** The environment variable a stored Claude credential reaches a headless claude process through (never argv). */
export const claudeTokenEnvName = (kind: ClaudeTokenKind): 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY' =>
  (kind === 'oauth-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY');

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
    '  `minions telegram access pair <code>` on the host, then lock down with `minions telegram access policy allowlist`.',
    'Pair only yourself: every allowlisted sender can control the coordinator and approve tool-permission prompts.',
    '  Unpaired senders get no access; their messages are dropped before they reach the coordinator.',
    'Residual risk: the coordinator and its tools can read the token inside the container (mount and environment).',
  ];
}

export type Verification = { status: 'ok' | 'invalid' | 'unverified'; detail: string; login?: string };

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

/** What a secret store needs to know about a secret type. */
export interface StoreKind {
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

/** One per-project secret type. Every kind shares the stores, the project reference file and the secrets mount. */
export interface CredentialKind extends StoreKind {
  readonly name: 'telegram' | 'codex' | 'claude';
}

export const TELEGRAM_CREDENTIAL: CredentialKind = {
  name: 'telegram', label: 'Telegram bot token', keychainService: 'minions.telegram', keychainLabel: 'minions-telegram-bot-token',
  fileName: 'telegram-bot-token', check: (raw) => checkTelegramTokenFormat(raw).token, command: 'minions auth telegram',
};
/** OpenAI API key for the Codex process harness (agent-runtimes D5); the runner reads the `codex-api-key` file. */
export const CODEX_CREDENTIAL: CredentialKind = {
  name: 'codex', label: 'OpenAI API key (Codex)', keychainService: 'minions.codex', keychainLabel: 'minions-codex-api-key',
  fileName: 'codex-api-key', check: (raw) => checkOpenAiKeyFormat(raw).token, command: 'minions auth codex',
};
/**
 * Headless Claude token of the `login` method (task-96): a `claude setup-token` OAuth token (or an Anthropic API key) for
 * minions-launched headless runs in a fresh CLAUDE_CONFIG_DIR (`minions coordinator live-run`), which cannot use the
 * coordinator's interactive /login. Only that command reads the materialized copy and passes it to its claude child in
 * the environment (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, by its prefix). The key methods need none: headless runs
 * reuse the provisioned key through an apiKeyHelper.
 */
export const CLAUDE_HEADLESS_CREDENTIAL: CredentialKind = {
  name: 'claude', label: 'headless Claude token', keychainService: 'minions.claude-headless', keychainLabel: 'minions-claude-headless-token',
  fileName: CLAUDE_HEADLESS_TOKEN_FILE, check: (raw) => checkClaudeTokenFormat(raw).token, command: 'minions auth set login --headless-token',
};
export const CREDENTIAL_KINDS = [TELEGRAM_CREDENTIAL, CODEX_CREDENTIAL, CLAUDE_HEADLESS_CREDENTIAL] as const;
/** Store account of the host-wide publisher bot token (never a project UUID, so it cannot collide with one). */
export const PUBLISHER_ACCOUNT = 'publisher';
/**
 * The host publisher's own Telegram bot token (docs/design/autonomy.md Decision 17). Host-wide, not per project:
 * Keychain service `minions.publisher` / Secret Service `service=minions.publisher account=publisher` /
 * `<MINIONS_HOME>/credentials/publisher/publisher-bot-token` (0600). Never materialized into a secrets directory,
 * never referenced from a project's credentials.json; only the publisher process reads it.
 */
export const PUBLISHER_CREDENTIAL: StoreKind = {
  label: 'publisher bot token', keychainService: 'minions.publisher', keychainLabel: 'minions-publisher-bot-token',
  fileName: 'publisher-bot-token', check: (raw) => checkTelegramTokenFormat(raw).token, command: 'minions auth publisher',
};
/** Materialized copies of removed kinds (the GitHub token): deleted from the secrets directory, never written. */
const LEGACY_SECRET_FILES = ['github-token'];

// ---------------------------------------------------------------- storage backends

export const BACKENDS = ['keychain', 'secret-service', 'file'] as const;
export type Backend = typeof BACKENDS[number];

/** Where a token of this backend lives, for user-facing messages ("stored in <label>"). */
export function backendLabel(backend: Backend): string {
  if (backend === 'keychain') return 'the macOS Keychain';
  if (backend === 'secret-service') return 'the Secret Service keyring (secret-tool)';
  return 'a 0600 host file';
}
const shortWhere = (backend: Backend) => (backend === 'keychain' ? 'macOS Keychain' : backend === 'secret-service' ? 'Secret Service keyring' : '0600 file');

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
  constructor(private readonly runner: Runner, readonly kind: StoreKind) {}
  ref(projectId: string) { return `keychain:${this.kind.keychainService}/${projectId}`; }

  async get(projectId: string): Promise<string | null> {
    const r = await this.runner('security', ['find-generic-password', '-s', this.kind.keychainService, '-a', projectId, '-w'], { allowFailure: true, timeoutMs: 30_000 });
    if (r.code === 0) return r.stdout.replace(/\r?\n$/, '') || null;
    if (r.code === 44) return null; // errSecItemNotFound
    throw new MinionsError('AUTH_REQUIRED', `Could not read the ${this.kind.label} from the macOS Keychain (security exit ${r.code}).`,
      'Unlock the login keychain (or allow access when prompted), then retry.');
  }

  async set(projectId: string, token: string): Promise<void> {
    assertAccount(projectId);
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

/**
 * Linux Secret Service (GNOME Keyring, KWallet's Secret Service bridge, KeePassXC, ...) via libsecret's
 * `secret-tool`. Items carry the attributes `service=<kind service>` and `account=<projectId>` (the
 * same names as the Keychain item). `secret-tool store` reads the secret from stdin, so the token
 * never appears in argv. `lookup` exits 1 with empty stderr when no item matches; any stderr output
 * (no D-Bus session, locked or denied collection) is an error.
 */
export class SecretServiceStore implements SecretStore {
  readonly backend = 'secret-service' as const;
  constructor(private readonly runner: Runner, readonly kind: StoreKind) {}
  ref(projectId: string) { return `secret-service:${this.kind.keychainService}/${projectId}`; }
  private attrs(projectId: string) { return ['service', this.kind.keychainService, 'account', projectId]; }

  async get(projectId: string): Promise<string | null> {
    const r = await this.runner('secret-tool', ['lookup', ...this.attrs(projectId)], { allowFailure: true, timeoutMs: 30_000 });
    if (r.code === 0) return r.stdout.replace(/\r?\n$/, '') || null;
    if (r.code === 1 && !r.stderr.trim()) return null; // no matching item
    throw new MinionsError('AUTH_REQUIRED', `Could not read the ${this.kind.label} from the Secret Service keyring (secret-tool exit ${r.code}).`,
      'Unlock the login keyring (or log in to a desktop session with D-Bus), then retry; or set MINIONS_CREDENTIAL_STORE=file to use a 0600 file.');
  }

  async set(projectId: string, token: string): Promise<void> {
    assertAccount(projectId);
    this.kind.check(token);
    await this.runner('secret-tool', ['store', `--label=${this.kind.keychainLabel}`, ...this.attrs(projectId)], { input: token, allowFailure: true, timeoutMs: 30_000 });
    // Verify by reading back, like the Keychain store.
    if ((await this.get(projectId).catch(() => null)) !== token) {
      throw new MinionsError('AUTH_REQUIRED', `Could not store the ${this.kind.label} in the Secret Service keyring.`,
        'Unlock the login keyring and retry, or set MINIONS_CREDENTIAL_STORE=file to use a 0600 file.');
    }
  }

  async delete(projectId: string): Promise<void> {
    await this.runner('secret-tool', ['clear', ...this.attrs(projectId)], { allowFailure: true, timeoutMs: 30_000 });
  }
}

/**
 * True when `secret-tool` runs and reaches a Secret Service: a lookup of an item that never exists
 * exits 1 with no stderr. A missing binary, no D-Bus session bus (headless or SSH hosts) or no Secret
 * Service provider print an error or fail to spawn, so those hosts use the file store.
 */
export async function secretServiceAvailable(runner: Runner, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.DBUS_SESSION_BUS_ADDRESS && !env.XDG_RUNTIME_DIR) return false;
  try {
    const r = await runner('secret-tool', ['lookup', 'service', 'minions.probe', 'account', 'probe'], { allowFailure: true, timeoutMs: 15_000 });
    return (r.code === 0 || r.code === 1) && !r.stderr.trim();
  } catch { return false; }
}

/** 0600 file in a 0700 directory under the host data root. */
export class FileStore implements SecretStore {
  readonly backend = 'file' as const;
  constructor(readonly kind: StoreKind) {}
  path(projectId: string) { return credentialStoreFile(projectId, this.kind.fileName); }
  ref(projectId: string) { return `file:${this.path(projectId)}`; }

  async get(projectId: string): Promise<string | null> {
    try { return (await readFile(this.path(projectId), 'utf8')).trim() || null; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async set(projectId: string, token: string): Promise<void> {
    assertAccount(projectId);
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

/** A store account is a project UUID, or the host-wide publisher account. */
const assertAccount = (id: string) => {
  if (id !== PUBLISHER_ACCOUNT && !z.uuid().safeParse(id).success) throw new MinionsError('INTERNAL', 'invalid project id');
};

export interface StoreOptions { runner?: Runner; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; hostRuntime?: boolean }

/**
 * True when any registered project (or the host-wide default) uses the host runtime. Its agents run
 * sandboxed commands as the user, and the Seatbelt sandbox lets them reach the Keychain service
 * (com.apple.SecurityServer): /usr/bin/security can then read every minions Keychain item, because
 * items created through `security` trust that binary. The file store sits under a sandbox read deny.
 */
export async function hostRuntimeInUse(): Promise<boolean> {
  const defaults = await readJsonIfExists<{ runtime?: string }>(defaultsPath()).catch(() => undefined);
  if (defaults?.runtime === 'host') return true;
  const reg = await loadRegistry().catch(() => ({ version: 1 as const, projects: {} }));
  for (const id of Object.keys(reg.projects)) {
    const pj = await readJsonIfExists<{ runtime?: string }>(projectPaths(id).projectJson).catch(() => undefined);
    if (pj?.runtime === 'host') return true;
  }
  return false;
}

/**
 * Keychain on macOS when `security` works; the Secret Service on Linux when `secret-tool` reaches one;
 * else the file store. MINIONS_CREDENTIAL_STORE=file|keychain|secret-service overrides, except that the
 * file store is always used while the host runtime is in use (see hostRuntimeInUse).
 */
export async function selectStore(opts: StoreOptions & { kind: StoreKind }): Promise<SecretStore> {
  const runner = opts.runner ?? run;
  const kind = opts.kind;
  const env = opts.env ?? process.env;
  const pref = env.MINIONS_CREDENTIAL_STORE;
  if (pref === 'file') return new FileStore(kind);
  if (opts.hostRuntime ?? await hostRuntimeInUse()) return new FileStore(kind);
  if (pref === 'keychain') return new KeychainStore(runner, kind);
  if (pref === 'secret-service') return new SecretServiceStore(runner, kind);
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') return (await secretServiceAvailable(runner, env)) ? new SecretServiceStore(runner, kind) : new FileStore(kind);
  if (platform !== 'darwin') return new FileStore(kind);
  const probe = await runner('security', ['list-keychains', '-d', 'user'], { allowFailure: true, timeoutMs: 15_000 });
  return probe.code === 0 ? new KeychainStore(runner, kind) : new FileStore(kind);
}

export const storeFor = (backend: Backend, runner: Runner, kind: StoreKind): SecretStore =>
  (backend === 'keychain' ? new KeychainStore(runner, kind) : backend === 'secret-service' ? new SecretServiceStore(runner, kind) : new FileStore(kind));

/** A moved token: a project's, or the host-wide publisher bot token (projectId null). */
export type MovedToken = { projectId: string; kind: CredentialKind['name'] } | { projectId: null; kind: 'publisher' };

/**
 * Host runtime: moves every registered project's tokens from the macOS Keychain
 * or the Secret Service keyring to the 0600 file store (read from Keychain, written to the file store, reference
 * updated, Keychain item deleted). A token that cannot be read (locked keychain, denied prompt) stays where it is and
 * yields a warning.
 */
export async function moveKeychainTokensToFileStore(runner: Runner = run): Promise<{ moved: MovedToken[]; warnings: string[] }> {
  const moved: MovedToken[] = [];
  const warnings: string[] = [];
  const reg = await loadRegistry().catch(() => ({ version: 1 as const, projects: {} }));
  for (const projectId of Object.keys(reg.projects)) {
    const refs = await loadCredentialRefs(projectId).catch((): CredentialsJson => ({ version: 1 }));
    for (const kind of CREDENTIAL_KINDS) {
      const ref = refs[kind.name];
      if (!ref || ref.backend === 'file') continue;
      try {
        const keychain = storeFor(ref.backend, runner, kind);
        const token = await keychain.get(projectId);
        if (!token) continue;
        const file = new FileStore(kind);
        await file.set(projectId, token);
        const now = await loadCredentialRefs(projectId);
        const cur = now[kind.name];
        if (cur) await saveCredentialRefs(projectId, { ...now, [kind.name]: { ...cur, backend: 'file', ref: file.ref(projectId), updatedAt: new Date().toISOString() } });
        await keychain.delete(projectId);
        moved.push({ projectId, kind: kind.name });
      } catch (e) {
        warnings.push(`The ${kind.label} of project ${projectId} is still in ${backendLabel(ref.backend)} (${redact((e as Error).message).split('\n')[0]}); agents of a host-runtime project could read it with ${ref.backend === 'keychain' ? '/usr/bin/security' : 'secret-tool'}. Re-provision it with \`${kind.command}\`.`);
      }
    }
  }
  // The publisher bot token: its reference is <MINIONS_HOME>/publisher/credential.json, not a project's credentials.json.
  const pub = await loadPublisherCredentialRef().catch(() => null);
  if (pub && pub.backend !== 'file') {
    try {
      const keychain = storeFor(pub.backend, runner, PUBLISHER_CREDENTIAL);
      const token = await keychain.get(PUBLISHER_ACCOUNT);
      if (token) {
        const file = new FileStore(PUBLISHER_CREDENTIAL);
        await file.set(PUBLISHER_ACCOUNT, token);
        await savePublisherCredentialRef({ ...pub, backend: 'file', ref: file.ref(PUBLISHER_ACCOUNT), updatedAt: new Date().toISOString() });
        await keychain.delete(PUBLISHER_ACCOUNT);
        moved.push({ projectId: null, kind: 'publisher' });
      }
    } catch (e) {
      warnings.push(`The publisher bot token is still in ${backendLabel(pub.backend)} (${redact((e as Error).message).split('\n')[0]}); agents of a host-runtime project could read it with ${pub.backend === 'keychain' ? '/usr/bin/security' : 'secret-tool'}. Store it again with \`${PUBLISHER_CREDENTIAL.command}\`.`);
    }
  }
  return { moved, warnings };
}

// ---------------------------------------------------------------- reference file

export const CredentialsJsonSchema = z.object({
  version: z.literal(1),
  /** Legacy: the reference of the removed GitHub token (docs/design/autonomy.md Decision 8); accepted and unused. */
  github: z.unknown().optional(),
  telegram: z.object({
    backend: z.enum(BACKENDS),
    ref: z.string().min(1),
    /** Non-secret numeric bot id (token prefix): detects one bot shared by two projects. */
    botId: z.string().regex(/^\d{6,12}$/),
    updatedAt: z.string(),
  }).strict().optional(),
  codex: z.object({
    backend: z.enum(BACKENDS),
    ref: z.string().min(1),
    updatedAt: z.string(),
  }).strict().optional(),
  claude: z.object({
    backend: z.enum(BACKENDS),
    ref: z.string().min(1),
    /** oauth-token (`claude setup-token`, CLAUDE_CODE_OAUTH_TOKEN) or api-key (ANTHROPIC_API_KEY); non-secret. */
    kind: z.enum(['oauth-token', 'api-key']),
    updatedAt: z.string(),
  }).strict().optional(),
}).strict();
export type CredentialsJson = z.infer<typeof CredentialsJsonSchema>;
export type TelegramCredentialRef = NonNullable<CredentialsJson['telegram']>;
export type CodexCredentialRef = NonNullable<CredentialsJson['codex']>;

export async function loadCredentialRefs(projectId: string): Promise<CredentialsJson> {
  return (await readJsonIfExists(projectPaths(projectId).credentialsJson, CredentialsJsonSchema)) ?? { version: 1 };
}

async function saveCredentialRefs(projectId: string, refs: CredentialsJson): Promise<void> {
  await writeJson(projectPaths(projectId).credentialsJson, refs, { mode: 0o600 });
}

// ---------------------------------------------------------------- provisioning

const isInside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return !!r && r !== '..' && !r.startsWith('..' + sep) && !r.startsWith(sep);
};

function assertOutsideRepo(projectId: string, repoPath: string): void {
  for (const p of [credentialStoreDir(), projectPaths(projectId).dir]) {
    if (isInside(p, repoPath) || p === repoPath) {
      throw new MinionsError('PRECONDITION', `The minions host data root (${p}) is inside the repository; refusing to store a credential there.`,
        'Set MINIONS_HOME to a directory outside the repository.');
    }
  }
}

/** Stores the token in the selected backend and deletes a copy left in a previous backend. */
async function storeToken(opts: TelegramProvisionOptions | CodexProvisionOptions | ClaudeHeadlessProvisionOptions, kind: CredentialKind, token: string, runner: Runner): Promise<{ backend: Backend; ref: string }> {
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
  // The publisher's bot must never become a coordinator bot: a coordinator's token is readable in its runtime.
  if ((await loadPublisherCredentialRef().catch(() => null))?.botId === botId) {
    throw new MinionsError('CONFLICT', `Bot ${botId} is the host publisher's bot; a coordinator needs a bot of its own.`, `Create a separate bot (${BOTFATHER_URL}, /newbot) for this project.`);
  }
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

// ---------------------------------------------------------------- Codex (OpenAI API key) provisioning

export interface CodexProvisionOptions extends StoreOptions {
  projectId: string;
  token: string;
  repoPath: string;
  store?: SecretStore;
}
export interface CodexProvisionResult { projectId: string; backend: Backend; ref: string; warnings: string[] }

/** Validates the key shape, stores it and records the reference. No network call (the key is checked by its first run). */
export async function provisionCodexKey(opts: CodexProvisionOptions): Promise<CodexProvisionResult> {
  const runner = opts.runner ?? run;
  const { token } = checkOpenAiKeyFormat(opts.token);
  assertOutsideRepo(opts.projectId, opts.repoPath);
  const { backend, ref } = await storeToken(opts, CODEX_CREDENTIAL, token, runner);
  const refs = await loadCredentialRefs(opts.projectId);
  await saveCredentialRefs(opts.projectId, { ...refs, codex: { backend, ref, updatedAt: new Date().toISOString() } });
  return { projectId: opts.projectId, backend, ref, warnings: [] };
}

export const readCodexKey = (projectId: string, runner: Runner = run) => readToken(projectId, CODEX_CREDENTIAL, runner);
export const removeCodexKey = (projectId: string, runner: Runner = run) => removeToken(projectId, CODEX_CREDENTIAL, runner);

/** Codex key: presence, format and file mode. No network call; never includes the key. */
export async function codexCredentialStatus(projectId: string, opts: { runner?: Runner } = {}): Promise<CredentialStatus> {
  const runner = opts.runner ?? run;
  let refs: CredentialsJson;
  try { refs = await loadCredentialRefs(projectId); } catch (e) {
    return { state: 'invalid', detail: `credential reference file is invalid: ${redact((e as Error).message).split('\n')[0]}` };
  }
  const ref = refs.codex;
  if (!ref) return { state: 'missing', detail: 'no OpenAI API key provisioned for Codex' };
  let token: string | null;
  try { token = await storeFor(ref.backend, runner, CODEX_CREDENTIAL).get(projectId); } catch (e) {
    return { state: 'invalid', backend: ref.backend, detail: redact((e as Error).message) };
  }
  if (!token) return { state: 'missing', backend: ref.backend, detail: `reference ${ref.ref} exists but the key is gone` };
  const problems: string[] = [];
  try { checkOpenAiKeyFormat(token); } catch { problems.push('stored value is not an OpenAI API key'); }
  if (ref.backend === 'file') {
    const p = await fileModeProblem(CODEX_CREDENTIAL, projectId);
    if (p) problems.push(p);
  }
  const where = shortWhere(ref.backend);
  return { state: problems.length ? 'invalid' : 'ok', backend: ref.backend, detail: [`stored in ${where}`, ...problems].join('; ') };
}

// ---------------------------------------------------------------- headless Claude token (login method, task-96)

export interface ClaudeHeadlessProvisionOptions extends StoreOptions {
  projectId: string;
  token: string;
  repoPath: string;
  store?: SecretStore;
}
export interface ClaudeHeadlessProvisionResult { projectId: string; backend: Backend; ref: string; kind: ClaudeTokenKind; envName: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY' }

/** Validates the token shape, stores it and records the (non-secret) reference with its kind. No network call. */
export async function provisionClaudeHeadlessToken(opts: ClaudeHeadlessProvisionOptions): Promise<ClaudeHeadlessProvisionResult> {
  const runner = opts.runner ?? run;
  const { token, kind } = checkClaudeTokenFormat(opts.token);
  assertOutsideRepo(opts.projectId, opts.repoPath);
  const { backend, ref } = await storeToken(opts, CLAUDE_HEADLESS_CREDENTIAL, token, runner);
  const refs = await loadCredentialRefs(opts.projectId);
  await saveCredentialRefs(opts.projectId, { ...refs, claude: { backend, ref, kind, updatedAt: new Date().toISOString() } });
  return { projectId: opts.projectId, backend, ref, kind, envName: claudeTokenEnvName(kind) };
}

export const removeClaudeHeadlessToken = (projectId: string, runner: Runner = run) => removeToken(projectId, CLAUDE_HEADLESS_CREDENTIAL, runner);

export interface ClaudeHeadlessCredentialStatus extends CredentialStatus { kind?: ClaudeTokenKind }

/** Headless Claude token: presence, kind, format and file mode. No network call; never includes the token. */
export async function claudeHeadlessCredentialStatus(projectId: string, opts: { runner?: Runner } = {}): Promise<ClaudeHeadlessCredentialStatus> {
  const runner = opts.runner ?? run;
  let refs: CredentialsJson;
  try { refs = await loadCredentialRefs(projectId); } catch (e) {
    return { state: 'invalid', detail: `credential reference file is invalid: ${redact((e as Error).message).split('\n')[0]}` };
  }
  const ref = refs.claude;
  if (!ref) return { state: 'missing', detail: 'no headless Claude token stored' };
  let token: string | null;
  try { token = await storeFor(ref.backend, runner, CLAUDE_HEADLESS_CREDENTIAL).get(projectId); } catch (e) {
    return { state: 'invalid', backend: ref.backend, kind: ref.kind, detail: redact((e as Error).message) };
  }
  if (!token) return { state: 'missing', backend: ref.backend, kind: ref.kind, detail: `reference ${ref.ref} exists but the token is gone` };
  const problems: string[] = [];
  try { if (checkClaudeTokenFormat(token).kind !== ref.kind) problems.push('stored token does not match the recorded kind'); } catch { problems.push('stored value is not a Claude token'); }
  if (ref.backend === 'file') {
    const p = await fileModeProblem(CLAUDE_HEADLESS_CREDENTIAL, projectId);
    if (p) problems.push(p);
  }
  return { state: problems.length ? 'invalid' : 'ok', backend: ref.backend, kind: ref.kind, detail: [`${ref.kind} stored in ${shortWhere(ref.backend)}`, ...problems].join('; ') };
}

// ---------------------------------------------------------------- container secrets dir

/** Host path of a kind's materialized copy inside the mounted secrets directory. */
export const secretFile = (projectId: string, kind: CredentialKind) => join(projectPaths(projectId).secretsDir, kind.fileName);

export type Materialized = Record<CredentialKind['name'], boolean>;

/**
 * Ensures the mounted secrets directory exists (0700; 0750 with a private group, see secrets-access.ts)
 * and writes every provisioned token into it (0600; 0640) via an atomic rename, removing stale copies of kinds that are not provisioned. A store read
 * failure for one kind keeps its last materialized copy (the directory is bind-mounted into a possibly
 * running container, which must not lose the token) and is rethrown after the other kinds are handled.
 */
export async function materializeSecrets(projectId: string, runner: Runner = run, access: SecretsAccess = probeSecretsAccess()): Promise<Materialized> {
  await prepareSecretsDir(projectPaths(projectId).secretsDir, access);
  const out = { telegram: false, codex: false, claude: false } as Materialized;
  for (const f of LEGACY_SECRET_FILES) await rm(join(projectPaths(projectId).secretsDir, f), { force: true });
  let failure: unknown;
  for (const kind of CREDENTIAL_KINDS) {
    const file = secretFile(projectId, kind);
    let token: string | null;
    try { token = await readToken(projectId, kind, runner); } catch (e) { failure ??= e; continue; }
    if (!token) { await rm(file, { force: true }); continue; }
    await atomicWrite(file, token + '\n', { mode: secretFileMode(access), gid: secretGid(access) });
    out[kind.name] = true;
  }
  if (failure) throw failure;
  return out;
}

/** Removes materialized secrets (container stopped / uninstall). Keeps the directory for the mount. */
export async function clearSecrets(projectId: string): Promise<void> {
  for (const kind of CREDENTIAL_KINDS) await rm(secretFile(projectId, kind), { force: true });
  for (const f of LEGACY_SECRET_FILES) await rm(join(projectPaths(projectId).secretsDir, f), { force: true });
}

// ---------------------------------------------------------------- status (doctor)

export type CredentialState = 'ok' | 'missing' | 'invalid' | 'unverified';
export interface CredentialStatus { state: CredentialState; detail: string; backend?: Backend }

async function fileModeProblem(kind: StoreKind, projectId: string): Promise<string | null> {
  const mode = (await stat(new FileStore(kind).path(projectId))).mode & 0o777;
  return mode & 0o077 ? `token file mode is ${mode.toString(8)} (expected 600)` : null;
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
  const where = shortWhere(ref.backend);
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

// ---------------------------------------------------------------- publisher bot token (host-wide)

// One token per host (PUBLISHER_CREDENTIAL, store account "publisher"; docs/design/autonomy.md Decision 17). Its
// non-secret reference lives in <MINIONS_HOME>/publisher/credential.json (0600: backend, locator, bot id), never in a
// project's credentials.json, so it is never materialized into a secrets directory or mounted. selectStore picks the
// file store while any project uses the host runtime (sandboxed agents can reach the Keychain service), and
// moveKeychainTokensToFileStore moves it there when a project switches to the host runtime later.

export const PublisherCredentialRefSchema = z.object({
  version: z.literal(1),
  backend: z.enum(BACKENDS),
  ref: z.string().min(1),
  botId: z.string().regex(/^\d{6,12}$/),
  updatedAt: z.string(),
}).strict();
export type PublisherCredentialRef = z.infer<typeof PublisherCredentialRefSchema>;

/** The publisher token's reference, or null when none is stored. An unreadable file is an error (INVALID_CONFIG). */
export async function loadPublisherCredentialRef(): Promise<PublisherCredentialRef | null> {
  return (await readJsonIfExists(publisherPaths().credentialJson, PublisherCredentialRefSchema)) ?? null;
}

async function savePublisherCredentialRef(ref: PublisherCredentialRef): Promise<void> {
  await privateDir(publisherPaths().dir);
  await writeJson(publisherPaths().credentialJson, ref, { mode: 0o600 });
}

export interface PublisherProvisionOptions extends StoreOptions {
  token: string;
  /** Bot API getMe check; only with the user's explicit consent (default off). */
  verify?: boolean;
  fetch?: Fetch;
  store?: SecretStore;
}
export interface PublisherProvisionResult { backend: Backend; ref: string; botId: string; verification: Verification | null; warnings: string[] }

/**
 * Validates the format, refuses a bot that is any project's coordinator bot (CONFLICT: that token is readable in a
 * runtime, so an agent could poll the bot and see or answer its updates), optionally verifies with getMe (an invalid
 * token is not stored), stores the token and records its bot id.
 */
export async function provisionPublisherToken(opts: PublisherProvisionOptions): Promise<PublisherProvisionResult> {
  const runner = opts.runner ?? run;
  const { token, botId } = checkTelegramTokenFormat(opts.token);
  const coordinators = await projectsUsingBot(botId);
  if (coordinators.length) {
    throw new MinionsError('CONFLICT', `Bot ${botId} is the coordinator bot of project(s) ${coordinators.join(', ')}; the publisher needs a bot of its own.`,
      `Create a separate bot (${BOTFATHER_URL}, /newbot): a coordinator's token is readable in its runtime, the publisher's never is.`);
  }
  const warnings: string[] = [];
  let verification: Verification | null = null;
  if (opts.verify) {
    verification = await verifyTelegramToken(token, { fetch: opts.fetch });
    if (verification.status === 'invalid') {
      throw new MinionsError('AUTH_REQUIRED', `Publisher bot token not stored: ${verification.detail}.`, `Copy the token again from ${BOTFATHER_URL} (/mybots -> API Token).`);
    }
    if (verification.status === 'unverified') warnings.push(`Token stored without verification: ${verification.detail}.`);
  }
  const store = opts.store ?? await selectStore({ ...opts, runner, kind: PUBLISHER_CREDENTIAL });
  const prev = await loadPublisherCredentialRef().catch(() => null);
  await store.set(PUBLISHER_ACCOUNT, token);
  if (prev && prev.backend !== store.backend) await storeFor(prev.backend, runner, PUBLISHER_CREDENTIAL).delete(PUBLISHER_ACCOUNT);
  const ref: PublisherCredentialRef = { version: 1, backend: store.backend, ref: store.ref(PUBLISHER_ACCOUNT), botId, updatedAt: new Date().toISOString() };
  await savePublisherCredentialRef(ref);
  return { backend: ref.backend, ref: ref.ref, botId, verification, warnings };
}

/** Reads the publisher token (host only: the publisher process). Null when none is stored. */
export async function readPublisherToken(runner: Runner = run): Promise<{ token: string; botId: string } | null> {
  const ref = await loadPublisherCredentialRef();
  if (!ref) return null;
  const token = await storeFor(ref.backend, runner, PUBLISHER_CREDENTIAL).get(PUBLISHER_ACCOUNT);
  if (!token) return null;
  if (checkTelegramTokenFormat(token).botId !== ref.botId) {
    throw new MinionsError('INVALID_CONFIG', `The stored publisher bot token does not match the recorded bot ${ref.botId}.`, `Store it again with \`${PUBLISHER_CREDENTIAL.command}\`.`);
  }
  return { token, botId: ref.botId };
}

/** Deletes the stored publisher token and its reference. */
export async function removePublisherToken(runner: Runner = run): Promise<{ removed: boolean; backend: Backend | null }> {
  const ref = await loadPublisherCredentialRef().catch(() => null);
  if (ref) await storeFor(ref.backend, runner, PUBLISHER_CREDENTIAL).delete(PUBLISHER_ACCOUNT);
  await rm(publisherPaths().credentialJson, { force: true });
  return { removed: !!ref, backend: ref?.backend ?? null };
}
