import { resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Option, type Command } from 'commander';
import { PROFILES, type Profile } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { CONTAINER } from '../core/paths.js';
import { registerAuth } from './auth-cli.js';
import { authOf, ensureSecretsDir, isKeyAuth, refreshKey, startRefreshTimer } from './auth.js';
import { dockerProbe } from './discovery.js';
import { Compose, ensureImage } from './docker.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { dockerUnavailable, formatInit, refreshDerived, runInit } from './install.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { exportRepo, importRepo } from './transfer.js';
import { formatUninstall, runUninstall } from './uninstall.js';
import { readlineIO } from './wizard.js';

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

/**
 * Starts the container. For Claude key methods the secrets dir must exist (bind source); with
 * `provision` the key is (re)obtained first and a failure stops here with AUTH_REQUIRED.
 * `compose up -d` recreates the container whenever compose.yaml changed (method, env, mounts).
 */
async function ensureUp(json: boolean, opts: { provision?: boolean } = {}) {
  await requireDocker();
  const p = await openProject(json);
  const auth = authOf(p.project);
  if (isKeyAuth(auth)) {
    await ensureSecretsDir(p.project.projectId);
    if (opts.provision) {
      say(json, `Refreshing the Claude key on the host (${auth.method === 'helper' ? `running \`${auth.command[0]}\`` : 'reading the configured source'})…`);
      await refreshKey(p.project.projectId, auth);
    }
  }
  if (await ensureImage(p.project.imageTag, { onBuild: (m) => say(json, m) })) say(json, `Built ${p.project.imageTag}.`);
  await p.compose.up();
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
  registerAuth(program, async (plan) => { process.stderr.write(plan + '\n'); return confirm('Apply? (y/n)'); });
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
      const { project, compose } = await ensureUp(json, { provision: true });
      let imported: unknown = null;
      if (!(await repoPresent(compose))) {
        say(json, `Importing committed history of ${project.baseBranch} into the container…`);
        const r = await importRepo(project, { repoPath: (await projectForPath(process.cwd())).repoPath });
        for (const w of r.warnings) say(json, `warning: ${w}`);
        imported = r;
      }
      // The coordinator is a TUI in tmux: attaching needs a terminal (compose exec allocates a TTY).
      if (!o.attach || json || !process.stdin.isTTY || !process.stdout.isTTY) {
        emit({ projectId: project.projectId, running: true, imported, attach: `docker compose -p ${compose.name} -f ${compose.file} exec ${'app'} minions coordinator` },
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
    .description('Stop and remove the project container (volumes are kept)')
    .option('--dry-run', 'show what would be stopped')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const { projectId } = await projectForPath(process.cwd());
      const compose = new Compose(projectId);
      if (!dryRun) { await requireDocker(); await compose.down(); }
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
      emit(r, { json, human: (d: typeof r) => [`Imported ${d.baseBranch} @ ${d.commit.slice(0, 12)} into the container.`, ...d.warnings.map((w) => `warning: ${w}`)].join('\n') });
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
