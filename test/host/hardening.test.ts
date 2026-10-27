// Host runtime hardening (security review fixes): Claude Code launch flags and settings, git run
// outside the sandbox on agent-writable repos, symlink-safe hook logs and bundle copies, environment
// allowlist, Keychain avoidance, typed confirmation, and Telegram/verification-command limits.
// No real claude, tmux, security or network: fake runners and local temp repos only.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';

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
const { hostRuntimePaths, projectPaths } = await import('../../src/core/paths.js');
const { runtimePaths } = await import('../../src/runtime/paths.js');
const { loadProjectJson } = await import('../../src/host/project.js');
const { HostRuntime, hostRuntimeEnv, minionsShim, prepareHostRuntime } = await import('../../src/host/runtime.js');
const C = await import('../../src/runtime/coordinator.js');
const G = await import('../../src/runtime/git-hardening.js');
const { git: workspaceGit } = await import('../../src/runtime/worktree.js');
const { hookLog } = await import('../../src/runtime/hooks.js');
const { copyRegularFileNoFollow, ensureRealDir } = await import('../../src/core/fsutil.js');
const Cred = await import('../../src/host/credentials.js');
const { ClaudeAuthSchema } = await import('../../src/host/auth.js');
const { defaults } = await import('../helpers.js');
const { dockerDown, makeRepo, withHome } = await import('./fixtures.js');

let env: ReturnType<typeof withHome>;
const saved = { ...process.env };
beforeEach(() => { env = withHome(); });
afterEach(() => {
  env.cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

async function hostProject() {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility: 'private', runtime: 'host', dockerProbe: dockerDown });
  return { repo, id: r.plan.projectId, project: await loadProjectJson(r.plan.projectId) };
}

const rawGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

// ---------------------------------------------------------------- H1, M8: claude launch

describe('host runtime claude launch (H1, M8)', () => {
  function hostEnv() {
    const dir = env.root;
    mkdirSync(join(dir, 'plugin'), { recursive: true });
    writeFileSync(join(dir, 'plugin', 'coordinator.md'), 'coordinator prompt\n');
    return { MINIONS_PLUGIN_DIR: join(dir, 'plugin'), MINIONS_STATE_DIR: join(dir, 'state'), MINIONS_WORKSPACE: join(dir, 'ws'), MINIONS_SECRETS_DIR: join(dir, 'secrets') };
  }

  it('host: no user/project/local settings, no MCP servers, workspace+state as working dirs, permission mode forced to default', async () => {
    Object.assign(process.env, hostEnv(), { MINIONS_RUNTIME: 'host' });
    const cfg = { ...defaults(), permissionMode: 'acceptEdits' as const, coordinator: { permissionMode: 'auto' as const } };
    // Claude Code 2.1.292 lists the default mode only as `manual`; older versions list `default`.
    const c = await C.buildClaudeCommand(cfg, runtimePaths(), { permissionModes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] });
    const old = await C.buildClaudeCommand(cfg, runtimePaths(), { permissionModes: ['acceptEdits', 'auto', 'default', 'plan'] });
    expect(old.args[old.args.indexOf('--permission-mode') + 1]).toBe('default');
    await expect(C.buildClaudeCommand(cfg, runtimePaths(), { permissionModes: ['acceptEdits', 'auto'] })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    expect(c.args).toContain('--setting-sources=');
    expect(c.args).toContain('--strict-mcp-config');
    expect(c.args).not.toContain('--mcp-config');
    const i = c.args.indexOf('--add-dir');
    expect(c.args.slice(i + 1, i + 3)).toEqual([join(env.root, 'ws'), join(env.root, 'state')]);
    expect(c.args[i + 3]!.startsWith('--')).toBe(true); // the variadic --add-dir ends before the next flag
    expect(c.args[c.args.indexOf('--permission-mode') + 1]).toBe('manual');
    expect(c.args[c.args.indexOf('--append-system-prompt') + 1]).toMatch(/CLAUDE\.md is not loaded automatically/);
  });

  it('container launch is unchanged (no host flags, configured permission mode)', async () => {
    Object.assign(process.env, hostEnv());
    process.env.MINIONS_RUNTIME = 'container';
    const c = await C.buildClaudeCommand({ ...defaults(), coordinator: { permissionMode: 'acceptEdits' } }, runtimePaths());
    for (const f of ['--setting-sources=', '--strict-mcp-config', '--add-dir']) expect(c.args).not.toContain(f);
    expect(c.args[c.args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const d = await C.buildClaudeCommand(defaults(), runtimePaths(), { permissionModes: ['acceptEdits', 'auto'] });
    expect(d.args[d.args.indexOf('--permission-mode') + 1]).toBe('auto');
    const s = JSON.parse(c.args[c.args.indexOf('--settings') + 1]!);
    expect(s.permissions.allow).toContain('Bash(git *)');
    expect(s).not.toHaveProperty('sandbox');
  });

  it('host: specific git subcommands only, git -c/config denied, unsafe verification commands get no allow rule', () => {
    const h = { home: '/Users/u', workspace: '/r/projects/p/host/workspace', state: '/r/projects/p/host/state', secretsDir: '/r/projects/p/secrets', credentialsDir: '/r/credentials', projectDir: '/r/projects/p', hostRoot: '/r' };
    const cfg = { ...defaults(), verification: { ...defaults().verification, commands: ['npm test', 'npm run lint', 'node', 'bash -c x', 'npm test; curl x', 'make *', 'node -e 1', 'python3 -m pytest'] } };
    const s = C.coordinatorSettings(cfg, { auth: 'login', host: h }) as { permissions: { allow: string[]; deny: string[] } };
    expect(s.permissions.allow).not.toContain('Bash(git *)');
    expect(s.permissions.allow).toEqual(expect.arrayContaining(['Bash(git status)', 'Bash(git commit *)', 'Bash(git worktree list)', 'Bash(npm test)', 'Bash(npm run lint *)']));
    expect(s.permissions.allow.some((a) => a.startsWith('Bash(git config') || a.startsWith('Bash(git push') || a.startsWith('Bash(git remote'))).toBe(false);
    for (const bad of ['node', 'bash -c x', 'npm test; curl x', 'make *', 'node -e 1', 'python3 -m pytest']) expect(s.permissions.allow).not.toContain(`Bash(${bad})`);
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Bash(git -c *)', 'Bash(git config *)', 'Bash(security *)']));
    expect(C.safeVerificationCommand('npm test')).toBe(true);
    expect(C.safeVerificationCommand('pnpm -r test')).toBe(true);
    expect(C.safeVerificationCommand('npm test $(id)')).toBe(false);
  });
});

// ---------------------------------------------------------------- H4, M3, M5, M7, L1: sandbox and denies

describe('host runtime sandbox settings (H4, M3, M5, M7, L1)', () => {
  const h = {
    home: '/Users/u', hostRoot: '/Users/u/Library/Application Support/Minions', projectDir: '/Users/u/Library/Application Support/Minions/projects/p1',
    workspace: '/Users/u/Library/Application Support/Minions/projects/p1/host/workspace', state: '/Users/u/Library/Application Support/Minions/projects/p1/host/state',
    secretsDir: '/Users/u/Library/Application Support/Minions/projects/p1/secrets', credentialsDir: '/Users/u/Library/Application Support/Minions/credentials',
    pluginDir: '/Users/u/Library/Application Support/Minions/projects/p1/plugin', otherProjects: ['/Users/u/Library/Application Support/Minions/projects/p2'],
    readable: ['/Users/u/.nvm/versions/node/v22'], tmuxDir: '/private/tmp/tmux-501',
  };
  const s = C.hostSettings(h);
  const fs = s.sandbox.filesystem as { allowWrite: string[]; denyWrite: string[]; denyRead: string[]; allowRead: string[] };
  const net = s.sandbox.network as Record<string, unknown>;

  it('data root unreadable to sandboxed commands; only this project\'s dirs, config, plugin and GitHub token re-opened', () => {
    expect(fs.denyRead).toEqual(expect.arrayContaining([h.hostRoot, h.credentialsDir, `${h.secretsDir}/anthropic-api-key`, `${h.secretsDir}/telegram-bot-token`]));
    expect(fs.allowRead).toEqual(expect.arrayContaining([h.workspace, h.state, `${h.projectDir}/host/bin`, `${h.projectDir}/runtime`, h.pluginDir, `${h.secretsDir}/github-token`, '/Users/u/.nvm/versions/node/v22']));
    expect(fs.allowRead).not.toContain(h.secretsDir);
    expect(s.deny).toEqual(expect.arrayContaining([`Read(//${h.hostRoot.slice(1)}/*.json)`, `Read(//${h.otherProjects[0]!.slice(1)}/**)`, `Edit(//${h.projectDir.slice(1)}/runtime/**)`]));
    expect(s.blockReadsOutsideWorkingDirectories).toBe(true);
  });

  it('the config history (<project dir>/config-history, what /undo restores from) is not editable (task-53.5.3)', () => {
    const dir = `//${h.projectDir.slice(1)}/config-history`;
    expect(s.deny).toContain(`Edit(${dir}/**)`);
    // `*.json` of the project dir does not match across '/': the subdirectory needs its own rule.
    expect(s.deny).toContain(`Edit(//${h.projectDir.slice(1)}/*.json)`);
  });

  it('host manager state under the data root is denied to Read and Edit (directory rule, task-53.5.5)', () => {
    const mgr = `//${h.hostRoot.slice(1)}/manager`;
    expect(s.deny).toEqual(expect.arrayContaining([`Edit(${mgr})`, `Edit(${mgr}/**)`, `Read(${mgr})`, `Read(${mgr}/**)`]));
    // No safe data root (not explicit, project not under <root>/projects): no manager rule at all.
    const noRoot = C.hostSettings({ ...h, hostRoot: undefined, projectDir: '/srv/p1' });
    expect(noRoot.deny.some((d) => d.includes('/manager'))).toBe(false);
    // Unsafe root (home itself) is not a deny target either.
    expect(C.hostSettings({ ...h, hostRoot: h.home }).deny.some((d) => d.includes('/manager'))).toBe(false);
  });

  it('no home paths writable (caches go to state); git config/hooks and Claude files in the workspace protected', () => {
    expect(fs.allowWrite).toEqual([h.workspace, h.state]);
    expect(fs.allowWrite.some((p) => p.startsWith('~'))).toBe(false);
    expect(fs.denyWrite).toEqual(expect.arrayContaining([`${h.workspace}/repo/.git/config`, `${h.workspace}/repo/.git/hooks`]));
    expect(s.deny).toEqual(expect.arrayContaining([`Edit(//${h.workspace.slice(1)}/repo/.git/hooks/**)`, `Edit(//${h.workspace.slice(1)}/**/.claude/**)`]));
    // never the whole .git: sandboxed commits must keep working
    expect(s.deny.some((d) => d.endsWith('/.git/**)') && d.startsWith('Edit'))).toBe(false);
  });

  it('credential, browser, mail and history locations denied; shell rc, git and Claude config not editable', () => {
    for (const p of ['~/.git-credentials', '~/.claude.json', '~/.claude/.credentials.json', '~/Library/Cookies', '~/Library/Application Support/Google', '~/.zsh_history', '~/.vault-token', '~/.config/gcloud'])
      expect(fs.denyRead).toContain(p);
    expect(s.deny).toEqual(expect.arrayContaining(['Read(~/.git-credentials)', 'Edit(~/.zshrc)', 'Edit(~/.gitconfig)', 'Edit(~/Library/LaunchAgents/**)', 'Edit(~/.claude/**)']));
  });

  it('no Unix sockets (tmux server, ssh-agent) and no tmux directory for sandboxed commands', () => {
    expect(net).toMatchObject({ allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false });
    expect(fs.denyRead).toEqual(expect.arrayContaining(['/private/tmp/tmux-501', '/tmp/tmux-501']));
    expect(fs.denyWrite).toEqual(expect.arrayContaining(['/private/tmp/tmux-501', '/tmp/tmux-501']));
  });

  it('readable tool dirs: PATH entries and toolchains under home, never home itself or a secret dir', () => {
    const home = join(env.root, 'h');
    for (const d of ['.local/bin', '.nvm/versions/node/v1/bin', '.ssh/bin']) mkdirSync(join(home, d), { recursive: true });
    const dirs = C.readableToolDirs(home, { PATH: [join(home, '.local/bin'), join(home, '.ssh/bin'), home, 'relative/bin', '/usr/bin'].join(':') });
    expect(dirs).toEqual(expect.arrayContaining([join(home, '.local/bin'), join(home, '.nvm')]));
    expect(dirs).not.toContain(home);
    expect(dirs.some((d) => d.includes('.ssh'))).toBe(false);
    expect(dirs).not.toContain('/usr/bin'); // outside home: readable anyway
  });
});

// ---------------------------------------------------------------- H2: git outside the sandbox

describe('host-runtime git hardening (H2)', () => {
  function hostileRepo() {
    const repo = makeRepo(env.root, 'ws-repo');
    const marker = join(env.root, 'pwned');
    const evil = join(env.root, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'-$1\ncat\n`); chmodSync(evil, 0o755);
    mkdirSync(join(repo, 'hooks'));
    for (const hk of ['post-merge', 'post-checkout', 'pre-push', 'reference-transaction']) { writeFileSync(join(repo, 'hooks', hk), `#!/bin/sh\ntouch '${marker}'-hook-${hk}\n`); chmodSync(join(repo, 'hooks', hk), 0o755); }
    rawGit(repo, 'config', 'core.hooksPath', join(repo, 'hooks'));
    rawGit(repo, 'config', 'core.fsmonitor', `${evil} fsmonitor`);
    rawGit(repo, 'config', 'filter.evil.smudge', `${evil} smudge`);
    rawGit(repo, 'config', 'filter.evil.clean', `${evil} clean`);
    rawGit(repo, 'config', 'credential.helper', `!${evil} cred`);
    rawGit(repo, 'config', 'core.sshCommand', `${evil} ssh`);
    writeFileSync(join(repo, '.gitattributes'), '* filter=evil\n');
    return { repo, marker };
  }
  const pwned = (marker: string) => execFileSync('sh', ['-c', `ls '${marker}'-* 2>/dev/null || true`], { encoding: 'utf8' }).trim();

  it('the container path is unchanged: repository hooks/filters would run there (sanity check of the fixture)', async () => {
    const { repo, marker } = hostileRepo();
    process.env.MINIONS_RUNTIME = 'container';
    await workspaceGit(repo, ['status', '--porcelain'], true);
    expect(pwned(marker)).not.toBe('');
  });

  it('host runtime: status, checkout, merge and worktree add run no hook, fsmonitor, filter or credential helper from the workspace config', async () => {
    const { repo, marker } = hostileRepo();
    process.env.MINIONS_RUNTIME = 'host';
    process.env.MINIONS_GIT_CREDENTIAL_HELPER = '!true';
    expect((await workspaceGit(repo, ['status', '--porcelain'], true)).code).toBe(0);
    rawGit(repo, '-c', 'core.hooksPath=/dev/null', 'branch', 'side');
    await workspaceGit(repo, ['checkout', '-q', 'side'], true);
    await workspaceGit(repo, ['checkout', '-q', 'main'], true);
    await workspaceGit(repo, ['merge', '--ff-only', '-q', 'side'], true);
    expect((await workspaceGit(repo, ['worktree', 'add', '-q', join(env.root, 'wt'), 'side'], true)).code).toBe(0);
    expect(existsSync(join(env.root, 'wt', 'README.md'))).toBe(true);
    expect(pwned(marker)).toBe('');
  });

  it('host runtime: core.worktree from the workspace config cannot redirect checkouts', async () => {
    const repo = makeRepo(env.root, 'wt-repo');
    const elsewhere = join(env.root, 'elsewhere');
    mkdirSync(elsewhere);
    rawGit(repo, 'config', 'core.worktree', elsewhere);
    process.env.MINIONS_RUNTIME = 'host';
    const r = await workspaceGit(repo, ['status', '--porcelain'], true);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(''); // pinned to the repo, not "elsewhere" (where every file would show as deleted)
  });

  it('argv/env: hooks off, only https (+file for bundles), no file transport for network ops, helpers reset, no system config', () => {
    const a = G.hardenedGitArgs({ credentialHelper: '!/x/minions git-credential' });
    for (const v of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'credential.helper=', 'credential.https://github.com.helper=!/x/minions git-credential',
      'protocol.allow=never', 'protocol.https.allow=always', 'protocol.file.allow=always', 'protocol.ssh.allow=never', 'protocol.ext.allow=never', 'submodule.recurse=false', 'gc.auto=0'])
      expect(a).toContain(v);
    expect(a.indexOf('credential.helper=')).toBeLessThan(a.indexOf('credential.https://github.com.helper=!/x/minions git-credential'));
    expect(G.hardenedGitArgs({ network: true })).toContain('protocol.file.allow=never');
    expect(G.isNetworkOp(['push', '--porcelain', 'https://github.com/a/b.git', 'x:y'])).toBe(true);
    expect(G.isNetworkOp(['ls-remote', 'origin'])).toBe(true);
    expect(G.isNetworkOp(['fetch', '--no-tags', '/state/import/x.bundle', '+refs/heads/*:refs/remotes/host/*'])).toBe(false);
    const e = G.hardenedGitEnv({ PATH: '/usr/bin', GIT_SSH_COMMAND: 'evil', GIT_CONFIG_PARAMETERS: "'x=y'", GIT_DIR: '/x', SSH_ASKPASS: 'evil' }, '/w');
    expect(e).toMatchObject({ PATH: '/usr/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GIT_WORK_TREE: '/w' });
    for (const k of ['GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR']) expect(e).not.toHaveProperty(k);
  });

  it('filter overrides empty every non-global driver; unsafe driver names fail closed', () => {
    expect(G.filterOverrides('global\tfilter.lfs.smudge\nlocal\tfilter.evil.clean\nworktree\tfilter.a.b.process\n'))
      .toEqual(['-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'filter.evil.process=', '-c', 'filter.evil.required=false',
        '-c', 'filter.a.b.clean=', '-c', 'filter.a.b.smudge=', '-c', 'filter.a.b.process=', '-c', 'filter.a.b.required=false']);
    expect(() => G.filterOverrides('local\tfilter.x=y.clean\n')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('HostRuntime.exec runs host-side git with the hardening and the allowlisted env', async () => {
    const { project } = await hostProject();
    const calls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
    const h = new HostRuntime(project, async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return ok(); });
    await h.exec(['git', '-C', h.paths.repo, 'rev-parse', '--git-dir']);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['core.hooksPath=/dev/null', 'core.fsmonitor=false', '-C', h.paths.repo, 'rev-parse']));
    expect(calls[0]!.opts!.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', MINIONS_RUNTIME: 'host' });
  });
});

// ---------------------------------------------------------------- M1: hook log

describe('hook log (M1)', () => {
  it('never follows a symlink at the log path; control characters are escaped', () => {
    const dir = join(env.root, 'logs');
    mkdirSync(dir);
    const target = join(env.root, 'victim');
    writeFileSync(target, 'original\n');
    symlinkSync(target, join(dir, 'hooks.log'));
    hookLog('stop allow: \u001b[2Jinjected\nfake line', join(dir, 'hooks.log'));
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    const real = join(env.root, 'logs2', 'hooks.log');
    hookLog('a\u001b[31mb\rc\nd', real);
    const line = readFileSync(real, 'utf8');
    expect(line.trim().split('\n')).toHaveLength(1);
    expect(line).not.toMatch(/[\u001b\r]/);
    expect(line).toContain('a\\x1b[31mb\\x0dc\\nd');
  });

  it('host runtime writes hooks.log under <project>/host/logs (MINIONS_LOG_DIR), outside the agent-writable state', async () => {
    const { project, id } = await hostProject();
    const e = hostRuntimeEnv(project, { PATH: '/usr/bin' });
    expect(runtimePaths(e).hooksLog).toBe(join(hostRuntimePaths(id).logs, 'hooks.log'));
    expect(runtimePaths(e).hooksLog.startsWith(hostRuntimePaths(id).state)).toBe(false);
  });
});

// ---------------------------------------------------------------- M2: bundle copies

describe('bundle copies (M2)', () => {
  it('copyRegularFileNoFollow refuses symlinks and non-files, never writes through a destination symlink', async () => {
    const src = join(env.root, 'b.bundle');
    writeFileSync(src, 'bundle');
    const link = join(env.root, 'link');
    symlinkSync('/etc/hosts', link);
    await expect(copyRegularFileNoFollow(link, join(env.root, 'out1'))).rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(copyRegularFileNoFollow(env.root, join(env.root, 'out2'))).rejects.toMatchObject({ code: 'PRECONDITION' });
    const victim = join(env.root, 'victim');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(env.root, 'dst-link'));
    await expect(copyRegularFileNoFollow(src, join(env.root, 'dst-link'))).rejects.toBeTruthy();
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    await copyRegularFileNoFollow(src, join(env.root, 'out3'));
    expect(readFileSync(join(env.root, 'out3'), 'utf8')).toBe('bundle');
    expect(lstatSync(join(env.root, 'out3')).mode & 0o777).toBe(0o600);
  });

  it('ensureRealDir refuses a symlinked directory', async () => {
    mkdirSync(join(env.root, 'real'));
    symlinkSync(join(env.root, 'real'), join(env.root, 'sym'));
    await expect(ensureRealDir(join(env.root, 'sym'))).rejects.toMatchObject({ code: 'PRECONDITION' });
  });

  it('host transfer dirs are host-owned (outside the agent-writable workspace/state) and copies refuse planted symlinks', async () => {
    const { project, id } = await hostProject();
    const hp = hostRuntimePaths(id);
    expect(hp.import.startsWith(hp.state) || hp.import.startsWith(hp.workspace)).toBe(false);
    await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/x' }, runner: async () => ok() });
    const t = new HostRuntime(project, async () => ok()).transferTarget();
    const local = join(env.root, 'x.bundle');
    writeFileSync(local, 'data');
    await t.putFile(local, join(t.dirs.import, 'import-1.bundle'));
    expect(readFileSync(join(hp.import, 'import-1.bundle'), 'utf8')).toBe('data');
    symlinkSync('/etc/hosts', join(hp.exports, 'export-1.bundle'));
    await expect(t.getFile(join(hp.exports, 'export-1.bundle'), join(env.root, 'got'))).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(existsSync(join(env.root, 'got'))).toBe(false);
  });
});

// ---------------------------------------------------------------- M4, L2, L3: environment

describe('host runtime environment (M4, L2, L3)', () => {
  it('allowlist: secrets and injection variables dropped, proxies kept, relative PATH entries dropped, caches in state', async () => {
    const { project, id } = await hostProject();
    const e = hostRuntimeEnv(project, {
      PATH: '/usr/bin:node_modules/.bin:.:/bin', HOME: '/Users/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy:3128',
      AWS_SECRET_ACCESS_KEY: 'x', ANTHROPIC_API_KEY: 'x', NPM_TOKEN: 'x', SSH_AUTH_SOCK: '/tmp/s', GIT_SSH_COMMAND: 'x', NODE_OPTIONS: '--require x', DYLD_INSERT_LIBRARIES: 'x', OPENAI_API_KEY: 'x',
    });
    for (const k of ['AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'OPENAI_API_KEY']) expect(e).not.toHaveProperty(k);
    expect(e).toMatchObject({ HOME: '/Users/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy:3128' });
    expect(e.PATH).toBe(`${hostRuntimePaths(id).bin}:/usr/bin:/bin`);
    const cache = hostRuntimePaths(id).cache;
    expect(e).toMatchObject({ XDG_CACHE_HOME: cache, npm_config_cache: join(cache, 'npm'), COREPACK_HOME: join(cache, 'corepack'), PIP_CACHE_DIR: join(cache, 'pip') });
    expect(cache.startsWith(hostRuntimePaths(id).state)).toBe(true);
  });

  it('claudeAuth.env cannot set MINIONS_*, PATH, GIT_* or DYLD_* names', () => {
    for (const k of ['MINIONS_STATE_DIR', 'PATH', 'GIT_SSH_COMMAND', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS'])
      expect(ClaudeAuthSchema.safeParse({ method: 'login', env: { [k]: 'x' } }).success).toBe(false);
    expect(ClaudeAuthSchema.safeParse({ method: 'login', env: { ANTHROPIC_BASE_URL: 'https://x' } }).success).toBe(true);
  });

  it('the shim unsets cloud credentials and injected git config before running the CLI', async () => {
    const { project } = await hostProject();
    const cli = join(env.root, 'fake cli.mjs');
    writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.env))\n');
    await prepareHostRuntime(project, { target: { node: process.execPath, cli }, pathEnv: '/usr/bin:/bin', runner: async () => ok() });
    const shim = hostRuntimePaths(project.projectId).minionsShim;
    expect(minionsShim(project, { node: '/n', cli: '/c' })).toMatch(/unset .*AWS|sed -n -E/);
    const out = execFileSync(shim, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', AWS_SESSION_TOKEN: 'x', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_COUNT: '1', NODE_OPTIONS: '--x', KEEP_ME: '1' } });
    const e = JSON.parse(out) as Record<string, string>;
    for (const k of ['AWS_SESSION_TOKEN', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_COUNT', 'NODE_OPTIONS']) expect(e).not.toHaveProperty(k);
    expect(e.KEEP_ME).toBe('1');
    expect(e.MINIONS_RUNTIME).toBe('host');
  });
});

// ---------------------------------------------------------------- H3: Keychain

describe('Keychain avoidance (H3)', () => {
  function fakeSecurity(items: Map<string, string>) {
    const calls: string[][] = [];
    const runner = async (cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> => {
      calls.push([cmd, ...args]);
      if (cmd !== 'security') return ok();
      if (args[0] === 'list-keychains') return ok('login.keychain');
      const key = `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
      if (args[0] === 'find-generic-password') return items.has(key) ? ok(items.get(key)! + '\n') : { code: 44, stdout: '', stderr: '' };
      if (args[0] === 'delete-generic-password') { items.delete(key); return ok(); }
      if (args[0] === '-i') { const m = /-s (\S+) -a (\S+) .* -w (\S+)/.exec(opts?.input ?? ''); if (m) items.set(`${m[1]}/${m[2]}`, m[3]!); return ok(); }
      return ok();
    };
    return { runner, calls };
  }
  const TOKEN = 'github_pat_' + 'A'.repeat(40);

  it('selectStore uses the file store while any project uses the host runtime', async () => {
    const { runner } = fakeSecurity(new Map());
    expect((await Cred.selectStore({ runner, platform: 'darwin', env: {} })).backend).toBe('keychain');
    await hostProject();
    expect((await Cred.selectStore({ runner, platform: 'darwin', env: {} })).backend).toBe('file');
    expect((await Cred.selectStore({ runner, platform: 'darwin', env: { MINIONS_CREDENTIAL_STORE: 'keychain' } })).backend).toBe('file');
  });

  it('prepareHostRuntime moves Keychain tokens of every project to the 0600 file store', async () => {
    const items = new Map<string, string>();
    const { runner } = fakeSecurity(items);
    const other = makeRepo(env.root, 'docker-repo');
    const r = await runInit({ path: other, yes: true, visibility: 'private', dockerProbe: async () => ({ daemon: true, serverVersion: '1', compose: true, composeVersion: '1' }) });
    const otherId = r.plan.projectId;
    await Cred.provisionGithubToken({ projectId: otherId, token: TOKEN, repoPath: other, verify: false, runner, platform: 'darwin', env: {} });
    expect((await Cred.loadCredentialRefs(otherId)).github?.backend).toBe('keychain');
    const { project } = await hostProject();
    const prep = await prepareHostRuntime(project, { target: { node: process.execPath, cli: '/x' }, runner });
    expect(prep.movedToFileStore).toEqual([{ projectId: otherId, kind: 'github' }]);
    expect((await Cred.loadCredentialRefs(otherId)).github?.backend).toBe('file');
    expect(items.size).toBe(0);
    expect(await Cred.readGithubToken(otherId, runner)).toBe(TOKEN);
    expect(lstatSync(new Cred.FileStore().path(otherId)).mode & 0o777).toBe(0o600);
    expect(projectPaths(otherId).dir).toBeTruthy();
  });
});

// ---------------------------------------------------------------- L5 / Telegram

describe('Telegram in the host runtime', () => {
  it('is disabled with a precise reason (user plugins are not loaded)', () => {
    const cfg = { ...defaults(), communication: { ...defaults().communication, channel: 'telegram' as const } };
    const d = C.decideTelegram(cfg, { state: 'ok', token: 'x', botId: '1' }, { available: true, summary: '', items: [] } as never, true);
    expect(d).toEqual({ enabled: false, reason: C.HOST_TELEGRAM_REASON });
    expect(C.decideTelegram(cfg, { state: 'ok', token: 'x', botId: '1' }, { available: true, summary: '', items: [] } as never, false).enabled).toBe(true);
  });
});
