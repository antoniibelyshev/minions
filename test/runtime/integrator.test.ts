// Local integrator (task-82.2, docs/design/local-auto-integration.md phase 2): queue, lock, verify runner and
// recovery, on temp repositories with fake verification commands (never the workspace checkout, never npm test).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { integrationCandidate, porcelainPaths } from '../../src/runtime/integration.js';
import {
  adoptIntegrationBase, enqueueIntegration, INTEGRATION_BASE_META, INTEGRATION_LOCK_META, integrationHalt, integrationLock,
  integrationRows, integratorAlive, runIntegrator, type IntegratorDeps,
} from '../../src/runtime/integrator.js';
import { pending } from '../../src/runtime/outbox.js';
import { isAlive, procIdentity } from '../../src/runtime/runner/record.js';
import { defaults } from '../helpers.js';
import { gitSync, initRepo, tmp } from './fixtures.js';

const branchOf = (task: string) => `agent/${task}-thing`;

function commit(dir: string, file: string, content: string, msg = `edit ${file}`): string {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  gitSync(dir, 'add', file);
  gitSync(dir, 'commit', '-q', '-m', msg);
  return gitSync(dir, 'rev-parse', 'HEAD');
}
/** Commits files on a new branch from `from` without touching the main checkout. */
function branchWith(repo: string, branch: string, from: string, files: Record<string, string>): string {
  const wt = join(tmp('minions-integrator-wt-'), 'wt');
  gitSync(repo, 'worktree', 'add', '-q', '-b', branch, wt, from);
  let sha = '';
  for (const [f, c] of Object.entries(files)) sha = commit(wt, f, c);
  gitSync(repo, 'worktree', 'remove', '--force', wt);
  return sha;
}

function setup(o: { commands?: string[]; setupCommands?: string[] } = {}) {
  const root = tmp('minions-integrator-');
  const repo = join(root, 'repo');
  const init = initRepo(repo);
  const B = commit(repo, 'base.txt', 'base\n', 'base change');
  const db = new RuntimeDb(join(root, 'minions.db'));
  const cfg = structuredClone(defaults()) as MinionsConfig;
  cfg.verification.commands = o.commands ?? ['true'];
  cfg.verification.setupCommands = o.setupCommands ?? [];
  const deps: IntegratorDeps = {
    db, repo, integrationDir: join(root, 'integration'), runDir: join(root, 'run', 'integration'), logDir: join(root, 'logs', 'integration'),
    config: () => cfg, env: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: 'secret-token', ANTHROPIC_API_KEY: 'secret-key' },
    timing: { pollMs: 50, killGraceMs: 500, reapGraceMs: 500 },
  };
  /** A task branch from init with one file, queued. */
  const queue = (task: string, files: Record<string, string> = { [`${task}.txt`]: `${task}\n` }) => {
    const H = branchWith(repo, branchOf(task), init, files);
    enqueueIntegration(db, { taskId: task, branch: branchOf(task), head: H });
    return H;
  };
  return { root, repo, init, B, db, cfg, deps, queue };
}
const mainOf = (repo: string) => gitSync(repo, 'rev-parse', 'refs/heads/main');
const rowOf = (db: RuntimeDb, task: string) => integrationRows(db, task).at(-1)!;
const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); }
};

describe('runIntegrator: landing and the verify runner', () => {
  it('merges, verifies in the integration worktree with the allowlisted env, and lands C on main', async () => {
    const s = setup({ commands: ['mkdir -p node_modules && env > node_modules/env.txt', 'test -f base.txt && test -f task-1.txt'] });
    const H = s.queue('task-1');
    const r = await runIntegrator(s.deps);
    expect(r.exit).toBe('empty');
    expect(r.settled).toEqual([{ id: 1, taskId: 'task-1', phase: 'landed' }]);
    const C = mainOf(s.repo);
    expect(gitSync(s.repo, 'rev-list', '--parents', '-n', '1', C).split(' ').slice(1)).toEqual([s.B, H]);
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'landed', base_sha: s.B, candidate_sha: C, attempt: 1, verify_pid: null });
    expect(s.db.getMeta(INTEGRATION_BASE_META)).toBe(C);
    expect(s.db.events('task-1', 'integrated')).toHaveLength(1);
    // The checkout of main was fast-forwarded; the verification ran on exactly C in the integration worktree.
    expect(gitSync(s.repo, 'status', '--porcelain')).toBe('');
    expect(gitSync(s.deps.integrationDir, 'rev-parse', 'HEAD')).toBe(C);
    const env = readFileSync(join(s.deps.integrationDir, 'node_modules', 'env.txt'), 'utf8');
    expect(env).toMatch(/^MINIONS_TEST_MAX_WORKERS=2$/m);
    expect(env).toMatch(/^CI=1$/m);
    expect(env).toContain(`HOME=${join(s.deps.runDir, 'home')}`);
    expect(env).toContain(`TMPDIR=${join(s.deps.runDir, 'tmp')}`);
    expect(env).not.toMatch(/TELEGRAM|ANTHROPIC|secret/);
    expect(integrationLock(s.db)).toBeNull();
  });

  it('every landing queues one integrated notice with the task, merge SHA and changed paths (capped with a count)', async () => {
    const s = setup();
    s.queue('task-1');
    const many: Record<string, string> = {};
    for (let i = 0; i < 25; i++) many[`src/f${String(i).padStart(2, '0')}.ts`] = `${i}\n`;
    s.queue('task-2', many);
    await runIntegrator(s.deps);
    const C1 = rowOf(s.db, 'task-1').candidate_sha!;
    const C2 = rowOf(s.db, 'task-2').candidate_sha!;
    const notes = pending(s.db, { includeWaiting: true }).filter((n) => n.key.startsWith('integrated:'));
    expect(notes.map((n) => [n.key, n.kind, n.taskId])).toEqual([[`integrated:task-1:${C1}`, 'other', 'task-1'], [`integrated:task-2:${C2}`, 'other', 'task-2']]);
    expect(notes[0]!.text).toBe(`task-1 merged into main at ${C1}; 1 changed path: task-1.txt. ref: #task-1`);
    expect(notes[1]!.text).toContain(`task-2 merged into main at ${C2}; 25 changed paths: src/f00.ts, `);
    expect(notes[1]!.text).toContain('src/f19.ts, … +5 more. ref: #task-2');
    expect(notes[1]!.text).not.toContain('src/f20.ts');
  });

  it('a failing command is red: main stays at B and the log tail is the detail', async () => {
    const s = setup({ commands: ['true', 'echo boom-from-tests; exit 3'] });
    s.queue('task-1');
    const r = await runIntegrator(s.deps);
    expect(r.settled.map((x) => x.phase)).toEqual(['red']);
    expect(mainOf(s.repo)).toBe(s.B);
    const row = rowOf(s.db, 'task-1');
    expect(row.phase).toBe('red');
    expect(row.detail).toMatch(/echo boom-from-tests; exit 3` failed twice: failed again on its rerun \(exit 3\)\nboom-from-tests/);
    expect(readFileSync(row.log_path!, 'utf8')).toContain('boom-from-tests');
    expect(s.db.getMeta(INTEGRATION_BASE_META)).toBe(s.B);
  });

  it('a conflict ends as conflict with the paths and leaves main unchanged', async () => {
    const s = setup();
    s.queue('task-1', { 'base.txt': 'other\n' });
    await runIntegrator(s.deps);
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'conflict' });
    expect(rowOf(s.db, 'task-1').detail).toContain('base.txt');
    expect(mainOf(s.repo)).toBe(s.B);
  });

  it('a timeout is transient: retried once, then the row ends transient with main unchanged', async () => {
    const s = setup({ commands: ['sleep 5'] });
    s.deps.timing = { ...s.deps.timing, commandTimeoutMs: 300 };
    s.queue('task-1');
    const r = await runIntegrator(s.deps);
    expect(r.settled.map((x) => x.phase)).toEqual(['transient']);
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'transient', attempt: 2 });
    expect(rowOf(s.db, 'task-1').detail).toMatch(/`sleep 5` timed out/);
    expect(s.db.events('task-1', 'integration-requeued').map((e) => (e.data as { outcome: string }).outcome)).toEqual(['transient']);
    expect(mainOf(s.repo)).toBe(s.B);
  });

  it('runs setupCommands only when the lockfile changes, and a setup failure is transient', async () => {
    const s = setup({ setupCommands: ['mkdir -p node_modules && echo x >> node_modules/setup-count'], commands: ['test -d node_modules'] });
    s.queue('task-1');
    s.queue('task-2');
    s.queue('task-3', { 'package-lock.json': '{"lockfileVersion": 3}\n' });
    const r = await runIntegrator(s.deps);
    expect(r.settled.map((x) => `${x.taskId} ${x.phase}`)).toEqual(['task-1 landed', 'task-2 landed', 'task-3 landed']);
    expect(readFileSync(join(s.deps.integrationDir, 'node_modules', 'setup-count'), 'utf8')).toBe('x\nx\n');
    s.cfg.verification.setupCommands = ['exit 1'];
    s.queue('task-4');
    await runIntegrator(s.deps);
    expect(rowOf(s.db, 'task-4')).toMatchObject({ phase: 'transient', attempt: 2 });
    expect(rowOf(s.db, 'task-4').detail).toMatch(/setup command `exit 1` failed/);
  });

  it('a recreated integration worktree runs setupCommands again (the setup marker belongs to the worktree)', async () => {
    const counter = join(tmp('minions-integrator-count-'), 'count');
    const s = setup({ setupCommands: [`mkdir -p node_modules && touch node_modules/installed && echo x >> ${counter}`], commands: ['test -f node_modules/installed'] });
    s.queue('task-1');
    await runIntegrator(s.deps);
    expect(rowOf(s.db, 'task-1').phase).toBe('landed');
    rmSync(s.deps.integrationDir, { recursive: true, force: true });
    s.queue('task-2');
    await runIntegrator(s.deps);
    expect(rowOf(s.db, 'task-2').phase).toBe('landed');
    expect(readFileSync(counter, 'utf8')).toBe('x\nx\n');
  });

  it('sensitive paths wait for a signed approval; with one they land', async () => {
    const s = setup();
    const H = s.queue('task-1', { '.minions/config.json': '{}\n' });
    await runIntegrator(s.deps);
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'awaiting-approval' });
    expect(rowOf(s.db, 'task-1').detail).toContain('.minions/config.json');
    expect(mainOf(s.repo)).toBe(s.B);
    // After the approval the same head is queued again (`work publish` in phase 3): a new row.
    enqueueIntegration(s.db, { taskId: 'task-1', branch: branchOf('task-1'), head: H });
    s.deps.approved = () => true;
    await runIntegrator(s.deps);
    expect(rowOf(s.db, 'task-1').phase).toBe('landed');
  });

  it('a dependency that is not integrated yet makes the task wait; order is otherwise oldest first', async () => {
    const s = setup();
    s.queue('task-2');
    s.queue('task-1');
    s.deps.unmetDependencies = (t) => (t === 'task-2' ? ['task-1'] : []);
    const r = await runIntegrator(s.deps);
    expect(r.settled.map((x) => x.taskId)).toEqual(['task-1', 'task-2']);
  });

  it('a dirty checkout of main re-queues without an attempt and stops the queue', async () => {
    const s = setup();
    s.queue('task-1');
    writeFileSync(join(s.repo, 'base.txt'), 'local edit\n');
    const r = await runIntegrator(s.deps);
    expect(r.exit).toBe('checkout-dirty');
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'queued', attempt: 0, outcome: 'checkout-dirty' });
    expect(mainOf(s.repo)).toBe(s.B);
    expect(readFileSync(join(s.repo, 'base.txt'), 'utf8')).toBe('local edit\n');
  });
});

describe('runIntegrator: lock, pause, drain and halt', () => {
  it('a live holder keeps the lock: the second integrator exits with conflict and touches nothing', async () => {
    const s = setup();
    s.queue('task-1');
    const foreign = { pid: 999_999, start: '1', bootId: null, at: '2026-10-29T00:00:00.000Z' };
    s.db.setMeta(INTEGRATION_LOCK_META, JSON.stringify(foreign));
    const r = await runIntegrator({ ...s.deps, lockAlive: () => true });
    expect(r.exit).toBe('conflict');
    expect(r.holder).toEqual(foreign);
    expect(integrationLock(s.db)).toEqual(foreign);
    expect(rowOf(s.db, 'task-1').phase).toBe('queued');
    // A stale holder is replaced.
    const r2 = await runIntegrator({ ...s.deps, lockAlive: () => false });
    expect(r2.exit).toBe('empty');
    expect(rowOf(s.db, 'task-1').phase).toBe('landed');
  });

  it('integratorAlive: pid, start time, boot and the `work integrate` command line', () => {
    const l = { pid: 42, start: '100', bootId: 'boot-a', at: 'x' };
    const view = (o: Partial<{ alive: boolean; start: string; cmd: string | null; boot: string }> = {}) => ({
      alive: () => o.alive ?? true, startTime: () => o.start ?? '100', cmdline: () => (o.cmd === undefined ? 'node /usr/bin/minions work integrate' : o.cmd), bootId: () => o.boot ?? 'boot-a',
    });
    expect(integratorAlive(l, view())).toBe(true);
    expect(integratorAlive(l, view({ alive: false }))).toBe(false);
    expect(integratorAlive(l, view({ start: '101' }))).toBe(false);
    expect(integratorAlive(l, view({ boot: 'boot-b' }))).toBe(false);
    expect(integratorAlive(l, view({ cmd: 'node /usr/bin/minions coordinator supervise' }))).toBe(false);
  });

  it('starts nothing while starts are paused or a drain is active', async () => {
    const s = setup();
    s.queue('task-1');
    s.db.setPaused({ starts: true });
    expect((await runIntegrator(s.deps)).exit).toBe('paused');
    s.db.setPaused({ starts: false });
    s.db.setDrain('upgrade');
    expect((await runIntegrator(s.deps)).exit).toBe('draining');
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'queued', attempt: 0 });
  });

  it('a drain stops a running verification at once (group killed) and re-queues it without an attempt', async () => {
    const s = setup({ commands: ['sleep 30 & sleep 30; wait'] });
    s.queue('task-1');
    const started = Date.now();
    const run = runIntegrator(s.deps);
    await waitFor(() => !!rowOf(s.db, 'task-1').verify_pid);
    const { verify_pid: pid, verify_start: start } = rowOf(s.db, 'task-1');
    s.db.setDrain('upgrade');
    const r = await run;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.exit).toBe('draining');
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'queued', attempt: 0, outcome: 'stopped', verify_pid: null, candidate_sha: null });
    expect(await isAlive({ pid: pid!, startTime: start! })).toBe(false);
    expect(mainOf(s.repo)).toBe(s.B);
    expect(integrationLock(s.db)).toBeNull();
  });

  const stopCases = [
    { phase: 'merge', commands: ['true'], setupCommands: [] as string[] },
    { phase: 'setup', commands: ['true'], setupCommands: ['sleep 30 & sleep 30; wait'] },
    { phase: 'verification', commands: ['sleep 30 & sleep 30; wait'], setupCommands: [] as string[] },
  ];
  for (const c of stopCases) {
    it(`a stop signal (SIGTERM) during the ${c.phase} re-queues without an attempt and leaves main untouched`, async () => {
      const s = setup({ commands: c.commands, setupCommands: c.setupCommands });
      s.queue('task-1');
      const ac = new AbortController();
      s.deps.signal = ac.signal;
      // The merge step: abort right after the loop picked the row, so the candidate's git runs see an aborted signal.
      if (c.phase === 'merge') s.deps.unmetDependencies = () => { ac.abort(); return []; };
      const run = runIntegrator(s.deps);
      if (c.phase !== 'merge') {
        await waitFor(() => !!rowOf(s.db, 'task-1').verify_pid);
        ac.abort();
      }
      const r = await run;
      expect(r.exit).toBe('stopped');
      expect(r.settled).toEqual([]);
      expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'queued', attempt: 0, outcome: 'stopped', verify_pid: null, candidate_sha: null });
      expect(s.db.events('task-1', 'integration-requeued').map((e) => e.data)).toEqual([expect.objectContaining({ outcome: 'stopped', counted: false })]);
      expect(mainOf(s.repo)).toBe(s.B);
      expect(integrationLock(s.db)).toBeNull();
    });
  }

  it('adopts a fast-forward of main made outside the integrator', async () => {
    const s = setup();
    s.queue('task-1');
    await runIntegrator(s.deps);
    const C1 = mainOf(s.repo);
    expect(s.db.getMeta(INTEGRATION_BASE_META)).toBe(C1);
    const outside = commit(s.repo, 'outside.txt', 'by hand\n', 'a commit on main outside the integrator');
    s.queue('task-2');
    const r = await runIntegrator(s.deps);
    expect(r.exit).toBe('empty');
    expect(integrationHalt(s.db)).toBeNull();
    expect(s.db.eventsOfKindSince('integration-base-adopted', '').map((e) => e.data)).toContainEqual({ from: C1, to: outside });
    expect(rowOf(s.db, 'task-2')).toMatchObject({ phase: 'landed', base_sha: outside });
    const C2 = mainOf(s.repo);
    expect(gitSync(s.repo, 'rev-list', '--parents', '-n', '1', C2).split(' ')[1]).toBe(outside);
    expect(s.db.getMeta(INTEGRATION_BASE_META)).toBe(C2);
  });

  it('halts when main no longer descends from the integration base, until --adopt-base', async () => {
    const s = setup();
    s.queue('task-1');
    const other = branchWith(s.repo, 'elsewhere', s.init, { 'e.txt': 'e\n' });
    s.db.setMeta(INTEGRATION_BASE_META, other);
    const r = await runIntegrator(s.deps);
    expect(r.exit).toBe('halted');
    expect(integrationHalt(s.db)?.reason).toMatch(/does not descend from the last integrated base/);
    expect(rowOf(s.db, 'task-1').phase).toBe('queued');
    expect((await runIntegrator(s.deps)).exit).toBe('halted');
    await adoptIntegrationBase(s.db, s.repo, 'main');
    expect(integrationHalt(s.db)).toBeNull();
    expect((await runIntegrator(s.deps)).exit).toBe('empty');
    expect(rowOf(s.db, 'task-1').phase).toBe('landed');
  });
});

describe('runIntegrator: crash recovery', () => {
  const staleLock = (db: RuntimeDb) => db.setMeta(INTEGRATION_LOCK_META, JSON.stringify({ pid: 999_999, start: '1', bootId: null, at: '2026-10-29T00:00:00.000Z' }));

  it('main already contains C (crash after the swap): the row is landed and integration_base = C', async () => {
    const s = setup();
    const H = s.queue('task-1');
    const c = await integrationCandidate(s.repo, { base: s.B, head: H, branch: branchOf('task-1'), taskId: 'task-1', identity: s.cfg.git.identity });
    if (c.state !== 'clean') throw new Error(JSON.stringify(c));
    gitSync(s.repo, 'merge', '-q', '--ff-only', c.candidate);
    s.db.exec("UPDATE integrations SET phase = 'landing', attempt = 1, base_sha = ?, candidate_sha = ? WHERE task_id = 'task-1'", s.B, c.candidate);
    staleLock(s.db);
    const r = await runIntegrator({ ...s.deps, lockAlive: () => false });
    expect(r.recovered).toEqual([{ id: 1, taskId: 'task-1', outcome: 'landed', killed: [] }]);
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'landed', candidate_sha: c.candidate });
    expect(s.db.getMeta(INTEGRATION_BASE_META)).toBe(c.candidate);
    expect(mainOf(s.repo)).toBe(c.candidate);
    // The crash may have come before the landing notice: recovery queues it (keyed by C).
    expect(pending(s.db, { includeWaiting: true }).filter((n) => n.key.startsWith('integrated:')).map((n) => [n.key, n.text]))
      .toEqual([[`integrated:task-1:${c.candidate}`, `task-1 merged into main at ${c.candidate}; 1 changed path: task-1.txt. ref: #task-1`]]);
    expect(r.exit).toBe('empty');
  });

  it('otherwise the recorded verify group is stopped (leader matched) and the row is re-queued and integrated', async () => {
    const s = setup();
    s.queue('task-1');
    const child = spawn('sh', ['-c', 'sleep 60 & sleep 60; wait'], { detached: true, stdio: 'ignore' });
    child.unref();
    await waitFor(() => !!child.pid);
    const id = (await procIdentity(child.pid!))!;
    s.db.exec("UPDATE integrations SET phase = 'verifying', attempt = 1, base_sha = ?, candidate_sha = ?, verify_pid = ?, verify_start = ? WHERE task_id = 'task-1'",
      s.B, 'f'.repeat(40), id.pid, id.startTime);
    staleLock(s.db);
    const r = await runIntegrator({ ...s.deps, lockAlive: () => false });
    expect(r.recovered).toHaveLength(1);
    expect(r.recovered[0]).toMatchObject({ outcome: 'requeued' });
    expect(r.recovered[0]!.killed).toContain(id.pid);
    expect(await isAlive(id)).toBe(false);
    expect(s.db.events('task-1', 'integration-requeued').map((e) => (e.data as { outcome: string; counted: boolean }))).toEqual([expect.objectContaining({ outcome: 'recovered', counted: false })]);
    expect(rowOf(s.db, 'task-1')).toMatchObject({ phase: 'landed', attempt: 1 });
  });

  it('a recorded pid whose start time does not match is never signalled', async () => {
    const s = setup();
    s.queue('task-1');
    s.db.exec("UPDATE integrations SET phase = 'verifying', attempt = 1, base_sha = ?, verify_pid = ?, verify_start = '1' WHERE task_id = 'task-1'", s.B, process.pid);
    staleLock(s.db);
    const r = await runIntegrator({ ...s.deps, lockAlive: () => false });
    expect(r.recovered[0]).toMatchObject({ outcome: 'requeued', killed: [] });
    expect(rowOf(s.db, 'task-1').phase).toBe('landed');
  });
});

describe('queue and helpers', () => {
  it('enqueue is idempotent for the same head and refuses a new head while one runs', () => {
    const s = setup();
    const a = 'a'.repeat(40), b = 'b'.repeat(40);
    const r1 = enqueueIntegration(s.db, { taskId: 'task-9', branch: 'agent/task-9', head: a });
    expect(enqueueIntegration(s.db, { taskId: 'task-9', branch: 'agent/task-9', head: a }).id).toBe(r1.id);
    expect(enqueueIntegration(s.db, { taskId: 'task-9', branch: 'agent/task-9', head: b })).toMatchObject({ id: r1.id, head_sha: b });
    s.db.exec("UPDATE integrations SET phase = 'verifying' WHERE id = ?", r1.id);
    expect(() => enqueueIntegration(s.db, { taskId: 'task-9', branch: 'agent/task-9', head: a })).toThrow(/is verifying/);
    expect(() => enqueueIntegration(s.db, { taskId: 'task-9', branch: 'agent/task-9', head: 'abc' })).toThrow(/full SHA/);
  });

  it('porcelainPaths keeps both whole paths of a staged rename', () => {
    expect(porcelainPaths('R  new name.txt\0old name.txt\0 M other.txt\0')).toEqual(['new name.txt', 'old name.txt', 'other.txt']);
  });
});

describe('schema 12: integrations (after 57.12 schema 11)', () => {
  it('a schema-11 database (the 57.12 router schema) migrates to 12: integrations is added, the 11 data is kept', () => {
    expect(SCHEMA_VERSION).toBe(12);
    const file = join(tmp('minions-integrator-db-'), 'v11.db');
    const v11 = new RuntimeDb(file);
    v11.sql.exec('DROP TABLE integrations;');
    v11.sql.exec("INSERT INTO tg_messages (message_id, ref, outbox_key, text_head, session, sent_at) VALUES (7, '#1', 'k', 'hi', 'general', 'now')");
    v11.setMeta('schema_version', '11');
    v11.close();
    const up = new RuntimeDb(file);
    try {
      expect(up.getMeta('schema_version')).toBe('12');
      expect(up.all('SELECT message_id, session FROM tg_messages')).toEqual([{ message_id: 7, session: 'general' }]);
      enqueueIntegration(up, { taskId: 'task-1', branch: 'agent/task-1', head: 'a'.repeat(40) });
      expect(() => up.exec("INSERT INTO integrations (task_id, branch, head_sha, phase, queued_at) VALUES ('task-1', 'b', 'c', 'verifying', 'now')")).toThrow(/UNIQUE/);
      up.exec("INSERT INTO integrations (task_id, branch, head_sha, phase, queued_at) VALUES ('task-1', 'b', 'c', 'landed', 'now')");
    } finally { up.close(); }
  });

  it('a schema-10 database applies 11 and 12 in order', () => {
    const file = join(tmp('minions-integrator-db-'), 'v10.db');
    const v10 = new RuntimeDb(file);
    v10.sql.exec('DROP TABLE integrations; DROP TABLE tg_messages; ALTER TABLE outbox DROP COLUMN session; ALTER TABLE outbox DROP COLUMN answered_at;');
    v10.setMeta('schema_version', '10');
    v10.close();
    const up = new RuntimeDb(file);
    try {
      expect(up.getMeta('schema_version')).toBe('12');
      const cols = up.all<{ name: string }>('PRAGMA table_info(outbox)').map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['session', 'answered_at']));
      expect(up.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tg_messages', 'integrations') ORDER BY name")).toEqual([{ name: 'integrations' }, { name: 'tg_messages' }]);
    } finally { up.close(); }
  });
});
