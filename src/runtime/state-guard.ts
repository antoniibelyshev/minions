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

/**
 * `secretsDir` (task-96), when given, is protected like the state: the host-provisioned secrets (Claude key, headless
 * Claude token, GitHub and Telegram tokens) are read by minions itself, Claude Code's apiKeyHelper and the git
 * credential helper, never by a worker's tool call. runtimePaths() always has it, so the hooks protect it.
 */
export function stateGuard(paths: Pick<RuntimePaths, 'state' | 'tmp'> & Partial<Pick<RuntimePaths, 'secretsDir'>> = runtimePaths()): StateGuard {
  const both = (p: string) => [...new Set([strip(posix.normalize(p)), strip(resolveReal(p))])];
  const roots = [...new Set([...both(paths.state), ...(paths.secretsDir ? both(paths.secretsDir) : [])])];
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
/** The same inside one shell word (quotes and escapes already removed): a space there is part of the path. */
const WORD_END = /[\n'"`;|&<>(){}$\\,=:]/;
/** How deep quoted words are unquoted again (`bash -c '… "a b" …'`). */
const MAX_UNQUOTE = 4;

/**
 * The words of a command line as the shell would see them, roughly: unquoted whitespace splits, `'…'` and `"…"`
 * (with `\` before `$`, `` ` ``, `"`, `\` and a newline) and backslash escapes are removed, everything else stays
 * literal (operators, expansions, a quote left open runs to the end). No parser: just enough that a path with a
 * space in it, quoted (`"/a b/state"`), partly quoted (`"/a b"/state`) or escaped (`/a\ b/state`), is one word.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\') { inWord = true; if (command[i + 1] !== '\n') word += command[i + 1] ?? ''; i++; continue; }
    if (c === "'") {
      inWord = true;
      const close = command.indexOf("'", i + 1);
      word += command.slice(i + 1, close < 0 ? undefined : close);
      i = close < 0 ? command.length : close;
      continue;
    }
    if (c === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const d = command[i]!;
        const n = command[i + 1];
        if (d === '\\' && n === '\n') i++;
        else if (d === '\\' && n !== undefined && '$`"\\'.includes(n)) word += command[++i]!;
        else word += d;
      }
      continue;
    }
    if (/\s/.test(c)) { if (inWord) words.push(word); word = ''; inWord = false; continue; }
    word += c;
    inWord = true;
  }
  if (inWord) words.push(word);
  return words;
}

/** `$HOME` and `${HOME}` expanded. */
const expandHome = (text: string, home: string) => text.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);

/**
 * The first reference to the protected state in `text` (the command line, or one of its words with `end` = WORD_END),
 * or null. Two scans, both through protectedLexical (exempt subtrees, links back into the state):
 * - every path-like stretch around the last segment of a root (`/state`), as written: catches `//state`,
 *   `/tmp/../state` and `~/…`;
 * - every occurrence of a whole root, as written and with its spaces backslash-escaped, extended to the end of the
 *   path: catches a root with a space in it (`…/Application Support/…/state`), which the first scan cuts apart.
 */
function referenceIn(text: string, g: StateGuard, home: string, end: RegExp): string | null {
  const pathEnd = (from: number) => {
    let stop = from;
    while (stop < text.length && !end.test(text[stop]!)) stop++;
    return stop;
  };
  for (const root of g.roots) {
    const needle = `/${posix.basename(root)}`;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      let start = at;
      while (start > 0 && !end.test(text[start - 1]!)) start--;
      const stop = pathEnd(at + needle.length);
      let written = text.slice(start, stop);
      if (written === '~' || written.startsWith('~/')) written = home + written.slice(1);
      if (!written.startsWith('/')) continue;
      if (protectedLexical(strip(posix.normalize(written)), g)) return text.slice(start, stop);
    }
  }
  for (const root of g.roots) {
    for (const spelled of new Set([root, root.replace(/(\s)/g, '\\$1')])) {
      for (let at = text.indexOf(spelled); at >= 0; at = text.indexOf(spelled, at + 1)) {
        const before = text[at - 1];
        // Inside another path (`/x/<root>`) it names another dir; after `/` (`//<root>`) it is still the root.
        if (before !== undefined && before !== '/' && !end.test(before) && !/\s/.test(before)) continue;
        const after = text[at + spelled.length];
        if (after !== undefined && after !== '/' && !end.test(after) && !/\s/.test(after)) continue;
        const stop = pathEnd(at + spelled.length);
        if (protectedLexical(strip(posix.normalize(root + text.slice(at + spelled.length, stop))), g)) return text.slice(at, stop);
      }
    }
  }
  return null;
}

/**
 * The first reference to the protected state in a Bash command line, or null: a path holding the state dir
 * (configured or resolved) that names an absolute path (`/state`, `//state`, `/tmp/../state`, `~/…` or `$HOME/…`
 * expanded) inside it but not inside an exempt subtree (the host runtime's scratch dir and caches, unless a symlink
 * or hardlink there leads back into the state), or an expansion of MINIONS_STATE_DIR or MINIONS_SECRETS_DIR. The
 * path counts as written in the raw text and in every shell word (shellWords, again inside quoted words), so a state
 * dir with a space in it (task-114: `~/Library/Application Support/…` on every macOS host) is caught quoted, partly
 * quoted or backslash-escaped. Raw text, deliberately: a quoted path is still a path to `sqlite3` or `node -e`. A
 * mention as plain text (a commit message, a grep pattern, a heredoc) matches too; workers pass such text through a
 * file (`git commit -F`) or use the Grep/Write tools instead. The pre-bash hook drops the heredoc bodies of
 * `minions work submit` before this check (data for minions, not a command).
 */
export function bashStateReference(command: string, g: StateGuard, home: string = homedir()): string | null {
  const env = /\$\{?(MINIONS_STATE_DIR|MINIONS_SECRETS_DIR)\b/.exec(command);
  if (env) return `$${env[1]}`;
  if (g.roots.includes('/')) return '/';
  const hit = referenceIn(expandHome(command, home), g, home, PATH_END);
  if (hit) return hit;
  const seen = new Set<string>();
  let level = [command];
  for (let depth = 0; depth < MAX_UNQUOTE && level.length > 0; depth++) {
    const next: string[] = [];
    for (const text of level) {
      for (const w of shellWords(text)) {
        if (seen.has(w)) continue;
        seen.add(w);
        const found = referenceIn(expandHome(w, home), g, home, WORD_END);
        if (found) return found;
        if (/['"\\]/.test(w)) next.push(w);
      }
    }
    level = next;
  }
  return null;
}
