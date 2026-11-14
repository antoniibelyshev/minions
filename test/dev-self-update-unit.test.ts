// scripts/dev/self-update.mjs (docs/design/coordinator-self-update.md), unit tier (task-137.2.1): the script's main()
// runs in-process with its command seam (setSeams) pointed at an in-memory fake of `git`, `minions`, `docker`, `npm`
// and the host runtime's minions shim, and a scratch MINIONS_HOME on disk. Phase 1: start refusals, the lock, polling,
// idle detection and --dry-run. Phase 2: the apply (sync, host gate in a throwaway worktree, previous-image tag,
// upgrade --rebuild-cli, outcome and notice). Phase 3: the health check and the rollback. Task-7: the host runtime.
// The few end-to-end runs of the real script (real subprocesses, signals and git) are in test/dev-self-update.test.ts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliBackups, globToRegExp, main, matchesAny, NOTICE_MAX, noticeText, paths, pickRequest, prevImageTag, procStart, setSeams, type RunOpts, type RunResult } from '../scripts/dev/self-update.mjs';

const root = join(import.meta.dirname, '..');
const SCRIPT = join(root, 'scripts', 'dev', 'self-update.mjs');
const PROJECT_ID = '0123abcd-0000-4000-8000-000000000001';
const COMPOSE = 'minions-0123abcd';
const TAG = 'minions-runtime:0.1.0';
const PREV = 'minions-runtime:0.1.0-prev';

interface Call { cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; input?: string }
interface Commit { sha: string; msg: string; files: string[] }

/** The fake world the commands see: the checkout's history, the runtime, the images, and switches per test. */
interface World {
  base: string; repo: string; home: string; globalRoot: string; shim: string;
  calls: Call[];
  commits: Commit[]; branch: string; dirty: string[]; worktrees: Map<string, string>;
  /** What `minions upgrade --sync-only` does in the checkout (default: one commit touching the CI workflow). */
  sync: () => void; syncRefuse: boolean; worktreeAddFail: boolean;
  config: unknown; requests: unknown; status: Record<string, unknown>;
  running: boolean; img: Record<string, string>; container: string | null;
  newImage: string | null; upgradeStopsRuntime: boolean; upgradeFail: boolean;
  /** On this image the coordinator does not run / its lock changes hands on every probe. */
  brokenImage: string | null; flapImage: string | null; flaps: number;
  /** The coordinator has Telegram; the value is the poller state. */
  telegram: string | null; doctorFailImage: string | null;
  npmInstallFail: boolean; gateFail: string | null; markFail: boolean;
  notice: string | null; coordinatorRestarts: number;
  /** Runs first for a host `minions` call; a result replaces the fake's own answer. */
  minionsHook: ((a: string, input?: string) => RunResult | undefined) | null;
  /** Runs first for a gate npm step (ci, run typecheck, test). */
  gateHook: ((c: Call) => RunResult | undefined) | null;
  /** Host runtime: the coordinator is down until a coordinator restart through the shim. */
  hostBroken: boolean;
}
let w: World;

const res = (stdout = '', code = 0, stderr = ''): RunResult => ({ code, timedOut: false, abnormal: false, why: '', stdout, stderr });
const envl = (v: unknown) => `${JSON.stringify(v)}\n`;
const okEnv = (data: unknown = {}) => envl({ ok: true, data });
const json = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
let shaN = 0;
const commit = (msg: string, files: string[] = []) => {
  w.commits.push({ sha: createHash('sha1').update(`${shaN++}:${msg}`).digest('hex'), msg, files });
};
const head = () => w.commits.at(-1)!.sha;
const isHostMode = () => (JSON.parse(readFileSync(projectJson(), 'utf8')) as { runtime?: string }).runtime === 'host';
const projectJson = () => join(w.home, 'projects', PROJECT_ID, 'project.json');
const editProject = (over: Record<string, unknown>) => json(projectJson(), { ...JSON.parse(readFileSync(projectJson(), 'utf8')), ...over });

function fakeGit(args: string[], cwd?: string): RunResult {
  const a = args.join(' ');
  if (a === 'rev-parse --show-toplevel') return cwd === w.repo ? res(`${w.repo}\n`) : res('', 128, 'fatal: not a git repository');
  if (a === 'rev-parse --path-format=absolute --git-common-dir') return res(`${join(w.repo, '.git')}\n`);
  if (a === 'symbolic-ref --short -q HEAD') return res(`${w.branch}\n`);
  if (a === 'status --porcelain') return res(w.dirty.join('\n'));
  if (a === 'rev-parse --verify -q refs/heads/main') return res(`${head()}\n`);
  if (a === 'rev-parse HEAD') { const h = cwd ? w.worktrees.get(cwd) : undefined; return h ? res(`${h}\n`) : res('', 128, 'fatal: not a git repository'); }
  if (args[0] === 'log' || args[0] === 'diff') {
    const [from, to] = args.at(-1)!.split('..');
    const i = w.commits.findIndex((c) => c.sha === from), j = w.commits.findIndex((c) => c.sha === to);
    const range = w.commits.slice(i + 1, j + 1);
    if (args[0] === 'diff') return res([...new Set(range.flatMap((c) => c.files))].join('\n'));
    const n = Number(args[args.indexOf('-n') + 1]);
    return res(range.reverse().slice(0, n).map((c) => `${c.sha.slice(0, 7)} ${c.msg}`).join('\n'));
  }
  if (a.startsWith('worktree add --detach ')) {
    // Like a failing post-checkout hook: `git worktree add` exits non-zero after it created the worktree.
    mkdirSync(args[3]!, { recursive: true });
    w.worktrees.set(args[3]!, args[4]!);
    return w.worktreeAddFail ? res('', 1, 'fatal: post-checkout hook failed') : res();
  }
  if (args[0] === 'worktree' && args[1] === 'remove') { w.worktrees.delete(args[3]!); rmSync(args[3]!, { recursive: true, force: true }); return res(); }
  if (a === 'worktree prune') return res();
  return res('', 1, `unexpected fake git call: ${a}`);
}

function hostStatus(): RunResult {
  if (isHostMode()) {
    return res(okEnv({ activeLeases: [], draining: null, restartRequired: { state: 'not-applicable' }, coordinatorLaunch: { state: w.hostBroken ? 'not-running' : 'current', reason: 'x' },
      coordinatorLock: { pid: 100, session: 'coordinator', acquiredAt: '2026-10-29T10:00:00.000Z' }, channel: { effective: 'terminal' }, telegramPoller: { state: 'not-applicable' } }));
  }
  const img = w.container ?? '';
  const launch = w.brokenImage && img === w.brokenImage ? 'not-running' : 'current';
  let pid = 100;
  if (w.flapImage && img === w.flapImage) pid = 200 + ++w.flaps;
  return res(okEnv({ activeLeases: [], draining: null, restartRequired: { state: 'current', required: false, reasons: [] }, coordinatorLaunch: { state: launch, reason: 'x' },
    coordinatorLock: { pid, session: 'coordinator', acquiredAt: '2026-10-29T10:00:00.000Z' }, channel: { effective: w.telegram ? 'telegram' : 'terminal' },
    telegramPoller: { state: w.telegram ?? 'not-applicable' } }));
}

function fakeMinions(args: string[], input?: string): RunResult {
  const a = args.join(' ');
  const hooked = w.minionsHook?.(a, input);
  if (hooked) return hooked;
  switch (a) {
    case '--json config show': return res(envl(w.config));
    case '--json settings requests': return res(envl(w.requests), (w.requests as { ok: boolean }).ok ? 0 : 1);
    case '--json upgrade --sync-only':
      if (w.syncRefuse) return res(envl({ ok: false, error: { code: 'PRECONDITION', message: 'main has diverged from minions/main; nothing is forced' } }), 1);
      w.sync();
      return res(okEnv({ ok: true, steps: [{ id: 'sync', status: 'done', detail: 'fast-forward' }], sync: { action: 'fast-forward' }, stopped: null }));
    case '--json upgrade --rebuild-cli': {
      // As applyCli: back up the installed CLI before replacing it; then the image and the recreate.
      const d = join(w.home, 'manager', 'cli-backup');
      mkdirSync(d, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
      writeFileSync(join(d, `minions-0.1.0-${stamp}${String(readdirSync(d).length).padStart(3, '0')}Z.tgz`), 'old-cli');
      if (w.newImage) w.img[TAG] = w.newImage;
      w.container = w.img[TAG] ?? null;
      if (w.upgradeStopsRuntime) w.running = false;
      if (w.upgradeFail) return res(okEnv({ ok: false, steps: [{ id: 'image', status: 'failed', detail: 'docker build failed' }], stopped: null }), 1);
      return res(okEnv({ ok: true, steps: [{ id: 'cli', status: 'done', detail: 'reinstalled' }], stopped: null }));
    }
    case '--version': return res('0.1.0\n');
    case '--json status': return hostStatus();
    case '--json doctor': {
      const st = w.doctorFailImage && w.container === w.doctorFailImage ? 'fail' : 'ok';
      return res(okEnv({ healthy: false, checks: [{ name: 'telegram.plugin', status: st, detail: `plugin ${st}` }] }));
    }
    case '--json down': w.container = null; w.running = false; return res(okEnv());
    case '--json start --no-attach': w.container = w.img[TAG] ?? null; w.running = true; return res(okEnv({ running: true }));
    default: return res(envl({ ok: false, error: { code: 'INTERNAL', message: 'unexpected fake call' } }), 1);
  }
}

function fakeDocker(args: string[], input?: string): RunResult {
  const a = args.join(' ');
  if (a.includes(' ps --status running -q app')) return res(w.running ? 'c0ffee\n' : '');
  if (a.endsWith(' ps -q app')) return res(w.container ? 'c0ffee\n' : '');
  if (a === 'inspect --format {{.Image}} c0ffee') return w.container ? res(`${w.container}\n`) : res('', 1, 'Error: No such object: c0ffee');
  if (a.endsWith('exec -T app minions coordinator restart --recover --json')) { w.coordinatorRestarts++; return res(okEnv({ action: 'restarted' })); }
  if (a.includes('exec -T app minions status --json')) return res(envl(w.status));
  if (a.includes('exec -T app minions settings requests mark')) {
    // markFail: the runtime refuses every mark except --status confirmed (an error that is not "not running").
    if (!a.includes(' --status confirmed ') && w.markFail) return res(envl({ ok: false, error: { code: 'INTERNAL', message: 'state store is locked' } }), 1);
    return res(okEnv());
  }
  if (a.includes('exec -T app minions notify enqueue')) { w.notice = input ?? ''; return res(okEnv({ created: true })); }
  if (args[0] === 'image' && args[1] === 'inspect') { const t = args[4]!; return t in w.img ? res(`${w.img[t]}\n`) : res('', 1, `Error: No such image: ${t}`); }
  if (args[0] === 'tag') { const [, from, to] = args; if (!(from! in w.img)) return res('', 1, `Error: No such image: ${from}`); w.img[to!] = w.img[from!]!; return res(); }
  return res('', 1, 'unexpected fake docker call');
}

function fakeShim(args: string[], input?: string): RunResult {
  const a = args.join(' ');
  if (a === 'status --json') return res(envl(w.status));
  if (a.startsWith('settings requests mark')) return res(okEnv());
  if (a.startsWith('notify enqueue')) { w.notice = input ?? ''; return res(okEnv({ created: true })); }
  if (a === 'coordinator restart --recover --json') { w.hostBroken = false; return res(okEnv({ action: 'restarted' })); }
  return res(envl({ ok: false, error: { code: 'INTERNAL', message: 'unexpected shim call' } }), 1);
}

function fakeNpm(c: Call): RunResult {
  const a = c.args.join(' ');
  if (a === 'root -g') return res(`${w.globalRoot}\n`);
  if (c.args[0] === 'install' && c.args[1] === '-g') return w.npmInstallFail ? res('', 1, 'npm ERR! EACCES') : res();
  if (!['ci', 'run typecheck', 'test'].includes(a)) return res('', 1, 'unexpected fake npm call');
  const hooked = w.gateHook?.(c);
  if (hooked) return hooked;
  return w.gateFail === a ? res('FAIL test/example.test.ts > it breaks\n', 1) : res();
}

async function fakeRun(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const c: Call = { cmd, args, cwd: opts.cwd, env: opts.env, input: opts.input };
  w.calls.push(c);
  if (cmd === 'git') return fakeGit(args, opts.cwd);
  if (cmd === 'minions') return fakeMinions(args, opts.input);
  if (cmd === 'docker') return fakeDocker(args, opts.input);
  if (cmd === 'npm') return fakeNpm(c);
  if (cmd === w.shim) return fakeShim(args, opts.input);
  return res('', 127, `spawn ${cmd} ENOENT`);
}

function setup(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'minions-self-update-unit-')));
  const repo = join(base, 'repo'), home = join(base, 'home'), globalRoot = join(base, 'global');
  for (const d of [join(repo, 'src'), join(repo, '.git'), join(home, 'projects', PROJECT_ID), join(globalRoot, 'minions', 'dist')]) mkdirSync(d, { recursive: true });
  json(join(repo, 'package.json'), { name: 'minions', version: '0.1.0' });
  writeFileSync(join(repo, 'src', 'cli.ts'), '');
  json(join(home, 'registry.json'), { version: 1, projects: { [PROJECT_ID]: { gitCommonDir: join(repo, '.git'), repoPath: repo, visibility: 'shared' } } });
  json(join(home, 'projects', PROJECT_ID, 'project.json'), { version: 1, projectId: PROJECT_ID, repoPath: repo, baseBranch: 'main', imageTag: TAG });
  json(join(globalRoot, 'minions', 'package.json'), { name: 'minions', version: '0.1.0' });
  json(join(globalRoot, 'minions', 'dist', 'build.json'), { kind: 'packed', source: 'abc' });
  return {
    base, repo, home, globalRoot, shim: join(home, 'projects', PROJECT_ID, 'host', 'bin', 'minions'),
    calls: [], commits: [], branch: 'main', dirty: [], worktrees: new Map(),
    sync: () => commit('change the CI workflow', ['.github/workflows/ci.yml']), syncRefuse: false, worktreeAddFail: false,
    config: { ok: true, data: { delivery: { mode: 'local' }, sensitivePaths: ['.github/workflows/**', 'CLAUDE.md'] } },
    requests: { ok: true, data: { projectId: PROJECT_ID, requests: [] } },
    status: { ok: true, data: { activeLeases: [], draining: null } },
    running: true, img: { [TAG]: 'sha256:0ldimage' }, container: 'sha256:0ldimage',
    newImage: null, upgradeStopsRuntime: false, upgradeFail: false,
    brokenImage: null, flapImage: null, flaps: 0, telegram: null, doctorFailImage: null,
    npmInstallFail: false, gateFail: null, markFail: false,
    notice: null, coordinatorRestarts: 0,
    minionsHook: null, gateHook: null, hostBroken: false,
  };
}

const request = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'upgrade', payload: { fromContainer: true }, reason: 'merged task-1', createdAt: '2026-10-29T10:00:00.000Z',
  status: 'proposed', updatedAt: '2026-10-29T10:00:00.000Z', detail: null, summary: 'upgrade', ...over,
});
const setRequests = (requests: unknown[]) => { w.requests = { ok: true, data: { projectId: PROJECT_ID, requests } }; };
const setStatus = (data: Record<string, unknown>) => { w.status = { ok: true, data: { activeLeases: [], draining: null, ...data } }; };
const log = (cmd: string) => w.calls.filter((c) => c.cmd === cmd).map((c) => c.args.join(' ')).join('\n');
const dockerLog = () => log('docker');
const minionsLog = () => `${log('minions')}\n`;
const shimLog = () => w.calls.filter((c) => c.cmd === w.shim).map((c) => `${c.args.join(' ')} | cwd=${c.cwd}`).join('\n');
const gateCalls = () => w.calls.filter((c) => c.cmd === 'npm' && ['ci', 'run typecheck', 'test'].includes(c.args.join(' ')));
const installCalls = () => w.calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'install');
const stateDir = () => join(w.home, 'dev-self-update');
const readState = () => JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8')) as { current: unknown; badShas: string[]; lastApplied: string | null; prevPin?: unknown };
const events = () => readFileSync(join(stateDir(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown> & { event: string });
const marks = () => (isHostMode() ? shimLog() : dockerLog()).split('\n').filter((l) => l.includes('requests mark cr_'));
const statuses = () => marks().map((l) => / --status (\w+)/.exec(l)?.[1]);
const steps = (e: Record<string, unknown> | undefined) => (e?.steps as { id: string; status: string }[]).map((s) => `${s.id}:${s.status}`);
const applyEvent = () => events().find((e) => e.event === 'apply');
const gateWorktreesGone = () => {
  expect([...w.worktrees.keys()]).toEqual([]);
  const gate = join(stateDir(), 'gate');
  expect(existsSync(gate) ? readdirSync(gate) : []).toEqual([]);
};

let stop: ((signal: string) => void) | null = null;
/** main() with a short health window (0.5 s; probes every 100 ms), its output captured. */
async function runScript(...args: string[]) {
  let out = '', err = '';
  const code = await main(['--repo', w.repo, '--health-window', '0.5', ...args], { out: (t) => { out += t; }, err: (t) => { err += t; }, onStop: (s) => { stop = s; } });
  return { code, out, err };
}

let restoreSeams: () => void;
beforeEach(() => {
  w = setup();
  commit('init', ['package.json', 'src/cli.ts']);
  stop = null;
  vi.stubEnv('MINIONS_HOME', w.home);
  restoreSeams = setSeams({ run: fakeRun, psStart: (pid) => (pid === process.pid ? 'this-test-process' : '') });
});
afterEach(() => {
  restoreSeams();
  vi.unstubAllEnvs();
  rmSync(w.base, { recursive: true, force: true });
});

describe('self-update helpers', () => {
  it('picks the oldest proposed upgrade --from-container request for the base branch', () => {
    const reqs = [
      request('cr_cccccccc', { createdAt: '2026-10-29T12:00:00.000Z' }),
      request('cr_aaaaaaaa', { payload: { fromContainer: 'main' }, createdAt: '2026-10-29T11:00:00.000Z' }),
      request('cr_00000000', { payload: { fromContainer: null }, createdAt: '2026-10-29T09:00:00.000Z' }),
      request('cr_11111111', { kind: 'config-set', payload: { key: 'x' }, createdAt: '2026-10-29T09:00:00.000Z' }),
      request('cr_22222222', { payload: { fromContainer: 'other-branch' }, createdAt: '2026-10-29T09:00:00.000Z' }),
      request('cr_33333333', { status: 'confirmed', createdAt: '2026-10-29T08:00:00.000Z' }),
      request('not-an-id', { createdAt: '2026-10-29T08:00:00.000Z' }),
    ];
    expect(pickRequest(reqs, 'main')?.id).toBe('cr_aaaaaaaa');
    expect(pickRequest([], 'main')).toBeNull();
  });

  it('the previous-image tag, the sensitive-path globs and the CLI backups', () => {
    expect(prevImageTag('minions-runtime:0.1.0')).toBe('minions-runtime:0.1.0-prev');
    expect(prevImageTag('registry:5000/minions')).toBe('registry:5000/minions:latest-prev');
    expect(matchesAny('.github/workflows/ci.yml', ['.github/workflows/**'])).toBe(true);
    expect(matchesAny('./CLAUDE.md', ['CLAUDE.md'])).toBe(true);
    expect(matchesAny('docs/CLAUDE.md', ['CLAUDE.md'])).toBe(false);
    expect(matchesAny('a/b/migrations/1.sql', ['**/migrations/**'])).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    const d = join(w.home, 'manager', 'cli-backup');
    mkdirSync(d, { recursive: true });
    for (const n of ['minions-0.1.0-20261029T100000001Z.tgz', 'minions-0.0.9-20261028T100000000Z.tgz', 'stray.tgz']) writeFileSync(join(d, n), 'x');
    expect(cliBackups(w.home).map((b) => b.version)).toEqual(['0.0.9', '0.1.0']);
    expect(paths(w.home).lock).toBe(join(stateDir(), 'lock'));
  });

  it('a long commit range keeps the owner notice under the outbox limit (4000) and points to the log', () => {
    const range = Array.from({ length: 50 }, (_, i) => `abc${i} merge branch agent/task-${i}-a-fairly-long-task-title-that-fills-the-subject-line`);
    const sensitive = Array.from({ length: 60 }, (_, i) => `.github/workflows/w${i}-with-a-rather-long-workflow-file-name.yml`);
    const text = noticeText({ outcome: 'applied', base: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40), request: 'cr_aaaaaaaa', range, rangeTruncated: true, sensitive, scriptChanged: false }, { log: '/x/log.jsonl' });
    expect(NOTICE_MAX).toBeLessThan(4000);
    expect(text.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(text).toMatch(/^Self-update applied: main aaaaaaaaaaaa\.\.bbbbbbbbbbbb \(request cr_aaaaaaaa\)\./);
    expect(text).toMatch(/Commits \(50\+\):/);
    expect(text).toMatch(/\.\.\. \d+\+ more, see the log/);
    expect(text).toMatch(/Sensitive paths touched: .* and 40 more\./);
    expect(text).toContain('Log: /x/log.jsonl');
  });
});

describe('self-update start refusals', () => {
  const cases: [string, () => void, RegExp][] = [
    ['the project repo is not a minions checkout', () => { json(join(w.repo, 'package.json'), { name: 'other' }); }, /is not a minions checkout/],
    ['the installed CLI is linked, not packed', () => {
      rmSync(join(w.globalRoot, 'minions'), { recursive: true });
      symlinkSync(w.repo, join(w.globalRoot, 'minions'));
    }, /not a packed install \(link/],
    ['the installed CLI has no packed build stamp', () => { rmSync(join(w.globalRoot, 'minions', 'dist', 'build.json')); }, /not a packed install \(unknown/],
    ['the installed CLI came from a git URL', () => { json(join(w.globalRoot, 'minions', 'package.json'), { name: 'minions', _resolved: 'git+https://example.com/minions.git' }); }, /not a packed install \(git/],
    ['no project is registered for the checkout', () => { json(join(w.home, 'registry.json'), { version: 1, projects: {} }); }, /no minions project is registered for/],
    ['delivery is not local', () => { w.config = { ok: true, data: { delivery: { mode: 'pull-request' } } }; }, /delivery mode is "pull-request", not local/],
    ['the runtime is neither Docker nor host', () => { editProject({ runtime: 'k8s' }); }, /runtime is "k8s", not docker or host/],
    ['the checkout is dirty', () => { w.dirty = ['?? stray.txt']; }, /uncommitted or untracked changes/],
    ['the checkout is not on the base branch', () => { w.branch = 'feature'; }, /on branch feature, not the base branch main/],
  ];
  it.each(cases)('refuses when %s', async (_name, mutate, message) => {
    setRequests([request('cr_aaaaaaaa')]);
    mutate();
    const r = await runScript('--once');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/refusing to start/);
    expect(r.err).toMatch(message);
    expect(dockerLog()).not.toMatch(/requests mark/);
    expect(existsSync(stateDir())).toBe(false);
  });

  it('lists every failed condition, not only the first', async () => {
    w.dirty = ['?? stray.txt'];
    w.branch = 'feature';
    const r = await runScript('--once');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/on branch feature(.|\n)*uncommitted or untracked changes/);
  });

  it('rejects unknown arguments with the usage', async () => {
    const r = await runScript('--bogus');
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/unknown argument: --bogus\nusage: node scripts\/dev\/self-update\.mjs/);
  });
});

describe('self-update polling', () => {
  it('takes the oldest proposed upgrade --from-container request through its own docker exec', async () => {
    setRequests([
      request('cr_cccccccc', { createdAt: '2026-10-29T12:00:00.000Z' }),
      request('cr_aaaaaaaa', { payload: { fromContainer: 'main' }, createdAt: '2026-10-29T11:00:00.000Z' }),
      request('cr_22222222', { payload: { fromContainer: 'other-branch' }, createdAt: '2026-10-29T09:00:00.000Z' }),
    ]);
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    const l = dockerLog();
    expect(l).toContain(`compose -p ${COMPOSE} -f ${join(w.home, 'projects', PROJECT_ID, 'compose.yaml')} exec -T app minions settings requests mark cr_aaaaaaaa --status confirmed`);
    expect(l).not.toMatch(/mark cr_(cccccccc|22222222)/);
    expect(l.indexOf('minions status --json')).toBeLessThan(l.indexOf('--status confirmed'));
    expect(r.out).toContain('took request cr_aaaaaaaa');

    expect(readState().current).toBeNull();
    expect(events().map((e) => e.event)).toEqual(['started', 'taken', 'apply', 'marked', 'notice', 'stopped']);
    expect(statSync(join(stateDir(), 'log.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir(), 'state.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(stateDir(), 'lock'))).toBe(false);
  });

  it('no open request: nothing is taken', async () => {
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('no open upgrade --from-container request');
    expect(dockerLog()).not.toMatch(/requests mark/);
  });

  it('does not take a request while a worker lease is active or a drain runs', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    setStatus({ activeLeases: [{ id: 'lease-1' }] });
    let r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/waiting for idle: 1 active worker lease\(s\) \(lease-1\); not taken/);
    setStatus({ draining: { at: '2026-10-29T10:00:00.000Z' } });
    r = await runScript('--once');
    expect(r.out).toMatch(/waiting for idle: a drain is in progress; not taken/);
    w.status = { ok: true, data: { draining: null } };
    r = await runScript('--once');
    expect(r.out).toMatch(/cannot tell whether the runtime is idle \(the runtime status has no activeLeases\)/);
    expect(dockerLog()).not.toMatch(/requests mark/);
  });

  it('waits while the local integrator holds the integration lock, and proceeds on a free lock (task-82.5)', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    const integration = (state: string, pid: number | null) => ({
      enabled: true, lock: { state, pid, at: pid ? '2026-10-29T10:00:00.000Z' : null },
      current: state === 'live' ? { taskId: 'task-7', phase: 'verifying' } : null, queue: [], problems: [],
    });
    setStatus({ integration: integration('live', 4242) });
    let r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/waiting for idle: the integrator holds the integration lock \(pid 4242, task-7 verifying\); not taken/);
    expect(dockerLog()).not.toMatch(/requests mark/);
    // A present block with an unreadable lock is not idle either.
    setStatus({ integration: { enabled: true } });
    r = await runScript('--once');
    expect(r.out).toMatch(/cannot tell whether the runtime is idle \(the runtime status has an integration block without a readable lock state\)/);
    expect(dockerLog()).not.toMatch(/requests mark/);
    setStatus({ integration: integration('none', null) });
    r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toMatch(/waiting for idle/);
    expect(dockerLog()).toMatch(/requests mark cr_aaaaaaaa --status confirmed/);
  });

  it('a stale integration lock (dead holder) is idle (task-82.5)', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    setStatus({ integration: { enabled: true, lock: { state: 'stale', pid: 4242, at: '2026-10-29T10:00:00.000Z' }, current: null, queue: [], problems: [] } });
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toMatch(/waiting for idle|cannot tell/);
    expect(dockerLog()).toMatch(/requests mark cr_aaaaaaaa --status confirmed/);
  });

  it('treats a stopped runtime as retry later, not as a failure', async () => {
    w.running = false;
    w.requests = { ok: false, error: { code: 'PRECONDITION', message: 'The runtime is not running, so change requests cannot be reached.' } };
    let r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/runtime not running: retry later/);
    // The listing still answers (e.g. the container stops between the two calls): nothing is marked either.
    setRequests([request('cr_aaaaaaaa')]);
    r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/cr_aaaaaaaa .*runtime not running: retry later/);
    expect(dockerLog()).not.toMatch(/exec/);
  });

  it('marks a request left confirmed by an interrupted run as failed, without running it again', async () => {
    mkdirSync(stateDir(), { recursive: true });
    json(join(stateDir(), 'state.json'), { version: 1, lastApplied: null, badShas: [], current: { id: 'cr_bbbbbbbb', takenAt: '2026-10-29T09:00:00.000Z', runId: 'old' } });
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).toMatch(/requests mark cr_bbbbbbbb --status failed --detail self-update: the script stopped/);
    expect(readState().current).toBeNull();
    expect(events().find((e) => e.event === 'interrupted')).toMatchObject({ request: 'cr_bbbbbbbb', marked: true });
    expect(minionsLog()).not.toMatch(/upgrade/);
  });

  it('--dry-run prints the plan and marks, writes and logs nothing', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    const r = await runScript('--dry-run');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('self-update plan (dry run');
    expect(r.out).toContain('installed CLI: packed');
    expect(r.out).toContain('delivery: local');
    expect(r.out).toContain('would take request cr_aaaaaaaa');
    expect(r.out).toContain(`docker compose -p ${COMPOSE}`);
    expect(r.out).toContain('minions --json upgrade --sync-only');
    expect(r.out).toContain('npm ci && npm run typecheck && npm test');
    expect(r.out).toContain(`docker tag ${TAG} ${PREV}`);
    expect(r.out).toContain('minions --json upgrade --rebuild-cli');
    expect(dockerLog()).not.toMatch(/requests mark|notify|tag /);
    expect(minionsLog()).not.toMatch(/upgrade/);
    expect(gateCalls()).toEqual([]);
    expect(w.commits).toHaveLength(1);
    expect(existsSync(stateDir())).toBe(false);
  });

  it('dry run of a refused start lists the refusals', async () => {
    w.config = { ok: true, data: { delivery: { mode: 'branch' } } };
    const r = await runScript('--dry-run');
    expect(r.code).toBe(2);
    expect(r.out).toContain('self-update plan (dry run');
    expect(r.err).toMatch(/delivery mode is "branch"/);
  });

  it('--dry-run leaves a pending outcome untouched (nothing is marked or notified)', async () => {
    mkdirSync(stateDir(), { recursive: true });
    const pending = { version: 1, lastApplied: null, badShas: [], current: { id: 'cr_bbbbbbbb', takenAt: '2026-10-29T09:00:00.000Z', runId: 'old',
      outcome: { status: 'applied', detail: 'self-update a..b', marked: false, notice: { key: 'self-update:cr_bbbbbbbb', text: 'x\n' } } } };
    json(join(stateDir(), 'state.json'), pending);
    setRequests([request('cr_aaaaaaaa')]);
    const r = await runScript('--dry-run');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).not.toMatch(/requests mark|notify enqueue|^tag /m);
    expect(minionsLog()).not.toMatch(/upgrade/);
    expect(JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8'))).toEqual(pending);
    expect(existsSync(join(stateDir(), 'log.jsonl'))).toBe(false);
  });
});

describe('self-update lock', () => {
  it('refuses to start while a live instance holds the lock, and leaves its lock alone', async () => {
    mkdirSync(stateDir(), { recursive: true });
    const lock = { pid: process.pid, start: procStart(process.pid), at: '2026-10-01T00:00:00.000Z' };
    json(join(stateDir(), 'lock'), lock);
    const r = await runScript('--once');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(new RegExp(`another self-update script runs \\(pid ${process.pid}, since 2026-10-01T00:00:00.000Z\\)`));
    expect(JSON.parse(readFileSync(join(stateDir(), 'lock'), 'utf8'))).toEqual(lock);
  });

  it('takes over a stale lock whose pid was reused by another process', async () => {
    mkdirSync(stateDir(), { recursive: true });
    // process.pid is alive (this test runner) but its start time differs: a reused pid, not a holder.
    json(join(stateDir(), 'lock'), { pid: process.pid, start: 'not-the-start-time', at: '2026-10-01T00:00:00.000Z' });
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('started');
    expect(existsSync(join(stateDir(), 'lock'))).toBe(false);
  });
});

describe('self-update apply (phase 2)', () => {
  it('gate passes: syncs, gates the exact synced commit, keeps the previous image, upgrades, marks applied and notifies', async () => {
    const from = head();
    setRequests([request('cr_aaaaaaaa')]);
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    const to = head();
    expect(to).not.toBe(from);
    expect(minionsLog()).toMatch(/--json upgrade --sync-only\n(.|\n)*--json upgrade --rebuild-cli/);
    const gate = gateCalls();
    expect(gate.map((c) => c.args.join(' '))).toEqual(['ci', 'run typecheck', 'test']);
    for (const c of gate) {
      expect(w.calls.find((x) => x.cmd === 'git' && x.args[1] === 'add' && x.args[3] === c.cwd)?.args[4]).toBe(to);
      expect(c.env?.MINIONS_TEST_MAX_WORKERS).toBe('2');
      expect(c.cwd).toMatch(new RegExp(`^${join(stateDir(), 'gate').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${to.slice(0, 12)}-`));
      expect(c.env?.MINIONS_HOME).not.toBe(w.home);
    }
    gateWorktreesGone();
    expect(dockerLog()).toContain(`tag ${TAG} ${PREV}`);
    expect(statuses()).toEqual(['confirmed', 'applied']);
    expect(marks()[1]).toContain(`--detail self-update ${from.slice(0, 12)}..${to.slice(0, 12)}`);
    expect(dockerLog()).toContain('exec -T app minions notify enqueue --key self-update:cr_aaaaaaaa --kind status --json');
    expect(w.notice).toContain('Self-update applied');
    expect(w.notice).toContain('change the CI workflow');
    expect(w.notice).toContain('Sensitive paths touched: .github/workflows/ci.yml.');
    expect(w.notice).toContain(join(stateDir(), 'log.jsonl'));
    expect(readState()).toMatchObject({ current: null, lastApplied: to, badShas: [] });
    expect(applyEvent()).toMatchObject({ request: 'cr_aaaaaaaa', from, to, outcome: 'applied', sensitive: ['.github/workflows/ci.yml'], previousImage: { tag: PREV, id: 'sha256:0ldimage' } });
    expect(steps(applyEvent())).toEqual(['sync:done', 'gate-worktree:done', 'gate-ci:done', 'gate-typecheck:done', 'gate-test:done', 'previous-image:done', 'upgrade:done', 'health:done']);
  });

  it('a commit under scripts/dev/ tells the owner to restart the script', async () => {
    w.sync = () => commit('fix the self-update script', ['scripts/dev/self-update.mjs']);
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(w.notice).toContain('The self-update script changed (scripts/dev/); restart it to use the new version.');
    expect(w.notice).toContain('Sensitive paths touched: none.');
  });

  it('a target already applied is marked applied without a gate, a build or a notice', async () => {
    w.sync = () => {};
    mkdirSync(stateDir(), { recursive: true });
    json(join(stateDir(), 'state.json'), { version: 1, lastApplied: head(), badShas: [], current: null });
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(gateCalls()).toEqual([]);
    expect(marks()[1]).toMatch(/--status applied --detail self-update: already at [0-9a-f]{12}; nothing to do/);
    expect(w.notice).toBeNull();
  });

  it('gate fails: builds nothing, marks the request failed with the reason and records the SHA as bad', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.gateFail = 'test';
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    const to = head();
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(dockerLog()).not.toMatch(/(^|\n)tag |image inspect/);
    gateWorktreesGone();
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(new RegExp(`the host gate failed at ${to.slice(0, 12)} \\(npm test failed \\(exit 1\\): FAIL test/example.test.ts`));
    expect(marks()[1]).toMatch(/nothing was built/);
    expect(w.notice).toMatch(/^Self-update failed \(request cr_aaaaaaaa\): .*host gate failed/);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [to] });
  });

  it('a typecheck failure in the gate records the SHA as bad and skips the tests', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.gateFail = 'run typecheck';
    expect((await runScript('--once')).code).toBe(0);
    const to = head();
    expect(gateCalls().map((c) => c.args.join(' '))).toEqual(['ci', 'run typecheck']);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(marks()[1]).toMatch(new RegExp(`npm run typecheck failed \\(exit 1\\).*${to.slice(0, 12)} is recorded as bad`));
    expect(readState()).toMatchObject({ current: null, badShas: [to] });
    gateWorktreesGone();
  });

  it('an npm ci failure in the gate fails the request but does not record the SHA as bad', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.gateFail = 'ci';
    expect((await runScript('--once')).code).toBe(0);
    expect(gateCalls().map((c) => c.args.join(' '))).toEqual(['ci']);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/npm ci failed .*is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
    gateWorktreesGone();
  });

  it.each([
    ['an outside SIGKILL', { code: 127, abnormal: true, why: 'ended by SIGKILL' }, /npm test did not finish \(ended by SIGKILL\)/],
    ['output over the 64 MB maxBuffer', { code: 127, abnormal: true, why: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, /npm test did not finish \(ERR_CHILD_PROCESS_STDIO_MAXBUFFER\)/],
    ['a timeout', { code: 127, abnormal: true, timedOut: true, why: 'ended by SIGTERM' }, /npm test timed out after 60 min/],
  ])('a gate step ended by %s is transient: the SHA is not recorded as bad', async (_name, end, detail) => {
    w.gateHook = (c) => (c.args.join(' ') === 'test' ? { ...res('', 0), ...end } : undefined);
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(detail);
    expect(marks()[1]).toMatch(/is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
  });

  it('a failed `git worktree add` fails the request, runs no npm step and does not record the SHA as bad', async () => {
    w.worktreeAddFail = true;
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(gateCalls()).toEqual([]);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/git worktree add failed.*is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
    gateWorktreesGone();
  });

  it('the gate runs with a scratch MINIONS_HOME (removed after) and without the runtime or handoff variables', async () => {
    vi.stubEnv('MINIONS_RUNTIME', 'container');
    vi.stubEnv('MINIONS_UPGRADE_HANDOFF', '1');
    const registry = readFileSync(join(w.home, 'registry.json'), 'utf8');
    // What a careless test in the project would do: write into its MINIONS_HOME.
    w.gateHook = (c) => { writeFileSync(join(c.env!.MINIONS_HOME!, 'registry.json'), 'x'); return undefined; };
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    const to = head();
    const homes = [...new Set(gateCalls().map((c) => c.env!.MINIONS_HOME!))];
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatch(new RegExp(`^${join(stateDir(), 'gate').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${to.slice(0, 12)}-[0-9a-f]{8}\\.home$`));
    expect(existsSync(homes[0]!)).toBe(false);
    for (const c of gateCalls()) {
      expect(c.env).not.toHaveProperty('MINIONS_RUNTIME');
      expect(c.env).not.toHaveProperty('MINIONS_UPGRADE_HANDOFF');
    }
    expect(readFileSync(join(w.home, 'registry.json'), 'utf8')).toBe(registry);
    gateWorktreesGone();
  });

  it('refused sync: builds and gates nothing and marks the request failed with the reason', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.syncRefuse = true;
    expect((await runScript('--once')).code).toBe(0);
    expect(gateCalls()).toEqual([]);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(marks()[1]).toMatch(/--status failed --detail self-update: the sync was refused \(main has diverged from minions\/main; nothing is forced\); nothing was built/);
    expect(w.notice).toContain('the sync was refused');
    expect(readState()).toMatchObject({ current: null, badShas: [] });
  });

  it('skips a SHA recorded as bad: no gate, no build, the request is marked failed', async () => {
    w.sync = () => {}; // up to date: the target is the current HEAD
    mkdirSync(stateDir(), { recursive: true });
    json(join(stateDir(), 'state.json'), { version: 1, lastApplied: null, badShas: [head()], current: null });
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(gateCalls()).toEqual([]);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(marks()[1]).toMatch(new RegExp(`--status failed --detail self-update: ${head().slice(0, 12)} failed before and is recorded as bad; it is not tried again`));
    expect(readState().badShas).toEqual([head()]);
  });

  it('a missing previous image fails the request before anything is built, without recording the SHA as bad', async () => {
    editProject({ imageTag: 'minions-runtime:gone' });
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(dockerLog()).toContain('image inspect --format {{.Id}} minions-runtime:gone');
    expect(dockerLog()).not.toMatch(/^tag /m);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/the previous image could not be kept .*nothing was built/);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [] });
    gateWorktreesGone();
  });

  it('a stop during the gate builds nothing and keeps the request confirmed for the next start', async () => {
    w.gateHook = (c) => { if (c.args.join(' ') === 'test') stop!('SIGTERM'); return undefined; };
    setRequests([request('cr_aaaaaaaa')]);
    const r = await runScript('--interval', '60');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/stopped during gate-test/);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed']);
    expect(readState()).toMatchObject({ current: { id: 'cr_aaaaaaaa' }, badShas: [] });
    expect(events().map((e) => e.event)).toContain('apply-stopped');
    expect(existsSync(join(stateDir(), 'lock'))).toBe(false);
    gateWorktreesGone();
  });

  it('a runtime that is down after the upgrade keeps the outcome pending and marks and notifies on a later poll', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.upgradeStopsRuntime = true;
    expect((await runScript('--once')).code).toBe(0);
    expect(statuses()).toEqual(['confirmed']);
    expect((readState().current as { outcome: { status: string } }).outcome.status).toBe('applied');
    w.running = true;
    setRequests([]);
    expect((await runScript('--once')).code).toBe(0);
    expect(statuses()).toEqual(['confirmed', 'applied']);
    expect(dockerLog()).not.toMatch(/the script stopped/);
    expect(w.notice).toContain('Self-update applied');
    expect(readState().current).toBeNull();
    expect(minionsLog().match(/--rebuild-cli/g)).toHaveLength(1);
  });

  it('a mark the runtime refuses stays pending and is retried on later polls, taking no new request meanwhile', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.markFail = true;
    expect((await runScript('--once')).code).toBe(0);
    type Pending = { id: string; outcome: { status: string; marked: boolean; markAttempts: number } };
    expect((readState().current as Pending).outcome).toMatchObject({ status: 'applied', marked: false, markAttempts: 1 });
    expect(dockerLog()).not.toMatch(/notify enqueue/);

    setRequests([request('cr_bbbbbbbb', { createdAt: '2026-10-29T11:00:00.000Z' })]);
    expect((await runScript('--once')).code).toBe(0);
    expect((readState().current as Pending).outcome.markAttempts).toBe(2);
    expect(dockerLog()).not.toMatch(/requests mark cr_bbbbbbbb/);
    expect(minionsLog().match(/upgrade --sync-only/g)).toHaveLength(1);

    // The runtime recovers: the next poll marks it and sends the notice.
    w.markFail = false;
    setRequests([]);
    expect((await runScript('--once')).code).toBe(0);
    expect(statuses()).toEqual(['confirmed', 'applied', 'applied', 'applied']);
    expect(events().find((e) => e.event === 'marked')).toMatchObject({ ok: true });
    expect(w.notice).toContain('Self-update applied');
    expect(readState().current).toBeNull();
  });

  it('a mark refused 3 times is given up with a clear log line, and the notice still goes out', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.markFail = true;
    await runScript('--once');
    setRequests([]);
    await runScript('--once');
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/NOT marked applied after 3 attempts .*mark it by hand/);
    expect(statuses()).toEqual(['confirmed', 'applied', 'applied', 'applied']);
    expect(events().filter((e) => e.event === 'mark-failed')).toHaveLength(2);
    expect(events().find((e) => e.event === 'marked')).toMatchObject({ ok: false, gaveUp: true, message: 'state store is locked' });
    expect(w.notice).toContain('Self-update applied');
    expect(readState().current).toBeNull();
  });
});

describe('self-update health check and rollback (phase 3)', () => {
  it('a healthy update keeps the new image and CLI: no rollback, marked applied', async () => {
    w.newImage = 'sha256:newimage';
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(w.container).toBe('sha256:newimage');
    expect(w.img[TAG]).toBe('sha256:newimage');
    expect(w.img[PREV]).toBe('sha256:0ldimage');
    expect(installCalls()).toEqual([]);
    expect(minionsLog()).not.toMatch(/--json (down|start)/);
    expect(statuses()).toEqual(['confirmed', 'applied']);
    // The health probes: fresh `--version` and `--json status`, and the container's image.
    expect(minionsLog()).toMatch(/--rebuild-cli\n(.|\n)*--version\n--json status/);
    expect(dockerLog()).toContain('inspect --format {{.Image}} c0ffee');
    expect(applyEvent()).toMatchObject({ outcome: 'applied', health: { healthy: true } });
    expect(steps(applyEvent()).slice(-2)).toEqual(['upgrade:done', 'health:done']);
    expect(readState().prevPin).toBeNull();
  });

  it('not healthy after the upgrade: reinstalls the CLI backup, tags -prev back, down and start on the old CLI, records the SHA as bad', async () => {
    w.newImage = 'sha256:newimage';
    w.brokenImage = 'sha256:newimage';
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    const to = head();
    // The old build runs again: -prev is the image tag again and the container was recreated from it.
    expect(w.img[TAG]).toBe('sha256:0ldimage');
    expect(w.container).toBe('sha256:0ldimage');
    const dir = join(w.home, 'manager', 'cli-backup');
    const backups = readdirSync(dir);
    expect(backups).toHaveLength(1);
    expect(installCalls().map((c) => `${c.args.join(' ')} | cwd=${c.cwd}`)).toEqual([`install -g --no-audit --no-fund ${join(dir, backups[0]!)} | cwd=${dir}`]);
    expect(minionsLog()).toMatch(/--rebuild-cli\n(.|\n)*--json down\n--json start --no-attach\n/);
    expect(w.coordinatorRestarts).toBe(1);
    expect(steps(applyEvent()).slice(6)).toEqual(['upgrade:done', 'health:failed', 'rollback-cli:done', 'rollback-image:done', 'rollback-down:done',
      'rollback-start:done', 'rollback-coordinator:done', 'health-after-rollback:done']);
    expect(applyEvent()).toMatchObject({ outcome: 'failed', health: { healthy: false }, rollback: { ok: true, healthy: true } });
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(new RegExp(`not healthy after the upgrade to ${to.slice(0, 12)} \\(not healthy within 1 s: the coordinator is not running\\); rolled back to the previous CLI and image \\(minions-runtime:0.1.0-prev\\); the coordinator is healthy again on the previous build; ${to.slice(0, 12)} is recorded as bad`));
    expect(w.notice).toMatch(/^Self-update failed .*rolled back to the previous CLI and image/);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [to] });
  });

  it('the container on another image than the tag names is not healthy', async () => {
    w.newImage = 'sha256:newimage';
    w.minionsHook = (a) => { if (a === '--json upgrade --rebuild-cli') { w.img[TAG] = 'sha256:newimage'; return res(okEnv({ ok: true, steps: [], stopped: null })); } return undefined; };
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(marks()[1]).toMatch(/not healthy after the upgrade .*the container runs image 0ldimage, not newimage/);
  });

  it('more than one coordinator restart in the window is not healthy', async () => {
    w.newImage = 'sha256:newimage';
    w.flapImage = 'sha256:newimage';
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(marks()[1]).toMatch(/not healthy after the upgrade .*\(the coordinator restarted 2 times within the health window\); rolled back/);
    expect(w.container).toBe('sha256:0ldimage');
  });

  it('a Telegram coordinator without a live poller is not healthy', async () => {
    w.newImage = 'sha256:newimage';
    w.telegram = 'dead';
    setRequests([request('cr_aaaaaaaa')]);
    await runScript('--once');
    expect(marks()[1]).toMatch(/not healthy after the upgrade .*the Telegram poller is dead/);
    // Never healthy here, also after the rollback, so `doctor` (it runs only when the rest passes) never ran.
    expect(minionsLog()).not.toMatch(/--json doctor/);
  });

  it('a Telegram coordinator is not healthy when doctor reports telegram.plugin as fail', async () => {
    w.newImage = 'sha256:newimage';
    w.telegram = 'ok';
    w.doctorFailImage = 'sha256:newimage';
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(marks()[1]).toMatch(/not healthy after the upgrade .*telegram\.plugin: plugin fail\); rolled back.*healthy again on the previous build/);
    expect(minionsLog()).toMatch(/--json doctor/);
    expect(w.container).toBe('sha256:0ldimage');
  });

  it('no healthy coordinator even after the rollback: the request is marked failed and the notice says so', async () => {
    w.newImage = 'sha256:newimage';
    w.brokenImage = 'sha256:newimage';
    w.npmInstallFail = true; // the CLI cannot be reinstalled: the rollback stops there
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(minionsLog()).not.toMatch(/--json (down|start)/); // never `start` on the new CLI (it would rebuild the image)
    // The rollback restarted nothing, so the check after it does not wait out the window: 2 probes, then the notice.
    expect(applyEvent()).toMatchObject({ rollback: { healthy: false, health: expect.stringMatching(/^not healthy in 2 probe\(s\): the coordinator is not running/) } });
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/the CLI backup could not be reinstalled.*; no healthy coordinator even after the rollback .*; .* is recorded as bad/);
    expect(w.notice).toMatch(/no healthy coordinator even after the rollback/);
  });

  it('a retry never replaces a known-good -prev with the image of an update that was not confirmed healthy', async () => {
    // 1st request: the update is broken and the rollback fails, so the broken image stays on the tag.
    w.newImage = 'sha256:badimage';
    w.brokenImage = 'sha256:badimage';
    w.npmInstallFail = true;
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(w.img[TAG]).toBe('sha256:badimage');
    expect(w.img[PREV]).toBe('sha256:0ldimage');
    expect(readState().prevPin).toBe('sha256:0ldimage');

    // 2nd request (a fix on main): -prev keeps the known-good image instead of taking the broken one.
    w.npmInstallFail = false;
    w.newImage = 'sha256:fixedimage';
    w.calls.length = 0;
    setRequests([request('cr_bbbbbbbb', { createdAt: '2026-10-29T11:00:00.000Z' })]);
    expect((await runScript('--once')).code).toBe(0);
    expect(dockerLog()).not.toContain(`tag ${TAG} ${PREV}`);
    expect(w.img[PREV]).toBe('sha256:0ldimage');
    const apply = events().filter((e) => e.event === 'apply').at(-1)!;
    expect(apply).toMatchObject({ request: 'cr_bbbbbbbb', outcome: 'applied', previousImage: { tag: PREV, id: 'sha256:0ldimage', kept: true } });
    expect((apply.steps as { id: string; detail: string }[]).find((s) => s.id === 'previous-image')!.detail).toMatch(/kept: the last update was not confirmed healthy/);
    // Confirmed healthy now: the pin is cleared, so the next update keeps this image as -prev.
    expect(w.container).toBe('sha256:fixedimage');
    expect(readState().prevPin).toBeNull();
  });

  it('a failed upgrade rolls back, is marked failed, and the SHA is not recorded as bad (it can be transient)', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    w.upgradeFail = true;
    expect((await runScript('--once')).code).toBe(0);
    expect(dockerLog()).toContain(`tag ${TAG} ${PREV}`);
    expect(dockerLog()).toContain(`tag ${PREV} ${TAG}`);
    expect(installCalls().map((c) => c.args.join(' '))).toEqual([expect.stringMatching(/^install -g --no-audit --no-fund .*cli-backup\/minions-0\.1\.0-\d{8}T\d{9}Z\.tgz$/)]);
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach/);
    expect(marks()[1]).toMatch(/--status failed --detail self-update: minions upgrade --rebuild-cli failed \(failed: image \(docker build failed\)\); rolled back to the previous CLI and image/);
    expect(marks()[1]).toMatch(/is not recorded as bad \(the upgrade itself failed/);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [] });
  });

  it('a failed upgrade that replaced neither the CLI nor the image: no rollback, no down and start, marked failed', async () => {
    // The upgrade fails before its CLI step (no backup) and before any image build.
    w.minionsHook = (a) => (a === '--json upgrade --rebuild-cli' ? res(okEnv({ ok: false, steps: [{ id: 'preflight', status: 'failed', detail: 'disk full' }], stopped: null }), 1) : undefined);
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(installCalls()).toEqual([]);
    expect(minionsLog()).not.toMatch(/--json (down|start)/);
    expect(dockerLog()).not.toContain(`tag ${PREV} ${TAG}`);
    expect(w.coordinatorRestarts).toBe(0);
    expect(steps(applyEvent()).slice(-2)).toEqual(['upgrade:failed', 'health-unchanged:done']);
    expect(applyEvent()).toMatchObject({ outcome: 'failed', rollback: { skipped: true, healthy: true } });
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/minions upgrade --rebuild-cli failed \(.*disk full.*\); it replaced neither the CLI nor the image and the coordinator is healthy on the current build, so nothing was rolled back or restarted; .* is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
  });

  it('a stopped upgrade is a failed upgrade: its reason is reported', async () => {
    w.minionsHook = (a) => (a === '--json upgrade --rebuild-cli' ? res(okEnv({ ok: false, steps: [], stopped: { reason: 'the owner stopped the drain' } }), 1) : undefined);
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(marks()[1]).toMatch(/minions upgrade --rebuild-cli failed \(stopped: the owner stopped the drain\)/);
  });

  it('a failed upgrade that rebuilt the image without a CLI backup still rolls back, even with a healthy coordinator', async () => {
    // No CLI backup (the CLI step did not reinstall), but the image tag moved and the container runs the new image,
    // with a healthy coordinator: the health-unchanged shortcut must not apply, the old image comes back.
    w.minionsHook = (a) => {
      if (a !== '--json upgrade --rebuild-cli') return undefined;
      w.img[TAG] = 'sha256:newimage';
      w.container = 'sha256:newimage';
      return res(okEnv({ ok: false, steps: [{ id: 'origin', status: 'failed', detail: 'no network' }], stopped: null }), 1);
    };
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    const s = steps(applyEvent());
    expect(s.filter((x) => x.startsWith('health-unchanged'))).toEqual([]);
    expect(s).toEqual(expect.arrayContaining(['upgrade:failed', 'rollback-cli:done', 'rollback-image:done', 'rollback-start:done', 'health-after-rollback:done']));
    expect(installCalls()).toEqual([]);
    expect(dockerLog()).toContain(`tag ${PREV} ${TAG}`);
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach\n/);
    expect(w.container).toBe('sha256:0ldimage');
    expect(applyEvent()).toMatchObject({ outcome: 'failed', rollback: { healthy: true } });
    expect(applyEvent()?.rollback).not.toHaveProperty('skipped');
    expect(marks()[1]).toMatch(/the coordinator is healthy again on the previous build; .* is not recorded as bad/);
  });

  it('a failed upgrade that replaced nothing but left no healthy coordinator still rolls back', async () => {
    w.minionsHook = (a) => {
      if (a === '--json upgrade --rebuild-cli') {
        w.running = false;
        w.brokenImage = w.container;
        return res(okEnv({ ok: false, steps: [{ id: 'drain', status: 'failed', detail: 'timeout' }], stopped: null }), 1);
      }
      if (a === '--json start --no-attach') w.brokenImage = null;
      return undefined;
    };
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach\n/);
    expect(steps(applyEvent())).toEqual(expect.arrayContaining(['upgrade:failed', 'health-unchanged:failed', 'rollback-cli:done', 'rollback-start:done', 'health-after-rollback:done']));
    expect(marks()[1]).toMatch(/the coordinator is healthy again on the previous build; .* is not recorded as bad/);
  });

  it('-prev is gone at rollback time: no re-tag, but down and start still run on the old CLI and any rebuilt image is accepted', async () => {
    w.newImage = 'sha256:newimage';
    w.brokenImage = 'sha256:newimage';
    // The upgrade loses -prev (pruned by hand); the old CLI's `start` then rebuilds the image from the old code.
    w.minionsHook = (a) => {
      if (a === '--json upgrade --rebuild-cli') delete w.img[PREV];
      if (a === '--json start --no-attach') w.img[TAG] = 'sha256:rebuiltold';
      return undefined;
    };
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(dockerLog()).not.toContain(`tag ${PREV} ${TAG}`);
    expect(installCalls()).toHaveLength(1);
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach\n/);
    expect(w.container).toBe('sha256:rebuiltold');
    expect(steps(applyEvent())).toEqual(expect.arrayContaining(['rollback-cli:done', 'rollback-image:failed', 'rollback-down:done', 'rollback-start:done', 'rollback-coordinator:done', 'health-after-rollback:done']));
    expect(applyEvent()).toMatchObject({ outcome: 'failed', rollback: { ok: false, healthy: true } });
    expect(marks()[1]).toMatch(/rolled back with failures \(image re-tag; see the log\); the coordinator is healthy again on the previous build; .* is recorded as bad/);
    expect(readState().prevPin).toBeNull();
  });
});

describe('self-update on the host runtime (task-7)', () => {
  const hostDir = () => join(w.home, 'projects', PROJECT_ID, 'host');
  beforeEach(() => {
    editProject({ runtime: 'host' });
    mkdirSync(join(hostDir(), 'bin'), { recursive: true });
    mkdirSync(join(hostDir(), 'workspace'), { recursive: true });
    writeFileSync(w.shim, '#!/bin/sh\n'); // a regular file: `minions start` prepared the host runtime
  });

  it('takes the request through the shim, syncs, gates, upgrades and marks applied without any docker call', async () => {
    const from = head();
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    const to = head();
    expect(dockerLog()).toBe('');
    expect(statuses()).toEqual(['confirmed', 'applied']);
    expect(marks()[0]).toContain(`| cwd=${join(hostDir(), 'workspace')}`);
    expect(marks()[1]).toContain(`--detail self-update ${from.slice(0, 12)}..${to.slice(0, 12)}`);
    expect(shimLog()).toContain('notify enqueue --key self-update:cr_aaaaaaaa --kind status --json');
    expect(minionsLog()).toMatch(/--json upgrade --sync-only\n(.|\n)*--json upgrade --rebuild-cli/);
    expect(applyEvent()).toMatchObject({ outcome: 'applied', previousImage: null, health: { healthy: true } });
    expect(steps(applyEvent())).toEqual(['sync:done', 'gate-worktree:done', 'gate-ci:done', 'gate-typecheck:done', 'gate-test:done', 'upgrade:done', 'health:done']);
  });

  it('not healthy after the upgrade: reinstalls the CLI backup, down and start on the old CLI, restart --recover through the shim; no image steps', async () => {
    w.hostBroken = true;
    setRequests([request('cr_aaaaaaaa')]);
    expect((await runScript('--once')).code).toBe(0);
    expect(dockerLog()).toBe('');
    const backups = readdirSync(join(w.home, 'manager', 'cli-backup'));
    expect(installCalls().map((c) => c.args.at(-1))).toEqual([join(w.home, 'manager', 'cli-backup', backups[0]!)]);
    expect(minionsLog()).toMatch(/--rebuild-cli\n(.|\n)*--json down\n--json start --no-attach\n/);
    expect(shimLog()).toContain('coordinator restart --recover --json');
    expect(steps(applyEvent()).slice(5)).toEqual(['upgrade:done', 'health:failed', 'rollback-cli:done', 'rollback-down:done', 'rollback-start:done', 'rollback-coordinator:done', 'health-after-rollback:done']);
    expect(applyEvent()).toMatchObject({ outcome: 'failed', rollback: { ok: true, healthy: true } });
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/rolled back to the previous CLI \(host runtime/);
  });

  it('a host runtime that was never started is retry later (no shim), nothing is taken', async () => {
    rmSync(w.shim);
    setRequests([request('cr_aaaaaaaa')]);
    const r = await runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/runtime not running: retry later/);
    expect(shimLog()).toBe('');
    expect(minionsLog()).not.toMatch(/upgrade/);
  });

  it('--dry-run prints the host plan: the shim, no docker tag', async () => {
    setRequests([request('cr_aaaaaaaa')]);
    const r = await runScript('--once', '--dry-run');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`${w.shim} settings requests mark cr_aaaaaaaa --status confirmed`);
    expect(r.out).toContain('host runtime: no image, so no previous-image tag');
    expect(r.out).not.toMatch(/docker tag/);
    expect(dockerLog()).toBe('');
  });
});

describe('self-update packaging', () => {
  it('the published package files leave scripts/ (and so scripts/dev/) and CLAUDE.md out', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files.length).toBeGreaterThan(0);
    expect(pkg.files.filter((f) => /^(\.\/)?scripts(\/|$)/.test(f) || f.includes('*'))).toEqual([]);
    expect(pkg.files).not.toContain('CLAUDE.md'); // the proactive trigger (phase 4) is the minions repo's own instruction
    expect(existsSync(SCRIPT)).toBe(true);
  });
});

describe('self-update trigger (phase 4)', () => {
  // The trigger is an instruction for this repository's coordinator, not shipped behaviour: CLAUDE.md asks for the
  // same request the script takes (upgrade --from-container on the base branch), and the shipped templates do not.
  const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');

  it('CLAUDE.md asks the coordinator for an upgrade --from-container request after meaningful merges only', () => {
    expect(claudeMd).toMatch(/minions upgrade --from-container --reason "[^"]+" --json/);
    expect(claudeMd).toMatch(/After an `integrated` notice/); // task-82.5: the trigger is the local integrator's landing
    expect(claudeMd).toMatch(/git diff --name-only <main before>\.\.main/); // task-82.5: the check for meaningful changes
    expect(claudeMd).toMatch(/without waiting to be asked/);
    for (const p of ['src/**', 'templates/**', 'docker/**', 'package.json']) expect(claudeMd).toContain(`\`${p}\``);
    expect(claudeMd).toMatch(/Not meaningful on its own: `docs\/\*\*`, `test\/\*\*`/);
    expect(claudeMd).toMatch(/`proposed` `upgrade`\s+already\s+covers these commits/);
    expect(claudeMd).toMatch(/draining/);
  });

  it('no shipped template carries the self-update trigger', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    const hits = walk(join(root, 'templates')).filter((f) => /self-update|scripts\/dev/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
