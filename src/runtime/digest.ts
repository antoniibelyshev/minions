// The owner digest and held notifications (task-68.5, docs/design/unattended-delivery.md decision 7, phase 4).
//
// - Holds: an outbox item held for the digest gets `next_attempt_at` = the next digest time, so `pending()` does
//   not return it earlier (no schema change). `notify enqueue --hold digest|none` decides per item; without the
//   flag the per-kind table DEFAULT_HOLDS applies, and only while routine.enabled is on (without the routine there
//   is no digest wake, so a default hold would only delay) and the owner is not in a live conversation.
// - The hold-back (reholdExpired, in each routine pass and before `notify pending`): while the routine is on, a held
//   item whose time came is moved on to the next digest time, so only the digest delivers it.
// - Due (digestStatus): the latest digest time (routine.digestAt in routine.timezone) at or before now whose digest
//   key `digest:<local YYYY-MM-DDTHH:MM>` is not delivered. A missed time (host asleep, container down, the
//   coordinator busy) is caught up at the first pass after it; only the latest time counts, so a long outage sends
//   one digest, not one per missed time. At most MAX_DIGEST_WAKES_PER_SLOT wakes per time, RETRY minutes apart.
// - Composition (composeDigest, pure and deterministic): fixed section order, sorted lines, questions as numbered
//   polls, the text under the Telegram limit. `notify digest` stores the text under the digest key; the
//   coordinator sends it with one `reply` and acks the returned keys (the digest key and every item it covered).
import type { Task } from '../backlog/types.js';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { sessionStates, totalOf, lastOwnerMessageAt } from './coordinator-usage.js';
import type { RuntimeDb } from './db.js';
import { isHeld, MAX_TEXT_LENGTH, NOTIFICATION_KINDS, pending, type NotificationKind, type OutboxItem } from './outbox.js';
import { OWNER_ACTIVE_MINUTES, routineSettings, WAKE_EVENT, type RoutineSettings } from './routine.js';
import type { SpendReport } from './spend.js';
import { localDate, localDayStart, localLabel, localStamp, zonedTimeToUtc } from './zoned-time.js';

/** Digest wakes per digest time: the first, and one retry when the woken session did not send it. */
export const MAX_DIGEST_WAKES_PER_SLOT = 2;
/** Minutes after a digest wake before the retry. */
export const DIGEST_RETRY_MINUTES = 60;
/** A digest time this many minutes old when first due was missed (caught up). */
const MISSED_AFTER_MINUTES = 30;
export const DIGEST_KEY_PREFIX = 'digest:';
/** Events that phase 5 records for each auto-promotion (listed in the digest). */
export const AUTO_PROMOTE_EVENT = 'auto-promote';

export type Hold = 'digest' | 'none';
export const HOLD_CHOICES = ['digest', 'none', 'default'] as const;

/**
 * Default hold per kind (while routine.enabled). Held: what the owner reads, not acts on, today (deliveries,
 * features) and questions, which the digest batches into numbered polls. Sent at once (at the next wake that
 * happens anyway; never a wake of its own): the answer to an owner message (goal-ack, owner-requested status),
 * approvals (a held approval would delay a merge by a day), blockers, and anything else.
 */
export const DEFAULT_HOLDS: Readonly<Record<NotificationKind, Hold>> = {
  'goal-ack': 'none', delivered: 'digest', feature: 'digest', blocker: 'none', approval: 'none',
  question: 'digest', status: 'none', digest: 'none', other: 'none',
};

// ---------------------------------------------------------------- digest times

export interface DigestSlot { at: string; local: string; key: string }

/** Digest instants on the local days around `now` (k days before to k days after), ascending. */
function slotsAround(now: Date, s: Pick<RoutineSettings, 'digestAt' | 'timezone'>, before = 2, after = 2): DigestSlot[] {
  const out: DigestSlot[] = [];
  for (let k = -before; k <= after; k++) {
    const d = localDate(now, s.timezone, k);
    for (const t of s.digestAt) {
      const [h, m] = t.split(':').map(Number) as [number, number];
      const at = zonedTimeToUtc(d.year, d.month, d.day, h, m, s.timezone);
      out.push({ at: at.toISOString(), local: localStamp(at, s.timezone), key: '' });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((x) => ({ ...x, key: `${DIGEST_KEY_PREFIX}${x.local}` }));
}

/** The latest digest time at or before `now`. */
export function lastDigestSlot(now: Date, s: Pick<RoutineSettings, 'digestAt' | 'timezone'>): DigestSlot {
  const t = now.toISOString();
  return slotsAround(now, s).filter((x) => x.at <= t).pop()!;
}

/** The first digest time after `now`: where a held item waits. */
export function nextDigestAt(now: Date, s: Pick<RoutineSettings, 'digestAt' | 'timezone'>): string {
  const t = now.toISOString();
  return slotsAround(now, s).find((x) => x.at > t)!.at;
}

// ---------------------------------------------------------------- holds

/**
 * The next_attempt_at for a new item, or null (sent at once). `hold`: digest = hold, none = never, default (or
 * undefined) = DEFAULT_HOLDS, only while the routine is on and the owner did not write in the last
 * OWNER_ACTIVE_MINUTES (they are in the chat: nothing is batched away from them).
 */
export function holdUntil(kind: string, hold: string | undefined, ctx: { settings: RoutineSettings; now: Date; lastOwnerMessageAt: string | null }): string | null {
  const h = hold ?? 'default';
  if (!(HOLD_CHOICES as readonly string[]).includes(h)) throw new MinionsError('PRECONDITION', `Unknown hold ${JSON.stringify(hold)}.`, `Use one of: ${HOLD_CHOICES.join(', ')}.`);
  if (kind === 'digest') {
    if (h === 'digest') throw new MinionsError('PRECONDITION', 'A digest cannot be held for the digest.', 'Compose it with `minions notify digest --json`.');
    return null;
  }
  if (h === 'none') return null;
  if (h === 'digest') return nextDigestAt(ctx.now, ctx.settings);
  if (!ctx.settings.enabled || !(NOTIFICATION_KINDS as readonly string[]).includes(kind) || DEFAULT_HOLDS[kind as NotificationKind] !== 'digest') return null;
  const owner = ctx.lastOwnerMessageAt ? (ctx.now.getTime() - Date.parse(ctx.lastOwnerMessageAt)) / 60_000 : Infinity;
  if (owner < OWNER_ACTIVE_MINUTES) return null;
  return nextDigestAt(ctx.now, ctx.settings);
}

/** holdUntil with the runtime's own context (config, clock, last owner message). */
export function holdFor(db: RuntimeDb, cfg: Pick<MinionsConfig, 'routine'>, kind: string, hold: string | undefined, now: Date = new Date()): string | null {
  return holdUntil(kind, hold, { settings: routineSettings(cfg), now, lastOwnerMessageAt: lastOwnerMessageAt(db) });
}

/**
 * The hold-back: while the routine is on, held items whose time came move on to the next digest time, so only the
 * digest delivers them (a session awake at 08:05 does not send them one by one). Returns the count.
 */
export function reholdExpired(db: RuntimeDb, cfg: Pick<MinionsConfig, 'routine'>, now: Date = new Date()): number {
  const s = routineSettings(cfg);
  if (!s.enabled) return 0;
  const t = now.toISOString();
  return db.exec("UPDATE outbox SET next_attempt_at = ? WHERE delivered_at IS NULL AND attempts = 0 AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? AND kind != 'digest'",
    nextDigestAt(now, s), t).changes;
}

// ---------------------------------------------------------------- due

export interface DigestStatus {
  enabled: boolean;
  timezone: string;
  times: string[];
  /** The latest digest time at or before now. */
  slot: DigestSlot;
  nextAt: string;
  /** When the digest of `slot` was delivered (acked), else null. */
  deliveredAt: string | null;
  /** Digest wakes since `slot`. */
  wakes: number;
  /** The wake reason detail when a digest wake is due now, else null. */
  due: string | null;
  /** The slot was missed (first due more than 30 min after its time): caught up now. */
  missed: boolean;
  /** Undelivered items held for the digest. */
  held: number;
}

export function digestStatus(db: RuntimeDb, cfg: Pick<MinionsConfig, 'routine'>, now: Date = new Date()): DigestStatus {
  const s = routineSettings(cfg);
  const slot = lastDigestSlot(now, s);
  const row = db.get<{ delivered_at: string | null }>('SELECT delivered_at FROM outbox WHERE dedup_key = ?', slot.key);
  const wakes = db.eventsOfKindSince(WAKE_EVENT, slot.at).filter((e) => (e.data as { digest?: unknown } | null)?.digest === true);
  const held = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL AND attempts = 0 AND next_attempt_at IS NOT NULL AND kind != 'digest'")?.n ?? 0;
  const age = (now.getTime() - Date.parse(slot.at)) / 60_000;
  const missed = age > MISSED_AFTER_MINUTES;
  const base = { enabled: s.enabled, timezone: s.timezone, times: s.digestAt, slot, nextAt: nextDigestAt(now, s), deliveredAt: row?.delivered_at ?? null, wakes: wakes.length, missed, held: Number(held) };
  let due: string | null = null;
  const lastWake = wakes.at(-1);
  if (s.enabled && !base.deliveredAt && wakes.length < MAX_DIGEST_WAKES_PER_SLOT
    && (!lastWake || (now.getTime() - Date.parse(lastWake.at)) / 60_000 >= DIGEST_RETRY_MINUTES)) {
    due = `digest ${slot.local} (${s.timezone}) due${missed ? ` (missed at its time: caught up ${Math.floor(age)} min late)` : ''}${lastWake ? '; retry: the last digest wake did not send it' : ''}`;
  }
  return { ...base, due };
}

// ---------------------------------------------------------------- composition

export type DigestTask = Pick<Task, 'id' | 'title' | 'status' | 'prUrl' | 'priority'>;

export interface DigestInput {
  now: Date;
  timezone: string;
  /** The digest key this text is stored under (`digest:<local time>`). */
  key: string;
  /** Start of the window for "merged" and "auto-promoted": the previous digest's delivery, else a day ago. */
  since: string;
  /** Undelivered outbox items (digest rows excluded). */
  items: OutboxItem[];
  /** The backlog (null when it could not be read). */
  tasks: DigestTask[] | null;
  merged: { taskId: string; prUrl: string | null; at: string }[];
  /** Publications and merges waiting for a host-signed approval (the manager chat's /approve). */
  approvals: { taskId: string; head: string; scope: 'publish' | 'merge' }[];
  autoPromoted: { taskId: string; at: string }[];
  spend: { todayTokens: number; todayUsd?: number; budget: { percent: number; text: string; exhausted: boolean } | null; wakesToday: number; wakeTokensToday: number } | null;
  runnable: { taskId: string; role: string }[];
}

export interface DigestQuestion { n: number; key: string; taskId: string | null; question: string; options: string[] }
export interface DigestSection { title: string; lines: string[] }

export interface Digest {
  key: string;
  text: string;
  /** Ack these after the send succeeded: the digest key and every outbox item the text covers. */
  keys: string[];
  /** Outbox items left out (the text limit): they stay pending for the next digest. */
  left: string[];
  questions: DigestQuestion[];
  sections: DigestSection[];
}

const byId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const oneLine = (t: string, max = 400) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const OPTION = /^(?:\(?\d{1,2}[.)]|[-*•])\s+(.+)$/;

/** A question item as a poll: option lines (`1. x`, `- x`) become options; "Other" is always the last one. */
export function parsePoll(text: string): { question: string; options: string[] } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const q: string[] = []; const options: string[] = [];
  for (const l of lines) {
    const m = OPTION.exec(l);
    if (m) options.push(oneLine(m[1]!, 200)); else if (!options.length) q.push(l);
  }
  const kept = options.filter((o) => !/^other\b/i.test(o));
  return { question: oneLine(q.join(' '), 600), options: kept.length ? [...kept, 'Other'] : [] };
}

const kTok = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * The digest text, deterministic for the same input: sections in a fixed order (merged and delivered, updates,
 * waiting for you, blockers, auto-promoted, spend, next up, questions), lines sorted, empty sections left out,
 * questions numbered Q1.. as polls. Outbox-backed lines that would push the text over the Telegram limit are left
 * out (in `left`, still pending), never cut in half.
 */
export function composeDigest(i: DigestInput): Digest {
  const tasks = new Map((i.tasks ?? []).map((t) => [t.id, t]));
  const title = (id: string) => { const t = tasks.get(id); return t ? `${id} ${oneLine(t.title, 80)}` : id; };
  const items = [...i.items].filter((x) => x.kind !== 'digest').sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : byId(a.key, b.key)));
  const ofKind = (...k: string[]) => items.filter((x) => k.includes(x.kind));
  const heldDelivered = new Set(ofKind('delivered').map((x) => x.taskId).filter(Boolean));
  const questions = ofKind('question').map((x, n): DigestQuestion => ({ n: n + 1, key: x.key, taskId: x.taskId, ...parsePoll(x.text) }));
  const qOf = new Map(questions.filter((q) => q.taskId).map((q) => [q.taskId!, q.n]));

  // Each line carries the outbox key it covers (null: from state, no ack needed).
  type Line = { text: string; key: string | null };
  const sections: { title: string; lines: Line[] }[] = [];
  const add = (t: string, lines: Line[]) => { if (lines.length) sections.push({ title: t, lines }); };
  const all = [...tasks.values()].sort((a, b) => byId(a.id, b.id));

  const merged = [...new Map([...i.merged].sort((a, b) => (a.at < b.at ? -1 : 1)).map((m) => [m.taskId, m])).values()].sort((a, b) => byId(a.taskId, b.taskId));
  add('Merged', merged.map((m) => ({ text: `- ${title(m.taskId)}${m.prUrl ? ` ${m.prUrl}` : ''}`, key: null })));
  add('Delivered, waiting for CI or merge', all.filter((t) => ['delivered', 'awaiting-ci', 'merging'].includes(t.status) && !heldDelivered.has(t.id))
    .map((t) => ({ text: `- ${title(t.id)}${t.status !== 'delivered' ? ` (${t.status})` : ''}${t.prUrl ? ` ${t.prUrl}` : ''}`, key: null })));
  add('Updates', ofKind('delivered', 'feature', 'status', 'goal-ack', 'other').map((x) => ({ text: `- ${oneLine(x.text)}`, key: x.key })));

  const approvals = [...i.approvals].sort((a, b) => byId(a.taskId, b.taskId) || a.scope.localeCompare(b.scope));
  add('Waiting for you', [
    ...approvals.map((a) => ({ text: `- ${title(a.taskId)}: ${a.scope === 'merge' ? 'merge' : 'publish'} approval, send in the manager chat: /approve ${a.taskId} ${a.head}${a.scope === 'merge' ? ' merge' : ''}`, key: null })),
    ...all.filter((t) => t.status === 'awaiting-human').map((t) => ({ text: `- ${title(t.id)}: needs your answer${qOf.has(t.id) ? ` (Q${qOf.get(t.id)})` : ''}`, key: null })),
    ...ofKind('approval').map((x) => ({ text: `- ${oneLine(x.text)}`, key: x.key })),
  ]);
  add('Blockers', [
    ...all.filter((t) => t.status === 'blocked').map((t) => ({ text: `- ${title(t.id)} (blocked)`, key: null })),
    ...ofKind('blocker').map((x) => ({ text: `- ${oneLine(x.text)}`, key: x.key })),
  ]);
  add('Auto-promoted (reply "cancel <id>" or "hold <id>")', [...new Set(i.autoPromoted.map((a) => a.taskId))].sort(byId).map((id) => ({ text: `- ${title(id)}`, key: null })));
  if (i.spend) {
    const s = i.spend;
    add('Spend today', [
      { text: `- ${kTok(s.todayTokens)} tokens${s.todayUsd !== undefined ? ` (~$${s.todayUsd.toFixed(2)} est.)` : ''}; coordinator wakes ${s.wakesToday} (${kTok(s.wakeTokensToday)} tokens)`, key: null },
      ...(s.budget ? [{ text: `- budget ${s.budget.percent}% of "${s.budget.text}"${s.budget.exhausted ? ': used up, new starts are refused until you raise it' : ''}`, key: null }] : []),
    ]);
  }
  const next = i.runnable.length
    ? [...i.runnable].map((r) => `- ${title(r.taskId)} (${r.role})`)
    : all.filter((t) => t.status === 'ready').sort((a, b) => prio(a) - prio(b) || byId(a.id, b.id)).map((t) => `- ${title(t.id)}`);
  add('Next up', next.slice(0, 5).map((text) => ({ text, key: null })));

  const head = `Digest ${localLabel(i.now, i.timezone)} (${i.timezone})`;
  const footerQ = questions.length ? ['Answer by number, e.g. `Q1 1`; for Other: `Q1 <n> <your answer>`.'] : [];
  const footer = [...footerQ, '', 'ref: #digest'];
  const budget = MAX_TEXT_LENGTH - footer.join('\n').length - 2;
  const out: string[] = [head];
  const covered: string[] = [];
  const left: string[] = [];
  const size = () => out.join('\n').length;
  const kept: DigestSection[] = [];
  for (const s of sections) {
    const lines: string[] = [];
    for (const l of s.lines) {
      const extra = (lines.length ? 0 : s.title.length + 3) + l.text.length + 1;
      if (size() + extra > budget) { if (l.key) left.push(l.key); continue; }
      if (!lines.length) out.push('', `${s.title}:`);
      out.push(l.text); lines.push(l.text);
      if (l.key) covered.push(l.key);
    }
    if (lines.length) kept.push({ title: s.title, lines });
  }
  const shownQ: DigestQuestion[] = [];
  for (const q of questions) {
    const block = [`Q${q.n}${q.taskId ? ` (${q.taskId})` : ''} ${q.question}`, ...(q.options.length ? q.options.map((o, k) => `  ${k + 1}. ${o}`) : ['  reply `Q' + q.n + ' <answer>`'])];
    const extra = (shownQ.length ? 0 : 'Questions:'.length + 2) + block.join('\n').length + 1;
    if (size() + extra > budget) { left.push(q.key); continue; }
    if (!shownQ.length) out.push('', 'Questions:');
    out.push(...block); shownQ.push(q); covered.push(q.key);
  }
  if (shownQ.length) kept.push({ title: 'Questions', lines: shownQ.map((q) => `Q${q.n} ${q.question}`) });
  if (out.length === 1) out.push('', 'Nothing new.');
  if (left.length) out.push('', `${left.length} more item(s) follow in the next digest.`);
  const text = [...out, ...(shownQ.length ? ['', ...footerQ] : []), '', 'ref: #digest'].join('\n');
  return { key: i.key, text, keys: [i.key, ...covered], left, questions: shownQ, sections: kept };
}

const prio = (t: DigestTask) => (t.priority === 'high' ? 0 : t.priority === 'medium' ? 1 : t.priority === 'low' ? 2 : 3);

// ---------------------------------------------------------------- inputs from the runtime state

export interface DigestSources {
  tasks: DigestTask[] | null;
  runnable: { taskId: string; role: string }[];
  spend: SpendReport | null;
}

/** The key of the digest to compose now: the latest time's, or (already delivered: an extra digest) now's. */
function currentKey(db: RuntimeDb, st: DigestStatus, now: Date): string {
  if (!st.deliveredAt) return st.slot.key;
  const base = `${DIGEST_KEY_PREFIX}${localStamp(now, st.timezone)}`;
  const delivered = (k: string) => !!db.get<{ delivered_at: string | null }>('SELECT delivered_at FROM outbox WHERE dedup_key = ?', k)?.delivered_at;
  let key = base;
  for (let n = 2; delivered(key); n++) key = `${base}+${n}`;
  return key;
}

export function digestInput(db: RuntimeDb, cfg: Pick<MinionsConfig, 'routine'>, src: DigestSources, now: Date = new Date()): DigestInput {
  const s = routineSettings(cfg);
  const st = digestStatus(db, cfg, now);
  const prev = db.get<{ at: string | null }>("SELECT MAX(delivered_at) AS at FROM outbox WHERE kind = 'digest' AND delivered_at IS NOT NULL")?.at ?? null;
  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const since = prev && prev > weekAgo ? prev : prev ? weekAgo : dayAgo;
  const items = pending(db, { includeWaiting: true }, () => now).filter((x) => x.kind !== 'digest');

  const merged: DigestInput['merged'] = [];
  for (const e of db.eventsOfKindSince('ci-observation', since)) {
    const d = e.data as { statusChange?: { to?: string } | null; prUrl?: string } | null;
    if (e.taskId && d?.statusChange?.to === 'done') merged.push({ taskId: e.taskId, prUrl: d.prUrl ?? null, at: e.at });
  }
  for (const e of db.eventsOfKindSince('merge', since)) {
    const d = e.data as { state?: string; prUrl?: string } | null;
    if (e.taskId && d?.state === 'merged') merged.push({ taskId: e.taskId, prUrl: d.prUrl ?? null, at: e.at });
  }

  const statusOf = new Map((src.tasks ?? []).map((t) => [t.id, t.status]));
  const approvals: DigestInput['approvals'] = [];
  for (const p of db.all<{ task_id: string; head_sha: string }>("SELECT task_id, head_sha FROM publications WHERE state = 'awaiting-approval'")) {
    approvals.push({ taskId: p.task_id, head: p.head_sha, scope: 'publish' });
  }
  const lastMerge = new Map<string, { state?: string; head?: string }>();
  for (const e of db.eventsOfKindSince('merge', weekAgo)) if (e.taskId) lastMerge.set(e.taskId, e.data as { state?: string; head?: string });
  for (const [taskId, d] of lastMerge) {
    const status = statusOf.get(taskId);
    if (d?.state === 'awaiting-approval' && d.head && (!src.tasks || status === 'delivered' || status === 'awaiting-ci' || status === 'merging')) approvals.push({ taskId, head: d.head, scope: 'merge' });
  }

  const autoPromoted = db.eventsOfKindSince(AUTO_PROMOTE_EVENT, since).filter((e) => e.taskId).map((e) => ({ taskId: e.taskId!, at: e.at }));
  const day = localDayStart(now, s.timezone);
  const wakesToday = db.eventsOfKindSince(WAKE_EVENT, day).length;
  const wakeTokensToday = sessionStates(db).filter((x) => x.woken && x.firstAt >= day).reduce((a, x) => a + totalOf(x.components), 0);
  const spend = src.spend ? {
    todayTokens: src.spend.today.tokens, ...(src.spend.today.estimatedUsd !== undefined ? { todayUsd: src.spend.today.estimatedUsd } : {}),
    budget: src.spend.budget ? { percent: src.spend.budget.percent, text: src.spend.budget.text, exhausted: src.spend.budget.exhausted } : null,
    wakesToday, wakeTokensToday,
  } : null;
  return { now, timezone: s.timezone, key: currentKey(db, st, now), since, items, tasks: src.tasks, merged, approvals, autoPromoted, spend, runnable: src.runnable };
}

/**
 * `minions notify digest`: composes the digest and stores it under its key (an undelivered row is replaced with
 * the new text, a delivered one is never touched), so `notify ack <keys...>` marks the digest time done.
 */
export function prepareDigest(db: RuntimeDb, cfg: Pick<MinionsConfig, 'routine'>, src: DigestSources, now: Date = new Date()): Digest & { status: DigestStatus } {
  const input = digestInput(db, cfg, src, now);
  const d = composeDigest(input);
  db.transaction(() => {
    const row = db.get<{ delivered_at: string | null }>('SELECT delivered_at FROM outbox WHERE dedup_key = ?', d.key);
    if (!row) {
      db.exec("INSERT INTO outbox (dedup_key, kind, task_id, text, created_at, attempts) VALUES (?, 'digest', NULL, ?, ?, 0)", d.key, d.text, now.toISOString());
      db.addEvent('notify-enqueue', null, { key: d.key, kind: 'digest', covers: d.keys.length - 1 });
    } else if (!row.delivered_at) {
      db.exec('UPDATE outbox SET text = ? WHERE dedup_key = ?', d.text, d.key);
    }
  });
  return { ...d, status: digestStatus(db, cfg, now) };
}

export function humanDigest(d: Digest): string {
  return `${d.text}\n\n(send with one reply, then: minions notify ack ${d.keys.join(' ')})${d.left.length ? `\n${d.left.length} item(s) left for the next digest` : ''}`;
}

export function humanDigestStatus(s: DigestStatus): string {
  return `digest: ${s.times.join(', ')} ${s.timezone}; last time ${s.slot.local} ${s.deliveredAt ? `sent ${s.deliveredAt}` : s.due ? 'due' : 'not sent'}; next ${s.nextAt}; ${s.held} held`;
}
