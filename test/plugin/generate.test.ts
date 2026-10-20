import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePlugin, renderPolicySummary, renderTemplate } from '../../src/plugin/generate.js';
import { DRAIN_HOOK_COMMAND } from '../../src/runtime/drain.js';
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
  'agents/engineer-deep.md', 'agents/engineer.md', 'agents/reviewer.md', 'agents/tester.md',
  'coordinator.md',
  'hooks/hooks.json',
  'skills/intake/SKILL.md', 'skills/maintain-context/SKILL.md', 'skills/orchestrate/SKILL.md',
  'skills/recover/SKILL.md', 'skills/status/SKILL.md',
];
/** Generated worker definitions and the lease role each runs under. */
const WORKER_AGENTS = [['engineer', 'engineer'], ['engineer-deep', 'engineer'], ['tester', 'tester'], ['reviewer', 'reviewer']] as const;
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
    for (const [agent, role] of WORKER_AGENTS) {
      const fm = frontmatter(await read(`agents/${agent}.md`));
      for (const k of Object.keys(fm)) expect(AGENT_FIELDS.has(k), `${agent}: ${k}`).toBe(true);
      expect(fm.name).toBe(agent);
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
    for (const [agent, role] of WORKER_AGENTS) {
      const md = await read(`agents/${agent}.md`);
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
    expect(hooks.hooks.PreToolUse).toEqual([
      { matcher: 'Agent', hooks: [{ type: 'command', command: 'minions hook pre-agent' }] },
      // Every tool; gated by a shell test so node starts only while a drain is requested.
      { matcher: '*', hooks: [{ type: 'command', command: DRAIN_HOOK_COMMAND }] },
    ]);
  });

  it('tells the coordinator, the skills and the workers how a drain winds work down', async () => {
    const { read } = await gen(defaults());
    expect(await read('coordinator.md')).toMatch(/Drain \(`minions status --json` shows `draining`.*start nothing.*`drain: true`: not a failed attempt or a repair cycle.*\/minions:recover` re-dispatches the drained tasks to the same role/);
    expect(await read('skills/orchestrate/SKILL.md')).toMatch(/If `draining` is set .*start nothing/);
    expect(await read('skills/recover/SKILL.md')).toMatch(/Drained tasks .*re-dispatch the same role/);
    for (const role of ['engineer', 'tester', 'reviewer']) {
      const md = await read(`agents/${role}.md`);
      expect(md).toMatch(/upgrade is pending \(a drain\).*prefix `wip:`.*`partial` result.*Never discard uncommitted changes/);
      expect(md).toMatch(/A `resume` field means the previous worker was wound down by a drain/);
    }
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
    const coord = await g.read('coordinator.md');
    expect(coord).toContain('Selection is fixed: omit `model` so every worker runs `sonnet` from its definition.');
    expect(coord).not.toMatch(/model: "/);
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

// Opt-in (MINIONS_LIVE_CLAUDE=1). The real claude runs with a temp HOME and CLAUDE_CONFIG_DIR so the
// user's enabled plugins (e.g. the Telegram channel, which would take over a running poller) never load.
const live = process.env.MINIONS_LIVE_CLAUDE === '1';
const hasClaude = live && (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.runIf(hasClaude)('claude plugin validate', () => {
  it('accepts the generated plugin', async () => {
    const { out } = await gen();
    const home = await tmp();
    const res = spawnSync('claude', ['plugin', 'validate', '--strict', out],
      { encoding: 'utf8', timeout: 60_000, cwd: home, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') } });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  }, 70_000);
});

describe('Telegram tools are coordinator-only', () => {
  const telegram = () => { const c = defaults(); c.communication.channel = 'telegram'; return c; };

  it('worker agents have explicit tool allowlists with no MCP (Telegram) tools when Telegram is configured', async () => {
    const { read } = await gen(telegram());
    for (const [role] of WORKER_AGENTS) {
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
    const terminal = defaults(); terminal.communication.channel = 'terminal';
    const term = await gen(terminal);
    expect(await term.read('coordinator.md')).toContain('Telegram is not configured for this project.');
    const auto = await gen();
    expect(await auto.read('coordinator.md')).toContain('Communication channel: auto (Telegram when a bot token is provisioned for this project, otherwise terminal)');
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
    expect(frontmatter(await g.read('agents/engineer-deep.md')).effort).toBe('high');
    expect(await g.read('coordinator.md')).toMatch(/reasoning effort engineer `medium`, tester `medium`, reviewer `medium`/);
    const plain = await gen();
    for (const a of ['engineer', 'tester', 'reviewer']) expect(frontmatter(await plain.read(`agents/${a}.md`)), a).not.toHaveProperty('effort');
    expect(frontmatter(await plain.read('agents/engineer-deep.md')).effort).toBe('high');
    expect(await plain.read('coordinator.md')).toMatch(/reasoning effort engineer the Claude Code default, tester the Claude Code default/);
  });

  it('effortByRole overrides models.effort per role; engineer-deep defaults to one level above the engineer', async () => {
    const g = await gen(withModels({ effort: 'medium', effortByRole: { engineer: 'low', coordinator: 'high' } }));
    const fx = async (a: string) => frontmatter(await g.read(`agents/${a}.md`)).effort;
    expect(await fx('engineer')).toBe('low');
    expect(await fx('engineer-deep')).toBe('medium');
    expect(await fx('tester')).toBe('medium');
    expect(await fx('reviewer')).toBe('medium');
    const coord = await g.read('coordinator.md');
    expect(coord).toMatch(/reasoning effort engineer `low`, tester `medium`, reviewer `medium`/);
    expect(coord).toMatch(/spawn `minions:engineer-deep` instead of `minions:engineer`: the same engineer under the same engineer lease, at effort `medium`/);

    const explicit = await gen(withModels({ effortByRole: { engineer: 'low', engineerDeep: 'xhigh', reviewer: 'high' } }));
    expect(frontmatter(await explicit.read('agents/engineer-deep.md')).effort).toBe('xhigh');
    expect(frontmatter(await explicit.read('agents/reviewer.md')).effort).toBe('high');
    expect(frontmatter(await explicit.read('agents/tester.md'))).not.toHaveProperty('effort');
    const capped = await gen(withModels({ effortByRole: { engineer: 'max' } }));
    expect(frontmatter(await capped.read('agents/engineer-deep.md')).effort).toBe('max');
  });

  it('engineer-deep is the engineer template under its own name, model and engineer role', async () => {
    const g = await gen(withModels({ effortByRole: { engineer: 'low' } }));
    const deep = await g.read('agents/engineer-deep.md');
    const eng = await g.read('agents/engineer.md');
    const fm = frontmatter(deep);
    expect(fm.name).toBe('engineer-deep');
    expect(fm.model).toBe('claude-opus-5-5');
    expect(fm.description).toMatch(/^Minions engineer \(higher reasoning effort, for hard debugging, architecture work, or after a failed attempt\)\./);
    expect(frontmatter(eng).description).toMatch(/^Minions engineer\. /);
    const body = (md: string) => md.slice(md.indexOf('\n---\n') + 5);
    expect(body(deep)).toBe(body(eng));
    expect(deep).toContain('Not permitted for the engineer');
  });

  it('never tells the coordinator to pass a full model id as the Agent `model`', async () => {
    for (const cfg of [withModels({}), withModels({ selection: 'fixed' }), defaults(), withModels({ allowed: ['claude-opus-5-5', 'claude-sonnet-5', 'haiku'] })]) {
      const g = await gen(cfg);
      for (const f of ['coordinator.md', 'skills/orchestrate/SKILL.md']) {
        const text = await g.read(f);
        const passed = [...text.matchAll(/model: "([^"]+)"/g)].map((m) => m[1]);
        for (const m of passed) expect(['sonnet', 'opus', 'haiku', 'fable'], `${f}: ${m}`).toContain(m);
        if (cfg.models.selection === 'coordinator') expect(text, f).toMatch(/omit `model` \(the definitions run `[^`]+`\)/);
      }
    }
    const g = await gen(withModels({}));
    const coord = await g.read('coordinator.md');
    expect(coord).toContain('Pass `model` only as one of the aliases `sonnet`, `opus`, `haiku`, `fable`, never a full model ID');
    expect(coord).toContain('`model: "haiku"` for narrow inspection');
    const extra = await (await gen(withModels({ allowed: ['claude-opus-5-5', 'claude-sonnet-5', 'haiku'] }))).read('coordinator.md');
    expect(extra).toContain('Allowed full IDs other than the default (`claude-sonnet-5`) cannot be chosen per call.');
    expect(await g.read('skills/orchestrate/SKILL.md')).toMatch(/`minions:engineer-deep` instead of `minions:engineer` for hard debugging, architecture work, or a retry after an engineer attempt failed/);
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
      expect(md, role).toContain('end with exactly one line, `brief unavailable: <error>`, and no WorkerResult');
      expect(md, role).not.toMatch(/fetch fails, report `blocked`/);
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
      // older-CLI fallback: plain claim with pasted brief, record via stdin
      expect(md).toContain('Older CLI fallback: if `--compact`, `work brief` or `--submitted` is rejected as an unknown option or command, claim without `--compact` and paste the brief in a ```json fence after the marker and worktree lines');
      expect(md).toContain("piping the worker's final JSON to `minions work record <leaseId> --json` on stdin");
      expect(md).toMatch(/`brief unavailable: <error>`.*do not record it.*[Rr]elease/s);
    }
    expect(orch).toMatch(/minions-lease: <leaseId>\n\s*worktree: <worktree>/);
    const recover = await read('skills/recover/SKILL.md');
    expect(recover).toContain('minions work record <leaseId> --submitted --json');
    expect(recover).toMatch(/On `PRECONDITION` about a pending correction.*--submitted --correction --json/);
  });

  it('documents the opt-in idle context reset without making it automatic', async () => {
    const coord = await (await gen()).read('coordinator.md');
    expect(coord).toMatch(/Idle context reset \(opt-in\): only if the user has asked for idle resets/);
    expect(coord).toContain('minions coordinator restart --recover');
    expect(coord).toMatch(/no active leases/);
  });
});

describe('file hand-off templates render completely (task-9 edge cases)', () => {
  it('no generated file keeps an unrendered placeholder, and each worker gets its own role in the commands', async () => {
    const { read, rel } = await gen();
    for (const f of rel) {
      const text = await read(f);
      expect(text, f).not.toMatch(/\{\{|\}\}/);
      expect(text, f).not.toContain('--role {{');
    }
    for (const [agent, role] of WORKER_AGENTS) {
      const md = await read(`agents/${agent}.md`);
      const roles = [...md.matchAll(/minions work (?:brief|submit) <leaseId> --role (\w+)/g)].map((m) => m[1]);
      expect(roles.length, role).toBeGreaterThanOrEqual(2);
      expect(new Set(roles), role).toEqual(new Set([role]));
      expect(md, role).toContain('minions-lease: <leaseId>');
    }
  });

  it('the reviewer stays read-only on its worktree while being allowed to submit', async () => {
    const { read } = await gen();
    const md = await read('agents/reviewer.md');
    const fm = frontmatter(md);
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent']) expect(toolList(fm.disallowedTools)).toContain(t);
    expect(toolList(fm.tools)).not.toContain('Edit');
    expect(toolList(fm.tools)).not.toContain('Write');
    expect(md).toMatch(/Never edit, create or delete files in the repository or worktree/);
    expect(md).toMatch(/never `git commit`/);
    expect(md).toContain('minions work submit <leaseId> --role reviewer --json');
  });
});

describe('coordinator prompt: origin/<base> as the single source of truth', () => {
  it('GitHub delivery forbids local base merges and explains the pre-claim sync; local delivery does not', async () => {
    for (const mode of ['branch', 'pull-request'] as const) {
      const cfg = defaults();
      cfg.delivery.mode = mode;
      cfg.delivery.provider = 'github';
      const md = await (await gen(cfg)).read('coordinator.md');
      expect(md).toContain('`origin/main` is the single source of truth');
      expect(md).toMatch(/never merge, rebase, cherry-pick or commit into the local `main`/);
      expect(md).toMatch(/Every `minions work claim` first fetches origin and fast-forwards `main`/);
      expect(md).toMatch(/do not repair it by merging or resetting yourself/);
    }
    const local = await (await gen(defaults())).read('coordinator.md');
    expect(local).not.toContain('single source of truth');
    expect(local).toContain('the user fetches branches with `minions export` on the host');
  });
});
