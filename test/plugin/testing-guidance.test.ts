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

describe('risk-based testing in the generated plugin', () => {
  it('engineer must add/update tests for the acceptance criteria and run the verification commands', async () => {
    const eng = await (await gen())('agents/engineer.md');
    expect(eng).toMatch(/Tests are your responsibility: add or update tests that prove each acceptance criterion/);
    expect(eng).toMatch(/edge cases/);
    expect(eng).toMatch(/Focus on the important, user-visible or risky behaviour of the change; do not chase exhaustive small cases of low-importance helpers/);
    expect(eng).toMatch(/Testing rule: from the brief's verification commands/);
  });

  it('testing rule (task-137.3): engineers run typecheck + unit tier, reviewers no tests, nobody the integration tier or baselines', async () => {
    const cfg = defaults();
    cfg.verification.commands = ['npm run typecheck', 'npm test'];
    const read = await gen(cfg);
    const eng = await read('agents/engineer.md');
    expect(eng).toMatch(/run the typecheck \(or build\) and the unit tests only/);
    expect(eng).toMatch(/targeted test files while iterating, then the unit tier once before you submit \(for example `npm run test:unit`/);
    expect(eng).toMatch(/Do not run the full suite or the integration tier, and never rerun tests on the base branch for a baseline comparison/);
    expect(eng).toMatch(/`TMPDIR` set to the scratch dir, whose path may contain spaces/);
    expect(eng).toMatch(/On host-runtime projects this is the host environment, so no separate tester run is needed/);
    expect(eng).toMatch(/The CLI refuses a `complete` engineer result with a failing check, a skipped verification command, or no passing test run/);
    expect(eng).not.toMatch(/TMPDIR=<scratchDir> npm test/);

    const rev = await read('agents/reviewer.md');
    expect(rev).toMatch(/Run no tests, test suites or baseline reruns\. Rely on the engineer's recorded checks/);
    expect(rev).toMatch(/The integration gate runs the full verification \(`npm run typecheck`, `npm test`\) before the base branch moves/);
    expect(rev).not.toMatch(/verification commands \([^)]*\) to confirm claims/);
    expect(rev).toMatch(/"needsQa": true` in your result only when .*install\/upgrade paths, cross-feature changes, or behaviour the engineer's evidence cannot show/);

    const t = await read('agents/tester.md');
    const taskQa = t.slice(t.indexOf('## Task QA'));
    expect(taskQa).toMatch(/Run targeted checks only.*Do not rerun the full suite, the unit tier the engineer already ran, or the integration tier, and never rerun tests on the base branch/);
    const sweep = t.slice(t.indexOf('## QA sweep'), t.indexOf('## Task QA'));
    expect(sweep).toMatch(/a sweep may run the integration tier/);

    const coord = await read('coordinator.md');
    expect(coord).toMatch(/Testing rule: engineers run the typecheck and unit tests only .*Reviewers run no tests.*only in the integration gate \(and in QA sweeps\)\. Nobody reruns tests on the base branch/);
  });

  it('reviewer owns test adequacy and can flag a task for QA', async () => {
    const rev = await (await gen())('agents/reviewer.md');
    expect(rev).toMatch(/You own test adequacy/);
    expect(rev).toMatch(/cover every acceptance criterion and the relevant edge cases, and that the engineer's recorded checks show them passing/);
    expect(rev).toMatch(/Missing or weak tests are a reason to request changes/);
    expect(rev).toMatch(/do not request changes only for missing tests of trivial or low-importance code/);
    expect(rev).toContain('"needsQa": true');
    expect(rev).toMatch(/moves to `testing` instead of being delivered/);
  });

  it('tester runs system-level QA sweeps against the base branch and task QA on demand', async () => {
    const base = defaults();
    const t = await (await gen({ ...base, git: { ...base.git, baseBranch: 'trunk' } }))('agents/tester.md');
    expect(t).toMatch(/system-level QA: end-to-end flows, install and upgrade paths, and regressions across features/);
    expect(t).toContain('## QA sweep (`kind: "qa-sweep"`)');
    expect(t).toMatch(/You test the base branch \(`trunk`\) itself, not a ticket branch/);
    expect(t).toMatch(/Do not commit/);
    expect(t).toMatch(/finding that can become a backlog task: `task: <title>/);
    expect(t).toContain('## Task QA (`kind: "task"`)');
    expect(t).toMatch(/for the important, user-visible or risky behaviour; do not chase exhaustive small cases of low-importance helpers/);
    expect(t).not.toMatch(/You run after the engineer and before review/);
  });

  it('QA sweeps include an efficiency pass with severity-tagged findings, focused on what matters', async () => {
    const t = await (await gen())('agents/tester.md');
    const sweep = t.slice(t.indexOf('## QA sweep'), t.indexOf('## Task QA'));
    expect(sweep).toMatch(/efficiency pass over the base: logical inefficiencies \(redundant work, needless I\/O or process spawns, slow paths, duplicated logic\)/);
    expect(sweep).toMatch(/code-style problems \(dead code, inconsistent idioms, oversized functions\)/);
    expect(sweep).toMatch(/Report each like other findings, adding `\| where: <file:line> \| severity: high\|medium\|low`/);
    expect(sweep).toMatch(/do not file nits about low-importance code/);
    expect(sweep).toMatch(/Do not commit/);

    const coord = await (await gen())('coordinator.md');
    expect(coord).toMatch(/Every sweep includes an efficiency pass \(logical inefficiencies, code style\) on the same cadence, with no separate role or command; its findings carry a severity/);
    const orch = await (await gen())('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/including the sweep's efficiency-pass findings \(same cadence, no extra role or command\); batch or skip `severity: low` nits/);
  });

  it('coordinator explains the default pipeline, per-task QA opt-in, and when to schedule a QA sweep', async () => {
    const base = defaults();
    const coord = await (await gen())('coordinator.md');
    expect(coord).toContain('## Testing');
    expect(coord).toMatch(/Stage order per task: engineer → tester \(only when QA is required, see Testing\) → reviewer → delivered/);
    expect(coord).toMatch(/by default a task goes engineer → reviewer/);
    expect(coord).toMatch(/In task descriptions, ask for tests of the important, user-visible or risky behaviour of a change, not exhaustive small cases of low-importance helpers/);
    expect(coord).toMatch(/QA label \(`qa`\), its branch touches sensitive paths, or the reviewer sets `"needsQa": true`/);
    expect(coord).toMatch(/QA sweeps test `main` itself, not a ticket branch/);
    expect(coord).toMatch(/at a milestone, before a release, after about five merges since the last sweep, or when the user asks/);
    expect(coord).toContain('--label qa-sweep');
    expect(coord).toMatch(/create one backlog task per finding/);
    expect(base.verification.testerRequired).toBe(false);

    const orch = await (await gen())('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/engineer `complete` → reviewer, or tester when the task needs QA/);
    expect(coord).toMatch(/the dispatcher runs it as a tester stage/);
  });

  it('testerRequired: true and custom QA labels are reflected', async () => {
    const base = defaults();
    const coord = await (await gen({ ...base, verification: { ...base.verification, testerRequired: true, qaLabels: ['needs-qa'] } }))('coordinator.md');
    expect(coord).toMatch(/Stage order per task: engineer → tester → reviewer → delivered/);
    expect(coord).toMatch(/`verification.testerRequired` is on: every task gets a tester stage/);
    expect(coord).toMatch(/In task descriptions, ask for tests of the important/);
    expect(coord).toContain('QA label (`needs-qa`)');
    expect(coord).toContain('`minions backlog update <taskId> --expected-version <v> --label needs-qa` (`<v>`: the `version` from `minions backlog show <taskId> --json`;');
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
