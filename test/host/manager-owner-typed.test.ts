// task-78: an owner change command typed in the paired manager chat applies without a Confirm tap when its plan
// loosens nothing and builds or installs no CLI on the host; loosening and code-execution plans keep the offer and the
// double tap, container requests always need Confirm, and a redelivered Telegram update never applies twice. Temp
// MINIONS_HOME, the real Telegram transport against a fake Bot API (it is also the manager's transport, so the
// outcome messages land in the same chat), a fake child runner (the config write runs the real host path in-process)
// and a fake upgrade. No network, no Docker, no child processes.
import { existsSync, readFileSync } from 'node:fs';
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
const M = await import('../../src/host/manager.js');
const T = await import('../../src/host/manager-telegram.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type ManagerOutcome = import('../../src/host/manager.js').ManagerOutcome;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;
type ChangePlan = import('../../src/host/change-requests.js').ChangePlan;
type RequestSnapshot = import('../../src/host/change-journal.js').RequestSnapshot;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
const journal = () => (existsSync(J.journalPath()) ? readFileSync(J.journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>) : []);
const ok = (data: unknown, code = 0): RunResult => ({ code, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
const fail = (e: Error & { code?: string }): RunResult => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } }) + '\n', stderr: '' });

const OWNER = 4242;
const TOKEN = '555666777:MMHmanagermanagermanagermanager_-9876';
const ACCESS = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T00:00:00.000Z' };
const msg = (update_id: number, text: string, o: { messageId?: number | null; forwarded?: boolean } = {}): TelegramUpdate => ({
  update_id,
  message: {
    ...(o.messageId === null ? {} : { message_id: o.messageId ?? 1000 + update_id }), text, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' },
    ...(o.forwarded ? { forward_date: 1_700_000_000 } : {}),
  },
});
const tap = (update_id: number, data: string): TelegramUpdate => ({ update_id, callback_query: { id: `cb${update_id}`, data, from: { id: OWNER }, message: { message_id: 50, chat: { id: OWNER, type: 'private' } } } });

async function install(name = 'repo') {
  const repo = makeRepo(env.root, name);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  return { project, repo, local: projectPaths(project.projectId).configLocalJson };
}

/** The fake Bot API. getUpdates answers the queued batches whatever the offset (a redelivery is just a batch again). */
function botApi() {
  const batches: TelegramUpdate[][] = [];
  const calls: { method: string; body: Record<string, any> }[] = [];
  let nextId = 100;
  const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    calls.push({ method, body });
    if (method === 'sendMessage') return res({ ok: true, result: { message_id: nextId++ } });
    if (method === 'getUpdates') return res({ ok: true, result: batches.shift() ?? [] });
    return res({ ok: true, result: true });
  }) as typeof fetch;
  const sent = () => calls.filter((c) => c.method === 'sendMessage');
  return { f, calls, sent, texts: () => sent().map((c) => String(c.body.text)), keyboards: () => sent().filter((c) => c.body.reply_markup), push: (b: TelegramUpdate[]) => { batches.push(b); } };
}

interface World { restart: 'restarted' | 'refused' }

function setup(projects: ProjectJson[], w: World = { restart: 'restarted' }) {
  const now = new Date('2026-10-26T10:00:00Z');
  const outcomes: ManagerOutcome[] = [];
  const delegateCalls: string[][] = [];
  const runs: string[][] = [];
  const upgrades: { fromContainer: unknown; dryRun: boolean; syncOnly?: boolean; rebuildCli?: boolean }[] = [];
  let rows: unknown[] = [];
  const api = botApi();
  const makeTransport = () => T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => now.getTime(), sleep: async () => undefined, lookupOffer: async () => null });
  const t = makeTransport();
  const transport = {
    sendOffer: (o: Parameters<typeof t.sendOffer>[0]) => t.sendOffer(o),
    receive: (ms: number, s?: AbortSignal) => t.receive(ms, s),
    sendOutcome: async (o: ManagerOutcome) => { outcomes.push(o); await t.sendOutcome(o); },
  };
  const deps: ManagerDeps = {
    transport,
    projects: async () => projects,
    loadProject: async (id) => { const p = projects.find((x) => x.projectId === id); if (!p) throw new Error(`no project ${id}`); return p; },
    running: async () => true,
    delegate: async (_p, argv) => {
      delegateCalls.push(argv);
      return argv[1] === 'settings' && argv[2] === 'requests' && !argv.includes('mark') ? ok({ requests: rows }) : ok({});
    },
    runChild: async (p, argv) => {
      runs.push(argv);
      try {
        if (argv[0] === 'settings' && argv[1] === 'set') {
          const [, , key, value, ...flags] = argv;
          const ctx = await S.loadSettingsContext(p);
          return ok(await SC.applySetting(ctx, key!, value!, { layer: flags.includes('--shared') ? 'shared' : 'local', yes: flags.includes('--yes'), restart: false, expectRevision: Number(flags[flags.indexOf('--expect-revision') + 1]) },
            { runtime: { running: async () => false, exec: async () => ok({}) }, confirm: async () => null }));
        }
        if (argv[0] === 'settings' && argv[1] === 'restart') return ok({ action: w.restart, detail: w.restart === 'refused' ? '1 worker lease active' : 'recover' }, w.restart === 'refused' ? 1 : 0);
      } catch (e) { return fail(e as Error); }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    upgrade: async (_p, x) => {
      upgrades.push(x);
      if (x.syncOnly) return { ok: true, steps: [{ id: 'sync', status: x.dryRun ? 'planned' : 'done', detail: x.dryRun ? 'fast-forward main aaa -> bbb' : 'fast-forwarded main aaa -> bbb' }], summary: x.dryRun ? '1 steps planned' : 'complete' };
      return { ok: true, steps: [{ id: 'recreate', status: x.dryRun ? 'planned' : 'done', detail: 'recreate the container' }], summary: x.dryRun ? '1 steps planned' : 'complete' };
    },
    now: () => now,
    sleep: async () => undefined,
    log: () => undefined,
  };
  const manager = new M.HostManager(deps);
  t.attach(manager.commands());
  let nextUpdate = 1;
  /** The owner types `text` (a fresh update and message id unless given); returns the events the transport hands the core. */
  const say = async (text: string, o: { update?: number; messageId?: number | null; forwarded?: boolean } = {}) => {
    api.push([msg(o.update ?? nextUpdate++, text, o)]);
    return t.receive(30_000);
  };
  return { deps, manager, t, makeTransport, api, outcomes, delegateCalls, runs, upgrades, say, setRows: (r: unknown[]) => { rows = r; } };
}

const typedOffers = () => journal().filter((e) => e.type === 'offer');

// ---------------------------------------------------------------- direct apply

describe('owner-typed safe commands apply without a Confirm tap', () => {
  it('/restart applies right away: no offer or buttons, the applying and outcome messages arrive, journaled as typed and direct', async () => {
    const { project } = await install();
    const s = setup([project]);
    expect(await s.say('/restart', { update: 7 })).toEqual([]);
    expect(s.runs).toEqual([['settings', 'restart']]);
    expect(s.api.keyboards()).toEqual([]);
    const texts = s.api.texts();
    expect(texts[0]).toMatch(/^Applying your request ow_[0-9a-f]{8} \(project [^)]+\): restart the coordinator… \(typed by you and it loosens nothing, so no Confirm is needed; digest [0-9a-f]{12}\)$/);
    expect(texts[1]).toMatch(/^change request ow_[0-9a-f]{8} \(project [^)]+\): applied - coordinator restart: restarted/);
    expect(texts).toHaveLength(2);
    for (const c of s.api.sent()) expect(c.body.parse_mode).toBeUndefined();
    const j = journal();
    expect(j.map((e) => e.type)).toEqual(['offer', 'confirmed', 'applying', 'applied']);
    expect(j[0]).toMatchObject({ typed: `telegram:${ACCESS.botId}:${OWNER}:1007`, direct: true, request: { origin: 'owner', kind: 'restart' }, plan: { origin: 'owner', loosens: null } });
    expect(j[1]).toMatchObject({ type: 'confirmed', nonce: j[0]!.nonce, digest: j[0]!.digest, detail: 'typed by the owner', pid: process.pid });
    expect(j[3]).toMatchObject({ type: 'applied', digest: j[0]!.digest });
    // The nonce was spent as it was minted: a tap naming it (a forged button) is already handled, nothing runs again.
    await s.manager.handle({ type: 'confirm', requestId: j[0]!.requestId, nonce: j[0]!.nonce });
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.runs).toHaveLength(1);
    // No pending offer is left behind for /requests.
    expect(await s.manager.pendingOffers(null)).toEqual([]);
  });

  it('/restart still refuses while workers are active; then Restart when idle and Drain now are offered with buttons (each needs a tap)', async () => {
    const { project } = await install();
    const s = setup([project], { restart: 'refused' });
    await s.say('/restart');
    expect(s.runs).toEqual([['settings', 'restart']]);
    expect(s.outcomes.map((o) => o.status)).toEqual(['applying', 'failed']);
    expect(s.outcomes[1]!.text).toMatch(/FAILED - coordinator restart: refused/);
    expect(s.outcomes[1]!.text).toMatch(/Two plans follow: "Restart when idle"/);
    const kb = s.api.keyboards();
    expect(kb.map((c) => String(c.body.text).split('\n')[0])).toEqual([
      expect.stringMatching(/Restart when idle/), expect.stringMatching(/Drain now/),
    ]);
    expect(s.manager.queuedRestarts()).toEqual([]); // offered, not queued
    expect(journal().filter((e) => e.type === 'offer').map((e) => !!e.direct)).toEqual([true, false, false]);
  });

  it('a neutral /set and a tightening /set apply right away through the child, with --expect-revision; /undo of one applies right away too', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    await s.say('/set communication.progress quiet');
    expect(s.runs[0]).toEqual(['settings', 'set', 'communication.progress', 'quiet', '--yes', '--no-restart', '--expect-revision', expect.stringMatching(/^\d+$/)]);
    expect(readJson(local).communication.progress).toBe('quiet');
    expect(s.outcomes.map((o) => o.status)).toEqual(['applying', 'applied']);
    const setId = s.outcomes[1]!.requestId!;

    // The undo of the neutral change loosens nothing either: applied, the file is restored.
    await s.say(`/undo ${setId}`);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', text: expect.stringMatching(new RegExp(`undid ${setId}: communication.progress: quiet -> milestones`)) });
    expect(existsSync(local) ? readJson(local).communication?.progress : undefined).toBeUndefined();

    // Tightening: fewer engineers at once (an increase would loosen spend).
    expect((await loadEffectiveConfig(project)).config.execution.maxEngineers).toBe(2);
    await s.say('/set execution.maxEngineers 1');
    expect(readJson(local).execution.maxEngineers).toBe(1);
    expect(s.outcomes.at(-1)!.status).toBe('applied');
    expect(s.runs).toHaveLength(2);
    expect(s.api.keyboards()).toEqual([]);
    expect(typedOffers().every((e) => e.direct === true && J.TYPED_KEY_PATTERN.test(e.typed))).toBe(true);
  });

  it('/sync and /upgrade apply right away after one dry run; the upgrade never asks for --rebuild-cli or --from-container', async () => {
    const { project } = await install();
    const s = setup([project]);
    await s.say('/sync');
    expect(s.upgrades).toEqual([{ fromContainer: null, dryRun: true, syncOnly: true }, { fromContainer: null, dryRun: false, syncOnly: true }]);
    expect(s.outcomes.map((o) => o.status)).toEqual(['applying', 'applied']);
    await s.say('/upgrade');
    expect(s.upgrades.slice(2)).toEqual([{ fromContainer: null, dryRun: true }, { fromContainer: null, dryRun: false }]);
    expect(s.outcomes.slice(2).map((o) => o.status)).toEqual(['applying', 'applied']);
    expect(s.outcomes.at(-1)!.text).toMatch(/applied - upgrade: complete/);
    const texts = s.api.texts();
    expect(texts.filter((x) => x.startsWith('Planning /'))).toEqual(['Planning /sync (a dry run on the host)…', 'Planning /upgrade (a dry run on the host)…']);
    expect(s.api.keyboards()).toEqual([]);
  });
});

// ---------------------------------------------------------------- kept confirmation

describe('loosening and code-execution plans keep the offer and the double tap', () => {
  it('a loosening /set is only offered (typed key journaled, not confirmed); the first tap asks again and only the second applies', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    // The reviewer must be required first, so turning it off loosens (a tightening /set applies right away).
    const before = (await loadEffectiveConfig(project)).config.verification.reviewerRequired;
    if (!before) {
      await s.say('/set verification.reviewerRequired true');
      expect(readJson(local).verification.reviewerRequired).toBe(true);
    }
    const runsBefore = s.runs.length;
    expect(await s.say('/set verification.reviewerRequired false')).toEqual([]);
    expect(s.runs).toHaveLength(runsBefore);
    const shown = s.api.keyboards().at(-1)!;
    expect(String(shown.body.text)).toMatch(/^Your request ow_[0-9a-f]{8} .*Confirm asks a second time/s);
    expect(String(shown.body.text)).toContain('this plan waits for your Confirm');
    const offer = typedOffers().at(-1)!;
    expect(offer.direct).toBeUndefined();
    expect(offer.typed).toMatch(J.TYPED_KEY_PATTERN);
    expect(journal().at(-1)).toMatchObject({ type: 'offer' }); // no confirmed entry
    const first = shown.body.reply_markup.inline_keyboard[0][0].callback_data;
    s.api.push([tap(900, first)]);
    expect(await s.t.receive(30_000)).toEqual([]);
    const again = s.api.keyboards().at(-1)!;
    expect(String(again.body.text)).toMatch(/^Second confirmation for change request ow_/);
    s.api.push([tap(901, again.body.reply_markup.inline_keyboard[0][0].callback_data)]);
    const events = await s.t.receive(30_000);
    expect(events).toHaveLength(1);
    await s.manager.handle(events[0]!);
    expect(readJson(local).verification.reviewerRequired).toBe(false);
    expect(s.outcomes.at(-1)!.status).toBe('applied');
  });

  it('a loosening /undo is only offered', async () => {
    const { project, local } = await install();
    const s = setup([project]);
    expect((await loadEffectiveConfig(project)).config.execution.maxEngineers).toBe(2);
    await s.say('/set execution.maxEngineers 1'); // tightening: applied at once
    const setId = s.outcomes.at(-1)!.requestId!;
    expect(readJson(local).execution.maxEngineers).toBe(1);
    const runs = s.runs.length;
    const n = s.outcomes.length;
    await s.say(`/undo ${setId}`); // back to 2: more engineers at once loosens spend
    expect(s.outcomes.length).toBe(n);
    expect(s.runs.length).toBe(runs);
    expect(String(s.api.keyboards().at(-1)!.body.text)).toMatch(/^Your request ow_[0-9a-f]{8} .*: undo .*LOOSENS POLICY/s);
    expect(readJson(local).execution.maxEngineers).toBe(1);
    expect(journal().at(-1)).toMatchObject({ type: 'offer', typed: expect.stringMatching(J.TYPED_KEY_PATTERN) });
    expect(journal().at(-1)!.direct).toBeUndefined();
  });

  it('/approve is only offered (it always loosens), and nothing is signed', async () => {
    const { project } = await install();
    const s = setup([project]);
    const approve = vi.fn(async () => 0);
    const m = new M.HostManager({ ...s.deps, approveOnHost: approve });
    const r = await m.submit(null, { kind: 'approve', taskId: 'task-12', head: 'a'.repeat(40), merge: false }, { key: `telegram:${ACCESS.botId}:${OWNER}:5` });
    expect(r.status).toBe('offered');
    expect(r.status === 'offered' && r.offer.loosens).toMatch(/signs a publication approval/);
    expect(approve).not.toHaveBeenCalled();
    expect(journal().map((e) => e.type)).toEqual(['offer']);
  });

  it('appliesWithoutConfirm: only owner plans of the allowed kinds that loosen nothing and build no CLI', () => {
    const owner = (kind: string, payload: Record<string, unknown> = {}): RequestSnapshot => ({ id: 'ow_0a1b2c3d', kind, payload, reason: null, origin: 'owner' });
    const plan = (kind: string, over: Partial<ChangePlan> = {}): ChangePlan => ({
      requestId: 'ow_0a1b2c3d', projectId: 'p', kind: kind as ChangePlan['kind'], origin: 'owner', configRevision: 1, reason: '', change: null, loosens: null, interrupts: null, steps: [], upgradeSteps: null, ...over,
    });
    for (const k of ['config-set', 'restart', 'sync', 'undo', 'upgrade']) expect(CR.appliesWithoutConfirm(plan(k), owner(k)), k).toBe(true);
    // Loosening, or a kind that signs, builds or installs: never.
    expect(CR.appliesWithoutConfirm(plan('config-set', { loosens: 'x' }), owner('config-set'))).toBe(false);
    expect(CR.appliesWithoutConfirm(plan('undo', { loosens: 'x' }), owner('undo'))).toBe(false);
    for (const k of ['approve', 'rebuild-cli', 'cli-rollback', 'something-new']) expect(CR.appliesWithoutConfirm(plan(k), owner(k)), k).toBe(false);
    // A queued restart mode is a follow-up offer; an upgrade from the container is not a plain upgrade.
    expect(CR.appliesWithoutConfirm(plan('restart', { restart: { mode: 'when-idle' } }), owner('restart', { mode: 'when-idle' }))).toBe(false);
    expect(CR.appliesWithoutConfirm(plan('upgrade'), owner('upgrade', { fromContainer: true }))).toBe(false);
    // Container requests, and anything that only claims the owner origin: never.
    expect(CR.appliesWithoutConfirm(plan('restart', { requestId: 'cr_0a1b2c3d', origin: undefined }), { id: 'cr_0a1b2c3d', kind: 'restart', payload: {}, reason: null })).toBe(false);
    expect(CR.appliesWithoutConfirm(plan('restart', { requestId: 'cr_0a1b2c3d' }), { id: 'cr_0a1b2c3d', kind: 'restart', payload: {}, reason: null, origin: 'owner' })).toBe(false);
    expect(CR.appliesWithoutConfirm(plan('restart', { origin: undefined }), owner('restart'))).toBe(false);
    expect(CR.appliesWithoutConfirm(plan('restart', { requestId: 'ow_ffffffff' }), owner('restart'))).toBe(false);
    expect(CR.appliesWithoutConfirm(plan('restart'), owner('upgrade'))).toBe(false);
    expect(CR.appliesWithoutConfirm(plan('restart', { loosens: undefined as unknown as null }), owner('restart'))).toBe(false);
  });
});

// ---------------------------------------------------------------- container requests

describe('container requests always need the owner\'s Confirm', () => {
  it('a container restart request is offered with buttons and applies only after the tap', async () => {
    const { project } = await install();
    const s = setup([project]);
    s.setRows([{ id: 'cr_0a1b2c3d', kind: 'restart', payload: {}, status: 'proposed', reason: 'pick up the new prompt', createdAt: '2026-10-26T09:00:00Z' }]);
    const sent = await s.manager.pollProject(project);
    expect(sent).toHaveLength(1);
    expect(s.runs).toEqual([]);
    const kb = s.api.keyboards();
    expect(String(kb[0]!.body.text)).toMatch(/^Change request cr_0a1b2c3d/);
    expect(journal().map((e) => e.type)).toEqual(['offer']);
    expect(journal()[0]!.typed).toBeUndefined();
    s.api.push([tap(50, kb[0]!.body.reply_markup.inline_keyboard[0][0].callback_data)]);
    const events = await s.t.receive(30_000);
    await s.manager.handle(events[0]!);
    expect(s.runs).toEqual([['settings', 'restart']]);
  });

  it('a confirmed-on-record offer is refused for anything but an owner-typed request', async () => {
    const base = { projectId: 'p', plan: {}, digest: 'd'.repeat(64), configRevision: 1 };
    await expect(J.recordOffer({ ...base, request: { id: 'cr_0a1b2c3d', kind: 'restart', payload: {}, reason: null }, typed: 'telegram:1:2:3', confirmed: true })).rejects.toThrow(/only an owner-typed request/);
    await expect(J.recordOffer({ ...base, request: { id: 'ow_0a1b2c3d', kind: 'restart', payload: {}, reason: null, origin: 'owner' }, confirmed: true })).rejects.toThrow(/only an owner-typed request/);
    await expect(J.recordOffer({ ...base, request: { id: 'ow_0a1b2c3d', kind: 'restart', payload: {}, reason: null, origin: 'owner' }, typed: '../x', confirmed: true })).rejects.toThrow(/malformed owner message key/);
    expect(journal()).toEqual([]);
  });
});

// ---------------------------------------------------------------- replay

describe('a redelivered update never applies twice', () => {
  it('the same update redelivered (to this transport, or to a fresh one after a restart without the saved offset) is already handled', async () => {
    const { project } = await install();
    const s = setup([project]);
    await s.say('/restart', { update: 40 });
    expect(s.runs).toHaveLength(1);
    // Telegram hands the same update out again (the Bot API fake ignores the offset).
    await s.say('/restart', { update: 40 });
    expect(s.runs).toHaveLength(1);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'already-handled', text: expect.stringMatching(/already handled as ow_[0-9a-f]{8} \(a redelivered update\); nothing was done again/) });
    // A fresh transport (the manager restarted and the offset file was lost) gets it once more: still nothing.
    const t2 = s.makeTransport();
    t2.attach(s.manager.commands());
    s.api.push([msg(40, '/restart')]);
    await t2.receive(30_000);
    expect(s.runs).toHaveLength(1);
    expect(typedOffers()).toHaveLength(1);
    expect(journal().filter((e) => e.type === 'applied')).toHaveLength(1);
    // A new message with the same text is a new command.
    await s.say('/restart', { update: 41 });
    expect(s.runs).toHaveLength(2);
  });

  it('a redelivered offered command is not offered again either', async () => {
    const { project } = await install();
    const s = setup([project]);
    const r1 = await s.manager.submit(null, { kind: 'approve', taskId: 'task-1', head: 'b'.repeat(40), merge: false }, { key: 'telegram:555666777:4242:77' });
    const r2 = await s.manager.submit(null, { kind: 'approve', taskId: 'task-1', head: 'b'.repeat(40), merge: false }, { key: 'telegram:555666777:4242:77' });
    expect(r1.status).toBe('offered');
    expect(r2).toEqual({ status: 'already-handled', requestId: r1.status === 'offered' ? r1.offer.requestId : '' });
    expect(typedOffers()).toHaveLength(1);
  });

  it('two submits of one message racing: the journal lock lets exactly one record and apply', async () => {
    const { project } = await install();
    const s = setup([project]);
    const key = { key: 'telegram:555666777:4242:99' };
    const rs = await Promise.all([s.manager.submit(null, { kind: 'restart' }, key), s.manager.submit(null, { kind: 'restart' }, key)]);
    expect(rs.map((r) => r.status).sort()).toEqual(['already-handled', 'applied']);
    expect(s.runs).toEqual([['settings', 'restart']]);
    expect(typedOffers()).toHaveLength(1);
  });

  it('a forwarded /restart is ignored; a message without a message id is only offered (no key, no direct apply)', async () => {
    const { project } = await install();
    const s = setup([project]);
    const submit = vi.spyOn(s.manager, 'submit');
    await s.say('/restart', { forwarded: true });
    expect(s.api.texts()).toEqual([]);
    expect(journal()).toEqual([]);
    await s.say('/restart', { messageId: null });
    expect(s.runs).toEqual([]);
    expect(String(s.api.keyboards().at(-1)!.body.text)).toMatch(/^Your request ow_[0-9a-f]{8} .*restart the coordinator/s);
    expect(typedOffers()).toEqual([expect.not.objectContaining({ typed: expect.anything() })]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('a startup after a crash between the confirmed entry and the outcome reports it as interrupted and never resumes it', async () => {
    const { project } = await install();
    const s = setup([project]);
    const req: RequestSnapshot = { id: 'ow_0a1b2c3d', kind: 'restart', payload: {}, reason: null, origin: 'owner' };
    const { plan } = await CR.buildPlan(project, req, { runtime: s.manager.runtime, upgrade: s.deps.upgrade });
    await J.recordOffer({ projectId: project.projectId, request: req, plan, digest: CR.planDigest(plan), configRevision: plan.configRevision, typed: 'telegram:555666777:4242:12', confirmed: true });
    const m = new M.HostManager({ ...s.deps, writerAlive: () => false });
    const found = await m.startup();
    expect(found.map((e) => [e.type, e.requestId])).toEqual([['confirmed', 'ow_0a1b2c3d']]);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'interrupted', requestId: 'ow_0a1b2c3d' });
    expect(s.runs).toEqual([]);
  });
});
