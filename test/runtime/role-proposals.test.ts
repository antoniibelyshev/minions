// task-33.6 (docs/design/roles-and-workflows.md D2), runtime side: `config roles propose --file` validates a
// proposal with the config rules and stores it in role_proposals without making it effective; `config roles
// list|show` are read-only; `apply` / `remove` are rejected inside the runtime; `mark-applied` only marks a
// proposal whose role the host has put into the runtime config.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { defaults } from '../helpers.js';
import { tmp } from './fixtures.js';

const { registerRoles } = await import('../../src/host/roles-cli.js');

let root = '';
let prev: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG', 'MINIONS_WORKSPACE'] as const;
const configFile = () => join(root, 'config.json');

beforeAll(() => {
  root = tmp();
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(configFile(), JSON.stringify(defaults('project-owner')));
  prev = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: join(root, 'state'), MINIONS_CONFIG: configFile(), MINIONS_WORKSPACE: join(root, 'workspace'),
  });
});
afterAll(() => { for (const k of ENV) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

type Envelope = { ok: boolean; data?: any; error?: { code: string; message: string; hint?: string } };

async function run(...args: string[]): Promise<Envelope> {
  const program = new Command();
  program.exitOverride();
  program.option('--json');
  registerRoles(program.command('config'), { confirm: async () => { throw new Error('no confirmation in the runtime'); } });
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c }); }) as typeof process.exit);
  try {
    await program.parseAsync(['node', 'minions', ...args, '--json']);
  } catch (e) {
    if ((e as { exitCode?: number }).exitCode === undefined) throw e;
  } finally {
    vi.restoreAllMocks();
  }
  return JSON.parse(out.join('').trim().split('\n').pop()!);
}

const RESEARCHER = {
  name: 'researcher',
  role: {
    description: 'Researches a question and writes findings to a notes file. No code edits.',
    contract: 'producer',
    edits: { paths: ['docs/research/**'] },
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
    model: 'sonnet',
    requires: ['network.use'],
  },
  promptText: 'You research the question in the task and write your findings to docs/research/<task-id>.md. Never edit code.',
  reason: 'Recurring research tasks need web access and a notes file, not code edits.',
  workflows: { research: ['researcher', 'reviewer'] },
};

let n = 0;
function proposalFile(p: unknown): string {
  const f = join(root, `proposal-${++n}.json`);
  writeFileSync(f, JSON.stringify(p));
  return f;
}

describe('config roles propose (runtime)', () => {
  it('validates and stores a proposal without making it effective; list and show are read-only', async () => {
    const configBefore = readFileSync(configFile(), 'utf8');
    const r = await run('config', 'roles', 'propose', '--file', proposalFile(RESEARCHER));
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data).toMatchObject({ name: 'researcher', state: 'pending', effective: false, superseded: [] });
    expect(r.data.proposalId).toMatch(/^rp_[0-9a-f]{8}$/);
    expect(r.data.applyCommand).toBe(`minions config roles apply ${r.data.proposalId}`);
    // Summary: fields, tools, edit scope, policy row.
    expect(r.data.summary).toMatchObject({
      change: 'add', contract: 'producer', worktree: 'branch', stageStatus: 'implementing', commits: true,
      edits: { paths: ['docs/research/**'] }, model: 'sonnet', requires: ['network.use'],
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
      workflows: [{ name: 'research', stages: ['researcher', 'reviewer'], change: 'add' }],
    });
    expect(r.data.summary.policy.deny).toEqual(expect.arrayContaining(['deploy.execute', 'pr.merge', 'external.read', 'ci.edit']));
    // Nothing effective: the runtime config is untouched and the role is not registered.
    expect(readFileSync(configFile(), 'utf8')).toBe(configBefore);
    const list = await run('config', 'roles', 'list');
    expect(list.ok).toBe(true);
    expect(list.data.roles.map((x: { name: string }) => x.name)).toEqual(['engineer', 'tester', 'reviewer']);
    expect(list.data.proposals).toEqual([expect.objectContaining({ id: r.data.proposalId, name: 'researcher', state: 'pending', reason: RESEARCHER.reason })]);
    const role = await run('config', 'roles', 'show', 'researcher');
    expect(role.error).toMatchObject({ code: 'NOT_FOUND' });
    const shown = await run('config', 'roles', 'show', r.data.proposalId);
    expect(shown.data).toMatchObject({ kind: 'proposal', proposal: RESEARCHER, view: { state: 'pending' }, problem: null, summary: { name: 'researcher' } });
    const db = new RuntimeDb(join(root, 'state', 'minions.db'));
    try {
      expect(db.roleProposal(r.data.proposalId)).toMatchObject({ name: 'researcher', state: 'pending', applied_revision: null });
    } finally { db.close(); }
  });

  it('a newer proposal for the same role supersedes the pending one', async () => {
    const a = await run('config', 'roles', 'propose', '--file', proposalFile({ ...RESEARCHER, name: 'writer', workflows: undefined }));
    const b = await run('config', 'roles', 'propose', '--file', proposalFile({ ...RESEARCHER, name: 'writer', workflows: undefined, reason: 'Second draft.' }));
    expect(b.data.superseded).toEqual([a.data.proposalId]);
    const all = await run('config', 'roles', 'list', '--all');
    expect(all.data.proposals.find((p: { id: string }) => p.id === a.data.proposalId).state).toBe('superseded');
    const pending = await run('config', 'roles', 'list');
    expect(pending.data.proposals.map((p: { id: string }) => p.id)).not.toContain(a.data.proposalId);
    expect(pending.data.proposals.map((p: { id: string }) => p.id)).toContain(b.data.proposalId);
  });

  it('rejects invalid proposals with the config rules and stores nothing', async () => {
    const before = (await run('config', 'roles', 'list', '--all')).data.proposals.length;
    const cases: [unknown, RegExp][] = [
      [{ ...RESEARCHER, role: { ...RESEARCHER.role, colour: 'blue' } }, /roles\.researcher\.colour: unknown field/],
      [{ ...RESEARCHER, role: { ...RESEARCHER.role, contract: 'boss' } }, /roles\.researcher\.contract/],
      [{ ...RESEARCHER, role: { ...RESEARCHER.role, model: 'gpt-9' } }, /roles\.researcher\.model: "gpt-9" is not in models\.allowed/],
      [{ ...RESEARCHER, role: { ...RESEARCHER.role, edits: 'none', commits: true } }, /roles\.researcher\.commits/],
      [{ ...RESEARCHER, role: { ...RESEARCHER.role, prompt: 'agents/x.md' } }, /role\.prompt: the prompt goes into the top-level promptText/],
      [{ ...RESEARCHER, name: 'Researcher' }, /name: role name must match/],
      [{ ...RESEARCHER, name: '../evil' }, /name: role name must match/],
      [{ ...RESEARCHER, name: 'engineer' }, /built-in role/],
      [{ ...RESEARCHER, name: 'coordinator' }, /coordinator is not a configurable role/],
      [{ ...RESEARCHER, name: 'researcher-deep' }, /must not end in "-deep"/],
      [{ ...RESEARCHER, promptText: '---\nname: x\n---\nbody' }, /frontmatter fence/],
      [{ ...RESEARCHER, workflows: { research: ['researcher', 'auditor'] } }, /workflows\.research/],
      [{ ...RESEARCHER, extra: true }, /extra: unknown field/],
      [{ name: 'researcher', role: RESEARCHER.role }, /promptText|reason/],
    ];
    for (const [p, msg] of cases) {
      const r = await run('config', 'roles', 'propose', '--file', proposalFile(p));
      expect(r.ok, JSON.stringify(p)).toBe(false);
      expect(r.error, JSON.stringify(p)).toMatchObject({ code: 'INVALID_CONFIG' });
      expect(r.error!.message, JSON.stringify(p)).toMatch(msg);
    }
    const missing = await run('config', 'roles', 'propose', '--file', join(root, 'nope.json'));
    expect(missing.error).toMatchObject({ code: 'NOT_FOUND' });
    const notJson = join(root, 'not.json');
    writeFileSync(notJson, '{ nope');
    expect((await run('config', 'roles', 'propose', '--file', notJson)).error).toMatchObject({ code: 'INVALID_CONFIG' });
    expect((await run('config', 'roles', 'list', '--all')).data.proposals.length).toBe(before);
  });

  it('show: a built-in role and an unknown proposal id', async () => {
    const eng = await run('config', 'roles', 'show', 'engineer');
    expect(eng.data).toMatchObject({ kind: 'role', role: { name: 'engineer', builtin: true, contract: 'producer' }, policy: null });
    expect((await run('config', 'roles', 'show', 'rp_00000000')).error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('host-only operations inside the runtime', () => {
  it('apply and remove are rejected in the container and the host runtime; nothing changes', async () => {
    const p = await run('config', 'roles', 'propose', '--file', proposalFile({ ...RESEARCHER, name: 'auditor', workflows: undefined }));
    const configBefore = readFileSync(configFile(), 'utf8');
    for (const mode of ['container', 'host']) {
      process.env.MINIONS_RUNTIME = mode;
      try {
        const apply = await run('config', 'roles', 'apply', p.data.proposalId, '--yes');
        expect(apply.error).toMatchObject({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/runs only in the host CLI/) });
        expect(apply.error!.hint).toContain(`minions config roles apply ${p.data.proposalId}`);
        const remove = await run('config', 'roles', 'remove', 'auditor', '--yes');
        expect(remove.error).toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
      } finally { process.env.MINIONS_RUNTIME = 'container'; }
    }
    expect(readFileSync(configFile(), 'utf8')).toBe(configBefore);
    expect((await run('config', 'roles', 'show', p.data.proposalId)).data.view.state).toBe('pending');
  });

  it('mark-applied refuses a proposal whose role is not in the runtime config, and marks it once it is', async () => {
    const p = await run('config', 'roles', 'propose', '--file', proposalFile({ ...RESEARCHER, name: 'scribe', workflows: undefined }));
    const refused = await run('config', 'roles', 'mark-applied', p.data.proposalId, '--revision', '7');
    expect(refused.error).toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/not in the runtime configuration/) });
    // The host applied it: the regenerated runtime config has the role.
    const original = readFileSync(configFile(), 'utf8');
    const cfg = JSON.parse(original);
    cfg.roles = { scribe: { ...RESEARCHER.role, promptText: RESEARCHER.promptText } };
    writeFileSync(configFile(), JSON.stringify(cfg));
    try {
      const ok = await run('config', 'roles', 'mark-applied', p.data.proposalId, '--revision', '7');
      expect(ok.data).toMatchObject({ id: p.data.proposalId, state: 'applied', appliedRevision: 7 });
      const list = await run('config', 'roles', 'list');
      expect(list.data.roles.map((r: { name: string }) => r.name)).toContain('scribe');
      expect(list.data.proposals.map((x: { id: string }) => x.id)).not.toContain(p.data.proposalId);
    } finally { writeFileSync(configFile(), original); }
  });
});

describe('role_proposals table', () => {
  it('migration 6 adds the table to a v5 database', () => {
    const path = join(tmp(), 'm.db');
    const v5 = new RuntimeDb(path);
    v5.exec('DROP TABLE role_proposals');
    v5.setMeta('schema_version', '5');
    v5.close();
    const up = new RuntimeDb(path);
    try {
      expect(SCHEMA_VERSION).toBe(6);
      expect(up.getMeta('schema_version')).toBe('6');
      up.addRoleProposal({ id: 'rp_00000009', name: 'a', json: '{}' });
      expect(up.roleProposals()).toHaveLength(1);
    } finally { up.close(); }
  });


  it('migrates, supersedes per name and marks applied idempotently', () => {
    const db = new RuntimeDb(':memory:');
    try {
      db.addRoleProposal({ id: 'rp_00000001', name: 'a', json: '{}' });
      const second = db.addRoleProposal({ id: 'rp_00000002', name: 'a', json: '{}' });
      db.addRoleProposal({ id: 'rp_00000003', name: 'b', json: '{}' });
      expect(second.superseded).toEqual(['rp_00000001']);
      expect(db.roleProposals().map((r) => r.id)).toEqual(['rp_00000002', 'rp_00000003']);
      expect(db.markRoleProposalApplied('rp_00000001', 2)).toBe(false);
      expect(db.markRoleProposalApplied('rp_00000002', 2)).toBe(true);
      expect(db.markRoleProposalApplied('rp_00000002', 3)).toBe(true);
      expect(db.roleProposal('rp_00000002')).toMatchObject({ state: 'applied', applied_revision: 2 });
      expect(db.markRoleProposalApplied('rp_missing', 1)).toBe(false);
    } finally { db.close(); }
  });
});
