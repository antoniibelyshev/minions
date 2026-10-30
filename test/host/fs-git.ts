// In-process answers to the read-only git queries `minions init` and host setup make (task-137.2.6), so a test of
// those flows can run in the unit tier (test/setup/no-subprocess.ts). Use from a test file:
//
//   vi.mock('../../src/core/exec.js', async (orig) => (await import('./fs-git.js')).withFsGit(await orig()));
//
// Only `git` calls whose answer can be read from the files of a simple repository (the ones makeRepo writes:
// loose refs, one config file, no worktrees) are answered; `status` reports a clean tree. Every other command
// goes to the real `run`, which fails in the unit tier, so a test that needs real git shows up at once.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  if (args[0] === 'status' && args[1] === '--porcelain') return ok('');
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
