// How the container user (uid/gid 1000) reads the host-provisioned secret files in the bind-mounted
// secrets directory (GitHub/Telegram tokens, Claude key copy).
//
// - macOS (Docker Desktop maps ownership), unknown uid, or host uid 1000: `owner` — dir 0700, files 0600,
//   no group_add. This path is byte-identical to the original behavior.
// - Linux, rootful Docker Engine, host uid != 1000: bind mounts keep host ownership, so 0600 files are
//   unreadable for uid 1000. When the host user's primary group is a private user group (same name as
//   the user, no other member, no other account with that primary gid), the secrets are shared through
//   that group: `group_add: ["<gid>"]` in compose.yaml, dir 0750 / files 0640 with that group. Granting
//   the group read access exposes nothing to other host users, because nobody else is in it.
// - Otherwise (shared primary group such as `users`, root, account not in /etc/passwd): `unsupported` —
//   modes stay 0700/0600 and `minions doctor` (docker.uid) refuses with a hint.
// Never chown to uid 1000 and never ACLs for uid 1000: on the host that uid may be another person.
// The group lookup reads /etc/passwd and /etc/group (no getent): accounts only known through NSS
// (LDAP, SSSD) fall back to `unsupported`, which is the safe side.
import { readFileSync } from 'node:fs';
import { chmod, chown, lstat, readdir } from 'node:fs/promises';
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
  if (f.platform !== 'linux' || f.uid === null || f.uid === CONTAINER_UID) return { mode: 'owner' };
  if (f.uid === 0) return { mode: 'unsupported', reason: 'minions runs as root (uid 0); its group must not be added to the container user' };
  if (f.passwd === null || f.group === null) return { mode: 'unsupported', reason: '/etc/passwd or /etc/group is unreadable, so the primary group cannot be checked' };
  const users = parsePasswd(f.passwd);
  const me = users.find((u) => u.uid === f.uid);
  if (!me) return { mode: 'unsupported', reason: `uid ${f.uid} has no entry in /etc/passwd (directory accounts via LDAP/SSSD are not checked)` };
  if (me.gid === 0) return { mode: 'unsupported', reason: `the primary group of ${me.name} is root (gid 0)` };
  const grp = parseGroup(f.group).find((g) => g.gid === me.gid);
  if (!grp) return { mode: 'unsupported', reason: `the primary group gid ${me.gid} of ${me.name} has no entry in /etc/group` };
  const members = new Set([...grp.members, ...users.filter((u) => u.gid === me.gid).map((u) => u.name)]);
  members.delete(me.name);
  if (grp.name !== me.name || members.size > 0) {
    const others = [...members].sort();
    return { mode: 'unsupported', reason: `the primary group ${grp.name} (gid ${me.gid}) is not a private user group`
      + (others.length ? ` (other members: ${others.join(', ')})` : ` (its name differs from the user ${me.name})`) };
  }
  return { mode: 'group', gid: me.gid, group: grp.name, user: me.name };
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  uid?: number | null;
  /** Reads a file as UTF-8, null when unreadable (tests inject fake /etc/passwd and /etc/group). */
  readFile?: (path: string) => string | null;
}

const readOrNull = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

/** Probes the current host (synchronous: two small file reads, only on Linux with uid != 1000). */
export function probeSecretsAccess(opts: ProbeOptions = {}): SecretsAccess {
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : null);
  if (platform !== 'linux' || uid === null || uid === CONTAINER_UID) return { mode: 'owner' };
  const read = opts.readFile ?? readOrNull;
  return secretsAccessFor({ platform, uid, passwd: read('/etc/passwd'), group: read('/etc/group') });
}

export const secretDirMode = (a: SecretsAccess) => (a.mode === 'group' ? 0o750 : 0o700);
export const secretFileMode = (a: SecretsAccess) => (a.mode === 'group' ? 0o640 : 0o600);
/** Group to set on the secrets dir and files; undefined leaves the group unchanged (owner/unsupported). */
export const secretGid = (a: SecretsAccess) => (a.mode === 'group' ? a.gid : undefined);

/**
 * Creates the secrets dir and applies the access modes to it and to the regular files already in it
 * (so switching between modes needs no reprovisioning). Symlinks are never followed. The group change
 * is to the user's own primary group (allowed for the owner), never to uid/gid 1000.
 */
export async function prepareSecretsDir(dir: string, access: SecretsAccess): Promise<void> {
  await ensureDir(dir, secretDirMode(access));
  await chmod(dir, secretDirMode(access));
  const gid = secretGid(access);
  if (gid !== undefined) await chown(dir, -1, gid);
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const st = await lstat(p).catch(() => null);
    if (!st?.isFile()) continue;
    if (gid !== undefined && st.gid !== gid) await chown(p, -1, gid);
    if ((st.mode & 0o777) !== secretFileMode(access)) await chmod(p, secretFileMode(access));
  }
}
