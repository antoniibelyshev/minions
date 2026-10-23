// task-33.5: the deterministic model suggestion of `work next` (docs/design/roles-and-workflows.md D12).
import { describe, expect, it } from 'vitest';
import { suggestModel, type ModelInput } from '../src/config/models.js';
import type { MinionsConfig } from '../src/config/schema.js';

type Models = MinionsConfig['models'];
const cfg = (over: Partial<Models> = {}): Pick<MinionsConfig, 'models'> => ({ models: { default: 'sonnet', allowed: ['sonnet', 'opus', 'haiku'], selection: 'coordinator', ...over } });
const gate = (over: Partial<ModelInput> = {}): ModelInput => ({ contract: 'gate', labels: [], deepVariant: false, ...over });
const producer = (over: Partial<ModelInput> = {}): ModelInput => ({ contract: 'producer', labels: [], deepVariant: true, ...over });

describe('suggestModel precedence: stage hint > role model > risk rule > default', () => {
  it('no hint, no role model, no risk: models.default, omitted in the Agent call', () => {
    expect(suggestModel(cfg(), producer())).toEqual({ model: 'sonnet', agentModel: null, deep: false, rule: 'default' });
  });

  it('the stage hint wins over the role model and every risk rule', () => {
    const x = { stageModel: 'haiku', roleModel: 'opus', labels: ['risk:high'], repairAfterFailure: true };
    expect(suggestModel(cfg(), producer(x))).toEqual({ model: 'haiku', agentModel: 'haiku', deep: true, rule: 'stage' });
    expect(suggestModel(cfg(), gate({ stageModel: 'opus', labels: ['risk:low'] }))).toMatchObject({ model: 'opus', rule: 'stage' });
  });

  it('the role model wins over the risk rules; it is the definition model, so the call omits it', () => {
    expect(suggestModel(cfg(), gate({ roleModel: 'opus', labels: ['risk:low'] }))).toEqual({ model: 'opus', agentModel: null, deep: false, rule: 'role' });
    expect(suggestModel(cfg(), producer({ roleModel: 'haiku', labels: ['risk:high'] }))).toMatchObject({ model: 'haiku', rule: 'role', deep: true });
  });

  it('a stage hint equal to the role model is omitted in the call; a different one is passed', () => {
    expect(suggestModel(cfg(), gate({ stageModel: 'opus', roleModel: 'opus' })).agentModel).toBeNull();
    expect(suggestModel(cfg(), gate({ stageModel: 'sonnet', roleModel: 'opus' })).agentModel).toBe('sonnet');
  });
});

describe('suggestModel risk rules', () => {
  it('risk:high: the strongest allowed alias and the deep variant when the role has one', () => {
    expect(suggestModel(cfg(), producer({ labels: ['risk:high'] }))).toEqual({ model: 'opus', agentModel: 'opus', deep: true, rule: 'risk-high' });
    expect(suggestModel(cfg(), gate({ labels: ['risk:high'] }))).toEqual({ model: 'opus', agentModel: 'opus', deep: false, rule: 'risk-high' });
  });

  it('a repair after a failed attempt: the strongest allowed alias and the deep variant', () => {
    expect(suggestModel(cfg(), producer({ repairAfterFailure: true }))).toEqual({ model: 'opus', agentModel: 'opus', deep: true, rule: 'repair-after-failure' });
  });

  it('risk:low: the cheapest allowed alias for gates and verifiers, the default for producers', () => {
    expect(suggestModel(cfg(), gate({ labels: ['risk:low'] }))).toEqual({ model: 'haiku', agentModel: 'haiku', deep: false, rule: 'risk-low' });
    expect(suggestModel(cfg(), gate({ contract: 'verifier', labels: ['risk:low'] }))).toMatchObject({ model: 'haiku', rule: 'risk-low' });
    expect(suggestModel(cfg(), producer({ labels: ['risk:low'] }))).toMatchObject({ model: 'sonnet', rule: 'default', deep: false });
  });

  it('an all-hinted workflow counts as risk:low for an unhinted gate or verifier (e.g. the inserted tester)', () => {
    expect(suggestModel(cfg(), gate({ contract: 'verifier', allHinted: true }))).toMatchObject({ model: 'haiku', rule: 'risk-low' });
  });

  it('risk:high wins over risk:low', () => {
    expect(suggestModel(cfg(), gate({ labels: ['risk:low', 'risk:high'] }))).toMatchObject({ model: 'opus', rule: 'risk-high' });
  });

  it('only allowed tiered aliases are picked; without one the default stays', () => {
    expect(suggestModel(cfg({ allowed: ['sonnet', 'haiku'] }), gate({ labels: ['risk:high'] }))).toMatchObject({ model: 'sonnet', rule: 'risk-high', agentModel: null });
    expect(suggestModel(cfg({ allowed: ['sonnet', 'opus'] }), gate({ labels: ['risk:low'] }))).toMatchObject({ model: 'sonnet', rule: 'risk-low' });
    expect(suggestModel(cfg({ default: 'claude-x-1', allowed: ['claude-x-1', 'fable'] }), gate({ labels: ['risk:high'] }))).toEqual({ model: 'claude-x-1', agentModel: null, deep: false, rule: 'default' });
  });

  it('a full model ID default is never passed in the Agent call', () => {
    const c = cfg({ default: 'claude-opus-5-5', allowed: ['claude-opus-5-5', 'sonnet', 'opus', 'haiku'] });
    expect(suggestModel(c, producer())).toEqual({ model: 'claude-opus-5-5', agentModel: null, deep: false, rule: 'default' });
    expect(suggestModel(c, gate({ labels: ['risk:low'] }))).toMatchObject({ model: 'haiku', agentModel: 'haiku' });
  });
});

describe('suggestModel with selection fixed', () => {
  it('always the default, omitted in the call, whatever the hint, role model or risk', () => {
    const c = cfg({ selection: 'fixed' });
    for (const x of [producer(), gate({ stageModel: 'haiku' }), gate({ roleModel: 'opus' }), gate({ labels: ['risk:low'] }), gate({ labels: ['risk:high'] }), producer({ repairAfterFailure: true })]) {
      expect(suggestModel(c, x)).toMatchObject({ model: 'sonnet', agentModel: null, rule: 'fixed' });
    }
  });

  it('the deep variant is an effort choice and still applies', () => {
    expect(suggestModel(cfg({ selection: 'fixed' }), producer({ labels: ['risk:high'] }))).toEqual({ model: 'sonnet', agentModel: null, deep: true, rule: 'fixed' });
  });
});
