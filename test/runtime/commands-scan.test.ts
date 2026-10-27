// CLI wiring of the PR scan after a slot frees up (task-68.3): `minions work record` / `work release` run the
// scan through scanAfterSlot (bounded, a `scan` field, never a change to the outcome). The scheduler is
// stubbed; the scan itself is covered in pr-scan.test.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScanReport } from '../../src/runtime/pr-scan.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const h = vi.hoisted(() => ({
  scan: vi.fn(async (_o: { deadline?: number; signal?: AbortSignal }): Promise<ScanReport> => ({ state: 'ran', prs: 1, tasks: [], message: 'PR scan: 1 open PR(s), 0 delivered task(s); nothing to do.' })),
  record: vi.fn(async () => ({ valid: true, leaseId: 'lease-1', taskId: 'task-1', from: 'implementing', to: 'reviewing', message: 'Recorded lease-1: task-1 implementing -> reviewing.' })),
  release: vi.fn(async () => ({ leaseId: 'lease-1', taskId: 'task-1', worktree: '/w', branch: 'agent/x', status: 'ready' })),
}));

vi.mock('../../src/backlog/factory.js', async (orig) => ({ ...(await orig<object>()), openBacklog: () => ({}) }));
vi.mock('../../src/runtime/scheduler.js', async (orig) => ({
  ...(await orig<object>()),
  Scheduler: class { record = h.record; release = h.release; scanPullRequests = h.scan; },
}));

const { register } = await import('../../src/runtime/commands.js');

let resultFile = '';
beforeAll(() => {
  const root = tmp();
  mkdirSync(join(root, 'state'), { recursive: true });
  const cfg = defaults('project-owner');
  Object.assign(cfg.delivery, { provider: 'github', mode: 'pull-request', merge: 'auto-when-eligible', requiredChecksConfigured: true });
  cfg.verification.ciAuthority = 'github';
  writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
  resultFile = join(root, 'result.json');
  writeFileSync(resultFile, '{}');
  process.env.MINIONS_RUNTIME = 'container';
  process.env.MINIONS_STATE_DIR = join(root, 'state');
  process.env.MINIONS_CONFIG = join(root, 'config.json');
  process.env.MINIONS_WORKSPACE = join(root, 'workspace');
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); h.scan.mockClear(); });

async function run(...args: string[]) {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  register(program);
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  await program.parseAsync(['node', 'minions', ...args]);
  vi.restoreAllMocks();
  return out.join('');
}

describe('PR scan after work record / work release (scanAfterSlot)', () => {
  it('record and release run one bounded scan and report it in a `scan` field', async () => {
    const t0 = Date.now();
    const rec = JSON.parse(await run('--json', 'work', 'record', 'lease-1', '--result-file', resultFile));
    expect(rec.data).toMatchObject({ valid: true, to: 'reviewing', scan: { state: 'ran', message: expect.stringMatching(/PR scan: 1 open PR/) } });
    expect(h.scan).toHaveBeenCalledTimes(1);
    const o = h.scan.mock.calls[0]![0];
    // The 60 s budget: a deadline for new base updates and a signal that cancels in-flight git/gh calls.
    expect(o.deadline).toBeGreaterThanOrEqual(t0 + 60_000);
    expect(o.deadline).toBeLessThan(Date.now() + 61_000);
    expect(o.signal).toBeInstanceOf(AbortSignal);
    expect(o.signal!.aborted).toBe(false);

    const rel = JSON.parse(await run('--json', 'work', 'release', 'lease-1', '--reason', 'done'));
    expect(rel.data).toMatchObject({ leaseId: 'lease-1', taskId: 'task-1', scan: { state: 'ran' } });
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
  });

  it('a failing scan never changes the record outcome or the exit code', async () => {
    h.scan.mockRejectedValueOnce(new Error('gh exploded'));
    const rec = JSON.parse(await run('--json', 'work', 'record', 'lease-1', '--result-file', resultFile));
    expect(rec.ok).toBe(true);
    expect(rec.data).toMatchObject({ valid: true, to: 'reviewing', message: 'Recorded lease-1: task-1 implementing -> reviewing.', scan: { state: 'error', message: expect.stringMatching(/gh exploded/) } });
    expect(process.exitCode).toBeUndefined();
  });
});
