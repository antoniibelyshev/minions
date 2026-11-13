// `minions upgrade` on the host runtime (task-7): runUpgrade with a fake host target (the shim exec is a fake
// runtime; nothing is installed, no shim or coordinator is touched for real), and the agent-writable CLI guard.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { hostRuntimePaths } from '../../src/core/paths.js';
import type { ProjectJson } from '../../src/host/project.js';
import type { HostRuntime } from '../../src/host/runtime.js';
import { HOST_UPGRADE_STEPS, formatUpgrade, runUpgrade, type HostUpgradeTarget, type InterruptHooks, type LeaseInfo, type UpgradeOptions } from '../../src/host/upgrade.js';
import { agentWritableDirs, hostUpgradeTarget, unsafeCliReason } from '../../src/host/upgrade-host.js';
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
}

function hostTarget(w: HostWorld): HostUpgradeTarget {
  let polls = 0;
  return {
    prepared: async () => w.prepared,
    cliProblem: async () => w.cliProblem ?? null,
    shimPlan: 'regenerate the shims for /opt/minions/dist/cli.js',
    regenerate: async () => { w.events.push('shim'); if (w.failShim) throw new Error('EACCES'); return 'shims regenerated'; },
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

const world = (over: Partial<HostWorld> = {}): HostWorld => ({ prepared: true, starts: false, timeline: [], leases: [], events: [], ...over });
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
  it('drains the workers, regenerates plugin and shims, then restarts the coordinator once no lease is active', async () => {
    const w = world({ leases: [lease('a')], timeline: [[lease('a')], []] });
    const r = await runUpgrade(opts(w));
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(HOST_UPGRADE_STEPS.filter((id) => id !== 'sync' && id !== 'cli'));
    expect(r.steps.every((s) => s.status === 'done')).toBe(true);
    expect(w.events).toEqual(['status:1', 'pause', 'status:1', 'status:0', 'files', 'secrets', 'shim', 'workspace', 'resume', 'coordinator']);
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
    expect(r.steps.map((s) => s.id)).toEqual(['preflight', 'pause', 'drain', 'files', 'secrets', 'shim', 'workspace', 'resume', 'coordinator']);
    for (const s of r.steps) expect(s.detail.length).toBeGreaterThan(10);
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
