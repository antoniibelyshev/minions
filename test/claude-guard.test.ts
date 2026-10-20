// The test-suite guard (test/setup): CLAUDE_CONFIG_DIR is a temp dir for every worker, and starting
// `claude` with the real config dir throws and fails the test. Every call here uses PATH=/nonexistent,
// so nothing would run even if the guard let it through.
import { execSync, fork, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/core/exec.js';
import { effectiveConfigDir, startsClaude, takeViolations } from './setup/claude-guard.js';

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
