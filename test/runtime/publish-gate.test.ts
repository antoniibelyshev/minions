// The sensitive-path gate (publish.ts gateChangedPaths) over an injected history reader (unit tier, task-137.2.2):
// which bases are diffed, how their paths are unioned and matched, and every fail-closed answer. The real-git
// end-to-end checks (a forged origin, a moved local base) stay in publish.test.ts and gate-forged-remote.test.ts.
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import type { GitFn } from '../../src/runtime/github.js';
import { gateChangedPaths } from '../../src/runtime/publish.js';
import { defaults } from '../helpers.js';

const sha = (c: string) => c.repeat(40);
const HEAD = sha('f');
const RECORDED = sha('a');
const SERVER = sha('b');
const SENSITIVE = defaults('project-owner').sensitivePaths;

/**
 * A fake hardened reader: `commits` resolve with rev-parse, `refs` are the local base refs present, `diffs`
 * maps a base to the paths `base...HEAD` lists, `unrelated` bases have no merge base with HEAD.
 */
function history(o: { commits?: string[]; refs?: string[]; diffs?: Record<string, string[]>; unrelated?: string[]; failDiff?: string[] } = {}) {
  const calls: string[][] = [];
  const known = new Set([...(o.commits ?? [RECORDED, SERVER]), ...(o.refs ?? [])]);
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const git: GitFn = async (_cwd, args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return known.has(args[3]!.replace(/\^\{commit\}$/, '')) ? ok(args[3]) : { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'merge-base') return o.unrelated?.includes(args[1]!) ? { code: 1, stdout: '', stderr: '' } : ok(`${args[1]}\n`);
    if (args[0] === 'diff') {
      const base = args.at(-1)!.split('...')[0]!;
      if (o.failDiff?.includes(base)) return { code: 128, stdout: '', stderr: 'fatal: bad object' };
      const paths = o.diffs?.[base] ?? [];
      return ok(paths.length ? `${paths.join('\0')}\0` : '');
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls, diffs: () => calls.filter((c) => c[0] === 'diff').map((c) => c.at(-1)) };
}

const gate = (h: ReturnType<typeof history>, over: Partial<Parameters<typeof gateChangedPaths>[0]> = {}) => gateChangedPaths({
  gateGit: h.git, repo: '/repo', base: 'main', head: HEAD, branch: 'agent/t', baseShas: [RECORDED], serverBase: SERVER,
  sensitivePaths: SENSITIVE, ...over,
});

describe('sensitive-path gate (injected history)', () => {
  const sensitive: [string, string[]][] = [
    ['nested migrations dir', ['svc/api/migrations/0001.sql']],
    ['top-level migrations dir', ['migrations/0001.sql']],
    ['dotfile-dir .claude', ['.claude/settings.json']],
    ['CLAUDE.md', ['CLAUDE.md']],
    ['a deleted or renamed-away workflow (diff lists the old side)', ['.github/workflows/ci.yml', 'docs/ci.yml']],
    ['deploy tree', ['deploy/k8s/app.yaml']],
    ['CODEOWNERS', ['.github/CODEOWNERS']],
    ['one sensitive among many', ['a.ts', 'b.ts', 'infra/main.tf']],
  ];
  it.each(sensitive)('flags %s', async (_name, paths) => {
    const r = await gate(history({ diffs: { [RECORDED]: paths } }));
    expect(r.ok && r.sensitivePaths.length).toBeGreaterThan(0);
  });

  const benign: [string, string[]][] = [
    ['a file merely named migrations.md', ['docs/migrations.md']],
    ['a migrations-like prefix', ['migrations_old/readme.md']],
    ['a non-sensitive .github file', ['.github/ISSUE_TEMPLATE/bug.md']],
    ['claude-ish names', ['src/claude.md', 'CLAUDE.md.bak']],
    ['deployment/', ['deployment/x.yaml']],
  ];
  it.each(benign)('does not flag %s', async (_name, paths) => {
    const r = await gate(history({ diffs: { [RECORDED]: paths } }));
    expect(r).toMatchObject({ ok: true, changedPaths: paths, sensitivePaths: [] });
  });

  it('diffs with the old side of renames and deletions, never through external diff drivers', async () => {
    const h = history();
    await gate(h);
    const diff = h.calls.find((c) => c[0] === 'diff')!;
    expect(diff).toEqual(expect.arrayContaining(['--name-only', '--no-renames', '--no-ext-diff', '-z']));
  });

  it('unions every base: a local base ref moved to the head cannot hide a path the recorded or server base shows', async () => {
    const h = history({ refs: ['refs/heads/main'], diffs: { [RECORDED]: [], [SERVER]: ['.github/workflows/ci.yml'], 'refs/heads/main': [] } });
    const r = await gate(h);
    expect(r).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
    expect(h.diffs()).toEqual([`${RECORDED}...${HEAD}`, `${SERVER}...${HEAD}`, `refs/heads/main...${HEAD}`]);
  });

  it('fails closed without a trustworthy base: local refs alone never carry the gate', async () => {
    const h = history({ commits: [], refs: ['refs/heads/main', 'refs/remotes/origin/main'] });
    const r = await gate(h, { baseShas: [null], serverBase: null });
    expect(r).toMatchObject({ ok: false, code: 'PRECONDITION' });
    expect(h.diffs()).toEqual([]);
  });

  it('recorded values that look like options or revision expressions are ignored, never passed to git', async () => {
    const h = history({ diffs: { [SERVER]: ['CLAUDE.md'] } });
    const r = await gate(h, { baseShas: ['--output=/tmp/x', 'HEAD~1', 'main', `${RECORDED}^`, null] });
    expect(r).toMatchObject({ ok: true, sensitivePaths: ['CLAUDE.md'] });
    expect(h.calls.flat().some((a) => /--output|HEAD~1|\^$/.test(a))).toBe(false);
  });

  it('a garbage-collected recorded base is skipped; the server base carries the gate', async () => {
    const h = history({ commits: [SERVER], diffs: { [SERVER]: ['a.ts'] } });
    expect(await gate(h)).toMatchObject({ ok: true, changedPaths: ['a.ts'] });
    expect(h.diffs()).toEqual([`${SERVER}...${HEAD}`]);
  });

  it('duplicate recorded bases (many leases) are diffed once', async () => {
    const h = history();
    await gate(h, { baseShas: [RECORDED, RECORDED, RECORDED, null], serverBase: RECORDED });
    expect(h.diffs()).toEqual([`${RECORDED}...${HEAD}`]);
  });

  it('unrelated history fails closed with PRECONDITION even next to a usable base (never skipped)', async () => {
    const r = await gate(history({ unrelated: [SERVER], diffs: { [RECORDED]: ['a.ts'] } }));
    expect(r).toMatchObject({ ok: false, code: 'PRECONDITION' });
    expect(!r.ok && r.message).toMatch(/unrelated history/);
  });

  it('a failing diff is an error, not an empty change set', async () => {
    expect(await gate(history({ failDiff: [RECORDED] }))).toMatchObject({ ok: false, code: 'INTERNAL' });
  });

  it('unusual file names (leading dashes, quotes, newlines, pathspec magic) are reported verbatim and matched', async () => {
    const odd = ['-rf', '"q".txt', 'line\nbreak.txt', ':(glob)x', '--', 'deploy/-x.yaml'];
    const r = await gate(history({ diffs: { [RECORDED]: odd } }));
    expect(r).toMatchObject({ ok: true, changedPaths: odd, sensitivePaths: ['deploy/-x.yaml'] });
  });
});
