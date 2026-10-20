import type { MinionsConfig } from './schema.js';

/**
 * GitHub delivery (`branch` / `pull-request`; validation ties both to provider `github`). Under it
 * origin/<base> is the single source of truth: nothing merges into a local base, the workspace base only
 * fast-forwards from origin before each claim, and `minions upgrade` builds the CLI from origin/<base>.
 * Decision record: docs/design/bootstrap.md, "origin/<base> as the single source of truth".
 */
export const isGithubDelivery = (cfg: Pick<MinionsConfig, 'delivery'>): boolean => cfg.delivery.mode !== 'local';
