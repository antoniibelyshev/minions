// task-14.7 (agent-runtimes D8): the Agents settings items. `harnesses.default`, one `roles.<r>.harness` item per
// worker role (built-ins and the configured project roles) and the Codex key item (provisioned / missing only).
// The phase rule (D9, phase 1 b: a process harness only for project gate roles) is the config validation's,
// so refused values fail before anything is written. Temp MINIONS_HOME, file credential store; no Docker.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
const { loadEffectiveConfig, loadProjectJson, projectConfigPath } = await import('../../src/host/project.js');
const { workerRole } = await import('../../src/config/roles.js');
const C = await import('../../src/host/credentials.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');

const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const CODEX = { models: { default: 'gpt-test', allowed: ['gpt-test'] } };
const PILOT = { description: 'Second review.', promptText: 'Review.', contract: 'gate' };

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

/** A private install whose project config gets `extra` merged in (roles, harnesses blocks). */
async function install(extra: Record<string, unknown> = {}, name?: string) {
  const repo = makeRepo(env.root, name);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  const file = projectConfigPath(project);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...extra }, null, 2));
  return { repo, project, local: projectPaths(project.projectId).configLocalJson };
}

const deps = { runtime: { running: async () => false, exec: async () => ({ code: 1, stdout: '', stderr: '' }) }, confirm: async () => null };
const view = (views: { key: string }[], key: string) => views.find((v) => v.key === key) as Record<string, unknown> | undefined;

describe('Agents settings items', () => {
  it('lists harnesses.default, the Codex key and one harness item per worker role (built-ins and project roles)', async () => {
    const { project } = await install({ harnesses: { codex: CODEX }, roles: { 'codex-reviewer': PILOT } });
    const views = S.listSettings(await S.loadSettingsContext(project));
    const agents = views.filter((v) => v.group === 'Agents').map((v) => v.key);
    expect(agents).toEqual(['harnesses.default', 'secrets.codex', 'roles.engineer.harness', 'roles.tester.harness', 'roles.reviewer.harness', 'roles.codex-reviewer.harness']);
    expect(view(views, 'harnesses.default')).toMatchObject({ value: undefined, class: 'restart', hostOwned: true, needsRestart: true, canLoosen: true, choices: ['claude', 'codex', 'junie'] });
    expect(view(views, 'secrets.codex')).toMatchObject({ value: 'missing', source: 'credential store', hostOwned: true });
    expect(view(views, 'roles.codex-reviewer.harness')).toMatchObject({ value: undefined, class: 'restart', hostOwned: true });
    expect(SC.formatList(views)).toMatch(/Agents:\n {2}harnesses\.default = default/);

    await C.provisionCodexKey({ projectId: project.projectId, token: OPENAI_KEY, repoPath: project.repoPath });
    const after = S.listSettings(await S.loadSettingsContext(project));
    expect(view(after, 'secrets.codex')!.value).toBe('provisioned');
    expect(JSON.stringify(after)).not.toContain(OPENAI_KEY);
  });

  it('settings set harnesses.default codex moves the project gate onto Codex (loosening, needs confirmation); built-ins stay on Claude', async () => {
    const { project, local } = await install({ harnesses: { codex: CODEX }, roles: { 'codex-reviewer': PILOT } });
    const ctx = await S.loadSettingsContext(project);
    const plan = await S.planSetting(ctx, 'harnesses.default', 'codex');
    expect(plan).toMatchObject({ changed: true, needsRestart: true, class: 'restart', hostOwned: true });
    expect(plan.loosens).toMatch(/OpenAI Codex CLI/);
    expect(workerRole(plan.effective, 'codex-reviewer')!.harness).toBe('codex');
    expect(workerRole(plan.effective, 'engineer')!.harness).toBe('claude');
    // A loosening change without a terminal and without --yes is refused; nothing written.
    await expect(SC.applySetting(ctx, 'harnesses.default', 'codex', { restart: false }, deps)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(existsSync(local) ? JSON.parse(readFileSync(local, 'utf8')).harnesses : undefined).toBeUndefined();
    const r = await SC.applySetting(ctx, 'harnesses.default', 'codex', { yes: true, restart: false }, deps);
    expect(r).toMatchObject({ written: true, takesEffect: 'restart' });
    expect(JSON.parse(readFileSync(local, 'utf8')).harnesses).toEqual({ default: 'codex' });
    expect(workerRole((await loadEffectiveConfig(project)).config, 'codex-reviewer')!.harness).toBe('codex');
    // `default` unsets it again (back to claude), which does not loosen anything.
    const back = await S.planSetting(await S.loadSettingsContext(project), 'harnesses.default', S.parseSettingValue(S.requireSetting('harnesses.default'), 'default'));
    expect(back).toMatchObject({ changed: true, loosens: null });
  });

  it('refuses a process harness without its harnesses.<id> block, and for a built-in role in this phase', async () => {
    const { project } = await install({ roles: { 'codex-reviewer': PILOT } });
    const ctx = await S.loadSettingsContext(project);
    await expect(S.planSetting(ctx, 'harnesses.default', 'codex')).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/no harnesses\.codex block/) });
    const { project: p2 } = await install({ harnesses: { codex: CODEX } }, 'second');
    await expect(S.planSetting(await S.loadSettingsContext(p2), 'roles.engineer.harness', 'codex'))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/built-in producer role engineer must stay on claude/) });
  });

  it('roles.<r>.harness: sets a project role; unknown roles and the coordinator are refused', async () => {
    const { project, local } = await install({ harnesses: { codex: CODEX }, roles: { 'codex-reviewer': PILOT } });
    const ctx = await S.loadSettingsContext(project);
    const r = await SC.applySetting(ctx, 'roles.codex-reviewer.harness', 'codex', { yes: true, restart: false }, deps);
    expect(r).toMatchObject({ written: true, from: undefined, to: 'codex', loosens: expect.stringMatching(/codex-reviewer stages run on OpenAI Codex CLI/) });
    expect(JSON.parse(readFileSync(local, 'utf8')).roles).toEqual({ 'codex-reviewer': { harness: 'codex' } });
    // The local layer only overrides the harness: the role keeps its project definition.
    expect(workerRole((await loadEffectiveConfig(project)).config, 'codex-reviewer')).toMatchObject({ harness: 'codex', contract: 'gate', promptText: 'Review.' });
    await expect(S.planSetting(ctx, 'roles.nobody.harness', 'codex')).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/no worker role "nobody"/) });
    expect(() => S.requireSetting('roles.coordinator.harness')).toThrow(/Unknown setting/);
    expect(() => S.requireSetting('roles.Bad_Name.harness')).toThrow(/Unknown setting/);
    expect(() => S.parseSettingValue(S.requireSetting('roles.codex-reviewer.harness'), 'gemini')).toThrow(/not one of the choices/);
  });
});
