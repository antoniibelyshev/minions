// The dispatcher's deterministic verification (docs/design/autonomy.md Decision 12): the verify step on each producer
// head before a gate stage starts (Scheduler.verificationDue / settleVerification decide; the dispatcher runs it), and
// the periodic run of the slow tier (verification.periodic) on the base head. Both use the integrator's runner
// (runVerification) in the dispatcher's own detached worktree, one run at a time.
import { join } from 'node:path';
import type { BacklogAdapter } from '../backlog/types.js';
import type { MinionsConfig } from '../config/schema.js';
import type { RuntimeDb } from './db.js';
import { runVerification, type VerifyResult } from './integrator.js';
import { enqueue } from './outbox.js';

/** One verification run: `commands` on the commit `head`. */
export interface VerifyRun { key: string; head: string; commands: string[]; setupCommands: string[]; timeoutMs: number; shouldStop: () => boolean }
export type Verifier = (r: VerifyRun) => Promise<VerifyResult>;

/** The production verifier: runVerification in `dir` (never the integrator's worktree), logs under `logDir`. */
export const worktreeVerifier = (o: { repo: string; dir: string; runDir: string; logDir: string; env?: NodeJS.ProcessEnv }): Verifier => (r) =>
  runVerification({
    repo: o.repo, dir: o.dir, runDir: o.runDir, candidate: r.head, setupCommands: r.setupCommands, commands: r.commands, timeoutMs: r.timeoutMs,
    logPath: join(o.logDir, `${r.key.replace(/[^A-Za-z0-9._-]/g, '_')}-${r.head.slice(0, 12)}.log`), shouldStop: r.shouldStop, ...(o.env ? { env: o.env } : {}),
  });

// ---------------------------------------------------------------- periodic

export const PERIODIC_META = 'periodic_verification';
export const PERIODIC_LABEL = 'verify:periodic';
export const DEFAULT_PERIODIC_HOURS = 24;
/** The last periodic run: the base head it verified (a transient run keeps the previous one) and when. */
export interface PeriodicRecord { base: string | null; at: string; outcome: VerifyResult['state'] }

export function periodicRecord(db: Pick<RuntimeDb, 'getMeta'>): PeriodicRecord | null {
  try { const v = db.getMeta(PERIODIC_META); return v ? JSON.parse(v) as PeriodicRecord : null; } catch { return null; }
}

/** Whether the slow tier is due on `base`: configured, `everyHours` since the last run, and the base moved since. */
export function periodicDue(db: Pick<RuntimeDb, 'getMeta'>, cfg: Pick<MinionsConfig, 'verification'>, base: string, now: Date): boolean {
  const p = cfg.verification.periodic;
  if (!p?.commands.length) return false;
  const last = periodicRecord(db);
  if (!last) return true;
  return last.base !== base && now.getTime() - Date.parse(last.at) >= (p.everyHours ?? DEFAULT_PERIODIC_HOURS) * 3_600_000;
}

/** A task still tracking the failure: anything but done or cancelled (a delivered fix is not on the base yet). */
const OPEN = (s: string) => !['done', 'cancelled'].includes(s);

/**
 * Records a periodic run. Red: one backlog task (label verify:periodic, the failing command and its output tail) unless
 * one is still open, and an owner notice for it. Transient: a notice only; the base counts as not verified yet.
 */
export async function settlePeriodic(d: { db: RuntimeDb; backlog: BacklogAdapter; cfg: MinionsConfig; now: Date }, base: string, v: VerifyResult): Promise<string | null> {
  if (v.state === 'stopped') return null;
  const prev = periodicRecord(d.db);
  const rec: PeriodicRecord = { base: v.state === 'transient' ? prev?.base ?? null : base, at: d.now.toISOString(), outcome: v.state };
  d.db.setMeta(PERIODIC_META, JSON.stringify(rec));
  d.db.addEvent('verify-periodic', null, { base, outcome: v.state, ...(v.state === 'red' ? { command: v.command } : {}) });
  const short = base.slice(0, 12);
  const notice = (key: string, kind: 'blocker' | 'other', text: string, taskId?: string) => {
    try { enqueue(d.db, { key, kind, text: text.slice(0, 3_900), ...(taskId ? { taskId } : {}) }, () => d.now); } catch { /* a notice never fails the dispatcher */ }
  };
  if (v.state === 'transient') {
    notice(`verify-periodic-transient:${base}`, 'blocker', `Periodic verification could not run on ${d.cfg.git.baseBranch} at ${short} (a setup problem, not a code failure): ${v.detail.split('\n')[0]!.slice(0, 400)}`);
    return null;
  }
  if (v.state !== 'red') return null;
  if ((await d.backlog.listTasks()).some((t) => t.labels.includes(PERIODIC_LABEL) && OPEN(t.status))) return null;
  const { task } = await d.backlog.createTask({
    title: `Periodic verification failed on ${short}: ${v.command}`.replace(/[\r\n]+/g, ' ').slice(0, 200),
    description: `The periodic verification (verification.periodic) failed on ${d.cfg.git.baseBranch} at ${base}: \`${v.command}\`.\n\nOutput tail:\n\n\`\`\`\n${v.detail}\n\`\`\``,
    acceptanceCriteria: [`\`${v.command}\` passes on ${d.cfg.git.baseBranch}`],
    labels: [PERIODIC_LABEL], provenance: 'observed-result', idempotencyKey: `verify-periodic:${base}`,
    ...(d.cfg.intake.startReady ? { status: 'ready' as const } : {}),
  });
  notice(`verify-periodic:${base}`, 'blocker', `Periodic verification failed on ${d.cfg.git.baseBranch} at ${short}: \`${v.command}\`; ${task.id} tracks the fix. ref: #${task.id}`, task.id);
  return task.id;
}
