// Pins the host's secrets-access probe to `owner` mode (dir 0700, files 0600) for suites that assert those
// modes through the code's default probe (materializeSecrets, writeKeyFile, composeYaml, ...).
//
// Without it the result depends on who runs the tests: on Linux with uid != 1000 and a private user
// group (a GitHub runner: uid 1001, group `runner`), the probe correctly picks `group` mode (0750/0640, see
// src/host/secrets-access.ts), while this dev container (uid 1000) gets `owner`. Group mode has its own
// tests with injected identity facts (secrets-access*.test.ts). A call with explicit options (the doctor's
// linux-host facts, the probe tests) still reaches the real probe.
//
// Usage, at the top of a test file (the factory must not reference top-level imports):
//   vi.mock('../../src/host/secrets-access.js', async (orig) =>
//     (await import('./pin-secrets-access.js')).pinOwnerAccess(await orig()));
import type * as SecretsAccessModule from '../../src/host/secrets-access.js';

type Mod = typeof SecretsAccessModule;

/** `original`: the real module (vi.mock's importOriginal()). */
export function pinOwnerAccess(original: unknown): Mod {
  const real = original as Mod;
  const probeSecretsAccess: Mod['probeSecretsAccess'] = (opts) => (opts === undefined ? { mode: 'owner' } : real.probeSecretsAccess(opts));
  return { ...real, probeSecretsAccess };
}
