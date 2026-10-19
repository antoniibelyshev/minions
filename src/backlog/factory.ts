import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MinionsConfig } from '../config/schema.js';
import { MinionsError } from '../core/errors.js';
import { atomicWrite } from '../core/fsutil.js';
import { containerPaths } from '../core/paths.js';
import { BacklogMdAdapter } from './backlogmd.js';
import type { BacklogAdapter, IdempotencyStore } from './types.js';

export type { IdempotencyStore } from './types.js';

/** In-memory store (CLI default and tests). The runtime passes a DB-backed one. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, string>();
  get(key: string) { return this.map.get(key); }
  put(key: string, taskId: string) { this.map.set(key, taskId); }
}

/** Opens the configured backend (v0.1: Backlog.md at /state/backlog). */
export function openBacklog(cfg: MinionsConfig, deps: { idempotency: IdempotencyStore; root?: string }): BacklogAdapter {
  if (cfg.backlog.backend !== 'backlogmd') {
    throw new MinionsError('INCOMPATIBLE_RUNTIME', `Backlog backend "${cfg.backlog.backend}" is deferred in v0.1`,
      'Use backlog.backend "backlogmd".');
  }
  return new BacklogMdAdapter({
    root: deps.root ?? containerPaths().backlog,
    idempotency: deps.idempotency,
    startReady: cfg.intake.startReady,
  });
}

/** Status order matters: Backlog.md treats the LAST status as "completed". */
export const BACKLOG_STATUSES = ['idea', 'ready', 'implementing', 'testing', 'reviewing', 'changes-requested',
  'awaiting-human', 'awaiting-ci', 'merging', 'blocked', 'cancelled', 'delivered', 'done'] as const;

export const BACKLOG_CONFIG_YML = `project_name: "minions"
default_status: "idea"
statuses: [${BACKLOG_STATUSES.map((s) => `"${s}"`).join(', ')}]
labels: []
date_format: yyyy-mm-dd
auto_open_browser: false
remote_operations: false
auto_commit: false
filesystem_only: true
check_active_branches: false
task_prefix: "task"
`;

/** Writes `<root>/backlog/config.yml` (no `backlog init`). Idempotent: unchanged content is not rewritten. */
export async function writeBacklogConfig(root: string): Promise<{ path: string; changed: boolean }> {
  const path = join(root, 'backlog', 'config.yml');
  let current: string | undefined;
  try { current = await readFile(path, 'utf8'); } catch { current = undefined; }
  if (current === BACKLOG_CONFIG_YML) return { path, changed: false };
  await atomicWrite(path, BACKLOG_CONFIG_YML);
  return { path, changed: true };
}
