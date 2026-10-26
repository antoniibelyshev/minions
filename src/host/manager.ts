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
//   events, send an outcome. Phase 4 plugs in the manager bot (owner check, inline buttons, double tap for a plan
//   with `loosens`); until then `manager run` uses a log transport (JSON lines on stdout, no events: confirm in the
//   terminal with the printed `settings apply --confirm` command, which uses the same journal).
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { action, requireMode } from '../core/cli-helpers.js';
import { displayText } from '../core/control-chars.js';
import { MinionsError, isMinionsError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { ensureDir } from '../core/fsutil.js';
import { procStartTime } from '../runtime/coordinator.js';
import { isChangeRequestId, type ChangeRequestView } from '../runtime/change-requests.js';
import { pidAlive } from '../runtime/db.js';
import {
  findOfferByNonce, interruptedEntries, lastOutcome, managerDir, readJournal, recordOutcome, writer, writerAlive,
  type JournalEntry, type OfferEntry, type OutcomeEntry,
} from './change-journal.js';
import {
  childUpgrade, confirmOffer, fetchRequests, formatPlan, fromContainerOf, hostCli, mark, offerRequest, planArgv,
  recordApplyResult, rejectRequest, snapshotOf, type ChangePlan, type ChangeRequestDeps,
} from './change-requests.js';
import { DELEGATE_MAX_OUTPUT_BYTES, DELEGATE_TIMEOUT_MS, delegateCapture } from './delegate.js';
import { loadProjectJson, type ProjectJson } from './project.js';
import { loadRegistry } from './registry.js';
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

export type ManagerOutcomeStatus = 'applying' | 'applied' | 'failed' | 'refused' | 'rejected' | 'already-handled' | 'interrupted' | 'error';
/** A report to the owner (one new message each, so the phone notifies). */
export interface ManagerOutcome { status: ManagerOutcomeStatus; projectId: string | null; requestId: string | null; text: string }

/** The manager's only channel to the owner. Phase 4 implements it with the manager bot. */
export interface ManagerTransport {
  sendOffer(offer: ManagerOffer): Promise<void>;
  /** Waits up to waitMs (or until signal aborts) for owner events; returns them (possibly none). */
  receive(waitMs: number, signal?: AbortSignal): Promise<ManagerEvent[]>;
  sendOutcome(outcome: ManagerOutcome): Promise<void>;
}

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
}

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
  if (plan.kind === 'restart') return 'restart the coordinator';
  return plan.steps[0] ?? plan.kind;
}

/** Reads the host CLI child's `--json` answer into an outcome. */
export function childOutcome(plan: ChangePlan, r: RunResult): { status: 'applied' | 'failed'; detail: string } {
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
  return { status: d.action === 'restarted' && r.code === 0 ? 'applied' : 'failed', detail };
}

export class HostManager {
  readonly runtime: SettingsRuntime;
  /** Problems already reported (key -> message), so a 20 s poll does not repeat them. */
  private readonly reported = new Map<string, string>();
  /** Offers whose sendOffer failed: offered again on the next poll. */
  private readonly unsent = new Set<string>();

  constructor(private readonly deps: ManagerDeps) {
    this.runtime = boundedRuntime(deps);
  }

  private get cr(): ChangeRequestDeps { return { runtime: this.runtime, upgrade: this.deps.upgrade, now: this.deps.now }; }

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
        + 'It is not resumed: check the project, then confirm the request again or reject it.';
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
      const o = await this.offer(project, row);
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
  private async offer(project: ProjectJson, row: Pick<ChangeRequestView, 'id' | 'kind' | 'payload' | 'reason'>): Promise<ManagerOffer | null> {
    let built: Awaited<ReturnType<typeof offerRequest>>;
    try { built = await offerRequest(project, snapshotOf(row), this.cr); } catch (e) {
      await this.reportOnce(`plan:${project.projectId}:${row.id}`, { status: 'error', projectId: project.projectId, requestId: row.id, text: `change request ${row.id} (project ${project.projectId}) cannot be offered: ${(e as Error).message}` });
      return null;
    }
    const o: ManagerOffer = {
      projectId: project.projectId, requestId: row.id, kind: built.plan.kind, nonce: built.offer.nonce, digest: built.digest, expiresAt: built.offer.expiresAt,
      summary: planSummary(built.plan), text: formatPlan(built.plan, built.digest, built.notes), loosens: built.plan.loosens,
    };
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
      await this.notify({ status: 'error', projectId: null, requestId: typeof ev.requestId === 'string' && isChangeRequestId(ev.requestId) ? ev.requestId : null, text: `handling a ${String(ev.type)}: ${(e as Error).message}` });
    }
  }

  private async findOffer(ev: ManagerEvent): Promise<{ offer: OfferEntry; spent: boolean; project: ProjectJson } | null> {
    if (typeof ev.requestId !== 'string' || !isChangeRequestId(ev.requestId) || typeof ev.nonce !== 'string' || !NONCE_PATTERN.test(ev.nonce)) {
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
      if (why === 'expired' || why === 'revision' || why === 'digest') await this.reoffer(project, offer.requestId);
      return;
    }
    await this.apply(project, offer);
  }

  /** After a refusal: a fresh offer when the request is still open in the runtime. */
  private async reoffer(project: ProjectJson, requestId: string): Promise<void> {
    try {
      const row = (await fetchRequests(project, this.runtime, false) as unknown[]).filter(wellFormed).find((r) => r.id === requestId);
      if (row && (row.status === 'proposed' || row.status === 'failed')) { await this.offer(project, row); return; }
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
    const argv = planArgv(plan, offer.request);
    await this.notify({ status: 'applying', ...ids, text: `Applying change request ${offer.requestId} (project ${offer.projectId}): ${planSummary(plan)}…` });
    let result: { status: 'applied' | 'failed'; detail: string };
    try {
      await recordOutcome({ type: 'applying', ...ids, nonce: offer.nonce, digest: offer.digest, detail: `minions ${argv.join(' ')}`, ...writer() }, this.deps.now());
      if (plan.kind === 'upgrade') {
        const r = await this.deps.upgrade(project, { fromContainer: fromContainerOf(offer.request.payload), dryRun: false });
        result = { status: r.ok ? 'applied' : 'failed', detail: `upgrade: ${r.summary}` };
      } else {
        result = childOutcome(plan, await this.deps.runChild(project, argv));
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
        ...warnings.map((x) => `warning: ${displayText(x)}`)].join('\n'),
    });
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

/** Takes the manager lock, runs the loop until signal aborts, releases the lock. */
export async function runManager(deps: ManagerDeps, signal: AbortSignal): Promise<void> {
  const lock = await acquireManagerLock({ now: deps.now() });
  try { await new HostManager(deps).run(signal); } finally { await lock.release(); }
}

// ---------------------------------------------------------------- defaults and the command

export const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * Until the manager bot (phase 4): offers and outcomes as JSON lines; no owner events. The printed confirm command
 * applies exactly the offered plan from the terminal (same journal, same checks).
 */
export function logTransport(write: (line: string) => void): ManagerTransport {
  return {
    sendOffer: async (o) => write(JSON.stringify({ event: 'offer', ...o, confirmCommand: `minions settings apply ${o.requestId} --confirm ${o.digest}` })),
    receive: async (waitMs, signal) => { await abortableSleep(waitMs, signal); return []; },
    sendOutcome: async (o) => write(JSON.stringify({ event: 'outcome', ...o })),
  };
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
        await runManager(defaultManagerDeps(logTransport((l) => process.stdout.write(`${l}\n`)), log), ctl.signal);
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    }));
}
