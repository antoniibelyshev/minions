import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Option, type Command } from 'commander';
import { PROFILES, type Profile } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { CONTAINER } from '../core/paths.js';
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
import { formatUninstall, runUninstall } from './uninstall.js';
import { DELIVERY_MODES, formatSetup, runSetup, type DeliveryMode, type SetupRuntime } from './setup.js';
import { readSecret, readlineIO } from './wizard.js';

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
  return (await readStdinLines(1))[0] ?? '';
}

/** First `n` lines of piped stdin (tokens are never accepted from argv). */
async function readStdinLines(n: number): Promise<string[]> {
  if (process.stdin.isTTY) throw new MinionsError('PRECONDITION', 'Token input on stdin expects a pipe, not a terminal.', 'Omit the stdin option to be prompted without echo.');
  let data = '';
  for await (const chunk of process.stdin) { data += String(chunk); if (data.length > 8192) break; }
  return data.split(/\r?\n/).slice(0, n);
}

/** `minions setup` container steps, using the same code as `minions start` and `minions import`. */
function setupRuntime(json: boolean, cwd: string): SetupRuntime {
  let opened: Awaited<ReturnType<typeof ensureUp>> | undefined;
  const up = () => { if (!opened) throw new MinionsError('INTERNAL', 'container not started'); return opened; };
  return {
    containerRunning: (projectId) => new Compose(projectId).isRunning().catch(() => false),
    async start() { opened = await ensureUp(json, cwd); },
    repoPresent: async () => repoPresent(up().compose),
    importRepo: async () => importRepo(up().project, { repoPath: (await projectForPath(cwd)).repoPath }),
    async launchCoordinator() {
      const p = up();
      // Started detached so it runs (and Telegram works) with nobody attached; attaching comes after.
      return (await telegramStartup(json, p.compose, p.config, { startDetached: true })) as { action?: string; reason?: string } | null;
    },
    attachCommand: (projectId) => { const c = new Compose(projectId); return `docker compose -p ${c.name} -f ${c.file} exec app minions coordinator`; },
  };
}

async function ensureUp(json: boolean, cwd: string = process.cwd()) {
  await requireDocker();
  const p = await openProject(json, cwd);
  if (await ensureImage(p.project.imageTag, { onBuild: (m) => say(json, m) })) say(json, `Built ${p.project.imageTag}.`);
  await materialize(json, p.project.projectId);
  await upClearingSecretsOnFailure(p.compose, p.project.projectId);
  await p.compose.exec(['minions', 'workspace', 'setup', '--json'], { timeoutMs: 120_000 });
  return p;
}

const repoPresent = async (compose: Compose) =>
  (await compose.exec(['git', '-C', CONTAINER.repo, 'rev-parse', '--git-dir'], { allowFailure: true, timeoutMs: 30_000 })).code === 0;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await rl.question(`${question} `)).trim()); } finally { rl.close(); }
}

/** Registers host commands on the root program. */
export function register(program: Command): void {
  program.command('init [path]')
    .description('Inspect a Git repository, propose an install plan, apply it, and verify Docker')
    .addOption(new Option('--profile <profile>', 'starting profile').choices([...PROFILES]))
    .option('--private', 'private install: nothing is written into the repository')
    .option('--shared', 'shared install: writes .minions/config.json and .minions/README.md')
    .option('-y, --yes', 'accept defaults without prompting')
    .option('--config <file>', 'use a validated config file instead of the wizard')
    .option('--dry-run', 'show the plan without writing anything')
    .option('--attach', 'attach this repository to the project id in .minions/config.json')
    .option('--new-identity', 'create a new project identity for this repository')
    .action(action(async (path: string | undefined, o: { profile?: Profile; private?: boolean; shared?: boolean; yes?: boolean; config?: string; dryRun?: boolean; attach?: boolean; newIdentity?: boolean }, cmd: Command) => {
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
          attach: o.attach, newIdentity: o.newIdentity, io,
        });
        emit(r, { json, human: formatInit });
      } finally { io?.close?.(); }
    }));

  program.command('setup [path]')
    .description('Guided end-to-end setup: init wizard, GitHub, CI guidance, Telegram, container start, import, coordinator')
    .addOption(new Option('--profile <profile>', 'starting profile').choices([...PROFILES]))
    .option('--private', 'private install: nothing is written into the repository')
    .option('--shared', 'shared install: writes .minions/config.json and .minions/README.md')
    .option('-y, --yes', 'non-interactive: accept defaults (optional integrations off unless a token is piped)')
    .option('--dry-run', 'show what setup would do without writing, prompting for secrets, or starting anything')
    .addOption(new Option('--delivery <mode>', 'delivery mode (branch/pull-request need a stored GitHub token)').choices([...DELIVERY_MODES]))
    .option('--github-token-stdin', 'read the GitHub token from the first line of piped stdin')
    .option('--telegram-token-stdin', 'read the Telegram bot token from piped stdin (second line when combined with --github-token-stdin)')
    // Same semantics as `minions init` (install.sh passes init options through to setup).
    .option('--config <file>', 'use a validated config file instead of the init wizard (skips the questions it covers)')
    .option('--attach', 'attach this repository to the project id in .minions/config.json')
    .option('--new-identity', 'create a new project identity for this repository')
    .option('--no-attach-coordinator', 'do not offer to attach the coordinator at the end')
    .action(action(async (path: string | undefined, o: { profile?: Profile; private?: boolean; shared?: boolean; yes?: boolean; dryRun?: boolean; delivery?: DeliveryMode; githubTokenStdin?: boolean; telegramTokenStdin?: boolean; config?: string; attach?: boolean; newIdentity?: boolean; attachCoordinator: boolean }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      if (o.private && o.shared) throw new MinionsError('INVALID_CONFIG', '--private and --shared are mutually exclusive.');
      const piped = !!(o.githubTokenStdin || o.telegramTokenStdin);
      const interactive = !o.yes && !o.dryRun && !json && !piped && !!process.stdin.isTTY;
      // Like init, --config is a non-interactive alternative to --yes (token questions then need stdin).
      if (!o.yes && !o.config && !o.dryRun && !interactive) {
        throw new MinionsError('PRECONDITION', 'setup needs a terminal for its questions.', 'Pass --yes to accept the defaults or --config <file> (tokens can be piped with --github-token-stdin / --telegram-token-stdin), or --dry-run.');
      }
      const target = resolvePath(path ?? '.');
      let tokens: { github?: string; telegram?: string } | undefined;
      if (piped && !o.dryRun) {
        const lines = await readStdinLines(o.githubTokenStdin && o.telegramTokenStdin ? 2 : 1);
        // A missing line is an empty token: runSetup rejects it instead of silently skipping the step.
        tokens = o.githubTokenStdin ? { github: lines[0] ?? '', ...(o.telegramTokenStdin ? { telegram: lines[1] ?? '' } : {}) } : { telegram: lines[0] ?? '' };
      }
      const io = interactive ? readlineIO() : undefined;
      try {
        const r = await runSetup({
          path: target, profile: o.profile, visibility: o.private ? 'private' : o.shared ? 'shared' : undefined,
          yes: !interactive, dryRun: o.dryRun, io, delivery: o.delivery, tokens, runtime: setupRuntime(json, target),
          configFile: o.config ? resolvePath(o.config) : undefined, attach: o.attach, newIdentity: o.newIdentity,
        });
        emit(r, { json, human: formatSetup });
        if (r.steps.some((s) => s.status === 'failed')) process.exitCode = 1;
        // The coordinator is a TUI in tmux: attaching needs a terminal (compose exec allocates a TTY).
        if (r.ready && interactive && o.attachCoordinator && process.stdout.isTTY && io && /^y(es)?$/i.test(await io.ask('Attach to the coordinator now? (y/n)', 'y'))) {
          io.close?.();
          say(json, 'Attaching the coordinator (tmux session "coordinator"; detach with Ctrl-b d). On first start, log in to Claude with /login.');
          process.exitCode = await new Compose(r.projectId).execInherit(['minions', 'coordinator'], { tty: true });
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
    .description('Build the image if needed, start the container, import the repo, and attach the coordinator')
    .option('--no-attach', 'start the container without attaching to the coordinator')
    .action(action(async (o: { attach: boolean }, cmd: Command) => {
      requireMode('host');
      const { json } = globalOpts(cmd);
      const { project, compose, config } = await ensureUp(json);
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
      const coordinator = await telegramStartup(json, compose, config, { startDetached: !attach && config.communication.channel === 'telegram' });
      if (!attach) {
        emit({ projectId: project.projectId, running: true, imported, coordinator, attach: `docker compose -p ${compose.name} -f ${compose.file} exec ${'app'} minions coordinator` },
          { json, human: () => `Container ${compose.name} is running. Run \`minions start\` in a terminal to attach the coordinator.` });
        return;
      }
      say(json, 'Attaching the coordinator (tmux session "coordinator"). On first start, log in to Claude with /login.');
      process.exitCode = await compose.execInherit(['minions', 'coordinator'], { tty: true });
    }));

  program.command('down')
    .description('Stop and remove the project container (volumes are kept)')
    .option('--dry-run', 'show what would be stopped')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const { projectId } = await projectForPath(process.cwd());
      const compose = new Compose(projectId);
      if (!dryRun) { await requireDocker(); await compose.down(); await clearSecrets(projectId); }
      emit({ projectId, stopped: !dryRun, dryRun }, { json, human: () => dryRun ? `Would stop ${compose.name}.` : `Stopped ${compose.name}; volumes kept.` });
    }));

  program.command('import')
    .description('Import committed history of the base branch into the container workspace (git bundle)')
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
      const { project } = await ensureUp(json);
      const r = await importRepo(project, { repoPath: (await projectForPath(process.cwd())).repoPath });
      emit(r, { json, human: (d: typeof r) => [`Imported ${d.baseBranch} @ ${d.commit.slice(0, 12)} into the container.`,
        ...(d.container.origin ? [`origin ${d.container.origin.url}: ${d.container.origin.authenticated ? 'authenticated' : 'not authenticated'}, ${d.container.origin.fetched ? 'base fetched' : 'not fetched'}`] : []),
        ...[...d.warnings, ...(d.container.origin?.warnings ?? [])].map((w) => `warning: ${w}`)].join('\n') });
    }));

  program.command('export')
    .description('Fetch agent branches from the container into refs/remotes/minions/* (non-destructive)')
    .option('--dry-run', 'show what would be exported')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const ref = await projectForPath(process.cwd());
      if (dryRun) { emit({ dryRun: true, target: 'refs/remotes/minions/*' }, { json }); return; }
      await requireDocker();
      const project = await loadProjectJson(ref.projectId);
      const compose = new Compose(ref.projectId);
      if (!(await compose.isRunning())) throw new MinionsError('PRECONDITION', 'The project container is not running.', 'Run `minions start --no-attach` first.');
      const r = await exportRepo(project, { repoPath: ref.repoPath, compose });
      emit(r, { json, human: (d: typeof r) => [`Bundle: ${d.bundle}`,
        ...(d.changes.length ? d.changes.map((c) => `  ${c.ref}: ${c.from?.slice(0, 12) ?? '(new)'} -> ${c.to?.slice(0, 12) ?? '(deleted)'}`) : ['  no ref changes']),
        'Local branches and the working tree were not modified.'].join('\n') });
    }));

  const auth = program.command('auth').description('Provision host-held credentials for this project');
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
      const vis = await compose.secretsVisibility();
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
