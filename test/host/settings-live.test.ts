// task-53.2: live settings take effect on the next runtime command without a coordinator restart. A change made
// on the host (`settings set`, or the config-write path) regenerates the runtime config.json; the next runtime
// command loads it (loadRuntimeConfig, as every `minions work ...` process does) and the scheduler enforces the
// new value. No restart is run or offered for live keys. Also covers the recreate class's reporting.
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

const { runInit } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const { editProjectConfig } = await import('../../src/host/config-write.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { loadRuntimeConfig } = await import('../../src/runtime/commands.js');
const { RuntimeDb } = await import('../../src/runtime/db.js');
const { Scheduler } = await import('../../src/runtime/scheduler.js');
const { workspaceLayout } = await import('../../src/runtime/worktree.js');
const { FakeBacklog, initRepo, tmp } = await import('../runtime/fixtures.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');
type ProjectJson = import('../../src/host/project.js').ProjectJson;
type MinionsError = import('../../src/core/errors.js').MinionsError;

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

/** A running runtime that records every exec: a live change must not cause a coordinator restart. */
function recordingRuntime() {
  const calls: string[][] = [];
  const runtime: import('../../src/host/settings-cli.js').SettingsRuntime = {
    running: async () => true,
    exec: async (_p, args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ ok: true, data: { action: 'restarted' } }) + '\n', stderr: '' }; },
  };
  return { runtime, calls };
}

const never = async (): Promise<boolean | null> => { throw new Error('unexpected confirmation'); };
const set = async (project: ProjectJson, runtime: import('../../src/host/settings-cli.js').SettingsRuntime, key: string, value: string, o: { yes?: boolean; restart?: boolean } = {}) =>
  SC.applySetting(await S.loadSettingsContext(project), key, value, o, { runtime, confirm: o.yes ? never : async () => null });

/** The runtime side: the workspace, state DB and backlog persist across commands; each command loads the config afresh. */
function runtimeSide(project: ProjectJson) {
  const root = tmp('minions-live-');
  const layout = workspaceLayout(join(root, 'workspace'));
  initRepo(layout.repo);
  const db = new RuntimeDb(join(root, 'state', 'minions.db'));
  const backlog = new FakeBacklog();
  const handoff = { briefs: join(root, 'state', 'briefs'), results: join(root, 'state', 'results') };
  /** One runtime command: reads the regenerated runtime config.json, as each `minions work ...` process does. */
  const command = async () => {
    const config = await loadRuntimeConfig(join(projectPaths(project.projectId).runtimeDir, 'config.json'));
    return new Scheduler({ db, backlog, config, layout, handoff });
  };
  return { backlog, command };
}

const rejection = async (p: Promise<unknown>): Promise<MinionsError> => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};

describe('live settings take effect on the next runtime command, without a restart', () => {
  it('execution.maxActiveTasks: lowered, the next claim is refused; raised, the next claim succeeds', async () => {
    const project = await install();
    const { runtime, calls } = recordingRuntime();
    const rt = runtimeSide(project);
    for (const id of ['task-1', 'task-2']) rt.backlog.add({ id });

    for (const [key, v] of [['execution.maxEngineers', '1'], ['execution.maxActiveTasks', '1']] as const) {
      const r = await set(project, runtime, key, v);
      expect(r).toMatchObject({ written: true, class: 'live', takesEffect: 'now', needsRestart: false, restart: null });
    }
    await (await rt.command()).claim('task-1');
    const next = await (await rt.command()).next();
    expect(next.waiting.find((w) => w.taskId === 'task-2')).toMatchObject({ waitingOn: 'capacity', why: 'active task limit (1/1)' });
    expect((await rejection((await rt.command()).claim('task-2'))).code).toBe('CAPACITY');

    for (const [key, v] of [['execution.maxActiveTasks', '3'], ['execution.maxEngineers', '3']] as const) {
      const r = await set(project, runtime, key, v, { yes: true });
      expect(r).toMatchObject({ written: true, takesEffect: 'now', needsRestart: false, restart: null });
    }
    const brief = await (await rt.command()).claim('task-2');
    expect(brief.task.id).toBe('task-2');
    expect((await (await rt.command()).capacity()).maxActiveTasks).toBe(3);
    expect(calls.filter((c) => c[1] === 'coordinator')).toEqual([]); // no restart was run
  });

  it('verification.commands: the next brief carries the new commands (config-write path)', async () => {
    const project = await install();
    const rt = runtimeSide(project);
    rt.backlog.add({ id: 'task-1' });
    rt.backlog.add({ id: 'task-2' });
    const first = await (await rt.command()).claim('task-1');
    expect(first.verificationCommands).not.toEqual(['npm run lint', 'npm test -- --run']);
    const edit = await editProjectConfig(project, (raw) => {
      (raw.verification as { commands: string[] }).commands = ['npm run lint', 'npm test -- --run'];
      return raw;
    });
    expect(edit.written).toBe(true);
    const second = await (await rt.command()).claim('task-2');
    expect(second.verificationCommands).toEqual(['npm run lint', 'npm test -- --run']);
  });

  it('models.*: the next brief uses the new default and allowed list at once; the agent definitions still need a restart', async () => {
    const project = await install();
    const { runtime } = recordingRuntime();
    const rt = runtimeSide(project);
    rt.backlog.add({ id: 'task-1' });
    rt.backlog.add({ id: 'task-2' });
    const first = await (await rt.command()).claim('task-1');
    expect([first.model, first.allowedModels]).not.toEqual(['haiku', ['sonnet', 'haiku']]);
    expect(first.model).not.toBe('haiku');
    const allowed = await set(project, runtime, 'models.allowed', 'sonnet, haiku', { restart: false });
    const dflt = await set(project, runtime, 'models.default', 'haiku', { restart: false });
    for (const r of [allowed, dflt]) {
      expect(r).toMatchObject({ written: true, class: 'restart', takesEffect: 'restart', needsRestart: true, restart: { action: 'offered' } });
    }
    const brief = await (await rt.command()).claim('task-2');
    expect(brief.allowedModels).toEqual(['sonnet', 'haiku']);
    expect(brief.model).toBe('haiku');
  });
});

describe('takes-effect reporting for every class', () => {
  it('maps classes to now / restart / upgrade and words each one', () => {
    expect([S.takesEffectOf('live'), S.takesEffectOf('restart'), S.takesEffectOf('recreate'), S.takesEffectOf('fixed')]).toEqual(['now', 'restart', 'upgrade', null]);
    expect([S.applyClass('live'), S.applyClass('prompt'), S.applyClass('launch'), S.applyClass('recreate')]).toEqual(['live', 'restart', 'restart', 'recreate']);
    expect(SC.effectText('now')).toMatch(/^takes effect now/);
    expect(SC.effectText('restart')).toMatch(/after a coordinator restart/);
    expect(SC.effectText('upgrade')).toMatch(/after `minions upgrade` \(the container is recreated, volumes kept\)/);
    expect(SC.effectText('upgrade', true)).toMatch(/^would take effect after `minions upgrade`/);
    expect(SC.effectText(null)).toBe('');
  });

  it('a recreate-class result prints the upgrade line and next step, and no coordinator restart', () => {
    const r: import('../../src/host/settings-cli.js').SetResult = {
      key: 'container.cpus', from: 4, to: 6, layer: 'local', file: '/x/config.local.json', changed: true, written: true, dryRun: false,
      loosens: null, needsRestart: false, needsUpgrade: true, class: 'recreate', hostOwned: false, takesEffect: 'upgrade',
      effect: SC.effectText('upgrade'), restart: null, warnings: [], nextSteps: [SC.UPGRADE_LATER],
    };
    const out = SC.formatSet(r);
    expect(out).toMatch(/takes effect after `minions upgrade`/);
    expect(out).toMatch(/next: Run `minions upgrade`/);
    expect(out).not.toMatch(/coordinator restart/);
  });
});
