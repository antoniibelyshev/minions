// task-130: no auto-promotion caps. The coordinator's own ideas (agent-hypothesis) go to ready through
// `minions backlog update|create` with no owner message on record, and an old config that still carries
// routine.autoPromote loads (runtime mode, temp state, the real Backlog.md CLI). Skipped where the backlog CLI is
// not installed.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { writeBacklogConfig } from '../../src/backlog/factory.js';
import { buildProgram } from '../../src/program.js';
import { lastOwnerMessageAt } from '../../src/runtime/coordinator-usage.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { defaults } from '../helpers.js';

const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'backlog')));

let state: string;
let db: RuntimeDb;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'minions-own-ideas-'));
  for (const k of ENV) saved[k] = process.env[k];
  const config = join(state, 'config.json');
  const cfg = defaults();
  cfg.communication.channel = 'telegram';
  cfg.routine = { autoPromote: { perDay: 0 } }; // legacy block of the removed caps: accepted and ignored
  writeFileSync(config, JSON.stringify(cfg));
  await writeBacklogConfig(join(state, 'backlog'));
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config });
  db = new RuntimeDb(join(state, 'minions.db'));
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(state, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ out: string; code: number; body: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; hint?: string } } }> {
  const program = buildProgram();
  let out = '';
  const capture = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } });
    cmd.commands.forEach(capture);
  };
  capture(program);
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const sink = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  const exit = process.exit.bind(process);
  process.exit = ((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as typeof process.exit;
  const before = process.exitCode;
  let code = 0;
  try {
    await program.parseAsync(['node', 'minions', ...args, '--json']);
    code = process.exitCode === before ? 0 : Number(process.exitCode);
  } catch (err) {
    code = (err as { exitCode?: number }).exitCode ?? 1;
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    process.exit = exit;
    process.exitCode = before;
  }
  let body = { ok: false } as Awaited<ReturnType<typeof cli>>['body'];
  try { body = JSON.parse(out); } catch { /* not JSON */ }
  return { out, code, body };
}

const create = async (key: string, extra: string[] = []) => {
  const r = await cli(['backlog', 'create', '--title', `Idea ${key}`, '--provenance', 'agent-hypothesis', '--key', key, ...extra]);
  expect(r.code, r.out).toBe(0);
  return (r.body.data as { task: { id: string } }).task.id;
};
const show = async (id: string) => (await cli(['backlog', 'show', id])).body.data as { status: string; version: string };
const toReady = async (id: string, extra: string[] = []) => cli(['backlog', 'update', id, '--expected-version', (await show(id)).version, '--status', 'ready', ...extra]);

describe.runIf(onPath)('backlog update|create on agent ideas: no caps', () => {
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
