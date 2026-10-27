// task-68.2 (docs/design/unattended-delivery.md decision 2): the host manager's routine watchdog lane. A fake
// transport, a fake routine delegate and a fake clock; no Docker, no child processes, no runtime.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { HostManager, WATCHDOG_ARGV, WATCHDOG_CHECK_MS, type ManagerDeps, type ManagerOutcome } from '../../src/host/manager.js';
import type { ProjectJson } from '../../src/host/project.js';
import { withHome } from './fixtures.js';

let home: ReturnType<typeof withHome>;
beforeEach(() => { home = withHome(); });
afterEach(() => { home.cleanup(); });

const project = (id = 'proj-a') => ({ projectId: id, repoPath: `/repos/${id}` }) as unknown as ProjectJson;
const answer = (data: unknown): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });

function setup(routine?: ManagerDeps['routine']) {
  let now = new Date('2026-10-27T12:00:00Z');
  const outcomes: ManagerOutcome[] = [];
  const logs: string[] = [];
  const delegateCalls: string[][] = [];
  const deps: ManagerDeps = {
    transport: { sendOffer: async () => {}, receive: async () => [], sendOutcome: async (o) => { outcomes.push(o); } },
    projects: async () => [project()],
    loadProject: async () => project(),
    running: async () => true,
    delegate: async (_p, argv) => { delegateCalls.push(argv); return answer({ requests: [] }); },
    runChild: async () => ({ code: 1, stdout: '', stderr: 'unexpected' }),
    upgrade: async () => { throw new Error('no upgrade in this test'); },
    now: () => now,
    sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    log: (l) => logs.push(l),
    ...(routine ? { routine } : {}),
  };
  return { manager: new HostManager(deps), outcomes, logs, delegateCalls, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

/** A routine delegate whose answers the test sets; records each call. */
function fakeRoutine() {
  const calls: string[][] = [];
  let next: () => Promise<RunResult> = async () => answer({ ran: false, skipped: 'fresh', why: 'fresh', coordinator: { running: true, since: '2026-10-27T10:00:00.000Z' } });
  return {
    calls,
    set: (f: () => Promise<RunResult>) => { next = f; },
    routine: async (_p: ProjectJson, argv: string[]) => { calls.push(argv); return next(); },
  };
}

describe('host manager: routine watchdog', () => {
  it('no routine dep (tests, older wiring): no watchdog at all', async () => {
    const s = setup();
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes).toHaveLength(0);
  });

  it('the poll starts the watchdog through the delegate with the routine argv; checks at most every 5 min', async () => {
    const r = fakeRoutine();
    const s = setup(r.routine);
    await s.manager.pollProject(project());
    await s.manager.watchdogSettled();
    expect(r.calls).toEqual([[...WATCHDOG_ARGV]]);
    expect(WATCHDOG_ARGV).toEqual(['minions', 'sync', '--routine', '--trigger', 'watchdog', '--json']);
    s.advance(WATCHDOG_CHECK_MS - 1);
    await s.manager.pollProject(project());
    await s.manager.watchdogSettled();
    expect(r.calls).toHaveLength(1);
    s.advance(1);
    await s.manager.pollProject(project());
    await s.manager.watchdogSettled();
    expect(r.calls).toHaveLength(2);
    expect(s.outcomes).toHaveLength(0); // a running coordinator is not reported
  });

  it('one pass in flight per project; the poll never waits for it', async () => {
    const r = fakeRoutine();
    const releases: ((x: RunResult) => void)[] = [];
    r.set(() => new Promise<RunResult>((res) => { releases.push(res); }));
    const s = setup(r.routine);
    await s.manager.pollProject(project()); // returns although the pass hangs
    s.advance(WATCHDOG_CHECK_MS * 3);
    await s.manager.pollProject(project());
    expect(r.calls).toHaveLength(1);
    // Another project has its own lane.
    s.manager.watchdog(project('proj-b'));
    expect(r.calls).toHaveLength(2);
    for (const release of releases) release(answer({ ran: false, skipped: 'fresh', why: 'fresh', coordinator: { running: true, since: null } }));
    await s.manager.watchdogSettled();
    r.set(async () => answer({ ran: false, skipped: 'fresh', why: 'fresh', coordinator: { running: true, since: null } }));
    await s.manager.watchdogSettled();
    s.advance(WATCHDOG_CHECK_MS);
    s.manager.watchdog(project());
    expect(r.calls).toHaveLength(3);
    await s.manager.watchdogSettled();
  });

  it('"coordinator not running since <t>" is reported once per outage, with the decision; a new outage is reported again', async () => {
    const r = fakeRoutine();
    const s = setup(r.routine);
    const down = (since: string, why: string) => answer({ ran: true, why, coordinator: { running: false, since } });
    r.set(async () => down('2026-10-27T11:00:00.000Z', 'the coordinator crashed (exit code 1): starting it with the recovery prompt (1/2 today)'));
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes).toEqual([expect.objectContaining({ status: 'error', projectId: 'proj-a', text: expect.stringMatching(/coordinator not running since 2026-10-27T11:00:00.000Z \(the coordinator crashed.*recovery prompt/) })]);
    expect(s.logs.join('\n')).toMatch(/watchdog proj-a: routine pass ran/);
    // The same outage, another decision: no second report.
    r.set(async () => down('2026-10-27T11:00:00.000Z', 'crash start limit reached (2/2 today): left for the owner'));
    s.advance(WATCHDOG_CHECK_MS);
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes).toHaveLength(1);
    // Up again, then down again: a new report.
    r.set(async () => answer({ ran: false, skipped: 'fresh', why: 'fresh', coordinator: { running: true, since: '2026-10-27T12:10:00.000Z' } }));
    s.advance(WATCHDOG_CHECK_MS);
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    r.set(async () => down('2026-10-27T12:20:00.000Z', 'the coordinator was stopped (exit code 0)'));
    s.advance(WATCHDOG_CHECK_MS);
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes).toHaveLength(2);
    expect(s.outcomes[1]!.text).toMatch(/not running since 2026-10-27T12:20:00.000Z \(the coordinator was stopped/);
  });

  it('routine off (skipped: disabled) reports nothing, even with the coordinator down', async () => {
    const r = fakeRoutine();
    r.set(async () => answer({ ran: false, skipped: 'disabled', why: 'routine.enabled is off', coordinator: { running: false, since: '2026-10-27T11:00:00.000Z' } }));
    const s = setup(r.routine);
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes).toHaveLength(0);
  });

  it('a failing, timed-out or unreadable pass is reported once and never throws into the poll', async () => {
    const r = fakeRoutine();
    const s = setup(r.routine);
    r.set(async () => { throw new Error('docker exec failed'); });
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    s.advance(WATCHDOG_CHECK_MS);
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes).toEqual([expect.objectContaining({ text: 'project proj-a: watchdog routine pass failed: docker exec failed' })]);
    r.set(async () => ({ code: 124, stdout: '', stderr: '', timedOut: true }));
    s.advance(WATCHDOG_CHECK_MS);
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes.at(-1)!.text).toMatch(/timed out after 5 min/);
    r.set(async () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'no such option --routine' } }), stderr: '' }));
    s.advance(WATCHDOG_CHECK_MS);
    s.manager.watchdog(project());
    await s.manager.watchdogSettled();
    expect(s.outcomes.at(-1)!.text).toMatch(/no readable answer \(exit 1\): no such option --routine/);
    expect(s.outcomes).toHaveLength(3);
  });
});
