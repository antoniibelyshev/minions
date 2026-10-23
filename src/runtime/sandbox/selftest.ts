// The L1 self-test (docs/design/agent-runtimes.md D4 "Fail closed", D7): `minions-sandbox --self-test`
// plays the runner, runs canaries under rules built by the same generator as real launches, and reports
// one line per check. Every restriction must hold from inside; anything else refuses process harnesses.
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { arch as osArch } from 'node:os';
import { dirname, join } from 'node:path';
import { run, type RunOptions, type RunResult } from '../../core/exec.js';
import { atomicWrite, readJsonIfExists, sha256File } from '../../core/fsutil.js';
import { MinionsError } from '../../core/errors.js';
import { redact } from '../../core/output.js';
import {
  SANDBOX_BIN, buildSandboxRules, checkRulePath, serializeRules, within,
  type SandboxRules, type SelfTestSection,
} from './rules.js';

export const SELFTEST_PROTOCOL = 1;
/** The helper exits by itself after 120 s; the caller allows a little more. */
export const SELFTEST_TIMEOUT_MS = 150_000;

export type SelfTestOutcome = 'pass' | 'escaped' | 'error' | 'skip';
export interface SelfTestCheck { name: string; outcome: SelfTestOutcome; detail: string }
/** ok: every restriction held. fail: a canary escaped or was not proven. unavailable: no helper or Landlock ABI < 6. error: the self-test itself broke. */
export type SandboxState = 'ok' | 'fail' | 'unavailable' | 'error';
export interface SelfTestReport {
  state: SandboxState;
  /** One line: "ok", "<canary> escaped: ...", "landlock ABI 4 (need 6)", ... */
  detail: string;
  abi: number | null;
  arch: string | null;
  helperVersion: string | null;
  checks: SelfTestCheck[];
}

/** Canaries the helper must report for every rules file, besides one per selfTest path and descriptor. */
export const FIXED_CANARIES = [
  'control.write-scratch', 'control.read', 'control.socketpair',
  'proc.environ', 'signal.runner', 'signal.wrapper',
  'seccomp.af-unix', 'unix.path', 'unix.abstract', 'tcp.loopback',
  'io_uring.setup', 'abi.x32', 'abi.compat-socketcall', 'proc.seccomp-filters',
  'canary.exit', 'lifetime.runner-death',
] as const;
/** The only canaries that may be skipped, and only where the architecture has no such ABI. */
const ARCH_SKIPPABLE = new Set(['abi.x32', 'abi.compat-socketcall']);

export function requiredCanaries(selfTest: SelfTestSection): string[] {
  return [...FIXED_CANARIES, ...selfTest.denyWrite.map((p) => `fs.write:${p}`), ...selfTest.denyRead.map((p) => `fs.read:${p}`)];
}

const lastLine = (s: string) => redact(s.trim().split('\n').slice(-1)[0] ?? '').slice(0, 300);

/**
 * Parses the helper's output. Strict and independent of the helper's own verdict: a missing canary, a
 * skip outside the allowed ones, an error or an escape is a failure even if the helper printed `ok`.
 */
export function parseSelfTest(res: RunResult, rules: SandboxRules): SelfTestReport {
  const report: SelfTestReport = { state: 'error', detail: '', abi: null, arch: null, helperVersion: null, checks: [] };
  const fail = (state: SandboxState, detail: string): SelfTestReport => ({ ...report, state, detail });
  if (res.timedOut) return fail('error', 'self-test timed out');
  const lines = res.stdout.split('\n').filter((l) => l.length > 0);
  if (lines[0] !== `minions-sandbox-selftest\t${SELFTEST_PROTOCOL}`) {
    return fail('error', `not a minions-sandbox self-test (exit ${res.code}${res.stderr.trim() ? `: ${lastLine(res.stderr)}` : ''})`);
  }
  let result: { verdict: string; detail: string } | null = null;
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    if (f[0] === 'version') report.helperVersion = f[1] ?? null;
    else if (f[0] === 'arch') report.arch = f[1] ?? null;
    else if (f[0] === 'abi' && /^\d+$/.test(f[1] ?? '')) report.abi = Number(f[1]);
    else if (f[0] === 'check' && f.length >= 4 && ['pass', 'escaped', 'error', 'skip'].includes(f[2]!)) {
      report.checks.push({ name: f[1]!, outcome: f[2] as SelfTestOutcome, detail: f.slice(3).join('\t') });
    } else if (f[0] === 'result') result = { verdict: f[1] ?? '', detail: f.slice(2).join('\t') };
  }
  if (result?.verdict === 'unavailable' || (report.abi !== null && report.abi < rules.minAbi)) {
    return fail('unavailable', `landlock ABI ${report.abi ?? 0} (need ${rules.minAbi})`);
  }
  if (!result) return fail('error', `self-test ended without a result (exit ${res.code}${res.stderr.trim() ? `: ${lastLine(res.stderr)}` : ''})`);

  const escaped = report.checks.find((c) => c.outcome === 'escaped');
  if (escaped) return fail('fail', `${escaped.name} escaped: ${escaped.detail}`);
  const errored = report.checks.find((c) => c.outcome === 'error');
  if (errored) return fail('fail', `${errored.name} could not be checked: ${errored.detail}`);
  const x86 = report.arch === 'x86_64';
  const skipped = report.checks.find((c) => c.outcome === 'skip' && (x86 || !ARCH_SKIPPABLE.has(c.name)));
  if (skipped) return fail('fail', `${skipped.name} was skipped: ${skipped.detail}`);
  const seen = new Set(report.checks.map((c) => c.name));
  const missing = rules.selfTest ? requiredCanaries(rules.selfTest).find((n) => !seen.has(n)) : 'selfTest section';
  if (missing) return fail('fail', `canary ${missing} not reported`);
  if (!report.checks.some((c) => c.name.startsWith('fd.inherited:'))) return fail('fail', 'canary fd.inherited not reported');
  if (result.verdict !== 'ok' || res.code !== 0) return fail('fail', result.detail || `helper verdict ${result.verdict || 'missing'} (exit ${res.code})`);
  return { ...report, state: 'ok', detail: `ok (Landlock ABI ${report.abi}, ${report.checks.filter((c) => c.outcome === 'pass').length} checks)` };
}

/** The D7 wording: ok / fail: <canary that escaped> / unavailable: landlock ABI <n> (need 6). */
export function summarizeSandbox(r: SelfTestReport): string {
  return r.state === 'ok' ? r.detail : `${r.state}: ${r.detail}`;
}

/** Real container targets the canaries probe when they exist (D4 self-test list). */
export interface RealTargets {
  /** e.g. /state/minions.db, every file in /opt/minions/secrets, ~/.claude, <repo>/.git/config */
  read: string[];
  /** e.g. /state, /workspace/repo, /workspace/worktrees, /tmp, /dev/shm */
  write: string[];
}

export async function containerRealTargets(p: { db: string; secretsDir: string; claudeHome: string; repo: string; state: string; worktrees: string }): Promise<RealTargets> {
  const secrets = await readdir(p.secretsDir).then((n) => n.filter((x) => !x.startsWith('.')).map((x) => join(p.secretsDir, x)), () => []);
  return {
    read: [p.db, ...secrets, p.claudeHome, join(p.repo, '.git', 'config')],
    write: [p.state, p.repo, p.worktrees, '/tmp', '/dev/shm'],
  };
}

const existing = async (paths: string[]) => (await Promise.all(paths.map(async (x) => ((await lstat(x).then(() => true, () => false)) ? x : null)))).filter((x): x is string => x !== null);

export interface SelfTestLayout { root: string; rules: SandboxRules; rulesFile: string }

/**
 * A throwaway lease-like layout under `parent`: a scratch dir (writable), a fake shared repo (objects
 * readable, refs and config not), a fake lease worktree and a fixture dir with a secret. The rules come
 * from buildSandboxRules, so the canaries test exactly what a launch would get.
 */
export async function prepareSelfTestLayout(parent: string, opts: {
  tcpConnectPorts?: readonly number[]; protectedPaths: readonly string[]; real?: RealTargets; helperDir?: string;
}): Promise<SelfTestLayout> {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'sandbox-probe-'));
  checkRulePath(root, 'self-test root');
  const d = (...p: string[]) => join(root, ...p);
  for (const dir of [d('scratch', 'write'), d('common', 'objects', 'pack'), d('common', 'refs', 'heads'), d('lease'), d('fixture')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(d('common', 'config'), '[core]\n\tbare = true\n');
  await writeFile(d('common', 'refs', 'heads', 'main'), '0'.repeat(40) + '\n');
  await writeFile(d('lease', 'README'), 'lease worktree fixture\n');
  await writeFile(d('fixture', 'secret'), 'not a real secret\n', { mode: 0o600 });
  const real = opts.real ?? { read: [], write: [] };
  // A real target that contains the probe itself (e.g. /tmp when TMPDIR is under it) proves nothing useful.
  const outside = (x: string) => !within(root, x);
  const rules = buildSandboxRules({
    role: { name: 'self-test', contract: 'gate', harness: 'self-test' },
    leaseId: 'sandbox-probe',
    layout: { scratchDir: d('scratch'), gitObjectsDir: d('common', 'objects'), harnessDir: null, toolchainDirs: opts.helperDir ? [opts.helperDir] : [] },
    tcpConnectPorts: opts.tcpConnectPorts,
    protectedPaths: [...opts.protectedPaths.filter(outside), d('common'), d('lease'), d('fixture')],
  });
  rules.selfTest = {
    fixtureDir: d('fixture'),
    allowWrite: d('scratch', 'write'),
    allowRead: ['/usr/bin', d('common', 'objects')],
    denyRead: [d('common', 'config'), d('fixture', 'secret'), ...(await existing(real.read)).filter(outside)],
    denyWrite: [d('lease'), d('common', 'refs'), d('common', 'objects'), d('fixture'), ...(await existing(real.write)).filter(outside)],
  };
  for (const p of [...rules.selfTest.denyRead, ...rules.selfTest.denyWrite]) checkRulePath(p, 'self-test path');
  // The rules file sits next to the layout, outside the scratch dir (like a launch's rules file).
  const rulesFile = d('rules.json');
  await writeFile(rulesFile, serializeRules(rules), { mode: 0o600 });
  return { root, rules, rulesFile };
}

export type Exec = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/** Runs the helper's self-test once in a fresh layout under `parent` and removes the layout afterwards. */
export async function runSandboxSelfTest(opts: {
  parent: string; protectedPaths: readonly string[]; tcpConnectPorts?: readonly number[]; real?: RealTargets;
  bin?: string; exec?: Exec; timeoutMs?: number;
}): Promise<SelfTestReport> {
  const bin = opts.bin ?? SANDBOX_BIN;
  const none: SelfTestReport = { state: 'unavailable', detail: '', abi: null, arch: null, helperVersion: null, checks: [] };
  if (!(await access(bin, constants.X_OK).then(() => true, () => false))) {
    return { ...none, detail: `${bin} is not installed (the image predates process-harness isolation)` };
  }
  if (osArch() !== 'x64' && osArch() !== 'arm64') return { ...none, detail: `unsupported architecture ${osArch()}` };
  const layout = await prepareSelfTestLayout(opts.parent, { ...opts, helperDir: dirname(bin) });
  try {
    const res = await (opts.exec ?? run)(bin, ['--self-test', layout.rulesFile], { allowFailure: true, timeoutMs: opts.timeoutMs ?? SELFTEST_TIMEOUT_MS });
    return parseSelfTest(res, layout.rules);
  } finally {
    await rm(layout.root, { recursive: true, force: true });
  }
}

/** What a cached result is valid for: one boot, one container start, one helper binary. */
export interface ProbeIdentity { bootId: string; containerStart: string; helperSha256: string }

/** Boot id and PID 1's start time (field 22 of /proc/1/stat) identify a container start; null if unreadable. */
export async function probeIdentity(bin: string, proc = '/proc'): Promise<ProbeIdentity | null> {
  try {
    const bootId = (await readFile(join(proc, 'sys', 'kernel', 'random', 'boot_id'), 'utf8')).trim();
    const stat = await readFile(join(proc, '1', 'stat'), 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const containerStart = fields[19]; // field 22 overall; fields after "(comm)" start at field 3
    if (!bootId || !containerStart || !/^\d+$/.test(containerStart)) return null;
    return { bootId, containerStart, helperSha256: await sha256File(bin) };
  } catch { return null; }
}

interface CacheFile { identity: ProbeIdentity; at: string; report: SelfTestReport }

const sameIdentity = (a: ProbeIdentity, b: ProbeIdentity) => a.bootId === b.bootId && a.containerStart === b.containerStart && a.helperSha256 === b.helperSha256;

/**
 * The self-test result, run once per container start and cached in `cacheFile` (D4: `/state/run/sandbox-probe.json`).
 * Only a conclusive result (ok / fail / unavailable) is cached; an `error` is retried next time.
 */
export async function cachedSandboxSelfTest(opts: {
  cacheFile: string; identity: ProbeIdentity | null; refresh?: boolean; run: () => Promise<SelfTestReport>; now?: () => Date;
}): Promise<SelfTestReport & { cached: boolean }> {
  if (opts.identity && !opts.refresh) {
    const cached = await readJsonIfExists<CacheFile>(opts.cacheFile).catch(() => undefined);
    if (cached?.identity && cached.report && sameIdentity(cached.identity, opts.identity)) return { ...cached.report, cached: true };
  }
  const report = await opts.run();
  if (opts.identity && report.state !== 'error') {
    const body: CacheFile = { identity: opts.identity, at: (opts.now?.() ?? new Date()).toISOString(), report };
    await atomicWrite(opts.cacheFile, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 }).catch(() => undefined);
  }
  return { ...report, cached: false };
}

/** Launch gate for the runner (task-14.4): every process-harness launch is refused unless the self-test passed. */
export function requireSandbox(r: SelfTestReport): void {
  if (r.state === 'ok') return;
  throw new MinionsError('PRECONDITION', `process isolation unavailable: ${summarizeSandbox(r)}`,
    'Run `minions status --check` for the failing canary; process harnesses stay refused until the self-test passes.');
}
