// The host manager core (docs/design/host-manager.md, phase 3, task-53.4): a deterministic host process, no model,
// no Telegram yet. Entry point: the hidden internal-tier `minions manager run` (owner decision Q1).
//
// - One manager per host: <MINIONS_HOME>/manager/lock ({pid, start}; a lock of a dead or reused pid is taken over).
// - Every 20 s it polls each registered project whose runtime runs: `minions settings requests --json` through the
//   delegate (docker compose exec / the host runtime shim), 30 s timeout, 256 KiB output cap. The output is untrusted:
//   a timeout, an oversize answer or a malformed one is a project error (reported once) and is dropped.
// - An open request without a pending offer gets one: the phase-2 plan/digest/offer code (src/host/change-requests.ts)
//   builds the plan from the host's config and journals the offer (nonce, 30 minute expiry); the transport shows it.
// - A confirm event names a request and a nonce. confirmOffer runs the checks (nonce unspent, request not handled,
//   unexpired, configRevision and digest unchanged when recomputed from the journaled request) and journals
//   `confirmed` as one step under the journal lock (replay protection). Then `applying` is journaled and the child
//   command built from the journal's stored plan runs (`minions settings set|restart|upgrade` in a fresh process):
//   the container's row is never read again at apply time. The outcome is journaled and the row marked.
// - At startup, a request whose newest journal entry is `confirmed` / `applying` from a process that is gone is
//   reported as "interrupted, state unknown" and closed as `failed` (row marked failed). It is never resumed: the
//   owner sees it re-offered and confirms it again, or rejects it.
// - The transport (ManagerTransport) is the only channel to the owner: send an offer, receive confirm / reject
//   events, send an outcome. Once the manager bot is paired, `manager run` uses the Bot API transport
//   (src/host/manager-telegram.ts: owner check, inline buttons, double tap for a plan with `loosens`, /status,
//   /requests, /project). Unpaired it uses a log transport (JSON lines on stdout, no events: confirm in the terminal
//   with the printed `settings apply --confirm` command, which uses the same journal).
// - Owner change commands (task-53.5.3): /set, /sync, /upgrade, /restart and /undo reach the core through
//   ManagerCommands.propose. The core mints an `ow_` request id, builds the same host plan (buildPlan), journals the
//   offer and hands it back to the transport, which shows it with Confirm / Reject. Typing the command is never
//   consent: only the tap (twice for a plan that loosens) applies it, through the same confirmOffer and apply path.
//   Owner requests have no runtime row, so nothing is marked for them; a refused one is re-offered from its journaled
//   snapshot. Every config write the manager applies saves the layer file first (src/host/config-history.ts), so
//   /undo <id> can restore it while the file is still what that change wrote.
// - /approve <task> <sha> [merge] (task-53.5.4) is an owner request of kind approve: its plan always loosens (two
//   taps), and the confirmed plan runs approveOnHost in this process (src/host/approvals.ts, injectable as
//   ManagerDeps.approveOnHost): the host key signs and the runtime's `work approve --signature` goes through the
//   bounded delegate. The runtime refuses a head that is not the one awaiting approval. The token is never logged,
//   journaled or sent to the chat: the runtime's answer (and an error while approving) goes through redactApprovalText
//   before it becomes the outcome detail. Approvals cannot be undone.
// - Restart when idle / Drain now (task-53.7): a plain restart refused because worker leases are active is followed by
//   two owner offers, restart mode when-idle and drain. A confirmed one is queued here (in memory; its journal entry
//   stays `applying`, so a manager restart reports it as interrupted and never resumes it): drain first runs
//   `pause --starts --drain` in the runtime. Every poll re-checks the active leases; the first idle poll resumes a
//   pause made here (`resume --starts`, before the restart, since the recovery prompt dispatches only with starts
//   open) and runs `minions settings restart`; an owner's own pause stays and only its drain is cleared after the
//   restart (a stopped runtime cannot be resumed: the outcome says so). A restart refused again at that moment (a
//   lease started in between) is paused again with the drain and stays queued; nothing else is tried.
// - CLI check and roll back (task-53.7): after an upgrade that rebuilt or reinstalled the CLI, `minions --version` and
//   `minions status` run in fresh processes; when either fails and a backup exists (src/host/cli-backup.ts), a
//   cli-rollback offer follows (one Confirm reinstalls it). The dev-only rebuild-cli request (src/host/cli-rebuild.ts)
//   exists only when the host CLI runs from a minions source checkout and the project is minions.
import { open, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Command } from 'commander';
import { action, requireMode } from '../core/cli-helpers.js';
import { APPROVAL_TOKEN_PREFIX } from '../core/approval.js';
import { displayText, truncateCodePoints } from '../core/control-chars.js';
import { MinionsError, isMinionsError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { ensureDir } from '../core/fsutil.js';
import { procStartTime } from '../runtime/coordinator.js';
import { isChangeRequestId, type ChangeRequestView } from '../runtime/change-requests.js';
import { pidAlive } from '../runtime/db.js';
import {
  findOfferByNonce, interruptedEntries, isOfferRequestId, isOwnerRequest, lastOutcome, managerDir, newOwnerRequestId, readJournal, recordOutcome, writer, writerAlive,
  type JournalEntry, type OfferEntry, type OutcomeEntry, type RequestSnapshot,
} from './change-journal.js';
import {
  childUpgrade, confirmOffer, fetchRequests, formatPlan, fromContainerOf, hostCli, mark, offerRequest, planArgv,
  recordApplyResult, rejectRequest, RESTART_MODES, snapshotOf, undoDetail, type ChangePlan, type ChangeRequestDeps, type UpgradeRun,
} from './change-requests.js';
import { approveOnHost } from './approvals.js';
import { checkCliHealth, installCliBackup, listCliBackups, type CliHealth } from './cli-backup.js';
import { devRebuildAvailable, notAvailable, rebuildRange, type CliDevDeps } from './cli-rebuild.js';
import type { Runner } from './docker.js';
import { applyUndo, beginHistory, completeHistory } from './config-history.js';
import { readManagerToken } from './credentials.js';
import { DELEGATE_MAX_OUTPUT_BYTES, DELEGATE_TIMEOUT_MS, delegateCapture } from './delegate.js';
import { loadManagerAccess, type ManagerAccess } from './manager-bot.js';
import { telegramTransport } from './manager-telegram.js';
import { loadProjectJson, type ProjectJson } from './project.js';
import { loadRegistry } from './registry.js';
import { parseStatusEnvelope } from './restart-required.js';
import { defaultSettingsRuntime, type SettingsRuntime } from './settings-cli.js';
import { formatValue } from './settings.js';

export const POLL_INTERVAL_MS = 20_000;
export const managerLockPath = () => join(managerDir(), 'lock');

// ---------------------------------------------------------------- transport

/** One offer shown to the owner: everything the transport needs for the message and its Confirm / Reject buttons. */
export interface ManagerOffer {
  projectId: string;
  requestId: string;
  kind: string;
  /** Single-use, 128-bit hex; a confirm or reject event must name it (Telegram callback_data `c:<requestId>:<nonce>`). */
  nonce: string;
  digest: string;
  expiresAt: string;
  /** One line, computed by the host from the plan (never the container's summary). */
  summary: string;
  /** The full plan as text (formatPlan: the untrusted reason is quoted, control characters are stripped). */
  text: string;
  /** Non-null: the plan loosens policy, and the transport asks twice before it sends the confirm event. */
  loosens: string | null;
}

/** What the owner did with an offer. The transport authenticates the sender (phase 4: the paired owner only). */
export interface ManagerEvent { type: 'confirm' | 'reject'; requestId: string; nonce: string }

export type ManagerOutcomeStatus = 'applying' | 'queued' | 'applied' | 'failed' | 'refused' | 'rejected' | 'already-handled' | 'interrupted' | 'error';
/** A report to the owner (one new message each, so the phone notifies). */
export interface ManagerOutcome { status: ManagerOutcomeStatus; projectId: string | null; requestId: string | null; text: string }

/** The manager's only channel to the owner. Phase 4 implements it with the manager bot. */
export interface ManagerTransport {
  sendOffer(offer: ManagerOffer): Promise<void>;
  /** Waits up to waitMs (or until signal aborts) for owner events; returns them (possibly none). */
  receive(waitMs: number, signal?: AbortSignal): Promise<ManagerEvent[]>;
  sendOutcome(outcome: ManagerOutcome): Promise<void>;
  /** Gives the transport the read-only owner commands (/status, /requests, /project); called once before the loop. */
  attach?(commands: ManagerCommands): void;
}

/** Read-only views for the owner commands of a transport. They never confirm or apply anything. */
export interface ManagerCommands {
  /** The registered projects (name: the repository directory name). */
  projects(): Promise<{ projectId: string; name: string }[]>;
  /** Plain text: per project (or only projectId), runtime, coordinator, active leases, pending change requests. */
  status(projectId: string | null): Promise<string>;
  /** The offers still waiting for the owner (newest journal entry is the offer), oldest first. */
  pending(projectId: string | null): Promise<ManagerOffer[]>;
  /**
   * An owner change command (/set, /sync, /upgrade, /restart, /undo): builds the host plan and journals an offer for
   * an owner request (`ow_` id). Nothing is applied: the returned offer still needs the owner's Confirm. Throws
   * (nothing journaled) when the plan cannot be built, for example an invalid value or a refused sync.
   */
  propose(projectId: string | null, command: OwnerCommand): Promise<ManagerOffer>;
  /**
   * Whether the dev-only /rebuild_cli exists for projectId (or, with null, for any registered project): the host CLI
   * runs from a minions source checkout and the project is minions. Elsewhere it is neither advertised nor accepted.
   */
  devRebuild?(projectId: string | null): Promise<boolean>;
}

/** An owner change command as the transport parsed it (the core validates everything again). */
export type OwnerCommand =
  | { kind: 'config-set'; key: string; value: string; layer: 'local' | 'shared' }
  | { kind: 'restart' }
  | { kind: 'upgrade' }
  | { kind: 'sync' }
  | { kind: 'undo'; target: string }
  /** A host-signed approval for exactly this task and full head SHA; merge: true approves merging instead of publishing. */
  | { kind: 'approve'; taskId: string; head: string; merge: boolean }
  /** Dev-only: `minions upgrade --rebuild-cli` with the commit range in the plan (see ManagerCommands.devRebuild). */
  | { kind: 'rebuild-cli' };

// ---------------------------------------------------------------- deps

export interface ManagerDeps {
  transport: ManagerTransport;
  /** The registered projects. */
  projects: () => Promise<ProjectJson[]>;
  loadProject: (projectId: string) => Promise<ProjectJson>;
  /** Whether the project's runtime runs. */
  running: (project: ProjectJson) => Promise<boolean>;
  /** `minions …` (argv includes `minions`) in the runtime, output captured, with the 30 s / 256 KiB limits. */
  delegate: (project: ProjectJson, argv: string[]) => Promise<RunResult>;
  /** The host CLI as a child process: `minions --json <argv>` in the project's repository. */
  runChild: (project: ProjectJson, argv: string[]) => Promise<RunResult>;
  /** `minions upgrade` as a child process (dry run for the plan, then the apply). */
  upgrade: ChangeRequestDeps['upgrade'];
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (line: string) => void;
  /** Whether the process that wrote a confirmed / applying entry still runs. */
  writerAlive?: (e: OutcomeEntry) => boolean;
  /** Signs and records an approval (default: approveOnHost of src/host/approvals.ts); tests stub it. */
  approveOnHost?: typeof approveOnHost;
  /** The running CLI's root and a git runner for the dev-only rebuild-cli request (defaults: packageRoot(), run). */
  cli?: CliDevDeps;
  /** Checks the host CLI after a rebuild/reinstall or a roll back (default: --version and status in fresh processes). */
  cliHealth?: (project: ProjectJson) => Promise<CliHealth>;
  /** npm for the CLI roll back (default: run). */
  npm?: Runner;
}

/** A restart confirmed with mode when-idle or drain, waiting in the manager for the first poll without active leases. */
interface QueuedRestart { projectId: string; offer: OfferEntry; plan: ChangePlan; since: string; resumeStarts: boolean; clearDrain: boolean }

/**
 * The runtime as the manager sees it: every answer is bounded. A timeout or an answer over the cap throws (a project
 * error), whatever the delegate returned.
 */
export function boundedRuntime(deps: Pick<ManagerDeps, 'running' | 'delegate'>): SettingsRuntime {
  return {
    running: deps.running,
    exec: async (project, argv) => {
      const r = await deps.delegate(project, argv);
      const what = `\`${argv.slice(0, 3).join(' ')}\` in project ${project.projectId}`;
      if (r.timedOut) throw new MinionsError('INTERNAL', `${what} timed out after ${DELEGATE_TIMEOUT_MS / 1000} s; its output was dropped.`);
      if (r.outputLimited || Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) > DELEGATE_MAX_OUTPUT_BYTES) {
        throw new MinionsError('INTERNAL', `${what} wrote more than ${DELEGATE_MAX_OUTPUT_BYTES / 1024} KiB; its output was dropped.`);
      }
      return r;
    },
  };
}

// ---------------------------------------------------------------- lock

interface LockRecord { pid: number; start: string | null; at: string }

/**
 * Takes <MINIONS_HOME>/manager/lock (O_EXCL, {pid, start}). A holder that still runs (same pid and start time) means
 * another manager: CONFLICT. A lock of a dead or reused pid is taken over.
 */
export async function acquireManagerLock(o: { alive?: (e: { pid?: number; start?: string | null }) => boolean; now?: Date } = {}): Promise<{ release: () => Promise<void> }> {
  await ensureDir(managerDir(), 0o700);
  const alive = o.alive ?? ((e) => writerAlive(e, pidAlive, procStartTime));
  const mine: LockRecord = { ...writer(), at: (o.now ?? new Date()).toISOString() };
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const h = await open(managerLockPath(), 'wx', 0o600);
      await h.writeFile(JSON.stringify(mine) + '\n');
      await h.close();
      return {
        release: async () => {
          const cur = await readLock();
          if (cur?.pid === mine.pid && cur.start === mine.start) await rm(managerLockPath(), { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = await readLock();
      if (holder && alive(holder)) {
        throw new MinionsError('CONFLICT', `Another host manager runs (pid ${holder.pid}, since ${holder.at}).`,
          'Only one manager may run per host. Stop the other one first (or let its supervisor keep it).', { pid: holder.pid });
      }
      await rm(managerLockPath(), { force: true });
    }
  }
  throw new MinionsError('CONFLICT', 'Could not take the host manager lock (it keeps changing).', 'Retry in a moment.');
}

async function readLock(): Promise<LockRecord | null> {
  try {
    const v = JSON.parse(await readFile(managerLockPath(), 'utf8')) as Partial<LockRecord>;
    return typeof v.pid === 'number' ? { pid: v.pid, start: typeof v.start === 'string' ? v.start : null, at: String(v.at ?? '') } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- the manager

const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const refusalOf = (e: unknown): string | undefined => (isMinionsError(e) ? (e.details as { refusal?: string } | undefined)?.refusal : undefined);

/** A request row as parsed from the runtime's answer: only well-formed rows are used (the rest is untrusted noise). */
function wellFormed(r: unknown): r is ChangeRequestView {
  if (!r || typeof r !== 'object') return false;
  const v = r as Record<string, unknown>;
  return typeof v.id === 'string' && isChangeRequestId(v.id) && typeof v.kind === 'string' && typeof v.status === 'string'
    && !!v.payload && typeof v.payload === 'object' && !Array.isArray(v.payload) && (v.reason === null || v.reason === undefined || typeof v.reason === 'string');
}

/** One line for a plan, from the host's own view. */
export function planSummary(plan: ChangePlan): string {
  if (plan.kind === 'config-set' && plan.change) return `set ${plan.change.key}: ${formatValue(plan.change.from)} -> ${formatValue(plan.change.to)}`;
  if (plan.kind === 'restart' && plan.restart) return plan.restart.mode === 'drain' ? 'Drain now: pause starts, let the workers hand back, then restart the coordinator' : 'Restart when idle: restart the coordinator at the first poll without active workers';
  if (plan.kind === 'restart') return 'restart the coordinator';
  if (plan.kind === 'rebuild-cli' && plan.rebuild) return `rebuild the host CLI from ${plan.rebuild.count} commit${plan.rebuild.count === 1 ? '' : 's'} (${plan.rebuild.from.slice(0, 12)}..${plan.rebuild.to.slice(0, 12)}), then upgrade`;
  if (plan.kind === 'cli-rollback' && plan.rollback) return `Roll back CLI: reinstall minions ${plan.rollback.version} from the backup`;
  if (plan.kind === 'undo' && plan.change) {
    const more = (plan.undo?.changes.length ?? 1) - 1;
    return `undo ${plan.undo?.target ?? '?'}: ${plan.change.key}: ${formatValue(plan.change.from)} -> ${formatValue(plan.change.to)}${more > 0 ? ` (+${more} more setting${more === 1 ? '' : 's'})` : ''}`;
  }
  if (plan.kind === 'sync') return 'sync the host base branch (strict fast-forward)';
  if (plan.kind === 'approve' && plan.approval) {
    return `approve ${plan.approval.scope === 'merge' ? 'merging' : 'publishing'} ${plan.approval.taskId} at ${plan.approval.head}`;
  }
  return plan.steps[0] ?? plan.kind;
}

/** The transport's view of a journaled offer. */
const offerOf = (b: Awaited<ReturnType<typeof offerRequest>>): ManagerOffer => ({
  projectId: b.offer.projectId, requestId: b.offer.requestId, kind: b.plan.kind, nonce: b.offer.nonce, digest: b.digest, expiresAt: b.offer.expiresAt,
  summary: planSummary(b.plan), text: formatPlan(b.plan, b.digest, b.notes), loosens: b.plan.loosens,
});

/** Reads the host CLI child's `--json` answer into an outcome. */
export function childOutcome(plan: ChangePlan, r: RunResult): { status: 'applied' | 'failed'; detail: string; refused?: boolean } {
  let env: { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } } | null = null;
  try { env = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { env = null; }
  const cmd = plan.kind === 'config-set' ? 'minions settings set' : 'minions settings restart';
  if (r.timedOut) return { status: 'failed', detail: `${cmd} timed out` };
  if (!env || typeof env !== 'object') return { status: 'failed', detail: `${cmd}: no result (exit ${r.code})${r.stderr.trim() ? `: ${displayText(r.stderr.trim().slice(-300))}` : ''}` };
  if (!env.ok) return { status: 'failed', detail: `${cmd} failed: ${displayText(env.error?.message ?? 'unknown error')}` };
  const d = env.data ?? {};
  if (plan.kind === 'config-set') {
    return d.written === true && r.code === 0
      ? { status: 'applied', detail: `${String(d.key)}: ${formatValue(d.from)} -> ${formatValue(d.to)} written to ${String(d.file)}` }
      : { status: 'failed', detail: `${plan.change?.key ?? 'setting'} was not written (exit ${r.code})` };
  }
  const detail = `coordinator restart: ${displayText(String(d.action ?? 'unknown'))} - ${displayText(String(d.detail ?? ''))}`;
  if (d.action === 'restarted' && r.code === 0) return { status: 'applied', detail };
  // `settings restart` refuses while worker leases are active (restartCoordinator: action refused).
  return { status: 'failed', detail, ...(d.action === 'refused' ? { refused: true } : {}) };
}

export class HostManager {
  readonly runtime: SettingsRuntime;
  /** Problems already reported (key -> message), so a 20 s poll does not repeat them. */
  private readonly reported = new Map<string, string>();
  /** Offers whose sendOffer failed: offered again on the next poll. */
  private readonly unsent = new Set<string>();
  /** Restarts waiting for an idle poll, by project (at most one per project). */
  private readonly queued = new Map<string, QueuedRestart>();

  constructor(private readonly deps: ManagerDeps) {
    this.runtime = boundedRuntime(deps);
  }

  private get cr(): ChangeRequestDeps {
    return { runtime: this.runtime, upgrade: this.deps.upgrade, now: this.deps.now, ...(this.deps.cli ? { cli: this.deps.cli } : {}) };
  }

  /** The restarts queued in this process (projectId, request id, mode, since). */
  queuedRestarts(): { projectId: string; requestId: string; mode: string; since: string }[] {
    return [...this.queued.values()].map((q) => ({ projectId: q.projectId, requestId: q.offer.requestId, mode: q.plan.restart?.mode ?? 'when-idle', since: q.since }));
  }

  private async notify(o: ManagerOutcome): Promise<void> {
    this.deps.log(`${o.status}${o.projectId ? ` ${o.projectId}` : ''}${o.requestId ? ` ${o.requestId}` : ''}: ${o.text.split('\n')[0]}`);
    try { await this.deps.transport.sendOutcome(o); } catch (e) { this.deps.log(`transport: sending an outcome failed: ${(e as Error).message}`); }
  }

  /** Reports a problem once per key until it changes or clears. */
  private async reportOnce(key: string, o: ManagerOutcome): Promise<void> {
    if (this.reported.get(key) === o.text) return;
    this.reported.set(key, o.text);
    await this.notify(o);
  }

  /**
   * Startup: every request left `confirmed` / `applying` by a process that is gone is reported as interrupted, state
   * unknown, and closed as failed (journal and runtime row). Nothing is resumed or re-run.
   */
  async startup(): Promise<OutcomeEntry[]> {
    const found = interruptedEntries(await readJournal(), this.deps.writerAlive ?? ((e) => writerAlive(e)));
    for (const e of found) {
      const detail = `interrupted, state unknown: the apply was ${e.type} at ${e.at} by process ${e.pid ?? 'unknown'}, which stopped before it recorded an outcome. `
        + 'It is not resumed: check the project, then confirm the request again or reject it.'
        + (e.detail?.startsWith('queued') ? ` It was ${e.detail}.` : '');
      await recordOutcome({ type: 'failed', projectId: e.projectId, requestId: e.requestId, digest: e.digest, detail }, this.deps.now());
      let warning = '';
      try {
        const w = await mark(await this.deps.loadProject(e.projectId), this.runtime, e.requestId, 'failed', detail);
        if (w) warning = `\nwarning: ${w}`;
      } catch (err) { warning = `\nwarning: project ${e.projectId}: ${(err as Error).message}`; }
      await this.notify({ status: 'interrupted', projectId: e.projectId, requestId: e.requestId, text: `change request ${e.requestId} (project ${e.projectId}): ${detail}${warning}` });
    }
    return found;
  }

  /** One poll of every registered project (a project error never stops the others). */
  async pollAll(): Promise<void> {
    let projects: ProjectJson[];
    try { projects = await this.deps.projects(); } catch (e) {
      await this.reportOnce('registry', { status: 'error', projectId: null, requestId: null, text: `cannot read the project registry: ${(e as Error).message}` });
      return;
    }
    await this.runQueued();
    for (const p of projects) {
      try {
        await this.pollProject(p);
        this.reported.delete(`project:${p.projectId}`);
      } catch (e) {
        await this.reportOnce(`project:${p.projectId}`, { status: 'error', projectId: p.projectId, requestId: null, text: `project ${p.projectId}: ${(e as Error).message}` });
      }
    }
  }

  /** Reads the project's open requests and offers each one that has no pending offer. Returns the offers sent. */
  async pollProject(project: ProjectJson): Promise<ManagerOffer[]> {
    if (!(await this.deps.running(project))) return [];
    const rows = await fetchRequests(project, this.runtime, false);
    const entries = await readJournal();
    const sent: ManagerOffer[] = [];
    let malformed = 0;
    for (const row of rows as unknown[]) {
      if (!wellFormed(row)) { malformed++; continue; }
      if (row.status !== 'proposed' && row.status !== 'failed') continue;
      if (!this.needsOffer(entries, project.projectId, row.id)) continue;
      const o = await this.offer(project, snapshotOf(row));
      if (o) sent.push(o);
    }
    if (malformed) {
      await this.reportOnce(`malformed:${project.projectId}`, { status: 'error', projectId: project.projectId, requestId: null, text: `project ${project.projectId}: ignored ${malformed} malformed change request row(s) in the runtime's answer.` });
    }
    return sent;
  }

  /** No journal entry, or the last one is `failed` (offer again: retry), or an offer whose message was never sent. */
  private needsOffer(entries: JournalEntry[], projectId: string, requestId: string): boolean {
    const last = entries.filter((e) => e.projectId === projectId && e.requestId === requestId).at(-1);
    if (!last) return true;
    if (last.type === 'offer') return this.unsent.has(last.nonce);
    return last.type === 'failed';
  }

  /** Builds the plan, journals the offer and sends it. A plan that cannot be built is reported once. */
  private async offer(project: ProjectJson, row: RequestSnapshot): Promise<ManagerOffer | null> {
    let built: Awaited<ReturnType<typeof offerRequest>>;
    try { built = await offerRequest(project, row, this.cr); } catch (e) {
      await this.reportOnce(`plan:${project.projectId}:${row.id}`, { status: 'error', projectId: project.projectId, requestId: row.id, text: `change request ${row.id} (project ${project.projectId}) cannot be offered: ${(e as Error).message}` });
      return null;
    }
    const o = offerOf(built);
    try {
      await this.deps.transport.sendOffer(o);
      this.deps.log(`offered ${project.projectId} ${row.id}: ${o.summary}`);
    } catch (e) {
      this.unsent.add(o.nonce);
      this.deps.log(`transport: sending the offer of ${row.id} failed (offered again on the next poll): ${(e as Error).message}`);
    }
    return o;
  }

  /** Handles one owner event; never throws (every problem becomes an outcome message). */
  async handle(ev: ManagerEvent): Promise<void> {
    try {
      await (ev.type === 'confirm' ? this.confirm(ev) : this.reject(ev));
    } catch (e) {
      await this.notify({ status: 'error', projectId: null, requestId: typeof ev.requestId === 'string' && isOfferRequestId(ev.requestId) ? ev.requestId : null, text: `handling a ${String(ev.type)}: ${(e as Error).message}` });
    }
  }

  private async findOffer(ev: ManagerEvent): Promise<{ offer: OfferEntry; spent: boolean; project: ProjectJson } | null> {
    if (typeof ev.requestId !== 'string' || !isOfferRequestId(ev.requestId) || typeof ev.nonce !== 'string' || !NONCE_PATTERN.test(ev.nonce)) {
      await this.notify({ status: 'refused', projectId: null, requestId: null, text: 'refused: malformed confirmation (unknown request or nonce); nothing applied.' });
      return null;
    }
    const found = await findOfferByNonce(ev.nonce);
    if (!found || found.offer.requestId !== ev.requestId) {
      await this.notify({ status: 'refused', projectId: null, requestId: ev.requestId, text: `refused: no offer for change request ${ev.requestId} with this nonce; nothing applied.` });
      return null;
    }
    return { ...found, project: await this.deps.loadProject(found.offer.projectId) };
  }

  private async confirm(ev: ManagerEvent): Promise<void> {
    const found = await this.findOffer(ev);
    if (!found) return;
    const { offer, project } = found;
    const ids = { projectId: offer.projectId, requestId: offer.requestId };
    if (found.spent) {
      await this.notify({ status: 'already-handled', ...ids, text: `change request ${offer.requestId}: already handled (this confirmation was used).` });
      return;
    }
    try {
      // Nonce check, expiry, revision and digest, and the `confirmed` entry: one step under the journal lock.
      await confirmOffer(project, offer, this.cr, 'A fresh offer follows.');
    } catch (e) {
      const why = refusalOf(e);
      if (why === 'spent' || why === 'handled') {
        await this.notify({ status: 'already-handled', ...ids, text: `change request ${offer.requestId}: already handled. ${(e as Error).message}` });
        return;
      }
      await this.notify({ status: 'refused', ...ids, text: `refused: ${(e as Error).message}` });
      if (why === 'expired' || why === 'revision' || why === 'digest') await this.reoffer(project, offer);
      return;
    }
    await this.apply(project, offer);
  }

  /** After a refusal: a fresh offer when the request is still open in the runtime. */
  private async reoffer(project: ProjectJson, offer: OfferEntry): Promise<void> {
    const requestId = offer.requestId;
    try {
      // An owner request has no runtime row: it is offered again from its journaled snapshot (rebuilt from scratch).
      if (isOwnerRequest(offer.request)) {
        const fresh = await offerRequest(project, offer.request, this.cr);
        await this.deps.transport.sendOffer(offerOf(fresh));
        return;
      }
      const row = (await fetchRequests(project, this.runtime, false) as unknown[]).filter(wellFormed).find((r) => r.id === requestId);
      if (row && (row.status === 'proposed' || row.status === 'failed')) { await this.offer(project, snapshotOf(row)); return; }
      await this.notify({ status: 'refused', projectId: project.projectId, requestId, text: `change request ${requestId} is no longer open in the runtime; no fresh offer.` });
    } catch (e) {
      await this.notify({ status: 'error', projectId: project.projectId, requestId, text: `no fresh offer for ${requestId}: ${(e as Error).message}` });
    }
  }

  /** Runs the plan stored in the journal (never the container's row) as a host child command, then records the outcome. */
  private async apply(project: ProjectJson, offer: OfferEntry): Promise<void> {
    const plan = offer.plan as ChangePlan;
    const ids = { projectId: offer.projectId, requestId: offer.requestId };
    const warnings: string[] = [];
    const w = await mark(project, this.runtime, offer.requestId, 'confirmed', `confirmed in the host manager (digest ${offer.digest.slice(0, 12)})`);
    if (w) warnings.push(w);
    if (plan.kind === 'restart' && plan.restart) { await this.enqueue(project, offer, plan, warnings); return; }
    const inManager = plan.kind === 'undo' || plan.kind === 'approve' || plan.kind === 'cli-rollback';
    const argv = inManager ? null : planArgv(plan, offer.request);
    await this.notify({ status: 'applying', ...ids, text: `Applying change request ${offer.requestId} (project ${offer.projectId}): ${planSummary(plan)}…` });
    let result: { status: 'applied' | 'failed'; detail: string; refused?: boolean };
    /** Lines after the outcome, and owner offers sent after it (each still needs its own Confirm). */
    const after: string[] = [];
    const nextOffers: RequestSnapshot[] = [];
    try {
      await recordOutcome({ type: 'applying', ...ids, nonce: offer.nonce, digest: offer.digest, detail: argv ? `minions ${argv.join(' ')}` : plan.steps[0] ?? plan.kind, ...writer() }, this.deps.now());
      if (plan.kind === 'upgrade' || plan.kind === 'sync' || plan.kind === 'rebuild-cli') {
        if (plan.kind === 'rebuild-cli') await this.assertRangeUnchanged(project, plan);
        const r = await this.deps.upgrade(project, plan.kind === 'sync' ? { fromContainer: null, dryRun: false, syncOnly: true }
          : plan.kind === 'rebuild-cli' ? { fromContainer: null, dryRun: false, rebuildCli: true } : { fromContainer: fromContainerOf(offer.request.payload), dryRun: false });
        result = { status: r.ok ? 'applied' : 'failed', detail: `${plan.kind}: ${r.summary}` };
        if (plan.kind !== 'sync' && cliReplaced(r)) {
          const f = await this.cliFollowUp(project);
          after.push(...f.lines);
          if (f.offer) nextOffers.push(f.offer);
        }
      } else if (plan.kind === 'cli-rollback') {
        const done = await installCliBackup(plan.rollback!.name, plan.rollback!.sha256, { runner: this.deps.npm, log: this.deps.log });
        const h = await this.cliHealth(project);
        result = h.ok ? { status: 'applied', detail: `${done}; CLI check: ${h.detail}` }
          : { status: 'failed', detail: `${done}, but the CLI check still fails: ${h.detail}. Nothing else is tried: fix the CLI in the terminal.` };
      } else if (plan.kind === 'approve') {
        result = await this.approve(project, plan);
      } else if (plan.kind === 'undo') {
        const u = await applyUndo(project, { target: plan.undo!.target, expectSha256: plan.undo!.expectSha256, restoreSha256: plan.undo!.restoreSha256, undoId: offer.requestId, now: this.deps.now() });
        warnings.push(...u.warnings);
        result = { status: 'applied', detail: undoDetail(plan) };
      } else if (plan.kind === 'config-set' && plan.change) {
        // The layer file as it is now goes to the config history first, so /undo can restore it.
        const h = await beginHistory(project, offer.requestId, plan.change, this.deps.now());
        result = childOutcome(plan, await this.deps.runChild(project, argv!));
        if (result.status === 'applied') await completeHistory(h);
      } else {
        result = childOutcome(plan, await this.deps.runChild(project, argv!));
        if (plan.kind === 'restart' && result.refused) {
          // Refused because workers are active: the owner may pick one of two follow-ups (never run on our own).
          after.push('Two plans follow: "Restart when idle" (queued here, it runs at the first poll that finds no active worker leases) and "Drain now" (pause --starts --drain, so the workers commit wip: and hand back, then the same restart once idle). Confirm one of them, or neither.');
          for (const mode of RESTART_MODES) nextOffers.push({ id: newOwnerRequestId(), kind: 'restart', payload: { mode }, reason: null, origin: 'owner' });
        }
      }
    } catch (e) {
      result = { status: 'failed', detail: (e as Error).message };
    }
    const rec = await recordApplyResult(project, { ...ids, digest: offer.digest, status: result.status, detail: result.detail }, this.cr);
    warnings.push(...rec.warnings);
    await this.notify({
      status: result.status, ...ids,
      text: [`change request ${offer.requestId} (project ${offer.projectId}): ${result.status === 'applied' ? 'applied' : 'FAILED'} - ${displayText(result.detail)}`,
        ...(plan.interrupts && result.status === 'applied' ? [`note: ${plan.interrupts}`] : []),
        ...(result.status === 'applied' ? followUp(plan) : []),
        ...after.map((x) => displayText(x)),
        ...warnings.map((x) => `warning: ${displayText(x)}`)].join('\n'),
    });
    for (const req of nextOffers) await this.offerOwner(project, req);
  }

  /** Journals and sends an offer the manager makes on the owner's behalf (a follow-up); a failure is reported. */
  private async offerOwner(project: ProjectJson, req: RequestSnapshot): Promise<void> {
    try {
      const built = await offerRequest(project, req, this.cr);
      await this.deps.transport.sendOffer(offerOf(built));
      this.deps.log(`offered ${project.projectId} ${req.id}: ${planSummary(built.plan)}`);
    } catch (e) {
      await this.notify({ status: 'error', projectId: project.projectId, requestId: null, text: `the follow-up plan (${req.kind}) cannot be offered: ${(e as Error).message}` });
    }
  }

  private async cliHealth(project: ProjectJson): Promise<CliHealth> {
    try { return await (this.deps.cliHealth ?? defaultCliHealth)(project); } catch (e) { return { ok: false, detail: `the check itself failed: ${(e as Error).message}` }; }
  }

  /** After an upgrade that replaced the CLI: check it; when the check fails and a backup exists, a roll back plan follows. */
  private async cliFollowUp(project: ProjectJson): Promise<{ lines: string[]; offer: RequestSnapshot | null }> {
    const h = await this.cliHealth(project);
    if (h.ok) return { lines: [`CLI check: ${h.detail}`], offer: null };
    const b = (await listCliBackups()).at(-1);
    if (!b) return { lines: [`CLI CHECK FAILED: ${h.detail}`, 'There is no CLI backup to roll back to (a linked checkout is rebuilt in place): fix the CLI in the terminal.'], offer: null };
    return {
      lines: [`CLI CHECK FAILED: ${h.detail}`, `A "Roll back CLI" plan follows: it reinstalls minions ${b.version} from the backup kept at ${b.stamp}. Confirm it to roll back; nothing happens otherwise.`],
      offer: { id: newOwnerRequestId(), kind: 'cli-rollback', payload: { backup: b.name }, reason: null, origin: 'owner' },
    };
  }

  /** Right before a rebuild: the checkout must still be at the HEAD the plan showed (the window since the confirmation). */
  private async assertRangeUnchanged(project: ProjectJson, plan: ChangePlan): Promise<void> {
    const now = await rebuildRange(project, this.deps.cli);
    if (now.to !== plan.rebuild?.to || now.from !== plan.rebuild.from) {
      throw new MinionsError('CONFLICT', `the checkout or the running CLI moved since the plan (${plan.rebuild?.from.slice(0, 12)}..${plan.rebuild?.to.slice(0, 12)} -> ${now.from.slice(0, 12)}..${now.to.slice(0, 12)}); nothing was built. Send /rebuild_cli again for a fresh plan.`);
    }
  }

  // ------------------------------------------------------------ restart when idle / drain now

  /** A confirmed when-idle / drain restart: drain first if asked, then queue it for the first idle poll. */
  private async enqueue(project: ProjectJson, offer: OfferEntry, plan: ChangePlan, warnings: string[]): Promise<void> {
    const ids = { projectId: offer.projectId, requestId: offer.requestId };
    const mode = plan.restart!.mode;
    const what = mode === 'drain' ? 'drain now, then restart when idle' : 'restart when idle';
    const finish = async (detail: string) => {
      const rec = await recordApplyResult(project, { ...ids, digest: offer.digest, status: 'failed', detail }, this.cr);
      await this.notify({ status: 'failed', ...ids, text: [`change request ${offer.requestId} (project ${offer.projectId}): FAILED - ${displayText(detail)}`, ...[...warnings, ...rec.warnings].map((x) => `warning: ${displayText(x)}`)].join('\n') });
    };
    const existing = this.queued.get(project.projectId);
    if (existing) { await finish(`a restart is already queued for this project (${existing.offer.requestId}, since ${existing.since}); this one was not queued`); return; }
    await recordOutcome({
      type: 'applying', ...ids, nonce: offer.nonce, digest: offer.digest, ...writer(),
      detail: `queued: ${what}${mode === 'drain' ? ' (the host manager may have paused starts with a drain: check `minions status` in the project; `minions resume --starts` brings them back)' : ''}`,
    }, this.deps.now());
    let resumeStarts = false;
    let clearDrain = false;
    if (mode === 'drain') {
      try {
        const st = parseStatusEnvelope((await this.runtime.exec(project, ['minions', 'status', '--json'])).stdout);
        const paused = st?.paused && typeof st.paused === 'object' ? (st.paused as { starts?: unknown }).starts : undefined;
        if (typeof paused !== 'boolean') throw new MinionsError('INTERNAL', 'the runtime gave no pause state');
        const r = await this.runtime.exec(project, ['minions', 'pause', '--starts', '--drain', '--reason', 'restart', '--json']);
        const why = envelopeError(r);
        if (why !== null) throw new MinionsError('INTERNAL', `minions pause --starts --drain: ${why}`);
        // Resume only a pause made here; a pause the owner made stays, and only the drain is cleared then.
        resumeStarts = !paused;
        clearDrain = paused;
      } catch (e) {
        await finish(`drain now failed, nothing queued: ${(e as Error).message}`);
        return;
      }
    }
    const since = this.deps.now().toISOString();
    this.queued.set(project.projectId, { projectId: project.projectId, offer, plan, since, resumeStarts, clearDrain });
    await this.notify({
      status: 'queued', ...ids,
      text: [`change request ${offer.requestId} (project ${offer.projectId}): queued - ${what}.`,
        mode === 'drain' ? 'Starts are paused and the active workers were asked to wind down (they commit wip: and hand back).' : 'Running workers are not interrupted.',
        'The coordinator restarts at the first poll (every 20 s) that finds no active worker leases; the outcome follows then.',
        ...warnings.map((x) => `warning: ${displayText(x)}`)].join('\n'),
    });
  }

  /** Each poll: every queued restart whose project has no active lease now runs (a problem is reported once; it stays queued). */
  private async runQueued(): Promise<void> {
    for (const q of [...this.queued.values()]) {
      try {
        await this.tryQueued(q);
        this.reported.delete(`queue:${q.projectId}`);
      } catch (e) {
        await this.reportOnce(`queue:${q.projectId}`, { status: 'error', projectId: q.projectId, requestId: q.offer.requestId, text: `queued restart ${q.offer.requestId} (project ${q.projectId}): ${(e as Error).message}; it stays queued` });
      }
    }
  }

  /** A runtime command's failure as text (null when it succeeded). */
  private async execWhy(project: ProjectJson, argv: string[]): Promise<string | null> {
    try { return envelopeError(await this.runtime.exec(project, argv)); } catch (e) { return (e as Error).message; }
  }

  private async tryQueued(q: QueuedRestart): Promise<void> {
    const project = await this.deps.loadProject(q.projectId);
    const ids = { projectId: q.projectId, requestId: q.offer.requestId };
    const warnings: string[] = [];
    const running = await this.deps.running(project);
    if (running) {
      const st = parseStatusEnvelope((await this.runtime.exec(project, ['minions', 'status', '--json'])).stdout);
      if (!st || !Array.isArray(st.activeLeases)) throw new MinionsError('INTERNAL', 'the runtime gave no active lease count');
      if (st.activeLeases.length > 0) return;
    }
    // A pause made here (starts were running before Drain now) is resumed BEFORE the restart: the recovery prompt
    // of the new coordinator dispatches only when starts are not paused (the same order as `minions upgrade`).
    const resumedFirst = running && q.resumeStarts;
    if (resumedFirst) {
      const why = await this.execWhy(project, ['minions', 'resume', '--starts', '--json']);
      if (why !== null) throw new MinionsError('INTERNAL', `minions resume --starts failed before the restart: ${why}`);
      q.resumeStarts = false;
    }
    const result = childOutcome(q.plan, await this.deps.runChild(project, planArgv(q.plan, q.offer.request)));
    if (resumedFirst && result.refused) {
      // A lease started between the status read and the restart: pause again with the drain, same plan next idle poll.
      const why = await this.execWhy(project, ['minions', 'pause', '--starts', '--drain', '--reason', 'restart', '--json']);
      if (why !== null) {
        throw new MinionsError('INTERNAL', `the restart was refused again (a worker lease started) and minions pause --starts --drain failed: ${why}; starts stay open, so it waits as a plain restart when idle`);
      }
      q.resumeStarts = true;
    }
    // The owner's own pause stays; only the drain made here is cleared, right after the restart ran (whatever it
    // answered). With the runtime stopped nothing can be undone: say so.
    if (q.resumeStarts || q.clearDrain) {
      const argv = q.resumeStarts ? ['minions', 'resume', '--starts', '--json'] : ['minions', 'resume', '--drain', '--json'];
      const cmd = argv.slice(0, 3).join(' ');
      if (!running) {
        warnings.push(`the runtime is not running, so the pause made by Drain now was left in place: run \`${cmd}\` in the project once it is back`);
        q.resumeStarts = false;
        q.clearDrain = false;
      } else if (q.clearDrain) {
        const why = await this.execWhy(project, argv);
        if (why !== null) warnings.push(`${cmd} failed: ${why}`);
        q.clearDrain = false;
      }
    }
    if (result.refused) {
      // A lease started between the status read and the restart: same plan, next idle poll.
      this.deps.log(`queued restart ${q.offer.requestId} (project ${q.projectId}): refused again (a worker lease started); still queued${warnings.length ? `; ${warnings.join('; ')}` : ''}`);
      return;
    }
    this.queued.delete(q.projectId);
    const rec = await recordApplyResult(project, { ...ids, digest: q.offer.digest, status: result.status, detail: result.detail }, this.cr);
    await this.notify({
      status: result.status, ...ids,
      text: [`change request ${q.offer.requestId} (project ${q.projectId}): ${result.status === 'applied' ? 'applied' : 'FAILED'} - ${displayText(result.detail)}`,
        ...[...warnings, ...rec.warnings].map((x) => `warning: ${displayText(x)}`)].join('\n'),
    });
  }

  /**
   * Applies an approve plan: approveOnHost signs with the host key (which never leaves the host) and delegates
   * `work approve <task> --head <sha> [--merge] --signature <token>` through the bounded runtime. Only the runtime's
   * envelope message is reported; the argv (it carries the token) is never logged or shown.
   */
  private async approve(project: ProjectJson, plan: ChangePlan): Promise<{ status: 'applied' | 'failed'; detail: string }> {
    const a = plan.approval;
    if (!a) throw new MinionsError('INTERNAL', `approve plan ${plan.requestId} without an approval.`);
    let answer: RunResult | null = null;
    let signature: string | undefined;
    let code: number;
    try {
      code = await (this.deps.approveOnHost ?? approveOnHost)(a.taskId, {
        head: a.head, merge: a.scope === 'merge', json: true, cwd: project.repoPath, note: `approved in the host manager chat (${plan.requestId})`,
      }, {
        projectId: project.projectId,
        delegate: async (args) => {
          const i = args.indexOf('--signature');
          if (i >= 0) signature = args[i + 1];
          answer = await this.runtime.exec(project, ['minions', ...args, '--json']);
          return answer.code;
        },
      });
    } catch (e) {
      // An error thrown once the token exists (the delegate, the runtime) may carry it: same redaction as an answer.
      return { status: 'failed', detail: redactApprovalText(String((e as Error)?.message ?? e), signature, 2000) };
    }
    return approveOutcome(a, code, answer, signature);
  }

  private async reject(ev: ManagerEvent): Promise<void> {
    const found = await this.findOffer(ev);
    if (!found) return;
    const { offer, project } = found;
    const ids = { projectId: offer.projectId, requestId: offer.requestId };
    const last = lastOutcome(await readJournal(), offer.projectId, offer.requestId);
    if (found.spent || (last && last.type !== 'failed')) {
      await this.notify({ status: 'already-handled', ...ids, text: `change request ${offer.requestId}: already handled (${last?.type ?? 'confirmed'}); not rejected.` });
      return;
    }
    const r = await rejectRequest(project, offer.requestId, { reason: 'in the host manager' }, this.cr);
    await this.notify({ status: 'rejected', ...ids, text: [`change request ${offer.requestId} rejected (nothing applied)`, ...r.warnings.map((x) => `warning: ${x}`)].join('\n') });
  }

  // ------------------------------------------------------------ read-only owner commands

  /** The read-only owner commands (/status, /requests, /project) for the transport. */
  commands(): ManagerCommands {
    return {
      projects: async () => (await this.deps.projects()).map((p) => ({ projectId: p.projectId, name: basename(p.repoPath) })),
      status: (projectId) => this.statusText(projectId),
      pending: (projectId) => this.pendingOffers(projectId),
      propose: (projectId, command) => this.propose(projectId, command),
      devRebuild: (projectId) => this.devRebuild(projectId),
    };
  }

  /** Whether the dev-only rebuild-cli request exists for the project (or, with null, any registered project). */
  async devRebuild(projectId: string | null): Promise<boolean> {
    const projects = (await this.deps.projects()).filter((p) => !projectId || p.projectId === projectId);
    return projects.some((p) => devRebuildAvailable(p, this.deps.cli));
  }

  /**
   * An owner change command: the plan of an owner request (`ow_` id), journaled as an offer. Nothing is applied here.
   * Without a picked project it needs exactly one registered project.
   */
  async propose(projectId: string | null, c: OwnerCommand): Promise<ManagerOffer> {
    let project: ProjectJson;
    if (projectId) project = await this.deps.loadProject(projectId);
    else {
      const all = await this.deps.projects();
      if (all.length !== 1) {
        throw new MinionsError('PRECONDITION', all.length ? `${all.length} projects are registered: pick one with /project <name> first.` : 'No registered projects.');
      }
      project = all[0]!;
    }
    // Not registered outside a minions source checkout: refused before anything is planned or journaled.
    if (c.kind === 'rebuild-cli' && !devRebuildAvailable(project, this.deps.cli)) throw notAvailable();
    const payload: Record<string, unknown> = c.kind === 'config-set' ? { key: c.key, value: c.value, layer: c.layer }
      : c.kind === 'undo' ? { target: c.target } : c.kind === 'approve' ? { taskId: c.taskId, head: c.head, merge: c.merge } : {};
    const req: RequestSnapshot = { id: newOwnerRequestId(), kind: c.kind, payload, reason: null, origin: 'owner' };
    const built = await offerRequest(project, req, this.cr);
    const o = offerOf(built);
    this.deps.log(`owner request ${project.projectId} ${req.id}: ${o.summary}`);
    return o;
  }

  /**
   * Offers still waiting for the owner: requests whose newest journal entry is an offer (expired ones included: a
   * Confirm then brings a fresh offer). Built from the journal's own plan, never from the container.
   */
  async pendingOffers(projectId: string | null): Promise<ManagerOffer[]> {
    const last = new Map<string, JournalEntry>();
    for (const e of await readJournal()) last.set(`${e.projectId}\0${e.requestId}`, e);
    const out: ManagerOffer[] = [];
    for (const e of last.values()) {
      if (e.type !== 'offer' || (projectId && e.projectId !== projectId)) continue;
      try {
        const plan = e.plan as ChangePlan;
        out.push({
          projectId: e.projectId, requestId: e.requestId, kind: plan.kind, nonce: e.nonce, digest: e.digest, expiresAt: e.expiresAt,
          summary: planSummary(plan), text: formatPlan(plan, e.digest, []), loosens: plan.loosens ?? null,
        });
      } catch (err) { this.deps.log(`journal: the offer of ${e.requestId} cannot be shown: ${(err as Error).message}`); }
    }
    return out;
  }

  /** /status: per project the runtime, the coordinator and active leases (from the runtime's status), pending requests. */
  async statusText(projectId: string | null): Promise<string> {
    const projects = (await this.deps.projects()).filter((p) => !projectId || p.projectId === projectId);
    if (!projects.length) return projectId ? `Project ${projectId} is not registered.` : 'No registered projects.';
    const pending = await this.pendingOffers(projectId);
    const blocks: string[] = [];
    for (const p of projects) {
      const lines = [`${basename(p.repoPath)} (${p.projectId})`];
      let running = false;
      try { running = await this.deps.running(p); } catch (e) { lines.push(`  runtime: unknown (${(e as Error).message})`); }
      if (running) {
        lines.push('  runtime: running');
        try {
          const st = parseStatusEnvelope((await this.runtime.exec(p, ['minions', 'status', '--json'])).stdout);
          lines.push(...(st ? runtimeStatusLines(st) : ['  coordinator: unknown (the runtime gave no status)']));
        } catch (e) { lines.push(`  coordinator: unknown (${(e as Error).message})`); }
      } else if (!lines[1]) lines.push('  runtime: stopped');
      const mine = pending.filter((o) => o.projectId === p.projectId);
      lines.push(`  pending change requests: ${mine.length}${mine.length ? ` (${mine.map((o) => `${o.requestId}: ${o.summary}`).join('; ')})` : ''}`);
      const q = this.queued.get(p.projectId);
      if (q) lines.push(`  queued restart: ${q.offer.requestId} (${q.plan.restart?.mode === 'drain' ? 'drain now, then restart when idle' : 'restart when idle'}, since ${q.since})`);
      const problem = this.reported.get(`project:${p.projectId}`);
      if (problem) lines.push(`  last poll problem: ${problem}`);
      blocks.push(lines.join('\n'));
    }
    return displayText(blocks.join('\n\n'));
  }

  /**
   * The loop: startup report, then every 20 s a poll of every project; between polls the transport's owner events
   * are handled as they arrive. Returns when signal aborts.
   */
  async run(signal: AbortSignal): Promise<void> {
    await this.startup();
    while (!signal.aborted) {
      await this.pollAll();
      const due = this.deps.now().getTime() + POLL_INTERVAL_MS;
      for (;;) {
        if (signal.aborted) return;
        const left = due - this.deps.now().getTime();
        if (left <= 0) break;
        let events: ManagerEvent[];
        try { events = await this.deps.transport.receive(left, signal); } catch (e) {
          this.deps.log(`transport: receive failed: ${(e as Error).message}`);
          await this.deps.sleep(Math.min(left, 5_000), signal);
          continue;
        }
        for (const ev of events) await this.handle(ev);
      }
    }
  }
}

/** Reads the runtime's answer to `work approve` (untrusted: only the envelope's message, through redactApprovalText). */
export function approveOutcome(a: NonNullable<ChangePlan['approval']>, code: number, r: RunResult | null, signature?: string): { status: 'applied' | 'failed'; detail: string } {
  let env: { ok?: boolean; data?: { message?: unknown }; error?: { message?: unknown } } | null = null;
  try { env = r ? JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '') : null; } catch { env = null; }
  const what = `${a.scope === 'merge' ? 'merge' : 'publication'} approval for ${a.taskId} at ${a.head}`;
  const msg = (v: unknown) => redactApprovalText(String(v ?? ''), signature, APPROVE_MESSAGE_MAX);
  if (env && env.ok === true && code === 0) return { status: 'applied', detail: `${what} recorded: ${msg(env.data?.message)}` };
  if (env && env.ok === false) return { status: 'failed', detail: `${what} refused by the runtime: ${msg(env.error?.message)}` };
  return { status: 'failed', detail: `${what}: no result from the runtime (exit ${code})` };
}

/** The longest runtime message an approve outcome shows (UTF-16 code units, after redaction). */
export const APPROVE_MESSAGE_MAX = 500;
const REDACTED = '[REDACTED]';
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
/** Anything shaped like an approval token (`mnap1.<payload>.<signature>`), real or not. */
const TOKEN_SHAPE = new RegExp(`${escRe(APPROVAL_TOKEN_PREFIX)}\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`, 'g');
/** What a reader skips over in display-safe text: the <U+XXXX> markers escapeFormatChars writes, and combining marks. */
const INVISIBLE_NOISE = /<U\+[0-9A-F]{4,6}>|\p{M}/uy;
/** A segment of the real token shorter than this is not searched for on its own (too short to be a secret). */
const MIN_SECRET_PART = 16;

/** `s` without the noise (and whitespace, if `dropSpace`), with the index in `s` of every code unit kept. */
function skeleton(s: string, dropSpace: boolean): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  for (let i = 0; i < s.length;) {
    INVISIBLE_NOISE.lastIndex = i;
    const m = INVISIBLE_NOISE.exec(s);
    if (m) { i += m[0].length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    if (!(dropSpace && /\s/u.test(ch))) for (let k = 0; k < ch.length; k++) { text += ch[k]; at.push(i + k); }
    i += ch.length;
  }
  return { text, at };
}

/**
 * Replaces the real token, each long segment of it, and anything token-shaped in display-safe `s` with [REDACTED].
 * Matching runs on a skeleton of `s` without the invisible noise (format-char markers, combining marks; for the real
 * token also whitespace), so a token with such characters injected is still found; the span replaced in `s` runs from
 * the first to the last matched character, noise included.
 */
function redactDisplayed(s: string, needles: string[]): string {
  const spans: [number, number][] = [];
  const exact = skeleton(s, true);
  for (const n of needles) {
    for (let i = exact.text.indexOf(n); i >= 0; i = exact.text.indexOf(n, i + 1)) spans.push([exact.at[i]!, exact.at[i + n.length - 1]! + 1]);
  }
  const shaped = skeleton(s, false);
  for (const m of shaped.text.matchAll(TOKEN_SHAPE)) spans.push([shaped.at[m.index]!, shaped.at[m.index + m[0].length - 1]! + 1]);
  if (!spans.length) return s;
  spans.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged.at(-1);
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push([...sp]);
  }
  let out = '';
  let from = 0;
  for (const [a, b] of merged) { out += s.slice(from, a) + REDACTED; from = b; }
  return out + s.slice(from);
}

/**
 * Untrusted runtime text made safe to show, with the approval token gone: the one helper every place the runtime's
 * answer to `work approve` lands goes through (the outcome detail, which is the chat text, the manager log line and the
 * journal entry; and an error thrown while approving). The runtime holds the token (it is in its argv), so it may
 * echo it, also with characters displayText strips (C0/C1 controls, ANSI/OSC sequences) or escapes (zero-width and
 * bidi characters) inside it to dodge a plain match. Order: redact the whole token in the raw text; displayText;
 * collapse whitespace; redact the token, its long segments and token shapes on the skeleton (see redactDisplayed);
 * truncate to `max`; redact once more. The raw pass is exact-match only: a token-shape match there could stop at an
 * injected character and leave the rest of the real token for the later passes to miss. A runtime that re-encodes the
 * token on purpose (reversed, with visible separators) is not caught: that is outside what redaction can do.
 */
export function redactApprovalText(raw: string, signature: string | undefined, max = APPROVE_MESSAGE_MAX): string {
  const sig = signature?.trim() ? signature : undefined;
  const needles = sig ? [...new Set([sig, ...sig.split('.').filter((p) => p.length >= MIN_SECRET_PART)])].sort((x, y) => y.length - x.length) : [];
  // NUL first: an escape sequence left open just before the token ends at the NUL (which displayText drops), not inside the marker.
  let s = sig ? raw.split(sig).join(`\u0000${REDACTED}`) : raw;
  s = redactDisplayed(displayText(s).replace(/\s+/g, ' ').trim(), needles);
  s = redactDisplayed(truncateCodePoints(s, max), needles);
  return truncateCodePoints(s, max);
}

/** The upgrade ran npm for the CLI (a rebuild or reinstall finished, or failed half way): the CLI must be checked. */
export function cliReplaced(r: UpgradeRun): boolean {
  const s = r.steps.find((x) => x.id === 'cli');
  return !!s && (s.status === 'done' || (s.status === 'failed' && /\b(?:reinstall|rebuild) (?:failed|finished)\b/.test(s.detail)));
}

/** null when the runtime's answer is an ok envelope; otherwise why not (display-safe, bounded). */
function envelopeError(r: RunResult): string | null {
  let env: { ok?: unknown; error?: { message?: unknown } } | null = null;
  try { env = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { env = null; }
  if (env?.ok === true) return null;
  return truncateCodePoints(displayText(String(env?.error?.message ?? (r.stderr.trim() || `no result (exit ${r.code})`))).replace(/\s+/g, ' '), 300);
}

/** The default CLI check: `minions --version` and `minions --json status` of the host CLI in fresh processes. */
async function defaultCliHealth(project: ProjectJson): Promise<CliHealth> {
  const h = hostCli();
  return checkCliHealth((argv) => run(h.cmd, [...h.args, ...argv], { cwd: project.repoPath, env: h.env, allowFailure: true, timeoutMs: 120_000 }));
}

/** After an applied config change: the command that applies what it still needs (each confirmed on its own). */
function followUp(plan: ChangePlan): string[] {
  if ((plan.kind !== 'config-set' && plan.kind !== 'undo') || !plan.change) return [];
  if (plan.change.takesEffect === 'restart') return ['next: send /restart here to restart the coordinator (shown as its own plan to confirm)'];
  if (plan.change.takesEffect === 'upgrade') return ['next: send /upgrade here to recreate the container (shown as its own plan to confirm)'];
  return [];
}

/** Takes the manager lock, runs the loop until signal aborts, releases the lock. */
export async function runManager(deps: ManagerDeps, signal: AbortSignal): Promise<void> {
  const lock = await acquireManagerLock({ now: deps.now() });
  try {
    const m = new HostManager(deps);
    deps.transport.attach?.(m.commands());
    await m.run(signal);
  } finally { await lock.release(); }
}

// ---------------------------------------------------------------- defaults and the command

export const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * Without a paired manager bot (chooseTransport): offers and outcomes as JSON lines; no owner events. The printed confirm command
 * applies exactly the offered plan from the terminal (same journal, same checks).
 */
export function logTransport(write: (line: string) => void): ManagerTransport {
  return {
    sendOffer: async (o) => write(JSON.stringify({ event: 'offer', ...o, confirmCommand: `minions settings apply ${o.requestId} --confirm ${o.digest}` })),
    receive: async (waitMs, signal) => { await abortableSleep(waitMs, signal); return []; },
    sendOutcome: async (o) => write(JSON.stringify({ event: 'outcome', ...o })),
  };
}

/** Lines of /status from the runtime's `minions status --json` (untrusted: only typed fields, bounded, displayText). */
export function runtimeStatusLines(st: Record<string, unknown>): string[] {
  const out: string[] = [];
  const short = (v: unknown, max = 200) => truncateCodePoints(displayText(String(v)).replace(/\s+/g, ' '), max);
  const launch = st.coordinatorLaunch as { state?: unknown; reason?: unknown } | undefined;
  const state = typeof launch?.state === 'string' && ['current', 'stale', 'unrecorded', 'not-running'].includes(launch.state) ? launch.state : null;
  if (!state) out.push('  coordinator: unknown');
  else if (state === 'not-running') out.push('  coordinator: not running');
  else if (state === 'stale') out.push(`  coordinator: running, restart required (${short(launch?.reason ?? '')}): \`minions upgrade\``);
  else out.push(`  coordinator: running${state === 'unrecorded' ? ' (no launch record)' : ''}`);
  if (Array.isArray(st.activeLeases)) {
    const leases = st.activeLeases.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object');
    const shown = leases.slice(0, 5).map((l) => `${short(l.task_id ?? '?', 40)} ${short(l.role ?? '?', 20)}`);
    out.push(`  active leases: ${leases.length}${shown.length ? ` (${shown.join(', ')}${leases.length > shown.length ? ', …' : ''})` : ''}`);
  }
  if (st.paused && typeof st.paused === 'object') {
    const p = st.paused as { intake?: unknown; starts?: unknown };
    const what = [p.intake === true ? 'intake' : '', p.starts === true ? 'starts' : ''].filter(Boolean);
    if (what.length) out.push(`  paused: ${what.join(', ')}`);
  }
  return out;
}

async function registeredProjects(log: (l: string) => void): Promise<ProjectJson[]> {
  const out: ProjectJson[] = [];
  for (const id of Object.keys((await loadRegistry()).projects)) {
    try { out.push(await loadProjectJson(id)); } catch (e) { log(`project ${id}: cannot load project.json: ${(e as Error).message}`); }
  }
  return out;
}

/** Child timeouts: a config write is quick; a graceful restart waits for the coordinator. */
const CHILD_TIMEOUT_MS = 10 * 60_000;

export function defaultManagerDeps(transport: ManagerTransport, log: (line: string) => void): ManagerDeps {
  return {
    transport,
    projects: () => registeredProjects(log),
    loadProject: loadProjectJson,
    running: defaultSettingsRuntime.running,
    delegate: (p, argv) => delegateCapture(p, argv),
    runChild: (p, argv) => {
      const h = hostCli();
      return run(h.cmd, [...h.args, '--json', ...argv], { cwd: p.repoPath, env: h.env, allowFailure: true, timeoutMs: CHILD_TIMEOUT_MS });
    },
    upgrade: childUpgrade,
    now: () => new Date(),
    sleep: abortableSleep,
    log,
  };
}

export interface TransportChoice { kind: 'telegram' | 'log'; transport: ManagerTransport; detail: string }

/**
 * The manager bot transport when the bot is paired (a stored manager-bot-token and access.json of the same bot);
 * otherwise the log transport (JSON lines on stdout, confirm in the terminal). An unreadable store or pairing file is
 * an error, not a silent fallback.
 */
export async function chooseTransport(o: {
  write: (line: string) => void; log: (line: string) => void;
  loadAccess?: () => Promise<ManagerAccess | null>; readToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
}): Promise<TransportChoice> {
  const access = await (o.loadAccess ?? loadManagerAccess)();
  const token = access ? await (o.readToken ?? (() => readManagerToken()))() : null;
  const fallback = (detail: string): TransportChoice => ({ kind: 'log', transport: logTransport(o.write), detail });
  if (!access) return fallback('the manager bot is not paired (run `minions setup`): offers are printed as JSON lines');
  if (!token) return fallback('no manager bot token is stored (run `minions setup`): offers are printed as JSON lines');
  if (!token.startsWith(`${access.botId}:`)) return fallback('the pairing belongs to another manager bot (pair again with `minions setup`): offers are printed as JSON lines');
  return {
    kind: 'telegram', detail: `talking to the paired owner through manager bot ${access.botId}`,
    transport: telegramTransport({ token, access, log: o.log, ...(o.fetch ? { fetch: o.fetch } : {}) }),
  };
}

/** `minions manager run` (internal tier; started by the supervisor in phase 5). */
export function registerManager(program: Command): void {
  const manager = program.command('manager')
    .description('Host manager: confirms and applies change requests from the projects (internal; started by its service)');
  manager.command('run')
    .description('Run the host manager loop in the foreground (host only; one per host): polls every project for change requests, offers them, applies confirmed ones')
    .action(action(async () => {
      requireMode('host');
      const log = (l: string) => process.stderr.write(`minions manager: ${displayText(l)}\n`);
      const ctl = new AbortController();
      const stop = () => ctl.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const choice = await chooseTransport({ write: (l) => process.stdout.write(`${l}\n`), log });
        log(choice.detail);
        await runManager(defaultManagerDeps(choice.transport, log), ctl.signal);
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }));
}
