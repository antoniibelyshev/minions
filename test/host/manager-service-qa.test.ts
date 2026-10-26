// task-53.6 QA: edges of the manager supervisor service. Every launchctl / systemctl / loginctl call goes to a fake
// runner (tests never call the real ones); the "home" is a temp dir; temp MINIONS_HOME.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      return [];
    },
  };
});

const S = await import('../../src/host/manager-service.js');
const ST = await import('../../src/host/manager-status.js');
const D = await import('../../src/host/doctor.js');
const { managerPaths } = await import('../../src/core/paths.js');
const { withHome } = await import('./fixtures.js');
type RunResult = import('../../src/core/exec.js').RunResult;
type ServiceHost = import('../../src/host/manager-service.js').ServiceHost;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const PROGRAM = ['/usr/bin/env', 'node', '/opt/minions/dist/cli.js', 'manager', 'run'];

function fakeRunner(answer: (line: string) => Partial<RunResult> = () => ({})) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[]): Promise<RunResult> => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    return { code: 0, stdout: '', stderr: '', ...answer(line) };
  };
  return { runner, calls };
}

function host(platform: NodeJS.Platform, runner: ServiceHost['runner'], over: Partial<ServiceHost> = {}): ServiceHost {
  return S.serviceHost({
    platform, home: join(env.root, 'userhome'), uid: 501, user: null, runner, program: PROGRAM, nodeDir: '/opt/node/bin',
    env: { PATH: '/usr/bin:/bin', MINIONS_HOME: env.home }, ...over,
  });
}

const writeRecord = (rec: unknown) => {
  mkdirSync(managerPaths().dir, { recursive: true });
  writeFileSync(managerPaths().serviceJson, typeof rec === 'string' ? rec : JSON.stringify(rec));
};

describe('tampered or corrupt service.json: status and doctor never ask the service manager', () => {
  const tampered = [
    ['not JSON', '{oops'],
    ['a non-minions unit', { version: 1, kind: 'systemd', name: 'sshd.service', path: '/etc/systemd/system/sshd.service', sha256: 'x', installedAt: 't' }],
    ['a minions name at another file', { version: 1, kind: 'systemd', name: 'minions-manager.service', path: '/etc/passwd', sha256: 'x', installedAt: 't' }],
    ['a .. path', { version: 1, kind: 'systemd', name: 'minions-manager.service', path: '/home/u/.config/systemd/user/../../../../etc/systemd/user/minions-manager.service', sha256: 'x', installedAt: 't' }],
    ['a relative path', { version: 1, kind: 'launchd', name: 'dev.minions.manager', path: 'Library/LaunchAgents/dev.minions.manager.plist', sha256: 'x', installedAt: 't' }],
    ['a non-minions launchd label', { version: 1, kind: 'launchd', name: 'com.apple.Finder', path: '/Users/u/Library/LaunchAgents/com.apple.Finder.plist', sha256: 'x', installedAt: 't' }],
  ] as const;

  for (const [what, rec] of tampered) {
    it(`${what}: serviceState, overview and doctor checks make no call and never fail`, async () => {
      writeRecord(rec);
      await expect(S.loadServiceRecord()).rejects.toThrow();
      const f = fakeRunner();
      for (const platform of ['linux', 'darwin'] as const) {
        const st = await S.serviceState(host(platform, f.runner));
        expect(st).toMatchObject({ installed: false, active: 'unknown', detail: expect.stringContaining('service.json is unreadable') });
        const m = await ST.managerOverview({ host: host(platform, f.runner) });
        const checks = ST.managerServiceChecks(m, { platform });
        expect(checks.find((c) => c.name === 'manager.service')).toMatchObject({ status: 'warn' });
        expect(checks.every((c) => (c.status as string) !== 'fail')).toBe(true);
        expect(ST.formatManagerOverview(m).join('\n')).toContain('service: not installed');
        const dc = await D.managerSupervisorChecks({ runner: f.runner, platform });
        expect(dc.every((c) => c.status !== 'fail')).toBe(true);
      }
      expect(f.calls).toEqual([]);
    });
  }

  it('a non-minions record on remove: only the default minions unit of this home is touched, never the named one', async () => {
    writeRecord({ version: 1, kind: 'systemd', name: 'sshd.service', path: join(env.root, 'sshd.service'), sha256: 'x', installedAt: 't' });
    writeFileSync(join(env.root, 'sshd.service'), 'keep');
    const f = fakeRunner();
    const r = await S.removeManagerService(host('linux', f.runner));
    expect(f.calls.join('\n')).not.toContain('sshd');
    expect(f.calls[0]).toMatch(/^systemctl --user disable --now minions-manager-[0-9a-f]{8}\.service$/);
    expect(readFileSync(join(env.root, 'sshd.service'), 'utf8')).toBe('keep');
    expect(r.warnings).toEqual([expect.stringContaining('unreadable')]);
  });
});

describe('doctor manager.* checks never fail', () => {
  it('a throwing or failing service manager is a warning, not a failure', async () => {
    await S.installManagerService(host('linux', fakeRunner().runner));
    const boom = async (): Promise<RunResult> => { throw new Error('spawn systemctl ENOENT'); };
    const fail = fakeRunner(() => ({ code: 1, stderr: 'Failed to connect to bus' }));
    for (const runner of [boom, fail.runner]) {
      const checks = await D.managerSupervisorChecks({ runner, platform: 'linux' });
      expect(checks.map((c) => c.name)).toEqual(['manager.service', 'manager.process']);
      expect(checks.every((c) => c.status !== 'fail')).toBe(true);
      expect(checks[0]).toMatchObject({ status: 'warn' });
    }
    // The recorded unit file was deleted by hand: warn, and no query.
    const rec = (await S.loadServiceRecord())!;
    const { rmSync } = await import('node:fs');
    rmSync(rec.path);
    const f = fakeRunner();
    const checks = await D.managerSupervisorChecks({ runner: f.runner, platform: 'linux' });
    expect(checks[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('is missing') });
    expect(f.calls).toEqual([]);
  });
});

describe('unit content with spaces and special characters in paths', () => {
  /** Splits an ExecStart= / Environment= value the way systemd does for double-quoted words (subset). */
  function systemdWords(v: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < v.length) {
      if (v[i] === ' ') { i++; continue; }
      expect(v[i]).toBe('"');
      let w = '';
      i++;
      while (v[i] !== '"') {
        if (v[i] === '\\') { w += v[i + 1]; i += 2; continue; }
        if (v[i] === '%') { expect(v[i + 1]).toBe('%'); w += '%'; i += 2; continue; }
        if (v[i] === '$' && v[i + 1] === '$') { w += '$'; i += 2; continue; }
        w += v[i++];
      }
      i++;
      out.push(w);
    }
    return out;
  }

  it('systemd: CLI, MINIONS_HOME and PATH with spaces, %, $ and quotes round-trip through the quoting', async () => {
    const home = join(env.root, 'my home %h $USER "q"');
    const program = ['/usr/bin/env', 'node', '/Users/Ada Lovelace/.npm global/lib/node_modules/minions/dist/cli.js', 'manager', 'run'];
    const h = host('linux', fakeRunner().runner, { program, home, nodeDir: '/opt/node 22/bin', env: { PATH: '/usr/bin:/my tools/bin', MINIONS_HOME: '/data/minions home 50%' } });
    const r = await S.installManagerService(h);
    expect(r.path!.startsWith(join(home, '.config', 'systemd', 'user'))).toBe(true);
    const text = readFileSync(r.path!, 'utf8');
    const exec = /^ExecStart=(.*)$/m.exec(text)![1]!;
    expect(systemdWords(exec)).toEqual(program);
    const envs = [...text.matchAll(/^Environment=(.*)$/gm)].map((m) => systemdWords(m[1]!)[0]);
    expect(envs).toEqual(['PATH=/opt/node 22/bin:/usr/bin:/my tools/bin', 'MINIONS_HOME=/data/minions home 50%']);
    // WorkingDirectory uses the specifier, not the raw home (which would need quoting).
    expect(text).toContain('WorkingDirectory=%h');
  });

  it('launchd: paths with spaces, & and < are XML-escaped and nothing else changes', async () => {
    const home = join(env.root, 'Ada & <Co> "home"');
    const program = ['/usr/bin/env', 'node', '/Users/Ada Lovelace/cli & co.js', 'manager', 'run'];
    const h = host('darwin', fakeRunner((l) => (l.startsWith('launchctl print') ? { code: 113 } : {})).runner, { program, home });
    const r = await S.installManagerService(h);
    const plist = readFileSync(r.path!, 'utf8');
    const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1]!;
    expect([...args.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1]!))).toEqual(program);
    expect(unxml(/<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(plist)![1]!)).toBe(home);
    expect(plist).not.toMatch(/<string>[^<]*[<>"][^<]*<\/string>/);
  });

  it('a line break anywhere (program, env value, home) is refused before anything is written or called', async () => {
    const f = fakeRunner();
    for (const over of [
      { program: ['/usr/bin/env', 'node', '/x\n[Service]\nExecStartPre=/bin/evil', 'manager', 'run'] },
      { env: { PATH: '/bin', MINIONS_HOME: '/h\nExecStartPre=/bin/evil' } },
    ] as Partial<ServiceHost>[]) {
      for (const platform of ['linux', 'darwin'] as const) {
        await expect(S.installManagerService(host(platform, f.runner, over))).rejects.toMatchObject({ code: 'PRECONDITION' });
      }
    }
    await expect(S.installManagerService(host('darwin', f.runner, { home: join(env.root, 'a\nb') }))).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(f.calls).toEqual([]);
    expect(existsSync(managerPaths().serviceJson)).toBe(false);
  });
});

describe('rerun idempotence', () => {
  it('three identical installs write the file once and keep one record; launchd: no reload when loaded and unchanged', async () => {
    const loaded = fakeRunner((l) => (l.startsWith('launchctl print') ? { stdout: 'state = running\n' } : {}));
    const h = host('darwin', loaded.runner);
    const first = await S.installManagerService(h, { now: new Date('2026-10-26T10:00:00Z') });
    expect(first.action).toBe('installed');
    const text = readFileSync(first.path!, 'utf8');
    loaded.calls.length = 0;
    for (let i = 0; i < 2; i++) expect((await S.installManagerService(h)).action).toBe('unchanged');
    expect(loaded.calls.every((c) => c.startsWith('launchctl print'))).toBe(true);
    expect(readFileSync(first.path!, 'utf8')).toBe(text);
    const rec = (await S.loadServiceRecord())!;
    expect(rec).toMatchObject({ kind: 'launchd', path: first.path, sha256: (await import('../../src/core/fsutil.js')).sha256(text) });
  });

  it('a moved XDG_CONFIG_HOME: the old unit is disabled and removed, one unit stays', async () => {
    const f = fakeRunner();
    const a = await S.installManagerService(host('linux', f.runner, { env: { PATH: '/bin', MINIONS_HOME: env.home, XDG_CONFIG_HOME: join(env.root, 'cfg-a') } }));
    f.calls.length = 0;
    const b = await S.installManagerService(host('linux', f.runner, { env: { PATH: '/bin', MINIONS_HOME: env.home, XDG_CONFIG_HOME: join(env.root, 'cfg-b') } }));
    expect(b.path).not.toBe(a.path);
    expect(existsSync(a.path!)).toBe(false);
    expect(existsSync(b.path!)).toBe(true);
    expect(f.calls[0]).toMatch(/^systemctl --user disable --now minions-manager-/);
    expect(b.warnings).toEqual([expect.stringContaining(`removed the previous service file ${a.path}`)]);
    expect((await S.loadServiceRecord())!.path).toBe(b.path);
  });

  it('remove is idempotent and makes no call once nothing is recorded', async () => {
    const f = fakeRunner();
    await S.installManagerService(host('linux', f.runner));
    await S.removeManagerService(host('linux', f.runner));
    f.calls.length = 0;
    for (let i = 0; i < 2; i++) expect(await S.removeManagerService(host('linux', f.runner))).toMatchObject({ action: 'absent' });
    expect(f.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- setup and uninstall edges

describe('setup and uninstall: the service is never installed or probed by accident', () => {
  const MGR = '555666777:MMHmanagermanagermanagermanager_-9876';
  const fakeRuntime = () => ({
    containerRunning: async () => false, start: async () => undefined, repoPresent: async () => true,
    importRepo: async () => { throw new Error('not used'); }, launchCoordinator: async () => ({ action: 'started' as const }), attachCommand: () => 'attach',
  });
  /** Docker / git runner for setup and uninstall: answers 0 and records service-manager calls separately. */
  const svcCalls: string[] = [];
  const anyRunner = async (cmd: string, args: string[]): Promise<RunResult> => {
    if (['launchctl', 'systemctl', 'loginctl'].includes(cmd)) svcCalls.push([cmd, ...args].join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  beforeEach(() => { svcCalls.length = 0; });

  it('--yes with a manager token never installs on macOS or Linux, across reruns', async () => {
    const { runSetup } = await import('../../src/host/setup.js');
    const { makeRepo, dockerUp } = await import('./fixtures.js');
    const repo = makeRepo(env.root);
    for (const platform of ['darwin', 'linux'] as const) {
      const managerService = { platform, home: join(env.root, 'userhome'), runner: anyRunner, uid: 501, user: null, program: PROGRAM };
      for (let i = 0; i < 2; i++) {
        const r = await runSetup({ path: repo, yes: true, ...(i === 0 ? { tokens: { manager: MGR } } : {}), runtime: fakeRuntime(), dockerProbe: dockerUp, platform, managerService });
        expect(r.steps.find((s) => s.id === 'service')).toMatchObject({ status: 'skipped' });
      }
    }
    expect(svcCalls).toEqual([]);
    expect(existsSync(managerPaths().serviceJson)).toBe(false);
    expect(existsSync(join(env.root, 'userhome', 'Library'))).toBe(false);
    expect(existsSync(join(env.root, 'userhome', '.config'))).toBe(false);
  });

  it('uninstall without a record never calls the service manager; a non-last project keeps even a corrupt record', async () => {
    const { runSetup } = await import('../../src/host/setup.js');
    const { runUninstall } = await import('../../src/host/uninstall.js');
    const { makeRepo, dockerUp } = await import('./fixtures.js');
    const managerService = { platform: 'linux' as const, home: join(env.root, 'userhome'), runner: anyRunner, uid: 501, user: null, program: PROGRAM };
    const a = makeRepo(env.root, 'a');
    const b = makeRepo(env.root, 'b');
    const c = makeRepo(env.root, 'c');
    for (const p of [a, b, c]) await runSetup({ path: p, yes: true, runtime: fakeRuntime(), dockerProbe: dockerUp, managerService });

    // Nothing recorded: no call on a non-last or (later) the last project.
    expect((await runUninstall({ cwd: a, yes: true, runner: anyRunner, managerService })).managerService).toBe('absent');
    // A tampered record while another project remains: kept as it is, no call.
    writeRecord({ version: 1, kind: 'systemd', name: 'sshd.service', path: '/etc/systemd/system/sshd.service', sha256: 'x', installedAt: 't' });
    const dry = await runUninstall({ cwd: b, dryRun: true, runner: anyRunner, managerService });
    expect(dry.managerService).toBe('absent');
    const mid = await runUninstall({ cwd: b, yes: true, runner: anyRunner, managerService });
    expect(mid.managerService).toBe('absent');
    expect(existsSync(managerPaths().serviceJson)).toBe(true);
    expect(svcCalls).toEqual([]);
    // Last project, record removed by hand first: still no call.
    const { rmSync } = await import('node:fs');
    rmSync(managerPaths().serviceJson);
    expect((await runUninstall({ cwd: c, yes: true, runner: anyRunner, managerService })).managerService).toBe('absent');
    expect(svcCalls).toEqual([]);
  });
});
