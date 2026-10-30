// task-130: no auto-promotion caps. The coordinator's own ideas (agent-hypothesis) go to ready through
// `minions backlog update|create` with no owner message on record, and an old config that still carries
// routine.autoPromote loads (runtime mode, temp state, an in-memory backlog in place of Backlog.md).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lastOwnerMessageAt } from '../../src/runtime/coordinator-usage.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { defaults } from '../helpers.js';
import { runCli } from './harness.js';

// The CLI runs in-process against an in-memory backlog (no Backlog.md subprocess); see harness.ts.
vi.mock('../../src/backlog/factory.js', async (orig) => (await import('./harness.js')).mockFactory(await orig()));

let state: string;
let db: RuntimeDb;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), 'minions-own-ideas-'));
  for (const k of ENV) saved[k] = process.env[k];
  const config = join(state, 'config.json');
  const cfg = defaults();
  cfg.communication.channel = 'telegram';
  cfg.routine = { autoPromote: { perDay: 0 } }; // legacy block of the removed caps: accepted and ignored
  writeFileSync(config, JSON.stringify(cfg));
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config });
  db = new RuntimeDb(join(state, 'minions.db'));
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(state, { recursive: true, force: true });
});

const cli = runCli;

const create = async (key: string, extra: string[] = []) => {
  const r = await cli(['backlog', 'create', '--title', `Idea ${key}`, '--provenance', 'agent-hypothesis', '--key', key, ...extra]);
  expect(r.code, r.out).toBe(0);
  return (r.body.data as { task: { id: string } }).task.id;
};
const show = async (id: string) => (await cli(['backlog', 'show', id])).body.data as { status: string; version: string };
const toReady = async (id: string, extra: string[] = []) => cli(['backlog', 'update', id, '--expected-version', (await show(id)).version, '--status', 'ready', ...extra]);

describe('backlog update|create on agent ideas: no caps', () => {
  it('no owner message is on record', () => {
    expect(lastOwnerMessageAt(db)).toBeNull();
  });

  it('moves more ideas to ready than any old cap allowed, and to changes-requested', async () => {
    const ids: string[] = [];
    for (const k of ['idea-a', 'idea-b', 'idea-c', 'idea-d', 'idea-e']) ids.push(await create(k));
    for (const id of ids.slice(0, 4)) {
      const r = await toReady(id);
      expect(r.code, r.out).toBe(0);
      expect((await show(id)).status).toBe('ready');
    }
    const cr = await cli(['backlog', 'update', ids[4]!, '--expected-version', (await show(ids[4]!)).version, '--status', 'changes-requested']);
    expect(cr.code, cr.out).toBe(0);
    expect((await show(ids[4]!)).status).toBe('changes-requested');
    expect(db.all('SELECT kind FROM events WHERE kind LIKE ?', 'auto-promote%')).toEqual([]);
  });

  it('creates an agent idea directly as ready', async () => {
    const r = await cli(['backlog', 'create', '--title', 'Direct', '--provenance', 'agent-hypothesis', '--status', 'ready', '--key', 'idea-direct']);
    expect(r.code, r.out).toBe(0);
    expect((await show((r.body.data as { task: { id: string } }).task.id)).status).toBe('ready');
  });

  it('--owner-approved is still accepted, as a no-op', async () => {
    const id = await create('idea-owner');
    const r = await toReady(id, ['--owner-approved']);
    expect(r.code, r.out).toBe(0);
    expect((await show(id)).status).toBe('ready');
    const c = await cli(['backlog', 'create', '--title', 'Owner flag', '--provenance', 'agent-hypothesis', '--status', 'ready', '--owner-approved', '--key', 'idea-owner-create']);
    expect(c.code, c.out).toBe(0);
  });
});
