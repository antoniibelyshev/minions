#!/usr/bin/env node
// Coordinator self-update for the minions project developing itself (docs/design/coordinator-self-update.md).
// Host-only dev tool: it lives in the minions checkout, is never shipped (package.json "files" leaves scripts/ out,
// the image copies only dist/ and templates/), and nothing installs or starts it. The owner starts it on the host;
// stopping it is the kill switch.
//
// Phase 1: start refusals, the lock, the log and state files, polling for `upgrade --from-container` change
// requests, taking one (`settings requests mark <id> --status confirmed`, through this script's own `docker exec`
// into the runtime container), idle detection and --dry-run.
// Phase 2: the apply. Sync (`minions upgrade --sync-only`), the host gate (`npm ci`, `npm run typecheck`, `npm test`)
// on the exact synced commit in a throwaway worktree, the previous-image tag (`<imageTag>-prev`), the upgrade
// (`minions upgrade --rebuild-cli`, a second run, so building the synced commits is allowed), outcome marking and
// the owner notice (`notify enqueue`, own docker exec). A SHA that failed the gate is recorded as bad and is never
// tried again.
// Phase 3 (not built): the health check and rollback. healthCheck() and the comment after the upgrade step are the
// seams.
//
// Plain Node ESM with no imports from src/: it runs against the installed `minions` CLI and `docker`. It never puts
// a token or secret in argv or the log, and it treats every request field from the container as untrusted text.
//
// Usage: node scripts/dev/self-update.mjs [--repo <path>] [--dry-run] [--once] [--interval <seconds>] [--gate-dir <path>]
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
const INTERRUPTED_DETAIL = 'self-update: the script stopped while handling this request; it is not run again';
const MIN = 60_000;
/** Step timeouts (ms). The gate's `npm test` is the slow step (the design's target: under 10 minutes in total). */
const TIMEOUTS = { sync: 10 * MIN, worktree: 2 * MIN, ci: 20 * MIN, typecheck: 15 * MIN, test: 60 * MIN, docker: 2 * MIN, upgrade: 60 * MIN };
const SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------- small helpers

/** Untrusted text for the terminal and the log: no control characters, bounded length. */
const clean = (s, max = 200) => {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const real = (p) => { try { return realpathSync(p); } catch { return null; } };

/** Running children, so a SIGINT/SIGTERM to the script reaches them (the child `minions upgrade` has its own handling). */
const children = new Set();

/**
 * Runs a command without a shell; never throws (spawn errors become code 127). opts: cwd, env (default
 * process.env), input (stdin text), timeoutMs.
 */
function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      children.delete(child);
      const code = err ? (typeof err.code === 'number' ? err.code : 127) : 0;
      res({ code, stdout: stdout ?? '', stderr: stderr || (err && typeof err.code !== 'number' ? String(err.message) : '') });
    });
    children.add(child);
    child.stdin?.on('error', () => { /* the child may exit before reading */ });
    if (opts.input !== undefined) child.stdin?.end(opts.input); else child.stdin?.end();
  });
}

/** The last lines of a command's output, for a failure detail. */
const tail = (r, max = 400) => {
  const t = clean(`${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-8).join(' '), 4000);
  return t.length > max ? `…${t.slice(-max)}` : t;
};

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
  let sensitivePaths = [];
  if (env?.ok) {
    delivery = env.data?.delivery?.mode ?? null;
    sensitivePaths = Array.isArray(env.data?.sensitivePaths) ? env.data.sensitivePaths.filter((g) => typeof g === 'string') : [];
  }
  if (delivery !== 'local') refusals.push(delivery ? `delivery mode is "${clean(delivery, 40)}", not local` : `could not read the delivery mode (\`minions --json config show\`: ${clean(env?.error?.message ?? cfg.stderr, 160) || `exit ${cfg.code}`})`);
  if (project) {
    const branch = await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (branch !== project.baseBranch) refusals.push(`the checkout is on ${branch ? `branch ${branch}` : 'a detached HEAD'}, not the base branch ${project.baseBranch}`);
  }
  const status = await git(repo, ['status', '--porcelain']);
  if (status === null) refusals.push('`git status` failed in the checkout');
  else if (status) refusals.push(`the checkout has uncommitted or untracked changes (${status.split('\n').length} path(s)); commit or remove them first`);
  return { repo, home, cli, project, delivery, sensitivePaths, refusals };
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
async function runtimeVerb(p, args, input) {
  if (!(await runtimeRunning(p))) return { state: 'not-running' };
  const r = await run('docker', composeArgv(p, 'exec', '-T', SERVICE, 'minions', ...args, '--json'), { timeoutMs: 120_000, input });
  const env = envelope(r.stdout);
  if (!env) return { state: 'error', message: `unexpected output from the runtime (exit ${r.code}): ${clean(r.stderr || r.stdout, 200)}` };
  if (!env.ok) return env.error?.code === 'PRECONDITION' && /not running/i.test(env.error?.message ?? '') ? { state: 'not-running' } : { state: 'error', message: clean(env.error?.message ?? 'failed in the runtime', 300) };
  return { state: 'ok', data: env.data };
}

const markRequest = (p, id, status, detail) => runtimeVerb(p, ['settings', 'requests', 'mark', id, '--status', status, '--detail', detail.slice(0, 900)]);
/**
 * The owner notice through the runtime outbox (text on stdin, never in argv); the coordinator sends it. Kind
 * `status`: the outbox accepts only its fixed kinds (src/runtime/outbox.ts), and `status` is not held for the digest.
 */
const enqueueNotice = (p, key, text) => runtimeVerb(p, ['notify', 'enqueue', '--key', key, '--kind', 'status'], text);

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

// ---------------------------------------------------------------- the apply (phase 2)

/** Thrown out of the apply when the script is stopped: the request stays confirmed (marked failed at next start). */
class Stopped extends Error {}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 12) : '?');

/** `<imageTag>-prev` (an image name without a tag gets `:latest-prev`). */
export function prevImageTag(tag) {
  return tag.slice(tag.lastIndexOf('/') + 1).includes(':') ? `${tag}-prev` : `${tag}:latest-prev`;
}

/** Minimal glob, the same rules as globToRegExp() in src/config/capabilities.ts. */
export function globToRegExp(glob) {
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; src += '(?:.*/)?'; } else src += '.*';
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`);
}
export const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')));

/** The gate's environment: a scratch MINIONS_HOME, so the project's tests never see the owner's real install. */
function gateEnv(home) {
  const env = { ...process.env, MINIONS_TEST_MAX_WORKERS: '2', MINIONS_HOME: home };
  delete env.MINIONS_RUNTIME;
  delete env.MINIONS_UPGRADE_HANDOFF;
  return env;
}

/**
 * The plan of the apply, as printed by --dry-run (argv only; nothing runs). The gate dir name is decided at run time.
 */
function planLines(ctx, reqId) {
  const p = ctx.facts.project;
  const gate = join(ctx.gateDir, '<sha>-<random>');
  return [
    `docker ${composeArgv(p, 'exec', '-T', SERVICE, 'minions', 'settings', 'requests', 'mark', reqId, '--status', 'confirmed', '--detail', '<detail>', '--json').join(' ')}`,
    `minions --json upgrade --sync-only   (in ${ctx.facts.repo}; the target is the new ${p.baseBranch})`,
    `git worktree add --detach ${gate} <target>   (a target recorded as bad is not tried again)`,
    `npm ci && npm run typecheck && npm test   (in ${gate}, MINIONS_TEST_MAX_WORKERS=2, scratch MINIONS_HOME; then the worktree is removed)`,
    `docker tag ${p.imageTag || '<imageTag>'} ${p.imageTag ? prevImageTag(p.imageTag) : '<imageTag>-prev'}`,
    'minions --json upgrade --rebuild-cli',
    'health check and rollback: phase 3, not built yet',
    `mark the request applied or failed, and enqueue the owner notice (notify enqueue --key self-update:${reqId} --kind status)`,
  ].map((l) => `  ${l}`);
}

/** Records one step (with its duration) in the apply, prints it, and stops the apply when the script is stopping. */
function stepper(ctx, apply) {
  return async (id, fn) => {
    const t0 = Date.now();
    const r = await fn();
    apply.steps.push({ id, status: r.ok ? 'done' : 'failed', ms: Date.now() - t0, detail: clean(r.detail, 600) });
    ctx.say(`${apply.request} ${id}: ${r.ok ? 'done' : 'failed'} - ${clean(r.detail, 300)}`);
    if (ctx.isStopping?.()) throw new Stopped(`stopped during ${id}`);
    return r;
  };
}

/** `minions --json upgrade ...` as a child in the checkout; ok as childUpgrade() in src/host/change-requests.ts decides it. */
async function minionsUpgrade(repo, flags, timeoutMs) {
  const r = await run('minions', ['--json', 'upgrade', ...flags], { cwd: repo, timeoutMs });
  const env = envelope(r.stdout);
  if (!env) return { ok: false, detail: `no result (exit ${r.code}): ${tail(r)}` };
  if (!env.ok) return { ok: false, detail: clean(env.error?.message ?? 'failed', 400) };
  const steps = Array.isArray(env.data?.steps) ? env.data.steps : [];
  const failed = steps.filter((s) => s?.status === 'failed');
  if (env.data?.stopped) return { ok: false, detail: `stopped: ${clean(env.data.stopped.reason, 300)}` };
  if (!env.data?.ok || r.code !== 0 || failed.length) {
    return { ok: false, detail: failed.length ? `failed: ${failed.map((s) => `${clean(s.id, 30)} (${clean(s.detail, 200)})`).join(', ')}` : `not ok (exit ${r.code})` };
  }
  return { ok: true, detail: 'complete', data: env.data };
}

/** Host gate on the exact commit, in a throwaway detached worktree outside the checkout; always removed after. */
async function runGate(ctx, sha, step) {
  const repo = ctx.facts.repo;
  mkdirSync(ctx.gateDir, { recursive: true, mode: 0o700 });
  const dir = join(ctx.gateDir, `${sha.slice(0, 12)}-${randomBytes(4).toString('hex')}`);
  const home = `${dir}.home`;
  try {
    const add = await step('gate-worktree', async () => {
      const r = await run('git', ['worktree', 'add', '--detach', dir, sha], { cwd: repo, timeoutMs: TIMEOUTS.worktree });
      if (r.code !== 0) return { ok: false, detail: `git worktree add failed: ${tail(r)}` };
      const head = await git(dir, ['rev-parse', 'HEAD']);
      return head === sha ? { ok: true, detail: `${dir} at ${short(sha)}` } : { ok: false, detail: `the worktree is at ${short(head)}, not ${short(sha)}` };
    });
    if (!add.ok) return add;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = gateEnv(home);
    for (const [id, args, timeoutMs] of [['gate-ci', ['ci'], TIMEOUTS.ci], ['gate-typecheck', ['run', 'typecheck'], TIMEOUTS.typecheck], ['gate-test', ['test'], TIMEOUTS.test]]) {
      const r = await step(id, async () => {
        const x = await run('npm', args, { cwd: dir, env, timeoutMs });
        return x.code === 0 ? { ok: true, detail: `npm ${args.join(' ')} passed` } : { ok: false, detail: `npm ${args.join(' ')} failed (exit ${x.code}): ${tail(x)}` };
      });
      if (!r.ok) return r;
    }
    return { ok: true, detail: `npm ci, typecheck and test passed at ${short(sha)}` };
  } finally {
    await run('git', ['worktree', 'remove', '--force', dir], { cwd: repo, timeoutMs: TIMEOUTS.worktree });
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    await run('git', ['worktree', 'prune'], { cwd: repo, timeoutMs: TIMEOUTS.worktree });
  }
}

/** Keeps the running image as `<imageTag>-prev` for the phase 3 rollback (the CLI backup is made by applyCli itself). */
async function tagPrevious(p) {
  if (!p.imageTag) return { ok: false, detail: 'the project has no imageTag' };
  const id = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', p.imageTag], { timeoutMs: TIMEOUTS.docker });
  const imageId = id.code === 0 ? id.stdout.trim() : '';
  if (!imageId) return { ok: false, detail: `docker image inspect ${p.imageTag} failed: ${tail(id)}` };
  const prev = prevImageTag(p.imageTag);
  const t = await run('docker', ['tag', p.imageTag, prev], { timeoutMs: TIMEOUTS.docker });
  return t.code === 0 ? { ok: true, detail: `${p.imageTag} (${clean(imageId, 80)}) kept as ${prev}`, prev, imageId } : { ok: false, detail: `docker tag ${p.imageTag} ${prev} failed: ${tail(t)}` };
}

/**
 * Phase 3 seam: the health definition of the design (fresh-process CLI checks, new image ID in the container,
 * coordinator running with restartRequired current, Telegram checks, at most one restart, polled for 5 minutes).
 * Not built: phase 2 trusts the upgrade's own result.
 */
// eslint-disable-next-line no-unused-vars
async function healthCheck(_ctx, _apply) {
  return { checked: false, healthy: true, detail: 'not checked (the health check and rollback are phase 3)' };
}

function noticeText(apply, files) {
  const lines = [apply.outcome === 'applied'
    ? `Self-update applied: ${apply.base} ${short(apply.from)}..${short(apply.to)} (request ${apply.request}).`
    : `Self-update failed (request ${apply.request}): ${clean(apply.detail, 600)}`];
  if (apply.range.length) lines.push(`Commits (${apply.range.length}${apply.rangeTruncated ? '+' : ''}):`, ...apply.range.map((l) => `  ${clean(l, 120)}`));
  if (apply.to) lines.push(`Sensitive paths touched: ${apply.sensitive.length ? apply.sensitive.map((s) => clean(s, 120)).join(', ') : 'none'}.`);
  if (apply.scriptChanged) lines.push('The self-update script changed (scripts/dev/); restart it to use the new version.');
  lines.push(`Log: ${files.log}`);
  return lines.join('\n') + '\n';
}

/**
 * Records the outcome of an apply: the log line, the state (bad SHA, last applied) and the pending outcome, then
 * marks the request and enqueues the notice. A stopped runtime leaves the outcome pending for the next poll.
 */
async function finishApply(ctx, apply, status, detail, o = {}) {
  apply.outcome = status;
  apply.detail = detail;
  logEvent(ctx.files.log, { event: 'apply', ...apply });
  const st = readState(ctx.files.state);
  const badShas = o.bad && apply.to && !st.badShas.includes(apply.to) ? [...st.badShas, apply.to] : st.badShas;
  const outcome = { status, detail, marked: false, notice: o.notice === false ? null : { key: `self-update:${apply.request}`, text: noticeText(apply, ctx.files) } };
  writeState(ctx.files.state, { ...st, badShas, lastApplied: status === 'applied' && apply.to ? apply.to : st.lastApplied, current: { ...st.current, outcome } });
  ctx.say(`request ${apply.request}: ${status}: ${clean(detail, 300)}`);
  return flushOutcome(ctx);
}

/** Marks and notifies a pending outcome. 'not-running': retried on the next poll. */
async function flushOutcome(ctx) {
  const p = ctx.facts.project;
  const st = readState(ctx.files.state);
  const cur = st.current;
  if (!cur?.outcome) return 'none';
  if (!cur.outcome.marked) {
    const m = await markRequest(p, cur.id, cur.outcome.status, cur.outcome.detail);
    if (m.state === 'not-running') { ctx.say(`request ${cur.id}: runtime not running: it is marked ${cur.outcome.status} on a later poll`); return 'not-running'; }
    if (m.state === 'error') ctx.say(`request ${cur.id}: could not be marked ${cur.outcome.status}: ${m.message}`);
    writeState(ctx.files.state, { ...st, current: { ...cur, outcome: { ...cur.outcome, marked: true } } });
    logEvent(ctx.files.log, { event: 'marked', request: cur.id, status: cur.outcome.status, ok: m.state === 'ok' });
  }
  if (cur.outcome.notice) {
    const n = await enqueueNotice(p, cur.outcome.notice.key, cur.outcome.notice.text);
    if (n.state === 'not-running') { ctx.say(`request ${cur.id}: runtime not running: the owner notice is enqueued on a later poll`); return 'not-running'; }
    if (n.state === 'error') ctx.say(`request ${cur.id}: could not enqueue the owner notice: ${n.message}`);
    logEvent(ctx.files.log, { event: 'notice', request: cur.id, key: cur.outcome.notice.key, ok: n.state === 'ok' });
  }
  writeState(ctx.files.state, { ...readState(ctx.files.state), current: null });
  return 'done';
}

/** The apply of a taken (confirmed) request: sync, gate, previous-image tag, upgrade, outcome. */
async function applyRequest(ctx, req) {
  const { facts, files } = ctx;
  const p = facts.project;
  const repo = facts.repo;
  const base = p.baseBranch;
  const apply = { request: req.id, base, from: null, to: null, range: [], rangeTruncated: false, sensitive: [], scriptChanged: false, steps: [], previousImage: null, health: null, rollback: null };
  const step = stepper(ctx, apply);
  apply.from = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${base}`]);

  // 1. Sync: export the container branches and strictly fast-forward host main (never forced).
  const sync = await step('sync', () => minionsUpgrade(repo, ['--sync-only'], TIMEOUTS.sync));
  if (!sync.ok) return finishApply(ctx, apply, 'failed', `self-update: the sync was refused (${sync.detail}); nothing was built`);
  const to = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${base}`]);
  if (!to || !SHA.test(to)) return finishApply(ctx, apply, 'failed', `self-update: could not read ${base} after the sync; nothing was built`);
  apply.to = to;
  if (apply.from && apply.from !== to) {
    const log = await git(repo, ['log', '--oneline', '--no-decorate', '-n', '51', `${apply.from}..${to}`]);
    const all = log ? log.split('\n').filter(Boolean) : [];
    apply.rangeTruncated = all.length > 50;
    apply.range = all.slice(0, 50).map((l) => clean(l, 160));
    const names = (await git(repo, ['diff', '--name-only', `${apply.from}..${to}`]))?.split('\n').filter(Boolean) ?? [];
    apply.sensitive = names.filter((n) => matchesAny(n, facts.sensitivePaths ?? [])).slice(0, 100);
    apply.scriptChanged = names.some((n) => n.startsWith('scripts/dev/'));
  }
  const st = readState(files.state);
  if (st.badShas.includes(to)) {
    return finishApply(ctx, apply, 'failed', `self-update: ${short(to)} failed before and is recorded as bad; it is not tried again (a newer commit on ${base} is tried normally); nothing was built`);
  }
  if (st.lastApplied === to) return finishApply(ctx, apply, 'applied', `self-update: already at ${short(to)}; nothing to do`, { notice: false });

  // 2. Host gate on the exact synced commit (container evidence is not trusted for this).
  const gate = await runGate(ctx, to, step);
  if (!gate.ok) return finishApply(ctx, apply, 'failed', `self-update: the host gate failed at ${short(to)} (${gate.detail}); nothing was built; ${short(to)} is recorded as bad`, { bad: true });

  // 3. Keep the previous image for the rollback.
  const tag = await step('previous-image', () => tagPrevious(p));
  if (!tag.ok) return finishApply(ctx, apply, 'failed', `self-update: the previous image could not be kept (${tag.detail}); nothing was built`);
  apply.previousImage = { tag: tag.prev, id: tag.imageId };

  // 4. Upgrade: a second run, so building the synced commits is allowed (drain, rebuild, recreate, restart --recover).
  const up = await step('upgrade', () => minionsUpgrade(repo, ['--rebuild-cli'], TIMEOUTS.upgrade));
  // Phase 3: a failed upgrade rolls back here (CLI backup reinstall, `<imageTag>-prev` re-tag, down && start).
  if (!up.ok) return finishApply(ctx, apply, 'failed', `self-update: minions upgrade --rebuild-cli failed (${up.detail}); not rolled back (rollback is phase 3); previous image kept as ${tag.prev}`);

  // 5. Health (phase 3 seam).
  apply.health = await healthCheck(ctx, apply);
  if (!apply.health.healthy) return finishApply(ctx, apply, 'failed', `self-update: not healthy after the upgrade (${apply.health.detail})`, { bad: true });

  return finishApply(ctx, apply, 'applied', `self-update ${short(apply.from)}..${short(to)}`);
}

// ---------------------------------------------------------------- one poll

/**
 * One poll. Returns a short outcome for the terminal. ctx: { facts, files, runId, dryRun, gateDir, say, isStopping }.
 * Dry run: reads only; marks, writes, logs and runs nothing.
 */
async function pollOnce(ctx) {
  const { facts, files, dryRun, say } = ctx;
  const p = facts.project;
  if (!dryRun) {
    const st = readState(files.state);
    if (st.current?.outcome) {
      // An outcome that could not be marked or notified yet (the runtime was down): finish it first.
      const f = await flushOutcome(ctx);
      if (f === 'not-running') return 'not-running';
    } else if (st.current && st.current.runId !== ctx.runId) {
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
    const st = readState(files.state);
    say(`would take request ${what} and apply it:`);
    for (const l of planLines(ctx, req.id)) say(l);
    say(`  state: last applied ${st.lastApplied ? short(st.lastApplied) : 'none'}, ${st.badShas.length} bad SHA(s)`);
    return 'would-take';
  }
  const m = await markRequest(p, req.id, 'confirmed', CONFIRM_DETAIL);
  if (m.state === 'not-running') { say(`request ${req.id}: runtime stopped before it was taken: retry later`); return 'not-running'; }
  if (m.state === 'error') { say(`request ${req.id}: marking it confirmed failed: ${m.message}; retry later`); return 'error'; }
  const st = readState(files.state);
  writeState(files.state, { ...st, current: { id: req.id, takenAt: new Date().toISOString(), runId: ctx.runId } });
  logEvent(files.log, { event: 'taken', request: req.id, fromContainer: req.payload.fromContainer === true ? true : clean(req.payload.fromContainer, 60) });
  say(`took request ${what}`);
  try {
    await applyRequest(ctx, req);
  } catch (e) {
    if (!(e instanceof Stopped)) {
      const cur = readState(files.state).current;
      if (cur?.id === req.id && !cur.outcome) {
        await finishApply(ctx, { request: req.id, base: p.baseBranch, from: null, to: null, range: [], sensitive: [], steps: [] }, 'failed', `self-update: the apply failed unexpectedly: ${clean(e?.message ?? e, 300)}`);
      }
      throw e;
    }
    // Stopped: no rollback, the request stays confirmed; the next start reports it as interrupted and marks it failed.
    logEvent(files.log, { event: 'apply-stopped', request: req.id, reason: e.message });
    say(`request ${req.id}: ${e.message}; it stays confirmed and is marked failed when the script next starts`);
    return 'stopped';
  }
  return 'taken';
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const o = { repo: process.cwd(), dryRun: false, once: false, intervalS: DEFAULT_INTERVAL_S, gateDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--once') o.once = true;
    else if (a === '--repo') o.repo = resolve(argv[++i] ?? '');
    else if (a === '--interval') { o.intervalS = Number(argv[++i]); if (!(o.intervalS > 0)) throw new Error('--interval needs a positive number of seconds'); }
    else if (a === '--gate-dir') { const v = argv[++i]; if (!v) throw new Error('--gate-dir needs a path'); o.gateDir = resolve(v); }
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${clean(a, 60)}`);
  }
  return o;
}

const USAGE = `usage: node scripts/dev/self-update.mjs [--repo <path>] [--dry-run] [--once] [--interval <seconds>] [--gate-dir <path>]
  Host-only dev tool for the minions project developing itself (docs/design/coordinator-self-update.md).
  --repo      the minions checkout of the project (default: the current directory)
  --dry-run   check the refusals and print the plan for one poll; mark, write, log and run nothing
  --once      one poll, then exit
  --interval  seconds between polls (default ${DEFAULT_INTERVAL_S})
  --gate-dir  where the throwaway gate worktrees go, outside the checkout (default <MINIONS_HOME>/dev-self-update/gate)`;

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
  const gateDir = o.gateDir ?? join(files.dir, 'gate');
  if (o.dryRun) {
    const h = readJson(files.lock);
    if (h && typeof h.pid === 'number' && holderAlive(h)) say(`note: another self-update script holds the lock (pid ${h.pid})`);
    await pollOnce({ facts, files, runId: 'dry-run', dryRun: true, gateDir, say });
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
  // A stop during an apply reaches the running child (the child `minions upgrade` resumes its pause, and its
  // upgrade.json marker lets a rerun finish); the apply then ends without a rollback.
  const stop = (sig) => {
    stopping = true; say(`${sig}: stopping`); if (timer) clearTimeout(timer); wake?.();
    for (const c of children) { try { c.kill(sig); } catch { /* already gone */ } }
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  try {
    logEvent(files.log, { event: 'started', pid: process.pid, repo: facts.repo, projectId: facts.project.projectId });
    say(`started (pid ${process.pid}, project ${facts.project.projectId}, polling every ${o.intervalS}s; stop with Ctrl-C)`);
    while (!stopping) {
      try { await pollOnce({ facts, files, runId, dryRun: false, gateDir, say, isStopping: () => stopping }); } catch (e) { say(`poll failed: ${clean(e?.message ?? e, 300)}; retry later`); }
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
