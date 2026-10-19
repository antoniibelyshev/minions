import { describe, expect, it } from 'vitest';
import { can, globToRegExp } from '../src/config/capabilities.js';
import { defaults } from './helpers.js';

describe('can()', () => {
  const base = defaults();

  it('deny wins over allow rules', () => {
    const cfg = { ...base, capabilities: { ...base.capabilities, 'git.push': { effect: 'deny' as const, rules: [{ effect: 'allow' as const, roles: ['engineer' as const] }] } } };
    expect(can(cfg, 'git.push', { role: 'engineer' })).toBe('deny');
    const cfg2 = { ...base, capabilities: { ...base.capabilities, 'code.edit': { effect: 'allow' as const, rules: [
      { effect: 'allow' as const, paths: ['src/**'] }, { effect: 'deny' as const, paths: ['src/secret/**'] }] } } };
    expect(can(cfg2, 'code.edit', { paths: ['src/a.ts'] })).toBe('allow');
    expect(can(cfg2, 'code.edit', { paths: ['src/a.ts', 'src/secret/k.ts'] })).toBe('deny');
  });

  it('applies role rules', () => {
    expect(can(base, 'code.edit', { role: 'engineer' })).toBe('allow');
    expect(can(base, 'code.edit', { role: 'reviewer' })).toBe('deny');
    expect(can(base, 'deploy.execute', { role: 'coordinator' })).toBe('deny');
  });

  it('sensitive paths upgrade allow to ask for publication', () => {
    expect(can(base, 'git.push', { paths: ['src/index.ts'] })).toBe('allow');
    expect(can(base, 'git.push', { paths: ['src/index.ts', '.github/workflows/ci.yml'] })).toBe('ask');
    expect(can(base, 'pr.create', { paths: ['db/migrations/001.sql'] })).toBe('ask');
    expect(can(base, 'git.commit', { paths: ['.github/workflows/ci.yml'] })).toBe('allow');
  });

  it('glob semantics', () => {
    expect(globToRegExp('**/migrations/**').test('migrations/1.sql')).toBe(true);
    expect(globToRegExp('**/migrations/**').test('a/b/migrations/1.sql')).toBe(true);
    expect(globToRegExp('CLAUDE.md').test('docs/CLAUDE.md')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });
});
