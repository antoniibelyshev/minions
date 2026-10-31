// Owner secrets, host side (docs/design/autonomy.md Decision 4; the read side is src/runtime/secrets.ts). Only the
// host CLI writes them: the value file under the project's secrets dir (bind-mounted read-only into the container,
// denied to the host-runtime sandbox) and the value-free manifest beside the runtime config.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SECRET_NAME } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import { checkSecretName, listGrants, MAX_SECRET_BYTES, ownerSecretsDir, readManifest, type SecretManifest } from '../runtime/secrets.js';
import { prepareSecretsDir, probeSecretsAccess, secretFileMode, secretGid, type SecretsAccess } from './secrets-access.js';

const ROLE = /^[a-z][a-z0-9-]{0,39}$/;
const manifestFile = (projectId: string) => join(projectPaths(projectId).runtimeDir, 'secrets.json');
const valuesDir = (projectId: string) => ownerSecretsDir(projectPaths(projectId).secretsDir);

function checkRoles(roles: readonly string[]): string[] {
  for (const r of roles) if (!ROLE.test(r)) throw new MinionsError('PRECONDITION', `Invalid role name "${r.slice(0, 40)}".`, 'Use a role name such as engineer or tester.');
  return [...new Set(roles)].sort();
}

async function save(projectId: string, m: SecretManifest): Promise<void> {
  await writeJson(manifestFile(projectId), m, { mode: 0o644 });
}

export function ownerSecrets(projectId: string) { return listGrants(readManifest(manifestFile(projectId))); }

/** Stores (or replaces) a value; `roles` adds grants. Returns names and grants, never the value. */
export async function setOwnerSecret(projectId: string, name: string, value: string, o: { roles?: string[]; now?: Date; access?: SecretsAccess } = {}) {
  checkSecretName(name);
  const v = value.replace(/\r?\n$/, '');
  if (!v) throw new MinionsError('PRECONDITION', 'The secret is empty.');
  if (Buffer.byteLength(v) > MAX_SECRET_BYTES) throw new MinionsError('PRECONDITION', `The secret is larger than ${MAX_SECRET_BYTES} bytes.`);
  const roles = checkRoles(o.roles ?? []);
  const access = o.access ?? probeSecretsAccess();
  await prepareSecretsDir(projectPaths(projectId).secretsDir, access);
  await prepareSecretsDir(valuesDir(projectId), access);
  await atomicWrite(join(valuesDir(projectId), name), v, { mode: secretFileMode(access), gid: secretGid(access) });
  const m = readManifest(manifestFile(projectId));
  const prev = m.secrets[name];
  m.secrets[name] = { roles: [...new Set([...(prev?.roles ?? []), ...roles])].sort(), bytes: Buffer.byteLength(v), setAt: (o.now ?? new Date()).toISOString() };
  await save(projectId, m);
  return { name, replaced: !!prev, ...m.secrets[name]! };
}

/** Adds (`grant`) or removes (`revoke`) roles of a stored secret. */
export async function changeGrant(projectId: string, name: string, roles: string[], op: 'grant' | 'revoke') {
  checkSecretName(name);
  const m = readManifest(manifestFile(projectId));
  const s = m.secrets[name];
  if (!s) throw new MinionsError('NOT_FOUND', `No secret ${name} is stored.`, `Store it first: \`minions secrets set ${name}\`.`);
  const rs = checkRoles(roles);
  s.roles = op === 'grant' ? [...new Set([...s.roles, ...rs])].sort() : s.roles.filter((r) => !rs.includes(r));
  await save(projectId, m);
  return { name, roles: s.roles };
}

export async function removeOwnerSecret(projectId: string, name: string) {
  checkSecretName(name);
  const m = readManifest(manifestFile(projectId));
  const removed = !!m.secrets[name];
  delete m.secrets[name];
  await rm(join(valuesDir(projectId), name), { force: true });
  await save(projectId, m);
  return { name, removed };
}

/** Value files with no manifest entry (a crash between the two writes): listed so the owner can remove them. */
export async function strayValues(projectId: string): Promise<string[]> {
  const known = new Set(Object.keys(readManifest(manifestFile(projectId)).secrets));
  try { return (await readdir(valuesDir(projectId))).filter((n) => SECRET_NAME.test(n) && !known.has(n)).sort(); } catch { return []; }
}
