// Source phase of `minions upgrade` (host), run before any container step:
//   sync: `--from-container` exports the container's branches (exportRepo) and fast-forwards one host
//         branch to refs/remotes/minions/<base>, only on a strict fast-forward with clean trees.
//   cli:  when the project repo is a minions checkout, compares the installed global CLI with it and
//         rebuilds/reinstalls, or prints the exact command and stops before the container steps.
// Decision record: docs/design/bootstrap.md, "Upgrade from the container".
//
// - The host branch only ever moves forward: `merge --ff-only` where it is checked out, else
//   `update-ref <ref> <new> <old>`. Never a force, reset, checkout or stash; a dirty tree or a
//   divergence refuses with the reason and changes nothing.
// - The running CLI never continues on a package it just replaced: after a rebuild/reinstall the rest of
//   the upgrade is handed off to the newly installed CLI (a fresh process). Kinds where npm cannot
//   replace the install in place (git-URL installs, unknown installs) are never reinstalled here: the
//   exact command is printed and the upgrade stops before touching the container.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceFingerprint } from '../../scripts/source-fingerprint.mjs';
import { MinionsError } from '../core/errors.js';
import { run, type RunResult } from '../core/exec.js';
import { HOST_GIT } from './discovery.js';
import type { Runner } from './docker.js';
import { shellQuote } from './setup.js';
import type { ExportResult } from './transfer.js';

/** Set in the environment of the CLI that continues an upgrade after a reinstall (no second reinstall). */
export const HANDOFF_ENV = 'MINIONS_UPGRADE_HANDOFF';
const BUILD_DEPS = ['esbuild', 'zod', 'commander'];

export interface SourceStep { id: 'sync' | 'cli'; status: 'done' | 'skipped' | 'failed' | 'planned'; detail: string }

// ---------------------------------------------------------------- sync (--from-container)

export interface SyncResult {
  branch: string;
  /** Remote-tracking ref the branch is fast-forwarded to. */
  target: string;
  from: string | null;
  to: string | null;
  action: 'fast-forward' | 'up-to-date' | 'ahead';
  /** How the ref was (or would be) moved; null when nothing moves. */
  method: 'merge --ff-only' | 'update-ref' | null;
  /** Worktree where the branch is checked out (null: not checked out anywhere). */
  worktree: string | null;
  applied: boolean;
  exported: ExportResult['changes'] | null;
}

export interface SyncOptions {
  repo: string;
  /** Host branch to move (default: the project's base branch). */
  branch: string;
  /** Container branch whose exported ref is the target (refs/remotes/minions/<baseBranch>). */
  baseBranch: string;
  /** Fetches the container's branches into refs/remotes/minions/* (skipped on --dry-run). */
  exportRepo: () => Promise<ExportResult>;
  dryRun?: boolean;
  runner?: Runner;
}

const short = (sha: string | null) => sha?.slice(0, 12) ?? '(none)';

export async function syncFromContainer(opts: SyncOptions): Promise<SyncResult> {
  const runner = opts.runner ?? run;
  const git = (args: string[], cwd = opts.repo) => runner('git', [...HOST_GIT, ...args], { cwd, allowFailure: true, timeoutMs: 120_000 });
  const branch = opts.branch;
  const fmt = await git(['check-ref-format', `refs/heads/${branch}`]);
  if (fmt.code !== 0 || branch.startsWith('-')) throw new MinionsError('PRECONDITION', `--from-container: "${branch}" is not a valid branch name.`);
  const target = `refs/remotes/minions/${opts.baseBranch}`;

  const exported = opts.dryRun ? null : (await opts.exportRepo()).changes;
  const sha = async (ref: string) => {
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const to = await sha(target);
  if (!to) {
    throw new MinionsError('PRECONDITION', `--from-container: ${target} does not exist${opts.dryRun ? ' (no export yet; the dry run does not export)' : ' after the export'}.`,
      opts.dryRun ? 'Run `minions export` first to preview against the container state.' : `The container has no ${opts.baseBranch} branch to take.`);
  }
  const from = await sha(`refs/heads/${branch}`);
  if (!from) throw new MinionsError('PRECONDITION', `--from-container: the host has no branch ${branch}.`, `Create it first (git branch ${shellQuote(branch)} ${target}) or choose another branch.`);
  const base: Omit<SyncResult, 'action' | 'method' | 'applied'> = { branch, target, from, to, worktree: null, exported };
  if (from === to) return { ...base, action: 'up-to-date', method: null, applied: false };

  const isAncestor = async (a: string, b: string) => {
    const r = await git(['merge-base', '--is-ancestor', a, b]);
    if (r.code > 1) throw new MinionsError('INTERNAL', `git merge-base --is-ancestor failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return r.code === 0;
  };
  if (!(await isAncestor(from, to))) {
    if (await isAncestor(to, from)) return { ...base, to: from, action: 'ahead', method: null, applied: false };
    throw new MinionsError('CONFLICT',
      `--from-container: ${branch} (${short(from)}) and ${target} (${short(to)}) have diverged; refusing to move ${branch} (only strict fast-forwards are applied).`,
      `Nothing was changed. Merge or rebase yourself, e.g. \`git merge ${target}\` on ${branch}, then rerun \`minions upgrade\`.`);
  }

  // Where is the branch checked out? Every worktree of the repository counts, not only the main one.
  const wt = await git(['worktree', 'list', '--porcelain']);
  let worktree: string | null = null, current: string | null = null;
  for (const line of wt.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && current) { worktree = current; break; }
  }
  // Clean trees only: the repository's own worktree always, and the one that has the branch.
  for (const dir of [...new Set([opts.repo, ...(worktree ? [worktree] : [])])]) {
    const st = await git(['status', '--porcelain'], dir);
    if (st.code !== 0) throw new MinionsError('PRECONDITION', `--from-container: git status failed in ${dir}: ${(st.stderr || st.stdout).trim().slice(0, 300)}`);
    const dirty = st.stdout.split('\n').filter(Boolean);
    if (dirty.length) {
      throw new MinionsError('PRECONDITION',
        `--from-container: the working tree at ${dir} has uncommitted or untracked changes (${dirty.length}: ${dirty.slice(0, 5).map((l) => l.trim()).join(', ')}${dirty.length > 5 ? ', ...' : ''}); refusing to move ${branch}.`,
        'Nothing was changed. Commit or stash the changes yourself, then rerun `minions upgrade --from-container`.');
    }
  }
  const method = worktree ? 'merge --ff-only' as const : 'update-ref' as const;
  if (opts.dryRun) return { ...base, worktree, action: 'fast-forward', method, applied: false };

  const r = worktree
    ? await git(['merge', '--ff-only', '--no-edit', to], worktree)
    : await git(['update-ref', '-m', 'minions upgrade --from-container: fast-forward', `refs/heads/${branch}`, to, from]);
  if (r.code !== 0) {
    throw new MinionsError('CONFLICT', `--from-container: git ${method} on ${branch} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
      'The branch was not moved; check the repository and rerun.');
  }
  const now = await sha(`refs/heads/${branch}`);
  if (now !== to) throw new MinionsError('INTERNAL', `--from-container: ${branch} is at ${short(now)} after ${method}, expected ${short(to)}.`);
  return { ...base, worktree, action: 'fast-forward', method, applied: true };
}

export function syncStep(s: SyncResult, dryRun: boolean): SourceStep {
  const where = s.worktree ? `checked out at ${s.worktree}` : 'not checked out';
  if (s.action === 'up-to-date') return { id: 'sync', status: 'skipped', detail: `${s.branch} already at ${s.target} (${short(s.to)})` };
  if (s.action === 'ahead') return { id: 'sync', status: 'skipped', detail: `${s.branch} (${short(s.from)}) already contains ${s.target}; not moved` };
  return dryRun
    ? { id: 'sync', status: 'planned', detail: `export, then fast-forward ${s.branch} ${short(s.from)} -> ${short(s.to)} (${s.target}, as of the last export) with ${s.method} (${where})` }
    : { id: 'sync', status: 'done', detail: `fast-forwarded ${s.branch} ${short(s.from)} -> ${short(s.to)} with ${s.method} (${where})` };
}

// ---------------------------------------------------------------- cli (installed vs checkout)

export interface BuildStamp { version: string; source: string | null; kind: 'packed' | 'source' }
/** link: `npm install -g <dir>` (symlink); packed: install.sh tarball; git: git-URL install; unknown: a real directory without either stamp. */
export type InstallKind = 'link' | 'packed' | 'git' | 'unknown' | 'missing';

export interface InstalledCli {
  /** <npm root -g>/minions (null when npm is unavailable). */
  path: string | null;
  realPath: string | null;
  kind: InstallKind;
  version: string | null;
  stamp: BuildStamp | null;
  resolved: string | null;
  /** The running CLI is this install. */
  running: boolean;
}

export interface CliCheck {
  checkout: string;
  checkoutVersion: string | null;
  checkoutSource: string | null;
  installed: InstalledCli;
  differs: boolean;
  reason: string;
  /** rebuild/reinstall: done here, then the upgrade continues on the new CLI; manual: printed and stopped. */
  action: 'none' | 'rebuild' | 'reinstall' | 'manual';
  /** Exact shell command that brings the installed CLI to the checkout. */
  command: string | null;
}

const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; } };
const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
const GIT_SPEC = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:)|\.git(#|$)/;

/** True when `dir` holds a minions source checkout (package.json named minions plus src/cli.ts). */
export function isMinionsCheckout(dir: string): boolean {
  return readJson<{ name?: string }>(join(dir, 'package.json'))?.name === 'minions' && existsSync(join(dir, 'src', 'cli.ts'));
}

export async function detectInstalled(opts: { runner?: Runner; runningRoot?: string } = {}): Promise<InstalledCli> {
  const runner = opts.runner ?? run;
  const none: InstalledCli = { path: null, realPath: null, kind: 'missing', version: null, stamp: null, resolved: null, running: false };
  const rootR = await runner('npm', ['root', '-g'], { allowFailure: true, timeoutMs: 60_000 });
  const globalRoot = rootR.code === 0 ? rootR.stdout.trim().split('\n').at(-1)?.trim() : '';
  if (!globalRoot) return { ...none, kind: 'unknown' };
  const path = join(globalRoot, 'minions');
  let st;
  try { st = lstatSync(path); } catch { return { ...none, path }; }
  const realPath = real(path);
  const pj = realPath ? readJson<{ version?: string; _resolved?: string; _from?: string }>(join(realPath, 'package.json')) : null;
  const stamp = realPath ? readJson<BuildStamp>(join(realPath, 'dist', 'build.json')) : null;
  const ls = await runner('npm', ['ls', '-g', 'minions', '--json', '--long'], { allowFailure: true, timeoutMs: 60_000 });
  const lsData = (() => { try { return (JSON.parse(ls.stdout) as { dependencies?: { minions?: { resolved?: string } } }).dependencies?.minions ?? null; } catch { return null; } })();
  const resolved = lsData?.resolved ?? pj?._resolved ?? pj?._from ?? null;
  const kind: InstallKind = st.isSymbolicLink() ? 'link'
    : [lsData?.resolved, pj?._resolved, pj?._from].some((s) => !!s && GIT_SPEC.test(s)) ? 'git'
      : stamp?.kind === 'packed' ? 'packed' : 'unknown';
  const runningReal = opts.runningRoot ? real(opts.runningRoot) : null;
  return { path, realPath, kind, version: pj?.version ?? null, stamp, resolved, running: !!realPath && runningReal === realPath };
}

const missingDeps = (checkout: string) => BUILD_DEPS.filter((d) => !existsSync(join(checkout, 'node_modules', d, 'package.json')));

/** The manual sequence: build and pack the checkout, then replace the global install (uninstall first). */
export function manualReinstallCommand(checkout: string, version: string | null): string {
  return `cd ${shellQuote(checkout)} && npm ci && MINIONS_BUILD_KIND=packed npm pack && npm uninstall -g minions && npm install -g ./minions-${version ?? '<version>'}.tgz`;
}

export async function checkCli(opts: { checkout: string; runner?: Runner; runningRoot?: string; handoff?: boolean }): Promise<CliCheck> {
  const checkout = real(opts.checkout) ?? opts.checkout;
  const checkoutVersion = readJson<{ version?: string }>(join(checkout, 'package.json'))?.version ?? null;
  const checkoutSource = sourceFingerprint(checkout);
  const installed = await detectInstalled({ runner: opts.runner, runningRoot: opts.runningRoot });
  const base = { checkout, checkoutVersion, checkoutSource, installed };
  const differs = installed.kind === 'missing' || installed.version !== checkoutVersion || !installed.stamp?.source || installed.stamp.source !== checkoutSource;
  if (!differs) return { ...base, differs, reason: `installed minions ${installed.version} (${installed.kind}) matches the checkout (source ${checkoutSource})`, action: 'none', command: null };
  const reason = installed.kind === 'missing' ? 'minions is not installed globally'
    : installed.version !== checkoutVersion ? `installed ${installed.version ?? '(unknown)'} != checkout ${checkoutVersion}`
      : !installed.stamp?.source ? 'the installed CLI has no build stamp (dist/build.json)'
        : `installed source ${installed.stamp.source} != checkout ${checkoutSource}`;
  const manual = { ...base, differs, reason, action: 'manual' as const, command: manualReinstallCommand(checkout, checkoutVersion) };
  if (opts.handoff) return { ...manual, reason: `${reason}; still different after the reinstall` };
  if (installed.kind === 'link' && installed.realPath === checkout) {
    const deps = missingDeps(checkout);
    return { ...base, differs, reason, action: 'rebuild', command: `cd ${shellQuote(checkout)} && ${deps.length ? 'npm ci' : 'npm run build'}` };
  }
  if (installed.kind === 'packed') {
    const deps = missingDeps(checkout);
    return { ...base, differs, reason, action: 'reinstall',
      command: `cd ${shellQuote(checkout)} && ${deps.length ? 'npm ci && ' : ''}MINIONS_BUILD_KIND=packed npm pack && npm install -g ./minions-${checkoutVersion}.tgz` };
  }
  return manual;
}

/** Runs the rebuild/reinstall chosen by checkCli (npm in the checkout; the global prefix only for `install -g`). */
export async function applyCli(c: CliCheck, opts: { runner?: Runner; log?: (m: string) => void } = {}): Promise<void> {
  const runner = opts.runner ?? run;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (c.action === 'reinstall') env.MINIONS_BUILD_KIND = 'packed'; else delete env.MINIONS_BUILD_KIND;
  const npm = async (args: string[], cwd: string) => {
    opts.log?.(`cli: npm ${args.join(' ')} (in ${cwd})`);
    const r = await runner('npm', args, { cwd, env, allowFailure: true, timeoutMs: 1_800_000 });
    if (r.code !== 0) throw new MinionsError('INTERNAL', `npm ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    return r;
  };
  if (missingDeps(c.checkout).length) await npm(['ci', '--no-audit', '--no-fund'], c.checkout);
  if (c.action === 'rebuild') { await npm(['run', 'build'], c.checkout); return; }
  if (c.action !== 'reinstall') return;
  const dir = await mkdtemp(join(tmpdir(), 'minions-reinstall-'));
  try {
    await npm(['pack', '--pack-destination', dir], c.checkout);
    const tgz = join(dir, `minions-${c.checkoutVersion}.tgz`);
    if (!existsSync(tgz)) throw new MinionsError('INTERNAL', `npm pack did not produce ${tgz}.`);
    await npm(['install', '-g', '--no-audit', '--no-fund', tgz], dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function cliStep(c: CliCheck, dryRun: boolean): SourceStep {
  if (!c.differs) return { id: 'cli', status: 'skipped', detail: c.reason };
  const what = c.action === 'rebuild' ? 'rebuild the linked checkout' : 'reinstall from the checkout';
  if (c.action === 'manual') return { id: 'cli', status: dryRun ? 'planned' : 'failed', detail: `${c.reason}; ${c.installed.kind} install cannot be replaced safely by the running CLI: stop and print \`${c.command}\`` };
  return dryRun ? { id: 'cli', status: 'planned', detail: `${c.reason}; ${what} (${c.command}), then continue on the new CLI` }
    : { id: 'cli', status: 'done', detail: `${c.reason}; ${c.action === 'rebuild' ? 'rebuilt' : 'reinstalled'} (${c.command})` };
}

// ---------------------------------------------------------------- hand-off to the new CLI

/** Runs `node <cli> <args>` with stderr passed through and stdout captured (the --json envelope). */
export function spawnCli(cliPath: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, [HANDOFF_ENV]: '1' } });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr: '' }));
  });
}

// ---------------------------------------------------------------- the phase

export interface SourceStop { reason: string; command: string; rerun: string }

export interface SourcePhase<C = unknown> {
  steps: SourceStep[];
  /** False when a dry run found that the real run would refuse (the real run throws instead). */
  ok: boolean;
  sync: SyncResult | null;
  cli: CliCheck | null;
  /** Set when the upgrade must stop before the container steps (the printed command comes first). */
  stop: SourceStop | null;
  /** Result of the upgrade continued by the newly installed CLI (after a rebuild/reinstall). */
  continued: C | null;
}

export interface SourcePhaseOptions {
  /** --from-container sync; null when not requested. */
  sync: SyncOptions | null;
  /** The project checkout when it is a minions source checkout (else the CLI check is skipped). */
  checkout: string | null;
  dryRun?: boolean;
  runner?: Runner;
  /** Package root of the running CLI. */
  runningRoot?: string;
  /** This process already continues an upgrade after a reinstall: never reinstall again. */
  handoff?: boolean;
  /** Arguments that continue the upgrade on the new CLI, e.g. ['--json', 'upgrade', '--timeout', '60']. */
  continueArgs: string[];
  /** The human rerun command printed when the upgrade stops. */
  rerun: string;
  spawnCli?: (cliPath: string, args: string[]) => Promise<RunResult>;
  log?: (msg: string) => void;
}

export async function runSourcePhase<C>(opts: SourcePhaseOptions): Promise<SourcePhase<C>> {
  const log = opts.log ?? (() => undefined);
  const dryRun = !!opts.dryRun;
  const out: SourcePhase<C> = { steps: [], ok: true, sync: null, cli: null, stop: null, continued: null };
  const push = (s: SourceStep) => { out.steps.push(s); if (!dryRun) log(`${s.id}: ${s.detail}`); };

  if (opts.sync) {
    try {
      out.sync = await syncFromContainer({ ...opts.sync, dryRun, runner: opts.sync.runner ?? opts.runner });
      push(syncStep(out.sync, dryRun));
    } catch (e) {
      if (!dryRun || !(e instanceof MinionsError)) throw e;
      push({ id: 'sync', status: 'failed', detail: `would refuse: ${e.message}` });
      out.ok = false;
    }
  }
  if (!opts.checkout) {
    push({ id: 'cli', status: 'skipped', detail: 'the project repository is not a minions checkout; installed CLI not compared' });
    return out;
  }
  const check = () => checkCli({ checkout: opts.checkout!, runner: opts.runner, runningRoot: opts.runningRoot, handoff: opts.handoff });
  const c = out.cli = await check();
  push(cliStep(c, dryRun));
  if (!c.differs || dryRun) return out;
  if (c.action === 'manual') {
    out.stop = { reason: c.reason, command: c.command!, rerun: opts.rerun };
    return out;
  }
  try {
    await applyCli(c, { runner: opts.runner, log });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    out.steps[out.steps.length - 1] = { id: 'cli', status: 'failed', detail: `${c.reason}; ${c.action} failed: ${msg}` };
    out.stop = { reason: `${c.action} failed: ${msg}`, command: c.command!, rerun: opts.rerun };
    return out;
  }
  const after = await check();
  if (after.differs || !after.installed.realPath) {
    out.steps[out.steps.length - 1] = { id: 'cli', status: 'failed', detail: `${c.action} finished but ${after.reason}` };
    out.stop = { reason: `after the ${c.action}: ${after.reason}`, command: manualReinstallCommand(after.checkout, after.checkoutVersion), rerun: opts.rerun };
    return out;
  }
  out.cli = { ...c, installed: after.installed };
  const cliPath = join(after.installed.realPath, 'dist', 'cli.js');
  log(`cli: continuing the upgrade on the new CLI (${cliPath})`);
  const r = await (opts.spawnCli ?? spawnCli)(cliPath, opts.continueArgs);
  const line = r.stdout.trim().split('\n').filter(Boolean).at(-1) ?? '';
  let env: { ok?: boolean; data?: C; error?: { code?: string; message?: string; hint?: string } };
  try { env = JSON.parse(line) as typeof env; } catch {
    throw new MinionsError('INTERNAL', `The new CLI did not report a result (exit ${r.code}); the CLI is already updated.`, `Run \`${opts.rerun}\` to finish the upgrade.`, { steps: out.steps });
  }
  if (!env.ok) {
    const code = (env.error?.code ?? 'INTERNAL') as ConstructorParameters<typeof MinionsError>[0];
    throw new MinionsError(code, `Upgrade continued on the new CLI failed: ${env.error?.message ?? 'unknown error'}`, env.error?.hint ?? `The CLI is already updated; rerun \`${opts.rerun}\`.`, { steps: out.steps });
  }
  out.continued = env.data ?? null;
  return out;
}
