import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { buildProgram } from '../src/program.js';
import { generatePlugin } from '../src/plugin/generate.js';
import { PROFILES } from '../src/config/schema.js';
import {
  ADVANCED_COMMANDS, INTERNAL_COMMANDS, PRIMARY_COMMANDS, UNLISTED_COMMANDS, surfaceListing, tierOf,
} from '../src/surface.js';
import { defaults } from './helpers.js';

const root = join(import.meta.dirname, '..');
const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

/**
 * Runs the program in-process and captures what commander and emit() write. Always in host mode
 * (MINIONS_RUNTIME unset), so runtime-only commands fail closed instead of touching a real /state
 * when the suite itself runs inside a minions container.
 */
async function run(args: string[]): Promise<{ out: string; code: number | undefined }> {
  const runtime = process.env.MINIONS_RUNTIME;
  delete process.env.MINIONS_RUNTIME;
  try { return await runHost(args); } finally { if (runtime !== undefined) process.env.MINIONS_RUNTIME = runtime; }
}

/** Like run(), but with MINIONS_RUNTIME forced to `mode` (only for commands that fail closed before touching state). */
async function runIn(mode: 'container', args: string[]): Promise<{ out: string; code: number | undefined }> {
  const runtime = process.env.MINIONS_RUNTIME;
  process.env.MINIONS_RUNTIME = mode;
  try { return await runHost(args); } finally {
    if (runtime === undefined) delete process.env.MINIONS_RUNTIME; else process.env.MINIONS_RUNTIME = runtime;
  }
}

async function runHost(args: string[]): Promise<{ out: string; code: number | undefined }> {
  const program = buildProgram();
  let out = '';
  const capture = (cmd: Command) => {
    cmd.exitOverride().configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } });
    cmd.commands.forEach(capture);
  };
  capture(program);
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const exit = process.exit.bind(process);
  const sink = ((s: string | Uint8Array) => { out += String(s); return true; }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  process.exit = ((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as typeof process.exit;
  const before = process.exitCode;
  let code: number | undefined;
  try {
    await program.parseAsync(['node', 'minions', ...args]);
    code = process.exitCode === before ? 0 : Number(process.exitCode);
  } catch (err) {
    code = (err as { exitCode?: number }).exitCode ?? 1;
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    process.exit = exit;
    process.exitCode = before;
  }
  return { out, code };
}

/** Top-level command names listed in a help text section (lines indented by exactly two spaces). */
function listed(help: string, heading = 'Commands:'): string[] {
  const lines = help.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    const m = /^ {2}([a-z][a-z-]*)/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

describe('CLI surface (docs/design/cli-surface.md)', () => {
  it('pins the commands visible in the default `minions --help`', () => {
    const help = buildProgram().helpInformation();
    // Changing this list is a product decision: update src/surface.ts, docs/design/cli-surface.md and README.
    expect(listed(help).sort()).toEqual(['down', 'help', 'setup', 'start', 'status', 'uninstall', 'upgrade']);
    expect(PRIMARY_COMMANDS.length).toBeGreaterThanOrEqual(5);
    expect(PRIMARY_COMMANDS.length).toBeLessThanOrEqual(7);
    expect(help).not.toMatch(/Advanced commands:|Internal commands/);
    for (const name of [...ADVANCED_COMMANDS, ...INTERNAL_COMMANDS, ...UNLISTED_COMMANDS]) {
      expect(help).not.toMatch(new RegExp(`^ {2}${name}\\b`, 'm'));
    }
  });

  it('classifies every top-level command into exactly one tier', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).filter((n) => n !== 'help');
    const unclassified = names.filter((n) => tierOf(n) === undefined);
    expect(unclassified, 'new top-level commands need an explicit tier in src/surface.ts').toEqual([]);
    const tiers = [PRIMARY_COMMANDS, ADVANCED_COMMANDS, INTERNAL_COMMANDS, UNLISTED_COMMANDS].flat() as string[];
    expect(new Set(tiers).size).toBe(tiers.length);
    expect([...tiers].sort()).toEqual([...names].sort());
  });

  it('`minions --help` and `minions help` print the primary listing', async () => {
    for (const args of [['--help'], ['help']]) {
      const { out, code } = await run(args);
      expect(code).toBe(0);
      expect(listed(out).sort()).toEqual(['down', 'help', 'setup', 'start', 'status', 'uninstall', 'upgrade']);
      expect(out).toContain('Run `minions help --all` for advanced and internal commands');
    }
  });

  it('`minions help --all` lists every advanced and internal command, grouped', async () => {
    const { out, code } = await run(['help', '--all']);
    expect(code).toBe(0);
    expect(listed(out, 'Advanced commands:')).toEqual([...ADVANCED_COMMANDS]);
    expect(listed(out, 'Internal commands (used by the coordinator, agents and the container):')).toEqual([...INTERNAL_COMMANDS]);
    expect(out.indexOf('Commands:')).toBeLessThan(out.indexOf('Advanced commands:'));
    expect(out).not.toContain('git-credential');
    expect(out).not.toContain('minions help --all` for advanced');
  });

  it('`minions help --all --json` returns the tiers', async () => {
    const { out } = await run(['help', '--all', '--json']);
    const parsed = JSON.parse(out) as { ok: boolean; data: unknown };
    expect(parsed).toEqual({ ok: true, data: surfaceListing(buildProgram(), true) });
    expect(parsed.data).toEqual({ primary: [...PRIMARY_COMMANDS], advanced: [...ADVANCED_COMMANDS], internal: [...INTERNAL_COMMANDS] });
  });

  it('hidden commands still parse and dispatch, with their own subcommand help', async () => {
    for (const [args, expected] of [
      [['work', '--help'], ['claim', 'brief', 'submit', 'record', 'release', 'publish', 'approve', 'list', 'spend']],
      [['backlog', '--help'], ['ready', 'list', 'show', 'create', 'update', 'note', 'export']],
      [['hook', '--help'], ['stop', 'pre-agent', 'pre-telegram']],
      [['coordinator', '--help'], ['run', 'sync', 'restart']],
      [['workspace', '--help'], ['setup', 'import', 'export']],
      [['auth', '--help'], ['show', 'set', 'refresh', 'github', 'telegram']],
      [['help', 'work'], ['claim', 'record']],
    ] as const) {
      const { out, code } = await run([...args]);
      expect(code, args.join(' ')).toBe(0);
      expect(listed(out)).toEqual(expect.arrayContaining([...expected]));
    }
    const { out } = await run(['help', 'work', 'claim']);
    expect(out).toContain('Usage: minions work claim');
  });

  it('hidden commands reach their action handlers (not commander\'s unknown-command error)', async () => {
    // Runtime-only commands run on the host fail closed inside their action with INCOMPATIBLE_RUNTIME.
    for (const args of [['workspace', 'setup'], ['work', 'list'], ['backlog', 'ready']]) {
      const { out, code } = await run([...args, '--json']);
      expect(code, args.join(' ')).toBe(6);
      expect(JSON.parse(out).error.code).toBe('INCOMPATIBLE_RUNTIME');
    }
  });

  it('keeps back-compat aliases: `stop` = `down`, `doctor` and `status --check`, `init`', () => {
    const program = buildProgram();
    const find = (n: string) => program.commands.find((c) => c.name() === n || c.aliases().includes(n));
    expect(find('stop')?.name()).toBe('down');
    expect(find('doctor')).toBeDefined();
    expect(find('init')).toBeDefined();
    expect(find('status')?.options.map((o) => o.long)).toContain('--check');
  });

  it('`minions help --json` without --all returns only the primary tier', async () => {
    const { out, code } = await run(['help', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true, data: { primary: [...PRIMARY_COMMANDS] } });
  });

  it('`minions help <command> --json` prints structured help instead of text', async () => {
    const { out, code } = await run(['help', 'work', 'brief', '--json']);
    expect(code).toBe(0);
    const d = JSON.parse(out).data;
    expect(d).toMatchObject({ name: 'minions work brief', description: expect.stringContaining('brief') });
    expect(d.options.map((o: { flags: string }) => o.flags)).toContain('--role <role>');
    expect(d.tier).toBe('internal');
    const w = JSON.parse((await run(['help', 'work', '--json'])).out).data;
    expect(w.commands.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['brief', 'submit']));
  });

  it('`minions help stop` resolves the alias to the `down` help', async () => {
    const { out, code } = await run(['help', 'stop']);
    expect(code).toBe(0);
    expect(out).toContain('Usage: minions down|stop');
  });

  it('`status --check` and `doctor` fail closed with INCOMPATIBLE_RUNTIME inside the container (no stack trace)', async () => {
    // requireMode('host') runs before any runtime state is opened, so this never touches /state.
    for (const args of [['status', '--check'], ['doctor']]) {
      const { out, code } = await runIn('container', [...args, '--json']);
      expect(code, args.join(' ')).toBe(6);
      const parsed = JSON.parse(out) as { ok: boolean; error: { code: string; hint?: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe('INCOMPATIBLE_RUNTIME');
      expect(parsed.error.hint).toMatch(/host/);
      const human = await runIn('container', [...args]);
      expect(human.code).toBe(6);
      expect(human.out).toContain('error [INCOMPATIBLE_RUNTIME]');
      expect(human.out).not.toMatch(/\n\s+at /);
    }
  });

  it('`minions help <unknown>` fails with NOT_FOUND', async () => {
    const { code } = await run(['help', 'no-such-command']);
    expect(code).not.toBe(0);
  });
});

// ------------------------------------------------------------ back-compat of every invocation we ship

/** `minions <a> [<b>]` invocations inside backtick spans, fenced code, JSON strings and shell lines. */
function invocations(text: string, opts: { shell?: boolean } = {}): string[][] {
  const chunks: string[] = [];
  if (opts.shell) {
    // Commands the script runs or tells the user to run (not prose inside messages).
    for (const m of text.matchAll(/(?:^|\bexec |\brun: |&& |; |\$\()(minions [^"\n]*)/gm)) chunks.push(' ' + m[1]);
  } else {
    for (const m of text.matchAll(/```[\s\S]*?```|`[^`\n]+`|"command"\s*:\s*"[^"]*"/g)) chunks.push(m[0]);
  }
  const out: string[][] = [];
  for (const c of chunks) {
    for (const m of c.matchAll(/(?:^|[\s`"'(])minions ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) out.push([m[1]!, ...(m[2] ? [m[2]] : [])]);
  }
  return out;
}

/** Resolves an invocation against the real program: top-level name or alias, then subcommand when it has any. */
function resolves(program: Command, [first, second]: string[]): boolean {
  const top = program.commands.find((c) => c.name() === first || c.aliases().includes(first!));
  if (!top) return false;
  if (!second || top.commands.length === 0) return true;
  return top.commands.some((c) => c.name() === second || c.aliases().includes(second)) || top.registeredArguments.length > 0;
}

async function textFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(await readFile(join(e.parentPath, e.name), 'utf8'));
  }
  return out;
}

describe('back-compat: every `minions ...` call shipped to agents, hooks and installers still resolves', () => {
  const program = buildProgram();
  const check = (found: string[][], where: string) => {
    const broken = found.filter((i) => !resolves(program, i)).map((i) => `minions ${i.join(' ')}`);
    expect(broken, `${where} invokes commands that no longer exist`).toEqual([]);
  };

  it('the resolver rejects commands that do not exist', () => {
    expect(resolves(program, ['no-such'])).toBe(false);
    expect(resolves(program, ['work', 'no-such'])).toBe(false);
    expect(resolves(program, ['stop'])).toBe(true);
    expect(resolves(program, ['setup', 'github'])).toBe(true);
    expect(invocations('run `minions work record L1` then\n```sh\nminions backlog ready --json\n```')).toEqual([['work', 'record'], ['backlog', 'ready']]);
  });

  it('generated plugin text (coordinator, agents, skills, hooks) for every profile', async () => {
    const found: string[][] = [];
    for (const profile of PROFILES) {
      const out = await mkdtemp(join(tmpdir(), 'minions-surface-')); dirs.push(out);
      await generatePlugin(defaults(profile), out);
      for (const text of await textFiles(out)) found.push(...invocations(text));
    }
    expect(found.map((i) => i[0])).toEqual(expect.arrayContaining(['work', 'backlog', 'hook', 'status']));
    check(found, 'the generated plugin');
  });

  it('install.sh, the setup assistant templates and the container scripts', async () => {
    const install = invocations(await readFile(join(root, 'install.sh'), 'utf8'), { shell: true });
    expect(install).toContainEqual(['setup']);
    check(install, 'install.sh');
    const assistant = (await textFiles(join(root, 'templates', 'assistant'))).flatMap((t) => invocations(t));
    check(assistant, 'templates/assistant');
    check(invocations(await readFile(join(root, 'docker', 'gh-wrapper.sh'), 'utf8')), 'docker/gh-wrapper.sh');
  });
});
