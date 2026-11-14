// The host publisher (docs/design/autonomy.md Decision 17): one trusted process per machine that asks the owner, through
// a Telegram bot of its own, whether to publish what a coordinator proposed, and then pushes it (src/host/publish.ts).
//
// Why an agent cannot forge an approval:
// - The bot token is host-only (PUBLISHER_CREDENTIAL in credentials.ts: Keychain / Secret Service / a 0600 file under
//   the credential store), never materialized into a project's secrets, never mounted, and under the host runtime's
//   sandbox read deny. Only this process polls the bot, so only it sees the button presses.
// - A press counts only from the owner (`telegram.owner` in `minions defaults`, a numeric user id Telegram itself puts
//   on every update) in the owner's private chat. Anything else is dropped without a reply. Forwarded messages never
//   count as commands.
// - The buttons carry only a random nonce. The nonce maps to a prompt this process stored (state.json, 0600, under the
//   data root): project, base, the exact SHA, the mode and the commit count, all computed here from git when the prompt
//   was sent. The push uses that record, never the request row again, so a request edited after the prompt cannot
//   change what is pushed. A newer request supersedes the prompt (its buttons stop working).
// - Requests are only proposals: `settings requests publish` in the runtime records one, and anything it says (the
//   summary, task ids) is shown as the coordinator's words. Commit count, base and SHA come from git.
//
// Commands to the bot (owner only): /publish <project> (ask now for the agents' current base), /publish (list the
// projects), /help. The loop polls the projects' open publish requests every POLL_REQUESTS_MS between long polls.
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import { displayText } from '../core/control-chars.js';
import { MinionsError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { ensureDir, readJsonIfExists, writeJson } from '../core/fsutil.js';
import { redact } from '../core/output.js';
import { publisherPaths } from '../core/paths.js';
import { inMinionsContainer } from '../runtime/paths.js';
import { publishPayloadOf, quotedReason, type ChangeRequestView } from '../runtime/change-requests.js';
import { BotApi, OffsetFile, isForwarded, nextOffset, oneLine, retryAfterMs, type Fetch, type InlineKeyboard, type TelegramUpdate } from '../telegram/bot-api.js';
import { loadDefaults } from './auth.js';
import { readPublisherToken } from './credentials.js';
import { HOST_GIT } from './discovery.js';
import { Compose } from './docker.js';
import { loadEffectiveConfig, loadProjectJson, type ProjectJson } from './project.js';
import { authHint, planPublish, publishCommit, publishEnv, pushAuthFacts, remoteUrlOf, type PublishMode, type PublishPlan, type PublishResult } from './publish.js';
import { cliChangeWatcher, PUBLISHER_RESTART_EXIT_CODE, takePublisherLock, writeHeartbeat, type Heartbeat } from './publisher-service.js';
import { loadRegistry } from './registry.js';
import { HostRuntime, prepareHostRuntime, runtimeOf } from './runtime.js';
import { exportRepo, parseEnvelope } from './transfer.js';

/** How often the open publish requests of every project are read (between long polls). */
export const POLL_REQUESTS_MS = 60_000;
/** Long-poll seconds per getUpdates call. */
export const LONG_POLL_SECS = 25;
/** A prompt nobody answered is dropped (its buttons answer "expired") after this long. */
export const PROMPT_TTL_MS = 7 * 24 * 60 * 60_000;

const NONCE = /^[0-9a-f]{24}$/;
export const callbackData = (action: 'pub' | 'not', nonce: string) => `${action}:${nonce}`;
export function parseCallback(data: unknown): { action: 'pub' | 'not'; nonce: string } | null {
  if (typeof data !== 'string') return null;
  const m = /^(pub|not):([0-9a-f]{24})$/.exec(data);
  return m ? { action: m[1] as 'pub' | 'not', nonce: m[2]! } : null;
}

// ---------------------------------------------------------------- state

const PromptSchema = z.object({
  nonce: z.string().regex(NONCE),
  projectId: z.string(),
  /** The runtime request it answers (null: asked by /publish, no request). */
  requestId: z.string().nullable(),
  base: z.string(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  mode: z.enum(['direct', 'pull-request']),
  commits: z.number().int().nonnegative(),
  tasks: z.array(z.string()),
  summary: z.string().nullable(),
  messageId: z.number().int().nullable(),
  askedAt: z.string(),
  /** asked: buttons live; publishing: a press is being handled (a crash leaves it here: never pushed twice). */
  status: z.enum(['asked', 'publishing']),
}).strict();
export type Prompt = z.infer<typeof PromptSchema>;

const StateSchema = z.object({
  version: z.literal(1),
  prompts: z.array(PromptSchema),
  /** Requests already answered or refused here (`<projectId>/<requestId>`), so they are not asked again. */
  handled: z.array(z.string()),
}).strict();
export type PublisherState = z.infer<typeof StateSchema>;

export interface StateStore { load(): Promise<PublisherState>; save(s: PublisherState): Promise<void> }

/** state.json (0600) in the 0700 publisher dir. */
export const fileStateStore: StateStore = {
  load: async () => (await readJsonIfExists(publisherPaths().stateJson, StateSchema).catch(() => undefined)) ?? { version: 1, prompts: [], handled: [] },
  save: async (s) => { await ensureDir(publisherPaths().dir, 0o700); await writeJson(publisherPaths().stateJson, { ...s, handled: s.handled.slice(-500) }, { mode: 0o600 }); },
};

// ---------------------------------------------------------------- per-project operations

export interface PublisherProject { projectId: string; name: string; repoPath: string; baseBranch: string }

/** What the publisher does to a project; the real implementation reaches the runtime and git, tests fake it. */
export interface PublisherOps {
  projects(): Promise<PublisherProject[]>;
  /** Open publish requests (proposed, confirmed, failed), or null when the runtime cannot be reached. */
  requests(p: PublisherProject): Promise<ChangeRequestView[] | null>;
  mark(p: PublisherProject, id: string, status: 'confirmed' | 'applied' | 'failed' | 'rejected', detail: string): Promise<void>;
  /** Exports the agents' refs and plans publishing `sha` (default: the agents' current base head). */
  prepare(p: PublisherProject, sha: string | null): Promise<{ plan: PublishPlan | null; tasks: string[]; error?: string }>;
  mode(p: PublisherProject): Promise<PublishMode>;
  publish(p: PublisherProject, plan: PublishPlan, mode: PublishMode, text: { title: string; body: string }): Promise<PublishResult>;
}

/** The parts of the Bot API the publisher uses (BotApi; faked in tests). */
export interface PublisherBot {
  sendMessage(chatId: number, text: string, o?: { keyboard?: InlineKeyboard }): Promise<number | null>;
  editMessageText(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  answerCallbackQuery(callbackId: string, text: string): Promise<void>;
}

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The question: "Publish N commits (tasks …) to <base> at <short sha>?" plus the facts, the coordinator's words marked as such. */
export function promptText(p: { project: string; base: string; sha: string; commits: number; tasks: string[]; mode: PublishMode; summary: string | null; subjects: string[]; remoteUrl: string | null }): string {
  const tasks = p.tasks.length ? ` (${p.tasks.length === 1 ? 'task' : 'tasks'} ${p.tasks.slice(0, 10).join(', ')}${p.tasks.length > 10 ? ', …' : ''})` : '';
  return [
    `Publish ${plural(p.commits, 'commit')}${tasks} to ${p.base} at ${short(p.sha)}?`,
    '',
    `Project: ${displayText(p.project)}`,
    `Remote: ${displayText(p.remoteUrl ?? '(none)')}`,
    `How: ${p.mode === 'direct' ? `push to ${p.base} (fast-forward)` : 'push a branch and open a pull request'}`,
    `Commit: ${p.sha}`,
    ...(p.summary ? ['', `Coordinator's summary: ${quotedReason(p.summary)}`] : []),
    ...(p.subjects.length ? ['', 'Newest commits:', ...p.subjects.slice(0, 10).map((s) => `- ${oneLine(s, 120)}`), ...(p.commits > 10 ? [`… and ${p.commits - 10} more`] : [])] : []),
  ].join('\n');
}

const keyboard = (nonce: string): InlineKeyboard => [[{ text: 'Publish', callback_data: callbackData('pub', nonce) }, { text: 'Not now', callback_data: callbackData('not', nonce) }]];

export const HELP_TEXT = [
  'minions publisher. I ask before anything of yours is pushed, and push only what you approve.',
  '/publish <project> - ask now about the agents\' current base branch of that project',
  '/publish - list the projects',
  'Publish requests from the coordinators arrive here by themselves.',
].join('\n');

export interface PublisherCoreOptions {
  bot: PublisherBot;
  ownerId: number;
  ops: PublisherOps;
  state?: StateStore;
  now?: () => Date;
  log?: (line: string) => void;
  nonce?: () => string;
}

/** Everything the publisher decides, independent of the transport loop (tests drive it with fake ops and bot). */
export class PublisherCore {
  private readonly state: StateStore;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly nonce: () => string;
  /** Per-project problems of the last pass (heartbeat). */
  readonly lastErrors = new Map<string, string | null>();

  constructor(private readonly o: PublisherCoreOptions) {
    this.state = o.state ?? fileStateStore;
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? (() => undefined);
    this.nonce = o.nonce ?? (() => randomBytes(12).toString('hex'));
  }

  private say(text: string, kb?: InlineKeyboard) { return this.o.bot.sendMessage(this.o.ownerId, text, kb ? { keyboard: kb } : {}); }
  private async edit(messageId: number | null, text: string): Promise<void> {
    if (messageId === null) { await this.say(text); return; }
    await this.o.bot.editMessageText(this.o.ownerId, messageId, text).catch(async () => { await this.say(text); });
  }

  /** One pass over the projects: ask about new publish requests, retire prompts whose request closed. */
  async scan(): Promise<void> {
    const st = await this.state.load();
    const cutoff = this.now().getTime() - PROMPT_TTL_MS;
    st.prompts = st.prompts.filter((p) => Date.parse(p.askedAt) >= cutoff);
    for (const project of await this.o.ops.projects()) {
      try {
        this.lastErrors.set(project.projectId, null);
        await this.scanProject(st, project);
      } catch (e) {
        const msg = redact((e as Error).message ?? String(e)).slice(0, 300);
        this.lastErrors.set(project.projectId, msg);
        this.log(`publisher: ${project.name}: ${msg}`);
      }
      await this.state.save(st);
    }
  }

  private async scanProject(st: PublisherState, project: PublisherProject): Promise<void> {
    const open = await this.o.ops.requests(project);
    if (open === null) return; // runtime down: nothing to read, prompts stay
    const openIds = new Set(open.filter((r) => r.status === 'proposed' || r.status === 'confirmed').map((r) => r.id));
    // A prompt whose request is no longer open (superseded, rejected elsewhere) loses its buttons.
    for (const p of st.prompts.filter((x) => x.projectId === project.projectId && x.requestId && x.status === 'asked' && !openIds.has(x.requestId))) {
      st.prompts = st.prompts.filter((x) => x !== p);
      await this.edit(p.messageId, `${project.name}: publish request ${p.requestId} was superseded or closed; nothing was pushed for ${short(p.sha)}.`);
    }
    for (const r of open.filter((x) => x.kind === 'publish' && x.status === 'proposed')) {
      const key = `${project.projectId}/${r.id}`;
      if (st.handled.includes(key) || st.prompts.some((p) => p.projectId === project.projectId && p.requestId === r.id)) continue;
      const payload = publishPayloadOf(r.payload);
      const refuse = async (detail: string, tell: boolean) => {
        st.handled.push(key);
        await this.o.ops.mark(project, r.id, 'rejected', detail);
        if (tell) await this.say(`${project.name}: not asking about publish request ${r.id}: ${detail}`);
        this.log(`publisher: ${project.name}: ${r.id} rejected: ${detail}`);
      };
      if (!payload) { await refuse('malformed request (base and a full commit SHA are required)', false); continue; }
      if (payload.base !== project.baseBranch) { await refuse(`the request names ${payload.base}, but the project's base branch is ${project.baseBranch}`, false); continue; }
      const prepared = await this.o.ops.prepare(project, payload.sha);
      if (!prepared.plan) { this.lastErrors.set(project.projectId, prepared.error ?? 'could not export the agents\' branches'); continue; } // retried next pass
      const plan = prepared.plan;
      if (plan.refusal) {
        if (plan.refusal.code === 'fetch-failed') { this.lastErrors.set(project.projectId, plan.refusal.message); continue; } // transient
        // A scan finding is reported to the owner: the coordinator alone cannot fix what it may not see as a secret.
        await refuse(plan.refusal.message, plan.refusal.code === 'scan' || plan.refusal.code === 'diverged');
        continue;
      }
      await this.ask(st, project, plan, { requestId: r.id, tasks: payload.tasks, summary: r.reason });
    }
  }

  private async ask(st: PublisherState, project: PublisherProject, plan: PublishPlan, o: { requestId: string | null; tasks: string[]; summary: string | null }): Promise<void> {
    const mode = await this.o.ops.mode(project);
    const nonce = this.nonce();
    const text = promptText({ project: project.name, base: plan.base, sha: plan.sha, commits: plan.commits, tasks: o.tasks, mode, summary: o.summary, subjects: plan.subjects, remoteUrl: plan.remoteUrl });
    const prompt: Prompt = { nonce, projectId: project.projectId, requestId: o.requestId, base: plan.base, sha: plan.sha, mode, commits: plan.commits, tasks: o.tasks,
      summary: o.summary, messageId: null, askedAt: this.now().toISOString(), status: 'asked' };
    // Saved before sending: a press can never arrive for a prompt this process does not know.
    st.prompts = st.prompts.filter((p) => !(p.projectId === project.projectId && p.status === 'asked'));
    st.prompts.push(prompt);
    await this.state.save(st);
    prompt.messageId = await this.say(text, keyboard(nonce));
    this.log(`publisher: ${project.name}: asked about ${plan.sha} (${o.requestId ?? '/publish'})`);
  }

  /** One update from the bot: an owner press or an owner command; everything else is dropped silently. */
  async handleUpdate(u: TelegramUpdate): Promise<void> {
    const cb = u.callback_query;
    if (cb) {
      if (cb.from?.id !== this.o.ownerId || cb.from.is_bot || cb.message?.chat?.id !== this.o.ownerId || typeof cb.id !== 'string') return;
      const parsed = parseCallback(cb.data);
      if (!parsed) return;
      await this.press(cb.id, parsed.action, parsed.nonce);
      return;
    }
    const m = u.message;
    if (!m || m.from?.id !== this.o.ownerId || m.from.is_bot || m.chat?.id !== this.o.ownerId || m.chat.type !== 'private' || isForwarded(m)) return;
    const text = (m.text ?? '').trim();
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(text);
    if (cmd && cmd[1]!.toLowerCase() === 'publish') { await this.publishCommand((cmd[2] ?? '').trim()); return; }
    await this.say(HELP_TEXT);
  }

  private async press(callbackId: string, action: 'pub' | 'not', nonce: string): Promise<void> {
    const st = await this.state.load();
    const prompt = st.prompts.find((p) => p.nonce === nonce);
    if (!prompt) { await this.o.bot.answerCallbackQuery(callbackId, 'This question expired or was superseded; nothing was pushed.'); return; }
    if (prompt.status !== 'asked') { await this.o.bot.answerCallbackQuery(callbackId, 'Already being handled.'); return; }
    const project = (await this.o.ops.projects()).find((p) => p.projectId === prompt.projectId);
    const name = project?.name ?? prompt.projectId;
    const key = prompt.requestId ? `${prompt.projectId}/${prompt.requestId}` : null;
    const done = async (text: string) => {
      const s = await this.state.load();
      s.prompts = s.prompts.filter((p) => p.nonce !== nonce);
      if (key && !s.handled.includes(key)) s.handled.push(key);
      await this.state.save(s);
      await this.edit(prompt.messageId, text);
    };
    if (action === 'not') {
      await this.o.bot.answerCallbackQuery(callbackId, 'Not published.');
      if (project && prompt.requestId) await this.o.ops.mark(project, prompt.requestId, 'rejected', 'the owner chose "Not now" in Telegram').catch(() => undefined);
      await done(`${name}: not published (${short(prompt.sha)} to ${prompt.base}). The coordinator can ask again later.`);
      return;
    }
    if (!project) { await this.o.bot.answerCallbackQuery(callbackId, 'That project is no longer registered.'); await done(`${name}: not published (the project is no longer registered).`); return; }
    prompt.status = 'publishing';
    await this.state.save(st);
    await this.o.bot.answerCallbackQuery(callbackId, `Publishing ${short(prompt.sha)}…`);
    await this.edit(prompt.messageId, `${name}: publishing ${plural(prompt.commits, 'commit')} to ${prompt.base} at ${short(prompt.sha)}…`);
    let confirmed = false;
    const fail = async (status: 'failed' | 'rejected', why: string) => {
      // A confirmed request can only end applied or failed.
      if (prompt.requestId) await this.o.ops.mark(project, prompt.requestId, confirmed ? 'failed' : status, why).catch(() => undefined);
      await done(`${name}: NOT published (${short(prompt.sha)} to ${prompt.base}): ${why}`);
    };
    try {
      if (prompt.requestId) {
        const open = await this.o.ops.requests(project);
        const r = open?.find((x) => x.id === prompt.requestId);
        if (!r || (r.status !== 'proposed' && r.status !== 'confirmed')) { await fail('rejected', 'the request was superseded or closed before the press'); return; }
        await this.o.ops.mark(project, prompt.requestId, 'confirmed', `approved by the owner in Telegram for ${prompt.sha}`);
        confirmed = true;
      }
      // Re-checked with the SHA the owner saw: origin may have moved, or the range changed meaning since the prompt.
      const prepared = await this.o.ops.prepare(project, prompt.sha);
      if (!prepared.plan) { await fail('failed', prepared.error ?? 'could not export the agents\' branches'); return; }
      if (prepared.plan.refusal) { await fail(prepared.plan.refusal.code === 'up-to-date' ? 'rejected' : 'failed', prepared.plan.refusal.message); return; }
      if (prepared.plan.sha !== prompt.sha || prepared.plan.base !== prompt.base) { await fail('failed', 'the checked commit differs from the approved one'); return; }
      const title = `${prompt.summary ? oneLine(prompt.summary, 100) : `Publish ${plural(prepared.plan.commits, 'commit')} to ${prompt.base}`}`;
      const body = [prompt.summary ?? '', prompt.tasks.length ? `Tasks: ${prompt.tasks.join(', ')}` : '', '', ...prepared.plan.subjects.map((s) => `- ${s}`), '', `Approved by the owner in Telegram; published by minions at ${prompt.sha}.`].join('\n').trim();
      const res = await this.o.ops.publish(project, prepared.plan, prompt.mode, { title, body });
      const detail = res.mode === 'direct' ? `pushed ${prompt.sha} to origin/${prompt.base}` : `pushed ${res.ref.replace(/^refs\/heads\//, '')}; pull request ${res.prUrl ?? '(no URL reported)'}`;
      if (prompt.requestId) await this.o.ops.mark(project, prompt.requestId, 'applied', detail).catch(() => undefined);
      const checkout = res.checkout ? (res.checkout.applied ? ` Your checkout was fast-forwarded to it.` : ` Your checkout was not moved: ${res.checkout.reason}.`) : '';
      await done(`${name}: published. ${detail}.${checkout}`);
      this.log(`publisher: ${name}: ${detail}`);
    } catch (e) {
      const msg = redact(e instanceof MinionsError ? `${e.message}${e.hint ? ` (${e.hint})` : ''}` : String((e as Error)?.message ?? e)).slice(0, 600);
      await fail('failed', msg);
    }
  }

  private async publishCommand(arg: string): Promise<void> {
    const projects = await this.o.ops.projects();
    if (!arg) {
      await this.say(projects.length ? ['Projects:', ...projects.map((p) => `- ${p.name} (${p.baseBranch})`), '', 'Send /publish <project>.'].join('\n') : 'No minions projects are registered on this host.');
      return;
    }
    const want = arg.toLowerCase();
    const matches = projects.filter((p) => p.name.toLowerCase() === want || (want.length >= 8 && p.projectId.startsWith(want)));
    if (matches.length !== 1) { await this.say(matches.length ? `"${oneLine(arg, 60)}" matches more than one project; use the project id.` : `No project named "${oneLine(arg, 60)}". Send /publish for the list.`); return; }
    const project = matches[0]!;
    const st = await this.state.load();
    const open = st.prompts.find((p) => p.projectId === project.projectId && p.status === 'asked');
    if (open) {
      // Ask again in a new message (the old one may be far up); the old buttons stop working.
      const nonce = this.nonce();
      const text = promptText({ project: project.name, base: open.base, sha: open.sha, commits: open.commits, tasks: open.tasks, mode: open.mode, summary: open.summary, subjects: [], remoteUrl: null });
      if (open.messageId !== null) await this.edit(open.messageId, `${project.name}: asked again below.`);
      open.nonce = nonce;
      await this.state.save(st);
      open.messageId = await this.say(text, keyboard(nonce));
      await this.state.save(st);
      return;
    }
    const prepared = await this.o.ops.prepare(project, null);
    if (!prepared.plan) { await this.say(`${project.name}: cannot check what to publish: ${prepared.error ?? 'the runtime is not reachable'}.`); return; }
    if (prepared.plan.refusal) { await this.say(`${project.name}: nothing to publish: ${prepared.plan.refusal.message}.`); return; }
    await this.ask(st, project, prepared.plan, { requestId: null, tasks: prepared.tasks, summary: null });
    await this.state.save(st);
  }
}

// ---------------------------------------------------------------- the real operations

const lastJson = <T>(r: RunResult) => { try { return parseEnvelope<T>(r.stdout, 'settings requests'); } catch { return null; } };

interface RuntimeHandle { exec(args: string[]): Promise<RunResult>; exportTarget: Parameters<typeof exportRepo>[1] }

/** The project's runtime when it can be reached (host runtime prepared, or the container running); null otherwise. */
async function runtimeHandle(project: ProjectJson): Promise<RuntimeHandle | null> {
  if (runtimeOf(project) === 'host') {
    const host = new HostRuntime(project);
    if (!(await host.prepared().catch(() => false))) return null;
    return { exec: (args) => host.exec(args, { allowFailure: true, timeoutMs: 120_000 }), exportTarget: { repoPath: project.repoPath, target: host.transferTarget() } };
  }
  const compose = new Compose(project.projectId);
  if (!(await compose.isRunning().catch(() => false))) return null;
  return { exec: (args) => compose.exec(args, { allowFailure: true, timeoutMs: 120_000 }), exportTarget: { repoPath: project.repoPath, compose } };
}

/** Project config for publishing: mode and deploy key from the host's project and local config (never the overlay). */
export async function publishSettings(project: ProjectJson): Promise<{ mode: PublishMode; deployKey: string | null }> {
  const cfg = (await loadEffectiveConfig(project)).config;
  return { mode: cfg.publish?.mode ?? 'direct', deployKey: cfg.publish?.deployKey ?? null };
}

/** Exports the agents' refs into the owner's checkout and plans publishing `sha` (null: the agents' base head). */
export async function preparePublish(project: ProjectJson, sha: string | null): Promise<{ plan: PublishPlan | null; tasks: string[]; error?: string }> {
  const h = await runtimeHandle(project);
  if (!h) return { plan: null, tasks: [], error: runtimeOf(project) === 'host' ? 'the host runtime has not been started' : 'the project container is not running' };
  if (runtimeOf(project) === 'host') await prepareHostRuntime(project);
  const exported = await exportRepo(project, h.exportTarget);
  const target = sha ?? await headOfRef(project.repoPath, `refs/remotes/minions/${project.baseBranch}`);
  if (!target) return { plan: null, tasks: [], error: `the agents have no ${project.baseBranch} branch yet` };
  const { deployKey } = await publishSettings(project);
  const plan = await planPublish({ repo: project.repoPath, base: project.baseBranch, sha: target, deployKey });
  // The delivered/landed tasks whose head is in the outgoing range (for a /publish prompt without a request).
  const tasks: string[] = [];
  if (!plan.refusal) {
    for (const t of exported.tasks) {
      const inRange = await gitOk(project.repoPath, ['merge-base', '--is-ancestor', t.sha, target]) && !(plan.from && await gitOk(project.repoPath, ['merge-base', '--is-ancestor', t.sha, plan.from]));
      if (inRange) tasks.push(t.taskId);
    }
  }
  return { plan, tasks: tasks.slice(0, 50) };
}

async function gitOk(repo: string, args: string[]): Promise<boolean> {
  return (await run('git', [...HOST_GIT, ...args], { cwd: repo, allowFailure: true, timeoutMs: 60_000 })).code === 0;
}

async function headOfRef(repo: string, ref: string): Promise<string | null> {
  const r = await run('git', [...HOST_GIT, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo, allowFailure: true, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

export function realOps(): PublisherOps {
  const load = (p: PublisherProject) => loadProjectJson(p.projectId);
  return {
    async projects() {
      const out: PublisherProject[] = [];
      for (const id of Object.keys((await loadRegistry()).projects)) {
        const pj = await loadProjectJson(id).catch(() => null);
        if (pj) out.push({ projectId: id, name: basename(pj.repoPath), repoPath: pj.repoPath, baseBranch: pj.baseBranch });
      }
      return out;
    },
    async requests(p) {
      const h = await runtimeHandle(await load(p));
      if (!h) return null;
      const d = lastJson<{ requests?: ChangeRequestView[] }>(await h.exec(['minions', 'settings', 'requests', '--json']));
      if (!d) throw new MinionsError('INTERNAL', 'settings requests: unexpected output from the runtime');
      return (Array.isArray(d.requests) ? d.requests : []).filter((r) => r && r.kind === 'publish' && typeof r.id === 'string');
    },
    async mark(p, id, status, detail) {
      const h = await runtimeHandle(await load(p));
      if (!h) throw new MinionsError('PRECONDITION', 'the runtime is not reachable');
      const r = await h.exec(['minions', 'settings', 'requests', 'mark', id, '--status', status, '--detail', detail.slice(0, 900), '--json']);
      if (r.code !== 0) throw new MinionsError('INTERNAL', `settings requests mark ${id} failed: ${redact((r.stderr || r.stdout).trim()).slice(-300)}`);
    },
    prepare: async (p, sha) => preparePublish(await load(p), sha),
    mode: async (p) => (await publishSettings(await load(p))).mode,
    async publish(p, plan, mode, text) {
      const project = await load(p);
      const { deployKey } = await publishSettings(project);
      return publishCommit({ repo: project.repoPath, base: plan.base, sha: plan.sha, plan, mode, deployKey, ...text });
    },
  };
}

// ---------------------------------------------------------------- the loop

export interface RunPublisherOptions {
  fetch?: Fetch;
  log?: (line: string) => void;
  signal?: AbortSignal;
  ops?: PublisherOps;
  /** Exit (PUBLISHER_RESTART_EXIT_CODE) when the installed CLI changes. */
  cliChanged?: () => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * `minions settings requests serve`: the publisher service's process. Waits (re-checking every few minutes) while no
 * token or no owner id is set; exits when another publisher holds the lock (the supervisor retries), and with
 * PUBLISHER_RESTART_EXIT_CODE after a CLI reinstall. Returns the exit code.
 */
export async function runPublisher(o: RunPublisherOptions = {}): Promise<number> {
  if (inMinionsContainer()) throw new MinionsError('INCOMPATIBLE_RUNTIME', 'The publisher runs only on the host.');
  const log = o.log ?? ((l: string) => process.stdout.write(`${new Date().toISOString()} ${l}\n`));
  const sleep = o.sleep ?? pause;
  await ensureDir(publisherPaths().dir, 0o700);
  const release = takePublisherLock();
  if (!release) { log('publisher: another publisher process holds the lock; exiting'); return 1; }
  const cliChanged = o.cliChanged ?? cliChangeWatcher();
  const startedAt = new Date().toISOString();
  const beat = async (state: Heartbeat['state'], detail: string, botId: string | null, projects: Heartbeat['projects'] = {}) =>
    writeHeartbeat({ version: 1, pid: process.pid, startedAt, at: new Date().toISOString(), state, detail, botId, sshAuthSock: !!process.env.SSH_AUTH_SOCK, projects }).catch(() => undefined);
  try {
    for (;;) {
      if (o.signal?.aborted) return 0;
      if (cliChanged()) { log('publisher: the installed CLI changed; exiting for a restart on the new version'); return PUBLISHER_RESTART_EXIT_CODE; }
      const cred = await readPublisherToken().catch((e: unknown) => { log(`publisher: ${redact((e as Error).message)}`); return null; });
      const owner = (await loadDefaults().catch(() => ({} as Awaited<ReturnType<typeof loadDefaults>>))).telegram?.owner;
      if (!cred || !owner) {
        await beat('waiting', !cred ? 'no publisher bot token (`minions auth publisher`)' : 'no owner id (`minions defaults set telegram.owner <id>`)', cred?.botId ?? null);
        await sleep(300_000, o.signal);
        continue;
      }
      const code = await serve({ token: cred.token, botId: cred.botId, ownerId: Number(owner), log, sleep, signal: o.signal, fetch: o.fetch, ops: o.ops ?? realOps(), cliChanged, beat });
      if (code !== null) return code;
    }
  } finally { release(); }
}

async function serve(o: {
  token: string; botId: string; ownerId: number; log: (l: string) => void; sleep: (ms: number, s?: AbortSignal) => Promise<void>; signal?: AbortSignal; fetch?: Fetch;
  ops: PublisherOps; cliChanged: () => boolean; beat: (state: Heartbeat['state'], detail: string, botId: string | null, projects?: Heartbeat['projects']) => Promise<void>;
}): Promise<number | null> {
  const api = new BotApi({
    token: o.token, fetch: o.fetch, sleep: o.sleep,
    errors: {
      auth: { message: 'The publisher bot token was rejected by Telegram (revoked or mistyped).', hint: 'Store it again with `minions auth publisher`.' },
      conflict: { message: 'Another process polls the publisher bot (Telegram getUpdates 409 Conflict), or a webhook is set.', hint: 'Stop the other publisher (another minions home on this or another machine), or remove the webhook.' },
    },
  });
  const core = new PublisherCore({ bot: api, ownerId: o.ownerId, ops: o.ops, log: o.log });
  const offsetFile = new OffsetFile(publisherPaths().offsetJson, o.botId);
  let offset = await offsetFile.load().catch(() => undefined);
  let nextScan = 0;
  let failures = 0;
  await api.setMyCommands([{ command: 'publish', description: 'Publish a project now: /publish <project>' }, { command: 'help', description: 'What this bot does' }]).catch(() => undefined);
  o.log(`publisher: serving bot ${o.botId} for owner ${o.ownerId}`);
  for (;;) {
    if (o.signal?.aborted) return 0;
    if (o.cliChanged()) { o.log('publisher: the installed CLI changed; exiting for a restart on the new version'); return PUBLISHER_RESTART_EXIT_CODE; }
    try {
      if (Date.now() >= nextScan) {
        await core.scan();
        nextScan = Date.now() + POLL_REQUESTS_MS;
        await o.beat('running', `bot ${o.botId}`, o.botId, await authFacts(core, o.ops));
      }
      const updates = await api.getUpdates({ offset, timeoutSecs: LONG_POLL_SECS, allowed: ['message', 'callback_query'], signal: o.signal });
      const next = nextOffset(offset, updates);
      if (next !== offset) { offset = next; await offsetFile.save(offset!); } // saved before handling: a crash never replays a press
      for (const u of updates) await core.handleUpdate(u).catch((e: unknown) => o.log(`publisher: update ${u.update_id}: ${redact((e as Error).message)}`));
      failures = 0;
    } catch (e) {
      const err = e as MinionsError;
      if (err.code === 'AUTH_REQUIRED') { o.log(`publisher: ${err.message}`); await o.beat('error', err.message, o.botId); await o.sleep(300_000, o.signal); return null; }
      if (err.code === 'CONFLICT') { o.log(`publisher: ${err.message}`); await o.beat('conflict', err.message, o.botId); await o.sleep(60_000, o.signal); continue; }
      failures++;
      o.log(`publisher: ${redact(err.message ?? String(e))}`);
      await o.sleep(Math.min(retryAfterMs(e) ?? 5000 * failures, 120_000), o.signal);
    }
  }
}

/** Per project: how a push would authenticate in this process, and the last problem (the heartbeat for doctor). */
async function authFacts(core: PublisherCore, ops: PublisherOps): Promise<Heartbeat['projects']> {
  const out: Heartbeat['projects'] = {};
  for (const p of await ops.projects().catch(() => [])) {
    const project = await loadProjectJson(p.projectId).catch(() => null);
    if (!project) continue;
    const deployKey = await publishSettings(project).then((s) => s.deployKey, () => null);
    out[p.projectId] = { auth: pushAuthFacts(await remoteUrlOf(project.repoPath).catch(() => null), publishEnv({}), deployKey), lastError: core.lastErrors.get(p.projectId) ?? null };
  }
  return out;
}

// ---------------------------------------------------------------- the owner's terminal

export interface TerminalPublish { request: ChangeRequestView; plan: PublishPlan; mode: PublishMode; result: PublishResult | null; checkout: string | null }

/**
 * `minions settings requests publish <id>` on the host: the same checks as the bot, confirmed in the owner's terminal
 * (no flag skips the question). `confirm` returns null without a terminal.
 */
export async function publishFromTerminal(project: ProjectJson, requestId: string, o: { confirm: (q: string) => Promise<boolean | null>; dryRun?: boolean; ops?: PublisherOps }): Promise<TerminalPublish> {
  if (inMinionsContainer()) throw new MinionsError('INCOMPATIBLE_RUNTIME', 'Publishing runs only on the host.');
  const ops = o.ops ?? realOps();
  const p: PublisherProject = { projectId: project.projectId, name: basename(project.repoPath), repoPath: project.repoPath, baseBranch: project.baseBranch };
  const open = await ops.requests(p);
  if (open === null) throw new MinionsError('PRECONDITION', 'The runtime is not reachable, so its publish requests cannot be read.', 'Run `minions start --no-attach` first.');
  const request = open.find((r) => r.id === requestId);
  if (!request) throw new MinionsError('NOT_FOUND', `No open publish request ${displayText(requestId)}.`, 'List them with `minions settings requests`.');
  const payload = publishPayloadOf(request.payload);
  if (!payload || payload.base !== project.baseBranch) throw new MinionsError('PRECONDITION', `Publish request ${requestId} is malformed or names another base branch.`);
  const prepared = await ops.prepare(p, payload.sha);
  if (!prepared.plan) throw new MinionsError('PRECONDITION', `cannot check what to publish: ${prepared.error ?? 'export failed'}`);
  const plan = prepared.plan;
  const mode = await ops.mode(p);
  if (plan.refusal) throw new MinionsError('PRECONDITION', `not published: ${plan.refusal.message}`, plan.refusal.code === 'fetch-failed' ? authHint(plan.remoteUrl) : undefined, { hits: plan.hits });
  if (o.dryRun) return { request, plan, mode, result: null, checkout: null };
  const q = `${promptText({ project: p.name, base: plan.base, sha: plan.sha, commits: plan.commits, tasks: payload.tasks, mode, summary: request.reason, subjects: plan.subjects, remoteUrl: plan.remoteUrl })}\n(y/N)`;
  const ok = await o.confirm(q);
  if (ok === null) throw new MinionsError('PRECONDITION', 'Publishing needs a confirmation in a terminal.', 'Run it in a terminal, or approve it in Telegram (the publisher bot).');
  if (!ok) throw new MinionsError('PRECONDITION', 'Not confirmed; nothing was pushed.');
  await ops.mark(p, requestId, 'confirmed', `approved by the owner in the host terminal for ${plan.sha}`);
  try {
    const result = await ops.publish(p, plan, mode, { title: request.reason ? oneLine(request.reason, 100) : `Publish ${plural(plan.commits, 'commit')} to ${plan.base}`, body: request.reason ?? '' });
    const detail = result.mode === 'direct' ? `pushed ${plan.sha} to origin/${plan.base}` : `pushed ${result.ref.replace(/^refs\/heads\//, '')}; pull request ${result.prUrl ?? '(no URL reported)'}`;
    await ops.mark(p, requestId, 'applied', detail).catch(() => undefined);
    return { request, plan, mode, result, checkout: result.checkout ? (result.checkout.applied ? 'fast-forwarded' : result.checkout.reason) : null };
  } catch (e) {
    await ops.mark(p, requestId, 'failed', redact((e as Error).message).slice(0, 600)).catch(() => undefined);
    throw e;
  }
}

