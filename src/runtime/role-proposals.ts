/**
 * Role proposals (docs/design/roles-and-workflows.md D2). The coordinator drafts a project role and stores it
 * with `minions config roles propose --file <f>` (runtime); the owner applies it on the host with
 * `minions config roles apply <id>` (src/host/roles-cli.ts). A stored proposal never makes anything
 * effective: the runtime only sees roles through the host-resolved runtime config.
 *
 * Validation reuses the config rules (strict schema, name rules, cross-field checks, workflow invariants) by
 * validating the current config with the proposal merged in, plus the prompt checks of the plugin generator;
 * nothing here re-implements a role rule. The host repeats the same checks before it writes.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { can, strictness } from '../config/capabilities.js';
import { validateConfig } from '../config/resolve.js';
import { isBuiltinWorkerRole, roleNameProblem, workerRole, type RoleDef } from '../config/roles.js';
import { CAPABILITIES, type Capability, type Effect, type MinionsConfig } from '../config/schema.js';
import { normalizeStage } from '../config/workflows.js';
import { displayText, FORMAT_CHAR } from '../core/control-chars.js';
import { MinionsError, invalidConfig, zodIssues } from '../core/errors.js';
import { resolveRolePrompt, roleTools } from '../plugin/generate.js';
import type { RoleProposalRow, RuntimeDb } from './db.js';

/** Proposal ids: `rp_` + 8 hex characters (an underscore, so an id never looks like a role name). */
export const PROPOSAL_ID_PATTERN = /^rp_[0-9a-f]{8}$/;
export const isProposalId = (s: string) => PROPOSAL_ID_PATTERN.test(s);
export const newProposalId = () => `rp_${randomBytes(4).toString('hex')}`;

/** The file `propose` reads (D2): `{name, role, promptText, reason, workflows?}`. The role fields are checked by the config schema. */
export const RoleProposalSchema = z.object({
  name: z.string().min(1),
  role: z.record(z.string(), z.unknown()),
  promptText: z.string().min(1),
  reason: z.string().min(1),
  workflows: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type RoleProposal = z.infer<typeof RoleProposalSchema>;

/** Where `apply` writes the prompt, relative to the config dir (`.minions/` shared, the project dir private). */
export const proposalPromptPath = (name: string) => `agents/${name}.md`;

// Proposal text reaches the owner's terminal in the apply plan, so it must not carry terminal controls: no
// C0/C1 control character (ESC, CSI, CR, ...) anywhere, and no newline either except in the prompt body.
// Unicode format/invisible characters (bidi overrides and isolates, zero-width characters, BOM, tag
// characters, line/paragraph separators) are refused everywhere too: they reorder or hide what the owner
// reads. Single-line strings are capped so padding cannot wrap text onto a line that looks like a plan line.
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// eslint-disable-next-line no-control-regex
const MULTI_LINE_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const FORMAT_MESSAGE = 'contains a Unicode format or invisible character (bidi control, zero-width, tag or separator)';
/** Longest single-line proposal string (description, reason, paths, ...); the prompt body is not capped. */
export const MAX_PROPOSAL_LINE = 240;

/** Why a single-line proposal string cannot be shown safely (null when fine). */
function singleLineProblem(s: string): string | null {
  if (SINGLE_LINE_CONTROL.test(s)) return 'contains a control character or line break';
  if (FORMAT_CHAR.test(s)) return FORMAT_MESSAGE;
  if (s.length > MAX_PROPOSAL_LINE) return `is longer than ${MAX_PROPOSAL_LINE} characters`;
  return null;
}

/** Strings in `v` (recursively, keys included) that cannot be shown safely, with the reason. */
function textProblems(v: unknown, path: string, out: { path: string; message: string }[] = []): { path: string; message: string }[] {
  if (typeof v === 'string') { const m = singleLineProblem(v); if (m) out.push({ path, message: m }); }
  else if (Array.isArray(v)) v.forEach((x, i) => textProblems(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const m = singleLineProblem(k);
      if (m) out.push({ path: `${path} (a key)`, message: m });
      textProblems(x, `${path}.${k}`, out);
    }
  }
  return out;
}

function promptTextProblem(s: string): string | null {
  if (MULTI_LINE_CONTROL.test(s)) return 'contains a control character (only newline and tab are allowed)';
  if (FORMAT_CHAR.test(s)) return FORMAT_MESSAGE;
  return null;
}

/** Parses a proposal object (shape and name only; `checkProposal` validates it against a config). */
export function parseProposal(raw: unknown, source = 'role proposal'): RoleProposal {
  const r = RoleProposalSchema.safeParse(raw);
  if (!r.success) throw invalidConfig(zodIssues(r.error.issues), source, 'A proposal is {name, role: {...}, promptText, reason, workflows?}; see README "Custom roles".');
  const p = r.data;
  const problem = roleNameProblem(p.name);
  if (problem) throw invalidConfig([{ path: 'name', message: problem }], source);
  if (isBuiltinWorkerRole(p.name)) {
    throw invalidConfig([{ path: 'name', message: `"${p.name}" is a built-in role; proposals add or change project roles only` }], source,
      'Customize a built-in (prompt append, model, effort, tools) by editing roles.<name> in the project config on the host (D9).');
  }
  const promptProblem = promptTextProblem(p.promptText);
  const bad = [
    ...textProblems(p.name, 'name'), ...textProblems(p.reason, 'reason'),
    ...textProblems(p.role, 'role'), ...textProblems(p.workflows, 'workflows'),
    ...(promptProblem ? [{ path: 'promptText', message: promptProblem }] : []),
  ];
  if (bad.length) {
    throw invalidConfig(bad, source,
      `Proposal text is shown to the owner on the terminal: use plain single-line text of at most ${MAX_PROPOSAL_LINE} characters (the prompt body may use newlines and tabs).`);
  }
  for (const k of ['prompt', 'promptText', 'promptAppend']) {
    if (Object.hasOwn(p.role, k)) throw invalidConfig([{ path: `role.${k}`, message: 'the prompt goes into the top-level promptText (apply writes it to the role\'s prompt file)' }], source);
  }
  return p;
}

/** The proposal merged into a config object: `roles.<name>` (with `prompt` or `promptText`) and the proposed workflows. */
export function mergeProposal<T extends Record<string, unknown>>(cfg: T, p: RoleProposal, prompt: { prompt: string } | { promptText: string }): T {
  const out: Record<string, unknown> = { ...cfg };
  out.roles = { ...((cfg.roles as Record<string, unknown> | undefined) ?? {}), [p.name]: { ...p.role, ...prompt } };
  if (p.workflows) out.workflows = { ...((cfg.workflows as Record<string, unknown> | undefined) ?? {}), ...p.workflows };
  return out as T;
}

export interface ProposalSummary {
  name: string;
  /** New role, or a change of an existing project role. */
  change: 'add' | 'change';
  description: string;
  contract: RoleDef['contract'];
  worktree: RoleDef['worktree'];
  stageStatus: RoleDef['stageStatus'];
  edits: RoleDef['edits'];
  commits: boolean;
  tools: string[];
  model: string | null;
  effort: string | null;
  /** Agent runtime the role would run on (docs/design/agent-runtimes.md D8); shown so the owner sees a non-Claude harness. */
  harness: RoleDef['harness'];
  maxTurns: number;
  deepVariant: boolean;
  requires: Capability[];
  /** The role's effective policy column: capabilities that are not `allow`. */
  policy: { deny: Capability[]; ask: Capability[] };
  /** Capabilities the role gets with a looser effect than the active profile's (e.g. pr.merge ask -> allow). */
  loosens: { capability: Capability; profile: Effect; proposed: Effect }[];
  workflows: { name: string; stages: string[]; change: 'add' | 'change' }[];
  promptBytes: number;
}

/**
 * Validates a proposal against `cfg` (the effective config the role would join) and returns the summary:
 * fields, tools, edit scope and the policy row the role implies. Throws INVALID_CONFIG naming the field.
 */
export async function checkProposal(cfg: MinionsConfig, raw: unknown, source?: string): Promise<{ proposal: RoleProposal; summary: ProposalSummary; config: MinionsConfig }> {
  const p = parseProposal(raw, source);
  const candidate = validateConfig(mergeProposal(structuredClone(cfg) as unknown as Record<string, unknown>, p, { promptText: p.promptText }), source ?? 'role proposal');
  const prompt = await resolveRolePrompt({ name: p.name, promptText: p.promptText });
  const def = workerRole(candidate, p.name)!;
  const policy: { deny: Capability[]; ask: Capability[] } = { deny: [], ask: [] };
  const loosens: ProposalSummary['loosens'] = [];
  for (const c of CAPABILITIES) {
    const e: Effect = can(candidate, c, { role: p.name });
    if (e !== 'allow') policy[e].push(c);
    const profile = can(cfg, c); // the active profile's (and project override's) base effect
    if (strictness(e) < strictness(profile)) loosens.push({ capability: c, profile, proposed: e });
  }
  const existingWf = cfg.workflows ?? {};
  const summary: ProposalSummary = {
    name: p.name,
    change: Object.hasOwn(cfg.roles ?? {}, p.name) ? 'change' : 'add',
    description: def.description, contract: def.contract, worktree: def.worktree, stageStatus: def.stageStatus,
    edits: def.edits, commits: def.commits, tools: roleTools(def), model: def.model ?? null, effort: def.effort ?? null, harness: def.harness,
    maxTurns: def.maxTurns, deepVariant: def.deepVariant, requires: def.requires, policy, loosens,
    workflows: Object.keys(p.workflows ?? {}).map((name) => ({
      name, stages: (candidate.workflows?.[name] ?? []).map((s) => normalizeStage(s).role),
      change: Object.hasOwn(existingWf, name) ? 'change' as const : 'add' as const,
    })),
    promptBytes: Buffer.byteLength(prompt ?? ''),
  };
  return { proposal: p, summary, config: candidate };
}

const editScope = (e: RoleDef['edits']) => (typeof e === 'string' ? e : e.paths.join(', '));

/** The prominent loosening line: capabilities the role gets looser than the active profile (null when none). */
export function formatLoosens(s: Pick<ProposalSummary, 'loosens'>): string | null {
  const l = s.loosens ?? [];
  return l.length ? `  LOOSENS: ${l.map((x) => `${x.capability} ${x.profile} -> ${x.proposed}`).join(', ')} (looser than the active profile)` : null;
}

/** Human summary of a proposal (fields, tools, edit scope, policy row, loosening, workflows); control characters stripped, format characters escaped. */
export function formatSummary(s: ProposalSummary): string {
  const loosens = formatLoosens(s);
  return displayText([
    `role ${s.name} (${s.change === 'add' ? 'new' : 'changed'}): ${s.description}`,
    ...(loosens ? [loosens] : []),
    `  contract ${s.contract}, worktree ${s.worktree}, stage status ${s.stageStatus}, max turns ${s.maxTurns}${s.model ? `, model ${s.model}` : ''}${s.effort ? `, effort ${s.effort}` : ''}${s.deepVariant ? ', deep variant' : ''}${s.harness !== 'claude' ? `, harness ${s.harness}` : ''}`,
    `  edits: ${editScope(s.edits)}; commits: ${s.commits ? 'yes' : 'no'}`,
    `  tools: ${s.tools.join(', ')}`,
    `  requires: ${s.requires.length ? s.requires.join(', ') : 'none'}`,
    `  policy: deny ${s.policy.deny.join(', ') || 'none'}; ask ${s.policy.ask.join(', ') || 'none'}; everything else allow`,
    ...s.workflows.map((w) => `  workflow ${w.name} (${w.change === 'add' ? 'new' : 'changed'}): ${w.stages.join(' -> ')}`),
    `  prompt: ${s.promptBytes} bytes`,
  ].join('\n'));
}

// ---------------------------------------------------------------- runtime operations

export interface ProposalView {
  id: string; name: string; state: RoleProposalRow['state']; createdAt: string; updatedAt: string;
  appliedRevision: number | null; reason: string;
}

export const proposalView = (row: RoleProposalRow): ProposalView => {
  let reason = '';
  try { reason = String((JSON.parse(row.json) as { reason?: unknown }).reason ?? ''); } catch { /* stored by propose: always JSON */ }
  return { id: row.id, name: row.name, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at, appliedRevision: row.applied_revision, reason };
};

export interface ProposeResult {
  proposalId: string; name: string; state: 'pending'; effective: false; superseded: string[];
  summary: ProposalSummary; applyCommand: string; note: string;
}

/** `config roles propose --file <f>` (runtime): validate against the runtime config and store; nothing becomes effective. */
export async function proposeRole(deps: { db: RuntimeDb; config: MinionsConfig }, file: string): Promise<ProposeResult> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch (e) {
    throw new MinionsError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'NOT_FOUND' : 'INVALID_CONFIG', `Cannot read the proposal ${file}: ${(e as Error).message}`, 'Write the proposal JSON to a file and pass --file <path>.');
  }
  const { proposal, summary } = await checkProposal(deps.config, raw, file);
  const id = newProposalId();
  const { superseded } = deps.db.addRoleProposal({ id, name: proposal.name, json: JSON.stringify(proposal) });
  const applyCommand = `minions config roles apply ${id}`;
  return {
    proposalId: id, name: proposal.name, state: 'pending', effective: false, superseded, summary, applyCommand,
    note: `Stored; nothing is effective until the owner runs \`${applyCommand}\` on the host (then a coordinator restart).`,
  };
}

export interface ShowProposal { kind: 'proposal'; proposal: RoleProposal; view: ProposalView; summary: ProposalSummary | null; problem: string | null }

/** One stored proposal, with its summary against `config` (problem: why it no longer validates). */
export async function showProposal(deps: { db: RuntimeDb; config: MinionsConfig }, id: string): Promise<ShowProposal> {
  const row = deps.db.roleProposal(id);
  if (!row) throw new MinionsError('NOT_FOUND', `No role proposal ${id}.`, 'List proposals with `minions config roles list`.');
  const proposal = JSON.parse(row.json) as RoleProposal;
  try {
    const { summary } = await checkProposal(deps.config, proposal);
    return { kind: 'proposal', proposal, view: proposalView(row), summary, problem: null };
  } catch (e) {
    return { kind: 'proposal', proposal, view: proposalView(row), summary: null, problem: (e as Error).message };
  }
}

/** JSON with sorted object keys, for comparing config values regardless of key order. */
const stableJson = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * Why the runtime config does not contain proposal `p` (null when it does): the configured role must equal the
 * proposed role field by field (as validated), its prompt must be the file apply writes (or the same inline
 * text), and every proposed workflow must be configured as proposed.
 */
export function proposalMismatch(cfg: MinionsConfig, p: RoleProposal): string | null {
  const have = (cfg.roles ?? {})[p.name] as Record<string, unknown> | undefined;
  if (!have) return `role ${p.name} is not in the runtime configuration`;
  let want: MinionsConfig;
  try {
    want = validateConfig(mergeProposal(structuredClone(cfg) as unknown as Record<string, unknown>, p, { promptText: p.promptText }), 'role proposal');
  } catch (e) { return `the proposal does not validate against the runtime configuration (${(e as Error).message})`; }
  const fields = (r: Record<string, unknown>) => { const { prompt: _p, promptText: _t, ...rest } = r; return stableJson(rest); };
  if (fields(have) !== fields((want.roles ?? {})[p.name] as Record<string, unknown>)) return `the configured role ${p.name} differs from the proposal`;
  const promptOk = have.prompt !== undefined ? have.prompt === proposalPromptPath(p.name) : have.promptText === p.promptText;
  if (!promptOk) return `the configured prompt of ${p.name} is not the proposal's (${proposalPromptPath(p.name)})`;
  for (const w of Object.keys(p.workflows ?? {})) {
    if (stableJson(cfg.workflows?.[w] ?? null) !== stableJson(want.workflows?.[w] ?? null)) return `workflow ${w} differs from the proposal`;
  }
  return null;
}

/**
 * Hidden `config roles mark-applied <id>` (runtime; called by the host's apply). Only marks a proposal whose
 * content (role fields, prompt file, workflows) is what the runtime config the host just regenerated has, so it
 * cannot record an apply that did not happen, nor mark a changed (e.g. widened) proposal for an older role.
 * The prompt file body itself is resolved on the host and is not checked here.
 */
export function markApplied(deps: { db: RuntimeDb; config: MinionsConfig }, id: string, revision: number | null): ProposalView {
  const row = deps.db.roleProposal(id);
  if (!row) throw new MinionsError('NOT_FOUND', `No role proposal ${id}.`);
  let mismatch: string | null;
  try { mismatch = proposalMismatch(deps.config, parseProposal(JSON.parse(row.json))); } catch (e) { mismatch = `the stored proposal is invalid (${(e as Error).message})`; }
  if (mismatch) {
    throw new MinionsError('PRECONDITION', `Proposal ${id} was not applied: ${mismatch}.`, 'Apply it on the host: `minions config roles apply <id>`.');
  }
  if (!deps.db.markRoleProposalApplied(id, revision)) throw new MinionsError('PRECONDITION', `Proposal ${id} is ${row.state}; not marked applied.`);
  return proposalView(deps.db.roleProposal(id)!);
}

// ---------------------------------------------------------------- roles view (list / show)

export interface RoleView {
  name: string; builtin: boolean; description: string; contract: RoleDef['contract']; worktree: RoleDef['worktree'];
  stageStatus: RoleDef['stageStatus']; edits: RoleDef['edits']; commits: boolean; model: string | null;
  /** The agent runtime the role runs on (own harness > harnesses.default where the phase allows > claude). */
  harness: RoleDef['harness'];
  /** Named workflows whose stages use the role. */
  workflows: string[];
}

/** Configured workflows that have a stage of `role`. */
export function workflowsUsing(cfg: Pick<MinionsConfig, 'workflows'>, role: string): string[] {
  return Object.entries(cfg.workflows ?? {}).filter(([, stages]) => stages.some((s) => normalizeStage(s).role === role)).map(([n]) => n);
}

export function roleView(cfg: MinionsConfig, def: RoleDef): RoleView {
  return {
    name: def.name, builtin: def.builtin, description: def.description, contract: def.contract, worktree: def.worktree,
    stageStatus: def.stageStatus, edits: def.edits, commits: def.commits, model: def.model ?? null, harness: def.harness, workflows: workflowsUsing(cfg, def.name),
  };
}

export interface ShowRole {
  kind: 'role'; role: RoleView; tools: string[] | null; requires: Capability[]; maxTurns: number; deepVariant: boolean;
  policy: { deny: Capability[]; ask: Capability[] } | null; prompt: string | null;
}

/** One configured role (read-only): fields, tools, policy column, the workflows using it. */
export function showRole(cfg: MinionsConfig, name: string): ShowRole {
  const def = workerRole(cfg, name);
  if (!def || def.name !== name) throw new MinionsError('NOT_FOUND', `No role ${name} (configured: ${Object.keys(cfg.roles ?? {}).join(', ') || 'none beyond the built-ins'}).`, 'List roles with `minions config roles list`.');
  const policy = def.builtin ? null : { deny: [] as Capability[], ask: [] as Capability[] };
  if (policy) for (const c of CAPABILITIES) { const e = can(cfg, c, { role: name }); if (e !== 'allow') policy[e].push(c); }
  return {
    kind: 'role', role: roleView(cfg, def), tools: def.builtin && !def.tools ? null : roleTools(def), requires: def.requires,
    maxTurns: def.maxTurns, deepVariant: def.deepVariant, policy, prompt: def.prompt ?? (def.promptText !== undefined ? '(inline promptText)' : null),
  };
}

export function formatRoleLine(r: RoleView): string {
  return displayText(`${r.name}${r.builtin ? ' (built-in)' : ''}  ${r.contract}  edits ${editScope(r.edits)}  harness ${r.harness}${r.workflows.length ? `  workflows ${r.workflows.join(', ')}` : ''}  - ${r.description}`);
}

export function formatProposalLine(p: ProposalView): string {
  return displayText(`${p.id}  ${p.name}  ${p.state}${p.appliedRevision !== null ? ` (revision ${p.appliedRevision})` : ''}  ${p.createdAt}  - ${p.reason}`);
}

export function formatShow(d: ShowRole | ShowProposal): string {
  if (d.kind === 'proposal') {
    return displayText([
      formatProposalLine(d.view),
      d.summary ? formatSummary(d.summary) : `no longer valid against the current config: ${d.problem}`,
      ...(d.view.state === 'pending' ? [`apply on the host: minions config roles apply ${d.view.id}`] : []),
    ].join('\n'));
  }
  return displayText([
    formatRoleLine(d.role),
    `  worktree ${d.role.worktree}, stage status ${d.role.stageStatus}, commits ${d.role.commits ? 'yes' : 'no'}, max turns ${d.maxTurns}${d.deepVariant ? ', deep variant' : ''}`,
    ...(d.tools ? [`  tools: ${d.tools.join(', ')}`] : []),
    ...(d.requires.length ? [`  requires: ${d.requires.join(', ')}`] : []),
    ...(d.policy ? [`  policy: deny ${d.policy.deny.join(', ') || 'none'}; ask ${d.policy.ask.join(', ') || 'none'}`] : []),
    ...(d.prompt ? [`  prompt: ${d.prompt}`] : []),
  ].join('\n'));
}
