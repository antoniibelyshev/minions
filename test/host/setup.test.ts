import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (cfg: { delivery: { merge: string }; communication: { channel: string } }, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), `merge ${cfg.delivery.merge} channel ${cfg.communication.channel}\n`);
      return [];
    },
  };
});

const { runSetup, formatSetup, shellQuote } = await import('../../src/host/setup.js');
const { loadCredentialRefs, readTelegramToken } = await import('../../src/host/credentials.js');
const { loadEffectiveConfig, loadProjectJson } = await import('../../src/host/project.js');
const { loadRegistry } = await import('../../src/host/registry.js');
const { projectPaths, repoPaths } = await import('../../src/core/paths.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');
type SetupRuntime = import('../../src/host/setup.js').SetupRuntime;
type SetupResult = import('../../src/host/setup.js').SetupResult;

const TG_TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

/** Scripted prompts: answers are matched by question prefix; unmatched questions take the default. */
function scripted(answers: Record<string, string> = {}, secrets: string[] = []) {
  const asked: string[] = [];
  const info: string[] = [];
  return {
    asked, info,
    io: {
      ask: async (q: string, def: string) => {
        asked.push(q);
        const key = Object.keys(answers).find((k) => q.startsWith(k));
        return key ? answers[key]! : def;
      },
      info: (l: string) => { info.push(l); },
      secret: async (prompt: string) => { asked.push(`secret:${prompt}`); return secrets.shift() ?? ''; },
    },
  };
}

/** Fake container runtime: records calls, keeps state across reruns. */
function fakeRuntime(state = { running: false, imported: false, coordinator: false }) {
  const calls: string[] = [];
  const runtime: SetupRuntime = {
    containerRunning: async () => { calls.push('running?'); return state.running; },
    start: async () => { calls.push('start'); state.running = true; },
    repoPresent: async () => { calls.push('repo?'); return state.imported; },
    importRepo: async () => {
      calls.push('import'); state.imported = true;
      return { bundle: '/tmp/b', commit: 'a'.repeat(40), baseBranch: 'main', warnings: [], container: {} };
    },
    launchCoordinator: async () => {
      calls.push('coordinator');
      const was = state.coordinator; state.coordinator = true;
      return was ? { action: 'none', reason: 'already running' } : { action: 'started', reason: 'not running' };
    },
    attachCommand: (id) => `docker compose -p minions-${id.slice(0, 8)} exec app minions coordinator`,
  };
  return { runtime, calls, state };
}

const step = (r: SetupResult, id: string) => r.steps.find((s) => s.id === id)!;

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('minions setup', () => {
  it('runs the whole flow end to end: mode, Telegram, container, import, coordinator', async () => {
    const repo = makeRepo(env.root);
    const a = scripted({ 'Mode': '1', 'Set up Telegram': 'y' }, [TG_TOKEN]);
    const rt = fakeRuntime();
    const r = await runSetup({ path: repo, yes: false, io: a.io, visibility: 'private', runtime: rt.runtime, dockerProbe: dockerUp });

    // Order of the questions: the mode first, then what defaults.json does not answer, then the integrations and the container.
    const order = ['Mode', 'Claude authorization', 'Apply this plan?',
      'Set up Telegram', 'secret:Telegram bot token', 'Check the token with Telegram', 'Build and start the container'];
    const idx = order.map((q) => a.asked.findIndex((x) => x.startsWith(q)));
    expect(idx.every((i) => i >= 0), JSON.stringify(a.asked)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    // The mode answers the rest: no visibility, channel or local integration question.
    expect(a.asked.some((q) => /^(Installation visibility|Communication channel|Store the Telegram|Integrate approved)/.test(q))).toBe(false);

    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['init', 'done'],
      ['telegram', 'done'], ['publish', 'skipped'], ['harness', 'skipped'], ['container', 'done'], ['import', 'done'], ['coordinator', 'done'],
    ]);
    expect(rt.calls).toEqual(['running?', 'start', 'repo?', 'import', 'coordinator']);
    expect(r.ready).toBe(true);
    expect(await readTelegramToken(r.projectId)).toBe(TG_TOKEN);

    // Choices land in the host-only local layer and in the regenerated plugin/runtime config.
    const paths = projectPaths(r.projectId);
    // communication.channel stays auto (the default): a stored bot token is what turns Telegram on.
    expect(existsSync(paths.configLocalJson)).toBe(false);
    const eff = (await loadEffectiveConfig(await loadProjectJson(r.projectId))).config;
    expect(eff.delivery.merge).toBe('auto-when-eligible');
    expect(eff.communication.channel).toBe('auto');
    expect(readFileSync(join(paths.pluginDir, 'coordinator.md'), 'utf8')).toBe('merge auto-when-eligible channel auto\n');
    expect(JSON.parse(readFileSync(paths.runtimeConfigJson, 'utf8')).communication.channel).toBe('auto');

    // Attach and pairing instructions.
    const out = formatSetup(r);
    expect(r.attach).toContain('exec app minions coordinator');
    expect(out).toContain('minions telegram access pair <code>');
    expect(out).toContain('minions telegram access policy allowlist');
    expect(out).toContain('/login');

    // Secrets never appear in the result, its rendering, prompts, notes, or generated files.
    const visible = JSON.stringify(r) + out + a.asked.join('\n') + a.info.join('\n');
    expect(visible).not.toContain(TG_TOKEN);
    for (const p of [...allFiles(repo), ...allFiles(paths.pluginDir), paths.configJson, paths.runtimeConfigJson, paths.composeYaml]) {
      expect(readFileSync(p, 'utf8'), p).not.toContain(TG_TOKEN);
    }
  });
  it('asks each optional integration with default no; declining skips cleanly with a note on enabling later', async () => {
    const repo = makeRepo(env.root);
    const a = scripted({ 'Installation visibility': 'private' });
    const rt = fakeRuntime();
    const r = await runSetup({ mode: 'independent', path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(a.asked.find((x) => x.startsWith('Set up Telegram'))).toBeDefined();
    expect(a.asked.some((x) => x.startsWith('secret:'))).toBe(false);
    expect(step(r, 'telegram').status).toBe('skipped');
    expect(step(r, 'telegram').later).toMatch(/minions setup/);
    expect(r.localConfig.changed).toEqual([]);
    expect(existsSync(projectPaths(r.projectId).configLocalJson)).toBe(false);
    const rp = shellQuote(r.init.plan.repoPath); // quoted when the temp path has a space (host TMPDIR)
    expect(formatSetup(r)).toContain(`later: Run \`minions setup ${rp}\` again (or \`cd ${rp} && minions auth telegram\`)`);
    // Core steps default to yes.
    expect(rt.calls).toContain('start');
    expect(step(r, 'coordinator').status).toBe('done');
  });
  it('every printed command names the repository (shell-quoted), so it works from any directory', async () => {
    const repo = makeRepo(env.root, "my repo's dir");
    const r = await runSetup({ mode: 'independent', path: repo, yes: true, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    const q = `'${r.init.plan.repoPath.replace(/'/g, `'\\''`)}'`;
    expect(r.init.plan.repoPath).toContain("my repo's dir");
    expect(r.ready).toBe(true);
    expect(r.nextSteps[0]).toContain(`\`cd ${q} && minions start\``);
    expect(r.nextSteps.at(-1)).toContain(`\`cd ${q} && minions doctor\``);
    expect(r.nextSteps.at(-1)).toContain(`\`minions setup ${q}\``);
    const out = formatSetup(r);
    expect(out).toContain(`Attach: cd ${q} && minions start   (or: `);
    // Every \`minions ...\` instruction is either \`minions setup <path>\` or prefixed with \`cd <path> &&\`.
    for (const m of out.matchAll(/\`([^\`]*minions [^\`]*)\`/g)) {
      expect(m[1]!.startsWith(`cd ${q} && `) || m[1] === `minions setup ${q}`, m[1]).toBe(true);
    }
    expect(step(r, 'telegram').later).toContain(`\`cd ${q} && minions auth telegram\``);
  });

  it('declining the container step says how to start later from any directory', async () => {
    const repo = makeRepo(env.root);
    const r = await runSetup({ mode: 'independent', path: repo, yes: false, io: scripted({ 'Installation visibility': 'private', 'Build and start the container': 'n' }).io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    const rp = shellQuote(r.init.plan.repoPath); // quoted when the temp path has a space (host TMPDIR)
    expect(step(r, 'container').later).toBe(`Run \`minions setup ${rp}\` again or \`cd ${rp} && minions start\` to start the container and attach the coordinator.`);
    expect(r.nextSteps[0]).toBe(`Run \`cd ${rp} && minions start\` to start the container and attach the coordinator.`);
  });

  it('declining the container step leaves Docker untouched and says how to start later', async () => {
    const repo = makeRepo(env.root);
    const a = scripted({ 'Installation visibility': 'private', 'Build and start the container': 'n' });
    const rt = fakeRuntime();
    const r = await runSetup({ mode: 'independent', path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(rt.calls).toEqual([]);
    expect(step(r, 'container')).toMatchObject({ status: 'skipped', later: expect.stringContaining('minions start') });
    expect(r.attach).toBeNull();
  });

  it('rerun is idempotent: detects config, credentials and container and offers keep/change without duplicating state', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    const first = await runSetup({ mode: 'independent', 
      path: repo, yes: false, runtime: rt.runtime, dockerProbe: dockerUp,
      io: scripted({ 'Installation visibility': 'private', 'Set up Telegram': 'y' }, [TG_TOKEN]).io,
    });
    const paths = projectPaths(first.projectId);
    const snapshot = () => [paths.manifestJson, paths.configLocalJson, paths.configJson, join(paths.dir, 'credentials.json')]
      .map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
    const before = snapshot();
    const refsBefore = await loadCredentialRefs(first.projectId);

    const a = scripted();
    rt.calls.length = 0;
    const again = await runSetup({ mode: 'independent', path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(again.projectId).toBe(first.projectId);
    expect(again.rerun).toBe(true);
    expect(a.asked.find((q) => q.startsWith('Project configuration: keep it or change it?'))).toBeDefined();
    expect(a.asked.find((q) => q.startsWith('Telegram is set up'))).toContain('keep/change/disable');
    expect(a.asked.some((q) => q.startsWith('secret:') || q.startsWith('Starting profile') || q.startsWith('Apply this plan?'))).toBe(false);
    expect(again.steps.filter((s) => ['init', 'telegram', 'container', 'import', 'coordinator'].includes(s.id)).map((s) => s.status))
      .toEqual(['kept', 'kept', 'kept', 'kept', 'kept']);
    expect(again.init.applied!.written).toEqual([]);
    expect(again.localConfig.changed).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(await loadCredentialRefs(first.projectId)).toEqual(refsBefore);
    expect(Object.keys((await loadRegistry()).projects)).toEqual([first.projectId]);
    expect(rt.calls).not.toContain('import');
  });
  it('every printed command in the kept and import branches also names the repository', async () => {
    const repo = makeRepo(env.root, "my repo's dir");
    const rt = fakeRuntime();
    const first = await runSetup({ mode: 'independent', path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, tokens: { telegram: TG_TOKEN }, visibility: 'private' });
    const q = `'${first.init.plan.repoPath.replace(/'/g, `'\\''`)}'`;
    const inRepo = (c: string) => `\`cd ${q} && ${c}\``;
    // kept import + telegram disabled (token kept)
    const kept = await runSetup({ mode: 'independent', path: repo, yes: false, runtime: rt.runtime, dockerProbe: dockerUp,
      io: scripted({ 'Telegram is set up': 'disable' }).io });
    expect(step(kept, 'import').detail).toContain(inRepo('minions import'));
    expect(step(kept, 'telegram').detail).toContain(inRepo('minions auth telegram --remove'));
    for (const m of formatSetup(kept).matchAll(/\`([^\`]*minions [^\`]*)\`/g)) {
      expect(m[1]!.startsWith(`cd ${q} && `) || m[1] === `minions setup ${q}`, m[1]).toBe(true);
    }
  });
  it('every printed command in the dry-run branch also names the repository', async () => {
    const rt = fakeRuntime();
    const repo3 = makeRepo(env.root, "my repo's dir 3");
    const d = await runSetup({ mode: 'independent', path: repo3, yes: false, dryRun: true, io: scripted().io, runtime: rt.runtime, dockerProbe: dockerUp });
    const q3 = `'${d.init.plan.repoPath.replace(/'/g, `'\\''`)}'`;
    const planned = formatSetup(d); // the init plan above the setup plan is shared with `minions init`
    for (const m of planned.slice(planned.indexOf('Setup plan')).matchAll(/\`([^\`]*minions [^\`]*)\`/g)) {
      expect(m[1]!.startsWith(`cd ${q3} && `) || m[1] === `minions setup ${q3}`, m[1]).toBe(true);
    }
  });
  it('rerun with "change" asks the mode again and rebuilds the configuration from it; the runtime and the token stay', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    const first = await runSetup({ mode: 'independent', path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, tokens: { telegram: TG_TOKEN }, visibility: 'private' });
    expect(step(first, 'telegram').status).toBe('done');
    const a = scripted({
      'Project configuration: keep it or change it?': 'change',
      'Mode': 'supervised',
    });
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(a.asked.find((q) => q.startsWith('Mode'))).toBe('Mode (independent/supervised)');
    expect(a.asked.some((q) => q.startsWith('Installation visibility'))).toBe(false); // visibility stays as installed
    expect(step(r, 'init').status).toBe('changed');
    expect(step(r, 'telegram').status).toBe('skipped'); // supervised talks in the terminal
    expect(await readTelegramToken(r.projectId)).toBe(TG_TOKEN); // the token is kept
    const eff = (await loadEffectiveConfig(await loadProjectJson(r.projectId))).config;
    expect(eff).toMatchObject({ mode: 'supervised', delivery: { merge: 'disabled' } });
    expect(eff.communication.channel).toBe('terminal');
    expect(r.init.plan.runtime).toBe('docker'); // an installed project keeps its runtime
  });
  it('--yes uses defaults: optional integrations off, core steps on, no prompts', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    const r = await runSetup({ mode: 'independent', path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['init', 'done'],
      ['telegram', 'skipped'], ['publish', 'skipped'], ['harness', 'skipped'], ['container', 'done'], ['import', 'done'], ['coordinator', 'done'],
    ]);
    expect((await loadEffectiveConfig(await loadProjectJson(r.projectId))).config.delivery.merge).toBe('auto-when-eligible');
  });
  it('an invalid token is reported as failed, nothing is stored, and the rest of setup continues', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    const a = scripted({ 'Installation visibility': 'private', 'Set up Telegram': 'y' }, ['not-a-token']);
    const r = await runSetup({ mode: 'independent', path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(step(r, 'telegram')).toMatchObject({ status: 'failed', later: expect.stringContaining('minions auth telegram') });
    expect(JSON.stringify(step(r, 'telegram'))).not.toContain('not-a-token');
    expect((await loadCredentialRefs(r.projectId)).telegram).toBeUndefined();
    expect(existsSync(projectPaths(r.projectId).configLocalJson)).toBe(false);
    expect(step(r, 'coordinator').status).toBe('done');
  });

  it('--dry-run writes nothing, prompts for nothing, and does not touch the container', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    const a = scripted();
    const r = await runSetup({ mode: 'independent', path: repo, yes: false, dryRun: true, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(r.dryRun).toBe(true);
    expect(a.asked).toEqual([]);
    expect(rt.calls).toEqual([]);
    expect(existsSync(env.home) ? allFiles(env.home) : []).toEqual([]);
    expect(existsSync(repoPaths(repo).dir)).toBe(false);
    expect(r.steps.slice(1).every((s) => s.status === 'planned')).toBe(true);
    expect(formatSetup(r)).toContain('Setup plan');
  });

  it('refuses to run without prompts unless --yes or --dry-run', async () => {
    const repo = makeRepo(env.root);
    await expect(runSetup({ mode: 'independent', path: repo, yes: false, runtime: fakeRuntime().runtime, dockerProbe: dockerUp })).rejects.toBeInstanceOf(MinionsError);
  });

  it('a container failure is reported as a failed step with how to retry', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    rt.runtime.start = async () => { throw new MinionsError('DOCKER_UNAVAILABLE', 'Docker daemon is not reachable.'); };
    const r = await runSetup({ mode: 'independent', path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(step(r, 'container')).toMatchObject({ status: 'failed', detail: 'Docker daemon is not reachable.' });
    expect(r.ready).toBe(false);
    expect(r.steps.some((s) => s.id === 'coordinator')).toBe(false);
  });

  it('host runtime: Telegram is skipped (no plugins there) and the steps name the host runtime', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    rt.runtime.kind = async () => 'host';
    const r = await runSetup({ mode: 'independent', path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, tokens: { telegram: TG_TOKEN } });
    expect(step(r, 'telegram')).toMatchObject({ status: 'skipped', detail: expect.stringContaining('host runtime has no Telegram') });
    expect(await readTelegramToken(r.projectId)).toBeNull();
    expect(r.pairing).toEqual([]);
  });
});
