// task-70: Claude Code 2.1.292 lists `manual` instead of `default` for --permission-mode. Every place
// that passes the strict mode maps it to the name the installed CLI lists and fails closed when it lists
// neither (never a looser mode).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/core/exec.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/resolve.js';
import { buildClaudeCommand, decidePermissionMode, permissionModesNeeded, probeRuntime, runCoordinator, type Runner } from '../../src/runtime/coordinator.js';
import { parsePermissionModes, strictPermissionModeArg } from '../../src/runtime/permission-modes.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';

// `claude --help` excerpts: 2.1.292 (manual, no default) and an older format (default, no manual).
const helpWith = (choices: string) => `Usage: claude [options] [command] [prompt]

Options:
  --append-system-prompt <prompt>       Append a system prompt to the default system prompt
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: ${choices})
  --plugin-dir <path>                   Load plugins from a directory
  --settings <file-or-json>             Path to a settings JSON file or a JSON string
  --setting-sources <sources>           Comma-separated list of setting sources
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --add-dir <directories...>            Additional directories to allow tool access to
`;
const HELP_MANUAL = helpWith('"acceptEdits", "auto",\n                                        "bypassPermissions", "manual",\n                                        "dontAsk", "plan"');
const HELP_DEFAULT = helpWith('"acceptEdits", "bypassPermissions", "default",\n                                        "dontAsk", "plan"');
const HELP_BOTH = helpWith('"acceptEdits", "auto", "default", "manual", "plan"');
const HELP_NEITHER = helpWith('"acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"');

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const stubRunner = (help: string): Runner => async (cmd, args) => {
  if (cmd === 'claude' && args[0] === '--version') return ok('2.1.292 (Claude Code)\n');
  if (cmd === 'claude' && args[0] === '--help') return ok(help);
  if (cmd === 'tmux') return ok('tmux 3.4\n');
  return { code: 127, stdout: '', stderr: `unexpected ${cmd}` };
};
const modeOf = (args: string[]) => args[args.indexOf('--permission-mode') + 1];
const legacyDefault = (): MinionsConfig => validateConfig({ ...defaults(), permissionMode: 'default' });

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const savedEnv = { ...process.env };
beforeEach(() => { process.env.MINIONS_RUNTIME = 'container'; });
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); });

function pluginPaths() {
  const root = mkdtempSync(join(tmpdir(), 'minions-perm70-'));
  dirs.push(root);
  mkdirSync(join(root, 'plugin'), { recursive: true });
  writeFileSync(join(root, 'plugin', 'coordinator.md'), 'coordinator prompt\n');
  return runtimePaths({ MINIONS_PLUGIN_DIR: join(root, 'plugin'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_SECRETS_DIR: join(root, 'secrets') });
}
const fakeSpawn = (calls: string[][]) => ((_c: string, args: string[]) => {
  calls.push(args);
  const listeners: Record<string, (...a: unknown[]) => void> = {};
  setImmediate(() => listeners.exit?.(0, null));
  return { on: (e: string, f: (...a: unknown[]) => void) => { listeners[e] = f; }, kill: () => true };
}) as never;
const terminal = (c: MinionsConfig) => { c.communication.channel = 'terminal'; return c; };

describe('strictPermissionModeArg: both --help formats', () => {
  it('parses each format and maps default to the listed name', () => {
    expect(parsePermissionModes(HELP_MANUAL)).toEqual(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']);
    expect(strictPermissionModeArg(parsePermissionModes(HELP_MANUAL))).toEqual({ ok: true, mode: 'manual' });
    expect(strictPermissionModeArg(parsePermissionModes(HELP_DEFAULT))).toEqual({ ok: true, mode: 'default' });
    // Both listed: the historical name wins.
    expect(strictPermissionModeArg(parsePermissionModes(HELP_BOTH))).toEqual({ ok: true, mode: 'default' });
  });

  it('fails closed when neither name is listed; never picks another mode', () => {
    const r = strictPermissionModeArg(parsePermissionModes(HELP_NEITHER));
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/neither --permission-mode default nor manual \(choices: acceptEdits, auto, bypassPermissions, dontAsk, plan\)/) });
    expect(strictPermissionModeArg([])).toMatchObject({ ok: false });
    // Near misses are not the strict mode.
    expect(strictPermissionModeArg(['Default', 'manualEdits', 'defaults'])).toMatchObject({ ok: false });
  });

  it('unreadable or unchecked choices keep the historical `default` (a CLI that rejects it fails the launch)', () => {
    expect(strictPermissionModeArg(null)).toEqual({ ok: true, mode: 'default' });
    expect(strictPermissionModeArg(undefined)).toEqual({ ok: true, mode: 'default' });
    expect(strictPermissionModeArg(parsePermissionModes('no such flag'))).toEqual({ ok: true, mode: 'default' });
  });
});

describe('coordinator: strict mode under the listed name', () => {
  it('host runtime passes manual on 2.1.292, default on older CLIs, and throws when neither is listed', async () => {
    const host = (help: string) => decidePermissionMode(defaults(), { hostRuntime: true, modes: parsePermissionModes(help) });
    expect(host(HELP_MANUAL)).toMatchObject({ configured: 'auto', mode: 'manual', fallback: false, reason: expect.stringMatching(/permission mode default \(passed as manual/) });
    expect(host(HELP_DEFAULT)).toMatchObject({ mode: 'default', reason: 'host runtime: the coordinator always runs in permission mode default' });
    expect(() => host(HELP_NEITHER)).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RUNTIME', message: expect.stringMatching(/not started in a looser mode/) }));
  });

  it('legacy container permissionMode "default" maps the same way', () => {
    const c = (help: string) => decidePermissionMode(legacyDefault(), { hostRuntime: false, modes: parsePermissionModes(help) });
    expect(c(HELP_MANUAL)).toMatchObject({ configured: 'default', mode: 'manual', fallback: false });
    expect(c(HELP_DEFAULT)).toMatchObject({ configured: 'default', mode: 'default' });
    expect(() => c(HELP_NEITHER)).toThrow(/permissionMode "default".*neither --permission-mode default nor manual/);
    // Auto and acceptEdits are untouched by the mapping.
    expect(decidePermissionMode(defaults(), { hostRuntime: false, modes: parsePermissionModes(HELP_MANUAL) })).toMatchObject({ mode: 'auto' });
    expect(decidePermissionMode(defaults(), { hostRuntime: false, modes: parsePermissionModes(HELP_NEITHER) })).toMatchObject({ mode: 'auto' });
  });

  it('asks Claude Code for its choices unless acceptEdits is configured in the container', () => {
    expect(permissionModesNeeded(defaults(), false)).toBe(true);
    expect(permissionModesNeeded(legacyDefault(), false)).toBe(true);
    expect(permissionModesNeeded({ ...defaults(), coordinator: { permissionMode: 'acceptEdits' } }, false)).toBe(false);
    expect(permissionModesNeeded({ ...defaults(), coordinator: { permissionMode: 'acceptEdits' } }, true)).toBe(true);
  });

  it('buildClaudeCommand and probeRuntime on the host runtime', async () => {
    process.env.MINIONS_RUNTIME = 'host';
    const paths = pluginPaths();
    expect(modeOf((await buildClaudeCommand(defaults(), paths, { permissionModes: parsePermissionModes(HELP_MANUAL) })).args)).toBe('manual');
    expect(modeOf((await buildClaudeCommand(defaults(), paths, { permissionModes: parsePermissionModes(HELP_DEFAULT) })).args)).toBe('default');
    expect(modeOf((await buildClaudeCommand(defaults(), paths)).args)).toBe('default');
    await expect(buildClaudeCommand(defaults(), paths, { permissionModes: parsePermissionModes(HELP_NEITHER) })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    expect((await probeRuntime(defaults(), { runner: stubRunner(HELP_MANUAL) })).permission).toMatchObject({ mode: 'manual', fallback: false });
    expect((await probeRuntime(defaults(), { runner: stubRunner(HELP_DEFAULT) })).permission).toMatchObject({ mode: 'default' });
    await expect(probeRuntime(defaults(), { runner: stubRunner(HELP_NEITHER) })).rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
  });

  it('runCoordinator (legacy default) launches with manual on 2.1.292 and does not start claude when neither is listed', async () => {
    const paths = pluginPaths();
    const calls: string[][] = [];
    await runCoordinator(terminal(legacyDefault()), { paths, spawn: fakeSpawn(calls), env: {}, log: () => {}, permissionModes: async () => parsePermissionModes(HELP_MANUAL) });
    expect(modeOf(calls[0]!)).toBe('manual');
    const old: string[][] = [];
    await runCoordinator(terminal(legacyDefault()), { paths, spawn: fakeSpawn(old), env: {}, log: () => {}, permissionModes: async () => parsePermissionModes(HELP_DEFAULT) });
    expect(modeOf(old[0]!)).toBe('default');
    const none: string[][] = [];
    await expect(runCoordinator(terminal(legacyDefault()), { paths, spawn: fakeSpawn(none), env: {}, log: () => {}, permissionModes: async () => parsePermissionModes(HELP_NEITHER) }))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_RUNTIME' });
    expect(none).toEqual([]);
  });
});
