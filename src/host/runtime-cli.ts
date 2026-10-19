// `minions runtime show|set docker|host` (host CLI only). The runtime is a host-controlled setting in
// project.json (or <MINIONS_HOME>/defaults.json with --global); repository config can never set it.
import { Argument, type Command } from 'commander';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { defaultsPath, hostRuntimePaths, projectPaths } from '../core/paths.js';
import { loadDefaults, saveDefaults } from './auth.js';
import { Compose, type Runner } from './docker.js';
import { projectJsonBytes, refreshDerived, writeGenerated } from './install.js';
import { loadEffectiveConfig, loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { HOST_CONFIRM_WORD, HOST_RUNTIME_WARNING, HostRuntime, RUNTIMES, runtimeOf, type RuntimeKind } from './runtime.js';

export interface RuntimeShowResult {
  scope: 'project' | 'global';
  projectId: string | null;
  runtime: RuntimeKind;
  explicit: boolean;
  globalDefault: RuntimeKind | null;
  warning: string[] | null;
  hostPaths: { workspace: string; state: string } | null;
}

export async function runRuntimeShow(o: { global?: boolean }, deps: { cwd: string }): Promise<RuntimeShowResult> {
  const defaults = await loadDefaults();
  if (o.global) {
    const rt = defaults.runtime ?? 'docker';
    return { scope: 'global', projectId: null, runtime: rt, explicit: !!defaults.runtime, globalDefault: null, warning: rt === 'host' ? HOST_RUNTIME_WARNING : null, hostPaths: null };
  }
  const { projectId } = await projectForPath(deps.cwd);
  const project = await loadProjectJson(projectId);
  const rt = runtimeOf(project);
  const hp = hostRuntimePaths(projectId);
  return {
    scope: 'project', projectId, runtime: rt, explicit: project.runtime !== undefined, globalDefault: defaults.runtime ?? null,
    warning: rt === 'host' ? HOST_RUNTIME_WARNING : null, hostPaths: rt === 'host' ? { workspace: hp.workspace, state: hp.state } : null,
  };
}

export function formatRuntimeShow(r: RuntimeShowResult): string {
  const L = [`Agent runtime (${r.scope === 'global' ? 'global default for new projects' : `project ${r.projectId}`}): ${r.runtime}${r.explicit ? '' : ' [default]'}`];
  if (r.runtime === 'docker') L.push('  agents run in the hardened project container (recommended).');
  if (r.hostPaths) L.push(`  workspace clone: ${r.hostPaths.workspace}`, `  runtime state: ${r.hostPaths.state}`);
  if (r.globalDefault) L.push(`  global default: ${r.globalDefault}`);
  if (r.warning) L.push('', ...r.warning);
  return L.join('\n');
}

export interface RuntimeSetDeps {
  cwd: string;
  runner?: Runner;
  /** Prints the warning and reads the typed confirmation (null = no terminal). */
  ask?: (question: string) => Promise<string | null>;
  warn?: (lines: string[]) => void;
  /** Whether the current runtime is running (tests). */
  isRunning?: (kind: RuntimeKind) => Promise<boolean>;
}

export interface RuntimeSetResult {
  scope: 'project' | 'global';
  projectId: string | null;
  from: RuntimeKind;
  to: RuntimeKind;
  dryRun: boolean;
  applied: boolean;
  writes: string[];
  notes: string[];
  warning: string[] | null;
}

/** Requires the typed word (or --yes) for host; prints the warning in every case it switches to host. */
async function confirmHost(o: { yes?: boolean }, deps: RuntimeSetDeps): Promise<void> {
  deps.warn?.(HOST_RUNTIME_WARNING);
  if (o.yes) return;
  const answer = deps.ask ? await deps.ask(`Type "${HOST_CONFIRM_WORD}" to run agents without Docker:`) : null;
  if (answer === null) throw new MinionsError('PRECONDITION', 'Switching to the host runtime needs an explicit confirmation.', 'Run it in a terminal and type "host", or pass --yes after reading the warning.');
  if (answer !== HOST_CONFIRM_WORD) throw new MinionsError('PRECONDITION', 'Not confirmed; the runtime was not changed.');
}

export async function runRuntimeSet(to: string, o: { global?: boolean; yes?: boolean; dryRun?: boolean }, deps: RuntimeSetDeps): Promise<RuntimeSetResult> {
  if (!(RUNTIMES as readonly string[]).includes(to)) throw new MinionsError('INVALID_CONFIG', `Unknown runtime "${to}".`, 'Use `docker` or `host`.');
  const target = to as RuntimeKind;
  const warning = target === 'host' ? HOST_RUNTIME_WARNING : null;
  if (o.global) {
    const defaults = await loadDefaults();
    const from = defaults.runtime ?? 'docker';
    const notes = ['Applies to projects created by `minions init` from now on; existing projects keep their runtime.'];
    if (target === 'host') notes.push('Each `minions init` and `minions start` with the host runtime shows the warning again.');
    const r: RuntimeSetResult = { scope: 'global', projectId: null, from, to: target, dryRun: !!o.dryRun, applied: false, writes: [defaultsPath()], notes, warning };
    if (o.dryRun) return r;
    if (target === 'host') await confirmHost(o, deps);
    await saveDefaults({ ...defaults, runtime: target });
    return { ...r, applied: true };
  }
  const { projectId } = await projectForPath(deps.cwd);
  const project = await loadProjectJson(projectId);
  const from = runtimeOf(project);
  const paths = projectPaths(projectId);
  const hp = hostRuntimePaths(projectId);
  const notes: string[] = [];
  if (from === target) notes.push(`The project already uses the ${target} runtime.`);
  else if (target === 'host') {
    notes.push(`Agents will work in a separate clone at ${hp.repo} (seeded from the committed ${project.baseBranch} branch on the next \`minions start\`), never in your checkout.`,
      'Agent branches, backlog and runtime state in the container volumes are not copied: run `minions export` first to keep agent branches.');
  } else {
    notes.push(`The host runtime workspace and state at ${hp.root} are kept (delete them with \`minions uninstall --delete-data\`). The container keeps its own volumes.`);
  }
  const r: RuntimeSetResult = { scope: 'project', projectId, from, to: target, dryRun: !!o.dryRun, applied: false, writes: [paths.projectJson], notes, warning };
  if (o.dryRun || from === target) return { ...r, applied: false };
  const running = deps.isRunning ?? (async (k: RuntimeKind) => k === 'host'
    ? new HostRuntime(project, deps.runner).isRunning()
    : new Compose(projectId, deps.runner).isRunning().catch(() => false));
  if (await running(from)) {
    throw new MinionsError('PRECONDITION', `The ${from === 'host' ? 'host runtime coordinator' : 'project container'} is running.`, 'Run `minions down` first, then switch the runtime.');
  }
  if (target === 'host') await confirmHost(o, deps);
  const next = { ...project, runtime: target };
  await writeGenerated(projectId, paths.projectJson, projectJsonBytes(next));
  const eff = await loadEffectiveConfig(next);
  notes.push(...await refreshDerived(next, eff.config));
  notes.push('Run `minions start` to use it.');
  return { ...r, applied: true };
}

export function formatRuntimeSet(r: RuntimeSetResult): string {
  const L = [`Agent runtime ${r.scope === 'global' ? 'default for new projects' : `for project ${r.projectId}`}: ${r.from} -> ${r.to}${r.dryRun ? ' (dry run: nothing changed)' : r.applied ? '' : ' (unchanged)'}`];
  L.push(`  writes: ${r.writes.join(', ')}`);
  for (const n of r.notes) L.push(`  note: ${n}`);
  return L.join('\n');
}

export function registerRuntime(program: Command, io: { ask: (q: string) => Promise<string | null>; confirm?: unknown }): Command {
  const rt = program.command('runtime').description('Agent runtime: docker (hardened container, default) or host (no Docker, less safe)');
  rt.command('show')
    .description('Show the agent runtime of this project (or the global default)')
    .option('--global', 'show the default for new projects')
    .action(action(async (o: { global?: boolean }, cmd: Command) => {
      requireMode('host');
      emit(await runRuntimeShow(o, { cwd: process.cwd() }), { json: globalOpts(cmd).json, human: formatRuntimeShow });
    }));
  rt.command('set')
    .description('Switch the agent runtime; "host" prints a warning and needs a typed confirmation (or --yes)')
    .addArgument(new Argument('<runtime>', 'docker | host').choices([...RUNTIMES]))
    .option('--global', 'set the default for new projects (<MINIONS_HOME>/defaults.json)')
    .option('-y, --yes', 'confirm without the typed prompt (the warning is still printed)')
    .option('--dry-run', 'show what would change')
    .action(action(async (to: string, o: { global?: boolean; yes?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const r = await runRuntimeSet(to, { ...o, dryRun }, {
        cwd: process.cwd(),
        ask: json ? async () => null : io.ask,
        warn: (lines) => process.stderr.write(lines.join('\n') + '\n'),
      });
      emit(r, { json, human: formatRuntimeSet });
    }));
  return rt;
}
