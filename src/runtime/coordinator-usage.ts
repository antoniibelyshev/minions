import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { MinionsConfig } from '../config/schema.js';
import type { RuntimeDb } from './db.js';

/**
 * Coordinator token tracking (task-57.1, step 1 of docs/design/coordinator-sessions.md).
 *
 * After each main coordinator turn the Stop hook reads the session's Claude Code transcript (JSONL)
 * incrementally, from a byte offset kept in meta `coordinator_usage:<session_id>`, and sums the
 * `message.usage` of the main-session assistant lines, the four components kept apart. Sidechain lines
 * (subagents: workers are counted through `--usage`) are skipped; a message id counts once (Claude Code
 * writes one line per content block, each with the message's usage); a truncated last line is left for
 * the next read. The cumulative session figure is stored with `recordSessionUsage` keyed
 * `session:<claude session_id>`, so a reset never overwrites the previous session. A session killed
 * before its last Stop is completed at the next coordinator start (`completeOpenSessions`) from the
 * transcript path in its meta state, and marked ended with the trigger that ended it.
 *
 * Best-effort throughout: nothing here throws to the caller, the read is bounded in bytes and time, and
 * the Stop decision never depends on it. No schema change: meta rows and `usage` events only.
 */

export const USAGE_META_PREFIX = 'coordinator_usage:';
/** Meta key: the triggers behind the last self-restart (`coordinator restart --detach`), for the session's end trigger. */
export const RESET_REQUEST_META = 'coordinator_reset_request';
/** Bytes read per call: tens of milliseconds to parse, far below the Stop hook timeout (a long transcript is caught up over several turns). */
export const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Message ids remembered across reads (a message's lines split across two reads count once). */
const RECENT_IDS = 500;

export interface UsageComponents { input: number; cacheRead: number; cacheWrite: number; output: number }
export type SessionEndTrigger = 'context-reset' | 'restart' | 'exit';

export interface CoordinatorSessionState {
  version: 1;
  sessionId: string;
  path: string;
  /** Bytes of the transcript already read (always at a line boundary). */
  offset: number;
  firstAt: string;
  lastAt: string;
  role: 'coordinator';
  model: string | null;
  components: UsageComponents;
  /** Main-session assistant messages (API calls) counted. */
  turns: number;
  /** Sum and max of the prompt size per turn (input + cache read + cache write). */
  contextSum: number;
  maxContext: number;
  /** Main-session user turns that start with a `<channel source="telegram"` tag. */
  ownerMessages: number;
  /** Whether the session started with the recovery prompt (null until its first user message is read). */
  recovered: boolean | null;
  /** Tokens a recovered session spent before its first claim or Telegram reply. */
  overhead: number;
  overheadDone: boolean;
  recentIds: string[];
  ended?: { at: string; trigger: SessionEndTrigger; detail?: string };
}

export const totalOf = (c: UsageComponents) => c.input + c.cacheRead + c.cacheWrite + c.output;
const zero = (): UsageComponents => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

export function newSessionState(sessionId: string, path: string, now: Date, model: string | null = null): CoordinatorSessionState {
  const at = now.toISOString();
  return { version: 1, sessionId, path, offset: 0, firstAt: at, lastAt: at, role: 'coordinator', model, components: zero(), turns: 0, contextSum: 0, maxContext: 0, ownerMessages: 0, recovered: null, overhead: 0, overheadDone: false, recentIds: [] };
}

// ---------------------------------------------------------------- parsing

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (u: Record<string, unknown>, k: string) => (typeof u[k] === 'number' && Number.isFinite(u[k]) && (u[k] as number) > 0 ? Math.round(u[k] as number) : 0);

const OWNER_TAG = /^\s*<channel\s+source="telegram"/;
const RECOVER_PREFIX = /^\s*\/minions:recover\b/;
/** A claim or a Telegram reply ends a recovered session's reset overhead. */
const CLAIM_CMD = /\bminions\s+work\s+claim\b/;
const isReplyTool = (name: string) => /telegram/i.test(name) && /__reply$/.test(name);

/** Text of a user message: the string content, or its text blocks (tool results are not user turns). */
function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => isObj(b) && b.type === 'tool_result')) return null;
  const t = content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as { text: string }).text);
  return t.length ? t.join('\n') : null;
}

function hasAction(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => isObj(b) && b.type === 'tool_use' && (
    (typeof b.name === 'string' && isReplyTool(b.name)) ||
    (b.name === 'Bash' && isObj(b.input) && typeof b.input.command === 'string' && CLAIM_CMD.test(b.input.command))));
}

type Item = { kind: 'user'; text: string } | { kind: 'assistant'; id: string | null; usage: UsageComponents; model: string | null; action: boolean };

/**
 * Folds complete transcript lines into the session state (mutates and returns it). Lines that do not
 * parse are skipped; the caller passes only whole lines.
 */
export function foldTranscriptLines(state: CoordinatorSessionState, text: string): CoordinatorSessionState {
  const items: Item[] = [];
  const byId = new Map<string, Item & { kind: 'assistant' }>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; }
    if (!isObj(v) || v.isSidechain === true) continue;
    const msg = isObj(v.message) ? v.message : null;
    if (!msg) continue;
    if (v.type === 'user') {
      const t = userText(msg.content);
      if (t !== null) items.push({ kind: 'user', text: t });
      continue;
    }
    if (v.type !== 'assistant' || !isObj(msg.usage)) continue;
    const u = msg.usage;
    const usage = { input: num(u, 'input_tokens'), cacheRead: num(u, 'cache_read_input_tokens'), cacheWrite: num(u, 'cache_creation_input_tokens'), output: num(u, 'output_tokens') };
    const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
    const model = typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<') ? msg.model : null;
    const action = hasAction(msg.content);
    const prev = id ? byId.get(id) : undefined;
    if (prev) {
      // Same message, another content block: the usage repeats (output may grow); keep the largest of each.
      for (const k of Object.keys(usage) as (keyof UsageComponents)[]) prev.usage[k] = Math.max(prev.usage[k], usage[k]);
      prev.action ||= action;
      prev.model ??= model;
      continue;
    }
    const item = { kind: 'assistant' as const, id, usage, model, action };
    if (id) byId.set(id, item);
    items.push(item);
  }
  const seen = new Set(state.recentIds);
  for (const it of items) {
    if (it.kind === 'user') {
      if (state.recovered === null) state.recovered = RECOVER_PREFIX.test(it.text);
      if (OWNER_TAG.test(it.text)) state.ownerMessages++;
      continue;
    }
    if (it.id && seen.has(it.id)) continue;
    const total = totalOf(it.usage);
    if (total === 0) continue;
    if (it.id) { seen.add(it.id); state.recentIds.push(it.id); }
    const c = state.components;
    c.input += it.usage.input; c.cacheRead += it.usage.cacheRead; c.cacheWrite += it.usage.cacheWrite; c.output += it.usage.output;
    state.turns++;
    const ctx = it.usage.input + it.usage.cacheRead + it.usage.cacheWrite;
    state.contextSum += ctx;
    state.maxContext = Math.max(state.maxContext, ctx);
    if (it.model) state.model = it.model;
    if (state.recovered && !state.overheadDone) {
      if (it.action) state.overheadDone = true;
      else state.overhead += total;
    }
  }
  if (state.recentIds.length > RECENT_IDS) state.recentIds = state.recentIds.slice(-RECENT_IDS);
  return state;
}

export interface ReadLimits { maxBytes?: number }

/**
 * Reads the transcript from `state.offset`, at most `maxBytes` (one chunk, so the time is bounded), and
 * folds the complete lines in. A last line without its newline (still being written, or cut off) is not
 * consumed. Returns whether the offset moved and whether more bytes remain. Never throws: a missing file
 * leaves the state as it was. A file shorter than the offset is not re-read (never count a transcript twice).
 */
export function readIncrement(state: CoordinatorSessionState, limits: ReadLimits = {}): { advanced: boolean; more: boolean; missing: boolean } {
  const maxBytes = Math.max(1, limits.maxBytes ?? MAX_READ_BYTES);
  let fd: number | undefined;
  try {
    fd = openSync(state.path, 'r');
    const size = fstatSync(fd).size;
    if (state.offset >= size) return { advanced: false, more: false, missing: false };
    const len = Math.min(size - state.offset, maxBytes);
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, state.offset);
    const nl = buf.subarray(0, got).lastIndexOf(0x0a);
    // No complete line in the chunk: a truncated tail (wait for the next read), or a single line longer
    // than maxBytes (skipped: the offset moves past it so the read never stalls on it).
    if (nl < 0) {
      if (len < size - state.offset) { state.offset += len; return { advanced: true, more: true, missing: false }; }
      return { advanced: false, more: false, missing: false };
    }
    foldTranscriptLines(state, buf.subarray(0, nl + 1).toString('utf8'));
    state.offset += nl + 1;
    return { advanced: true, more: state.offset < size, missing: false };
  } catch {
    return { advanced: false, more: false, missing: true };
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- storage

export function readSessionState(db: Pick<RuntimeDb, 'getMeta'>, sessionId: string): CoordinatorSessionState | null {
  try {
    const v = db.getMeta(USAGE_META_PREFIX + sessionId);
    const s = v ? JSON.parse(v) as CoordinatorSessionState : null;
    return s && s.version === 1 && typeof s.offset === 'number' && isObj(s.components) ? s : null;
  } catch { return null; }
}

export function sessionStates(db: Pick<RuntimeDb, 'all'>): CoordinatorSessionState[] {
  const out: CoordinatorSessionState[] = [];
  for (const r of db.all<{ value: string }>('SELECT value FROM meta WHERE key LIKE ? ORDER BY key', `${USAGE_META_PREFIX}%`)) {
    try {
      const s = JSON.parse(r.value) as CoordinatorSessionState;
      if (s && s.version === 1 && isObj(s.components)) out.push(s);
    } catch { /* corrupt row: skipped */ }
  }
  return out.sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0));
}

type UsageDb = Pick<RuntimeDb, 'getMeta' | 'setMeta' | 'addEvent' | 'all'>;

/** Stores the state and, when the totals changed, the cumulative `usage` event (key `session:<id>`). */
function persist(db: UsageDb, s: CoordinatorSessionState, changed: boolean): void {
  db.setMeta(USAGE_META_PREFIX + s.sessionId, JSON.stringify(s));
  if (!changed) return;
  db.addEvent('usage', null, {
    key: `session:${s.sessionId}`, scope: 'session', session: s.sessionId, role: s.role,
    tokens: totalOf(s.components), model: s.model, source: 'transcript',
    components: { ...s.components }, turns: s.turns, maxContext: s.maxContext, ownerMessages: s.ownerMessages,
  });
}

export interface TrackDeps {
  db: UsageDb & Pick<RuntimeDb, 'coordinatorLock'>;
  config?: Pick<MinionsConfig, 'models'>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  limits?: ReadLimits;
}

/**
 * The Stop hook's step: only for the main coordinator session (no `agent_id`/`agent_type`, not a process
 * worker, a coordinator lock held). Never throws.
 */
export function trackCoordinatorUsage(deps: TrackDeps, input: Record<string, unknown>): { recorded: boolean; reason: string } {
  try {
    const env = deps.env ?? process.env;
    if (input.agent_id !== undefined && input.agent_id !== null) return { recorded: false, reason: 'subagent' };
    if (input.agent_type !== undefined && input.agent_type !== null) return { recorded: false, reason: 'subagent' };
    if (env.MINIONS_ROLE) return { recorded: false, reason: 'worker process' };
    const path = input.transcript_path;
    const sessionId = input.session_id;
    if (typeof path !== 'string' || !path.endsWith('.jsonl') || typeof sessionId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(sessionId)) return { recorded: false, reason: 'no transcript' };
    if (!deps.db.coordinatorLock()) return { recorded: false, reason: 'no coordinator lock' };
    const now = deps.now ?? new Date();
    let s = readSessionState(deps.db, sessionId);
    const fresh = !s;
    if (!s || s.path !== path) {
      // A new session (or the same id on another file: start that file from the beginning, keep the totals).
      s = s ? { ...s, path, offset: 0 } : newSessionState(sessionId, path, now, deps.config?.models.coordinator ?? null);
    }
    if (s.ended) delete s.ended; // resumed after it was completed
    const before = totalOf(s.components);
    const r = readIncrement(s, deps.limits);
    s.lastAt = now.toISOString();
    persist(deps.db, s, totalOf(s.components) !== before);
    // A new session: the previous one ended; complete it now if the next start did not.
    if (fresh) completeOpenSessions({ ...deps, except: sessionId });
    return { recorded: true, reason: r.missing ? 'transcript missing' : `turns ${s.turns}, ${totalOf(s.components)} tokens${r.more ? ' (more to read)' : ''}` };
  } catch (e) {
    return { recorded: false, reason: `error: ${(e as Error).message}` };
  }
}

interface RestartInfo { at?: string; reason?: string }
const parse = <T>(v: string | undefined): T | null => { try { return v ? JSON.parse(v) as T : null; } catch { return null; } };

/** Why a session ended: the self-reset request, else a recorded restart, else it just exited (crash, stop, quit). */
function endTrigger(db: UsageDb, s: CoordinatorSessionState): { trigger: SessionEndTrigger; detail?: string } {
  const req = parse<{ at?: string; triggers?: string[] }>(db.getMeta(RESET_REQUEST_META));
  if (req?.at && req.at >= s.firstAt) return { trigger: 'context-reset', detail: req.triggers?.length ? req.triggers.join(',') : 'requested' };
  const restart = parse<RestartInfo>(db.getMeta('coordinator_restart'));
  if (restart?.at && restart.at >= s.firstAt) return { trigger: 'restart', ...(restart.reason ? { detail: restart.reason.slice(0, 200) } : {}) };
  return { trigger: 'exit' };
}

/**
 * Completes every session not marked ended (except `except`): reads what is left of its transcript and
 * marks it ended with its trigger. Runs at coordinator start and when a Stop hook sees a new session.
 */
export function completeOpenSessions(deps: Omit<TrackDeps, 'env'> & { except?: string }): { completed: string[] } {
  const completed: string[] = [];
  try {
    const now = deps.now ?? new Date();
    for (const s of sessionStates(deps.db)) {
      if (s.ended || s.sessionId === deps.except) continue;
      const before = totalOf(s.components);
      // Up to a few chunks: the remainder of one session is small.
      for (let i = 0; i < 8; i++) { const r = readIncrement(s, deps.limits); if (!r.more || !r.advanced) break; }
      s.ended = { at: now.toISOString(), ...endTrigger(deps.db, s) };
      persist(deps.db, s, totalOf(s.components) !== before);
      completed.push(s.sessionId);
    }
  } catch { /* best-effort */ }
  return { completed };
}

/** `coordinator restart --detach` (the self-reset) records which triggers held, so the ended session says why. */
export function noteResetRequest(db: Pick<RuntimeDb, 'setMeta'>, triggers: string[], now: Date = new Date()): void {
  try { db.setMeta(RESET_REQUEST_META, JSON.stringify({ at: now.toISOString(), triggers })); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------- weighting

/** Price multipliers relative to the model's input rate (Anthropic pricing: cache read 0.1x, cache write 1.25x, output 5x). */
export const WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const;

export function weightedMTok(c: UsageComponents): number {
  return (c.input * WEIGHTS.input + c.cacheRead * WEIGHTS.cacheRead + c.cacheWrite * WEIGHTS.cacheWrite + c.output * WEIGHTS.output) / 1e6;
}
