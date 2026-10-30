// The drain hook's plugin gate (task-3.7): the PreToolUse command in hooks.json is a shell one-liner that starts
// `minions hook drain` only while the drain flag file exists. These run the real `sh` (integration tier); the hook
// logic itself is unit-tested in drain.test.ts.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRAIN_HOOK_COMMAND } from '../../src/runtime/drain.js';
import { tmp } from './fixtures.js';
import { shq } from '../helpers.js';

describe('drain hook gate (sh)', () => {
  const gateEnv = () => {
    const dir = tmp('minions-drain-gate2-');
    const state = join(dir, 'state');
    mkdirSync(join(state, 'run'), { recursive: true });
    return { dir, state };
  };
  const runGate = (env: Record<string, string>) => {
    try {
      execFileSync('sh', ['-c', DRAIN_HOOK_COMMAND], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return 0;
    } catch (e) { return (e as { status: number }).status; }
  };

  it('the plugin gate runs minions only while the flag file exists (no node start otherwise)', () => {
    const dir = tmp('minions-drain-gate-');
    const bin = join(dir, 'bin');
    const state = join(dir, 'state');
    mkdirSync(bin); mkdirSync(join(state, 'run'), { recursive: true });
    writeFileSync(join(bin, 'minions'), `#!/bin/sh\necho "called $*" >> ${shq(join(dir, 'calls'))}\n`);
    chmodSync(join(bin, 'minions'), 0o755);
    const run = () => execFileSync('sh', ['-c', DRAIN_HOOK_COMMAND], { env: { PATH: `${bin}:/usr/bin:/bin`, MINIONS_STATE_DIR: state }, encoding: 'utf8' });
    run();
    expect(existsSync(join(dir, 'calls'))).toBe(false);
    writeFileSync(join(state, 'run', 'drain'), '{}');
    run();
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe('called hook drain\n');
  });


  it('the gate never exits 2 (the only blocking PreToolUse exit code), even with a missing or broken minions binary', () => {
    const { dir, state } = gateEnv();
    const empty = join(dir, 'empty-bin');
    const broken = join(dir, 'broken-bin');
    mkdirSync(empty); mkdirSync(broken);
    writeFileSync(join(broken, 'minions'), '#!/bin/sh\necho boom >&2\nexit 1\n');
    chmodSync(join(broken, 'minions'), 0o755);
    // No flag: exit 0 without looking for minions at all.
    expect(runGate({ PATH: `${empty}:/usr/bin:/bin`, MINIONS_STATE_DIR: state })).toBe(0);
    writeFileSync(join(state, 'run', 'drain'), '{}');
    // Flag present: a missing binary is 127 and a crashing one 1; both are non-blocking hook errors.
    expect(runGate({ PATH: `${empty}:/usr/bin:/bin`, MINIONS_STATE_DIR: state })).toBe(127);
    expect(runGate({ PATH: `${broken}:/usr/bin:/bin`, MINIONS_STATE_DIR: state })).toBe(1);
  });

  it('the hooks.json command string keeps the ${MINIONS_STATE_DIR:-/state} default for the shell (no JSON escaping)', () => {
    const json = JSON.parse(readFileSync(new URL('../../templates/plugin/hooks/hooks.json', import.meta.url), 'utf8')) as
      { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } };
    const entry = json.hooks.PreToolUse.find((h) => h.matcher === '*');
    expect(entry?.hooks[0]?.command).toBe(DRAIN_HOOK_COMMAND);
    expect(DRAIN_HOOK_COMMAND).toContain('"${MINIONS_STATE_DIR:-/state}/run/drain"');
    // Shell expansion of the default, without touching the real /state.
    const expanded = execFileSync('sh', ['-c', 'echo ${MINIONS_STATE_DIR:-/state}/run/drain'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(expanded.trim()).toBe('/state/run/drain');
  });

  it('the gate handles a state dir with a space: exit 0 without the flag, runs minions with it', () => {
    const { dir } = gateEnv();
    const state = join(dir, 'state with space');
    mkdirSync(join(state, 'run'), { recursive: true });
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'minions'), `#!/bin/sh\necho "called $*" >> "${join(dir, 'calls')}"\n`);
    chmodSync(join(bin, 'minions'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, MINIONS_STATE_DIR: state };
    expect(runGate(env)).toBe(0);
    expect(existsSync(join(dir, 'calls'))).toBe(false);
    writeFileSync(join(state, 'run', 'drain'), '{}');
    expect(runGate(env)).toBe(0);
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe('called hook drain\n');
  });
});
