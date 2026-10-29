// Tester QA for task-24.1 (retest of the plain-scalar allowlist in src/backlog/taskfile.ts): every unquoted
// value the fast path accepts must give exactly the Task and version `backlog task view` gives. The values
// go into hand-written task files as dependencies, documentation items or titles; the fast listing is
// compared with `task view` from the real Backlog.md CLI.
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
// taskfile-edge.test.ts, and the fallback to `task view` for such a file in taskfile.test.ts. The list-item
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
