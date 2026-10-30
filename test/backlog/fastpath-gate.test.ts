import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BacklogMdAdapter, type BacklogExec } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { FAST_PATH_TESTED, fastPathHint, fastPathVersionOk, parseTaskFile } from '../../src/backlog/taskfile.js';
import { backlogCliCheck } from '../../src/host/doctor.js';
import { hostTools } from '../../src/host/runtime.js';

// task-24.9: the in-process task reader runs only for a tested Backlog.md release. An in-process fake
// `backlog` (the adapter's exec seam, no subprocess) answers --version / task list / task view from `state`
// and logs every call, so the tests see which path a listing took.

const FILE = `---
id: TASK-1
title: One
status: ready
assignee: []
labels: []
dependencies: []
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
from file
<!-- SECTION:DESCRIPTION:END -->
`;

interface StubState { version: string | null; summary: unknown; view: unknown }

/** The fake CLI: the same answers the old node stub script gave, without starting a process. */
const stub = (state: () => StubState, log: string[]): BacklogExec => async (_cmd, args) => {
  log.push(args.slice(0, 3).join(' '));
  const s = state();
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
  if (args[0] === '--version') return s.version === null ? { code: 1, stdout: '', stderr: 'boom\n' } : ok(`${s.version}\n`);
  if (args[0] === 'task' && args[1] === 'list') return ok(JSON.stringify({ tasks: [s.summary] }));
  if (args[0] === 'task' && args[1] === 'view') return ok(JSON.stringify({ task: s.view }));
  return { code: 1, stdout: '', stderr: `error: unexpected ${args.join(' ')}\n` };
};

describe('fast path version gate (fake CLI)', () => {
  let root: string;
  let state: StubState;
  let log: string[];
  const parsed = parseTaskFile(FILE)!;

  const setVersion = (version: string | null) => { state = { version, summary: parsed, view: { ...parsed, description: 'from view' } }; };
  const calls = () => log;
  const adapter = (extra: { cliVersion?: string | null; readFiles?: boolean } = {}) =>
    new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), startReady: true, exec: stub(() => state, log), ...extra });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'minions-blgate-'));
    await writeBacklogConfig(root);
    mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'backlog', 'tasks', 'task-1 - One.md'), FILE);
    log = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads task files for a tested version and asks --version once per adapter', async () => {
    setVersion('1.54.0');
    const a = adapter();
    expect((await a.listTasks())[0]!.description).toBe('from file');
    expect((await a.listTasks())[0]!.description).toBe('from file');
    expect((await a.listReady(5, new Set(), { milestone: null, requiredLabels: [], allowedPaths: ['**'] }))[0]!.description).toBe('from file');
    expect(calls()).toEqual(['task list --json', '--version', 'task list --json', 'task list --json']);
  });

  it('accepts any 1.54.x patch release', async () => {
    setVersion('1.54.7');
    expect((await adapter().listTasks())[0]!.description).toBe('from file');
  });

  it.each(['1.55.0', '1.53.2', '2.0.0', '1.54.0-beta.1', 'backlog.md', ''])('views every task for version %j', async (v) => {
    setVersion(v);
    const a = adapter();
    expect((await a.listTasks())[0]!.description).toBe('from view');
    expect((await a.listTasks())[0]!.description).toBe('from view');
    expect(calls()).toEqual(['task list --json', '--version', 'task view TASK-1', 'task list --json', 'task view TASK-1']);
  });

  it('views every task when --version fails', async () => {
    setVersion(null);
    expect((await adapter().listTasks())[0]!.description).toBe('from view');
    expect(calls()).toEqual(['task list --json', '--version', 'task view TASK-1']);
  });

  it('gives the same Tasks on both paths', async () => {
    state = { version: '1.54.0', summary: parsed, view: parsed };
    const fast = await adapter().listTasks();
    expect(fast).toEqual(await adapter({ cliVersion: '9.9.9' }).listTasks());
  });

  it('reuses the version capabilities() reported', async () => {
    setVersion('1.54.0');
    const a = adapter();
    expect((await a.capabilities()).version).toBe('1.54.0');
    await a.listTasks();
    expect(calls()).toEqual(['--version', 'task list --json']);
  });

  it('takes an injected version instead of probing', async () => {
    setVersion('2.0.0');
    expect((await adapter({ cliVersion: '1.54.0' }).listTasks())[0]!.description).toBe('from file');
    expect((await adapter({ cliVersion: '1.60.0' }).listTasks())[0]!.description).toBe('from view');
    expect((await adapter({ cliVersion: null }).listTasks())[0]!.description).toBe('from view');
    expect(calls().filter((c) => c === '--version')).toEqual([]);
  });

  it('never probes the version when file reading is off', async () => {
    setVersion('1.54.0');
    expect((await adapter({ readFiles: false }).listTasks())[0]!.description).toBe('from view');
    expect(calls()).toEqual(['task list --json', 'task view TASK-1']);
  });

  it('views a task with a non-TASK prefix even on a tested version (documented in backlogmd-cli.md)', async () => {
    const mn = FILE.replace('id: TASK-1', 'id: MN-1');
    rmSync(join(root, 'backlog', 'tasks', 'task-1 - One.md'));
    writeFileSync(join(root, 'backlog', 'tasks', 'mn-1 - One.md'), mn);
    expect(parseTaskFile(mn)).toBeNull();
    const summary = { ...parsed, id: 'MN-1' };
    state = { version: '1.54.0', summary, view: { ...summary, description: 'from view' } };
    const [t] = await adapter().listTasks();
    expect(t).toMatchObject({ id: 'mn-1', description: 'from view' });
    expect(calls()).toEqual(['task list --json', '--version', 'task view MN-1']);
  });
});

describe('fast listing fallbacks (fake CLI)', () => {
  // Each task has a file and a matching list summary; `task view` answers from the same raw task, so both paths
  // agree and the call log shows exactly which tasks the listing viewed.
  let root: string;
  let log: string[];
  let raws: Map<string, Record<string, unknown>>;
  const fileOf = (n: number) => FILE.replace('id: TASK-1', `id: TASK-${n}`).replace('title: One', `title: Task ${n}`);
  const dir = () => join(root, 'backlog', 'tasks');
  const exec: BacklogExec = async (_cmd, args) => {
    log.push(args.slice(0, 3).join(' '));
    if (args[0] === '--version') return { code: 0, stdout: '1.54.0\n', stderr: '' };
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify({ tasks: [...raws.values()] }), stderr: '' };
    return { code: 0, stdout: JSON.stringify({ task: raws.get(args[2]!) }), stderr: '' };
  };
  const adapter = (readFiles = true) => new BacklogMdAdapter({ root, idempotency: new MemoryIdempotencyStore(), startReady: true, exec, readFiles });
  const views = () => log.filter((c) => c.startsWith('task view')).map((c) => c.slice('task view '.length)).sort();
  const add = (n: number) => {
    writeFileSync(join(dir(), `task-${n} - Task ${n}.md`), fileOf(n));
    raws.set(`TASK-${n}`, parseTaskFile(fileOf(n))! as unknown as Record<string, unknown>);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'minions-blfall-'));
    await writeBacklogConfig(root);
    mkdirSync(dir(), { recursive: true });
    log = [];
    raws = new Map();
    for (let n = 1; n <= 4; n++) add(n);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps one CLI process per listing as the backlog grows, with the same Tasks as task view', async () => {
    const a = adapter();
    expect(await a.listTasks()).toEqual(await adapter(false).listTasks());
    for (let n = 5; n <= 40; n++) add(n);
    log = [];
    expect(await a.listTasks()).toHaveLength(40);
    expect(await a.listReady(50, new Set(), { milestone: null, requiredLabels: [], allowedPaths: ['**'] })).toHaveLength(40);
    expect(log).toEqual(['task list --json', 'task list --json']);
  });

  it('views only the tasks the reader cannot vouch for: unparseable, duplicated, missing or disagreeing with the list', async () => {
    writeFileSync(join(dir(), 'task-1 - Task 1.md'), fileOf(1).replace('## Description', '## Comments')); // unknown section
    writeFileSync(join(dir(), 'zz-copy.md'), fileOf(2)); // a second file with id TASK-2
    rmSync(join(dir(), 'task-3 - Task 3.md')); // listed, but no file
    raws.set('TASK-4', { ...raws.get('TASK-4')!, status: 'Ready' }); // the list summary normalised a field differently
    const a = adapter();
    expect(await a.listTasks()).toEqual(await adapter(false).listTasks());
    log = [];
    await adapter().listTasks();
    expect(log.filter((c) => c.startsWith('task list'))).toHaveLength(1);
    expect(views()).toEqual(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']);
  });

  it('views a task whose file cannot be read', async () => {
    rmSync(join(dir(), 'task-2 - Task 2.md'));
    mkdirSync(join(dir(), 'task-2 - Task 2.md')); // a directory: readFile fails
    await adapter().listTasks();
    expect(views()).toEqual(['TASK-2']);
  });
});

describe('tested version helpers and doctor hints', () => {
  it('fastPathVersionOk accepts only 1.54.x', () => {
    for (const v of ['1.54.0', '1.54.12', ' 1.54.0\n', 'v1.54.1']) expect(fastPathVersionOk(v)).toBe(true);
    for (const v of ['1.55.0', '1.5.40', '11.54.0', '1.54', '1.54.0-rc.1', 'x', '', null, undefined]) expect(fastPathVersionOk(v)).toBe(false);
  });

  it('fastPathHint names the tested line only for other versions', () => {
    expect(fastPathHint('1.54.0')).toBeNull();
    expect(fastPathHint('1.60.0')).toContain(FAST_PATH_TESTED);
    expect(fastPathHint('1.60.0')).toContain('task view');
  });

  it('doctor backlog.cli: ok for 1.54.x, warn with a hint otherwise, fail when unusable', () => {
    expect(backlogCliCheck({ code: 0, stdout: '1.54.0\n', stderr: '' })).toEqual({ name: 'backlog.cli', status: 'ok', detail: 'backlog.md 1.54.0' });
    const warn = backlogCliCheck({ code: 0, stdout: '1.60.0\n', stderr: '' });
    expect(warn).toMatchObject({ name: 'backlog.cli', status: 'warn', hint: expect.stringContaining('minions upgrade') });
    expect(warn.detail).toMatch(/^backlog\.md 1\.60\.0: untested .*1\.54\.x/);
    expect(backlogCliCheck({ code: 127, stdout: '', stderr: 'not found' })).toMatchObject({ status: 'fail', detail: 'backlog CLI not usable: not found' });
  });

  it('host tools: the backlog detail notes the slower listing path for an untested version', async () => {
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    const at = async (v: string) => (await hostTools(async (cmd) => ok(cmd === 'backlog' ? v : 'x')))
      .find((t) => t.name === 'backlog')!.detail;
    expect(await at('1.54.0')).toBe('1.54.0');
    expect(await at('1.60.0')).toMatch(/^1\.60\.0 \(tested with 1\.54\.0\); untested for in-process task reading/);
  });
});
