import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BacklogMdAdapter } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { matchesSummary, parseFrontmatter, parseTaskFile } from '../../src/backlog/taskfile.js';

const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'backlog')));
const hasCli = !!process.env.MINIONS_BACKLOG_BIN || onPath;
const bin = process.env.MINIONS_BACKLOG_BIN || 'backlog';

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

describe.skipIf(!hasCli)('fast listing vs task view (real CLI)', () => {
  let root: string;
  let a: BacklogMdAdapter;
  const scope = { milestone: null, requiredLabels: [], allowedPaths: ['**'] };
  const fresh = (readFiles = true) => new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), readFiles });
  const cli = (...args: string[]) => execFileSync(bin, args, { cwd: root, env: { ...process.env, BACKLOG_CWD: root, NO_COLOR: '1' }, encoding: 'utf8' });
  const tasksDir = () => join(root, 'backlog', 'tasks');
  /** Fast and view paths agree on listTasks and listReady; returns the fast path's spawn counts. */
  const compare = async () => {
    const fast = fresh(), slow = fresh(false);
    const [ft, st] = [await fast.listTasks(), await slow.listTasks()];
    expect(ft).toEqual(st);
    const listSpawns = fast.spawnCount;
    const [fr, sr] = [await fast.listReady(50, new Set(), scope), await slow.listReady(50, new Set(), scope)];
    expect(fr).toEqual(sr);
    return { tasks: ft, listSpawns, readySpawns: fast.spawnCount - listSpawns };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'minions-blfast-'));
    await writeBacklogConfig(root);
    a = fresh();
    // Tasks written by minions itself (meta block, ACs, labels, deps, parent, notes) ...
    const p = (await a.createTask({ title: 'Parent epic', description: 'Epic body\n\n## heading inside', acceptanceCriteria: ['one', 'two, with comma'],
      priority: 'high', labels: ['minions:authorized', 'epic'], status: 'ready', provenance: 'agent-hypothesis', idempotencyKey: 'f1' })).task;
    const c = (await a.createTask({ title: 'Child with a deliberately long title that js-yaml folds over two lines in the frontmatter block',
      description: 'Child body', acceptanceCriteria: ['works'], parent: p.id, dependencies: [p.id], status: 'ready',
      labels: ['minions:authorized'], workflow: 'docs', idempotencyKey: 'f2' })).task;
    await a.addNote(c.id, 'first note');
    await a.addNote(c.id, 'second note with `code` and "quotes"');
    const u = await a.updateTask(c.id, (await a.getTask(c.id)).version, { branch: 'agent/child', prUrl: 'https://github.com/o/r/pull/1' });
    expect(u.branch).toBe('agent/child');
    await a.createTask({ title: "It's: tricky #1", status: 'ready', labels: ['minions:authorized'], dependencies: [p.id, c.id], idempotencyKey: 'f3' });
    await a.closeTask((await a.createTask({ title: 'Done dep', idempotencyKey: 'f4' })).task.id, 'done');
    // ... and fields only humans set through Backlog.md.
    cli('task', 'create', 'Human task', '-d', 'by hand', '--ac', 'h1', '--dod', 'd1', '--plan', 'p1', '--notes', 'n1', '--final-summary', 'fs',
      '--ref', 'https://x.y/z', '--doc', 'docs/a.md', '--modified-file', 'src/a.ts', '-a', '@bob', '--type', 'bug', '--due-date', '2026-12-01',
      '-m', 'M1', '--ordinal', '3', '-p', 'TASK-1', '--dep', 'TASK-3', '--status', 'ready', '-l', 'minions:authorized');
    cli('task', 'edit', 'TASK-1.2', '--check-ac', '1');
    // Neither archived tasks nor drafts are listed.
    cli('task', 'create', 'To archive');
    cli('task', 'archive', 'TASK-4');
    cli('task', 'create', 'A draft', '--draft');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('gives identical Tasks (and versions) to task view with one Backlog.md process per listing', async () => {
    const { tasks, listSpawns, readySpawns } = await compare();
    // Backlog.md's list order (ordinal first) is kept.
    expect(tasks.map((t) => t.id)).toEqual(['task-1.2', 'task-1', 'task-1.1', 'task-2', 'task-3']);
    expect(listSpawns).toBe(1);
    expect(readySpawns).toBe(1);
    const child = tasks.find((t) => t.id === 'task-1.1')!;
    expect(child).toMatchObject({ parent: 'task-1', dependencies: ['task-1'], branch: 'agent/child', workflow: 'docs',
      prUrl: 'https://github.com/o/r/pull/1', acceptanceCriteria: [{ text: 'works', done: false }] });
    expect(child.version).toBe((await a.getTask('task-1.1')).version);
    expect(tasks.find((t) => t.id === 'task-1.2')).toMatchObject({ milestone: 'M1', parent: 'task-1', dependencies: ['task-3'],
      acceptanceCriteria: [{ text: 'h1', done: true }] });
    // The fast-path version is accepted by updateTask (optimistic concurrency keeps working).
    const upd = await a.updateTask('task-2', tasks.find((t) => t.id === 'task-2')!.version, { status: 'implementing' });
    expect(upd.status).toBe('implementing');
  });

  it('keeps a constant spawn count as the backlog grows', async () => {
    for (let i = 0; i < 6; i++) await a.createTask({ title: `Bulk ${i}`, status: 'ready', labels: ['minions:authorized'], acceptanceCriteria: ['x'], idempotencyKey: `bulk-${i}` });
    const { tasks, listSpawns, readySpawns } = await compare();
    expect(tasks.length).toBe(11);
    expect(listSpawns).toBe(1);
    expect(readySpawns).toBe(1);
  });

  it('falls back to task view only for files the reader cannot vouch for', async () => {
    cli('task', 'edit', 'TASK-3', '--comment', 'a human comment'); // comments section: not parsed in-process
    const file = readdirSync(tasksDir()).find((n) => n.startsWith('task-7 '))!;
    const legacy = readFileSync(join(tasksDir(), file), 'utf8').replace(/<!-- SECTION:DESCRIPTION:(BEGIN|END) -->\n/g, '');
    writeFileSync(join(tasksDir(), file), `${legacy}## Description\n\nlegacy text\n`);
    const { listSpawns } = await compare();
    expect(listSpawns).toBe(1 + 2);
  });

  it('falls back for duplicate ids and unreadable files', async () => {
    const file = readdirSync(tasksDir()).find((n) => n.startsWith('task-8 '))!;
    writeFileSync(join(tasksDir(), 'zz-copy.md'), readFileSync(join(tasksDir(), file), 'utf8'));
    const before = (await compare()).listSpawns;
    rmSync(join(tasksDir(), 'zz-copy.md'));
    expect(before).toBe(1 + 3);
    if (process.getuid?.() !== 0) {
      const target = join(tasksDir(), readdirSync(tasksDir()).find((n) => n.startsWith('task-9 '))!);
      chmodSync(target, 0o000);
      try {
        const fast = fresh();
        // Backlog.md cannot read it either; the result must match the pre-24.1 behaviour of the view path.
        const [f, s] = await Promise.allSettled([fast.listTasks(), fresh(false).listTasks()]);
        expect(f.status).toBe(s.status);
        if (f.status === 'fulfilled' && s.status === 'fulfilled') expect(f.value).toEqual(s.value);
        const [fr, sr] = await Promise.allSettled([fresh().listReady(50, new Set(), scope), fresh(false).listReady(50, new Set(), scope)]);
        expect(fr.status).toBe(sr.status);
        if (fr.status === 'fulfilled' && sr.status === 'fulfilled') expect(fr.value).toEqual(sr.value);
      } finally { chmodSync(target, 0o644); }
    }
  });
});
