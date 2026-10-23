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

const PLAIN_RESERVED = /^(?:null|~|true|false|yes|no|on|off)$/i;

/** One YAML scalar as js-yaml dumps it; undefined when outside the supported subset. */
function scalar(src: string): string | number | null | undefined {
  const s = src.trim();
  if (s === '') return null;
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) return undefined;
    const body = s.slice(1, -1);
    if (/'(?!')/.test(body.replace(/''/g, ''))) return undefined;
    return body.replace(/''/g, "'");
  }
  if (s.startsWith('"')) {
    try { const v: unknown = JSON.parse(s); return typeof v === 'string' ? v : undefined; } catch { return undefined; }
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  // Anything YAML could read as something other than a plain string is left to Backlog.md.
  if (PLAIN_RESERVED.test(s) || /^[-?:,[\]{}#&*!|>%@`]/.test(s) || /: | #/.test(s) || /^[-+.\d]/.test(s) && !Number.isNaN(Number(s))) return undefined;
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
    const rest = (m[2] ?? '').trim();
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
