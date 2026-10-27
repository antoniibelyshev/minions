// Task-72: Claude subagent workers (engineer, tester, reviewer and project roles) run as the same uid as the
// coordinator, so the OS lets them write the runtime state (/state: minions.db, backlog, briefs, results). The DB is
// the root of trust of every gate (pr_url, origin_repository, reviewer evidence, approvals, lease bases), so the
// plugin's PreToolUse hooks refuse subagent tool calls that reach it. This module holds the path logic shared by
// the file-tool hook (exact, symlink-aware) and the Bash hook (a text check, best effort).
//
// Not a security boundary on its own: a Bash command can build a path at run time (variables, `cd` then a relative
// path, an interpreter script) that no text check sees. Only a separate uid for Claude workers closes that, as the
// process workers already have (src/runtime/sandbox/rules.ts, containerProtectedPaths).
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { runtimePaths, type RuntimePaths } from './paths.js';

/** The protected state dir and the parts of it workers may still use. */
export interface StateGuard {
  /** The state dir as configured and, when it differs, as resolved (symlinks). */
  roots: string[];
  /**
   * Subtrees workers use legitimately: the scratch root and, only when that root is inside the state dir (the host
   * runtime keeps it at <state>/cache/tmp), the host runtime's tool caches (<state>/cache: npm, XDG, ...). In the
   * container the scratch root is outside /state, so /state/cache is protected like the rest (a worker could create
   * it and link the DB into it).
   */
  exempt: string[];
}

const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** Real path of `p`, also through a dangling symlink or a not yet existing tail (lexical `p` when nothing resolves). */
export function resolveReal(p: string, hops = 0): string {
  const abs = posix.normalize(p);
  try { return realpathSync(abs); } catch { /* missing, dangling or unreadable: resolve by hand */ }
  if (hops > 40) return abs;
  try {
    if (lstatSync(abs).isSymbolicLink()) return resolveReal(posix.resolve(posix.dirname(abs), readlinkSync(abs)), hops + 1);
  } catch { /* does not exist: resolve the parent */ }
  const parent = posix.dirname(abs);
  return parent === abs ? abs : posix.join(resolveReal(parent, hops + 1), posix.basename(abs));
}

export function stateGuard(paths: Pick<RuntimePaths, 'state' | 'tmp'> = runtimePaths()): StateGuard {
  const both = (p: string) => [...new Set([strip(posix.normalize(p)), strip(resolveReal(p))])];
  const roots = both(paths.state);
  const tmp = both(paths.tmp);
  const tmpInState = tmp.some((t) => roots.some((r) => within(t, r)));
  return { roots, exempt: [...new Set([...tmp, ...(tmpInState ? both(posix.join(paths.state, 'cache')) : [])])] };
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);

const inRoot = (p: string, g: StateGuard) => g.roots.some((r) => within(p, r));
const inExempt = (p: string, g: StateGuard) => g.exempt.some((e) => within(p, e));

/** Most entries walked when looking for the state file a hardlink shares its inode with. */
const MAX_HARDLINK_SCAN = 5000;

/**
 * Whether the existing regular file `p` is a hardlink to a protected state file: same device
 * and inode as a file under a root, outside the exempt subtrees. Only a file with more than one link is looked up;
 * when the state tree is too large to walk, such a file counts as protected (fails closed).
 */
function hardlinkToState(p: string, g: StateGuard): boolean {
  let st;
  try { st = statSync(p); } catch { return false; }
  if (!st.isFile() || st.nlink < 2) return false;
  let budget = MAX_HARDLINK_SCAN;
  const walk = (dir: string): boolean => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return false; }
    for (const n of names) {
      if (--budget < 0) return true;
      const child = posix.join(dir, n);
      if (inExempt(child, g)) continue;
      let c;
      try { c = lstatSync(child); } catch { continue; }
      if (c.isDirectory()) { if (walk(child)) return true; } else if (c.isFile() && c.ino === st.ino && c.dev === st.dev) return true;
    }
    return false;
  };
  for (const r of g.roots) {
    try { if (statSync(r).dev !== st.dev) continue; } catch { continue; }
    if (walk(r)) return true;
  }
  return false;
}

/**
 * True when the absolute, normalized path is inside the protected state: a root, not an exempt subtree; or an
 * exempt-subtree path whose real path (symlinks) is protected, or a hardlink to a protected file.
 */
function protectedLexical(p: string, g: StateGuard): boolean {
  if (!inRoot(p, g)) return false;
  if (!inExempt(p, g)) return true;
  const real = strip(resolveReal(p));
  return (inRoot(real, g) && !inExempt(real, g)) || hardlinkToState(real, g);
}

/**
 * Whether a file-tool path reaches the protected state: checked as written (normalized) and as resolved, so a
 * symlink in the worktree pointing into /state is caught too. `ancestor` (search tools): also true for a directory
 * that contains the state dir (Grep or Glob over `/`).
 */
export function protectedStatePath(path: string, cwd: string, g: StateGuard, opts: { ancestor?: boolean } = {}): boolean {
  const lexical = strip(posix.resolve(cwd, path));
  for (const p of new Set([lexical, strip(resolveReal(lexical))])) {
    if (protectedLexical(p, g)) return true;
    // A hardlink elsewhere (the worktree, the container scratch dir) to a state file.
    if (!inRoot(p, g) && hardlinkToState(p, g)) return true;
    if (opts.ancestor && g.roots.some((r) => within(r, p))) return true;
  }
  return false;
}

/** Where a path written in a command line starts or ends. */
const PATH_END = /[\s'"`;|&<>(){}$\\,=:]/;

/**
 * The first reference to the protected state in a Bash command line, or null: a word holding the state dir
 * (configured or resolved) that names an absolute path (`/state`, `//state`, `/tmp/../state`, `~/…` expanded) inside
 * it but not inside an exempt subtree (the host runtime's scratch dir and caches, unless a symlink or hardlink there
 * leads back into the state), or an expansion of MINIONS_STATE_DIR. Raw text, deliberately: a quoted path is still
 * a path to `sqlite3` or `node -e`. A mention as plain text (a commit message, a grep pattern, a heredoc) matches
 * too; workers pass such text through a file (`git commit -F`) or use the Grep/Write tools instead. The pre-bash
 * hook drops the heredoc bodies of `minions work submit` before this check (data for minions, not a command).
 */
export function bashStateReference(command: string, g: StateGuard, home: string = homedir()): string | null {
  if (/\$\{?MINIONS_STATE_DIR\b/.test(command)) return '$MINIONS_STATE_DIR';
  for (const root of g.roots) {
    if (root === '/') return '/';
    // The root as written, and its last segment (`~/x/state`, `/tmp/../state` hold no full root).
    const needle = `/${posix.basename(root)}`;
    for (let at = command.indexOf(needle); at >= 0; at = command.indexOf(needle, at + 1)) {
      let start = at;
      while (start > 0 && !PATH_END.test(command[start - 1]!)) start--;
      let end = at + needle.length;
      while (end < command.length && !PATH_END.test(command[end]!)) end++;
      let written = command.slice(start, end);
      if (written === '~' || written.startsWith('~/')) written = home + written.slice(1);
      if (!written.startsWith('/')) continue;
      if (protectedLexical(strip(posix.normalize(written)), g)) return command.slice(start, end);
    }
  }
  return null;
}
