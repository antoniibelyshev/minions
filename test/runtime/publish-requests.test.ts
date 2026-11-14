// Publish requests, runtime side (docs/design/autonomy.md Decision 17): `settings requests publish` records a request
// for the base branch at one exact SHA (refused without a git remote), a newer one supersedes the older, `settings
// requests` lists both kinds, and the host's outcome goes through the hidden `mark`. Real program, temp state; git in
// the workspace is faked (unit tier).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OFF_BASE = 'c'.repeat(40);
/** git in the workspace: the base head is HEAD; OLD is on the base, OFF_BASE is not. */
vi.mock('../../src/core/exec.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/exec.js')>()),
  run: async (cmd: string, args: string[]) => {
    if (cmd !== 'git') return { code: 1, stdout: '', stderr: 'no server running' };
    if (args.includes('rev-parse')) return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
    if (args.includes('merge-base')) return { code: args.includes(OFF_BASE) ? 1 : 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  },
}));
import { buildProgram } from '../../src/program.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { parsePublishTasks, publishPayloadOf, recordPublishRequest, requestSummary } from '../../src/runtime/change-requests.js';
import { defaults } from '../helpers.js';

let state: string;
let configFile: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG', 'MINIONS_WORKSPACE'] as const;

const writeProject = (remoteUrl: string | null) =>
  writeFileSync(join(state, 'project.json'), JSON.stringify({ projectId: defaults().projectId, baseBranch: 'main', remoteUrl }));

beforeAll(() => { for (const k of ENV) saved[k] = process.env[k]; });
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'minions-pub-'));
  configFile = join(state, 'config.json');
  writeFileSync(configFile, JSON.stringify(defaults()));
  writeProject('git@github.com:owner/repo.git');
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: configFile, MINIONS_WORKSPACE: join(state, 'ws') });
});
afterEach(() => rmSync(state, { recursive: true, force: true }));
afterAll(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function cli(args: string[]): Promise<{ code: number; env: { ok: boolean; data?: any; error?: { code: string; message: string; hint?: string } } }> {
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
  return { code, env };
}

const rows = () => { const db = new RuntimeDb(join(state, 'minions.db')); try { return db.changeRequests({ all: true }); } finally { db.close(); } };

describe('settings requests publish (runtime)', () => {
  it('records the base head with the summary and tasks; nothing is pushed', async () => {
    const { code, env } = await cli(['settings', 'requests', 'publish', '--summary', 'Login and the settings page', '--task', 'task-3', '--task', 'task-4,TASK-5']);
    expect(code).toBe(0);
    expect(env.data).toMatchObject({ recorded: true, applied: false, request: { kind: 'publish', status: 'proposed', reason: 'Login and the settings page', payload: { base: 'main', sha: HEAD, tasks: ['task-3', 'task-4', 'task-5'] } } });
    expect(env.data.message).toMatch(/not pushed/);
    expect(rows()).toHaveLength(1);
  });

  it('accepts an earlier commit of the base and refuses one that is not on it', async () => {
    expect((await cli(['settings', 'requests', 'publish', '--summary', 's', '--sha', OLD])).env.data.request.payload.sha).toBe(OLD);
    const off = await cli(['settings', 'requests', 'publish', '--summary', 's', '--sha', OFF_BASE]);
    expect(off.env.error?.message).toMatch(/is not on main/);
    const short = await cli(['settings', 'requests', 'publish', '--summary', 's', '--sha', 'abc123']);
    expect(short.env.error?.message).toMatch(/full 40-character/);
  });

  it('is unavailable without a git remote, and says so', async () => {
    writeProject(null);
    const { code, env } = await cli(['settings', 'requests', 'publish', '--summary', 's']);
    expect(code).not.toBe(0);
    expect(env.error).toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/Publishing is unavailable: this project has no git remote/) });
    expect(rows()).toHaveLength(0);
  });

  it('needs a summary, takes no request id in the runtime, and a dry run records nothing', async () => {
    expect((await cli(['settings', 'requests', 'publish'])).env.error?.message).toMatch(/--summary is required/);
    expect((await cli(['settings', 'requests', 'publish', 'cr_00000000', '--summary', 's'])).env.error?.message).toMatch(/takes no request id/);
    const dry = await cli(['settings', 'requests', 'publish', '--summary', 's', '--dry-run']);
    expect(dry.env.data).toMatchObject({ recorded: false, dryRun: true });
    expect(rows()).toHaveLength(0);
  });

  it('a newer request supersedes the open one; both kinds are listed; the host marks the outcome', async () => {
    const up = await cli(['upgrade', '--reason', 'new minions']);
    const first = (await cli(['settings', 'requests', 'publish', '--summary', 'one'])).env.data.request.id as string;
    const second = await cli(['settings', 'requests', 'publish', '--summary', 'two', '--sha', OLD]);
    expect(second.env.data.expired).toEqual([first]);
    const list = (await cli(['settings', 'requests'])).env.data.requests as { id: string; kind: string; summary: string }[];
    expect(list.map((r) => r.kind).sort()).toEqual(['publish', 'upgrade']);
    expect(list.find((r) => r.kind === 'publish')!.summary).toBe(`publish main at ${OLD.slice(0, 12)}`);
    expect(list.some((r) => r.id === up.env.data.request.id)).toBe(true);
    const id = second.env.data.request.id as string;
    expect((await cli(['settings', 'requests', 'mark', id, '--status', 'confirmed'])).code).toBe(0);
    const applied = await cli(['settings', 'requests', 'mark', id, '--status', 'applied', '--detail', `pushed ${OLD} to origin/main`]);
    expect(applied.env.data).toMatchObject({ status: 'applied', detail: `pushed ${OLD} to origin/main` });
    // A confirmed request can only end applied or failed: never back to rejected.
    expect((await cli(['settings', 'requests', 'mark', id, '--status', 'rejected'])).env.error?.code).toBe('CONFLICT');
  });
});

describe('publish request model', () => {
  it('validates tasks, payloads and the one-line summary (the row is runtime-written)', () => {
    expect(parsePublishTasks(['task-1, task-2.1', 'task-1'])).toEqual(['task-1', 'task-2.1']);
    expect(() => parsePublishTasks(['rm -rf'])).toThrow(/not a task id/);
    expect(publishPayloadOf({ base: 'main', sha: HEAD, tasks: ['task-1', 'evil\u0007', 7] })).toEqual({ base: 'main', sha: HEAD, tasks: ['task-1'] });
    expect(publishPayloadOf({ base: 'main', sha: 'HEAD' })).toBeNull();
    expect(publishPayloadOf({ base: '--force', sha: HEAD })).toBeNull();
    expect(requestSummary({ base: 'main', sha: HEAD, tasks: ['task-1'] }, 'publish')).toBe(`publish main at ${HEAD.slice(0, 12)} (1 task: task-1)`);
    expect(requestSummary({}, 'publish')).toBe('publish (malformed request)');
  });

  it('recordPublishRequest refuses without a remote and stores the summary as the reason', () => {
    const db = new RuntimeDb(join(state, 'minions.db'));
    try {
      expect(() => recordPublishRequest(db, { base: 'main', sha: HEAD, tasks: [], summary: 's', remoteUrl: null })).toThrow(/no git remote/);
      const r = recordPublishRequest(db, { base: 'main', sha: HEAD, tasks: ['task-9'], summary: '  ship it  ', remoteUrl: 'https://example.com/r.git' });
      expect(r.request).toMatchObject({ kind: 'publish', reason: 'ship it', status: 'proposed' });
    } finally { db.close(); }
  });
});
