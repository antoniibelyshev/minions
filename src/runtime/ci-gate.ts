// CI evidence gate (verification.ciAuthority "github"; decision record: docs/design/bootstrap.md,
// "CI as verification authority").
//
// One question, asked by every consumer the same way: do the base branch's *required* checks pass for
// exactly this head? Consumers: tester/reviewer stages (src/runtime/scheduler.ts record/claim), and the
// merge gate (task-1.9 reuses `evaluateCiGate` / `Scheduler.ciGate` for the approved head).
//
// Fail closed. Evidence is only:
// - required checks read from branch protection / rulesets through read-only GET calls
//   (src/runtime/ci.ts requiredChecksStatus); unreadable or none configured -> `unknown`, never "zero
//   required checks";
// - `minions sync` observations (evidence kind `ci`) recorded for the exact head SHA; an observation of
//   another head never counts, and neither does a worker's own claim about CI.
// Anything other than every required check passing (`pass`) is not approval: `fail`, `pending`
// (within verification.ciPendingTimeoutMinutes of the first observation of the head), `timeout`,
// `missing` (no observation of this head), `unknown` (required checks unreadable / none configured /
// an observation without per-check results / a skipped required check), `disabled` (ciAuthority none).
import type { MinionsConfig } from '../config/schema.js';
import type { EvidenceRow, RuntimeDb } from './db.js';
import type { CheckState, CiSummary, RequiredChecksReport } from './ci.js';

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
  for (const name of g.requiredChecks) {
    const states = checks.filter((c) => c?.name === name).map((c) => c.state);
    // Not reported yet = expected (pending); several runs of one name: the worst one counts.
    const worst = states.length ? states.reduce((a, b) => (rank[b] > rank[a] ? b : a)) : 'pending';
    if (worst === 'pass') g.passed.push(name);
    else if (worst === 'fail') g.failed.push(name);
    else if (worst === 'skipped') skipped.push(name);
    else g.pending.push(name);
  }
  if (g.failed.length) return out('fail', `required checks failing at ${i.head.slice(0, 12)}: ${g.failed.join(', ')}`);
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
