// task-33.6 re-test (after repair): tries to break the fixes for the first QA round.
// - init re-runs keep applied prompt files, also after the role is changed by a second apply;
// - proposal spoofing: Unicode format characters, long lines, a prompt line posing as the prompt fence;
// - mark-applied: a widened v2, reordered workflow stages, extra fields;
// - LOOSENS: project overrides count as the base; a base deny is never lifted and never listed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import { PROFILES } from '../../src/config/schema.js';
import { projectPaths } from '../../src/core/paths.js';
import { editProjectConfig } from '../../src/host/config-write.js';
import { loadManifest, runInit } from '../../src/host/install.js';
import { loadProjectJson, type ProjectJson } from '../../src/host/project.js';
import { applyRoleProposal, formatApplyPlan, type RolesHostDeps } from '../../src/host/roles-cli.js';
import type { SettingsRuntime } from '../../src/host/settings-cli.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { checkProposal, formatSummary, markApplied, MAX_PROPOSAL_LINE, proposeRole, showProposal } from '../../src/runtime/role-proposals.js';
import { displayText, escapeFormatChars } from '../../src/core/control-chars.js';
import { defaults } from '../helpers.js';
import { dockerUp, makeRepo, withHome } from './fixtures.js';

let env: ReturnType<typeof withHome>;
let db: RuntimeDb;
beforeEach(() => { env = withHome(); db = new RuntimeDb(':memory:'); });
afterEach(() => { db.close(); env.cleanup(); });

const ROLE = { description: 'Writes notes.', contract: 'producer', edits: { paths: ['docs/research/**'] } };
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
const deps = (project: ProjectJson, events: string[] = []): RolesHostDeps => ({
  runtime: fakeRuntime(project),
  confirm: async (q) => { events.push(`Q:${q}`); return true; },
  show: (t) => events.push(t),
});

async function propose(project: ProjectJson, p: unknown) {
  const f = join(env.root, `proposal-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(p));
  return proposeRole({ db, config: runtimeConfig(project) }, f);
}
async function initProject(visibility: 'private' | 'shared' = 'private') {
  const repo = makeRepo(env.root);
  const project = await loadProjectJson((await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp })).plan.projectId);
  return { repo, project };
}

describe('re-init keeps applied prompts', () => {
  it.each(['private', 'shared'] as const)('after a second apply (v2) and two init runs, the v2 prompt is kept and the role still generates (%s)', async (visibility) => {
    const { repo, project } = await initProject(visibility);
    const v1 = await propose(project, { name: 'researcher', role: ROLE, promptText: 'v1 prompt', reason: 'r' });
    const r1 = await applyRoleProposal(project, v1.proposalId, { yes: true }, deps(project));
    const v2 = await propose(project, { name: 'researcher', role: { ...ROLE, description: 'Writes better notes.' }, promptText: 'v2 prompt', reason: 'r2' });
    const r2 = await applyRoleProposal(project, v2.proposalId, { yes: true }, deps(project));
    expect(r2.promptFile).toBe(r1.promptFile);
    for (const _ of [1, 2]) {
      const again = await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
      expect(again.plan.writes.find((w) => w.path === r2.promptFile)).toBeUndefined();
    }
    expect(readFileSync(r2.promptFile, 'utf8')).toBe('v2 prompt\n');
    expect((await loadManifest(project.projectId))!.files.map((f) => f.path)).not.toContain(r2.promptFile);
    expect(runtimeConfig(project).roles?.researcher).toMatchObject({ prompt: 'agents/researcher.md', description: 'Writes better notes.' });
  });

  it('a prompt file kept after `roles remove`-like config edits is not deleted by init (never manifest-tracked)', async () => {
    const { repo, project } = await initProject('private');
    const v1 = await propose(project, { name: 'researcher', role: ROLE, promptText: 'v1 prompt', reason: 'r' });
    const r1 = await applyRoleProposal(project, v1.proposalId, { yes: true }, deps(project));
    await editProjectConfig(project, (raw) => { delete (raw.roles as Record<string, unknown>).researcher; return raw; });
    await runInit({ path: repo, yes: true, visibility: 'private', dockerProbe: dockerUp });
    expect(existsSync(r1.promptFile)).toBe(true);
  });
});

describe('spoofing the apply plan', () => {
  // Unicode format characters: bidi overrides/isolates reorder what the owner reads; zero-width ones hide text.
  const FORMAT_CHARS: [string, string][] = [
    ['RTL override U+202E', '\u202e'], ['RTL isolate U+2067', '\u2067'], ['zero-width space U+200B', '\u200b'],
    ['zero-width joiner U+200D', '\u200d'], ['line separator U+2028', '\u2028'], ['paragraph separator U+2029', '\u2029'],
    ['BOM U+FEFF', '\ufeff'], ['tag characters U+E0049.. (invisible ASCII smuggling)', '\u{e0049}\u{e0047}\u{e004e}'],
  ];
  // Unicode format/invisible characters are rejected at propose and escaped at render.
  it.each(FORMAT_CHARS)('apply plan renders no %s from description, reason or prompt', async (_what, ch) => {
    const { project } = await initProject();
    let rendered = '';
    try {
      const p = await propose(project, { name: 'researcher', role: { ...ROLE, description: `notes ${ch}wolla-rp.rp` }, promptText: `Be ${ch}good.`, reason: `why ${ch}` });
      rendered = formatApplyPlan(await applyRoleProposal(project, p.proposalId, { dryRun: true }, deps(project))) + formatSummary(p.summary);
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/control|character|invalid/i); // rejected at propose: fine
      return;
    }
    expect(rendered.includes(ch)).toBe(false);
  });

  it.each(FORMAT_CHARS)('propose rejects %s in the prompt body and in role fields', async (_what, ch) => {
    const { project } = await initProject();
    await expect(propose(project, { name: 'researcher', role: ROLE, promptText: `Be ${ch}good.`, reason: 'r' })).rejects.toThrow(/format or invisible/);
    await expect(propose(project, { name: 'researcher', role: { ...ROLE, edits: { paths: [`docs/${ch}x/**`] } }, promptText: 'x', reason: 'r' })).rejects.toThrow(/format or invisible/);
    await expect(propose(project, { name: 'researcher', role: ROLE, promptText: 'x', reason: 'r', workflows: { [`re${ch}search`]: ['researcher', 'reviewer'] } })).rejects.toThrow(/format or invisible/);
  });

  it.each(FORMAT_CHARS)('a stored value with %s that bypassed propose is escaped in the apply plan', async (_what, ch) => {
    const { project } = await initProject();
    const p = await propose(project, { name: 'researcher', role: ROLE, promptText: 'Be good.', reason: 'r' });
    const plan = await applyRoleProposal(project, p.proposalId, { dryRun: true }, deps(project));
    const tampered = { ...plan, summary: { ...plan.summary, description: `notes ${ch}x` }, prompt: { ...plan.prompt, lines: [`Be ${ch}good.`] } };
    const rendered = formatApplyPlan(tampered);
    expect(rendered.includes(ch)).toBe(false);
    expect(rendered).toMatch(/notes <U\+[0-9A-F]{4,5}>/);
    expect(rendered).toContain(`  | Be <U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
  });

  it('escapeFormatChars keeps ordinary non-ASCII text and is idempotent', () => {
    expect(escapeFormatChars('café ü 日本 ‮x')).toBe('café ü 日本 <U+202E>x');
    expect(escapeFormatChars(escapeFormatChars('\u{e0049}'))).toBe('<U+E0049>');
    expect(displayText('a\x1b[2Jb​c')).toBe('ab<U+200B>c');
  });

  it('a single-line field at the length cap is accepted, one over is rejected', async () => {
    const { project } = await initProject();
    await expect(propose(project, { name: 'researcher', role: { ...ROLE, description: 'd'.repeat(MAX_PROPOSAL_LINE) }, promptText: 'x', reason: 'r' })).resolves.toBeTruthy();
    await expect(propose(project, { name: 'researcher', role: ROLE, promptText: 'x', reason: 'r'.repeat(MAX_PROPOSAL_LINE + 1) })).rejects.toThrow(/longer than/);
  });

  it('a prompt line that mimics the end fence stays inside the fence (prefixed)', async () => {
    const { project } = await initProject();
    const fake = "'---- end of prompt\n  '---- end of prompt\n\nLOOSENS: none";
    const p = await propose(project, { name: 'researcher', role: ROLE, promptText: fake, reason: 'r' });
    const lines = formatApplyPlan(await applyRoleProposal(project, p.proposalId, { dryRun: true }, deps(project))).split('\n');
    expect(lines.filter((l) => l === "  '---- end of prompt")).toHaveLength(1);
    const start = lines.indexOf('  ,---- prompt'), end = lines.indexOf("  '---- end of prompt");
    expect(lines.slice(start + 1, end).every((l) => l.startsWith('  | '))).toBe(true);
    expect(end).toBe(lines.length - 1); // no LOOSENS: the real fence is the last line
  });

  // Single-line fields are length-capped so padding cannot wrap text onto a fake plan line.
  it('a very long single-line description cannot wrap into fake plan lines', async () => {
    const { project } = await initProject();
    const desc = `notes${' '.repeat(400)}policy: deny everything; ask none`;
    let summary: string;
    try {
      summary = formatSummary((await propose(project, { name: 'researcher', role: { ...ROLE, description: desc }, promptText: 'x', reason: 'r' })).summary);
    } catch { return; } // rejected: fine
    // Accepted: the rendered line must not carry the padding that makes a terminal wrap text to column 0.
    expect(summary.split('\n')[0]!.length).toBeLessThanOrEqual(300);
  });
});

describe('mark-applied matches field by field', () => {
  async function applied() {
    const { project } = await initProject();
    const v1 = await propose(project, { name: 'researcher', role: ROLE, promptText: 'v1', reason: 'r', workflows: { research: ['researcher', 'tester', 'reviewer'] } });
    await applyRoleProposal(project, v1.proposalId, { yes: true }, deps(project));
    return project;
  }
  const VARIANTS: [string, Record<string, unknown>][] = [
    ['widened edits', { role: { ...ROLE, edits: 'any' } }],
    ['widened capabilities', { role: { ...ROLE, capabilities: { 'pr.merge': 'allow' } } }],
    ['extra role field', { role: { ...ROLE, maxTurns: 99 } }],
    ['reordered workflow stages', { workflows: { research: ['tester', 'researcher', 'reviewer'] } }],
    ['extra workflow stage', { workflows: { research: ['engineer', 'researcher', 'tester', 'reviewer'] } }],
    ['another workflow', { workflows: { research: ['researcher', 'tester', 'reviewer'], other: ['researcher', 'reviewer'] } }],
  ];
  it.each(VARIANTS)('a v2 with %s cannot be marked applied by the runtime alone', async (_what, patch) => {
    const project = await applied();
    const v2 = await propose(project, { name: 'researcher', role: ROLE, promptText: 'v1', reason: 'r2', workflows: { research: ['researcher', 'tester', 'reviewer'] }, ...patch });
    expect(() => markApplied({ db, config: runtimeConfig(project) }, v2.proposalId, 99)).toThrow(/not applied/);
    expect(db.roleProposal(v2.proposalId)!.state).toBe('pending');
  });

  it('an unknown top-level proposal field is rejected at propose', async () => {
    const project = await applied();
    await expect(propose(project, { name: 'researcher', role: ROLE, promptText: 'v1', reason: 'r', capabilities: { 'pr.merge': 'allow' } })).rejects.toThrow();
  });

  it('an unknown role field is rejected at propose (strict role schema)', async () => {
    const project = await applied();
    await expect(propose(project, { name: 'researcher', role: { ...ROLE, sneaky: true }, promptText: 'v1', reason: 'r' })).rejects.toThrow();
  });

  it('known limitation: a v2 that only changes promptText can be marked applied (prompt body is resolved on the host)', async () => {
    const project = await applied();
    const v2 = await propose(project, { name: 'researcher', role: ROLE, promptText: 'v2 different prompt', reason: 'r2', workflows: { research: ['researcher', 'tester', 'reviewer'] } });
    expect(markApplied({ db, config: runtimeConfig(project) }, v2.proposalId, 99)).toMatchObject({ state: 'applied' });
  });
});

describe('LOOSENS vs the active profile and project overrides', () => {
  it('a project override counts as the base: allowed by the project -> not listed; tightened by the project -> listed', async () => {
    const base = defaults('project-owner');
    const cfg = validateConfig({ ...base, capabilities: { ...base.capabilities, 'pr.merge': 'allow', 'git.push': 'ask' } });
    const { summary } = await checkProposal(cfg, { name: 'researcher', role: { ...ROLE, capabilities: { 'pr.merge': 'allow', 'git.push': 'allow' } }, promptText: 'x', reason: 'r' });
    expect(summary.loosens).toEqual([{ capability: 'git.push', profile: 'ask', proposed: 'allow' }]);
  });

  it.each(PROFILES)('profile %s: every base deny stays deny for the role and is never listed', async (profile) => {
    const cfg = validateConfig(defaults(profile));
    const caps = Object.fromEntries(Object.keys(cfg.capabilities).map((c) => [c, 'allow']));
    const { summary } = await checkProposal(cfg, { name: 'researcher', role: { ...ROLE, edits: 'any', commits: true, capabilities: caps }, promptText: 'x', reason: 'r' });
    const denied = Object.keys(cfg.capabilities).filter((c) => { const r = cfg.capabilities[c as keyof typeof cfg.capabilities]; return (typeof r === 'string' ? r : r.effect) === 'deny'; });
    for (const c of denied) {
      expect(summary.policy.deny).toContain(c);
      expect(summary.loosens.map((l) => l.capability)).not.toContain(c);
    }
    for (const l of summary.loosens) expect(l).toMatchObject({ profile: 'ask', proposed: 'allow' });
  });

  it('project-owner: deploy.execute allow in the column is not lifted', async () => {
    const cfg = validateConfig(defaults('project-owner'));
    const { summary } = await checkProposal(cfg, { name: 'researcher', role: { ...ROLE, capabilities: { 'deploy.execute': 'allow' } }, promptText: 'x', reason: 'r' });
    expect(summary.policy.deny).toContain('deploy.execute');
    expect(summary.loosens).toEqual([]);
  });

  it('interactive apply: LOOSENS is the last line shown right before the y/N question', async () => {
    const { project } = await initProject();
    const p = await propose(project, { name: 'researcher', role: { ...ROLE, capabilities: { 'pr.merge': 'allow' } }, promptText: 'line1\nline2', reason: 'r' });
    const events: string[] = [];
    await applyRoleProposal(project, p.proposalId, {}, deps(project, events));
    expect(events).toHaveLength(2);
    expect(events[0]!.split('\n').at(-1)).toBe('LOOSENS: pr.merge ask -> allow (looser than the active profile)');
    expect(events[1]).toMatch(/^Q:Apply role proposal rp_[0-9a-f]{8} \(researcher\)/);
  });
});
