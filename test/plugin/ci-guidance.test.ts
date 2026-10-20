import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { generatePlugin } from '../../src/plugin/generate.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function gen(mutate: (c: MinionsConfig) => void = () => {}) {
  const cfg = defaults();
  cfg.verification.commands = ['npm run typecheck', 'npm test'];
  mutate(cfg);
  const out = await mkdtemp(join(tmpdir(), 'minions-plugin-ci-'));
  dirs.push(out);
  await generatePlugin(cfg, out);
  return (rel: string) => readFile(join(out, rel), 'utf8');
}

describe('CI evidence guidance in the generated plugin', () => {
  it('ciAuthority github: tester and reviewer may rely on a passing CI gate, never on missing CI', async () => {
    const read = await gen((c) => { c.verification.ciAuthority = 'github'; });
    for (const f of ['agents/tester.md', 'agents/reviewer.md']) {
      const t = await read(f);
      expect(t, f).toContain('## CI evidence');
      expect(t, f).toMatch(/`ci\.state` `pass`: you may rely on CI instead of re-running the full verification/);
      expect(t, f).toContain('"source": "ci"');
      expect(t, f).toMatch(/Any other state .* CI is not evidence\. Run the verification commands \(`npm run typecheck`, `npm test`\) locally/);
      expect(t, f).toMatch(/missing, failing, pending or unreadable CI never approves/);
      expect(t, f).not.toContain('{{');
    }
    const skill = await read('skills/orchestrate/SKILL.md');
    expect(skill).toMatch(/Run `minions sync` once before claiming a tester\/reviewer/);
    expect(skill).toMatch(/CI `fail` → `changes-requested`/);
    expect(skill).toMatch(/Never approve or report a task as verified on missing CI/);
    // Engineers keep running their own checks; the contract documents the source field.
    const eng = await read('agents/engineer.md');
    expect(eng).not.toContain('## CI evidence');
    expect(eng).toMatch(/`checks\[\]\.source` \(optional\): `local` \(default/);
  });

  it('ciAuthority none: workers verify locally and must not cite CI', async () => {
    const read = await gen();
    expect(await read('agents/reviewer.md')).toMatch(/CI is not a verification authority for this project/);
    expect(await read('agents/tester.md')).toMatch(/Never report a check with `"source": "ci"`/);
    expect(await read('skills/orchestrate/SKILL.md')).toMatch(/testers and reviewers verify locally/);
  });
});
