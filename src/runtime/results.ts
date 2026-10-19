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

export const WorkerResultSchema = z.object({
  status: z.enum(RESULT_STATUSES),
  summary: text,
  branch: text,
  headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'must be a full lowercase hex commit SHA'),
  modifiedPaths: z.array(text),
  checks: z.array(z.object({
    command: text,
    outcome: z.enum(['pass', 'fail', 'skipped']),
    details: z.string().optional(),
  }).strict()),
  acceptanceEvidence: z.array(z.object({ criterion: text, evidence: text }).strict()),
  findings: z.array(FindingSchema),
  nextAction: text,
  verdict: z.enum(['approve', 'request-changes']).optional(),
  usage: z.object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
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
 * only reviewers give a verdict; reviewer `complete` means `approve`, `needs_changes` means `request-changes`.
 */
export function validateResult(raw: unknown, role?: LeaseRole): ValidationOutcome {
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
  if (role === 'reviewer') {
    if (res.status === 'complete' && res.verdict !== 'approve') errors.push('verdict: a complete reviewer result must have verdict "approve"');
    if (res.status === 'needs_changes' && res.verdict === 'approve') errors.push('verdict: needs_changes cannot carry verdict "approve"');
    if (res.status !== 'complete' && res.verdict === 'approve') errors.push('verdict: "approve" requires status "complete"');
  }
  return errors.length ? { ok: false, errors } : { ok: true, result: res };
}
