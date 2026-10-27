// CI-gated auto-merge for pull-request delivery (decision record: docs/design/bootstrap.md,
// "CI-gated auto-merge").
//
// - Opt-in: delivery.merge "auto-when-eligible" (default "disabled"). Runs only from the runtime's own
//   command path (`minions sync`, `minions work publish`), never from a model's shell; the
//   coordinator's deny rules for `gh pr merge` stay in place.
// - Gates, all for the approved publication head (publications.head_sha), evaluated every time:
//   configuration (pull-request delivery, requiredChecksConfigured, ciAuthority "github", pr.merge not
//   denied); the live PR (open, not a draft, same repository, base == git.baseBranch, head == approved
//   head); reviewer evidence for that head; the CI evidence gate (`Scheduler.ciGate`, fail closed, see
//   src/runtime/ci-gate.ts); the sensitive-path diff against trusted bases (gateChangedPaths, shared
//   with publication) and `can(pr.merge)`: "ask" (the default, and every sensitive change) needs a
//   host-signed approval of scope "merge" for exactly that task and head (src/core/approval.ts).
// - Native GitHub auto-merge: `gh pr merge <url> --auto --<method> --match-head-commit <head>`, armed
//   only when every gate passes, so GitHub itself enforces branch protection at merge time. Never
//   `--admin`, never a force merge. When GitHub reports the PR already mergeable ("clean status"), the
//   same merge without `--auto` is used only if GitHub's own mergeStateStatus is CLEAN.
// - Disarm (`gh pr merge <url> --disable-auto`) when a PR minions armed no longer passes a gate (new
//   head, failing/missing CI, approval gone, policy or config changed).
// - States are recorded as `merge` evidence bound to the approved head; a merged PR closes the task as
//   `done` (merged), distinct from `delivered` (PR open).
import { can } from '../config/capabilities.js';
import { autoMergeConfigReasons } from '../config/delivery.js';
import type { MinionsConfig } from '../config/schema.js';
import type { BacklogAdapter, Task } from '../backlog/types.js';
import { verifyAnyApproval } from '../core/approval.js';
import type { ErrorCode } from '../core/errors.js';
import { redact } from '../core/output.js';
import { readFile } from 'node:fs/promises';
import type { CiGate } from './ci-gate.js';
import { formatCiGate } from './ci-gate.js';
import type { EvidenceRow, RuntimeDb } from './db.js';
import type { GitFn } from './github.js';
import { missingApprovalKeyReason } from './paths.js';
import { originOfPrUrl, type ServerUrlFn } from './base-update.js';
import { classifyFailure, gateChangedPaths, verifiedGateBase, type GhFn } from './publish.js';

export type MergeState =
  /** delivery.merge is not "auto-when-eligible" and minions armed nothing: no gh call was made. */
  | 'off'
  /** A gate does not pass (yet): CI pending/missing/failing, head differs, not reviewed, config. */
  | 'waiting'
  /** Every gate passes except the host-signed merge approval that pr.merge "ask" requires. */
  | 'awaiting-approval'
  /** pr.merge is denied by policy. */
  | 'denied'
  /** GitHub auto-merge is enabled for the approved head (GitHub merges once branch protection allows). */
  | 'armed'
  /** minions disabled the auto-merge it had armed because a gate stopped passing. */
  | 'disarmed'
  | 'merged'
  /** The PR was closed without merging. */
  | 'closed'
  /** gh failed; nothing changed on GitHub (retry with `minions sync`). */
  | 'failed';

export interface MergeResult {
  taskId: string;
  state: MergeState;
  prUrl: string | null;
  /** The approved head the decision is bound to. */
  head: string | null;
  armed: boolean;
  merged: boolean;
  reasons: string[];
  ci?: CiGate;
  /** awaiting-approval: why no recorded merge approval was accepted. */
  approvalError?: string;
  /** What minions did on GitHub in this pass. */
  action: 'none' | 'armed' | 'merged' | 'disarmed';
  errorCode?: ErrorCode;
  message: string;
}

/** `gh pr view` fields the merge gate reads (live, never from a cached observation). */
export const MERGE_PR_FIELDS = 'url,state,isDraft,headRefOid,baseRefName,mergedAt,mergeStateStatus,autoMergeRequest,isCrossRepository';

export interface MergePrView {
  url?: string; state?: string; isDraft?: boolean; headRefOid?: string; baseRefName?: string; mergedAt?: string | null;
  mergeStateStatus?: string | null; autoMergeRequest?: unknown; isCrossRepository?: boolean;
}

export interface MergeDeps {
  db: RuntimeDb;
  backlog: BacklogAdapter;
  config: MinionsConfig;
  repo: string;
  gh: GhFn;
  git: GitFn;
  /** History reader of the sensitive-path gate (default the hardened gateGit, see publish.ts gateChangedPaths). */
  gateGit?: GitFn;
  /** The CI evidence gate for (taskId, head): `Scheduler.ciGate`. */
  ciGate: (taskId: string, head: string) => Promise<CiGate>;
  approvalPublicKeyFile: string;
  now?: () => Date;
  /** Test seam: where git reaches the recorded origin URL (base-update.ts ServerUrlFn; default the URL itself). */
  serverUrl?: ServerUrlFn;
}

/** Last arm/disarm record: whether a PR's auto-merge was enabled by minions (and not disabled since). */
export function armedByMinions(history: Pick<EvidenceRow, 'outcome'>[]): boolean {
  const last = [...history].reverse().find((e) => e.outcome === 'armed' || e.outcome === 'disarmed' || e.outcome === 'merged');
  return last?.outcome === 'armed';
}

export interface MergeGateInput {
  config: MinionsConfig;
  approvedHead: string;
  pr: MergePrView;
  reviewed: boolean;
  ci: CiGate;
  paths: { ok: true; changedPaths: string[]; sensitivePaths: string[] } | { ok: false; message: string };
  /** Verifies the recorded merge approvals (only called when pr.merge evaluates to "ask"). */
  approval: () => { ok: true } | { ok: false; reason: string };
}

export interface MergeGate {
  state: 'eligible' | 'waiting' | 'awaiting-approval' | 'denied';
  reasons: string[];
  sensitivePaths: string[];
  approvalError?: string;
}

/** Pure merge decision for the approved head. Anything short of every gate passing is not eligible. */
export function evaluateMergeGate(i: MergeGateInput): MergeGate {
  const cfg = i.config;
  const reasons = autoMergeConfigReasons(cfg);
  const pr = i.pr;
  if (pr.isDraft) reasons.push('the pull request is a draft');
  if (pr.isCrossRepository) reasons.push('the pull request comes from another repository');
  if (pr.baseRefName !== cfg.git.baseBranch) reasons.push(`the pull request targets ${String(pr.baseRefName)}, not ${cfg.git.baseBranch}`);
  if (pr.headRefOid !== i.approvedHead) reasons.push(`PR head ${String(pr.headRefOid).slice(0, 12)} is not the approved head ${i.approvedHead.slice(0, 12)} (test and review the new head first)`);
  if (!i.reviewed) reasons.push(`no reviewer approval for ${i.approvedHead.slice(0, 12)} at config revision ${cfg.configRevision}`);
  if (i.ci.state !== 'pass') reasons.push(formatCiGate(i.ci));
  let sensitivePaths: string[] = [];
  let denied = false;
  let approvalError: string | undefined;
  if (!i.paths.ok) reasons.push(`sensitive-path gate: ${i.paths.message}`);
  else {
    sensitivePaths = i.paths.sensitivePaths;
    const effect = can(cfg, 'pr.merge', { paths: i.paths.changedPaths });
    if (effect === 'deny') {
      denied = true;
      if (!reasons.includes('pr.merge is denied by policy')) reasons.push('pr.merge is denied by policy');
    } else if (effect === 'ask') {
      const a = i.approval();
      if (!a.ok) approvalError = a.reason;
    }
  }
  if (denied) return { state: 'denied', reasons, sensitivePaths };
  if (reasons.length) return { state: 'waiting', reasons, sensitivePaths, ...(approvalError ? { approvalError } : {}) };
  if (approvalError) {
    const why = sensitivePaths.length
      ? `pr.merge needs human approval: the branch changes sensitive paths (${sensitivePaths.slice(0, 10).join(', ')}${sensitivePaths.length > 10 ? ', …' : ''})`
      : 'pr.merge needs human approval by configuration';
    return { state: 'awaiting-approval', reasons: [why], sensitivePaths, approvalError };
  }
  return { state: 'eligible', reasons: [], sensitivePaths };
}

const short = (s: string) => redact(s.trim().split('\n').slice(-3).join(' | ')).slice(0, 500);
/** gh runs outside the workspace for merges: with a PR URL it needs no repository, and never touches local branches. */
const GH_CWD = '/';

async function viewPr(gh: GhFn, url: string): Promise<{ pr?: MergePrView; error?: string; code?: ErrorCode }> {
  const r = await gh(['pr', 'view', url, '--json', MERGE_PR_FIELDS], { cwd: GH_CWD });
  if (r.code !== 0) return { error: `gh pr view failed: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`, code: classifyFailure(r.stderr) };
  try { return { pr: JSON.parse(r.stdout) as MergePrView }; } catch { return { error: 'gh pr view returned invalid JSON', code: 'INTERNAL' }; }
}

const prState = (pr: MergePrView) => String(pr.state ?? '').toUpperCase();

/**
 * One auto-merge pass for a delivered task: evaluates every gate for the approved head, then arms,
 * keeps, or disarms GitHub auto-merge. Never throws for expected failures.
 */
export async function autoMergeTask(d: MergeDeps, taskId: string): Promise<MergeResult> {
  const cfg = d.config;
  const pub = d.db.publication(taskId);
  const history = d.db.evidenceOfKind(taskId, 'merge');
  const ours = armedByMinions(history);
  const enabled = cfg.delivery.merge === 'auto-when-eligible';
  const prUrl = pub?.pr_url ?? null;
  const head = pub?.head_sha ?? null;
  const res = (state: MergeState, message: string, extra: Partial<MergeResult> = {}): MergeResult =>
    ({ taskId, state, prUrl, head, armed: state === 'armed', merged: state === 'merged', reasons: [], action: 'none', ...extra, message });

  if (!enabled && !ours) return res('off', `Auto-merge is off (delivery.merge "${cfg.delivery.merge}").`);
  if (!pub || pub.state !== 'published' || !prUrl || !head) {
    return res('waiting', 'Not delivered as a pull request yet; auto-merge waits for publication.', { reasons: ['not delivered as a pull request'] });
  }

  const record = async (state: MergeState, details: Record<string, unknown>, note?: string) => {
    const last = history.at(-1);
    const detailsJson = JSON.stringify({ prUrl, ...details });
    const changed = !last || last.outcome !== state || last.head_sha !== head || last.details_json !== detailsJson;
    if (changed) d.db.addEvidence({ task_id: taskId, head_sha: head, kind: 'merge', config_revision: cfg.configRevision, outcome: state, details_json: detailsJson });
    d.db.addEvent('merge', taskId, { state, head, prUrl, ...details });
    if (changed && note) {
      try { await d.backlog.addNote(taskId, note); } catch (e) { d.db.addEvent('merge-backlog-error', taskId, { error: (e as Error).message }); }
    }
  };
  const leased = d.db.activeLeases().some((l) => l.task_id === taskId);
  const closeMerged = async (pr: MergePrView, how: 'auto-merge' | 'direct', action: MergeResult['action'] = 'none'): Promise<MergeResult> => {
    await record('merged', { mergedAt: pr.mergedAt ?? null, how }, `minions: pull request ${prUrl} merged${how === 'auto-merge' ? ' by GitHub auto-merge' : ''} at ${head.slice(0, 12)}; task done (merged).`);
    let task: Task | null = null;
    try { task = await d.backlog.getTask(taskId); } catch { task = null; }
    if (task && !leased && task.status !== 'done' && task.status !== 'cancelled') await d.backlog.closeTask(taskId, 'done');
    return res('merged', `Merged: ${prUrl} at ${head}${task && leased ? ` (task ${taskId} has an active lease; status left unchanged)` : '; task done'}.`, { action });
  };

  const view = await viewPr(d.gh, prUrl);
  if (!view.pr) return res('failed', `Auto-merge not evaluated: ${view.error}. Retry with \`minions sync ${taskId}\`.`, { errorCode: view.code, reasons: [view.error!] });
  let pr = view.pr;
  if (prState(pr) === 'MERGED') return closeMerged(pr, 'auto-merge');
  if (prState(pr) === 'CLOSED') return res('closed', `Pull request ${prUrl} is closed without merging; nothing to merge.`, { reasons: ['pull request closed'] });

  // ---- gates (every one bound to the approved head)
  const reviewed = d.db.evidenceFor(taskId, head, 'reviewer', cfg.configRevision).some((e) => e.outcome === 'complete');
  const ci = await d.ciGate(taskId, head);
  // The server is the repository of the recorded PR URL, never the workspace's (agent-writable) origin remote
  // or url.* config; its base is read from an isolated git dir and cross-checked with the GitHub API
  // (publish.ts verifiedGateBase). Unverifiable (gh down, a mismatch, not fetchable): the gate fails closed.
  const origin = originOfPrUrl(prUrl);
  const base = cfg.git.baseBranch;
  const vb = origin
    ? await verifiedGateBase({ repo: d.repo, gh: d.gh, origin, base, haves: [head], ...(d.serverUrl ? { serverUrl: d.serverUrl } : {}) })
    : { ok: false as const, message: `${prUrl} is not a github.com pull request` };
  const paths: MergeGateInput['paths'] = vb.ok
    ? await gateChangedPaths({ gateGit: d.gateGit, repo: d.repo, base, head, branch: pub.branch, serverBase: vb.sha,
      baseShas: d.db.leases({ taskId, all: true }).map((l) => l.base_sha), sensitivePaths: cfg.sensitivePaths })
    : { ok: false as const, message: `origin's ${base} could not be verified: ${vb.message}` };
  const pem = await readFile(d.approvalPublicKeyFile, 'utf8').catch(() => null);
  const gate = evaluateMergeGate({
    config: cfg, approvedHead: head, pr, reviewed, ci, paths,
    approval: () => pem
      ? verifyAnyApproval(d.db.approvals(taskId, 'merge', head).map((a) => a.signature), pem, { taskId, head, now: d.now?.(), scope: 'merge' })
      : { ok: false, reason: missingApprovalKeyReason(d.approvalPublicKeyFile) },
  });
  const armedOnGithub = !!pr.autoMergeRequest;

  if (gate.state !== 'eligible') {
    const why = gate.reasons.join('; ');
    if (armedOnGithub && ours) {
      const r = await d.gh(['pr', 'merge', prUrl, '--disable-auto'], { cwd: GH_CWD });
      if (r.code !== 0) {
        const err = `gh pr merge --disable-auto failed: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`;
        d.db.addEvent('merge', taskId, { state: 'failed', head, prUrl, error: err });
        return res('failed', `A gate stopped passing (${why}) but auto-merge could not be disabled: ${err}. Retry with \`minions sync ${taskId}\`; GitHub still enforces branch protection.`,
          { reasons: [...gate.reasons, err], ci, errorCode: classifyFailure(r.stderr), armed: true });
      }
      await record('disarmed', { reasons: gate.reasons, ci: ci.state }, `minions: auto-merge disabled for ${prUrl}: ${why}.`);
      return res('disarmed', `Auto-merge disabled for ${prUrl}: ${why}.`, { reasons: gate.reasons, ci, action: 'disarmed', ...(gate.approvalError ? { approvalError: gate.approvalError } : {}) });
    }
    const external = armedOnGithub ? ' (auto-merge was enabled on GitHub outside minions; left as is)' : '';
    if (gate.state === 'awaiting-approval') {
      const how = `the user approves on the host with \`minions work approve ${taskId} --head ${head} --merge\` (signed with the host-held key), then runs \`minions sync ${taskId}\``;
      await record('awaiting-approval', { reasons: gate.reasons, approvalError: gate.approvalError ?? null },
        `minions: ${prUrl} passes every merge gate at ${head.slice(0, 12)} but waits for human merge approval: ${why}.`);
      return res('awaiting-approval', `Not merged: ${why} (${gate.approvalError}). Ask the user — ${how}.${external}`,
        { reasons: gate.reasons, ci, approvalError: gate.approvalError });
    }
    await record(gate.state, { reasons: gate.reasons, ci: ci.state });
    return res(gate.state, `Auto-merge ${gate.state === 'denied' ? 'denied' : 'waiting'}: ${why}.${external}`, { reasons: gate.reasons, ci, ...(gate.approvalError ? { approvalError: gate.approvalError } : {}) });
  }

  // ---- every gate passes for the approved head
  if (armedOnGithub) {
    if (!ours || history.at(-1)?.head_sha !== head) await record('armed', { method: cfg.delivery.method, ci: ci.state, adopted: !ours });
    return res('armed', `Auto-merge is enabled for ${prUrl} at ${head}; GitHub merges it once branch protection allows.`, { ci });
  }
  const method = `--${cfg.delivery.method}`;
  const arm = await d.gh(['pr', 'merge', prUrl, '--auto', method, '--match-head-commit', head], { cwd: GH_CWD });
  let how: 'auto' | 'direct' = 'auto';
  if (arm.code !== 0) {
    const err = short(arm.stderr || arm.stdout) || `exit ${arm.code}`;
    // GitHub refuses to *enable* auto-merge on a PR that is mergeable right now. Merge it the same way
    // (no --admin) only when GitHub itself reports every requirement met (mergeStateStatus CLEAN).
    if (/clean status/i.test(err) && String(pr.mergeStateStatus ?? '').toUpperCase() === 'CLEAN') {
      const m = await d.gh(['pr', 'merge', prUrl, method, '--match-head-commit', head], { cwd: GH_CWD });
      if (m.code !== 0) {
        const e2 = `gh pr merge failed: ${short(m.stderr || m.stdout) || `exit ${m.code}`}`;
        d.db.addEvent('merge', taskId, { state: 'failed', head, prUrl, error: e2 });
        return res('failed', `${e2}. Nothing was bypassed; retry with \`minions sync ${taskId}\`.`, { reasons: [e2], ci, errorCode: classifyFailure(m.stderr) });
      }
      how = 'direct';
    } else {
      const hint = /auto.?merge is not allowed|not allowed for this repository|enablePullRequestAutoMerge/i.test(err)
        ? ' Enable "Allow auto-merge" in the repository settings on GitHub (Settings > General > Pull Requests).' : '';
      d.db.addEvent('merge', taskId, { state: 'failed', head, prUrl, error: err });
      return res('failed', `Could not enable auto-merge for ${prUrl}: ${err}.${hint} Retry with \`minions sync ${taskId}\`.`, { reasons: [err], ci, errorCode: classifyFailure(arm.stderr) });
    }
  }
  // Read back what GitHub did (gh may merge at once when nothing is pending).
  const after = await viewPr(d.gh, prUrl);
  if (after.pr) pr = after.pr;
  if (after.pr && prState(pr) === 'MERGED') return closeMerged(pr, how === 'direct' ? 'direct' : 'auto-merge', 'merged');
  await record('armed', { method: cfg.delivery.method, ci: ci.state }, `minions: auto-merge enabled for ${prUrl} at ${head.slice(0, 12)} (${cfg.delivery.method}); required checks passed; GitHub merges once branch protection allows.`);
  return res('armed', `Auto-merge enabled for ${prUrl} at ${head} (${cfg.delivery.method}); GitHub merges it once branch protection allows.`, { ci, action: 'armed' });
}

export function formatMerge(m: MergeResult): string {
  return `merge ${m.state}: ${m.message}`;
}
