import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOOK_SETTINGS_TIMEOUT_S, TELEGRAM_HOOK_COMMAND } from '../../src/runtime/coordinator.js';
import { FAKE_MINIONS, runHookCommand } from '../helpers.js';

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

describe.each(cases)('tester: $name hook command fails closed', ({ command, stdin }) => {
  it('blocks (exit 2) when the binary is missing, and the shell error is what was seen', () => {
    const r = runHookCommand(command, null, stdin);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/minions.*(not found|No such file)/);
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

// task-2.7: a hang must deny too. coreutils `timeout` kills a stuck hook (124) and `|| exit 2` blocks.
describe.each(cases)('$name hook command fails closed on a hang', ({ command, stdin }) => {
  it('a hung minions is killed by the wrapper and blocks with exit 2 (timeout shortened for the test)', () => {
    expect(command).toMatch(/^timeout 20 minions hook /);
    const fast = command.replace(/^timeout 20 /, 'timeout 1 ');
    const t0 = Date.now();
    const r = runHookCommand(fast, '#!/bin/sh\nsleep 30\n', stdin);
    expect(r.status).toBe(2);
    expect(Date.now() - t0).toBeLessThan(15000);
  });
});

describe('hook entries carry a timeout larger than the wrapper', () => {
  const wrapper = (c: string) => Number(/^timeout (\d+) /.exec(c)![1]);
  it('plugin pre-agent entry', () => {
    const h = template.hooks.PreToolUse.find((e) => e.matcher === 'Agent')!.hooks[0] as { command: string; timeout?: number };
    expect(h.timeout).toBeGreaterThan(wrapper(h.command));
  });
  it('coordinator pre-telegram entry', () => {
    expect(HOOK_SETTINGS_TIMEOUT_S).toBeGreaterThan(wrapper(TELEGRAM_HOOK_COMMAND));
  });
});

describe('task-2.7: wrapper shape and shell safety', () => {
  const shape = /^timeout (\d+) minions hook (pre-agent|pre-telegram) \|\| exit 2$/;
  it('both gating hooks use the same wrapper, with plain shell-safe words only', () => {
    const agent = (template.hooks.PreToolUse.find((e) => e.matcher === 'Agent')!.hooks[0] as { command: string; timeout?: number });
    expect(agent.command).toMatch(shape);
    expect(TELEGRAM_HOOK_COMMAND).toMatch(shape);
    expect(agent.command.replace('pre-agent', 'X')).toBe(TELEGRAM_HOOK_COMMAND.replace('pre-telegram', 'X'));
    expect(agent.timeout).toBe(HOOK_SETTINGS_TIMEOUT_S);
  });
});
