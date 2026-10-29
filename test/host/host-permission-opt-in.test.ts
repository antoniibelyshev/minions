// Task-8, host side: `minions settings set coordinator.permissionMode` on a host-runtime project. Only the
// host-only config.local.json value reaches runtime/host-permission.json, which the host-runtime coordinator
// honours; the same value in the repository's .minions/config.json is ignored (default). Raising the host mode
// asks for a confirmation. Temp MINIONS_HOME, file credential store, fake runtime; no Docker, no claude.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { runInit, refreshDerived } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson, loadEffectiveConfig, projectConfigPath } = await import('../../src/host/project.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { decidePermissionMode } = await import('../../src/runtime/coordinator.js');
const { HOST_PERMISSION_FILE } = await import('../../src/runtime/host-permission.js');
const { dockerDown, makeRepo, withHome } = await import('./fixtures.js');

const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];

let env: ReturnType<typeof withHome>;
const saved = { ...process.env };
beforeEach(() => { env = withHome(); process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  env.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

async function hostInstall(runtime: 'host' | 'container' = 'host') {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility: 'shared', ...(runtime === 'host' ? { runtime: 'host' as const } : {}), dockerProbe: dockerDown });
  const project = await loadProjectJson(r.plan.projectId);
  const pp = projectPaths(project.projectId);
  // The runtime's view: MINIONS_CONFIG pins <project>/runtime/config.json; the record sits next to it.
  Object.assign(process.env, {
    MINIONS_RUNTIME: 'host', MINIONS_CONFIG: join(pp.runtimeDir, 'config.json'),
    MINIONS_WORKSPACE: join(env.root, 'agent-ws'), MINIONS_STATE_DIR: join(env.root, 'agent-state'),
  });
  return { repo, project, shared: projectConfigPath(project), local: pp.configLocalJson, record: join(pp.runtimeDir, HOST_PERMISSION_FILE), runtimeCfg: join(pp.runtimeDir, 'config.json') };
}

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
/** The host-runtime coordinator's decision from the generated runtime files (record + runtime config). */
const decision = (runtimeCfg: string) => decidePermissionMode(readJson(runtimeCfg), { hostRuntime: true, modes: MODES });
const notRunning: import('../../src/host/settings-cli.js').SettingsRuntime = { running: async () => false, exec: async () => ({ code: 1, stdout: '', stderr: 'not running' }) };
const ctxOf = (project: Awaited<ReturnType<typeof hostInstall>>['project']) => S.loadSettingsContext(project);

describe('host runtime opt-in through config.local.json', () => {
  it('a repo-only value is ignored (default); a local value is honoured after a confirmed loosening', async () => {
    const { project, shared, local, record, runtimeCfg } = await hostInstall();
    expect(readJson(record)).toMatchObject({ version: 1, coordinatorPermissionMode: null, source: local });
    expect(decision(runtimeCfg)).toMatchObject({ mode: 'manual', source: 'host-default' });

    // The repository's .minions/config.json says auto (e.g. a teammate's commit): the record stays null.
    const repoCfg = readJson(shared);
    writeFileSync(shared, JSON.stringify({ ...repoCfg, coordinator: { ...repoCfg.coordinator, permissionMode: 'auto' } }, null, 2));
    const eff = await loadEffectiveConfig(project);
    expect(eff.config.coordinator?.permissionMode).toBe('auto');
    await refreshDerived(project, eff.config);
    expect(readJson(runtimeCfg).coordinator.permissionMode).toBe('auto');
    expect(readJson(record).coordinatorPermissionMode).toBeNull();
    const d = decision(runtimeCfg);
    expect(d).toMatchObject({ configured: 'default', mode: 'manual', source: 'host-default' });
    expect(d.reason).toMatch(/ignored on the host runtime/);

    // The owner sets the same value on the host: the merged value does not change, the host mode does.
    const questions: string[] = [];
    const r = await SC.applySetting(await ctxOf(project), 'coordinator.permissionMode', 'auto', {}, { runtime: notRunning, confirm: async (q) => { questions.push(q); return true; } });
    expect(r).toMatchObject({ layer: 'local', file: local, changed: true, written: true, from: undefined, to: 'auto' });
    expect(r.loosens).toMatch(/host-runtime coordinator runs in permission mode auto instead of default/);
    expect(questions[0]).toMatch(/loosens policy: the host-runtime coordinator runs in permission mode auto/);
    expect(readJson(local)).toMatchObject({ coordinator: { permissionMode: 'auto' } });
    expect(readJson(record)).toEqual({ version: 1, coordinatorPermissionMode: 'auto', source: local });
    expect(decision(runtimeCfg)).toMatchObject({ configured: 'auto', mode: 'auto', fallback: false, source: 'host-local', sourceFile: local });
    // acceptEdits fallback where the installed Claude Code lacks auto.
    expect(decidePermissionMode(readJson(runtimeCfg), { hostRuntime: true, modes: ['acceptEdits', 'manual', 'plan'] }))
      .toMatchObject({ mode: 'acceptEdits', fallback: true, source: 'host-local' });
  });

  it('a declined or unanswerable confirmation leaves the host in default', async () => {
    const { project, record, runtimeCfg } = await hostInstall();
    await expect(SC.applySetting(await ctxOf(project), 'coordinator.permissionMode', 'auto', {}, { runtime: notRunning, confirm: async () => null }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(SC.applySetting(await ctxOf(project), 'coordinator.permissionMode', 'acceptEdits', {}, { runtime: notRunning, confirm: async () => false }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(readJson(record).coordinatorPermissionMode).toBeNull();
    expect(decision(runtimeCfg).source).toBe('host-default');
  });

  it('acceptEdits -> auto loosens again; a shared write warns that the host ignores it; bypass/dontAsk are rejected', async () => {
    const { project, record, runtimeCfg } = await hostInstall();
    const yes = { runtime: notRunning, confirm: async () => true };
    const a = await SC.applySetting(await ctxOf(project), 'coordinator.permissionMode', 'acceptEdits', {}, yes);
    expect(a.loosens).toMatch(/permission mode acceptEdits instead of default/);
    expect(decision(runtimeCfg)).toMatchObject({ mode: 'acceptEdits', source: 'host-local' });
    const b = await SC.applySetting(await ctxOf(project), 'coordinator.permissionMode', 'auto', {}, yes);
    expect(b.loosens).toMatch(/permission mode auto instead of acceptEdits/);
    expect(readJson(record).coordinatorPermissionMode).toBe('auto');

    // A shared write does not move the host mode (the local value still wins) and says so.
    const plan = await S.planSetting(await ctxOf(project), 'coordinator.permissionMode', 'acceptEdits', 'shared');
    expect(plan.warnings.join('\n')).toMatch(/ignored by the host runtime \(it stays auto\)/);
    expect(plan.loosens).toBeNull();

    for (const bad of ['bypassPermissions', 'dontAsk']) {
      await expect(SC.applySetting(await ctxOf(project), 'coordinator.permissionMode', bad, { yes: true }, yes)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(readJson(record).coordinatorPermissionMode).toBe('auto');

    // "default" unsets the local value: a tightening (no confirmation), back to the host runtime default.
    const back = await SC.applySetting(await ctxOf(project), 'coordinator.permissionMode', 'default', {}, { runtime: notRunning, confirm: async () => { throw new Error('unexpected confirmation'); } });
    expect(back).toMatchObject({ changed: true, written: true, loosens: null });
    expect(readJson(record).coordinatorPermissionMode).toBeNull();
    expect(decision(runtimeCfg).source).toBe('host-default');
  });

  it('hostPermissionChange applies only to coordinator.permissionMode on host-runtime projects', () => {
    expect(S.hostPermissionChange({ runtime: 'container' } as never, 'coordinator.permissionMode', {}, { coordinator: { permissionMode: 'auto' } }, 'local')).toBeNull();
    expect(S.hostPermissionChange({ runtime: 'host' } as never, 'execution.maxActiveTasks', {}, {}, 'local')).toBeNull();
    expect(S.hostPermissionChange({ runtime: 'host' } as never, 'coordinator.permissionMode', { coordinator: { permissionMode: 'auto' } }, {}, 'local'))
      .toMatchObject({ was: 'auto', will: 'default', loosens: null });
  });
});
