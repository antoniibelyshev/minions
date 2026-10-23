import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_HOOK_COMMAND } from '../../src/runtime/coordinator.js';
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
    expect(r.stderr).toMatch(/minions.*not found/);
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
