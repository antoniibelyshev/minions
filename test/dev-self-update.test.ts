// scripts/dev/self-update.mjs (docs/design/coordinator-self-update.md). Phase 1: start refusals, the lock, polling and
// taking upgrade requests through the script's own docker exec, idle detection and --dry-run. Phase 2: the apply
// (sync, host gate in a throwaway worktree, previous-image tag, upgrade --rebuild-cli, outcome and notice). Phase 3:
// the health check and the rollback (CLI backup, image re-tag, down and start, manager bot notice). The script runs as
// a subprocess against a fake `minions`, `docker` and `npm` on PATH (shell scripts), a real Git checkout and a scratch
// MINIONS_HOME. The fake docker keeps its images as files ($FAKE/img/<tag> holds the image ID) and the container's
// image in $FAKE/container-image; the fake host `minions --json status` is healthy unless a test says otherwise.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const SCRIPT = join(root, 'scripts', 'dev', 'self-update.mjs');
const PROJECT_ID = '0123abcd-0000-4000-8000-000000000001';
const COMPOSE = 'minions-0123abcd';

interface Fx { base: string; repo: string; home: string; fake: string; bin: string }
let fx: Fx;

const sh = (p: string, body: string) => { writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
const json = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
const gitIn = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const request = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'upgrade', payload: { fromContainer: true }, reason: 'merged task-1', createdAt: '2026-10-29T10:00:00.000Z',
  status: 'proposed', updatedAt: '2026-10-29T10:00:00.000Z', detail: null, summary: 'upgrade', ...over,
});
const setRequests = (requests: unknown[]) => json(join(fx.fake, 'requests.json'), { ok: true, data: { projectId: PROJECT_ID, requests } });
const setStatus = (data: Record<string, unknown>) => json(join(fx.fake, 'status.json'), { ok: true, data: { activeLeases: [], draining: null, ...data } });
const setRunning = (on: boolean) => { const p = join(fx.fake, 'running'); if (on) writeFileSync(p, ''); else rmSync(p, { force: true }); };
const readLog = (name: string) => { try { return readFileSync(join(fx.fake, name), 'utf8'); } catch { return ''; } };
const dockerLog = () => readLog('docker.log');
const minionsLog = () => readLog('minions.log');
const npmLog = () => readLog('npm.log');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
/** What the fake `minions upgrade --sync-only` does in the checkout (a shell snippet; default: one new commit). */
const setSync = (body: string) => writeFileSync(join(fx.fake, 'sync-action'), body);
const readState = () => JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8')) as { current: unknown; badShas: string[]; lastApplied: string | null };
const events = () => readFileSync(join(stateDir(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown> & { event: string });
const stateDir = () => join(fx.home, 'dev-self-update');

function setup(): Fx {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'minions-self-update-')));
  const repo = join(base, 'repo'), home = join(base, 'home'), fake = join(base, 'fake'), bin = join(base, 'bin');
  for (const d of [repo, join(repo, 'src'), join(home, 'projects', PROJECT_ID), fake, bin, join(fake, 'global', 'minions', 'dist'), join(fake, 'img')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(fake, 'img', 'minions-runtime:0.1.0'), 'sha256:0ldimage\n');
  writeFileSync(join(fake, 'container-image'), 'sha256:0ldimage\n');
  gitIn(repo, 'init', '-q', '-b', 'main');
  json(join(repo, 'package.json'), { name: 'minions', version: '0.1.0' });
  writeFileSync(join(repo, 'src', 'cli.ts'), '');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  json(join(home, 'registry.json'), { version: 1, projects: { [PROJECT_ID]: { gitCommonDir: join(repo, '.git'), repoPath: repo, visibility: 'shared' } } });
  json(join(home, 'projects', PROJECT_ID, 'project.json'), { version: 1, projectId: PROJECT_ID, repoPath: repo, baseBranch: 'main', imageTag: 'minions-runtime:0.1.0' });
  json(join(fake, 'global', 'minions', 'package.json'), { name: 'minions', version: '0.1.0' });
  json(join(fake, 'global', 'minions', 'dist', 'build.json'), { kind: 'packed', source: 'abc' });
  json(join(fake, 'config.json'), { ok: true, data: { delivery: { mode: 'local' }, sensitivePaths: ['.github/workflows/**', 'CLAUDE.md'] } });
  // npm: `root -g`; the gate steps log their argv, cwd, commit and env, and fail when $FAKE/gate-fail names them.
  sh(join(bin, 'npm'), [
    '[ "$1 $2" = "root -g" ] && { echo "root -g" >> "$FAKE/npm.log"; echo "$FAKE/global"; exit 0; }',
    // The rollback's CLI reinstall; $FAKE/npm-install-fail makes it fail.
    '[ "$1 $2" = "install -g" ] && { echo "$* | cwd=$PWD" >> "$FAKE/npm.log"; [ -f "$FAKE/npm-install-fail" ] && { echo "npm ERR! EACCES" >&2; exit 1; }; exit 0; }',
    'echo "$* | cwd=$PWD | head=$(git rev-parse HEAD) | home=$MINIONS_HOME | workers=$MINIONS_TEST_MAX_WORKERS" >> "$FAKE/npm.log"',
    'case "$*" in ci|"run typecheck"|test) ;; *) exit 1 ;; esac',
    '[ -f "$FAKE/gate-fail" ] && [ "$(cat "$FAKE/gate-fail")" = "$*" ] && { echo "FAIL test/example.test.ts > it breaks"; exit 1; }',
    // $FAKE/gate-run: a shell snippet the `npm test` step runs in this process (e.g. a SIGKILL of itself).
    '[ -f "$FAKE/gate-run" ] && [ "$*" = test ] && . "$FAKE/gate-run"',
    'exit 0',
  ].join('\n'));
  sh(join(bin, 'minions'), [
    'echo "$*" >> "$FAKE/minions.log"',
    'case "$*" in',
    '  *"config show"*) cat "$FAKE/config.json" ;;',
    '  *"settings requests"*) cat "$FAKE/requests.json" ;;',
    '  *"upgrade --sync-only"*)',
    '    if [ -f "$FAKE/sync-refuse" ]; then echo \'{"ok":false,"error":{"code":"PRECONDITION","message":"main has diverged from minions/main; nothing is forced"}}\'; exit 1; fi',
    '    sh "$FAKE/sync-action" || exit 1',
    '    echo \'{"ok":true,"data":{"ok":true,"steps":[{"id":"sync","status":"done","detail":"fast-forward"}],"sync":{"action":"fast-forward"},"stopped":null}}\' ;;',
    '  *"upgrade --rebuild-cli"*)',
    // As applyCli: back up the installed CLI before replacing it; then the image ($FAKE/new-image) and the recreate.
    '    mkdir -p "$MINIONS_HOME/manager/cli-backup" && echo old-cli > "$MINIONS_HOME/manager/cli-backup/minions-0.1.0-$(date -u +%Y%m%dT%H%M%S%3NZ).tgz"',
    '    [ -f "$FAKE/new-image" ] && cp "$FAKE/new-image" "$FAKE/img/minions-runtime:0.1.0"',
    '    cp "$FAKE/img/minions-runtime:0.1.0" "$FAKE/container-image"',
    '    [ -f "$FAKE/upgrade-stops-runtime" ] && rm -f "$FAKE/running"',
    '    if [ -f "$FAKE/upgrade-fail" ]; then echo \'{"ok":true,"data":{"ok":false,"steps":[{"id":"image","status":"failed","detail":"docker build failed"}],"stopped":null}}\'; exit 1; fi',
    '    echo \'{"ok":true,"data":{"ok":true,"steps":[{"id":"cli","status":"done","detail":"reinstalled"}],"stopped":null}}\' ;;',
    '  "--version") echo 0.1.0 ;;',
    '  "--json status") sh "$FAKE/host-status.sh" ;;',
    // $FAKE/doctor-fail-image: on that image doctor reports telegram.plugin as fail.
    '  "--json doctor") echo doctor >> "$FAKE/doctor.log"; st=ok; [ -f "$FAKE/doctor-fail-image" ] && [ "$(cat "$FAKE/container-image")" = "$(cat "$FAKE/doctor-fail-image")" ] && st=fail',
    '    echo "{\\"ok\\":true,\\"data\\":{\\"healthy\\":false,\\"checks\\":[{\\"name\\":\\"telegram.plugin\\",\\"status\\":\\"$st\\",\\"detail\\":\\"plugin $st\\"}]}}" ;;',
    '  "--json down") rm -f "$FAKE/container-image" "$FAKE/running"; echo \'{"ok":true,"data":{}}\' ;;',
    '  "--json start --no-attach") cp "$FAKE/img/minions-runtime:0.1.0" "$FAKE/container-image"; touch "$FAKE/running"; echo \'{"ok":true,"data":{"running":true}}\' ;;',
    '  "--json manager notify") cat > "$FAKE/manager-notice.txt"; echo \'{"ok":true,"data":{"sent":true,"botId":"555"}}\' ;;',
    '  *) echo \'{"ok":false,"error":{"code":"INTERNAL","message":"unexpected fake call"}}\'; exit 1 ;;',
    'esac',
  ].join('\n'));
  // The host status the health check reads. $FAKE/broken-image: a container on that image has no coordinator.
  // $FAKE/flap-image: on that image the coordinator lock changes hands on every call (a restart loop).
  // $FAKE/telegram: the coordinator has Telegram, and the file holds the poller state.
  writeFileSync(join(fake, 'host-status.sh'), [
    'img=$(cat "$FAKE/container-image" 2>/dev/null)',
    'launch=current; [ -f "$FAKE/broken-image" ] && [ "$img" = "$(cat "$FAKE/broken-image")" ] && launch=not-running',
    'pid=100; if [ -f "$FAKE/flap-image" ] && [ "$img" = "$(cat "$FAKE/flap-image")" ]; then n=$(cat "$FAKE/flaps" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FAKE/flaps"; pid=$((200+n)); fi',
    'channel=terminal; poller=not-applicable; [ -f "$FAKE/telegram" ] && { channel=telegram; poller=$(cat "$FAKE/telegram"); }',
    'printf \'{"ok":true,"data":{"activeLeases":[],"draining":null,"restartRequired":{"state":"current","required":false,"reasons":[]},"coordinatorLaunch":{"state":"%s","reason":"x"},"coordinatorLock":{"pid":%s,"session":"coordinator","acquiredAt":"2026-10-29T10:00:00.000Z"},"channel":{"effective":"%s"},"telegramPoller":{"state":"%s"}}}\\n\' "$launch" "$pid" "$channel" "$poller"',
  ].join('\n'));
  sh(join(bin, 'docker'), [
    'echo "$*" >> "$FAKE/docker.log"',
    'case "$*" in',
    '  *" ps --status running -q app"*) [ -f "$FAKE/running" ] && echo c0ffee; exit 0 ;;',
    '  *" ps -q app") [ -f "$FAKE/container-image" ] && echo c0ffee; exit 0 ;;',
    '  "inspect --format {{.Image}} c0ffee") cat "$FAKE/container-image" ;;',
    '  *"exec -T app minions coordinator restart --recover --json") echo restart >> "$FAKE/coordinator.log"; echo \'{"ok":true,"data":{"action":"restarted"}}\' ;;',
    '  *"exec -T app minions status --json"*) cat "$FAKE/status.json" ;;',
    // $FAKE/mark-fail: the runtime refuses every mark except --status confirmed (an error that is not "not running").
    '  *"exec -T app minions settings requests mark"*" --status confirmed "*) echo \'{"ok":true,"data":{}}\' ;;',
    '  *"exec -T app minions settings requests mark"*) [ -f "$FAKE/mark-fail" ] && { echo \'{"ok":false,"error":{"code":"INTERNAL","message":"state store is locked"}}\'; exit 1; }; echo \'{"ok":true,"data":{}}\' ;;',
    '  *"exec -T app minions notify enqueue"*) cat > "$FAKE/notice.txt"; echo \'{"ok":true,"data":{"created":true}}\' ;;',
    '  "image inspect --format {{.Id}} "*) [ -f "$FAKE/img/$5" ] && cat "$FAKE/img/$5" || { echo "Error: No such image: $5" >&2; exit 1; } ;;',
    '  "tag "*) [ -f "$FAKE/img/$2" ] && cp "$FAKE/img/$2" "$FAKE/img/$3" || { echo "Error: No such image: $2" >&2; exit 1; } ;;',
    '  *) echo "unexpected fake docker call" >&2; exit 1 ;;',
    'esac',
  ].join('\n'));
  writeFileSync(join(fake, 'sync-action'), 'mkdir -p .github/workflows && echo x >> .github/workflows/ci.yml && git add -A && git commit -qm "change the CI workflow"');
  return { base, repo, home, fake, bin };
}

const env = () => ({ ...process.env, ...GIT_ENV, PATH: `${fx.bin}:${process.env.PATH ?? ''}`, MINIONS_HOME: fx.home, FAKE: fx.fake });
const runScript = (...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', fx.repo, '--health-window', '2', ...args], { encoding: 'utf8', env: env(), timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeEach(() => {
  fx = setup();
  setRequests([]);
  setStatus({});
  setRunning(true);
});
afterEach(() => { rmSync(fx.base, { recursive: true, force: true }); });

describe('self-update start refusals', () => {
  const cases: [string, () => void, RegExp][] = [
    ['the project repo is not a minions checkout', () => { json(join(fx.repo, 'package.json'), { name: 'other' }); gitIn(fx.repo, 'commit', '-qam', 'rename'); }, /is not a minions checkout/],
    ['the installed CLI is linked, not packed', () => {
      rmSync(join(fx.fake, 'global', 'minions'), { recursive: true });
      symlinkSync(fx.repo, join(fx.fake, 'global', 'minions'));
    }, /not a packed install \(link/],
    ['the installed CLI has no packed build stamp', () => { rmSync(join(fx.fake, 'global', 'minions', 'dist', 'build.json')); }, /not a packed install \(unknown/],
    ['delivery is not local', () => { json(join(fx.fake, 'config.json'), { ok: true, data: { delivery: { mode: 'pull-request' } } }); }, /delivery mode is "pull-request", not local/],
    ['the runtime is not Docker', () => {
      const p = join(fx.home, 'projects', PROJECT_ID, 'project.json');
      json(p, { ...JSON.parse(readFileSync(p, 'utf8')), runtime: 'host' });
    }, /runtime is "host", not docker/],
    ['the checkout is dirty', () => { writeFileSync(join(fx.repo, 'stray.txt'), 'x'); }, /uncommitted or untracked changes/],
    ['the checkout is not on the base branch', () => { gitIn(fx.repo, 'checkout', '-q', '-b', 'feature'); }, /on branch feature, not the base branch main/],
  ];
  it.each(cases)('refuses when %s', (_name, mutate, message) => {
    setRequests([request('cr_aaaaaaaa')]);
    mutate();
    const r = runScript('--once');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/refusing to start/);
    expect(r.err).toMatch(message);
    expect(dockerLog()).not.toMatch(/requests mark/);
    expect(existsSync(stateDir())).toBe(false);
  });
});

describe('self-update polling', () => {
  it('takes the oldest proposed upgrade --from-container request through its own docker exec', () => {
    setRequests([
      request('cr_cccccccc', { createdAt: '2026-10-29T12:00:00.000Z' }),
      request('cr_aaaaaaaa', { payload: { fromContainer: 'main' }, createdAt: '2026-10-29T11:00:00.000Z' }),
      request('cr_00000000', { payload: { fromContainer: null }, createdAt: '2026-10-29T09:00:00.000Z' }),
      request('cr_11111111', { kind: 'config-set', payload: { key: 'x' }, createdAt: '2026-10-29T09:00:00.000Z' }),
      request('cr_22222222', { payload: { fromContainer: 'other-branch' }, createdAt: '2026-10-29T09:00:00.000Z' }),
    ]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    const log = dockerLog();
    expect(log).toContain(`compose -p ${COMPOSE} -f ${join(fx.home, 'projects', PROJECT_ID, 'compose.yaml')} exec -T app minions settings requests mark cr_aaaaaaaa --status confirmed`);
    expect(log).not.toMatch(/apply is not built yet/);
    expect(log).not.toMatch(/mark cr_(cccccccc|00000000|11111111|22222222)/);
    expect(log.indexOf('minions status --json')).toBeLessThan(log.indexOf('--status confirmed'));
    expect(r.out).toContain('took request cr_aaaaaaaa');

    expect(readState().current).toBeNull();
    expect(events().map((e) => e.event)).toEqual(['started', 'taken', 'apply', 'marked', 'notice', 'stopped']);
    expect(statSync(join(stateDir(), 'log.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDir(), 'state.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(stateDir(), 'lock'))).toBe(false);
  });

  it('does not take a request while a worker lease is active or a drain runs', () => {
    setRequests([request('cr_aaaaaaaa')]);
    setStatus({ activeLeases: [{ id: 'lease-1' }] });
    let r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/waiting for idle: 1 active worker lease\(s\) \(lease-1\); not taken/);
    setStatus({ draining: { at: '2026-10-29T10:00:00.000Z' } });
    r = runScript('--once');
    expect(r.out).toMatch(/waiting for idle: a drain is in progress; not taken/);
    expect(dockerLog()).not.toMatch(/requests mark/);
  });

  it('treats a stopped runtime as retry later, not as a failure', () => {
    setRunning(false);
    json(join(fx.fake, 'requests.json'), { ok: false, error: { code: 'PRECONDITION', message: 'The runtime is not running, so change requests cannot be reached.' } });
    let r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/runtime not running: retry later/);
    // The listing still answers (e.g. the container stops between the two calls): nothing is marked either.
    setRequests([request('cr_aaaaaaaa')]);
    r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/cr_aaaaaaaa .*runtime not running: retry later/);
    expect(dockerLog()).not.toMatch(/exec/);
  });

  it('marks a request left confirmed by an interrupted run as failed, without running it again', () => {
    mkdirSync(stateDir(), { recursive: true });
    json(join(stateDir(), 'state.json'), { version: 1, lastApplied: null, badShas: [], current: { id: 'cr_bbbbbbbb', takenAt: '2026-10-29T09:00:00.000Z', runId: 'old' } });
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).toMatch(/requests mark cr_bbbbbbbb --status failed --detail self-update: the script stopped/);
    expect((JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8')) as { current: unknown }).current).toBeNull();
  });

  it('--dry-run prints the plan and marks, writes and logs nothing', () => {
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--dry-run');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('self-update plan (dry run');
    expect(r.out).toContain('installed CLI: packed');
    expect(r.out).toContain('delivery: local');
    expect(r.out).toContain('would take request cr_aaaaaaaa');
    expect(r.out).toContain(`docker compose -p ${COMPOSE}`);
    expect(r.out).toContain('minions --json upgrade --sync-only');
    expect(r.out).toContain('npm ci && npm run typecheck && npm test');
    expect(r.out).toContain('docker tag minions-runtime:0.1.0 minions-runtime:0.1.0-prev');
    expect(r.out).toContain('minions --json upgrade --rebuild-cli');
    expect(dockerLog()).not.toMatch(/requests mark|notify|tag /);
    expect(minionsLog()).not.toMatch(/upgrade/);
    expect(npmLog()).not.toMatch(/^(ci|test|run typecheck)/m);
    expect(gitIn(fx.repo, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(existsSync(stateDir())).toBe(false);
  });

  it('dry run of a refused start lists the refusals', () => {
    json(join(fx.fake, 'config.json'), { ok: true, data: { delivery: { mode: 'branch' } } });
    const r = runScript('--dry-run');
    expect(r.code).toBe(2);
    expect(r.out).toContain('self-update plan (dry run');
    expect(r.err).toMatch(/delivery mode is "branch"/);
  });
});

describe('self-update lock', () => {
  it('runs one instance at a time and releases the lock on SIGTERM', async () => {
    const first = spawn(process.execPath, [SCRIPT, '--repo', fx.repo, '--interval', '60'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((res, rej) => {
        let out = '';
        const t = setTimeout(() => rej(new Error(`no start: ${out}`)), 30_000);
        first.stdout.on('data', (b: Buffer) => { out += b.toString(); if (out.includes('started')) { clearTimeout(t); res(); } });
        first.on('exit', () => { clearTimeout(t); rej(new Error(`exited early: ${out}`)); });
      });
      const second = runScript('--once');
      expect(second.code).toBe(2);
      expect(second.err).toMatch(new RegExp(`another self-update script runs \\(pid ${first.pid}`));
    } finally {
      const exited = new Promise((res) => first.on('exit', res));
      first.kill('SIGTERM');
      await exited;
    }
    expect(existsSync(join(stateDir(), 'lock'))).toBe(false);
  });

  it('takes over a stale lock whose pid was reused by another process', () => {
    mkdirSync(stateDir(), { recursive: true });
    // process.pid is alive (this test runner) but its start time differs: a reused pid, not a holder.
    json(join(stateDir(), 'lock'), { pid: process.pid, start: 'not-the-start-time', at: '2026-10-01T00:00:00.000Z' });
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('started');
    expect(existsSync(join(stateDir(), 'lock'))).toBe(false);
  });
});

describe('self-update apply (phase 2)', () => {
  const marks = () => dockerLog().split('\n').filter((l) => l.includes('requests mark cr_aaaaaaaa'));
  const gateWorktreesGone = () => {
    expect(gitIn(fx.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    const gate = join(stateDir(), 'gate');
    expect(existsSync(gate) ? readdirSync(gate) : []).toEqual([]);
  };

  it('gate passes: syncs, gates the exact synced commit, keeps the previous image, upgrades, marks applied and notifies', () => {
    const from = gitIn(fx.repo, 'rev-parse', 'HEAD');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    const to = gitIn(fx.repo, 'rev-parse', 'HEAD');
    expect(to).not.toBe(from);

    // Order: sync, then the gate, then the image tag, then the rebuild.
    expect(minionsLog()).toMatch(/--json upgrade --sync-only\n(.|\n)*--json upgrade --rebuild-cli/);
    const gate = npmLog().split('\n').filter((l) => /^(ci|run typecheck|test) \|/.test(l));
    expect(gate.map((l) => l.split(' |')[0])).toEqual(['ci', 'run typecheck', 'test']);
    for (const l of gate) {
      expect(l).toContain(`head=${to}`);
      expect(l).toContain('workers=2');
      expect(l).toContain(`cwd=${join(stateDir(), 'gate')}/${to.slice(0, 12)}-`);
      expect(l).not.toContain(`home=${fx.home} `);
    }
    gateWorktreesGone();
    expect(dockerLog()).toContain('tag minions-runtime:0.1.0 minions-runtime:0.1.0-prev');

    expect(marks().map((l) => / --status (\w+)/.exec(l)?.[1])).toEqual(['confirmed', 'applied']);
    expect(marks()[1]).toContain(`--detail self-update ${from.slice(0, 12)}..${to.slice(0, 12)}`);
    expect(dockerLog()).toContain('exec -T app minions notify enqueue --key self-update:cr_aaaaaaaa --kind status --json');
    const notice = readFileSync(join(fx.fake, 'notice.txt'), 'utf8');
    expect(notice).toContain('Self-update applied');
    expect(notice).toContain('change the CI workflow');
    expect(notice).toContain('Sensitive paths touched: .github/workflows/ci.yml.');
    expect(notice).toContain(join(stateDir(), 'log.jsonl'));

    const st = readState();
    expect(st).toMatchObject({ current: null, lastApplied: to, badShas: [] });
    const apply = events().find((e) => e.event === 'apply')!;
    expect(apply).toMatchObject({ request: 'cr_aaaaaaaa', from, to, outcome: 'applied', sensitive: ['.github/workflows/ci.yml'], previousImage: { tag: 'minions-runtime:0.1.0-prev', id: 'sha256:0ldimage' } });
    expect((apply.steps as { id: string; status: string; ms: number }[]).map((s) => `${s.id}:${s.status}`))
      .toEqual(['sync:done', 'gate-worktree:done', 'gate-ci:done', 'gate-typecheck:done', 'gate-test:done', 'previous-image:done', 'upgrade:done', 'health:done']);
  });

  it('gate fails: builds nothing, marks the request failed with the reason and records the SHA as bad', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'gate-fail'), 'test');
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    const to = gitIn(fx.repo, 'rev-parse', 'HEAD');
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(dockerLog()).not.toMatch(/ tag |image inspect/);
    gateWorktreesGone();
    expect(marks().map((l) => / --status (\w+)/.exec(l)?.[1])).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(new RegExp(`the host gate failed at ${to.slice(0, 12)} \\(npm test failed \\(exit 1\\): FAIL test/example.test.ts`));
    expect(marks()[1]).toMatch(/nothing was built/);
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toMatch(/^Self-update failed \(request cr_aaaaaaaa\): .*host gate failed/);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [to] });
  });

  it('refused sync: builds and gates nothing and marks the request failed with the reason', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'sync-refuse'), '');
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(npmLog()).not.toMatch(/^(ci|test|run typecheck)/m);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(marks()[1]).toMatch(/--status failed --detail self-update: the sync was refused \(main has diverged from minions\/main; nothing is forced\); nothing was built/);
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toContain('the sync was refused');
    expect(readState()).toMatchObject({ current: null, badShas: [] });
  });

  it('skips a SHA recorded as bad: no gate, no build, the request is marked failed', () => {
    setSync('true'); // up to date: the target is the current HEAD
    const head = gitIn(fx.repo, 'rev-parse', 'HEAD');
    mkdirSync(stateDir(), { recursive: true });
    json(join(stateDir(), 'state.json'), { version: 1, lastApplied: null, badShas: [head], current: null });
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(npmLog()).not.toMatch(/^(ci|test|run typecheck)/m);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(marks()[1]).toMatch(new RegExp(`--status failed --detail self-update: ${head.slice(0, 12)} failed before and is recorded as bad; it is not tried again`));
    expect(readState().badShas).toEqual([head]);
  });

  it('a failed upgrade rolls back, is marked failed, and the SHA is not recorded as bad (it can be transient)', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'upgrade-fail'), '');
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).toContain('tag minions-runtime:0.1.0 minions-runtime:0.1.0-prev');
    expect(dockerLog()).toContain('tag minions-runtime:0.1.0-prev minions-runtime:0.1.0');
    expect(npmLog()).toMatch(/^install -g --no-audit --no-fund .*cli-backup\/minions-0\.1\.0-\d{8}T\d{9}Z\.tgz/m);
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach/);
    expect(marks()[1]).toMatch(/--status failed --detail self-update: minions upgrade --rebuild-cli failed \(failed: image \(docker build failed\)\); rolled back to the previous CLI and image/);
    expect(marks()[1]).toMatch(/is not recorded as bad \(the upgrade itself failed/);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [] });
  });

  it('a runtime that is down after the upgrade keeps the outcome pending and marks and notifies on a later poll', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'upgrade-stops-runtime'), '');
    let r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(marks().map((l) => / --status (\w+)/.exec(l)?.[1])).toEqual(['confirmed']);
    expect((readState().current as { outcome: { status: string } }).outcome.status).toBe('applied');
    setRunning(true);
    setRequests([]);
    r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(marks().map((l) => / --status (\w+)/.exec(l)?.[1])).toEqual(['confirmed', 'applied']);
    expect(dockerLog()).not.toMatch(/the script stopped/);
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toContain('Self-update applied');
    expect(readState().current).toBeNull();
    expect(minionsLog().match(/--rebuild-cli/g)).toHaveLength(1);
  });
});

describe('self-update apply: failure paths and isolation', () => {
  const marks = () => dockerLog().split('\n').filter((l) => l.includes('requests mark cr_aaaaaaaa'));
  const statuses = () => marks().map((l) => / --status (\w+)/.exec(l)?.[1]);
  const gateWorktreesGone = () => {
    expect(gitIn(fx.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    const gate = join(stateDir(), 'gate');
    expect(existsSync(gate) ? readdirSync(gate) : []).toEqual([]);
  };

  it('a missing previous image fails the request before anything is built, without recording the SHA as bad', () => {
    const p = join(fx.home, 'projects', PROJECT_ID, 'project.json');
    json(p, { ...JSON.parse(readFileSync(p, 'utf8')), imageTag: 'minions-runtime:gone' });
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).toContain('image inspect --format {{.Id}} minions-runtime:gone');
    expect(dockerLog()).not.toMatch(/^tag /m);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/the previous image could not be kept .*nothing was built/);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [] });
    gateWorktreesGone();
  });

  it('the gate runs with a scratch MINIONS_HOME (removed after) and without the runtime or handoff variables', () => {
    const registry = readFileSync(join(fx.home, 'registry.json'), 'utf8');
    sh(join(fx.bin, 'npm'), [
      '[ "$1 $2" = "root -g" ] && { echo "$FAKE/global"; exit 0; }',
      'echo "$* | home=$MINIONS_HOME | runtime=${MINIONS_RUNTIME-unset} | handoff=${MINIONS_UPGRADE_HANDOFF-unset}" >> "$FAKE/npm.log"',
      // What a careless test in the project would do: write into its MINIONS_HOME.
      'echo x > "$MINIONS_HOME/registry.json"',
      'exit 0',
    ].join('\n'));
    setRequests([request('cr_aaaaaaaa')]);
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', fx.repo, '--once'], { encoding: 'utf8', timeout: 60_000,
      env: { ...env(), MINIONS_RUNTIME: 'container', MINIONS_UPGRADE_HANDOFF: '1' } });
    expect(r.status, r.stderr).toBe(0);
    const to = gitIn(fx.repo, 'rev-parse', 'HEAD');
    const lines = npmLog().trim().split('\n');
    expect(lines.map((l) => l.split(' |')[0])).toEqual(['ci', 'run typecheck', 'test']);
    const homes = [...new Set(lines.map((l) => / home=(\S+)/.exec(l)?.[1]))];
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatch(new RegExp(`^${join(stateDir(), 'gate')}/${to.slice(0, 12)}-[0-9a-f]{8}\\.home$`));
    expect(existsSync(homes[0]!)).toBe(false);
    for (const l of lines) expect(l).toContain('runtime=unset | handoff=unset');
    expect(readFileSync(join(fx.home, 'registry.json'), 'utf8')).toBe(registry);
    gateWorktreesGone();
  });

  it('a stop during the gate builds nothing, keeps the request confirmed, cleans up, and the next start marks it interrupted', async () => {
    sh(join(fx.bin, 'npm'), [
      '[ "$1 $2" = "root -g" ] && { echo "$FAKE/global"; exit 0; }',
      'echo "$*" >> "$FAKE/npm.log"',
      '[ "$*" = test ] && { touch "$FAKE/gate-running"; exec sleep 30; }',
      'exit 0',
    ].join('\n'));
    setRequests([request('cr_aaaaaaaa')]);
    const child = spawn(process.execPath, [SCRIPT, '--repo', fx.repo, '--interval', '60'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    const t0 = Date.now();
    while (!existsSync(join(fx.fake, 'gate-running'))) {
      if (Date.now() - t0 > 30_000) { child.kill('SIGKILL'); throw new Error(`the gate did not start: ${out}`); }
      await new Promise((r) => setTimeout(r, 50));
    }
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(25_000);
    expect(out).toMatch(/stopped during gate-test/);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(dockerLog()).not.toMatch(/^tag |notify enqueue/m);
    expect(statuses()).toEqual(['confirmed']);
    const st = readState() as unknown as { current: { id: string; outcome?: unknown }; badShas: string[] };
    expect(st.current.id).toBe('cr_aaaaaaaa');
    expect(st.current.outcome).toBeUndefined();
    expect(st.badShas).toEqual([]);
    expect(events().map((e) => e.event)).toContain('apply-stopped');
    expect(existsSync(join(stateDir(), 'lock'))).toBe(false);
    gateWorktreesGone();

    setRequests([]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/the script stopped while handling this request/);
    expect(readState().current).toBeNull();
    expect(minionsLog().match(/upgrade --sync-only/g)).toHaveLength(1);
  });

  it('a long commit range keeps the owner notice under the outbox limit (4000) and points to the log', () => {
    // 60 commits with long subjects, each touching a sensitive path: uncapped, this is well over 4000 characters.
    setSync('i=0; while [ $i -lt 60 ]; do i=$((i+1)); mkdir -p .github/workflows; echo $i > .github/workflows/w$i-with-a-rather-long-workflow-file-name.yml; git add -A; git commit -qm "merge branch agent/task-$i-a-fairly-long-task-title-that-fills-the-subject-line"; done');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(statuses()).toEqual(['confirmed', 'applied']);
    const notice = readFileSync(join(fx.fake, 'notice.txt'), 'utf8');
    expect(notice.length).toBeLessThanOrEqual(4000);
    expect(notice).toMatch(/^Self-update applied/);
    expect(notice).toMatch(/Commits \(50\+\):/);
    expect(notice).toMatch(/\.\.\. \d+\+ more, see the log/);
    expect(notice).toMatch(/Sensitive paths touched: .* and \d+ more\./);
    expect(notice).toContain(`Log: ${join(stateDir(), 'log.jsonl')}`);
    expect(events().find((e) => e.event === 'notice')).toMatchObject({ ok: true });
  });

  it('an npm ci failure in the gate fails the request but does not record the SHA as bad', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'gate-fail'), 'ci');
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(npmLog()).not.toMatch(/^(run typecheck|test) \|/m);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/npm ci failed .*is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
    gateWorktreesGone();
  });

  it('a typecheck failure in the gate records the SHA as bad and skips the tests', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'gate-fail'), 'run typecheck');
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    const to = gitIn(fx.repo, 'rev-parse', 'HEAD');
    expect(npmLog()).not.toMatch(/^test \|/m);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(new RegExp(`npm run typecheck failed \\(exit 1\\).*${to.slice(0, 12)} is recorded as bad`));
    expect(readState()).toMatchObject({ current: null, badShas: [to] });
    gateWorktreesGone();
  });

  it('a failed `git worktree add` fails the request, runs no npm step and does not record the SHA as bad', () => {
    // A failing post-checkout hook makes `git worktree add` exit non-zero (after it created the worktree).
    setSync('git commit -q --allow-empty -m next && printf "#!/bin/sh\\nexit 1\\n" > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(npmLog()).not.toMatch(/^(ci|run typecheck|test) \|/m);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/git worktree add failed.*is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
    gateWorktreesGone();
  });

  it('a mark the runtime refuses stays pending and is retried on later polls, taking no new request meanwhile', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'mark-fail'), '');
    let r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    type Pending = { id: string; outcome: { status: string; marked: boolean; markAttempts: number } };
    expect((readState().current as Pending).outcome).toMatchObject({ status: 'applied', marked: false, markAttempts: 1 });
    expect(dockerLog()).not.toMatch(/notify enqueue/);

    setRequests([request('cr_bbbbbbbb', { createdAt: '2026-10-29T11:00:00.000Z' })]);
    r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect((readState().current as Pending).outcome.markAttempts).toBe(2);
    expect(dockerLog()).not.toMatch(/requests mark cr_bbbbbbbb/);
    expect(minionsLog().match(/upgrade --sync-only/g)).toHaveLength(1);

    // The runtime recovers: the next poll marks it and sends the notice.
    rmSync(join(fx.fake, 'mark-fail'));
    setRequests([]);
    r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(statuses()).toEqual(['confirmed', 'applied', 'applied', 'applied']);
    expect(events().find((e) => e.event === 'marked')).toMatchObject({ ok: true });
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toContain('Self-update applied');
    expect(readState().current).toBeNull();
  });

  it('a mark refused 3 times is given up with a clear log line, and the notice still goes out', () => {
    setRequests([request('cr_aaaaaaaa')]);
    writeFileSync(join(fx.fake, 'mark-fail'), '');
    runScript('--once');
    setRequests([]);
    runScript('--once');
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/NOT marked applied after 3 attempts .*mark it by hand/);
    expect(statuses()).toEqual(['confirmed', 'applied', 'applied', 'applied']);
    expect(events().filter((e) => e.event === 'mark-failed')).toHaveLength(2);
    expect(events().find((e) => e.event === 'marked')).toMatchObject({ ok: false, gaveUp: true, message: 'state store is locked' });
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toContain('Self-update applied');
    expect(readState().current).toBeNull();
  });

  it('--dry-run leaves a pending outcome untouched (nothing is marked or notified)', () => {
    mkdirSync(stateDir(), { recursive: true });
    const pending = { version: 1, lastApplied: null, badShas: [], current: { id: 'cr_bbbbbbbb', takenAt: '2026-10-29T09:00:00.000Z', runId: 'old',
      outcome: { status: 'applied', detail: 'self-update a..b', marked: false, notice: { key: 'self-update:cr_bbbbbbbb', text: 'x\n' } } } };
    json(join(stateDir(), 'state.json'), pending);
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--dry-run');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).not.toMatch(/requests mark|notify enqueue|^tag /m);
    expect(minionsLog()).not.toMatch(/upgrade/);
    expect(JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8'))).toEqual(pending);
    expect(existsSync(join(stateDir(), 'log.jsonl'))).toBe(false);
  });
});

describe('self-update health check and rollback (phase 3)', () => {
  const marks = () => dockerLog().split('\n').filter((l) => l.includes('requests mark cr_'));
  const statuses = () => marks().map((l) => / --status (\w+)/.exec(l)?.[1]);
  const img = (tag: string) => readFileSync(join(fx.fake, 'img', tag), 'utf8').trim();
  const containerImg = () => readFileSync(join(fx.fake, 'container-image'), 'utf8').trim();
  const steps = (e: Record<string, unknown> | undefined) => (e?.steps as { id: string; status: string }[]).map((s) => `${s.id}:${s.status}`);
  const newImage = (id: string) => writeFileSync(join(fx.fake, 'new-image'), `${id}\n`);

  it('a healthy update keeps the new image and CLI: no rollback, marked applied', () => {
    newImage('sha256:newimage');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(containerImg()).toBe('sha256:newimage');
    expect(img('minions-runtime:0.1.0')).toBe('sha256:newimage');
    expect(img('minions-runtime:0.1.0-prev')).toBe('sha256:0ldimage');
    expect(npmLog()).not.toMatch(/^install -g/m);
    expect(minionsLog()).not.toMatch(/--json (down|start)/);
    expect(statuses()).toEqual(['confirmed', 'applied']);
    // The health probes: fresh `--version` and `--json status`, and the container's image.
    expect(minionsLog()).toMatch(/--rebuild-cli\n(.|\n)*--version\n--json status/);
    expect(dockerLog()).toContain('inspect --format {{.Image}} c0ffee');
    const apply = events().find((e) => e.event === 'apply');
    expect(apply).toMatchObject({ outcome: 'applied', health: { healthy: true } });
    expect(steps(apply).slice(-2)).toEqual(['upgrade:done', 'health:done']);
    expect((readState() as unknown as { prevPin: unknown }).prevPin).toBeNull();
  });

  it('not healthy after the upgrade: reinstalls the CLI backup, tags -prev back, down and start on the old CLI, records the SHA as bad', () => {
    newImage('sha256:newimage');
    writeFileSync(join(fx.fake, 'broken-image'), 'sha256:newimage\n');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    const to = gitIn(fx.repo, 'rev-parse', 'HEAD');

    // The old build runs again: -prev is the image tag again and the container was recreated from it.
    expect(img('minions-runtime:0.1.0')).toBe('sha256:0ldimage');
    expect(containerImg()).toBe('sha256:0ldimage');
    const backups = readdirSync(join(fx.home, 'manager', 'cli-backup'));
    expect(backups).toHaveLength(1);
    expect(npmLog()).toContain(`install -g --no-audit --no-fund ${join(fx.home, 'manager', 'cli-backup', backups[0]!)} | cwd=${join(fx.home, 'manager', 'cli-backup')}`);
    expect(minionsLog()).toMatch(/--rebuild-cli\n(.|\n)*--json down\n--json start --no-attach\n/);
    expect(readLog('coordinator.log')).toBe('restart\n');
    const apply = events().find((e) => e.event === 'apply');
    expect(steps(apply).slice(6)).toEqual(['upgrade:done', 'health:failed', 'rollback-cli:done', 'rollback-image:done', 'rollback-down:done',
      'rollback-start:done', 'rollback-coordinator:done', 'health-after-rollback:done']);
    expect(apply).toMatchObject({ outcome: 'failed', health: { healthy: false }, rollback: { ok: true, healthy: true } });

    // Reported: marked failed with the reason, the SHA is bad, the owner notice says so; no manager bot needed.
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(new RegExp(`not healthy after the upgrade to ${to.slice(0, 12)} \\(not healthy within 2 s: the coordinator is not running\\); rolled back to the previous CLI and image \\(minions-runtime:0.1.0-prev\\); the coordinator is healthy again on the previous build; ${to.slice(0, 12)} is recorded as bad`));
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toMatch(/^Self-update failed .*rolled back to the previous CLI and image/);
    expect(existsSync(join(fx.fake, 'manager-notice.txt'))).toBe(false);
    expect(readState()).toMatchObject({ current: null, lastApplied: null, badShas: [to] });
  });

  it('more than one coordinator restart in the window is not healthy', () => {
    newImage('sha256:newimage');
    writeFileSync(join(fx.fake, 'flap-image'), 'sha256:newimage\n');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(marks()[1]).toMatch(/not healthy after the upgrade .*\(the coordinator restarted 2 times within the health window\); rolled back/);
    expect(containerImg()).toBe('sha256:0ldimage');
  });

  it('a Telegram coordinator without a live poller is not healthy', () => {
    newImage('sha256:newimage');
    writeFileSync(join(fx.fake, 'telegram'), 'dead');
    setRequests([request('cr_aaaaaaaa')]);
    runScript('--once');
    expect(marks()[1]).toMatch(/not healthy after the upgrade .*the Telegram poller is dead/);
    // Never healthy here, also after the rollback, so `doctor` (it runs only when the rest passes) never ran.
    expect(minionsLog()).not.toMatch(/--json doctor/);
    rmSync(join(fx.fake, 'telegram'));
  });

  it('a Telegram coordinator is not healthy when doctor reports telegram.plugin as fail', () => {
    newImage('sha256:newimage');
    writeFileSync(join(fx.fake, 'telegram'), 'ok');
    writeFileSync(join(fx.fake, 'doctor-fail-image'), 'sha256:newimage\n');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(marks()[1]).toMatch(/not healthy after the upgrade .*telegram\.plugin: plugin fail\); rolled back.*healthy again on the previous build/);
    expect(readLog('doctor.log').length).toBeGreaterThan(0);
    expect(containerImg()).toBe('sha256:0ldimage');
  });

  it('no healthy coordinator even after the rollback: the owner is told through the manager bot too', () => {
    newImage('sha256:newimage');
    writeFileSync(join(fx.fake, 'broken-image'), 'sha256:newimage\n');
    writeFileSync(join(fx.fake, 'npm-install-fail'), ''); // the CLI cannot be reinstalled: the rollback stops there
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(minionsLog()).not.toMatch(/--json (down|start)/); // never `start` on the new CLI (it would rebuild the image)
    const bot = readFileSync(join(fx.fake, 'manager-notice.txt'), 'utf8');
    expect(bot).toMatch(/^Self-update failed \(request cr_aaaaaaaa\): NO HEALTHY COORDINATOR even after the rollback/);
    expect(bot).toContain('the CLI backup could not be reinstalled');
    expect(bot).toContain(`Log: ${join(stateDir(), 'log.jsonl')}`);
    expect(events().find((e) => e.event === 'manager-notice')).toMatchObject({ request: 'cr_aaaaaaaa', ok: true });
    // The rollback restarted nothing, so the check after it does not wait out the window: 2 probes, then the notice.
    expect(events().find((e) => e.event === 'apply')).toMatchObject({ rollback: { healthy: false, health: expect.stringMatching(/^not healthy in 2 probe\(s\): the coordinator is not running/) } });
    expect(marks()[1]).toMatch(/no healthy coordinator even after the rollback .*; the owner was told through the manager bot; .* is recorded as bad/);
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toMatch(/NO HEALTHY COORDINATOR|no healthy coordinator/);
  });

  it('a retry never replaces a known-good -prev with the image of an update that was not confirmed healthy', () => {
    // 1st request: the update is broken and the rollback fails, so the broken image stays on the tag.
    newImage('sha256:badimage');
    writeFileSync(join(fx.fake, 'broken-image'), 'sha256:badimage\n');
    writeFileSync(join(fx.fake, 'npm-install-fail'), '');
    setRequests([request('cr_aaaaaaaa')]);
    expect(runScript('--once').code).toBe(0);
    expect(img('minions-runtime:0.1.0')).toBe('sha256:badimage');
    expect(img('minions-runtime:0.1.0-prev')).toBe('sha256:0ldimage');
    expect((readState() as unknown as { prevPin: string }).prevPin).toBe('sha256:0ldimage');

    // 2nd request (a fix on main): -prev keeps the known-good image instead of taking the broken one.
    rmSync(join(fx.fake, 'npm-install-fail'));
    newImage('sha256:fixedimage');
    rmSync(join(fx.fake, 'docker.log'));
    setRequests([request('cr_bbbbbbbb', { createdAt: '2026-10-29T11:00:00.000Z' })]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).not.toContain('tag minions-runtime:0.1.0 minions-runtime:0.1.0-prev');
    expect(img('minions-runtime:0.1.0-prev')).toBe('sha256:0ldimage');
    const apply = events().filter((e) => e.event === 'apply').at(-1)!;
    expect(apply).toMatchObject({ request: 'cr_bbbbbbbb', outcome: 'applied', previousImage: { tag: 'minions-runtime:0.1.0-prev', id: 'sha256:0ldimage', kept: true } });
    expect((apply.steps as { id: string; detail: string }[]).find((s) => s.id === 'previous-image')!.detail).toMatch(/kept: the last update was not confirmed healthy/);
    // Confirmed healthy now: the pin is cleared, so the next update keeps this image as -prev.
    expect(containerImg()).toBe('sha256:fixedimage');
    expect((readState() as unknown as { prevPin: unknown }).prevPin).toBeNull();
  });

  it.each([
    ['an outside SIGKILL', 'kill -9 $$', /npm test did not finish \(ended by SIGKILL\)/],
    ['output over the 64 MB maxBuffer', 'head -c 70000000 /dev/zero', /npm test did not finish \(ERR_CHILD_PROCESS_STDIO_MAXBUFFER\)/],
  ])('a gate step ended by %s is transient: the SHA is not recorded as bad', (_name, snippet, detail) => {
    writeFileSync(join(fx.fake, 'gate-run'), snippet);
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(detail);
    expect(marks()[1]).toMatch(/is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
  });

  /** Wraps the fake `minions`: `pre` is a shell snippet run first (it may exit), then the fake runs as before. */
  const wrapMinions = (pre: string) => {
    renameSync(join(fx.bin, 'minions'), join(fx.bin, 'minions-fake'));
    sh(join(fx.bin, 'minions'), `${pre}\nexec "${join(fx.bin, 'minions-fake')}" "$@"`);
  };

  it('an old CLI without `manager notify`: the failure is logged and printed, the request is still marked failed', () => {
    newImage('sha256:newimage');
    writeFileSync(join(fx.fake, 'broken-image'), 'sha256:newimage\n');
    writeFileSync(join(fx.fake, 'npm-install-fail'), '');
    wrapMinions(`[ "$*" = "--json manager notify" ] && { echo "$*" >> "$FAKE/minions.log"; echo "error: unknown command 'notify'" >&2; exit 1; }`);
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(fx.fake, 'manager-notice.txt'))).toBe(false);
    expect(events().find((e) => e.event === 'manager-notice')).toMatchObject({ request: 'cr_aaaaaaaa', ok: false, message: expect.stringMatching(/unknown command 'notify'/) });
    expect(r.out).toMatch(/could not tell the owner through the manager bot: .*unknown command 'notify'/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/no healthy coordinator even after the rollback .*; the manager bot could not tell the owner \(.*unknown command 'notify'.*\); .* is recorded as bad/);
    // The coordinator outbox notice is still enqueued (it goes out if the coordinator comes back).
    expect(readFileSync(join(fx.fake, 'notice.txt'), 'utf8')).toMatch(/no healthy coordinator even after the rollback/);
  });

  it('a failed upgrade that replaced neither the CLI nor the image: no rollback, no down and start, marked failed', () => {
    // The upgrade fails before its CLI step (no backup) and before any image build.
    wrapMinions(`case "$*" in *"upgrade --rebuild-cli"*) echo "$*" >> "$FAKE/minions.log"; echo '{"ok":true,"data":{"ok":false,"steps":[{"id":"preflight","status":"failed","detail":"disk full"}],"stopped":null}}'; exit 1 ;; esac`);
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(npmLog()).not.toMatch(/^install -g/m);
    expect(minionsLog()).not.toMatch(/--json (down|start)/);
    expect(dockerLog()).not.toContain('tag minions-runtime:0.1.0-prev minions-runtime:0.1.0');
    expect(readLog('coordinator.log')).toBe('');
    const apply = events().find((e) => e.event === 'apply');
    expect(steps(apply).slice(-2)).toEqual(['upgrade:failed', 'health-unchanged:done']);
    expect(apply).toMatchObject({ outcome: 'failed', rollback: { skipped: true, healthy: true } });
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/minions upgrade --rebuild-cli failed \(.*disk full.*\); it replaced neither the CLI nor the image and the coordinator is healthy on the current build, so nothing was rolled back or restarted; .* is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
  });

  it('a failed upgrade that rebuilt the image without a CLI backup still rolls back, even with a healthy coordinator', () => {
    // No CLI backup (the CLI step did not reinstall), but the image tag moved and the container runs the new image,
    // with a healthy coordinator: the health-unchanged shortcut must not apply, the old image comes back.
    wrapMinions(`case "$*" in *"upgrade --rebuild-cli"*) echo "$*" >> "$FAKE/minions.log"; echo sha256:newimage > "$FAKE/img/minions-runtime:0.1.0"; cp "$FAKE/img/minions-runtime:0.1.0" "$FAKE/container-image"; echo '{"ok":true,"data":{"ok":false,"steps":[{"id":"origin","status":"failed","detail":"no network"}],"stopped":null}}'; exit 1 ;; esac`);
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    const apply = events().find((e) => e.event === 'apply');
    expect(steps(apply)).not.toContain('health-unchanged:done');
    expect(steps(apply)).not.toContain('health-unchanged:failed');
    expect(steps(apply)).toEqual(expect.arrayContaining(['upgrade:failed', 'rollback-cli:done', 'rollback-image:done', 'rollback-start:done', 'health-after-rollback:done']));
    expect(npmLog()).not.toMatch(/^install -g/m);
    expect(dockerLog()).toContain('tag minions-runtime:0.1.0-prev minions-runtime:0.1.0');
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach\n/);
    expect(containerImg()).toBe('sha256:0ldimage');
    expect(apply).toMatchObject({ outcome: 'failed', rollback: { healthy: true } });
    expect(apply?.rollback).not.toHaveProperty('skipped');
    expect(marks()[1]).toMatch(/the coordinator is healthy again on the previous build; .* is not recorded as bad/);
  });

  it('a failed upgrade that replaced nothing but left no healthy coordinator still rolls back', () => {
    wrapMinions(`case "$*" in *"upgrade --rebuild-cli"*) echo "$*" >> "$FAKE/minions.log"; rm -f "$FAKE/running"; cat "$FAKE/container-image" > "$FAKE/broken-image"; echo '{"ok":true,"data":{"ok":false,"steps":[{"id":"drain","status":"failed","detail":"timeout"}],"stopped":null}}'; exit 1 ;; "--json start --no-attach") rm -f "$FAKE/broken-image" ;; esac`);
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach\n/);
    const apply = events().find((e) => e.event === 'apply');
    expect(steps(apply)).toEqual(expect.arrayContaining(['upgrade:failed', 'health-unchanged:failed', 'rollback-cli:done', 'rollback-start:done', 'health-after-rollback:done']));
    expect(marks()[1]).toMatch(/the coordinator is healthy again on the previous build; .* is not recorded as bad/);
  });

  it('-prev is gone at rollback time: no re-tag, but down and start still run on the old CLI and any rebuilt image is accepted', () => {
    newImage('sha256:newimage');
    writeFileSync(join(fx.fake, 'broken-image'), 'sha256:newimage\n');
    // The upgrade loses -prev (pruned by hand); the old CLI's `start` then rebuilds the image from the old code.
    wrapMinions([
      `case "$*" in *"upgrade --rebuild-cli"*) rm -f "$FAKE/img/minions-runtime:0.1.0-prev" ;; esac`,
      `[ "$*" = "--json start --no-attach" ] && echo sha256:rebuiltold > "$FAKE/img/minions-runtime:0.1.0"`,
    ].join('\n'));
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(dockerLog()).not.toContain('tag minions-runtime:0.1.0-prev minions-runtime:0.1.0');
    expect(npmLog()).toMatch(/^install -g --no-audit --no-fund .*cli-backup\/minions-0\.1\.0-/m);
    expect(minionsLog()).toMatch(/--json down\n--json start --no-attach\n/);
    expect(containerImg()).toBe('sha256:rebuiltold');
    const apply = events().find((e) => e.event === 'apply');
    expect(steps(apply)).toEqual(expect.arrayContaining(['rollback-cli:done', 'rollback-image:failed', 'rollback-down:done', 'rollback-start:done', 'rollback-coordinator:done', 'health-after-rollback:done']));
    expect(apply).toMatchObject({ outcome: 'failed', rollback: { ok: false, healthy: true } });
    expect(marks()[1]).toMatch(/rolled back with failures \(image re-tag; see the log\); the coordinator is healthy again on the previous build; .* is recorded as bad/);
    expect(existsSync(join(fx.fake, 'manager-notice.txt'))).toBe(false);
    expect((readState() as unknown as { prevPin: unknown }).prevPin).toBeNull();
  });
});

describe('self-update packaging', () => {
  it('npm pack --dry-run lists nothing under scripts/dev/', () => {
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
    const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', env: cleanEnv });
    expect(r.status, r.stderr).toBe(0);
    const files = (JSON.parse(r.stdout) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => f.startsWith('scripts/dev/'))).toEqual([]);
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
