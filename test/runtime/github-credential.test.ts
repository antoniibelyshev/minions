// GitHub remote normalization, the token file, the git credential helper and configureOrigin over a mocked git
// (unit tier). The shell gh wrapper and the built CLI helper are exercised in github.test.ts (integration tier).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { GITHUB_TOKEN_CONTAINER_PATH } from '../../src/core/paths.js';
import {
  configureOrigin, GIT_CREDENTIAL_HELPER, GITHUB_CREDENTIAL_KEY, gitCredential, normalizeGithubRemote,
  parseCredentialInput, readGithubToken, type GitFn,
} from '../../src/runtime/github.js';
import { tmp } from './fixtures.js';

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
});
