// Opt-in: MINIONS_DOCKER_TESTS=1 npx vitest run test/docker
// Builds the runtime image (tagged minions-test-runtime:*), starts one test project, and inspects it.
// All Docker resources are prefixed minions-test- and removed afterwards. No Claude/agent is run.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../src/core/exec.js';
import { projectPaths, shortId } from '../../src/core/paths.js';
import { Compose, ensureImage, packageRoot } from '../../src/host/docker.js';
import { runInit } from '../../src/host/install.js';
import { loadProjectJson } from '../../src/host/project.js';
import { importRepo } from '../../src/host/transfer.js';
import { git, makeRepo, withHome } from '../host/fixtures.js';

const TAG = 'minions-test-runtime:latest';
const SECRET = 'sk-ant-api03-minionsTESTsecretVALUE0123456789';

/** Same project, but every Docker resource name is prefixed minions-test-. */
class TestCompose extends Compose {
  override get name() { return `minions-test-${shortId(this.projectId)}`; }
}

let env: ReturnType<typeof withHome>;
let compose: TestCompose;
let repo: string;
let projectId: string;
let containerId: string;
let inspect: any;

const docker = (...args: string[]) => run('docker', args, { timeoutMs: 120_000 });
const sh = (cmd: string[]) => compose.exec(cmd, { allowFailure: true, timeoutMs: 60_000 });

beforeAll(async () => {
  env = withHome();
  repo = makeRepo(env.root);
  writeFileSync(join(repo, '.env'), `ANTHROPIC_API_KEY=${SECRET}\n`); // ignored by .gitignore
  const r = await runInit({ path: repo, yes: true, visibility: 'private' });
  projectId = r.plan.projectId;
  const paths = projectPaths(projectId);
  // Retarget image + resource names to test-prefixed ones.
  const pj = JSON.parse(readFileSync(paths.projectJson, 'utf8'));
  pj.imageTag = TAG;
  pj.container.publishPorts = [{ host: 39123, container: 3000 }];
  writeFileSync(paths.projectJson, JSON.stringify(pj, null, 2));
  const { composeYaml } = await import('../../src/host/docker.js');
  const base = `minions-${shortId(projectId)}`;
  writeFileSync(paths.composeYaml, composeYaml(await loadProjectJson(projectId)).replaceAll(`"${base}`, `"minions-test-${shortId(projectId)}`));
  compose = new TestCompose(projectId);
  await ensureImage(TAG, { root: packageRoot(), onBuild: (m) => process.stderr.write(m + '\n') });
  await compose.up();
  containerId = (await compose.compose(['ps', '-q', 'app'])).stdout.trim();
  inspect = JSON.parse((await docker('inspect', containerId)).stdout)[0];
}, 1_800_000);

afterAll(async () => {
  if (compose) await compose.down({ volumes: true }).catch(() => {});
  await docker('image', 'rm', '-f', TAG).catch(() => {});
  env?.cleanup();
}, 300_000);

describe('runtime container (docker)', () => {
  it('runs as non-root with the security baseline', async () => {
    const hc = inspect.HostConfig;
    expect(inspect.Config.User).toBe('1000:1000');
    expect((await sh(['id', '-u'])).stdout.trim()).toBe('1000');
    expect(hc.Privileged).toBe(false);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.CapAdd ?? []).toEqual([]);
    expect(hc.SecurityOpt).toContain('no-new-privileges:true');
    expect(hc.NetworkMode).not.toBe('host');
    expect(hc.PidMode ?? '').toBe('');
    expect(hc.IpcMode).not.toBe('host');
    expect(hc.Devices ?? []).toEqual([]);
    expect(hc.NanoCpus).toBe(4e9);
    expect(hc.Memory).toBe(6144 * 1024 * 1024);
    expect(hc.PidsLimit).toBe(512);
    expect(hc.Init).toBe(true);
    expect(inspect.Config.Env).toEqual(expect.arrayContaining(['MINIONS_RUNTIME=container', 'CLAUDE_CONFIG_DIR=/home/node/.claude']));
  });

  it('mounts no docker socket and only ro binds for plugin/config/secrets', () => {
    const mounts = inspect.Mounts as { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[];
    expect(mounts.some((m) => /docker\.sock/.test(m.Source) || /docker\.sock/.test(m.Destination))).toBe(false);
    const binds = mounts.filter((m) => m.Type === 'bind');
    expect(binds.map((m) => [m.Destination, m.RW]).sort()).toEqual([['/opt/minions/config', false], ['/opt/minions/plugin', false], ['/opt/minions/secrets', false]]);
    const vols = mounts.filter((m) => m.Type === 'volume').map((m) => m.Name).sort();
    expect(vols.every((n) => n!.startsWith('minions-test-'))).toBe(true);
    expect(vols).toHaveLength(4);
  });

  it('publishes requested ports on loopback only', () => {
    const b = inspect.HostConfig.PortBindings['3000/tcp'];
    expect(b).toEqual([{ HostIp: '127.0.0.1', HostPort: '39123' }]);
  });

  it('root filesystem is read-only; tmp, home, and volumes are writable', async () => {
    expect((await sh(['touch', '/usr/local/x'])).code).not.toBe(0);
    for (const p of ['/tmp/x', '/home/node/x', '/workspace/x', '/state/x', '/home/node/.claude/x', '/home/node/.cache/x']) {
      expect((await sh(['touch', p])).code, p).toBe(0);
    }
    expect((await sh(['touch', '/opt/minions/config/x'])).code).not.toBe(0);
  });

  it('pinned tools are present', async () => {
    expect((await sh(['claude', '--version'])).stdout).toContain('2.1.292');
    expect((await sh(['backlog', '--version'])).stdout).toContain('1.54.0');
    expect((await sh(['bun', '--version'])).stdout.trim()).toBe('1.4.3'); // Telegram channel plugin runtime
    expect(JSON.stringify(inspect.Config.Env)).not.toContain('TELEGRAM_BOT_TOKEN'); // token reaches only the coordinator process
    for (const t of ['git', 'tmux', 'rg', 'minions']) expect((await sh(['sh', '-c', `command -v ${t}`])).code, t).toBe(0);
  });

  it('host home and host files are not visible', async () => {
    expect((await sh(['ls', '/Users'])).code).not.toBe(0);
    expect((await sh(['test', '-e', repo])).code).not.toBe(0);
    const envOut = (await sh(['env'])).stdout;
    expect(envOut).not.toContain(SECRET);
    expect(envOut).not.toContain(process.env.HOME ?? '/Users/');
  });

  it('imports committed history only: ignored .env is absent', async () => {
    await compose.exec(['minions', 'workspace', 'setup', '--json'], { timeoutMs: 120_000 });
    const project = await loadProjectJson(projectId);
    const r = await importRepo(project, { compose, repoPath: repo });
    expect(r.commit).toBe(git(repo, 'rev-parse', 'main'));
    expect((await sh(['git', '-C', '/workspace/repo', 'rev-parse', 'HEAD'])).stdout.trim()).toBe(r.commit);
    expect((await sh(['test', '-e', '/workspace/repo/.env'])).code).not.toBe(0);
    expect((await sh(['grep', '-rqs', SECRET, '/workspace', '/state'])).code).not.toBe(0);
  }, 300_000);

  it('repository clone and state survive container recreation', async () => {
    await sh(['sh', '-c', 'echo keep > /state/marker && echo keep > /home/node/.claude/marker']);
    const before = (await compose.compose(['ps', '-q', 'app'])).stdout.trim();
    await compose.down();
    expect(await compose.isRunning()).toBe(false);
    await compose.up();
    const after = (await compose.compose(['ps', '-q', 'app'])).stdout.trim();
    expect(after).not.toBe(before);
    expect((await sh(['cat', '/state/marker'])).stdout.trim()).toBe('keep');
    expect((await sh(['cat', '/home/node/.claude/marker'])).stdout.trim()).toBe('keep');
    expect((await sh(['git', '-C', '/workspace/repo', 'rev-parse', 'HEAD'])).code).toBe(0);
    expect((await sh(['test', '-e', '/tmp/x'])).code).not.toBe(0); // tmpfs is ephemeral
  }, 300_000);
});
