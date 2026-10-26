// task-14.3: `harness.*` checks in `minions status --check` / `doctor` (docs/design/agent-runtimes.md D7):
// helper absent, present but failing, and passing, plus the runDoctor wiring. All fakes: no Docker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import type { WorkProbeReport } from '../../src/runtime/sandbox/probe.js';
import type { SelfTestReport } from '../../src/runtime/sandbox/selftest.js';

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

/** Until task-14.2 adds `harnesses` to the schema, a test injects it into the loaded effective config. */
const injected: { harnesses?: unknown; roles?: Record<string, unknown> } = {};
vi.mock('../../src/host/project.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/host/project.js')>();
  return {
    ...orig,
    loadEffectiveConfig: async (p: Parameters<typeof orig.loadEffectiveConfig>[0]) => {
      const r = await orig.loadEffectiveConfig(p);
      if (!injected.harnesses) return r;
      return { ...r, config: { ...r.config, harnesses: injected.harnesses, roles: { ...r.config.roles, ...injected.roles } } };
    },
  };
});

const { harnessChecks, harnessSkipChecks, parseWorkProbe } = await import('../../src/host/harness-checks.js');
const { runInit } = await import('../../src/host/install.js');
const { runDoctor } = await import('../../src/host/doctor.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');

const sandbox = (over: Partial<SelfTestReport> = {}): SelfTestReport => ({ state: 'ok', detail: 'ok (Landlock ABI 8, 29 checks)', abi: 8, arch: 'aarch64', helperVersion: '1.0.0', checks: [], ...over });
const codexOk = { id: 'codex', found: true, version: '0.130.0', pinned: '0.130.0', ok: true, detail: 'codex 0.130.0 (pinned)' };
const report = (over: Partial<WorkProbeReport> = {}): WorkProbeReport => ({ harnesses: [codexOk], sandbox: sandbox(), tcpConnectPorts: [443], listeners: [], ...over });
const view = { processHarnesses: ['codex'], tcpConnectPorts: [443] };

describe('harnessChecks', () => {
  it('reports nothing when no process harness is configured (Claude-only projects see no change)', () => {
    expect(harnessChecks({ processHarnesses: [], tcpConnectPorts: [443] }, report())).toEqual([]);
    expect(harnessSkipChecks({ processHarnesses: [], tcpConnectPorts: [443] }, 'not-running')).toEqual([]);
  });

  it('passing: binary at the pinned version and the self-test ok', () => {
    expect(harnessChecks(view, report())).toEqual([{ name: 'harness.codex', status: 'ok', detail: 'codex 0.130.0 (pinned); isolation ok (Landlock ABI 8, 29 checks)' }]);
  });

  it('helper absent: fail, every launch refused', () => {
    const [c] = harnessChecks(view, report({ sandbox: sandbox({ state: 'unavailable', abi: null, detail: '/usr/local/bin/minions-sandbox is not installed (the image predates process-harness isolation)' }) }));
    expect(c).toMatchObject({ name: 'harness.codex', status: 'fail', detail: expect.stringContaining('isolation unavailable: /usr/local/bin/minions-sandbox is not installed'), hint: expect.stringContaining('minions start') });
    expect(c!.detail).toMatch(/every launch is refused/);
  });

  it('present but failing: fail naming the escaped canary; low Landlock ABI: kernel hint', () => {
    const [esc] = harnessChecks(view, report({ sandbox: sandbox({ state: 'fail', detail: 'proc.environ escaped: operation succeeded' }) }));
    expect(esc).toMatchObject({ status: 'fail', detail: expect.stringContaining('isolation fail: proc.environ escaped: operation succeeded') });
    const [abi] = harnessChecks(view, report({ sandbox: sandbox({ state: 'unavailable', abi: 4, detail: 'landlock ABI 4 (need 6)' }) }));
    expect(abi).toMatchObject({ status: 'fail', detail: expect.stringContaining('isolation unavailable: landlock ABI 4 (need 6)'), hint: expect.stringContaining('6.12') });
  });

  it('binary missing or at the wrong version: fail; no pin in the image: warn', () => {
    expect(harnessChecks(view, report({ harnesses: [{ ...codexOk, found: false, ok: false, version: null, detail: 'codex not found on PATH' }] }))[0])
      .toMatchObject({ status: 'fail', detail: 'codex not found on PATH; isolation ok (Landlock ABI 8, 29 checks)' });
    expect(harnessChecks(view, report({ harnesses: [{ ...codexOk, ok: false, version: '0.131.0', detail: 'codex 0.131.0, but the image pins 0.130.0' }] }))[0]!.status).toBe('fail');
    expect(harnessChecks(view, report({ harnesses: [{ ...codexOk, pinned: null, detail: 'codex 0.130.0 (no pinned version in this image)' }] }))[0]!.status).toBe('warn');
    expect(harnessChecks({ ...view, processHarnesses: ['codex', 'junie'] }, report())[1]).toMatchObject({ name: 'harness.junie', status: 'fail', detail: expect.stringMatching(/^not probed/) });
  });

  it('warns once per loopback listener on an allowed connect port', () => {
    const checks = harnessChecks(view, report({ listeners: [{ address: '127.0.0.1', port: 443, family: 4 }, { address: '::', port: 443, family: 6 }] }));
    expect(checks.filter((c) => c.name === 'harness.network')).toEqual([
      expect.objectContaining({ status: 'warn', detail: expect.stringContaining('127.0.0.1:443 listens on an allowed TCP connect port') }),
      expect.objectContaining({ status: 'warn', detail: expect.stringContaining(':::443') }),
    ]);
  });

  it('probe unusable (older image without `work probe`): fail per harness', () => {
    const p = parseWorkProbe({ code: 1, stdout: '', stderr: "error: unknown command 'probe'\n" });
    expect(p).toEqual({ error: "probe failed (exit 1): error: unknown command 'probe'" });
    expect(harnessChecks(view, p)).toEqual([expect.objectContaining({ name: 'harness.codex', status: 'fail', detail: "probe failed (exit 1): error: unknown command 'probe'" })]);
    expect(parseWorkProbe({ code: 11, stdout: JSON.stringify({ ok: false, error: { code: 'PRECONDITION', message: 'nope' } }), stderr: '' })).toEqual({ error: 'probe failed: nope' });
    expect(parseWorkProbe({ code: 0, stdout: 'not json', stderr: '' })).toEqual({ error: 'probe printed no usable report' });
    expect(parseWorkProbe({ code: 0, stdout: JSON.stringify({ ok: true, data: report() }), stderr: '' })).toEqual(report());
  });

  it('skips: host runtime fails (process harnesses need Docker), container down or Docker missing warns', () => {
    expect(harnessSkipChecks(view, 'host-runtime')[0]).toMatchObject({ status: 'fail', detail: expect.stringContaining('only in the Docker runtime') });
    expect(harnessSkipChecks(view, 'not-running')[0]).toMatchObject({ status: 'warn', detail: 'skipped: container not running' });
    expect(harnessSkipChecks(view, 'no-docker')[0]).toMatchObject({ status: 'warn', detail: 'skipped: Docker unavailable' });
  });
});

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  delete injected.harnesses; delete injected.roles;
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

/** A running container whose `minions work probe --json` answers `probe`. */
const container = (probe: RunResult | null, calls: string[], running = true) => async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
  const a = args.join(' ');
  if (cmd !== 'docker') return { code: 1, stdout: '', stderr: 'unavailable' };
  if (a.startsWith('image inspect')) return { code: 0, stdout: 'x\n', stderr: '' };
  if (a.includes(' ps --status running')) return { code: 0, stdout: running ? 'abc\n' : '', stderr: '' };
  if (a.includes(' exec -T app minions work probe')) { calls.push(a.slice(a.indexOf('app minions') + 4)); return probe ?? { code: 1, stdout: '', stderr: 'unavailable' }; }
  if (a.endsWith('claude auth status') || a.endsWith('backlog --version')) return { code: 0, stdout: '1.54.0\n', stderr: '' };
  return { code: 1, stdout: '', stderr: 'unavailable' };
};
const ok = (data: WorkProbeReport): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' });

describe('runDoctor (doctor and status --check): harness.* checks', () => {
  it('Claude-only config: no harness.* checks and the probe is never run', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const calls: string[] = [];
    const r = await runDoctor({ cwd: repo, probe: dockerUp, runner: container(ok(report()), calls) });
    expect(r.checks.filter((c) => c.name.startsWith('harness.'))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('process harness configured: runs `minions work probe --json` in the container; passing, failing and absent helper', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    injected.harnesses = { default: 'claude', codex: {} };
    injected.roles = { engineer: { harness: 'codex' } };
    const calls: string[] = [];
    const harness = async (probe: RunResult) => (await runDoctor({ cwd: repo, probe: dockerUp, runner: container(probe, calls) })).checks.filter((c) => c.name.startsWith('harness.'));

    expect(await harness(ok(report()))).toEqual([expect.objectContaining({ name: 'harness.codex', status: 'ok' })]);
    expect(calls[0]).toBe('minions work probe --json');

    const failing = await runDoctor({ cwd: repo, probe: dockerUp, runner: container(ok(report({ sandbox: sandbox({ state: 'fail', detail: 'unix.path escaped: operation succeeded' }) })), calls) });
    expect(failing.checks.find((c) => c.name === 'harness.codex')).toMatchObject({ status: 'fail', detail: expect.stringContaining('unix.path escaped') });
    expect(failing.healthy).toBe(false);

    const absent = await harness(ok(report({ sandbox: sandbox({ state: 'unavailable', abi: null, detail: '/usr/local/bin/minions-sandbox is not installed (the image predates process-harness isolation)' }) })));
    expect(absent[0]).toMatchObject({ status: 'fail', detail: expect.stringContaining('not installed') });

    const oldImage = await harness({ code: 1, stdout: '', stderr: "error: unknown command 'probe'\n" });
    expect(oldImage[0]).toMatchObject({ status: 'fail', detail: expect.stringContaining('probe failed') });
  });

  it('container not running: harness.<id> is listed as skipped', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    injected.harnesses = { default: 'codex', codex: {} };
    const calls: string[] = [];
    const r = await runDoctor({ cwd: repo, probe: dockerUp, runner: container(null, calls, false) });
    expect(r.checks.find((c) => c.name === 'harness.codex')).toMatchObject({ status: 'warn', detail: 'skipped: container not running' });
    expect(calls).toEqual([]);
  });
});
