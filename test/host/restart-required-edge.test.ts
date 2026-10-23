// Restart-required detection (task-3.4), edge cases: parse robustness of the container's
// `minions status --json`, image label vs image id disagreement, realpath'd secrets mounts, the doctor
// `restart` check never failing, and host status rendering. Fake runners only: no Docker.
import { mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { CONTAINER, projectPaths } from '../../src/core/paths.js';
import { Compose } from '../../src/host/docker.js';
import {
  RESTART_COMMAND, RESTART_REASON_KINDS, checkRestartRequired, formatRestartRequired, hostStatus, notApplicable, parseStatusEnvelope, restartUnknown,
  type RestartRequired,
} from '../../src/host/restart-required.js';
import { humanStatus, type StatusReport } from '../../src/runtime/commands.js';

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
const { runDoctor, restartCheck } = await import('../../src/host/doctor.js');
const { projectForPath } = await import('../../src/host/registry.js');
const { dockerUp, dockerDown, makeRepo, withHome } = await import('./fixtures.js');

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
const fail = (stderr = 'unavailable', code = 1): RunResult => ({ code, stdout: '', stderr });

const STATUS_DATA = {
  paused: { intake: false, starts: true }, activeLeases: [], queue: { 'To Do': 2 }, guard: { lastReason: null },
  configRevision: 3, profile: 'project-owner', deliveryMode: 'local', capacity: null, coordinatorLock: null,
};

interface World {
  containerImage: string;
  containerLabel: string | undefined;
  tagId: string | null;
  inspectStdout?: string;
  mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
  versionResult: RunResult;
  statusResult: RunResult;
}

function world(projectId: string, over: Partial<World> = {}): World {
  return {
    containerImage: 'sha256:aaa', containerLabel: FP, tagId: 'sha256:aaa',
    mounts: [{ Type: 'bind', Source: projectPaths(projectId).secretsDir, Destination: CONTAINER.secretsDir, RW: false }],
    versionResult: ok(HOST_VERSION + '\n'),
    statusResult: ok(JSON.stringify({ ok: true, data: { ...STATUS_DATA, coordinatorLaunch: { state: 'current', reason: 'ok' } } }) + '\n'),
    ...over,
  };
}

function fakeDocker(w: World) {
  return async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
    const a = args.join(' ');
    if (cmd !== 'docker') return fail();
    if (a.includes(' ps -a --format json')) return ok(JSON.stringify({ State: 'running' }) + '\n');
    if (a.includes(' ps --status running -q')) return ok('cid123\n');
    if (a === 'inspect cid123') {
      if (w.inspectStdout !== undefined) return ok(w.inspectStdout);
      const labels = w.containerLabel === undefined ? null : { 'minions.build': w.containerLabel };
      return ok(JSON.stringify([{ Id: 'cid123', Image: w.containerImage, Config: { Labels: labels }, Mounts: w.mounts }]));
    }
    if (a.startsWith('image inspect --format {{.Id}}')) return w.tagId ? ok(w.tagId + '\n') : fail('No such image');
    if (a.startsWith('image inspect')) return ok(FP + '\n');
    if (a.endsWith('exec -T app minions --version')) return w.versionResult;
    if (a.endsWith('exec -T app minions status --json')) return w.statusResult;
    if (a.endsWith('claude auth status') || a.endsWith('backlog --version')) return ok('1.0\n');
    return fail();
  };
}

const ID = 'proj-edge';
const check = (w: World, fingerprint: string | null = FP) => {
  const runner = fakeDocker(w);
  return checkRestartRequired({ projectId: ID, imageTag: 'minions-runtime:test', compose: new Compose(ID, runner), runner, fingerprint, version: HOST_VERSION });
};
const kinds = (r: RestartRequired) => r.reasons.map((x) => x.kind);

describe('parseStatusEnvelope', () => {
  it('accepts a successful envelope, also after leading log lines', () => {
    expect(parseStatusEnvelope(JSON.stringify({ ok: true, data: { a: 1 } }))).toEqual({ a: 1 });
    expect(parseStatusEnvelope(`warning: something\n${JSON.stringify({ ok: true, data: { a: 2 } })}\n\n`)).toEqual({ a: 2 });
  });

  it('returns null for non-JSON, partial JSON, error envelopes and non-object data', () => {
    for (const s of ['', '   \n', 'config revision 3  profile p', '{"ok":true,"data":{"paused":', '[1,2', 'null', '42',
      JSON.stringify({ ok: false, error: { code: 'PRECONDITION', message: 'x' } }),
      JSON.stringify({ ok: true, data: null }), JSON.stringify({ ok: true, data: 'text' }), JSON.stringify({ ok: true }),
      `${JSON.stringify({ ok: true, data: { a: 1 } })}\ntrailing garbage`]) {
      expect(parseStatusEnvelope(s)).toBeNull();
    }
  });
});

describe('checkRestartRequired edge cases', () => {
  it('image: label vs image id disagreement', async () => {
    // Label differs and the tag was rebuilt: one image reason (the build label one), not two.
    let r = await check(world(ID, { containerLabel: 'fp-old', tagId: 'sha256:bbb' }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'image', running: 'fp-old', current: FP })]);
    // Label differs but the tag still points at the running image (package changed, image not rebuilt yet).
    r = await check(world(ID, { containerLabel: 'fp-old' }));
    expect(kinds(r)).toEqual(['image']);
    // Label matches, tag rebuilt since the container was created.
    r = await check(world(ID, { tagId: 'sha256:ccc' }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'image', running: 'sha256:aaa', current: 'sha256:ccc' })]);
    // Label matches, tag missing (image removed): nothing to compare by id, label is enough -> current.
    r = await check(world(ID, { tagId: null }));
    expect(r.state).toBe('current');
    // No package fingerprint (dev checkout): falls back to the image id comparison.
    r = await check(world(ID, { containerLabel: 'anything', tagId: 'sha256:ddd' }), null);
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'image', current: 'sha256:ddd' })]);
    r = await check(world(ID, { containerLabel: 'anything' }), null);
    expect(r.state).toBe('current');
    // Neither a fingerprint nor the tag: image is unchecked, overall unknown (not required).
    r = await check(world(ID, { tagId: null }), null);
    expect(r).toMatchObject({ state: 'unknown', required: false, command: null, unchecked: [expect.objectContaining({ kind: 'image' })] });
  });

  it('image without labels at all is treated as unlabeled (outdated)', async () => {
    const r = await check(world(ID, { containerLabel: undefined }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'image', running: null, detail: expect.stringContaining('unlabeled') })]);
  });

  it('unparsable docker inspect output leaves image and mounts unchecked, never throws', async () => {
    for (const inspectStdout of ['not json', '[]', '[{"Id":"cid123"}]', '{"Image":']) {
      const r = await check(world(ID, { inspectStdout }));
      expect(r).toMatchObject({ state: 'unknown', required: false });
      expect(r.unchecked.map((u) => u.kind)).toEqual(['image', 'credential-mounts']);
    }
  });

  it('secrets mount compared by realpath (symlinked host path is not a change)', async () => {
    const expected = projectPaths(ID).secretsDir;
    mkdirSync(expected, { recursive: true });
    const link = join(dirname(expected), 'secrets-link');
    symlinkSync(expected, link);
    let r = await check(world(ID, { mounts: [{ Type: 'bind', Source: link, Destination: CONTAINER.secretsDir, RW: false }] }));
    expect(r.state).toBe('current');
    // A mount at another destination does not count as the secrets mount.
    r = await check(world(ID, { mounts: [{ Type: 'bind', Source: expected, Destination: '/elsewhere', RW: false }] }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'credential-mounts', running: null })]);
  });

  it('CLI version: last output line is used; empty or failing output is unchecked', async () => {
    let r = await check(world(ID, { versionResult: ok(`npm notice something\n${HOST_VERSION}\n`) }));
    expect(r.state).toBe('current');
    r = await check(world(ID, { versionResult: ok('') }));
    expect(r).toMatchObject({ state: 'unknown', unchecked: [expect.objectContaining({ kind: 'cli-version' })] });
    r = await check(world(ID, { versionResult: fail('exec failed', 126) }));
    expect(r.unchecked).toEqual([expect.objectContaining({ kind: 'cli-version', detail: expect.stringContaining('exec failed') })]);
  });

  it('container status: non-JSON / partial JSON / error envelope make coordinator-launch unchecked', async () => {
    for (const statusResult of [ok('config revision 3\n'), ok('{"ok":true,"data":{'), ok(JSON.stringify({ ok: false, error: { message: 'db locked' } })), fail('boom')]) {
      const r = await check(world(ID, { statusResult }));
      expect(r).toMatchObject({ state: 'unknown', required: false, reasons: [], unchecked: [expect.objectContaining({ kind: 'coordinator-launch' })] });
    }
  });

  it('coordinatorLaunch shape variations', async () => {
    const withLaunch = (l: unknown) => world(ID, { statusResult: ok(JSON.stringify({ ok: true, data: { ...STATUS_DATA, coordinatorLaunch: l } })) });
    // Coordinator not running inside a running container: nothing stale to report.
    expect((await check(withLaunch({ state: 'not-running', reason: 'coordinator is not running' }))).state).toBe('current');
    // Malformed / partial launch info (older image or bad data): unchecked, not required.
    for (const l of [{}, { state: 7 }, null]) {
      const r = await check(withLaunch(l));
      expect(r).toMatchObject({ state: 'unknown', required: false, unchecked: [expect.objectContaining({ kind: 'coordinator-launch' })] });
    }
    // Stale without a reason still names the fingerprint.
    const r = await check(withLaunch({ state: 'stale' }));
    expect(r.reasons).toEqual([expect.objectContaining({ kind: 'coordinator-launch', detail: expect.stringContaining('stale coordinator launch fingerprint') })]);
  });

  it('every reason kind yields required + the exact command', async () => {
    expect(RESTART_COMMAND).toBe('minions upgrade');
    expect([...RESTART_REASON_KINDS].sort()).toEqual(['cli-version', 'coordinator-launch', 'credential-mounts', 'image']);
    const r = await check(world(ID, { versionResult: ok('0.0.9\n') }));
    expect(r).toMatchObject({ state: 'required', required: true, command: 'minions upgrade' });
    expect(r.detail).toContain('0.0.9');
  });
});

describe('doctor restart check never fails', () => {
  it('restartCheck maps every state to ok/warn/unavailable', () => {
    const required: RestartRequired = { state: 'required', required: true, reasons: [{ kind: 'image', detail: 'x' }], unchecked: [], command: RESTART_COMMAND, detail: 'x' };
    const states: RestartRequired[] = [
      required,
      { state: 'current', required: false, reasons: [], unchecked: [], command: null, detail: 'ok' },
      { state: 'not-running', required: false, reasons: [], unchecked: [], command: null, detail: 'gone' },
      notApplicable('host runtime'),
      restartUnknown('?'),
    ];
    const statuses = states.map((s) => restartCheck(s).status);
    expect(statuses).toEqual(['warn', 'ok', 'ok', 'unavailable', 'warn']);
    expect(restartCheck(required).hint).toContain('minions upgrade');
  });

  it('doctor health is the same whether or not a restart is required', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const { projectId } = await projectForPath(repo);
    const base = await runDoctor({ cwd: repo, probe: dockerUp, runner: fakeDocker(world(projectId)), fingerprint: FP, version: HOST_VERSION });
    const stale = await runDoctor({ cwd: repo, probe: dockerUp, fingerprint: FP, version: HOST_VERSION,
      runner: fakeDocker(world(projectId, { containerLabel: 'old', mounts: [], versionResult: ok('0.0.1\n'),
        statusResult: ok(JSON.stringify({ ok: true, data: { ...STATUS_DATA, coordinatorLaunch: { state: 'stale', reason: 'token' } } })) })) });
    expect(stale.restartRequired.reasons.map((x) => x.kind)).toEqual(['image', 'credential-mounts', 'cli-version', 'coordinator-launch']);
    expect(stale.healthy).toBe(base.healthy);
    expect(stale.checks.filter((c) => c.status === 'fail').map((c) => c.name)).toEqual(base.checks.filter((c) => c.status === 'fail').map((c) => c.name));
    expect(stale.checks.find((c) => c.name === 'restart')?.status).toBe('warn');
    const garbage = await runDoctor({ cwd: repo, probe: dockerUp, fingerprint: FP, version: HOST_VERSION,
      runner: fakeDocker(world(projectId, { inspectStdout: 'nope', versionResult: fail(), statusResult: ok('nope') })) });
    expect(garbage.restartRequired.state).toBe('unknown');
    expect(garbage.checks.find((c) => c.name === 'restart')?.status).toBe('warn');
  });

  it('host runtime: restart check is not applicable', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    const r = await runDoctor({ cwd: repo, probe: dockerDown, runner: async () => fail('not found', 127) });
    expect(r.restartRequired.state).toBe('not-applicable');
    expect(r.checks.find((c) => c.name === 'restart')?.status).toBe('unavailable');
  });
});

describe('host status', () => {
  async function dockerProject() {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const { projectId } = await projectForPath(repo);
    return { repo, projectId };
  }

  it('raw passthrough keeps the container exit code and output for unparsable status', async () => {
    const { repo, projectId } = await dockerProject();
    for (const statusResult of [{ code: 3, stdout: 'old human output\n', stderr: 'warn\n' }, ok('{"ok":true,"data":'), ok(JSON.stringify({ ok: false, error: { message: 'x' } }))]) {
      const h = await hostStatus({ cwd: repo, runner: fakeDocker(world(projectId, { statusResult })), fingerprint: FP, version: HOST_VERSION });
      expect(h).toEqual({ kind: 'raw', result: statusResult });
    }
  });

  it('host runtime delegates unchanged', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    const h = await hostStatus({ cwd: repo, runner: async () => { throw new Error('must not run docker'); } });
    expect(h).toEqual({ kind: 'delegate' });
  });

  it('human rendering keeps the container status lines and appends the restart reasons', async () => {
    const { repo, projectId } = await dockerProject();
    const h = await hostStatus({ cwd: repo, fingerprint: FP, version: HOST_VERSION,
      runner: fakeDocker(world(projectId, { versionResult: ok('0.0.1\n'), statusResult: ok(JSON.stringify({ ok: true, data: STATUS_DATA })) })) });
    expect(h.kind).toBe('report');
    if (h.kind !== 'report') return;
    // Older image without coordinatorLaunch: the CLI version mismatch explains it; no extra unchecked entry.
    expect(h.restartRequired).toMatchObject({ state: 'required', unchecked: [], reasons: [expect.objectContaining({ kind: 'cli-version' })] });
    const text = [humanStatus(h.status as unknown as StatusReport), ...formatRestartRequired(h.restartRequired)].join('\n');
    expect(text).toContain('config revision 3  profile project-owner  delivery local');
    expect(text).toContain('paused: intake=false starts=true');
    expect(text).toContain('queue: To Do=2');
    expect(text).toContain('restart required (run `minions upgrade`):');
    expect(text).toContain('  - cli-version: the container runs minions 0.0.1, the host CLI is 1.2.3');
  });
});
