import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateConfig } from '../../src/config/resolve.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { MinionsError } from '../../src/core/errors.js';
import { generatePlugin, PROJECT_PROMPT_MARKER, resolveRolePrompt, roleTools, type GenerateOptions } from '../../src/plugin/generate.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'minions-roles-plugin-')); dirs.push(d); return d; };
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

const withRoles = (roles: Record<string, unknown>, mutate?: (c: Record<string, unknown>) => void): MinionsConfig => {
  const raw = { ...defaults(), roles } as unknown as Record<string, unknown>;
  mutate?.(raw);
  return validateConfig(raw, 'test');
};

async function gen(cfg: MinionsConfig, opts?: GenerateOptions) {
  const out = await tmp();
  const files = await generatePlugin(cfg, out, opts);
  return {
    files, rel: files.map((f) => relative(out, f.path).split('\\').join('/')),
    read: (rel: string) => readFile(join(out, rel), 'utf8'),
    hash: (rel: string) => files.find((f) => relative(out, f.path).split('\\').join('/') === rel)?.sha256,
  };
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
const failure = async (p: Promise<unknown>): Promise<MinionsError> => {
  try { await p; } catch (e) { return e as MinionsError; }
  throw new Error('expected a failure');
};

const researcher = {
  description: 'Researches a question and writes findings to a notes file.',
  promptText: 'Research the question in the task. Literal braces stay: {{notAPlaceholder}} and {{> nopartial}}.\nWrite notes under docs/research/.',
  contract: 'producer',
  edits: { paths: ['docs/research/**'] },
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebSearch', 'Agent', 'SendMessage', 'Task', 'mcp__plugin_telegram_telegram__reply', 'mcp__x__*'],
  model: 'opus',
  effort: 'medium',
  maxTurns: 42,
};

describe('project roles in the plugin (D10)', () => {
  it('renders a project role from _role.md with frontmatter from its fields; _role.md itself is never emitted', async () => {
    const g = await gen(withRoles({ researcher }));
    expect(g.rel).toContain('agents/researcher.md');
    expect(g.rel).not.toContain('agents/_role.md');
    expect(g.rel).not.toContain('agents/researcher-deep.md');
    const md = await g.read('agents/researcher.md');
    const fm = frontmatter(md);
    expect(Object.keys(fm).sort()).toEqual(['description', 'disallowedTools', 'effort', 'maxTurns', 'model', 'name', 'tools']);
    expect(fm.name).toBe('researcher');
    expect(JSON.parse(fm.description!)).toBe('Minions researcher: Researches a question and writes findings to a notes file. Launched only by the minions coordinator with a minions-lease marker.');
    // Agent, SendMessage, Task, MCP tools and patterns are always removed; this role may edit, so Edit/Write stay.
    expect(toolList(fm.tools)).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'WebSearch']);
    expect(toolList(fm.disallowedTools)).toEqual(['Agent', 'SendMessage']);
    expect(fm.model).toBe('opus');
    expect(fm.effort).toBe('medium');
    expect(fm.maxTurns).toBe('42');
    expect(md).not.toContain(PROJECT_PROMPT_MARKER);
  });

  it('inserts the project prompt after rendering: placeholders in it stay literal text', async () => {
    const md = await (await gen(withRoles({ researcher }))).read('agents/researcher.md');
    expect(md).toContain('## Role instructions (from the project)\n\nResearch the question in the task. Literal braces stay: {{notAPlaceholder}} and {{> nopartial}}.\nWrite notes under docs/research/.\n\n## Worktree and changes');
    // the rest of the body is the shared worker text, rendered for this role
    expect(md).toContain('You are the **minions researcher** for one task attempt. This is a project-defined role (producer stage).');
    expect(md).toContain('minions work brief <leaseId> --role researcher --json');
    expect(md).toContain('minions work submit <leaseId> --role researcher --json');
    expect(md).toContain('Not permitted for the researcher');
    expect(md).toContain('`pr.merge`'); // custom roles are denied pr.merge by default (D8)
    expect(md).toContain('You may edit and create files only under `docs/research/**`');
    expect(md).toContain('Status guide (producer stage)');
    for (const f of ['status', 'summary', 'headSha', 'acceptanceEvidence', 'nextAction']) expect(md).toContain(`"${f}"`);
  });

  it('removes Edit/Write when edits is none and for review worktrees; gates get the verdict guide', async () => {
    const g = await gen(withRoles({
      analyst: { description: 'Reads and reports.', promptText: 'Analyse.', contract: 'producer', tools: ['Read', 'Edit', 'Write', 'NotebookEdit', 'Bash'] },
      auditor: { description: 'Audits the head.', promptText: 'Audit.', contract: 'gate' },
    }));
    const analyst = await g.read('agents/analyst.md');
    expect(toolList(frontmatter(analyst).tools)).toEqual(['Read', 'Bash']);
    expect(toolList(frontmatter(analyst).disallowedTools)).toEqual(['Agent', 'SendMessage', 'Edit', 'Write', 'NotebookEdit']);
    expect(analyst).toContain('You may not edit, create or delete files');
    expect(analyst).toContain('Never `git commit`');
    const auditor = await g.read('agents/auditor.md');
    // default tool set without the edit tools
    expect(toolList(frontmatter(auditor).tools)).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(auditor).toContain('read-only review worktree detached at the brief\'s `expectedHead`');
    expect(auditor).toContain('`complete` with `"verdict": "approve"`');
    expect(frontmatter(auditor).model).toBe(defaults().models.default);
    expect(frontmatter(auditor).effort).toBeUndefined();
  });

  it('generates <role>-deep only for deepVariant roles, one effort level higher', async () => {
    const g = await gen(withRoles({ researcher: { ...researcher, deepVariant: true }, writer: { description: 'Writes.', promptText: 'Write.', contract: 'producer', edits: 'any', deepVariant: true } }));
    expect(g.rel).toEqual(expect.arrayContaining(['agents/researcher.md', 'agents/researcher-deep.md', 'agents/writer.md', 'agents/writer-deep.md']));
    const deep = await g.read('agents/researcher-deep.md');
    expect(frontmatter(deep).name).toBe('researcher-deep');
    expect(frontmatter(deep).effort).toBe('high');
    expect(deep).toContain('You are the **minions researcher** (higher reasoning effort)');
    // the deep variant runs under the base role's lease
    expect(deep).toContain('--role researcher --json');
    expect(frontmatter(await g.read('agents/writer-deep.md')).effort).toBe('high');
    expect(frontmatter(await g.read('agents/writer.md')).effort).toBeUndefined();
  });

  it('rejects a project prompt that starts with a frontmatter fence', async () => {
    for (const promptText of ['---\nname: evil\n---\nbody', '\n\n  ---\nx']) {
      const e = await failure(gen(withRoles({ researcher: { ...researcher, promptText } })));
      expect(e.code).toBe('INVALID_CONFIG');
      expect(e.message).toMatch(/roles\.researcher: prompt must not start with a frontmatter fence/);
    }
    // a fence later in the prompt is ordinary Markdown
    const ok = await gen(withRoles({ researcher: { ...researcher, promptText: 'Intro\n\n---\n\nMore' } }));
    expect(await ok.read('agents/researcher.md')).toContain('Intro\n\n---\n\nMore');
  });

  it('resolves prompt files on the host relative to the config dir, staying inside it', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'minions-roles-cfg-'));
    dirs.push(configDir);
    mkdirSync(join(configDir, 'agents'));
    writeFileSync(join(configDir, 'agents', 'researcher.md'), '\uFEFFFrom the file: {{literal}}\r\nSecond line\n\n');
    const { promptText: _drop, ...rest } = researcher;
    const cfg = withRoles({ researcher: { ...rest, prompt: 'agents/researcher.md' } });
    const md = await (await gen(cfg, { configDir })).read('agents/researcher.md');
    expect(md).toContain('## Role instructions (from the project)\n\nFrom the file: {{literal}}\nSecond line\n\n## Worktree');

    // no config dir (e.g. inside the container): refuse rather than render without the prompt
    expect((await failure(gen(cfg))).message).toMatch(/prompt file "agents\/researcher.md" cannot be read here/);
    // missing file
    expect((await failure(gen(withRoles({ researcher: { ...rest, prompt: 'agents/none.md' } }), { configDir }))).message).toMatch(/not found/);
    // a symlink out of the config dir is not followed out
    const outside = mkdtempSync(join(tmpdir(), 'minions-roles-out-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.md'), 'host secret');
    symlinkSync(join(outside, 'secret.md'), join(configDir, 'agents', 'link.md'));
    const e = await failure(gen(withRoles({ researcher: { ...rest, prompt: 'agents/link.md' } }), { configDir }));
    expect(e.code).toBe('INVALID_CONFIG');
    expect(e.message).toMatch(/resolves outside/);
    // `..` and absolute paths are refused even if the config check was bypassed
    for (const prompt of ['../x.md', '/etc/passwd']) {
      expect((await failure(resolveRolePrompt({ name: 'researcher', prompt }, configDir))).message, prompt).toMatch(/must be relative/);
    }
    expect((await failure(resolveRolePrompt({ name: 'researcher', promptText: ' \n ' }))).message).toMatch(/prompt is empty/);
    expect((await failure(resolveRolePrompt({ name: 'researcher', promptText: 'x'.repeat(64 * 1024 + 1) }))).message).toMatch(/larger than 64 KB/);
  });

  it('roleTools keeps order, drops duplicates and never-allowed tools', () => {
    expect(roleTools({ tools: ['Read', 'Read', 'Agent', 'MCP__x', 'mcp__y__z', '*', 'Edit'], edits: 'any', worktree: 'branch' })).toEqual(['Read', 'Edit']);
    expect(roleTools({ tools: ['Read', 'Edit', 'MultiEdit'], edits: 'any', worktree: 'review' })).toEqual(['Read']);
    expect(roleTools({ edits: 'none', worktree: 'branch' })).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
  });
});

describe('built-in overrides in the plugin (D9)', () => {
  it('without overrides the built-ins are byte-identical (empty roles, empty overrides)', async () => {
    const base = await gen(defaults());
    for (const roles of [{}, { engineer: {}, tester: {}, reviewer: {} }]) {
      const g = await gen(withRoles(roles));
      expect(g.files.map((f) => f.sha256)).toEqual(base.files.map((f) => f.sha256));
    }
  });

  it('renders model, effort, maxTurns and tool removal into the built-in frontmatter, deep engineer included', async () => {
    const g = await gen(withRoles({
      engineer: { model: 'opus', effort: 'low', maxTurns: 33, tools: ['Read', 'Grep', 'Glob', 'Bash'], deepEffort: 'max' },
      reviewer: { tools: ['Bash', 'Read'] },
    }));
    const eng = frontmatter(await g.read('agents/engineer.md'));
    expect(eng).toMatchObject({ model: 'opus', effort: 'low', maxTurns: '33', disallowedTools: 'Agent' });
    // the template's order is kept
    expect(toolList(eng.tools)).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    const deep = frontmatter(await g.read('agents/engineer-deep.md'));
    expect(deep).toMatchObject({ name: 'engineer-deep', model: 'opus', effort: 'max', maxTurns: '33' });
    expect(toolList(deep.tools)).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(toolList(frontmatter(await g.read('agents/reviewer.md')).tools)).toEqual(['Read', 'Bash']);
    const tester = frontmatter(await g.read('agents/tester.md'));
    expect(tester).toMatchObject({ model: defaults().models.default, maxTurns: String(defaults().execution.attemptMaxTurns) });
    expect(toolList(tester.tools)).toEqual(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']);
  });

  it('appends promptAppend / a prompt file under "Project instructions", after the built-in body', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'minions-roles-cfg-'));
    dirs.push(configDir);
    writeFileSync(join(configDir, 'reviewer-extra.md'), 'Check the changelog too. {{kept}}\n');
    const base = await gen(defaults());
    const g = await gen(withRoles({ engineer: { promptAppend: 'Always run `make lint`.' }, reviewer: { prompt: 'reviewer-extra.md' } }), { configDir });
    for (const agent of ['engineer', 'engineer-deep']) {
      const before = await base.read(`agents/${agent}.md`);
      const after = await g.read(`agents/${agent}.md`);
      expect(after).toBe(`${before.replace(/\n*$/, '\n')}\n## Project instructions\n\nAlways run \`make lint\`.\n`);
    }
    expect(await g.read('agents/reviewer.md')).toMatch(/Reviewer status and verdict:[^\n]*\n\n## Project instructions\n\nCheck the changelog too\. \{\{kept\}\}\n$/);
    expect(g.hash('agents/tester.md')).toBe(base.hash('agents/tester.md'));
    expect((await failure(gen(withRoles({ tester: { promptAppend: '---\nx: y\n---' } })))).message).toMatch(/roles\.tester: prompt must not start with a frontmatter fence/);
  });
});
