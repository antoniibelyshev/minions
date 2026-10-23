// `minions settings`: the settings model (values, sources, restart/loosening flags), `--list --json`,
// `set <key> <value>` (layer, validation, loosening confirmation, regeneration, graceful restart), runtime
// pause controls, and the interactive menu with fake terminal IO (arrow keys and the numbered fallback).
// Temp MINIONS_HOME, file credential store, fake runtime; no Docker.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (cfg: { execution: { maxActiveTasks: number } }, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), `maxActiveTasks ${cfg.execution.maxActiveTasks}\n`);
      return [];
    },
  };
});

const { runInit } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson, loadEffectiveConfig, projectConfigPath } = await import('../../src/host/project.js');
const C = await import('../../src/host/credentials.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const M = await import('../../src/host/settings-menu.js');
type MenuKey = import('../../src/host/settings-menu.js').MenuKey;
type MenuIO = import('../../src/host/settings-menu.js').MenuIO;
const { makeRepo, withHome, dockerUp } = await import('./fixtures.js');

const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

async function install(visibility: 'shared' | 'private' = 'private') {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  return { repo, project, file: projectConfigPath(project), local: projectPaths(project.projectId).configLocalJson };
}

/** A fake runtime: records exec calls; answers status, pause/resume and coordinator restart. */
function fakeRuntime(o: { running?: boolean; restart?: 'ok' | 'refused' } = {}) {
  const calls: string[][] = [];
  const paused = { intake: false, starts: false };
  const runtime: import('../../src/host/settings-cli.js').SettingsRuntime = {
    running: async () => o.running ?? true,
    exec: async (_p, args) => {
      calls.push(args);
      const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
      if (args[1] === 'status') return ok({ paused });
      if (args[1] === 'pause' || args[1] === 'resume') { paused[args[2] === '--intake' ? 'intake' : 'starts'] = args[1] === 'pause'; return ok({ paused }); }
      if (args[1] === 'coordinator') {
        return o.restart === 'refused'
          ? { code: 1, stdout: JSON.stringify({ ok: false, error: { message: 'Coordinator restart refused: 1 active worker lease(s) (lease-1).' } }) + '\n', stderr: '' }
          : ok({ action: 'restarted', reason: 'recover' });
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
  return { runtime, calls, paused };
}

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
const runtimeCfg = (projectId: string) => readJson(join(projectPaths(projectId).runtimeDir, 'config.json'));
const ctxOf = (project: Awaited<ReturnType<typeof install>>['project'], runtime?: import('../../src/host/settings-cli.js').SettingsRuntime) =>
  S.loadSettingsContext(project, runtime ? { pausedState: (p) => SC.runtimePaused(p, runtime) } : {});
const never = async () => { throw new Error('unexpected confirmation'); };

describe('settings model and --list', () => {
  it('lists every group with values, sources, restart and loosening flags; secrets show only provisioned/missing', async () => {
    const { repo, project, local } = await install('private');
    await C.provisionTelegramToken({ projectId: project.projectId, token: TOKEN, repoPath: repo, verify: false });
    writeFileSync(local, JSON.stringify({ communication: { progress: 'quiet' } }));
    const { runtime } = fakeRuntime();
    const views = S.listSettings(await ctxOf(project, runtime));
    const by = (k: string) => views.find((v) => v.key === k)!;
    expect(new Set(views.map((v) => v.group))).toEqual(new Set(S.SETTING_GROUPS));
    expect(by('execution.maxActiveTasks')).toMatchObject({ value: 2, source: 'project config', apply: 'live', needsRegenerate: true, needsRestart: false, canLoosen: true });
    expect(by('communication.progress')).toMatchObject({ value: 'quiet', source: 'local override', needsRestart: true });
    expect(by('communication.channel')).toMatchObject({ apply: 'launch', needsRestart: true });
    expect(by('secrets.telegram')).toMatchObject({ value: 'provisioned', source: 'credential store', needsRegenerate: false });
    expect(by('secrets.github')).toMatchObject({ value: 'missing' });
    expect(by('pause.starts')).toMatchObject({ value: 'running', source: 'runtime' });
    expect(JSON.stringify(views)).not.toContain(TOKEN);
    expect(JSON.stringify(views)).not.toContain('AAHfake');
    const human = SC.formatList(views);
    expect(human).toMatch(/^Delivery:/m);
    expect(human).toContain('execution.maxActiveTasks = 2  (project config)');
    expect(human).not.toContain('AAHfake');
  });

  it('pause flags are unknown (null) when the runtime is not running; shared installs report "shared config"', async () => {
    const { project } = await install('shared');
    const views = S.listSettings(await ctxOf(project, fakeRuntime({ running: false }).runtime));
    expect(views.find((v) => v.key === 'pause.intake')!.value).toBeNull();
    expect(views.find((v) => v.key === 'delivery.mode')!.source).toBe('shared config');
  });
});

describe('settings set', () => {
  it('raising concurrency writes config.local.json (not the project file), regenerates runtime config and plugin, needs no restart', async () => {
    const { project, file, local } = await install('private');
    const before = readFileSync(file, 'utf8');
    const { runtime, calls } = fakeRuntime();
    const confirms: string[] = [];
    const confirm = async (q: string) => { confirms.push(q); return true; };
    const r1 = await SC.applySetting(await ctxOf(project), 'execution.maxActiveTasks', '3', {}, { runtime, confirm });
    expect(r1).toMatchObject({ from: 2, to: 3, layer: 'local', file: local, changed: true, written: true, needsRestart: false, restart: null });
    expect(r1.loosens).toMatch(/more tasks may run in parallel/);
    expect(confirms[0]).toMatch(/loosens policy: more tasks may run in parallel \(higher spend\) \(2 -> 3\).*\(y\/N\)/);
    const r2 = await SC.applySetting(await ctxOf(project), 'execution.maxEngineers', '3', { yes: true }, { runtime, confirm: never });
    expect(r2).toMatchObject({ from: 2, to: 3, written: true });
    expect(readJson(local)).toEqual({ execution: { maxActiveTasks: 3, maxEngineers: 3 } });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(runtimeCfg(project.projectId).execution).toMatchObject({ maxActiveTasks: 3, maxEngineers: 3 });
    expect(readFileSync(join(projectPaths(project.projectId).pluginDir, 'coordinator.md'), 'utf8')).toContain('maxActiveTasks 3');
    expect((await loadEffectiveConfig(project)).provenance['execution.maxActiveTasks']).toBe('local');
    expect(calls).toEqual([]); // live setting: no restart
  });

  it('a loosening change without a terminal needs --yes; a declined confirmation writes nothing', async () => {
    const { project, local } = await install('private');
    const { runtime } = fakeRuntime();
    await expect(SC.applySetting(await ctxOf(project), 'execution.maxActiveTasks', '4', {}, { runtime, confirm: async () => null }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(SC.applySetting(await ctxOf(project), 'execution.maxActiveTasks', '4', {}, { runtime, confirm: async () => false }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(existsSync(local)).toBe(false);
    // Tightening needs no confirmation.
    const r = await SC.applySetting(await ctxOf(project), 'execution.maxActiveTasks', '1', {}, { runtime, confirm: never })
      .catch((e: unknown) => e);
    expect(r).toMatchObject({ code: 'INVALID_CONFIG' }); // maxEngineers 2 > maxActiveTasks 1
    const r2 = await SC.applySetting(await ctxOf(project), 'execution.maxEngineers', '1', {}, { runtime, confirm: never });
    expect(r2).toMatchObject({ loosens: null, written: true });
  });

  it('validates with the schema before writing: bad values, unknown keys, cross-field errors, secrets', async () => {
    const { project, local } = await install('private');
    const { runtime } = fakeRuntime();
    const deps = { runtime, confirm: async () => true };
    const ctx = await ctxOf(project);
    await expect(SC.applySetting(ctx, 'execution.maxEngineers', '5', { yes: true }, deps)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(SC.applySetting(ctx, 'execution.maxActiveTasks', 'three', {}, deps)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(SC.applySetting(ctx, 'communication.progress', 'loud', {}, deps)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(SC.applySetting(ctx, 'models.default', 'not-allowed-model', {}, deps)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(SC.applySetting(ctx, 'no.such.key', '1', {}, deps)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(SC.applySetting(ctx, 'secrets.github', 'ghp_x', {}, deps)).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(existsSync(local)).toBe(false);
  });

  it('a local override cannot lift a deny from the project layer', async () => {
    const { project, file } = await install('private');
    const cfg = readJson(file);
    cfg.capabilities['deploy.execute'] = 'deny';
    writeFileSync(file, JSON.stringify(cfg));
    const views = S.listSettings(await ctxOf(project));
    expect(views.find((v) => v.key === 'capabilities.deploy.execute')!.value).toBe('deny');
    const { runtime } = fakeRuntime();
    await expect(SC.applySetting(await ctxOf(project), 'capabilities.deploy.execute', 'allow', { yes: true }, { runtime, confirm: async () => true }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const plan = await S.planSetting(await ctxOf(project), 'capabilities.deploy.execute', 'deny');
    expect(plan.changed).toBe(false);
  });

  it('--shared: refused on a private install; on a shared install it writes .minions/config.json with a revision bump', async () => {
    const priv = await install('private');
    const { runtime } = fakeRuntime({ running: false });
    await expect(SC.applySetting(await ctxOf(priv.project), 'communication.progress', 'tasks', { layer: 'shared' }, { runtime, confirm: never }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
    env.cleanup(); env = withHome();
    const { project, file, local } = await install('shared');
    const rev = readJson(file).configRevision as number;
    const r = await SC.applySetting(await ctxOf(project), 'communication.progress', 'tasks', { layer: 'shared' }, { runtime, confirm: never });
    expect(r).toMatchObject({ layer: 'shared', file, written: true, needsRestart: true, restart: { action: 'not-running' } });
    expect(r.nextSteps.join(' ')).toMatch(/Commit .*config\.json/);
    expect(readJson(file)).toMatchObject({ configRevision: rev + 1, communication: { progress: 'tasks' } });
    expect(existsSync(local)).toBe(false);
  });

  it('restart-needing changes: confirm then a graceful coordinator restart --recover; refused while workers run; --no-restart only offers', async () => {
    const { project } = await install('private');
    const ok = fakeRuntime();
    const r = await SC.applySetting(await ctxOf(project), 'communication.progress', 'tasks', {}, { runtime: ok.runtime, confirm: async (q) => /Restart the coordinator now\? \(Y\/n\)/.test(q) });
    expect(r.restart).toMatchObject({ action: 'restarted' });
    expect(ok.calls).toEqual([['minions', 'coordinator', 'restart', '--recover', '--json']]);
    expect(ok.calls.flat()).not.toContain('--force');

    const busy = fakeRuntime({ restart: 'refused' });
    const r2 = await SC.applySetting(await ctxOf(project), 'communication.progress', 'quiet', { restart: true }, { runtime: busy.runtime, confirm: never });
    expect(r2.restart).toMatchObject({ action: 'refused' });
    expect(r2.restart!.detail).toContain('minions settings restart');

    const off = fakeRuntime();
    const r3 = await SC.applySetting(await ctxOf(project), 'communication.progress', 'milestones', { restart: false }, { runtime: off.runtime, confirm: never });
    expect(r3.restart).toMatchObject({ action: 'offered' });
    expect(off.calls).toEqual([]);

    const noTty = fakeRuntime();
    const r4 = await SC.applySetting(await ctxOf(project), 'models.selection', 'fixed', {}, { runtime: noTty.runtime, confirm: async () => null });
    expect(r4.restart).toMatchObject({ action: 'offered' });
    expect(SC.formatSet(r4)).toContain('coordinator restart: offered');
  });

  it('optional settings: "default" removes the override; --dry-run writes nothing', async () => {
    const { project, local } = await install('private');
    const { runtime } = fakeRuntime({ running: false });
    const dry = await SC.applySetting(await ctxOf(project), 'models.effort', 'high', { dryRun: true }, { runtime, confirm: never });
    expect(dry).toMatchObject({ changed: true, written: false, dryRun: true });
    expect(existsSync(local)).toBe(false);
    await SC.applySetting(await ctxOf(project), 'models.effort', 'high', {}, { runtime, confirm: never });
    expect(readJson(local)).toEqual({ models: { effort: 'high' } });
    await SC.applySetting(await ctxOf(project), 'models.effort', 'default', {}, { runtime, confirm: never });
    expect(readJson(local)).toEqual({ models: {} });
    expect(runtimeCfg(project.projectId).models.effort).toBeUndefined();
  });

  it('pause controls run minions pause/resume in the runtime; refused when it is not running', async () => {
    const { project } = await install('private');
    const f = fakeRuntime();
    const r = await SC.applySetting(await ctxOf(project, f.runtime), 'pause.starts', 'paused', {}, { runtime: f.runtime, confirm: never });
    expect(r).toMatchObject({ from: 'running', to: 'paused', changed: true, layer: 'runtime' });
    expect(f.calls).toContainEqual(['minions', 'pause', '--starts', '--json']);
    expect(f.paused.starts).toBe(true);
    const down = fakeRuntime({ running: false });
    await expect(SC.applySetting(await ctxOf(project, down.runtime), 'pause.intake', 'paused', {}, { runtime: down.runtime, confirm: never }))
      .rejects.toMatchObject({ code: 'PRECONDITION' });
  });
});

/** Fake terminal: scripted keys and lines; collects everything written. */
function fakeIO(tty: boolean, keys: MenuKey[], lines: string[]) {
  const out: string[] = [];
  const prompts: string[] = [];
  const io: MenuIO = {
    tty,
    write: (t) => { out.push(t); },
    key: async () => { const k = keys.shift(); if (!k) throw new Error('no more keys'); return k; },
    line: async (p) => { prompts.push(p); const l = lines.shift(); if (l === undefined) throw new Error(`no more input for: ${p}`); return l; },
  };
  return { io, out, prompts, text: () => out.join('') };
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const indexOf = (key: string) => S.SETTING_GROUPS.flatMap((g) => S.SETTINGS.filter((s) => s.group === g)).findIndex((s) => s.key === key);

describe('interactive menu', () => {
  it('TTY: grouped rows with values and sources; arrows move, Enter edits with validation, restart offered on exit', async () => {
    const { project, local } = await install('private');
    const f = fakeRuntime();
    const down = indexOf('communication.progress');
    // Navigate down to Reporting > Progress reports, Enter, pick "quiet" (milestones -> tasks -> quiet), quit, confirm restart.
    const keys: MenuKey[] = [...Array(down).fill('down'), 'enter', 'down', 'down', 'enter', 'up', 'down', 'quit'];
    const t = fakeIO(true, keys, ['y']);
    const changed = await M.runSettingsMenu(project, { io: t.io, runtime: f.runtime, runAuth: async () => {} });
    expect(changed).toEqual(['communication.progress']);
    expect(readJson(local)).toEqual({ communication: { progress: 'quiet' } });
    const text = plain(t.text());
    for (const g of ['Delivery', 'Verification', 'Reporting', 'Models', 'Concurrency', 'Integrations', 'Pause']) expect(text).toMatch(new RegExp(`^${g}$`, 'm'));
    expect(text).toMatch(/> Progress reports\s+milestones\s+project config/);
    expect(text).toMatch(/Progress reports\s+quiet\s+local override/);
    expect(text).toContain('communication.progress: what the coordinator reports unprompted');
    expect(text).toContain('coordinator restart: restarted');
    expect(f.calls).toContainEqual(['minions', 'coordinator', 'restart', '--recover', '--json']);
  });

  it('TTY: an invalid value is reported and nothing is saved; a loosening edit asks first', async () => {
    const { project, local } = await install('private');
    const f = fakeRuntime();
    const at = indexOf('execution.maxEngineers');
    const keys: MenuKey[] = [...Array(at).fill('down'), 'enter', 'enter', 'quit'];
    // 5 > maxActiveTasks: invalid. Then 1 (tightening, no confirmation). No restart needed (live).
    const t = fakeIO(true, keys, ['5', '1']);
    await M.runSettingsMenu(project, { io: t.io, runtime: f.runtime, runAuth: async () => {} });
    expect(plain(t.text())).toMatch(/not saved:[\s\S]*execution\.maxEngineers: must be <=/);
    expect(readJson(local)).toEqual({ execution: { maxEngineers: 1 } });
    expect(t.prompts.some((p) => /Restart/.test(p))).toBe(false);
  });

  it('numbered fallback without a TTY: pick by number, loosening confirmation, quit', async () => {
    const { project, local } = await install('private');
    const f = fakeRuntime({ running: false });
    const n = indexOf('execution.maxActiveTasks') + 1;
    const t = fakeIO(false, [], [String(n), '3', 'y', 'q']);
    const changed = await M.runSettingsMenu(project, { io: t.io, runtime: f.runtime, runAuth: async () => {} });
    expect(changed).toEqual(['execution.maxActiveTasks']);
    expect(readJson(local)).toEqual({ execution: { maxActiveTasks: 3 } });
    const text = t.text();
    expect(text).toMatch(/^Concurrency:$/m);
    expect(text).toMatch(new RegExp(`^\\s+${n}\\) Max active tasks\\s+2\\s+project config`, 'm'));
    expect(t.prompts.some((p) => /loosens policy/.test(p))).toBe(true);
  });

  it('numbered fallback: enum choices by number, declined loosening keeps the value; token items refuse with a --stdin hint', async () => {
    const { project, local } = await install('private');
    const f = fakeRuntime({ running: false });
    const auth: string[] = [];
    const n = indexOf('verification.reviewerRequired') + 1;
    const g = indexOf('secrets.github') + 1;
    const tg = indexOf('secrets.telegram') + 1;
    // reviewerRequired: choose 2) false -> loosening -> decline. Then both token items: refused, no auth flow on
    // the piped stdin (the next line is still read as a menu choice, not as a token). Quit.
    const t = fakeIO(false, [], [String(n), '2', 'n', String(g), String(tg), 'q']);
    await M.runSettingsMenu(project, { io: t.io, runtime: f.runtime, runAuth: async (k) => { auth.push(k); } });
    expect(existsSync(local)).toBe(false);
    expect(auth).toEqual([]);
    expect(t.text()).toContain('not saved: Not confirmed');
    expect(t.text()).toContain('GitHub token: not changed here (no terminal to enter a token without echo)');
    expect(t.text()).toContain('hint: run `minions auth github --stdin < token-file` instead');
    expect(t.text()).toContain('hint: run `minions auth telegram --stdin < token-file` instead');
    expect(t.prompts.filter((p) => /^Setting to change/.test(p))).toHaveLength(4);
  });

  it('TTY: a token item runs the auth flow and then shows provisioned / missing', async () => {
    const { project } = await install('private');
    const f = fakeRuntime({ running: false });
    const auth: string[] = [];
    const t = fakeIO(true, [...Array(indexOf('secrets.github')).fill('down'), 'enter', 'quit'], []);
    await M.runSettingsMenu(project, { io: t.io, runtime: f.runtime, runAuth: async (k) => { auth.push(k); } });
    expect(auth).toEqual(['github']);
    expect(plain(t.text())).toContain('GitHub token: missing');
  });
});

describe('tester additions (task-23)', () => {
  it('coordinator tool keys (task-48): launch-class, need a restart; a required tool is rejected; dropping the trim is loosening', async () => {
    const { project, local } = await install('private');
    const views = S.listSettings(await ctxOf(project));
    const by = (k: string) => views.find((v) => v.key === k)!;
    expect(by('coordinator.disallowedTools')).toMatchObject({ value: undefined, apply: 'launch', needsRestart: true, canLoosen: true, source: 'profile default' });
    expect(by('coordinator.toolSearch')).toMatchObject({ value: true, apply: 'launch', needsRestart: true });
    expect(by('coordinator.bundledSkills')).toMatchObject({ value: false, apply: 'launch', needsRestart: true });
    const { runtime, calls } = fakeRuntime({ running: false });
    for (const bad of ['Bash', 'Artifact, Agent', 'Read(*)', 'mcp__plugin_telegram_telegram__reply']) {
      await expect(SC.applySetting(await ctxOf(project), 'coordinator.disallowedTools', bad, { yes: true }, { runtime, confirm: never }))
        .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(existsSync(local)).toBe(false);
    // "none" keeps every tool: loosening, needs a confirmation (refused without a terminal).
    await expect(SC.applySetting(await ctxOf(project), 'coordinator.disallowedTools', 'none', {}, { runtime, confirm: async () => null }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const r = await SC.applySetting(await ctxOf(project), 'coordinator.disallowedTools', 'none', { yes: true }, { runtime, confirm: never });
    expect(r).toMatchObject({ written: true, needsRestart: true, restart: { action: 'not-running' } });
    expect(r.loosens).toMatch(/the coordinator gets back Artifact/);
    expect(readJson(local)).toEqual({ coordinator: { disallowedTools: [] } });
    expect(runtimeCfg(project.projectId).coordinator.disallowedTools).toEqual([]);
    // Adding a tool back to the trim tightens: no confirmation; "default" unsets it.
    const t = await SC.applySetting(await ctxOf(project), 'coordinator.disallowedTools', 'WebFetch, WebSearch', {}, { runtime, confirm: never });
    expect(t).toMatchObject({ loosens: null, written: true });
    await SC.applySetting(await ctxOf(project), 'coordinator.disallowedTools', 'default', { yes: true }, { runtime, confirm: async () => true });
    expect(readJson(local)).toEqual({ coordinator: {} });
    const ts = await SC.applySetting(await ctxOf(project), 'coordinator.toolSearch', 'false', {}, { runtime, confirm: never });
    expect(ts).toMatchObject({ from: true, to: false, needsRestart: true, written: true });
    expect(calls).toEqual([]);
  });

  it('a local override cannot lift a project-level deny rule either (rule-level deny, plain allow attempt)', async () => {
    const { project, file, local } = await install('private');
    const cfg = readJson(file);
    cfg.capabilities['git.push'] = { effect: 'ask', rules: [{ effect: 'deny', roles: ['reviewer'] }] };
    writeFileSync(file, JSON.stringify(cfg));
    const { runtime } = fakeRuntime({ running: false });
    await expect(SC.applySetting(await ctxOf(project), 'capabilities.git.push', 'allow', { yes: true }, { runtime, confirm: async () => true }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(existsSync(local)).toBe(false);
  });

  it('the menu (TTY and numbered) never shows a stored token', async () => {
    const { repo, project } = await install('private');
    await C.provisionTelegramToken({ projectId: project.projectId, token: TOKEN, repoPath: repo, verify: false });
    const f = fakeRuntime({ running: false });
    const g = indexOf('secrets.telegram');
    const tty = fakeIO(true, [...Array(g).fill('down'), 'enter', 'quit'], []);
    await M.runSettingsMenu(project, { io: tty.io, runtime: f.runtime, runAuth: async () => {} });
    const num = fakeIO(false, [], [String(g + 1), 'q']);
    await M.runSettingsMenu(project, { io: num.io, runtime: f.runtime, runAuth: async () => {} });
    for (const t of [tty.text(), num.text()]) {
      expect(plain(t)).toMatch(/Telegram bot token\s+provisioned\s+credential store/);
      expect(t).not.toContain('AAHfake');
    }
  });

  it('menu: the restart offered on exit is graceful; refused while leases are active, never forced', async () => {
    const { project } = await install('private');
    const busy = fakeRuntime({ restart: 'refused' });
    const n = indexOf('communication.progress') + 1;
    const t = fakeIO(false, [], [String(n), '3', 'q', 'y']);
    await M.runSettingsMenu(project, { io: t.io, runtime: busy.runtime, runAuth: async () => {} });
    expect(t.text()).toMatch(/coordinator restart: refused - .*active worker lease/);
    expect(t.text()).toContain('minions settings restart');
    expect(busy.calls.filter((c) => c[1] === 'coordinator')).toEqual([['minions', 'coordinator', 'restart', '--recover', '--json']]);
    expect(busy.calls.flat()).not.toContain('--force');
    // Declining the restart issues no restart at all.
    const ok = fakeRuntime();
    const d = fakeIO(false, [], [String(n), '2', 'q', 'n']);
    await M.runSettingsMenu(project, { io: d.io, runtime: ok.runtime, runAuth: async () => {} });
    expect(ok.calls.some((c) => c[1] === 'coordinator')).toBe(false);
    expect(d.text()).toContain('Restart later with `minions settings restart`');
  });

  it('terminalMenuIO on a piped (non-TTY) stdin: numbered prompts read every line of one chunk; owner raises concurrency to 3', async () => {
    const { PassThrough } = await import('node:stream');
    const { project, local } = await install('private');
    const f = fakeRuntime({ running: false });
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const out = new PassThrough();
    let text = '';
    out.on('data', (d: Buffer) => { text += d.toString(); });
    const a = indexOf('execution.maxActiveTasks') + 1, e = indexOf('execution.maxEngineers') + 1;
    (stdin as unknown as NodeJS.WritableStream).end([a, 3, 'y', e, 3, 'y', 'q'].join('\n') + '\n');
    const io = M.terminalMenuIO(stdin, out);
    expect(io.tty).toBe(false);
    const changed = await M.runSettingsMenu(project, { io, runtime: f.runtime, runAuth: async () => {} });
    expect(changed).toEqual(['execution.maxActiveTasks', 'execution.maxEngineers']);
    expect(readJson(local)).toEqual({ execution: { maxActiveTasks: 3, maxEngineers: 3 } });
    expect(runtimeCfg(project.projectId).execution).toMatchObject({ maxActiveTasks: 3, maxEngineers: 3 });
    expect(text).toMatch(/Setting to change \[1-\d+, q = quit\]/);
  });

  it('terminalMenuIO on a non-TTY stdin: end of input at the restart prompt is no, not the (Y/n) default', async () => {
    const { PassThrough } = await import('node:stream');
    const { project } = await install('private');
    const f = fakeRuntime({ running: true });
    const stdin = new PassThrough();
    const out = new PassThrough();
    let text = '';
    out.on('data', (d: Buffer) => { text += d.toString(); });
    // communication.progress milestones -> tasks (choice 2): needs a restart, loosens nothing; then 'q' and end of input.
    stdin.end([indexOf('communication.progress') + 1, 2, 'q'].join('\n') + '\n');
    const changed = await M.runSettingsMenu(project, { io: M.terminalMenuIO(stdin as unknown as NodeJS.ReadStream, out), runtime: f.runtime, runAuth: async () => {} });
    expect(changed).toEqual(['communication.progress']);
    expect(text).toContain('Restart later');
    expect(f.calls.some((c) => c[1] === 'coordinator')).toBe(false);
  });

  it('TTY: Enter at the restart prompt takes the shown default (restart)', async () => {
    const { project } = await install('private');
    const f = fakeRuntime();
    const down = indexOf('communication.progress');
    const t = fakeIO(true, [...Array(down).fill('down'), 'enter', 'down', 'enter', 'quit'], ['']);
    await M.runSettingsMenu(project, { io: t.io, runtime: f.runtime, runAuth: async () => {} });
    expect(f.calls).toContainEqual(['minions', 'coordinator', 'restart', '--recover', '--json']);
  });

  it('terminalMenuIO on a non-TTY stdin: end of input quits the menu without changes', async () => {
    const { PassThrough } = await import('node:stream');
    const { project, local } = await install('private');
    const stdin = new PassThrough();
    stdin.end();
    const changed = await M.runSettingsMenu(project, { io: M.terminalMenuIO(stdin as unknown as NodeJS.ReadStream, new PassThrough()), runtime: fakeRuntime({ running: false }).runtime, runAuth: async () => {} });
    expect(changed).toEqual([]);
    expect(existsSync(local)).toBe(false);
  });
});

describe('apply classes match what reads each value', () => {
  it('default model and turn limit need a restart (worker definitions); concurrency and repair cycles are live', async () => {
    const { project } = await install('private');
    const views = S.listSettings(await ctxOf(project));
    const by = (k: string) => views.find((v) => v.key === k)!;
    expect(by('models.default')).toMatchObject({ apply: 'prompt', needsRestart: true });
    expect(by('execution.attemptMaxTurns')).toMatchObject({ apply: 'prompt', needsRestart: true });
    for (const k of ['execution.maxActiveTasks', 'execution.maxEngineers', 'execution.maxRepairCyclesBeforeReplan']) expect(by(k)).toMatchObject({ apply: 'live', needsRestart: false });
    const tpl = (f: string) => readFileSync(join(process.cwd(), 'templates', 'plugin', 'agents', f), 'utf8');
    for (const f of ['engineer.md', 'tester.md', 'reviewer.md']) expect(tpl(f)).toMatch(/^maxTurns: \{\{attemptMaxTurns\}\}$/m);
  });
});

describe('remaining loosening changes (task-50)', () => {
  /** Each change: refused without a terminal and without --yes; applied with --yes; the reverse is not loosening. */
  const cases: { key: string; to: string; back: string; seed?: Record<string, unknown>; msg: RegExp }[] = [
    { key: 'models.allowed', to: 'sonnet, opus, haiku, claude-opus-4-1', back: 'sonnet, opus, haiku', msg: /the coordinator may pick claude-opus-4-1 for workers \(higher spend possible\)/ },
    { key: 'models.default', to: 'opus', back: 'sonnet', msg: /workers default to a pricier model \(sonnet ~\$3\/MTok -> opus ~\$5\/MTok; higher spend\)/ },
    { key: 'models.selection', to: 'coordinator', back: 'fixed', seed: { models: { selection: 'fixed' } }, msg: /the coordinator may pick other allowed models per worker \(possibly pricier\)/ },
    { key: 'coordinator.bundledSkills', to: 'true', back: 'false', msg: /the coordinator session gets Claude Code's bundled skills/ },
    { key: 'delivery.merge', to: 'manual', back: 'disabled', seed: { delivery: { provider: 'github', mode: 'pull-request' } }, msg: /minions may merge pull requests on GitHub when asked/ },
    { key: 'execution.maxRepairCyclesBeforeReplan', to: '5', back: '3', msg: /more failed fix cycles may run before a task is replanned \(higher spend\) \(3 -> 5\)/ },
  ];
  for (const c of cases) {
    it(`${c.key} -> ${c.to}: needs a confirmation or --yes; back to ${c.back} needs none`, async () => {
      const { project, local } = await install('private');
      if (c.seed) writeFileSync(local, JSON.stringify(c.seed));
      const seeded = c.seed ? readFileSync(local, 'utf8') : undefined;
      const { runtime } = fakeRuntime({ running: false });
      // No terminal, no --yes: refused, nothing written.
      await expect(SC.applySetting(await ctxOf(project), c.key, c.to, {}, { runtime, confirm: async () => null }))
        .rejects.toMatchObject({ code: 'POLICY_DENIED' });
      // Declined confirmation: nothing written.
      const asked: string[] = [];
      await expect(SC.applySetting(await ctxOf(project), c.key, c.to, {}, { runtime, confirm: async (q) => { asked.push(q); return false; } }))
        .rejects.toMatchObject({ code: 'PRECONDITION' });
      expect(asked[0]).toMatch(/loosens policy/);
      expect(asked[0]).toMatch(c.msg);
      if (seeded === undefined) expect(existsSync(local)).toBe(false); else expect(readFileSync(local, 'utf8')).toBe(seeded);
      // --yes applies it without asking.
      const r = await SC.applySetting(await ctxOf(project), c.key, c.to, { yes: true }, { runtime, confirm: never });
      expect(r).toMatchObject({ changed: true, written: true });
      expect(r.loosens).toMatch(c.msg);
      // The reverse change tightens: no confirmation.
      const b = await SC.applySetting(await ctxOf(project), c.key, c.back, {}, { runtime, confirm: never });
      expect(b).toMatchObject({ loosens: null, written: true });
    });
  }

  it('models.default: a cheaper default is not loosening; one without a known price is; models.allowed narrowing is not', async () => {
    const { project, local } = await install('private');
    const { runtime } = fakeRuntime({ running: false });
    writeFileSync(local, JSON.stringify({ models: { allowed: ['sonnet', 'opus', 'haiku', 'custom-model-x'] } }));
    const cheaper = await SC.applySetting(await ctxOf(project), 'models.default', 'haiku', {}, { runtime, confirm: never });
    expect(cheaper).toMatchObject({ from: 'sonnet', to: 'haiku', loosens: null, written: true });
    const unknown = await S.planSetting(await ctxOf(project), 'models.default', 'custom-model-x');
    expect(unknown.loosens).toMatch(/workers default to a possibly pricier model \(haiku ~\$1\/MTok -> custom-model-x \(no known price\); higher spend\)/);
    const narrow = await SC.applySetting(await ctxOf(project), 'models.allowed', 'sonnet, haiku', {}, { runtime, confirm: never });
    expect(narrow).toMatchObject({ loosens: null, written: true });
    // Swapping one model for another still adds a model: loosening.
    expect((await S.planSetting(await ctxOf(project), 'models.allowed', ['haiku', 'opus'])).loosens).toMatch(/may pick opus/);
  });

  it('delivery.merge: manual -> disabled and auto -> manual are not loosening; the settings list flags every new key as canLoosen', async () => {
    const { project, local } = await install('private');
    writeFileSync(local, JSON.stringify({ delivery: { provider: 'github', mode: 'pull-request', merge: 'auto-when-eligible' } }));
    const ctx = await ctxOf(project);
    expect((await S.planSetting(ctx, 'delivery.merge', 'manual')).loosens).toBeNull();
    expect((await S.planSetting(ctx, 'delivery.merge', 'disabled')).loosens).toBeNull();
    const views = S.listSettings(ctx);
    for (const k of ['models.allowed', 'models.default', 'coordinator.bundledSkills', 'delivery.merge', 'execution.maxRepairCyclesBeforeReplan']) {
      expect(views.find((v) => v.key === k)).toMatchObject({ canLoosen: true });
    }
  });

  it('numbered menu: raising repair cycles asks for confirmation; declining writes nothing', async () => {
    const { project, local } = await install('private');
    const f = fakeRuntime({ running: false });
    const t = fakeIO(false, [], [String(indexOf('execution.maxRepairCyclesBeforeReplan') + 1), '6', 'n', 'q']);
    await M.runSettingsMenu(project, { io: t.io, runtime: f.runtime, runAuth: async () => {} });
    expect(t.prompts.some((p) => /loosens policy: more failed fix cycles/.test(p))).toBe(true);
    expect(existsSync(local)).toBe(false);
  });
});
