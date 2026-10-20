// CLI wiring of auto-merge (task-1.9): `minions sync` exit code on a failed merge state and
// `minions work approve --merge`. The scheduler, backlog and sync internals are stubbed; they are
// covered in merge.test.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const h = vi.hoisted(() => ({
  merge: 'armed' as string,
  approveMerge: vi.fn(() => ({ message: 'merge approved' })),
  approvePublication: vi.fn(() => ({ message: 'publish approved' })),
}));

vi.mock('../../src/backlog/factory.js', async (orig) => ({ ...(await orig<object>()), openBacklog: () => ({}) }));
vi.mock('../../src/runtime/scheduler.js', async (orig) => ({
  ...(await orig<object>()),
  Scheduler: class { approveMerge = h.approveMerge; approvePublication = h.approvePublication; autoMerge = async () => ({}); },
}));
vi.mock('../../src/runtime/ci.js', async (orig) => ({
  ...(await orig<object>()),
  syncTasks: async () => ({
    failed: 0, synced: 1,
    tasks: [{ taskId: 'task-1', prUrl: 'https://github.com/acme/demo/pull/1', prState: 'OPEN', headSha: 'a'.repeat(40), ci: { state: 'none', total: 0, passed: 0, failed: [], pending: [], checks: [] }, changed: true, warnings: [], merge: { taskId: 'task-1', state: h.merge, message: `state ${h.merge}` } }],
  }),
}));

const { register } = await import('../../src/runtime/commands.js');

beforeAll(() => {
  const root = tmp();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify(defaults('project-owner')));
  process.env.MINIONS_RUNTIME = 'container';
  process.env.MINIONS_STATE_DIR = join(root, 'state');
  process.env.MINIONS_CONFIG = join(root, 'config.json');
  process.env.MINIONS_WORKSPACE = join(root, 'workspace');
});
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); h.approveMerge.mockClear(); h.approvePublication.mockClear(); });

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

describe('minions sync exit code with auto-merge', () => {
  it('exits 1 when a merge state is failed, 0 otherwise', async () => {
    h.merge = 'failed';
    const out = await run('sync', 'task-1');
    expect(out).toMatch(/merge failed/);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    for (const s of ['armed', 'waiting', 'merged']) {
      h.merge = s;
      await run('sync', 'task-1');
      expect(process.exitCode).toBeUndefined();
    }
  });
});

describe('minions work approve --merge', () => {
  const head = 'a'.repeat(40);
  it('--merge records a merge approval; without it a publication approval', async () => {
    await run('work', 'approve', 'task-1', '--head', head, '--merge', '--signature', 'tok');
    expect(h.approveMerge).toHaveBeenCalledWith('task-1', expect.objectContaining({ head, signature: 'tok' }));
    expect(h.approvePublication).not.toHaveBeenCalled();
    await run('work', 'approve', 'task-1', '--head', head, '--signature', 'tok');
    expect(h.approvePublication).toHaveBeenCalledWith('task-1', expect.objectContaining({ head, signature: 'tok' }));
    expect(h.approveMerge).toHaveBeenCalledTimes(1);
  });
});
