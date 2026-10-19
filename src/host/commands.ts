import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Option, type Command } from 'commander';
import { PROFILES, type Profile } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { CONTAINER } from '../core/paths.js';
import { registerAuth } from './auth-cli.js';
import { authOf, isKeyAuth, refreshKey, startRefreshTimer } from './auth.js';
import type { MinionsConfig } from '../config/schema.js';
import {
  clearSecrets, upClearingSecretsOnFailure, githubTokenGuidance, materializeSecrets, provisionGithubToken, provisionTelegramToken, removeGithubToken,
  removeTelegramToken, telegramBotGuidance,
} from './credentials.js';
import { dockerProbe } from './discovery.js';
import { Compose, ensureImage } from './docker.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { dockerUnavailable, formatInit, refreshDerived, runInit } from './install.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { exportRepo, importRepo } from './transfer.js';
import { HOST_RUNTIME_WARNING, HostRuntime, RUNTIMES, prepareHostRuntime, requireHostTools, runtimeOf, type RuntimeKind } from './runtime.js';
import { registerRuntime } from './runtime-cli.js';
import { githubStartHint, registerGithubSetup } from './github-setup.js';
import { formatUninstall, runUninstall } from './uninstall.js';
import { readSecret, readlineIO } from './wizard.js';
import { initMayOfferAssistant, launchAssistant, loadAssistantContext, offerSetupAssistant, registerAssistant } from './assistant.js';

const say = (json: boolean, msg: string) => { if (!json) process.stderr.write(msg + '\n'); };

async function requireDocker(): Promise<void> {
  const s = await dockerProbe()();
  if (!s.daemon || !s.compose) throw dockerUnavailable(s);
}

/** Loads the project for cwd, refreshes derived files, and returns a compose handle. */
async function openProject(json: boolean) {
  const { projectId } = await projectForPath(process.cwd());
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

/**
 * Telegram startup integration (container): install the official plugin when Telegram is selected,
 * then apply restart-required Telegram changes with a controlled coordinator restart. Never fails
 * the start: terminal mode must keep working.
 */
async function telegramStartup(json: boolean, compose: Compose, config: MinionsConfig, opts: { startDetached: boolean }): Promise<unknown> {
  if (config.communication.channel === 'telegram' && config.container.network !== 'none') {
    const r = await compose.exec(['minions', 'telegram', 'install', '--json'], { allowFailure: true, timeoutMs: 600_000 });
    if (r.code !== 0) say(json, `warning: Telegram plugin not installed (${lastLine(r.stdout, r.stderr)}); the coordinator starts terminal-only.`);
  }
  return coordinatorSync(json, compose, opts);
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
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', '--stdin expects the token on a pipe, not a terminal.', 'Omit --stdin to be prompted without echo.');
  let data = '';
  for await (const chunk of process.stdin) { data += String(chunk); if (data.length > 4096) break; }
  return data.split(/\r?\n/)[0] ?? '';
}

/**
 * Starts the container. For Claude key methods with `provision` the key is (re)obtained first and a
 * failure stops here with AUTH_REQUIRED. GitHub/Telegram tokens are then materialized into the same
 * secrets dir (which must exist: it is the bind source), and cleared again if `up` fails.
 * `compose up -d` recreates the container whenever compose.yaml changed (method, env, mounts).
 */
async function ensureUp(json: boolean, opts: { provision?: boolean } = {}) {
  await requireDocker();
  const p = await openProject(json);
  const auth = authOf(p.project);
  if (isKeyAuth(auth) && opts.provision) {
    say(json, `Refreshing the Claude key on the host (${auth.method === 'helper' ? `running \`${auth.command[0]}\`` : 'reading the configured source'})…`);
    await refreshKey(p.project.projectId, auth);
  }
  if (await ensureImage(p.project.imageTag, { onBuild: (m) => say(json, m) })) say(json, `Built ${p.project.imageTag}.`);
  await materialize(json, p.project.projectId);
  await upClearingSecretsOnFailure(p.compose, p.project.projectId);
  await p.compose.exec(['minions', 'workspace', 'setup', '--json'], { timeoutMs: 120_000 });
  return p;
}

/**
 * Host runtime counterpart of ensureUp: warning, host tools, Claude key (key methods), token copies,
 * shims, and the state layout. Nothing Docker-related runs.
 */
async function ensureHost(json: boolean, opts: { provision?: boolean } = {}) {
  const p = await openProject(json);
  process.stderr.write(HOST_RUNTIME_WARNING.join('\n') + '\n'); // always (stderr): also in --json mode
  await requireHostTools();
  const auth = authOf(p.project);
  if (isKeyAuth(auth) && opts.provision) {
    say(json, `Refreshing the Claude key on the host (${auth.method === 'helper' ? `running \`${auth.command[0]}\`` : 'reading the configured source'})…`);
    await refreshKey(p.project.projectId, auth);
  }
  const host = new HostRuntime(p.project);
  const prepared = await prepareHostRuntime(p.project);
  if (!prepared.gh && p.config.delivery.mode === 'pull-request') say(json, 'warning: gh is not installed on the host; pull-request delivery cannot open PRs (brew install gh).');
  await materialize(json, p.project.projectId);
  const setup = await host.exec(['minions', 'workspace', 'setup', '--json'], { allowFailure: true, timeoutMs: 120_000 });
  if (setup.code !== 0) throw new MinionsError('INTERNAL', `Host runtime state setup failed: ${lastLine(setup.stdout, setup.stderr)}`);
  return { ...p, host };
}

async function startHost(json: boolean, o: { attach: boolean }): Promise<void> {
  const { project, config, host } = await ensureHost(json, { provision: true });
  let imported: unknown = null;
  const present = (await host.exec(['git', '-C', host.paths.repo, 'rev-parse', '--git-dir'], { allowFailure: true, timeoutMs: 30_000 })).code === 0;
  if (!present) {
    say(json, `Cloning committed history of ${project.baseBranch} into the host runtime workspace (${host.paths.workspace})…`);
    const r = await importRepo(project, { repoPath: (await projectForPath(process.cwd())).repoPath, target: host.transferTarget() });
    for (const w of r.warnings) say(json, `warning: ${w}`);
    imported = r;
  }
  const hint = await githubStartHint(project, config);
  if (hint) say(json, hint);
  if (config.communication.channel === 'telegram') {
    say(json, 'warning: host runtime: the Telegram channel plugin is not installed automatically (it would change your own Claude Code setup). Install it yourself with `claude plugin install telegram@claude-plugins-official`, or the coordinator runs terminal-only.');
  }
  const attach = o.attach && !json && !!process.stdin.isTTY && !!process.stdout.isTTY;
  const sync = await host.exec(['minions', 'coordinator', 'sync', '--json', ...(!attach && config.communication.channel === 'telegram' ? ['--start-detached'] : [])], { allowFailure: true, timeoutMs: 60_000 });
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

const repoPresent = async (compose: Compose) =>
  (await compose.exec(['git', '-C', CONTAINER.repo, 'rev-parse', '--git-dir'], { allowFailure: true, timeoutMs: 30_000 })).code === 0;

async function askLine(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(`${question} `)).trim(); } finally { rl.close(); }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(`${question} `)).trim()); } finally { rl.close(); }
}

/** Registers host commands on the root program. */
export function register(program: Command): void {
  const auth = registerAuth(program, async (plan) => { process.stderr.write(plan + '\n'); return confirm('Apply? (y/n)'); });
  program.command('init [path]')
    .description('Inspect a Git repository, propose an install plan, apply it, and verify the runtime')
    .addOption(new Option('--profile <profile>', 'starting profile').choices([...PROFILES]))
    .option('--private', 'private install: nothing is written into the repository')
    .option('--shared', 'shared install: writes .minions/config.json and .minions/README.md')
    .option('-y, --yes', 'accept defaults without prompting')
    .option('--config <file>', 'use a validated config file instead of the wizard')
    .option('--dry-run', 'show the plan without writing anything')
    .option('--attach', 'attach this repository to the project id in .minions/config.json')
    .option('--new-identity', 'create a new project identity for this repository')
    .addOption(new Option('--runtime <runtime>', 'agent runtime: docker (default) or host (no Docker, less safe; prints a warning)').choices([...RUNTIMES]))
    .action(action(async (path: string | undefined, o: { profile?: Profile; private?: boolean; shared?: boolean; yes?: boolean; config?: string; dryRun?: boolean; attach?: boolean; newIdentity?: boolean; runtime?: RuntimeKind }, cmd: Command) => {
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
          path: resolvePath(path ?? '.'), profile: o.profile, visibility: o.private ? 'private' : o.shared ? 'shared' : undefined,
          yes: !interactive, configFile: o.config ? resolvePath(o.config) : undefined, dryRun: o.dryRun,
          attach: o.attach, newIdentity: o.newIdentity, io, runtime: o.runtime,
        });
        emit(r, { json, human: formatInit });
        // Interactive init only (never --yes / --config / --json / --dry-run / no terminal): offer the AI setup assistant.
        const offer = initMayOfferAssistant({ ...o, json, stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY }) && !r.dryRun;
        if (offer && io) {
          await offerSetupAssistant({ interactive: true, io, launch: async () => {
            io.close?.(); // the assistant owns the terminal from here
            return launchAssistant(await loadAssistantContext(r.plan.repoPath), { onInfo: (l) => process.stderr.write(l + '\n') });
          } });
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
    }));

  program.command('start')
    .description('Start the agent runtime (container, or the host runtime), import the repo, and attach the coordinator')
    .option('--no-attach', 'start the runtime without attaching to the coordinator')
    .action(action(async (o: { attach: boolean }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      const { projectId } = await projectForPath(process.cwd());
      if (runtimeOf(await loadProjectJson(projectId)) === 'host') return startHost(json, o);
      const { project, compose, config } = await ensureUp(json, { provision: true });
      let imported: unknown = null;
      if (!(await repoPresent(compose))) {
        say(json, `Importing committed history of ${project.baseBranch} into the container…`);
        const r = await importRepo(project, { repoPath: (await projectForPath(process.cwd())).repoPath });
        for (const w of r.warnings) say(json, `warning: ${w}`);
        imported = r;
      }
      const hint = await githubStartHint(project, config);
      if (hint) say(json, hint);
      // The coordinator is a TUI in tmux: attaching needs a terminal (compose exec allocates a TTY).
      const attach = o.attach && !json && !!process.stdin.isTTY && !!process.stdout.isTTY;
      // Telegram must work with nobody attached: start the session detached in that case.
      const coordinator = await telegramStartup(json, compose, config, { startDetached: !attach && config.communication.channel === 'telegram' });
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
      try { process.exitCode = await compose.execInherit(['minions', 'coordinator'], { tty: true }); } finally { stopRefresh(); }
    }));

  program.command('down')
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

  program.command('import')
    .description('Import committed history of the base branch into the runtime workspace (git bundle)')
    .option('--dry-run', 'show what would be imported')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
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
        ...(d.container.origin ? [`origin ${d.container.origin.url}: ${d.container.origin.authenticated ? 'authenticated' : 'not authenticated'}, ${d.container.origin.fetched ? 'base fetched' : 'not fetched'}`] : []),
        ...[...d.warnings, ...(d.container.origin?.warnings ?? [])].map((w) => `warning: ${w}`)].join('\n') });
    }));

  program.command('export')
    .description('Fetch agent branches from the runtime workspace into refs/remotes/minions/* (non-destructive)')
    .option('--dry-run', 'show what would be exported')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const ref = await projectForPath(process.cwd());
      if (dryRun) { emit({ dryRun: true, target: 'refs/remotes/minions/*' }, { json }); return; }
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
      emit(r, { json, human: (d: typeof r) => [`Bundle: ${d.bundle}`,
        ...(d.changes.length ? d.changes.map((c) => `  ${c.ref}: ${c.from?.slice(0, 12) ?? '(new)'} -> ${c.to?.slice(0, 12) ?? '(deleted)'}`) : ['  no ref changes']),
        'Local branches and the working tree were not modified.'].join('\n') });
    }));

  auth.command('github')
    .description('Store a fine-grained GitHub token (prompted without echo; Keychain or a 0600 host file)')
    .option('--stdin', 'read the token from piped stdin instead of the terminal prompt')
    .option('--no-verify', 'store without checking the token against the GitHub API')
    .option('--remove', 'delete the stored token and its reference')
    .option('--dry-run', 'show the guidance and storage location without prompting')
    .action(action(async (o: { stdin?: boolean; verify: boolean; remove?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const ref = await projectForPath(process.cwd());
      const project = await loadProjectJson(ref.projectId);
      if (o.remove) {
        const r = dryRun ? { removed: false, backend: null } : await removeGithubToken(project.projectId);
        emit({ projectId: project.projectId, dryRun, ...r }, { json, human: () => dryRun ? 'Would remove the stored GitHub token.'
          : r.removed ? `Removed the GitHub token (${r.backend}).` : 'No GitHub token was stored.' });
        return;
      }
      const guidance = githubTokenGuidance(project.remoteUrl);
      if (dryRun) { emit({ projectId: project.projectId, dryRun: true, guidance }, { json, human: () => guidance.join('\n') }); return; }
      say(json, guidance.join('\n'));
      // The token is read only here, from the host terminal (no echo) or a pipe; never from argv.
      const token = o.stdin ? await readStdinSecret()
        : process.stdin.isTTY ? await readSecret('GitHub token (input hidden): ')
          : (() => { throw new MinionsError('PRECONDITION', 'No terminal to prompt for the token.', 'Run in a terminal, or pipe it: `minions auth github --stdin < token-file`.'); })();
      const r = await provisionGithubToken({ projectId: project.projectId, token, repoPath: ref.repoPath, remoteUrl: project.remoteUrl, verify: o.verify });
      const compose = new Compose(project.projectId);
      let mounted = false;
      let needsRestart = false;
      const vis = runtimeOf(project) === 'host'
        ? (await new HostRuntime(project).prepared() ? 'mounted' : 'not-running')
        : await compose.secretsVisibility();
      if (vis === 'mounted') { await materialize(json, project.projectId); mounted = true; }
      else if (vis === 'restart-required') needsRestart = true; // container predates the secrets mount: a copy would not reach it
      emit({ ...r, mountedPath: CONTAINER.githubTokenFile, visibleInRunningContainer: mounted, ...(needsRestart ? { restartRequired: true } : {}) }, { json, human: () => [
        `Stored the GitHub token in ${r.backend === 'keychain' ? 'the macOS Keychain' : 'a 0600 host file'} (${r.ref}).`,
        r.verification ? `Verification: ${r.verification.status} — ${r.verification.detail}` : 'Verification skipped (--no-verify).',
        ...r.warnings.map((w) => `warning: ${w}`),
        mounted ? `Updated ${CONTAINER.githubTokenFile} in the running container.`
          : needsRestart ? 'The running container has no secrets mount (created before this feature); run `minions start` to recreate it so the token becomes visible.'
            : `It is mounted read-only at ${CONTAINER.githubTokenFile} on the next \`minions start\`.`,
      ].join('\n') });
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
        await coordinatorSync(json, compose, { startDetached: eff?.config.communication.channel === 'telegram' });
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
      const applied = await apply();
      emit({ ...r, mountedPath: CONTAINER.telegramTokenFile, appliedToRunningContainer: applied, ...(needsRestart ? { restartRequired: true } : {}) }, { json, human: () => [
        `Stored the Telegram bot token for bot ${r.botId} in ${r.backend === 'keychain' ? 'the macOS Keychain' : 'a 0600 host file'} (${r.ref}).`,
        r.verification ? `Verification: ${r.verification.status} — ${r.verification.detail}` : 'Not checked with Telegram (pass --verify to call getMe).',
        ...r.warnings.map((w) => `warning: ${w}`),
        applied ? 'Applied to the running container (controlled coordinator restart when needed).'
          : needsRestart ? 'The running container has no secrets mount (created before this feature); run `minions start` to recreate it so the token becomes visible.'
            : `It is mounted read-only at ${CONTAINER.telegramTokenFile} on the next \`minions start\`.`,
        'Telegram is used only when communication.channel is "telegram" (check with `minions config show --explain`).',
      ].join('\n') });
    }));

  registerRuntime(program, { confirm, ask: askLine });
  registerAssistant(registerGithubSetup(program));

  const config = program.command('config').description('Inspect configuration');
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
