import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import type { RunResult } from '../../src/core/exec.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/resolve.js';
import {
  buildClaudeCommand, claudePermissionModes, configuredPermissionMode, coordinatorSettings, decidePermissionMode,
  parsePermissionModes, probeRuntime, runCoordinator, type Runner,
} from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';

// `claude --help` excerpts. 2.1.292 is the installed version the auto default was verified against.
const HELP_AUTO = `Usage: claude [options] [command] [prompt]

Options:
  --append-system-prompt <prompt>       Append a system prompt to the default system prompt
  --effort <level>                      Effort level for the current session
  --model <model>                       Model for the current session
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --plugin-dir <path>                   Load plugins from a directory
  --settings <file-or-json>             Path to a settings JSON file or a JSON string
  --setting-sources <sources>           Comma-separated list of setting sources
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --add-dir <directories...>            Additional directories to allow tool access to
`;
// An older Claude Code without auto mode. "auto" appears elsewhere in the text but not as a choice.
const HELP_NO_AUTO = HELP_AUTO.replace('"acceptEdits", "auto",', '"acceptEdits", "default",')
  .replace('Load plugins from a directory', 'Load plugins from a directory (auto-loaded)');

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const stubRunner = (help: string): Runner => async (cmd, args) => {
  if (cmd === 'claude' && args[0] === '--version') return ok('2.1.292 (Claude Code)\n');
  if (cmd === 'claude' && args[0] === '--help') return ok(help);
  if (cmd === 'tmux') return ok('tmux 3.4\n');
  return { code: 127, stdout: '', stderr: `unexpected ${cmd}` };
};
const withCoord = (permissionMode?: 'auto' | 'acceptEdits', legacy?: MinionsConfig['permissionMode']): MinionsConfig => ({
  ...defaults(), ...(permissionMode ? { coordinator: { permissionMode } } : {}), ...(legacy ? { permissionMode: legacy } : {}),
});
const modeOf = (args: string[]) => args[args.indexOf('--permission-mode') + 1];

const dirs: string[] = [];
const mkTmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const savedEnv = { ...process.env };
beforeEach(() => { process.env.MINIONS_RUNTIME = 'container'; });
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });

function pluginPaths() {
  const root = mkTmp('minions-perm-');
  mkdirSync(join(root, 'plugin'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'coordinator prompt\n');
  return { root, env: { MINIONS_PLUGIN_DIR: join(root, 'plugin'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_SECRETS_DIR: join(root, 'secrets') } };
}

describe('coordinator permission mode: config', () => {
  it('defaults to auto; coordinator.permissionMode "acceptEdits" opts out; bypass is rejected by the schema', () => {
    expect(configuredPermissionMode(defaults())).toBe('auto');
    expect(configuredPermissionMode(withCoord('acceptEdits'))).toBe('acceptEdits');
    expect(configuredPermissionMode(withCoord('auto'))).toBe('auto');
    expect(validateConfig(withCoord('acceptEdits')).coordinator).toEqual({ permissionMode: 'acceptEdits' });
    expect(() => validateConfig({ ...defaults(), coordinator: { permissionMode: 'bypassPermissions' } })).toThrow(/coordinator\.permissionMode/);
    expect(() => validateConfig({ ...defaults(), coordinator: { permissionMode: 'dontAsk' } })).toThrow();
    expect(() => validateConfig({ ...defaults(), coordinator: { other: 1 } })).toThrow();
  });

  it('legacy top-level permissionMode: "default" stays (stricter); "acceptEdits" (the old profile default) means auto', () => {
    expect(configuredPermissionMode(withCoord(undefined, 'default'))).toBe('default');
    expect(configuredPermissionMode(withCoord(undefined, 'acceptEdits'))).toBe('auto');
    expect(configuredPermissionMode(withCoord('acceptEdits', 'auto'))).toBe('acceptEdits');
    expect(validateConfig(withCoord(undefined, 'acceptEdits')).permissionMode).toBe('acceptEdits'); // existing configs stay valid
  });

  it('legacy top-level permissionMode "acceptEdits" is reported as ignored by --probe/doctor (decision reason)', () => {
    const note = /legacy permissionMode "acceptEdits" is ignored; set coordinator\.permissionMode "acceptEdits" to opt out/;
    const legacy = withCoord(undefined, 'acceptEdits');
    expect(decidePermissionMode(legacy, { hostRuntime: false, modes: ['acceptEdits', 'auto'] })).toMatchObject({ mode: 'auto', reason: expect.stringMatching(note) });
    expect(decidePermissionMode(legacy, { hostRuntime: false, modes: ['acceptEdits'] })).toMatchObject({ mode: 'acceptEdits', fallback: true, reason: expect.stringMatching(note) });
    expect(decidePermissionMode(withCoord('acceptEdits', 'acceptEdits'), { hostRuntime: false }).reason).not.toMatch(note);
    expect(decidePermissionMode(withCoord(undefined, 'default'), { hostRuntime: false }).reason).not.toMatch(note);
    expect(decidePermissionMode(defaults(), { hostRuntime: false }).reason).not.toMatch(note);
  });

  it('never allows bypassPermissions from either key', () => {
    expect(() => decidePermissionMode({ permissionMode: 'bypassPermissions' as never }, { hostRuntime: false })).toThrow(/never allowed/);
    expect(() => decidePermissionMode({ coordinator: { permissionMode: 'bypassPermissions' as never } }, { hostRuntime: false })).toThrow(/never allowed/);
  });
});

describe('coordinator permission mode: Claude Code support', () => {
  it('reads the --permission-mode choices from claude --help, never guessing', () => {
    expect(parsePermissionModes(HELP_AUTO)).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
    expect(parsePermissionModes(HELP_NO_AUTO)).not.toContain('auto');
    expect(parsePermissionModes('  --permission-mode <mode>  Permission mode\n  --plugin-dir <p>  (choices: "auto")\n')).toBeNull();
    expect(parsePermissionModes('no such flag')).toBeNull();
  });

  it('claudePermissionModes is null when claude --help fails', async () => {
    expect(await claudePermissionModes(stubRunner(HELP_AUTO))).toContain('auto');
    expect(await claudePermissionModes(async () => ({ code: 127, stdout: '', stderr: 'not found' }))).toBeNull();
    expect(await claudePermissionModes(async () => { throw new Error('boom'); })).toBeNull();
  });

  it('falls back to acceptEdits with a clear reason when auto is unavailable; host runtime stays default', () => {
    expect(decidePermissionMode(defaults(), { hostRuntime: false, modes: ['acceptEdits', 'auto'] })).toMatchObject({ mode: 'auto', fallback: false });
    const old = decidePermissionMode(defaults(), { hostRuntime: false, modes: ['acceptEdits', 'default', 'plan'] });
    expect(old).toMatchObject({ configured: 'auto', mode: 'acceptEdits', fallback: true });
    expect(old.reason).toMatch(/does not offer --permission-mode auto \(choices: acceptEdits, default, plan\); falling back to permission mode acceptEdits/);
    expect(decidePermissionMode(defaults(), { hostRuntime: false, modes: null })).toMatchObject({ mode: 'acceptEdits', fallback: true, reason: expect.stringMatching(/could not read/) });
    // An explicit acceptEdits opt-out is not a fallback.
    expect(decidePermissionMode(withCoord('acceptEdits'), { hostRuntime: false, modes: null })).toMatchObject({ mode: 'acceptEdits', fallback: false });
    expect(decidePermissionMode(defaults(), { hostRuntime: true, modes: ['auto'] })).toMatchObject({ mode: 'default', fallback: false });
  });

  it('--probe reports auto when supported and falls back to acceptEdits (not an error) when not', async () => {
    const yes = await probeRuntime(defaults(), { runner: stubRunner(HELP_AUTO) });
    expect(yes).toMatchObject({ claudeVersion: '2.1.292 (Claude Code)', tmuxVersion: 'tmux 3.4', permission: { mode: 'auto', fallback: false } });
    const no = await probeRuntime(defaults(), { runner: stubRunner(HELP_NO_AUTO) });
    expect(no.permission).toMatchObject({ configured: 'auto', mode: 'acceptEdits', fallback: true });
    expect(no.permission.reason).toMatch(/does not offer --permission-mode auto/);
    const optOut = await probeRuntime(withCoord('acceptEdits'), { runner: stubRunner(HELP_AUTO) });
    expect(optOut.permission).toMatchObject({ mode: 'acceptEdits', fallback: false });
  });
});

describe('coordinator permission mode: launch argv and settings', () => {
  it('launches in auto by default; deny/ask rules and disableBypassPermissionsMode are identical in every mode', async () => {
    const { env } = pluginPaths();
    const paths = runtimePaths(env);
    const auto = await buildClaudeCommand(defaults(), paths, { permissionModes: ['acceptEdits', 'auto'] });
    const unchecked = await buildClaudeCommand(defaults(), paths);
    const edits = await buildClaudeCommand(withCoord('acceptEdits'), paths, { permissionModes: ['acceptEdits', 'auto'] });
    const fallback = await buildClaudeCommand(defaults(), paths, { permissionModes: ['acceptEdits', 'default'] });
    expect(modeOf(auto.args)).toBe('auto');
    expect(modeOf(unchecked.args)).toBe('auto');
    expect(modeOf(edits.args)).toBe('acceptEdits');
    expect(modeOf(fallback.args)).toBe('acceptEdits');
    const perms = (c: typeof auto) => JSON.parse(c.args[c.args.indexOf('--settings') + 1]!).permissions;
    const a = perms(auto);
    expect(a.deny).toEqual(expect.arrayContaining(['Bash(git push *)', 'Bash(git push)', 'Bash(git * push *)', 'Bash(gh pr merge *)', 'Bash(gh pr merge)', 'Bash(gh * pr merge *)']));
    expect(a.ask).toEqual(expect.arrayContaining(['Bash(minions work approve *)', 'Bash(minions * work approve *)', 'Bash(minions approve *)', 'Bash(minions * approve *)']));
    expect(a.disableBypassPermissionsMode).toBe('disable');
    for (const c of [edits, fallback, unchecked]) expect(perms(c)).toEqual(a);
    expect(coordinatorSettings(withCoord('acceptEdits')).permissions).toEqual(coordinatorSettings(defaults()).permissions);
    for (const c of [auto, edits, fallback]) expect(c.args.join(' ')).not.toMatch(/bypassPermissions|dangerously|dontAsk/);
  });

  it('the exec wrapper checks Claude Code for auto, logs the fallback, and skips the check when acceptEdits is configured', async () => {
    const { env } = pluginPaths();
    const paths = runtimePaths(env);
    const launch = async (cfg: MinionsConfig, modes: () => Promise<string[] | null>) => {
      const calls: string[][] = []; const logs: string[] = [];
      const spawn = ((_c: string, args: string[]) => {
        calls.push(args);
        const listeners: Record<string, (...a: unknown[]) => void> = {};
        setImmediate(() => listeners.exit?.(0, null));
        return { on: (e: string, f: (...a: unknown[]) => void) => { listeners[e] = f; }, kill: () => true };
      }) as never;
      cfg.communication.channel = 'terminal';
      await runCoordinator(cfg, { paths, spawn, env: {}, log: (l) => logs.push(l), permissionModes: modes });
      return { args: calls[0]!, logs };
    };
    const yes = await launch(defaults(), async () => ['acceptEdits', 'auto']);
    expect(modeOf(yes.args)).toBe('auto');
    expect(yes.logs).toEqual([]);
    const no = await launch(defaults(), async () => ['acceptEdits', 'plan']);
    expect(modeOf(no.args)).toBe('acceptEdits');
    expect(no.logs.join('\n')).toMatch(/^minions: the installed Claude Code does not offer --permission-mode auto.*falling back to permission mode acceptEdits/);
    const broken = await launch(defaults(), async () => { throw new Error('boom'); });
    expect(modeOf(broken.args)).toBe('acceptEdits');
    const optOut = await launch(withCoord('acceptEdits'), async () => { throw new Error('must not check'); });
    expect(modeOf(optOut.args)).toBe('acceptEdits');
    expect(optOut.logs).toEqual([]);
  });
});

describe('minions coordinator --print-command / --probe (stub claude on PATH)', () => {
  async function cli(args: string[], cfg: MinionsConfig, help: string): Promise<string> {
    const { root, env } = pluginPaths();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(root, 'help.txt'), help);
    const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    stub('claude', `case "$1" in --version) echo "2.1.292 (Claude Code)";; --help) cat "${join(root, 'help.txt')}";; *) exit 2;; esac`);
    stub('tmux', 'echo "tmux 3.4"');
    writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
    Object.assign(process.env, env, { MINIONS_CONFIG: join(root, 'config.json'), MINIONS_RUNTIME: 'container', PATH: `${bin}${delimiter}${process.env.PATH}` });
    // Fresh modules per call: the runtime commands cache the loaded config.
    vi.resetModules();
    const { buildProgram } = await import('../../src/program.js');
    const program = buildProgram();
    let out = '';
    const capture = (c: Command) => { c.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } }); c.commands.forEach(capture); };
    capture(program);
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
    const before = process.exitCode;
    try { await program.parseAsync(['node', 'minions', '--json', ...args]); } finally { process.stdout.write = write; process.exitCode = before; }
    return out;
  }
  const json = (out: string) => JSON.parse(out.trim().split('\n').at(-1)!).data;

  it('--print-command shows --permission-mode auto by default and acceptEdits when Claude Code lacks auto', async () => {
    const term = (c: MinionsConfig) => { c.communication.channel = 'terminal'; return c; };
    expect(modeOf(json(await cli(['coordinator', '--print-command'], term(defaults()), HELP_AUTO)).claude.args)).toBe('auto');
    expect(modeOf(json(await cli(['coordinator', '--print-command'], term(defaults()), HELP_NO_AUTO)).claude.args)).toBe('acceptEdits');
    expect(modeOf(json(await cli(['coordinator', '--print-command'], term(withCoord('acceptEdits')), HELP_AUTO)).claude.args)).toBe('acceptEdits');
  });

  it('--probe --json reports the permission mode decision', async () => {
    expect(json(await cli(['coordinator', '--probe'], defaults(), HELP_AUTO)).permission).toMatchObject({ mode: 'auto', fallback: false });
    const no = json(await cli(['coordinator', '--probe'], defaults(), HELP_NO_AUTO));
    expect(no.permission).toMatchObject({ mode: 'acceptEdits', fallback: true });
    expect(no.permission.reason).toMatch(/does not offer --permission-mode auto/);
  });
});
