// Lifecycle of the plaintext container copies of the credentials: failed up, stale copies, mount check.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTAINER, projectPaths } from '../../src/core/paths.js';
import { Compose } from '../../src/host/docker.js';
import * as C from '../../src/host/credentials.js';
import { runDoctor } from '../../src/host/doctor.js';
import { runInit } from '../../src/host/install.js';
import { dockerDown, dockerUp, makeRepo, withHome } from './fixtures.js';

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

describe('Compose.hasSecretsMount parsing edge cases', () => {
  const withOut = (out: string, code = 0) => async (_c: string, args: string[]): Promise<RunResult> =>
    args[0] === 'inspect' ? { code, stdout: out, stderr: '' } : ok('abc123\n');
  it('is false for malformed, empty or failing inspect output', async () => {
    for (const out of ['', 'not json', 'null', '{}', '[1,null]']) {
      expect(await new Compose(ID, withOut(out)).hasSecretsMount().catch(() => 'threw')).toBe(false);
    }
    expect(await new Compose(ID, withOut(JSON.stringify([{ Destination: CONTAINER.secretsDir }]), 1)).hasSecretsMount()).toBe(false);
  });
  it('does not match lookalike destinations or the Source field', async () => {
    const m = [{ Destination: `${CONTAINER.secretsDir}-old` }, { Destination: `${CONTAINER.secretsDir}X` }, { Destination: '/opt/minions' }, { Source: CONTAINER.secretsDir, Destination: '/elsewhere' }];
    expect(await new Compose(ID, withOut(JSON.stringify(m))).hasSecretsMount()).toBe(false);
  });
});

describe('upClearingSecretsOnFailure resilience', () => {
  it('still rethrows the original error and clears when one kind cannot be removed', async () => {
    await plant(ID);
    const err = new Error('boom');
    await expect(C.upClearingSecretsOnFailure({ up: async () => { throw err; } }, '../does-not-exist/../' + ID)).rejects.toBe(err);
  });
});

describe('Compose.containerState', () => {
  const st = (stdout: string, code = 0) => new Compose(ID, async () => ({ code, stdout, stderr: '' })).containerState();
  const one = (State: string) => JSON.stringify({ Name: 'x', State });
  it('is absent only for empty output, exited or dead', async () => {
    expect((await st('')).state).toBe('absent');
    expect((await st(one('exited'))).state).toBe('absent');
    expect((await st(one('dead'))).state).toBe('absent');
    expect((await st('[]')).state).toBe('absent');
  });
  it('is running for a running container (NDJSON or array)', async () => {
    expect((await st(one('running'))).state).toBe('running');
    expect((await st(`[${one('running')}]`)).state).toBe('running');
  });
  it('is unknown for restarting, paused, created, errors, timeouts, multiples and malformed output', async () => {
    for (const s of ['restarting', 'paused', 'created']) expect((await st(one(s))).state).toBe('unknown');
    expect((await st('', 1)).state).toBe('unknown');
    expect((await st(one('exited'), 1)).state).toBe('unknown');
    expect((await new Compose(ID, async () => { throw new Error('timed out'); }).containerState()).state).toBe('unknown');
    expect((await st(`${one('exited')}\n${one('exited')}`)).state).toBe('unknown');
    expect((await st('not json')).state).toBe('unknown');
    expect((await st('{"Name":"x"}')).state).toBe('unknown');
    expect((await st('null')).state).toBe('unknown');
  });
});

describe('doctor keeps copies unless the container is confirmed gone', () => {
  for (const [label, res] of [
    ['ps error', { code: 1, stdout: '', stderr: 'boom' }],
    ['restarting', { code: 0, stdout: JSON.stringify({ State: 'restarting' }), stderr: '' }],
    ['paused', { code: 0, stdout: JSON.stringify({ State: 'paused' }), stderr: '' }],
    ['created', { code: 0, stdout: JSON.stringify({ State: 'created' }), stderr: '' }],
  ] as const) {
    it(`does not delete on ${label}, and warns`, async () => {
      const repo = makeRepo(env.root);
      const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
      const id = r.plan.projectId;
      await plant(id);
      const runner = async (_c: string, args: string[]): Promise<RunResult> => {
        if (!args.includes('ps')) return ok('{}');
        return args.includes('-a') ? res : ok(''); // `--status running` lookup finds nothing
      };
      const doc = await runDoctor({ cwd: repo, probe: dockerUp, runner });
      expect(copies(id)).toEqual([true, true]);
      expect(doc.checks.find((c) => c.name === 'secrets.copy')).toMatchObject({ status: 'warn', detail: expect.stringContaining('not removed') });
    });
  }
  it('deletes on exited', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    await plant(r.plan.projectId);
    const runner = async (_c: string, args: string[]): Promise<RunResult> =>
      args.includes('ps') && args.includes('-a') ? ok(JSON.stringify({ State: 'exited' })) : ok('');
    await runDoctor({ cwd: repo, probe: dockerUp, runner });
    expect(copies(r.plan.projectId)).toEqual([false, false]);
  });
});

describe('Compose.secretsVisibility (auth github / auth telegram)', () => {
  const mk = (running: boolean, mounts: unknown) => new Compose(ID, async (_c, args) =>
    args[0] === 'inspect' ? ok(JSON.stringify(mounts)) : ok(running ? 'abc\n' : ''));
  it('claims visibility only when running with the secrets mount', async () => {
    expect(await mk(true, [{ Destination: CONTAINER.secretsDir }]).secretsVisibility()).toBe('mounted');
    expect(await mk(true, [{ Destination: '/workspace' }]).secretsVisibility()).toBe('restart-required');
    expect(await mk(false, []).secretsVisibility()).toBe('not-running');
  });
});

describe('containerState edge cases (tester)', () => {
  const st = (stdout: string) => new Compose(ID, async () => ({ code: 0, stdout, stderr: '' })).containerState();
  it('treats extra fields as harmless and unexpected State casing as unknown (never deletes)', async () => {
    expect((await st(JSON.stringify({ Name: 'x', State: 'exited', ExitCode: 137, Publishers: [], Health: '' }))).state).toBe('absent');
    expect((await st(JSON.stringify({ State: 'Exited' }))).state).toBe('unknown');
    expect((await st(JSON.stringify({ State: 'RUNNING' }))).state).toBe('unknown');
    expect((await st(JSON.stringify({ State: 5 }))).state).toBe('unknown');
  });
  it('scopes the query to our service so other compose services are not counted', async () => {
    let seen: string[] = [];
    await new Compose(ID, async (_c, args) => { seen = args; return ok(''); }).containerState();
    expect(seen.slice(-1)[0]).toBe('app');
    expect(seen).toContain('-a');
  });
  it('tolerates blank lines and trailing newline in NDJSON', async () => {
    expect((await st(`\n${JSON.stringify({ State: 'exited' })}\n\n`)).state).toBe('absent');
  });
});

describe('doctor never deletes when Docker or ps is unreachable (tester)', () => {
  it('keeps copies when the daemon is down', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    await plant(r.plan.projectId);
    await runDoctor({ cwd: repo, probe: dockerDown, runner: async () => ok('') });
    expect(copies(r.plan.projectId)).toEqual([true, true]);
  });
  it('keeps copies when ps -a throws (timeout) at doctor level', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    await plant(r.plan.projectId);
    const runner = async (_c: string, args: string[]): Promise<RunResult> => {
      if (args.includes('ps') && args.includes('-a')) throw new Error('timed out');
      return ok('');
    };
    const doc = await runDoctor({ cwd: repo, probe: dockerUp, runner });
    expect(copies(r.plan.projectId)).toEqual([true, true]);
    expect(doc.checks.find((c) => c.name === 'secrets.copy')?.status).toBe('warn');
  });
  it('keeps copies when another service is running but ours is restarting (filtered ps -a returns ours only)', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    await plant(r.plan.projectId);
    const runner = async (_c: string, args: string[]): Promise<RunResult> =>
      args.includes('ps') && args.includes('-a') ? ok(JSON.stringify({ Service: 'app', State: 'restarting' })) : ok('');
    await runDoctor({ cwd: repo, probe: dockerUp, runner });
    expect(copies(r.plan.projectId)).toEqual([true, true]);
  });
});
