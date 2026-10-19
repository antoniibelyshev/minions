// `minions upgrade` core with a fake Runner behind the real Compose and ensureImage: step order, lease
// drain (wait / timeout / --now), fingerprint-gated rebuild, volume and backlog preservation, failure paths.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { projectPaths } from '../../src/core/paths.js';
import { Compose, buildFingerprint } from '../../src/host/docker.js';
import type { ImportResult } from '../../src/host/transfer.js';
import { UPGRADE_RELEASE_REASON, formatUpgrade, runUpgrade, type LeaseInfo, type UpgradeOptions } from '../../src/host/upgrade.js';
import { tempDir, withHome } from './fixtures.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const TAG = 'minions-runtime:test';
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const env = (data: unknown) => ok(JSON.stringify({ ok: true, data }) + '\n');

let home: ReturnType<typeof withHome>;
let root: string;
beforeEach(() => {
  home = withHome();
  root = tempDir('minions-pkg-');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'docker'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), 'console.log(1)\n');
  writeFileSync(join(root, 'docker', 'Dockerfile'), 'FROM node\n');
  writeFileSync(join(root, 'package.json'), '{"name":"minions"}\n');
});
afterEach(() => home.cleanup());

interface World {
  container: 'running' | 'absent';
  label: string | null;
  paused: { intake: boolean; starts: boolean };
  /** Lease sets returned by successive `status` calls after the first (the last one repeats). */
  leaseTimeline: LeaseInfo[][];
  leases: LeaseInfo[];
  /** Named volume contents: only `down -v` / `volume rm` could remove them. */
  volumes: { workspace: string[]; state: string[]; claude: string[] };
  coordinatorRunning: boolean;
  fail?: Partial<Record<'recreate' | 'workspace' | 'resume' | 'pause' | 'build', boolean>>;
}

function world(over: Partial<World> = {}): World {
  return {
    container: 'running', label: buildFingerprint(root), paused: { intake: false, starts: false }, leaseTimeline: [], leases: [],
    volumes: { workspace: ['repo', 'backlog/tasks/task-1.md', 'backlog/tasks/task-2.md', 'worktrees/task-1'], state: ['runtime.db'], claude: ['login'] },
    coordinatorRunning: true, ...over,
  };
}

function harness(w: World) {
  const events: string[] = [];
  const calls: string[][] = [];
  let statusCalls = 0;
  const runner = async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    if (args[0] === 'image' && args[1] === 'inspect') return w.label === null ? { code: 1, stdout: '', stderr: 'No such image' } : ok(w.label + '\n');
    if (args[0] === 'build') { events.push('build'); if (w.fail?.build) throw new Error('build failed'); w.label = args[args.indexOf('--label') + 1]!.split('=')[1]!; return ok(); }
    if (args[0] === 'volume' || (args.includes('down') && args.includes('-v'))) { w.volumes = { workspace: [], state: [], claude: [] }; return ok(); }
    const sub = args.slice(5); // after: compose -p <name> -f <file>
    if (sub[0] === 'ps') return ok(w.container === 'running' ? '{"State":"running"}\n' : '');
    if (sub[0] === 'up') {
      events.push(sub.includes('--force-recreate') ? 'recreate' : 'up');
      if (w.fail?.recreate) return Promise.reject(new Error('compose up failed'));
      // A new container: processes are gone, named volumes (and so the runtime DB) are kept.
      w.container = 'running'; w.coordinatorRunning = false;
      return ok();
    }
    if (sub[0] === 'exec') {
      const m = sub.slice(3); // exec -T app minions ...
      const line = m.slice(1).filter((a) => a !== '--json').join(' ');
      if (w.container !== 'running') return { code: 1, stdout: '', stderr: 'service "app" is not running' };
      if (line === 'status') {
        if (statusCalls++ > 0 && w.leaseTimeline.length) w.leases = w.leaseTimeline.length > 1 ? w.leaseTimeline.shift()! : w.leaseTimeline[0]!;
        events.push('status');
        return env({ paused: { ...w.paused }, activeLeases: w.leases });
      }
      if (line === 'pause --starts') { events.push('pause'); if (w.fail?.pause) return { code: 1, stdout: '', stderr: 'db locked' }; w.paused.starts = true; return env({ paused: w.paused }); }
      if (line === 'resume --starts') { events.push('resume'); if (w.fail?.resume) return { code: 1, stdout: '', stderr: 'db locked' }; w.paused.starts = false; return env({ paused: w.paused }); }
      if (m[1] === 'work' && m[2] === 'release') {
        events.push(`release:${m[3]}`);
        expect(m[5]).toBe(UPGRADE_RELEASE_REASON);
        w.leases = w.leases.filter((l) => l.id !== m[3]); w.leaseTimeline = w.leaseTimeline.map((s) => s.filter((l) => l.id !== m[3]));
        return env({ leaseId: m[3] });
      }
      if (line === 'workspace setup') { events.push('workspace'); return w.fail?.workspace ? { code: 1, stdout: '', stderr: 'disk full' } : env({}); }
      if (line === 'coordinator restart --recover') {
        events.push('coordinator');
        // Mirrors task-3.1: refuses while leases are active in a running session.
        if (w.coordinatorRunning && w.leases.length) return ok(JSON.stringify({ ok: false, error: { code: 'PRECONDITION', message: 'leases active' } }));
        const action = w.coordinatorRunning ? 'restarted' : 'started';
        w.coordinatorRunning = true;
        return env({ action, running: true, reason: 'coordinator started with the recovery prompt', telegram: false });
      }
      return { code: 1, stdout: '', stderr: `unexpected exec ${line}` };
    }
    return { code: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}` };
  };
  let t = 0;
  const opts = (over: Partial<UpgradeOptions> = {}): UpgradeOptions => ({
    projectId: ID, imageTag: TAG, compose: new Compose(ID, runner), runner, root, timeoutSec: 60,
    refresh: async () => { events.push('files'); return []; },
    importRepo: async () => { events.push('origin'); return { bundle: 'b', commit: 'c', baseBranch: 'main', warnings: [], container: { origin: { url: 'https://github.com/o/r.git', authenticated: true, fetched: true, warnings: [] } } } satisfies ImportResult; },
    materialize: async () => { events.push('secrets'); },
    sleep: async (ms) => { t += ms; }, clock: () => t, pollMs: 10_000,
    ...over,
  });
  /** Calls that could change state (anything except reads). */
  const mutating = () => calls.filter((c) => {
    const a = c.slice(1);
    if (a[0] === 'image' && a[1] === 'inspect') return false;
    if (a[5] === 'ps') return false;
    if (a[5] === 'exec' && a.slice(9).filter((x) => x !== '--json').join(' ') === 'status') return false;
    return true;
  });
  return { events, calls, runner, opts, mutating, elapsed: () => t };
}

const ids = (r: { steps: { id: string; status: string }[] }) => r.steps.map((s) => `${s.id}:${s.status}`);
const lease = (id: string, task: string, role = 'engineer'): LeaseInfo => ({ id, task_id: task, role });

describe('runUpgrade', () => {
  it('runs every step in order without a rebuild when the fingerprint is unchanged', async () => {
    const w = world();
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(r.ok).toBe(true);
    expect(h.events).toEqual(['status', 'pause', 'files', 'secrets', 'recreate', 'workspace', 'origin', 'resume', 'coordinator']);
    expect(ids(r)).toEqual(['preflight:done', 'pause:done', 'drain:done', 'files:done', 'image:skipped', 'secrets:done', 'recreate:done',
      'workspace:done', 'origin:done', 'resume:done', 'coordinator:done']);
    expect(r.image.rebuild).toBe(false);
    expect(h.calls.some((c) => c[1] === 'build')).toBe(false);
    expect(r.coordinator).toMatchObject({ action: 'started', running: true });
    expect(w.paused.starts).toBe(false);
    expect(existsSync(join(projectPaths(ID).dir, 'upgrade.json'))).toBe(false);
    expect(formatUpgrade(r)).toContain('complete');
  });

  it('keeps volumes and the backlog: no down, no -v, no volume commands; the container is recreated in place', async () => {
    const w = world({ leaseTimeline: [[lease('l1', 'task-1')], []], leases: [lease('l1', 'task-1')] });
    const before = structuredClone(w.volumes);
    const h = harness(w);
    await runUpgrade(h.opts());
    expect(w.volumes).toEqual(before);
    const docker = h.calls.map((c) => c.slice(1));
    expect(docker.some((a) => a.includes('down') || a.includes('-v') || a.includes('--volumes') || a[0] === 'volume' || a.includes('rm'))).toBe(false);
    const up = docker.filter((a) => a[5] === 'up');
    expect(up).toEqual([['compose', '-p', expect.any(String), '-f', projectPaths(ID).composeYaml, 'up', '-d', '--no-build', '--force-recreate', '--remove-orphans']]);
    // Only these container commands run: no workspace import/re-clone from here, no backlog writes.
    const execs = docker.filter((a) => a[5] === 'exec').map((a) => a.slice(9).filter((x) => x !== '--json').slice(0, 2).join(' '));
    expect(new Set(execs)).toEqual(new Set(['status', 'pause --starts', 'workspace setup', 'resume --starts', 'coordinator restart']));
  });

  it('rebuilds the image after the drain and before the recreate when the fingerprint changed', async () => {
    const w = world({ label: 'stale0000000000' });
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(h.events).toEqual(['status', 'pause', 'files', 'build', 'secrets', 'recreate', 'workspace', 'origin', 'resume', 'coordinator']);
    expect(r.image).toMatchObject({ rebuild: true, previous: 'stale0000000000', fingerprint: buildFingerprint(root) });
    expect(w.label).toBe(buildFingerprint(root));
    expect(r.steps.find((s) => s.id === 'image')?.status).toBe('done');
  });

  it('waits for active leases to end before touching the container', async () => {
    const a = lease('l1', 'task-1'), b = lease('l2', 'task-2', 'reviewer');
    const w = world({ leases: [a, b], leaseTimeline: [[a, b], [b], []] });
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(r.ok).toBe(true);
    expect(r.interrupted).toEqual([]);
    expect(h.events.slice(0, 6)).toEqual(['status', 'pause', 'status', 'status', 'status', 'files']);
    expect(h.elapsed()).toBe(30_000);
  });

  it('aborts on --timeout without --now: starts resumed, no rebuild, container untouched', async () => {
    const a = lease('l1', 'task-1');
    const w = world({ label: 'stale0000000000', leases: [a], leaseTimeline: [[a]] });
    const h = harness(w);
    const err = await runUpgrade(h.opts({ timeoutSec: 25 })).catch((e) => e);
    expect(err).toMatchObject({ code: 'PRECONDITION' });
    expect(err.message).toMatch(/still active after 25s \(task-1\)/);
    expect(err.hint).toMatch(/--now/);
    expect(h.events.filter((e) => e !== 'status')).toEqual(['pause', 'resume']);
    expect(w.paused.starts).toBe(false);
    expect(w.coordinatorRunning).toBe(true);
    expect(h.elapsed()).toBe(25_000);
    expect(err.details.steps.map((s: { id: string; status: string }) => `${s.id}:${s.status}`)).toEqual(['preflight:done', 'pause:done', 'drain:failed', 'resume:done']);
    expect(existsSync(join(projectPaths(ID).dir, 'upgrade.json'))).toBe(false);
  });

  it('--now releases the remaining leases, reports them interrupted, and preserves the leases for recovery', async () => {
    const a = lease('l1', 'task-1'), b = lease('l2', 'task-2', 'tester');
    const w = world({ leases: [a, b], leaseTimeline: [[a, b]] });
    const h = harness(w);
    const r = await runUpgrade(h.opts({ timeoutSec: 0, now: true }));
    expect(r.ok).toBe(true);
    expect(r.interrupted).toEqual([a, b]);
    expect(h.events).toEqual(['status', 'pause', 'release:l1', 'release:l2', 'files', 'secrets', 'recreate', 'workspace', 'origin', 'resume', 'coordinator']);
    expect(r.steps.find((s) => s.id === 'drain')?.detail).toMatch(/released 2 lease\(s\) as interrupted/);
    expect(formatUpgrade(r)).toMatch(/Interrupted leases .*l1 \(task-1, engineer\), l2 \(task-2, tester\)/);
  });

  it('leaves starts paused by the user paused', async () => {
    const w = world({ paused: { intake: false, starts: true } });
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(h.events).not.toContain('pause');
    expect(h.events).not.toContain('resume');
    expect(w.paused.starts).toBe(true);
    expect(r.steps.find((s) => s.id === 'resume')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/paused before the upgrade/) });
  });

  it('--dry-run lists every step and changes nothing', async () => {
    const a = lease('l1', 'task-1');
    const w = world({ label: 'stale0000000000', leases: [a] });
    const h = harness(w);
    const r = await runUpgrade(h.opts({ dryRun: true, now: true, timeoutSec: 0 }));
    expect(r.dryRun).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(['preflight', 'pause', 'drain', 'files', 'image', 'secrets', 'recreate', 'workspace', 'origin', 'resume', 'coordinator']);
    expect(r.steps.filter((s) => s.id !== 'preflight').every((s) => s.status === 'planned')).toBe(true);
    expect(r.steps.find((s) => s.id === 'drain')?.detail).toMatch(/release 1 active lease\(s\) now .*l1 \(task-1, engineer\)/);
    expect(h.mutating()).toEqual([]);
    expect(h.events.filter((e) => e !== 'status')).toEqual([]);
    expect(existsSync(join(projectPaths(ID).dir, 'upgrade.json'))).toBe(false);
    expect(formatUpgrade(r)).toMatch(/dry run; nothing changed/);
  });

  it('continues after a post-recreate failure: still resumes starts and restarts the coordinator', async () => {
    const w = world({ fail: { workspace: true } });
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(r.ok).toBe(false);
    expect(h.events.slice(-4)).toEqual(['workspace', 'origin', 'resume', 'coordinator']);
    expect(r.steps.find((s) => s.id === 'workspace')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/disk full/) });
    expect(w.paused.starts).toBe(false);
    expect(w.coordinatorRunning).toBe(true);
  });

  it('a failed recreate keeps volumes and remembers its pause, so a rerun resumes starts', async () => {
    const w = world({ fail: { recreate: true } });
    const h = harness(w);
    const err = await runUpgrade(h.opts()).catch((e) => e);
    expect(err.message).toMatch(/recreating the container/);
    expect(err.hint).toMatch(/Rerun `minions upgrade`/);
    expect(w.paused.starts).toBe(true);
    expect(existsSync(join(projectPaths(ID).dir, 'upgrade.json'))).toBe(true);
    expect(w.volumes.workspace).toContain('backlog/tasks/task-1.md');

    // The rerun sees starts paused, but by the unfinished upgrade: it resumes them at the end.
    w.fail = {};
    const h2 = harness(w);
    const r = await runUpgrade(h2.opts());
    expect(r.ok).toBe(true);
    expect(h2.events).not.toContain('pause');
    expect(h2.events).toContain('resume');
    expect(w.paused.starts).toBe(false);
    expect(existsSync(join(projectPaths(ID).dir, 'upgrade.json'))).toBe(false);
  });

  it('a failed image build resumes starts and leaves the running container alone', async () => {
    const w = world({ label: 'stale0000000000', fail: { build: true } });
    const h = harness(w);
    const err = await runUpgrade(h.opts()).catch((e) => e);
    expect(err.message).toMatch(/Upgrade aborted at image: build failed/);
    expect(h.events).toEqual(['status', 'pause', 'files', 'build', 'resume']);
    expect(w.paused.starts).toBe(false);
    expect(w.coordinatorRunning).toBe(true);
  });

  it('a failed pause aborts before anything else and still tries to resume', async () => {
    const w = world({ fail: { pause: true } });
    const h = harness(w);
    const err = await runUpgrade(h.opts()).catch((e) => e);
    expect(err.message).toMatch(/aborted at pause/);
    expect(h.events).toEqual(['status', 'pause', 'resume']);
  });

  it('with the container not running: no pause or drain, then recreate, setup and coordinator start', async () => {
    const w = world({ container: 'absent', coordinatorRunning: false });
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(r.ok).toBe(true);
    expect(ids(r).slice(0, 3)).toEqual(['preflight:done', 'pause:skipped', 'drain:skipped']);
    expect(h.events).toEqual(['files', 'secrets', 'recreate', 'workspace', 'origin', 'coordinator']);
  });

  it('refuses to start when the container state is unknown', async () => {
    const w = world();
    const h = harness(w);
    const compose = new Compose(ID, async (c, a, o) => (a[5] === 'ps' ? { code: 1, stdout: '', stderr: 'boom' } : h.runner(c, a, o)));
    const err = await runUpgrade(h.opts({ compose })).catch((e) => e);
    expect(err).toMatchObject({ code: 'PRECONDITION' });
    expect(h.events).toEqual([]);
  });
});

// Graceful-upgrade probes: a live coordinator session during the drain, an upgrade killed mid-drain,
// a stale upgrade.json, the --now release race, and --timeout N --now.
describe('runUpgrade: interruption and recovery', () => {
  const markerFile = () => join(projectPaths(ID).dir, 'upgrade.json');
  const writeMarker = () => { mkdirSync(projectPaths(ID).dir, { recursive: true }); writeFileSync(markerFile(), JSON.stringify({ pausedStarts: true, at: '2026-01-01T00:00:00.000Z' })); };

  it('the drain only polls status while the coordinator session runs: nothing is released, killed or recreated early', async () => {
    const a = lease('l1', 'task-1');
    const w = world({ leases: [a], leaseTimeline: [[a], [a], [a], []] });
    const h = harness(w);
    let checked = 0;
    const r = await runUpgrade(h.opts({
      timeoutSec: 600,
      sleep: async (ms) => {
        // Every wait happens with the session alive and the container untouched.
        expect(w.coordinatorRunning).toBe(true);
        expect(h.events).not.toContain('recreate');
        expect(h.mutating().map((c) => c.slice(1)).filter((a) => !(a[5] === 'exec' && a.includes('pause')))).toEqual([]);
        checked++;
        await h.opts().sleep!(ms);
      },
    }));
    expect(r.ok).toBe(true);
    expect(checked).toBe(4); // initial read, then three polls still showing l1, then the empty set
    expect(r.interrupted).toEqual([]);
    expect(h.events.filter((e) => e.startsWith('release'))).toEqual([]);
    expect(h.events.indexOf('recreate')).toBeGreaterThan(h.events.lastIndexOf('status'));
  });

  it('a run killed mid-drain leaves its pause and marker; the rerun finishes the drain and resumes starts', async () => {
    // State left by a SIGINT/SIGTERM during the wait: starts paused by the upgrade, marker on disk, lease active.
    const a = lease('l1', 'task-1');
    writeMarker();
    const w = world({ paused: { intake: false, starts: true }, leases: [a], leaseTimeline: [[a], []] });
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.id === 'pause')).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/unfinished upgrade/) });
    expect(h.events).not.toContain('pause');
    expect(h.events.slice(-2)).toEqual(['resume', 'coordinator']);
    expect(w.paused.starts).toBe(false);
    expect(existsSync(markerFile())).toBe(false);
  });

  it('a rerun after a killed run that times out again still resumes the inherited pause', async () => {
    const a = lease('l1', 'task-1');
    writeMarker();
    const w = world({ paused: { intake: false, starts: true }, leases: [a], leaseTimeline: [[a]] });
    const h = harness(w);
    const err = await runUpgrade(h.opts({ timeoutSec: 10 })).catch((e) => e);
    expect(err).toMatchObject({ code: 'PRECONDITION' });
    expect(h.events.filter((e) => e !== 'status')).toEqual(['resume']);
    expect(w.paused.starts).toBe(false);
    expect(existsSync(markerFile())).toBe(false);
  });

  it('a stale marker after the user resumed manually: pauses and resumes normally and clears the marker', async () => {
    writeMarker();
    const w = world();
    const h = harness(w);
    const r = await runUpgrade(h.opts());
    expect(r.ok).toBe(true);
    expect(h.events).toEqual(['status', 'pause', 'files', 'secrets', 'recreate', 'workspace', 'origin', 'resume', 'coordinator']);
    expect(w.paused.starts).toBe(false);
    expect(existsSync(markerFile())).toBe(false);
  });

  it('--dry-run with a stale marker reads it but does not remove it or touch the container', async () => {
    writeMarker();
    const w = world({ paused: { intake: false, starts: true } });
    const h = harness(w);
    const r = await runUpgrade(h.opts({ dryRun: true }));
    expect(r.steps.find((s) => s.id === 'resume')?.status).toBe('planned');
    expect(h.mutating()).toEqual([]);
    expect(existsSync(markerFile())).toBe(true);
  });

  it('--timeout N --now waits N seconds, lets finished leases end normally, then releases only the rest', async () => {
    const a = lease('l1', 'task-1'), b = lease('l2', 'task-2', 'reviewer');
    const w = world({ leases: [a, b], leaseTimeline: [[a, b], [b]] });
    const h = harness(w);
    const r = await runUpgrade(h.opts({ timeoutSec: 30, now: true }));
    expect(r.ok).toBe(true);
    expect(h.elapsed()).toBe(30_000);
    expect(r.interrupted).toEqual([b]);
    expect(h.events.filter((e) => e.startsWith('release'))).toEqual(['release:l2']);
    expect(h.events.indexOf('release:l2')).toBeLessThan(h.events.indexOf('recreate'));
  });

  it('a lease that ends between the last poll and its --now release aborts safely: starts resumed, container untouched', async () => {
    const a = lease('l1', 'task-1');
    const w = world({ leases: [a], leaseTimeline: [[a]] });
    const base = harness(w);
    const runner = async (c: string, args: string[], o?: RunOptions): Promise<RunResult> =>
      args.includes('release') ? { code: 1, stdout: '', stderr: 'Lease l1 already ended (completed).' } : base.runner(c, args, o);
    const err = await runUpgrade(base.opts({ timeoutSec: 0, now: true, compose: new Compose(ID, runner), runner })).catch((e) => e);
    expect(err.message).toMatch(/aborted at drain: work release l1 failed/);
    expect(base.events).not.toContain('recreate');
    expect(base.events.at(-1)).toBe('resume');
    expect(w.paused.starts).toBe(false);
    expect(w.coordinatorRunning).toBe(true);
  });

  it('no path issues compose down, -v or volume commands (success, timeout, --now, failed recreate, post-recreate failure)', async () => {
    const a = lease('l1', 'task-1');
    const scenarios: [Partial<World>, Partial<UpgradeOptions>][] = [
      [{}, {}],
      [{ leases: [a], leaseTimeline: [[a]] }, { timeoutSec: 5 }],
      [{ leases: [a], leaseTimeline: [[a]] }, { timeoutSec: 0, now: true }],
      [{ fail: { recreate: true } }, {}],
      [{ fail: { workspace: true, resume: true } }, {}],
      [{ label: 'stale0000000000', fail: { build: true } }, {}],
      [{ container: 'absent', coordinatorRunning: false }, {}],
    ];
    for (const [over, o] of scenarios) {
      const w = world(over);
      const before = structuredClone(w.volumes);
      const h = harness(w);
      await runUpgrade(h.opts(o)).catch(() => undefined);
      const docker = h.calls.map((c) => c.slice(1));
      expect(docker.filter((x) => x.includes('down') || x.includes('-v') || x.includes('--volumes') || x[0] === 'volume' || x.includes('rm'))).toEqual([]);
      expect(w.volumes).toEqual(before);
    }
  });
});
