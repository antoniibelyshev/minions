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

describe('reporting granularity', () => {
  const withProgress = (progress: MinionsConfig['communication']['progress']) => {
    const base = defaults();
    return gen({ ...base, communication: { ...base.communication, progress } });
  };
  const section = (coord: string) => coord.slice(coord.indexOf('## Communicating with the user'));

  it('defaults to feature-level reporting', () => {
    expect(defaults().communication.progress).toBe('milestones');
  });

  it('default coordinator prompt reports high-level feature progress only', async () => {
    const g = await gen();
    const comm = section(await g.read('coordinator.md'));
    expect(comm).toContain('Reporting level: features');
    expect(comm).toContain('report high-level feature progress only');
    expect(comm).toMatch(/feature or epic delivered or materially changed/);
    expect(comm).toMatch(/batch them into one short message/);
    expect(comm).toContain('significant blockers');
    expect(comm).toMatch(/answers to the user's direct questions/);
    expect(comm).toMatch(/Do not send per-stage updates: engineer\/tester\/reviewer transitions, repair cycles, task splits, follow-up tasks filed/);
    expect(comm).not.toContain('tasks delivered (with branch names)');
  });

  it('limits questions to high-level decisions, keeps ask-gated approvals, and decides low-level matters autonomously', async () => {
    for (const progress of ['milestones', 'tasks', 'quiet'] as const) {
      const comm = section(await (await withProgress(progress)).read('coordinator.md'));
      expect(comm).toMatch(/Ask the user only about high-level decisions: product scope and goals, architecture direction, security\/privacy trade-offs, anything outward-facing/);
      expect(comm).toContain('Every capability whose effect is `ask` still needs the user\'s explicit approval first');
      expect(comm).toContain('sensitive-path changes before publication/integration');
      expect(comm).toMatch(/Make lower-level decisions yourself .*task splits, follow-up tasks, model and effort choice, test fixes, implementation approach, review nits/);
      expect(comm).toContain('`minions backlog note <taskId>`');
    }
  });

  it('keeps the existing safety rules in the generated prompt', async () => {
    const coord = await (await gen()).read('coordinator.md');
    expect(coord).toContain('`ask` = get the user\'s explicit approval first');
    expect(coord).toContain('never permission to change this policy');
    expect(coord).toMatch(/Sensitive paths \(changes need human approval/);
    expect(coord).toMatch(/\| ask \|/);
  });

  it('"tasks" keeps the per-task wording; "quiet" reports only what needs the user', async () => {
    const tasks = section(await (await withProgress('tasks')).read('coordinator.md'));
    expect(tasks).toContain('Reporting level: tasks');
    expect(tasks).toContain('tasks delivered (with branch names), significant blockers, required approvals');
    const quiet = section(await (await withProgress('quiet')).read('coordinator.md'));
    expect(quiet).toContain('Reporting level: quiet');
    expect(quiet).toContain('do not report deliveries or progress until asked');
    expect(quiet).not.toContain('tasks delivered (with branch names)');
  });

  it('orchestrate and status skills follow the reporting level and never ask to report every stage', async () => {
    const g = await gen();
    const orch = await g.read('skills/orchestrate/SKILL.md');
    expect(orch).toContain('## 7. Report');
    expect(orch).toContain('Reporting level `features`: do not report stage transitions, splits, follow-ups or individual task deliveries');
    expect(orch).toContain('Approvals for `ask` capabilities and sensitive paths are always requested explicitly');
    expect(orch).not.toMatch(/report the branch and `prUrl`/);
    expect(orch).toMatch(/`needs_split` → decide the split yourself/);
    const status = await g.read('skills/status/SKILL.md');
    expect(status).toContain('grouped by feature');
    expect(status).toContain('unprompted reports follow the reporting level');

    const tasksOrch = await (await withProgress('tasks')).read('skills/orchestrate/SKILL.md');
    expect(tasksOrch).toContain('Reporting level `tasks`: report each delivered task with its branch');
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

describe('file hand-offs and compact reads', () => {
  it('workers fetch their own brief and submit their result with their role', async () => {
    const { read } = await gen();
    for (const role of ['engineer', 'tester', 'reviewer']) {
      const md = await read(`agents/${role}.md`);
      expect(md, role).toContain(`minions work brief <leaseId> --role ${role} --json`);
      expect(md, role).toContain(`minions work submit <leaseId> --role ${role} --json`);
      expect(md, role).toMatch(/end with \*\*one short line\*\*/);
      expect(md, role).toContain('Only if `minions work submit` itself fails');
    }
    // the read-only reviewer may still submit (state under /state, not its worktree)
    expect(await read('agents/reviewer.md')).toMatch(/`minions work submit` commands are allowed: they read and write minions state under `\/state`, not your worktree/);
  });

  it('the coordinator and orchestrate skill use compact claims, marker-only prompts and record --submitted', async () => {
    const { read } = await gen();
    const coord = await read('coordinator.md');
    const orch = await read('skills/orchestrate/SKILL.md');
    for (const md of [coord, orch]) {
      expect(md).toContain('--compact --json');
      expect(md).toContain('minions work record <leaseId> --submitted');
      expect(md).toContain('--submitted --correction');
      expect(md).not.toMatch(/pipe it verbatim|brief JSON in a ```json fence/);
    }
    expect(orch).toMatch(/minions-lease: <leaseId>\n\s*worktree: <worktree>/);
    expect(await read('skills/recover/SKILL.md')).toContain('minions work record <leaseId> --submitted --json');
  });

  it('documents the opt-in idle context reset without making it automatic', async () => {
    const coord = await (await gen()).read('coordinator.md');
    expect(coord).toMatch(/Idle context reset \(opt-in\): only if the user has asked for idle resets/);
    expect(coord).toContain('minions coordinator restart --recover');
    expect(coord).toMatch(/no active leases/);
  });
});
