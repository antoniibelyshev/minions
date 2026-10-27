// QA (task-40, item 2): unrelated / orphan base history in the sensitive-path gate, shared by
// publication and the merge gate. Real git throughout (temp workspace + temp bare origin); never the
// live /state or DB. Complements publish-base.test.ts, which drives publishTask with recorded bases.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitFn } from '../../src/runtime/github.js';
import { evaluateMergeGate } from '../../src/runtime/merge.js';
import { gateChangedPaths } from '../../src/runtime/publish.js';
import { git as realGit } from '../../src/runtime/worktree.js';
import { gateGit as realGateGit } from '../../src/runtime/git-hardening.js';
import { defaults } from '../helpers.js';
import { gitSync, tmp } from './fixtures.js';

const REMOTE = 'https://github.com/acme/demo.git';

function put(repo: string, file: string, content: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
  gitSync(repo, 'add', '--', file);
}
const commit = (repo: string, msg: string) => { gitSync(repo, 'commit', '-q', '-m', msg); return gitSync(repo, 'rev-parse', 'HEAD'); };

function setup() {
  const repo = join(tmp('minions-gate-qa-'), 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  put(repo, 'README.md', 'r\n');
  put(repo, '.github/workflows/ci.yml', 'ci: v1\n');
  const claimBase = commit(repo, 'init');
  const bare = join(tmp('minions-gate-qa-origin-'), 'demo.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  gitSync(repo, 'remote', 'add', 'origin', REMOTE);
  gitSync(repo, 'config', `url.${bare}.insteadOf`, REMOTE);
  gitSync(repo, 'push', '-q', 'origin', 'main');
  gitSync(repo, 'fetch', '-q', 'origin');
  gitSync(repo, 'checkout', '-q', '-b', 'agent/t');
  const calls: string[][] = [];
  const git: GitFn = async (cwd, args, allow) => { calls.push(args); return realGit(cwd, args, allow); };
  const gateGit: GitFn = async (cwd, args, allow) => { calls.push(args); return realGateGit(cwd, args, allow); };
  const gate = (head: string, baseShas: (string | null)[]) => gateChangedPaths({
    git, gateGit, repo, remote: 'origin', base: 'main', head, branch: 'agent/t', baseShas, sensitivePaths: defaults().sensitivePaths,
  });
  return { repo, bare, claimBase, calls, gate };
}

describe('sensitive-path gate: unrelated base history (task-40 QA)', () => {
  it('origin\'s base force-pushed to an orphan commit fails closed with PRECONDITION, even with a good recorded base', async () => {
    const t = setup();
    put(t.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(t.repo, 'touch ci');
    // An orphan with the head's exact tree: a plain two-dot diff against it would be empty.
    const orphan = gitSync(t.repo, 'commit-tree', `${head}^{tree}`, '-m', 'orphan');
    gitSync(t.repo, 'push', '-q', '-f', 'origin', `${orphan}:refs/heads/main`);
    const out = await t.gate(head, [t.claimBase]);
    expect(out).toMatchObject({ ok: false, code: 'PRECONDITION', message: expect.stringMatching(/unrelated history/) });
    // No diff was evaluated against the unrelated base (the gate stops before any partial result).
    expect(t.calls.some((a) => a[0] === 'diff' && a.some((x) => x.startsWith(orphan)))).toBe(false);
  });

  it('a fully orphan branch (no shared history with any base) fails closed with PRECONDITION', async () => {
    const t = setup();
    gitSync(t.repo, 'checkout', '-q', '--orphan', 'agent/orphan');
    gitSync(t.repo, 'rm', '-rq', '--cached', '.');
    put(t.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(t.repo, 'orphan branch');
    expect(await t.gate(head, [t.claimBase])).toMatchObject({ ok: false, code: 'PRECONDITION' });
  });

  it('related history still evaluates normally and reports the sensitive change', async () => {
    const t = setup();
    put(t.repo, '.github/workflows/ci.yml', 'evil\n');
    const head = commit(t.repo, 'touch ci');
    expect(await t.gate(head, [t.claimBase])).toMatchObject({ ok: true, sensitivePaths: ['.github/workflows/ci.yml'] });
  });

  it('the merge gate is never eligible when the path gate failed on unrelated history', async () => {
    const t = setup();
    put(t.repo, 'a.txt', 'harmless');
    const head = commit(t.repo, 'plain');
    const orphan = gitSync(t.repo, 'commit-tree', `${head}^{tree}`, '-m', 'orphan');
    const paths = await t.gate(head, [orphan]);
    expect(paths).toMatchObject({ ok: false, code: 'PRECONDITION' });
    const cfg = defaults();
    cfg.delivery.provider = 'github'; cfg.delivery.mode = 'pull-request';
    const gate = evaluateMergeGate({
      config: cfg, approvedHead: head, reviewed: true, ci: { state: 'pass' } as never,
      pr: { isDraft: false, isCrossRepository: false, baseRefName: 'main', headRefOid: head } as never,
      paths: paths as { ok: false; message: string }, approval: () => ({ ok: true }),
    });
    expect(gate.state).not.toBe('eligible');
    expect(gate.reasons.join(' ')).toMatch(/sensitive-path gate: .*unrelated history/);
  });
});
