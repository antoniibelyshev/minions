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
