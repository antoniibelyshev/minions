import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hookLog, MAX_LOG_BYTES, preAgentHook, preTelegramHook, runHook, stopHook } from '../../src/runtime/hooks.js';
import { commitFile, makeEnv, result, tmp, type Env } from './fixtures.js';

let stateDir: string;
beforeAll(() => { stateDir = tmp('minions-hooks-'); process.env.MINIONS_STATE_DIR = stateDir; });
afterEach(() => vi.restoreAllMocks());

const loader = (env: Env) => () => ({ db: env.db, backlog: env.backlog, config: env.config });
const decision = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout) : null);

describe('stop hook', () => {
  it('blocks with a bounded instruction, then allows stop after repeated no-progress', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const a = await stopHook({ hook_event_name: 'Stop' }, loader(env));
    expect(decision(a)).toMatchObject({ decision: 'block' });
    expect(decision(a).reason).toMatch(/1 ready task\(s\) \(task-1\), capacity 2; run \/minions:orchestrate/);
    const b = await stopHook({ stop_hook_active: true }, loader(env));
    expect(decision(b)?.decision).toBe('block');
    const c = await stopHook({ stop_hook_active: true }, loader(env));
    expect(c.stdout).toBeUndefined();
    expect(env.db.guard().last_reason).toBe('no-progress');
    // stays quiet while nothing changes
    expect((await stopHook({}, loader(env))).stdout).toBeUndefined();
    // progress (a claim) resets the guard
    env.backlog.add({ id: 'task-2' });
    await env.sched.claim('task-1', 'engineer');
    expect(decision(await stopHook({}, loader(env)))?.decision).toBe('block');
  });

  it('allows stop when paused', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.db.setPaused({ starts: true });
    expect((await stopHook({}, loader(env))).stdout).toBeUndefined();
    expect(env.db.guard().last_reason).toBe('paused');
  });

  it('allows stop when the only tasks are blocked', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'blocked' });
    env.backlog.add({ id: 'task-2', dependencies: ['task-1'] });
    expect((await stopHook({}, loader(env))).stdout).toBeUndefined();
    expect(env.db.guard().last_reason).toBe('no-ready');
  });

  it('allows stop when there is no capacity', async () => {
    const env = makeEnv();
    for (const id of ['task-1', 'task-2', 'task-3']) env.backlog.add({ id });
    await env.sched.claim('task-1', 'engineer');
    await env.sched.claim('task-2', 'engineer');
    expect((await stopHook({}, loader(env))).stdout).toBeUndefined();
    expect(env.db.guard().last_reason).toBe('no-capacity');
  });

  it('allows stop on backlog error or unavailable state', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.failReady = true;
    expect((await stopHook({}, loader(env))).stdout).toBeUndefined();
    expect(env.db.guard().last_reason).toBe('backlog-error');
    const r = await stopHook({}, () => { throw new Error('db locked'); });
    expect(r.stdout).toBeUndefined();
    expect(r.reason).toMatch(/db locked/);
  });

  it('allows stop while a background subagent is running', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const r = await stopHook({ background_tasks: [{ id: 'x', type: 'subagent', status: 'running' }] }, loader(env));
    expect(r.stdout).toBeUndefined();
    expect(env.db.guard().last_reason).toBe('background-running');
  });

  it('continues for tasks awaiting the next stage', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1', status: 'testing' });
    expect(decision(await stopHook({}, loader(env))).reason).toMatch(/task-1:testing/);
  });
});

describe('pre-agent hook', () => {
  const agent = (subagent_type: string, prompt: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type, prompt, description: 'x' } });

  it('denies an unclaimed minions:engineer and allows a claimed one', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const none = await preAgentHook(agent('minions:engineer', 'implement task-1'), loader(env));
    expect(decision(none)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(decision(none).hookSpecificOutput.permissionDecisionReason).toMatch(/work claim/);
    expect(decision(await preAgentHook(agent('minions:engineer', 'minions-lease: lease-deadbeef0000'), loader(env))).hookSpecificOutput.permissionDecision).toBe('deny');

    const brief = await env.sched.claim('task-1', 'engineer');
    const ok = await preAgentHook(agent('minions:engineer', `Brief...\n${brief.briefMarker}\n`), loader(env));
    expect(ok.stdout).toBeUndefined();
    // wrong role for the lease
    expect(decision(await preAgentHook(agent('minions:tester', brief.briefMarker), loader(env))).hookSpecificOutput.permissionDecision).toBe('deny');
    // released lease no longer authorizes
    await env.sched.release(brief.leaseId, 'done');
    expect(decision(await preAgentHook(agent('minions:engineer', brief.briefMarker), loader(env))).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('accepts minions:engineer-deep under an engineer lease only', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const eng = await env.sched.claim('task-1', 'engineer');
    const ok = await preAgentHook(agent('minions:engineer-deep', eng.briefMarker), loader(env));
    expect(ok.stdout).toBeUndefined();
    expect(ok.reason).toMatch(/allow: minions:engineer-deep under lease/);
    for (const t of ['minions:tester-deep', 'minions:reviewer-deep', 'minions:engineer-deeper']) {
      expect(decision(await preAgentHook(agent(t, eng.briefMarker), loader(env))).hookSpecificOutput.permissionDecisionReason, t).toMatch(/Unknown minions agent type/);
    }
    // the engineer lease is the only thing that authorizes it
    await env.sched.release(eng.leaseId, 'done');
    const gone = decision(await preAgentHook(agent('minions:engineer-deep', eng.briefMarker), loader(env)));
    expect(gone.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(gone.hookSpecificOutput.permissionDecisionReason).toMatch(/No active engineer lease/);
    expect(decision(await preAgentHook(agent('minions:engineer-deep', 'go'), loader(env))).hookSpecificOutput.permissionDecisionReason).toMatch(/--role engineer/);
  });

  it('denies minions:engineer-deep under a tester lease', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const eng = await env.sched.claim('task-1', 'engineer');
    const head = commitFile(eng.worktree, 'a.txt', 'x');
    await env.sched.record(eng.leaseId, result({ branch: eng.branch, headSha: head }));
    const tester = await env.sched.claim('task-1', 'tester');
    const r = decision(await preAgentHook(agent('minions:engineer-deep', tester.briefMarker), loader(env)));
    expect(r.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies a full model id as the Agent model and allows aliases or an omitted model', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const brief = await env.sched.claim('task-1', 'engineer');
    const withModel = (model: string) => ({ ...agent('minions:engineer', brief.briefMarker), tool_input: { ...agent('minions:engineer', brief.briefMarker).tool_input, model } });
    const full = decision(await preAgentHook(withModel('claude-opus-5-5'), loader(env)));
    expect(full.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(full.hookSpecificOutput.permissionDecisionReason).toMatch(/not an Agent model alias \(sonnet\|opus\|haiku\|fable\)\. Omit `model`/);
    for (const m of ['sonnet', 'opus', 'haiku', 'fable']) expect((await preAgentHook(withModel(m), loader(env))).stdout, m).toBeUndefined();
    expect((await preAgentHook(agent('minions:engineer', brief.briefMarker), loader(env))).stdout).toBeUndefined();
  });

  it('passes other agent types through and fails closed for minions workers', async () => {
    expect((await preAgentHook(agent('general-purpose', 'anything'), () => { throw new Error('x'); })).stdout).toBeUndefined();
    const r = await preAgentHook(agent('minions:reviewer', 'minions-lease: lease-abc'), () => { throw new Error('db broken'); });
    expect(decision(r).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision(r).hookSpecificOutput.permissionDecisionReason).toMatch(/db broken/);
  });
});

describe('runHook', () => {
  it('prints the exact Claude Code formats and logs redacted lines', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => { writes.push(String(s)); return true; });
    await runHook('stop', loader(env), '{"hook_event_name":"Stop"}');
    expect(JSON.parse(writes.join(''))).toEqual({ decision: 'block', reason: expect.any(String) });
    writes.length = 0;
    await runHook('pre-agent', loader(env), 'not json sk-ant-api03-abcdefghijklmnop');
    expect(JSON.parse(writes.join('')).hookSpecificOutput.permissionDecision).toBe('deny');
    writes.length = 0;
    await runHook('stop', loader(env), 'garbage');
    expect(writes).toEqual([]);
    const log = readFileSync(join(stateDir, 'logs', 'hooks.log'), 'utf8');
    expect(log).toMatch(/stop allow: unreadable/);
    expect(log).not.toMatch(/sk-ant-api03-abcdefghijklmnop/);
  });

  it('rotates the hook log at ~1MB', () => {
    const path = join(tmp(), 'logs', 'hooks.log');
    hookLog('first', path);
    writeFileSync(path, 'x'.repeat(MAX_LOG_BYTES + 10));
    hookLog('after rotation', path);
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(statSync(path).size).toBeLessThan(1000);
  });
});

describe('pre-telegram hook', () => {
  const call = (extra: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: { chat_id: '1', text: 'hi' }, ...extra });
  const permission = (o: { stdout?: string }) => decision(o)?.hookSpecificOutput?.permissionDecision;

  it('allows the coordinator main thread', () => {
    const r = preTelegramHook(call({}));
    expect(r.stdout).toBeUndefined();
    expect(r.reason).toMatch(/^allow: mcp__plugin_telegram_telegram__reply from the coordinator/);
  });

  it('denies the built-in general-purpose subagent and every other subagent type', () => {
    for (const agent_type of ['general-purpose', 'Explore', 'Plan', 'some-plugin:helper', 'minions:engineer']) {
      const r = preTelegramHook(call({ agent_id: 'a1b2', agent_type }));
      expect(permission(r), agent_type).toBe('deny');
      expect(decision(r).hookSpecificOutput.permissionDecisionReason).toMatch(new RegExp(`coordinator-only; subagents \\(${agent_type}\\)`));
    }
    // Either field alone marks a subagent call.
    expect(permission(preTelegramHook(call({ agent_id: 'x' })))).toBe('deny');
    expect(permission(preTelegramHook(call({ agent_type: 'general-purpose' })))).toBe('deny');
  });

  it('runHook fails closed on unreadable input', async () => {
    const env = makeEnv();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(permission(await runHook('pre-telegram', loader(env), 'not json'))).toBe('deny');
    expect(permission(await runHook('pre-telegram', loader(env), JSON.stringify(call({ agent_id: 'z', agent_type: 'general-purpose' }))))).toBe('deny');
    expect((await runHook('pre-telegram', loader(env), JSON.stringify(call({})))).stdout).toBeUndefined();
  });
});

describe('tester: pre-telegram edge cases', () => {
  const permission = (o: { stdout?: string }) => decision(o)?.hookSpecificOutput?.permissionDecision;

  it('never emits an explicit allow on the main thread, so download_attachment still prompts', () => {
    for (const tool of ['reply', 'react', 'edit_message', 'download_attachment'].map((t) => `mcp__plugin_telegram_telegram__${t}`)) {
      const r = preTelegramHook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} });
      expect(r.stdout, tool).toBeUndefined();
    }
  });

  it('denies a subagent download_attachment call and names the tool', () => {
    const r = preTelegramHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram_telegram__download_attachment', agent_id: 'a', agent_type: 'general-purpose' });
    expect(permission(r)).toBe('deny');
    expect(decision(r).hookSpecificOutput.permissionDecisionReason).toMatch(/^mcp__plugin_telegram_telegram__download_attachment is coordinator-only/);
  });

  it('logs the deny to hooks.log so the first live run can confirm the gate', async () => {
    const env = makeEnv();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHook('pre-telegram', loader(env), JSON.stringify({ tool_name: 'mcp__plugin_telegram_telegram__reply', agent_id: 'a', agent_type: 'general-purpose' }));
    expect(readFileSync(join(stateDir, 'logs', 'hooks.log'), 'utf8')).toMatch(/pre-telegram deny/);
  });
});
