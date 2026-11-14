/**
 * Upgrade and publish requests, recorded in the runtime DB (change_requests). In the agent runtime `minions upgrade
 * [--from-container] --reason <text>` records an upgrade request instead of failing with "host only"; it changes
 * nothing. The host reads open requests with `settings requests --json` (scripts/dev/self-update.mjs, or the owner),
 * applies one with `minions upgrade` on the host and reports the outcome with the hidden
 * `settings requests mark <id> --status <s>`.
 *
 * Publish requests (docs/design/autonomy.md Decision 17): `settings requests publish --summary <text>` in the runtime
 * proposes pushing the base branch at one exact SHA. The row is a claim, never an authorization: the host publisher
 * (src/host/publisher.ts) recomputes what it shows from git, asks the owner through its own bot, and pushes only the
 * SHA it showed. A newer publish request supersedes (expires) an older open one.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { CHANGE_REQUEST_KINDS, CHANGE_REQUEST_STATUSES, openDb, type ChangeRequestKind, type ChangeRequestRow, type ChangeRequestStatus, type RuntimeDb } from './db.js';
import { runtimePaths } from './paths.js';

/** Request ids: `cr_` + 8 hex characters. */
export const CHANGE_REQUEST_ID_PATTERN = /^cr_[0-9a-f]{8}$/;
export const isChangeRequestId = (s: string) => CHANGE_REQUEST_ID_PATTERN.test(s);
export const newChangeRequestId = () => `cr_${randomBytes(4).toString('hex')}`;

/** Stored reasons are capped; the host shows at most REASON_DISPLAY_MAX characters of it, quoted. */
export const REASON_MAX = 1000;
export const REASON_DISPLAY_MAX = 300;

/** Payload of an `upgrade` request: --from-container (true: the base branch; a string: that branch). */
export interface UpgradePayload { fromContainer: string | true | null }
/** Payload of a `publish` request: the base branch at one exact commit, and the tasks it lands (the summary is the reason). */
export interface PublishPayload { base: string; sha: string; tasks: string[] }

/** A full, lowercase commit SHA (the only form a publish request or approval binds to). */
export const FULL_SHA = /^[0-9a-f]{40}$/;
/** Task ids as minions names them (task-12, task-12.3). */
export const TASK_ID_PATTERN = /^task-\d{1,6}(?:\.\d{1,4}){0,3}$/;
/** At most this many task ids in a publish request. */
export const PUBLISH_TASKS_MAX = 50;

export interface ChangeRequestView {
  id: string;
  kind: ChangeRequestKind;
  payload: Record<string, unknown>;
  reason: string | null;
  createdAt: string;
  status: ChangeRequestStatus;
  updatedAt: string;
  /** The host's outcome or why the request expired. */
  detail: string | null;
  /** One line: what the request asks for. */
  summary: string;
}

const parsePayload = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
};

const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** The payload of a publish request when it is well formed (the row is runtime-written: anything else is null). */
export function publishPayloadOf(payload: Record<string, unknown>): PublishPayload | null {
  const { base, sha, tasks } = payload as { base?: unknown; sha?: unknown; tasks?: unknown };
  if (typeof base !== 'string' || !BRANCH_RE.test(base) || typeof sha !== 'string' || !FULL_SHA.test(sha)) return null;
  const list = Array.isArray(tasks) ? tasks.filter((t): t is string => typeof t === 'string' && TASK_ID_PATTERN.test(t)).slice(0, PUBLISH_TASKS_MAX) : [];
  return { base, sha, tasks: list };
}

/** One line describing a request (control characters stripped: the row is runtime-written). */
export function requestSummary(payload: Record<string, unknown>, kind: ChangeRequestKind = 'upgrade'): string {
  if (kind === 'publish') {
    const p = publishPayloadOf(payload);
    if (!p) return 'publish (malformed request)';
    const tasks = p.tasks.length ? ` (${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'}: ${p.tasks.slice(0, 8).join(', ')}${p.tasks.length > 8 ? ', …' : ''})` : '';
    return displayText(`publish ${p.base} at ${p.sha.slice(0, 12)}${tasks}`);
  }
  const fc = payload.fromContainer;
  return displayText(`upgrade${fc === true ? ' --from-container' : typeof fc === 'string' ? ` --from-container ${fc}` : ''}`);
}

export const requestView = (r: ChangeRequestRow): ChangeRequestView => {
  const payload = parsePayload(r.payload);
  return {
    id: r.id, kind: r.kind, payload, reason: r.reason, createdAt: r.created_at, status: r.status, updatedAt: r.updated_at, detail: r.detail,
    summary: requestSummary(payload, r.kind),
  };
};

export interface RecordResult {
  /** A row was written (false: dry run). */
  recorded: boolean;
  /** Always false: a request is applied only on the host. */
  applied: false;
  dryRun: boolean;
  request: ChangeRequestView | null;
  /** Earlier open requests of the same kind this one replaced (now expired). */
  expired: string[];
  message: string;
}

/** Runs fn with the runtime DB. */
export async function withRequestDb<T>(fn: (db: RuntimeDb) => T | Promise<T>): Promise<T> {
  const db = openDb(runtimePaths().db);
  try { return await fn(db); } finally { db.close(); }
}

function cleanReason(reason: string | undefined): string | null {
  const r = (reason ?? '').trim();
  if (!r) return null;
  return r.length > REASON_MAX ? r.slice(0, REASON_MAX) : r;
}

const RECORDED_NOTE = 'Recorded only: nothing changed. Tell the owner the request id and reason; never say the upgrade was done. The owner (or the host self-update script) applies it on the host.';

/** `upgrade [--from-container [branch]]` in the runtime: records an upgrade request. */
export function recordUpgradeRequest(db: RuntimeDb, o: { fromContainer?: string | boolean; reason?: string; dryRun?: boolean }): RecordResult {
  let fromContainer: UpgradePayload['fromContainer'] = null;
  if (o.fromContainer !== undefined && o.fromContainer !== false) {
    if (typeof o.fromContainer === 'string') {
      if (!BRANCH_RE.test(o.fromContainer)) throw new MinionsError('PRECONDITION', `--from-container: "${displayText(o.fromContainer)}" is not a branch name.`);
      fromContainer = o.fromContainer;
    } else fromContainer = true;
  }
  const payload: UpgradePayload = { fromContainer };
  if (o.dryRun) {
    return { recorded: false, applied: false, dryRun: true, request: null, expired: [], message: `dry run: would record an upgrade request (${requestSummary({ ...payload })}); nothing recorded.` };
  }
  const id = newChangeRequestId();
  const { row, expired } = db.addChangeRequest({ id, kind: 'upgrade', payload: { ...payload }, reason: cleanReason(o.reason) });
  return {
    recorded: true, applied: false, dryRun: false, request: requestView(row), expired,
    message: `Upgrade request ${id} recorded (proposed, not applied): ${requestSummary({ ...payload })}. ${RECORDED_NOTE}`,
  };
}

/** Upgrade and publish requests: open ones (proposed, confirmed, failed), or every status with all. Rows of removed kinds are left out. */
export const listChangeRequests = (db: RuntimeDb, o: { all?: boolean } = {}): ChangeRequestView[] =>
  db.changeRequests(o).filter((r) => (CHANGE_REQUEST_KINDS as readonly string[]).includes(r.kind)).map(requestView);

/** Hidden `settings requests mark <id> --status <s>`: the host reports its outcome. */
export function markChangeRequest(db: RuntimeDb, id: string, status: string, detail?: string): ChangeRequestView {
  if (!isChangeRequestId(id)) throw new MinionsError('PRECONDITION', `"${displayText(id)}" is not a change request id (cr_ + 8 hex characters).`);
  if (!(CHANGE_REQUEST_STATUSES as readonly string[]).includes(status) || status === 'proposed') {
    throw new MinionsError('PRECONDITION', `--status must be one of ${CHANGE_REQUEST_STATUSES.filter((s) => s !== 'proposed').join(', ')} (got "${displayText(status)}").`);
  }
  const d = detail?.trim() ? detail.trim().slice(0, REASON_MAX) : null;
  return requestView(db.setChangeRequestStatus(id, status as ChangeRequestStatus, d));
}

// ---------------------------------------------------------------- publish requests

const PUBLISH_NOTE = 'Recorded only: nothing was pushed. The owner approves it with one tap in Telegram (the host publisher bot), which pushes exactly this commit; never say it was published until the request is `applied`.';

/** The runtime's project.json (beside config.json): the base branch and the sanitized origin URL the host recorded at setup. */
export function runtimeProjectFacts(configJson: string = runtimePaths().configJson): { baseBranch: string | null; remoteUrl: string | null } {
  try {
    const v = JSON.parse(readFileSync(join(dirname(configJson), 'project.json'), 'utf8')) as { baseBranch?: unknown; remoteUrl?: unknown };
    return {
      baseBranch: typeof v.baseBranch === 'string' && BRANCH_RE.test(v.baseBranch) ? v.baseBranch : null,
      remoteUrl: typeof v.remoteUrl === 'string' && v.remoteUrl ? v.remoteUrl : null,
    };
  } catch { return { baseBranch: null, remoteUrl: null }; }
}

export const NO_REMOTE_MESSAGE = 'Publishing is unavailable: this project has no git remote (origin), so there is nowhere to push.';
export const NO_REMOTE_HINT = 'Keep the work local; the owner can add a remote on the host (`git remote add origin <url>`) and rerun `minions setup`.';

/** Normalizes --task values (repeatable, comma-separated allowed): task ids only, unique, in order. */
export function parsePublishTasks(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values.flatMap((v) => v.split(','))) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (!TASK_ID_PATTERN.test(t)) throw new MinionsError('PRECONDITION', `--task: "${displayText(raw).slice(0, 40)}" is not a task id (task-<n>).`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > PUBLISH_TASKS_MAX) throw new MinionsError('PRECONDITION', `--task: at most ${PUBLISH_TASKS_MAX} tasks per publish request.`);
  return out;
}

/**
 * `settings requests publish` in the runtime: records a publish request for `base` at `sha` (resolved and checked
 * against the workspace by the caller). Refused without a git remote; the summary is required (the owner reads it).
 */
export function recordPublishRequest(db: RuntimeDb, o: { base: string; sha: string; tasks: readonly string[]; summary?: string; remoteUrl: string | null; dryRun?: boolean }): RecordResult {
  if (!o.remoteUrl) throw new MinionsError('PRECONDITION', NO_REMOTE_MESSAGE, NO_REMOTE_HINT);
  if (!BRANCH_RE.test(o.base)) throw new MinionsError('PRECONDITION', `"${displayText(o.base)}" is not a branch name.`);
  if (!FULL_SHA.test(o.sha)) throw new MinionsError('PRECONDITION', `--sha must be a full 40-character lowercase commit SHA (got "${displayText(o.sha).slice(0, 60)}").`);
  const summary = cleanReason(o.summary);
  if (!summary) throw new MinionsError('PRECONDITION', '--summary is required: one or two sentences the owner reads before approving.');
  const payload: PublishPayload = { base: o.base, sha: o.sha, tasks: parsePublishTasks(o.tasks) };
  const line = requestSummary({ ...payload }, 'publish');
  if (o.dryRun) return { recorded: false, applied: false, dryRun: true, request: null, expired: [], message: `dry run: would record a publish request (${line}); nothing recorded.` };
  const id = newChangeRequestId();
  const { row, expired } = db.addChangeRequest({ id, kind: 'publish', payload: { ...payload }, reason: summary });
  return { recorded: true, applied: false, dryRun: false, request: requestView(row), expired, message: `Publish request ${id} recorded (proposed, not pushed): ${line}. ${PUBLISH_NOTE}` };
}

// ---------------------------------------------------------------- output

/** A quoted, untrusted reason: control characters stripped, cut to REASON_DISPLAY_MAX characters. */
export function quotedReason(reason: string | null): string {
  if (!reason) return '(no reason given)';
  const r = displayText(reason).replace(/\s+/g, ' ');
  return `"${r.length > REASON_DISPLAY_MAX ? `${r.slice(0, REASON_DISPLAY_MAX)}…` : r}"`;
}

export function formatRequestLine(v: ChangeRequestView): string {
  return `${v.id}  ${v.status.padEnd(9)} ${v.createdAt}  ${v.summary}  ${v.kind === 'publish' ? 'summary' : 'reason'}: ${quotedReason(v.reason)}${v.detail ? `  (${displayText(v.detail)})` : ''}`;
}

export function formatRequests(list: ChangeRequestView[]): string {
  return list.length ? ['requests:', ...list.map((v) => `  ${formatRequestLine(v)}`)].join('\n') : 'requests: none';
}

export function formatRecord(r: RecordResult): string {
  const publish = r.request?.kind === 'publish';
  return [
    r.message,
    ...(r.expired.length ? [`replaces earlier request(s), now expired: ${r.expired.join(', ')}`] : []),
    ...(r.request ? [publish ? 'owner: approve it in Telegram (the publisher bot), or on the host: `minions settings requests publish <id>`' : 'owner, on the host: `minions upgrade`'] : []),
  ].join('\n');
}
