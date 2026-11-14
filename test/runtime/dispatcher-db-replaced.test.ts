// `minions work dispatch` after a state restore swapped the DB file (runtime health fix): the process keeps the old
// inode and would stay lock holder of a DB nobody reads; it exits with lock-lost instead. Temp SQLite DBs only.
import { copyFileSync, renameSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runDispatcher } from '../../src/runtime/dispatcher.js';
import { makeDefaultEnv } from './fixtures.js';
// Unit tier: git runs on the in-memory fake; the lock's process identity (ps) is not read.
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));
vi.mock('../../src/runtime/runner/record.js', async (orig) => ({ ...(await orig<object>()), procIdentity: async () => null, hostIdentity: async () => null }));

describe('dispatcher: the database file is replaced under it (state restore)', () => {
  it('exits with lock-lost instead of looping as lock holder of a DB nobody reads', async () => {
    const env = makeDefaultEnv();
    const lines: string[] = [];
    let sleeps = 0;
    const r = await runDispatcher({
      db: env.db, paths: { briefs: '/nonexistent/briefs', results: '/nonexistent/results', state: '/nonexistent' }, config: async () => structuredClone(env.config),
      scheduler: async () => { throw new Error('no scheduler in this test'); },
      launch: async () => { throw new Error('nothing to launch'); }, taskStatus: async () => 'ready', notify: () => undefined,
      lockAlive: () => false, tickMs: 1, log: (l) => lines.push(l),
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) { renameSync(env.db.path, `${env.db.path}.pre-restore`); copyFileSync(`${env.db.path}.pre-restore`, env.db.path); }
        if (sleeps > 5) throw new Error('still looping');
      },
    });
    expect(r.exit).toBe('lock-lost');
    expect(sleeps).toBe(1);
    expect(lines.join('\n')).toMatch(/database file was replaced/);
  });
});
