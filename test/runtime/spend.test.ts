import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import type { MinionsError } from '../../src/core/errors.js';
import { collectStatus, humanStatus, register as registerRuntime, spendCommand } from '../../src/runtime/commands.js';
import { RuntimeDb } from '../../src/runtime/db.js';
import { stopHook } from '../../src/runtime/hooks.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import {
  billingOf, budgetNotice, currentBudget, parseBudget, parseTokens, recordLeaseUsage, setBudget, spendReport, usdPerMTok,
} from '../../src/runtime/spend.js';
import { commitFile, makeEnv, result, type Env } from './fixtures.js';

const errOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a rejection');
};

/** A scheduler over the same state with a chosen billing and clock. */
const schedWith = (env: Env, o: { billing?: 'api-key' | 'subscription'; now?: () => Date } = {}) =>
  new Scheduler({ db: env.db, backlog: env.backlog, config: env.config, layout: env.layout, billing: o.billing ?? 'subscription', now: o.now });

async function engineerRecord(env: Env, sched: Scheduler, id: string, usage?: { tokens: number; model?: string }) {
  const brief = await sched.claim(id, 'engineer');
  const head = commitFile(brief.worktree, `${id}.txt`, `work ${Math.random()}`);
  const r = await sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }), { usage });
  return { brief, head, r };
}

describe('budget and token parsing', () => {
  it('reads token counts with separators and suffixes', () => {
    expect(parseTokens('135947')).toBe(135947);
    expect(parseTokens('135,947')).toBe(135947);
    expect(parseTokens('135k')).toBe(135000);
    expect(parseTokens('1.5M')).toBe(1_500_000);
    expect(parseTokens('2 million tokens')).toBe(2_000_000);
    expect(() => parseTokens('lots')).toThrow(/Not a token count/);
    expect(() => parseTokens('-5')).toThrow();
  });

  it('reads budgets in plain language', () => {
    expect(parseBudget('5M tokens')).toEqual({ limit: 5_000_000, unit: 'tokens', period: 'since-set' });
    expect(parseBudget('stop at 500k tokens per day')).toEqual({ limit: 500_000, unit: 'tokens', period: 'day' });
    expect(parseBudget('3000000')).toEqual({ limit: 3_000_000, unit: 'tokens', period: 'since-set' });
    expect(parseBudget('$50')).toEqual({ limit: 50, unit: 'usd', period: 'since-set' });
    expect(parseBudget('12.50 USD daily')).toEqual({ limit: 12.5, unit: 'usd', period: 'day' });
    expect(parseBudget('$1,000')).toEqual({ limit: 1000, unit: 'usd', period: 'since-set' });
    expect(parseBudget('20 attempts')).toEqual({ limit: 20, unit: 'attempts', period: 'since-set' });
    expect(parseBudget('off')).toBeNull();
    expect(() => parseBudget('a lot')).toThrow(/Cannot read the budget/);
    expect(() => parseBudget('0 tokens')).toThrow(/positive/);
  });

  it('billing follows MINIONS_AUTH_METHOD; prices are per model family', () => {
    expect(billingOf({ MINIONS_AUTH_METHOD: 'api-key' })).toBe('api-key');
    expect(billingOf({ MINIONS_AUTH_METHOD: 'helper' })).toBe('api-key');
    expect(billingOf({ MINIONS_AUTH_METHOD: 'login' })).toBe('subscription');
    expect(billingOf({})).toBe('subscription');
    expect(usdPerMTok('sonnet')).toBe(3);
    expect(usdPerMTok('claude-opus-4-5')).toBe(5);
    expect(usdPerMTok('claude-opus-4-1-20250805')).toBe(15);
    expect(usdPerMTok('haiku')).toBe(1);
    expect(usdPerMTok('mystery')).toBeNull();
    expect(usdPerMTok(null)).toBeNull();
  });
});

describe('durable usage tally', () => {
  it('stores --usage per attempt, survives a restart, and shows total/today/per task in status', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const sched = schedWith(env);
    const a = await engineerRecord(env, sched, 'task-1', { tokens: 135947, model: 'sonnet' });
    expect(a.r.valid).toBe(true);
    expect(a.r.usage).toEqual({ tokens: 135947, model: 'sonnet', source: 'record' });
    expect(a.r.budget).toBeUndefined();
    await engineerRecord(env, sched, 'task-2', { tokens: 20000 });

    // A coordinator restart: a fresh connection to the same database file sees the same tally.
    const reopened = new RuntimeDb(env.db.path);
    const s = spendReport({ db: reopened, billing: 'subscription' });
    expect(s.total.tokens).toBe(155947);
    expect(s.total.attempts).toBe(2);
    expect(s.today.tokens).toBe(155947);
    expect(s.total.estimatedUsd).toBeUndefined(); // subscription: tokens only
    expect(s.notes.join(' ')).toMatch(/remaining plan quota .* not visible/);
    expect(s.perTask).toEqual([
      { taskId: 'task-1', tokens: 135947, attempts: 1 },
      { taskId: 'task-2', tokens: 20000, attempts: 1 },
    ]);
    reopened.close();

    // Billing is read from the environment: pin it so a host's MINIONS_AUTH_METHOD cannot change the line.
    vi.stubEnv('MINIONS_AUTH_METHOD', 'subscription');
    let status;
    try { status = await collectStatus({ db: env.db, config: env.config, backlog: async () => env.backlog }); } finally { vi.unstubAllEnvs(); }
    expect(status.spend?.total.tokens).toBe(155947);
    expect(status.spend?.budget).toBeNull();
    expect(humanStatus(status)).toMatch(/spend \(subscription\): total 155,947 tokens, 2 attempt\(s\)/);
  });

  it('a correction replaces the earlier cumulative figure instead of double-counting', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const sched = schedWith(env);
    const brief = await sched.claim('task-1', 'engineer');
    const head = commitFile(brief.worktree, 'a.txt', 'x');
    const bad = await sched.record(brief.leaseId, result({ branch: brief.branch, headSha: '0'.repeat(40) }), { usage: { tokens: 100_000 } });
    expect(bad.valid).toBe(false);
    expect(spendReport({ db: env.db, billing: 'subscription' }).total.tokens).toBe(100_000); // kept even when rejected
    const ok = await sched.record(brief.leaseId, result({ branch: brief.branch, headSha: head }), { correction: true, usage: { tokens: 130_000 } });
    expect(ok.valid).toBe(true);
    const s = spendReport({ db: env.db, billing: 'subscription' });
    expect(s.total.tokens).toBe(130_000);
    expect(s.perTask).toEqual([{ taskId: 'task-1', tokens: 130_000, attempts: 1 }]);
  });

  it('falls back to the result usage block when no --usage is given; --usage wins over it', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    const sched = schedWith(env);
    const b1 = await sched.claim('task-1', 'engineer');
    const h1 = commitFile(b1.worktree, 'a.txt', 'x');
    const r1 = await sched.record(b1.leaseId, result({ branch: b1.branch, headSha: h1, usage: { inputTokens: 1000, outputTokens: 500, model: 'opus' } }));
    expect(r1.usage).toEqual({ tokens: 1500, model: 'opus', source: 'result' });
    const b2 = await sched.claim('task-2', 'engineer');
    const h2 = commitFile(b2.worktree, 'b.txt', 'y');
    const r2 = await sched.record(b2.leaseId, result({ branch: b2.branch, headSha: h2, usage: { totalTokens: 9 } }), { usage: { tokens: 7000 } });
    expect(r2.usage).toEqual({ tokens: 7000, model: null, source: 'record' });
    expect(spendReport({ db: env.db, billing: 'subscription' }).total.tokens).toBe(8500);
  });

  it('release records usage; a figure added after the record (work spend --lease) replaces it; the coordinator session counts', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const sched = schedWith(env);
    const brief = await sched.claim('task-1', 'engineer');
    const rel = await sched.release(brief.leaseId, 'worker died', { usage: { tokens: 4000 } });
    expect(rel.usage?.tokens).toBe(4000);
    recordLeaseUsage(env.db, brief.leaseId, { tokens: 5000, source: 'manual' });
    const out = await spendCommand({ session: 'sess-1', tokens: '50k' }, { db: env.db, config: env.config });
    expect(out.coordinator.tokens).toBe(50_000);
    expect(out.total.tokens).toBe(55_000);
    expect(out.perTask).toEqual([expect.objectContaining({ taskId: 'task-1', tokens: 5000, attempts: 1 })]);
    // The session figure is cumulative too.
    expect((await spendCommand({ session: 'sess-1', tokens: '60000' }, { db: env.db, config: env.config })).coordinator.tokens).toBe(60_000);
    await expect(spendCommand({ tokens: '5' }, { db: env.db, config: env.config })).rejects.toThrow(/--lease <leaseId> or --session/);
    await expect(spendCommand({ lease: brief.leaseId }, { db: env.db, config: env.config })).rejects.toThrow(/need --tokens/);
    await expect(spendCommand({ lease: 'lease-nope', tokens: '5' }, { db: env.db, config: env.config })).rejects.toThrow(/does not exist/);
  });

  it('today counts only what was spent since the UTC day start', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    const brief = await schedWith(env).claim('task-1', 'engineer');
    recordLeaseUsage(env.db, brief.leaseId, { tokens: 1000, source: 'record' });
    env.db.exec("UPDATE events SET at = '2000-01-01T10:00:00.000Z' WHERE kind = 'usage'");
    recordLeaseUsage(env.db, brief.leaseId, { tokens: 1600, source: 'manual' });
    const s = spendReport({ db: env.db, billing: 'subscription' });
    expect(s.total.tokens).toBe(1600);
    expect(s.today.tokens).toBe(600);
  });

  it('API-key billing adds a rough USD estimate per model', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    await engineerRecord(env, schedWith(env, { billing: 'api-key' }), 'task-1', { tokens: 2_000_000, model: 'sonnet' });
    const s = spendReport({ db: env.db, billing: 'api-key', config: env.config });
    expect(s.billing).toBe('api-key');
    expect(s.total.estimatedUsd).toBe(6);
    expect(s.notes.join(' ')).toMatch(/rough estimate.*Console usage page/);
  });
});

describe('owner budget', () => {
  it('warns once at 50% and 80%, refuses new claims at 100% and leaves running work alone', async () => {
    const env = makeEnv((c) => { c.execution.maxActiveTasks = 5; c.execution.maxEngineers = 5; });
    for (const id of ['task-1', 'task-2', 'task-3', 'task-4', 'task-5']) env.backlog.add({ id });
    const sched = schedWith(env);
    expect(setBudget({ db: env.db, billing: 'subscription' }, '100k tokens', 'owner')?.percent).toBe(0);

    const running = await sched.claim('task-5', 'engineer'); // started before the limit

    const r1 = (await engineerRecord(env, sched, 'task-1', { tokens: 55_000 })).r;
    expect(r1.budget).toMatchObject({ crossed: 50, percent: 55, used: 55_000, limit: 100_000, exhausted: false });
    expect(r1.budget?.message).toMatch(/Budget 50% reached/);
    const r2 = (await engineerRecord(env, sched, 'task-2', { tokens: 10_000 })).r;
    expect(r2.budget?.crossed).toBeNull(); // 65%: 50% already reported
    const r3 = (await engineerRecord(env, sched, 'task-3', { tokens: 20_000 })).r;
    expect(r3.budget?.crossed).toBe(80);

    // The running lease's notification arrives: it pushes the spend over the limit.
    const head = commitFile(running.worktree, 'r.txt', 'r');
    const r4 = await sched.record(running.leaseId, result({ branch: running.branch, headSha: head }), { usage: { tokens: 30_000 } });
    expect(r4.valid).toBe(true); // running work is recorded as usual
    expect(r4.budget).toMatchObject({ crossed: 100, exhausted: true });
    expect(r4.budget?.message).toMatch(/Budget reached: .*New claims are refused; running workers continue/);

    const e = await errOf(sched.claim('task-4', 'engineer'));
    expect(e.code).toBe('POLICY_DENIED');
    expect(e.message).toMatch(/^Budget reached: 115,000 tokens of 100,000 tokens since .* \(115%; budget "100k tokens"\)/);
    expect(e.hint).toMatch(/--budget/);
    expect(env.backlog.status('task-4')).toBe('ready');

    const status = await collectStatus({ db: env.db, config: env.config, backlog: async () => env.backlog });
    expect(status.spend?.budget).toMatchObject({ exhausted: true, percent: 115, unit: 'tokens', setBy: 'owner' });
    expect(status.spend?.percent).toBe(115);
    expect(humanStatus(status)).toMatch(/budget: .* - new starts refused/);

    // The stop hook lets the coordinator stop instead of looping on refused claims.
    const stop = await stopHook({}, () => ({ db: env.db, backlog: env.backlog, config: env.config }));
    expect(stop.stdout).toBeUndefined();
    expect(env.db.guard().last_reason).toBe('budget');

    // Raising the budget lets work start again; the new budget counts from when it was set.
    await spendCommand({ budget: '1M tokens', by: 'owner' }, { db: env.db, config: env.config });
    expect(currentBudget({ db: env.db })).toMatchObject({ used: 0, exhausted: false });
    await sched.claim('task-4', 'engineer');
    // Clearing it removes the budget.
    expect((await spendCommand({ budget: 'off' }, { db: env.db, config: env.config })).budget).toBeNull();
  });

  it('an attempts budget counts claims', async () => {
    const env = makeEnv((c) => { c.execution.maxActiveTasks = 5; c.execution.maxEngineers = 5; });
    for (const id of ['task-1', 'task-2', 'task-3']) env.backlog.add({ id });
    const sched = schedWith(env);
    setBudget({ db: env.db, billing: 'subscription' }, '2 attempts');
    await sched.claim('task-1', 'engineer');
    await sched.claim('task-2', 'engineer');
    expect((await errOf(sched.claim('task-3', 'engineer'))).message).toMatch(/Budget reached: 2 attempt\(s\) of 2 attempt\(s\)/);
  });

  it('a daily budget resets on the next UTC day, and so do the threshold reports', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    let now = new Date();
    const sched = schedWith(env, { now: () => now });
    setBudget({ db: env.db, billing: 'subscription', now }, '10k tokens per day');
    const r = (await engineerRecord(env, sched, 'task-1', { tokens: 12_000 })).r;
    expect(r.budget).toMatchObject({ crossed: 100, exhausted: true, period: 'day' });
    expect((await errOf(sched.claim('task-2', 'engineer'))).code).toBe('POLICY_DENIED');
    now = new Date(now.getTime() + 24 * 3600 * 1000);
    expect(currentBudget({ db: env.db, now })).toMatchObject({ used: 0, exhausted: false });
    expect(budgetNotice({ db: env.db, now })?.crossed).toBeNull();
    await sched.claim('task-2', 'engineer');
  });

  it('a USD budget needs API-key billing and compares the estimate', async () => {
    const env = makeEnv();
    env.backlog.add({ id: 'task-1' });
    env.backlog.add({ id: 'task-2' });
    expect(() => setBudget({ db: env.db, billing: 'subscription' }, '$50')).toThrow(/needs API-key billing/);
    const sched = schedWith(env, { billing: 'api-key' });
    setBudget({ db: env.db, billing: 'api-key', config: env.config }, '$5');
    const r = (await engineerRecord(env, sched, 'task-1', { tokens: 2_000_000, model: 'sonnet' })).r;
    expect(r.budget).toMatchObject({ unit: 'usd', used: 6, exhausted: true });
    expect((await errOf(sched.claim('task-2', 'engineer'))).message).toMatch(/\$6\.00 \(estimated\) of \$5\.00 \(estimated\)/);
  });
});

describe('CLI wiring', () => {
  const program = new Command();
  registerRuntime(program);
  const work = program.commands.find((c) => c.name() === 'work')!;
  const flags = (name: string) => work.commands.find((c) => c.name() === name)!.options.map((o) => o.long).sort();

  it('adds --usage to record and release and a work spend subcommand (no new top-level command)', () => {
    expect(flags('release')).toEqual(['--model', '--reason', '--usage']);
    expect(flags('spend')).toEqual(['--budget', '--by', '--lease', '--model', '--session', '--tokens']);
    expect(program.commands.map((c) => c.name())).not.toContain('spend');
    expect(program.commands.map((c) => c.name())).not.toContain('budget');
  });
});

