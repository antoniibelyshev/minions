// task-39 tester: gaps around run() signal handling. No live /state.
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { run } from '../../src/core/exec.js';

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
    // Ignores SIGTERM so the timeout fires during the SIGKILL grace (injected 800 ms: abort at 300, timeout at 600).
    const p = run('node', ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{}, 1000)'], { signal: ctl.signal, timeoutMs: 600, allowFailure: true, killGraceMs: 800 });
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
