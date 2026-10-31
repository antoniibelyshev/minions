// Owner secrets (docs/design/autonomy.md Decision 4): named values only the owner sets, on the host
// (`minions secrets set`, src/host/owner-secrets.ts), each granted to the worker roles that may receive it. The
// dispatcher puts a role's granted secrets into that worker's env; the coordinator sees names and grants, never values.
//
// - Values: <secrets dir>/env/<NAME> (the host-provisioned secrets dir: /opt/minions/secrets in the container,
//   MINIONS_SECRETS_DIR in the host runtime, where the sandbox denies reading it).
// - Manifest (no values): secrets.json next to the runtime config, readable by the coordinator, written by the host.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { RESERVED_ENV, SECRET_NAME } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';

export const MAX_SECRET_BYTES = 64 * 1024;

export const ownerSecretsDir = (secretsDir: string) => join(secretsDir, 'env');
/** The manifest beside the runtime config (`<project>/runtime/secrets.json`, /opt/minions/config/secrets.json). */
export const secretManifestPath = (configJson: string) => join(dirname(configJson), 'secrets.json');

const ManifestSchema = z.object({
  secrets: z.record(z.string(), z.object({ roles: z.array(z.string()), bytes: z.number(), setAt: z.string() })),
});
export type SecretManifest = z.infer<typeof ManifestSchema>;

export function checkSecretName(name: string): string {
  if (!SECRET_NAME.test(name)) throw new MinionsError('PRECONDITION', `Invalid secret name "${name.slice(0, 70)}".`, 'Use an env-style name: A-Z, 0-9 and _, starting with a letter (e.g. NPM_TOKEN).');
  if (RESERVED_ENV.test(name)) throw new MinionsError('PRECONDITION', `The name ${name} is reserved (minions sets it, or it changes what programs run).`, 'Choose another name.');
  return name;
}

export function readManifest(file: string): SecretManifest {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch { return { secrets: {} }; }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { json = null; }
  const r = ManifestSchema.safeParse(json);
  if (!r.success) throw new MinionsError('INVALID_CONFIG', `The secret manifest ${file} is invalid.`, 'Run `minions secrets list` on the host to rewrite it.');
  return r.data;
}

/** Names, grants and set times (never values). */
export function listGrants(manifest: SecretManifest): { name: string; roles: string[]; bytes: number; setAt: string }[] {
  return Object.entries(manifest.secrets).sort(([a], [b]) => a.localeCompare(b)).map(([name, s]) => ({ name, ...s }));
}

/**
 * The secrets granted to `role` for its worker env. A granted secret whose value is missing refuses the launch, so the
 * stage waits for the owner instead of running without it.
 */
export function secretEnv(secretsDir: string, manifest: SecretManifest, role: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, roles } of listGrants(manifest)) {
    if (!roles.includes(role)) continue;
    checkSecretName(name);
    try { out[name] = readFileSync(join(ownerSecretsDir(secretsDir), name), 'utf8'); } catch {
      throw new MinionsError('PRECONDITION', `The secret ${name} granted to ${role} has no stored value.`, `Ask the owner to run \`minions secrets set ${name}\` on the host.`);
    }
  }
  return out;
}
