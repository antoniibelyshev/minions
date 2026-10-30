// Task-114, integration tier: the pre-bash hook's shell filter must forward a command that expands
// MINIONS_SECRETS_DIR to minions instead of allowing it in the shell. It spawns a shell, so it lives apart from the
// unit-tier checks in state-guard-spaces.test.ts.
import { describe, expect, it } from 'vitest';
import { PRE_BASH_HOOK_COMMAND } from '../../src/runtime/hooks.js';
import { runHookCommand } from '../helpers.js';

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: process.cwd(),
  agent_id: 'agent-1', agent_type: 'minions:engineer',
});

describe('pre-bash shell filter: MINIONS_SECRETS_DIR expansion (task-114)', () => {
  it('forwards the call to minions (none installed here: exit 2, fails closed)', () => {
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(bash('cat "$MINIONS_SECRETS_DIR/github-token"'))).status).toBe(2);
  });
});
