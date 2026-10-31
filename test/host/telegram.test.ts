// Host side of Telegram: bot token provisioning through the shared credential mechanism, the init
// wizard step, and doctor readiness. All fakes: no Keychain, Docker, network, or Telegram.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Secrets modes under the default (owner) access, whoever runs the suite: see pin-secrets-access.ts.
vi.mock('../../src/host/secrets-access.js', async (orig) => (await import('./pin-secrets-access.js')).pinOwnerAccess(await orig()));
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
const { projectPaths, CONTAINER } = await import('../../src/core/paths.js');
const { runInit, formatInit } = await import('../../src/host/install.js');
const { runDoctor, formatDoctor } = await import('../../src/host/doctor.js');
const { runUninstall } = await import('../../src/host/uninstall.js');
const { runWizard } = await import('../../src/host/wizard.js');
const { discover } = await import('../../src/host/discovery.js');
const { saveRegistry } = await import('../../src/host/registry.js');
const { DEFERRED_FEATURES, listUnavailable, validateConfig } = await import('../../src/config/resolve.js');
const { redact } = await import('../../src/core/output.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { hostChannelServerProbe } = await import('../../src/telegram/channel/launch.js');
const { defaults } = await import('../helpers.js');
const { dockerDown, dockerUp, makeRepo, withHome } = await import('./fixtures.js');
type RunResult = import('../../src/core/exec.js').RunResult;
type RunOptions = import('../../src/core/exec.js').RunOptions;

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const KEY = 'sk-proj-11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

type Call = { cmd: string; args: string[]; opts?: RunOptions };
function recorder(handler: (c: Call) => RunResult | undefined = () => undefined) {
  const calls: Call[] = [];
  const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    const c = { cmd, args, opts };
    calls.push(c);
    return handler(c) ?? { code: 1, stdout: '', stderr: 'unavailable' };
  };
  return { calls, runner };
}
const mode = (p: string) => statSync(p).mode & 0o777;
function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}
const tgFetch = (status: number, body: unknown = { ok: true, result: { is_bot: true, username: 'demo_minions_bot' } }) => {
  const urls: string[] = [];
  const f = (async (url: string | URL | Request) => { urls.push(String(url)); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  return { f, urls };
};

describe('bot token format', () => {
  it('accepts BotFather tokens (optional "bot" prefix) and returns the non-secret bot id', () => {
    expect(C.checkTelegramTokenFormat(`  ${TOKEN}\n`)).toEqual({ token: TOKEN, botId: '123456789' });
    expect(C.checkTelegramTokenFormat(`bot${TOKEN}`).token).toBe(TOKEN);
  });

  it('rejects anything that could break out of a keychain line or environment, before any store call', async () => {
    const hostile = ['', 'hunter2', `${TOKEN} -w x`, `${TOKEN}\nadd-generic-password -s evil`, `${TOKEN}"`, `${TOKEN};id`, `${TOKEN}$(id)`,
      '12:AAHfakefakefakefakefakefakefake_-0123', `123456789:${'a'.repeat(10)}`, KEY];
    const { calls, runner } = recorder();
    const ks = new C.KeychainStore(runner, C.TELEGRAM_CREDENTIAL);
    for (const t of hostile) {
      expect(() => C.checkTelegramTokenFormat(t), t).toThrow(MinionsError);
      await expect(ks.set(ID, t)).rejects.toBeInstanceOf(MinionsError);
    }
    expect(calls).toEqual([]);
  });

  it('every accepted token is masked by core redact', () => {
    for (const t of [TOKEN, `123456:${'x'.repeat(30)}`, `123456789012:${'Z_-'.repeat(21)}`]) {
      C.checkTelegramTokenFormat(t);
      expect(redact(`log ${t} end`)).toBe('log [REDACTED_BOT_TOKEN] end');
      expect(redact(`https://api.telegram.org/bot${t}/getMe`)).not.toContain(t.split(':')[1]);
    }
  });
});

describe('provisioning through the shared credential mechanism', () => {
  it('file store: 0600 token file separate from the Codex key; reference holds only the bot id', async () => {
    const repo = makeRepo(env.root);
    await C.provisionCodexKey({ projectId: ID, token: KEY, repoPath: repo });
    const r = await C.provisionTelegramToken({ projectId: ID, token: TOKEN, repoPath: repo });
    expect(r).toMatchObject({ backend: 'file', botId: '123456789', verification: null, sharedWith: [], warnings: [] });
    const file = new C.FileStore(C.TELEGRAM_CREDENTIAL).path(ID);
    expect(file).not.toBe(new C.FileStore(C.CODEX_CREDENTIAL).path(ID));
    expect(readFileSync(file, 'utf8')).toBe(TOKEN + '\n');
    expect(mode(file)).toBe(0o600);
    const refText = readFileSync(projectPaths(ID).credentialsJson, 'utf8');
    expect(refText).not.toContain(TOKEN);
    expect(JSON.parse(refText)).toMatchObject({ codex: { backend: 'file' }, telegram: { backend: 'file', botId: '123456789', ref: `file:${file}` } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    for (const p of allFiles(repo)) expect(readFileSync(p, 'utf8')).not.toContain(TOKEN);

    // Materialized next to the Codex key in the read-only mounted dir.
    expect(await C.materializeSecrets(ID)).toEqual({ telegram: true, codex: true, claude: false });
    expect(readFileSync(projectPaths(ID).telegramTokenFile, 'utf8')).toBe(TOKEN + '\n');
    expect(mode(projectPaths(ID).telegramTokenFile)).toBe(0o600);
    expect(CONTAINER.telegramTokenFile).toBe('/opt/minions/secrets/telegram-bot-token');

    // Removing the Telegram token leaves the Codex key alone.
    expect(await C.removeTelegramToken(ID)).toEqual({ removed: true, backend: 'file' });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(projectPaths(ID).telegramTokenFile)).toBe(false);
    expect(existsSync(projectPaths(ID).codexKeyFile)).toBe(true);
    expect(await C.readCodexKey(ID)).toBe(KEY);
    expect(await C.materializeSecrets(ID)).toEqual({ telegram: false, codex: true, claude: false });
    await C.clearSecrets(ID);
    expect(existsSync(projectPaths(ID).codexKeyFile)).toBe(false);
  });

  it('keychain: own service name; the token goes through stdin, never argv', async () => {
    const repo = makeRepo(env.root);
    let stored: string | null = null;
    const { calls, runner } = recorder((c) => {
      if (c.args[0] === '-i') { stored = /-w (\S+)\n$/.exec(c.opts?.input ?? '')?.[1] ?? null; return { code: 0, stdout: '', stderr: '' }; }
      if (c.args[0] === 'find-generic-password') return stored ? { code: 0, stdout: stored + '\n', stderr: '' } : { code: 44, stdout: '', stderr: '' };
      return undefined;
    });
    const store = new C.KeychainStore(runner, C.TELEGRAM_CREDENTIAL);
    const r = await C.provisionTelegramToken({ projectId: ID, token: TOKEN, repoPath: repo, store, runner });
    expect(r).toMatchObject({ backend: 'keychain', ref: `keychain:minions.telegram/${ID}` });
    expect(calls.find((c) => c.args[0] === '-i')!.opts!.input).toContain('-s minions.telegram ');
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
  });

  it('optional getMe check: invalid tokens are not stored; network errors are redacted', async () => {
    const repo = makeRepo(env.root);
    const good = tgFetch(200);
    const r = await C.provisionTelegramToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: true, fetch: good.f });
    expect(r.verification).toEqual({ status: 'ok', detail: 'bot @demo_minions_bot', login: 'demo_minions_bot' });
    expect(good.urls).toEqual([`https://api.telegram.org/bot${TOKEN}/getMe`]);
    await C.removeTelegramToken(ID);
    await expect(C.provisionTelegramToken({ projectId: ID, token: TOKEN, repoPath: repo, verify: true, fetch: tgFetch(401).f })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await C.readTelegramToken(ID)).toBeNull();
    const boom = (async (u: string) => { throw new Error(`request to ${u} failed`); }) as unknown as typeof fetch;
    const v = await C.verifyTelegramToken(TOKEN, { fetch: boom });
    expect(v.status).toBe('unverified');
    expect(v.detail).not.toContain(TOKEN.split(':')[1]);
  });

  it('warns when another registered project already uses the same bot (one coordinator per bot)', async () => {
    const repo = makeRepo(env.root);
    await saveRegistry({ version: 1, projects: {
      [ID]: { gitCommonDir: '/a/.git', repoPath: '/a', visibility: 'private' },
      [OTHER]: { gitCommonDir: '/b/.git', repoPath: '/b', visibility: 'private' },
    } });
    await C.provisionTelegramToken({ projectId: OTHER, token: TOKEN, repoPath: repo });
    const r = await C.provisionTelegramToken({ projectId: ID, token: TOKEN, repoPath: repo });
    expect(r.sharedWith).toEqual([OTHER]);
    expect(r.warnings.join()).toMatch(/Only one coordinator can poll a bot at a time/);
    expect(await C.telegramCredentialStatus(ID)).toMatchObject({ state: 'ok', sharedWith: [OTHER] });
  });

  it('status: missing, ok, insecure mode, tampered token; never includes the token', async () => {
    const repo = makeRepo(env.root);
    expect((await C.telegramCredentialStatus(ID)).state).toBe('missing');
    await C.provisionTelegramToken({ projectId: ID, token: TOKEN, repoPath: repo });
    expect(await C.telegramCredentialStatus(ID)).toMatchObject({ state: 'ok', botId: '123456789' });
    const { chmodSync, writeFileSync } = await import('node:fs');
    const file = new C.FileStore(C.TELEGRAM_CREDENTIAL).path(ID);
    chmodSync(file, 0o644);
    expect(await C.telegramCredentialStatus(ID)).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/mode is 644/) });
    chmodSync(file, 0o600);
    writeFileSync(file, '987654321:AAHfakefakefakefakefakefakefake_-0123\n');
    const s = await C.telegramCredentialStatus(ID);
    expect(s).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/does not match the recorded bot id/) });
    expect(JSON.stringify(s)).not.toMatch(/AAHfake/);
  });
});

describe('config support', () => {
  it('telegram is a supported channel and no longer a deferred feature', () => {
    const c = defaults();
    c.communication.channel = 'telegram';
    expect(validateConfig(c).communication.channel).toBe('telegram');
    expect(listUnavailable(c)).toEqual([]);
    expect(DEFERRED_FEATURES as readonly string[]).not.toContain('Telegram');
    c.container.network = 'none';
    expect(listUnavailable(c).find((u) => u.path === 'communication.channel')?.reason).toMatch(/terminal-only/);
  });
});

/** Fake IO answering by question prefix. */
function answering(answers: Record<string, string>, secrets: string[] = []) {
  const asked: string[] = [];
  const info: string[] = [];
  return {
    asked, info,
    io: {
      ask: async (q: string, def: string) => { asked.push(q); const k = Object.keys(answers).find((a) => q.startsWith(a)); return k ? answers[k]! : def; },
      info: (l: string) => info.push(l),
      secret: async (prompt: string) => { asked.push(`secret:${prompt}`); return secrets.shift() ?? ''; },
    },
  };
}

describe('init and doctor', () => {
  const container = (opts: { probe: 'available' | 'old-claude'; access?: string; poller?: string }) => recorder((c) => {
    const a = c.args.join(' ');
    if (c.cmd !== 'docker') return undefined;
    if (a.startsWith('image inspect')) return { code: 0, stdout: 'x\n', stderr: '' };
    if (a.includes(' ps --status running')) return { code: 0, stdout: 'abc\n', stderr: '' };
    if (a.endsWith('claude auth status') || a.endsWith('backlog --version') || a.endsWith('coordinator --probe --json')) return { code: 0, stdout: '1.54.0\n', stderr: '' };
    if (a.endsWith('telegram probe --json')) {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
      const report = hostChannelServerProbe({ claudeVersion: opts.probe === 'available' ? '2.1.308 (Claude Code)' : '2.0.1 (Claude Code)', token: 'ok', command: true });
      return ok(JSON.stringify({ ok: true, data: report }));
    }
    if (a.endsWith('telegram status --json')) {
      return { code: 0, stdout: JSON.stringify({ ok: true, data: { access: { state: opts.access ?? 'ok', detail: 'paired with one owner' }, coordinator: null,
        ...(opts.poller ? { poller: { state: opts.poller, detail: `poller ${opts.poller}` } } : {}) } }), stderr: '' };
    }
    return undefined;
  });

  it('interactive init with Telegram stores the token via the hidden prompt; doctor reports ok', async () => {
    const repo = makeRepo(env.root);
    const a = answering({ 'Communication channel': 'telegram', 'Store the Telegram bot token': 'y', 'Check the token with Telegram': 'n' }, [TOKEN]);
    const r = await runInit({ mode: 'independent', path: repo, yes: false, visibility: 'private', io: a.io, dockerProbe: dockerUp });
    expect(r.telegram).toMatchObject({ status: 'stored', provisioned: { backend: 'file', botId: '123456789' } });
    expect(a.asked).toContain('secret:Telegram bot token (input hidden): ');
    expect(r.plan.communication.channel).toBe('auto');
    expect(r.plan.externalSetup.join('\n')).toContain('/opt/minions/secrets/telegram-bot-token');
    expect(r.nextSteps.join('\n')).toContain('minions telegram access pair <code>');
    expect(await C.readTelegramToken(r.plan.projectId)).toBe(TOKEN);
    expect(JSON.stringify(r) + formatInit(r)).not.toContain(TOKEN);
    const p = projectPaths(r.plan.projectId);
    for (const f of [...allFiles(repo), ...allFiles(p.pluginDir), ...allFiles(p.runtimeDir), p.composeYaml, p.projectJson, p.configJson, p.credentialsJson]) {
      expect(readFileSync(f, 'utf8'), f).not.toContain(TOKEN);
    }

    const ok = await runDoctor({ cwd: repo, probe: dockerUp, runner: container({ probe: 'available' }).runner });
    const by = (n: string) => ok.checks.find((c) => c.name === n);
    expect(by('telegram.credential')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^ok: bot 123456789/) });
    expect(by('telegram.server')?.status).toBe('ok');
    expect(by('telegram.access')?.status).toBe('ok');
    expect(by('telegram')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^ok:/) });
    expect(by('features')!.detail).not.toContain('Telegram');
    expect(ok.healthy).toBe(true);
    expect(JSON.stringify(ok) + formatDoctor(ok)).not.toContain(TOKEN);

    // No live channel server for a running Telegram coordinator: telegram.poller warns, readiness follows the probe.
    for (const poller of ['missing', 'dead']) {
      const w = await runDoctor({ cwd: repo, probe: dockerUp, runner: container({ probe: 'available', poller }).runner });
      expect(w.checks.find((c) => c.name === 'telegram.poller')?.status, poller).toBe('warn');
      expect(w.checks.find((c) => c.name === 'telegram')).toMatchObject({ status: 'ok' });
      expect(w.checks.some((c) => c.name.startsWith('telegram') && c.status === 'fail')).toBe(false);
    }

    // Channel server unavailable (a Claude Code without development channels): unavailable, never fail.
    const un = await runDoctor({ cwd: repo, probe: dockerUp, runner: container({ probe: 'old-claude', access: 'unpaired' }).runner });
    expect(un.checks.find((c) => c.name === 'telegram')).toMatchObject({ status: 'unavailable', detail: expect.stringMatching(/^unavailable: .*terminal-only/) });
    expect(un.checks.find((c) => c.name === 'telegram.access')?.status).toBe('warn');
    expect(un.checks.filter((c) => c.name.startsWith('telegram')).some((c) => c.status === 'fail')).toBe(false);

    // Uninstall keeps the stored token and removes the materialized copy.
    await C.materializeSecrets(r.plan.projectId);
    const u = await runUninstall({ cwd: repo, runner: recorder().runner });
    expect(u.kept.some((k) => k.reason.includes('Telegram bot token kept'))).toBe(true);
    expect(existsSync(p.telegramTokenFile)).toBe(false);
  });

  it('independent, token declined: init says terminal-only until stored; doctor reports it missing', async () => {
    const repo = makeRepo(env.root);
    const a = answering({ 'Store the Telegram bot token': 'n' });
    const r = await runInit({ mode: 'independent', path: repo, yes: false, visibility: 'private', io: a.io, dockerProbe: dockerUp });
    expect(r.telegram).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/terminal-only until a bot token is stored with `minions auth telegram`/) });
    expect(a.asked.some((q) => q.startsWith('secret:'))).toBe(false);
    expect(r.nextSteps.join('\n')).toContain('minions auth telegram');
    const doc = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner });
    expect(doc.checks.find((c) => c.name === 'telegram.credential')?.detail).toMatch(/^missing:/);
    expect(doc.checks.find((c) => c.name === 'telegram')?.detail).toMatch(/terminal mode/);
  });

  it('non-interactive independent init without a token: terminal mode until stored, no prompt', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    expect(r.plan.communication.channel).toBe('auto');
    expect(r.telegram).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/^non-interactive init; .*terminal-only/) });
    expect(r.nextSteps.join('\n')).toContain('Run `minions auth telegram`');
    const doc = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner });
    expect(doc.checks.find((c) => c.name === 'telegram')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^auto: terminal mode \(auto: no Telegram bot token is stored/) });
    expect(doc.checks.find((c) => c.name === 'telegram.credential')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^missing: optional/) });
    expect(doc.checks.find((c) => c.name === 'communication.channel')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^configured auto, effective terminal/) });
  });

  it('supervised projects (terminal): Telegram reported as not selected, no prompt', async () => {
    const repo = makeRepo(env.root);
    const r = await runInit({ mode: 'supervised', runtime: 'docker', path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    expect(r.plan.communication.channel).toBe('terminal');
    expect(r.telegram).toBeUndefined();
    const doc = await runDoctor({ cwd: repo, probe: dockerDown, runner: recorder().runner });
    expect(doc.checks.find((c) => c.name === 'telegram')).toMatchObject({ status: 'ok', detail: 'terminal mode (Telegram not selected)' });
    expect(doc.checks.find((c) => c.name === 'telegram.credential')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^missing: not needed/) });
  });
});
