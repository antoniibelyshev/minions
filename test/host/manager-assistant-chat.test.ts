// task-65.4: the manager assistant in the chat. Plain owner text goes to the assistant (slash commands never do), the
// labelled reply comes first and the host offer (ManagerCommands.propose with via: 'assistant') second; the double tap
// is unchanged for loosening plans; in-memory history (6 exchanges, 8 KiB, 30-min idle clear, cleared on /project and
// /assistant off); the daily limit; /assistant on|off|status; every failure falls back to the help text.
// Temp MINIONS_HOME, a real install, the real HostManager, the real Telegram transport against a fake Bot API, and the
// real createManagerAssistant with a FAKE runner (no claude is ever run), a fake CLI check and a fake token.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async (orig) => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    ...(await orig<typeof import('../../src/plugin/generate.js')>()),
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const J = await import('../../src/host/change-journal.js');
const CR = await import('../../src/host/change-requests.js');
const M = await import('../../src/host/manager.js');
const T = await import('../../src/host/manager-telegram.js');
const MA = await import('../../src/host/manager-assistant.js');
const AC = await import('../../src/host/manager-assistant-chat.js');
const { managerPaths } = await import('../../src/core/paths.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;
type RunOptions = import('../../src/core/exec.js').RunOptions;
type ManagerDeps = import('../../src/host/manager.js').ManagerDeps;
type ManagerEvent = import('../../src/host/manager.js').ManagerEvent;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;
type ClaudeCapabilities = import('../../src/host/manager-assistant.js').ClaudeCapabilities;
type CapabilityCheck = import('../../src/host/manager-assistant.js').CapabilityCheck;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const OWNER = 4242;
const TOKEN = '555666777:MMHmanagermanagermanagermanager_-9876';
const ACCESS = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T00:00:00.000Z' };
const CLAUDE_TOKEN = 'sk-ant-oat01-FAKEfakeFAKEfakeFAKEfakeFAKEfake';
const CAPS: ClaudeCapabilities = {
  claudePath: '/opt/claude/bin/claude', version: '2.1.292', permissionMode: 'manual', jsonSchema: true, noSessionPersistence: true,
  maxBudget: true, maxTurns: false, permissionPromptsNone: true, disableSlashCommands: true, restricted: true, settingSources: true,
};
const SYSTEM = 'You are the minions host manager assistant (test prompt).';
const T0 = Date.parse('2026-10-27T10:00:00Z');

const journal = () => (existsSync(J.journalPath()) ? readFileSync(J.journalPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const ok = (data: unknown): RunResult => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
/** What `claude -p --output-format json` prints, with the structured answer. */
const answer = (reply: string, proposal: unknown = null, extra: Record<string, unknown> = {}): RunResult => ({
  code: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply, structured_output: { reply, proposal }, total_cost_usd: 0.01, ...extra }), stderr: '',
});

async function install(name = 'repo') {
  const repo = makeRepo(env.root, name);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  return loadProjectJson(r.plan.projectId);
}

interface Call { cmd: string; args: string[]; opts?: RunOptions; stdin: { context: any; history: any[]; message: string } }

/** The whole stack: HostManager, Telegram transport (fake Bot API), the assistant chat with a fake runner. */
async function stack(o: {
  projects?: ProjectJson[]; reply?: (c: Call) => RunResult | Promise<RunResult>; probe?: () => Promise<CapabilityCheck>;
  credential?: { token: string; kind: 'oauth-token' | 'api-key' } | null; config?: { enabled: boolean; dailyLimit?: number } | null; deadlineMs?: number; slotMs?: number;
} = {}) {
  const projects = o.projects ?? [await install()];
  if (o.config !== null) await MA.saveAssistantConfig({ version: 1, enabled: o.config?.enabled ?? true, model: 'sonnet', dailyLimit: o.config?.dailyLimit ?? 50 });
  let now = T0;
  const clock = { set: (ms: number) => { now = ms; }, add: (ms: number) => { now += ms; } };
  const childRuns: string[][] = [];
  const deps: ManagerDeps = {
    transport: { sendOffer: async () => undefined, receive: async () => [], sendOutcome: async () => undefined },
    projects: async () => projects,
    loadProject: async (id) => { const p = projects.find((x) => x.projectId === id); if (!p) throw new Error(`no project ${id}`); return p; },
    running: async () => true,
    delegate: async (_p, argv) => (argv.includes('status') ? ok({ paused: { intake: false, starts: false }, activeLeases: [], coordinatorLaunch: { state: 'current' } }) : ok({ requests: [] })),
    runChild: async (_p, argv) => {
      childRuns.push(argv);
      const i = argv.indexOf('set');
      return ok({ written: true, key: argv[i + 1], from: 'disabled', to: argv[i + 2], file: 'config.yaml' });
    },
    upgrade: async () => ({ ok: true, steps: [], summary: '' }),
    now: () => new Date(now),
    sleep: async () => undefined,
    log: () => undefined,
  };
  const m = new M.HostManager(deps);
  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    const c: Call = { cmd, args, opts, stdin: JSON.parse(String(opts?.input ?? '{}')) };
    calls.push(c);
    return o.reply ? o.reply(c) : answer('Hello from the fake assistant.');
  };
  const assistant = MA.createManagerAssistant({
    runner, env: { PATH: '/usr/bin', HOME: env.root },
    readCredential: async () => (o.credential === undefined ? { token: CLAUDE_TOKEN, kind: 'oauth-token' } : o.credential),
    probe: o.probe ?? (async () => ({ ok: true, caps: CAPS })),
  });
  const chat = AC.createAssistantChat({ assistant, now: () => new Date(now), loadSystemPrompt: async () => SYSTEM, ...(o.deadlineMs ? { deadlineMs: o.deadlineMs } : {}) });

  // Fake Bot API.
  const sent: { text: string; keyboard?: { text: string; callback_data: string }[][] }[] = [];
  const methods: string[] = [];
  let queue: TelegramUpdate[][] = [];
  let mid = 100;
  let uid = 1;
  const res = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    methods.push(method);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    if (method === 'sendMessage') {
      expect(body.parse_mode).toBeUndefined();
      expect(body.disable_web_page_preview).toBe(true);
      sent.push({ text: String(body.text), ...(body.reply_markup ? { keyboard: body.reply_markup.inline_keyboard } : {}) });
      return res({ ok: true, result: { message_id: mid++ } });
    }
    if (method === 'getUpdates') return res({ ok: true, result: queue.shift() ?? [] });
    return res({ ok: true, result: true });
  }) as typeof fetch;
  const t = T.telegramTransport({
    token: TOKEN, access: ACCESS, fetch: f, now: () => now, sleep: async () => undefined, assistant: chat,
    ...(o.slotMs ? { assistantSlotMs: o.slotMs } : {}),
  });
  t.attach(m.commands());
  const msg = (text: string): TelegramUpdate => ({ update_id: uid++, message: { message_id: 1000 + uid, text, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' } } });
  const tap = (data: string): TelegramUpdate => ({ update_id: uid++, callback_query: { id: `cb${uid}`, data, from: { id: OWNER }, message: { message_id: 50, chat: { id: OWNER, type: 'private' } } } });
  /** Delivers one batch, waits for the assistant, returns the new messages and the events. */
  const say = async (...texts: (string | TelegramUpdate)[]) => {
    const before = sent.length;
    queue.push(texts.map((x) => (typeof x === 'string' ? msg(x) : x)));
    const events = await t.receive(30_000);
    await t.assistantIdle();
    return { out: sent.slice(before), events };
  };
  return { m, t, chat, calls, sent, methods, say, tap, clock, projects, childRuns, push: (u: TelegramUpdate[]) => queue.push(u), msg, reset: () => { queue = []; } };
}

const offerButtons = (s: { keyboard?: { text: string; callback_data: string }[][] }) => s.keyboard?.[0]?.map((b) => b.callback_data) ?? [];

// ---------------------------------------------------------------- routing and order

describe('plain text goes to the assistant; slash commands never do', () => {
  it('a plain message is one call (stdin: bundle, history, message; argv: no owner text, no token); the reply is labelled', async () => {
    const s = await stack();
    const { out, events } = await s.say('  what can I change?  ');
    expect(events).toEqual([]);
    expect(s.calls).toHaveLength(1);
    const c = s.calls[0]!;
    expect(c.cmd).toBe(CAPS.claudePath);
    expect(c.stdin.message).toBe('what can I change?');
    expect(c.stdin.history).toEqual([]);
    expect(c.stdin.context.project).toBe('repo');
    expect(c.stdin.context.settings.length).toBeGreaterThan(10);
    expect(c.args.join('\n')).not.toContain('what can I change');
    expect(c.args.join('\n')).not.toContain(CLAUDE_TOKEN);
    expect(c.opts?.killGroup).toBe(true);
    expect(c.args).toContain('--json-schema');
    expect(out.map((x) => x.text)).toEqual(['Assistant: Hello from the fake assistant.']);
    expect(out[0]!.keyboard).toBeUndefined();
    expect(s.methods).toContain('sendChatAction');
  });

  it('slash commands (known, unknown, /help, /assistant) and empty text never reach the assistant', async () => {
    const s = await stack();
    const { out } = await s.say('/status', '/help', '/nonsense hello there', '/settings delivery', '/assistant', '/project', '');
    expect(s.calls).toEqual([]);
    expect(out[1]!.text).toBe(T.HELP_TEXT);
    expect(out[2]!.text).toBe(T.HELP_TEXT);
    expect(out[6]!.text).toBe(T.HELP_TEXT);
    expect(T.HELP_TEXT).toContain('/assistant [on|off|status]');
  });

  it('without an assistant attached plain text still gets the help text (unchanged transport behaviour)', async () => {
    const p = await install();
    const sent: string[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').at(-1)!;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
      if (method === 'sendMessage') sent.push(String(body.text));
      if (method === 'getUpdates') return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 1, text: 'hello', from: { id: OWNER }, chat: { id: OWNER, type: 'private' } } }] }));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch;
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: f, sleep: async () => undefined });
    t.attach(new M.HostManager({ projects: async () => [p] } as unknown as ManagerDeps).commands());
    await t.receive(30_000);
    expect(sent).toEqual([T.HELP_TEXT]);
  });

  it('labelled reply first, then the host offer (proposed by the assistant); via: assistant in the plan and the journal', async () => {
    const s = await stack({ reply: () => answer('I proposed setting execution.maxActiveTasks to 4: check the plan below. Nothing is applied yet.', { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' }) });
    const { out } = await s.say('allow four tasks at once');
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toMatch(/^Assistant: I proposed setting execution\.maxActiveTasks to 4/);
    expect(out[0]!.keyboard).toBeUndefined();
    expect(out[1]!.text).toMatch(/^Proposed by the assistant from your message: request ow_[0-9a-f]{8} \(project [^)]+\): set execution\.maxActiveTasks: \d+ -> 4/);
    expect(out[1]!.text).toContain('proposed by the assistant from your message in the manager chat');
    expect(offerButtons(out[1]!)).toEqual([expect.stringMatching(/^c:ow_/), expect.stringMatching(/^r:ow_/)]);
    const offers = journal().filter((e) => e.type === 'offer');
    expect(offers).toHaveLength(1);
    expect(offers[0].request).toMatchObject({ origin: 'owner', via: 'assistant', kind: 'config-set' });
    expect(offers[0].plan).toMatchObject({ origin: 'owner', via: 'assistant', kind: 'config-set' });
    expect(offers[0].digest).toBe(CR.planDigest(offers[0].plan));
    // Nothing applied: no child ran.
    expect(s.childRuns).toEqual([]);
  });

  it('the digests of typed and container plans are unchanged: no via field; the assistant plan differs only by via', async () => {
    const s = await stack();
    const cmds = s.m.commands();
    const typed = await cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' });
    const viaA = await cmds.propose(null, { kind: 'config-set', key: 'execution.maxActiveTasks', value: '4', layer: 'local' }, { via: 'assistant' });
    expect(typed.via).toBeUndefined();
    expect(viaA.via).toBe('assistant');
    const [eTyped, eA] = journal().filter((e) => e.type === 'offer');
    expect('via' in eTyped.plan).toBe(false);
    expect('via' in eTyped.request).toBe(false);
    expect(eTyped.digest).toBe(CR.planDigest(eTyped.plan));
    const { via: _v, ...rest } = eA.plan;
    expect(CR.planDigest({ ...rest, requestId: eTyped.plan.requestId })).toBe(eTyped.digest);
    expect(eA.digest).not.toBe(eTyped.digest);
    // A container request can never carry via (nor be planned as assistant-proposed).
    const deps = { runtime: s.m.runtime, upgrade: async () => ({ ok: true, steps: [], summary: '' }) };
    await expect(CR.buildPlan(s.projects[0]!, { id: 'cr_0123abcd', kind: 'config-set', payload: { key: 'execution.maxActiveTasks', value: '4', layer: 'local' }, reason: null, via: 'assistant' }, deps))
      .rejects.toThrow(/comes only from the owner/);
    // The host refuses typed-only kinds through the assistant path, whatever the schema let through.
    await expect(cmds.propose(null, { kind: 'approve', taskId: 'task-1', head: 'a'.repeat(40), merge: false }, { via: 'assistant' })).rejects.toThrow(/never proposed by the assistant/);
    await expect(cmds.propose(null, { kind: 'rebuild-cli' }, { via: 'assistant' })).rejects.toThrow(/never proposed by the assistant/);
  });

  it('a loosening plan keeps the double tap; the confirmed assistant offer passes the digest check and applies; the outcome lands in the history', async () => {
    const s = await stack({ reply: () => answer('delivery.merge manual lets minions merge when asked. Check the plan below; nothing is applied yet.', { kind: 'config-set', key: 'delivery.merge', value: 'manual', layer: 'local' }) });
    const { out } = await s.say('switch to manual merges');
    expect(out[0]!.text).toMatch(/^Assistant: /);
    const offer = out[1]!;
    expect(offer.text).toContain('This change loosens policy');
    const confirm = offerButtons(offer)[0]!;
    const first = await s.say(s.tap(confirm));
    expect(first.events).toEqual([]);
    expect(first.out[0]!.text).toMatch(/^Second confirmation for change request ow_/);
    const again = first.out[0]!.keyboard![0]![0]!.callback_data;
    expect(again).toMatch(/^d:ow_/);
    const second = await s.say(s.tap(again));
    expect(second.events).toEqual([{ type: 'confirm', requestId: expect.stringMatching(/^ow_/), nonce: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
    (s.m as unknown as { deps: ManagerDeps }).deps.transport = s.t;
    await s.m.handle(second.events[0] as ManagerEvent);
    expect(s.childRuns).toHaveLength(1);
    expect(s.childRuns[0]!.join(' ')).toContain('delivery.merge manual');
    const last = journal().at(-1);
    expect(last).toMatchObject({ type: 'applied' });
    expect(s.chat.exchanges().at(-1)).toMatchObject({ owner: 'switch to manual merges', proposal: 'set delivery.merge: disabled -> manual', outcome: 'applied' });
  });

  it('an invalid proposal shows the reply and says nothing was planned; approve is refused; nothing is journaled', async () => {
    const s = await stack({ reply: () => answer('Approved!', { kind: 'approve', taskId: 'task-1', head: 'a'.repeat(40), merge: false }) });
    const { out } = await s.say('approve task-1');
    expect(out.map((x) => x.text)).toEqual(['Assistant: Approved!', "The assistant's proposal was invalid (approve is never proposed: the owner types it); nothing was planned."]);
    expect(journal()).toEqual([]);
  });

  it('a proposal the host refuses gets the usual "/<cmd> failed" line after the reply; a no-op gets the plain notice', async () => {
    let proposal: unknown = { kind: 'config-set', key: 'execution.maxActiveTasks', value: '0', layer: 'local' };
    const s = await stack({ reply: () => answer('Proposed.', proposal) });
    let r = await s.say('zero tasks');
    expect(r.out[0]!.text).toBe('Assistant: Proposed.');
    expect(r.out[1]!.text).toMatch(/^\/set failed: /);
    const current = (await s.m.commands().settings!(null)).settings.find((v) => v.key === 'delivery.mode')!;
    proposal = { kind: 'config-set', key: 'delivery.mode', value: String(current.value), layer: 'local' };
    r = await s.say('keep the delivery mode');
    expect(r.out[1]!.text).toMatch(/^delivery\.mode is already /);
    expect(journal().filter((e) => e.type === 'offer')).toEqual([]);
  });

  it('the reply is plain, display-safe and cut to 1,500 characters behind the fixed label', async () => {
    const s = await stack({ reply: () => answer(`\u001b[31mDone‮ ${'x'.repeat(3000)}`) });
    const { out } = await s.say('hi');
    expect(out[0]!.text.startsWith('Assistant: ')).toBe(true);
    expect(out[0]!.text.length).toBeLessThanOrEqual('Assistant: '.length + 1500);
    expect(out[0]!.text).not.toContain('\u001b');
    expect(out[0]!.text).not.toContain('‮');
  });
});

// ---------------------------------------------------------------- off the poll loop

describe('a stuck call never blocks the poll loop', () => {
  it('receive returns at once; taps and commands keep working; another message gets the fallback; the call is bounded', async () => {
    let release: (() => void) | null = null;
    const s = await stack({
      deadlineMs: 1500,
      reply: (c) => new Promise<RunResult>((resolve) => {
        release = () => resolve(answer('late'));
        c.opts?.signal?.addEventListener('abort', () => resolve({ code: 130, stdout: '', stderr: '', aborted: true }), { once: true });
      }),
    });
    s.push([s.msg('hello')]);
    const t0 = Date.now();
    expect(await s.t.receive(30_000)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000); // well before the call's own bound
    // While it waits: a command is answered, and another plain message gets the fallback (no second call).
    const before = s.sent.length;
    s.push([s.msg('/help'), s.msg('are you there?')]);
    await s.t.receive(30_000);
    expect(s.sent.slice(before).map((x) => x.text)).toEqual([T.HELP_TEXT, T.fallbackText('it is still answering your previous message')]);
    await s.t.assistantIdle();
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.stdin.message).toBe('hello');
    expect(s.sent.at(-1)!.text).toBe(T.fallbackText('no answer within 2 s'));
    expect(release).not.toBeNull();
  });

  it('the transport frees the slot after its bound even if the chat never settles', async () => {
    const p = await install();
    const never = { handle: () => new Promise<void>(() => undefined), command: async () => '', statusLine: async () => '', clearHistory: () => undefined, noteOutcome: () => undefined };
    const f = (async (url: string | URL | Request) => {
      const method = String(url).split('/').at(-1)!;
      if (method === 'getUpdates') return new Response(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { message_id: 1, text: 'hello', from: { id: OWNER }, chat: { id: OWNER, type: 'private' } } }] }));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch;
    const t = T.telegramTransport({ token: TOKEN, access: ACCESS, fetch: f, sleep: async () => undefined, assistant: never, assistantSlotMs: 100 });
    t.attach(new M.HostManager({ projects: async () => [p] } as unknown as ManagerDeps).commands());
    await t.receive(30_000);
    const t0 = Date.now();
    await t.assistantIdle();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------- history

describe('conversation history (in memory only)', () => {
  it('goes to the next call; at most 6 exchanges and 8 KiB; never written to disk', async () => {
    const s = await stack({ reply: (c) => answer(`answer to ${c.stdin.message.slice(0, 12)}`) });
    for (let i = 0; i < 8; i++) await s.say(`question ${i}`);
    const last = s.calls.at(-1)!;
    expect(last.stdin.history.map((h: { owner: string }) => h.owner)).toEqual(['question 1', 'question 2', 'question 3', 'question 4', 'question 5', 'question 6']);
    expect(s.chat.exchanges()).toHaveLength(AC.HISTORY_MAX_EXCHANGES);
    const files = [managerPaths().assistantUsageJson, managerPaths().assistantJson, J.journalPath()].filter(existsSync).map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(files).not.toContain('question 3');
    // 8 KiB: long exchanges push the old ones out.
    const big = await stack({ projects: [await install('big')], reply: () => answer('r'.repeat(1400)) });
    for (let i = 0; i < 6; i++) await big.say(`${i} ${'o'.repeat(1900)}`);
    expect(Buffer.byteLength(JSON.stringify(big.chat.exchanges()))).toBeLessThanOrEqual(8 * 1024);
    expect(big.chat.exchanges().length).toBeLessThan(6);
  });

  it('is cleared after 30 minutes without a message, on /project and on /assistant off', async () => {
    const s = await stack();
    await s.say('one');
    s.clock.add(29 * 60_000);
    await s.say('two');
    expect(s.calls.at(-1)!.stdin.history).toHaveLength(1);
    s.clock.add(31 * 60_000);
    await s.say('three');
    expect(s.calls.at(-1)!.stdin.history).toEqual([]);
    expect(s.chat.exchanges()).toHaveLength(1);
    await s.say('/project repo');
    expect(s.chat.exchanges()).toEqual([]);
    await s.say('four');
    expect(s.chat.exchanges()).toHaveLength(1);
    const { out } = await s.say('/assistant off');
    expect(out[0]!.text).toContain('history was cleared');
    expect(s.chat.exchanges()).toEqual([]);
  });
});

// ---------------------------------------------------------------- daily limit, /assistant

describe('daily limit and /assistant on|off|status', () => {
  it('over the limit: the reason once a day, then the command list only; no call; the next UTC day it runs again', async () => {
    const s = await stack({ config: { enabled: true, dailyLimit: 2 } });
    await s.say('a');
    await s.say('b');
    expect(s.calls).toHaveLength(2);
    let r = await s.say('c');
    expect(r.out.map((x) => x.text)).toEqual([T.fallbackText('the daily limit of 2 calls is reached; it resets at 00:00 UTC')]);
    r = await s.say('d');
    expect(r.out.map((x) => x.text)).toEqual([T.HELP_TEXT]);
    expect(s.calls).toHaveLength(2);
    expect((await MA.loadAssistantUsage(new Date(T0))).calls).toBe(2);
    s.clock.set(Date.parse('2026-10-28T00:00:01Z'));
    r = await s.say('e');
    expect(r.out[0]!.text).toMatch(/^Assistant: /);
    expect(s.calls).toHaveLength(3);
  });

  it('/assistant off writes assistant.json and plain text then gets the fallback; on switches it back; status shows calls, limit and the last error', async () => {
    const s = await stack({ reply: (c) => (c.stdin.message === 'fail' ? { code: 1, stdout: '', stderr: 'boom' } : answer('ok')) });
    await s.say('hello');
    await s.say('fail');
    let r = await s.say('/assistant off');
    expect(r.out[0]!.text).toMatch(/^Assistant switched off/);
    expect((await MA.loadAssistantConfig())?.enabled).toBe(false);
    r = await s.say('hello again');
    expect(r.out.map((x) => x.text)).toEqual([T.fallbackText('switched off')]);
    r = await s.say('/assistant on');
    expect(r.out[0]!.text).toMatch(/^Assistant switched on/);
    expect((await MA.loadAssistantConfig())?.enabled).toBe(true);
    r = await s.say('/assistant status');
    expect(r.out[0]!.text).toMatch(/^Assistant: on \(sonnet\), 2 of 50 calls today; last error 2026-10-27T10:00:00\.000Z: claude exited with code 1: boom/);
    r = await s.say('/assistant sideways');
    expect(r.out[0]!.text).toMatch(/^Usage: \/assistant \[on\|off\|status\]/);
    r = await s.say('/status');
    expect(r.out[0]!.text).toContain('assistant: on (sonnet), 2 of 50 calls today; last error');
    expect(s.calls).toHaveLength(2);
  });

  it('/assistant on when it is not set up points to minions setup and writes nothing', async () => {
    const s = await stack({ config: null });
    const { out } = await s.say('/assistant on');
    expect(out[0]!.text).toContain('not set up: run `minions setup`');
    expect(await MA.loadAssistantConfig()).toBeNull();
  });
});

// ---------------------------------------------------------------- failure and fallback

describe('every failure falls back to the help text (one reply, the reason, the commands)', () => {
  const cases: { name: string; o: Parameters<typeof stack>[0]; reason: RegExp; recorded: boolean; spawned: boolean }[] = [
    { name: 'not set up', o: { config: null }, reason: /^not set up/, recorded: false, spawned: false },
    { name: 'switched off', o: { config: { enabled: false } }, reason: /^switched off$/, recorded: false, spawned: false },
    { name: 'no Claude token', o: { credential: null }, reason: /^no Claude token stored/, recorded: true, spawned: false },
    { name: 'claude not on PATH', o: { probe: async () => ({ ok: false, reason: 'Claude Code (`claude`) is not on PATH' }) }, reason: /not on PATH/, recorded: true, spawned: false },
    { name: 'claude too old', o: { probe: async () => ({ ok: false, reason: 'Claude Code 1.0.0 is older than 2.0.0; update it (`claude update`)' }) }, reason: /older than/, recorded: true, spawned: false },
    { name: 'a timeout', o: { reply: () => ({ code: 124, stdout: '', stderr: '', timedOut: true }) }, reason: /^no answer within 60 s$/, recorded: true, spawned: true },
    { name: 'a non-zero exit', o: { reply: () => ({ code: 2, stdout: '', stderr: 'crashed' }) }, reason: /^claude exited with code 2: crashed$/, recorded: true, spawned: true },
    { name: 'output over the cap', o: { reply: () => ({ code: 125, stdout: '{"type":', stderr: '', outputLimited: true }) }, reason: /^the answer exceeded 64 KiB$/, recorded: true, spawned: true },
    { name: 'output that is not JSON', o: { reply: () => ({ code: 0, stdout: 'Sure! Here you go.', stderr: '' }) }, reason: /not the expected JSON/, recorded: true, spawned: true },
    { name: 'an auth error (401)', o: { reply: () => ({ code: 1, stdout: '', stderr: 'API Error: 401 {"type":"authentication_error"}' }) }, reason: /minions setup/, recorded: true, spawned: true },
    { name: 'a result without reply text', o: { reply: () => answer('', null, { result: '', structured_output: { proposal: null } }) }, reason: /no reply text/, recorded: true, spawned: true },
    { name: 'a throwing runner', o: { reply: () => { throw new Error('spawn EACCES'); } }, reason: /could not run claude: spawn EACCES/, recorded: true, spawned: true },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const s = await stack(c.o);
      const { out } = await s.say('switch to manual merges');
      expect(out).toHaveLength(1);
      const text = out[0]!.text;
      const m = /^Assistant unavailable \((.*)\)\. Commands:\n/.exec(text);
      expect(m, text).not.toBeNull();
      expect(m![1]).toMatch(c.reason);
      expect(text.endsWith(T.HELP_TEXT.split('\n').slice(1).join('\n'))).toBe(true);
      expect(text).not.toContain(CLAUDE_TOKEN);
      expect(journal()).toEqual([]);
      expect(s.calls.length > 0).toBe(c.spawned);
      const usage = await MA.loadAssistantUsage(new Date(T0));
      expect(usage.lastError !== null).toBe(c.recorded);
      // A call that never spawned does not count.
      expect(usage.calls).toBe(c.spawned ? 1 : 0);
      // Never a retry or a second strategy.
      expect(s.calls.length).toBeLessThanOrEqual(1);
      // The manager keeps working: a command right after is answered normally.
      const after = await s.say('/help');
      expect(after.out.map((x) => x.text)).toEqual([T.HELP_TEXT]);
    });
  }
});
