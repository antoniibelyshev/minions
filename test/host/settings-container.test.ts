// task-53.9: container resource limits (container.cpus, memoryMiB, pidsLimit, tmpSizeMiB) are `recreate` settings.
// compose.yaml is generated from project.json, so `minions upgrade` (its files step, refreshForUpgrade) copies the
// config's limits into project.json before regenerating compose, and the recreate that follows uses them.
// `settings set` alone only records the value (the running container keeps its limits until the upgrade).
import { readFileSync } from 'node:fs';
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

const { runInit, refreshForUpgrade, syncContainerLimits } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { loadEffectiveConfig, loadProjectJson } = await import('../../src/host/project.js');
const { Compose } = await import('../../src/host/docker.js');
const { runUpgrade } = await import('../../src/host/upgrade.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { makeRepo, tempDir, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type RunResult = import('../../src/core/exec.js').RunResult;

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

async function install(): Promise<ProjectJson> {
  const r = await runInit({ path: makeRepo(env.root), yes: true, visibility: 'private', dockerProbe: dockerUp });
  return loadProjectJson(r.plan.projectId);
}

const idleRuntime: import('../../src/host/settings-cli.js').SettingsRuntime = {
  running: async () => false,
  exec: async () => { throw new Error('a recreate setting must not exec in the runtime'); },
};
const never = async (): Promise<boolean | null> => { throw new Error('unexpected confirmation'); };
const set = async (project: ProjectJson, key: string, value: string) =>
  SC.applySetting(await S.loadSettingsContext(project), key, value, { yes: true }, { runtime: idleRuntime, confirm: never });

const composeText = (p: ProjectJson) => readFileSync(projectPaths(p.projectId).composeYaml, 'utf8');
const limits = (yaml: string) => ({
  cpus: /^ {4}cpus: (.+)$/m.exec(yaml)?.[1], mem: /^ {4}mem_limit: (.+)$/m.exec(yaml)?.[1],
  pids: /^ {4}pids_limit: (.+)$/m.exec(yaml)?.[1], tmp: /\/tmp:rw,[^"]*size=(\d+)m/.exec(yaml)?.[1],
});

/**
 * A fake Docker behind the real Compose for an upgrade with the container down: records the compose.yaml the
 * `up --force-recreate` was given (the file the new container gets its limits from).
 */
function fakeDocker() {
  const recreated: string[] = [];
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const runner = async (_cmd: string, args: string[]): Promise<RunResult> => {
    if (args[0] === 'image' && args[1] === 'inspect') return ok('label\n'); // root has no dist: no rebuild
    const sub = args.slice(5); // after: compose -p <name> -f <file>
    if (sub[0] === 'ps') return ok('');
    if (sub[0] === 'up') { recreated.push(readFileSync(args[4]!, 'utf8')); return ok(); }
    if (sub[0] === 'exec') return ok(JSON.stringify({ ok: true, data: { action: 'started', running: true } }) + '\n');
    return { code: 1, stdout: '', stderr: `unexpected docker ${args.join(' ')}` };
  };
  return { runner, recreated };
}

describe('container limits are recreate settings', () => {
  it('container.* items are class recreate (not host-owned), and network / ports are not offered', () => {
    for (const k of ['container.cpus', 'container.memoryMiB', 'container.pidsLimit', 'container.tmpSizeMiB']) {
      expect(S.requireSetting(k), k).toMatchObject({ group: 'Container', apply: 'recreate', class: 'recreate', hostOwned: false });
    }
    for (const k of ['container.network', 'container.publishPorts', 'container.mountDockerSocket']) expect(S.settingDef(k), k).toBeUndefined();
  });

  it('container.cpus takes fractions; the int limits keep their schema minimums', () => {
    expect(S.parseSettingValue(S.requireSetting('container.cpus'), '1.5')).toBe(1.5);
    for (const bad of ['0', '-1', 'two', '1.2.3']) expect(() => S.parseSettingValue(S.requireSetting('container.cpus'), bad), bad).toThrow();
    expect(() => S.parseSettingValue(S.requireSetting('container.memoryMiB'), '256')).toThrow(/at least 512/);
    expect(() => S.parseSettingValue(S.requireSetting('container.pidsLimit'), '10')).toThrow(/at least 64/);
    expect(S.parseSettingValue(S.requireSetting('container.tmpSizeMiB'), 'default')).toBeUndefined();
  });
});

describe('settings set container.<key> followed by minions upgrade applies the new limit', () => {
  it('set reports the upgrade; the upgrade copies the limits into project.json and recreates with them', async () => {
    const project = await install();
    const before = limits(composeText(project));
    expect(before).toMatchObject({ cpus: String(project.container.cpus), pids: String(project.container.pidsLimit) });

    const r = await set(project, 'container.cpus', '3.5');
    expect(r).toMatchObject({ written: true, class: 'recreate', takesEffect: 'upgrade', needsUpgrade: true, needsRestart: false, restart: null });
    expect(r.nextSteps).toContain(SC.UPGRADE_LATER);
    await set(project, 'container.memoryMiB', '6144');
    await set(project, 'container.pidsLimit', '2048');
    await set(project, 'container.tmpSizeMiB', '512');
    // Not yet applied: project.json and compose keep the old limits until the upgrade.
    expect((await loadProjectJson(project.projectId)).container).toEqual(project.container);
    expect(limits(composeText(project))).toEqual(before);

    const docker = fakeDocker();
    const up = await runUpgrade({
      projectId: project.projectId, imageTag: project.imageTag, compose: new Compose(project.projectId, docker.runner), runner: docker.runner,
      root: tempDir('minions-pkg-'), timeoutSec: 0,
      refresh: () => refreshForUpgrade(project),
      importRepo: async () => ({ bundle: 'b', commit: 'c', baseBranch: 'main', warnings: [], container: { origin: null } }) as never,
      materialize: async () => undefined,
      interrupt: { subscribe: () => () => undefined, exit: () => undefined, notice: () => undefined },
    });
    expect(up.steps.find((s) => s.id === 'recreate')?.status).toBe('done');
    expect(docker.recreated).toHaveLength(1);
    expect(limits(docker.recreated[0]!)).toEqual({ cpus: '3.5', mem: '"6144m"', pids: '2048', tmp: '512' });
    const after = await loadProjectJson(project.projectId);
    expect(after.container).toEqual({ ...project.container, cpus: 3.5, memoryMiB: 6144, pidsLimit: 2048, tmpSizeMiB: 512 });
  });

  it('only the limits are copied: network and published ports stay as setup wrote them; an unset tmpSizeMiB drops the override', async () => {
    const project = await install();
    const withTmp = { ...project, container: { ...project.container, tmpSizeMiB: 2048, network: 'none' as const, publishPorts: [{ host: 9000, container: 9000 }] } };
    const cfg = (await loadEffectiveConfig(project)).config;
    expect(cfg.container.tmpSizeMiB).toBeUndefined();
    const next = await syncContainerLimits(withTmp, cfg);
    expect(next.container).toEqual({ ...project.container, network: 'none', publishPorts: [{ host: 9000, container: 9000 }] });
    expect('tmpSizeMiB' in next.container).toBe(false);
    expect((await loadProjectJson(project.projectId)).container).toEqual(next.container);
  });

  it('unchanged limits leave project.json alone', async () => {
    const project = await install();
    const file = projectPaths(project.projectId).projectJson;
    const bytes = readFileSync(file, 'utf8');
    const next = await syncContainerLimits(project, (await loadEffectiveConfig(project)).config);
    expect(next).toBe(project);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });
});

describe('edges (QA)', () => {
  it('refreshDerived (the path of start and every other command) does not sync limits: project.json and compose keep the old values', async () => {
    const { refreshDerived } = await import('../../src/host/install.js');
    const project = await install();
    const file = projectPaths(project.projectId).projectJson;
    const bytes = readFileSync(file, 'utf8');
    const before = limits(composeText(project));
    await set(project, 'container.cpus', '3.5');
    await refreshDerived(project, (await loadEffectiveConfig(project)).config);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(limits(composeText(project))).toEqual(before);
  });

  it('a fractional cpus value is synced into project.json', async () => {
    const project = await install();
    const cfg = (await loadEffectiveConfig(project)).config;
    const next = await syncContainerLimits(project, { ...cfg, container: { ...cfg.container, cpus: 0.5 } });
    expect(next.container.cpus).toBe(0.5);
    expect((await loadProjectJson(project.projectId)).container.cpus).toBe(0.5);
  });
});
