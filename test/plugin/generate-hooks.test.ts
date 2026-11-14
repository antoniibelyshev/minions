// The generated plugin run for real (task-137.2.6): the pre-agent hook command through a shell with fake
// minions binaries, and the opt-in `claude plugin validate`. Everything about the generated files themselves
// is in the unit tier (test/plugin/generate.test.ts).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePlugin } from '../../src/plugin/generate.js';
import { defaults, FAKE_MINIONS, runHookCommand } from '../helpers.js';

const dirs: string[] = [];
const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'minions-plugin-')); dirs.push(d); return d; };
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function gen() {
  const out = await tmp();
  await generatePlugin(defaults(), out);
  return { out, read: (rel: string) => readFile(join(out, rel), 'utf8') };
}

describe('generated pre-agent hook', () => {
  it('the generated pre-agent hook fails closed: a missing or crashing minions blocks the Agent launch', async () => {
    const hooks = JSON.parse(await (await gen()).read('hooks/hooks.json'));
    const entry = (hooks.hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[]).find((h) => h.matcher === 'Agent');
    const command = entry!.hooks[0]!.command;
    const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'minions:engineer', prompt: 'x' } });
    // Exit 2 is the only blocking PreToolUse exit; 127 (not found), 1 (crash) or 137 (killed) would let the launch through.
    expect(runHookCommand(command, null, stdin).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.crash, stdin).status).toBe(2);
    expect(runHookCommand(command, FAKE_MINIONS.killed, stdin).status).toBe(2);
    // A healthy hook exits 0 and decides through stdout, unchanged by the wrapper.
    expect(runHookCommand(command, FAKE_MINIONS.allow, stdin)).toMatchObject({ status: 0, stdout: '' });
    const denied = runHookCommand(command, FAKE_MINIONS.deny, stdin);
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
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
