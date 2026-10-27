// Task-72: Claude subagent workers run as the coordinator's uid, so the OS lets them write the runtime state
// (minions.db, backlog, briefs, results). The plugin hooks refuse it: pre-file for the file tools (exact, through
// symlinks) and pre-bash for Bash (a best-effort text check, plus a worker allowlist of minions commands).
// Nothing here touches the live /state: every real file lives in a temp copy.
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/program.js';
import {
  MINIONS_COMMANDS, PRE_BASH_HOOK_COMMAND, PRE_FILE_READ_HOOK_COMMAND, PRE_FILE_WRITE_HOOK_COMMAND, preBashHook, preFileHook, runHook,
  withoutSubmitBodies, workerMinionsCommand,
} from '../../src/runtime/hooks.js';
import { scanShell } from '../../src/runtime/shell-scan.js';
import { bashStateReference, protectedStatePath, resolveReal, stateGuard } from '../../src/runtime/state-guard.js';
import { containerStateDenies, coordinatorSettings } from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults, FAKE_MINIONS, runHookCommand } from '../helpers.js';

const tmp = mkdtempSync(join(tmpdir(), 'minions-state-guard-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A copy of the state layout under a temp dir, a worktree next to it, and the container-style guard.
const state = join(tmp, 'state');
const worktree = join(tmp, 'workspace', 'worktrees', 'task-1');
for (const d of [join(state, 'backlog', 'backlog'), join(state, 'briefs'), join(state, 'results'), join(state, 'cache', 'tmp', 'leases', 'lease-1'), worktree]) mkdirSync(d, { recursive: true });
writeFileSync(join(state, 'minions.db'), 'db');
const host = stateGuard({ state, tmp: join(state, 'cache', 'tmp') });
const container = stateGuard({ state: '/state', tmp: '/home/node/.cache/tmp' });

const sub = { agent_id: 'agent-1', agent_type: 'minions:engineer' };
const bash = (command: unknown, extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const file = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = sub) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: worktree, ...extra });
const decision = (o: { stdout?: string }) => (o.stdout ? (JSON.parse(o.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : null);
const denied = (o: { stdout?: string }) => decision(o)?.permissionDecision === 'deny';

describe('evidence: the runtime state is writable by the shared uid (temp copy)', () => {
  it('a process of the same uid can write the DB file: only the hooks stand between a Claude worker and it', () => {
    // The live /state is node-owned (minions.db 0644, dirs 0755) and every Claude worker runs as node; this
    // reproduces it on a copy and proves the write itself is not refused by the OS.
    writeFileSync(join(state, 'minions.db'), 'forged');
    expect(readFileSync(join(state, 'minions.db'), 'utf8')).toBe('forged');
  });
});

describe('protectedStatePath', () => {
  it('covers the DB, backlog, briefs and results, as written and relative to cwd', () => {
    for (const p of [state, join(state, 'minions.db'), join(state, 'minions.db-wal'), join(state, 'backlog', 'backlog', 'task-1.md'), join(state, 'briefs', 'lease-1.json'), join(state, 'results', 'x.json'), `${state}/../state/minions.db`, `/${state}`]) {
      expect(protectedStatePath(p, worktree, host)).toBe(true);
    }
    expect(protectedStatePath('../../../state/minions.db', worktree, host)).toBe(true);
  });

  it('leaves the worktree, the scratch dir and the host tool caches open', () => {
    for (const p of [join(worktree, 'src', 'a.ts'), 'src/a.ts', join(state, 'cache', 'tmp', 'leases', 'lease-1', 'r.json'), join(state, 'cache', 'npm', 'x'), `${state}ful/x`]) {
      expect(protectedStatePath(p, worktree, host)).toBe(false);
    }
  });

  it('follows symlinks: a link in the worktree to the DB, to a state dir, or dangling into it', () => {
    symlinkSync(join(state, 'minions.db'), join(worktree, 'db-link'));
    symlinkSync(join(state, 'backlog'), join(worktree, 'bl-link'));
    symlinkSync(join(state, 'briefs', 'new.json'), join(worktree, 'dangling'));
    expect(protectedStatePath(join(worktree, 'db-link'), worktree, host)).toBe(true);
    expect(protectedStatePath('bl-link/backlog/task-9.md', worktree, host)).toBe(true);
    expect(protectedStatePath('dangling', worktree, host)).toBe(true);
    expect(resolveReal(join(worktree, 'dangling'))).toBe(resolveReal(join(state, 'briefs', 'new.json')));
  });

  it('a search over a directory that holds the state dir counts only with ancestor', () => {
    expect(protectedStatePath(tmp, worktree, host)).toBe(false);
    expect(protectedStatePath(tmp, worktree, host, { ancestor: true })).toBe(true);
    expect(protectedStatePath(worktree, worktree, host, { ancestor: true })).toBe(false);
  });
});

describe('bashStateReference', () => {
  it.each([
    'sqlite3 /state/minions.db "update tasks set pr_url=1"',
    `node -e "require('fs').writeFileSync('/state/minions.db', '')"`,
    'cd /state && sqlite3 minions.db .dump',
    'cp forged.md /state/backlog/backlog/task-1.md',
    'ls //state/briefs',
    'cat /tmp/../state/briefs/lease-1.json',
    'echo x > /state/results/lease-1.json',
    'sqlite3 "$MINIONS_STATE_DIR/minions.db"',
    'ls ${MINIONS_STATE_DIR}',
    'MINIONS_STATE_DIR=/state node dist/cli.js backlog update task-1',
    'grep -r "/state" src',
  ])('container: refers to the state in %s', (cmd) => {
    expect(bashStateReference(cmd, container)).not.toBeNull();
  });

  it.each([
    'npm test',
    'ls /workspace/state src/state',
    'cat /statefile /x/stated',
    'vi src/runtime/state-guard.ts && cat /workspace/worktrees/t/src/runtime/state-guard.ts',
    'TMPDIR=/home/node/.cache/tmp/leases/lease-1 npm test',
    'MINIONS_STATE_DIR=$TMPDIR/s node dist/cli.js setup',
  ])('container: no reference in %s', (cmd) => {
    expect(bashStateReference(cmd, container)).toBeNull();
  });

  it('host layout: the state dir by full path or ~, but not its scratch dir or caches', () => {
    expect(bashStateReference(`sqlite3 ${state}/minions.db`, host)).toBe(`${state}/minions.db`);
    expect(bashStateReference(`cat '${state}/briefs/lease-1.json'`, host)).not.toBeNull();
    expect(bashStateReference('cat ~/p/state/minions.db', stateGuard({ state: '/home/u/p/state', tmp: '/home/u/p/state/cache/tmp' }), '/home/u')).toBe('~/p/state/minions.db');
    expect(bashStateReference(`TMPDIR=${state}/cache/tmp/leases/lease-1 npm test`, host)).toBeNull();
    expect(bashStateReference(`npm_config_cache=${state}/cache/npm npm ci`, host)).toBeNull();
  });
});

describe('exempt subtrees lead nowhere into the state (QA attempt 2)', () => {
  it('<state>/cache is exempt only when the scratch root is inside the state dir', () => {
    expect(host.exempt).toEqual(expect.arrayContaining([join(state, 'cache'), join(state, 'cache', 'tmp')]));
    expect(container.exempt.some((e) => e === '/state' || e.startsWith('/state/'))).toBe(false);
    expect(protectedStatePath('/state/cache/npm/x', '/', container)).toBe(true);
    expect(bashStateReference('ls /state/cache', container)).toBe('/state/cache');
  });

  it('host: a symlink in the scratch dir or cache to the DB or a state dir is refused, in Bash and the file tools', () => {
    symlinkSync(join(state, 'minions.db'), join(state, 'cache', 'tmp', 'db-sym'));
    symlinkSync('../../backlog', join(state, 'cache', 'tmp', 'bl-sym'));
    symlinkSync('../minions.db', join(state, 'cache', 'db-rel'));
    for (const p of [join(state, 'cache', 'tmp', 'db-sym'), join(state, 'cache', 'tmp', 'bl-sym', 'backlog', 'task-1.md'), join(state, 'cache', 'db-rel')]) {
      expect(bashStateReference(`sqlite3 ${p} .dump`, host), p).toBe(p);
      expect(denied(preFileHook(file('Write', { file_path: p, content: 'x' }), host)), p).toBe(true);
    }
    // A link inside the exempt tree that stays there is fine.
    writeFileSync(join(state, 'cache', 'tmp', 'plain'), '');
    symlinkSync('plain', join(state, 'cache', 'tmp', 'plain-sym'));
    expect(bashStateReference(`cat ${join(state, 'cache', 'tmp', 'plain-sym')}`, host)).toBeNull();
  });

  it('a hardlink to a state file is refused, in the scratch dir (Bash and file tools) and in the worktree (file tools)', () => {
    linkSync(join(state, 'minions.db'), join(state, 'cache', 'tmp', 'db-hard'));
    writeFileSync(join(state, 'backlog', 'backlog', 'task-1.md'), '# task-1');
    linkSync(join(state, 'backlog', 'backlog', 'task-1.md'), join(worktree, 'task-hard.md'));
    expect(bashStateReference(`sqlite3 ${join(state, 'cache', 'tmp', 'db-hard')}`, host)).not.toBeNull();
    expect(denied(preFileHook(file('Write', { file_path: join(state, 'cache', 'tmp', 'db-hard'), content: 'x' }), host))).toBe(true);
    expect(denied(preFileHook(file('Edit', { file_path: 'task-hard.md', old_string: 'a', new_string: 'b' }), host))).toBe(true);
    // Two links to a file outside the state are no state file.
    writeFileSync(join(worktree, 'own.txt'), '');
    linkSync(join(worktree, 'own.txt'), join(worktree, 'own-hard.txt'));
    expect(preFileHook(file('Write', { file_path: 'own-hard.txt', content: 'x' }), host).stdout).toBeUndefined();
  });
});

describe('heredoc bodies of minions work submit are data (QA attempt 2)', () => {
  const finding = '{"findings":["workers could write /state/minions.db and /state/briefs"]}';
  it.each([
    `minions work submit lease-1 --role tester --json <<'RESULT'\n${finding}\nRESULT`,
    `cd ${worktree} && minions work submit lease-1 --role engineer --json <<"RESULT"\n${finding}\nRESULT`,
    `node dist/cli.js --json work submit lease-1 --role tester <<-'R'\n\t${finding}\n\tR`,
    `minions work submit lease-1 --role tester --json <<RESULT\n${finding} \$HOME\nRESULT`,
  ])('allows %s', (cmd) => {
    expect(withoutSubmitBodies(cmd)).not.toContain('/state');
    expect(denied(preBashHook(bash(cmd, sub), container))).toBe(false);
  });

  it.each([
    // An unquoted body runs its substitutions.
    'minions work submit lease-1 --role tester --json <<RESULT\n$(sqlite3 /state/minions.db .dump)\nRESULT',
    'minions work submit lease-1 --role tester --json <<RESULT\n`cat /state/briefs/x`\nRESULT',
    // Outside the body, the line is still checked.
    "minions work submit lease-1 --json <<'RESULT' > /state/results/x.json\n{}\nRESULT",
    "minions work submit lease-1 --json <<'RESULT'\n{}\nRESULT\nsqlite3 /state/minions.db .dump",
    "MINIONS_STATE_DIR=/state minions work submit lease-1 --json <<'RESULT'\n{}\nRESULT",
    // Other commands' heredocs are not exempt.
    "cat <<'E' > x.sql\n/state/minions.db\nE",
    "bash <<'E'\nsqlite3 /state/minions.db .dump\nE",
    "minions work brief lease-1 <<'E'\n/state/minions.db\nE",
  ])('refuses %s', (cmd) => {
    expect(denied(preBashHook(bash(cmd, sub), container))).toBe(true);
  });

  it('scanShell reports heredoc body positions and quoting', () => {
    const src = "a <<'X' <<Y\nbody x\nX\nbody y\nY\nb";
    const { heredocs, commands } = scanShell(src);
    expect(heredocs.map((h) => [src.slice(h.start, h.end), h.quoted, h.owner])).toEqual([['body x\n', true, commands[0]], ['body y\n', false, commands[0]]]);
  });
});

describe('workerMinionsCommand (worker allowlist of minions commands)', () => {
  it.each([
    ['minions work record lease-1 --submitted', 'minions work record'],
    ['minions backlog update task-1 --pr-url x', 'minions backlog update'],
    ['minions --json backlog create --title x', 'minions backlog create'],
    ['minions backlog note task-1', 'minions backlog note'],
    ['echo hi | minions notify enqueue --key k', 'minions notify enqueue'],
    ['minions workspace state-import x.tgz --force', 'minions workspace state-import'],
    ['minions sync', 'minions sync'],
    ['minions pause --drain', 'minions pause'],
    ['minions coordinator handoff', 'minions coordinator handoff'],
    ['minions work publish task-1', 'minions work publish'],
    ['minions work cancel --all', 'minions work cancel'],
    ['minions work spend --record 1', 'minions work spend'],
    ['minions work list', 'minions work list'],
    ['node /opt/minions/pkg/dist/cli.js hook pre-bash', 'minions hook pre-bash'],
    ["bash -c 'minions settings set x y'", 'minions settings set'],
    ['MINIONS_STATE_DIR=/x minions work claim t', 'minions work claim'],
  ])('refuses %s', (cmd, hit) => {
    expect(workerMinionsCommand(cmd, container)).toBe(hit);
  });

  it.each([
    'minions work brief lease-1 --role engineer --json',
    'cd /w && minions work submit lease-1 --role engineer --json <<\'RESULT\'\n{}\nRESULT',
    'minions --json work submit lease-1 --role tester --result-file r.json',
    'minions status --json',
    'minions backlog show task-1 --json',
    'minions backlog ready',
    'minions ci status',
    'minions help work',
    'minions --version',
    'minions work --help',
    'minions',
    'npm test',
    'git commit -m "minions sync now refuses workers"',
    'find dist -name cli.js -newer src/x.ts',
    'MINIONS_STATE_DIR=$TMPDIR/s node dist/cli.js workspace setup',
    'env MINIONS_STATE_DIR=/scratch/s node dist/cli.js backlog update t-1',
  ])('allows %s', (cmd) => {
    expect(workerMinionsCommand(cmd, container)).toBeNull();
  });

  it('MINIONS_COMMANDS lists every top-level command and alias of the program (new ones are refused by default)', () => {
    const names = buildProgram().commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names.length).toBeGreaterThan(20);
    for (const n of names) expect(MINIONS_COMMANDS).toContain(n);
  });
});

describe('preBashHook (task-72 additions)', () => {
  it('refuses a subagent naming the state dir or running a state-writing minions command; the coordinator keeps both', () => {
    for (const cmd of ['sqlite3 /state/minions.db .tables', 'minions backlog update task-1 --pr-url x', 'minions work record lease-1']) {
      expect(denied(preBashHook(bash(cmd, sub), container))).toBe(true);
      expect(preBashHook(bash(cmd), container)).toEqual({ reason: 'allow: Bash from the coordinator' });
    }
    expect(decision(preBashHook(bash('cat /state/briefs/x', sub), container))?.permissionDecisionReason).toMatch(/runtime state.*git commit -F/);
    expect(decision(preBashHook(bash('minions sync', sub), container))?.permissionDecisionReason).toMatch(/`minions sync` is coordinator-only.*MINIONS_STATE_DIR=/);
  });

  it('keeps the worker\'s own brief and submit, and ordinary commands', () => {
    for (const cmd of ['minions work brief lease-1 --role engineer --json', 'minions work submit lease-1 --role engineer --json', 'npm test', 'git status']) {
      expect(preBashHook(bash(cmd, sub), container).stdout).toBeUndefined();
    }
  });
});

describe('preFileHook', () => {
  it('refuses subagent writes into the state: Write, Edit, MultiEdit, NotebookEdit, also through a symlink', () => {
    expect(denied(preFileHook(file('Write', { file_path: join(state, 'minions.db'), content: 'x' }), host))).toBe(true);
    expect(denied(preFileHook(file('Edit', { file_path: join(state, 'backlog', 'backlog', 'task-1.md'), old_string: 'a', new_string: 'b' }), host))).toBe(true);
    expect(denied(preFileHook(file('MultiEdit', { file_path: join(state, 'results', 'r.json'), edits: [] }), host))).toBe(true);
    expect(denied(preFileHook(file('NotebookEdit', { notebook_path: join(state, 'briefs', 'n.ipynb'), new_source: '' }), host))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: 'db-link', content: 'x' }), host))).toBe(true);
    expect(decision(preFileHook(file('Write', { file_path: join(state, 'minions.db'), content: 'x' }), host))?.permissionDecisionReason).toMatch(/may not write the minions runtime state/);
  });

  it('refuses subagent reads and searches of the state (Read, Glob path or absolute pattern, Grep over an ancestor)', () => {
    expect(denied(preFileHook(file('Read', { file_path: join(state, 'briefs', 'lease-1.json') }), host))).toBe(true);
    expect(denied(preFileHook(file('Glob', { pattern: '*.json', path: join(state, 'briefs') }), host))).toBe(true);
    expect(denied(preFileHook(file('Glob', { pattern: `${state}/briefs/*.json` }), host))).toBe(true);
    expect(denied(preFileHook(file('Grep', { pattern: 'lease', path: tmp }), host))).toBe(true);
  });

  it('allows the worktree, the scratch dir and searches without a path inside the worktree', () => {
    expect(preFileHook(file('Write', { file_path: join(worktree, 'src', 'a.ts'), content: '' }), host).stdout).toBeUndefined();
    expect(preFileHook(file('Write', { file_path: join(state, 'cache', 'tmp', 'leases', 'lease-1', 'result.json'), content: '' }), host).stdout).toBeUndefined();
    expect(preFileHook(file('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), host).stdout).toBeUndefined();
    expect(preFileHook(file('Grep', { pattern: '/state' }), host).stdout).toBeUndefined();
    expect(preFileHook(file('Glob', { pattern: '**/*.ts' }), host).stdout).toBeUndefined();
    expect(preFileHook(file('Read', { file_path: join(worktree, 'README.md') }), host).stdout).toBeUndefined();
  });

  it('allows the coordinator (no agent_id): it keeps its notes under the state dir', () => {
    expect(preFileHook(file('Write', { file_path: join(state, 'notes', 'status.md'), content: '' }, {}), host)).toEqual({ reason: 'allow: Write from the coordinator' });
    expect(preFileHook(file('Write', { file_path: join(state, 'notes', 'status.md'), content: '' }, { agent_id: null }), host).stdout).toBeUndefined();
  });

  it('fails closed on input it cannot decide; any non-null agent_id is a subagent', () => {
    for (const input of [null, [], 'x', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { tool_name: 'toString', agent_id: 'a' }, file('Write', null), file('Write', {}), file('Write', { file_path: 42 })]) {
      expect(denied(preFileHook(input, host))).toBe(true);
    }
    for (const agent_id of ['', 0, false, {}]) expect(denied(preFileHook(file('Write', { file_path: join(state, 'minions.db') }, { agent_id }), host))).toBe(true);
  });

  it('runHook pre-file uses the runtime state dir from the environment and denies unparseable input', async () => {
    vi.stubEnv('MINIONS_STATE_DIR', state);
    vi.stubEnv('MINIONS_LOG_DIR', join(tmp, 'logs'));
    try {
      const load = async () => { throw new Error('no context'); };
      expect(denied(await runHook('pre-file', load, '{broken'))).toBe(true);
      expect(denied(await runHook('pre-file', load, JSON.stringify(file('Write', { file_path: join(state, 'minions.db'), content: '' }))))).toBe(true);
      expect((await runHook('pre-file', load, JSON.stringify(file('Write', { file_path: join(worktree, 'x'), content: '' })))).stdout).toBeUndefined();
      expect(denied(await runHook('pre-bash', load, JSON.stringify(bash(`sqlite3 ${state}/minions.db`, sub))))).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('the plugin hooks.json file-tool and Bash entries', () => {
  const template = JSON.parse(readFileSync(new URL('../../templates/plugin/hooks/hooks.json', import.meta.url), 'utf8')) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout?: number }[] }[] };
  };
  const entry = (m: string) => template.hooks.PreToolUse.find((h) => h.matcher === m)!.hooks[0]!;

  it('register the documented commands with an entry timeout above the wrapper timeout', () => {
    expect(entry('Edit|MultiEdit|Write|NotebookEdit').command).toBe(PRE_FILE_WRITE_HOOK_COMMAND);
    expect(entry('Read|Glob|Grep').command).toBe(PRE_FILE_READ_HOOK_COMMAND);
    expect(entry('Bash').command).toBe(PRE_BASH_HOOK_COMMAND);
    for (const m of ['Edit|MultiEdit|Write|NotebookEdit', 'Read|Glob|Grep']) expect(entry(m).timeout).toBeGreaterThan(20);
  });

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
    expect(runHookCommand(PRE_FILE_READ_HOOK_COMMAND, null, JSON.stringify(file('Read', { file_path: join(worktree, 'a.ts') })))).toMatchObject({ status: 0, stdout: '' });
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(bash('sqlite3 /state/minions.db .dump', sub))).status).toBe(2);
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(bash('ls "$MINIONS_STATE_DIR"', sub))).status).toBe(2);
    expect(runHookCommand(PRE_BASH_HOOK_COMMAND, null, JSON.stringify(bash('sqlite3 /state/minions.db .dump')))).toMatchObject({ status: 0, stdout: '' });
  });
});

describe('coordinator settings (container): Edit denies for the state only minions writes', () => {
  it('deny the DB, backlog, briefs, results and run records but not the coordinator notes', () => {
    const deny = containerStateDenies('/state');
    expect(deny).toEqual(expect.arrayContaining(['Edit(//state/minions.db)', 'Edit(//state/minions.db-*)', 'Edit(//state/backlog/**)', 'Edit(//state/briefs/**)', 'Edit(//state/results/**)', 'Edit(//state/run/**)']));
    expect(deny.some((r) => r.includes('notes'))).toBe(false);
    const s = coordinatorSettings(defaults(), { host: null, auth: 'login' }) as { permissions: { deny: string[] } };
    expect(s.permissions.deny).toEqual(expect.arrayContaining(containerStateDenies(runtimePaths().state)));
  });
});
