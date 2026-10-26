// A small shell-ish scanner for the pre-bash hook (task-14.5): it splits a Bash command line into the simple
// commands it would run, so the hook can reason about words in command position instead of raw text. It is no
// full POSIX parser and need not be: the hook is defence-in-depth, not a security boundary (the `work run` L0
// gate stays authoritative).
//
// What it handles:
// - quotes ('…' literal, "…" with \ escapes) and backslash escapes are removed from words; a quoted string stays
//   one word, so a quoted argument such as `git commit -m "… minions work run …"` is never a command;
// - backslash-newline line continuations are joined;
// - `;`, `&`, `|`, newlines, `(` and `)` end a simple command;
// - redirection operators end the word they are glued to (`run>/dev/null`), and their target word is dropped;
//   a leading fd number (`2>`) is dropped too;
// - heredoc bodies are skipped; an unquoted delimiter (`<<EOF`) still has its `$(…)`, `${…}` and backtick
//   substitutions scanned, as the shell runs those;
// - `$(…)` and `<(…)`/`>(…)` are scanned in place (their commands join the list); backtick and `${…}` bodies are
//   returned as nested scripts for the caller to scan again. Inside a word a substitution leaves a NUL placeholder.
// - `#` comments are skipped.
// Unbalanced quotes, an unterminated `$(` or backtick, or nesting deeper than MAX_NEST throw ShellParseError: the
// caller decides (the hook fails closed on the raw text).

export class ShellParseError extends Error {}

/** The placeholder a command substitution leaves inside a word. */
export const SUBSTITUTION = '\u0000';

const MAX_NEST = 32;

export interface ShellScan {
  /** Simple commands, each a list of words (quotes removed, redirections dropped), in source order. */
  commands: string[][];
  /** Backtick and `${…}` bodies to scan as scripts of their own. */
  scripts: string[];
}

interface Heredoc { delim: string; strip: boolean; quoted: boolean }

class Lexer {
  i = 0;
  readonly commands: string[][] = [];
  readonly scripts: string[] = [];
  private pending: Heredoc[] = [];

  constructor(private readonly s: string) {}

  /** Scans simple commands until the end (top level) or the `)` that closes a `$(`/`<(` (sub). */
  parse(sub: boolean, nest: number): void {
    if (nest > MAX_NEST) throw new ShellParseError('substitutions nested too deeply');
    const s = this.s;
    const st = { words: [] as string[], word: null as string | null, quoted: false, target: null as 'skip' | 'heredoc' | null, strip: false };
    let depth = 0;
    const add = (t: string, quoted = false) => {
      if (st.word === null) { st.word = ''; st.quoted = false; }
      st.word += t;
      if (quoted) st.quoted = true;
    };
    const endWord = () => {
      if (st.word === null) return;
      if (st.target === 'heredoc') this.pending.push({ delim: st.word, strip: st.strip, quoted: st.quoted });
      else if (st.target !== 'skip') st.words.push(st.word);
      st.target = null;
      st.word = null;
    };
    const endCommand = () => {
      endWord();
      if (st.words.length) this.commands.push(st.words);
      st.words = [];
      st.target = null;
    };
    while (this.i < s.length) {
      const c = s[this.i]!;
      const d = s[this.i + 1];
      if (c === '\\') {
        if (d !== '\n' && d !== undefined) add(d, true);
        this.i += 2;
      } else if (c === "'") {
        const j = s.indexOf("'", this.i + 1);
        if (j < 0) throw new ShellParseError('unterminated single quote');
        add(s.slice(this.i + 1, j), true);
        this.i = j + 1;
      } else if (c === '"') {
        this.i++;
        add(this.double(nest), true);
      } else if (c === '`') {
        this.backtick();
        add(SUBSTITUTION);
      } else if (c === '$' && (d === '(' || d === '{')) {
        this.dollar(nest);
        add(SUBSTITUTION);
      } else if ((c === '<' || c === '>') && d === '(') {
        this.i += 2;
        this.parse(true, nest + 1);
        add(SUBSTITUTION);
      } else if (c === ' ' || c === '\t' || c === '\r') {
        endWord();
        this.i++;
      } else if (c === '\n') {
        endCommand();
        this.i++;
        this.bodies(nest);
      } else if (c === '#' && st.word === null) {
        const j = s.indexOf('\n', this.i);
        this.i = j < 0 ? s.length : j;
      } else if (c === '&' && d === '>') {
        endWord();
        st.target = 'skip';
        this.i += s[this.i + 2] === '>' ? 3 : 2;
      } else if (c === '<' || c === '>') {
        if (st.word !== null && !st.quoted && /^\d+$/.test(st.word)) st.word = null; // an fd number (2>)
        endWord();
        if (c === '<' && d === '<' && s[this.i + 2] === '<') { st.target = 'skip'; this.i += 3; }
        else if (c === '<' && d === '<') { st.strip = s[this.i + 2] === '-'; st.target = 'heredoc'; this.i += st.strip ? 3 : 2; }
        else { st.target = 'skip'; this.i += d === '>' || d === '&' || d === '|' || (c === '<' && d === '>') ? 2 : 1; }
      } else if (c === '(') {
        endCommand();
        depth++;
        this.i++;
      } else if (c === ')') {
        endCommand();
        this.i++;
        if (depth === 0 && sub) return;
        if (depth > 0) depth--;
      } else if (c === ';' || c === '&' || c === '|') {
        endCommand();
        this.i++;
      } else {
        add(c);
        this.i++;
      }
    }
    if (sub) throw new ShellParseError('unterminated $( or <(');
    endCommand();
  }

  /** The content of a "…" string (the opening quote consumed); substitutions inside are scanned. */
  private double(nest: number): string {
    const s = this.s;
    let out = '';
    while (this.i < s.length) {
      const c = s[this.i]!;
      const d = s[this.i + 1];
      if (c === '"') { this.i++; return out; }
      if (c === '\\') {
        if (d === '\n') { this.i += 2; continue; }
        if (d !== undefined && '$`"\\'.includes(d)) { out += d; this.i += 2; continue; }
        out += c; this.i++; continue;
      }
      if (c === '`') { this.backtick(); out += SUBSTITUTION; continue; }
      if (c === '$' && (d === '(' || d === '{')) { this.dollar(nest); out += SUBSTITUTION; continue; }
      out += c;
      this.i++;
    }
    throw new ShellParseError('unterminated double quote');
  }

  /** At `$(` (scanned in place) or `${` (its body becomes a nested script when it can run anything). */
  private dollar(nest: number): void {
    const s = this.s;
    if (s[this.i + 1] === '(') { this.i += 2; this.parse(true, nest + 1); return; }
    const start = this.i + 2;
    let j = start;
    let depth = 1;
    while (j < s.length) {
      const c = s[j]!;
      if (c === '\\') { j += 2; continue; }
      if (c === "'") { const k = s.indexOf("'", j + 1); if (k < 0) break; j = k + 1; continue; }
      if (c === '"') { j++; while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; j++; continue; }
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) break;
      j++;
    }
    if (j >= s.length) throw new ShellParseError('unterminated ${');
    const body = s.slice(start, j);
    if (/[$`]/.test(body)) this.scripts.push(body);
    this.i = j + 1;
  }

  /** At a backtick: its body (escapes undone) becomes a nested script. */
  private backtick(): void {
    const s = this.s;
    let j = this.i + 1;
    let inner = '';
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\' && j + 1 < s.length) {
        const n = s[j + 1]!;
        inner += n === '`' || n === '\\' || n === '$' ? n : `\\${n}`;
        j += 2;
        continue;
      }
      inner += s[j];
      j++;
    }
    if (j >= s.length) throw new ShellParseError('unterminated backtick');
    this.scripts.push(inner);
    this.i = j + 1;
  }

  /** After a newline: skips the bodies of pending heredocs (scanning the substitutions of unquoted ones). */
  private bodies(nest: number): void {
    if (!this.pending.length) return;
    const s = this.s;
    const hs = this.pending;
    this.pending = [];
    for (const h of hs) {
      const lines: string[] = [];
      while (this.i < s.length) {
        const nl = s.indexOf('\n', this.i);
        const e = nl < 0 ? s.length : nl;
        const line = s.slice(this.i, e);
        this.i = nl < 0 ? s.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      if (!h.quoted && lines.length) {
        const body = new Lexer(lines.join('\n'));
        body.substitutions(nest);
        this.commands.push(...body.commands);
        this.scripts.push(...body.scripts);
      }
    }
  }

  /** Heredoc-body mode: only escapes and substitutions are special. */
  private substitutions(nest: number): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i];
      const d = s[this.i + 1];
      if (c === '\\') this.i += 2;
      else if (c === '`') this.backtick();
      else if (c === '$' && (d === '(' || d === '{')) this.dollar(nest + 1);
      else this.i++;
    }
  }
}

/** The simple commands of a Bash command line; throws ShellParseError when it cannot be scanned. */
export function scanShell(src: string): ShellScan {
  const lx = new Lexer(src);
  lx.parse(false, 0);
  return { commands: lx.commands, scripts: lx.scripts };
}
