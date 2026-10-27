// task-14.6: the `codex` credential kind (an OpenAI API key for Codex process workers, agent-runtimes D5).
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Secrets modes under the default (owner) access, whoever runs the suite: see pin-secrets-access.ts.
vi.mock('../../src/host/secrets-access.js', async (orig) => (await import('./pin-secrets-access.js')).pinOwnerAccess(await orig()));
import * as C from '../../src/host/credentials.js';
import { CONTAINER, projectPaths } from '../../src/core/paths.js';
import { makeRepo, withHome } from './fixtures.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const KEY = 'sk-proj-AbcdefghijklmnopqrstuvwxyzABCDEF0123456789';
const KEY2 = 'sk-proj-Rotatedrotatedrotatedrotated9876543210';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

describe('codex credential kind', () => {
  it('checks the key shape without echoing it', () => {
    expect(C.checkOpenAiKeyFormat(`  ${KEY}\n`).token).toBe(KEY);
    for (const bad of ['', 'not-a-key', 'sk-short', `sk-${'a'.repeat(30)} x`, `"${KEY}"`]) {
      let msg = '';
      try { C.checkOpenAiKeyFormat(bad); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toBe('');
      expect(msg).not.toContain(KEY);
    }
    expect(C.codexKeyGuidance().join('\n')).toMatch(/CODEX_API_KEY, never as an argument/);
    expect(C.CREDENTIAL_KINDS.map((k) => k.name)).toEqual(['github', 'telegram', 'codex']);
    expect(C.CODEX_CREDENTIAL.fileName).toBe('codex-api-key');
    expect(CONTAINER.codexKeyFile.endsWith('/codex-api-key')).toBe(true);
  });

  it('provisions, rotates, materializes, reports status and removes the key; status never includes it', async () => {
    const repo = makeRepo(env.root);
    expect((await C.codexCredentialStatus(ID)).state).toBe('missing');
    const r = await C.provisionCodexKey({ projectId: ID, token: KEY, repoPath: repo });
    expect(r).toMatchObject({ projectId: ID, backend: 'file', warnings: [] });
    expect((await C.loadCredentialRefs(ID)).codex).toMatchObject({ backend: 'file' });
    expect(await C.readCodexKey(ID)).toBe(KEY);
    expect(await C.codexCredentialStatus(ID)).toMatchObject({ state: 'ok', backend: 'file' });

    await C.provisionCodexKey({ projectId: ID, token: KEY2, repoPath: repo });
    expect(await C.readCodexKey(ID)).toBe(KEY2);
    expect(await C.materializeSecrets(ID)).toEqual({ github: false, telegram: false, codex: true });
    const mounted = `${projectPaths(ID).secretsDir}/codex-api-key`;
    expect(readFileSync(mounted, 'utf8')).toBe(KEY2 + '\n');
    expect(statSync(mounted).mode & 0o777).toBe(0o600);

    const file = new C.FileStore(C.CODEX_CREDENTIAL).path(ID);
    chmodSync(file, 0o644);
    expect(await C.codexCredentialStatus(ID)).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/mode is 644/) });
    chmodSync(file, 0o600);
    writeFileSync(file, 'garbage-not-a-key\n');
    const s = await C.codexCredentialStatus(ID);
    expect(s).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/not an OpenAI API key/) });

    await C.removeCodexKey(ID);
    expect((await C.codexCredentialStatus(ID)).state).toBe('missing');
    expect(JSON.stringify(s)).not.toMatch(/sk-proj/);
  });

  it('refuses a malformed key before storing anything', async () => {
    const repo = makeRepo(env.root);
    await expect(C.provisionCodexKey({ projectId: ID, token: 'ghp_wrongkind', repoPath: repo })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect((await C.loadCredentialRefs(ID)).codex).toBeUndefined();
  });
});
