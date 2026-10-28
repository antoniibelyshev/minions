// task-90: the host change journal is compacted once large. Open offers, in-flight / interrupted requests and the
// applied config changes /undo can still name are kept; old closed requests are dropped. Temp MINIONS_HOME.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const J = await import('../../src/host/change-journal.js');
const { undoCandidates } = await import('../../src/host/manager-assistant-context.js');
const { withHome } = await import('./fixtures.js');
type JournalEntry = import('../../src/host/change-journal.js').JournalEntry;

let env: ReturnType<typeof withHome>;
beforeEach(() => { env = withHome(); });
afterEach(() => env.cleanup());

const P = 'p_test';
let seq = 0;
const id = () => `ow_${(seq++).toString(16).padStart(8, '0')}`;
const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();

/** An offer entry (the fields an old journal line has; no typed / direct / via). */
function offer(requestId: string, kind: string, plan: Record<string, unknown>, i: number, pad = ''): JournalEntry {
  return {
    type: 'offer', at: at(i), projectId: P, requestId, digest: 'd'.repeat(64), configRevision: 1, nonce: `${requestId}-n`.padEnd(32, '0'),
    expiresAt: at(i + 30), request: { id: requestId, kind, payload: {}, reason: null, origin: 'owner' }, plan: { kind, ...plan, pad },
  };
}
const outcome = (requestId: string, type: 'applied' | 'rejected' | 'failed' | 'confirmed', i: number): JournalEntry => ({ type, at: at(i), projectId: P, requestId });
const set = (key: string, from: number, to: number) => ({ change: { key, from, to } });

/**
 * A journal: 10 old rejected requests, 4 applied config-sets (the newest one undone by an applied undo), an old open
 * offer, an old request confirmed without an outcome (interrupted), then 3 newer rejected requests.
 */
function history(pad = '') {
  const e: JournalEntry[] = [];
  let i = 0;
  const openId = id(), stuckId = id();
  e.push(offer(openId, 'config-set', set('execution.maxActiveTasks', 1, 2), i++, pad));
  e.push(offer(stuckId, 'restart', {}, i++, pad), outcome(stuckId, 'confirmed', i++));
  const oldRejected: string[] = [];
  for (let k = 0; k < 10; k++) { const r = id(); oldRejected.push(r); e.push(offer(r, 'sync', {}, i++, pad), outcome(r, 'rejected', i++)); }
  const sets: string[] = [];
  for (let k = 0; k < 4; k++) { const r = id(); sets.push(r); e.push(offer(r, 'config-set', set(`k${k}`, k, k + 1), i++, pad), outcome(r, 'applied', i++)); }
  const undo = id();
  e.push(offer(undo, 'undo', { undo: { target: sets[3] }, ...set('k3', 4, 3) }, i++, pad), outcome(undo, 'applied', i++));
  const newRejected: string[] = [];
  for (let k = 0; k < 3; k++) { const r = id(); newRejected.push(r); e.push(offer(r, 'sync', {}, i++, pad), outcome(r, 'rejected', i++)); }
  return { e, openId, stuckId, oldRejected, sets, undo, newRejected };
}
const ids = (entries: JournalEntry[]) => new Set(entries.map((x) => x.requestId));

describe('compactEntries', () => {
  it('keeps open offers, interrupted requests and the undo candidates; drops the oldest closed requests', () => {
    const h = history();
    const kept = J.compactEntries(h.e, { keepClosed: 3, keepUndo: 3 });
    const k = ids(kept);
    expect(k.has(h.openId)).toBe(true);
    expect(k.has(h.stuckId)).toBe(true);
    // The newest 3 applied config changes per project (sets[2], sets[3] and the undo), whatever the closed tail.
    expect(k.has(h.undo) && k.has(h.sets[3]!) && k.has(h.sets[2]!)).toBe(true);
    expect(k.has(h.sets[0]!) || k.has(h.sets[1]!)).toBe(false);
    // The closed tail: the newest 3 other closed requests (sets[1] would be next, so the old rejected ones go).
    for (const r of h.newRejected) expect(k.has(r)).toBe(true);
    for (const r of h.oldRejected) expect(k.has(r)).toBe(false);
    // A request is kept whole and in order.
    expect(kept.filter((x) => x.requestId === h.stuckId).map((x) => x.type)).toEqual(['offer', 'confirmed']);
    expect(kept).toEqual(h.e.filter((x) => k.has(x.requestId)));
    // What /undo offers is unchanged (the undone sets[3] stays left out, because its undo is kept with it).
    expect(undoCandidates(kept, P, 2)).toEqual(undoCandidates(h.e, P, 2));
    expect(undoCandidates(kept, P, 2).map((c) => c.id)).toEqual([h.undo, h.sets[2]]);
  });

  it('a dropped applied or rejected container request leaves a tombstone; a failed one does not; stable on repeat', () => {
    const cr = (n: number) => `cr_${n.toString(16).padStart(8, '0')}`;
    const e: JournalEntry[] = [];
    const types = ['applied', 'rejected', 'failed'] as const;
    types.forEach((t, n) => e.push({ ...offer(cr(n), 'sync', {}, 2 * n), request: { id: cr(n), kind: 'sync', payload: {}, reason: null } } as JournalEntry,
      { type: t, at: at(2 * n + 1), projectId: P, requestId: cr(n), digest: 'd'.repeat(64), detail: 'done' }));
    const newer = id();
    e.push(offer(newer, 'sync', {}, 10), outcome(newer, 'rejected', 11));
    const kept = J.compactEntries(e, { keepClosed: 1, keepUndo: 0 });
    expect(kept).toEqual([
      { type: 'applied', at: at(1), projectId: P, requestId: cr(0) },
      { type: 'rejected', at: at(3), projectId: P, requestId: cr(1) },
      ...e.slice(-2),
    ]);
    expect(J.lastOutcome(kept, P, cr(0))?.type).toBe('applied');
    expect(J.compactEntries(kept, { keepClosed: 1, keepUndo: 0 })).toBe(kept);
  });

  it('returns the same array when nothing is dropped', () => {
    const h = history();
    expect(J.compactEntries(h.e)).toBe(h.e);
  });
});

describe('journal compaction on append', () => {
  it('a journal past COMPACT_AT_BYTES is rewritten by the next append (atomic, 0600); old lines still parse', async () => {
    // Old-format lines with a large plan each, so the file passes the threshold with a few hundred entries.
    const h = history('x'.repeat(Math.ceil(J.COMPACT_AT_BYTES / 20)));
    mkdirSync(J.managerDir(), { recursive: true, mode: 0o700 });
    writeFileSync(J.journalPath(), h.e.map((x) => JSON.stringify(x) + '\n').join(''), { mode: 0o600 });
    const sizeBefore = statSync(J.journalPath()).size;
    expect(sizeBefore).toBeGreaterThan(J.COMPACT_AT_BYTES);

    // More closed requests than the tail keeps: the append that finds the file large drops the oldest.
    const extra: JournalEntry[] = [];
    for (let k = 0; k < J.KEEP_CLOSED_REQUESTS; k++) { const r = id(); extra.push(offer(r, 'sync', {}, 1000 + 2 * k), outcome(r, 'rejected', 1001 + 2 * k)); }
    writeFileSync(J.journalPath(), readFileSync(J.journalPath(), 'utf8') + extra.map((x) => JSON.stringify(x) + '\n').join(''));
    const last = id();
    await J.recordOutcome({ type: 'failed', projectId: P, requestId: last, detail: 'appended under the lock' });

    const after = await J.readJournal();
    const k = ids(after);
    expect(statSync(J.journalPath()).size).toBeLessThan(sizeBefore);
    expect(statSync(J.journalPath()).mode & 0o777).toBe(0o600);
    // The appended entry survives its own compaction.
    expect(after.at(-1)).toMatchObject({ type: 'failed', requestId: last, detail: 'appended under the lock' });
    expect(k.has(h.openId) && k.has(h.stuckId) && k.has(h.undo) && k.has(h.sets[2]!)).toBe(true);
    for (const r of [...h.oldRejected, ...h.newRejected]) expect(k.has(r)).toBe(false);
    expect(J.interruptedEntries(after, () => false).map((x) => x.requestId)).toEqual([h.stuckId]);
    expect(undoCandidates(after, P)).toEqual(undoCandidates([...h.e, ...extra], P));
  });

  it('a small journal is only appended to', async () => {
    const h = history();
    mkdirSync(J.managerDir(), { recursive: true, mode: 0o700 });
    const text = h.e.map((x) => JSON.stringify(x) + '\n').join('');
    writeFileSync(J.journalPath(), text, { mode: 0o600 });
    await J.recordOutcome({ type: 'rejected', projectId: P, requestId: h.openId });
    const now = readFileSync(J.journalPath(), 'utf8');
    expect(now.startsWith(text)).toBe(true);
    expect(now.slice(text.length).trim().split('\n')).toHaveLength(1);
  });
});
