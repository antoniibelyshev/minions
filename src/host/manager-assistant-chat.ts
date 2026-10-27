// The host manager's natural-language assistant, part 4: the chat (docs/design/host-manager-assistant.md,
// "Conversation state", "Failure and fallback", "Trust boundary"; task-65.4). The Telegram transport hands it the
// owner's plain text (never a slash command) and runs it off the poll loop; this module builds the context bundle,
// makes the one call (manager-assistant.ts), reads the answer (manager-assistant-proposal.ts) and replies.
//
// - Order: the labelled reply first ("Assistant: ", plain text, cut to 1,500 characters), then, for a valid proposal,
//   the host offer: ManagerCommands.propose with `via: 'assistant'` builds and journals the plan like a typed command,
//   and the transport shows it with Confirm / Reject (twice for a plan that loosens policy, unchanged). The model's
//   text is never acted on; an invalid proposal is reported and nothing is planned.
// - Every failure of the call path gets one reply, `Assistant unavailable (<reason>). Commands:` and the help text:
//   switched off, not set up, no token, no or an unsuitable `claude`, the daily limit (said once a day; later
//   messages that day get the command list only), a timeout, a non-zero exit, output over the cap, output that is not
//   the expected JSON, an auth error. Nothing is retried and no second strategy is tried.
// - Conversation state is in memory only, for the paired owner chat: at most 6 exchanges and 8 KiB, cleared after
//   30 minutes without a message, on /project, on /assistant off and when the manager restarts (a new process).
// - assistant-usage.json (manager-assistant.ts) holds the calls of the UTC day and the last error, for the daily
//   limit, /assistant status, /status, `minions status` and doctor. /assistant on|off writes assistant.json.
// - /assistant status and the /status line read only local files and what this process already knows: no claude run
//   and no secret store access happen on the poll loop.
import { displayText, truncateCodePoints } from '../core/control-chars.js';
import { redact } from '../core/output.js';
import { readJournal as defaultReadJournal, type JournalEntry } from './change-journal.js';
import {
  ASSISTANT_TIMEOUT_MS, loadAssistantConfig, loadAssistantUsage, saveAssistantConfig, saveAssistantUsage, usageDay,
  type AssistantConfig, type AssistantFailure, type AssistantOutcome, type AssistantUsage, type ManagerAssistant,
} from './manager-assistant.js';
import {
  assistantHelpLines, buildContextBundle, formatAssistantInput, HISTORY_MAX_BYTES, loadSystemPrompt as defaultLoadSystemPrompt, OWNER_TEXT_MAX,
  undoCandidates, type ContextBundle, type HistoryExchange,
} from './manager-assistant-context.js';
import { ANSWER_JSON_SCHEMA, parseAssistantAnswer } from './manager-assistant-proposal.js';
import { ManagerNotice } from './manager-notice.js';
import { fallbackText, helpText } from './manager-telegram.js';
import type { ManagerCommands, ManagerOffer, OwnerCommand } from './manager.js';
import type { SettingView } from './settings.js';

export { fallbackText };

/** Exchanges kept in memory. */
export const HISTORY_MAX_EXCHANGES = 6;
/** The history is cleared after this long without an owner message to the assistant. */
export const HISTORY_IDLE_MS = 30 * 60_000;
/** The assistant's reply as shown in the chat (characters, before the label). */
export const REPLY_SHOWN_MAX = 1500;
/** The fixed label every assistant reply starts with. */
export const REPLY_LABEL = 'Assistant: ';
/** A hard bound on one call beyond the runner's own timeout (the runner kills the child at ASSISTANT_TIMEOUT_MS). */
export const CALL_DEADLINE_MS = ASSISTANT_TIMEOUT_MS + 15_000;

const oneLine = (s: string, max: number) => {
  const t = displayText(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${truncateCodePoints(t, max - 1)}…` : t;
};
const short = (e: unknown, max = 200) => oneLine(redact(String((e as Error)?.message ?? e)), max);

/** The labelled reply: plain, one fixed label, at most REPLY_SHOWN_MAX characters of the model's text. */
export function labelledReply(reply: string): string {
  const t = displayText(reply).trim();
  return `${REPLY_LABEL}${t.length > REPLY_SHOWN_MAX ? `${truncateCodePoints(t, REPLY_SHOWN_MAX - 1)}…` : t}`;
}

/** The typed command name of a proposal, for the host's usual `/<cmd> failed: <reason>` line. */
const commandName = (c: OwnerCommand) => (c.kind === 'config-set' ? 'set' : c.kind === 'rebuild-cli' ? 'rebuild_cli' : c.kind);

/** What the chat needs from the transport for one message. */
export interface ChatIO {
  /** Plain text to the owner (no parse_mode, link previews off). */
  send(text: string): Promise<void>;
  /** The host offer message with Confirm / Reject (the transport's sendOffer: double tap for a loosening plan). */
  sendOffer(offer: ManagerOffer): Promise<void>;
  commands: ManagerCommands;
  /** The project picked with /project (null: none). */
  selected: string | null;
  /** Whether the help text lists the dev-only /rebuild_cli. */
  devRebuild: boolean;
}

/** The chat side the transport calls (manager-telegram.ts depends on this shape only). */
export interface AssistantChatPort {
  /** One plain-text owner message. Never throws; the transport runs it off the poll loop. */
  handle(text: string, io: ChatIO): Promise<void>;
  /** `/assistant [on|off|status]`: the reply text. Never calls the model. */
  command(arg: string): Promise<string>;
  /** One line for the chat /status. Local files only. */
  statusLine(): Promise<string>;
  /** /project picked another project: the history belongs to the old context. */
  clearHistory(): void;
  /** The host outcome of an offer, for the history entry of the proposal it came from. */
  noteOutcome(requestId: string | null, status: string): void;
}

export interface AssistantChatDeps {
  assistant: ManagerAssistant;
  now?: () => Date;
  log?: (line: string) => void;
  loadSystemPrompt?: () => Promise<string>;
  readJournal?: () => Promise<JournalEntry[]>;
  loadConfig?: () => Promise<AssistantConfig | null>;
  saveConfig?: (c: AssistantConfig) => Promise<void>;
  loadUsage?: (now: Date) => Promise<AssistantUsage>;
  saveUsage?: (u: AssistantUsage) => Promise<void>;
  /** The hard bound on one call (default CALL_DEADLINE_MS). */
  deadlineMs?: number;
}

/** One remembered exchange (HistoryExchange plus the offer it led to, for its outcome). */
interface Exchange extends HistoryExchange { requestId: string | null }

/** Reasons of an assistant that is off on purpose: a fallback, but not an error worth recording. */
const notAnError = (reason: string) => reason === 'switched off' || reason.startsWith('not set up');

export class AssistantChat implements AssistantChatPort {
  private history: Exchange[] = [];
  private lastAt: number | null = null;
  /** Bumped by every clear, so an answer that arrives after a clear is not added to the new conversation. */
  private generation = 0;
  /** Why the assistant was last unavailable in this process (shown by /assistant status; no claude run there). */
  private lastUnavailable: string | null = null;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: AssistantChatDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  /** The history as the next call would see it (tests). */
  exchanges(): readonly HistoryExchange[] {
    this.expireIdle(this.now());
    return this.history.map(({ requestId: _r, ...h }) => h);
  }

  clearHistory(): void {
    this.history = [];
    this.lastAt = null;
    this.generation++;
  }

  noteOutcome(requestId: string | null, status: string): void {
    if (!requestId) return;
    const e = this.history.find((x) => x.requestId === requestId);
    // Only the host's status word: the outcome text can hold host paths and runtime text.
    if (e) e.outcome = /^[a-z-]{1,20}$/.test(status) ? status : 'unknown';
  }

  private expireIdle(now: Date): void {
    if (this.lastAt !== null && now.getTime() - this.lastAt > HISTORY_IDLE_MS) this.clearHistory();
  }

  private remember(e: Exchange, generation: number): void {
    if (generation !== this.generation) return;
    this.history.push(e);
    while (this.history.length > HISTORY_MAX_EXCHANGES) this.history.shift();
    while (this.history.length && Buffer.byteLength(JSON.stringify(this.history.map(({ requestId: _r, ...h }) => h))) > HISTORY_MAX_BYTES) this.history.shift();
  }

  private loadUsage(now: Date): Promise<AssistantUsage> { return (this.deps.loadUsage ?? loadAssistantUsage)(now); }

  private async saveUsage(u: AssistantUsage): Promise<void> {
    try { await (this.deps.saveUsage ?? saveAssistantUsage)(u); } catch (e) { this.log(`assistant: saving the usage failed: ${short(e)}`); }
  }

  private async recordError(failure: AssistantFailure | 'prepare', reason: string, now: Date): Promise<void> {
    const u = await this.loadUsage(now);
    await this.saveUsage({ ...u, lastError: { at: now.toISOString(), failure, reason: oneLine(reason, 400) } });
    this.log(`assistant: ${failure}: ${oneLine(reason, 300)}`);
  }

  /** The context bundle: host data only (only the named fields of the inputs are read; see buildContextBundle). */
  private async bundle(io: ChatIO): Promise<ContextBundle> {
    const projects = await io.commands.projects();
    const target = io.selected ?? (projects.length === 1 ? projects[0]!.projectId : null);
    let settings: SettingView[] = [];
    if (target && io.commands.settings) {
      try { settings = (await io.commands.settings(target)).settings; } catch (e) { this.log(`assistant: no settings for the bundle: ${short(e)}`); }
    }
    const status = target && io.commands.assistantStatus ? await io.commands.assistantStatus(target).catch(() => null) : null;
    // The host's own offer summaries (planSummary of the journaled plan); nonce, digest, plan text and reason stay out.
    const pending = target ? (await io.commands.pending(target).catch((): ManagerOffer[] => [])).map((o) => ({
      requestId: o.requestId, kind: o.kind, summary: o.summary, expiresAt: o.expiresAt, loosens: o.loosens,
    })) : [];
    const undo = target ? undoCandidates(await (this.deps.readJournal ?? defaultReadJournal)().catch((): JournalEntry[] => []), target) : [];
    return buildContextBundle({
      settings, help: assistantHelpLines(io.devRebuild), status, pending, undo,
      projects: projects.map((p) => ({ name: p.name, selected: p.projectId === target })),
    });
  }

  /** One call, bounded here too: a runner that ignores its timeout cannot hold the chat. */
  private async ask(o: { systemPrompt: string; input: string }): Promise<AssistantOutcome> {
    const ms = this.deps.deadlineMs ?? CALL_DEADLINE_MS;
    const ctl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<AssistantOutcome>((resolve) => {
      timer = setTimeout(() => { ctl.abort(); resolve({ ok: false, failure: 'timeout', reason: `no answer within ${Math.ceil(ms / 1000)} s` }); }, ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        this.deps.assistant.ask({ ...o, jsonSchema: ANSWER_JSON_SCHEMA, signal: ctl.signal })
          .catch((e): AssistantOutcome => ({ ok: false, failure: 'error', reason: `the call failed: ${short(e)}` })),
        deadline,
      ]);
    } finally { clearTimeout(timer); }
  }

  async handle(text: string, io: ChatIO): Promise<void> {
    try { await this.handleInner(text, io); } catch (e) {
      this.log(`assistant: handling a message failed: ${short(e)}`);
      try { await io.send(fallbackText(`internal error: ${short(e, 120)}`, io.devRebuild)); } catch { /* the transport logs it */ }
    }
  }

  private async handleInner(text: string, io: ChatIO): Promise<void> {
    const now = this.now();
    this.expireIdle(now);
    this.lastAt = now.getTime();
    const generation = this.generation;
    const fallback = (reason: string) => io.send(fallbackText(reason, io.devRebuild));

    const a = await this.deps.assistant.availability();
    if (!a.available) {
      this.lastUnavailable = a.reason;
      if (!notAnError(a.reason)) await this.recordError('unavailable', a.reason, now);
      await fallback(a.reason);
      return;
    }
    this.lastUnavailable = null;
    const usage = await this.loadUsage(now);
    if (usage.calls >= a.config.dailyLimit) {
      const day = usageDay(now);
      if (usage.limitNoticeDay === day) { await io.send(helpText(io.devRebuild)); return; }
      await this.saveUsage({ ...usage, limitNoticeDay: day });
      await fallback(`the daily limit of ${a.config.dailyLimit} calls is reached; it resets at 00:00 UTC`);
      return;
    }

    let input: string;
    let systemPrompt: string;
    try {
      systemPrompt = await (this.deps.loadSystemPrompt ?? defaultLoadSystemPrompt)();
      input = formatAssistantInput({ bundle: await this.bundle(io), history: this.exchanges().slice(), message: text });
    } catch (e) {
      const reason = `the request could not be prepared: ${short(e, 160)}`;
      await this.recordError('prepare', reason, now);
      await fallback(reason);
      return;
    }

    const out = await this.ask({ systemPrompt, input });
    // A call that never spawned (no token, too much input) does not count against the limit.
    if (out.ok || (out.failure !== 'unavailable' && out.failure !== 'input-too-large')) {
      const u = await this.loadUsage(now);
      await this.saveUsage({ ...u, calls: u.calls + 1 });
    }
    if (!out.ok) {
      if (out.failure === 'unavailable') this.lastUnavailable = out.reason;
      await this.recordError(out.failure, out.reason, now);
      await fallback(out.reason);
      return;
    }
    const answer = parseAssistantAnswer(out);
    if (!answer.reply) {
      const reason = 'the answer had no reply text';
      await this.recordError('invalid-json', reason, now);
      await fallback(reason);
      return;
    }

    // The reply first, labelled; then the host's own messages.
    const shown = labelledReply(answer.reply);
    await io.send(shown);
    const ex: Exchange = { owner: truncateCodePoints(text, OWNER_TEXT_MAX), assistant: shown.slice(REPLY_LABEL.length), proposal: null, outcome: null, requestId: null };
    if (answer.invalid) {
      await io.send(`The assistant's proposal was invalid (${oneLine(answer.invalid, 200)}); nothing was planned.`);
      ex.outcome = 'invalid proposal, nothing planned';
    } else if (answer.command) {
      const c = answer.command;
      const cmd = commandName(c);
      try {
        if (c.kind === 'upgrade' || c.kind === 'sync') await io.send(`Planning /${cmd} (a dry run on the host)…`);
        const offer = await io.commands.propose(io.selected, c, { via: 'assistant' });
        await io.sendOffer(offer);
        ex.proposal = offer.summary;
        ex.requestId = offer.requestId;
        ex.outcome = 'offered, waiting for Confirm';
      } catch (e) {
        if (e instanceof ManagerNotice) {
          await io.send(displayText(e.message));
          ex.outcome = 'not planned: already in effect';
        } else {
          await io.send(`/${cmd} failed: ${displayText(redact((e as Error).message))}`);
          ex.outcome = 'not planned: the host refused it';
        }
      }
    }
    this.remember(ex, generation);
  }

  async command(arg: string): Promise<string> {
    const a = arg.trim().toLowerCase();
    if (a === '' || a === 'status') return this.statusText();
    if (a !== 'on' && a !== 'off') return 'Usage: /assistant [on|off|status]. on / off switch the plain-language assistant (writes assistant.json on the host); status shows it.';
    let cfg: AssistantConfig | null;
    try { cfg = await (this.deps.loadConfig ?? loadAssistantConfig)(); } catch (e) { return `/assistant ${a} failed: assistant.json is unreadable (${short(e, 160)}); fix it with \`minions setup\` on the host.`; }
    if (a === 'off') this.clearHistory();
    if (!cfg) return a === 'off' ? 'The assistant is not set up, so it is off.' : 'The assistant is not set up: run `minions setup` in a terminal on the host (host manager step) to store its Claude token, then /assistant on.';
    if (a === 'off') {
      if (cfg.enabled) await (this.deps.saveConfig ?? saveAssistantConfig)({ ...cfg, enabled: false });
      return `Assistant ${cfg.enabled ? 'switched' : 'is already'} off: plain text gets the command list. The conversation history was cleared. /assistant on switches it back on.`;
    }
    if (!cfg.enabled) await (this.deps.saveConfig ?? saveAssistantConfig)({ ...cfg, enabled: true });
    this.lastUnavailable = null;
    return [`Assistant ${cfg.enabled ? 'is already' : 'switched'} on: write to me in plain language. Slash commands keep working, and nothing applies until you tap Confirm on the host plan.`, await this.statusText()].join('\n');
  }

  async statusLine(): Promise<string> {
    let cfg: AssistantConfig | null;
    try { cfg = await (this.deps.loadConfig ?? loadAssistantConfig)(); } catch (e) { return `assistant: assistant.json is unreadable (${short(e, 120)})`; }
    if (!cfg) return 'assistant: not set up (optional: `minions setup` on the host)';
    const u = await this.loadUsage(this.now());
    return [
      `assistant: ${cfg.enabled ? 'on' : 'off'} (${cfg.model}), ${u.calls} of ${cfg.dailyLimit} calls today`,
      ...(cfg.enabled && this.lastUnavailable ? [`, unavailable: ${oneLine(this.lastUnavailable, 200)}`] : []),
      ...(u.lastError ? [`; last error ${u.lastError.at}: ${oneLine(u.lastError.reason, 200)}`] : []),
    ].join('');
  }

  private async statusText(): Promise<string> {
    const line = await this.statusLine();
    const n = this.exchanges().length;
    return [
      line.replace(/^assistant:/, 'Assistant:'),
      `Conversation: ${n} exchange${n === 1 ? '' : 's'} in memory (at most ${HISTORY_MAX_EXCHANGES}; cleared after ${HISTORY_IDLE_MS / 60_000} minutes without a message, on /project and on /assistant off).`,
      'The daily limit resets at 00:00 UTC. /assistant on|off switches it; the model, the token and the limit are set with `minions setup` on the host.',
    ].join('\n');
  }
}

export function createAssistantChat(deps: AssistantChatDeps): AssistantChat {
  return new AssistantChat(deps);
}
