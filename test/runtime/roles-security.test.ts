// Deny paths of the D10 role enforcement (task-33.2): preAgentHook and the drain hook.
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { requestDrain } from '../../src/runtime/drain.js';
import { drainHook, preAgentHook } from '../../src/runtime/hooks.js';
import { makeEnv, tmp, type Env } from './fixtures.js';

beforeAll(() => { process.env.MINIONS_STATE_DIR = tmp('minions-roles-sec-state-'); });

const ROLES = {
  researcher: { description: 'Researches.', promptText: 'Research.', contract: 'producer', edits: 'any', deepVariant: true },
  analyst: { description: 'Analyses.', promptText: 'Analyse.', contract: 'producer' },
} as const;
const withRoles = (c: MinionsConfig) => { (c as { roles?: unknown }).roles = ROLES; };
const loader = (env: Env) => () => ({ db: env.db, backlog: env.backlog, config: env.config });
const decision = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout).hookSpecificOutput : undefined);
const agent = (subagent_type: unknown, prompt: unknown, extra: Record<string, unknown> = {}) =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type, prompt, description: 'x', ...extra } });
function lease(env: Env, role: string, taskId = 'task-1', id = `lease-${role}0001`, status = 'active'): string {
  env.db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, worktree, branch, config_revision, started_at, status)
    VALUES (?, ?, ?, 1, NULL, ?, 'agent/x', 1, ?, ?)`, id, taskId, role, env.layout.repo, new Date().toISOString(), status);
  return id;
}
const denied = async (input: unknown, load: Parameters<typeof preAgentHook>[1]) => {
  const out = await preAgentHook(input, load);
  const d = decision(out);
  return d?.permissionDecision === 'deny' ? String(d.permissionDecisionReason) : undefined;
};

describe('preAgentHook deny paths', () => {
  it('denies case variants, whitespace and control characters around otherwise valid names, even with a matching lease', async () => {
    const env = makeEnv(withRoles);
    const ids = [lease(env, 'engineer', 'task-1'), lease(env, 'researcher', 'task-2')];
    const marker = ids.map((i) => `minions-lease: ${i}`).join(' ');
    for (const t of ['minions:Engineer', 'minions:ENGINEER', 'Minions:engineer', 'MINIONS:engineer', 'minions:Researcher', 'minions:engineer-Deep',
      'minions: engineer', 'minions:engineer ', ' minions:engineer', 'minions:engineer\n', 'minions:engineer\t', 'minions:\tengineer',
      'minions:engineer\u0000', 'minions:engin​eer', 'minions:researcher\nminions:engineer', 'minions:engineer:x', 'minions:engineer/../x']) {
      const r = await denied(agent(t, marker), loader(env));
      // a leading space or other prefix makes it a non-minions type, which the Agent hook does not police
      if (!t.startsWith('minions:')) { expect(r, JSON.stringify(t)).toBeUndefined(); continue; }
      expect(r, JSON.stringify(t)).toMatch(/Unknown minions agent type/);
    }
  });

  it('denies -deep for roles without a deep variant and for deep-of-deep, under any lease', async () => {
    const env = makeEnv(withRoles);
    const marker = ['engineer', 'tester', 'reviewer', 'researcher', 'analyst'].map((r, i) => `minions-lease: ${lease(env, r, `task-${i}`)}`).join(' ');
    for (const t of ['minions:tester-deep', 'minions:reviewer-deep', 'minions:analyst-deep', 'minions:engineer-deep-deep', 'minions:coordinator-deep', 'minions:-deep', 'minions:deep']) {
      expect(await denied(agent(t, marker), loader(env)), t).toMatch(/Unknown minions agent type/);
    }
    // the allowed deep variants work under their base role's lease only
    expect(await denied(agent('minions:engineer-deep', marker), loader(env))).toBeUndefined();
    expect(await denied(agent('minions:researcher-deep', marker), loader(env))).toBeUndefined();
    expect(await denied(agent('minions:researcher-deep', `minions-lease: ${lease(env, 'researcher-deep', 'task-9', 'lease-rdeep')}`), loader(env))).toMatch(/No active researcher lease/);
  });

  it('denies prototype-like names when the config has an own entry of the same name that is not a valid role', async () => {
    const env = makeEnv((c) => {
      (c as { roles?: unknown }).roles = JSON.parse('{"__proto__":{"description":"x","promptText":"x","contract":"producer"},"constructor":null}');
    });
    const marker = ['constructor', '__proto__', 'tostring'].map((r, i) => `minions-lease: ${lease(env, r, `task-${i}`)}`).join(' ');
    for (const t of ['minions:__proto__', 'minions:constructor', 'minions:toString', 'minions:tostring', 'minions:prototype', 'minions:isprototypeof']) {
      expect(await denied(agent(t, marker), loader(env)), t).toMatch(/Unknown minions agent type/);
    }
  });

  it('denies a lease that is not active, belongs to another role, or does not exist; tolerates a marker for the right lease among others', async () => {
    const env = makeEnv(withRoles);
    const released = lease(env, 'researcher', 'task-1', 'lease-rel', 'released');
    const done = lease(env, 'researcher', 'task-2', 'lease-done', 'completed');
    const other = lease(env, 'analyst', 'task-3');
    for (const ids of [[released], [done], [other], ['lease-nope'], [released, done, other, 'lease-nope']]) {
      expect(await denied(agent('minions:researcher', ids.map((i) => `minions-lease: ${i}`).join('\n')), loader(env)), ids.join()).toMatch(/No active researcher lease/);
    }
    const good = lease(env, 'researcher', 'task-4', 'lease-good');
    expect(await denied(agent('minions:researcher', `minions-lease: ${other}\nminions-lease: ${good}`), loader(env))).toBeUndefined();
    // a lease id-like string that is not the marker form does not count
    expect(await denied(agent('minions:researcher', `lease: ${good} ${good}`), loader(env))).toMatch(/needs a claimed lease/);
  });

  it('denies non-string or missing prompts and subagent types that are not strings', async () => {
    const env = makeEnv(withRoles);
    const id = lease(env, 'researcher');
    for (const p of [undefined, null, 42, { text: `minions-lease: ${id}` }, [`minions-lease: ${id}`]]) {
      expect(await denied(agent('minions:researcher', p), loader(env)), JSON.stringify(p)).toMatch(/needs a claimed lease/);
    }
    // a non-string subagent_type is not a minions type (allowed by the Agent hook as before)
    expect(await denied(agent(['minions:researcher'], `minions-lease: ${id}`), loader(env))).toBeUndefined();
  });

  it('fails closed when the loader rejects, returns no config, or the DB throws', async () => {
    const env = makeEnv(withRoles);
    const id = lease(env, 'researcher');
    const input = agent('minions:researcher', `minions-lease: ${id}`);
    expect(await denied(input, () => Promise.reject(new Error('config unreadable')))).toMatch(/config unreadable/);
    expect(await denied(input, () => ({ db: env.db, backlog: env.backlog }) as never)).toBeDefined();
    expect(await denied(input, () => ({ db: env.db, backlog: env.backlog, config: {} }) as never)).toBeDefined();
    const brokenDb = { lease: () => { throw new Error('database disk image is malformed'); } };
    expect(await denied(input, () => ({ db: brokenDb, backlog: env.backlog, config: env.config }) as never)).toMatch(/malformed/);
    // the same input is allowed with a working loader
    expect(await denied(input, loader(env))).toBeUndefined();
  });

  it('denies a full model id before loading anything', async () => {
    let loaded = false;
    const r = await denied(agent('minions:researcher', 'minions-lease: lease-x', { model: 'claude-opus-5-5' }), () => { loaded = true; throw new Error('x'); });
    expect(r).toMatch(/not an Agent model alias/);
    expect(loaded).toBe(false);
  });
});

describe('drain hook with an unregistered minions:* type', () => {
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

  it('an unregistered type is denied at launch by preAgentHook, so it cannot run under a lease the drain would miss', async () => {
    const env = makeEnv(withRoles);
    const id = lease(env, 'writer');
    expect(await denied(agent('minions:writer', `minions-lease: ${id}`), loader(env))).toMatch(/not a registered worker role/);
    expect(await denied(agent('minions:analyst-deep', `minions-lease: ${id}`), loader(env))).toMatch(/Unknown minions agent type/);
  });
});
