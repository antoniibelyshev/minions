import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import { buildClaudeCommand, buildCoordinatorCommand, coordinatorSettings } from '../../src/runtime/coordinator.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { validateResult } from '../../src/runtime/results.js';
import { taskSlug } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { result, tmp } from './fixtures.js';

const SHA = 'a'.repeat(40);

describe('runtime db', () => {
  it('migrates, uses WAL, and reopens idempotently', () => {
    const path = join(tmp(), 'state', 'minions.db');
    const db = new RuntimeDb(path);
    expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode).toBe('wal');
    db.setPaused({ intake: true });
    db.close();
    const again = new RuntimeDb(path);
    expect(again.paused()).toEqual({ intake: true, starts: false });
    again.setMeta('schema_version', '99');
    again.close();
    expect(() => new RuntimeDb(path)).toThrow(/newer/);
  });

  it('idempotency store maps keys to task ids', () => {
    const db = new RuntimeDb(':memory:');
    expect(db.idempotency.get('k')).toBeUndefined();
    db.idempotency.put('k', 'task-1');
    db.idempotency.put('k', 'task-1');
    expect(db.idempotency.get('k')).toBe('task-1');
    expect(() => db.idempotency.put('k', 'task-2')).toThrow(/already maps/);
  });

  it('coordinator lock conflicts with a live holder and replaces a dead one', () => {
    const db = new RuntimeDb(':memory:');
    db.acquireCoordinatorLock('s1', process.ppid); // another live process
    let err: MinionsError | undefined;
    try { db.acquireCoordinatorLock('s2'); } catch (e) { err = e as MinionsError; }
    expect(err?.code).toBe('CONFLICT');
    db.acquireCoordinatorLock('s1', process.ppid); // re-entrant
    db.setMeta('coordinator_lock', JSON.stringify({ pid: 2 ** 22 + 12345, session: 'dead', acquiredAt: 'x' }));
    expect(db.acquireCoordinatorLock('s2').session).toBe('s2');
    expect(db.releaseCoordinatorLock('s2')).toBe(true);
    expect(db.coordinatorLock()).toBeUndefined();
  });

  it('honours MINIONS_STATE_DIR / MINIONS_WORKSPACE / MINIONS_CONFIG', () => {
    const p = runtimePaths({ MINIONS_STATE_DIR: '/s', MINIONS_WORKSPACE: '/w', MINIONS_CONFIG: '/c.json' });
    expect(p).toMatchObject({ db: '/s/minions.db', hooksLog: '/s/logs/hooks.log', repo: '/w/repo', configJson: '/c.json' });
    expect(runtimePaths({}).db).toBe('/state/minions.db');
  });
});

describe('worker results', () => {
  it('accepts a valid result and rejects malformed ones with paths', () => {
    expect(validateResult(result({ branch: 'agent/x', headSha: SHA })).ok).toBe(true);
    const bad = validateResult({ ...result({ branch: 'agent/x', headSha: 'abc' }), extra: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join('\n')).toMatch(/headSha[\s\S]*extra/);
    expect(validateResult('nope').ok).toBe(false);
  });
  it('enforces reviewer verdict rules', () => {
    expect(validateResult(result({ branch: 'b', headSha: SHA, verdict: 'approve' }), 'engineer').ok).toBe(false);
    expect(validateResult(result({ branch: 'b', headSha: SHA }), 'reviewer').ok).toBe(false);
    expect(validateResult(result({ branch: 'b', headSha: SHA, verdict: 'approve' }), 'reviewer').ok).toBe(true);
    expect(validateResult(result({ branch: 'b', headSha: SHA, status: 'needs_changes', verdict: 'approve' }), 'reviewer').ok).toBe(false);
  });
  it('slugs are sanitized and bounded', () => {
    expect(taskSlug('TASK-12', 'Fix: the  "login" bug!!')).toBe('task-12-fix-the-login-bug');
    const long = taskSlug('task-1', 'a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('coordinator command', () => {
  it('builds tmux (exec wrapper) + claude argv without a shell or bypass mode', async () => {
    const root = tmp();
    mkdirSync(join(root, 'plugin'), { recursive: true });
    const prompt = 'You are the coordinator.\nUse $(minions status) literally; no shell.';
    writeFileSync(join(root, 'plugin', 'coordinator.md'), prompt);
    const paths = { ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws') }), pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md') };
    const cfg = defaults();
    const c = await buildCoordinatorCommand(cfg, paths);
    expect(c.cmd).toBe('tmux');
    expect(c.args).toEqual(['-u', 'new-session', '-A', '-s', 'coordinator', '-c', join(root, 'ws', 'repo'), '--', 'minions', 'coordinator', 'run']);
    expect((await buildCoordinatorCommand(cfg, paths, { detached: true })).args.slice(0, 3)).toEqual(['-u', 'new-session', '-d']);
    const cc = await buildClaudeCommand(cfg, paths);
    expect(cc.cmd).toBe('claude');
    const claude = cc.args;
    expect(claude).not.toContain('--channels');
    expect(claude[claude.indexOf('--plugin-dir') + 1]).toBe(join(root, 'plugin'));
    expect(claude[claude.indexOf('--append-system-prompt') + 1]).toBe(prompt);
    expect(claude[claude.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    const settings = JSON.parse(claude[claude.indexOf('--settings') + 1]!);
    expect(settings.permissions.allow).toEqual(expect.arrayContaining(['Bash(minions *)', 'Bash(git *)', 'Bash(backlog *)']));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Bash(git push *)', 'Bash(git * push *)']));
    expect(JSON.stringify([c.args, cc.args])).not.toMatch(/bypassPermissions/);
    expect(coordinatorSettings(cfg).permissions).toMatchObject({ disableBypassPermissionsMode: 'disable' });
  });
  it('reports a missing coordinator prompt', async () => {
    const paths = { ...runtimePaths({}), coordinatorPrompt: join(tmp(), 'missing.md') };
    await expect(buildCoordinatorCommand(defaults(), paths)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
