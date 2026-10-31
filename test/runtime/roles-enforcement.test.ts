import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { requestDrain } from '../../src/runtime/drain.js';
import { fetchBrief, requireWorkerRole, submitResult } from '../../src/runtime/handoff.js';
import { drainHook, drainNotice, preAgentHook } from '../../src/runtime/hooks.js';
import { makeEnv, tmp, type Env } from './fixtures.js';
// Unit tier: git runs on the in-memory fake (./fake-git.ts).
vi.mock('../../src/core/exec.js', async (orig) => (await import('./fake-git.js')).mockExec(await orig()));

beforeAll(() => { process.env.MINIONS_STATE_DIR = tmp('minions-roles-state-'); });

const ROLES = {
  researcher: { description: 'Researches.', promptText: 'Research.', contract: 'producer', edits: { paths: ['docs/**'] }, deepVariant: true },
  analyst: { description: 'Analyses, read-only.', promptText: 'Analyse.', contract: 'producer' },
  auditor: { description: 'Audits.', promptText: 'Audit.', contract: 'gate' },
} as const;
const withRoles = (c: MinionsConfig) => { (c as { roles?: unknown }).roles = ROLES; };

const decision = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout).hookSpecificOutput : undefined);
const agent = (subagent_type: string, prompt: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type, prompt, description: 'x' } });

/** Inserts an active lease as a claim would (these hook tests need no task, worktree or workflow). */
function lease(env: Env, role: string, taskId = 'task-1', id = `lease-${role}0001`): string {
  env.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, worktree, branch, config_revision, started_at, status)
    VALUES (?, ?, ?, 1, NULL, ?, 'agent/x', 1, ?, 'active')`, id, taskId, role, env.layout.repo, new Date().toISOString());
  return id;
}

describe('pre-agent hook: minions workers never run as subagents (autonomy Decision 10)', () => {
  it('denies every minions:* agent type, whatever the leases say; other agent types pass', async () => {
    const env = makeEnv(withRoles);
    const id = lease(env, 'researcher');
    for (const t of ['minions:researcher', 'minions:researcher-deep', 'minions:engineer', 'minions:coordinator', 'minions:__proto__']) {
      const d = decision(preAgentHook(agent(t, `minions-lease: ${id}`)));
      expect(d.permissionDecision, t).toBe('deny');
      expect(d.permissionDecisionReason, t).toMatch(/workers run only under the autopilot dispatcher/);
    }
    expect(preAgentHook(agent('Explore', 'look around')).stdout).toBeUndefined();
    expect(preAgentHook({}).stdout).toBeUndefined();
  });
});

describe('work claim|brief|submit --role: registry roles only', () => {
  it('requireWorkerRole accepts built-ins and configured project roles, nothing else', () => {
    const env = makeEnv(withRoles);
    for (const r of ['engineer', 'tester', 'reviewer', 'researcher', 'analyst', 'auditor']) expect(requireWorkerRole(env.config, r).name).toBe(r);
    for (const r of ['coordinator', 'engineer-deep', 'researcher-deep', 'writer', 'constructor', '__proto__', 'toString', '', 'Engineer']) {
      let err: unknown;
      try { requireWorkerRole(env.config, r); } catch (e) { err = e; }
      expect(err, r).toBeInstanceOf(MinionsError);
      expect((err as MinionsError).code, r).toBe('POLICY_DENIED');
      expect((err as MinionsError).message, r).toMatch(/is not a registered worker role \(known: engineer, tester, reviewer, researcher, analyst, auditor\)/);
    }
  });

  it('brief and submit refuse an unregistered role before looking at the lease; a registered project role reaches its own lease', async () => {
    const env = makeEnv(withRoles);
    const id = lease(env, 'researcher');
    const p = { briefs: join(env.root, 'state', 'briefs'), results: join(env.root, 'state', 'results') };
    const caller = (role: string) => ({ role, cwd: env.layout.repo, config: env.config });
    const code = async (x: Promise<unknown>) => { try { await x; return 'ok'; } catch (e) { return (e as MinionsError).code; } };
    expect(await code(fetchBrief(env.db, p, id, caller('writer')))).toBe('POLICY_DENIED');
    expect(await code(submitResult(env.db, p, id, '{}', caller('constructor')))).toBe('POLICY_DENIED');
    // registered and the lease's own role: passes the ownership check (no stored brief for an inserted lease)
    expect(await code(fetchBrief(env.db, p, id, caller('researcher')))).toBe('NOT_FOUND');
    expect((await submitResult(env.db, p, id, '{"status":"partial"}', caller('researcher'))).leaseId).toBe(id);
    // registered, but not the lease's role
    expect(await code(fetchBrief(env.db, p, id, caller('analyst')))).toBe('POLICY_DENIED');
  });
});

describe('drain notice by contract variant (D10)', () => {
  it('words the notice by contract and by whether the role commits', () => {
    expect(drainNotice({ contract: 'gate', commits: false }, 'upgrade')).toMatch(/^Upgrade pending: stop the review now\. You have nothing to commit/);
    expect(drainNotice({ contract: 'producer', commits: true }, 'upgrade')).toMatch(/^Upgrade pending: reach a safe checkpoint now\. Commit work in progress/);
    expect(drainNotice({ contract: 'verifier', commits: true }, 'maintenance')).toMatch(/^Drain requested \(maintenance\): reach a safe checkpoint now\. If you changed tests/);
    expect(drainNotice({ contract: 'producer', commits: false }, 'upgrade')).toMatch(/^Upgrade pending: stop now\. Your role does not commit/);
    // built-in role names keep their wording
    expect(drainNotice('reviewer', 'upgrade')).toBe(drainNotice({ contract: 'gate', commits: false }, 'upgrade'));
    expect(drainNotice('engineer', 'upgrade')).toBe(drainNotice('producer', 'upgrade'));
    expect(drainNotice('tester', 'upgrade')).toBe(drainNotice('verifier', 'upgrade'));
  });

  const worker = (agentType: string, tool: string, agentId = 'agent-1') =>
    ({ hook_event_name: 'PreToolUse', agent_id: agentId, agent_type: agentType, tool_name: tool, tool_input: {}, cwd: '/workspace/repo' });
  const context = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout).hookSpecificOutput.additionalContext as string : undefined);

  it('the drain hook reaches project-role workers and words their notice by contract', async () => {
    const env = makeEnv(withRoles);
    lease(env, 'researcher', 'task-1');
    lease(env, 'auditor', 'task-2');
    lease(env, 'analyst', 'task-3');
    requestDrain(env.db, { drainFlag: join(env.root, 'state', 'run', 'drain') }, 'upgrade');
    const load = () => ({ db: env.db, config: env.config });
    expect(context(await drainHook(worker('minions:researcher-deep', 'Edit', 'a1'), load))).toMatch(/Commit work in progress/);
    expect(context(await drainHook(worker('minions:auditor', 'Read', 'a2'), load))).toMatch(/stop the review now/);
    expect(context(await drainHook(worker('minions:analyst', 'Read', 'a3'), load))).toMatch(/Your role does not commit/);
    // an unregistered type falls back to the lease-role match: no lease, nothing to do; an active lease of that role still gets the notice
    expect((await drainHook(worker('minions:writer', 'Edit', 'a4'), load)).reason).toMatch(/no active writer lease/);
    lease(env, 'writer', 'task-4');
    expect(context(await drainHook(worker('minions:writer', 'Edit', 'a5'), load))).toMatch(/If you changed tests, commit them/);
    // without the config (unreadable) the lease roles decide; the generic wording applies to project roles
    const dbOnly = () => ({ db: env.db });
    expect(context(await drainHook(worker('minions:researcher-deep', 'Edit', 'b1'), dbOnly))).toMatch(/If you changed tests, commit them/);
    expect(env.db.drainNotices('task-1').map((n) => n.agentId)).toEqual(['a1', 'b1']);
  });
});
