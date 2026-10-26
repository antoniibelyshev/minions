// Change requests, host side (docs/design/host-manager.md, "Confirmation model"): the terminal route of
// `minions settings requests | apply <id> | reject <id>`. The manager (task-53.4) reuses the same plan, digest and
// journal functions.
//
// - A request row is a claim, never an authorization. The host reads it through the runtime, re-validates it
//   against the host's own config (planSetting -> resolveEffective), and computes the plan itself: the exact diff,
//   the layer and file, the class, what it loosens, what it interrupts and the commands it runs. Host-owned keys are
//   refused again here, whatever the row says.
// - digest = sha256(canonical plan JSON). The offer (digest, configRevision, single-use nonce, 30 minute expiry,
//   and the request as read) goes to the host journal (src/host/change-journal.ts). A confirmation names the
//   digest; the host then rebuilds the plan from the journaled request (not from the container's row), and applies
//   only when the digest and the configRevision are unchanged and the offer is unexpired and unspent.
// - Apply runs the existing host paths: applySetting with --expect-revision (no restart: a needed restart is
//   offered as its own step), the graceful coordinator restart, or `minions upgrade` as a child process. The runtime
//   row then becomes applied / failed (best effort: a runtime that cannot be reached leaves a warning).
// - Owner-initiated requests (task-53.5.3: /set, /sync, /upgrade, /restart, /undo in the manager chat) take the same
//   plan, digest, offer and confirmation. Their snapshot has `origin: 'owner'` and an `ow_` id minted by the host,
//   so they may set host-owned keys (owner decision Q2; a container request never may), there is no runtime row to
//   mark, and two kinds exist only for them: `sync` (`minions upgrade --sync-only`) and `undo` (restore a config
//   file from the config history, src/host/config-history.ts).
import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { isGithubDelivery } from '../config/delivery.js';
import { action, globalOpts, requireMode, runtimeMode } from '../core/cli-helpers.js';
import { displayText } from '../core/control-chars.js';
import { MinionsError, type ErrorCode } from '../core/errors.js';
import { sha256 } from '../core/fsutil.js';
import { emit } from '../core/output.js';
import type { ChangeRequestKind } from '../runtime/db.js';
import {
  formatRequestLine, formatRequests, listChangeRequests, markChangeRequest, quotedReason, requestSummary, withRequestContext, type ChangeRequestView,
} from '../runtime/change-requests.js';
import { inMinionsContainer } from '../runtime/paths.js';
import {
  assertOfferOpen, consumeOffer, findOffer, isOwnerRequest, isOwnerRequestId, readJournal, recordOffer, recordOutcome, type OfferEntry, type RequestSnapshot,
} from './change-journal.js';
import { applyUndo, beginHistory, checkUndo, completeHistory, strongestEffect, undoDiff, validateRestore } from './config-history.js';
import { packageRoot } from './docker.js';
import { loadEffectiveConfig, loadProjectJson, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import {
  applySetting, effectText, formatSet, restartCoordinator, RESTART_LATER, UPGRADE_LATER,
  type RestartOutcome, type SetResult, type SettingsRuntime,
} from './settings-cli.js';
import { formatValue, loadSettingsContext, parseSettingValue, planSetting, requireSetting, takesEffectOf, type SettingLayer, type TakesEffect } from './settings.js';

// ---------------------------------------------------------------- plan and digest

/** The kinds of a plan: the container's request kinds, plus the owner-only sync and undo. */
export type PlanKind = ChangeRequestKind | 'sync' | 'undo';

export interface ChangePlan {
  requestId: string;
  projectId: string;
  kind: PlanKind;
  /** 'owner': typed by the owner in the manager chat (absent for a container request, so older digests stay valid). */
  origin?: 'owner';
  /**
   * undo: the change it reverts, the sha256 of the file text that change wrote (the compare-and-swap value) and of the
   * text it restores, and every setting the restore changes in that file (`change` is the first, the entry's own key).
   */
  undo?: { target: string; expectSha256: string; restoreSha256: string; changes: { key: string; from: unknown; to: unknown; class: string }[] };
  /** The effective configRevision the plan was computed against. */
  configRevision: number;
  /** The request's reason as shown to the owner: quoted, control characters stripped, cut to 300 characters. */
  reason: string;
  /** config-set: the host-computed diff. */
  change: { key: string; from: unknown; to: unknown; layer: SettingLayer; file: string; class: string; takesEffect: TakesEffect | null } | null;
  /** What the change newly allows (null: does not loosen policy). */
  loosens: string | null;
  /** What applying it interrupts or still needs afterwards. */
  interrupts: string | null;
  /** The host commands applying it runs. */
  steps: string[];
  /** upgrade: the step ids of `minions upgrade --dry-run` (their details are shown, not digested). */
  upgradeSteps: string[] | null;
}

/** JSON with sorted keys (undefined members dropped), the input of the digest. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const planDigest = (plan: ChangePlan): string => sha256(canonicalJson(plan));

export interface UpgradeRun { ok: boolean; steps: { id: string; status: string; detail: string }[]; summary: string }

/** What change requests need from the host (faked in tests). */
export interface ChangeRequestDeps {
  runtime: SettingsRuntime;
  /**
   * Runs `minions upgrade [--from-container [branch]] [--dry-run]` for the project as a child process; with syncOnly,
   * `minions upgrade --sync-only` (the source sync only: export and strict fast-forward, or origin with GitHub delivery).
   */
  upgrade: (project: ProjectJson, o: { fromContainer: string | true | null; dryRun: boolean; syncOnly?: boolean }) => Promise<UpgradeRun>;
  now?: () => Date;
}

const q = (s: string) => (/^[A-Za-z0-9._,:/=@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export const fromContainerOf = (payload: Record<string, unknown>): string | true | null => {
  const fc = payload.fromContainer;
  return fc === true ? true : typeof fc === 'string' ? fc : null;
};

/**
 * The host command (argv after `minions`) that applies a plan, built from the plan and the journaled request
 * snapshot. `plan.steps` is this argv as text, so the digest covers exactly what runs. The host manager runs it as a
 * child process; `settings apply` runs the same paths in-process.
 */
export function planArgv(plan: Pick<ChangePlan, 'kind' | 'change' | 'configRevision'>, req: Pick<RequestSnapshot, 'payload'>): string[] {
  if (plan.kind === 'config-set') {
    const c = plan.change;
    if (!c) throw new MinionsError('INTERNAL', 'config-set plan without a change.');
    return ['settings', 'set', c.key, String(req.payload.value), ...(c.layer === 'shared' ? ['--shared'] : []), '--yes', '--no-restart', '--expect-revision', String(plan.configRevision)];
  }
  if (plan.kind === 'restart') return ['settings', 'restart'];
  if (plan.kind === 'upgrade') {
    const fc = fromContainerOf(req.payload);
    return ['upgrade', ...(fc === true ? ['--from-container'] : fc ? ['--from-container', fc] : [])];
  }
  if (plan.kind === 'sync') return ['upgrade', '--sync-only'];
  if (plan.kind === 'undo') throw new MinionsError('INTERNAL', 'an undo runs in the host manager, not as a child command.');
  throw new MinionsError('PRECONDITION', `Unknown change kind "${displayText(String(plan.kind))}".`);
}

const stepText = (argv: string[]) => `minions ${argv.map(q).join(' ')}`;

/** The request as read from the runtime (only the fields the plan uses). */
export const snapshotOf = (v: Pick<ChangeRequestView, 'id' | 'kind' | 'payload' | 'reason'>): RequestSnapshot =>
  ({ id: v.id, kind: v.kind, payload: v.payload, reason: v.reason });

/**
 * The slow part of an upgrade plan: `minions upgrade --dry-run` as a child process (after the cheap delivery check).
 * Throws PRECONDITION when the dry run reports that the upgrade would fail. confirmOffer runs it before taking the
 * journal lock and hands the result to buildPlan (task-53.11).
 */
export async function upgradeDryRun(project: ProjectJson, req: RequestSnapshot, deps: Pick<ChangeRequestDeps, 'upgrade'>): Promise<UpgradeRun> {
  if (req.kind === 'sync') {
    const dry = await deps.upgrade(project, { fromContainer: null, dryRun: true, syncOnly: true });
    if (!dry.ok) {
      throw new MinionsError('PRECONDITION', `Request ${req.id}: \`minions upgrade --sync-only --dry-run\` reports that the sync would be refused (nothing is ever forced, reset or stashed): ${dry.summary}`,
        'Fix that on the host first (commit or stash yourself, or merge a divergence), then send /sync again.');
    }
    return dry;
  }
  const fromContainer = fromContainerOf(req.payload);
  await assertUpgradeDelivery(project, req, fromContainer);
  const dry = await deps.upgrade(project, { fromContainer, dryRun: true });
  if (!dry.ok) {
    throw new MinionsError('PRECONDITION', `Change request ${req.id}: \`minions upgrade --dry-run\` reports that the upgrade would fail: ${dry.summary}`, 'Fix that first (run `minions upgrade --dry-run` for the details), then apply again.');
  }
  return dry;
}

async function assertUpgradeDelivery(project: ProjectJson, req: RequestSnapshot, fromContainer: string | true | null): Promise<void> {
  if (fromContainer !== null && isGithubDelivery((await loadEffectiveConfig(project)).config)) {
    throw new MinionsError('PRECONDITION', `Change request ${req.id}: --from-container is for local delivery only; this project delivers through GitHub.`, `Reject it: \`minions settings reject ${req.id}\`.`);
  }
}

/**
 * Builds the host plan of a request: validated against the host's config, never trusting the row's own view.
 * Throws CONFLICT for host-owned keys, PRECONDITION for anything that cannot be applied. `pre.dry`: an upgrade dry
 * run already made for this request (upgradeDryRun); everything else is still read now.
 */
export async function buildPlan(project: ProjectJson, req: RequestSnapshot, deps: ChangeRequestDeps, pre: { dry?: UpgradeRun } = {}): Promise<{ plan: ChangePlan; notes: string[] }> {
  const owner = isOwnerRequest(req);
  if (!owner && (req.kind === 'sync' || req.kind === 'undo' || req.origin !== undefined || isOwnerRequestId(req.id))) {
    throw new MinionsError('PRECONDITION', `Change request ${displayText(req.id)}: kind "${displayText(String(req.kind))}" comes only from the owner in the manager chat; nothing to apply.`);
  }
  const base = { requestId: req.id, projectId: project.projectId, reason: quotedReason(req.reason), change: null, loosens: null, upgradeSteps: null, ...(owner ? { origin: 'owner' as const } : {}) };
  if (req.kind === 'config-set') {
    const { key, value, layer } = req.payload as { key?: unknown; value?: unknown; layer?: unknown };
    if (typeof key !== 'string' || typeof value !== 'string' || (layer !== 'local' && layer !== 'shared')) {
      throw new MinionsError('PRECONDITION', `Change request ${req.id}: malformed config-set payload; nothing to apply.`, `Reject it: \`minions settings reject ${req.id}\`.`);
    }
    const def = requireSetting(key);
    if (def.hostOwned && !owner) {
      throw new MinionsError('CONFLICT', `Change request ${req.id}: ${key} is host-owned; a request from the container is never applied.`,
        `If you want this change, make it yourself: \`minions settings set ${key} ${q(value)}\`. Then \`minions settings reject ${req.id}\`.`, { path: key, hostOwned: true });
    }
    if (def.type === 'secret' || def.type === 'control') throw new MinionsError('PRECONDITION', `Change request ${req.id}: ${key} is not a configuration setting.`);
    const ctx = await loadSettingsContext(project);
    const change = await planSetting(ctx, key, parseSettingValue(def, value), layer);
    if (!change.changed) {
      throw new MinionsError('PRECONDITION', `Change request ${req.id}: ${key} is already ${formatValue(change.from)} on the host; nothing to apply.`, `Reject it: \`minions settings reject ${req.id}\`.`);
    }
    const takesEffect = takesEffectOf(change.class);
    return {
      plan: {
        ...base, kind: 'config-set', configRevision: change.revision,
        change: { key, from: change.from, to: change.to, layer, file: change.file, class: change.class, takesEffect },
        loosens: change.loosens,
        interrupts: change.needsRestart ? `nothing now; ${RESTART_LATER}` : change.needsUpgrade ? `nothing now; ${UPGRADE_LATER}` : null,
        steps: [stepText(planArgv({ kind: 'config-set', configRevision: change.revision, change: { key, from: change.from, to: change.to, layer, file: change.file, class: change.class, takesEffect } }, req))],
      },
      notes: [effectText(takesEffect), ...change.warnings.map((w) => `warning: ${w}`)].filter(Boolean),
    };
  }
  const configRevision = (await loadEffectiveConfig(project)).config.configRevision;
  if (req.kind === 'restart') {
    return {
      plan: { ...base, kind: 'restart', configRevision, interrupts: 'the coordinator session restarts (graceful: refused while worker leases are active; running workers are never interrupted)', steps: [stepText(planArgv({ kind: 'restart', change: null, configRevision }, req))] },
      notes: [],
    };
  }
  if (req.kind === 'sync') {
    const dry = pre.dry ?? await upgradeDryRun(project, req, deps);
    return {
      plan: { ...base, kind: 'sync', configRevision, upgradeSteps: dry.steps.map((s) => s.id), steps: [stepText(planArgv({ kind: 'sync', change: null, configRevision }, req))], interrupts: null },
      notes: dry.steps.map((s) => `${s.id}: ${s.detail}`),
    };
  }
  if (req.kind === 'undo') return planUndo(project, req, base, configRevision);
  if (req.kind === 'upgrade') {
    let dry = pre.dry;
    if (dry) await assertUpgradeDelivery(project, req, fromContainerOf(req.payload));
    else dry = await upgradeDryRun(project, req, deps);
    return {
      plan: {
        ...base, kind: 'upgrade', configRevision, upgradeSteps: dry.steps.map((s) => s.id), steps: [stepText(planArgv({ kind: 'upgrade', change: null, configRevision }, req))],
        interrupts: 'pauses starts and drains active workers (they commit wip: and hand back), recreates the container (volumes kept) and restarts the coordinator',
      },
      notes: dry.steps.map((s) => `${s.id}: ${s.detail}`),
    };
  }
  throw new MinionsError('PRECONDITION', `Change request ${req.id}: unknown kind "${displayText(String(req.kind))}"; nothing to apply.`, `Reject it: \`minions settings reject ${req.id}\`.`);
}

/**
 * The undo of a config change applied by the host manager: restore the file text before it (compare-and-swap). The
 * history entry is not trusted: the file comes from the project and the entry's layer, and the plan lists every
 * setting the restore changes (the loosening check runs over all of them); anything else changing refuses.
 */
async function planUndo(project: ProjectJson, req: RequestSnapshot, base: Omit<ChangePlan, 'kind' | 'configRevision' | 'interrupts' | 'steps'>, configRevision: number): Promise<{ plan: ChangePlan; notes: string[] }> {
  const target = req.payload.target;
  if (typeof target !== 'string') throw new MinionsError('PRECONDITION', `Request ${req.id}: malformed undo payload; nothing to apply.`);
  const check = await checkUndo(project, target);
  const { entry, file, expectSha256, restoreSha256 } = check;
  const restored = await validateRestore(project, entry);
  const changes = undoDiff(await loadSettingsContext(project), check, restored);
  const first = changes[0]!;
  const takesEffect = strongestEffect(changes);
  const loosening = changes.filter((c) => c.loosens);
  return {
    plan: {
      ...base, kind: 'undo', configRevision,
      undo: { target, expectSha256, restoreSha256, changes: changes.map((c) => ({ key: c.key, from: c.from, to: c.to, class: c.class })) },
      change: { key: first.key, from: first.from, to: first.to, layer: entry.layer, file, class: first.class, takesEffect },
      loosens: loosening.length === 0 ? null : changes.length === 1 ? loosening[0]!.loosens : loosening.map((c) => `${c.key}: ${c.loosens}`).join('; '),
      interrupts: takesEffect === 'restart' ? `nothing now; ${RESTART_LATER}` : takesEffect === 'upgrade' ? `nothing now; ${UPGRADE_LATER}` : null,
      steps: [`restore ${file} as it was before ${target} (in the host manager; refused unless the file is still exactly what ${target} wrote, sha256 ${expectSha256.slice(0, 12)})`],
    },
    notes: [effectText(takesEffect), `the whole file returns to its text before ${target} (${entry.at})${entry.layer === 'shared' ? '; configRevision still moves forward' : ''}`].filter(Boolean),
  };
}

export function formatPlan(plan: ChangePlan, digest: string, notes: string[]): string {
  const owner = plan.origin === 'owner';
  return displayText([
    `${owner ? 'owner request' : 'change request'} ${plan.requestId} (${plan.kind}) for project ${plan.projectId}, configRevision ${plan.configRevision}`,
    owner ? 'requested by you in the manager chat (typing the command is not consent: confirm this exact plan)' : `reason (from the container, untrusted): ${plan.reason}`,
    ...(plan.undo ? [`undoes: ${plan.undo.target}`] : []),
    ...(plan.undo && plan.undo.changes.length > 1
      ? plan.undo.changes.map((c) => `change: ${c.key}: ${formatValue(c.from)} -> ${formatValue(c.to)} (${plan.change?.layer ?? ''} layer, ${plan.change?.file ?? ''}; class ${c.class})`)
      : plan.change ? [`change: ${plan.change.key}: ${formatValue(plan.change.from)} -> ${formatValue(plan.change.to)} (${plan.change.layer} layer, ${plan.change.file}; class ${plan.change.class})`] : []),
    ...(plan.loosens ? [`LOOSENS POLICY: ${plan.loosens}`] : []),
    ...(plan.interrupts ? [`interrupts: ${plan.interrupts}`] : []),
    'runs:', ...plan.steps.map((s) => `  ${s}`),
    ...(notes.length ? ['notes:', ...notes.map((n) => `  ${n}`)] : []),
    `digest: ${digest}`,
  ].join('\n'));
}

// ---------------------------------------------------------------- runtime access

const lastEnvelope = <T>(stdout: string): { ok: boolean; data?: T; error?: { code?: string; message?: string; hint?: string } } | null => {
  try { return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { return null; }
};
const PASS_CODES: readonly string[] = ['NOT_FOUND', 'PRECONDITION', 'CONFLICT'];

async function runtimeJson<T>(project: ProjectJson, runtime: SettingsRuntime, args: string[], what: string): Promise<T> {
  if (!(await runtime.running(project))) {
    throw new MinionsError('PRECONDITION', `The runtime is not running, so ${what} cannot be reached.`, 'Run `minions start --no-attach` first (change requests live in the runtime database).');
  }
  const r = await runtime.exec(project, ['minions', ...args, '--json']);
  const env = lastEnvelope<T>(r.stdout);
  if (!env) throw new MinionsError('INTERNAL', `${what}: unexpected output from the runtime.`, undefined, { stdout: r.stdout.slice(-500), stderr: r.stderr.slice(-500) });
  if (!env.ok) {
    const code = (PASS_CODES.includes(env.error?.code ?? '') ? env.error!.code : 'INTERNAL') as ErrorCode;
    throw new MinionsError(code, `${what}: ${displayText(env.error?.message ?? 'failed in the runtime')}`, env.error?.hint ? displayText(env.error.hint) : undefined);
  }
  return env.data as T;
}

export async function fetchRequests(project: ProjectJson, runtime: SettingsRuntime, all: boolean): Promise<ChangeRequestView[]> {
  const d = await runtimeJson<{ requests: ChangeRequestView[] }>(project, runtime, ['settings', 'requests', ...(all ? ['--all'] : [])], 'change requests');
  return Array.isArray(d?.requests) ? d.requests : [];
}

async function fetchRequest(project: ProjectJson, runtime: SettingsRuntime, id: string): Promise<ChangeRequestView> {
  const found = (await fetchRequests(project, runtime, true)).find((r) => r.id === id);
  if (!found) throw new MinionsError('NOT_FOUND', `No change request ${displayText(id)} in the runtime.`, 'List requests with `minions settings requests`.');
  return found;
}

/** Marks the runtime row; returns a warning instead of throwing (the host's outcome stands either way). */
export async function mark(project: ProjectJson, runtime: SettingsRuntime, id: string, status: string, detail: string): Promise<string | null> {
  if (isOwnerRequestId(id)) return null; // owner-initiated: no runtime row (the journal is its only record)
  try {
    await runtimeJson(project, runtime, ['settings', 'requests', 'mark', id, '--status', status, '--detail', detail.slice(0, 900)], `marking change request ${id} ${status}`);
    return null;
  } catch (e) {
    return `change request ${id} could not be marked ${status} in the runtime: ${(e as Error).message}`;
  }
}

const openStatus = (s: string) => s === 'proposed' || s === 'failed';

// ---------------------------------------------------------------- apply / reject

export interface ApplyOutcome {
  requestId: string;
  kind: PlanKind;
  /** planned: dry run; offered: recorded for confirmation, nothing applied; applied / failed: the outcome. */
  status: 'planned' | 'offered' | 'applied' | 'failed';
  applied: boolean;
  plan: ChangePlan;
  digest: string;
  notes: string[];
  expiresAt: string | null;
  /** offered: the command that confirms exactly this plan. */
  confirmCommand: string | null;
  detail: string;
  set?: SetResult;
  restart?: RestartOutcome;
  upgrade?: UpgradeRun;
  marked: boolean;
  warnings: string[];
  nextSteps: string[];
}

const outcomeBase = (offer: { plan: ChangePlan; digest: string; notes: string[] }) => ({
  requestId: offer.plan.requestId, kind: offer.plan.kind, plan: offer.plan, digest: offer.digest, notes: offer.notes,
  marked: false, warnings: [] as string[], nextSteps: [] as string[],
});

/** Builds the plan and records an offer (30 minutes) in the host journal. Nothing is applied. */
export async function offerRequest(project: ProjectJson, req: RequestSnapshot, deps: ChangeRequestDeps): Promise<{ offer: OfferEntry; plan: ChangePlan; digest: string; notes: string[] }> {
  const { plan, notes } = await buildPlan(project, req, deps);
  const digest = planDigest(plan);
  const offer = await recordOffer({ projectId: project.projectId, request: req, plan, digest, configRevision: plan.configRevision, now: deps.now?.() });
  return { offer, plan, digest, notes };
}

/**
 * Confirms the offer with this digest and applies it. Refuses (nothing applied) when there is no such offer, when it
 * was already used, when it expired, or when the plan recomputed now from the journaled request differs (digest or
 * configRevision).
 */
export async function confirmRequest(project: ProjectJson, requestId: string, digest: string, deps: ChangeRequestDeps): Promise<ApplyOutcome> {
  const found = await findOffer(project.projectId, requestId, digest);
  const again = `Run \`minions settings apply ${requestId}\` again for a fresh plan.`;
  if (!found) throw new MinionsError('PRECONDITION', `No offered plan for change request ${displayText(requestId)} with digest ${displayText(digest)}.`, again);
  if (found.spent) throw new MinionsError('CONFLICT', `Change request ${requestId}: this confirmation was already used (already handled).`, 'List requests with `minions settings requests --all`.', { refusal: 'spent' });
  const { offer } = found;
  const current = await confirmOffer(project, offer, deps, again);
  const plan = offer.plan as ChangePlan;
  const out: ApplyOutcome = { ...outcomeBase({ plan, digest, notes: current.notes }), status: 'failed', applied: false, expiresAt: offer.expiresAt, confirmCommand: null, detail: '' };
  const w = await mark(project, deps.runtime, requestId, 'confirmed', `confirmed on the host (digest ${digest.slice(0, 12)})`);
  if (w) out.warnings.push(w);
  try {
    await execute(project, plan, offer, out, deps);
  } catch (e) {
    out.status = 'failed';
    out.detail = (e as Error).message;
    await finish(project, out, deps);
    throw e;
  }
  await finish(project, out, deps);
  return out;
}

/**
 * The confirmation checks of one offer, and its `confirmed` entry, as one step under the journal lock (replay
 * protection): refuses when the nonce is spent or the request already handled (CONFLICT), when the offer expired,
 * or when the plan recomputed now from the journaled request differs (configRevision or digest). Errors carry
 * `details.refusal`: spent | handled | expired | revision | digest. Returns the recomputed plan and its notes.
 *
 * The upgrade dry run (a child process that can outlast the 10 s other writers wait for the lock) runs before the
 * lock is taken, after an advisory early check of the same refusals; under the lock the refusals are checked again
 * and the rest of the plan (configRevision, delivery, digest) is rebuilt with that dry run (task-53.11).
 */
export async function confirmOffer(project: ProjectJson, offer: OfferEntry, deps: ChangeRequestDeps, again?: string): Promise<{ plan: ChangePlan; notes: string[] }> {
  const requestId = offer.requestId;
  const hint = again ?? `Run \`minions settings apply ${requestId}\` again for a fresh plan.`;
  const assertUnexpired = () => {
    const now = deps.now?.() ?? new Date();
    if (now.getTime() > Date.parse(offer.expiresAt)) {
      throw new MinionsError('PRECONDITION', `Change request ${requestId}: the confirmation expired at ${offer.expiresAt} (plans are valid for 30 minutes); nothing applied.`, hint, { refusal: 'expired' });
    }
  };
  let pre: { dry?: UpgradeRun } = {};
  if (offer.request.kind === 'upgrade' || offer.request.kind === 'sync') {
    // Outside the lock: refuse early what would be refused anyway, then the slow dry run.
    assertOfferOpen(await readJournal(), offer);
    assertUnexpired();
    pre = { dry: await upgradeDryRun(project, offer.request, deps) };
  }
  let current: { plan: ChangePlan; notes: string[] } | undefined;
  await consumeOffer(offer, async () => {
    assertUnexpired();
    // Recompute from the request as journaled (never the container's row again) against the host as it is now.
    current = await buildPlan(project, offer.request, deps, pre);
    if (current.plan.configRevision !== offer.configRevision) {
      throw new MinionsError('CONFLICT', `Change request ${requestId}: the configuration moved from revision ${offer.configRevision} to ${current.plan.configRevision} since the plan was shown; nothing applied.`, hint, { refusal: 'revision' });
    }
    if (planDigest(current.plan) !== offer.digest) {
      throw new MinionsError('CONFLICT', `Change request ${requestId}: the plan changed since it was shown (digest mismatch); nothing applied.`, hint, { refusal: 'digest' });
    }
  }, deps.now?.());
  return current!;
}

async function execute(project: ProjectJson, plan: ChangePlan, offer: OfferEntry, out: ApplyOutcome, deps: ChangeRequestDeps): Promise<void> {
  if (plan.kind === 'config-set') {
    const c = plan.change!;
    const value = String((offer.request.payload as { value?: unknown }).value);
    const ctx = await loadSettingsContext(project);
    const h = await beginHistory(project, plan.requestId, c, deps.now?.());
    const r = await applySetting(ctx, c.key, value, { layer: c.layer, yes: true, restart: false, expectRevision: plan.configRevision },
      { runtime: deps.runtime, confirm: async () => null });
    if (r.written) await completeHistory(h);
    out.set = r;
    out.applied = r.written;
    out.status = r.written ? 'applied' : 'failed';
    out.detail = r.written ? `${c.key}: ${formatValue(r.from)} -> ${formatValue(r.to)} written to ${r.file}` : `${c.key} was not written`;
    out.warnings.push(...r.warnings);
    out.nextSteps.push(...r.nextSteps);
    if (r.restart?.action === 'offered') out.nextSteps.push(r.restart.detail);
    return;
  }
  if (plan.kind === 'restart') {
    const r = await restartCoordinator(project, deps.runtime);
    out.restart = r;
    out.applied = r.action === 'restarted';
    out.status = out.applied ? 'applied' : 'failed';
    out.detail = `coordinator restart: ${r.action} - ${r.detail}`;
    return;
  }
  if (plan.kind === 'undo') {
    const r = await applyUndo(project, { target: plan.undo!.target, expectSha256: plan.undo!.expectSha256, restoreSha256: plan.undo!.restoreSha256, undoId: plan.requestId, now: deps.now?.() });
    out.applied = true;
    out.status = 'applied';
    out.detail = undoDetail(plan);
    out.warnings.push(...r.warnings);
    return;
  }
  if (plan.kind === 'sync') {
    const r = await deps.upgrade(project, { fromContainer: null, dryRun: false, syncOnly: true });
    out.upgrade = r;
    out.applied = r.ok;
    out.status = r.ok ? 'applied' : 'failed';
    out.detail = `sync: ${r.summary}`;
    return;
  }
  const r = await deps.upgrade(project, { fromContainer: fromContainerOf(offer.request.payload), dryRun: false });
  out.upgrade = r;
  out.applied = r.ok;
  out.status = r.ok ? 'applied' : 'failed';
  out.detail = `upgrade: ${r.summary}`;
  if (!r.ok) out.nextSteps.push(`Fix the failed step, then rerun \`${plan.steps[0]}\` on the host (the upgrade marker lets a rerun finish the job).`);
}

export const undoDetail = (plan: ChangePlan) =>
  `undid ${plan.undo?.target ?? '?'}: ${(plan.undo?.changes.length ? plan.undo.changes : plan.change ? [plan.change] : []).map((c) => `${c.key}: ${formatValue(c.from)} -> ${formatValue(c.to)}`).join(', ') || 'setting'} (${plan.change?.file ?? ''} restored)`;

async function finish(project: ProjectJson, out: ApplyOutcome, deps: ChangeRequestDeps): Promise<void> {
  const r = await recordApplyResult(project, { requestId: out.requestId, digest: out.digest, status: out.status === 'applied' ? 'applied' : 'failed', detail: out.detail }, deps);
  out.warnings.push(...r.warnings);
  out.marked = r.marked;
}

/** Journals the outcome of an apply and marks the runtime row (both best effort: problems come back as warnings). */
export async function recordApplyResult(project: ProjectJson, o: { requestId: string; digest: string; status: 'applied' | 'failed'; detail: string },
  deps: Pick<ChangeRequestDeps, 'runtime' | 'now'>): Promise<{ marked: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  await recordOutcome({ type: o.status, projectId: project.projectId, requestId: o.requestId, digest: o.digest, detail: o.detail }, deps.now?.())
    .catch((e: unknown) => { warnings.push(`journal: ${(e as Error).message}`); });
  const w = await mark(project, deps.runtime, o.requestId, o.status, o.detail);
  if (w) warnings.push(w);
  return { marked: !w, warnings };
}

export interface ApplyIO {
  /** Yes/no question; null when no terminal can answer. */
  confirm: (question: string) => Promise<boolean | null>;
  /** Shows the plan before the question (human mode: stderr). */
  show?: (text: string) => void;
}

/**
 * `minions settings apply <id>` (host): dry run -> the plan; --confirm <digest> -> applies that offered plan;
 * otherwise records an offer and confirms it (--yes, or a terminal question; loosening plans ask twice). Without
 * a terminal and without --yes the offer is returned with its confirm command: nothing is applied.
 */
export async function applyRequest(project: ProjectJson, id: string, o: { yes?: boolean; confirm?: string; dryRun?: boolean }, deps: ChangeRequestDeps, io: ApplyIO): Promise<ApplyOutcome> {
  if (o.confirm !== undefined) {
    if (o.dryRun) throw new MinionsError('PRECONDITION', '--confirm and --dry-run exclude each other.');
    return confirmRequest(project, id, o.confirm.trim(), deps);
  }
  const req = await fetchRequest(project, deps.runtime, id);
  if (!openStatus(req.status)) {
    throw new MinionsError('PRECONDITION', `Change request ${id} is ${req.status}; nothing to apply.`, 'List open requests with `minions settings requests`.');
  }
  if (o.dryRun) {
    const { plan, notes } = await buildPlan(project, snapshotOf(req), deps);
    return { ...outcomeBase({ plan, digest: planDigest(plan), notes }), status: 'planned', applied: false, expiresAt: null, confirmCommand: null, detail: 'dry run: nothing offered or applied' };
  }
  const offered = await offerRequest(project, snapshotOf(req), deps);
  const confirmCommand = `minions settings apply ${id} --confirm ${offered.digest}`;
  const offeredOut = (): ApplyOutcome => ({
    ...outcomeBase(offered), status: 'offered', applied: false, expiresAt: offered.offer.expiresAt, confirmCommand,
    detail: `offered, not applied: confirm this exact plan before ${offered.offer.expiresAt}`,
  });
  if (!o.yes) {
    io.show?.(formatPlan(offered.plan, offered.digest, offered.notes));
    const ok = await io.confirm(`Apply change request ${id} (${requestSummary(req.kind, req.payload)})? (y/N)`);
    if (ok === null) return offeredOut();
    if (!ok) throw new MinionsError('PRECONDITION', `Not confirmed; change request ${id} was not applied (it stays ${req.status}).`, `Reject it with \`minions settings reject ${id}\`, or apply it later.`);
    if (offered.plan.loosens) {
      const again = await io.confirm(`This loosens policy: ${offered.plan.loosens}. Apply it anyway? (y/N)`);
      if (again !== true) throw new MinionsError('PRECONDITION', `Not confirmed twice; change request ${id} was not applied (it stays ${req.status}).`);
    }
  }
  return confirmRequest(project, id, offered.digest, deps);
}

export interface RejectOutcome { requestId: string; status: 'rejected'; marked: boolean; detail: string; warnings: string[] }

/** `minions settings reject <id>` (host): marks an open request rejected (nothing is applied). */
export async function rejectRequest(project: ProjectJson, id: string, o: { reason?: string }, deps: Pick<ChangeRequestDeps, 'runtime' | 'now'>): Promise<RejectOutcome> {
  if (isOwnerRequestId(id)) {
    // Owner-initiated: no runtime row; the journal entry is the whole record.
    const detail = `rejected by the owner${o.reason?.trim() ? ` ${o.reason.trim()}` : ''}`;
    await recordOutcome({ type: 'rejected', projectId: project.projectId, requestId: id, detail }, deps.now?.());
    return { requestId: id, status: 'rejected', marked: false, detail, warnings: [] };
  }
  const req = await fetchRequest(project, deps.runtime, id);
  if (!openStatus(req.status)) throw new MinionsError('PRECONDITION', `Change request ${id} is ${req.status}; nothing to reject.`, 'List open requests with `minions settings requests`.');
  const detail = `rejected on the host${o.reason?.trim() ? `: ${o.reason.trim()}` : ''}`;
  await runtimeJson(project, deps.runtime, ['settings', 'requests', 'mark', id, '--status', 'rejected', '--detail', detail.slice(0, 900)], `marking change request ${id} rejected`);
  const warnings: string[] = [];
  await recordOutcome({ type: 'rejected', projectId: project.projectId, requestId: id, detail }, deps.now?.()).catch((e: unknown) => { warnings.push(`journal: ${(e as Error).message}`); });
  return { requestId: id, status: 'rejected', marked: true, detail, warnings };
}

export function formatApplyOutcome(r: ApplyOutcome): string {
  const head = r.status === 'planned' ? [formatPlan(r.plan, r.digest, r.notes), '', 'dry run: nothing offered or applied']
    : r.status === 'offered' ? [formatPlan(r.plan, r.digest, r.notes), '', `NOT applied: offered until ${r.expiresAt}. To apply exactly this plan, run:`, `  ${r.confirmCommand}`]
      : [`change request ${r.requestId}: ${r.status === 'applied' ? 'applied' : 'FAILED'} - ${displayText(r.detail)}`, ...(r.set ? [formatSet(r.set)] : [])];
  return [
    ...head,
    ...(r.status === 'applied' || r.status === 'failed' ? [r.marked ? `runtime request marked ${r.status}` : 'runtime request not marked (see warning)'] : []),
    ...r.warnings.map((x) => `warning: ${displayText(x)}`),
    ...r.nextSteps.map((x) => `next: ${x}`),
  ].join('\n');
}

// ---------------------------------------------------------------- default deps

/** How to run this CLI as a host child process: the same node, script and flags, without MINIONS_RUNTIME. */
export function hostCli(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const cli = process.argv[1] ?? `${packageRoot()}/dist/cli.js`;
  const env = { ...process.env };
  delete env.MINIONS_RUNTIME;
  return { cmd: process.execPath, args: [...process.execArgv, cli], env };
}

/** `minions upgrade` of this CLI as a child process in the project's repository (progress on stderr). */
export const childUpgrade: ChangeRequestDeps['upgrade'] = (project, o) => new Promise((resolve) => {
  const flag = o.fromContainer === true ? ['--from-container'] : o.fromContainer ? ['--from-container', o.fromContainer] : [];
  const host = hostCli();
  const child = spawn(host.cmd, [...host.args, '--json', 'upgrade', ...flag, ...(o.syncOnly ? ['--sync-only'] : []), ...(o.dryRun ? ['--dry-run'] : [])],
    { cwd: project.repoPath, env: host.env, stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
  const done = (code: number | null, err?: string) => {
    const env2 = lastEnvelope<{ ok?: boolean; steps?: UpgradeRun['steps']; stopped?: { reason?: string } | null }>(stdout);
    const steps = Array.isArray(env2?.data?.steps) ? env2!.data!.steps! : [];
    const failed = steps.filter((s) => s.status === 'failed');
    const ok = !!(env2?.ok && env2.data?.ok && !env2.data.stopped && code === 0);
    const summary = err ?? (!env2 ? `no result (exit ${code})` : !env2.ok ? displayText(env2.error?.message ?? 'failed')
      : env2.data?.stopped ? `stopped: ${displayText(env2.data.stopped.reason ?? '')}` : failed.length ? `failed: ${failed.map((s) => `${s.id} (${displayText(s.detail)})`).join(', ')}`
        : o.dryRun ? `${steps.length} steps planned` : 'complete');
    resolve({ ok, steps, summary });
  };
  child.on('error', (e) => done(null, e.message));
  child.on('close', (code) => done(code));
});

// ---------------------------------------------------------------- register (under `settings`)

const refuseInRuntime = (what: string, id: string) => {
  if (runtimeMode() !== 'host' || inMinionsContainer()) {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `${what} runs only in the host CLI: the owner confirms change requests on the host.`,
      `Tell the owner that change request ${id} is waiting; they run \`minions settings apply ${id}\` (or \`reject\`) on the host.`);
  }
};

async function currentProject(): Promise<ProjectJson> {
  const { projectId } = await projectForPath(process.cwd());
  return loadProjectJson(projectId);
}

/**
 * `settings requests [--all]` (runtime: its own DB; host: through the runtime), the hidden runtime-only
 * `settings requests mark <id> --status <s>` the host calls, and the host-only `settings apply <id>` / `settings reject <id>`.
 */
export function registerChangeRequestCommands(settings: Command, io: ApplyIO & { runtime: SettingsRuntime; upgrade?: ChangeRequestDeps['upgrade'] }): void {
  const deps = (): ChangeRequestDeps => ({ runtime: io.runtime, upgrade: io.upgrade ?? childUpgrade });
  const requests = settings.command('requests')
    .description('List change requests (settings set, settings restart and upgrade recorded in the runtime): open ones, or every status with --all')
    .option('--all', 'include applied, rejected and expired requests')
    .action(action(async (o: { all?: boolean }, cmd: Command) => {
      const { json } = globalOpts(cmd);
      if (runtimeMode() !== 'host') {
        const list = await withRequestContext(({ db }) => listChangeRequests(db, { all: !!o.all }));
        emit({ requests: list }, { json, human: () => formatRequests(list) });
        return;
      }
      await hostListRequests(io.runtime, !!o.all, json);
    }));
  requests.command('mark <requestId>', { hidden: true })
    .description('Runtime only, called by the host: record the host\'s outcome of a change request')
    .requiredOption('--status <status>', 'confirmed | applied | failed | rejected | expired')
    .option('--detail <text>', 'what happened')
    .action(action(async (id: string, o: { status: string; detail?: string }, cmd: Command) => {
      requireMode('runtime');
      const v = await withRequestContext(({ db }) => markChangeRequest(db, id, o.status, o.detail));
      emit(v, { json: globalOpts(cmd).json, human: formatRequestLine });
    }));
  settings.command('apply <requestId>')
    .description('Host only: review and apply a change request from the runtime (host-computed plan and digest; confirm in the terminal, with --yes, or later with --confirm <digest> within 30 minutes)')
    .option('-y, --yes', 'apply the plan without asking (after reviewing it, e.g. with --dry-run)')
    .option('--confirm <digest>', 'apply the plan offered earlier with this digest (refused if it expired or anything changed)')
    .option('--dry-run', 'show the plan and its digest; offer and apply nothing')
    .action(action(async (id: string, o: { yes?: boolean; confirm?: string }, cmd: Command) => {
      refuseInRuntime('`settings apply`', id);
      const { json, dryRun } = globalOpts(cmd);
      const r = await applyRequest(await currentProject(), id, { yes: o.yes, confirm: o.confirm, dryRun }, deps(),
        { confirm: json ? async () => null : io.confirm, show: json ? undefined : io.show });
      emit(r, { json, human: formatApplyOutcome });
      if (r.status === 'failed') process.exitCode = 1;
    }));
  settings.command('reject <requestId>')
    .description('Host only: reject a change request (marks it rejected in the runtime; nothing is applied)')
    .option('--reason <text>', 'why (stored with the request)')
    .action(action(async (id: string, o: { reason?: string }, cmd: Command) => {
      refuseInRuntime('`settings reject`', id);
      const r = await rejectRequest(await currentProject(), id, o, deps());
      emit(r, { json: globalOpts(cmd).json, human: (x: RejectOutcome) => [`change request ${x.requestId} rejected (nothing applied)`, ...x.warnings.map((w) => `warning: ${w}`)].join('\n') });
    }));
}

/** Host side of `settings requests [--all]`: lists the runtime's requests. */
export async function hostListRequests(runtime: SettingsRuntime, all: boolean, json: boolean): Promise<void> {
  const project = await currentProject();
  const requests = await fetchRequests(project, runtime, all);
  emit({ projectId: project.projectId, requests }, { json, human: () => formatRequests(requests) });
}
