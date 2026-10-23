// task-33.6 (docs/design/roles-and-workflows.md D2), host side: `config roles apply <id>` reads the proposal
// through the runtime, re-validates it against the host config, shows the diff and the prompt, confirms (or
// --yes), writes the prompt file and the config via editProjectConfig (configRevision + 1, derived files
// regenerated), marks the proposal applied and reports a restart (never restarts, never commits).
// `config roles remove` is refused while a workflow or an active lease uses the role.
// Temp MINIONS_HOME; the fake runtime answers from a real runtime DB and the regenerated runtime config.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { projectPaths, repoPaths } from '../../src/core/paths.js';
import { runInit } from '../../src/host/install.js';
import { loadProjectJson, projectConfigPath, type ProjectJson } from '../../src/host/project.js';
import { applyRoleProposal, lineDiff, removeRole, type RolesHostDeps } from '../../src/host/roles-cli.js';
import type { SettingsRuntime } from '../../src/host/settings-cli.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { markApplied, proposeRole, showProposal } from '../../src/runtime/role-proposals.js';
import { dockerUp, git, makeRepo, withHome } from './fixtures.js';

let env: ReturnType<typeof withHome>;
let db: RuntimeDb;
beforeEach(() => { env = withHome(); db = new RuntimeDb(':memory:'); });
afterEach(() => { db.close(); env.cleanup(); });

const readJson = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Record<string, any>;
const projectDir = (p: ProjectJson) => dirname(projectPaths(p.projectId).configJson);
const runtimeConfigFile = (p: ProjectJson) => join(projectPaths(p.projectId).runtimeDir, 'config.json');
const runtimeConfig = (p: ProjectJson) => validateConfig(readJson(runtimeConfigFile(p)));

async function install(visibility: 'shared' | 'private' = 'private') {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
  const project = await loadProjectJson(r.plan.projectId);
  return { repo, project, file: projectConfigPath(project) };
}

/** A fake runtime backed by the test's runtime DB and the runtime config the host regenerates. */
function fakeRuntime(project: ProjectJson, o: { running?: boolean } = {}) {
  const calls: string[][] = [];
  const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
  const fail = (e: Error & { code?: string }) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code: e.code ?? 'INTERNAL', message: e.message } }) + '\n', stderr: '' });
  const runtime: SettingsRuntime = {
    running: async () => o.running ?? true,
    exec: async (_p, args) => {
      calls.push(args);
      const ctx = { db, config: runtimeConfig(project) };
      try {
        if (args.slice(1, 4).join(' ') === 'config roles show') return ok(await showProposal(ctx, args[4]!));
        if (args.slice(1, 4).join(' ') === 'config roles mark-applied') return ok(markApplied(ctx, args[4]!, Number(args[6])));
        if (args.slice(1, 3).join(' ') === 'work list') return ok({ leases: db.activeLeases() });
      } catch (e) { return fail(e as Error); }
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    },
  };
  return { runtime, calls };
}

const RESEARCHER = {
  name: 'researcher',
  role: {
    description: 'Researches a question and writes findings to a notes file. No code edits.',
    contract: 'producer',
    edits: { paths: ['docs/research/**'] },
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'],
    model: 'sonnet',
  },
  promptText: 'You research the question in the task and write your findings to docs/research/<task-id>.md.\nNever edit code.',
  reason: 'Recurring research tasks need a notes file, not code edits.',
  workflows: { research: ['researcher', 'reviewer'] },
};

async function propose(project: ProjectJson, p: unknown = RESEARCHER): Promise<string> {
  const f = join(env.root, `proposal-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(p));
  return (await proposeRole({ db, config: runtimeConfig(project) }, f)).proposalId;
}

function deps(runtime: SettingsRuntime, answer: boolean | null = true) {
  const asked: string[] = [];
  const shown: string[] = [];
  const d: RolesHostDeps = { runtime, confirm: async (q) => { asked.push(q); return answer; }, show: (t) => shown.push(t) };
  return { d, asked, shown };
}

describe('config roles apply (host)', () => {
  it('shows the diff and the prompt, confirms, writes config + prompt file with configRevision + 1, regenerates, marks applied, reports restart', async () => {
    const { repo, project, file } = await install('private');
    const id = await propose(project);
    const { runtime, calls } = fakeRuntime(project);
    const before = readJson(file);
    const head = git(repo, 'rev-parse', 'HEAD');
    const { d, asked, shown } = deps(runtime, true);
    const r = await applyRoleProposal(project, id, {}, d);

    expect(asked).toEqual([`Apply role proposal ${id} (researcher) to ${file}? (y/N)`]);
    const plan = shown.join('\n');
    expect(plan).toContain('role researcher (new)');
    expect(plan).toContain('roles.researcher (add):');
    expect(plan).toContain('+ {');
    expect(plan).toContain('"prompt": "agents/researcher.md"');
    expect(plan).toContain('workflows.research (add):');
    expect(plan).toContain('+ Never edit code.');

    const after = readJson(file);
    expect(after.configRevision).toBe(before.configRevision + 1);
    expect(after.roles.researcher).toEqual({ ...RESEARCHER.role, prompt: 'agents/researcher.md' });
    expect(after.roles.researcher.promptText).toBeUndefined();
    expect(after.workflows).toEqual({ research: ['researcher', 'reviewer'] });
    const promptFile = join(projectDir(project), 'agents', 'researcher.md');
    expect(r).toMatchObject({ written: true, marked: true, restartRequired: true, revision: before.configRevision + 1, file, promptFile, name: 'researcher', dryRun: false });
    expect(readFileSync(promptFile, 'utf8')).toBe(`${RESEARCHER.promptText}\n`);
    // Derived files: the runtime config and the generated agent definition.
    const rt = runtimeConfig(project);
    expect(rt.configRevision).toBe(before.configRevision + 1);
    expect(rt.roles?.researcher).toMatchObject({ prompt: 'agents/researcher.md', contract: 'producer' });
    const agent = readFileSync(join(projectPaths(project.projectId).pluginDir, 'agents', 'researcher.md'), 'utf8');
    expect(agent).toContain('Never edit code.');
    expect(agent).toContain('name: researcher');
    // Marked applied in the runtime DB, with the revision.
    expect(db.roleProposal(id)).toMatchObject({ state: 'applied', applied_revision: before.configRevision + 1 });
    // Restart required but never performed; nothing committed.
    expect(r.nextSteps.join('\n')).toMatch(/Restart required.*minions settings restart/);
    expect(calls.some((c) => c.includes('restart'))).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('shared install: writes .minions/agents/<name>.md and reminds to commit, without committing', async () => {
    const { repo, project, file } = await install('shared');
    const id = await propose(project, { ...RESEARCHER, workflows: undefined });
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = await applyRoleProposal(project, id, { yes: true }, deps(fakeRuntime(project).runtime, null).d);
    expect(file).toBe(repoPaths(repo).configJson);
    expect(r.promptFile).toBe(join(repo, '.minions', 'agents', 'researcher.md'));
    expect(existsSync(r.promptFile)).toBe(true);
    expect(r.nextSteps[0]).toBe(`Commit ${file} and ${r.promptFile} so the role reaches everyone using this repository.`);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toContain('.minions/');
  });

  it('declined, unconfirmable (--json without --yes) and --dry-run write nothing', async () => {
    const { project, file } = await install('private');
    const id = await propose(project);
    const { runtime } = fakeRuntime(project);
    const text = readFileSync(file, 'utf8');
    const promptFile = join(projectDir(project), 'agents', 'researcher.md');

    await expect(applyRoleProposal(project, id, {}, deps(runtime, false).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/Not confirmed/) });
    await expect(applyRoleProposal(project, id, {}, deps(runtime, null).d)).rejects.toMatchObject({ code: 'POLICY_DENIED', hint: expect.stringMatching(/--yes/) });
    const dry = await applyRoleProposal(project, id, { dryRun: true }, deps(runtime).d);
    expect(dry).toMatchObject({ dryRun: true, written: false, marked: false, revision: readJson(file).configRevision + 1 });
    expect(dry.diff.map((e) => e.path)).toEqual(['roles.researcher', 'workflows.research']);
    expect(dry.prompt.change).toBe('add');

    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(existsSync(promptFile)).toBe(false);
    expect(db.roleProposal(id)!.state).toBe('pending');
  });

  it('refuses applied, superseded and unknown proposals, and needs the runtime', async () => {
    const { project } = await install('private');
    const first = await propose(project, { ...RESEARCHER, workflows: undefined });
    const second = await propose(project, { ...RESEARCHER, workflows: undefined, reason: 'v2' });
    const { runtime } = fakeRuntime(project);
    await expect(applyRoleProposal(project, first, { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/superseded/) });
    await applyRoleProposal(project, second, { yes: true }, deps(runtime).d);
    await expect(applyRoleProposal(project, second, { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/is applied/) });
    await expect(applyRoleProposal(project, 'rp_00000000', { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(applyRoleProposal(project, 'researcher', { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/not a proposal id/) });
    const down = fakeRuntime(project, { running: false }).runtime;
    await expect(applyRoleProposal(project, second, { yes: true }, deps(down).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/runtime is not running/) });
  });

  it('re-validates on the host: a forged proposal in the runtime DB is rejected and nothing is written', async () => {
    const { project, file } = await install('private');
    const text = readFileSync(file, 'utf8');
    const { runtime } = fakeRuntime(project);
    const forged: [string, unknown][] = [
      ['rp_0000000a', { ...RESEARCHER, name: '../../evil' }],
      ['rp_0000000b', { ...RESEARCHER, name: 'engineer' }],
      ['rp_0000000c', { ...RESEARCHER, role: { ...RESEARCHER.role, worktree: 'review', edits: 'any' } }],
      ['rp_0000000d', { ...RESEARCHER, promptText: '---\nname: x\n---' }],
    ];
    for (const [id, p] of forged) {
      db.addRoleProposal({ id, name: String((p as { name: string }).name), json: JSON.stringify(p) });
      await expect(applyRoleProposal(project, id, { yes: true }, deps(runtime).d), id).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(existsSync(join(projectDir(project), 'agents'))).toBe(false);
  });

  it('a changed role shows the prompt and config diff against the current files', async () => {
    const { project } = await install('private');
    const { runtime } = fakeRuntime(project);
    await applyRoleProposal(project, await propose(project, { ...RESEARCHER, workflows: undefined }), { yes: true }, deps(runtime).d);
    const id = await propose(project, { ...RESEARCHER, workflows: undefined, role: { ...RESEARCHER.role, model: 'haiku' }, promptText: `${RESEARCHER.promptText}\nCite sources.` });
    const dry = await applyRoleProposal(project, id, { dryRun: true }, deps(runtime).d);
    expect(dry.summary.change).toBe('change');
    expect(dry.diff).toEqual([expect.objectContaining({ path: 'roles.researcher', change: 'change' })]);
    expect(dry.diff[0]!.lines).toEqual(expect.arrayContaining(['-   "model": "sonnet",', '+   "model": "haiku",']));
    expect(dry.prompt).toMatchObject({ change: 'change' });
    expect(dry.prompt.lines).toContain('+ Cite sources.');
  });
});

describe('config roles remove (host)', () => {
  it('is refused while a workflow or an active lease uses the role; otherwise removes it with configRevision + 1', async () => {
    const { project, file } = await install('private');
    const { runtime } = fakeRuntime(project);
    await applyRoleProposal(project, await propose(project), { yes: true }, deps(runtime).d);

    await expect(removeRole(project, 'researcher', { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/in use: workflow research/) });
    // Drop the workflow by hand (still valid), then an active lease of the role blocks the removal.
    const raw = readJson(file);
    delete raw.workflows;
    writeFileSync(file, JSON.stringify(raw, null, 2));
    db.exec("INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('lease-r1', 'task-9', 'researcher', 1, 1, '2026-10-23T00:00:00Z', 'active')");
    await expect(removeRole(project, 'researcher', { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/1 active lease\(s\) \(lease-r1 on task-9\)/) });
    await expect(removeRole(project, 'researcher', { yes: true }, deps(fakeRuntime(project, { running: false }).runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/runtime is not running/) });
    db.exec("UPDATE leases SET status = 'completed' WHERE id = 'lease-r1'");

    const { d, asked } = deps(runtime, true);
    const before = readJson(file).configRevision;
    const r = await removeRole(project, 'researcher', {}, d);
    expect(asked).toEqual([`Remove role researcher from ${file}? (y/N)`]);
    expect(r).toMatchObject({ written: true, revision: before + 1, restartRequired: true });
    expect(r.diff).toEqual([expect.objectContaining({ path: 'roles.researcher', change: 'remove' })]);
    expect(readJson(file).roles).toBeUndefined();
    expect(readJson(file).configRevision).toBe(before + 1);
    expect(runtimeConfig(project).roles?.researcher).toBeUndefined();
    expect(existsSync(join(projectPaths(project.projectId).pluginDir, 'agents', 'researcher.md'))).toBe(false);
    expect(r.nextSteps.join('\n')).toMatch(/agents\/researcher\.md is left in place/);
  });

  it('refuses built-in and unknown roles', async () => {
    const { project } = await install('private');
    const { runtime } = fakeRuntime(project);
    await expect(removeRole(project, 'engineer', { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION', message: expect.stringMatching(/built-in/) });
    await expect(removeRole(project, 'coordinator', { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'PRECONDITION' });
    await expect(removeRole(project, 'ghost', { yes: true }, deps(runtime).d)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual(['  a', '- b', '+ x', '  c']);
    expect(lineDiff(null, 'a')).toEqual(['+ a']);
    expect(lineDiff('a', null)).toEqual(['- a']);
  });
});
