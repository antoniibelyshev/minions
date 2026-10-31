// The two modes (docs/design/autonomy.md Decision 11): `minions mode set`, `minions defaults`, project.json written
// before the modes, and the owner's Telegram id pre-approved on a new bot. Temp MINIONS_HOME; no Docker.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));

const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson, loadEffectiveConfig, projectConfigPath } = await import('../../src/host/project.js');
const { runModeSet } = await import('../../src/host/mode-cli.js');
const { runDefaultsSet } = await import('../../src/host/defaults-cli.js');
const { loadDefaults } = await import('../../src/host/auth.js');
const { runInit } = await import('../../src/host/install.js');
const { seedOwnerAccess } = await import('../../src/telegram/channel/access-cli.js');
const { dockerUp, initFromTemplate, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('minions mode set', () => {
  it('--dry-run lists the mode-owned changes and writes nothing; applying rewrites them and keeps config.local.json', async () => {
    const { repo, projectId } = await initFromTemplate(env.root);
    const project = await loadProjectJson(projectId);
    const file = projectConfigPath(project);
    const local = projectPaths(projectId).configLocalJson;
    writeFileSync(local, JSON.stringify({ execution: { maxActiveTasks: 3 } }));
    const before = readFileSync(file, 'utf8');

    const dry = await runModeSet('supervised', { dryRun: true }, { cwd: repo });
    expect(dry).toMatchObject({ from: 'independent', to: 'supervised', dryRun: true, applied: false });
    expect(dry.changes.map((c) => c.key)).toEqual(expect.arrayContaining(['mode', 'delivery.merge', 'capabilities', 'sensitivePaths', 'coordinator.sessions', 'routine']));
    expect(dry.changes.find((c) => c.key === 'delivery.merge')).toEqual({ key: 'delivery.merge', from: 'auto-when-eligible', to: 'disabled' });
    expect(readFileSync(file, 'utf8')).toBe(before);

    const r = await runModeSet('supervised', {}, { cwd: repo });
    expect(r.applied).toBe(true);
    const raw = readJson(file);
    expect(raw).toMatchObject({ mode: 'supervised', delivery: { merge: 'disabled' }, architecture: 'propose', capabilities: { 'base.merge': 'deny' } });
    expect(raw).not.toHaveProperty('routine');
    expect(raw.coordinator?.sessions).toBeUndefined();
    expect(raw.configRevision).toBe(r.configRevision);
    expect((await loadProjectJson(projectId)).mode).toBe('supervised');
    expect(readJson(local)).toEqual({ execution: { maxActiveTasks: 3 } });
    const eff = (await loadEffectiveConfig(await loadProjectJson(projectId))).config;
    expect(eff.execution.maxActiveTasks).toBe(3); // the local override wins over the mode's 2
    expect(r.notes.join(' ')).toMatch(/runtime stays docker .*minions runtime set host/);

    expect((await runModeSet('supervised', {}, { cwd: repo })).changes).toEqual([]);
  });
});

describe('minions defaults', () => {
  it('sets and unsets git.name, git.email and telegram.owner; refuses bad values; auth reuses the auth methods', async () => {
    await runDefaultsSet('git.name', 'Minion Bot');
    await runDefaultsSet('git.email', 'bot@example.com');
    const v = await runDefaultsSet('telegram.owner', '123456789');
    expect(v).toMatchObject({ git: { name: 'Minion Bot', email: 'bot@example.com' }, telegram: { owner: '123456789' } });
    await expect(runDefaultsSet('telegram.owner', '@me')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(runDefaultsSet('mode', 'independent')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect((await runDefaultsSet('auth', 'login')).auth).toMatch(/^login/);
    await expect(runDefaultsSet('auth', 'api-key')).rejects.toMatchObject({ code: 'INVALID_CONFIG', hint: expect.stringMatching(/minions auth set <method> --global/) });
    await runDefaultsSet('git.email', undefined);
    expect(await loadDefaults()).toEqual({ claudeAuth: { method: 'login' }, git: { name: 'Minion Bot' }, telegram: { owner: '123456789' } });
  });

  it('init takes the git identity and the Telegram owner from the defaults', async () => {
    await runDefaultsSet('git.name', 'Minion Bot');
    await runDefaultsSet('git.email', 'bot@example.com');
    await runDefaultsSet('telegram.owner', '42');
    const repo = makeRepo(env.root);
    const r = await runInit({ mode: 'independent', path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const project = await loadProjectJson(r.plan.projectId);
    expect(project).toMatchObject({ gitIdentity: { name: 'Minion Bot', email: 'bot@example.com' }, telegramOwner: '42' });
    expect(readJson(join(projectPaths(project.projectId).runtimeDir, 'project.json')).telegramOwner).toBe('42');
  });
});

describe('project.json from before the modes', () => {
  it('reads profile as the mode it maps to', async () => {
    const { projectId } = await initFromTemplate(env.root);
    const file = projectPaths(projectId).projectJson;
    const { mode: _m, ...rest } = readJson(file);
    writeFileSync(file, JSON.stringify({ ...rest, profile: 'personal-work' }));
    expect((await loadProjectJson(projectId)).mode).toBe('supervised');
  });
});

describe('Telegram owner from the defaults', () => {
  it('allowlists the owner on a bot without access.json, and never touches an existing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'minions-owner-'));
    try {
      const info = join(dir, 'project.json');
      const state = join(dir, 'telegram');
      writeFileSync(info, JSON.stringify({ projectId: 'x' }));
      expect(await seedOwnerAccess(state, info)).toBe(false);
      writeFileSync(info, JSON.stringify({ telegramOwner: '42' }));
      expect(await seedOwnerAccess(state, info)).toBe(true);
      expect(readJson(join(state, 'access.json'))).toEqual({ dmPolicy: 'allowlist', allowFrom: ['42'], groups: {}, pending: {} });
      writeFileSync(join(state, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [] }));
      expect(await seedOwnerAccess(state, info)).toBe(false);
      expect(readJson(join(state, 'access.json'))).toEqual({ dmPolicy: 'pairing', allowFrom: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
