// Host runtime (no Docker): path resolution, host-only selection (repository config cannot set it),
// the warning, settings hardening, and command delegation in both runtimes. No real tmux/claude/docker.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';

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

const { runInit, formatInit } = await import('../../src/host/install.js');
const { hostRuntimePaths, projectPaths, repoPaths } = await import('../../src/core/paths.js');
const { runtimePaths } = await import('../../src/runtime/paths.js');
const { requireMode, runtimeMode } = await import('../../src/core/cli-helpers.js');
const { validateConfig } = await import('../../src/config/resolve.js');
const { loadEffectiveConfig, loadProjectJson } = await import('../../src/host/project.js');
const { saveDefaults } = await import('../../src/host/auth.js');
const {
  HOST_RUNTIME_WARNING, HostRuntime, hostRuntimeEnv, hostTools, minionsShim, prepareHostRuntime,
} = await import('../../src/host/runtime.js');
const { runRuntimeSet, runRuntimeShow } = await import('../../src/host/runtime-cli.js');
const { delegateToRuntime } = await import('../../src/host/delegate.js');
const { coordinatorSettings, buildClaudeCommand, buildCoordinatorCommand, hostSettings } = await import('../../src/runtime/coordinator.js');
const { runDoctor } = await import('../../src/host/doctor.js');
const { runUninstall } = await import('../../src/host/uninstall.js');
const { defaults } = await import('../helpers.js');
const { dockerDown, dockerUp, git, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
const saved = { ...process.env };
beforeEach(() => { env = withHome(); });
afterEach(() => {
  env.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const no: RunResult = { code: 127, stdout: '', stderr: 'not found' };

async function hostProject(extra: Parameters<typeof runInit>[0] extends infer T ? Partial<T> : never = {}) {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown, ...extra });
  return { repo, r, id: r.plan.projectId };
}

describe('runtime path resolution', () => {
  it('container defaults, env overrides for the host runtime', () => {
    const c = runtimePaths({});
    expect(c).toMatchObject({ state: '/state', workspace: '/workspace', repo: '/workspace/repo', pluginDir: '/opt/minions/plugin',
      coordinatorPrompt: '/opt/minions/plugin/coordinator.md', githubTokenFile: '/opt/minions/secrets/github-token', tmuxSocket: null });
    const h = runtimePaths({ MINIONS_RUNTIME: 'host', MINIONS_STATE_DIR: '/h/state', MINIONS_WORKSPACE: '/h/ws', MINIONS_SECRETS_DIR: '/h/sec dir',
      MINIONS_PLUGIN_DIR: '/h/plugin', MINIONS_TMUX_SOCKET: 'minions-abc', MINIONS_CONFIG: '/h/cfg.json' });
    expect(h).toMatchObject({ db: '/h/state/minions.db', backlog: '/h/state/backlog', repo: '/h/ws/repo', worktrees: '/h/ws/worktrees',
      configJson: '/h/cfg.json', pluginDir: '/h/plugin', coordinatorPrompt: '/h/plugin/coordinator.md',
      githubTokenFile: '/h/sec dir/github-token', apiKeyFile: '/h/sec dir/anthropic-api-key', tmuxSocket: 'minions-abc' });
  });

  it('host runtime env points every runtime path at <project>/host and drops tokens', async () => {
    const { id } = await hostProject();
    const project = await loadProjectJson(id);
    const e = hostRuntimeEnv(project, { PATH: '/usr/bin:/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', TMUX: '/tmp/t', MINIONS_RUNTIME: 'container', HOME: '/Users/u' });
    const hp = hostRuntimePaths(id);
    expect(runtimePaths(e)).toMatchObject({ state: hp.state, workspace: hp.workspace, repo: hp.repo, configJson: projectPaths(id).runtimeConfigJson,
      pluginDir: projectPaths(id).pluginDir, secretsDir: projectPaths(id).secretsDir, tmuxSocket: hp.tmuxSocket });
    expect(e.MINIONS_RUNTIME).toBe('host');
    expect(runtimeMode(e)).toBe('host-runtime');
    expect(e.PATH).toBe(`${hp.bin}:/usr/bin:/bin`);
    for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'TMUX']) expect(e).not.toHaveProperty(k);
    expect(e.CLAUDE_CONFIG_DIR).toBeUndefined(); // login reuses the user's own Claude Code login
    expect(e.MINIONS_GIT_CREDENTIAL_HELPER).toBe(`!${hp.minionsShim.includes(' ') ? `'${hp.minionsShim}'` : hp.minionsShim} git-credential`);
  });

  it('modes: host-runtime may run runtime commands, never host-control commands', () => {
    process.env.MINIONS_RUNTIME = 'host';
    expect(runtimeMode()).toBe('host-runtime');
    expect(() => requireMode('runtime')).not.toThrow();
    expect(() => requireMode('host')).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RUNTIME' }));
    delete process.env.MINIONS_RUNTIME;
    expect(() => requireMode('runtime')).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RUNTIME' }));
  });
});

describe('runtime selection is host-controlled', () => {
  it('repository config cannot select the host runtime (strict schema)', async () => {
    expect(() => validateConfig({ ...defaults(), runtime: 'host' }, 'x')).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'shared', dockerProbe: dockerUp });
    const shared = repoPaths(repo).configJson;
    writeFileSync(shared, JSON.stringify({ ...JSON.parse(readFileSync(shared, 'utf8')), runtime: 'host' }));
    const project = await loadProjectJson(r.plan.projectId);
    expect(project.runtime).toBeUndefined();
    await expect(loadEffectiveConfig(project)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(runInit({ path: repo, yes: true, dockerProbe: dockerUp })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('init --runtime host needs no Docker, records the runtime in project.json, and warns', async () => {
    const { r, id } = await hostProject();
    expect(r.plan.runtime).toBe('host');
    expect((await loadProjectJson(id)).runtime).toBe('host');
    expect(r.plan.warnings.join('\n')).toMatch(/agents run as your macOS user/);
    const text = formatInit(r);
    for (const l of HOST_RUNTIME_WARNING) expect(text).toContain(l);
    expect(r.plan.externalSetup.join('\n')).toMatch(/tmux, claude .* backlog/);
    // the docker runtime still refuses without Docker
    await expect(runInit({ path: makeRepo(env.root, 'other'), yes: true, visibility: 'private', dockerProbe: dockerDown }))
      .rejects.toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
  });

  it('a global default of host is never inherited by a non-interactive init; the wizard asks with the typed word', async () => {
    await saveDefaults({ runtime: 'host' });
    const repo = makeRepo(env.root);
    const r = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    expect(r.plan.runtime).toBe('docker');
    expect(r.plan.notes.join(' ')).toMatch(/never inherits it/);
    await runUninstall({ cwd: repo, yes: true, runner: async () => no });
    const asked: string[] = [];
    const io = { info: () => undefined, ask: async (q: string, def: string) => { asked.push(`${q}=${def}`); return q.startsWith('Type "host"') ? 'host' : q.startsWith('Apply this plan') ? 'y' : def; } };
    const r2 = await runInit({ path: repo, io, dockerProbe: dockerDown, visibility: 'private' });
    expect(r2.plan.runtime).toBe('host');
    expect(asked.some((a) => a.startsWith('Agent runtime (docker/host)=host'))).toBe(true);
    expect(r2.plan.warnings.join('\n')).toMatch(/Use Docker for untrusted repositories/);
  });

  it('--runtime host: non-interactive needs --yes; interactive needs the typed word', async () => {
    const repo = makeRepo(env.root);
    await expect(runInit({ path: repo, visibility: 'private', runtime: 'host', dockerProbe: dockerDown })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/needs confirmation/) });
    const io = (typed: string) => ({ info: () => undefined, ask: async (q: string, def: string) => (q.startsWith('Type "host"') ? typed : q.startsWith('Apply this plan') ? 'y' : def) });
    const r1 = await runInit({ path: repo, io: io('no'), visibility: 'private', runtime: 'host', dockerProbe: dockerUp });
    expect(r1.plan.runtime).toBe('docker');
    await runUninstall({ cwd: repo, yes: true, runner: async () => no });
    const r2 = await runInit({ path: repo, io: io('host'), visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    expect(r2.plan.runtime).toBe('host');
  });

  it('wizard: host needs the typed word, anything else keeps docker', async () => {
    const repo = makeRepo(env.root);
    const mk = (typed: string) => {
      const info: string[] = [];
      return { info, io: { info: (l: string) => info.push(l), ask: async (q: string, def: string) =>
        q.startsWith('Agent runtime') ? 'host' : q.startsWith('Type "host"') ? typed : q.startsWith('Apply this plan') ? 'y' : def } };
    };
    const a = mk('nope');
    const r1 = await runInit({ path: repo, io: a.io, dockerProbe: dockerUp, visibility: 'private' });
    expect(r1.plan.runtime).toBe('docker');
    expect(a.info.join('\n')).toContain(HOST_RUNTIME_WARNING[1]);
    expect(r1.plan.notes.join(' ')).toMatch(/not confirmed/);
    const b = mk('host');
    await runUninstall({ cwd: repo, yes: true, runner: async () => no });
    const r2 = await runInit({ path: repo, io: b.io, dockerProbe: dockerDown, visibility: 'private' });
    expect(r2.plan.runtime).toBe('host');
  });

  it('runtime set host: warning always, typed confirmation or --yes, refuses while running', async () => {
    const repo = makeRepo(env.root);
    const { plan } = await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const warned: string[][] = [];
    const deps = { cwd: repo, warn: (l: string[]) => warned.push(l), isRunning: async () => false };
    await expect(runRuntimeSet('host', {}, { ...deps, ask: async () => null })).rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(runRuntimeSet('host', {}, { ...deps, ask: async () => 'yes' })).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect((await loadProjectJson(plan.projectId)).runtime).toBeUndefined();
    await expect(runRuntimeSet('host', { yes: true }, { ...deps, isRunning: async () => true })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/container is running/) });
    const r = await runRuntimeSet('host', {}, { ...deps, ask: async () => 'host' });
    expect(r).toMatchObject({ from: 'docker', to: 'host', applied: true });
    expect(warned.length).toBeGreaterThanOrEqual(3);
    expect(warned.every((w) => w === HOST_RUNTIME_WARNING)).toBe(true);
    expect((await loadProjectJson(plan.projectId)).runtime).toBe('host');
    expect((await runRuntimeShow({}, { cwd: repo })).warning).toEqual(HOST_RUNTIME_WARNING);
    const back = await runRuntimeSet('docker', {}, { ...deps, ask: async () => { throw new Error('docker needs no confirmation'); } });
    expect(back).toMatchObject({ from: 'host', to: 'docker', applied: true });
    const g = await runRuntimeSet('host', { global: true, yes: true }, deps);
    expect(g).toMatchObject({ scope: 'global', applied: true });
    expect((await runRuntimeShow({ global: true }, { cwd: repo })).runtime).toBe('host');
    await expect(runRuntimeSet('vm', { yes: true }, deps)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});

describe('host runtime coordinator settings', () => {
  const h = { home: '/Users/u', workspace: '/m/host/workspace', state: '/m/host/state', secretsDir: '/m/My Proj/secrets', credentialsDir: '/m/credentials', projectDir: '/m/proj' };

  it('adds the sandbox and credential denies, never bypass; container settings are unchanged', () => {
    const s = coordinatorSettings(defaults(), { auth: 'api-key', host: h, paths: { apiKeyFile: '/m/My Proj/secrets/anthropic-api-key' } }) as {
      permissions: { deny: string[]; disableBypassPermissionsMode: string }; sandbox: Record<string, unknown>; apiKeyHelper: string };
    expect(s.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(s.sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, failIfUnavailable: true });
    expect((s.sandbox.filesystem as { allowWrite: string[] }).allowWrite).toEqual([h.workspace, h.state]);
    expect((s.sandbox.filesystem as { denyRead: string[] }).denyRead).toEqual(expect.arrayContaining(['~/.ssh', '~/.aws', '~/Library/Keychains', h.credentialsDir]));
    expect((s.sandbox.network as { allowedDomains: string[] }).allowedDomains).toContain('github.com');
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Bash(security *)', 'Read(//m/credentials/**)',
      'Read(//m/My Proj/secrets/anthropic-api-key)', 'Read(//m/My Proj/secrets/telegram-bot-token)', 'Edit(//m/proj/*.json)']));
    // no data root derivable from /m/proj: never deny `/` or the home directory
    expect(s.permissions.deny.some((d) => d.startsWith('Read(///'))).toBe(false);
    expect((s.sandbox.filesystem as { denyRead: string[] }).denyRead).not.toContain('/');
    expect(s.apiKeyHelper).toBe("cat '/m/My Proj/secrets/anthropic-api-key'");
    const c = coordinatorSettings(defaults(), { auth: 'api-key', host: null });
    expect(c).not.toHaveProperty('sandbox');
    expect(c.apiKeyHelper).toBe('cat /opt/minions/secrets/anthropic-api-key');
    expect(hostSettings(h).deny.some((d) => d.includes('bypass'))).toBe(false);
  });

  it('host runtime launch: dedicated tmux socket, sandbox in --settings, host prompt note', async () => {
    const dir = env.root;
    mkdirSync(join(dir, 'plugin'), { recursive: true });
    writeFileSync(join(dir, 'plugin', 'coordinator.md'), 'coordinator prompt\n');
    const e = { MINIONS_RUNTIME: 'host', MINIONS_PLUGIN_DIR: join(dir, 'plugin'), MINIONS_STATE_DIR: join(dir, 'state'), MINIONS_WORKSPACE: join(dir, 'ws'), MINIONS_TMUX_SOCKET: 'minions-test', MINIONS_SECRETS_DIR: join(dir, 'secrets') };
    Object.assign(process.env, e);
    const paths = runtimePaths();
    const tmux = await buildCoordinatorCommand(defaults(), paths);
    expect(tmux.args.slice(0, 4)).toEqual(['-L', 'minions-test', '-u', 'new-session']);
    expect(tmux.cwd).toBe(join(dir, 'ws', 'repo'));
    const claude = await buildClaudeCommand(defaults(), paths);
    const settings = JSON.parse(claude.args[claude.args.indexOf('--settings') + 1]!);
    expect(settings.sandbox.enabled).toBe(true);
    expect(claude.args).not.toContain('bypassPermissions');
    expect(claude.args[claude.args.indexOf('--append-system-prompt') + 1]).toMatch(/Host runtime \(no container\)[\s\S]*ws\/repo/);
    expect(claude.args[claude.args.indexOf('--plugin-dir') + 1]).toBe(join(dir, 'plugin'));
  });
});

describe('host runtime processes', () => {
  it('shim pins the runtime environment (quoted paths) and execs the CLI', async () => {
    const { id } = await hostProject();
    const project = await loadProjectJson(id);
    const cli = join(env.root, 'fake cli.mjs');
    writeFileSync(cli, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: process.env }))\n');
    await prepareHostRuntime(project, { target: { node: process.execPath, cli }, pathEnv: '/usr/bin:/bin' });
    const hp = hostRuntimePaths(id);
    expect(readFileSync(hp.minionsShim, 'utf8')).toMatch(/^#!\/bin\/sh\n/);
    expect(existsSync(hp.ghShim)).toBe(false); // no gh on that PATH
    const out = await new HostRuntime(project).exec(['minions', 'status', '--json']);
    const d = JSON.parse(out.stdout) as { argv: string[]; env: Record<string, string> };
    expect(d.argv).toEqual(['status', '--json']);
    expect(d.env).toMatchObject({ MINIONS_RUNTIME: 'host', MINIONS_STATE_DIR: hp.state, MINIONS_WORKSPACE: hp.workspace, MINIONS_TMUX_SOCKET: hp.tmuxSocket });
    expect(d.env.GH_TOKEN).toBeUndefined();
    expect(minionsShim(project, { node: '/a b/node', cli: "/c'd/cli.js" })).toContain(`exec '/a b/node' '/c'\\''d/cli.js' "$@"`);
  });

  it('gh shim only when gh exists; it reads the project token file, not the user login', async () => {
    const { id } = await hostProject();
    const project = await loadProjectJson(id);
    const bin = join(env.root, 'tools');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho real\n'); chmodSync(join(bin, 'gh'), 0o755);
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/x' }, pathEnv: `${hostRuntimePaths(id).bin}:${bin}` });
    const sh = readFileSync(hostRuntimePaths(id).ghShim, 'utf8');
    expect(sh).toContain(`REAL_GH=${join(bin, 'gh')}`);
    expect(sh).toContain(`TOKEN_FILE=${projectPaths(id).githubTokenFile.includes(' ') ? `'${projectPaths(id).githubTokenFile}'` : projectPaths(id).githubTokenFile}`);
  });

  it('delegation: host runtime runs the shim directly; docker runtime needs a running container', async () => {
    const { repo, id } = await hostProject();
    const project = await loadProjectJson(id);
    await expect(delegateToRuntime(['status'], { json: true, cwd: repo })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/host runtime has not been started/) });
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/nonexistent' } });
    // a real shim run (re-prepared with the package CLI) would start the CLI; check the docker branch instead:
    const other = makeRepo(env.root, 'docker-repo');
    await runInit({ path: other, yes: true, visibility: 'private', dockerProbe: dockerUp });
    const only = join(env.root, 'only-git');
    mkdirSync(only);
    symlinkSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(only, 'git'));
    process.env.PATH = only; // no docker CLI: the container is not running
    await expect(delegateToRuntime(['status'], { json: true, cwd: other })).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/container is not running/) });
  });

  it('isRunning / down use the dedicated tmux server only', async () => {
    const { id } = await hostProject();
    const calls: string[][] = [];
    const h = new HostRuntime(await loadProjectJson(id), async (cmd, args) => { calls.push([cmd, ...args]); return args.includes('has-session') ? ok() : ok(); });
    expect(await h.down()).toBe(true);
    const sock = hostRuntimePaths(id).tmuxSocket;
    expect(calls).toEqual([['tmux', '-L', sock, 'has-session', '-t', 'coordinator'], ['tmux', '-L', sock, 'kill-server']]);
  });

  it('host tools report versions and install hints', async () => {
    const tools = await hostTools(async (cmd) => (cmd === 'tmux' ? ok('tmux 3.5a') : cmd === 'claude' ? ok('2.1.292 (Claude Code)') : no));
    expect(tools.find((t) => t.name === 'tmux')).toMatchObject({ ok: true, version: 'tmux 3.5a' });
    expect(tools.find((t) => t.name === 'backlog')).toMatchObject({ ok: false, required: true, hint: expect.stringMatching(/npm install -g backlog.md/) });
    expect(tools.find((t) => t.name === 'gh')).toMatchObject({ ok: false, required: false });
  });

  it('doctor in host mode: warn-level runtime check, host tools, no Docker calls', async () => {
    const { repo } = await hostProject();
    const calls: string[] = [];
    const runner = async (cmd: string, args: string[]) => {
      calls.push(cmd);
      if (cmd === 'tmux' && args.includes('-V')) return ok('tmux 3.5a');
      if (cmd === 'claude') return ok('2.1.292 (Claude Code)');
      if (cmd === 'git') return ok('git version 2.50.0');
      return no;
    };
    const r = await runDoctor({ cwd: repo, runner, probe: async () => { throw new Error('docker must not be probed'); } });
    const by = (n: string) => r.checks.find((c) => c.name === n);
    expect(by('runtime')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/macOS user/) });
    expect(by('host.tmux')!.status).toBe('ok');
    expect(by('host.backlog')).toMatchObject({ status: 'fail', hint: expect.stringMatching(/backlog.md/) });
    expect(by('docker.daemon')).toBeUndefined();
    expect(by('coordinator')!.status).toBe('warn');
    expect(calls).not.toContain('docker');
  });

  it('uninstall --delete-data removes the host workspace; without it the data is kept', async () => {
    const { repo, id } = await hostProject();
    await prepareHostRuntime(await loadProjectJson(id), { target: { node: process.execPath, cli: '/x' } });
    writeFileSync(join(hostRuntimePaths(id).state, 'minions.db'), 'x');
    const runner = async () => no;
    const kept = await runUninstall({ cwd: repo, yes: true, runner });
    expect(kept.hostData).toEqual({ path: hostRuntimePaths(id).root, deleted: false });
    expect(existsSync(hostRuntimePaths(id).state)).toBe(true);
    expect(existsSync(hostRuntimePaths(id).bin)).toBe(false);
    const again = await runInit({ path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
    const id2 = again.plan.projectId;
    await prepareHostRuntime(await loadProjectJson(id2), { target: { node: process.execPath, cli: '/x' } });
    const del = await runUninstall({ cwd: repo, yes: true, deleteData: true, runner });
    expect(del.hostData).toMatchObject({ deleted: true });
    expect(existsSync(hostRuntimePaths(id2).root)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});

describe('minions upgrade on the host runtime', () => {
  it('refuses with PRECONDITION before any source or container step, also with --dry-run, --from-container and --rebuild-cli', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../src/host/commands.js');
    const { repo } = await hostProject();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('MINIONS_RUNTIME', ''); // the host CLI
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      for (const args of [['upgrade'], ['upgrade', '--dry-run'], ['upgrade', '--from-container', '--rebuild-cli', '--now']]) {
        err.mockClear();
        const program = new Command();
        register(program);
        await expect(program.parseAsync(args, { from: 'user' })).rejects.toThrow(/^exit [1-9]/);
        const text = err.mock.calls.map((c) => String(c[0])).join('');
        expect(text).toContain('supports the Docker runtime only');
        expect(text).toContain('minions down && minions start');
      }
      expect(git(repo, 'status', '--porcelain')).toBe('');
    } finally {
      process.chdir(cwd);
      exit.mockRestore(); err.mockRestore(); out.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('help: --rebuild-cli is offered and --from-container does not promise a host build', async () => {
    const { Command } = await import('commander');
    const { register } = await import('../../src/host/commands.js');
    const program = new Command();
    register(program);
    const up = program.commands.find((c) => c.name() === 'upgrade')!;
    const opt = (flag: string) => up.options.find((o) => o.long === flag);
    expect(opt('--rebuild-cli')?.description).toMatch(/rebuilding\/reinstalling the global CLI .*review it first/);
    expect(opt('--from-container')?.description).toMatch(/strict fast-forward on a clean tree only$/);
    expect(opt('--from-container')?.description).not.toMatch(/built|install/);
    expect(opt('--timeout')).toBeDefined();
    expect(opt('--now')).toBeDefined();
  });
});
