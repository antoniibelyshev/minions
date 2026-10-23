// task-29 host hardening: portable idle restart (no setsid), shell-quoted reinstall command, control
// characters stripped from container output shown on the host (one shared helper), and a source
// fingerprint that never follows symlinks out of the checkout.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FINGERPRINT_DEPTH, MAX_FINGERPRINT_FILES, sourceFingerprint } from '../../scripts/source-fingerprint.mjs';
import { createControlStripper, relayStripped, stripControlChars, stripTerminalEscapes } from '../../src/core/control-chars.js';
import { emit, reportError } from '../../src/core/output.js';
import { MinionsError } from '../../src/core/errors.js';
import { spawnRelay } from '../../src/host/docker.js';
import { manualReinstallCommand, packedTarball } from '../../src/host/upgrade-source.js';
import { scheduleDetachedRestart, type DetachedSpawn } from '../../src/runtime/coordinator.js';

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

const ROOT = join(import.meta.dirname, '..', '..');

describe('idle restart is portable (no setsid)', () => {
  it('detaches with node spawn detached:true and runs minions itself, not setsid/nohup', () => {
    const calls: { cmd: string; args: string[]; opts: Parameters<DetachedSpawn>[2] }[] = [];
    const spawn: DetachedSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 1, unref: () => undefined, on: () => undefined }; };
    const dir = tmp('minions-t29-');
    scheduleDetachedRestart({ activeLeases: () => [], drain: () => null, log: join(dir, 'restart.log'), cwd: dir, spawn }, { recover: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('minions');
    expect(calls[0]!.opts.detached).toBe(true);
    expect([calls[0]!.cmd, ...calls[0]!.args].join(' ')).not.toMatch(/\b(setsid|nohup)\b/);
  });

  it('no template, script or docker file invokes setsid (missing on macOS)', () => {
    const hits: string[] = [];
    const scan = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) scan(p);
        // C sources (docker/minions-sandbox) call the setsid(2) syscall inside the Linux container; not the command.
        else if (e.isFile() && !p.endsWith('.c') && /\bsetsid\b/.test(readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    for (const d of ['templates', 'scripts', 'docker']) scan(join(ROOT, d));
    expect(hits).toEqual([]);
  });
});

describe('reinstall command quotes the version', () => {
  it('quotes a version with shell metacharacters', () => {
    const cmd = manualReinstallCommand('/src/minions', '1.0.0;touch /tmp/pwned');
    expect(cmd).toContain(`npm install -g './minions-1.0.0;touch /tmp/pwned.tgz'`);
    expect(packedTarball(`1'x`)).toBe(`'./minions-1'\\''x.tgz'`);
  });
  it('leaves plain versions readable and keeps the placeholder', () => {
    expect(packedTarball('0.2.0')).toBe('./minions-0.2.0.tgz');
    expect(packedTarball(null)).toBe('./minions-<version>.tgz');
  });
});

describe('control characters (shared helper)', () => {
  it('strips CSI, OSC, DCS, two-byte ESC and C1 sequences and other controls; keeps newline/tab', () => {
    expect(stripControlChars('a\x1b[31mred\x1b[0m\tb\n')).toBe('ared\tb\n');
    expect(stripControlChars('x\x1b]0;evil title\x07y\x1b]8;;http://e\x1b\\z')).toBe('xyz');
    expect(stripControlChars('p\x1bPq#0;1\x1b\\q\x1b(Br\x1bcs')).toBe('pqrs');
    expect(stripControlChars('a\x9b2Jb\x9d0;t\x9cc')).toBe('abc');
    expect(stripControlChars('a\rb\x00c\x08d\x7fe\x85fé中')).toBe('abcdefé中');
    expect(stripControlChars('\x1b[200~paste\x1b[201~')).toBe('paste');
  });

  it('handles sequences and UTF-8 split across chunks', () => {
    const st = createControlStripper();
    const bytes = Buffer.from('ok \x1b[1;31mX\x1b]0;t\x07 é!', 'utf8');
    let out = '';
    for (const b of bytes) out += st.push(Buffer.from([b]));
    expect(out + st.end()).toBe('ok X é!');
  });

  it('an unterminated control string stops swallowing output after a bound', () => {
    const s = stripControlChars('\x1b]' + 'x'.repeat(5000) + '\nvisible');
    expect(s.endsWith('\nvisible')).toBe(true);
  });

  it('stripTerminalEscapes keeps single controls (secret entry reads them)', () => {
    expect(stripTerminalEscapes('\x1b[Aab\x7f\r\x03')).toBe('ab\x7f\r\x03');
  });

  it('relayStripped filters a stream', async () => {
    const from = new PassThrough();
    let out = '';
    relayStripped(from, { write: (s: string) => { out += s; return true; } });
    from.write('a\x1b['); from.write('2Jb'); from.end('\x1b]0;x\x07c\n');
    await new Promise((r) => setImmediate(r));
    expect(out).toBe('abc\n');
  });

  it('non-TTY relay of a child process (the docker exec -T path) strips its stdout and stderr', async () => {
    let out = ''; let err = '';
    const code = await spawnRelay(process.execPath, ['-e', 'process.stdout.write("hi\\x1b[2J\\x1b]0;t\\x07!\\n"); process.stderr.write("e\\x1b[31mr\\r\\n"); process.exitCode = 3'],
      { filter: true, out: { write: (s: string) => { out += s; return true; } }, err: { write: (s: string) => { err += s; return true; } } });
    expect(code).toBe(3);
    expect(out).toBe('hi!\n');
    expect(err).toBe('er\n');
  });

  it('human output and errors printed by the CLI are stripped (container text in messages)', () => {
    const out: string[] = []; const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
    emit({ x: 1 }, { json: false, human: () => 'status \x1b]52;c;ZXZpbA==\x07ok' });
    reportError(new MinionsError('PRECONDITION', 'sync failed: \x1b[2Jboom', 'hint\x1b[1m'), { json: false });
    emit({ s: '\x1b[31m' }, { json: true });
    vi.restoreAllMocks();
    expect(out[0]).toBe('status ok\n');
    expect(err.join('')).toBe('error [PRECONDITION]: sync failed: boom\nhint: hint\n');
    expect(JSON.parse(out[1]!)).toEqual({ ok: true, data: { s: '\x1b[31m' } }); // JSON escapes, unchanged
  });

  it('wizard secret entry uses the shared helper (no ad-hoc ANSI regex left)', () => {
    const src = readFileSync(join(ROOT, 'src', 'host', 'wizard.ts'), 'utf8');
    expect(src).toContain('stripTerminalEscapes(');
    expect(src).not.toMatch(/\\x1b\\\[/);
  });
});

describe('source fingerprint and symlinks', () => {
  const checkout = () => {
    const c = tmp('minions-fp-');
    writeFileSync(join(c, 'package.json'), '{"name":"minions","version":"0.2.0"}');
    for (const d of ['src', 'templates', 'docker', 'scripts']) mkdirSync(join(c, d));
    writeFileSync(join(c, 'src', 'a.ts'), 'a');
    return c;
  };

  it('ignores a symlinked top-level src/ pointing outside the checkout', () => {
    const c = checkout();
    const base = sourceFingerprint(c);
    const outside = tmp('minions-out-');
    writeFileSync(join(outside, 'secret.ts'), 'secret');
    rmSync(join(c, 'src'), { recursive: true });
    symlinkSync(outside, join(c, 'src'));
    const linked = sourceFingerprint(c);
    writeFileSync(join(outside, 'secret.ts'), 'changed');
    expect(sourceFingerprint(c)).toBe(linked); // outside content never read
    expect(linked).not.toBe(base);
  });

  it('ignores nested directory and file symlinks', () => {
    const c = checkout();
    const base = sourceFingerprint(c);
    const outside = tmp('minions-out-');
    writeFileSync(join(outside, 'x.ts'), 'x');
    symlinkSync(outside, join(c, 'src', 'linkdir'));
    symlinkSync(join(outside, 'x.ts'), join(c, 'src', 'link.ts'));
    symlinkSync(join(c, 'src'), join(c, 'src', 'loop'));
    expect(sourceFingerprint(c)).toBe(base);
  });

  it('caps traversal depth', () => {
    const c = checkout();
    let d = join(c, 'src');
    for (let i = 0; i < MAX_FINGERPRINT_DEPTH + 2; i++) { d = join(d, 'd'); mkdirSync(d); }
    writeFileSync(join(d, 'deep.ts'), '1');
    const fp = sourceFingerprint(c);
    writeFileSync(join(d, 'deep.ts'), '2');
    expect(sourceFingerprint(c)).toBe(fp);
    expect(MAX_FINGERPRINT_FILES).toBeGreaterThan(1000);
  });
});
