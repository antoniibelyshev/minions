import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { GITHUB_TOKEN_CONTAINER_PATH } from '../../src/core/paths.js';
import { buildFingerprint } from '../../src/host/docker.js';
import {
  configureOrigin, GIT_CREDENTIAL_HELPER, GITHUB_CREDENTIAL_KEY, gitCredential, normalizeGithubRemote,
  parseCredentialInput, readGithubToken, type GitFn,
} from '../../src/runtime/github.js';
import { importWorkspace } from '../../src/runtime/workspace.js';
import { git as realGit, workspaceLayout } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { gitSync, initRepo, tmp } from './fixtures.js';

const TOKEN = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function tokenFile(content?: string, mode = 0o600): string {
  const dir = join(tmp('minions-gh-'), 'secrets');
  mkdirSync(dir);
  const file = join(dir, 'github-token');
  if (content !== undefined) { writeFileSync(file, content); chmodSync(file, mode); }
  return file;
}

/** Mocked git: records argv, answers `remote get-url` per `hasOrigin`, `fetch` per `fetchCode`. */
function mockGit(opts: { hasOrigin?: boolean; fetchCode?: number; fetchStderr?: string } = {}) {
  const calls: string[][] = [];
  const fn: GitFn = async (_cwd, args) => {
    calls.push(args);
    const r: RunResult = { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'remote' && args[1] === 'get-url') r.code = opts.hasOrigin ? 0 : 2;
    if (args[0] === 'config' && args[1] === '--unset-all') r.code = 5;
    if (args[0] === 'fetch') { r.code = opts.fetchCode ?? 0; r.stderr = opts.fetchStderr ?? ''; }
    return r;
  };
  return { calls, fn };
}

describe('normalizeGithubRemote', () => {
  it('normalizes scp, ssh, git and https forms to https without credentials', () => {
    for (const u of [
      'git@github.com:acme/app.git', 'git@github.com:acme/app', 'github.com:acme/app.git',
      'ssh://git@github.com/acme/app.git', 'ssh://git@github.com:22/acme/app', 'git://github.com/acme/app.git',
      'https://github.com/acme/app', 'https://github.com/acme/app.git/', `https://x-access-token:${TOKEN}@github.com/acme/app.git`,
      'HTTPS://user@github.com/acme/app.git',
    ]) expect(normalizeGithubRemote(u), u).toBe('https://github.com/acme/app.git');
    expect(normalizeGithubRemote('git@github.com:my-org/my.repo_1.git')).toBe('https://github.com/my-org/my.repo_1.git');
  });

  it('rejects non-GitHub and malformed remotes', () => {
    for (const u of [
      null, undefined, '', 'git@gitlab.com:acme/app.git', 'https://evilgithub.com/acme/app.git', 'https://github.com.evil.io/acme/app.git',
      'https://github.com/acme', 'https://github.com/acme/app/extra', 'git@github.com:../app.git', 'https://github.com/-x/app.git',
      'https://github.com/acme/app;rm -rf', 'file:///github.com/acme/app.git',
    ]) expect(normalizeGithubRemote(u), String(u)).toBeNull();
  });
});

describe('readGithubToken', () => {
  it('reports absent, ok (trimmed), empty and invalid tokens without echoing the content', async () => {
    expect(await readGithubToken(tokenFile())).toEqual({ state: 'absent' });
    expect(await readGithubToken(join(tokenFile(), 'nested'))).toEqual({ state: 'absent' });
    expect(await readGithubToken(tokenFile(`${TOKEN}\n`))).toEqual({ state: 'ok', token: TOKEN });
    expect(await readGithubToken(tokenFile('  \n'))).toEqual({ state: 'absent' });
    const bad = await readGithubToken(tokenFile(`${TOKEN}\nprotocol=https`));
    expect(bad.state).toBe('invalid');
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
  });

  it.skipIf(isRoot)('gives a precise error for a token file the container user cannot read', async () => {
    const file = tokenFile(TOKEN, 0o000);
    const r = await readGithubToken(file);
    expect(r.state).toBe('unreadable');
    const msg = (r as { message: string }).message;
    expect(msg).toContain(file);
    expect(msg).toContain(`uid ${process.getuid!()}`);
    expect(msg).toMatch(/owner uid \d+, mode 0000/);
    expect(msg).toContain('uid 1000');
    expect(msg).not.toContain(TOKEN);
  });

  it('defaults to the mounted container path', () => {
    expect(GITHUB_TOKEN_CONTAINER_PATH).toBe('/opt/minions/secrets/github-token');
  });
});

describe('git credential helper', () => {
  const req = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n\n';

  it('parses the credential protocol up to the blank line', () => {
    expect(parseCredentialInput('protocol=https\nhost=github.com\npath=a=b\n\nhost=evil\n')).toEqual({ protocol: 'https', host: 'github.com', path: 'a=b' });
  });

  it('answers get for https://github.com with x-access-token and the current file content', async () => {
    const file = tokenFile(TOKEN);
    expect(await gitCredential('get', req({ protocol: 'https', host: 'github.com' }), { tokenFile: file }))
      .toEqual({ stdout: `username=x-access-token\npassword=${TOKEN}\n` });
    // replaced on the host: the next call sees the new token (read at use time)
    const next = 'ghp_' + 'Z'.repeat(36);
    writeFileSync(file, next);
    expect((await gitCredential('get', req({ protocol: 'https', host: 'GitHub.com', path: 'acme/app.git' }), { tokenFile: file })).stdout).toContain(`password=${next}\n`);
  });

  it('ignores store/erase, other hosts and non-https protocols', async () => {
    const file = tokenFile(TOKEN);
    for (const op of ['store', 'erase', 'bogus']) {
      expect(await gitCredential(op, req({ protocol: 'https', host: 'github.com', username: 'x', password: 'y' }), { tokenFile: file })).toEqual({ stdout: '' });
    }
    for (const r of [{ protocol: 'https', host: 'gitlab.com' }, { protocol: 'http', host: 'github.com' }, { protocol: 'https', host: 'api.github.com' }, { protocol: 'https', host: 'github.com.evil.io' }, {}] as Record<string, string>[]) {
      expect(await gitCredential('get', req(r), { tokenFile: file })).toEqual({ stdout: '' });
    }
  });

  it('emits no credentials and a diagnostic (never the token) when the token is absent, invalid or unreadable', async () => {
    const absent = await gitCredential('get', req({ protocol: 'https', host: 'github.com' }), { tokenFile: tokenFile() });
    expect(absent.stdout).toBe('');
    expect(absent.stderr).toContain('minions auth github');
    const invalid = await gitCredential('get', req({ protocol: 'https', host: 'github.com' }), { tokenFile: tokenFile(`${TOKEN} extra`) });
    expect(invalid.stdout).toBe('');
    expect(invalid.stderr).not.toContain(TOKEN);
    if (!isRoot) {
      const unreadable = await gitCredential('get', req({ protocol: 'https', host: 'github.com' }), { tokenFile: tokenFile(TOKEN, 0o000) });
      expect(unreadable.stdout).toBe('');
      expect(unreadable.stderr).toContain('not readable');
      expect(unreadable.stderr).not.toContain(TOKEN);
    }
  });
});

describe('configureOrigin (mocked git)', () => {
  it('without a credential records the URL verbatim and never fetches or configures a helper (v0.1 behaviour)', async () => {
    for (const hasOrigin of [false, true]) {
      const g = mockGit({ hasOrigin });
      expect(await configureOrigin('/repo', { remoteUrl: 'git@github.com:acme/app.git', base: 'main', tokenFile: tokenFile(), git: g.fn })).toBeNull();
      expect(g.calls).toEqual([
        ['remote', 'get-url', 'origin'],
        hasOrigin ? ['remote', 'set-url', 'origin', 'git@github.com:acme/app.git'] : ['remote', 'add', 'origin', 'git@github.com:acme/app.git'],
      ]);
    }
  });

  it('does nothing without a remote URL, and keeps non-GitHub remotes verbatim even with a credential', async () => {
    const none = mockGit();
    expect(await configureOrigin('/repo', { base: 'main', tokenFile: tokenFile(TOKEN), git: none.fn })).toBeNull();
    expect(none.calls).toEqual([]);
    const other = mockGit();
    expect(await configureOrigin('/repo', { remoteUrl: 'git@gitlab.com:acme/app.git', base: 'main', tokenFile: tokenFile(TOKEN), git: other.fn })).toBeNull();
    expect(other.calls).toEqual([['remote', 'get-url', 'origin'], ['remote', 'add', 'origin', 'git@gitlab.com:acme/app.git']]);
  });

  it('with a credential sets the https origin, configures the helper and fetches the base; the token is in no argv', async () => {
    const g = mockGit({ hasOrigin: true });
    const r = await configureOrigin('/repo', { remoteUrl: 'git@github.com:acme/app.git', base: 'trunk', tokenFile: tokenFile(TOKEN), git: g.fn });
    expect(r).toEqual({ url: 'https://github.com/acme/app.git', authenticated: true, fetched: true, warnings: [] });
    expect(g.calls).toEqual([
      ['remote', 'get-url', 'origin'],
      ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'],
      ['config', '--unset-all', GITHUB_CREDENTIAL_KEY],
      ['config', '--add', GITHUB_CREDENTIAL_KEY, ''],
      ['config', '--add', GITHUB_CREDENTIAL_KEY, GIT_CREDENTIAL_HELPER],
      ['fetch', '--no-tags', 'origin', '+refs/heads/trunk:refs/remotes/origin/trunk'],
    ]);
    expect(GITHUB_CREDENTIAL_KEY).toBe('credential.https://github.com.helper');
    expect(GIT_CREDENTIAL_HELPER).toBe('/usr/local/bin/minions git-credential');
    expect(JSON.stringify(g.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('strips credentials embedded in a recorded https URL', async () => {
    const g = mockGit();
    const r = await configureOrigin('/repo', { remoteUrl: `https://someone:${TOKEN}@github.com/acme/app`, base: 'main', tokenFile: tokenFile(TOKEN), git: g.fn });
    expect(r?.url).toBe('https://github.com/acme/app.git');
    expect(g.calls[1]).toEqual(['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
    expect(JSON.stringify(g.calls)).not.toContain(TOKEN);
  });

  it('a failed fetch only warns, with redacted stderr', async () => {
    const g = mockGit({ fetchCode: 128, fetchStderr: `fatal: Authentication failed for ${TOKEN}\n` });
    const r = await configureOrigin('/repo', { remoteUrl: 'https://github.com/acme/app.git', base: 'main', tokenFile: tokenFile(TOKEN), git: g.fn });
    expect(r).toMatchObject({ authenticated: true, fetched: false });
    expect(r!.warnings[0]).toContain('Authentication failed');
    expect(r!.warnings[0]).not.toContain(TOKEN);
  });

  it.skipIf(isRoot)('an unreadable token does not fail: origin recorded verbatim, not fetched, precise warning', async () => {
    const g = mockGit();
    const r = await configureOrigin('/repo', { remoteUrl: 'git@github.com:acme/app.git', base: 'main', tokenFile: tokenFile(TOKEN, 0o000), git: g.fn });
    expect(r).toMatchObject({ url: 'git@github.com:acme/app.git', authenticated: false, fetched: false });
    expect(r!.warnings[0]).toContain('not readable by container uid');
    expect(g.calls).toEqual([['remote', 'get-url', 'origin'], ['remote', 'add', 'origin', 'git@github.com:acme/app.git']]);
  });
});

describe('importWorkspace with a real repository', () => {
  function setup() {
    const root = tmp();
    const host = join(root, 'host');
    mkdirSync(host);
    initRepo(host, 'trunk');
    const bundle = join(root, 'in.bundle');
    gitSync(host, 'bundle', 'create', bundle, 'trunk');
    return { root, bundle, layout: workspaceLayout(join(root, 'workspace')) };
  }

  it('without a credential: no origin field, verbatim URL, no helper, no origin refs', async () => {
    const { bundle, layout } = setup();
    const r = await importWorkspace(bundle, { base: 'trunk', remoteUrl: 'git@github.com:acme/app.git', config: defaults(), layout, tokenFile: tokenFile() });
    expect(r.origin).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(['base', 'baseFastForwarded', 'head', 'hostRefs', 'imported', 'repo']);
    expect(gitSync(layout.repo, 'remote', 'get-url', 'origin')).toBe('git@github.com:acme/app.git');
    expect(readFileSync(join(layout.repo, '.git', 'config'), 'utf8')).not.toContain('credential');
    expect(gitSync(layout.repo, 'for-each-ref', 'refs/remotes/origin/')).toBe('');
  });

  it('with a credential: .git/config holds the https URL and helper but never the token', async () => {
    const { bundle, layout } = setup();
    await importWorkspace(bundle, { base: 'trunk', config: defaults(), layout });
    // real git for everything except the network fetch
    const fetches: string[][] = [];
    const git: GitFn = async (cwd, args, allowFailure) => {
      if (args[0] === 'fetch') { fetches.push(args); return { code: 0, stdout: '', stderr: '' }; }
      return realGit(cwd, args, allowFailure);
    };
    const r = await configureOrigin(layout.repo, { remoteUrl: 'git@github.com:acme/app.git', base: 'trunk', tokenFile: tokenFile(TOKEN), git });
    expect(r).toMatchObject({ url: 'https://github.com/acme/app.git', authenticated: true, fetched: true });
    expect(fetches).toHaveLength(1);
    expect(gitSync(layout.repo, 'remote', 'get-url', 'origin')).toBe('https://github.com/acme/app.git');
    expect(gitSync(layout.repo, 'config', '-z', '--get-all', GITHUB_CREDENTIAL_KEY).split('\0').slice(0, -1)).toEqual(['', GIT_CREDENTIAL_HELPER]);
    // idempotent: re-running does not stack helper entries
    await configureOrigin(layout.repo, { remoteUrl: 'git@github.com:acme/app.git', base: 'trunk', tokenFile: tokenFile(TOKEN), git });
    expect(gitSync(layout.repo, 'config', '-z', '--get-all', GITHUB_CREDENTIAL_KEY).split('\0').slice(0, -1)).toEqual(['', GIT_CREDENTIAL_HELPER]);
    expect(readFileSync(join(layout.repo, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
  });
});

describe('gh wrapper (docker/gh-wrapper.sh)', () => {
  const script = resolve(fileURLToPath(new URL('../../docker/', import.meta.url)), 'gh-wrapper.sh');
  // The fake "real gh" is node running a script that reports its env and argv (no exec bit needed).
  function wrapper(tokenPath: string) {
    const dir = tmp('minions-ghw-');
    const fake = join(dir, 'fake-gh.cjs');
    writeFileSync(fake, 'process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN ?? null, notifier: process.env.GH_NO_UPDATE_NOTIFIER ?? null, argv: process.argv.slice(2) }))');
    const src = readFileSync(script, 'utf8');
    expect(src).toContain('REAL_GH=/opt/gh/bin/gh\n');
    expect(src).toContain(`TOKEN_FILE=${GITHUB_TOKEN_CONTAINER_PATH}\n`);
    const w = join(dir, 'gh.sh');
    writeFileSync(w, src.replace('REAL_GH=/opt/gh/bin/gh', `REAL_GH=${process.execPath}`).replace(`TOKEN_FILE=${GITHUB_TOKEN_CONTAINER_PATH}`, `TOKEN_FILE=${tokenPath}`));
    return (...args: string[]) => {
      const env = { ...process.env };
      delete env.GH_TOKEN;
      const r = spawnSync('sh', [w, fake, ...args], { encoding: 'utf8', env });
      return { code: r.status, stderr: r.stderr, out: r.stdout ? JSON.parse(r.stdout) as { token: string | null; notifier: string | null; argv: string[] } : null };
    };
  }

  it('sets GH_TOKEN for gh only from the file, read at exec time, and passes args intact', () => {
    const file = tokenFile(`${TOKEN}\n`);
    const gh = wrapper(file);
    const r = gh('pr', 'create', '--title', 'a "quoted" $(title)', '--body', '');
    expect(r.code).toBe(0);
    expect(r.out).toEqual({ token: TOKEN, notifier: '1', argv: ['pr', 'create', '--title', 'a "quoted" $(title)', '--body', ''] });
    const next = 'ghs_' + 'Q'.repeat(36);
    writeFileSync(file, next);
    expect(gh('api', 'user').out?.token).toBe(next);
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it('runs gh unauthenticated when no token file exists', () => {
    const r = wrapper(tokenFile())('auth', 'status');
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ token: null, argv: ['auth', 'status'] });
  });

  it('refuses malformed token content without echoing it', () => {
    for (const bad of [`${TOKEN} x`, `${TOKEN}\nGH_HOST=evil`, 'not-a-token', `ghp_abc'; echo pwned`]) {
      const r = wrapper(tokenFile(bad))('api', 'user');
      expect(r.code).toBe(4);
      expect(r.out).toBeNull();
      expect(r.stderr).toContain('does not contain a GitHub token');
      expect(r.stderr).not.toContain(TOKEN);
    }
  });

  it.skipIf(isRoot)('explains an unreadable token file precisely', () => {
    const file = tokenFile(TOKEN, 0o000);
    const r = wrapper(file)('api', 'user');
    expect(r.code).toBe(4);
    expect(r.out).toBeNull();
    expect(r.stderr).toContain(`${file} is not readable by container uid`);
    expect(r.stderr).toContain('uid 1000');
  });

  it('is part of the image build fingerprint and installed by the Dockerfile', () => {
    const dockerfile = readFileSync(resolve(fileURLToPath(new URL('../../docker/', import.meta.url)), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY docker/gh-wrapper.sh /usr/local/bin/gh');
    expect(dockerfile).toMatch(/ARG GH_VERSION=\d+\.\d+\.\d+\n/);
    expect(dockerfile.match(/ADD --checksum=sha256:[0-9a-f]{64}/g)).toHaveLength(2);
    expect(dockerfile).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/);
    const root = tmp('minions-fp-');
    for (const f of ['dist/cli.js', 'docker/Dockerfile', 'docker/gh-wrapper.sh', 'package.json']) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), f);
    }
    const before = buildFingerprint(root);
    writeFileSync(join(root, 'docker/gh-wrapper.sh'), 'changed');
    expect(buildFingerprint(root)).not.toBe(before);
    expect(existsSync(script)).toBe(true);
    expect(execFileSync('sh', ['-n', script], { encoding: 'utf8' })).toBe('');
  });
});

describe('tester edge cases', () => {
  it('credential helper answers a request without the trailing blank line, with CRLF, and a path-scoped request', async () => {
    const file = tokenFile(`${TOKEN}\n\n`);
    const want = { stdout: `username=x-access-token\npassword=${TOKEN}\n` };
    expect(await gitCredential('get', 'protocol=https\nhost=github.com', { tokenFile: file })).toEqual(want);
    expect(await gitCredential('get', 'protocol=https\r\nhost=github.com\r\n\r\n', { tokenFile: file })).toEqual(want);
    expect(await gitCredential('get', 'protocol=https\nhost=github.com\npath=acme/app.git\nusername=bob\n\n', { tokenFile: file })).toEqual(want);
    expect(await gitCredential('get', '', { tokenFile: file })).toEqual({ stdout: '' });
  });

  it('helper stderr never contains the token for any token state', async () => {
    for (const content of [undefined, '', `${TOKEN} x`, 'junk']) {
      const r = await gitCredential('get', 'protocol=https\nhost=github.com\n\n', { tokenFile: tokenFile(content) });
      expect(r.stdout).toBe('');
      expect(`${r.stderr ?? ''}`).not.toContain(TOKEN);
    }
  });

  it('hostile recorded origins are never normalized, fetched or given the helper, even with a credential', async () => {
    const file = tokenFile(TOKEN);
    for (const url of [
      'ext::sh -c touch% /tmp/pwn', 'file:///etc', '--upload-pack=touch /tmp/pwn', '-f',
      'https://github.com.evil.io/o/r.git', 'https://evil.io/github.com/o/r.git', 'https://github.com@evil.io/o/r.git',
      'https://u:p@evil.io/o/r.git', 'https://github.com/../r', 'https://github.com/o/r.git --upload-pack=x',
    ]) {
      const g = mockGit();
      const r = await configureOrigin('/repo', { remoteUrl: url, base: 'main', tokenFile: file, git: g.fn });
      expect(r, url).toBeNull();
      expect(g.calls.some((c) => c[0] === 'fetch' || c[0] === 'config'), url).toBe(false);
      expect(JSON.stringify(g.calls)).not.toContain(TOKEN);
    }
  });

  it('embedded credentials in a github URL never survive normalization', () => {
    expect(normalizeGithubRemote('https://user:pw@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(normalizeGithubRemote('https://x-access-token:ghp_secret@github.com/o/r')).toBe('https://github.com/o/r.git');
  });

  // Spawns the built CLI with an explicit --token-file so the real mounted token is never read.
  const cli = resolve(fileURLToPath(new URL('../../dist/cli.js', import.meta.url)));
  it.skipIf(!existsSync(cli))('the CLI helper reads stdin, writes the token only to stdout, ignores store, and exits 0 (needs dist/cli.js: npm run build)', () => {
    const run = (op: string, file: string) => spawnSync(process.execPath, [cli, 'git-credential', op, '--token-file', file], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, MINIONS_MODE: 'container' } });
    const file = tokenFile(TOKEN);
    const store = run('store', file);
    expect(store.status).toBe(0);
    expect(store.stdout).toBe('');
    const get = run('get', file);
    expect(get.status).toBe(0);
    expect(get.stdout).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(get.stderr).not.toContain(TOKEN);
    const absent = run('get', join(tmp(), 'missing-token'));
    expect(absent.status).toBe(0);
    expect(absent.stdout).not.toContain('password=');
  });
});
