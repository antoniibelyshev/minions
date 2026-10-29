// Task-57 phase 4 (docs/design/coordinator-sessions.md): the sessions schema (10), the session settings and the
// headless session launch builder. No process is started: a fake `claude` on PATH would leave a marker if it ran.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { classifyKey } from '../../src/config/setting-classes.js';
import { MinionsError } from '../../src/core/errors.js';
import { TELEGRAM_PLUGIN_ID } from '../../src/telegram/probe.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { runtimePaths, type RuntimePaths } from '../../src/runtime/paths.js';
import {
  buildSessionCommand, checkHookCommands, DEFAULT_ROUTER_MODEL, hookCommands, parseSessionKey, routerModel, sessionConfigDir, sessionsSettings, taskSessionPromptNote,
  type SessionCommandDeps,
} from '../../src/runtime/sessions.js';
import { GENERAL_SESSION_NOTE } from '../../src/runtime/router-prompt.js';
import { defaults } from '../helpers.js';

const OAUTH = `sk-ant-oat01-${'A'.repeat(80)}`;
const PROVISIONED_KEY = 'provisioned-key-0123456789abcdef';
const COORD_SECRET = 'coordinator-env-secret-value';
const TG = '123456:telegram-bot-token-value';
const TEMPLATE_HOOKS = join(import.meta.dirname, '..', '..', 'templates', 'plugin', 'hooks', 'hooks.json');

let root: string;
let paths: RuntimePaths;
let env: NodeJS.ProcessEnv;
const savedRuntime = process.env.MINIONS_RUNTIME;

beforeEach(() => {
  process.env.MINIONS_RUNTIME = 'container';
  root = mkdtempSync(join(tmpdir(), 'minions-sessions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch ${JSON.stringify(join(root, 'claude-ran'))}\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  mkdirSync(join(root, 'plugin', 'hooks'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'session prompt\n');
  writeFileSync(join(root, 'plugin', 'hooks', 'hooks.json'), readFileSync(TEMPLATE_HOOKS, 'utf8'));
  mkdirSync(join(root, 'secrets'), { mode: 0o700 });
  mkdirSync(join(root, 'scratch'));
  paths = runtimePaths({ MINIONS_PLUGIN_DIR: join(root, 'plugin'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_WORKSPACE: join(root, 'ws'),
    MINIONS_SECRETS_DIR: join(root, 'secrets'), MINIONS_SCRATCH_DIR: join(root, 'scratch') }, { inContainer: false });
  // The caller (the wrapper) carries the bot token, other credentials, worker markers and the coordinator's config dir.
  env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: '/home/node', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: '/tmp', MINIONS_STATE_DIR: paths.state,
    CLAUDE_CONFIG_DIR: join(root, 'coordinator-home'), ANTHROPIC_BASE_URL: 'http://proxy.local',
    TELEGRAM_BOT_TOKEN: TG, TELEGRAM_STATE_DIR: join(root, 'coordinator-home', 'channels', 'telegram'), TELEGRAM_EXTRA: TG,
    ANTHROPIC_API_KEY: COORD_SECRET, ANTHROPIC_AUTH_TOKEN: COORD_SECRET, CLAUDE_CODE_OAUTH_TOKEN: COORD_SECRET, GH_TOKEN: COORD_SECRET,
    MINIONS_ROLE: 'engineer', MINIONS_WORKER_LEASE: 'lease-x', MINIONS_SESSION: 'general', UNRELATED_SECRETISH: COORD_SECRET,
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedRuntime === undefined) delete process.env.MINIONS_RUNTIME; else process.env.MINIONS_RUNTIME = savedRuntime;
});

const deps = (method: SessionCommandDeps['method'], extra: Partial<SessionCommandDeps> = {}): SessionCommandDeps =>
  ({ method, paths, env, host: null, hostRuntime: false, ...extra });
const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const mode = (p: string) => statSync(p).mode & 0o777;

async function failure(p: Promise<unknown>): Promise<MinionsError> {
  try { await p; } catch (e) { if (e instanceof MinionsError) return e; throw e; }
  throw new Error('expected a MinionsError');
}

describe('schema 10: sessions and session_inbox', () => {
  it('an existing schema-9 database opens cleanly, gains both tables and keeps its data', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(10);
    const file = join(root, 'v9.db');
    const v9 = new RuntimeDb(file);
    v9.sql.exec('DROP TABLE sessions; DROP TABLE session_inbox; DROP TABLE tg_messages; ALTER TABLE outbox DROP COLUMN session; ALTER TABLE outbox DROP COLUMN answered_at;');
    v9.setMeta('schema_version', '9');
    v9.setControl('paused_starts', '1');
    v9.addEvent('routine', null, { trigger: 'clock' });
    v9.close();

    const up = new RuntimeDb(file);
    try {
      expect(up.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
      expect(up.paused().starts).toBe(true);
      expect(up.all("SELECT 1 FROM events WHERE kind = 'routine'")).toHaveLength(1);
      const cols = (t: string) => up.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
      expect(cols('sessions')).toEqual(['key', 'kind', 'claude_session_id', 'status', 'model', 'config_dir', 'opened_at', 'last_wake_at', 'closed_at', 'resumes', 'failure']);
      expect(cols('session_inbox')).toEqual(['id', 'session_key', 'source', 'text', 'meta_json', 'created_at', 'delivered_at']);
      up.exec("INSERT INTO sessions (key, kind, status, config_dir, opened_at) VALUES ('task:task-57', 'task', 'open', '/state/run/sessions/task:task-57/config', 'now')");
      up.exec("INSERT INTO session_inbox (session_key, source, text, created_at) VALUES ('general', 'router', 'hi', 'now')");
      expect(up.get('SELECT resumes FROM sessions')).toEqual({ resumes: 0 });
    } finally { up.close(); }
    // A second open is the plain read-only path (already current).
    const again = new RuntimeDb(file);
    try { expect(again.all('SELECT key FROM sessions')).toEqual([{ key: 'task:task-57' }]); } finally { again.close(); }
  });
});

describe('session settings', () => {
  it('sessions are off by default; max defaults to maxActiveTasks + 1; the router model defaults to haiku', () => {
    const cfg = defaults();
    expect(cfg.coordinator?.sessions).toBeUndefined();
    expect(sessionsSettings(cfg)).toEqual({ enabled: false, max: cfg.execution.maxActiveTasks + 1 });
    expect(routerModel(cfg)).toBe(DEFAULT_ROUTER_MODEL);
    expect(DEFAULT_ROUTER_MODEL).toBe('haiku');
    const on = validateConfig({ ...cfg, coordinator: { sessions: { enabled: true, max: 2 } }, models: { ...cfg.models, router: cfg.models.allowed[0] } });
    expect(sessionsSettings(on)).toEqual({ enabled: true, max: 2 });
    expect(routerModel(on)).toBe(cfg.models.allowed[0]);
  });

  it('rejects a router model outside models.allowed and a zero session cap', () => {
    const cfg = defaults();
    expect(() => validateConfig({ ...cfg, models: { ...cfg.models, router: 'not-allowed-model' } })).toThrow(/models\.router/);
    expect(() => validateConfig({ ...cfg, coordinator: { sessions: { max: 0 } } })).toThrow();
  });

  it('the new keys are registered with setting classes', () => {
    expect(classifyKey('coordinator.sessions.enabled')).toMatchObject({ class: 'restart', hostOwned: true });
    expect(classifyKey('coordinator.sessions.max')).toMatchObject({ class: 'live', hostOwned: false });
    expect(classifyKey('models.router')).toMatchObject({ class: 'restart', hostOwned: false });
  });
});

describe('session keys', () => {
  it('accepts general and task:<id> only (the key is a path segment)', () => {
    expect(parseSessionKey('general')).toEqual({ key: 'general', kind: 'general', taskId: null });
    expect(parseSessionKey('task:task-57.8')).toEqual({ key: 'task:task-57.8', kind: 'task', taskId: 'task-57.8' });
    for (const bad of ['router', 'task:', 'task:../x', 'task:a/b', 'task:.hidden', '', 'general/..']) expect(() => parseSessionKey(bad), bad).toThrow(MinionsError);
  });
});

describe('buildSessionCommand', () => {
  it('argv, env and settings carry no Telegram token, plugin, channel or tools, and no secret in argv', async () => {
    writeFileSync(paths.claudeHeadlessTokenFile, `${OAUTH}\n`, { mode: 0o600 });
    const l = await buildSessionCommand(defaults(), 'task:task-57.8', deps('login'));

    // argv: resident stream-json, the minions plugin, strict MCP, no channel, nothing secret.
    expect(l.args.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    expect(valueOf(l.args, '--plugin-dir')).toBe(paths.pluginDir);
    // A task session gets the coordinator prompt plus its task note (phase 7): only this task, the /minions:task skill, no channel.
    expect(valueOf(l.args, '--append-system-prompt')).toBe('session prompt\n' + taskSessionPromptNote('task-57.8'));
    expect(taskSessionPromptNote('task-57.8')).toMatch(/Follow `\/minions:task task-57\.8`.*no chat channel/s);
    expect(l.args).toContain('--strict-mcp-config');
    expect(l.args).toContain('--permission-mode');
    for (const f of ['--channels', '--dangerously-load-development-channels', '--dangerously-skip-permissions', '--mcp-config']) expect(l.args).not.toContain(f);
    const argv = JSON.stringify(l.args);
    for (const s of [OAUTH, TG, COORD_SECRET]) expect(argv).not.toContain(s);
    expect(l.args.filter((a) => a !== valueOf(l.args, '--settings')).join(' ')).not.toMatch(/telegram/i);

    // settings: the plugin is disabled, no Telegram tool is allowed, no Telegram hook.
    expect(JSON.parse(valueOf(l.args, '--settings')!)).toEqual(l.flagSettings);
    expect(l.flagSettings.enabledPlugins).toEqual({ [TELEGRAM_PLUGIN_ID]: false });
    const { enabledPlugins: _off, ...rest } = l.flagSettings;
    expect(JSON.stringify(rest)).not.toMatch(/telegram/i);
    expect(hookCommands(l.flagSettings)).toEqual([]);
    expect(l.userSettings).toEqual({ permissions: { disableBypassPermissionsMode: 'disable' } });

    // env: an allowlist plus the one credential and MINIONS_SESSION.
    expect(Object.keys(l.env).filter((k) => k.startsWith('TELEGRAM_'))).toEqual([]);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'MINIONS_ROLE', 'MINIONS_WORKER_LEASE', 'UNRELATED_SECRETISH']) expect(l.env[k], k).toBeUndefined();
    expect(Object.values(l.env).filter((v) => v.includes(TG) || v.includes(COORD_SECRET))).toEqual([]);
    expect(l.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH, CLAUDE_CONFIG_DIR: l.configDir, MINIONS_SESSION: 'task:task-57.8', DISABLE_AUTOUPDATER: '1',
      ANTHROPIC_BASE_URL: 'http://proxy.local', PATH: env.PATH, HOME: '/home/node', LC_ALL: 'C.UTF-8', MINIONS_STATE_DIR: paths.state,
    });
    expect(l.setEnv).toEqual(['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_OAUTH_TOKEN', 'MINIONS_SESSION']);
    // Neither the credential description nor the settings file holds the token.
    expect(l.credential).not.toContain(OAUTH);
    expect(readFileSync(join(l.configDir, 'settings.json'), 'utf8')).not.toContain(OAUTH);
    expect(existsSync(join(root, 'claude-ran'))).toBe(false); // nothing was started
  });

  it('key methods: the apiKeyHelper reads the key file; the key itself is nowhere', async () => {
    writeFileSync(paths.apiKeyFile, PROVISIONED_KEY, { mode: 0o600 });
    const l = await buildSessionCommand(defaults(), 'general', deps('api-key'));
    expect(l.flagSettings.apiKeyHelper).toContain(paths.apiKeyFile);
    expect(l.userSettings.apiKeyHelper).toContain(paths.apiKeyFile);
    expect(l.env).toMatchObject({ CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '300000', MINIONS_SESSION: 'general' });
    // The general session's note (phase 8), never the task note; no channel.
    expect(valueOf(l.args, '--append-system-prompt')).toBe('session prompt\n' + GENERAL_SESSION_NOTE);
    expect(l.args).not.toContain('--channels');
    expect(l.flagSettings.enabledPlugins).toEqual({ [TELEGRAM_PLUGIN_ID]: false });
    expect(Object.keys(l.env).filter((k) => k.startsWith('TELEGRAM_'))).toEqual([]);
    expect(l.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify([l.args, l.env, l.flagSettings, l.userSettings])).not.toContain(PROVISIONED_KEY);
  });

  it('uses a persistent fresh config dir per key, 0700 at every level, kept across builds', async () => {
    writeFileSync(paths.claudeHeadlessTokenFile, OAUTH, { mode: 0o600 });
    const first = await buildSessionCommand(defaults(), 'task:task-57', deps('login'));
    expect(first.configDir).toBe(sessionConfigDir(paths, 'task:task-57'));
    expect(first.configDir).toBe(join(paths.state, 'run', 'sessions', 'task:task-57', 'config'));
    for (const d of [join(paths.state, 'run', 'sessions'), join(paths.state, 'run', 'sessions', 'task:task-57'), first.configDir]) expect(mode(d), d).toBe(0o700);
    expect(mode(join(first.configDir, 'settings.json'))).toBe(0o600);
    expect(first.configDir.startsWith(env.CLAUDE_CONFIG_DIR!)).toBe(false);
    // A transcript written by the session survives the next wake's build (so --resume finds it).
    mkdirSync(join(first.configDir, 'projects'));
    writeFileSync(join(first.configDir, 'projects', 's1.jsonl'), '{}\n');
    const again = await buildSessionCommand(defaults(), 'task:task-57', deps('login', { resume: '0f9e5c1a-1111-2222-3333-444455556666' }));
    expect(again.configDir).toBe(first.configDir);
    expect(existsSync(join(first.configDir, 'projects', 's1.jsonl'))).toBe(true);
    expect(valueOf(again.args, '--resume')).toBe('0f9e5c1a-1111-2222-3333-444455556666');
    expect((await failure(buildSessionCommand(defaults(), 'task:task-57', deps('login', { resume: '--channels' })))).code).toBe('INVALID_CONFIG');
    expect(existsSync(env.CLAUDE_CONFIG_DIR!)).toBe(false); // the coordinator's config is never written
  });

  it('builds while worker leases are active (no live-run lease check), and passes the coordinator model', async () => {
    writeFileSync(paths.claudeHeadlessTokenFile, OAUTH, { mode: 0o600 });
    const cfg = defaults();
    const withModel: MinionsConfig = validateConfig({ ...cfg, models: { ...cfg.models, coordinator: cfg.models.allowed[0] } });
    const l = await buildSessionCommand(withModel, 'general', deps('login'));
    expect(valueOf(l.args, '--model')).toBe(cfg.models.allowed[0]);
  });

  it('refuses a bypassPermissions config and a missing credential', async () => {
    const bypass = { ...defaults(), permissionMode: 'bypassPermissions' } as unknown as MinionsConfig;
    writeFileSync(paths.claudeHeadlessTokenFile, OAUTH, { mode: 0o600 });
    expect((await failure(buildSessionCommand(bypass, 'general', deps('login')))).code).toBe('POLICY_DENIED');
    rmSync(paths.claudeHeadlessTokenFile);
    expect((await failure(buildSessionCommand(defaults(), 'general', deps('login')))).code).toBe('AUTH_REQUIRED');
    expect(existsSync(join(paths.state, 'run', 'sessions'))).toBe(false);
  });
});

describe('hook commands never exec from a noexec /tmp (U1)', () => {
  it('the shipped plugin hooks pass, even with the plugin dir under /tmp', () => {
    const cmds = hookCommands(JSON.parse(readFileSync(TEMPLATE_HOOKS, 'utf8')));
    expect(cmds.length).toBeGreaterThan(3);
    expect(() => checkHookCommands(cmds, { pluginDir: '/tmp/plugin' })).not.toThrow();
  });

  it('refuses a script exec\'d from /tmp, allows it through sh or from a plugin dir outside /tmp', () => {
    const check = (c: string, pluginDir = '/opt/minions/plugin') => () => checkHookCommands([c], { pluginDir });
    for (const bad of ['/tmp/probe/hook.sh', 'timeout 20 /tmp/x/hook || exit 2', 'i=$(cat); printf %s "$i" | /var/tmp/h', '/dev/shm/h', '/usr/bin/env /tmp/x/hook.sh', 'env /tmp/x/hook.sh']) expect(check(bad), bad).toThrow(/noexec/);
    expect(check('${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh', '/tmp/plugin')).toThrow(/noexec/);
    for (const ok of ['sh /tmp/probe/hook.sh', 'bash /tmp/probe/hook.sh || exit 2', 'minions hook stop', '${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh']) expect(check(ok), ok).not.toThrow();
    expect(check('sh ${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh', '/tmp/plugin')).not.toThrow();
  });

  it('`sh <script>` runs a script the kernel refuses to exec (what noexec does to every file on the mount)', () => {
    const script = join(root, 'hook.sh');
    writeFileSync(script, 'echo ran\n', { mode: 0o644 }); // not executable: exec fails like on a noexec mount
    expect(spawnSync(script, [], { encoding: 'utf8' }).error).toBeDefined();
    expect(spawnSync('sh', ['-c', `sh ${script}`], { encoding: 'utf8' }).stdout).toBe('ran\n');
  });

  it('buildSessionCommand refuses a plugin whose hooks exec from /tmp, and moves a /tmp TMPDIR to the scratch root', async () => {
    writeFileSync(paths.claudeHeadlessTokenFile, OAUTH, { mode: 0o600 });
    const ok = await buildSessionCommand(defaults(), 'general', deps('login'));
    expect(ok.env.TMPDIR).toBe(paths.tmp);
    expect((await buildSessionCommand(defaults(), 'general', deps('login', { env: { ...env, TMPDIR: join(root, 'scratch', 'x') } }))).env.TMPDIR).toBe(join(root, 'scratch', 'x'));
    writeFileSync(join(paths.pluginDir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/tmp/probe/stop.sh' }] }] } }));
    expect((await failure(buildSessionCommand(defaults(), 'general', deps('login')))).code).toBe('POLICY_DENIED');
  });
});
