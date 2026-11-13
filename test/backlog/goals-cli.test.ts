// `minions backlog goals` (docs/design/autonomy.md Decision 15): the owner's goals as the runtime sees them (the host's
// copy next to the config), the coordinator's marks, the "nothing worthwhile left" record and the retrospective
// (runtime mode, temp state, an in-memory backlog in place of Backlog.md).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readGoalsState } from '../../src/runtime/goals.js';
import { defaults } from '../helpers.js';
import { runCli as cli } from './harness.js';

vi.mock('../../src/backlog/factory.js', async (orig) => (await import('./harness.js')).mockFactory(await orig()));

let state: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['MINIONS_RUNTIME', 'MINIONS_STATE_DIR', 'MINIONS_CONFIG'] as const;

beforeAll(() => {
  state = mkdtempSync(join(tmpdir(), 'minions-goals-cli-'));
  for (const k of ENV) saved[k] = process.env[k];
  const config = join(state, 'config.json');
  writeFileSync(config, JSON.stringify(defaults()));
  Object.assign(process.env, { MINIONS_RUNTIME: 'container', MINIONS_STATE_DIR: state, MINIONS_CONFIG: config });
});
afterAll(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(state, { recursive: true, force: true });
});

type View = { present: boolean; path: string; goals: { id: string; status: string; fileStatus: string; measure: string | null; body: string }[]; counts: Record<string, number>; exhausted: unknown; retro: { due: boolean; doneSince: number } | null };
const view = async () => { const r = await cli(['backlog', 'goals']); expect(r.code, r.out).toBe(0); return r.body.data as View; };

describe('backlog goals', () => {
  it('without a goals file: present false, and idle cannot be recorded', async () => {
    expect(await view()).toMatchObject({ present: false, goals: [], path: join(state, 'goals.md') });
    const r = await cli(['backlog', 'goals', 'record', 'idle', '--reason', 'x']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no goals file/);
  });

  it('lists the goals with body and measure; set marks one and the file status still shows', async () => {
    writeFileSync(join(state, 'goals.md'), '## Win more games\nMeasure: 55% vs level 5\n\nDetails here.\n\n## Faster search\nStatus: paused\n');
    const v = await view();
    expect(v.goals.map((g) => [g.id, g.status, g.measure])).toEqual([['win-more-games', 'open', '55% vs level 5'], ['faster-search', 'paused', null]]);
    expect(v.goals[0]!.body).toContain('Details here.');
    expect(v.retro).toMatchObject({ due: false, doneSince: 0 });

    const set = await cli(['backlog', 'goals', 'set', 'win-more-games', 'done', '--reason', '57% over 400 games']);
    expect(set.code, set.out).toBe(0);
    expect(set.body.data).toEqual({ id: 'win-more-games', status: 'done', fileStatus: 'open' });
    expect((await view()).goals[0]).toMatchObject({ status: 'done', fileStatus: 'open' });
    expect((await view()).retro).toMatchObject({ due: true }); // a goal marked done since the last retrospective
    // Setting it back to the file's own status drops the mark.
    expect((await cli(['backlog', 'goals', 'set', 'win-more-games', 'open', '--reason', 'regressed'])).code).toBe(0);
    expect(readGoalsState(state).marks).toEqual({});

    expect((await cli(['backlog', 'goals', 'set', 'nope', 'done', '--reason', 'x'])).body).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', message: 'No goal "nope".' } });
    expect((await cli(['backlog', 'goals', 'set', 'win-more-games', 'finished', '--reason', 'x'])).out).toMatch(/Invalid status/);
  });

  it('record idle holds until the goals change; record retro resets the retrospective count', async () => {
    expect((await cli(['backlog', 'goals', 'record', 'idle', '--reason', 'every next step needs the owner'])).code).toBe(0);
    expect((await view()).exhausted).toMatchObject({ reason: 'every next step needs the owner' });
    writeFileSync(join(state, 'goals.md'), '## Win more games\nMeasure: 60% vs level 5\n');
    expect((await view()).exhausted).toBeNull();

    expect((await cli(['backlog', 'create', '--title', 'Done one', '--status', 'done', '--key', 'k1'])).code).toBe(0);
    expect((await view()).retro).toMatchObject({ doneSince: 1 });
    expect((await cli(['backlog', 'goals', 'record', 'retro', '--reason', 'two flaky tests filed'])).code).toBe(0);
    expect((await view()).retro).toMatchObject({ doneSince: 0, due: false });
    expect(readGoalsState(state).log.map((l) => l.what)).toEqual(['set done', 'set open', 'record idle', 'record retro']);
  });
});
