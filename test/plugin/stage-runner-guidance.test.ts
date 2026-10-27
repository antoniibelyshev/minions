// task-33.5 (D11): the coordinator dispatches from `minions work next` instead of a role-by-status table.
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
  const out = await mkdtemp(join(tmpdir(), 'minions-plugin-next-'));
  dirs.push(out);
  await generatePlugin(cfg, out);
  return (rel: string) => readFile(join(out, rel), 'utf8');
}

const withWorkflows = (): MinionsConfig => {
  const c = defaults() as MinionsConfig & { roles?: unknown; workflows?: unknown };
  c.roles = { writer: { description: 'Writes docs.', promptText: 'Write.', contract: 'producer', edits: { paths: ['docs/**'] } } };
  c.workflows = { docs: ['writer', { role: 'reviewer', model: 'haiku' }] };
  delete (c.execution as { maxEngineers?: number }).maxEngineers;
  c.execution.maxByRole = { engineer: 2, writer: 1 };
  return c;
};

describe('coordinator.md and orchestrate dispatch from work next', () => {
  it('the dispatch flow lists work next, claims without --role and spawns agentType with agentModel', async () => {
    const read = await gen();
    const coord = await read('coordinator.md');
    expect(coord).toContain('`minions work next|claim|advance|record|release|list|spend ... --json`');
    expect(coord).toMatch(/1\. Pick a stage: `minions work next --json` lists the runnable stages .*`taskId`, `role`, `agentType`, `position`, `workflow`, `suggestedModel`, `agentModel`, `reason`/);
    expect(coord).toMatch(/Never derive the role from the task status yourself/);
    expect(coord).toMatch(/2\. Claim it: `minions work claim <taskId> --compact --json` \(the stage machine picks the role; `--role <role>` is optional and refused unless it is the current stage's\)/);
    expect(coord).toMatch(/`subagent_type` = the stage's `agentType`.*`model` = `agentModel`, omitted when it is null/);
    expect(coord).not.toMatch(/--role engineer\|tester\|reviewer/);

    const orch = await read('skills/orchestrate/SKILL.md');
    expect(orch).not.toMatch(/Role by status/);
    expect(orch).toMatch(/`minions work next --json` for the runnable stages: `runnable`.*`waiting`.*`stuck`/);
    expect(orch).toMatch(/never pick a role from the task status/);
    expect(orch).toContain('`minions work claim <taskId> --compact --json` (the CLI picks the stage\'s role');
    expect(orch).toMatch(/`subagent_type`: the stage's `agentType` from `work next`/);
    expect(orch).toMatch(/`model`: the stage's `agentModel`; omit it when null/);
  });

  it('after a worker returns, the coordinator advances in one call (task-68.7); record and claim stay as fallbacks', async () => {
    const read = await gen();
    const coord = await read('coordinator.md');
    expect(coord).toContain('Record it and claim the next stage in one call: `minions work advance <leaseId> --usage <subagent_tokens> --json`');
    expect(coord).toMatch(/either `next` .*spawn it as in step 3, no `work next` or `work claim` needed.* or `decision`/);
    expect(coord).toContain('Fallback: `minions work record <leaseId> --submitted --usage <subagent_tokens> --json`');
    const orch = await read('skills/orchestrate/SKILL.md');
    expect(orch).toContain('## 5. Record and advance');
    expect(orch).toContain('`minions work advance <leaseId> --usage <subagent_tokens> --json`');
    expect(orch).toMatch(/It never claims while paused, draining or over the budget, after an invalid result, or when a context reset is due/);
    expect(orch).toMatch(/- `next`: the claimed stage .*Spawn it right away as in step 4/);
    for (const kind of ['invalid', 'replan', 'needs-split', 'needs-changes', 'blocked', 'partial', 'awaiting-human', 'publication', 'ci-unverified', 'qa-findings', 'context-reset', 'paused', 'draining', 'budget', 'capacity', 'nothing-runnable', 'claim-failed']) {
      expect(orch).toContain(`\`${kind}\``);
    }
    expect(orch).toContain('`minions work advance <leaseId> --correction --usage <subagent_tokens> --json`');
    expect(orch).toMatch(/Fallback \(an older CLI rejects `work advance`.*`minions work record <leaseId> --submitted --usage <subagent_tokens> --json`, then steps 1 to 3/);
  });

  it('orchestrate covers assigning a workflow, proposing a role and cheap stages', async () => {
    const orch = await (await gen(withWorkflows()))('skills/orchestrate/SKILL.md');
    expect(orch).toContain('## Workflows, roles and models');
    expect(orch).toMatch(/\*\*Assigning a workflow\*\* when you create a task: the default unless the task fits a configured workflow \(`docs`\).*`minions backlog create \.\.\. --workflow <name>`/);
    expect(orch).toMatch(/\*\*Proposing a role\*\*: only when recurring project work does not fit engineer, tester and reviewer.*never for a one-off task.*`edits\.paths` scoped.*never edit `\.minions\/\*\*` yourself/);
    expect(orch).toMatch(/\*\*Cheap stages\*\*: follow `suggestedModel` \(stage hint, then role model, then the risk rule: `risk:low` → the cheapest allowed model for gates and verifiers, `risk:high` or a repair after a failed attempt → the strongest and the deep variant\)/);
    expect(await (await gen())('skills/orchestrate/SKILL.md')).toMatch(/fits a configured workflow \(none configured yet\)/);
  });

  it('proposing a role names the propose command and the host apply command (task-33.6)', async () => {
    const read = await gen();
    const orch = await read('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/\*\*Proposing a role\*\*:.*store it with `minions config roles propose --file <f> --json`.*returns `proposalId`, a `summary`.*Nothing becomes effective\..*host command `minions config roles apply <proposalId>`.*never edit `\.minions\/\*\*` yourself/);
    const coord = await read('coordinator.md');
    expect(coord).toContain('- Roles: `minions config roles list|show|propose ... --json` (propose only; the owner applies a proposal on the host with `minions config roles apply <proposalId>`');
  });

  it('configured workflows and per-role limits are rendered', async () => {
    const read = await gen(withWorkflows());
    const coord = await read('coordinator.md');
    expect(coord).toMatch(/\(the `default` workflow\)\. One active stage per task\. Configured workflows: `docs` \(writer → reviewer \[haiku\]\)/);
    expect(coord).toContain('2 concurrent engineers (per-role limits: engineer 2, writer 1; other roles only by the task limit)');
    expect(await read('skills/status/SKILL.md')).toContain('per role from `capacity.byRole` in the status, limits engineer 2, writer 1; other roles only by the task limit');
    expect(await read('skills/orchestrate/SKILL.md')).toContain('per-role limits (engineer 2, writer 1; other roles only by the task limit)');
    const plain = await (await gen())('coordinator.md');
    expect(plain).toContain('No other workflows are configured: tasks run the default.');
    expect(plain).toContain('per-role limits: engineer 2; other roles only by the task limit');
  });

  it('the status and recover skills point at work next', async () => {
    const read = await gen();
    expect(await read('skills/status/SKILL.md')).toMatch(/`minions work next --json` shows what can start next and what waits/);
    expect(await read('skills/recover/SKILL.md')).toMatch(/without a lease with `minions work next --json`: `runnable` lists the stage each needs again; a task under `stuck`/);
  });
});
