import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import type { RuntimeDb } from './db.js';

/**
 * Routine coordinator context resets (task-45). The coordinator session's context grows with every turn;
 * instead of one long session it restarts itself often, carrying over only a short handoff.
 *
 * - Handoff: `minions coordinator handoff` (text on stdin) stores a capped (HANDOFF_MAX_BYTES), redacted
 *   note at `<state>/coordinator-handoff.json`, replacing the previous one (atomic write, 0600). A fresh
 *   coordinator reads it with `--read` at startup (the recovery prompt and the recover skill say so),
 *   together with `minions status`. Everything else (backlog, leases, results, outbox, spend) is already
 *   durable; the handoff only holds what lives in the conversation: open owner questions, pending
 *   decisions, what the session waits on.
 * - Triggers (contextResetCheck): evaluated from durable state on demand, never by a timer. A reset is due
 *   only with no active lease and no drain, and when one trigger holds for the current session (since the
 *   coordinator lock was taken): a task was delivered, the context reached `contextTokens` (latest
 *   main-session usage in the transcript the Stop hook recorded), or `handoffs` worker records/releases
 *   happened (also the fallback when no transcript usage is readable). `work record|release` responses
 *   carry `contextReset` only when due; `coordinator handoff --check` and `status` show the full state.
 * - The runtime never restarts the coordinator by itself: the coordinator, told by the response, writes
 *   the handoff and runs `coordinator restart --recover`, which still refuses while leases are active.
 */

export const HANDOFF_MAX_BYTES = 4096;
export const DEFAULT_CONTEXT_TOKENS = 60_000;
export const DEFAULT_HANDOFFS = 10;
/** Transcript bytes read from the end when looking for the latest usage. */
export const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
/** Meta key: the main-session transcript the Stop hook last saw. */
export const TRANSCRIPT_META = 'coordinator_transcript';

export interface ContextResetSettings { enabled: boolean; afterDelivery: boolean; contextTokens: number | null; handoffs: number | null }

/** Effective settings: unset config = off; unset trigger fields = defaults; null = that trigger off. */
export function contextResetSettings(cfg: Pick<MinionsConfig, 'coordinator'>): ContextResetSettings {
  const c = cfg.coordinator?.contextReset;
  return {
    enabled: c?.enabled ?? false,
    afterDelivery: c?.afterDelivery ?? true,
    contextTokens: c?.contextTokens === undefined ? DEFAULT_CONTEXT_TOKENS : c.contextTokens,
    handoffs: c?.handoffs === undefined ? DEFAULT_HANDOFFS : c.handoffs,
  };
}

// ---------------------------------------------------------------- handoff file

/** Extra credential shapes masked in handoffs, on top of the CLI-wide redact(). */
const HANDOFF_SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]'],
  [/\b(password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)(["']?)[^\s"']{8,}\3/gi, '$1$2[REDACTED]'],
  [/(\/\/[^\s:/@]+:)[^\s@/]{3,}@/g, '$1[REDACTED]@'],
];

/** Masks credential-shaped substrings; returns the text and how many were masked. */
export function redactHandoff(text: string): { text: string; redactions: number } {
  const marks = (s: string) => (s.match(/\[REDACTED/g) ?? []).length;
  let out = redact(text);
  for (const [re, rep] of HANDOFF_SECRET_PATTERNS) out = out.replace(re, rep);
  return { text: out, redactions: Math.max(0, marks(out) - marks(text)) };
}

export interface StoredHandoff { version: 1; writtenAt: string; session: string | null; bytes: number; redactions: number; text: string }

export interface HandoffWriteResult { path: string; writtenAt: string; bytes: number; maxBytes: number; redactions: number; replaced: boolean }

function readStored(path: string): StoredHandoff | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as StoredHandoff;
    return v && typeof v.text === 'string' && typeof v.writtenAt === 'string' ? v : null;
  } catch { return null; }
}

/**
 * `minions coordinator handoff` (stdin): redacts, enforces the cap, replaces the stored handoff. Over the cap
 * it is refused (PRECONDITION) and the previous handoff is kept: nothing is silently cut off.
 */
export async function writeHandoff(deps: { db: RuntimeDb; path: string; now?: Date }, raw: string): Promise<HandoffWriteResult> {
  const trimmed = raw.replace(/\r\n/g, '\n').trim();
  if (!trimmed) throw new MinionsError('PRECONDITION', 'The handoff is empty.', 'Pipe a short note on stdin (a quoted heredoc): open owner questions with your recommended answers, pending decisions, what you are waiting on, spend, chat context the durable state does not hold.');
  const { text, redactions } = redactHandoff(trimmed);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > HANDOFF_MAX_BYTES) {
    throw new MinionsError('PRECONDITION', `The handoff is ${bytes} bytes; the cap is ${HANDOFF_MAX_BYTES}. The previous handoff is kept.`,
      'Shorten it: keep open owner questions and pending decisions first, drop anything the backlog, leases, outbox or `minions status` already hold.', { bytes, maxBytes: HANDOFF_MAX_BYTES });
  }
  const replaced = readStored(deps.path) !== null;
  const writtenAt = (deps.now ?? new Date()).toISOString();
  const session = deps.db.coordinatorLock()?.session ?? null;
  const stored: StoredHandoff = { version: 1, writtenAt, session, bytes, redactions, text };
  await atomicWrite(deps.path, JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
  // The event carries no text: the DB and logs never hold the handoff body.
  deps.db.addEvent('coordinator-handoff', null, { bytes, redactions, replaced });
  return { path: deps.path, writtenAt, bytes, maxBytes: HANDOFF_MAX_BYTES, redactions, replaced };
}

export type HandoffReadResult =
  | { present: false; path: string }
  | { present: true; path: string; writtenAt: string; ageMinutes: number; bytes: number; text: string };

/** `minions coordinator handoff --read`: the stored handoff for a fresh coordinator (never throws on a missing file). */
export function readHandoff(path: string, now: Date = new Date()): HandoffReadResult {
  const v = readStored(path);
  if (!v) return { present: false, path };
  const ageMinutes = Math.max(0, Math.round((now.getTime() - Date.parse(v.writtenAt)) / 60_000));
  return { present: true, path, writtenAt: v.writtenAt, ageMinutes, bytes: v.bytes, text: v.text };
}

// ---------------------------------------------------------------- transcript usage

/** The Stop hook's input names the main session's transcript; remember it (meta only: no event, so the stop guard's fingerprint is unchanged). */
export function noteTranscript(db: Pick<RuntimeDb, 'setMeta' | 'getMeta'>, input: Record<string, unknown>, now: Date = new Date()): void {
  const path = input.transcript_path;
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return;
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
  const prev = db.getMeta(TRANSCRIPT_META);
  let firstSeen = now.toISOString();
  try { const p = prev ? JSON.parse(prev) as { path?: string; firstSeen?: string } : null; if (p?.path === path && p.firstSeen) firstSeen = p.firstSeen; } catch { /* replace a corrupt value */ }
  db.setMeta(TRANSCRIPT_META, JSON.stringify({ path, sessionId, firstSeen, at: now.toISOString() }));
}

function readTail(path: string, maxBytes = TRANSCRIPT_TAIL_BYTES): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

/**
 * Context size of the latest main-session assistant turn in a Claude Code transcript (JSONL): input +
 * cache read + cache creation + output tokens of its `message.usage`. Sidechain (subagent) lines are
 * skipped. Null when no usage is readable.
 */
export function contextTokensFromTranscript(tail: string | null): number | null {
  if (!tail) return null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    let v: { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, unknown> } };
    try { v = JSON.parse(line); } catch { continue; }
    if (v.type !== 'assistant' || v.isSidechain) continue;
    const u = v.message?.usage;
    if (!u) continue;
    const n = (k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : 0);
    const total = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
    if (total > 0) return total;
  }
  return null;
}

// ---------------------------------------------------------------- triggers

export type ResetTrigger = 'delivered' | 'context' | 'handoffs';

export interface ContextResetCheck {
  enabled: boolean;
  due: boolean;
  /** Triggers that hold (a reset is due only when one holds and nothing blocks). */
  triggers: ResetTrigger[];
  /** Why a reset cannot happen now (disabled, active leases, drain, no session). */
  blockers: string[];
  /** One line for the coordinator. */
  reason: string;
  session: {
    since: string | null;
    handoffs: number;
    delivered: string[];
    contextTokens: number | null;
    contextSource: 'transcript' | 'unavailable';
    /** A handoff was written in this session. */
    handoffWritten: boolean;
  };
  settings: ContextResetSettings;
  /** Present when due: what to run, in order. */
  steps?: string[];
}

export interface ContextResetDeps {
  db: RuntimeDb;
  config: Pick<MinionsConfig, 'coordinator'>;
  /** Transcript tail reader (tests inject it). */
  readTranscript?: (path: string) => string | null;
}

interface EventRow { kind: string; task_id: string | null; data_json: string | null }

/** The restart the coordinator runs on itself: detached, because the restart ends the calling session; refused with active leases. */
export const RESET_RESTART_COMMAND = 'minions coordinator restart --recover --detach --json';

export function contextResetCheck(deps: ContextResetDeps): ContextResetCheck {
  const { db } = deps;
  const settings = contextResetSettings(deps.config);
  const since = db.coordinatorLock()?.acquiredAt ?? null;
  const blockers: string[] = [];
  if (!settings.enabled) blockers.push('context resets are off (coordinator.contextReset.enabled)');
  const leases = db.activeLeases();
  if (leases.length) blockers.push(`${leases.length} active worker lease(s) (${leases.map((l) => l.id).join(', ')})`);
  if (db.drain()) blockers.push('a drain is in progress (the upgrade restarts the coordinator itself)');
  if (!since) blockers.push('no coordinator session holds the project lock');

  const rows = since
    ? db.all<EventRow>("SELECT kind, task_id, data_json FROM events WHERE at >= ? AND kind IN ('record', 'release', 'coordinator-handoff') ORDER BY id", since)
    : [];
  let handoffs = 0;
  let handoffWritten = false;
  const delivered: string[] = [];
  for (const r of rows) {
    if (r.kind === 'coordinator-handoff') { handoffWritten = true; continue; }
    handoffs++;
    if (r.kind !== 'record' || !r.data_json) continue;
    try {
      const d = JSON.parse(r.data_json) as { to?: string; leaseId?: string };
      if (d.to === 'delivered' || d.to === 'done') delivered.push(r.task_id ?? d.leaseId ?? '?');
    } catch { /* not a record we can read */ }
  }

  let contextTokens: number | null = null;
  try {
    const t = db.getMeta(TRANSCRIPT_META);
    const rec = t ? JSON.parse(t) as { path?: string; at?: string } : null;
    // Only this session's transcript: the Stop hook saw it after the current lock was taken.
    if (rec?.path && since && rec.at && rec.at >= since) contextTokens = contextTokensFromTranscript((deps.readTranscript ?? readTail)(rec.path));
  } catch { contextTokens = null; }

  const triggers: ResetTrigger[] = [];
  if (settings.afterDelivery && delivered.length) triggers.push('delivered');
  if (settings.contextTokens !== null && contextTokens !== null && contextTokens >= settings.contextTokens) triggers.push('context');
  if (settings.handoffs !== null && handoffs >= settings.handoffs) triggers.push('handoffs');

  const due = settings.enabled && blockers.length === 0 && triggers.length > 0;
  const what = triggers.map((t) => t === 'delivered' ? `delivered ${[...new Set(delivered)].join(', ')}`
    : t === 'context' ? `context ${contextTokens} >= ${settings.contextTokens} tokens` : `${handoffs} hand-offs >= ${settings.handoffs}`).join('; ');
  const reason = due ? `context reset due: ${what}`
    : blockers.length ? `no context reset: ${blockers.join('; ')}` : 'no context reset: no trigger holds yet';
  return {
    enabled: settings.enabled, due, triggers, blockers, reason,
    session: { since, handoffs, delivered: [...new Set(delivered)], contextTokens, contextSource: contextTokens === null ? 'unavailable' : 'transcript', handoffWritten },
    settings,
    ...(due ? { steps: [
      'Finish the current owner exchange (never restart mid-answer); send pending notifications (`minions notify pending --json`).',
      'Write the handoff: `minions coordinator handoff --json` with the note on stdin (quoted heredoc, at most 4 KB, no secrets): open owner questions with your recommended answers, pending decisions, what you wait on, spend, chat context the durable state does not hold.',
      `Restart: \`${RESET_RESTART_COMMAND}\``,
    ] } : {}),
  };
}

/** The compact form put on `work record|release` responses (only when due, to keep the coordinator's context small). */
export function dueNotice(c: ContextResetCheck): { due: true; reason: string; steps: string[] } | undefined {
  return c.due ? { due: true, reason: c.reason, steps: c.steps ?? [] } : undefined;
}

/** One status line when resets are on. */
export function humanContextReset(c: ContextResetCheck): string {
  const s = c.session;
  const ctx = s.contextTokens === null ? 'context unknown' : `context ${Math.round(s.contextTokens / 1000)}k${c.settings.contextTokens ? `/${Math.round(c.settings.contextTokens / 1000)}k` : ''}`;
  return `context reset: ${c.due ? 'due' : 'not due'} (${s.handoffs}${c.settings.handoffs ? `/${c.settings.handoffs}` : ''} hand-offs, ${ctx}${s.delivered.length ? `, delivered ${s.delivered.join(', ')}` : ''})${c.due ? '' : c.blockers.length ? `; ${c.blockers.join('; ')}` : ''}`;
}
