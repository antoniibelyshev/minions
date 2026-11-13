// Standing goals, planning, experiments and retrospectives in the generated plugin (docs/design/autonomy.md Decision 15).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { currentValue, settingDef, type SettingsContext } from '../../src/host/settings.js';
import { classifyKey } from '../../src/config/setting-classes.js';
import { validateConfig } from '../../src/config/resolve.js';
import { GENERAL_SESSION_NOTE } from '../../src/runtime/router-prompt.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function gen(cfg: MinionsConfig) {
  const out = await mkdtemp(join(tmpdir(), 'minions-plugin-goals-'));
  dirs.push(out);
  await generatePlugin(cfg, out);
  return (rel: string) => readFile(join(out, rel), 'utf8');
}
const section = (md: string, from: string, to?: string) => md.slice(md.indexOf(from), to ? md.indexOf(to, md.indexOf(from) + from.length) : undefined);

describe('coordinator prompt: goals, planning, experiments, retrospectives', () => {
  it('independent with the routine on: the goals file in the repo, routine planning wakes with their limits', async () => {
    const c = defaults('independent');
    c.routine = { enabled: true };
    const coord = await (await gen(c))('coordinator.md');
    const s = section(coord, '## Goals, planning, experiments', '## Testing');
    expect(s).toContain('`.minions/goals.md` in the owner\'s checkout');
    expect(s).toContain('`minions backlog goals set <id> done|paused|open --reason <text> --json`');
    expect(s).toMatch(/the routine wakes you to plan \(`plan` among the wake reasons, or the message `\/minions:orchestrate plan`; at most 4 a day, 120 min apart\)/);
    expect(s).toMatch(/\*\*Experiments\.\*\* .*label `experiment`.*hypothesis, measurement command, acceptance threshold/);
    expect(s).toMatch(/\*\*Retrospectives\.\*\* .*`retro.due`/);
    expect(coord).not.toMatch(/\{\{\w+\}\}/);
  });

  it('supervised (private, routine off): the goals file on the host, no planning wakes, plans proposed as ideas', async () => {
    const r = await gen(defaults('supervised'));
    const coord = await r('coordinator.md');
    expect(coord).toContain('`goals.md` in the project\'s minions directory on the host');
    expect(coord).toMatch(/The routine does not wake you to plan here \(the routine is off\)/);
    expect(await r('skills/orchestrate/SKILL.md')).toMatch(/Create them as `idea` and ask the owner which to start/);
  });

  it('the routine on but planWhenIdle off says so', async () => {
    const c = defaults('independent');
    c.routine = { enabled: true, planWhenIdle: false };
    expect(await (await gen(c))('coordinator.md')).toMatch(/does not wake you to plan here \(`routine.planWhenIdle` is off\)/);
  });
});

describe('orchestrate skill: the plan procedure, experiments and the retrospective', () => {
  it('the wake reads plan reasons; plan reads goals and outcomes, promotes ideas first, files 1-3 ready tasks, records idle, stops', async () => {
    const orch = await (await gen(defaults('independent')))('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/`plan` when the queue is empty and a goal is open\)\. Handle exactly those \(step 2 for the holds, step 4 for `plan`\)/);
    expect(orch).toContain('Invoked as `/minions:orchestrate plan` (the argument `plan`): go straight to step 4.');
    const plan = section(orch, '## 4. Plan', '## Experiments');
    expect(plan).toContain('`minions backlog goals --json`');
    expect(plan).toMatch(/Promote existing `idea` tasks that serve a goal before inventing new ones/);
    expect(plan).toMatch(/next 1-3 highest-value tasks/);
    expect(plan).toMatch(/idempotency key `plan:<goal id>:<short slug>`/);
    expect(plan).toMatch(/Create them `ready` \(this project starts work without the owner\)/);
    expect(plan).toContain('`minions backlog goals set <id> done --reason "<the measurement>" --json`');
    expect(plan).toContain('`minions backlog goals record idle --reason "<why>" --json`');
    expect(plan).toMatch(/Never file filler work/);
    const exp = section(orch, '## Experiments', '## Retrospective');
    expect(exp).toMatch(/\*\*Hypothesis\*\*; \*\*Measurement\*\*.*\*\*Threshold\*\*.*\*\*Record\*\*/);
    expect(exp).toMatch(/Records directory\*\*: choose it once per project/);
    expect(exp).toMatch(/only the record/);
    const retro = section(orch, '## Retrospective');
    expect(retro).toMatch(/repair cycles.*over the per-task budget.*flaky checks/);
    expect(retro).toMatch(/as `idea` \(provenance `agent-hypothesis`, key `retro:<date>:<n>`\)/);
    expect(retro).toMatch(/minions itself .* digest for the owner/);
    expect(retro).toContain('minions control set verification.periodic');
    expect(retro).toContain('`minions backlog goals record retro');
  });

  it('the general session (sessions on) knows the routine\'s plan message', () => {
    expect(GENERAL_SESSION_NOTE).toContain('The message `/minions:orchestrate plan` comes from the routine');
  });

  it('engineer and reviewer know the experiment label', async () => {
    const r = await gen(defaults('independent'));
    expect(await r('agents/engineer.md')).toMatch(/\*\*Experiments\*\* \(label `experiment`\).*baseline run on the base branch is part of the task.*Threshold missed: revert the change/);
    expect(await r('agents/reviewer.md')).toMatch(/\*\*Experiments\*\* \(label `experiment`\).*a missed threshold lands only the record/);
  });
});

describe('config: the planning keys', () => {
  it('validate, are classified live (planWhenIdle host-owned), and are host settings with the mode default', () => {
    const c = defaults('independent');
    c.routine = { enabled: true, planWhenIdle: true, maxPlanWakesPerDay: 2, minPlanGapMinutes: 60 };
    expect(() => validateConfig(c, 'test')).not.toThrow();
    const bad = defaults('independent');
    bad.routine = { minPlanGapMinutes: 0 };
    expect(() => validateConfig(bad, 'test')).toThrow(/minPlanGapMinutes/);
    expect(classifyKey('routine.planWhenIdle')).toMatchObject({ class: 'live', hostOwned: true });
    expect(classifyKey('routine.maxPlanWakesPerDay')).toMatchObject({ class: 'live', hostOwned: false });
    const def = settingDef('routine.planWhenIdle')!;
    const ctx = (mode: 'independent' | 'supervised') => ({ config: defaults(mode) }) as unknown as SettingsContext;
    expect(currentValue(def, ctx('independent'))).toBe(true);
    expect(currentValue(def, ctx('supervised'))).toBe(false);
    expect(settingDef('routine.maxPlanWakesPerDay')!.loosens!(4, 6)).toMatch(/more planning wakes per day \(4 -> 6/);
  });
});
