// scripts/dev/self-update.mjs, phase 1 (docs/design/coordinator-self-update.md): start refusals, the lock, polling and
// taking upgrade requests through the script's own docker exec, idle detection and --dry-run. The script runs as a
// subprocess against a fake `minions`, `docker` and `npm` on PATH (shell scripts) and a scratch MINIONS_HOME.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
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
const dockerLog = () => { try { return readFileSync(join(fx.fake, 'docker.log'), 'utf8'); } catch { return ''; } };
const stateDir = () => join(fx.home, 'dev-self-update');

function setup(): Fx {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'minions-self-update-')));
  const repo = join(base, 'repo'), home = join(base, 'home'), fake = join(base, 'fake'), bin = join(base, 'bin');
  for (const d of [repo, join(repo, 'src'), join(home, 'projects', PROJECT_ID), fake, bin, join(fake, 'global', 'minions', 'dist')]) mkdirSync(d, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'main');
  json(join(repo, 'package.json'), { name: 'minions', version: '0.1.0' });
  writeFileSync(join(repo, 'src', 'cli.ts'), '');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  json(join(home, 'registry.json'), { version: 1, projects: { [PROJECT_ID]: { gitCommonDir: join(repo, '.git'), repoPath: repo, visibility: 'shared' } } });
  json(join(home, 'projects', PROJECT_ID, 'project.json'), { version: 1, projectId: PROJECT_ID, repoPath: repo, baseBranch: 'main', imageTag: 'minions-runtime:0.1.0' });
  json(join(fake, 'global', 'minions', 'package.json'), { name: 'minions', version: '0.1.0' });
  json(join(fake, 'global', 'minions', 'dist', 'build.json'), { kind: 'packed', source: 'abc' });
  json(join(fake, 'config.json'), { ok: true, data: { delivery: { mode: 'local' } } });
  sh(join(bin, 'npm'), 'echo "$*" >> "$FAKE/npm.log"\n[ "$1 $2" = "root -g" ] && { echo "$FAKE/global"; exit 0; }\nexit 1');
  sh(join(bin, 'minions'), [
    'echo "$*" >> "$FAKE/minions.log"',
    'case "$*" in',
    '  *"config show"*) cat "$FAKE/config.json" ;;',
    '  *"settings requests"*) cat "$FAKE/requests.json" ;;',
    '  *) echo \'{"ok":false,"error":{"code":"INTERNAL","message":"unexpected fake call"}}\'; exit 1 ;;',
    'esac',
  ].join('\n'));
  sh(join(bin, 'docker'), [
    'echo "$*" >> "$FAKE/docker.log"',
    'case "$*" in',
    '  *" ps --status running -q app"*) [ -f "$FAKE/running" ] && echo c0ffee; exit 0 ;;',
    '  *"exec -T app minions status --json"*) cat "$FAKE/status.json" ;;',
    '  *"exec -T app minions settings requests mark"*) echo \'{"ok":true,"data":{}}\' ;;',
    '  *) echo "unexpected fake docker call" >&2; exit 1 ;;',
    'esac',
  ].join('\n'));
  return { base, repo, home, fake, bin };
}

const env = () => ({ ...process.env, PATH: `${fx.bin}:${process.env.PATH ?? ''}`, MINIONS_HOME: fx.home, FAKE: fx.fake });
const runScript = (...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--repo', fx.repo, ...args], { encoding: 'utf8', env: env(), timeout: 60_000 });
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
    // Phase 1 applies nothing: the taken request is then released as failed with that reason.
    expect(log).toMatch(/requests mark cr_aaaaaaaa --status failed --detail self-update: apply is not built yet/);
    expect(log).not.toMatch(/mark cr_(cccccccc|00000000|11111111|22222222)/);
    expect(log.indexOf('minions status --json')).toBeLessThan(log.indexOf('--status confirmed'));
    expect(r.out).toContain('took request cr_aaaaaaaa');

    const state = JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8')) as { current: unknown; badShas: unknown[] };
    expect(state.current).toBeNull();
    const events = readFileSync(join(stateDir(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toEqual(['started', 'taken', 'not-applied', 'stopped']);
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
    expect(dockerLog()).not.toMatch(/requests mark/);
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
