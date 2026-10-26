// task-53.3 (docs/design/host-manager.md, phase 2), host side: `settings apply <id>` reads the request through the
// runtime, re-validates it against the host config, builds the plan and its digest, records an offer (30 minute
// expiry, single-use nonce) in <MINIONS_HOME>/manager/journal.jsonl and applies only after a confirmation of that
// exact plan; `settings reject <id>`; `settings set --expect-revision` (the editProjectConfig guard).
// Temp MINIONS_HOME; the fake runtime answers from a real runtime DB; the upgrade child process is faked. No Docker.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const { loadProjectJson, projectConfigPath } = await import('../../src/host/project.js');
const { validateConfig } = await import('../../src/config/resolve.js');
const { RuntimeDb } = await import('../../src/runtime/db.js');
const RT = await import('../../src/runtime/change-requests.js');
const CR = await import('../../src/host/change-requests.js');
const J = await import('../../src/host/change-journal.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { editProjectConfig } = await import('../../src/host/config-write.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type SettingsRuntime = import('../../src/host/settings-cli.js').SettingsRuntime;
type UpgradeRun = import('../../src/host/change-requests.js').UpgradeRun;

let env: ReturnType<typeof withHome>;
let db: InstanceType<typeof RuntimeDb>;
beforeEach(() => { env = withHome(); db = new RuntimeDb(':memory:'); });
afterEach(() => { db.close(); env.cleanup(); });

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
const readLocal = (f: string) => (existsSync(f) ? readJson(f) : {});
const runtimeConfig = (p: ProjectJson) => validateConfig(readJson(join(projectPaths(p.projectId).runtimeDir, 'config.json')));

async function install(visibility: 'shared' | 'private' = 'private') {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  return { repo, project, file: projectConfigPath(project), local: projectPaths(project.projectId).configLocalJson };
}

/** A fake runtime backed by the test's runtime DB: settings requests (list, mark) and the coordinator restart. */
function fakeRuntime(o: { running?: boolean; restart?: 'ok' | 'refused' } = {}) {
  const calls: string[][] = [];
  const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
  const fail = (e: Error & { code?: string }) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } }) + '\n', stderr: '' });
  const runtime: SettingsRuntime = {
    running: async () => o.running ?? true,
    exec: async (_p, args) => {
      calls.push(args);
      try {
        if (args[1] === 'settings' && args[2] === 'requests' && args[3] === 'mark') {
          const i = args.indexOf('--status'), d = args.indexOf('--detail');
          return ok(RT.markChangeRequest(db, args[4]!, args[i + 1]!, d > 0 ? args[d + 1] : undefined));
        }
        if (args[1] === 'settings' && args[2] === 'requests') return ok({ requests: RT.listChangeRequests(db, { all: args.includes('--all') }) });
        if (args[1] === 'coordinator') {
          return o.restart === 'refused'
            ? { code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'Coordinator restart refused: 1 active worker lease(s) (lease-1).' } }) + '\n', stderr: '' }
            : ok({ action: 'restarted', reason: 'recover' });
        }
      } catch (e) { return fail(e as Error); }
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    },
  };
  return { runtime, calls };
}

function fakeUpgrade(result: Partial<UpgradeRun> = {}) {
  const runs: { fromContainer: string | true | null; dryRun: boolean }[] = [];
  const upgrade = async (_p: ProjectJson, x: { fromContainer: string | true | null; dryRun: boolean }): Promise<UpgradeRun> => {
    runs.push(x);
    const steps = [{ id: 'pause', status: x.dryRun ? 'planned' : 'done', detail: 'pause starts (2 active leases)' }, { id: 'recreate', status: x.dryRun ? 'planned' : 'done', detail: 'recreate the container' }];
    return { ok: true, steps, summary: x.dryRun ? '2 steps planned' : 'complete', ...(x.dryRun ? {} : result) };
  };
  return { upgrade, runs };
}

function deps(runtime: SettingsRuntime, o: { now?: () => Date; upgrade?: ReturnType<typeof fakeUpgrade>['upgrade'] } = {}) {
  return { runtime, upgrade: o.upgrade ?? fakeUpgrade().upgrade, now: o.now };
}
function io(answers: (boolean | null)[]) {
  const asked: string[] = [];
  const shown: string[] = [];
  return { asked, shown, io: { confirm: async (q: string) => { asked.push(q); return answers.length ? answers.shift()! : null; }, show: (t: string) => shown.push(t) } };
}

/** Records a request the way the runtime does (validated against the regenerated runtime config). */
const requestSet = (p: ProjectJson, key: string, value: string, o: { layer?: 'local' | 'shared' } = {}) =>
  RT.recordSettingRequest({ db, config: runtimeConfig(p) }, key, value, { reason: 'the backlog has many independent tasks', layer: o.layer }).request!.id;
const journal = () => readFileSync(J.journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);

describe('settings apply (host): plan, digest, confirmation', () => {
  it('shows the host-computed plan, confirms, writes the setting, marks the request applied and journals offer/confirmed/applied', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const { runtime, calls } = fakeRuntime();
    const t = io([true, true]);
    const r = await CR.applyRequest(project, id, {}, deps(runtime), t.io);

    expect(r).toMatchObject({ requestId: id, kind: 'config-set', status: 'applied', applied: true, marked: true });
    expect(r.plan.change).toMatchObject({ key: 'execution.maxActiveTasks', to: 5, layer: 'local', file: local, class: 'live', takesEffect: 'now' });
    expect(r.plan.loosens).toMatch(/more tasks may run in parallel/);
    expect(r.plan.steps).toEqual([`minions settings set execution.maxActiveTasks 5 --yes --no-restart --expect-revision ${r.plan.configRevision}`]);
    expect(r.digest).toBe(CR.planDigest(r.plan));
    expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    const plan = t.shown.join('\n');
    expect(plan).toContain(`change request ${id} (config-set)`);
    expect(plan).toContain('reason (from the container, untrusted): "the backlog has many independent tasks"');
    expect(plan).toContain('LOOSENS POLICY: more tasks may run in parallel');
    expect(plan).toContain(`digest: ${r.digest}`);
    // Loosening: asked twice.
    expect(t.asked).toHaveLength(2);
    expect(t.asked[1]).toMatch(/This loosens policy/);
    expect(readJson(local).execution.maxActiveTasks).toBe(5);
    expect(runtimeConfig(project).execution.maxActiveTasks).toBe(5); // derived files regenerated
    expect(db.changeRequest(id)).toMatchObject({ status: 'applied' });
    expect(db.changeRequest(id)!.detail).toMatch(/execution.maxActiveTasks: \d+ -> 5 written to/);
    const marks = calls.filter((c) => c[3] === 'mark').map((c) => c[c.indexOf('--status') + 1]);
    expect(marks).toEqual(['confirmed', 'applied']);
    const j = journal();
    expect(j.map((e) => e.type)).toEqual(['offer', 'confirmed', 'applied']);
    expect(j[0]).toMatchObject({ requestId: id, projectId: project.projectId, digest: r.digest, configRevision: r.plan.configRevision, request: { id, kind: 'config-set' } });
    expect(j[0]!.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Date.parse(j[0]!.expiresAt) - Date.parse(j[0]!.at)).toBe(30 * 60 * 1000);
    expect(j[1]!.nonce).toBe(j[0]!.nonce);
    expect(statSync(J.journalPath()).mode & 0o777).toBe(0o600);
  });

  it('a restart-class change is applied without restarting; the restart is offered as a next step', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'communication.progress', 'quiet');
    const { runtime, calls } = fakeRuntime();
    const r = await CR.applyRequest(project, id, { yes: true }, deps(runtime), io([]).io);
    expect(r.status).toBe('applied');
    expect(readJson(local).communication.progress).toBe('quiet');
    expect(r.plan.interrupts).toMatch(/minions settings restart/);
    expect(calls.some((c) => c[1] === 'coordinator')).toBe(false);
    expect(r.nextSteps.join('\n')).toMatch(/minions settings restart/);
  });

  it('without a terminal: offered, not applied; --confirm <digest> applies exactly that plan once', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '6');
    const { runtime } = fakeRuntime();
    const offered = await CR.applyRequest(project, id, {}, deps(runtime), io([null]).io);
    expect(offered).toMatchObject({ status: 'offered', applied: false, confirmCommand: `minions settings apply ${id} --confirm ${offered.digest}` });
    expect(CR.formatApplyOutcome(offered)).toMatch(/NOT applied: offered until/);
    expect(readLocal(local).execution?.maxActiveTasks).toBeUndefined();
    expect(db.changeRequest(id)!.status).toBe('proposed');

    const r = await CR.applyRequest(project, id, { confirm: offered.digest }, deps(runtime), io([]).io);
    expect(r).toMatchObject({ status: 'applied', applied: true, digest: offered.digest });
    expect(readJson(local).execution.maxActiveTasks).toBe(6);
    // Replay: the nonce is spent.
    await expect(CR.applyRequest(project, id, { confirm: offered.digest }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/already used/) });
    await expect(CR.applyRequest(project, id, { confirm: 'f'.repeat(64) }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/No offered plan/) });
  });

  it('QA: a row tampered after the offer cannot change what --confirm applies (the plan comes from the journal)', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '6');
    const { runtime } = fakeRuntime();
    const offered = await CR.applyRequest(project, id, {}, deps(runtime), io([null]).io);
    expect(offered.status).toBe('offered');
    // The container rewrites its row: another value, then a host-owned key.
    db.exec('UPDATE change_requests SET payload = ? WHERE id = ?', JSON.stringify({ key: 'execution.maxActiveTasks', value: '9', layer: 'local' }), id);
    db.exec('UPDATE change_requests SET payload = ?, reason = ? WHERE id = ?', JSON.stringify({ key: 'capabilities.git.push', value: 'allow', layer: 'local' }), 'forged', id);
    const r = await CR.applyRequest(project, id, { confirm: offered.digest }, deps(runtime), io([]).io);
    expect(r).toMatchObject({ status: 'applied', applied: true, digest: offered.digest });
    expect(r.plan.change).toMatchObject({ key: 'execution.maxActiveTasks', to: 6 });
    const after = readJson(local);
    expect(after.execution.maxActiveTasks).toBe(6);
    expect(after.capabilities).toBeUndefined();
  });

  it('QA: a digest offered for one request or project cannot confirm another', async () => {
    const { project } = await install();
    const a = requestSet(project, 'execution.maxActiveTasks', '6');
    const b = requestSet(project, 'communication.progress', 'quiet');
    const { runtime } = fakeRuntime();
    const offeredA = await CR.applyRequest(project, a, {}, deps(runtime), io([null]).io);
    await expect(CR.applyRequest(project, b, { confirm: offeredA.digest }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/No offered plan/) });
    await expect(CR.applyRequest({ ...project, projectId: 'other-project' }, a, { confirm: offeredA.digest }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/No offered plan/) });
    expect(journal().filter((e) => e.type === 'confirmed')).toHaveLength(0);
  });

  it('a confirmation after 30 minutes is refused and applies nothing', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '6');
    const { runtime } = fakeRuntime();
    const t0 = new Date('2026-10-26T10:00:00Z');
    const offered = await CR.applyRequest(project, id, {}, deps(runtime, { now: () => t0 }), io([null]).io);
    expect(offered.expiresAt).toBe('2026-10-26T10:30:00.000Z');
    const late = () => new Date('2026-10-26T10:30:01Z');
    await expect(CR.applyRequest(project, id, { confirm: offered.digest }, deps(runtime, { now: late }), io([]).io))
      .rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/confirmation expired/) });
    expect(readLocal(local).execution?.maxActiveTasks).toBeUndefined();
    expect(db.changeRequest(id)!.status).toBe('proposed');
    // Not consumed: within the window it still applies (e.g. a clock check, not a spent nonce).
    const inTime = () => new Date('2026-10-26T10:29:59Z');
    expect((await CR.applyRequest(project, id, { confirm: offered.digest }, deps(runtime, { now: inTime }), io([]).io)).status).toBe('applied');
  });

  it('refuses when the config changed after the plan was shown (revision or value): nothing applied', async () => {
    const { project, local, file } = await install('shared');
    const id = requestSet(project, 'execution.maxActiveTasks', '6');
    const { runtime } = fakeRuntime();
    const offered = await CR.applyRequest(project, id, {}, deps(runtime), io([null]).io);
    // The owner edits the shared config in between: configRevision + 1.
    await editProjectConfig(project, (raw) => ({ ...raw, communication: { ...(raw.communication as object), progress: 'quiet' } }));
    await expect(CR.applyRequest(project, id, { confirm: offered.digest }, deps(runtime), io([]).io))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/configuration moved from revision \d+ to \d+/) });
    expect(readLocal(local).execution?.maxActiveTasks).toBeUndefined();

    // Same revision but the value moved (a local-layer edit does not bump the revision): the digest differs.
    const again = await CR.applyRequest(project, id, {}, deps(runtime), io([null]).io);
    writeFileSync(local, JSON.stringify({ execution: { maxActiveTasks: 4, maxEngineers: 1 } }));
    await expect(CR.applyRequest(project, id, { confirm: again.digest }, deps(runtime), io([]).io))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/plan changed since it was shown/) });
    expect(readJson(local).execution.maxActiveTasks).toBe(4);
    expect(readJson(file).execution?.maxActiveTasks).not.toBe(6);
  });

  it('refuses a forged request for a host-owned key, and requests that are not open', async () => {
    const { project, local } = await install();
    db.addChangeRequest({ id: 'cr_0000beef', kind: 'config-set', payload: { key: 'capabilities.git.push', value: 'allow', layer: 'local' }, reason: 'trust me' });
    const { runtime } = fakeRuntime();
    await expect(CR.applyRequest(project, 'cr_0000beef', { yes: true }, deps(runtime), io([]).io))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/host-owned; a request from the container is never applied/) });
    expect(readLocal(local).capabilities).toBeUndefined();
    await expect(CR.applyRequest(project, 'cr_00000000', { yes: true }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // An invalid value forged into the row is refused by the host's own validation.
    db.addChangeRequest({ id: 'cr_0000cafe', kind: 'config-set', payload: { key: 'execution.maxEngineers', value: '50', layer: 'local' }, reason: null });
    await expect(CR.applyRequest(project, 'cr_0000cafe', { yes: true }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    db.setChangeRequestStatus(id, 'rejected');
    await expect(CR.applyRequest(project, id, { yes: true }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/is rejected; nothing to apply/) });
  });

  it('a second offer of an applied or rejected request cannot be confirmed (the journal, not the container row, decides)', async () => {
    const { project } = await install();
    const rid = RT.recordRestartRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const { runtime, calls } = fakeRuntime();
    const first = await CR.applyRequest(project, rid, {}, deps(runtime), io([null]).io);
    const second = await CR.applyRequest(project, rid, {}, deps(runtime), io([null]).io);
    expect(second.digest).toBe(first.digest);
    expect((await CR.applyRequest(project, rid, { confirm: first.digest }, deps(runtime), io([]).io)).status).toBe('applied');
    // The container forges its row back to proposed; the journal still says applied.
    db.exec("UPDATE change_requests SET status = 'proposed' WHERE id = ?", rid);
    const third = await CR.applyRequest(project, rid, {}, deps(runtime), io([null]).io);
    await expect(CR.applyRequest(project, rid, { confirm: third.digest }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/already applied/) });
    expect(calls.filter((c) => c[1] === 'coordinator')).toHaveLength(1);

    const rid2 = RT.recordRestartRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const offered = await CR.applyRequest(project, rid2, {}, deps(runtime), io([null]).io);
    await CR.rejectRequest(project, rid2, {}, deps(runtime));
    await expect(CR.applyRequest(project, rid2, { confirm: offered.digest }, deps(runtime), io([]).io)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/already rejected/) });
    expect(calls.filter((c) => c[1] === 'coordinator')).toHaveLength(1);
  });

  it('declined (once or at the loosening question) and --dry-run apply nothing', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const { runtime } = fakeRuntime();
    await expect(CR.applyRequest(project, id, {}, deps(runtime), io([false]).io)).rejects.toThrow(/Not confirmed/);
    await expect(CR.applyRequest(project, id, {}, deps(runtime), io([true, false]).io)).rejects.toThrow(/Not confirmed twice/);
    const dry = await CR.applyRequest(project, id, { dryRun: true }, deps(runtime), io([]).io);
    expect(dry).toMatchObject({ status: 'planned', applied: false });
    expect(readLocal(local).execution?.maxActiveTasks).toBeUndefined();
    expect(db.changeRequest(id)!.status).toBe('proposed');
    expect(journal().filter((e) => e.type === 'confirmed')).toHaveLength(0);
  });

  it('Agents keys are all host-owned: refused when recorded by the container and by the host plan, never applied', async () => {
    const { project } = await install();
    const { runtime } = fakeRuntime();
    for (const [key, value] of [['secrets.codex', 'sk-test'], ['harnesses.default', 'codex'], ['roles.engineer.harness', 'codex']] as const) {
      expect(() => requestSet(project, key, value)).toThrow(/host-owned/);
      const id = requestSet(project, 'execution.maxActiveTasks', '5');
      await expect(CR.buildPlan(project, { id, kind: 'config-set', reason: 'x', payload: { key, value, layer: 'local' } }, deps(runtime)))
        .rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('the digest is stable for the same plan and covers its content', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const { runtime } = fakeRuntime();
    const a = await CR.buildPlan(project, CR.snapshotOf(RT.requestView(db.changeRequest(id)!)), deps(runtime));
    const b = await CR.buildPlan(project, CR.snapshotOf(RT.requestView(db.changeRequest(id)!)), deps(runtime));
    expect(CR.planDigest(a.plan)).toBe(CR.planDigest(b.plan));
    expect(CR.planDigest({ ...a.plan, steps: ['other'] })).not.toBe(CR.planDigest(a.plan));
    expect(CR.canonicalJson({ b: 1, a: [1, { d: undefined, c: 'x' }] })).toBe('{"a":[1,{"c":"x"}],"b":1}');
  });
});

describe('settings apply (host): restart and upgrade requests', () => {
  it('restart: runs the graceful restart and marks applied; refused while workers run -> failed', async () => {
    const { project } = await install();
    const rid = RT.recordRestartRequest({ db, config: runtimeConfig(project) }, { reason: 'attemptMaxTurns changed' }).request!.id;
    const ok = await CR.applyRequest(project, rid, { yes: true }, deps(fakeRuntime().runtime), io([]).io);
    expect(ok).toMatchObject({ status: 'applied', restart: { action: 'restarted' } });
    expect(db.changeRequest(rid)!.status).toBe('applied');

    const rid2 = RT.recordRestartRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const refused = await CR.applyRequest(project, rid2, { yes: true }, deps(fakeRuntime({ restart: 'refused' }).runtime), io([]).io);
    expect(refused).toMatchObject({ status: 'failed', applied: false, restart: { action: 'refused' } });
    expect(db.changeRequest(rid2)).toMatchObject({ status: 'failed' });
    expect(db.changeRequest(rid2)!.detail).toMatch(/refused/);
    expect(CR.formatApplyOutcome(refused)).toMatch(/FAILED/);
  });

  it('upgrade: the plan holds the dry-run step ids (details shown, not digested); apply runs the upgrade', async () => {
    const { project } = await install();
    const uid = RT.recordUpgradeRequest({ db, config: runtimeConfig(project) }, { fromContainer: true, reason: 'sync' }).request!.id;
    const u = fakeUpgrade();
    const r = await CR.applyRequest(project, uid, { yes: true }, deps(fakeRuntime().runtime, { upgrade: u.upgrade }), io([]).io);
    expect(r.plan).toMatchObject({ kind: 'upgrade', upgradeSteps: ['pause', 'recreate'], steps: ['minions upgrade --from-container'] });
    expect(r.notes).toContain('pause: pause starts (2 active leases)');
    expect(r).toMatchObject({ status: 'applied', applied: true });
    expect(u.runs).toEqual([{ fromContainer: true, dryRun: true }, { fromContainer: true, dryRun: true }, { fromContainer: true, dryRun: false }]);
    expect(db.changeRequest(uid)!.status).toBe('applied');

    const uid2 = RT.recordUpgradeRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const bad = fakeUpgrade({ ok: false, summary: 'failed: image (build failed)' });
    const f = await CR.applyRequest(project, uid2, { yes: true }, deps(fakeRuntime().runtime, { upgrade: bad.upgrade }), io([]).io);
    expect(f).toMatchObject({ status: 'failed', applied: false, detail: 'upgrade: failed: image (build failed)' });
    expect(db.changeRequest(uid2)!.status).toBe('failed');
    // A failed request stays open: it can be applied again (new plan, new confirmation).
    expect((await CR.applyRequest(project, uid2, { yes: true }, deps(fakeRuntime().runtime, { upgrade: u.upgrade }), io([]).io)).status).toBe('applied');
  });

  /** An upgrade whose confirm-time dry run (the second dry run: the first one is the offer's) waits for release(). */
  function slowUpgrade() {
    const inner = fakeUpgrade();
    let dryRuns = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const upgrade: typeof inner.upgrade = async (p, x) => {
      if (x.dryRun && ++dryRuns === 2) { entered(); await gate; }
      return inner.upgrade(p, x);
    };
    return { upgrade, runs: inner.runs, release, started };
  }
  const snapshot = (id: string) => CR.snapshotOf(RT.listChangeRequests(db, { all: true }).find((r) => r.id === id)!);

  it('task-53.11: the confirm-time upgrade dry run runs outside the journal lock; a concurrent reject does not wait for it', async () => {
    const { project } = await install();
    const uid = RT.recordUpgradeRequest({ db, config: runtimeConfig(project) }, { reason: 'sync' }).request!.id;
    const other = requestSet(project, 'execution.maxActiveTasks', '5');
    const slow = slowUpgrade();
    const d = deps(fakeRuntime().runtime, { upgrade: slow.upgrade });
    const offered = await CR.offerRequest(project, snapshot(uid), d);
    const confirming = CR.confirmRequest(project, uid, offered.digest, d);
    await slow.started;
    // The dry run is in flight: the lock is free (a 200 ms wait suffices) and a reject journals at once.
    await expect(J.withJournalLock(async () => 'free', 200)).resolves.toBe('free');
    const t0 = Date.now();
    await expect(CR.rejectRequest(project, other, { reason: 'not now' }, d)).resolves.toMatchObject({ status: 'rejected' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(journal().some((e) => e.type === 'confirmed' && e.requestId === uid)).toBe(false);
    slow.release();
    await expect(confirming).resolves.toMatchObject({ status: 'applied', applied: true });
    expect(slow.runs).toEqual([{ fromContainer: null, dryRun: true }, { fromContainer: null, dryRun: true }, { fromContainer: null, dryRun: false }]);
    expect(journal().filter((e) => e.requestId === uid).map((e) => e.type)).toEqual(['offer', 'confirmed', 'applied']);
  });

  it('task-53.11: replay protection holds across the unlocked dry run (reject, confirm or config change meanwhile -> refused)', async () => {
    const { project } = await install();
    // A reject of the same request while the dry run runs: the check under the lock refuses (handled).
    const uid = RT.recordUpgradeRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const slow = slowUpgrade();
    const d = deps(fakeRuntime().runtime, { upgrade: slow.upgrade });
    const offered = await CR.offerRequest(project, snapshot(uid), d);
    const confirming = CR.confirmRequest(project, uid, offered.digest, d);
    await slow.started;
    await CR.rejectRequest(project, uid, {}, d);
    slow.release();
    await expect(confirming).rejects.toMatchObject({ code: 'CONFLICT', details: { refusal: 'handled' } });
    expect(slow.runs.some((r) => !r.dryRun)).toBe(false);
    expect(journal().some((e) => e.type === 'confirmed' && e.requestId === uid)).toBe(false);

    // Two confirmations of the same offer race: the one that takes the lock first wins, the other finds the nonce spent.
    const uid2 = RT.recordUpgradeRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const slow2 = slowUpgrade();
    const d2 = deps(fakeRuntime().runtime, { upgrade: slow2.upgrade });
    const offer2 = await CR.offerRequest(project, snapshot(uid2), d2);
    const first = CR.confirmRequest(project, uid2, offer2.digest, d2);
    await slow2.started;
    await expect(CR.confirmOffer(project, offer2.offer, deps(fakeRuntime().runtime))).resolves.toMatchObject({ plan: { kind: 'upgrade' } });
    slow2.release();
    await expect(first).rejects.toMatchObject({ code: 'CONFLICT', details: { refusal: 'spent' } });
    expect(slow2.runs.some((r) => !r.dryRun)).toBe(false);
    expect(journal().filter((e) => e.type === 'confirmed' && e.requestId === uid2)).toHaveLength(1);

    // A configuration change while the dry run runs: the revision read under the lock refuses.
    const uid3 = RT.recordUpgradeRequest({ db, config: runtimeConfig(project) }, {}).request!.id;
    const slow3 = slowUpgrade();
    const d3 = deps(fakeRuntime().runtime, { upgrade: slow3.upgrade });
    const offer3 = await CR.offerRequest(project, snapshot(uid3), d3);
    const third = CR.confirmRequest(project, uid3, offer3.digest, d3);
    await slow3.started;
    await editProjectConfig(project, (raw) => ({ ...raw, architecture: 'propose' }));
    slow3.release();
    await expect(third).rejects.toMatchObject({ code: 'CONFLICT', details: { refusal: 'revision' } });
    expect(slow3.runs.some((r) => !r.dryRun)).toBe(false);
  });
});

describe('settings reject and requests (host)', () => {
  it('reject marks the request rejected and journals it; nothing is applied', async () => {
    const { project, local } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const r = await CR.rejectRequest(project, id, { reason: 'not now' }, deps(fakeRuntime().runtime));
    expect(r).toMatchObject({ requestId: id, status: 'rejected', marked: true });
    expect(db.changeRequest(id)).toMatchObject({ status: 'rejected', detail: 'rejected on the host: not now' });
    expect(journal().at(-1)).toMatchObject({ type: 'rejected', requestId: id });
    expect(readLocal(local).execution?.maxActiveTasks).toBeUndefined();
    await expect(CR.rejectRequest(project, id, {}, deps(fakeRuntime().runtime))).rejects.toThrow(/is rejected; nothing to reject/);
  });

  it('the runtime not running: a clear PRECONDITION', async () => {
    const { project } = await install();
    await expect(CR.fetchRequests(project, fakeRuntime({ running: false }).runtime, false)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/runtime is not running/) });
  });

  it('a recorded-then-applied value still in effect: apply refuses instead of claiming a change', async () => {
    const { project } = await install();
    const id = requestSet(project, 'execution.maxActiveTasks', '5');
    const ctx = await S.loadSettingsContext(project);
    await SC.applySetting(ctx, 'execution.maxActiveTasks', '5', { yes: true, restart: false }, { runtime: fakeRuntime().runtime, confirm: async () => null });
    await expect(CR.applyRequest(project, id, { yes: true }, deps(fakeRuntime().runtime), io([]).io)).rejects.toThrow(/already 5 on the host; nothing to apply/);
  });
});

describe('settings set --expect-revision (editProjectConfig guard)', () => {
  it('editProjectConfig refuses a stale expected revision with CONFLICT and writes nothing', async () => {
    const { project, file } = await install('shared');
    const before = readFileSync(file, 'utf8');
    const rev = readJson(file).configRevision as number;
    await expect(editProjectConfig(project, (raw) => ({ ...raw, architecture: 'propose' }), { expectRevision: rev + 5 }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(new RegExp(`at configRevision ${rev}, not ${rev + 5}`)) });
    expect(readFileSync(file, 'utf8')).toBe(before);
    const ok = await editProjectConfig(project, (raw) => ({ ...raw, architecture: 'propose' }), { expectRevision: rev });
    expect(ok).toMatchObject({ written: true, revision: rev + 1 });
  });

  it('settings set: a matching revision writes (shared and local); a changed revision refuses before asking', async () => {
    const { project, file, local } = await install('shared');
    const rev = readJson(file).configRevision as number;
    const ctx = await S.loadSettingsContext(project);
    const { runtime } = fakeRuntime();
    const never = async () => { throw new Error('unexpected confirmation'); };
    await expect(SC.applySetting(ctx, 'communication.progress', 'quiet', { layer: 'shared', restart: false, expectRevision: rev - 1 + 2 }, { runtime, confirm: never }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readJson(file).communication.progress).not.toBe('quiet');
    const shared = await SC.applySetting(ctx, 'communication.progress', 'quiet', { layer: 'shared', restart: false, expectRevision: rev }, { runtime, confirm: never });
    expect(shared.written).toBe(true);
    expect(readJson(file).configRevision).toBe(rev + 1);
    // The old revision is now stale for the local layer too.
    const ctx2 = await S.loadSettingsContext(project);
    await expect(SC.applySetting(ctx2, 'models.selection', 'fixed', { restart: false, expectRevision: rev }, { runtime, confirm: never })).rejects.toMatchObject({ code: 'CONFLICT' });
    const r = await SC.applySetting(ctx2, 'models.selection', 'fixed', { restart: false, expectRevision: rev + 1 }, { runtime, confirm: never });
    expect(r.written).toBe(true);
    expect(readJson(local).models.selection).toBe('fixed');
    // writeSetting checks the files again right before it writes (a change after the plan).
    const ctx3 = await S.loadSettingsContext(project);
    const change = await S.planSetting(ctx3, 'communication.progress', 'tasks', 'local');
    await editProjectConfig(project, (raw) => ({ ...raw, architecture: 'propose' }));
    await expect(S.writeSetting(project, change, { expectRevision: change.revision })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readLocal(local).communication?.progress).toBeUndefined();
  });

  it('parseRevision accepts whole numbers >= 1 only; controls refuse the flag', async () => {
    expect(SC.parseRevision(' 7 ')).toBe(7);
    for (const bad of ['0', '-1', '1.5', 'x', '']) expect(() => SC.parseRevision(bad)).toThrow(/--expect-revision/);
    const { project } = await install();
    const ctx = await S.loadSettingsContext(project);
    await expect(SC.applySetting(ctx, 'pause.starts', 'paused', { expectRevision: 1 }, { runtime: fakeRuntime().runtime, confirm: async () => null })).rejects.toThrow(/runtime control/);
  });
});
