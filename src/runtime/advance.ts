// The decision table after a recorded result (docs/design/autonomy.md Decision 1): when the autopilot dispatcher may
// move the task on by itself, and when it holds the task for the coordinator's judgement.
import type { RecordResponse, Scheduler } from './scheduler.js';

/** Why the dispatcher holds a task after a record (handled by the coordinator, see the orchestrate skill). */
export type RecordDecisionKind =
  /** The result was rejected (`correctionAllowed`: one automatic correction) or stored unvalidated after the correction. */
  | 'invalid'
  /** A drain partial: the stage stays runnable once the drain ends. */
  | 'draining'
  /** The repair-cycle limit was reached: rethink the task. */
  | 'replan'
  /** The worker reported needs_split: create the children. */
  | 'needs-split'
  /** A producer reported needs_changes: the task returned for re-planning. */
  | 'needs-changes'
  /** The task waits for the owner (e.g. a host-signed merge approval). */
  | 'awaiting-human'
  /** The local integration was queued or did not complete: report it (retry with `work publish`). */
  | 'publication'
  /** The worker reported blocked. */
  | 'blocked'
  /** A partial result (not a drain): re-dispatch with the remaining work, or split. */
  | 'partial'
  /** A QA sweep returned findings: create one backlog task per finding. */
  | 'qa-findings';

export interface RecordDecision {
  kind: RecordDecisionKind;
  /** One line on why (the record message). */
  message: string;
  taskId?: string;
  errors?: string[]; correctionAllowed?: boolean; unvalidated?: boolean;
  findings?: number;
}

/** The worker result fields read back after a valid record. */
interface StoredResult { status?: string; findings?: unknown[] }

/** The decision a recorded result needs from the coordinator, or null when the task moves on by itself. */
export function recordDecision(sched: Scheduler, r: RecordResponse, worker: StoredResult): RecordDecision | null {
  const at = { taskId: r.taskId, message: r.message };
  if (!r.valid) {
    return { kind: 'invalid', ...at, errors: r.errors ?? [], correctionAllowed: !!r.correctionAllowed, ...(r.unvalidated ? { unvalidated: true } : {}) };
  }
  if (r.drain) return { kind: 'draining', ...at };
  if (r.replan) return { kind: 'replan', ...at };
  if (r.needsSplit) return { kind: 'needs-split', ...at };
  const pub = r.publication;
  if (pub && pub.state !== 'published') return { kind: pub.state === 'awaiting-approval' ? 'awaiting-human' : 'publication', ...at };
  if (r.to === 'blocked') return { kind: 'blocked', ...at };
  if (r.to === 'awaiting-human') return { kind: 'awaiting-human', ...at };
  const lease = sched.db.lease(r.leaseId);
  const sweep = !!lease && sched.isSweepLease(lease);
  if (worker.status === 'partial') return { kind: 'partial', ...at };
  if (worker.status === 'needs_changes' && !sweep && r.to !== 'changes-requested') return { kind: 'needs-changes', ...at };
  if (sweep && (worker.findings?.length ?? 0) > 0) return { kind: 'qa-findings', ...at, findings: worker.findings!.length };
  return null;
}
