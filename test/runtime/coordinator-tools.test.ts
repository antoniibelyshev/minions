import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/resolve.js';
import { COORDINATOR_DISALLOWED_TOOLS, COORDINATOR_REQUIRED_TOOLS, isRequiredCoordinatorTool } from '../../src/config/coordinator-tools.js';
import { buildClaudeCommand, coordinatorDisallowedTools, coordinatorSettings } from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const savedEnv = { ...process.env };
beforeEach(() => { process.env.MINIONS_RUNTIME = 'container'; });
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });

function paths() {
  const root = mkdtempSync(join(tmpdir(), 'minions-tools-'));
  dirs.push(root);
  mkdirSync(join(root, 'plugin'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'coordinator prompt\n');
  return runtimePaths({ ...process.env, MINIONS_PLUGIN_DIR: join(root, 'plugin'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_SECRETS_DIR: join(root, 'secrets') });
}
const withCoord = (coordinator: NonNullable<MinionsConfig['coordinator']>): MinionsConfig => ({ ...defaults(), coordinator });
const valueOf = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

describe('coordinator startup trim: tools', () => {
  it('the default list removes the unused built-ins and none of the tools the coordinator needs', () => {
    expect(COORDINATOR_DISALLOWED_TOOLS).toEqual(expect.arrayContaining(['Artifact', 'DesignSync', 'Workflow', 'CronCreate', 'Monitor', 'ScheduleWakeup', 'NotebookEdit', 'EnterWorktree', 'EnterPlanMode', 'WebSearch', 'WebFetch', 'SendFeedback']));
    for (const t of COORDINATOR_DISALLOWED_TOOLS) expect(isRequiredCoordinatorTool(t)).toBe(false);
    for (const t of ['Agent', 'SendMessage', 'Bash', 'Read', 'Edit', 'Write', 'Skill', 'AskUserQuestion', 'TaskStop', 'PushNotification', 'ListAgents']) {
      expect(COORDINATOR_REQUIRED_TOOLS).toContain(t);
    }
    expect(isRequiredCoordinatorTool('mcp__plugin_telegram_telegram__reply')).toBe(true);
    expect(isRequiredCoordinatorTool('Bash(git push *)')).toBe(true);
  });

  it('passes the default list as one --disallowedTools value before --settings', async () => {
    const { args } = await buildClaudeCommand(defaults(), paths(), { telegram: true, startupPrompt: 'go' });
    expect(valueOf(args, '--disallowedTools')!.split(',')).toEqual([...COORDINATOR_DISALLOWED_TOOLS]);
    expect(args.indexOf('--disallowedTools')).toBeLessThan(args.indexOf('--settings'));
    expect(args.slice(-2)).toEqual(['--', 'go']);
  });

  it('coordinator.disallowedTools replaces the list; [] keeps every tool', async () => {
    const p = paths();
    expect(coordinatorDisallowedTools(withCoord({ disallowedTools: ['Artifact'] }))).toEqual(['Artifact']);
    expect(valueOf((await buildClaudeCommand(validateConfig(withCoord({ disallowedTools: ['Artifact', 'Monitor'] })), p)).args, '--disallowedTools')).toBe('Artifact,Monitor');
    expect((await buildClaudeCommand(validateConfig(withCoord({ disallowedTools: [] })), p)).args).not.toContain('--disallowedTools');
  });

  it('the schema rejects disallowing a tool the coordinator needs', () => {
    for (const t of ['Agent', 'Task', 'Bash', 'Skill', 'SendMessage', 'mcp__plugin_telegram_telegram__reply', 'Read(/etc/**)']) {
      expect(() => validateConfig(withCoord({ disallowedTools: [t] }))).toThrow(/coordinator\.disallowedTools/);
    }
    expect(validateConfig(withCoord({ disallowedTools: ['Monitor'], toolSearch: false, bundledSkills: true })).coordinator)
      .toEqual({ disallowedTools: ['Monitor'], toolSearch: false, bundledSkills: true });
  });

  it('worker agents are untouched: their tools allowlists name no disallowed tool', () => {
    const dir = join(__dirname, '..', '..', 'templates', 'plugin', 'agents');
    for (const f of readdirSync(dir)) {
      const line = readFileSync(join(dir, f), 'utf8').split('\n').find((l) => l.startsWith('tools:'));
      expect(line, f).toBeDefined();
      for (const t of line!.slice('tools:'.length).split(',').map((s) => s.trim())) expect(COORDINATOR_DISALLOWED_TOOLS as readonly string[]).not.toContain(t);
    }
  });
});

describe('coordinator startup trim: settings', () => {
  const opts = { auth: 'login' as const, host: null };
  it('turns tool search on and bundled skills off by default; hooks and permissions are unchanged', () => {
    const s = coordinatorSettings(defaults(), { ...opts, telegram: true });
    expect(s.env).toEqual({ ENABLE_TOOL_SEARCH: 'true' });
    expect(s.disableBundledSkills).toBe(true);
    expect(s.hooks).toBeDefined();
    expect((s.permissions as { disableBypassPermissionsMode: string }).disableBypassPermissionsMode).toBe('disable');
  });

  it('coordinator.toolSearch false and bundledSkills true opt out', () => {
    const s = coordinatorSettings(withCoord({ toolSearch: false, bundledSkills: true }), opts);
    expect(s).not.toHaveProperty('env');
    expect(s).not.toHaveProperty('disableBundledSkills');
  });
});

describe('coordinator startup trim: argv and merge with contextReset', () => {
  it('passes --disallowedTools exactly once, as one shell-safe argument', async () => {
    const { args } = await buildClaudeCommand(defaults(), paths(), { telegram: true, startupPrompt: 'go' });
    expect(args.filter((a) => a === '--disallowedTools')).toHaveLength(1);
    expect(valueOf(args, '--disallowedTools')).toMatch(/^[A-Za-z0-9_]+(,[A-Za-z0-9_]+)*$/);
  });

  it('a user list is not extended by the default, and a bad entry names the offending key', () => {
    expect(() => validateConfig(withCoord({ disallowedTools: ['Monitor', 'mcp__plugin_telegram_telegram__reply'] }))).toThrow(/coordinator\.disallowedTools.*must not name a tool the coordinator needs/s);
  });

  it('the trim keys and coordinator.contextReset validate together', () => {
    const c = validateConfig(withCoord({ disallowedTools: [], contextReset: { enabled: false }, toolSearch: false })).coordinator;
    expect(c).toEqual({ disallowedTools: [], contextReset: { enabled: false }, toolSearch: false });
  });
});
