// task-33.6 QA: cross-feature checks of the role proposal/approval flow (docs/design/roles-and-workflows.md D2).
// - the README "Custom roles" researcher example validates through `propose` under every profile;
// - migration 6 on a v5 runtime DB with data keeps the data and is idempotent across reopenings;
// - regressions for defects found in QA (fixed in the task-33.6 repair):
//   * re-running `minions init` must keep the applied role prompt file (owner content, not manifest-tracked;
//     init also never removes a config-referenced prompt that an older apply did track);
//   * the hidden `mark-applied` must compare the configured role and workflows with the proposal, not just the name;
//   * proposal text with terminal control sequences is rejected at propose and at host apply, and everything
//     rendered for the owner is stripped, with the prompt body fenced;
//   * capabilities the role gets looser than the active profile are listed on a prominent LOOSENS line.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadManifest } from '../../src/host/install.js';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { PROFILES } from '../../src/config/schema.js';
import { projectPaths } from '../../src/core/paths.js';
import { runInit } from '../../src/host/install.js';
import { loadProjectJson, type ProjectJson } from '../../src/host/project.js';
import { applyRoleProposal, formatApplyPlan, type RolesHostDeps } from '../../src/host/roles-cli.js';
import type { SettingsRuntime } from '../../src/host/settings-cli.js';
import { RuntimeDb, SCHEMA_VERSION } from '../../src/runtime/db.js';
import { checkProposal, formatShow, formatSummary, markApplied, proposeRole, showProposal, type ProposalSummary } from '../../src/runtime/role-proposals.js';
import { defaults } from '../helpers.js';
import { tmp } from '../runtime/fixtures.js';
import { dockerUp, makeRepo, withHome } from './fixtures.js';

/** The JSON block of the README "Custom roles" worked example. */
function readmeResearcher(): string {
  const md = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');
  const section = md.slice(md.indexOf('## Custom roles'));
  const m = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!m) throw new Error('README "Custom roles" has no json example');
  return m[1]!;
}

describe('README Custom roles example', () => {
  it.each(PROFILES)('the researcher proposal validates through propose (%s) and implies the documented policy', async (profile) => {
    const dir = tmp('minions-qa-readme-');
    const file = join(dir, 'researcher.json');
    writeFileSync(file, readmeResearcher());
    const db = new RuntimeDb(':memory:');
    try {
      const r = await proposeRole({ db, config: validateConfig(defaults(profile)) }, file);
      expect(r).toMatchObject({ name: 'researcher', state: 'pending', effective: false });
      expect(r.summary).toMatchObject({ change: 'add', contract: 'producer', edits: { paths: ['docs/research/**'] }, model: 'sonnet', requires: ['network.use'] });
      expect(r.summary.workflows).toEqual([{ name: 'research', stages: ['researcher', 'reviewer'], change: 'add' }]);
      // README: pr.merge, external.*, ci.edit, infrastructure.edit and deploy.execute default to deny.
      expect(r.summary.policy.deny).toEqual(expect.arrayContaining(['pr.merge', 'external.comment', 'ci.edit', 'infrastructure.edit', 'deploy.execute']));
    } finally { db.close(); }
  });
});

describe('migration 6 on a populated v5 database', () => {
  it('keeps leases, meta and events; reopening is idempotent', () => {
    const path = join(tmp('minions-qa-mig-'), 'minions.db');
    const v5 = new RuntimeDb(path);
    v5.exec('DROP INDEX role_proposals_name');
    v5.exec('DROP TABLE role_proposals');
    v5.exec('ALTER TABLE leases DROP COLUMN harness');
    v5.setMeta('schema_version', '5');
    v5.exec("INSERT INTO leases (id, task_id, role, attempt, config_revision, started_at, status) VALUES ('lease-a', 'task-1', 'engineer', 1, 3, '2026-10-23T00:00:00Z', 'active')");
    v5.setMeta('qa_marker', 'kept');
    v5.addEvent('qa-event', 'task-1', { x: 1 });
    v5.close();
    for (const round of [1, 2, 3]) {
      const db = new RuntimeDb(path);
      try {
        if (round === 1) db.addRoleProposal({ id: 'rp_000000aa', name: 'researcher', json: '{"reason":"x"}' });
        expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION));
        expect(db.getMeta('qa_marker')).toBe('kept');
        expect(db.activeLeases().map((l) => l.id)).toEqual(['lease-a']);
        expect(db.roleProposals().map((p) => p.id)).toEqual(['rp_000000aa']);
      } finally { db.close(); }
    }
  });
});

// ---------------------------------------------------------------- host flows

let env: ReturnType<typeof withHome>;
let db: RuntimeDb;
beforeEach(() => { env = withHome(); db = new RuntimeDb(':memory:'); });
afterEach(() => { db.close(); env.cleanup(); });

const runtimeConfig = (p: ProjectJson) => validateConfig(JSON.parse(readFileSync(join(projectPaths(p.projectId).runtimeDir, 'config.json'), 'utf8')));

function fakeRuntime(project: ProjectJson): SettingsRuntime {
  const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify({ ok: true, data }) + '\n', stderr: '' });
  return {
    running: async () => true,
    exec: async (_p, args) => {
      const ctx = { db, config: runtimeConfig(project) };
      if (args.slice(1, 4).join(' ') === 'config roles show') return ok(await showProposal(ctx, args[4]!));
      if (args.slice(1, 4).join(' ') === 'config roles mark-applied') return ok(markApplied(ctx, args[4]!, Number(args[6])));
      return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` };
    },
  };
}

const ROLE = { description: 'Writes notes.', contract: 'producer', edits: { paths: ['docs/research/**'] } };

async function propose(project: ProjectJson, p: unknown): Promise<string> {
  const f = join(env.root, `proposal-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(p));
  return (await proposeRole({ db, config: runtimeConfig(project) }, f)).proposalId;
}

const deps = (runtime: SettingsRuntime, show?: (t: string) => void): RolesHostDeps => ({ runtime, confirm: async () => true, show });

describe('QA defect regressions', () => {
  it.each(['private', 'shared'] as const)('re-running init keeps the applied role prompt file (%s)', async (visibility) => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp })).plan.projectId);
    const id = await propose(project, { name: 'researcher', role: ROLE, promptText: 'Research.', reason: 'r' });
    const r = await applyRoleProposal(project, id, { yes: true }, deps(fakeRuntime(project)));
    expect(existsSync(r.promptFile)).toBe(true);
    await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
    expect(existsSync(r.promptFile)).toBe(true);
    expect(readFileSync(r.promptFile, 'utf8')).toBe('Research.\n');
    expect((await loadManifest(project.projectId))!.files.map((f) => f.path)).not.toContain(r.promptFile);
  });

  it.each(['private', 'shared'] as const)('init keeps a config-referenced prompt that an older apply tracked in the manifest (%s)', async (visibility) => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp })).plan.projectId);
    const id = await propose(project, { name: 'researcher', role: ROLE, promptText: 'Research.', reason: 'r' });
    const r = await applyRoleProposal(project, id, { yes: true }, deps(fakeRuntime(project)));
    // What the first version of apply did: record the prompt as a minions-generated file.
    const { writeGenerated } = await import('../../src/host/install.js');
    await writeGenerated(project.projectId, r.promptFile, Buffer.from('Research.\n'));
    expect((await loadManifest(project.projectId))!.files.map((f) => f.path)).toContain(r.promptFile);
    const again = await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
    expect(again.plan.writes.find((w) => w.path === r.promptFile)).toBeUndefined();
    expect(readFileSync(r.promptFile, 'utf8')).toBe('Research.\n');
    expect((await loadManifest(project.projectId))!.files.map((f) => f.path)).not.toContain(r.promptFile);
  });

  it('mark-applied refuses a proposal whose content is not what the runtime config has for the role', async () => {
    const config = validateConfig({ ...defaults('project-owner'), roles: { researcher: { ...ROLE, promptText: 'v1' } } });
    db.addRoleProposal({ id: 'rp_0000000b', name: 'researcher', json: JSON.stringify({ name: 'researcher', role: { ...ROLE, edits: 'any' }, promptText: 'v2', reason: 'wider' }) });
    expect(() => markApplied({ db, config }, 'rp_0000000b', 9)).toThrow(/not applied: the configured role researcher differs/);
    expect(db.roleProposal('rp_0000000b')!.state).toBe('pending');
  });

  it('mark-applied checks the prompt file and the proposed workflows, and marks a matching proposal', () => {
    const proposal = { name: 'researcher', role: ROLE, promptText: 'v2', reason: 'r', workflows: { research: ['researcher', 'reviewer'] } };
    db.addRoleProposal({ id: 'rp_0000000c', name: 'researcher', json: JSON.stringify(proposal) });
    const base = defaults('project-owner');
    const inline = validateConfig({ ...base, roles: { researcher: { ...ROLE, promptText: 'v1' } }, workflows: { research: ['researcher', 'reviewer'] } });
    expect(() => markApplied({ db, config: inline }, 'rp_0000000c', 9)).toThrow(/configured prompt of researcher/);
    const noWf = validateConfig({ ...base, roles: { researcher: { ...ROLE, prompt: 'agents/researcher.md' } } });
    expect(() => markApplied({ db, config: noWf }, 'rp_0000000c', 9)).toThrow(/workflow research differs/);
    const otherWf = validateConfig({ ...base, roles: { researcher: { ...ROLE, prompt: 'agents/researcher.md' } }, workflows: { research: ['engineer', 'researcher', 'reviewer'] } });
    expect(() => markApplied({ db, config: otherWf }, 'rp_0000000c', 9)).toThrow(/workflow research differs/);
    const applied = validateConfig({ ...base, roles: { researcher: { ...ROLE, prompt: 'agents/researcher.md' } }, workflows: { research: ['researcher', 'reviewer'] } });
    expect(markApplied({ db, config: applied }, 'rp_0000000c', 9)).toMatchObject({ state: 'applied', appliedRevision: 9 });
  });

  const SPOOFS: [string, Record<string, unknown>, RegExp][] = [
    // Cursor up 40 lines + erase to the end: hides the summary and the config diff printed before the prompt.
    ['ESC in promptText', { promptText: 'Be helpful.\n\x1b[40A\x1b[J' }, /promptText: contains a control character/],
    ['C1 CSI in promptText', { promptText: 'Be helpful.\x9b2K' }, /promptText: contains a control character/],
    ['CR in promptText', { promptText: 'Be helpful.\rrole x' }, /promptText: contains a control character/],
    ['ESC in description', { role: { ...ROLE, description: 'Notes role\x1b[2K' } }, /role\.description: contains a control character/],
    ['newline in description', { role: { ...ROLE, description: 'Notes\n  policy: deny everything' } }, /role\.description: contains a control character or line break/],
    ['newline in reason', { reason: 'r\nrole researcher (new): harmless' }, /reason: contains a control character or line break/],
    ['OSC in an edit path', { role: { ...ROLE, edits: { paths: ['docs/\x1b]0;x\x07**'] } } }, /role\.edits\.paths\[0\]: contains a control character/],
  ];
  it.each(SPOOFS)('propose rejects proposal text with terminal controls (%s)', async (_what, patch, msg) => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp })).plan.projectId);
    await expect(propose(project, { name: 'researcher', role: ROLE, promptText: 'Research.', reason: 'r', ...patch })).rejects.toThrow(msg);
    expect(db.roleProposals()).toEqual([]);
  });

  it('newlines and tabs stay allowed in promptText', async () => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp })).plan.projectId);
    await expect(propose(project, { name: 'researcher', role: ROLE, promptText: 'Research.\n\t- step one\n', reason: 'r' })).resolves.toMatch(/^rp_/);
  });

  it('host apply re-checks: a spoofing proposal planted in the runtime DB is rejected and nothing is written', async () => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp })).plan.projectId);
    const cfgPath = join(projectPaths(project.projectId).dir, 'config.json');
    const before = readFileSync(cfgPath, 'utf8');
    db.addRoleProposal({ id: 'rp_000000dd', name: 'researcher', json: JSON.stringify({ name: 'researcher', role: ROLE, promptText: 'ok\n\x1b[40A\x1b[J', reason: 'r' }) });
    const shown: string[] = [];
    await expect(applyRoleProposal(project, 'rp_000000dd', {}, deps(fakeRuntime(project), (t) => shown.push(t)))).rejects.toThrow(/promptText: contains a control character/);
    expect(shown).toEqual([]);
    expect(readFileSync(cfgPath, 'utf8')).toBe(before);
    // `show` of the planted row renders without the escape sequences.
    // eslint-disable-next-line no-control-regex
    expect(formatShow(await showProposal({ db, config: runtimeConfig(project) }, 'rp_000000dd'))).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it('rendering strips control characters and fences the prompt so it cannot pose as plan lines', async () => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp })).plan.projectId);
    const id = await propose(project, { name: 'researcher', role: ROLE, promptText: 'Be helpful.\nconfig /etc/x (configRevision 1):\nrole researcher (new): fine', reason: 'r' });
    const r = await applyRoleProposal(project, id, { dryRun: true }, deps(fakeRuntime(project)));
    // Defence in depth: a summary that somehow carries controls is still rendered clean.
    r.summary = { ...r.summary, description: 'x\x1b[2K\x9b1Ay' };
    r.prompt.lines = [...r.prompt.lines, '+ \x1b[40A\x1b[J'];
    const plan = formatApplyPlan(r);
    // eslint-disable-next-line no-control-regex
    expect(plan).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(plan).toContain('role researcher (new): xy');
    const lines = plan.split('\n');
    const start = lines.indexOf('  ,---- prompt'), end = lines.indexOf("  '---- end of prompt");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    for (const l of lines.slice(start + 1, end)) expect(l.startsWith('  | ')).toBe(true);
    expect(lines.slice(start + 1, end)).toContain('  | + config /etc/x (configRevision 1):');
  });
});

describe('loosening is stated explicitly', () => {
  it('propose summary and the host apply plan list each capability the role gets looser than the profile', async () => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp })).plan.projectId);
    const p = { name: 'researcher', role: { ...ROLE, capabilities: { 'pr.merge': 'allow', 'ci.edit': 'allow', 'external.comment': 'allow' } }, promptText: 'Research.', reason: 'r' };
    const f = join(env.root, 'loose.json');
    writeFileSync(f, JSON.stringify(p));
    const proposed = await proposeRole({ db, config: runtimeConfig(project) }, f);
    // project-owner has these at ask.
    expect(proposed.summary.loosens).toEqual([
      { capability: 'external.comment', profile: 'ask', proposed: 'allow' },
      { capability: 'pr.merge', profile: 'ask', proposed: 'allow' },
      { capability: 'ci.edit', profile: 'ask', proposed: 'allow' },
    ]);
    const line = '  LOOSENS: external.comment ask -> allow, pr.merge ask -> allow, ci.edit ask -> allow (looser than the active profile)';
    expect(formatSummary(proposed.summary).split('\n')[1]).toBe(line);
    const plan = formatApplyPlan(await applyRoleProposal(project, proposed.proposalId, { dryRun: true }, deps(fakeRuntime(project))));
    expect(plan.split('\n')[1]).toBe(line);
    expect(plan.split('\n').at(-1)).toBe(line.trim()); // repeated right before the question
  });

  it('a role within the profile has no LOOSENS line', async () => {
    const config = validateConfig(defaults('project-owner'));
    const { summary } = await checkProposal(config, { name: 'researcher', role: { ...ROLE, capabilities: { 'pr.merge': 'deny' } }, promptText: 'x', reason: 'r' });
    expect(summary.loosens).toEqual([]);
    expect(formatSummary(summary)).not.toMatch(/LOOSENS/);
  });

  it('formatSummary tolerates a summary without loosens (older runtime)', () => {
    const s = { name: 'r', change: 'add', description: 'd', contract: 'producer', worktree: 'none', stageStatus: 'complete', edits: 'none', commits: false, tools: [], model: null, effort: null, maxTurns: 1, deepVariant: false, requires: [], policy: { deny: [], ask: [] }, workflows: [], promptBytes: 1 } as unknown as ProposalSummary;
    expect(formatSummary(s)).not.toMatch(/LOOSENS/);
  });
});
