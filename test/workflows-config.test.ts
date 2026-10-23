import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/resolve.js';
import type { MinionsConfig } from '../src/config/schema.js';
import {
  claimableStatuses, derivePosition, derivedDefaultWorkflow, nextRunnable, repairTarget, resolveWorkflow, verifierBefore, withQaTester,
  workflowConfigIssues, workflowNames, type Stage,
} from '../src/config/workflows.js';
import type { MinionsError } from '../src/core/errors.js';
import { checkWorkflowName } from '../src/backlog/commands.js';
import { defaults } from './helpers.js';

const issuesOf = (over: Partial<MinionsConfig>) => {
  try { validateConfig({ ...defaults(), ...over }); return []; } catch (e) {
    return ((e as MinionsError).details as { issues: { path: string; message: string }[] }).issues;
  }
};
const researcher = { description: 'Researches.', promptText: 'Research it.', contract: 'producer' as const, edits: { paths: ['docs/research/**'] } };
const writer = { description: 'Writes.', promptText: 'Write it.', contract: 'producer' as const, edits: 'any' as const };
const checker = { description: 'Checks.', promptText: 'Check it.', contract: 'verifier' as const };

describe('workflow config', () => {
  it('derives the default workflow from the verification settings (today\'s pipeline)', () => {
    const cfg = defaults();
    expect(cfg.workflows).toBeUndefined();
    expect(derivedDefaultWorkflow(cfg)).toEqual([{ role: 'engineer' }, { role: 'tester', when: 'qa' }, { role: 'reviewer' }]);
    expect(resolveWorkflow(cfg, null)).toEqual({ name: 'default', stages: derivedDefaultWorkflow(cfg) });
    const strict = { ...cfg, verification: { ...cfg.verification, testerRequired: true } };
    expect(derivedDefaultWorkflow(strict)).toEqual([{ role: 'engineer' }, { role: 'tester' }, { role: 'reviewer' }]);
    const noReview = { ...cfg, verification: { ...cfg.verification, reviewerRequired: false } };
    expect(derivedDefaultWorkflow(noReview)).toEqual([{ role: 'engineer' }, { role: 'tester', when: 'qa' }]);
  });

  it('accepts the documented workflows and a workflows.default override', () => {
    const cfg = validateConfig({
      ...defaults(), roles: { researcher, writer },
      workflows: { docs: ['engineer', { role: 'reviewer', model: 'haiku' }], research: ['researcher', 'writer', 'reviewer'], default: ['engineer', 'reviewer'] },
    });
    expect(resolveWorkflow(cfg, 'docs')!.stages).toEqual([{ role: 'engineer' }, { role: 'reviewer', model: 'haiku' }]);
    expect(resolveWorkflow(cfg, null)!.stages).toEqual([{ role: 'engineer' }, { role: 'reviewer' }]);
    expect(resolveWorkflow(cfg, 'nope')).toBeUndefined();
    expect(workflowNames(cfg)).toEqual(['default', 'docs', 'research']);
  });

  it('rejects unknown roles, the coordinator, -deep names, disallowed models and bad names', () => {
    const issues = issuesOf({ workflows: { docs: ['engineer', 'ghost', 'reviewer'], xx: ['coordinator', 'reviewer'], dd: ['engineer-deep', 'reviewer'],
      mm: ['engineer', { role: 'reviewer', model: 'gpt' }], Bad_Name: ['engineer', 'reviewer'] } as never });
    const paths = issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['workflows.docs.1', 'workflows.xx.0', 'workflows.dd.0', 'workflows.mm.1', 'workflows.Bad_Name']));
    expect(issues.find((i) => i.path === 'workflows.docs.1')!.message).toMatch(/unknown role "ghost"/);
    expect(issues.find((i) => i.path === 'workflows.mm.1')!.message).toMatch(/models\.allowed/);
  });

  it('with reviewerRequired a gate must come after the last stage that can commit (invariant 2)', () => {
    expect(issuesOf({ workflows: { aa: ['engineer'] } })[0]).toMatchObject({ path: 'workflows.aa', message: expect.stringMatching(/gate stage .* after the last stage that can commit \(engineer, stage 1\)/) });
    expect(issuesOf({ workflows: { aa: ['engineer', 'reviewer', 'tester'] } })[0]!.message).toMatch(/tester, stage 3/);
    expect(issuesOf({ workflows: { aa: ['engineer', 'tester', 'reviewer'] } })).toEqual([]);
    const lax = defaults();
    lax.verification.reviewerRequired = false;
    expect(issuesOf({ verification: lax.verification, workflows: { aa: ['engineer'] } })).toEqual([]);
  });

  it('checks roles.<r>.repairTo', () => {
    const cfg = validateConfig({ ...defaults(), roles: { writer, checker: { ...checker, repairTo: 'writer' } }, workflows: { ww: ['writer', 'checker', 'reviewer'] } });
    expect(workflowConfigIssues(cfg)).toEqual([]);
    expect(issuesOf({ roles: { checker: { ...checker, repairTo: 'ghost' } } } as never)[0]).toMatchObject({ path: 'roles.checker.repairTo', message: expect.stringMatching(/unknown worker role/) });
    expect(issuesOf({ roles: { checker: { ...checker, repairTo: 'checker' } } } as never)[0]!.message).toMatch(/own repair target/);
    expect(issuesOf({ roles: { writer: { ...writer, repairTo: 'engineer' } } } as never)[0]!.message).toMatch(/only gate and verifier/);
    // Built-ins accept only the D9 override fields.
    expect(issuesOf({ roles: { reviewer: { repairTo: 'tester' } } } as never).length).toBeGreaterThan(0);
  });

  it('backlog --workflow accepts configured names only', () => {
    const cfg = validateConfig({ ...defaults(), workflows: { docs: ['engineer', 'reviewer'] } });
    expect(checkWorkflowName(cfg, 'docs')).toBe('docs');
    expect(checkWorkflowName(cfg, 'default')).toBe('default');
    expect(() => checkWorkflowName(cfg, 'research')).toThrow(/Unknown workflow "research" \(configured: default, docs\)/);
  });
});

describe('stage machine helpers', () => {
  const cfg = validateConfig({ ...defaults(), roles: { researcher, writer, checker: { ...checker, repairTo: 'researcher' } } });
  const docs: Stage[] = [{ role: 'engineer' }, { role: 'reviewer', model: 'haiku' }];
  const dflt = derivedDefaultWorkflow(cfg);

  it('QA insertion (invariant 3): the tester goes before the final gate unless a verifier already runs there', () => {
    expect(withQaTester(cfg, docs, 0)).toEqual([{ role: 'engineer' }, { role: 'tester', inserted: 'qa' }, { role: 'reviewer', model: 'haiku' }]);
    expect(withQaTester(cfg, dflt, 0)).toBe(dflt); // the conditional tester is a runnable verifier when QA is required
    expect(withQaTester(cfg, [{ role: 'engineer' }], 0)).toEqual([{ role: 'engineer' }, { role: 'tester', inserted: 'qa' }]);
    expect(withQaTester(cfg, [{ role: 'researcher' }, { role: 'checker' }, { role: 'reviewer' }], 0).map((s) => s.role)).toEqual(['researcher', 'checker', 'reviewer']);
    expect(verifierBefore(cfg, docs, 1)).toEqual({ stages: [{ role: 'engineer' }, { role: 'tester', inserted: 'qa' }, { role: 'reviewer', model: 'haiku' }], position: 1 });
    expect(verifierBefore(cfg, dflt, 2)).toEqual({ stages: dflt, position: 1 });
  });

  it('skips when:qa stages without QA reasons', () => {
    expect(nextRunnable(dflt, 0, false)).toBe(2);
    expect(nextRunnable(dflt, 0, true)).toBe(1);
    expect(nextRunnable(dflt, 2, true)).toBeNull();
  });

  it('repair targets: repairTo, else the nearest earlier committing producer (never a verifier by default)', () => {
    expect(repairTarget(cfg, dflt, 2)).toBe(0);
    expect(repairTarget(cfg, dflt, 1)).toBe(0);
    const research: Stage[] = [{ role: 'researcher' }, { role: 'writer' }, { role: 'reviewer' }];
    expect(repairTarget(cfg, research, 2)).toBe(1);
    expect(repairTarget(cfg, [{ role: 'researcher' }, { role: 'writer' }, { role: 'checker' }, { role: 'reviewer' }], 2)).toBe(0); // repairTo researcher
    expect(claimableStatuses(cfg, research, 1)).toEqual(['implementing', 'changes-requested']);
    expect(claimableStatuses(cfg, dflt, 1)).toEqual(['testing']);
    expect(claimableStatuses(cfg, dflt, 2)).toEqual(['reviewing']);
  });

  it('legacy tasks derive their position from the status', () => {
    for (const s of ['ready', 'changes-requested', 'implementing'] as const) expect(derivePosition(cfg, dflt, s)).toEqual({ stages: dflt, position: 0 });
    expect(derivePosition(cfg, dflt, 'testing')).toEqual({ stages: dflt, position: 1 });
    expect(derivePosition(cfg, dflt, 'reviewing')).toEqual({ stages: dflt, position: 2 });
    expect(derivePosition(cfg, docs, 'testing')).toEqual({ stages: withQaTester(cfg, docs, 0), position: 1 });
    expect(derivePosition(cfg, dflt, 'blocked')).toBeNull();
    expect(derivePosition(cfg, dflt, 'delivered')).toBeNull();
  });
});
