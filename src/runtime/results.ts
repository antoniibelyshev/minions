import { z } from 'zod';
import { ROLE_CONTRACTS, type RoleContract } from '../config/schema.js';
import type { BuiltinLeaseRole } from './db.js';

export const RESULT_STATUSES = ['complete', 'needs_changes', 'blocked', 'needs_split', 'partial'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

const text = z.string().trim().min(1);

export const FindingSchema = z.union([
  text,
  z.object({
    text,
    severity: z.enum(['blocker', 'major', 'minor', 'nit', 'info']).optional(),
    path: z.string().optional(),
    line: z.number().int().min(1).optional(),
  }).strict(),
]);

/**
 * One check. `source` "local" (default) = a command the worker ran; "ci" = a required CI check the worker
 * relied on (verification.ciAuthority "github", tester/reviewer only): `command` names the check (e.g.
 * "test"); the runtime accepts it only when `minions sync` recorded that required check passing for the
 * exact head of the result (src/runtime/ci-gate.ts). A worker's claim about CI is never evidence by itself.
 */
export const CheckSchema = z.object({
  command: text,
  outcome: z.enum(['pass', 'fail', 'skipped']),
  details: z.string().optional(),
  source: z.enum(['local', 'ci']).optional(),
}).strict();

export const WorkerResultSchema = z.object({
  status: z.enum(RESULT_STATUSES),
  summary: text,
  branch: text,
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'must be a full lowercase hex commit SHA'),
  modifiedPaths: z.array(text),
  checks: z.array(CheckSchema),
  acceptanceEvidence: z.array(z.object({ criterion: text, evidence: text }).strict()),
  findings: z.array(FindingSchema),
  nextAction: text,
  verdict: z.enum(['approve', 'request-changes']).optional(),
  /** Reviewer only: the change needs a tester (QA) stage before delivery; recorded on the task as a QA label. */
  needsQa: z.boolean().optional(),
  usage: z.object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
    /** Total tokens for the attempt (e.g. the task-notification total); the coordinator's --usage wins over it. */
    totalTokens: z.number().int().min(0).optional(),
    costUsd: z.number().min(0).optional(),
    turns: z.number().int().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
    model: z.string().optional(),
  }).strict().optional(),
}).strict();

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

export type ValidationOutcome = { ok: true; result: WorkerResult } | { ok: false; errors: string[] };

/** Extracts JSON from a string, tolerating a single ```json fenced block around it. */
function parseText(raw: string): { value?: unknown; error?: string } {
  const attempts = [raw.trim()];
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(raw);
  if (fence) attempts.push(fence[1]!.trim());
  let error = 'empty result';
  for (const a of attempts) {
    if (!a) continue;
    try { return { value: JSON.parse(a) }; } catch (e) { error = `not valid JSON (${(e as Error).message})`; }
  }
  return { error };
}

/** Options of validateResult. */
export interface ValidateOptions {
  /** verification.ciAuthority; with "none" (or unset) CI-sourced checks are rejected. */
  ciAuthority?: 'none' | 'github';
  /**
   * verification.commands, passed for the built-in engineer (task-137.3; custom producer roles keep their own
   * rules). Then a complete producer result may not report a failing check, and with commands configured it
   * must carry passing local evidence: no configured non-test command (the typecheck) reported skipped, at least one passing check, and
   * a passing test run when a configured command runs tests. The test run may be the unit tier or targeted
   * files: the full suite and the integration tier run in the merge gate.
   */
  verificationCommands?: string[];
}

/** A command that runs tests (the full suite, one tier, or targeted files): `npm test`, `npm run test:unit`, `pytest`. */
export const isTestRun = (command: string): boolean => /test/i.test(command);

/** Why a complete producer result lacks the verification evidence it needs (empty = enough). */
function producerEvidenceErrors(checks: WorkerResult['checks'], configured: string[]): string[] {
  const local = checks.filter((c) => !isCiCheck(c));
  const errors: string[] = [];
  const failed = local.filter((c) => c.outcome === 'fail').map((c) => c.command);
  if (failed.length) errors.push(`checks: a complete engineer (producer) result cannot report failing checks (${failed.join(', ')}); fix them, or use partial or blocked`);
  if (!configured.length) return errors;
  // Configured test runs (the full suite, the integration tier) may be skipped: the engineer runs the unit tier
  // instead, and the merge gate runs the rest. Other configured commands (the typecheck) may not.
  const skipped = configured.filter((cmd) => !isTestRun(cmd) && local.some((c) => c.outcome === 'skipped' && normalizeCheckCommand(c.command) === normalizeCheckCommand(cmd)));
  if (skipped.length) errors.push(`checks: a complete engineer (producer) result cannot skip configured verification (${skipped.join(', ')}); run it along with the unit tier (e.g. \`npm run test:unit\`), or use partial or blocked`);
  const passed = local.filter((c) => c.outcome === 'pass');
  if (!passed.length) errors.push(`checks: a complete engineer (producer) result needs passing verification evidence (the typecheck and the unit tests you ran; configured: ${configured.join(', ')}); use partial or blocked if you could not run it`);
  else if (configured.some(isTestRun) && !passed.some((c) => isTestRun(c.command))) errors.push('checks: a complete engineer (producer) result needs a passing test run (the unit tier, e.g. `npm run test:unit`); use partial or blocked if you could not run it');
  return errors;
}

/**
 * Command text reduced to what ran: the last `&&`/`;` segment with leading `VAR=value` assignments removed,
 * so `mkdir -p x && TMPDIR=x npm test` matches the configured `npm test`. Still an exact match otherwise.
 */
export function normalizeCheckCommand(command: string): string {
  const last = command.split(/&&|;/).map((p) => p.trim()).filter(Boolean).pop() ?? '';
  return last.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim();
}

export const isCiCheck = (c: { source?: 'local' | 'ci' }): boolean => c.source === 'ci';

/** Contract variant of a built-in worker (engineer = producer, tester = verifier, reviewer = gate). */
const BUILTIN_CONTRACT: Record<BuiltinLeaseRole, RoleContract> = { engineer: 'producer', tester: 'verifier', reviewer: 'gate' };
/** How the rule texts name a variant (the built-in role that has it, so existing wording stays readable). */
const VARIANT_LABEL: Record<RoleContract, string> = { producer: 'producer (engineer)', verifier: 'verifier (tester)', gate: 'gate (reviewer)' };

/** A contract variant, or the built-in worker role whose variant it is (back-compat: `validateResult(raw, 'reviewer')`). */
export type ContractRef = RoleContract | BuiltinLeaseRole;
export const contractOfRef = (ref: ContractRef): RoleContract =>
  (ROLE_CONTRACTS as readonly string[]).includes(ref) ? ref as RoleContract : BUILTIN_CONTRACT[ref as BuiltinLeaseRole];

/**
 * Validates a worker result (object or JSON text). With a contract variant (D4; a built-in role name maps to
 * its variant), also checks the variant's rules: only a gate gives a verdict or sets needsQa; a gate
 * `complete` means `approve`, `needs_changes` means `request-changes`; a verifier/gate `complete` may not
 * report failing checks; an engineer `complete` needs passing local evidence (ValidateOptions.verificationCommands);
 * CI-sourced checks need ciAuthority "github" and a verifier/gate (whether CI really passed for the head is
 * decided by the runtime gate). `blocked`, `needs_split` and `partial` mean the same
 * for every variant.
 */
export function validateResult(raw: unknown, contractRef?: ContractRef, opts: ValidateOptions = {}): ValidationOutcome {
  let value = raw;
  if (typeof raw === 'string') {
    const p = parseText(raw);
    if (p.error) return { ok: false, errors: [`(root): ${p.error}`] };
    value = p.value;
  }
  const r = WorkerResultSchema.safeParse(value);
  if (!r.success) {
    return { ok: false, errors: r.error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`) };
  }
  const res = r.data;
  const errors: string[] = [];
  const contract = contractRef === undefined ? undefined : contractOfRef(contractRef);
  const as = contract ? `contract ${VARIANT_LABEL[contract]}` : '';
  if (contract && contract !== 'gate' && res.verdict !== undefined) errors.push(`verdict: only reviewer (gate) results carry a verdict (${as})`);
  if (contract && contract !== 'gate' && res.needsQa !== undefined) errors.push(`needsQa: only reviewer (gate) results can request a QA stage (${as})`);
  const ci = res.checks.filter(isCiCheck);
  if (ci.length) {
    if (opts.ciAuthority !== 'github') errors.push('checks: CI evidence entries (source "ci") need verification.ciAuthority "github"; report the checks you ran locally');
    if (contract === 'producer') errors.push(`checks: only tester and reviewer (verifier and gate) results may cite CI evidence (${as}); producers report the checks they ran`);
    const skipped = ci.filter((c) => c.outcome === 'skipped').map((c) => c.command);
    if (skipped.length) errors.push(`checks: a CI evidence entry must be pass or fail, not skipped (${skipped.join(', ')})`);
  }
  if (contract === 'producer' && res.status === 'complete' && opts.verificationCommands) errors.push(...producerEvidenceErrors(res.checks, opts.verificationCommands));
  if ((contract === 'verifier' || contract === 'gate') && res.status === 'complete') {
    const failed = res.checks.filter((c) => c.outcome === 'fail').map((c) => c.command);
    if (failed.length) errors.push(`checks: a complete ${VARIANT_LABEL[contract]} result cannot report failing checks (${failed.join(', ')}); use needs_changes or blocked`);
  }
  if (contract === 'gate') {
    if (res.status === 'complete' && res.verdict !== 'approve') errors.push('verdict: a complete reviewer (gate) result must have verdict "approve"');
    if (res.status === 'needs_changes' && res.verdict === 'approve') errors.push('verdict: needs_changes cannot carry verdict "approve"');
    if (res.status !== 'complete' && res.verdict === 'approve') errors.push('verdict: "approve" requires status "complete"');
  }
  return errors.length ? { ok: false, errors } : { ok: true, result: res };
}

/**
 * The result-contract text of a brief (D4), rendered per variant: a producer is never told about `verdict`,
 * `needsQa` or CI evidence; a gate is told its verdict rule and that the head must not move.
 */
export function resultContractText(contract: RoleContract, opts: { commits?: boolean } = {}): string {
  const commits = opts.commits ?? contract !== 'gate';
  const head = contract === 'gate' || !commits ? 'headSha (full SHA of the exact head you were given; you do not commit)' : 'headSha (full SHA of the branch head you leave)';
  const source = contract === 'producer' ? '' : ', source?: local|ci (ci: a required CI check for this head; with ciAuthority github only)';
  const gate = contract === 'gate' ? ', verdict: approve|request-changes (complete requires approve; needs_changes = request-changes), needsQa? (true: a tester must run before delivery)' : '';
  const rule = contract === 'producer'
    ? ' No verdict, needsQa or CI-sourced checks. complete = your stage is done; needs_changes = the task must be replanned.'
    : contract === 'verifier'
      ? ' No verdict or needsQa. complete = verified at the head you report (no failing checks); needs_changes = defects for the repair stage. Commits go on top of the head you were given (never rewrite it).'
      : ' complete = approved at the head (no failing checks); needs_changes = request changes. The head must not move.';
  return `Return exactly one JSON object: {status: complete|needs_changes|blocked|needs_split|partial, summary, branch, ${head}, modifiedPaths[], checks[{command, outcome: pass|fail|skipped, details?${source}}], acceptanceEvidence[{criterion, evidence}], findings[], nextAction${gate}, usage? (only when actually available)}.${rule}`;
}
