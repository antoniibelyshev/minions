// Routine coordinator context resets (task-45): the capped, redacted handoff file, the restart triggers
// (after delivery when idle, context threshold, hand-off count) that never fire with active leases, the
// detached self-restart, and that the Telegram pairing, inbound queue and the outbox survive a restart.
// Temp state dirs and SQLite DBs only; tmux, claude and the restart child are fakes.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/resolve.js';
import { collectStatus, humanStatus, withContextReset } from '../../src/runtime/commands.js';
import {
  contextResetCheck, contextResetSettings, contextTokensFromTranscript, DEFAULT_CONTEXT_TOKENS, DEFAULT_HANDOFFS, HANDOFF_MAX_BYTES,
  noteTranscript, readHandoff, redactHandoff, RESET_RESTART_COMMAND, TRANSCRIPT_META, writeHandoff,
} from '../../src/runtime/context-reset.js';
import { RECOVERY_PROMPT, restartCoordinator, scheduleDetachedRestart, type DetachedSpawn } from '../../src/runtime/coordinator.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { sweepScratchOnStart } from '../../src/runtime/handoff.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { enqueue, pending } from '../../src/runtime/outbox.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';
import { commitFile, makeDefaultEnv, result, tmp, type Env } from './fixtures.js';

const withReset = (c: NonNullable<NonNullable<MinionsConfig['coordinator']>['contextReset']> | undefined): MinionsConfig => {
  const cfg = defaults();
  cfg.coordinator = c ? { contextReset: c } : {};
  return cfg;
};

function freshDb(): RuntimeDb {
  return new RuntimeDb(join(tmp('minions-reset-'), 'state', 'minions.db'));
}

/** A live coordinator session: the lock is what scopes "this session". */
function session(db: RuntimeDb, pid = 4242): void {
  db.acquireCoordinatorLock('coordinator', pid, () => false);
}

function addLease(db: RuntimeDb, id: string, taskId: string, status = 'active'): void {
  db.exec("INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES (?, ?, 'engineer', 1, 1, ?, ?)", id, taskId, new Date().toISOString(), status);
}

const handoffs = (db: RuntimeDb, n: number) => { for (let i = 0; i < n; i++) db.addEvent('record', `task-${i}`, { leaseId: `lease-h${i}`, status: 'completed', to: 'reviewing' }); };

function transcript(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
const usageLine = (input: number, cacheRead: number, cacheCreate = 0, output = 0, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', ...extra, message: { role: 'assistant', usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: output } } });

describe('handoff file (capped, redacted, replaced on write)', () => {
  it('stores the note under /state, replaces it on the next write, and a fresh reader gets it back', async () => {
    const db = freshDb();
    session(db);
    const path = join(tmp('minions-handoff-'), 'state', 'coordinator-handoff.json');
    expect(readHandoff(path)).toEqual({ present: false, path });

    const first = await writeHandoff({ db, path, now: new Date('2026-10-23T10:00:00Z') }, '## Open owner questions\n1. Ship dark mode first? (recommended: yes)\n');
    expect(first).toMatchObject({ path, bytes: Buffer.byteLength('## Open owner questions\n1. Ship dark mode first? (recommended: yes)'), maxBytes: 4096, redactions: 0, replaced: false });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const second = await writeHandoff({ db, path, now: new Date('2026-10-23T11:00:00Z') }, '## Waiting on\n- owner approval for task-7\n');
    expect(second.replaced).toBe(true);
    // A fresh coordinator (new process, new DB connection) reads only the latest note.
    const read = readHandoff(path, new Date('2026-10-23T11:30:00Z'));
    expect(read).toEqual({ present: true, path, writtenAt: '2026-10-23T11:00:00.000Z', ageMinutes: 30, bytes: second.bytes, text: '## Waiting on\n- owner approval for task-7' });
    expect(readFileSync(path, 'utf8')).not.toContain('dark mode');
    // The DB keeps only the fact of the write, never the text.
    const ev = db.all<{ data_json: string }>("SELECT data_json FROM events WHERE kind = 'coordinator-handoff'");
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.data_json).join('')).not.toContain('owner approval');
  });

  it('refuses a note over 4 KB (after redaction) and keeps the previous one; refuses an empty note', async () => {
    const db = freshDb();
    const path = join(tmp('minions-handoff-'), 'coordinator-handoff.json');
    await writeHandoff({ db, path }, 'keep me');
    await expect(writeHandoff({ db, path }, 'x'.repeat(HANDOFF_MAX_BYTES + 1))).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/4097 bytes; the cap is 4096\. The previous handoff is kept/) });
    // Multi-byte text counts in bytes, not characters.
    await expect(writeHandoff({ db, path }, 'é'.repeat(2049))).rejects.toMatchObject({ code: 'PRECONDITION' });
    expect((readHandoff(path) as { text: string }).text).toBe('keep me');
    expect((await writeHandoff({ db, path }, 'y'.repeat(HANDOFF_MAX_BYTES))).bytes).toBe(4096); // exactly at the cap
    await expect(writeHandoff({ db, path }, ' \n\t ')).rejects.toMatchObject({ code: 'PRECONDITION', message: 'The handoff is empty.' });
  });

  it('redacts credentials before storing (CLI-wide patterns plus key=value secrets, private keys, URL passwords)', async () => {
    const db = freshDb();
    const path = join(tmp('minions-handoff-'), 'coordinator-handoff.json');
    const secrets = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_11ABCDEFG0123456789_abcdefghijk',
      '123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll', 'AKIAABCDEFGHIJKLMNOP', 'hunter2hunter2', 's3cr3t-value-xyz', 'pa55word99',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    ];
    const note = [
      '## Chat context',
      `Owner pasted key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123 / github_pat_11ABCDEFG0123456789_abcdefghijk`,
      'bot 123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll, aws AKIAABCDEFGHIJKLMNOP',
      'password: hunter2hunter2', 'API_KEY=s3cr3t-value-xyz', 'clone https://bob:pa55word99@example.com/r.git',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
      '## Spend', 'total 1.2M tokens; token budget 5M', // ordinary words stay
    ].join('\n');
    const r = await writeHandoff({ db, path }, note);
    const stored = readFileSync(path, 'utf8');
    for (const s of secrets) expect(stored, s).not.toContain(s);
    expect(r.redactions).toBeGreaterThanOrEqual(8);
    expect(stored).toContain('total 1.2M tokens; token budget 5M');
    expect(stored).toContain('https://bob:[REDACTED]@example.com');
    expect(redactHandoff('nothing secret here').redactions).toBe(0);
  });
});

describe('settings (config defaults keep existing configs valid)', () => {
  it('an existing config without contextReset validates and means off; new projects default to on', () => {
    const { coordinator: _c, ...legacy } = defaults();
    expect(validateConfig(legacy, 'x').coordinator).toBeUndefined();
    expect(contextResetSettings(legacy)).toEqual({ enabled: false, afterDelivery: true, contextTokens: DEFAULT_CONTEXT_TOKENS, handoffs: DEFAULT_HANDOFFS });
    expect(validateConfig({ ...legacy, coordinator: { permissionMode: 'acceptEdits' } }, 'x').coordinator).toEqual({ permissionMode: 'acceptEdits' });
    expect(defaults().coordinator?.contextReset).toEqual({ enabled: true });
    expect(contextResetSettings(defaults())).toEqual({ enabled: true, afterDelivery: true, contextTokens: 60_000, handoffs: 10 });
    for (const p of ['personal-work', 'supervised'] as const) expect(contextResetSettings(defaults(p)).enabled).toBe(true);
  });

  it('triggers are configurable: null turns one off; invalid values are rejected', () => {
    const cfg = withReset({ enabled: true, afterDelivery: false, contextTokens: null, handoffs: 3 });
    expect(validateConfig(cfg, 'x').coordinator?.contextReset).toEqual({ enabled: true, afterDelivery: false, contextTokens: null, handoffs: 3 });
    expect(contextResetSettings(cfg)).toEqual({ enabled: true, afterDelivery: false, contextTokens: null, handoffs: 3 });
    expect(() => validateConfig(withReset({ enabled: true, handoffs: 0 }), 'x')).toThrow(/handoffs/);
    expect(() => validateConfig(withReset({ enabled: true, contextTokens: 10 }), 'x')).toThrow(/contextTokens/);
    expect(() => validateConfig({ ...defaults(), coordinator: { contextReset: { enabled: true, every: 5 } } }, 'x')).toThrow(/INVALID|Unrecognized|every/i);
  });
});

describe('restart triggers', () => {
  it('after a delivery when idle: due once the last lease ended, never while a lease is active', () => {
    const db = freshDb();
    session(db);
    addLease(db, 'lease-a', 'task-2');
    db.addEvent('record', 'task-1', { leaseId: 'lease-r1', status: 'completed', to: 'delivered' });
    let c = contextResetCheck({ db, config: defaults() });
    expect(c).toMatchObject({ enabled: true, due: false, triggers: ['delivered'], blockers: ['1 active worker lease(s) (lease-a)'] });
    expect(c.steps).toBeUndefined();
    db.exec("UPDATE leases SET status = 'completed' WHERE id = 'lease-a'");
    c = contextResetCheck({ db, config: defaults() });
    expect(c).toMatchObject({ due: true, triggers: ['delivered'], blockers: [], reason: 'context reset due: delivered task-1' });
    expect(c.session.delivered).toEqual(['task-1']);
    expect(c.steps!.join('\n')).toContain('minions coordinator handoff --json');
    expect(c.steps!.at(-1)).toContain(RESET_RESTART_COMMAND);
    // afterDelivery: false ignores deliveries.
    expect(contextResetCheck({ db, config: withReset({ enabled: true, afterDelivery: false }) }).due).toBe(false);
  });

  it('hand-off count: records and releases of this session only; the fresh session starts from zero', () => {
    const db = freshDb();
    handoffs(db, 12); // a previous session's hand-offs
    session(db);
    const cfg = withReset({ enabled: true, handoffs: 3, afterDelivery: false });
    expect(contextResetCheck({ db, config: cfg })).toMatchObject({ due: false, triggers: [], session: { handoffs: 0 } });
    handoffs(db, 2);
    db.addEvent('release', 'task-9', { leaseId: 'lease-x', status: 'released', reason: 'r' });
    const c = contextResetCheck({ db, config: cfg });
    expect(c).toMatchObject({ due: true, triggers: ['handoffs'], reason: 'context reset due: 3 hand-offs >= 3', session: { handoffs: 3 } });
    // An active lease blocks it, whatever the count.
    addLease(db, 'lease-b', 'task-3');
    expect(contextResetCheck({ db, config: cfg })).toMatchObject({ due: false, triggers: ['handoffs'] });
  });

  it('context threshold: latest main-session usage from the transcript the Stop hook recorded this session', () => {
    const db = freshDb();
    session(db);
    const dir = tmp('minions-transcript-');
    const file = join(dir, 'sess-1.jsonl');
    writeFileSync(file, transcript([
      { type: 'user', message: { role: 'user', content: 'hi' } },
      usageLine(10, 30_000, 2_000, 500),
      usageLine(5, 900_000, 0, 0, { isSidechain: true }), // a subagent's usage never counts
      { type: 'user', message: { role: 'user', content: 'next' } },
      usageLine(3, 59_000, 1_500, 700),
      'not json',
    ]));
    const cfg = withReset({ enabled: true, afterDelivery: false, handoffs: null });
    // Without the Stop hook's record: unknown, not due.
    expect(contextResetCheck({ db, config: cfg })).toMatchObject({ due: false, session: { contextTokens: null, contextSource: 'unavailable' } });
    noteTranscript(db, { transcript_path: file, session_id: 'sess-1' });
    const c = contextResetCheck({ db, config: cfg });
    expect(c).toMatchObject({ due: true, triggers: ['context'], session: { contextTokens: 61_203, contextSource: 'transcript' } });
    expect(c.reason).toBe('context reset due: context 61203 >= 60000 tokens');
    expect(contextResetCheck({ db, config: withReset({ enabled: true, contextTokens: 70_000, handoffs: null }) }).due).toBe(false);
    // A transcript recorded before this session's lock (the previous session) is ignored.
    db.setMeta(TRANSCRIPT_META, JSON.stringify({ path: file, at: '2000-01-01T00:00:00.000Z' }));
    expect(contextResetCheck({ db, config: cfg }).session.contextTokens).toBeNull();
  });

  it('the Stop hook records the transcript path without adding an event (the stop guard fingerprint is unchanged)', async () => {
    const env = makeDefaultEnv();
    session(env.db);
    const before = env.db.lastEventId();
    await stopHook({ transcript_path: '/home/node/.claude/projects/-workspace-repo/abc.jsonl', session_id: 'abc' }, () => ({ db: env.db, backlog: env.backlog, config: env.config }));
    expect(JSON.parse(env.db.getMeta(TRANSCRIPT_META)!)).toMatchObject({ path: '/home/node/.claude/projects/-workspace-repo/abc.jsonl', sessionId: 'abc' });
    expect(env.db.lastEventId()).toBe(before);
    noteTranscript(env.db, { transcript_path: '/etc/passwd' }); // not a transcript: ignored
    expect(JSON.parse(env.db.getMeta(TRANSCRIPT_META)!).path).toMatch(/abc\.jsonl$/);
  });

  it('transcript usage parsing tolerates missing or malformed lines', () => {
    expect(contextTokensFromTranscript(null)).toBeNull();
    expect(contextTokensFromTranscript('')).toBeNull();
    expect(contextTokensFromTranscript('garbage\n{"type":"assistant"}\n')).toBeNull();
    expect(contextTokensFromTranscript(transcript([usageLine(1, 2, 3, 4)]))).toBe(10);
  });

  it('never fires when disabled, during a drain, or without a coordinator session', () => {
    const db = freshDb();
    db.addEvent('record', 'task-1', { leaseId: 'lease-r1', status: 'completed', to: 'delivered' });
    expect(contextResetCheck({ db, config: defaults() })).toMatchObject({ due: false, blockers: ['no coordinator session holds the project lock'] });
    session(db);
    db.addEvent('record', 'task-1', { leaseId: 'lease-r2', status: 'completed', to: 'done' });
    const { coordinator: _c, ...legacy } = defaults();
    expect(contextResetCheck({ db, config: legacy as MinionsConfig })).toMatchObject({ enabled: false, due: false, triggers: ['delivered'] });
    db.setDrain('upgrade');
    expect(contextResetCheck({ db, config: defaults() }).blockers).toEqual(['a drain is in progress (the upgrade restarts the coordinator itself)']);
  });

  it('end to end: the reviewer approval that delivers the last active task carries contextReset; earlier records do not', async () => {
    const env: Env = makeDefaultEnv();
    session(env.db);
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const e1 = await env.sched.claim('task-1', 'engineer');
    const e2 = await env.sched.claim('task-2', 'engineer');
    const h1 = commitFile(e1.worktree, 'a.txt', 'one');
    const r1 = withContextReset(await env.sched.record(e1.leaseId, result({ branch: e1.branch, headSha: h1 })), env);
    expect(r1.to).toBe('reviewing');
    expect(r1.contextReset).toBeUndefined();
    const rev = await env.sched.claim('task-1', 'reviewer');
    const rr = withContextReset(await env.sched.record(rev.leaseId, result({ branch: rev.branch, headSha: h1, verdict: 'approve' })), env);
    expect(rr.to).toBe('delivered');
    expect(rr.contextReset).toBeUndefined(); // task-2's engineer is still running
    const h2 = commitFile(e2.worktree, 'b.txt', 'two');
    const r2 = withContextReset(await env.sched.release(e2.leaseId, 'owner cancelled'), env);
    expect(h2).toBeTruthy();
    expect(r2.contextReset).toEqual({ due: true, reason: 'context reset due: delivered task-1', steps: expect.any(Array) });
    const status = await collectStatus({ db: env.db, config: env.config, backlog: async () => env.backlog });
    expect(status.contextReset).toMatchObject({ enabled: true, due: true, triggers: ['delivered'] });
    expect(humanStatus(status)).toMatch(/context reset: due \(3\/10 hand-offs, context unknown, delivered task-1\)/);
  });
});

describe('self-restart (coordinator restart --detach)', () => {
  const fakeSpawn = () => {
    const calls: { cmd: string; args: string[]; opts: Parameters<DetachedSpawn>[2] }[] = [];
    let unrefs = 0;
    const spawn: DetachedSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 777, unref: () => { unrefs++; }, on: () => undefined }; };
    return { calls, spawn, unrefs: () => unrefs };
  };

  it('refuses in-band with active leases and spawns nothing', () => {
    const f = fakeSpawn();
    const dir = tmp('minions-detach-');
    expect(() => scheduleDetachedRestart({ activeLeases: () => [{ id: 'lease-1' }], log: join(dir, 'logs', 'context-reset.log'), cwd: dir, spawn: f.spawn }, { recover: true }))
      .toThrow(expect.objectContaining({ code: 'PRECONDITION', message: 'Coordinator restart refused: 1 active worker lease(s) (lease-1).' }));
    expect(f.calls).toHaveLength(0);
  });

  it('idle: runs `minions coordinator restart --recover` in its own session, output to the log, and returns at once', () => {
    const f = fakeSpawn();
    const dir = tmp('minions-detach-');
    const log = join(dir, 'logs', 'context-reset.log');
    const r = scheduleDetachedRestart({ activeLeases: () => [], log, cwd: dir, spawn: f.spawn, env: { PATH: '/usr/bin' } }, { recover: true });
    expect(r).toMatchObject({ action: 'restart-scheduled', log, pid: 777 });
    expect(f.calls).toEqual([{ cmd: 'minions', args: ['coordinator', 'restart', '--recover'], opts: expect.objectContaining({ cwd: dir, detached: true, env: { PATH: '/usr/bin' } }) }]);
    expect(f.calls[0]!.opts.stdio[0]).toBe('ignore');
    expect(f.unrefs()).toBe(1);
    expect(statSync(log).isFile()).toBe(true);
  });

  it('the recovery prompt of the new session reads the handoff first', () => {
    expect(RECOVERY_PROMPT).toContain('minions coordinator handoff --read --json');
    expect(RECOVERY_PROMPT.indexOf('handoff --read')).toBeLessThan(RECOVERY_PROMPT.indexOf('Reconcile'));
  });
});

describe('Telegram survives a restart (pairing, inbound queue, outbox)', () => {
  it('a full restart (kill + relaunch + startup sweep) leaves access.json, the plugin inbox, the outbox and the handoff intact', async () => {
    const root = tmp('minions-tg-restart-');
    for (const d of ['plugin', 'secrets', 'state', 'claude/channels/telegram/inbox', 'claude/channels/telegram/approved']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
    const paths = {
      ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets'), TELEGRAM_STATE_DIR: join(root, 'claude', 'channels', 'telegram') }),
      pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
    };
    // The official plugin's state: pairing/allowlist and a downloaded attachment of an inbound message.
    const access = JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111222333'], groups: {}, pending: {} });
    writeFileSync(join(paths.telegramStateDir, 'access.json'), access);
    writeFileSync(join(paths.telegramStateDir, 'inbox', 'photo-1.jpg'), 'jpeg');
    writeFileSync(join(paths.telegramStateDir, 'approved', '111222333'), '');
    const db = new RuntimeDb(paths.db);
    session(db);
    enqueue(db, { key: 'delivered:task-1:abc', kind: 'delivered', taskId: 'task-1', text: 'Delivered task-1 on agent/task-1.' });
    await writeHandoff({ db, path: paths.coordinatorHandoff }, '## Open owner questions\n1. Rename the CLI? (recommended: no)');

    let alive = true;
    const calls: string[][] = [];
    const runner = async (_c: string, args: string[]): Promise<RunResult> => {
      calls.push(args);
      if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') { alive = false; return { code: 0, stdout: '', stderr: '' }; }
      if (args.includes('new-session')) { alive = true; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const r = await restartCoordinator(defaults(), { paths, runner, activeLeases: () => db.activeLeases(), sleep: async () => {} }, { recover: true });
    expect(r.action).toBe('restarted');
    // The new wrapper's startup sweep (coordinator run onStart) only touches lease scratch dirs and the TMPDIR root.
    await sweepScratchOnStart(db, paths, () => {});

    expect(readFileSync(join(paths.telegramStateDir, 'access.json'), 'utf8')).toBe(access);
    expect(readFileSync(join(paths.telegramStateDir, 'inbox', 'photo-1.jpg'), 'utf8')).toBe('jpeg');
    expect(statSync(join(paths.telegramStateDir, 'approved', '111222333')).isFile()).toBe(true);
    const fresh = new RuntimeDb(paths.db); // the new session's connection
    expect(pending(fresh).map((i) => i.key)).toEqual(['delivered:task-1:abc']);
    expect(readHandoff(paths.coordinatorHandoff)).toMatchObject({ present: true, text: expect.stringContaining('Rename the CLI?') });
    // Nothing in the restart path references the Telegram state dir.
    expect(calls.flat().join(' ')).not.toContain(paths.telegramStateDir);
  });

  it('the plugin keeps unconfirmed inbound updates across a restart (no drop_pending_updates), per its source', () => {
    // Evidence for the inbound queue: Telegram holds unconfirmed getUpdates for 24 h; the plugin starts polling
    // with bot.start({ onStart }) and never passes drop_pending_updates, so messages sent while no session polls
    // are delivered to the next session. Checked against the installed plugin when it is present.
    const server = '/home/node/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts';
    let src: string;
    try { src = readFileSync(server, 'utf8'); } catch { return; } // plugin not installed here: docs/design/telegram.md records the evidence
    expect(src).toMatch(/await bot\.start\(\{/);
    expect(src).not.toMatch(/drop_pending_updates/);
    expect(src).toMatch(/const ACCESS_FILE = join\(STATE_DIR, 'access\.json'\)/);
  });
});
