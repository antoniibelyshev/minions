import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_SETTINGS_TIMEOUT_S, HOOK_WRAPPER_TIMEOUT_S, TELEGRAM_HOOK_COMMAND } from '../../src/runtime/coordinator.js';
import { hangGuarded } from '../../src/runtime/hook-guard.js';
import { PRE_BASH_HOOK_COMMAND, PRE_FILE_READ_HOOK_COMMAND, PRE_FILE_WRITE_HOOK_COMMAND } from '../../src/runtime/hooks.js';
import { FAKE_MINIONS, hasCoreutilsTimeout, runHookCommand, withHangGuard } from '../helpers.js';

// Tester (task-2.5): adversarial probes of the shell wrappers around the fail-closed PreToolUse hooks.
// Claude Code blocks a PreToolUse call only on exit 2 (stdout JSON is ignored then); any other non-zero
// exit is a non-blocking error that lets the call through.

const template = JSON.parse(readFileSync(new URL('../../templates/plugin/hooks/hooks.json', import.meta.url), 'utf8')) as {
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
};
const PRE_AGENT_COMMAND = template.hooks.PreToolUse.find((h) => h.matcher === 'Agent')!.hooks[0]!.command;

const cases = [
  { name: 'pre-telegram', command: TELEGRAM_HOOK_COMMAND, stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_telegram_telegram__reply', tool_input: { chat_id: '1', text: 'hi' } }) },
  { name: 'pre-agent', command: PRE_AGENT_COMMAND, stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'minions:engineer', prompt: 'x' } }) },
];

// task-4: every probe runs under both hang guards; coreutils only where runHookCommand's PATH has `timeout`.
const guards = [
  { guard: 'perl' as const, skip: false },
  { guard: 'coreutils' as const, skip: !hasCoreutilsTimeout() },
];
const guarded = guards.flatMap((g) => cases.map((c) => ({ ...c, guard: g.guard, skip: g.skip, command: withHangGuard(c.command, { guard: g.guard }) })));

describe.each(guarded)('tester: $name hook command fails closed ($guard guard)', ({ command, stdin, skip }) => {
  if (skip) { it.skip('coreutils timeout not on PATH', () => {}); return; }
  it('blocks (exit 2) when the binary is missing, and the shell error is what was seen', () => {
    const r = runHookCommand(command, null, stdin);
    expect(r.status).toBe(2);
    // GNU timeout and shells name the binary; uutils timeout (Ubuntu's Rust coreutils) does not.
    expect(r.stderr).toMatch(/minions.*(not found|No such file)|failed to execute process: No such file/);
  });

  it('blocks a crash, and the fake really ran (not a failed exec from a noexec TMPDIR)', () => {
    const r = runHookCommand(command, FAKE_MINIONS.crash, stdin);
    expect(r.stderr).toMatch(/TypeError: boom/);
    expect(r.status).toBe(2);
  });

  it('blocks when minions is terminated by a signal', () => {
    const r = runHookCommand(command, FAKE_MINIONS.terminated, stdin);
    expect(r.stderr).toMatch(/minions-fake: terminating/);
    expect(r.status).toBe(2);
  });

  it('blocks when the minions shim cannot exec its interpreter (127)', () => {
    const r = runHookCommand(command, FAKE_MINIONS.noNode, stdin);
    expect(r.stderr).toMatch(/nonexistent/);
    expect(r.status).toBe(2);
  });

  it('blocks an "allow" JSON on stdout when the exit code is non-zero', () => {
    const r = runHookCommand(command, FAKE_MINIONS.allowThenFail, stdin);
    expect(r.stderr).toMatch(/minions-fake: failing/);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
    // Exit 2: Claude Code ignores stdout and blocks, so the stray allow cannot leak through.
    expect(r.status).toBe(2);
  });

  it('passes a healthy exit 0 through unchanged', () => {
    expect(runHookCommand(command, FAKE_MINIONS.allow, stdin)).toMatchObject({ status: 0, stdout: '', stderr: '' });
  });
});

// task-2.7: a hang must deny too. The guard (coreutils `timeout`, or the perl watchdog on stock macOS, task-4) kills
// a stuck hook (124) and `|| exit 2` blocks.
describe.each(guarded)('$name hook command fails closed on a hang ($guard guard)', ({ command, stdin, skip }) => {
  it.skipIf(skip)('a hung minions is killed by the wrapper and blocks with exit 2 (timeout shortened for the test)', () => {
    const fast = withHangGuard(command, { seconds: 1 });
    const t0 = Date.now();
    const r = runHookCommand(fast, '#!/bin/sh\nsleep 30\n', stdin);
    expect(r.status).toBe(2);
    expect(Date.now() - t0).toBeLessThan(15000);
  });

  it.skipIf(skip)('a hook that ends in time keeps its stdin and exit 0', () => {
    const r = runHookCommand(withHangGuard(command, { seconds: 5 }), '#!/bin/sh\ncat\n', stdin);
    expect(r).toMatchObject({ status: 0, stdout: stdin });
  });
});

describe('task-4: the perl fallback without perl', () => {
  it('blocks (exit 2) when neither timeout nor perl is on PATH', () => {
    const command = withHangGuard(TELEGRAM_HOOK_COMMAND, { guard: 'perl' }).replace('perl -e', '/nonexistent/perl -e');
    expect(runHookCommand(command, FAKE_MINIONS.allow, '{}').status).toBe(2);
  });
});

describe('hook entries carry a timeout larger than the wrapper', () => {
  it('plugin pre-agent entry', () => {
    const h = template.hooks.PreToolUse.find((e) => e.matcher === 'Agent')!.hooks[0] as { command: string; timeout?: number };
    expect(h.command).toContain(`timeout ${HOOK_WRAPPER_TIMEOUT_S} minions hook pre-agent`);
    expect(h.timeout).toBeGreaterThan(HOOK_WRAPPER_TIMEOUT_S);
  });
  it('coordinator pre-telegram entry', () => {
    expect(HOOK_SETTINGS_TIMEOUT_S).toBeGreaterThan(HOOK_WRAPPER_TIMEOUT_S);
  });
});

describe('task-2.7: wrapper shape and shell safety', () => {
  it('both gating hooks use the same wrapper, with plain shell-safe words only', () => {
    const agent = (template.hooks.PreToolUse.find((e) => e.matcher === 'Agent')!.hooks[0] as { command: string; timeout?: number });
    expect(agent.command).toBe(`${hangGuarded('minions hook pre-agent')} || exit 2`);
    expect(TELEGRAM_HOOK_COMMAND).toBe(`${hangGuarded('minions hook pre-telegram')} || exit 2`);
    expect(agent.command.replaceAll('pre-agent', 'X')).toBe(TELEGRAM_HOOK_COMMAND.replaceAll('pre-telegram', 'X'));
    expect(agent.timeout).toBe(HOOK_SETTINGS_TIMEOUT_S);
  });
});

// --------------------------------------------------------------------------- the pre-bash and state-guard entries
// The real end-to-end checks of the other PreToolUse shell entries (task-137.2.5): each guard's hooks.json command
// runs in a real shell against a fake minions binary and must fail closed (exit 2). The pure decisions behind them
// are unit tests (pre-bash-hook.test.ts, state-guard.test.ts, state-guard-spaces.test.ts).
const bash = (command: unknown, extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const sub = { agent_id: 'agent-1', agent_type: 'minions:engineer' };

describe('the plugin hooks.json Bash entry (pre-bash guard)', () => {
  const command = template.hooks.PreToolUse.find((h) => h.matcher === 'Bash')!.hooks[0]!.command;
  const subCall = JSON.stringify(bash('minions work claim task-1', sub));
  it('a subagent call naming minions blocks (exit 2) when minions is missing, crashes, is killed or fails after an allow', () => {
    expect(runHookCommand(command, null, subCall).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.crash, subCall).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.killed, subCall).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.noNode, subCall).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.allowThenFail, subCall).status).toBe(2);
    const denied = runHookCommand(command, FAKE_MINIONS.deny, subCall);
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('a hang is killed by the wrapper and blocks', () => {
    // The perl fallback (stock macOS, task-4); the coreutils branch is covered in hook-commands-fail-closed.test.ts.
    const fast = withHangGuard(command, { guard: 'perl', seconds: 1 });
    expect(runHookCommand(fast, '#!/bin/sh\nsleep 30\n', subCall).status).toBe(2);
  });

  it('node never starts for the coordinator\'s calls or for subagent calls that do not mention minions', () => {
    // A missing binary would exit 2 if the wrapper ran it.
    expect(runHookCommand(command, null, JSON.stringify(bash('minions work claim task-1')))).toMatchObject({ status: 0, stdout: '' });
    expect(runHookCommand(command, null, JSON.stringify(bash('npm test', sub)))).toMatchObject({ status: 0, stdout: '' });
    // The worker's own agent_type (minions:<role>) and a "minions:" label alone do not start it either.
    expect(runHookCommand(command, null, JSON.stringify(bash('gh issue list --label minions:authorized', sub)))).toMatchObject({ status: 0, stdout: '' });
  });

  it('a subagent call naming the entry script (cli.js) reaches minions too', () => {
    const direct = JSON.stringify(bash('node ./dist/cli.js work release lease-1', sub));
    expect(runHookCommand(command, null, direct).status).toBe(2);
    expect(JSON.parse(runHookCommand(command, FAKE_MINIONS.deny, direct).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(runHookCommand(command, null, JSON.stringify(bash('node ./dist/clixjs', sub)))).toMatchObject({ status: 0, stdout: '' });
  });

  it('a grep failure (missing or broken) blocks rather than skipping the check', () => {
    const noGrep = command.replace("grep -Eq", '/nonexistent/grep -Eq');
    expect(runHookCommand(noGrep, FAKE_MINIONS.allow, JSON.stringify(bash('npm test', sub))).status).toBe(2);
  });

  it('passes the hook input to minions unchanged', () => {
    const echo = '#!/bin/sh\ncat >&2\nexit 0\n';
    expect(runHookCommand(command, echo, subCall).stderr).toBe(subCall);
  });
});

describe('the plugin hooks.json file-tool and Bash entries (state guard)', () => {
  const worktree = join(mkdtempSync(join(tmpdir(), 'minions-hook-entries-')), 'workspace', 'worktrees', 'task-1');
  const file = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = sub) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: worktree, ...extra });
  it('write tools: every subagent call reaches minions and fails closed; the coordinator never starts node', () => {
    const subWrite = JSON.stringify(file('Write', { file_path: join(worktree, 'a.ts'), content: '' }));
    for (const fake of [null, FAKE_MINIONS.crash, FAKE_MINIONS.killed, FAKE_MINIONS.noNode, FAKE_MINIONS.allowThenFail]) {
      expect(runHookCommand(PRE_FILE_WRITE_HOOK_COMMAND, fake, subWrite).status).toBe(2);
    }
    expect(JSON.parse(runHookCommand(PRE_FILE_WRITE_HOOK_COMMAND, FAKE_MINIONS.deny, subWrite).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(runHookCommand(PRE_FILE_WRITE_HOOK_COMMAND, null, JSON.stringify(file('Write', { file_path: '/state/minions.db' }, {})))).toMatchObject({ status: 0, stdout: '' });
  });

  it('read tools and Bash: node starts for a subagent call naming the state dir, and fails closed then', () => {
    const subRead = JSON.stringify(file('Read', { file_path: '/state/briefs/lease-1.json' }));
    expect(runHookCommand(PRE_FILE_READ_HOOK_COMMAND, null, subRead).status).toBe(2);
    // A fixed path and cwd: the temp worktree can sit under a dir named state (the host scratch dir is <state>/cache/tmp).
    expect(runHookCommand(PRE_FILE_READ_HOOK_COMMAND, null, JSON.stringify(file('Read', { file_path: '/workspace/worktrees/t/a.ts' }, { ...sub, cwd: '/workspace/worktrees/t' })))).toMatchObject({ status: 0, stdout: '' });
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(bash('sqlite3 /state/minions.db .dump', sub))).status).toBe(2);
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(bash('ls "$MINIONS_STATE_DIR"', sub))).status).toBe(2);
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(bash('sqlite3 /state/minions.db .dump')))).toMatchObject({ status: 0, stdout: '' });
  });
});

describe('pre-bash shell filter: MINIONS_SECRETS_DIR expansion (task-114)', () => {
  it('forwards the call to minions (none installed here: exit 2, fails closed)', () => {
    const call = bash('cat "$MINIONS_SECRETS_DIR/github-token"', { ...sub, cwd: process.cwd() });
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(call)).status).toBe(2);
  });
});
