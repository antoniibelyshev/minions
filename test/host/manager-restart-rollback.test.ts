// task-53.7 (host manager phase 6): Restart when idle / Drain now after a refused restart, the CLI check and the
// "Roll back CLI" offer after an upgrade that replaced the CLI, and the dev-only rebuild-cli request. Temp
// MINIONS_HOME, a fake runtime delegate, a fake child runner, a fake upgrade, a fake CLI check and a fake npm: nothing
// touches the real system (git runs only against temp repositories).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const CR = await import('../../src/host/change-requests.js');
const J = await import('../../src/host/change-journal.js');
const B = await import('../../src/host/cli-backup.js');
const M = await import('../../src/host/manager.js');
const T = await import('../../src/host/manager-telegram.js');
const { makeRepo, withHome, dockerUp, git, tempDir } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type ManagerOffer = import('../../src/host/manager.js').ManagerOffer;
type ManagerOutcome = import('../../src/host/manager.js').ManagerOutcome;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type UpgradeRun = import('../../src/host/change-requests.js').UpgradeRun;
type CliHealth = import('../../src/host/cli-backup.js').CliHealth;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const journal = () => (existsSync(J.journalPath()) ? readFileSync(J.journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>) : []);
const ok = (data: unknown): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { code?: string; details?: any }; } throw new Error('expected a refusal'); };

async function install(name = 'repo', o: { minions?: boolean } = {}) {
  const repo = makeRepo(env.root, name);
  if (o.minions) {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'minions', version: '0.2.0' }));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'cli.ts'), 'export {};\n');
  }
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  if (o.minions) { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'minions checkout'); }
  return { project: await loadProjectJson(r.plan.projectId), repo };
}

interface World {
  leases: number;
  pausedStarts: boolean;
  restart: 'restarted' | 'refused' | (() => 'restarted' | 'refused');
  upgrade?: UpgradeRun;
  health: CliHealth[];
  npmFail?: boolean;
}

function setup(projects: ProjectJson[], w: World, extra: Partial<ManagerDeps> = {}) {
  let now = new Date('2026-10-26T10:00:00Z');
  const offers: ManagerOffer[] = [];
  const outcomes: ManagerOutcome[] = [];
  const delegateCalls: string[][] = [];
  const runs: string[][] = [];
  const npm: string[][] = [];
  const upgrades: Record<string, unknown>[] = [];
  const healthCalls: string[] = [];
  const deps: ManagerDeps = {
    transport: { sendOffer: async (x) => { offers.push(x); }, receive: async () => [], sendOutcome: async (x) => { outcomes.push(x); } },
    projects: async () => projects,
    loadProject: async (id) => projects.find((x) => x.projectId === id)!,
    running: async () => true,
    delegate: async (_p, argv) => {
      delegateCalls.push(argv);
      if (argv[1] === 'status') return ok({ activeLeases: Array.from({ length: w.leases }, (_, i) => ({ task_id: `task-${i}`, role: 'engineer' })), paused: { intake: false, starts: w.pausedStarts } });
      if (argv[1] === 'pause') { w.pausedStarts = true; return ok({}); }
      if (argv[1] === 'resume') { if (argv[2] === '--starts') w.pausedStarts = false; return ok({}); }
      return ok({ requests: [] });
    },
    runChild: async (_p, argv) => {
      runs.push(argv);
      const action = typeof w.restart === 'function' ? w.restart() : w.restart;
      return ok({ action, detail: action === 'refused' ? '2 active worker leases' : 'recover' });
    },
    upgrade: async (_p, x) => {
      upgrades.push(x);
      return x.dryRun ? { ok: true, steps: [{ id: 'cli', status: 'planned', detail: 'rebuild the linked checkout' }, { id: 'recreate', status: 'planned', detail: 'recreate' }], summary: '2 steps planned' }
        : w.upgrade ?? { ok: true, steps: [{ id: 'recreate', status: 'done', detail: 'recreate' }], summary: 'complete' };
    },
    cliHealth: async (p) => { healthCalls.push(p.projectId); return w.health.shift() ?? { ok: true, detail: 'minions 0.2.0 answers --version and status' }; },
    npm: async (cmd, args) => { npm.push([cmd, ...args]); return w.npmFail ? { code: 1, stdout: '', stderr: 'EACCES' } : { code: 0, stdout: '', stderr: '' }; },
    now: () => now,
    sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    log: () => undefined,
    ...extra,
  };
  const manager = new M.HostManager(deps);
  const cmds = manager.commands();
  const confirm = (x: ManagerOffer) => manager.handle({ type: 'confirm', requestId: x.requestId, nonce: x.nonce });
  return { deps, manager, cmds, offers, outcomes, delegateCalls, runs, npm, upgrades, healthCalls, confirm };
}

// ---------------------------------------------------------------- restart when idle / drain now

describe('a restart refused while workers run: Restart when idle and Drain now', () => {
  it('offers both follow-ups; Restart when idle is queued and runs at the first idle poll', async () => {
    const { project } = await install();
    const w: World = { leases: 2, pausedStarts: false, restart: () => (w.leases > 0 ? 'refused' : 'restarted'), health: [] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'failed', text: expect.stringMatching(/refused[\s\S]*Two plans follow: "Restart when idle"[\s\S]*"Drain now"/) });
    const [idle, drain] = s.offers;
    expect(idle).toMatchObject({ kind: 'restart', summary: expect.stringMatching(/^Restart when idle/), loosens: null });
    expect(drain).toMatchObject({ kind: 'restart', summary: expect.stringMatching(/^Drain now/), loosens: null });
    expect(idle!.text).toContain('restart: restart when idle (queued)');
    expect(drain!.text).toContain('minions pause --starts --drain --reason restart');
    // Offering is not consent: nothing is queued until a Confirm.
    expect(s.manager.queuedRestarts()).toEqual([]);

    await s.confirm(idle!);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'queued', requestId: idle!.requestId, text: expect.stringMatching(/queued - restart when idle/) });
    expect(s.manager.queuedRestarts()).toEqual([expect.objectContaining({ projectId: project.projectId, requestId: idle!.requestId, mode: 'when-idle' })]);
    expect(journal().filter((e) => e.requestId === idle!.requestId).map((e) => e.type)).toEqual(['offer', 'confirmed', 'applying']);
    expect(await s.cmds.status(null)).toMatch(new RegExp(`queued restart: ${idle!.requestId} \\(restart when idle`));
    // No pause or drain for when-idle.
    expect(s.delegateCalls.filter((c) => c[1] === 'pause' || c[1] === 'resume')).toEqual([]);

    const restarts = () => s.runs.filter((r) => r[1] === 'restart').length;
    expect(restarts()).toBe(1);
    await s.manager.pollAll(); // still busy
    expect(restarts()).toBe(1);
    expect(s.manager.queuedRestarts()).toHaveLength(1);

    w.leases = 0;
    await s.manager.pollAll(); // the first idle poll
    expect(restarts()).toBe(2);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', requestId: idle!.requestId, text: expect.stringMatching(/coordinator restart: restarted/) });
    expect(journal().filter((e) => e.requestId === idle!.requestId).map((e) => e.type)).toEqual(['offer', 'confirmed', 'applying', 'applied']);
    expect(s.manager.queuedRestarts()).toEqual([]);
    await s.manager.pollAll();
    expect(restarts()).toBe(2);
  });

  it('Drain now pauses starts with a drain, then resumes them and restarts at the first idle poll', async () => {
    const { project } = await install();
    const w: World = { leases: 1, pausedStarts: false, restart: () => (w.leases > 0 ? 'refused' : 'restarted'), health: [] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    const drain = s.offers.find((o) => o.summary.startsWith('Drain now'))!;
    await s.confirm(drain);
    expect(s.delegateCalls.filter((c) => c[1] === 'pause')).toEqual([['minions', 'pause', '--starts', '--drain', '--reason', 'restart', '--json']]);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'queued', text: expect.stringMatching(/Starts are paused/) });
    expect(journal().filter((e) => e.requestId === drain.requestId).at(-1)).toMatchObject({ type: 'applying', detail: expect.stringMatching(/^queued: drain now/) });

    w.leases = 0;
    await s.manager.pollAll();
    const order = s.delegateCalls.filter((c) => c[1] === 'resume').map((c) => c.join(' '));
    expect(order).toEqual(['minions resume --starts --json']);
    expect(w.pausedStarts).toBe(false);
    expect(s.runs.at(-1)).toEqual(['settings', 'restart']);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', requestId: drain.requestId });
  });

  it('Drain now keeps a pause the owner made: only the drain is cleared', async () => {
    const { project } = await install();
    const w: World = { leases: 1, pausedStarts: true, restart: () => (w.leases > 0 ? 'refused' : 'restarted'), health: [] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    await s.confirm(s.offers.find((o) => o.summary.startsWith('Drain now'))!);
    w.leases = 0;
    await s.manager.pollAll();
    expect(s.delegateCalls.filter((c) => c[1] === 'resume')).toEqual([['minions', 'resume', '--drain', '--json']]);
    expect(w.pausedStarts).toBe(true);
  });

  it('a restart refused again at the idle poll (a lease started in between) stays queued; nothing else is tried', async () => {
    const { project } = await install();
    let refuseNext = 2;
    const w: World = { leases: 1, pausedStarts: false, restart: () => (refuseNext-- > 0 ? 'refused' : 'restarted'), health: [] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    await s.confirm(s.offers[0]!);
    w.leases = 0;
    await s.manager.pollAll();
    expect(s.runs.filter((r) => r[1] === 'restart')).toHaveLength(2);
    expect(s.manager.queuedRestarts()).toHaveLength(1);
    expect(s.outcomes.at(-1)!.status).toBe('queued');
    await s.manager.pollAll();
    expect(s.runs.filter((r) => r[1] === 'restart')).toHaveLength(3);
    expect(s.outcomes.at(-1)!.status).toBe('applied');
    // Only `settings restart` ever ran: no other strategy.
    expect(new Set(s.runs.map((r) => r.join(' ')))).toEqual(new Set(['settings restart']));
  });

  it('a second queued restart for the same project is refused; a failed drain queues nothing', async () => {
    const { project } = await install();
    const w: World = { leases: 1, pausedStarts: false, restart: 'refused', health: [] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    const [idle, drain] = s.offers;
    await s.confirm(idle!);
    await s.confirm(drain!);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'failed', requestId: drain!.requestId, text: expect.stringMatching(/already queued for this project \(ow_/) });
    expect(s.delegateCalls.filter((c) => c[1] === 'pause')).toEqual([]);

    const t = setup([project], w, { delegate: async (_p, argv) => (argv[1] === 'status' ? ok({ activeLeases: [{}], paused: { starts: false } }) : { code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'unknown option --drain' } }), stderr: '' }) });
    await t.confirm(await t.cmds.propose(null, { kind: 'restart' }));
    await t.confirm(t.offers.find((o) => o.summary.startsWith('Drain now'))!);
    expect(t.outcomes.at(-1)).toMatchObject({ status: 'failed', text: expect.stringMatching(/drain now failed, nothing queued: .*unknown option --drain/) });
    expect(t.manager.queuedRestarts()).toEqual([]);
  });

  it('a manager restart reports a queued restart as interrupted and never resumes it', async () => {
    const { project } = await install();
    const w: World = { leases: 1, pausedStarts: false, restart: 'refused', health: [] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    const drain = s.offers.find((o) => o.summary.startsWith('Drain now'))!;
    await s.confirm(drain);
    const t = setup([project], { ...w, leases: 0 }, { writerAlive: () => false });
    const found = await t.manager.startup();
    expect(found.map((e) => e.requestId)).toEqual([drain.requestId]);
    expect(t.outcomes[0]).toMatchObject({ status: 'interrupted', text: expect.stringMatching(/interrupted, state unknown[\s\S]*It was queued: drain now[\s\S]*minions resume --starts/) });
    await t.manager.pollAll();
    expect(t.runs).toEqual([]);
  });

  it('only the owner may ask for a queued restart: a container request with a mode is refused', async () => {
    const { project } = await install();
    const deps = { runtime: { running: async () => true, exec: async () => ok({}) }, upgrade: async () => ({ ok: true, steps: [], summary: '' }) };
    const e = await reason(CR.buildPlan(project, { id: 'cr_0123abcd', kind: 'restart', payload: { mode: 'drain' }, reason: null }, deps));
    expect(e.message).toMatch(/malformed restart payload/);
    const f = await reason(CR.buildPlan(project, { id: 'ow_0123abcd', kind: 'restart', payload: { mode: 'now' }, reason: null, origin: 'owner' }, deps));
    expect(f.message).toMatch(/malformed restart payload/);
    // The plain restart keeps its plan (and digest) without a restart field.
    const plain = await CR.buildPlan(project, { id: 'cr_0123abcd', kind: 'restart', payload: {}, reason: null }, deps);
    expect(plain.plan.restart).toBeUndefined();
  });
});

// ---------------------------------------------------------------- CLI check and roll back

async function makeBackup(version = '0.1.0') {
  const src = tempDir('minions-install-');
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'minions', version }));
  return B.backupInstalledCli(src, version, {
    runner: async (_c, args) => { writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, `minions-${version}.tgz`), `tgz ${version}`); return { code: 0, stdout: '', stderr: '' }; },
  });
}
const reinstalled: UpgradeRun = { ok: true, steps: [{ id: 'cli', status: 'done', detail: 'installed 0.1.0 != checkout 0.2.0; reinstalled (npm ...)' }, { id: 'recreate', status: 'done', detail: 'recreate' }], summary: 'complete' };

describe('CLI check after an upgrade that replaced the CLI, and Roll back CLI', () => {
  it('a failed check offers Roll back CLI; its Confirm reinstalls the backup and checks again', async () => {
    const { project } = await install();
    const b = await makeBackup('0.1.0');
    const w: World = { leases: 0, pausedStarts: false, restart: 'restarted', upgrade: reinstalled, health: [{ ok: false, detail: '`minions --version` failed (exit 1): SyntaxError' }] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'upgrade' }));
    expect(s.healthCalls).toHaveLength(1);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', text: expect.stringMatching(/CLI CHECK FAILED: `minions --version` failed[\s\S]*"Roll back CLI" plan follows/) });
    const rb = s.offers.at(-1)!;
    expect(rb).toMatchObject({ kind: 'cli-rollback', summary: 'Roll back CLI: reinstall minions 0.1.0 from the backup', loosens: null });
    expect(rb.text).toContain(b.file);
    expect(s.npm).toEqual([]); // offered, not run

    await s.confirm(rb);
    expect(s.npm).toEqual([['npm', 'install', '-g', '--no-audit', '--no-fund', b.file]]);
    expect(s.healthCalls).toHaveLength(2);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', requestId: rb.requestId, text: expect.stringMatching(/reinstalled minions 0.1.0 .*CLI check: minions 0.2.0 answers/) });
  });

  it('a backup changed since the plan is refused (nothing installed); a check still failing after the roll back is reported, not retried', async () => {
    const { project } = await install();
    const b = await makeBackup('0.1.0');
    const w: World = { leases: 0, pausedStarts: false, restart: 'restarted', upgrade: reinstalled, health: [{ ok: false, detail: 'status failed' }] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'upgrade' }));
    const rb = s.offers.at(-1)!;
    writeFileSync(b.file, 'tampered');
    await s.confirm(rb);
    expect(s.npm).toEqual([]);
    expect(s.outcomes.some((o) => o.status === 'refused' && /digest mismatch|plan changed/.test(o.text))).toBe(true);

    // A fresh offer came with the refusal; this time the check after the install still fails.
    const fresh = s.offers.at(-1)!;
    expect(fresh.requestId).toBe(rb.requestId);
    w.health.push({ ok: false, detail: 'still broken' });
    await s.confirm(fresh);
    expect(s.npm).toHaveLength(1);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'failed', text: expect.stringMatching(/but the CLI check still fails: still broken\. Nothing else is tried/) });
    expect(s.offers.at(-1)!.requestId).toBe(rb.requestId); // no new roll back offer
  });

  it('a passing check is reported; no check when the CLI was not touched; no backup means no roll back offer', async () => {
    const { project } = await install();
    const w: World = { leases: 0, pausedStarts: false, restart: 'restarted', upgrade: reinstalled, health: [] };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'upgrade' }));
    expect(s.outcomes.at(-1)!.text).toMatch(/CLI check: minions 0.2.0 answers --version and status/);

    const t = setup([project], { ...w, upgrade: undefined });
    await t.confirm(await t.cmds.propose(null, { kind: 'upgrade' }));
    expect(t.healthCalls).toEqual([]);

    const u = setup([project], { ...w, health: [{ ok: false, detail: 'broken' }] });
    await u.confirm(await u.cmds.propose(null, { kind: 'upgrade' }));
    expect(u.outcomes.at(-1)!.text).toMatch(/CLI CHECK FAILED: broken\nThere is no CLI backup to roll back to/);
    expect(u.offers).toEqual([]); // propose returns the plan itself; no roll back offer was sent
  });

  it('cliReplaced: only a rebuild or reinstall that ran counts', () => {
    const r = (status: string, detail: string): UpgradeRun => ({ ok: true, steps: [{ id: 'cli', status, detail }], summary: '' });
    expect(M.cliReplaced(r('done', 'reinstalled'))).toBe(true);
    expect(M.cliReplaced(r('failed', 'x; reinstall failed: npm install failed: EACCES'))).toBe(true);
    expect(M.cliReplaced(r('failed', 'reinstall finished but installed 0.1.0 != checkout 0.2.0'))).toBe(true);
    expect(M.cliReplaced(r('failed', 'x; review them, then rerun with --rebuild-cli'))).toBe(false);
    expect(M.cliReplaced(r('skipped', 'matches'))).toBe(false);
  });

  it('checkCliHealth needs a version line and an ok status envelope', async () => {
    const good = await B.checkCliHealth(async (argv) => (argv[0] === '--version' ? { code: 0, stdout: '0.2.0\n', stderr: '' } : ok({})));
    expect(good).toEqual({ ok: true, detail: 'minions 0.2.0 answers --version and status' });
    const bad = await B.checkCliHealth(async (argv) => (argv[0] === '--version' ? { code: 1, stdout: '', stderr: 'SyntaxError: x' } : { code: 1, stdout: '{"ok":false,"error":{"message":"boom"}}', stderr: '' }));
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/--version` failed \(exit 1\): SyntaxError: x; `minions status` failed \(exit 1\): boom/);
  });

  it('the terminal route refuses the manager-only kinds', async () => {
    const { project } = await install();
    const b = await makeBackup();
    const deps = { runtime: { running: async () => true, exec: async () => ok({}) }, upgrade: async () => ({ ok: true, steps: [], summary: '' }) };
    const offered = await CR.offerRequest(project, { id: 'ow_00000001', kind: 'cli-rollback', payload: { backup: b.name }, reason: null, origin: 'owner' }, deps);
    const e = await reason(CR.confirmRequest(project, 'ow_00000001', offered.digest, deps));
    expect(e.message).toMatch(/runs only in the host manager; nothing applied/);
    const c = await reason(CR.buildPlan(project, { id: 'cr_0000abcd', kind: 'cli-rollback', payload: { backup: b.name }, reason: null }, deps));
    expect(c.message).toMatch(/comes only from the owner/);
  });
});

// ---------------------------------------------------------------- dev-only rebuild-cli

/** A running CLI root (a minions source checkout) whose dist/build.json names `commit`. */
function runningRoot(commit: string | null, o: { checkout?: boolean } = {}) {
  const dir = tempDir('minions-running-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'minions', version: '0.2.0' }));
  if (o.checkout !== false) { mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src', 'cli.ts'), ''); }
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'build.json'), JSON.stringify({ version: '0.2.0', source: 'x', kind: 'source', ...(commit ? { commit, dirty: false } : {}) }));
  return dir;
}

describe('dev-only rebuild-cli', () => {
  it('is hidden and refused on a normal install (or for a project that is not minions)', async () => {
    const plain = await install('plain');
    const mine = await install('minions-repo', { minions: true });
    const packed = runningRoot(null, { checkout: false }); // a packed install has no src/
    const w: World = { leases: 0, pausedStarts: false, restart: 'restarted', health: [] };
    for (const [projects, root] of [[[mine.project], packed], [[plain.project], runningRoot(git(mine.repo, 'rev-parse', 'HEAD'))]] as const) {
      const s = setup([...projects], w, { cli: { runningRoot: root } });
      expect(await s.cmds.devRebuild!(null)).toBe(false);
      const e = await reason(s.cmds.propose(null, { kind: 'rebuild-cli' }));
      expect(e.details?.refusal).toBe('unavailable');
      expect(journal()).toEqual([]);
      // The chat neither lists nor accepts it.
      const chat = fakeChat(s.cmds);
      await chat.say('/help');
      await chat.say('/rebuild_cli');
      expect(chat.sent).toEqual([T.helpText(false), T.helpText(false)]);
      expect(chat.sent[0]).not.toContain('rebuild');
    }
    // A container request for it is refused whatever the host.
    const deps = { runtime: { running: async () => true, exec: async () => ok({}) }, upgrade: async () => ({ ok: true, steps: [], summary: '' }), cli: { runningRoot: runningRoot(git(mine.repo, 'rev-parse', 'HEAD')) } };
    expect((await reason(CR.buildPlan(mine.project, { id: 'cr_0000abcd', kind: 'rebuild-cli', payload: {}, reason: null }, deps))).message).toMatch(/comes only from the owner/);
  });

  it('in a minions source checkout: shows git log, diffstat and sensitive paths, asks twice, and runs upgrade --rebuild-cli', async () => {
    const { project, repo } = await install('minions-repo', { minions: true });
    const from = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'add feature');
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'touch ci');
    const to = git(repo, 'rev-parse', 'HEAD');
    const w: World = { leases: 0, pausedStarts: false, restart: 'restarted', health: [], upgrade: { ok: true, steps: [{ id: 'cli', status: 'done', detail: 'rebuilt' }], summary: 'complete' } };
    const s = setup([project], w, { cli: { runningRoot: runningRoot(from) } });
    expect(await s.cmds.devRebuild!(null)).toBe(true);

    const o = await s.cmds.propose(null, { kind: 'rebuild-cli' });
    expect(s.upgrades).toEqual([{ fromContainer: null, dryRun: true, rebuildCli: true }]);
    expect(o.summary).toBe(`rebuild the host CLI from 2 commits (${from.slice(0, 12)}..${to.slice(0, 12)}), then upgrade`);
    expect(o.loosens).toMatch(/runs build scripts from 2 commits made in the container on your host.*touches 1 sensitive path/);
    expect(o.text).toContain(`commits (git log --oneline ${from.slice(0, 12)}..${to.slice(0, 12)}): 2`);
    expect(o.text).toMatch(/ touch ci\n.* add feature\n/);
    expect(o.text).toMatch(/diffstat:\n.*\.github\/workflows\/ci\.yml[\s\S]*src\/feature\.ts[\s\S]*2 files changed/);
    expect(o.text).toContain('SENSITIVE PATHS TOUCHED: .github/workflows/ci.yml');
    expect(o.text).toContain('minions upgrade --rebuild-cli');

    await s.confirm(o);
    expect(s.upgrades.at(-1)).toEqual({ fromContainer: null, dryRun: false, rebuildCli: true });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', text: expect.stringMatching(/rebuild-cli: complete[\s\S]*CLI check:/) });
  });

  it('the chat lists it and asks twice; a moved HEAD refuses the confirmation; a dirty checkout or an unknown build commit refuses the plan', async () => {
    const { project, repo } = await install('minions-repo', { minions: true });
    const from = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'a');
    const w: World = { leases: 0, pausedStarts: false, restart: 'restarted', health: [] };
    const s = setup([project], w, { cli: { runningRoot: runningRoot(from) } });
    const chat = fakeChat(s.cmds);
    await chat.say('/help');
    expect(chat.sent[0]).toBe(T.helpText(true));
    expect(chat.sent[0]).toContain(T.REBUILD_HELP_LINE);
    await chat.say('/rebuild_cli');
    expect(chat.offers).toHaveLength(1);
    expect(chat.offers[0]!.loosens).not.toBeNull(); // the transport asks twice for a plan that loosens

    const o = chat.offers[0]!;
    writeFileSync(join(repo, 'b.txt'), 'b\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'b');
    await s.confirm(o);
    expect(s.upgrades.filter((u) => !u.dryRun)).toEqual([]);
    expect(s.outcomes.find((x) => x.status === 'refused')!.text).toMatch(/plan changed since it was shown/);

    writeFileSync(join(repo, 'dirty.txt'), 'x');
    expect((await reason(s.cmds.propose(null, { kind: 'rebuild-cli' }))).message).toMatch(/uncommitted or untracked changes/);
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'c');
    const t = setup([project], w, { cli: { runningRoot: runningRoot(null) } });
    expect((await reason(t.cmds.propose(null, { kind: 'rebuild-cli' }))).message).toMatch(/records no build commit/);
  });
});

/** The real Telegram transport's command handling against a fake Bot API (owner messages only). */
function fakeChat(cmds: import('../../src/host/manager.js').ManagerCommands) {
  const OWNER = 4242;
  const sent: string[] = [];
  const offers: ManagerOffer[] = [];
  const access = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T00:00:00.000Z' };
  let updateId = 1;
  const queue: TelegramUpdate[] = [];
  const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    if (method === 'getUpdates') return res({ ok: true, result: queue.splice(0) });
    if (method === 'sendMessage') {
      // Plan messages and "Planning ..." are not plain replies.
      if (!/^(Your request|Planning)/.test(String(body.text))) sent.push(String(body.text));
      return res({ ok: true, result: { message_id: 100 + updateId } });
    }
    return res({ ok: true, result: true });
  }) as typeof fetch;
  const t = T.telegramTransport({ token: '555666777:MMHmanagermanagermanagermanager_-9876', access, fetch: f, now: () => Date.parse('2026-10-26T10:00:00Z'), sleep: async () => undefined, lookupOffer: async () => null });
  t.attach({ ...cmds, propose: async (p, c) => { const o = await cmds.propose(p, c); offers.push(o); return o; } });
  return {
    sent, offers,
    say: async (text: string) => {
      const id = updateId++;
      queue.push({ update_id: id, message: { message_id: 1000 + id, text, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' } } } as TelegramUpdate);
      await t.receive(30_000);
    },
  };
}
