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

  it('an abort signal kills the child (SIGTERM) and reports aborted; rejects unless allowFailure', async () => {
    const t = Date.now();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 150);
    const r = await run('node', ['-e', 'setTimeout(()=>{}, 10000)'], { allowFailure: true, signal: ctl.signal });
    expect(r).toMatchObject({ aborted: true, code: 130 });
    expect(r.timedOut).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(2000);
    const ctl2 = new AbortController();
    setTimeout(() => ctl2.abort(), 150);
    await expect(run('node', ['-e', 'setTimeout(()=>{}, 10000)'], { signal: ctl2.signal })).rejects.toThrow(/was aborted/);
  });

  it('an abort escalates to SIGKILL after the grace when the child ignores SIGTERM', async () => {
    const ctl = new AbortController();
    const p = run('node', ['-e', 'process.on("SIGTERM",()=>{}); console.log("up"); setInterval(()=>{}, 1000)'], { allowFailure: true, signal: ctl.signal, timeoutMs: 60_000 });
    await new Promise((res) => setTimeout(res, 300)); // let node install the handler
    const t = Date.now();
    ctl.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it('an already aborted signal spawns nothing; no signal keeps the old behaviour', async () => {
    const ctl = new AbortController(); ctl.abort();
    expect(await run('definitely-not-a-command-xyz', [], { allowFailure: true, signal: ctl.signal })).toMatchObject({ aborted: true, code: 130 });
    await expect(run('definitely-not-a-command-xyz', [], { signal: ctl.signal })).rejects.toThrow(/aborted before it started/);
    const r = await run('node', ['-e', 'process.exit(0)'], { signal: new AbortController().signal });
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it.skipIf(process.platform === 'win32')('killGroup: a timeout kills the grandchildren too, so one holding the output pipe cannot hang the call (task-65.4)', async () => {
    // The child starts a grandchild that ignores SIGTERM and keeps stdout open, prints its pid, and waits.
    const script = 'const c=require("child_process").spawn(process.execPath,["-e","process.on(\'SIGTERM\',()=>{});setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});console.log(c.pid);setInterval(()=>{},1000)';
    const t = Date.now();
    const r = await run('node', ['-e', script], { timeoutMs: 400, allowFailure: true, killGroup: true });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(6000);
    const pid = Number.parseInt(r.stdout.trim(), 10);
    expect(pid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 200));
    const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    expect(alive).toBe(false);
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
