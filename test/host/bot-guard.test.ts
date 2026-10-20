// One Telegram bot, one coordinator (host-side check before a launch). Temp MINIONS_HOME, file
// credential store, fake docker runner: no Docker, Keychain, network, or live state.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertBotFree, dockerCoordinatorPollsBot, findBotConflict } from '../../src/host/bot-guard.js';
import { provisionTelegramToken } from '../../src/host/credentials.js';
import type { ProjectJson } from '../../src/host/project.js';
import { saveRegistry } from '../../src/host/registry.js';
import { projectPaths } from '../../src/core/paths.js';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { MinionsError } from '../../src/core/errors.js';
import { defaults } from '../helpers.js';
import { makeRepo, withHome } from './fixtures.js';

const A = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const C = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const OTHER_BOT = '987654321:CCHotherbototherbototherbotother_-55';
const SECRET = TOKEN.split(':')[1]!;

const project = (projectId: string, over: Partial<ProjectJson> = {}): ProjectJson => ({
  version: 1, projectId, repoPath: `/r/${projectId}`, gitCommonDir: `/r/${projectId}/.git`, visibility: 'private', profile: 'project-owner',
  imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null, gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 2, memoryMiB: 4096, pidsLimit: 512, publishPorts: [], network: 'outbound-internet' }, ...over,
});
const cfg = (channel: 'auto' | 'telegram' | 'terminal') => { const c = defaults(); c.communication.channel = channel; return c; };

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

async function threeProjectsSharingABot() {
  const repo = makeRepo(env.root);
  await saveRegistry({ version: 1, projects: {
    [A]: { gitCommonDir: '/a/.git', repoPath: '/a', visibility: 'private' },
    [B]: { gitCommonDir: '/b/.git', repoPath: '/b', visibility: 'private' },
    [C]: { gitCommonDir: '/c/.git', repoPath: '/c', visibility: 'private' },
  } });
  await provisionTelegramToken({ projectId: A, token: TOKEN, repoPath: repo });
  await provisionTelegramToken({ projectId: B, token: TOKEN, repoPath: repo });
  await provisionTelegramToken({ projectId: C, token: OTHER_BOT, repoPath: repo });
}

describe('one bot, one coordinator', () => {
  it('refuses a Telegram coordinator while another project polls the same bot; the token is never printed', async () => {
    await threeProjectsSharingABot();
    const polled: string[] = [];
    const err = await assertBotFree(project(A), cfg('telegram'), { coordinatorPollsBot: async (id) => { polled.push(id); return true; } }).catch((e: unknown) => e);
    expect(polled).toEqual([B]); // C uses another bot and is not even checked
    expect(err).toBeInstanceOf(MinionsError);
    const e = err as MinionsError;
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toMatch(new RegExp(`Telegram bot 123456789 is already polled by the running coordinator of project\\(s\\) ${B}`));
    expect(e.message).toMatch(/was not started/);
    expect(e.hint).toMatch(/minions channel set terminal/);
    expect(e.hint).toMatch(/minions down/);
    expect(JSON.stringify({ m: e.message, h: e.hint, d: e.details })).not.toContain(SECRET);
  });

  it('auto with a stored token is Telegram too, and is refused the same way', async () => {
    await threeProjectsSharingABot();
    await expect(assertBotFree(project(A), cfg('auto'), { coordinatorPollsBot: async () => true })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('terminal mode still starts: no check, even with the same bot polled elsewhere', async () => {
    await threeProjectsSharingABot();
    let checked = false;
    await expect(assertBotFree(project(A), cfg('terminal'), { coordinatorPollsBot: async () => { checked = true; return true; } })).resolves.toBeUndefined();
    expect(checked).toBe(false);
  });

  it('auto without a stored token is terminal mode: never checked, never refused', async () => {
    await threeProjectsSharingABot();
    const D = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
    let checked = false;
    await expect(assertBotFree(project(D), cfg('auto'), { coordinatorPollsBot: async () => { checked = true; return true; } })).resolves.toBeUndefined();
    expect(checked).toBe(false);
  });

  it('allows the launch when the other project is stopped or terminal-only, and when no token is stored', async () => {
    await threeProjectsSharingABot();
    await expect(assertBotFree(project(A), cfg('telegram'), { coordinatorPollsBot: async () => false })).resolves.toBeUndefined();
    await expect(assertBotFree(project(A), cfg('telegram'), { coordinatorPollsBot: async () => { throw new Error('docker gone'); } })).resolves.toBeUndefined();
    expect(await findBotConflict('00000000-0000-4000-8000-000000000000', { coordinatorPollsBot: async () => true })).toBeNull();
    expect(await findBotConflict(C, { coordinatorPollsBot: async () => true })).toBeNull();
  });
});

describe('dockerCoordinatorPollsBot (fake docker)', () => {
  type Call = { args: string[]; opts?: RunOptions };
  function docker(s: { running: boolean; session: boolean; status?: string }) {
    const calls: Call[] = [];
    const runner = async (_cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
      calls.push({ args, opts });
      if (args.includes('ps')) return { code: 0, stdout: s.running ? 'abc123\n' : '', stderr: '' };
      if (args.includes('has-session')) return { code: s.session ? 0 : 1, stdout: '', stderr: '' };
      if (args.includes('telegram')) return { code: 0, stdout: s.status ?? '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    return { calls, runner };
  }
  const status = (enabled: boolean) => JSON.stringify({ ok: true, data: { access: { state: 'ok' }, coordinator: { telegram: { enabled, reason: 'x' } } } });
  const writeProject = (p: ProjectJson) => {
    const file = projectPaths(p.projectId).projectJson;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(p));
  };

  it('true only for a running Docker coordinator session launched with Telegram', async () => {
    writeProject(project(B));
    expect(await dockerCoordinatorPollsBot(B, docker({ running: true, session: true, status: status(true) }).runner)).toBe(true);
    expect(await dockerCoordinatorPollsBot(B, docker({ running: true, session: true, status: status(false) }).runner)).toBe(false);
    expect(await dockerCoordinatorPollsBot(B, docker({ running: true, session: false, status: status(true) }).runner)).toBe(false);
    expect(await dockerCoordinatorPollsBot(B, docker({ running: false, session: true, status: status(true) }).runner)).toBe(false);
    // Running session with an unreadable launch record: assume it polls (fail safe).
    expect(await dockerCoordinatorPollsBot(B, docker({ running: true, session: true, status: 'garbage' }).runner)).toBe(true);
    const d = docker({ running: true, session: true, status: status(true) });
    await dockerCoordinatorPollsBot(B, d.runner);
    expect(d.calls.find((c) => c.args.includes('has-session'))!.args.slice(-4)).toEqual(['tmux', 'has-session', '-t', 'coordinator']);
  });

  it('host-runtime and unknown projects never poll (no Telegram there)', async () => {
    writeProject(project(B, { runtime: 'host' }));
    const d = docker({ running: true, session: true, status: status(true) });
    expect(await dockerCoordinatorPollsBot(B, d.runner)).toBe(false);
    expect(await dockerCoordinatorPollsBot(C, d.runner)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});
