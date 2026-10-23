// Restart-required detection (task-3.4): the host compares the running container with what
// `minions upgrade` would give it now (image build/id, container CLI version, secrets bind mount,
// coordinator launch fingerprint) and reports reasons plus the exact command. Fake runners only: no Docker.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { CONTAINER, projectPaths } from '../../src/core/paths.js';
import { Compose } from '../../src/host/docker.js';
import {
  RESTART_COMMAND, checkRestartRequired, formatRestartRequired, hostStatus, type RestartRequired,
} from '../../src/host/restart-required.js';
import { coordinatorLaunchStatus, launchFingerprint, readMountedToken } from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), 'coordinator\n');
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { runDoctor } = await import('../../src/host/doctor.js');
const { projectForPath } = await import('../../src/host/registry.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

const FP = 'fp-current';
const HOST_VERSION = '1.2.3';
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr = 'unavailable'): RunResult => ({ code: 1, stdout: '', stderr });

interface World {
  state: 'running' | 'exited' | 'error' | 'throw';
  containerImage: string;
  containerLabel: string;
  tagId: string | null;
  mounts: { Type: string; Source: string; Destination: string; RW: boolean }[] | null;
  cliVersion: string | null;
  launch: { state: string; reason: string } | null | 'no-status';
}

function world(projectId: string, over: Partial<World> = {}): World {
  return {
    state: 'running', containerImage: 'sha256:aaa', containerLabel: FP, tagId: 'sha256:aaa',
    mounts: [{ Type: 'bind', Source: projectPaths(projectId).secretsDir, Destination: CONTAINER.secretsDir, RW: false }],
    cliVersion: HOST_VERSION, launch: { state: 'current', reason: 'coordinator launched' }, ...over,
  };
}

/** Fake `docker`: compose ps / inspect / image inspect / exec, driven by `w`. Records argv. */
function fakeDocker(w: World, calls: string[] = []) {
  return async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
    const a = args.join(' ');
    calls.push(`${cmd} ${a}`);
    if (w.state === 'throw') throw new Error('spawn docker ENOENT');
    if (cmd !== 'docker') return fail();
    if (a.includes(' ps -a --format json')) {
      if (w.state === 'error') return fail('Cannot connect to the Docker daemon');
      return ok(JSON.stringify({ State: w.state }) + '\n');
    }
    if (a.includes(' ps --status running -q')) return w.state === 'running' ? ok('cid123\n') : ok('');
    if (a === 'inspect cid123') {
      if (!w.mounts) return fail('inspect failed');
      return ok(JSON.stringify([{ Id: 'cid123', Image: w.containerImage, Config: { Labels: { 'minions.build': w.containerLabel } }, Mounts: w.mounts }]));
    }
    if (a.startsWith('image inspect --format {{.Id}}')) return w.tagId ? ok(w.tagId + '\n') : fail('No such image');
    if (a.startsWith('image inspect')) return ok(FP + '\n'); // doctor's build-label check
    if (a.endsWith('exec -T app minions --version')) return w.cliVersion ? ok(w.cliVersion + '\n') : fail('minions: not found');
    if (a.endsWith('exec -T app minions status --json')) {
      if (w.launch === 'no-status') return fail('boom');
      return ok(JSON.stringify({ ok: true, data: { paused: { intake: false, starts: false }, activeLeases: [], queue: {}, guard: { lastReason: null },
        configRevision: 1, profile: 'p', deliveryMode: 'local', capacity: null, ...(w.launch ? { coordinatorLaunch: w.launch } : {}) } }) + '\n');
    }
    if (a.endsWith('claude auth status') || a.endsWith('backlog --version')) return ok('1.0\n');
    return fail();
  };
}

const check = (projectId: string, w: World, calls?: string[]) => {
  const runner = fakeDocker(w, calls);
  return checkRestartRequired({ projectId, imageTag: 'minions-runtime:test', compose: new Compose(projectId, runner), runner, fingerprint: FP, version: HOST_VERSION });
};
const kinds = (r: RestartRequired) => r.reasons.map((x) => x.kind);

describe('checkRestartRequired', () => {
  const id = 'proj-1';

  it('current when the container matches the installed package', async () => {
    const r = await check(id, world(id));
    expect(r).toMatchObject({ state: 'current', required: false, reasons: [], unchecked: [], command: null });
    expect(formatRestartRequired(r)).toEqual(['restart required: no']);
  });

  it('newer image: build label differs from the installed fingerprint, or a newer image id for the tag', async () => {
    let r = await check(id, world(id, { containerLabel: 'fp-old' }));
    expect(r).toMatchObject({ state: 'required', required: true, command: RESTART_COMMAND });
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'image', running: 'fp-old', current: FP })]);
    r = await check(id, world(id, { tagId: 'sha256:bbb' }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'image', running: 'sha256:aaa', current: 'sha256:bbb', detail: expect.stringContaining('newer minions-runtime:test image') })]);
    // Unlabeled image (built by an older minions): also outdated.
    expect(kinds(await check(id, world(id, { containerLabel: '' })))).toEqual(['image']);
  });

  it('CLI version mismatch inside the container', async () => {
    const r = await check(id, world(id, { cliVersion: '1.2.2' }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'cli-version', running: '1.2.2', current: HOST_VERSION })]);
    expect(r.command).toBe('minions upgrade');
  });

  it('credential mounts missing, from another host path, or writable', async () => {
    let r = await check(id, world(id, { mounts: [] }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'credential-mounts', detail: expect.stringContaining('not mounted') })]);
    r = await check(id, world(id, { mounts: [{ Type: 'bind', Source: '/elsewhere/secrets', Destination: CONTAINER.secretsDir, RW: false }] }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'credential-mounts', running: '/elsewhere/secrets' })]);
    r = await check(id, world(id, { mounts: [{ Type: 'bind', Source: projectPaths(id).secretsDir, Destination: CONTAINER.secretsDir, RW: true }] }));
    expect(kinds(r)).toEqual(['credential-mounts']);
  });

  it('stale coordinator launch fingerprint', async () => {
    const r = await check(id, world(id, { launch: { state: 'stale', reason: 'communication.channel changed since the coordinator launched (terminal -> telegram)' } }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'coordinator-launch', detail: expect.stringContaining('terminal -> telegram') })]);
  });

  it('collects every reason at once and formats them with the command', async () => {
    const r = await check(id, world(id, { containerLabel: 'old', cliVersion: '0.9.0', mounts: [], launch: { state: 'stale', reason: 'x' } }));
    expect(kinds(r)).toEqual(['image', 'credential-mounts', 'cli-version', 'coordinator-launch']);
    const lines = formatRestartRequired(r);
    expect(lines[0]).toBe('restart required (run `minions upgrade`):');
    expect(lines).toHaveLength(5);
  });

  it('not running / Docker errors / runner throwing: never throws, reports not-running or unknown', async () => {
    expect((await check(id, world(id, { state: 'exited' }))).state).toBe('not-running');
    expect(await check(id, world(id, { state: 'error' }))).toMatchObject({ state: 'unknown', required: false, command: null });
    expect(await check(id, world(id, { state: 'throw' }))).toMatchObject({ state: 'unknown', required: false });
  });

  it('unreadable parts are unchecked (unknown) unless a reason is found', async () => {
    let r = await check(id, world(id, { mounts: null, cliVersion: null, launch: 'no-status' }));
    expect(r).toMatchObject({ state: 'unknown', required: false, reasons: [] });
    expect(r.unchecked.map((u) => u.kind)).toEqual(['image', 'credential-mounts', 'cli-version', 'coordinator-launch']);
    // An older image without coordinatorLaunch: its CLI version mismatch is the reason; no extra unchecked entry.
    r = await check(id, world(id, { cliVersion: '0.1.0', launch: null }));
    expect(r).toMatchObject({ state: 'required', unchecked: [] });
    // Running coordinator without a launch record: cannot compare, so unknown rather than required.
    r = await check(id, world(id, { launch: { state: 'unrecorded', reason: 'no launch record' } }));
    expect(r).toMatchObject({ state: 'unknown', unchecked: [{ kind: 'coordinator-launch', detail: 'no launch record' }] });
  });

  it('reuses a status the caller already read instead of exec-ing again', async () => {
    const calls: string[] = [];
    const runner = fakeDocker(world(id), calls);
    const r = await checkRestartRequired({ projectId: id, imageTag: 't', compose: new Compose(id, runner), runner, fingerprint: FP, version: HOST_VERSION,
      status: { coordinatorLaunch: { state: 'stale', reason: 'token changed' } } });
    expect(kinds(r)).toEqual(['coordinator-launch']);
    expect(calls.some((c) => c.endsWith('minions status --json'))).toBe(false);
  });
});

describe('doctor and status integration', () => {
  it('doctor reports the restart check and restartRequired (--json data); never a FAIL', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const { projectId } = await projectForPath(repo);
    const base = world(projectId);
    let r = await runDoctor({ cwd: repo, probe: dockerUp, runner: fakeDocker(base), fingerprint: FP, version: HOST_VERSION });
    expect(r.restartRequired.state).toBe('current');
    expect(r.checks.find((c) => c.name === 'restart')).toMatchObject({ status: 'ok' });

    r = await runDoctor({ cwd: repo, probe: dockerUp, runner: fakeDocker({ ...base, cliVersion: '0.0.1', mounts: [] }), fingerprint: FP, version: HOST_VERSION });
    expect(r.restartRequired).toMatchObject({ state: 'required', command: 'minions upgrade' });
    expect(r.restartRequired.reasons.map((x) => x.kind)).toEqual(['credential-mounts', 'cli-version']);
    const c = r.checks.find((x) => x.name === 'restart');
    expect(c).toMatchObject({ status: 'warn', hint: 'Run `minions upgrade`.' });
    expect(JSON.parse(JSON.stringify(r)).restartRequired.reasons).toHaveLength(2);

    // docker compose ps failing: the restart check is unknown (a warning), never a FAIL.
    r = await runDoctor({ cwd: repo, probe: dockerUp, runner: fakeDocker({ ...base, state: 'error' }), fingerprint: FP, version: HOST_VERSION });
    expect(r.restartRequired).toMatchObject({ state: 'unknown', required: false });
    expect(r.checks.find((x) => x.name === 'restart')?.status).toBe('warn');
    // Container gone: nothing to restart (`minions start` uses the current image).
    r = await runDoctor({ cwd: repo, probe: dockerUp, runner: fakeDocker({ ...base, state: 'exited' }), fingerprint: FP, version: HOST_VERSION });
    expect(r.restartRequired.state).toBe('not-running');
    expect(r.checks.find((x) => x.name === 'restart')?.status).toBe('ok');
  });

  it('doctor with Docker unavailable reports unknown', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const { dockerDown } = await import('./fixtures.js');
    const r = await runDoctor({ cwd: repo, probe: dockerDown, runner: fakeDocker(world('x')), fingerprint: FP, version: HOST_VERSION });
    expect(r.restartRequired).toMatchObject({ state: 'unknown', detail: 'Docker unavailable' });
    expect(r.checks.find((x) => x.name === 'restart')?.status).toBe('warn');
  });

  it('host status merges the container status with restartRequired', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const { projectId } = await projectForPath(repo);
    const h = await hostStatus({ cwd: repo, runner: fakeDocker(world(projectId, { containerLabel: 'old' })), fingerprint: FP, version: HOST_VERSION });
    expect(h.kind).toBe('report');
    if (h.kind !== 'report') return;
    expect(h.status).toMatchObject({ configRevision: 1, coordinatorLaunch: { state: 'current' } });
    expect(h.restartRequired).toMatchObject({ state: 'required', command: 'minions upgrade', reasons: [expect.objectContaining({ kind: 'image' })] });

    const raw = await hostStatus({ cwd: repo, runner: fakeDocker(world(projectId, { launch: 'no-status' })), fingerprint: FP, version: HOST_VERSION });
    expect(raw.kind).toBe('raw');
    await expect(hostStatus({ cwd: repo, runner: fakeDocker(world(projectId, { state: 'exited' })) })).rejects.toThrow(/not running/);
  });
});

describe('coordinatorLaunchStatus (container side)', () => {
  function layout() {
    const root = join(env.root, 'rt');
    for (const d of ['secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
    return runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') });
  }
  const tmux = (running: boolean) => async (): Promise<RunResult> => ({ code: running ? 0 : 1, stdout: '', stderr: '' });

  it('not-running, unrecorded, current and stale', async () => {
    const paths = layout();
    const cfg = defaults();
    expect((await coordinatorLaunchStatus(cfg, { paths, runner: tmux(false) })).state).toBe('not-running');
    expect((await coordinatorLaunchStatus(cfg, { paths, runner: tmux(true) })).state).toBe('unrecorded');
    const fp = launchFingerprint(cfg, await readMountedToken(paths.telegramTokenFile));
    const record = (fingerprint: string, channel: string) => writeFileSync(paths.coordinatorLaunch, JSON.stringify({ version: 1, pid: 1, startedAt: '2026-10-23T00:00:00Z', fingerprint, channel, telegram: { enabled: false, reason: 'terminal' } }));
    record(fp, cfg.communication.channel);
    expect((await coordinatorLaunchStatus(cfg, { paths, runner: tmux(true) })).state).toBe('current');
    record('other', cfg.communication.channel);
    expect(await coordinatorLaunchStatus(cfg, { paths, runner: tmux(true) })).toMatchObject({ state: 'stale', reason: expect.stringContaining('Telegram configuration changed') });
    record('other', cfg.communication.channel === 'telegram' ? 'terminal' : 'telegram');
    expect(await coordinatorLaunchStatus(cfg, { paths, runner: tmux(true) })).toMatchObject({ state: 'stale', reason: expect.stringContaining('communication.channel changed') });
  });
});
