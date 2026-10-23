// Task-40: a `backlog task create` still running when a pre-spawn signal ends the coordinator wrapper
// must not lead to a duplicate task. The pass marks each create in flight (meta row) before the
// subprocess starts; a successor pass skips an unlinked issue with a fresh mark. Fake backlog, mocked
// read-only GitHub, temp state only. The "subprocess" is a create that never settles.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CreateTaskInput } from '../../src/backlog/types.js';
import type { ApiResponse } from '../../src/runtime/ci.js';
import { intakeOnStart } from '../../src/runtime/commands.js';
import { coordinatorWrapper, type SpawnLike } from '../../src/runtime/coordinator.js';
import {
  INTAKE_INFLIGHT_META, INTAKE_INFLIGHT_TTL_MS, intakeKey, syncIntake, type GithubIntakeConfig,
} from '../../src/runtime/intake-sync.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { FakeBacklog, makeDefaultEnv, tmp } from './fixtures.js';

const REPO = 'acme/demo';
const FILTER: GithubIntakeConfig = { enabled: true, repository: REPO, labels: [], assignee: null, milestone: null, state: 'open' };
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
const issue = (n: number) => ({ number: n, title: `Issue ${n}`, body: '', state: 'open', html_url: url(n), assignees: [], labels: [], milestone: null });

const api = (numbers: number[]) => async (path: string): Promise<ApiResponse> =>
  path.startsWith(`/repos/${REPO}/issues?`) ? { status: 200, body: numbers.map(issue) } : { status: 404, body: null, error: 'HTTP 404' };

/** Fake backlog whose creates can hang (the CLI subprocess still running) or fail. */
class ControlledBacklog extends FakeBacklog {
  mode: 'ok' | 'hang' | 'fail' = 'ok';
  creates: CreateTaskInput[] = [];
  private started: (() => void)[] = [];
  /** Resolves when the next create starts. */
  createStarted() { return new Promise<void>((r) => { this.started.push(r); }); }
  override async createTask(input: CreateTaskInput) {
    this.creates.push(input);
    for (const r of this.started.splice(0)) r();
    if (this.mode === 'hang') return new Promise<never>(() => {});
    if (this.mode === 'fail') throw new Error('backlog task create: exit 1');
    return super.createTask(input);
  }
  /** What the orphaned `backlog task create` leaves behind once it finishes: the task, linked to its issue. */
  land(n: number) { return this.add({ id: `task-${this.tasks.size + 1}`, status: 'idea', externalLinks: [url(n)] }); }
}

const inflight = (db: { getMeta(k: string): string | undefined }) => JSON.parse(db.getMeta(INTAKE_INFLIGHT_META) ?? '{}') as Record<string, string>;

describe('intake sync: creates in flight (task-40)', () => {
  it('a pass abandoned mid-create leaves a mark; the next pass skips that issue instead of importing it twice; the landed task is linked later', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const backlog = new ControlledBacklog();
    backlog.mode = 'hang';
    const started = backlog.createStarted();
    void syncIntake({ db: e.db, backlog, config: e.config, api: api([1]) }); // abandoned, like the exiting wrapper
    await started;
    expect(Object.keys(inflight(e.db))).toEqual([intakeKey(REPO, 1)]);

    backlog.mode = 'ok';
    const second = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1]) });
    expect(second).toMatchObject({ created: [], existing: 0, errors: [] });
    expect(second.warnings.join('\n')).toMatch(/may still be finishing; not imported now so it cannot be imported twice/);
    expect(backlog.creates).toHaveLength(1); // only the abandoned one
    expect(await backlog.listTasks()).toHaveLength(0);

    const landed = backlog.land(1); // the orphaned subprocess finishes
    const third = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1]) });
    expect(third).toMatchObject({ created: [], existing: 1, errors: [] });
    expect(await backlog.listTasks()).toHaveLength(1);
    expect(backlog.creates).toHaveLength(1);
    expect(e.db.idempotency.get(intakeKey(REPO, 1))).toBe(landed.id);
    expect(e.db.getMeta(INTAKE_INFLIGHT_META)).toBeUndefined();
  });

  it('a mark older than the TTL counts as a create that never happened: the issue is imported once', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const backlog = new ControlledBacklog();
    const now = new Date('2026-10-23T12:00:00Z');
    e.db.setMeta(INTAKE_INFLIGHT_META, JSON.stringify({ [intakeKey(REPO, 1)]: new Date(now.getTime() - INTAKE_INFLIGHT_TTL_MS).toISOString() }));
    const r = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1]), now: () => now });
    expect(r).toMatchObject({ created: ['task-1'], errors: [] });
    expect(e.db.getMeta(INTAKE_INFLIGHT_META)).toBeUndefined();
    // Just inside the TTL it is still skipped.
    e.db.setMeta(INTAKE_INFLIGHT_META, JSON.stringify({ [intakeKey(REPO, 2)]: new Date(now.getTime() - INTAKE_INFLIGHT_TTL_MS + 1).toISOString() }));
    expect(await syncIntake({ db: e.db, backlog, config: e.config, api: api([1, 2]), now: () => now })).toMatchObject({ created: [], existing: 1 });
  });

  it('a create that fails clears its mark, so the next pass retries; a successful pass leaves no mark', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; });
    const backlog = new ControlledBacklog();
    backlog.mode = 'fail';
    const r = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1, 2]) });
    expect(r.errors).toHaveLength(2);
    expect(e.db.getMeta(INTAKE_INFLIGHT_META)).toBeUndefined();
    backlog.mode = 'ok';
    expect(await syncIntake({ db: e.db, backlog, config: e.config, api: api([1, 2]) })).toMatchObject({ created: ['task-1', 'task-2'], errors: [] });
    expect(e.db.getMeta(INTAKE_INFLIGHT_META)).toBeUndefined();
  });

  it('end to end: SIGHUP while the startup intake is inside `backlog task create`; a later sync creates no duplicate', async () => {
    const e = makeDefaultEnv((c) => { c.intake.github = { ...FILTER }; c.communication.channel = 'terminal'; });
    const root = tmp('minions-inflight-');
    for (const d of ['plugin', 'secrets', 'state']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'plugin', 'coordinator.md'), 'You are the coordinator.');
    const paths = {
      ...runtimePaths({ MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_SECRETS_DIR: join(root, 'secrets') }),
      pluginDir: join(root, 'plugin'), coordinatorPrompt: join(root, 'plugin', 'coordinator.md'),
    };
    const handlers = new Map<string, Set<() => void>>();
    const bus = {
      on(s: string, h: () => void) { (handlers.get(s) ?? handlers.set(s, new Set()).get(s)!).add(h); return this; },
      removeListener(s: string, h: () => void) { handlers.get(s)?.delete(h); return this; },
    };
    let spawned = 0;
    const spawn: SpawnLike = () => { spawned++; return { on() { return this; } } as unknown as ReturnType<SpawnLike>; };
    const backlog = new ControlledBacklog();
    backlog.mode = 'hang';
    const started = backlog.createStarted();
    const sync = (o: { signal: AbortSignal }) => syncIntake({ db: e.db, backlog, config: e.config, api: api([1]), signal: o.signal });
    const p = coordinatorWrapper(async () => e.config, {
      paths, lock: e.db, spawn, permissionModes: async () => ['acceptEdits', 'auto'], env: {}, log: () => {}, signals: bus,
      onStart: (c, l, stop) => intakeOnStart(c, l, sync, undefined, stop), exitAfterSignal: () => {},
    });
    await started;
    for (const h of [...(handlers.get('SIGHUP') ?? [])]) h();
    expect(await p).toBe(129); // the wrapper does not wait for the create
    expect(spawned).toBe(0);
    expect(e.db.coordinatorLock()).toBeUndefined();

    // The successor's pass runs while the orphaned create is still going: no second create.
    backlog.mode = 'ok';
    const next = await syncIntake({ db: e.db, backlog, config: e.config, api: api([1]) });
    expect(next.created).toEqual([]);
    expect(backlog.creates).toHaveLength(1);
    backlog.land(1);
    expect(await syncIntake({ db: e.db, backlog, config: e.config, api: api([1]) })).toMatchObject({ created: [], existing: 1 });
    expect(await backlog.listTasks()).toHaveLength(1);
  });
});
