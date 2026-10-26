// Coordinator token tracking (task-57.1, docs/design/coordinator-sessions.md "Step 1"): the Stop hook reads the
// main session's transcript incrementally and records its usage per Claude session id; the baseline in
// `work spend`. Fixture transcripts only (temp files); no live Claude run.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectStatus, currentSessionKey, humanStatus, spendCommand } from '../../src/runtime/commands.js';
import { noteTranscript } from '../../src/runtime/context-reset.js';
import {
  completeOpenSessions, foldTranscriptLines, newSessionState, noteResetRequest, readIncrement, readSessionState, trackCoordinatorUsage, USAGE_META_PREFIX,
} from '../../src/runtime/coordinator-usage.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { RECOVERY_PROMPT } from '../../src/runtime/coordinator.js';
import { humanBaseline, humanSpend, spendReport } from '../../src/runtime/spend.js';
import { defaults } from '../helpers.js';
import { makeEnv, tmp, type Env } from './fixtures.js';

const cfg = defaults();

function freshDb(lock = true): RuntimeDb {
  const db = new RuntimeDb(join(tmp('minions-cusage-'), 'state', 'minions.db'));
  if (lock) db.acquireCoordinatorLock('coordinator', 4242, () => false);
  return db;
}

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number) =>
  ({ input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output });
/** One assistant line (Claude Code writes one per content block, each with the message's usage). */
const asst = (id: string, u: ReturnType<typeof usage>, o: { sidechain?: boolean; content?: unknown[]; model?: string } = {}) =>
  ({ type: 'assistant', isSidechain: o.sidechain ?? false, message: { id, role: 'assistant', model: o.model ?? 'claude-opus-4-5', usage: u, content: o.content ?? [{ type: 'text', text: 'ok' }] } });
const user = (text: string, sidechain = false) => ({ type: 'user', isSidechain: sidechain, message: { role: 'user', content: text } });
const toolResult = () => ({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } });
const lines = (xs: unknown[]) => xs.map((x) => JSON.stringify(x) + '\n').join('');
const owner = (text: string) => `<channel source="telegram" chat_id="1" message_id="9" user="owner" ts="2026-10-26T10:00:00Z">${text}</channel>`;

function transcriptFile(content: string, name = 'sess.jsonl'): string {
  const file = join(tmp('minions-transcript-'), name);
  writeFileSync(file, content);
  return file;
}

const track = (db: RuntimeDb, sessionId: string, path: string, extra: Record<string, unknown> = {}, now?: Date) =>
  trackCoordinatorUsage({ db, config: cfg, env: {}, ...(now ? { now } : {}) }, { transcript_path: path, session_id: sessionId, ...extra });

const usageEvents = (db: RuntimeDb) => db.all<{ data_json: string }>("SELECT data_json FROM events WHERE kind = 'usage' ORDER BY id").map((r) => JSON.parse(r.data_json));

describe('transcript folding', () => {
  it('counts a message id once (one line per content block), keeps the components apart and skips sidechain lines', () => {
    const s = newSessionState('s1', '/x.jsonl', new Date());
    foldTranscriptLines(s, lines([
      user('hello'),
      asst('msg_1', usage(10, 1000, 200, 5), { content: [{ type: 'thinking', thinking: '' }] }),
      asst('msg_1', usage(10, 1000, 200, 30), { content: [{ type: 'text', text: 'hi' }] }),
      asst('msg_1', usage(10, 1000, 200, 30), { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }),
      toolResult(),
      asst('msg_side', usage(999, 99_999, 9999, 999), { sidechain: true }),
      user(owner('ignored: a subagent prompt'), true),
      asst('msg_2', usage(3, 1300, 0, 7)),
    ]));
    expect(s.components).toEqual({ input: 13, cacheRead: 2300, cacheWrite: 200, output: 37 });
    expect(s.turns).toBe(2);
    expect(s.maxContext).toBe(1300 + 3);
    expect(s.contextSum).toBe(1210 + 1303);
    expect(s.ownerMessages).toBe(0);
    expect(s.model).toBe('claude-opus-4-5');
    // The same id again in a later read (lines of one message split across two reads) is not counted twice.
    foldTranscriptLines(s, lines([asst('msg_2', usage(3, 1300, 0, 7))]));
    expect(s.turns).toBe(2);
  });

  it('counts owner messages (telegram channel tags) and the reset overhead of a recovered session until its first claim or reply', () => {
    const s = newSessionState('s1', '/x.jsonl', new Date());
    foldTranscriptLines(s, lines([
      user(RECOVERY_PROMPT),
      asst('m1', usage(1, 100, 0, 1)),
      asst('m2', usage(1, 200, 0, 1)),
      user(owner('status?')),
      asst('m3', usage(1, 300, 0, 1), { content: [{ type: 'tool_use', name: 'mcp__plugin_telegram_telegram__reply', input: { text: 'all good' } }] }),
      asst('m4', usage(1, 400, 0, 1)),
      user(owner('ship it')),
    ]));
    expect(s.recovered).toBe(true);
    expect(s.overhead).toBe(102 + 202);
    expect(s.overheadDone).toBe(true);
    expect(s.ownerMessages).toBe(2);

    const t = newSessionState('s2', '/y.jsonl', new Date());
    foldTranscriptLines(t, lines([user('/minions:orchestrate'), asst('m1', usage(1, 100, 0, 1),
      { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'minions work claim task-1 --role engineer --json' } }] })]));
    expect(t.recovered).toBe(false);
    expect(t.overhead).toBe(0);
  });

  it('ignores malformed lines and zero-usage (synthetic) messages', () => {
    const s = newSessionState('s1', '/x.jsonl', new Date());
    foldTranscriptLines(s, '{not json\n' + lines([{ type: 'assistant', message: { id: 'z', model: '<synthetic>', usage: usage(0, 0, 0, 0) } }, { type: 'summary' }, asst('m', usage(1, 2, 3, 4))]));
    expect(s.turns).toBe(1);
    expect(s.components).toEqual({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 });
  });
});

describe('incremental read', () => {
  it('leaves a truncated last line for the next read, then counts it once it is complete', () => {
    const full = JSON.stringify(asst('m2', usage(5, 500, 0, 5)));
    const file = transcriptFile(lines([asst('m1', usage(1, 100, 0, 1))]) + full.slice(0, 40));
    const s = newSessionState('s1', file, new Date());
    expect(readIncrement(s)).toMatchObject({ advanced: true, more: true, missing: false });
    expect(s.turns).toBe(1);
    const offset = s.offset;
    expect(readIncrement(s)).toMatchObject({ advanced: false });
    expect(s.offset).toBe(offset);
    appendFileSync(file, full.slice(40) + '\n');
    readIncrement(s);
    expect(s.turns).toBe(2);
    expect(s.components.input).toBe(6);
    // Nothing new: no change.
    expect(readIncrement(s)).toMatchObject({ advanced: false, more: false });
    expect(s.turns).toBe(2);
  });

  it('reads at most maxBytes per call and catches up over later calls', () => {
    const body = lines(Array.from({ length: 50 }, (_, i) => asst(`m${i}`, usage(1, 10, 0, 1))));
    const file = transcriptFile(body);
    const s = newSessionState('s1', file, new Date());
    let calls = 0;
    while (readIncrement(s, { maxBytes: 2048 }).more) calls++;
    expect(calls).toBeGreaterThan(1);
    expect(s.turns).toBe(50);
    expect(s.offset).toBe(Buffer.byteLength(body));
  });

  it('a missing file reports missing and never throws', () => {
    const s = newSessionState('s1', join(tmp('minions-transcript-'), 'gone.jsonl'), new Date());
    expect(readIncrement(s)).toEqual({ advanced: false, more: false, missing: true });
  });
});

describe('Stop hook tracking', () => {
  it('records the session cumulatively, keyed session:<session_id>, only for the main coordinator session', () => {
    const db = freshDb();
    const file = transcriptFile(lines([user('go'), asst('m1', usage(10, 1000, 100, 20))]));
    expect(track(db, 'sess-a', file).recorded).toBe(true);
    appendFileSync(file, lines([toolResult(), asst('m2', usage(5, 1200, 0, 10))]));
    track(db, 'sess-a', file);
    // No new bytes: no new usage event.
    track(db, 'sess-a', file);
    const ev = usageEvents(db);
    expect(ev).toHaveLength(2);
    expect(ev[1]).toMatchObject({ key: 'session:sess-a', scope: 'session', role: 'coordinator', source: 'transcript', tokens: 2345,
      components: { input: 15, cacheRead: 2200, cacheWrite: 100, output: 30 }, turns: 2, maxContext: 1205, model: 'claude-opus-4-5' });
    expect(spendReport({ db, config: cfg, billing: 'subscription' }).coordinator.tokens).toBe(2345);

    // Not the main coordinator session: a subagent, a process worker, or no coordinator lock.
    const other = transcriptFile(lines([asst('x', usage(1, 1, 1, 1))]));
    expect(track(db, 'sess-b', other, { agent_id: 'a1', agent_type: 'minions:engineer' })).toMatchObject({ recorded: false, reason: 'subagent' });
    expect(trackCoordinatorUsage({ db, env: { MINIONS_ROLE: 'engineer' } }, { transcript_path: other, session_id: 'sess-b' })).toMatchObject({ recorded: false });
    expect(track(freshDb(false), 'sess-b', other)).toMatchObject({ recorded: false, reason: 'no coordinator lock' });
    expect(track(db, '../evil', other)).toMatchObject({ recorded: false });
    expect(readSessionState(db, 'sess-b')).toBeNull();
  });

  it('a missing transcript records nothing and never throws', () => {
    const db = freshDb();
    expect(track(db, 'sess-a', join(tmp('minions-transcript-'), 'gone.jsonl'))).toMatchObject({ recorded: true, reason: 'transcript missing' });
    expect(usageEvents(db)).toHaveLength(0);
    expect(spendReport({ db, config: cfg, billing: 'subscription' }).coordinator.tokens).toBe(0);
  });

  it('two sessions across a reset: separate keys, the first completed with its trigger at the next start', () => {
    const db = freshDb();
    const t0 = new Date('2026-10-26T09:00:00Z');
    const a = transcriptFile(lines([user('/minions:orchestrate'), asst('a1', usage(10, 40_000, 2000, 100))]), 'a.jsonl');
    track(db, 'sess-a', a, {}, t0);
    // The session wrote more before it was restarted (its last Stop never ran).
    appendFileSync(a, lines([asst('a2', usage(10, 50_000, 0, 100))]));
    db.addEvent('record', 'task-1', { leaseId: 'lease-1', to: 'delivered' });
    noteResetRequest(db, ['delivered'], new Date('2026-10-26T09:30:00Z'));
    // Next start: the interrupted session is completed from the transcript path in its meta state.
    expect(completeOpenSessions({ db, config: cfg, now: new Date('2026-10-26T09:31:00Z') }).completed).toEqual(['sess-a']);
    const sa = readSessionState(db, 'sess-a')!;
    expect(sa.turns).toBe(2);
    expect(sa.ended).toMatchObject({ trigger: 'context-reset', detail: 'delivered' });

    const b = transcriptFile(lines([user(RECOVERY_PROMPT), asst('b1', usage(10, 20_000, 5000, 50)), user(owner('hi')),
      asst('b2', usage(1, 25_000, 0, 10), { content: [{ type: 'tool_use', name: 'mcp__plugin_telegram_telegram__reply', input: {} }] })]), 'b.jsonl');
    track(db, 'sess-b', b, {}, new Date('2026-10-26T09:32:00Z'));
    const r = spendReport({ db, config: cfg, billing: 'api-key', now: new Date('2026-10-26T10:00:00Z') });
    const ta = 10 + 40_000 + 2000 + 100 + 10 + 50_000 + 100;
    const tb = 10 + 20_000 + 5000 + 50 + 1 + 25_000 + 10;
    expect(r.coordinator.tokens).toBe(ta + tb);
    expect(r.coordinator.estimatedUsd).toBeGreaterThan(0);
    const bl = r.coordinator.baseline;
    expect(bl).toMatchObject({
      since: '2026-10-26T09:00:00.000Z', sessions: 2, open: 1, endedBy: { 'context-reset': 1 }, resetTriggers: { delivered: 1 },
      tokens: ta + tb, turns: { total: 4, perSession: 2 }, contextPerTurn: { max: 50_010 }, ownerMessages: 1, deliveredTasks: 1,
      tokensPerDeliveredTask: ta + tb, tokensPerOwnerMessage: ta + tb,
      resetOverhead: { recoveredSessions: 1, tokens: 10 + 20_000 + 5000 + 50, perRecovery: 25_060 }, share: 1, model: 'claude-opus-4-5',
    });
    // Weighted USD (opus 4.5: $5/MTok input; cache read 0.1x, cache write 1.25x, output 5x).
    const w = (i: number, cr: number, cw: number, o: number) => (i + cr * 0.1 + cw * 1.25 + o * 5) / 1e6 * 5;
    expect(bl.estimatedUsd).toBeCloseTo(w(20, 90_000, 2000, 200) + w(11, 45_000, 5000, 60), 2);
    expect(humanBaseline(bl)).toMatch(/2 session\(s\) \(1 open; ended: context-reset 1; resets by trigger: delivered 1\), 4 turns/);
  });

  it('a new session completes the previous one at its first Stop when the start did not; a plain restart or exit is the trigger', () => {
    const db = freshDb();
    const a = transcriptFile(lines([asst('a1', usage(1, 100, 0, 1))]), 'a.jsonl');
    track(db, 'sess-a', a, {}, new Date('2026-10-26T09:00:00Z'));
    db.setMeta('coordinator_restart', JSON.stringify({ at: '2026-10-26T09:10:00.000Z', reason: 'restart requested', leases: [] }));
    const b = transcriptFile(lines([asst('b1', usage(1, 100, 0, 1))]), 'b.jsonl');
    track(db, 'sess-b', b, {}, new Date('2026-10-26T09:11:00Z'));
    expect(readSessionState(db, 'sess-a')!.ended).toMatchObject({ trigger: 'restart', detail: 'restart requested' });
    expect(readSessionState(db, 'sess-b')!.ended).toBeUndefined();
    // No restart recorded after sess-b began: it just exited.
    completeOpenSessions({ db, config: cfg, now: new Date('2026-10-26T10:00:00Z') });
    expect(readSessionState(db, 'sess-b')!.ended).toMatchObject({ trigger: 'exit' });
    expect(spendReport({ db, config: cfg, billing: 'subscription' }).coordinator.baseline.endedBy).toEqual({ restart: 1, exit: 1 });
  });

  it('a corrupt meta state is replaced, never thrown', () => {
    const db = freshDb();
    db.setMeta(USAGE_META_PREFIX + 'sess-a', '{broken');
    const file = transcriptFile(lines([asst('m1', usage(1, 2, 3, 4))]));
    expect(track(db, 'sess-a', file).recorded).toBe(true);
    expect(readSessionState(db, 'sess-a')!.turns).toBe(1);
  });
});

describe('Stop hook integration', () => {
  const loader = (env: Env) => () => ({ db: env.db, backlog: env.backlog, config: env.config });

  it('records usage on every Stop without changing the decision or defeating the no-progress guard', async () => {
    const env = makeEnv();
    env.db.acquireCoordinatorLock('coordinator', 4242, () => false);
    env.backlog.add({ id: 'task-1' });
    const file = transcriptFile(lines([asst('m1', usage(1, 100, 0, 1))]));
    const inp = { transcript_path: file, session_id: 'sess-a' };
    const decisions: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      appendFileSync(file, lines([asst(`n${i}`, usage(1, 100 + i, 0, 1))]));
      const o = await stopHook(inp, loader(env));
      decisions.push(o.stdout ? JSON.parse(o.stdout).decision : null);
    }
    // block, block, then allow (no progress): usage events in between are not progress.
    expect(decisions).toEqual(['block', 'block', null]);
    expect(env.db.guard().last_reason).toBe('no-progress');
    expect(readSessionState(env.db, 'sess-a')!.turns).toBe(4);
    expect(usageEvents(env.db).length).toBe(3);
  });

  it('a throwing state store never changes the Stop decision', async () => {
    const env = makeEnv();
    env.db.acquireCoordinatorLock('coordinator', 4242, () => false);
    const file = transcriptFile(lines([asst('m1', usage(1, 100, 0, 1))]));
    const db = new Proxy(env.db, {
      get(t, p) {
        if (p === 'setMeta') return () => { throw new Error('disk full'); };
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const o = await stopHook({ transcript_path: file, session_id: 'sess-a' }, () => ({ db, backlog: env.backlog, config: env.config }));
    expect(o.reason).toMatch(/^allow: no runnable tasks/);
  });
});

describe('work spend and status', () => {
  it('show non-zero coordinator spend and the baseline; a manual --session figure overrides the measured one (no double count)', async () => {
    const db = freshDb();
    const file = transcriptFile(lines([asst('m1', usage(100, 10_000, 1000, 400))]));
    noteTranscript(db, { transcript_path: file, session_id: 'sess-a' });
    track(db, 'sess-a', file);
    const r1 = await spendCommand({}, { db, config: cfg });
    expect(r1.coordinator.tokens).toBe(11_500);
    expect(r1.coordinator.baseline.sessions).toBe(1);
    expect(humanSpend(r1)).toMatch(/coordinator: 11,500 tokens/);

    // --session without an id targets the Claude session the Stop hook saw: it replaces, never adds.
    expect(currentSessionKey(db)).toBe('sess-a');
    const r2 = await spendCommand({ session: true, tokens: '20000' }, { db, config: cfg });
    expect(r2.coordinator.tokens).toBe(20_000);
    // A later measured figure does not undo the override.
    appendFileSync(file, lines([asst('m2', usage(100, 12_000, 0, 400))]));
    track(db, 'sess-a', file);
    expect(spendReport({ db, config: cfg, billing: 'subscription' }).coordinator.tokens).toBe(20_000);

    const env = makeEnv();
    env.db.acquireCoordinatorLock('coordinator', 4242, () => false);
    track(env.db, 'sess-z', transcriptFile(lines([asst('m1', usage(1, 2000, 0, 3))])));
    const s = await collectStatus({ db: env.db, config: env.config, backlog: async () => env.backlog });
    expect(s.spend?.coordinator).toMatchObject({ tokens: 2004, baseline: { sessions: 1, turns: { total: 1 } } });
    expect(humanStatus(s)).toMatch(/coordinator: 2,004 tokens/);
    expect(humanStatus(s)).not.toMatch(/coordinator baseline/);
  });

  it('without a measured session the baseline says so and the coordinator total stays as recorded', () => {
    const db = freshDb();
    const r = spendReport({ db, config: cfg, billing: 'subscription' });
    expect(r.coordinator).toMatchObject({ tokens: 0, baseline: { sessions: 0, since: null, share: null, tokensPerDeliveredTask: null } });
    expect(humanBaseline(r.coordinator.baseline)).toMatch(/no session measured yet/);
  });
});
