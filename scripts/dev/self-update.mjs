#!/usr/bin/env node
// Coordinator self-update for the minions project developing itself (docs/design/coordinator-self-update.md).
// Host-only dev tool: it lives in the minions checkout, is never shipped (package.json "files" leaves scripts/ out,
// the image copies only dist/ and templates/), and nothing installs or starts it. The owner starts it on the host;
// stopping it is the kill switch.
//
// Phase 1 (this file): start refusals, the lock, the log and state files, polling for `upgrade --from-container`
// change requests, taking one (`settings requests mark <id> --status confirmed`, through this script's own
// `docker exec` into the runtime container), idle detection and --dry-run. Nothing is applied yet: sync, gate,
// build, health check and rollback are phases 2 and 3, so a taken request is marked failed with that reason.
//
// Plain Node ESM with no imports from src/: it runs against the installed `minions` CLI and `docker`. It never puts
// a token or secret in argv or the log, and it treats every request field from the container as untrusted text.
//
// Usage: node scripts/dev/self-update.mjs [--repo <path>] [--dry-run] [--once] [--interval <seconds>]
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE = 'app';
const DEFAULT_INTERVAL_S = 30;
const GIT_SPEC = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:)|\.git(#|$)/;
const CONFIRM_DETAIL = 'taken by the host self-update script (scripts/dev/self-update.mjs)';
const PHASE1_DETAIL = 'self-update: apply is not built yet (phase 1 of docs/design/coordinator-self-update.md); nothing was applied';
const INTERRUPTED_DETAIL = 'self-update: the script stopped while handling this request; it is not run again';

// ---------------------------------------------------------------- small helpers

/** Untrusted text for the terminal and the log: no control characters, bounded length. */
const clean = (s, max = 200) => {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const real = (p) => { try { return realpathSync(p); } catch { return null; } };

/** Runs a command without a shell; never throws (spawn errors become code 127). */
function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    execFile(cmd, args, { cwd: opts.cwd, env: process.env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 127) : 0;
      res({ code, stdout: stdout ?? '', stderr: stderr || (err && typeof err.code !== 'number' ? String(err.message) : '') });
    });
  });
}

/** The last JSON line of a `--json` command (the minions envelope), or null. */
function envelope(stdout) {
  const line = String(stdout).trim().split('\n').filter(Boolean).at(-1);
  try { const v = JSON.parse(line ?? ''); return v && typeof v === 'object' && typeof v.ok === 'boolean' ? v : null; } catch { return null; }
}

/** <MINIONS_HOME>: same rules as hostRoot() in src/core/paths.ts. */
export function hostRoot(env = process.env, platform = process.platform, home = homedir()) {
  if (env.MINIONS_HOME) return env.MINIONS_HOME;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Minions');
  const xdg = env.XDG_DATA_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'share'), 'minions');
}

/** Same check as isMinionsCheckout() in src/host/upgrade-source.ts. */
export const isMinionsCheckout = (dir) => readJson(join(dir, 'package.json'))?.name === 'minions' && existsSync(join(dir, 'src', 'cli.ts'));

// ---------------------------------------------------------------- facts

/** Kind of the global minions install, as detectInstalled() in src/host/upgrade-source.ts decides it. */
async function installedCli() {
  const r = await run('npm', ['root', '-g'], { timeoutMs: 60_000 });
  const root = r.code === 0 ? r.stdout.trim().split('\n').at(-1)?.trim() : '';
  if (!root) return { kind: 'unknown', path: null, detail: '`npm root -g` failed' };
  const path = join(root, 'minions');
  let st;
  try { st = lstatSync(path); } catch { return { kind: 'missing', path, detail: `nothing at ${path}` }; }
  if (st.isSymbolicLink()) return { kind: 'link', path, detail: `${path} is a link (npm link)` };
  const pj = readJson(join(path, 'package.json'));
  if ([pj?._resolved, pj?._from].some((s) => typeof s === 'string' && GIT_SPEC.test(s))) return { kind: 'git', path, detail: 'installed from a git URL' };
  const stamp = readJson(join(path, 'dist', 'build.json'));
  return stamp?.kind === 'packed' ? { kind: 'packed', path, version: pj?.version ?? null, detail: `packed ${pj?.version ?? ''}`.trim() }
    : { kind: 'unknown', path, detail: 'no packed build stamp (dist/build.json)' };
}

async function git(repo, args) {
  const r = await run('git', args, { cwd: repo, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The registered minions project of the checkout: registry.json by git common dir, then project.json. */
function findProject(home, commonDir) {
  const reg = readJson(join(home, 'registry.json'));
  const entry = Object.entries(reg?.projects ?? {}).find(([, e]) => e && real(e.gitCommonDir) === commonDir);
  if (!entry) return null;
  const [projectId] = entry;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) return null;
  const dir = join(home, 'projects', projectId);
  const pj = readJson(join(dir, 'project.json'));
  if (!pj) return null;
  return {
    projectId, dir, runtime: pj.runtime ?? 'docker', baseBranch: String(pj.baseBranch ?? 'main'), imageTag: String(pj.imageTag ?? ''),
    composeName: `minions-${projectId.slice(0, 8).toLowerCase()}`, composeFile: join(dir, 'compose.yaml'),
  };
}

/** Collects the facts and the start refusals (every failed condition, not only the first). */
async function gatherFacts(repoArg) {
  const refusals = [];
  const top = await git(repoArg, ['rev-parse', '--show-toplevel']);
  const repo = top ? real(top) ?? top : null;
  if (!repo) return { refusals: [`${repoArg} is not inside a Git repository`] };
  const home = hostRoot();
  if (!isMinionsCheckout(repo)) refusals.push(`${repo} is not a minions checkout (package.json named minions plus src/cli.ts); self-update is only for the minions project developing itself`);
  const cli = await installedCli();
  if (cli.kind !== 'packed') refusals.push(`the installed minions CLI is not a packed install (${cli.kind}: ${cli.detail}); only a packed install can be backed up and rolled back`);
  const commonDirRaw = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = commonDirRaw ? real(commonDirRaw) ?? commonDirRaw : null;
  const project = commonDir ? findProject(home, commonDir) : null;
  if (!project) refusals.push(`no minions project is registered for ${repo} under ${home}`);
  else if (project.runtime !== 'docker') refusals.push(`the project runtime is "${clean(project.runtime, 40)}", not docker`);
  let delivery = null;
  const cfg = await run('minions', ['--json', 'config', 'show'], { cwd: repo, timeoutMs: 60_000 });
  const env = envelope(cfg.stdout);
  if (env?.ok) delivery = env.data?.delivery?.mode ?? null;
  if (delivery !== 'local') refusals.push(delivery ? `delivery mode is "${clean(delivery, 40)}", not local` : `could not read the delivery mode (\`minions --json config show\`: ${clean(env?.error?.message ?? cfg.stderr, 160) || `exit ${cfg.code}`})`);
  if (project) {
    const branch = await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (branch !== project.baseBranch) refusals.push(`the checkout is on ${branch ? `branch ${branch}` : 'a detached HEAD'}, not the base branch ${project.baseBranch}`);
  }
  const status = await git(repo, ['status', '--porcelain']);
  if (status === null) refusals.push('`git status` failed in the checkout');
  else if (status) refusals.push(`the checkout has uncommitted or untracked changes (${status.split('\n').length} path(s)); commit or remove them first`);
  return { repo, home, cli, project, delivery, refusals };
}

// ---------------------------------------------------------------- runtime access (own docker exec)

const composeArgv = (p, ...args) => ['compose', '-p', p.composeName, '-f', p.composeFile, ...args];

async function runtimeRunning(p) {
  const r = await run('docker', composeArgv(p, 'ps', '--status', 'running', '-q', SERVICE), { timeoutMs: 30_000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/**
 * A runtime verb through `docker compose exec` (as runtimeJson in src/host/change-requests.ts). A stopped runtime is
 * `{ state: 'not-running' }`, which callers treat as "retry later", never as a failure of the request.
 */
async function runtimeVerb(p, args) {
  if (!(await runtimeRunning(p))) return { state: 'not-running' };
  const r = await run('docker', composeArgv(p, 'exec', '-T', SERVICE, 'minions', ...args, '--json'), { timeoutMs: 120_000 });
  const env = envelope(r.stdout);
  if (!env) return { state: 'error', message: `unexpected output from the runtime (exit ${r.code}): ${clean(r.stderr || r.stdout, 200)}` };
  if (!env.ok) return env.error?.code === 'PRECONDITION' && /not running/i.test(env.error?.message ?? '') ? { state: 'not-running' } : { state: 'error', message: clean(env.error?.message ?? 'failed in the runtime', 300) };
  return { state: 'ok', data: env.data };
}

const markRequest = (p, id, status, detail) => runtimeVerb(p, ['settings', 'requests', 'mark', id, '--status', status, '--detail', detail.slice(0, 900)]);

/** Open requests through the host verb `minions --json settings requests` (it reaches the runtime itself). */
async function listRequests(repo) {
  const r = await run('minions', ['--json', 'settings', 'requests'], { cwd: repo, timeoutMs: 120_000 });
  const env = envelope(r.stdout);
  if (!env) return { state: 'error', message: `\`minions --json settings requests\` gave no JSON (exit ${r.code}): ${clean(r.stderr, 200)}` };
  if (!env.ok) return env.error?.code === 'PRECONDITION' ? { state: 'not-running', message: clean(env.error?.message, 200) } : { state: 'error', message: clean(env.error?.message, 300) };
  return { state: 'ok', requests: Array.isArray(env.data?.requests) ? env.data.requests : [] };
}

/** The oldest proposed `upgrade --from-container` request for the base branch (true or the branch name). */
export function pickRequest(requests, baseBranch) {
  const ok = requests.filter((r) => r && r.kind === 'upgrade' && r.status === 'proposed' && typeof r.id === 'string' && /^cr_[0-9a-f]{8}$/.test(r.id)
    && (r.payload?.fromContainer === true || r.payload?.fromContainer === baseBranch));
  return ok.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] ?? null;
}

/** Idle: no active worker lease and no drain (process runs belong to leases). Unreadable status is not idle. */
async function idleState(p) {
  const r = await runtimeVerb(p, ['status']);
  if (r.state !== 'ok') return r;
  const leases = Array.isArray(r.data?.activeLeases) ? r.data.activeLeases : null;
  if (!leases) return { state: 'error', message: 'the runtime status has no activeLeases' };
  const busy = [];
  if (leases.length) busy.push(`${leases.length} active worker lease(s) (${leases.map((l) => clean(l?.id, 40)).join(', ')})`);
  if (r.data?.draining) busy.push('a drain is in progress');
  return busy.length ? { state: 'busy', reason: busy.join('; ') } : { state: 'idle' };
}

// ---------------------------------------------------------------- lock, log, state

/** Process start time, to tell a live holder from a reused pid (Linux /proc field 22; elsewhere `ps -o lstart=`). */
export function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const v = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (v && /^\d+$/.test(v)) return v;
  } catch { /* no procfs */ }
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10_000 });
  const t = r.status === 0 ? r.stdout.trim() : '';
  return t || null;
}
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** Alive and the same process: a reused pid (different start time) is a stale lock. */
const holderAlive = (h) => pidAlive(h.pid) && (!h.start || (() => { const s = procStart(h.pid); return s === null || s === h.start; })());

export const paths = (home) => {
  const dir = join(home, 'dev-self-update');
  return { dir, lock: join(dir, 'lock'), log: join(dir, 'log.jsonl'), state: join(dir, 'state.json') };
};

/** Takes <home>/dev-self-update/lock atomically (temp file + hard link); a dead or reused holder is taken over. */
function acquireLock(file, dir) {
  const mine = { pid: process.pid, start: procStart(process.pid), at: new Date().toISOString() };
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = join(dir, `lock.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(mine) + '\n', { mode: 0o600, flag: 'wx' });
      try { linkSync(tmp, file); } finally { rmSync(tmp, { force: true }); }
      return { ok: true, release: () => { const cur = readJson(file); if (cur?.pid === mine.pid && cur?.start === mine.start) rmSync(file, { force: true }); } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const h = readJson(file);
      if (h && typeof h.pid === 'number' && holderAlive({ pid: h.pid, start: typeof h.start === 'string' ? h.start : null })) {
        return { ok: false, holder: { pid: h.pid, at: clean(h.at, 40) } };
      }
      rmSync(file, { force: true }); // stale: dead pid, reused pid, or unreadable
    }
  }
  return { ok: false, holder: null };
}
function logEvent(file, event) {
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

const EMPTY_STATE = { version: 1, lastApplied: null, badShas: [], current: null };
function readState(file) {
  const s = readJson(file);
  return s && s.version === 1 ? { ...EMPTY_STATE, ...s, badShas: Array.isArray(s.badShas) ? s.badShas : [] } : { ...EMPTY_STATE };
}
function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- one poll

/**
 * One poll. Returns a short outcome for the terminal. ctx: { facts, files, runId, dryRun, say }.
 * Dry run: reads only; marks, writes and logs nothing.
 */
async function pollOnce(ctx) {
  const { facts, files, dryRun, say } = ctx;
  const p = facts.project;
  if (!dryRun) {
    const st = readState(files.state);
    if (st.current && st.current.runId !== ctx.runId) {
      const m = await markRequest(p, st.current.id, 'failed', INTERRUPTED_DETAIL);
      if (m.state === 'not-running') { say('runtime not running: retry later (an interrupted request is still to be marked failed)'); return 'not-running'; }
      if (m.state === 'error') say(`could not mark interrupted request ${st.current.id} failed: ${m.message}`);
      logEvent(files.log, { event: 'interrupted', request: st.current.id, marked: m.state === 'ok' });
      writeState(files.state, { ...st, current: null });
    }
  }
  const list = await listRequests(facts.repo);
  if (list.state === 'not-running') { say(`runtime not running: retry later (${list.message})`); return 'not-running'; }
  if (list.state === 'error') { say(`could not list change requests: ${list.message}; retry later`); return 'error'; }
  const req = pickRequest(list.requests, p.baseBranch);
  if (!req) { say('no open upgrade --from-container request'); return 'none'; }
  const what = `${req.id} (upgrade --from-container ${req.payload.fromContainer === true ? p.baseBranch : clean(req.payload.fromContainer, 60)}, created ${clean(req.createdAt, 40)}, reason from the container: "${clean(req.reason, 120)}")`;
  const idle = await idleState(p);
  if (idle.state === 'not-running') { say(`request ${what}: runtime not running: retry later`); return 'not-running'; }
  if (idle.state === 'error') { say(`request ${what}: cannot tell whether the runtime is idle (${idle.message}); not taken, retry later`); return 'error'; }
  if (idle.state === 'busy') { say(`request ${what}: waiting for idle: ${idle.reason}; not taken`); return 'busy'; }
  if (dryRun) {
    say(`would take request ${what}`);
    say(`  docker ${composeArgv(p, 'exec', '-T', SERVICE, 'minions', 'settings', 'requests', 'mark', req.id, '--status', 'confirmed', '--detail', '<detail>', '--json').join(' ')}`);
    say('  then apply (phase 2/3, not built yet): upgrade --sync-only, host gate, upgrade --rebuild-cli, health check, rollback');
    say(`  phase 1 marks the request failed: "${PHASE1_DETAIL}"`);
    return 'would-take';
  }
  const m = await markRequest(p, req.id, 'confirmed', CONFIRM_DETAIL);
  if (m.state === 'not-running') { say(`request ${req.id}: runtime stopped before it was taken: retry later`); return 'not-running'; }
  if (m.state === 'error') { say(`request ${req.id}: marking it confirmed failed: ${m.message}; retry later`); return 'error'; }
  const st = readState(files.state);
  writeState(files.state, { ...st, current: { id: req.id, takenAt: new Date().toISOString(), runId: ctx.runId } });
  logEvent(files.log, { event: 'taken', request: req.id, fromContainer: req.payload.fromContainer === true ? true : clean(req.payload.fromContainer, 60) });
  say(`took request ${what}`);
  // Phase 1 stops here: report honestly that nothing was applied and release the request.
  const f = await markRequest(p, req.id, 'failed', PHASE1_DETAIL);
  logEvent(files.log, { event: 'not-applied', request: req.id, reason: 'phase 1: apply not built', marked: f.state === 'ok' });
  if (f.state === 'ok') writeState(files.state, { ...readState(files.state), current: null });
  say(`request ${req.id}: ${f.state === 'ok' ? 'marked failed' : `could not be marked failed yet (${f.state}); it is marked when the script next starts`}: apply is not built yet (phase 1)`);
  return 'taken';
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const o = { repo: process.cwd(), dryRun: false, once: false, intervalS: DEFAULT_INTERVAL_S };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--once') o.once = true;
    else if (a === '--repo') o.repo = resolve(argv[++i] ?? '');
    else if (a === '--interval') { o.intervalS = Number(argv[++i]); if (!(o.intervalS > 0)) throw new Error('--interval needs a positive number of seconds'); }
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${clean(a, 60)}`);
  }
  return o;
}

const USAGE = `usage: node scripts/dev/self-update.mjs [--repo <path>] [--dry-run] [--once] [--interval <seconds>]
  Host-only dev tool for the minions project developing itself (docs/design/coordinator-self-update.md).
  --repo      the minions checkout of the project (default: the current directory)
  --dry-run   check the refusals and print the plan for one poll; mark, write and log nothing
  --once      one poll, then exit
  --interval  seconds between polls (default ${DEFAULT_INTERVAL_S})`;

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`self-update: ${e.message}\n${USAGE}\n`); return 64; }
  if (o.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  const say = (m) => process.stdout.write(`${new Date().toISOString()} self-update: ${m}\n`);
  const facts = await gatherFacts(o.repo);
  if (o.dryRun) {
    process.stdout.write([
      'self-update plan (dry run: nothing is marked, written or logged)',
      `  checkout: ${facts.repo ?? o.repo}`,
      `  installed CLI: ${facts.cli ? `${facts.cli.kind} (${facts.cli.detail})` : 'unknown'}`,
      `  project: ${facts.project ? `${facts.project.projectId} (runtime ${facts.project.runtime}, base ${facts.project.baseBranch}, compose ${facts.project.composeName})` : 'not found'}`,
      `  delivery: ${facts.delivery ?? 'unknown'}`,
      ...(facts.home ? [`  state: ${paths(facts.home).dir}`] : []),
    ].join('\n') + '\n');
  }
  if (facts.refusals.length) {
    process.stderr.write(`self-update: refusing to start:\n${facts.refusals.map((r) => `  - ${r}`).join('\n')}\n`);
    return 2;
  }
  const files = paths(facts.home);
  if (o.dryRun) {
    const h = readJson(files.lock);
    if (h && typeof h.pid === 'number' && holderAlive(h)) say(`note: another self-update script holds the lock (pid ${h.pid})`);
    await pollOnce({ facts, files, runId: 'dry-run', dryRun: true, say });
    return 0;
  }
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(files.lock, files.dir);
  if (!lock.ok) {
    process.stderr.write(`self-update: refusing to start: another self-update script runs${lock.holder ? ` (pid ${lock.holder.pid}, since ${lock.holder.at})` : ''} (lock ${files.lock})\n`);
    return 2;
  }
  const runId = randomBytes(8).toString('hex');
  let stopping = false;
  let wake = null;
  let timer = null;
  const stop = (sig) => { stopping = true; say(`${sig}: stopping`); if (timer) clearTimeout(timer); wake?.(); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  try {
    logEvent(files.log, { event: 'started', pid: process.pid, repo: facts.repo, projectId: facts.project.projectId });
    say(`started (pid ${process.pid}, project ${facts.project.projectId}, polling every ${o.intervalS}s; stop with Ctrl-C)`);
    while (!stopping) {
      try { await pollOnce({ facts, files, runId, dryRun: false, say }); } catch (e) { say(`poll failed: ${clean(e?.message ?? e, 300)}; retry later`); }
      if (o.once || stopping) break;
      await new Promise((r) => { wake = r; timer = setTimeout(r, o.intervalS * 1000); });
      wake = null; timer = null;
    }
    logEvent(files.log, { event: 'stopped', pid: process.pid });
  } finally { lock.release(); }
  return 0;
}

// Imported for its helpers: do nothing. Run as a script: main.
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`self-update: ${clean(e?.stack ?? e, 2000)}\n`); process.exitCode = 1; });
}
