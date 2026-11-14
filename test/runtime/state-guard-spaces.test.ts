// Task-114: on every macOS host the state and secrets dirs live under ~/Library/Application Support/…, and the
// Bash text check used to split paths at the space, so a quoted or escaped path into the state passed. These
// tests build that layout (a dir named "Application Support") in a temp dir; nothing touches the live state.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { preBashHook, preFileHook, runHook } from '../../src/runtime/hooks.js';
import { bashStateReference, stateGuard } from '../../src/runtime/state-guard.js';

const tmp = mkdtempSync(join(tmpdir(), 'minions-state-spaces-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const project = join(tmp, 'Library', 'Application Support', 'Minions', 'projects', 'p1');
const state = join(project, 'host', 'state');
const secrets = join(project, 'secrets');
const scratch = join(state, 'cache', 'tmp', 'leases', 'lease-1');
const worktree = join(project, 'host', 'workspace', 'worktrees', 'task-1');
for (const d of [join(state, 'results'), join(state, 'briefs'), scratch, secrets, worktree]) mkdirSync(d, { recursive: true });
writeFileSync(join(state, 'minions.db'), 'db');
writeFileSync(join(secrets, 'github-token'), 'token');
symlinkSync(join(state, 'minions.db'), join(scratch, 'db-sym'));

const host = stateGuard({ state, tmp: join(state, 'cache', 'tmp'), secretsDir: secrets });
/** A path with its spaces backslash-escaped, as a shell user types it. */
const esc = (p: string) => p.replace(/ /g, '\\ ');
const sub = { agent_id: 'agent-1', agent_type: 'minions:engineer' };
const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: worktree, ...sub });
const file = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: worktree, ...sub });
const denied = (o: { stdout?: string }) => !!o.stdout && JSON.parse(o.stdout).hookSpecificOutput.permissionDecision === 'deny';

describe('bashStateReference: a state or secrets dir with a space in its path (task-114)', () => {
  const support = join(tmp, 'Library', 'Application Support');
  it.each([
    // The QA repro: quoted paths into the state.
    `sqlite3 "${state}/minions.db" "update tasks set pr_url=1"`,
    `rm -rf "${state}/results"`,
    `cat '${state}/coordinator-launch.json'`,
    `ls "${state}"`,
    // Backslash-escaped, partly quoted, quoted in the middle, unquoted (split by the shell, refused anyway).
    `sqlite3 ${esc(state)}/minions.db .dump`,
    `cat "${support}"/Minions/projects/p1/host/state/briefs/lease-1.json`,
    `cat ${esc(join(tmp, 'Library'))}/Application" "Support/Minions/projects/p1/host/state/minions.db`,
    `cat ${state}/minions.db`,
    // cd into it, dot-dot and doubled slashes, interpreters and nested shells.
    `cd "${state}" && sqlite3 minions.db .tables`,
    `cat "${join(state, 'cache', '..', 'minions.db')}"`,
    `ls "/${state}/briefs"`,
    `python3 -c "open('${state}/minions.db', 'w')"`,
    `node -e 'require("fs").writeFileSync("${state}/results/x.json", "")'`,
    `bash -c 'sqlite3 "${state}/minions.db" .dump'`,
    `bash -c "cat ${esc(state)}/minions.db"`,
    `echo x > "${state}/results/r.json"`,
    `cp x.md --target-directory="${state}/briefs"`,
    // A heredoc body or a plain mention (fails closed, like a path without spaces).
    `cat <<'E' > x.sql\n${state}/minions.db\nE`,
    // Secrets: the GitHub token, quoted, escaped and through test -r.
    `cat "${secrets}/github-token"`,
    `test -r ${esc(secrets)}/github-token`,
    `wc -c < '${secrets}/github-token'`,
    // A symlink in the scratch dir back to the DB.
    `sqlite3 "${join(scratch, 'db-sym')}" .dump`,
  ])('refers to the state or secrets in %s', (cmd) => {
    expect(bashStateReference(cmd, host)).not.toBeNull();
    expect(denied(preBashHook(bash(cmd), host)), cmd).toBe(true);
  });

  it.each([
    // The worker's own scratch dir (under <state>/cache/tmp on the host) and the host tool caches stay usable.
    `TMPDIR="${scratch}" npm test`,
    `TMPDIR=${esc(scratch)} npm test`,
    `cat '${join(scratch, 'result.json')}'`,
    `cd "${scratch}" && ls`,
    `npm_config_cache="${join(state, 'cache', 'npm')}" npm ci`,
    `mkdir -p "${join(scratch, 'a b', 'c')}"`,
    // The worktree and the rest of the project dir.
    `cd "${worktree}" && npm test`,
    `git -C ${esc(worktree)} status`,
    `ls "${join(project, 'host', 'workspace')}"`,
    // Paths that only resemble the state dir.
    `cat "${state}ful/x"`,
    `cat "/elsewhere${state}/minions.db"`,
    `cat "${secrets}-old/x"`,
  ])('no reference in %s', (cmd) => {
    expect(bashStateReference(cmd, host)).toBeNull();
    expect(denied(preBashHook(bash(cmd), host)), cmd).toBe(false);
  });

  it('~ and $HOME forms of a state dir under a home with "Application Support"', () => {
    const home = join(tmp, 'home');
    const g = stateGuard({ state: join(home, 'Library', 'Application Support', 'M', 'state'), tmp: join(home, 'Library', 'Application Support', 'M', 'state', 'cache', 'tmp') });
    for (const cmd of [
      'cat ~/"Library/Application Support/M/state/minions.db"',
      'cat ~/Library/Application\\ Support/M/state/minions.db',
      'sqlite3 "$HOME/Library/Application Support/M/state/minions.db"',
      'ls "${HOME}/Library/Application Support/M/state"',
    ]) expect(bashStateReference(cmd, g, home), cmd).not.toBeNull();
    expect(bashStateReference('TMPDIR="$HOME/Library/Application Support/M/state/cache/tmp/leases/l" npm test', g, home)).toBeNull();
    expect(bashStateReference('ls "$HOME/Library/Application Support/M"', g, home)).toBeNull();
  });

  it('MINIONS_STATE_DIR and MINIONS_SECRETS_DIR expansions are refused', () => {
    for (const cmd of ['cat "$MINIONS_SECRETS_DIR/github-token"', 'ls ${MINIONS_SECRETS_DIR}', 'sqlite3 "$MINIONS_STATE_DIR/minions.db"']) {
      expect(bashStateReference(cmd, host), cmd).not.toBeNull();
    }
    // The hook's shell filter forwarding such a call spawns a shell: see hook-commands-fail-closed.test.ts (integration).
  });

  it('paths without spaces are refused and allowed as before', () => {
    const plain = stateGuard({ state: '/srv/p/host/state', tmp: '/srv/p/host/state/cache/tmp', secretsDir: '/srv/p/secrets' });
    expect(bashStateReference('sqlite3 /srv/p/host/state/minions.db', plain)).toBe('/srv/p/host/state/minions.db');
    expect(bashStateReference('sqlite3 "/srv/p/host/state/minions.db"', plain)).toBe('/srv/p/host/state/minions.db');
    expect(bashStateReference('cat /srv/p/secrets/github-token', plain)).toBe('/srv/p/secrets/github-token');
    expect(bashStateReference('TMPDIR=/srv/p/host/state/cache/tmp/leases/l npm test', plain)).toBeNull();
    expect(bashStateReference('cat /srv/p/host/workspace/worktrees/t/state.ts', plain)).toBeNull();
  });
});

describe('preFileHook: a state or secrets dir with a space in its path (task-114)', () => {
  it('refuses Read, Write, Edit and Glob into it; allows the scratch dir and the worktree', () => {
    expect(denied(preFileHook(file('Read', { file_path: join(state, 'minions.db') }), host))).toBe(true);
    expect(denied(preFileHook(file('Read', { file_path: join(secrets, 'github-token') }), host))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: join(state, 'results', 'r.json'), content: '' }), host))).toBe(true);
    expect(denied(preFileHook(file('Edit', { file_path: '../../../state/briefs/b.json', old_string: 'a', new_string: 'b' }), host))).toBe(true);
    expect(denied(preFileHook(file('Glob', { pattern: `${state}/briefs/*.json` }), host))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: join(scratch, 'db-sym'), content: '' }), host))).toBe(true);
    expect(denied(preFileHook(file('Write', { file_path: join(scratch, 'result.json'), content: '' }), host))).toBe(false);
    expect(denied(preFileHook(file('Write', { file_path: join(worktree, 'src', 'a.ts'), content: '' }), host))).toBe(false);
  });
});

describe('runHook pre-bash with MINIONS_STATE_DIR="<tmp>/a b/state" (the QA repro)', () => {
  it('denies quoted paths into the state and secrets dirs; allows the scratch dir', async () => {
    const root = join(tmp, 'a b');
    const s = join(root, 'state');
    mkdirSync(join(s, 'results'), { recursive: true });
    vi.stubEnv('MINIONS_STATE_DIR', s);
    vi.stubEnv('MINIONS_SECRETS_DIR', join(root, 'secrets'));
    vi.stubEnv('MINIONS_SCRATCH_DIR', '');
    vi.stubEnv('MINIONS_LOG_DIR', join(tmp, 'logs'));
    try {
      const load = async () => { throw new Error('no context'); };
      const run = async (cmd: string) => denied(await runHook('pre-bash', load, JSON.stringify(bash(cmd))));
      expect(await run(`sqlite3 "${s}/minions.db" .tables`)).toBe(true);
      expect(await run(`rm -rf "${s}/results"`)).toBe(true);
      expect(await run(`cat '${join(root, 'secrets', 'github-token')}'`)).toBe(true);
      expect(await run(`TMPDIR="${join(s, 'cache', 'tmp', 'leases', 'lease-1')}" npm test`)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });
});
