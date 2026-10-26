/**
 * Change requests, runtime side (docs/design/host-manager.md, "How requests reach the manager").
 *
 * In the agent runtime, `minions settings set <key> <value> --reason <text>`, `minions settings restart` and
 * `minions upgrade [--from-container]` do not fail with "host only": they record a request in the runtime DB
 * (change_requests). Recording validates the request against the runtime config and refuses host-owned keys
 * (CONFLICT: the coordinator asks the owner instead). A recorded request changes nothing: the host re-reads it,
 * re-validates it against its own config, builds the plan and applies it only after the owner confirms that
 * plan (src/host/change-requests.ts). The output therefore always says "recorded, not applied".
 */
import { randomBytes } from 'node:crypto';
import { isGithubDelivery } from '../config/delivery.js';
import { validateConfig } from '../config/resolve.js';
import type { MinionsConfig } from '../config/schema.js';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { readJson } from '../core/fsutil.js';
import {
  currentValue, formatValue, parseSettingValue, requireSetting, setPath, takesEffectOf,
  type SettingLayer, type SettingsContext, type TakesEffect,
} from '../host/settings.js';
import { CHANGE_REQUEST_STATUSES, openDb, type ChangeRequestKind, type ChangeRequestRow, type ChangeRequestStatus, type RuntimeDb } from './db.js';
import { runtimePaths } from './paths.js';

/** Request ids: `cr_` + 8 hex characters. */
export const CHANGE_REQUEST_ID_PATTERN = /^cr_[0-9a-f]{8}$/;
export const isChangeRequestId = (s: string) => CHANGE_REQUEST_ID_PATTERN.test(s);
export const newChangeRequestId = () => `cr_${randomBytes(4).toString('hex')}`;

/** Stored reasons are capped; the host shows at most REASON_DISPLAY_MAX characters of it, quoted. */
export const REASON_MAX = 1000;
export const REASON_DISPLAY_MAX = 300;

/** Payload of a `config-set` request. value is the raw CLI text: the host parses and validates it again. */
export interface ConfigSetPayload { key: string; value: string; layer: SettingLayer; baseRevision: number }
/** Payload of an `upgrade` request: --from-container (true: the base branch; a string: that branch). */
export interface UpgradePayload { fromContainer: string | true | null }
export type RestartPayload = Record<string, never>;

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

/** One line describing a request (control characters stripped: the row is container-written). */
export function requestSummary(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'config-set') return displayText(`settings set ${String(payload.key)} ${String(payload.value)}${payload.layer === 'shared' ? ' (shared)' : ''}`);
  if (kind === 'restart') return 'coordinator restart (graceful)';
  if (kind === 'upgrade') {
    const fc = payload.fromContainer;
    return displayText(`upgrade${fc === true ? ' --from-container' : typeof fc === 'string' ? ` --from-container ${fc}` : ''}`);
  }
  return displayText(`unknown kind ${kind}`);
}

export const requestView = (r: ChangeRequestRow): ChangeRequestView => {
  const payload = parsePayload(r.payload);
  return {
    id: r.id, kind: r.kind, payload, reason: r.reason, createdAt: r.created_at, status: r.status, updatedAt: r.updated_at, detail: r.detail,
    summary: requestSummary(r.kind, payload),
  };
};

export interface RecordResult {
  /** A row was written (false: dry run, or the value is already in effect). */
  recorded: boolean;
  /** Always false: a request is applied only on the host, after the owner confirms. */
  applied: false;
  dryRun: boolean;
  /** The requested value is already the runtime's (nothing recorded). */
  unchanged: boolean;
  request: ChangeRequestView | null;
  /** Earlier open requests for the same thing that this one replaced (now expired). */
  expired: string[];
  /** config-set only: the runtime's view of the change (the host recomputes all of it). */
  change?: { key: string; from: unknown; to: unknown; layer: SettingLayer; takesEffect: TakesEffect | null; loosens: string | null };
  /** What the owner runs on the host. */
  applyCommand: string | null;
  rejectCommand: string | null;
  message: string;
}

export interface RecordContext { db: RuntimeDb; config: MinionsConfig }

/** Runs fn with the runtime DB and the runtime config (the regenerated, read-only config.json). */
export async function withRequestContext<T>(fn: (ctx: RecordContext) => T | Promise<T>): Promise<T> {
  const paths = runtimePaths();
  const config = validateConfig(await readJson(paths.configJson), paths.configJson);
  const db = openDb(paths.db);
  try { return await fn({ db, config }); } finally { db.close(); }
}

function cleanReason(reason: string | undefined, required: boolean): string | null {
  const r = (reason ?? '').trim();
  if (!r) {
    if (required) throw new MinionsError('PRECONDITION', 'A change request needs a reason (--reason <text>): the owner sees it with the plan.', 'Add --reason "<why this change is needed>".');
    return null;
  }
  return r.length > REASON_MAX ? r.slice(0, REASON_MAX) : r;
}

const RECORDED_NOTE = 'Recorded only: nothing changed. Tell the owner that a change request is waiting (with its id and reason); never say the change was made. The owner applies it on the host after reviewing the plan.';

function recorded(ctx: RecordContext, kind: ChangeRequestKind, payload: Record<string, unknown>, reason: string | null, dryRun: boolean, extra: Partial<RecordResult> = {}): RecordResult {
  if (dryRun) {
    return {
      recorded: false, applied: false, dryRun: true, unchanged: false, request: null, expired: [], applyCommand: null, rejectCommand: null, ...extra,
      message: `dry run: would record a ${kind} change request (${requestSummary(kind, payload)}); nothing recorded.`,
    };
  }
  const id = newChangeRequestId();
  const { row, expired } = ctx.db.addChangeRequest({ id, kind, payload, reason });
  return {
    recorded: true, applied: false, dryRun: false, unchanged: false, request: requestView(row), expired, ...extra,
    applyCommand: `minions settings apply ${id}`, rejectCommand: `minions settings reject ${id}`,
    message: `Change request ${id} recorded (proposed, not applied): ${requestSummary(kind, payload)}. ${RECORDED_NOTE}`,
  };
}

/** `settings set <key> <value> --reason <text>` in the runtime: validates against the runtime config and records a config-set request. */
export function recordSettingRequest(ctx: RecordContext, key: string, input: string, o: { layer?: SettingLayer; reason?: string; dryRun?: boolean }): RecordResult {
  const def = requireSetting(key);
  if (def.type === 'control') {
    throw new MinionsError('PRECONDITION', `${key} is a runtime control, not a configuration setting: no change request is needed.`,
      `Run \`minions ${key === 'pause.intake' ? 'pause --intake' : 'pause --starts'}\` or \`minions resume\` in the runtime.`, { path: key });
  }
  if (def.hostOwned) {
    throw new MinionsError('CONFLICT', `${key} is host-owned (policy, permissions, secrets or isolation): the container cannot request a change to it; nothing recorded.`,
      `Ask the owner instead: post the reason and the exact command in your chat (\`minions settings set ${key} <value>\` in the host terminal). Never record it as a change request.`, { path: key, hostOwned: true });
  }
  const reason = cleanReason(o.reason, true);
  const layer = o.layer ?? 'local';
  if (layer === 'shared' && ctx.config.visibility !== 'shared') {
    throw new MinionsError('PRECONDITION', 'This is a private install: there is no shared configuration to write.', 'Omit --shared; the owner\'s host-only config.local.json takes the change.');
  }
  const value = parseSettingValue(def, input);
  const view = { config: ctx.config } as SettingsContext; // currentValue reads only the config for configuration settings
  const from = currentValue(def, view);
  const next = validateConfig(setPath(structuredClone(ctx.config) as unknown as Record<string, unknown>, key, value), `change request ${key}`);
  const to = currentValue(def, { config: next } as SettingsContext);
  const changed = JSON.stringify(from) !== JSON.stringify(to);
  const change = { key, from, to, layer, takesEffect: changed ? takesEffectOf(def.class) : null, loosens: changed && def.loosens ? def.loosens(from, to) : null };
  if (!changed) {
    return {
      recorded: false, applied: false, dryRun: !!o.dryRun, unchanged: true, request: null, expired: [], change, applyCommand: null, rejectCommand: null,
      message: `${key} is already ${formatValue(from)} in the runtime config; nothing recorded.`,
    };
  }
  const payload: ConfigSetPayload = { key, value: input.trim(), layer, baseRevision: ctx.config.configRevision };
  return recorded(ctx, 'config-set', { ...payload }, reason, !!o.dryRun, { change });
}

/** `settings restart` in the runtime: records a coordinator restart request. */
export function recordRestartRequest(ctx: RecordContext, o: { reason?: string; dryRun?: boolean }): RecordResult {
  return recorded(ctx, 'restart', {}, cleanReason(o.reason, false), !!o.dryRun);
}

const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** `upgrade [--from-container [branch]]` in the runtime: records an upgrade request. */
export function recordUpgradeRequest(ctx: RecordContext, o: { fromContainer?: string | boolean; reason?: string; dryRun?: boolean }): RecordResult {
  let fromContainer: UpgradePayload['fromContainer'] = null;
  if (o.fromContainer !== undefined && o.fromContainer !== false) {
    if (isGithubDelivery(ctx.config)) {
      throw new MinionsError('PRECONDITION', '--from-container is for local delivery only: with GitHub delivery the upgrade always takes origin/<base>.', 'Request `minions upgrade` without --from-container.');
    }
    if (typeof o.fromContainer === 'string') {
      if (!BRANCH_RE.test(o.fromContainer)) throw new MinionsError('PRECONDITION', `--from-container: "${displayText(o.fromContainer)}" is not a branch name.`);
      fromContainer = o.fromContainer;
    } else fromContainer = true;
  }
  const payload: UpgradePayload = { fromContainer };
  return recorded(ctx, 'upgrade', { ...payload }, cleanReason(o.reason, false), !!o.dryRun);
}

export const listChangeRequests = (db: RuntimeDb, o: { all?: boolean } = {}): ChangeRequestView[] => db.changeRequests(o).map(requestView);

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
  return list.length ? ['change requests:', ...list.map((v) => `  ${formatRequestLine(v)}`)].join('\n') : 'change requests: none';
}

export function formatRecord(r: RecordResult): string {
  return [
    r.message,
    ...(r.change && !r.unchanged ? [`requested: ${r.change.key}: ${formatValue(r.change.from)} -> ${formatValue(r.change.to)}${r.change.loosens ? ` (loosens: ${r.change.loosens})` : ''}`] : []),
    ...(r.expired.length ? [`replaces earlier request(s), now expired: ${r.expired.join(', ')}`] : []),
    ...(r.applyCommand ? [`owner, on the host: ${r.applyCommand}  (or: ${r.rejectCommand})`] : []),
  ].join('\n');
}
