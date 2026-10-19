// `minions channel show|set` and the `minions auth telegram` follow-up: writes to the effective project
// config file with a configRevision bump, never overwrites a file that fails to parse, next steps
// (token / commit / restart / host runtime). Temp MINIONS_HOME, file credential store; no Docker.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const { runInit, loadManifest } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson, loadEffectiveConfig, projectConfigPath } = await import('../../src/host/project.js');
const CH = await import('../../src/host/channel-cli.js');
const C = await import('../../src/host/credentials.js');
const { sha256 } = await import('../../src/core/fsutil.js');
const { runtimeChannelStatus } = await import('../../src/runtime/commands.js');
const { runtimePaths } = await import('../../src/runtime/paths.js');
const { dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');

const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const notRunning = async () => false;
const running = async () => true;

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

async function install(visibility: 'shared' | 'private') {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  return { repo, project, file: projectConfigPath(project) };
}
const readCfg = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { configRevision: number; communication: { channel: string } };

describe('minions channel set', () => {
  it('private install: writes the private config with a revision bump, refreshes the runtime config, no commit hint', async () => {
    const { repo, project, file } = await install('private');
    expect(file).toBe(projectPaths(project.projectId).configJson);
    const before = readCfg(file);
    expect(before.communication.channel).toBe('auto');
    const r = await CH.setChannel(project, 'terminal', { yes: true }, { isRunning: notRunning });
    expect(r).toMatchObject({ from: 'auto', to: 'terminal', changed: true, applied: true, configRevision: before.configRevision + 1, path: file });
    const after = readCfg(file);
    expect(after).toMatchObject({ configRevision: before.configRevision + 1, communication: { channel: 'terminal', progress: 'milestones' } });
    expect((await loadEffectiveConfig(project)).config.communication.channel).toBe('terminal');
    const runtimeCfg = JSON.parse(readFileSync(join(projectPaths(project.projectId).runtimeDir, 'config.json'), 'utf8'));
    expect(runtimeCfg).toMatchObject({ configRevision: before.configRevision + 1, communication: { channel: 'terminal' } });
    expect(r.nextSteps.join('\n')).not.toMatch(/Commit|minions auth telegram|minions down/);
    expect(r.nextSteps).toContain('Applies on the next `minions start`.');
    // Generated file stays tracked by the manifest (hash updated).
    const entry = (await loadManifest(project.projectId))!.files.find((f) => f.path === file)!;
    expect(entry.sha256).toBe(sha256(readFileSync(file)));
    // Same value again: unchanged, no bump.
    const again = await CH.setChannel(project, 'terminal', { yes: true }, { isRunning: notRunning });
    expect(again).toMatchObject({ changed: false, applied: false, configRevision: before.configRevision + 1 });
    expect(readCfg(file).configRevision).toBe(before.configRevision + 1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('shared install: edits .minions/config.json, never commits; token, commit and restart next steps', async () => {
    const { repo, project, file } = await install('shared');
    expect(file).toBe(join(repo, '.minions', 'config.json'));
    git(repo, 'add', '.minions'); git(repo, 'commit', '-q', '-m', 'minions');
    const commits = git(repo, 'rev-list', '--count', 'HEAD');
    const rev = readCfg(file).configRevision;
    const r = await CH.setChannel(project, 'telegram', { yes: true }, { isRunning: running });
    expect(r).toMatchObject({ from: 'auto', to: 'telegram', applied: true, configRevision: rev + 1 });
    expect(readCfg(file)).toMatchObject({ configRevision: rev + 1, communication: { channel: 'telegram' } });
    const steps = r.nextSteps.join('\n');
    expect(steps).toMatch(/No Telegram bot token is stored.*BotFather.*`minions auth telegram`/);
    expect(steps).toMatch(/Commit \.minions\/config\.json.*minions does not commit/);
    expect(steps).toContain('`minions down && minions start`');
    expect(r.effective).toMatchObject({ configured: 'telegram', effective: 'terminal', cause: 'no-token' });
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe(commits);
    expect(git(repo, 'status', '--porcelain')).toBe('M .minions/config.json');
    expect(CH.formatChannelSet(r)).toMatch(/communication.channel: auto -> telegram \(configRevision \d+/);
  });

  it('dry run and confirmation: nothing is written without --yes or a yes', async () => {
    const { project, file } = await install('private');
    const text = readFileSync(file, 'utf8');
    const dry = await CH.setChannel(project, 'terminal', { dryRun: true }, { isRunning: notRunning });
    expect(dry).toMatchObject({ dryRun: true, changed: true, applied: false });
    expect(readFileSync(file, 'utf8')).toBe(text);
    await expect(CH.setChannel(project, 'terminal', {}, { isRunning: notRunning })).rejects.toMatchObject({ code: 'PRECONDITION', hint: expect.stringMatching(/--yes/) });
    await expect(CH.setChannel(project, 'terminal', {}, { isRunning: notRunning, confirm: async () => null })).rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(CH.setChannel(project, 'terminal', {}, { isRunning: notRunning, confirm: async () => false })).rejects.toMatchObject({ message: expect.stringMatching(/not changed/) });
    expect(readFileSync(file, 'utf8')).toBe(text);
    const asked: string[] = [];
    const ok = await CH.setChannel(project, 'terminal', {}, { isRunning: notRunning, confirm: async (q) => { asked.push(q); return true; } });
    expect(ok.applied).toBe(true);
    expect(asked[0]).toMatch(/Set communication.channel to "terminal" in .*config.json/);
    await expect(CH.setChannel(project, 'slack' as never, { yes: true })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('never overwrites a config file that fails to parse or would become invalid', async () => {
    const { project, file } = await install('private');
    writeFileSync(file, '{ "schemaVersion": 1, broken');
    await expect(CH.setChannel(project, 'terminal', { yes: true }, { isRunning: notRunning })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(readFileSync(file, 'utf8')).toBe('{ "schemaVersion": 1, broken');
    writeFileSync(file, '[1, 2]');
    await expect(CH.setChannel(project, 'terminal', { yes: true }, { isRunning: notRunning })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(readFileSync(file, 'utf8')).toBe('[1, 2]');
    // Parses, but the result fails validation (unknown key): not written either.
    const bad = JSON.stringify({ ...readCfgOf(project.projectId), surprise: true }, null, 2);
    writeFileSync(file, bad);
    await expect(CH.setChannel(project, 'terminal', { yes: true }, { isRunning: notRunning })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(readFileSync(file, 'utf8')).toBe(bad);
  });

  it('hand-edited (valid) file: written, but the manifest keeps it marked as edited', async () => {
    const { project, file } = await install('private');
    const cfg = readCfg(file) as Record<string, unknown> & { configRevision: number };
    writeFileSync(file, JSON.stringify({ ...cfg, permissionMode: 'default' }, null, 4) + '\n');
    const edited = sha256(readFileSync(file));
    const r = await CH.setChannel(project, 'terminal', { yes: true }, { isRunning: notRunning });
    expect(r.applied).toBe(true);
    expect(readCfg(file)).toMatchObject({ configRevision: cfg.configRevision + 1, communication: { channel: 'terminal' }, permissionMode: 'default' });
    const entry = (await loadManifest(project.projectId))!.files.find((f) => f.path === file)!;
    expect(entry.sha256).not.toBe(sha256(readFileSync(file)));
    expect(entry.sha256).not.toBe(edited);
  });

  it('host runtime: warns Telegram is unavailable there; config.local.json override is reported', async () => {
    const { project } = await install('private');
    const host = { ...project, runtime: 'host' as const };
    const r = await CH.setChannel(host, 'telegram', { yes: true }, { isRunning: notRunning });
    expect(r.warnings.join('\n')).toMatch(/Telegram is unavailable in the host runtime/);
    expect(r.nextSteps.join('\n')).not.toMatch(/minions auth telegram/);
    expect(r.effective).toMatchObject({ effective: 'terminal', cause: 'host-runtime' });
    const back = await CH.setChannel(host, 'terminal', { yes: true }, { isRunning: notRunning });
    expect(back.warnings).toEqual([]);

    writeFileSync(projectPaths(project.projectId).configLocalJson, JSON.stringify({ communication: { channel: 'terminal' } }));
    const o = await CH.setChannel(project, 'auto', { yes: true }, { isRunning: notRunning });
    expect(o.warnings.join('\n')).toMatch(/config.local.json sets communication.channel "terminal", which overrides the project file/);
    expect(o.effective.configured).toBe('terminal');
  });
});

function readCfgOf(projectId: string) {
  return JSON.parse(readFileSync(projectPaths(projectId).configJson, 'utf8')) as Record<string, unknown>;
}

describe('minions channel show', () => {
  it('configured vs effective, with the reason; a stored token turns auto into Telegram (docker)', async () => {
    const { repo } = await install('private');
    const s1 = await CH.runChannelShow({ cwd: repo, isRunning: notRunning });
    expect(s1).toMatchObject({ configured: 'auto', effective: 'terminal', cause: 'no-token', source: 'project', tokenStored: false, runtime: 'docker', running: false });
    expect(CH.formatChannelShow(s1)).toMatch(/configured auto \(project: .*config.json\)\neffective: terminal — auto: no Telegram bot token/);
    await C.provisionTelegramToken({ projectId: s1.projectId, token: TOKEN, repoPath: repo, verify: false });
    const s2 = await CH.runChannelShow({ cwd: repo, isRunning: notRunning });
    expect(s2).toMatchObject({ configured: 'auto', effective: 'telegram', cause: 'unchecked', tokenStored: true });
    expect(JSON.stringify(s2) + CH.formatChannelShow(s2)).not.toContain(TOKEN);
  });
});

describe('auth telegram: offer to switch from terminal to auto', () => {
  it('interactive: default yes switches through the channel set path; declining or no terminal prints a hint', async () => {
    const { project, file } = await install('private');
    await CH.setChannel(project, 'terminal', { yes: true }, { isRunning: notRunning });
    const rev = readCfg(file).configRevision;

    const nonInteractive = await CH.offerAutoChannel(project, { interactive: false, confirm: async () => { throw new Error('must not ask'); } }, { isRunning: notRunning });
    expect(nonInteractive).toMatchObject({ configured: 'terminal', offered: false, switched: false, hint: expect.stringMatching(/minions channel set auto/) });
    expect(readCfg(file).communication.channel).toBe('terminal');

    const declined = await CH.offerAutoChannel(project, { interactive: true, confirm: async () => false }, { isRunning: notRunning });
    expect(declined).toMatchObject({ offered: true, switched: false, hint: expect.stringMatching(/minions channel set auto/) });
    expect(readCfg(file).configRevision).toBe(rev);

    const asked: string[] = [];
    const yes = await CH.offerAutoChannel(project, { interactive: true, confirm: async (q) => { asked.push(q); return true; } }, { isRunning: running });
    expect(asked[0]).toMatch(/Switch to "auto".*\(Y\/n\)/);
    expect(yes).toMatchObject({ offered: true, switched: true, hint: null, result: { from: 'terminal', to: 'auto', configRevision: rev + 1 } });
    expect(yes.result!.nextSteps.join('\n')).toContain('minions down && minions start');
    expect(readCfg(file)).toMatchObject({ configRevision: rev + 1, communication: { channel: 'auto' } });

    // Already auto (or telegram): nothing to offer.
    const none = await CH.offerAutoChannel(project, { interactive: true, confirm: async () => { throw new Error('must not ask'); } });
    expect(none).toMatchObject({ configured: 'auto', offered: false, switched: false, hint: null });
  });
});

describe('minions status: channel inside the runtime', () => {
  it('predicted from the mounted token without a launch record; the launch decision once the coordinator ran', async () => {
    const root = join(env.root, 'rt');
    for (const d of ['state', 'secrets', 'ws']) mkdirSync(join(root, d), { recursive: true });
    const paths = runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') });
    const { defaults } = await import('../helpers.js');
    const cfg = defaults();
    expect(await runtimeChannelStatus(cfg, paths)).toMatchObject({ configured: 'auto', effective: 'terminal', source: 'predicted', reason: expect.stringMatching(/no Telegram bot token/) });
    writeFileSync(paths.telegramTokenFile, TOKEN + '\n');
    expect(await runtimeChannelStatus(cfg, paths)).toMatchObject({ effective: 'telegram', source: 'predicted' });
    writeFileSync(paths.coordinatorLaunch, JSON.stringify({ version: 1, pid: 1, startedAt: 'x', fingerprint: 'f', channel: 'terminal', telegram: { enabled: false, reason: 'communication.channel is terminal' } }));
    expect(await runtimeChannelStatus(cfg, paths)).toEqual({ configured: 'auto', effective: 'terminal', reason: 'communication.channel is terminal', source: 'launch', restartRequired: true });
  });
});
