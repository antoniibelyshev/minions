// Guided GitHub setup (init + `minions setup github`): never prompts/pushes/opens with --yes, explicit
// confirmation for remote changes, pushes and the browser, token via the hidden prompt, delivery mode.
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type RunOptions, type RunResult } from '../../src/core/exec.js';

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

const { runInit } = await import('../../src/host/install.js');
const { projectPaths } = await import('../../src/core/paths.js');
const { loadProjectJson, loadEffectiveConfig } = await import('../../src/host/project.js');
const S = await import('../../src/host/github-setup.js');
const C = await import('../../src/host/credentials.js');
const { runDoctor } = await import('../../src/host/doctor.js');
const { dockerDown, dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789';
const REMOTE = 'https://github.com/acme/demo.git';

let env: ReturnType<typeof withHome>;
let prevStore: string | undefined;
beforeEach(() => { env = withHome(); prevStore = process.env.MINIONS_CREDENTIAL_STORE; process.env.MINIONS_CREDENTIAL_STORE = 'file'; });
afterEach(() => {
  if (prevStore === undefined) delete process.env.MINIONS_CREDENTIAL_STORE; else process.env.MINIONS_CREDENTIAL_STORE = prevStore;
  env.cleanup();
});

const okFetch = (async () => new Response(JSON.stringify({ full_name: 'acme/demo', permissions: { push: true } }), { status: 200 })) as unknown as typeof fetch;

/** Real git for inspection; push/open/security are intercepted and recorded (never executed). */
function guardedRunner() {
  const calls: string[][] = [];
  const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
    calls.push([cmd, ...args]);
    if (cmd === 'open' || cmd === 'security' || cmd === 'gh') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args.includes('push')) return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args.includes('ls-remote')) throw new Error('no network access in tests');
    return run(cmd, args, opts);
  };
  return { calls, runner };
}

function scripted(answers: Record<string, string>, secrets: string[] = []) {
  const asked: string[] = [];
  const info: string[] = [];
  return {
    asked, info,
    io: {
      ask: async (q: string, def: string) => { asked.push(q); const k = Object.keys(answers).find((a) => q.startsWith(a)); return k !== undefined ? answers[k]! : def; },
      info: (l: string) => info.push(l),
      secret: async (p: string) => { asked.push(`secret:${p}`); return secrets.shift() ?? ''; },
    },
  };
}

describe('token link', () => {
  it('pre-fills the fine-grained token page (GitHub template URL parameters)', () => {
    const u = new URL(S.githubTokenUrl(REMOTE));
    expect(u.origin + u.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      name: 'minions demo', target_name: 'acme', expires_in: '90', contents: 'write', pull_requests: 'write', actions: 'read', statuses: 'read',
    });
    expect(u.searchParams.get('name')!.length).toBeLessThanOrEqual(40);
    expect(u.searchParams.get('description')).toContain('acme/demo only');
    expect(S.githubTokenUrl(null)).toBe('https://github.com/settings/personal-access-tokens/new');
    const steps = S.githubTokenSteps(REMOTE).join('\n');
    expect(steps).toContain('Only select repositories" -> acme/demo');
    expect(steps).toContain('Pull requests: Read and write');
  });

  it('parses owner/repo, https and scp forms; rejects others', () => {
    expect(S.parseGithubRepoInput('acme/demo')).toBe(REMOTE);
    expect(S.parseGithubRepoInput('https://github.com/acme/demo')).toBe(REMOTE);
    expect(S.parseGithubRepoInput('git@github.com:acme/demo.git')).toBe(REMOTE);
    expect(() => S.parseGithubRepoInput('https://gitlab.com/acme/demo')).toThrow();
    expect(() => S.parseGithubRepoInput('acme/demo; rm -rf /')).toThrow();
  });
});

describe('non-interactive (--yes)', () => {
  it('init --yes never prompts, pushes or opens a browser; prints next-step hints', async () => {
    const repo = makeRepo(env.root);
    const g = guardedRunner();
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp, runner: g.runner });
    expect(r.github).toBeUndefined();
    expect(r.githubSetup).toMatchObject({ interactive: false, remote: { status: 'missing' } });
    expect(r.nextSteps.join('\n')).toMatch(/No GitHub remote: add one .*minions setup github/);
    expect(g.calls.some((c) => c[0] === 'open' || c.includes('push') || c.includes('remote') && c.includes('add'))).toBe(false);

    git(repo, 'remote', 'add', 'origin', REMOTE);
    const s = await S.runGithubSetup({ projectId: r.plan.projectId, repoPath: repo, yes: true, runner: g.runner });
    expect(s.nextSteps.join('\n')).toContain('git push -u origin main');
    expect(s.nextSteps.join('\n')).toContain('personal-access-tokens/new?');
    expect(g.calls.some((c) => c[0] === 'open' || c.includes('push'))).toBe(false);
  });
});

describe('interactive guided flow', () => {
  it('adds a GitHub remote, shows the push command (declined by default), stores the token, sets pull-request delivery', async () => {
    const repo = makeRepo(env.root);
    const g = guardedRunner();
    const opened: string[] = [];
    const a = scripted({ 'GitHub repository': 'acme/demo' }, [TOKEN]);
    const r = await runInit({ path: repo, io: a.io, visibility: 'private', dockerProbe: dockerUp, runner: g.runner, fetch: okFetch, openUrl: async (u) => { opened.push(u); } });
    expect(git(repo, 'remote', 'get-url', 'origin')).toBe(REMOTE);
    expect((await loadProjectJson(r.plan.projectId)).remoteUrl).toBe(REMOTE);
    expect(r.githubSetup).toMatchObject({ remote: { status: 'added' }, base: { onRemote: false, pushed: false, command: 'git push -u origin main' } });
    expect(a.info.join('\n')).toContain('Command: git push -u origin main');
    expect(g.calls.some((c) => c.includes('push'))).toBe(false);
    expect(opened).toEqual([]); // the browser question defaults to no
    expect(r.github).toMatchObject({ status: 'stored' });
    expect(await C.readGithubToken(r.plan.projectId)).toBe(TOKEN);
    const eff = await loadEffectiveConfig(await loadProjectJson(r.plan.projectId));
    expect(eff.config.delivery).toMatchObject({ mode: 'pull-request', provider: 'github' });
    expect(eff.config.configRevision).toBe(2);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(a.asked.indexOf('Set up GitHub for this project now? (y/n)')).toBeGreaterThan(-1);
  });

  it('push and browser only after an explicit yes', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', REMOTE);
    const init = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const g = guardedRunner();
    const opened: string[] = [];
    const a = scripted({ 'Push main': 'y', 'Open the token page': 'y', 'Store a GitHub token': 'n' });
    const s = await S.runGithubSetup({ projectId: init.plan.projectId, repoPath: repo, io: a.io, runner: g.runner, openUrl: async (u) => { opened.push(u); }, skipIntro: true });
    expect(g.calls.filter((c) => c.includes('push'))).toEqual([['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-pager', 'push', '-u', 'origin', 'refs/heads/main:refs/heads/main']]);
    expect(s.base.pushed).toBe(true);
    expect(opened).toEqual([S.githubTokenUrl(REMOTE)]);
    expect(s.token.status).toBe('skipped');
    expect(a.asked.some((q) => q.startsWith('secret:'))).toBe(false);
  });

  it('declining the intro changes nothing', async () => {
    const repo = makeRepo(env.root);
    const g = guardedRunner();
    const a = scripted({ 'Set up GitHub': 'n' });
    const r = await runInit({ path: repo, io: a.io, visibility: 'private', dockerProbe: dockerUp, runner: g.runner });
    expect(r.githubSetup?.nextSteps.join(' ')).toMatch(/skipped; run `minions setup github`/);
    expect(git(repo, 'remote')).toBe('');
  });

  it('an edited project config is not rewritten; instructions instead', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', REMOTE);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const file = projectPaths(r.plan.projectId).configJson;
    writeFileSync(file, readFileSync(file, 'utf8').replace('"configRevision": 1', '"configRevision": 7'));
    const out = await S.setDeliveryMode(await loadProjectJson(r.plan.projectId), 'pull-request');
    expect(out).toMatchObject({ changed: false, note: expect.stringMatching(/edited since minions generated it; set "delivery"/) });
  });
});

describe('doctor and start hints', () => {
  it('doctor has a github.setup check with an actionable next step', async () => {
    const repo = makeRepo(env.root);
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const doc1 = await runDoctor({ cwd: repo, probe: dockerDown, runner: guardedRunner().runner, fetch: okFetch });
    expect(doc1.checks.find((c) => c.name === 'github.setup')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/no GitHub remote/), hint: expect.stringMatching(/minions setup github/) });
    git(repo, 'remote', 'add', 'origin', REMOTE);
    const doc2 = await runDoctor({ cwd: repo, probe: dockerDown, runner: guardedRunner().runner, fetch: okFetch });
    expect(doc2.checks.find((c) => c.name === 'github.setup')).toMatchObject({ status: 'warn', hint: expect.stringMatching(/minions setup github/) });
  });

  it('start prints one hint line only when a GitHub remote exists without a token', async () => {
    const repo = makeRepo(env.root);
    git(repo, 'remote', 'add', 'origin', REMOTE);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const p = await loadProjectJson(r.plan.projectId);
    expect(await S.githubStartHint(p)).toMatch(/^hint: .*minions setup github/);
    await C.provisionGithubToken({ projectId: p.projectId, token: TOKEN, repoPath: repo, remoteUrl: REMOTE, verify: false });
    expect(await S.githubStartHint(p)).toBeNull();
    expect(await S.githubStartHint({ ...p, remoteUrl: null })).toBeNull();
  });
});
