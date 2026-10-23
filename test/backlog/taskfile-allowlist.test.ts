// Tester QA for task-24.1 (retest of the plain-scalar allowlist in src/backlog/taskfile.ts): every unquoted
// value the fast path accepts must give exactly the Task and version `backlog task view` gives. Each case is
// a hand-written task file with the value as a dependency, a documentation item or the title; the fast
// listing is compared field by field with the view-per-task listing from the real Backlog.md CLI.
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

const FIELDS = ['dependencies', 'documentation', 'title'] as const; // documentation is only in the version hash
type Field = (typeof FIELDS)[number];

describe.skipIf(!hasCli)('plain-scalar allowlist vs task view (real CLI)', { timeout: 180_000 }, () => {
  let root: string;
  const cases: { id: string; field: Field; value: string; fast: boolean }[] = [];
  let fastTasks: Task[] = [];
  let slowTasks: Task[] = [];
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
    let n = 100;
    for (const field of FIELDS) {
      // documentation goes through the same list-item path as dependencies: probe it with the accepted values only.
      for (const value of field === 'documentation' ? VALUES.filter((v) => parseTaskFile(tmpl.replace(/\ndependencies:\n {2}- TASK-1\n/, `\ndependencies:\n  - ${v}\n`))) : VALUES) {
        const id = `TASK-${n++}`;
        let t = tmpl.replace(/^id: TASK-2$/m, `id: ${id}`);
        if (field === 'title') t = t.replace(/^title: Template$/m, `title: ${value}`);
        else if (field === 'dependencies') t = t.replace(/\ndependencies:\n {2}- TASK-1\n/, `\ndependencies:\n  - ${value}\n`);
        else t = t.replace(/\ndependencies:\n/, `\ndocumentation:\n  - ${value}\ndependencies:\n`);
        expect(t).not.toBe(tmpl);
        writeFileSync(join(dir, `${id.toLowerCase()} - Case.md`), t);
        cases.push({ id: id.toLowerCase(), field, value, fast: parseTaskFile(t) !== null });
      }
    }
    const fast = new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore() });
    await fast.capabilities(); // asks `backlog --version` once (task-24.9); the listing below reuses the cached answer
    const base = fast.spawnCount;
    fastTasks = await fast.listTasks();
    fastSpawns = fast.spawnCount - base;
    // Fallback tasks were already viewed by the fast listing; only the accepted ones need a task view to compare.
    const slow = new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), readFiles: false });
    const listedIds = new Set(fastTasks.map((t) => t.id));
    for (const c of cases) if (c.fast && listedIds.has(c.id)) slowTasks.push(await slow.getTask(c.id));
  }, 180_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('gives the same Task and version as task view for every value the fast path accepts', () => {
    const diff = cases.flatMap((c) => {
      const f = fastTasks.find((t) => t.id === c.id), s = slowTasks.find((t) => t.id === c.id);
      if (!c.fast || (!f && !s)) return [];
      return JSON.stringify(f) === JSON.stringify(s) ? [] : [`${c.field} ${JSON.stringify(c.value)} fast=${c.fast}: ${JSON.stringify(f)} vs view ${JSON.stringify(s)}`];
    });
    expect(diff).toEqual([]);
  });

  it('keeps the fast path for allowlisted values: one list call plus one view per fallback only', () => {
    const listed = cases.filter((c) => fastTasks.some((t) => t.id === c.id));
    expect(listed.filter((c) => c.fast)).toEqual(cases.filter((c) => c.fast)); // Backlog.md lists every accepted file
    expect(listed.filter((c) => c.fast).length).toBeGreaterThan(100);
    // TASK-1 and TASK-2 (CLI-written) are read in-process too.
    expect(fastSpawns).toBe(1 + listed.filter((c) => !c.fast).length);
  });
});
