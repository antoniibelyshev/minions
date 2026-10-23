import { describe, expect, it } from 'vitest';
import { can } from '../src/config/capabilities.js';
import { resolve, validateConfig } from '../src/config/resolve.js';
import {
  BUILTIN_WORKER_ROLES, CUSTOM_ROLE_DENY_BY_DEFAULT, baseRoleName, engineerDeepEffort, isRegisteredRole, registeredRoleNames,
  roleEffort, roleLimit, roleNameProblem, roleRegistry, workerRole, workerRoleNames,
} from '../src/config/roles.js';
import { CAPABILITIES, type MinionsConfig } from '../src/config/schema.js';
import { MinionsError } from '../src/core/errors.js';
import { renderCapabilityTable } from '../src/plugin/generate.js';
import type { Lease } from '../src/runtime/db.js';
import { capacityOf } from '../src/runtime/scheduler.js';
import { defaults } from './helpers.js';

const researcher = {
  description: 'Researches a question and writes findings to a notes file.',
  promptText: 'Research the question in the brief.',
  contract: 'producer',
  edits: { paths: ['docs/research/**'] },
} as const;

const withRoles = (roles: Record<string, unknown>, patch: Partial<MinionsConfig> = {}): MinionsConfig =>
  validateConfig({ ...defaults(), ...patch, roles });

function fail(fn: () => unknown): MinionsError {
  try { fn(); } catch (e) { if (e instanceof MinionsError) return e; throw e; }
  throw new Error('expected a MinionsError');
}
const issuesOf = (fn: () => unknown) => {
  const e = fail(fn);
  return JSON.stringify({ message: e.message, details: e.details });
};

describe('role registry', () => {
  it('is the three built-ins (plus the coordinator) without roles config', () => {
    const cfg = defaults();
    expect(workerRoleNames(cfg)).toEqual([...BUILTIN_WORKER_ROLES]);
    expect(registeredRoleNames(cfg)).toEqual(['coordinator', 'engineer', 'tester', 'reviewer']);
    const [eng, tester, reviewer] = roleRegistry(cfg);
    expect(eng).toMatchObject({ name: 'engineer', builtin: true, contract: 'producer', worktree: 'branch', stageStatus: 'implementing', edits: 'any', commits: true, deepVariant: true, maxTurns: 80 });
    expect(tester).toMatchObject({ contract: 'verifier', stageStatus: 'testing' });
    expect(reviewer).toMatchObject({ contract: 'gate', worktree: 'review', edits: 'none', commits: false });
    expect(isRegisteredRole(cfg, 'researcher')).toBe(false);
  });

  it('adds configured roles with D3 defaults', () => {
    const cfg = withRoles({ researcher, judge: { description: 'Judges.', promptText: 'x', contract: 'gate' }, checker: { description: 'c', prompt: 'agents/checker.md', contract: 'verifier', edits: 'any', commits: false, maxTurns: 20, deepVariant: true } });
    expect(workerRoleNames(cfg)).toEqual(['engineer', 'tester', 'reviewer', 'researcher', 'judge', 'checker']);
    expect(workerRole(cfg, 'researcher')).toMatchObject({ builtin: false, contract: 'producer', worktree: 'branch', stageStatus: 'implementing', edits: { paths: ['docs/research/**'] }, commits: true, deepVariant: false, maxTurns: 80 });
    expect(workerRole(cfg, 'judge')).toMatchObject({ worktree: 'review', stageStatus: 'reviewing', edits: 'none', commits: false });
    expect(workerRole(cfg, 'checker')).toMatchObject({ stageStatus: 'testing', edits: 'any', commits: false, maxTurns: 20, prompt: 'agents/checker.md' });
    expect(isRegisteredRole(cfg, 'researcher')).toBe(true);
    expect(workerRole(cfg, 'nobody')).toBeUndefined();
  });

  it('resolves -deep only for roles with a deep variant', () => {
    const cfg = withRoles({ researcher, checker: { description: 'c', promptText: 'x', contract: 'verifier', deepVariant: true } });
    expect(baseRoleName(cfg, 'engineer-deep')).toBe('engineer');
    expect(baseRoleName(cfg, 'checker-deep')).toBe('checker');
    expect(baseRoleName(cfg, 'researcher-deep')).toBe('researcher-deep');
    expect(baseRoleName(cfg, 'tester-deep')).toBe('tester-deep');
    expect(isRegisteredRole(cfg, 'engineer-deep')).toBe(false);
  });

  it('enforces the name rules', () => {
    expect(roleNameProblem('researcher')).toBeNull();
    expect(roleNameProblem('deploy-engineer')).toBeNull();
    for (const bad of ['Researcher', 'r', '1abc', 'a_b', 'x'.repeat(32), 'coordinator', 'writer-deep', 'orchestrate', 'status', 'recover', 'intake', 'maintain-context']) {
      expect(roleNameProblem(bad), bad).not.toBeNull();
      expect(issuesOf(() => withRoles({ [bad]: researcher })), bad).toContain(`roles.${bad}`);
    }
  });

  it('allows only the D9 override fields on built-ins', () => {
    const cfg = withRoles({ engineer: { promptAppend: 'Use pnpm.', model: 'opus', effort: 'high', maxTurns: 50, tools: ['Read', 'Bash'], deepEffort: 'max' }, reviewer: { prompt: 'agents/review-notes.md' } });
    expect(workerRole(cfg, 'engineer')).toMatchObject({ builtin: true, contract: 'producer', model: 'opus', effort: 'high', maxTurns: 50, tools: ['Read', 'Bash'], promptText: 'Use pnpm.' });
    expect(workerRole(cfg, 'reviewer')).toMatchObject({ contract: 'gate', prompt: 'agents/review-notes.md' });
    for (const field of [{ contract: 'gate' }, { stageStatus: 'testing' }, { capabilities: { 'pr.merge': 'allow' } }, { description: 'x' }]) {
      expect(issuesOf(() => withRoles({ tester: field })), JSON.stringify(field)).toContain('roles.tester');
    }
    expect(issuesOf(() => withRoles({ tester: { deepEffort: 'high' } }))).toContain('roles.tester');
    expect(issuesOf(() => withRoles({ reviewer: { tools: ['Read', 'Edit'] } }))).toContain('may only remove tools');
    expect(issuesOf(() => withRoles({ engineer: { prompt: 'a.md', promptAppend: 'b' } }))).toContain('at most one of prompt and promptAppend');
  });

  it('checks project role fields', () => {
    expect(issuesOf(() => withRoles({ r1: { description: 'd', contract: 'producer' } }))).toContain('exactly one of prompt and promptText');
    expect(issuesOf(() => withRoles({ r1: { ...researcher, prompt: 'agents/r1.md' } }))).toContain('exactly one of prompt and promptText');
    expect(issuesOf(() => withRoles({ r1: { description: 'd', contract: 'producer', prompt: '../outside.md' } }))).toContain('roles.r1.prompt');
    expect(issuesOf(() => withRoles({ r1: { description: 'd', contract: 'producer', prompt: '/etc/passwd' } }))).toContain('roles.r1.prompt');
    expect(issuesOf(() => withRoles({ r1: { ...researcher, model: 'gpt-5' } }))).toContain('not in models.allowed');
    expect(issuesOf(() => withRoles({ r1: { ...researcher, contract: 'gate' } }))).toContain('review worktree is read-only');
    expect(issuesOf(() => withRoles({ r1: { description: 'd', promptText: 'x', contract: 'producer', commits: true } }))).toContain('cannot commit');
    expect(issuesOf(() => withRoles({ r1: { ...researcher, tools: ['Read', 'Bash npm'] } }))).toContain('roles.r1.tools');
    expect(issuesOf(() => withRoles({ r1: { ...researcher, requires: ['launch.rockets'] } }))).toContain('roles.r1.requires');
    expect(issuesOf(() => withRoles({ r1: { ...researcher, repairTo: 'engineer' } }))).toContain('roles.r1');
    expect(() => withRoles({ r1: { ...researcher, tools: ['Read', 'WebSearch', 'mcp__x__*', 'Bash(git)'] } })).not.toThrow();
  });

  it('validates capability sub-rule roles against the registry', () => {
    const d = defaults();
    const rule = (role: string) => ({ ...d.capabilities, 'pr.review': { effect: 'allow' as const, rules: [{ effect: 'deny' as const, roles: [role] }] } });
    expect(issuesOf(() => validateConfig({ ...d, capabilities: rule('researcher') }))).toContain('unknown role \\"researcher\\"');
    expect(can(withRoles({ researcher }, { capabilities: rule('researcher') }), 'pr.review', { role: 'researcher' })).toBe('deny');
    expect(() => validateConfig({ ...d, capabilities: rule('coordinator') })).not.toThrow();
  });
});

describe('effort precedence', () => {
  it('roles.<r>.effort > models.effortByRole.<r> > models.effort', () => {
    const d = defaults();
    const models = { ...d.models, effort: 'low' as const, effortByRole: { engineer: 'medium' as const, tester: 'medium' as const } };
    const cfg = withRoles({ engineer: { effort: 'xhigh' }, researcher: { ...researcher, effort: 'high' }, writer: { ...researcher } }, { models });
    expect(roleEffort(cfg, 'engineer')).toBe('xhigh');
    expect(roleEffort(cfg, 'tester')).toBe('medium');
    expect(roleEffort(cfg, 'reviewer')).toBe('low');
    expect(roleEffort(cfg, 'researcher')).toBe('high');
    expect(roleEffort(cfg, 'writer')).toBe('low');
    expect(roleEffort(cfg, 'coordinator')).toBe('low');
    expect(roleEffort(d, 'engineer')).toBeUndefined();
  });

  it('engineer deep effort: roles.engineer.deepEffort > effortByRole.engineerDeep > one above the engineer', () => {
    const d = defaults();
    expect(engineerDeepEffort(d)).toBe('high');
    expect(engineerDeepEffort(withRoles({ engineer: { effort: 'high' } }))).toBe('xhigh');
    const models = { ...d.models, effortByRole: { engineerDeep: 'medium' as const } };
    expect(engineerDeepEffort(withRoles({}, { models }))).toBe('medium');
    expect(engineerDeepEffort(withRoles({ engineer: { deepEffort: 'max' } }, { models }))).toBe('max');
  });
});

describe('policy columns', () => {
  it('denies unknown roles everything', () => {
    const d = defaults();
    for (const c of CAPABILITIES) expect(can(d, c, { role: 'researcher' }), c).toBe('deny');
    expect(can(d, 'task.read', { role: 'engineer-deep' })).toBe('deny');
    expect(can(d, 'task.read', { role: 'engineer' })).toBe('allow');
    expect(can(d, 'task.read')).toBe('allow');
  });

  it('gives project roles the base effect, D8 default denies and edits/commits-derived columns', () => {
    const cfg = withRoles({ researcher, judge: { description: 'j', promptText: 'x', contract: 'gate' } });
    expect(CUSTOM_ROLE_DENY_BY_DEFAULT).toEqual(['external.read', 'external.comment', 'external.changeStatus', 'external.create', 'pr.merge', 'ci.edit', 'infrastructure.edit', 'deploy.execute']);
    for (const c of CUSTOM_ROLE_DENY_BY_DEFAULT) expect(can(cfg, c, { role: 'researcher' }), c).toBe('deny');
    expect(can(cfg, 'task.read', { role: 'researcher' })).toBe('allow');
    expect(can(cfg, 'network.use', { role: 'researcher' })).toBe('allow');
    expect(can(cfg, 'code.edit', { role: 'researcher' })).toBe('allow');
    expect(can(cfg, 'git.commit', { role: 'researcher' })).toBe('allow');
    expect(can(cfg, 'code.edit', { role: 'judge' })).toBe('deny');
    expect(can(cfg, 'git.commit', { role: 'judge' })).toBe('deny');
    // Built-in columns are untouched by project roles.
    expect(can(cfg, 'pr.merge', { role: 'engineer' })).toBe(can(defaults(), 'pr.merge', { role: 'engineer' }));
  });

  it('applies explicit column entries like hand-written sub-rules; a base deny still wins', () => {
    const cfg = withRoles({ researcher: { ...researcher, capabilities: { 'pr.review': 'deny', 'external.read': 'allow', 'pr.merge': 'allow', 'deploy.execute': 'allow', 'code.edit': 'allow' } },
      notes: { description: 'n', promptText: 'x', contract: 'producer', capabilities: { 'code.edit': 'allow' } } });
    expect(can(cfg, 'pr.review', { role: 'researcher' })).toBe('deny');
    expect(can(cfg, 'external.read', { role: 'researcher' })).toBe('allow');
    expect(can(cfg, 'pr.merge', { role: 'researcher' })).toBe('allow');
    expect(can(cfg, 'pr.merge', { role: 'researcher', paths: ['.github/workflows/ci.yml'] })).toBe('ask');
    expect(can(cfg, 'deploy.execute', { role: 'researcher' })).toBe('deny');
    // edits: none keeps code.edit denied even when the column says allow.
    expect(can(cfg, 'code.edit', { role: 'notes' })).toBe('deny');
  });

  it('a local layer cannot lift a project role column deny', () => {
    const project = { roles: { researcher: { ...researcher, capabilities: { 'pr.review': 'deny' } } } };
    const e = fail(() => resolve({ defaults: defaults(), project, local: { roles: { researcher: { capabilities: { 'pr.review': 'allow' } } } } }));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toContain('roles.researcher');
    expect(() => resolve({ defaults: defaults(), project, local: { roles: { researcher: { maxTurns: 10 } } } })).not.toThrow();
  });

  it('renders one capability-table column per registered role', () => {
    const header = (cfg: MinionsConfig) => renderCapabilityTable(cfg).split('\n')[0];
    expect(header(defaults())).toBe('| Capability | coordinator | engineer | tester | reviewer | Path rules |');
    const cfg = withRoles({ researcher });
    const table = renderCapabilityTable(cfg).split('\n');
    expect(table[0]).toBe('| Capability | coordinator | engineer | tester | reviewer | researcher | Path rules |');
    expect(table[1]).toBe('| - | - | - | - | - | - | - |');
    expect(table.find((l) => l.startsWith('| pr.merge |'))).toBe('| pr.merge | ask | ask | ask | ask | deny |  |');
  });
});

describe('per-role capacity', () => {
  const lease = (task: string, role: string): Lease => ({ id: `l-${task}`, task_id: task, role } as unknown as Lease);
  const exec = (d: MinionsConfig, e: Record<string, unknown>) => ({ ...d.execution, ...e });

  it('keeps maxEngineers as an alias of maxByRole.engineer', () => {
    const d = defaults();
    expect(roleLimit(d, 'engineer')).toBe(2);
    expect(roleLimit(d, 'tester')).toBeUndefined();
    const { maxEngineers: _, ...noAlias } = d.execution;
    const cfg = validateConfig({ ...d, execution: { ...noAlias, maxByRole: { engineer: 1, tester: 1 } } });
    expect(roleLimit(cfg, 'engineer')).toBe(1);
    expect(roleLimit(cfg, 'tester')).toBe(1);
    expect(() => validateConfig({ ...d, execution: exec(d, { maxByRole: { engineer: 2 } }) })).not.toThrow();
    const e = fail(() => validateConfig({ ...d, execution: exec(d, { maxByRole: { engineer: 1 } }) }));
    expect(e.code).toBe('INVALID_CONFIG');
    expect(issuesOf(() => validateConfig({ ...d, execution: exec(d, { maxByRole: { engineer: 1 } }) }))).toContain('alias of execution.maxByRole.engineer and must agree');
    const unbounded = validateConfig({ ...d, execution: noAlias });
    expect(roleLimit(unbounded, 'engineer')).toBeUndefined();
  });

  it('rejects unknown roles and limits above maxActiveTasks', () => {
    const d = defaults();
    expect(issuesOf(() => validateConfig({ ...d, execution: exec(d, { maxByRole: { researcher: 1 } }) }))).toContain('execution.maxByRole.researcher');
    expect(issuesOf(() => validateConfig({ ...d, execution: exec(d, { maxByRole: { 'engineer-deep': 1 } }) }))).toContain('execution.maxByRole.engineer-deep');
    expect(issuesOf(() => validateConfig({ ...d, execution: exec(d, { maxByRole: { coordinator: 1 } }) }))).toContain('execution.maxByRole.coordinator');
    expect(issuesOf(() => validateConfig({ ...d, execution: exec(d, { maxByRole: { tester: 3 } }) }))).toContain('must be <= execution.maxActiveTasks');
    expect(issuesOf(() => validateConfig({ ...d, execution: exec(d, { maxEngineers: 3 }) }))).toContain('must be <= execution.maxActiveTasks');
    expect(() => withRoles({ researcher }, { execution: exec(d, { maxByRole: { researcher: 1 } }) as MinionsConfig['execution'] })).not.toThrow();
  });

  it('lets a layer set either alias without contradicting the lower layers', () => {
    const r1 = resolve({ defaults: defaults(), project: { execution: { maxByRole: { engineer: 1 } } } }).config;
    expect(r1.execution).toMatchObject({ maxEngineers: 1, maxByRole: { engineer: 1 } });
    const r2 = resolve({ defaults: defaults(), project: { execution: { maxByRole: { engineer: 1 } } }, local: { execution: { maxEngineers: 2 } } }).config;
    expect(r2.execution).toMatchObject({ maxEngineers: 2, maxByRole: { engineer: 2 } });
    expect(fail(() => resolve({ defaults: defaults(), project: { execution: { maxEngineers: 1, maxByRole: { engineer: 2 } } } })).code).toBe('INVALID_CONFIG');
    const s = resolve({ defaults: defaults(), project: { execution: { maxByRole: { engineer: 2, tester: 2 } } }, session: { execution: { maxEngineers: 1, maxByRole: { tester: 1 } } } }).config;
    expect(s.execution).toMatchObject({ maxEngineers: 1, maxByRole: { engineer: 1, tester: 1 } });
    expect(fail(() => resolve({ defaults: defaults(), session: { execution: { maxByRole: { tester: 5 } } } })).code).toBe('POLICY_DENIED');
  });

  it('reports byRole and keeps the engineer fields', () => {
    const d = defaults();
    const cfg = withRoles({ researcher }, { execution: exec(d, { maxByRole: { engineer: 2, researcher: 1 } }) as MinionsConfig['execution'] });
    const cap = capacityOf(cfg, [lease('a', 'engineer'), lease('b', 'researcher'), lease('c', 'tester')], []);
    expect(cap.byRole).toEqual({
      engineer: { active: 1, max: 2, free: 1, limited: true },
      tester: { active: 1, max: 2, free: 1, limited: false },
      reviewer: { active: 0, max: 2, free: 2, limited: false },
      researcher: { active: 1, max: 1, free: 0, limited: true },
    });
    expect(cap).toMatchObject({ activeEngineers: 1, maxEngineers: 2, freeEngineerSlots: 1, maxActiveTasks: 2, freeTaskSlots: 0 });
    const old = capacityOf(d, [lease('a', 'engineer'), lease('b', 'engineer')], []);
    expect(old).toMatchObject({ activeEngineers: 2, maxEngineers: 2, freeEngineerSlots: 0 });
    expect(Object.keys(old.byRole)).toEqual(['engineer', 'tester', 'reviewer']);
  });
});

describe('back-compat', () => {
  it('configs without roles validate unchanged', () => {
    for (const p of ['project-owner', 'personal-work', 'supervised'] as const) {
      const d = defaults(p);
      expect(validateConfig(structuredClone(d))).toEqual(d);
      expect(d.roles).toBeUndefined();
    }
  });
});
