// Tester additions (task-19, attempt 2): the startup intake budget against a real, hung `gh` process
// (a fake gh script on PATH, run through ghWithTimeout like coordinator startup does). Temp dirs only.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { intakeOnStart } from '../../src/runtime/commands.js';
import { syncIntake, type GithubIntakeConfig } from '../../src/runtime/intake-sync.js';
import { makeDefaultEnv } from './fixtures.js';

const REPO = 'acme/demo';
const FILTER: GithubIntakeConfig = { enabled: true, repository: REPO, labels: [], assignee: null, milestone: null, state: 'open' };
const BUDGET = 1_000;
const GRACE = 2_000; // STARTUP_INTAKE_GRACE_MS
const issue = (n: number) => ({ number: n, title: `Issue ${n}`, body: '', state: 'open', html_url: `https://github.com/${REPO}/issues/${n}`, assignees: [], labels: [], milestone: null });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
const oldPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = oldPath;
  for (const d of dirs.splice(0)) {
    const pidFile = join(d, 'hung.pid');
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Fake gh on PATH: the filtered list answers from list.json after `listDelay` s; any single-issue read
 * records its pid and hangs (`exec sleep`, so the pid is the hung process itself).
 */
function fakeGh(list: unknown[], listDelay = 0): string {
  const d = mkdtempSync(join(tmpdir(), 'minions-gh-hung-'));
  dirs.push(d);
  writeFileSync(join(d, 'list.json'), JSON.stringify(list));
  writeFileSync(join(d, 'gh'), [
    '#!/bin/sh',
    'for a in "$@"; do last="$a"; done',
    `case "$last" in *'/issues?'*) sleep ${listDelay}; cat '${d}/list.json'; exit 0;; esac`,
    `echo $$ > '${d}/hung.pid'`,
    'exec sleep 120',
  ].join('\n'));
  chmodSync(join(d, 'gh'), 0o755);
  process.env.PATH = `${d}:${oldPath}`;
  return d;
}

describe('startup intake budget with a real hung gh process', () => {
  it('starts the coordinator within budget + grace, pauses nothing, and the hung gh is killed (no survivor)', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    // First an unbounded pass imports issues 1 and 2 (gh list answers immediately).
    fakeGh([issue(1), issue(2)]);
    const first = await syncIntake({ db: e.db, backlog: e.backlog, config: e.config });
    expect(first.created).toEqual(['task-1', 'task-2']);

    // Startup: issue 2 left the filter; its single-issue read hangs in a real gh process.
    const d = fakeGh([issue(1)]);
    const logs: string[] = [];
    const t0 = Date.now();
    await intakeOnStart(e.config, (l) => logs.push(l), (o) => syncIntake({ db: e.db, backlog: e.backlog, config: e.config, ...o }), BUDGET);
    const startedAfter = Date.now() - t0;
    expect(startedAfter).toBeGreaterThanOrEqual(BUDGET - 50);
    expect(startedAfter).toBeLessThan(BUDGET + GRACE + 500);
    expect(logs.join('\n')).toContain('time budget exhausted');

    // An aborted pass never pauses: the departed task keeps its status and no reconcile event exists.
    expect(e.backlog.status('task-2')).not.toBe('blocked');
    expect(e.db.all('SELECT id FROM events WHERE kind = ?', 'intake-reconcile')).toEqual([]);

    // The hung gh is killed by its own budget timeout (SIGTERM, SIGKILL 2 s later) and does not survive.
    const pid = Number(readFileSync(join(d, 'hung.pid'), 'utf8'));
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = !alive(pid); if (!gone) await sleep(100); }
    expect(gone).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2 * BUDGET + GRACE + 1_000);

    // The next unbounded `minions sync` completes the reconciliation (single read now answers 404).
    fakeGh([issue(1)]);
    writeFileSync(join(dirs.at(-1)!, 'gh'), ['#!/bin/sh', 'for a in "$@"; do last="$a"; done',
      `case "$last" in *'/issues?'*) cat '${dirs.at(-1)!}/list.json'; exit 0;; esac`, 'echo "HTTP 404" >&2; exit 1'].join('\n'));
    const later = await syncIntake({ db: e.db, backlog: e.backlog, config: e.config });
    expect(later.reconciliations).toMatchObject([{ taskId: 'task-2', reason: 'not-visible', action: 'paused' }]);
  }, 20_000);

  it('a gh list call that hangs past the budget makes startup give up on time and imports nothing', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const d = mkdtempSync(join(tmpdir(), 'minions-gh-hung-'));
    dirs.push(d);
    writeFileSync(join(d, 'gh'), ['#!/bin/sh', `echo $$ > '${d}/hung.pid'`, 'exec sleep 120'].join('\n'));
    chmodSync(join(d, 'gh'), 0o755);
    process.env.PATH = `${d}:${oldPath}`;
    const logs: string[] = [];
    const t0 = Date.now();
    await intakeOnStart(e.config, (l) => logs.push(l), (o) => syncIntake({ db: e.db, backlog: e.backlog, config: e.config, ...o }), BUDGET);
    expect(Date.now() - t0).toBeLessThan(BUDGET + GRACE + 500);
    expect(await e.backlog.listTasks()).toEqual([]);
    const pid = Number(readFileSync(join(d, 'hung.pid'), 'utf8'));
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = !alive(pid); if (!gone) await sleep(100); }
    expect(gone).toBe(true);
  }, 20_000);
});
