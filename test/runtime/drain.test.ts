// Drain (task-3.7): the durable request behind `minions upgrade` winding workers down, the worker
// PreToolUse hook that acts on it, and how drain partials are recorded and resumed. Temp state only.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectStatus, pauseControl } from '../../src/runtime/commands.js';
import { clearDrain, DRAIN_HOOK_COMMAND, requestDrain } from '../../src/runtime/drain.js';
import { DRAIN_GRACE_CALLS, drainHook, drainSafeBash, runHook } from '../../src/runtime/hooks.js';
import { MinionsError } from '../../src/core/errors.js';
import { commitFile, makeEnv, result, tmp, type Env } from './fixtures.js';

beforeAll(() => { process.env.MINIONS_STATE_DIR = tmp('minions-drain-state-'); });

const flagOf = (env: Env) => ({ drainFlag: join(env.root, 'state', 'run', 'drain') });
const out = (o: { stdout?: string }) => (o.stdout ? JSON.parse(o.stdout) : null);
const worker = (agentType: string, tool: string, toolInput: Record<string, unknown> = {}, agentId = 'agent-1') =>
  ({ hook_event_name: 'PreToolUse', agent_id: agentId, agent_type: agentType, tool_name: tool, tool_input: toolInput, cwd: '/workspace/repo' });

describe('drain request (runtime DB + flag file)', () => {
  it('pause --drain pauses starts, records the request and writes the flag; a repeat keeps the same request', () => {
    const env = makeEnv();
    const p = flagOf(env);
    const r = pauseControl(env.db, p, 'pause', { drain: true, reason: 'upgrade' });
    expect(r.paused).toEqual({ intake: false, starts: true });
    expect(r.draining).toMatchObject({ reason: 'upgrade', eventId: expect.any(Number), requestedAt: expect.any(String) });
    expect(existsSync(p.drainFlag)).toBe(true);
    expect(JSON.parse(readFileSync(p.drainFlag, 'utf8')).eventId).toBe(r.draining!.eventId);
    const again = pauseControl(env.db, p, 'pause', { drain: true, reason: 'upgrade' });
    expect(again.draining).toEqual(r.draining);
  });

  it('keeps an existing starts pause (and its event), so the upgrade can still tell whose pause it is', () => {
    const env = makeEnv();
    env.db.setPaused({ starts: true });
    const before = env.db.pauseChanges().starts;
    requestDrain(env.db, flagOf(env), 'upgrade');
    expect(env.db.pauseChanges().starts).toEqual(before);
  });

  it('resume --starts (and plain resume) clears the drain and the flag; resume --drain clears only the drain', () => {
    const env = makeEnv();
    const p = flagOf(env);
    pauseControl(env.db, p, 'pause', { drain: true, reason: 'upgrade' });
    const r = pauseControl(env.db, p, 'resume', { starts: true });
    expect(r.draining).toBeNull();
    expect(existsSync(p.drainFlag)).toBe(false);

    pauseControl(env.db, p, 'pause', { drain: true, reason: 'upgrade' });
    pauseControl(env.db, p, 'resume', {});
    expect(env.db.drain()).toBeNull();

    pauseControl(env.db, p, 'pause', { drain: true, reason: 'upgrade' });
    const only = pauseControl(env.db, p, 'resume', { drain: true });
    expect(only.draining).toBeNull();
    expect(only.paused.starts).toBe(true);
    expect(existsSync(p.drainFlag)).toBe(false);
  });

  it('resume --intake does not clear a drain; --reason needs --drain', () => {
    const env = makeEnv();
    const p = flagOf(env);
    pauseControl(env.db, p, 'pause', { drain: true, reason: 'upgrade' });
    pauseControl(env.db, p, 'resume', { intake: true });
    expect(env.db.drain()).not.toBeNull();
    expect(() => pauseControl(env.db, p, 'pause', { reason: 'x' })).toThrow(/--reason is only used with --drain/);
  });

  it('status --json shows draining', async () => {
    const env = makeEnv();
    const status = () => collectStatus({ db: env.db, config: env.config, backlog: async () => env.backlog });
    expect((await status()).draining).toBeNull();
    requestDrain(env.db, flagOf(env), 'upgrade');
    expect((await status()).draining).toMatchObject({ reason: 'upgrade' });
    clearDrain(env.db, flagOf(env), 'test');
    expect((await status()).draining).toBeNull();
  });

  it('claims are refused while draining, with a hint to start nothing', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    requestDrain(env.db, flagOf(env), 'upgrade');
    const err = await env.sched.claim('task-1', 'engineer').catch((e: MinionsError) => e);
    expect(err).toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/paused for a drain \(upgrade/) });
    expect((err as MinionsError).hint).toMatch(/Start nothing while draining/);
  });
});

describe('drain hook (PreToolUse, every tool)', () => {
  async function leased(role: 'engineer' | 'reviewer' = 'engineer') {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    if (role === 'reviewer') {
      const e = await env.sched.claim('task-1', 'engineer');
      const head = commitFile(e.worktree, 'a.txt', 'x');
      await env.sched.record(e.leaseId, result({ branch: e.branch, headSha: head }));
      env.backlog.tasks.get('task-1')!.status = 'reviewing';
    }
    const brief = await env.sched.claim('task-1', role);
    requestDrain(env.db, flagOf(env), 'upgrade');
    return { env, brief, load: () => ({ db: env.db }) };
  }

  it('never touches the coordinator, other subagents, or sessions while no drain is requested', async () => {
    const env = makeEnv();
    const load = () => ({ db: env.db });
    requestDrain(env.db, flagOf(env), 'upgrade');
    expect((await drainHook({ tool_name: 'Edit', tool_input: {} }, load)).stdout).toBeUndefined();
    // --agent main thread: agent_type without agent_id is not a subagent
    expect((await drainHook({ agent_type: 'minions:engineer', tool_name: 'Edit' }, load)).stdout).toBeUndefined();
    expect((await drainHook(worker('Explore', 'Edit'), load)).stdout).toBeUndefined();
    clearDrain(env.db, flagOf(env), 'test');
    expect((await drainHook(worker('minions:engineer', 'Edit'), load)).reason).toMatch(/no drain requested/);
  });

  it('allows a minions worker type without an active lease of its role', async () => {
    const { load } = await leased('engineer');
    const r = await drainHook(worker('minions:reviewer', 'Edit'), load);
    expect(r.stdout).toBeUndefined();
    expect(r.reason).toMatch(/no active reviewer lease/);
  });

  it('first call: checkpoint notice as context; then a grace of tool calls; then only read-only tools, git and submit', async () => {
    const { load } = await leased('engineer');
    const first = out(await drainHook(worker('minions:engineer-deep', 'Edit'), load));
    expect(first.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('Upgrade pending: reach a safe checkpoint now. Commit work in progress on your branch (message prefix `wip:`), then return a partial WorkerResult that lists the remaining work.') });
    expect(first.hookSpecificOutput.permissionDecision).toBeUndefined();
    for (let i = 0; i < DRAIN_GRACE_CALLS; i++) expect((await drainHook(worker('minions:engineer-deep', 'Edit'), load)).stdout).toBeUndefined();
    const denied = out(await drainHook(worker('minions:engineer-deep', 'Edit'), load));
    expect(denied.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/Drain in progress \(upgrade\).*wip:.*partial WorkerResult/) });
    for (const [tool, input] of [['Read', {}], ['Grep', {}], ['Bash', { command: 'git add -A && git commit -m "wip: half of it; tests next"' }],
      ['Bash', { command: "cd /w && minions work submit lease-1 --role engineer --json <<'RESULT'\n{\"a\": \"x > y; z | w\"}\nRESULT" }]] as const) {
      expect((await drainHook(worker('minions:engineer-deep', tool, input), load)).stdout, `${tool} ${JSON.stringify(input)}`).toBeUndefined();
    }
    for (const command of ['git reset --hard', 'npm test', 'echo x > a.txt']) {
      expect(out(await drainHook(worker('minions:engineer-deep', 'Bash', { command }), load))?.hookSpecificOutput.permissionDecision, command).toBe('deny');
    }
    // Another worker has its own count: it gets its own notice first.
    expect(out(await drainHook(worker('minions:engineer', 'Edit', {}, 'agent-2'), load)).hookSpecificOutput.additionalContext).toMatch(/Upgrade pending/);
  });

  it('reviewers are told they have nothing to commit and return partial right away', async () => {
    const { load } = await leased('reviewer');
    const first = out(await drainHook(worker('minions:reviewer', 'Read'), load));
    expect(first.hookSpecificOutput.additionalContext).toMatch(/nothing to commit: return a partial WorkerResult right away.*reruns later at the same head/);
  });

  it('fails closed only for a minions worker when the drain state is unreadable; everyone else is allowed', async () => {
    const broken = () => { throw new Error('db locked'); };
    expect((await drainHook(worker('minions:engineer', 'Read'), broken)).stdout).toBeUndefined();
    expect(out(await drainHook(worker('minions:engineer', 'Edit'), broken)).hookSpecificOutput.permissionDecision).toBe('deny');
    expect((await drainHook({ tool_name: 'Edit' }, broken)).stdout).toBeUndefined();
    expect((await drainHook(worker('general-purpose', 'Edit'), broken)).stdout).toBeUndefined();
    // Unreadable input or an internal error: allow (the hook never blocks on its own failure outside a drain).
    expect((await runHook('drain', broken, 'not json')).stdout).toBeUndefined();
  });

  it('drainSafeBash: commits and inspection only', () => {
    for (const ok of ['git status --short', 'git -C /w log --oneline -5', 'cd /w && git add src/a.ts && git commit -m "wip: x"', 'git diff 2>&1 | head -50', 'git rev-parse HEAD >/dev/null', "git commit -F - <<'EOF'\nwip: a > b\nEOF"]) {
      expect(drainSafeBash(ok), ok).toBe(true);
    }
    for (const bad of ['git checkout -- .', 'git clean -fd', 'git stash', 'git restore a.ts', 'git branch -D x', 'rm -rf src', 'npm test', 'cat a > b', 'git status; rm x', 'minions backlog create']) {
      expect(drainSafeBash(bad), bad).toBe(false);
    }
  });

  it('the plugin gate runs minions only while the flag file exists (no node start otherwise)', () => {
    const dir = tmp('minions-drain-gate-');
    const bin = join(dir, 'bin');
    const state = join(dir, 'state');
    mkdirSync(bin); mkdirSync(join(state, 'run'), { recursive: true });
    writeFileSync(join(bin, 'minions'), `#!/bin/sh\necho "called $*" >> ${join(dir, 'calls')}\n`);
    chmodSync(join(bin, 'minions'), 0o755);
    const run = () => execFileSync('sh', ['-c', DRAIN_HOOK_COMMAND], { env: { PATH: `${bin}:/usr/bin:/bin`, MINIONS_STATE_DIR: state }, encoding: 'utf8' });
    run();
    expect(existsSync(join(dir, 'calls'))).toBe(false);
    writeFileSync(join(state, 'run', 'drain'), '{}');
    run();
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe('called hook drain\n');
  });
});

describe('drain partials (record + re-dispatch)', () => {
  it('an engineer drain partial is marked drain, costs no repair cycle, and the next brief continues from the wip: commit', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    requestDrain(env.db, flagOf(env), 'upgrade');
    const wip = commitFile(b.worktree, 'a.txt', 'half', 'wip: half of the feature');
    // Recorded after the upgrade already cleared the drain (recovery): still a drain partial.
    pauseControl(env.db, flagOf(env), 'resume', { starts: true });
    const r = await env.sched.record(b.leaseId, result({ status: 'partial', branch: b.branch, headSha: wip, findings: ['tests for b.txt'], nextAction: 'finish b.txt' }));
    expect(r).toMatchObject({ valid: true, drain: true, to: 'ready', message: expect.stringMatching(/Drain partial recorded.*not a failed attempt or repair cycle/) });
    expect(env.db.repairCycles('task-1')).toBe(0);
    expect(env.db.events('task-1', 'record').at(-1)?.data).toMatchObject({ drain: true, reason: 'drain' });
    expect(env.backlog.notes.at(-1)?.text).toMatch(/engineer partial \(drain\)/);
    const next = await env.sched.claim('task-1', 'engineer');
    expect(next.expectedHead).toBe(wip);
    expect(next.resume).toMatchObject({ fromLeaseId: b.leaseId, role: 'engineer', reason: 'drain', headSha: wip, remainingWork: ['tests for b.txt'], nextAction: 'finish b.txt' });
    expect(next.resume!.instruction).toMatch(/Continue from that commit/);
  });

  it('a reviewer drain partial keeps the task in reviewing; the rerun review gets the resume note', async () => {
    const env = makeEnv((c) => { c.verification.testerRequired = false; });
    env.backlog.add({ id: 'task-1' });
    const e = await env.sched.claim('task-1', 'engineer');
    const head = commitFile(e.worktree, 'a.txt', 'x');
    await env.sched.record(e.leaseId, result({ branch: e.branch, headSha: head }));
    const rv = await env.sched.claim('task-1', 'reviewer');
    requestDrain(env.db, flagOf(env), 'upgrade');
    const r = await env.sched.record(rv.leaseId, result({ status: 'partial', branch: rv.branch, headSha: head, checks: [], findings: ['src/ not reviewed yet'] }));
    expect(r).toMatchObject({ drain: true, to: 'reviewing' });
    clearDrain(env.db, flagOf(env), 'test');
    env.db.setPaused({ starts: false });
    const again = await env.sched.claim('task-1', 'reviewer');
    expect(again.expectedHead).toBe(head);
    expect(again.resume).toMatchObject({ role: 'reviewer', remainingWork: ['src/ not reviewed yet'] });
  });

  it('an ordinary partial (no drain) is unchanged: no drain mark, no resume block', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    const head = commitFile(b.worktree, 'a.txt', 'half');
    const r = await env.sched.record(b.leaseId, result({ status: 'partial', branch: b.branch, headSha: head }));
    expect(r.drain).toBeUndefined();
    expect(r.message).toBe('Partial result recorded; status unchanged.');
    expect((await env.sched.claim('task-1', 'engineer')).resume).toBeUndefined();
  });
});
