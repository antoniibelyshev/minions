import type { TaskStatus } from '../backlog/types.js';
import type { CapabilityRule, MinionsConfig } from './schema.js';

const baseEffect = (r: CapabilityRule | undefined) => (r === undefined ? undefined : typeof r === 'string' ? r : r.effect);

/**
 * Why local integration (delivery.merge "auto-when-eligible") cannot be used with this configuration; empty = the
 * configuration allows it. Shared by the integration gates, `minions doctor` merge.readiness and listUnavailable
 * (docs/design/local-auto-integration.md, Decision 1): the local integrator (src/runtime/integrator.ts) lands approved
 * heads on the base after its own verification gate; it needs `base.merge` not denied and verification.commands to
 * run. Each landing still passes the sensitive-path and `base.merge` "ask" approval gate.
 */
export function autoMergeConfigReasons(cfg: Pick<MinionsConfig, 'delivery'> & Partial<Pick<MinionsConfig, 'verification' | 'capabilities' | 'sensitivePaths'>>): string[] {
  const out: string[] = [];
  if (cfg.delivery.merge !== 'auto-when-eligible') out.push(`delivery.merge is "${cfg.delivery.merge}" (local integration is opt-in: set "auto-when-eligible")`);
  if (cfg.capabilities && baseEffect(cfg.capabilities['base.merge']) === 'deny') out.push('base.merge is denied by policy (the user integrates approved branches)');
  if (cfg.verification && !cfg.verification.commands.length) out.push('verification.commands is empty: the local integration gate has nothing to verify');
  return out;
}

/**
 * Local integration is on: delivery.merge "auto-when-eligible", `base.merge` not denied and verification commands
 * configured. An approval then queues the head for the integrator (task -> `merging`) instead of ending `delivered`.
 */
export const localIntegrationEnabled = (cfg: Pick<MinionsConfig, 'delivery' | 'verification' | 'capabilities'>): boolean =>
  autoMergeConfigReasons(cfg).length === 0;

const DONE_ONLY: ReadonlySet<TaskStatus> = new Set(['done']);
const DONE_OR_DELIVERED: ReadonlySet<TaskStatus> = new Set(['done', 'delivered']);

/**
 * Statuses that satisfy a dependency. With local integration on only `done` does (the dependency is on the
 * base, so dependents branch from a base that contains it); otherwise `done` or `delivered`, as before.
 */
export const dependencyDoneStatuses = (cfg: Pick<MinionsConfig, 'delivery' | 'verification' | 'capabilities'>): ReadonlySet<TaskStatus> =>
  localIntegrationEnabled(cfg) ? DONE_ONLY : DONE_OR_DELIVERED;
