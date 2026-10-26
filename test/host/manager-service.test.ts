// task-53.6 (docs/design/host-manager.md, phase 5): the manager's supervisor service (launchd agent / systemd --user
// unit), the self-upgrade restart, the heartbeat, and the manager in `minions status` / `status --check`. Every
// launchctl / systemctl / loginctl call goes to a fake runner; the "home" is a temp dir. Temp MINIONS_HOME.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const S = await import('../../src/host/manager-service.js');
const ST = await import('../../src/host/manager-status.js');
const { managerPaths } = await import('../../src/core/paths.js');
const { withHome } = await import('./fixtures.js');
type RunResult = import('../../src/core/exec.js').RunResult;
type ServiceHost = import('../../src/host/manager-service.js').ServiceHost;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const PROGRAM = ['/usr/bin/env', 'node', '/opt/minions/dist/cli.js', 'manager', 'run'];

/** A fake service manager: answers by command prefix ("systemctl --user enable"), records every call. */
function fakeRunner(answers: Record<string, Partial<RunResult>> = {}) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(answers).sort((a, b) => b.length - a.length).find((k) => line.startsWith(k));
    return { code: 0, stdout: '', stderr: '', ...(key ? answers[key] : {}) };
  };
  return { runner, calls };
}

function host(platform: NodeJS.Platform, runner: ServiceHost['runner'], over: Partial<ServiceHost> = {}): ServiceHost {
  return S.serviceHost({
    platform, home: join(env.root, 'userhome'), uid: 501, user: 'ada', runner, program: PROGRAM, nodeDir: '/opt/node/bin',
    env: { PATH: '/usr/bin:/bin', MINIONS_HOME: env.home, DOCKER_HOST: 'unix:///run/user/501/docker.sock' }, ...over,
  });
}

describe('systemd --user unit (Linux)', () => {
  it('installs atomically, enables and starts; a rerun with the same content writes nothing and only starts', async () => {
    const f = fakeRunner({ 'loginctl show-user': { stdout: 'no\n' } });
    const h = host('linux', f.runner);
    const r = await S.installManagerService(h);
    const unit = S.serviceNames(h.env).unit;
    const path = join(env.root, 'userhome', '.config', 'systemd', 'user', unit);
    expect(r).toMatchObject({ action: 'installed', kind: 'systemd', path, started: true });
    expect(unit).toMatch(/^minions-manager-[0-9a-f]{8}\.service$/);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('ExecStart="/usr/bin/env" "node" "/opt/minions/dist/cli.js" "manager" "run"');
    expect(text).toContain('Restart=always');
    expect(text).toContain(`SuccessExitStatus=${S.MANAGER_RESTART_EXIT_CODE}`);
    expect(text).toContain('WantedBy=default.target');
    expect(text).toContain('Environment="PATH=/opt/node/bin:/usr/bin:/bin"');
    expect(text).toContain(`Environment="MINIONS_HOME=${env.home}"`);
    expect(text).toContain('Environment="DOCKER_HOST=unix:///run/user/501/docker.sock"');
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(f.calls).toEqual([
      'systemctl --user daemon-reload', `systemctl --user enable ${unit}`, `systemctl --user restart ${unit}`,
      'loginctl show-user ada --property=Linger --value',
    ]);
    expect(r.warnings).toEqual([expect.stringContaining('enable-linger')]);
    const rec = await S.loadServiceRecord();
    expect(rec).toMatchObject({ version: 1, kind: 'systemd', name: unit, path });
    expect(statSync(managerPaths().serviceJson).mode & 0o777).toBe(0o600);

    const ino = statSync(path).ino;
    f.calls.length = 0;
    const again = await S.installManagerService(h);
    expect(again.action).toBe('unchanged');
    expect(statSync(path).ino).toBe(ino); // not rewritten
    expect(f.calls.slice(0, 2)).toEqual([`systemctl --user enable ${unit}`, `systemctl --user start ${unit}`]);
    f.calls.length = 0;
    await S.installManagerService(h, { restart: true });
    expect(f.calls[1]).toBe(`systemctl --user restart ${unit}`);
    // A new CLI path is an update: rewritten, reloaded, restarted.
    f.calls.length = 0;
    const moved = await S.installManagerService({ ...h, program: [...PROGRAM.slice(0, 2), '/new/cli.js', 'manager', 'run'] });
    expect(moved.action).toBe('updated');
    expect(readFileSync(path, 'utf8')).toContain('"/new/cli.js"');
    expect(f.calls.slice(0, 3)).toEqual(['systemctl --user daemon-reload', `systemctl --user enable ${unit}`, `systemctl --user restart ${unit}`]);
  });

  it('a refusing systemctl is an error with a hint; the file and record stay so remove cleans up', async () => {
    const f = fakeRunner({ 'systemctl --user enable': { code: 1, stderr: 'Failed to connect to bus: No medium found' } });
    const h = host('linux', f.runner);
    await expect(S.installManagerService(h)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringContaining('Failed to connect to bus'), hint: expect.stringContaining('enable-linger') });
    const rec = (await S.loadServiceRecord())!;
    expect(existsSync(rec.path)).toBe(true);
    writeFileSync(managerPaths().stateJson, '{}');
    writeFileSync(managerPaths().logFile, 'log');
    f.calls.length = 0;
    const r = await S.removeManagerService(h);
    expect(r).toMatchObject({ action: 'removed', path: rec.path });
    expect(f.calls).toEqual([`systemctl --user disable --now ${rec.name}`, 'systemctl --user daemon-reload']);
    for (const p of [rec.path, managerPaths().serviceJson, managerPaths().stateJson, managerPaths().logFile]) expect(existsSync(p)).toBe(false);
    f.calls.length = 0;
    expect(await S.removeManagerService(h)).toMatchObject({ action: 'absent' });
    expect(f.calls).toEqual([]);
  });

  it('quotes for systemd ($, %, quotes, backslashes) and refuses control characters', () => {
    const unit = S.systemdUnit({ program: ['/a b/node', '50%', '$HOME', 'say "hi"', 'c:\\x'], env: { PATH: '/x%y:$z' } });
    expect(unit).toContain('ExecStart="/a b/node" "50%%" "$$HOME" "say \\"hi\\"" "c:\\\\x"');
    expect(unit).toContain('Environment="PATH=/x%%y:$z"');
    expect(() => S.systemdUnit({ program: ['node', 'a\nExecStartPre=/bin/evil'], env: {} })).toThrow(/control character/);
    expect(() => S.systemdUnit({ program: ['node'], env: { 'BAD NAME': 'x' } })).toThrow(/not an environment variable name/);
  });

  it('the service state comes from `systemctl --user show`; nothing is asked when no service is recorded', async () => {
    const f = fakeRunner({ 'systemctl --user show': { stdout: 'ActiveState=active\nSubState=running\nMainPID=4242\nLoadState=loaded\n' } });
    const h = host('linux', f.runner);
    expect(await S.serviceState(h)).toMatchObject({ installed: false, active: null, detail: 'not installed' });
    expect(f.calls).toEqual([]);
    await S.installManagerService(h);
    expect(await S.serviceState(h)).toMatchObject({ kind: 'systemd', installed: true, active: 'running', fileMatches: true, detail: expect.stringContaining('active (running), pid 4242') });
    writeFileSync((await S.loadServiceRecord())!.path, '# edited by hand\n');
    expect((await S.serviceState(h)).fileMatches).toBe(false);
  });
});

describe('launchd agent (macOS)', () => {
  it('writes the plist (KeepAlive, RunAtLoad, log file) and bootstraps it into gui/<uid>; reloads only on change', async () => {
    const f = fakeRunner({ 'launchctl print': { code: 113, stderr: 'Could not find service' } });
    const h = host('darwin', f.runner, { program: ['/usr/bin/env', 'node', '/Users/a & b/<cli>.js', 'manager', 'run'] });
    const r = await S.installManagerService(h);
    const { label } = S.serviceNames(h.env);
    const path = join(env.root, 'userhome', 'Library', 'LaunchAgents', `${label}.plist`);
    expect(r).toMatchObject({ action: 'installed', kind: 'launchd', path });
    const plist = readFileSync(path, 'utf8');
    expect(plist).toContain(`<key>Label</key><string>${label}</string>`);
    expect(plist).toContain('<string>/Users/a &amp; b/&lt;cli&gt;.js</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain(`<key>StandardErrorPath</key><string>${managerPaths().logFile}</string>`);
    expect(plist).toContain(`<key>MINIONS_HOME</key><string>${env.home}</string>`);
    expect(f.calls).toEqual([`launchctl print gui/501/${label}`, `launchctl enable gui/501/${label}`, `launchctl bootstrap gui/501 ${path}`]);

    // Loaded and unchanged: nothing to do. Loaded and changed (or restart): bootout, then bootstrap.
    const loaded = fakeRunner({ 'launchctl print': { stdout: 'state = running\n\tpid = 777\n' } });
    expect((await S.installManagerService({ ...h, runner: loaded.runner })).action).toBe('unchanged');
    expect(loaded.calls).toEqual([`launchctl print gui/501/${label}`]);
    loaded.calls.length = 0;
    await S.installManagerService({ ...h, runner: loaded.runner }, { restart: true });
    expect(loaded.calls).toEqual([`launchctl print gui/501/${label}`, `launchctl bootout gui/501/${label}`, `launchctl enable gui/501/${label}`, `launchctl bootstrap gui/501 ${path}`]);
    expect(await S.serviceState({ ...h, runner: loaded.runner })).toMatchObject({ active: 'running', detail: expect.stringContaining('running (pid 777)') });

    loaded.calls.length = 0;
    expect(await S.removeManagerService({ ...h, runner: loaded.runner })).toMatchObject({ action: 'removed', path });
    expect(loaded.calls).toEqual([`launchctl bootout gui/501/${label}`]);
    expect(existsSync(path)).toBe(false);
  });

  it('unsupported platforms are refused without touching anything', async () => {
    const f = fakeRunner();
    await expect(S.installManagerService(host('win32', f.runner))).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringContaining('No supported user service manager on win32') });
    expect(f.calls).toEqual([]);
    expect(existsSync(managerPaths().serviceJson)).toBe(false);
  });
});

describe('the service record is not trusted', () => {
  it('a record naming another file is refused: remove uses the default unit of this minions home, never that file', async () => {
    const victim = join(env.root, 'important.txt');
    writeFileSync(victim, 'keep me');
    mkdirSync(managerPaths().dir, { recursive: true });
    writeFileSync(managerPaths().serviceJson, JSON.stringify({ version: 1, kind: 'systemd', name: 'minions-manager.service', path: victim, sha256: 'x', installedAt: 'now' }));
    await expect(S.loadServiceRecord()).rejects.toThrow(/does not name a minions manager unit file/);
    const f = fakeRunner();
    const r = await S.removeManagerService(host('linux', f.runner));
    expect(r.action).toBe('removed');
    expect(r.path).not.toBe(victim);
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(existsSync(managerPaths().serviceJson)).toBe(false);
  });

  it('names: the default home has the plain names, a MINIONS_HOME gets a stable suffix', () => {
    expect(S.serviceNames({})).toEqual({ label: 'dev.minions.manager', unit: 'minions-manager.service' });
    const a = S.serviceNames({ MINIONS_HOME: '/a' });
    expect(a.label).toMatch(/^dev\.minions\.manager-[0-9a-f]{8}$/);
    expect(S.serviceNames({ MINIONS_HOME: '/a' })).toEqual(a);
    expect(S.serviceNames({ MINIONS_HOME: '/b' }).label).not.toBe(a.label);
  });
});

describe('self-upgrade detection', () => {
  it('cliChangeWatcher: a rewritten dist/cli.js is a change; a missing file (mid-install) is not yet', () => {
    const root = join(env.root, 'pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'cli.js'), 'v1');
    writeFileSync(join(root, 'package.json'), '{"version":"0.1.0"}');
    const changed = S.cliChangeWatcher(() => S.cliStamp(root));
    expect(changed()).toBe(false);
    const tmp = join(root, 'dist', 'cli.js.new');
    writeFileSync(tmp, 'v2 longer');
    writeFileSync(join(root, 'dist', 'cli.js'), readFileSync(tmp));
    expect(changed()).toBe(true);
    let stamp: string | null = 'a';
    const w = S.cliChangeWatcher(() => stamp);
    stamp = null;
    expect(w()).toBe(false);
    stamp = 'b';
    expect(w()).toBe(true);
    expect(S.cliChangeWatcher(() => null)()).toBe(false);
  });

  it('managerProgram runs the CLI script through env node, so PATH picks node', () => {
    expect(S.managerProgram({ script: '/usr/local/bin/minions', execArgv: [] })).toEqual(['/usr/bin/env', 'node', '/usr/local/bin/minions', 'manager', 'run']);
    expect(S.serviceEnvironment({ env: { PATH: '/opt/node/bin:/bin' }, nodeDir: '/opt/node/bin' }).PATH).toBe('/opt/node/bin:/bin');
  });
});

describe('heartbeat, status and status --check', () => {
  const lock = (pid: number, start: string | null) => {
    mkdirSync(managerPaths().dir, { recursive: true });
    writeFileSync(join(managerPaths().dir, 'lock'), JSON.stringify({ pid, start, at: '2026-10-26T09:00:00.000Z' }));
  };

  it('the process state is the lock holder plus its own heartbeat; a heartbeat of another process is ignored', async () => {
    expect(await S.managerProcessState()).toMatchObject({ running: false });
    const now = new Date('2026-10-26T10:00:00Z');
    const beat = S.managerHeartbeat({ transport: 'telegram', botId: '555', now: () => now });
    await beat.start();
    await beat.poll(new Date('2026-10-26T10:00:20Z'));
    const st = JSON.parse(readFileSync(managerPaths().stateJson, 'utf8'));
    expect(st).toMatchObject({ pid: process.pid, transport: 'telegram', botId: '555', lastPollAt: '2026-10-26T10:00:20.000Z' });
    expect(statSync(managerPaths().stateJson).mode & 0o777).toBe(0o600);
    lock(process.pid, st.start);
    expect(await S.managerProcessState()).toMatchObject({ running: true, pid: process.pid, transport: 'telegram', botId: '555', lastPollAt: '2026-10-26T10:00:20.000Z', since: '2026-10-26T09:00:00.000Z' });
    // A dead holder: not running. A reused pid (other start time): not running.
    expect(await S.managerProcessState({ alive: () => false })).toMatchObject({ running: false });
    lock(process.pid, 'other-start');
    expect(await S.managerProcessState({ startOf: () => 'now-start' })).toMatchObject({ running: false });
    // Another live process holds the lock: its state, not this heartbeat.
    lock(1, null);
    expect(await S.managerProcessState({ alive: () => true })).toMatchObject({ running: true, pid: 1, transport: null, lastPollAt: null });
  });

  it('overview: pending offers per project from the journal; human lines and checks never fail', async () => {
    const J = await import('../../src/host/change-journal.js');
    mkdirSync(managerPaths().dir, { recursive: true });
    const offer = (projectId: string, requestId: string, expiresAt: string) => JSON.stringify({ type: 'offer', at: 't', projectId, requestId, digest: 'd', configRevision: 1, nonce: 'n'.repeat(32), expiresAt,
      request: { id: requestId, kind: 'restart', payload: {}, reason: null }, plan: { kind: 'restart', steps: ['settings restart'] } });
    writeFileSync(J.journalPath(), [
      offer('p1', 'cr_00000001', '2026-10-26T10:30:00.000Z'),
      offer('p1', 'cr_00000002', '2026-10-26T09:00:00.000Z'),
      offer('p2', 'cr_00000003', '2026-10-26T10:30:00.000Z'),
      JSON.stringify({ type: 'applied', at: 't', projectId: 'p2', requestId: 'cr_00000003' }),
    ].join('\n') + '\n');
    const now = new Date('2026-10-26T10:00:00Z');
    const f = fakeRunner();
    const m = await ST.managerOverview({ host: host('linux', f.runner), now });
    expect(f.calls).toEqual([]);
    expect(m.pending).toEqual([{ projectId: 'p1', name: null, requests: [
      { requestId: 'cr_00000001', kind: 'restart', summary: 'restart the coordinator', expiresAt: '2026-10-26T10:30:00.000Z', expired: false },
      { requestId: 'cr_00000002', kind: 'restart', summary: 'restart the coordinator', expiresAt: '2026-10-26T09:00:00.000Z', expired: true },
    ] }]);
    const text = ST.formatManagerOverview(m, now).join('\n');
    expect(text).toContain('service: not installed');
    expect(text).toContain('bot: not set up');
    expect(text).toContain('process: not running');
    expect(text).toContain('pending requests, p1: 2');
    expect(text).toContain('cr_00000002 restart the coordinator (offer expired');
    const checks = ST.managerServiceChecks(m, { platform: 'linux', now });
    expect(checks).toEqual([
      { name: 'manager.service', status: 'ok', detail: 'not installed (optional)' },
      { name: 'manager.process', status: 'unavailable', detail: 'not running' },
    ]);
    expect(ST.managerServiceChecks(m, { platform: 'win32', now })[0]).toMatchObject({ status: 'unavailable' });

    // Installed and running, polling: ok. Stale poll: warn. Installed but stopped: warn. Never fail.
    await S.installManagerService(host('linux', f.runner));
    const running = fakeRunner({ 'systemctl --user show': { stdout: 'ActiveState=active\nSubState=running\nMainPID=99\n' } });
    lock(process.pid, null);
    await S.writeManagerState({ version: 1, pid: process.pid, start: null, startedAt: 'x', transport: 'log', botId: null, lastPollAt: '2026-10-26T09:59:40.000Z' });
    const up = await ST.managerOverview({ host: host('linux', running.runner), now });
    expect(ST.managerServiceChecks(up, { platform: 'linux', now }).map((c) => [c.name, c.status])).toEqual([['manager.service', 'ok'], ['manager.process', 'ok']]);
    expect(ST.formatManagerOverview(up, now).join('\n')).toMatch(/systemd --user unit installed, running[\s\S]*process: running \(pid \d+.*log only\), last poll 20 s ago/);
    const later = new Date('2026-10-26T10:10:00Z');
    expect(ST.managerServiceChecks(up, { platform: 'linux', now: later })[1]).toMatchObject({ status: 'warn', detail: expect.stringContaining('stalled') });
    const stopped = fakeRunner({ 'systemctl --user show': { stdout: 'ActiveState=failed\nSubState=failed\nMainPID=0\n' } });
    const down = await ST.managerOverview({ host: host('linux', stopped.runner), now, alive: () => false });
    const c = ST.managerServiceChecks(down, { platform: 'linux', now });
    expect(c.map((x) => [x.name, x.status])).toEqual([['manager.service', 'warn'], ['manager.process', 'warn']]);
    expect(c.every((x) => (x.status as string) !== 'fail')).toBe(true);
    expect(ST.managerOverviewJson(down)).toMatchObject({ running: false, service: { installed: true, active: 'stopped' } });
  });
});
