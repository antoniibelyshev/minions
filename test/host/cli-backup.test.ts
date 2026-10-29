// The CLI backup for real (src/host/cli-backup.ts): no faked npm. The backup must work for an install whose
// `prepare` script cannot run (the shipped minions package has `prepare: node scripts/prepare.mjs` but no
// scripts/), and `npm install -g <backup>` must bring the same files back byte for byte.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../src/core/exec.js';
import { backupInstalledCli, installCliBackup } from '../../src/host/cli-backup.js';
import { sha256File } from '../../src/core/fsutil.js';
import { tempDir, withHome } from './fixtures.js';

let home: ReturnType<typeof withHome>;
beforeEach(() => { home = withHome(); });
afterEach(() => home.cleanup());

/** Every regular file under `dir` (relative path -> bytes, mode bits). */
function files(dir: string): Map<string, { data: string; exec: boolean }> {
  const out = new Map<string, { data: string; exec: boolean }>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(relative(dir, p), { data: readFileSync(p).toString('base64'), exec: (statSync(p).mode & 0o100) !== 0 });
    }
  };
  walk(dir);
  return out;
}

describe('backupInstalledCli and installCliBackup (real npm)', () => {
  it('backs up an install whose prepare script fails and reinstalls it byte for byte', async () => {
    const install = join(tempDir('minions-install-'), 'minions');
    mkdirSync(join(install, 'dist'), { recursive: true });
    const pkg = { name: 'minions', version: '0.1.0', type: 'module', bin: { minions: 'dist/cli.js' }, scripts: { prepare: 'node scripts/prepare.mjs && exit 1' } };
    writeFileSync(join(install, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    writeFileSync(join(install, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("0.1.0");\n');
    chmodSync(join(install, 'dist', 'cli.js'), 0o755);
    writeFileSync(join(install, 'dist', 'build-info.json'), '{"source":"abc","kind":"packed"}\n');
    // A path longer than the 100-byte tar name field, and binary content.
    const deep = join(install, 'docs', 'design', 'a-rather-long-directory-name-for-the-tar-name-field', 'and-a-long-file-name-as-well-0123456789.md');
    mkdirSync(join(deep, '..'), { recursive: true });
    writeFileSync(deep, 'deep\n');
    writeFileSync(join(install, 'templates.bin'), Buffer.from([0, 1, 2, 255, 254, 10, 13]));
    // Left out: a top-level node_modules and a symlink (npm pack leaves both out too).
    mkdirSync(join(install, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(install, 'node_modules', 'x', 'index.js'), '');
    symlinkSync('/etc/passwd', join(install, 'link'));

    // npm pack of the directory runs prepare even with --ignore-scripts, which is why the backup does not use it.
    const pack = await run('npm', ['pack', install, '--ignore-scripts', '--dry-run'], { cwd: tempDir('minions-pack-'), allowFailure: true, timeoutMs: 120_000 });
    expect(pack.code).not.toBe(0);

    const logs: string[] = [];
    const b = await backupInstalledCli(install, '0.1.0', { log: (m) => logs.push(m) });
    expect(b.version).toBe('0.1.0');
    expect(statSync(b.file).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).toMatch(/left out of the backup .*link.*node_modules|left out of the backup .*node_modules.*link/);

    // A standard tar reads it, everything under package/.
    const listed = execFileSync('tar', ['-tzf', b.file]).toString().trim().split('\n');
    expect(listed.every((n) => n.startsWith('package/'))).toBe(true);
    expect(listed).toContain(`package/${relative(install, deep)}`);

    // Restore into a scratch global prefix with the real npm (offline: the package has no dependencies).
    const prefix = tempDir('minions-prefix-');
    const npmEnv = { npm_config_prefix: prefix, npm_config_cache: join(prefix, '.cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false' };
    const runner = (cmd: string, args: string[], o?: RunOptions) => run(cmd, args, { ...o, env: { ...(o?.env ?? process.env), ...npmEnv } });
    const done = await installCliBackup(b.name, await sha256File(b.file), { runner });
    expect(done).toMatch(/reinstalled minions 0\.1\.0/);

    const installed = join(prefix, 'lib', 'node_modules', 'minions');
    const expected = files(install);
    for (const k of [...expected.keys()]) if (k.startsWith('node_modules')) expected.delete(k);
    expect(files(installed)).toEqual(expected);
    expect(execFileSync(join(prefix, 'bin', 'minions')).toString().trim()).toBe('0.1.0');
  }, 120_000);

  it('a directory without package.json is no backup: it throws and keeps nothing', async () => {
    const dir = tempDir('minions-install-');
    await expect(backupInstalledCli(dir, '0.1.0')).rejects.toThrow(/has no package\.json/);
    await expect(backupInstalledCli(join(dir, 'missing'), '0.1.0')).rejects.toThrow(/is not a directory/);
  });
});
