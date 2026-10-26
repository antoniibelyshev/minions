// The host manager's supervisor (docs/design/host-manager.md, phase 5, task-53.6; owner decision Q4): a user service
// that runs the hidden `minions manager run` in the background and starts it again whenever it exits.
//
// - macOS: a launchd agent, ~/Library/LaunchAgents/<label>.plist, loaded into gui/<uid> (RunAtLoad, KeepAlive,
//   ThrottleInterval 10 s). stdout and stderr go to <MINIONS_HOME>/manager/manager.log.
// - Linux: a systemd --user unit, $XDG_CONFIG_HOME/systemd/user/<unit> (default ~/.config), enabled for
//   default.target, Restart=always, RestartSec=10. Output goes to the user journal.
// - Self-upgrade: after a CLI reinstall the manager finishes the current child, reports, and exits with
//   MANAGER_RESTART_EXIT_CODE (cliChangeWatcher notices that the installed CLI changed under the running process). The
//   supervisor restarts it on any exit, so the next process runs the new CLI.
// - Every launchctl / systemctl call goes through the injectable runner (tests never call them). The unit file is
//   written atomically and only when its content changed; setup records it in <MINIONS_HOME>/manager/service.json so
//   status, doctor and uninstall know what is installed without probing the real home directory.
// - The program is `/usr/bin/env node <cli> manager run` with PATH set from the installing shell, so a node upgrade
//   that moves the binary does not break the unit, and a CLI reinstall at the same path is picked up on restart.
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { MinionsError } from '../core/errors.js';
import { run } from '../core/exec.js';
import { atomicWrite, readJsonIfExists, sha256, writeJson } from '../core/fsutil.js';
import { hostRoot, managerDir, managerPaths } from '../core/paths.js';
import { procStartTime } from '../runtime/coordinator.js';
import { pidAlive } from '../runtime/db.js';
import { packageRoot, type Runner } from './docker.js';

/** Exit code of `minions manager run` after a CLI reinstall (EX_TEMPFAIL): "start me again on the new CLI". */
export const MANAGER_RESTART_EXIT_CODE = 75;

export type ServiceKind = 'launchd' | 'systemd';

/** Everything the service code touches on the host; tests inject all of it. */
export interface ServiceHost {
  platform: NodeJS.Platform;
  /** The user's home (unit file location). */
  home: string;
  /** Environment of the installing shell (PATH, MINIONS_HOME, XDG_CONFIG_HOME, ...). */
  env: NodeJS.ProcessEnv;
  uid: number | null;
  /** User name (loginctl linger check), null when unknown. */
  user: string | null;
  /** launchctl / systemctl / loginctl. */
  runner: Runner;
  /** argv the service runs (default: managerProgram()). */
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
    program: o.program ?? managerProgram(),
    nodeDir: o.nodeDir ?? dirname(process.execPath),
  };
}

export const serviceKind = (platform: NodeJS.Platform): ServiceKind | null =>
  (platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : null);

/**
 * The launchd label and systemd unit name. A non-default MINIONS_HOME gets its own suffix, so two minions homes on one
 * host (each with its own manager lock) never share a unit.
 */
export function serviceNames(env: NodeJS.ProcessEnv = process.env): { label: string; unit: string } {
  const suffix = env.MINIONS_HOME ? `-${sha256(hostRoot(env)).slice(0, 8)}` : '';
  return { label: `dev.minions.manager${suffix}`, unit: `minions-manager${suffix}.service` };
}

export function serviceFile(kind: ServiceKind, host: Pick<ServiceHost, 'home' | 'env'>): string {
  const n = serviceNames(host.env);
  if (kind === 'launchd') return join(host.home, 'Library', 'LaunchAgents', `${n.label}.plist`);
  const xdg = host.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(host.home, '.config'), 'systemd', 'user', n.unit);
}

/** `/usr/bin/env node [execArgv] <cli> manager run`: node comes from the unit's PATH. */
export function managerProgram(o: { script?: string; execArgv?: string[] } = {}): string[] {
  const script = o.script ?? process.argv[1] ?? join(packageRoot(), 'dist', 'cli.js');
  return ['/usr/bin/env', 'node', ...(o.execArgv ?? process.execArgv), script, 'manager', 'run'];
}

/** Variables the manager needs from the installing shell: PATH (node, docker, git) and where minions keeps its data. */
const PASSED_ENV = ['MINIONS_HOME', 'XDG_DATA_HOME', 'MINIONS_CREDENTIAL_STORE', 'DOCKER_HOST', 'DOCKER_CONTEXT'] as const;

export function serviceEnvironment(host: Pick<ServiceHost, 'env' | 'nodeDir'>): Record<string, string> {
  const path = (host.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(delimiter).filter(Boolean);
  if (!path.includes(host.nodeDir)) path.unshift(host.nodeDir);
  const out: Record<string, string> = { PATH: path.join(delimiter) };
  for (const k of PASSED_ENV) if (host.env[k]) out[k] = host.env[k]!;
  return out;
}

const CONTROL = /[\u0000-\u001f\u007f]/;
function checkValue(what: string, v: string): string {
  if (CONTROL.test(v)) throw new MinionsError('PRECONDITION', `The host manager service cannot be written: ${what} contains a control character or line break.`);
  return v;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchdPlist(o: { label: string; program: string[]; env: Record<string, string>; log: string; home: string }): string {
  const str = (what: string, v: string) => `<string>${xml(checkValue(what, v))}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Generated by `minions setup` (host manager). Rerun `minions setup` to change or remove it. -->',
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new MinionsError('PRECONDITION', `The host manager service cannot be written: "${k}" is not an environment variable name.`);
  return `"${`${k}=${checkValue(`$${k}`, v)}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
};

export function systemdUnit(o: { program: string[]; env: Record<string, string> }): string {
  return [
    '# Generated by `minions setup` (host manager). Rerun `minions setup` to change or remove it.',
    '[Unit]',
    'Description=minions host manager (confirms setup changes from its Telegram bot)',
    'StartLimitIntervalSec=0',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${o.program.map(execArg).join(' ')}`,
    'WorkingDirectory=%h',
    ...Object.entries(o.env).map(([k, v]) => `Environment=${envAssign(k, v)}`),
    'Restart=always',
    'RestartSec=10',
    `SuccessExitStatus=${MANAGER_RESTART_EXIT_CODE}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderService(kind: ServiceKind, host: ServiceHost): string {
  const env = serviceEnvironment(host);
  return kind === 'launchd'
    ? launchdPlist({ label: serviceNames(host.env).label, program: host.program, env, log: managerPaths().logFile, home: host.home })
    : systemdUnit({ program: host.program, env });
}

// ---------------------------------------------------------------- the record

const ServiceRecordSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['launchd', 'systemd']),
  /** launchd label or systemd unit name. */
  name: z.string(),
  path: z.string(),
  sha256: z.string(),
  installedAt: z.string(),
}).refine((r) => recordShapeOk(r), { message: 'service.json does not name a minions manager unit file' });

/** The record is not trusted to name any file: only a minions manager unit in its usual directory is accepted. */
function recordShapeOk(r: { kind: ServiceKind; name: string; path: string }): boolean {
  if (!isAbsolute(r.path) || r.path.split(/[\\/]/).includes('..')) return false;
  if (r.kind === 'launchd') return /^dev\.minions\.manager(-[0-9a-f]{8})?$/.test(r.name) && r.path.endsWith(`/Library/LaunchAgents/${r.name}.plist`);
  return /^minions-manager(-[0-9a-f]{8})?\.service$/.test(r.name) && r.path.endsWith(`/systemd/user/${r.name}`);
}
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

/**
 * Whether a well-formed record names a unit that this minions home's install produced. The name must be exactly this
 * home's label / unit (so neither the default home's unit nor another home's is ever accepted under a custom
 * MINIONS_HOME). The path must be the one this home and this user would install now, or (an install under another
 * home directory or XDG_CONFIG_HOME, still to be cleaned up) a path where either nothing exists or the very file setup
 * wrote exists: a regular file (no symlink) owned by this process's user with the recorded sha256. Another user's unit
 * or any other file is never accepted.
 */
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

/**
 * The recorded service, or null when none is recorded. Throws when service.json is unreadable, malformed, or names a
 * unit this minions home did not install (see recordBelongsHere); callers then never touch the unit it names.
 */
export async function loadServiceRecord(host: Pick<ServiceHost, 'home' | 'env'> = { home: homedir(), env: process.env }): Promise<ServiceRecord | null> {
  const rec = (await readJsonIfExists(managerPaths().serviceJson, ServiceRecordSchema)) ?? null;
  if (rec && !recordBelongsHere(rec, host)) {
    throw new MinionsError('PRECONDITION', `${managerPaths().serviceJson} does not name a minions manager unit file of this minions home (${rec.name} at ${rec.path}).`,
      'Rerun `minions setup`: it replaces the record.');
  }
  return rec;
}

// ---------------------------------------------------------------- install / remove

export interface ServiceResult {
  action: 'installed' | 'updated' | 'unchanged' | 'removed' | 'absent';
  kind: ServiceKind | null;
  path: string | null;
  /** The service manager was told to (re)start it. */
  started: boolean;
  warnings: string[];
}

const short = (s: string) => s.trim().split('\n').slice(-3).join(' ').slice(0, 300);

async function call(host: ServiceHost, cmd: string, args: string[]) {
  return host.runner(cmd, args, { allowFailure: true, timeoutMs: 30_000 });
}

async function must(host: ServiceHost, cmd: string, args: string[], hint: string): Promise<void> {
  const r = await call(host, cmd, args);
  if (r.code !== 0) throw new MinionsError('PRECONDITION', `\`${cmd} ${args.join(' ')}\` failed (exit ${r.code})${short(r.stderr || r.stdout) ? `: ${short(r.stderr || r.stdout)}` : ''}.`, hint);
}

const launchdTarget = (host: ServiceHost, label: string) => `gui/${host.uid ?? 0}/${label}`;
const SYSTEMD_HINT = '`systemctl --user` needs your user session (a login, or `sudo loginctl enable-linger "$USER"`). Fix that and rerun `minions setup`.';
const LAUNCHD_HINT = 'Run `minions setup` from a terminal of your logged-in macOS user (launchd agents live in the gui/<uid> domain).';

/**
 * Installs the manager service, or brings it up to date (rerunnable): writes the unit file only when its content
 * changed, records it, then loads and (re)starts it. `restart`: restart a running manager even when the file is
 * unchanged (a new token or pairing). Throws when the service manager refuses; the file and record stay, so a rerun
 * or `removeManagerService` can still clean up.
 */
export async function installManagerService(host: ServiceHost, o: { restart?: boolean; now?: Date } = {}): Promise<ServiceResult> {
  const kind = serviceKind(host.platform);
  if (!kind) {
    throw new MinionsError('PRECONDITION', `No supported user service manager on ${host.platform} (launchd on macOS, systemd --user on Linux).`,
      'Run `minions manager run` under a supervisor of your own.');
  }
  if (kind === 'launchd' && host.uid === null) throw new MinionsError('PRECONDITION', 'Cannot tell the user id for the launchd gui domain.', LAUNCHD_HINT);
  const path = serviceFile(kind, host);
  const names = serviceNames(host.env);
  const name = kind === 'launchd' ? names.label : names.unit;
  const content = renderService(kind, host);
  const warnings: string[] = [];

  // A unit recorded elsewhere (another XDG_CONFIG_HOME, another name) is removed first: one service per minions home.
  const before = await loadServiceRecord(host).catch(() => null);
  if (before && (before.path !== path || before.name !== name || before.kind !== kind)) {
    await unload(host, before.kind, before.name);
    await rm(before.path, { force: true });
    warnings.push(`removed the previous service file ${before.path}`);
  }

  const prev = await readFile(path, 'utf8').catch(() => null);
  const changed = prev !== content;
  if (changed) await atomicWrite(path, content, { mode: 0o644 });
  await writeJson(managerPaths().serviceJson, { version: 1, kind, name, path, sha256: sha256(content), installedAt: (o.now ?? new Date()).toISOString() } satisfies ServiceRecord, { mode: 0o600 });

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
      if (l?.code === 0 && l.stdout.trim() === 'no') {
        warnings.push('the manager runs only while you are logged in; to keep it running after logout: `sudo loginctl enable-linger "$USER"`');
      }
    }
  }
  return { action: prev === null ? 'installed' : changed ? 'updated' : 'unchanged', kind, path, started: true, warnings };
}

async function unload(host: ServiceHost, kind: ServiceKind, name: string): Promise<void> {
  if (kind === 'launchd') await call(host, 'launchctl', ['bootout', launchdTarget(host, name)]).catch(() => null);
  else await call(host, 'systemctl', ['--user', 'disable', '--now', name]).catch(() => null);
}

/**
 * Stops and removes the service and its files (unit file, record, heartbeat, launchd log). The token, pairing and
 * journal stay (they are credentials and history; `minions setup` removes the token). Idempotent.
 */
export async function removeManagerService(host: ServiceHost): Promise<ServiceResult> {
  // Only what setup recorded is removed (never a guess in the home directory). An unreadable record still means
  // setup installed one: then the default location of this minions home is used.
  let rec: ServiceRecord | null;
  let corrupt = false;
  try { rec = await loadServiceRecord(host); } catch { rec = null; corrupt = true; }
  const kind = rec?.kind ?? (corrupt ? serviceKind(host.platform) : null);
  if (!kind) {
    if (corrupt) await rm(managerPaths().serviceJson, { force: true });
    return { action: 'absent', kind: null, path: null, started: false, warnings: [] };
  }
  const names = serviceNames(host.env);
  const name = rec?.name ?? (kind === 'launchd' ? names.label : names.unit);
  const path = rec?.path ?? serviceFile(kind, host);
  await unload(host, kind, name);
  await rm(path, { force: true });
  if (kind === 'systemd') await call(host, 'systemctl', ['--user', 'daemon-reload']).catch(() => null);
  const p = managerPaths();
  for (const f of [p.serviceJson, p.stateJson, p.logFile]) await rm(f, { force: true });
  return { action: 'removed', kind, path, started: false, warnings: corrupt ? ['service.json was unreadable: removed the default unit of this minions home'] : [] };
}

// ---------------------------------------------------------------- state

export interface ServiceState {
  kind: ServiceKind | null;
  installed: boolean;
  path: string | null;
  /** What the service manager reports; null when nothing is installed. */
  active: 'running' | 'stopped' | 'unknown' | null;
  detail: string;
  /** The unit file still has the content setup wrote (null: not installed). */
  fileMatches: boolean | null;
}

/** The recorded service and what launchctl / systemctl say about it. No probe when nothing is recorded. */
export async function serviceState(host: ServiceHost): Promise<ServiceState> {
  const kind = serviceKind(host.platform);
  let rec: ServiceRecord | null;
  try { rec = await loadServiceRecord(host); } catch (e) {
    return { kind, installed: false, path: null, active: 'unknown', detail: `service.json is unreadable: ${(e as Error).message.split('\n')[0]}`, fileMatches: null };
  }
  if (!rec) return { kind, installed: false, path: null, active: null, detail: 'not installed', fileMatches: null };
  const text = await readFile(rec.path, 'utf8').catch(() => null);
  const fileMatches = text !== null && sha256(text) === rec.sha256;
  if (text === null) return { kind: rec.kind, installed: false, path: rec.path, active: 'unknown', detail: `the recorded unit file ${rec.path} is missing`, fileMatches: false };
  try {
    if (rec.kind === 'launchd') {
      const r = await call(host, 'launchctl', ['print', launchdTarget(host, rec.name)]);
      if (r.code !== 0) return { kind: rec.kind, installed: true, path: rec.path, active: 'stopped', detail: `launchd agent ${rec.name} is not loaded`, fileMatches };
      const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1] ?? 'unknown';
      const pid = /^\s*pid = (\d+)/m.exec(r.stdout)?.[1];
      const exit = /last exit code = (.+)$/m.exec(r.stdout)?.[1]?.trim();
      return { kind: rec.kind, installed: true, path: rec.path, active: state === 'running' ? 'running' : 'stopped',
        detail: `launchd agent ${rec.name}: ${state}${pid ? ` (pid ${pid})` : ''}${exit && state !== 'running' ? `, last exit ${exit}` : ''}`, fileMatches };
    }
    const r = await call(host, 'systemctl', ['--user', 'show', rec.name, '--property=ActiveState,SubState,MainPID,LoadState']);
    if (r.code !== 0) return { kind: rec.kind, installed: true, path: rec.path, active: 'unknown', detail: `systemctl --user show failed: ${short(r.stderr || r.stdout) || `exit ${r.code}`}`, fileMatches };
    const v = Object.fromEntries(r.stdout.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...rest]) => [k!.trim(), rest.join('=').trim()]));
    const running = v.ActiveState === 'active';
    return { kind: rec.kind, installed: true, path: rec.path, active: running ? 'running' : v.ActiveState ? 'stopped' : 'unknown',
      detail: `systemd --user unit ${rec.name}: ${v.ActiveState ?? 'unknown'}${v.SubState ? ` (${v.SubState})` : ''}${running && v.MainPID && v.MainPID !== '0' ? `, pid ${v.MainPID}` : ''}`, fileMatches };
  } catch (e) {
    return { kind: rec.kind, installed: true, path: rec.path, active: 'unknown', detail: `could not ask the service manager: ${(e as Error).message.split('\n')[0]}`, fileMatches };
  }
}

// ---------------------------------------------------------------- heartbeat and the running process

const StateSchema = z.object({
  version: z.literal(1),
  pid: z.number(),
  start: z.string().nullable(),
  startedAt: z.string(),
  transport: z.enum(['telegram', 'log']),
  botId: z.string().nullable(),
  lastPollAt: z.string().nullable(),
});
export type ManagerState = z.infer<typeof StateSchema>;

/** Writes <MINIONS_HOME>/manager/state.json (0600): who runs and when it last polled. Never the token. */
export async function writeManagerState(s: ManagerState): Promise<void> {
  await atomicWrite(managerPaths().stateJson, JSON.stringify(s) + '\n', { mode: 0o600 });
}

/** The heartbeat of this process: start() once, poll(at) after every poll of the projects. Best effort. */
export function managerHeartbeat(o: { transport: 'telegram' | 'log'; botId: string | null; now: () => Date; log?: (l: string) => void }) {
  const base: ManagerState = { version: 1, pid: process.pid, start: procStartTime(process.pid), startedAt: o.now().toISOString(), transport: o.transport, botId: o.botId, lastPollAt: null };
  let warned = false;
  const write = async (s: ManagerState) => {
    try { await writeManagerState(s); } catch (e) { if (!warned) { warned = true; o.log?.(`cannot write ${managerPaths().stateJson}: ${(e as Error).message}`); } }
  };
  return {
    start: () => write(base),
    poll: (at: Date) => write({ ...base, lastPollAt: at.toISOString() }),
  };
}

export interface ProcessState {
  running: boolean;
  pid: number | null;
  /** When the running manager took the lock. */
  since: string | null;
  transport: 'telegram' | 'log' | null;
  botId: string | null;
  lastPollAt: string | null;
}

/** The manager lock (who runs) and the heartbeat of that same process (transport, bot, last poll). */
export async function managerProcessState(o: { alive?: (pid: number) => boolean; startOf?: (pid: number) => string | null } = {}): Promise<ProcessState> {
  const alive = o.alive ?? pidAlive;
  const startOf = o.startOf ?? procStartTime;
  const none: ProcessState = { running: false, pid: null, since: null, transport: null, botId: null, lastPollAt: null };
  let lock: { pid?: unknown; start?: unknown; at?: unknown };
  try { lock = JSON.parse(await readFile(join(managerDir(), 'lock'), 'utf8')) as typeof lock; } catch { return none; }
  if (typeof lock.pid !== 'number' || !alive(lock.pid)) return none;
  const start = typeof lock.start === 'string' ? lock.start : null;
  if (start) { const now = startOf(lock.pid); if (now !== null && now !== start) return none; }
  const out: ProcessState = { ...none, running: true, pid: lock.pid, since: typeof lock.at === 'string' ? lock.at : null };
  const st = await readJsonIfExists(managerPaths().stateJson, StateSchema).catch(() => undefined);
  if (st && st.pid === lock.pid && (st.start ?? null) === start) {
    out.transport = st.transport; out.botId = st.botId; out.lastPollAt = st.lastPollAt;
  }
  return out;
}

// ---------------------------------------------------------------- self-upgrade

/** Identity of the installed CLI files (size, mtime, inode of dist/cli.js and package.json); null when missing. */
export function cliStamp(root: string = packageRoot()): string | null {
  const parts: string[] = [];
  for (const f of [join('dist', 'cli.js'), 'package.json']) {
    try {
      const s = statSync(join(root, f));
      parts.push(`${f}:${s.size}:${s.mtimeMs}:${s.ino}`);
    } catch { return null; }
  }
  try { parts.push(String((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version)); } catch { /* the stat parts suffice */ }
  return parts.join('|');
}

/**
 * Whether the installed CLI changed since this process started (a reinstall or rebuild at the same path). A
 * missing file (mid-install) is not a change yet: the next check decides.
 */
export function cliChangeWatcher(stamp: () => string | null = () => cliStamp()): () => boolean {
  const first = stamp();
  return () => {
    if (first === null) return false;
    const now = stamp();
    return now !== null && now !== first;
  };
}
