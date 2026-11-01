// The autopilot dispatcher (docs/design/autonomy.md Decision 1): `minions work dispatch`, a deterministic node process
// that runs the stage loop: the only way stages run (Decision 10). No model decides anything here.
//
//   pass: holds cleared when the coordinator acted -> `next` -> claim each runnable stage -> start a headless worker
//   exit: record the submitted result -> recordDecision -> one automatic correction, or a hold for the coordinator
//
// Architecture decisions:
// - Every check stays where it is: claim, brief, record, the stage machine, QA insertion, repairs, CI gates,
//   publication and local integration are Scheduler / handoff functions. The dispatcher only replaces the turns
//   between them, and uses advance.ts's decision table (recordDecision) for "the coordinator must judge".
// - A hold (meta `dispatch_holds`) parks a task after a decision: the dispatcher never claims it again until the
//   coordinator acts. It clears itself when the task's status changes or a lease the dispatcher did not take starts
//   after it; `minions work autopilot resume <taskId>` clears it by hand. Each hold is also a `dispatch-decision`
//   event and is handed to the coordinator (deps.notify: the task session's inbox, else a routine wake reason).
// - Workers are started through deps.launch (production: ./dispatch-launch.ts, `claude -p --agent minions:<role>` or
//   the process-harness runner); the dispatcher supervises them with runner/supervise.ts and keeps one run record per
//   lease (<state>/run/dispatch/<leaseId>.json) so a restarted dispatcher recovers its leases instead of losing them.
// - Leases it claims have holder `dispatcher`; the coordinator's restart and wake rules ignore them (they are not its
//   subagents).
// - Budget, pause and drain apply (Scheduler.next reports them as startsBlocked). A spend cap that stops work is told to
//   the owner once per cap value; stages it holds back are still verified (verification spends no tokens).
// - Verify step (Decision 12): a gate stage starts only on a head whose verification passed (Scheduler.verificationDue).
//   The dispatcher runs it through deps.verify (./verify-step.ts) instead of claiming, one run at a time, and records it
//   with Scheduler.settleVerification. With the slot free it runs verification.periodic on the base head when due.
//   Without deps.verify (tests of other paths) nothing is verified.
import { readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, ensureDir } from '../core/fsutil.js';
import { recordDecision } from './advance.js';
import { DISPATCH_HOLDER, type Lease, type RuntimeDb, type SupervisorLock } from './db.js';
import { DEFAULT_TICK_SECONDS, DISPATCH_EVENT, dispatchSettings, readHolds, writeHolds, type DispatchHold } from './dispatch-state.js';
import { claimWithBrief, compactClaim, recordSubmitted, type CompactClaim, type HandoffPaths } from './handoff.js';
import { enqueue } from './outbox.js';
import type { NextReport, NextStage, RecordResponse, Scheduler } from './scheduler.js';
import { hostIdentity, procIdentity } from './runner/record.js';
import { verifyTimeoutMs } from './integrator.js';
import { periodicDue, settlePeriodic, type Verifier } from './verify-step.js';
import { headOf } from './worktree.js';
import type { StopReason } from './runner/supervise.js';
import { supervisorAlive, systemLockView, type LockProcessView } from './supervisor.js';

export { DISPATCH_HOLDER };
export * from './dispatch-state.js';

/** Claims of one task that fail in a row before the task is held. */
const MAX_CLAIM_FAILURES = 3;

// ---------------------------------------------------------------- run records

export interface DispatchRunRecord {
  leaseId: string; taskId: string; role: string; pid: number | null; startedAt: string;
  /** The worker process's start time (procIdentity), so a reused pid is never taken for it. */
  procStart: string | null;
  /** The worker's Claude session id (from stream-json), for the correction resume. */
  sessionId: string | null;
  corrections: number;
}
export const dispatchRunDir = (state: string) => join(state, 'run', 'dispatch');
const runRecordPath = (state: string, leaseId: string) => join(dispatchRunDir(state), `${leaseId}.json`);
async function writeRunRecord(state: string, r: DispatchRunRecord): Promise<void> {
  await ensureDir(dispatchRunDir(state), 0o700);
  await atomicWrite(runRecordPath(state, r.leaseId), JSON.stringify(r) + '\n', { mode: 0o600 });
}
async function readRunRecords(state: string): Promise<DispatchRunRecord[]> {
  let names: string[];
  try { names = await readdir(dispatchRunDir(state)); } catch { return []; }
  const out: DispatchRunRecord[] = [];
  for (const n of names.filter((x) => /^lease-[A-Za-z0-9_-]+\.json$/.test(x))) {
    try { out.push(JSON.parse(await readFile(join(dispatchRunDir(state), n), 'utf8')) as DispatchRunRecord); } catch { /* a torn record is dropped */ }
  }
  return out;
}

// ---------------------------------------------------------------- workers

export interface WorkerExit {
  code: number | null; signal: string | null; stopped: StopReason | null;
  /** Total tokens the worker reported (stream-json result usage), or null. */
  tokens: number | null;
  model: string | null;
  sessionId: string | null;
  stderrTail: string;
  spawnError: string | null;
}
export interface WorkerHandle {
  /** Resolves once the process (group) is gone. */
  done: Promise<WorkerExit>;
  /** The process group id, once spawned (for the run record). */
  pid(): number | null;
  sessionId(): string | null;
}
export interface LaunchInput {
  cfg: MinionsConfig; stage: NextStage; claim: CompactClaim; timeoutMs: number;
  /** The single correction: the errors of the rejected result and the session to resume (null: a fresh worker). */
  correction?: { errors: string[]; resume: string | null };
}

export interface DispatcherDeps {
  db: RuntimeDb;
  paths: HandoffPaths & { state: string };
  config(): Promise<MinionsConfig>;
  scheduler(cfg: MinionsConfig): Promise<Scheduler>;
  launch(i: LaunchInput): Promise<WorkerHandle>;
  /** The task's current backlog status (null: unknown), for hold clearing. */
  taskStatus(sched: Scheduler, taskId: string): Promise<string | null>;
  /** Hands a hold to the coordinator (task session inbox, wake reason, ...). Never throws into the dispatcher. */
  notify(hold: DispatchHold, cfg: MinionsConfig): Promise<void> | void;
  /** Whether the worker of a run record still runs (same pid and start time). Default: never (nothing adopted). */
  workerAlive?(r: DispatchRunRecord): Promise<boolean>;
  /** Stops an adopted worker's process group (identity checked by the caller), e.g. past its wall-clock limit. */
  stopWorker?(r: DispatchRunRecord): Promise<void>;
  /** The start time of a just-spawned worker, for its run record. */
  procStart?(pid: number): Promise<string | null>;
  /** Runs verification commands on a commit (production: verify-step.ts worktreeVerifier). Omitted: no verify step. */
  verify?: Verifier;
  now?(): Date;
  log?(line: string): void;
}

export interface PassReport {
  started: { taskId: string; role: string; leaseId: string }[];
  /** The verification started this pass: a task id, or `periodic` for the base head. */
  verifying: string | null;
  held: string[];
  cleared: string[];
  blocked: string | null;
}

interface Running { leaseId: string; taskId: string; role: string; stage: NextStage; handle: WorkerHandle; corrections: number }

export class Dispatcher {
  private readonly running = new Map<string, Running>();
  /** Workers a previous dispatcher started that still run (a restart, e.g. a self-update): recorded once they end. */
  private readonly adopted = new Map<string, DispatchRunRecord>();
  private readonly claimFailures = new Map<string, number>();
  /** Exit handling in flight (tests await it; the loop never overlaps a pass with a record of the same lease). */
  private readonly settling = new Set<Promise<void>>();
  /** Tasks whose worker ended and whose result is being recorded: never claimed again until it is (no second worker). */
  private readonly recording = new Set<string>();
  /** The one verification running now (a task id, or `periodic`). */
  private verifying: string | null = null;
  constructor(private readonly d: DispatcherDeps) {}

  private now = () => (this.d.now ?? (() => new Date()))();
  private log = (line: string) => { try { this.d.log?.(line); } catch { /* logging never stops the loop */ } };

  /** Workers this dispatcher supervises now. */
  active(): { leaseId: string; taskId: string; role: string }[] {
    return [...this.running.values(), ...this.adopted.values()].map(({ leaseId, taskId, role }) => ({ leaseId, taskId, role }));
  }

  /** Resolves once every exit handled so far is recorded (tests, shutdown). */
  async settled(): Promise<void> { while (this.settling.size) await Promise.all([...this.settling]); }

  private async hold(cfg: MinionsConfig, sched: Scheduler, h: Omit<DispatchHold, 'at' | 'status'>): Promise<void> {
    const status = await this.d.taskStatus(sched, h.taskId).catch(() => null);
    const hold: DispatchHold = { ...h, at: this.now().toISOString(), status };
    const all = readHolds(this.d.db);
    all[h.taskId] = hold;
    writeHolds(this.d.db, all);
    this.d.db.addEvent(DISPATCH_EVENT, h.taskId, { kind: h.kind, message: h.message.slice(0, 500), leaseId: h.leaseId, ...(h.errors ? { errors: h.errors.slice(0, 10) } : {}) });
    this.log(`dispatch: hold ${h.taskId} (${h.kind}): ${h.message.slice(0, 200)}`);
    try { await this.d.notify(hold, cfg); } catch (e) { this.log(`dispatch: notify ${h.taskId} failed: ${(e as Error).message}`); }
  }

  /** Clears holds the coordinator resolved: the task's status moved, or someone else claimed a stage since. */
  private async clearResolved(sched: Scheduler): Promise<string[]> {
    const holds = readHolds(this.d.db);
    const cleared: string[] = [];
    for (const [taskId, h] of Object.entries(holds)) {
      const status = await this.d.taskStatus(sched, taskId).catch(() => h.status);
      const claimedSince = this.d.db.all<{ id: string }>('SELECT id FROM leases WHERE task_id = ? AND started_at > ? AND (holder IS NULL OR holder != ?)', taskId, h.at, DISPATCH_HOLDER).length > 0;
      // A hold written while the backlog could not be read (status null) clears only by a claim or by hand.
      if ((h.status !== null && status !== null && status !== h.status) || claimedSince) {
        delete holds[taskId];
        cleared.push(taskId);
        this.d.db.addEvent('dispatch-resume', taskId, { why: claimedSince ? 'the coordinator claimed a stage' : `status ${h.status ?? '?'} -> ${status ?? '?'}` });
      }
    }
    if (cleared.length) writeHolds(this.d.db, holds);
    return cleared;
  }

  /**
   * Startup recovery: leases a previous dispatcher held. A worker that still runs is adopted (recorded when it ends);
   * otherwise a submitted result is recorded as usual and a lease without one is released (worktree and branch kept:
   * the next attempt continues from the branch).
   */
  async recover(): Promise<{ recorded: string[]; released: string[]; adopted: string[] }> {
    const records = new Map((await readRunRecords(this.d.paths.state)).map((r) => [r.leaseId, r]));
    const out = { recorded: [] as string[], released: [] as string[], adopted: [] as string[] };
    for (const l of this.d.db.activeLeases().filter((x) => x.holder === DISPATCH_HOLDER && !this.running.has(x.id))) {
      const rec = records.get(l.id);
      if (rec && await (this.d.workerAlive?.(rec) ?? Promise.resolve(false)).catch(() => false)) {
        this.adopted.set(l.id, rec);
        out.adopted.push(l.id);
        continue;
      }
      (await this.finishOrphan(l, rec)) === 'recorded' ? out.recorded.push(l.id) : out.released.push(l.id);
    }
    const active = new Set(this.d.db.activeLeases().map((l) => l.id));
    for (const id of records.keys()) if (!active.has(id)) await rm(runRecordPath(this.d.paths.state, id), { force: true });
    return out;
  }

  /** An adopted or orphaned worker ended: record its submitted result, or release the lease. */
  private async finishOrphan(l: Lease, rec: DispatchRunRecord | undefined): Promise<'recorded' | 'released'> {
    const cfg = await this.d.config();
    const sched = await this.d.scheduler(cfg);
    let outcome: 'recorded' | 'released';
    try {
      const r = await recordSubmitted(sched, this.d.paths, l.id, { correction: (rec?.corrections ?? 0) > 0 });
      outcome = 'recorded';
      await this.afterRecord(cfg, sched, l, r, rec?.corrections ?? 1, rec?.sessionId ?? null);
    } catch {
      await sched.release(l.id, 'the dispatcher restarted and this worker ended without a result; the next attempt continues from its branch').catch(() => undefined);
      outcome = 'released';
    }
    await rm(runRecordPath(this.d.paths.state, l.id), { force: true });
    return outcome;
  }

  /** Adopted workers that have ended since the last pass (one past its wall-clock limit is stopped first). */
  private async reapAdopted(cfg: MinionsConfig): Promise<void> {
    const limit = dispatchSettings(cfg).workerTimeoutMs;
    for (const [id, rec] of [...this.adopted]) {
      const alive = await (this.d.workerAlive?.(rec) ?? Promise.resolve(false)).catch(() => true);
      const l = this.d.db.lease(id);
      const overdue = this.now().getTime() - Date.parse(rec.startedAt) > limit;
      if (alive && (overdue || l?.status !== 'active')) { await this.d.stopWorker?.(rec).catch(() => undefined); continue; }
      if (alive) continue;
      this.adopted.delete(id);
      this.recording.add(rec.taskId);
      try {
        if (l?.status === 'active') await this.finishOrphan(l, rec);
      } catch (e) { this.log(`dispatch: recording the adopted ${id} failed: ${(e as Error).message}`); } finally {
        this.recording.delete(rec.taskId);
        await this.cleanupRun(id);
      }
    }
  }

  /** One pass: clear resolved holds, then claim and start every runnable stage within the limits. */
  async pass(): Promise<PassReport> {
    const cfg = await this.d.config();
    const report: PassReport = { started: [], verifying: null, held: [], cleared: [], blocked: null };
    await this.reapAdopted(cfg);
    const sched = await this.d.scheduler(cfg);
    report.cleared = await this.clearResolved(sched);
    const holds = readHolds(this.d.db);
    report.held = Object.keys(holds);
    const next = await sched.next();
    this.capNotices(next);
    const busy = new Set([...this.active().map((r) => r.taskId), ...this.recording, ...(this.verifying ? [this.verifying] : [])]);
    if (next.startsBlocked) {
      // Verification spends no tokens: a stage held only by the daily cap is still verified (not while paused or draining).
      if (next.caps.day.exhausted && !this.d.db.paused().starts) report.verifying = await this.verifyCapped(cfg, sched, next.waiting, holds, busy);
      report.blocked = next.startsBlocked.message;
      return report;
    }
    for (const stage of next.runnable) {
      if (holds[stage.taskId] || busy.has(stage.taskId)) continue;
      if (this.d.verify) {
        // A gate starts only on a verified head: verify first (one run at a time; the others wait for the slot).
        let due: Awaited<ReturnType<Scheduler['verificationDue']>>;
        try { due = await sched.verificationDue(stage.taskId, stage.role); } catch (e) {
          this.log(`dispatch: verify check of ${stage.taskId} failed: ${(e as Error).message}`);
          continue;
        }
        if (due) {
          if (!this.verifying) { this.startVerify(cfg, stage.taskId, due.head, due.commands); report.verifying = stage.taskId; }
          busy.add(stage.taskId);
          continue;
        }
      }
      let claim: CompactClaim;
      try {
        claim = compactClaim(await claimWithBrief(sched, this.d.paths, stage.taskId, stage.role, { holder: DISPATCH_HOLDER }));
      } catch (e) {
        // A full task or role limit: another stage (another role) may still fit.
        if ((e as MinionsError).code === 'CAPACITY') continue;
        const n = (this.claimFailures.get(stage.taskId) ?? 0) + 1;
        this.claimFailures.set(stage.taskId, n);
        this.log(`dispatch: claim ${stage.taskId} ${stage.role} failed (${n}/${MAX_CLAIM_FAILURES}): ${(e as Error).message}`);
        if (n >= MAX_CLAIM_FAILURES) {
          this.claimFailures.delete(stage.taskId);
          await this.hold(cfg, sched, { taskId: stage.taskId, kind: 'claim-failed', message: (e as Error).message, leaseId: null });
          report.held.push(stage.taskId);
        }
        continue;
      }
      this.claimFailures.delete(stage.taskId);
      if (await this.start(cfg, sched, stage, claim, 0)) {
        busy.add(stage.taskId);
        report.started.push({ taskId: stage.taskId, role: stage.role, leaseId: claim.leaseId });
      } else report.held.push(stage.taskId);
    }
    report.verifying ??= await this.verifyCapped(cfg, sched, next.waiting.filter((w) => w.waitingOn === 'budget'), holds, busy);
    if (this.d.verify && !this.verifying && await this.startPeriodicIfDue(cfg, sched)) report.verifying = 'periodic';
    return report;
  }

  /** Verifies the first stage among `stages` (held back by a spend cap) whose head needs it, if the slot is free. */
  private async verifyCapped(cfg: MinionsConfig, sched: Scheduler, stages: NextStage[], holds: Record<string, DispatchHold>, busy: Set<string>): Promise<string | null> {
    if (!this.d.verify || this.verifying) return null;
    for (const stage of stages) {
      if (holds[stage.taskId] || busy.has(stage.taskId)) continue;
      const due = await sched.verificationDue(stage.taskId, stage.role).catch(() => null);
      if (!due) continue;
      this.startVerify(cfg, stage.taskId, due.head, due.commands);
      return stage.taskId;
    }
    return null;
  }

  /** Tells the owner once per cap value when a spend cap stops work: the daily cap per UTC day, the per-task cap per task. */
  private capNotices(next: NextReport): void {
    const { caps } = next;
    if (!caps.enforced) return;
    const notice = (key: string, taskId: string | null, text: string) => {
      try {
        if (enqueue(this.d.db, { key, kind: 'blocker', taskId, text }, () => this.now()).created) this.log(`dispatch: ${text}`);
      } catch (e) { this.log(`dispatch: could not queue the notice ${key}: ${(e as Error).message}`); }
    };
    if (caps.day.exhausted) {
      notice(`budget-cap:day:${this.now().toISOString().slice(0, 10)}:${caps.day.capUsd}`, null,
        `Daily spend cap reached: ~$${caps.day.usedUsd.toFixed(2)} of $${caps.day.capUsd} today (UTC, estimated). New stages wait; running workers finish. Raise it with /budget day <usd> (or off).`);
      return;
    }
    const capped = [...new Map(next.waiting.filter((w) => w.waitingOn === 'budget').map((w) => [w.taskId, w])).values()];
    for (const w of capped) {
      notice(`budget-cap:task:${w.taskId}:${caps.task.capUsd}`, w.taskId,
        `${w.taskId} reached the per-task spend cap: ~$${(caps.task.atCapUsd[w.taskId] ?? 0).toFixed(2)} of $${caps.task.capUsd} (estimated). Its ${w.role} stage waits (verification still runs). Raise it with /budget task <usd> (or off).`);
    }
  }

  /** Runs `work` in the verification slot, tracked like an exit (settled() awaits it). */
  private occupy(id: string, work: () => Promise<void>): void {
    this.verifying = id;
    const p = work().catch((e) => this.log(`dispatch: verification ${id} failed: ${(e as Error).message}`))
      .finally(() => { this.verifying = null; this.settling.delete(p); });
    this.settling.add(p);
  }

  private startVerify(cfg: MinionsConfig, taskId: string, head: string, commands: string[]): void {
    this.log(`dispatch: verifying ${taskId} at ${head.slice(0, 12)} (${commands.join('; ')})`);
    this.occupy(taskId, async () => {
      const v = await this.d.verify!({ key: taskId, head, commands, setupCommands: cfg.verification.setupCommands ?? [], timeoutMs: verifyTimeoutMs(cfg), shouldStop: () => !!this.d.db.drain() });
      const now = await this.d.config();
      const sched = await this.d.scheduler(now);
      const out = await sched.settleVerification(taskId, head, commands, v);
      this.log(`dispatch: ${taskId}: ${out.message}`);
      if (out.hold) await this.hold(now, sched, { taskId, kind: out.hold.kind, message: out.hold.message, leaseId: null });
    });
  }

  /** Starts the periodic run of verification.periodic on the base head when it is due (verify-step.ts). */
  private async startPeriodicIfDue(cfg: MinionsConfig, sched: Scheduler): Promise<boolean> {
    const p = cfg.verification.periodic;
    if (!p || this.d.db.drain()) return false;
    const base = await headOf(sched.layout.repo, cfg.git.baseBranch).catch(() => null);
    if (!base || !periodicDue(this.d.db, cfg, base, this.now())) return false;
    this.log(`dispatch: periodic verification of ${cfg.git.baseBranch} at ${base.slice(0, 12)} (${p.commands.join('; ')})`);
    this.occupy('periodic', async () => {
      const v = await this.d.verify!({ key: 'periodic', head: base, commands: p.commands, setupCommands: cfg.verification.setupCommands ?? [], timeoutMs: verifyTimeoutMs(cfg), shouldStop: () => !!this.d.db.drain() });
      const taskId = await settlePeriodic({ db: this.d.db, backlog: sched.backlog, cfg, now: this.now() }, base, v);
      this.log(`dispatch: periodic verification at ${base.slice(0, 12)}: ${v.state}${taskId ? ` (${taskId} created)` : ''}`);
    });
    return true;
  }

  private async start(cfg: MinionsConfig, sched: Scheduler, stage: NextStage, claim: CompactClaim, corrections: number, correction?: LaunchInput['correction']): Promise<boolean> {
    const s = dispatchSettings(cfg);
    let handle: WorkerHandle;
    try {
      handle = await this.d.launch({ cfg, stage, claim, timeoutMs: s.workerTimeoutMs, ...(correction ? { correction } : {}) });
    } catch (e) {
      const message = `could not start the ${stage.role} worker: ${(e as Error).message}`;
      await sched.release(claim.leaseId, message).catch(() => undefined);
      await this.hold(cfg, sched, { taskId: stage.taskId, kind: 'launch-failed', message, leaseId: claim.leaseId });
      return false;
    }
    const run: Running = { leaseId: claim.leaseId, taskId: stage.taskId, role: stage.role, stage, handle, corrections };
    this.running.set(claim.leaseId, run);
    const pid = handle.pid();
    const procStart = pid !== null && this.d.procStart ? await this.d.procStart(pid).catch(() => null) : null;
    const record: DispatchRunRecord = { leaseId: claim.leaseId, taskId: stage.taskId, role: stage.role, pid, procStart, startedAt: this.now().toISOString(), sessionId: handle.sessionId(), corrections };
    await writeRunRecord(this.d.paths.state, record).catch(() => undefined);
    this.log(`dispatch: started ${stage.taskId} ${stage.role} (${claim.leaseId}${correction ? ', correction' : ''})`);
    const settle = handle.done.then((exit) => this.onExit(run, exit)).catch((e) => this.log(`dispatch: exit of ${claim.leaseId} failed: ${(e as Error).message}`))
      .finally(() => { this.settling.delete(settle); });
    this.settling.add(settle);
    return true;
  }

  private async onExit(run: Running, exit: WorkerExit): Promise<void> {
    this.recording.add(run.taskId);
    this.running.delete(run.leaseId);
    try { await this.settleExit(run, exit); } catch (e) {
      // Never leave the lease active and the task parked silently: end it and hand the task to the coordinator.
      this.log(`dispatch: recording ${run.leaseId} failed: ${(e as Error).message}`);
      try {
        const cfg = await this.d.config();
        const sched = await this.d.scheduler(cfg);
        if (this.d.db.lease(run.leaseId)?.status === 'active') await sched.release(run.leaseId, `the dispatcher could not record this worker: ${(e as Error).message}`).catch(() => undefined);
        await this.hold(cfg, sched, { taskId: run.taskId, kind: 'no-result', message: `the dispatcher could not record the ${run.role} worker: ${(e as Error).message}`, leaseId: run.leaseId });
      } catch { /* the next dispatcher's recovery picks the lease up */ }
    } finally {
      this.recording.delete(run.taskId);
      await this.cleanupRun(run.leaseId);
    }
  }

  /** The run record, the worker's config dir (its transcripts) and its output log end with the lease. */
  private async cleanupRun(leaseId: string): Promise<void> {
    if (this.running.has(leaseId)) return; // the correction run of the same lease reuses them
    await rm(runRecordPath(this.d.paths.state, leaseId), { force: true });
    if (this.d.db.lease(leaseId)?.status === 'active') return;
    await rm(join(dispatchRunDir(this.d.paths.state), 'config', leaseId), { recursive: true, force: true });
    await rm(join(dispatchRunDir(this.d.paths.state), `${leaseId}.log`), { force: true });
  }

  private async settleExit(run: Running, exit: WorkerExit): Promise<void> {
    const cfg = await this.d.config();
    const sched = await this.d.scheduler(cfg);
    const lease = this.d.db.lease(run.leaseId);
    const why = exit.spawnError ? `spawn error: ${exit.spawnError}` : exit.stopped ? `stopped (${exit.stopped})` : `exit ${exit.code ?? exit.signal}`;
    this.log(`dispatch: ${run.taskId} ${run.role} ended (${run.leaseId}, ${why}${exit.tokens !== null ? `, ${exit.tokens} tokens` : ''})`);
    if (!lease || lease.status !== 'active') return;
    const usage = exit.tokens !== null ? { tokens: exit.tokens, model: exit.model } : undefined;
    let r: RecordResponse;
    try {
      r = await recordSubmitted(sched, this.d.paths, run.leaseId, { correction: run.corrections > 0, ...(usage ? { usage } : {}) });
    } catch (e) {
      // Someone else ended the lease meanwhile (a release, a cancel): theirs is the decision.
      if (this.d.db.lease(run.leaseId)?.status !== 'active') return;
      // Stopped for a drain (an upgrade) without a partial: not a failed attempt; the stage stays runnable.
      if (exit.stopped === 'drain') {
        await sched.release(run.leaseId, 'stopped for a drain before it submitted; the next attempt continues from its branch', usage ? { usage } : {});
        return;
      }
      // No submitted result: the worker ran out of turns or time, or crashed. The lease ends; the coordinator decides.
      const tail = exit.stderrTail.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      const message = `the ${run.role} worker ended without a result (${why})${tail ? `: ${tail}` : ''}; ${(e as Error).message}`;
      await sched.release(run.leaseId, message, usage ? { usage } : {}).catch(() => undefined);
      await this.hold(cfg, sched, { taskId: run.taskId, kind: 'no-result', message, leaseId: run.leaseId });
      return;
    }
    await this.afterRecord(cfg, sched, lease, r, run.corrections, exit.sessionId ?? run.handle.sessionId(), run.stage);
  }

  private async afterRecord(cfg: MinionsConfig, sched: Scheduler, lease: Lease, r: RecordResponse, corrections: number, sessionId: string | null, stage?: NextStage): Promise<void> {
    const worker = r.valid ? storedResult(this.d.db, lease.id) : {};
    const decision = recordDecision(sched, r, worker);
    if (!decision || decision.kind === 'draining') return;
    if (decision.kind === 'invalid' && decision.correctionAllowed && corrections === 0 && stage) {
      // The one bounded correction: same lease, the worker's own session resumed with the errors.
      const claim: CompactClaim = {
        leaseId: lease.id, briefMarker: `minions-lease: ${lease.id}`, taskId: lease.task_id, title: stage.title, role: lease.role, attempt: lease.attempt,
        branch: lease.branch ?? '', worktree: lease.worktree ?? '', expectedHead: lease.head_sha ?? '', briefCommand: `minions work brief ${lease.id} --role ${lease.role} --json`,
      };
      if (await this.start(cfg, sched, stage, claim, 1, { errors: decision.errors ?? [], resume: sessionId })) return;
      return;
    }
    await this.hold(cfg, sched, {
      taskId: decision.taskId ?? lease.task_id, kind: decision.kind, message: decision.message, leaseId: lease.id,
      ...(decision.errors?.length ? { errors: decision.errors } : {}),
    });
  }
}

function storedResult(db: RuntimeDb, leaseId: string): { status?: string; findings?: unknown[] } {
  try { return JSON.parse(db.lease(leaseId)?.result_json ?? '{}') as { status?: string; findings?: unknown[] }; } catch { return {}; }
}

/** The prompt of a headless worker: the lease marker, the worktree and what to do, or the correction. */
export function workerPrompt(claim: Pick<CompactClaim, 'briefMarker' | 'worktree' | 'leaseId' | 'role'>, correction?: LaunchInput['correction']): string {
  const head = `${claim.briefMarker}\nworktree: ${claim.worktree}\n`;
  if (!correction) return `${head}\nFetch your brief (\`${`minions work brief ${claim.leaseId} --role ${claim.role} --json`}\` from the worktree), do the task, and submit your WorkerResult with \`minions work submit ${claim.leaseId} --role ${claim.role}\` before you end.`;
  const errors = correction.errors.slice(0, 20).map((e) => `- ${e}`).join('\n');
  return `${head}\nYour submitted WorkerResult was rejected:\n${errors || '- (no details)'}\n\nFix exactly these problems (commit if needed), then submit the corrected WorkerResult again with \`minions work submit ${claim.leaseId} --role ${claim.role}\`. This is the only correction.`;
}

// ---------------------------------------------------------------- the process

const DISPATCH_CMDLINE = /(^|[\s/])work\s+dispatch(\s|$)/;
export const dispatcherAlive = (l: SupervisorLock, pc: LockProcessView = systemLockView) => supervisorAlive(l, pc, DISPATCH_CMDLINE);
export function dispatcherLockState(db: Pick<RuntimeDb, 'supervisorLock'>, pc: LockProcessView = systemLockView): { state: 'none' | 'live' | 'stale'; lock: SupervisorLock | null } {
  const lock = db.supervisorLock('dispatcher_lock');
  return lock ? { state: dispatcherAlive(lock, pc) ? 'live' : 'stale', lock } : { state: 'none', lock: null };
}

export interface RunDispatcherDeps extends DispatcherDeps {
  signal?: AbortSignal;
  lockAlive?: (l: SupervisorLock) => boolean;
  /** Default: the dispatch.tickSeconds of each pass's config. */
  tickMs?: number;
  /** Test seam: resolves after `ms` or when aborted. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export type DispatcherExit = 'conflict' | 'stopped' | 'lock-lost';

const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * `minions work dispatch`: takes the dispatcher lock, recovers the previous holder's leases, then runs a pass every
 * tick until stopped or the lock is lost. Running workers are waited for on the way out, never abandoned.
 */
export async function runDispatcher(d: RunDispatcherDeps): Promise<{ exit: DispatcherExit; passes: number; holder: SupervisorLock | null }> {
  const log = (l: string) => { try { d.log?.(l); } catch { /* ignore */ } };
  const self = await procIdentity(process.pid);
  const host = await hostIdentity();
  const now = d.now ?? (() => new Date());
  const lock = d.db.acquireSupervisorLock({ pid: process.pid, start: self?.startTime ?? null, bootId: host?.bootId ?? null }, d.lockAlive ?? ((l) => dispatcherAlive(l)), now(), 'dispatcher_lock');
  if (!lock) return { exit: 'conflict', passes: 0, holder: d.db.supervisorLock('dispatcher_lock') };
  const sleep = d.sleep ?? abortableSleep;
  const disp = new Dispatcher(d);
  let passes = 0;
  let exit: DispatcherExit = 'stopped';
  log(`minions dispatcher: started (pid ${process.pid})`);
  try {
    const rec = await disp.recover();
    if (rec.recorded.length || rec.released.length || rec.adopted.length) {
      log(`minions dispatcher: recovered ${rec.recorded.length} result(s), released ${rec.released.length} lease(s), adopted ${rec.adopted.length} running worker(s)`);
    }
    while (!d.signal?.aborted) {
      const holder = d.db.supervisorLock('dispatcher_lock');
      if (!holder || holder.pid !== lock.pid || holder.at !== lock.at) { exit = 'lock-lost'; break; }
      let tick = d.tickMs ?? DEFAULT_TICK_SECONDS * 1000;
      try {
        const cfg = await d.config();
        tick = d.tickMs ?? dispatchSettings(cfg).tickMs;
        const r = await disp.pass();
        passes++;
        if (r.started.length) log(`minions dispatcher: started ${r.started.map((x) => `${x.taskId} ${x.role}`).join(', ')}`);
      } catch (e) { log(`minions dispatcher: pass failed: ${(e as Error).message.slice(0, 300)}`); }
      await sleep(tick, d.signal);
    }
    // Stopped (an upgrade, a restart): running workers keep going in their own process groups; the next dispatcher
    // adopts them. Lock lost: wait for the exits already being recorded.
    if (!d.signal?.aborted) await disp.settled();
  } finally {
    d.db.releaseSupervisorLock(lock, 'dispatcher_lock');
    log(`minions dispatcher: ${exit}`);
  }
  return { exit, passes, holder: lock };
}
