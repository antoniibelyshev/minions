import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BacklogMdAdapter } from '../../src/backlog/backlogmd.js';
import { MemoryIdempotencyStore, writeBacklogConfig } from '../../src/backlog/factory.js';
import { FAST_PATH_TESTED, fastPathHint, fastPathVersionOk, parseTaskFile } from '../../src/backlog/taskfile.js';
import { backlogCliCheck } from '../../src/host/doctor.js';
import { hostTools } from '../../src/host/runtime.js';

// task-24.9: the in-process task reader runs only for a tested Backlog.md release. A stub `backlog`
// (no real CLI needed) answers --version / task list / task view from state.json in the project root
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

const STUB = `#!/usr/bin/env node
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('state.json', 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync('calls.log', args.slice(0, 3).join(' ') + '\\n');
if (args[0] === '--version') {
  if (state.version === null) { process.stderr.write('boom\\n'); process.exit(1); }
  process.stdout.write(state.version + '\\n');
} else if (args[0] === 'task' && args[1] === 'list') {
  process.stdout.write(JSON.stringify({ tasks: [state.summary] }));
} else if (args[0] === 'task' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ task: state.view }));
} else { process.stderr.write('error: unexpected ' + args.join(' ') + '\\n'); process.exit(1); }
`;

describe('fast path version gate (stub CLI)', () => {
  let root: string;
  let bin: string;
  const parsed = parseTaskFile(FILE)!;

  const setVersion = (version: string | null) => writeFileSync(join(root, 'state.json'),
    JSON.stringify({ version, summary: parsed, view: { ...parsed, description: 'from view' } }));
  const calls = () => readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n');
  const adapter = (extra: { cliVersion?: string | null; readFiles?: boolean } = {}) =>
    new BacklogMdAdapter({ root, bin, idempotency: new MemoryIdempotencyStore(), startReady: true, ...extra });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'minions-blgate-'));
    await writeBacklogConfig(root);
    mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'backlog', 'tasks', 'task-1 - One.md'), FILE);
    writeFileSync(join(root, 'calls.log'), '');
    bin = join(root, 'backlog-stub');
    writeFileSync(bin, STUB);
    chmodSync(bin, 0o755);
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
    writeFileSync(join(root, 'state.json'), JSON.stringify({ version: '1.54.0', summary: parsed, view: parsed }));
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
    writeFileSync(join(root, 'state.json'), JSON.stringify({ version: '1.54.0', summary, view: { ...summary, description: 'from view' } }));
    const [t] = await adapter().listTasks();
    expect(t).toMatchObject({ id: 'mn-1', description: 'from view' });
    expect(calls()).toEqual(['task list --json', '--version', 'task view MN-1']);
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
