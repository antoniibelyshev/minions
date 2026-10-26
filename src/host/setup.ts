// `minions setup`: one guided command for the whole host-side setup (decision record:
// docs/design/bootstrap.md, "Guided setup").
//
// Order: init wizard (repo/profile/visibility/runtime/Claude auth) -> GitHub (the guided flow of
// `minions setup github`: remote, base branch, pre-filled token link, token; then the delivery mode) ->
// CI guidance -> auto-merge (opt-in, default no) -> Telegram (token + pairing guidance) -> agents (which harness does
// the work; src/host/harness-setup.ts) -> host manager bot (optional, host-wide: token and terminal pairing;
// src/host/manager-bot.ts) -> host manager service (optional: launchd agent / systemd --user unit;
// src/host/manager-service.ts) -> runtime start
// (container, or the host runtime), repository import, coordinator launch -> attach/pair instructions.
// The CLI then offers the AI setup assistant (`minions setup assist`) for whatever is left.
//
// - Reuses runInit (wizard, plan, apply), the credential provisioning of `auth github|telegram`, the CI
//   helpers of src/runtime/ci.ts, and (through SetupRuntime) the start/import code of `minions start`.
// - Integration choices that differ from the project configuration (delivery.mode/provider,
//   communication.channel) go into the host-only config.local.json, never into shared repo files.
// - Secrets are read only through the non-echoing terminal prompt or from stdin (never argv), and never
//   appear in the result, the notes, or any prompt text.
// - Never writes workflow files and never changes branch protection: CI is observed read-only (GET)
//   and the setup plan is printed only. Auto-merge is only recorded as delivery.merge in
//   config.local.json when the user answers yes (default no); nothing is enabled on GitHub here.
import { rm } from 'node:fs/promises';
import { can } from '../config/capabilities.js';
import { defaultDeliveryMode } from '../config/profiles.js';
import { autoMergeConfigReasons } from '../config/delivery.js';
import type { MinionsConfig, Profile } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { readJsonIfExists, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import { ciSetupPlan, fetchApi, requiredChecksStatus, type RequiredChecksReport } from '../runtime/ci.js';
import {
  backendLabel, githubRepoFromRemote, provisionCodexKey, githubTokenGuidance, loadCredentialRefs, provisionGithubToken, provisionTelegramToken, readGithubToken,
  removeGithubToken, telegramBotGuidance, loadManagerCredentialRef, readManagerToken, removeManagerToken, type CredentialsJson, type Fetch,
} from './credentials.js';
import { checkTelegramTokenFormat } from '../telegram/token.js';
import { clearManagerAccess, loadManagerAccess, managerBotGuidance, pairManagerBot, provisionManagerToken, type PairingOptions } from './manager-bot.js';
import { installManagerService, loadServiceRecord, removeManagerService, serviceHost, serviceKind, type ServiceHost } from './manager-service.js';
import type { DockerProbe } from './discovery.js';
import type { Runner } from './docker.js';
import { runGithubSetup, type GithubSetupResult } from './github-setup.js';
import { harnessStep } from './harness-setup.js';
import { formatPlan, runInit, type InitResult } from './install.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { findByCommonDir, gitCommonDir, loadRegistry, repoRoot } from './registry.js';
import type { RuntimeKind } from './runtime.js';
import type { ImportResult } from './transfer.js';
import type { WizardIO } from './wizard.js';

export const DELIVERY_MODES = ['local', 'branch', 'pull-request'] as const;
export type DeliveryMode = typeof DELIVERY_MODES[number];

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
   * init wizard and the questions the file covers (keep/change, delivery mode, communication channel)
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
  /** --delivery: explicit delivery mode (non-interactive). */
  delivery?: DeliveryMode;
  /** Tokens read from stdin by the CLI (never from argv). */
  tokens?: { github?: string; telegram?: string; manager?: string };
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
  /** Guided GitHub flow: browser opener and platform (tests). */
  openUrl?: (url: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

export type StepId = 'init' | 'github' | 'delivery' | 'ci' | 'intake' | 'autoMerge' | 'telegram' | 'harness' | 'manager' | 'service' | 'container' | 'import' | 'coordinator';
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

const isYes = (s: string) => /^y(es)?$/i.test(s.trim());

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
      github: `Run ${setup} again (or ${inRepo('minions auth github')}) to store a GitHub token and choose branch or pull-request delivery.`,
      intake: `Run ${setup} again to import GitHub issues into the backlog (intake.github; read-only).`,
      ci: `Run ${setup} again, ${inRepo('minions doctor')} (ci.requiredChecks), or ${inRepo('minions ci status')} to see the CI setup plan.`,
      autoMerge: `Run ${setup} again to enable CI-gated auto-merge (needs pull-request delivery; default no).`,
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
  const pipedNames = (['github', 'telegram', 'manager'] as const).filter((n) => opts.tokens?.[n] !== undefined);
  for (const [name, label] of [['github', 'GitHub'], ['telegram', 'Telegram'], ['manager', 'manager bot']] as const) {
    const t = opts.tokens?.[name];
    if (t !== undefined && t.trim() === '') {
      const line = ['first', 'second', 'third'][pipedNames.indexOf(name)];
      throw new MinionsError('PRECONDITION', `--${name}-token-stdin: no ${label} token was read from stdin (empty input); nothing was changed.`,
        `Pipe the token as the ${line} line of stdin, or omit --${name}-token-stdin.`);
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

  const git = init.plan.discovery.git;
  const cmds = setupCommands(init.plan.repoPath);
  const LATER = cmds.later;
  const refs = await loadCredentialRefs(projectId).catch((): CredentialsJson => ({ version: 1 }));
  const localPath = projectPaths(projectId).configLocalJson;

  if (opts.dryRun) return dryRunResult(opts, init, steps, refs, priorId !== null, localPath, cmds.inRepo);
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

  // ---------------------------------------------------------------- 2. GitHub (guided flow + delivery mode)
  let hasToken = !!refs.github;
  let onGitHub = git.hasGitHub;
  let remoteUrl = git.remoteUrl;
  if (interactive) say('\n== GitHub ==');
  // Interactive token entry uses the guided flow of `minions setup github` (remote, base branch,
  // pre-filled token link, hidden prompt); setup asks the delivery mode itself below.
  const guided = async (replaceToken: boolean): Promise<GithubSetupResult> => {
    const g = await runGithubSetup({
      projectId, repoPath: project.repoPath, io, skipIntro: true, tokenConfirmed: true, skipDelivery: true, replaceToken,
      runner: opts.runner, fetch: opts.fetch, openUrl: opts.openUrl, platform: opts.platform,
    });
    onGitHub = !!g.state.repository;
    remoteUrl = g.state.remoteUrl;
    hasToken = g.state.token === 'stored';
    return g;
  };
  if (!git.hasGitHub) {
    const offer = interactive && !git.remoteUrl && !opts.tokens?.github &&
      await yesNo(io!, 'No GitHub remote. Set up GitHub (add a github.com origin, store a token, then branch or pull-request delivery)?', false);
    if (offer) step(githubStep(await guided(false), 'done', LATER.github));
    else step({ id: 'github', status: 'skipped', detail: `the repository has no github.com origin; local delivery only${opts.tokens?.github ? unused('github') : ''}`, later: `Add a github.com origin, then run ${cmds.setup} again.` });
  } else {
    type GhAction = 'keep' | 'change' | 'remove' | 'setup' | 'skip';
    let action: GhAction;
    if (opts.tokens?.github) action = hasToken ? 'change' : 'setup';
    else if (hasToken) {
      action = interactive ? await choose(io!, `A GitHub token is stored (${refs.github!.backend}). Keep, change, or remove it?`, 'keep', ['keep', 'change', 'remove'] as const) : 'keep';
    } else {
      action = interactive && await yesNo(io!, 'Set up GitHub integration (fine-grained token, then branch or pull-request delivery)?', false) ? 'setup' : 'skip';
    }
    if ((action === 'setup' || action === 'change') && interactive && !opts.tokens?.github) {
      step(githubStep(await guided(action === 'change'), action === 'change' ? 'changed' : 'done', LATER.github));
    } else if (action === 'setup' || action === 'change') {
      for (const l of githubTokenGuidance(git.remoteUrl)) say(`  ${l}`);
      try {
        const token = opts.tokens?.github ?? (io?.secret ? await io.secret('GitHub token (input hidden): ')
          : (() => { throw new MinionsError('PRECONDITION', 'no terminal for a non-echoing prompt; pipe it with --github-token-stdin'); })());
        const r = await provisionGithubToken({ projectId, token, repoPath: project.repoPath, remoteUrl: git.remoteUrl, runner: opts.runner, fetch: opts.fetch });
        hasToken = true;
        step({ id: 'github', status: action === 'change' ? 'changed' : 'done',
          detail: `token stored in ${backendLabel(r.backend)}${r.verification ? ` (verification: ${r.verification.status})` : ''}`,
          ...(r.warnings.length ? { lines: r.warnings.map((w) => `warning: ${w}`) } : {}) });
      } catch (e) {
        step({ id: 'github', status: 'failed', detail: `${errMsg(e, 'could not store the token')}; nothing was stored`, later: LATER.github });
      }
    } else if (action === 'remove') {
      const r = await removeGithubToken(projectId, opts.runner);
      hasToken = false;
      step({ id: 'github', status: 'changed', detail: r.removed ? `token removed (${r.backend})` : 'no token was stored', later: LATER.github });
    } else if (action === 'keep') {
      step({ id: 'github', status: 'kept', detail: `token already stored (${refs.github!.backend}); replace it with ${cmds.inRepo('minions auth github')}` });
    } else {
      step({ id: 'github', status: 'skipped', detail: 'GitHub integration not set up; delivery stays local', later: LATER.github });
    }
  }

  // Delivery mode: branch/pull-request need a GitHub remote, a stored token, and git.push not denied.
  const current = config.delivery.mode;
  const blocked = !onGitHub ? 'no GitHub remote' : !hasToken ? 'no GitHub token is stored'
    : can(config, 'git.push') === 'deny' ? 'the profile denies git.push' : null;
  let mode: DeliveryMode = current;
  if (opts.delivery) {
    if (opts.delivery !== 'local' && blocked) {
      step({ id: 'delivery', status: 'failed', detail: `--delivery ${opts.delivery} is not selectable (${blocked}); keeping ${current}`, later: LATER.github });
    } else mode = opts.delivery;
  } else if (interactive && !opts.configFile && !blocked && steps.find((s) => s.id === 'github')?.status !== 'skipped') {
    // PR-first: with a GitHub remote and a stored token pull-request delivery is the offered default
    // (a project still on local is offered the switch); local and branch stay selectable.
    say(`  Delivery: pull-request (default: push agent/<slug> and open a PR, CI runs on it), branch (push agent/<slug> only), or local (commits stay in the container; ${cmds.inRepo('minions export')}). minions merges only through opt-in CI-gated auto-merge (asked below).`);
    mode = await choose(io!, 'Delivery mode', defaultDeliveryMode(current, false), DELIVERY_MODES);
  } else if (blocked && current !== 'local' && !hasToken && refs.github) {
    mode = 'local'; // the token was just removed: branch/PR delivery could no longer publish
  }
  if (!steps.some((s) => s.id === 'delivery')) {
    if (mode !== current) {
      setLocal('delivery.mode', mode);
      setLocal('delivery.provider', mode === 'local' ? 'none' : 'github');
      step({ id: 'delivery', status: 'changed', detail: `delivery.mode ${current} -> ${mode} (recorded in ${localPath})` });
    } else {
      step({ id: 'delivery', status: 'kept', detail: `delivery.mode ${current}${current !== 'local' && blocked ? ` (cannot publish: ${blocked}; see ${cmds.inRepo('minions doctor')})` : ''}`,
        ...(current === 'local' && blocked ? { later: LATER.github } : {}) });
    }
  }

  // ---------------------------------------------------------------- 3. CI guidance (read-only)
  if (interactive) say('\n== CI ==');
  if (!onGitHub) {
    step({ id: 'ci', status: 'skipped', detail: 'no GitHub remote: CI observation not applicable', later: LATER.ci });
  } else if (interactive && await yesNo(io!, 'Use CI? (check workflows and required status checks read-only, and print the setup plan; nothing is changed)', false)) {
    step(await ciStep(opts, config, remoteUrl, hasToken, projectId, init.plan.discovery.ciWorkflows, cmds.inRepo));
  } else {
    step({ id: 'ci', status: 'skipped', detail: 'CI guidance not requested', later: LATER.ci });
  }

  // ---------------------------------------------------------------- 3b. GitHub intake sync (read-only import)
  if (interactive) say('\n== GitHub intake ==');
  step(await intakeStep(interactive && !opts.configFile ? io! : null, config, onGitHub, setLocal, LATER.intake, cmds.inRepo));

  // ---------------------------------------------------------------- 4. auto-merge (opt-in, default no)
  if (interactive) say('\n== Auto-merge ==');
  step(await autoMergeStep(interactive && !opts.configFile ? io! : null, config, mode, setLocal, LATER.autoMerge, cmds.inRepo));

  // ---------------------------------------------------------------- 5. Telegram
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
        step({ id: 'telegram', status: action === 'change' ? 'changed' : 'done',
          detail: `bot ${r.botId} stored in ${backendLabel(r.backend)}; communication.channel ${channel}`,
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
  let rec: Awaited<ReturnType<typeof loadServiceRecord>>;
  try { rec = await loadServiceRecord(); } catch (e) {
    return { id: 'service', status: 'failed', detail: errMsg(e, 'the manager service record is unreadable'), later };
  }
  if (!hasToken && !rec) return null;
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

/** The github step from the guided flow's result. */
function githubStep(g: GithubSetupResult, stored: StepStatus, later: string): SetupStep {
  const lines = [
    ...(g.remote.status === 'added' ? [`origin added: ${g.remote.url}`] : []),
    ...(g.base.pushed ? [`pushed ${g.base.branch} to origin`] : g.base.command ? [`${g.base.branch} is not on origin yet: ${g.base.command}`] : []),
    ...(g.token.provisioned?.warnings ?? []).map((w) => `warning: ${w}`),
  ];
  const extra = lines.length ? { lines } : {};
  if (!g.state.repository) return { id: 'github', status: 'skipped', detail: 'no github.com origin; local delivery only', later, ...extra };
  switch (g.token.status) {
    case 'stored': return { id: 'github', status: stored, detail: `token ${g.token.detail}`, ...extra };
    case 'present': return { id: 'github', status: 'kept', detail: g.token.detail, ...extra };
    case 'failed': return { id: 'github', status: 'failed', detail: `${g.token.detail}; nothing was stored`, later, ...extra };
    default: return { id: 'github', status: 'skipped', detail: `token not stored (${g.token.detail}); delivery stays local`, later, ...extra };
  }
}

function importStep(r: ImportResult, status: StepStatus): SetupStep {
  const o = r.container.origin;
  return {
    id: 'import', status, detail: `${r.baseBranch} @ ${r.commit.slice(0, 12)}${o ? `; origin ${o.url} (${o.authenticated ? 'authenticated' : 'not authenticated'}, ${o.fetched ? 'base fetched' : 'not fetched'})` : ''}`,
    ...([...r.warnings, ...(o?.warnings ?? [])].length ? { lines: [...r.warnings, ...(o?.warnings ?? [])].map((w) => `warning: ${w}`) } : {}),
  };
}

type IntakeFilter = NonNullable<MinionsConfig['intake']['github']>;
const describeFilter = (f: IntakeFilter) => [`repository ${f.repository ?? 'origin'}`, `state ${f.state}`,
  `labels ${f.labels.join(',') || 'any'}`, `assignee ${f.assignee ?? 'any'}`, `milestone ${f.milestone ?? 'any'}`].join(', ');

/**
 * Warning for an intake filter that any GitHub user can satisfy (task-39): no labels and no assignee
 * (null or "none" = unassigned) and no milestone restriction. On a public repository anyone can open an
 * issue, so such a filter imports issues from strangers. Labels, assignees and milestones can only be set
 * by people with triage access (unless an issue template applies labels automatically). Warn only.
 */
export function openIntakeFilterWarning(f: IntakeFilter): string | null {
  if (f.labels.length || (f.assignee !== null && f.assignee !== 'none') || (f.milestone !== null && f.milestone !== 'none')) return null;
  return 'the intake filter has no labels and no assignee: on a public repository anyone can open an issue, so issues from anyone are imported. '
    + 'Require a label that only maintainers apply (not one an issue template adds automatically), or an assignee.';
}
const filterLines = (f: IntakeFilter): Pick<SetupStep, 'lines'> => {
  const w = f.enabled ? openIntakeFilterWarning(f) : null;
  return w ? { lines: [`warning: ${w}`] } : {};
};

async function askText(io: WizardIO, q: string, def: string, ok: (v: string) => string | null): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const a = (await io.ask(q, def)).trim();
    const why = ok(a);
    if (!why) return a;
    io.info(`  ${why}`);
  }
  return def;
}

/**
 * Intake step: asks whether `minions sync` and coordinator startup should import GitHub issues matching a
 * filter (default no), then the filter. Recorded in config.local.json as intake.github. Read-only on GitHub.
 */
async function intakeStep(io: WizardIO | null, config: MinionsConfig, onGitHub: boolean, setLocal: (k: string, v: unknown) => void, later: string, inRepo: (c: string) => string): Promise<SetupStep> {
  const cur = config.intake.github;
  if (!onGitHub && !cur?.repository) {
    return cur?.enabled ? { id: 'intake', status: 'kept', detail: `intake.github on (${describeFilter(cur)}), but there is no github.com origin`, ...filterLines(cur) }
      : { id: 'intake', status: 'skipped', detail: 'no GitHub remote: GitHub intake not applicable', later };
  }
  if (!io) {
    return cur?.enabled ? { id: 'intake', status: 'kept', detail: `intake.github on (${describeFilter(cur)})`, ...filterLines(cur) }
      : { id: 'intake', status: 'skipped', detail: 'GitHub intake not enabled', later };
  }
  io.info(`  minions can import GitHub issues matching a filter into the backlog on ${inRepo('minions sync')} and at coordinator start.`);
  io.info('  It only reads GitHub (no comments, labels or status changes) and never deletes tasks; issues that leave the filter pause their task.');
  const enable = await yesNo(io, 'Import GitHub issues into the backlog?', cur?.enabled ?? false);
  if (!enable) {
    if (!cur?.enabled) return { id: 'intake', status: 'skipped', detail: 'GitHub intake not enabled', later };
    setLocal('intake.github', { ...cur, enabled: false });
    return { id: 'intake', status: 'changed', detail: 'intake.github disabled (already imported tasks stay in the backlog)' };
  }
  const list = (v: string) => (v === 'none' || v === '' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean));
  io.info('  On a public repository anyone can open an issue: filter by a label only maintainers apply, or by an assignee.');
  const labels = list(await askText(io, 'Issue labels to import (comma separated; all must match; "none" for any)', cur?.labels.join(',') || 'none',
    (v) => (/[\r\n]/.test(v) ? 'labels must be on one line' : null)));
  const assignee = await askText(io, 'Assignee filter (GitHub login, "none" = unassigned, "*" = anyone assigned, "any" = no filter)', cur?.assignee ?? 'any',
    (v) => (v === 'any' || /^(?:\*|none|[A-Za-z0-9][A-Za-z0-9-]{0,38})$/.test(v) ? null : 'enter a GitHub login, none, * or any'));
  const milestone = await askText(io, 'Milestone filter (title or number, "none" = without milestone, "*" = any milestone, "any" = no filter)', cur?.milestone ?? 'any',
    (v) => (v ? null : 'enter a milestone or any'));
  const state = await choose(io, 'Issue state', cur?.state ?? 'open', ['open', 'closed', 'all'] as const);
  const next: IntakeFilter = {
    enabled: true, repository: cur?.repository ?? null, labels,
    assignee: assignee === 'any' ? null : assignee, milestone: milestone === 'any' ? null : milestone, state,
  };
  if (cur && JSON.stringify(cur) === JSON.stringify(next)) return { id: 'intake', status: 'kept', detail: `intake.github on (${describeFilter(next)})`, ...filterLines(next) };
  setLocal('intake.github', next);
  return { id: 'intake', status: cur?.enabled ? 'changed' : 'done', detail: `intake.github on (${describeFilter(next)}); imported on ${inRepo('minions sync')} and coordinator start`, ...filterLines(next) };
}

/**
 * Auto-merge step: with pull-request delivery, asks "Enable auto-merge?" (default: the current setting,
 * i.e. no on a new project). Yes records delivery.merge "auto-when-eligible" in config.local.json and
 * lists what is still missing; nothing is changed on GitHub.
 */
async function autoMergeStep(io: WizardIO | null, config: MinionsConfig, mode: DeliveryMode, setLocal: (k: string, v: unknown) => void, later: string, inRepo: (c: string) => string): Promise<SetupStep> {
  const on = config.delivery.merge === 'auto-when-eligible';
  const missing = () => autoMergeConfigReasons({ ...config, delivery: { ...config.delivery, mode, provider: mode === 'local' ? 'none' : 'github', merge: 'auto-when-eligible' } });
  const lines = () => missing().map((r) => `still needed: ${r}`);
  if (mode !== 'pull-request') {
    io?.info(`  Auto-merge needs pull-request delivery (delivery is ${mode}); not asked.`);
    return on ? { id: 'autoMerge', status: 'kept', detail: `delivery.merge auto-when-eligible, but delivery is ${mode}: not usable`, later }
      : { id: 'autoMerge', status: 'skipped', detail: `auto-merge needs pull-request delivery (delivery is ${mode})`, later };
  }
  if (!io) {
    return on ? { id: 'autoMerge', status: 'kept', detail: 'delivery.merge auto-when-eligible', ...(missing().length ? { lines: lines() } : {}) }
      : { id: 'autoMerge', status: 'skipped', detail: 'auto-merge not enabled (default no)', later };
  }
  io.info('  minions can arm GitHub auto-merge for a delivered PR, only when the base branch has required status checks and they all pass');
  io.info('  for the reviewed head, the PR head is that head, and pr.merge policy allows it ("ask": you approve each PR on the host with');
  io.info(`  ${inRepo('minions work approve <taskId> --head <sha> --merge')}). GitHub branch protection still decides; minions never force-merges.`);
  const yes = await yesNo(io, 'Enable auto-merge?', on);
  if (yes === on) {
    return on ? { id: 'autoMerge', status: 'kept', detail: 'delivery.merge auto-when-eligible', ...(missing().length ? { lines: lines() } : {}) }
      : { id: 'autoMerge', status: 'skipped', detail: 'auto-merge not enabled', later };
  }
  setLocal('delivery.merge', yes ? 'auto-when-eligible' : 'disabled');
  if (!yes) return { id: 'autoMerge', status: 'changed', detail: `delivery.merge disabled (minions no longer arms auto-merge; ${inRepo('minions sync')} disarms what it armed)` };
  const l = lines();
  for (const x of l) io.info(`  ${x}`);
  return { id: 'autoMerge', status: 'done', detail: `delivery.merge auto-when-eligible${l.length ? ` (not usable yet; see below and ${inRepo('minions doctor')} merge.readiness)` : ''}`, ...(l.length ? { lines: l } : {}) };
}

/** CI step: local workflow files plus (with a token) required checks read with GET only; prints the plan. */
async function ciStep(opts: SetupOptions, config: MinionsConfig, remoteUrl: string | null, hasToken: boolean, projectId: string, ciWorkflows: string[], inRepo: (c: string) => string): Promise<SetupStep> {
  const workflows = ciWorkflows.filter((f) => f.startsWith('.github/workflows/'));
  const gh = githubRepoFromRemote(remoteUrl);
  const repository = gh ? `${gh.owner}/${gh.repo}` : null;
  const base = config.git.baseBranch;
  let rc: RequiredChecksReport | null = null;
  let unknownWhy = !hasToken ? 'no GitHub token is stored' : !repository ? 'origin is not a github.com repository' : '';
  if (hasToken && repository) {
    const token = await readGithubToken(projectId, opts.runner).catch(() => null);
    if (token) rc = await requiredChecksStatus(fetchApi(token, opts.fetch), repository, base);
    else unknownWhy = 'the stored GitHub token could not be read';
  }
  if (rc?.state === 'unknown') unknownWhy = rc.errors.join('; ') || 'not readable';
  // Local workflow files are definite for this checkout; the API count only adds to it. Unknown required
  // checks are reported as unknown (never as "none") and the plan is shown as conditional.
  const hasWorkflows = workflows.length > 0 || (rc?.workflows ?? 0) > 0;
  const state = rc?.state ?? 'unknown';
  const lines = [
    `Workflows: ${workflows.length ? workflows.join(', ') : 'none in .github/workflows of this checkout'}${rc?.workflows != null ? ` (GitHub reports ${rc.workflows})` : ''}`,
    `Required checks on ${base}: ${state === 'configured' ? rc!.requiredChecks.join(', ') : state === 'none' ? 'none' : `unknown (${unknownWhy})`}`,
  ];
  const plan = ciSetupPlan({ hasWorkflows, requiredChecks: state, verificationCommands: config.verification.commands, baseBranch: base, repository });
  if (plan.length && state === 'unknown') lines.push(`Required checks could not be read; follow the steps below if they are missing (rerun ${inRepo('minions doctor')} to check).`);
  lines.push(...plan.map((l) => l.split('`minions doctor`').join(inRepo('minions doctor'))));
  if (!plan.length) lines.push(`CI is in place. Set delivery.requiredChecksConfigured to true to record that these checks gate merging, and verification.ciAuthority to "github" to let tester/reviewer stages rely on them (setup changes neither; ${inRepo('minions doctor')} reports ci.authority).`);
  for (const l of lines) opts.io?.info(`  ${l}`);
  return { id: 'ci', status: 'done', detail: `${workflows.length} workflow file(s); required checks ${state}; nothing was changed`, lines };
}

function dryRunResult(opts: SetupOptions, init: InitResult, steps: SetupStep[], refs: CredentialsJson, rerun: boolean, localPath: string, inRepo: (c: string) => string): SetupResult {
  const git = init.plan.discovery.git;
  const would = (id: StepId, detail: string) => steps.push({ id, status: 'planned', detail });
  would('github', !git.hasGitHub ? 'skipped: no github.com origin'
    : refs.github ? `token stored (${refs.github.backend}): would offer keep/change/remove` : opts.tokens?.github ? 'would store the token from stdin' : 'would ask "Set up GitHub integration?" (default no); token entered without echo');
  would('delivery', `delivery.mode ${opts.delivery ?? 'unchanged'}; branch/pull-request need a GitHub remote and a stored token (then pull-request is the offered default)`);
  would('ci', git.hasGitHub ? 'would ask "Use CI?" (default no): read-only check of workflows and required checks, setup plan printed only' : 'skipped: no GitHub remote');
  would('intake', git.hasGitHub ? `would ask "Import GitHub issues into the backlog?" (default no): read-only filtered import on ${inRepo('minions sync')} and coordinator start` : 'skipped: no GitHub remote');
  would('autoMerge', 'with pull-request delivery, would ask "Enable auto-merge?" (default no); yes records delivery.merge "auto-when-eligible" in the local layer');
  would('telegram', refs.telegram ? `bot ${refs.telegram.botId} stored: would offer keep/change/disable` : 'would ask "Set up Telegram?" (default no); bot token entered without echo');
  would('harness', 'would ask "Which agent should do the work?" (default Claude Code; OpenAI Codex: OpenAI API key without echo, model, and in this version the read-only codex-reviewer stage after the Claude reviewer)');
  would('manager', 'would ask "Set up the host manager bot?" (default no; host-wide): its own bot token entered without echo, then a one-time pairing code sent to the bot within 10 minutes');
  would('service', 'with a manager bot token: would ask to install the host manager as a launchd agent (macOS) or systemd --user unit (Linux), default no; an installed one is kept up to date');
  would('container', 'would build the image if needed and start the container (idempotent)');
  would('import', 'would import committed history of the base branch unless already imported, and configure origin');
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
