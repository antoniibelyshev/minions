// task-14.7 (agent-runtimes D8): with a role on a process harness, coordinator.md and the orchestrate skill say what
// its holds mean (the dispatcher runs it through `minions work run`, docs/design/autonomy.md Decision 10). The text is
// rendered only when a role runs on a process harness, so Claude-only prompts stay as they were.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

describe('process-harness guidance', () => {
  it('a process role gets what its holds mean in coordinator.md and orchestrate', async () => {
    const read = await gen(pilot());
    for (const text of [await read('coordinator.md'), await read('skills/orchestrate/SKILL.md')]) {
      expect(text).toContain('Roles on a process harness here: `codex-reviewer` on OpenAI Codex CLI. The dispatcher runs them through the process runner (`minions work run`)');
      expect(text).toMatch(/`harness-violation:` is a security event.*tell the owner/);
      expect(text).toMatch(/A `launch-failed` hold .* is fixed by the owner on the host/);
    }
    expect(await read('coordinator.md')).toMatch(/minions:orchestrate` describes[^\n]*\n\nRoles on a process harness here[^\n]*\n\nStage order per task/);
    // No Claude agent definition for the process role (unchanged from task-14.2).
    await expect(read('agents/codex-reviewer.md')).rejects.toThrow();
  });

  it('Claude-only configs get no process-harness text and no stray blank lines', async () => {
    const read = await gen(defaults());
    const coord = await read('coordinator.md');
    const orch = await read('skills/orchestrate/SKILL.md');
    expect(coord).not.toContain('Roles on a process harness');
    expect(orch).not.toContain('Roles on a process harness');
    expect(coord).toMatch(/never read full briefs or worker result JSON\.\n\nStage order per task/);
    expect(orch).toMatch(/\n\nWhat the dispatcher does without you/);
    // A codex block alone (no role on it) changes nothing either.
    const c = defaults();
    const only = await gen(validateConfig({ ...c, harnesses: { codex: { models: { default: 'gpt-test', allowed: ['gpt-test'] } } } }, 'test'));
    expect(await only('coordinator.md')).toBe(coord);
  });
});
