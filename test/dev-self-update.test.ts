// scripts/dev/self-update.mjs (docs/design/coordinator-self-update.md), end to end: the real script as a subprocess
// against a fake `minions`, `docker` and `npm` on PATH (shell scripts), a real Git checkout and a scratch MINIONS_HOME.
// Only the flows that need real processes stay here (task-137.2.1): the full docker apply (the real command runner and
// git, the gate worktree), a stop by SIGTERM during the gate (the signal reaches the running child, the lock is
// released), and a gate step ended by an outside SIGKILL (how the runner classifies an end without an exit code).
// Every other behaviour is covered in the unit tier, in-process, by test/dev-self-update-unit.test.ts. The fake
// docker keeps its images as files ($FAKE/img/<tag> holds the image ID) and the container's image in
// $FAKE/container-image; the fake host `minions --json status` is healthy unless a test says otherwise.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const SCRIPT = join(root, 'scripts', 'dev', 'self-update.mjs');
const PROJECT_ID = '0123abcd-0000-4000-8000-000000000001';

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
    // The stamp's milliseconds are a running count: BSD date (macOS) has no `%3N` (task-105).
    '    d="$MINIONS_HOME/manager/cli-backup"; mkdir -p "$d" && n=$(ls "$d" | wc -l | tr -d " ") && echo old-cli > "$d/minions-0.1.0-$(date -u +%Y%m%dT%H%M%S)$(printf %03d "$n")Z.tgz"',
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

const marks = () => dockerLog().split('\n').filter((l) => l.includes('requests mark cr_aaaaaaaa'));
const statuses = () => marks().map((l) => / --status (\w+)/.exec(l)?.[1]);
const gateWorktreesGone = () => {
  expect(gitIn(fx.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  const gate = join(stateDir(), 'gate');
  expect(existsSync(gate) ? readdirSync(gate) : []).toEqual([]);
};

describe('self-update end to end', () => {
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

  it('a gate step ended by an outside SIGKILL is transient: the SHA is not recorded as bad', () => {
    writeFileSync(join(fx.fake, 'gate-run'), 'kill -9 $$');
    setRequests([request('cr_aaaaaaaa')]);
    const r = runScript('--once');
    expect(r.code, r.err).toBe(0);
    expect(minionsLog()).not.toMatch(/--rebuild-cli/);
    expect(statuses()).toEqual(['confirmed', 'failed']);
    expect(marks()[1]).toMatch(/npm test did not finish \(ended by SIGKILL\)/);
    expect(marks()[1]).toMatch(/is not recorded as bad/);
    expect(readState()).toMatchObject({ current: null, badShas: [] });
  });
});
