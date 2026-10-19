import { describe, expect, it } from 'vitest';
import { profileDefaults } from '../src/config/profiles.js';
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
      permissionMode: 'acceptEdits',
    });
    expect(Object.keys(c.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    expect(c.capabilities['pr.merge']).toBe('ask');
    expect(c.capabilities['ci.edit']).toBe('ask');
    expect(c.capabilities['deploy.execute']).toBe('deny');
    expect(c.sensitivePaths).toContain('.github/workflows/**');
    expect(notes.some((n) => n.includes('GitHub Issues'))).toBe(true);
    expect(profileDefaults('project-owner', { ...ctx, hasGitHub: false }).notes).toEqual([]);
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
    [{ delivery: { mode: 'pull-request' } }, 'delivery.mode'],
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
    expect(SUPPORTED.delivery).toEqual(['local']);
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
