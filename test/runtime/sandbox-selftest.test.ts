// task-14.3: the minions-sandbox self-test (docs/design/agent-runtimes.md D4 "Fail closed", D7, D10).
// Parsing and layout are pure or use TMPDIR; the helper is mocked by a script. The real canaries run only
// when a built helper and Landlock ABI >= 6 are available (MINIONS_SANDBOX_TEST_BIN, or the image path).
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import { run } from '../../src/core/exec.js';
import { SANDBOX_BIN, assertRulesSafe, buildSandboxRules, sandboxArgv, serializeRules, type SandboxRules } from '../../src/runtime/sandbox/rules.js';
import {
  FIXED_CANARIES, cachedSandboxSelfTest, parseSelfTest, prepareSelfTestLayout, probeIdentity, requireSandbox,
  requiredCanaries, runSandboxSelfTest, summarizeSandbox, type ProbeIdentity, type SelfTestReport,
} from '../../src/runtime/sandbox/selftest.js';

const tmp = (p: string) => mkdtemp(join(tmpdir(), p));

const RULES: SandboxRules = {
  ...buildSandboxRules({
    role: { name: 'self-test', contract: 'gate', harness: 'self-test' }, leaseId: 'p',
    layout: { scratchDir: '/x/scratch', gitObjectsDir: '/x/common/objects', harnessDir: null }, protectedPaths: ['/x/common', '/state'],
  }),
  selfTest: { fixtureDir: '/x/fixture', allowWrite: '/x/scratch/write', allowRead: ['/usr/bin'], denyRead: ['/x/common/config', '/state/minions.db'], denyWrite: ['/x/lease', '/state'] },
};

/** A helper transcript where every required canary passed. */
function transcript(opts: { arch?: string; abi?: number; outcome?: Record<string, string>; omit?: string[]; result?: string; extra?: string[] } = {}): string {
  const arch = opts.arch ?? 'aarch64';
  const lines = ['minions-sandbox-selftest\t1', 'version\t1.0.0', `arch\t${arch}`, `abi\t${opts.abi ?? 8}`, 'check\tfd.inherited:3\tpass\tBad file descriptor'];
  for (const name of requiredCanaries(RULES.selfTest!)) {
    if (opts.omit?.includes(name)) continue;
    const skippable = arch !== 'x86_64' && (name === 'abi.x32' || name === 'abi.compat-socketcall');
    const outcome = opts.outcome?.[name] ?? (skippable ? 'skip' : 'pass');
    lines.push(`check\t${name}\t${outcome}\t${outcome === 'pass' ? 'Permission denied' : 'detail for ' + name}`);
  }
  lines.push(...(opts.extra ?? []), opts.result ?? 'result\tok\t29 checks passed, 2 skipped');
  return lines.join('\n') + '\n';
}
const res = (stdout: string, code = 0, extra: Partial<RunResult> = {}): RunResult => ({ code, stdout, stderr: '', ...extra });

describe('parseSelfTest', () => {
  it('ok only when every required canary passed (skips allowed only for x32/compat off x86_64)', () => {
    const r = parseSelfTest(res(transcript()), RULES);
    expect(r).toMatchObject({ state: 'ok', abi: 8, arch: 'aarch64', helperVersion: '1.0.0' });
    expect(r.detail).toMatch(/^ok \(Landlock ABI 8, \d+ checks\)$/);
    expect(summarizeSandbox(r)).toBe(r.detail);
    expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining([...FIXED_CANARIES, 'fs.write:/state', 'fs.read:/state/minions.db']));
  });

  it('names the canary that escaped (D7 "fail: <canary that escaped>"), even when the helper said ok', () => {
    const r = parseSelfTest(res(transcript({ outcome: { 'fs.read:/state/minions.db': 'escaped' } })), RULES);
    expect(r.state).toBe('fail');
    expect(summarizeSandbox(r)).toBe('fail: fs.read:/state/minions.db escaped: detail for fs.read:/state/minions.db');
    for (const name of ['proc.environ', 'signal.runner', 'signal.wrapper', 'unix.path', 'unix.abstract', 'io_uring.setup', 'tcp.loopback', 'lifetime.runner-death', 'fs.write:/x/lease']) {
      expect(parseSelfTest(res(transcript({ outcome: { [name]: 'escaped' } })), RULES).detail).toMatch(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} escaped`));
    }
    const fd = parseSelfTest(res(transcript({ extra: ['check\tfd.inherited:7\tescaped\tdescriptor 7 is open in the worker'] })), RULES);
    expect(fd.detail).toBe('fd.inherited:7 escaped: descriptor 7 is open in the worker');
  });

  it('an escape outranks an error; an error is a failure (the restriction is unproven)', () => {
    const both = parseSelfTest(res(transcript({ outcome: { 'control.read': 'error', 'unix.path': 'escaped' } })), RULES);
    expect(both.detail).toMatch(/^unix\.path escaped/);
    const err = parseSelfTest(res(transcript({ outcome: { 'fs.read:/x/common/config': 'error' } })), RULES);
    expect(err).toMatchObject({ state: 'fail', detail: 'fs.read:/x/common/config could not be checked: detail for fs.read:/x/common/config' });
  });

  it('fails when a required canary is missing, an fd canary is missing, or a skip is not allowed', () => {
    expect(parseSelfTest(res(transcript({ omit: ['tcp.loopback'] })), RULES).detail).toBe('canary tcp.loopback not reported');
    expect(parseSelfTest(res(transcript({ omit: ['fs.write:/state'] })), RULES).detail).toBe('canary fs.write:/state not reported');
    const noFd = transcript().replace('check\tfd.inherited:3\tpass\tBad file descriptor\n', '');
    expect(parseSelfTest(res(noFd), RULES).detail).toBe('canary fd.inherited not reported');
    // On x86_64 the x32 and compat canaries must run; elsewhere only those two may be skipped.
    expect(parseSelfTest(res(transcript({ arch: 'x86_64', outcome: { 'abi.x32': 'skip' } })), RULES).detail).toMatch(/^abi\.x32 was skipped/);
    expect(parseSelfTest(res(transcript({ arch: 'x86_64' })), RULES).state).toBe('ok');
    expect(parseSelfTest(res(transcript({ outcome: { 'proc.environ': 'skip' } })), RULES).detail).toMatch(/^proc\.environ was skipped/);
  });

  it('does not trust a helper verdict or exit status that disagree with ok', () => {
    expect(parseSelfTest(res(transcript({ result: 'result\tfail\tsomething the helper saw' }), 1), RULES))
      .toMatchObject({ state: 'fail', detail: 'something the helper saw' });
    expect(parseSelfTest(res(transcript(), 1), RULES).state).toBe('fail');
  });

  it('reports unavailable for a Landlock ABI below 6 (D7 wording)', () => {
    const out = ['minions-sandbox-selftest\t1', 'version\t1.0.0', 'arch\tx86_64', 'abi\t4', 'result\tunavailable\tlandlock ABI 4 (need 6)'].join('\n');
    const r = parseSelfTest(res(out, 2), RULES);
    expect(r).toMatchObject({ state: 'unavailable', abi: 4 });
    expect(summarizeSandbox(r)).toBe('unavailable: landlock ABI 4 (need 6)');
    // A low ABI is unavailable even if a broken helper claims ok.
    expect(parseSelfTest(res(transcript({ abi: 5 })), RULES).state).toBe('unavailable');
  });

  it('is an error for garbage, a timeout, a setup failure or a missing result line', () => {
    expect(parseSelfTest(res('hello\n', 0), RULES)).toMatchObject({ state: 'error', detail: expect.stringMatching(/^not a minions-sandbox self-test/) });
    expect(parseSelfTest(res('', 124, { timedOut: true }), RULES)).toMatchObject({ state: 'error', detail: 'self-test timed out' });
    const setup = parseSelfTest({ code: 125, stdout: 'minions-sandbox-selftest\t1\nversion\t1.0.0\narch\taarch64\n', stderr: 'minions-sandbox: rules: unknown key "x" in rules\n' }, RULES);
    expect(setup).toMatchObject({ state: 'error', detail: 'self-test ended without a result (exit 125: minions-sandbox: rules: unknown key "x" in rules)' });
    expect(parseSelfTest(res('minions-sandbox-selftest\t2\n'), RULES).state).toBe('error');
  });

  it('requireSandbox refuses every launch unless the self-test passed (PRECONDITION)', () => {
    expect(() => requireSandbox(parseSelfTest(res(transcript()), RULES))).not.toThrow();
    for (const r of [parseSelfTest(res(transcript({ outcome: { 'unix.path': 'escaped' } })), RULES), parseSelfTest(res('x'), RULES)]) {
      expect(() => requireSandbox(r)).toThrow(expect.objectContaining({ code: 'PRECONDITION', message: expect.stringMatching(/^process isolation unavailable: /) }));
    }
  });
});

describe('prepareSelfTestLayout', () => {
  it('builds a lease-like layout with rules from the launch generator and only existing real targets', async () => {
    const parent = await tmp('sbx-layout-');
    const real = await tmp('sbx-real-');
    await writeFile(join(real, 'minions.db'), 'db');
    const l = await prepareSelfTestLayout(parent, {
      protectedPaths: [real], tcpConnectPorts: [443, 8443],
      real: { read: [join(real, 'minions.db'), join(real, 'missing-secret')], write: [real, join(real, 'nope')] },
    });
    expect(l.root.startsWith(join(parent, 'sandbox-probe-'))).toBe(true);
    const st = l.rules.selfTest!;
    expect(st.denyRead).toEqual([join(l.root, 'common', 'config'), join(l.root, 'fixture', 'secret'), join(real, 'minions.db')]);
    expect(st.denyWrite).toEqual([join(l.root, 'lease'), join(l.root, 'common', 'refs'), join(l.root, 'common', 'objects'), join(l.root, 'fixture'), real]);
    expect(st.allowWrite).toBe(join(l.root, 'scratch', 'write'));
    expect(l.rules.tcpConnectPorts).toEqual([443, 8443]);
    for (const p of [...st.denyRead, ...st.denyWrite, st.allowWrite, st.fixtureDir]) expect(existsSync(p), p).toBe(true);
    // The same safety rules as a launch: nothing protected is opened; the rules file is outside the scratch dir.
    assertRulesSafe(l.rules, { scratchDir: join(l.root, 'scratch'), gitObjectsDir: join(l.root, 'common', 'objects'), protectedPaths: [real, join(l.root, 'common'), join(l.root, 'lease'), join(l.root, 'fixture')] });
    expect(l.rulesFile).toBe(join(l.root, 'rules.json'));
    expect(JSON.parse(await readFile(l.rulesFile, 'utf8'))).toEqual(l.rules);
    expect((await lstat(l.rulesFile)).mode & 0o777).toBe(0o600);
  });

  it('drops a real target that contains the probe itself (it would prove nothing and block the layout)', async () => {
    const parent = await tmp('sbx-contains-');
    const l = await prepareSelfTestLayout(parent, { protectedPaths: [parent], real: { read: [], write: [parent] } });
    expect(l.rules.selfTest!.denyWrite).not.toContain(parent);
  });
});

/** A fake helper: prints a transcript for the rules file it is given and records what it saw. */
async function mockHelper(mode: 'ok' | 'escape' | 'abi4' | 'garbage' | 'setup-error'): Promise<{ bin: string; seen: string }> {
  const dir = await tmp('sbx-mock-');
  const bin = join(dir, 'minions-sandbox');
  const seen = join(dir, 'seen.json');
  const fixed = JSON.stringify(FIXED_CANARIES);
  await writeFile(bin, `#!${process.execPath}
const fs = require('fs');
const [flag, file] = process.argv.slice(2);
const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ flag, file, rules, layoutExists: fs.existsSync(rules.selfTest.fixtureDir) }));
const mode = ${JSON.stringify(mode)};
const out = ['minions-sandbox-selftest\\t1', 'version\\t1.0.0', 'arch\\taarch64', 'abi\\t' + (mode === 'abi4' ? 4 : 8)];
if (mode === 'garbage') { console.log('segfault?'); process.exit(139); }
if (mode === 'setup-error') { console.log(out.slice(0, 3).join('\\n')); console.error('minions-sandbox: rules: unknown key "x" in rules'); process.exit(125); }
if (mode === 'abi4') { console.log(out.join('\\n') + '\\nresult\\tunavailable\\tlandlock ABI 4 (need 6)'); process.exit(2); }
const names = [...${fixed}, ...rules.selfTest.denyWrite.map((p) => 'fs.write:' + p), ...rules.selfTest.denyRead.map((p) => 'fs.read:' + p), 'fd.inherited:3'];
for (const n of names) {
  const skip = n === 'abi.x32' || n === 'abi.compat-socketcall';
  const bad = mode === 'escape' && n === 'fs.write:' + rules.selfTest.denyWrite[0];
  out.push('check\\t' + n + '\\t' + (bad ? 'escaped' : skip ? 'skip' : 'pass') + '\\t' + (bad ? 'operation succeeded' : 'Permission denied'));
}
out.push(mode === 'escape' ? 'result\\tfail\\tescaped' : 'result\\tok\\tall');
console.log(out.join('\\n'));
process.exit(mode === 'escape' ? 1 : 0);
`);
  await chmod(bin, 0o755);
  return { bin, seen };
}

describe('runSandboxSelfTest with a mocked helper', () => {
  it('passing helper: ok, the helper got --self-test <rules> while the layout existed, the layout is removed after', async () => {
    const { bin, seen } = await mockHelper('ok');
    const parent = await tmp('sbx-run-');
    const r = await runSandboxSelfTest({ parent, protectedPaths: [], bin, tcpConnectPorts: [443] });
    expect(r.state).toBe('ok');
    const s = JSON.parse(await readFile(seen, 'utf8')) as { flag: string; file: string; rules: SandboxRules; layoutExists: boolean };
    expect(s.flag).toBe('--self-test');
    expect(s.layoutExists).toBe(true);
    // The mock's own dir is not under /usr, so the launch generator added it as read+execute for the canary exec.
    expect(s.rules.fs).toContainEqual({ path: join(bin, '..'), access: ['read', 'execute'] });
    expect(await readdir(parent)).toEqual([]);
  });

  it('present but failing helper: fail naming the canary; ABI too low: unavailable; broken: error', async () => {
    const parent = await tmp('sbx-run-');
    const escape = await runSandboxSelfTest({ parent, protectedPaths: [], bin: (await mockHelper('escape')).bin });
    expect(escape.state).toBe('fail');
    expect(escape.detail).toMatch(/^fs\.write:.*\/lease escaped: operation succeeded$/);
    expect(await runSandboxSelfTest({ parent, protectedPaths: [], bin: (await mockHelper('abi4')).bin }))
      .toMatchObject({ state: 'unavailable', detail: 'landlock ABI 4 (need 6)' });
    expect((await runSandboxSelfTest({ parent, protectedPaths: [], bin: (await mockHelper('garbage')).bin })).state).toBe('error');
    expect(await runSandboxSelfTest({ parent, protectedPaths: [], bin: (await mockHelper('setup-error')).bin }))
      .toMatchObject({ state: 'error', detail: expect.stringContaining('unknown key') });
    expect(await readdir(parent)).toEqual([]);
  });

  it('absent helper: unavailable, nothing created', async () => {
    const parent = await tmp('sbx-run-');
    const r = await runSandboxSelfTest({ parent, protectedPaths: [], bin: join(parent, 'no-such-helper') });
    expect(r).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('is not installed') });
    expect(await readdir(parent)).toEqual([]);
  });
});

describe('cachedSandboxSelfTest: once per container start', () => {
  const ok: SelfTestReport = { state: 'ok', detail: 'ok (Landlock ABI 8, 29 checks)', abi: 8, arch: 'aarch64', helperVersion: '1.0.0', checks: [] };
  const id: ProbeIdentity = { bootId: 'b1', containerStart: '100', helperSha256: 'h1' };

  it('runs once, then serves the cache for the same boot, container start and helper', async () => {
    const cacheFile = join(await tmp('sbx-cache-'), 'run', 'sandbox-probe.json');
    let runs = 0;
    const runOnce = async () => { runs++; return ok; };
    expect(await cachedSandboxSelfTest({ cacheFile, identity: id, run: runOnce })).toMatchObject({ state: 'ok', cached: false });
    expect(await cachedSandboxSelfTest({ cacheFile, identity: id, run: runOnce })).toMatchObject({ state: 'ok', cached: true });
    expect(runs).toBe(1);
    expect((await lstat(cacheFile)).mode & 0o777).toBe(0o600);
    for (const other of [{ ...id, bootId: 'b2' }, { ...id, containerStart: '200' }, { ...id, helperSha256: 'h2' }]) {
      expect((await cachedSandboxSelfTest({ cacheFile, identity: other, run: runOnce })).cached).toBe(false);
    }
    expect(runs).toBe(4);
    await cachedSandboxSelfTest({ cacheFile, identity: { ...id, helperSha256: 'h2' }, refresh: true, run: runOnce });
    expect(runs).toBe(5);
  });

  it('never caches an error, and never caches without an identity', async () => {
    const cacheFile = join(await tmp('sbx-cache-'), 'sandbox-probe.json');
    let runs = 0;
    const err = async (): Promise<SelfTestReport> => { runs++; return { ...ok, state: 'error', detail: 'self-test timed out' }; };
    await cachedSandboxSelfTest({ cacheFile, identity: id, run: err });
    await cachedSandboxSelfTest({ cacheFile, identity: id, run: err });
    expect(runs).toBe(2);
    expect(existsSync(cacheFile)).toBe(false);
    await cachedSandboxSelfTest({ cacheFile, identity: null, run: async () => ok });
    expect(existsSync(cacheFile)).toBe(false);
  });

  it('probeIdentity reads the boot id and PID 1 start time (field 22), and hashes the helper', async () => {
    const proc = await tmp('sbx-proc-');
    await mkdir(join(proc, 'sys', 'kernel', 'random'), { recursive: true });
    await mkdir(join(proc, '1'));
    await writeFile(join(proc, 'sys', 'kernel', 'random', 'boot_id'), 'abc-boot\n');
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    fields[0] = 'S';
    await writeFile(join(proc, '1', 'stat'), `1 (sleep (x) y) ${fields.join(' ')}\n`);
    const bin = join(proc, 'helper');
    await writeFile(bin, 'binary');
    const identity = await probeIdentity(bin, proc);
    expect(identity).toEqual({ bootId: 'abc-boot', containerStart: '22', helperSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await probeIdentity(join(proc, 'missing'), proc)).toBeNull();
  });
});

// ---------------------------------------------------------------- the real helper (D10: skipIf no Landlock 6)

function realHelper(): string | null {
  const bin = process.env.MINIONS_SANDBOX_TEST_BIN || SANDBOX_BIN;
  try {
    accessSync(bin, constants.X_OK);
    return Number(execFileSync(bin, ['--abi'], { encoding: 'utf8' }).trim()) >= 6 ? bin : null;
  } catch { return null; }
}
const REAL = realHelper();

describe.skipIf(!REAL)('the real minions-sandbox (Landlock ABI >= 6)', () => {
  const bin = REAL!;

  it('self-test: every canary is blocked from inside', async () => {
    const parent = await tmp('sbx-real-');
    const r = await runSandboxSelfTest({ parent, protectedPaths: [], bin });
    expect(r.checks.filter((c) => c.outcome !== 'pass' && c.outcome !== 'skip')).toEqual([]);
    expect(r.state).toBe('ok');
    expect(r.checks.find((c) => c.name === 'lifetime.runner-death')?.outcome).toBe('pass');
  }, 60_000);

  it('self-test catches a rule that opens a denied path', async () => {
    const l = await prepareSelfTestLayout(await tmp('sbx-real-'), { protectedPaths: [], helperDir: dirname(bin) });
    const widened: SandboxRules = { ...l.rules, fs: [...l.rules.fs, { path: join(l.root, 'fixture'), access: ['read'] }] };
    await writeFile(l.rulesFile, serializeRules(widened));
    const r = parseSelfTest(await run(bin, ['--self-test', l.rulesFile], { allowFailure: true, timeoutMs: 60_000 }), widened);
    expect(r).toMatchObject({ state: 'fail', detail: expect.stringMatching(/^fs\.read:.*\/fixture\/secret escaped/) });
  }, 60_000);

  it('proc.seccomp-filters names an unreadable /proc/self/status (Landlock, no /proc rule) instead of calling the line missing', async () => {
    // The escapee sweep (D3b) needs Seccomp_filters, so the check stays strict; it must say why it failed.
    const l = await prepareSelfTestLayout(await tmp('sbx-real-'), { protectedPaths: [], helperDir: dirname(bin) });
    const noProc: SandboxRules = { ...l.rules, fs: l.rules.fs.filter((f) => f.path !== '/proc') };
    await writeFile(l.rulesFile, serializeRules(noProc));
    const r = parseSelfTest(await run(bin, ['--self-test', l.rulesFile], { allowFailure: true, timeoutMs: 60_000 }), noProc);
    expect(r.state).toBe('fail');
    expect(r.checks.find((c) => c.name === 'proc.seccomp-filters')).toMatchObject({
      outcome: 'error', detail: expect.stringMatching(/^cannot open \/proc\/self\/status: Permission denied/),
    });
  }, 60_000);

  it('run mode: scratch writable, protected paths denied, exit status passed through, helper refuses bad rules', async () => {
    const l = await prepareSelfTestLayout(await tmp('sbx-real-'), { protectedPaths: [] });
    const scratch = join(l.root, 'scratch');
    const script = join(scratch, 'worker.sh');
    await writeFile(script, `#!/bin/sh\necho hi > "${scratch}/out"\ncat "${l.root}/fixture/secret" 2>/dev/null && echo LEAK\nexit 7\n`);
    await chmod(script, 0o755);
    const argv = sandboxArgv(l.rulesFile, [script], { bin, scratchDir: scratch, secretValues: ['not-in-argv-secret'] });
    const r = await run(argv[0]!, argv.slice(1), { allowFailure: true, timeoutMs: 30_000 });
    expect(r.code).toBe(7);
    expect(r.stdout).not.toContain('LEAK');
    expect(await readFile(join(scratch, 'out'), 'utf8')).toBe('hi\n');
    await writeFile(join(l.root, 'bad.json'), '{"version":1,"minAbi":6,"fs":[],"tcpConnectPorts":[443]}');
    expect((await run(bin, ['--rules', join(l.root, 'bad.json'), '--', '/bin/true'], { allowFailure: true })).code).toBe(125);
  }, 60_000);

  it('supervisor: leftovers are killed when the harness exits; SIGTERM escalates to SIGKILL after the grace', async () => {
    const l = await prepareSelfTestLayout(await tmp('sbx-real-'), { protectedPaths: [] });
    const scratch = join(l.root, 'scratch');
    const leave = join(scratch, 'leave.sh');
    await writeFile(leave, '#!/bin/sh\nsetsid sleep 3001 &\nsleep 3002 &\necho $!\nexit 0\n');
    await chmod(leave, 0o755);
    const r = await run(bin, ['--rules', l.rulesFile, '--', leave], { allowFailure: true, timeoutMs: 30_000 });
    expect(r.code).toBe(0);
    const pid = Number(r.stdout.trim());
    expect(() => process.kill(pid, 0)).toThrow();

    const stubborn = join(scratch, 'stubborn.sh');
    await writeFile(stubborn, '#!/bin/sh\ntrap "" TERM\nsleep 3003\n');
    await chmod(stubborn, 0o755);
    const child = spawn(bin, ['--rules', l.rulesFile, '--', stubborn], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(137);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(14_000);
  }, 60_000);
});
