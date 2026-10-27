// Task-72 QA: negative cases for the worker state guard beyond the engineer's unit tests (path spellings,
// wrappers, redirected state dirs), plus known gaps pinned with it.fails so a fix shows up as a failing test
// (then turn the it.fails into a plain it; both former gaps are fixed now). Nothing here touches the live /state.
import { describe, expect, it } from 'vitest';
import { preBashHook, preFileHook } from '../../src/runtime/hooks.js';
import { stateGuard } from '../../src/runtime/state-guard.js';

const container = stateGuard({ state: '/state', tmp: '/home/node/.cache/tmp' });
const sub = { agent_id: 'agent-1', agent_type: 'minions:tester' };
const cwd = '/workspace/worktrees/task-1';
const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, ...sub });
const file = (tool_name: string, tool_input: Record<string, unknown>, at = cwd) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: at, ...sub });
const denied = (o: { stdout?: string }) => !!o.stdout && JSON.parse(o.stdout).hookSpecificOutput.permissionDecision === 'deny';

describe('state guard QA: worker writes are refused in other spellings', () => {
  it('file tools: doubled slash, dot-dot through another dir, and a relative path from /', () => {
    expect(denied(preFileHook(file('MultiEdit', { file_path: '//state/minions.db', edits: [] }), container))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: '/tmp/../state/results/r.json', content: 'x' }), container))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: 'state/minions.db', content: 'x' }, '/'), container))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: '/state/minions.db-wal', content: 'x' }), container))).toBe(true);
  });

  it('Bash: interpreter writes, nested shells, symlink creation and the minions entry by full path or option order', () => {
    for (const cmd of [
      "node -e \"require('fs').writeFileSync('/state/x','')\"",
      "bash -c 'echo x > /state/x'",
      'ln -s /state LINK',
      'sqlite3 /state/cache/../minions.db .tables',
      '/usr/local/bin/minions work record lease-1',
      'npx minions backlog update task-1 --status done',
      'minions --json work approve lease-1',
      // Pointing minions at the protected dir is no redirect.
      'MINIONS_STATE_DIR=/state node dist/cli.js backlog update task-1 --status done',
      // The redirect counts only for the same simple command.
      'MINIONS_STATE_DIR=/home/node/.cache/tmp/s true; minions work record lease-1',
    ]) expect(denied(preBashHook(bash(cmd), container)), cmd).toBe(true);
  });

  it('Bash: a scratch-state minions run and the worker submit from a scratch file stay allowed', () => {
    for (const cmd of [
      'env MINIONS_STATE_DIR=/home/node/.cache/tmp/s node dist/cli.js work record lease-1',
      'minions work submit lease-1 --role tester --json < /home/node/.cache/tmp/leases/lease-1/result.json',
      'minions status --json',
    ]) expect(denied(preBashHook(bash(cmd), container)), cmd).toBe(false);
  });
});

describe('state guard QA: former gaps (fixed in attempt 2)', () => {
  // In the container the scratch root is /home/node/.cache/tmp, yet <state>/cache stays exempt. /state/cache does
  // not exist there, so a worker can create it and link the DB into it, all with literal paths.
  it('container: /state/cache is not exempt (no literal-path route to the DB through a link there)', () => {
    expect(denied(preBashHook(bash('mkdir -p /state/cache && ln -s ../minions.db /state/cache/db'), container))).toBe(true);
    expect(denied(preBashHook(bash("sqlite3 /state/cache/db \"update tasks set pr_url='x'\""), container))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: '/state/cache/x', content: 'x' }), container))).toBe(true);
  });

  // The worker prompts submit through a heredoc; findings that name a state path (common in this repository) are refused.
  it('a heredoc submit whose findings mention a state path is allowed', () => {
    const cmd = "minions work submit lease-1 --role tester --json <<'RESULT'\n{\"findings\":[\"workers could write /state/minions.db\"]}\nRESULT";
    expect(denied(preBashHook(bash(cmd), container))).toBe(false);
  });
});
