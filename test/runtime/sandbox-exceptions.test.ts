// coordinator.sshHosts (host runtime): ssh/scp/rsync to the owner's hosts run outside the Claude Code sandbox and are
// allowed without a prompt; only the owner sets the list (config.local.json, never the project layer or the overlay).
import { describe, expect, it } from 'vitest';
import type { MinionsConfig } from '../../src/config/schema.js';
import { resolve, validateConfig } from '../../src/config/resolve.js';
import { coordinatorSettings, sshPatterns } from '../../src/runtime/coordinator.js';
import { ownerOnlyKey } from '../../src/runtime/control.js';
import { sandboxExceptionGuidance } from '../../src/plugin/generate.js';
import { preSshHook, sshFormProblem } from '../../src/runtime/hooks.js';
import { defaults } from '../helpers.js';

const host = { home: '/Users/u', workspace: '/r/projects/p/host/workspace', state: '/r/projects/p/host/state', secretsDir: '/r/projects/p/secrets', credentialsDir: '/r/credentials', projectDir: '/r/projects/p', hostRoot: '/r' };
const withHosts = (sshHosts?: string[], sandbox?: boolean): MinionsConfig => ({ ...defaults(), coordinator: { ...defaults().coordinator, sshHosts, ...(sandbox === undefined ? {} : { sandbox }) } });
type Settings = { permissions: { allow: string[] }; sandbox?: { excludedCommands?: string[] } };

describe('coordinator.sshHosts', () => {
  it('excludes ssh/scp/rsync to each host from the sandbox and allows them', () => {
    const s = coordinatorSettings(withHosts(['me@10.0.0.1']), { auth: 'login', host }) as Settings;
    const h = 'me@10.0.0.1';
    const patterns = [`ssh ${h}`, `ssh ${h} *`, ...['scp', 'rsync'].flatMap((p) => [`${p} * ${h}:/*`, `${p} * ${h}:~/*`, `${p} ${h}:/* *`, `${p} ${h}:~/* *`, `${p} * ${h}:/* *`, `${p} * ${h}:~/* *`])];
    // A trailing `:*` is Claude Code's legacy prefix syntax (the * is not a wildcard there).
    expect(patterns.some((p) => p.endsWith(':*'))).toBe(false);
    expect(sshPatterns(['me@10.0.0.1'])).toEqual(patterns);
    expect(s.sandbox?.excludedCommands).toEqual(patterns);
    expect(s.permissions.allow).toEqual(expect.arrayContaining(patterns.map((p) => `Bash(${p})`)));
  });

  it('nothing without hosts, in the container, or with the sandbox off', () => {
    const none = coordinatorSettings(withHosts(), { auth: 'login', host }) as Settings;
    expect(none.sandbox?.excludedCommands).toBeUndefined();
    const container = coordinatorSettings(withHosts(['h']), { auth: 'login', host: null }) as Settings;
    expect(container.permissions.allow.some((a) => a.startsWith('Bash(ssh'))).toBe(false);
    const off = coordinatorSettings(withHosts(['h'], false), { auth: 'login', host }) as Settings;
    expect(off.sandbox).toBeUndefined();
    expect(off.permissions.allow.some((a) => a.startsWith('Bash(ssh'))).toBe(false);
  });

  it('accepts host and user@host only; never from the project layer or the coordinator overlay', () => {
    expect(validateConfig(withHosts(['gpu.example.com', 'me@10.0.0.1'])).coordinator?.sshHosts).toEqual(['gpu.example.com', 'me@10.0.0.1']);
    for (const bad of ['*', 'me@h *', 'h;id', '-oProxyCommand=x', 'me@', '']) expect(() => validateConfig(withHosts([bad]))).toThrow();
    expect(() => resolve({ defaults: defaults(), project: { coordinator: { sshHosts: ['h'] } } })).toThrow(/coordinator\.sshHosts: .* cannot let agent commands reach SSH hosts/);
    expect(resolve({ defaults: defaults(), local: { coordinator: { sshHosts: ['h'] } } }).config.coordinator?.sshHosts).toEqual(['h']);
    expect(ownerOnlyKey('coordinator.sshHosts')).toBe(true);
  });

  it('unsandboxedCommands: excluded and allowed like the SSH patterns; plain patterns only; owner only', () => {
    const cfg = { ...withHosts(['me@h']), coordinator: { ...withHosts(['me@h']).coordinator, unsandboxedCommands: ['uv run python -m training.train *'] } };
    const s = coordinatorSettings(cfg, { auth: 'login', host }) as Settings;
    expect(s.sandbox?.excludedCommands).toEqual([...sshPatterns(['me@h']), 'uv run python -m training.train *']);
    expect(s.permissions.allow).toContain('Bash(uv run python -m training.train *)');
    const v = (p: string) => () => validateConfig({ ...defaults(), coordinator: { ...defaults().coordinator, unsandboxedCommands: [p] } });
    for (const ok of ['uv run python -m training.train *', 'scripts/train.sh *', 'make train']) expect(v(ok)).not.toThrow();
    for (const bad of ['*', 'uv run x; rm -rf ~', 'sh -c "x"', 'a | b', 'x $(id)', '']) expect(v(bad), bad).toThrow();
    expect(() => resolve({ defaults: defaults(), project: { coordinator: { unsandboxedCommands: ['make train'] } } })).toThrow(/cannot run agent commands outside the sandbox/);
    expect(ownerOnlyKey('coordinator.unsandboxedCommands')).toBe(true);
    expect(sandboxExceptionGuidance(cfg)).toMatch(/SSH hosts .* Commands the owner lets run outside the sandbox.*Metal\/MPS\): `uv run python -m training\.train \*`/);
  });

  it('tells the agents how to call the hosts (host runtime, sandbox on)', () => {
    expect(sandboxExceptionGuidance(withHosts(['me@10.0.0.1']))).toMatch(/^SSH hosts the owner opened: `me@10\.0\.0\.1`\..*no options before the host.*nothing after the closing quote/);
    expect(sandboxExceptionGuidance(withHosts())).toBe('');
    expect(sandboxExceptionGuidance(withHosts(['h'], false))).toBe('');
  });
});

describe('coordinator.allowedDomains', () => {
  it('adds the owner\'s hosts to the sandbox network list; host names only; owner only', () => {
    const cfg: MinionsConfig = { ...defaults(), coordinator: { ...defaults().coordinator, allowedDomains: ['crates.io', '*.pythonhosted.org'] } };
    const s = coordinatorSettings(cfg, { auth: 'login', host }) as { sandbox: { network: { allowedDomains: string[] } } };
    expect(s.sandbox.network.allowedDomains).toEqual(['registry.npmjs.org', 'crates.io', '*.pythonhosted.org']);
    const v = (d: string) => () => validateConfig({ ...defaults(), coordinator: { ...defaults().coordinator, allowedDomains: [d] } });
    for (const bad of ['*', 'localhost', 'crates.io/x', 'a b.com', '*.', 'evil.com:22']) expect(v(bad), bad).toThrow();
    expect(() => resolve({ defaults: defaults(), project: { coordinator: { allowedDomains: ['crates.io'] } } })).toThrow(/cannot open network hosts/);
    expect(ownerOnlyKey('coordinator.allowedDomains')).toBe(true);
  });
});

describe('pre-ssh hook: SSH calls that would stay sandboxed', () => {
  const H = 'me@10.0.0.1';
  const problem = (c: string) => sshFormProblem(c, [H]);
  it('allows the exact forms and calls to other hosts', () => {
    for (const ok of [`ssh ${H} 'hostname; nvidia-smi 2>&1 | head -20'`, `ssh ${H}`, `scp -r out ${H}:~/runs/`, `rsync -av ${H}:/data/x ./x`, 'ssh other@host x | head', 'git log --grep=ssh'])
      expect(problem(ok), ok).toBeNull();
  });
  it('names what to change for the forms agents write', () => {
    expect(problem(`ssh ${H} 'hostname' 2>&1 | head -30`)).toMatch(/^nothing outside the quotes/);
    expect(problem(`ssh -o BatchMode=yes ${H} 'hostname'`)).toMatch(/host right after `ssh`/);
    expect(problem(`timeout 20 ssh ${H} 'hostname'`)).toMatch(/no `timeout`/);
    expect(problem(`cd /tmp && ssh ${H} 'x'`)).toMatch(/no `cd`/);
    expect(problem(`scp out ${H}:runs/`)).toMatch(/remote path as/);
  });
  it('the hook denies with the reason and an example; allows otherwise', () => {
    const input = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
    const out = preSshHook(input(`ssh ${H} 'x' 2>&1 | head`), [H]);
    expect(JSON.parse(out.stdout!).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/Operation not permitted.*For example: `ssh me@10\.0\.0\.1 'nvidia-smi 2>&1 \| head -20'`/) });
    expect(preSshHook(input(`ssh ${H} 'x'`), [H]).stdout).toBeUndefined();
    expect(preSshHook(input(`ssh ${H} 'x' | head`), []).stdout).toBeUndefined();
  });
});
