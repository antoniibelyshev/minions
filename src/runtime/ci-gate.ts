// CI evidence gate (verification.ciAuthority "github"; decision record: docs/design/bootstrap.md,
// "CI as verification authority").
//
// One question, asked by every consumer the same way: do the base branch's *required* checks pass for
// exactly this head? Consumers: tester/reviewer stages (src/runtime/scheduler.ts record/claim), and the
// merge gate (task-1.9 reuses `evaluateCiGate` / `Scheduler.ciGate` for the approved head).
//
// Fail closed. Evidence is only:
// - required checks read from branch protection / rulesets through read-only GET calls
//   (src/runtime/ci.ts requiredChecksStatus); unreadable (either source), or none configured ->
//   `unknown`, never "zero required checks". A check pinned to a GitHub App (protection app_id /
//   ruleset integration_id) counts only from a check run of that app; unpinned checks match by name;
// - `minions sync` observations (evidence kind `ci`) recorded for the exact head SHA; an observation of
//   another head never counts, and neither does a worker's own claim about CI.
// Anything other than every required check passing (`pass`) is not approval: `fail`, `pending`
// (within verification.ciPendingTimeoutMinutes of the first observation of the head), `timeout`,
// `missing` (no observation of this head), `unknown` (required checks unreadable / none configured /
// an observation without per-check results / a skipped required check / a pinned check whose app
// could not be read), `disabled` (ciAuthority none).
import type { MinionsConfig } from '../config/schema.js';
import type { EvidenceRow, RuntimeDb } from './db.js';
import type { CheckState, CiSummary, RequiredCheck, RequiredChecksReport } from './ci.js';

export type CiGateState = 'pass' | 'fail' | 'pending' | 'timeout' | 'missing' | 'unknown' | 'disabled';

export interface CiGate {
  state: CiGateState;
  /** The head the decision is bound to. */
  head: string;
  requiredChecks: string[];
  passed: string[];
  failed: string[];
  pending: string[];
  /** Latest / first `minions sync` observation of this head (ISO), null when none. */
  observedAt: string | null;
  firstObservedAt: string | null;
  timeoutMinutes: number;
  /** Human-readable reasons; empty only for `pass`. */
  reasons: string[];
}

export const DEFAULT_CI_PENDING_TIMEOUT_MINUTES = 60;

export const ciTimeoutOf = (cfg: Pick<MinionsConfig, 'verification'>): number =>
  cfg.verification.ciPendingTimeoutMinutes ?? DEFAULT_CI_PENDING_TIMEOUT_MINUTES;

export interface CiGateInput {
  ciAuthority: MinionsConfig['verification']['ciAuthority'];
  head: string;
  /** Required checks of the base branch; null = could not be read. */
  required: RequiredChecksReport | null;
  /** `ci` evidence rows recorded for this task (any head; only rows for `head` are used). */
  observations: Pick<EvidenceRow, 'head_sha' | 'details_json' | 'recorded_at'>[];
  now: Date;
  timeoutMinutes: number;
}

const rank: Record<CheckState, number> = { fail: 3, pending: 2, skipped: 1, pass: 0 };

/** Pure decision: never approves on missing, failing, unknown or pending-too-long CI. */
export function evaluateCiGate(i: CiGateInput): CiGate {
  const rows = i.observations.filter((o) => o.head_sha === i.head).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const g: CiGate = {
    state: 'unknown', head: i.head, requiredChecks: [], passed: [], failed: [], pending: [],
    observedAt: rows.at(-1)?.recorded_at ?? null, firstObservedAt: rows[0]?.recorded_at ?? null, timeoutMinutes: i.timeoutMinutes, reasons: [],
  };
  const out = (state: CiGateState, reason?: string): CiGate => ({ ...g, state, reasons: reason ? [...g.reasons, reason] : g.reasons });
  if (i.ciAuthority !== 'github') return out('disabled', 'verification.ciAuthority is "none": CI is not a verification authority');
  if (!i.required || i.required.state === 'unknown') {
    return out('unknown', `required checks could not be read${i.required?.errors.length ? ` (${i.required.errors.join('; ')})` : ''}: not evidence`);
  }
  if (i.required.state !== 'configured' || !i.required.requiredChecks.length) {
    return out('unknown', `no required status checks on ${i.required.baseBranch}: never treated as zero required checks`);
  }
  g.requiredChecks = [...i.required.requiredChecks];
  const last = rows.at(-1);
  if (!last) return out('missing', `no CI observation for head ${i.head} (open the PR at this head, then run \`minions sync\`)`);
  let checks: CiSummary['checks'] | undefined;
  try { checks = (JSON.parse(last.details_json ?? 'null') as { ci?: { checks?: CiSummary['checks'] } } | null)?.ci?.checks; } catch { checks = undefined; }
  if (!Array.isArray(checks)) return out('unknown', 'the CI observation has no per-check results (re-run `minions sync`)');

  const skipped: string[] = [];
  const unverified: string[] = [];
  // Requirements with their app pin; reports without `requirements` fall back to name-only matching.
  const reqs: RequiredCheck[] = i.required.requirements?.length
    ? i.required.requirements : g.requiredChecks.map((context) => ({ context, appId: null }));
  const verdict = new Map<string, CheckState | 'unverified'>();
  const order = ['pass', 'skipped', 'pending', 'unverified', 'fail'] as const;
  for (const q of reqs) {
    const named = checks.filter((c) => c?.name === q.context);
    let v: CheckState | 'unverified';
    if (q.appId === null) {
      // Name-only (residual: GitHub accepts any source for an unpinned check). Worst run of the name counts.
      const states = named.map((c) => c.state);
      v = states.length ? states.reduce((a, b) => (rank[b] > rank[a] ? b : a)) : 'pending';
    } else {
      // Pinned: only check runs reported by that app count; statuses and other apps are ignored.
      const states = named.filter((c) => c.source === 'check-run' && c.appId === q.appId).map((c) => c.state);
      if (states.length) v = states.reduce((a, b) => (rank[b] > rank[a] ? b : a));
      // A check run of that name whose app is unknown (rollup without apps) cannot be attributed.
      else v = named.some((c) => c.source !== 'status' && typeof c.appId !== 'number') ? 'unverified' : 'pending';
    }
    const prev = verdict.get(q.context);
    if (!prev || order.indexOf(v) > order.indexOf(prev)) verdict.set(q.context, v);
  }
  for (const name of g.requiredChecks) {
    const v = verdict.get(name) ?? 'pending';
    if (v === 'pass') g.passed.push(name);
    else if (v === 'fail') g.failed.push(name);
    else if (v === 'skipped') skipped.push(name);
    else if (v === 'unverified') unverified.push(name);
    else g.pending.push(name);
  }
  if (g.failed.length) return out('fail', `required checks failing at ${i.head.slice(0, 12)}: ${g.failed.join(', ')}`);
  if (unverified.length) {
    const apps = reqs.filter((q) => q.appId !== null && unverified.includes(q.context)).map((q) => `${q.context} (app ${q.appId})`);
    return out('unknown', `required checks pinned to an app could not be attributed at ${i.head.slice(0, 12)}: ${apps.join(', ')} (check-run apps unreadable; re-run \`minions sync\`)`);
  }
  if (skipped.length) return out('unknown', `required checks skipped at ${i.head.slice(0, 12)}: ${skipped.join(', ')} (a skipped check is not evidence)`);
  if (g.pending.length) {
    const since = Date.parse(g.firstObservedAt!);
    const waited = (i.now.getTime() - since) / 60_000;
    if (!Number.isFinite(waited) || waited > i.timeoutMinutes) {
      return out('timeout', `required checks still pending after ${Number.isFinite(waited) ? Math.floor(waited) : '?'} min (limit ${i.timeoutMinutes}): ${g.pending.join(', ')}`);
    }
    return out('pending', `required checks pending at ${i.head.slice(0, 12)}: ${g.pending.join(', ')} (timeout in ${Math.max(0, Math.ceil(i.timeoutMinutes - waited))} min; run \`minions sync\` later)`);
  }
  return { ...g, state: 'pass', reasons: [] };
}

/** Gate for a task head from the runtime DB (`ci` evidence written by `minions sync`). */
export function ciGateFromDb(db: RuntimeDb, cfg: Pick<MinionsConfig, 'verification'>, taskId: string, head: string, required: RequiredChecksReport | null, now = new Date()): CiGate {
  return evaluateCiGate({
    ciAuthority: cfg.verification.ciAuthority, head, required, now, timeoutMinutes: ciTimeoutOf(cfg),
    observations: db.evidenceFor(taskId, head, 'ci'),
  });
}

export function formatCiGate(g: CiGate): string {
  if (g.state === 'pass') return `CI gate pass at ${g.head.slice(0, 12)}: required ${g.requiredChecks.join(', ')}`;
  return `CI gate ${g.state} at ${g.head.slice(0, 12)}: ${g.reasons.join('; ')}`;
}
