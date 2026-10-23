// The test-suite guard (test/setup): CLAUDE_CONFIG_DIR is a temp dir for every worker, and starting
// `claude` with the real config dir throws and fails the test. Every call here uses PATH=/nonexistent,
// so nothing would run even if the guard let it through.
import { execSync, fork, spawnSync } from 'node:child_process';
import { constants as fsConstants, createWriteStream, existsSync, linkSync, mkdirSync, mkdtempSync, open, openSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { run } from '../src/core/exec.js';
import { atomicWrite } from '../src/core/fsutil.js';
import { runtimePaths } from '../src/runtime/paths.js';
import { effectiveConfigDir, protectedTarget, startsClaude, takeViolations, writesWithFlags } from './setup/claude-guard.js';

const realDirs = JSON.parse(process.env.MINIONS_TEST_REAL_CLAUDE_DIRS ?? '[]') as string[];
const isolated = process.env.MINIONS_TEST_CLAUDE_CONFIG_DIR!;
const noPath = { PATH: '/nonexistent' };

afterEach(() => { takeViolations(); });

describe('test claude isolation', () => {
  it('points CLAUDE_CONFIG_DIR at a temp dir that is not a real config dir', () => {
    expect(isolated).toBeTruthy();
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(isolated);
    expect(realDirs.length).toBeGreaterThan(0);
    expect(realDirs).not.toContain(isolated);
  });

  it('recognizes claude invocations', () => {
    expect(startsClaude('claude', [], false)).toBe(true);
    expect(startsClaude('/usr/local/bin/claude', ['plugin', 'validate'], false)).toBe(true);
    expect(startsClaude('claude --version', [], true)).toBe(true);
    expect(startsClaude('sh', ['-c', 'cd x && claude -p hi'], false)).toBe(true);
    expect(startsClaude('tmux', ['new-session', '-d', 'claude', '--model', 'x'], false)).toBe(true);
    expect(startsClaude('git', ['add', '.claude/settings.json'], false)).toBe(false);
    expect(startsClaude('cat ~/.claude/settings.json', [], true)).toBe(false);
    expect(startsClaude('claude-plugin', [], false)).toBe(false);
  });

  it('recognizes claude behind shell flags, wrapper programs, and the package binary', () => {
    expect(startsClaude('bash', ['-lc', 'claude -p hi'], false)).toBe(true);
    expect(startsClaude('/bin/sh', ['-e', '-c', 'exec claude'], false)).toBe(true);
    expect(startsClaude('/usr/bin/env', ['FOO=1', 'claude', '--version'], false)).toBe(true);
    expect(startsClaude('timeout', ['60', 'claude', '-p', 'x'], false)).toBe(true);
    expect(startsClaude('npx', ['claude'], false)).toBe(true);
    expect(startsClaude('tmux', ['send-keys', '-t', 'x', 'claude --model y', 'Enter'], false)).toBe(true);
    expect(startsClaude('/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', [], false)).toBe(true);
    expect(startsClaude('env', ['git', 'status'], false)).toBe(false);
    expect(startsClaude('bash', ['-c', 'cat .claude/settings.json'], false)).toBe(false);
  });

  it('resolves the config dir claude would use', () => {
    expect(effectiveConfigDir({ CLAUDE_CONFIG_DIR: '/x/cfg', HOME: '/h' })).toBe('/x/cfg');
    expect(effectiveConfigDir({ HOME: '/h' })).toBe(join('/h', '.claude'));
    expect(realDirs).toContain(effectiveConfigDir({}));
    expect(effectiveConfigDir({ CLAUDE_CONFIG_DIR: '.claude' }, '/h')).toBe(join('/h', '.claude'));
  });

  it('refuses spawnSync/execSync/run of claude with the real config dir and records the violation', async () => {
    expect(() => spawnSync('claude', ['--version'], { env: noPath })).toThrow(/test guard: refusing to start `claude --version`/);
    expect(() => execSync('claude --version', { env: noPath, stdio: 'ignore' })).toThrow(/test guard/);
    await expect(run('claude', ['plugin', 'list'], { env: noPath, allowFailure: true })).rejects.toThrow(/test guard/);
    expect(takeViolations()).toHaveLength(3);
  });

  it('refuses claude through a wrapper, a shell flag combo, fork, or a relative real config dir', () => {
    expect(() => spawnSync('/usr/bin/env', ['claude', '--version'], { env: noPath })).toThrow(/test guard/);
    expect(() => spawnSync('bash', ['-lc', 'claude --version'], { env: noPath })).toThrow(/test guard/);
    expect(() => fork('/nonexistent/@anthropic-ai/claude-code/cli.js', [], { env: noPath, silent: true })).toThrow(/test guard/);
    expect(() => spawnSync('claude', [], { env: { ...noPath, CLAUDE_CONFIG_DIR: '.claude' }, cwd: homedir() })).toThrow(/test guard/);
    expect(takeViolations()).toHaveLength(4);
  });

  it('allows claude with an isolated config dir', () => {
    const r = spawnSync('claude', ['--version'], { env: { ...noPath, CLAUDE_CONFIG_DIR: isolated } });
    expect((r.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
    expect(takeViolations()).toEqual([]);
  });
});

describe('test write guard for the real Claude Code config (task-51)', () => {
  afterEach(() => { takeViolations(); });

  it('runtimePaths from the test env resolves settings.json and the Telegram state outside every real config dir', () => {
    const p = runtimePaths({ ...process.env });
    expect(protectedTarget(p.claudeUserSettings)).toBeNull();
    expect(protectedTarget(join(p.telegramStateDir, 'bot.pid'))).toBeNull();
    expect(p.claudeUserSettings.startsWith(isolated)).toBe(true);
  });

  it('names every real config dir\'s settings.json as protected', () => {
    for (const d of realDirs) expect(protectedTarget(join(d, 'settings.json'))).toBe(join(d, 'settings.json'));
  });

  // The write checks run against a stand-in "real" dir (the guard reads the list per call), so a
  // broken guard could only ever clobber a temp dir, never the user's ~/.claude.
  it('refuses writes, renames and removals of settings.json and channels/telegram before touching them', async () => {
    const real = mkdtempSync(join(tmpdir(), 'minions-guard-fake-real-'));
    mkdirSync(join(real, 'channels', 'telegram'), { recursive: true });
    const saved = process.env.MINIONS_TEST_REAL_CLAUDE_DIRS;
    process.env.MINIONS_TEST_REAL_CLAUDE_DIRS = JSON.stringify([real]);
    onTestFinished(() => { process.env.MINIONS_TEST_REAL_CLAUDE_DIRS = saved; });
    const settings = join(real, 'settings.json');
    const botPid = join(real, 'channels', 'telegram', 'bot.pid');
    expect(protectedTarget(settings)).toBe(settings);
    expect(protectedTarget(join(real, '.settings.json.1.ab.tmp'))).toBeTruthy();
    expect(protectedTarget(join(real, 'channels', 'telegram'))).toBeTruthy();
    expect(protectedTarget(join(real, 'projects', 'x.json'))).toBeNull();
    expect(protectedTarget(join(real, 'channels', 'telegram-other'))).toBeNull();
    expect(() => writeFileSync(botPid, '1')).toThrow(/test guard: refusing writeFileSync/);
    expect(() => renameSync('/nonexistent/a', settings)).toThrow(/test guard: refusing renameSync/);
    await expect(fsp.writeFile(settings, '{}')).rejects.toThrow(/test guard/);
    await expect(fsp.rm(join(real, 'channels', 'telegram'), { recursive: true })).rejects.toThrow(/test guard/);
    // atomicWrite (named ESM imports in src/) stages a temp file beside the target: refused too.
    await expect(atomicWrite(settings, '{}')).rejects.toThrow(/test guard/);
    expect(takeViolations()).toHaveLength(6); // atomicWrite: the temp writeFile and its cleanup rm
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(botPid)).toBe(false);
    expect(readdirSync(real).filter((f) => f.startsWith('.settings.json.'))).toEqual([]);
  });

  it('task-52: also refuses createWriteStream, writing opens, mkdir and symlink/link into the protected paths; reads stay allowed', async () => {
    const real = mkdtempSync(join(tmpdir(), 'minions-guard-fake-real-'));
    const saved = process.env.MINIONS_TEST_REAL_CLAUDE_DIRS;
    process.env.MINIONS_TEST_REAL_CLAUDE_DIRS = JSON.stringify([real]);
    onTestFinished(() => { process.env.MINIONS_TEST_REAL_CLAUDE_DIRS = saved; });
    const settings = join(real, 'settings.json');
    const tg = join(real, 'channels', 'telegram');
    const src = join(isolated, 'guard-src.txt');
    expect(() => createWriteStream(settings)).toThrow(/test guard: refusing createWriteStream/);
    expect(() => openSync(settings, 'w')).toThrow(/test guard: refusing openSync/);
    expect(() => openSync(settings, fsConstants.O_WRONLY | fsConstants.O_CREAT)).toThrow(/test guard: refusing openSync/);
    await expect(fsp.open(join(tg, 'bot.pid'), 'a')).rejects.toThrow(/test guard: refusing open/);
    expect(() => open(settings, 'r+', () => undefined)).toThrow(/test guard: refusing open/);
    expect(() => mkdirSync(tg, { recursive: true })).toThrow(/test guard: refusing mkdirSync/);
    await expect(fsp.mkdir(tg, { recursive: true })).rejects.toThrow(/test guard: refusing mkdir/);
    expect(() => symlinkSync(src, settings)).toThrow(/test guard: refusing symlinkSync/);
    await expect(fsp.symlink(src, settings)).rejects.toThrow(/test guard: refusing symlink/);
    expect(() => linkSync(src, settings)).toThrow(/test guard: refusing linkSync/);
    expect(takeViolations()).toHaveLength(10);
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(tg)).toBe(false);
    // Reading opens (default 'r', O_RDONLY) are not writes: they reach the fs and fail with ENOENT.
    expect(() => (openSync as (p: string) => number)(settings)).toThrow(/ENOENT/);
    expect(() => openSync(settings, fsConstants.O_RDONLY)).toThrow(/ENOENT/);
    await expect(fsp.open(settings, 'r')).rejects.toThrow(/ENOENT/);
    expect(takeViolations()).toEqual([]);
    expect(writesWithFlags('r')).toBe(false);
    expect(writesWithFlags(undefined)).toBe(false);
    expect(writesWithFlags('wx')).toBe(true);
    expect(writesWithFlags(fsConstants.O_RDWR)).toBe(true);
  });
});
