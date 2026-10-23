// Linux host support (task-25): host data root, Docker Engine diagnostics and their doctor wiring.
// All fakes: no Docker, no SELinux, no real distro. Every Linux branch is paired with the unchanged macOS behaviour.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import { hostRoot } from '../../src/core/paths.js';
import type { DockerStatus } from '../../src/host/discovery.js';
import { dockerUnavailable } from '../../src/host/install.js';
import {
  composeHint, daemonHint, linuxDockerChecks, linuxHostFacts, unknownLinuxFacts, type LinuxHostFacts,
} from '../../src/host/linux-host.js';
import { runDoctor } from '../../src/host/doctor.js';
import { tempDir, withHome } from './fixtures.js';

const facts = (f: Partial<LinuxHostFacts>): LinuxHostFacts => ({ ...unknownLinuxFacts(), ...f });
const down = (error: string): DockerStatus => ({ daemon: false, serverVersion: null, compose: true, composeVersion: '2.29.1', error });
const up: DockerStatus = { daemon: true, serverVersion: '27.3.1', compose: true, composeVersion: '2.29.1' };
const SEC_ROOTFUL = ['name=apparmor', 'name=seccomp,profile=builtin', 'name=cgroupns'];

describe('host data root', () => {
  it('macOS is unchanged (~/Library/Application Support/Minions) and ignores XDG variables', () => {
    expect(hostRoot({ XDG_DATA_HOME: '/x/data' }, 'darwin', '/Users/u')).toBe('/Users/u/Library/Application Support/Minions');
  });
  it('Linux honours an absolute XDG_DATA_HOME, else ~/.local/share/minions (unset, empty or relative)', () => {
    expect(hostRoot({ XDG_DATA_HOME: '/x/data' }, 'linux', '/home/u')).toBe('/x/data/minions');
    expect(hostRoot({}, 'linux', '/home/u')).toBe('/home/u/.local/share/minions');
    expect(hostRoot({ XDG_DATA_HOME: '' }, 'linux', '/home/u')).toBe('/home/u/.local/share/minions');
    expect(hostRoot({ XDG_DATA_HOME: 'rel/data' }, 'linux', '/home/u')).toBe('/home/u/.local/share/minions');
  });
  it('XDG_CONFIG_HOME does not split the root; MINIONS_HOME wins everywhere', () => {
    expect(hostRoot({ XDG_CONFIG_HOME: '/x/config' }, 'linux', '/home/u')).toBe('/home/u/.local/share/minions');
    expect(hostRoot({ MINIONS_HOME: '/m', XDG_DATA_HOME: '/x' }, 'linux', '/home/u')).toBe('/m');
    expect(hostRoot({ MINIONS_HOME: '/m' }, 'darwin', '/Users/u')).toBe('/m');
  });
});

describe('daemon and compose hints', () => {
  it('macOS keeps the Docker Desktop hints whatever the error', () => {
    expect(daemonHint('darwin', down('permission denied while trying to connect to the Docker daemon socket'))).toBe('Start Docker Desktop.');
    expect(composeHint('darwin', { ...up, compose: false, composeVersion: null })).toBe('Install Docker Compose v2 or newer (bundled with Docker Desktop).');
  });

  it('Linux socket permission denied: docker group or rootless Docker', () => {
    const h = daemonHint('linux', down('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied'));
    expect(h).toContain('sudo usermod -aG docker "$USER"');
    expect(h).toContain('newgrp docker');
    expect(h).toContain('root-equivalent');
    expect(h).toContain('DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock');
  });

  it('Linux daemon not running: systemctl, or the rootless socket / service', () => {
    const err = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
    expect(daemonHint('linux', down(err))).toContain('sudo systemctl enable --now docker');
    expect(daemonHint('linux', down(err), facts({ rootlessSocket: '/run/user/1000/docker.sock' })))
      .toContain('export DOCKER_HOST=unix:///run/user/1000/docker.sock');
    expect(daemonHint('linux', down('Cannot connect to the Docker daemon at unix:///run/user/1000/docker.sock.'), facts({ dockerHost: 'unix:///run/user/1000/docker.sock' })))
      .toContain('systemctl --user start docker');
  });

  it('Linux docker CLI missing: install Docker Engine', () => {
    expect(daemonHint('linux', down('spawn docker ENOENT'))).toContain('https://docs.docker.com/engine/install/');
  });

  it('Linux compose: v2 plugin missing, legacy v1 only, or too old', () => {
    const missing = composeHint('linux', { ...up, compose: false, composeVersion: null });
    expect(missing).toContain('sudo apt-get install docker-compose-plugin');
    expect(missing).toContain('sudo dnf install docker-compose-plugin');
    expect(composeHint('linux', { ...up, compose: false, composeVersion: null }, facts({ composeV1: 'docker-compose version 1.29.2, build unknown' })))
      .toMatch(/^Only the legacy Compose v1 is installed \(docker-compose version 1\.29\.2/);
    expect(composeHint('linux', { ...up, compose: false, composeVersion: '1.29.2' })).toMatch(/^Compose 1\.29\.2 is too old/);
  });

  it('init/start error: Linux names the exact fix, macOS text is unchanged', () => {
    expect(dockerUnavailable(down('connect: permission denied'), 'darwin').hint).toMatch(/^Start Docker Desktop \(or install Compose v2\), then rerun\. Running without Docker/);
    expect(dockerUnavailable(down('connect: permission denied'), 'linux').hint).toContain('sudo usermod -aG docker');
    expect(dockerUnavailable({ ...up, compose: false, composeVersion: null }, 'linux').hint).toContain('docker-compose-plugin');
  });
});

describe('linuxDockerChecks', () => {
  it('reports nothing it could not probe', () => {
    expect(linuxDockerChecks(unknownLinuxFacts(), '/r')).toEqual([]);
  });

  it('rootful Docker with host uid 1000: ok (secret files readable without chown)', () => {
    const c = linuxDockerChecks(facts({ securityOptions: SEC_ROOTFUL, uid: 1000 }), '/r');
    expect(c.map((x) => [x.name, x.status])).toEqual([['docker.rootless', 'ok'], ['docker.uid', 'ok']]);
  });

  it('rootful Docker with another host uid: warns that the 0600 secrets are unreadable and never suggests chown to 1000', () => {
    const uid = linuxDockerChecks(facts({ securityOptions: SEC_ROOTFUL, uid: 1001 }), '/r').find((x) => x.name === 'docker.uid')!;
    expect(uid.status).toBe('warn');
    expect(uid.detail).toContain('host uid 1001');
    expect(uid.hint).toContain('never chowns');
  });

  it('rootless Docker: warns about subordinate uid mapping; no uid check', () => {
    const c = linuxDockerChecks(facts({ securityOptions: ['name=seccomp,profile=builtin', 'name=rootless', 'name=cgroupns'], uid: 1000 }), '/r');
    expect(c.map((x) => [x.name, x.status])).toEqual([['docker.rootless', 'warn']]);
    expect(c[0]!.detail).toContain('subordinate host uid');
  });

  it('SELinux enforcing with Docker labeling: exact semanage/restorecon fix for the projects dir', () => {
    const c = linuxDockerChecks(facts({ securityOptions: ['name=seccomp,profile=builtin', 'name=selinux'], uid: 1000, selinux: 'enforcing' }), '/home/u/.local/share/minions');
    const se = c.find((x) => x.name === 'docker.selinux')!;
    expect(se.status).toBe('warn');
    expect(se.hint).toContain("sudo semanage fcontext -a -t container_file_t '/home/u/.local/share/minions/projects(/.*)?'");
    expect(se.hint).toContain("sudo restorecon -R '/home/u/.local/share/minions/projects'");
  });

  it('SELinux enforcing without Docker labeling, or permissive: no relabel needed', () => {
    expect(linuxDockerChecks(facts({ securityOptions: SEC_ROOTFUL, uid: 1000, selinux: 'enforcing' }), '/r').find((x) => x.name === 'docker.selinux')?.status).toBe('ok');
    expect(linuxDockerChecks(facts({ securityOptions: SEC_ROOTFUL, uid: 1000, selinux: 'permissive' }), '/r').find((x) => x.name === 'docker.selinux')).toBeUndefined();
  });
});

describe('linuxHostFacts (fake runner)', () => {
  type Call = { cmd: string; args: string[] };
  const fake = (h: (c: Call) => RunResult | undefined) => {
    const calls: Call[] = [];
    const runner = async (cmd: string, args: string[], _o?: RunOptions): Promise<RunResult> => {
      calls.push({ cmd, args });
      return h({ cmd, args }) ?? { code: 127, stdout: '', stderr: `spawn ${cmd} ENOENT` };
    };
    return { calls, runner };
  };

  it('parses SecurityOptions, getenforce, the rootless socket and a legacy docker-compose', async () => {
    const { runner } = fake(({ cmd, args }) => {
      if (cmd === 'docker' && args[0] === 'info') return { code: 0, stdout: '["name=seccomp,profile=builtin","name=selinux"]\n', stderr: '' };
      if (cmd === 'getenforce') return { code: 0, stdout: 'Enforcing\n', stderr: '' };
      if (cmd === 'docker-compose') return { code: 0, stdout: 'docker-compose version 1.29.2, build unknown\n', stderr: '' };
      return undefined;
    });
    const f = await linuxHostFacts(runner, { ...up, compose: false, composeVersion: null },
      { env: { XDG_RUNTIME_DIR: '/run/user/1000' }, uid: 1000, exists: async (p) => p === '/run/user/1000/docker.sock' });
    expect(f).toEqual({ uid: 1000, securityOptions: ['name=seccomp,profile=builtin', 'name=selinux'], selinux: 'enforcing', dockerHost: null,
      rootlessSocket: '/run/user/1000/docker.sock', composeV1: 'docker-compose version 1.29.2, build unknown' });
  });

  it('leaves facts unknown when tools are missing; skips docker info when the daemon is down', async () => {
    const { calls, runner } = fake(() => undefined);
    const f = await linuxHostFacts(runner, down('x'), { env: { DOCKER_HOST: 'unix:///run/user/1000/docker.sock' }, uid: 1001, exists: async () => false });
    expect(f).toEqual({ ...unknownLinuxFacts(), uid: 1001, dockerHost: 'unix:///run/user/1000/docker.sock' });
    expect(calls.some((c) => c.cmd === 'docker' && c.args[0] === 'info')).toBe(false);
  });
});

describe('doctor wiring', () => {
  let env: ReturnType<typeof withHome>;
  beforeEach(() => { env = withHome(); });
  afterEach(() => env.cleanup());
  const noop = async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: '' });
  const cwd = () => tempDir('minions-linux-doctor-');
  const permDenied = async (): Promise<DockerStatus> => down('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock');

  it('macOS: Docker Desktop hint, no Linux checks, no Linux probe', async () => {
    let probed = false;
    const r = await runDoctor({ cwd: cwd(), runner: noop, probe: permDenied, platform: 'darwin', linuxFacts: async () => { probed = true; return unknownLinuxFacts(); } });
    expect(r.checks.find((c) => c.name === 'docker.daemon')?.hint).toBe('Start Docker Desktop.');
    expect(probed).toBe(false);
    expect(r.checks.some((c) => c.name.startsWith('docker.') && !['docker.daemon', 'docker.compose'].includes(c.name))).toBe(false);
  });

  it('Linux: socket permission fix on the daemon check', async () => {
    const r = await runDoctor({ cwd: cwd(), runner: noop, probe: permDenied, platform: 'linux', linuxFacts: async () => unknownLinuxFacts() });
    const d = r.checks.find((c) => c.name === 'docker.daemon')!;
    expect(d.status).toBe('fail');
    expect(d.hint).toContain('sudo usermod -aG docker');
  });

  it('Linux: compose plugin fix, and rootless/uid/SELinux checks once the daemon is up', async () => {
    const r = await runDoctor({ cwd: cwd(), runner: noop, probe: async () => ({ ...up, compose: false, composeVersion: null }), platform: 'linux',
      linuxFacts: async () => facts({ securityOptions: ['name=selinux'], uid: 1001, selinux: 'enforcing' }) });
    expect(r.checks.find((c) => c.name === 'docker.compose')?.hint).toContain('docker-compose-plugin');
    expect(r.checks.filter((c) => ['docker.rootless', 'docker.uid', 'docker.selinux'].includes(c.name)).map((c) => [c.name, c.status]))
      .toEqual([['docker.rootless', 'ok'], ['docker.uid', 'warn'], ['docker.selinux', 'warn']]);
  });
});
