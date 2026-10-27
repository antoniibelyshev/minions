// task-53.5.3: owner change commands in the manager chat (/set, /sync, /upgrade, /restart, /undo). Each one builds a
// host plan for an owner request (`ow_` id, origin owner), journals an offer and is applied only through the same
// confirmOffer / apply path as a container request. Temp MINIONS_HOME, a fake delegate and child runner (the child
// runs the real host apply path in-process), a fake upgrade, and the real Telegram transport against a fake Bot API
// for the chat side. No network, no Docker, no child processes.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const { loadProjectJson, loadEffectiveConfig } = await import('../../src/host/project.js');
const CR = await import('../../src/host/change-requests.js');
const J = await import('../../src/host/change-journal.js');
const H = await import('../../src/host/config-history.js');
const M = await import('../../src/host/manager.js');
const T = await import('../../src/host/manager-telegram.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const US = await import('../../src/host/upgrade-source.js');
const { makeRepo, withHome, dockerUp, git } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type ManagerOffer = import('../../src/host/manager.js').ManagerOffer;
type ManagerOutcome = import('../../src/host/manager.js').ManagerOutcome;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type UpgradeRun = import('../../src/host/change-requests.js').UpgradeRun;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
const journal = () => (existsSync(J.journalPath()) ? readFileSync(J.journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>) : []);
const ok = (data: unknown, code = 0): RunResult => ({ code, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
const fail = (e: Error & { code?: string }): RunResult => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } }) + '\n', stderr: '' });
const editProjectConfigBump = async (p: ProjectJson) => (await import('../../src/host/config-write.js')).editProjectConfig(p, (raw) => ({ ...raw }));
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { code?: string; details?: any }; } throw new Error('expected a refusal'); };

async function install(name = 'repo') {
  const repo = makeRepo(env.root, name);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  return { project, repo, local: projectPaths(project.projectId).configLocalJson };
}

function setup(projects: ProjectJson[], o: { sync?: UpgradeRun; upgrade?: UpgradeRun } = {}) {
  let now = new Date('2026-10-26T10:00:00Z');
  const offers: ManagerOffer[] = [];
  const outcomes: ManagerOutcome[] = [];
  const delegateCalls: string[][] = [];
  const runs: string[][] = [];
  const upgrades: { fromContainer: unknown; dryRun: boolean; syncOnly?: boolean }[] = [];
  const deps: ManagerDeps = {
    transport: { sendOffer: async (x) => { offers.push(x); }, receive: async () => [], sendOutcome: async (x) => { outcomes.push(x); } },
    projects: async () => projects,
    loadProject: async (id) => { const p = projects.find((x) => x.projectId === id); if (!p) throw new Error(`no project ${id}`); return p; },
    running: async () => true,
    // An owner request has no runtime row: any runtime call is recorded (and must not be a mark).
    delegate: async (_p, argv) => { delegateCalls.push(argv); return ok({ requests: [] }); },
    runChild: async (p, argv) => {
      runs.push(argv);
      try {
        if (argv[0] === 'settings' && argv[1] === 'set') {
          const [, , key, value, ...flags] = argv;
          const ctx = await S.loadSettingsContext(p);
          return ok(await SC.applySetting(ctx, key!, value!, { layer: flags.includes('--shared') ? 'shared' : 'local', yes: flags.includes('--yes'), restart: false, expectRevision: Number(flags[flags.indexOf('--expect-revision') + 1]) },
            { runtime: { running: async () => false, exec: async () => ok({}) }, confirm: async () => null }));
        }
        if (argv[0] === 'settings' && argv[1] === 'restart') return ok({ action: 'restarted', detail: 'recover' });
      } catch (e) { return fail(e as Error); }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    upgrade: async (_p, x) => {
      upgrades.push(x);
      if (x.syncOnly) return o.sync ?? { ok: true, steps: [{ id: 'sync', status: x.dryRun ? 'planned' : 'done', detail: x.dryRun ? 'export, then fast-forward main aaa -> bbb' : 'fast-forwarded main aaa -> bbb' }], summary: x.dryRun ? '1 steps planned' : 'complete' };
      return o.upgrade ?? { ok: true, steps: [{ id: 'recreate', status: x.dryRun ? 'planned' : 'done', detail: 'recreate the container' }], summary: x.dryRun ? '1 steps planned' : 'complete' };
    },
    now: () => now,
    sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    log: () => undefined,
  };
  const manager = new M.HostManager(deps);
  const cmds = manager.commands();
  const confirm = (x: ManagerOffer) => manager.handle({ type: 'confirm', requestId: x.requestId, nonce: x.nonce });
  return { deps, manager, cmds, offers, outcomes, delegateCalls, runs, upgrades, confirm, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const noMarks = (calls: string[][]) => expect(calls.filter((c) => c.includes('mark'))).toEqual([]);

// ---------------------------------------------------------------- /set

describe('/set: an owner config change is a plan to confirm', () => {
  it('proposing only journals an offer (ow_ id, owner origin); the confirm applies it through the child, and nothing marks a runtime row', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    const before = existsSync(local) ? readFileSync(local, 'utf8') : null;
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '3', layer: 'local' });
    expect(o.requestId).toMatch(J.OWNER_REQUEST_ID_PATTERN);
    expect(o.summary).toMatch(/^set execution.maxActiveTasks: \d+ -> 3$/);
    expect(o.text).toContain(`owner request ${o.requestId} (config-set)`);
    expect(o.text).toContain('requested by you in the manager chat');
    expect(o.text).not.toContain('from the container');
    expect(journal()).toEqual([expect.objectContaining({ type: 'offer', requestId: o.requestId, request: expect.objectContaining({ origin: 'owner', kind: 'config-set' }), plan: expect.objectContaining({ origin: 'owner' }) })]);
    // Typing the command is not consent: nothing written yet.
    expect(existsSync(local) ? readFileSync(local, 'utf8') : null).toBe(before);
    expect(s.runs).toEqual([]);

    await s.confirm(o);
    expect(s.runs).toEqual([['settings', 'set', 'execution.maxActiveTasks', '3', '--yes', '--no-restart', '--expect-revision', String((await loadEffectiveConfig(project)).config.configRevision)]]);
    expect(readJson(local).execution.maxActiveTasks).toBe(3);
    expect(s.outcomes.map((x) => x.status)).toEqual(['applying', 'applied']);
    expect(s.outcomes[1]!.text).not.toMatch(/warning/);
    expect(journal().map((e) => e.type)).toEqual(['offer', 'confirmed', 'applying', 'applied']);
    noMarks(s.delegateCalls);
    // The config history keeps the file before and after the write (for /undo).
    const h = await H.loadHistory(project.projectId, o.requestId);
    expect(h).toMatchObject({ key: 'execution.maxActiveTasks', layer: 'local', file: local, before, to: 3 });
    expect(h!.after).toBe(readFileSync(local, 'utf8'));
    // A second tap of the same offer is already handled.
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.runs).toHaveLength(1);
  });

  it('an invalid value or an unchanged one is refused when proposed; nothing is journaled', async () => {
    const { project } = await install();
    const s = setup([project]);
    expect((await reason(s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: 'lots', layer: 'local' }))).message).toMatch(/whole number/);
    expect((await reason(s.cmds.propose(null, { kind: 'config-set', key: 'no.such.key', value: '1', layer: 'local' }))).code).toBeDefined();
    const cur = (await loadEffectiveConfig(project)).config.execution.maxActiveTasks;
    expect((await reason(s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: String(cur), layer: 'local' }))).message).toMatch(/already/);
    expect((await reason(s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '2', layer: 'shared' }))).message).toMatch(/private install/);
    expect(journal()).toEqual([]);
  });

  it('a host-owned key is allowed for the owner, with its loosening text (the transport asks twice); a container request for it is still refused', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    await S.loadSettingsContext(project);
    // Make sure the reviewer is required first, so turning it off loosens.
    const on = await s.cmds.propose(null, { kind: 'config-set', key: 'verification.reviewerRequired', value: 'true', layer: 'local' }).catch(() => null);
    if (on) await s.confirm(on);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'verification.reviewerRequired', value: 'false', layer: 'local' });
    expect(o.loosens).toMatch(/without a reviewer approval/);
    expect(o.text).toContain('LOOSENS POLICY');
    await s.confirm(o);
    expect(readJson(local).verification.reviewerRequired).toBe(false);

    // The same change as a container request (forged snapshot) is refused by the host, whatever the snapshot claims.
    const crId = 'cr_0a1b2c3d';
    const forged = [
      { id: crId, kind: 'config-set', payload: { key: 'verification.reviewerRequired', value: 'true', layer: 'local' }, reason: null },
      { id: crId, kind: 'config-set', payload: { key: 'verification.reviewerRequired', value: 'true', layer: 'local' }, reason: null, origin: 'owner' as const },
      { id: 'ow_0a1b2c3d', kind: 'config-set', payload: { key: 'verification.reviewerRequired', value: 'true', layer: 'local' }, reason: null },
      { id: crId, kind: 'sync', payload: {}, reason: null },
      { id: crId, kind: 'undo', payload: { target: o.requestId }, reason: null },
    ];
    for (const f of forged) {
      const e = await reason(CR.buildPlan(project, f, { runtime: s.manager.runtime, upgrade: s.deps.upgrade }));
      expect(['CONFLICT', 'PRECONDITION']).toContain(e.code);
    }
    expect((await reason(CR.buildPlan(project, forged[0]!, { runtime: s.manager.runtime, upgrade: s.deps.upgrade }))).details).toMatchObject({ hostOwned: true });
  });

  it('delivery.requiredChecksConfigured (task-79): /set true is offered with its loosening text and applied; a container request is refused', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'delivery.requiredChecksConfigured', value: 'true', layer: 'local' });
    expect(o.summary).toBe('set delivery.requiredChecksConfigured: false -> true');
    expect(o.loosens).toMatch(/auto-merge may arm for pull requests once their required checks pass/);
    expect(o.text).toContain('LOOSENS POLICY');
    await s.confirm(o);
    expect(s.outcomes.map((x) => x.status)).toEqual(['applying', 'applied']);
    expect(readJson(local).delivery.requiredChecksConfigured).toBe(true);
    const off = await s.cmds.propose(null, { kind: 'config-set', key: 'delivery.requiredChecksConfigured', value: 'false', layer: 'local' });
    expect(off.loosens ?? null).toBeNull();
    await s.confirm(off);
    expect(readJson(local).delivery.requiredChecksConfigured).toBe(false);
    const forged = { id: 'cr_0a1b2c3e', kind: 'config-set', payload: { key: 'delivery.requiredChecksConfigured', value: 'true', layer: 'local' }, reason: null };
    expect((await reason(CR.buildPlan(project, forged, { runtime: s.manager.runtime, upgrade: s.deps.upgrade }))).details).toMatchObject({ hostOwned: true });
  });

  it('with several projects the command needs /project first; with a picked project it targets that one', async () => {
    const a = await install('a');
    const b = await install('b');
    const s = setup([a.project, b.project]);
    expect((await reason(s.cmds.propose(null, { kind: 'restart' }))).message).toMatch(/2 projects are registered: pick one with \/project/);
    const o = await s.cmds.propose(b.project.projectId, { kind: 'restart' });
    expect(o.projectId).toBe(b.project.projectId);
  });

  it('a refused confirmation (expired) brings a fresh offer of the same owner request from its journaled snapshot', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'restart' });
    s.advance(31 * 60_000);
    await s.confirm(o);
    expect(s.outcomes[0]).toMatchObject({ status: 'refused', requestId: o.requestId });
    expect(s.offers).toHaveLength(1);
    expect(s.offers[0]).toMatchObject({ requestId: o.requestId, kind: 'restart' });
    expect(s.offers[0]!.nonce).not.toBe(o.nonce);
    expect(s.runs).toEqual([]);
    await s.confirm(s.offers[0]!);
    expect(s.runs).toEqual([['settings', 'restart']]);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied' });
    noMarks(s.delegateCalls);
  });

  it('Reject of an owner offer journals rejected without any runtime call; a later Confirm is already handled', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'restart' });
    await s.manager.handle({ type: 'reject', requestId: o.requestId, nonce: o.nonce });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'rejected', requestId: o.requestId });
    expect(s.delegateCalls).toEqual([]);
    expect(journal().map((e) => e.type)).toEqual(['offer', 'rejected']);
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.runs).toEqual([]);
  });

  it('an interrupted owner apply is reported at startup and closed without a runtime mark', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'restart' });
    await J.recordOutcome({ type: 'confirmed', projectId: project.projectId, requestId: o.requestId, nonce: o.nonce, digest: o.digest, pid: 999_999_9, start: null });
    const m = new M.HostManager({ ...s.deps, writerAlive: () => false });
    expect(await m.startup()).toHaveLength(1);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'interrupted', requestId: o.requestId });
    expect(s.outcomes.at(-1)!.text).not.toMatch(/warning/);
    noMarks(s.delegateCalls);
  });
});

// ---------------------------------------------------------------- /restart, /upgrade, /sync

describe('/restart, /upgrade and /sync', () => {
  it('/upgrade shows the dry-run plan; the confirm runs the real upgrade', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'upgrade' });
    expect(s.upgrades).toEqual([{ fromContainer: null, dryRun: true }]);
    expect(o.kind).toBe('upgrade');
    expect(o.text).toContain('recreate: recreate the container');
    expect(o.text).toContain('runs:\n  minions upgrade');
    await s.confirm(o);
    expect(s.upgrades.at(-1)).toEqual({ fromContainer: null, dryRun: false });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', text: expect.stringContaining('upgrade: complete') });
  });

  it('/upgrade whose dry run fails is not offered', async () => {
    const { project } = await install();
    const s = setup([project], { upgrade: { ok: false, steps: [{ id: 'preflight', status: 'failed', detail: 'docker down' }], summary: 'failed: preflight (docker down)' } });
    expect((await reason(s.cmds.propose(null, { kind: 'upgrade' }))).message).toMatch(/would fail: failed: preflight/);
    expect(journal()).toEqual([]);
  });

  it('/sync plans `minions upgrade --sync-only` from its dry run and applies only the sync', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'sync' });
    expect(s.upgrades).toEqual([{ fromContainer: null, dryRun: true, syncOnly: true }]);
    expect(o).toMatchObject({ kind: 'sync', loosens: null, summary: expect.stringMatching(/sync the host base branch/) });
    expect(o.text).toContain('minions upgrade --sync-only');
    expect(o.text).toContain('sync: export, then fast-forward main aaa -> bbb');
    await s.confirm(o);
    expect(s.upgrades.at(-1)).toEqual({ fromContainer: null, dryRun: false, syncOnly: true });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', text: expect.stringContaining('sync: complete') });
    expect(journal().find((e) => e.type === 'applying')!.detail).toBe('minions upgrade --sync-only');
  });

  it('/sync whose dry run would refuse (dirty tree, divergence) shows the reason and offers nothing', async () => {
    const { project } = await install();
    const s = setup([project], { sync: { ok: false, steps: [{ id: 'sync', status: 'failed', detail: 'would refuse: the working tree has uncommitted changes' }], summary: 'failed: sync (would refuse: the working tree has uncommitted changes)' } });
    const e = await reason(s.cmds.propose(null, { kind: 'sync' }));
    expect(e.message).toMatch(/sync would be refused.*uncommitted changes/);
    expect(e.message).toMatch(/nothing is ever forced, reset or stashed/);
    expect(journal()).toEqual([]);
  });
});

// ---------------------------------------------------------------- /undo

describe('/undo: restore the config file a change wrote, compare-and-swap', () => {
  async function applied() {
    const i = await install();
    const s = setup([i.project]);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' });
    const before = existsSync(i.local) ? readFileSync(i.local, 'utf8') : null;
    await s.confirm(o);
    return { ...i, s, set: o, before };
  }

  it('proposes the inverse diff and, confirmed, restores the file as it was', async () => {
    const { s, set, local, before } = await applied();
    const u = await s.cmds.propose(null, { kind: 'undo', target: set.requestId });
    expect(u.kind).toBe('undo');
    expect(u.summary).toMatch(new RegExp(`^undo ${set.requestId}: execution.maxActiveTasks: 4 -> `));
    expect(u.text).toContain(`undoes: ${set.requestId}`);
    expect(readJson(local).execution.maxActiveTasks).toBe(4); // not yet
    await s.confirm(u);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', text: expect.stringContaining(`undid ${set.requestId}`) });
    expect(existsSync(local) ? readFileSync(local, 'utf8') : null).toBe(before);
    // The undo has its own history entry, so it can be undone in turn.
    const again = await s.cmds.propose(null, { kind: 'undo', target: u.requestId });
    expect(again.summary).toMatch(/-> 4$/);
    noMarks(s.delegateCalls);
  });

  it('shows the drift and stops when the file changed since the change wrote it', async () => {
    const { s, set, local } = await applied();
    writeFileSync(local, JSON.stringify({ ...readJson(local), execution: { maxActiveTasks: 7 } }, null, 2) + '\n');
    const e = await reason(s.cmds.propose(null, { kind: 'undo', target: set.requestId }));
    expect(e.message).toMatch(/changed since .* wrote it/);
    expect(e.message).toMatch(/drift: execution.maxActiveTasks in that file: .* wrote 4, now 7/);
    expect(journal().filter((x) => x.type === 'offer')).toHaveLength(1);
  });

  it('refuses at confirm time when the file changed after the undo was offered (nothing written)', async () => {
    const { s, set, local } = await applied();
    const u = await s.cmds.propose(null, { kind: 'undo', target: set.requestId });
    const drifted = JSON.stringify({ ...readJson(local), execution: { maxActiveTasks: 9 } }, null, 2) + '\n';
    writeFileSync(local, drifted);
    await s.confirm(u);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/changed since/) });
    expect(readFileSync(local, 'utf8')).toBe(drifted);
  });

  it('shared layer: the undo restores the committed file content and configRevision still moves forward', async () => {
    const repo = makeRepo(env.root, 'shared');
    const r = await runInit({ path: repo, yes: true, visibility: 'shared', dockerProbe: dockerUp });
    const project = await loadProjectJson(r.plan.projectId);
    const file = (await import('../../src/host/project.js')).projectConfigPath(project);
    const s = setup([project]);
    const rev0 = readJson(file).configRevision as number;
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '6', layer: 'shared' });
    expect(o.text).toContain('(shared layer');
    await s.confirm(o);
    expect(readJson(file)).toMatchObject({ configRevision: rev0 + 1, execution: expect.objectContaining({ maxActiveTasks: 6 }) });
    const before = readJson(file);
    const u = await s.cmds.propose(null, { kind: 'undo', target: o.requestId });
    await s.confirm(u);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied' });
    const after = readJson(file);
    expect(after.configRevision).toBe(rev0 + 2);
    expect(after.execution.maxActiveTasks).not.toBe(6);
    expect({ ...after, configRevision: 0 }).not.toEqual({ ...before, configRevision: 0 });
    // A plan made before the undo (against the old revision) is refused now.
    const stale = await s.cmds.propose(null, { kind: 'restart' });
    await editProjectConfigBump(project);
    await s.confirm(stale);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/revision/) });
  });

  it('refuses an id without history', async () => {
    const { project } = await install();
    const s = setup([project]);
    expect((await reason(s.cmds.propose(null, { kind: 'undo', target: 'cr_00000000' }))).message).toMatch(/No config history for cr_00000000/);
  });

  it('keeps only the last 20 history entries', async () => {
    const { project, local } = await install();
    for (let i = 0; i < 23; i++) {
      await H.beginHistory(project, `ow_${String(i).padStart(8, '0')}`, { key: 'execution.maxActiveTasks', layer: 'local', file: local, from: 1, to: 2 }, new Date(Date.UTC(2026, 9, 26, 10, i)));
    }
    const names = readdirSync(H.configHistoryDir(project.projectId)).sort();
    expect(names).toHaveLength(H.CONFIG_HISTORY_KEEP);
    expect(names[0]).toBe('ow_00000003.json');
  });
});

// ---------------------------------------------------------------- /undo with a tampered history entry

describe('/undo never trusts the history entry (file, layer, hidden keys)', () => {
  async function applied() {
    const i = await install();
    const s = setup([i.project]);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' });
    const before = existsSync(i.local) ? readFileSync(i.local, 'utf8') : null;
    await s.confirm(o);
    const entryFile = join(H.configHistoryDir(i.project.projectId), `${o.requestId}.json`);
    const tamper = (f: (e: Record<string, any>) => void) => { const e = readJson(entryFile); f(e); writeFileSync(entryFile, JSON.stringify(e, null, 2)); };
    return { ...i, s, set: o, before, entryFile, tamper };
  }
  const offers = () => journal().filter((x) => x.type === 'offer');

  it('a key hidden in the saved text is listed in the plan, and its loosening asks twice', async () => {
    const { project, s, set, local, tamper } = await applied();
    expect((await loadEffectiveConfig(project)).config.verification.reviewerRequired).toBe(true);
    // `after` is untouched, so the compare-and-swap still passes; `before` now also turns the reviewer off.
    tamper((e) => { const b = JSON.parse(e.before ?? '{}'); e.before = JSON.stringify({ ...b, verification: { reviewerRequired: false } }, null, 2) + '\n'; });
    const u = await s.cmds.propose(null, { kind: 'undo', target: set.requestId });
    expect(u.summary).toMatch(/^undo ow_[0-9a-f]{8}: execution.maxActiveTasks: 4 -> .* \(\+1 more setting\)$/);
    expect(u.text).toMatch(/change: execution.maxActiveTasks: 4 -> /);
    expect(u.text).toContain('change: verification.reviewerRequired: true -> false');
    expect(u.text).toContain('LOOSENS POLICY: verification.reviewerRequired: tasks can be delivered without a reviewer approval');
    // A loosening plan: the transport asks for a second tap.
    expect(u.loosens).toMatch(/without a reviewer approval/);
    const plan = offers().at(-1)!.plan;
    expect(plan.undo.changes.map((c: { key: string }) => c.key)).toEqual(['execution.maxActiveTasks', 'verification.reviewerRequired']);
    expect(readJson(local).execution.maxActiveTasks).toBe(4); // nothing written yet
  });

  it('refuses when the saved text would change anything that is not a setting', async () => {
    const { s, set, local, tamper } = await applied();
    const text = readFileSync(local, 'utf8');
    tamper((e) => { const b = JSON.parse(e.before ?? '{}'); e.before = JSON.stringify({ ...b, sensitivePaths: [] }); }); // valid config, but no setting
    const e = await reason(s.cmds.propose(null, { kind: 'undo', target: set.requestId }));
    expect(e.code).toBe('PRECONDITION');
    expect(e.details).toMatchObject({ refusal: 'history-mismatch' });
    expect(e.message).toMatch(/would also change sensitivePaths, which \/undo does not restore/);
    expect(offers()).toHaveLength(1);
    expect(readFileSync(local, 'utf8')).toBe(text);
  });

  it("refuses when the entry's key is not what the restore changes", async () => {
    const { s, set, tamper } = await applied();
    tamper((e) => { e.key = 'execution.maxEngineers'; });
    const e = await reason(s.cmds.propose(null, { kind: 'undo', target: set.requestId }));
    expect(e.message).toMatch(/names execution.maxEngineers, but restoring it would change execution.maxActiveTasks instead/);
    expect(offers()).toHaveLength(1);
  });

  it("an entry pointing at another file is refused and that file is never read or written", async () => {
    const { s, set, local, tamper } = await applied();
    const evil = join(env.root, 'evil.json');
    const text = readFileSync(local, 'utf8');
    // The tampered entry claims to have written `evil` (its after matches what is there).
    writeFileSync(evil, text);
    tamper((e) => { e.file = evil; e.before = '{"execution":{"maxActiveTasks":1}}\n'; });
    const e = await reason(s.cmds.propose(null, { kind: 'undo', target: set.requestId }));
    expect(e.code).toBe('PRECONDITION');
    expect(e.details).toMatchObject({ refusal: 'history-mismatch' });
    expect(e.message).toContain(`expected ${local}`);
    expect(readFileSync(evil, 'utf8')).toBe(text);
    expect(readFileSync(local, 'utf8')).toBe(text);
    // Nor at write time, whatever the caller passes.
    const w = await reason(H.applyUndo(await loadProjectJson(set.projectId), { target: set.requestId, expectSha256: H.textSha(text), restoreSha256: H.textSha('{"execution":{"maxActiveTasks":1}}\n'), undoId: 'ow_eeeeeeee' }));
    expect(w.details).toMatchObject({ refusal: 'history-mismatch' });
    expect(readFileSync(evil, 'utf8')).toBe(text);
    expect(offers()).toHaveLength(1);
  });

  it('an entry of another layer, project or request is refused', async () => {
    const { s, set, tamper } = await applied();
    tamper((e) => { e.layer = 'shared'; }); // a private install has no shared layer
    expect((await reason(s.cmds.propose(null, { kind: 'undo', target: set.requestId }))).code).toBe('PRECONDITION');
    tamper((e) => { e.layer = 'local'; e.projectId = 'other'; });
    expect((await reason(s.cmds.propose(null, { kind: 'undo', target: set.requestId }))).details).toMatchObject({ refusal: 'history-mismatch' });
    tamper((e) => { e.projectId = set.projectId; e.requestId = 'ow_00000001'; });
    expect((await reason(s.cmds.propose(null, { kind: 'undo', target: set.requestId }))).details).toMatchObject({ refusal: 'history-mismatch' });
    expect(offers()).toHaveLength(1);
  });

  it('an entry tampered after the undo was offered: the confirm is refused and nothing is written', async () => {
    const { s, set, local, tamper } = await applied();
    const u = await s.cmds.propose(null, { kind: 'undo', target: set.requestId });
    expect(u.loosens).toBeNull();
    const text = readFileSync(local, 'utf8');
    tamper((e) => { const b = JSON.parse(e.before ?? '{}'); e.before = JSON.stringify({ ...b, verification: { reviewerRequired: false } }); });
    await s.confirm(u);
    expect(s.outcomes.at(-1)!.status).not.toBe('applied');
    expect(readFileSync(local, 'utf8')).toBe(text);
    // At write time too: the restored text must be the one the plan was computed from.
    // The plan as first offered (a refused confirmation is re-offered with a fresh plan).
    const plan = offers().find((x) => x.requestId === u.requestId)!.plan;
    const project = await loadProjectJson(set.projectId);
    const w = await reason(H.applyUndo(project, { target: set.requestId, expectSha256: plan.undo.expectSha256, restoreSha256: plan.undo.restoreSha256, undoId: 'ow_dddddddd' }));
    expect(w.code).toBe('CONFLICT');
    expect(w.details).toMatchObject({ refusal: 'history-mismatch' });
    expect(readFileSync(local, 'utf8')).toBe(text);
  });
});

// ---------------------------------------------------------------- sync only (upgrade --sync-only)

describe('runSyncOnly (minions upgrade --sync-only)', () => {
  function syncRepo() {
    const repo = makeRepo(env.root, 'sync');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'tmp');
    writeFileSync(join(repo, 'feature.txt'), 'from the container\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'agent work');
    const ahead = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/minions/main', ahead);
    git(repo, 'branch', '-q', '-D', 'tmp');
    let exports = 0;
    return { repo, base, ahead, exports: () => exports, exportRepo: async () => { exports++; return { bundle: 'b', refs: [], changes: [] }; } };
  }

  it('dry run plans the fast-forward without exporting; the run exports and fast-forwards', async () => {
    const r = syncRepo();
    const sync = { repo: r.repo, branch: 'main', baseBranch: 'main', exportRepo: r.exportRepo };
    const dry = await US.runSyncOnly({ sync, origin: null, dryRun: true });
    expect(dry).toMatchObject({ ok: true, steps: [{ id: 'sync', status: 'planned' }], stopped: null });
    expect(r.exports()).toBe(0);
    const done = await US.runSyncOnly({ sync, origin: null });
    expect(done).toMatchObject({ ok: true, steps: [{ id: 'sync', status: 'done' }] });
    expect(git(r.repo, 'rev-parse', 'HEAD')).toBe(r.ahead);
    expect(r.exports()).toBe(1);
  });

  it('a dirty tree: the dry run reports the refusal (ok false), the run throws; nothing moves', async () => {
    const r = syncRepo();
    writeFileSync(join(r.repo, 'README.md'), '# local edit\n');
    const sync = { repo: r.repo, branch: 'main', baseBranch: 'main', exportRepo: r.exportRepo };
    const dry = await US.runSyncOnly({ sync, origin: null, dryRun: true });
    expect(dry.ok).toBe(false);
    expect(dry.steps[0]!.detail).toMatch(/would refuse: .*uncommitted or untracked changes/);
    await expect(US.runSyncOnly({ sync, origin: null })).rejects.toThrow(/refusing to move main/);
    expect(git(r.repo, 'rev-parse', 'HEAD')).toBe(r.base);
    expect(readFileSync(join(r.repo, 'README.md'), 'utf8')).toBe('# local edit\n');
  });
});

describe('QA: runSyncOnly never forces', () => {
  it('a divergence (a host commit not in minions/main): the dry run refuses, the run throws; main and the tree stay', async () => {
    const repo = makeRepo(env.root, 'diverge');
    git(repo, 'checkout', '-q', '-b', 'tmp');
    writeFileSync(join(repo, 'agent.txt'), 'agent\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'agent work');
    git(repo, 'update-ref', 'refs/remotes/minions/main', git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'branch', '-q', '-D', 'tmp');
    writeFileSync(join(repo, 'host.txt'), 'host\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'host work');
    const head = git(repo, 'rev-parse', 'HEAD');
    let exports = 0;
    const sync = { repo, branch: 'main', baseBranch: 'main', exportRepo: async () => { exports++; return { bundle: 'b', refs: [], changes: [] }; } };
    const dry = await US.runSyncOnly({ sync, origin: null, dryRun: true });
    expect(dry.ok).toBe(false);
    expect(dry.steps[0]!.detail).toMatch(/^would refuse: /);
    await expect(US.runSyncOnly({ sync, origin: null })).rejects.toThrow();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, 'agent.txt'))).toBe(false);
    expect(exports).toBeLessThanOrEqual(1);
  });

  it('needs exactly one source', async () => {
    await expect(US.runSyncOnly({ sync: null, origin: null })).rejects.toThrow(/exactly one source/);
  });
});

// ---------------------------------------------------------------- the chat side

const OWNER = 4242;
const TOKEN = '555666777:MMHmanagermanagermanagermanager_-9876';
const ACCESS = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T00:00:00.000Z' };
const msg = (update_id: number, text: string): TelegramUpdate => ({ update_id, message: { message_id: 1000 + update_id, text, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' } } });
const tap = (update_id: number, data: string): TelegramUpdate => ({ update_id, callback_query: { id: `cb${update_id}`, data, from: { id: OWNER }, message: { message_id: 50, chat: { id: OWNER, type: 'private' } } } });

function botApi(batches: TelegramUpdate[][]) {
  const calls: { method: string; body: Record<string, any> }[] = [];
  let nextId = 100;
  const clock = { t: Date.parse('2026-10-26T10:00:00Z') };
  const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    calls.push({ method, body });
    if (method === 'sendMessage') return res({ ok: true, result: { message_id: nextId++ } });
    if (method === 'getUpdates') return res({ ok: true, result: batches.shift() ?? [] });
    return res({ ok: true, result: true });
  }) as typeof fetch;
  return { f, calls, texts: () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text)), clock, push: (b: TelegramUpdate[]) => { batches.push(b); } };
}

describe('the manager chat: owner change commands', () => {
  it('parses the commands and their arguments; anything malformed gets the usage line', () => {
    expect(T.parseOwnerCommand('set', 'execution.maxActiveTasks 3')).toEqual({ kind: 'config-set', key: 'execution.maxActiveTasks', value: '3', layer: 'local' });
    expect(T.parseOwnerCommand('set', 'models.allowed opus, sonnet shared')).toEqual({ kind: 'config-set', key: 'models.allowed', value: 'opus, sonnet', layer: 'shared' });
    expect(T.parseOwnerCommand('undo', 'cr_0a1b2c3d')).toEqual({ kind: 'undo', target: 'cr_0a1b2c3d' });
    expect(T.parseOwnerCommand('undo', 'ow_0a1b2c3d')).toEqual({ kind: 'undo', target: 'ow_0a1b2c3d' });
    for (const k of ['sync', 'upgrade', 'restart'] as const) expect(T.parseOwnerCommand(k, '')).toEqual({ kind: k });
    for (const [c, a] of [['set', ''], ['set', 'execution.maxActiveTasks'], ['set', 'execution.maxActiveTasks -1'], ['set', 'a;b 1'], ['undo', ''], ['undo', '../x'], ['undo', 'cr_0a1b2c3d extra'], ['sync', 'now'], ['restart', '--force']]) {
      expect(T.parseOwnerCommand(c!, a!)).toBeNull();
    }
  });

  it('/set shows the plan with Confirm / Reject (ow_ buttons within 64 bytes); only the tap confirms; a loosening plan asks twice', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    // Make sure the reviewer is required, so turning it off loosens (refused as unchanged when it already is).
    const on = await s.cmds.propose(null, { kind: 'config-set', key: 'verification.reviewerRequired', value: 'true', layer: 'local' }).catch(() => null);
    if (on) await s.confirm(on);
    const runsBefore = s.runs.length;
    const api = botApi([[msg(1, '/set verification.reviewerRequired false')]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined, lookupOffer: async () => null });
    t.attach(s.cmds);
    expect(await t.receive(30_000)).toEqual([]); // typing is not consent: no event
    const shown = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(shown.body.text)).toMatch(/^Your request ow_[0-9a-f]{8} \(project /);
    expect(String(shown.body.text)).toContain('Confirm asks a second time');
    expect(shown.body.parse_mode).toBeUndefined();
    const [confirmBtn, rejectBtn] = shown.body.reply_markup.inline_keyboard[0];
    expect(confirmBtn.callback_data).toMatch(/^c:ow_[0-9a-f]{8}:[0-9a-f]{32}$/);
    expect(rejectBtn.callback_data).toMatch(/^r:ow_/);
    expect(Buffer.byteLength(confirmBtn.callback_data)).toBeLessThanOrEqual(T.CALLBACK_DATA_MAX_BYTES);
    expect(s.runs).toHaveLength(runsBefore);

    // First tap: a second confirmation, no event.
    api.push([tap(2, confirmBtn.callback_data)]);
    expect(await t.receive(30_000)).toEqual([]);
    const again = api.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(again.body.text)).toMatch(/^Second confirmation for change request ow_.*without a reviewer approval/s);
    expect(s.runs).toHaveLength(runsBefore);
    // Second tap: the confirm event, which the core applies.
    api.push([tap(3, again.body.reply_markup.inline_keyboard[0][0].callback_data)]);
    const [, rid, nonce] = String(confirmBtn.callback_data).split(':');
    const events = await t.receive(30_000);
    expect(events).toEqual([{ type: 'confirm', requestId: rid, nonce }]);
    expect(api.calls.filter((c) => c.method === 'answerCallbackQuery')).toHaveLength(2);
    await s.manager.handle(events[0]!);
    expect(readJson(local).verification.reviewerRequired).toBe(false);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', requestId: rid });
  });

  it('usage on bad arguments, the refusal text when the plan cannot be built, and /project needed with several projects', async () => {
    const a = await install('a');
    const b = await install('b');
    const s = setup([a.project, b.project]);
    const api = botApi([[msg(1, '/set'), msg(2, '/undo nope'), msg(3, '/restart'), msg(4, `/project ${a.project.projectId}`), msg(5, '/set execution.maxActiveTasks lots'), msg(6, '/undo cr_00000000'), msg(7, '/restart')]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    await t.receive(30_000);
    const texts = api.texts();
    expect(texts[0]).toMatch(/^Usage: \/set <key> <value>/);
    expect(texts[1]).toMatch(/^Usage: \/undo <id>/);
    expect(texts[2]).toMatch(/^\/restart failed: 2 projects are registered: pick one with \/project/);
    expect(texts[3]).toMatch(/^Project picked/);
    expect(texts[4]).toMatch(/^\/set failed: .*whole number/);
    expect(texts[5]).toMatch(/^\/undo failed: No config history for cr_00000000/);
    expect(texts[6]).toMatch(/^Your request ow_[0-9a-f]{8} \(project [^)]+\): restart the coordinator/);
    expect(texts[6]).toContain(a.project.projectId);
    expect(texts).toHaveLength(7);
  });
});

// ---------------------------------------------------------------- QA (task-53.5.3): security edges

describe('QA: owner command security edges', () => {
  const rows = (list: unknown[]) => async (_p: ProjectJson, argv: string[]) => (argv[1] === 'settings' && argv[2] === 'requests' && !argv.includes('mark') ? ok({ requests: list }) : ok({}));

  it('container rows through the poll: an ow_ id is dropped as malformed; a cr_ row claiming the owner origin or an owner-only kind is never offered', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    const before = existsSync(local) ? readFileSync(local, 'utf8') : null;
    const base = { status: 'proposed', reason: 'please', createdAt: '2026-10-26T09:00:00Z' };
    const m = new M.HostManager({ ...s.deps, delegate: rows([
      { ...base, id: 'ow_0a1b2c3d', kind: 'config-set', payload: { key: 'verification.reviewerRequired', value: 'false', layer: 'local' } },
      { ...base, id: 'cr_0a1b2c3d', kind: 'config-set', origin: 'owner', payload: { key: 'verification.reviewerRequired', value: 'false', layer: 'local' } },
      { ...base, id: 'cr_0a1b2c3e', kind: 'sync', payload: {} },
      { ...base, id: 'cr_0a1b2c3f', kind: 'undo', payload: { target: 'cr_00000000' } },
    ]) });
    expect(await m.pollProject(project)).toEqual([]);
    expect(s.offers).toEqual([]);
    expect(journal().filter((e) => e.type === 'offer')).toEqual([]);
    const texts = s.outcomes.map((o) => o.text).join('\n');
    expect(texts).toMatch(/ignored 1 malformed change request row/);
    expect(texts).toMatch(/cr_0a1b2c3d .*cannot be offered: .*host-owned/);
    expect(texts).toMatch(/cr_0a1b2c3e .*cannot be offered: .*only from the owner/);
    expect(texts).toMatch(/cr_0a1b2c3f .*cannot be offered: .*only from the owner/);
    expect(existsSync(local) ? readFileSync(local, 'utf8') : null).toBe(before);
    expect(s.runs).toEqual([]);
  });

  it('nonce replay: a made-up nonce, a nonce of another offer, and the old nonce after a re-offer never apply', async () => {
    const { project } = await install();
    const s = setup([project]);
    const a = await s.cmds.propose(null, { kind: 'restart' });
    const b = await s.cmds.propose(null, { kind: 'restart' });
    await s.manager.handle({ type: 'confirm', requestId: a.requestId, nonce: '0'.repeat(32) });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/no offer for change request ow_.* with this nonce/) });
    await s.manager.handle({ type: 'confirm', requestId: a.requestId, nonce: b.nonce });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/with this nonce/) });
    await s.manager.handle({ type: 'confirm', requestId: 'ow_XYZ', nonce: a.nonce });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'refused', text: expect.stringMatching(/malformed confirmation/) });
    expect(s.runs).toEqual([]);
    // Expired: refused and re-offered; the old nonce stays dead after that.
    s.advance(31 * 60_000);
    await s.confirm(a);
    const fresh = s.offers.find((o) => o.requestId === a.requestId)!;
    expect(fresh.nonce).not.toBe(a.nonce);
    const n = s.outcomes.length;
    await s.confirm(a);
    expect(s.outcomes.slice(n).map((o) => o.status)).not.toContain('applied');
    expect(s.runs).toEqual([]);
    await s.confirm(fresh);
    expect(s.runs).toEqual([['settings', 'restart']]);
    await s.confirm(fresh);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.runs).toHaveLength(1);
  });

  it('the double tap survives a transport restart: a loosening owner plan read from the journal still asks twice', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    const on = await s.cmds.propose(null, { kind: 'config-set', key: 'verification.reviewerRequired', value: 'true', layer: 'local' }).catch(() => null);
    if (on) await s.confirm(on);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'verification.reviewerRequired', value: 'false', layer: 'local' });
    expect(o.loosens).toBeTruthy();
    const snap = existsSync(local) ? readFileSync(local, 'utf8') : null;
    // A fresh transport that never sent this offer (no in-memory copy): the default journal lookup.
    const api = botApi([[tap(1, T.callbackData('c', o.requestId, o.nonce))]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.texts().at(-1)).toMatch(/^Second confirmation for change request ow_/);
    expect(existsSync(local) ? readFileSync(local, 'utf8') : null).toBe(snap);
    // A forged `d` without the armed first tap is refused by the transport.
    const api2 = botApi([[tap(2, T.callbackData('d', o.requestId, o.nonce))]]);
    const t2 = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api2.f, now: () => api2.clock.t, sleep: async () => undefined });
    t2.attach(s.cmds);
    expect(await t2.receive(30_000)).toEqual([]);
    expect(api2.texts().at(-1)).toMatch(/second confirmation .* expired/);
  });

  it('a non-owner typing /set is dropped silently: no reply, no plan, nothing journaled', async () => {
    const { project } = await install();
    const s = setup([project]);
    const propose = vi.spyOn(s.cmds, 'propose');
    const stranger = (update_id: number, text: string, from: number, chat: number): TelegramUpdate =>
      ({ update_id, message: { message_id: 1000 + update_id, text, from: { id: from, is_bot: false }, chat: { id: chat, type: 'private' } } });
    const api = botApi([[stranger(1, '/set verification.reviewerRequired false', 999, 999), stranger(2, '/restart', 999, OWNER), stranger(3, '/sync', OWNER, 999)]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.texts()).toEqual([]);
    expect(propose).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
  });

  it('undo write-time compare-and-swap: a stale expected sha is refused and the file is untouched', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' });
    await s.confirm(o);
    const text = readFileSync(local, 'utf8');
    const e = await reason(H.applyUndo(project, { target: o.requestId, expectSha256: 'f'.repeat(64), restoreSha256: H.textSha(null), undoId: 'ow_ffffffff' }));
    expect(e.code).toBe('CONFLICT');
    expect(e.details).toMatchObject({ refusal: 'drift' });
    expect(readFileSync(local, 'utf8')).toBe(text);
    expect(await H.loadHistory(project.projectId, 'ow_ffffffff')).toBeNull();
  });

  it('a config-set whose write failed leaves an incomplete history entry that /undo refuses', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' });
    const m = new M.HostManager({ ...s.deps, runChild: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    await m.handle({ type: 'confirm', requestId: o.requestId, nonce: o.nonce });
    expect(s.outcomes.at(-1)!.status).toBe('failed');
    expect(await H.loadHistory(project.projectId, o.requestId)).toMatchObject({ completed: false });
    expect((await reason(s.cmds.propose(null, { kind: 'undo', target: o.requestId }))).message).toMatch(/no completed write/);
    expect(existsSync(local) ? readJson(local).execution?.maxActiveTasks : undefined).not.toBe(4);
  });

  it('config history files are private (dir 0700, files 0600) and ids are validated before any path is built', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' });
    await s.confirm(o);
    const { statSync } = await import('node:fs');
    expect(statSync(H.configHistoryDir(project.projectId)).mode & 0o777).toBe(0o700);
    expect(statSync(join(H.configHistoryDir(project.projectId), `${o.requestId}.json`)).mode & 0o777).toBe(0o600);
    for (const bad of ['../config', 'cr_../../x', 'ow_0a1b2c3d/../../y']) {
      await expect(H.loadHistory(project.projectId, bad)).rejects.toThrow(/not a change request id/);
    }
    void local;
  });
});
