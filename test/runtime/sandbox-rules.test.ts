// task-14.3: per-role L1 rules generation and the argv/JSON contract between the runner and minions-sandbox
// (docs/design/agent-runtimes.md D4). Pure: no helper binary needed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TCP_CONNECT_PORTS, SANDBOX_BIN, SANDBOX_MIN_ABI, SANDBOX_RULES_VERSION, SYSTEM_FS_RULES,
  assertRulesSafe, buildSandboxRules, containerProtectedPaths, sandboxArgv, serializeRules, within,
  type BuildRulesInput, type SandboxRoleView, type SandboxRules,
} from '../../src/runtime/sandbox/rules.js';
import { containerPaths } from '../../src/core/paths.js';

const C = containerPaths('');
const SCRATCH = '/home/node/.cache/tmp/leases/lease-1';
const COMMON = '/workspace/repo/.git';
const OBJECTS = `${COMMON}/objects`;
const LEASE_WT = '/workspace/worktrees/task-1';
const PROTECTED = containerProtectedPaths(
  { state: C.state, secretsDir: C.secretsDir, configDir: C.configDir, pluginDir: C.pluginDir, claudeHome: C.claudeHome, workspace: C.workspace },
  { commonDir: COMMON, leaseWorktree: LEASE_WT },
);
const ROLES: SandboxRoleView[] = [
  { name: 'engineer', contract: 'producer', harness: 'codex' },
  { name: 'tester', contract: 'verifier', harness: 'codex' },
  { name: 'reviewer', contract: 'gate', harness: 'junie' },
  { name: 'codex-reviewer', contract: 'gate', harness: 'codex' },
];
const input = (role: SandboxRoleView, over: Partial<BuildRulesInput> = {}): BuildRulesInput => ({
  role, leaseId: 'lease-1', protectedPaths: PROTECTED,
  layout: { scratchDir: SCRATCH, gitObjectsDir: OBJECTS, harnessDir: `/opt/${role.harness}` },
  ...over,
});
const rule = (r: SandboxRules, path: string) => r.fs.find((x) => x.path === path);

describe('buildSandboxRules: per-role rules', () => {
  it.each(ROLES)('$name ($contract, $harness): system read rules, scratch rwx, objects read-only, harness rx', (role) => {
    const r = buildSandboxRules(input(role));
    expect(r).toMatchObject({ version: SANDBOX_RULES_VERSION, minAbi: SANDBOX_MIN_ABI, tcpConnectPorts: [...DEFAULT_TCP_CONNECT_PORTS] });
    expect(r.label).toBe(`lease-1 ${role.name} (${role.contract}, ${role.harness})`);
    expect(rule(r, SCRATCH)?.access).toEqual(['read', 'write', 'execute']);
    expect(rule(r, OBJECTS)?.access).toEqual(['read']);
    expect(rule(r, `/opt/${role.harness}`)?.access).toEqual(['read', 'execute']);
    expect(r.selfTest).toBeUndefined();
    // D4: /proc, /sys and /dev read rules; /dev/null is the only writable path outside the scratch dir.
    expect(rule(r, '/proc')?.access).toEqual(['read']);
    expect(rule(r, '/sys/fs/cgroup')).toMatchObject({ access: ['read'], optional: true });
    expect(rule(r, '/sys/devices/system/cpu')).toMatchObject({ access: ['read'], optional: true });
    for (const d of ['/dev/zero', '/dev/random', '/dev/urandom']) expect(rule(r, d)?.access).toEqual(['read']);
    expect(rule(r, '/dev/null')?.access).toEqual(['read', 'write']);
    const writable = r.fs.filter((x) => x.access.includes('write')).map((x) => x.path);
    expect(writable).toEqual(['/dev/null', SCRATCH]);
    expect(rule(r, '/usr')?.access).toEqual(['read', 'execute']);
    expect(rule(r, '/etc')?.access).toEqual(['read']);
  });

  it('gives every contract the same filesystem shape (gates are read-only towards the squad by L4, not L1)', () => {
    const shapes = ROLES.map((role) => buildSandboxRules(input({ ...role, harness: 'codex' })).fs);
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });

  it('never exposes a protected container path (D4 deny list), for every role', () => {
    for (const role of ROLES) {
      const r = buildSandboxRules(input(role));
      for (const q of [C.state, C.db, C.secretsDir, `${C.secretsDir}/github-token`, C.claudeHome, C.repo, `${COMMON}/config`, `${COMMON}/refs`,
        `${COMMON}/worktrees`, LEASE_WT, C.worktrees, C.review, '/tmp', '/tmp/tmux-1000/default', '/dev/shm', C.configDir, C.pluginDir]) {
        const covering = r.fs.filter((x) => within(q, x.path));
        expect(covering, q).toEqual([]);
      }
      // The only rule inside a protected path is the read-only object store.
      expect(r.fs.filter((x) => PROTECTED.some((p) => within(x.path, p)))).toEqual([{ path: OBJECTS, access: ['read'] }]);
    }
  });

  it('uses harnesses.network.tcpConnectPorts, de-duplicated', () => {
    expect(buildSandboxRules(input(ROLES[0]!, { tcpConnectPorts: [443, 8443, 443] })).tcpConnectPorts).toEqual([443, 8443]);
  });

  it('adds toolchains outside /usr as read+execute and skips ones under /usr', () => {
    const r = buildSandboxRules(input(ROLES[0]!, { layout: { scratchDir: SCRATCH, gitObjectsDir: OBJECTS, harnessDir: null, toolchainDirs: ['/opt/node-22', '/usr/local'] } }));
    expect(rule(r, '/opt/node-22')?.access).toEqual(['read', 'execute']);
    expect(rule(r, '/usr/local')).toBeUndefined();
    expect(r.fs.some((x) => x.path.startsWith('/opt/codex'))).toBe(false);
  });

  it.each([
    ['the coordinator', input({ name: 'coordinator', contract: 'gate', harness: 'codex' }), /coordinator never runs/],
    ['the claude harness', input({ name: 'engineer', contract: 'producer', harness: 'claude' }), /in-session/],
    ['a malformed harness id', input({ name: 'engineer', contract: 'producer', harness: '../codex' }), /unknown harness id/],
    ['a scratch dir inside /state', input(ROLES[0]!, { layout: { scratchDir: '/state/scratch', gitObjectsDir: OBJECTS, harnessDir: null } }), /inside the protected path \/state/],
    ['a scratch dir that contains ~/.claude', input(ROLES[0]!, { layout: { scratchDir: '/home/node', gitObjectsDir: OBJECTS, harnessDir: null } }), /expose the protected path \/home\/node\/.claude/],
    ['a scratch dir in /tmp (tmux socket dir)', input(ROLES[0]!, { layout: { scratchDir: '/tmp/x', gitObjectsDir: OBJECTS, harnessDir: null } }), /inside the protected path \/tmp/],
    ['the lease worktree as scratch', input(ROLES[0]!, { layout: { scratchDir: LEASE_WT, gitObjectsDir: OBJECTS, harnessDir: null } }), /protected path/],
    ['a harness dir under /opt/minions', input(ROLES[0]!, { layout: { scratchDir: SCRATCH, gitObjectsDir: OBJECTS, harnessDir: '/opt/minions/secrets' } }), /protected path/],
    ['a toolchain dir of /', input(ROLES[0]!, { layout: { scratchDir: SCRATCH, gitObjectsDir: OBJECTS, harnessDir: null, toolchainDirs: ['/'] } }), /root directory/],
    ['an object dir that is the whole common dir', input(ROLES[0]!, { layout: { scratchDir: SCRATCH, gitObjectsDir: COMMON, harnessDir: null } }), /protected path/],
    ['a relative scratch dir', input(ROLES[0]!, { layout: { scratchDir: 'scratch', gitObjectsDir: OBJECTS, harnessDir: null } }), /normalized absolute/],
    ['a scratch dir with ..', input(ROLES[0]!, { layout: { scratchDir: `${SCRATCH}/../../x`, gitObjectsDir: OBJECTS, harnessDir: null } }), /normalized absolute/],
    ['a trailing slash', input(ROLES[0]!, { layout: { scratchDir: `${SCRATCH}/`, gitObjectsDir: OBJECTS, harnessDir: null } }), /normalized absolute/],
    ['a newline in a path', input(ROLES[0]!, { layout: { scratchDir: `${SCRATCH}\nx`, gitObjectsDir: OBJECTS, harnessDir: null } }), /control character/],
    ['an empty port list', input(ROLES[0]!, { tcpConnectPorts: [] }), /tcpConnectPorts/],
    ['port 0', input(ROLES[0]!, { tcpConnectPorts: [0] }), /tcpConnectPorts/],
    ['port 70000', input(ROLES[0]!, { tcpConnectPorts: [70000] }), /tcpConnectPorts/],
  ])('refuses %s', (_what, i, message) => {
    expect(() => buildSandboxRules(i)).toThrow(message);
  });

  it('assertRulesSafe refuses writes outside the scratch dir, a write rule on the object store, and a low ABI', () => {
    const base = buildSandboxRules(input(ROLES[0]!));
    const ctx = { scratchDir: SCRATCH, gitObjectsDir: OBJECTS, protectedPaths: PROTECTED };
    const withRule = (extra: SandboxRules['fs'][number]): SandboxRules => ({ ...base, fs: [...base.fs, extra] });
    expect(() => assertRulesSafe(base, ctx)).not.toThrow();
    expect(() => assertRulesSafe(withRule({ path: '/etc', access: ['write'] }), ctx)).toThrow(/write access is allowed only inside the scratch dir/);
    expect(() => assertRulesSafe(withRule({ path: OBJECTS, access: ['read', 'write'] }), ctx)).toThrow(/inside the protected path/);
    expect(() => assertRulesSafe(withRule({ path: '/opt', access: ['read'] }), ctx)).toThrow(/expose the protected path \/opt\/minions/);
    expect(() => assertRulesSafe({ ...base, minAbi: 5 }, ctx)).toThrow(/minAbi/);
    expect(() => assertRulesSafe({ ...base, fs: [] }, ctx)).toThrow(/fs must not be empty/);
    expect(() => assertRulesSafe({ ...base, label: 'a\tb' }, ctx)).toThrow(/label/);
  });
});

/** Keys the helper accepts, read from the C source so a contract drift fails here. */
function helperKeys(): { top: string[]; fs: string[]; selfTest: string[]; access: string[]; version: number; minAbi: number } {
  const src = readFileSync(join(import.meta.dirname, '..', '..', 'docker', 'minions-sandbox', 'minions-sandbox.c'), 'utf8');
  const list = (re: RegExp) => [...(re.exec(src)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  return {
    top: list(/top\[\] = \{([^}]*)\}/),
    fs: list(/keys\[\] = \{ ("path"[^}]*)\}/),
    selfTest: list(/keys\[\] = \{ ("fixtureDir"[^}]*)\}/),
    access: [...src.matchAll(/strcmp\(s, "(read|write|execute)"\)/g)].map((m) => m[1]!),
    version: Number(/#define RULES_VERSION (\d+)/.exec(src)?.[1]),
    minAbi: Number(/#define MIN_ABI (\d+)/.exec(src)?.[1]),
  };
}

describe('rules JSON contract with docker/minions-sandbox/minions-sandbox.c', () => {
  it('emits only keys, access names and versions the helper accepts (it refuses unknown keys)', () => {
    const k = helperKeys();
    expect(k.top).toEqual(['version', 'minAbi', 'label', 'fs', 'tcpConnectPorts', 'selfTest']);
    expect(k.version).toBe(SANDBOX_RULES_VERSION);
    expect(k.minAbi).toBe(SANDBOX_MIN_ABI);
    expect(k.access.sort()).toEqual(['execute', 'read', 'write']);
    const rules: SandboxRules = {
      ...buildSandboxRules(input(ROLES[0]!)),
      selfTest: { fixtureDir: '/f', allowWrite: `${SCRATCH}/w`, allowRead: ['/usr/bin'], denyRead: ['/state/minions.db'], denyWrite: ['/state'] },
    };
    const parsed = JSON.parse(serializeRules(rules)) as Record<string, unknown> & { fs: Record<string, unknown>[]; selfTest: Record<string, unknown> };
    for (const key of Object.keys(parsed)) expect(k.top, key).toContain(key);
    for (const r of parsed.fs) for (const key of Object.keys(r)) expect(k.fs, key).toContain(key);
    for (const key of Object.keys(parsed.selfTest)) expect(k.selfTest, key).toContain(key);
    expect(serializeRules(rules).endsWith('\n')).toBe(true);
  });

  it('keeps the system rules in the shape the helper validates (absolute, optional only as a boolean)', () => {
    for (const r of SYSTEM_FS_RULES) {
      expect(r.path.startsWith('/')).toBe(true);
      if (r.optional !== undefined) expect(typeof r.optional).toBe('boolean');
    }
  });
});

describe('sandboxArgv: the runner -> helper argv', () => {
  const RULES_FILE = '/state/run/leases/lease-1/sandbox-rules.json';
  const SECRET = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

  it('is <helper> --rules <file> -- <command...>, with the helper at its literal path', () => {
    expect(sandboxArgv(RULES_FILE, ['codex', 'exec', '--json', '-'], { scratchDir: SCRATCH, secretValues: [SECRET] }))
      .toEqual([SANDBOX_BIN, '--rules', RULES_FILE, '--', 'codex', 'exec', '--json', '-']);
    expect(SANDBOX_BIN).toBe('/usr/local/bin/minions-sandbox');
  });

  it('refuses a secret anywhere in argv (it would show in ps and /proc/<pid>/cmdline)', () => {
    for (const cmd of [['junie', `--auth=${SECRET}`], ['codex', '-c', `x=${SECRET}`], [SECRET]]) {
      expect(() => sandboxArgv(RULES_FILE, cmd, { scratchDir: SCRATCH, secretValues: ['', SECRET] })).toThrow(/secret in its argv/);
    }
    // Too-short values are not treated as secrets (an empty credential file must not block every launch).
    expect(() => sandboxArgv(RULES_FILE, ['codex', 'exec'], { scratchDir: SCRATCH, secretValues: ['', 'x'] })).not.toThrow();
  });

  it('refuses a rules file inside the worker-writable scratch dir, a relative rules path and an empty command', () => {
    expect(() => sandboxArgv(`${SCRATCH}/rules.json`, ['codex'], { scratchDir: SCRATCH, secretValues: [] })).toThrow(/outside the worker-writable scratch dir/);
    expect(() => sandboxArgv('rules.json', ['codex'], { scratchDir: SCRATCH, secretValues: [] })).toThrow(/absolute/);
    expect(() => sandboxArgv(RULES_FILE, [], { scratchDir: SCRATCH, secretValues: [] })).toThrow(/no command/);
  });
});

describe('docker/Dockerfile builds the helper (owner-approved infrastructure change)', () => {
  const dockerfile = readFileSync(join(import.meta.dirname, '..', '..', 'docker', 'Dockerfile'), 'utf8');

  it('compiles it statically in a digest-pinned builder stage and installs only the binary at the literal path', () => {
    expect(dockerfile).toMatch(/^FROM gcc:\d+\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64} AS sandbox$/m);
    expect(dockerfile).toContain('COPY docker/minions-sandbox/minions-sandbox.c /src/minions-sandbox.c');
    expect(dockerfile).toMatch(/gcc -std=gnu11 -O2 -Wall -Wextra .*-static/);
    expect(dockerfile).toContain(`COPY --from=sandbox /out/minions-sandbox ${SANDBOX_BIN}`);
    const helperVersion = /#define HELPER_VERSION "([^"]+)"/.exec(readFileSync(join(import.meta.dirname, '..', '..', 'docker', 'minions-sandbox', 'minions-sandbox.c'), 'utf8'))?.[1];
    // The build fails unless the binary reports the version of the source it was built from.
    expect(dockerfile).toContain(`/out/minions-sandbox --version | grep -q "^minions-sandbox ${helperVersion!} "`);
  });

  it('is part of the image build fingerprint, so a helper change rebuilds the image', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { buildFingerprint } = await import('../../src/host/docker.js');
    const root = mkdtempSync(join(tmpdir(), 'sbx-fp-'));
    for (const f of ['dist/cli.js', 'docker/Dockerfile', 'docker/gh-wrapper.sh', 'docker/minions-sandbox/minions-sandbox.c', 'package.json']) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), f);
    }
    const before = buildFingerprint(root);
    writeFileSync(join(root, 'docker/minions-sandbox/minions-sandbox.c'), 'changed');
    expect(buildFingerprint(root)).not.toBe(before);
  });
});
