// The local integrator's user-facing surface (task-82.4, docs/design/local-auto-integration.md phase 4): the flaky
// rerun (Decision 2), the status block and the doctor problems (incl. a crash during `git merge --ff-only`), owner
// notices, the digest lines, the backstops, and the merge-approval refusal after a failed integration.
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { verifyAnyApproval } from '../../src/core/approval.js';
import { integrationDoctorChecks } from '../../src/host/doctor.js';
import {
} from '../../src/runtime/integration-status.js';
import { pending } from '../../src/runtime/outbox.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { approvalKeys, type Env } from './fixtures.js';

interface LocalEnv extends Env { keys: ReturnType<typeof approvalKeys>; starts: number }


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
