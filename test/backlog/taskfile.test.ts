// End-to-end check of the in-process task-file reader (task-24.1) against the real Backlog.md CLI: for the files
// Backlog.md writes, and for every plain scalar the reader's allowlist accepts, the fast listing gives exactly the
// Tasks (and versions) `backlog task view` gives, with one CLI process per listing. The parser itself (strict
// layout, fallbacks) is unit-tested in taskfile-edge.test.ts, the adapter's listing paths in fastpath-gate.test.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BacklogMdAdapter } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { parseTaskFile } from '../../src/backlog/taskfile.js';
import type { Task } from '../../src/backlog/types.js';

const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'backlog')));
const hasCli = !!process.env.MINIONS_BACKLOG_BIN || onPath;
const bin = process.env.MINIONS_BACKLOG_BIN || 'backlog';

describe.skipIf(!hasCli)('fast listing vs task view (real CLI)', { timeout: 30_000 }, () => {
  let root: string;
  let a: BacklogMdAdapter;
  const scope = { milestone: null, requiredLabels: [], allowedPaths: ['**'] };
  const fresh = (readFiles = true) => new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), readFiles });
  const cli = (...args: string[]) => execFileSync(bin, args, { cwd: root, env: { ...process.env, BACKLOG_CWD: root, NO_COLOR: '1' }, encoding: 'utf8' });
  const tasksDir = () => join(root, 'backlog', 'tasks');
  /** Fast and view paths agree on listTasks and listReady; returns the fast path's spawn counts. */
  const compare = async () => {
    const fast = fresh(), slow = fresh(false);
    await fast.capabilities(); // asks `backlog --version` once (task-24.9); the listings below reuse the cached answer
    const base = fast.spawnCount;
    const [ft, st] = [await fast.listTasks(), await slow.listTasks()];
    expect(ft).toEqual(st);
    const listSpawns = fast.spawnCount - base;
    const [fr, sr] = [await fast.listReady(50, new Set(), scope), await slow.listReady(50, new Set(), scope)];
    expect(fr).toEqual(sr);
    return { tasks: ft, listSpawns, readySpawns: fast.spawnCount - base - listSpawns };
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
    const u = await a.updateTask(c.id, (await a.getTask(c.id)).version, { branch: 'agent/child' });
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
    // Files with unusual content, all written by Backlog.md (task-24.1 QA): markdown look-alikes, emoji (js-yaml
    // writes "\U0001F680"), titles YAML could read as a number or date, a tab (written as "\t").
    const desc = 'Intro\n\n---\n\nAfter a rule\n\n```md\n---\nid: TASK-99\n---\n## Acceptance Criteria\n- [ ] #1 fake\n```\n\n'
      + '## Implementation Notes\n\n### Sub\n\n# H1\n\n<!-- minions:meta {"provenance":"agent-hypothesis"} -->';
    cli('task', 'create', 'Markdown torture', '-d', desc, '--ac', 'plain', '--ac', 'has ## hash and `code`', '--plan', 'step 1\n\n---\n\n```\ncode\n```',
      '--notes', '## Fake heading\n---\nnote', '-l', 'minions:authorized', '--status', 'ready');
    cli('task', 'create', 'Ünïcödé 🚀 emoji — “quotes”', '-d', '日本語 🎉', '-l', 'ラベル', '-l', 'emoji🔥');
    cli('task', 'create', '123', '-d', 'numeric title');
    cli('task', 'create', '2026-10-23', '-d', 'date-like title');
    cli('task', 'create', 'Tab\tin title', '-d', 'tab\there');
    // A comments section is a layout the reader does not parse: this one task falls back to `task view`.
    cli('task', 'edit', 'TASK-3', '--comment', 'a human comment');
  }, 90_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('gives identical Tasks (and versions) to task view, viewing only the file it cannot vouch for', async () => {
    const { tasks, listSpawns, readySpawns } = await compare();
    // Backlog.md's list order (ordinal first) is kept; archived tasks and drafts are not listed.
    expect(tasks[0]!.id).toBe('task-1.2');
    expect(tasks).toHaveLength(10);
    expect(tasks.map((t) => t.title)).toEqual(expect.arrayContaining(['Done dep', 'Human task', "It's: tricky #1", 'Markdown torture']));
    expect(tasks.map((t) => t.title)).not.toEqual(expect.arrayContaining(['To archive']));
    expect(tasks.map((t) => t.title)).not.toEqual(expect.arrayContaining(['A draft']));
    expect(listSpawns).toBe(1 + 1); // the list, plus one view for the commented task-3
    expect(readySpawns).toBe(1); // task-3 is done, so not a candidate
    expect(readdirSync(tasksDir()).some((n) => readFileSync(join(tasksDir(), n), 'utf8').includes('\\U0001F680'))).toBe(true);
    const child = tasks.find((t) => t.id === 'task-1.1')!;
    expect(child).toMatchObject({ parent: 'task-1', dependencies: ['task-1'], branch: 'agent/child', workflow: 'docs',
      acceptanceCriteria: [{ text: 'works', done: false }] });
    expect(child.version).toBe((await a.getTask('task-1.1')).version);
    expect(tasks.find((t) => t.id === 'task-1.2')).toMatchObject({ milestone: 'M1', parent: 'task-1', dependencies: ['task-3'],
      acceptanceCriteria: [{ text: 'h1', done: true }] });
    // The fast-path version is accepted by updateTask (optimistic concurrency keeps working).
    const upd = await a.updateTask('task-2', tasks.find((t) => t.id === 'task-2')!.version, { status: 'implementing' });
    expect(upd.status).toBe('implementing');
  });

  it('round-trips list -> update -> note -> update with fast-path versions and no CONFLICT', async () => {
    const listed = (await fresh().listTasks()).find((t) => t.title === 'Markdown torture')!;
    const id = listed.id;
    expect(listed.version).toBe((await a.getTask(id)).version);
    const u = await a.updateTask(id, listed.version, { branch: `agent/${id}` });
    expect((await fresh().listTasks()).find((t) => t.id === id)!.version).toBe(u.version);
    await a.addNote(id, 'qa note with `code`, ---\n## heading');
    const after = (await fresh().listTasks()).find((t) => t.id === id)!;
    expect(after.version).toBe((await a.getTask(id)).version);
    expect(after.version).not.toBe(u.version);
    await expect(a.updateTask(id, after.version, { priority: 'low' })).resolves.toMatchObject({ priority: 'low' });
    await expect(a.updateTask(id, u.version, { priority: 'high' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await compare();
  });
});

// Values the coordinator asked to probe, plus neighbours of each allowlist boundary.
const VALUES = [
  'a: b', 'a :b', 'a:b', 'key: value', 'a :', 'a:', ':a', 'x::y', 'a:-b', 'a:/b', 'a:漢', '漢字:かな', 'a:\u0301b',
  'http://x', 'https://x.y/z?q=1', 'x:y', 'TASK-3:x',
  'TASK-3   ', 'a b  ',
  '-a', '- a', '?a', '? a', '!a', '&a', '*a', '|a', '>a', '%a', '@a', '`a',
  'a"b', "a'b", 'a "b" c', "it's", 'a\\b', 'a`b`',
  'yes', 'no', 'on', 'off', 'null', '~', 'Yes', 'NO', 'Null', 'y', 'n', 'Y', 'true', 'False', 'yesno', 'onoff', 'nullx',
  '0o17', '017', '0x1F', '0b101', '1e3', '1E3', '1_000', '12', '-12', '007',
  'a #b', 'a#b', 'a # b', 'a #',
  'a,b', 'a[b]', 'a{b}', 'a|b', 'a>b', 'a=b', 'a&b', 'a*b', 'a!b', 'a%b', 'a@b', 'a?b', 'a - b',
  'Infinity', 'NaN', 'inf', 'nan',
  'a:|', 'a:>b', 'a:!b', 'a:,b', 'a:[b]', 'a:{', 'a:"c"', "a:'b'", 'a:*b', 'a:&b', 'a:-', 'a:\u00a0b', 'a:\u3000b',
  '^a', '$a', '(a)', '/a', '_a', ';a', 'é', '🚀 rocket', 'a 🚀', '👍', 'a\u3000b', 'a\u00a0b', 'ﬁ', 'Ⅻ', '٣',
];



// Only the values the parser accepts are probed against the CLI: the rejected ones (null) are unit-tested in
// taskfile-edge.test.ts, and the fallback to `task view` for such a file in fastpath-gate.test.ts. The list-item
// values share one task file per field, so the oracle costs two task views instead of one per value
// (task-104.2). Titles are single-valued (one file each) and part of the list summary the adapter
// cross-checks: a title the parser read differently from Backlog.md would fall back and add a spawn.
describe.skipIf(!hasCli)('plain-scalar allowlist vs task view (real CLI)', { timeout: 60_000 }, () => {
  let root: string;
  const titles: string[] = [];
  let deps: string[] = [];
  let docs: string[] = [];
  let fastTasks: Task[] = [];
  const viewed = new Map<string, Task>();
  let fastSpawns = 0;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'minions-allowlist-'));
    await writeBacklogConfig(root);
    const cli = (...a: string[]) => execFileSync(bin, a, { cwd: root, env: { ...process.env, BACKLOG_CWD: root, NO_COLOR: '1' }, encoding: 'utf8' });
    cli('task', 'create', 'Target', '-d', 'dep target'); // TASK-1
    cli('task', 'create', 'Template', '-d', 'body', '--dep', 'TASK-1', '--ac', 'one', '--status', 'ready'); // TASK-2
    const dir = join(root, 'backlog', 'tasks');
    const tmpl = readFileSync(join(dir, readdirSync(dir).find((n) => n.startsWith('task-2 '))!), 'utf8');
    expect(tmpl).toMatch(/\ndependencies:\n {2}- TASK-1\n/);
    const withId = (id: string) => tmpl.replace(/^id: TASK-2$/m, `id: ${id}`);
    const items = (vs: string[]) => vs.map((v) => `  - ${v}\n`).join('');
    const depFile = (vs: string[]) => withId('TASK-100').replace(/\ndependencies:\n {2}- TASK-1\n/, `\ndependencies:\n${items(vs)}`);
    const docFile = (vs: string[]) => withId('TASK-101').replace(/\ndependencies:\n/, `\ndocumentation:\n${items(vs)}dependencies:\n`);
    // A value is probed when the parser accepts a file carrying it alone.
    deps = VALUES.filter((v) => parseTaskFile(depFile([v])));
    docs = VALUES.filter((v) => parseTaskFile(docFile([v])));
    const files: [string, string][] = [['task-100 - Deps.md', depFile(deps)], ['task-101 - Docs.md', docFile(docs)]];
    let n = 200;
    for (const value of VALUES) {
      const t = withId(`TASK-${n++}`).replace(/^title: Template$/m, `title: ${value}`);
      if (parseTaskFile(t)) { files.push([`task-${n - 1} - Case.md`, t]); titles.push(value); }
    }
    for (const [name, t] of files) { expect(parseTaskFile(t), name).not.toBeNull(); writeFileSync(join(dir, name), t); }
    const fast = new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore() });
    await fast.capabilities(); // asks `backlog --version` once (task-24.9); the listing below reuses the cached answer
    const base = fast.spawnCount;
    fastTasks = await fast.listTasks();
    fastSpawns = fast.spawnCount - base;
    const slow = new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), readFiles: false });
    // getTask also carries the notes (task-98); listings never do, so compare without them.
    for (const id of ['task-100', 'task-101']) { const { notes: _n, ...t } = await slow.getTask(id); viewed.set(id, t); }
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('gives the same Task and version as task view for every list item value the fast path accepts', () => {
    expect(deps.length).toBeGreaterThan(50);
    expect(docs.length).toBeGreaterThan(50);
    for (const id of ['task-100', 'task-101']) expect(fastTasks.find((t) => t.id === id)).toEqual(viewed.get(id));
    // Backlog.md keeps every item as its own entry: none merged, dropped or split (documentation is only in the version).
    expect(viewed.get('task-100')!.dependencies).toHaveLength(deps.length);
  });

  it('keeps the fast path for allowlisted values: one list call and no task view, titles included', () => {
    expect(titles.length).toBeGreaterThan(50);
    expect(fastTasks).toHaveLength(2 + 2 + titles.length); // Backlog.md lists every accepted file
    // Every file (TASK-1 and TASK-2, written by the CLI, too) is read in-process and agrees with the list summary.
    expect(fastSpawns).toBe(1);
  });
});
