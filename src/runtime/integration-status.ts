// The user-facing surface of the local integrator (docs/design/local-auto-integration.md phase 4, task-82.4):
// the `integration` block of `minions status`, the problems `minions doctor` reports from it, and the backstops
// that start the integrator when a detached start was lost (the coordinator wrapper's minute watch and
// `coordinator restart --recover`).
//
// Architecture decisions (task-82.4):
// - One read model, collectIntegrationStatus: status shows it, and the host doctor reads the same block from the
//   container's `minions status --json` (no new command; the doctor never opens the runtime DB itself).
// - Problems are derived in the runtime, where the lock, the rows and the checkout can be read together:
//   a stale lock (the holder died; the next start recovers it), a halted queue, a dirty checkout that blocks a
//   landing, and a crash during `git merge --ff-only` (a row still in `landing`, no live holder, and the base
//   checkout has changes: its tree was partly updated while the base still points at B). Recovery never touches
//   /workspace/repo, so that last one needs the owner: save own edits, then `git checkout --force <base>`.
// - Backstop rule (integratorKickDecision, pure): start when local integration is on, the queue has entries (or a
//   dead holder left a running row to recover), no live holder, and no halt, drain or start pause. A second
//   integrator exits at once on the held lock, and a start is not repeated within a grace window.
import type { Task } from '../backlog/types.js';
import { autoMergeConfigReasons, localIntegrationEnabled } from '../config/delivery.js';
import type { MinionsConfig } from '../config/schema.js';
import { gateGit } from './git-hardening.js';
import { withEmptyHome } from './isolated-git.js';
import type { RuntimeDb } from './db.js';
import { checkoutGit, porcelainPaths } from './integration.js';
import {
  INTEGRATION_BASE_META, integrationHalt, integrationLockState, integrationQueue, OPEN_PHASES, RUNNING_PHASES,
  type IntegrationHalt, type IntegrationRow,
} from './integrator.js';
import type { LockProcessView } from './supervisor.js';
import { parseWorktreeList } from './worktree.js';

export interface BaseCheckout {
  /** The worktree that has the base branch checked out (null: none; the integrator then moves the ref only). */
  path: string | null;
  state: 'clean' | 'dirty' | 'not-checked-out' | 'unknown';
  /** Tracked paths with staged or unstaged changes (dirty), at most 20. */
  paths?: string[];
  detail?: string;
}

export interface IntegrationProblem { name: string; status: 'warn' | 'fail'; detail: string; hint: string }

export interface IntegrationStatus {
  /** Local integration on (local delivery, delivery.merge "auto-when-eligible", base.merge not deny, verification commands). */
  enabled: boolean;
  /** Why it is off (local delivery only; empty when on). */
  reasons: string[];
  lock: { state: 'none' | 'live' | 'stale'; pid: number | null; at: string | null };
  /** The running integration (merging, verifying, landing). */
  current: { taskId: string; head: string; phase: string; attempt: number; startedAt: string | null; elapsedSeconds: number | null } | null;
  /** Queued integrations, oldest first, with why each waits (null: next in line). */
  queue: { taskId: string; head: string; queuedAt: string; attempt: number; waiting: string | null; lastOutcome: string | null }[];
  /** Integrations waiting for a host-signed merge approval (task awaiting-human). */
  awaitingApproval: { taskId: string; head: string; detail: string | null }[];
  /** The latest terminal integration. */
  last: { taskId: string; phase: string; outcome: string | null; endedAt: string | null; detail: string | null } | null;
  /** The last base SHA the integrator landed or adopted. */
  base: string | null;
  halted: IntegrationHalt | null;
  checkout: BaseCheckout | null;
  problems: IntegrationProblem[];
}

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
const firstLine = (s: string | null) => (s ? s.split('\n')[0]!.slice(0, 300) : null);

/** Where the base branch is checked out in `repo`'s worktrees, and whether that checkout has tracked changes. Never throws. */
export async function inspectBaseCheckout(repo: string, baseBranch: string): Promise<BaseCheckout> {
  try {
    const wl = await gateGit(repo, ['worktree', 'list', '--porcelain'], true);
    if (wl.code !== 0) return { path: null, state: 'unknown', detail: `git worktree list failed (exit ${wl.code})` };
    const wt = parseWorktreeList(wl.stdout).find((w) => w.branch === baseBranch && !w.detached);
    if (!wt) return { path: null, state: 'not-checked-out' };
    return await withEmptyHome(async (home) => {
      const st = await checkoutGit(wt.path, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none'], home);
      if (st.code !== 0) return { path: wt.path, state: 'unknown', detail: `git status failed (exit ${st.code})` } as BaseCheckout;
      const paths = porcelainPaths(st.stdout);
      return paths.length ? { path: wt.path, state: 'dirty', paths: paths.slice(0, 20) } : { path: wt.path, state: 'clean' };
    });
  } catch (e) {
    return { path: null, state: 'unknown', detail: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}

export interface IntegrationStatusDeps {
  db: RuntimeDb;
  config: MinionsConfig;
  /** The repository the integrator lands on (/workspace/repo). */
  repo: string;
  /** The backlog (dependency waits); null when it could not be read. */
  tasks?: Pick<Task, 'id' | 'status' | 'dependencies'>[] | null;
  now?: Date;
  lockView?: LockProcessView;
  /** Default inspectBaseCheckout. */
  inspect?: (repo: string, baseBranch: string) => Promise<BaseCheckout>;
}

/** The `integration` block of `minions status`; null when there is nothing to show (local integration off and never used). */
export async function collectIntegrationStatus(d: IntegrationStatusDeps): Promise<IntegrationStatus | null> {
  const cfg = d.config;
  const enabled = localIntegrationEnabled(cfg);
  const any = !!d.db.get('SELECT 1 FROM integrations LIMIT 1');
  if (!enabled && !any) return null;
  const now = d.now ?? new Date();
  const base = cfg.git.baseBranch;
  const lockState = d.lockView ? integrationLockState(d.db, d.lockView) : integrationLockState(d.db);
  const lock = { state: lockState.state, pid: lockState.lock?.pid ?? null, at: lockState.lock?.at ?? null };
  const running = d.db.all<IntegrationRow>(`SELECT * FROM integrations WHERE phase IN (${inList(RUNNING_PHASES)}) ORDER BY id`);
  const cur = running[0] ?? null;
  const halted = integrationHalt(d.db);
  const drain = d.db.drain();
  const paused = d.db.paused().starts;
  const statusOf = new Map((d.tasks ?? []).map((t) => [t.id, t]));
  const queue = integrationQueue(d.db).map((q, n) => {
    const deps = (statusOf.get(q.task_id)?.dependencies ?? []).filter((dep) => statusOf.has(dep) && statusOf.get(dep)!.status !== 'done');
    const waiting = halted ? 'queue halted'
      : drain ? `drain (${drain.reason})`
      : paused ? 'starts paused'
      : deps.length ? `dependency ${deps.map((dep) => `${dep} (${statusOf.get(dep)!.status})`).join(', ')}`
      : q.outcome === 'checkout-dirty' ? `checkout not clean (${firstLine(q.detail) ?? ''})`
      : cur ? `behind ${cur.task_id}`
      : n > 0 ? 'in line' : null;
    return { taskId: q.task_id, head: q.head_sha, queuedAt: q.queued_at, attempt: q.attempt, waiting, lastOutcome: q.outcome };
  });
  const awaitingApproval = d.db.all<{ task_id: string; head_sha: string; error: string | null }>("SELECT task_id, head_sha, error FROM publications WHERE mode = 'local' AND state = 'awaiting-approval' ORDER BY task_id")
    .map((p) => ({ taskId: p.task_id, head: p.head_sha, detail: firstLine(p.error) }));
  const lastRow = d.db.get<IntegrationRow>(`SELECT * FROM integrations WHERE phase NOT IN (${inList(OPEN_PHASES)}) ORDER BY COALESCE(ended_at, queued_at) DESC, id DESC LIMIT 1`) ?? null;
  const checkout = await (d.inspect ?? inspectBaseCheckout)(d.repo, base).catch((): BaseCheckout => ({ path: null, state: 'unknown' }));
  const status: IntegrationStatus = {
    enabled,
    reasons: autoMergeConfigReasons(cfg),
    lock,
    current: cur ? {
      taskId: cur.task_id, head: cur.head_sha, phase: cur.phase, attempt: cur.attempt, startedAt: cur.started_at,
      elapsedSeconds: cur.started_at ? Math.max(0, Math.round((now.getTime() - Date.parse(cur.started_at)) / 1000)) : null,
    } : null,
    queue,
    awaitingApproval,
    last: lastRow ? { taskId: lastRow.task_id, phase: lastRow.phase, outcome: lastRow.outcome, endedAt: lastRow.ended_at, detail: firstLine(lastRow.detail) } : null,
    base: d.db.getMeta(INTEGRATION_BASE_META) ?? null,
    halted,
    checkout,
    problems: [],
  };
  status.problems = integrationProblems(status, base, running);
  return status;
}

/** What `minions doctor` reports from the block (see the header). */
export function integrationProblems(s: IntegrationStatus, base: string, running: Pick<IntegrationRow, 'task_id' | 'phase' | 'base_sha' | 'candidate_sha'>[] = []): IntegrationProblem[] {
  const out: IntegrationProblem[] = [];
  const holderDead = s.lock.state !== 'live';
  const landing = holderDead ? running.find((r) => r.phase === 'landing') : undefined;
  const repo = s.checkout?.path ?? 'the base checkout';
  if (landing && s.checkout?.state === 'dirty') {
    out.push({ name: 'integration.checkout', status: 'fail',
      detail: `the integrator stopped during \`git merge --ff-only\` of ${landing.task_id} (candidate ${landing.candidate_sha ?? '?'}): ${repo} has changes to ${s.checkout.paths?.slice(0, 5).join(', ') ?? 'tracked files'} while ${base} still points at ${landing.base_sha ?? 'the old base'}`,
      hint: `In ${repo}: save any edits of your own, then run \`git checkout --force ${base}\`. The next integrator start recovers the run (it never touches ${repo} itself).` });
  } else if (s.checkout?.state === 'dirty' && s.queue.some((q) => q.lastOutcome === 'checkout-dirty')) {
    out.push({ name: 'integration.checkout', status: 'warn',
      detail: `${repo} is not clean (${s.checkout.paths?.slice(0, 5).join(', ') ?? 'tracked files'}): approved integrations cannot land on ${base}`,
      hint: `Commit or stash the changes in ${repo} (never on ${base} by hand for a task); the integrator retries on its next start.` });
  }
  if (s.lock.state === 'stale') {
    out.push({ name: 'integration.lock', status: 'warn',
      detail: `the integration lock is held by pid ${s.lock.pid ?? '?'} since ${s.lock.at ?? '?'}, which no longer runs${running.length ? ` (${running.map((r) => `${r.task_id} ${r.phase}`).join(', ')} left running)` : ''}`,
      hint: 'The next integrator start takes it over and recovers the run (the coordinator wrapper checks every minute; `minions coordinator restart --recover` starts it too).' });
  }
  if (s.halted) {
    out.push({ name: 'integration.queue', status: 'warn',
      detail: `the integration queue is halted since ${s.halted.at || '?'}: ${s.halted.reason}`,
      hint: `Check that the change to ${base} is intended, then run \`minions work integrate --adopt-base\` in the runtime to take the current base and resume.` });
  }
  return out;
}

const dur = (sec: number | null) => (sec === null ? '?' : sec >= 3600 ? `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m` : sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`);

/** The human lines of the block in `minions status`. */
export function humanIntegration(s: IntegrationStatus): string[] {
  const lock = s.lock.state === 'none' ? 'idle' : s.lock.state === 'live' ? `running (pid ${s.lock.pid})` : `stale lock (pid ${s.lock.pid})`;
  const out = [`integration: ${s.enabled ? 'on' : `off (${s.reasons.join('; ') || 'not configured'})`}; ${lock}; base ${s.base ? s.base.slice(0, 12) : '-'}`];
  if (s.current) out.push(`  current: ${s.current.taskId} ${s.current.phase} for ${dur(s.current.elapsedSeconds)} (attempt ${s.current.attempt}, head ${s.current.head.slice(0, 12)})`);
  if (s.queue.length) out.push(`  queue: ${s.queue.map((q) => `${q.taskId}${q.waiting ? ` (${q.waiting})` : ''}`).join(', ')}`);
  for (const a of s.awaitingApproval) out.push(`  awaiting approval: ${a.taskId} at ${a.head} (on the host: minions work approve ${a.taskId} --head ${a.head})`);
  if (s.last) out.push(`  last: ${s.last.taskId} ${s.last.outcome === 'landed-flaky' ? 'landed (flaky)' : s.last.phase}${s.last.endedAt ? ` at ${s.last.endedAt}` : ''}${s.last.detail ? `: ${s.last.detail}` : ''}`);
  if (s.halted) out.push(`  halted: ${s.halted.reason}`);
  for (const p of s.problems) out.push(`  ${p.status === 'fail' ? 'FAIL' : 'warn'} ${p.name}: ${p.detail}`);
  return out;
}

// ---------------------------------------------------------------- backstops

export interface KickInputs {
  enabled: boolean;
  queued: number;
  /** Rows left in a running phase (a dead holder's run to recover). */
  running: number;
  lock: 'none' | 'live' | 'stale';
  halted: boolean;
  draining: boolean;
  startsPaused: boolean;
}

/** Whether a backstop starts the integrator now (see the header). Pure. */
export function integratorKickDecision(i: KickInputs): { start: boolean; why: string } {
  if (!i.enabled) return { start: false, why: 'local integration is off' };
  if (i.lock === 'live') return { start: false, why: 'the integrator is running' };
  if (i.halted) return { start: false, why: 'the integration queue is halted' };
  if (i.draining) return { start: false, why: 'a drain is active' };
  if (i.startsPaused) return { start: false, why: 'starts are paused' };
  if (i.queued === 0 && !(i.lock === 'stale' && i.running > 0)) return { start: false, why: 'nothing queued' };
  return { start: true, why: i.queued ? `${i.queued} queued integration(s) and no integrator running` : 'a stopped integrator left a run to recover' };
}

/** The decision inputs from the runtime DB and config. */
export function kickInputs(db: RuntimeDb, cfg: Pick<MinionsConfig, 'delivery' | 'verification' | 'capabilities'>, lockView?: LockProcessView): KickInputs {
  const lock = lockView ? integrationLockState(db, lockView) : integrationLockState(db);
  return {
    enabled: localIntegrationEnabled(cfg),
    queued: integrationQueue(db).length,
    running: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM integrations WHERE phase IN (${inList(RUNNING_PHASES)})`)?.n ?? 0,
    lock: lock.state, halted: !!integrationHalt(db), draining: !!db.drain(), startsPaused: db.paused().starts,
  };
}

/** One backstop check: starts the integrator when integratorKickDecision says so. Never throws. */
export async function kickIntegratorIfNeeded(o: { decide: () => KickInputs | Promise<KickInputs>; start: () => number | null; say?: (line: string) => void }): Promise<{ start: boolean; why: string; pid?: number | null }> {
  try {
    const d = integratorKickDecision(await o.decide());
    if (!d.start) return d;
    const pid = o.start();
    o.say?.(`minions: started the local integrator (pid ${pid ?? '?'}): ${d.why}`);
    return { ...d, pid };
  } catch (e) {
    o.say?.(`minions: could not start the local integrator: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { start: false, why: `error: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
  }
}

export interface IntegrationWatchDeps {
  decide: () => KickInputs | Promise<KickInputs>;
  start: () => number | null;
  /** Check interval (default 60 s). */
  intervalMs?: number;
  /** A start this recent is still coming up: no second one (default 30 s). */
  startGraceMs?: number;
  timer?: (fn: () => void, ms: number) => () => void;
  clock?: () => number;
  say?: (line: string) => void;
}

const realTimer = (fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return () => clearInterval(h); };

/**
 * The coordinator wrapper's integration backstop: checks now and every minute, and starts the integrator when a
 * queued integration has no live holder (a detached start that was lost, or a dead holder to recover). Returns the
 * stop function.
 */
export function startIntegrationWatch(o: IntegrationWatchDeps): () => void {
  const clock = o.clock ?? Date.now;
  const grace = o.startGraceMs ?? 30_000;
  let lastStart = -Infinity;
  let busy = false;
  const check = () => {
    if (busy || clock() - lastStart < grace) return;
    busy = true;
    void kickIntegratorIfNeeded({ decide: o.decide, start: () => { lastStart = clock(); return o.start(); }, ...(o.say ? { say: o.say } : {}) })
      .finally(() => { busy = false; });
  };
  check();
  return (o.timer ?? realTimer)(check, o.intervalMs ?? 60_000);
}
