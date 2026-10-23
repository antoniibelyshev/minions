// task-14.2: harness config, registry, phase rules and -deep effort mapping (docs/design/agent-runtimes.md D1, D8, D9).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_PHASE, HARNESSES, HARNESS_IDS, PHASE1_PROCESS_PRODUCER_CAP, PHASE_RULES, harnessModels, isProcessHarness, nativeEffort, phaseAllows,
} from '../src/config/harnesses.js';
import { launchFor, runCommand } from '../src/config/launch.js';
import { suggestModel } from '../src/config/models.js';
import { resolve, validateConfig } from '../src/config/resolve.js';
import { harnessConfigIssues, harnessRoleEffort, roleRegistry, workerRole } from '../src/config/roles.js';
import { PROFILES, configJsonSchema, type MinionsConfig } from '../src/config/schema.js';
import { MinionsError } from '../src/core/errors.js';
import { defaults } from './helpers.js';

const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol', 'gpt-6.1-mini'] } };
const JUNIE = { models: { default: 'sonnet', allowed: ['sonnet', 'opus', 'gpt'] } };
const gate = (over: Record<string, unknown> = {}) => ({ description: 'Second-opinion review.', promptText: 'Review the head.', contract: 'gate', ...over });
const PILOT = { 'codex-reviewer': gate({ harness: 'codex' }) };

const cfgWith = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...defaults(), ...patch });
const valid = (patch: Record<string, unknown>): MinionsConfig => validateConfig(cfgWith(patch), 'test');
/** A config object that skips validateConfig (e.g. a later phase's assignment), as the runtime would hold it. */
const raw = (patch: Record<string, unknown>): MinionsConfig => cfgWith(patch) as unknown as MinionsConfig;

function issues(patch: Record<string, unknown>): { path: string; message: string }[] {
  try { validateConfig(cfgWith(patch), 'test'); } catch (e) {
    if (e instanceof MinionsError) return (e.details as { issues: { path: string; message: string }[] }).issues;
    throw e;
  }
  return [];
}
const paths = (patch: Record<string, unknown>) => issues(patch).map((i) => i.path);

describe('back-compat: no harnesses block', () => {
  it('every profile default validates unchanged and runs every worker on claude', () => {
    for (const p of PROFILES) {
      const cfg = defaults(p);
      expect(cfg.harnesses).toBeUndefined();
      expect(validateConfig(structuredClone(cfg))).toEqual(cfg);
      expect(roleRegistry(cfg).map((r) => r.harness)).toEqual(['claude', 'claude', 'claude']);
    }
  });

  it('existing role and workflow configs validate unchanged; project roles and stage hints stay on Claude models', () => {
    const patch = {
      roles: { engineer: { model: 'opus', effort: 'high' }, judge: gate({ model: 'haiku' }), researcher: { description: 'r', promptText: 'x', contract: 'producer', edits: 'any' } },
      workflows: { cheap: [{ role: 'engineer', model: 'sonnet' }, { role: 'judge', model: 'haiku' }] },
    };
    const cfg = valid(patch);
    expect(roleRegistry(cfg).every((r) => r.harness === 'claude')).toBe(true);
    // Claude messages are unchanged: models.allowed.
    expect(issues({ roles: { judge: gate({ model: 'gpt-6.1-sol' }) } })).toEqual([{ path: 'roles.judge.model', message: '"gpt-6.1-sol" is not in models.allowed [sonnet, opus, haiku]' }]);
  });

  it('resolve() layers a harnesses block like any other setting', () => {
    const { config, provenance } = resolve({ defaults: defaults(), project: { harnesses: { codex: CODEX }, roles: PILOT } });
    expect(config.harnesses?.codex?.models.default).toBe('gpt-6.1-sol');
    expect(provenance['harnesses.codex.models.default']).toBe('project');
    expect(workerRole(config, 'codex-reviewer')?.harness).toBe('codex');
  });

  it('a session override cannot set a harness', () => {
    expect(() => resolve({ defaults: defaults(), session: { harnesses: { default: 'codex' } } })).toThrow(/not a session-overridable setting/);
  });
});

describe('harnesses schema', () => {
  it('accepts the D8 shape (phase 1 option b pilot)', () => {
    const cfg = valid({
      harnesses: { default: 'claude', codex: { ...CODEX, effort: 'high', timeoutMinutes: 60 }, junie: JUNIE, network: { tcpConnectPorts: [443] } },
      roles: PILOT,
    });
    expect(workerRole(cfg, 'codex-reviewer')).toMatchObject({ harness: 'codex', contract: 'gate', builtin: false });
    expect(workerRole(cfg, 'reviewer')?.harness).toBe('claude');
  });

  it('is strict: no unknown harness keys, no claude block, no unknown ids', () => {
    expect(paths({ harnesses: { claude: CODEX } })).toEqual(['harnesses.claude']);
    expect(paths({ harnesses: { codex: { ...CODEX, sandbox: 'none' } } })).toEqual(['harnesses.codex.sandbox']);
    expect(paths({ harnesses: { codex: { models: { ...CODEX.models, extra: 1 } } } })).toEqual(['harnesses.codex.models.extra']);
    expect(paths({ harnesses: { default: 'fake' } })).toEqual(['harnesses.default']);
    expect(paths({ roles: { 'codex-reviewer': gate({ harness: 'gemini' }) } })).toEqual(['roles.codex-reviewer.harness']);
    expect(paths({ harnesses: { codex: { models: { default: 'gpt', allowed: [] } } } })).toEqual(['harnesses.codex.models.allowed']);
    expect(paths({ harnesses: { codex: { ...CODEX, timeoutMinutes: 0 } } })).toEqual(['harnesses.codex.timeoutMinutes']);
  });

  it('network.tcpConnectPorts: ports 1 to 65535, never empty', () => {
    expect(paths({ harnesses: { network: { tcpConnectPorts: [] } } })).toEqual(['harnesses.network.tcpConnectPorts']);
    expect(issues({ harnesses: { network: { tcpConnectPorts: [] } } })[0]!.message).toMatch(/at least one port/);
    expect(paths({ harnesses: { network: { tcpConnectPorts: [0] } } })).toEqual(['harnesses.network.tcpConnectPorts.0']);
    expect(paths({ harnesses: { network: { tcpConnectPorts: [443, 65536] } } })).toEqual(['harnesses.network.tcpConnectPorts.1']);
    expect(paths({ harnesses: { network: { tcpConnectPorts: [44.3] } } })).toEqual(['harnesses.network.tcpConnectPorts.0']);
    expect(paths({ harnesses: { network: {} } })).toEqual(['harnesses.network.tcpConnectPorts']);
    expect(valid({ harnesses: { network: { tcpConnectPorts: [1, 443, 65535] } } }).harnesses?.network?.tcpConnectPorts).toEqual([1, 443, 65535]);
  });

  it('the JSON schema in schema/ is regenerated', () => {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schema', 'config.schema.json'), 'utf8')) as unknown;
    expect(file).toEqual(JSON.parse(JSON.stringify(configJsonSchema())));
    const props = (configJsonSchema() as { properties: Record<string, { properties?: Record<string, unknown> }> }).properties;
    expect(Object.keys(props.harnesses!.properties!)).toEqual(['default', 'codex', 'junie', 'network']);
  });
});

describe('cross-field harness checks (validateConfig)', () => {
  it('a referenced process harness needs its block', () => {
    expect(issues({ harnesses: { default: 'codex' } })).toEqual([{ path: 'harnesses.default', message: expect.stringMatching(/no harnesses\.codex block/) }]);
    expect(paths({ roles: PILOT })).toEqual(['roles.codex-reviewer.harness']);
    expect(paths({ roles: { judge: gate({ harness: 'junie' }) }, harnesses: { codex: CODEX } })).toEqual(['roles.judge.harness']);
    // claude never needs a block; an unused block is fine.
    expect(paths({ harnesses: { default: 'claude', junie: JUNIE }, roles: { engineer: { harness: 'claude' } } })).toEqual([]);
  });

  it('the coordinator cannot be assigned a harness', () => {
    const got = issues({ roles: { coordinator: { harness: 'codex', description: 'x', promptText: 'x', contract: 'gate' } }, harnesses: { codex: CODEX } });
    expect(got).toContainEqual({ path: 'roles.coordinator.harness', message: expect.stringMatching(/coordinator always runs on Claude Code/) });
  });

  it('a harness default model must be one of its allowed models', () => {
    expect(paths({ harnesses: { codex: { models: { default: 'gpt-7', allowed: ['gpt-6.1-sol'] } } } })).toEqual(['harnesses.codex.models.default']);
  });

  it('role models are validated against the role harness', () => {
    const h = { codex: CODEX };
    expect(valid({ harnesses: h, roles: { 'codex-reviewer': gate({ harness: 'codex', model: 'gpt-6.1-mini' }) } })).toBeTruthy();
    expect(issues({ harnesses: h, roles: { 'codex-reviewer': gate({ harness: 'codex', model: 'sonnet' }) } }))
      .toEqual([{ path: 'roles.codex-reviewer.model', message: '"sonnet" is not in harnesses.codex.models.allowed [gpt-6.1-sol, gpt-6.1-mini]' }]);
    // harnesses.default reaches project gate roles without their own harness.
    expect(paths({ harnesses: { default: 'codex', ...h }, roles: { judge: gate({ model: 'haiku' }) } })).toEqual(['roles.judge.model']);
    expect(paths({ harnesses: { default: 'codex', ...h }, roles: { judge: gate({ model: 'gpt-6.1-sol' }) } })).toEqual([]);
  });

  it('workflow stage model hints are validated against the stage role harness and never name a harness', () => {
    const base = { harnesses: { codex: CODEX }, roles: PILOT };
    expect(valid({ ...base, workflows: { pilot: ['engineer', 'reviewer', { role: 'codex-reviewer', model: 'gpt-6.1-mini' }] } })).toBeTruthy();
    expect(issues({ ...base, workflows: { pilot: ['engineer', { role: 'reviewer', model: 'gpt-6.1-sol' }] } }))
      .toEqual([{ path: 'workflows.pilot.1', message: 'model "gpt-6.1-sol" is not in models.allowed [sonnet, opus, haiku]' }]);
    expect(issues({ ...base, workflows: { pilot: ['engineer', 'reviewer', { role: 'codex-reviewer', model: 'opus' }] } }))
      .toEqual([{ path: 'workflows.pilot.2', message: 'model "opus" is not in harnesses.codex.models.allowed [gpt-6.1-sol, gpt-6.1-mini]' }]);
    expect(paths({ ...base, workflows: { pilot: ['engineer', { role: 'reviewer', harness: 'codex' }] } })).toEqual(['workflows.pilot.1.harness']);
  });
});

describe('phase rules (D9)', () => {
  it('this build enforces phase 1 option (b) with the producer cap of one ready for option (a)', () => {
    expect(CURRENT_PHASE).toBe(PHASE_RULES['1b']);
    expect(PHASE1_PROCESS_PRODUCER_CAP).toBe(1);
    expect(PHASE_RULES['1b'].processProducerCap).toBe(1);
    expect(PHASE_RULES['1a'].processProducerCap).toBe(1);
    expect(PHASE_RULES['2'].processProducerCap).toBeNull();
  });

  it('phase 1 (b): a process harness only for project gate roles', () => {
    const h = { codex: CODEX };
    expect(valid({ harnesses: h, roles: PILOT })).toBeTruthy();
    for (const role of ['engineer', 'tester', 'reviewer']) {
      const got = issues({ harnesses: h, roles: { [role]: { harness: 'codex' } } });
      expect(got).toEqual([{ path: `roles.${role}.harness`, message: expect.stringMatching(new RegExp(`option \\(b\\).*the built-in \\w+ role ${role} must stay on claude`)) }]);
    }
    expect(paths({ harnesses: h, roles: { maker: { description: 'm', promptText: 'x', contract: 'producer', edits: 'any', harness: 'codex' } } })).toEqual(['roles.maker.harness']);
    expect(paths({ harnesses: h, roles: { checker: { description: 'c', promptText: 'x', contract: 'verifier', harness: 'codex' } } })).toEqual(['roles.checker.harness']);
    // claude is always allowed, also when set explicitly.
    expect(paths({ roles: { engineer: { harness: 'claude' }, judge: gate({ harness: 'claude' }) } })).toEqual([]);
  });

  it('harnesses.default ("authorize one harness for the squad") applies only to the roles the phase allows', () => {
    const cfg = valid({ harnesses: { default: 'codex', codex: CODEX }, roles: { judge: gate(), maker: { description: 'm', promptText: 'x', contract: 'producer', edits: 'any' } } });
    expect(Object.fromEntries(roleRegistry(cfg).map((r) => [r.name, r.harness]))).toEqual({ engineer: 'claude', tester: 'claude', reviewer: 'claude', judge: 'codex', maker: 'claude' });
  });

  it('phaseAllows by phase: (a) adds producers (built-in too) and keeps the gate pilot; phase 2 allows every worker contract', () => {
    const roles = [
      { contract: 'producer', builtin: true }, { contract: 'producer', builtin: false }, { contract: 'verifier', builtin: true },
      { contract: 'verifier', builtin: false }, { contract: 'gate', builtin: true }, { contract: 'gate', builtin: false },
    ] as const;
    const table = (id: '1a' | '1b' | '2') => roles.map((r) => phaseAllows('codex', r, PHASE_RULES[id]));
    expect(table('1b')).toEqual([false, false, false, false, false, true]);
    expect(table('1a')).toEqual([true, true, false, false, false, true]);
    expect(table('2')).toEqual([true, true, true, true, true, true]);
    expect(roles.every((r) => phaseAllows('claude', r, PHASE_RULES['1b']))).toBe(true);
    // validateConfig's check takes the phase as a parameter, so the (a) switch needs no config change.
    const engineerOnCodex = raw({ harnesses: { codex: CODEX }, roles: { engineer: { harness: 'codex', model: 'gpt-6.1-sol' } } });
    expect(harnessConfigIssues(engineerOnCodex, PHASE_RULES['1b']).map((i) => i.path)).toEqual(['roles.engineer.harness']);
    expect(harnessConfigIssues(engineerOnCodex, PHASE_RULES['1a'])).toEqual([]);
  });
});

describe('harness registry', () => {
  it('is a static list with capability flags', () => {
    expect(HARNESS_IDS).toEqual(['claude', 'codex', 'junie']);
    expect(HARNESS_IDS.map((id) => HARNESSES[id].capabilities.launch)).toEqual(['in-session', 'process', 'process']);
    expect(HARNESS_IDS.filter(isProcessHarness)).toEqual(['codex', 'junie']);
    expect(HARNESSES.codex.capabilities).toMatchObject({ structuredFinalOutput: true, usageEvents: 'jsonl', maxSteps: false, effort: true });
    expect(HARNESSES.junie.capabilities).toMatchObject({ maxSteps: true, effort: true });
  });

  it('harnessModels: top-level models for claude, the harness block otherwise', () => {
    const cfg = valid({ harnesses: { codex: CODEX } });
    expect(harnessModels(cfg, 'claude')).toEqual({ default: 'sonnet', allowed: ['sonnet', 'opus', 'haiku'] });
    expect(harnessModels(cfg, 'codex')).toEqual(CODEX.models);
    expect(harnessModels(cfg, 'junie')).toBeUndefined();
  });
});

describe('-deep effort mapping onto the harness (D8)', () => {
  it('maps the minions scale onto each harness, clamped to its strongest level', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => nativeEffort('codex', e as 'low'))).toEqual(['low', 'medium', 'high', 'xhigh', 'xhigh']);
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => nativeEffort('junie', e as 'low'))).toEqual(['low', 'medium', 'high', 'high', 'high']);
    expect(nativeEffort('claude', 'max')).toBe('max');
  });

  it('engineer-deep on a process harness: same harness and model, engineerDeepEffort mapped (option a)', () => {
    const cfg = raw({ harnesses: { codex: { ...CODEX, effort: 'medium' }, junie: JUNIE }, roles: { engineer: { harness: 'codex' } } });
    const eng = workerRole(cfg, 'engineer')!;
    expect(eng.harness).toBe('codex');
    // base: harnesses.codex.effort (no role or effortByRole effort); deep: one level above.
    expect(harnessRoleEffort(cfg, eng, false)).toEqual({ effort: 'medium', native: 'medium', deepApplied: false });
    expect(harnessRoleEffort(cfg, eng, true)).toEqual({ effort: 'high', native: 'high', deepApplied: true });
    // roles.engineer.deepEffort > effortByRole.engineerDeep, then clamped onto Codex's scale.
    const max = raw({ harnesses: { codex: CODEX }, roles: { engineer: { harness: 'codex', deepEffort: 'max' } }, models: { ...defaults().models, effortByRole: { engineerDeep: 'low' } } });
    expect(harnessRoleEffort(max, workerRole(max, 'engineer')!, true)).toEqual({ effort: 'max', native: 'xhigh', deepApplied: true });
    // Junie clamps at high.
    const j = raw({ harnesses: { junie: JUNIE }, roles: { engineer: { harness: 'junie', effort: 'high' } } });
    expect(harnessRoleEffort(j, workerRole(j, 'engineer')!, true)).toEqual({ effort: 'xhigh', native: 'high', deepApplied: true });
  });

  it('project roles with deepVariant; role effort wins over the harness effort; no effort set = harness default', () => {
    const cfg = valid({ harnesses: { codex: { ...CODEX, effort: 'low' } }, roles: { 'codex-reviewer': gate({ harness: 'codex', deepVariant: true, effort: 'high' }), plain: gate({ harness: 'codex' }) } });
    const r = workerRole(cfg, 'codex-reviewer')!;
    expect(harnessRoleEffort(cfg, r, false)).toEqual({ effort: 'high', native: 'high', deepApplied: false });
    expect(harnessRoleEffort(cfg, r, true)).toEqual({ effort: 'xhigh', native: 'xhigh', deepApplied: true });
    // deep is only applied to a role with a deep variant.
    expect(harnessRoleEffort(cfg, workerRole(cfg, 'plain')!, true)).toEqual({ effort: 'low', native: 'low', deepApplied: false });
    const none = valid({ harnesses: { codex: CODEX }, roles: { plain: gate({ harness: 'codex' }) } });
    expect(harnessRoleEffort(none, workerRole(none, 'plain')!, false)).toEqual({ effort: undefined, native: null, deepApplied: false });
  });
});

describe('model suggestion and launch per harness', () => {
  const input = { contract: 'gate' as const, labels: [] as string[], deepVariant: true, harness: 'codex' as const };

  it('a process role uses its harness models: fixed = harness default, then stage > role > harness default; never an Agent model', () => {
    const cfg = valid({ harnesses: { codex: CODEX }, roles: PILOT });
    expect(suggestModel(cfg, input)).toEqual({ model: 'gpt-6.1-sol', rule: 'default', deep: false, agentModel: null });
    expect(suggestModel(cfg, { ...input, roleModel: 'gpt-6.1-mini' })).toMatchObject({ model: 'gpt-6.1-mini', rule: 'role', agentModel: null });
    expect(suggestModel(cfg, { ...input, roleModel: 'gpt-6.1-mini', stageModel: 'gpt-6.1-sol' })).toMatchObject({ model: 'gpt-6.1-sol', rule: 'stage' });
    // risk:low has no tier ranking off Claude; risk:high still picks the -deep variant.
    expect(suggestModel(cfg, { ...input, labels: ['risk:low'] })).toMatchObject({ model: 'gpt-6.1-sol', rule: 'default' });
    expect(suggestModel(cfg, { ...input, labels: ['risk:high'] })).toMatchObject({ model: 'gpt-6.1-sol', deep: true, agentModel: null });
    const fixed = valid({ harnesses: { codex: CODEX }, roles: PILOT, models: { ...defaults().models, selection: 'fixed' } });
    expect(suggestModel(fixed, { ...input, roleModel: 'gpt-6.1-mini', stageModel: 'gpt-6.1-mini' })).toEqual({ model: 'gpt-6.1-sol', rule: 'fixed', deep: false, agentModel: null });
    // Claude roles are unchanged.
    expect(suggestModel(cfg, { ...input, harness: 'claude', labels: ['risk:low'] })).toMatchObject({ model: 'haiku', rule: 'risk-low', agentModel: 'haiku' });
  });

  it('launch: agent for claude, run (after claim) for a process harness', () => {
    const cfg = valid({ harnesses: { codex: { ...CODEX, effort: 'medium' } }, roles: { 'codex-reviewer': gate({ harness: 'codex', deepVariant: true }) } });
    const reviewer = workerRole(cfg, 'reviewer')!;
    expect(launchFor(cfg, reviewer, { model: 'sonnet', agentModel: null, deep: false, rule: 'default' })).toEqual({ kind: 'agent', agentType: 'minions:reviewer', agentModel: null });
    const eng = workerRole(cfg, 'engineer')!;
    expect(launchFor(cfg, eng, { model: 'opus', agentModel: 'opus', deep: true, rule: 'risk-high' })).toEqual({ kind: 'agent', agentType: 'minions:engineer-deep', agentModel: 'opus' });
    const codex = workerRole(cfg, 'codex-reviewer')!;
    expect(launchFor(cfg, codex, { model: 'gpt-6.1-sol', agentModel: null, deep: false, rule: 'default' }))
      .toEqual({ kind: 'run', command: 'minions work run <leaseId> --json', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', deep: false });
    expect(launchFor(cfg, codex, { model: 'gpt-6.1-sol', agentModel: null, deep: true, rule: 'risk-high' })).toMatchObject({ kind: 'run', effort: 'high', deep: true });
    expect(runCommand('lease-0123456789ab')).toBe('minions work run lease-0123456789ab --json');
  });
});
