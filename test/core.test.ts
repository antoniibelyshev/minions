import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MinionsError } from '../src/core/errors.js';
import { run } from '../src/core/exec.js';
import { atomicWrite, readJson, sha256, sha256File } from '../src/core/fsutil.js';
import { redact } from '../src/core/output.js';
import { composeProjectName, projectPaths, volumeNames } from '../src/core/paths.js';

describe('redact', () => {
  it('masks token shapes', () => {
    const secrets = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'gho_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
      '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ',
    ];
    for (const s of secrets) expect(redact(`token=${s} end`)).not.toContain(s);
    expect(redact('Authorization: Bearer abc.def.ghijklmnop')).toBe('Authorization: Bearer [REDACTED]');
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });
});

describe('exec', () => {
  it('never uses a shell', async () => {
    const r = await run('node', ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'a; echo pwned', '$(id)']);
    expect(JSON.parse(r.stdout)).toEqual(['a; echo pwned', '$(id)']);
  });

  it('passes stdin input', async () => {
    const r = await run('node', ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello' });
    expect(r.stdout).toBe('hello');
  });

  it('throws on non-zero unless allowFailure', async () => {
    await expect(run('node', ['-e', 'process.exit(3)'])).rejects.toBeInstanceOf(MinionsError);
    expect((await run('node', ['-e', 'process.exit(3)'], { allowFailure: true })).code).toBe(3);
  });

  it('handles timeout', async () => {
    const t = Date.now();
    await expect(run('node', ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    const r = await run('node', ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 200, allowFailure: true });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('reports missing commands as NOT_FOUND', async () => {
    await expect(run('definitely-not-a-command-xyz', [])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('fsutil', () => {
  it('atomicWrite writes with mode and leaves no temp files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minions-'));
    const p = join(dir, 'nested', 'f.json');
    await atomicWrite(p, 'one');
    await atomicWrite(p, 'two', { mode: 0o600 });
    expect(await readFile(p, 'utf8')).toBe('two');
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, 'nested'))).toEqual(['f.json']);
    expect(await sha256File(p)).toBe(sha256('two'));
  });

  it('readJson validates with dotted paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'minions-'));
    const p = join(dir, 'x.json');
    await atomicWrite(p, JSON.stringify({ a: { b: 'x' } }));
    const schema = z.object({ a: z.object({ b: z.number() }).strict() }).strict();
    await expect(readJson(p, schema)).rejects.toThrow(/a\.b/);
    await expect(readJson(join(dir, 'missing.json'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('paths', () => {
  it('names volumes and compose project from projectId', () => {
    process.env.MINIONS_HOME = '/tmp/mh';
    const id = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
    expect(composeProjectName(id)).toBe('minions-3f2b8c1e');
    expect(volumeNames(id).state).toBe('minions-3f2b8c1e-state');
    expect(projectPaths(id).configJson).toBe(`/tmp/mh/projects/${id}/config.json`);
  });
});
