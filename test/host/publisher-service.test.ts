// The host publisher's service and token (docs/design/autonomy.md Decision 17): the launchd / systemd unit (fake
// launchctl and systemctl), its record, the per-home lock, and the host-wide token that must never be a coordinator's bot.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { projectPaths, publisherPaths, registryPath } from '../../src/core/paths.js';
import {
  loadPublisherCredentialRef, provisionPublisherToken, provisionTelegramToken, readPublisherToken, removePublisherToken,
} from '../../src/host/credentials.js';
import {
  installPublisherService, launchdPlist, publisherProgram, removePublisherService, serviceEnvironment, serviceHost, serviceState, stableAgentSocket,
  systemdUnit, takePublisherLock, type ServiceHost,
} from '../../src/host/publisher-service.js';
import { pushAuthFacts, isSshUrl } from '../../src/host/publish.js';
import { withHome } from './fixtures.js';

const PUB_TOKEN = `1234567:${'A'.repeat(35)}`;
const COORD_TOKEN = `7654321:${'B'.repeat(35)}`;

let home: ReturnType<typeof withHome>;
beforeEach(() => { home = withHome(); });
afterEach(() => home.cleanup());

function fakeHost(platform: NodeJS.Platform, answers: (cmd: string, args: string[]) => Partial<RunResult> = () => ({})) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { code: 0, stdout: '', stderr: '', ...answers(cmd, args) };
  };
  const host: ServiceHost = serviceHost({ platform, home: join(home.root, 'user'), env: { PATH: '/usr/bin:/bin', MINIONS_HOME: home.home }, uid: 501, user: 'me', runner,
    program: ['/usr/bin/env', 'node', '/opt/minions/dist/cli.js', 'settings', 'requests', 'serve'], nodeDir: '/opt/node/bin' });
  return { host, calls };
}

describe('publisher service unit', () => {
  it('runs the hidden `settings requests serve` with PATH and the minions home; pins only a stable agent socket', () => {
    expect(publisherProgram({ script: '/x/cli.js', execArgv: [] })).toEqual(['/usr/bin/env', 'node', '/x/cli.js', 'settings', 'requests', 'serve']);
    expect(stableAgentSocket('/private/tmp/com.apple.launchd.abc/Listeners')).toBeNull();
    expect(stableAgentSocket('/tmp/ssh-XYZ/agent.123')).toBeNull();
    expect(stableAgentSocket('/Users/me/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock')).toMatch(/agent\.sock$/);
    const env = serviceEnvironment({ env: { PATH: '/usr/bin', MINIONS_HOME: '/h', SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh', SECRET: 'x' }, nodeDir: '/opt/node/bin' });
    expect(env).toEqual({ PATH: '/opt/node/bin:/usr/bin', MINIONS_HOME: '/h', SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh' });
    const plist = launchdPlist({ label: 'dev.minions.publisher', program: ['/usr/bin/env', 'node', 'a&b'], env: { PATH: '/bin' }, log: '/l', home: '/h' });
    expect(plist).toContain('<string>a&amp;b</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(() => launchdPlist({ label: 'x', program: ['bad\nline'], env: {}, log: '/l', home: '/h' })).toThrow(/control character/);
    expect(systemdUnit({ program: ['/usr/bin/env', 'node', '/p/100%/cli.js'], env: { PATH: '/bin' } })).toContain('ExecStart="/usr/bin/env" "node" "/p/100%%/cli.js"');
  });

  it('launchd: installs, records, keeps an unchanged unit running, and removes it', async () => {
    const { host, calls } = fakeHost('darwin', (cmd, args) => (cmd === 'launchctl' && args[0] === 'print' ? { code: 113 } : {}));
    const r = await installPublisherService(host, { now: new Date('2026-11-14T00:00:00Z') });
    expect(r).toMatchObject({ action: 'installed', kind: 'launchd' });
    expect(r.path).toMatch(/Library\/LaunchAgents\/dev\.minions\.publisher-[0-9a-f]{8}\.plist$/);
    expect(readFileSync(r.path!, 'utf8')).toContain('<string>serve</string>');
    expect(calls.some((c) => c.startsWith('launchctl bootstrap gui/501 '))).toBe(true);
    expect(statSync(publisherPaths().serviceJson).mode & 0o777).toBe(0o600);
    const again = await installPublisherService(host);
    expect(again.action).toBe('unchanged');
    const gone = await removePublisherService(host);
    expect(gone).toMatchObject({ action: 'removed', kind: 'launchd' });
    expect(existsSync(r.path!)).toBe(false);
    expect(existsSync(publisherPaths().serviceJson)).toBe(false);
  });

  it('systemd: enables and restarts the user unit, and warns about linger and a missing ssh-agent', async () => {
    const { host, calls } = fakeHost('linux', (cmd) => (cmd === 'loginctl' ? { stdout: 'no\n' } : {}));
    const r = await installPublisherService(host);
    expect(r).toMatchObject({ action: 'installed', kind: 'systemd' });
    expect(calls.filter((c) => c.startsWith('systemctl'))).toEqual([
      'systemctl --user daemon-reload', expect.stringMatching(/^systemctl --user enable minions-publisher-[0-9a-f]{8}\.service$/), expect.stringMatching(/^systemctl --user restart /),
    ]);
    expect(r.warnings.join('\n')).toMatch(/enable-linger/);
    expect(r.warnings.join('\n')).toMatch(/no SSH agent socket/);
    const st = await serviceState({ ...host, runner: async () => ({ code: 0, stdout: 'ActiveState=active\nSubState=running\nMainPID=42\n', stderr: '' }) });
    expect(st).toMatchObject({ installed: true, active: 'running' });
  });

  it('one publisher per home: a live holder keeps the lock, a dead one loses it', () => {
    mkdirSync(publisherPaths().dir, { recursive: true });
    writeFileSync(publisherPaths().lock, JSON.stringify({ pid: 999999 }));
    expect(takePublisherLock({ alive: () => true })).toBeNull();
    const release = takePublisherLock({ alive: () => false });
    expect(release).not.toBeNull();
    expect(JSON.parse(readFileSync(publisherPaths().lock, 'utf8')).pid).toBe(process.pid);
    release!();
    expect(existsSync(publisherPaths().lock)).toBe(false);
  });
});

describe('publisher token', () => {
  /** A registered project whose coordinator bot is COORD_TOKEN's. */
  function coordinatorProject(): string {
    const id = '22222222-2222-4222-8222-222222222222';
    mkdirSync(join(registryPath(), '..'), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify({ version: 1, projects: { [id]: { gitCommonDir: '/r/.git', repoPath: '/r', visibility: 'private' } } }));
    mkdirSync(projectPaths(id).dir, { recursive: true });
    writeFileSync(projectPaths(id).credentialsJson, JSON.stringify({ version: 1, telegram: { backend: 'file', ref: 'file:/x', botId: '7654321', updatedAt: 'now' } }));
    return id;
  }

  it('is stored host-wide in a 0600 file under the credential store, never a coordinator bot', async () => {
    const id = coordinatorProject();
    await expect(provisionPublisherToken({ token: COORD_TOKEN })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/coordinator bot of project\(s\) 2222/) });
    const r = await provisionPublisherToken({ token: PUB_TOKEN });
    expect(r).toMatchObject({ backend: 'file', botId: '1234567' });
    const file = r.ref.replace(/^file:/, '');
    expect(file).toBe(join(home.home, 'credentials', 'publisher', 'publisher-bot-token'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await readPublisherToken()).toEqual({ token: PUB_TOKEN, botId: '1234567' });
    // Nothing of it in the project's references or secrets directory.
    expect(readFileSync(projectPaths(id).credentialsJson, 'utf8')).not.toContain('1234567');
    expect(existsSync(join(projectPaths(id).secretsDir, 'publisher-bot-token'))).toBe(false);
    // And a coordinator can never take the publisher's bot.
    await expect(provisionTelegramToken({ projectId: id, token: PUB_TOKEN, repoPath: '/r' })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/host publisher's bot/) });
    expect(await removePublisherToken()).toEqual({ removed: true, backend: 'file' });
    expect(await loadPublisherCredentialRef()).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('push credentials as the service sees them', () => {
    expect(isSshUrl('git@github.com:o/r.git')).toBe(true);
    expect(isSshUrl('ssh://git@host/r.git')).toBe(true);
    expect(isSshUrl('https://github.com/o/r.git')).toBe(false);
    expect(pushAuthFacts('git@github.com:o/r.git', {})).toMatchObject({ ok: false, detail: expect.stringMatching(/SSH_AUTH_SOCK is not set/) });
    expect(pushAuthFacts('git@github.com:o/r.git', {}, '/keys/deploy')).toMatchObject({ ok: true });
    expect(pushAuthFacts('https://github.com/o/r.git', {})).toMatchObject({ ok: true });
    expect(pushAuthFacts(null, {})).toMatchObject({ ok: false, detail: expect.stringMatching(/publishing is unavailable/) });
  });
});
