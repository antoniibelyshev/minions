// The coordinator never dispatches (docs/design/autonomy.md Decision 10): the autopilot runs every stage, the
// coordinator handles its holds and owns the backlog and the config.
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

describe('coordinator.md and orchestrate: the autopilot runs the stages', () => {
  it('the coordinator never claims, spawns or records; it handles holds with autopilot status|resume', async () => {
    const read = await gen();
    const coord = await read('coordinator.md');
    expect(coord).toContain('**The autopilot dispatcher runs every stage.**');
    expect(coord).toContain('You never claim, spawn, record or release workers; a hook refuses `minions:*` Agent calls.');
    expect(coord).toContain('`minions work autopilot status --json` lists the holds');
    expect(coord).toContain('`minions work autopilot resume <taskId> --json`');
    for (const gone of ['work advance', 'work claim', 'subagent_type', 'briefMarker', 'dispatch.mode', '--usage <subagent_tokens>']) expect(coord).not.toContain(gone);

    const orch = await read('skills/orchestrate/SKILL.md');
    expect(orch).toContain('## 2. Handle each hold');
    for (const kind of ['invalid', 'replan', 'needs-split', 'needs-changes', 'partial', 'blocked', 'awaiting-human', 'publication', 'qa-findings', 'no-result', 'claim-failed', 'launch-failed']) {
      expect(orch).toContain(`\`${kind}\``);
    }
    for (const gone of ['work advance', 'work claim', 'subagent_type', 'Spawn']) expect(orch).not.toContain(gone);
    expect(orch).toMatch(/`minions work next --json` shows what can start \(`runnable`.*`waiting`.*`stuck`/);
  });

  it('orchestrate covers assigning a workflow, defining a role and models', async () => {
    const orch = await (await gen(withWorkflows()))('skills/orchestrate/SKILL.md');
    expect(orch).toContain('## Workflows, roles and models');
    expect(orch).toMatch(/\*\*Assigning a workflow\*\* when you create a task: the default unless the task fits a configured workflow \(`docs`\).*`minions backlog create \.\.\. --workflow <name>`/);
    expect(orch).toMatch(/\*\*Defining a role \(worker profile\)\*\*: when recurring project work does not fit the existing roles.*never for a one-off task.*`edits\.paths` scoped/);
    expect(orch).toMatch(/\*\*Models\*\*: The dispatcher runs each stage on the model `work next` suggests/);
    expect(await (await gen())('skills/orchestrate/SKILL.md')).toMatch(/fits a configured workflow \(none configured yet\)/);
  });

  it('defining a role and tuning a flow go through the control layer, applied at once (autonomy D3)', async () => {
    const read = await gen();
    const orch = await read('skills/orchestrate/SKILL.md');
    expect(orch).toMatch(/\*\*Defining a role \(worker profile\)\*\*:.*`minions control apply --file <f> --reason <why> --json`.*takes effect for the next stage/);
    expect(orch).toMatch(/\*\*Tuning flows\*\*:.*`minions control set workflows\.<name>/);
    const coord = await read('coordinator.md');
    expect(coord).toContain('**You own the configuration.** `minions control set <key> <json> --reason <text> --json` changes any config key at once, without the owner');
  });

  it('configured workflows and per-role limits are rendered', async () => {
    const read = await gen(withWorkflows());
    const coord = await read('coordinator.md');
    expect(coord).toMatch(/\(the `default` workflow\)\. One active stage per task\. Configured workflows: `docs` \(writer → reviewer \[haiku\]\)/);
    expect(coord).toContain('2 concurrent engineers (per-role limits: engineer 2, writer 1; other roles only by the task limit)');
    expect(await read('skills/status/SKILL.md')).toContain('per role from `capacity.byRole` in the status, limits engineer 2, writer 1; other roles only by the task limit');
    expect(await read('skills/orchestrate/SKILL.md')).toContain('limits engineer 2, writer 1; other roles only by the task limit applied');
    const plain = await (await gen())('coordinator.md');
    expect(plain).toContain('No other workflows are configured: tasks run the default.');
    expect(plain).toContain('per-role limits: engineer 2; other roles only by the task limit');
  });

  it('the task skill handles the hold of its task and never dispatches; recover leaves dispatcher leases alone', async () => {
    const read = await gen();
    const task = await read('skills/task/SKILL.md');
    expect(task).toContain('you never claim, spawn, record or release workers');
    expect(task).toContain('`minions work autopilot resume <id> --json`');
    expect(task).not.toContain('work advance');
    const recover = await read('skills/recover/SKILL.md');
    expect(recover).toMatch(/leases whose `holder` is not `dispatcher`/);
    expect(recover).toMatch(/Tasks under `stuck` in `minions work next --json`/);
    expect(await read('skills/status/SKILL.md')).toMatch(/`minions work next --json` shows what can start next and what waits/);
  });
});
