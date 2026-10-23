// task-29 repair: --json output must survive the host's control-character handling. The emitter escapes
// DEL/C1 (JSON.stringify leaves U+007F-U+009F raw; U+009B is CSI and U+009D is OSC to a terminal), and
// the docker exec relay passes stdout through byte-exact when the delegated command is --json.
import { afterEach, describe, expect, it, vi } from 'vitest';

const execInherit = vi.fn(async (_args: string[], _opts: { tty: boolean; rawStdout?: boolean }) => 0);
vi.mock('../../src/host/docker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/host/docker.js')>();
  class FakeCompose { constructor(_id: string) {} isRunning = async () => true; execInherit = execInherit; }
  return { ...real, Compose: FakeCompose };
});
vi.mock('../../src/host/registry.js', () => ({ projectForPath: async () => ({ projectId: 'p1' }) }));
vi.mock('../../src/host/project.js', () => ({ loadProjectJson: async () => ({ id: 'p1' }) }));
vi.mock('../../src/host/runtime.js', async (importOriginal) => ({ ...(await importOriginal<object>()), runtimeOf: () => 'docker' }));

const { emit, jsonLine, reportError } = await import('../../src/core/output.js');
const { MinionsError } = await import('../../src/core/errors.js');
const { stripControlChars } = await import('../../src/core/control-chars.js');
const { spawnRelay } = await import('../../src/host/docker.js');
const { delegateToRuntime } = await import('../../src/host/delegate.js');

afterEach(() => { vi.restoreAllMocks(); execInherit.mockClear(); });

const PAYLOAD = { title: 'a\u009b2Jb', osc: 'x\u009d0;title\u0007y', nel: 'line\u0085next', del: 'd\u007fe', esc: '\x1b[31mred', n: 1, list: ['\u0090dcs', 'ok'] };
const C1_OR_DEL = /[\u007f-\u009f]/;

const capture = (fn: () => void): string => {
  const out: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
  try { fn(); } finally { vi.restoreAllMocks(); }
  return out.join('');
};

describe('JSON emitter escapes every control character', () => {
  it('jsonLine escapes DEL and C1 (U+009B, U+009D, U+0085) and parses back to the same value', () => {
    const line = jsonLine(PAYLOAD);
    expect(line).not.toMatch(C1_OR_DEL);
    expect(line).not.toMatch(/[\u0000-\u001f]/);
    expect(line).toContain('\\u009b');
    expect(line).toContain('\\u009d');
    expect(line).toContain('\\u0085');
    expect(line).toContain('\\u007f');
    expect(JSON.parse(line)).toEqual(PAYLOAD);
  });

  it('emit --json output is control-free, parses to the payload, and survives the control-char filter unchanged', () => {
    const out = capture(() => emit(PAYLOAD, { json: true }));
    expect(out.endsWith('\n')).toBe(true);
    expect(out).not.toMatch(C1_OR_DEL);
    expect(JSON.parse(out)).toEqual({ ok: true, data: PAYLOAD });
    expect(stripControlChars(out)).toBe(out);
  });

  it('reportError --json escapes C1 in message, hint and details', () => {
    const out = capture(() => reportError(new MinionsError('PRECONDITION', 'm\u009bX', 'h\u009dY', { d: 'z\u0085' }), { json: true }));
    expect(out).not.toMatch(C1_OR_DEL);
    expect(stripControlChars(out)).toBe(out);
    expect(JSON.parse(out)).toEqual({ ok: false, error: { code: 'PRECONDITION', message: 'm\u009bX', hint: 'h\u009dY', details: { d: 'z\u0085' } } });
  });

  it('non-control unicode is left as-is', () => {
    expect(jsonLine({ s: 'héllo   — \u{1f600}' })).toBe(JSON.stringify({ s: 'héllo   — \u{1f600}' }));
  });
});

const bufSink = () => { const parts: Buffer[] = []; return { w: { write: (c: string | Buffer) => { parts.push(Buffer.from(c)); return true; } }, get: () => Buffer.concat(parts) }; };

describe('exec relay keeps --json stdout intact', () => {
  it('rawStdout copies even raw C1 JSON byte-exact while stderr stays filtered', async () => {
    const raw = JSON.stringify({ ok: true, data: PAYLOAD }) + '\n'; // worst case: an emitter without escaping
    const o = bufSink(); const e = bufSink();
    const script = `process.stdout.write(${JSON.stringify(raw)}); process.stderr.write("w\\x1b[2J\\u009b1mx\\n")`;
    expect(await spawnRelay(process.execPath, ['-e', script], { filter: true, rawStdout: true, out: o.w, err: e.w })).toBe(0);
    expect(o.get().equals(Buffer.from(raw))).toBe(true);
    expect(JSON.parse(o.get().toString('utf8'))).toEqual({ ok: true, data: PAYLOAD });
    expect(e.get().toString('utf8')).toBe('wx\n');
  });

  it('the filtered relay also passes emitter JSON through unchanged (belt and braces)', async () => {
    const line = jsonLine({ ok: true, data: PAYLOAD }) + '\n';
    const o = bufSink();
    expect(await spawnRelay(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(line)})`], { filter: true, out: o.w, err: bufSink().w })).toBe(0);
    expect(o.get().toString('utf8')).toBe(line);
    expect(JSON.parse(o.get().toString('utf8'))).toEqual({ ok: true, data: PAYLOAD });
  });

  it('delegateToRuntime requests raw stdout for --json and the filter otherwise', async () => {
    await delegateToRuntime(['status'], { json: true });
    expect(execInherit).toHaveBeenLastCalledWith(['minions', 'status', '--json'], { tty: false, rawStdout: true });
    await delegateToRuntime(['task', 'list', '--json'], { json: false });
    expect(execInherit).toHaveBeenLastCalledWith(['minions', 'task', 'list', '--json'], { tty: false, rawStdout: true });
    await delegateToRuntime(['status'], { json: false });
    expect(execInherit).toHaveBeenLastCalledWith(['minions', 'status'], { tty: false, rawStdout: false });
  });
});

// QA (task-29 retest): rawStdout is chosen from the argv alone, so `--json` may be a positional value
// while the runtime prints human output. That is safe only because the human emitter strips control
// characters itself, including C1; these tests pin both halves of that argument.
describe('--json detection cannot expose unfiltered human output', () => {
  it('an option value that merely contains --json (--opt=--json) keeps the filter', async () => {
    await delegateToRuntime(['pause', '--drain', '--reason=--json'], { json: false });
    expect(execInherit).toHaveBeenLastCalledWith(['minions', 'pause', '--drain', '--reason=--json'], { tty: false, rawStdout: false });
  });

  it('a positional --json after `--` selects raw stdout (documented: human output must already be clean)', async () => {
    await delegateToRuntime(['notify', 'ack', '--', '--json'], { json: false });
    expect(execInherit).toHaveBeenLastCalledWith(['minions', 'notify', 'ack', '--', '--json'], { tty: false, rawStdout: true });
  });

  it('human emit/reportError strip C1 (U+009B CSI, U+009D OSC, U+0085) and DEL, so a raw relay of human output is still clean', () => {
    const out = capture(() => emit({}, { json: false, human: () => 'a\u009b2Jb x\u009d0;title\u0007y line\u0085next d\u007fe' }));
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('ab');
    const err: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true; });
    reportError(new MinionsError('PRECONDITION', 'm\u009b2JX', 'h\u009d0;t\u0007Y'), { json: false });
    vi.restoreAllMocks();
    expect(err.join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('rawStdout does not apply to stderr even when the child writes human output there', async () => {
    const o = bufSink(); const e = bufSink();
    const script = 'process.stderr.write("e\\u009b2J\\u009d0;t\\u0007\\x1b[31mz\\n")';
    expect(await spawnRelay(process.execPath, ['-e', script], { filter: true, rawStdout: true, out: o.w, err: e.w })).toBe(0);
    expect(e.get().toString('utf8')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(o.get().length).toBe(0);
  });
});
