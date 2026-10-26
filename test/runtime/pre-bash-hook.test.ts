// task-14.5 (agent-runtimes D10, child task 8): the Claude-subagent PreToolUse(Bash) hook denies
// `minions work run|claim|release` when agent_id is set; the coordinator is allowed; the hook fails closed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coordinatorOnlyWorkCommand, preBashHook, PRE_BASH_HOOK_COMMAND, runHook } from '../../src/runtime/hooks.js';
import { FAKE_MINIONS, runHookCommand } from '../helpers.js';

const template = JSON.parse(readFileSync(new URL('../../templates/plugin/hooks/hooks.json', import.meta.url), 'utf8')) as {
  hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout?: number }[] }[] };
};
const bash = (command: unknown, extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const sub = { agent_id: 'agent-1', agent_type: 'minions:engineer' };
const decision = (o: { stdout?: string }) => (o.stdout ? (JSON.parse(o.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : null);

describe('coordinatorOnlyWorkCommand', () => {
  it.each([
    'minions work run lease-1',
    'minions work claim task-1 --json',
    'minions work release lease-1 --reason x',
    'cd /x && minions --json work claim task-1',
    '/usr/local/bin/minions work run lease-1',
    'ls; minions work release lease-1',
    'echo $(minions work claim t)',
    "sh -c 'minions work run lease-1'",
    '"minions" work "claim" t',
    'm\\inions work run x',
    'MINIONS_X=1 minions work run x',
    'true || minions work run x &',
  ])('matches %s', (cmd) => {
    expect(coordinatorOnlyWorkCommand(cmd)).toMatch(/^minions work (run|claim|release)$/);
  });

  it.each([
    'minions work submit lease-1 --role engineer --json',
    'minions work brief lease-1 --role engineer --json',
    'minions status --json',
    'echo minions; work run',
    'npm test',
    'minions-sandbox work run',
  ])('does not match %s', (cmd) => {
    expect(coordinatorOnlyWorkCommand(cmd)).toBeNull();
  });
});

describe('preBashHook', () => {
  it('denies a subagent running minions work run|claim|release', () => {
    for (const verb of ['run lease-1', 'claim task-1', 'release lease-1 --reason x']) {
      const d = decision(preBashHook(bash(`minions work ${verb}`, sub)));
      expect(d?.permissionDecision).toBe('deny');
      expect(d?.permissionDecisionReason).toMatch(/coordinator-only/);
    }
  });

  it('any non-null agent_id marks a subagent (fail closed), with or without agent_type', () => {
    for (const agent_id of ['', 0, false, {}, 'x']) expect(decision(preBashHook(bash('minions work claim t', { agent_id })))?.permissionDecision).toBe('deny');
  });

  it('allows the coordinator (no agent_id) and a subagent\'s own submit/brief and other commands', () => {
    expect(preBashHook(bash('minions work claim task-1 --json'))).toEqual({ reason: 'allow: Bash from the coordinator' });
    expect(preBashHook(bash('minions work claim task-1 --json', { agent_id: null })).stdout).toBeUndefined();
    expect(preBashHook(bash('minions work submit lease-1 --role engineer --json', sub)).stdout).toBeUndefined();
    expect(preBashHook(bash('npm test', sub)).stdout).toBeUndefined();
  });

  it('fails closed on input it cannot decide', () => {
    for (const input of [null, [], 'x', { tool_name: 'Read', tool_input: { command: 'ls' } }, { tool_name: 'Bash' }, bash(42), bash(undefined, sub)]) {
      expect(decision(preBashHook(input))?.permissionDecision).toBe('deny');
    }
  });

  it('runHook pre-bash denies unparseable input and needs no runtime context', async () => {
    const load = async () => { throw new Error('no context'); };
    expect(decision(await runHook('pre-bash', load, '{broken'))?.permissionDecision).toBe('deny');
    expect(decision(await runHook('pre-bash', load, JSON.stringify(bash('minions work run x', sub))))?.permissionDecision).toBe('deny');
    expect((await runHook('pre-bash', load, JSON.stringify(bash('ls', sub)))).stdout).toBeUndefined();
  });
});

describe('the plugin hooks.json Bash entry', () => {
  const entry = template.hooks.PreToolUse.find((h) => h.matcher === 'Bash')!;
  const command = entry.hooks[0]!.command;
  const subCall = JSON.stringify(bash('minions work claim task-1', sub));

  it('is the documented command, with an entry timeout above the wrapper timeout', () => {
    expect(command).toBe(PRE_BASH_HOOK_COMMAND);
    expect(entry.hooks[0]!.timeout).toBeGreaterThan(20);
  });

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
    const fast = command.replace('timeout 20 ', 'timeout 1 ');
    expect(fast).not.toBe(command);
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

// ------------------------------------------------------------------------------- tester regressions (task-14.5 QA)

describe('tester regressions: pre-bash bypass variants', () => {
  it.each([
    'command minions work claim t',
    'env -i PATH=/usr/bin minions work claim t',
    'exec minions work release lease-1',
    'nohup minions work run lease-1 &',
    'timeout 5 minions work run lease-1',
    'sudo -u node minions work run lease-1',
    'bash -lc "minions work claim t"',
    'minions work -- run lease-1',
    'minions\twork\trelease lease-1',
    'cd /w && npm test && minions work release lease-1 --reason done',
    'xargs -I{} minions work release {}',
    "/opt/minions/pkg/node_modules/.bin/minions work 'claim' t",
  ])('denies a subagent: %s', (cmd) => {
    expect(decision(preBashHook(bash(cmd, sub)))?.permissionDecision).toBe('deny');
  });

  it('the coordinator (no agent_id) is never denied, whatever the command', () => {
    for (const cmd of ['minions work run lease-1', 'minions work release lease-1 --reason x', 'minions work claim t']) {
      expect(preBashHook(bash(cmd)).stdout).toBeUndefined();
    }
  });

  it('a subagent\'s ordinary worker commands pass', () => {
    for (const cmd of [
      'cd /w && minions work brief lease-1 --role tester --json',
      'minions work submit lease-1 --role tester --result-file /s/result.json',
      'minions work submit lease-1 --role engineer --json <<\'RESULT\'\n{"status":"complete","summary":"ok"}\nRESULT',
      'minions status --json',
      'minions --help',
    ]) expect(preBashHook(bash(cmd, sub)).stdout).toBeUndefined();
  });

  // Gaps found in QA (task-14.5), fixed by the command-position scanner (src/runtime/shell-scan.ts).
  it('FIXED: a line continuation (backslash-newline) between words is ordinary shell, but bypasses the check', () => {
    expect(coordinatorOnlyWorkCommand('minions \\\nwork run lease-1')).not.toBeNull();
  });
  it('FIXED: a redirection glued to a word (run>/dev/null, minions>log, run<in) bypasses the check', () => {
    for (const cmd of ['minions work run>/dev/null lease-1', 'minions>/tmp/log work claim t', 'minions work release<in lease-1']) {
      expect(coordinatorOnlyWorkCommand(cmd)).not.toBeNull();
    }
  });
  it('FIXED: the bin target run directly (node .../minions/pkg/dist/cli.js) bypasses the check', () => {
    expect(coordinatorOnlyWorkCommand('node /opt/minions/pkg/dist/cli.js work release lease-1')).not.toBeNull();
  });
  it('FIXED (false positive): a worker submit heredoc whose findings mention the command is denied', () => {
    const cmd = 'minions work submit lease-1 --role tester --json <<\'RESULT\'\n{"findings":["repro: run minions work release lease-1 while a runner is live"]}\nRESULT';
    expect(preBashHook(bash(cmd, sub)).stdout).toBeUndefined();
  });
  it('FIXED (false positive): a commit message naming the command is denied', () => {
    expect(preBashHook(bash('git commit -m "Add the process runner (minions work run) and the fake harness"', sub)).stdout).toBeUndefined();
  });
});

// ------------------------------------------------------------------- command-position scanner (task-14.5 repair)

describe('coordinatorOnlyWorkCommand: command position, not raw text', () => {
  it.each([
    ['continuation inside the verb list', 'minions work \\\nrelease lease-1'],
    ['continuation in a wrapper', 'env \\\n  FOO=1 \\\n  minions work claim t'],
    ['fd redirection before the verb', 'minions work 2>/dev/null run lease-1'],
    ['&> redirection glued', 'minions work run&>/dev/null lease-1'],
    ['heredoc on the command itself', "minions work release lease-1 --reason x <<'EOF'\nbody\nEOF"],
    ['command after a heredoc body', "cat <<'EOF'\nminions work release lease-1\nEOF\nminions work run lease-1"],
    ['substitution in an unquoted heredoc body', 'cat <<EOF\n$(minions work claim t)\nEOF'],
    ['backticks in an unquoted heredoc body', 'cat <<EOF\n`minions work release lease-1`\nEOF'],
    ['substitution inside double quotes', 'echo "now: $(minions work claim t)"'],
    ['backticks inside double quotes', 'echo "`minions work run x`"'],
    ['nested substitutions', 'echo $(echo $(minions work run x))'],
    ['process substitution', 'cat <(minions work claim t)'],
    ['parameter expansion with a substitution', 'echo ${X:-$(minions work run x)}'],
    ['a subshell', '(cd /w && minions work release lease-1)'],
    ['a brace group', '{ minions work claim t; }'],
    ['if/then', 'if true; then minions work run x; fi'],
    ['a pipeline after a quoted pipe char', 'echo "a|b" | minions work claim t'],
    ['the entry script, direct', '/opt/minions/pkg/dist/cli.js work run lease-1'],
    ['the entry script, relative under node', 'node ./dist/cli.js work claim t'],
    ['node with options', 'node --enable-source-maps /opt/minions/pkg/dist/cli.js --json work release x'],
    ['npx', 'npx minions work run x'],
    ['eval', 'eval "minions work" run x'],
    ['sh -c with a nested quoted script', 'sh -c "bash -c \'minions work release x\'"'],
    ['ssh with a remote command string', "ssh host 'minions work claim t'"],
    ['find -exec', 'find . -name x -exec minions work release {} \\;'],
    ['an assignment with an array index', 'A[0]=1 minions work run x'],
    ['after a comment line', '# release it\nminions work release lease-1'],
    ['carriage returns', 'minions work run x\r\n'],
  ])('denies %s', (_name, cmd) => {
    expect(coordinatorOnlyWorkCommand(cmd)).toMatch(/^minions work (run|claim|release)$/);
  });

  it.each([
    ['a quoted heredoc body', "minions work submit lease-1 --role tester --json <<'RESULT'\n{\"findings\":[\"run minions work release lease-1; then minions work claim t\"]}\nRESULT"],
    ['an unquoted heredoc body (plain text, no substitution)', 'minions work submit lease-1 --role tester --json <<RESULT\n{"findings":["repro: minions work release lease-1 | minions work run x"]}\nRESULT'],
    ['a <<- heredoc body', 'cat <<-EOF > /s/notes\n\tminions work run x\n\tEOF'],
    ['a commit message', 'git commit -m "Add the process runner (minions work run) and the fake harness"'],
    ['a commit message from a heredoc substitution', "git commit -m \"$(cat <<'EOF'\nDon't let minions work release end the lease (or minions work run)\n\nBody.\nEOF\n)\""],
    ['a grep pattern', 'grep -rn "minions work release" src'],
    ['a single-quoted grep pattern', "grep -rn 'minions work run\\|minions work claim' src test"],
    ['echo with quotes', 'echo "use: minions work claim <task>"'],
    ['a comment', 'npm test # then minions work release lease-1'],
    ['a file name', 'cat docs/minions-work-run.md'],
    ['a redirection target named minions', 'npm test > minions; work run'],
    ['wrappers whose quoted argument mentions it', 'timeout 60 git commit -m "minions work run"'],
    ['sh -c with a quoted inner argument', 'sh -c \'git commit -m "minions work release x"\''],
    ['a here-string', 'cat <<< "minions work run x"'],
    ['the worker\'s own submit', 'cd /w && minions work submit lease-1 --role engineer --result-file /s/r.json'],
  ])('allows %s', (_name, cmd) => {
    expect(coordinatorOnlyWorkCommand(cmd)).toBeNull();
  });

  it('fails closed on a line it cannot scan, but only when the raw text names the command', () => {
    expect(coordinatorOnlyWorkCommand("echo 'unterminated; minions work run x")).toBe('minions work run');
    expect(coordinatorOnlyWorkCommand('echo "unterminated $(minions work claim t')).toBe('minions work claim');
    expect(coordinatorOnlyWorkCommand("echo 'unterminated; npm test")).toBeNull();
    const deep = `${'$('.repeat(40)}minions work release x${')'.repeat(40)}`;
    expect(coordinatorOnlyWorkCommand(deep)).toBe('minions work release');
  });
});

// Tester re-test (task-14.5 attempt 2) of the shell scanner. Normal worker commands stay allowed; wrapped,
// substituted and heredoc-fed forms are denied. `it.fails` marks scanner gaps found in this pass: each passes while
// the gap exists and starts failing once it is fixed (turn it into a plain `it` then).
describe('tester re-test: shell scanner edge cases', () => {
  it.each([
    "minions work submit lease-1 --role tester --result-file /scratch/result.json",
    "cd /w && minions work brief lease-1 --role tester --json",
    'minions work submit lease-1 --role tester --json <<RESULT\n{"findings":["run minions work release lease-1"]}\nRESULT',
    'git commit -m "$(cat <<\'EOF\'\nmention minions work release here\nEOF\n)"',
    'git commit -F - <<EOF\nminions work claim stuff\nEOF',
    'grep -rn "minions work run" docs | head',
    "rg 'minions work (run|claim|release)' src",
    'timeout 60 npm test -- -t "minions work run"',
    'npx vitest run test/runtime/pre-bash-hook.test.ts -t "denies minions work release"',
    "sed -i 's/minions work run/x/' notes.md",
    'git grep -n "cli.js work run"',
    'git commit -m "unbalanced',
    'minions work cancel lease-1',
  ])('allows %j', (cmd) => {
    expect(coordinatorOnlyWorkCommand(cmd)).toBeNull();
  });

  it.each([
    'cat <<EOF; minions work run l\nbody\nEOF',
    'cat <<-EOF\n\tbody\n\tEOF\nminions work run l',
    'cat <<EOF\n$(minions work run l)\nEOF',
    'echo "${x:-$(minions work run l)}"',
    'cat <(minions work claim t)',
    'minions work run l<<<x',
    'minions 2>&1 work run l',
    'minions work 2>/dev/null run l',
    'xargs minions work release <<< l',
    'f() { minions work run l; }; f',
    'case x in x) minions work run l;; esac',
    'for i in 1; do minions work run l; done',
    '/bin/bash -lc "minions work release l"',
    'su -c "minions work run l"',
    'node dist/cli.mjs work run l',
    'minions\twork\trun l',
    'git commit -m "minions work run',
  ])('denies %j', (cmd) => {
    expect(coordinatorOnlyWorkCommand(cmd)).toMatch(/^minions work (run|claim|release)$/);
  });

  it.fails('KNOWN GAP: an arithmetic shift (<<) is read as a heredoc and hides the following lines', () => {
    // bash runs `(( … << … ))` and `$(( … << … ))` as arithmetic, then the next line; the scanner skips it as a body.
    expect(coordinatorOnlyWorkCommand('(( x = 1 << 2 ))\nminions work run l')).toBe('minions work run');
    expect(coordinatorOnlyWorkCommand('echo $(( 1 << 2 ))\nminions work run l')).toBe('minions work run');
    expect(coordinatorOnlyWorkCommand('x=$((1<<2))\nminions work release l')).toBe('minions work release');
  });

  it.fails('KNOWN GAP: a `function name { … }` definition body is not in command position', () => {
    expect(coordinatorOnlyWorkCommand('function f { minions work run l; }; f')).toBe('minions work run');
  });

  it.fails('KNOWN GAP: a script fed to a shell on stdin (heredoc or pipe) is not scanned', () => {
    expect(coordinatorOnlyWorkCommand('bash <<EOF\nminions work run l\nEOF')).toBe('minions work run');
    expect(coordinatorOnlyWorkCommand('echo minions work run l | bash')).toBe('minions work run');
  });
});
