// PR scan (decision record: docs/design/bootstrap.md, "PR scan"; design: docs/design/unattended-delivery.md
// decision 4, task-68.3).
//
// - One `gh pr list --state open` read per scan, matched to `delivered` tasks by URL. Runs in `minions sync`,
//   after `work record` / `work release` (bounded: 60 s, then an abort kills in-flight git/gh; a `scan` field
//   that never changes the record outcome) and,
//   once it exists, in the routine pass (task-68.2 calls runPrScan). Only with pull-request delivery on
//   GitHub and delivery.merge "auto-when-eligible"; otherwise it is off and reads nothing.
// - Only tasks without an active lease, whose PR is at the approved publication head, are acted on:
//   CLEAN / BLOCKED / UNSTABLE / HAS_HOOKS: nothing (the merge pass decides); UNKNOWN: retry next pass;
//   BEHIND: verified base update (base-update.ts); DIRTY / CONFLICTING: confirmed by a local merge-tree after a
//   fresh fetch: clean -> base update, conflict -> reported (and handed to the needs-rebase hook, task-68.4);
//   required checks failing at the approved head: changes-requested as a repair cycle; timed out: a
//   notification, the task stays delivered.
// - At most one base update is in flight across all PRs (highest priority, longest-waiting first): a base
//   update whose CI at the new head has not finished blocks the next one. routine.maxBaseUpdatesPerTask caps
//   updates per task in any 24 hours.
// - A PR head that is not the approved head is adopted only when it is a verified base update of it (the crash
//   window between the push and moving publications.head_sha); anything else is a foreign push and is left
//   alone (the merge gate disarms and waits).
// - Where the server is: the repository of the task's recorded PR URL (publications.pr_url), never the
//   repository's `origin` remote or url.* config (agent-writable). Every read of origin's base and of the PR
//   branch, the fetch and the push go to that explicit https URL from an isolated git dir (base-update.ts
//   serverRefOf / fetchBase / pushToServer); the base is also cross-checked with the GitHub API
//   (verifiedServerBase) and a mismatch, or gh unavailable, skips the update.
import { can } from '../config/capabilities.js';
import type { MinionsConfig } from '../config/schema.js';
import type { BacklogAdapter, Task, TaskStatus } from '../backlog/types.js';
import { priorityRank } from '../backlog/ready.js';
import { redact } from '../core/output.js';
import {
  BASE_UPDATE_KIND, commitExists, commitMerge, fetchBase, isolatedGit, mergeTree, originOfPrUrl, parseBaseUpdate, pushToServer, serverRefOf,
  verifiedServerBase, verifyLink, type ServerOrigin, type ServerOptions, type ServerUrlFn,
} from './base-update.js';
import { ciTimeoutOf, formatCiGate, type CiGate } from './ci-gate.js';
import type { PublicationRow, RuntimeDb } from './db.js';
import type { GitFn } from './github.js';
import { armedByMinions } from './merge.js';
import { enqueue } from './outbox.js';
import { classifyFailure, gateChangedPaths, githubOrigin, type GhFn } from './publish.js';
import { headOf, isDirty, listWorktrees } from './worktree.js';

export const PR_SCAN_FIELDS = 'number,url,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,isDraft';
export const DEFAULT_MAX_BASE_UPDATES_PER_TASK = 4;
/** Budget of the scan after `work record` / `work release` (design: 60 s). */
export const SCAN_AFTER_SLOT_BUDGET_MS = 60_000;
/** A base update is not started with less than this left of the budget (fetch, merge-tree, push). */
const BASE_UPDATE_MIN_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GH_CWD = '/';

export interface ScanPr {
  number?: number; url: string; headRefOid: string; headRefName?: string; baseRefName?: string;
  mergeable?: string | null; mergeStateStatus?: string | null; isDraft?: boolean;
}

export type ScanAction =
  | 'none' | 'retry' | 'skipped' | 'deferred'
  | 'base-updated' | 'base-update-failed' | 'conflict'
  | 'ci-repair' | 'ci-timeout'
  | 'adopted' | 'foreign-push';

export interface ScanTaskResult {
  taskId: string; prUrl: string; head: string | null; mergeStateStatus: string | null;
  action: ScanAction; message: string;
  /** base-updated: the new head; conflict: the files. */
  newHead?: string; conflictFiles?: string[]; base?: string;
  to?: TaskStatus; repairCycles?: number;
}

export interface ScanReport {
  state: 'ran' | 'off' | 'failed' | 'budget';
  /** Open PRs the single `gh pr list` returned. */
  prs: number;
  tasks: ScanTaskResult[];
  message: string;
}

export interface ConflictInfo { taskId: string; prUrl: string; head: string; base: string; baseBranch: string; files: string[] }

export interface ScanDeps {
  db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig; repo: string; gh: GhFn; git: GitFn;
  /** The CI evidence gate for (taskId, head): `Scheduler.ciGate`. */
  ciGate: (taskId: string, head: string) => Promise<CiGate>;
  /** Required checks failing at the approved head: delivered -> changes-requested as a repair cycle (`Scheduler.ciRepair`). */
  ciRepair: (taskId: string, head: string, findings: string[]) => Promise<{ to: TaskStatus; repairCycles: number; replan: boolean }>;
  /** A confirmed conflict (task-68.4 builds the needs-rebase stage on this hook); default: event and notification only. */
  onConflict?: (c: ConflictInfo) => Promise<void>;
  now?: () => Date;
  /** Epoch ms after which no new base update starts (the 60 s budget after record/release). */
  deadline?: number;
  /**
   * Aborted when the budget is over (boundedScan): no further task is scanned and gh calls get it (the
   * caller passes a `git` that is killed by it too, worktree.ts abortableGit; the allowlisted base-update calls
   * get the signal directly).
   */
  signal?: AbortSignal;
  /** Test seam: where git reaches the recorded origin URL (base-update.ts ServerUrlFn; default the URL itself). */
  serverUrl?: ServerUrlFn;
}

const sig = (d: ScanDeps) => (d.signal ? { signal: d.signal } : {});
/** Options of the calls that reach the server (the abort signal and the test seam). */
const srv = (d: ScanDeps): ServerOptions => ({ ...sig(d), ...(d.serverUrl ? { serverUrl: d.serverUrl } : {}) });
const short = (s: string) => redact(s.trim().split('\n').slice(-3).join(' | ')).slice(0, 400);
const upper = (s: unknown) => String(s ?? '').toUpperCase();

/** Whether the scan acts at all: pull-request delivery on GitHub with CI-gated auto-merge opted in. */
export function scanEnabled(cfg: MinionsConfig): string | null {
  if (cfg.delivery.mode !== 'pull-request' || cfg.delivery.provider !== 'github') return 'delivery is not pull-request on GitHub';
  if (cfg.delivery.merge !== 'auto-when-eligible') return `delivery.merge is "${cfg.delivery.merge}", not "auto-when-eligible"`;
  return null;
}

/** Base updates pushed for a task in the last 24 hours (events). */
export function baseUpdatesToday(db: RuntimeDb, taskId: string, now: Date): number {
  const since = now.getTime() - DAY_MS;
  return db.events(taskId, 'base-update').filter((e) => (e.data as { state?: string } | null)?.state === 'pushed' && Date.parse(e.at) >= since).length;
}

/** One PR scan: one `gh pr list`, then the cheapest correct action per delivered task. Never throws for expected failures. */
export async function runPrScan(d: ScanDeps, opts: { taskIds?: string[] } = {}): Promise<ScanReport> {
  const cfg = d.config;
  const now = () => d.now?.() ?? new Date();
  const off = scanEnabled(cfg);
  if (off) return { state: 'off', prs: 0, tasks: [], message: `PR scan off: ${off}.` };
  const origin = await githubOrigin(d.git, d.repo);
  if (!origin) return { state: 'off', prs: 0, tasks: [], message: 'PR scan off: origin is not a github.com repository.' };

  const r = await d.gh(['pr', 'list', '--repo', origin.repository, '--state', 'open', '--limit', '200', '--json', PR_SCAN_FIELDS], { cwd: GH_CWD, ...sig(d) });
  if (r.code !== 0) {
    const message = `gh pr list failed: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`;
    d.db.addEvent('pr-scan', null, { state: 'failed', error: message, code: classifyFailure(r.stderr) });
    return { state: 'failed', prs: 0, tasks: [], message: `PR scan failed: ${message}; nothing changed (the next pass retries).` };
  }
  let prs: ScanPr[];
  try { prs = JSON.parse(r.stdout || '[]') as ScanPr[]; if (!Array.isArray(prs)) throw new Error('not a list'); } catch {
    return { state: 'failed', prs: 0, tasks: [], message: 'PR scan failed: gh pr list returned invalid JSON; nothing changed.' };
  }
  const byUrl = new Map(prs.filter((p) => p && typeof p.url === 'string').map((p) => [p.url, p]));
  const want = opts.taskIds?.length ? new Set(opts.taskIds) : null;
  const leased = new Set(d.db.activeLeases().map((l) => l.task_id));
  const all = await d.backlog.listTasks();
  const delivered = all.filter((t) => t.status === 'delivered' && t.prUrl && byUrl.has(t.prUrl));
  // Highest priority first, then the longest-waiting publication (a light merge train).
  const order = delivered.map((t) => ({ t, pub: d.db.publication(t.id) }))
    .sort((a, b) => priorityRank(a.t.priority) - priorityRank(b.t.priority) || (a.pub?.updated_at ?? '').localeCompare(b.pub?.updated_at ?? '') || a.t.id.localeCompare(b.t.id));

  const ctx: Ctx = { d, cfg, origin, now, inFlight: inFlightUpdate(d, delivered, byUrl, now()) };
  const out: ScanTaskResult[] = [];
  let budgetHit = false;
  for (const { t, pub } of order) {
    if (want && !want.has(t.id)) continue;
    if (d.signal?.aborted) { budgetHit = true; out.push({ taskId: t.id, prUrl: t.prUrl!, head: pub?.head_sha ?? null, mergeStateStatus: byUrl.get(t.prUrl!)!.mergeStateStatus ?? null, action: 'deferred', message: 'scan budget exhausted (aborted); the next pass continues' }); continue; }
    const pr = byUrl.get(t.prUrl!)!;
    const res = await scanOne(ctx, t, pub, pr, leased.has(t.id))
      .catch((e: unknown): ScanTaskResult => ({ taskId: t.id, prUrl: t.prUrl!, head: pub?.head_sha ?? null, mergeStateStatus: pr.mergeStateStatus ?? null, action: 'skipped', message: `scan failed: ${short(String((e as Error)?.message ?? e))}` }));
    if (res.action === 'deferred' && /budget/.test(res.message)) budgetHit = true;
    out.push(res);
  }
  const acted = out.filter((x) => !['none', 'retry', 'skipped', 'deferred'].includes(x.action));
  d.db.addEvent('pr-scan', null, { state: 'ran', prs: prs.length, tasks: out.length, actions: acted.map((x) => ({ taskId: x.taskId, action: x.action })) });
  return {
    state: budgetHit ? 'budget' : 'ran', prs: prs.length, tasks: out,
    message: `PR scan: ${prs.length} open PR(s), ${out.length} delivered task(s)${acted.length ? `; ${acted.map((x) => `${x.taskId} ${x.action}`).join(', ')}` : '; nothing to do'}.`,
  };
}

interface Ctx {
  d: ScanDeps; cfg: MinionsConfig; origin: { repository: string; remote: string }; now: () => Date;
  /** The task whose base update is still waiting for CI at its new head (at most one in flight). */
  inFlight: string | null;
}

/** A base update pushed to the current approved head whose CI has not finished yet (and not timed out). */
function inFlightUpdate(d: ScanDeps, delivered: Task[], byUrl: Map<string, ScanPr>, now: Date): string | null {
  const timeoutMs = ciTimeoutOf(d.config) * 60_000;
  for (const t of delivered) {
    const pub = d.db.publication(t.id);
    if (!pub || byUrl.get(t.prUrl!)?.headRefOid !== pub.head_sha) continue;
    const pushed = d.db.events(t.id, 'base-update').filter((e) => (e.data as { state?: string; head?: string } | null)?.state === 'pushed' && (e.data as { head?: string }).head === pub.head_sha).at(-1);
    if (!pushed || now.getTime() - Date.parse(pushed.at) > timeoutMs) continue;
    const ci = d.db.evidenceFor(t.id, pub.head_sha, 'ci').at(-1)?.outcome ?? '';
    if (!/:(passing|failing)$/.test(ci)) return t.id;
  }
  return null;
}

async function scanOne(x: Ctx, task: Task, pub: PublicationRow | undefined, pr: ScanPr, leased: boolean): Promise<ScanTaskResult> {
  const { d, cfg } = x;
  const mss = upper(pr.mergeStateStatus) || null;
  const res = (action: ScanAction, message: string, extra: Partial<ScanTaskResult> = {}): ScanTaskResult =>
    ({ taskId: task.id, prUrl: task.prUrl!, head: pub?.head_sha ?? null, mergeStateStatus: mss, action, message, ...extra });
  if (!pub || pub.state !== 'published' || pub.pr_url !== task.prUrl) return res('skipped', 'no published pull request recorded for this task');
  if (leased) return res('skipped', 'the task has an active lease; never touched while a worker holds it');
  if (pr.isDraft) return res('none', 'draft pull request');
  if (pr.baseRefName && pr.baseRefName !== cfg.git.baseBranch) return res('skipped', `the PR targets ${pr.baseRefName}, not ${cfg.git.baseBranch}`);
  const server = originOfPrUrl(pub.pr_url);
  if (!server) return res('skipped', `the recorded PR URL ${String(pub.pr_url)} is not a github.com pull request`);
  const head = pub.head_sha;
  if (pr.headRefOid !== head) return adoptOrForeign(x, task, pub, pr, server, res);

  // Required checks at the approved head: failing -> repair; timed out -> a notification.
  const ciRow = d.db.evidenceFor(task.id, head, 'ci');
  const lastCi = ciRow.at(-1)?.outcome ?? '';
  const pendingLong = lastCi.endsWith(':awaiting-ci') && ciRow[0] && x.now().getTime() - Date.parse(ciRow[0].recorded_at) > ciTimeoutOf(cfg) * 60_000;
  if (lastCi.endsWith(':failing') || pendingLong) {
    const gate = await d.ciGate(task.id, head);
    if (gate.state === 'fail') return ciRepair(x, task, pub, gate, res);
    if (gate.state === 'timeout') {
      enqueueOnce(d.db, `ci-timeout:${task.id}:${head}`, 'status', task.id, `${task.id}: required checks still pending at ${head.slice(0, 12)} on ${task.prUrl} (${gate.pending.join(', ')}); the task stays delivered. Re-run CI on GitHub or push a fix.`);
      return res('ci-timeout', formatCiGate(gate));
    }
  }

  if (mss === 'UNKNOWN' || (!mss && upper(pr.mergeable) === 'UNKNOWN')) return res('retry', 'GitHub is still computing the merge state; retry on the next pass');
  const conflicting = mss === 'DIRTY' || upper(pr.mergeable) === 'CONFLICTING';
  if (mss !== 'BEHIND' && !conflicting) return res('none', `merge state ${mss ?? 'unknown'}: the merge pass decides`);
  return baseUpdate(x, task, pub, conflicting, server, res);
}

type Res = (action: ScanAction, message: string, extra?: Partial<ScanTaskResult>) => ScanTaskResult;

function enqueueOnce(db: RuntimeDb, key: string, kind: string, taskId: string, text: string): void {
  try { enqueue(db, { key, kind, taskId, text }); } catch (e) { db.addEvent('pr-scan-notify-error', taskId, { key, error: (e as Error).message }); }
}

async function ciRepair(x: Ctx, task: Task, pub: PublicationRow, gate: CiGate, res: Res): Promise<ScanTaskResult> {
  const { d } = x;
  const head = pub.head_sha;
  const link = d.db.evidenceFor(task.id, head, BASE_UPDATE_KIND).at(-1);
  const rec = link ? parseBaseUpdate(link) : null;
  const findings = [
    `required checks fail at the approved head ${head} on ${task.prUrl}: ${gate.failed.join(', ')}`,
    ...(rec ? [`${head.slice(0, 12)} is a base update by minions (a clean textual merge of ${cfg(x).git.baseBranch} at ${rec.base.slice(0, 12)} into the reviewed head ${rec.from.slice(0, 12)}), so this is likely a semantic conflict with ${cfg(x).git.baseBranch}: fix the code on top of ${head.slice(0, 12)}; never rebase or force-push`] : []),
  ];
  const disarm = await disarmIfOurs(x, task, pub, 'required checks failing');
  if (disarm) return res('skipped', `required checks fail, but ${disarm}; retried on the next pass`);
  const r = await d.ciRepair(task.id, head, findings);
  return res('ci-repair', `${formatCiGate(gate)}; task delivered -> ${r.to} (repair cycle ${r.repairCycles}${r.replan ? ', the limit: replan' : ''})`, { to: r.to, repairCycles: r.repairCycles });
}
const cfg = (x: Ctx) => x.cfg;

/** Disarms GitHub auto-merge when minions armed it. Returns an error message, or null when nothing is armed by minions any more. */
async function disarmIfOurs(x: Ctx, task: Task, pub: PublicationRow, why: string): Promise<string | null> {
  const { d } = x;
  const history = d.db.evidenceOfKind(task.id, 'merge');
  if (!armedByMinions(history)) return null;
  const r = await d.gh(['pr', 'merge', task.prUrl!, '--disable-auto'], { cwd: GH_CWD, ...sig(d) });
  if (r.code !== 0) {
    const err = `gh pr merge --disable-auto failed: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`;
    d.db.addEvent('merge', task.id, { state: 'failed', head: pub.head_sha, prUrl: task.prUrl, error: err });
    return `auto-merge could not be disabled (${err})`;
  }
  d.db.addEvidence({ task_id: task.id, head_sha: pub.head_sha, kind: 'merge', config_revision: d.config.configRevision, outcome: 'disarmed',
    details_json: JSON.stringify({ prUrl: task.prUrl, reasons: [why], by: 'pr-scan' }) });
  d.db.addEvent('merge', task.id, { state: 'disarmed', head: pub.head_sha, prUrl: task.prUrl, reasons: [why] });
  return null;
}

/** Moves the local task branch (and its clean worktree) forward from `from` to `to`; never a reset. */
async function moveLocalBranch(d: ScanDeps, branch: string, from: string, to: string): Promise<string | null> {
  const wt = (await listWorktrees(d.repo)).find((w) => w.branch === branch);
  const r = wt
    ? await d.git(wt.path, ['merge', '--ff-only', '--quiet', to], true)
    : await d.git(d.repo, ['update-ref', '-m', 'minions: base update', `refs/heads/${branch}`, to, from], true);
  return r.code === 0 ? null : `cannot move ${branch} to ${to.slice(0, 12)}: ${short(r.stderr || r.stdout) || `git exit ${r.code}`}`;
}

/** The PR head moved off the approved head: adopt it only when it is a verified base update of it. */
async function adoptOrForeign(x: Ctx, task: Task, pub: PublicationRow, pr: ScanPr, server: ServerOrigin, res: Res): Promise<ScanTaskResult> {
  const { d, cfg } = x;
  const head = pub.head_sha, prHead = pr.headRefOid;
  const record = d.db.evidenceFor(task.id, prHead, BASE_UPDATE_KIND).at(-1);
  const rec = record ? parseBaseUpdate(record) : null;
  if (rec && rec.from === head && await commitExists(d.repo, prHead, sig(d))) {
    const vb = await verifiedServerBase({ repo: d.repo, gh: d.gh, origin: server, base: cfg.git.baseBranch, ...srv(d) });
    // Not verifiable now (gh down, a git/API mismatch): neither adopted nor reported as foreign; the next pass retries.
    if ('error' in vb) return res('skipped', `the PR head ${prHead.slice(0, 12)} may be a base update of ${head.slice(0, 12)}, but ${vb.error}`);
    const link = await verifyLink(d.repo, prHead, record, { serverBase: vb.sha, configRevision: cfg.configRevision, ...sig(d) });
    if (!link.problems.length && link.from === head) {
      const local = await headOf(d.repo, pub.branch);
      const moved = local === prHead ? null : local === head ? await moveLocalBranch(d, pub.branch, head, prHead) : `${pub.branch} is at ${String(local).slice(0, 12)}`;
      if (moved) return res('skipped', `the PR head ${prHead.slice(0, 12)} is a verified base update, but ${moved}`);
      if (!d.db.movePublicationHead(task.id, head, prHead)) return res('skipped', 'the publication changed concurrently');
      d.db.addEvent('base-update', task.id, { state: 'pushed', adopted: true, from: head, base: rec.base, head: prHead, tree: rec.tree });
      await note(d, task.id, `minions: adopted the base update ${prHead.slice(0, 12)} of ${head.slice(0, 12)} (verified merge of ${cfg.git.baseBranch} at ${rec.base.slice(0, 12)}); CI must pass at the new head.`);
      return res('adopted', `PR head ${prHead.slice(0, 12)} is a verified base update of ${head.slice(0, 12)}; publication head moved`, { newHead: prHead, base: rec.base });
    }
  }
  if (!d.db.events(task.id, 'foreign-push').some((e) => (e.data as { head?: string } | null)?.head === prHead)) {
    d.db.addEvent('foreign-push', task.id, { head: prHead, approved: head, prUrl: task.prUrl });
    enqueueOnce(d.db, `foreign-push:${task.id}:${prHead}`, 'status', task.id, `${task.id}: ${task.prUrl} was pushed to ${prHead.slice(0, 12)} outside minions; the approved head is ${head.slice(0, 12)}. Auto-merge waits; test and review the new head, or restore the branch.`);
  }
  return res('foreign-push', `PR head ${prHead.slice(0, 12)} is not the approved head ${head.slice(0, 12)} and not a verified base update of it; left alone`);
}

async function note(d: ScanDeps, taskId: string, text: string): Promise<void> {
  try { await d.backlog.addNote(taskId, text); } catch (e) { d.db.addEvent('pr-scan-backlog-error', taskId, { error: (e as Error).message }); }
}

/** BEHIND (or DIRTY): fetch, merge-tree, and when clean commit-tree + disarm + fast-forward push. */
async function baseUpdate(x: Ctx, task: Task, pub: PublicationRow, conflicting: boolean, server: ServerOrigin, res: Res): Promise<ScanTaskResult> {
  const { d, cfg } = x;
  const base = cfg.git.baseBranch;
  const H = pub.head_sha;
  // Every git call the update's result depends on runs with the allowlisted environment in an isolated git
  // dir (base-update.ts header), never through d.git; the server is the recorded origin URL, and its base is
  // cross-checked with the GitHub API. d.git only moves the local branch (and reads the reviewed paths).
  const vb = await verifiedServerBase({ repo: d.repo, gh: d.gh, origin: server, base, ...srv(d) });
  if ('error' in vb) return res('skipped', `no base update: ${vb.error}`);
  const B = vb.sha;
  if (!(await commitExists(d.repo, B, sig(d)))) {
    const haves = [H, ...d.db.leases({ taskId: task.id, all: true }).map((l) => l.base_sha ?? '')];
    const fetched = await fetchBase(d.repo, server, base, { ...srv(d), haves });
    if (!fetched.ok) return res('skipped', fetched.message);
    if (!(await commitExists(d.repo, B, sig(d)))) return res('skipped', `origin's ${base} at ${B.slice(0, 12)} could not be fetched`);
  }
  if ((await isolatedGit(d.repo, ['merge-base', '--is-ancestor', B, H], sig(d))).code === 0) return res('none', `${H.slice(0, 12)} already contains ${base} at ${B.slice(0, 12)} (GitHub's state is stale)`);

  const mt = await mergeTree(d.repo, H, B, sig(d));
  if (mt.state === 'conflict') {
    const info: ConflictInfo = { taskId: task.id, prUrl: task.prUrl!, head: H, base: B, baseBranch: base, files: mt.files };
    if (!d.db.events(task.id, 'pr-conflict').some((e) => { const v = e.data as { head?: string; base?: string } | null; return v?.head === H && v?.base === B; })) {
      d.db.addEvent('pr-conflict', task.id, { head: H, base: B, files: mt.files, prUrl: task.prUrl });
    }
    if (d.onConflict) await d.onConflict(info);
    else enqueueOnce(d.db, `pr-conflict:${task.id}:${H}`, 'status', task.id, `${task.id}: ${task.prUrl} conflicts with ${base} at ${B.slice(0, 12)} in ${mt.files.slice(0, 10).join(', ')}; it needs a merge of origin/${base} into the branch.`);
    return res('conflict', `conflicts with ${base} at ${B.slice(0, 12)} in ${mt.files.slice(0, 10).join(', ')}`, { conflictFiles: mt.files, base: B });
  }
  if (mt.state !== 'clean') return res('skipped', `no base update: ${mt.message}`);

  // A clean merge: one base update in flight across all PRs, a daily cap per task, and the budget.
  if (x.inFlight && x.inFlight !== task.id) return res('deferred', `a base update of ${x.inFlight} is waiting for CI (one in flight)`);
  if (x.inFlight === task.id) return res('deferred', 'this task\'s last base update is still waiting for CI');
  const max = cfg.routine?.maxBaseUpdatesPerTask ?? DEFAULT_MAX_BASE_UPDATES_PER_TASK;
  const done = baseUpdatesToday(d.db, task.id, x.now());
  if (done >= max) return res('skipped', `routine.maxBaseUpdatesPerTask reached (${done}/${max} in 24 hours)`);
  if (d.deadline !== undefined && d.deadline - x.now().getTime() < BASE_UPDATE_MIN_MS) return res('deferred', 'scan budget exhausted; the next pass updates it');

  const local = await headOf(d.repo, pub.branch);
  if (local !== H) return res('skipped', `${pub.branch} is at ${String(local).slice(0, 12)}, not the approved head`);
  const wt = (await listWorktrees(d.repo)).find((w) => w.branch === pub.branch);
  if (wt && await isDirty(wt.path)) return res('skipped', `the worktree ${wt.path} has uncommitted changes`);
  const remoteHead = await serverRefOf(d.repo, server, pub.branch, srv(d));
  if (remoteHead !== H) return res('skipped', `origin/${pub.branch} is at ${String(remoteHead).slice(0, 12)}, not the approved head`);

  const made = await commitMerge(d.repo, { tree: mt.tree, head: H, base: B, baseBranch: base, identity: cfg.git.identity }, sig(d));
  if ('error' in made) return res('base-update-failed', made.error);
  const H2 = made.sha;
  // Policy for the push: the reviewed paths plus what the merge commit changes against the verified base (a union).
  const gated = await gateChangedPaths({ git: d.git, repo: d.repo, remote: server.https, base, head: H, branch: pub.branch, serverBase: B,
    baseShas: d.db.leases({ taskId: task.id, all: true }).map((l) => l.base_sha), sensitivePaths: cfg.sensitivePaths });
  if (!gated.ok) return res('skipped', `no base update: ${gated.message}`);
  const diff = await isolatedGit(d.repo, ['diff', '--name-only', '--no-renames', '-z', B, H2], sig(d));
  if (diff.code !== 0) return res('skipped', `cannot diff ${H2.slice(0, 12)} against ${B.slice(0, 12)}`);
  const paths = [...new Set([...gated.changedPaths, ...diff.stdout.split('\0').filter(Boolean)])];
  const push = can(cfg, 'git.push', { paths });
  if (push !== 'allow') return res('skipped', `git.push is "${push}" for this branch's paths; a base update needs it allowed (a human approval is per head)`);

  const disarm = await disarmIfOurs(x, task, pub, 'base update');
  if (disarm) return res('base-update-failed', `not pushed: ${disarm}`);
  // The record goes first (a hint, verified from git objects by the merge gate), so a crash after the push
  // is adopted on the next pass instead of looking like a foreign push.
  d.db.addEvidence({ task_id: task.id, head_sha: H2, kind: BASE_UPDATE_KIND, config_revision: cfg.configRevision, outcome: 'prepared',
    details_json: JSON.stringify({ from: H, base: B, tree: mt.tree }) });
  // To the recorded URL from the isolated dir: no pushInsteadOf / pushurl can send it elsewhere while the
  // publication head moves.
  const p = await pushToServer(d.repo, server, H2, pub.branch, srv(d));
  if (p.code !== 0) {
    const err = short(p.stderr || p.stdout) || `git exit ${p.code}`;
    const raced = /non-fast-forward|fetch first|rejected|stale info/i.test(p.stderr + p.stdout);
    d.db.addEvent('base-update', task.id, { state: 'rejected', from: H, base: B, head: H2, error: err });
    return res('base-update-failed', raced ? `push rejected (someone else pushed ${pub.branch}); skipped, retried after the next sync` : `push failed: ${err}`);
  }
  const moved = await moveLocalBranch(d, pub.branch, H, H2);
  if (!d.db.movePublicationHead(task.id, H, H2)) return res('base-update-failed', `pushed ${H2.slice(0, 12)}, but the publication changed concurrently; the next pass adopts or reports it`);
  d.db.addEvent('base-update', task.id, { state: 'pushed', from: H, base: B, head: H2, tree: mt.tree, conflicting, ...(moved ? { localWarning: moved } : {}) });
  x.inFlight = task.id;
  await note(d, task.id, `minions: base update ${H.slice(0, 12)} -> ${H2.slice(0, 12)}: merged ${base} at ${B.slice(0, 12)} (clean merge-tree, fast-forward push to ${task.prUrl}); reviewer approval carries over, CI must pass at the new head.`);
  return res('base-updated', `merged ${base} at ${B.slice(0, 12)}: ${H.slice(0, 12)} -> ${H2.slice(0, 12)} (fast-forward); CI must pass again${moved ? ` (warning: ${moved})` : ''}`, { newHead: H2, base: B });
}

export interface ScanField { state: ScanReport['state'] | 'error'; message: string; report?: ScanReport }

/**
 * The scan after `work record` / `work release`: bounded (default 60 s), never throws, never changes the
 * record outcome. The deadline stops new base updates; at the budget the signal aborts, which kills the
 * scan's in-flight git and gh children (SIGTERM, then SIGKILL after 2 s) and stops it before the next
 * task, and the caller stops waiting. A push killed mid-way is the crash window the next scan adopts.
 */
export async function boundedScan(run: (deadline: number, signal: AbortSignal) => Promise<ScanReport>, budgetMs = SCAN_AFTER_SLOT_BUDGET_MS, now: () => number = Date.now): Promise<ScanField> {
  const deadline = now() + budgetMs;
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ScanField>((resolve) => {
    timer = setTimeout(() => { ctl.abort(); resolve({ state: 'budget', message: `PR scan stopped after ${Math.round(budgetMs / 1000)} s (in-flight git/gh calls cancelled); the next pass continues.` }); }, budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(deadline, ctl.signal)).then((r): ScanField => ({ state: r.state, message: r.message, report: r }), (e: unknown): ScanField => ({ state: 'error', message: `PR scan failed: ${short(String((e as Error)?.message ?? e))}` })),
      timeout,
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
