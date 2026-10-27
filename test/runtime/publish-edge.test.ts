import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { git as realGit, taskSlug, branchFor } from '../../src/runtime/worktree.js';
import { gateChangedPaths, publishTask, type GhFn } from '../../src/runtime/publish.js';
import { verifyAnyApproval } from '../../src/core/approval.js';
import type { GitFn } from '../../src/runtime/github.js';
import { defaults } from '../helpers.js';
import { approvalKeys, commitFile, ghBranchApi, gitSync, tmp } from './fixtures.js';

const TOKEN = 'ghp_' + 'b'.repeat(36);

function openRaw(path: string) {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(path);
}

describe('runtime db migration 1 -> 2', () => {
  const v1Db = () => {
    const path = join(tmp(), 'minions.db');
    // Build a genuine v1 database with this build's own code, then roll its schema back.
    const db = new RuntimeDb(path);
    db.sql.exec('DROP TABLE publications; DROP TABLE approvals; ALTER TABLE leases DROP COLUMN harness');
    db.sql.prepare("INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('lease-x','task-1','engineer',1,1,'2026-01-01T00:00:00Z','ended')").run();
    db.setMeta('schema_version', '1');
    db.close();
    return path;
  };

  it('upgrades preserving leases, creates new tables, and is idempotent', () => {
    const path = v1Db();
    const db = new RuntimeDb(path);
    expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    expect(db.get<{ id: string }>("SELECT id FROM leases WHERE id = 'lease-x'")).toEqual({ id: 'lease-x' });
    const approval = db.addApproval({ task_id: 'task-1', scope: 'publish', head_sha: 'a'.repeat(40), approved_by: 'u', note: null });
    db.close();
    const again = new RuntimeDb(path);
    expect(again.approval('task-1', 'publish', 'a'.repeat(40))?.id).toBe(approval.id);
    expect(again.get<{ id: string }>("SELECT id FROM leases WHERE id = 'lease-x'")).toBeTruthy();
    again.close();
  });

  it('a failing migration rolls back completely and leaves the v1 database intact', () => {
    const path = v1Db();
    const raw = openRaw(path);
    raw.exec('CREATE TABLE approvals (junk TEXT)'); // incompatible: the v2 index on approvals(scope) cannot be created
    raw.close();
    expect(() => new RuntimeDb(path)).toThrow();
    const check = openRaw(path);
    expect((check.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value).toBe('1');
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='publications'").get()).toBeUndefined();
    expect(check.prepare("SELECT id FROM leases WHERE id='lease-x'").get()).toBeTruthy();
    check.close();
  });

  it('a newer schema than the build supports fails clearly (old binary on a v2+ database)', () => {
    const path = join(tmp(), 'minions.db');
    const db = new RuntimeDb(path);
    db.setMeta('schema_version', String(SCHEMA_VERSION + 1));
    db.close();
    expect(() => new RuntimeDb(path)).toThrow(/newer than this build supports/);
  });
});

describe('runtime db migration 2 -> 3 (host-signed approvals)', () => {
  it('adds approvals.signature, keeps existing schema-2 approval rows, and those unsigned rows never verify', () => {
    const path = join(tmp(), 'minions.db');
    // A genuine v2 database with a task-1.4 style (unsigned) approval row.
    const db = new RuntimeDb(path);
    db.sql.exec('ALTER TABLE approvals DROP COLUMN signature; ALTER TABLE leases DROP COLUMN harness');
    db.sql.prepare("INSERT INTO approvals (task_id, scope, head_sha, approved_by, note, recorded_at) VALUES ('task-1', 'publish', ?, 'user', NULL, '2026-01-01T00:00:00Z')").run('a'.repeat(40));
    db.setMeta('schema_version', '2');
    db.close();

    const up = new RuntimeDb(path);
    expect(up.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
    const rows = up.approvals('task-1', 'publish', 'a'.repeat(40));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approved_by: 'user', signature: null });
    const keys = approvalKeys();
    expect(verifyAnyApproval(rows.map((r) => r.signature), keys.publicKeyPem, { taskId: 'task-1', head: 'a'.repeat(40) }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/no host-signed approval/) });
    up.close();
    // Idempotent: reopening does not re-run the ALTER.
    const again = new RuntimeDb(path);
    expect(again.approvals('task-1', 'publish', 'a'.repeat(40))).toHaveLength(1);
    again.close();
  });
});

describe('sensitive path detection and publication argv safety (fake git/gh)', () => {
  /** Real repo with a base commit; diff output is replaced so any path list can be tested. */
  function setup(diffPaths: string[], mutate?: (c: ReturnType<typeof defaults>) => void) {
    const repo = join(tmp(), 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    gitSync(repo, 'config', 'user.email', 't@e.st'); gitSync(repo, 'config', 'user.name', 't');
    const baseSha = commitFile(repo, 'base.txt', 'base');
    gitSync(repo, 'checkout', '-q', '-b', 'agent/t');
    const head = commitFile(repo, 'x.txt', 'x');
    // The server: a bare repository with main at the base, reached only through the serverUrl seam (task-71).
    const bare = join(tmp(), 'demo.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    gitSync(repo, 'push', '-q', bare, `${baseSha}:refs/heads/main`);
    const cfg = defaults();
    cfg.delivery.provider = 'github'; cfg.delivery.mode = 'pull-request';
    mutate?.(cfg);
    const tokenFile = join(tmp(), 'tok'); writeFileSync(tokenFile, TOKEN);
    const calls: string[][] = [];
    const git: GitFn = async (cwd, args, allow) => {
      calls.push(args);
      if (args[0] === 'config' && args[1] === '--get') return { code: 0, stdout: 'https://github.com/acme/demo.git\n', stderr: '' };
      if (args[0] === 'diff') return { code: 0, stdout: diffPaths.join('\0') + '\0', stderr: '' };
      return realGit(cwd, args, allow);
    };
    const ghCalls: { args: string[]; input?: string; cwd?: string }[] = [];
    const gh: GhFn = async (args, opts) => {
      const api = ghBranchApi(bare, args);
      if (api) return api;
      ghCalls.push({ args, input: opts?.input, cwd: opts?.cwd });
      if (args[1] === 'list') return { code: 0, stdout: '[]', stderr: '' };
      return { code: 0, stdout: 'https://github.com/acme/demo/pull/9\n', stderr: '' };
    };
    const keys = approvalKeys();
    const run = (humanApproved = false, title = 'T', baseShas: (string | null)[] = [baseSha]) => publishTask({
      config: cfg, task: { id: 'task-1', title, description: 'd', acceptanceCriteria: [] } as never,
      repo, branch: 'agent/t', head, git, gateGit: git, gh, tokenFile, baseShas, serverUrl: () => bare,
      approvals: humanApproved ? [keys.sign('task-1', head)] : [], approvalPublicKeyFile: keys.publicKeyFile,
    });
    const remoteHead = (ref: string) => { try { return gitSync(bare, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; } };
    return { run, calls, ghCalls, repo, bare, head, git, cfg, remoteHead };
  }

  const sensitive: [string, string[]][] = [
    ['nested migrations dir', ['svc/api/migrations/0001.sql']],
    ['top-level migrations dir', ['migrations/0001.sql']],
    ['dotfile-dir .claude', ['.claude/settings.json']],
    ['CLAUDE.md', ['CLAUDE.md']],
    ['deleted workflow (diff lists deletions)', ['.github/workflows/ci.yml']],
    ['rename out of a sensitive path (old side listed with --no-renames)', ['.github/workflows/ci.yml', 'docs/ci.yml']],
    ['deploy tree', ['deploy/k8s/app.yaml']],
    ['CODEOWNERS', ['.github/CODEOWNERS']],
    ['one sensitive among many', ['a.ts', 'b.ts', 'infra/main.tf']],
  ];
  for (const [name, paths] of sensitive) {
    it(`requires human approval: ${name}`, async () => {
      const t = setup(paths);
      const out = await t.run(false);
      expect(out.state).toBe('awaiting-approval');
      expect(t.remoteHead('refs/heads/agent/t')).toBeNull();
      expect(t.ghCalls).toHaveLength(0);
      expect((await t.run(true)).state).toBe('published');
    });
  }

  const benign: [string, string[]][] = [
    ['file merely named migrations.md', ['docs/migrations.md']],
    ['migrations-like prefix', ['migrations_old/readme.md']],
    ['.github non-sensitive file', ['.github/ISSUE_TEMPLATE/bug.md']],
    ['claude-ish name', ['src/claude.md', 'CLAUDE.md.bak']],
    ['deploys', ['deployment/x.yaml']],
  ];
  for (const [name, paths] of benign) {
    it(`does not gate non-sensitive: ${name}`, async () => {
      const t = setup(paths);
      const out = await t.run(false);
      expect(out.state).toBe('published');
    });
  }

  it('argv: pushes an explicit sha refspec without force; title starting with "-" cannot become a flag; body via stdin', async () => {
    const t = setup(['a.ts']);
    const out = await t.run(false, '--web --force-evil');
    expect(out.state).toBe('published');
    // The push (isolated, explicit URL) lands exactly the approved head; the workspace git never pushes.
    expect(t.remoteHead('refs/heads/agent/t')).toBe(t.head);
    expect(t.calls.some((a) => a[0] === 'push' || a[0] === 'ls-remote')).toBe(false);
    const create = t.ghCalls.find((c) => c.args[1] === 'create')!;
    const i = create.args.indexOf('--title');
    expect(create.args[i + 1]).toBe('--web --force-evil'); // a separate argv value after --title, never parsed as its own option
    expect(create.args.filter((a) => a === '--web')).toHaveLength(0);
    expect(create.args).toContain('--body-file');
    expect(create.input).toMatch(/^d\n/);
    expect(t.ghCalls.some((c) => c.args.includes('merge'))).toBe(false);
  });

  it('host runtime: no ls-remote or push through the workspace git; the server reads deny the file transport (fail closed)', async () => {
    const prev = process.env.MINIONS_RUNTIME;
    process.env.MINIONS_RUNTIME = 'host';
    try {
      const t = setup(['a.ts']);
      // The seam points at a local bare repository, which the host's network hardening refuses: nothing is published.
      expect(await t.run(false)).toMatchObject({ state: 'failed', message: expect.stringMatching(/could not be read from https:\/\/github\.com\/acme\/demo\.git/) });
      expect(t.calls.some((a) => a[0] === 'push' || a[0] === 'ls-remote')).toBe(false);
      expect(t.remoteHead('refs/heads/agent/t')).toBeNull();
      expect(t.ghCalls).toHaveLength(0);
    } finally { if (prev === undefined) delete process.env.MINIONS_RUNTIME; else process.env.MINIONS_RUNTIME = prev; }
  });

  it('fails closed without a verified server base: gh reports no base branch, or the gate gets no server base and no usable recorded base', async () => {
    const t = setup(['a.ts']);
    gitSync(t.bare, 'update-ref', '-d', 'refs/heads/main'); // origin has no main (GitHub says 404)
    expect(await t.run(false)).toMatchObject({ state: 'failed', message: expect.stringMatching(/cannot verify origin's main with the GitHub API/) });
    expect(t.remoteHead('refs/heads/agent/t')).toBeNull();
    expect(t.ghCalls).toHaveLength(0);
    // The gate itself (also the merge gate's): refs/heads/main exists, but local refs alone never suffice.
    for (const baseShas of [[], [null], ['f'.repeat(40)], ['main'], ['HEAD~1']]) {
      const g = await gateChangedPaths({ gateGit: t.git, repo: t.repo, base: 'main', head: t.head, branch: 'agent/t', baseShas, sensitivePaths: t.cfg.sensitivePaths });
      expect(g, JSON.stringify(baseShas)).toMatchObject({ ok: false, code: 'PRECONDITION', message: expect.stringMatching(/No trustworthy base/) });
    }
  });

  it('hostile task id/title produce a safe branch slug', () => {
    for (const [id, title] of [['task-1', '--upload-pack=evil; rm -rf /'], ['../../x', 'a b..c~^:?*[\\ @{'], ['$(id)', '`x`\n-flag']] as const) {
      const b = branchFor(taskSlug(id, title));
      expect(b).toMatch(/^agent\/[a-z0-9][a-z0-9-]*$/);
      expect(() => execFileSync('git', ['check-ref-format', `refs/heads/${b}`])).not.toThrow();
    }
  });
});
