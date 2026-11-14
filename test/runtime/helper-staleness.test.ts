// The detached helpers' backstop for an upgrade under them (src/runtime/helper-staleness.ts): a config that stops
// loading after the CLI bundle changed on disk or after a configRevision change ends the helper (`stale`), so the
// wrapper's watch starts it again on the installed build; a config that never loaded with unchanged code keeps the
// old "log and retry". Unit tier: temp files only; git runs on the in-memory fake, no process identity is read.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runDispatcher } from '../../src/runtime/dispatcher.js';
import { codeStamp, rawConfigRevision, staleConfigGuard } from '../../src/runtime/helper-staleness.js';
import { makeDefaultEnv, tmp } from './fixtures.js';
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));
vi.mock('../../src/runtime/runner/record.js', async (orig) => ({ ...(await orig<object>()), procIdentity: async () => null, hostIdentity: async () => null }));

const invalid = new Error('Invalid config: budgets.dailyTokens: unknown field');

function files() {
  const dir = tmp('minions-stale-');
  const cli = join(dir, 'cli.js');
  const config = join(dir, 'config.json');
  writeFileSync(cli, '// build 1\n');
  writeFileSync(config, JSON.stringify({ configRevision: 4 }));
  return { cli, config };
}

describe('stale config guard', () => {
  it('unchanged code and revision: keep retrying (a restart would load the same file with the same code)', () => {
    const f = files();
    const g = staleConfigGuard({ configPath: f.config, started: codeStamp(f.cli) });
    expect(g.invalid(invalid)).toBeNull();
    g.valid({ configRevision: 4 });
    expect(g.invalid(invalid)).toBeNull();
  });

  it('the CLI bundle was replaced or rewritten since the start: exit', () => {
    const f = files();
    const g = staleConfigGuard({ configPath: f.config, started: codeStamp(f.cli) });
    writeFileSync(f.cli, '// build 2, a little longer\n');
    expect(g.invalid(invalid)).toMatch(/budgets\.dailyTokens: unknown field.*cli\.js\) changed on disk since it started/);
  });

  it('the config revision moved past the last one this process loaded: exit', () => {
    const f = files();
    const g = staleConfigGuard({ configPath: f.config, started: codeStamp(f.cli) });
    g.valid({ configRevision: 4 });
    writeFileSync(f.config, JSON.stringify({ configRevision: 5, budgets: { dailyTokens: 1 } }));
    expect(g.invalid(invalid)).toMatch(/configRevision 5\) does not load.*last loaded configRevision 4/);
  });

  it('a revision change before any valid load, or an unreadable file, is not enough', () => {
    const f = files();
    const g = staleConfigGuard({ configPath: f.config, started: codeStamp(f.cli) });
    writeFileSync(f.config, '{ half-written');
    expect(rawConfigRevision(f.config)).toBeNull();
    expect(g.invalid(invalid)).toBeNull();
    g.valid({ configRevision: 4 });
    expect(g.invalid(invalid)).toBeNull();
    expect(staleConfigGuard({ configPath: f.config, started: null }).invalid(invalid)).toBeNull();
  });
});

describe('dispatcher: exits stale instead of looping on "pass failed"', () => {
  function run(o: { stale: ReturnType<typeof staleConfigGuard>; configs: (() => unknown)[] }) {
    const env = makeDefaultEnv();
    const lines: string[] = [];
    let n = 0;
    let sleeps = 0;
    const done = runDispatcher({
      db: env.db, paths: { briefs: '/nonexistent/briefs', results: '/nonexistent/results', state: '/nonexistent' },
      config: async () => { const c = o.configs[Math.min(n++, o.configs.length - 1)]!(); return c as typeof env.config; },
      scheduler: async () => { throw new Error('no scheduler in this test'); },
      launch: async () => { throw new Error('nothing to launch'); }, taskStatus: async () => 'ready', notify: () => undefined,
      lockAlive: () => false, tickMs: 1, log: (l) => lines.push(l), stale: o.stale,
      sleep: async () => { if (++sleeps > 4) throw new Error('still looping'); },
    });
    return { env, lines, done, sleeps: () => sleeps };
  }

  it('the config stops loading after the bundle changed: exit stale and release the lock', async () => {
    const f = files();
    const stale = staleConfigGuard({ configPath: f.config, started: codeStamp(f.cli) });
    const env = makeDefaultEnv();
    const r = run({ stale, configs: [() => { writeFileSync(f.cli, '// build 2, replaced by npm install -g\n'); return structuredClone(env.config); }, () => { throw invalid; }] });
    const out = await r.done;
    expect(out.exit).toBe('stale');
    expect(r.lines.join('\n')).toMatch(/minions dispatcher: the runtime config does not load .*exiting so the coordinator wrapper starts the installed build/);
    // The pass reads the config too: at most the pass already under way fails before the exit.
    expect(r.lines.filter((l) => /pass failed: Invalid config/.test(l)).length).toBeLessThanOrEqual(1);
    expect(r.env.db.supervisorLock('dispatcher_lock')).toBeNull();
  });

  it('a config that never loaded with unchanged code keeps logging "pass failed" (no exit)', async () => {
    const f = files();
    const r = run({ stale: staleConfigGuard({ configPath: f.config, started: codeStamp(f.cli) }), configs: [() => { throw invalid; }] });
    await expect(r.done).rejects.toThrow(/still looping/);
    expect(r.lines.filter((l) => /pass failed: Invalid config/.test(l)).length).toBeGreaterThan(1);
  });
});
