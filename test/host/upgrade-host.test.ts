// `minions upgrade` on the host runtime (task-7): runUpgrade with a fake host target (the shim exec is a fake
// runtime; nothing is installed, no shim or coordinator is touched for real), and the agent-writable CLI guard.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { hostRuntimePaths } from '../../src/core/paths.js';
import type { ProjectJson } from '../../src/host/project.js';
import type { HostRuntime } from '../../src/host/runtime.js';
import { HOST_UPGRADE_STEPS, formatUpgrade, runUpgrade, type HelperKind, type HostUpgradeTarget, type InterruptHooks, type LeaseInfo, type LiveHelper, type UpgradeOptions } from '../../src/host/upgrade.js';
import { agentWritableDirs, hostHelperControl, hostUpgradeTarget, unsafeCliReason } from '../../src/host/upgrade-host.js';
import type { ProcessLockKey, SupervisorLock } from '../../src/runtime/db.js';
import { dispatcherAlive } from '../../src/runtime/dispatcher.js';
import { supervisorAlive, type LockProcessView } from '../../src/runtime/supervisor.js';
import { tempDir, withHome } from './fixtures.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const ok = (data: unknown): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
const fail = (msg: string): RunResult => ({ code: 1, stdout: '', stderr: msg });
const noInterrupts: InterruptHooks = { subscribe: () => () => undefined, exit: () => undefined, notice: () => undefined };

let home: ReturnType<typeof withHome>;
beforeEach(() => { home = withHome(); });
afterEach(() => home.cleanup());

interface HostWorld {
  prepared: boolean;
  starts: boolean;
  /** Lease sets returned by successive status polls after the first (the last repeats). */
  timeline: LeaseInfo[][];
  leases: LeaseInfo[];
  cliProblem?: string | null;
  failShim?: boolean;
  events: string[];
  /** The runtime's upgrade requests (`settings requests` / `settings requests mark`); undefined: the verb fails. */
  requests?: { id: string; kind: string; status: string }[];
  /** Live supervisor/dispatcher lock holders (null: the DB is unreadable). */
  helpers: LiveHelper[] | null;
  /** Helpers that ignore SIGTERM. */
  stubborn?: HelperKind[];
  /** Whether the restarted wrapper starts the stopped helpers again (new pids). */
  respawn?: boolean;
}

const helper = (kind: HelperKind, pid: number): LiveHelper => ({ kind, lock: { pid, start: '100', bootId: 'boot-1', at: '2026-11-14T00:00:00Z' } });

function hostTarget(w: HostWorld): HostUpgradeTarget {
  let polls = 0;
  return {
    prepared: async () => w.prepared,
    cliProblem: async () => w.cliProblem ?? null,
    shimPlan: 'regenerate the shims for /opt/minions/dist/cli.js',
    regenerate: async () => { w.events.push('shim'); if (w.failShim) throw new Error('EACCES'); return 'shims regenerated'; },
    helpers: {
      live: () => w.helpers && [...w.helpers],
      stop: async (h) => {
        w.events.push(`stop:${h.kind}:${h.lock.pid}`);
        if (w.stubborn?.includes(h.kind)) return false;
        w.helpers = (w.helpers ?? []).filter((x) => x.lock.pid !== h.lock.pid);
        return true;
      },
    },
    exec: async (args: string[], _o?: RunOptions) => {
      const line = args.slice(1).filter((a) => a !== '--json').join(' ');
      if (line === 'status') {
        if (polls++ > 0 && w.timeline.length) w.leases = w.timeline.length > 1 ? w.timeline.shift()! : w.timeline[0]!;
        w.events.push(`status:${w.leases.length}`);
        return ok({ paused: { intake: false, starts: w.starts }, activeLeases: w.leases, draining: null });
      }
      if (line === 'pause --starts --drain --reason upgrade') { w.events.push('pause'); w.starts = true; return ok({ paused: { starts: true } }); }
      if (line === 'resume --starts') { w.events.push('resume'); w.starts = false; return ok({ paused: { starts: false } }); }
      if (line === 'workspace setup') { w.events.push('workspace'); return ok({}); }
      if (line === 'coordinator restart --recover') {
        // As the real verb (no --force): refused while a worker lease is active.
        if (w.leases.length) { w.events.push('coordinator:refused'); return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'PRECONDITION', message: 'Coordinator restart refused: active worker lease(s)' } }) + '\n', stderr: '' }; }
        w.events.push('coordinator');
        // The new wrapper's watches start the helpers whose lock is free, through the regenerated shim.
        if (w.respawn && w.helpers) for (const k of ['supervisor', 'dispatcher'] as const) if (!w.helpers.some((h) => h.kind === k)) w.helpers.push(helper(k, k === 'supervisor' ? 201 : 202));
        return ok({ action: 'restarted', running: true, reason: 'recover' });
      }
      if (line === 'settings requests' && w.requests) return ok({ requests: w.requests.filter((q) => ['proposed', 'confirmed', 'failed'].includes(q.status)) });
      if (args[1] === 'settings' && args[2] === 'requests' && args[3] === 'mark' && w.requests) {
        const q = w.requests.find((x) => x.id === args[4]);
        if (!q) return fail('NOT_FOUND');
        q.status = args[6]!; w.events.push(`mark:${q.id}:${q.status}`);
        return ok(q);
      }
      if (args[1] === 'work' && args[2] === 'release') { w.events.push(`release:${args[3]}`); w.leases = w.leases.filter((l) => l.id !== args[3]); w.timeline = w.timeline.map((s) => s.filter((l) => l.id !== args[3])); return ok({}); }
      return fail(`unexpected ${args.join(' ')}`);
    },
  };
}

const world = (over: Partial<HostWorld> = {}): HostWorld => ({ prepared: true, starts: false, timeline: [], leases: [], events: [], helpers: [], ...over });
const lease = (id: string): LeaseInfo => ({ id, task_id: `task-${id}`, role: 'engineer' });

function opts(w: HostWorld, over: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    projectId: ID, imageTag: 'unused', timeoutSec: 60, host: hostTarget(w), pollMs: 1, sleep: async () => undefined, interrupt: noInterrupts,
    refresh: async () => { w.events.push('files'); return []; },
    materialize: async () => { w.events.push('secrets'); },
    ...over,
  };
}

describe('runUpgrade on the host runtime', () => {
  it('drains the workers, regenerates plugin and shims, stops the old helpers, then restarts the coordinator once no lease is active', async () => {
    const w = world({ leases: [lease('a')], timeline: [[lease('a')], []], helpers: [helper('supervisor', 101), helper('dispatcher', 102)], respawn: true });
    const r = await runUpgrade(opts(w));
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(HOST_UPGRADE_STEPS.filter((id) => id !== 'sync' && id !== 'cli'));
    expect(r.steps.every((s) => s.status === 'done')).toBe(true);
    // The helpers stop after the shim (a respawn runs the installed build) and before the resume (the drain still holds).
    expect(w.events).toEqual(['status:1', 'pause', 'status:1', 'status:0', 'files', 'secrets', 'shim', 'workspace', 'stop:supervisor:101', 'stop:dispatcher:102', 'resume', 'coordinator']);
    expect(r.helpers).toEqual([{ kind: 'supervisor', pid: 101, stopped: true, back: 201 }, { kind: 'dispatcher', pid: 102, stopped: true, back: 202 }]);
    expect(r.steps.find((s) => s.id === 'helpers')?.detail).toMatch(/stopped session supervisor \(pid 101\), dispatcher \(pid 102\)/);
    expect(r.steps.find((s) => s.id === 'helpers-check')?.detail).toMatch(/back on the installed build: session supervisor \(pid 201\), dispatcher \(pid 202\)/);
    expect(r.coordinator).toMatchObject({ action: 'restarted' });
    expect(r.steps.some((s) => s.id === 'image' || s.id === 'recreate' || s.id === 'import')).toBe(false);
  });

  it('a successful upgrade marks the open (proposed or failed) upgrade requests applied; a confirmed one is the self-update script\'s', async () => {
    const w = world({ requests: [
      { id: 'cr_0000000a', kind: 'upgrade', status: 'proposed' }, { id: 'cr_0000000b', kind: 'upgrade', status: 'failed' },
      { id: 'cr_0000000c', kind: 'upgrade', status: 'confirmed' }, { id: 'cr_0000000d', kind: 'upgrade', status: 'applied' },
    ] });
    const r = await runUpgrade(opts(w));
    expect(r.ok).toBe(true);
    expect(r.requestsApplied).toEqual(['cr_0000000a', 'cr_0000000b']);
    expect(w.events.slice(-2)).toEqual(['mark:cr_0000000a:applied', 'mark:cr_0000000b:applied']);
    expect(w.requests!.map((q) => q.status)).toEqual(['applied', 'applied', 'confirmed', 'applied']);
    expect(formatUpgrade(r)).toMatch(/Upgrade request\(s\) marked applied: cr_0000000a, cr_0000000b/);
    // A dry run or a failed upgrade marks nothing.
    const w2 = world({ requests: [{ id: 'cr_0000000e', kind: 'upgrade', status: 'proposed' }] });
    await runUpgrade(opts(w2, { dryRun: true }));
    const w3 = world({ requests: [{ id: 'cr_0000000f', kind: 'upgrade', status: 'proposed' }], failShim: true });
    await expect(runUpgrade(opts(w3))).rejects.toThrow();
    expect([w2.requests![0]!.status, w3.requests![0]!.status]).toEqual(['proposed', 'proposed']);
  });

  it('dry run explains each host step and changes nothing', async () => {
    const w = world({ leases: [lease('a')] });
    const r = await runUpgrade(opts(w, { dryRun: true }));
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(['preflight', 'pause', 'drain', 'files', 'secrets', 'shim', 'workspace', 'helpers', 'resume', 'coordinator', 'helpers-check']);
    for (const s of r.steps) expect(s.detail.length).toBeGreaterThan(10);
    expect(r.steps.find((s) => s.id === 'helpers')).toMatchObject({ status: 'planned', detail: expect.stringMatching(/none running now/) });
    w.helpers = [helper('dispatcher', 102)];
    const r2 = await runUpgrade(opts(w, { dryRun: true }));
    expect(r2.steps.find((s) => s.id === 'helpers')?.detail).toMatch(/running now: dispatcher \(pid 102\).*identity-checked SIGTERM/);
    expect(w.events.filter((e) => e.startsWith('stop'))).toEqual([]);
    w.events.splice(1);
    expect(r.steps.find((s) => s.id === 'shim')?.detail).toContain('/opt/minions/dist/cli.js');
    expect(r.steps.find((s) => s.id === 'coordinator')?.detail).toMatch(/refused while a worker lease is active/);
    expect(w.events).toEqual(['status:1']);
    expect(formatUpgrade(r)).toMatch(/dry run; nothing changed/);
  });

  it('refuses a CLI inside the agent-writable dirs before pausing anything', async () => {
    const w = world({ cliProblem: 'the CLI the shims would run (/x) is inside the agent-writable /w' });
    const dry = await runUpgrade(opts(w, { dryRun: true }));
    expect(dry.ok).toBe(false);
    expect(dry.steps[0]).toMatchObject({ id: 'preflight', status: 'failed' });
    await expect(runUpgrade(opts(w))).rejects.toThrow(/agent-writable/);
    expect(w.events.filter((e) => !e.startsWith('status'))).toEqual([]);
  });

  it('an unprepared host runtime fails the preflight', async () => {
    const w = world({ prepared: false });
    await expect(runUpgrade(opts(w))).rejects.toThrow(/host runtime has not been started/);
    expect(w.events).toEqual([]);
  });

  it('workers still active at the timeout: aborts, resumes starts, never touches the shims or the coordinator', async () => {
    const w = world({ leases: [lease('a')], timeline: [[lease('a')]] });
    let t = 0;
    await expect(runUpgrade(opts(w, { timeoutSec: 1, clock: () => (t += 600) }))).rejects.toThrow(/still active/);
    expect(w.events).not.toContain('shim');
    expect(w.events).not.toContain('coordinator');
    expect(w.events.at(-1)).toBe('resume');
  });

  it('--now releases the remaining leases first, so the restart runs with no worker', async () => {
    const w = world({ leases: [lease('a')], timeline: [[lease('a')]] });
    const r = await runUpgrade(opts(w, { timeoutSec: 0, now: true }));
    expect(r.interrupted.map((l) => l.id)).toEqual(['a']);
    expect(w.events.indexOf('release:a')).toBeLessThan(w.events.indexOf('coordinator'));
    expect(w.events).not.toContain('coordinator:refused');
  });

  it('a failed shim regeneration stops before workspace and coordinator (the rerun finishes the job)', async () => {
    const w = world({ failShim: true });
    await expect(runUpgrade(opts(w))).rejects.toThrow(/regenerating the host runtime shims/);
    expect(w.events).not.toContain('coordinator');
  });

  it('no helper running (or an unreadable DB): the helpers steps are skipped and the upgrade succeeds', async () => {
    for (const helpers of [[], null]) {
      const w = world({ helpers });
      const r = await runUpgrade(opts(w));
      expect(r.ok).toBe(true);
      expect(r.steps.find((s) => s.id === 'helpers')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(helpers ? /no session supervisor or dispatcher running/ : /not readable/) });
      expect(r.steps.find((s) => s.id === 'helpers-check')).toMatchObject({ status: 'skipped', detail: 'no helper was stopped' });
      expect(w.events).toContain('coordinator');
      expect(r.helpers).toBeUndefined();
    }
  });

  it('a helper that does not exit fails the step with the exact check and kill commands; the coordinator still restarts', async () => {
    const w = world({ helpers: [helper('supervisor', 101), helper('dispatcher', 102)], stubborn: ['supervisor'], respawn: true });
    const r = await runUpgrade(opts(w));
    expect(r.ok).toBe(false);
    const s = r.steps.find((x) => x.id === 'helpers')!;
    expect(s.status).toBe('failed');
    expect(s.detail).toMatch(/stopped dispatcher \(pid 102\); session supervisor \(pid 101\) did not exit.*ps -o pid,lstart,command -p 101.*kill 101/);
    expect(w.events.slice(-2)).toEqual(['resume', 'coordinator']);
    expect(r.steps.find((x) => x.id === 'helpers-check')?.detail).toMatch(/dispatcher \(pid 202\)/);
  });

  it('helpers not back within the wait: reported with when the wrapper starts them, not a failure', async () => {
    const w = world({ helpers: [helper('supervisor', 101), helper('dispatcher', 102)] });
    let sleeps = 0;
    const r = await runUpgrade(opts(w, { helperWaitMs: 10_000, sleep: async () => { sleeps++; } }));
    expect(r.ok).toBe(true);
    expect(sleeps).toBe(5);
    expect(r.steps.find((s) => s.id === 'helpers-check')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/not running yet after 10s: the coordinator wrapper's watch starts the session supervisor within 60 s and the dispatcher within 20 s/) });
    expect(r.helpers?.map((h) => h.back)).toEqual([null, null]);
  });

  it('needs exactly one of compose and host', async () => {
    const w = world();
    await expect(runUpgrade({ ...opts(w), host: undefined })).rejects.toThrow(/exactly one/);
  });
});

describe('agent-writable CLI guard', () => {
  const project = { projectId: ID } as ProjectJson;

  it('flags a CLI inside the host workspace or state, also through a symlink, and passes one outside', () => {
    const [ws, st] = agentWritableDirs(ID);
    mkdirSync(join(ws!, 'repo', 'dist'), { recursive: true });
    mkdirSync(st!, { recursive: true });
    expect(unsafeCliReason({ cliPaths: [join(ws!, 'repo', 'dist', 'cli.js')], agentWritable: [ws!, st!] })).toMatch(/inside the agent-writable/);
    const outside = tempDir('minions-global-');
    symlinkSync(join(ws!, 'repo'), join(outside, 'minions'));
    expect(unsafeCliReason({ cliPaths: [join(outside, 'minions', 'dist', 'cli.js')], agentWritable: [ws!, st!] })).toMatch(/inside the agent-writable/);
    expect(unsafeCliReason({ cliPaths: [], installed: { kind: 'link', path: join(outside, 'minions'), realPath: join(ws!, 'repo') }, agentWritable: [ws!, st!] })).toMatch(/is a link into the agent-writable/);
    mkdirSync(join(outside, 'pkg', 'dist'), { recursive: true });
    writeFileSync(join(outside, 'pkg', 'dist', 'cli.js'), '');
    expect(unsafeCliReason({ cliPaths: [join(outside, 'pkg', 'dist', 'cli.js')], installed: { kind: 'packed', path: join(outside, 'pkg'), realPath: join(outside, 'pkg') }, agentWritable: [ws!, st!] })).toBeNull();
  });

  it('hostUpgradeTarget checks the shim target and the global install, and regenerates the shim for that target', async () => {
    const hp = hostRuntimePaths(ID);
    const fakeHost = { exec: async () => ok({}), prepared: async () => true } as unknown as HostRuntime;
    const prepared: string[] = [];
    const t = hostUpgradeTarget(project, fakeHost, {
      target: { node: '/usr/bin/node', cli: join(hp.workspace, 'repo', 'dist', 'cli.js') },
      installed: async () => null,
      prepare: async (_p, o) => { prepared.push(o.target.cli); },
    });
    expect(await t.cliProblem()).toMatch(/inside the agent-writable/);
    const safe = hostUpgradeTarget(project, fakeHost, {
      target: { node: '/usr/bin/node', cli: '/opt/homebrew/lib/node_modules/minions/dist/cli.js' },
      installed: async () => ({ path: '/opt/homebrew/lib/node_modules/minions', realPath: '/opt/homebrew/lib/node_modules/minions', kind: 'packed', version: '0.1.0', stamp: null, resolved: null, running: true }),
      prepare: async (_p, o) => { prepared.push(o.target.cli); },
    });
    expect(await safe.cliProblem()).toBeNull();
    expect(safe.shimPlan).toContain(hp.minionsShim);
    expect(await safe.regenerate()).toBe(`${join(hp.bin, 'minions')} -> /opt/homebrew/lib/node_modules/minions/dist/cli.js`);
    expect(prepared).toEqual(['/opt/homebrew/lib/node_modules/minions/dist/cli.js']);
  });
});

describe('host helper control (identity-checked stop)', () => {
  /** A fake process table: pid -> start time and command line; boot id fixed. */
  function view(procs: Record<number, { start: string; cmd: string }>): LockProcessView {
    return { alive: (pid) => pid in procs, startTime: (pid) => procs[pid]?.start ?? null, cmdline: (pid) => procs[pid]?.cmd ?? null, bootId: () => 'boot-1' };
  }
  const lock = (pid: number, start = '100', bootId = 'boot-1'): SupervisorLock => ({ pid, start, bootId, at: '2026-11-14T00:00:00Z' });

  function control(procs: Record<number, { start: string; cmd: string }>, locks: Record<ProcessLockKey, SupervisorLock | null> | null) {
    const v = view(procs);
    const kills: [number, string][] = [];
    const c = hostHelperControl('/nonexistent/minions.db', {
      locks: () => locks,
      alive: (key, l) => (key === 'dispatcher_lock' ? dispatcherAlive(l, v) : supervisorAlive(l, v)),
      kill: (pid, sig) => { kills.push([pid, sig]); delete procs[pid]; },
      timeoutMs: 50, pollMs: 1,
    });
    return { c, kills };
  }

  it('lists and stops the live holders with SIGTERM', async () => {
    const procs = { 101: { start: '100', cmd: 'node /x/cli.js coordinator supervise' }, 102: { start: '100', cmd: 'node /x/cli.js work dispatch' } };
    const { c, kills } = control(procs, { supervisor_lock: lock(101), dispatcher_lock: lock(102) });
    const live = c.live()!;
    expect(live.map((h) => [h.kind, h.lock.pid])).toEqual([['supervisor', 101], ['dispatcher', 102]]);
    for (const h of live) expect(await c.stop(h)).toBe(true);
    expect(kills).toEqual([[101, 'SIGTERM'], [102, 'SIGTERM']]);
    expect(c.live()).toEqual([]);
  });

  it('never signals a reused pid, a lock from another boot, or a pid running another command', async () => {
    const procs = {
      101: { start: '999', cmd: 'node /x/cli.js coordinator supervise' }, // the pid was reused (other start time)
      102: { start: '100', cmd: '/usr/bin/vim notes.txt' }, // same start second, another program
    };
    const { c, kills } = control(procs, { supervisor_lock: lock(101), dispatcher_lock: lock(102) });
    expect(c.live()).toEqual([]);
    const other = control({ 101: { start: '100', cmd: 'node /x/cli.js coordinator supervise' } }, { supervisor_lock: lock(101, '100', 'boot-0'), dispatcher_lock: null });
    expect(other.c.live()).toEqual([]);
    // A holder whose identity changed between the listing and the stop is not signalled either.
    expect(await c.stop({ kind: 'supervisor', lock: lock(101) })).toBe(true);
    expect([...kills, ...other.kills]).toEqual([]);
  });

  it('no locks, or an unreadable DB', () => {
    expect(control({}, { supervisor_lock: null, dispatcher_lock: null }).c.live()).toEqual([]);
    expect(control({}, null).c.live()).toBeNull();
  });
});
