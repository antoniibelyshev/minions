// Owner secrets and the coordinator's plain env (docs/design/autonomy.md Decision 4).
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { projectPaths } from '../../src/core/paths.js';
import { changeGrant, ownerSecrets, removeOwnerSecret, setOwnerSecret, strayValues } from '../../src/host/owner-secrets.js';
import { hostSettings, ownerSecretDenies } from '../../src/runtime/coordinator.js';
import { readManifest, secretEnv, secretManifestPath } from '../../src/runtime/secrets.js';
import { defaults } from '../helpers.js';

const PID = '11111111-2222-4333-8444-555555555555';
let home: string;
let prev: string | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'minions-secrets-')); prev = process.env.MINIONS_HOME; process.env.MINIONS_HOME = home; });
afterEach(() => { if (prev === undefined) delete process.env.MINIONS_HOME; else process.env.MINIONS_HOME = prev; rmSync(home, { recursive: true, force: true }); });

const owner = { access: { mode: 'owner' } as const };
const pp = () => projectPaths(PID);
const manifest = () => readManifest(secretManifestPath(pp().runtimeConfigJson));

describe('owner secrets', () => {
  it('the host stores the value privately and a value-free manifest; grants decide which role gets it', async () => {
    const r = await setOwnerSecret(PID, 'NPM_TOKEN', 'npm_s3cret\n', { roles: ['engineer'], ...owner });
    expect(r).toMatchObject({ name: 'NPM_TOKEN', bytes: 10, roles: ['engineer'], replaced: false });
    const file = join(pp().secretsDir, 'env', 'NPM_TOKEN');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(pp().secretsDir, 'env')).mode & 0o777).toBe(0o700);
    expect(readFileSync(secretManifestPath(pp().runtimeConfigJson), 'utf8')).not.toContain('npm_s3cret');

    expect(secretEnv(pp().secretsDir, manifest(), 'engineer')).toEqual({ NPM_TOKEN: 'npm_s3cret' });
    expect(secretEnv(pp().secretsDir, manifest(), 'reviewer')).toEqual({});
    await changeGrant(PID, 'NPM_TOKEN', ['reviewer'], 'grant');
    expect(secretEnv(pp().secretsDir, manifest(), 'reviewer')).toEqual({ NPM_TOKEN: 'npm_s3cret' });
    await changeGrant(PID, 'NPM_TOKEN', ['engineer', 'reviewer'], 'revoke');
    expect(ownerSecrets(PID)).toEqual([expect.objectContaining({ name: 'NPM_TOKEN', roles: [] })]);

    // Replacing keeps the grants; removing drops value and entry.
    await changeGrant(PID, 'NPM_TOKEN', ['engineer'], 'grant');
    expect(await setOwnerSecret(PID, 'NPM_TOKEN', 'other', owner)).toMatchObject({ replaced: true, roles: ['engineer'] });
    expect(await removeOwnerSecret(PID, 'NPM_TOKEN')).toEqual({ name: 'NPM_TOKEN', removed: true });
    expect(ownerSecrets(PID)).toEqual([]);
    expect(await strayValues(PID)).toEqual([]);
  });

  it('a granted secret without its value refuses the launch', async () => {
    await setOwnerSecret(PID, 'DOCS_KEY', 'k', { roles: ['writer'], ...owner });
    rmSync(join(pp().secretsDir, 'env', 'DOCS_KEY'));
    expect(() => secretEnv(pp().secretsDir, manifest(), 'writer')).toThrow(/DOCS_KEY granted to writer has no stored value/);
  });

  it('refuses bad and reserved names, bad roles, empty values and grants of an unknown secret', async () => {
    await expect(setOwnerSecret(PID, 'npm-token', 'x', owner)).rejects.toMatchObject({ code: 'PRECONDITION' });
    for (const n of ['ANTHROPIC_API_KEY', 'MINIONS_WORKER_LEASE', 'GIT_SSH_COMMAND', 'NODE_OPTIONS', 'BASH_ENV', 'PATH']) {
      await expect(setOwnerSecret(PID, n, 'x', owner)).rejects.toThrow(/reserved/);
    }
    await expect(setOwnerSecret(PID, 'API_KEY', '\n', owner)).rejects.toThrow(/empty/);
    await expect(setOwnerSecret(PID, 'API_KEY', 'x', { roles: ['Bad Role'], ...owner })).rejects.toThrow(/role name/);
    await expect(changeGrant(PID, 'NOPE', ['engineer'], 'grant')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('agents cannot read the values: denied to the host sandbox and file tools, and to the container file tools', () => {
    const h = hostSettings({ projectDir: '/data/projects/p', workspace: '/data/projects/p/host/workspace', state: '/data/projects/p/host/state', secretsDir: '/data/projects/p/secrets', credentialsDir: '/data/credentials', home: '/Users/me' } as never);
    expect((h.sandbox as { filesystem: { denyRead: string[] } }).filesystem.denyRead).toContain('/data/projects/p/secrets/env');
    expect(h.deny).toEqual(expect.arrayContaining(['Read(//data/projects/p/secrets/env/**)', 'Edit(//data/projects/p/secrets/env/**)']));
    expect(ownerSecretDenies('/opt/minions/secrets')).toEqual(expect.arrayContaining(['Read(//opt/minions/secrets/env/**)']));
  });
});

describe('the coordinator-owned env', () => {
  it('takes plain variables and refuses names that minions sets or that change what programs run', () => {
    expect(validateConfig({ ...defaults(), env: { NODE_ENV: 'production', API_BASE_URL: 'https://example.test', FEATURE_X: '1' } }).env).toMatchObject({ FEATURE_X: '1' });
    for (const n of ['NODE_OPTIONS', 'GIT_SSH_COMMAND', 'LD_PRELOAD', 'BASH_ENV', 'PATH', 'MINIONS_STATE_DIR', 'HTTPS_PROXY', 'PYTHONPATH']) {
      expect(() => validateConfig({ ...defaults(), env: { [n]: 'x' } }), n).toThrow(/reserved/);
    }
    expect(() => validateConfig({ ...defaults(), env: { 'bad-name': 'x' } })).toThrow();
  });
});
