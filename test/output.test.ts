import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireMode, runtimeMode } from '../src/core/cli-helpers.js';
import { MinionsError } from '../src/core/errors.js';
import { emit, reportError } from '../src/core/output.js';

const capture = (stream: 'stdout' | 'stderr') => {
  const chunks: string[] = [];
  vi.spyOn(process[stream], 'write').mockImplementation((c: string | Uint8Array) => (chunks.push(String(c)), true));
  return chunks;
};

afterEach(() => { vi.restoreAllMocks(); delete process.env.MINIONS_RUNTIME; });

describe('output', () => {
  it('emits JSON envelopes and maps error codes', () => {
    const out = capture('stdout');
    emit({ a: 1 }, { json: true });
    const code = reportError(new MinionsError('CONFLICT', 'stale ghp_abcdefghijklmnopqrstuvwxyz0123', 'retry'), { json: true });
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, data: { a: 1 } });
    const err = JSON.parse(out[1]!);
    expect(err).toMatchObject({ ok: false, error: { code: 'CONFLICT', hint: 'retry' } });
    expect(err.error.message).not.toContain('ghp_abcdef');
    expect(code).toBe(4);
  });

  it('maps unknown errors to INTERNAL in human mode', () => {
    const errs = capture('stderr');
    expect(reportError(new Error('boom'), { json: false })).toBe(1);
    expect(errs[0]).toContain('error [INTERNAL]: boom');
  });

  it('requireMode throws INCOMPATIBLE_RUNTIME', () => {
    expect(runtimeMode()).toBe('host');
    expect(() => requireMode('container')).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RUNTIME' }));
    process.env.MINIONS_RUNTIME = 'container';
    expect(() => requireMode('host')).toThrow(MinionsError);
  });
});
