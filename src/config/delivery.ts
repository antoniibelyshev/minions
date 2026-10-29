import type { TaskStatus } from '../backlog/types.js';
import type { CapabilityRule, MinionsConfig } from './schema.js';

/**
 * GitHub delivery (`branch` / `pull-request`; validation ties both to provider `github`). Under it
 * origin/<base> is the single source of truth: nothing merges into a local base, the workspace base only
 * fast-forwards from origin before each claim, and `minions upgrade` builds the CLI from origin/<base>.
 * Decision record: docs/design/bootstrap.md, "origin/<base> as the single source of truth".
 */
export const isGithubDelivery = (cfg: Pick<MinionsConfig, 'delivery'>): boolean => cfg.delivery.mode !== 'local';

const baseEffect = (r: CapabilityRule | undefined) => (r === undefined ? undefined : typeof r === 'string' ? r : r.effect);

/**
 * Why automatic merging (delivery.merge "auto-when-eligible") cannot be used with this configuration;
 * empty = the configuration allows it. Shared by the merge gates, `minions doctor` merge.readiness and
 * listUnavailable. Mode-aware (docs/design/local-auto-integration.md, Decision 1):
 * - pull-request delivery: CI-gated GitHub auto-merge (each merge still passes the per-PR gate in
 *   src/runtime/merge.ts: required checks passing for the approved head, PR head == approved head, pr.merge
 *   policy, sensitive paths).
 * - local delivery: the local integrator (src/runtime/integrator.ts) lands approved heads on the base after its
 *   own verification gate; it needs `base.merge` not denied and verification.commands to run. Each landing still
 *   passes the sensitive-path and `base.merge` "ask" approval gate.
 */
export function autoMergeConfigReasons(cfg: Pick<MinionsConfig, 'delivery'> & Partial<Pick<MinionsConfig, 'verification' | 'capabilities' | 'sensitivePaths'>>): string[] {
  const out: string[] = [];
  const d = cfg.delivery;
  if (d.merge !== 'auto-when-eligible') out.push(`delivery.merge is "${d.merge}" (auto-merge is opt-in: set "auto-when-eligible")`);
  if (d.mode === 'local') {
    if (cfg.capabilities && baseEffect(cfg.capabilities['base.merge']) === 'deny') out.push('base.merge is denied by policy (the user integrates approved branches)');
    if (cfg.verification && !cfg.verification.commands.length) out.push('verification.commands is empty: the local integration gate has nothing to verify');
    return out;
  }
  if (d.mode !== 'pull-request' || d.provider !== 'github') out.push(`auto-merge needs pull-request delivery to GitHub (delivery.mode is "${d.mode}")`);
  if (!d.requiredChecksConfigured) out.push('delivery.requiredChecksConfigured is false (never treated as zero required checks)');
  if (cfg.verification && cfg.verification.ciAuthority !== 'github') out.push('verification.ciAuthority is not "github": required checks are not read as merge evidence');
  if (cfg.capabilities) {
    const r = cfg.capabilities['pr.merge'];
    if (baseEffect(r) === 'deny') out.push('pr.merge is denied by policy');
  }
  return out;
}

/**
 * Local integration is on: local delivery with delivery.merge "auto-when-eligible", `base.merge` not denied and
 * verification commands configured. An approval then queues the head for the integrator (task -> `merging`)
 * instead of ending `delivered`.
 */
export const localIntegrationEnabled = (cfg: Pick<MinionsConfig, 'delivery' | 'verification' | 'capabilities'>): boolean =>
  cfg.delivery.mode === 'local' && autoMergeConfigReasons(cfg).length === 0;

const DONE_ONLY: ReadonlySet<TaskStatus> = new Set(['done']);
const DONE_OR_DELIVERED: ReadonlySet<TaskStatus> = new Set(['done', 'delivered']);

/**
 * Statuses that satisfy a dependency. With local integration on only `done` does (the dependency is on the
 * base, so dependents branch from a base that contains it); otherwise `done` or `delivered`, as before.
 */
export const dependencyDoneStatuses = (cfg: Pick<MinionsConfig, 'delivery' | 'verification' | 'capabilities'>): ReadonlySet<TaskStatus> =>
  localIntegrationEnabled(cfg) ? DONE_ONLY : DONE_OR_DELIVERED;
