// The host publisher's service (docs/design/autonomy.md Decision 17): one user service per machine (per minions home)
// that runs the hidden `minions settings requests serve` for every registered project and starts it again whenever it
// exits. Adapted from the removed host manager's service (docs/design/host-manager.md, task-53.6).
//
// - macOS: a launchd agent, ~/Library/LaunchAgents/<label>.plist, loaded into gui/<uid> (RunAtLoad, KeepAlive,
//   ThrottleInterval 10 s). stdout and stderr go to <MINIONS_HOME>/publisher/publisher.log.
// - Linux: a systemd --user unit, $XDG_CONFIG_HOME/systemd/user/<unit> (default ~/.config), enabled for
//   default.target, Restart=always, RestartSec=10. Output goes to the user journal.
// - Self-upgrade: after a CLI reinstall the publisher exits with PUBLISHER_RESTART_EXIT_CODE between passes
//   (cliChangeWatcher) and the supervisor starts it on the new CLI.
// - Credentials for the push: the owner's own. The unit gets PATH (git, gh, node, docker) and, when the installing shell
//   has one at a stable path, SSH_AUTH_SOCK (a per-boot launchd or /tmp socket is left to the session, which sets its
//   own). The publisher records in its heartbeat whether it has an agent, and `minions doctor` reports it.
// - Every launchctl / systemctl call goes through the injectable runner (tests never call them). The unit file is
//   written atomically and only when its content changed, and recorded in <MINIONS_HOME>/publisher/service.json so
//   status, doctor and uninstall know what is installed without probing the real home directory.
import { closeSync, lstatSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { atomicWrite, ensureDir, readJsonIfExists, sha256, writeJson } from '../core/fsutil.js';
import { hostRoot, publisherPaths } from '../core/paths.js';
import { pidAlive } from '../runtime/db.js';
import { packageRoot, type Runner } from './docker.js';

/** Exit code of the publisher after a CLI reinstall (EX_TEMPFAIL): "start me again on the new CLI". */
export const PUBLISHER_RESTART_EXIT_CODE = 75;

export type ServiceKind = 'launchd' | 'systemd';

/** Everything the service code touches on the host; tests inject all of it. */
export interface ServiceHost {
  platform: NodeJS.Platform;
  home: string;
  /** Environment of the installing shell (PATH, MINIONS_HOME, SSH_AUTH_SOCK, ...). */
  env: NodeJS.ProcessEnv;
  uid: number | null;
  user: string | null;
  /** launchctl / systemctl / loginctl. */
  runner: Runner;
  /** argv the service runs (default: publisherProgram()). */
  program: string[];
  /** Directory of the node binary that installs the service (put on PATH). */
  nodeDir: string;
}

export function serviceHost(o: Partial<ServiceHost> = {}): ServiceHost {
  let user: string | null = null;
  try { user = userInfo().username; } catch { /* unknown */ }
  return {
    platform: o.platform ?? process.platform,
    home: o.home ?? homedir(),
    env: o.env ?? process.env,
    uid: o.uid !== undefined ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : null),
    user: o.user !== undefined ? o.user : user,
    runner: o.runner ?? run,
    program: o.program ?? publisherProgram(),
    nodeDir: o.nodeDir ?? dirname(process.execPath),
  };
}

export const serviceKind = (platform: NodeJS.Platform): ServiceKind | null =>
  (platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : null);

/** The launchd label and systemd unit name; a non-default MINIONS_HOME gets its own suffix (one publisher per home). */
export function serviceNames(env: NodeJS.ProcessEnv = process.env): { label: string; unit: string } {
  const suffix = env.MINIONS_HOME ? `-${sha256(hostRoot(env)).slice(0, 8)}` : '';
  return { label: `dev.minions.publisher${suffix}`, unit: `minions-publisher${suffix}.service` };
}

export function serviceFile(kind: ServiceKind, host: Pick<ServiceHost, 'home' | 'env'>): string {
  const n = serviceNames(host.env);
  if (kind === 'launchd') return join(host.home, 'Library', 'LaunchAgents', `${n.label}.plist`);
  const xdg = host.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(host.home, '.config'), 'systemd', 'user', n.unit);
}

/** `/usr/bin/env node [execArgv] <cli> settings requests serve`: node comes from the unit's PATH. */
export function publisherProgram(o: { script?: string; execArgv?: string[] } = {}): string[] {
  const script = o.script ?? process.argv[1] ?? join(packageRoot(), 'dist', 'cli.js');
  return ['/usr/bin/env', 'node', ...(o.execArgv ?? process.execArgv), script, 'settings', 'requests', 'serve'];
}

/** Variables the publisher needs from the installing shell: where minions keeps its data, Docker, and git's SSH. */
const PASSED_ENV = ['MINIONS_HOME', 'XDG_DATA_HOME', 'MINIONS_CREDENTIAL_STORE', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'GIT_SSH_COMMAND'] as const;

/** An agent socket worth pinning in the unit: absolute, and not a per-boot launchd or /tmp socket (the session sets those). */
export const stableAgentSocket = (sock: string | undefined): string | null =>
  (sock && isAbsolute(sock) && !/^\/(private\/)?tmp\//.test(sock) && !/com\.apple\.launchd\./.test(sock) ? sock : null);

export function serviceEnvironment(host: Pick<ServiceHost, 'env' | 'nodeDir'>): Record<string, string> {
  const path = (host.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(Boolean);
  if (!path.includes(host.nodeDir)) path.unshift(host.nodeDir);
  const out: Record<string, string> = { PATH: path.join(delimiter) };
  for (const k of PASSED_ENV) if (host.env[k]) out[k] = host.env[k]!;
  const sock = stableAgentSocket(host.env.SSH_AUTH_SOCK);
  if (sock) out.SSH_AUTH_SOCK = sock;
  return out;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
function checkValue(what: string, v: string): string {
  if (CONTROL.test(v)) throw new MinionsError('PRECONDITION', `The publisher service cannot be written: ${what} contains a control character or line break.`);
  return v;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchdPlist(o: { label: string; program: string[]; env: Record<string, string>; log: string; home: string }): string {
  const str = (what: string, v: string) => `<string>${xml(checkValue(what, v))}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Generated by `minions setup` (host publisher). `minions auth publisher --remove` removes it. -->',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str('the label', o.label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...o.program.map((a) => `    ${str('the program', a)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(o.env).map(([k, v]) => `    <key>${xml(checkValue('an environment name', k))}</key>${str(`$${k}`, v)}`),
    '  </dict>',
    `  <key>WorkingDirectory</key>${str('the home directory', o.home)}`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key>${str('the log path', o.log)}`,
    `  <key>StandardErrorPath</key>${str('the log path', o.log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** systemd quoting: ExecStart expands `$` and specifiers (`%`); Environment= expands specifiers only. */
const execArg = (v: string) => `"${checkValue('the program', v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
const envAssign = (k: string, v: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new MinionsError('PRECONDITION', `The publisher service cannot be written: "${k}" is not an environment variable name.`);
  return `"${`${k}=${checkValue(`$${k}`, v)}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
};

export function systemdUnit(o: { program: string[]; env: Record<string, string> }): string {
  return [
    '# Generated by `minions setup` (host publisher). `minions auth publisher --remove` removes it.',
    '[Unit]',
    'Description=minions host publisher (pushes agent work after the owner approves it in Telegram)',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${o.program.map(execArg).join(' ')}`,
    'WorkingDirectory=%h',
    ...Object.entries(o.env).map(([k, v]) => `Environment=${envAssign(k, v)}`),
    'Restart=always',
    'RestartSec=10',
    `SuccessExitStatus=${PUBLISHER_RESTART_EXIT_CODE}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderService(kind: ServiceKind, host: ServiceHost): string {
  const env = serviceEnvironment(host);
  return kind === 'launchd'
    ? launchdPlist({ label: serviceNames(host.env).label, program: host.program, env, log: publisherPaths().logFile, home: host.home })
    : systemdUnit({ program: host.program, env });
}

// ---------------------------------------------------------------- the record

const ServiceRecordSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['launchd', 'systemd']),
  name: z.string(),
  path: z.string(),
  sha256: z.string(),
  installedAt: z.string(),
}).refine((r) => recordShapeOk(r), { message: 'service.json does not name a minions publisher unit file' });
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

/** The record is not trusted to name any file: only a minions publisher unit in its usual directory is accepted. */
function recordShapeOk(r: { kind: ServiceKind; name: string; path: string }): boolean {
  if (!isAbsolute(r.path) || r.path.split(/[\\/]/).includes('..')) return false;
  if (r.kind === 'launchd') return /^dev\.minions\.publisher(-[0-9a-f]{8})?$/.test(r.name) && r.path.endsWith(`/Library/LaunchAgents/${r.name}.plist`);
  return /^minions-publisher(-[0-9a-f]{8})?\.service$/.test(r.name) && r.path.endsWith(`/systemd/user/${r.name}`);
}

/** A well-formed record names this home's unit at the path this home would install now, or a file setup wrote. */
function recordBelongsHere(r: ServiceRecord, host: Pick<ServiceHost, 'home' | 'env'>): boolean {
  const names = serviceNames(host.env);
  if (r.name !== (r.kind === 'launchd' ? names.label : names.unit)) return false;
  if (r.path === serviceFile(r.kind, host)) return true;
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(r.path); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT'; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!st.isFile() || uid === null || st.uid !== uid) return false;
  try { return sha256(readFileSync(r.path, 'utf8')) === r.sha256; } catch { return false; }
}

/** The recorded service, or null. Throws when service.json is unreadable or names a unit this home did not install. */
export async function loadServiceRecord(host: Pick<ServiceHost, 'home' | 'env'> = { home: homedir(), env: process.env }): Promise<ServiceRecord | null> {
  const rec = (await readJsonIfExists(publisherPaths().serviceJson, ServiceRecordSchema)) ?? null;
  if (rec && !recordBelongsHere(rec, host)) {
    throw new MinionsError('PRECONDITION', `${publisherPaths().serviceJson} does not name a minions publisher unit of this minions home (${rec.name} at ${rec.path}).`,
      'Rerun `minions setup` or `minions auth publisher`: they replace the record.');
  }
  return rec;
}

// ---------------------------------------------------------------- install / remove

export interface ServiceResult {
  action: 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent';
  kind: ServiceKind | null;
  path: string | null;
  started: boolean;
  warnings: string[];
}

const short = (s: string) => s.trim().split('\n').slice(-3).join(' ').slice(0, 300);
const call = (host: ServiceHost, cmd: string, args: string[]) => host.runner(cmd, args, { allowFailure: true, timeoutMs: 30_000 });

async function must(host: ServiceHost, cmd: string, args: string[], hint: string): Promise<void> {
  const r = await call(host, cmd, args);
  if (r.code !== 0) throw new MinionsError('PRECONDITION', `\`${cmd} ${args.join(' ')}\` failed (exit ${r.code})${short(r.stderr || r.stdout) ? `: ${short(r.stderr || r.stdout)}` : ''}.`, hint);
}

const launchdTarget = (host: ServiceHost, label: string) => `gui/${host.uid ?? 0}/${label}`;
const SYSTEMD_HINT = '`systemctl --user` needs your user session (a login, or `sudo loginctl enable-linger "$USER"`). Fix that and rerun `minions auth publisher`.';
const LAUNCHD_HINT = 'Run it from a terminal of your logged-in macOS user (launchd agents live in the gui/<uid> domain).';

/**
 * Installs the publisher service, or brings it up to date (rerunnable): writes the unit file only when its content
 * changed, records it, then loads and (re)starts it. `restart`: restart a running publisher even when the file is
 * unchanged (a new token).
 */
export async function installPublisherService(host: ServiceHost, o: { restart?: boolean; now?: Date } = {}): Promise<ServiceResult> {
  const kind = serviceKind(host.platform);
  if (!kind) {
    throw new MinionsError('PRECONDITION', `No supported user service manager on ${host.platform} (launchd on macOS, systemd --user on Linux).`,
      'Run `minions settings requests serve` under a supervisor of your own.');
  }
  if (kind === 'launchd' && host.uid === null) throw new MinionsError('PRECONDITION', 'Cannot tell the user id for the launchd gui domain.', LAUNCHD_HINT);
  const path = serviceFile(kind, host);
  const names = serviceNames(host.env);
  const name = kind === 'launchd' ? names.label : names.unit;
  const content = renderService(kind, host);
  const warnings: string[] = [];
  const before = await loadServiceRecord(host).catch(() => null);
  if (before && (before.path !== path || before.name !== name || before.kind !== kind)) {
    await unload(host, before.kind, before.name);
    await rm(before.path, { force: true });
    warnings.push(`removed the previous service file ${before.path}`);
  }
  const prev = await readFile(path, 'utf8').catch(() => null);
  const changed = prev !== content;
  await ensureDir(publisherPaths().dir, 0o700);
  if (changed) await atomicWrite(path, content, { mode: 0o644 });
  await writeJson(publisherPaths().serviceJson, { version: 1, kind, name, path, sha256: sha256(content), installedAt: (o.now ?? new Date()).toISOString() } satisfies ServiceRecord, { mode: 0o600 });
  if (kind === 'launchd') {
    const target = launchdTarget(host, name);
    let loaded = (await call(host, 'launchctl', ['print', target])).code === 0;
    if (loaded && (changed || o.restart)) { await call(host, 'launchctl', ['bootout', target]); loaded = false; }
    if (!loaded) {
      await call(host, 'launchctl', ['enable', target]);
      await must(host, 'launchctl', ['bootstrap', `gui/${host.uid}`, path], LAUNCHD_HINT);
    }
  } else {
    if (changed) await must(host, 'systemctl', ['--user', 'daemon-reload'], SYSTEMD_HINT);
    await must(host, 'systemctl', ['--user', 'enable', name], SYSTEMD_HINT);
    await must(host, 'systemctl', ['--user', changed || o.restart ? 'restart' : 'start', name], SYSTEMD_HINT);
    if (host.user) {
      const l = await call(host, 'loginctl', ['show-user', host.user, '--property=Linger', '--value']).catch(() => null);
      if (l?.code === 0 && l.stdout.trim() === 'no') warnings.push('the publisher runs only while you are logged in; to keep it running after logout: `sudo loginctl enable-linger "$USER"`');
    }
  }
  if (isSshAgentMissing(serviceEnvironment(host), kind)) {
    warnings.push('no SSH agent socket was passed to the service: pushes to an SSH remote need the session\'s agent (launchd sets one on macOS) or a deploy key (`minions settings set publish.deployKey <path>`); `minions doctor` reports what the running publisher sees');
  }
  return { action: prev === null ? 'installed' : changed ? 'updated' : 'unchanged', kind, path, started: true, warnings };
}

/** systemd user units get no SSH_AUTH_SOCK of their own; launchd agents get the system ssh-agent's. */
const isSshAgentMissing = (env: Record<string, string>, kind: ServiceKind) => kind === 'systemd' && !env.SSH_AUTH_SOCK;

async function unload(host: ServiceHost, kind: ServiceKind, name: string): Promise<void> {
  if (kind === 'launchd') await call(host, 'launchctl', ['bootout', launchdTarget(host, name)]).catch(() => null);
  else await call(host, 'systemctl', ['--user', 'disable', '--now', name]).catch(() => null);
}

/** Stops and removes the service and its files (unit file, record, heartbeat, log). The token stays. Idempotent. */
export async function removePublisherService(host: ServiceHost): Promise<ServiceResult> {
  let rec: ServiceRecord | null;
  let corrupt = false;
  try { rec = await loadServiceRecord(host); } catch { rec = null; corrupt = true; }
  const kind = rec?.kind ?? (corrupt ? serviceKind(host.platform) : null);
  if (!kind) {
    if (corrupt) await rm(publisherPaths().serviceJson, { force: true });
    return { action: 'absent', kind: null, path: null, started: false, warnings: [] };
  }
  const names = serviceNames(host.env);
  const name = rec?.name ?? (kind === 'launchd' ? names.label : names.unit);
  const path = rec?.path ?? serviceFile(kind, host);
  await unload(host, kind, name);
  await rm(path, { force: true });
  if (kind === 'systemd') await call(host, 'systemctl', ['--user', 'daemon-reload']).catch(() => null);
  const p = publisherPaths();
  for (const f of [p.serviceJson, p.heartbeatJson, p.logFile]) await rm(f, { force: true });
  return { action: 'removed', kind, path, started: false, warnings: corrupt ? ['service.json was unreadable: removed the default unit of this minions home'] : [] };
}

export interface ServiceState {
  kind: ServiceKind | null;
  installed: boolean;
  path: string | null;
  active: 'running' | 'stopped' | 'unknown' | null;
  detail: string;
}

/** The recorded service and what launchctl / systemctl say about it. No probe when nothing is recorded. */
export async function serviceState(host: ServiceHost): Promise<ServiceState> {
  const kind = serviceKind(host.platform);
  let rec: ServiceRecord | null;
  try { rec = await loadServiceRecord(host); } catch (e) {
    return { kind, installed: false, path: null, active: 'unknown', detail: `service.json is unreadable: ${(e as Error).message.split('\n')[0]}` };
  }
  if (!rec) return { kind, installed: false, path: null, active: null, detail: 'not installed' };
  if ((await readFile(rec.path, 'utf8').catch(() => null)) === null) return { kind: rec.kind, installed: false, path: rec.path, active: 'unknown', detail: `the recorded unit file ${rec.path} is missing` };
  try {
    if (rec.kind === 'launchd') {
      const r = await call(host, 'launchctl', ['print', launchdTarget(host, rec.name)]);
      if (r.code !== 0) return { kind: rec.kind, installed: true, path: rec.path, active: 'stopped', detail: `launchd agent ${rec.name} is not loaded` };
      const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1] ?? 'unknown';
      const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
      return { kind: rec.kind, installed: true, path: rec.path, active: state === 'running' ? 'running' : 'stopped', detail: `launchd agent ${rec.name}: ${state}${pid ? ` (pid ${pid})` : ''}` };
    }
    const r = await call(host, 'systemctl', ['--user', 'show', rec.name, '--property=ActiveState,SubState,MainPID']);
    if (r.code !== 0) return { kind: rec.kind, installed: true, path: rec.path, active: 'unknown', detail: `systemctl --user show failed: ${short(r.stderr || r.stdout) || `exit ${r.code}`}` };
    const v = Object.fromEntries(r.stdout.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...rest]) => [k!.trim(), rest.join('=').trim()]));
    const running = v.ActiveState === 'active';
    return { kind: rec.kind, installed: true, path: rec.path, active: running ? 'running' : v.ActiveState ? 'stopped' : 'unknown', detail: `systemd --user unit ${rec.name}: ${v.ActiveState ?? 'unknown'}${v.SubState ? ` (${v.SubState})` : ''}` };
  } catch (e) {
    return { kind: rec.kind, installed: true, path: rec.path, active: 'unknown', detail: `could not ask the service manager: ${(e as Error).message.split('\n')[0]}` };
  }
}

// ---------------------------------------------------------------- heartbeat, lock, self-upgrade

export const HeartbeatSchema = z.object({
  version: z.literal(1),
  pid: z.number(),
  startedAt: z.string(),
  at: z.string(),
  /** running | waiting (no token or no owner id) | conflict (another poller) | error. */
  state: z.enum(['running', 'waiting', 'conflict', 'error']),
  detail: z.string(),
  botId: z.string().nullable(),
  /** Whether the service process has an SSH agent socket (SSH remotes without a deploy key need one). */
  sshAuthSock: z.boolean(),
  /** Per project: how pushes would authenticate, and the last problem. */
  projects: z.record(z.string(), z.object({ auth: z.object({ ok: z.boolean(), detail: z.string() }), lastError: z.string().nullable() }).strict()),
}).strict();
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/** Writes the heartbeat (0600). Never the token. Best effort. */
export async function writeHeartbeat(h: Heartbeat): Promise<void> {
  await ensureDir(publisherPaths().dir, 0o700);
  await atomicWrite(publisherPaths().heartbeatJson, JSON.stringify(h) + '\n', { mode: 0o600 });
}

/** The last heartbeat, or null (none, unreadable). */
export const readHeartbeat = async (): Promise<Heartbeat | null> => (await readJsonIfExists(publisherPaths().heartbeatJson, HeartbeatSchema).catch(() => undefined)) ?? null;

/**
 * Takes the per-home publisher lock (`<publisher>/lock`, O_EXCL, holding the pid). A lock of a dead process is taken
 * over. Returns a release function, or null when another live publisher holds it.
 */
export function takePublisherLock(o: { alive?: (pid: number) => boolean } = {}): (() => void) | null {
  const file = publisherPaths().lock;
  const alive = o.alive ?? pidAlive;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { const v = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }; if (v.pid === process.pid) rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid: number | undefined;
      try { pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid; } catch { pid = undefined; }
      if (typeof pid === 'number' && pid !== process.pid && alive(pid)) return null;
      // Stale (a dead publisher, or an unreadable file): remove it and try once more.
      rmSync(file, { force: true });
    }
  }
  return null;
}

/** Identity of the installed CLI files (size, mtime, inode of dist/cli.js and package.json); null when missing. */
export function cliStamp(root: string = packageRoot()): string | null {
  const parts: string[] = [];
  for (const f of [join('dist', 'cli.js'), 'package.json']) {
    try { const s = statSync(join(root, f)); parts.push(`${f}:${s.size}:${s.mtimeMs}:${s.ino}`); } catch { return null; }
  }
  return parts.join('|');
}

/** Whether the installed CLI changed since this process started (a missing file mid-install is not a change yet). */
export function cliChangeWatcher(stamp: () => string | null = () => cliStamp()): () => boolean {
  const first = stamp();
  return () => {
    if (first === null) return false;
    const now = stamp();
    return now !== null && now !== first;
  };
}
