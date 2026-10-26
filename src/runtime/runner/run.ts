// The process runner `minions work run <leaseId>` (docs/design/agent-runtimes.md D3, D3a, D3b). Harness-
// independent: launch gate, run record, brief by proxy, per-lease clone, spawn under the isolation wrapper,
// supervision, post-exit checks and fetch-back, submit by proxy. `reapRun` drives recovery from the record.
//
// Architecture decisions (task-14.4):
// - Adapters are injected (`RunnerDeps.adapters`); production registers Codex (child task 4, gate plan first;
//   adapters.ts). The test-only `fake` adapter is never selectable from config.
// - The worker instructions carry the role's project prompt (task-14.6): inline `promptText`, else the copy the host
//   generated into the plugin's `harness-prompts/` (prompt files are resolved on the host only). An adapter may
//   normalize the result text (`normalizeResult`, e.g. Codex strict-schema nulls) before it is submitted.
// - A harness violation becomes a synthesized `blocked` result whose findings name it (terminal for the attempt;
//   the coordinator sees it in `work record`), plus a `harness-violation` event. Nothing is fetched.
// - The cancel mark is a separate file in the record dir (`cancel`), so the reaper never races the runner's own
//   record rewrites.
// - QA sweeps (base-branch leases) are refused for process harnesses: their branch moves with merges.
// - Isolation `none` exists only for tests (no minions-sandbox binary in CI); the CLI always uses the sandbox.
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { harnessBlock, isProcessHarness, phaseAllows, CURRENT_PHASE, DEFAULT_HARNESS_TIMEOUT_MINUTES, type PhaseRules, type HarnessId } from '../../config/harnesses.js';
import { baseRoleName, roleLimit, workerRole, type RoleDef } from '../../config/roles.js';
import { MAX_ROLE_PROMPT_BYTES, resolveRolePrompt } from '../../plugin/generate.js';
import type { MinionsConfig } from '../../config/schema.js';
import { MinionsError } from '../../core/errors.js';
import { redact } from '../../core/output.js';
import type { Lease, RuntimeDb } from '../db.js';
import { fetchBrief, scratchDirOf, submitResult, type HandoffPaths } from '../handoff.js';
import { runnerGit } from '../git-hardening.js';
import { assertBudgetAllowsStart, billingOf, recordLeaseUsage, type Billing } from '../spend.js';
import { leaseHarness, type TaskBrief } from '../scheduler.js';
import { buildSandboxRules, sandboxArgv, serializeRules, within } from '../sandbox/rules.js';
import { requireSandbox, type SelfTestReport } from '../sandbox/selftest.js';
import { checkPlanEnv, type LaunchPlan, type ProcessAdapter, type UsageEvent } from './adapter.js';
import {
  cancelMarked, createRunRecord, groupMembers, procStat, hostIdentity, isAlive, procIdentity, readRunRecord, runDir, sameHost, updateRunRecord, markCancel,
  type RunRecord, type RunRole, type HostIdentity,
} from './record.js';
import { branchRuleAndFetch, createClone, diffLeaseGit, restoreLeaseGit, sanitizeClone, sharedTarget, snapshotLeaseGit, wipCommit, writeNoFollow, type RepoContext } from './repo.js';
import { DEFAULT_TIMING, supervise, type StopReason, type SuperviseTiming } from './supervise.js';

export type Isolation =
  | { kind: 'sandbox'; bin?: string; protectedPaths: string[]; selfTest: () => Promise<SelfTestReport>; harnessDir?: string | null; toolchainDirs?: string[]; tcpConnectPorts?: number[] }
  /** Tests only: no L1 wrapper (the post-exit checks must still catch everything). */
  | { kind: 'none' };

export interface RunnerPaths extends HandoffPaths { state: string; secretsDir: string; drainFlag: string; scratch: string }

export interface RunnerDeps {
  db: RuntimeDb;
  config: MinionsConfig;
  paths: RunnerPaths;
  /** The shared repository's git dir (`<repo>/.git`). */
  commonDir: string;
  adapters: Readonly<Record<string, ProcessAdapter>>;
  isolation: Isolation;
  phase?: PhaseRules;
  /**
   * The generated plugin's `harness-prompts` dir: the resolved prompt of a process role whose `roles.<r>.prompt`
   * names a file (resolved on the host). Inline `promptText` needs none.
   */
  rolePromptDir?: string;
  /** The caller's environment and cwd (hints for honest callers: a worker must not start workers). */
  callerEnv?: NodeJS.ProcessEnv;
  callerCwd?: string;
  /** Base environment (PATH, LANG, the runner's own identity for the worker's clone). */
  env?: NodeJS.ProcessEnv;
  timing?: Partial<SuperviseTiming>;
  billing?: Billing;
  now?: () => Date;
  proc?: string;
}

export interface RunOutput {
  leaseId: string;
  exit: { code: number | null; signal: string | null; stopped: StopReason | null } | null;
  submitted: boolean;
  status: string | null;
  violations: string[];
  usage: { tokens: number; detail: Record<string, number> } | null;
  wipCommit: string | null;
  head: string | null;
  error?: string;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const inside = (dir: string, cwd: string) => { const r = relative(real(dir), real(cwd)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const deny = (msg: string, hint?: string) => new MinionsError('POLICY_DENIED', msg, hint);

// ------------------------------------------------------------------------------------------------- the gate

export interface GateOk { lease: Lease & { worktree: string; branch: string; head_sha: string }; def: RoleDef; harness: HarnessId; adapter: ProcessAdapter; brief: TaskBrief }

/**
 * D3.1, the launch gate (replaces preAgentHook for process harnesses). Fails closed: any unreadable input throws.
 * Capacity counts the active leases other than this one: this lease was counted when it was claimed.
 */
export async function assertRunAllowed(leaseId: string, deps: RunnerDeps): Promise<GateOk> {
  const { db, config } = deps;
  const callerEnv = deps.callerEnv ?? process.env;
  if (callerEnv.MINIONS_WORKER_LEASE) throw deny('A worker cannot start workers (MINIONS_WORKER_LEASE is set).');
  if (callerEnv.MINIONS_RUNTIME === 'host') throw new MinionsError('PRECONDITION', 'Process harnesses run only in the Docker runtime; the host runtime refuses them.', 'Switch with `minions runtime set docker`.');
  const active = db.activeLeases();
  const cwd = deps.callerCwd ?? process.cwd();
  if (active.some((l) => l.worktree && inside(l.worktree, cwd))) throw deny('`minions work run` is refused from inside a lease worktree (a worker cannot start workers).', 'Run it from the coordinator.');
  const lease = db.lease(leaseId);
  if (!lease) throw new MinionsError('NOT_FOUND', `Lease ${leaseId} does not exist.`);
  if (lease.status !== 'active') throw new MinionsError('CONFLICT', `Lease ${leaseId} already ended (${lease.status}).`);
  if (!lease.worktree || !lease.branch || !lease.head_sha) throw new MinionsError('PRECONDITION', `Lease ${leaseId} has no worktree, branch or claim head yet.`);
  const def = workerRole(config, lease.role);
  if (!def) throw new MinionsError('INVALID_CONFIG', `Lease ${leaseId} has role "${lease.role}", which is not a registered worker role.`);
  const harness = leaseHarness(lease);
  if (!isProcessHarness(harness)) throw new MinionsError('PRECONDITION', `Lease ${leaseId} (${lease.role}) runs on Claude Code: spawn it with the Agent tool, not \`work run\`.`);
  if (def.harness !== harness) throw new MinionsError('PRECONDITION', `Role ${def.name} now runs on ${def.harness}, but lease ${leaseId} was claimed on ${harness}.`, 'Release the lease and claim the task again.');
  const phase = deps.phase ?? CURRENT_PHASE;
  if (!phaseAllows(harness, def, phase)) throw deny(`Role ${def.name} cannot run on harness ${harness}: ${phase.summary}.`);
  if (!harnessBlock(config, harness)) throw new MinionsError('PRECONDITION', `Harness ${harness} has no harnesses.${harness} block.`);
  const adapter = deps.adapters[harness];
  if (!adapter) throw new MinionsError('PRECONDITION', `No adapter for harness ${harness} in this build.`, 'Process harness adapters ship with their own child tasks (agent-runtimes D6).');
  if (await readRunRecord(deps.paths.state, leaseId)) throw deny(`Lease ${leaseId} already has a run record: a lease runs at most once.`, 'Release the lease and claim the task again for a new attempt.');
  for (const other of db.leases({ taskId: lease.task_id, all: true })) {
    if (other.id === leaseId) continue;
    const r = await readRunRecord(deps.paths.state, other.id).catch(() => ({ phase: 'unreadable' } as const));
    if (r && r.phase !== 'done') throw deny(`Task ${lease.task_id} has an unfinished run (${other.id}, phase ${r.phase}): its post-exit checks must finish first.`, `Release ${other.id} so recovery reaps it.`);
  }
  // Same start rules as claim: drain, pause, budget.
  if (db.paused().starts) {
    const drain = db.drain();
    throw deny(drain ? `Starts are paused for a drain (${drain.reason}).` : 'Starts are paused (paused_starts).', drain ? undefined : 'Run `minions resume` to allow new work.');
  }
  assertBudgetAllowsStart({ db, billing: deps.billing ?? billingOf(), config, now: (deps.now ?? (() => new Date()))() });
  const others = active.filter((l) => l.id !== leaseId);
  const otherTasks = new Set(others.map((l) => l.task_id).filter((t) => t !== lease.task_id));
  if (otherTasks.size >= config.execution.maxActiveTasks) throw deny(`Active task limit reached without this lease (${otherTasks.size}/${config.execution.maxActiveTasks}).`);
  const limit = roleLimit(config, def.name);
  const sameRole = others.filter((l) => baseRoleName(config, l.role) === def.name).length;
  if (limit !== undefined && sameRole >= limit) throw deny(`Role ${def.name} limit reached without this lease (${sameRole}/${limit}).`);
  if (def.contract === 'producer' && phase.processProducerCap !== null) {
    const n = others.filter((l) => isProcessHarness(leaseHarness(l)) && (workerRole(config, l.role)?.contract ?? 'producer') === 'producer').length;
    if (n >= phase.processProducerCap) throw deny(`Process-harness producer cap reached without this lease (${n}/${phase.processProducerCap}; ${phase.summary}).`);
  }
  const brief = await fetchBrief(db, deps.paths, leaseId, { role: lease.role, cwd: lease.worktree });
  if (brief.kind === 'qa-sweep') throw new MinionsError('PRECONDITION', 'QA sweeps do not run on process harnesses yet.', `Set roles.${def.name}.harness to claude for sweeps.`);
  if (deps.isolation.kind === 'sandbox') requireSandbox(await deps.isolation.selfTest());
  return { lease: lease as GateOk['lease'], def, harness, adapter, brief };
}

// ----------------------------------------------------------------------------------------------- helpers

const runRole = (def: RoleDef): RunRole => ({ name: def.name, contract: def.contract, commits: def.commits, edits: def.edits, harness: def.harness });

/** The worker's commit identity: the runner's own (trusted) environment, else a neutral default. */
function workerIdentity(env: NodeJS.ProcessEnv): { name: string; email: string } {
  return { name: env.GIT_AUTHOR_NAME || env.GIT_COMMITTER_NAME || 'minions worker', email: env.GIT_AUTHOR_EMAIL || env.GIT_COMMITTER_EMAIL || 'minions-worker@minions.invalid' };
}

function repoContext(rec: RunRecord, deps: Pick<RunnerDeps, 'env' | 'paths'>): RepoContext {
  const env = deps.env ?? process.env;
  return {
    leaseId: rec.leaseId, branch: rec.branch, claimHead: rec.claimHead, leaseWorktree: rec.leaseWorktree, checkout: rec.checkout,
    globalConfig: join(runDir(deps.paths.state, rec.leaseId), 'gitconfig'), workerIdentity: workerIdentity(env), env,
  };
}

/** Reads a worker-written file without following symlinks, at most `max` bytes; null when absent or not a file. */
async function readWorkerFile(path: string, max = 1 << 20): Promise<string | null> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.size > max) return null;
  try {
    const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return await fh.readFile('utf8'); } finally { await fh.close(); }
  } catch { return null; }
}

function instructionsFor(brief: TaskBrief, rolePrompt: string | undefined): string {
  return [
    `You are the minions ${brief.role} for lease ${brief.leaseId}. Work only in ${brief.worktree} (your private clone of branch ${brief.branch}).`,
    'Your brief is in the file named by $MINIONS_BRIEF_FILE (also below). Do not run `minions work brief` or `minions work submit`:',
    'write exactly one WorkerResult JSON object to the file named by $MINIONS_RESULT_FILE before you finish.',
    `Result contract: ${brief.resultContract}`,
    ...(rolePrompt ? ['', 'Role instructions (from the project):', '', rolePrompt] : []),
    '',
    'Brief:',
    JSON.stringify(brief, null, 2),
  ].join('\n');
}

/** The project prompt of a process role: inline text, else the copy the host generated into the plugin. */
async function rolePromptOf(def: RoleDef, dir: string | undefined): Promise<string | undefined> {
  if (def.promptText !== undefined || def.prompt === undefined) return resolveRolePrompt(def);
  const text = dir ? await readWorkerFile(join(dir, `${def.name}.md`), MAX_ROLE_PROMPT_BYTES) : null;
  if (!text?.trim()) throw new MinionsError('PRECONDITION', `The prompt of role ${def.name} (${def.prompt}) is not in the generated plugin.`, 'Regenerate it with `minions start` on the host.');
  return text.trimEnd();
}

const isObjectJson = (s: string): boolean => { try { const v = JSON.parse(s) as unknown; return !!v && typeof v === 'object' && !Array.isArray(v); } catch { return false; } };

function synthesized(rec: RunRecord, head: string, status: 'blocked' | 'partial', summary: string, findings: string[], nextAction: string): string {
  return JSON.stringify({ status, summary, branch: rec.branch, headSha: head, modifiedPaths: [], checks: [], acceptanceEvidence: [], findings, nextAction }, null, 2) + '\n';
}

export interface PostExit { violations: string[]; head: string; fetched: boolean; wipCommit: string | null }

/**
 * D3.7.1 to 7.5: lease git files against the snapshot (restored on a difference), the clone sanitized, an optional
 * `wip:` commit, the branch rule and the fast-forward-only fetch-back. Any violation means nothing is fetched.
 */
export async function postExit(rec: RunRecord, deps: Pick<RunnerDeps, 'env' | 'paths'>, wip: string | null): Promise<PostExit> {
  const snap = rec.leaseGit;
  if (!snap) return { violations: [], head: rec.claimHead, fetched: false, wipCommit: null };
  const ctx = repoContext(rec, deps);
  const violations: string[] = [];
  const changed = await diffLeaseGit(snap);
  if (changed.length) {
    violations.push(`lease git files changed: ${changed.join(', ')}`);
    await restoreLeaseGit(snap, changed);
    const still = await diffLeaseGit(snap);
    if (still.length) throw new MinionsError('INTERNAL', `could not restore the lease git files: ${still.join(', ')}`);
  }
  violations.push(...await sanitizeClone(ctx, snap.commonDir));
  if (violations.length) return { violations, head: rec.claimHead, fetched: false, wipCommit: null };
  const role = rec.role;
  const wipHead = wip ? await wipCommit(ctx, role, wip) : null;
  const fb = await branchRuleAndFetch(ctx, snap, role);
  return { violations: fb.violations, head: fb.head, fetched: fb.fetched, wipCommit: fb.fetched ? wipHead : null };
}

// -------------------------------------------------------------------------------------------------- runLease

/** `minions work run <leaseId>`: runs one process worker to the end and submits its result by proxy. */
export async function runLease(leaseId: string, deps: RunnerDeps): Promise<RunOutput> {
  const gate = await assertRunAllowed(leaseId, deps);
  const { lease, def, adapter, harness } = gate;
  const proc = deps.proc ?? '/proc';
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const scratch = scratchDirOf(deps.paths, leaseId)!;
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const sst = await lstat(scratch);
  if (sst.isSymbolicLink() || !sst.isDirectory()) throw new MinionsError('PRECONDITION', `${scratch} is not a real directory.`);
  const block = harnessBlock(deps.config, harness)!;
  const timing: SuperviseTiming = { ...DEFAULT_TIMING, timeoutMs: (block.timeoutMinutes ?? DEFAULT_HARNESS_TIMEOUT_MINUTES) * 60_000, ...deps.timing };
  const host = await hostIdentity(proc);
  const at = now().toISOString();
  let rec: RunRecord = {
    version: 1, leaseId, taskId: lease.task_id, role: runRole(def), branch: lease.branch, claimHead: lease.head_sha, leaseWorktree: lease.worktree,
    scratchDir: scratch, checkout: join(scratch, 'work'), host, runner: await procIdentity(process.pid, proc), wrapper: null, pgid: null,
    phase: 'prepared', leaseGit: null, deadline: null, createdAt: at, updatedAt: at,
  };
  const dir = await createRunRecord(deps.paths.state, rec);
  const state = deps.paths.state;
  const update = async (patch: Partial<RunRecord>) => (rec = await updateRunRecord(state, rec, patch, now()));
  const out: RunOutput = { leaseId, exit: null, submitted: false, status: null, violations: [], usage: null, wipCommit: null, head: null };
  const usageEvents: UsageEvent[] = [];
  let finalMessage: string | null = null;
  try {
    await writeFile(join(dir, 'gitconfig'), '', { mode: 0o600, flag: 'wx' });
    const snap = await snapshotLeaseGit(lease.worktree, deps.commonDir, lease.head_sha);
    const ctx = repoContext(rec, deps);
    const shared = await runnerGit(sharedTarget(snap), ['rev-parse', '--verify', '--quiet', `refs/heads/${lease.branch}`], true, { globalConfig: ctx.globalConfig, env });
    if (shared.stdout.trim() !== lease.head_sha) throw new MinionsError('PRECONDITION', `Branch ${lease.branch} moved since the claim (${shared.stdout.trim() || 'missing'} vs ${lease.head_sha}).`, 'Release the lease and claim the task again.');
    await update({ leaseGit: snap });
    await createClone(ctx, snap, join(dir, 'template'));

    const harnessHome = join(scratch, 'harness-home');
    const tmpDir = join(scratch, 'tmp');
    await mkdir(harnessHome, { recursive: true, mode: 0o700 });
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const briefFile = join(scratch, 'brief.json');
    const resultFile = join(scratch, 'result.json');
    const workerBrief = { ...gate.brief, worktree: rec.checkout, leaseWorktree: lease.worktree, scratchDir: scratch };
    await writeNoFollow(briefFile, JSON.stringify(workerBrief, null, 2) + '\n', 0o600);
    const plan: LaunchPlan = adapter.plan({
      lease: { id: leaseId, taskId: lease.task_id, role: lease.role, attempt: lease.attempt }, role: { name: def.name, contract: def.contract, edits: def.edits, commits: def.commits },
      checkout: rec.checkout, leaseWorktree: lease.worktree, gitObjectsDir: join(snap.commonDir, 'objects'), scratchDir: scratch, harnessHome,
      instructions: instructionsFor(workerBrief, await rolePromptOf(def, deps.rolePromptDir)), briefFile, resultFile, model: gate.brief.model ?? null, effort: gate.brief.effort ?? null,
      maxSteps: gate.brief.maxTurns, credential: null,
    });
    checkPlanEnv([...Object.keys(plan.env), ...Object.keys(plan.secretEnv)]);
    for (const f of plan.files) {
      if (!isAbsolute(f.path) || !within(f.path, scratch)) throw new MinionsError('INTERNAL', `adapter plan writes outside the scratch dir: ${f.path}`);
      await mkdir(dirname(f.path), { recursive: true, mode: 0o700 });
      await writeNoFollow(f.path, f.content, f.mode);
    }
    const secrets: Record<string, string> = {};
    for (const [name, kind] of Object.entries(plan.secretEnv)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(kind)) throw new MinionsError('INTERNAL', `adapter plan names an invalid credential kind ${JSON.stringify(kind)}`);
      const value = (await readWorkerFile(join(deps.paths.secretsDir, kind), 64 * 1024))?.trim();
      if (!value) throw new MinionsError('PRECONDITION', `No ${kind} credential is set up for harness ${harness}.`, `Add it on the host (\`minions auth ${harness}\`).`);
      secrets[name] = value;
    }
    const childEnv: Record<string, string> = {
      PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: harnessHome, TMPDIR: tmpDir, LANG: env.LANG ?? 'C.UTF-8', TERM: 'dumb',
      MINIONS_WORKER_LEASE: leaseId, MINIONS_ROLE: lease.role, MINIONS_BRIEF_FILE: briefFile, MINIONS_RESULT_FILE: resultFile,
      ...plan.env, ...secrets,
    };
    let argv = plan.argv;
    const secretValues = Object.values(secrets);
    if (deps.isolation.kind === 'sandbox') {
      const iso = deps.isolation;
      const rules = buildSandboxRules({
        role: { name: def.name, contract: def.contract, harness }, leaseId,
        layout: { scratchDir: scratch, gitObjectsDir: join(snap.commonDir, 'objects'), harnessDir: iso.harnessDir ?? null, ...(iso.toolchainDirs ? { toolchainDirs: iso.toolchainDirs } : {}) },
        tcpConnectPorts: iso.tcpConnectPorts ?? deps.config.harnesses?.network?.tcpConnectPorts,
        protectedPaths: [...iso.protectedPaths, lease.worktree],
      });
      const rulesFile = join(dir, 'rules.json');
      await writeFile(rulesFile, serializeRules(rules), { mode: 0o600 });
      argv = sandboxArgv(rulesFile, plan.argv, { ...(iso.bin ? { bin: iso.bin } : {}), scratchDir: scratch, secretValues });
    } else if (secretValues.some((s) => s.length >= 4 && argv.some((a) => a.includes(s)))) {
      throw new MinionsError('INTERNAL', 'refusing to start a process harness with a secret in its argv; pass it through the environment', 'This is a bug in the harness adapter plan.');
    }

    await update({ deadline: new Date(now().getTime() + timing.timeoutMs).toISOString() });
    const sup = await supervise({ argv, cwd: rec.checkout, env: childEnv, stdin: plan.stdin }, timing, {
      onSpawn: async (pid) => { await update({ wrapper: await procIdentity(pid, proc), pgid: pid, phase: 'running' }); },
      onLine: (line) => {
        const ev = adapter.parseEvent?.(line);
        if (ev?.usage) usageEvents.push(ev.usage);
        if (ev?.finalMessage !== undefined) finalMessage = ev.finalMessage;
      },
      poll: async () => {
        const l = deps.db.lease(leaseId);
        if (!l || l.status !== 'active') return 'lease-ended';
        if (await cancelMarked(state, leaseId)) return 'cancel';
        if (deps.db.drain() || await lstat(deps.paths.drainFlag).then(() => true, () => false)) return 'drain';
        return null;
      },
    });
    out.exit = { code: sup.code, signal: sup.signal, stopped: sup.stopped };
    // Recovery (reapRun) took the record over while this runner looked dead or stuck: it owns post-exit now.
    const cur = await readRunRecord(state, leaseId).catch(() => null);
    if (!cur || cur.phase === 'done' || cur.runner?.pid !== rec.runner?.pid || cur.runner?.startTime !== rec.runner?.startTime) {
      out.error = 'the run was taken over by recovery (reapRun); nothing submitted';
      return out;
    }
    await update({ phase: 'post-exit' });
    const stoppedEarly = sup.stopped === 'drain' || sup.stopped === 'timeout' || sup.stopped === 'cancel' || sup.stopped === 'lease-ended';
    const post = await postExit(rec, deps, stoppedEarly ? (sup.stopped as string) : null);
    out.violations = post.violations; out.head = post.head; out.wipCommit = post.wipCommit;
    out.usage = (adapter.finalUsage ?? (() => null))(usageEvents);

    let raw: string | null = null;
    if (post.violations.length) {
      deps.db.addEvent('harness-violation', lease.task_id, { leaseId, harness, violations: post.violations });
      raw = synthesized(rec, post.head, 'blocked', `The process runner found a harness violation (${harness}); nothing was fetched.`,
        post.violations.map((v) => `harness-violation: ${v}`), 'Terminal for this attempt: inspect the violation before dispatching the task again.');
    } else if (sup.stopped === 'drain' || sup.stopped === 'timeout') {
      raw = synthesized(rec, post.head, 'partial', `Stopped by the runner (${sup.stopped})${post.wipCommit ? `; work in progress is committed as ${post.wipCommit}` : '; nothing to commit'}.`,
        [`runner: ${sup.stopped === 'drain' ? 'drain' : `wall-clock limit of ${Math.round(timing.timeoutMs / 1000)} s`} reached`], 'Continue from the wip: commit on the branch.');
    } else {
      const fromFile = await readWorkerFile(join(scratch, 'result.json'));
      const fm = finalMessage as string | null;
      const norm = (t: string | null) => (t && adapter.normalizeResult ? adapter.normalizeResult(t) : t);
      const file = norm(fromFile);
      const final = norm(fm);
      raw = file && isObjectJson(file) ? file : final && isObjectJson(final) ? final : null;
      if (!raw) {
        const tail = redact(sup.stderrTail).slice(-2048);
        raw = synthesized(rec, post.head, 'blocked', `The ${harness} worker ended without a result (exit ${sup.code ?? sup.signal ?? sup.spawnError ?? 'unknown'}).`,
          [`runner: no WorkerResult in $MINIONS_RESULT_FILE or the final message`, ...(sup.spawnError ? [`spawn: ${redact(sup.spawnError)}`] : []), ...(tail.trim() ? [`stderr: ${tail}`] : [])],
          'Inspect the worker output and dispatch the task again.');
      }
    }
    const l = deps.db.lease(leaseId);
    if (l?.status === 'active' && raw) {
      await submitResult(deps.db, deps.paths, leaseId, raw, { role: lease.role, cwd: lease.worktree });
      out.submitted = true;
      try { out.status = (JSON.parse(raw) as { status?: string }).status ?? null; } catch { out.status = null; }
    }
    if (out.usage) recordLeaseUsage(deps.db, leaseId, { tokens: out.usage.tokens, model: gate.brief.model ?? null, source: 'runner', harness });
    await update({ phase: 'done', outcome: { status: out.status, submitted: out.submitted, wipCommit: out.wipCommit, violations: out.violations, head: out.head, reason: sup.stopped ?? 'exit' } });
    return out;
  } catch (e) {
    const msg = (e as Error).message;
    out.error = redact(msg).slice(0, 500);
    if (rec.pgid) { try { process.kill(-rec.pgid, 'SIGKILL'); } catch { /* gone */ } }
    const l = deps.db.lease(leaseId);
    if (l?.status === 'active') {
      const raw = synthesized(rec, rec.claimHead, 'blocked', `The process runner failed: ${out.error}`, [`runner: ${out.error}`], 'Fix the cause and dispatch the task again.');
      await submitResult(deps.db, deps.paths, leaseId, raw, { role: lease.role, cwd: lease.worktree }).then(() => { out.submitted = true; out.status = 'blocked'; }, () => undefined);
    }
    // A failure during post-exit leaves the record for recovery; before the spawn there is nothing to reap.
    if (rec.phase === 'prepared') await update({ phase: 'done', outcome: { status: out.status, submitted: out.submitted, wipCommit: null, violations: [], head: rec.claimHead, reason: 'error' } }).catch(() => undefined);
    return out;
  }
}

// --------------------------------------------------------------------------------------------------- reapRun

export interface ReapOutcome { leaseId: string; action: 'none' | 'cancelled' | 'recovered'; killed: number[]; post: PostExit | null; note: string | null }

/**
 * D3b: recovery driven by the run record, before a lease ends or a task is re-dispatched. Nothing to do for no
 * record or `done`. A live runner gets a cancel mark and `waitMs` to finish. Otherwise (or on timeout) the recorded
 * runner, wrapper and process group are killed (each checked against its recorded start time; skipped for a record
 * from another boot or container start), post-exit runs with a drain-style `wip:` commit, and the record is `done`.
 */
export async function reapRun(leaseId: string, deps: Pick<RunnerDeps, 'env' | 'paths' | 'db' | 'proc' | 'now'> & { waitMs?: number; pollMs?: number }): Promise<ReapOutcome> {
  const state = deps.paths.state;
  const proc = deps.proc ?? '/proc';
  let rec = await readRunRecord(state, leaseId);
  if (!rec || rec.phase === 'done') return { leaseId, action: 'none', killed: [], post: null, note: null };
  const host: HostIdentity | null = await hostIdentity(proc);
  const live = sameHost(rec.host, host);
  if (live && await isAlive(rec.runner, proc)) {
    await markCancel(state, leaseId, 'reap');
    const until = Date.now() + (deps.waitMs ?? 60_000);
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 500));
      rec = (await readRunRecord(state, leaseId))!;
      if (rec.phase === 'done') return { leaseId, action: 'cancelled', killed: [], post: null, note: null };
    }
  }
  const killed: number[] = [];
  if (live) {
    for (const p of [rec.runner, rec.wrapper]) {
      if (p && p.pid !== process.pid && await isAlive(p, proc)) { try { process.kill(p.pid, 'SIGKILL'); killed.push(p.pid); } catch { /* gone */ } }
    }
    if (rec.pgid && rec.wrapper) {
      for (const pid of await groupMembers(rec.pgid, rec.wrapper.startTime, proc)) {
        if (pid === process.pid) continue;
        try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch { /* gone */ }
      }
    }
    // Wait (bounded) until every killed process is gone before post-exit touches the clone.
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const states = await Promise.all(killed.map((pid) => procStat(pid, proc)));
      if (states.every((x) => !x || x.state === 'Z')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const post = rec.leaseGit ? await postExit(rec, deps, 'recovered: runner lost') : null;
  if (post?.violations.length) deps.db.addEvent('harness-violation', rec.taskId, { leaseId, harness: rec.role.harness, violations: post.violations, recovered: true });
  const note = post?.wipCommit ? `recovered: runner lost; work in progress is committed as ${post.wipCommit}` : 'recovered: runner lost';
  await updateRunRecord(state, rec, { phase: 'done', outcome: { status: null, submitted: false, wipCommit: post?.wipCommit ?? null, violations: post?.violations ?? [], head: post?.head ?? rec.claimHead, reason: 'recovered' } }, (deps.now ?? (() => new Date()))());
  return { leaseId, action: 'recovered', killed, post, note };
}
