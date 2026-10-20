// task-39 tester: gaps around run() signal handling and the provenance fallback hook. No live /state.
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { toTask } from '../../src/backlog/backlogmd.js';
import { run } from '../../src/core/exec.js';
import { INTAKE_STATE_META, intakeKey, intakeProvenanceFallback } from '../../src/runtime/intake-sync.js';
import { makeDefaultEnv } from './fixtures.js';

const HANG = ['-e', 'setTimeout(()=>{}, 10000)'];

describe('run(): signal listeners and abort/timeout interplay', () => {
  it('removes its abort listener when the child exits normally, fails, or times out', async () => {
    const ctl = new AbortController();
    await run('node', ['-e', 'process.exit(0)'], { signal: ctl.signal });
    await run('node', ['-e', 'process.exit(3)'], { signal: ctl.signal, allowFailure: true });
    await expect(run('node', ['-e', 'process.exit(3)'], { signal: ctl.signal })).rejects.toThrow(/exited with code 3/);
    await run('node', HANG, { signal: ctl.signal, timeoutMs: 150, allowFailure: true });
    await run('definitely-not-a-command-xyz', [], { signal: ctl.signal }).catch(() => {});
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
    // Aborting after all runs settled is harmless.
    ctl.abort();
  });

  it('many sequential runs sharing one signal do not accumulate listeners', async () => {
    const ctl = new AbortController();
    for (let i = 0; i < 15; i++) await run('node', ['-e', '0'], { signal: ctl.signal });
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
  });

  it('timeout first, then abort: reported as timed out (124), not aborted, and not killed twice', async () => {
    const ctl = new AbortController();
    const t = Date.now();
    const p = run('node', HANG, { signal: ctl.signal, timeoutMs: 150, allowFailure: true });
    setTimeout(() => ctl.abort(), 160);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(r.aborted).toBeUndefined();
    expect(r.code).toBe(124);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('abort first, then timeout: reported as aborted (130), not timed out', async () => {
    const ctl = new AbortController();
    // Ignores SIGTERM so the timeout fires during the SIGKILL grace.
    const p = run('node', ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'], { signal: ctl.signal, timeoutMs: 600, allowFailure: true });
    await new Promise((res) => setTimeout(res, 300));
    ctl.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBeUndefined();
    expect(r.code).toBe(130);
    expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0);
  }, 10_000);

  it('without a signal the timeout path is unchanged (rejects with timed out, code 124 with allowFailure)', async () => {
    await expect(run('node', HANG, { timeoutMs: 150 })).rejects.toMatchObject({ details: expect.objectContaining({ timedOut: true, code: 124 }) });
    const r = await run('node', HANG, { timeoutMs: 150, allowFailure: true });
    expect(r).toMatchObject({ timedOut: true, code: 124 });
    expect('aborted' in r).toBe(false);
    const f = await run('node', ['-e', 'process.stderr.write("e"); process.exit(2)'], { allowFailure: true });
    expect(f).toEqual({ code: 2, stdout: '', stderr: 'e' });
  });
});

describe('provenance fallback hook: cost', () => {
  it('only consults the DB for tasks without a usable meta provenance', () => {
    let calls = 0;
    const fallback = (id: string) => { calls++; return id === 'task-1' ? 'external-requirement' as const : undefined; };
    const good = { id: 'TASK-1', description: 'B\n\n<!-- minions:meta {"provenance":"user-decision"} -->' };
    for (let i = 0; i < 50; i++) toTask(good, { provenanceFallback: fallback });
    expect(calls).toBe(0);
    toTask({ id: 'TASK-1', description: 'no meta' }, { provenanceFallback: fallback });
    expect(calls).toBe(1);
  });

  it('stays cheap with a large sync record and many meta-less tasks', () => {
    const e = makeDefaultEnv();
    const issues: Record<string, unknown> = {};
    for (let n = 1; n <= 1000; n++) {
      issues[intakeKey('acme/demo', n)] = { taskId: `task-${n}`, url: `https://github.com/acme/demo/issues/${n}`, repository: 'acme/demo', number: n, assignees: [], inFilter: true, lastSeenAt: 'x' };
    }
    e.db.setMeta(INTAKE_STATE_META, JSON.stringify({ version: 1, issues }));
    const fallback = intakeProvenanceFallback(() => e.db);
    const t = Date.now();
    for (let i = 1; i <= 500; i++) expect(toTask({ id: `TASK-${i}`, description: 'x' }, { provenanceFallback: fallback }).provenance).toBe('external-requirement');
    // Generous bound: 500 meta reads + parses of a 1000-entry record.
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('a getMeta that throws falls back to the default instead of breaking the read', () => {
    const fallback = intakeProvenanceFallback(() => ({ getMeta: () => { throw new Error('database is locked'); } }));
    expect(toTask({ id: 'TASK-1', description: 'x' }, { provenanceFallback: fallback }).provenance).toBe('user-decision');
  });

  it('a db getter that throws falls back to the default instead of breaking the read', () => {
    const fallback = intakeProvenanceFallback(() => { throw new Error('SQLITE_CANTOPEN'); });
    expect(toTask({ id: 'TASK-1', description: 'x' }, { provenanceFallback: fallback }).provenance).toBe('user-decision');
  });
});
