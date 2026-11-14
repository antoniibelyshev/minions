// `minions mode show|set` (host only; docs/design/autonomy.md Decision 11): switching mode rewrites the keys the mode
// decides (MODE_KEYS) in the project config layer. config.local.json is a separate layer and stays as it is.
import { Argument, type Command } from 'commander';
import { MODE_KEYS, modeDefaults } from '../config/modes.js';
import { MODES, type Mode } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { projectPaths } from '../core/paths.js';
import { VERSION } from '../core/version.js';
import { editProjectConfig } from './config-write.js';
import { projectJsonBytes, writeGenerated } from './install.js';
import { loadProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { runtimeOf } from './runtime.js';

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const get = (o: Raw, key: string): unknown => key.split('.').reduce<unknown>((cur, k) => (isObj(cur) ? cur[k] : undefined), o);
function put(o: Raw, key: string, v: unknown): void {
  const ks = key.split('.');
  let cur = o;
  for (const k of ks.slice(0, -1)) { if (!isObj(cur[k])) cur[k] = {}; cur = cur[k] as Raw; }
  if (v === undefined) delete cur[ks.at(-1)!]; else cur[ks.at(-1)!] = structuredClone(v);
}

export interface ModeChange { key: string; from: unknown; to: unknown }
export interface ModeSetResult {
  projectId: string; path: string; from: Mode; to: Mode; dryRun: boolean; applied: boolean; configRevision: number;
  changes: ModeChange[]; notes: string[];
}

export async function runModeSet(to: string, o: { dryRun?: boolean }, deps: { cwd: string }): Promise<ModeSetResult> {
  if (!(MODES as readonly string[]).includes(to)) throw new MinionsError('INVALID_CONFIG', `Unknown mode "${to}".`, `Use one of: ${MODES.join(', ')}.`);
  const mode = to as Mode;
  const { projectId } = await projectForPath(deps.cwd);
  const project = await loadProjectJson(projectId);
  const target = modeDefaults(mode, { baseBranch: project.baseBranch, identity: project.gitIdentity, projectId, packageVersion: VERSION }) as unknown as Raw;
  const changes: ModeChange[] = [];
  const mutate = (raw: Raw): Raw | null => {
    changes.length = 0;
    const next = structuredClone(raw);
    for (const key of MODE_KEYS) {
      const from = get(raw, key), want = get(target, key);
      if (JSON.stringify(from) === JSON.stringify(want)) continue;
      changes.push({ key, from, to: want });
      put(next, key, want);
    }
    return changes.length ? next : null;
  };
  const edit = await editProjectConfig(project, mutate, { dryRun: !!o.dryRun });
  const notes: string[] = [];
  if (edit.written && project.mode !== mode) {
    await writeGenerated(projectId, projectPaths(projectId).projectJson, projectJsonBytes({ ...project, mode }));
  }
  const runtime = runtimeOf(project);
  const modeRuntime = mode === 'independent' ? 'docker' : 'host';
  if (runtime !== modeRuntime) notes.push(`The agent runtime stays ${runtime} (${mode} starts new projects on ${modeRuntime}): \`minions runtime set ${modeRuntime}\` switches it.`);
  if (edit.written) notes.push('Restart with `minions down && minions start` to apply every change.');
  notes.push(...edit.warnings);
  return { projectId, path: edit.path, from: project.mode, to: mode, dryRun: !!o.dryRun, applied: edit.written, configRevision: edit.revision, changes, notes };
}

export function formatModeSet(r: ModeSetResult): string {
  const show = (v: unknown) => (v === undefined ? '(unset)' : JSON.stringify(v));
  const L = [`Mode of project ${r.projectId}: ${r.from} -> ${r.to}${r.dryRun ? ' (dry run: nothing changed)' : r.applied ? ` (${r.path}, configRevision ${r.configRevision})` : ' (unchanged)'}`];
  for (const c of r.changes) L.push(`  ${c.key}: ${show(c.from)} -> ${show(c.to)}`);
  for (const n of r.notes) L.push(`  note: ${n}`);
  return L.join('\n');
}

export function registerMode(program: Command): Command {
  const m = program.command('mode').description('Operating mode: independent (the agents run the project) or supervised (you review and merge all code)');
  m.command('show').description('Show the mode of this project')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      const project = await loadProjectJson((await projectForPath(process.cwd())).projectId);
      emit({ projectId: project.projectId, mode: project.mode }, { json: globalOpts(cmd).json, human: (d: { mode: Mode }) => `Mode: ${d.mode}` });
    }));
  m.command('set').description('Switch the mode: rewrites the keys the mode decides in the project config (config.local.json overrides stay)')
    .addArgument(new Argument('<mode>', MODES.join(' | ')).choices([...MODES]))
    .action(action(async (to: string, _o: unknown, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      emit(await runModeSet(to, { dryRun }, { cwd: process.cwd() }), { json, human: formatModeSet });
    }));
  return m;
}
