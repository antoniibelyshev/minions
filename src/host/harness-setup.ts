// `minions setup`, "Agents" step (docs/design/agent-runtimes.md D8, D9; task-14.7): one question, "Which agent
// should do the work?", that authorizes one harness for the whole squad (`harnesses.default`), limited to the roles
// the current phase allows on a process harness. Every other role stays on Claude Code, and setup says so.
//
// Architecture decisions (task-14.7):
// - Phase 1 option (b) (CURRENT_PHASE 1b) allows a process harness only for project gate roles, so authorizing Codex
//   also wires the pilot D9 describes: a project role `codex-reviewer` (contract gate, harness codex, read-only, inline
//   prompt) added as an extra stage after the Claude reviewer in one workflow the owner picks (default: `default`).
//   An existing `codex-reviewer` role is kept as configured; a non-gate role of that name is refused.
// - Choosing `default` while the project has no `workflows.default` writes the derived default stages explicitly plus
//   the pilot stage. From then on `verification.testerRequired` / `reviewerRequired` no longer reshape that workflow;
//   the step says so.
// - Everything goes to the host-only config.local.json, like the other setup choices. The whole planned layer is
//   validated with the full config rules before anything is recorded; a refusal records nothing (a key stored in the
//   same run stays stored and is reported).
// - Junie has no adapter yet (U-J1), so the Junie answer keeps Claude Code. The host runtime refuses process harnesses
//   (D9), so the question is not asked there.
// - The Codex CLI is not installed in the default runtime image yet (owner approval pending); the step says the
//   harness must be installed and that `minions doctor` reports it (harness.codex).
import { CURRENT_PHASE, HARNESSES, isProcessHarness, type HarnessId } from '../config/harnesses.js';
import { defaultMovedGates, REVIEWER_ROLE, workerRole, workerRoleNames } from '../config/roles.js';
import type { CustomRoleConfig, MinionsConfig, WorkflowStageConfig } from '../config/schema.js';
import { DEFAULT_WORKFLOW, resolveWorkflow, workflowNames, type Stage } from '../config/workflows.js';
import { MinionsError } from '../core/errors.js';
import { readJsonIfExists } from '../core/fsutil.js';
import { codexKeyGuidance } from './credentials.js';
import { projectConfigPath, resolveEffective, type ProjectJson } from './project.js';
import { setPath } from './settings.js';
import type { WizardIO } from './wizard.js';

/** Name of the phase 1 (b) pilot role (D9). */
export const PILOT_ROLE = 'codex-reviewer';
/**
 * Model setup offers for Codex when no `harnesses.codex` block exists yet (the id of the design's config example).
 * The owner types the model their OpenAI project can use; it is validated as a model id, not against OpenAI.
 */
export const SETUP_CODEX_MODEL = 'gpt-6.1-sol';

/** The answers of the question; `later` = "Other / later". */
export const AGENT_CHOICES = ['claude', 'codex', 'junie', 'later'] as const;
export type AgentChoice = (typeof AGENT_CHOICES)[number];

/** The pilot role (D9 option b): a read-only gate on Codex, a second opinion after the Claude reviewer. */
export function pilotRole(): CustomRoleConfig {
  return {
    description: 'Second, independent review on OpenAI Codex (phase 1 pilot): a read-only gate after the Claude reviewer',
    contract: 'gate',
    harness: 'codex',
    promptText: [
      'You are a second, independent reviewer running on OpenAI Codex (the minions codex-reviewer pilot). The Claude reviewer has already approved this head; you give a cross-model second opinion.',
      '',
      'Review the change on the branch against the brief: read the diff from the base commit to HEAD, check that it does what the task and each acceptance criterion ask, that tests prove the criteria, and that it introduces no bug, security problem or out-of-scope change.',
      '',
      'You cannot edit files or commit. Approve when the change is correct and complete. Request changes only for concrete problems, one finding each, naming the file and line and what is wrong. Do not request changes for style preferences or for work the brief lists as a non-goal.',
    ].join('\n'),
  };
}

/** A resolved stage back in config form (a plain role name when it has nothing else). */
const stageConfig = (s: Stage): WorkflowStageConfig =>
  s.when || s.model ? { role: s.role, ...(s.when ? { when: s.when } : {}), ...(s.model ? { model: s.model } : {}) } : s.role;

/**
 * The stages of `workflow` with the pilot stage after its last reviewer stage (at the end when it has none), or null
 * when the workflow already runs the pilot role or does not exist.
 */
export function withPilotStage(cfg: MinionsConfig, workflow: string): WorkflowStageConfig[] | null {
  const wf = resolveWorkflow(cfg, workflow);
  if (!wf || wf.stages.some((s) => s.role === PILOT_ROLE)) return null;
  const stages = wf.stages.map(stageConfig);
  const lastReviewer = wf.stages.map((s) => s.role).lastIndexOf(REVIEWER_ROLE);
  const at = lastReviewer >= 0 ? lastReviewer + 1 : stages.length;
  return [...stages.slice(0, at), PILOT_ROLE, ...stages.slice(at)];
}

/** Worker roles that resolve to a process harness, as `name (harness)`. */
export function processRoleNames(cfg: MinionsConfig): string[] {
  return workerRoleNames(cfg).flatMap((n) => { const d = workerRole(cfg, n); return d && isProcessHarness(d.harness) ? [`${n} (${d.harness})`] : []; });
}

/** Plain-language scope of the current phase for the setup text (D8: "Setup says so plainly"). */
export function phaseScopeLines(label: string): string[] {
  if (CURRENT_PHASE.id === '1b') {
    return [
      `In this version ${label} works only as a read-only extra reviewer: the ${PILOT_ROLE} stage runs after the Claude reviewer, and both must approve.`,
      'Engineering, testing, review and coordination stay on Claude Code until a later version, so Claude credentials are still needed.',
    ];
  }
  return [`In this version ${label} runs ${CURRENT_PHASE.summary.replace(/^phase \S+(, option \(\w\))?: /, '')}; the other roles stay on Claude Code.`];
}

export interface HarnessStepInput {
  /** Null: non-interactive (--yes, --config): report the current harnesses, ask nothing. */
  io: WizardIO | null;
  config: MinionsConfig;
  project: ProjectJson;
  /** The local layer as planned so far by this setup run (validated together with the harness choices). */
  local: Record<string, unknown>;
  setLocal: (dotted: string, value: unknown) => void;
  hostRuntime: boolean;
  /** An OpenAI API key for Codex is stored already. */
  codexKeyStored: boolean;
  /** Stores the key (provisionCodexKey); returns where. */
  storeCodexKey: (token: string) => Promise<string>;
  inRepo: (c: string) => string;
  setupCmd: string;
}

export interface HarnessStepResult {
  status: 'done' | 'kept' | 'changed' | 'skipped' | 'failed';
  detail: string;
  later?: string;
  lines?: string[];
}

async function choose<T extends string>(io: WizardIO, q: string, def: T, opts: readonly T[]): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const a = (await io.ask(`${q} (${opts.join('/')})`, def)).trim().toLowerCase();
    const hit = opts.find((o) => o === a);
    if (hit) return hit;
    io.info(`  choose one of: ${opts.join(', ')}`);
  }
  return def;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]*$/;
const errMsg = (e: unknown) => (e instanceof MinionsError ? e.message : 'unexpected error');

/** The Agents step of `minions setup` (see the header). Records choices only through `setLocal`. */
export async function harnessStep(x: HarnessStepInput): Promise<HarnessStepResult> {
  const { io, config } = x;
  const current: HarnessId = config.harnesses?.default ?? 'claude';
  const onProcess = processRoleNames(config);
  const later = `Run ${x.setupCmd} again to let OpenAI Codex review alongside Claude, or change it with ${x.inRepo('minions settings')} (Agents).`;
  const keepDetail = onProcess.length ? `harnesses.default ${current}; on a process harness: ${onProcess.join(', ')}` : 'every worker runs on Claude Code';
  if (x.hostRuntime) {
    return onProcess.length
      ? { status: 'kept', detail: `${keepDetail}; the host runtime refuses process harnesses (\`work run\` needs the Docker runtime)`, later }
      : { status: 'skipped', detail: 'the host runtime runs every worker on Claude Code (process harnesses need the Docker runtime)' };
  }
  if (!io) return onProcess.length || current !== 'claude' ? { status: 'kept', detail: keepDetail } : { status: 'skipped', detail: keepDetail, later };

  io.info('  Claude Code does the work by default. You can also authorize OpenAI Codex CLI for the whole squad, as far as this version allows:');
  for (const l of phaseScopeLines(HARNESSES.codex.label)) io.info(`  ${l}`);
  io.info(`  JetBrains Junie is not supported yet. Per-role choices are in ${x.inRepo('minions settings')} (Agents).`);
  const choice = await choose(io, 'Which agent should do the work?', current === 'junie' ? 'later' : current as AgentChoice, AGENT_CHOICES);

  if (choice === 'later') return onProcess.length ? { status: 'kept', detail: keepDetail } : { status: 'skipped', detail: 'not chosen now; workers stay on Claude Code', later };
  if (choice === 'junie') {
    return { status: 'skipped', detail: 'JetBrains Junie is not supported yet (its adapter is pending); workers stay on Claude Code', later };
  }
  if (choice === 'claude') {
    if (current === 'claude') return { status: onProcess.length ? 'kept' : 'skipped', detail: keepDetail, ...(onProcess.length ? {} : { later }) };
    x.setLocal('harnesses.default', 'claude');
    const own = processRoleNames({ ...config, harnesses: { ...config.harnesses, default: 'claude' } });
    return {
      status: 'changed', detail: `harnesses.default ${current} -> claude`,
      ...(own.length ? { lines: [`still on a process harness by their own roles.<r>.harness: ${own.join(', ')} (${x.inRepo(`minions settings set roles.${PILOT_ROLE}.harness claude`)} moves the pilot back)`] } : {}),
    };
  }
  return codexChoice(x, current);
}

async function codexChoice(x: HarnessStepInput, current: HarnessId): Promise<HarnessStepResult> {
  const io = x.io!;
  const { config } = x;
  const lines: string[] = [];

  // 1. The key (never echoed; only the runner reads it, as CODEX_API_KEY).
  let keyNote = 'OpenAI API key already stored';
  const replace = x.codexKeyStored && await choose(io, 'An OpenAI API key for Codex is stored. Keep it or change it?', 'keep', ['keep', 'change'] as const) === 'change';
  if (!x.codexKeyStored || replace) {
    for (const l of codexKeyGuidance()) io.info(`  ${l}`);
    if (!io.secret) return { status: 'failed', detail: 'no terminal for a non-echoing prompt; nothing was changed', later: `Store the key with ${x.inRepo('minions auth codex --stdin < key-file')}, then run ${x.setupCmd} again.` };
    try {
      keyNote = `OpenAI API key stored in ${await x.storeCodexKey(await io.secret('OpenAI API key (input hidden): '))}`;
    } catch (e) {
      return { status: 'failed', detail: `${errMsg(e)}; nothing was stored, workers stay on ${HARNESSES[current].label}`, later: `Run ${x.setupCmd} again or ${x.inRepo('minions auth codex')}.` };
    }
  }

  // 2. The model (harness-native id; the owner's OpenAI project decides what is available).
  const block = config.harnesses?.codex;
  let model = block?.models.default ?? SETUP_CODEX_MODEL;
  for (let i = 0; i < 3; i++) {
    const a = (await io.ask('Codex model (an OpenAI model id your API key can use)', model)).trim();
    if (MODEL_ID.test(a)) { model = a; break; }
    io.info('  enter a model id (letters, digits, . _ : @ [ ] -)');
  }

  // 3. The pilot stage (phase 1 option b: only project gate roles may run on Codex).
  const planned: [string, unknown][] = [
    ['harnesses.default', 'codex'],
    ['harnesses.codex', { ...block, models: { default: model, allowed: [...new Set([model, ...(block?.models.allowed ?? [])])] } }],
  ];
  let workflow: string | null = null;
  if (CURRENT_PHASE.id === '1b') {
    const existing = workerRole(config, PILOT_ROLE);
    if (existing && existing.contract !== 'gate') {
      return { status: 'failed', detail: `a ${existing.contract} role named ${PILOT_ROLE} exists; the pilot needs a gate role of that name. Nothing was changed (${keyNote}).` };
    }
    if (!existing) planned.push([`roles.${PILOT_ROLE}`, pilotRole()]);
    const names = workflowNames(config);
    workflow = await choose(io, `Which workflow gets the ${PILOT_ROLE} stage (after the Claude reviewer)?`, DEFAULT_WORKFLOW, names);
    const withRole = existing ? config : { ...config, roles: { ...config.roles, [PILOT_ROLE]: pilotRole() } } as unknown as MinionsConfig;
    const stages = withPilotStage(withRole, workflow);
    if (stages) {
      const localWf = (x.local.workflows && typeof x.local.workflows === 'object' ? x.local.workflows : {}) as Record<string, unknown>;
      planned.push(['workflows', { ...localWf, [workflow]: stages }]);
      if (workflow === DEFAULT_WORKFLOW && !Object.hasOwn(config.workflows ?? {}, DEFAULT_WORKFLOW)) {
        lines.push('workflows.default is now written out (the derived stages plus the pilot): verification.testerRequired / reviewerRequired no longer reshape it.');
      }
    }
  }

  // 4. Validate the whole planned layer before recording anything.
  const candidate = structuredClone(x.local);
  for (const [k, v] of planned) setPath(candidate, k, v);
  let effective: MinionsConfig;
  try {
    const projectRaw = (await readJsonIfExists<Record<string, unknown>>(projectConfigPath(x.project))) ?? {};
    effective = resolveEffective(x.project, projectRaw, candidate).config;
  } catch (e) {
    return { status: 'failed', detail: `the Codex settings do not validate: ${errMsg(e)}; nothing was recorded (${keyNote})`, later: `Fix the named setting, then run ${x.setupCmd} again.` };
  }
  const same = JSON.stringify([config.harnesses, config.roles?.[PILOT_ROLE], config.workflows]) === JSON.stringify([effective.harnesses, effective.roles?.[PILOT_ROLE], effective.workflows]);
  if (!same) for (const [k, v] of planned) x.setLocal(k, v);

  const moved = defaultMovedGates(effective).map((g) => g.role).filter((r) => r !== PILOT_ROLE);
  if (moved.length) lines.push(`warning: harnesses.default also moves these gate roles onto Codex: ${moved.join(', ')} (set roles.<r>.harness to claude to keep one on Claude Code)`);
  lines.push(
    ...phaseScopeLines(HARNESSES.codex.label),
    'The Codex CLI must be installed in the runtime image (the default image does not include it yet); `minions doctor` reports harness.codex.',
  );
  const scope = workflow ? `; ${PILOT_ROLE} runs after the reviewer in workflow ${workflow}` : '';
  return { status: same ? 'kept' : current === 'codex' ? 'changed' : 'done', detail: `harnesses.default codex (model ${model})${scope}; ${keyNote}`, lines };
}
