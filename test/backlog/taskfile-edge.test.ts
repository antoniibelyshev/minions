// Unit tests for the in-process task-file reader (task-24.1): the strict layout it accepts maps every field the way
// `backlog task view --json` reports it, and anything outside it (unusual YAML, hand edits, CRLF) returns null so
// the adapter falls back to `task view`. The comparison against the real Backlog.md CLI (files it writes, the
// plain-scalar allowlist as js-yaml reads it) is the end-to-end check in taskfile.test.ts.
import { describe, expect, it } from 'vitest';
import { matchesSummary, parseFrontmatter, parseTaskFile } from '../../src/backlog/taskfile.js';

const FULL = `---
id: TASK-1
title: 'Parent: task with "quotes" and it''s'
status: ready
assignee:
  - '@alice'
created_date: '2026-10-23 17:20'
updated_date: '2026-10-23 17:20'
due_date: '2026-11-01'
labels:
  - 'minions:authorized'
  - x y
dependencies:
  - TASK-2
references:
  - 'https://x.y/z'
documentation:
  - docs/c.md
modified_files:
  - src/b.ts
parent_task_id: TASK-9
priority: high
type: bug
ordinal: 5
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Line one

## Fake heading in desc

<!-- minions:meta {"provenance":"agent-hypothesis"} -->
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 first ac
- [x] #2 second, with comma
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 dod item
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
step 1
step 2
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
note 1

note 2
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
summary here
<!-- SECTION:FINAL_SUMMARY:END -->
`;

describe('task file parser', () => {
  it('maps every field the way `backlog task view --json` reports it', () => {
    expect(parseTaskFile(FULL)).toEqual({
      id: 'TASK-1', title: 'Parent: task with "quotes" and it\'s', status: 'ready', archived: false, type: 'bug', priority: 'high',
      project: null, assignees: ['@alice'], reporter: null, labels: ['minions:authorized', 'x y'], milestone: null,
      parentTaskId: 'TASK-9', references: ['https://x.y/z'], modifiedFiles: ['src/b.ts'], ordinal: 5, dueDate: '2026-11-01',
      description: 'Line one\n\n## Fake heading in desc\n\n<!-- minions:meta {"provenance":"agent-hypothesis"} -->',
      dependencies: ['TASK-2'], documentation: ['docs/c.md'],
      acceptanceCriteria: [{ index: 1, text: 'first ac', checked: false }, { index: 2, text: 'second, with comma', checked: true }],
      definitionOfDone: [{ index: 1, text: 'dod item', checked: false }],
      implementationPlan: 'step 1\nstep 2', implementationNotes: 'note 1\n\nnote 2', comments: [], finalSummary: 'summary here',
    });
  });

  it('defaults absent keys and sections like Backlog.md (empty lists, nulls)', () => {
    const t = parseTaskFile('---\nid: TASK-3\ntitle: C\nstatus: idea\nassignee: []\nlabels: []\ndependencies: []\n---\n\n\n');
    expect(t).toMatchObject({ assignees: [], labels: [], dependencies: [], references: [], documentation: [], modifiedFiles: [],
      priority: null, ordinal: null, parentTaskId: null, milestone: null, description: null, acceptanceCriteria: [],
      definitionOfDone: [], implementationPlan: null, implementationNotes: null, finalSummary: null });
    // An empty marked section is null, as in the view.
    const empty = parseTaskFile('---\nid: TASK-3\ntitle: C\nstatus: idea\n---\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n<!-- SECTION:NOTES:END -->\n');
    expect(empty?.implementationNotes).toBeNull();
  });

  it('reads the folded long titles js-yaml writes', () => {
    const fm = parseFrontmatter(['title: >-', '  Backlog listing spawns one Backlog.md process per task (status/next/claim take', '  3-7 s at 100 tasks)']);
    expect(fm?.get('title')).toBe('Backlog listing spawns one Backlog.md process per task (status/next/claim take 3-7 s at 100 tasks)');
  });

  it.each([
    ['CRLF line endings', FULL.replace(/\n/g, '\r\n')],
    ['an unknown frontmatter key', FULL.replace('ordinal: 5', 'ordinal: 5\nestimate: 3')],
    ['a flow list', FULL.replace('labels:\n  - \'minions:authorized\'\n  - x y', 'labels: [a, b]')],
    ['a lowercase id', FULL.replace('id: TASK-1', 'id: task-1')],
    ['a numeric dependency', FULL.replace('  - TASK-2', '  - 2')],
    ['a comments section', `${FULL}\n## Comments\n\n<!-- COMMENTS:BEGIN -->\nauthor: bob\n\n---\n\nhi\n\n---\n<!-- COMMENTS:END -->\n`],
    ['a legacy section without markers', FULL.replace('<!-- SECTION:PLAN:BEGIN -->\nstep 1\nstep 2\n<!-- SECTION:PLAN:END -->', 'step 1')],
    ['loose text outside sections', `${FULL}\nloose text\n`],
    ['an uppercase [X] checkbox', FULL.replace('- [x] #2', '- [X] #2')],
    ['an AC without an index', FULL.replace('- [x] #2 second', '- [x] second')],
    ['AC indexes with a gap', FULL.replace('- [x] #2', '- [x] #3')],
    ['a duplicated marker', FULL.replace('step 2', 'step 2\n<!-- SECTION:PLAN:END -->')],
    ['a folded scalar with extra indentation', FULL.replace("title: 'Parent: task with \"quotes\" and it''s'", 'title: >-\n  a\n    b')],
    ['no frontmatter', '# Title\n'],
    ['an unterminated frontmatter', '---\nid: TASK-1\ntitle: A\nstatus: idea\n'],
    ['an ambiguous plain scalar', FULL.replace('type: bug', 'type: yes')],
  ])('returns null (fall back to task view) for %s', (_name, text) => {
    expect(parseTaskFile(text)).toBeNull();
  });

  it('handles hand edits: a BOM falls back; reordered sections and a missing final newline read the same', () => {
    expect(parseTaskFile(`\ufeff${FULL}`)).toBeNull();
    const want = parseTaskFile(FULL);
    expect(parseTaskFile(FULL.replace(/\n+$/, ''))).toEqual(want);
    const fs = /\n## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->[\s\S]*?<!-- SECTION:FINAL_SUMMARY:END -->\n/.exec(FULL)![0];
    expect(parseTaskFile(FULL.replace(fs, '').replace('## Description', `${fs.trimStart()}\n## Description`))).toEqual(want);
  });

  it('cross-checks every field the list summary carries', () => {
    const t = parseTaskFile(FULL)!;
    const summary = { id: t.id, title: t.title, status: t.status, archived: false, type: t.type, priority: t.priority, project: null,
      assignees: t.assignees, reporter: null, labels: t.labels, milestone: null, parentTaskId: t.parentTaskId, references: t.references,
      modifiedFiles: t.modifiedFiles, ordinal: t.ordinal, dueDate: t.dueDate, acceptanceCriteriaCount: 2, acceptanceCriteriaCompleted: 1 };
    expect(matchesSummary(t, summary)).toBe(true);
    expect(matchesSummary(t, { ...summary, status: 'Ready' })).toBe(false);
    expect(matchesSummary(t, { ...summary, milestone: 'm-1' })).toBe(false);
    expect(matchesSummary(t, { ...summary, labels: ['x y'] })).toBe(false);
    expect(matchesSummary(t, { ...summary, acceptanceCriteriaCount: 3 })).toBe(false);
    expect(matchesSummary(t, { ...summary, acceptanceCriteriaCompleted: 0 })).toBe(false);
  });
});

const doc = (item: string) => `---
id: TASK-1
title: Doc
status: idea
assignee: []
created_date: '2026-10-23 17:32'
labels: []
dependencies:
  - TASK-2
documentation:
  - ${item}
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
x
<!-- SECTION:DESCRIPTION:END -->
`;

describe('task file parser: plain scalars outside the summary cross-check', () => {
  it('accepts plain list items that js-yaml reads as the same string', () => {
    for (const v of ['docs/x y.md', 'TASK-34', 'a-b_c', 'https://a/b']) expect(parseTaskFile(doc(v))?.documentation).toEqual([v]);
  });

  // Regression (task-24.1 QA): documentation and dependencies are not in the `task list` summary, so the
  // cross-check cannot catch these. Backlog.md (js-yaml) resolves them to a number, a Date, a mapping or a
  // comment-stripped string, so `task view` reports e.g. "80", "Infinity", "[object Object]", "TASK-1".
  // Keeping the literal text would give a different Task, a different version, and CONFLICT on update, so
  // each must return null (fall back to task view).
  it.each([
    ['sexagesimal', '1:20'], ['underscore int', '1_000'], ['.inf', '.inf'], ['.NaN', '.NaN'], ['date', '2026-10-23'],
    ['timestamp', '2026-10-23 10:00:00'], ['colon-tab mapping', 'a:\tb'], ['trailing colon mapping', 'TASK-1:'],
    ['tab comment', 'a\t#c'],
  ])('returns null for a YAML-ambiguous plain list item (%s)', (_n, v) => {
    expect(parseTaskFile(doc(v))).toBeNull();
  });

  it.each([
    ['bare colon mapping', 'x:'], ['colon-space mapping', 'a: b'], ['space comment', 'a #c'], ['hash', 'a#b'],
    ['hex', '0x1F'], ['octal', '010'], ['float', '1.5'], ['exponent', '1e3'], ['signed', '+1'], ['negative', '-1'],
    ['dot float', '.5'], ['-.inf', '-.inf'], ['.nan lower', '.nan'], ['ISO timestamp', '2026-10-23T10:00:00Z'],
    ['sexagesimal float', '190:20:30.15'], ['bool', 'True'], ['null', 'NULL'], ['tilde', '~'], ['yes', 'yes'],
    ['merge key', '<<'], ['value key', '='], ['anchor', '&a'], ['alias', '*a'], ['tag', '!x'], ['flow seq', '[a]'],
    ['flow map', '{a}'], ['question', '? a'], ['inner tab', 'a\tb'], ['nbsp', 'TASK-1\u00a0'], ['bom', '\ufeffTASK-1'],
    ['line separator', 'a\u2028b'], ['nel', 'a\u0085b'], ['zero width', 'a\u200bb'], ['backslash start', '\\x'],
  ])('returns null for another plain list item outside the allowlist (%s)', (_n, v) => {
    expect(parseTaskFile(doc(v))).toBeNull();
  });

  it('accepts conservative plain items and quoted forms, decoding js-yaml \\U escapes', () => {
    for (const v of ['task-1.2', 'src/a_b.ts', 'Ünïcödé — “quotes”', 'a :b', 'x - y', 'a, b'])
      expect(parseTaskFile(doc(v))?.documentation).toEqual([v]);
    expect(parseTaskFile(doc('TASK-3 \t'))?.documentation).toEqual(['TASK-3']);
    expect(parseTaskFile(doc("'1:20'"))?.documentation).toEqual(['1:20']);
    expect(parseTaskFile(doc('"a\\t#c"'))?.documentation).toEqual(['a\t#c']);
    expect(parseTaskFile(doc('"rocket \\U0001F680 \\u00e9"'))?.documentation).toEqual(['rocket 🚀 é']);
    expect(parseTaskFile(doc('"\\\\U0001F680"'))?.documentation).toEqual(['\\U0001F680']);
    for (const bad of ['"\\U00110000"', '"\\U0000D800"', '"\\x41"', '"\\e"', '"\\N"', '"\\_"', '"\\U0001F68"'])
      expect(parseTaskFile(doc(bad))).toBeNull();
  });

  it('returns null for a dependency followed by a tab comment', () => {
    expect(parseTaskFile(doc('ok').replace('  - TASK-2', '  - TASK-2\t# blocked on auth'))).toBeNull();
  });
});
