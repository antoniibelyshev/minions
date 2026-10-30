import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { taskSlug, branchFor } from '../../src/runtime/worktree.js';
import { verifyAnyApproval } from '../../src/core/approval.js';
import { approvalKeys, tmp } from './fixtures.js';

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

// Sensitive-path detection over the gate: publish-gate.test.ts (injected history); end to end: publish.test.ts.
describe('branch names', () => {
  it('hostile task id/title produce a safe branch slug', () => {
    for (const [id, title] of [['task-1', '--upload-pack=evil; rm -rf /'], ['../../x', 'a b..c~^:?*[\\ @{'], ['$(id)', '`x`\n-flag']] as const) {
      const b = branchFor(taskSlug(id, title));
      expect(b).toMatch(/^agent\/[a-z0-9][a-z0-9-]*$/);
    }
  });
});
