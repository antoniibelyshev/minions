// `minions backlog create|update --workflow` in runtime mode (temp state, in-memory backlog): configured names only,
// the name lands in the meta block, and a workflow change is refused while the task has an active lease.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RuntimeDb } from '../../src/runtime/db.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';
import { runCli } from './harness.js';

// The CLI runs in-process against an in-memory backlog (no Backlog.md subprocess); see harness.ts.
vi.mock('../../src/backlog/factory.js', async (orig) => (await import('./harness.js')).mockFactory(await orig()));

let state: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), 'minions-wfcli-'));
  for (const k of ENV) saved[k] = process.env[k];
  const config = join(state, 'config.json');
  writeFileSync(config, JSON.stringify({ ...defaults(), workflows: { docs: ['engineer', 'reviewer'] } }));
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config });
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(state, { recursive: true, force: true });
});

const cli = runCli;
const body = (out: string) => JSON.parse(out) as { ok: boolean; data?: Record<string, unknown> & { task?: Record<string, unknown> }; error?: { code: string; message: string } };

describe('backlog --workflow', () => {
  it('create refuses an unconfigured workflow name', async () => {
    const r = await cli(['backlog', 'create', '--title', 'X', '--workflow', 'research', '--key', 'wf-unknown']);
    expect(body(r.out).error).toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/Unknown workflow "research" \(configured: default, docs\)/) });
  });

  it('create stores the name; update is refused while a lease is active and applied after it ends', async () => {
    const c = await cli(['backlog', 'create', '--title', 'Docs task', '--workflow', 'docs', '--status', 'ready', '--key', 'wf-docs']);
    expect(c.code, c.out).toBe(0);
    const task = body(c.out).data!.task as { id: string; workflow?: string; version: string };
    expect(task.workflow).toBe('docs');

    const shown = body((await cli(['backlog', 'show', task.id])).out).data as { workflow?: string; version: string };
    expect(shown.workflow).toBe('docs');

    const unknown = await cli(['backlog', 'update', task.id, '--expected-version', shown.version, '--workflow', 'nope']);
    expect(body(unknown.out).error?.code).toBe('PRECONDITION');

    const db = new RuntimeDb(runtimePaths().db);
    try {
      db.exec(`INSERT INTO leases (id, task_id, role, attempt, holder, branch, config_revision, started_at, status)
        VALUES ('lease-wf', ?, 'engineer', 1, 'test', 'agent/x', 1, ?, 'active')`, task.id, new Date().toISOString());
      const refused = await cli(['backlog', 'update', task.id, '--expected-version', shown.version, '--workflow', 'default']);
      expect(refused.code).toBe(4);
      expect(body(refused.out).error).toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/active stage/) });
      expect((body((await cli(['backlog', 'show', task.id])).out).data as { workflow?: string }).workflow).toBe('docs');

      // A non-workflow update is not affected by the lease check.
      const title = await cli(['backlog', 'update', task.id, '--expected-version', shown.version, '--title', 'Docs task 2']);
      expect(title.code, title.out).toBe(0);
      const v2 = (body(title.out).data as { version: string; workflow?: string });
      expect(v2.workflow).toBe('docs');

      db.exec("UPDATE leases SET status = 'completed', ended_at = ? WHERE id = 'lease-wf'", new Date().toISOString());
      const ok = await cli(['backlog', 'update', task.id, '--expected-version', v2.version, '--workflow', 'default']);
      expect(ok.code, ok.out).toBe(0);
      // An explicit 'default' is stored as the name (it resolves to the default workflow).
      expect((body(ok.out).data as { workflow?: string }).workflow).toBe('default');
    } finally { db.close(); }
  });
});
