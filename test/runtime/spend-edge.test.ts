import { describe, it, expect } from 'vitest';
import { parseBudget, parseTokens } from '../../src/runtime/spend.js';

describe('budget parsing edge cases', () => {
  it('2,000,000 and 5M tokens parse; per day sets the day window', () => {
    expect(parseBudget('2,000,000')).toEqual({ limit: 2_000_000, unit: 'tokens', period: 'since-set' });
    expect(parseBudget('5M tokens per day')).toEqual({ limit: 5_000_000, unit: 'tokens', period: 'day' });
    expect(parseBudget('  20 Attempts  ')).toEqual({ limit: 20, unit: 'attempts', period: 'since-set' });
  });
  it('rejects negatives, zero, garbage and empty input', () => {
    for (const bad of ['-5M tokens', '-20 attempts', '$-5', '0', '$0', '0 attempts', '', '   ', 'per day', 'tokens', '5 apples', '20 tokens attempts', '1e9']) {
      expect(() => parseBudget(bad), bad).toThrow();
    }
  });
  it('an unusable token count is rejected', () => {
    for (const bad of ['', '-1', 'NaN', '1e5']) expect(() => parseTokens(bad), bad).toThrow();
  });
});
