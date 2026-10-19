import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePlugin, renderPolicySummary, renderTemplate } from '../../src/plugin/generate.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'minions-plugin-')); dirs.push(d); return d; };
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function gen(cfg: MinionsConfig = defaults()) {
  const out = await tmp();
  const files = await generatePlugin(cfg, out);
  const read = (rel: string) => readFile(join(out, rel), 'utf8');
  return { out, files, rel: files.map((f) => relative(out, f.path).split('\\').join('/')), read };
}

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error('no frontmatter');
  return Object.fromEntries(m[1]!.split('\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
}
const toolList = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const EXPECTED = [
  '.claude-plugin/plugin.json',
  'agents/engineer.md', 'agents/reviewer.md', 'agents/tester.md',
  'coordinator.md',
  'hooks/hooks.json',
  'skills/intake/SKILL.md', 'skills/maintain-context/SKILL.md', 'skills/orchestrate/SKILL.md',
  'skills/recover/SKILL.md', 'skills/status/SKILL.md',
];
const AGENT_FIELDS = new Set(['name', 'description', 'tools', 'disallowedTools', 'model', 'maxTurns', 'effort', 'skills', 'color']);

describe('generatePlugin', () => {
  it('writes the expected files with absolute paths, sorted, with sha256', async () => {
    const { files, rel, out } = await gen();
    expect([...rel].sort()).toEqual(EXPECTED);
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort());
    for (const f of files) {
      expect(f.path.startsWith(out)).toBe(true);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(rel.some((r) => r.includes('_partials'))).toBe(false);
  });

  it('renders every placeholder', async () => {
    const { rel, read } = await gen();
    for (const r of rel) {
      const text = await read(r);
      expect(text, r).not.toMatch(/\{\{|\}\}/);
    }
  });

  it('agent frontmatter uses only allowed fields; workers lack Agent; reviewer is read-only', async () => {
    const cfg = defaults();
    const { read } = await gen(cfg);
    for (const role of ['engineer', 'tester', 'reviewer']) {
      const fm = frontmatter(await read(`agents/${role}.md`));
      for (const k of Object.keys(fm)) expect(AGENT_FIELDS.has(k), `${role}: ${k}`).toBe(true);
      expect(fm.name).toBe(role);
      expect(fm.description).toBeTruthy();
      expect(fm.model).toBe(cfg.models.default);
      expect(fm.maxTurns).toBe(String(cfg.execution.attemptMaxTurns));
      const tools = toolList(fm.tools);
      expect(tools).not.toContain('Agent');
      expect(toolList(fm.disallowedTools)).toContain('Agent');
      if (role === 'reviewer') {
        expect(tools.sort()).toEqual(['Bash', 'Glob', 'Grep', 'Read']);
        expect(tools).not.toContain('Edit');
        expect(tools).not.toContain('Write');
      } else {
        expect(tools.sort()).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
      }
    }
  });

  it('worker prompts include the result contract and role policy', async () => {
    const { read } = await gen();
    for (const role of ['engineer', 'tester', 'reviewer']) {
      const md = await read(`agents/${role}.md`);
      for (const f of ['status', 'summary', 'branch', 'headSha', 'modifiedPaths', 'checks', 'acceptanceEvidence', 'findings', 'nextAction']) {
        expect(md, `${role} ${f}`).toContain(`"${f}"`);
      }
      expect(md).toContain('needs_split');
      expect(md).toContain('minions-lease');
      expect(md).toContain(`Not permitted for the ${role}`);
    }
    expect(await read('agents/reviewer.md')).toContain('"verdict": "approve"');
  });

  it('skill frontmatter has name and description only', async () => {
    const { read } = await gen();
    for (const s of ['orchestrate', 'status', 'intake', 'recover', 'maintain-context']) {
      const fm = frontmatter(await read(`skills/${s}/SKILL.md`));
      expect(Object.keys(fm).sort()).toEqual(['description', 'name']);
      expect(fm.name).toBe(s);
    }
  });

  it('plugin.json and hooks.json have the expected shape', async () => {
    const cfg = defaults();
    const { read } = await gen(cfg);
    const manifest = JSON.parse(await read('.claude-plugin/plugin.json'));
    expect(manifest.name).toBe('minions');
    expect(manifest.version).toBe(cfg.packageVersion);
    const hooks = JSON.parse(await read('hooks/hooks.json'));
    expect(Object.keys(hooks)).toEqual(['hooks']);
    expect(hooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'minions hook stop' }] }]);
    expect(hooks.hooks.PreToolUse).toEqual([{ matcher: 'Agent', hooks: [{ type: 'command', command: 'minions hook pre-agent' }] }]);
  });

  it('is deterministic for the same config', async () => {
    const a = await gen();
    const b = await gen();
    expect(a.files.map((f) => f.sha256)).toEqual(b.files.map((f) => f.sha256));
  });

  it('config changes are reflected in coordinator.md', async () => {
    const base = defaults();
    const a = await gen(base);
    const coord = await a.read('coordinator.md');
    expect(coord).toContain(`At most ${base.execution.maxActiveTasks} active tasks and ${base.execution.maxEngineers} concurrent engineers`);
    expect(coord).toContain('minions export');

    const hash = (g: Awaited<ReturnType<typeof gen>>) => g.files.find((f) => f.path.endsWith('coordinator.md'))!.sha256;
    const more = await gen({ ...base, execution: { ...base.execution, maxActiveTasks: 5, maxEngineers: 4 } });
    expect(hash(more)).not.toBe(hash(a));
    expect(await more.read('coordinator.md')).toContain('4 concurrent engineers');

    const sens = await gen({ ...base, sensitivePaths: [...base.sensitivePaths, 'secret/**'] });
    expect(hash(sens)).not.toBe(hash(a));
    expect(await sens.read('coordinator.md')).toContain('`secret/**`');
    expect(await sens.read('agents/engineer.md')).toContain('`secret/**`');
  });

  it('renders model guidance for fixed selection', async () => {
    const base = defaults();
    const g = await gen({ ...base, models: { ...base.models, selection: 'fixed' } });
    expect(await g.read('coordinator.md')).toContain('Selection is fixed');
  });
});

describe('renderTemplate', () => {
  const r = (t: string, json = false) => renderTemplate(t, { a: 'x"y' }, { p: 'P {{a}}' }, { name: 't', json });
  it('substitutes vars and partials', () => {
    expect(r('{{a}} {{> p}}')).toBe('x"y P x"y');
    expect(r('{"k": "{{a}}"}', true)).toBe('{"k": "x\\"y"}');
  });
  it('rejects unknown and malformed placeholders', () => {
    expect(() => r('{{b}}')).toThrow(/unknown placeholder/);
    expect(() => r('{{> q}}')).toThrow(/unknown partial/);
    expect(() => r('{{ a-b }}')).toThrow(/malformed/);
  });
  it('does not reinterpret braces inside values', () => {
    expect(renderTemplate('{{a}}', { a: '{{x}}' }, {}, { name: 't' })).toBe('{{x}}');
  });
});

describe('renderPolicySummary', () => {
  it('is role-aware', () => {
    const cfg = defaults();
    expect(renderPolicySummary(cfg, 'reviewer')).toMatch(/Not permitted for the reviewer: .*code\.edit/);
    expect(renderPolicySummary(cfg, 'engineer')).not.toMatch(/Not permitted for the engineer: .*code\.edit/);
  });
});

const hasClaude = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.runIf(process.env.MINIONS_LIVE_CLAUDE === '1' && hasClaude)('claude plugin validate', () => {
  it('accepts the generated plugin', async () => {
    const { out } = await gen();
    const res = spawnSync('claude', ['plugin', 'validate', '--strict', out], { encoding: 'utf8', timeout: 60_000 });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  }, 70_000);
});

describe('Telegram tools are coordinator-only', () => {
  const telegram = () => { const c = defaults(); c.communication.channel = 'telegram'; return c; };

  it('worker agents have explicit tool allowlists with no MCP (Telegram) tools when Telegram is configured', async () => {
    const { read } = await gen(telegram());
    for (const role of ['engineer', 'tester', 'reviewer']) {
      const md = await read(`agents/${role}.md`);
      const fm = frontmatter(md);
      const tools = toolList(fm.tools);
      expect(tools.length, role).toBeGreaterThan(0); // an explicit allowlist: omitted `tools` would inherit every tool
      for (const t of tools) expect(t, role).toMatch(/^(Read|Edit|Write|Grep|Glob|Bash)$/);
      expect(md, role).not.toMatch(/mcp__|telegram/i);
      expect(toolList(fm.disallowedTools)).toContain('Agent');
    }
  });

  it('only the coordinator prompt describes the Telegram channel and its access rules', async () => {
    const { read } = await gen(telegram());
    const coord = await read('coordinator.md');
    expect(coord).toContain('Communication channel: Telegram');
    expect(coord).toContain('the plugin drops unpaired senders');
    expect(coord).toMatch(/Never give them to workers/);
    expect(coord).toMatch(/Pairing and access changes .* happen only in the terminal/);
    const term = await gen();
    expect(await term.read('coordinator.md')).toContain('Telegram is not configured for this project.');
  });
});

describe('models.effort / models.coordinator', () => {
  const withModels = (m: Partial<MinionsConfig['models']>): MinionsConfig => {
    const c = defaults();
    c.models = { ...c.models, default: 'claude-opus-5-5', allowed: ['claude-opus-5-5', 'sonnet', 'opus', 'haiku'], ...m };
    return c;
  };

  it('worker frontmatter gets `effort` only when set; the coordinator guidance mentions it', async () => {
    const g = await gen(withModels({ effort: 'medium' }));
    for (const a of ['engineer', 'tester', 'reviewer']) {
      const fm = frontmatter(await g.read(`agents/${a}.md`));
      expect(fm.model).toBe('claude-opus-5-5');
      expect(fm.effort).toBe('medium');
    }
    expect(await g.read('coordinator.md')).toMatch(/reasoning effort `medium`/);
    const plain = await gen();
    expect(frontmatter(await plain.read('agents/engineer.md'))).not.toHaveProperty('effort');
    expect(await plain.read('coordinator.md')).not.toMatch(/reasoning effort/);
  });
});
