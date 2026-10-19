export type ErrorCode =
  | 'AUTH_REQUIRED' | 'CONFLICT' | 'POLICY_DENIED' | 'INVALID_CONFIG'
  | 'INCOMPATIBLE_RUNTIME' | 'NETWORK_RETRYABLE' | 'NOT_FOUND'
  | 'DOCKER_UNAVAILABLE' | 'CAPACITY' | 'PRECONDITION' | 'INTERNAL';

export const EXIT_CODES: Record<ErrorCode, number> = {
  INVALID_CONFIG: 2, POLICY_DENIED: 3, CONFLICT: 4, AUTH_REQUIRED: 5,
  INCOMPATIBLE_RUNTIME: 6, NETWORK_RETRYABLE: 7, NOT_FOUND: 8,
  DOCKER_UNAVAILABLE: 9, CAPACITY: 10, PRECONDITION: 11, INTERNAL: 1,
};

export class MinionsError extends Error {
  constructor(public code: ErrorCode, message: string, public hint?: string, public details?: unknown) {
    super(message);
    this.name = 'MinionsError';
  }
}

export const isMinionsError = (e: unknown): e is MinionsError => e instanceof MinionsError;

export interface ConfigIssue { path: string; message: string }

/** Builds an INVALID_CONFIG error whose message lists every dotted path. */
export function invalidConfig(issues: ConfigIssue[], source?: string, hint?: string): MinionsError {
  const where = source ? ` in ${source}` : '';
  const lines = issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n');
  return new MinionsError('INVALID_CONFIG', `Invalid configuration${where}:\n${lines}`,
    hint ?? 'Fix the listed fields; unknown fields are rejected.', { issues });
}

/** Maps zod issues ({path, message}) to ConfigIssues with dotted paths. */
export function zodIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code?: string; keys?: string[] }>): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const i of issues) {
    const base = i.path.map(String).join('.');
    if (i.code === 'unrecognized_keys' && i.keys) {
      for (const k of i.keys) out.push({ path: base ? `${base}.${k}` : k, message: 'unknown field' });
    } else out.push({ path: base, message: i.message });
  }
  return out;
}
