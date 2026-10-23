/**
 * In-process reader for Backlog.md task files (task-24.1).
 *
 * `backlog task list --json` lacks the description, dependencies, acceptance criteria and notes, and a
 * `backlog task view` per task made every listing cost 1+N process spawns. This module parses the task
 * markdown files Backlog.md writes (`<root>/backlog/tasks/*.md`) into the same raw shape `task view --json`
 * returns, so `toTask`/`taskVersion` give identical Tasks and versions.
 *
 * The parser is deliberately strict: it accepts only the exact layout Backlog.md 1.x writes (a YAML
 * frontmatter subset and marker-delimited sections). Anything else (unknown keys or sections, comments,
 * legacy unmarked sections, CRLF, flow lists, ...) returns null and the caller falls back to
 * `backlog task view` for that one task. The caller also cross-checks every field the list summary
 * carries, so a frontmatter normalisation Backlog.md applies that this parser misses also falls back
 * instead of producing a different version.
 */

/** Raw task fields as `backlog task view --json` reports them (the subset minions hashes and maps). */
export interface ParsedTaskFile {
  id: string; title: string; status: string; archived: boolean; type: string | null; priority: string | null;
  project: string | null; assignees: string[]; reporter: string | null; labels: string[]; milestone: string | null;
  parentTaskId: string | null; references: string[]; modifiedFiles: string[]; ordinal: number | null;
  dueDate: string | null; description: string | null; dependencies: string[]; documentation: string[];
  acceptanceCriteria: ChecklistItem[]; definitionOfDone: ChecklistItem[]; implementationPlan: string | null;
  implementationNotes: string | null; comments: unknown[]; finalSummary: string | null;
}
export interface ChecklistItem { index: number; text: string; checked: boolean }

type Yaml = string | number | boolean | null | string[];

// ---------------------------------------------------------------- frontmatter (YAML subset)

const PLAIN_RESERVED = /^(?:null|~|true|false|yes|no|on|off|y|n)$/i;
/**
 * Unquoted strings the parser trusts to read back as exactly themselves. Deliberately an allowlist, not a
 * YAML implementation: letters, digits, marks, punctuation, symbols and spaces only (no tabs, control,
 * format or line-separator characters). The first character must not be a YAML indicator, a digit, a sign
 * or a dot, which rules out every YAML 1.1 int/float/sexagesimal/.inf/.nan and date/timestamp form.
 * PLAIN_UNSAFE then rejects any `#` (comments) and any `:` not followed by a visible character (mappings
 * such as `x:` or `a: b`), while `https://a/b` stays plain. Anything else returns undefined and the caller
 * falls back to `task view`; being strict only costs that one spawn.
 */
const PLAIN_SAFE = /^[^\s\d\-+.?:,[\]{}#&*!|>'"%@`<=~\\][\p{L}\p{N}\p{M}\p{P}\p{S} ]*$/u;
const PLAIN_UNSAFE = /#|:(?![\p{L}\p{N}\p{P}\p{S}])/u;

/**
 * A YAML double-quoted scalar on one line. JSON.parse handles the escapes both languages share; js-yaml's
 * dumper also writes non-BMP characters (emoji) as `\UXXXXXXXX`, decoded here to the same code point
 * Backlog.md's reader yields. Any other YAML-only escape (`\x`, `\e`, `\N`, `\_`, ...) makes JSON.parse
 * throw, which falls back.
 */
function decodeDoubleQuoted(s: string): string | undefined {
  let bad = false;
  const json = s.replace(/\\(?:U([0-9A-Fa-f]{8})|[\s\S])/g, (m, hex: string | undefined) => {
    if (hex === undefined) return m;
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { bad = true; return m; }
    return String.fromCodePoint(cp);
  });
  if (bad) return undefined;
  try { const v: unknown = JSON.parse(json); return typeof v === 'string' ? v : undefined; } catch { return undefined; }
}

/** One YAML scalar as js-yaml dumps it; undefined when outside the supported subset. */
function scalar(src: string): string | number | null | undefined {
  const s = src.replace(/^[ \t]+|[ \t]+$/g, ''); // YAML trims only spaces and tabs
  if (s === '') return null;
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) return undefined;
    const body = s.slice(1, -1);
    if (/'(?!')/.test(body.replace(/''/g, ''))) return undefined;
    return body.replace(/''/g, "'");
  }
  if (s.startsWith('"')) return decodeDoubleQuoted(s);
  // Plain decimal integers only (no leading zero: YAML 1.1 reads 010 as octal), within the exact range.
  if (/^-?(?:0|[1-9]\d{0,14})$/.test(s)) return Number(s);
  // Anything YAML could read as something other than this exact string is left to Backlog.md.
  if (PLAIN_RESERVED.test(s) || !PLAIN_SAFE.test(s) || PLAIN_UNSAFE.test(s)) return undefined;
  return s;
}

/** Parses the frontmatter lines into key -> value; undefined when any line is outside the subset. */
export function parseFrontmatter(lines: string[]): Map<string, Yaml> | undefined {
  const out = new Map<string, Yaml>();
  let i = 0;
  while (i < lines.length) {
    const m = /^([a-z_]+):(?: (.*))?$/.exec(lines[i]!);
    if (!m || out.has(m[1]!)) return undefined;
    const key = m[1]!;
    const rest = (m[2] ?? '').replace(/^[ \t]+|[ \t]+$/g, '');
    i++;
    if (rest === '') {
      // Block sequence (possibly empty: `key:` alone is null).
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('  - ')) {
        const v = scalar(lines[i]!.slice(4));
        if (typeof v !== 'string') return undefined;
        items.push(v);
        i++;
      }
      if (i < lines.length && /^\s/.test(lines[i]!)) return undefined;
      out.set(key, items.length ? items : null);
    } else if (rest === '>-' || rest === '|-') {
      // Folded/literal block scalar: only the simple form js-yaml emits for long single-line strings.
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('  ')) {
        const l = lines[i]!.slice(2);
        if (!l || /^\s/.test(l) || /\s$/.test(l)) return undefined;
        body.push(l);
        i++;
      }
      if (!body.length || (i < lines.length && /^\s/.test(lines[i]!))) return undefined;
      out.set(key, body.join(rest === '>-' ? ' ' : '\n'));
    } else if (rest === '[]') {
      out.set(key, []);
    } else {
      const v = scalar(rest);
      if (v === undefined) return undefined;
      out.set(key, v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- body sections

interface SectionSpec { heading: string; marker: string; key: 'description' | 'implementationPlan' | 'implementationNotes' | 'finalSummary' | 'acceptanceCriteria' | 'definitionOfDone' }
const SECTIONS: SectionSpec[] = [
  { heading: 'Description', marker: 'SECTION:DESCRIPTION', key: 'description' },
  { heading: 'Acceptance Criteria', marker: 'AC', key: 'acceptanceCriteria' },
  { heading: 'Definition of Done', marker: 'DOD', key: 'definitionOfDone' },
  { heading: 'Implementation Plan', marker: 'SECTION:PLAN', key: 'implementationPlan' },
  { heading: 'Implementation Notes', marker: 'SECTION:NOTES', key: 'implementationNotes' },
  { heading: 'Final Summary', marker: 'SECTION:FINAL_SUMMARY', key: 'finalSummary' },
];

/** `- [ ] #1 text` lines, indexes 1..n in order; undefined for anything else (blank lines are skipped). */
function checklist(content: string): ChecklistItem[] | undefined {
  const items: ChecklistItem[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const m = /^- \[( |x)\] #(\d+) (\S.*)$/.exec(line);
    if (!m || Number(m[2]) !== items.length + 1) return undefined;
    items.push({ index: items.length + 1, text: m[3]!, checked: m[1] === 'x' });
  }
  return items;
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * Parses one Backlog.md task file. Returns null when the file is outside the strict layout this parser
 * understands; the caller then asks `backlog task view` instead.
 */
export function parseTaskFile(text: string): ParsedTaskFile | null {
  if (text.includes('\r') || !text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  const close = end >= 0 ? end : (text.endsWith('\n---') ? text.length - 4 : -1);
  if (close < 0) return null;
  const fm = parseFrontmatter(text.slice(4, close).split('\n'));
  if (!fm) return null;
  const body = text.slice(close + 5);

  const KNOWN = new Set(['id', 'title', 'status', 'assignee', 'reporter', 'created_date', 'updated_date', 'due_date', 'labels',
    'milestone', 'dependencies', 'references', 'documentation', 'modified_files', 'parent_task_id', 'priority', 'type', 'project', 'ordinal']);
  for (const k of fm.keys()) if (!KNOWN.has(k)) return null;
  const str = (k: string): string | null | undefined => {
    const v = fm.get(k);
    return v === undefined || v === null ? null : typeof v === 'string' ? v : undefined;
  };
  const list = (k: string): string[] | undefined => {
    const v = fm.get(k);
    return v === undefined || v === null ? [] : Array.isArray(v) ? v : undefined;
  };
  const id = str('id'), title = str('title'), status = str('status');
  if (!id || !/^TASK-\d+(?:\.\d+)*$/.test(id) || title === undefined || title === null || !status) return null;
  const ordinal = fm.get('ordinal');
  if (ordinal !== undefined && ordinal !== null && typeof ordinal !== 'number') return null;
  const scalars = { type: str('type'), priority: str('priority'), project: str('project'), reporter: str('reporter'),
    milestone: str('milestone'), parentTaskId: str('parent_task_id'), dueDate: str('due_date') };
  const lists = { assignees: list('assignee'), labels: list('labels'), references: list('references'),
    modifiedFiles: list('modified_files'), dependencies: list('dependencies'), documentation: list('documentation') };
  if (Object.values(scalars).some((v) => v === undefined) || Object.values(lists).some((v) => v === undefined)) return null;

  const sections: Partial<Record<SectionSpec['key'], string>> = {};
  let rest = body;
  for (;;) {
    rest = rest.replace(/^\n+/, '');
    if (!rest) break;
    const h = /^## (.+)\n/.exec(rest);
    const spec = h ? SECTIONS.find((s) => s.heading === h[1]) : undefined;
    if (!h || !spec || spec.key in sections) return null;
    rest = rest.slice(h[0].length).replace(/^\n+/, '');
    const begin = `<!-- ${spec.marker}:BEGIN -->`, endMarker = `<!-- ${spec.marker}:END -->`;
    if (count(text, begin) !== 1 || count(text, endMarker) !== 1 || !rest.startsWith(`${begin}\n`)) return null;
    const stop = rest.indexOf(`${endMarker}`);
    if (stop < 0) return null;
    const after = rest.slice(stop + endMarker.length);
    if (after && !after.startsWith('\n')) return null;
    sections[spec.key] = rest.slice(begin.length + 1, stop);
    rest = after;
  }
  const textOf = (k: SectionSpec['key']) => { const v = sections[k]?.trim(); return v ? v : null; };
  const ac = checklist(sections.acceptanceCriteria ?? '');
  const dod = checklist(sections.definitionOfDone ?? '');
  if (!ac || !dod) return null;

  return {
    id, title, status, archived: false,
    type: scalars.type!, priority: scalars.priority ? scalars.priority.toLowerCase() : null, project: scalars.project!,
    assignees: lists.assignees!, reporter: scalars.reporter!, labels: lists.labels!, milestone: scalars.milestone!,
    parentTaskId: scalars.parentTaskId!, references: lists.references!, modifiedFiles: lists.modifiedFiles!,
    ordinal: typeof ordinal === 'number' ? ordinal : null, dueDate: scalars.dueDate!,
    description: textOf('description'), dependencies: lists.dependencies!, documentation: lists.documentation!,
    acceptanceCriteria: ac, definitionOfDone: dod,
    implementationPlan: textOf('implementationPlan'), implementationNotes: textOf('implementationNotes'),
    comments: [], finalSummary: textOf('finalSummary'),
  };
}

/** Fields both `task list --json` and the parser report; any difference means "ask Backlog.md". */
const SUMMARY_FIELDS = ['id', 'title', 'status', 'archived', 'type', 'priority', 'project', 'assignees', 'reporter', 'labels',
  'milestone', 'parentTaskId', 'references', 'modifiedFiles', 'ordinal', 'dueDate'] as const;

/** True when the parsed file agrees with the list summary on every shared field (and the AC counts). */
export function matchesSummary(parsed: ParsedTaskFile, summary: Record<string, unknown>): boolean {
  for (const k of SUMMARY_FIELDS) {
    if (JSON.stringify(parsed[k] ?? null) !== JSON.stringify(summary[k] ?? null)) return false;
  }
  if (typeof summary.acceptanceCriteriaCount === 'number' && summary.acceptanceCriteriaCount !== parsed.acceptanceCriteria.length) return false;
  if (typeof summary.acceptanceCriteriaCompleted === 'number'
    && summary.acceptanceCriteriaCompleted !== parsed.acceptanceCriteria.filter((a) => a.checked).length) return false;
  return true;
}

// ---------------------------------------------------------------- tested CLI versions

/** Backlog.md release line the file layout above was validated against (task-24.9). */
export const FAST_PATH_TESTED = '1.54.x';

/**
 * True when `backlog --version` output names a release the in-process reader was validated against
 * (1.54.x). Anything else (another minor or major, a pre-release tag, unparseable output, no output)
 * is false: listings then view every task with the CLI, which is slower but never misreads a file
 * layout a newer Backlog.md might write.
 */
export function fastPathVersionOk(version: string | null | undefined): boolean {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)\s*$/.exec((version ?? '').split('\n')[0] ?? '');
  return !!m && m[1] === '1' && m[2] === '54';
}

/** One-line note for doctor/status when the installed Backlog.md is outside the tested line; null when it is tested. */
export function fastPathHint(version: string | null | undefined): string | null {
  return fastPathVersionOk(version) ? null
    : `untested for in-process task reading (tested ${FAST_PATH_TESTED}); listings use one \`backlog task view\` per task (slower)`;
}
