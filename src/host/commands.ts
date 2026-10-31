import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Option, type Command } from 'commander';
import { MODES, type Mode } from '../config/schema.js';
import { toMode } from '../config/modes.js';
import { action, globalOpts, requireMode, runtimeMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { CONTAINER, projectPaths } from '../core/paths.js';
import { PRE_RESTORE_KEEP, STATE_BACKUP_DIRS, STATE_BACKUP_FILES } from '../runtime/state-backup.js';
import { formatRecord, recordUpgradeRequest, withRequestDb } from '../runtime/change-requests.js';
import { registerAuth } from './auth-cli.js';
import { authOf, isKeyAuth, refreshKey, startRefreshTimer } from './auth.js';
import type { MinionsConfig } from '../config/schema.js';
import {
  backendLabel, clearSecrets, upClearingSecretsOnFailure, materializeSecrets, provisionTelegramToken,
  removeTelegramToken, telegramBotGuidance, codexKeyGuidance, provisionCodexKey, removeCodexKey,
} from './credentials.js';
import { assertBotFree, startBotCheck } from './bot-guard.js';
import { dockerProbe } from './discovery.js';
import { Compose, ensureAptImage, ensureImage, packageRoot, runtimeImageTag } from './docker.js';
import { describeAptChange, formatToolsReset, planAptPackages, readControlOverlay, syncAptPackages, toolsReset } from './tools.js';
import { applyDoctorExit, formatDoctor, runDoctor } from './doctor.js';
import { checkPlugin, dockerUnavailable, formatInit, pluginMismatch, refreshDerived, refreshForUpgrade, runInit } from './install.js';
import { loadEffectiveConfig, loadProjectJson, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { composeTarget, exportRepo, exportState, importRepo, importState, inspectStateBackup, type TransferTarget } from './transfer.js';
import { fastForwardBase } from './pull.js';
import { agentWritableDirs, hostUpgradeTarget } from './upgrade-host.js';
import { HOST_RUNTIME_WARNING, HostRuntime, RUNTIMES, prepareHostRuntime, requireHostTools, runtimeOf, type RuntimeKind } from './runtime.js';
import { registerRuntime } from './runtime-cli.js';
import { registerMode } from './mode-cli.js';
import { registerDefaults } from './defaults-cli.js';
import { HOST_CHANNEL_NOTE, formatChannelSet, hostChannel, offerAutoChannel, registerChannel } from './channel-cli.js';
import { formatChannel } from '../telegram/channel.js';
import { formatUninstall, runUninstall } from './uninstall.js';
import { formatSetup, runSetup, shellQuote, type SetupRuntime } from './setup.js';
import { DEFAULT_UPGRADE_TIMEOUT_SEC, formatUpgrade, runUpgrade, upgradeTimeout } from './upgrade.js';
import { HANDOFF_ENV, formatSyncOnly, isMinionsCheckout, runSourcePhase, runSyncOnly, upgradeSourceMode } from './upgrade-source.js';
import { readSecret, readlineIO } from './wizard.js';
import { addListCommand, addSetCommand, registerSettings } from './settings-cli.js';
import { registerSecrets } from './secrets-cli.js';

const say = (json: boolean, msg: string) => { if (!json) process.stderr.write(msg + '\n'); };

async function requireDocker(): Promise<void> {
  const s = await dockerProbe()();
  if (!s.daemon || !s.compose) throw dockerUnavailable(s);
}

/** Loads the project for cwd, refreshes derived files, and returns a compose handle. */
async function openProject(json: boolean, cwd: string = process.cwd()) {
  const { projectId } = await projectForPath(cwd);
  const project = await loadProjectJson(projectId);
  const eff = await loadEffectiveConfig(project);
  for (const w of await refreshDerived(project, eff.config)) say(json, `warning: ${w}`);
  return { project, config: eff.config, compose: new Compose(projectId) };
}

/** Writes the provisioned tokens into the mounted secrets dir; a store read failure only warns. */
async function materialize(json: boolean, projectId: string): Promise<void> {
  try { await materializeSecrets(projectId); } catch (e) {
    say(json, `warning: a stored token is not available to the container: ${e instanceof MinionsError ? e.message : 'credential store unreadable'}`);
  }
}

async function coordinatorSync(json: boolean, compose: Compose, opts: { startDetached: boolean }): Promise<unknown> {
  const r = await compose.exec(['minions', 'coordinator', 'sync', '--json', ...(opts.startDetached ? ['--start-detached'] : [])], { allowFailure: true, timeoutMs: 60_000 });
  let data: { action?: string; reason?: string } | undefined;
  try { data = (JSON.parse(r.stdout) as { ok: boolean; data?: typeof data }).data; } catch { /* below */ }
  if (r.code !== 0 || !data) { say(json, `warning: coordinator sync failed: ${lastLine(r.stdout, r.stderr)}`); return null; }
  if (data.action === 'restarted' || data.action === 'restart-pending' || data.action === 'started') say(json, `coordinator: ${data.action} (${data.reason})`);
  return data;
}

const lastLine = (...parts: string[]) => {
  const text = parts.filter(Boolean).join('\n');
  try { const e = JSON.parse(text.split('\n')[0] ?? '') as { error?: { message?: string } }; if (e.error?.message) return e.error.message; } catch { /* plain text */ }
  return text.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? 'no output';
};

async function readStdinSecret(): Promise<string> {
  return (await readStdinLines(1))[0] ?? '';
}

/** First `n` lines of piped stdin (tokens are never accepted from argv). */
async function readStdinLines(n: number): Promise<string[]> {
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', 'Token input on stdin expects a pipe, not a terminal.', 'Omit the stdin option to be prompted without echo.');
  let data = '';
  for await (const chunk of process.stdin) { data += String(chunk); if (data.length > 8192) break; }
  return data.split(/\r?\n/).slice(0, n);
}

/**
 * `minions setup` runtime steps, using the same code as `minions start` and `minions import`, for
 * the project's runtime (Docker container, or the host runtime when the project uses it).
 */
function setupRuntime(json: boolean, cwd: string): SetupRuntime {
  let opened: Awaited<ReturnType<typeof ensureUp>> | undefined;
  let hostOpened: Awaited<ReturnType<typeof ensureHost>> | undefined;
  const up = () => { if (!opened) throw new MinionsError('INTERNAL', 'container not started'); return opened; };
  const isHost = async (projectId: string) => runtimeOf(await loadProjectJson(projectId)) === 'host';
  return {
    kind: async (projectId) => ((await isHost(projectId)) ? 'host' : 'docker'),
    containerRunning: async (projectId) => ((await isHost(projectId))
      ? new HostRuntime(await loadProjectJson(projectId)).isRunning().catch(() => false)
      : new Compose(projectId).isRunning().catch(() => false)),
    async start(projectId) {
      if (await isHost(projectId)) hostOpened = await ensureHost(json, { provision: true, cwd });
      else opened = await ensureUp(json, { provision: true, cwd });
    },
    repoPresent: async () => (hostOpened ? hostRepoPresent(hostOpened.host) : repoPresent(up().compose)),
    importRepo: async () => {
      const repoPath = (await projectForPath(cwd)).repoPath;
      return hostOpened ? importRepo(hostOpened.project, { repoPath, target: hostOpened.host.transferTarget() }) : importRepo(up().project, { repoPath });
    },
    async launchCoordinator() {
      if (hostOpened) {
        // The host runtime has no Telegram: the session starts when the user attaches (`minions start`).
        const r = await hostOpened.host.exec(['minions', 'coordinator', 'sync', '--json'], { allowFailure: true, timeoutMs: 60_000 });
        try { return ((JSON.parse(r.stdout) as { data?: { action?: string; reason?: string } }).data ?? null); } catch {
          say(json, `warning: coordinator sync failed: ${lastLine(r.stdout, r.stderr)}`);
          return null;
        }
      }
      const p = up();
      await assertBotFree(p.project, p.config);
      const channel = await hostChannel(p.project, p.config);
      // Started detached so it runs (and Telegram works) with nobody attached; attaching comes after.
      return (await coordinatorSync(json, p.compose, { startDetached: true })) as { action?: string; reason?: string } | null;
    },
    attachCommand: (projectId) => {
      if (hostOpened) return hostOpened.host.attachCommand;
      const c = new Compose(projectId);
      return `docker compose -p ${c.name} -f ${shellQuote(c.file)} exec app minions coordinator`;
    },
  };
}

/**
 * Starts the container. For Claude key methods with `provision` the key is (re)obtained first and a
 * failure stops here with AUTH_REQUIRED. The project's tokens are then materialized into the same
 * secrets dir (which must exist: it is the bind source), and cleared again if `up` fails.
 * `compose up -d` recreates the container whenever compose.yaml changed (method, env, mounts).
 */
async function ensureUp(json: boolean, opts: { provision?: boolean; cwd?: string } = {}) {
  await requireDocker();
  const p = await openProject(json, opts.cwd);
  const auth = authOf(p.project);
  if (isKeyAuth(auth) && opts.provision) {
    say(json, `Refreshing the Claude key on the host (${auth.method === 'helper' ? `running \`${auth.command[0]}\`` : 'reading the configured source'})…`);
    await refreshKey(p.project.projectId, auth);
  }
  if (await ensureImage(p.project.imageTag, { onBuild: (m) => say(json, m) })) say(json, `Built ${p.project.imageTag}.`);
  // container.aptPackages (Decision 14): the coordinator's control value or the config's; a change gives a new image tag.
  const apt = await planAptPackages(p.project, p.config, () => readControlOverlay(p.project.projectId, p.project.imageTag, { compose: p.compose }));
  if (apt.warning) say(json, `warning: ${apt.warning}`);
  // A running container is never recreated for it here (that would cut off its workers): upgrade drains them first.
  if (apt.changed && await p.compose.isRunning().catch(() => true)) {
    say(json, `note: image rebuild pending: container.aptPackages changed (${describeAptChange(apt)}); \`minions upgrade\` applies it after draining the workers (or \`minions down\`, then \`minions start\`).`);
  } else if (apt.changed) {
    say(json, `Image rebuild: container.aptPackages changed (${describeAptChange(apt)}).`);
    p.project = await syncAptPackages(p.project, apt.desired);
    for (const w of await refreshDerived(p.project, p.config)) say(json, `warning: ${w}`);
  }
  if (await ensureAptImage(p.project.imageTag, p.project.container.aptPackages, { onBuild: (m) => say(json, m) })) say(json, `Built ${runtimeImageTag(p.project)}.`);
  await materialize(json, p.project.projectId);
  await upClearingSecretsOnFailure(p.compose, p.project.projectId);
  await p.compose.exec(['minions', 'workspace', 'setup', '--json'], { timeoutMs: 120_000 });
  return p;
}

/**
 * Host runtime counterpart of ensureUp: warning, host tools, Claude key (key methods), token copies,
 * shims, and the state layout. Nothing Docker-related runs.
 */
async function ensureHost(json: boolean, opts: { provision?: boolean; cwd?: string } = {}) {
  const p = await openProject(json, opts.cwd);
  process.stderr.write(HOST_RUNTIME_WARNING.join('\n') + '\n'); // always (stderr): also in --json mode
  await requireHostTools();
  const auth = authOf(p.project);
  if (isKeyAuth(auth) && opts.provision) {
    say(json, `Refreshing the Claude key on the host (${auth.method === 'helper' ? `running \`${auth.command[0]}\`` : 'reading the configured source'})…`);
    await refreshKey(p.project.projectId, auth);
  }
  const host = new HostRuntime(p.project);
  await prepareHostRuntime(p.project);
  await materialize(json, p.project.projectId);
  const setup = await host.exec(['minions', 'workspace', 'setup', '--json'], { allowFailure: true, timeoutMs: 120_000 });
  if (setup.code !== 0) throw new MinionsError('INTERNAL', `Host runtime state setup failed: ${lastLine(setup.stdout, setup.stderr)}`);
  return { ...p, host };
}

async function startHost(json: boolean, o: { attach: boolean }): Promise<void> {
  const { project, config, host } = await ensureHost(json, { provision: true });
  let imported: unknown = null;
  if (!(await hostRepoPresent(host))) {
    say(json, `Cloning committed history of ${project.baseBranch} into the host runtime workspace (${host.paths.workspace})…`);
    const r = await importRepo(project, { repoPath: (await projectForPath(process.cwd())).repoPath, target: host.transferTarget() });
    for (const w of r.warnings) say(json, `warning: ${w}`);
    imported = r;
  }
  // Telegram intended (telegram, or auto with a stored token): the minions channel server (task-6).
  const channel = await hostChannel(project, config);
  if (channel.wantsTelegram) say(json, `note: ${HOST_CHANNEL_NOTE}`);
  const attach = o.attach && !json && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const sync = await host.exec(['minions', 'coordinator', 'sync', '--json', ...(!attach && channel.wantsTelegram ? ['--start-detached'] : [])], { allowFailure: true, timeoutMs: 60_000 });
  let coordinator: unknown = null;
  try { coordinator = (JSON.parse(sync.stdout) as { data?: unknown }).data ?? null; } catch { say(json, `warning: coordinator sync failed: ${lastLine(sync.stdout, sync.stderr)}`); }
  if (!attach) {
    emit({ projectId: project.projectId, runtime: 'host', running: await host.isRunning(), imported, coordinator, workspace: host.paths.workspace, attach: host.attachCommand },
      { json, human: () => `Host runtime prepared (workspace ${host.paths.repo}). Run \`minions start\` in a terminal to attach the coordinator.` });
    return;
  }
  const auth = authOf(project);
  say(json, auth.method === 'login'
    ? `Attaching the coordinator (tmux server ${host.paths.tmuxSocket}, session "coordinator"). Claude Code uses your existing host login.`
    : `Attaching the coordinator (tmux server ${host.paths.tmuxSocket}, session "coordinator"). Claude uses the host-provisioned key.`);
  const stopRefresh = startRefreshTimer(project.projectId, auth, { onWarn: (line) => process.stderr.write(`\r\n${line}\r\n`) });
  try { process.exitCode = await host.execInherit(['minions', 'coordinator']); } finally { stopRefresh(); }
}

const hostRepoPresent = async (host: HostRuntime) =>
  (await host.exec(['git', '-C', host.paths.repo, 'rev-parse', '--git-dir'], { allowFailure: true, timeoutMs: 30_000 })).code === 0;

const repoPresent = async (compose: Compose) =>
  (await compose.exec(['git', '-C', CONTAINER.repo, 'rev-parse', '--git-dir'], { allowFailure: true, timeoutMs: 30_000 })).code === 0;

async function askLine(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(`${question} `)).trim(); } finally { rl.close(); }
}

/** Yes/no with yes as the default; null without a terminal. */
async function confirmDefaultYes(question: string): Promise<boolean> {
  return (await confirmOrNull(question)) ?? false;
}
async function confirmOrNull(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return !/^n(o)?$/i.test((await rl.question(`${question} `)).trim()); } finally { rl.close(); }
}

/** Yes/no; the default follows the (Y/n) / (y/N) marker; null without a terminal. */
async function confirmMarked(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question(`${question} `)).trim();
    return a ? /^y(es)?$/i.test(a) : /\(Y\/n\)/.test(question);
  } finally { rl.close(); }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(`${question} `)).trim()); } finally { rl.close(); }
}

/** Registers host commands on the root program. */
/** The running runtime's transfer target (no auto-start: a backup or restore needs the runtime already up). */
async function runningTarget(projectId: string): Promise<{ project: ProjectJson; target: TransferTarget; runtime: 'host' | 'docker' }> {
  const project = await loadProjectJson(projectId);
  if (runtimeOf(project) === 'host') {
    const host = new HostRuntime(project);
    if (!(await host.prepared())) throw new MinionsError('PRECONDITION', 'The host runtime has not been started for this project.', 'Run `minions start --no-attach` first.');
    await prepareHostRuntime(project);
    return { project, target: host.transferTarget(), runtime: 'host' };
  }
  await requireDocker();
  const compose = new Compose(projectId);
  if (!(await compose.isRunning())) throw new MinionsError('PRECONDITION', 'The project container is not running.', 'Run `minions start --no-attach` first.');
  return { project, target: composeTarget(compose), runtime: 'docker' };
}

async function exportStateCommand(out: string | undefined, o: { json: boolean; dryRun: boolean }): Promise<void> {
  const { projectId } = await projectForPath(process.cwd());
  if (o.dryRun) {
    emit({ dryRun: true, archive: out ? resolvePath(out) : `${projectPaths(projectId).exportsDir}/state-<time>.tar.gz`, includes: [...STATE_BACKUP_DIRS, ...STATE_BACKUP_FILES, 'minions.db (snapshot)'],
      excludes: ['secrets and tokens', 'the Claude login', 'import/', 'exports/', 'logs/', 'cache/', 'the workspace (use `minions export` for branches)'] }, { json: o.json });
    return;
  }
  const { project, target } = await runningTarget(projectId);
  const r = await exportState(project, { out, target });
  emit(r, { json: o.json, human: (d: typeof r) => [`State backup: ${d.archive} (${d.files} files, ${d.bytes} bytes, schema ${d.schemaVersion})`,
    ...d.skipped.map((s) => `  skipped ${s.path}: ${s.reason}`),
    ...(d.activeLeases ? [`warning: ${d.activeLeases} worker lease(s) were active; their in-flight work is not in the backup.`] : []),
    `Restore with: minions import --state ${d.archive}`].join('\n') });
}

async function importStateCommand(file: string, o: { force: boolean; json: boolean; dryRun: boolean }): Promise<void> {
  const { projectId } = await projectForPath(process.cwd());
  if (o.dryRun) {
    const { archive, manifest } = await inspectStateBackup(file);
    emit({ dryRun: true, archive, valid: true, createdAt: manifest.createdAt, minionsVersion: manifest.minionsVersion, schemaVersion: manifest.schemaVersion, files: manifest.files.length, force: o.force },
      { json: o.json, human: () => `Would restore ${manifest.files.length} files from a valid backup of ${manifest.createdAt} (schema ${manifest.schemaVersion}); the current state would be kept under <state>/pre-restore/ (the newest ${PRE_RESTORE_KEEP} copies are kept).` });
    return;
  }
  // Validate before touching the runtime (importState validates again before copying).
  await inspectStateBackup(file);
  const { project, target, runtime } = await runningTarget(projectId);
  const r = await importState(project, file, { force: o.force, target });
  emit(r, { json: o.json, human: (d: typeof r) => [`Restored ${d.files} files into the ${runtime === 'host' ? 'host runtime' : 'container'} state from ${d.archive} (backup of ${d.createdAt}).`,
    ...(d.container.previous ? [`Previous state kept in ${d.container.previous} (inside the runtime).`] : []),
    ...(d.container.releasedLeases?.length ? [`Released restored lease(s): ${d.container.releasedLeases.join(', ')}`] : []),
    ...d.container.warnings.map((w) => `warning: ${w}`)].join('\n') });
}

/** `--profile` (before the two modes): the old names, read as the mode they map to. */
function legacyProfile(v: string): Mode {
  const m = toMode(v);
  if (!m) throw new MinionsError('INVALID_CONFIG', `Unknown profile "${v}".`, 'Use --mode independent or --mode supervised.');
  return m;
}

export function register(program: Command): void {
  const auth = registerAuth(program, async (plan) => { process.stderr.write(plan + '\n'); return confirm('Apply? (y/n)'); }, {
    // `auth set login --headless-token` (task-96): the token is read only here, from the host terminal (no echo) or a pipe; never from argv.
    readHeadlessToken: async ({ stdin }) => stdin ? readStdinSecret()
      : process.stdin.isTTY ? readSecret('Headless Claude token from `claude setup-token` (input hidden): ')
        : (() => { throw new MinionsError('PRECONDITION', 'No terminal to prompt for the headless token.', 'Run in a terminal, or pipe it: `minions auth set login --headless-token --stdin --yes < token-file`.'); })(),
    // A copy into a running container's secrets mount applies at once (live runs read the file at each start).
    applySecrets: async (projectId) => {
      const project = await loadProjectJson(projectId);
      if (runtimeOf(project) === 'host') return 'not-running'; // live runs are Docker-runtime only
      const vis = await new Compose(projectId).secretsVisibility();
      if (vis === 'mounted') await materialize(true, projectId);
      return vis;
    },
  });
  program.command('init [path]')
    .description('Inspect a Git repository, propose an install plan, apply it, and verify the runtime')
    .addOption(new Option('--mode <mode>', 'independent (the agents run the project) or supervised (you review and merge all code); asked first when omitted').choices([...MODES]))
    .addOption(new Option('--profile <profile>').hideHelp().argParser(legacyProfile))
    .option('--private', 'private install: nothing is written into the repository')
    .option('--shared', 'shared install: writes .minions/config.json and .minions/README.md')
    .option('-y, --yes', 'accept defaults without prompting')
    .option('--config <file>', 'use a validated config file instead of the wizard')
    .option('--dry-run', 'show the plan without writing anything')
    .option('--attach', 'attach this repository to the project id in .minions/config.json')
    .option('--new-identity', 'create a new project identity for this repository')
    .addOption(new Option('--runtime <runtime>', 'agent runtime: docker (default) or host (no Docker, less safe; prints a warning)').choices([...RUNTIMES]))
    .action(action(async (path: string | undefined, o: { mode?: Mode; profile?: Mode; private?: boolean; shared?: boolean; yes?: boolean; config?: string; dryRun?: boolean; attach?: boolean; newIdentity?: boolean; runtime?: RuntimeKind }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      if (o.private && o.shared) throw new MinionsError('INVALID_CONFIG', '--private and --shared are mutually exclusive.');
      const interactive = !o.yes && !o.config && !json && process.stdin.isTTY;
      if (!o.yes && !o.config && !interactive && !o.dryRun) {
        throw new MinionsError('PRECONDITION', 'init needs a terminal for the wizard.', 'Pass --yes to accept defaults or --config <file>.');
      }
      const io = interactive ? readlineIO() : undefined;
      try {
        const r = await runInit({
          path: resolvePath(path ?? '.'), mode: o.mode ?? o.profile, visibility: o.private ? 'private' : o.shared ? 'shared' : undefined,
          yes: !interactive, configFile: o.config ? resolvePath(o.config) : undefined, dryRun: o.dryRun,
          attach: o.attach, newIdentity: o.newIdentity, io, runtime: o.runtime,
        });
        emit(r, { json, human: formatInit });
      } finally { io?.close?.(); }
    }));

  program.command('setup [path]')
    .description('Guided end-to-end setup: init wizard, local integration, Telegram, runtime start, import, coordinator')
    .addOption(new Option('--mode <mode>', 'independent (the agents run the project) or supervised (you review and merge all code); asked first when omitted').choices([...MODES]))
    .addOption(new Option('--profile <profile>').hideHelp().argParser(legacyProfile))
    .option('--private', 'private install: nothing is written into the repository')
    .option('--shared', 'shared install: writes .minions/config.json and .minions/README.md')
    .option('-y, --yes', 'non-interactive: accept defaults (optional integrations off unless a token is piped)')
    .option('--dry-run', 'show what setup would do without writing, prompting for secrets, or starting anything')
    .option('--telegram-token-stdin', 'read the Telegram bot token from the first line of piped stdin')
    // Same semantics as `minions init` (install.sh passes init options through to setup).
    .option('--config <file>', 'use a validated config file instead of the init wizard (skips the questions it covers)')
    .option('--attach', 'attach this repository to the project id in .minions/config.json')
    .option('--new-identity', 'create a new project identity for this repository')
    .addOption(new Option('--runtime <runtime>', 'agent runtime: docker (default) or host (no Docker, less safe; prints a warning)').choices([...RUNTIMES]))
    .option('--no-attach-coordinator', 'do not offer to attach the coordinator at the end')
    .action(action(async (path: string | undefined, o: { mode?: Mode; profile?: Mode; private?: boolean; shared?: boolean; yes?: boolean; dryRun?: boolean; telegramTokenStdin?: boolean; config?: string; attach?: boolean; newIdentity?: boolean; runtime?: RuntimeKind; attachCoordinator: boolean }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      if (o.private && o.shared) throw new MinionsError('INVALID_CONFIG', '--private and --shared are mutually exclusive.');
      const piped = !!o.telegramTokenStdin;
      const interactive = !o.yes && !o.dryRun && !json && !piped && !!process.stdin.isTTY;
      // Like init, --config is a non-interactive alternative to --yes (token questions then need stdin).
      if (!o.yes && !o.config && !o.dryRun && !interactive) {
        throw new MinionsError('PRECONDITION', 'setup needs a terminal for its questions.', 'Pass --yes to accept the defaults or --config <file> (the Telegram token can be piped with --telegram-token-stdin), or --dry-run.');
      }
      const target = resolvePath(path ?? '.');
      let tokens: { telegram?: string } | undefined;
      // A missing line is an empty token: runSetup rejects it instead of silently skipping the step.
      if (piped && !o.dryRun) tokens = { telegram: (await readStdinLines(1))[0] ?? '' };
      const io = interactive ? readlineIO() : undefined;
      try {
        const r = await runSetup({
          path: target, mode: o.mode ?? o.profile, visibility: o.private ? 'private' : o.shared ? 'shared' : undefined,
          yes: !interactive, dryRun: o.dryRun, io, tokens, runtime: setupRuntime(json, target),
          configFile: o.config ? resolvePath(o.config) : undefined, attach: o.attach, newIdentity: o.newIdentity, runtimeKind: o.runtime,
        });
        emit(r, { json, human: formatSetup });
        if (r.steps.some((s) => s.status === 'failed')) process.exitCode = 1;
        const tty = interactive && !!process.stdout.isTTY && !!io;
        // The coordinator is a TUI in tmux: attaching needs a terminal (compose exec allocates a TTY).
        if (r.ready && tty && o.attachCoordinator && /^y(es)?$/i.test(await io!.ask('Attach to the coordinator now? (y/n)', 'y'))) {
          io!.close?.();
          const project = await loadProjectJson(r.projectId);
          if (runtimeOf(project) === 'host') {
            // Same path as `minions start` in the host runtime (dedicated tmux server, key refresh timer).
            process.chdir(r.init.plan.repoPath);
            await startHost(json, { attach: true });
          } else {
            say(json, authOf(project).method === 'login'
              ? 'Attaching the coordinator (tmux session "coordinator"; detach with Ctrl-b d). On first start, log in to Claude with /login.'
              : 'Attaching the coordinator (tmux session "coordinator"; detach with Ctrl-b d). Claude uses the host-provisioned key.');
            const stopRefresh = startRefreshTimer(project.projectId, authOf(project), { onWarn: (line) => process.stderr.write(`\r\n${line}\r\n`) });
            try { process.exitCode = await new Compose(r.projectId).execInherit(['minions', 'coordinator'], { tty: true }); } finally { stopRefresh(); }
          }
        }
      } finally { io?.close?.(); }
    }));

  program.command('doctor')
    .description('Check host tools, Docker, the container, Claude auth, and configuration')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      const r = await runDoctor({ cwd: process.cwd() });
      emit(r, { json, human: formatDoctor });
      applyDoctorExit(r);
    }));

  program.command('start')
    .description('Start the agent runtime (container, or the host runtime), import the repo, and attach the coordinator')
    .option('--no-attach', 'start the runtime without attaching to the coordinator')
    .action(action(async (o: { attach: boolean }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      const { projectId } = await projectForPath(process.cwd());
      const registered = await loadProjectJson(projectId);
      if (runtimeOf(registered) === 'host') return startHost(json, o);
      // One bot, one coordinator: refuse before anything starts (terminal mode is never refused). When
      // this project's own coordinator already runs, attaching adds no poller: warn and attach only.
      const bot = await startBotCheck(registered, (await loadEffectiveConfig(registered)).config);
      if (bot.action === 'attach-existing') say(json, bot.warning);
      const attachOnly = bot.action === 'attach-existing';
      const { project, compose, config } = await ensureUp(json, { provision: true });
      let imported: unknown = null;
      if (!(await repoPresent(compose))) {
        say(json, `Importing committed history of ${project.baseBranch} into the container…`);
        const r = await importRepo(project, { repoPath: (await projectForPath(process.cwd())).repoPath });
        for (const w of r.warnings) say(json, `warning: ${w}`);
        imported = r;
      }
      // The coordinator is a TUI in tmux: attaching needs a terminal (compose exec allocates a TTY).
      const attach = o.attach && !json && !!process.stdin.isTTY && !!process.stdout.isTTY;
      // Telegram must work with nobody attached: start the session detached in that case.
      const channel = await hostChannel(project, config);
      if (channel.degraded) say(json, `warning: Telegram is off: ${channel.reason}; the coordinator starts terminal-only.`);
      // attachOnly: never sync/relaunch the running coordinator onto a bot another project polls.
      const coordinator = attachOnly ? { action: 'unchanged', reason: 'bot conflict: the running coordinator was left unchanged' }
        : await coordinatorSync(json, compose, { startDetached: !attach && channel.wantsTelegram });
      if (!attach) {
        emit({ projectId: project.projectId, runtime: 'docker', running: true, imported, coordinator, attach: `docker compose -p ${compose.name} -f ${compose.file} exec ${'app'} minions coordinator` },
          { json, human: () => `Container ${compose.name} is running. Run \`minions start\` in a terminal to attach the coordinator.` });
        return;
      }
      const auth = authOf(project);
      say(json, auth.method === 'login'
        ? 'Attaching the coordinator (tmux session "coordinator"). On first start, log in to Claude with /login.'
        : 'Attaching the coordinator (tmux session "coordinator"). Claude uses the host-provisioned key.');
      const stopRefresh = startRefreshTimer(project.projectId, auth, { onWarn: (line) => process.stderr.write(`\r\n${line}\r\n`) });
      // attachOnly: plain tmux attach (never `new-session -A`), so a session that ended meanwhile is not relaunched.
      const attachArgv = attachOnly ? ['tmux', 'attach-session', '-t', 'coordinator'] : ['minions', 'coordinator'];
      try { process.exitCode = await compose.execInherit(attachArgv, { tty: true }); } finally { stopRefresh(); }
    }));

  program.command('upgrade')
    .description('Upgrade the project container (or the host runtime: plugin and shims) to the installed minions (drains workers, keeps volumes); in the runtime: record an upgrade request for the owner')
    .option('--timeout <seconds>', `wait this long for active workers (default ${DEFAULT_UPGRADE_TIMEOUT_SEC}; 0 with --now)`)
    .option('--now', 'release workers still active when the wait ends (reported as interrupted, re-dispatched after)')
    .option('--from-container [branch]', 'first export the container branches and fast-forward <branch> (default: the base branch) to minions/<base>; strict fast-forward on a clean tree only')
    .option('--rebuild-cli', 'in a minions checkout: allow rebuilding/reinstalling the global CLI from it (runs its npm scripts and build on the host; review it first)')
    .option('--sync-only', 'only the source sync: export the container branches and fast-forward the base branch; no CLI or container steps')
    .option('--dry-run', 'list the steps without changing anything')
    .option('--reason <text>', 'runtime: why the upgrade is needed (shown to the owner)')
    .action(action(async (o: { timeout?: string; now?: boolean; fromContainer?: string | boolean; rebuildCli?: boolean; syncOnly?: boolean; reason?: string }, cmd: Command) => {
      const { json, dryRun } = globalOpts(cmd);
      if (runtimeMode() !== 'host') {
        // The container can only propose: record a request; the owner applies it on the host.
        const hostOnly = [o.timeout !== undefined ? '--timeout' : null, o.now ? '--now' : null, o.rebuildCli ? '--rebuild-cli' : null, o.syncOnly ? '--sync-only' : null].filter(Boolean);
        if (hostOnly.length) {
          throw new MinionsError('PRECONDITION', `${hostOnly.join(', ')}: not available in an upgrade request (the owner picks how to drain, and a CLI rebuild is never requested from the container).`, 'Request `minions upgrade [--from-container [branch]] --reason <text>`.');
        }
        const r = await withRequestDb((db) => recordUpgradeRequest(db, { fromContainer: o.fromContainer, reason: o.reason, dryRun }));
        emit(r, { json, human: formatRecord });
        return;
      }
      if (o.reason !== undefined) throw new MinionsError('PRECONDITION', '--reason is for upgrade requests recorded in the runtime; on the host the upgrade runs directly.');
      if (o.syncOnly) { await upgradeSyncOnly(o, { json, dryRun }); return; }
      const timeoutSec = upgradeTimeout(o.timeout, !!o.now);
      const ref = await projectForPath(process.cwd());
      const project = await loadProjectJson(ref.projectId);
      // Host runtime (task-7): no image or container; the same phases run through the shim (src/host/upgrade-host.ts).
      const hostRt = runtimeOf(project) === 'host' ? new HostRuntime(project) : null;
      const hostTarget = hostRt ? hostUpgradeTarget(project, hostRt) : null;
      if (!dryRun && !hostRt) await requireDocker();
      const compose = hostRt ? null : new Compose(project.projectId);
      // The rest of the upgrade, as run again by the new CLI after a reinstall (or by the user after a stop).
      const checkout = isMinionsCheckout(ref.repoPath) ? ref.repoPath : null;
      const mode = upgradeSourceMode({ fromContainer: o.fromContainer !== undefined, checkout });
      const flags = [...(o.timeout !== undefined ? ['--timeout', String(timeoutSec)] : []), ...(o.now ? ['--now'] : [])];
      // container.aptPackages after the files step (Decision 14): the image step builds the derived image for them.
      let aptPackages = project.container.aptPackages;
      const r = await runUpgrade({
        source: () => runSourcePhase({
          dryRun, handoff: process.env[HANDOFF_ENV] === '1', rebuildCli: !!o.rebuildCli, runningRoot: packageRoot(), log: (m) => say(json, m),
          checkout,
          sync: mode !== 'container' ? null : {
            repo: ref.repoPath, baseBranch: project.baseBranch,
            branch: typeof o.fromContainer === 'string' ? o.fromContainer : project.baseBranch,
            exportRepo: async () => {
              if (hostRt) {
                if (!(await hostRt.prepared())) throw new MinionsError('PRECONDITION', '--from-container needs the host runtime started (it exports from it).', 'Run `minions start --no-attach`, or upgrade without --from-container.');
                // Refuse before touching anything (the shim included): the preflight in runUpgrade only runs after this
                // source phase. The shim is left as it is here; the transfer target creates its own dirs.
                const problem = await hostTarget!.cliProblem();
                if (problem) throw new MinionsError('PRECONDITION', `Upgrade not started: ${problem}.`);
                return exportRepo(project, { repoPath: ref.repoPath, target: hostRt.transferTarget() });
              }
              if (!(await compose!.isRunning())) throw new MinionsError('PRECONDITION', '--from-container needs the project container running (it exports from it).', 'Run `minions start --no-attach`, or upgrade without --from-container.');
              return exportRepo(project, { repoPath: ref.repoPath, compose: compose! });
            },
          },
          ...(hostRt ? { agentWritable: agentWritableDirs(project.projectId) } : {}),
          continueArgs: ['--json', 'upgrade', ...flags],
          rerun: ['minions', 'upgrade', ...flags].join(' '),
        }),
        projectId: project.projectId, imageTag: project.imageTag, timeoutSec, now: o.now, dryRun,
        ...(hostTarget ? { host: hostTarget } : { compose: compose!, importRepo: () => importRepo(project, { repoPath: ref.repoPath }) }),
        refresh: async () => {
          if (hostRt) return refreshForUpgrade(project);
          const apt = await planAptPackages(project, (await loadEffectiveConfig(project)).config,
            () => readControlOverlay(project.projectId, project.imageTag, { compose: compose! }));
          if (apt.changed) say(json, `Image rebuild: container.aptPackages changed (${describeAptChange(apt)}).`);
          const next = apt.changed ? await syncAptPackages(project, apt.desired) : project;
          aptPackages = next.container.aptPackages;
          return [...(apt.warning ? [apt.warning] : []), ...await refreshForUpgrade(next)];
        },
        aptPackages: () => aptPackages,
        checkPlugin: async () => pluginMismatch(await checkPlugin(project, (await loadEffectiveConfig(project)).config)),
        materialize: () => materializeSecrets(project.projectId),
        log: (m) => say(json, m),
      });
      emit(r, { json, human: formatUpgrade });
      if (!r.ok) process.exitCode = 1;
    }));

  /** `minions upgrade --sync-only`: the source sync alone. */
  async function upgradeSyncOnly(o: { timeout?: string; now?: boolean; fromContainer?: string | boolean; rebuildCli?: boolean }, g: { json: boolean; dryRun: boolean }): Promise<void> {
    if (o.timeout !== undefined || o.now || o.rebuildCli) throw new MinionsError('PRECONDITION', '--sync-only takes no --timeout, --now or --rebuild-cli (it moves no container and builds nothing).');
    const ref = await projectForPath(process.cwd());
    const project = await loadProjectJson(ref.projectId);
    const exportFrom = async () => {
      if (runtimeOf(project) === 'host') {
        const host = new HostRuntime(project);
        if (!(await host.prepared())) throw new MinionsError('PRECONDITION', 'The host runtime has not been started for this project, so there is nothing to export.', 'Run `minions start --no-attach` first.');
        await prepareHostRuntime(project);
        return exportRepo(project, { repoPath: ref.repoPath, target: host.transferTarget() });
      }
      await requireDocker();
      const compose = new Compose(project.projectId);
      if (!(await compose.isRunning())) throw new MinionsError('PRECONDITION', 'The sync needs the project container running (it exports from it).', 'Run `minions start --no-attach` first.');
      return exportRepo(project, { repoPath: ref.repoPath, compose });
    };
    const r = await runSyncOnly({
      dryRun: g.dryRun,
      sync: { repo: ref.repoPath, baseBranch: project.baseBranch, branch: typeof o.fromContainer === 'string' ? o.fromContainer : project.baseBranch, exportRepo: exportFrom },
    });
    emit(r, { json: g.json, human: formatSyncOnly });
    if (!r.ok) process.exitCode = 1;
  }

  program.command('down').alias('stop')
    .description('Stop the agent runtime: remove the container (volumes kept) or stop the host runtime tmux server')
    .option('--dry-run', 'show what would be stopped')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const { projectId } = await projectForPath(process.cwd());
      const project = await loadProjectJson(projectId);
      if (runtimeOf(project) === 'host') {
        const host = new HostRuntime(project);
        const was = dryRun ? false : await host.down();
        if (!dryRun) await clearSecrets(projectId);
        emit({ projectId, runtime: 'host', stopped: !dryRun, wasRunning: was, dryRun }, { json, human: () => dryRun
          ? `Would stop the host runtime (tmux server ${host.paths.tmuxSocket}) and remove the materialized token copies.`
          : `Stopped the host runtime (tmux server ${host.paths.tmuxSocket}${was ? '' : ', was not running'}); workspace and state kept in ${host.paths.root}.` });
        return;
      }
      const compose = new Compose(projectId);
      if (!dryRun) { await requireDocker(); await compose.down(); await clearSecrets(projectId); }
      emit({ projectId, runtime: 'docker', stopped: !dryRun, dryRun }, { json, human: () => dryRun ? `Would stop ${compose.name}.` : `Stopped ${compose.name}; volumes kept.` });
    }));

  const tools = program.command('tools').description('Docker runtime: the persistent tools volume (/opt/tools) where agents install toolchains');
  tools.command('reset')
    .description('Delete the tools volume so agent-installed toolchains start over (the container must be stopped; --yes stops it)')
    .option('-y, --yes', 'stop a running container without asking')
    .option('--dry-run', 'show what would be deleted')
    .action(action(async (o: { yes?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const project = await loadProjectJson((await projectForPath(process.cwd())).projectId);
      if (runtimeOf(project) === 'host') {
        throw new MinionsError('INCOMPATIBLE_RUNTIME', '`minions tools reset` is for the Docker runtime: the host runtime uses the tools installed on this machine.', 'Remove a host toolchain with its own uninstaller.');
      }
      await requireDocker();
      const r = await toolsReset(project, { yes: !!o.yes, dryRun, confirm: confirmMarked, afterStop: () => clearSecrets(project.projectId) });
      emit(r, { json, human: formatToolsReset });
    }));

  program.command('import')
    .description('Import committed history of the base branch into the runtime workspace (git bundle); with --state, restore a state backup instead')
    .option('--state <file>', 'restore runtime state (backlog, notes, briefs, results, runtime DB) from a backup written by `minions export --state`')
    .option('--force', 'with --state: restore even while worker leases are active or the coordinator holds the project lock')
    .option('--dry-run', 'show what would be imported')
    .action(action(async (o: { state?: string; force?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      if (o.force && !o.state) throw new MinionsError('PRECONDITION', '--force applies only to --state.', 'Use `minions import --state <file> --force`.');
      if (o.state) return importStateCommand(o.state, { force: !!o.force, json, dryRun });
      if (dryRun) {
        const { projectId } = await projectForPath(process.cwd());
        const p = await loadProjectJson(projectId);
        emit({ dryRun: true, baseBranch: p.baseBranch, note: 'committed history only; dirty, untracked and ignored files are not imported' }, { json });
        return;
      }
      const { projectId } = await projectForPath(process.cwd());
      const isHost = runtimeOf(await loadProjectJson(projectId)) === 'host';
      const r = isHost
        ? await (async () => { const h = await ensureHost(json); return importRepo(h.project, { repoPath: (await projectForPath(process.cwd())).repoPath, target: h.host.transferTarget() }); })()
        : await (async () => { const { project } = await ensureUp(json); return importRepo(project, { repoPath: (await projectForPath(process.cwd())).repoPath }); })();
      emit(r, { json, human: (d: typeof r) => [`Imported ${d.baseBranch} @ ${d.commit.slice(0, 12)} into the ${isHost ? 'host runtime workspace' : 'container'}.`,
        ...d.warnings.map((w) => `warning: ${w}`)].join('\n') });
    }));

  // `minions pull` (docs/design/autonomy.md Decision 13); a bare `minions export` is `pull --no-ff-main`.
  const pull = async (json: boolean, dryRun: boolean, ffMain: boolean) => {
    const ref = await projectForPath(process.cwd());
    if (dryRun) { emit({ dryRun: true, target: 'refs/remotes/minions/*', ffMain }, { json }); return; }
    const project = await loadProjectJson(ref.projectId);
    let r;
    if (runtimeOf(project) === 'host') {
      const host = new HostRuntime(project);
      if (!(await host.prepared())) throw new MinionsError('PRECONDITION', 'The host runtime has not been started for this project.', 'Run `minions start --no-attach` first.');
      await prepareHostRuntime(project);
      r = await exportRepo(project, { repoPath: ref.repoPath, target: host.transferTarget() });
    } else {
      await requireDocker();
      const compose = new Compose(ref.projectId);
      if (!(await compose.isRunning())) throw new MinionsError('PRECONDITION', 'The project container is not running.', 'Run `minions start --no-attach` first.');
      r = await exportRepo(project, { repoPath: ref.repoPath, compose });
    }
    const ff = ffMain ? await fastForwardBase(ref.repoPath, project.baseBranch) : null;
    const out = { ...r, ff };
    const name = (full: string) => full.replace(/^refs\/remotes\//, '');
    emit(out, { json, human: (d: typeof out) => [
      ...(d.changes.length ? d.changes.map((c) => `  ${name(c.ref)}: ${c.from?.slice(0, 12) ?? '(new)'} -> ${c.to?.slice(0, 12) ?? '(deleted)'}`) : ['  no ref changes']),
      d.tasks.length ? `Delivered/landed tasks (git merge <ref>): ${d.tasks.map((t) => name(t.ref)).join(', ')}` : 'No delivered or landed task branches.',
      d.ff ? `${project.baseBranch}: ${d.ff.applied ? `fast-forwarded (${d.ff.reason})` : `${d.ff.action === 'up-to-date' ? 'up to date' : 'not moved'}: ${d.ff.reason}`}` : `${project.baseBranch}: not touched (--no-ff-main); minions/${project.baseBranch} has the agents' base`,
      d.ff?.applied ? 'No other local branch was modified.' : 'Local branches and the working tree were not modified.'].join('\n') });
  };

  program.command('pull')
    .description('Fetch the agents\' branches into refs/remotes/minions/* (delivered and landed tasks as minions/task-<id>, the agents\' base as minions/<base>), then fast-forward your base branch to it when the checkout is clean and on it')
    .option('--no-ff-main', 'only fetch; never move the base branch')
    .option('--dry-run', 'show what would be fetched')
    .action(action(async (o: { ffMain: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      await pull(json, dryRun, o.ffMain);
    }));

  program.command('export')
    .description('Same as `minions pull --no-ff-main` (fetch agent branches, non-destructive); with --state, write a state backup instead')
    .option('--state [file]', 'write a backup of the runtime state (backlog, notes, briefs, results, runtime DB snapshot; no secrets, no Claude login) to <file> (default: <project>/exports/state-<time>.tar.gz)')
    .option('--dry-run', 'show what would be exported')
    .action(action(async (o: { state?: string | boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      if (o.state !== undefined) return exportStateCommand(typeof o.state === 'string' ? o.state : undefined, { json, dryRun });
      await pull(json, dryRun, false);
    }));

  auth.command('telegram')
    .description('Store the Telegram bot token (prompted without echo; Keychain or a 0600 host file)')
    .option('--stdin', 'read the token from piped stdin instead of the terminal prompt')
    .option('--verify', 'check the token with the Telegram Bot API (getMe) before storing it')
    .option('--remove', 'delete the stored token and its reference')
    .option('--dry-run', 'show the guidance and storage location without prompting')
    .action(action(async (o: { stdin?: boolean; verify?: boolean; remove?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const ref = await projectForPath(process.cwd());
      const project = await loadProjectJson(ref.projectId);
      const compose = new Compose(project.projectId);
      // A token change is restart-required: apply it to a running container with a controlled restart.
      let needsRestart = false;
      const apply = async () => {
        const vis = await compose.secretsVisibility();
        if (vis === 'not-running') return false;
        if (vis === 'restart-required') { needsRestart = true; return false; } // a copy would not reach it
        await materialize(json, project.projectId);
        const eff = await loadEffectiveConfig(project).catch(() => undefined);
        // One bot, one coordinator: do not (re)launch onto a bot another project's coordinator polls.
        const busy = eff ? await assertBotFree(project, eff.config).then(() => null, (e: unknown) => e) : null;
        if (busy) {
          say(json, `warning: ${busy instanceof MinionsError ? busy.message : 'bot check failed'} The running coordinator was left unchanged.`);
          return true;
        }
        await coordinatorSync(json, compose, { startDetached: eff ? (await hostChannel(project, eff.config)).wantsTelegram : false });
        return true;
      };
      if (o.remove) {
        const r = dryRun ? { removed: false, backend: null } : await removeTelegramToken(project.projectId);
        const applied = !dryRun && r.removed ? await apply() : false;
        emit({ projectId: project.projectId, dryRun, ...r, appliedToRunningContainer: applied, ...(needsRestart ? { restartRequired: true } : {}) }, { json, human: () => dryRun ? 'Would remove the stored Telegram bot token.'
          : r.removed ? `Removed the Telegram bot token (${r.backend}).${applied ? ' The coordinator now runs terminal-only.' : ''}` : 'No Telegram bot token was stored.' });
        return;
      }
      const guidance = telegramBotGuidance();
      if (dryRun) { emit({ projectId: project.projectId, dryRun: true, guidance, mountedPath: CONTAINER.telegramTokenFile }, { json, human: () => guidance.join('\n') }); return; }
      say(json, guidance.join('\n'));
      // The token is read only here, from the host terminal (no echo) or a pipe; never from argv.
      const token = o.stdin ? await readStdinSecret()
        : process.stdin.isTTY ? await readSecret('Telegram bot token (input hidden): ')
          : (() => { throw new MinionsError('PRECONDITION', 'No terminal to prompt for the token.', 'Run in a terminal, or pipe it: `minions auth telegram --stdin < token-file`.'); })();
      const r = await provisionTelegramToken({ projectId: project.projectId, token, repoPath: ref.repoPath, verify: !!o.verify });
      // Explicit "terminal" would leave the token unused: offer auto (same path as `minions channel set auto`).
      const interactive = !o.stdin && !json && !!process.stdin.isTTY;
      const channel = await offerAutoChannel(project, { interactive, confirm: confirmDefaultYes });
      const applied = await apply();
      const eff = await loadEffectiveConfig(project).catch(() => undefined);
      const resolved = eff ? await hostChannel(project, eff.config) : null;
      emit({ ...r, mountedPath: CONTAINER.telegramTokenFile, appliedToRunningContainer: applied, ...(needsRestart ? { restartRequired: true } : {}),
        channel: { configured: resolved?.configured ?? channel.configured, effective: resolved?.effective ?? 'terminal', reason: resolved?.reason ?? null, switchedToAuto: channel.switched, hint: channel.hint } }, { json, human: () => [
        `Stored the Telegram bot token for bot ${r.botId} in ${backendLabel(r.backend)} (${r.ref}).`,
        r.verification ? `Verification: ${r.verification.status} — ${r.verification.detail}` : 'Not checked with Telegram (pass --verify to call getMe).',
        ...r.warnings.map((w) => `warning: ${w}`),
        applied ? 'Applied to the running container (controlled coordinator restart when needed).'
          : needsRestart ? 'The running container has no secrets mount (created before this feature); run `minions start` to recreate it so the token becomes visible.'
            : runtimeOf(project) === 'host'
              ? 'The host runtime copies it for the minions channel server (only that process reads it) on the next `minions start` (`minions down && minions start` when running).'
              : `It is mounted read-only at ${CONTAINER.telegramTokenFile} on the next \`minions start\`.`,
        ...(channel.result ? [formatChannelSet(channel.result)] : []),
        resolved ? `communication.channel: ${formatChannel(resolved)}` : '',
        ...(channel.hint ? [`hint: ${channel.hint}`] : []),
        ...(resolved?.effective === 'telegram' ? [
          ...(channel.result ? [] : ['Start (or restart) with Telegram: `minions down && minions start` (relaunches the coordinator).']),
          'Then pair in a terminal on the host: DM your bot, run `minions telegram access pair <code>`, then `minions telegram access policy allowlist`.',
        ] : []),
      ].filter(Boolean).join('\n') });
    }));

  auth.command('codex')
    .description('Store the OpenAI API key for Codex process workers (prompted without echo; Keychain or a 0600 host file)')
    .option('--stdin', 'read the key from piped stdin instead of the terminal prompt')
    .option('--remove', 'delete the stored key and its reference')
    .option('--dry-run', 'show the guidance and storage location without prompting')
    .action(action(async (o: { stdin?: boolean; remove?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const ref = await projectForPath(process.cwd());
      const project = await loadProjectJson(ref.projectId);
      const compose = new Compose(project.projectId);
      // The runner reads the file at each `work run`: a copy into a running container's secrets mount applies at once.
      let needsRestart = false;
      const apply = async () => {
        if (runtimeOf(project) === 'host') return false; // process harnesses run only in the Docker runtime
        const vis = await compose.secretsVisibility();
        if (vis === 'restart-required') needsRestart = true;
        if (vis !== 'mounted') return false;
        await materialize(json, project.projectId);
        return true;
      };
      if (o.remove) {
        const r = dryRun ? { removed: false, backend: null } : await removeCodexKey(project.projectId);
        const applied = !dryRun && r.removed ? await apply() : false;
        emit({ projectId: project.projectId, dryRun, ...r, appliedToRunningContainer: applied }, { json, human: () => dryRun ? 'Would remove the stored OpenAI API key (Codex).'
          : r.removed ? `Removed the OpenAI API key (${r.backend}).` : 'No OpenAI API key was stored.' });
        return;
      }
      const guidance = codexKeyGuidance();
      if (dryRun) { emit({ projectId: project.projectId, dryRun: true, guidance, mountedPath: CONTAINER.codexKeyFile }, { json, human: () => guidance.join('\n') }); return; }
      say(json, guidance.join('\n'));
      // The key is read only here, from the host terminal (no echo) or a pipe; never from argv.
      const token = o.stdin ? await readStdinSecret()
        : process.stdin.isTTY ? await readSecret('OpenAI API key (input hidden): ')
          : (() => { throw new MinionsError('PRECONDITION', 'No terminal to prompt for the key.', 'Run in a terminal, or pipe it: `minions auth codex --stdin < key-file`.'); })();
      const r = await provisionCodexKey({ projectId: project.projectId, token, repoPath: ref.repoPath });
      const applied = await apply();
      emit({ ...r, mountedPath: CONTAINER.codexKeyFile, appliedToRunningContainer: applied, ...(needsRestart ? { restartRequired: true } : {}) }, { json, human: () => [
        `Stored the OpenAI API key in ${backendLabel(r.backend)} (${r.ref}).`,
        ...r.warnings.map((w) => `warning: ${w}`),
        applied ? `Updated ${CONTAINER.codexKeyFile} in the running container.`
          : needsRestart ? 'The running container has no secrets mount (created before this feature); run `minions start` to recreate it so the key becomes visible.'
            : `It is mounted read-only at ${CONTAINER.codexKeyFile} on the next \`minions start\`.`,
      ].join('\n') });
    }));

  registerRuntime(program, { confirm, ask: askLine });
  registerMode(program);
  registerDefaults(program);
  registerChannel(program, { confirm: confirmOrNull });
  registerSecrets(program);

  registerSettings(program, { confirm: confirmMarked });

  // Advanced alias of `minions settings` (kept for scripts): `config show` (raw effective config), `config list`, `config set`.
  const config = program.command('config').description('Alias of `minions settings`: show the raw effective config, list or set settings');
  addListCommand(config);
  addSetCommand(config, { confirm: confirmMarked });
  config.command('show')
    .description('Show the effective configuration')
    .option('--explain', 'include the source of every value (default/project/local/session)')
    .action(action(async (o: { explain?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      const { projectId } = await projectForPath(process.cwd());
      const eff = await loadEffectiveConfig(await loadProjectJson(projectId));
      const data = o.explain ? { config: eff.config, provenance: eff.provenance, sources: eff.sources } : eff.config;
      emit(data, { json, human: () => o.explain
        ? Object.entries(eff.provenance).sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => `${k} = ${JSON.stringify(get(eff.config, k))}  (${s})`).join('\n')
        : JSON.stringify(eff.config, null, 2) });
    }));

  program.command('uninstall')
    .description('Remove generated files unchanged since generation; keep data volumes unless --delete-data')
    .option('--delete-data', 'also delete the Docker volumes (repository clone, backlog, runtime DB, Claude login)')
    .option('-y, --yes', 'confirm without prompting')
    .option('--dry-run', 'show what would be removed')
    .action(action(async (o: { deleteData?: boolean; yes?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const r = await runUninstall({ cwd: process.cwd(), deleteData: o.deleteData, yes: o.yes, dryRun, confirm });
      emit(r, { json, human: formatUninstall });
    }));
}

/** Resolve a dotted provenance path; keys may themselves contain dots (e.g. `capabilities.code.edit`). */
function get(obj: unknown, dotted: string): unknown {
  if (dotted === '') return obj;
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  const parts = dotted.split('.');
  for (let i = parts.length; i > 0; i--) {
    const key = parts.slice(0, i).join('.');
    if (key in rec) return get(rec[key], parts.slice(i).join('.'));
  }
  return undefined;
}
