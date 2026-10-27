// CI awareness for GitHub delivery (decision record: docs/design/bootstrap.md, "CI awareness").
//
// - Read-only against GitHub: REST GETs (`gh api --method GET` in the container, a plain GET with the
//   stored token on the host) plus a read-only `gh pr view --json` GraphQL query in sync (sent as a
//   POST, but a query, never a mutation). minions never creates workflows, never edits branch
//   protection or rulesets, and never merges (the opt-in auto-merge pass lives in merge.ts).
// - Required checks: classic branch protection (`GET /repos/{repo}/branches/{base}`, whose
//   `protection.required_status_checks` is readable with repository read access) plus rulesets
//   (`GET /repos/{repo}/rules/branches/{base}`, rules of type `required_status_checks`).
// - `minions sync` refreshes PR state and check results for tasks with a prUrl. It is an explicit,
//   one-shot command (no LLM polling loop): observations are recorded as `ci` evidence bound to the PR
//   head SHA, a task note is added only when the observation changes, and merged/closed PRs are
//   reconciled (merged -> done; closed without merge -> blocked).
import type { BacklogAdapter, Task, TaskStatus } from '../backlog/types.js';
import type { MinionsConfig } from '../config/schema.js';
import { redact } from '../core/output.js';
import type { RuntimeDb } from './db.js';
import { normalizeGithubRemote, type GitFn } from './github.js';
import { realGh, type GhFn } from './publish.js';
import { ciTimeoutOf, evaluateCiGate, formatCiGate, type CiGate } from './ci-gate.js';
import type { MergeResult } from './merge.js';

// ---------------------------------------------------------------- read-only API access

export interface ApiResponse { status: number; body: unknown; error?: string }
/**
 * Read-only GitHub REST GET (path relative to https://api.github.com, e.g. `/repos/o/r`). status 0 =
 * transport failure. Only REST reads go through ApiGet; sync's `gh pr view --json` is a separate
 * read-only GraphQL query.
 */
export type ApiGet = (path: string) => Promise<ApiResponse>;

const short = (s: string) => redact(s.trim().split('\n').slice(-2).join(' | ')).slice(0, 300);

/** ApiGet over `gh api` (container: the gh wrapper injects the mounted token). Always a REST `--method GET`. */
export function ghApi(gh: GhFn = realGh): ApiGet {
  return async (path) => {
    const r = await gh(['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', path]);
    let body: unknown = null;
    try { body = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* non-JSON */ }
    if (r.code === 0) return { status: 200, body };
    const m = /HTTP (\d{3})/.exec(r.stderr);
    return { status: m ? Number(m[1]) : 0, body, error: short(r.stderr || r.stdout) || `gh exit ${r.code}` };
  };
}

/** ApiGet over fetch with a token (host side, e.g. doctor when the container is not running). Always a REST GET. */
export function fetchApi(token: string, f: typeof fetch = fetch, timeoutMs = 10_000): ApiGet {
  return async (path) => {
    try {
      const res = await f(`https://api.github.com${path}`, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'minions' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      const msg = (body as { message?: unknown } | null)?.message;
      return { status: res.status, body, ...(res.ok ? {} : { error: `HTTP ${res.status}${typeof msg === 'string' ? `: ${redact(msg).slice(0, 200)}` : ''}` }) };
    } catch (e) {
      return { status: 0, body: null, error: short(String((e as Error).message ?? e)) };
    }
  };
}

// ---------------------------------------------------------------- required checks

export interface RequiredChecksReport {
  repository: string;
  baseBranch: string;
  /** configured: at least one required status check applies to the base; none: verified that none do; unknown: could not tell. */
  state: 'configured' | 'none' | 'unknown';
  requiredChecks: string[];
  /**
   * Required checks with the source GitHub pins them to: `appId` is the GitHub App that must report the
   * check (protection `checks[].app_id`, ruleset `integration_id`); null = any source (name-only match).
   */
  requirements?: RequiredCheck[];
  protection: { protected: boolean; contexts: string[] } | null;
  rulesets: { contexts: string[] } | null;
  /** GitHub Actions workflows in the repository (null when not readable). */
  workflows: number | null;
  errors: string[];
}

export interface RequiredCheck { context: string; appId: number | null }

/** A positive app id pins the check to that GitHub App; null / -1 / absent means any source. */
export const pinOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

const segs = (s: string) => s.split('/').map(encodeURIComponent).join('/');

/** Reads required status checks for the base branch. Read-only; never throws for API failures. */
export async function requiredChecksStatus(api: ApiGet, repository: string, baseBranch: string): Promise<RequiredChecksReport> {
  const errors: string[] = [];
  const reqs = new Map<string, RequiredCheck>();
  const require = (context: string, appId: number | null) => { reqs.set(`${context}\0${appId ?? ''}`, { context, appId }); };
  const repo = segs(repository);
  const [b, rules, wf] = await Promise.all([
    api(`/repos/${repo}/branches/${segs(baseBranch)}`),
    api(`/repos/${repo}/rules/branches/${segs(baseBranch)}`),
    api(`/repos/${repo}/actions/workflows?per_page=1`),
  ]);

  let protection: RequiredChecksReport['protection'] = null;
  if (b.status === 200 && b.body && typeof b.body === 'object') {
    const body = b.body as { protected?: boolean; protection?: { required_status_checks?: { enforcement_level?: string; contexts?: unknown; checks?: unknown } } };
    const rsc = body.protection?.required_status_checks;
    const contexts = new Set<string>();
    if (rsc && rsc.enforcement_level !== 'off') {
      // `checks` (with app_id) supersedes the legacy `contexts` list for the same name.
      const pinned = new Set<string>();
      if (Array.isArray(rsc.checks)) {
        for (const c of rsc.checks as { context?: unknown; app_id?: unknown }[]) {
          if (typeof c?.context !== 'string') continue;
          contexts.add(c.context); pinned.add(c.context); require(c.context, pinOf(c.app_id));
        }
      }
      if (Array.isArray(rsc.contexts)) for (const c of rsc.contexts) if (typeof c === 'string') { contexts.add(c); if (!pinned.has(c)) require(c, null); }
    }
    protection = { protected: !!body.protected, contexts: [...contexts] };
  } else {
    errors.push(b.status === 404 ? `branch ${baseBranch} not found in ${repository} (or not visible to the token)` : `branch protection unreadable: ${b.error ?? `HTTP ${b.status}`}`);
  }

  let rulesets: RequiredChecksReport['rulesets'] = null;
  if (rules.status === 200 && Array.isArray(rules.body)) {
    const contexts = new Set<string>();
    for (const r of rules.body as { type?: string; parameters?: { required_status_checks?: { context?: unknown; integration_id?: unknown }[] } }[]) {
      if (r?.type !== 'required_status_checks') continue;
      for (const c of r.parameters?.required_status_checks ?? []) if (typeof c?.context === 'string') { contexts.add(c.context); require(c.context, pinOf(c.integration_id)); }
    }
    rulesets = { contexts: [...contexts] };
  } else if (rules.status !== 404) {
    errors.push(`rulesets unreadable: ${rules.error ?? `HTTP ${rules.status}`}`);
  }

  const workflows = wf.status === 200 && typeof (wf.body as { total_count?: unknown } | null)?.total_count === 'number'
    ? (wf.body as { total_count: number }).total_count : null;

  const requiredChecks = [...new Set([...(protection?.contexts ?? []), ...(rulesets?.contexts ?? [])])].sort();
  // Both sources must be read (a 404 for rules means no rulesets apply): a partial read is `unknown`
  // even when the readable source lists checks, because the unreadable one may require more.
  const complete = !!protection && (!!rulesets || rules.status === 404);
  const state = !complete ? 'unknown' : requiredChecks.length ? 'configured' : 'none';
  const requirements = [...reqs.values()].sort((a, b) => a.context.localeCompare(b.context) || (a.appId ?? 0) - (b.appId ?? 0));
  return { repository, baseBranch, state, requiredChecks, requirements, protection, rulesets, workflows, errors };
}

/** Required checks of the base for the workspace origin via read-only `gh api` GETs; null when origin is not on GitHub. */
export async function readRequiredChecks(repo: string, cfg: Pick<MinionsConfig, 'git'>, deps: { git: GitFn; gh: GhFn }): Promise<RequiredChecksReport | null> {
  const o = await deps.git(repo, ['config', '--get', 'remote.origin.url'], true);
  const https = o.code === 0 ? normalizeGithubRemote(o.stdout.trim()) : null;
  if (!https) return null;
  const repository = https.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  return requiredChecksStatus(ghApi(deps.gh), repository, cfg.git.baseBranch);
}

// ---------------------------------------------------------------- setup guidance

/**
 * Step-by-step external CI setup plan, printed (never applied) when workflows or required checks are
 * missing. minions does not write workflow files or change branch protection.
 * hasWorkflows is tri-state: true = workflows exist (no workflow step), false = none (add one),
 * null = unknown (the workflow step is conditional; never claims they are missing).
 */
export function ciSetupPlan(o: { hasWorkflows: boolean | null; requiredChecks: 'configured' | 'none' | 'unknown'; verificationCommands: string[]; baseBranch: string; repository?: string | null }): string[] {
  // Required checks configured: something already reports them, so nothing to set up unless workflows are definitely absent.
  if (o.requiredChecks === 'configured' && o.hasWorkflows !== false) return [];
  const where = o.repository ? `https://github.com/${o.repository}/settings/branches` : 'the repository Settings -> Branches (or Rules -> Rulesets)';
  const cmds = o.verificationCommands.length ? o.verificationCommands : ['<your build/test commands>'];
  const steps: string[] = ['CI setup (manual; minions never creates workflows or changes branch protection):'];
  let n = 1;
  if (o.hasWorkflows === null) {
    steps.push(`  ${n++}. If the repository has no CI workflow yet (workflows could not be read), add one yourself (for example .github/workflows/ci.yml, reviewed like any change) that runs on pull_request against ${o.baseBranch} and executes the verification commands: ${cmds.join('; ')}.`);
  } else if (o.hasWorkflows === false) {
    steps.push(`  ${n++}. Add a CI workflow yourself (for example .github/workflows/ci.yml, reviewed like any change) that runs on pull_request against ${o.baseBranch} and executes the verification commands: ${cmds.join('; ')}.`);
  }
  steps.push(`  ${n++}. Push it and open a pull request so the check reports at least once (its job name becomes the check name).`);
  steps.push(`  ${n++}. Mark the check required for ${o.baseBranch}: ${where} -> add a branch protection rule or ruleset with "Require status checks to pass" and select the check.`);
  steps.push(`  ${n++}. Run \`minions doctor\`; when it reports the required checks, run \`minions settings set delivery.requiredChecksConfigured true\`.`);
  steps.push('  Until then the project is usable for local work and pull-request delivery; automatic merge stays unavailable.');
  return steps;
}

// ---------------------------------------------------------------- check rollup

export type CiState = 'no-checks' | 'awaiting-ci' | 'passing' | 'failing';
/**
 * Per-check result. pass = SUCCESS / NEUTRAL only; skipped is kept apart because it is never CI
 * evidence; a completed check run with a missing or unrecognised conclusion is pending (fail closed).
 */
export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped';
/** One observed check. `source`: check run or commit status; `appId`: the GitHub App that reported a check run, when known. */
export interface ObservedCheck { name: string; state: CheckState; source?: 'check-run' | 'status'; appId?: number }
export interface CiSummary {
  state: CiState; total: number; passed: number; failed: string[]; pending: string[];
  /** Every check run / status context by name (the CI evidence gate matches required checks against these). */
  checks: ObservedCheck[];
}

interface RollupItem { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string | null; state?: string; appId?: unknown }

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

/** Summarizes `gh pr view --json statusCheckRollup` (check runs and commit statuses). */
export function summarizeChecks(rollup: unknown): CiSummary {
  const items = Array.isArray(rollup) ? (rollup as RollupItem[]) : [];
  const failed: string[] = [], pending: string[] = [];
  const checks: CiSummary['checks'] = [];
  let passed = 0;
  const add = (name: string, state: CheckState, source: ObservedCheck['source'], appId?: unknown) => {
    const app = pinOf(appId);
    checks.push({ name, state, source, ...(app !== null ? { appId: app } : {}) });
    if (state === 'fail') failed.push(name); else if (state === 'pending') pending.push(name); else passed++;
  };
  for (const it of items) {
    const name = String(it.name ?? it.context ?? 'check');
    if (it.__typename === 'StatusContext' || (it.state !== undefined && it.status === undefined)) {
      const s = String(it.state ?? '').toUpperCase();
      add(name, s === 'SUCCESS' ? 'pass' : s === 'FAILURE' || s === 'ERROR' ? 'fail' : 'pending', 'status');
      continue;
    }
    if (String(it.status ?? '').toUpperCase() !== 'COMPLETED') { add(name, 'pending', 'check-run', it.appId); continue; }
    const c = String(it.conclusion ?? '').toUpperCase();
    // Only SUCCESS / NEUTRAL pass. SKIPPED stays apart (the rollup counts it as passed, but it is never CI
    // evidence). A missing or unrecognised conclusion is not a pass: pending, so the gate waits / times out.
    add(name, FAILED_CONCLUSIONS.has(c) ? 'fail' : c === 'SKIPPED' ? 'skipped' : c === 'SUCCESS' || c === 'NEUTRAL' ? 'pass' : 'pending', 'check-run', it.appId);
  }
  const state: CiState = !items.length ? 'no-checks' : failed.length ? 'failing' : pending.length ? 'awaiting-ci' : 'passing';
  return { state, total: items.length, passed, failed, pending, checks };
}

/**
 * Check runs of a commit with the reporting app (`GET /repos/{repo}/commits/{sha}/check-runs`, latest
 * per name and app), as rollup items. null when unreadable. Read-only.
 */
export async function checkRunsWithApps(api: ApiGet, repository: string, sha: string): Promise<RollupItem[] | null> {
  type Run = { name?: unknown; status?: unknown; conclusion?: unknown; app?: { id?: unknown } | null };
  const base = `/repos/${segs(repository)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`;
  const all: Run[] = [];
  // Paginate until total_count is reached. Any incomplete read (error, cap hit, inconsistent counts) is
  // unreadable: a truncated list could hide a failing run, so a partial list is never returned.
  for (let page = 1; ; page++) {
    const r = await api(page === 1 ? base : `${base}&page=${page}`);
    const body = r.body as { check_runs?: unknown; total_count?: unknown } | null;
    const runs = body?.check_runs;
    const total = body?.total_count;
    if (r.status !== 200 || !Array.isArray(runs) || typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null;
    all.push(...(runs as Run[]));
    if (all.length > total) return null;
    if (all.length === total) break;
    if (!runs.length || page >= CHECK_RUNS_MAX_PAGES) return null;
  }
  return all.map((c) => ({
    __typename: 'CheckRun',
    name: typeof c?.name === 'string' ? c.name : 'check',
    status: String(c?.status ?? '').toUpperCase(),
    conclusion: typeof c?.conclusion === 'string' ? c.conclusion.toUpperCase() : null,
    appId: c?.app?.id,
  }));
}
const CHECK_RUNS_MAX_PAGES = 10;

// ---------------------------------------------------------------- sync

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export interface SyncTaskResult {
  taskId: string;
  prUrl: string;
  prState?: PrState;
  headSha?: string;
  ci?: CiSummary;
  /** Observation differs from the last one recorded for this head (a note was added). */
  changed: boolean;
  statusChange?: { from: TaskStatus; to: TaskStatus };
  /** verification.ciAuthority github: the CI evidence gate for the PR head (src/runtime/ci-gate.ts). */
  gate?: CiGate;
  /** delivery.merge "auto-when-eligible": the auto-merge pass for this task (src/runtime/merge.ts). */
  merge?: MergeResult;
  warnings: string[];
  error?: string;
}
export interface SyncReport { tasks: SyncTaskResult[]; synced: number; failed: number }

export interface SyncDeps {
  db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig; gh?: GhFn;
  /** Auto-merge pass for an open PR after its observation is recorded (`Scheduler.autoMerge`); omitted: read-only sync. */
  merge?: (taskId: string) => Promise<MergeResult>;
}

const PR_FIELDS = 'url,state,isDraft,headRefOid,baseRefName,mergedAt,closedAt,mergeStateStatus,statusCheckRollup';
const SKIP_STATUSES: TaskStatus[] = ['done', 'cancelled'];
/** Task statuses that a closed (unmerged) PR moves to blocked; anything else is left for the coordinator. */
const DELIVERY_STATUSES: TaskStatus[] = ['delivered', 'awaiting-ci', 'merging'];

function describeObservation(r: { prState: PrState; ci: CiSummary; headSha: string }): string {
  const ci = r.ci;
  const detail = ci.state === 'failing' ? ` (failed: ${ci.failed.join(', ')})` : ci.state === 'awaiting-ci' ? ` (pending: ${ci.pending.join(', ')})` : ci.state === 'passing' ? ` (${ci.passed}/${ci.total} passed)` : '';
  return `PR ${r.prState.toLowerCase()} at ${r.headSha.slice(0, 12)}; CI ${ci.state}${detail}`;
}

/**
 * Refreshes PR state and check results for tasks with a prUrl (all, or the given ids). Records `ci`
 * evidence per head, notes on change, and reconciles merged/closed PRs. Read-only on GitHub, except the
 * optional auto-merge pass (`deps.merge`, delivery.merge "auto-when-eligible"), which arms or disarms
 * GitHub auto-merge through its own gates; sync itself never merges.
 */
export async function syncTasks(deps: SyncDeps, opts: { taskIds?: string[] } = {}): Promise<SyncReport> {
  const gh = deps.gh ?? realGh;
  const { db, backlog, config } = deps;
  const all = await backlog.listTasks();
  const want = opts.taskIds?.length ? new Set(opts.taskIds) : null;
  const tasks = all.filter((t) => t.prUrl && (want ? want.has(t.id) : !SKIP_STATUSES.includes(t.status)));
  const leased = new Set(db.activeLeases().map((l) => l.task_id));
  const out: SyncTaskResult[] = [];
  // CI authority: required checks per repository, read once per sync (read-only REST GETs).
  const required = new Map<string, Promise<RequiredChecksReport | null>>();
  const requiredFor = (prUrl: string) => {
    const repository = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl)?.[1];
    if (!repository) return Promise.resolve(null);
    if (!required.has(repository)) required.set(repository, requiredChecksStatus(ghApi(gh), repository, config.git.baseBranch).catch(() => null));
    return required.get(repository)!;
  };
  for (const task of tasks) {
    // One task's failure (e.g. a backlog version conflict) is reported on that task; the run continues.
    out.push(await syncOne(task, { db, backlog, config, gh, leased, requiredFor, merge: deps.merge })
      .catch((e: unknown): SyncTaskResult => ({ taskId: task.id, prUrl: task.prUrl!, changed: false, warnings: [], error: `sync failed: ${short(String((e as Error)?.message ?? e))}` })));
  }
  db.addEvent('sync', null, { tasks: out.length, failed: out.filter((t) => t.error).length });
  return { tasks: out, synced: out.filter((t) => !t.error).length, failed: out.filter((t) => t.error).length };
}

async function syncOne(task: Task, x: { db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig; gh: GhFn; leased: Set<string>; requiredFor: (prUrl: string) => Promise<RequiredChecksReport | null>; merge?: SyncDeps['merge'] }): Promise<SyncTaskResult> {
  const prUrl = task.prUrl!;
  const res: SyncTaskResult = { taskId: task.id, prUrl, changed: false, warnings: [] };
  const r = await x.gh(['pr', 'view', prUrl, '--json', PR_FIELDS]);
  if (r.code !== 0) { res.error = `gh pr view failed: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`; return res; }
  let pr: { state?: string; headRefOid?: string; mergedAt?: string | null; isDraft?: boolean; mergeStateStatus?: string; statusCheckRollup?: unknown };
  try { pr = JSON.parse(r.stdout) as typeof pr; } catch { res.error = 'gh pr view returned invalid JSON'; return res; }
  const prState = (['OPEN', 'MERGED', 'CLOSED'] as const).find((s) => s === String(pr.state ?? '').toUpperCase());
  if (!prState || !pr.headRefOid) { res.error = `gh pr view returned an unexpected PR state (${String(pr.state)})`; return res; }
  const github = x.config.verification.ciAuthority === 'github';
  const required = github ? await x.requiredFor(prUrl) : null;
  let rollup = pr.statusCheckRollup;
  if (required?.requirements?.some((q) => q.appId !== null)) {
    // A required check is pinned to a GitHub App: the rollup carries no app, so read check runs (with
    // app ids) for the head. On failure the rollup is kept without apps and pinned checks stay unverified.
    const runs = await checkRunsWithApps(ghApi(x.gh), required.repository, pr.headRefOid);
    // Merge, never replace: a failing rollup check run (no app) is kept next to the app-aware runs, so a
    // failure seen in either source cannot disappear. Passing rollup runs are duplicates and are dropped.
    const failedRollupRun = (i: RollupItem) => i.__typename !== 'StatusContext' && !(i.state !== undefined && i.status === undefined)
      && String(i.status ?? '').toUpperCase() === 'COMPLETED' && FAILED_CONCLUSIONS.has(String(i.conclusion ?? '').toUpperCase());
    if (runs) rollup = [...(Array.isArray(rollup) ? (rollup as RollupItem[]) : []).filter((i) => i.__typename === 'StatusContext' || (i.state !== undefined && i.status === undefined) || failedRollupRun(i)), ...runs];
    else res.warnings.push('check runs (with apps) unreadable; required checks pinned to an app cannot be verified');
  }
  const ci = summarizeChecks(rollup);
  Object.assign(res, { prState, headSha: pr.headRefOid, ci });

  const approved = x.db.publication(task.id)?.head_sha;
  if (approved && approved !== pr.headRefOid) res.warnings.push(`PR head ${pr.headRefOid.slice(0, 12)} differs from the approved head ${approved.slice(0, 12)}`);

  // Record the observation (bound to the PR head); dedupe against the last one for that head.
  const outcome = `${prState.toLowerCase()}:${ci.state}`;
  const details = { prUrl, prState, isDraft: !!pr.isDraft, mergeStateStatus: pr.mergeStateStatus ?? null, mergedAt: pr.mergedAt ?? null, ci };
  const prev = x.db.evidenceFor(task.id, pr.headRefOid, 'ci').at(-1);
  if (!prev || prev.outcome !== outcome || prev.details_json !== JSON.stringify(details)) {
    x.db.addEvidence({ task_id: task.id, head_sha: pr.headRefOid, kind: 'ci', config_revision: x.config.configRevision, outcome, details_json: JSON.stringify(details) });
  }
  res.changed = !prev || prev.outcome !== outcome;
  if (github) {
    res.gate = evaluateCiGate({ ciAuthority: 'github', head: pr.headRefOid, required, now: new Date(),
      timeoutMinutes: ciTimeoutOf(x.config), observations: x.db.evidenceFor(task.id, pr.headRefOid, 'ci') });
  }
  try {
    await reconcileBacklog(task, res, x, { prState, ci, headSha: pr.headRefOid, mergedAt: pr.mergedAt ?? null });
  } catch (e) {
    // Backlog write failed (e.g. a version conflict): the observation is already recorded as evidence;
    // report it on this task and leave the rest of the run alone. No auto-merge pass on a failed task.
    res.error = `backlog update failed: ${short(String((e as Error)?.message ?? e))}`;
  }
  x.db.addEvent('ci-observation', task.id, { prUrl, prState, head: pr.headRefOid, ci: ci.state, statusChange: res.statusChange ?? null, ...(res.error ? { error: res.error } : {}) });
  if (prState === 'OPEN' && x.merge && !res.error) {
    try {
      const m = await x.merge(task.id);
      if (m.state !== 'off') res.merge = m;
      if (m.merged) res.statusChange = { from: task.status, to: 'done' };
    } catch (e) { res.warnings.push(`auto-merge not evaluated: ${(e as Error).message}`); }
  }
  return res;
}

/** Backlog side of a sync observation: change note, then merged -> done / closed -> blocked. Throws on backlog errors. */
async function reconcileBacklog(task: Task, res: SyncTaskResult, x: { db: RuntimeDb; backlog: BacklogAdapter; config: MinionsConfig; leased: Set<string> }, o: { prState: PrState; ci: CiSummary; headSha: string; mergedAt: string | null }): Promise<void> {
  const { prState, ci } = o;
  const prUrl = res.prUrl;
  const pr = { headRefOid: o.headSha, mergedAt: o.mergedAt };
  if (res.changed) {
    await x.backlog.addNote(task.id, `minions sync: ${describeObservation({ prState, ci, headSha: pr.headRefOid })}. ${prState === 'OPEN' ? (x.config.delivery.merge === 'auto-when-eligible' ? 'Not merged yet.' : 'Not merged; minions never merges.') : ''}`.trim());
  }

  // Reconcile merged / closed PRs (never while a worker holds the task).
  if (x.leased.has(task.id)) {
    if (prState !== 'OPEN') res.warnings.push(`PR is ${prState.toLowerCase()} but ${task.id} has an active lease; status left unchanged`);
  } else if (prState === 'MERGED' && !SKIP_STATUSES.includes(task.status)) {
    await x.backlog.closeTask(task.id, 'done');
    res.statusChange = { from: task.status, to: 'done' };
    // Merged is recorded distinctly from delivered: `merge` evidence bound to the merged head.
    if (!x.db.evidenceOfKind(task.id, 'merge').some((e) => e.outcome === 'merged')) {
      x.db.addEvidence({ task_id: task.id, head_sha: pr.headRefOid, kind: 'merge', config_revision: x.config.configRevision, outcome: 'merged',
        details_json: JSON.stringify({ prUrl, mergedAt: pr.mergedAt ?? null, how: 'github' }) });
    }
    await x.backlog.addNote(task.id, `minions sync: pull request ${prUrl} was merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ''}; task done (merged).`);
  } else if (prState === 'CLOSED' && DELIVERY_STATUSES.includes(task.status)) {
    const cur = await x.backlog.getTask(task.id); // the note above may have changed the version
    await x.backlog.updateTask(task.id, cur.version, { status: 'blocked' });
    await x.backlog.addNote(task.id, `minions sync: pull request ${prUrl} was closed without merging; task blocked. Reopen the PR (then \`minions sync\`) or decide how to proceed.`);
    res.statusChange = { from: task.status, to: 'blocked' };
  }
}

export function formatSync(r: SyncReport): string {
  if (!r.tasks.length) return 'No tasks with a pull request to sync.';
  const L = r.tasks.map((t) => t.error
    ? `${t.taskId}: error: ${t.error}`
    : `${t.taskId}: ${describeObservation({ prState: t.prState!, ci: t.ci!, headSha: t.headSha! })}${t.statusChange ? `; status ${t.statusChange.from} -> ${t.statusChange.to}` : ''}${t.changed ? '' : ' (unchanged)'}  ${t.prUrl}` +
      (t.gate ? `\n  ${formatCiGate(t.gate)}` : '') + (t.merge ? `\n  merge ${t.merge.state}: ${t.merge.message}` : '') + t.warnings.map((w) => `\n  warning: ${w}`).join(''));
  L.push(`synced ${r.synced}, failed ${r.failed}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- container `minions ci status`

export interface CiStatus {
  repository: string | null;
  requiredChecks: RequiredChecksReport | null;
  /** delivery.requiredChecksConfigured as configured (the readiness flag automatic merge depends on). */
  requiredChecksConfigured: boolean;
  setupPlan: string[];
  detail?: string;
}

/** Required-checks status for the workspace origin (container side, via `gh api`). Read-only. */
export async function ciStatus(repo: string, config: MinionsConfig, deps: { git: GitFn; gh?: GhFn }): Promise<CiStatus> {
  const o = await deps.git(repo, ['config', '--get', 'remote.origin.url'], true);
  const https = o.code === 0 ? normalizeGithubRemote(o.stdout.trim()) : null;
  const base = { requiredChecksConfigured: config.delivery.requiredChecksConfigured };
  if (!https) return { ...base, repository: null, requiredChecks: null, setupPlan: [], detail: 'origin is not a github.com repository' };
  const repository = https.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const rc = await requiredChecksStatus(ghApi(deps.gh), repository, config.git.baseBranch);
  return {
    ...base, repository, requiredChecks: rc,
    setupPlan: ciSetupPlan({ hasWorkflows: rc.workflows === null ? null : rc.workflows > 0, requiredChecks: rc.state, verificationCommands: config.verification.commands, baseBranch: config.git.baseBranch, repository }),
  };
}

export function formatCiStatus(s: CiStatus): string {
  if (!s.repository || !s.requiredChecks) return `CI: not applicable (${s.detail ?? 'no GitHub repository'})`;
  const rc = s.requiredChecks;
  const L = [
    `repository ${s.repository}, base ${rc.baseBranch}: required checks ${rc.state}${rc.requiredChecks.length ? ` (${rc.requiredChecks.join(', ')})` : ''}`,
    `workflows: ${rc.workflows ?? 'unknown'}; delivery.requiredChecksConfigured: ${s.requiredChecksConfigured}`,
    ...rc.errors.map((e) => `warning: ${e}`),
  ];
  if (s.setupPlan.length) L.push('', ...s.setupPlan);
  return L.join('\n');
}
