// task-53.7 QA: edges of Restart when idle / Drain now, Roll back CLI and the dev-only /rebuild_cli that
// manager-restart-rollback.test.ts does not cover. Temp MINIONS_HOME, a fake runtime delegate, a fake child runner, a
// fake upgrade, a fake CLI check, a fake npm and a fake Bot API: nothing touches the real system (git runs only against
// temp repositories).
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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
const B = await import('../../src/host/cli-backup.js');
const M = await import('../../src/host/manager.js');
const T = await import('../../src/host/manager-telegram.js');
const { makeRepo, withHome, dockerUp, git, tempDir } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type ManagerOffer = import('../../src/host/manager.js').ManagerOffer;
type ManagerOutcome = import('../../src/host/manager.js').ManagerOutcome;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type ManagerEvent = import('../../src/host/manager.js').ManagerEvent;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

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

interface World { leases: number; pausedStarts: boolean; running: boolean; restart: () => string; statusFails?: boolean }

function setup(projects: ProjectJson[], w: World, extra: Partial<ManagerDeps> = {}) {
  let now = new Date('2026-10-26T10:00:00Z');
  const offers: ManagerOffer[] = [];
  const outcomes: ManagerOutcome[] = [];
  const delegateCalls: string[][] = [];
  const runs: string[][] = [];
  const upgrades: Record<string, unknown>[] = [];
  const deps: ManagerDeps = {
    transport: { sendOffer: async (x) => { offers.push(x); }, receive: async () => [], sendOutcome: async (x) => { outcomes.push(x); } },
    projects: async () => projects,
    loadProject: async (id) => projects.find((x) => x.projectId === id)!,
    running: async () => w.running,
    delegate: async (_p, argv) => {
      delegateCalls.push(argv);
      if (argv[1] === 'status') {
        if (w.statusFails) return { code: 1, stdout: '', stderr: 'database is locked' };
        return ok({ activeLeases: Array.from({ length: w.leases }, (_, i) => ({ task_id: `task-${i}`, role: 'engineer' })), paused: { intake: false, starts: w.pausedStarts } });
      }
      if (argv[1] === 'pause') { w.pausedStarts = true; return ok({}); }
      if (argv[1] === 'resume') { if (argv[2] === '--starts') w.pausedStarts = false; return ok({}); }
      return ok({ requests: [] });
    },
    runChild: async (_p, argv) => {
      runs.push(argv);
      const action = w.restart();
      return ok({ action, detail: action === 'refused' ? '1 active worker lease' : action === 'not-running' ? 'the runtime is not running' : 'recover' });
    },
    upgrade: async (_p, x) => {
      upgrades.push(x);
      return x.dryRun ? { ok: true, steps: [{ id: 'cli', status: 'planned', detail: 'rebuild the linked checkout' }], summary: '1 step planned' }
        : { ok: true, steps: [{ id: 'cli', status: 'done', detail: 'rebuilt' }], summary: 'complete' };
    },
    cliHealth: async () => ({ ok: true, detail: 'minions 0.2.0 answers --version and status' }),
    npm: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => now,
    sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    log: () => undefined,
    ...extra,
  };
  const manager = new M.HostManager(deps);
  const cmds = manager.commands();
  const confirm = (x: ManagerOffer) => manager.handle({ type: 'confirm', requestId: x.requestId, nonce: x.nonce });
  return { deps, manager, cmds, offers, outcomes, delegateCalls, runs, upgrades, confirm };
}

/** A running CLI root (a minions source checkout) whose dist/build.json names `commit`. */
function runningRoot(commit: string | null) {
  const dir = tempDir('minions-running-');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'minions', version: '0.2.0' }));
  mkdirSync(join(dir, 'src'), { recursive: true }); writeFileSync(join(dir, 'src', 'cli.ts'), '');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'build.json'), JSON.stringify({ version: '0.2.0', source: 'x', kind: 'source', ...(commit ? { commit, dirty: false } : {}) }));
  return dir;
}

/** The real Telegram transport's command and tap handling against a fake Bot API (owner only). */
function fakeChat(cmds: import('../../src/host/manager.js').ManagerCommands) {
  const OWNER = 4242;
  const sent: string[] = [];
  const offers: ManagerOffer[] = [];
  const proposed: unknown[] = [];
  const access = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T00:00:00.000Z' };
  let updateId = 1;
  const queue: TelegramUpdate[] = [];
  const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    if (method === 'getUpdates') return res({ ok: true, result: queue.splice(0) });
    if (method === 'sendMessage') {
      if (!/^(Your request|Planning)/.test(String(body.text))) sent.push(String(body.text));
      return res({ ok: true, result: { message_id: 100 + updateId } });
    }
    return res({ ok: true, result: true });
  }) as typeof fetch;
  const t = T.telegramTransport({ token: '555666777:MMHmanagermanagermanagermanager_-9876', access, fetch: f, now: () => Date.parse('2026-10-26T10:00:00Z'), sleep: async () => undefined, lookupOffer: async () => null });
  t.attach({ ...cmds, propose: async (p, c) => { proposed.push(c); const o = await cmds.propose(p, c); offers.push(o); return o; } });
  return {
    sent, offers, proposed,
    say: async (text: string): Promise<ManagerEvent[]> => {
      const id = updateId++;
      queue.push({ update_id: id, message: { message_id: 1000 + id, text, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' } } } as TelegramUpdate);
      return t.receive(30_000);
    },
    tap: async (data: string): Promise<ManagerEvent[]> => {
      const id = updateId++;
      queue.push({ update_id: id, callback_query: { id: `cb${id}`, data, from: { id: OWNER }, message: { message_id: 50, chat: { id: OWNER, type: 'private' } } } } as TelegramUpdate);
      return t.receive(30_000);
    },
  };
}

// ---------------------------------------------------------------- restart when idle / drain now

describe('QA: queued restarts', () => {
  it('a status read that fails at the poll keeps the restart queued, is reported once, and nothing runs', async () => {
    const { project } = await install();
    const w: World = { leases: 1, pausedStarts: false, running: true, restart: () => (w.leases > 0 ? 'refused' : 'restarted') };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    await s.confirm(s.offers.find((o) => o.summary.startsWith('Drain now'))!);
    const runsBefore = s.runs.length;
    w.leases = 0;
    w.statusFails = true;
    await s.manager.pollAll();
    await s.manager.pollAll();
    expect(s.runs.length).toBe(runsBefore);
    expect(s.delegateCalls.filter((c) => c[1] === 'resume')).toEqual([]);
    expect(s.outcomes.filter((o) => o.status === 'error' && /it stays queued/.test(o.text))).toHaveLength(1);
    expect(s.manager.queuedRestarts()).toHaveLength(1);
    // Once the runtime answers again it runs: the pause made by Drain now is resumed, then the restart.
    w.statusFails = false;
    await s.manager.pollAll();
    expect(s.delegateCalls.filter((c) => c[1] === 'resume').map((c) => c.join(' '))).toEqual(['minions resume --starts --json']);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied' });
    expect(s.manager.queuedRestarts()).toEqual([]);
  });

  it('Drain now refused again at the idle poll: the pause is resumed once, never re-paused, and only `settings restart` is retried', async () => {
    const { project } = await install();
    let refuse = 2; // the first (plain) restart and the first idle poll
    const w: World = { leases: 1, pausedStarts: false, running: true, restart: () => (refuse-- > 0 ? 'refused' : 'restarted') };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    await s.confirm(s.offers.find((o) => o.summary.startsWith('Drain now'))!);
    w.leases = 0;
    await s.manager.pollAll();
    expect(s.manager.queuedRestarts()).toHaveLength(1);
    await s.manager.pollAll();
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied' });
    expect(s.delegateCalls.filter((c) => c[1] === 'pause')).toHaveLength(1);
    expect(s.delegateCalls.filter((c) => c[1] === 'resume')).toHaveLength(1);
    expect(new Set(s.runs.map((r) => r.join(' ')))).toEqual(new Set(['settings restart']));
  });

  it('a queued restart for one project does not block a restart queued for another', async () => {
    const a = await install('repo-a');
    const b = await install('repo-b');
    const w: World = { leases: 1, pausedStarts: false, running: true, restart: () => (w.leases > 0 ? 'refused' : 'restarted') };
    const s = setup([a.project, b.project], w);
    await s.confirm(await s.cmds.propose(a.project.projectId, { kind: 'restart' }));
    await s.confirm(s.offers.find((o) => o.summary.startsWith('Restart when idle'))!);
    s.offers.length = 0;
    await s.confirm(await s.cmds.propose(b.project.projectId, { kind: 'restart' }));
    await s.confirm(s.offers.find((o) => o.summary.startsWith('Restart when idle'))!);
    expect(s.manager.queuedRestarts().map((q) => q.projectId).sort()).toEqual([a.project.projectId, b.project.projectId].sort());
  });

  // DEFECT (reported to the coordinator): when the runtime is stopped at the idle poll, tryQueued skips the
  // status/resume branch and runs `settings restart`, which answers not-running; the queue entry is dropped as
  // failed and the `pause --starts --drain` that Drain now made stays in the runtime's state, with no warning in the
  // outcome. Expected: the outcome at least names the pause the manager left (`minions resume --starts`), or the
  // restart stays queued until the runtime is back. Flip to `it` when fixed.
  it.fails('Drain now with the runtime stopped at the idle poll: the outcome says the pause it made was left in place', async () => {
    const { project } = await install();
    const w: World = { leases: 1, pausedStarts: false, running: true, restart: () => (!w.running ? 'not-running' : w.leases > 0 ? 'refused' : 'restarted') };
    const s = setup([project], w);
    await s.confirm(await s.cmds.propose(null, { kind: 'restart' }));
    await s.confirm(s.offers.find((o) => o.summary.startsWith('Drain now'))!);
    expect(w.pausedStarts).toBe(true);
    w.leases = 0;
    w.running = false;
    await s.manager.pollAll();
    const last = s.outcomes.at(-1)!;
    const resumed = s.delegateCalls.some((c) => c[1] === 'resume');
    const queued = s.manager.queuedRestarts().length === 1;
    expect(resumed || queued || /resume --starts/.test(last.text)).toBe(true);
  });
});

// ---------------------------------------------------------------- roll back

describe('QA: CLI roll back names only real backups', () => {
  const deps = { runtime: { running: async () => true, exec: async () => ok({}) }, upgrade: async () => ({ ok: true, steps: [], summary: '' }) };

  it('a backup name outside the pattern, with a path, or a symlink in the backup directory is refused', async () => {
    const { project } = await install();
    mkdirSync(B.cliBackupDir(), { recursive: true });
    const outside = join(tempDir('minions-outside-'), 'evil.tgz');
    writeFileSync(outside, 'evil');
    const link = 'minions-0.1.0-20261026T100000000Z.tgz';
    symlinkSync(outside, join(B.cliBackupDir(), link));
    expect(await B.findCliBackup(link)).toBeNull();
    for (const backup of ['../../evil.tgz', `../cli-backup/${link}`, 'minions-0.1.0.tgz', outside, 42, null, link]) {
      const e = await reason(CR.buildPlan(project, { id: 'ow_0000abcd', kind: 'cli-rollback', payload: { backup }, reason: null, origin: 'owner' }, deps));
      expect(e.message).toMatch(/no such CLI backup/);
    }
  });

  it('installCliBackup refuses a sha256 mismatch and a vanished backup without running npm', async () => {
    const src = tempDir('minions-install-');
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'minions', version: '0.1.0' }));
    const b = await B.backupInstalledCli(src, '0.1.0', {
      runner: async (_c, args) => { writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, 'minions-0.1.0.tgz'), 'tgz'); return { code: 0, stdout: '', stderr: '' }; },
    });
    const npm: string[][] = [];
    const runner = async (c: string, a: string[]) => { npm.push([c, ...a]); return { code: 0, stdout: '', stderr: '' }; };
    const e = await reason(B.installCliBackup(b.name, '0'.repeat(64), { runner }));
    expect(e.code).toBe('CONFLICT');
    expect(e.details?.refusal).toBe('backup');
    const g = await reason(B.installCliBackup('minions-9.9.9-20261026T100000000Z.tgz', '0'.repeat(64), { runner }));
    expect(g.message).toMatch(/is gone; nothing was installed/);
    expect(npm).toEqual([]);
  });

  it('a version that is not a safe name is stored as "unknown"', async () => {
    const src = tempDir('minions-install-');
    const b = await B.backupInstalledCli(src, '../../x', {
      runner: async (_c, args) => { writeFileSync(join(args[args.indexOf('--pack-destination') + 1]!, 'x.tgz'), 'tgz'); return { code: 0, stdout: '', stderr: '' }; },
    });
    expect(b.version).toBe('unknown');
    expect(b.file.startsWith(B.cliBackupDir())).toBe(true);
  });
});

// ---------------------------------------------------------------- dev-only /rebuild_cli

describe('QA: dev-only /rebuild_cli', () => {
  it('the first Confirm tap applies nothing; only "Confirm again" sends the confirm event', async () => {
    const { project, repo } = await install('minions-repo', { minions: true });
    const from = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'a');
    const w: World = { leases: 0, pausedStarts: false, running: true, restart: () => 'restarted' };
    const s = setup([project], w, { cli: { runningRoot: runningRoot(from) } });
    const chat = fakeChat(s.cmds);
    await chat.say('/rebuild_cli');
    const o = chat.offers[0]!;
    expect(o.loosens).toBeTruthy();
    expect(await chat.tap(`c:${o.requestId}:${o.nonce}`)).toEqual([]);
    expect(chat.sent.at(-1)).toMatch(/^Second confirmation for change request/);
    const events = await chat.tap(`d:${o.requestId}:${o.nonce}`);
    expect(events).toEqual([{ type: 'confirm', requestId: o.requestId, nonce: o.nonce }]);
    await s.manager.handle(events[0]!);
    expect(s.upgrades.filter((u) => !u.dryRun)).toEqual([{ fromContainer: null, dryRun: false, rebuildCli: true }]);
  });

  it('with the request available: arguments get the usage line, @bot suffix works, and underscore names never reach other commands', async () => {
    const { project, repo } = await install('minions-repo', { minions: true });
    const from = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'a');
    const s = setup([project], { leases: 0, pausedStarts: false, running: true, restart: () => 'restarted' }, { cli: { runningRoot: runningRoot(from) } });
    const chat = fakeChat(s.cmds);
    await chat.say('/rebuild_cli now');
    expect(chat.sent.at(-1)).toBe('Usage: /rebuild_cli (no arguments).');
    for (const text of ['/set_x a b', '/approve_ task-1 ' + 'a'.repeat(40), '/restart_', '/rebuild_cli_', '/rebuild__cli', '/upgrade_now', '/status_all', '/undo_cr_0a1b2c3d', '/REBUILD_CLI', '/_restart']) {
      const before = chat.sent.length;
      await chat.say(text);
      expect(chat.sent.slice(before), text).toEqual([T.helpText(true)]);
    }
    expect(chat.proposed).toEqual([]);
    await chat.say('/rebuild_cli@minions_manager_bot');
    expect(chat.proposed).toEqual([{ kind: 'rebuild-cli' }]);
  });

  it('parseOwnerCommand: rebuild_cli takes no arguments', () => {
    expect(T.parseOwnerCommand('rebuild_cli', '')).toEqual({ kind: 'rebuild-cli' });
    expect(T.parseOwnerCommand('rebuild_cli', 'x')).toBeNull();
    expect(T.parseOwnerCommand('rebuild-cli', '')).toBeNull();
  });

  it('a build commit that is not an ancestor of HEAD refuses the plan; nothing is journaled as applied', async () => {
    const { project } = await install('minions-repo', { minions: true });
    const s = setup([project], { leases: 0, pausedStarts: false, running: true, restart: () => 'restarted' }, { cli: { runningRoot: runningRoot('f'.repeat(40)) } });
    const e = await reason(s.cmds.propose(null, { kind: 'rebuild-cli' }));
    expect(e.message).toMatch(/is not an ancestor of HEAD/);
    expect(s.upgrades).toEqual([]);
  });

  it('a build.json commit that is not a full sha is treated as unknown', async () => {
    const { project, repo } = await install('minions-repo', { minions: true });
    const root = runningRoot(null);
    writeFileSync(join(root, 'dist', 'build.json'), JSON.stringify({ commit: git(repo, 'rev-parse', '--short', 'HEAD'), dirty: false }));
    const s = setup([project], { leases: 0, pausedStarts: false, running: true, restart: () => 'restarted' }, { cli: { runningRoot: root } });
    expect((await reason(s.cmds.propose(null, { kind: 'rebuild-cli' }))).message).toMatch(/records no build commit/);
  });

  it('the running root is a checkout but the project is a different (non-minions) repo with the same layout name: hidden', async () => {
    const plain = await install('minions');
    const s = setup([plain.project], { leases: 0, pausedStarts: false, running: true, restart: () => 'restarted' }, { cli: { runningRoot: runningRoot('a'.repeat(40)) } });
    expect(await s.cmds.devRebuild!(plain.project.projectId)).toBe(false);
    expect(await s.cmds.devRebuild!('no-such-project')).toBe(false);
  });
});
