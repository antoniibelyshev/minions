// task-53.4 (docs/design/host-manager.md, phase 3): the host manager core without Telegram. A fake transport, a
// fake delegate answering from a real runtime DB, a fake child runner (it runs the real host apply path in-process
// from the argv it is given) and a fake clock. Temp MINIONS_HOME; no Docker, no child processes.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (cfg: { execution: { maxActiveTasks: number } }, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), `maxActiveTasks ${cfg.execution.maxActiveTasks}\n`);
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const { validateConfig } = await import('../../src/config/resolve.js');
const { RuntimeDb } = await import('../../src/runtime/db.js');
const RT = await import('../../src/runtime/change-requests.js');
const CR = await import('../../src/host/change-requests.js');
const J = await import('../../src/host/change-journal.js');
const M = await import('../../src/host/manager.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { editProjectConfig } = await import('../../src/host/config-write.js');
const { run } = await import('../../src/core/exec.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type ManagerOffer = import('../../src/host/manager.js').ManagerOffer;
type ManagerOutcome = import('../../src/host/manager.js').ManagerOutcome;
type ManagerEvent = import('../../src/host/manager.js').ManagerEvent;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;

let env: ReturnType<typeof withHome>;
let db: InstanceType<typeof RuntimeDb>;
beforeEach(() => { env = withHome(); db = new RuntimeDb(':memory:'); });
afterEach(() => { db.close(); env.cleanup(); });

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
const runtimeConfig = (p: ProjectJson) => validateConfig(readJson(join(projectPaths(p.projectId).runtimeDir, 'config.json')));
const journal = () => readFileSync(J.journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);

async function install(name = 'repo') {
  const repo = makeRepo(env.root, name);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  return { project, local: projectPaths(project.projectId).configLocalJson };
}
const requestSet = (p: ProjectJson, key: string, value: string) =>
  RT.recordSettingRequest({ db, config: runtimeConfig(p) }, key, value, { reason: 'many independent tasks' }).request!.id;

const ok = (data: unknown, code = 0): RunResult => ({ code, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
const fail = (e: Error & { code?: string }): RunResult => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } }) + '\n', stderr: '' });

/** The runtime side of the delegate, answered from the test's DB (list and mark). `override` replaces an answer. */
function fakeDelegate() {
  const calls: string[][] = [];
  let override: ((argv: string[]) => RunResult | null) | null = null;
  const delegate = async (_p: ProjectJson, argv: string[]): Promise<RunResult> => {
    calls.push(argv);
    const o = override?.(argv);
    if (o) return o;
    try {
      if (argv[1] === 'settings' && argv[2] === 'requests' && argv[3] === 'mark') {
        const i = argv.indexOf('--status'), d = argv.indexOf('--detail');
        return ok(RT.markChangeRequest(db, argv[4]!, argv[i + 1]!, d > 0 ? argv[d + 1] : undefined));
      }
      if (argv[1] === 'settings' && argv[2] === 'requests') return ok({ requests: RT.listChangeRequests(db, { all: argv.includes('--all') }) });
    } catch (e) { return fail(e as Error); }
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  return { delegate, calls, setOverride: (f: typeof override) => { override = f; } };
}

/**
 * The host CLI child: records the argv and runs what `minions --json <argv>` would run on the host, in-process
 * (settings set through applySetting, settings restart answered as configured).
 */
function fakeChild(o: { restart?: 'restarted' | 'refused' } = {}) {
  const runs: string[][] = [];
  const runChild = async (p: ProjectJson, argv: string[]): Promise<RunResult> => {
    runs.push(argv);
    try {
      if (argv[0] === 'settings' && argv[1] === 'set') {
        const [, , key, value, ...flags] = argv;
        const rev = flags[flags.indexOf('--expect-revision') + 1];
        const ctx = await S.loadSettingsContext(p);
        const r = await SC.applySetting(ctx, key!, value!, { layer: flags.includes('--shared') ? 'shared' : 'local', yes: flags.includes('--yes'), restart: false, expectRevision: Number(rev) },
          { runtime: { running: async () => false, exec: async () => ok({}) }, confirm: async () => null });
        return ok(r);
      }
      if (argv[0] === 'settings' && argv[1] === 'restart') {
        return o.restart === 'refused' ? ok({ action: 'refused', detail: '1 active worker lease' }, 1) : ok({ action: 'restarted', detail: 'recover' });
      }
    } catch (e) { return fail(e as Error); }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { runChild, runs };
}

function fakeTransport() {
  const offers: ManagerOffer[] = [];
  const outcomes: ManagerOutcome[] = [];
  const queue: ManagerEvent[][] = [];
  let failSends = 0;
  return {
    offers, outcomes, queue,
    failNextSends: (n: number) => { failSends = n; },
    transport: {
      sendOffer: async (o: ManagerOffer) => { if (failSends > 0) { failSends--; throw new Error('telegram down'); } offers.push(o); },
      receive: async () => queue.shift() ?? [],
      sendOutcome: async (o: ManagerOutcome) => { outcomes.push(o); },
    },
  };
}

function setup(projects: ProjectJson[], o: { restart?: 'restarted' | 'refused'; running?: boolean } = {}) {
  let now = new Date('2026-10-26T10:00:00Z');
  const t = fakeTransport();
  const d = fakeDelegate();
  const c = fakeChild(o);
  const upgrades: unknown[] = [];
  const logs: string[] = [];
  const deps: ManagerDeps = {
    transport: t.transport,
    projects: async () => projects,
    loadProject: async (id) => { const p = projects.find((x) => x.projectId === id); if (!p) throw new Error(`no project ${id}`); return p; },
    running: async () => o.running ?? true,
    delegate: d.delegate,
    runChild: c.runChild,
    upgrade: async (_p, x) => { upgrades.push(x); return { ok: true, steps: [{ id: 'recreate', status: x.dryRun ? 'planned' : 'done', detail: 'recreate' }], summary: x.dryRun ? '1 steps planned' : 'complete' }; },
    now: () => now,
    sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    log: (l) => logs.push(l),
  };
  return { deps, t, d, c, upgrades, logs, manager: new M.HostManager(deps), advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('host manager: polling and offers', () => {
  it('offers each open request once, with the host-computed plan, and journals the offer', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    await s.manager.pollAll();
    await s.manager.pollAll();
    expect(s.t.offers).toHaveLength(1);
    const o = s.t.offers[0]!;
    expect(o).toMatchObject({ projectId: project.projectId, requestId: id, kind: 'config-set', summary: expect.stringMatching(/^set execution.maxActiveTasks: \d+ -> 5$/), loosens: expect.stringMatching(/more tasks/) });
    expect(o.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(o.text).toContain(`digest: ${o.digest}`);
    expect(o.text).toContain('reason (from the container, untrusted): "many independent tasks"');
    expect(o.expiresAt).toBe('2026-10-26T10:30:00.000Z');
    expect(journal()).toEqual([expect.objectContaining({ type: 'offer', requestId: id, nonce: o.nonce, digest: o.digest })]);
    // The poll goes through the delegate: `minions settings requests --json`.
    expect(s.d.calls[0]).toEqual(['minions', 'settings', 'requests', '--json']);
  });

  it('a stopped runtime is skipped quietly; a failed send is offered again on the next poll', async () => {
    const { project } = await install();
    requestSet(project, 'execution.maxActiveTasks', '5');
    const stopped = setup([project], { running: false });
    await stopped.manager.pollAll();
    expect(stopped.d.calls).toHaveLength(0);
    expect(stopped.t.outcomes).toHaveLength(0);
    const s = setup([project]);
    s.t.failNextSends(1);
    await s.manager.pollAll();
    expect(s.t.offers).toHaveLength(0);
    await s.manager.pollAll();
    expect(s.t.offers).toHaveLength(1);
    await s.manager.pollAll();
    expect(s.t.offers).toHaveLength(1);
  });

  it('timeout, oversize and malformed answers are project errors (reported once, output dropped); other projects still poll', async () => {
    const a = await install('a');
    const b = await install('b');
    requestSet(b.project, 'execution.maxActiveTasks', '5');
    const s = setup([a.project, b.project]);
    const mode = { v: 'timeout' as 'timeout' | 'oversize' | 'garbage' | 'rows' };
    s.d.setOverride((argv) => {
      if (argv[1] !== 'settings' || argv[3] === 'mark') return null;
      const isA = s.d.calls.length % 2 === 1; // a is polled first in each round
      if (!isA) return null;
      if (mode.v === 'timeout') return { code: 124, stdout: '', stderr: '', timedOut: true };
      if (mode.v === 'oversize') return { code: 0, stdout: 'x'.repeat(300 * 1024), stderr: '' };
      if (mode.v === 'garbage') return { code: 0, stdout: 'not json', stderr: '' };
      return ok({ requests: [{ id: '../../etc', kind: 'config-set', payload: {}, status: 'proposed' }, 'junk', null] });
    });
    await s.manager.pollAll();
    await s.manager.pollAll();
    let errors = s.t.outcomes.filter((o) => o.projectId === a.project.projectId);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.text).toMatch(/timed out after 30 s; its output was dropped/);
    expect(s.t.offers.map((o) => o.projectId)).toEqual([b.project.projectId]);

    mode.v = 'oversize';
    await s.manager.pollAll();
    mode.v = 'garbage';
    await s.manager.pollAll();
    mode.v = 'rows';
    await s.manager.pollAll();
    errors = s.t.outcomes.filter((o) => o.projectId === a.project.projectId);
    expect(errors.map((e) => e.text)).toEqual([
      expect.stringMatching(/timed out/), expect.stringMatching(/more than 256 KiB; its output was dropped/),
      expect.stringMatching(/unexpected output from the runtime/), expect.stringMatching(/ignored 3 malformed change request row/),
    ]);
    expect(s.t.offers).toHaveLength(1);
  });

  it('a forged host-owned request is never offered; the refusal is reported once', async () => {
    const { project } = await install();
    db.addChangeRequest({ id: 'cr_0000beef', kind: 'config-set', payload: { key: 'capabilities.git.push', value: 'allow', layer: 'local' }, reason: 'trust me' });
    const s = setup([project]);
    await s.manager.pollAll();
    await s.manager.pollAll();
    expect(s.t.offers).toHaveLength(0);
    expect(s.t.outcomes).toEqual([expect.objectContaining({ status: 'error', requestId: 'cr_0000beef', text: expect.stringMatching(/host-owned/) })]);
  });
});

describe('host manager: confirm, apply, replay', () => {
  it('confirm runs the child command built from the journaled plan, then journals and reports the outcome', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    await s.manager.pollAll();
    const o = s.t.offers[0]!;
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: o.nonce });
    const rev = runtimeConfig(project).configRevision;
    expect(s.c.runs).toEqual([['settings', 'set', 'execution.maxActiveTasks', '5', '--yes', '--no-restart', '--expect-revision', String(rev)]]);
    expect(readJson(local).execution.maxActiveTasks).toBe(5);
    expect(db.changeRequest(id)).toMatchObject({ status: 'applied' });
    expect(journal().map((e) => e.type)).toEqual(['offer', 'confirmed', 'applying', 'applied']);
    const [, confirmed, applying] = journal();
    expect(confirmed).toMatchObject({ nonce: o.nonce, pid: process.pid });
    expect(applying).toMatchObject({ nonce: o.nonce, detail: `minions settings set execution.maxActiveTasks 5 --yes --no-restart --expect-revision ${rev}` });
    expect(s.t.outcomes.map((x) => x.status)).toEqual(['applying', 'applied']);
    expect(s.t.outcomes[1]!.text).toMatch(/applied - execution.maxActiveTasks: \d+ -> 5 written to/);
    const marks = s.d.calls.filter((c) => c[3] === 'mark').map((c) => c[c.indexOf('--status') + 1]);
    expect(marks).toEqual(['confirmed', 'applied']);
    // The plan's displayed step is exactly that argv.
    expect(journal()[0]!.plan.steps).toEqual([`minions ${s.c.runs[0]!.join(' ')}`]);
  });

  it('replay: a second tap or a redelivered callback (even concurrent) applies once and answers "already handled"', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    await s.manager.pollAll();
    const ev = { type: 'confirm' as const, requestId: id, nonce: s.t.offers[0]!.nonce };
    await Promise.all([s.manager.handle(ev), s.manager.handle(ev)]);
    await s.manager.handle(ev);
    expect(s.c.runs).toHaveLength(1);
    expect(journal().filter((e) => e.type === 'confirmed')).toHaveLength(1);
    expect(s.t.outcomes.filter((x) => x.status === 'already-handled')).toHaveLength(2);
    // A restarted manager finds the nonce spent too.
    const again = new M.HostManager(s.deps);
    await again.handle(ev);
    expect(s.c.runs).toHaveLength(1);
    expect(s.t.outcomes.at(-1)!.status).toBe('already-handled');
  });

  it('applies the journal\'s plan, never the container row: a row rewritten after the offer changes nothing', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '6');
    const s = setup([project]);
    await s.manager.pollAll();
    db.exec('UPDATE change_requests SET payload = ? WHERE id = ?', JSON.stringify({ key: 'capabilities.git.push', value: 'allow', layer: 'local' }), id);
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: s.t.offers[0]!.nonce });
    expect(s.c.runs[0]!.slice(0, 4)).toEqual(['settings', 'set', 'execution.maxActiveTasks', '6']);
    expect(readJson(local).execution.maxActiveTasks).toBe(6);
    expect(readJson(local).capabilities).toBeUndefined();
    // No `settings requests` read happened between the tap and the apply.
    const afterOffer = s.d.calls.slice(1);
    expect(afterOffer.every((c) => c[3] === 'mark')).toBe(true);
  });

  it('refuses an expired offer, a moved configRevision and a changed plan; each refusal sends a fresh offer, nothing applied', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '6');
    const s = setup([project]);
    await s.manager.pollAll();
    // Expired (31 minutes later).
    s.advance(31 * 60_000);
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: s.t.offers[0]!.nonce });
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/confirmation expired/) });
    expect(s.t.offers).toHaveLength(2);
    // configRevision moved.
    await editProjectConfig(project, (raw) => ({ ...raw, communication: { ...(raw.communication as object), progress: 'quiet' } }));
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: s.t.offers[1]!.nonce });
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/configuration moved from revision/) });
    expect(s.t.offers).toHaveLength(3);
    // Same revision, different value in the local layer: the digest differs.
    writeFileSync(local, JSON.stringify({ execution: { maxActiveTasks: 4, maxEngineers: 1 } }));
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: s.t.offers[2]!.nonce });
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/plan changed since it was shown/) });
    expect(s.t.offers).toHaveLength(4);
    expect(s.c.runs).toHaveLength(0);
    expect(journal().filter((e) => e.type === 'confirmed')).toHaveLength(0);
    // The fresh offer applies.
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: s.t.offers[3]!.nonce });
    expect(s.c.runs).toHaveLength(1);
    expect(readJson(local).execution.maxActiveTasks).toBe(6);
  });

  it('unknown, malformed or mismatched nonces are refused without applying', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const other = requestSet(project, 'communication.progress', 'quiet');
    const s = setup([project]);
    await s.manager.pollAll();
    const nonceOf = (rid: string) => s.t.offers.find((o) => o.requestId === rid)!.nonce;
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: 'f'.repeat(32) });
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: 'not-hex' });
    await s.manager.handle({ type: 'confirm', requestId: '../x', nonce: nonceOf(id) });
    await s.manager.handle({ type: 'confirm', requestId: other, nonce: nonceOf(id) });
    expect(s.t.outcomes.map((o) => o.status)).toEqual(['refused', 'refused', 'refused', 'refused']);
    expect(s.c.runs).toHaveLength(0);
  });

  it('reject marks the request rejected; a later confirm of that offer is "already handled"', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    await s.manager.pollAll();
    const nonce = s.t.offers[0]!.nonce;
    await s.manager.handle({ type: 'reject', requestId: id, nonce });
    expect(db.changeRequest(id)).toMatchObject({ status: 'rejected' });
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'rejected' });
    await s.manager.handle({ type: 'confirm', requestId: id, nonce });
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'already-handled' });
    await s.manager.handle({ type: 'reject', requestId: id, nonce });
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'already-handled' });
    expect(s.c.runs).toHaveLength(0);
  });

  it('restart: refused while workers run -> failed, then re-offered on the next poll (retry); upgrade runs the upgrade child', async () => {
    const { project } = await install();
    const rid = RT.recordRestartRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const s = setup([project], { restart: 'refused' });
    await s.manager.pollAll();
    await s.manager.handle({ type: 'confirm', requestId: rid, nonce: s.t.offers[0]!.nonce });
    expect(s.c.runs).toEqual([['settings', 'restart']]);
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'failed', text: expect.stringMatching(/coordinator restart: refused/) });
    expect(db.changeRequest(rid)).toMatchObject({ status: 'failed' });
    // task-53.7: the refusal is followed by the two owner plans "Restart when idle" and "Drain now" (each its own offer).
    expect(s.t.offers.slice(1).map((o) => [o.kind, o.summary.split(':')[0]])).toEqual([['restart', 'Restart when idle'], ['restart', 'Drain now']]);
    await s.manager.pollAll();
    expect(s.t.offers).toHaveLength(4);
    expect(s.t.offers[3]!.requestId).toBe(rid);

    const uid = RT.recordUpgradeRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    await s.manager.pollAll();
    const uo = s.t.offers.find((o) => o.requestId === uid)!;
    await s.manager.handle({ type: 'confirm', requestId: uid, nonce: uo.nonce });
    expect(s.upgrades.at(-1)).toEqual({ fromContainer: null, dryRun: false });
    expect(db.changeRequest(uid)).toMatchObject({ status: 'applied' });
  });
});

describe('host manager: startup, lock, loop', () => {
  it('reports confirmed / applying entries of a gone process as "interrupted, state unknown"; never resumes them', async () => {
    const { project } = await install();
    const a = requestSet(project, 'execution.maxActiveTasks', '5');
    const b = requestSet(project, 'communication.progress', 'quiet');
    const live = RT.recordRestartRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const s = setup([project]);
    await s.manager.pollAll();
    const offerOf = (rid: string) => journal().find((e) => e.type === 'offer' && e.requestId === rid)!;
    const at = '2026-10-26T10:01:00.000Z';
    const line = (e: object) => readFileSync(J.journalPath(), 'utf8') + JSON.stringify(e) + '\n';
    writeFileSync(J.journalPath(), line({ type: 'confirmed', at, projectId: project.projectId, requestId: a, nonce: offerOf(a).nonce, digest: offerOf(a).digest, pid: 999_999_1, start: '1' }));
    writeFileSync(J.journalPath(), line({ type: 'confirmed', at, projectId: project.projectId, requestId: b, nonce: offerOf(b).nonce, digest: offerOf(b).digest }));
    writeFileSync(J.journalPath(), line({ type: 'applying', at, projectId: project.projectId, requestId: b, nonce: offerOf(b).nonce, digest: offerOf(b).digest, pid: 999_999_2, start: '1' }));
    writeFileSync(J.journalPath(), line({ type: 'confirmed', at, projectId: project.projectId, requestId: live, nonce: offerOf(live).nonce, digest: offerOf(live).digest, pid: process.pid, start: null }));
    const before = s.t.outcomes.length;

    const found = await new M.HostManager(s.deps).startup();
    expect(found.map((e) => [e.requestId, e.type]).sort()).toEqual([[a, 'confirmed'], [b, 'applying']].sort());
    const reports = s.t.outcomes.slice(before);
    expect(reports.map((r) => r.status)).toEqual(['interrupted', 'interrupted']);
    expect(reports[0]!.text).toMatch(/interrupted, state unknown/);
    expect(s.c.runs).toHaveLength(0);
    expect(db.changeRequest(a)).toMatchObject({ status: 'failed', detail: expect.stringMatching(/interrupted, state unknown/) });
    expect(db.changeRequest(live)).toMatchObject({ status: 'proposed' });
    expect(J.lastOutcome(await J.readJournal(), project.projectId, a)).toMatchObject({ type: 'failed' });
    // A second start reports nothing again; the next poll offers the interrupted ones afresh (confirm = re-run).
    expect(await new M.HostManager(s.deps).startup()).toEqual([]);
    const m = new M.HostManager(s.deps);
    await m.pollAll();
    expect(s.t.offers.filter((o) => o.requestId === a || o.requestId === b)).toHaveLength(4);
    expect(s.t.offers.filter((o) => o.requestId === live)).toHaveLength(1);
  });

  it('one manager per host: a live holder refuses with CONFLICT, a dead one is taken over, release removes the lock', async () => {
    const first = await M.acquireManagerLock();
    await expect(M.acquireManagerLock()).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/Another host manager runs/) });
    const dead = await M.acquireManagerLock({ alive: () => false });
    expect(JSON.parse(readFileSync(M.managerLockPath(), 'utf8'))).toMatchObject({ pid: process.pid });
    await dead.release();
    await first.release();
    const again = await M.acquireManagerLock();
    await again.release();
    expect(() => readFileSync(M.managerLockPath())).toThrow();
  });

  it('run(): startup, a poll every 20 s, owner events between polls; stops on abort and releases the lock', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    const ctl = new AbortController();
    let receives = 0;
    s.deps.transport.receive = async (waitMs) => {
      receives++;
      if (receives === 1) { const o = s.t.offers[0]!; return [{ type: 'confirm', requestId: id, nonce: o.nonce }]; }
      s.advance(waitMs);
      if (receives >= 3) ctl.abort();
      return [];
    };
    const polls: number[] = [];
    const real = s.deps.projects;
    s.deps.projects = async () => { polls.push(s.deps.now().getTime()); return real(); };
    await M.runManager(s.deps, ctl.signal);
    expect(readJson(local).execution.maxActiveTasks).toBe(5);
    expect(polls).toHaveLength(2);
    expect(polls[1]! - polls[0]!).toBe(20_000);
    expect(() => readFileSync(M.managerLockPath())).toThrow();
  });

  it('run(): after a CLI reinstall the running child finishes and reports first, then the loop ends with restart (task-53.6)', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    let reinstalled = false;
    const child = s.deps.runChild;
    s.deps.runChild = async (p, argv) => { const r = await child(p, argv); reinstalled = true; return r; };
    const polls: Date[] = [];
    let receives = 0;
    s.deps.transport.receive = async (waitMs) => {
      receives++;
      if (receives === 1) return [{ type: 'confirm', requestId: id, nonce: s.t.offers[0]!.nonce }];
      s.advance(waitMs);
      return [];
    };
    const end = await M.runManager({ ...s.deps, onPoll: (at) => { polls.push(at); }, cliChanged: () => reinstalled }, new AbortController().signal);
    expect(end).toBe('restart');
    expect(receives).toBe(1);
    expect(polls).toHaveLength(1);
    expect(readJson(local).execution.maxActiveTasks).toBe(5);
    const statuses = s.t.outcomes.map((o) => o.status);
    expect(statuses.slice(-3)).toEqual(['applying', 'applied', 'restarting']);
    expect(s.t.outcomes.at(-1)!.text).toMatch(/reinstalled.*restarts on the new version/);
    expect(() => readFileSync(M.managerLockPath())).toThrow();
    // Without a reinstall the loop only stops on abort.
    const ctl = new AbortController();
    const quiet = setup([project]);
    quiet.deps.transport.receive = async (waitMs) => { quiet.advance(waitMs); ctl.abort(); return []; };
    expect(await M.runManager({ ...quiet.deps, cliChanged: () => false }, ctl.signal)).toBe('stopped');
  });
});

describe('bounded delegate', () => {
  it('run() kills a child over maxOutputBytes and keeps only the capped output', async () => {
    const r = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(1 << 20)); setTimeout(() => {}, 5000)'], { allowFailure: true, maxOutputBytes: 1000, timeoutMs: 10_000 });
    expect(r.outputLimited).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(r.code).toBe(125);
    await expect(run(process.execPath, ['-e', 'process.stdout.write("y".repeat(5000))'], { maxOutputBytes: 100 })).rejects.toMatchObject({ message: expect.stringMatching(/more than 100 bytes/) });
    const small = await run(process.execPath, ['-e', 'process.stdout.write("ok")'], { maxOutputBytes: 100 });
    expect(small).toMatchObject({ code: 0, stdout: 'ok' });
    expect(small.outputLimited).toBeUndefined();
  });

  it('planArgv matches the displayed step for every kind', () => {
    const base = { configRevision: 3 };
    expect(CR.planArgv({ ...base, kind: 'restart', change: null }, { payload: {} })).toEqual(['settings', 'restart']);
    expect(CR.planArgv({ ...base, kind: 'upgrade', change: null }, { payload: { fromContainer: true } })).toEqual(['upgrade', '--from-container']);
    expect(CR.planArgv({ ...base, kind: 'upgrade', change: null }, { payload: { fromContainer: 'feat/x' } })).toEqual(['upgrade', '--from-container', 'feat/x']);
    expect(CR.planArgv({ ...base, kind: 'config-set', change: { key: 'a.b', from: 1, to: 2, layer: 'shared', file: 'f', class: 'live', takesEffect: 'now' } }, { payload: { value: '2' } }))
      .toEqual(['settings', 'set', 'a.b', '2', '--shared', '--yes', '--no-restart', '--expect-revision', '3']);
  });
});

// QA (task-53.4 tester): edges of replay, interruption, the lock, cross-path confirmation and the real delegate limits.
describe('host manager: QA edges', () => {
  it('QA: the nonce of an interrupted apply (closed as failed at startup) stays spent: re-sending it never re-runs', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    await s.manager.pollAll();
    const o = s.t.offers[0]!;
    // A manager that confirmed and started applying, then died (its pid is gone).
    const at = '2026-10-26T10:01:00.000Z';
    const add = (e: object) => writeFileSync(J.journalPath(), readFileSync(J.journalPath(), 'utf8') + JSON.stringify(e) + '\n');
    add({ type: 'confirmed', at, projectId: project.projectId, requestId: id, nonce: o.nonce, digest: o.digest, pid: 999_999_3, start: '1' });
    add({ type: 'applying', at, projectId: project.projectId, requestId: id, nonce: o.nonce, digest: o.digest, pid: 999_999_3, start: '1' });
    const m = new M.HostManager(s.deps);
    expect((await m.startup()).map((e) => e.requestId)).toEqual([id]);
    // A redelivered callback of the old offer (e.g. Telegram retry after the restart).
    await m.handle({ type: 'confirm', requestId: id, nonce: o.nonce });
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'already-handled' });
    expect(s.c.runs).toHaveLength(0);
    // Only a fresh offer, confirmed by the owner, re-runs it (once).
    await m.pollAll();
    const fresh = s.t.offers.at(-1)!;
    expect(fresh.nonce).not.toBe(o.nonce);
    await m.handle({ type: 'confirm', requestId: id, nonce: fresh.nonce });
    await m.handle({ type: 'confirm', requestId: id, nonce: o.nonce });
    expect(s.c.runs).toHaveLength(1);
    expect(db.changeRequest(id)).toMatchObject({ status: 'applied' });
  });

  it('QA: an `applying` entry of a process that still runs is left alone at startup and not re-offered; a reused pid is interrupted', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    await s.manager.pollAll();
    const o = s.t.offers[0]!;
    const me = J.writer();
    writeFileSync(J.journalPath(), readFileSync(J.journalPath(), 'utf8')
      + JSON.stringify({ type: 'confirmed', at: '2026-10-26T10:01:00.000Z', projectId: project.projectId, requestId: id, nonce: o.nonce, digest: o.digest, ...me }) + '\n'
      + JSON.stringify({ type: 'applying', at: '2026-10-26T10:01:00.000Z', projectId: project.projectId, requestId: id, nonce: o.nonce, digest: o.digest, ...me }) + '\n');
    // Default writerAlive (real pid and /proc start time): this process runs, so the apply is in flight.
    const m = new M.HostManager({ ...s.deps, writerAlive: undefined });
    expect(await m.startup()).toEqual([]);
    await m.pollAll();
    expect(s.t.offers).toHaveLength(1);
    expect(s.t.outcomes.filter((x) => x.status === 'interrupted')).toHaveLength(0);
    expect(J.lastOutcome(await J.readJournal(), project.projectId, id)).toMatchObject({ type: 'applying' });
    // writerAlive: same pid with a different start time is a reused pid (gone); an unknown start trusts the pid.
    expect(J.writerAlive({ pid: 42, start: 'a' }, () => true, () => 'b')).toBe(false);
    expect(J.writerAlive({ pid: 42, start: 'a' }, () => true, () => 'a')).toBe(true);
    expect(J.writerAlive({ pid: 42, start: null }, () => true, () => 'b')).toBe(true);
    expect(J.writerAlive({ pid: 42, start: 'a' }, () => false, () => 'a')).toBe(false);
    expect(J.writerAlive({}, () => true, () => 'a')).toBe(false);
  });

  it('QA: the terminal command printed for a manager offer applies it once; the manager then answers "already handled" (and vice versa)', async () => {
    const { project, local } = await install();
    const a = requestSet(project, 'execution.maxActiveTasks', '5');
    const b = requestSet(project, 'communication.progress', 'quiet');
    const lines: string[] = [];
    const s = setup([project]);
    const m = new M.HostManager({ ...s.deps, transport: M.logTransport((l) => lines.push(l)) });
    await m.pollAll();
    const printed = lines.map((l) => JSON.parse(l) as Record<string, any>).filter((l) => l.event === 'offer');
    expect(printed).toHaveLength(2);
    const pa = printed.find((p) => p.requestId === a)!;
    expect(pa.confirmCommand).toBe(`minions settings apply ${a} --confirm ${pa.digest}`);
    const cr = { runtime: m.runtime, upgrade: s.deps.upgrade, now: s.deps.now };
    const quiet = { confirm: async () => null, show: () => undefined };
    expect((await CR.applyRequest(project, a, { confirm: pa.digest }, cr, quiet)).status).toBe('applied');
    expect(readJson(local).execution.maxActiveTasks).toBe(5);
    await m.handle({ type: 'confirm', requestId: a, nonce: pa.nonce });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ event: 'outcome', status: 'already-handled', requestId: a });
    // The other way round: the manager applies b, then the printed terminal command is refused.
    const pb = printed.find((p) => p.requestId === b)!;
    await m.handle({ type: 'confirm', requestId: b, nonce: pb.nonce });
    expect(db.changeRequest(b)).toMatchObject({ status: 'applied' });
    await expect(CR.applyRequest(project, b, { confirm: pb.digest }, cr, quiet)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/already used/) });
    expect(s.c.runs).toHaveLength(1);
  });

  it('QA: a runtime that times out while the row is marked does not stop the apply; the outcome is journaled with a warning', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const s = setup([project]);
    await s.manager.pollAll();
    s.d.setOverride((argv) => (argv[3] === 'mark' ? { code: 124, stdout: '', stderr: '', timedOut: true } : null));
    await s.manager.handle({ type: 'confirm', requestId: id, nonce: s.t.offers[0]!.nonce });
    expect(readJson(local).execution.maxActiveTasks).toBe(5);
    expect(journal().map((e) => e.type)).toEqual(['offer', 'confirmed', 'applying', 'applied']);
    expect(s.t.outcomes.at(-1)).toMatchObject({ status: 'applied', text: expect.stringMatching(/warning: .*timed out after 30 s/) });
  });

  it('QA: two managers racing for a free lock: exactly one wins', async () => {
    const results = await Promise.allSettled([M.acquireManagerLock(), M.acquireManagerLock(), M.acquireManagerLock()]);
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'CONFLICT')).toBe(true);
    await (won[0] as PromiseFulfilledResult<{ release: () => Promise<void> }>).value.release();
  });

  it('QA: delegateCapture enforces the output cap and the timeout on a real (host runtime) child', async () => {
    const { mkdirSync, chmodSync } = await import('node:fs');
    const { hostRuntimePaths } = await import('../../src/core/paths.js');
    const { delegateCapture, DELEGATE_MAX_OUTPUT_BYTES } = await import('../../src/host/delegate.js');
    const { project } = await install();
    const hp = hostRuntimePaths(project.projectId);
    mkdirSync(join(hp.minionsShim, '..'), { recursive: true });
    mkdirSync(hp.workspace, { recursive: true });
    writeFileSync(hp.minionsShim, `#!${process.execPath}\nif (process.argv[2] === 'big') { process.stdout.write('x'.repeat(1 << 20)); setTimeout(() => {}, 20000); } else { setTimeout(() => {}, 20000); }\n`);
    chmodSync(hp.minionsShim, 0o755);
    const host = { ...project, runtime: 'host' as const };
    const big = await delegateCapture(host, ['minions', 'big']);
    expect(big.outputLimited).toBe(true);
    expect(Buffer.byteLength(big.stdout) + Buffer.byteLength(big.stderr)).toBeLessThanOrEqual(DELEGATE_MAX_OUTPUT_BYTES);
    const slow = await delegateCapture(host, ['minions', 'slow'], { timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    // Through the manager's bounded runtime both are project errors.
    const rt = M.boundedRuntime({ running: async () => true, delegate: (p, argv) => delegateCapture(p, argv, { timeoutMs: 300 }) });
    await expect(rt.exec(host, ['minions', 'big'])).rejects.toMatchObject({ message: expect.stringMatching(/more than 256 KiB/) });
    await expect(rt.exec(host, ['minions', 'slow'])).rejects.toMatchObject({ message: expect.stringMatching(/timed out/) });
  }, 20_000);
});
