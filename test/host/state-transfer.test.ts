import { copyFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectPaths } from '../../src/core/paths.js';
import { MinionsError } from '../../src/core/errors.js';
import type { ProjectJson } from '../../src/host/project.js';
import { Compose, type Runner } from '../../src/host/docker.js';
import { composeTarget, exportState, importState, type TransferTarget } from '../../src/host/transfer.js';
import { buildProgram } from '../../src/program.js';
import { openDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { createStateBackup, restoreStateBackup } from '../../src/runtime/state-backup.js';
import { withHome } from './fixtures.js';

const ID = '3f2b8c1e-7d4a-4e9b-9c2f-1a2b3c4d5e6f';
const project: ProjectJson = {
  version: 1, projectId: ID, repoPath: '/Users/x/repo', gitCommonDir: '/Users/x/repo/.git', visibility: 'private',
  profile: 'personal-work', imageTag: 'minions-runtime:0.1.0', baseBranch: 'main', remoteUrl: null,
  gitIdentity: { name: 'Ada', email: 'ada@example.com' },
  container: { cpus: 4, memoryMiB: 6144, pidsLimit: 512, publishPorts: [], network: 'outbound-internet' },
};

const rtPaths = (root: string) => runtimePaths({ MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') } as NodeJS.ProcessEnv, { inContainer: false });

/** A fake runtime: exec runs the runtime-side state commands in-process against `root`. */
function fakeRuntime(root: string): TransferTarget & { puts: string[]; execs: string[][] } {
  const p = rtPaths(root);
  const dirs = { import: join(root, 'state', 'import'), exports: join(root, 'state', 'exports') };
  mkdirSync(dirs.import, { recursive: true }); mkdirSync(dirs.exports, { recursive: true });
  const puts: string[] = [];
  const execs: string[][] = [];
  return {
    dirs, puts, execs,
    async exec(args) {
      execs.push(args);
      try {
        const data = args[2] === 'state-export' ? await createStateBackup(p, args[3]!)
          : await restoreStateBackup(p, args[3]!, { force: args.includes('--force'), alive: () => false });
        return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, data }) };
      } catch (e) {
        const m = e as MinionsError;
        return { code: 1, stderr: '', stdout: JSON.stringify({ ok: false, error: { code: m.code, message: m.message, hint: m.hint, ...(m.details !== undefined ? { details: m.details } : {}) } }) };
      }
    },
    async putFile(local, remote) { puts.push(remote); await copyFile(local, remote); },
    async getFile(remote, local) { await copyFile(remote, local); },
    async removeFile(remote) { rmSync(remote, { force: true }); },
  };
}

function seedRuntime(root: string): void {
  const p = rtPaths(root);
  mkdirSync(join(root, 'secrets'), { recursive: true });
  writeFileSync(join(root, 'secrets', 'github-token'), 'ghp_HOSTTESTSECRET987654321\n');
  mkdirSync(join(p.backlog, 'backlog', 'tasks'), { recursive: true });
  writeFileSync(join(p.backlog, 'backlog', 'tasks', 'task-7 - Thing.md'), 'task seven\n');
  mkdirSync(p.notes, { recursive: true });
  writeFileSync(join(p.notes, 'n.md'), 'note\n');
  const d = openDb(p.db);
  d.exec(`INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('l1', 'task-7', 'engineer', 1, 3, 'now', 'completed')`);
  d.close();
}

describe('minions export --state / import --state (host side)', () => {
  let env: ReturnType<typeof withHome>;
  beforeEach(() => { env = withHome(); });
  afterEach(() => env.cleanup());

  it('backs up one runtime and restores it into a fresh one', async () => {
    const src = fakeRuntime(join(env.root, 'src'));
    seedRuntime(join(env.root, 'src'));
    const out = await exportState(project, { target: src });
    expect(out.archive.startsWith(projectPaths(ID).exportsDir)).toBe(true);
    expect(out.archive).toMatch(/state-[\w-]+\.tar\.gz$/);
    expect(statSync(out.archive).mode & 0o777).toBe(0o600);
    expect(readFileSync(out.archive).includes('ghp_HOSTTESTSECRET')).toBe(false);
    expect(src.execs[0]).toEqual(['minions', 'workspace', 'state-export', expect.stringMatching(/\/exports\/state-[\w-]+\.tar\.gz$/), '--json']);

    const dstRoot = join(env.root, 'dst');
    const dst = fakeRuntime(dstRoot);
    openDb(rtPaths(dstRoot).db).close();
    const r = await importState(project, out.archive, { target: dst });
    expect(r.files).toBe(out.files);
    expect(dst.puts[0]).toMatch(/\/import\/import-state-[\w-]+\.tar\.gz$/);
    const p = rtPaths(dstRoot);
    expect(readFileSync(join(p.backlog, 'backlog', 'tasks', 'task-7 - Thing.md'), 'utf8')).toBe('task seven\n');
    expect(readFileSync(join(p.notes, 'n.md'), 'utf8')).toBe('note\n');
    const d = openDb(p.db);
    expect(d.all<{ id: string }>('SELECT id FROM leases').map((l) => l.id)).toEqual(['l1']);
    d.close();
  });

  it('works through a compose/Runner fake (container paths are never lstat-ed on the host)', async () => {
    const src = fakeRuntime(join(env.root, 'src'));
    seedRuntime(join(env.root, 'src'));
    const dstRoot = join(env.root, 'dst');
    const dst = fakeRuntime(dstRoot);
    openDb(rtPaths(dstRoot).db).close();
    // Container paths do not exist on the host: map them onto the fake runtime dirs.
    const calls: string[][] = [];
    const mk = (t: TransferTarget): Runner => async (_cmd, args) => {
      calls.push(args);
      const mapPath = (x: string) => x.replace(/^[^:/]*:/, '').replace('/state/exports', t.dirs.exports).replace('/state/import', t.dirs.import);
      if (args.includes('exec')) return t.exec(args.slice(args.indexOf('minions')).map(mapPath));
      if (args.includes('cp')) {
        const [a, b] = args.slice(-2) as [string, string];
        await copyFile(mapPath(a), mapPath(b));
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error('unexpected ' + args.join(' '));
    };
    const out = await exportState(project, { target: composeTarget(new Compose(ID, mk(src))) });
    expect(existsSync(out.archive)).toBe(true);
    expect(calls.some((a) => a.includes('cp'))).toBe(true);
    const r = await importState(project, out.archive, { target: composeTarget(new Compose(ID, mk(dst))) });
    expect(r.files).toBe(out.files);
    expect(readFileSync(join(rtPaths(dstRoot).notes, 'n.md'), 'utf8')).toBe('note\n');
  });

  it('host runtime (hostFs) refuses a non-regular backup before copying it', async () => {
    const root = join(env.root, 'src');
    const base = fakeRuntime(root);
    seedRuntime(root);
    const getFile = vi.fn(base.getFile);
    const evil: TransferTarget = {
      ...base, hostFs: true, getFile,
      async exec(args) {
        const r = await base.exec(args);
        const f = args[3]!;
        rmSync(f); symlinkSync('/etc/hostname', f); // swap the backup for a symlink
        return r;
      },
    };
    await expect(exportState(project, { target: evil })).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect(getFile).not.toHaveBeenCalled();
  });

  it('writes to an explicit file and never overwrites one', async () => {
    const src = fakeRuntime(join(env.root, 'src'));
    seedRuntime(join(env.root, 'src'));
    const file = join(env.root, 'backup.tar.gz');
    expect((await exportState(project, { target: src, out: file })).archive).toBe(file);
    await expect(exportState(project, { target: src, out: file })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('validates the archive on the host before copying anything into the runtime', async () => {
    const dst = fakeRuntime(join(env.root, 'dst'));
    const bad = join(env.root, 'bad.tar.gz');
    writeFileSync(bad, 'garbage');
    await expect(importState(project, bad, { target: dst })).rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(importState(project, join(env.root, 'missing.tar.gz'), { target: dst })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dst.puts).toEqual([]);
    expect(dst.execs).toEqual([]);
  });

  it('keeps the runtime CONFLICT when a worker lease is active, and passes --force through', async () => {
    const src = fakeRuntime(join(env.root, 'src'));
    seedRuntime(join(env.root, 'src'));
    const { archive } = await exportState(project, { target: src });
    const dstRoot = join(env.root, 'dst');
    const dst = fakeRuntime(dstRoot);
    const d = openDb(rtPaths(dstRoot).db);
    d.exec(`INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('busy', 'task-9', 'engineer', 1, 3, 'now', 'active')`);
    d.close();
    const err = await importState(project, archive, { target: dst }).then(() => null, (e: unknown) => e as MinionsError);
    expect(err).toMatchObject({ code: 'CONFLICT' });
    // The runtime's own details, not the whole error envelope nested under details.
    expect(err!.details).toEqual({ activeLeases: ['busy'], coordinatorPid: null });
    expect(err!.hint).toMatch(/minions settings restart/);
    const r = await importState(project, archive, { target: dst, force: true });
    expect(dst.execs.at(-1)).toContain('--force');
    expect(r.container.forced).toBe(true);
    expect(existsSync(join(rtPaths(dstRoot).notes, 'n.md'))).toBe(true);
    // Archive copies do not pile up in the runtime transfer dirs (success or refusal).
    expect(readdirSync(dst.dirs.import)).toEqual([]);
    expect(readdirSync(src.dirs.exports)).toEqual([]);
  });
});

describe('CLI surface for state backup', () => {
  it('folds backup/restore into export/import (no new top-level command)', () => {
    const program = buildProgram();
    const cmd = (n: string) => program.commands.find((c) => c.name() === n)!;
    expect(cmd('export').options.map((o) => o.long)).toContain('--state');
    expect(cmd('import').options.map((o) => o.long)).toEqual(expect.arrayContaining(['--state', '--force']));
    const names = program.commands.map((c) => c.name());
    expect(names.some((n) => /backup|restore/.test(n))).toBe(false);
    const ws = cmd('workspace').commands.map((c) => c.name());
    expect(ws).toEqual(expect.arrayContaining(['state-export', 'state-import']));
  });
});

describe('docs/troubleshooting.md', () => {
  const root = join(import.meta.dirname, '..', '..');
  const doc = readFileSync(join(root, 'docs', 'troubleshooting.md'), 'utf8');

  it('is linked from the README', () => {
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('](docs/troubleshooting.md)');
  });

  it('covers each listed failure with commands', () => {
    for (const heading of [/^## Docker is not running/m, /^## Claude authorization expired/m, /^## The coordinator died/m, /^## A lease is stuck/m,
      /^## Telegram: pairing/m, /^## Token problems/m, /^## A failed or interrupted upgrade/m]) {
      expect(doc).toMatch(heading);
    }
    const sections = doc.split(/^## /m).slice(1);
    for (const s of sections) expect(s, s.split('\n')[0]).toMatch(/`minions [a-z]/);
  });

  it('names only real commands and subcommands', () => {
    const program = buildProgram();
    // Commands in inline code spans and in shell blocks (lines starting with `minions `).
    const spans = [...doc.matchAll(/`(minions [^`]+)`/g)].map((m) => m[1]!);
    const lines = doc.split('\n').filter((l) => l.startsWith('minions ')).map((l) => l.replace(/\s+#.*$/, ''));
    const all = [...spans, ...lines].flatMap((c) => c.split(/ && /));
    expect(all.length).toBeGreaterThan(20);
    for (const c of all) {
      const [, name, sub] = c.split(/\s+/);
      const cmd = program.commands.find((x) => x.name() === name || x.aliases().includes(name!));
      expect(cmd, c).toBeDefined();
      if (sub && /^[a-z]/.test(sub) && cmd!.commands.length) expect(cmd!.commands.map((x) => x.name()), c).toContain(sub);
    }
  });
});
