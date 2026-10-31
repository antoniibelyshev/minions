import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function gen(cfg: MinionsConfig = defaults()) {
  const out = await mkdtemp(join(tmpdir(), 'minions-plugin-qa-'));
  dirs.push(out);
  await generatePlugin(cfg, out);
  return (rel: string) => readFile(join(out, rel), 'utf8');
}

describe('testing in the generated plugin (docs/design/autonomy.md Decision 12)', () => {
  it('engineer writes unit tests for new behaviour and runs the fast checks itself', async () => {
    const eng = await (await gen())('agents/engineer.md');
    expect(eng).toMatch(/Tests are your responsibility: write or update unit tests for the new behaviour that prove each acceptance criterion/);
    expect(eng).toMatch(/edge cases/);
    expect(eng).toMatch(/Focus on the important, user-visible or risky behaviour of the change; do not chase exhaustive small cases of low-importance helpers/);
    expect(eng).toMatch(/No tester runs after you: the runtime runs the verification commands on your head/);
    expect(eng).toMatch(/Testing rule: from the brief's verification commands/);
  });

  it('testing rule: engineers run typecheck + unit tier, reviewers rerun nothing, nobody the integration tier or baselines', async () => {
    const cfg = defaults();
    cfg.verification.commands = ['npm run typecheck', 'npm test'];
    const read = await gen(cfg);
    const eng = await read('agents/engineer.md');
    expect(eng).toMatch(/run the typecheck \(or build\) and the unit tests only/);
    expect(eng).toMatch(/targeted test files while iterating, then the unit tier once before you submit \(for example `npm run test:unit`/);
    expect(eng).toMatch(/Do not run the full suite or the integration tier, and never rerun tests on the base branch for a baseline comparison/);
    expect(eng).toMatch(/`TMPDIR` set to the scratch dir, whose path may contain spaces/);
    expect(eng).toMatch(/The CLI refuses a `complete` engineer result with a failing check, a skipped verification command, or no passing test run/);

    const rev = await read('agents/reviewer.md');
    expect(rev).toMatch(/Verification already passed on this head: the runtime ran the verification commands \(`npm run typecheck`, `npm test`\) on it/);
    expect(rev).toMatch(/Do not rerun tests, the typecheck or the linter/);
    expect(rev).not.toContain('needsQa');

    const t = await read('agents/tester.md');
    const taskQa = t.slice(t.indexOf('## Task QA'));
    expect(taskQa).toMatch(/Run targeted checks only.*Do not rerun the full suite, the unit tier the engineer already ran, or the integration tier, and never rerun tests on the base branch/);
    const sweep = t.slice(t.indexOf('## QA sweep'), t.indexOf('## Task QA'));
    expect(sweep).toMatch(/a sweep may run the integration tier/);
  });

  it('reviewer reviews the code, the test quality and the coverage of new behaviour', async () => {
    const rev = await (await gen())('agents/reviewer.md');
    expect(rev).toMatch(/Review the code, the test quality and the coverage of new behaviour/);
    expect(rev).toMatch(/You own test adequacy/);
    expect(rev).toMatch(/Missing or weak tests are a reason to request changes/);
    expect(rev).toMatch(/do not request changes only for missing tests of trivial or low-importance code/);
  });

  it('tester runs system-level QA sweeps against the base branch and a workflow tester stage', async () => {
    const base = defaults();
    const t = await (await gen({ ...base, git: { ...base.git, baseBranch: 'trunk' } }))('agents/tester.md');
    expect(t).toMatch(/system-level QA: end-to-end flows, install and upgrade paths, and regressions across features/);
    expect(t).toContain('## QA sweep (`kind: "qa-sweep"`)');
    expect(t).toMatch(/You test the base branch \(`trunk`\) itself, not a ticket branch/);
    expect(t).toMatch(/Do not commit/);
    expect(t).toMatch(/finding that can become a backlog task: `task: <title>/);
    expect(t).toContain('## Task QA (`kind: "task"`)');
    expect(t).not.toMatch(/QA label/);
  });

  it('QA sweeps include an efficiency pass with severity-tagged findings, focused on what matters', async () => {
    const t = await (await gen())('agents/tester.md');
    const sweep = t.slice(t.indexOf('## QA sweep'), t.indexOf('## Task QA'));
    expect(sweep).toMatch(/efficiency pass over the base: logical inefficiencies \(redundant work, needless I\/O or process spawns, slow paths, duplicated logic\)/);
    expect(sweep).toMatch(/Report each like other findings, adding `\| where: <file:line> \| severity: high\|medium\|low`/);

    const coord = await (await gen())('coordinator.md');
    expect(coord).toMatch(/Every sweep includes an efficiency pass \(logical inefficiencies, code style\) on the same cadence, with no separate role or command; its findings carry a severity/);
    const orch = await (await gen())('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/including the sweep's efficiency-pass findings \(same cadence, no extra role or command\); batch or skip `severity: low` nits/);
  });

  it('coordinator explains the verify step, the two tiers, verify:full and QA sweeps', async () => {
    const cfg = defaults();
    cfg.verification.commands = ['npm run test:unit'];
    cfg.verification.periodic = { commands: ['npm run test:integration'], everyHours: 12 };
    const coord = await (await gen(cfg))('coordinator.md');
    expect(coord).toContain('## Testing');
    expect(coord).toMatch(/Stage order per task: engineer → verify \(the dispatcher runs the verification commands on the head; no worker\) → reviewer → delivered/);
    expect(coord).toMatch(/The fast tier, `verification.commands` \(`npm run test:unit`\)/);
    expect(coord).toMatch(/The slow tier, `verification.periodic` \(`npm run test:integration` every 12 h\)/);
    expect(coord).toMatch(/Tasks need no tester/);
    expect(coord).toMatch(/Label a task `verify:full` only when .*Use it sparingly/);
    expect(coord).not.toMatch(/Your first task is to set them up/);
    expect(coord).toMatch(/QA sweeps test `main` itself, not a ticket branch/);
    expect(coord).toContain('--label qa-sweep');
    expect(coord).not.toMatch(/needsQa|QA label/);

    const orch = await (await gen(cfg))('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/engineer `complete` → the verify step on its head/);
    expect(orch).not.toMatch(/needsQa|testerRequired/);
  });

  it('a project without verification commands: setting them up is the coordinator\'s first task', async () => {
    const cfg = defaults();
    cfg.verification.commands = [];
    cfg.delivery.merge = 'auto-when-eligible';
    const coord = await (await gen(cfg))('coordinator.md');
    expect(coord).toMatch(/This project has no `verification.commands`, so nothing is verified before review and the integrator lands nothing on `main`/);
    expect(coord).toMatch(/Your first task is to set them up: find the project's fast checks \(unit tests, typecheck, lint/);
    expect(coord).toMatch(/set them as `verification.periodic`/);
  });
});

describe('minimal, in-scope changes in the generated plugin', () => {
  it('engineer and engineer-deep make only the changes the acceptance criteria need', async () => {
    const read = await gen();
    for (const f of ['agents/engineer.md', 'agents/engineer-deep.md']) {
      const eng = await read(f);
      expect(eng, f).toMatch(/Change only what the acceptance criteria need: no unrequested features, options, abstractions, refactors, renames, reformatting or drive-by fixes, and touch only the files the task needs/);
      expect(eng, f).toMatch(/Prefer the smallest diff that meets the criteria; report anything else worth doing in `findings` instead of doing it/);
    }
  });

  it('reviewer treats scope creep as a requested change, not a nit', async () => {
    const rev = await (await gen())('agents/reviewer.md');
    expect(rev).toMatch(/Scope creep is a requested change, not a nit: .*request changes and ask the engineer to drop them/);
  });

  it('coordinator worker briefs name what is out of scope', async () => {
    const coord = await (await gen())('coordinator.md');
    expect(coord).toMatch(/\*\*Task text is the brief\.\*\*[^\n]*Name what is out of scope, so engineers change only what the task needs/);
  });
});
