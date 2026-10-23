import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    generatePlugin: async (cfg: { delivery: { mode: string }; communication: { channel: string } }, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), `delivery ${cfg.delivery.mode} channel ${cfg.communication.channel}\n`);
      return [];
    },
  };
});

const { runSetup, formatSetup, openIntakeFilterWarning } = await import('../../src/host/setup.js');
const { loadCredentialRefs, readGithubToken, readTelegramToken, removeGithubToken } = await import('../../src/host/credentials.js');
const { loadEffectiveConfig, loadProjectJson } = await import('../../src/host/project.js');
const { loadRegistry } = await import('../../src/host/registry.js');
const { projectPaths, repoPaths } = await import('../../src/core/paths.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');
type SetupRuntime = import('../../src/host/setup.js').SetupRuntime;
type SetupResult = import('../../src/host/setup.js').SetupResult;

const GH_TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';
const TG_TOKEN = '123456789:AAHfakefakefakefakefakefakefake_-0123';
const REMOTE = 'https://github.com/acme/demo.git';

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
      return { bundle: '/tmp/b', commit: 'a'.repeat(40), baseBranch: 'main', warnings: [], container: { origin: { url: REMOTE, authenticated: true, fetched: true, warnings: [] } } };
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

/** Fake GitHub API (GET only is asserted). */
function githubApi(opts: { requiredChecks?: string[]; rules?: number } = {}) {
  const seen: { url: string; method: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, method: init?.method ?? 'GET' });
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/rules/branches/')) return res(opts.rules ?? 404, { message: 'Not Found' });
    if (u.includes('/branches/')) return res(200, { protected: !!opts.requiredChecks, protection: { required_status_checks: { enforcement_level: 'everyone', contexts: opts.requiredChecks ?? [] } } });
    if (u.includes('/actions/workflows')) return res(200, { total_count: 0 });
    return res(200, { full_name: 'acme/demo', permissions: { push: true } });
  }) as typeof fetch;
  return { f, seen };
}

function githubRepo(name?: string): string {
  const repo = makeRepo(env.root, name);
  git(repo, 'remote', 'add', 'origin', REMOTE);
  return repo;
}

const step = (r: SetupResult, id: string) => r.steps.find((s) => s.id === id)!;

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe('minions setup', () => {
  it('runs the whole flow end to end: wizard, GitHub + delivery, CI, auto-merge, Telegram, container, import, coordinator', async () => {
    const repo = githubRepo();
    const a = scripted({
      'Installation visibility': 'private',
      'Set up GitHub integration': 'y',
      'Delivery mode': 'pull-request',
      'Use CI?': 'y',
      'Enable auto-merge?': 'y',
      'Set up Telegram': 'y',
    }, [GH_TOKEN, TG_TOKEN]);
    const api = githubApi();
    const rt = fakeRuntime();
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: api.f });

    // Order of the questions: project first, then each integration, then the container.
    const order = ['Starting profile', 'Installation visibility', 'Apply this plan?', 'Set up GitHub integration', 'secret:GitHub token', 'Delivery mode',
      'Use CI?', 'Import GitHub issues into the backlog?', 'Enable auto-merge?', 'Set up Telegram', 'secret:Telegram bot token', 'Check the token with Telegram', 'Build and start the container'];
    const idx = order.map((q) => a.asked.findIndex((x) => x.startsWith(q)));
    expect(idx.every((i) => i >= 0), JSON.stringify(a.asked)).toBe(true);
    expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    // The wizard does not ask the questions setup owns.
    expect(a.asked.some((q) => q.startsWith('Communication channel') || q.startsWith('Store a GitHub token') || q.startsWith('Store the Telegram'))).toBe(false);

    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['init', 'done'], ['github', 'done'], ['delivery', 'changed'], ['ci', 'done'], ['intake', 'skipped'], ['autoMerge', 'done'],
      ['telegram', 'done'], ['container', 'done'], ['import', 'done'], ['coordinator', 'done'],
    ]);
    expect(rt.calls).toEqual(['running?', 'start', 'repo?', 'import', 'coordinator']);
    expect(r.ready).toBe(true);
    expect(await readGithubToken(r.projectId)).toBe(GH_TOKEN);
    expect(await readTelegramToken(r.projectId)).toBe(TG_TOKEN);

    // Choices land in the host-only local layer and in the regenerated plugin/runtime config.
    const paths = projectPaths(r.projectId);
    // communication.channel stays auto (the default): a stored bot token is what turns Telegram on.
    expect(JSON.parse(readFileSync(paths.configLocalJson, 'utf8'))).toEqual({ delivery: { mode: 'pull-request', provider: 'github', merge: 'auto-when-eligible' } });
    const eff = (await loadEffectiveConfig(await loadProjectJson(r.projectId))).config;
    expect(eff.delivery.mode).toBe('pull-request');
    expect(eff.communication.channel).toBe('auto');
    expect(readFileSync(join(paths.pluginDir, 'coordinator.md'), 'utf8')).toBe('delivery pull-request channel auto\n');
    expect(JSON.parse(readFileSync(paths.runtimeConfigJson, 'utf8')).communication.channel).toBe('auto');

    // CI: read-only, plan printed. Auto-merge: opted in (local layer only), with what is still missing; nothing on GitHub.
    expect(api.seen.every((s) => s.method === 'GET')).toBe(true);
    expect(step(r, 'ci').lines!.join('\n')).toContain('Add a CI workflow yourself');
    expect(eff.delivery.merge).toBe('auto-when-eligible');
    expect(step(r, 'autoMerge').lines).toEqual(expect.arrayContaining([expect.stringMatching(/still needed: delivery\.requiredChecksConfigured is false/), expect.stringMatching(/still needed: verification\.ciAuthority/)]));
    expect(a.asked.find((x) => x.startsWith('Enable auto-merge?'))).toBe('Enable auto-merge? (y/n)');
    expect(existsSync(join(repo, '.github'))).toBe(false);

    // Attach and pairing instructions.
    const out = formatSetup(r);
    expect(r.attach).toContain('exec app minions coordinator');
    expect(out).toContain('/telegram:access pair <code>');
    expect(out).toContain('/telegram:access policy allowlist');
    expect(out).toContain('/login');

    // Secrets never appear in the result, its rendering, prompts, notes, or generated files.
    const visible = JSON.stringify(r) + out + a.asked.join('\n') + a.info.join('\n');
    expect(visible).not.toContain(GH_TOKEN);
    expect(visible).not.toContain(TG_TOKEN);
    for (const p of [...allFiles(repo), ...allFiles(paths.pluginDir), paths.configLocalJson, paths.configJson, paths.runtimeConfigJson, paths.composeYaml]) {
      const text = readFileSync(p, 'utf8');
      expect(text, p).not.toContain(GH_TOKEN);
      expect(text, p).not.toContain(TG_TOKEN);
    }
  });

  it('PR-first: with a GitHub remote and a stored token the delivery question defaults to pull-request; local stays selectable', async () => {
    const offered = async (profile: string, answer?: string) => {
      const repo = githubRepo();
      const defaults: Record<string, string> = {};
      const a = scripted({ 'Starting profile': profile, 'Installation visibility': 'private', 'Set up GitHub integration': 'y', ...(answer ? { 'Delivery mode': answer } : {}) }, [GH_TOKEN]);
      const ask = a.io.ask;
      a.io.ask = async (q: string, def: string) => { if (q.startsWith('Delivery mode')) defaults.delivery = def; return ask(q, def); };
      const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp, fetch: githubApi().f });
      const eff = (await loadEffectiveConfig(await loadProjectJson(r.projectId))).config;
      return { def: defaults.delivery, mode: eff.delivery.mode, provider: eff.delivery.provider, info: a.info.join('\n'), r };
    };
    // Accepting the default switches a local project to pull-request delivery (project-owner and personal-work).
    const owner = await offered('1');
    expect(owner).toMatchObject({ def: 'pull-request', mode: 'pull-request', provider: 'github' });
    expect(owner.info).toMatch(/pull-request \(default: push agent\/<slug> and open a PR/);
    expect(step(owner.r, 'delivery')).toMatchObject({ status: 'changed', detail: expect.stringMatching(/local -> pull-request/) });
    env.cleanup(); env = withHome();
    expect(await offered('2')).toMatchObject({ def: 'pull-request', mode: 'pull-request' });
    // Local remains an explicit option.
    env.cleanup(); env = withHome();
    expect(await offered('1', 'local')).toMatchObject({ def: 'pull-request', mode: 'local', provider: 'none' });
  });

  it('without a GitHub remote setup never offers pull-request delivery and stays local', async () => {
    const repo = makeRepo(env.root);
    const a = scripted({ 'Installation visibility': 'private' });
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(a.asked.some((q) => q.startsWith('Delivery mode'))).toBe(false);
    expect((await loadEffectiveConfig(await loadProjectJson(r.projectId))).config.delivery.mode).toBe('local');
  });

  it('asks "Enable auto-merge?" with pull-request delivery, default no: accepting the default writes nothing for merge', async () => {
    const repo = githubRepo();
    const a = scripted({ 'Installation visibility': 'private', 'Set up GitHub integration': 'y', 'Delivery mode': 'pull-request' }, [GH_TOKEN]);
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(a.asked).toContain('Enable auto-merge? (y/n)');
    expect(step(r, 'autoMerge')).toMatchObject({ status: 'skipped', detail: 'auto-merge not enabled' });
    expect(JSON.parse(readFileSync(projectPaths(r.projectId).configLocalJson, 'utf8')).delivery.merge).toBeUndefined();
    expect((await loadEffectiveConfig(await loadProjectJson(r.projectId))).config.delivery.merge).toBe('disabled');
  });

  it('asks each optional integration with default no; declining skips cleanly with a note on enabling later', async () => {
    const repo = githubRepo();
    const a = scripted({ 'Installation visibility': 'private' });
    const rt = fakeRuntime();
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    const q = (p: string) => a.asked.find((x) => x.startsWith(p));
    expect(q('Set up GitHub integration')).toBeDefined();
    expect(q('Use CI?')).toBeDefined();
    expect(q('Import GitHub issues into the backlog?')).toContain('(y/n)');
    expect(q('Issue labels to import')).toBeUndefined();
    // Auto-merge needs pull-request delivery; with local delivery it is not asked.
    expect(q('Enable auto-merge?')).toBeUndefined();
    expect(q('Set up Telegram')).toBeDefined();
    expect(q('Delivery mode')).toBeUndefined();
    expect(a.asked.some((x) => x.startsWith('secret:'))).toBe(false);
    for (const id of ['github', 'ci', 'intake', 'telegram']) {
      expect(step(r, id).status).toBe('skipped');
      expect(step(r, id).later).toMatch(/minions setup/);
    }
    expect(step(r, 'autoMerge')).toMatchObject({ status: 'skipped', later: expect.stringMatching(/minions setup/) });
    expect(r.localConfig.changed).toEqual([]);
    expect(existsSync(projectPaths(r.projectId).configLocalJson)).toBe(false);
    const rp = r.init.plan.repoPath;
    expect(formatSetup(r)).toContain(`later: Run \`minions setup ${rp}\` again (or \`cd ${rp} && minions auth github\`)`);
    // Core steps default to yes.
    expect(rt.calls).toContain('start');
    expect(step(r, 'coordinator').status).toBe('done');
  });

  it('GitHub intake: the question defaults to no; yes records the filter in config.local.json (read-only import, no GitHub calls at setup)', async () => {
    const repo = githubRepo();
    const defaults = scripted({ 'Installation visibility': 'private' });
    const prompts: { q: string; def: string }[] = [];
    const io = { ...defaults.io, ask: async (q: string, def: string) => { prompts.push({ q, def }); return defaults.io.ask(q, def); } };
    const rt = fakeRuntime();
    const first = await runSetup({ path: repo, yes: false, io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(prompts.find((p) => p.q.startsWith('Import GitHub issues into the backlog?'))!.def).toBe('n');
    expect(step(first, 'intake')).toMatchObject({ status: 'skipped', later: expect.stringMatching(/minions setup/) });
    expect((await loadEffectiveConfig(await loadProjectJson(first.projectId))).config.intake.github).toBeUndefined();

    const api = githubApi();
    const a = scripted({
      'Import GitHub issues into the backlog?': 'y', 'Issue labels to import': 'bug, minions', 'Assignee filter': 'octocat',
      'Milestone filter': 'v1', 'Issue state': 'open',
    });
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: api.f });
    expect(step(r, 'intake')).toMatchObject({ status: 'done', detail: expect.stringContaining('labels bug,minions') });
    expect(r.localConfig.changed).toContain('intake.github');
    const eff = (await loadEffectiveConfig(await loadProjectJson(r.projectId))).config;
    expect(eff.intake.github).toEqual({ enabled: true, repository: null, labels: ['bug', 'minions'], assignee: 'octocat', milestone: 'v1', state: 'open' });
    expect(api.seen.every((c) => c.method === 'GET')).toBe(true);
    expect(api.seen.some((c) => c.url.includes('/issues'))).toBe(false);
    expect(step(r, 'intake').lines ?? []).toEqual([]); // labels and an assignee: no open-filter warning

    // task-39: a filter anyone can satisfy (no labels, no assignee) is accepted with a warning.
    const open = scripted({
      'Import GitHub issues into the backlog?': 'y', 'Issue labels to import': 'none', 'Assignee filter': 'any', 'Milestone filter': 'any', 'Issue state': 'open',
    });
    const o = await runSetup({ path: repo, yes: false, io: open.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(step(o, 'intake')).toMatchObject({ status: 'changed', lines: [expect.stringMatching(/^warning: the intake filter has no labels and no assignee: on a public repository anyone/)] });
    expect(formatSetup(o)).toContain('no labels and no assignee');
    // Non-interactive rerun keeps it and still warns.
    const kept = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(step(kept, 'intake')).toMatchObject({ status: 'kept', lines: [expect.stringContaining('anyone can open an issue')] });

    // Rerun: the question now defaults to the recorded "yes"; answering no disables it (tasks are kept).
    const b = scripted({ 'Import GitHub issues into the backlog?': 'n' });
    const off = await runSetup({ path: repo, yes: false, io: b.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(step(off, 'intake')).toMatchObject({ status: 'changed', detail: expect.stringContaining('disabled') });
    expect((await loadEffectiveConfig(await loadProjectJson(off.projectId))).config.intake.github?.enabled).toBe(false);
  });

  it('openIntakeFilterWarning: only a filter with no labels, no assignee and no milestone restriction warns (task-39)', () => {
    const f = { enabled: true, repository: null, labels: [] as string[], assignee: null as string | null, milestone: null as string | null, state: 'open' as const };
    expect(openIntakeFilterWarning(f)).toMatch(/anyone can open an issue/);
    expect(openIntakeFilterWarning({ ...f, assignee: 'none' })).toMatch(/anyone/); // unassigned is what strangers file
    expect(openIntakeFilterWarning({ ...f, milestone: 'none' })).toMatch(/anyone/);
    expect(openIntakeFilterWarning({ ...f, labels: ['minions'] })).toBeNull();
    expect(openIntakeFilterWarning({ ...f, assignee: 'octocat' })).toBeNull();
    expect(openIntakeFilterWarning({ ...f, assignee: '*' })).toBeNull();
    expect(openIntakeFilterWarning({ ...f, milestone: 'v1' })).toBeNull();
  });

  it('every printed command names the repository (shell-quoted), so it works from any directory', async () => {
    const repo = makeRepo(env.root, "my repo's dir");
    const r = await runSetup({ path: repo, yes: true, runtime: fakeRuntime().runtime, dockerProbe: dockerUp, tokens: { github: GH_TOKEN } });
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
    // The piped GitHub token cannot be used without a github.com origin; the summary says so.
    expect(step(r, 'github').detail).toContain('the token piped with --github-token-stdin was not used');
    expect(step(r, 'github').later).toContain(`\`minions setup ${q}\``);
    expect(JSON.stringify(r) + out).not.toContain(GH_TOKEN);
  });

  it('declining the container step says how to start later from any directory', async () => {
    const repo = makeRepo(env.root);
    const r = await runSetup({ path: repo, yes: false, io: scripted({ 'Installation visibility': 'private', 'Build and start the container': 'n' }).io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp });
    const rp = r.init.plan.repoPath;
    expect(step(r, 'container').later).toBe(`Run \`minions setup ${rp}\` again or \`cd ${rp} && minions start\` to start the container and attach the coordinator.`);
    expect(r.nextSteps[0]).toBe(`Run \`cd ${rp} && minions start\` to start the container and attach the coordinator.`);
  });

  it('declining the container step leaves Docker untouched and says how to start later', async () => {
    const repo = makeRepo(env.root);
    const a = scripted({ 'Installation visibility': 'private', 'Build and start the container': 'n' });
    const rt = fakeRuntime();
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(rt.calls).toEqual([]);
    expect(step(r, 'container')).toMatchObject({ status: 'skipped', later: expect.stringContaining('minions start') });
    expect(step(r, 'github')).toMatchObject({ status: 'skipped', detail: expect.stringContaining('no github.com origin') });
    expect(r.attach).toBeNull();
  });

  it('rerun is idempotent: detects config, credentials and container and offers keep/change without duplicating state', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const first = await runSetup({
      path: repo, yes: false, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f,
      io: scripted({ 'Installation visibility': 'private', 'Set up GitHub integration': 'y', 'Delivery mode': 'branch', 'Set up Telegram': 'y' }, [GH_TOKEN, TG_TOKEN]).io,
    });
    const paths = projectPaths(first.projectId);
    const snapshot = () => [paths.manifestJson, paths.configLocalJson, paths.configJson, join(paths.dir, 'credentials.json')]
      .map((p) => (existsSync(p) ? readFileSync(p, 'utf8') : null));
    const before = snapshot();
    const refsBefore = await loadCredentialRefs(first.projectId);

    const a = scripted();
    rt.calls.length = 0;
    const again = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(again.projectId).toBe(first.projectId);
    expect(again.rerun).toBe(true);
    expect(a.asked.find((q) => q.startsWith('Project configuration: keep it or change it?'))).toBeDefined();
    expect(a.asked.find((q) => q.startsWith('A GitHub token is stored'))).toContain('keep/change/remove');
    expect(a.asked.find((q) => q.startsWith('Telegram is set up'))).toContain('keep/change/disable');
    expect(a.asked.some((q) => q.startsWith('secret:') || q.startsWith('Starting profile') || q.startsWith('Apply this plan?'))).toBe(false);
    expect(again.steps.filter((s) => ['init', 'github', 'delivery', 'telegram', 'container', 'import', 'coordinator'].includes(s.id)).map((s) => s.status))
      .toEqual(['kept', 'kept', 'kept', 'kept', 'kept', 'kept', 'kept']);
    expect(again.init.applied!.written).toEqual([]);
    expect(again.localConfig.changed).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(await loadCredentialRefs(first.projectId)).toEqual(refsBefore);
    expect(Object.keys((await loadRegistry()).projects)).toEqual([first.projectId]);
    expect(rt.calls).not.toContain('import');
  });

  it('every printed command in the kept, blocked, remove and import branches also names the repository', async () => {
    const repo = githubRepo("my repo's dir");
    const rt = fakeRuntime();
    const first = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, tokens: { github: GH_TOKEN, telegram: TG_TOKEN }, delivery: 'branch', visibility: 'private', fetch: githubApi().f });
    const q = `'${first.init.plan.repoPath.replace(/'/g, `'\\''`)}'`;
    const inRepo = (c: string) => `\`cd ${q} && ${c}\``;
    const check = (r: Awaited<ReturnType<typeof runSetup>>) => {
      for (const m of formatSetup(r).matchAll(/\`([^\`]*minions [^\`]*)\`/g)) {
        expect(m[1]!.startsWith(`cd ${q} && `) || m[1] === `minions setup ${q}`, m[1]).toBe(true);
      }
    };
    // kept github + kept import + telegram disabled (token kept)
    const kept = await runSetup({ path: repo, yes: false, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f,
      io: scripted({ 'A GitHub token is stored': 'keep', 'Telegram is set up': 'disable' }).io });
    expect(step(kept, 'github').detail).toContain(inRepo('minions auth github'));
    expect(step(kept, 'import').detail).toContain(inRepo('minions import'));
    expect(step(kept, 'telegram').detail).toContain(inRepo('minions auth telegram --remove'));
    check(kept);
    // token gone (removed outside setup) on a branch-delivery project: delivery is kept but cannot publish
    await removeGithubToken(first.projectId);
    const blocked = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(step(blocked, 'delivery').detail).toContain(`cannot publish`);
    expect(step(blocked, 'delivery').detail).toContain(inRepo('minions doctor'));
    check(blocked);
  });

  it('every printed command in the intake, auto-merge, CI and dry-run branches also names the repository', async () => {
    const repo = githubRepo("my repo's dir");
    const rt = fakeRuntime();
    const a = scripted({ 'Installation visibility': 'private', 'Set up GitHub integration': 'n', 'Delivery mode': 'pull-request', 'Use CI?': 'y', 'Import GitHub issues into the backlog?': 'y', 'Enable auto-merge?': 'y' });
    // token piped in: pull-request delivery, CI step reads required checks (none), auto-merge not usable yet
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp, tokens: { github: GH_TOKEN }, fetch: githubApi().f });
    const q = `'${r.init.plan.repoPath.replace(/'/g, `'\\''`)}'`;
    const inRepo = (c: string) => `\`cd ${q} && ${c}\``;
    const check = (text: string) => {
      for (const m of text.matchAll(/\`([^\`]*minions [^\`]*)\`/g)) {
        expect(m[1]!.startsWith(`cd ${q} && `) || m[1] === `minions setup ${q}`, m[1]).toBe(true);
      }
    };
    // The wizard's own plan text (before the integration steps) is not part of the setup steps.
    const stepInfo = (info: string[]) => info.slice(info.findIndex((l) => l.includes('minions can import GitHub issues'))).join('\n');
    check(stepInfo(a.info) + '\n' + formatSetup(r));
    expect(a.info.join('\n')).toContain(inRepo('minions sync'));
    expect(a.info.join('\n')).toContain(inRepo('minions work approve <taskId> --head <sha> --merge'));
    expect(a.info.join('\n')).toContain(inRepo('minions doctor'));
    expect(step(r, 'intake').detail).toContain(inRepo('minions sync'));
    expect(step(r, 'autoMerge').detail).toContain(inRepo('minions doctor'));
    // declining auto-merge on a project that has it on
    const off = scripted({ 'Enable auto-merge?': 'n' });
    const r2 = await runSetup({ path: repo, yes: false, io: off.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(step(r2, 'autoMerge').detail).toContain(inRepo('minions sync'));
    check(formatSetup(r2));
    // dry run
    const repo3 = githubRepo("my repo's dir 3");
    const d = await runSetup({ path: repo3, yes: false, dryRun: true, io: scripted().io, runtime: rt.runtime, dockerProbe: dockerUp });
    const q3 = `'${d.init.plan.repoPath.replace(/'/g, `'\\''`)}'`;
    expect(step(d, 'intake').detail).toContain(`\`cd ${q3} && minions sync\``);
    const planned = formatSetup(d); // the init plan above the setup plan is shared with `minions init`
    for (const m of planned.slice(planned.indexOf('Setup plan')).matchAll(/\`([^\`]*minions [^\`]*)\`/g)) {
      expect(m[1]!.startsWith(`cd ${q3} && `) || m[1] === `minions setup ${q3}`, m[1]).toBe(true);
    }
  });

  it('rerun with "change" reruns the wizard with the existing values as defaults; integrations can be changed or disabled', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const first = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, tokens: { github: GH_TOKEN, telegram: TG_TOKEN }, delivery: 'branch', visibility: 'private', fetch: githubApi().f });
    expect(step(first, 'telegram').status).toBe('done');
    const a = scripted({
      'Project configuration: keep it or change it?': 'change',
      'Start ready tasks automatically?': 'n',
      'A GitHub token is stored': 'remove',
      'Telegram is set up': 'disable',
    });
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f });
    expect(a.asked.find((q) => q.startsWith('Starting profile'))).toBeDefined();
    expect(a.asked.some((q) => q.startsWith('Installation visibility'))).toBe(false); // visibility stays as installed
    expect(step(r, 'init').status).toBe('changed');
    expect(step(r, 'github')).toMatchObject({ status: 'changed', detail: expect.stringContaining('token removed') });
    expect(step(r, 'delivery')).toMatchObject({ status: 'changed', detail: expect.stringContaining('branch -> local') });
    expect(step(r, 'telegram').status).toBe('changed');
    expect(await readGithubToken(r.projectId)).toBeNull();
    expect(await readTelegramToken(r.projectId)).toBe(TG_TOKEN); // disabling keeps the token
    const eff = (await loadEffectiveConfig(await loadProjectJson(r.projectId))).config;
    expect(eff.intake.startReady).toBe(false);
    expect(eff.delivery.mode).toBe('local');
    expect(eff.communication.channel).toBe('terminal');
  });

  it('--yes uses defaults: optional integrations off, core steps on, no prompts', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const r = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(r.steps.map((s) => [s.id, s.status])).toEqual([
      ['init', 'done'], ['github', 'skipped'], ['delivery', 'kept'], ['ci', 'skipped'], ['intake', 'skipped'], ['autoMerge', 'skipped'],
      ['telegram', 'skipped'], ['container', 'done'], ['import', 'done'], ['coordinator', 'done'],
    ]);
    expect((await loadEffectiveConfig(await loadProjectJson(r.projectId))).config.delivery.mode).toBe('local');
  });

  it('--yes takes tokens from stdin only (never argv) and rejects an unselectable --delivery', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const r = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, delivery: 'pull-request', fetch: githubApi().f });
    expect(step(r, 'delivery')).toMatchObject({ status: 'failed', detail: expect.stringContaining('not selectable (no GitHub token is stored)') });
    const ok = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, delivery: 'pull-request', tokens: { github: GH_TOKEN }, fetch: githubApi().f });
    expect(step(ok, 'github').status).toBe('done');
    expect(step(ok, 'delivery').status).toBe('changed');
    expect(JSON.stringify(ok) + formatSetup(ok)).not.toContain(GH_TOKEN);
  });

  it('an invalid token is reported as failed, nothing is stored, and the rest of setup continues', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const a = scripted({ 'Installation visibility': 'private', 'Set up Telegram': 'y' }, ['not-a-token']);
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(step(r, 'telegram')).toMatchObject({ status: 'failed', later: expect.stringContaining('minions auth telegram') });
    expect(JSON.stringify(step(r, 'telegram'))).not.toContain('not-a-token');
    expect((await loadCredentialRefs(r.projectId)).telegram).toBeUndefined();
    expect(existsSync(projectPaths(r.projectId).configLocalJson)).toBe(false);
    expect(step(r, 'coordinator').status).toBe('done');
  });

  it('CI: reports configured required checks without changing anything; unknown checks are not treated as none', async () => {
    const repo = githubRepo();
    mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: pull_request\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'ci');
    const rt = fakeRuntime();
    const api = githubApi({ requiredChecks: ['test'] });
    const r = await runSetup({ path: repo, yes: false, runtime: rt.runtime, dockerProbe: dockerUp, fetch: api.f,
      io: scripted({ 'Installation visibility': 'private', 'Set up GitHub integration': 'y', 'Use CI?': 'y' }, [GH_TOKEN]).io });
    expect(step(r, 'ci').detail).toContain('required checks configured');
    expect(step(r, 'ci').lines!.join('\n')).toContain('setup changes neither');
    expect(step(r, 'ci').lines!.join('\n')).toContain('verification.ciAuthority to "github"');
    expect(api.seen.every((s) => s.method === 'GET')).toBe(true);
    expect((await loadEffectiveConfig(await loadProjectJson(r.projectId))).config.delivery.requiredChecksConfigured).toBe(false);

    // Without a token the required checks are unknown: the plan is shown as conditional, never as "none".
    const repo2 = makeRepo(env.root, 'other');
    git(repo2, 'remote', 'add', 'origin', 'https://github.com/acme/other.git');
    const r2 = await runSetup({ path: repo2, yes: false, runtime: fakeRuntime().runtime, dockerProbe: dockerUp,
      io: scripted({ 'Installation visibility': 'private', 'Use CI?': 'y' }).io });
    const lines = step(r2, 'ci').lines!.join('\n');
    expect(lines).toContain('unknown (no GitHub token is stored)');
    expect(lines).toContain('Required checks could not be read');
    expect(existsSync(join(repo2, '.github'))).toBe(false);
  });

  it('--dry-run writes nothing, prompts for nothing, and does not touch the container', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    const a = scripted();
    const r = await runSetup({ path: repo, yes: false, dryRun: true, io: a.io, runtime: rt.runtime, dockerProbe: dockerUp });
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
    await expect(runSetup({ path: repo, yes: false, runtime: fakeRuntime().runtime, dockerProbe: dockerUp })).rejects.toBeInstanceOf(MinionsError);
  });

  it('a container failure is reported as a failed step with how to retry', async () => {
    const repo = makeRepo(env.root);
    const rt = fakeRuntime();
    rt.runtime.start = async () => { throw new MinionsError('DOCKER_UNAVAILABLE', 'Docker daemon is not reachable.'); };
    const r = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp });
    expect(step(r, 'container')).toMatchObject({ status: 'failed', detail: 'Docker daemon is not reachable.' });
    expect(r.ready).toBe(false);
    expect(r.steps.some((s) => s.id === 'coordinator')).toBe(false);
  });

  it('GitHub uses the guided flow: no remote -> adds origin (shown first), pre-filled token link, hidden token; the browser is opened only after a yes', async () => {
    const repo = makeRepo(env.root);
    const opened: string[] = [];
    const a = scripted({
      'Installation visibility': 'private',
      'No GitHub remote. Set up GitHub': 'y',
      'Add a GitHub remote as origin now?': 'y',
      'GitHub repository': 'acme/demo',
      'Open the token page in your browser?': 'n',
      'Push main to origin now?': 'n',
      'Delivery mode': 'pull-request',
    }, [GH_TOKEN]);
    const r = await runSetup({ path: repo, yes: false, io: a.io, runtime: fakeRuntime().runtime, dockerProbe: dockerUp, fetch: githubApi().f,
      platform: 'darwin', openUrl: async (u) => { opened.push(u); } });
    expect(git(repo, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/demo.git');
    expect(step(r, 'github')).toMatchObject({ status: 'done', lines: expect.arrayContaining(['origin added: https://github.com/acme/demo.git']) });
    expect(step(r, 'delivery')).toMatchObject({ status: 'changed', detail: expect.stringContaining('local -> pull-request') });
    expect(opened).toEqual([]);
    expect(a.info.join('\n')).toContain('github.com/settings/personal-access-tokens/new?');
    expect(a.info.join('\n')).toContain('Running: git remote add origin https://github.com/acme/demo.git');
    // setup owns the token decision and the delivery question: the guided flow does not ask them again.
    expect(a.asked.filter((q) => q.startsWith('Store a GitHub token') || q.startsWith('Delivery mode')).length).toBe(1);
    expect(await readGithubToken(r.projectId)).toBe(GH_TOKEN);
    expect(JSON.stringify(r) + a.info.join('\n') + a.asked.join('\n')).not.toContain(GH_TOKEN);
  });

  it('host runtime: Telegram is skipped (no plugins there) and the steps name the host runtime', async () => {
    const repo = githubRepo();
    const rt = fakeRuntime();
    rt.runtime.kind = async () => 'host';
    const r = await runSetup({ path: repo, yes: true, runtime: rt.runtime, dockerProbe: dockerUp, fetch: githubApi().f, tokens: { telegram: TG_TOKEN } });
    expect(step(r, 'telegram')).toMatchObject({ status: 'skipped', detail: expect.stringContaining('host runtime has no Telegram') });
    expect(await readTelegramToken(r.projectId)).toBeNull();
    expect(r.pairing).toEqual([]);
    expect(r.nextSteps.join('\n')).toContain('minions setup assist');
  });
});
