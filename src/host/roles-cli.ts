// `minions config roles ...` (docs/design/roles-and-workflows.md D2): the approval path for project roles.
//
// - runtime: `propose --file <f>` validates a proposal against the runtime config and stores it in the runtime DB
//   (role_proposals); nothing becomes effective. `list` / `show` are read-only (also on the host).
// - host only: `apply <proposalId>` reads the proposal through the runtime, re-validates it against the host's
//   own config, shows the config diff and the prompt, asks (or --yes), writes the prompt file and the config via
//   editProjectConfig (configRevision + 1, derived files regenerated) and marks the proposal applied.
//   `remove <name>` is refused while a workflow or an active lease uses the role. Neither commits nor restarts.
// An in-runtime `apply` / `remove` is rejected like an in-runtime `work approve`.
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { validateConfig } from '../config/resolve.js';
import { isBuiltinRole, roleRegistry } from '../config/roles.js';
import type { MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode, runtimeMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite, ensureDir, readJson } from '../core/fsutil.js';
import { emit } from '../core/output.js';
import { openDb, type Lease, type RuntimeDb } from '../runtime/db.js';
import { inMinionsContainer, runtimePaths } from '../runtime/paths.js';
import {
  checkProposal, formatProposalLine, formatRoleLine, formatShow, formatSummary, isProposalId, markApplied, mergeProposal, proposalPromptPath,
  proposalView, proposeRole, roleView, showProposal, showRole, workflowsUsing,
  type ProposalSummary, type ShowRole, type ProposalView, type RoleView, type ShowProposal,
} from '../runtime/role-proposals.js';
import { editProjectConfig, readProjectConfigRaw } from './config-write.js';
import { writeGenerated } from './install.js';
import { loadEffectiveConfig, loadProjectJson, projectConfigPath, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { defaultSettingsRuntime, type SettingsRuntime } from './settings-cli.js';

/** How the change takes effect: the plugin (agent definitions) is read at coordinator session start. */
export const ROLES_RESTART = 'Restart required: the coordinator loads agent definitions at session start. Run `minions settings restart` (graceful; refused while workers are active) or `minions down && minions start`, or let the coordinator\'s idle restart pick it up.';

// ---------------------------------------------------------------- diff

/** Line diff (LCS) of two texts: `  ` unchanged, `- ` removed, `+ ` added. */
export function lineDiff(before: string | null, after: string | null): string[] {
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) { out.push(`+ ${b[j]}`); j++; }
    else { out.push(`- ${a[i]}`); i++; }
  }
  return out;
}

const pretty = (v: unknown) => (v === undefined ? null : JSON.stringify(v, null, 2));
const get = (raw: Record<string, unknown>, section: string, key: string): unknown => {
  const s = raw[section];
  return s && typeof s === 'object' && Object.hasOwn(s, key) ? (s as Record<string, unknown>)[key] : undefined;
};

export interface ConfigDiffEntry { path: string; change: 'add' | 'change' | 'remove'; lines: string[] }

/** Diff of the given `section.key` entries between two raw config objects (only those that differ). */
export function configDiff(before: Record<string, unknown>, after: Record<string, unknown>, keys: [section: string, key: string][]): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  for (const [section, key] of keys) {
    const b = pretty(get(before, section, key)), a = pretty(get(after, section, key));
    if (a === b) continue;
    out.push({ path: `${section}.${key}`, change: b === null ? 'add' : a === null ? 'remove' : 'change', lines: lineDiff(b, a) });
  }
  return out;
}

const formatDiff = (d: ConfigDiffEntry[]) => d.flatMap((e) => [`${e.path} (${e.change}):`, ...e.lines.map((l) => `  ${l}`)]);

// ---------------------------------------------------------------- runtime access from the host

const lastEnvelope = <T>(stdout: string): { ok: boolean; data?: T; error?: { code?: string; message?: string; hint?: string } } | null => {
  try { return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { return null; }
};

/** Runs `minions <args> --json` in the project runtime and returns `data`; throws the runtime's error. */
async function runtimeJson<T>(project: ProjectJson, runtime: SettingsRuntime, args: string[], what: string): Promise<T> {
  if (!(await runtime.running(project))) {
    throw new MinionsError('PRECONDITION', `The runtime is not running, so ${what} cannot be read.`, 'Run `minions start --no-attach` first (the role proposals and leases live in the runtime database).');
  }
  const r = await runtime.exec(project, ['minions', ...args, '--json']);
  const env = lastEnvelope<T>(r.stdout);
  if (!env) throw new MinionsError('INTERNAL', `${what}: unexpected output from the runtime.`, undefined, { stdout: r.stdout.slice(-500), stderr: r.stderr.slice(-500) });
  if (!env.ok) {
    const code = env.error?.code === 'NOT_FOUND' || env.error?.code === 'PRECONDITION' ? env.error.code : 'INTERNAL';
    throw new MinionsError(code, `${what}: ${env.error?.message ?? 'failed in the runtime'}`, env.error?.hint);
  }
  return env.data as T;
}

const refuseInRuntime = (what: string, hint: string) => {
  if (runtimeMode() !== 'host' || inMinionsContainer()) {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `${what} runs only in the host CLI (current: ${runtimeMode() === 'host' ? 'the minions container' : runtimeMode()}); roles are host-applied configuration.`, hint);
  }
};

// ---------------------------------------------------------------- apply

export interface RolesHostDeps {
  runtime: SettingsRuntime;
  /** Yes/no question; null when no terminal can answer. */
  confirm: (question: string) => Promise<boolean | null>;
  /** Shows the plan (diff and prompt) before the question (human mode: stderr). */
  show?: (text: string) => void;
}

export interface ApplyResult {
  proposalId: string; name: string; file: string; promptFile: string; revision: number;
  dryRun: boolean; written: boolean; marked: boolean;
  summary: ProposalSummary; diff: ConfigDiffEntry[]; prompt: { change: 'add' | 'change' | 'unchanged'; lines: string[] };
  restartRequired: boolean; restart: string; warnings: string[]; nextSteps: string[];
}

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function confirmOrRefuse(deps: RolesHostDeps, question: string, what: string): Promise<void> {
  const ok = await deps.confirm(question);
  if (ok === null) throw new MinionsError('POLICY_DENIED', `${what} needs a confirmation.`, 'Run it in a terminal, or pass --yes after reviewing the diff (`--dry-run --json` shows it).');
  if (!ok) throw new MinionsError('PRECONDITION', `Not confirmed; ${what.toLowerCase()} was not done.`);
}

/** `minions config roles apply <proposalId>` (host only). Never commits, never restarts. */
export async function applyRoleProposal(project: ProjectJson, id: string, o: { yes?: boolean; dryRun?: boolean }, deps: RolesHostDeps): Promise<ApplyResult> {
  if (!isProposalId(id)) throw new MinionsError('PRECONDITION', `"${id}" is not a proposal id (rp_ + 8 hex characters).`, 'List proposals with `minions config roles list`.');
  const shown = await runtimeJson<ShowProposal>(project, deps.runtime, ['config', 'roles', 'show', id], `role proposal ${id}`);
  if (shown?.kind !== 'proposal' || !shown.proposal) throw new MinionsError('INTERNAL', `role proposal ${id}: the runtime returned no proposal.`);
  if (shown.view.state !== 'pending') {
    throw new MinionsError('PRECONDITION', `Proposal ${id} is ${shown.view.state}${shown.view.state === 'superseded' ? ' by a newer proposal for the same role' : ''}; nothing to apply.`,
      'List pending proposals with `minions config roles list`.');
  }
  // The runtime is not trusted: validate again against the host's own effective config.
  const eff = (await loadEffectiveConfig(project)).config;
  const { proposal, summary } = await checkProposal(eff, shown.proposal, `role proposal ${id}`);
  const promptRel = proposalPromptPath(proposal.name);
  const promptFile = join(dirname(projectConfigPath(project)), promptRel);
  const mutate = (raw: Record<string, unknown>) => mergeProposal(raw, proposal, { prompt: promptRel });
  const plan = await editProjectConfig(project, mutate, { dryRun: true }); // throws INVALID_CONFIG; nothing written
  const keys: [string, string][] = [['roles', proposal.name], ...Object.keys(proposal.workflows ?? {}).map((w): [string, string] => ['workflows', w])];
  const diff = configDiff(plan.before, plan.after, keys);
  const oldPrompt = await readText(promptFile);
  const newPrompt = proposal.promptText.endsWith('\n') ? proposal.promptText : `${proposal.promptText}\n`;
  const prompt = { change: oldPrompt === null ? 'add' as const : oldPrompt === newPrompt ? 'unchanged' as const : 'change' as const, lines: lineDiff(oldPrompt, newPrompt) };
  const result: ApplyResult = {
    proposalId: id, name: proposal.name, file: plan.path, promptFile, revision: plan.revision, dryRun: !!o.dryRun, written: false, marked: false,
    summary, diff, prompt, restartRequired: true, restart: ROLES_RESTART, warnings: [], nextSteps: [],
  };
  if (o.dryRun) return result;
  if (!o.yes) {
    deps.show?.(formatApplyPlan(result));
    await confirmOrRefuse(deps, `Apply role proposal ${id} (${proposal.name}) to ${plan.path}? (y/N)`, `Applying role proposal ${id}`);
  }
  // The prompt file first: regenerating the plugin (inside editProjectConfig) reads it.
  await ensureDir(dirname(promptFile));
  if (prompt.change !== 'unchanged') await writeGenerated(project.projectId, promptFile, Buffer.from(newPrompt));
  let edit;
  try {
    edit = await editProjectConfig(project, mutate);
  } catch (e) {
    // Config not written (revision unchanged): put the prompt file back.
    const now = await readProjectConfigRaw(project).catch(() => null);
    if (now && Number(now.raw.configRevision ?? 1) === Number(plan.before.configRevision ?? 1) && prompt.change !== 'unchanged') {
      if (oldPrompt === null) await rm(promptFile, { force: true }); else await atomicWrite(promptFile, oldPrompt);
    }
    throw e;
  }
  result.written = edit.written;
  result.revision = edit.revision;
  result.warnings.push(...edit.warnings);
  try {
    await runtimeJson<ProposalView>(project, deps.runtime, ['config', 'roles', 'mark-applied', id, '--revision', String(edit.revision)], `marking proposal ${id} applied`);
    result.marked = true;
  } catch (e) {
    result.warnings.push(`the role is applied, but proposal ${id} could not be marked applied in the runtime: ${(e as Error).message}`);
  }
  if (project.visibility === 'shared') result.nextSteps.push(`Commit ${plan.path} and ${promptFile} so the role reaches everyone using this repository.`);
  result.nextSteps.push(ROLES_RESTART);
  return result;
}

export function formatApplyPlan(r: ApplyResult): string {
  return [
    formatSummary(r.summary),
    '',
    `config ${r.file} (configRevision ${r.revision}):`,
    ...formatDiff(r.diff),
    '',
    `prompt ${r.promptFile} (${r.prompt.change}):`,
    ...r.prompt.lines.map((l) => `  ${l}`),
  ].join('\n');
}

export function formatApply(r: ApplyResult): string {
  return [
    ...(r.dryRun ? [formatApplyPlan(r), '', 'dry run: nothing written'] : [
      `applied role proposal ${r.proposalId} (${r.name}): ${r.file} (configRevision ${r.revision}), prompt ${r.promptFile}`,
      'Derived files regenerated (runtime config, plugin).',
      r.marked ? `proposal ${r.proposalId} marked applied` : `proposal ${r.proposalId} not marked applied (see warning)`,
    ]),
    ...r.warnings.map((w) => `warning: ${w}`),
    ...r.nextSteps.map((s) => `next: ${s}`),
  ].join('\n');
}

// ---------------------------------------------------------------- remove

export interface RemoveResult {
  name: string; file: string; revision: number; dryRun: boolean; written: boolean; diff: ConfigDiffEntry[];
  restartRequired: boolean; restart: string; warnings: string[]; nextSteps: string[];
}

/** `minions config roles remove <name>` (host only): refused while a workflow or an active lease uses the role. */
export async function removeRole(project: ProjectJson, name: string, o: { yes?: boolean; dryRun?: boolean }, deps: RolesHostDeps): Promise<RemoveResult> {
  if (isBuiltinRole(name)) {
    throw new MinionsError('PRECONDITION', `${name} is a built-in role and cannot be removed.`, 'Drop its overrides by editing roles.<name> in the project config on the host.');
  }
  const eff = (await loadEffectiveConfig(project)).config;
  if (!Object.hasOwn(eff.roles ?? {}, name)) throw new MinionsError('NOT_FOUND', `No project role ${name}.`, 'List roles with `minions config roles list`.');
  const workflows = workflowsUsing(eff, name);
  const repairs = Object.entries(eff.roles ?? {}).filter(([, r]) => (r as { repairTo?: string } | undefined)?.repairTo === name).map(([n]) => `roles.${n}.repairTo`);
  if (workflows.length || repairs.length) {
    throw new MinionsError('PRECONDITION', `Role ${name} is in use: ${[...workflows.map((w) => `workflow ${w}`), ...repairs].join(', ')}.`,
      'Remove it from those workflows (and repairTo references) first, then remove the role.', { workflows, references: repairs });
  }
  const { leases } = await runtimeJson<{ leases: Lease[] }>(project, deps.runtime, ['work', 'list'], 'active leases');
  const active = leases.filter((l) => l.status === 'active' && l.role === name);
  if (active.length) {
    throw new MinionsError('PRECONDITION', `Role ${name} has ${active.length} active lease(s) (${active.map((l) => `${l.id} on ${l.task_id}`).join(', ')}).`,
      'Wait for those stages to finish (or release them with `minions work release`), then remove the role.', { leases: active.map((l) => l.id) });
  }
  const { raw } = await readProjectConfigRaw(project);
  if (!Object.hasOwn((raw.roles as Record<string, unknown> | undefined) ?? {}, name)) {
    throw new MinionsError('PRECONDITION', `Role ${name} is not defined in ${projectConfigPath(project)} (it comes from another layer, e.g. config.local.json).`, 'Remove it from that file by hand.');
  }
  const mutate = (r: Record<string, unknown>) => {
    const roles = { ...(r.roles as Record<string, unknown>) };
    delete roles[name];
    const out = { ...r, roles };
    if (!Object.keys(roles).length) delete (out as Record<string, unknown>).roles;
    return out;
  };
  const plan = await editProjectConfig(project, mutate, { dryRun: true });
  const diff = configDiff(plan.before, plan.after, [['roles', name]]);
  const result: RemoveResult = { name, file: plan.path, revision: plan.revision, dryRun: !!o.dryRun, written: false, diff, restartRequired: true, restart: ROLES_RESTART, warnings: [], nextSteps: [] };
  if (o.dryRun) return result;
  if (!o.yes) {
    deps.show?.([`config ${plan.path}:`, ...formatDiff(diff)].join('\n'));
    await confirmOrRefuse(deps, `Remove role ${name} from ${plan.path}? (y/N)`, `Removing role ${name}`);
  }
  const edit = await editProjectConfig(project, mutate);
  result.written = edit.written;
  result.revision = edit.revision;
  result.warnings.push(...edit.warnings);
  const prompt = (get(plan.before, 'roles', name) as { prompt?: string } | undefined)?.prompt;
  if (prompt) result.nextSteps.push(`The prompt file ${join(dirname(plan.path), prompt)} is left in place; delete it if no longer needed.`);
  if (project.visibility === 'shared') result.nextSteps.push(`Commit ${plan.path} so the change reaches everyone using this repository.`);
  result.nextSteps.push(ROLES_RESTART);
  return result;
}

export function formatRemove(r: RemoveResult): string {
  return [
    ...(r.dryRun ? [`config ${r.file}:`, ...formatDiff(r.diff), '', 'dry run: nothing written'] : [`removed role ${r.name} from ${r.file} (configRevision ${r.revision})`, 'Derived files regenerated (runtime config, plugin).']),
    ...r.warnings.map((w) => `warning: ${w}`),
    ...r.nextSteps.map((s) => `next: ${s}`),
  ].join('\n');
}

// ---------------------------------------------------------------- list / show

export interface RolesList { roles: RoleView[]; proposals: ProposalView[] | null; note?: string }

const listRoles = (cfg: MinionsConfig): RoleView[] => roleRegistry(cfg).map((d) => roleView(cfg, d));

function formatList(d: RolesList): string {
  return [
    'roles:', ...d.roles.map((r) => `  ${formatRoleLine(r)}`),
    d.proposals === null ? `proposals: ${d.note ?? 'unavailable'}` : d.proposals.length ? 'proposals:' : 'proposals: none',
    ...(d.proposals ?? []).map((p) => `  ${formatProposalLine(p)}`),
  ].join('\n');
}

// ---------------------------------------------------------------- register

interface RuntimeCtx { db: RuntimeDb; config: MinionsConfig }

async function withRuntime<T>(fn: (ctx: RuntimeCtx) => Promise<T> | T): Promise<T> {
  const paths = runtimePaths();
  const config = validateConfig(await readJson(paths.configJson), paths.configJson);
  const db = openDb(paths.db);
  try { return await fn({ db, config }); } finally { db.close(); }
}

async function currentProject(): Promise<ProjectJson> {
  const { projectId } = await projectForPath(process.cwd());
  return loadProjectJson(projectId);
}

export interface RolesCliIO { confirm: (question: string) => Promise<boolean | null>; runtime?: SettingsRuntime }

/** Registers `config roles list|show|propose|apply|remove` under the `config` command. */
export function registerRoles(config: Command, io: RolesCliIO): Command {
  const runtime = io.runtime ?? defaultSettingsRuntime;
  const roles = config.command('roles').description('Project worker roles: list/show (read-only), propose (runtime), apply/remove (host only)');
  const hostDeps = (json: boolean): RolesHostDeps => ({
    runtime, confirm: json ? async () => null : io.confirm, show: json ? undefined : (t) => process.stderr.write(`${t}\n`),
  });

  roles.command('list')
    .description('List the configured roles and the role proposals (pending; --all: every state)')
    .option('--all', 'include applied and superseded proposals')
    .action(action(async (o: { all?: boolean }, cmd: Command) => {
      const { json } = globalOpts(cmd);
      let data: RolesList;
      if (runtimeMode() !== 'host') {
        data = await withRuntime(({ db, config: cfg }) => ({ roles: listRoles(cfg), proposals: db.roleProposals({ all: !!o.all }).map(proposalView) }));
      } else {
        const project = await currentProject();
        const cfg = (await loadEffectiveConfig(project)).config;
        data = { roles: listRoles(cfg), proposals: null };
        try {
          data.proposals = (await runtimeJson<RolesList>(project, runtime, ['config', 'roles', 'list', ...(o.all ? ['--all'] : [])], 'role proposals')).proposals;
        } catch (e) { data.note = (e as Error).message; }
      }
      emit(data, { json, human: formatList });
    }));

  roles.command('show <nameOrProposalId>')
    .description('Show one configured role (fields, tools, policy column, workflows) or one proposal (rp_...) with its summary')
    .action(action(async (target: string, _o: unknown, cmd: Command) => {
      const { json } = globalOpts(cmd);
      if (runtimeMode() !== 'host') {
        const data = await withRuntime<ShowProposal | ShowRole>((ctx) => (isProposalId(target) ? showProposal(ctx, target) : showRole(ctx.config, target)));
        emit(data, { json, human: formatShow });
        return;
      }
      const project = await currentProject();
      const data = isProposalId(target)
        ? await runtimeJson<ShowProposal>(project, runtime, ['config', 'roles', 'show', target], `role proposal ${target}`)
        : showRole((await loadEffectiveConfig(project)).config, target);
      emit(data, { json, human: formatShow });
    }));

  roles.command('propose')
    .description('Validate a role proposal and store it for the owner (runtime only; nothing becomes effective until `config roles apply` on the host)')
    .requiredOption('--file <file>', 'proposal JSON: {name, role: {...}, promptText, reason, workflows?}')
    .action(action(async (o: { file: string }, cmd: Command) => {
      requireMode('runtime');
      const r = await withRuntime((ctx) => proposeRole(ctx, o.file));
      emit(r, { json: globalOpts(cmd).json, human: (d: typeof r) => [`proposal ${d.proposalId} stored (pending; not effective)`, formatSummary(d.summary), ...(d.superseded.length ? [`supersedes ${d.superseded.join(', ')}`] : []), `owner applies it on the host: ${d.applyCommand}`].join('\n') });
    }));

  roles.command('apply <proposalId>')
    .description('Host only: apply a role proposal (shows the config diff and the prompt; writes config + prompt file, configRevision + 1; restart required)')
    .option('-y, --yes', 'apply without asking (after reviewing the diff)')
    .option('--dry-run', 'validate and show the diff; write nothing')
    .action(action(async (id: string, o: { yes?: boolean }, cmd: Command) => {
      refuseInRuntime('`config roles apply`', `Ask the owner to run \`minions config roles apply ${id}\` on the host, in the repository.`);
      const { json, dryRun } = globalOpts(cmd);
      const r = await applyRoleProposal(await currentProject(), id, { yes: o.yes, dryRun }, hostDeps(json));
      emit(r, { json, human: formatApply });
    }));

  roles.command('remove <name>')
    .description('Host only: remove a project role (refused while a workflow or an active lease uses it; restart required)')
    .option('-y, --yes', 'remove without asking')
    .option('--dry-run', 'show the change; write nothing')
    .action(action(async (name: string, o: { yes?: boolean }, cmd: Command) => {
      refuseInRuntime('`config roles remove`', `Ask the owner to run \`minions config roles remove ${name}\` on the host, in the repository.`);
      const { json, dryRun } = globalOpts(cmd);
      const r = await removeRole(await currentProject(), name, { yes: o.yes, dryRun }, hostDeps(json));
      emit(r, { json, human: formatRemove });
    }));

  roles.command('mark-applied <proposalId>', { hidden: true })
    .description('Runtime only, called by the host\'s `config roles apply`: mark a proposal applied (only when its role is in the runtime config)')
    .option('--revision <n>', 'the configRevision the host wrote')
    .action(action(async (id: string, o: { revision?: string }, cmd: Command) => {
      requireMode('runtime');
      const revision = o.revision === undefined ? null : Number.parseInt(o.revision, 10);
      const r = await withRuntime((ctx) => markApplied(ctx, id, Number.isFinite(revision) ? revision : null));
      emit(r, { json: globalOpts(cmd).json, human: formatProposalLine });
    }));
  return roles;
}
