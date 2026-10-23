import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { requestDrain } from '../../src/runtime/drain.js';
import { fetchBrief, requireWorkerRole, submitResult } from '../../src/runtime/handoff.js';
import { drainHook, drainNotice, preAgentHook } from '../../src/runtime/hooks.js';
import { makeEnv, tmp, type Env } from './fixtures.js';

beforeAll(() => { process.env.MINIONS_STATE_DIR = tmp('minions-roles-state-'); });

const ROLES = {
  researcher: { description: 'Researches.', promptText: 'Research.', contract: 'producer', edits: { paths: ['docs/**'] }, deepVariant: true },
  analyst: { description: 'Analyses, read-only.', promptText: 'Analyse.', contract: 'producer' },
  auditor: { description: 'Audits.', promptText: 'Audit.', contract: 'gate' },
} as const;
const withRoles = (c: MinionsConfig) => { (c as { roles?: unknown }).roles = ROLES; };

const loader = (env: Env) => () => ({ db: env.db, backlog: env.backlog, config: env.config });
const decision = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout).hookSpecificOutput : undefined);
const agent = (subagent_type: string, prompt: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type, prompt, description: 'x' } });

/** Project-role leases cannot be claimed yet (stage machine: task-33.3/33.4); insert one as the claim would. */
function lease(env: Env, role: string, taskId = 'task-1', id = `lease-${role}0001`): string {
  env.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, worktree, branch, config_revision, started_at, status)
    VALUES (?, ?, ?, 1, NULL, ?, 'agent/x', 1, ?, 'active')`, id, taskId, role, env.layout.repo, new Date().toISOString());
  return id;
}

describe('pre-agent hook: registry roles only (D10)', () => {
  it('accepts minions:<role> of a project role under an active lease of that role', async () => {
    const env = makeEnv(withRoles);
    const id = lease(env, 'researcher');
    const ok = await preAgentHook(agent('minions:researcher', `minions-lease: ${id}`), loader(env));
    expect(ok.stdout).toBeUndefined();
    expect(ok.reason).toMatch(/allow: minions:researcher under lease/);
    // a lease of another role does not authorize it
    expect(decision(await preAgentHook(agent('minions:analyst', `minions-lease: ${id}`), loader(env))).permissionDecisionReason).toMatch(/No active analyst lease/);
    expect(decision(await preAgentHook(agent('minions:engineer', `minions-lease: ${id}`), loader(env))).permissionDecision).toBe('deny');
    // no marker: the claim hint names the role
    expect(decision(await preAgentHook(agent('minions:researcher', 'go'), loader(env))).permissionDecisionReason).toMatch(/--role researcher/);
  });

  it('accepts <role>-deep only for roles with deepVariant, under the base role lease', async () => {
    const env = makeEnv(withRoles);
    const r = lease(env, 'researcher', 'task-1');
    const a = lease(env, 'analyst', 'task-2');
    expect((await preAgentHook(agent('minions:researcher-deep', `minions-lease: ${r}`), loader(env))).stdout).toBeUndefined();
    for (const t of ['minions:analyst-deep', 'minions:auditor-deep', 'minions:researcher-deep-deep', 'minions:tester-deep']) {
      expect(decision(await preAgentHook(agent(t, `minions-lease: ${a} minions-lease: ${r}`), loader(env))).permissionDecisionReason, t).toMatch(/Unknown minions agent type/);
    }
  });

  it('denies unknown, removed, coordinator and prototype-like role names, whatever the leases say', async () => {
    const env = makeEnv(withRoles);
    const ids = ['writer', 'coordinator', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].map((r, i) => lease(env, r, `task-${i}`, `lease-x${i}`));
    const marker = ids.map((i) => `minions-lease: ${i}`).join('\n');
    for (const t of ['minions:writer', 'minions:coordinator', 'minions:constructor', 'minions:toString', 'minions:__proto__', 'minions:hasOwnProperty',
      'minions:valueof', 'minions:', 'minions:Engineer', 'minions:orchestrate', `minions:${'a'.repeat(60)}`, 'minions:engineer ']) {
      const d = decision(await preAgentHook(agent(t, marker), loader(env)));
      expect(d?.permissionDecision, t).toBe('deny');
      expect(d.permissionDecisionReason, t).toMatch(/Unknown minions agent type/);
    }
    // the same role name is fine once it is configured, and denied again once it is removed
    const without = makeEnv();
    const id = lease(without, 'researcher');
    expect(decision(await preAgentHook(agent('minions:researcher', `minions-lease: ${id}`), loader(without))).permissionDecisionReason).toMatch(/not a registered worker role \(engineer, tester, reviewer\)/);
  });

  it('fails closed when the config cannot be loaded', async () => {
    const d = decision(await preAgentHook(agent('minions:researcher', 'minions-lease: lease-abc'), () => { throw new Error('config broken'); }));
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toMatch(/config broken/);
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
    // an unregistered type is not a minions worker for the drain hook
    expect((await drainHook(worker('minions:writer', 'Edit', 'a4'), load)).reason).toMatch(/not a registered worker role/);
    // without the config (unreadable) the lease roles decide; the generic wording applies to project roles
    const dbOnly = () => ({ db: env.db });
    expect(context(await drainHook(worker('minions:researcher-deep', 'Edit', 'b1'), dbOnly))).toMatch(/If you changed tests, commit them/);
    expect(env.db.drainNotices('task-1').map((n) => n.agentId)).toEqual(['a1', 'b1']);
  });
});
