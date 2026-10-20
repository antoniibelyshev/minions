// doctor `container.tmp` / `container.scratch` (task-27): /tmp is a RAM-backed tmpfs counted against the
// container memory limit; doctor warns when it fills up, when the container predates the size cap, and
// when the disk-backed TMPDIR is missing or nearly full. All fakes: no Docker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';

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
const { runDoctor, parseDf, tmpUsageChecks, TMP_WARN_PERCENT } = await import('../../src/host/doctor.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');

const HEADER = 'Filesystem     1024-blocks    Used Available Capacity Mounted on';
const SCRATCH = '/home/node/.cache/tmp';
const df = (tmp: [number, number] | null, scratch: [number, number] | null, code = 0): RunResult => ({
  code, stderr: scratch ? '' : `df: ${SCRATCH}: No such file or directory`,
  stdout: [HEADER,
    ...(tmp ? [`tmpfs ${tmp[0]} ${tmp[1]} ${tmp[0] - tmp[1]} ${Math.ceil((tmp[1] / tmp[0]) * 100)}% /tmp`] : []),
    ...(scratch ? [`/dev/vdb1 ${scratch[0]} ${scratch[1]} ${scratch[0] - scratch[1]} ${Math.ceil((scratch[1] / scratch[0]) * 100)}% /home/node/.cache`] : []),
  ].join('\n') + '\n',
});
const GiB = 1024 * 1024; // KiB

describe('tmpUsageChecks', () => {
  const opts = { capMiB: 1024, scratch: SCRATCH };

  it('parses df -Pk rows', () => {
    expect(parseDf(df([GiB, 1024], [100 * GiB, GiB]).stdout)).toEqual([
      { sizeKiB: GiB, usedKiB: 1024, percent: 1, mount: '/tmp' },
      { sizeKiB: 100 * GiB, usedKiB: GiB, percent: 1, mount: '/home/node/.cache' },
    ]);
    expect(parseDf('garbage\nnot a row\n')).toEqual([]);
  });

  it('ok when /tmp is capped as configured and lightly used, scratch present', () => {
    const [tmp, scratch] = tmpUsageChecks(df([GiB, 100 * 1024], [100 * GiB, 10 * GiB]), opts);
    expect(tmp).toMatchObject({ name: 'container.tmp', status: 'ok', detail: expect.stringContaining('/tmp 10% used (100 MiB of 1024 MiB') });
    expect(scratch).toMatchObject({ name: 'container.scratch', status: 'ok' });
  });

  it(`warns at ${TMP_WARN_PERCENT}% and above, with a hint pointing at TMPDIR`, () => {
    const [tmp] = tmpUsageChecks(df([GiB, Math.floor(0.85 * GiB)], [100 * GiB, GiB]), opts);
    expect(tmp).toMatchObject({ status: 'warn', detail: expect.stringContaining('memory limit'), hint: expect.stringContaining(SCRATCH) });
    // The 2026-10-19 incident: an uncapped 3.9 GiB /tmp at 100%.
    const [full] = tmpUsageChecks(df([3.9 * GiB, 3.9 * GiB], [100 * GiB, GiB]), opts);
    expect(full!.status).toBe('warn');
    expect(full!.detail).toMatch(/100% used/);
    // Just below the threshold, correctly capped: ok.
    expect(tmpUsageChecks(df([GiB, Math.floor(0.79 * GiB)], [100 * GiB, GiB]), opts)[0]!.status).toBe('ok');
  });

  it('warns when /tmp is not capped at the configured size (container from an older compose.yaml)', () => {
    const [tmp] = tmpUsageChecks(df([3 * GiB, 1024], [100 * GiB, GiB]), opts);
    expect(tmp).toMatchObject({ status: 'warn', detail: expect.stringContaining('expected a 1024 MiB cap'), hint: expect.stringContaining('minions down') });
    expect(tmpUsageChecks(df([2 * GiB, 1024], [100 * GiB, GiB]), { ...opts, capMiB: 2048 })[0]!.status).toBe('ok');
  });

  it('warns when the scratch dir is missing or its disk is nearly full; unreadable df is a warning', () => {
    const missing = tmpUsageChecks(df([GiB, 1024], null, 1), opts);
    expect(missing[0]!.status).toBe('ok');
    expect(missing[1]).toMatchObject({ name: 'container.scratch', status: 'warn', detail: expect.stringContaining('not found') });
    expect(tmpUsageChecks(df([GiB, 1024], [100 * GiB, 95 * GiB]), opts)[1]).toMatchObject({ status: 'warn', detail: expect.stringContaining('95%') });
    const none = tmpUsageChecks({ code: 127, stdout: '', stderr: 'df: not found' }, opts);
    expect(none[0]).toMatchObject({ name: 'container.tmp', status: 'warn', detail: expect.stringContaining('df: not found') });
  });
});

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

const container = (dfOut: RunResult, calls: string[][]) => async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
  const a = args.join(' ');
  if (cmd !== 'docker') return { code: 1, stdout: '', stderr: 'unavailable' };
  if (a.startsWith('image inspect')) return { code: 0, stdout: 'x\n', stderr: '' };
  if (a.includes(' ps --status running')) return { code: 0, stdout: 'abc\n', stderr: '' };
  if (a.includes(' exec -T app df ')) { calls.push(args.slice(args.indexOf('df'))); return dfOut; }
  if (a.endsWith('claude auth status') || a.endsWith('backlog --version')) return { code: 0, stdout: '1.54.0\n', stderr: '' };
  return { code: 1, stdout: '', stderr: 'unavailable' };
};

describe('runDoctor: /tmp usage in the running container', () => {
  it('runs df on /tmp and the scratch dir in the container and warns on high /tmp usage', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const calls: string[][] = [];
    const check = async (out: RunResult) => (await runDoctor({ cwd: repo, probe: dockerUp, runner: container(out, calls) })).checks.filter((c) => c.name.startsWith('container.'));

    const ok = await check(df([GiB, 1024], [100 * GiB, GiB]));
    expect(calls[0]).toEqual(['df', '-Pk', '/tmp', SCRATCH]);
    expect(ok.find((c) => c.name === 'container.tmp')?.status).toBe('ok');
    expect(ok.find((c) => c.name === 'container.scratch')?.status).toBe('ok');

    const high = await check(df([GiB, Math.floor(0.9 * GiB)], [100 * GiB, GiB]));
    expect(high.find((c) => c.name === 'container.tmp')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/\/tmp 90% used/) });
  });
});
