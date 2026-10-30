// The local integrator's user-facing surface (task-82.4, docs/design/local-auto-integration.md phase 4), unit tier:
// the doctor problems for the status integration block and the backstop kick decision / watch. The end-to-end
// integrator runs live in integrator.test.ts and local-integration.test.ts.
import { describe, expect, it } from 'vitest';
import { integrationDoctorChecks } from '../../src/host/doctor.js';
import { integratorKickDecision, startIntegrationWatch, type KickInputs } from '../../src/runtime/integration-status.js';

describe('status integration block', () => {

  it('doctor: a halted queue warns with --adopt-base; a healthy block is one ok line; no block, no checks', () => {
    const halted = { enabled: true, lock: { state: 'none' }, queue: [{}], problems: [{ name: 'integration.queue', status: 'warn', detail: 'the integration queue is halted since x: main was reset', hint: 'run `minions work integrate --adopt-base`' }] };
    expect(integrationDoctorChecks({ code: 0, stdout: JSON.stringify({ ok: true, data: { integration: halted } }) })).toEqual([
      { name: 'integration.queue', status: 'warn', detail: expect.stringMatching(/halted/), hint: expect.stringMatching(/--adopt-base/) }]);
    expect(integrationDoctorChecks({ code: 0, stdout: JSON.stringify({ ok: true, data: { integration: { enabled: true, lock: { state: 'live' }, queue: [{}, {}], problems: [] } } }) }))
      .toEqual([{ name: 'integration', status: 'ok', detail: 'local integration on; integrator running; 2 queued' }]);
    expect(integrationDoctorChecks({ code: 0, stdout: JSON.stringify({ ok: true, data: {} }) })).toEqual([]);
    expect(integrationDoctorChecks({ code: 1, stdout: '' })).toEqual([]);
  });

});

describe('backstops: routine-tick watch and --recover', () => {
  const base: KickInputs = { enabled: true, queued: 1, running: 0, lock: 'none', halted: false, draining: false, startsPaused: false };
  it('starts only with a queued entry (or a dead holder to recover) and no live holder, halt, drain or pause', () => {
    expect(integratorKickDecision(base)).toMatchObject({ start: true });
    expect(integratorKickDecision({ ...base, queued: 0 })).toMatchObject({ start: false, why: 'nothing queued' });
    expect(integratorKickDecision({ ...base, queued: 0, lock: 'stale', running: 1 })).toMatchObject({ start: true, why: expect.stringMatching(/recover/) });
    for (const over of [{ enabled: false }, { lock: 'live' as const }, { halted: true }, { draining: true }, { startsPaused: true }]) {
      expect(integratorKickDecision({ ...base, ...over }).start, JSON.stringify(over)).toBe(false);
    }
  });

  it('the wrapper watch checks at once and every tick, without a second start inside the grace window', async () => {
    let fire: (() => void) | null = null;
    let now = 0;
    let starts = 0;
    let inputs: KickInputs = base;
    const lines: string[] = [];
    const stop = startIntegrationWatch({ decide: () => inputs, start: () => { starts++; return 42; }, timer: (fn) => { fire = fn; return () => { fire = null; }; }, clock: () => now, say: (l) => lines.push(l) });
    await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(1);
    expect(lines[0]).toMatch(/started the local integrator \(pid 42\): 1 queued/);
    now = 10_000; fire!(); await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(1);
    now = 61_000; inputs = { ...base, lock: 'live' }; fire!(); await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(1);
    inputs = base; fire!(); await new Promise((r) => setTimeout(r, 0));
    expect(starts).toBe(2);
    stop();
    expect(fire).toBeNull();
  });
});
