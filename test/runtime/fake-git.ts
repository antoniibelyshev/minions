// In-memory git for scheduler tests in the unit tier (task-137.2.4). The claim/brief/submit/record pipeline only
// reads a handful of git facts (rev-parse, branch, worktree add/list/remove, status, merge-base --is-ancestor,
// diff --name-only); real git made every such test a subprocess-heavy integration test. A test file opts in with
//
//   vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));
//
// and fixtures.ts (initRepo, commitFile, gitSync, makeEnv) then works on the fake. Production code is unchanged:
// only `run('git', ...)` calls whose cwd is inside a fake repository are answered here; every other command goes to
// the real `run` (which the unit tier refuses). A few end-to-end files keep real git (see test/tiers.ts).
//
// Model: a commit is a snapshot of the work tree's files (no index: `add` is a no-op, `commit` snapshots the whole
// tree, `rm`/`mv` are file operations). History is linear per commit (one parent; no merges).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { MinionsError } from '../../src/core/errors.js';
import type * as Exec from '../../src/core/exec.js';
import type { RunOptions, RunResult } from '../../src/core/exec.js';

type Tree = Record<string, string>;
interface Commit { sha: string; parent: string | null; tree: Tree; message: string }
interface Worktree { path: string; branch: string | null; head: string }
interface Repo { path: string; commits: Map<string, Commit>; branches: Map<string, string>; worktrees: Worktree[] }

// Module state: one instance per test file (the vi.mock factory imports this same module as fixtures.ts does), so a
// file that never installs the fake keeps real git even in a worker that ran one that did.
const repos: Repo[] = [];
let active = false;

/** True once this test file installed the fake (mockExec): fixtures.ts then routes its git helpers here. */
export const fakeGitActive = () => active;

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const within = (dir: string, p: string) => p === dir || p.startsWith(dir + sep);

let counter = 0;
const newSha = (parent: string | null, tree: Tree, message: string) =>
  createHash('sha1').update(JSON.stringify([parent, tree, message, ++counter])).digest('hex');

function snapshot(dir: string): Tree {
  const out: Tree = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function checkout(dir: string, tree: Tree): void {
  for (const f of Object.keys(snapshot(dir))) if (!(f in tree)) rmSync(join(dir, f));
  for (const [f, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), content);
  }
}

/** The repository and work tree that `cwd` belongs to (a linked worktree wins over the main one). */
function locate(cwd: string): { repo: Repo; wt: Worktree } | null {
  const c = real(cwd);
  let best: { repo: Repo; wt: Worktree } | null = null;
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      if (within(real(wt.path), c) && (!best || real(wt.path).length > real(best.wt.path).length)) best = { repo, wt };
    }
  }
  return best;
}

const headSha = (repo: Repo, wt: Worktree) => (wt.branch ? repo.branches.get(wt.branch)! : wt.head);

function resolveRef(repo: Repo, wt: Worktree, ref: string): string | null {
  let r = ref.replace(/\^\{commit\}$/, '');
  let up = 0;
  const m = /^(.*?)~(\d+)$/.exec(r);
  if (m) { r = m[1]!; up = Number(m[2]); }
  let sha: string | null = null;
  if (r === 'HEAD') sha = headSha(repo, wt);
  else if (r.startsWith('refs/heads/')) sha = repo.branches.get(r.slice(11)) ?? null;
  else if (r.startsWith('refs/')) sha = null;
  else if (repo.branches.has(r)) sha = repo.branches.get(r)!;
  else if (/^[0-9a-f]{4,40}$/.test(r)) {
    const hits = [...repo.commits.keys()].filter((k) => k.startsWith(r));
    sha = hits.length === 1 ? hits[0]! : null;
  }
  for (let i = 0; i < up && sha; i++) sha = repo.commits.get(sha)!.parent;
  return sha;
}

function ancestors(repo: Repo, sha: string): string[] {
  const out: string[] = [];
  for (let s: string | null = sha; s; s = repo.commits.get(s)!.parent) out.push(s);
  return out;
}

const changed = (a: Tree, b: Tree) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });

/** Leading `-c key=value` / `--no-pager` / `-C dir` options, as the hardened and gate git calls add them. */
function strip(args: string[], cwd: string): { args: string[]; cwd: string } {
  const a = [...args];
  while (a.length) {
    if (a[0] === '-c') a.splice(0, 2);
    else if (a[0] === '--no-pager') a.shift();
    else if (a[0] === '-C') { cwd = resolve(cwd, a[1]!); a.splice(0, 2); }
    else break;
  }
  return { args: a, cwd };
}

function commitTree(repo: Repo, wt: Worktree, tree: Tree, message: string): string {
  const parent = headSha(repo, wt);
  const sha = newSha(parent, tree, message);
  repo.commits.set(sha, { sha, parent, tree, message });
  if (wt.branch) repo.branches.set(wt.branch, sha); else wt.head = sha;
  return sha;
}

/** Answers one git command in a fake repository. */
export function fakeGit(cwd0: string, args0: string[]): RunResult {
  const { args, cwd } = strip(args0, cwd0);
  const loc = locate(cwd);
  if (!loc) return fail(`fatal: not a git repository: ${cwd}`, 128);
  const { repo, wt } = loc;
  const [sub, ...rest] = args;
  const flags = rest.filter((x) => x.startsWith('-'));
  const pos = rest.filter((x) => !x.startsWith('-'));
  switch (sub) {
    case 'rev-parse': {
      if (flags.includes('--is-inside-work-tree')) return ok('true\n');
      if (flags.includes('--show-toplevel')) return ok(`${real(wt.path)}\n`);
      if (flags.includes('--git-common-dir')) return ok(`${join(real(repo.path), '.git')}\n`);
      if (flags.includes('--abbrev-ref')) return ok(`${wt.branch ?? 'HEAD'}\n`);
      const sha = resolveRef(repo, wt, pos[0] ?? 'HEAD');
      return sha ? ok(`${sha}\n`) : fail(flags.includes('--quiet') ? '' : `fatal: bad revision '${pos[0]}'`, flags.includes('--quiet') ? 1 : 128);
    }
    case 'symbolic-ref':
      if (!wt.branch) return fail('', 1);
      return ok(flags.includes('--short') ? `${wt.branch}\n` : `refs/heads/${wt.branch}\n`);
    case 'branch': {
      if (flags.includes('--list') || pos.length === 0) {
        const pat = pos[0] ? new RegExp(`^${pos[0].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) : /.*/;
        return ok([...repo.branches.keys()].filter((b) => pat.test(b)).sort().map((b) => `${b === wt.branch ? '*' : ' '} ${b}\n`).join(''));
      }
      const [name, start] = pos;
      if (repo.branches.has(name!) && !flags.includes('-f')) return fail(`fatal: a branch named '${name}' already exists`, 128);
      const sha = resolveRef(repo, wt, start ?? 'HEAD');
      if (!sha) return fail(`fatal: not a valid object name: '${start}'`, 128);
      repo.branches.set(name!, sha);
      return ok();
    }
    case 'worktree': {
      const [action, ...wargs] = rest;
      const wpos = wargs.filter((x) => !x.startsWith('-'));
      if (action === 'list') {
        return ok(repo.worktrees.map((w) => `worktree ${w.path}\nHEAD ${headSha(repo, w)}\n${w.branch ? `branch refs/heads/${w.branch}` : 'detached'}\n\n`).join(''));
      }
      if (action === 'add') {
        const path = resolve(cwd, wpos[0]!);
        const detach = wargs.includes('--detach');
        const ref = wpos[1]!;
        const sha = resolveRef(repo, wt, ref);
        if (!sha) return fail(`fatal: invalid reference: ${ref}`, 128);
        if (!detach && repo.worktrees.some((w) => w.branch === ref)) return fail(`fatal: '${ref}' is already checked out`, 128);
        if (existsSync(path) && readdirSync(path).length) return fail(`fatal: '${path}' already exists`, 128);
        mkdirSync(path, { recursive: true });
        checkout(path, repo.commits.get(sha)!.tree);
        repo.worktrees.push({ path, branch: detach ? null : ref, head: sha });
        return ok();
      }
      if (action === 'remove') {
        const target = real(resolve(cwd, wpos[0]!));
        const i = repo.worktrees.findIndex((w, n) => n > 0 && real(w.path) === target);
        if (i < 0) return fail(`fatal: '${wpos[0]}' is not a working tree`, 128);
        rmSync(repo.worktrees[i]!.path, { recursive: true, force: true });
        repo.worktrees.splice(i, 1);
        return ok();
      }
      if (action === 'prune') return ok();
      break;
    }
    case 'status': {
      const head = repo.commits.get(headSha(repo, wt))!.tree;
      const now = snapshot(wt.path);
      return ok(changed(head, now).map((f) => `${!(f in head) ? '??' : !(f in now) ? ' D' : ' M'} ${f}\n`).join(''));
    }
    case 'merge-base': {
      const [a, b] = pos.map((r) => resolveRef(repo, wt, r));
      if (!a || !b) return fail('fatal: not a valid object name', 128);
      if (flags.includes('--is-ancestor')) return ancestors(repo, b).includes(a) ? ok() : fail('', 1);
      const bs = new Set(ancestors(repo, b));
      const base = ancestors(repo, a).find((s) => bs.has(s));
      return base ? ok(`${base}\n`) : fail('', 1);
    }
    case 'diff': {
      let from: string | null; let to: string | null;
      if (pos.length === 1 && pos[0]!.includes('...')) {
        const [x, y] = pos[0]!.split('...');
        const a = resolveRef(repo, wt, x!); to = resolveRef(repo, wt, y!);
        const bs = new Set(to ? ancestors(repo, to) : []);
        from = a ? ancestors(repo, a).find((s) => bs.has(s)) ?? null : null;
      } else {
        from = resolveRef(repo, wt, pos[0]!); to = resolveRef(repo, wt, pos[1]!);
      }
      if (!from || !to) return fail('fatal: bad revision', 128);
      const files = changed(repo.commits.get(from)!.tree, repo.commits.get(to)!.tree);
      return ok(flags.includes('-z') ? files.map((f) => `${f}\0`).join('') : files.map((f) => `${f}\n`).join(''));
    }
    case 'add': return ok();
    case 'rm': for (const f of pos) rmSync(join(wt.path, f), { force: true }); return ok();
    case 'mv': {
      const [a, b] = pos;
      mkdirSync(dirname(join(wt.path, b!)), { recursive: true });
      renameSync(join(wt.path, a!), join(wt.path, b!));
      return ok();
    }
    case 'commit': {
      const mi = rest.indexOf('-m');
      const tree = snapshot(wt.path);
      if (!changed(repo.commits.get(headSha(repo, wt))!.tree, tree).length && !rest.includes('--allow-empty')) return fail('nothing to commit, working tree clean', 1);
      commitTree(repo, wt, tree, mi >= 0 ? rest[mi + 1]! : '');
      return ok();
    }
    case 'reset': {
      const sha = resolveRef(repo, wt, pos[0] ?? 'HEAD');
      if (!sha) return fail('fatal: bad revision', 128);
      if (wt.branch) repo.branches.set(wt.branch, sha); else wt.head = sha;
      if (flags.includes('--hard')) checkout(wt.path, repo.commits.get(sha)!.tree);
      return ok();
    }
    case 'log': {
      const sha = resolveRef(repo, wt, pos[0] ?? 'HEAD');
      if (!sha) return fail('fatal: bad revision', 128);
      return ok(`${repo.commits.get(sha)!.message}\n`);
    }
    case 'config': return ok();
  }
  return fail(`fake git: unsupported command: git ${args.join(' ')}`, 129);
}

/** A fake repository at `dir` with one commit (README.md) on `branch`; returns its SHA. */
export function fakeInitRepo(dir: string, branch = 'main'): string {
  mkdirSync(join(dir, '.git'), { recursive: true });
  const prior = snapshot(dir);
  const tree: Tree = Object.keys(prior).length ? prior : { 'README.md': '# test\n' };
  checkout(dir, tree);
  const sha = newSha(null, tree, 'init');
  const repo: Repo = { path: resolve(dir), commits: new Map([[sha, { sha, parent: null, tree, message: 'init' }]]), branches: new Map([[branch, sha]]), worktrees: [] };
  repo.worktrees.push({ path: resolve(dir), branch, head: sha });
  repos.push(repo);
  return sha;
}

/** `git <args>` in `cwd` on the fake, as fixtures.gitSync: trimmed stdout, throws on a non-zero exit. */
export function fakeGitSync(cwd: string, ...args: string[]): string {
  const r = fakeGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
  return r.stdout.trim();
}

/** The vi.mock factory body for src/core/exec.js: git in a fake repository is answered in memory. */
export function mockExec(orig: typeof Exec): typeof Exec {
  active = true;
  const run = (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    if (cmd !== 'git' || !locate(strip(args, opts.cwd ?? process.cwd()).cwd)) return orig.run(cmd, args, opts);
    const r = fakeGit(opts.cwd ?? process.cwd(), args);
    if (r.code !== 0 && !opts.allowFailure) {
      return Promise.reject(new MinionsError('INTERNAL', `git exited with code ${r.code}: ${r.stderr}`, undefined, { cmd: 'git', args, code: r.code }));
    }
    return Promise.resolve(r);
  };
  return { ...orig, run };
}
