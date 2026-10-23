// L1 isolation rules for process-harness workers (docs/design/agent-runtimes.md D4). The runner writes these
// as JSON for the `minions-sandbox` helper (docker/minions-sandbox/minions-sandbox.c), which applies them
// with Landlock and seccomp before it execs the harness. This file is the contract: the helper refuses
// unknown keys, so both sides change together (bump SANDBOX_RULES_VERSION).
import { isAbsolute, normalize } from 'node:path';
import { MinionsError } from '../../core/errors.js';

/** The helper's literal install path in the image. Deliberately not env-overridable (tests inject it). */
export const SANDBOX_BIN = '/usr/local/bin/minions-sandbox';
export const SANDBOX_RULES_VERSION = 1;
/** Landlock ABI 6 (Linux 6.12): first with signal and abstract-socket scoping (D4). */
export const SANDBOX_MIN_ABI = 6;
export const DEFAULT_TCP_CONNECT_PORTS: readonly number[] = [443];
/** Helper exit statuses that are not the harness's own: sandbox setup failed / not executable / not found. */
export const SANDBOX_EXIT = { setup: 125, notExecutable: 126, notFound: 127 } as const;

export type FsAccess = 'read' | 'write' | 'execute';
export interface FsRule { path: string; access: FsAccess[]; optional?: boolean }
export interface SelfTestSection {
  /** Outside every allowed path: the helper's unix socket fixture lives here. */
  fixtureDir: string;
  /** Inside the scratch dir: the canary must be able to write here (control). */
  allowWrite: string;
  /** Must be readable from inside (control). */
  allowRead: string[];
  /** Must not be readable from inside. */
  denyRead: string[];
  /** Must not be writable from inside. */
  denyWrite: string[];
}
export interface SandboxRules {
  version: typeof SANDBOX_RULES_VERSION;
  minAbi: number;
  label?: string;
  fs: FsRule[];
  tcpConnectPorts: number[];
  selfTest?: SelfTestSection;
}

/**
 * What the rules need from a role. A local view on purpose: the role registry gains `harness` in
 * task-14.2, and the runner (task-14.4) maps the resolved role onto this.
 */
export interface SandboxRoleView {
  name: string;
  contract: 'producer' | 'verifier' | 'gate';
  harness: string;
}

export interface SandboxLayout {
  /** Per-lease scratch dir: read, write, execute (clone `work/`, harness home, tmp, npm cache, brief, result). */
  scratchDir: string;
  /** `<common>/objects`: read only (the clone's alternates). May sit inside a protected path. */
  gitObjectsDir: string;
  /** The harness install dir, e.g. /opt/codex: read and execute. */
  harnessDir: string | null;
  /** Toolchains outside /usr (e.g. a Node prefix elsewhere): read and execute. */
  toolchainDirs?: string[];
}

const RX: FsAccess[] = ['read', 'execute'];
const R: FsAccess[] = ['read'];

/** System paths every worker needs. Optional ones may be absent (merged /usr, other architectures). */
export const SYSTEM_FS_RULES: readonly FsRule[] = [
  { path: '/usr', access: RX },
  { path: '/bin', access: RX, optional: true },
  { path: '/sbin', access: RX, optional: true },
  { path: '/lib', access: RX, optional: true },
  { path: '/lib64', access: RX, optional: true },
  { path: '/lib32', access: RX, optional: true },
  { path: '/libx32', access: RX, optional: true },
  { path: '/etc', access: R },
  // Other processes' /proc entries (environ included) stay denied by Landlock's ptrace rule (self-tested).
  { path: '/proc', access: R },
  // Node and the JVM size heaps and thread pools from these.
  { path: '/sys/fs/cgroup', access: R, optional: true },
  { path: '/sys/devices/system/cpu', access: R, optional: true },
  { path: '/dev/null', access: ['read', 'write'] },
  { path: '/dev/zero', access: R },
  { path: '/dev/random', access: R },
  { path: '/dev/urandom', access: R },
];

/** Paths in the container no process worker may read or write (D4 "Everything else is denied"). */
export function containerProtectedPaths(p: {
  state: string; secretsDir: string; configDir: string; pluginDir: string; claudeHome: string; workspace: string;
}, lease: { commonDir: string; leaseWorktree?: string }): string[] {
  return [p.state, p.secretsDir, p.configDir, p.pluginDir, p.claudeHome, p.workspace, lease.commonDir,
    ...(lease.leaseWorktree ? [lease.leaseWorktree] : []), '/tmp', '/dev/shm'];
}

const bad = (message: string) => new MinionsError('PRECONDITION', `sandbox rules: ${message}`);

/** Absolute, normalized, not `/`, no control characters (they would break the helper's line protocol). */
export function checkRulePath(path: string, what: string): string {
  if (path === '/') throw bad(`${what} must not be the root directory`);
  if (!isAbsolute(path) || normalize(path) !== path || path.endsWith('/') || path.includes('//')) throw bad(`${what} must be a normalized absolute path: ${JSON.stringify(path)}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw bad(`${what} contains a control character`);
  return path;
}

/** `a` is `b` or below it. */
export const within = (a: string, b: string): boolean => a === b || a.startsWith(b + '/');

/**
 * Refuses rules that would open a protected path. An allowed path may be neither inside a protected path
 * nor an ancestor of one; the only exception is the read-only git object dir. Writes are allowed only in
 * the scratch dir and /dev/null.
 */
export function assertRulesSafe(rules: SandboxRules, ctx: { scratchDir: string; gitObjectsDir: string; protectedPaths: readonly string[] }): void {
  if (rules.version !== SANDBOX_RULES_VERSION) throw bad(`version must be ${SANDBOX_RULES_VERSION}`);
  if (!Number.isInteger(rules.minAbi) || rules.minAbi < SANDBOX_MIN_ABI) throw bad(`minAbi must be at least ${SANDBOX_MIN_ABI}`);
  if (!rules.fs.length) throw bad('fs must not be empty');
  if (!rules.tcpConnectPorts.length || rules.tcpConnectPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw bad('tcpConnectPorts must hold ports 1 to 65535 and must not be empty');
  }
  const protectedPaths = ctx.protectedPaths.map((p) => checkRulePath(p, 'protected path'));
  for (const rule of rules.fs) {
    checkRulePath(rule.path, 'fs path');
    if (!rule.access.length || rule.access.some((a) => !['read', 'write', 'execute'].includes(a))) throw bad(`${rule.path}: access must be read, write or execute`);
    const objectsOnly = rule.path === ctx.gitObjectsDir && rule.access.length === 1 && rule.access[0] === 'read';
    for (const q of protectedPaths) {
      if (within(q, rule.path)) throw bad(`${rule.path} would expose the protected path ${q}`);
      if (within(rule.path, q) && !objectsOnly) throw bad(`${rule.path} is inside the protected path ${q}`);
    }
    if (rule.access.includes('write') && rule.path !== '/dev/null' && !within(rule.path, ctx.scratchDir)) {
      throw bad(`${rule.path}: write access is allowed only inside the scratch dir ${ctx.scratchDir}`);
    }
  }
  if (rules.label !== undefined && (rules.label.length > 200 || /[\t\n\r]/.test(rules.label))) throw bad('label must be a short single line');
}

export interface BuildRulesInput {
  role: SandboxRoleView;
  leaseId: string;
  layout: SandboxLayout;
  /** `harnesses.network.tcpConnectPorts`; default [443]. */
  tcpConnectPorts?: readonly number[];
  protectedPaths: readonly string[];
}

/**
 * The rules for one process-harness launch. The filesystem shape is the same for every contract (D4: a
 * reviewer's clone is writable too, so its builds and tests run); what a gate or a `commits: false` role
 * may change is enforced after exit (D3.7.4, L4). The role is validated here and named in the label.
 */
export function buildSandboxRules(input: BuildRulesInput): SandboxRules {
  const { role, layout } = input;
  if (role.name === 'coordinator') throw bad('the coordinator never runs under a process harness');
  if (role.harness === 'claude') throw bad('Claude Code workers run in-session, never as a process harness (D11)');
  if (!/^[a-z][a-z0-9-]*$/.test(role.harness)) throw bad(`unknown harness id ${JSON.stringify(role.harness)}`);
  const scratchDir = checkRulePath(layout.scratchDir, 'scratchDir');
  const gitObjectsDir = checkRulePath(layout.gitObjectsDir, 'gitObjectsDir');
  const ports = [...new Set(input.tcpConnectPorts ?? DEFAULT_TCP_CONNECT_PORTS)];
  const fs: FsRule[] = [
    ...SYSTEM_FS_RULES.map((r) => ({ ...r, access: [...r.access] })),
    ...(layout.harnessDir ? [{ path: checkRulePath(layout.harnessDir, 'harnessDir'), access: [...RX] }] : []),
    ...(layout.toolchainDirs ?? []).filter((d) => !within(d, '/usr')).map((d) => ({ path: checkRulePath(d, 'toolchain dir'), access: [...RX] })),
    { path: gitObjectsDir, access: [...R] },
    { path: scratchDir, access: ['read', 'write', 'execute'] },
  ];
  const rules: SandboxRules = {
    version: SANDBOX_RULES_VERSION,
    minAbi: SANDBOX_MIN_ABI,
    label: `${input.leaseId} ${role.name} (${role.contract}, ${role.harness})`,
    fs,
    tcpConnectPorts: ports,
  };
  assertRulesSafe(rules, { scratchDir, gitObjectsDir, protectedPaths: input.protectedPaths });
  return rules;
}

/** The rules file content (validated by the caller through buildSandboxRules / assertRulesSafe). */
export const serializeRules = (rules: SandboxRules): string => JSON.stringify(rules, null, 2) + '\n';

/**
 * The argv that starts `command` under the helper. The argv is visible in `ps` and in /proc to every
 * process of the container, so a secret value in any element is refused (secrets go only into the env
 * entries the adapter plan names). The rules file must live outside the worker-writable scratch dir.
 */
export function sandboxArgv(rulesFile: string, command: readonly string[], opts: { bin?: string; scratchDir: string; secretValues: readonly string[] }): string[] {
  checkRulePath(rulesFile, 'rules file');
  if (within(rulesFile, opts.scratchDir)) throw bad('the rules file must be outside the worker-writable scratch dir');
  if (!command.length || !command[0]) throw bad('no command to run');
  const argv = [opts.bin ?? SANDBOX_BIN, '--rules', rulesFile, '--', ...command];
  for (const secret of opts.secretValues) {
    if (secret.length < 4) continue; // too short to identify; never a real credential
    if (argv.some((a) => a.includes(secret))) {
      throw new MinionsError('INTERNAL', 'refusing to start a process harness with a secret in its argv; pass it through the environment', 'This is a bug in the harness adapter plan.');
    }
  }
  return argv;
}
