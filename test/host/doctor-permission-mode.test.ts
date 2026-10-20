// doctor `claude.capabilities` reports the coordinator launch permission mode from
// `minions coordinator --probe --json` (task-36): ok with auto, warn on the acceptEdits fallback,
// ok for older probe output without the permission field. All fakes: no Docker.
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
const { runDoctor } = await import('../../src/host/doctor.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

const container = (probe: RunResult) => async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
  const a = args.join(' ');
  if (cmd !== 'docker') return { code: 1, stdout: '', stderr: 'unavailable' };
  if (a.startsWith('image inspect')) return { code: 0, stdout: 'x\n', stderr: '' };
  if (a.includes(' ps --status running')) return { code: 0, stdout: 'abc\n', stderr: '' };
  if (a.endsWith('coordinator --probe --json')) return probe;
  if (a.endsWith('claude auth status') || a.endsWith('backlog --version')) return { code: 0, stdout: '1.54.0\n', stderr: '' };
  return { code: 1, stdout: '', stderr: 'unavailable' };
};
const probeOut = (permission?: object): RunResult => ({
  code: 0, stderr: '',
  stdout: JSON.stringify({ ok: true, data: { claudeVersion: '2.1.292 (Claude Code)', tmuxVersion: 'tmux 3.4', ...(permission ? { permission } : {}) } }),
});

describe('doctor claude.capabilities: coordinator permission mode', () => {
  it('ok with auto, warn with the reason on fallback, ok for older probe output, fail when the probe fails', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const cap = async (probe: RunResult) =>
      (await runDoctor({ cwd: repo, probe: dockerUp, runner: container(probe) })).checks.find((c) => c.name === 'claude.capabilities');

    expect(await cap(probeOut({ configured: 'auto', mode: 'auto', fallback: false, reason: 'coordinator permission mode auto' })))
      .toMatchObject({ status: 'ok', detail: expect.stringMatching(/permission mode auto$/) });

    const reason = 'the installed Claude Code does not offer --permission-mode auto (choices: acceptEdits, plan); falling back to permission mode acceptEdits';
    expect(await cap(probeOut({ configured: 'auto', mode: 'acceptEdits', fallback: true, reason })))
      .toMatchObject({ status: 'warn', detail: expect.stringContaining(`permission mode acceptEdits (${reason})`) });

    expect(await cap(probeOut({ configured: 'acceptEdits', mode: 'acceptEdits', fallback: false, reason: 'coordinator permission mode acceptEdits' })))
      .toMatchObject({ status: 'ok', detail: expect.stringMatching(/permission mode acceptEdits$/) });

    // An older image whose probe has no permission field, or non-JSON output: still ok, no mode claimed.
    for (const p of [probeOut(), { code: 0, stdout: 'Claude Code 2.1.292: launch flags supported\n', stderr: '' }]) {
      const c = await cap(p);
      expect(c?.status).toBe('ok');
      expect(c?.detail).not.toMatch(/permission mode/);
    }

    expect((await cap({ code: 1, stdout: '', stderr: 'INCOMPATIBLE_RUNTIME' }))?.status).toBe('fail');
  });
});
