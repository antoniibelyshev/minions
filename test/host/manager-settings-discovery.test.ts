// task-65.1: deterministic discovery in the manager chat. /settings [query] (value, source, takes effect, host-owned
// mark; filtered by group or key substring; cut to one message), the closest keys for an unknown /set key (also on
// the terminal through requireSetting), and a plain explanation for a /set whose value is already in effect (nothing
// journaled). Temp MINIONS_HOME, a real install, the real HostManager and Telegram transport against a fake Bot API.
// No network, no Docker, no child processes.
import { existsSync, readFileSync } from 'node:fs';
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
const { loadProjectJson, loadEffectiveConfig } = await import('../../src/host/project.js');
const J = await import('../../src/host/change-journal.js');
const M = await import('../../src/host/manager.js');
const T = await import('../../src/host/manager-telegram.js');
const S = await import('../../src/host/settings.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type ManagerCommands = import('../../src/host/manager.js').ManagerCommands;
type SettingView = import('../../src/host/settings.js').SettingView;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const journal = () => (existsSync(J.journalPath()) ? readFileSync(J.journalPath(), 'utf8').trim().split('\n').filter(Boolean) : []);
const ok = (data: unknown): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { code?: string; details?: any }; } throw new Error('expected a refusal'); };

async function install(name = 'repo') {
  const repo = makeRepo(env.root, name);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  return loadProjectJson(r.plan.projectId);
}

function manager(projects: ProjectJson[]) {
  const runs: string[][] = [];
  const deps: ManagerDeps = {
    transport: { sendOffer: async () => undefined, receive: async () => [], sendOutcome: async () => undefined },
    projects: async () => projects,
    loadProject: async (id) => { const p = projects.find((x) => x.projectId === id); if (!p) throw new Error(`no project ${id}`); return p; },
    running: async () => true,
    delegate: async (_p, argv) => (argv.includes('status') ? ok({ paused: { intake: false, starts: true } }) : ok({ requests: [] })),
    runChild: async (_p, argv) => { runs.push(argv); return { code: 1, stdout: '', stderr: 'unexpected' }; },
    upgrade: async () => ({ ok: true, steps: [], summary: '' }),
    now: () => new Date('2026-10-27T10:00:00Z'),
    sleep: async () => undefined,
    log: () => undefined,
  };
  const m = new M.HostManager(deps);
  return { m, cmds: m.commands(), runs };
}

// ---------------------------------------------------------------- the chat side

const OWNER = 4242;
const TOKEN = '555666777:MMHmanagermanagermanagermanager_-9876';
const ACCESS = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T00:00:00.000Z' };
const msg = (update_id: number, text: string): TelegramUpdate => ({ update_id, message: { message_id: 1000 + update_id, text, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' } } });

function chat(cmds: ManagerCommands, texts: string[]) {
  const sent: string[] = [];
  const batches = [texts.map((t, i) => msg(i + 1, t))];
  const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  let id = 100;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    if (method === 'sendMessage') { sent.push(String(body.text)); return res({ ok: true, result: { message_id: id++ } }); }
    if (method === 'getUpdates') return res({ ok: true, result: batches.shift() ?? [] });
    return res({ ok: true, result: true });
  }) as typeof fetch;
  const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: f, now: () => Date.parse('2026-10-27T10:00:00Z'), sleep: async () => undefined, lookupOffer: async () => null });
  t.attach(cmds);
  return { t, sent, run: () => t.receive(30_000) };
}

// ---------------------------------------------------------------- closest keys

describe('closest keys for an unknown setting', () => {
  it('a key that is part of a real key finds it first (pr.merge -> capabilities.pr.merge); typos by edit distance; nonsense finds nothing', () => {
    expect(S.closestSettingKeys('pr.merge')[0]).toBe('capabilities.pr.merge');
    expect(S.closestSettingKeys('merge')).toEqual(expect.arrayContaining(['delivery.merge', 'capabilities.pr.merge']));
    expect(S.closestSettingKeys('delivery.mod')[0]).toBe('delivery.mode');
    expect(S.closestSettingKeys('execution.maxActivTasks')).toEqual(['execution.maxActiveTasks']);
    expect(S.closestSettingKeys('maxActiveTask')).toEqual(['execution.maxActiveTasks']);
    expect(S.closestSettingKeys('DELIVERY.MODE')[0]).toBe('delivery.mode');
    expect(S.closestSettingKeys('zzz')).toEqual([]);
    expect(S.closestSettingKeys('')).toEqual([]);
    expect(S.closestSettingKeys('capabilities').length).toBe(3); // at most 3
  });

  it('requireSetting (the terminal `minions settings set` too) names them in the message and details; the CLI hint stays', () => {
    let err: (Error & { code?: string; hint?: string; details?: any }) | undefined;
    try { S.requireSetting('pr.merge'); } catch (e) { err = e as typeof err; }
    expect(err?.code).toBe('INVALID_CONFIG');
    expect(err?.message).toBe('Unknown setting: pr.merge. Did you mean: capabilities.pr.merge, delivery.merge?');
    expect(err?.hint).toContain('minions settings --list');
    expect(err?.details).toEqual({ path: 'pr.merge', suggestions: ['capabilities.pr.merge', 'delivery.merge'] });
    expect(() => S.requireSetting('zzz')).toThrow(/^Unknown setting: zzz$/);
  });
});

// ---------------------------------------------------------------- /settings formatting

const view = (o: Partial<SettingView>): SettingView => ({
  key: 'execution.maxActiveTasks', group: 'Concurrency', label: 'x', description: 'x', type: 'int', value: 3, source: 'profile default',
  apply: 'live', class: 'live', hostOwned: false, needsRegenerate: true, needsRestart: false, needsUpgrade: false, effect: 'x', canLoosen: false, ...o,
});
const P = { projectId: 'pid', name: 'acme' };

describe('formatSettingsList', () => {
  const all = [
    view({ key: 'delivery.mode', group: 'Delivery', type: 'enum', value: 'pull-request', source: 'shared config', hostOwned: true }),
    view({ key: 'delivery.merge', group: 'Delivery', type: 'enum', value: 'disabled', hostOwned: true }),
    view({ key: 'models.default', group: 'Models', type: 'model', value: 'opus', source: 'local override', apply: 'launch', class: 'restart', needsRestart: true }),
    view({ key: 'container.cpus', group: 'Container', type: 'number', value: 2, apply: 'recreate', class: 'recreate', needsUpgrade: true }),
    view({ key: 'secrets.github', group: 'Integrations', type: 'secret', value: 'provisioned', source: 'credential store', hostOwned: true }),
    view({ key: 'secrets.telegram', group: 'Integrations', type: 'secret', value: 'missing', source: 'credential store', hostOwned: true }),
  ];

  it('lists every setting with value, source, takes effect and the host-owned mark, grouped', () => {
    const text = T.formatSettingsList(P, all, '');
    expect(text).toContain('Settings of acme (all 6):');
    expect(text).toContain('\nDelivery\n  delivery.mode = pull-request (shared config; now) [host-owned]');
    expect(text).toContain('  models.default = opus (local override; restart)\n');
    expect(text).not.toMatch(/models\.default.*host-owned/);
    expect(text).toContain('  container.cpus = 2 (profile default; upgrade)');
    expect(text).toContain('  secrets.github = set (credential store; minions auth github) [host-owned]');
    expect(text).toContain('  secrets.telegram = unset (credential store; minions auth telegram) [host-owned]');
    expect(text).not.toContain('provisioned');
    expect(text).toContain('Change one with /set <key> <value> [shared].');
  });

  it('a group name (any case) or a key substring narrows the list', () => {
    const g = T.formatSettingsList(P, all, 'DELIVERY');
    expect(g).toContain('Settings of acme (2 of 6):');
    expect(g).toContain('delivery.merge = disabled');
    expect(g).not.toContain('models.default');
    const k = T.formatSettingsList(P, all, 'secrets.');
    expect(k).toContain('(2 of 6)');
    expect(k).toContain('secrets.github');
    expect(k).not.toContain('delivery.mode');
    const m = T.formatSettingsList(P, all, 'merge');
    expect(m).toContain('(1 of 6)');
  });

  it('no match: the closest keys and the groups', () => {
    const text = T.formatSettingsList(P, all, 'delivery.mod3');
    expect(text).toContain('No setting matches "delivery.mod3".');
    expect(text).toContain('Closest keys: delivery.mode');
    expect(text).toContain('Groups: delivery, verification,');
  });

  it('is cut below the limit with an "N more, narrow the query" tail', () => {
    const many = Array.from({ length: 200 }, (_, i) => view({ key: `execution.k${i}`, value: i }));
    const text = T.formatSettingsList(P, many, '', 1500);
    expect(text.length).toBeLessThanOrEqual(1500);
    const shown = text.split('\n').filter((l) => l.startsWith('  execution.k')).length;
    expect(shown).toBeGreaterThan(10);
    expect(text).toMatch(new RegExp(`… ${200 - shown} more, narrow the query: /settings <group or part of a key>\\.`));
    expect(text).not.toContain('Change one with');
    const full = T.formatSettingsList(P, many, '');
    expect(full.length).toBeLessThanOrEqual(T.MESSAGE_MAX_CHARS);
    expect(full).toContain('more, narrow the query');
  });

  it('a long or control-character value stays one bounded plain line', () => {
    const text = T.formatSettingsList(P, [view({ key: 'models.allowed', type: 'list', value: Array(100).fill('opus\u001b[2J') })], '');
    const line = text.split('\n').find((l) => l.includes('models.allowed'))!;
    expect(line).not.toContain('\u001b');
    expect(line.length).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------- the manager core and the chat

describe('/settings in the manager chat', () => {
  it('lists the real settings of the only project, read-only; secrets show only set / unset; the help text lists /settings', async () => {
    const project = await install();
    const { cmds, runs } = manager([project]);
    const r = await cmds.settings!(null);
    expect(r.projectId).toBe(project.projectId);
    expect(r.settings.map((v) => v.key)).toEqual(expect.arrayContaining(['delivery.mode', 'capabilities.pr.merge', 'secrets.github']));
    const c = chat(cmds, ['/settings', '/settings delivery', '/settings pr.merge', '/help']);
    await c.run();
    const mode = (await loadEffectiveConfig(project)).config.delivery.mode;
    expect(c.sent[0]).toContain('Settings of repo (');
    expect(c.sent[0]!.length).toBeLessThanOrEqual(T.MESSAGE_MAX_CHARS);
    expect(c.sent[1]).toMatch(new RegExp(`delivery\\.mode = ${mode} \\([a-z ]+; restart\\) \\[host-owned\\]`));
    expect(c.sent[1]).not.toContain('models.default');
    expect(c.sent[2]).toContain('capabilities.pr.merge = ');
    expect(c.sent[2]).toContain('[host-owned]');
    expect(c.sent.join('\n')).not.toMatch(/secrets\.\w+ = (?!set|unset)/);
    expect(c.sent[3]).toBe(T.HELP_TEXT);
    expect(T.HELP_TEXT).toContain('/settings [query]');
    expect(journal()).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('pause flags come from the runtime when it answers', async () => {
    const project = await install();
    const { cmds } = manager([project]);
    const r = await cmds.settings!(null);
    expect(r.settings.find((v) => v.key === 'pause.starts')?.value).toBe('paused');
    expect(r.settings.find((v) => v.key === 'pause.intake')?.value).toBe('running');
  });

  it('with several projects and none picked it asks for /project', async () => {
    const a = await install('a');
    const b = await install('b');
    const { cmds } = manager([a, b]);
    const c = chat(cmds, ['/settings']);
    await c.run();
    expect(c.sent[0]).toBe('/settings failed: 2 projects are registered: pick one with /project <name> first.');
  });

  it('a transport attached to commands without settings says it is not available', async () => {
    const c = chat({ projects: async () => [], status: async () => '', pending: async () => [], propose: async () => { throw new Error('x'); } }, ['/settings']);
    await c.run();
    expect(c.sent[0]).toBe('/settings is not available in this host manager.');
  });
});

describe('/set: unknown keys and values already in effect', () => {
  it('an unknown key names the closest keys; nothing is journaled', async () => {
    const project = await install();
    const { cmds } = manager([project]);
    const c = chat(cmds, ['/set pr.merge allow']);
    await c.run();
    expect(c.sent[0]).toContain('/set failed: Unknown setting: pr.merge. Did you mean: capabilities.pr.merge');
    expect(journal()).toEqual([]);
  });

  it('a value already in effect is explained (value, source, other choices), not a failure, and no request is created', async () => {
    const project = await install();
    const { cmds, runs } = manager([project]);
    const cfg = (await loadEffectiveConfig(project)).config;
    const mode = cfg.delivery.mode;
    const def = S.settingDef('delivery.mode')!;
    const source = (await S.listSettings(await S.loadSettingsContext(project))).find((v) => v.key === 'delivery.mode')!.source;
    const c = chat(cmds, [`/set delivery.mode ${mode}`, `/set execution.maxActiveTasks ${cfg.execution.maxActiveTasks}`]);
    await c.run();
    expect(c.sent[0]).not.toContain('failed');
    expect(c.sent[0]).toContain(`delivery.mode is already ${mode} (${source}); nothing to change.`);
    const others = def.choices!.filter((x) => x !== mode);
    expect(c.sent[0]).toContain(`Other choices: ${others.join(', ')}.`);
    expect(c.sent[0]).toContain('/settings delivery.mode');
    expect(c.sent[1]).toContain(`execution.maxActiveTasks is already ${cfg.execution.maxActiveTasks} (`);
    expect(c.sent[1]).not.toContain('Other choices');
    expect(journal()).toEqual([]);
    expect(runs).toEqual([]);
    // The core throws a ManagerNotice (still mentions "already"), before minting a request.
    const e = await reason(cmds.propose(null, { kind: 'config-set', key: 'delivery.mode', value: mode, layer: 'local' }));
    expect(e).toBeInstanceOf(M.ManagerNotice);
    expect(journal()).toEqual([]);
  });

  it('a bool already in effect offers the opposite; a real change still becomes an offer to confirm', async () => {
    const project = await install();
    const { cmds } = manager([project]);
    const cur = (await S.listSettings(await S.loadSettingsContext(project))).find((v) => v.key === 'verification.reviewerRequired')!;
    const e = await reason(cmds.propose(null, { kind: 'config-set', key: 'verification.reviewerRequired', value: String(cur.value), layer: 'local' }));
    expect(e.message).toContain(`Other choices: ${String(cur.value !== true)}.`);
    const o = await cmds.propose(null, { kind: 'config-set', key: 'verification.reviewerRequired', value: String(cur.value !== true), layer: 'local' });
    expect(o.requestId).toMatch(J.OWNER_REQUEST_ID_PATTERN);
    expect(journal()).toHaveLength(1);
  });

  it('an invalid value keeps its usual error (the no-op check leaves errors to the plan)', async () => {
    const project = await install();
    const { cmds } = manager([project]);
    const e = await reason(cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: 'lots', layer: 'local' }));
    expect(e).not.toBeInstanceOf(M.ManagerNotice);
    expect(e.message).toMatch(/whole number/);
  });

  it('unchangedSettingText lists the enum choices other than the current one, and default for an optional key', () => {
    expect(M.unchangedSettingText(view({ key: 'models.effort', type: 'enum', choices: ['low', 'high'], optional: true, value: 'low', source: 'local override' })))
      .toBe('models.effort is already low (local override); nothing to change.\nOther choices: high, default.\nSend /settings models.effort for how a change takes effect.');
  });
});
