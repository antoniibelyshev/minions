// In-process answers to the read-only git queries `minions init` and host setup make (task-137.2.6), so a test of
// those flows can run in the unit tier (test/setup/no-subprocess.ts). Use from a test file:
//
//   vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));
//
// Only `git` calls whose answer can be read from the files of a simple repository (the ones makeRepo writes:
// loose refs, one config file, no worktrees) are answered; `status` reports a clean tree. Every other command
// goes to the real `run`, which fails in the unit tier, so a test that needs real git shows up at once.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import type * as Exec from '../../src/core/exec.js';

type ExecModule = typeof Exec;
type Result = Exec.RunResult;

function top(cwd: string): string | null {
  let dir = realpathSync(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Value of `section.key` (or `section "sub".key`) from a repository's .git/config. */
function configGet(repo: string, name: string): string | null {
  const m = /^([^.]+)\.(?:(.+)\.)?([^.]+)$/.exec(name);
  if (!m) return null;
  const [, section, sub, key] = m;
  const want = sub ? `[${section} "${sub}"]` : `[${section}]`;
  let inSection = false;
  let value: string | null = null;
  for (const raw of readFileSync(join(repo, '.git', 'config'), 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inSection = line.toLowerCase() === want.toLowerCase(); continue; }
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (inSection && kv && kv[1]!.toLowerCase() === key!.toLowerCase()) value = kv[2]!;
  }
  return value;
}

function readRef(repo: string, ref: string): string | null {
  const p = join(repo, '.git', ref);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

const ok = (stdout: string): Result => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
const no: Result = { code: 1, stdout: '', stderr: '' };

/** The answer to `git args` in `cwd`, or undefined when the query is not one this fake knows. */
export function fsGit(cwd: string, argv: string[]): Result | undefined {
  const args = [...argv];
  while (args[0] === '-c') args.splice(0, 2);
  if (args[0] === '--no-pager') args.shift();
  const repo = top(cwd);
  if (!repo) return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' };
  const head = () => readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim();
  const q = args.join(' ');
  if (q === 'rev-parse --show-toplevel') return ok(repo);
  if (q === 'rev-parse --path-format=absolute --git-common-dir') return ok(join(repo, '.git'));
  if (q === 'rev-parse HEAD') {
    const h = head();
    const sha = h.startsWith('ref: ') ? readRef(repo, h.slice(5)) : h;
    return sha ? ok(sha) : { code: 128, stdout: '', stderr: "fatal: ambiguous argument 'HEAD'\n" };
  }
  if (q === 'symbolic-ref --quiet --short HEAD') {
    const h = head();
    return h.startsWith('ref: refs/heads/') ? ok(h.slice('ref: refs/heads/'.length)) : no;
  }
  if (q === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') {
    const r = readRef(repo, 'refs/remotes/origin/HEAD');
    return r?.startsWith('ref: refs/remotes/') ? ok(r.slice('ref: refs/remotes/'.length)) : no;
  }
  if (args[0] === 'config' && args[1] === '--get' && args.length === 3) {
    const v = configGet(repo, args[2]!);
    return v === null ? no : ok(v);
  }
  if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet' && args.length === 4 && args[3]!.startsWith('refs/')) {
    const sha = readRef(repo, args[3]!);
    return sha ? ok(sha) : no;
  }
  if (q === 'remote get-url --push origin' || q === 'remote get-url origin') {
    const url = (args[2] === '--push' ? configGet(repo, 'remote.origin.pushurl') : null) ?? configGet(repo, 'remote.origin.url');
    return url === null ? { code: 2, stdout: '', stderr: "error: No such remote 'origin'\n" } : ok(url);
  }
  if (q.startsWith('remote add origin ') && args.length === 4) { addOrigin(repo, args[3]!); return ok(''); }
  if (args[0] === 'status' && args[1] === '--porcelain' && args.slice(2).every((a) => a === '--untracked-files=no')) {
    const lines = fsStatus(repo).filter((l) => !(args[2] && l.startsWith('??')));
    return { code: 0, stdout: lines.map((l) => `${l}\n`).join(''), stderr: '' };
  }
  return undefined;
}

/** `git remote add origin <url>` as a file edit (makeRepo repositories). */
export function addOrigin(repo: string, url: string): void {
  const cfg = join(repo, '.git', 'config');
  writeFileSync(cfg, `${readFileSync(cfg, 'utf8')}[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

/** core/exec with `run('git', ...)` answered by fsGit where it can. */
export function withFsGit(real: ExecModule): ExecModule {
  const run: ExecModule['run'] = async (cmd, args, opts = {}) => {
    if (cmd === 'git') {
      const r = fsGit(opts.cwd ?? process.cwd(), args);
      if (r) {
        if (r.code !== 0 && !opts.allowFailure) throw new Error(`git ${args.join(' ')} failed (fs-git): ${r.stderr}`);
        return r;
      }
    }
    return real.run(cmd, args, opts);
  };
  return { ...real, run };
}

/** `git rev-parse HEAD` read from the files. */
export function headSha(repo: string): string {
  return fsGit(repo, ['rev-parse', 'HEAD'])!.stdout.trim();
}

/** `git remote get-url origin` read from the config ('' when there is none). */
export function originUrl(repo: string): string {
  return configGet(top(repo)!, 'remote.origin.url') ?? '';
}

// --- Objects, trees and the index (flat or nested paths; loose objects only) -------------------------------

function writeObject(repo: string, type: string, body: Buffer): Buffer {
  const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  const id = createHash('sha1').update(raw).digest();
  const hex = id.toString('hex');
  const path = join(repo, '.git', 'objects', hex.slice(0, 2), hex.slice(2));
  if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, deflateSync(raw)); }
  return id;
}

function readObject(repo: string, sha: string): Buffer {
  const raw = inflateSync(readFileSync(join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2))));
  return raw.subarray(raw.indexOf(0) + 1);
}

/** path -> blob sha of the tree. */
function treeFiles(repo: string, tree: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const b = readObject(repo, tree);
  for (let i = 0; i < b.length;) {
    const sp = b.indexOf(0x20, i), nul = b.indexOf(0, sp);
    const mode = b.subarray(i, sp).toString(), name = b.subarray(sp + 1, nul).toString();
    const sha = b.subarray(nul + 1, nul + 21).toString('hex');
    if (mode === '40000') treeFiles(repo, sha, `${prefix}${name}/`, out); else out.set(`${prefix}${name}`, sha);
    i = nul + 21;
  }
  return out;
}

function headFiles(repo: string): Map<string, string> {
  const sha = fsGit(repo, ['rev-parse', 'HEAD']);
  if (!sha || sha.code !== 0) return new Map();
  const commit = readObject(repo, sha.stdout.trim()).toString();
  return treeFiles(repo, /^tree ([0-9a-f]{40})/.exec(commit)![1]!);
}

/** Work-tree files (relative paths), without .git and the names the root .gitignore lists. */
function workFiles(repo: string): string[] {
  const ignore = existsSync(join(repo, '.gitignore'))
    ? new Set(readFileSync(join(repo, '.gitignore'), 'utf8').split('\n').map((l) => l.trim().replace(/^\/|\/$/g, '')).filter(Boolean)) : new Set<string>();
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if ((rel === '' && e.name === '.git') || ignore.has(e.name)) continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else if (e.isFile()) out.push(`${rel}${e.name}`);
    }
  };
  walk(repo, '');
  return out.sort();
}

const blobSha = (content: Buffer) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest('hex');

/**
 * `git status --porcelain` from HEAD and the work tree (no staging area: everything is compared with HEAD).
 * Untracked files are collapsed to their top-level directory when that directory has no tracked file.
 */
export function fsStatus(repo: string): string[] {
  const head = headFiles(repo);
  const work = workFiles(repo);
  const lines = new Map<string, string>();
  const trackedDirs = new Set([...head.keys()].map((p) => p.split('/')[0]!));
  for (const p of work) {
    const sha = head.get(p);
    if (sha === undefined) {
      const top = p.split('/')[0]!;
      const key = p.includes('/') && !trackedDirs.has(top) ? `${top}/` : p;
      lines.set(key, `?? ${key}`);
    } else if (sha !== blobSha(readFileSync(join(repo, p)))) lines.set(p, ` M ${p}`);
  }
  for (const p of head.keys()) if (!work.includes(p)) lines.set(p, ` D ${p}`);
  // Like git: changes to tracked files first, then untracked paths, each in path order.
  const keys = [...lines.keys()].sort();
  return [...keys.filter((k) => !lines.get(k)!.startsWith('??')), ...keys.filter((k) => lines.get(k)!.startsWith('??'))].map((k) => lines.get(k)!);
}

function writeTree(repo: string, files: Map<string, Buffer>): Buffer {
  const here = new Map<string, Buffer>();
  const sub = new Map<string, Map<string, Buffer>>();
  for (const [p, id] of files) {
    const i = p.indexOf('/');
    if (i < 0) here.set(p, id);
    else {
      const d = p.slice(0, i);
      if (!sub.has(d)) sub.set(d, new Map());
      sub.get(d)!.set(p.slice(i + 1), id);
    }
  }
  const entries: [string, string, Buffer][] = [...here].map(([n, id]) => [n, '100644', id]);
  for (const [d, m] of sub) entries.push([d, '40000', writeTree(repo, m)]);
  // Git orders tree entries by name, a directory as if its name ended in '/'.
  entries.sort(([a, ma], [b, mb]) => Buffer.compare(Buffer.from(ma === '40000' ? `${a}/` : a), Buffer.from(mb === '40000' ? `${b}/` : b)));
  return writeObject(repo, 'tree', Buffer.concat(entries.flatMap(([n, m, id]) => [Buffer.from(`${m} ${n}\0`), id])));
}

/** Index v2 for `paths` with their real stat data, so git sees them as clean without re-hashing. */
function writeIndex(repo: string, files: Map<string, Buffer>): void {
  const names = [...files.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const u32 = (b: Buffer, off: number, v: bigint) => b.writeUInt32BE(Number(v & 0xffffffffn), off);
  const entries = names.map((n) => {
    const st = statSync(join(repo, n), { bigint: true });
    const len = 62 + Buffer.byteLength(n);
    const e = Buffer.alloc(Math.ceil((len + 1) / 8) * 8);
    u32(e, 0, st.ctimeNs / 1_000_000_000n); u32(e, 4, st.ctimeNs % 1_000_000_000n);
    u32(e, 8, st.mtimeNs / 1_000_000_000n); u32(e, 12, st.mtimeNs % 1_000_000_000n);
    u32(e, 16, st.dev); u32(e, 20, st.ino); u32(e, 24, 0o100644n); u32(e, 28, st.uid); u32(e, 32, st.gid); u32(e, 36, st.size);
    files.get(n)!.copy(e, 40);
    e.writeUInt16BE(Math.min(Buffer.byteLength(n), 0xfff), 60);
    e.write(n, 62);
    return e;
  });
  const header = Buffer.alloc(12);
  header.write('DIRC', 0); header.writeUInt32BE(2, 4); header.writeUInt32BE(names.length, 8);
  const index = Buffer.concat([header, ...entries]);
  writeFileSync(join(repo, '.git', 'index'), Buffer.concat([index, createHash('sha1').update(index).digest()]));
}

/**
 * `git add -A && git commit -m <message>` as file writes: commits every work-tree file (minus root .gitignore
 * names) on the current branch, with HEAD as the parent when there is one. Returns the commit SHA.
 */
export function commitAll(repo: string, message: string): string {
  const files = new Map<string, Buffer>();
  for (const p of workFiles(repo)) files.set(p, writeObject(repo, 'blob', readFileSync(join(repo, p))));
  const tree = writeTree(repo, files);
  const parent = fsGit(repo, ['rev-parse', 'HEAD']);
  const author = `${process.env.GIT_AUTHOR_NAME ?? 'Ada Lovelace'} <${process.env.GIT_AUTHOR_EMAIL ?? 'ada@example.com'}>`;
  const committer = `${process.env.GIT_COMMITTER_NAME ?? 'Ada Lovelace'} <${process.env.GIT_COMMITTER_EMAIL ?? 'ada@example.com'}>`;
  const when = `${Math.floor(Date.now() / 1000)} +0000`;
  const body = `tree ${tree.toString('hex')}\n${parent?.code === 0 ? `parent ${parent.stdout.trim()}\n` : ''}author ${author} ${when}\ncommitter ${committer} ${when}\n\n${message}\n`;
  const commit = writeObject(repo, 'commit', Buffer.from(body)).toString('hex');
  const head = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim();
  const ref = head.startsWith('ref: ') ? head.slice(5) : 'HEAD';
  mkdirSync(dirname(join(repo, '.git', ref)), { recursive: true });
  writeFileSync(join(repo, '.git', ref), `${commit}\n`);
  writeIndex(repo, files);
  return commit;
}

/**
 * A new repository at `repo` with `files` committed as "init" on `main` by Ada Lovelace (identity in the
 * config, gpgsign off): what `git init -b main` + config + `git add .` + `git commit -m init` makes.
 */
export function writeGitRepo(repo: string, files: Record<string, string>): string {
  const gitDir = join(repo, '.git');
  for (const d of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags', 'info']) mkdirSync(join(gitDir, d), { recursive: true });
  for (const [name, content] of Object.entries(files)) { mkdirSync(dirname(join(repo, name)), { recursive: true }); writeFileSync(join(repo, name), content); }
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(gitDir, 'description'), "Unnamed repository; edit this file 'description' to name the repository.\n");
  writeFileSync(join(gitDir, 'config'), [
    '[core]', '\trepositoryformatversion = 0', '\tfilemode = true', '\tbare = false', '\tlogallrefupdates = true',
    ...(process.platform === 'darwin' ? ['\tignorecase = true', '\tprecomposeunicode = true'] : []),
    '[user]', '\tname = Ada Lovelace', '\temail = ada@example.com', '[commit]', '\tgpgsign = false', '',
  ].join('\n'));
  return commitAll(repo, 'init');
}
