// task-14.11 QA: the three hardening behaviours through the real CLI with real config files (as task-14.2 QA did).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeBacklogConfig } from '../../src/backlog/factory.js';
import { validateConfig } from '../../src/config/resolve.js';
import { workerRole, workerRoleNames } from '../../src/config/roles.js';
import { defaults } from '../helpers.js';
import { commitFile, initRepo } from './fixtures.js';

const onPath = (process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'backlog')));

const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol', 'gpt-6.1-mini'] }, effort: 'medium' };
const PILOT = { description: 'Second-opinion review on Codex.', promptText: 'Review the head.', contract: 'gate', harness: 'codex' };
const gate = (over: Record<string, unknown> = {}) => ({ description: 'A gate.', promptText: 'Judge.', contract: 'gate', ...over });
const pilotConfig = (over: Record<string, unknown> = {}) => ({
  ...defaults('project-owner'),
  harnesses: { codex: CODEX, network: { tcpConnectPorts: [443] } },
  roles: { 'codex-reviewer': PILOT },
  workflows: { pilot: ['engineer', 'codex-reviewer'] },
  ...over,
});

let state: string;
let configFile: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG', 'MINIONS_WORKSPACE', 'MINIONS_SCRATCH_DIR'] as const;
const writeConfig = (c: unknown) => writeFileSync(configFile, JSON.stringify(c));

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), 'minions-harness-cli-'));
  for (const k of ENV) saved[k] = process.env[k];
  configFile = join(state, 'config.json');
  writeConfig(pilotConfig());
  await writeBacklogConfig(join(state, 'backlog'));
  const workspace = join(state, 'workspace');
  mkdirSync(join(workspace, 'repo'), { recursive: true });
  initRepo(join(workspace, 'repo'));
  Object.assign(process.env, {
    MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: configFile, MINIONS_WORKSPACE: workspace, MINIONS_SCRATCH_DIR: join(state, 'scratch'),
  });
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(state, { recursive: true, force: true });
});

// A fresh module graph per call: src/runtime/commands.ts caches the loaded config for the process, as one CLI run would.
async function cli(args: string[]): Promise<{ out: string; code: number }> {
  vi.resetModules();
  const { buildProgram } = await import('../../src/program.js');
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
  return { out, code };
}
type Body = { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const body = (out: string): Body => JSON.parse(out.trim().split('\n').pop()!) as Body;

describe.runIf(onPath)('task-14.11 through the CLI', () => {
  it('refuses a gate on a process harness with edits/commits/branch worktree (exit 2, dotted paths)', async () => {
    writeConfig(pilotConfig({ roles: { 'codex-reviewer': { ...PILOT, worktree: 'branch', edits: 'any' } } }));
    const r = await cli(['work', 'next']);
    expect(r.code, r.out).toBe(2);
    const b = body(r.out);
    expect(b.error?.code).toBe('INVALID_CONFIG');
    for (const p of ['roles.codex-reviewer.worktree', 'roles.codex-reviewer.edits', 'roles.codex-reviewer.commits']) expect(b.error?.message).toContain(p);
    expect(b.error?.message).toMatch(/read-only/);
  });

  it('commits: true alone on a codex gate is refused', async () => {
    writeConfig(pilotConfig({ roles: { 'codex-reviewer': { ...PILOT, commits: true } } }));
    const r = await cli(['work', 'next']);
    expect(r.code, r.out).toBe(2);
    expect(body(r.out).error?.message).toContain('roles.codex-reviewer.commits');
  });

  it('harnesses.default codex moves an existing gate: work next succeeds for a read-only gate and lists a warning (json), none for Claude-only', async () => {
    writeConfig({ ...defaults('project-owner'), harnesses: { default: 'codex', codex: CODEX, network: { tcpConnectPorts: [443] } }, roles: { judge: gate() } });
    const r = await cli(['work', 'next']);
    expect(r.code, r.out).toBe(0);
    const d = body(r.out).data as { warnings?: string[] };
    expect(d.warnings?.some((w) => /harnesses\.default moves the gate role judge/.test(w)), r.out).toBe(true);
    writeConfig({ ...defaults('project-owner'), roles: { judge: gate() } });
    const c = await cli(['work', 'next']);
    expect(c.code, c.out).toBe(0);
    expect(body(c.out).data).not.toHaveProperty('warnings');
  });

  it('harnesses.default codex with a writable existing gate is refused naming harnesses.default', async () => {
    writeConfig({ ...defaults('project-owner'), harnesses: { default: 'codex', codex: CODEX, network: { tcpConnectPorts: [443] } }, roles: { judge: gate({ worktree: 'branch', edits: 'any' }) } });
    const r = await cli(['work', 'next']);
    expect(r.code, r.out).toBe(2);
    expect(body(r.out).error?.message).toMatch(/harnesses\.default puts the gate role judge on harness codex/);
  });

  it('a process role without its harnesses.<id> block cannot reach work next through a real config (refused up front, never a throw from suggestModel)', async () => {
    writeConfig({ ...defaults('project-owner'), roles: { judge: gate({ harness: 'codex' }) }, workflows: { pilot: ['engineer', 'judge'] } });
    const r = await cli(['work', 'next']);
    expect(r.code, r.out).toBe(2);
    expect(body(r.out).error?.code).toBe('INVALID_CONFIG');
  });
});
