// task-29 QA: extra regression coverage around the host hardening (shell round-trip of the quoted
// reinstall command, the non-TTY exec relay's exit/error behaviour, split escapes, and symlinked
// top-level fingerprint files).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceFingerprint } from '../../scripts/source-fingerprint.mjs';
import { createControlStripper, stripControlChars } from '../../src/core/control-chars.js';
import { spawnRelay } from '../../src/host/docker.js';
import { manualReinstallCommand, packedTarball } from '../../src/host/upgrade-source.js';

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const sink = () => { let s = ''; return { w: { write: (c: string) => { s += c; return true; } }, get: () => s }; };

describe('quoted tarball survives a real shell unchanged', () => {
  it.each(['0.2.0', '1.0 beta', '1"x', '$(touch pwned)', "a'b", '`id`', 'x;y&&z|w', '*'])('version %j', (v) => {
    const dir = tmp('minions-q-');
    const out = execFileSync('sh', ['-c', `printf '%s' ${packedTarball(v)}`], { cwd: dir }).toString();
    expect(out).toBe(`./minions-${v}.tgz`);
  });

  it('the full manual command parses as one install argument', () => {
    const cmd = manualReinstallCommand('/a dir/minions', '$(id)');
    expect(cmd.endsWith(`npm install -g './minions-$(id).tgz'`)).toBe(true);
    expect(cmd.startsWith(`cd '/a dir/minions' && `)).toBe(true);
  });
});

describe('non-TTY exec relay (spawnRelay)', () => {
  it('keeps a zero exit, maps a signal death to 128 and rejects ENOENT (mapped to DOCKER_UNAVAILABLE by execInherit)', async () => {
    const o = sink(); const e = sink();
    expect(await spawnRelay('sh', ['-c', 'printf ok'], { filter: true, out: o.w, err: e.w })).toBe(0);
    expect(o.get()).toBe('ok');
    expect(await spawnRelay('sh', ['-c', 'kill -TERM $$'], { filter: true, out: o.w, err: e.w })).toBe(128);
    await expect(spawnRelay(join(tmp('minions-x-'), 'missing-bin'), [], { filter: true, out: o.w, err: e.w })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('relays large output completely before resolving', async () => {
    let n = 0;
    const code = await spawnRelay(process.execPath, ['-e', 'process.stdout.write("a".repeat(3_000_000))'],
      { filter: true, out: { write: (s: string) => { n += s.length; return true; } }, err: sink().w });
    expect(code).toBe(0);
    expect(n).toBe(3_000_000);
  });
});

describe('control stripper edge cases', () => {
  it('ESC-terminated OSC split on every boundary, then CSI split mid-parameters', () => {
    const st = createControlStripper();
    const parts = ['ok\x1b', ']0;ti', 'tle\x1b', '\\done\x1b[', '3', '1mX\n'];
    expect(parts.map((p) => st.push(p)).join('') + st.end()).toBe('okdoneX\n');
  });

  it('an unterminated OSC at stream end is dropped and does not swallow the next stream', () => {
    const st = createControlStripper();
    expect(st.push('a\x1b]0;never') + st.end()).toBe('a');
    expect(st.push('after')).toBe('after');
  });

  it('ESC followed by a control character drops only the ESC', () => {
    expect(stripControlChars('\x1b\nY')).toBe('\nY');
    expect(stripControlChars('\x1b\x1b[31mX')).toBe('X');
  });

  it('\\r is dropped, so CR-based progress lines run together (documented behaviour)', () => {
    expect(stripControlChars('10%\r20%\r30%\n')).toBe('10%20%30%\n');
    expect(stripControlChars('a\r\nb\r\n')).toBe('a\nb\n');
  });
});

describe('fingerprint: symlinked top-level files', () => {
  it('a symlinked package-lock.json / esbuild.config.mjs is not read', () => {
    const c = tmp('minions-fp-');
    writeFileSync(join(c, 'package.json'), '{"name":"minions","version":"0.2.0"}');
    mkdirSync(join(c, 'src'));
    writeFileSync(join(c, 'src', 'a.ts'), 'a');
    const base = sourceFingerprint(c);
    const outside = tmp('minions-out-');
    writeFileSync(join(outside, 'lock.json'), '1');
    symlinkSync(join(outside, 'lock.json'), join(c, 'package-lock.json'));
    symlinkSync(join(outside, 'lock.json'), join(c, 'esbuild.config.mjs'));
    expect(sourceFingerprint(c)).toBe(base);
    writeFileSync(join(outside, 'lock.json'), '2');
    expect(sourceFingerprint(c)).toBe(base);
  });
});
