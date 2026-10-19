// `minions channel show|set terminal|telegram|auto` (host CLI only). Edits communication.channel in
// the project configuration file the install uses (shared .minions/config.json or the private
// config), with a configRevision bump and validation (src/host/config-write.ts). Never commits, never
// restarts the runtime; it prints the next steps instead (token, commit, restart).
import { Argument, type Command } from 'commander';
import { CHANNELS, type ChannelSetting, type MinionsConfig } from '../config/schema.js';
import { action, globalOpts, requireMode } from '../core/cli-helpers.js';
import { MinionsError } from '../core/errors.js';
import { emit } from '../core/output.js';
import { projectPaths } from '../core/paths.js';
import { BOTFATHER_URL } from '../telegram/token.js';
import { formatChannel, resolveChannel, type ChannelResolution, type ChannelFacts } from '../telegram/channel.js';
import { editProjectConfig } from './config-write.js';
import { loadCredentialRefs, type CredentialsJson } from './credentials.js';
import { Compose, type Runner } from './docker.js';
import { loadEffectiveConfig, loadProjectJson, type ProjectJson } from './project.js';
import { projectForPath } from './registry.js';
import { HostRuntime, runtimeOf } from './runtime.js';

export const RESTART_HINT = 'communication.channel is restart-required: run `minions down && minions start` to apply it.';
export const HOST_CHANNEL_WARNING = 'Telegram is unavailable in the host runtime (the coordinator starts without user plugins or MCP servers), so it stays terminal-only. Use the Docker runtime for Telegram (`minions runtime set docker`).';
const TOKEN_HINT = `No Telegram bot token is stored for this project: create a bot with BotFather (${BOTFATHER_URL}, /newbot), then run \`minions auth telegram\`.`;

/** Whether a Telegram bot token reference is stored for the project (no secret store access, no network). */
export async function telegramTokenStored(projectId: string): Promise<boolean> {
  return !!(await loadCredentialRefs(projectId).catch((): CredentialsJson => ({ version: 1 }))).telegram;
}

/** Host-side channel facts: stored token reference, runtime, network. The plugin probe is left to the launch. */
export async function hostChannelFacts(project: ProjectJson, config: Pick<MinionsConfig, 'container'>, opts: { token?: ChannelFacts['token']; probe?: ChannelFacts['probe'] } = {}): Promise<ChannelFacts> {
  const token = opts.token ?? ((await telegramTokenStored(project.projectId)) ? 'ok' : 'missing');
  return { token, runtime: runtimeOf(project), network: config.container.network, ...(opts.probe !== undefined ? { probe: opts.probe } : {}) };
}

/** communication.channel of a registered project, resolved on the host (prediction: the launch runs the plugin probe). */
export async function hostChannel(project: ProjectJson, config: Pick<MinionsConfig, 'communication' | 'container'>, opts: Parameters<typeof hostChannelFacts>[2] = {}): Promise<ChannelResolution> {
  return resolveChannel(config.communication.channel, await hostChannelFacts(project, config, opts));
}

async function runtimeRunning(project: ProjectJson, runner?: Runner): Promise<boolean> {
  return runtimeOf(project) === 'host'
    ? new HostRuntime(project, runner).isRunning().catch(() => false)
    : new Compose(project.projectId, runner).isRunning().catch(() => false);
}

// ---------------------------------------------------------------- show

export interface ChannelShowResult extends ChannelResolution {
  projectId: string;
  /** File holding the setting and the layer it comes from (project file, config.local.json, or the profile default). */
  file: string;
  source: string;
  runtime: 'docker' | 'host';
  tokenStored: boolean;
  running: boolean;
}

export interface ChannelDeps {
  cwd: string;
  runner?: Runner;
  isRunning?: (project: ProjectJson) => Promise<boolean>;
}

export async function runChannelShow(deps: ChannelDeps): Promise<ChannelShowResult> {
  const { projectId } = await projectForPath(deps.cwd);
  const project = await loadProjectJson(projectId);
  const eff = await loadEffectiveConfig(project);
  const source = eff.provenance['communication.channel'] ?? 'default';
  const r = await hostChannel(project, eff.config);
  return {
    projectId, ...r, file: source === 'local' ? eff.sources.local! : eff.sources.project!, source,
    runtime: runtimeOf(project), tokenStored: await telegramTokenStored(projectId),
    running: await (deps.isRunning ?? ((p) => runtimeRunning(p, deps.runner)))(project),
  };
}

export function formatChannelShow(r: ChannelShowResult): string {
  return [
    `communication.channel: configured ${r.configured} (${r.source}: ${r.file})`,
    `effective: ${r.effective} — ${r.reason}`,
    `Telegram bot token: ${r.tokenStored ? 'stored' : 'not stored'}; runtime: ${r.runtime}${r.running ? ' (running)' : ''}`,
    ...(r.running && r.wantsTelegram && r.effective === 'telegram' ? ['The running coordinator decided at launch; `minions status` shows its decision.'] : []),
  ].join('\n');
}

// ---------------------------------------------------------------- set

export interface ChannelSetResult {
  projectId: string;
  path: string;
  from: ChannelSetting;
  to: ChannelSetting;
  dryRun: boolean;
  changed: boolean;
  applied: boolean;
  configRevision: number;
  /** Effective channel after the change (host-side prediction). */
  effective: Pick<ChannelResolution, 'configured' | 'effective' | 'reason' | 'cause'>;
  warnings: string[];
  nextSteps: string[];
}

export interface ChannelSetDeps extends ChannelDeps {
  /** Asks for confirmation (default yes). null: no terminal; then --yes is required. */
  confirm?: (question: string) => Promise<boolean | null>;
}

/** Pure next steps after a change: token, host runtime, local override, commit, restart. */
export function channelNextSteps(s: { to: ChannelSetting; runtime: 'docker' | 'host'; tokenStored: boolean; shared: boolean; running: boolean; changed: boolean; localOverride: ChannelSetting | null; localPath: string }): { warnings: string[]; nextSteps: string[] } {
  const warnings: string[] = [];
  const nextSteps: string[] = [];
  if (s.to !== 'terminal' && s.runtime === 'host') warnings.push(HOST_CHANNEL_WARNING);
  if (s.localOverride !== null && s.localOverride !== s.to) warnings.push(`${s.localPath} sets communication.channel "${s.localOverride}", which overrides the project file; edit or remove it there.`);
  if (s.to !== 'terminal' && s.runtime === 'docker' && !s.tokenStored) nextSteps.push(TOKEN_HINT);
  if (s.changed && s.shared) nextSteps.push('Commit .minions/config.json to share the change (minions does not commit): `git add .minions/config.json && git commit -m "minions: communication.channel"`.');
  if (s.changed && s.running) nextSteps.push(RESTART_HINT);
  else if (s.changed) nextSteps.push('Applies on the next `minions start`.');
  return { warnings, nextSteps };
}

/**
 * Sets communication.channel in the project config file. A file that fails to parse is never
 * overwritten; the result is validated before writing. `--yes` (or a confirmation) is required to write.
 */
export async function setChannel(project: ProjectJson, to: ChannelSetting, o: { dryRun?: boolean; yes?: boolean } = {}, deps: Omit<ChannelSetDeps, 'cwd'> = {}): Promise<ChannelSetResult> {
  if (!(CHANNELS as readonly string[]).includes(to)) throw new MinionsError('INVALID_CONFIG', `Unknown channel "${to}".`, `Use one of: ${CHANNELS.join(', ')}.`);
  let from: ChannelSetting = 'terminal';
  // Validate (and compute the result) without writing first; also catches a file that does not parse.
  const plan = await editProjectConfig(project, (raw) => {
    const comm = (raw.communication ?? {}) as Record<string, unknown>;
    from = (typeof comm.channel === 'string' ? comm.channel : 'terminal') as ChannelSetting;
    return comm.channel === to ? null : { ...raw, communication: { ...comm, channel: to } };
  }, { dryRun: true });
  const eff = await loadEffectiveConfig(project).catch(() => null);
  const localOverride = eff?.provenance['communication.channel'] === 'local' ? eff.config.communication.channel : null;
  const tokenStored = await telegramTokenStored(project.projectId);
  const running = await (deps.isRunning ?? ((p) => runtimeRunning(p, deps.runner)))(project);
  let applied = false;
  let revision = plan.revision;
  if (plan.changed && !o.dryRun) {
    if (!o.yes) {
      const ok = deps.confirm ? await deps.confirm(`Set communication.channel to "${to}" in ${plan.path} (configRevision ${plan.revision})? (Y/n)`) : null;
      if (ok === null) throw new MinionsError('PRECONDITION', 'Changing communication.channel needs a confirmation.', 'Run it in a terminal, or pass --yes.');
      if (!ok) throw new MinionsError('PRECONDITION', 'Not confirmed; communication.channel was not changed.');
    }
    const done = await editProjectConfig(project, (raw) => {
      const comm = (raw.communication ?? {}) as Record<string, unknown>;
      return comm.channel === to ? null : { ...raw, communication: { ...comm, channel: to } };
    });
    applied = done.written;
    revision = done.revision;
  }
  const r = resolveChannel(plan.effective.communication.channel, await hostChannelFacts(project, plan.effective));
  const steps = channelNextSteps({
    to, runtime: runtimeOf(project), tokenStored, shared: project.visibility === 'shared', running, changed: plan.changed && !o.dryRun,
    localOverride, localPath: projectPaths(project.projectId).configLocalJson,
  });
  return {
    projectId: project.projectId, path: plan.path, from, to, dryRun: !!o.dryRun, changed: plan.changed, applied, configRevision: revision,
    effective: { configured: r.configured, effective: r.effective, reason: r.reason, cause: r.cause }, ...steps,
  };
}

export async function runChannelSet(to: string, o: { dryRun?: boolean; yes?: boolean }, deps: ChannelSetDeps): Promise<ChannelSetResult> {
  const { projectId } = await projectForPath(deps.cwd);
  return setChannel(await loadProjectJson(projectId), to as ChannelSetting, o, deps);
}

export function formatChannelSet(r: ChannelSetResult): string {
  const head = `communication.channel: ${r.from} -> ${r.to}${r.dryRun ? ' (dry run: nothing changed)' : r.changed ? ` (configRevision ${r.configRevision}, ${r.path})` : ' (unchanged)'}`;
  return [
    head,
    `effective: ${formatChannel(r.effective)}`,
    ...r.warnings.map((w) => `warning: ${w}`),
    ...(r.nextSteps.length ? ['Next steps:', ...r.nextSteps.map((s) => `  - ${s}`)] : []),
  ].join('\n');
}

// ---------------------------------------------------------------- `minions auth telegram` follow-up

export interface AutoOffer { configured: ChannelSetting; offered: boolean; switched: boolean; hint: string | null; result?: ChannelSetResult }

/**
 * After a bot token is stored: when communication.channel is explicitly "terminal", offer (default
 * yes) to switch to "auto" through the same code path as `minions channel set auto`. Without a
 * terminal (--stdin, no TTY, --json) only a hint is returned.
 */
export async function offerAutoChannel(project: ProjectJson, o: { interactive: boolean; confirm?: (q: string) => Promise<boolean> }, deps: Omit<ChannelSetDeps, 'cwd' | 'confirm'> = {}): Promise<AutoOffer> {
  const eff = await loadEffectiveConfig(project).catch(() => null);
  const configured = eff?.config.communication.channel ?? 'terminal';
  if (configured !== 'terminal') return { configured, offered: false, switched: false, hint: null };
  const hint = 'communication.channel is "terminal", so the stored token is not used: run `minions channel set auto` (Telegram when a token is stored) to use it.';
  if (!o.interactive || !o.confirm) return { configured, offered: false, switched: false, hint };
  if (!(await o.confirm('communication.channel is "terminal". Switch to "auto" (Telegram whenever a bot token is stored)? (Y/n)'))) {
    return { configured, offered: true, switched: false, hint };
  }
  const result = await setChannel(project, 'auto', { yes: true }, deps);
  return { configured, offered: true, switched: result.applied, hint: null, result };
}

// ---------------------------------------------------------------- register

export function registerChannel(program: Command, io: { confirm: (q: string) => Promise<boolean | null> }): Command {
  const ch = program.command('channel').description('Communication channel: terminal, telegram, or auto (Telegram when a bot token is stored)');
  ch.command('show')
    .description('Show the configured and the effective communication channel, with the reason')
    .action(action(async (_o: unknown, cmd: Command) => {
      requireMode('host');
      emit(await runChannelShow({ cwd: process.cwd() }), { json: globalOpts(cmd).json, human: formatChannelShow });
    }));
  ch.command('set')
    .description('Set communication.channel in the project config (configRevision bump; restart-required)')
    .addArgument(new Argument('<channel>', CHANNELS.join(' | ')).choices([...CHANNELS]))
    .option('-y, --yes', 'write without asking')
    .option('--dry-run', 'show what would change')
    .action(action(async (to: string, o: { yes?: boolean }, cmd: Command) => {
      requireMode('host');
      const { json, dryRun } = globalOpts(cmd);
      const r = await runChannelSet(to, { ...o, dryRun }, { cwd: process.cwd(), confirm: json ? async () => null : io.confirm });
      emit(r, { json, human: formatChannelSet });
    }));
  return ch;
}
