/**
 * Upgrade requests, recorded in the runtime DB (change_requests). In the agent runtime `minions upgrade
 * [--from-container] --reason <text>` records one instead of failing with "host only"; it changes nothing. The host
 * reads open requests with `settings requests --json` (scripts/dev/self-update.mjs, or the owner), applies one with
 * `minions upgrade` on the host and reports the outcome with the hidden `settings requests mark <id> --status <s>`.
 */
import { randomBytes } from 'node:crypto';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { CHANGE_REQUEST_STATUSES, openDb, type ChangeRequestKind, type ChangeRequestRow, type ChangeRequestStatus, type RuntimeDb } from './db.js';
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

/** One line describing an upgrade request (control characters stripped: the row is container-written). */
export function requestSummary(payload: Record<string, unknown>): string {
  const fc = payload.fromContainer;
  return displayText(`upgrade${fc === true ? ' --from-container' : typeof fc === 'string' ? ` --from-container ${fc}` : ''}`);
}

export const requestView = (r: ChangeRequestRow): ChangeRequestView => {
  const payload = parsePayload(r.payload);
  return {
    id: r.id, kind: r.kind, payload, reason: r.reason, createdAt: r.created_at, status: r.status, updatedAt: r.updated_at, detail: r.detail,
    summary: requestSummary(payload),
  };
};

export interface RecordResult {
  /** A row was written (false: dry run). */
  recorded: boolean;
  /** Always false: a request is applied only on the host. */
  applied: false;
  dryRun: boolean;
  request: ChangeRequestView | null;
  /** Earlier open upgrade requests this one replaced (now expired). */
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
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

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

/** Upgrade requests: open ones (proposed, confirmed, failed), or every status with all. Rows of removed kinds are left out. */
export const listChangeRequests = (db: RuntimeDb, o: { all?: boolean } = {}): ChangeRequestView[] =>
  db.changeRequests(o).filter((r) => r.kind === 'upgrade').map(requestView);

/** Hidden `settings requests mark <id> --status <s>`: the host reports its outcome. */
export function markChangeRequest(db: RuntimeDb, id: string, status: string, detail?: string): ChangeRequestView {
  if (!isChangeRequestId(id)) throw new MinionsError('PRECONDITION', `"${displayText(id)}" is not a change request id (cr_ + 8 hex characters).`);
  if (!(CHANGE_REQUEST_STATUSES as readonly string[]).includes(status) || status === 'proposed') {
    throw new MinionsError('PRECONDITION', `--status must be one of ${CHANGE_REQUEST_STATUSES.filter((s) => s !== 'proposed').join(', ')} (got "${displayText(status)}").`);
  }
  const d = detail?.trim() ? detail.trim().slice(0, REASON_MAX) : null;
  return requestView(db.setChangeRequestStatus(id, status as ChangeRequestStatus, d));
}

// ---------------------------------------------------------------- output

/** A quoted, untrusted reason: control characters stripped, cut to REASON_DISPLAY_MAX characters. */
export function quotedReason(reason: string | null): string {
  if (!reason) return '(no reason given)';
  const r = displayText(reason).replace(/\s+/g, ' ');
  return `"${r.length > REASON_DISPLAY_MAX ? `${r.slice(0, REASON_DISPLAY_MAX)}…` : r}"`;
}

export function formatRequestLine(v: ChangeRequestView): string {
  return `${v.id}  ${v.status.padEnd(9)} ${v.createdAt}  ${v.summary}  reason: ${quotedReason(v.reason)}${v.detail ? `  (${displayText(v.detail)})` : ''}`;
}

export function formatRequests(list: ChangeRequestView[]): string {
  return list.length ? ['upgrade requests:', ...list.map((v) => `  ${formatRequestLine(v)}`)].join('\n') : 'upgrade requests: none';
}

export function formatRecord(r: RecordResult): string {
  return [
    r.message,
    ...(r.expired.length ? [`replaces earlier request(s), now expired: ${r.expired.join(', ')}`] : []),
    ...(r.request ? ['owner, on the host: `minions upgrade`'] : []),
  ].join('\n');
}
