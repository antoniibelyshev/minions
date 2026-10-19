// In-container GitHub authentication (decision record: docs/design/bootstrap.md, "GitHub in the container").
//
// - The token lives only in the read-only mounted file GITHUB_TOKEN_CONTAINER_PATH and is read at
//   use time (the host may replace it atomically or remove it at any moment).
// - git: `credential.https://github.com.helper` in the repository config points at
//   `minions git-credential`, which answers `get` for https://github.com with the token. The token
//   never enters .git/config, remote URLs, argv, or the environment.
// - gh: /usr/local/bin/gh is a wrapper (docker/gh-wrapper.sh) that reads the same file and sets
//   GH_TOKEN only in the environment of the exec'd gh process.
import { readFile, stat } from 'node:fs/promises';
import { GITHUB_TOKEN_CONTAINER_PATH } from '../core/paths.js';
import { redact } from '../core/output.js';
import type { RunResult } from '../core/exec.js';
import { git as realGit } from './worktree.js';

export type GitFn = (cwd: string, args: string[], allowFailure?: boolean) => Promise<RunResult>;

/** Credential helper command as configured in git (absolute path, fixed arguments, no user input). */
export const GIT_CREDENTIAL_HELPER = '/usr/local/bin/minions git-credential';
export const GITHUB_CREDENTIAL_KEY = 'credential.https://github.com.helper';
export const GITHUB_TOKEN_USERNAME = 'x-access-token';

// Same shapes as host-side checkTokenFormat; also guarantees no whitespace/newlines, so the token
// cannot inject extra lines into the git credential protocol.
const TOKEN_RE = /^(?:github_pat_[A-Za-z0-9_]{20,255}|gh[pousr]_[A-Za-z0-9]{20,255})$/;

export type TokenState =
  | { state: 'absent' }
  | { state: 'ok'; token: string }
  | { state: 'unreadable'; message: string }
  | { state: 'invalid'; message: string };

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** Reads the mounted token now. Never throws; never includes the token in a message. */
export async function readGithubToken(file: string = GITHUB_TOKEN_CONTAINER_PATH): Promise<TokenState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
    if (code === 'EACCES' || code === 'EPERM') {
      const owner = await stat(file).then((s) => ` (owner uid ${s.uid}, mode ${(s.mode & 0o777).toString(8).padStart(4, '0')})`, () => '');
      return {
        state: 'unreadable',
        message: `GitHub token file ${file} is not readable by container uid ${uid()}${owner}. ` +
          'On a Linux Docker Engine host the 0600 token file must be owned by uid 1000 (the container user): ' +
          'run minions as a host user with uid 1000. Until then git and gh in the container run unauthenticated.',
      };
    }
    return { state: 'unreadable', message: `Cannot read GitHub token file ${file}: ${code ?? (e as Error).message}.` };
  }
  const token = raw.trim();
  if (!token) return { state: 'absent' };
  if (!TOKEN_RE.test(token)) return { state: 'invalid', message: `GitHub token file ${file} does not contain a GitHub token; re-provision it with \`minions auth github\` on the host.` };
  return { state: 'ok', token };
}

/**
 * Normalizes a GitHub remote to `https://github.com/<owner>/<repo>.git` (credentials, ports and
 * scp/ssh forms dropped). Returns null for anything that is not a github.com repository URL.
 */
export function normalizeGithubRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.trim();
  const path = '([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?';
  const forms = [
    new RegExp(`^(?:[A-Za-z0-9_.-]+@)?github\\.com:${path}$`), // scp-like: git@github.com:o/r.git
    new RegExp(`^(?:https?|ssh|git)://(?:[^@/]*@)?github\\.com(?::\\d+)?/${path}$`, 'i'),
  ];
  for (const re of forms) {
    const m = re.exec(s);
    if (!m) continue;
    const [, owner, repo] = m as unknown as [string, string, string];
    if ([owner, repo].some((p) => p === '.' || p === '..' || p.startsWith('-'))) return null;
    return `https://github.com/${owner}/${repo}.git`;
  }
  return null;
}

/** Parses git credential protocol input (key=value lines, blank line ends). */
export function parseCredentialInput(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    if (!line) break;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * `git credential` helper. Answers only `get` for https://github.com; `store`/`erase` and other
 * hosts produce no output. Returns stdout text and an optional stderr diagnostic (never the token).
 */
export async function gitCredential(operation: string, input: string, opts: { tokenFile?: string } = {}): Promise<{ stdout: string; stderr?: string }> {
  if (operation !== 'get') return { stdout: '' };
  const req = parseCredentialInput(input);
  if (req.protocol !== 'https' || req.host?.toLowerCase() !== 'github.com') return { stdout: '' };
  const t = await readGithubToken(opts.tokenFile);
  if (t.state === 'ok') return { stdout: `username=${GITHUB_TOKEN_USERNAME}\npassword=${t.token}\n` };
  if (t.state === 'absent') return { stdout: '', stderr: `minions: no GitHub token is provisioned (${opts.tokenFile ?? GITHUB_TOKEN_CONTAINER_PATH} is absent); run \`minions auth github\` on the host.` };
  return { stdout: '', stderr: `minions: ${t.message}` };
}

export interface OriginResult {
  url: string;
  /** True when the GitHub credential helper is configured and a readable token was present. */
  authenticated: boolean;
  /** True when the base branch was fetched from origin into refs/remotes/origin/<base>. */
  fetched: boolean;
  warnings: string[];
}

/**
 * Records `remoteUrl` as origin. Without a readable credential (or for non-GitHub remotes) this is
 * exactly the v0.1 behaviour: the URL is recorded verbatim and never fetched, and the result is
 * null. With a credential, origin is set to the normalized https URL, the repository-level GitHub
 * credential helper is configured, and the base branch is fetched (fetch failure only warns).
 */
export async function configureOrigin(repo: string, opts: { remoteUrl?: string; base: string; tokenFile?: string; helper?: string; git?: GitFn }): Promise<OriginResult | null> {
  if (!opts.remoteUrl) return null;
  const git = opts.git ?? realGit;
  const setOrigin = async (url: string) => {
    const has = await git(repo, ['remote', 'get-url', 'origin'], true);
    await git(repo, has.code === 0 ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  };
  const https = normalizeGithubRemote(opts.remoteUrl);
  const token = https ? await readGithubToken(opts.tokenFile) : { state: 'absent' as const };
  if (!https || token.state === 'absent') {
    await setOrigin(opts.remoteUrl);
    return null;
  }
  if (token.state !== 'ok') {
    await setOrigin(opts.remoteUrl);
    return { url: opts.remoteUrl, authenticated: false, fetched: false, warnings: [`${token.message} Origin was recorded but not fetched.`] };
  }
  await setOrigin(https);
  // An empty helper entry first resets any inherited helpers for github.com; ours is the only one.
  await git(repo, ['config', '--unset-all', GITHUB_CREDENTIAL_KEY], true);
  await git(repo, ['config', '--add', GITHUB_CREDENTIAL_KEY, '']);
  await git(repo, ['config', '--add', GITHUB_CREDENTIAL_KEY, opts.helper ?? GIT_CREDENTIAL_HELPER]);
  const warnings: string[] = [];
  const f = await git(repo, ['fetch', '--no-tags', 'origin', `+refs/heads/${opts.base}:refs/remotes/origin/${opts.base}`], true);
  if (f.code !== 0) warnings.push(`Fetching ${opts.base} from origin failed: ${redact(f.stderr.trim()).slice(-500) || `git exit ${f.code}`}`);
  return { url: https, authenticated: true, fetched: f.code === 0, warnings };
}
