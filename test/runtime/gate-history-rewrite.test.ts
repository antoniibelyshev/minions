// Security (task-71): workers can write the shared .git (refs/replace, info/grafts, shallow, objects/info),
// so the git reads that decide a gate must not see history rewrites. QA showed that
// `git replace <head> <commit with head^'s tree>` emptied the sensitive-path diff and turned an
// awaiting-approval PR into a published one. Real git throughout (temp workspace + temp bare origin).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitFn } from '../../src/runtime/github.js';
import { gateGit, gateGitArgs, gateGitEnv, GATE_HOME } from '../../src/runtime/git-hardening.js';
import { gateChangedPaths, publishTask, type GhFn } from '../../src/runtime/publish.js';
import { git as realGit } from '../../src/runtime/worktree.js';
import { defaults } from '../helpers.js';
import { approvalKeys, commitFile, ghBranchApi, gitSync, makeDefaultEnv, tmp } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';
const TOKEN = 'ghp_' + 'g'.repeat(36);

function put(repo: string, file: string, content: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  gitSync(repo, 'add', '--', file);
}
const commit = (repo: string, msg: string) => { gitSync(repo, 'commit', '-q', '-m', msg); return gitSync(repo, 'rev-parse', 'HEAD'); };
const plainDiff = (repo: string, range: string) => gitSync(repo, 'diff', '--name-only', range);

/** Workspace + bare origin; the branch agent/t changes a workflow on top of the claim base. */
function setup() {
  const repo = join(tmp('minions-gate-rewrite-'), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  put(repo, 'README.md', 'r\n');
  put(repo, '.github/workflows/ci.yml', 'ci: v1\n');
  const base = commit(repo, 'init');
  const bare = join(tmp('minions-gate-rewrite-origin-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitSync(repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(repo, 'config', `url.${bare}.insteadOf`, REMOTE);
  gitSync(repo, 'push', '-q', 'origin', 'main');
  gitSync(repo, 'fetch', '-q', 'origin');
  gitSync(repo, 'checkout', '-q', '-b', 'agent/t');
  put(repo, '.github/workflows/ci.yml', 'evil\n');
  const head = commit(repo, 'touch ci');
  const cfg = defaults();
  cfg.delivery.provider = 'github'; cfg.delivery.mode = 'pull-request';
  const tokenFile = join(tmp(), 'tok'); writeFileSync(tokenFile, TOKEN);
  const keys = approvalKeys();
  const ghCalls: string[][] = [];
  const gh: GhFn = async (args) => {
    const api = ghBranchApi(bare, args); // the verified base read (task-71)
    if (api) return api;
    ghCalls.push(args);
    if (args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: 'https://github.com/acme/demo/pull/9\n', stderr: '' };
  };
  // Workspace git as in production (the container's plain git); the gate's history reader is the default.
  const git: GitFn = (cwd, args, allow) => realGit(cwd, args, allow);
  const publish = () => publishTask({
    config: cfg, task: { id: 'task-1', title: 'T', description: 'd', acceptanceCriteria: [] } as never,
    repo, branch: 'agent/t', head, git, gh, tokenFile, baseShas: [base], approvals: [], approvalPublicKeyFile: keys.publicKeyFile,
    serverUrl: () => bare,
  });
  const gate = () => gateChangedPaths({ git, repo, remote: 'origin', base: 'main', head, branch: 'agent/t', baseShas: [base], sensitivePaths: cfg.sensitivePaths });
  const remoteHead = (ref: string) => { try { return gitSync(bare, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; } };
  return { repo, base, head, publish, gate, ghCalls, remoteHead };
}

/** The QA attack: replace the head with a commit that carries the base's tree. */
function replaceHead(t: ReturnType<typeof setup>) {
  const fake = gitSync(t.repo, 'commit-tree', `${t.head}^^{tree}`, '-p', t.base, '-m', 'innocent');
  gitSync(t.repo, 'replace', t.head, fake);
  expect(plainDiff(t.repo, `${t.base}...${t.head}`)).toBe('');
}

/** A graft giving the base the head as its parent: `base...head` then has the head as merge base. */
function graftBase(t: ReturnType<typeof setup>, file = join(t.repo, '.git', 'info', 'grafts')) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${t.base} ${t.head}\n`);
  return file;
}

const expectAwaiting = async (t: ReturnType<typeof setup>) => {
  const out = await t.publish();
  expect(out).toMatchObject({ state: 'awaiting-approval', sensitivePaths: ['.github/workflows/ci.yml'] });
  expect(t.remoteHead('refs/heads/agent/t')).toBeNull();
  expect(t.ghCalls).toHaveLength(0);
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('sensitive-path gate ignores history rewrites in the shared .git (task-71)', () => {
  it('baseline: without a rewrite the sensitive PR waits for approval', async () => {
    await expectAwaiting(setup());
  });

  it('a replace ref (git replace <head> <commit with the base tree>) does not hide the sensitive change', async () => {
    const t = setup();
    replaceHead(t);
    expect(await t.gate()).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
    await expectAwaiting(t);
  });

  it('a replace ref on the base (base replaced by a commit with the head tree) does not hide it either', async () => {
    const t = setup();
    const fake = gitSync(t.repo, 'commit-tree', `${t.head}^{tree}`, '-m', 'base lookalike');
    gitSync(t.repo, 'replace', t.base, fake);
    expect(await t.gate()).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
    await expectAwaiting(t);
  });

  it('a graft file in the git dir does not hide the sensitive change', async () => {
    const t = setup();
    graftBase(t);
    expect(execFileSync('git', ['diff', '--name-only', `${t.base}...${t.head}`], { cwd: t.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()).toBe('');
    expect(await t.gate()).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
    await expectAwaiting(t);
  });

  it('a shallow file in the git dir does not change the answer', async () => {
    const t = setup();
    writeFileSync(join(t.repo, '.git', 'shallow'), `${t.head}\n`);
    expect(await t.gate()).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
    await expectAwaiting(t);
  });

  it('GIT_* variables in the minions process (graft file, replace ref base, config parameters, git dir) have no effect', async () => {
    const t = setup();
    const other = join(tmp('minions-gate-rewrite-other-'), 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    const graft = graftBase(t, join(tmp('minions-gate-rewrite-graft-'), 'grafts'));
    // Replacements under a custom ref namespace that only GIT_REPLACE_REF_BASE would activate.
    const fake = gitSync(t.repo, 'commit-tree', `${t.head}^^{tree}`, '-p', t.base, '-m', 'innocent');
    gitSync(t.repo, 'update-ref', `refs/evil/${t.head}`, fake);
    vi.stubEnv('GIT_GRAFT_FILE', graft);
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/evil/');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'core.usereplacerefs'='true'");
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.useReplaceRefs');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    vi.stubEnv('GIT_NO_REPLACE_OBJECTS', '');
    vi.stubEnv('GIT_OBJECT_DIRECTORY', join(other, '.git', 'objects'));
    expect(await t.gate()).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    expect(await t.gate()).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
  });

  it('repository config cannot re-enable replace refs or the commit graph for the gate', async () => {
    const t = setup();
    replaceHead(t);
    gitSync(t.repo, 'config', 'core.useReplaceRefs', 'true');
    gitSync(t.repo, 'config', 'core.commitGraph', 'true');
    gitSync(t.repo, 'config', 'diff.external', '/usr/bin/false');
    expect(await t.gate()).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
  });
});

describe('scheduler gate reads ignore history rewrites (task-71)', () => {
  it('the QA requirement still sees a sensitive change hidden by a replace ref', async () => {
    const env = makeDefaultEnv();
    env.backlog.add({ id: 'task-1' });
    const b = await env.sched.claim('task-1', 'engineer');
    mkdirSync(join(b.worktree, '.github', 'workflows'), { recursive: true });
    const head = commitFile(b.worktree, '.github/workflows/ci.yml', 'evil\n');
    const fake = gitSync(b.worktree, 'commit-tree', `${head}^^{tree}`, '-p', `${head}^`, '-m', 'innocent');
    gitSync(b.worktree, 'replace', head, fake);
    expect(plainDiff(b.worktree, `${head}^...${head}`)).toBe('');
    const req = await env.sched.qaRequirement(env.backlog.tasks.get('task-1')!, head);
    expect(req.reasons.join()).toMatch(/sensitive paths \(\.github\/workflows\/ci\.yml\)/);
  });
});

describe('gateGit (task-71)', () => {
  it('runs with replace objects, grafts, shallow and commit graph off and only allowlisted variables', async () => {
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    await gateGit('/repo', ['diff', '--name-only', 'a...b'], true, {
      env: { PATH: '/usr/bin', HOME: '/home/agent', XDG_CONFIG_HOME: '/x', GIT_DIR: '/evil', GIT_GRAFT_FILE: '/evil/g', GIT_CONFIG_PARAMETERS: "'a'='b'", GIT_NO_REPLACE_OBJECTS: '' },
      run: async (_c, args, o) => { seen.push({ args, env: o.env }); return { code: 0, stdout: '', stderr: '' }; },
    });
    const { args, env } = seen[0]!;
    expect(args.slice(-3)).toEqual(['diff', '--name-only', 'a...b']);
    for (const c of ['core.useReplaceRefs=false', 'core.commitGraph=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'diff.external=']) {
      expect(args[args.indexOf(c) - 1]).toBe('-c');
    }
    expect(env).toMatchObject({
      GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null', GIT_SHALLOW_FILE: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1', HOME: GATE_HOME, PATH: '/usr/bin',
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });

  it('gateGitArgs ends with --no-pager and gateGitEnv keeps no inherited GIT_* variable', () => {
    expect(gateGitArgs().at(-1)).toBe('--no-pager');
    const env = gateGitEnv({ PATH: '/bin', GIT_WORK_TREE: '/w', GIT_COMMON_DIR: '/c', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/a' });
    expect(Object.keys(env).filter((k) => k.startsWith('GIT_')).sort()).toEqual([
      'GIT_ASKPASS', 'GIT_ATTR_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_GRAFT_FILE', 'GIT_NO_REPLACE_OBJECTS',
      'GIT_OPTIONAL_LOCKS', 'GIT_SHALLOW_FILE', 'GIT_TERMINAL_PROMPT',
    ]);
  });
});
