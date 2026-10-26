// task-14.7 (agent-runtimes D8): coordinator.md and the orchestrate skill say how a `launch.kind: "run"` stage is
// started (claim, then `minions work run <leaseId> --json` with Bash in the background) and recorded (no --usage).
// The text is rendered only when a role runs on a process harness, so Claude-only prompts stay as they were.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RUN_COMMAND_TEMPLATE } from '../../src/config/launch.js';
import { validateConfig } from '../../src/config/resolve.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function gen(cfg: MinionsConfig) {
  const out = await mkdtemp(join(tmpdir(), 'minions-plugin-harness-'));
  dirs.push(out);
  await generatePlugin(cfg, out);
  return (rel: string) => readFile(join(out, rel), 'utf8');
}

/** The phase 1 (b) pilot as setup writes it: a codex-reviewer gate after the Claude reviewer. */
const pilot = (): MinionsConfig => {
  const c = defaults();
  return validateConfig({
    ...c,
    harnesses: { default: 'codex', codex: { models: { default: 'gpt-test', allowed: ['gpt-test'] } } },
    roles: { 'codex-reviewer': { description: 'Second review.', promptText: 'Review.', contract: 'gate', harness: 'codex' } },
    workflows: { default: ['engineer', { role: 'tester', when: 'qa' }, 'reviewer', 'codex-reviewer'] },
  }, 'test');
};

describe('process-harness dispatch guidance', () => {
  it('a process role gets the run procedure in coordinator.md and orchestrate', async () => {
    const read = await gen(pilot());
    const coord = await read('coordinator.md');
    expect(coord).toContain('Process-harness stages (`codex-reviewer` on OpenAI Codex CLI): their `work next` entry has `launch.kind: "run"`');
    expect(coord).toContain(`\`${RUN_COMMAND_TEMPLATE}\``);
    expect(coord).toMatch(/Bash \(`run_in_background: true`, from the repository, not a worktree\)/);
    expect(coord).toMatch(/Never use the Agent tool for them/);
    expect(coord).toMatch(/record with `minions work record <leaseId> --submitted --json` \(no `--usage`: the runner recorded the usage\)/);
    expect(coord).toMatch(/--json`\.\n\nProcess-harness stages[^\n]*\n\nStage order per task/);

    const orch = await read('skills/orchestrate/SKILL.md');
    expect(orch).toContain('### Process-harness stages (`launch.kind: "run"`)');
    expect(orch).toContain('Roles on a process harness here: `codex-reviewer` on OpenAI Codex CLI.');
    expect(orch).toMatch(/run `launch\.command` with `<leaseId>` replaced by the claimed lease \(`minions work run <leaseId> --json`\) through Bash with `run_in_background: true`/);
    expect(orch).toMatch(/`submitted: true`: record with `minions work record <leaseId> --submitted --json`, without `--usage`/);
    expect(orch).toMatch(/`violations` not empty: .*tell the owner/);
    expect(orch).toMatch(/Invalid result \(`valid: false`\): there is no live worker to correct/);
    expect(orch).toMatch(/never start `work run` again for the same lease/);
    expect(orch).toMatch(/Stop a running process worker only with `minions work release <leaseId>/);
    expect(orch).toMatch(/A process-harness run \(`launch.kind: "run"`\) records its own usage: record it without `--usage`\./);
    expect(orch).toMatch(/record it as usual\.\n\nIndependent tasks may run in parallel/);
    // No Claude agent definition for the process role (unchanged from task-14.2).
    await expect(read('agents/codex-reviewer.md')).rejects.toThrow();
  });

  it('Claude-only configs get no process-harness text and no stray blank lines', async () => {
    const read = await gen(defaults());
    const coord = await read('coordinator.md');
    const orch = await read('skills/orchestrate/SKILL.md');
    expect(coord).not.toContain('Process-harness stages');
    expect(orch).not.toContain('Process-harness stages');
    expect(coord).toMatch(/--json`\.\n\nStage order per task/);
    expect(orch).toMatch(/A task never has two workers at once\./);
    expect(orch).toMatch(/\n\nIndependent tasks may run in parallel/);
    expect(orch).not.toMatch(/\n\n\nIndependent tasks/);
    // A codex block alone (no role on it) changes nothing either.
    const c = defaults();
    const only = await gen(validateConfig({ ...c, harnesses: { codex: { models: { default: 'gpt-test', allowed: ['gpt-test'] } } } }, 'test'));
    expect(await only('coordinator.md')).toBe(coord);
  });
});
