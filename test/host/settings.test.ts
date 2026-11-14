// `minions settings`: the settings model (values, sources, restart/loosening flags), `--list --json`,
// `set <key> <value>` (layer, validation, loosening confirmation, regeneration, graceful restart), runtime
// pause controls. Temp MINIONS_HOME, file credential store, fake runtime; no Docker.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));

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

const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson, loadEffectiveConfig, projectConfigPath } = await import('../../src/host/project.js');
const C = await import('../../src/host/credentials.js');
const S = await import('../../src/host/settings.js');
const SC = await import('../../src/host/settings-cli.js');
const { initFromTemplate, withHome } = await import('./fixtures.js');

const TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

async function install(visibility: 'shared' | 'private' = 'private') {
  const { repo, projectId } = await initFromTemplate(env.root, { visibility });
  const project = await loadProjectJson(projectId);
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
    expect(by('execution.maxActiveTasks')).toMatchObject({ value: 3, source: 'project config', apply: 'live', needsRegenerate: true, needsRestart: false, canLoosen: true });
    expect(by('communication.progress')).toMatchObject({ value: 'quiet', source: 'local override', needsRestart: true });
    expect(by('communication.channel')).toMatchObject({ apply: 'launch', needsRestart: true });
    expect(by('secrets.telegram')).toMatchObject({ value: 'provisioned', source: 'credential store', needsRegenerate: false });
    expect(by('secrets.codex')).toMatchObject({ value: 'missing' });
    expect(by('pause.starts')).toMatchObject({ value: 'running', source: 'runtime' });
    expect(JSON.stringify(views)).not.toContain(TOKEN);
    expect(JSON.stringify(views)).not.toContain('AAHfake');
    const human = SC.formatList(views);
    expect(human).toMatch(/^Delivery:/m);
    expect(human).toContain('execution.maxActiveTasks = 3  (project config)');
    expect(human).not.toContain('AAHfake');
  });

  it('pause flags are unknown (null) when the runtime is not running; shared installs report "shared config"', async () => {
    const { project } = await install('shared');
    const views = S.listSettings(await ctxOf(project, fakeRuntime({ running: false }).runtime));
    expect(views.find((v) => v.key === 'pause.intake')!.value).toBeNull();
    expect(views.find((v) => v.key === 'delivery.merge')!.source).toBe('shared config');
  });
});

describe('settings set', () => {
  it('raising concurrency writes config.local.json (not the project file), regenerates runtime config and plugin, needs no restart', async () => {
    const { project, file, local } = await install('private');
    const before = readFileSync(file, 'utf8');
    const { runtime, calls } = fakeRuntime();
    const confirms: string[] = [];
    const confirm = async (q: string) => { confirms.push(q); return true; };
    const r1 = await SC.applySetting(await ctxOf(project), 'execution.maxActiveTasks', '4', {}, { runtime, confirm });
    expect(r1).toMatchObject({ from: 3, to: 4, layer: 'local', file: local, changed: true, written: true, needsRestart: false, restart: null });
    expect(r1.loosens).toMatch(/more tasks may run in parallel/);
    expect(confirms[0]).toMatch(/loosens policy: more tasks may run in parallel \(higher spend\) \(3 -> 4\).*\(y\/N\)/);
    const r2 = await SC.applySetting(await ctxOf(project), 'execution.maxEngineers', '4', { yes: true }, { runtime, confirm: never });
    expect(r2).toMatchObject({ from: 2, to: 4, written: true });
    expect(readJson(local)).toEqual({ execution: { maxActiveTasks: 4, maxEngineers: 4 } });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(runtimeCfg(project.projectId).execution).toMatchObject({ maxActiveTasks: 4, maxEngineers: 4 });
    expect(readFileSync(join(projectPaths(project.projectId).pluginDir, 'coordinator.md'), 'utf8')).toContain('maxActiveTasks 4');
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
    await expect(SC.applySetting(ctx, 'secrets.telegram', 'x', {}, deps)).rejects.toMatchObject({ code: 'PRECONDITION' });
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

  it('spend caps (budgets.*): token caps settable in tokens, raising or turning one off is loosening, off overrides a lower layer', async () => {
    const { project, local } = await install('private');
    const { runtime, calls } = fakeRuntime();
    const ctx = await ctxOf(project);
    expect(S.listSettings(ctx).filter((v) => v.key.startsWith('budgets.')).map((v) => [v.key, v.value, v.class, v.hostOwned])).toEqual([
      ['budgets.dailyTokens', 'off', 'live', true], ['budgets.taskTokens', 'off', 'live', true],
      ['budgets.dailyUsd', ctx.config.budgets.dailyUsd ?? 'off', 'live', true], ['budgets.taskUsd', ctx.config.budgets.taskUsd ?? 'off', 'live', true],
    ]);
    const r1 = await SC.applySetting(ctx, 'budgets.dailyTokens', '20000000', {}, { runtime, confirm: never });
    expect(r1).toMatchObject({ from: 'off', to: 20_000_000, written: true, loosens: null, needsRestart: false });
    await SC.applySetting(await ctxOf(project), 'budgets.taskTokens', '4000000', {}, { runtime, confirm: never });
    expect(readJson(local)).toEqual({ budgets: { dailyTokens: 20_000_000, taskTokens: 4_000_000 } });
    expect(runtimeCfg(project.projectId).budgets).toMatchObject({ dailyTokens: 20_000_000, taskTokens: 4_000_000 });
    const raise = await SC.applySetting(await ctxOf(project), 'budgets.dailyTokens', '30000000', { yes: true }, { runtime, confirm: never });
    expect(raise.loosens).toBe('the daily token cap is raised (20000000 -> 30000000; higher spend)');
    const lower = await SC.applySetting(await ctxOf(project), 'budgets.dailyTokens', '10000000', {}, { runtime, confirm: never });
    expect(lower.loosens).toBeNull();
    const offed = await SC.applySetting(await ctxOf(project), 'budgets.taskTokens', 'off', { yes: true }, { runtime, confirm: never });
    expect(offed).toMatchObject({ to: null, loosens: 'the per-task token cap is turned off (was 4000000): no stop at that spend' });
    expect(readJson(local).budgets).toEqual({ dailyTokens: 10_000_000, taskTokens: null });
    // USD caps take off too (null overrides the project layer's value).
    await SC.applySetting(await ctxOf(project), 'budgets.dailyUsd', 'off', { yes: true }, { runtime, confirm: never });
    expect(runtimeCfg(project.projectId).budgets.dailyUsd).toBeNull();
    for (const [key, value, msg] of [['budgets.dailyTokens', '0', /at least 1/], ['budgets.dailyTokens', '1.5', /whole number/], ['budgets.taskUsd', '-1', /must be a number/]] as const) {
      await expect(SC.applySetting(await ctxOf(project), key, value, { yes: true }, { runtime, confirm: never })).rejects.toThrow(msg);
    }
    expect(calls).toEqual([]); // live: no restart
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

describe('tester additions (task-23)', () => {
  it('coordinator tool keys (task-48): launch-class, need a restart; a required tool is rejected; dropping the trim is loosening', async () => {
    const { project, local } = await install('private');
    const views = S.listSettings(await ctxOf(project));
    const by = (k: string) => views.find((v) => v.key === k)!;
    expect(by('coordinator.disallowedTools')).toMatchObject({ value: undefined, apply: 'launch', needsRestart: true, canLoosen: true, source: 'mode default' });
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
    cfg.capabilities['base.merge'] = { effect: 'ask', rules: [{ effect: 'deny', roles: ['reviewer'] }] };
    writeFileSync(file, JSON.stringify(cfg));
    const { runtime } = fakeRuntime({ running: false });
    await expect(SC.applySetting(await ctxOf(project), 'capabilities.base.merge', 'allow', { yes: true }, { runtime, confirm: async () => true }))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
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
    { key: 'delivery.merge', to: 'auto-when-eligible', back: 'disabled', seed: { delivery: { merge: 'disabled' } }, msg: /approved branches that pass verification are merged into the base without asking/ },
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

  it('delivery.merge: auto -> disabled is not loosening; the settings list flags every new key as canLoosen', async () => {
    const { project, local } = await install('private');
    writeFileSync(local, JSON.stringify({ delivery: { merge: 'auto-when-eligible' } }));
    const ctx = await ctxOf(project);
    expect((await S.planSetting(ctx, 'delivery.merge', 'disabled')).loosens).toBeNull();
    const views = S.listSettings(ctx);
    for (const k of ['models.allowed', 'models.default', 'coordinator.bundledSkills', 'delivery.merge', 'execution.maxRepairCyclesBeforeReplan']) {
      expect(views.find((v) => v.key === k)).toMatchObject({ canLoosen: true });
    }
  });
});
