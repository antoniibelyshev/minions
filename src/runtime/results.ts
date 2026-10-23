import { z } from 'zod';
import type { LeaseRole } from './db.js';

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

/**
 * Validates a worker result (object or JSON text). With a role, also checks role rules:
 * only reviewers give a verdict; reviewer `complete` means `approve`, `needs_changes` means `request-changes`;
 * a tester/reviewer `complete` may not report failing checks; CI-sourced checks need ciAuthority "github"
 * and a tester/reviewer role (whether CI really passed for the head is decided by the runtime gate).
 */
export interface ValidateOptions {
  /** verification.ciAuthority; with "none" (or unset) CI-sourced checks are rejected. */
  ciAuthority?: 'none' | 'github';
}

export const isCiCheck = (c: { source?: 'local' | 'ci' }): boolean => c.source === 'ci';

export function validateResult(raw: unknown, role?: LeaseRole, opts: ValidateOptions = {}): ValidationOutcome {
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
  if (role && role !== 'reviewer' && res.verdict !== undefined) errors.push(`verdict: only reviewer results carry a verdict (role ${role})`);
  if (role && role !== 'reviewer' && res.needsQa !== undefined) errors.push(`needsQa: only reviewer results can request a QA stage (role ${role})`);
  const ci = res.checks.filter(isCiCheck);
  if (ci.length) {
    if (opts.ciAuthority !== 'github') errors.push('checks: CI evidence entries (source "ci") need verification.ciAuthority "github"; report the checks you ran locally');
    if (role && role !== 'tester' && role !== 'reviewer') errors.push(`checks: only tester and reviewer results may cite CI evidence (role ${role}); engineers report the checks they ran`);
    const skipped = ci.filter((c) => c.outcome === 'skipped').map((c) => c.command);
    if (skipped.length) errors.push(`checks: a CI evidence entry must be pass or fail, not skipped (${skipped.join(', ')})`);
  }
  if ((role === 'tester' || role === 'reviewer') && res.status === 'complete') {
    const failed = res.checks.filter((c) => c.outcome === 'fail').map((c) => c.command);
    if (failed.length) errors.push(`checks: a complete ${role} result cannot report failing checks (${failed.join(', ')}); use needs_changes or blocked`);
  }
  if (role === 'reviewer') {
    if (res.status === 'complete' && res.verdict !== 'approve') errors.push('verdict: a complete reviewer result must have verdict "approve"');
    if (res.status === 'needs_changes' && res.verdict === 'approve') errors.push('verdict: needs_changes cannot carry verdict "approve"');
    if (res.status !== 'complete' && res.verdict === 'approve') errors.push('verdict: "approve" requires status "complete"');
  }
  return errors.length ? { ok: false, errors } : { ok: true, result: res };
}
