// `minions setup`: one guided command for the whole host-side setup (decision record:
// docs/design/bootstrap.md, "Guided setup").
//
// Order: init (mode first; Claude auth and git identity only when defaults.json does not answer them) -> Telegram (token + pairing guidance) -> agents (which harness does
// the work; src/host/harness-setup.ts) -> runtime start
// (container, or the host runtime), repository import, coordinator launch -> attach/pair instructions.
//
// - Reuses runInit (wizard, plan, apply), the credential provisioning of `auth telegram`, and (through
//   SetupRuntime) the start/import code of `minions start`.
// - Integration choices that differ from the project configuration (communication.channel, harnesses) go
//   into the host-only config.local.json, never into shared repo files. The mode decides local integration.
// - Secrets are read only through the non-echoing terminal prompt or from stdin (never argv), and never
//   appear in the result, the notes, or any prompt text.
import { rm } from 'node:fs/promises';
import type { MinionsConfig, Mode } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { readJsonIfExists, writeJson } from '../core/fsutil.js';
import { projectPaths } from '../core/paths.js';
import {
  backendLabel, provisionCodexKey, loadCredentialRefs, provisionTelegramToken, telegramBotGuidance, type CredentialsJson, type Fetch,
} from './credentials.js';
import type { DockerProbe } from './discovery.js';
import type { Runner } from './docker.js';
import { harnessStep } from './harness-setup.js';
import { formatPlan, runInit, type InitResult } from './install.js';
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
  mode?: Mode;
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
  tokens?: { telegram?: string };
  runtime: SetupRuntime;
  /** --runtime: forwarded to runInit (same semantics as `minions init --runtime`). */
  runtimeKind?: RuntimeKind;
  dockerProbe?: DockerProbe;
  runner?: Runner;
  fetch?: Fetch;
}

export type StepId = 'init' | 'telegram' | 'harness' | 'container' | 'import' | 'coordinator';
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
  '  2. On the host run: minions telegram access pair <code>',
  '  3. Then lock access to the allowlist: minions telegram access policy allowlist (pair only yourself).',
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
  if (opts.tokens?.telegram !== undefined && opts.tokens.telegram.trim() === '') {
    throw new MinionsError('PRECONDITION', '--telegram-token-stdin: no Telegram token was read from stdin (empty input); nothing was changed.',
      'Pipe the token as the first line of stdin, or omit --telegram-token-stdin.');
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
    path: opts.path, mode: opts.mode, visibility: opts.visibility, yes: !interactive, dryRun: opts.dryRun,
    configFile: opts.configFile, attach: opts.attach, newIdentity: opts.newIdentity, runtime: opts.runtimeKind,
    io: interactive ? io : undefined, skipIntegrations: true, reconfigure,
    dockerProbe: opts.dockerProbe, runner: opts.runner, fetch: opts.fetch,
  });
  const projectId = init.plan.projectId;
  const written = init.applied ? init.applied.written.length + init.applied.removed.length : 0;
  step({ id: 'init', status: opts.dryRun ? 'planned' : priorId ? (reconfigure || opts.configFile ? 'changed' : 'kept') : 'done',
    detail: opts.dryRun ? `would install project ${projectId} (${init.plan.visibility}, ${init.plan.mode})`
      : `project ${projectId} (${init.plan.visibility}, ${init.plan.mode}); ${written} file(s) written, ${init.applied?.unchanged ?? 0} unchanged` });

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
      ...(telegramOn ? PAIRING_STEPS : []),
      `Run ${cmds.inRepo('minions doctor')} to check readiness at any time; rerun ${cmds.setup} to keep or change any of these choices.`,
    ],
  };
}

function importStep(r: ImportResult, status: StepStatus): SetupStep {
  return { id: 'import', status, detail: `${r.baseBranch} @ ${r.commit.slice(0, 12)}`, ...(r.warnings.length ? { lines: r.warnings.map((w) => `warning: ${w}`) } : {}) };
}

function dryRunResult(init: InitResult, steps: SetupStep[], refs: CredentialsJson, rerun: boolean, localPath: string): SetupResult {
  const would = (id: StepId, detail: string) => steps.push({ id, status: 'planned', detail });
  would('telegram', refs.telegram ? `bot ${refs.telegram.botId} stored: would offer keep/change/disable` : 'would ask "Set up Telegram?" (default no); bot token entered without echo');
  would('harness', 'would ask "Which agent should do the work?" (default Claude Code; OpenAI Codex: OpenAI API key without echo, model, and in this version the read-only codex-reviewer stage after the Claude reviewer)');
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
