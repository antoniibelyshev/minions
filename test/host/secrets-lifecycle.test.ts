// Lifecycle of the plaintext container copies of the credentials: failed up, stale copies, mount check.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTAINER, projectPaths } from '../../src/core/paths.js';
import { Compose } from '../../src/host/docker.js';
import * as C from '../../src/host/credentials.js';
import { runDoctor } from '../../src/host/doctor.js';
import { runInit } from '../../src/host/install.js';
import { dockerUp, makeRepo, withHome } from './fixtures.js';

type RunResult = import('../../src/core/exec.js').RunResult;
const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';

let env: ReturnType<typeof withHome>;
let prev: string | undefined;
beforeEach(() => { env = withHome(); prev = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prev === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prev;
  env.cleanup();
});

async function plant(projectId: string) {
  await mkdir(projectPaths(projectId).secretsDir, { recursive: true });
  for (const k of C.CREDENTIAL_KINDS) await writeFile(C.secretFile(projectId, k), 'secret\n', { mode: 0o600 });
}
const copies = (projectId: string) => C.CREDENTIAL_KINDS.map((k) => existsSync(C.secretFile(projectId, k)));
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

describe('container copy lifecycle', () => {
  it('removes copies of every kind when compose.up fails and rethrows', async () => {
    await plant(ID);
    const err = new Error('up failed');
    await expect(C.upClearingSecretsOnFailure({ up: async () => { throw err; } }, ID)).rejects.toBe(err);
    expect(copies(ID)).toEqual([false, false]);
  });

  it('keeps the copies when compose.up succeeds', async () => {
    await plant(ID);
    await C.upClearingSecretsOnFailure({ up: async () => undefined }, ID);
    expect(copies(ID)).toEqual([true, true]);
  });

  it('clearStaleSecrets removes copies only when no container is running', async () => {
    await plant(ID);
    expect(await C.clearStaleSecrets(ID, true)).toBe(false);
    expect(copies(ID)).toEqual([true, true]);
    expect(await C.clearStaleSecrets(ID, false)).toBe(true);
    expect(copies(ID)).toEqual([false, false]);
    expect(await C.clearStaleSecrets(ID, false)).toBe(false);
  });

  it('doctor removes stale copies when the container is not running, keeps the stored original', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const id = r.plan.projectId;
    await new C.FileStore().set(id, TOKEN);
    await plant(id);
    const runner = async (_c: string, args: string[]): Promise<RunResult> => ok(args.includes('ps') ? '' : '');
    const doc = await runDoctor({ cwd: repo, probe: dockerUp, runner });
    expect(doc.checks.find((c) => c.name === 'secrets.copy')).toMatchObject({ status: 'warn' });
    expect(copies(id)).toEqual([false, false]);
    expect(existsSync(new C.FileStore().path(id))).toBe(true);
  });

  it('doctor leaves copies alone when the container is running', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const id = r.plan.projectId;
    await plant(id);
    const runner = async (_c: string, args: string[]): Promise<RunResult> => args.includes('ps') ? ok('abc\n') : ok('{}');
    const doc = await runDoctor({ cwd: repo, probe: dockerUp, runner });
    expect(doc.checks.find((c) => c.name === 'secrets.copy')).toBeUndefined();
    expect(copies(id)).toEqual([true, true]);
  });
});

describe('Compose.hasSecretsMount', () => {
  const runnerWith = (mounts: unknown, running = true) => async (_c: string, args: string[]): Promise<RunResult> => {
    if (args[0] === 'inspect') { expect(args).toEqual(['inspect', '--format', '{{json .Mounts}}', 'abc123']); return ok(JSON.stringify(mounts)); }
    return ok(running ? 'abc123\n' : '');
  };
  it('is true only when /opt/minions/secrets is among the container mounts', async () => {
    expect(await new Compose(ID, runnerWith([{ Destination: '/workspace' }, { Destination: CONTAINER.secretsDir }])).hasSecretsMount()).toBe(true);
    expect(await new Compose(ID, runnerWith([{ Destination: '/workspace' }])).hasSecretsMount()).toBe(false);
    expect(await new Compose(ID, runnerWith([], false)).hasSecretsMount()).toBe(false);
  });
});
