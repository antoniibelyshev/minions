// `minions setup`: one guided command for the whole host-side setup (decision record:
// docs/design/bootstrap.md, "Guided setup").
//
// Order: init wizard (repo/profile/visibility) -> GitHub (token + delivery mode) -> CI guidance ->
// auto-merge (deferred) -> Telegram (token + pairing guidance) -> container start, repository import,
// coordinator launch -> attach/pair instructions.
//
// - Reuses runInit (wizard, plan, apply), the credential provisioning of `auth github|telegram`, the CI
//   helpers of src/runtime/ci.ts, and (through SetupRuntime) the start/import code of `minions start`.
// - Integration choices that differ from the project configuration (delivery.mode/provider,
//   communication.channel) go into the host-only config.local.json, never into shared repo files.
// - Secrets are read only through the non-echoing terminal prompt or from stdin (never argv), and never
//   appear in the result, the notes, or any prompt text.
// - Never writes workflow files, never changes branch protection, never enables auto-merge: CI is
//   observed read-only (GET) and the setup plan is printed only.
import { rm } from 'node:fs/promises';
import { can } from '../config/capabilities.js';
import type { MinionsConfig, Profile } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { readJsonIfExists, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import { ciSetupPlan, fetchApi, requiredChecksStatus, type RequiredChecksReport } from '../runtime/ci.js';
import {
  githubRepoFromRemote, githubTokenGuidance, loadCredentialRefs, provisionGithubToken, provisionTelegramToken, readGithubToken,
  removeGithubToken, telegramBotGuidance, type CredentialsJson, type Fetch,
} from './credentials.js';
import type { DockerProbe } from './discovery.js';
import type { Runner } from './docker.js';
import { formatPlan, runInit, type InitResult } from './install.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { findByCommonDir, gitCommonDir, loadRegistry, repoRoot } from './registry.js';
import type { ImportResult } from './transfer.js';
import type { WizardIO } from './wizard.js';

export const DELIVERY_MODES = ['local', 'branch', 'pull-request'] as const;
export type DeliveryMode = typeof DELIVERY_MODES[number];

/** Container-side operations, implemented by the CLI with the code of `minions start` (fakes in tests). */
export interface SetupRuntime {
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
  tokens?: { github?: string; telegram?: string };
  runtime: SetupRuntime;
  dockerProbe?: DockerProbe;
  runner?: Runner;
  fetch?: Fetch;
}

export type StepId = 'init' | 'github' | 'delivery' | 'ci' | 'autoMerge' | 'telegram' | 'container' | 'import' | 'coordinator';
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
      ci: `Run ${setup} again, ${inRepo('minions doctor')} (ci.requiredChecks), or ${inRepo('minions ci status')} to see the CI setup plan.`,
      autoMerge: 'Auto-merge is not available yet; minions never merges.',
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
  for (const [name, label] of [['github', 'GitHub'], ['telegram', 'Telegram']] as const) {
    const t = opts.tokens?.[name];
    if (t !== undefined && t.trim() === '') {
      const line = name === 'telegram' && opts.tokens?.github !== undefined ? 'second' : 'first';
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
    configFile: opts.configFile, attach: opts.attach, newIdentity: opts.newIdentity,
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

  if (opts.dryRun) return dryRunResult(opts, init, steps, refs, priorId !== null, localPath);
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

  // ---------------------------------------------------------------- 2. GitHub (token + delivery mode)
  let hasToken = !!refs.github;
  if (interactive) say('\n== GitHub ==');
  if (!git.hasGitHub) {
    step({ id: 'github', status: 'skipped', detail: `the repository has no github.com origin; local delivery only${opts.tokens?.github ? unused('github') : ''}`, later: `Add a github.com origin, then run ${cmds.setup} again.` });
  } else {
    type GhAction = 'keep' | 'change' | 'remove' | 'setup' | 'skip';
    let action: GhAction;
    if (opts.tokens?.github) action = hasToken ? 'change' : 'setup';
    else if (hasToken) {
      action = interactive ? await choose(io!, `A GitHub token is stored (${refs.github!.backend}). Keep, change, or remove it?`, 'keep', ['keep', 'change', 'remove'] as const) : 'keep';
    } else {
      action = interactive && await yesNo(io!, 'Set up GitHub integration (fine-grained token, then branch or pull-request delivery)?', false) ? 'setup' : 'skip';
    }
    if (action === 'setup' || action === 'change') {
      for (const l of githubTokenGuidance(git.remoteUrl)) say(`  ${l}`);
      try {
        const token = opts.tokens?.github ?? (io?.secret ? await io.secret('GitHub token (input hidden): ')
          : (() => { throw new MinionsError('PRECONDITION', 'no terminal for a non-echoing prompt; pipe it with --github-token-stdin'); })());
        const r = await provisionGithubToken({ projectId, token, repoPath: project.repoPath, remoteUrl: git.remoteUrl, runner: opts.runner, fetch: opts.fetch });
        hasToken = true;
        step({ id: 'github', status: action === 'change' ? 'changed' : 'done',
          detail: `token stored in ${r.backend === 'keychain' ? 'the macOS Keychain' : 'a 0600 host file'}${r.verification ? ` (verification: ${r.verification.status})` : ''}`,
          ...(r.warnings.length ? { lines: r.warnings.map((w) => `warning: ${w}`) } : {}) });
      } catch (e) {
        step({ id: 'github', status: 'failed', detail: `${errMsg(e, 'could not store the token')}; nothing was stored`, later: LATER.github });
      }
    } else if (action === 'remove') {
      const r = await removeGithubToken(projectId, opts.runner);
      hasToken = false;
      step({ id: 'github', status: 'changed', detail: r.removed ? `token removed (${r.backend})` : 'no token was stored', later: LATER.github });
    } else if (action === 'keep') {
      step({ id: 'github', status: 'kept', detail: `token already stored (${refs.github!.backend}); replace it with \`minions auth github\`` });
    } else {
      step({ id: 'github', status: 'skipped', detail: 'GitHub integration not set up; delivery stays local', later: LATER.github });
    }
  }

  // Delivery mode: branch/pull-request need a GitHub remote, a stored token, and git.push not denied.
  const current = config.delivery.mode;
  const blocked = !git.hasGitHub ? 'no GitHub remote' : !hasToken ? 'no GitHub token is stored'
    : can(config, 'git.push') === 'deny' ? 'the profile denies git.push' : null;
  let mode: DeliveryMode = current;
  if (opts.delivery) {
    if (opts.delivery !== 'local' && blocked) {
      step({ id: 'delivery', status: 'failed', detail: `--delivery ${opts.delivery} is not selectable (${blocked}); keeping ${current}`, later: LATER.github });
    } else mode = opts.delivery;
  } else if (interactive && !opts.configFile && !blocked && steps.find((s) => s.id === 'github')?.status !== 'skipped') {
    say('  Delivery: local (commits stay in the container; `minions export`), branch (push agent/<slug>), or pull-request (push and open a PR). minions never merges.');
    mode = await choose(io!, 'Delivery mode', current, DELIVERY_MODES);
  } else if (blocked && current !== 'local' && !hasToken && refs.github) {
    mode = 'local'; // the token was just removed: branch/PR delivery could no longer publish
  }
  if (!steps.some((s) => s.id === 'delivery')) {
    if (mode !== current) {
      setLocal('delivery.mode', mode);
      setLocal('delivery.provider', mode === 'local' ? 'none' : 'github');
      step({ id: 'delivery', status: 'changed', detail: `delivery.mode ${current} -> ${mode} (recorded in ${localPath})` });
    } else {
      step({ id: 'delivery', status: 'kept', detail: `delivery.mode ${current}${current !== 'local' && blocked ? ` (cannot publish: ${blocked}; see \`minions doctor\`)` : ''}`,
        ...(current === 'local' && blocked ? { later: LATER.github } : {}) });
    }
  }

  // ---------------------------------------------------------------- 3. CI guidance (read-only)
  if (interactive) say('\n== CI ==');
  if (!git.hasGitHub) {
    step({ id: 'ci', status: 'skipped', detail: 'no GitHub remote: CI observation not applicable', later: LATER.ci });
  } else if (interactive && await yesNo(io!, 'Use CI? (check workflows and required status checks read-only, and print the setup plan; nothing is changed)', false)) {
    step(await ciStep(opts, config, git.remoteUrl, hasToken, projectId, init.plan.discovery.ciWorkflows));
  } else {
    step({ id: 'ci', status: 'skipped', detail: 'CI guidance not requested', later: LATER.ci });
  }

  // ---------------------------------------------------------------- 4. auto-merge (deferred)
  if (interactive) {
    say('\n== Auto-merge ==');
    say('  Auto-merge is not available yet (planned after CI-gated delivery); minions never merges.');
    if (await yesNo(io!, 'Enable auto-merge? (not available yet)', false)) say('  Auto-merge is not available yet; nothing was changed.');
  }
  step({ id: 'autoMerge', status: 'deferred', detail: 'not available yet; nothing written (minions never merges)', later: LATER.autoMerge });

  // ---------------------------------------------------------------- 5. Telegram
  if (interactive) say('\n== Telegram ==');
  let channel = config.communication.channel;
  const tg = refs.telegram;
  if (config.container.network === 'none') {
    step({ id: 'telegram', status: 'skipped', detail: `container.network is none; the Telegram plugin needs api.telegram.org and the npm registry${opts.tokens?.telegram ? unused('telegram') : ''}`, later: LATER.telegram });
  } else {
    type TgAction = 'keep' | 'change' | 'disable' | 'setup' | 'reuse' | 'skip';
    let action: TgAction;
    if (opts.tokens?.telegram) action = tg ? 'change' : 'setup';
    else if (channel === 'telegram' && tg) {
      action = interactive ? await choose(io!, `Telegram is set up (bot ${tg.botId}). Keep it, change the bot token, or disable Telegram?`, 'keep', ['keep', 'change', 'disable'] as const) : 'keep';
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
        channel = 'telegram';
        step({ id: 'telegram', status: action === 'change' ? 'changed' : 'done',
          detail: `bot ${r.botId} stored in ${r.backend === 'keychain' ? 'the macOS Keychain' : 'a 0600 host file'}; communication.channel telegram`,
          ...(r.warnings.length ? { lines: r.warnings.map((w) => `warning: ${w}`) } : {}) });
      } catch (e) {
        step({ id: 'telegram', status: 'failed', detail: `${errMsg(e, 'could not store the token')}; nothing was stored, the coordinator stays terminal-only`, later: LATER.telegram });
      }
    } else if (action === 'reuse') {
      channel = 'telegram';
      step({ id: 'telegram', status: 'changed', detail: `using the stored bot ${tg!.botId}; communication.channel telegram` });
    } else if (action === 'disable') {
      channel = 'terminal';
      step({ id: 'telegram', status: 'changed', detail: 'communication.channel terminal; the bot token is kept (remove it with `minions auth telegram --remove`)', later: LATER.telegram });
    } else if (action === 'keep') {
      step({ id: 'telegram', status: 'kept', detail: `bot ${tg!.botId}; communication.channel telegram` });
    } else {
      step({ id: 'telegram', status: 'skipped', detail: channel === 'telegram' ? 'no bot token stored; the coordinator runs terminal-only' : 'terminal only', later: LATER.telegram });
    }
  }
  if (channel !== config.communication.channel) setLocal('communication.channel', channel);

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
  if (interactive) say('\n== Container ==');
  let ready = false;
  const start = !interactive || await yesNo(io!, 'Build and start the container, import the repository, and launch the coordinator now?', true);
  if (!start) {
    step({ id: 'container', status: 'skipped', detail: 'container not started', later: LATER.container });
  } else {
    try {
      const wasRunning = await opts.runtime.containerRunning(projectId);
      say('  Starting the container (the first run builds the runtime image; this can take a few minutes)…');
      await opts.runtime.start(projectId);
      step({ id: 'container', status: wasRunning ? 'kept' : 'done', detail: wasRunning ? 'already running; reused' : 'started' });

      if (await opts.runtime.repoPresent(projectId)) {
        const again = interactive && await yesNo(io!, `The repository is already imported. Import ${project.baseBranch} again (committed history only)?`, false);
        if (again) step(importStep(await opts.runtime.importRepo(projectId), 'changed'));
        else step({ id: 'import', status: 'kept', detail: 'repository already imported; run `minions import` to refresh it' });
      } else {
        say(`  Importing committed history of ${project.baseBranch} into the container…`);
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

  const telegramOn = config.communication.channel === 'telegram';
  const attach = start ? opts.runtime.attachCommand(projectId) : null;
  return {
    dryRun: false, projectId, rerun: priorId !== null, init, steps, localConfig: { path: localPath, changed }, ready,
    attach, attachStart: `cd ${shellQuote(init.plan.repoPath)} && minions start`, pairing: telegramOn ? PAIRING_STEPS : [],
    nextSteps: [
      ready ? `Attach to the coordinator: ${cmds.inRepo('minions start')} (or the command below); detach with Ctrl-b d, it keeps running.`
        : `Run ${cmds.inRepo('minions start')} to start the container and attach the coordinator.`,
      'First time only: log in to Claude inside the coordinator session with /login (your host login is not reused).',
      ...(telegramOn ? PAIRING_STEPS : []),
      `Run ${cmds.inRepo('minions doctor')} to check readiness at any time; rerun ${cmds.setup} to keep or change any of these choices.`,
    ],
  };
}

function importStep(r: ImportResult, status: StepStatus): SetupStep {
  const o = r.container.origin;
  return {
    id: 'import', status, detail: `${r.baseBranch} @ ${r.commit.slice(0, 12)}${o ? `; origin ${o.url} (${o.authenticated ? 'authenticated' : 'not authenticated'}, ${o.fetched ? 'base fetched' : 'not fetched'})` : ''}`,
    ...([...r.warnings, ...(o?.warnings ?? [])].length ? { lines: [...r.warnings, ...(o?.warnings ?? [])].map((w) => `warning: ${w}`) } : {}),
  };
}

/** CI step: local workflow files plus (with a token) required checks read with GET only; prints the plan. */
async function ciStep(opts: SetupOptions, config: MinionsConfig, remoteUrl: string | null, hasToken: boolean, projectId: string, ciWorkflows: string[]): Promise<SetupStep> {
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
  if (plan.length && state === 'unknown') lines.push('Required checks could not be read; follow the steps below if they are missing (rerun `minions doctor` to check).');
  lines.push(...plan);
  if (!plan.length) lines.push(`CI is in place. Set delivery.requiredChecksConfigured to true to record that these checks gate merging (setup does not change it).`);
  for (const l of lines) opts.io?.info(`  ${l}`);
  return { id: 'ci', status: 'done', detail: `${workflows.length} workflow file(s); required checks ${state}; nothing was changed`, lines };
}

function dryRunResult(opts: SetupOptions, init: InitResult, steps: SetupStep[], refs: CredentialsJson, rerun: boolean, localPath: string): SetupResult {
  const git = init.plan.discovery.git;
  const would = (id: StepId, detail: string) => steps.push({ id, status: 'planned', detail });
  would('github', !git.hasGitHub ? 'skipped: no github.com origin'
    : refs.github ? `token stored (${refs.github.backend}): would offer keep/change/remove` : opts.tokens?.github ? 'would store the token from stdin' : 'would ask "Set up GitHub integration?" (default no); token entered without echo');
  would('delivery', `delivery.mode ${opts.delivery ?? 'unchanged'}; branch/pull-request need a GitHub remote and a stored token`);
  would('ci', git.hasGitHub ? 'would ask "Use CI?" (default no): read-only check of workflows and required checks, setup plan printed only' : 'skipped: no GitHub remote');
  would('autoMerge', 'shown as not available yet (default no); nothing written');
  would('telegram', refs.telegram ? `bot ${refs.telegram.botId} stored: would offer keep/change/disable` : 'would ask "Set up Telegram?" (default no); bot token entered without echo');
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
