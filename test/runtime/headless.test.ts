// Task-96: headless claude runs launched by minions (`minions coordinator live-run`) start in a fresh CLAUDE_CONFIG_DIR
// and get the runtime's Claude credential for every claudeAuth method, only through env or an apiKeyHelper. A fake
// `claude` script on PATH records what it received; no real Claude Code session is started.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shQuote } from '../../src/runtime/coordinator.js';
import { checkHeadlessArgs, headlessEnv, liveRun, liveRunExitCode, type LiveRunDeps } from '../../src/runtime/headless.js';
import { MinionsError } from '../../src/core/errors.js';

const OAUTH = `sk-ant-oat01-${'A'.repeat(80)}`;
const API = `sk-ant-api03-${'B'.repeat(80)}`;
const PROVISIONED_KEY = 'provisioned-key-0123456789abcdef';
const COORD_SECRET = 'coordinator-env-secret-value';
const TG = '123456:telegram-bot-token-value';

let root: string;
let out: string;
let paths: LiveRunDeps['paths'];
let env: NodeJS.ProcessEnv;
let logs: string[];

// Records argv, the credential variables, the config dir contents and (for the key methods) what the apiKeyHelper yields.
const FAKE_CLAUDE = `#!/bin/sh
{
  echo "argv=$*"
  echo "config=$CLAUDE_CONFIG_DIR"
  echo "oauth=\${CLAUDE_CODE_OAUTH_TOKEN:-}"
  echo "apikey=\${ANTHROPIC_API_KEY:-}"
  echo "authtoken=\${ANTHROPIC_AUTH_TOKEN:-}"
  echo "telegram=\${TELEGRAM_BOT_TOKEN:-}"
  echo "ttl=\${CLAUDE_CODE_API_KEY_HELPER_TTL_MS:-}"
  echo "files=$(ls -A "$CLAUDE_CONFIG_DIR" | tr '\\n' ' ')"
  helper=$(sed -n 's/.*"apiKeyHelper": "\\(.*\\)".*/\\1/p' "$CLAUDE_CONFIG_DIR/settings.json")
  echo "helper=$helper"
  [ -n "$helper" ] && echo "helperkey=$(sh -c "$helper")"
} > "$FAKE_OUT"
exit 3
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'minions-headless-'));
  const bin = join(root, 'bin');
  const secrets = join(root, 'secrets');
  mkdirSync(bin);
  mkdirSync(secrets, { mode: 0o700 });
  mkdirSync(join(root, 'tmp'));
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  out = join(root, 'out.txt');
  paths = { claudeHeadlessTokenFile: join(secrets, 'claude-headless-token'), apiKeyFile: join(secrets, 'anthropic-api-key'), tmp: join(root, 'tmp') };
  // The caller's environment carries other credentials and the coordinator's config dir: none of it may pass through.
  env = {
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, FAKE_OUT: out, CLAUDE_CONFIG_DIR: join(root, 'coordinator-home'),
    ANTHROPIC_API_KEY: COORD_SECRET, ANTHROPIC_AUTH_TOKEN: COORD_SECRET, CLAUDE_CODE_OAUTH_TOKEN: COORD_SECRET, TELEGRAM_BOT_TOKEN: TG,
  };
  logs = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (method: LiveRunDeps['method'], extra: Partial<LiveRunDeps> = {}): LiveRunDeps => ({
  activeLeases: () => [], method, paths, env, log: (l) => logs.push(l), signals: { on: () => process, off: () => process }, ...extra,
});
const recorded = (): Record<string, string> => Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const run = (method: LiveRunDeps['method'], extra: Partial<LiveRunDeps> = {}) => liveRun(['-p', '--output-format', 'json'], { cwd: root }, deps(method, extra));

async function failure(p: Promise<unknown>): Promise<MinionsError> {
  try { await p; } catch (e) { if (e instanceof MinionsError) return e; throw e; }
  throw new Error('expected a MinionsError');
}

describe('live run credentials per claudeAuth method', () => {
  it('login: the setup-token token reaches claude only as CLAUDE_CODE_OAUTH_TOKEN, in a fresh config dir', async () => {
    writeFileSync(paths.claudeHeadlessTokenFile, `${OAUTH}\n`, { mode: 0o600 });
    const r = await run('login');
    const got = recorded();
    expect(got.oauth).toBe(OAUTH);
    expect(got.apikey).toBe('');
    expect(got.authtoken).toBe('');
    expect(got.telegram).toBe('');
    expect(got.helper).toBe('');
    expect(got.argv).toBe('-p --output-format json');
    expect(got.config).not.toBe(env.CLAUDE_CONFIG_DIR);
    expect(got.config?.startsWith(join(paths.tmp, 'headless'))).toBe(true);
    expect(got.files?.trim()).toBe('settings.json'); // fresh: no plugins, no channels, no login state
    expect(r).toMatchObject({ method: 'login', exitCode: 3, keptDir: false });
    expect(liveRunExitCode(r)).toBe(3);
    expect(existsSync(got.config!)).toBe(false); // removed afterwards
    for (const text of [JSON.stringify(r), ...logs]) expect(text).not.toContain(OAUTH);
    expect(existsSync(env.CLAUDE_CONFIG_DIR!)).toBe(false); // the coordinator's config is never written
  });

  it('login with an Anthropic API key stored instead maps it to ANTHROPIC_API_KEY', async () => {
    writeFileSync(paths.claudeHeadlessTokenFile, API, { mode: 0o600 });
    await run('login');
    expect(recorded()).toMatchObject({ apikey: API, oauth: '', authtoken: '' });
  });

  it.each(['api-key', 'helper'] as const)('%s (and jbcentral, a helper preset): the provisioned key through an apiKeyHelper, no copy', async (method) => {
    writeFileSync(paths.apiKeyFile, PROVISIONED_KEY, { mode: 0o600 });
    const r = await run(method);
    const got = recorded();
    expect(got.helperkey).toBe(PROVISIONED_KEY);
    expect(got.helper).toContain(paths.apiKeyFile);
    expect(got).toMatchObject({ oauth: '', apikey: '', authtoken: '', telegram: '', ttl: '300000' });
    expect(r.settings).toEqual({ permissions: { disableBypassPermissionsMode: 'disable' }, apiKeyHelper: `cat ${shQuote(paths.apiKeyFile)}` });
    for (const text of [JSON.stringify(r), ...logs]) expect(text).not.toContain(PROVISIONED_KEY);
  });

  it('a missing credential is AUTH_REQUIRED with the setup step, and nothing is spawned', async () => {
    const e = await failure(run('login'));
    expect(e.code).toBe('AUTH_REQUIRED');
    expect(e.hint).toMatch(/claude setup-token.*minions auth set login --headless-token/);
    expect((await failure(run('api-key'))).code).toBe('AUTH_REQUIRED');
    expect(existsSync(out)).toBe(false);
  });
});

describe('live run refusals', () => {
  it('refuses while a worker lease is active (dry run only reports it)', async () => {
    writeFileSync(paths.claudeHeadlessTokenFile, OAUTH, { mode: 0o600 });
    const busy = { activeLeases: () => [{ id: 'lease-abc' }] };
    const e = await failure(run('login', busy));
    expect(e.code).toBe('CONFLICT');
    expect(e.message).toContain('lease-abc');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(paths.tmp, 'headless'))).toBe(false);
    const dry = await liveRun([], { cwd: root, dryRun: true }, deps('login', busy));
    expect(dry.refused).toContain('lease-abc');
    expect(JSON.stringify(dry)).not.toContain(OAUTH);
    expect(dry.setEnv).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('never puts the secret in argv and refuses bypass, channels and the coordinator config dir', () => {
    const o = { coordinatorConfigDir: '/home/node/.claude', secret: OAUTH };
    expect(() => checkHeadlessArgs(['-p', `--append-system-prompt=${OAUTH}`], o)).toThrow(/secret in argv/);
    for (const bad of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode=bypassPermissions'],
      ['--channels', 'plugin:telegram@x'], ['--plugin-dir', '/home/node/.claude/plugins/x'], ['--settings=/home/node/.claude/settings.json']]) {
      expect(() => checkHeadlessArgs(bad, o)).toThrow(MinionsError);
    }
    expect(checkHeadlessArgs(['-p', '--plugin-dir', '/opt/minions/plugin'], o)).toEqual(['-p', '--plugin-dir', '/opt/minions/plugin']);
  });

  it('the child env drops every inherited credential and keeps unrelated variables', () => {
    const cred = { method: 'login' as const, envName: 'CLAUDE_CODE_OAUTH_TOKEN' as const, token: OAUTH, source: 'x' };
    const e = headlessEnv({ ...env, GH_TOKEN: 'gh', ANTHROPIC_BASE_URL: 'http://proxy' }, '/scratch/run/config', cred);
    expect(e).toMatchObject({ CLAUDE_CONFIG_DIR: '/scratch/run/config', CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_BASE_URL: 'http://proxy' });
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'TELEGRAM_BOT_TOKEN', 'GH_TOKEN']) expect(e[k]).toBeUndefined();
  });
});
