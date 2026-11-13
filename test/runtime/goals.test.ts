// Standing goals and the planning wake (docs/design/autonomy.md Decision 16): the goals parser, the coordinator's
// marks, the plan reason, the plan gates of the wake decision, and the pass that wakes (or messages the general
// session) to plan. A fake clock and fake restarts; no subprocess.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  effectiveGoals, goalsHash, goalsView, humanGoals, parseGoals, readGoalsState, readGoalsText, RETRO_EVERY_DONE, runtimeGoalsPath, writeGoalsState,
  type GoalsState,
} from '../../src/runtime/goals.js';
import {
  decideWake, humanPlan, PLAN_WAKE_EVENT, planReason, routineLast, runRoutinePass, WAKE_EVENT,
  type CoordinatorView, type PlanFacts, type RoutinePassDeps, type RoutineSettings, type WakeInputs, type WakeReason,
} from '../../src/runtime/routine.js';
import { writeHolds } from '../../src/runtime/dispatch-state.js';
import { collectStatus, humanStatus } from '../../src/runtime/commands.js';
import { makeDbEnv, tmp } from './fixtures.js';

const T0 = new Date('2026-11-13T12:00:00.000Z');
const ago = (min: number, from = T0) => new Date(from.getTime() - min * 60_000).toISOString();
const later = (min: number) => new Date(T0.getTime() + min * 60_000);
const empty = (): GoalsState => ({ marks: {}, exhausted: null, retro: null, log: [] });

const GOALS = `# Chess bot goals

Intro text, not a goal.

## Beat Stockfish level 5
Status: open
Measure: score >= 55% over 400 games at 10+0.1

## Search speed
- **Status:** done
- Metric: 2M nodes/s on the bench position

## Opening book
Status: on hold

\`\`\`
## not a heading (inside a fence)
\`\`\`

## Opening book
Status: banana
`;

describe('goals file', () => {
  it('parses one goal per ## heading with tolerant status and measure lines; fenced text and the intro are not goals', () => {
    const g = parseGoals(GOALS);
    expect(g.map((x) => [x.id, x.fileStatus, x.measure])).toEqual([
      ['beat-stockfish-level-5', 'open', 'score >= 55% over 400 games at 10+0.1'],
      ['search-speed', 'done', '2M nodes/s on the bench position'],
      ['opening-book', 'paused', null],
      ['opening-book-2', 'open', null], // a duplicate title gets a suffix; an unknown status reads as open
    ]);
    expect(g[2]!.body).toContain('## not a heading');
    expect(parseGoals('')).toEqual([]);
    expect(parseGoals('just text\nno headings')).toEqual([]);
  });

  it('a coordinator mark applies while the file status is unchanged; the owner\'s edit of the status line wins', () => {
    const s = empty();
    s.marks['beat-stockfish-level-5'] = { status: 'done', fileStatus: 'open', at: ago(5), reason: '57% over 400 games' };
    const before = effectiveGoals(parseGoals(GOALS), s);
    expect(before[0]).toMatchObject({ status: 'done', fileStatus: 'open', mark: { reason: '57% over 400 games' } });
    const edited = effectiveGoals(parseGoals(GOALS.replace('Status: open', 'Status: paused')), s);
    expect(edited[0]).toMatchObject({ status: 'paused' });
    expect(edited[0]!.mark).toBeUndefined();
  });

  it('the view counts goals; "nothing left" holds only while the goals are unchanged; the retrospective comes due', () => {
    const s = empty();
    const v = goalsView(GOALS, s);
    expect(v).toMatchObject({ present: true, counts: { open: 2, done: 1, paused: 1 }, exhausted: null, retro: null });
    s.exhausted = { hash: v.hash!, at: ago(10), reason: 'every next step needs the owner' };
    expect(goalsView(GOALS, s).exhausted).toMatchObject({ reason: 'every next step needs the owner' });
    expect(goalsView(GOALS + '\n## New goal\n', s).exhausted).toBeNull();
    s.marks['beat-stockfish-level-5'] = { status: 'done', fileStatus: 'open', at: ago(1), reason: 'met' };
    expect(goalsView(GOALS, s).exhausted).toBeNull(); // a mark changes the hash too
    expect(goalsHash(GOALS, effectiveGoals(parseGoals(GOALS), empty()))).toBe(v.hash);

    const done = (n: number) => Array.from({ length: n }, () => ({ status: 'done' as const }));
    const r = empty();
    expect(goalsView(GOALS, r, done(RETRO_EVERY_DONE - 1)).retro).toMatchObject({ doneSince: RETRO_EVERY_DONE - 1, due: false });
    expect(goalsView(GOALS, r, done(RETRO_EVERY_DONE)).retro).toMatchObject({ due: true });
    r.retro = { at: ago(60), done: RETRO_EVERY_DONE, summary: 'ok' };
    expect(goalsView(GOALS, r, done(RETRO_EVERY_DONE + 2)).retro).toMatchObject({ doneSince: 2, due: false });
    r.marks['search-speed'] = { status: 'open', fileStatus: 'done', at: ago(5), reason: 'regressed' };
    r.marks['beat-stockfish-level-5'] = { status: 'done', fileStatus: 'open', at: ago(5), reason: 'met' };
    expect(goalsView(GOALS, r, done(RETRO_EVERY_DONE + 2)).retro).toMatchObject({ goalsDoneSince: 1, due: true }); // a goal marked done since
    expect(goalsView(null, r)).toMatchObject({ present: false, goals: [], hash: null });
  });

  it('reads the runtime copy next to the config and keeps the state in <state>/goals.json', async () => {
    const root = tmp('minions-goals-');
    const cfg = join(root, 'config', 'config.json');
    mkdirSync(join(root, 'config'));
    expect(runtimeGoalsPath(cfg)).toBe(join(root, 'config', 'goals.md'));
    expect(readGoalsText(runtimeGoalsPath(cfg))).toBeNull();
    writeFileSync(runtimeGoalsPath(cfg), GOALS);
    expect(readGoalsText(runtimeGoalsPath(cfg))).toBe(GOALS);
    expect(readGoalsState(join(root, 'state'))).toEqual(empty()); // none yet
    const s = empty();
    s.log = Array.from({ length: 70 }, (_, i) => ({ at: ago(i), what: 'x', reason: String(i) }));
    await writeGoalsState(join(root, 'state'), s);
    expect(readGoalsState(join(root, 'state')).log).toHaveLength(50);
    expect(humanGoals(goalsView(GOALS, empty()))).toBe('goals: 2 open, 1 done, 1 paused');
    expect(humanGoals({ present: false, counts: { open: 0, done: 0, paused: 0 }, exhausted: null })).toMatch(/no goals file/);
  });
});

const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({
  goals: { present: true, counts: { open: 2, done: 0, paused: 0 }, exhausted: null }, queued: 0, ideas: 0, intakePaused: false, sessionBusy: null, ...over,
});

describe('planReason (pure)', () => {
  it('plans when the queue is empty and a goal is open, naming the ideas to weigh first', () => {
    expect(planReason(facts({ ideas: 3 }))).toEqual({ reason: { kind: 'plan', detail: expect.stringMatching(/queue is empty and 2 goal\(s\) are open; 3 idea task\(s\) to weigh first/) }, why: 'plan due' });
  });

  it.each<[string, Partial<PlanFacts>, RegExp]>([
    ['no goals file', { goals: { present: false, counts: { open: 0, done: 0, paused: 0 }, exhausted: null } }, /no goals file/],
    ['no open goal', { goals: { present: true, counts: { open: 0, done: 2, paused: 1 }, exhausted: null } }, /no open goal \(2 done, 1 paused\)/],
    ['work queued', { queued: 2 }, /2 task\(s\) ready or in flight/],
    ['intake paused', { intakePaused: true }, /intake is paused/],
    ['nothing worthwhile left', { goals: { present: true, counts: { open: 1, done: 0, paused: 0 }, exhausted: { hash: 'h', at: ago(30), reason: 'r' } } }, /nothing worthwhile left .*until the goals change/],
    ['the general session is busy', { sessionBusy: 'the general session has 1 message(s) waiting' }, /general session/],
  ])('no plan: %s', (_n, over, why) => {
    const p = planReason(facts(over));
    expect(p.reason).toBeNull();
    expect(p.why).toMatch(why);
  });
});

const ON: RoutineSettings = { enabled: true, tickMinutes: 15, minWakeGapMinutes: 30, maxWakesPerDay: 8, digestAt: ['08:00'], timezone: 'Europe/Berlin', planWhenIdle: true, maxPlanWakesPerDay: 4, minPlanGapMinutes: 120 };
const running = (): CoordinatorView => ({ running: true, lockAcquiredAt: ago(300), staleLock: false, exit: null, lastRestartAt: null });
const plan: WakeReason = { kind: 'plan', detail: 'the queue is empty and 1 goal(s) are open: plan the next tasks' };
const digest: WakeReason = { kind: 'digest', detail: 'digest 09:00 due' };
const inputs = (over: Partial<WakeInputs> = {}): WakeInputs => ({
  now: T0, settings: ON, coordinator: running(), activeLeases: [], drain: null, startsPaused: false, budgetExhausted: false,
  reasons: [plan], idleSince: ago(60), lastOwnerMessageAt: ago(120), wakesToday: 0, lastWakeAt: null, crashStartsToday: 0,
  planWakesToday: 0, lastPlanWakeAt: null, ...over,
});

describe('decideWake: the plan reason', () => {
  it('wakes to plan within every limit', () => {
    expect(decideWake(inputs())).toMatchObject({ action: 'wake', plan: true, digest: false });
  });

  it.each<[string, Partial<WakeInputs>, RegExp]>([
    ['its daily cap', { planWakesToday: 4 }, /plan wake limit reached \(4\/4 today, routine.maxPlanWakesPerDay\)/],
    ['its own gap', { lastPlanWakeAt: ago(90) }, /last plan wake 90 min ago \(routine.minPlanGapMinutes 120\)/],
    ['the budget', { budgetExhausted: true }, /budget is used up/],
    ['paused starts', { startsPaused: true }, /starts are paused/],
    ['a drain', { drain: { reason: 'upgrade' } }, /drain is in progress/],
    ['an active lease', { activeLeases: ['l1'] }, /active worker lease/],
    ['the owner writing', { lastOwnerMessageAt: ago(5) }, /owner wrote 5 min ago/],
    ['a busy coordinator', { idleSince: ago(2) }, /active 2 min ago/],
    ['the wake gap', { lastWakeAt: ago(10) }, /minWakeGapMinutes/],
    ['the daily wake cap', { wakesToday: 8 }, /wake limit reached \(8\/8/],
  ])('no plan wake: %s', (_n, over, why) => {
    const d = decideWake(inputs(over));
    expect(d.action).toBe('none');
    expect(d.why).toMatch(why);
  });

  it('a digest wake carries the plan only within the plan limits', () => {
    expect(decideWake(inputs({ reasons: [digest, plan] }))).toMatchObject({ action: 'wake', digest: true, plan: true });
    expect(decideWake(inputs({ reasons: [digest, plan], planWakesToday: 4 }))).toMatchObject({ action: 'wake', digest: true, plan: false });
  });
});

/** A routine pass with goals open and an empty queue (fake facts), a fake clock and fake restarts. */
function planEnv(o: { facts?: () => PlanFacts; sessions?: boolean; mode?: 'independent' | 'supervised' } = {}) {
  const env = makeDbEnv((c) => {
    c.routine = { enabled: true };
    if (o.mode) c.mode = o.mode;
    if (o.sessions) c.coordinator = { ...c.coordinator, sessions: { enabled: true } };
  });
  let now = T0;
  const calls = { wake: 0, session: 0, facts: 0 };
  const deps: RoutinePassDeps = {
    db: env.db, config: env.config, now: () => now, pid: 1111, procStart: () => 's1', lockAlive: () => true,
    coordinator: async () => running(), activeLeases: async () => [], budgetExhausted: () => false,
    planFacts: async () => { calls.facts++; return (o.facts ?? (() => facts()))(); },
    planSession: async () => { calls.session++; return 'queued for the general session'; },
    wake: async () => { calls.wake++; return 'wake scheduled'; },
    crashStart: async () => 'start scheduled',
  };
  return { env, deps, calls, setNow: (d: Date) => { now = d; } };
}

describe('runRoutinePass: planning', () => {
  it('sessions off: wakes the coordinator through the restart, records the plan wake, then its gap holds', async () => {
    const t = planEnv();
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r).toMatchObject({ decision: { action: 'wake', plan: true }, plan: 'plan due', reasons: [{ kind: 'plan' }], outcome: { ok: true, detail: 'wake scheduled' } });
    expect(t.calls).toMatchObject({ wake: 1, session: 0 });
    expect(t.env.db.lastEventOfKind(PLAN_WAKE_EVENT)!.data).toMatchObject({ via: 'restart' });
    expect(t.env.db.eventsOfKindSince(WAKE_EVENT, ago(60))).toHaveLength(1); // also a wake
    t.setNow(later(60));
    const r2 = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r2.decision).toMatchObject({ action: 'none', why: expect.stringMatching(/last plan wake 60 min ago/) });
    const last = routineLast(t.env.db, t.env.config, later(60));
    expect(last.plan).toMatchObject({ wakesToday: 1, maxPerDay: 4, lastAt: T0.toISOString(), nextAt: later(120).toISOString(), why: 'plan due' });
    expect(humanPlan(last.plan!)).toMatch(/plan wakes: last 2026-11-13T12:00:00.000Z; next when the queue is empty, not before 2026-11-13T14:00:00.000Z; today 1\/4/);
  });

  it('sessions on: the plan goes to the general session as a message, never a router restart', async () => {
    const t = planEnv({ sessions: true });
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r).toMatchObject({ decision: { action: 'wake', plan: true }, outcome: { ok: true, detail: 'queued for the general session' } });
    expect(t.calls).toMatchObject({ wake: 0, session: 1 });
    expect(t.env.db.lastEventOfKind(PLAN_WAKE_EVENT)!.data).toMatchObject({ via: 'session' });
  });

  it('a held decision comes first (sessions off): no plan facts read, the wake is for the hold', async () => {
    const t = planEnv();
    writeHolds(t.env.db, { 'task-1': { taskId: 'task-1', kind: 'blocked', message: 'stuck', leaseId: null, at: ago(60), status: 'blocked' } });
    const r = await runRoutinePass(t.deps, { trigger: 'clock' });
    expect(r).toMatchObject({ plan: 'held decisions come first', decision: { action: 'wake', plan: false } });
    expect(t.calls.facts).toBe(0);
  });

  it('queued work, planWhenIdle off (supervised default) and unreadable facts never plan', async () => {
    const busy = planEnv({ facts: () => facts({ queued: 1 }) });
    expect(await runRoutinePass(busy.deps, { trigger: 'clock' })).toMatchObject({ plan: '1 task(s) ready or in flight', decision: { action: 'none', why: 'nothing needs a model' } });
    const sup = planEnv({ mode: 'supervised' });
    expect(await runRoutinePass(sup.deps, { trigger: 'clock' })).toMatchObject({ plan: null, decision: { action: 'none' } });
    expect(sup.calls.facts).toBe(0);
    expect(routineLast(sup.env.db, sup.env.config, T0).plan).toBeNull();
    const bad = planEnv({ facts: () => { throw new Error('backlog unreadable'); } });
    expect(await runRoutinePass(bad.deps, { trigger: 'clock' })).toMatchObject({ plan: 'planning facts unreadable: backlog unreadable', decision: { action: 'none' } });
  });

  it('the daily plan cap: once it is used, the next plan wake is tomorrow', async () => {
    const t = planEnv();
    t.env.config.routine = { enabled: true, maxPlanWakesPerDay: 1, minPlanGapMinutes: 1 };
    await runRoutinePass(t.deps, { trigger: 'clock' });
    t.setNow(later(45));
    expect((await runRoutinePass(t.deps, { trigger: 'clock' })).decision!.why).toMatch(/plan wake limit reached \(1\/1/);
    expect(routineLast(t.env.db, t.env.config, later(45)).plan!.nextAt).toBe('2026-11-13T23:00:00.000Z'); // midnight in Berlin
  });

  it('status shows the goal counts and the plan line', async () => {
    const t = planEnv();
    await runRoutinePass(t.deps, { trigger: 'clock' });
    const s = await collectStatus({ db: t.env.db, config: t.env.config, backlog: async () => t.env.backlog, goals: () => goalsView(GOALS, empty()) });
    expect(s.goals).toEqual({ present: true, counts: { open: 2, done: 1, paused: 1 }, exhausted: null });
    const h = humanStatus(s);
    expect(h).toContain('goals: 2 open, 1 done, 1 paused');
    expect(h).toMatch(/plan wakes: last .*today 1\/4/);
  });
});
