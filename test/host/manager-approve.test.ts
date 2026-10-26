// task-53.5.4: /approve <task> <sha> [merge] in the manager chat. An owner request of kind approve, bound to the exact
// full head SHA; its plan always loosens (the chat asks twice) and only the confirmed plan runs approveOnHost (the host
// key signs, the runtime's `work approve --signature` records). Temp MINIONS_HOME, a fake delegate (the runtime), a
// stubbed or real approveOnHost, and the real Telegram transport against a fake Bot API. No network, no Docker.
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
const { loadProjectJson } = await import('../../src/host/project.js');
const A = await import('../../src/host/approvals.js');
const AP = await import('../../src/core/approval.js');
const CR = await import('../../src/host/change-requests.js');
const J = await import('../../src/host/change-journal.js');
const M = await import('../../src/host/manager.js');
const T = await import('../../src/host/manager-telegram.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type ManagerOffer = import('../../src/host/manager.js').ManagerOffer;
type ManagerOutcome = import('../../src/host/manager.js').ManagerOutcome;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const journal = () => (existsSync(J.journalPath()) ? readFileSync(J.journalPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>) : []);
const ok = (data: unknown, code = 0): RunResult => ({ code, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
const refused = (code: string, message: string): RunResult => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }) + '\n', stderr: '' });
const reason = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error & { code?: string; details?: any }; } throw new Error('expected a refusal'); };

async function install(name = 'repo') {
  const repo = makeRepo(env.root, name);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  return { project: await loadProjectJson(r.plan.projectId), repo };
}

/**
 * The fake runtime: `work approve` answers like the scheduler (CONFLICT when the head is not the one awaiting, else
 * recorded). `awaiting` is the head the task waits on.
 */
function setup(projects: ProjectJson[], o: { awaiting?: string; realApprove?: boolean } = {}) {
  let now = new Date('2026-10-26T10:00:00Z');
  const outcomes: ManagerOutcome[] = [];
  const offers: ManagerOffer[] = [];
  const delegateCalls: string[][] = [];
  const logs: string[] = [];
  const approveCalls: { taskId: string; o: Record<string, unknown>; deps: Record<string, unknown> }[] = [];
  const awaiting = o.awaiting ?? HEAD;
  const deps: ManagerDeps = {
    transport: { sendOffer: async (x) => { offers.push(x); }, receive: async () => [], sendOutcome: async (x) => { outcomes.push(x); } },
    projects: async () => projects,
    loadProject: async (id) => { const p = projects.find((x) => x.projectId === id); if (!p) throw new Error(`no project ${id}`); return p; },
    running: async () => true,
    delegate: async (_p, argv) => {
      delegateCalls.push(argv);
      if (argv[1] === 'work' && argv[2] === 'approve') {
        const head = argv[argv.indexOf('--head') + 1];
        if (head !== awaiting) return refused('CONFLICT', `--head ${head} is not the head awaiting publication (${awaiting}).`);
        return ok({ taskId: argv[3], headSha: head, approvalId: 1, message: `Recorded host-signed approval to publish agent/x at ${head}.` });
      }
      return ok({ requests: [] });
    },
    runChild: async () => { throw new Error('an approval never runs a child command'); },
    upgrade: async () => { throw new Error('no upgrade'); },
    now: () => now,
    sleep: async (ms) => { now = new Date(now.getTime() + ms); },
    log: (l) => { logs.push(l); },
    approveOnHost: async (taskId, ao, ad) => {
      approveCalls.push({ taskId, o: { ...ao }, deps: { ...ad } as Record<string, unknown> });
      if (o.realApprove) return A.approveOnHost(taskId, ao, { ...ad, inContainer: false });
      // The stub signs nothing; it forwards a fake token the way approveOnHost does.
      return ad!.delegate!(['work', 'approve', taskId, '--head', ao.head, '--by', 'owner', ...(ao.merge ? ['--merge'] : []), '--signature', 'FAKE-TOKEN-SECRET'], { json: true, cwd: ao.cwd });
    },
  };
  const manager = new M.HostManager(deps);
  const cmds = manager.commands();
  const confirm = (x: ManagerOffer) => manager.handle({ type: 'confirm', requestId: x.requestId, nonce: x.nonce });
  const reject = (x: ManagerOffer) => manager.handle({ type: 'reject', requestId: x.requestId, nonce: x.nonce });
  return { deps, manager, cmds, outcomes, offers, delegateCalls, logs, approveCalls, confirm, reject };
}

describe('/approve: parsing', () => {
  it('parses a task id and a full 40-hex lowercase head, with the optional merge keyword', () => {
    expect(T.parseOwnerCommand('approve', `task-12 ${HEAD}`)).toEqual({ kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    expect(T.parseOwnerCommand('approve', `task-53.5.4 ${HEAD} merge`)).toEqual({ kind: 'approve', taskId: 'task-53.5.4', head: HEAD, merge: true });
  });

  it('refuses short, long, uppercase or non-hex SHAs, bad task ids and extra words', () => {
    for (const a of ['', 'task-12', `task-12 ${HEAD.slice(0, 7)}`, `task-12 ${HEAD.slice(0, 39)}`, `task-12 ${HEAD}a`, `task-12 ${'A'.repeat(40)}`, `task-12 ${'g'.repeat(40)}`,
      `task-12 ${'c'.repeat(64)}`, `TASK-12 ${HEAD}`, `12 ${HEAD}`, `task-12; ${HEAD}`, `../task-1 ${HEAD}`, `task-12 ${HEAD} publish`, `task-12 ${HEAD} merge extra`, `task-12 --head ${HEAD}`]) {
      expect(T.parseOwnerCommand('approve', a)).toBeNull();
    }
  });

  it('buildPlan refuses a malformed approve payload, and any container request of kind approve', async () => {
    const { project } = await install();
    const s = setup([project]);
    const d = { runtime: s.manager.runtime, upgrade: s.deps.upgrade };
    const owner = (payload: Record<string, unknown>) => ({ id: 'ow_0a1b2c3d', kind: 'approve', payload, reason: null, origin: 'owner' as const });
    expect((await reason(CR.buildPlan(project, owner({ taskId: 'task-1', head: 'abc1234', merge: false }), d))).message).toMatch(/full 40-character lowercase commit SHA/);
    expect((await reason(CR.buildPlan(project, owner({ taskId: 'nope', head: HEAD, merge: false }), d))).message).toMatch(/task id/);
    expect((await reason(CR.buildPlan(project, owner({ taskId: 'task-1', head: HEAD, merge: 'yes' }), d))).message).toMatch(/malformed/);
    for (const f of [{ id: 'cr_0a1b2c3d', kind: 'approve', payload: { taskId: 'task-1', head: HEAD, merge: false }, reason: null },
      { id: 'cr_0a1b2c3d', kind: 'approve', payload: { taskId: 'task-1', head: HEAD, merge: false }, reason: null, origin: 'owner' as const },
      { id: 'ow_0a1b2c3d', kind: 'approve', payload: { taskId: 'task-1', head: HEAD, merge: false }, reason: null }]) {
      expect((await reason(CR.buildPlan(project, f, d))).code).toBe('PRECONDITION');
    }
  });
});

describe('/approve: the plan and its confirmation', () => {
  it('proposing only journals an offer that always loosens; nothing is signed until the confirm, which calls approveOnHost with the exact args', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    expect(o.requestId).toMatch(J.OWNER_REQUEST_ID_PATTERN);
    expect(o.kind).toBe('approve');
    expect(o.summary).toBe(`approve publishing task-12 at ${HEAD}`);
    expect(o.loosens).toBe(`signs a publication approval for task-12 at ${HEAD}`);
    expect(o.text).toContain(`approves: task-12 at head ${HEAD}`);
    expect(o.text).toMatch(/scope: publish \(push the branch/);
    expect(o.text).toContain('LOOSENS POLICY');
    expect(journal().map((e) => e.type)).toEqual(['offer']);
    expect(s.approveCalls).toEqual([]);
    expect(s.delegateCalls).toEqual([]);

    await s.confirm(o);
    expect(s.approveCalls).toHaveLength(1);
    expect(s.approveCalls[0]).toMatchObject({ taskId: 'task-12', o: { head: HEAD, merge: false, json: true, cwd: project.repoPath }, deps: { projectId: project.projectId } });
    expect(s.delegateCalls).toEqual([['minions', 'work', 'approve', 'task-12', '--head', HEAD, '--by', 'owner', '--signature', 'FAKE-TOKEN-SECRET', '--json']]);
    expect(s.outcomes.map((x) => x.status)).toEqual(['applying', 'applied']);
    expect(s.outcomes[1]!.text).toMatch(/publication approval for task-12 at a{40} recorded: Recorded host-signed approval/);
    expect(journal().map((e) => e.type)).toEqual(['offer', 'confirmed', 'applying', 'applied']);
    // The token never reaches the journal, the chat or the log.
    expect(readFileSync(J.journalPath(), 'utf8')).not.toContain('FAKE-TOKEN-SECRET');
    expect(JSON.stringify(s.outcomes)).not.toContain('FAKE-TOKEN-SECRET');
    expect(s.logs.join('\n')).not.toContain('FAKE-TOKEN-SECRET');
    // A second tap of the same offer is already handled: nothing signed again.
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.approveCalls).toHaveLength(1);
  });

  it('merge: the scope is explicit in the offer and approveOnHost gets merge: true', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: true });
    expect(o.summary).toBe(`approve merging task-12 at ${HEAD}`);
    expect(o.loosens).toBe(`signs a merge approval for task-12 at ${HEAD}`);
    expect(o.text).toMatch(/scope: merge \(arms the merge of the delivered pull request/);
    expect(o.text).toContain('--merge');
    await s.confirm(o);
    expect(s.approveCalls[0]!.o).toMatchObject({ head: HEAD, merge: true });
    expect(s.delegateCalls[0]).toContain('--merge');
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied' });
  });

  it('a head that is not the one awaiting approval is refused by the runtime: the outcome is failed, nothing recorded', async () => {
    const { project } = await install();
    const s = setup([project], { awaiting: OTHER });
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('failed');
    expect(s.outcomes.at(-1)!.text).toMatch(/refused by the runtime: --head a{40} is not the head awaiting publication \(b{40}\)/);
    expect(journal().at(-1)).toMatchObject({ type: 'failed' });
    expect(JSON.stringify(s.outcomes)).not.toContain('FAKE-TOKEN-SECRET');
  });

  it('Reject does nothing: no approveOnHost, no runtime call; a later Confirm is already handled', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.reject(o);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'rejected', requestId: o.requestId });
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.approveCalls).toEqual([]);
    expect(s.delegateCalls).toEqual([]);
  });

  it('an expired offer is refused and re-offered; nothing is signed', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.deps.sleep(31 * 60_000);
    await s.confirm(o);
    expect(s.outcomes[0]).toMatchObject({ status: 'refused' });
    expect(s.offers).toHaveLength(1);
    expect(s.offers[0]!.loosens).toBe(o.loosens);
    expect(s.approveCalls).toEqual([]);
  });

  it('the real approveOnHost: the host key signs exactly (task, head, scope), the runtime gets the token, and the token stays out of the chat', async () => {
    const { project } = await install();
    const s = setup([project], { realApprove: true });
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: true });
    await s.confirm(o);
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied' });
    const argv = s.delegateCalls[0]!;
    expect(argv.slice(0, 6)).toEqual(['minions', 'work', 'approve', 'task-12', '--head', HEAD]);
    expect(argv).toContain('--merge');
    const token = argv[argv.indexOf('--signature') + 1]!;
    const pub = readFileSync(A.approvalPublicKeyFile(project.projectId), 'utf8');
    expect(AP.verifyApproval(token, pub, { taskId: 'task-12', head: HEAD, scope: 'merge' }).ok).toBe(true);
    expect(AP.verifyApproval(token, pub, { taskId: 'task-12', head: HEAD, scope: 'publish' }).ok).toBe(false);
    expect(readFileSync(J.journalPath(), 'utf8')).not.toContain(token);
    expect(JSON.stringify(s.outcomes)).not.toContain(token);
    expect(s.logs.join('\n')).not.toContain(token);
  });

  it('/undo of an approval is refused clearly; nothing journaled for it', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.confirm(o);
    const before = journal().length;
    const e = await reason(s.cmds.propose(null, { kind: 'undo', target: o.requestId }));
    expect(e.message).toMatch(/is an approval: approvals cannot be undone/);
    expect(journal()).toHaveLength(before);
  });

  it('`settings apply --confirm` in the terminal never signs a chat approval', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    const e = await reason(CR.confirmRequest(project, o.requestId, o.digest, { runtime: s.manager.runtime, upgrade: s.deps.upgrade, now: s.deps.now }));
    expect(e.message).toMatch(/confirmed only there; nothing signed/);
    expect(s.approveCalls).toEqual([]);
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
  const sent = () => calls.filter((c) => c.method === 'sendMessage');
  return { f, calls, sent, texts: () => sent().map((c) => String(c.body.text)), clock, push: (b: TelegramUpdate[]) => { batches.push(b); } };
}

describe('/approve in the manager chat', () => {
  it('short and non-hex SHAs get the usage line; nothing is proposed', async () => {
    const { project } = await install();
    const s = setup([project]);
    const api = botApi([[msg(1, '/approve task-12 abc1234'), msg(2, `/approve task-12 ${'z'.repeat(40)}`), msg(3, '/approve')]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    await t.receive(30_000);
    expect(api.texts()).toHaveLength(3);
    for (const x of api.texts()) expect(x).toMatch(/^Usage: \/approve <task> <sha> \[merge\].*full 40-character lowercase head SHA.*short or non-hex SHAs are refused/);
    expect(journal()).toEqual([]);
  });

  it('typing is not consent and the first tap is not either: only the second tap sends the confirm, which signs', async () => {
    const { project } = await install();
    const s = setup([project]);
    const api = botApi([[msg(1, `/approve task-12 ${HEAD} merge`)]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined, lookupOffer: async () => null });
    t.attach(s.cmds);
    expect(await t.receive(30_000)).toEqual([]);
    const shown = api.sent().at(-1)!;
    expect(String(shown.body.text)).toMatch(/^Your request ow_[0-9a-f]{8} \(project [^)]+\): approve merging task-12 at a{40}/);
    expect(String(shown.body.text)).toContain('scope: merge');
    expect(String(shown.body.text)).toContain('Confirm asks a second time');
    expect(shown.body.parse_mode).toBeUndefined();
    const [confirmBtn] = shown.body.reply_markup.inline_keyboard[0];

    api.push([tap(2, confirmBtn.callback_data)]);
    expect(await t.receive(30_000)).toEqual([]);
    const again = api.sent().at(-1)!;
    expect(String(again.body.text)).toMatch(/^Second confirmation for change request ow_[0-9a-f]{8}\. Risk: signs a merge approval for task-12 at a{40}/);
    expect(s.approveCalls).toEqual([]);

    // A second tap after the 2 minute window does nothing.
    api.clock.t += T.DOUBLE_TAP_MS + 1;
    api.push([tap(3, again.body.reply_markup.inline_keyboard[0][0].callback_data)]);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.texts().at(-1)).toMatch(/second confirmation .* expired/);

    // Tap Confirm again, then the second tap in time: the confirm event, which the core applies.
    api.push([tap(4, confirmBtn.callback_data)]);
    expect(await t.receive(30_000)).toEqual([]);
    const again2 = api.sent().at(-1)!;
    api.push([tap(5, again2.body.reply_markup.inline_keyboard[0][0].callback_data)]);
    const events = await t.receive(30_000);
    const [, rid, nonce] = String(confirmBtn.callback_data).split(':');
    expect(events).toEqual([{ type: 'confirm', requestId: rid, nonce }]);
    expect(s.approveCalls).toEqual([]);
    await s.manager.handle(events[0]!);
    expect(s.approveCalls).toHaveLength(1);
    expect(s.approveCalls[0]).toMatchObject({ taskId: 'task-12', o: { head: HEAD, merge: true } });
    expect(s.outcomes.at(-1)).toMatchObject({ status: 'applied', requestId: rid });
  });

  it('a fresh transport that never sent the offer still asks twice (loosens from the journal)', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    const api = botApi([[tap(1, T.callbackData('c', o.requestId, o.nonce))]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.texts().at(-1)).toMatch(/^Second confirmation for change request ow_.*signs a publication approval/s);
    expect(s.approveCalls).toEqual([]);
  });

  it('the help text lists /approve', () => {
    expect(T.HELP_TEXT).toMatch(/\/approve <task> <sha> \[merge\]/);
  });
});

// ---------------------------------------------------------------- QA (task-53.5.4): security edges

describe('/approve QA: parsing edges', () => {
  it('refuses control characters, a "-" prefix, unicode look-alikes and a flag-shaped scope', () => {
    for (const a of [`task-12\u0000 ${HEAD}`, `task-12‮ ${HEAD}`, `task-1\u00002 ${HEAD}`, `-task-12 ${HEAD}`, `--task-12 ${HEAD}`, `task-12 -${HEAD.slice(1)}`,
      `task-١٢ ${HEAD}`, `task‑12 ${HEAD}`, `task-12. ${HEAD}`, `task-12..3 ${HEAD}`, `task- ${HEAD}`, `task-12 ${HEAD}\u0000`, `task-12 ${HEAD} --merge`,
      `task-12 ${HEAD} MERGE`, `task-12 ${HEAD} merge\u0000`, `${HEAD} task-12`, `task-12 ${HEAD.slice(0, 20)}​${HEAD.slice(20)}`]) {
      expect(T.parseOwnerCommand('approve', a), JSON.stringify(a)).toBeNull();
    }
  });

  it('buildPlan refuses control characters and a "-" prefix in a journaled payload too (the second check)', async () => {
    const { project } = await install();
    const s = setup([project]);
    const d = { runtime: s.manager.runtime, upgrade: s.deps.upgrade };
    const owner = (payload: Record<string, unknown>) => ({ id: 'ow_0a1b2c3d', kind: 'approve', payload, reason: null, origin: 'owner' as const });
    for (const p of [{ taskId: 'task-1\n', head: HEAD, merge: false }, { taskId: '-task-1', head: HEAD, merge: false }, { taskId: 'task-1', head: `${HEAD}\n`, merge: false },
      { taskId: 'task-1', head: 'A'.repeat(40), merge: false }, { taskId: 'task-1', head: 'c'.repeat(64), merge: false }, { taskId: 'task-1', head: HEAD }, { taskId: ['task-1'], head: HEAD, merge: false }]) {
      expect((await reason(CR.buildPlan(project, owner(p), d))).code, JSON.stringify(p)).toBe('PRECONDITION');
    }
  });
});

describe('/approve QA: replay, forgery and failures', () => {
  it('a forged nonce, or the old nonce of a re-offered request, signs nothing', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.manager.handle({ type: 'confirm', requestId: o.requestId, nonce: 'f'.repeat(o.nonce.length) });
    expect(s.outcomes.at(-1)!.status).toBe('refused');
    // Expire it: the confirm is refused and a fresh offer (fresh nonce) is sent.
    await s.deps.sleep(31 * 60_000);
    await s.confirm(o);
    const fresh = s.offers.at(-1)!;
    expect(fresh.nonce).not.toBe(o.nonce);
    expect(fresh.loosens).toBe(o.loosens);
    // The old nonce again: spent (the expired confirm did not sign, and it never will).
    await s.confirm(o);
    expect(s.approveCalls).toEqual([]);
    expect(s.delegateCalls).toEqual([]);
    // The fresh offer works once.
    await s.confirm(fresh);
    await s.confirm(fresh);
    expect(s.approveCalls).toHaveLength(1);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
  });

  it('two concurrent confirms of the same offer sign once', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await Promise.all([s.confirm(o), s.confirm(o), s.confirm(o)]);
    expect(s.approveCalls).toHaveLength(1);
    expect(s.outcomes.filter((x) => x.status === 'applied')).toHaveLength(1);
  });

  it('a runtime that times out, or answers garbage, is a clear failed outcome; the token is not shown or logged', async () => {
    const { project } = await install();
    for (const answer of [{ code: 0, stdout: '', stderr: '', timedOut: true } as RunResult, { code: 1, stdout: 'not json FAKE-TOKEN-SECRET?', stderr: 'FAKE-TOKEN-SECRET' } as RunResult]) {
      const s = setup([project]);
      s.deps.delegate = async (_p, argv) => { s.delegateCalls.push(argv); return answer; };
      const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
      await s.confirm(o);
      const last = s.outcomes.at(-1)!;
      expect(last.status).toBe('failed');
      expect(last.text).toMatch(answer.timedOut ? /timed out/ : /publication approval for task-12 at a{40}: no result from the runtime \(exit 1\)/);
      expect(JSON.stringify(s.outcomes)).not.toContain('FAKE-TOKEN-SECRET');
      expect(s.logs.join('\n')).not.toContain('FAKE-TOKEN-SECRET');
      expect(readFileSync(J.journalPath(), 'utf8')).not.toContain('FAKE-TOKEN-SECRET');
    }
  });

  it('a failed approval is final for that offer: confirming it again signs nothing more', async () => {
    const { project } = await install();
    const s = setup([project], { awaiting: OTHER });
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: true });
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('failed');
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.approveCalls).toHaveLength(1);
    expect(readFileSync(J.journalPath(), 'utf8')).not.toContain('FAKE-TOKEN-SECRET');
    expect(s.logs.join('\n')).not.toContain('FAKE-TOKEN-SECRET');
  });

  it('a container row of kind approve (even claiming the owner origin) is never offered or signed', async () => {
    const { project } = await install();
    const s = setup([project]);
    const rows = [{ id: 'cr_0a1b2c3d', kind: 'approve', status: 'proposed', payload: { taskId: 'task-12', head: HEAD, merge: false }, reason: 'please', origin: 'owner' },
      { id: 'cr_0a1b2c3e', kind: 'approve', status: 'proposed', payload: { taskId: 'task-12', head: HEAD, merge: true }, reason: null }];
    s.deps.delegate = async (_p, argv) => { s.delegateCalls.push(argv); return ok({ requests: rows }); };
    expect(await s.manager.pollProject(project)).toEqual([]);
    expect(s.offers).toEqual([]);
    expect(journal().filter((e) => e.type === 'offer')).toEqual([]);
    expect(s.outcomes.every((x) => x.status === 'error')).toBe(true);
    expect(s.approveCalls).toEqual([]);
  });

  it('after `settings apply --confirm` refused it in the terminal, the chat confirm of that offer signs nothing either', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await reason(CR.confirmRequest(project, o.requestId, o.digest, { runtime: s.manager.runtime, upgrade: s.deps.upgrade, now: s.deps.now }));
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('already-handled');
    expect(s.approveCalls).toEqual([]);
    expect(s.delegateCalls.filter((a) => a[2] === 'approve')).toEqual([]);
  });
});

describe('/approve QA: the chat side', () => {
  const foreign = (update_id: number, text: string, o: { from?: number; chat?: number; type?: string; extra?: Record<string, unknown> } = {}): TelegramUpdate => ({
    update_id, message: { message_id: 2000 + update_id, text, from: { id: o.from ?? OWNER, is_bot: false }, chat: { id: o.chat ?? OWNER, type: o.type ?? 'private' }, ...(o.extra ?? {}) } as never,
  });

  it('a forwarded /approve, or one from another user, chat or group, is ignored: no reply, nothing journaled', async () => {
    const { project } = await install();
    const s = setup([project]);
    const cmd = `/approve task-12 ${HEAD} merge`;
    const api = botApi([[
      foreign(1, cmd, { extra: { forward_origin: { type: 'user', sender_user: { id: OWNER } } } }),
      foreign(2, cmd, { extra: { forward_from: { id: OWNER } } }),
      foreign(3, cmd, { extra: { forward_date: 1 } }),
      foreign(4, cmd, { from: 999 }),
      foreign(5, cmd, { chat: -100123, type: 'group' }),
      foreign(6, cmd, { from: 999, chat: 999 }),
    ]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.sent()).toEqual([]);
    expect(journal()).toEqual([]);
  });

  it('a non-owner tap on an approve offer does nothing; a forged "Confirm again" without the first tap is expired', async () => {
    const { project } = await install();
    const s = setup([project]);
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    const strangerTap: TelegramUpdate = { update_id: 1, callback_query: { id: 'cb1', data: T.callbackData('c', o.requestId, o.nonce), from: { id: 999 }, message: { message_id: 50, chat: { id: 999, type: 'private' } } } };
    const api = botApi([[strangerTap, tap(2, T.callbackData('d', o.requestId, o.nonce))]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    expect(await t.receive(30_000)).toEqual([]);
    expect(api.texts()).toHaveLength(1);
    expect(api.texts()[0]).toMatch(/second confirmation .* expired/);
    expect(api.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.callback_query_id)).toEqual(['cb2']);
    expect(s.approveCalls).toEqual([]);
  });

  it('/approve@bot works; a flag-shaped scope gets the usage line', async () => {
    const { project } = await install();
    const s = setup([project]);
    const api = botApi([[msg(1, `/approve task-12 ${HEAD} --merge`), msg(2, `/approve@MinionsManagerBot task-12 ${HEAD}`)]]);
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: api.f, now: () => api.clock.t, sleep: async () => undefined });
    t.attach(s.cmds);
    await t.receive(30_000);
    expect(api.texts()[0]).toMatch(/^Usage: \/approve/);
    expect(api.texts()[1]).toMatch(/^Your request ow_[0-9a-f]{8} .*approve publishing task-12 at a{40}/);
    expect(journal().map((e) => e.type)).toEqual(['offer']);
    expect(s.approveCalls).toEqual([]);
  });

  // approveOutcome scrubs the --signature value and token-shaped strings from the runtime's answer.
  it('a hostile runtime that echoes the token in its refusal does not get it into the chat, the log or the journal', async () => {
    const { project } = await install();
    const s = setup([project]);
    s.deps.delegate = async (_p, argv) => {
      s.delegateCalls.push(argv);
      return refused('CONFLICT', `bad signature ${argv[argv.indexOf('--signature') + 1]}`);
    };
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('failed');
    expect(s.outcomes.at(-1)!.text).toContain('refused by the runtime');
    expect(JSON.stringify(s.outcomes)).not.toContain('FAKE-TOKEN-SECRET');
    expect(s.logs.join('\n')).not.toContain('FAKE-TOKEN-SECRET');
    expect(readFileSync(J.journalPath(), 'utf8')).not.toContain('FAKE-TOKEN-SECRET');
  });

  it('scrubs the token from an ok:true answer too', async () => {
    const { project } = await install();
    const s = setup([project]);
    s.deps.delegate = async (_p, argv) => {
      s.delegateCalls.push(argv);
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { message: `recorded with ${argv[argv.indexOf('--signature') + 1]}` } }) + '\n', stderr: '' };
    };
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.confirm(o);
    expect(s.outcomes.at(-1)!.status).toBe('applied');
    expect(s.outcomes.at(-1)!.text).toContain('[REDACTED]');
    expect(JSON.stringify(s.outcomes)).not.toContain('FAKE-TOKEN-SECRET');
    expect(s.logs.join('\n')).not.toContain('FAKE-TOKEN-SECRET');
    expect(readFileSync(J.journalPath(), 'utf8')).not.toContain('FAKE-TOKEN-SECRET');
  });

  it('scrubs a token-shaped string that is not the real token', async () => {
    const { project } = await install();
    const s = setup([project]);
    s.deps.delegate = async (_p, argv) => {
      s.delegateCalls.push(argv);
      return refused('CONFLICT', 'bad mnap1.eyJhIjoxfQ.c2ln_-x and mnap1.AAA.BBB');
    };
    const o = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.confirm(o);
    const text = s.outcomes.at(-1)!.text;
    expect(text).not.toMatch(/mnap1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(text).toContain('bad [REDACTED] and [REDACTED]');
    expect(readFileSync(J.journalPath(), 'utf8')).not.toContain('mnap1.');
  });
});

// Repair 2: redaction must survive what displayText strips or escapes inside the token, and the cut at the limit.
describe('/approve QA: token redaction against injected characters', () => {
  const SIG = `mnap1.${'P'.repeat(40)}.${'S'.repeat(86)}`;
  const PAYLOAD = 'P'.repeat(40);
  const SIGPART = 'S'.repeat(86);
  const plan = { taskId: 'task-12', head: HEAD, scope: 'publish' } as never;
  /** No run of 12 or more characters of the token survives, in any of its parts. */
  const leaks = (text: string, token = SIG) => {
    const bare = text.replace(/<U\+[0-9A-F]{4,6}>|\p{M}|\s/gu, '');
    for (let i = 0; i + 12 <= token.length; i++) if (bare.includes(token.slice(i, i + 12))) return token.slice(i, i + 12);
    return null;
  };
  const split = (t: string, at: number, junk: string) => t.slice(0, at) + junk + t.slice(at);

  it('control characters, ESC/CSI/OSC sequences and C1 introducers inside the real token are redacted after displayText', () => {
    const junks = ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u001b[31m', '\u001b[0m', '\u001b(B', '\u001b]0;title\u0007', '\u001b]8;;http://x\u001b\\',
      '\u009b31m', '\u009d0;x\u009c', '\u001bP1;2|x\u001b\\', '\r', '\u001bc'];
    for (const junk of junks) {
      for (const at of [1, 4, 5, 6, 20, 46, 47, 100, SIG.length - 1]) {
        const raw = `bad signature ${split(SIG, at, junk)} for task-12`;
        const out = M.redactApprovalText(raw, SIG);
        expect(leaks(out), JSON.stringify({ junk, at, out })).toBeNull();
        expect(out, JSON.stringify({ junk, at, out })).toContain('[REDACTED]');
        // At most one character before the marker: the final byte of an escape whose rest joined the token in the raw text.
        expect(out).toMatch(/^bad signature .?\[REDACTED\] for task-12$/);
        expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      }
    }
  });

  it('zero-width, bidi, BOM, tag and combining characters inside the real token are redacted (escaped markers do not split it)', () => {
    for (const junk of ['​', '‌', '‍', '⁠', '﻿', '‮', '⁦', '\u{e0041}', '­', '́', ' ', '<U+200B>']) {
      for (const at of [2, 6, 30, 47, 120]) {
        const out = M.redactApprovalText(`echo: ${split(SIG, at, junk + junk)}!`, SIG);
        expect(leaks(out), JSON.stringify({ junk, at, out })).toBeNull();
        expect(out).toBe('echo: [REDACTED]!');
      }
    }
  });

  it('several kinds of junk at once, and whitespace inside the real token, still redact it', () => {
    let t = SIG;
    for (const [at, junk] of [[130, '​'], [90, ' '], [60, '\u001b[1m'], [30, '\t'], [3, '\u0000‮']] as const) t = split(t, at, junk);
    const out = M.redactApprovalText(`x ${t} y`, SIG);
    expect(leaks(out)).toBeNull();
    expect(out).toBe('x [REDACTED] y');
  });

  it('the signature part or the payload part alone (with or without junk) is redacted too', () => {
    for (const part of [SIGPART, PAYLOAD, split(SIGPART, 40, '\u001b[0m'), split(PAYLOAD, 10, '​')]) {
      const out = M.redactApprovalText(`part ${part} end`, SIG);
      expect(leaks(out)).toBeNull();
      expect(out).toBe('part [REDACTED] end');
    }
  });

  it('a token-shaped string that is not the real token, with injected characters, is redacted', () => {
    for (const raw of ['mnap1.AA\u001b[31mAA.BBBB', 'mn\u0000ap1.AAAA.BBBB', 'mnap1​.AAAA.B‍BBB', 'mnap1.AAAA.\u001b]0;x\u0007BBBB', 'ḿnap1.AAAA.BBBB', 'mnap1.AA<U+202E>AA.BBBB']) {
      const out = M.redactApprovalText(`bad ${raw} end`, 'FAKE-TOKEN-SECRET');
      expect(out, JSON.stringify(raw)).toBe('bad [REDACTED] end');
    }
    // No signature known at all (an error before signing): the shape is still redacted.
    expect(M.redactApprovalText('x mnap1.A\u0000A.B​B y', undefined)).toBe('x [REDACTED] y');
  });

  it('a token across the truncation cut leaves no part of it, and the result is within the limit', () => {
    for (let pad = 380; pad <= 505; pad += 3) {
      for (const junk of ['', '​', '\u001b[0m']) {
        const raw = `${'z'.repeat(pad)} ${split(SIG, 50, junk)} tail`;
        const out = M.redactApprovalText(raw, SIG);
        expect(out.length).toBeLessThanOrEqual(M.APPROVE_MESSAGE_MAX);
        expect(leaks(out), JSON.stringify({ pad, junk })).toBeNull();
        expect(out).not.toMatch(/mnap1/);
      }
    }
    // An unknown token-shaped string at the cut: the redaction runs before the cut, so no partial shape survives.
    for (let pad = 470; pad <= 500; pad++) {
      const out = M.redactApprovalText(`${'z'.repeat(pad)} mnap1.${'Q'.repeat(30)}.${'R'.repeat(30)}`, undefined);
      expect(out).not.toMatch(/QQQQ|RRRR|mnap1/);
    }
  });

  it('ordinary text is kept (controls stripped, format characters shown), and a short token segment is not searched for alone', () => {
    expect(M.redactApprovalText('Recorded host-signed approval\u001b[31m to publish\n agent/x ​ at abc.', 'mnap1.ab.cd')).toBe('Recorded host-signed approval to publish agent/x <U+200B> at abc.');
  });

  it('approveOutcome: both envelope paths go through the redaction', () => {
    const tok = split(SIG, 47, '\u001b[31m​');
    const okA = M.approveOutcome(plan, 0, ok({ message: `recorded ${tok}` }), SIG);
    expect(okA).toEqual({ status: 'applied', detail: `publication approval for task-12 at ${HEAD} recorded: recorded [REDACTED]` });
    const bad = M.approveOutcome(plan, 1, refused('CONFLICT', `bad ${tok}`), SIG);
    expect(bad).toEqual({ status: 'failed', detail: `publication approval for task-12 at ${HEAD} refused by the runtime: bad [REDACTED]` });
  });

  let repos = 0;
  async function hostile(message: (token: string) => string, o: { ok?: boolean; realApprove?: boolean; throws?: boolean } = {}) {
    const { project } = await install(`repo-${++repos}`);
    const s = setup([project], { realApprove: o.realApprove });
    let token = '';
    s.deps.delegate = async (_p, argv) => {
      s.delegateCalls.push(argv);
      token = argv[argv.indexOf('--signature') + 1]!;
      if (o.throws) throw new Error(message(token));
      return o.ok ? { code: 0, stdout: JSON.stringify({ ok: true, data: { message: message(token) } }) + '\n', stderr: '' } : refused('CONFLICT', message(token));
    };
    const offer = await s.cmds.propose(null, { kind: 'approve', taskId: 'task-12', head: HEAD, merge: false });
    await s.confirm(offer);
    const places = { chat: JSON.stringify(s.outcomes), log: s.logs.join('\n'), journal: readFileSync(J.journalPath(), 'utf8') };
    return { s, token, places };
  }

  it('end to end with the real signed token: injected characters do not get it into the chat, the log or the journal', async () => {
    for (const o of [{ ok: false }, { ok: true }, { throws: true }]) {
      const { s, token, places } = await hostile((t) => `bad \u001b[31m${split(split(t, 70, '\u0000'), 20, '​\u001b]0;x\u0007')}\u001b[0m (${t.split('.')[2]})`, { ...o, realApprove: true });
      expect(token.startsWith('mnap1.')).toBe(true);
      expect(s.outcomes.at(-1)!.status).toBe(o.ok ? 'applied' : 'failed');
      expect(s.outcomes.at(-1)!.text).toContain('[REDACTED]');
      for (const [where, text] of Object.entries(places)) {
        // The journal is JSON: undo its string escapes before looking.
        const plain = where === 'log' ? text : text.split('\n').filter(Boolean).map((l) => JSON.stringify(JSON.parse(l))).join('\n').replace(/\\u[0-9a-f]{4}/g, '');
        expect(leaks(plain, token), `${JSON.stringify(o)} ${where}`).toBeNull();
      }
      const failed = journal().filter((e) => e.type === 'failed' || e.type === 'applied').at(-1)!;
      expect(String(failed.detail)).toContain('[REDACTED]');
    }
  });

  it('end to end with the stub token across the truncation cut: nothing of it in the chat, the log or the journal', async () => {
    const { places } = await hostile((t) => `${'z'.repeat(485)} ${split(t, 5, '​')}`);
    for (const text of Object.values(places)) expect(text.replace(/<U\+200B>|\\u200b/gi, '')).not.toMatch(/FAKE-TOKEN|TOKEN-SECRET|FAKE-TOK/);
  });
});
