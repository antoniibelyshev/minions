// Host manager bot, part 1 (task-53.5.1): the manager-bot-token credential, the bot-id guard in both directions,
// terminal pairing in `minions setup`, and the doctor manager.* checks. Temp MINIONS_HOME, file credential store,
// fake Bot API (fetch) and fake clock: no Keychain, network, Docker or live state.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), 'coordinator\n');
      return [];
    },
  };
});

const C = await import('../../src/host/credentials.js');
const M = await import('../../src/host/manager-bot.js');
const { assertManagerBotDistinct, assertNotManagerBot, managerBotClash } = await import('../../src/host/bot-guard.js');
const { managerChecks, runDoctor, formatDoctor } = await import('../../src/host/doctor.js');
const { runSetup, formatSetup } = await import('../../src/host/setup.js');
const { composeYaml } = await import('../../src/host/docker.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const { saveRegistry } = await import('../../src/host/registry.js');
const { credentialStoreDir, managerPaths, projectPaths } = await import('../../src/core/paths.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');
type RunResult = import('../../src/core/exec.js').RunResult;
type RunOptions = import('../../src/core/exec.js').RunOptions;
type TelegramUpdate = import('../../src/host/manager-bot.js').TelegramUpdate;
type SetupRuntime = import('../../src/host/setup.js').SetupRuntime;

const A = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const COORD = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const MGR = '555666777:MMHmanagermanagermanagermanager_-9876';
const MGR2 = '888999000:NNHsecondmanagersecondmanagerzz_-5432';
const MGR_SECRET = MGR.split(':')[1]!;
const OWNER = 4242;

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

/** The MinionsError a promise rejects with (fails the test when it resolves). */
const refused = (): never => { throw new Error('expected a refusal'); };
const caught = (x: unknown) => x as InstanceType<typeof MinionsError>;
const mode = (p: string) => statSync(p).mode & 0o777;
const managerFile = () => join(env.home, 'credentials', 'manager', 'manager-bot-token');

/** Every regular file under `dir` (recursive). */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}
/** Files under MINIONS_HOME that contain the manager token's secret part. */
const filesWithSecret = (secret = MGR_SECRET) => filesUnder(env.home).filter((f) => readFileSync(f, 'utf8').includes(secret));

function recorder(handler: (c: { cmd: string; args: string[]; opts?: RunOptions }) => RunResult | undefined = () => undefined) {
  const calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
  const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    const c = { cmd, args, opts };
    calls.push(c);
    return handler(c) ?? { code: 1, stdout: '', stderr: 'unavailable' };
  };
  return { calls, runner };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msg = (update_id: number, text: string, o: { from?: number; chat?: number; type?: string; bot?: boolean } = {}): TelegramUpdate => ({
  update_id, message: { text, from: { id: o.from ?? OWNER, is_bot: o.bot ?? false }, chat: { id: o.chat ?? o.from ?? OWNER, type: o.type ?? 'private' } },
});

/**
 * Fake Bot API with a fake clock. getUpdates hands out `batches` one by one (filtered by offset); when they run out,
 * a long poll "waits" its timeout on the clock. `statuses` overrides the HTTP status of the next getUpdates calls;
 * the string 'throw' makes the call fail like a network error.
 */
function botApi(batches: TelegramUpdate[][] = [], o: { statuses?: (number | 'throw')[]; username?: string; getMe?: number } = {}) {
  const calls: { token: string; method: string; body: Record<string, unknown> }[] = [];
  const clock = { t: Date.parse('2026-10-26T12:00:00Z') };
  const statuses = [...(o.statuses ?? [])];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(String(url));
    if (!m) throw new Error(`unexpected url ${String(url)}`);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ token: m[1]!, method: m[2]!, body });
    if (m[2] === 'getMe') return o.getMe && o.getMe !== 200 ? json(o.getMe, { ok: false }) : json(200, { ok: true, result: { id: 1, is_bot: true, username: o.username ?? 'acme_manager_bot' } });
    if (m[2] === 'sendMessage') return json(200, { ok: true, result: {} });
    if (m[2] === 'getUpdates') {
      if (body.timeout === 0) return json(200, { ok: true, result: [] });
      const st = statuses.shift();
      if (st === 'throw') throw new TypeError('fetch failed');
      if (st !== undefined && st !== 200) return json(st, { ok: false, description: 'error' });
      const b = batches.shift();
      if (!b) { clock.t += Number(body.timeout ?? 0) * 1000 + 1000; return json(200, { ok: true, result: [] }); }
      const offset = typeof body.offset === 'number' ? body.offset : 0;
      return json(200, { ok: true, result: b.filter((u) => u.update_id >= offset) });
    }
    return json(404, { ok: false });
  }) as typeof fetch;
  return { f, calls, clock, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms; } };
}

async function registerProjects(...ids: string[]) {
  await saveRegistry({ version: 1, projects: Object.fromEntries(ids.map((id) => [id, { gitCommonDir: `/r/${id}/.git`, repoPath: `/r/${id}`, visibility: 'private' as const }])) });
}

// ---------------------------------------------------------------- credential

describe('manager-bot-token credential', () => {
  it('file store: <MINIONS_HOME>/credentials/manager/manager-bot-token (0600, dir 0700); the reference holds no token', async () => {
    const r = await M.provisionManagerToken({ token: `  ${MGR}\n` });
    expect(r).toMatchObject({ backend: 'file', botId: '555666777', verification: null, pairingCleared: false });
    expect(new C.FileStore(C.MANAGER_CREDENTIAL).path(C.MANAGER_ACCOUNT)).toBe(managerFile());
    expect(r.ref).toBe(`file:${managerFile()}`);
    expect(readFileSync(managerFile(), 'utf8')).toBe(MGR + '\n');
    expect(mode(managerFile())).toBe(0o600);
    expect(mode(join(credentialStoreDir(), 'manager'))).toBe(0o700);
    const ref = JSON.parse(readFileSync(managerPaths().credentialJson, 'utf8'));
    expect(ref).toMatchObject({ version: 1, backend: 'file', botId: '555666777' });
    expect(JSON.stringify(ref)).not.toContain(MGR_SECRET);
    expect(mode(managerPaths().credentialJson)).toBe(0o600);
    expect(mode(managerPaths().dir)).toBe(0o700);
    expect(await C.readManagerToken()).toBe(MGR);
    expect(filesWithSecret()).toEqual([managerFile()]);
  });

  it('Keychain service minions.manager / Secret Service service=minions.manager, account manager; the token only on stdin', async () => {
    let stored: string | null = null;
    const kc = recorder(({ cmd, args, opts }) => {
      if (cmd !== 'security') return undefined;
      if (args[0] === '-i') { stored = / -w (\S+)\n$/.exec(opts?.input ?? '')?.[1] ?? null; return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'find-generic-password') return stored ? { code: 0, stdout: stored + '\n', stderr: '' } : { code: 44, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const ks = new C.KeychainStore(kc.runner, C.MANAGER_CREDENTIAL);
    await ks.set(C.MANAGER_ACCOUNT, MGR);
    expect(kc.calls.find((c) => c.args[0] === '-i')!.opts?.input)
      .toBe(`add-generic-password -U -s minions.manager -a manager -l minions-manager-bot-token -w ${MGR}\n`);
    expect(ks.ref(C.MANAGER_ACCOUNT)).toBe('keychain:minions.manager/manager');
    for (const c of kc.calls) expect(c.args.join(' ')).not.toContain(MGR_SECRET);

    const items = new Map<string, string>();
    const ss = recorder(({ cmd, args, opts }) => {
      if (cmd !== 'secret-tool') return undefined;
      const key = `${args[args.indexOf('service') + 1]}/${args[args.indexOf('account') + 1]}`;
      if (args[0] === 'store') { items.set(key, opts?.input ?? ''); return { code: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'lookup') { const v = items.get(key); return v === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: v, stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    });
    await new C.SecretServiceStore(ss.runner, C.MANAGER_CREDENTIAL).set(C.MANAGER_ACCOUNT, MGR);
    expect(ss.calls[0]!.args).toEqual(['store', '--label=minions-manager-bot-token', 'service', 'minions.manager', 'account', 'manager']);
    expect([...items.keys()]).toEqual(['minions.manager/manager']);
    for (const c of ss.calls) expect(c.args.join(' ')).not.toContain(MGR_SECRET);
  });

  it('store accounts: the manager kind only takes the fixed account, project kinds never take it', async () => {
    await expect(new C.FileStore(C.MANAGER_CREDENTIAL).set(A, MGR)).rejects.toMatchObject({ code: 'INTERNAL' });
    await expect(new C.FileStore(C.TELEGRAM_CREDENTIAL).set(C.MANAGER_ACCOUNT, COORD)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(C.CREDENTIAL_KINDS.map((k) => k.name)).not.toContain('manager-bot-token');
  });

  it('format check: a non-token is refused and nothing is stored; the input never appears in the error', async () => {
    const bad = 'not-a-token secret-ish-value';
    const e = await M.provisionManagerToken({ token: bad }).then(refused, caught);
    expect(e).toMatchObject({ code: 'INVALID_CONFIG' });
    expect(`${e.message} ${e.hint}`).not.toContain(bad);
    expect(existsSync(managerFile())).toBe(false);
    expect(existsSync(managerPaths().credentialJson)).toBe(false);
  });

  it('getMe only with consent; a token Telegram rejects is not stored', async () => {
    const api = botApi();
    await M.provisionManagerToken({ token: MGR, fetch: api.f });
    expect(api.calls).toEqual([]);
    const ok = await M.provisionManagerToken({ token: MGR, verify: true, fetch: api.f });
    expect(ok.verification).toMatchObject({ status: 'ok', login: 'acme_manager_bot' });
    expect(api.calls.map((c) => c.method)).toEqual(['getMe']);
    await C.removeManagerToken();
    await expect(M.provisionManagerToken({ token: MGR, verify: true, fetch: botApi([], { getMe: 401 }).f })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(existsSync(managerFile())).toBe(false);
  });

  it('is never materialized: not in projects/<id>/secrets, credentials.json, compose.yaml, doctor or setup --json output', async () => {
    const repo = makeRepo(env.root);
    const api = botApi([[msg(1, 'K7QP-M3XA')]]);
    const r = await runSetup({
      path: repo, yes: true, tokens: { telegram: COORD, manager: MGR }, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: api.f,
    });
    expect(r.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'done', detail: expect.stringMatching(/^bot 555666777 stored in a 0600 host file; not paired/) });
    const id = r.projectId;
    const secretsBefore = await C.materializeSecrets(id);
    expect(secretsBefore).toEqual({ github: false, telegram: true, codex: false });
    const p = projectPaths(id);
    expect(readdirSync(p.secretsDir).sort()).toEqual(['telegram-bot-token']);
    expect(readFileSync(p.telegramTokenFile, 'utf8')).toBe(COORD + '\n');
    const compose = composeYaml(await loadProjectJson(id));
    expect(compose).not.toContain(MGR_SECRET);
    expect(compose).not.toContain('manager-bot-token');
    expect(readFileSync(p.credentialsJson, 'utf8')).not.toContain('555666777');
    const doctor = await runDoctor({ cwd: repo, probe: dockerUp, runner: recorder().runner, platform: 'darwin', fingerprint: null });
    const out = JSON.stringify({ r, doctor }) + formatSetup(r) + formatDoctor(doctor);
    expect(out).not.toContain(MGR_SECRET);
    // The only file on disk that holds the token is the 0600 store file.
    expect(filesWithSecret()).toEqual([managerFile()]);
    await C.clearSecrets(id);
    expect(await C.readManagerToken()).toBe(MGR);
  });

  it('readManagerToken refuses a stored value whose bot id differs from the reference; remove deletes both', async () => {
    await M.provisionManagerToken({ token: MGR });
    writeFileSync(managerFile(), MGR2 + '\n', { mode: 0o600 });
    await expect(C.readManagerToken()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect((await C.managerCredentialStatus()).state).toBe('invalid');
    expect(await C.removeManagerToken()).toEqual({ removed: true, backend: 'file' });
    expect(existsSync(managerFile())).toBe(false);
    expect(existsSync(managerPaths().credentialJson)).toBe(false);
    expect(await C.readManagerToken()).toBeNull();
  });
});

// ---------------------------------------------------------------- bot-id guard

describe('bot-id guard, both directions', () => {
  it('a manager token that is a registered project\'s coordinator bot is refused (CONFLICT); nothing is stored', async () => {
    await registerProjects(A, B);
    const repo = makeRepo(env.root);
    await C.provisionTelegramToken({ projectId: B, token: COORD, repoPath: repo });
    const e = await M.provisionManagerToken({ token: COORD }).then(refused, caught);
    expect(e).toBeInstanceOf(MinionsError);
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toContain(`Telegram bot 123456789 is the coordinator bot of project(s) ${B}`);
    expect(JSON.stringify({ m: e.message, h: e.hint, d: e.details })).not.toContain(COORD.split(':')[1]!);
    expect(existsSync(managerFile())).toBe(false);
    await expect(assertManagerBotDistinct('555666777')).resolves.toBeUndefined();
  });

  it('a coordinator token that is the manager bot is refused for every project (auth telegram, init, setup share provisionTelegramToken)', async () => {
    await registerProjects(A);
    const repo = makeRepo(env.root);
    await M.provisionManagerToken({ token: MGR });
    const e = await C.provisionTelegramToken({ projectId: A, token: MGR, repoPath: repo }).then(refused, caught);
    expect(e).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining("Telegram bot 555666777 is the host manager's bot") });
    expect(JSON.stringify({ m: e.message, h: e.hint })).not.toContain(MGR_SECRET);
    expect((await C.loadCredentialRefs(A)).telegram).toBeUndefined();
    expect(existsSync(join(credentialStoreDir(), A, 'telegram-bot-token'))).toBe(false);
    await expect(assertNotManagerBot('555666777')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(assertNotManagerBot('123456789')).resolves.toBeUndefined();
    // A different bot is fine.
    await expect(C.provisionTelegramToken({ projectId: A, token: COORD, repoPath: repo })).resolves.toMatchObject({ botId: '123456789' });
  });

  it('fails closed: an unreadable manager reference refuses a coordinator token', async () => {
    await registerProjects(A);
    const repo = makeRepo(env.root);
    mkdirSync(managerPaths().dir, { recursive: true });
    writeFileSync(managerPaths().credentialJson, '{ not json');
    await expect(C.provisionTelegramToken({ projectId: A, token: COORD, repoPath: repo })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining("Cannot compare with the host manager's bot") });
    expect((await C.loadCredentialRefs(A)).telegram).toBeUndefined();
  });

  it('setup: a manager token equal to this project\'s own coordinator bot fails the manager step and stores nothing', async () => {
    const repo = makeRepo(env.root);
    const r = await runSetup({ path: repo, yes: true, tokens: { telegram: COORD, manager: COORD }, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(r.steps.find((s) => s.id === 'telegram')?.status).toBe('done');
    expect(r.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/is the coordinator bot of project\(s\) .*nothing was stored/) });
    expect(existsSync(managerFile())).toBe(false);
    expect(JSON.stringify(r)).not.toContain(COORD.split(':')[1]!);
  });

  it('managerBotClash reports the stored manager bot against the coordinator bots (doctor)', async () => {
    expect(await managerBotClash()).toBeNull();
    await registerProjects(A);
    await M.provisionManagerToken({ token: MGR });
    expect(await managerBotClash()).toEqual({ botId: '555666777', projects: [] });
    // Simulate a reference written before the guard existed: project A records the manager's bot.
    mkdirSync(projectPaths(A).dir, { recursive: true });
    writeFileSync(projectPaths(A).credentialsJson, JSON.stringify({ version: 1, telegram: { backend: 'file', ref: 'file:x', botId: '555666777', updatedAt: 'now' } }));
    expect(await managerBotClash()).toEqual({ botId: '555666777', projects: [A] });
  });
});

// ---------------------------------------------------------------- pairing

describe('terminal pairing', () => {
  it('pairs the private-chat sender of the code; groups, bots, other text and earlier updates are skipped', async () => {
    await M.provisionManagerToken({ token: MGR });
    const api = botApi([
      [msg(10, 'hello'), msg(11, 'K7QP-M3XA', { chat: -100123, type: 'group' }), msg(12, 'K7QP-M3XA', { from: 999, bot: true })],
      [msg(13, 'K7QP-M3XB', { from: 777 })],
      [msg(14, ' k7qp m3xa ', { from: OWNER })],
    ]);
    let shown = '';
    const r = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: api.f, now: api.now, sleep: api.sleep, code: 'K7QP-M3XA', onCode: (c) => { shown = c; } });
    expect(shown).toBe('K7QP-M3XA');
    expect(r).toMatchObject({ status: 'paired', access: { version: 1, botId: '555666777', userId: OWNER, chatId: OWNER } });
    const access = JSON.parse(readFileSync(managerPaths().accessJson, 'utf8'));
    expect(access).toEqual({ version: 1, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: '2026-10-26T12:00:00.000Z' });
    expect(mode(managerPaths().accessJson)).toBe(0o600);
    expect(readFileSync(managerPaths().accessJson, 'utf8')).not.toContain(MGR_SECRET);
    // Offsets advance past every seen update; the code message is acknowledged; one confirmation goes to the owner.
    const polls = api.calls.filter((c) => c.method === 'getUpdates');
    expect(polls.map((c) => c.body.offset)).toEqual([undefined, 13, 14, 15]);
    expect(polls[0]!.body.allowed_updates).toEqual(['message']);
    expect(polls.at(-1)!.body.timeout).toBe(0);
    const sent = api.calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.chat_id).toBe(OWNER);
    expect(String(sent[0]!.body.text)).not.toContain(MGR_SECRET);
    expect(await M.loadManagerAccess()).toMatchObject({ userId: OWNER });
  });

  it('expires after 10 minutes without recording anything; an existing pairing stays unchanged', async () => {
    const old = { version: 1 as const, botId: '555666777', userId: 1111, chatId: 1111, pairedAt: '2026-10-01T00:00:00.000Z' };
    await M.saveManagerAccess(old);
    const api = botApi([[msg(1, 'WRONG-CODE')]]);
    const start = api.now();
    const r = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: api.f, now: api.now, sleep: api.sleep, code: 'AAAA-BBBB' });
    expect(r).toMatchObject({ status: 'expired', detail: expect.stringContaining('within 10 minutes') });
    expect(api.now() - start).toBeGreaterThanOrEqual(M.PAIRING_TTL_MS);
    expect(api.now() - start).toBeLessThan(M.PAIRING_TTL_MS + 60_000);
    // Each long poll waits at most the time left.
    for (const c of api.calls) expect(Number(c.body.timeout)).toBeLessThanOrEqual(25);
    expect(await M.loadManagerAccess()).toEqual(old);
  });

  it('409 is "another process polls the manager bot"; 401 is a rejected token; network errors and 5xx are retried; never the token', async () => {
    const conflict = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: botApi([], { statuses: [409] }).f, code: 'AAAA-BBBB' }).then(refused, caught);
    expect(conflict).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Another process polls the manager bot') });
    const denied = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: botApi([], { statuses: [401] }).f, code: 'AAAA-BBBB' }).then(refused, caught);
    expect(denied).toMatchObject({ code: 'AUTH_REQUIRED' });
    for (const e of [conflict, denied]) expect(`${e.message} ${e.hint}`).not.toContain(MGR_SECRET);
    const flaky = botApi([[msg(5, 'AAAA-BBBB')]], { statuses: ['throw', 502] });
    const r = await M.pairManagerBot({ token: MGR, botId: '555666777', fetch: flaky.f, now: flaky.now, sleep: flaky.sleep, code: 'AAAA-BBBB' });
    expect(r.status).toBe('paired');
    expect(existsSync(managerPaths().accessJson)).toBe(true);
  });

  it('codes are 8 characters from an unambiguous alphabet; isOwnerUpdate accepts only the paired private chat', () => {
    const codes = new Set(Array.from({ length: 50 }, () => M.pairingCode()));
    expect(codes.size).toBeGreaterThan(45);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const access = { version: 1 as const, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: 'x' };
    expect(M.isOwnerUpdate(access, msg(1, 'hi'))).toBe(true);
    expect(M.isOwnerUpdate(access, { update_id: 2, callback_query: { from: { id: OWNER }, message: { chat: { id: OWNER, type: 'private' } } } })).toBe(true);
    expect(M.isOwnerUpdate(access, msg(3, 'hi', { from: 777 }))).toBe(false);
    expect(M.isOwnerUpdate(access, msg(4, 'hi', { chat: -100, type: 'group' }))).toBe(false);
    expect(M.isOwnerUpdate(access, msg(5, 'hi', { type: 'group' }))).toBe(false);
    expect(M.isOwnerUpdate(access, { update_id: 6 })).toBe(false);
  });

  it('a token of a different bot clears the old pairing; the same bot keeps it', async () => {
    await M.provisionManagerToken({ token: MGR });
    await M.saveManagerAccess({ version: 1, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: 'x' });
    expect((await M.provisionManagerToken({ token: MGR })).pairingCleared).toBe(false);
    expect(await M.loadManagerAccess()).not.toBeNull();
    expect((await M.provisionManagerToken({ token: MGR2 })).pairingCleared).toBe(true);
    expect(await M.loadManagerAccess()).toBeNull();
  });
});

// ---------------------------------------------------------------- setup

function scripted(answers: Record<string, string> = {}, secrets: string[] = []) {
  const asked: string[] = [];
  const info: string[] = [];
  return {
    asked, info,
    io: {
      ask: async (q: string, def: string) => {
        asked.push(q);
        const key = Object.keys(answers).find((k) => q.startsWith(k));
        return key ? answers[key]! : def;
      },
      info: (l: string) => { info.push(l); },
      secret: async (prompt: string) => { asked.push(`secret:${prompt}`); return secrets.shift() ?? ''; },
    },
  };
}

function fakeRuntime(): SetupRuntime {
  return {
    containerRunning: async () => false,
    start: async () => undefined,
    repoPresent: async () => true,
    importRepo: async () => { throw new Error('not used'); },
    launchCoordinator: async () => ({ action: 'started' }),
    attachCommand: () => 'attach',
  };
}

describe('minions setup: host manager bot step', () => {
  it('interactive: hidden token prompt, optional getMe, then the one-time code; records the owner', async () => {
    const repo = makeRepo(env.root);
    const api = botApi([[msg(7, 'K7QP-M3XA')]]);
    const a = scripted({ 'Installation visibility': 'private', 'Set up the host manager bot': 'y', 'Check the token with Telegram': 'y' }, [MGR]);
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: api.f,
      managerPairing: { now: api.now, sleep: api.sleep, code: 'K7QP-M3XA' } });
    const order = ['Set up the host manager bot', 'secret:Manager bot token', 'Check the token with Telegram', 'Pair your Telegram account'];
    const idx = order.map((q) => a.asked.findIndex((x) => x.startsWith(q)));
    expect(idx.every((i) => i >= 0), JSON.stringify(a.asked)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    expect(a.info.join('\n')).toContain('Send this one-time code to @acme_manager_bot in a private chat (not a group) within 10 minutes');
    expect(a.info.join('\n')).toContain('K7QP-M3XA');
    expect(r.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'done', detail: `bot 555666777 stored in a 0600 host file; paired with Telegram user ${OWNER} (private chat)` });
    expect(await M.loadManagerAccess()).toMatchObject({ botId: '555666777', userId: OWNER, chatId: OWNER });
    expect(api.calls.map((c) => c.method)).toEqual(['getMe', 'getUpdates', 'getUpdates', 'sendMessage']);
    expect(JSON.stringify(r) + formatSetup(r) + a.info.join('\n') + a.asked.join('\n')).not.toContain(MGR_SECRET);
    expect(filesWithSecret()).toEqual([managerFile()]);

    // Rerun: paired, so keep is the default; nothing is asked for the token and Telegram is not contacted.
    const again = scripted({ 'Project configuration': 'keep' });
    const n = api.calls.length;
    const r2 = await runSetup({ path: repo, yes: false, io: again.io, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: api.f });
    expect(again.asked.some((q) => q.startsWith('The host manager bot is set up (bot 555666777, paired)'))).toBe(true);
    expect(r2.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'kept', detail: `bot 555666777; paired with Telegram user ${OWNER}` });
    expect(api.calls.length).toBe(n);
  });

  it('re-pairing is a terminal action: "pair" replaces the owner only when the new code arrives; "remove" clears everything', async () => {
    const repo = makeRepo(env.root);
    await M.provisionManagerToken({ token: MGR });
    await M.saveManagerAccess({ version: 1, botId: '555666777', userId: 1111, chatId: 1111, pairedAt: 'x' });
    const expired = botApi();
    const a = scripted({ 'Installation visibility': 'private', 'The host manager bot is set up': 'pair' });
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: expired.f,
      managerPairing: { now: expired.now, sleep: expired.sleep, code: 'AAAA-BBBB' } });
    expect(r.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'failed', detail: expect.stringContaining('pairing code expired') });
    expect((await M.loadManagerAccess())?.userId).toBe(1111);
    // The token was read from the store for pairing, never prompted for again.
    expect(a.asked.some((q) => q.startsWith('secret:'))).toBe(false);
    expect(expired.calls.every((c) => c.token === MGR)).toBe(true);

    const ok = botApi([[msg(3, 'CCCC-DDDD', { from: 2222 })]]);
    const b = scripted({ 'Project configuration': 'keep', 'The host manager bot is set up': 'pair' });
    const r2 = await runSetup({ path: repo, yes: false, io: b.io, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: ok.f,
      managerPairing: { now: ok.now, sleep: ok.sleep, code: 'CCCC-DDDD' } });
    expect(r2.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'changed', detail: 'bot 555666777; paired with Telegram user 2222 (private chat)' });
    expect((await M.loadManagerAccess())?.userId).toBe(2222);

    const c = scripted({ 'Project configuration': 'keep', 'The host manager bot is set up': 'remove' });
    const r3 = await runSetup({ path: repo, yes: false, io: c.io, runtime: fakeRuntime(), dockerProbe: dockerUp });
    expect(r3.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'changed', detail: 'manager bot token removed (file); pairing cleared' });
    expect(existsSync(managerFile())).toBe(false);
    expect(await M.loadManagerAccess()).toBeNull();
  });

  it('--yes: skipped without a piped token and never pairs; a piped token is stored without contacting Telegram', async () => {
    const repo = makeRepo(env.root);
    const api = botApi();
    const r = await runSetup({ path: repo, yes: true, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: api.f });
    expect(r.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'skipped', detail: expect.stringContaining('not set up (optional)') });
    const r2 = await runSetup({ path: repo, yes: true, tokens: { manager: MGR }, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: api.f });
    expect(r2.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'done', lines: [expect.stringMatching(/^not paired: Run `minions setup .*` again in a terminal/)] });
    expect(api.calls).toEqual([]);
    expect(await C.readManagerToken()).toBe(MGR);
    const r3 = await runSetup({ path: repo, yes: true, runtime: fakeRuntime(), dockerProbe: dockerUp, fetch: api.f });
    expect(r3.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'kept', detail: 'bot 555666777; not paired' });
  });

  it('an empty piped manager token fails before anything is written, naming its stdin line', async () => {
    const repo = makeRepo(env.root);
    await expect(runSetup({ path: repo, yes: true, tokens: { github: 'x', telegram: COORD, manager: ' ' }, runtime: fakeRuntime() }))
      .rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringContaining('--manager-token-stdin'), hint: expect.stringContaining('third line') });
    await expect(runSetup({ path: repo, yes: true, tokens: { manager: '' }, runtime: fakeRuntime() }))
      .rejects.toMatchObject({ hint: expect.stringContaining('first line') });
    expect(existsSync(managerPaths().dir)).toBe(false);
  });

  it('--dry-run plans the step without prompting or storing', async () => {
    const repo = makeRepo(env.root);
    const r = await runSetup({ path: repo, yes: false, dryRun: true, runtime: fakeRuntime() });
    expect(r.steps.find((s) => s.id === 'manager')).toMatchObject({ status: 'planned', detail: expect.stringContaining('one-time pairing code') });
    expect(r.steps.find((s) => s.id === 'service')).toMatchObject({ status: 'planned', detail: expect.stringContaining('systemd --user unit') });
  });
});

// ---------------------------------------------------------------- setup / uninstall: the manager service (task-53.6)

describe('minions setup and uninstall: host manager service', () => {
  /** systemctl / launchctl / loginctl answered by a fake; the "home" is a temp dir. */
  function serviceFake(platform: NodeJS.Platform = 'linux') {
    const calls: string[] = [];
    const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'launchctl' && args[0] === 'print') return { code: 113, stdout: '', stderr: 'not loaded' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const home = join(env.root, 'userhome');
    return { calls, home, managerService: { platform, home, runner, uid: 501, user: null, program: ['/usr/bin/env', 'node', '/opt/cli.js', 'manager', 'run'] } };
  }
  const svcStep = (r: { steps: { id: string }[] }) => r.steps.find((s) => s.id === 'service');

  it('no token and no service: no step; --yes never installs; interactive asks (default no) and installs on yes', async () => {
    const repo = makeRepo(env.root);
    const f = serviceFake();
    const none = await runSetup({ path: repo, yes: true, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(svcStep(none)).toBeUndefined();
    const piped = await runSetup({ path: repo, yes: true, tokens: { manager: MGR }, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(svcStep(piped)).toMatchObject({ status: 'skipped', detail: expect.stringContaining('an interactive setup asks') });
    expect(f.calls).toEqual([]);

    // Interactive, default answer: not installed.
    const dflt = scripted({ 'Project configuration': 'keep' });
    const r0 = await runSetup({ path: repo, yes: false, io: dflt.io, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(dflt.asked.some((q) => q.startsWith('Install the host manager as a systemd --user unit'))).toBe(true);
    expect(svcStep(r0)).toMatchObject({ status: 'skipped' });
    expect(f.calls).toEqual([]);

    const yes = scripted({ 'Project configuration': 'keep', 'Install the host manager': 'y' });
    const r1 = await runSetup({ path: repo, yes: false, io: yes.io, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(svcStep(r1)).toMatchObject({ status: 'done', detail: expect.stringMatching(/^systemd --user unit installed and started \(.*userhome\/\.config\/systemd\/user\/minions-manager-[0-9a-f]{8}\.service\)$/) });
    expect(f.calls).toContain('systemctl --user daemon-reload');
    expect(formatSetup(r1)).toContain('service');
    // The token never reaches the unit file.
    const rec = JSON.parse(readFileSync(managerPaths().serviceJson, 'utf8')) as { path: string };
    expect(readFileSync(rec.path, 'utf8')).not.toContain(MGR_SECRET);

    // Rerun: keep is the default and an unchanged unit is only started; --yes keeps it up to date too.
    f.calls.length = 0;
    const keep = scripted({ 'Project configuration': 'keep' });
    const r2 = await runSetup({ path: repo, yes: false, io: keep.io, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(keep.asked.some((q) => q.startsWith('The host manager runs as a systemd --user unit'))).toBe(true);
    expect(svcStep(r2)).toMatchObject({ status: 'kept', detail: expect.stringContaining('up to date') });
    expect(f.calls.filter((c) => c.startsWith('systemctl'))).toEqual([expect.stringContaining('enable'), expect.stringContaining('start minions-manager')]);
    const r3 = await runSetup({ path: repo, yes: true, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(svcStep(r3)).toMatchObject({ status: 'kept' });

    // A changed token restarts the running manager (it reads token and pairing at start).
    f.calls.length = 0;
    const r4 = await runSetup({ path: repo, yes: true, tokens: { manager: MGR2 }, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(svcStep(r4)).toMatchObject({ status: 'kept', detail: expect.stringContaining('restarted for the new token or pairing') });
    expect(f.calls.some((c) => /^systemctl --user restart minions-manager/.test(c))).toBe(true);

    // Removing the token removes the service as well.
    f.calls.length = 0;
    const rm = scripted({ 'Project configuration': 'keep', 'The host manager bot is set up': 'remove' });
    const r5 = await runSetup({ path: repo, yes: false, io: rm.io, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(svcStep(r5)).toMatchObject({ status: 'changed', detail: expect.stringContaining('the manager service was removed') });
    expect(existsSync(rec.path)).toBe(false);
    expect(existsSync(managerPaths().serviceJson)).toBe(false);
    expect(f.calls[0]).toMatch(/^systemctl --user disable --now minions-manager/);
  });

  it('a corrupt or foreign service.json never fails setup: ignored with a warning, then rewritten or removed', async () => {
    const repo = makeRepo(env.root);
    const f = serviceFake();
    const victim = join(env.root, 'sshd.service');
    writeFileSync(victim, 'keep');
    const corrupt = (text: string) => { mkdirSync(managerPaths().dir, { recursive: true }); writeFileSync(managerPaths().serviceJson, text); };
    const foreign = JSON.stringify({ version: 1, kind: 'systemd', name: 'sshd.service', path: victim, sha256: 'x', installedAt: 't' });
    const noFail = (r: { steps: { status: string }[] }) => expect(r.steps.filter((s) => s.status === 'failed')).toEqual([]);

    // No token: the record is removed (only this home's own default unit is disabled), setup succeeds.
    for (const text of ['{oops', foreign]) {
      corrupt(text);
      f.calls.length = 0;
      const r = await runSetup({ path: repo, yes: true, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
      noFail(r);
      expect(svcStep(r)).toMatchObject({ status: 'changed', lines: [expect.stringContaining('ignored the invalid manager service record')] });
      expect(existsSync(managerPaths().serviceJson)).toBe(false);
      expect(f.calls.join('\n')).not.toContain('sshd');
    }

    // With a token and --yes: skipped (never installs) with the warning, nothing touched.
    corrupt(foreign);
    f.calls.length = 0;
    const piped = await runSetup({ path: repo, yes: true, tokens: { manager: MGR }, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    noFail(piped);
    expect(svcStep(piped)).toMatchObject({ status: 'skipped', lines: [expect.stringContaining('ignored the invalid manager service record')] });
    expect(f.calls).toEqual([]);

    // Interactive install rewrites the record to this home's own unit.
    corrupt('{oops');
    const yes = scripted({ 'Project configuration': 'keep', 'Install the host manager': 'y' });
    const r = await runSetup({ path: repo, yes: false, io: yes.io, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    expect(svcStep(r)).toMatchObject({ status: 'done', lines: [expect.stringContaining('ignored the invalid manager service record')] });
    expect(JSON.parse(readFileSync(managerPaths().serviceJson, 'utf8'))).toMatchObject({ kind: 'systemd', name: expect.stringMatching(/^minions-manager-[0-9a-f]{8}\.service$/) });
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(f.calls.join('\n')).not.toContain('sshd');
  });

  it('macOS: a launchd agent; "remove" in the service step keeps the bot', async () => {
    const repo = makeRepo(env.root);
    await M.provisionManagerToken({ token: MGR });
    const f = serviceFake('darwin');
    const a = scripted({ 'Installation visibility': 'private', 'Install the host manager as a launchd agent': 'y' });
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime(), dockerProbe: dockerUp, platform: 'darwin', managerService: f.managerService });
    expect(svcStep(r)).toMatchObject({ status: 'done', detail: expect.stringContaining('launchd agent installed and started') });
    expect(f.calls.some((c) => c.startsWith('launchctl bootstrap gui/501 '))).toBe(true);
    const b = scripted({ 'Project configuration': 'keep', 'The host manager runs as a launchd agent': 'remove' });
    const r2 = await runSetup({ path: repo, yes: false, io: b.io, runtime: fakeRuntime(), dockerProbe: dockerUp, platform: 'darwin', managerService: f.managerService });
    expect(svcStep(r2)).toMatchObject({ status: 'changed', detail: expect.stringContaining('launchd agent removed') });
    expect(await C.readManagerToken()).toBe(MGR);
  });

  it('uninstall removes the service with the last registered project and keeps it while others remain', async () => {
    const { runUninstall, formatUninstall } = await import('../../src/host/uninstall.js');
    const S = await import('../../src/host/manager-service.js');
    const a = makeRepo(env.root, 'a');
    const b = makeRepo(env.root, 'b');
    const f = serviceFake();
    await runSetup({ path: a, yes: true, tokens: { manager: MGR }, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    await runSetup({ path: b, yes: true, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService: f.managerService });
    await S.installManagerService(S.serviceHost(f.managerService));
    const rec = (await S.loadServiceRecord())!;
    const docker = recorder(() => ({ code: 0, stdout: '', stderr: '' })).runner;

    const dry = await runUninstall({ cwd: a, dryRun: true, runner: docker, managerService: f.managerService });
    expect(dry.managerService).toBe('kept');
    const first = await runUninstall({ cwd: a, yes: true, runner: docker, managerService: f.managerService });
    expect(first.managerService).toBe('kept');
    expect(first.kept).toContainEqual({ path: rec.path, reason: 'host manager service kept: 1 other project(s) are registered' });
    expect(existsSync(rec.path)).toBe(true);

    f.calls.length = 0;
    const dry2 = await runUninstall({ cwd: b, dryRun: true, runner: docker, managerService: f.managerService });
    expect(dry2.managerService).toBe('removed');
    expect(formatUninstall(dry2)).toContain('Would remove the host manager service');
    expect(f.calls).toEqual([]);
    const last = await runUninstall({ cwd: b, yes: true, runner: docker, managerService: f.managerService });
    expect(last.managerService).toBe('removed');
    expect(last.removed).toContain(rec.path);
    expect(f.calls).toEqual([`systemctl --user disable --now ${rec.name}`, 'systemctl --user daemon-reload']);
    expect(existsSync(rec.path)).toBe(false);
    expect(existsSync(managerPaths().serviceJson)).toBe(false);
    expect(last.kept.some((k) => k.path === managerPaths().credentialJson && /manager bot token kept/.test(k.reason))).toBe(true);
    expect(formatUninstall(last)).toContain('Removed the host manager service');
  });
});

// ---------------------------------------------------------------- doctor / status --check

describe('doctor manager.* checks', () => {
  const by = <T extends { name: string }>(checks: T[], n: string) => checks.find((c) => c.name === n);

  it('not set up: ok (optional); stored but unpaired: warn; paired: ok; other bot paired or a clash: warn. Never fail', async () => {
    let c = await managerChecks();
    expect(c.map((x) => [x.name, x.status])).toEqual([['manager.token', 'ok'], ['manager.bot', 'unavailable'], ['manager.pairing', 'unavailable']]);

    await registerProjects(A);
    await M.provisionManagerToken({ token: MGR });
    c = await managerChecks();
    expect(by(c, 'manager.token')).toMatchObject({ status: 'ok', detail: 'bot 555666777; stored in 0600 file' });
    expect(by(c, 'manager.bot')).toMatchObject({ status: 'ok' });
    expect(by(c, 'manager.pairing')).toMatchObject({ status: 'warn', detail: expect.stringContaining('not paired'), hint: expect.stringContaining('minions setup') });

    await M.saveManagerAccess({ version: 1, botId: '555666777', userId: OWNER, chatId: OWNER, pairedAt: 'x' });
    expect(by(await managerChecks(), 'manager.pairing')).toMatchObject({ status: 'ok', detail: `paired with Telegram user ${OWNER} (private chat)` });

    await M.saveManagerAccess({ version: 1, botId: '888999000', userId: OWNER, chatId: OWNER, pairedAt: 'x' });
    expect(by(await managerChecks(), 'manager.pairing')).toMatchObject({ status: 'warn', detail: 'paired for bot 888999000, but the stored token is bot 555666777' });

    mkdirSync(projectPaths(A).dir, { recursive: true });
    writeFileSync(projectPaths(A).credentialsJson, JSON.stringify({ version: 1, telegram: { backend: 'file', ref: 'file:x', botId: '555666777', updatedAt: 'now' } }));
    expect(by(await managerChecks(), 'manager.bot')).toMatchObject({ status: 'warn', detail: expect.stringContaining(`also the coordinator bot of project(s) ${A}`) });

    writeFileSync(managerPaths().accessJson, 'garbage');
    expect(by(await managerChecks(), 'manager.pairing')).toMatchObject({ status: 'warn', detail: expect.stringContaining('unreadable') });
    writeFileSync(managerPaths().credentialJson, 'garbage');
    c = await managerChecks();
    expect(by(c, 'manager.token')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^invalid:/) });
    for (const x of c) expect(x.status).not.toBe('fail');
    expect(JSON.stringify(c)).not.toContain(MGR_SECRET);
  });

  it('a 0644 token file warns', async () => {
    await M.provisionManagerToken({ token: MGR });
    const { chmodSync } = await import('node:fs');
    chmodSync(managerFile(), 0o644);
    expect(by(await managerChecks(), 'manager.token')).toMatchObject({ status: 'warn', detail: expect.stringContaining('token file mode is 644') });
    const d = by(await managerChecks(), 'manager.token')?.detail;
    expect(d).toContain('stored in host file');
    expect(d).not.toContain('0600');
  });

  it('runDoctor (doctor and status --check) includes the manager checks and they never change healthy', async () => {
    const opts = { cwd: env.root, probe: dockerUp, runner: recorder().runner, platform: 'darwin' as const };
    const before = await runDoctor(opts);
    expect(before.checks.filter((x) => x.name.startsWith('manager.')).map((x) => x.name)).toEqual(['manager.token', 'manager.bot', 'manager.pairing', 'manager.service', 'manager.process']);
    await M.provisionManagerToken({ token: MGR });
    writeFileSync(managerPaths().accessJson, 'garbage');
    const after = await runDoctor(opts);
    expect(after.checks.filter((x) => x.name.startsWith('manager.')).every((x) => x.status !== 'fail')).toBe(true);
    expect(by(after.checks, 'manager.pairing')?.status).toBe('warn');
    expect(after.healthy).toBe(before.healthy);
    expect(JSON.stringify(after) + formatDoctor(after)).not.toContain(MGR_SECRET);
  });
});
