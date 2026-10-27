import type { MinionsConfig } from '../config/schema.js';
import type { Launch } from '../config/launch.js';
import { MinionsError } from '../core/errors.js';
import { withContextReset } from './context-reset.js';
import type { RuntimeDb } from './db.js';
import { claimWithBrief, compactClaim, recordSubmitted, type CompactClaim, type HandoffPaths } from './handoff.js';
import type { NextReport, NextStage, RecordResponse, Scheduler, UsageFlag } from './scheduler.js';

/**
 * `minions work advance <leaseId>` (docs/design/unattended-delivery.md, Phases item 6): one coordinator call per
 * stage hand-off instead of record → spend → next → claim. It records the submitted result exactly as
 * `work record --submitted` (recordSubmitted), then, when nothing needs the coordinator's judgement, claims the
 * next runnable stage exactly as `work claim --compact` (claimWithBrief), picked from `work next` (Scheduler.next):
 * the same task's next stage first, else the first runnable stage overall. All checks stay in those functions;
 * this module only decides whether to claim, and never claims while paused, draining, over budget, after an
 * invalid result, or when a context reset is due.
 */

/** Why advance claimed nothing: the coordinator decides (see the orchestrate skill, step 6). */
export type AdvanceDecisionKind =
  /** The result was rejected (`correctionAllowed`: relay `errors` once) or stored unvalidated after the correction. */
  | 'invalid'
  /** A drain partial, or starts are paused for a drain: start nothing. */
  | 'draining'
  /** The repair-cycle limit was reached: rethink the task. */
  | 'replan'
  /** The worker reported needs_split: create the children. */
  | 'needs-split'
  /** A producer reported needs_changes: the task returned for re-planning. */
  | 'needs-changes'
  /** The task waits for the owner (e.g. a host-signed publication or merge approval). */
  | 'awaiting-human'
  /** Publication or merge did not complete (failed or pending): report it and retry `work publish`. */
  | 'publication'
  /** The worker reported blocked. */
  | 'blocked'
  /** A partial result (not a drain): re-dispatch with the remaining work, or split. */
  | 'partial'
  /** The stage relied on CI that is not usable: re-dispatch with local verification. */
  | 'ci-unverified'
  /** A QA sweep returned findings: create one backlog task per finding. */
  | 'qa-findings'
  /** A context reset is due: hand off and restart before dispatching more. */
  | 'context-reset'
  /** Starts are paused (paused_starts). */
  | 'paused'
  /** The owner budget is used up: new claims are refused. */
  | 'budget'
  /** Runnable stages exist but wait for capacity (task, role or harness limits). */
  | 'capacity'
  /** Nothing can start now. */
  | 'nothing-runnable'
  /** The claim of the picked stage was refused (CONFLICT, PRECONDITION, ...); `work next` again. */
  | 'claim-failed';

export interface AdvanceDecision {
  kind: AdvanceDecisionKind;
  /** One line on why (the record or next message, or the claim error). */
  message: string;
  taskId?: string;
  errors?: string[]; correctionAllowed?: boolean; unvalidated?: boolean;
  findings?: number;
  code?: string; hint?: string;
  waiting?: { taskId: string; role: string; waitingOn: string; why: string }[];
  stuck?: NextReport['stuck'];
  warnings?: string[];
}

/** The claimed next stage plus what the Agent call needs (or, with `launch.kind: "run"`, the runner command). */
export interface AdvanceNext extends CompactClaim {
  agentType: string;
  agentModel: string | null;
  suggestedModel: string;
  /** Present only for a process-harness stage (`kind: "run"`): run `launch.command` instead of the Agent tool. */
  launch?: Launch;
  reason: string;
}

export type AdvanceRecord = RecordResponse & { contextReset?: { due: true; reason: string; steps: string[] } };

export interface AdvanceResponse {
  record: AdvanceRecord;
  next?: AdvanceNext;
  decision?: AdvanceDecision;
  message: string;
}

export interface AdvanceDeps { db: RuntimeDb; config: MinionsConfig; state?: string }

/** The worker result fields advance reads back after a valid record. */
interface StoredResult { status?: string; findings?: unknown[] }

function storedResult(db: RuntimeDb, leaseId: string): StoredResult {
  try { return JSON.parse(db.lease(leaseId)?.result_json ?? '{}') as StoredResult; } catch { return {}; }
}

/** The decision a recorded result needs from the coordinator, or null when the next stage may be claimed. */
export function recordDecision(sched: Scheduler, r: AdvanceRecord, worker: StoredResult): AdvanceDecision | null {
  const at = { taskId: r.taskId, message: r.message };
  if (!r.valid) {
    return { kind: 'invalid', ...at, errors: r.errors ?? [], correctionAllowed: !!r.correctionAllowed, ...(r.unvalidated ? { unvalidated: true } : {}) };
  }
  if (r.drain) return { kind: 'draining', ...at };
  if (r.replan) return { kind: 'replan', ...at };
  if (r.needsSplit) return { kind: 'needs-split', ...at };
  const pub = r.publication;
  if (pub && pub.state !== 'published') return { kind: pub.state === 'awaiting-approval' ? 'awaiting-human' : 'publication', ...at };
  const merge = pub?.merge?.state;
  if (merge === 'awaiting-approval') return { kind: 'awaiting-human', ...at, message: pub!.merge!.reasons.join('; ') || r.message };
  if (merge === 'failed' || merge === 'denied') return { kind: 'publication', ...at, message: pub!.merge!.reasons.join('; ') || r.message };
  if (r.to === 'blocked') return { kind: 'blocked', ...at };
  if (r.to === 'awaiting-human') return { kind: 'awaiting-human', ...at };
  const lease = sched.db.lease(r.leaseId);
  const sweep = !!lease && sched.isSweepLease(lease);
  if (worker.status === 'partial') return { kind: 'partial', ...at };
  if (worker.status === 'needs_changes' && !sweep && r.to !== 'changes-requested') return { kind: 'needs-changes', ...at };
  if (r.ciBlocked === 'unverified') return { kind: 'ci-unverified', ...at };
  if (sweep && (worker.findings?.length ?? 0) > 0) return { kind: 'qa-findings', ...at, findings: worker.findings!.length };
  if (r.contextReset) return { kind: 'context-reset', ...at, message: r.contextReset.reason };
  return null;
}

/** Why `work next` lets nothing start, as a decision; null when a stage is runnable. */
export function nextDecision(db: RuntimeDb, n: NextReport): AdvanceDecision | null {
  const extra = { ...(n.stuck.length ? { stuck: n.stuck } : {}), ...(n.warnings?.length ? { warnings: n.warnings } : {}) };
  if (n.startsBlocked) {
    const kind: AdvanceDecisionKind = db.drain() ? 'draining' : db.paused().starts ? 'paused' : 'budget';
    return { kind, message: n.startsBlocked.message, code: n.startsBlocked.code, ...(n.startsBlocked.hint ? { hint: n.startsBlocked.hint } : {}), ...extra };
  }
  if (n.runnable.length) return null;
  const capped = n.waiting.filter((w) => w.waitingOn !== 'starts' && w.waitingOn !== 'requires');
  const waiting = n.waiting.map((w) => ({ taskId: w.taskId, role: w.role, waitingOn: w.waitingOn, why: w.why }));
  return { kind: capped.length ? 'capacity' : 'nothing-runnable', message: n.message, ...(waiting.length ? { waiting } : {}), ...extra };
}

/** The same task's next stage first (finish what is started), else `work next`'s dispatch order. */
export const pickStage = (n: NextReport, taskId: string): NextStage | undefined =>
  n.runnable.find((s) => s.taskId === taskId) ?? n.runnable[0];

const advanceNext = (c: CompactClaim, s: NextStage): AdvanceNext => ({
  ...c, agentType: s.agentType, agentModel: s.agentModel, suggestedModel: s.suggestedModel,
  ...(s.launch.kind === 'run' ? { launch: s.launch } : {}), reason: s.reason,
});

/** `minions work advance`: record the submitted result, then claim the next stage or return a decision. */
export async function advanceLease(sched: Scheduler, p: HandoffPaths, leaseId: string, opts: { correction?: boolean; usage?: UsageFlag }, deps: AdvanceDeps): Promise<AdvanceResponse> {
  const recorded = await recordSubmitted(sched, p, leaseId, opts);
  const record: AdvanceRecord = withContextReset(recorded, deps);
  const worker = record.valid ? storedResult(deps.db, leaseId) : {};
  const stop = (decision: AdvanceDecision): AdvanceResponse => ({ record, decision, message: `${record.message} Decide: ${decision.kind}.` });
  const early = recordDecision(sched, record, worker);
  if (early) return stop(early);
  let stage: NextStage | undefined;
  try {
    const report = await sched.next();
    const blocked = nextDecision(deps.db, report);
    if (blocked) return stop(blocked);
    stage = pickStage(report, record.taskId)!;
    const next = advanceNext(compactClaim(await claimWithBrief(sched, p, stage.taskId, stage.role)), stage);
    return { record, next, message: `${record.message} Next: ${next.taskId} ${next.role} (${next.leaseId}).` };
  } catch (e) {
    // The record already happened: never fail the whole call (and hide the recorded outcome) because the
    // follow-up step failed, whatever the error.
    const err = e as { code?: unknown; message?: unknown; hint?: unknown };
    const code = typeof err.code === 'string' ? err.code : 'INTERNAL';
    const message = typeof err.message === 'string' ? err.message : String(e);
    const kind: AdvanceDecisionKind = code === 'CAPACITY' ? 'capacity' : 'claim-failed';
    return stop({ kind, taskId: stage?.taskId ?? record.taskId, message, code, ...(e instanceof MinionsError && e.hint ? { hint: e.hint } : {}) });
  }
}

/** Human output of `work advance`. */
export function humanAdvance(r: AdvanceResponse): string {
  const lines = [r.record.message, ...(r.record.errors ?? []).map((e) => `  - ${e}`), ...(r.record.budget ? [r.record.budget.message] : [])];
  if (r.next) lines.push(`next: ${r.next.taskId} ${r.next.role} -> ${r.next.agentType}${r.next.agentModel ? ` (${r.next.agentModel})` : ''}`, r.next.briefMarker, `worktree: ${r.next.worktree}`);
  if (r.decision) lines.push(`decision: ${r.decision.kind}: ${r.decision.message}`);
  return lines.join('\n');
}
