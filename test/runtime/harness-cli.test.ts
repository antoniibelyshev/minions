// task-14.2 QA: the harness config plumbing end to end through the real CLI (`minions work next|claim|brief`,
// runtime mode, real Backlog.md, real config files under MINIONS_CONFIG), not through Scheduler objects. Covers the
// phase 1 option (b) rules, per-harness model checks and tcpConnectPorts as a user meets them (INVALID_CONFIG from a
// command), and the `launch` / `harness` fields a coordinator reads. No runner exists yet (`work run` is child task 3).
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

describe("back-compat: this repository's own config", () => {
  it('validates with no harnesses block, every worker role on claude, and the file is not modified', () => {
    const url = new URL('../../.minions/config.json', import.meta.url);
    const before = readFileSync(url, 'utf8');
    const raw = JSON.parse(before) as Record<string, unknown> & { git: Record<string, unknown> };
    expect(raw.harnesses).toBeUndefined();
    // Same identity patch as test/config.test.ts: the shared file leaves git.identity to the local layer.
    const cfg = validateConfig({ ...raw, git: { ...raw.git, identity: { name: 'x', email: 'x@example.com' } } }, '.minions/config.json');
    for (const name of workerRoleNames(cfg)) expect(workerRole(cfg, name)?.harness, name).toBe('claude');
    expect(readFileSync(url, 'utf8')).toBe(before);
  });
});

describe.runIf(onPath)('work next / claim through the CLI with a real config file', () => {
  it('a codex gate gets launch kind run and a codex brief; a default-workflow task stays an engineer agent launch', async () => {
    writeConfig(pilotConfig());
    const p = body((await cli(['backlog', 'create', '--title', 'Pilot', '--workflow', 'pilot', '--status', 'ready', '--key', 'h-pilot'])).out);
    expect(p.ok, JSON.stringify(p)).toBe(true);
    const pilotId = (p.data!.task as { id: string }).id;
    const d = body((await cli(['backlog', 'create', '--title', 'Plain', '--status', 'ready', '--key', 'h-plain'])).out);
    expect(d.ok, JSON.stringify(d)).toBe(true);
    const plainId = (d.data!.task as { id: string }).id;

    const n = await cli(['work', 'next']);
    expect(n.code, n.out).toBe(0);
    const first = (body(n.out).data as { runnable: Array<Record<string, unknown>> }).runnable;
    for (const r of first) expect(r, String(r.taskId)).toMatchObject({ role: 'engineer', harness: 'claude', agentType: 'minions:engineer', launch: { kind: 'agent', agentType: 'minions:engineer' } });
    expect(first.map((r) => r.taskId).sort()).toEqual([pilotId, plainId].sort());

    // Claude engineer stage of the pilot task, through the CLI: claim, commit, record.
    const e = await cli(['work', 'claim', pilotId]);
    expect(e.code, e.out).toBe(0);
    const eng = body(e.out).data as { leaseId: string; worktree: string; branch: string; harness: string; allowedModels: string[] };
    expect(eng.harness).toBe('claude');
    expect(eng.allowedModels).toEqual(defaults('project-owner').models.allowed);
    const head = commitFile(eng.worktree, 'a.txt', 'pilot');
    const resultFile = join(state, 'eng-result.json');
    writeFileSync(resultFile, JSON.stringify({
      status: 'complete', summary: 'done', branch: eng.branch, headSha: head, modifiedPaths: ['a.txt'],
      checks: [{ command: 'npm test', outcome: 'pass' }], acceptanceEvidence: [], findings: [], nextAction: 'review',
    }));
    const rec = await cli(['work', 'record', eng.leaseId, '--result-file', resultFile]);
    expect(rec.code, rec.out).toBe(0);

    const n2 = await cli(['work', 'next']);
    expect(n2.code, n2.out).toBe(0);
    const byTask = Object.fromEntries((body(n2.out).data as { runnable: Array<Record<string, unknown>> }).runnable.map((r) => [r.taskId as string, r]));
    expect(byTask[pilotId]).toMatchObject({
      role: 'codex-reviewer', harness: 'codex', agentModel: null, suggestedModel: 'gpt-6.1-sol',
      launch: { kind: 'run', command: 'minions work run <leaseId> --json', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', deep: false },
    });
    expect(byTask[plainId]).toMatchObject({ role: 'engineer', harness: 'claude', launch: { kind: 'agent' } });
    expect((byTask[plainId]!.launch as Record<string, unknown>).command).toBeUndefined();

    const c = await cli(['work', 'claim', pilotId]);
    expect(c.code, c.out).toBe(0);
    const gateBrief = body(c.out).data as { leaseId: string; worktree: string };
    expect(gateBrief).toMatchObject({ role: 'codex-reviewer', harness: 'codex', model: 'gpt-6.1-sol', allowedModels: ['gpt-6.1-sol', 'gpt-6.1-mini'], effort: 'medium' });

    // `work brief` (the stored brief, fetched from inside the worktree) carries the same harness fields.
    const cwd = process.cwd();
    process.chdir(gateBrief.worktree);
    try {
      const b = await cli(['work', 'brief', gateBrief.leaseId, '--role', 'codex-reviewer']);
      expect(b.code, b.out).toBe(0);
      expect(body(b.out).data).toMatchObject({ role: 'codex-reviewer', harness: 'codex', model: 'gpt-6.1-sol' });
    } finally {
      process.chdir(cwd);
    }
  });

  // Each refused config is reported by the first command that loads it, with exit code 2 and the dotted path.
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ['harness on engineer', { roles: { engineer: { harness: 'codex' } } }, /roles\.engineer\.harness: .*built-in producer role engineer must stay on claude/],
    ['harness on tester', { roles: { tester: { harness: 'codex' } } }, /roles\.tester\.harness: .*built-in verifier role tester must stay on claude/],
    ['harness on reviewer', { roles: { reviewer: { harness: 'codex' } } }, /roles\.reviewer\.harness: .*built-in gate role reviewer must stay on claude/],
    ['harness on a project producer', { roles: { writer: { description: 'w', promptText: 'w', contract: 'producer', edits: 'any', harness: 'codex' } } }, /roles\.writer\.harness: .*project producer role writer must stay on claude/],
    ['harness on a project verifier', { roles: { checker: { description: 'c', promptText: 'c', contract: 'verifier', harness: 'codex' } } }, /roles\.checker\.harness: .*project verifier role checker must stay on claude/],
    ['harness on the coordinator', { roles: { coordinator: gate({ harness: 'codex' }) } }, /roles\.coordinator\.harness: the coordinator always runs on Claude Code/],
    ['harness without its block', { harnesses: { codex: CODEX }, roles: { judge: gate({ harness: 'junie' }) } }, /roles\.judge\.harness: harness "junie" has no harnesses\.junie block/],
    ['no harnesses block at all', { harnesses: undefined }, /roles\.codex-reviewer\.harness: harness "codex" has no harnesses\.codex block/],
    ['Claude alias on a codex role', { roles: { 'codex-reviewer': { ...PILOT, model: 'sonnet' } } }, /roles\.codex-reviewer\.model: "sonnet" is not in harnesses\.codex\.models\.allowed/],
    ['Codex model on a Claude role', { roles: { 'codex-reviewer': PILOT, reviewer: { model: 'gpt-6.1-sol' } } }, /roles\.reviewer\.model: "gpt-6.1-sol" is not in models\.allowed/],
    ['Codex model as a Claude stage hint', { workflows: { pilot: ['engineer', 'codex-reviewer'], docs: ['engineer', { role: 'reviewer', model: 'gpt-6.1-mini' }] } }, /workflows\.docs\.1: model "gpt-6.1-mini" is not in models\.allowed/],
    ['Claude alias as a codex stage hint', { workflows: { pilot: ['engineer', { role: 'codex-reviewer', model: 'opus' }] } }, /workflows\.pilot\.1: model "opus" is not in harnesses\.codex\.models\.allowed/],
    ['tcpConnectPorts empty', { harnesses: { codex: CODEX, network: { tcpConnectPorts: [] } } }, /harnesses\.network\.tcpConnectPorts/],
    ['tcpConnectPorts 0', { harnesses: { codex: CODEX, network: { tcpConnectPorts: [0] } } }, /harnesses\.network\.tcpConnectPorts\.0/],
    ['tcpConnectPorts 65536', { harnesses: { codex: CODEX, network: { tcpConnectPorts: [443, 65536] } } }, /harnesses\.network\.tcpConnectPorts\.1/],
  ];
  it.each(refused)('refuses %s with INVALID_CONFIG', async (_name, patch, message) => {
    const cfg = pilotConfig() as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete cfg[k];
      else cfg[k] = k === 'roles' && !('codex-reviewer' in (v as object)) && cfg.harnesses ? { ...(cfg.roles as object), ...(v as object) } : v;
    }
    writeConfig(cfg);
    try {
      const r = await cli(['work', 'next']);
      expect(r.code, r.out).toBe(2);
      const b = body(r.out);
      expect(b.error?.code).toBe('INVALID_CONFIG');
      expect(b.error?.message).toMatch(message);
    } finally {
      writeConfig(pilotConfig());
    }
  });

  it('accepts tcpConnectPorts at the range ends (1, 65535)', async () => {
    writeConfig(pilotConfig({ harnesses: { codex: CODEX, network: { tcpConnectPorts: [1, 65535] } } }));
    try {
      const r = await cli(['work', 'next']);
      expect(r.code, r.out).toBe(0);
    } finally {
      writeConfig(pilotConfig());
    }
  });

  it('harnesses.default codex validates and leaves built-in roles on Claude agent launches', async () => {
    writeConfig(pilotConfig({ harnesses: { default: 'codex', codex: CODEX }, roles: { judge: gate() }, workflows: { judged: ['engineer', 'judge'] } }));
    try {
      const r = await cli(['work', 'next']);
      expect(r.code, r.out).toBe(0);
      const runnable = (body(r.out).data as { runnable: Array<Record<string, unknown>> }).runnable;
      expect(runnable.length).toBeGreaterThan(0);
      for (const x of runnable) {
        if (x.role === 'engineer') expect(x).toMatchObject({ harness: 'claude', launch: { kind: 'agent' } });
      }
    } finally {
      writeConfig(pilotConfig());
    }
  });
});
