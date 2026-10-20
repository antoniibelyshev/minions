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
    expect(eng).toMatch(/Run the verification commands/);
  });

  it('reviewer owns test adequacy and can flag a task for QA', async () => {
    const rev = await (await gen())('agents/reviewer.md');
    expect(rev).toMatch(/You own test adequacy/);
    expect(rev).toMatch(/cover every acceptance criterion and the relevant edge cases/);
    expect(rev).toMatch(/Missing or weak tests are a reason to request changes/);
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
    expect(t).not.toMatch(/You run after the engineer and before review/);
  });

  it('coordinator explains the default pipeline, per-task QA opt-in, and when to schedule a QA sweep', async () => {
    const base = defaults();
    const coord = await (await gen())('coordinator.md');
    expect(coord).toContain('## Testing');
    expect(coord).toMatch(/Stage order per task: engineer → tester \(only when QA is required, see Testing\) → reviewer → delivered/);
    expect(coord).toMatch(/by default a task goes engineer → reviewer/);
    expect(coord).toMatch(/QA label \(`qa`\), its branch touches sensitive paths, or the reviewer sets `"needsQa": true`/);
    expect(coord).toMatch(/QA sweeps test `main` itself, not a ticket branch/);
    expect(coord).toMatch(/at a milestone, before a release, after about five merges since the last sweep, or when the user asks/);
    expect(coord).toContain('--label qa-sweep');
    expect(coord).toMatch(/create one backlog task per finding/);
    expect(base.verification.testerRequired).toBe(false);

    const orch = await (await gen())('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/labelled `qa-sweep` → tester \(QA sweep against `main`/);
    expect(orch).toMatch(/engineer `complete` → reviewer \(`reviewing`\), or tester \(`testing`\) when the task needs QA/);
  });

  it('testerRequired: true and custom QA labels are reflected', async () => {
    const base = defaults();
    const coord = await (await gen({ ...base, verification: { ...base.verification, testerRequired: true, qaLabels: ['needs-qa'] } }))('coordinator.md');
    expect(coord).toMatch(/Stage order per task: engineer → tester → reviewer → delivered/);
    expect(coord).toMatch(/`verification.testerRequired` is on: every task gets a tester stage/);
    expect(coord).toContain('QA label (`needs-qa`)');
    expect(coord).toContain('--label needs-qa');
  });
});
