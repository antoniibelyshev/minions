// `minions settings [--list] | settings set <key> <value> | settings restart` (host): applies changes from
// the settings model (src/host/settings.ts): validation, the loosening confirmation, the write to the
// right layer, regeneration of the derived files, and the graceful coordinator restart
// (`minions coordinator restart --recover` in the runtime, the same call `minions upgrade` makes; it is
// refused while worker leases are active, so running workers are never interrupted).
import type { Command } from 'commander';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import type { RunResult } from '../core/exec.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { Compose } from './docker.js';
import { loadProjectJson, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { HostRuntime, runtimeOf } from './runtime.js';
import {
  SETTING_GROUPS, formatValue, listSettings, loadSettingsContext, parseSettingValue, planSetting, requireSetting, writeSetting,
  type SettingChange, type SettingLayer, type SettingView, type SettingsContext,
} from './settings.js';

/** The runtime operations settings needs (faked in tests). */
export interface SettingsRuntime {
  running(project: ProjectJson): Promise<boolean>;
  exec(project: ProjectJson, args: string[]): Promise<RunResult>;
}

export const defaultSettingsRuntime: SettingsRuntime = {
  running: (p) => (runtimeOf(p) === 'host' ? new HostRuntime(p).isRunning() : new Compose(p.projectId).isRunning()).catch(() => false),
  exec: (p, args) => (runtimeOf(p) === 'host' ? new HostRuntime(p).exec(args, { allowFailure: true, timeoutMs: 120_000 })
    : new Compose(p.projectId).exec(args, { allowFailure: true, timeoutMs: 120_000 })),
};

export interface SettingsApplyDeps {
  runtime: SettingsRuntime;
  /** Yes/no question; null when no terminal can answer. */
  confirm: (question: string) => Promise<boolean | null>;
}

const lastJson = <T>(stdout: string): { ok: boolean; data?: T; error?: { message?: string } } | null => {
  try { return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { return null; }
};

/** Pause flags of the running runtime (`minions status --json`), or null. */
export async function runtimePaused(project: ProjectJson, runtime: SettingsRuntime): Promise<SettingsContext['paused']> {
  if (!(await runtime.running(project))) return null;
  const env = lastJson<{ paused?: { intake: boolean; starts: boolean } }>((await runtime.exec(project, ['minions', 'status', '--json'])).stdout);
  return env?.ok && env.data?.paused ? env.data.paused : null;
}

export interface RestartOutcome { action: 'restarted' | 'refused' | 'not-running' | 'failed' | 'skipped' | 'offered'; detail: string }

export const RESTART_LATER = 'Restart the coordinator later with `minions settings restart` (graceful: waits for no active workers).';

/** Graceful coordinator restart in the runtime: refused (not forced) while worker leases are active. */
export async function restartCoordinator(project: ProjectJson, runtime: SettingsRuntime): Promise<RestartOutcome> {
  if (!(await runtime.running(project))) return { action: 'not-running', detail: 'the runtime is not running; the next `minions start` uses the new settings' };
  const r = await runtime.exec(project, ['minions', 'coordinator', 'restart', '--recover', '--json']);
  const env = lastJson<{ action?: string; reason?: string }>(r.stdout);
  if (env?.ok) return { action: 'restarted', detail: `${env.data?.action ?? 'restarted'} (${env.data?.reason ?? ''})` };
  const msg = env?.error?.message ?? ((r.stderr || r.stdout).trim().split('\n').at(-1) ?? 'no output');
  return /active worker lease/.test(msg) ? { action: 'refused', detail: `${msg} ${RESTART_LATER}` } : { action: 'failed', detail: msg };
}

export interface SetOptions {
  layer?: SettingLayer;
  /** Confirm loosening changes and the restart without asking. */
  yes?: boolean;
  /** true: restart without asking; false: never restart (only offer); undefined: ask. */
  restart?: boolean;
  dryRun?: boolean;
}

export interface SetResult {
  key: string;
  from: unknown;
  to: unknown;
  layer: SettingLayer | 'runtime';
  file: string | null;
  changed: boolean;
  written: boolean;
  dryRun: boolean;
  loosens: string | null;
  needsRestart: boolean;
  restart: RestartOutcome | null;
  warnings: string[];
  nextSteps: string[];
}

/** Applies one setting (config or runtime control). Never prints secrets; throws before writing on invalid input. */
export async function applySetting(ctx: SettingsContext, key: string, input: string, o: SetOptions, deps: SettingsApplyDeps): Promise<SetResult> {
  const def = requireSetting(key);
  const value = parseSettingValue(def, input);
  const { project } = ctx;
  const dryRun = !!o.dryRun;
  if (def.type === 'control') {
    const which = key === 'pause.intake' ? 'intake' : 'starts';
    const from = ctx.paused ? (ctx.paused[which] ? 'paused' : 'running') : null;
    const base = { key, from, to: value, layer: 'runtime' as const, file: null, dryRun, loosens: null, needsRestart: false, restart: null, warnings: [] };
    if (!(await deps.runtime.running(project))) {
      throw new MinionsError('PRECONDITION', 'The runtime is not running, so there is nothing to pause or resume.', 'Run `minions start` first.');
    }
    if (from === value || dryRun) return { ...base, changed: from !== value, written: false, nextSteps: [] };
    const r = await deps.runtime.exec(project, ['minions', value === 'paused' ? 'pause' : 'resume', `--${which}`, '--json']);
    const env = lastJson(r.stdout);
    if (!env?.ok) throw new MinionsError('INTERNAL', `minions ${value === 'paused' ? 'pause' : 'resume'} failed in the runtime: ${env?.error?.message ?? 'no output'}`);
    return { ...base, changed: true, written: true, nextSteps: [] };
  }
  const layer = o.layer ?? 'local';
  const change = await planSetting(ctx, key, value, layer);
  const result: SetResult = {
    key, from: change.from, to: change.to, layer, file: change.file, changed: change.changed, written: false, dryRun,
    loosens: change.loosens, needsRestart: change.needsRestart, restart: null, warnings: [...change.warnings], nextSteps: [],
  };
  if (!change.changed || dryRun) return result;
  if (change.loosens && !o.yes) {
    const ok = await deps.confirm(`${key}: ${formatValue(change.from)} -> ${formatValue(change.to)} loosens policy: ${change.loosens}. Apply? (y/N)`);
    if (ok === null) throw new MinionsError('POLICY_DENIED', `${key}: this change loosens policy (${change.loosens}) and needs a confirmation.`, 'Run it in a terminal, or pass --yes to confirm.', { path: key });
    if (!ok) throw new MinionsError('PRECONDITION', `Not confirmed; ${key} was not changed.`);
  }
  result.warnings.push(...await writeSetting(project, change));
  result.written = true;
  if (layer === 'shared') result.nextSteps.push(`Commit ${change.file} so the change reaches everyone using this repository.`);
  if (change.needsRestart) result.restart = await maybeRestart(project, o, deps);
  return result;
}

async function maybeRestart(project: ProjectJson, o: SetOptions, deps: SettingsApplyDeps): Promise<RestartOutcome> {
  if (o.restart === false) return { action: 'offered', detail: RESTART_LATER };
  if (!(await deps.runtime.running(project))) return { action: 'not-running', detail: 'the runtime is not running; the next `minions start` uses the new settings' };
  if (!o.yes && o.restart !== true) {
    const ok = await deps.confirm('This change needs a coordinator restart (graceful; refused while workers are active). Restart the coordinator now? (Y/n)');
    if (ok === null) return { action: 'offered', detail: `${RESTART_LATER} (or pass --restart)` };
    if (!ok) return { action: 'skipped', detail: RESTART_LATER };
  }
  return restartCoordinator(project, deps.runtime);
}

// ---------------------------------------------------------------- output

export function formatList(views: SettingView[]): string {
  const out: string[] = [];
  for (const g of SETTING_GROUPS) {
    const items = views.filter((v) => v.group === g);
    if (!items.length) continue;
    out.push(`${g}:`);
    for (const v of items) out.push(`  ${v.key} = ${formatValue(v.value)}  (${v.source}${v.needsRestart ? '; restart' : ''})`);
  }
  return out.join('\n');
}

export function formatSet(r: SetResult): string {
  return [
    `${r.key}: ${formatValue(r.from)} -> ${formatValue(r.to)}${r.dryRun ? ' (dry run: nothing changed)' : !r.changed ? ' (unchanged)' : r.file ? ` (written to ${r.file})` : ' (applied to the runtime)'}`,
    ...(r.loosens ? [`loosens policy: ${r.loosens}`] : []),
    ...(r.written && r.layer !== 'runtime' ? ['Derived files regenerated (runtime config, plugin).'] : []),
    ...(r.restart ? [`coordinator restart: ${r.restart.action} - ${r.restart.detail}`] : []),
    ...r.warnings.map((w) => `warning: ${w}`),
    ...r.nextSteps.map((s) => `next: ${s}`),
  ].join('\n');
}

// ---------------------------------------------------------------- register

export interface SettingsCliIO {
  confirm: (q: string) => Promise<boolean | null>;
  /** Runs the interactive menu (src/host/settings-menu.ts). */
  menu: (project: ProjectJson, o: { layer: SettingLayer }) => Promise<void>;
}

async function currentProject(): Promise<ProjectJson> {
  const { projectId } = await projectForPath(process.cwd());
  return loadProjectJson(projectId);
}

export function registerSettings(program: Command, io: SettingsCliIO): Command {
  const runtime = defaultSettingsRuntime;
  const cmd = program.command('settings')
    .description('View and change settings: an interactive menu, or --list / set <key> <value> for scripts')
    .option('--list', 'list every setting with its value, source and how a change takes effect')
    .option('--shared', 'write to the shared .minions/config.json (shared installs; default: the host-only config.local.json)')
    .action(action(async (o: { list?: boolean; shared?: boolean }, c: Command) => {
      requireMode('host');
      const { json } = globalOpts(c);
      const project = await currentProject();
      if (o.list || json) {
        await listAction(project, json, runtime);
        return;
      }
      // Without a TTY the menu degrades to numbered prompts (terminalMenuIO); end of input quits it.
      await io.menu(project, { layer: o.shared ? 'shared' : 'local' });
    }));
  addSetCommand(cmd, io, runtime);
  cmd.command('restart')
    .description('Restart the coordinator gracefully so prompt/launch settings take effect (refused while workers are active)')
    .action(action(async (_o: unknown, c: Command) => {
      requireMode('host');
      const r = await restartCoordinator(await currentProject(), runtime);
      emit(r, { json: globalOpts(c).json, human: (x: RestartOutcome) => `coordinator restart: ${x.action} - ${x.detail}` });
      if (r.action === 'refused' || r.action === 'failed') process.exitCode = 1;
    }));
  return cmd;
}

async function listAction(project: ProjectJson, json: boolean, runtime: SettingsRuntime): Promise<void> {
  const ctx = await loadSettingsContext(project, { pausedState: (p) => runtimePaused(p, runtime) });
  const views = listSettings(ctx);
  emit({ projectId: project.projectId, settings: views }, { json, human: () => formatList(views) });
}

/** `settings set` (also registered as the `config set` alias). */
export function addSetCommand(parent: Command, io: Pick<SettingsCliIO, 'confirm'>, runtime: SettingsRuntime = defaultSettingsRuntime): Command {
  return parent.command('set <key> <value>')
    .description('Change one setting (validated; loosening changes need a confirmation or --yes)')
    .option('--shared', 'write to the shared .minions/config.json (shared installs only)')
    .option('-y, --yes', 'confirm loosening changes and the coordinator restart without asking')
    .option('--restart', 'restart the coordinator when the change needs it, without asking')
    .option('--no-restart', 'never restart the coordinator (print how to do it later)')
    .option('--dry-run', 'validate and show the change; write nothing')
    .action(action(async (key: string, value: string, o: { shared?: boolean; yes?: boolean; restart?: boolean }, c: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(c);
      const project = await currentProject();
      const def = requireSetting(key);
      const ctx = await loadSettingsContext(project, def.type === 'control' ? { pausedState: (p) => runtimePaused(p, runtime) } : {});
      // --restart / --no-restart: true / false; neither: ask (commander's default for --no-restart is true).
      const restart = c.getOptionValueSource('restart') === 'cli' ? o.restart : undefined;
      const shared = !!(o.shared || (c.parent?.opts() as { shared?: boolean } | undefined)?.shared);
      const r = await applySetting(ctx, key, value, { layer: shared ? 'shared' : 'local', yes: o.yes, restart, dryRun }, { runtime, confirm: json ? async () => null : io.confirm });
      emit(r, { json, human: formatSet });
    }));
}

/** `config list` alias of `settings --list`. */
export function addListCommand(parent: Command, runtime: SettingsRuntime = defaultSettingsRuntime): Command {
  return parent.command('list')
    .description('Alias of `minions settings --list`')
    .action(action(async (_o: unknown, c: Command) => {
      requireMode('host');
      await listAction(await currentProject(), globalOpts(c).json, runtime);
    }));
}

export type { SettingChange };
