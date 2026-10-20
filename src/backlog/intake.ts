import { MinionsError } from '../core/errors.js';
import type { Provenance } from './types.js';

// Intake pause (`minions pause --intake`): while it is set, `backlog create` refuses new work that enters
// from outside (owner requests, pasted tickets, agent ideas). Creation that comes from work already in the
// backlog stays allowed, so the coordinator can still finish splits, follow-ups and QA findings:
//   - a `--parent` is set (split children, sub-tasks of an existing task);
//   - the idempotency key starts with `split:`, `followup:` or `qa:` (QA sweep findings);
//   - provenance is `observed-result` (something a worker or check actually observed).
// A key starting with `intake:` is always intake (the intake skill's own keys), even with a parent.

export const INTERNAL_KEY_PREFIXES = ['split:', 'followup:', 'qa:'] as const;
export const INTAKE_KEY_PREFIX = 'intake:';
export const RESUME_INTAKE_HINT = 'Resume with `minions resume --intake` (or `minions resume` for both), then create the task again.';

export interface CreateOrigin { parent?: string | null; idempotencyKey: string; provenance?: Provenance }

/** True when this creation is new work from outside (subject to the intake pause). */
export function isIntakeCreation(o: CreateOrigin): boolean {
  if (o.idempotencyKey.startsWith(INTAKE_KEY_PREFIX)) return true;
  if (o.parent) return false;
  if (INTERNAL_KEY_PREFIXES.some((p) => o.idempotencyKey.startsWith(p))) return false;
  if (o.provenance === 'observed-result') return false;
  return true;
}

/** Throws POLICY_DENIED when intake is paused and `o` is intake-originated creation. */
export function assertIntakeOpen(o: CreateOrigin, intakePaused: boolean): void {
  if (!intakePaused || !isIntakeCreation(o)) return;
  throw new MinionsError('POLICY_DENIED',
    `Intake is paused: not creating "${o.idempotencyKey}". New tasks from requests or tickets are refused until intake is resumed.`,
    RESUME_INTAKE_HINT);
}
