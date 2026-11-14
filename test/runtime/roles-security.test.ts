// The drain hook reaches every registered worker role (D10 role enforcement, task-33.2).
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { requestDrain } from '../../src/runtime/drain.js';
import { drainHook } from '../../src/runtime/hooks.js';
import { makeEnv, tmp, type Env } from './fixtures.js';
// Unit tier: git runs on the in-memory fake (./fake-git.ts).
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));

beforeAll(() => { process.env.MINIONS_STATE_DIR = tmp('minions-roles-sec-state-'); });

const ROLES = {
  researcher: { description: 'Researches.', promptText: 'Research.', contract: 'producer', edits: 'any', deepVariant: true },
  analyst: { description: 'Analyses.', promptText: 'Analyse.', contract: 'producer' },
} as const;
const withRoles = (c: MinionsConfig) => { (c as { roles?: unknown }).roles = ROLES; };
function lease(env: Env, role: string, taskId = 'task-1', id = `lease-${role}0001`, status = 'active'): string {
  env.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, worktree, branch, config_revision, started_at, status)
    VALUES (?, ?, ?, 1, NULL, ?, 'agent/x', 1, ?, ?)`, id, taskId, role, env.layout.repo, new Date().toISOString(), status);
  return id;
}

describe('drain hook', () => {
  const worker = (agentType: string, tool: string, agentId: string) =>
    ({ hook_event_name: 'PreToolUse', agent_id: agentId, agent_type: agentType, tool_name: tool, tool_input: {}, cwd: '/workspace/repo' });

  it('still drains every registered worker, deep variants included', async () => {
    const env = makeEnv(withRoles);
    lease(env, 'engineer', 'task-1');
    lease(env, 'researcher', 'task-2');
    requestDrain(env.db, { drainFlag: join(env.root, 'state', 'run', 'drain') }, 'upgrade');
    const load = () => ({ db: env.db, config: env.config });
    for (const [t, id] of [['minions:engineer', 'a1'], ['minions:engineer-deep', 'a2'], ['minions:researcher', 'a3'], ['minions:researcher-deep', 'a4']] as const) {
      expect((await drainHook(worker(t, 'Edit', id), load)).stdout, t).toBeDefined();
    }
  });
});
