// The shell gh wrapper (docker/gh-wrapper.sh) and the built CLI credential helper as real subprocesses (integration
// tier). Remote normalization, the token file, the helper protocol and configureOrigin: github-credential.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GITHUB_TOKEN_CONTAINER_PATH } from '../../src/core/paths.js';
import { buildFingerprint } from '../../src/host/docker.js';
import { shq } from '../helpers.js';
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
    writeFileSync(w, src.replace('REAL_GH=/opt/gh/bin/gh', `REAL_GH=${shq(process.execPath)}`).replace(`TOKEN_FILE=${GITHUB_TOKEN_CONTAINER_PATH}`, `TOKEN_FILE=${shq(tokenPath)}`));
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

describe('git credential helper CLI', () => {
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