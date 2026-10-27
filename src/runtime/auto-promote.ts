// Autonomous promotion limits (docs/design/unattended-delivery.md decision 8, phase 5, task-68.6).
//
// The coordinator's own ideas (provenance `agent-hypothesis`: QA findings, follow-ups, split children) start as
// `idea`. Moving such a task to `ready` (`backlog update --status ready`, or `backlog create --status ready`) is an
// auto-promotion, and the runtime refuses it when one of these holds, so a prompt mistake cannot exceed the caps:
//   - `routine.autoPromote.perDay` (default 3) auto-promotions were already recorded today (routine.timezone);
//   - the budget is at or above `routine.autoPromote.maxBudgetPercent` (default 80);
//   - the last owner message is more than `routine.autoPromote.ownerSilentDays` (default 3) days old, or unknown
//     (fail closed: only Telegram owner messages are counted, by the Stop hook);
//   - the task's parent (or the task itself) carries the label `needs-owner` (a design the owner has not agreed to).
// Not capped: `user-decision`, `external-requirement` and `observed-result` tasks, a task already `ready`, and a task
// that has had a lease (it goes back to ready after a stage, e.g. recover). Each allowed auto-promotion records an
// `auto-promote` event, which the digest lists (the owner vetoes with "cancel <id>" or "hold <id>").
//
// Owner override (`--owner-approved`): the owner asked for this task. Allowed only when the runtime saw an owner
// message in the last OWNER_ACTIVE_MINUTES, or on the terminal channel (the owner is at the session). It skips the
// caps and records an `owner-promote` event instead (not an auto-promotion, not counted).
import type { Provenance, Task, TaskStatus } from '../backlog/types.js';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { lastOwnerMessageAt } from './coordinator-usage.js';
import type { RuntimeDb } from './db.js';
import { AUTO_PROMOTE_EVENT } from './digest.js';
import { OWNER_ACTIVE_MINUTES, routineSettings } from './routine.js';
import { localDayStart } from './zoned-time.js';

export { AUTO_PROMOTE_EVENT };
export const OWNER_PROMOTE_EVENT = 'owner-promote';
export const AUTO_PROMOTE_REFUSED_EVENT = 'auto-promote-refused';
export const NEEDS_OWNER_LABEL = 'needs-owner';
export const AUTO_PROMOTE_DEFAULTS = { perDay: 3, maxBudgetPercent: 80, ownerSilentDays: 3 } as const;

export interface AutoPromoteSettings { perDay: number; maxBudgetPercent: number; ownerSilentDays: number; timezone: string }

/** Effective caps: every unset field takes its default (they apply whether or not the routine is enabled). */
export function autoPromoteSettings(cfg: Pick<MinionsConfig, 'routine'>): AutoPromoteSettings {
  const a = cfg.routine?.autoPromote ?? {};
  return {
    perDay: a.perDay ?? AUTO_PROMOTE_DEFAULTS.perDay,
    maxBudgetPercent: a.maxBudgetPercent ?? AUTO_PROMOTE_DEFAULTS.maxBudgetPercent,
    ownerSilentDays: a.ownerSilentDays ?? AUTO_PROMOTE_DEFAULTS.ownerSilentDays,
    timezone: routineSettings(cfg).timezone,
  };
}

/** A status change the backlog commands ask the guard about (task null: `backlog create`). */
export interface PromotionRequest {
  taskId: string | null;
  provenance: Provenance;
  from: TaskStatus | null;
  to: TaskStatus;
  labels: string[];
  parent: string | null;
  ownerApproved: boolean;
}

/** Whether this change is an auto-promotion the caps apply to. */
export function isCappedPromotion(r: Pick<PromotionRequest, 'provenance' | 'from' | 'to'>, everLeased: boolean): boolean {
  return r.provenance === 'agent-hypothesis' && r.to === 'ready' && r.from !== 'ready' && !everLeased;
}

export interface CapInputs {
  now: Date;
  settings: AutoPromoteSettings;
  promotedToday: number;
  /** Budget used in percent; null without a budget. */
  budgetPercent: number | null;
  lastOwnerMessageAt: string | null;
  /** Labels of the task itself and of its parent (null: no parent or unreadable). */
  taskLabels: string[];
  parent: { id: string; labels: string[] } | null;
}

/** Every cap that refuses the promotion (empty: allowed). Pure. */
export function capRefusals(i: CapInputs): string[] {
  const out: string[] = [];
  const s = i.settings;
  if (i.promotedToday >= s.perDay) {
    out.push(s.perDay === 0 ? 'auto-promotion is off (routine.autoPromote.perDay is 0)' : `the daily cap is reached: ${i.promotedToday} of ${s.perDay} auto-promotion(s) today (routine.autoPromote.perDay)`);
  }
  if (i.budgetPercent !== null && i.budgetPercent >= s.maxBudgetPercent) {
    out.push(`the budget is at ${i.budgetPercent}% (auto-promotion stops at ${s.maxBudgetPercent}%, routine.autoPromote.maxBudgetPercent)`);
  }
  if (!i.lastOwnerMessageAt) out.push('no owner message is on record (only Telegram owner messages are counted), so the owner may be away (routine.autoPromote.ownerSilentDays)');
  else {
    const days = (i.now.getTime() - Date.parse(i.lastOwnerMessageAt)) / 86_400_000;
    if (days > s.ownerSilentDays) out.push(`the owner has been silent for ${Math.floor(days)} day(s) (last message ${i.lastOwnerMessageAt}; limit ${s.ownerSilentDays}, routine.autoPromote.ownerSilentDays)`);
  }
  if (i.taskLabels.includes(NEEDS_OWNER_LABEL)) out.push(`the task carries the label ${NEEDS_OWNER_LABEL}: it waits for the owner`);
  if (i.parent?.labels.includes(NEEDS_OWNER_LABEL)) out.push(`its parent ${i.parent.id} carries the label ${NEEDS_OWNER_LABEL} (a design the owner has not agreed to): build children wait for the owner`);
  return out;
}

export interface GuardDeps {
  db: RuntimeDb;
  config: Pick<MinionsConfig, 'routine' | 'communication'>;
  getTask: (id: string) => Promise<Pick<Task, 'id' | 'labels'>>;
  budgetPercent: () => number | null;
  now?: () => Date;
}

/** A finished check: call `commit(taskId)` after the status change landed (records the event). */
export interface PromotionTicket { kind: 'auto' | 'owner'; commit: (taskId: string) => void }

const everLeased = (db: RuntimeDb, taskId: string | null) =>
  taskId !== null && (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM leases WHERE task_id = ?', taskId)?.n ?? 0) > 0;

/** Auto-promotions recorded since the local day start in routine.timezone. */
export function promotionsToday(db: RuntimeDb, now: Date, timezone: string): number {
  return db.eventsOfKindSince(AUTO_PROMOTE_EVENT, localDayStart(now, timezone)).length;
}

/**
 * Checks one status change. Returns null when the caps do not apply, a ticket when it is allowed, and throws
 * POLICY_DENIED (details.refusal) when a cap refuses it. Nothing is written until the ticket is committed, except
 * an `auto-promote-refused` event on a refusal.
 */
export async function checkPromotion(r: PromotionRequest, deps: GuardDeps): Promise<PromotionTicket | null> {
  const { db } = deps;
  if (!isCappedPromotion(r, everLeased(db, r.taskId))) return null;
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const who = r.taskId ?? 'the new task';
  const owner = lastOwnerMessageAt(db);
  if (r.ownerApproved) {
    const recent = owner !== null && (now.getTime() - Date.parse(owner)) / 60_000 <= OWNER_ACTIVE_MINUTES;
    if (!recent && deps.config.communication.channel !== 'terminal') {
      throw new MinionsError('POLICY_DENIED',
        `--owner-approved refused for ${who}: no owner message in the last ${OWNER_ACTIVE_MINUTES} minutes${owner ? ` (last ${owner})` : ''}.`,
        'Use --owner-approved only right after the owner asked for this task. Otherwise leave it as idea and ask the owner in the digest.',
        { refusal: { taskId: r.taskId, reasons: ['no recent owner message'] } });
    }
    return { kind: 'owner', commit: (taskId) => { db.addEvent(OWNER_PROMOTE_EVENT, taskId, { from: r.from }, at); } };
  }
  const s = autoPromoteSettings(deps.config);
  let parent: CapInputs['parent'] = null;
  if (r.parent) {
    try { const p = await deps.getTask(r.parent); parent = { id: p.id, labels: p.labels }; }
    catch { parent = null; /* a missing parent carries no label */ }
  }
  const reasons = capRefusals({
    now, settings: s, promotedToday: promotionsToday(db, now, s.timezone), budgetPercent: deps.budgetPercent(),
    lastOwnerMessageAt: owner, taskLabels: r.labels, parent,
  });
  if (reasons.length) {
    db.addEvent(AUTO_PROMOTE_REFUSED_EVENT, r.taskId, { reasons }, at);
    throw new MinionsError('POLICY_DENIED',
      `Auto-promotion refused: ${who} (agent-hypothesis) stays ${r.from ?? 'idea'}: ${reasons.join('; ')}.`,
      'Leave it as idea and ask the owner in the digest (do not change its provenance or labels to get around this). The caps are host settings (routine.autoPromote.*).',
      { refusal: { taskId: r.taskId, reasons } });
  }
  return { kind: 'auto', commit: (taskId) => { db.addEvent(AUTO_PROMOTE_EVENT, taskId, { from: r.from }, at); } };
}
