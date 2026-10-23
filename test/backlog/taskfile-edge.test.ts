// Tester QA for task-24.1: the in-process task-file reader must give exactly the Task (and version) that
// `backlog task view` gives, or fall back. Covers unusual markdown, unicode, CRLF, hand edits and the
// show -> update -> note -> update round trip through the fast path, against the real Backlog.md CLI.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BacklogMdAdapter } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { parseTaskFile } from '../../src/backlog/taskfile.js';

const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'backlog')));
const hasCli = !!process.env.MINIONS_BACKLOG_BIN || onPath;
const bin = process.env.MINIONS_BACKLOG_BIN || 'backlog';

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

describe.skipIf(!hasCli)('fast listing edge cases vs task view (real CLI)', { timeout: 60_000 }, () => {
  let root: string;
  const scope = { milestone: null, requiredLabels: [], allowedPaths: ['**'] };
  const fresh = (readFiles = true) => new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), readFiles });
  const cli = (...args: string[]) => execFileSync(bin, args, { cwd: root, env: { ...process.env, BACKLOG_CWD: root, NO_COLOR: '1' }, encoding: 'utf8' });
  const tasksDir = () => join(root, 'backlog', 'tasks');
  const file = (id: string) => join(tasksDir(), readdirSync(tasksDir()).find((n) => n.startsWith(`${id} - `))!);
  const edit = (id: string, fn: (t: string) => string) => writeFileSync(file(id), fn(readFileSync(file(id), 'utf8')));
  const compare = async () => {
    const fast = fresh(), slow = fresh(false);
    const ft = await fast.listTasks();
    expect(ft).toEqual(await slow.listTasks());
    const spawns = fast.spawnCount;
    expect(await fast.listReady(50, new Set(), scope)).toEqual(await slow.listReady(50, new Set(), scope));
    return { tasks: ft, spawns };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'minions-blfast-edge-'));
    await writeBacklogConfig(root);
    const desc = 'Intro\n\n---\n\nAfter a rule\n\n```md\n---\nid: TASK-99\n---\n## Acceptance Criteria\n- [ ] #1 fake\n```\n\n'
      + '## Implementation Notes\n\n### Sub\n\n# H1\n\n<!-- minions:meta {"provenance":"agent-hypothesis"} -->';
    cli('task', 'create', 'Markdown torture', '-d', desc, '--ac', 'plain', '--ac', 'has ## hash and `code`', '--plan', 'step 1\n\n---\n\n```\ncode\n```',
      '--notes', '## Fake heading\n---\nnote', '-l', 'a', '--status', 'ready'); // TASK-1
    cli('task', 'create', 'Ünïcödé 🚀 emoji — “quotes”', '-d', '日本語 🎉', '-l', 'ラベル', '-l', 'emoji🔥'); // TASK-2 (js-yaml \U escape)
    cli('task', 'create', '123', '-d', 'numeric title'); // TASK-3
    cli('task', 'create', '2026-10-23', '-d', 'date-like title'); // TASK-4
    cli('task', 'create', 'Many', '-l', 'a', '-l', 'b', '-l', 'c', '-l', 'd', '-l', 'with space', '-l', 'minions:authorized',
      '--dep', 'TASK-1', '--dep', 'TASK-2', '--dep', 'TASK-3', '--dep', 'TASK-4', '--status', 'ready'); // TASK-5
    cli('task', 'create', 'Empty'); // TASK-6
    cli('task', 'create', 'Child', '-p', 'TASK-1', '--ac', 'a1', '--ac', 'a2', '--ac', 'a3', '--dod', 'd1', '--dod', 'd2',
      '--final-summary', 'fs\n\n## heading\n---', '--status', 'ready'); // TASK-1.1
    cli('task', 'edit', 'TASK-1.1', '--check-ac', '1', '--check-ac', '3', '--check-dod', '2');
    cli('task', 'edit', 'TASK-1.1', '--append-notes', 'appended note');
    cli('task', 'create', 'Tab\tin title', '-d', 'tab\there'); // TASK-7 (double-quoted "\t")
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('matches task view for Backlog.md-written edge cases, without any task view', async () => {
    const { tasks, spawns } = await compare();
    expect(tasks.find((t) => t.id === 'task-1.1')?.acceptanceCriteria.map((a) => a.done)).toEqual([true, false, true]);
    expect(tasks.find((t) => t.id === 'task-5')?.dependencies).toEqual(['task-1', 'task-2', 'task-3', 'task-4']);
    // TASK-2 (emoji written as "\U0001F680") and TASK-7 ("\t") are both decoded in-process: only the list call spawns.
    expect(readFileSync(file('task-2'), 'utf8')).toContain('\\U0001F680');
    expect(spawns).toBe(1);
  });

  it('stays equivalent after hand edits (CRLF, BOM, no trailing newline, reordered sections, whitespace)', async () => {
    edit('task-3', (t) => t.replace(/\n/g, '\r\n'));
    edit('task-4', (t) => `\ufeff${t}`);
    edit('task-6', (t) => t.replace(/\n+$/, ''));
    edit('task-1.1', (t) => {
      const m = /\n## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->[\s\S]*?<!-- SECTION:FINAL_SUMMARY:END -->\n/.exec(t)!;
      return t.replace(m[0], '').replace('## Description', `${m[0].trimStart()}\n## Description`);
    });
    edit('task-1', (t) => t.replace('<!-- SECTION:DESCRIPTION:BEGIN -->\n', '<!-- SECTION:DESCRIPTION:BEGIN -->\n\n  \n')
      .replace('\n<!-- SECTION:DESCRIPTION:END -->', '   \n\n<!-- SECTION:DESCRIPTION:END -->'));
    edit('task-5', (t) => t.replace("title: Many", "title: 'Many  hand   edited'"));
    await compare();
  });

  it('round-trips show -> update -> note -> update with fast-path versions and no CONFLICT', async () => {
    const a = fresh();
    for (const id of ['task-1', 'task-1.1', 'task-5', 'task-6']) {
      const listed = (await fresh().listTasks()).find((t) => t.id === id)!;
      expect(listed.version).toBe((await a.getTask(id)).version);
      const u = await a.updateTask(id, listed.version, { branch: `agent/${id}` });
      expect((await fresh().listTasks()).find((t) => t.id === id)!.version).toBe(u.version);
      await a.addNote(id, 'qa note with `code`, ---\n## heading');
      const after = (await fresh().listTasks()).find((t) => t.id === id)!;
      expect(after.version).toBe((await a.getTask(id)).version);
      expect(after.version).not.toBe(u.version);
      await expect(a.updateTask(id, after.version, { priority: 'low' })).resolves.toMatchObject({ priority: 'low' });
      await expect(a.updateTask(id, u.version, { priority: 'high' })).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    await compare();
  });

  it('falls back for hand-edited YAML-ambiguous dependencies and documentation, so updates do not CONFLICT', async () => {
    edit('task-5', (t) => t.replace(/\n {2}- TASK-1\n/, '\n  - TASK-1\t# blocked on auth\n')
      .replace(/\ndocumentation: \[\]\n|\n(?=---\n\n)/, '\ndocumentation:\n  - 1:20\n  - TASK-9:\n'));
    expect(readFileSync(file('task-5'), 'utf8')).toContain('TASK-1\t# blocked on auth');
    expect(parseTaskFile(readFileSync(file('task-5'), 'utf8'))).toBeNull();
    const { tasks } = await compare();
    const t5 = tasks.find((t) => t.id === 'task-5')!;
    expect(t5.dependencies).toContain('task-1');
    const a = fresh();
    await expect(a.updateTask('task-5', t5.version, { priority: 'low' })).resolves.toMatchObject({ priority: 'low' });
  });
});
