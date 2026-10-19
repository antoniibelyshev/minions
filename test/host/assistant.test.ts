// AI setup assistant (`minions setup assist`, offered at the end of an interactive init): generated
// claude argv (read-only allowlist, denied credential/runtime/publish commands, permission mode
// default, never bypass), host plugin generation, launch with a fake `claude` on PATH (the real
// Claude Code is never started), and the init offer (interactive only; --yes never launches).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/plugin/generate.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/plugin/generate.js')>();
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join: j } = await import('node:path');
  return {
    ...orig,
    generatePlugin: async (_cfg: unknown, outDir: string) => {
      await mkdir(j(outDir, '.claude-plugin'), { recursive: true });
      await writeFile(j(outDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'minions' }) + '\n');
      await writeFile(j(outDir, 'coordinator.md'), 'coordinator\n');
      return [];
    },
  };
});

const A = await import('../../src/host/assistant.js');
const { runInit } = await import('../../src/host/install.js');
const { projectPaths, credentialStoreDir } = await import('../../src/core/paths.js');
const { dockerUp, makeRepo, withHome } = await import('./fixtures.js');

// Resolved before any test changes PATH; used only for `claude plugin validate` (no session, no API).
const realClaude = (() => { try { return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || null; } catch { return null; } })();

let env: ReturnType<typeof withHome>;
let prevPath: string | undefined;
beforeEach(() => { env = withHome(); prevPath = process.env.PATH; });
afterEach(() => { process.env.PATH = prevPath; env.cleanup(); });

async function project(visibility: 'shared' | 'private' = 'private') {
  const repo = makeRepo(env.root);
  const r = await runInit({ path: repo, yes: true, visibility, dockerProbe: dockerUp });
  const ctx = await A.loadAssistantContext(repo);
  return { repo, id: r.plan.projectId, ctx };
}

/** Fake `claude` on PATH: records argv and cwd, prints nothing interactive, exits 7. */
function fakeClaude(): { log: string } {
  const bin = join(env.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(env.root, 'claude.json');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))' "${log}" "$@"\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  process.env.PATH = `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`;
  return { log };
}
const dirname = (p: string) => p.slice(0, p.lastIndexOf('/'));

/** Values of a variadic option: from after the flag up to the next option. */
function variadic(args: string[], flag: string): string[] {
  const i = args.indexOf(flag);
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith('--'); j++) out.push(args[j]!);
  return out;
}

describe('assistant argv', () => {
  it('pre-allows read-only commands only, denies credential/runtime/publish commands, permission mode default, never bypass', async () => {
    const { id, ctx } = await project();
    const { args } = await A.planAssistant(ctx);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    for (const a of args) expect(a).not.toMatch(/^--(dangerously-skip-permissions|allow-dangerously-skip-permissions)$/);
    expect(args.filter((a) => /^(bypassPermissions|acceptEdits|auto|dontAsk)$/.test(a))).toEqual([]);
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ permissions: { disableBypassPermissionsMode: 'disable' } });

    expect(variadic(args, '--allowedTools')).toEqual([
      'Bash(minions doctor*)', 'Bash(minions status*)', 'Bash(minions auth show*)', 'Bash(minions config show*)', 'Bash(minions runtime show*)',
      'Bash(git remote -v)', 'Bash(git status*)', 'Bash(git log*)', `Read(/${ctx.repoPath}/**)`,
    ]);
    // Reads are pre-allowed only inside the repository root: never a bare Read/Glob/Grep.
    expect(variadic(args, '--allowedTools').filter((a) => /^(Read|Glob|Grep)$/.test(a))).toEqual([]);
    expect(`Read(/${ctx.repoPath}/**)`.startsWith('Read(//')).toBe(true);
    const denied = variadic(args, '--disallowedTools');
    for (const d of ['Bash(minions runtime set*)', 'Bash(security *)', 'Bash(gh auth token*)', 'Bash(cat *secrets*)', 'Bash(git push*)', 'Bash(open *)',
      'Bash(minions auth set*)', 'Bash(minions auth github*)', 'Bash(minions auth telegram*)', 'Bash(minions channel set*)']) expect(denied).toContain(d);
    // Host-side secret stores are unreadable; host-side minions files are not editable.
    const p = projectPaths(id);
    expect(denied).toContain(`Read(/${credentialStoreDir()}/**)`);
    expect(denied).toContain(`Read(/${p.secretsDir}/**)`);
    expect(denied).toContain(`Read(/${join(env.home, 'projects', '*', 'secrets')}/**)`);
    expect(denied).toContain(`Read(/${join(env.home, 'projects', '*', 'credentials.json')})`);
    for (const d of ['Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/gh/**)', 'Read(~/.netrc)', 'Read(~/Library/Keychains/**)']) expect(denied).toContain(d);
    for (const f of [p.projectJson, join(env.home, 'defaults.json'), p.credentialsJson]) expect(denied).toContain(`Edit(/${f})`);
    expect(denied).toContain(`Edit(/${p.secretsDir}/**)`);
    expect(denied.every((d) => !d.startsWith('Read(//') || d.startsWith(`Read(//${env.home.slice(1)}`))).toBe(true);
    // No allowed rule is also a write/credential command.
    expect(variadic(args, '--allowedTools').some((a) => /push|auth set|runtime set|Edit|Write/.test(a))).toBe(false);

    // Plugin dir + appended instructions; the prompt is the last argv element after a single-value option.
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe(A.assistantPluginDir(id));
    expect(args.at(-1)).toBe(A.ASSISTANT_PROMPT);
    expect(args.at(-3)).toBe('--permission-mode');
    expect(args.indexOf('--allowedTools')).toBeLessThan(args.indexOf('--plugin-dir'));
    expect(args.indexOf('--disallowedTools')).toBeLessThan(args.indexOf('--plugin-dir'));
  });

  it('renders the instructions with the project context and the hard rules', async () => {
    const { id, repo, ctx } = await project('shared');
    const plan = await A.planAssistant(ctx);
    const sp = plan.args[plan.args.indexOf('--append-system-prompt') + 1]!;
    expect(sp).toBe(plan.systemPrompt);
    expect(sp).toContain(id);
    expect(sp).toContain(join(repo, '.minions', 'config.json'));
    expect(sp).toMatch(/Never ask for, accept, or repeat a secret/);
    expect(sp).toMatch(/! minions auth github/);
    expect(sp).toMatch(/Never switch the agent runtime, never push, never open a browser/);
    expect(sp).toMatch(/Show a diff before every edit/);
    const skill = plan.files.find((f) => f.path.endsWith('SKILL.md'))!.content;
    expect(skill).toMatch(/^---\nname: setup\ndescription: /);
    for (const c of ['minions doctor --json', 'minions status --json', 'minions auth show --json', 'minions config show --explain', 'git remote -v', 'configRevision']) expect(skill).toContain(c);
    expect(skill).toContain('commit `.minions/config.json`');
    expect(skill).toMatch(/runs only inside the agent runtime/);
    for (const t of [sp, skill]) expect(t).not.toMatch(/\{\{|\}\}/);
  });

  it('dry-run planning writes nothing', async () => {
    const { id, ctx } = await project();
    await A.planAssistant(ctx);
    expect(existsSync(A.assistantPluginDir(id))).toBe(false);
  });
});

describe('launch (fake claude on PATH)', () => {
  it('writes the host plugin and runs claude in the repository root with the generated argv', async () => {
    const { id, repo, ctx } = await project();
    const { log } = fakeClaude();
    const info: string[] = [];
    const code = await A.launchAssistant(ctx, { onInfo: (l) => info.push(l) });
    expect(code).toBe(0);
    const rec = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; cwd: string };
    expect(rec.cwd).toBe(repo);
    expect(rec.argv).toEqual((await A.planAssistant(ctx)).args);
    const dir = A.assistantPluginDir(id);
    expect(JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'))).toMatchObject({ name: 'minions-setup' });
    expect(readFileSync(join(dir, 'skills', 'setup', 'SKILL.md'), 'utf8')).toMatch(/name: setup/);
    expect(info.join('\n')).toMatch(/permission prompts stay on/);
  });

  it('fails with a precondition when claude is not on PATH', async () => {
    const { ctx } = await project();
    process.env.PATH = join(env.root, 'empty');
    await expect(A.launchAssistant(ctx)).rejects.toMatchObject({ code: 'PRECONDITION' });
  });

  describe.runIf(!!realClaude)('claude plugin validate', () => {
    it('accepts the generated assistant plugin', async () => {
      const { id, ctx } = await project();
      await A.writeAssistantPlugin(await A.planAssistant(ctx));
      const res = spawnSync(realClaude!, ['plugin', 'validate', '--strict', A.assistantPluginDir(id)], { encoding: 'utf8', timeout: 60_000 });
      expect(res.status, res.stdout + res.stderr).toBe(0);
    }, 70_000);
  });
});

describe('init offer', () => {
  const base = { json: false, stdinTTY: true, stdoutTTY: true };
  it('only an interactive init with a terminal may offer the assistant', () => {
    expect(A.initMayOfferAssistant(base)).toBe(true);
    expect(A.initMayOfferAssistant({ ...base, yes: true })).toBe(false);
    expect(A.initMayOfferAssistant({ ...base, config: 'c.json' })).toBe(false);
    expect(A.initMayOfferAssistant({ ...base, json: true })).toBe(false);
    expect(A.initMayOfferAssistant({ ...base, dryRun: true })).toBe(false);
    expect(A.initMayOfferAssistant({ ...base, stdinTTY: false })).toBe(false);
    expect(A.initMayOfferAssistant({ ...base, stdoutTTY: false })).toBe(false);
  });

  const io = (answer: string) => { const asked: string[] = []; const info: string[] = []; return { asked, info, io: { ask: async (q: string) => { asked.push(q); return answer; }, info: (l: string) => info.push(l) } }; };

  it('--yes / non-interactive: never asks and never launches', async () => {
    const s = io('y');
    const launch = vi.fn(async () => 0);
    expect(await A.offerSetupAssistant({ interactive: false, io: s.io, launch, claudeAvailable: async () => true })).toBe('skipped');
    expect(s.asked).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
  });

  it('asks "[Y/n]"; Enter or y launches, n declines', async () => {
    for (const [answer, outcome] of [['', 'launched'], ['y', 'launched'], ['YES', 'launched'], ['n', 'declined']] as const) {
      const s = io(answer);
      const launch = vi.fn(async () => 0);
      expect(await A.offerSetupAssistant({ interactive: true, io: s.io, launch, claudeAvailable: async () => true })).toBe(outcome);
      expect(s.asked).toEqual(['Open the setup assistant to finish remaining setup? [Y/n]']);
      expect(launch).toHaveBeenCalledTimes(outcome === 'launched' ? 1 : 0);
    }
  });

  it('without claude on PATH: no question, a hint instead; a failed launch never fails init', async () => {
    const s = io('y');
    const launch = vi.fn(async () => 0);
    expect(await A.offerSetupAssistant({ interactive: true, io: s.io, launch, claudeAvailable: async () => false })).toBe('unavailable');
    expect(s.asked).toEqual([]);
    expect(s.info.join(' ')).toMatch(/minions setup assist/);
    const t = io('');
    expect(await A.offerSetupAssistant({ interactive: true, io: t.io, launch: async () => { throw new Error('boom'); }, claudeAvailable: async () => true })).toBe('unavailable');
  });
});

describe('doctor setup check', () => {
  it('points at the setup assistant when there are obvious gaps', async () => {
    const { setupGapsCheck } = await import('../../src/host/doctor.js');
    const cfg = (commands: string[], channel: 'terminal' | 'telegram' = 'terminal') => ({ verification: { commands, testerRequired: true, reviewerRequired: true, ciAuthority: 'none' as const }, communication: { channel, progress: 'milestones' as const } });
    const none = { onGitHub: false, githubCredential: null, telegramToken: 'missing' as const };
    const gap = setupGapsCheck(cfg([]), none);
    expect(gap).toMatchObject({ name: 'setup', status: 'warn' });
    expect(gap.detail).toMatch(/no verification commands/);
    expect(gap.hint).toMatch(/minions setup assist/);
    expect(setupGapsCheck(cfg(['npm test']), { ...none, onGitHub: true, githubCredential: 'missing' }).detail).toMatch(/GitHub remote without a stored token/);
    expect(setupGapsCheck(cfg(['npm test'], 'telegram'), none).detail).toMatch(/Telegram/);
    expect(setupGapsCheck(cfg(['npm test']), none)).toMatchObject({ status: 'ok' });
  });
});
