import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import type { RuntimeDb } from './db.js';
import { sessionStates, totalOf, weightedMTok, type CoordinatorSessionState, type SessionEndTrigger, type UsageComponents } from './coordinator-usage.js';

/**
 * Spend monitoring (task-32): a durable usage tally and an owner budget, kept in the runtime DB without a
 * schema change.
 *
 * Source of the numbers: the coordinator passes the worker's token total from its task notification
 * (`subagent_tokens`) with `minions work record|release <leaseId> --usage <tokens>`, or later with
 * `minions work spend --lease <id> --tokens <n>`. The coordinator's own sessions are measured from their
 * transcript by the Stop hook (coordinator-usage.ts); a figure set by hand
 * with `minions work spend --session --tokens <n>` overrides that session. A WorkerResult `usage` block is the fallback when no
 * flag is given. Each figure is stored as a `usage` event (events table). The figure is cumulative for that
 * agent (a resumed agent's notification includes the earlier turns), so the latest figure per lease or
 * session replaces the earlier one: a correction never double-counts.
 *
 * The budget (controls row `budget`) is in tokens, attempts (claims) or, with API-key billing, estimated
 * USD. Claims are refused at 100%; running leases are never touched. The tally and the budget logic are
 * the same for API-key billing and a Claude subscription; only the units and wording differ.
 */

export type Billing = 'api-key' | 'subscription';
export type BudgetUnit = 'tokens' | 'usd' | 'attempts';
/** since-set: spend counted from when the budget was set; day: per UTC day. */
export type BudgetPeriod = 'since-set' | 'day';

export interface Budget {
  limit: number; unit: BudgetUnit; period: BudgetPeriod;
  /** The owner's words, as given. */
  text: string; setAt: string; setBy: string | null;
  /** Highest threshold (50/80/100) already reported in the current window, and that window. */
  notified?: { threshold: number; window: string };
}

export const THRESHOLDS = [50, 80, 100] as const;

/** Billing from the non-secret MINIONS_AUTH_METHOD (same rule as runtimeAuthMethod in coordinator.ts). */
export function billingOf(env: NodeJS.ProcessEnv = process.env): Billing {
  const m = env.MINIONS_AUTH_METHOD;
  return m === 'api-key' || m === 'helper' ? 'api-key' : 'subscription';
}

// ---------------------------------------------------------------- estimates

/**
 * Rough USD per million tokens by model family, at the input rate: notification totals do not separate
 * input, output and cache tokens, so any estimate is rough. The Console usage page is authoritative.
 */
const USD_PER_MTOK: [RegExp, number][] = [
  [/opus-4(-[01])?(-\d{8})?$|opus-4-1/, 15],
  [/opus/, 5],
  [/sonnet/, 3],
  [/haiku-3/, 0.8],
  [/haiku/, 1],
];

export function usdPerMTok(model: string | null | undefined): number | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [re, usd] of USD_PER_MTOK) if (re.test(m)) return usd;
  return null;
}

export const ESTIMATE_NOTE = 'USD is a rough estimate: worker notification totals do not separate input, output and cache tokens (priced at the model\'s input rate); measured coordinator tokens are weighted by component. The Console usage page has the authoritative numbers.';
export const SUBSCRIPTION_NOTE = 'Claude subscription: tokens only. The remaining plan quota (session and weekly limits) is not visible to minions.';

// ---------------------------------------------------------------- parsing

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** A token count: `135947`, `135,947`, `135k`, `1.5M`, `2 million`. */
export function parseTokens(text: string): number {
  const m = /^\s*(\d+(?:[.,_]\d+)*)\s*(k|thousand|mm|m|million|b|billion)?\s*(tokens?)?\s*$/i.exec(String(text));
  if (!m) throw new MinionsError('PRECONDITION', `Not a token count: "${text}".`, 'Pass a whole number of tokens, e.g. 135947 or 1.5M.');
  const n = numberOf(m[1]!, !!m[2]) * (m[2] ? MULT[m[2].toLowerCase()]! : 1);
  if (!Number.isFinite(n) || n < 0) throw new MinionsError('PRECONDITION', `Not a token count: "${text}".`);
  return Math.round(n);
}

/** `1,500,000` / `1_500_000` are thousands separators; with a suffix (`1.5M`) a dot or comma is a decimal point. */
function numberOf(s: string, suffixed: boolean): number {
  if (suffixed) return Number(s.replace(/_/g, '').replace(',', '.'));
  if (/^\d+\.\d+$/.test(s)) return Number(s);
  return Number(s.replace(/[.,_]/g, ''));
}

/**
 * Parses a budget in plain language: "5M tokens", "500k tokens per day", "$50", "50 USD daily",
 * "20 attempts", "3000000". A bare number is tokens. Returns null for "off" / "none" / "clear".
 */
export function parseBudget(text: string): Pick<Budget, 'limit' | 'unit' | 'period'> | null {
  let t = String(text).trim().toLowerCase();
  if (/^(off|none|clear|no budget|unlimited|remove)$/.test(t)) return null;
  let period: BudgetPeriod = 'since-set';
  const daily = /\s*(\bper\s+day\b|\ba\s+day\b|\beach\s+day\b|\bdaily\b|\/\s*day\b|\btoday\b|\bper\s+24\s*h(ours)?\b)\s*/;
  if (daily.test(t)) { period = 'day'; t = t.replace(daily, ' ').trim(); }
  t = t.replace(/^(stop\s+at|up\s+to|at\s+most|max(imum)?|limit|budget)\s*:?\s*/, '').trim();
  let unit: BudgetUnit = 'tokens';
  if (/^\$|\busd\b|\bdollars?\b|^us\$/.test(t)) {
    unit = 'usd';
    t = t.replace(/^us\$|^\$|\busd\b|\bdollars?\b/g, ' ').trim();
  } else if (/\b(attempts?|workers?|runs?|claims?|stages?)\b/.test(t)) {
    unit = 'attempts';
    t = t.replace(/\b(attempts?|workers?|runs?|claims?|stages?)\b/g, ' ').trim();
  }
  const m = /^(\d+(?:[.,_]\d+)*)\s*(k|thousand|mm|m|million|b|billion)?\s*(tokens?)?$/.exec(t);
  if (!m || (unit !== 'tokens' && m[3])) {
    throw new MinionsError('PRECONDITION', `Cannot read the budget "${text}".`,
      'Give an amount with a unit, e.g. "5M tokens", "500k tokens per day", "$50", "20 attempts", or "off".');
  }
  const base = unit === 'usd' && !m[2] ? Number(m[1]!.replace(/[,_]/g, '')) : numberOf(m[1]!, !!m[2]);
  const limit = base * (m[2] ? MULT[m[2]]! : 1);
  if (!Number.isFinite(limit) || limit <= 0) throw new MinionsError('PRECONDITION', `The budget must be positive (got "${text}").`);
  return { limit: unit === 'usd' ? Math.round(limit * 100) / 100 : Math.round(limit), unit, period };
}

// ---------------------------------------------------------------- storage

export interface UsageInput {
  tokens: number;
  model?: string | null;
  /** record | release | result (the WorkerResult usage block) | manual (`work spend`) | runner (a process harness, `work run`) | transcript (the coordinator's Stop hook, coordinator-usage.ts). */
  source: 'record' | 'release' | 'result' | 'manual' | 'runner' | 'transcript';
  /** The process harness that reported it (`work run`); absent for Claude workers. */
  harness?: string;
}

interface UsageEventData { key: string; scope: 'lease' | 'session'; leaseId?: string; role?: string; attempt?: number; session?: string; tokens: number; model: string | null; source: string; harness?: string; components?: UsageComponents }

function checkTokens(tokens: number): void {
  if (!Number.isInteger(tokens) || tokens < 0) throw new MinionsError('PRECONDITION', `Usage must be a whole, non-negative number of tokens (got ${tokens}).`);
}

/** Stores a worker's cumulative token total for a lease (any status); the latest figure per lease counts. */
export function recordLeaseUsage(db: RuntimeDb, leaseId: string, u: UsageInput): UsageEventData {
  checkTokens(u.tokens);
  const lease = db.lease(leaseId);
  if (!lease) throw new MinionsError('NOT_FOUND', `Lease ${leaseId} does not exist.`);
  const data: UsageEventData = { key: `lease:${leaseId}`, scope: 'lease', leaseId, role: lease.role, attempt: lease.attempt, tokens: u.tokens, model: u.model ?? null, source: u.source, ...(u.harness ? { harness: u.harness } : {}) };
  db.addEvent('usage', lease.task_id, data);
  return data;
}

/**
 * The latest usage figure stored for a lease, or null. Used by `record`/`release` to keep a measured figure
 * (runner, coordinator --usage, `work spend --lease`) from being replaced by a worker's self-reported block.
 */
export function latestLeaseUsage(db: RuntimeDb, leaseId: string): { tokens: number; model: string | null; source: string } | null {
  const lease = db.lease(leaseId);
  if (!lease) return null;
  const key = `lease:${leaseId}`;
  let found: UsageEventData | null = null;
  for (const r of db.all<{ data_json: string | null }>("SELECT data_json FROM events WHERE kind = 'usage' AND task_id = ? ORDER BY id", lease.task_id)) {
    try {
      const d = JSON.parse(r.data_json ?? 'null') as UsageEventData | null;
      if (d && d.key === key && typeof d.tokens === 'number') found = d;
    } catch { /* not a usage payload */ }
  }
  return found ? { tokens: found.tokens, model: found.model ?? null, source: found.source } : null;
}

/** Stores the coordinator session's own cumulative total; the latest figure per session counts. */
export function recordSessionUsage(db: RuntimeDb, session: string, u: UsageInput): UsageEventData {
  checkTokens(u.tokens);
  const data: UsageEventData = { key: `session:${session}`, scope: 'session', session, tokens: u.tokens, model: u.model ?? null, source: u.source };
  db.addEvent('usage', null, data);
  return data;
}

/** Tokens from a WorkerResult usage block (fallback when the coordinator passed no --usage). */
export function tokensFromResultUsage(u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; totalTokens?: number } | undefined): number | null {
  if (!u) return null;
  if (u.totalTokens !== undefined) return u.totalTokens;
  const parts = [u.inputTokens, u.outputTokens, u.cacheReadTokens].filter((n): n is number => n !== undefined);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

// ---------------------------------------------------------------- tally

interface UsageRow { id: number; at: string; taskId: string | null; data: UsageEventData }

function usageRows(db: RuntimeDb): UsageRow[] {
  const out: UsageRow[] = [];
  for (const r of db.all<{ id: number; at: string; task_id: string | null; data_json: string | null }>("SELECT id, at, task_id, data_json FROM events WHERE kind = 'usage' ORDER BY id")) {
    try {
      const d = JSON.parse(r.data_json ?? 'null') as UsageEventData | null;
      if (d && typeof d.key === 'string' && typeof d.tokens === 'number') out.push({ id: r.id, at: r.at, taskId: r.task_id, data: d });
    } catch { /* not a usage payload */ }
  }
  return out;
}

interface KeyTally { key: string; scope: 'lease' | 'session'; taskId: string | null; tokens: number; model: string | null; components?: UsageComponents }

const COMPONENT_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
const isComponents = (c: unknown): c is UsageComponents => typeof c === 'object' && c !== null && COMPONENT_KEYS.every((k) => typeof (c as Record<string, unknown>)[k] === 'number');

/**
 * Per lease/session: the latest cumulative figure minus the last figure recorded before `since` (all of
 * it without `since`). A session figure set by hand (`work spend --session --tokens`, source manual) is an
 * override: once a session key has one, its measured (transcript) figures no longer count, so the two are
 * never added up.
 */
function tally(rows: UsageRow[], since?: string): KeyTally[] {
  const overridden = new Set(rows.filter((r) => r.data.scope === 'session' && r.data.source === 'manual').map((r) => r.data.key));
  const latest = new Map<string, UsageRow>();
  const before = new Map<string, UsageRow>();
  for (const r of rows) {
    if (overridden.has(r.data.key) && r.data.source === 'transcript') continue;
    latest.set(r.data.key, r);
    if (since && r.at < since) before.set(r.data.key, r);
  }
  return [...latest.values()].map((r) => {
    const b = before.get(r.data.key);
    const c = r.data.components;
    const bc = b?.data.components;
    const components = isComponents(c) && (!b || isComponents(bc))
      ? Object.fromEntries(COMPONENT_KEYS.map((k) => [k, Math.max(0, c[k] - (bc ? bc[k] : 0))])) as unknown as UsageComponents : undefined;
    return {
      key: r.data.key, scope: r.data.scope, taskId: r.taskId,
      tokens: Math.max(0, r.data.tokens - (b?.data.tokens ?? 0)), model: r.data.model, ...(components ? { components } : {}),
    };
  });
}

export interface SpendFigures { tokens: number; attempts: number; estimatedUsd?: number }

function figures(entries: KeyTally[], attempts: number, billing: Billing, fallbackModel: string | null): SpendFigures {
  const tokens = entries.reduce((a, e) => a + e.tokens, 0);
  if (billing !== 'api-key') return { tokens, attempts };
  let usd = 0;
  // Measured figures (components known) are weighted: cache read 0.1x, cache write 1.25x, output 5x the input rate.
  for (const e of entries) usd += (e.components ? weightedMTok(e.components) : e.tokens / 1e6) * (usdPerMTok(e.model) ?? usdPerMTok(fallbackModel) ?? 0);
  return { tokens, attempts, estimatedUsd: Math.round(usd * 100) / 100 };
}

const attemptsSince = (db: RuntimeDb, since?: string, taskId?: string): number => {
  const where: string[] = []; const p: string[] = [];
  if (since) { where.push('started_at >= ?'); p.push(since); }
  if (taskId) { where.push('task_id = ?'); p.push(taskId); }
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM leases ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, ...p)!.n;
};

export const utcDayStart = (now: Date) => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

export interface BudgetStatus {
  limit: number; unit: BudgetUnit; period: BudgetPeriod; text: string; setAt: string; setBy: string | null;
  /** Start of the window the budget counts (setAt, or the UTC day start). */
  windowStart: string;
  used: number; remaining: number; percent: number;
  /** Highest of 50/80/100 reached in this window (null below 50%). */
  threshold: number | null;
  exhausted: boolean;
}

export interface SpendReport {
  billing: Billing;
  total: SpendFigures;
  /** Since the UTC day start. */
  today: SpendFigures & { since: string };
  perTask: ({ taskId: string } & SpendFigures)[];
  /** The coordinator sessions' own totals: measured from the transcript by the Stop hook, or set by hand. */
  coordinator: SpendFigures & { baseline: CoordinatorBaseline };
  budget: BudgetStatus | null;
  /** Shortcut for budget.percent (null without a budget). */
  percent: number | null;
  notes: string[];
}

/**
 * Measured coordinator baseline (task-57.1, docs/design/coordinator-sessions.md "Step 1"): the numbers the
 * cost model needs. From the Stop hook's per-session states (meta `coordinator_usage:<session_id>`).
 */
export interface CoordinatorBaseline {
  /** Start of the first measured session (null: nothing measured yet). */
  since: string | null;
  sessions: number;
  /** Sessions still running (not yet ended). */
  open: number;
  /** Ended sessions by what ended them: context-reset (self-restart), restart (upgrade, settings, sync), exit (no restart recorded). */
  endedBy: Partial<Record<SessionEndTrigger, number>>;
  /** Context resets by the reset trigger that held (delivered, context, handoffs, requested). */
  resetTriggers: Record<string, number>;
  tokens: number;
  components: UsageComponents;
  turns: { total: number; perSession: number | null };
  contextPerTurn: { mean: number | null; max: number };
  ownerMessages: number;
  /** Distinct tasks delivered (or done) since `since`. */
  deliveredTasks: number;
  tokensPerDeliveredTask: number | null;
  tokensPerOwnerMessage: number | null;
  /** Tokens recovered sessions spent before their first claim or Telegram reply. */
  resetOverhead: { recoveredSessions: number; tokens: number; perRecovery: number | null };
  /** Measured coordinator tokens / all tokens since `since` (0..1; null when nothing is counted). */
  share: number | null;
  /** API-key billing: USD with the components weighted (cache read 0.1x, cache write 1.25x, output 5x). */
  estimatedUsd?: number;
  /** API-key billing: the coordinator's share of the estimated USD since `since`. */
  usdShare?: number | null;
  model: string | null;
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round(a / b) : null);

function deliveredSince(db: RuntimeDb, since: string): number {
  const ids = new Set<string>();
  for (const r of db.all<{ task_id: string | null; data_json: string | null }>("SELECT task_id, data_json FROM events WHERE kind = 'record' AND at >= ?", since)) {
    try {
      const d = JSON.parse(r.data_json ?? 'null') as { to?: string; leaseId?: string } | null;
      if (d && (d.to === 'delivered' || d.to === 'done')) ids.add(r.task_id ?? d.leaseId ?? '?');
    } catch { /* unreadable record */ }
  }
  return ids.size;
}

export function coordinatorBaseline(ctx: { db: RuntimeDb; billing: Billing; fallbackModel: string | null; rows: UsageRow[]; states?: CoordinatorSessionState[] }): CoordinatorBaseline {
  const states = ctx.states ?? sessionStates(ctx.db);
  const since = states[0]?.firstAt ?? null;
  const components: UsageComponents = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const endedBy: Partial<Record<SessionEndTrigger, number>> = {};
  const resetTriggers: Record<string, number> = {};
  let turns = 0; let contextSum = 0; let maxContext = 0; let ownerMessages = 0; let recovered = 0; let overhead = 0; let usd = 0;
  for (const s of states) {
    for (const k of COMPONENT_KEYS) components[k] += s.components[k];
    turns += s.turns; contextSum += s.contextSum; maxContext = Math.max(maxContext, s.maxContext); ownerMessages += s.ownerMessages;
    if (s.recovered) { recovered++; overhead += s.overhead; }
    if (s.ended) {
      endedBy[s.ended.trigger] = (endedBy[s.ended.trigger] ?? 0) + 1;
      if (s.ended.trigger === 'context-reset') for (const t of (s.ended.detail ?? 'requested').split(',')) resetTriggers[t] = (resetTriggers[t] ?? 0) + 1;
    }
    usd += weightedMTok(s.components) * (usdPerMTok(s.model) ?? usdPerMTok(ctx.fallbackModel) ?? 0);
  }
  const tokens = totalOf(components);
  const delivered = since ? deliveredSince(ctx.db, since) : 0;
  let share: number | null = null;
  let usdShare: number | null = null;
  if (since) {
    const all = figures(tally(ctx.rows, since), 0, 'api-key', ctx.fallbackModel);
    share = all.tokens > 0 ? Math.round((Math.min(tokens, all.tokens) / all.tokens) * 1000) / 1000 : null;
    usdShare = all.estimatedUsd ? Math.round((Math.min(usd, all.estimatedUsd) / all.estimatedUsd) * 1000) / 1000 : null;
  }
  return {
    since, sessions: states.length, open: states.filter((s) => !s.ended).length, endedBy, resetTriggers,
    tokens, components,
    turns: { total: turns, perSession: states.length ? Math.round((turns / states.length) * 10) / 10 : null },
    contextPerTurn: { mean: ratio(contextSum, turns), max: maxContext },
    ownerMessages, deliveredTasks: delivered,
    tokensPerDeliveredTask: ratio(tokens, delivered), tokensPerOwnerMessage: ratio(tokens, ownerMessages),
    resetOverhead: { recoveredSessions: recovered, tokens: overhead, perRecovery: ratio(overhead, recovered) },
    share,
    ...(ctx.billing === 'api-key' ? { estimatedUsd: Math.round(usd * 100) / 100, usdShare } : {}),
    model: [...states].reverse().find((s) => s.model)?.model ?? null,
  };
}

export interface SpendContext { db: RuntimeDb; billing?: Billing; config?: Pick<MinionsConfig, 'models'>; now?: Date }

export function readBudget(db: RuntimeDb): Budget | null {
  const v = db.getControl('budget');
  if (!v) return null;
  try { return JSON.parse(v) as Budget; } catch { return null; }
}

function budgetStatus(ctx: SpendContext, b: Budget, rows: UsageRow[]): BudgetStatus {
  const now = ctx.now ?? new Date();
  const windowStart = b.period === 'day' ? utcDayStart(now) : b.setAt;
  let used: number;
  if (b.unit === 'attempts') used = attemptsSince(ctx.db, windowStart);
  else {
    const f = figures(tally(rows, windowStart), 0, 'api-key', ctx.config?.models.default ?? null);
    used = b.unit === 'usd' ? f.estimatedUsd ?? 0 : f.tokens;
  }
  const percent = Math.round((used / b.limit) * 1000) / 10;
  const threshold = [...THRESHOLDS].reverse().find((t) => percent >= t) ?? null;
  return {
    limit: b.limit, unit: b.unit, period: b.period, text: b.text, setAt: b.setAt, setBy: b.setBy, windowStart,
    used, remaining: Math.max(0, Math.round((b.limit - used) * 100) / 100), percent, threshold, exhausted: used >= b.limit,
  };
}

export function currentBudget(ctx: SpendContext): BudgetStatus | null {
  const b = readBudget(ctx.db);
  return b ? budgetStatus(ctx, b, usageRows(ctx.db)) : null;
}

/** The spend block of `minions status --json` (and `minions work spend`). */
export function spendReport(ctx: SpendContext): SpendReport {
  const now = ctx.now ?? new Date();
  const billing = ctx.billing ?? billingOf();
  const fallback = ctx.config?.models.default ?? null;
  const rows = usageRows(ctx.db);
  const all = tally(rows);
  const day = utcDayStart(now);
  const taskIds = [...new Set([
    ...all.filter((e) => e.scope === 'lease' && e.taskId).map((e) => e.taskId!),
    ...ctx.db.all<{ task_id: string }>('SELECT DISTINCT task_id FROM leases').map((r) => r.task_id),
  ])].sort();
  const perTask = taskIds.map((taskId) => ({ taskId, ...figures(all.filter((e) => e.scope === 'lease' && e.taskId === taskId), attemptsSince(ctx.db, undefined, taskId), billing, fallback) }));
  const b = readBudget(ctx.db);
  const budget = b ? budgetStatus(ctx, b, rows) : null;
  const notes = [billing === 'api-key' ? ESTIMATE_NOTE : SUBSCRIPTION_NOTE,
    'Worker tokens come from the coordinator (task-notification totals passed with --usage); coordinator tokens are measured from its transcript by the Stop hook (`work spend --session --tokens` overrides a session). Spend not reported is not counted.'];
  return {
    billing,
    total: figures(all, attemptsSince(ctx.db), billing, fallback),
    today: { ...figures(tally(rows, day), attemptsSince(ctx.db, day), billing, fallback), since: day },
    perTask: perTask.filter((t) => t.tokens > 0 || t.attempts > 0),
    coordinator: { ...figures(all.filter((e) => e.scope === 'session'), 0, billing, fallback), baseline: coordinatorBaseline({ db: ctx.db, billing, fallbackModel: ctx.config?.models.coordinator ?? fallback, rows }) },
    budget, percent: budget?.percent ?? null, notes,
  };
}

// ---------------------------------------------------------------- budget control

export function setBudget(ctx: SpendContext, text: string, setBy: string | null = null): BudgetStatus | null {
  const parsed = parseBudget(text);
  const billing = ctx.billing ?? billingOf();
  if (!parsed) {
    ctx.db.transaction(() => {
      ctx.db.exec("DELETE FROM controls WHERE key = 'budget'");
      ctx.db.addEvent('budget', null, { cleared: true, by: setBy });
    });
    return null;
  }
  if (parsed.unit === 'usd' && billing !== 'api-key') {
    throw new MinionsError('PRECONDITION', 'A USD budget needs API-key billing; this runtime uses a Claude subscription login.',
      'Give the budget in tokens or attempts (e.g. "5M tokens", "20 attempts"); the remaining plan quota is not visible to minions.');
  }
  const b: Budget = { ...parsed, text: String(text).trim(), setAt: (ctx.now ?? new Date()).toISOString(), setBy };
  ctx.db.transaction(() => {
    ctx.db.setControl('budget', JSON.stringify(b));
    ctx.db.addEvent('budget', null, b);
  });
  return currentBudget(ctx);
}

const fmt = (n: number, unit: BudgetUnit) => unit === 'usd' ? `$${n.toFixed(2)} (estimated)` : unit === 'attempts' ? `${n} attempt(s)` : `${n.toLocaleString('en-US')} tokens`;
const windowText = (s: BudgetStatus) => s.period === 'day' ? 'today (UTC)' : `since ${s.setAt}`;

export function describeBudget(s: BudgetStatus): string {
  return `${fmt(s.used, s.unit)} of ${fmt(s.limit, s.unit)} ${windowText(s)} (${s.percent}%; budget "${s.text}")`;
}

/** Refuses a new claim when the budget is used up. Running leases are never touched. */
export function assertBudgetAllowsStart(ctx: SpendContext): void {
  const s = currentBudget(ctx);
  if (!s?.exhausted) return;
  throw new MinionsError('POLICY_DENIED', `Budget reached: ${describeBudget(s)}. New starts are refused; running workers continue.`,
    'Record returning workers and report to the owner; starts resume when the owner raises the budget (`minions work spend --budget "<amount>"`) or clears it (`--budget off`).',
    { budget: s });
}

export interface BudgetNotice extends BudgetStatus {
  /** A threshold (50/80/100) newly reached by this record: report it to the owner. */
  crossed: number | null;
  message: string;
}

/**
 * After usage is recorded: the budget state, with `crossed` set when a threshold is reached for the
 * first time in the current window (each is reported once). Null without a budget.
 */
export function budgetNotice(ctx: SpendContext): BudgetNotice | null {
  const b = readBudget(ctx.db);
  if (!b) return null;
  const s = budgetStatus(ctx, b, usageRows(ctx.db));
  const window = s.windowStart;
  const already = b.notified && b.notified.window === window ? b.notified.threshold : 0;
  const crossed = s.threshold !== null && s.threshold > already ? s.threshold : null;
  if (crossed !== null) ctx.db.setControl('budget', JSON.stringify({ ...b, notified: { threshold: crossed, window } }));
  const message = s.exhausted
    ? `Budget reached: ${describeBudget(s)}. New claims are refused; running workers continue. Tell the owner why starts stopped.`
    : crossed !== null ? `Budget ${crossed}% reached: ${describeBudget(s)}. Tell the owner.`
      : `Budget: ${describeBudget(s)}.`;
  return { ...s, crossed, message };
}

export function humanSpend(r: SpendReport): string {
  const usd = (f: SpendFigures) => (f.estimatedUsd !== undefined ? `, ~$${f.estimatedUsd.toFixed(2)} est.` : '');
  const tok = (f: SpendFigures) => `${f.tokens.toLocaleString('en-US')} tokens${usd(f)}, ${f.attempts} attempt(s)`;
  const c = r.coordinator;
  return [
    `spend (${r.billing}): total ${tok(r.total)}; today ${tok(r.today)}`,
    `coordinator: ${c.tokens.toLocaleString('en-US')} tokens${usd(c)}; workers: ${Math.max(0, r.total.tokens - c.tokens).toLocaleString('en-US')} tokens`,
    r.budget ? `budget: ${describeBudget(r.budget)}${r.budget.exhausted ? ' - new starts refused' : ''}` : 'budget: none',
  ].join('\n');
}

const k = (n: number | null) => (n === null ? '-' : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US'));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${Math.round(n * 1000) / 10}%`);

/** The baseline in a few lines (`work spend`; `status` shows only the coordinator total). */
export function humanBaseline(b: CoordinatorBaseline): string {
  if (!b.sessions) return 'coordinator baseline: no session measured yet (the Stop hook records it after each coordinator turn)';
  const ended = Object.entries(b.endedBy).map(([t, n]) => `${t} ${n}`).join(', ') || 'none';
  const resets = Object.entries(b.resetTriggers).map(([t, n]) => `${t} ${n}`).join(', ');
  return [
    `coordinator baseline since ${b.since}: ${b.sessions} session(s) (${b.open} open; ended: ${ended}${resets ? `; resets by trigger: ${resets}` : ''}), ${b.turns.total} turns (${b.turns.perSession ?? '-'}/session)`,
    `  context/turn mean ${k(b.contextPerTurn.mean)}, max ${k(b.contextPerTurn.max)}; tokens/delivered task ${k(b.tokensPerDeliveredTask)} (${b.deliveredTasks} delivered); tokens/owner message ${k(b.tokensPerOwnerMessage)} (${b.ownerMessages})`,
    `  reset overhead ${k(b.resetOverhead.perRecovery)}/recovery (${b.resetOverhead.recoveredSessions} recovered); coordinator share ${pct(b.share)} of tokens${b.estimatedUsd !== undefined ? `, ~$${b.estimatedUsd.toFixed(2)} weighted est. (${pct(b.usdShare)} of USD)` : ''}`,
  ].join('\n');
}
