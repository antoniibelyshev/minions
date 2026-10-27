// The host manager in `minions status` and `status --check` (docs/design/host-manager.md, phase 5, task-53.6):
// the service (installed, running), the process (lock, transport, last poll), the bot (id, paired) and the change
// requests still waiting for the owner, per project. Read-only: local files and, only when a service is recorded,
// one launchctl / systemctl query through the injectable runner. No network call, never the token.
import { basename } from 'node:path';
import { displayText, truncateCodePoints } from '../core/control-chars.js';
import { readJournal, type JournalEntry } from './change-journal.js';
import type { ChangePlan } from './change-requests.js';
import { loadManagerCredentialRef } from './credentials.js';
import { loadManagerAccess } from './manager-bot.js';
import { assistantOverview, formatAssistantLine, type AssistantOverview } from './manager-assistant.js';
import { managerProcessState, serviceHost, serviceKind, serviceState, type ProcessState, type ServiceHost, type ServiceState } from './manager-service.js';
import { planSummary } from './manager.js';
import { loadRegistry } from './registry.js';

/** A poll older than this while the manager runs is reported as stalled (it polls every 20 s). */
export const POLL_STALE_MS = 3 * 60_000;

export interface PendingRequest { requestId: string; kind: string; summary: string; expiresAt: string; expired: boolean }
export interface ManagerOverview {
  /** A manager bot token is stored. */
  setUp: boolean;
  botId: string | null;
  paired: boolean;
  /** The natural-language assistant: assistant.json and whether a Claude token is stored (no claude run). */
  assistant: AssistantOverview;
  service: ServiceState;
  process: ProcessState;
  /** Requests whose newest journal entry is an offer (waiting for Confirm / Reject), per project. */
  pending: { projectId: string; name: string | null; requests: PendingRequest[] }[];
  /** Problems reading any of the above (status never fails on them). */
  errors: string[];
}

const one = (v: unknown, max = 160) => truncateCodePoints(displayText(String(v)).replace(/\s+/g, ' '), max);

/** Offers waiting for the owner, grouped by project (oldest first). */
export function pendingFromJournal(entries: JournalEntry[], now: Date): Map<string, PendingRequest[]> {
  const last = new Map<string, JournalEntry>();
  for (const e of entries) { last.delete(`${e.projectId}\0${e.requestId}`); last.set(`${e.projectId}\0${e.requestId}`, e); }
  const out = new Map<string, PendingRequest[]>();
  for (const e of last.values()) {
    if (e.type !== 'offer') continue;
    let summary: string;
    try { summary = planSummary(e.plan as ChangePlan); } catch { summary = String((e.plan as { kind?: unknown } | null)?.kind ?? 'change'); }
    const list = out.get(e.projectId) ?? [];
    list.push({ requestId: e.requestId, kind: String((e.plan as { kind?: unknown } | null)?.kind ?? e.request?.kind ?? '?'), summary: one(summary), expiresAt: e.expiresAt, expired: Date.parse(e.expiresAt) <= now.getTime() });
    out.set(e.projectId, list);
  }
  return out;
}

export async function managerOverview(o: { host?: ServiceHost; now?: Date; alive?: (pid: number) => boolean; startOf?: (pid: number) => string | null } = {}): Promise<ManagerOverview> {
  const host = o.host ?? serviceHost();
  const now = o.now ?? new Date();
  const errors: string[] = [];
  const ref = await loadManagerCredentialRef().catch((e) => { errors.push(`manager credential reference: ${(e as Error).message.split('\n')[0]}`); return null; });
  const access = await loadManagerAccess().catch((e) => { errors.push(`access.json: ${(e as Error).message.split('\n')[0]}`); return null; });
  const assistant = await assistantOverview().catch((e): AssistantOverview => ({
    setUp: false, enabled: false, model: null, dailyLimit: null, credential: 'invalid', credentialKind: null, errors: [`assistant: ${String((e as Error).message ?? e).split('\n')[0]}`],
  }));
  errors.push(...assistant.errors);
  const service = await serviceState(host);
  const proc = await managerProcessState({ ...(o.alive ? { alive: o.alive } : {}), ...(o.startOf ? { startOf: o.startOf } : {}) });
  const pending: ManagerOverview['pending'] = [];
  try {
    const byProject = pendingFromJournal(await readJournal(), now);
    const reg = await loadRegistry().catch(() => ({ projects: {} as Record<string, { repoPath?: string }> }));
    for (const [projectId, requests] of byProject) {
      const repo = (reg.projects as Record<string, { repoPath?: string }>)[projectId]?.repoPath;
      pending.push({ projectId, name: repo ? basename(repo) : null, requests });
    }
  } catch (e) { errors.push(`journal: ${(e as Error).message.split('\n')[0]}`); }
  return { setUp: !!ref, botId: ref?.botId ?? null, paired: !!ref && access?.botId === ref.botId, assistant, service, process: proc, pending, errors };
}

const ago = (iso: string, now: Date) => {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** Human lines for `minions status`. */
export function formatManagerOverview(m: ManagerOverview, now: Date = new Date()): string[] {
  const out = ['host manager:'];
  const svc = m.service.installed
    ? `${m.service.kind === 'launchd' ? 'launchd agent' : 'systemd --user unit'} installed, ${m.service.active ?? 'unknown'}${m.service.fileMatches === false ? ' (unit file changed since setup)' : ''}`
    : m.service.path ? `not installed (${m.service.detail})` : 'not installed';
  out.push(`  service: ${svc}`);
  out.push(`  bot: ${m.setUp ? `${m.botId}, ${m.paired ? 'paired' : 'not paired'}` : 'not set up (optional: `minions setup`)'}`);
  if (m.setUp || m.assistant.setUp) out.push(`  ${formatAssistantLine(m.assistant)}`);
  if (m.process.running) {
    const poll = m.process.lastPollAt ? `last poll ${ago(m.process.lastPollAt, now)}` : 'no poll yet';
    out.push(`  process: running (pid ${m.process.pid}${m.process.since ? `, since ${m.process.since}` : ''}${m.process.transport ? `, ${m.process.transport === 'telegram' ? 'Telegram' : 'log only'}` : ''}), ${poll}`);
  } else out.push('  process: not running');
  if (!m.pending.length) out.push('  pending requests: none');
  for (const p of m.pending) {
    out.push(`  pending requests, ${p.name ? `${one(p.name, 60)} (${p.projectId})` : p.projectId}: ${p.requests.length}`);
    for (const r of p.requests.slice(0, 10)) out.push(`    ${r.requestId} ${r.summary}${r.expired ? ' (offer expired: Confirm brings a fresh one)' : ''}`);
    if (p.requests.length > 10) out.push(`    … ${p.requests.length - 10} more (\`minions settings requests\` in the project)`);
  }
  for (const e of m.errors) out.push(`  warning: ${one(e, 300)}`);
  return out;
}

/** The JSON view for `status --json` (no paths of other users' files, never the token). */
export function managerOverviewJson(m: ManagerOverview) {
  return {
    setUp: m.setUp, botId: m.botId, paired: m.paired,
    assistant: { setUp: m.assistant.setUp, enabled: m.assistant.enabled, model: m.assistant.model, dailyLimit: m.assistant.dailyLimit, credential: m.assistant.credential, credentialKind: m.assistant.credentialKind },
    service: { kind: m.service.kind, installed: m.service.installed, active: m.service.active, detail: m.service.detail, path: m.service.path },
    running: m.process.running, pid: m.process.pid, since: m.process.since, transport: m.process.transport, lastPollAt: m.process.lastPollAt,
    pending: m.pending, ...(m.errors.length ? { errors: m.errors } : {}),
  };
}

type CheckStatus = 'ok' | 'warn' | 'unavailable';
export interface ManagerServiceCheck { name: string; status: CheckStatus; detail: string; hint?: string }

/**
 * manager.service and manager.process for `status --check` / doctor. Never 'fail': the manager is optional and the
 * terminal (`minions settings requests|apply|reject`) stays the baseline.
 */
export function managerServiceChecks(m: ManagerOverview, o: { platform?: NodeJS.Platform; now?: Date } = {}): ManagerServiceCheck[] {
  const now = o.now ?? new Date();
  const setup = 'Run `minions setup` in a terminal (host manager step) to install the service.';
  const out: ManagerServiceCheck[] = [];
  const kind = serviceKind(o.platform ?? process.platform);
  const s = m.service;
  if (!s.installed && !s.path && s.active !== 'unknown') {
    if (!kind) out.push({ name: 'manager.service', status: 'unavailable', detail: `no supported user service manager on ${o.platform ?? process.platform}; run \`minions manager run\` under your own supervisor` });
    else if (m.setUp) out.push({ name: 'manager.service', status: 'warn', detail: 'the manager bot is set up, but no service runs the manager', hint: setup });
    else out.push({ name: 'manager.service', status: 'ok', detail: 'not installed (optional)' });
  } else if (!s.installed || s.active === 'unknown') {
    out.push({ name: 'manager.service', status: 'warn', detail: s.detail, hint: setup });
  } else if (s.active !== 'running') {
    out.push({ name: 'manager.service', status: 'warn', detail: s.detail,
      hint: s.kind === 'launchd' ? 'See <MINIONS_HOME>/manager/manager.log; rerun `minions setup` to load it again.' : 'See `journalctl --user -u minions-manager*`; rerun `minions setup` to start it again.' });
  } else {
    out.push({ name: 'manager.service', status: s.fileMatches === false ? 'warn' : 'ok', detail: `${s.detail}${s.fileMatches === false ? '; the unit file changed since setup wrote it' : ''}`,
      ...(s.fileMatches === false ? { hint: 'Rerun `minions setup` to rewrite it.' } : {}) });
  }
  const p = m.process;
  if (!p.running) {
    out.push(s.installed || m.setUp
      ? { name: 'manager.process', status: 'warn', detail: 'the host manager is not running: change requests wait in each runtime (`minions status` lists them)', hint: s.installed ? 'Check the service (manager.service above).' : setup }
      : { name: 'manager.process', status: 'unavailable', detail: 'not running' });
  } else {
    const stale = p.lastPollAt ? now.getTime() - Date.parse(p.lastPollAt) > POLL_STALE_MS : false;
    const detail = `running (pid ${p.pid}${p.transport ? `, ${p.transport === 'telegram' ? `Telegram bot ${p.botId ?? '?'}` : 'log transport: confirm in the terminal'}` : ''}), ${p.lastPollAt ? `last poll ${ago(p.lastPollAt, now)}` : 'no poll recorded yet'}`;
    out.push(stale
      ? { name: 'manager.process', status: 'warn', detail: `${detail}: polling looks stalled (a long apply also delays it)`, hint: 'If it stays like this, restart the service (rerun `minions setup`).' }
      : { name: 'manager.process', status: 'ok', detail });
  }
  return out;
}
