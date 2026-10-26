// task-53.3 (docs/design/host-manager.md, phase 2), runtime side: the change_requests table (schema 8 migration),
// and `settings set ... --reason`, `settings restart`, `upgrade` recording requests in the runtime (never applying
// them), validated against the runtime config, host-owned keys refused with CONFLICT; `settings requests` lists
// them and the hidden `settings requests mark` records the host's outcome. Real program, temp state, no Docker.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/program.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { isChangeRequestId, quotedReason, recordSettingRequest, REASON_MAX } from '../../src/runtime/change-requests.js';
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
    expect(SCHEMA_VERSION).toBe(8);
    const file = join(state, 'v7.db');
    const v7 = new RuntimeDb(file);
    v7.exec('DROP TABLE change_requests');
    v7.setMeta('schema_version', '7');
    v7.exec("INSERT INTO controls (key, value) VALUES ('paused_starts', '1')");
    v7.close();
    const up = new RuntimeDb(file);
    try {
      expect(up.getMeta('schema_version')).toBe('8');
      expect(up.paused().starts).toBe(true);
      const cols = up.all<{ name: string }>('PRAGMA table_info(change_requests)').map((c) => c.name);
      expect(cols).toEqual(['id', 'kind', 'payload', 'reason', 'created_at', 'status', 'updated_at', 'detail']);
    } finally { up.close(); }
  });

  it('a newer request for the same thing expires the open one; status transitions are checked', () => {
    const db = new RuntimeDb(':memory:');
    try {
      db.addChangeRequest({ id: 'cr_00000001', kind: 'config-set', payload: { key: 'execution.maxActiveTasks', value: '3' }, reason: 'a' });
      db.addChangeRequest({ id: 'cr_00000002', kind: 'config-set', payload: { key: 'execution.maxEngineers', value: '2' }, reason: 'b' });
      db.addChangeRequest({ id: 'cr_00000003', kind: 'restart', payload: {}, reason: null });
      const r = db.addChangeRequest({ id: 'cr_00000004', kind: 'config-set', payload: { key: 'execution.maxActiveTasks', value: '4' }, reason: 'c' });
      expect(r.expired).toEqual(['cr_00000001']);
      expect(db.changeRequest('cr_00000001')).toMatchObject({ status: 'expired', detail: 'superseded by cr_00000004' });
      expect(db.changeRequests().map((x) => x.id)).toEqual(['cr_00000002', 'cr_00000003', 'cr_00000004']);
      // proposed -> confirmed -> applied; final states stay final.
      expect(db.setChangeRequestStatus('cr_00000004', 'confirmed').status).toBe('confirmed');
      expect(() => db.setChangeRequestStatus('cr_00000004', 'rejected')).toThrow(/is confirmed; it cannot become rejected/);
      expect(db.setChangeRequestStatus('cr_00000004', 'applied', 'done').detail).toBe('done');
      expect(db.setChangeRequestStatus('cr_00000004', 'applied').status).toBe('applied'); // idempotent
      expect(() => db.setChangeRequestStatus('cr_00000004', 'failed')).toThrow(/is applied/);
      // failed stays open: it can be retried (confirmed) or rejected.
      db.setChangeRequestStatus('cr_00000003', 'failed', 'refused');
      expect(db.setChangeRequestStatus('cr_00000003', 'rejected').status).toBe('rejected');
      expect(() => db.setChangeRequestStatus('cr_00000004', 'proposed')).toThrow(/is applied; it cannot become proposed/);
      expect(() => db.setChangeRequestStatus('cr_99999999', 'applied')).toThrow(/No change request/);
    } finally { db.close(); }
  });
});

describe('settings set in the runtime records a request', () => {
  it('records a proposed config-set request (validated against the runtime config); nothing is applied', async () => {
    const { code, env } = await cli(['settings', 'set', 'execution.maxActiveTasks', '5', '--reason', 'the backlog has 12 independent tasks']);
    expect(code).toBe(0);
    expect(env.ok).toBe(true);
    const d = env.data;
    expect(d).toMatchObject({ recorded: true, applied: false, unchanged: false, dryRun: false });
    expect(isChangeRequestId(d.request.id)).toBe(true);
    expect(d.request).toMatchObject({ kind: 'config-set', status: 'proposed', reason: 'the backlog has 12 independent tasks',
      payload: { key: 'execution.maxActiveTasks', value: '5', layer: 'local', baseRevision: 1 } });
    expect(d.change).toMatchObject({ key: 'execution.maxActiveTasks', to: 5, takesEffect: 'now' });
    expect(d.change.loosens).toMatch(/more tasks may run in parallel/);
    expect(d.applyCommand).toBe(`minions settings apply ${d.request.id}`);
    expect(d.message).toMatch(/recorded \(proposed, not applied\)/);
    expect(d.message).toMatch(/never say the change was made/);
    expect(d.message).not.toMatch(/\bapplied:/);
    expect(rows()).toHaveLength(1);
    // The runtime config is untouched: the runtime cannot write it.
    expect(JSON.parse((await import('node:fs')).readFileSync(configFile, 'utf8')).execution.maxActiveTasks).toBe(defaults().execution.maxActiveTasks);
  });

  it('refuses host-owned keys with CONFLICT (ask the owner instead) and records nothing', async () => {
    for (const [key, value] of [['delivery.mode', 'pull-request'], ['capabilities.git.push', 'allow'], ['communication.channel', 'terminal'], ['verification.reviewerRequired', 'false'], ['secrets.github', 'x']]) {
      const { code, env } = await cli(['settings', 'set', key!, value!, '--reason', 'faster']);
      expect(env.ok, key).toBe(false);
      expect(env.error!.code, key).toBe('CONFLICT');
      expect(env.error!.message).toMatch(/host-owned/);
      expect(env.error!.hint).toMatch(/Ask the owner/);
      expect(code).toBe(4);
    }
    expect(rows()).toHaveLength(0);
  });

  it('validates before recording: invalid values, unknown keys, a missing reason, controls, shared on a private install', async () => {
    expect((await cli(['settings', 'set', 'execution.maxActiveTasks', 'many', '--reason', 'r'])).env.error!.code).toBe('INVALID_CONFIG');
    expect((await cli(['settings', 'set', 'execution.maxEngineers', '99', '--reason', 'r'])).env.error!.code).toBe('INVALID_CONFIG'); // > maxActiveTasks (cross-field rule)
    expect((await cli(['settings', 'set', 'no.such.key', '1', '--reason', 'r'])).env.error!.code).toBe('INVALID_CONFIG');
    const noReason = await cli(['settings', 'set', 'execution.maxActiveTasks', '5']);
    expect(noReason.env.error).toMatchObject({ code: 'PRECONDITION' });
    expect(noReason.env.error!.message).toMatch(/needs a reason/);
    expect((await cli(['settings', 'set', 'pause.starts', 'paused', '--reason', 'r'])).env.error!.message).toMatch(/runtime control/);
    writeConfig({ visibility: 'private' });
    expect((await cli(['settings', 'set', 'execution.maxActiveTasks', '5', '--shared', '--reason', 'r'])).env.error!.message).toMatch(/private install/);
    expect((await cli(['settings', 'set', 'execution.maxActiveTasks', '5', '--yes', '--reason', 'r'])).env.error!.message).toMatch(/--yes: host-only/);
    expect((await cli(['settings', 'set', 'execution.maxActiveTasks', '5', '--expect-revision', '1', '--reason', 'r'])).env.error!.message).toMatch(/--expect-revision: host-only/);
    expect(rows()).toHaveLength(0);
  });

  it('the `config set` alias records the same request and refuses the same direct-apply options (task-53.10)', async () => {
    const { code, env } = await cli(['config', 'set', 'execution.maxActiveTasks', '5', '--reason', 'more parallelism']);
    expect(code).toBe(0);
    expect(env.data).toMatchObject({ recorded: true, applied: false, unchanged: false, dryRun: false });
    expect(env.data.request).toMatchObject({ kind: 'config-set', status: 'proposed', reason: 'more parallelism',
      payload: { key: 'execution.maxActiveTasks', value: '5', layer: 'local' } });
    expect(env.data.applyCommand).toBe(`minions settings apply ${env.data.request.id}`);
    expect(rows()).toHaveLength(1);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).execution.maxActiveTasks).toBe(defaults().execution.maxActiveTasks);
    for (const [flag, extra] of [['--yes', []], ['--restart', []], ['--no-restart', []], ['--expect-revision', ['1']]] as const) {
      const r = await cli(['config', 'set', 'execution.maxActiveTasks', '6', flag, ...extra, '--reason', 'r']);
      expect(r.env.ok, flag).toBe(false);
      expect(r.env.error, flag).toMatchObject({ code: 'PRECONDITION' });
      expect(r.env.error!.message, flag).toMatch(new RegExp(`${flag}: host-only`));
    }
    expect((await cli(['config', 'set', 'execution.maxActiveTasks', '6'])).env.error!.message).toMatch(/needs a reason/);
    expect(rows()).toHaveLength(1); // only the first request was recorded
  });

  it('an unchanged value and --dry-run record nothing', async () => {
    const same = await cli(['settings', 'set', 'execution.maxActiveTasks', String(defaults().execution.maxActiveTasks), '--reason', 'r']);
    expect(same.env.data).toMatchObject({ recorded: false, applied: false, unchanged: true });
    const dry = await cli(['settings', 'set', 'execution.maxActiveTasks', '6', '--reason', 'r', '--dry-run']);
    expect(dry.env.data).toMatchObject({ recorded: false, applied: false, dryRun: true, request: null });
    expect(dry.env.data.message).toMatch(/dry run: would record/);
    expect(rows()).toHaveLength(0);
  });

  it('a shared install (the project-owner default) may request the shared layer; reasons are capped and shown quoted and cut', async () => {
    const { env } = await cli(['settings', 'set', 'models.selection', 'fixed', '--shared', '--reason', 'x'.repeat(REASON_MAX + 50)]);
    expect(env.data.request.payload.layer).toBe('shared');
    expect(env.data.request.reason).toHaveLength(REASON_MAX);
    expect(quotedReason(env.data.request.reason)).toHaveLength(300 + 3); // quotes + ellipsis
    expect(quotedReason('evil\u001b[2Jtext‮')).toBe('"eviltext<U+202E>"');
  });
});

describe('settings restart and upgrade in the runtime record requests', () => {
  it('settings restart records a restart request (reason optional)', async () => {
    const { env } = await cli(['settings', 'restart', '--reason', 'new attemptMaxTurns']);
    expect(env.data).toMatchObject({ recorded: true, applied: false, request: { kind: 'restart', status: 'proposed', reason: 'new attemptMaxTurns', payload: {} } });
    const again = await cli(['settings', 'restart']);
    expect(again.env.data.expired).toEqual([env.data.request.id]);
    expect(rows().map((r) => r.status)).toEqual(['expired', 'proposed']);
  });

  it('upgrade records an upgrade request; --from-container [branch] only with local delivery; drain and CLI options are refused', async () => {
    const plain = await cli(['upgrade', '--reason', 'new minions release']);
    expect(plain.env.data.request).toMatchObject({ kind: 'upgrade', payload: { fromContainer: null } });
    const fc = await cli(['upgrade', '--from-container', '--reason', 'sync']);
    expect(fc.env.data.request.payload).toEqual({ fromContainer: true });
    const fcb = await cli(['upgrade', '--from-container', 'release/1.2', '--reason', 'sync']);
    expect(fcb.env.data.request.payload).toEqual({ fromContainer: 'release/1.2' });
    expect((await cli(['upgrade', '--from-container', '--evil', '--reason', 'x'])).env.ok).toBe(false);
    for (const flag of [['--now'], ['--timeout', '10'], ['--rebuild-cli'], ['--sync-only']]) {
      const r = await cli(['upgrade', ...flag, '--reason', 'x']);
      expect(r.env.error!.code, flag.join(' ')).toBe('PRECONDITION');
      expect(r.env.error!.message).toMatch(/not available in an upgrade request/);
    }
    writeConfig({ delivery: { ...defaults().delivery, mode: 'branch', provider: 'github' } });
    const gh = await cli(['upgrade', '--from-container', '--reason', 'x']);
    expect(gh.env.error!.message).toMatch(/local delivery only/);
    expect(rows().filter((r) => r.status === 'proposed')).toHaveLength(1); // each upgrade request replaced the previous one
  });
});

describe('settings requests (runtime)', () => {
  it('lists open requests (--all: every status) and records the host outcome with the hidden mark', async () => {
    const a = (await cli(['settings', 'set', 'execution.maxActiveTasks', '5', '--reason', 'r'])).env.data.request.id as string;
    const b = (await cli(['settings', 'restart'])).env.data.request.id as string;
    const list = await cli(['settings', 'requests']);
    expect(list.env.data.requests.map((r: { id: string }) => r.id)).toEqual([a, b]);
    expect(list.env.data.requests[0]).toMatchObject({ id: a, kind: 'config-set', status: 'proposed', summary: 'settings set execution.maxActiveTasks 5' });
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'confirmed'])).env.data.status).toBe('confirmed');
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'applied', '--detail', 'written'])).env.data).toMatchObject({ status: 'applied', detail: 'written' });
    expect((await cli(['settings', 'requests', 'mark', b, '--status', 'rejected'])).env.data.status).toBe('rejected');
    expect((await cli(['settings', 'requests'])).env.data.requests).toEqual([]);
    expect((await cli(['settings', 'requests', '--all'])).env.data.requests.map((r: { status: string }) => r.status)).toEqual(['applied', 'rejected']);
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'proposed'])).env.error!.code).toBe('PRECONDITION');
    expect((await cli(['settings', 'requests', 'mark', a, '--status', 'failed'])).env.error!.code).toBe('CONFLICT');
  });

  it('status lists the open requests, so nothing is lost while the host manager is down (task-53.6)', async () => {
    const { humanStatus } = await import('../../src/runtime/commands.js');
    expect((await cli(['status'])).env.data.changeRequests).toEqual({ open: 0, items: [] });
    const id = (await cli(['settings', 'restart'])).env.data.request.id as string;
    const st = (await cli(['status'])).env.data;
    expect(st.changeRequests).toEqual({ open: 1, items: [expect.objectContaining({ id, kind: 'restart', status: 'proposed' })] });
    const text = humanStatus(st);
    expect(text).toContain('change requests: 1 open');
    expect(text).toMatch(new RegExp(`${id} proposed `));
  });

  it('apply and reject are host-only', async () => {
    const id = (await cli(['settings', 'restart'])).env.data.request.id as string;
    for (const sub of ['apply', 'reject']) {
      const r = await cli(['settings', sub, id]);
      expect(r.env.error!.code).toBe('INCOMPATIBLE_RUNTIME');
      expect(r.env.error!.hint).toContain(`minions settings apply ${id}`);
    }
    expect(rows()[0]!.status).toBe('proposed');
  });
});

describe('recordSettingRequest (unit)', () => {
  it('refuses host-owned keys before parsing the value', () => {
    const db = new RuntimeDb(':memory:');
    try {
      expect(() => recordSettingRequest({ db, config: defaults() }, 'architecture', 'not-a-choice', { reason: 'r' })).toThrow(/host-owned/);
      expect(db.changeRequests({ all: true })).toEqual([]);
    } finally { db.close(); }
  });
});
