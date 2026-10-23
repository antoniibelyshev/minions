// How the container user (uid/gid 1000) reads the host-provisioned secret files in the bind-mounted
// secrets directory (GitHub/Telegram tokens, Claude key copy).
//
// - macOS (Docker Desktop maps ownership), unknown uid, or host uid 1000: `owner` — dir 0700, files 0600,
//   no group_add. This path is byte-identical to the original behavior.
// - Linux, rootful Docker Engine, host uid != 1000: bind mounts keep host ownership, so 0600 files are
//   unreadable for uid 1000. When the host user's primary group is a private user group (same name as
//   the user, no other member in any /etc/group entry with that gid, no other account with that primary
//   gid), the secrets are shared through that group: `group_add: ["<gid>"]` in compose.yaml, dir 0750 /
//   files 0640 with that group. Granting the group read access exposes nothing to other host users,
//   because nobody else is in it.
// - Otherwise (shared primary group such as `users`, root, account not in /etc/passwd): `unsupported` —
//   modes stay 0700/0600 and `minions doctor` (docker.uid) refuses with a hint.
// - Rootless Docker (the Docker endpoint is a socket in the user's runtime dir, or `docker info` says so
//   in doctor): `owner`. Group sharing cannot reach the container user there (uid 1000 maps to a
//   subordinate host uid); `minions doctor` warns (docker.rootless).
// Never chown to uid 1000 and never ACLs for uid 1000: on the host that uid may be another person.
// The group lookup reads /etc/passwd and /etc/group (no getent): accounts only known through NSS
// (LDAP, SSSD) fall back to `unsupported`, which is the safe side. Group members added only through NSS
// (LDAP/SSSD membership of a local gid) are NOT visible here; docs/compatibility.md documents this.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, chown, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureDir } from '../core/fsutil.js';

/** In-container uid/gid of the `node` user the compose file runs as (`user: "1000:1000"`). */
export const CONTAINER_UID = 1000;

export type SecretsAccess =
  | { mode: 'owner' }
  | { mode: 'group'; gid: number; group: string; user: string }
  | { mode: 'unsupported'; reason: string };

export interface IdentityFacts {
  platform: NodeJS.Platform;
  /** Host uid running the CLI; null when unknown. */
  uid: number | null;
  /** Contents of /etc/passwd and /etc/group; null when unreadable. */
  passwd: string | null;
  group: string | null;
  /** Docker runs rootless: group sharing cannot reach the container user, so owner mode is kept. */
  rootless?: boolean;
}

interface PasswdEntry { name: string; uid: number; gid: number }
interface GroupEntry { name: string; gid: number; members: string[] }

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !/^[+-]/.test(l));
const int = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

export function parsePasswd(s: string): PasswdEntry[] {
  const out: PasswdEntry[] = [];
  for (const l of lines(s)) {
    const f = l.split(':');
    const uid = int(f[2]), gid = int(f[3]);
    if (f[0] && uid !== null && gid !== null) out.push({ name: f[0], uid, gid });
  }
  return out;
}

export function parseGroup(s: string): GroupEntry[] {
  const out: GroupEntry[] = [];
  for (const l of lines(s)) {
    const f = l.split(':');
    const gid = int(f[2]);
    if (f[0] && gid !== null) out.push({ name: f[0], gid, members: (f[3] ?? '').split(',').map((m) => m.trim()).filter(Boolean) });
  }
  return out;
}

/** Pure decision over injected identity facts (see the header comment). */
export function secretsAccessFor(f: IdentityFacts): SecretsAccess {
  if (f.platform !== 'linux' || f.uid === null || f.uid === CONTAINER_UID || f.rootless) return { mode: 'owner' };
  if (f.uid === 0) return { mode: 'unsupported', reason: 'minions runs as root (uid 0); its group must not be added to the container user' };
  if (f.passwd === null || f.group === null) return { mode: 'unsupported', reason: '/etc/passwd or /etc/group is unreadable, so the primary group cannot be checked' };
  const users = parsePasswd(f.passwd);
  const me = users.find((u) => u.uid === f.uid);
  if (!me) return { mode: 'unsupported', reason: `uid ${f.uid} has no entry in /etc/passwd (directory accounts via LDAP/SSSD are not checked)` };
  if (me.gid === 0) return { mode: 'unsupported', reason: `the primary group of ${me.name} is root (gid 0)` };
  // Every /etc/group entry with this gid counts (aliases sharing one gid grant the same access), and so
  // does every passwd account with it as primary gid. The first entry is the name getgrgid and ls show.
  const grps = parseGroup(f.group).filter((g) => g.gid === me.gid);
  const grp = grps[0];
  if (!grp) return { mode: 'unsupported', reason: `the primary group gid ${me.gid} of ${me.name} has no entry in /etc/group` };
  const members = new Set([...grps.flatMap((g) => g.members), ...users.filter((u) => u.gid === me.gid).map((u) => u.name)]);
  members.delete(me.name);
  if (grp.name !== me.name || members.size > 0) {
    const others = [...members].sort();
    return { mode: 'unsupported', reason: `the primary group ${grp.name} (gid ${me.gid}) is not a private user group`
      + (others.length ? ` (other members: ${others.join(', ')})` : ` (its name differs from the user ${me.name})`) };
  }
  return { mode: 'group', gid: me.gid, group: grp.name, user: me.name };
}

const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

export interface RootlessOptions {
  uid: number;
  env?: NodeJS.ProcessEnv;
  /** Reads a file as UTF-8, null when unreadable. */
  readFile?: (path: string) => string | null;
}

const parseJson = (s: string | null): unknown => { try { return s === null ? null : JSON.parse(s) as unknown; } catch { return null; } };

/**
 * Best-effort synchronous rootless check that never runs docker: the Docker endpoint (DOCKER_HOST, else
 * the endpoint of DOCKER_CONTEXT or of the CLI config's currentContext) is a unix socket in the user's
 * runtime dir (/run/user/<uid>/ or $XDG_RUNTIME_DIR), or the context is named `rootless` and its
 * endpoint is unreadable.
 */
export function dockerLooksRootless(opts: RootlessOptions): boolean {
  const env = opts.env ?? process.env;
  const read = opts.readFile ?? readOrNull;
  let host: string | null = env.DOCKER_HOST || null;
  if (!host) {
    const cfgDir = env.DOCKER_CONFIG || join(env.HOME || homedir(), '.docker');
    const ctx: unknown = env.DOCKER_CONTEXT || (parseJson(read(join(cfgDir, 'config.json'))) as { currentContext?: unknown } | null)?.currentContext;
    if (typeof ctx !== 'string' || !ctx || ctx === 'default') return false;
    const meta = parseJson(read(join(cfgDir, 'contexts', 'meta', createHash('sha256').update(ctx).digest('hex'), 'meta.json'))) as
      { Endpoints?: { docker?: { Host?: unknown } } } | null;
    const h = meta?.Endpoints?.docker?.Host;
    if (typeof h !== 'string' || !h) return ctx === 'rootless';
    host = h;
  }
  if (!host.startsWith('unix://')) return false;
  const sock = host.slice('unix://'.length);
  const dirs = [`/run/user/${opts.uid}/`];
  if (env.XDG_RUNTIME_DIR) dirs.push(env.XDG_RUNTIME_DIR.replace(/\/*$/, '/'));
  return dirs.some((d) => sock.startsWith(d));
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  uid?: number | null;
  /** Reads a file as UTF-8, null when unreadable (tests inject fake /etc/passwd and /etc/group). */
  readFile?: (path: string) => string | null;
  /** Environment for the rootless check (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Known rootless state (doctor: from `docker info`); undefined runs dockerLooksRootless. */
  rootless?: boolean;
}

/** Probes the current host (synchronous: a few small file reads, only on Linux with uid != 1000). */
export function probeSecretsAccess(opts: ProbeOptions = {}): SecretsAccess {
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (platform !== 'linux' || uid === null || uid === CONTAINER_UID) return { mode: 'owner' };
  const read = opts.readFile ?? readOrNull;
  const rootless = opts.rootless ?? dockerLooksRootless({ uid, readFile: read, ...(opts.env ? { env: opts.env } : {}) });
  if (rootless) return { mode: 'owner' };
  return secretsAccessFor({ platform, uid, passwd: read('/etc/passwd'), group: read('/etc/group') });
}

export const secretDirMode = (a: SecretsAccess) => (a.mode === 'group' ? 0o750 : 0o700);
export const secretFileMode = (a: SecretsAccess) => (a.mode === 'group' ? 0o640 : 0o600);
/** Group to set on the secrets dir and files; undefined leaves the group unchanged (owner/unsupported). */
export const secretGid = (a: SecretsAccess) => (a.mode === 'group' ? a.gid : undefined);

/**
 * Creates the secrets dir (0700) and applies the access modes to it and to the regular files already in
 * it (so switching between modes needs no reprovisioning). Symlinks are never followed. The group change
 * is to the user's own primary group (allowed for the owner), never to uid/gid 1000. Every group change
 * happens before any mode is widened, so a failed chown never leaves 0750/0640 under the old group.
 */
export async function prepareSecretsDir(dir: string, access: SecretsAccess): Promise<void> {
  await ensureDir(dir, 0o700);
  const gid = secretGid(access);
  const files: { path: string; gid: number; mode: number }[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (st?.isFile()) files.push({ path, gid: st.gid, mode: st.mode & 0o777 });
  }
  if (gid !== undefined) {
    await chown(dir, -1, gid);
    for (const f of files) if (f.gid !== gid) await chown(f.path, -1, gid);
  }
  await chmod(dir, secretDirMode(access));
  for (const f of files) if (f.mode !== secretFileMode(access)) await chmod(f.path, secretFileMode(access));
}
