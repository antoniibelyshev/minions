import type { MinionsConfig } from './schema.js';

/**
 * GitHub delivery (`branch` / `pull-request`; validation ties both to provider `github`). Under it
 * origin/<base> is the single source of truth: nothing merges into a local base, the workspace base only
 * fast-forwards from origin before each claim, and `minions upgrade` builds the CLI from origin/<base>.
 * Decision record: docs/design/bootstrap.md, "origin/<base> as the single source of truth".
 */
export const isGithubDelivery = (cfg: Pick<MinionsConfig, 'delivery'>): boolean => cfg.delivery.mode !== 'local';

/**
 * Why CI-gated auto-merge (delivery.merge "auto-when-eligible") cannot be used with this configuration;
 * empty = the configuration allows it (each merge still passes the per-PR gate in src/runtime/merge.ts:
 * required checks passing for the approved head, PR head == approved head, pr.merge policy, sensitive
 * paths). Shared by the merge gate, `minions doctor` merge.readiness and listUnavailable.
 */
export function autoMergeConfigReasons(cfg: Pick<MinionsConfig, 'delivery'> & Partial<Pick<MinionsConfig, 'verification' | 'capabilities' | 'sensitivePaths'>>): string[] {
  const out: string[] = [];
  const d = cfg.delivery;
  if (d.merge !== 'auto-when-eligible') out.push(`delivery.merge is "${d.merge}" (auto-merge is opt-in: set "auto-when-eligible")`);
  if (d.mode !== 'pull-request' || d.provider !== 'github') out.push(`auto-merge needs pull-request delivery to GitHub (delivery.mode is "${d.mode}")`);
  if (!d.requiredChecksConfigured) out.push('delivery.requiredChecksConfigured is false (never treated as zero required checks)');
  if (cfg.verification && cfg.verification.ciAuthority !== 'github') out.push('verification.ciAuthority is not "github": required checks are not read as merge evidence');
  if (cfg.capabilities) {
    const r = cfg.capabilities['pr.merge'];
    if ((typeof r === 'string' ? r : r.effect) === 'deny') out.push('pr.merge is denied by policy');
  }
  return out;
}
