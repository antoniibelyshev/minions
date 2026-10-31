// `minions setup`: one guided command for the whole host-side setup (decision record:
// docs/design/bootstrap.md, "Guided setup").
//
// Order: init wizard (repo/profile/visibility/runtime/Claude auth) -> local integration (opt-in, default no) -> Telegram (token + pairing guidance) -> agents (which harness does
// the work; src/host/harness-setup.ts) -> host manager bot (optional, host-wide: token and terminal pairing;
// src/host/manager-bot.ts) -> host manager service (optional: launchd agent / systemd --user unit;
// src/host/manager-service.ts) -> runtime start
// (container, or the host runtime), repository import, coordinator launch -> attach/pair instructions.
// The CLI then offers the AI setup assistant (`minions setup assist`) for whatever is left.
//
// - Reuses runInit (wizard, plan, apply), the credential provisioning of `auth telegram`, and (through
//   SetupRuntime) the start/import code of `minions start`.
// - Integration choices that differ from the project configuration (delivery.merge, communication.channel) go
//   into the host-only config.local.json, never into shared repo files.
// - Secrets are read only through the non-echoing terminal prompt or from stdin (never argv), and never
//   appear in the result, the notes, or any prompt text.
import { rm } from 'node:fs/promises';
import { autoMergeConfigReasons } from '../config/delivery.js';
import type { MinionsConfig, Profile } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { readJsonIfExists, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import {
  backendLabel, provisionCodexKey, loadCredentialRefs, provisionTelegramToken, telegramBotGuidance, loadManagerCredentialRef, readManagerToken, removeManagerToken, type CredentialsJson, type Fetch,
  loadManagerClaudeCredentialRef, removeManagerClaudeToken, storeManagerClaudeToken,
} from './credentials.js';
import {
  ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL, defaultAssistantConfig, loadAssistantConfig, managerAssistantGuidance, removeAssistantConfig, saveAssistantConfig,
  type AssistantConfig, type AssistantModel,
} from './manager-assistant.js';
import { resolveOnPath } from './auth.js';
import { checkTelegramTokenFormat } from '../telegram/token.js';
import { clearManagerAccess, loadManagerAccess, managerBotGuidance, pairManagerBot, provisionManagerToken, type PairingOptions } from './manager-bot.js';
import { installManagerService, loadServiceRecord, removeManagerService, serviceHost, serviceKind, type ServiceHost } from './manager-service.js';
import type { DockerProbe } from './discovery.js';
import type { Runner } from './docker.js';
import { harnessStep } from './harness-setup.js';
import { formatPlan, runInit, type InitResult } from './install.js';
import { defaultSessionsOn } from './channel-cli.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { findByCommonDir, gitCommonDir, loadRegistry, repoRoot } from './registry.js';
import type { RuntimeKind } from './runtime.js';
import type { ImportResult } from './transfer.js';
import type { WizardIO } from './wizard.js';

/**
 * Runtime-side operations (container, or the host runtime), implemented by the CLI with the code of
 * `minions start` (fakes in tests).
 */
export interface SetupRuntime {
  /** Which runtime the project uses (default docker). */
  kind?(projectId: string): Promise<RuntimeKind>;
  containerRunning(projectId: string): Promise<boolean>;
  /** Builds the image if needed, materializes secrets, starts the container (idempotent compose up). */
  start(projectId: string): Promise<void>;
  repoPresent(projectId: string): Promise<boolean>;
  importRepo(projectId: string): Promise<ImportResult>;
  /** Installs the Telegram plugin when selected and starts the coordinator session detached. */
  launchCoordinator(projectId: string): Promise<{ action?: string; reason?: string } | null>;
  /** Human command that attaches a terminal to the coordinator. */
  attachCommand(projectId: string): string;
}

export interface SetupOptions {
  path: string;
  profile?: Profile;
  visibility?: 'shared' | 'private';
  /**
   * --config <file>: validated project configuration (same semantics as `minions init --config`). The
   * init wizard and the questions the file covers (keep/change, communication channel)
   * are skipped; token questions are still asked when interactive.
   */
  configFile?: string;
  /** --attach / --new-identity: forwarded to runInit (same semantics as `minions init`). */
  attach?: boolean;
  newIdentity?: boolean;
  /** --yes: non-interactive defaults (optional integrations off unless a token arrives on stdin). */
  yes: boolean;
  dryRun?: boolean;
  /** Prompts (required unless --yes or --dry-run). */
  io?: WizardIO;
  /** Tokens read from stdin by the CLI (never from argv). */
  tokens?: { telegram?: string; manager?: string; managerClaude?: string };
  /** Manager bot pairing clock, code and TTL (tests); fetch is `fetch` above. */
  managerPairing?: Pick<PairingOptions, 'now' | 'sleep' | 'ttlMs' | 'pollSeconds' | 'code'>;
  /** The manager service host (tests: platform, home, runner for launchctl / systemctl, program). */
  managerService?: Partial<ServiceHost>;
  runtime: SetupRuntime;
  /** --runtime: forwarded to runInit (same semantics as `minions init --runtime`). */
  runtimeKind?: RuntimeKind;
  dockerProbe?: DockerProbe;
  runner?: Runner;
  fetch?: Fetch;
  /** Host platform of the manager service step (tests). */
  platform?: NodeJS.Platform;
}

export type StepId = 'init' | 'autoMerge' | 'telegram' | 'harness' | 'manager' | 'assistant' | 'service' | 'container' | 'import' | 'coordinator';
export type StepStatus = 'done' | 'kept' | 'changed' | 'skipped' | 'failed' | 'deferred' | 'planned';
export interface SetupStep { id: StepId; status: StepStatus; detail: string; later?: string; lines?: string[] }

export interface SetupResult {
  dryRun: boolean;
  projectId: string;
  /** A project was already registered for this repository (rerun). */
  rerun: boolean;
  init: InitResult;
  steps: SetupStep[];
  /** Keys written to config.local.json by this run (empty when nothing changed). */
  localConfig: { path: string; changed: string[] };
  /** The container is running and the coordinator was launched. */
  ready: boolean;
  attach: string | null;
  /** `cd <repo> && minions start`: the attach command that works from any directory. */
  attachStart?: string;
  pairing: string[];
  nextSteps: string[];
}

async function choose<T extends string>(io: WizardIO, q: string, def: T, opts: readonly T[]): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const a = (await io.ask(`${q} (${opts.join('/')})`, def)).trim().toLowerCase();
    const hit = opts.find((o) => o === a || o[0] === a);
    if (hit) return hit;
    io.info(`  choose one of: ${opts.join(', ')}`);
  }
  return def;
}

async function yesNo(io: WizardIO, q: string, def: boolean): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const a = (await io.ask(`${q} (y/n)`, def ? 'y' : 'n')).trim();
    if (/^y(es)?$/i.test(a)) return true;
    if (/^no?$/i.test(a)) return false;
    io.info('  answer y or n');
  }
  return def;
}

const errMsg = (e: unknown, fallback: string) => (e instanceof MinionsError ? e.message : fallback);

export const PAIRING_STEPS = [
  'Telegram pairing happens in the coordinator terminal (setup cannot approve it):',
  '  1. Attach to the coordinator and DM your bot on Telegram; it replies with a pairing code.',
  '  2. In the coordinator session run: /telegram:access pair <code>',
  '  3. Then lock access to the allowlist: /telegram:access policy allowlist (pair only yourself).',
];

/** POSIX shell quoting: plain paths stay as they are, anything else is single-quoted. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Commands printed by setup that work from any directory: `minions setup <repo>` takes the path; the
 * other commands resolve the project from the working directory, so they get a `cd <repo> &&` prefix.
 */
export function setupCommands(repoPath: string) {
  const q = shellQuote(repoPath);
  const setup = `\`minions setup ${q}\``;
  const inRepo = (c: string) => `\`cd ${q} && ${c}\``;
  return {
    setup, inRepo,
    later: {
      autoMerge: `Run ${setup} again to enable automatic local integration (default no).`,
      telegram: `Run ${setup} again (or ${inRepo('minions auth telegram')}) to connect a Telegram bot.`,
      container: `Run ${setup} again or ${inRepo('minions start')} to start the container and attach the coordinator.`,
    },
  };
}

/** Registered project id for the repository containing `path`, or null. */
async function registeredProject(path: string): Promise<string | null> {
  try {
    const found = findByCommonDir(await loadRegistry(), await gitCommonDir(await repoRoot(path)));
    return found?.[0] ?? null;
  } catch { return null; }
}

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const interactive = !opts.yes && !opts.dryRun && !!opts.io;
  if (!opts.yes && !opts.dryRun && !opts.io) {
    throw new MinionsError('PRECONDITION', 'setup needs a terminal for its questions.', 'Pass --yes to accept the defaults (optional integrations off), or --dry-run.');
  }
  // A piped token that is empty is an error, not "no integration": fail before anything is written.
  // The message never includes the input.
  const pipedNames = (['telegram', 'manager', 'managerClaude'] as const).filter((n) => opts.tokens?.[n] !== undefined);
  for (const [name, flag, label] of [['telegram', 'telegram', 'Telegram'], ['manager', 'manager', 'manager bot'], ['managerClaude', 'manager-claude', 'manager Claude']] as const) {
    const t = opts.tokens?.[name];
    if (t !== undefined && t.trim() === '') {
      const line = ['first', 'second', 'third'][pipedNames.indexOf(name)];
      throw new MinionsError('PRECONDITION', `--${flag}-token-stdin: no ${label} token was read from stdin (empty input); nothing was changed.`,
        `Pipe the token as the ${line} line of stdin, or omit --${flag}-token-stdin.`);
    }
  }
  const io = opts.io;
  const say = (l: string) => io?.info(l);
  const steps: SetupStep[] = [];
  const step = (s: SetupStep) => { steps.push(s); return s; };

  // ---------------------------------------------------------------- 1. project (init wizard)
  const priorId = await registeredProject(opts.path);
  let reconfigure = false;
  if (priorId && interactive && !opts.configFile) {
    say(`minions is already set up for this repository (project ${priorId}).`);
    reconfigure = (await choose(io!, 'Project configuration: keep it or change it?', 'keep', ['keep', 'change'] as const)) === 'change';
  }
  if (interactive) say('\n== Project ==');
  const init = await runInit({
    path: opts.path, profile: opts.profile, visibility: opts.visibility, yes: !interactive, dryRun: opts.dryRun,
    configFile: opts.configFile, attach: opts.attach, newIdentity: opts.newIdentity, runtime: opts.runtimeKind,
    io: interactive ? io : undefined, skipIntegrations: true, reconfigure,
    dockerProbe: opts.dockerProbe, runner: opts.runner, fetch: opts.fetch,
  });
  const projectId = init.plan.projectId;
  const written = init.applied ? init.applied.written.length + init.applied.removed.length : 0;
  step({ id: 'init', status: opts.dryRun ? 'planned' : priorId ? (reconfigure || opts.configFile ? 'changed' : 'kept') : 'done',
    detail: opts.dryRun ? `would install project ${projectId} (${init.plan.visibility}, profile ${init.plan.profile})`
      : `project ${projectId} (${init.plan.visibility}, profile ${init.plan.profile}); ${written} file(s) written, ${init.applied?.unchanged ?? 0} unchanged` });

  const cmds = setupCommands(init.plan.repoPath);
  const LATER = cmds.later;
  const refs = await loadCredentialRefs(projectId).catch((): CredentialsJson => ({ version: 1 }));
  const localPath = projectPaths(projectId).configLocalJson;

  if (opts.dryRun) return dryRunResult(init, steps, refs, priorId !== null, localPath);
  const unused = (name: string) => `; the token piped with --${name}-token-stdin was not used (nothing was stored)`;

  const project = await loadProjectJson(projectId);
  let config: MinionsConfig = (await loadEffectiveConfig(project)).config;
  const localRaw = await readJsonIfExists<Record<string, unknown>>(localPath);
  const hadLocal = localRaw !== undefined;
  const localBefore = localRaw ?? {};
  const local: Record<string, unknown> = structuredClone(localBefore);
  const changed: string[] = [];
  const setLocal = (dotted: string, value: unknown) => {
    const keys = dotted.split('.');
    let cur = local;
    for (const k of keys.slice(0, -1)) { if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}; cur = cur[k] as Record<string, unknown>; }
    cur[keys.at(-1)!] = value;
    if (!changed.includes(dotted)) changed.push(dotted);
  };

  // ---------------------------------------------------------------- 2. local integration (opt-in, default no)
  if (interactive) say('\n== Local integration ==');
  step(await localIntegrationStep(interactive && !opts.configFile ? io! : null, config, setLocal, LATER.autoMerge, cmds.inRepo));

  // ---------------------------------------------------------------- 3. Telegram
  if (interactive) say('\n== Telegram ==');
  let channel = config.communication.channel;
  const tg = refs.telegram;
  const hostRuntime = (await opts.runtime.kind?.(projectId)) === 'host';
  // auto already means Telegram once a bot token is stored: storing one keeps auto.
  const telegramChannel = channel === 'auto' ? 'auto' : 'telegram';
  if (hostRuntime) {
    step({ id: 'telegram', status: 'skipped', detail: `the host runtime has no Telegram (no user plugins or MCP servers); the coordinator runs in the terminal${opts.tokens?.telegram ? unused('telegram') : ''}`,
      later: `Telegram needs the Docker runtime: ${cmds.inRepo('minions runtime set docker')}.` });
  } else if (config.container.network === 'none') {
    step({ id: 'telegram', status: 'skipped', detail: `container.network is none; the Telegram plugin needs api.telegram.org and the npm registry${opts.tokens?.telegram ? unused('telegram') : ''}`, later: LATER.telegram });
  } else {
    type TgAction = 'keep' | 'change' | 'disable' | 'setup' | 'reuse' | 'skip';
    let action: TgAction;
    if (opts.tokens?.telegram) action = tg ? 'change' : 'setup';
    else if (channel !== 'terminal' && tg) {
      action = interactive ? await choose(io!, `Telegram is set up (bot ${tg.botId}${channel === 'auto' ? ', communication.channel auto' : ''}). Keep it, change the bot token, or disable Telegram?`, 'keep', ['keep', 'change', 'disable'] as const) : 'keep';
    } else if (!interactive) action = 'skip';
    else if (channel === 'telegram') {
      action = await yesNo(io!, 'Telegram is selected but no bot token is stored. Set up Telegram now?', false) ? 'setup' : 'skip';
    } else if (opts.configFile) action = 'skip'; // the config file selects the channel (terminal)
    else if (await yesNo(io!, 'Set up Telegram (talk to the coordinator through your own bot)?', false)) {
      action = tg && await yesNo(io!, `A bot token is already stored (bot ${tg.botId}). Use it?`, true) ? 'reuse' : 'setup';
    } else action = 'skip';

    if (action === 'setup' || action === 'change') {
      for (const l of telegramBotGuidance()) say(`  ${l}`);
      try {
        const token = opts.tokens?.telegram ?? (io?.secret ? await io.secret('Telegram bot token (input hidden): ')
          : (() => { throw new MinionsError('PRECONDITION', 'no terminal for a non-echoing prompt; pipe it with --telegram-token-stdin'); })());
        const verify = interactive ? await yesNo(io!, 'Check the token with Telegram now (Bot API getMe; sends it to api.telegram.org)?', false) : false;
        const r = await provisionTelegramToken({ projectId, token, repoPath: project.repoPath, verify, runner: opts.runner, fetch: opts.fetch });
        channel = telegramChannel;
        const sessionsOn = await defaultSessionsOn(await loadProjectJson(projectId)).catch(() => false);
        step({ id: 'telegram', status: action === 'change' ? 'changed' : 'done',
          detail: `bot ${r.botId} stored in ${backendLabel(r.backend)}; communication.channel ${channel}${sessionsOn ? '; coordinator sessions on (one per thread)' : ''}`,
          ...(r.warnings.length ? { lines: r.warnings.map((w) => `warning: ${w}`) } : {}) });
      } catch (e) {
        step({ id: 'telegram', status: 'failed', detail: `${errMsg(e, 'could not store the token')}; nothing was stored, the coordinator stays terminal-only`, later: LATER.telegram });
      }
    } else if (action === 'reuse') {
      channel = telegramChannel;
      step({ id: 'telegram', status: 'changed', detail: `using the stored bot ${tg!.botId}; communication.channel ${channel}` });
    } else if (action === 'disable') {
      channel = 'terminal';
      step({ id: 'telegram', status: 'changed', detail: `communication.channel terminal; the bot token is kept (remove it with ${cmds.inRepo('minions auth telegram --remove')})`, later: LATER.telegram });
    } else if (action === 'keep') {
      step({ id: 'telegram', status: 'kept', detail: `bot ${tg!.botId}; communication.channel ${channel}` });
    } else {
      step({ id: 'telegram', status: 'skipped', detail: channel === 'telegram' ? 'no bot token stored; the coordinator runs terminal-only' : 'terminal only', later: LATER.telegram });
    }
  }
  if (channel !== config.communication.channel) setLocal('communication.channel', channel);

  // ---------------------------------------------------------------- 5b. agents (harnesses; agent-runtimes D8)
  if (interactive && !hostRuntime && !opts.configFile) say('\n== Agents ==');
  const h = await harnessStep({
    io: interactive && !opts.configFile ? io! : null, config, project, local, setLocal, hostRuntime,
    codexKeyStored: !!refs.codex, inRepo: cmds.inRepo, setupCmd: cmds.setup,
    storeCodexKey: async (token) => backendLabel((await provisionCodexKey({ projectId, token, repoPath: project.repoPath, runner: opts.runner })).backend),
  });
  step({ id: 'harness', ...h });

  // ---------------------------------------------------------------- 5c. host manager bot (host-wide, optional)
  if (interactive) say('\n== Host manager bot ==');
  const mgr = await managerStep({ io: interactive ? io! : null, token: opts.tokens?.manager, runner: opts.runner, fetch: opts.fetch, pairing: opts.managerPairing, setupCmd: cmds.setup });
  step(mgr);
  const ast = await assistantStep({ io: interactive ? io! : null, token: opts.tokens?.managerClaude, runner: opts.runner, setupCmd: cmds.setup });
  if (ast) step(ast);
  const svc = await serviceStep({ io: interactive ? io! : null, manager: mgr, host: opts.managerService, platform: opts.platform, setupCmd: cmds.setup });
  if (svc) step(svc);

  // ---------------------------------------------------------------- record choices, regenerate derived files
  if (changed.length) {
    await writeJson(localPath, local);
    try {
      config = (await loadEffectiveConfig(project)).config;
    } catch (e) {
      if (hadLocal) await writeJson(localPath, localBefore); else await rm(localPath, { force: true });
      throw e;
    }
    // Same code path as a rerun of init: regenerates the plugin and runtime config with the new layer.
    await runInit({ path: opts.path, yes: true, skipIntegrations: true, dockerProbe: opts.dockerProbe, runner: opts.runner, fetch: opts.fetch });
  }

  // ---------------------------------------------------------------- 6. container, import, coordinator
  if (interactive) say(hostRuntime ? '\n== Host runtime ==' : '\n== Container ==');
  let ready = false;
  const start = !interactive || await yesNo(io!, hostRuntime
    ? 'Prepare the host runtime, clone the repository into its workspace, and set up the coordinator now?'
    : 'Build and start the container, import the repository, and launch the coordinator now?', true);
  if (!start) {
    step({ id: 'container', status: 'skipped', detail: 'container not started', later: LATER.container });
  } else {
    try {
      const wasRunning = await opts.runtime.containerRunning(projectId);
      say(hostRuntime ? '  Preparing the host runtime (no Docker; agents run as your macOS user)…' : '  Starting the container (the first run builds the runtime image; this can take a few minutes)…');
      await opts.runtime.start(projectId);
      step({ id: 'container', status: wasRunning ? 'kept' : 'done', detail: wasRunning ? 'already running; reused' : 'started' });

      if (await opts.runtime.repoPresent(projectId)) {
        const again = interactive && await yesNo(io!, `The repository is already imported. Import ${project.baseBranch} again (committed history only)?`, false);
        if (again) step(importStep(await opts.runtime.importRepo(projectId), 'changed'));
        else step({ id: 'import', status: 'kept', detail: `repository already imported; run ${cmds.inRepo('minions import')} to refresh it` });
      } else {
        say(`  Importing committed history of ${project.baseBranch} into the ${hostRuntime ? 'host runtime workspace' : 'container'}…`);
        step(importStep(await opts.runtime.importRepo(projectId), 'done'));
      }

      const c = await opts.runtime.launchCoordinator(projectId);
      step(c ? { id: 'coordinator', status: c.action === 'started' ? 'done' : 'kept', detail: `coordinator ${c.action ?? 'running'}${c.reason ? ` (${c.reason})` : ''}` }
        : { id: 'coordinator', status: 'failed', detail: 'coordinator sync failed (see the warning above)', later: `Run ${cmds.inRepo('minions start')} to launch and attach it.` });
      ready = !!c;
    } catch (e) {
      const at: StepId = !steps.some((s) => s.id === 'container') ? 'container' : !steps.some((s) => s.id === 'import') ? 'import' : 'coordinator';
      step({ id: at, status: 'failed', detail: errMsg(e, 'container step failed'), later: LATER.container });
    }
  }

  const telegramOn = !hostRuntime && (config.communication.channel === 'telegram' || (config.communication.channel === 'auto' && !!(await loadCredentialRefs(projectId).catch((): CredentialsJson => ({ version: 1 }))).telegram));
  const login = (project.claudeAuth?.method ?? 'login') === 'login';
  const attach = start ? opts.runtime.attachCommand(projectId) : null;
  return {
    dryRun: false, projectId, rerun: priorId !== null, init, steps, localConfig: { path: localPath, changed }, ready,
    attach, attachStart: `cd ${shellQuote(init.plan.repoPath)} && minions start`, pairing: telegramOn ? PAIRING_STEPS : [],
    nextSteps: [
      ready ? `Attach to the coordinator: ${cmds.inRepo('minions start')} (or the command below); detach with Ctrl-b d, it keeps running.`
        : `Run ${cmds.inRepo('minions start')} to start the container and attach the coordinator.`,
      ...(!login ? [] : hostRuntime ? ['The host runtime uses your existing Claude Code login on this Mac.']
        : ['First time only: log in to Claude inside the coordinator session with /login (your host login is not reused).']),
      `Anything left (verification commands, CI, Telegram pairing)? ${cmds.inRepo('minions setup assist')} opens the AI setup assistant.`,
      ...(telegramOn ? PAIRING_STEPS : []),
      `Run ${cmds.inRepo('minions doctor')} to check readiness at any time; rerun ${cmds.setup} to keep or change any of these choices.`,
    ],
  };
}

/**
 * Host manager bot (host-wide, optional, rerunnable; docs/design/host-manager.md). Token: hidden prompt or
 * --manager-token-stdin, format check, bot-id guard, optional consented getMe. Pairing: terminal only (never with
 * --yes or a piped token), a one-time code the owner sends to the bot in a private chat within 10 minutes.
 */
async function managerStep(o: { io: WizardIO | null; token?: string; runner?: Runner; fetch?: Fetch; pairing?: SetupOptions['managerPairing']; setupCmd: string }): Promise<SetupStep> {
  const later = `Run ${o.setupCmd} again in a terminal to set up or pair the host manager bot.`;
  let ref: Awaited<ReturnType<typeof loadManagerCredentialRef>>;
  try { ref = await loadManagerCredentialRef(); } catch (e) {
    return { id: 'manager', status: 'failed', detail: errMsg(e, 'the manager credential reference is unreadable'), later };
  }
  const access = await loadManagerAccess().catch(() => null);
  const paired = !!ref && access?.botId === ref.botId;
  const pairState = (userId?: number) => (userId !== undefined ? `paired with Telegram user ${userId}` : 'not paired');
  type Action = 'keep' | 'change' | 'pair' | 'remove' | 'setup' | 'skip';
  let action: Action;
  if (o.token) action = ref ? 'change' : 'setup';
  else if (!o.io) action = ref ? 'keep' : 'skip';
  else if (ref) {
    action = await choose(o.io, `The host manager bot is set up (bot ${ref.botId}, ${paired ? 'paired' : 'not paired'}). Keep it, change the token, pair your Telegram account again, or remove it?`,
      paired ? 'keep' : 'pair', ['keep', 'change', 'pair', 'remove'] as const);
  } else {
    action = await yesNo(o.io, 'Set up the host manager bot (a second Telegram bot, separate from coordinator bots, that asks you to confirm setup changes)?', false) ? 'setup' : 'skip';
  }

  if (action === 'skip') return { id: 'manager', status: 'skipped', detail: `host manager bot not set up (optional)${o.io ? '' : '; pairing needs a terminal'}`, later };
  if (action === 'keep') {
    return { id: 'manager', status: 'kept', detail: `bot ${ref!.botId}; ${pairState(paired ? access!.userId : undefined)}`,
      ...(paired ? {} : { lines: [`not paired: ${later}`] }) };
  }
  if (action === 'remove') {
    const r = await removeManagerToken(o.runner);
    await clearManagerAccess();
    return { id: 'manager', status: 'changed', detail: `manager bot token removed${r.backend ? ` (${r.backend})` : ''}; pairing cleared`, later };
  }

  const lines: string[] = [];
  let botId = ref?.botId ?? '';
  let token: string | null = null;
  let username: string | undefined;
  let stored = '';
  if (action === 'setup' || action === 'change') {
    for (const l of managerBotGuidance()) o.io?.info(`  ${l}`);
    try {
      const raw = o.token ?? (o.io?.secret ? await o.io.secret('Manager bot token (input hidden): ')
        : (() => { throw new MinionsError('PRECONDITION', 'no terminal for a non-echoing prompt; pipe it with --manager-token-stdin'); })());
      const verify = o.io ? await yesNo(o.io, 'Check the token with Telegram now (Bot API getMe; sends it to api.telegram.org)?', false) : false;
      const r = await provisionManagerToken({ token: raw, verify, runner: o.runner, fetch: o.fetch });
      botId = r.botId;
      token = checkTelegramTokenFormat(raw).token;
      username = r.verification?.login;
      stored = `bot ${r.botId} stored in ${backendLabel(r.backend)}`;
      lines.push(...r.warnings.map((w) => `warning: ${w}`));
      if (r.pairingCleared) lines.push('the previous pairing belonged to another bot and was removed');
    } catch (e) {
      return { id: 'manager', status: 'failed', detail: `${errMsg(e, 'could not store the manager bot token')}; nothing was stored`, later };
    }
  }
  const done: StepStatus = action === 'setup' ? 'done' : 'changed';
  const wantPair = action === 'pair' || (!!o.io && await yesNo(o.io,
    'Pair your Telegram account with the manager bot now (a one-time code you send to the bot within 10 minutes; polls api.telegram.org)?', true));
  if (!wantPair) return { id: 'manager', status: done, detail: `${stored}; not paired`, lines: [...lines, `not paired: ${later}`] };

  try {
    token ??= await readManagerToken(o.runner);
    if (!token) throw new MinionsError('NOT_FOUND', 'no manager bot token is stored');
    const p = await pairManagerBot({ token, botId, fetch: o.fetch, ...o.pairing, onCode: (code) => {
      o.io?.info(`  Send this one-time code to ${username ? `@${username}` : 'your manager bot'} in a private chat (not a group) within 10 minutes:`);
      o.io?.info(`      ${code}`);
      o.io?.info('  Waiting for it… (Ctrl-C cancels; nothing is recorded until the code arrives)');
    } });
    if (p.status === 'paired') {
      return { id: 'manager', status: action === 'pair' ? 'changed' : done, detail: `${stored ? `${stored}; ` : `bot ${botId}; `}${pairState(p.access.userId)} (private chat)`, ...(lines.length ? { lines } : {}) };
    }
    if (action === 'pair') return { id: 'manager', status: 'failed', detail: `pairing code expired: ${p.detail}; the previous pairing is unchanged`, later };
    return { id: 'manager', status: done, detail: `${stored}; not paired (code expired)`, lines: [...lines, `warning: ${p.detail}`, `not paired: ${later}`] };
  } catch (e) {
    if (action === 'pair') return { id: 'manager', status: 'failed', detail: `${errMsg(e, 'pairing failed')}; the previous pairing is unchanged`, later };
    return { id: 'manager', status: done, detail: `${stored}; not paired`, lines: [...lines, `warning: pairing failed: ${errMsg(e, 'unexpected error')}`, `not paired: ${later}`] };
  }
}

/**
 * The manager's natural-language assistant (optional, host-wide, rerunnable; docs/design/host-manager-assistant.md).
 * Offered only with a manager bot (or when already set up). Token: hidden prompt or --manager-claude-token-stdin, format
 * check, stored like the manager bot token. Only an interactive "yes" (or "on") switches it on: --yes and a piped token
 * never do (a piped token is stored and the on/off state stays as it was). Null when there is nothing to report (no
 * manager bot, no assistant state, no piped token).
 */
async function assistantStep(o: { io: WizardIO | null; token?: string; runner?: Runner; setupCmd: string }): Promise<SetupStep | null> {
  const later = `Run ${o.setupCmd} again in a terminal to set up or switch on the manager assistant.`;
  let cfg: AssistantConfig | null;
  let cred: Awaited<ReturnType<typeof loadManagerClaudeCredentialRef>>;
  try {
    cfg = await loadAssistantConfig();
    cred = await loadManagerClaudeCredentialRef();
  } catch (e) {
    return { id: 'assistant', status: 'failed', detail: `${errMsg(e, 'the assistant settings are unreadable')}${o.token !== undefined ? '; the piped Claude token was not stored' : ''}`, later };
  }
  const bot = !!(await loadManagerCredentialRef().catch(() => null));
  if (!bot && !cfg && !cred && o.token === undefined) return null;
  const state = (c: AssistantConfig | null) => (c?.enabled ? `on (${c.model}, limit ${c.dailyLimit} calls/day)` : 'off');
  const kindLabel = (k: 'oauth-token' | 'api-key') => (k === 'oauth-token' ? 'Claude OAuth token' : 'Anthropic API key');
  type Action = 'keep' | 'on' | 'off' | 'change' | 'remove' | 'setup' | 'token' | 'skip';
  let action: Action;
  if (o.token !== undefined) action = 'token';
  else if (!o.io) action = cfg || cred ? 'keep' : 'skip';
  else if (cred) {
    action = cfg?.enabled
      ? await choose(o.io, `The manager assistant is ${state(cfg)}. Keep it, change the model or token, turn it off, or remove it?`, 'keep', ['keep', 'change', 'off', 'remove'] as const)
      : await choose(o.io, 'The manager assistant is off (a Claude token is stored). Keep it off, turn it on, change the model or token (this also turns it on), or remove it?', 'keep', ['keep', 'on', 'change', 'remove'] as const);
  } else {
    action = await yesNo(o.io, 'Set up the natural-language assistant in the manager chat (plain-language requests; each message is one Claude call billed to the token you enter)?', false) ? 'setup' : 'skip';
  }

  if (action === 'skip') return { id: 'assistant', status: 'skipped', detail: `manager assistant not set up (optional${o.io ? '' : '; only an interactive setup switches it on'})`, later };
  if (action === 'keep') return { id: 'assistant', status: 'kept', detail: `manager assistant ${state(cfg)}; ${cred ? 'Claude token stored' : 'no Claude token stored'}` };
  if (action === 'remove') {
    const r = await removeManagerClaudeToken(o.runner);
    await removeAssistantConfig();
    return { id: 'assistant', status: 'changed', detail: `manager assistant removed (Claude token deleted${r.backend ? ` from ${r.backend}` : ''})` };
  }
  if (action === 'on' || action === 'off') {
    const next: AssistantConfig = { ...(cfg ?? defaultAssistantConfig()), enabled: action === 'on' };
    await saveAssistantConfig(next);
    return { id: 'assistant', status: 'changed', detail: `manager assistant ${state(next)}` };
  }
  if (action === 'token') {
    let stored: string;
    try {
      const ref = await storeManagerClaudeToken(o.token!, { runner: o.runner });
      stored = `${kindLabel(ref.kind)} stored in ${backendLabel(ref.backend)}`;
    } catch (e) {
      return { id: 'assistant', status: 'failed', detail: `${errMsg(e, 'could not store the Claude token')}; nothing was stored`, later };
    }
    const now = cfg ?? defaultAssistantConfig();
    if (!cfg) await saveAssistantConfig(now);
    return { id: 'assistant', status: cred ? 'changed' : 'done', detail: `${stored}; manager assistant ${state(now)}`,
      ...(now.enabled ? {} : { lines: ['not switched on: a piped token never switches the assistant on', `later: ${later}`] }) };
  }

  // setup / change: interactive only.
  const io = o.io!;
  for (const l of managerAssistantGuidance()) io.info(`  ${l}`);
  const model = await choose<AssistantModel>(io, 'Assistant model (sonnet: balanced; haiku: cheaper; opus: strongest)', cfg?.model ?? DEFAULT_ASSISTANT_MODEL, ASSISTANT_MODELS);
  let stored = '';
  try {
    const keep = action === 'change' && !!cred;
    const raw = io.secret ? await io.secret(`Claude token (claude setup-token or an Anthropic API key; input hidden${keep ? '; empty keeps the stored token' : ''}): `)
      : (() => { throw new MinionsError('PRECONDITION', 'no terminal for a non-echoing prompt; pipe it with --manager-claude-token-stdin'); })();
    if (raw.trim() || !keep) {
      const ref = await storeManagerClaudeToken(raw, { runner: o.runner });
      stored = `${kindLabel(ref.kind)} stored in ${backendLabel(ref.backend)}; `;
    }
  } catch (e) {
    return { id: 'assistant', status: 'failed', detail: `${errMsg(e, 'could not store the Claude token')}; nothing was stored`, later };
  }
  const next: AssistantConfig = { ...(cfg ?? defaultAssistantConfig()), model, enabled: true };
  await saveAssistantConfig(next);
  const lines = (await resolveOnPath('claude')) ? [] : ['warning: Claude Code (`claude`) is not on PATH: the manager answers with the command list until it is installed'];
  return { id: 'assistant', status: action === 'setup' ? 'done' : 'changed', detail: `${stored}manager assistant ${state(next)}`, ...(lines.length ? { lines } : {}) };
}

/**
 * Host manager service (optional, rerunnable; docs/design/host-manager.md phase 5): a launchd agent or systemd --user
 * unit that runs `minions manager run` and restarts it when it exits (also after a CLI reinstall). Only offered while a
 * manager bot token is stored; removed when the token is gone. Installing asks first (default no), also never with
 * --yes; an installed service is kept up to date on every rerun, and restarted after a token or pairing change.
 * Returns null (no step) when there is neither a token nor a service.
 */
async function serviceStep(o: { io: WizardIO | null; manager: SetupStep; host?: Partial<ServiceHost>; platform?: NodeJS.Platform; setupCmd: string }): Promise<SetupStep | null> {
  const later = `Run ${o.setupCmd} again in a terminal to install the host manager service.`;
  const host = serviceHost({ ...(o.platform ? { platform: o.platform } : {}), ...o.host });
  const hasToken = !!(await loadManagerCredentialRef().catch(() => null));
  // A corrupt or foreign record counts as absent (the unit it names is never touched); install rewrites it, and
  // without a token removeManagerService deletes it (and only this home's own default unit).
  let rec: Awaited<ReturnType<typeof loadServiceRecord>>;
  let invalid: string | null = null;
  try { rec = await loadServiceRecord(host); } catch (e) {
    rec = null;
    invalid = `warning: ignored the invalid manager service record (${errMsg(e, 'unreadable').split('\n')[0]})`;
  }
  if (!hasToken && !rec && !invalid) return null;
  const step = await serviceAction(o, host, later, hasToken, rec);
  return invalid ? { ...step, lines: [invalid, ...(step.lines ?? [])] } : step;
}

async function serviceAction(o: { io: WizardIO | null; manager: SetupStep }, host: ServiceHost, later: string, hasToken: boolean,
  rec: Awaited<ReturnType<typeof loadServiceRecord>>): Promise<SetupStep> {
  const kind = serviceKind(host.platform);
  const what = kind === 'launchd' ? 'launchd agent' : 'systemd --user unit';
  if (!hasToken) {
    try {
      const r = await removeManagerService(host);
      return { id: 'service', status: 'changed', detail: `no manager bot token: the manager service was removed${r.path ? ` (${r.path})` : ''}` };
    } catch (e) { return { id: 'service', status: 'failed', detail: errMsg(e, 'could not remove the manager service'), later }; }
  }
  if (!kind) {
    return { id: 'service', status: 'skipped', detail: `no supported user service manager on ${host.platform}: run \`minions manager run\` under your own supervisor` };
  }
  let action: 'install' | 'keep' | 'remove' | 'skip';
  if (rec) {
    action = o.io ? await choose(o.io, `The host manager runs as a ${what} (${rec.path}). Keep it (brought up to date) or remove it?`, 'keep', ['keep', 'remove'] as const) : 'keep';
  } else if (o.io) {
    action = await yesNo(o.io, `Install the host manager as a ${what} (runs in the background, starts at login, and restarts after it exits, also after a CLI upgrade)?`, false) ? 'install' : 'skip';
  } else action = 'skip';
  if (action === 'skip') return { id: 'service', status: 'skipped', detail: `host manager service not installed (optional)${o.io ? '' : '; an interactive setup asks'}`, later };
  try {
    if (action === 'remove') {
      const r = await removeManagerService(host);
      return { id: 'service', status: 'changed', detail: `${what} removed${r.path ? ` (${r.path})` : ''}`, later };
    }
    // A new token or pairing is read only at start: restart a running manager after one.
    const restart = o.manager.status === 'done' || o.manager.status === 'changed';
    const r = await installManagerService(host, { restart });
    const lines = r.warnings.map((w) => `warning: ${w}`);
    if (r.action === 'installed') return { id: 'service', status: 'done', detail: `${what} installed and started (${r.path})`, ...(lines.length ? { lines } : {}) };
    if (r.action === 'updated') return { id: 'service', status: 'changed', detail: `${what} updated and restarted (${r.path})`, ...(lines.length ? { lines } : {}) };
    return { id: 'service', status: 'kept', detail: `${what} up to date${restart ? '; restarted for the new token or pairing' : ''} (${r.path})`, ...(lines.length ? { lines } : {}) };
  } catch (e) {
    return { id: 'service', status: 'failed', detail: errMsg(e, `could not ${action === 'remove' ? 'remove' : 'install'} the ${what}`), later };
  }
}

function importStep(r: ImportResult, status: StepStatus): SetupStep {
  return { id: 'import', status, detail: `${r.baseBranch} @ ${r.commit.slice(0, 12)}`, ...(r.warnings.length ? { lines: r.warnings.map((w) => `warning: ${w}`) } : {}) };
}

/**
 * The autoMerge step in local delivery (task-82.4): asks "Integrate approved tasks automatically?" (default: the
 * current setting). Yes records delivery.merge "auto-when-eligible": the runtime merges each approved head, runs the
 * verification commands on the merged tree, and lands it on the local base (docs/design/local-auto-integration.md).
 * Not asked in the supervised profile (base.merge is denied there: the user integrates).
 */
async function localIntegrationStep(io: WizardIO | null, config: MinionsConfig, setLocal: (k: string, v: unknown) => void, later: string, inRepo: (c: string) => string): Promise<SetupStep> {
  const on = config.delivery.merge === 'auto-when-eligible';
  const missing = () => autoMergeConfigReasons({ ...config, delivery: { ...config.delivery, merge: 'auto-when-eligible' } });
  const base = config.git.baseBranch;
  const lines = () => missing().map((r) => `still needed: ${r}`);
  const kept = (): SetupStep => ({ id: 'autoMerge', status: 'kept', detail: `delivery.merge auto-when-eligible: the runtime integrates approved tasks into the local ${base}`, ...(missing().length ? { lines: lines() } : {}) });
  const denied = missing().some((r) => r.startsWith('base.merge is denied'));
  if (denied && !on) {
    io?.info(`  Automatic local integration is off in this profile (base.merge is denied: you integrate approved branches); not asked.`);
    return { id: 'autoMerge', status: 'skipped', detail: 'local integration not offered: base.merge is denied by policy', later };
  }
  if (!io) return on ? kept() : { id: 'autoMerge', status: 'skipped', detail: 'automatic local integration not enabled (default no)', later };
  io.info(`  minions can integrate approved tasks into the local ${base} itself: it merges the approved head, runs the verification commands`);
  io.info(`  (${config.verification.commands.join(', ') || 'none configured'}) on the merged tree, and moves ${base} only when they pass. A conflict or a failure`);
  io.info(`  sends the task back for a repair. Sensitive paths need your approval (${inRepo('minions work approve <taskId> --head <sha>')}).`);
  const yes = await yesNo(io, 'Integrate approved tasks automatically?', on);
  if (yes === on) return on ? kept() : { id: 'autoMerge', status: 'skipped', detail: 'automatic local integration not enabled', later };
  setLocal('delivery.merge', yes ? 'auto-when-eligible' : 'disabled');
  if (!yes) return { id: 'autoMerge', status: 'changed', detail: `delivery.merge disabled (approved tasks end delivered; the coordinator merges them into the local ${base})` };
  const l = lines();
  for (const x of l) io.info(`  ${x}`);
  return { id: 'autoMerge', status: 'done', detail: `delivery.merge auto-when-eligible: the runtime integrates approved tasks into the local ${base}${l.length ? ` (not usable yet; see below and ${inRepo('minions doctor')} merge.readiness)` : ''}`, ...(l.length ? { lines: l } : {}) };
}

function dryRunResult(init: InitResult, steps: SetupStep[], refs: CredentialsJson, rerun: boolean, localPath: string): SetupResult {
  const would = (id: StepId, detail: string) => steps.push({ id, status: 'planned', detail });
  would('autoMerge', 'would ask "Integrate approved tasks automatically?" (default no); yes records delivery.merge "auto-when-eligible" in the local layer');
  would('telegram', refs.telegram ? `bot ${refs.telegram.botId} stored: would offer keep/change/disable` : 'would ask "Set up Telegram?" (default no); bot token entered without echo');
  would('harness', 'would ask "Which agent should do the work?" (default Claude Code; OpenAI Codex: OpenAI API key without echo, model, and in this version the read-only codex-reviewer stage after the Claude reviewer)');
  would('manager', 'would ask "Set up the host manager bot?" (default no; host-wide): its own bot token entered without echo, then a one-time pairing code sent to the bot within 10 minutes');
  would('assistant', `with a manager bot: would ask "Set up the natural-language assistant?" (default no; --yes never switches it on): model (${ASSISTANT_MODELS.join('/')}) and a Claude token (claude setup-token or an Anthropic API key) entered without echo`);
  would('service', 'with a manager bot token: would ask to install the host manager as a launchd agent (macOS) or systemd --user unit (Linux), default no; an installed one is kept up to date');
  would('container', 'would build the image if needed and start the container (idempotent)');
  would('import', 'would import committed history of the base branch unless already imported');
  would('coordinator', 'would launch the coordinator detached and print how to attach and pair');
  return {
    dryRun: true, projectId: init.plan.projectId, rerun, init, steps, localConfig: { path: localPath, changed: [] }, ready: false,
    attach: null, pairing: [], nextSteps: ['Rerun without --dry-run to apply.'],
  };
}

export function formatSetup(r: SetupResult): string {
  const L: string[] = [];
  if (r.dryRun) L.push(formatPlan(r.init.plan), '');
  L.push(`${r.dryRun ? 'Setup plan' : 'Setup summary'} for project ${r.projectId}${r.rerun ? ' (rerun: existing installation detected)' : ''}:`);
  for (const s of r.steps) {
    L.push(`  ${s.id.padEnd(11)} ${s.status.padEnd(8)} ${s.detail}`);
    for (const l of s.lines ?? []) L.push(`              ${l}`);
    if (s.later && (s.status === 'skipped' || s.status === 'failed')) L.push(`              later: ${s.later}`);
  }
  if (r.localConfig.changed.length) L.push('', `Recorded in ${r.localConfig.path}: ${r.localConfig.changed.join(', ')}`);
  if (r.attach) L.push('', `Attach: ${r.attachStart ?? 'minions start'}   (or: ${r.attach})`);
  L.push('', 'Next steps:', ...r.nextSteps.map((s) => `  ${s}`));
  return L.join('\n');
}
