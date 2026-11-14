// Upgrade requests, runtime side: the change_requests table (schema 8 migration), `upgrade` recording a request in the
// runtime (never applying it), `settings requests` listing them and the hidden `settings requests mark` recording the
// host's outcome; `settings set` and `settings restart` are host-only. Real program, temp state, no Docker.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `status` probes the coordinator's tmux session; the unit tier runs no subprocess, so the probe answers "no session".
vi.mock('../../src/core/exec.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/exec.js')>()),
  run: async () => ({ code: 1, stdout: '', stderr: 'no server running' }),
}));
import { buildProgram } from '../../src/program.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { isChangeRequestId, quotedReason, REASON_MAX } from '../../src/runtime/change-requests.js';
import { defaults } from '../helpers.js';

let state: string;
let configFile: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

const writeConfig = (over: Record<string, unknown> = {}) => writeFileSync(configFile, JSON.stringify({ ...defaults(), ...over }));

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'minions-cr-'));
  configFile = join(state, 'config.json');
  writeConfig();
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: configFile });
});
afterEach(() => rmSync(state, { recursive: true, force: true }));
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function cli(args: string[]): Promise<{ out: string; code: number; env: { ok: boolean; data?: any; error?: { code: string; message: string; hint?: string } } }> {
  const program = buildProgram();
  let out = '';
  const capture = (cmd: Command) => { cmd.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } }); cmd.commands.forEach(capture); };
  capture(program);
  const w = process.stdout.write.bind(process.stdout), we = process.stderr.write.bind(process.stderr), exit = process.exit.bind(process);
  const sink = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  process.stdout.write = sink; process.stderr.write = sink;
  process.exit = ((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as typeof process.exit;
  const before = process.exitCode;
  let code = 0;
  try { await program.parseAsync(['node', 'minions', ...args, '--json']); code = process.exitCode === before ? 0 : Number(process.exitCode); }
  catch (e) { code = (e as { exitCode?: number }).exitCode ?? 1; }
  finally { process.stdout.write = w; process.stderr.write = we; process.exit = exit; process.exitCode = before; }
  let env;
  try { env = JSON.parse(out.trim().split('\n').at(-1)!); } catch { env = { ok: false, error: { code: 'PARSE', message: out } }; }
  return { out, code, env };
}

const openState = () => new RuntimeDb(join(state, 'minions.db'));
const rows = () => { const db = openState(); try { return db.changeRequests({ all: true }); } finally { db.close(); } };

describe('change_requests migration', () => {
  it('schema 8 adds change_requests; a schema-7 database migrates and keeps its rows', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(8); // later migrations run on top
    const file = join(state, 'v7.db');
    const v7 = new RuntimeDb(file);
    v7.exec('DROP TABLE change_requests');
    v7.setMeta('schema_version', '7');
    v7.exec("INSERT INTO controls (key, value) VALUES ('paused_starts', '1')");
    v7.close();
    const up = new RuntimeDb(file);
    try {
      expect(up.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
      expect(up.paused().starts).toBe(true);
      const cols = up.all<{ name: string }>('PRAGMA table_info(change_requests)').map((c) => c.name);
      expect(cols).toEqual(['id', 'kind', 'payload', 'reason', 'created_at', 'status', 'updated_at', 'detail']);
    } finally { up.close(); }
  });

  it('a newer request expires the open one; status transitions are checked', () => {
    const db = new RuntimeDb(':memory:');
    try {
      db.addChangeRequest({ id: 'cr_00000001', kind: 'upgrade', payload: { fromContainer: null }, reason: 'a' });
      const r = db.addChangeRequest({ id: 'cr_00000002', kind: 'upgrade', payload: { fromContainer: true }, reason: 'b' });
      expect(r.expired).toEqual(['cr_00000001']);
      expect(db.changeRequest('cr_00000001')).toMatchObject({ status: 'expired', detail: 'superseded by cr_00000002' });
      expect(db.changeRequests().map((x) => x.id)).toEqual(['cr_00000002']);
      // proposed -> confirmed -> applied; final states stay final.
      expect(db.setChangeRequestStatus('cr_00000002', 'confirmed').status).toBe('confirmed');
      expect(() => db.setChangeRequestStatus('cr_00000002', 'rejected')).toThrow(/is confirmed; it cannot become rejected/);
      expect(db.setChangeRequestStatus('cr_00000002', 'applied', 'done').detail).toBe('done');
      expect(db.setChangeRequestStatus('cr_00000002', 'applied').status).toBe('applied'); // idempotent
      expect(() => db.setChangeRequestStatus('cr_00000002', 'failed')).toThrow(/is applied/);
      // failed stays open: it can be retried (confirmed) or rejected.
      db.addChangeRequest({ id: 'cr_00000003', kind: 'upgrade', payload: {}, reason: null });
      db.setChangeRequestStatus('cr_00000003', 'failed', 'refused');
      expect(db.setChangeRequestStatus('cr_00000003', 'rejected').status).toBe('rejected');
      expect(() => db.setChangeRequestStatus('cr_00000002', 'proposed')).toThrow(/is applied; it cannot become proposed/);
      expect(() => db.setChangeRequestStatus('cr_99999999', 'applied')).toThrow(/No change request/);
    } finally { db.close(); }
  });
});

describe('upgrade in the runtime records a request', () => {
  it('records an upgrade request with --from-container [branch]; drain and CLI options are refused', async () => {
    const plain = await cli(['upgrade', '--reason', 'new minions release']);
    expect(plain.code).toBe(0);
    expect(plain.env.data).toMatchObject({ recorded: true, applied: false, dryRun: false });
    expect(isChangeRequestId(plain.env.data.request.id)).toBe(true);
    expect(plain.env.data.request).toMatchObject({ kind: 'upgrade', status: 'proposed', reason: 'new minions release', payload: { fromContainer: null }, summary: 'upgrade' });
    expect(plain.env.data.message).toMatch(/recorded \(proposed, not applied\)/);
    const fc = await cli(['upgrade', '--from-container', '--reason', 'sync']);
    expect(fc.env.data.request.payload).toEqual({ fromContainer: true });
    expect(fc.env.data.expired).toEqual([plain.env.data.request.id]);
    const fcb = await cli(['upgrade', '--from-container', 'release/1.2', '--reason', 'sync']);
    expect(fcb.env.data.request).toMatchObject({ payload: { fromContainer: 'release/1.2' }, summary: 'upgrade --from-container release/1.2' });
    expect((await cli(['upgrade', '--from-container', '--evil', '--reason', 'x'])).env.ok).toBe(false);
    for (const flag of [['--now'], ['--timeout', '10'], ['--rebuild-cli'], ['--sync-only']]) {
      const r = await cli(['upgrade', ...flag, '--reason', 'x']);
      expect(r.env.error!.code, flag.join(' ')).toBe('PRECONDITION');
      expect(r.env.error!.message).toMatch(/not available in an upgrade request/);
    }
    expect(rows().filter((r) => r.status === 'proposed')).toHaveLength(1); // each upgrade request replaced the previous one
  });

  it('--dry-run records nothing; reasons are optional, capped and shown quoted and cut', async () => {
    const dry = await cli(['upgrade', '--from-container', '--reason', 'r', '--dry-run']);
    expect(dry.env.data).toMatchObject({ recorded: false, applied: false, dryRun: true, request: null });
    expect(dry.env.data.message).toMatch(/dry run: would record/);
    expect(rows()).toHaveLength(0);
    expect((await cli(['upgrade'])).env.data.request.reason).toBeNull();
    const long = await cli(['upgrade', '--reason', 'x'.repeat(REASON_MAX + 50)]);
    expect(long.env.data.request.reason).toHaveLength(REASON_MAX);
    expect(quotedReason(long.env.data.request.reason)).toHaveLength(300 + 3); // quotes + ellipsis
    expect(quotedReason('evil\u001b[2Jtext‮')).toBe('"eviltext<U+202E>"');
  });

  it('settings set and settings restart are host-only in the runtime; nothing is recorded', async () => {
    const set = await cli(['settings', 'set', 'execution.maxActiveTasks', '5']);
    expect(set.env.error).toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', hint: expect.stringContaining('minions control set') });
    expect((await cli(['config', 'set', 'execution.maxActiveTasks', '5'])).env.error!.code).toBe('INCOMPATIBLE_RUNTIME');
    const restart = await cli(['settings', 'restart']);
    expect(restart.env.error).toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', hint: expect.stringContaining('minions coordinator restart --recover --detach') });
    expect(rows()).toHaveLength(0);
  });
});

describe('settings requests (runtime)', () => {
  it('lists open requests (--all: every status) and records the host outcome with the hidden mark', async () => {
    const a = (await cli(['upgrade', '--reason', 'r'])).env.data.request.id as string;
    const list = await cli(['settings', 'requests']);
    expect(list.env.data.requests).toEqual([expect.objectContaining({ id: a, kind: 'upgrade', status: 'proposed', summary: 'upgrade' })]);
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'confirmed'])).env.data.status).toBe('confirmed');
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'applied', '--detail', 'synced'])).env.data).toMatchObject({ status: 'applied', detail: 'synced' });
    const b = (await cli(['upgrade'])).env.data.request.id as string;
    expect((await cli(['settings', 'requests', 'mark', b, '--status', 'rejected'])).env.data.status).toBe('rejected');
    expect((await cli(['settings', 'requests'])).env.data.requests).toEqual([]);
    expect((await cli(['settings', 'requests', '--all'])).env.data.requests.map((r: { status: string }) => r.status)).toEqual(['applied', 'rejected']);
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'proposed'])).env.error!.code).toBe('PRECONDITION');
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'failed'])).env.error!.code).toBe('CONFLICT');
  });

  it('rows of the removed kinds (config-set, restart) in an old database are never listed', async () => {
    const db = openState();
    try {
      db.exec("INSERT INTO change_requests (id, kind, payload, reason, created_at, status, updated_at) VALUES ('cr_0000000a', 'config-set', '{}', null, '2026-01-01T00:00:00Z', 'proposed', '2026-01-01T00:00:00Z')");
      db.exec("INSERT INTO change_requests (id, kind, payload, reason, created_at, status, updated_at) VALUES ('cr_0000000b', 'restart', '{}', null, '2026-01-01T00:00:00Z', 'proposed', '2026-01-01T00:00:00Z')");
    } finally { db.close(); }
    const id = (await cli(['upgrade'])).env.data.request.id as string;
    expect((await cli(['settings', 'requests', '--all'])).env.data.requests.map((r: { id: string }) => r.id)).toEqual([id]);
  });

  it('status lists the open requests', async () => {
    const { humanStatus } = await import('../../src/runtime/commands.js');
    expect((await cli(['status'])).env.data.changeRequests).toEqual({ open: 0, items: [] });
    const id = (await cli(['upgrade', '--from-container'])).env.data.request.id as string;
    const st = (await cli(['status'])).env.data;
    expect(st.changeRequests).toEqual({ open: 1, items: [expect.objectContaining({ id, kind: 'upgrade', status: 'proposed' })] });
    const text = humanStatus(st);
    expect(text).toContain('upgrade requests: 1 open');
    expect(text).toMatch(new RegExp(`${id} proposed `));
  });
});
