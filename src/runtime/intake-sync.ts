// GitHub-filtered intake sync (decision record: docs/design/bootstrap.md, "GitHub intake sync").
//
// - Source, not backend: matching GitHub issues are imported into the existing Backlog.md backlog. The
//   GitHub Issues backend stays deferred.
// - Read-only on GitHub: every call is `gh api --method GET` (the gh wrapper injects the mounted token).
//   minions never comments, labels, assigns or closes issues.
// - Additive and idempotent: one task per issue, keyed `intake:gh:<owner>/<repo>#<n>` (idempotency table)
//   and linked by the issue URL (task meta `externalLinks`). Reruns create nothing new; tasks are never
//   deleted and their title/description are never overwritten. minions only updates its own sync record
//   (meta row `intake_github`) and, on reconciliation, the task status.
// - Intake pause: the keys start with `intake:`, so while intake is paused new issues are skipped and
//   counted (`skippedIntakePaused`); the sync itself never fails because of the pause, and reconciliation
//   of already-imported issues still runs.
// - Reconciliation: an imported issue that leaves the filter (labels, milestone, assignee, state or
//   repository changed, issue closed or no longer visible) or is reassigned (the recorded assignees were
//   non-empty and changed) pauses the linked task: status `blocked` plus a note, and an `intake-reconcile`
//   event. Finished tasks (done/delivered/cancelled) are left alone; a task with an active lease is
//   paused on a later sync. A task whose issue comes back is not resumed automatically (event + note).
//   Departures are only evaluated after a complete query; a failed or truncated query never pauses.
import type { BacklogAdapter, Task, TaskStatus } from '../backlog/types.js';
import { neutralizeComments } from '../backlog/backlogmd.js';
import { isIntakeCreation } from '../backlog/intake.js';
import type { MinionsConfig } from '../config/schema.js';
import { redact } from '../core/output.js';
import { ghApi, type ApiGet } from './ci.js';
import type { RuntimeDb } from './db.js';
import { normalizeGithubRemote, type GitFn } from './github.js';
import type { GhFn } from './publish.js';

export type GithubIntakeConfig = NonNullable<MinionsConfig['intake']['github']>;

export const INTAKE_STATE_META = 'intake_github';
export const INTAKE_MAX_PAGES = 10;
const PER_PAGE = 100;
const MAX_BODY = 20_000;
const FINISHED: TaskStatus[] = ['done', 'delivered', 'cancelled'];

/** Idempotency key of an imported issue (starts with `intake:`, so a paused intake refuses it). */
export const intakeKey = (repository: string, n: number) => `intake:gh:${repository.toLowerCase()}#${n}`;

export interface GhIssue {
  number: number; title: string; body: string | null; html_url: string; state: string;
  assignees: string[]; labels: string[]; milestone: string | null;
}

interface IssueRecord {
  taskId: string; url: string; repository: string; number: number;
  assignees: string[]; inFilter: boolean;
  /** A pause that could not be applied yet (active lease); retried on every sync. */
  pending?: { reason: ReconcileReason; detail: string };
  lastSeenAt: string;
}
interface IntakeState { version: 1; issues: Record<string, IssueRecord> }

export type ReconcileReason = 'left-filter' | 'closed' | 'not-visible' | 'reassigned' | 'returned';
export type ReconcileAction = 'paused' | 'already-blocked' | 'finished' | 'lease-active' | 'none' | 'missing';
export interface Reconciliation { key: string; taskId: string; url: string; reason: ReconcileReason; action: ReconcileAction; detail: string }

export interface IntakeSyncReport {
  enabled: boolean;
  repository: string | null;
  /**
   * Issues returned by the filter (pull requests excluded); a lower bound when the list was truncated.
   * null when the list was not read (failed or aborted read, no repository): the count is unknown.
   */
  matched: number | null;
  created: string[];
  existing: number;
  /** New issues not imported because intake is paused (`minions resume --intake`). */
  skippedIntakePaused: number;
  reconciliations: Reconciliation[];
  /** The query covered every matching issue (departures are only evaluated then). */
  complete: boolean;
  warnings: string[];
  errors: string[];
}

export interface IntakeSyncDeps {
  db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig;
  gh?: GhFn;
  /** Read-only GitHub GET (default: `gh api --method GET` over `gh`). */
  api?: ApiGet;
  /** Resolves the repository when `intake.github.repository` is null (the workspace origin). */
  originRepository?: () => Promise<string | null>;
  now?: () => Date;
  /**
   * Overall budget (coordinator startup): once aborted, in-flight GitHub reads resolve as failed, no new
   * ones start, the import stops and departures are not evaluated. What was imported so far is kept.
   */
  signal?: AbortSignal;
}

export const INTAKE_ABORTED = 'intake sync stopped: time budget exhausted';

/** ApiGet that resolves as failed as soon as `signal` aborts (the caller never waits past the budget). */
function abortable(api: ApiGet, signal: AbortSignal | undefined): ApiGet {
  if (!signal) return api;
  const failed = { status: 0, body: null, error: INTAKE_ABORTED };
  const onAbort = new Promise<typeof failed>((resolve) => {
    if (signal.aborted) resolve(failed); else signal.addEventListener('abort', () => resolve(failed), { once: true });
  });
  return (path) => (signal.aborted ? Promise.resolve(failed) : Promise.race([api(path).catch((e: Error) => ({ status: 0, body: null, error: e.message })), onAbort]));
}

const segs = (s: string) => s.split('/').map(encodeURIComponent).join('/');
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const emptyReport = (enabled: boolean, repository: string | null): IntakeSyncReport =>
  ({ enabled, repository, matched: enabled ? null : 0, created: [], existing: 0, skippedIntakePaused: 0, reconciliations: [], complete: false, warnings: [], errors: [] });

/** `owner/repo` of the workspace origin, or null when it is not a github.com repository. */
export async function originRepository(repoDir: string, git: GitFn): Promise<string | null> {
  const o = await git(repoDir, ['config', '--get', 'remote.origin.url'], true);
  const https = o.code === 0 ? normalizeGithubRemote(o.stdout.trim()) : null;
  return https ? https.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : null;
}

function toIssue(raw: unknown): GhIssue | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.pull_request) return null; // the issues endpoint also lists pull requests
  if (typeof r.number !== 'number' || typeof r.html_url !== 'string') return null;
  const names = (v: unknown, k: string) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : x)).filter((x): x is string => typeof x === 'string') : []);
  const ms = r.milestone && typeof r.milestone === 'object' ? (r.milestone as { title?: unknown }).title : null;
  return {
    number: r.number, title: typeof r.title === 'string' ? r.title : '', body: typeof r.body === 'string' ? r.body : null,
    html_url: r.html_url, state: typeof r.state === 'string' ? r.state : 'open',
    assignees: names(r.assignees, 'login'), labels: names(r.labels, 'name'), milestone: typeof ms === 'string' ? ms : null,
  };
}

async function resolveMilestone(api: ApiGet, repo: string, m: string | null): Promise<{ value: string | null; error?: string }> {
  if (m === null || m === '*' || m === 'none' || /^\d+$/.test(m)) return { value: m };
  const r = await api(`/repos/${segs(repo)}/milestones?state=all&per_page=100`);
  if (r.status !== 200 || !Array.isArray(r.body)) return { value: null, error: `milestones of ${repo} unreadable: ${r.error ?? `HTTP ${r.status}`}` };
  const hit = (r.body as { number?: unknown; title?: unknown }[]).find((x) => x?.title === m);
  if (!hit || typeof hit.number !== 'number') return { value: null, error: `milestone "${m}" not found in ${repo}` };
  return { value: String(hit.number) };
}

/** Path of one page of the filtered issue list (REST `GET /repos/{repo}/issues`). */
export function issuesPath(repo: string, f: GithubIntakeConfig, milestone: string | null, page: number): string {
  const q = new URLSearchParams({ state: f.state, sort: 'created', direction: 'asc', per_page: String(PER_PAGE), page: String(page) });
  if (f.labels.length) q.set('labels', f.labels.join(','));
  if (f.assignee) q.set('assignee', f.assignee);
  if (milestone) q.set('milestone', milestone);
  return `/repos/${segs(repo)}/issues?${q.toString()}`;
}

/** Runs the scoped, read-only issue query. */
export async function queryIssues(api: ApiGet, repo: string, f: GithubIntakeConfig): Promise<{ issues: GhIssue[]; complete: boolean; error?: string }> {
  const ms = await resolveMilestone(api, repo, f.milestone);
  if (ms.error) return { issues: [], complete: false, error: ms.error };
  const issues: GhIssue[] = [];
  for (let page = 1; page <= INTAKE_MAX_PAGES; page++) {
    const r = await api(issuesPath(repo, f, ms.value, page));
    if (r.status !== 200 || !Array.isArray(r.body)) {
      return { issues, complete: false, error: `issues of ${repo} unreadable: ${r.error ?? `HTTP ${r.status}`}` };
    }
    for (const raw of r.body) { const i = toIssue(raw); if (i) issues.push(i); }
    if (r.body.length < PER_PAGE) return { issues, complete: true };
  }
  return { issues, complete: false };
}

function loadState(db: Pick<RuntimeDb, 'getMeta'>): IntakeState {
  try {
    const v = JSON.parse(db.getMeta(INTAKE_STATE_META) ?? '') as IntakeState;
    if (v && v.version === 1 && v.issues && typeof v.issues === 'object') return v;
  } catch { /* none yet */ }
  return { version: 1, issues: {} };
}

/** Ids of the backlog tasks this sync tracks (meta row `intake_github`). */
export function intakeTrackedTaskIds(db: Pick<RuntimeDb, 'getMeta'>): Set<string> {
  return new Set(Object.values(loadState(db).issues).map((r) => r?.taskId).filter((id): id is string => typeof id === 'string'));
}

/**
 * Backlog provenance fallback (task-39): a tracked task whose meta block is missing or malformed reads
 * as `external-requirement` (what the import wrote), never the adapter default `user-decision`, the most
 * trusted value. Other tasks keep the default. Reads the meta row on every call (only tasks without a
 * usable provenance reach it), so a sync that just ran is seen at once.
 */
export const intakeProvenanceFallback = (db: () => Pick<RuntimeDb, 'getMeta'>) =>
  (taskId: string): 'external-requirement' | undefined => (intakeTrackedTaskIds(db()).has(taskId) ? 'external-requirement' : undefined);

function describeIssue(issue: GhIssue): string {
  const body = (issue.body ?? '').trim();
  const capped = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n(truncated; see the issue)` : body;
  const facts = [
    issue.labels.length ? `labels: ${issue.labels.join(', ')}` : null,
    issue.assignees.length ? `assignees: ${issue.assignees.join(', ')}` : null,
    issue.milestone ? `milestone: ${issue.milestone}` : null,
  ].filter(Boolean).join('; ');
  // Untrusted text: comment openers are neutralised so the issue cannot forge a minions meta block.
  return neutralizeComments([capped, `Imported from GitHub issue ${issue.html_url} by minions intake sync${facts ? ` (${facts})` : ''}.`].filter(Boolean).join('\n\n'));
}

const titleOf = (issue: GhIssue) => neutralizeComments(issue.title.replace(/\s+/g, ' ').trim()) || `GitHub issue #${issue.number}`;

/**
 * One intake pass: imports issues matching `intake.github` into the backlog and reconciles imported
 * issues that left the filter or were reassigned. Never writes to GitHub, never deletes tasks, never
 * throws for GitHub or per-issue failures (they are reported in `errors`).
 */
export async function syncIntake(deps: IntakeSyncDeps): Promise<IntakeSyncReport> {
  const f = deps.config.intake.github;
  if (!f?.enabled) return emptyReport(false, f?.repository ?? null);
  const { db, backlog } = deps;
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const repo = f.repository ?? (await deps.originRepository?.().catch(() => null)) ?? null;
  const report = emptyReport(true, repo);
  const finish = () => {
    db.addEvent('intake-sync', null, {
      repository: repo, matched: report.matched, created: report.created.length, existing: report.existing,
      skippedIntakePaused: report.skippedIntakePaused, reconciliations: report.reconciliations.length, complete: report.complete, errors: report.errors.length,
    });
    return report;
  };
  if (!repo) { report.errors.push('intake.github.repository is null and the workspace origin is not a github.com repository'); return finish(); }

  const api = abortable(deps.api ?? ghApi(deps.gh), deps.signal);
  const aborted = () => deps.signal?.aborted === true;
  const q = await queryIssues(api, repo, f);
  report.complete = q.complete;
  // A failed or aborted list read leaves `matched` null: the pages read so far say nothing about the total.
  if (q.error) { report.errors.push(redact(q.error)); return finish(); }
  report.matched = q.issues.length;
  if (!q.complete) report.warnings.push(`more than ${INTAKE_MAX_PAGES * PER_PAGE} matching issues: imported the first ${q.issues.length}; departures were not evaluated (narrow the filter)`);

  const state = loadState(db);
  const intakePaused = db.paused().intake;
  let tasks: Task[];
  try { tasks = await backlog.listTasks(); } catch (e) { report.errors.push(`backlog unreadable: ${redact((e as Error).message)}`); return finish(); }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byLink = new Map<string, Task>();
  for (const t of tasks) for (const l of t.externalLinks) byLink.set(l, t);
  const leased = new Set(db.activeLeases().map((l) => l.task_id));

  const reconcile = async (key: string, rec: IssueRecord, reason: ReconcileReason, detail: string): Promise<Reconciliation> => {
    const out: Reconciliation = { key, taskId: rec.taskId, url: rec.url, reason, action: 'none', detail };
    try {
      const task = await backlog.getTask(rec.taskId).catch(() => null);
      if (!task) out.action = 'missing';
      else if (reason === 'returned') {
        await backlog.addNote(task.id, `minions intake sync: ${rec.url} matches the intake filter again. The task is not resumed automatically${task.status === 'blocked' ? '; set it back to ready or idea if it should continue' : ''}.`);
      } else if (FINISHED.includes(task.status)) out.action = 'finished';
      else if (task.status === 'blocked') out.action = 'already-blocked';
      else if (leased.has(task.id)) out.action = 'lease-active';
      else {
        await backlog.updateTask(task.id, task.version, { status: 'blocked' });
        await backlog.addNote(task.id, `minions intake sync: ${rec.url} ${detail}; task paused (status ${task.status} -> blocked). Nothing was deleted. Check the issue, then set the task back to ${task.status} or cancel it.`);
        out.action = 'paused';
        out.detail = `${detail}; status ${task.status} -> blocked`;
      }
    } catch (e) {
      report.errors.push(`${rec.taskId}: reconciliation failed: ${redact((e as Error).message)}`);
      out.action = 'none';
      return out;
    }
    if (out.action === 'lease-active') rec.pending = { reason, detail }; else delete rec.pending;
    if (out.action === 'lease-active') report.warnings.push(`${rec.taskId} has an active lease; it is paused on a later sync`);
    db.addEvent('intake-reconcile', rec.taskId, { key, url: rec.url, reason, action: out.action, detail: out.detail });
    report.reconciliations.push(out);
    return out;
  };

  const seen = new Set<string>();
  for (const issue of q.issues) {
    if (aborted()) break;
    const key = intakeKey(repo, issue.number);
    seen.add(key);
    let rec = state.issues[key];
    const linked = rec?.taskId ?? db.idempotency.get(key) ?? byLink.get(issue.html_url)?.id;
    if (linked) {
      if (!byId.has(linked)) { report.warnings.push(`${key}: linked task ${linked} is no longer in the backlog; not imported again`); continue; }
      report.existing++;
      try { db.idempotency.put(key, linked); } catch { /* the key maps elsewhere; keep the recorded link */ }
      if (!rec) rec = state.issues[key] = { taskId: linked, url: issue.html_url, repository: repo, number: issue.number, assignees: issue.assignees, inFilter: true, lastSeenAt: now() };
      if (!rec.inFilter) {
        rec.inFilter = true;
        delete rec.pending;
        await reconcile(key, rec, 'returned', 'matches the filter again');
      } else if (rec.assignees.length && !sameSet(rec.assignees, issue.assignees)) {
        await reconcile(key, rec, 'reassigned', `was reassigned (${rec.assignees.join(', ')} -> ${issue.assignees.join(', ') || 'nobody'})`);
      } else if (rec.pending) {
        await reconcile(key, rec, rec.pending.reason, rec.pending.detail);
      }
      rec.assignees = issue.assignees;
      rec.lastSeenAt = now();
      continue;
    }
    const input = {
      title: titleOf(issue), description: describeIssue(issue), provenance: 'external-requirement' as const,
      idempotencyKey: key, externalLinks: [issue.html_url],
    };
    if (intakePaused && isIntakeCreation(input)) { report.skippedIntakePaused++; continue; }
    try {
      const r = await backlog.createTask(input);
      db.idempotency.put(key, r.task.id);
      state.issues[key] = { taskId: r.task.id, url: issue.html_url, repository: repo, number: issue.number, assignees: issue.assignees, inFilter: true, lastSeenAt: now() };
      if (r.created) {
        report.created.push(r.task.id);
        db.addEvent('intake-import', r.task.id, { key, url: issue.html_url });
      } else report.existing++;
    } catch (e) {
      report.errors.push(`${key}: import failed: ${redact((e as Error).message)}`);
    }
  }

  // Departures: only after a complete query, so a failed or truncated read never pauses anything.
  // An aborted pass may not have looked at every matching issue, so it never evaluates departures.
  if (q.complete && !aborted()) {
    for (const [key, rec] of Object.entries(state.issues)) {
      if (aborted()) break;
      if (seen.has(key)) continue;
      const departed = rec.inFilter;
      if (!departed && !rec.pending) continue;
      let reason: ReconcileReason = rec.pending?.reason ?? 'left-filter';
      let detail = rec.pending?.detail ?? 'no longer matches the intake filter';
      if (departed) {
        const cur = await api(`/repos/${segs(rec.repository)}/issues/${rec.number}`);
        const issue = cur.status === 200 ? toIssue(cur.body) : null;
        if (cur.status === 404 || cur.status === 410) { reason = 'not-visible'; detail = 'is no longer visible (deleted, transferred or access removed)'; }
        else if (issue && issue.state === 'closed' && f.state === 'open') { reason = 'closed'; detail = 'was closed'; }
        else if (issue && rec.assignees.length && !sameSet(rec.assignees, issue.assignees)) {
          reason = 'reassigned'; detail = `was reassigned (${rec.assignees.join(', ')} -> ${issue.assignees.join(', ') || 'nobody'}) and no longer matches the intake filter`;
        } else if (rec.repository.toLowerCase() !== repo.toLowerCase()) detail = `is in ${rec.repository}, outside the configured repository ${repo}`;
        if (aborted()) break; // the read was cut short: decide on a later sync
        if (issue) rec.assignees = issue.assignees;
      }
      rec.inFilter = false;
      await reconcile(key, rec, reason, detail);
    }
  }

  if (aborted()) report.warnings.push(`${INTAKE_ABORTED}; the rest runs on the next \`minions sync\``);
  db.setMeta(INTAKE_STATE_META, JSON.stringify(state));
  return finish();
}

export function formatIntake(r: IntakeSyncReport): string {
  if (!r.enabled) return 'Intake sync: off (intake.github is not enabled).';
  const from = `Intake sync from ${r.repository ?? '(no repository)'}`;
  if (r.matched === null) {
    return [`${from}: issue list not read, nothing imported`, ...r.warnings.map((w) => `  warning: ${w}`), ...r.errors.map((e) => `  error: ${e}`)].join('\n');
  }
  const L = [`${from}: ${r.complete ? '' : 'at least '}${r.matched} matching issue(s), ${r.created.length} imported${r.created.length ? ` (${r.created.join(', ')})` : ''}, ${r.existing} already in the backlog` +
    (r.skippedIntakePaused ? `, ${r.skippedIntakePaused} skipped (intake is paused; \`minions resume --intake\`)` : '')];
  for (const c of r.reconciliations) L.push(`  ${c.taskId}: ${c.reason} -> ${c.action} (${c.detail})  ${c.url}`);
  for (const w of r.warnings) L.push(`  warning: ${w}`);
  for (const e of r.errors) L.push(`  error: ${e}`);
  return L.join('\n');
}
