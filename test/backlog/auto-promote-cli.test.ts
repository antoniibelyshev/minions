// task-68.6: the auto-promotion caps end to end through `minions backlog update|create` (runtime mode, temp state,
// the real Backlog.md CLI). Skipped where the backlog CLI is not installed.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { writeBacklogConfig } from '../../src/backlog/factory.js';
import { buildProgram } from '../../src/program.js';
import { AUTO_PROMOTE_EVENT, OWNER_PROMOTE_EVENT } from '../../src/runtime/auto-promote.js';
import { LAST_OWNER_MESSAGE_META } from '../../src/runtime/coordinator-usage.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { defaults } from '../helpers.js';

const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'backlog')));

let state: string;
let db: RuntimeDb;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'minions-promote-'));
  for (const k of ENV) saved[k] = process.env[k];
  const config = join(state, 'config.json');
  const cfg = defaults();
  cfg.communication.channel = 'telegram';
  cfg.routine = { autoPromote: { perDay: 2 } };
  writeFileSync(config, JSON.stringify(cfg));
  await writeBacklogConfig(join(state, 'backlog'));
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config });
  db = new RuntimeDb(join(state, 'minions.db'));
  db.setMeta(LAST_OWNER_MESSAGE_META, new Date(Date.now() - 2 * 3_600_000).toISOString()); // 2 h ago
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
const eventIds = (kind: string) => db.eventsOfKindSince(kind, '2000-01-01T00:00:00Z').map((e) => e.taskId);

describe.runIf(onPath)('backlog update|create --status ready on agent ideas (perDay 2)', () => {
  const ids: string[] = [];

  it('promotes two ideas (under the cap) and refuses the third (over it); the refused task stays idea', async () => {
    for (const k of ['idea-a', 'idea-b', 'idea-c']) ids.push(await create(k));
    for (const id of ids.slice(0, 2)) {
      const r = await toReady(id);
      expect(r.code, r.out).toBe(0);
      expect((await show(id)).status).toBe('ready');
    }
    const refused = await toReady(ids[2]!);
    expect(refused.code).toBe(3);
    expect(refused.body.error?.code).toBe('POLICY_DENIED');
    expect(refused.body.error?.message).toMatch(/Auto-promotion refused: .* \(agent-hypothesis\) stays idea: the daily cap is reached: 2 of 2/);
    expect((await show(ids[2]!)).status).toBe('idea');
    expect(eventIds(AUTO_PROMOTE_EVENT)).toEqual(ids.slice(0, 2));
  });

  it('create --status ready for an agent idea is capped too; an owner request is not', async () => {
    const r = await cli(['backlog', 'create', '--title', 'Direct', '--provenance', 'agent-hypothesis', '--status', 'ready', '--key', 'idea-direct']);
    expect(r.body.error?.code).toBe('POLICY_DENIED');
    const owner = await cli(['backlog', 'create', '--title', 'Owner wants', '--provenance', 'user-decision', '--status', 'ready', '--key', 'intake:owner-wants']);
    expect(owner.code, owner.out).toBe(0);
  });

  it('other changes (not into ready) are never capped', async () => {
    const r = await cli(['backlog', 'update', ids[2]!, '--expected-version', (await show(ids[2]!)).version, '--priority', 'high']);
    expect(r.code, r.out).toBe(0);
  });

  it('--owner-approved needs a recent owner message: refused at 2 h, allowed at 5 min and recorded as owner-promote', async () => {
    expect((await toReady(ids[2]!, ['--owner-approved'])).body.error?.message).toMatch(/--owner-approved refused/);
    db.setMeta(LAST_OWNER_MESSAGE_META, new Date(Date.now() - 5 * 60_000).toISOString());
    const ok = await toReady(ids[2]!, ['--owner-approved']);
    expect(ok.code, ok.out).toBe(0);
    expect((await show(ids[2]!)).status).toBe('ready');
    expect(eventIds(OWNER_PROMOTE_EVENT)).toEqual([ids[2]]);
    expect(eventIds(AUTO_PROMOTE_EVENT)).toHaveLength(2);
  });
});
