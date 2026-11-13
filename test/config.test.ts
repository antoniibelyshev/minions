import { describe, expect, it } from 'vitest';
import { modeDefaults } from '../src/config/modes.js';
import { applyControl, resolve, validateConfig } from '../src/config/resolve.js';
import { CAPABILITIES } from '../src/config/schema.js';
import { MinionsError } from '../src/core/errors.js';
import { ctx, defaults } from './helpers.js';

const fail = (fn: () => unknown): MinionsError => {
  try { fn(); } catch (e) { if (e instanceof MinionsError) return e; throw e; }
  throw new Error('expected a MinionsError');
};

describe('modes', () => {
  it('independent yields documented explicit defaults', () => {
    const c = modeDefaults('independent', ctx);
    expect(validateConfig(c)).toEqual(c);
    expect(c).toMatchObject({
      schemaVersion: 1, configRevision: 1, projectId: ctx.projectId, packageVersion: '0.1.0',
      mode: 'independent', visibility: 'shared', architecture: 'decide',
      backlog: { backend: 'backlogmd', ownership: 'direct' },
      intake: { sources: ['user', 'milestone'], startReady: true },
      delivery: { merge: 'auto-when-eligible' },
      communication: { channel: 'auto' },
      budgets: { dailyUsd: 20, taskUsd: 5 },
      container: { mountDockerSocket: false, mountHostRepository: false, cpus: 4, memoryMiB: 6144, pidsLimit: 512 },
      execution: { maxActiveTasks: 3, maxEngineers: 2 },
      coordinator: { sessions: { enabled: true, threads: true } },
      routine: { enabled: true, digestAt: ['09:00'] },
      git: { baseBranch: 'main', identity: ctx.identity },
    });
    // The coordinator permission mode is left unset: auto by default (opt-out: coordinator.permissionMode).
    expect(c).not.toHaveProperty('permissionMode');
    expect(Object.keys(c.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    for (const cap of CAPABILITIES) {
      const r = c.capabilities[cap];
      expect(typeof r === 'string' ? r : r.effect).toBe(cap === 'deploy.execute' ? 'deny' : 'allow');
    }
    expect(c.capabilities['code.edit']).toEqual({ effect: 'allow', rules: [{ effect: 'deny', roles: ['reviewer'] }] });
    expect(c.sensitivePaths).toEqual(['.claude/**', '.minions/**', 'CLAUDE.md', 'AGENTS.md', '.githooks/**', '.husky/**', '.github/workflows/**']);
  });

  it('budgets: token caps are optional whole positive numbers (or null); the modes leave them unset', () => {
    const base = defaults();
    expect(base.budgets).not.toHaveProperty('dailyTokens');
    expect(modeDefaults('independent', ctx).budgets).toEqual({ dailyUsd: 20, taskUsd: 5 });
    const ok = validateConfig({ ...base, budgets: { dailyUsd: null, taskUsd: 25, dailyTokens: 20_000_000, taskTokens: null } });
    expect(ok.budgets).toEqual({ dailyUsd: null, taskUsd: 25, dailyTokens: 20_000_000, taskTokens: null });
    for (const bad of [{ dailyTokens: 0 }, { dailyTokens: -5 }, { taskTokens: 1.5 }, { taskTokens: '4M' }, { weeklyTokens: 1 }]) {
      expect(() => validateConfig({ ...base, budgets: { dailyUsd: null, taskUsd: null, ...bad } }), JSON.stringify(bad)).toThrow(MinionsError);
    }
  });

  it('supervised yields documented explicit defaults', () => {
    const c = modeDefaults('supervised', ctx);
    validateConfig(c);
    expect(c).toMatchObject({ mode: 'supervised', visibility: 'private', architecture: 'propose', intake: { startReady: true },
      execution: { maxActiveTasks: 2, maxEngineers: 1 }, delivery: { merge: 'disabled' }, communication: { channel: 'terminal' },
      budgets: { dailyUsd: null, taskUsd: null } });
    expect(c).not.toHaveProperty('coordinator');
    expect(c).not.toHaveProperty('routine');
    expect(c.capabilities['base.merge']).toBe('deny');
    expect(c.capabilities['ci.edit']).toBe('allow');
    expect(c.capabilities['deploy.execute']).toBe('deny');
    expect(c.sensitivePaths).toContain('**/migrations/**');
  });

  it('loads configs written with the old profiles: profile becomes mode, external.* capabilities are dropped', () => {
    const { mode: _m, ...raw } = defaults();
    for (const [profile, mode] of [['project-owner', 'independent'], ['personal-work', 'supervised'], ['supervised', 'supervised']] as const) {
      const old = { ...raw, profile, capabilities: { ...raw.capabilities, 'external.read': 'allow', 'external.comment': 'ask', 'external.changeStatus': 'deny', 'external.create': 'ask' } };
      const c = validateConfig(old);
      expect(c.mode).toBe(mode);
      expect(c).not.toHaveProperty('profile');
      expect(Object.keys(c.capabilities).some((k) => k.startsWith('external.'))).toBe(false);
    }
    // An explicit mode wins over a leftover profile.
    expect(validateConfig({ ...raw, mode: 'supervised', profile: 'project-owner' }).mode).toBe('supervised');
    expect(fail(() => validateConfig({ ...raw, profile: 'other' })).message).toContain('mode');
  });
});

describe('validation', () => {
  it('rejects unknown fields with dotted path', () => {
    const e = fail(() => resolve({ defaults: defaults(), project: { execution: { maxWorkers: 3 } } }));
    expect(e.code).toBe('INVALID_CONFIG');
    expect(e.message).toContain('execution.maxWorkers: unknown field');
  });

  it('rejects model ids and base branches that could inject into frontmatter or git argv', () => {
    const d = defaults();
    for (const m of ['sonnet\ntools: Agent', 'opus # x']) {
      expect(fail(() => validateConfig({ ...d, models: { ...d.models, default: m, allowed: [m] } })).message).toContain('models.');
    }
    for (const b of ['--upload-pack=x', 'a..b', 'main branch']) {
      expect(fail(() => validateConfig({ ...d, git: { ...d.git, baseBranch: b } })).message).toContain('git.baseBranch');
    }
    expect(validateConfig({ ...d, models: { ...d.models, default: 'opus[1m]', allowed: ['opus[1m]'] } }).models.default).toBe('opus[1m]');
  });

  it('validates communication.progress (reporting level) and defaults it to feature-level milestones', () => {
    for (const p of ['independent', 'supervised'] as const) {
      expect(modeDefaults(p, ctx).communication.progress).toBe('milestones');
    }
    const d = defaults();
    for (const progress of ['milestones', 'tasks', 'quiet']) {
      expect(resolve({ defaults: d, project: { communication: { progress } } }).config.communication.progress).toBe(progress);
    }
    expect(fail(() => resolve({ defaults: d, project: { communication: { progress: 'stages' } } })).message).toContain('communication.progress');
  });

  it('rejects wrong types with dotted path', () => {
    const e = fail(() => resolve({ defaults: defaults(), local: { container: { cpus: 'four' } } }));
    expect(e.message).toContain('container.cpus');
    expect(e.message).toContain('local configuration');
  });

  it.each([
    [{ execution: { maxEngineers: 4 } }, 'execution.maxEngineers'],
    [{ models: { default: 'gpt' } }, 'models.default'],
    [{ container: { mountDockerSocket: true } }, 'container.mountDockerSocket'],
    [{ container: { mountHostRepository: true } }, 'container.mountHostRepository'],
  ])('rejects conflicting settings %j', (project, path) => {
    const e = fail(() => resolve({ defaults: defaults(), project }));
    expect(e.code).toBe('INVALID_CONFIG');
    expect(e.message).toContain(path);
  });

  it('accepts and drops the keys of the removed GitHub delivery (docs/design/autonomy.md Decision 8)', () => {
    const legacy = {
      backlog: { backend: 'github', repository: null },
      intake: { github: { enabled: true, repository: null, labels: [], assignee: null, milestone: null, state: 'open' } },
      delivery: { provider: 'github', mode: 'pull-request', merge: 'auto-when-eligible', method: 'squash', deleteMergedBranches: true,
        identityMode: 'git-identity', requireIndependentApproval: true, requiredChecksConfigured: true },
      verification: { ciAuthority: 'github', ciPendingTimeoutMinutes: 30 },
      capabilities: { 'git.push': 'allow', 'pr.create': 'allow', 'pr.review': 'allow', 'pr.merge': 'ask' },
    };
    const { config } = resolve({ defaults: defaults(), project: legacy });
    // GitHub auto-merge never turns into local integration.
    expect(config.delivery).toEqual({ merge: 'disabled' });
    expect(config.backlog).toEqual({ backend: 'backlogmd', ownership: 'direct' });
    expect(config.intake).not.toHaveProperty('github');
    expect(config.verification).not.toHaveProperty('ciAuthority');
    expect(Object.keys(config.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    // Local delivery keeps its switch; the never-implemented "manual" is off.
    expect(resolve({ defaults: defaults(), local: { delivery: { mode: 'local', provider: 'none', merge: 'auto-when-eligible' } } }).config.delivery.merge).toBe('auto-when-eligible');
    expect(resolve({ defaults: defaults(), project: { delivery: { merge: 'manual' } } }).config.delivery.merge).toBe('disabled');
    expect(fail(() => resolve({ defaults: defaults(), project: { delivery: { merge: 'sometimes' } } })).message).toContain('delivery.merge');
  });

  it('accepts and drops dispatch.mode and the context-reset barrier (Decision 10: the autopilot always runs)', () => {
    const legacy = { dispatch: { mode: 'coordinator', tickSeconds: 5 }, coordinator: { contextReset: { enabled: true, barrierTokens: 120_000 } } };
    const { config } = resolve({ defaults: defaults(), project: legacy, local: { dispatch: { mode: 'auto' } } });
    expect(config.dispatch).toEqual({ tickSeconds: 5 });
    expect(config.coordinator?.contextReset).toEqual({ enabled: true });
    expect(applyControl(defaults(), { dispatch: { mode: 'auto' } }).dispatch).toEqual({});
  });
});

describe('layering and provenance', () => {
  it('bypassPermissions and sandbox false come only from config.local.json, never the (committable) project layer', () => {
    for (const coordinator of [{ permissionMode: 'bypassPermissions' }, { sandbox: false }]) {
      expect(fail(() => resolve({ defaults: defaults(), project: { coordinator } })).code).toBe('POLICY_DENIED');
      expect(resolve({ defaults: defaults(), local: { coordinator } }).config.coordinator).toMatchObject(coordinator);
    }
  });

  it('records the source of every field', () => {
    const { config, provenance } = resolve({
      defaults: defaults(),
      project: { execution: { maxActiveTasks: 3 }, verification: { commands: ['npm test'] } },
      local: { container: { cpus: 2 } },
      session: { execution: { maxEngineers: 1 } },
    });
    expect(config.execution).toMatchObject({ maxActiveTasks: 3, maxEngineers: 1 });
    expect(provenance['execution.maxActiveTasks']).toBe('project');
    expect(provenance['verification.commands']).toBe('project');
    expect(provenance['container.cpus']).toBe('local');
    expect(provenance['execution.maxEngineers']).toBe('session');
    expect(provenance['models.default']).toBe('default');
    expect(provenance['capabilities.base.merge']).toBe('default');
  });

  it('replaces arrays instead of concatenating', () => {
    const { config } = resolve({ defaults: defaults(), project: { models: { allowed: ['sonnet'] } } });
    expect(config.models.allowed).toEqual(['sonnet']);
  });

  it('session override cannot widen', () => {
    const project = { capabilities: { 'base.merge': 'deny' } };
    const e = fail(() => resolve({ defaults: defaults(), project, session: { capabilities: { 'base.merge': 'allow' } } }));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toContain('capabilities.base.merge');
    expect(fail(() => resolve({ defaults: defaults(), session: { execution: { maxActiveTasks: 5 } } })).code).toBe('POLICY_DENIED');
    expect(fail(() => resolve({ defaults: defaults(), session: { models: { default: 'gpt' } } })).code).toBe('POLICY_DENIED');
    expect(fail(() => resolve({ defaults: defaults(), session: { container: { cpus: 1 } } })).code).toBe('INVALID_CONFIG');
  });

  it('session override can narrow, raising role rules too', () => {
    const { config, provenance } = resolve({ defaults: defaults(), session: { capabilities: { 'code.edit': 'ask', 'base.merge': 'deny' } } });
    expect(config.capabilities['base.merge']).toBe('deny');
    expect(config.capabilities['code.edit']).toEqual({ effect: 'ask', rules: [{ effect: 'deny', roles: ['reviewer'] }] });
    expect(provenance['capabilities.base.merge']).toBe('session');
  });

  it('local overrides cannot remove a project deny', () => {
    const e = fail(() => resolve({ defaults: defaults(), project: {}, local: { capabilities: { 'deploy.execute': 'allow' } } }));
    expect(e.code).toBe('POLICY_DENIED');
  });
});

describe('models.effort and models.coordinator', async () => {
  const { validateConfig } = await import('../src/config/resolve.js');
  const { defaults: d } = await import('./helpers.js');
  const base = () => { const c = d(); c.models = { ...c.models, default: 'claude-opus-5-5', allowed: ['claude-opus-5-5', 'sonnet', 'opus', 'haiku'] }; return c; };

  it('accepts a full model id, effort levels and an allowed coordinator model', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(validateConfig({ ...base(), models: { ...base().models, effort, coordinator: 'claude-opus-5-5' } }, 'x').models).toMatchObject({ effort, coordinator: 'claude-opus-5-5' });
    }
    expect(validateConfig(base(), 'x').models.effort).toBeUndefined();
  });

  it('accepts per-role effort (all keys optional) and rejects unknown roles or levels', () => {
    const roles = { engineer: 'low', engineerDeep: 'high', tester: 'medium', reviewer: 'medium', coordinator: 'medium' } as const;
    expect(validateConfig({ ...base(), models: { ...base().models, effort: 'medium', effortByRole: roles } }, 'x').models.effortByRole).toEqual(roles);
    expect(validateConfig({ ...base(), models: { ...base().models, effortByRole: {} } }, 'x').models.effortByRole).toEqual({});
    expect(validateConfig(base(), 'x').models.effortByRole).toBeUndefined();
    expect(() => validateConfig({ ...base(), models: { ...base().models, effortByRole: { planner: 'low' } } }, 'x')).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => validateConfig({ ...base(), models: { ...base().models, effortByRole: { engineer: 'tiny' } } }, 'x')).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('rejects unknown effort levels and a coordinator model outside models.allowed', () => {
    expect(() => validateConfig({ ...base(), models: { ...base().models, effort: 'extreme' } }, 'x')).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => validateConfig({ ...base(), models: { ...base().models, coordinator: 'gpt-x' } }, 'x')).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it("this repository's .minions/config.json validates (Opus 5.5 workers at medium effort)", async () => {
    const { readFileSync } = await import('node:fs');
    const raw = JSON.parse(readFileSync(new URL('../.minions/config.json', import.meta.url), 'utf8'));
    const cfg = validateConfig({ ...raw, git: { ...raw.git, identity: { name: 'x', email: 'x@example.com' } } }, '.minions/config.json');
    expect(cfg.models).toMatchObject({ default: 'claude-opus-5-5', effort: 'medium', selection: 'coordinator' });
    expect(cfg.models.allowed).toEqual(['claude-opus-5-5', 'sonnet', 'opus', 'haiku']);
  });
});
