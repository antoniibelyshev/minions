import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { workerRole } from '../../src/config/roles.js';
import { journalPath } from '../../src/runtime/control.js';
import { listSecrets, removeSecret, secretEnv, secretsDir, setSecret } from '../../src/runtime/secrets.js';
import { preFileHook } from '../../src/runtime/hooks.js';
import { defaults } from '../helpers.js';

let state: string;
beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'minions-secrets-')); });
afterEach(() => rmSync(state, { recursive: true, force: true }));

describe('coordinator-stored secrets', () => {
  it('stores privately, lists names only, journals a fingerprint and never the value', async () => {
    const r = await setSecret(state, 'NPM_TOKEN', 'npm_s3cret\n', { reason: 'publish to npm' });
    expect(r).toMatchObject({ name: 'NPM_TOKEN', bytes: 10, replaced: false });
    expect(statSync(join(secretsDir(state), 'NPM_TOKEN')).mode & 0o777).toBe(0o600);
    expect(statSync(secretsDir(state)).mode & 0o777).toBe(0o700);
    expect(listSecrets(state)).toEqual([expect.objectContaining({ name: 'NPM_TOKEN', bytes: 10 })]);
    const journal = readFileSync(journalPath(state), 'utf8');
    expect(journal).toContain('NPM_TOKEN');
    expect(journal).not.toContain('npm_s3cret');
    expect((await setSecret(state, 'NPM_TOKEN', 'other', { reason: 'rotated' })).replaced).toBe(true);
    expect(await removeSecret(state, 'NPM_TOKEN', { reason: 'unused' })).toEqual({ name: 'NPM_TOKEN', removed: true });
    expect(listSecrets(state)).toEqual([]);
  });

  it('refuses bad and reserved names, empty values and a missing reason', async () => {
    await expect(setSecret(state, 'npm-token', 'x', { reason: 'r' })).rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(setSecret(state, 'ANTHROPIC_API_KEY', 'x', { reason: 'r' })).rejects.toThrow(/reserved/);
    await expect(setSecret(state, 'MINIONS_WORKER_LEASE', 'x', { reason: 'r' })).rejects.toThrow(/reserved/);
    await expect(setSecret(state, 'API_KEY', '\n', { reason: 'r' })).rejects.toThrow(/empty/);
    await expect(setSecret(state, 'API_KEY', 'x', { reason: ' ' })).rejects.toThrow(/reason/);
  });

  it('a role declares the secrets its workers get; an unstored one refuses the launch', async () => {
    const cfg = validateConfig({ ...defaults(), roles: { engineer: { secrets: ['NPM_TOKEN'] }, writer: { description: 'Writes.', promptText: 'Write.', contract: 'producer', edits: 'any', secrets: ['DOCS_KEY'] } } });
    expect(workerRole(cfg, 'engineer')!.secrets).toEqual(['NPM_TOKEN']);
    expect(workerRole(cfg, 'reviewer')!.secrets).toEqual([]);
    expect(() => validateConfig({ ...defaults(), roles: { engineer: { secrets: ['bad name'] } } })).toThrow();
    await setSecret(state, 'NPM_TOKEN', 'tok', { reason: 'r' });
    expect(secretEnv(state, workerRole(cfg, 'engineer')!.secrets)).toEqual({ NPM_TOKEN: 'tok' });
    expect(() => secretEnv(state, workerRole(cfg, 'writer')!.secrets)).toThrow(/DOCS_KEY, which is not stored/);
  });

  it('workers cannot read the store: it is under the guarded state dir', () => {
    const file = join('/state', 'control', 'secrets', 'NPM_TOKEN');
    const r = preFileHook({ tool_name: 'Read', tool_input: { file_path: file }, agent_id: 'a1', cwd: '/workspace/worktrees/x' });
    expect(r.reason).toMatch(/^deny/);
  });
});
