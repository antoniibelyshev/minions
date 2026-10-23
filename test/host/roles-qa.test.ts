// task-33.6 QA: cross-feature checks of the role proposal/approval flow (docs/design/roles-and-workflows.md D2).
// - the README "Custom roles" researcher example validates through `propose` under every profile;
// - migration 6 on a v5 runtime DB with data keeps the data and is idempotent across reopenings;
// - known defects found in QA, pinned with `it.fails` (remove `.fails` once fixed):
//   * re-running `minions init` deletes the applied role prompt file (it is tracked in the install manifest
//     as a minions-generated file), so the next start fails on the missing prompt;
//   * the hidden `mark-applied` marks a proposal applied when only the role *name* is configured, even if the
//     configured role differs from the proposal;
//   * the apply plan shown to the owner prints proposal text (description, prompt) with raw terminal control
//     sequences, so a proposal can erase or rewrite the visible diff before the y/N question.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { markApplied, proposeRole, showProposal } from '../../src/runtime/role-proposals.js';
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

describe('QA defects (it.fails until fixed)', () => {
  it.fails.each(['private', 'shared'] as const)('re-running init keeps the applied role prompt file (%s)', async (visibility) => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp })).plan.projectId);
    const id = await propose(project, { name: 'researcher', role: ROLE, promptText: 'Research.', reason: 'r' });
    const r = await applyRoleProposal(project, id, { yes: true }, deps(fakeRuntime(project)));
    expect(existsSync(r.promptFile)).toBe(true);
    await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
    // Today: init plans `remove` for the prompt (manifest entry, not generated by init), so it is deleted and
    // the config's roles.researcher.prompt points at a missing file.
    expect(existsSync(r.promptFile)).toBe(true);
  });

  it.fails('mark-applied refuses a proposal whose content is not what the runtime config has for the role', async () => {
    const config = validateConfig({ ...defaults('project-owner'), roles: { researcher: { ...ROLE, promptText: 'v1' } } });
    db.addRoleProposal({ id: 'rp_0000000b', name: 'researcher', json: JSON.stringify({ name: 'researcher', role: { ...ROLE, edits: 'any' }, promptText: 'v2', reason: 'wider' }) });
    // Today: marked applied (only the role name is checked), so the pending change disappears from `list`.
    expect(() => markApplied({ db, config }, 'rp_0000000b', 9)).toThrow(/not applied/);
  });

  it.fails('the apply plan shown to the owner contains no raw terminal control sequences', async () => {
    const repo = makeRepo(env.root);
    const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp })).plan.projectId);
    const id = await propose(project, {
      name: 'researcher', role: { ...ROLE, description: 'Notes role\x1b[2K', capabilities: { 'pr.merge': 'allow' } },
      // Cursor up 40 lines + erase to the end: hides the summary and the config diff printed before the prompt.
      promptText: 'Be helpful.\n\x1b[40A\x1b[J', reason: 'r',
    });
    const plan = formatApplyPlan(await applyRoleProposal(project, id, { dryRun: true }, deps(fakeRuntime(project))));
    // eslint-disable-next-line no-control-regex
    expect(plan).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});
