// task-14.10: `config roles list|show` report each role's resolved harness (own harness > harnesses.default
// where the phase allows it > claude), in the JSON data and in the human line.
import { describe, expect, it } from 'vitest';
import { roleRegistry } from '../../src/config/roles.js';
import { validateConfig } from '../../src/config/resolve.js';
import { formatRoleLine, formatShow, roleView, showRole } from '../../src/runtime/role-proposals.js';
import { defaults } from '../helpers.js';

const CODEX = { models: { default: 'gpt-6.1-sol', allowed: ['gpt-6.1-sol', 'gpt-6.1-mini'] }, effort: 'medium' };
const gate = { description: 'A gate.', promptText: 'Judge.', contract: 'gate' };
const list = (c: ReturnType<typeof validateConfig>) => Object.fromEntries(roleRegistry(c).map((d) => [d.name, roleView(c, d)]));

describe('roles list/show harness', () => {
  it('a Claude-only config shows claude for every role', () => {
    const c = validateConfig({ ...defaults('project-owner'), roles: { judge: gate } });
    const v = list(c);
    expect(Object.keys(v)).toEqual(expect.arrayContaining(['engineer', 'tester', 'reviewer', 'judge']));
    for (const r of Object.values(v)) { expect(r.harness).toBe('claude'); expect(formatRoleLine(r)).toContain('harness claude'); }
    const s = showRole(c, 'judge');
    expect(s.role.harness).toBe('claude');
    expect(formatShow(s)).toContain('harness claude');
  });

  it('harnesses.default codex moves a gate role (and not the producers); a role-level harness wins', () => {
    const c = validateConfig({
      ...defaults('project-owner'),
      harnesses: { default: 'codex', codex: CODEX, network: { tcpConnectPorts: [443] } },
      roles: { judge: gate, 'claude-judge': { ...gate, harness: 'claude' } },
    });
    const v = list(c);
    expect(v.judge!.harness).toBe('codex');
    expect(v['claude-judge']!.harness).toBe('claude');
    expect(v.engineer!.harness).toBe('claude');
    expect(JSON.parse(JSON.stringify(showRole(c, 'judge'))).role.harness).toBe('codex');
    expect(formatShow(showRole(c, 'judge'))).toContain('harness codex');
    expect(formatRoleLine(v['claude-judge']!)).toContain('harness claude');
  });
});
