import { describe, expect, it } from 'vitest';
import { defaultDeliveryMode, profileDefaults } from '../src/config/profiles.js';
import { listUnavailable, resolve, validateConfig, SUPPORTED } from '../src/config/resolve.js';
import { CAPABILITIES } from '../src/config/schema.js';
import { MinionsError } from '../src/core/errors.js';
import { ctx, defaults } from './helpers.js';

const fail = (fn: () => unknown): MinionsError => {
  try { fn(); } catch (e) { if (e instanceof MinionsError) return e; throw e; }
  throw new Error('expected a MinionsError');
};

describe('profiles', () => {
  it('project-owner yields documented explicit defaults', () => {
    const { config: c, notes } = profileDefaults('project-owner', ctx);
    expect(validateConfig(c)).toEqual(c);
    expect(c).toMatchObject({
      schemaVersion: 1, configRevision: 1, projectId: ctx.projectId, packageVersion: '0.1.0',
      profile: 'project-owner', visibility: 'shared', architecture: 'decide',
      backlog: { backend: 'backlogmd', ownership: 'direct' },
      intake: { sources: ['user', 'milestone'], startReady: true },
      delivery: { mode: 'local', merge: 'disabled', requiredChecksConfigured: false },
      container: { mountDockerSocket: false, mountHostRepository: false, cpus: 4, memoryMiB: 6144, pidsLimit: 512 },
      execution: { maxActiveTasks: 2, maxEngineers: 2 },
      git: { baseBranch: 'main', identity: ctx.identity },
    });
    // The coordinator permission mode is left unset: auto by default (opt-out: coordinator.permissionMode).
    expect(c).not.toHaveProperty('permissionMode');
    expect(c).not.toHaveProperty('coordinator');
    expect(Object.keys(c.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    expect(c.capabilities['pr.merge']).toBe('ask');
    expect(c.capabilities['ci.edit']).toBe('ask');
    expect(c.capabilities['deploy.execute']).toBe('deny');
    expect(c.sensitivePaths).toContain('.github/workflows/**');
    expect(notes.some((n) => n.includes('GitHub Issues'))).toBe(true);
    expect(profileDefaults('project-owner', { ...ctx, hasGitHub: false }).notes).toEqual([]);
    expect(notes.some((n) => /pull-request delivery .*no GitHub token/.test(n))).toBe(true);
  });

  it('project-owner defaults to pull-request delivery only with a GitHub remote and token', () => {
    const withToken = profileDefaults('project-owner', { ...ctx, hasGitHubCredential: true }).config;
    expect(validateConfig(withToken).delivery).toMatchObject({ provider: 'github', mode: 'pull-request', merge: 'disabled' });
    expect(profileDefaults('project-owner', { ...ctx, hasGitHub: false, hasGitHubCredential: true }).config.delivery.mode).toBe('local');
    expect(profileDefaults('personal-work', { ...ctx, hasGitHubCredential: true }).config.delivery.mode).toBe('local');
    expect(profileDefaults('supervised', { ...ctx, hasGitHubCredential: true }).config.delivery.mode).toBe('local');
  });

  it('personal-work yields documented explicit defaults', () => {
    const { config: c, notes } = profileDefaults('personal-work', ctx);
    validateConfig(c);
    expect(c).toMatchObject({ visibility: 'private', architecture: 'propose', backlog: { backend: 'backlogmd', ownership: 'personal' },
      intake: { sources: ['user', 'external'], startReady: true }, delivery: { mode: 'local', merge: 'disabled' } });
    for (const k of ['external.comment', 'external.changeStatus', 'external.create', 'pr.merge', 'ci.edit', 'deploy.execute'] as const)
      expect(c.capabilities[k]).toBe('deny');
    expect(c.capabilities['external.read']).toBe('allow');
    expect(notes.length).toBe(1);
  });

  it('supervised yields documented explicit defaults', () => {
    const { config: c, notes } = profileDefaults('supervised', ctx);
    validateConfig(c);
    expect(c).toMatchObject({ visibility: 'private', architecture: 'propose', backlog: { ownership: 'assigned' },
      intake: { sources: ['user'], startReady: false }, execution: { maxActiveTasks: 1, maxEngineers: 1 },
      delivery: { mode: 'local', merge: 'disabled' } });
    expect(c.capabilities['git.push']).toBe('deny');
    expect(c.capabilities['pr.merge']).toBe('deny');
    expect(c.capabilities['deploy.execute']).toBe('deny');
    expect(notes).toEqual([]);
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
    for (const p of ['project-owner', 'personal-work', 'supervised'] as const) {
      expect(profileDefaults(p, ctx).config.communication.progress).toBe('milestones');
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
    [{ execution: { maxEngineers: 3 } }, 'execution.maxEngineers'],
    [{ models: { default: 'gpt' } }, 'models.default'],
    [{ container: { mountDockerSocket: true } }, 'container.mountDockerSocket'],
    [{ container: { mountHostRepository: true } }, 'container.mountHostRepository'],
    [{ delivery: { mode: 'pull-request' } }, 'delivery.provider'],
    [{ delivery: { mode: 'branch', provider: 'none' } }, 'delivery.provider'],
    [{ backlog: { backend: 'github' } }, 'backlog.backend'],
  ])('rejects conflicting settings %j', (project, path) => {
    const e = fail(() => resolve({ defaults: defaults(), project }));
    expect(e.code).toBe('INVALID_CONFIG');
    expect(e.message).toContain(path);
  });

  it('reports auto-merge without required checks as unavailable, not as zero checks', () => {
    const c = { ...defaults(), delivery: { ...defaults().delivery, merge: 'auto-when-eligible' as const } };
    validateConfig(c);
    const u = listUnavailable(c).find((x) => x.path === 'delivery.merge');
    expect(u?.reason).toContain('requiredChecksConfigured is false');
    expect(SUPPORTED.delivery).toEqual(['local', 'branch', 'pull-request']);
  });

  it('accepts branch and pull-request delivery with the github provider; merge stays deferred', () => {
    for (const mode of ['branch', 'pull-request'] as const) {
      const c = validateConfig({ ...defaults(), delivery: { ...defaults().delivery, provider: 'github', mode } });
      expect(c.delivery.mode).toBe(mode);
      expect(listUnavailable(c).map((u) => u.path)).not.toContain('delivery.mode');
    }
    const pr = { ...defaults(), delivery: { ...defaults().delivery, provider: 'github' as const, mode: 'pull-request' as const, merge: 'manual' as const } };
    expect(listUnavailable(validateConfig(pr)).find((u) => u.path === 'delivery.merge')?.reason).toMatch(/never merges/);
    const auto = { ...pr, delivery: { ...pr.delivery, merge: 'auto-when-eligible' as const, requiredChecksConfigured: true } };
    expect(listUnavailable(validateConfig(auto)).find((u) => u.path === 'delivery.merge')?.reason).toMatch(/deferred/);
    expect(resolve({ defaults: defaults(), project: { delivery: { provider: 'github', mode: 'branch' } } }).config.delivery.mode).toBe('branch');
  });
});

describe('layering and provenance', () => {
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
    expect(provenance['capabilities.pr.merge']).toBe('default');
  });

  it('replaces arrays instead of concatenating', () => {
    const { config } = resolve({ defaults: defaults(), project: { models: { allowed: ['sonnet'] } } });
    expect(config.models.allowed).toEqual(['sonnet']);
  });

  it('session override cannot widen', () => {
    const project = { capabilities: { 'git.push': 'deny' } };
    const e = fail(() => resolve({ defaults: defaults(), project, session: { capabilities: { 'git.push': 'allow' } } }));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toContain('capabilities.git.push');
    expect(fail(() => resolve({ defaults: defaults(), session: { execution: { maxActiveTasks: 5 } } })).code).toBe('POLICY_DENIED');
    expect(fail(() => resolve({ defaults: defaults(), session: { models: { default: 'gpt' } } })).code).toBe('POLICY_DENIED');
    expect(fail(() => resolve({ defaults: defaults(), session: { container: { cpus: 1 } } })).code).toBe('INVALID_CONFIG');
  });

  it('session override can narrow, raising role rules too', () => {
    const { config, provenance } = resolve({ defaults: defaults(), session: { capabilities: { 'code.edit': 'ask', 'pr.merge': 'deny' } } });
    expect(config.capabilities['pr.merge']).toBe('deny');
    expect(config.capabilities['code.edit']).toEqual({ effect: 'ask', rules: [{ effect: 'deny', roles: ['reviewer'] }] });
    expect(provenance['capabilities.pr.merge']).toBe('session');
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

describe('PR-first delivery default and CI authority', () => {
  it('offers pull-request as the default when GitHub delivery is selectable; local stays local when blocked', () => {
    expect(defaultDeliveryMode('local', false)).toBe('pull-request');
    expect(defaultDeliveryMode('branch', false)).toBe('branch');
    expect(defaultDeliveryMode('pull-request', false)).toBe('pull-request');
    expect(defaultDeliveryMode('local', true)).toBe('local');
    expect(defaultDeliveryMode('pull-request', true)).toBe('local');
    // project-owner with a GitHub remote and a stored token defaults to pull-request; without the token, local.
    expect(profileDefaults('project-owner', { ...ctx, hasGitHubCredential: true }).config.delivery).toMatchObject({ mode: 'pull-request', provider: 'github' });
    expect(profileDefaults('project-owner', ctx).config.delivery.mode).toBe('local');
  });

  it('ciAuthority github is no longer reported unavailable; the pending timeout is optional and validated', () => {
    const c = defaults();
    c.verification.ciAuthority = 'github';
    expect(listUnavailable(c).map((u) => u.path)).not.toContain('verification.ciAuthority');
    expect(validateConfig({ ...c, verification: { ...c.verification, ciPendingTimeoutMinutes: 45 } }).verification.ciPendingTimeoutMinutes).toBe(45);
    expect(fail(() => validateConfig({ ...c, verification: { ...c.verification, ciPendingTimeoutMinutes: 0 } })).code).toBe('INVALID_CONFIG');
    const notes = profileDefaults('project-owner', { ...ctx, hasGitHubCredential: true }).notes.join('\n');
    expect(notes).not.toMatch(/CI authority is deferred/);
    expect(notes).toMatch(/CI authority is opt-in/);
  });
});
