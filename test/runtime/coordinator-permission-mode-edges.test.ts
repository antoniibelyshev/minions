// Edge cases of the coordinator permission-mode decision (task-36): `claude --help` that fails, hangs or
// prints something unexpected must fall back to acceptEdits and never pick an unlisted mode; the tmux
// wrapper (`minions coordinator run`, also used by restart) applies the same decision.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunOptions, RunResult } from '../../src/core/exec.js';
import type { MinionsConfig } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/resolve.js';
import {
  claudePermissionModes, coordinatorWrapper, decidePermissionMode, parsePermissionModes, runCoordinator,
} from '../../src/runtime/coordinator.js';
import { runtimePaths } from '../../src/runtime/paths.js';
import { defaults } from '../helpers.js';

const dirs: string[] = [];
const mkTmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const savedEnv = { ...process.env };
beforeEach(() => { process.env.MINIONS_RUNTIME = 'container'; });
afterEach(() => {
  vi.useRealTimers();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

const modeOf = (args: string[]) => args[args.indexOf('--permission-mode') + 1];
const choices = (list: string) => `Options:\n  --model <model>  Model\n  --permission-mode <mode>  Permission mode\n      (choices: ${list})\n  --plugin-dir <path>  Plugins\n`;

describe('parsePermissionModes: unexpected --help output never yields an unlisted mode', () => {
  it('handles CRLF output and choices wrapped over several lines', () => {
    expect(parsePermissionModes(choices('"acceptEdits",\r\n        "auto", "plan"').replace(/\n/g, '\r\n'))).toEqual(['acceptEdits', 'auto', 'plan']);
  });

  it('returns null for unquoted, empty or unterminated choices', () => {
    expect(parsePermissionModes(choices('acceptEdits, auto'))).toBeNull();
    expect(parsePermissionModes(choices(''))).toBeNull();
    expect(parsePermissionModes('  --permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto"\n')).toBeNull();
    expect(parsePermissionModes('')).toBeNull();
  });

  it('does not take choices from a later flag', () => {
    const help = '  --permission-mode <mode>  Permission mode\n  --effort <level>  Effort (choices: "auto", "low")\n';
    expect(parsePermissionModes(help)).toBeNull();
  });

  it('a first mention inside another flag description is a conservative miss (fallback), never a wrong pick', () => {
    const help = '  --dangerously-skip-permissions  Same as --permission-mode bypassPermissions\n' + choices('"acceptEdits", "auto"');
    const modes = parsePermissionModes(help);
    expect(modes === null || (modes.includes('auto') && !modes.includes('bypassPermissions'))).toBe(true);
  });

  it('"auto" only counts as an exact choice, not as a substring of another one', () => {
    const modes = parsePermissionModes(choices('"acceptEdits", "autoEdits", "plan"'));
    expect(modes).toEqual(['acceptEdits', 'autoEdits', 'plan']);
    expect(decidePermissionMode(defaults(), { hostRuntime: false, modes })).toMatchObject({ mode: 'acceptEdits', fallback: true });
  });

  it.skipIf(!(() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 30_000 }); return true; } catch { return false; } })())(
    'parses the help of the Claude Code installed in this environment', () => {
      const help = execFileSync('claude', ['--help'], { encoding: 'utf8', timeout: 30_000 });
      const modes = parsePermissionModes(help);
      expect(modes).not.toBeNull();
      expect(modes).toContain('acceptEdits');
      // Every parsed choice appears quoted in the real --help text.
      for (const m of modes!) expect(help).toContain(`"${m}"`);
    });
});

describe('claudePermissionModes: failing or hanging claude --help', () => {
  it('bounds claude --help with a timeout and treats a timeout or non-zero exit as unknown (null)', async () => {
    let seen: RunOptions | undefined;
    const timedOut = async (_c: string, _a: string[], o?: RunOptions): Promise<RunResult> => { seen = o; return { code: 124, stdout: choices('"auto"'), stderr: '', timedOut: true }; };
    expect(await claudePermissionModes(timedOut)).toBeNull();
    expect(seen?.timeoutMs).toBeGreaterThan(0);
    expect(seen?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(seen?.allowFailure).toBe(true);
    // A non-zero exit is not trusted even when the text lists auto.
    expect(await claudePermissionModes(async () => ({ code: 1, stdout: choices('"acceptEdits", "auto"'), stderr: '' }))).toBeNull();
    // Choices printed on stderr are still read.
    expect(await claudePermissionModes(async () => ({ code: 0, stdout: '', stderr: choices('"acceptEdits", "auto"') }))).toContain('auto');
  });

  it('a claude --help that hangs is killed at the timeout and yields null (real process, fake clock)', async () => {
    const bin = mkTmp('minions-perm-hang-');
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexec sleep 600\n');
    chmodSync(join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = claudePermissionModes();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    expect(await p).toBeNull();
  });
});

function pluginPaths() {
  const root = mkTmp('minions-perm-edge-');
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

describe('launch wrapper: same decision on every path', () => {
  it('coordinatorWrapper (tmux `minions coordinator run`, used by start and restart) falls back to acceptEdits and logs why', async () => {
    const paths = pluginPaths();
    const calls: string[][] = []; const logs: string[] = [];
    const code = await coordinatorWrapper(async () => terminal(defaults()), {
      paths, spawn: fakeSpawn(calls), env: {}, log: (l) => logs.push(l), permissionModes: async () => null,
    });
    expect(code).toBe(0);
    expect(modeOf(calls[0]!)).toBe('acceptEdits');
    expect(logs.join('\n')).toMatch(/could not read the --permission-mode choices.*falling back to permission mode acceptEdits/);
    const calls2: string[][] = [];
    await coordinatorWrapper(async () => terminal(defaults()), { paths, spawn: fakeSpawn(calls2), env: {}, log: () => {}, permissionModes: async () => ['acceptEdits', 'auto'] });
    expect(modeOf(calls2[0]!)).toBe('auto');
  });

  it('legacy permissionMode "default" launches in default when the choices cannot be read', async () => {
    const paths = pluginPaths();
    const calls: string[][] = []; const logs: string[] = [];
    const cfg = terminal(validateConfig({ ...defaults(), permissionMode: 'default' }));
    await runCoordinator(cfg, { paths, spawn: fakeSpawn(calls), env: {}, log: (l) => logs.push(l), permissionModes: async () => { throw new Error('must not check'); } });
    expect(modeOf(calls[0]!)).toBe('default');
    expect(logs).toEqual([]);
  });

  it('waits for a slow permission-mode check and uses its answer', async () => {
    const paths = pluginPaths();
    const calls: string[][] = [];
    const slow = () => new Promise<string[] | null>((res) => setTimeout(() => res(['acceptEdits', 'plan']), 20));
    await runCoordinator(terminal(defaults()), { paths, spawn: fakeSpawn(calls), env: {}, log: () => {}, permissionModes: slow });
    expect(modeOf(calls[0]!)).toBe('acceptEdits');
  });
});

describe('minions coordinator --print-command with a broken claude --help (stub on PATH)', () => {
  async function printCommand(cfg: MinionsConfig, claudeBody: string, runtime = 'container') {
    const root = mkTmp('minions-perm-cli-');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'plugin'));
    writeFileSync(join(root, 'plugin', 'coordinator.md'), 'coordinator prompt\n');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\n${claudeBody}\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(root, 'config.json'), JSON.stringify(cfg));
    Object.assign(process.env, {
      MINIONS_PLUGIN_DIR: join(root, 'plugin'), MINIONS_STATE_DIR: join(root, 'state'), MINIONS_WORKSPACE: join(root, 'ws'), MINIONS_SECRETS_DIR: join(root, 'secrets'),
      MINIONS_CONFIG: join(root, 'config.json'), MINIONS_RUNTIME: runtime, PATH: `${bin}${delimiter}${process.env.PATH}`, MARK: join(root, 'called'),
    });
    vi.resetModules();
    const { buildProgram } = await import('../../src/program.js');
    const program = buildProgram();
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
    const before = process.exitCode;
    try { await program.parseAsync(['node', 'minions', '--json', 'coordinator', '--print-command']); } finally { process.stdout.write = write; process.exitCode = before; }
    const res = JSON.parse(out.trim().split('\n').at(-1)!);
    return { res, called: existsSync(join(root, 'called')) };
  }

  it('falls back to acceptEdits when claude --help exits non-zero or prints garbage', async () => {
    for (const body of ['echo "boom" >&2; exit 3', 'echo "Usage: claude --permission-mode <mode>"', 'printf "\\377\\376garbage"']) {
      const { res } = await printCommand(terminal(defaults()), body);
      expect(res.ok, body).toBe(true);
      expect(modeOf(res.data.claude.args), body).toBe('acceptEdits');
    }
  });

  it('falls back to acceptEdits when claude --help succeeds but prints nothing', async () => {
    const { res } = await printCommand(terminal(defaults()), 'exit 0');
    expect(modeOf(res.data.claude.args)).toBe('acceptEdits');
  });

  it('does not run claude --help for an acceptEdits opt-out', async () => {
    const { res, called } = await printCommand(terminal({ ...defaults(), coordinator: { permissionMode: 'acceptEdits' } }), 'touch "$MARK"; exit 1');
    expect(modeOf(res.data.claude.args)).toBe('acceptEdits');
    expect(called).toBe(false);
  });
});
